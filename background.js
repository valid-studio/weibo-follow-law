/* global WBRRadar, importScripts */
if (typeof importScripts === "function") {
  importScripts("shared/radar_engine.js");
}

(function (root) {
  "use strict";

  const Engine = root.WBRRadar || (typeof require === "function" ? require("./shared/radar_engine.js") : null);
  const STORAGE_KEY = Engine.STORAGE_KEY;

  const BREAKER_STATUS_CODES = new Set([403, 414, 418, 429]);
  const BREAKER_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
  const CLEANUP_MAX_BATCH = 30;
  const WRITE_MIN_DELAY_MS = 2500;
  const WRITE_JITTER_MS = 1000;
  const MANUAL_BATCH_COOLDOWN_MS = 140;
  const MANUAL_BATCH_JITTER_MS = 70;
  const AUTO_BATCH_COOLDOWN_MS = 260;
  const AUTO_BATCH_JITTER_MS = 100;
  const INTER_USER_AUTO_DELAY_MS = 350;
  const INTER_USER_AUTO_JITTER_MS = 150;
  const FAST_CLEAN_PAGES = 5; // 最近 100 位关注 0 命中则快速收敛
  const PAGE_CONCURRENCY = 2; // 2 页微并发步进
  const MY_FOLLOWING_CACHE_TTL_MS = 20 * 60 * 1000;
  const VIEWER_FOLLOWING_SYNC_TTL_MS = 12 * 60 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 8500;
  const TAB_PROXY_TIMEOUT_MS = 9000;
  const USER_CHECK_TIMEOUT_MS = 28000;
  const SERIAL_TASK_TIMEOUT_MS = 35000;
  const LONG_TASK_TIMEOUT_MS = 90000;
  const SYNC_FOLLOWING_BUDGET_MS = 1500;

  class CircuitBreakerError extends Error {
    constructor(message, statusCode = 0, endpoint = "") {
      super(message);
      this.name = "CircuitBreakerError";
      this.statusCode = statusCode;
      this.endpoint = endpoint;
      this.isCircuitBreaker = true;
    }
  }

  function createController(deps = {}) {
    const fetchImpl = deps.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    const storageApi = deps.storage || (typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null);
    const tabsApi = deps.tabs || (typeof chrome !== "undefined" && chrome.tabs ? chrome.tabs : null);
    const runtimeApi = deps.runtime || (typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime : null);
    const actionApi = deps.action || (typeof chrome !== "undefined" && chrome.action ? chrome.action : null);
    const sleepImpl = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const nowImpl = deps.now || (() => Date.now());
    const cacheStore = deps.cacheStore || Engine.createCacheStore(deps.indexedDB);

    let memoryState = Engine.defaultState();
    let serialTail = Promise.resolve();
    let activeTaskCount = 0;
    let batchStopRequested = false;
    let myFollowingCache = { uid: "", fetchedAt: 0, uids: new Set() };
    let softFollowingSyncPromise = null;
    let detectAccountPromise = null;
    let cachedXsrfToken = "";
    const inFlightChecks = new Map();

    function withTimeout(promise, ms, timeoutMessage = "操作超时，请稍后再试") {
      if (!(ms > 0)) return promise;
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(timeoutMessage));
        }, ms);
        Promise.resolve(promise).then(
          (val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(val);
          },
          (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        );
      });
    }

    async function fetchWithTimeout(url, fetchOpts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
      if (!fetchImpl) throw new Error("Fetch API 不可用");
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let aborted = false;
      let timer = null;
      const opts = controller && !fetchOpts.signal
        ? { ...fetchOpts, signal: controller.signal }
        : fetchOpts;
      try {
        const fetchPromise = fetchImpl(url, opts);
        if (!(timeoutMs > 0)) return await fetchPromise;
        return await new Promise((resolve, reject) => {
          let settled = false;
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            aborted = true;
            if (controller) {
              try { controller.abort(); } catch (_) {}
            }
            reject(new Error("请求微博接口超时，请稍后再试"));
          }, timeoutMs);
          Promise.resolve(fetchPromise).then(
            (res) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(res);
            },
            (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (aborted || (err && err.name === "AbortError")) {
                reject(new Error("请求微博接口超时，请稍后再试"));
              } else {
                reject(err);
              }
            }
          );
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function pageCooldownMs(modeOrBatch = "manual") {
      const isAutoOrBatch = modeOrBatch === true || modeOrBatch === "auto" || modeOrBatch === "batch";
      const base = isAutoOrBatch ? AUTO_BATCH_COOLDOWN_MS : MANUAL_BATCH_COOLDOWN_MS;
      const jitter = isAutoOrBatch ? AUTO_BATCH_JITTER_MS : MANUAL_BATCH_JITTER_MS;
      return base + Math.floor(Math.random() * jitter);
    }

    function extractEndpoint(url) {
      try {
        const u = new URL(String(url || ""), "https://weibo.com");
        return u.pathname || String(url || "");
      } catch (_) {
        return String(url || "");
      }
    }

    function formatBreakerError(cb, now) {
      const summary = Engine.formatBreakerSummary(cb, now);
      return summary || "请求太频繁被微博暂时限制，已自动暂停休息一会儿（本地屏蔽依然生效），也可点「立即恢复」";
    }

    async function getState() {
      const now = nowImpl();
      if (!storageApi) return Engine.normalizeState(memoryState, now);
      const res = await storageApi.get(STORAGE_KEY);
      const raw = (res && res[STORAGE_KEY]) || {};
      const st = Engine.normalizeState(raw, now);
      memoryState = st;
      if (raw.circuitBreaker && raw.circuitBreaker.tripped && (!st.circuitBreaker || !st.circuitBreaker.tripped)) {
        await storageApi.set({ [STORAGE_KEY]: st });
      }
      return st;
    }

    async function saveState(state) {
      const normalized = Engine.normalizeState(state, nowImpl());
      memoryState = normalized;
      if (storageApi) {
        await storageApi.set({ [STORAGE_KEY]: normalized });
      }
      await broadcastMessage({ type: "WBR_STATE_UPDATED", state: normalized });
      return normalized;
    }

    async function broadcastMessage(msg) {
      if (runtimeApi && runtimeApi.sendMessage) {
        try {
          const p = runtimeApi.sendMessage(msg);
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (_) {}
      }
      if (tabsApi && tabsApi.query) {
        try {
          const tabs = await tabsApi.query({
            url: ["https://weibo.com/*", "https://api.weibo.com/*"]
          });
          for (const t of tabs) {
            if (!t || !t.id) continue;
            tabsApi.sendMessage(t.id, msg).catch(() => {});
          }
        } catch (_) {}
      }
    }

    function runSerialized(fn, timeoutMs = SERIAL_TASK_TIMEOUT_MS) {
      const next = serialTail.then(async () => {
        activeTaskCount += 1;
        try {
          return await withTimeout(
            Promise.resolve().then(() => fn()),
            timeoutMs,
            "任务执行超时，请稍后再试"
          );
        } finally {
          activeTaskCount = Math.max(0, activeTaskCount - 1);
        }
      });
      serialTail = next.catch(() => {});
      return next;
    }

    async function assertNotTripped() {
      const st = await getState();
      if (st.circuitBreaker && st.circuitBreaker.tripped) {
        const now = nowImpl();
        const until = Number(st.circuitBreaker.until) || 0;
        if (until <= 0 || now >= until) {
          return resetBreaker();
        }
        throw new CircuitBreakerError(
          formatBreakerError(st.circuitBreaker, now),
          st.circuitBreaker.statusCode || 429,
          st.circuitBreaker.endpoint || ""
        );
      }
      return st;
    }

    async function tripBreaker(statusCode, reason, endpoint = "") {
      const st = await getState();
      const now = nowImpl();
      const cb = {
        tripped: true,
        trippedAt: now,
        until: now + BREAKER_COOLDOWN_MS,
        statusCode: Number(statusCode) || 0,
        endpoint: Engine.normalizeText(endpoint),
        reason: Engine.normalizeText(reason) || "请求有点频繁，暂时休息一下"
      };
      const updated = await saveState({
        ...st,
        circuitBreaker: cb
      });
      await broadcastMessage({
        type: "WBR_BREAKER_TRIPPED",
        circuitBreaker: updated.circuitBreaker
      });
      throw new CircuitBreakerError(
        formatBreakerError(updated.circuitBreaker, now),
        cb.statusCode,
        cb.endpoint
      );
    }

    async function resetBreaker() {
      const st = await getState();
      return saveState({
        ...st,
        circuitBreaker: { tripped: false, trippedAt: 0, until: 0, statusCode: 0, endpoint: "", reason: "" }
      });
    }

    function looksLikeHtmlBlockOrLogin(text) {
      if (!text || typeof text !== "string") return false;
      const head = text.slice(0, 600).toLowerCase();
      return (
        head.includes("<!doctype html") ||
        head.includes("<html") ||
        head.includes("sina visitor system") ||
        head.includes("passport.weibo.com")
      );
    }

    function isRiskJson(data) {
      if (!data || typeof data !== "object") return false;
      if (data.ok === 1 || data.ok === true || (typeof data.ok === "number" && data.ok > 0)) {
        return false;
      }
      const msg = String(data.msg || data.message || data.error || "").toLowerCase();
      if (!msg) return false;
      // Do NOT trip on "hidden following / no permission to view following list"
      if (
        msg.includes("隐藏") ||
        msg.includes("不可见") ||
        msg.includes("仅自己") ||
        msg.includes("未公开") ||
        msg.includes("不存在")
      ) {
        return false;
      }
      return (
        msg.includes("频繁") ||
        msg.includes("验证") ||
        msg.includes("captcha") ||
        msg.includes("limit") ||
        msg.includes("异常") ||
        msg.includes("登录") ||
        msg.includes("login") ||
        msg.includes("风控") ||
        msg.includes("请求过多") ||
        msg.includes("系统繁忙")
      );
    }

    async function getSortedWeiboTabs(preferredTabId = null, limit = 2) {
      if (!tabsApi || !tabsApi.query) return [];
      try {
        const tabs = await tabsApi.query({ url: ["https://weibo.com/*"] });
        if (!Array.isArray(tabs) || tabs.length === 0) return [];
        return tabs
          .filter((t) => t && t.id && !t.discarded)
          .slice()
          .sort((a, b) => {
            const aPref = preferredTabId && a.id === preferredTabId ? 2 : 0;
            const bPref = preferredTabId && b.id === preferredTabId ? 2 : 0;
            if (bPref !== aPref) return bPref - aPref;
            const aAct = a.active ? 1 : 0;
            const bAct = b.active ? 1 : 0;
            if (bAct !== aAct) return bAct - aAct;
            const aComp = a.status === "complete" ? 1 : 0;
            const bComp = b.status === "complete" ? 1 : 0;
            return bComp - aComp;
          })
          .slice(0, limit);
      } catch (_) {
        return [];
      }
    }

    async function getXsrfToken(preferredTabId = null) {
      if (tabsApi && tabsApi.sendMessage) {
        const sorted = await getSortedWeiboTabs(preferredTabId, 2);
        for (const t of sorted) {
          try {
            const resp = await withTimeout(
              tabsApi.sendMessage(t.id, { type: "WBR_TAB_GET_XSRF" }),
              3000,
              "Tab xsrf timeout"
            );
            if (resp && resp.xsrfToken) {
              cachedXsrfToken = String(resp.xsrfToken);
              return cachedXsrfToken;
            }
          } catch (_) {}
        }
      }
      if (cachedXsrfToken) {
        return cachedXsrfToken;
      }
      return "";
    }

    async function fetchViaWeiboTab(url, method, headers, body, preferredTabId = null, timeoutMs = TAB_PROXY_TIMEOUT_MS) {
      if (!tabsApi || !tabsApi.query || !tabsApi.sendMessage) return null;
      if (!String(url || "").startsWith("https://weibo.com/")) return null;
      try {
        const sorted = await getSortedWeiboTabs(preferredTabId, 2);
        if (sorted.length === 0) return null;
        for (const t of sorted) {
          try {
            const resp = await withTimeout(
              tabsApi.sendMessage(t.id, {
                type: "WBR_TAB_FETCH",
                url,
                method,
                headers,
                body,
                timeoutMs: Math.max(2000, timeoutMs - 1000)
              }),
              timeoutMs,
              "Tab fetch timeout"
            );
            if (resp && resp.xsrfToken) {
              cachedXsrfToken = String(resp.xsrfToken);
            }
            if (resp && resp.ok === true && typeof resp.status === "number") {
              return {
                viaTab: true,
                status: resp.status,
                ok: resp.httpOk !== undefined ? Boolean(resp.httpOk) : (resp.status >= 200 && resp.status < 300),
                text: async () => resp.text || ""
              };
            }
          } catch (_) {}
        }
      } catch (_) {}
      return null;
    }

    async function guardedFetchJson(url, options = {}) {
      const skipBreaker = Boolean(options.skipBreaker);
      if (!skipBreaker) {
        await assertNotTripped();
      }
      const endpoint = extractEndpoint(url);
      const method = (options.method || "GET").toUpperCase();
      const timeoutMs = Number(options.timeoutMs) || FETCH_TIMEOUT_MS;
      const headers = {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        ...(options.headers || {})
      };

      const fetchOpts = {
        method,
        credentials: "include",
        headers
      };

      if (method !== "GET" && method !== "HEAD") {
        const xsrf = options.xsrfToken || (await getXsrfToken(options.preferredTabId || null));
        if (xsrf) {
          headers["X-XSRF-TOKEN"] = xsrf;
        }
        if (options.body !== undefined) {
          headers["Content-Type"] = "application/json;charset=UTF-8";
          fetchOpts.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
        }
      }

      let resp = null;
      let viaTab = false;
      if (!options.disableTabProxy && String(url || "").startsWith("https://weibo.com/")) {
        const tabResp = await fetchViaWeiboTab(
          url,
          method,
          headers,
          fetchOpts.body,
          options.preferredTabId || null,
          Math.max(TAB_PROXY_TIMEOUT_MS, timeoutMs + 500)
        );
        if (tabResp) {
          resp = tabResp;
          viaTab = true;
        }
      }

      if (!resp) {
        if (!headers.Referer) {
          headers.Referer = options.referer || "https://weibo.com/";
        }
        resp = await fetchWithTimeout(url, fetchOpts, timeoutMs);
      }

      if (BREAKER_STATUS_CODES.has(resp.status)) {
        // In real Chrome runtime, Service Worker fetch to /ajax/* lacks browser Referer and gets 403.
        // Never trip the 10-min global circuit breaker when the request did not go through a weibo.com tab.
        if (resp.status === 403 && !viaTab && tabsApi && endpoint.startsWith("/ajax/")) {
          throw new Error("请先打开或刷新一下微博网页（weibo.com），再试一次");
        }
        const reason = "微博接口暂时限制了访问";
        if (!skipBreaker) {
          await tripBreaker(resp.status, reason, endpoint);
        }
        throw new Error(reason);
      }

      const text = await resp.text();
      if (looksLikeHtmlBlockOrLogin(text)) {
        const reason = "微博需要重新登录或安全验证";
        if (!skipBreaker) {
          await tripBreaker(resp.status || 403, reason, endpoint);
        }
        throw new Error(reason);
      }

      if (!resp.ok) {
        throw new Error("微博服务暂时不可用，请稍后再试");
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        throw new Error("微博返回数据格式异常，请稍后再试");
      }

      if (isRiskJson(data)) {
        const reason = Engine.normalizeText(data.msg || data.message || data.error) || "请求太频繁被微博暂时限制，先休息一会儿";
        if (!skipBreaker) {
          await tripBreaker(resp.status || 429, reason, endpoint);
        }
        throw new Error(reason);
      }
      return data;
    }

    async function detectAccount(preferredTabId = null) {
      if (detectAccountPromise) return detectAccountPromise;
      detectAccountPromise = (async () => {
        let uid = "";
        let screenName = "";

        // 1) Prefer reading from an open weibo.com tab (zero risk, genuine page context)
        if (tabsApi && tabsApi.query && tabsApi.sendMessage) {
          try {
            const sorted = await getSortedWeiboTabs(preferredTabId, 3);
            for (const t of sorted) {
              try {
                const acc = await withTimeout(
                  tabsApi.sendMessage(t.id, { type: "WBR_TAB_GET_ACCOUNT" }),
                  3500,
                  "Tab account timeout"
                );
                if (acc && acc.xsrfToken) {
                  cachedXsrfToken = String(acc.xsrfToken);
                }
                if (acc && acc.ok && acc.uid) {
                  uid = Engine.normalizeUid(acc.uid);
                  screenName = Engine.normalizeText(acc.screenName);
                  if (uid) break;
                }
              } catch (_) {}
            }
          } catch (_) {}
        }

        // 2) Probe weibo.com config/page softly (skipBreaker: true so startup never locks global breaker)
        if (!uid) {
          try {
            const cfg = await guardedFetchJson("https://weibo.com/ajax/config/get_config", {
              skipBreaker: true,
              preferredTabId
            });
            const cfgUid = (cfg && cfg.data && cfg.data.uid) || (cfg && cfg.uid);
            if (cfgUid) uid = Engine.normalizeUid(cfgUid);
          } catch (_) {}
        }

        if (!uid && fetchImpl) {
          try {
            const resp = await fetchWithTimeout(
              "https://weibo.com/",
              {
                method: "GET",
                credentials: "include",
                headers: { "X-Requested-With": "XMLHttpRequest" }
              },
              FETCH_TIMEOUT_MS
            );
            if (resp && resp.ok) {
              const html = await resp.text();
              const m = html.match(/"(?:idstr|uid)"\s*:\s*"?(\d{5,})"?/);
              if (m) uid = Engine.normalizeUid(m[1]);
              const nm = html.match(/"screen_name"\s*:\s*"([^"\\]+)"/);
              if (nm && nm[1]) screenName = Engine.normalizeText(nm[1]);
            }
          } catch (_) {}
        }

        if (!uid) {
          throw new Error("请先在当前浏览器打开并登录微博网页版");
        }

        if (!screenName) {
          try {
            const prof = await guardedFetchJson(`https://weibo.com/ajax/profile/info?uid=${uid}`, {
              skipBreaker: true,
              preferredTabId
            });
            if (prof && prof.ok === 1 && prof.data && prof.data.user) {
              const u = prof.data.user;
              uid = Engine.normalizeUid(u.idstr || u.id || uid);
              screenName = Engine.normalizeText(u.screen_name || u.name || uid);
            }
          } catch (_) {
            if (!screenName) {
              throw new Error("读取微博账号信息失败，请刷新微博网页后再试");
            }
          }
        }

        if (!screenName) {
          throw new Error("读取微博账号信息失败，请刷新微博网页后再试");
        }

        const account = {
          uid,
          screenName,
          checkedAt: nowImpl()
        };
        const st = await getState();
        await saveState({ ...st, account });
        syncViewerFollowingSoft(uid, false, preferredTabId).catch(() => {});
        return account;
      })();
      try {
        return await detectAccountPromise;
      } finally {
        detectAccountPromise = null;
      }
    }

    async function syncViewerFollowingSoft(accountUid, force = false, preferredTabId = null) {
      const cleanUid = Engine.normalizeUid(accountUid);
      if (!cleanUid) return [];
      const curState = await getState();
      const now = nowImpl();
      if (
        !force &&
        curState.viewerFollowingSyncedAt &&
        now - curState.viewerFollowingSyncedAt < VIEWER_FOLLOWING_SYNC_TTL_MS &&
        Array.isArray(curState.viewerFollowingUids) &&
        curState.viewerFollowingUids.length > 0
      ) {
        return curState.viewerFollowingUids;
      }
      if (softFollowingSyncPromise) {
        return softFollowingSyncPromise;
      }
      softFollowingSyncPromise = (async () => {
        try {
          const collected = [];
          const seen = new Set();
          let gotValidPage = false;
          for (let startPage = 1; startPage <= 10; startPage += PAGE_CONCURRENCY) {
            if (startPage > 1) await sleepImpl(180);
            const batchPages = [];
            for (let p = startPage; p < startPage + PAGE_CONCURRENCY && p <= 10; p += 1) {
              batchPages.push(p);
            }
            const batchRes = await Promise.all(
              batchPages.map((p) =>
                guardedFetchJson(
                  `https://weibo.com/ajax/friendships/friends?uid=${encodeURIComponent(cleanUid)}&page=${p}`,
                  { skipBreaker: true, preferredTabId }
                ).catch(() => null)
              )
            );
            let shouldStop = false;
            for (const fRes of batchRes) {
              if (!fRes || (fRes.ok !== 1 && !Array.isArray(fRes.users))) {
                shouldStop = true;
                break;
              }
              gotValidPage = true;
              const users = Array.isArray(fRes.users) ? fRes.users : [];
              if (users.length === 0) {
                shouldStop = true;
                break;
              }
              for (const u of users) {
                const fu = Engine.normalizeUid(u && (u.idstr || u.id));
                if (fu && !seen.has(fu)) {
                  seen.add(fu);
                  collected.push(fu);
                }
              }
              const totalNum = Number(fRes.total_number) || 0;
              if (totalNum > 0 && collected.length >= totalNum) {
                shouldStop = true;
                break;
              }
              if (fRes.next_cursor === 0) {
                shouldStop = true;
                break;
              }
            }
            if (shouldStop) break;
          }
          if (gotValidPage) {
            const latestSt = await getState();
            const merged = Array.from(
              new Set([...collected, ...(latestSt.viewerFollowingUids || [])])
            ).slice(0, 1000);
            await saveState({
              ...latestSt,
              viewerFollowingUids: merged,
              viewerFollowingSyncedAt: nowImpl()
            });
            return merged;
          }
        } catch (_) {
          // Soft sync must silently ignore errors and never block or trip breaker
        } finally {
          softFollowingSyncPromise = null;
        }
        return curState.viewerFollowingUids || [];
      })();
      return softFollowingSyncPromise;
    }

    async function resolveProfile(uid, screenName, preferredTabId = null) {
      const cleanUid = Engine.normalizeUid(uid);
      const cleanName = Engine.normalizeText(screenName);
      if (cleanUid) {
        try {
          const prof = await guardedFetchJson(`https://weibo.com/ajax/profile/info?uid=${cleanUid}`, {
            preferredTabId
          });
          if (prof && prof.ok === 1 && prof.data && prof.data.user) {
            return { ...prof.data.user, _fetched: true };
          }
        } catch (err) {
          if (err && err.isCircuitBreaker) throw err;
        }
        return { idstr: cleanUid, screen_name: cleanName || cleanUid, _fetched: true };
      }
      if (!cleanName) {
        throw new Error("缺少用户 UID 或昵称");
      }
      let prof = null;
      let lastErr = null;
      try {
        prof = await guardedFetchJson(
          `https://weibo.com/ajax/profile/info?screen_name=${encodeURIComponent(cleanName)}`,
          { preferredTabId }
        );
      } catch (err) {
        if (err && err.isCircuitBreaker) throw err;
        lastErr = err;
      }
      if (!prof || prof.ok !== 1 || !prof.data || !prof.data.user) {
        try {
          prof = await guardedFetchJson(
            `https://weibo.com/ajax/profile/info?custom=${encodeURIComponent(cleanName)}`,
            { preferredTabId }
          );
          lastErr = null;
        } catch (err) {
          if (err && err.isCircuitBreaker) throw err;
          lastErr = err;
        }
      }
      if (!prof || prof.ok !== 1 || !prof.data || !prof.data.user) {
        if (lastErr && lastErr.message) {
          throw lastErr;
        }
        throw new Error(`未找到用户 @${cleanName}`);
      }
      return { ...prof.data.user, _fetched: true };
    }

    async function checkUserFollowingUncached(params = {}) {
      let cancelled = false;
      const preferredTabId = params.senderTabId || null;

      const runWork = async () => {
        let st = await assertNotTripped();
        if (!st.account || !st.account.uid) {
          try {
            await detectAccount(preferredTabId);
            st = await getState();
          } catch (_) {}
        }
        if (
          st.account &&
          st.account.uid &&
          (!st.viewerFollowingSyncedAt || nowImpl() - st.viewerFollowingSyncedAt >= VIEWER_FOLLOWING_SYNC_TTL_MS)
        ) {
          const syncP = syncViewerFollowingSoft(st.account.uid, false, preferredTabId).catch(() => null);
          await Promise.race([syncP, sleepImpl(SYNC_FOLLOWING_BUDGET_MS)]);
          if (cancelled) throw new Error("查询关注列表超时，请稍后再试");
          st = await getState();
        }

        const mode = params.mode || (params.isBatch ? "batch" : "manual");
        const fullScan = Boolean(params.fullScan);
        const forceDeepScan = Boolean(params.forceDeepScan);
        const simulateVisitor = Boolean(params.simulateVisitor);
        const hint = params.profileHint && typeof params.profileHint === "object" ? params.profileHint : {};
        const inputUid = Engine.normalizeUid(params.uid);
        const inputName = Engine.normalizeText(params.screenName);

        // Step A: 0-request Instant Exempt Short-Circuit
        const isSelfHint = Boolean(st.account && st.account.uid && inputUid && st.account.uid === inputUid);
        const knownVerifiedType = typeof hint.verifiedType === "number" ? hint.verifiedType : null;
        const isOrgVerifiedHint = knownVerifiedType !== null && knownVerifiedType >= 1 && knownVerifiedType <= 7;
        const knownFollowingHint =
          hint.viewerFollowing === true || Boolean(inputUid && (st.viewerFollowingUids || []).includes(inputUid));

        if (
          !forceDeepScan &&
          !simulateVisitor &&
          (inputUid || inputName) &&
          (isSelfHint || isOrgVerifiedHint || (st.exemptFollowedUsers && knownFollowingHint) || (inputUid && hint.friendsCount === 0))
        ) {
          const fastEvaluated = Engine.evaluateFollowing([], st, {
            uid: inputUid,
            screenName: inputName || inputUid,
            followersCount: Number(hint.followersCount) || 0,
            friendsCount: Number(hint.friendsCount) || 0,
            scannedCount: 0,
            viewerFollowing: knownFollowingHint,
            verifiedType: knownVerifiedType !== null ? knownVerifiedType : -1,
            isSelf: isSelfHint,
            fastSkippedExempt: true,
            scanMode: "exempt_fast",
            checkedAt: nowImpl()
          });
          await cacheStore.put(fastEvaluated);
          return { ...fastEvaluated, fromCache: false };
        }

        const maxPages = Math.min(10, Math.max(1, Number(params.maxPages || st.followScanMaxPages) || 9));
        let emitMaxPages = maxPages;
        let resolvedUid = inputUid;
        let resolvedName = inputName;
        const following = [];

        function emitUserProgress(curPage) {
          const payload = {
            type: "WBR_USER_SCAN_PROGRESS",
            uid: resolvedUid,
            screenName: resolvedName,
            currentPage: curPage,
            maxPages: emitMaxPages,
            scannedCount: following.length
          };
          if (preferredTabId && tabsApi && tabsApi.sendMessage) {
            try {
              const p = tabsApi.sendMessage(preferredTabId, payload);
              if (p && typeof p.catch === "function") p.catch(() => {});
              return;
            } catch (_) {}
          }
          broadcastMessage(payload).catch(() => {});
        }

        // Step B: First-round concurrent probe
        let userObj = null;
        let page1Res = null;
        if (!inputUid) {
          userObj = await resolveProfile("", inputName, preferredTabId);
        } else {
          const hasEnoughHint =
            !fullScan &&
            typeof hint.viewerFollowing === "boolean" &&
            typeof hint.verifiedType === "number";
          const page1Url = `https://weibo.com/ajax/friendships/friends?uid=${encodeURIComponent(inputUid)}&page=1`;
          if (hasEnoughHint) {
            userObj = {
              idstr: inputUid,
              screen_name: inputName || inputUid,
              following: hint.viewerFollowing,
              verified_type: hint.verifiedType,
              friends_count: hint.friendsCount,
              followers_count: hint.followersCount,
              _fetched: false
            };
            page1Res = await guardedFetchJson(page1Url, { preferredTabId });
          } else {
            const [profObj, p1] = await Promise.all([
              resolveProfile(inputUid, inputName, preferredTabId),
              guardedFetchJson(page1Url, { preferredTabId })
            ]);
            userObj = profObj;
            page1Res = p1;
          }
        }
        if (cancelled) throw new Error("查询关注列表超时，请稍后再试");

        const uid = Engine.normalizeUid(userObj.idstr || userObj.id || inputUid);
        const screenName = Engine.normalizeText(userObj.screen_name || userObj.name || inputName || uid);
        resolvedUid = uid;
        resolvedName = screenName;
        if (!uid) {
          throw new Error(`未找到用户 @${inputName || "该用户"}`);
        }

        const followersCount = typeof userObj.followers_count === "number"
          ? userObj.followers_count
          : (Number(hint.followersCount) || 0);
        const friendsCount = typeof userObj.friends_count === "number"
          ? userObj.friends_count
          : (Number(hint.friendsCount) || 0);
        const viewerFollowing = typeof userObj.following === "boolean"
          ? userObj.following
          : Boolean(hint.viewerFollowing);
        const followViewer = Boolean(userObj.follow_me);
        const verifiedType = userObj.verified_type !== undefined && userObj.verified_type !== null
          ? Number(userObj.verified_type)
          : (typeof hint.verifiedType === "number" ? hint.verifiedType : -1);
        const isSelf = Boolean(st.account && st.account.uid && st.account.uid === uid);

        if (viewerFollowing && uid && !(st.viewerFollowingUids || []).includes(uid)) {
          const latestSt = await getState();
          const nextUids = Array.from(new Set([uid, ...(latestSt.viewerFollowingUids || [])])).slice(0, 1000);
          st = await saveState({ ...latestSt, viewerFollowingUids: nextUids });
        }

        const seenUids = new Set();
        let hiddenFollowing = false;

        const hasZeroFriends = Object.prototype.hasOwnProperty.call(userObj, "friends_count") && friendsCount === 0;
        if (!page1Res && !hasZeroFriends) {
          emitUserProgress(0);
          page1Res = await guardedFetchJson(
            `https://weibo.com/ajax/friendships/friends?uid=${encodeURIComponent(uid)}&page=1`,
            { preferredTabId }
          );
          if (cancelled) throw new Error("查询关注列表超时，请稍后再试");
        }

        function consumeFriendsPage(data, pageNum) {
          if (!data || (data.ok !== 1 && !Array.isArray(data.users))) {
            if (pageNum === 1) hiddenFollowing = true;
            return { stop: true };
          }
          const users = Array.isArray(data.users) ? data.users : [];
          if (users.length === 0) return { stop: true };
          let newInPage = 0;
          for (const u of users) {
            const fu = Engine.normalizeUid(u.idstr || u.id);
            const fn = Engine.normalizeText(u.screen_name || u.name);
            const dedupKey = fu || `n:${Engine.normalizeKey(fn)}`;
            if (!dedupKey || seenUids.has(dedupKey)) continue;
            seenUids.add(dedupKey);
            newInPage += 1;
            following.push({ uid: fu, screenName: fn });
          }
          if (newInPage === 0) return { stop: true };
          if (data.next_cursor === 0) return { stop: true };
          return { stop: false };
        }

        let page1Stop = false;
        if (!hasZeroFriends && page1Res) {
          page1Stop = consumeFriendsPage(page1Res, 1).stop;
        } else if (hasZeroFriends) {
          page1Stop = true;
        }

        const knownTotal = Math.max(friendsCount || 0, Number(page1Res && page1Res.total_number) || 0);
        const effectiveMaxPages = Math.min(
          maxPages,
          knownTotal > 0 ? Math.max(1, Math.ceil(knownTotal / 20)) : maxPages
        );
        emitMaxPages = effectiveMaxPages;

        emitUserProgress(1);

        const isConfirmedExempt =
          !forceDeepScan &&
          !simulateVisitor &&
          (isSelf ||
            (verifiedType >= 1 && verifiedType <= 7) ||
            (st.exemptFollowedUsers && viewerFollowing));

        let scanMode = isConfirmedExempt ? "exempt_fast" : "full";

        // Step C: 2-page micro-concurrency + lossless early stop
        if (
          !isConfirmedExempt &&
          !hiddenFollowing &&
          !page1Stop &&
          !(knownTotal > 0 && following.length >= knownTotal) &&
          effectiveMaxPages > 1
        ) {
          for (let startPage = 2; startPage <= effectiveMaxPages; startPage += PAGE_CONCURRENCY) {
            if (cancelled) throw new Error("查询关注列表超时，请稍后再试");
            await sleepImpl(pageCooldownMs(mode));
            if (cancelled) throw new Error("查询关注列表超时，请稍后再试");
            const batchPages = [];
            for (let p = startPage; p < startPage + PAGE_CONCURRENCY && p <= effectiveMaxPages; p += 1) {
              batchPages.push(p);
            }
            const batchResponses = await Promise.all(
              batchPages.map((p) =>
                guardedFetchJson(
                  `https://weibo.com/ajax/friendships/friends?uid=${encodeURIComponent(uid)}&page=${p}`,
                  { preferredTabId }
                )
              )
            );
            if (cancelled) throw new Error("查询关注列表超时，请稍后再试");

            let shouldStopPagination = false;
            let lastPage = batchPages[0];
            for (let idx = 0; idx < batchPages.length; idx += 1) {
              lastPage = batchPages[idx];
              const res = consumeFriendsPage(batchResponses[idx], lastPage);
              if (res.stop || (knownTotal > 0 && following.length >= knownTotal)) {
                shouldStopPagination = true;
                break;
              }
            }

            emitUserProgress(lastPage);
            if (shouldStopPagination) break;

            if (!fullScan) {
              const interim = Engine.evaluateFollowing(following, st, {
                uid,
                screenName,
                followersCount,
                friendsCount: knownTotal || following.length,
                scannedCount: following.length,
                hiddenFollowing,
                viewerFollowing,
                followViewer,
                verifiedType,
                isSelf
              });
              if (!interim.exemptReason && interim.level === "high") {
                scanMode = "fast_high";
                break;
              }
              if ((mode === "auto" || mode === "batch") && lastPage >= FAST_CLEAN_PAGES && interim.hitCount === 0) {
                scanMode = "fast_clean";
                break;
              }
            }
          }
        }

        const evaluated = Engine.evaluateFollowing(following, st, {
          uid,
          screenName,
          followersCount,
          friendsCount: knownTotal || friendsCount,
          scannedCount: following.length,
          hiddenFollowing,
          viewerFollowing,
          followViewer,
          verifiedType,
          isSelf,
          simulateVisitor,
          scanMode,
          fastSkippedExempt: false,
          checkedAt: nowImpl()
        });

        if (!simulateVisitor) {
          await cacheStore.put(evaluated);
        }
        return { ...evaluated, fromCache: false };
      };

      try {
        return await withTimeout(
          runWork(),
          Number(params.timeoutMs) || USER_CHECK_TIMEOUT_MS,
          "查询关注列表超时，请稍后再试"
        );
      } finally {
        cancelled = true;
      }
    }

    async function checkUser(params = {}) {
      const st = await getState();
      const uid = Engine.normalizeUid(params.uid);
      const screenName = Engine.normalizeText(params.screenName);
      const fullScan = Boolean(params.fullScan);
      const forceDeepScan = Boolean(params.forceDeepScan);
      const simulateVisitor = Boolean(params.simulateVisitor);
      const skipCache = Boolean(params.forceRefresh || forceDeepScan || fullScan || simulateVisitor);

      if (!skipCache) {
        const cached = await cacheStore.get(uid, screenName, st.cacheTtlDays, nowImpl());
        if (cached) {
          return { ...cached, fromCache: true };
        }
      }

      const dedupId = uid ? `u:${uid}` : `n:${Engine.normalizeKey(screenName)}`;
      const inFlightKey = dedupId
        ? `${dedupId}:${simulateVisitor ? 1 : 0}:${fullScan ? 1 : 0}:${forceDeepScan ? 1 : 0}`
        : "";
      if (inFlightKey && inFlightChecks.has(inFlightKey)) {
        return inFlightChecks.get(inFlightKey);
      }

      const taskPromise = runSerialized(async () => {
        if (!skipCache) {
          const cachedAgain = await cacheStore.get(uid, screenName, st.cacheTtlDays, nowImpl());
          if (cachedAgain) return { ...cachedAgain, fromCache: true };
        }
        return checkUserFollowingUncached({
          uid,
          screenName,
          profileHint: params.profileHint,
          mode: params.mode || "manual",
          fullScan,
          forceDeepScan,
          simulateVisitor,
          senderTabId: params.senderTabId,
          timeoutMs: params.timeoutMs
        });
      }, Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) + 2000 : SERIAL_TASK_TIMEOUT_MS);

      if (inFlightKey) {
        inFlightChecks.set(inFlightKey, taskPromise);
      }
      try {
        return await taskPromise;
      } finally {
        if (inFlightKey && inFlightChecks.get(inFlightKey) === taskPromise) {
          inFlightChecks.delete(inFlightKey);
        }
      }
    }

    async function blockUserOfficial(params = {}) {
      const uid = Engine.normalizeUid(params.uid);
      const screenName = Engine.normalizeText(params.screenName);
      const alsoMute = params.alsoMute !== false;
      const preferredTabId = params.senderTabId || null;

      let officialBlocked = false;
      let officialError = "";

      try {
        await runSerialized(async () => {
          const target = uid ? { uid, screenName } : await resolveProfile("", screenName, preferredTabId);
          const finalUid = Engine.normalizeUid(target.idstr || target.id || uid);
          const finalName = Engine.normalizeText(target.screen_name || screenName);
          const res = await guardedFetchJson("https://weibo.com/ajax/statuses/filterUser", {
            method: "POST",
            preferredTabId,
            body: {
              uid: finalUid,
              screen_name: finalName,
              status: 1,
              interact: 1,
              follow: 1
            }
          });
          if (res && (res.ok > 0 || res.ok === true)) {
            officialBlocked = true;
          } else {
            officialError = (res && (res.msg || res.message)) || "官方拉黑接口返回非成功状态";
          }
        });
      } catch (err) {
        officialError = err && err.message ? err.message : "官方拉黑失败";
        if (err && err.isCircuitBreaker && !alsoMute) throw err;
      }

      let state = await getState();
      if (alsoMute) {
        state = await saveState(
          Engine.upsertMutedUser(state, {
            uid,
            screenName,
            source: params.source || (officialBlocked ? "weibo_block" : "manual"),
            reason: params.reason || (officialBlocked ? "官方拉黑同步屏蔽" : "官方拉黑失败兜底本地屏蔽")
          })
        );
      }

      return {
        ok: officialBlocked || alsoMute,
        officialBlocked,
        muted: alsoMute,
        error: officialError,
        state
      };
    }

    async function removeFollowerOfficial(params = {}) {
      const uid = Engine.normalizeUid(params.uid);
      if (!uid) throw new Error("移除粉丝需要有效的 UID");
      const preferredTabId = params.senderTabId || null;
      return runSerialized(async () => {
        const res = await guardedFetchJson("https://weibo.com/ajax/profile/destroyFollowers", {
          method: "POST",
          preferredTabId,
          body: { uid }
        });
        if (!res || !(res.ok > 0 || res.ok === true)) {
          throw new Error((res && (res.msg || res.message)) || "移除粉丝失败");
        }
        return { ok: true, uid };
      });
    }

    async function syncOfficialBlocklist() {
      return runSerialized(async () => {
        let st = await getState();
        const imported = [];
        let softWarning = "";
        for (let page = 1; page <= 50; page += 1) {
          if (page > 1) await sleepImpl(pageCooldownMs());
          let res;
          try {
            res = await guardedFetchJson(
              `https://weibo.com/ajax/setting/getFilteredUsers?page=${page}`,
              {
                skipBreaker: true,
                referer: "https://weibo.com/set/shield"
              }
            );
          } catch (err) {
            const msg = err && err.message ? err.message : "官方黑名单接口受限";
            if (page === 1 && imported.length === 0) {
              return {
                ok: false,
                softFailed: true,
                importedCount: 0,
                error: "暂时无法自动读取微博黑名单，本地屏蔽仍正常生效；您也可以打开微博网页版「设置-屏蔽设置」页面点顶部按钮一键导入",
                state: st
              };
            }
            softWarning = msg;
            break;
          }
          if (!res || !res.ok || !Array.isArray(res.card_group) || res.card_group.length === 0) {
            break;
          }
          for (const card of res.card_group) {
            const screenName = Engine.normalizeText(card.title_sub || card.screen_name || card.name);
            let uid = Engine.normalizeUid(card.uid || card.idstr || card.id);
            if (!uid && typeof card.scheme === "string") {
              uid = Engine.normalizeUid(card.scheme);
            }
            if (uid || screenName) {
              imported.push({
                uid,
                screenName,
                source: "weibo_block",
                reason: Engine.normalizeText(card.desc1) || "官方黑名单同步"
              });
            }
          }
          if (!res.next_cursor) break;
        }

        for (const item of imported) {
          st = Engine.upsertMutedUser(st, item);
        }
        st.lastSyncAt = nowImpl();
        const saved = await saveState(st);
        return {
          ok: true,
          partial: Boolean(softWarning),
          warning: softWarning,
          importedCount: imported.length,
          state: saved
        };
      }, LONG_TASK_TIMEOUT_MS);
    }

    function parseMblogId(input) {
      const s = Engine.normalizeText(input);
      if (!s) return "";
      // Match https://weibo.com/<uid>/<mblogid> or raw mblogid
      const urlMatch = s.match(/weibo\.com\/\d+\/([A-Za-z0-9]+)/);
      if (urlMatch) return urlMatch[1];
      const detailMatch = s.match(/weibo\.com\/detail\/(\d+)/);
      if (detailMatch) return detailMatch[1];
      const tokenMatch = s.match(/^[A-Za-z0-9]{6,24}$/);
      return tokenMatch ? tokenMatch[0] : s;
    }

    async function fetchPostInteractors(params = {}) {
      return runSerialized(async () => {
        const mblogId = parseMblogId(params.urlOrId);
        if (!mblogId) throw new Error("请输入有效的微博网页链接");
        const post = await guardedFetchJson(`https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(mblogId)}`);
        if (!post || !post.idstr) {
          throw new Error("没有找到这条微博，请确认链接是否正确或已登录微博");
        }
        const mid = String(post.idstr);
        const authorUid = Engine.normalizeUid(post.user && (post.user.idstr || post.user.id));
        const maxPages = Math.min(5, Math.max(1, Number(params.maxPages) || 2));
        const userMap = new Map();

        function collectUser(u, snippet, kind) {
          if (!u) return;
          const uid = Engine.normalizeUid(u.idstr || u.id);
          const screenName = Engine.normalizeText(u.screen_name || u.name);
          if (!uid || (authorUid && uid === authorUid)) return;
          if (!userMap.has(uid)) {
            userMap.set(uid, {
              uid,
              screenName,
              followersCount: Number(u.followers_count) || 0,
              friendsCount: Number(u.friends_count) || 0,
              snippet: Engine.normalizeText(snippet).slice(0, 120),
              interactionType: kind
            });
          }
        }

        if (params.includeComments !== false) {
          let maxId = 0;
          for (let p = 1; p <= maxPages; p += 1) {
            await sleepImpl(pageCooldownMs());
            const cRes = await guardedFetchJson(
              `https://weibo.com/ajax/statuses/buildComments?is_reload=1&id=${mid}&is_show_bulletin=2&is_mix=0&max_id=${maxId}&count=20&uid=${authorUid}&fetch_level=0`
            );
            const list = Array.isArray(cRes.data) ? cRes.data : [];
            for (const c of list) {
              collectUser(c.user, c.text_raw || c.text, "评论");
            }
            maxId = Number(cRes.max_id) || 0;
            if (!maxId || list.length === 0) break;
          }
        }

        if (params.includeReposts !== false) {
          for (let p = 1; p <= Math.min(3, maxPages); p += 1) {
            await sleepImpl(pageCooldownMs());
            const rRes = await guardedFetchJson(
              `https://weibo.com/ajax/statuses/repostTimeline?id=${mid}&page=${p}&moduleID=feed&count=20`
            );
            const list = Array.isArray(rRes.data) ? rRes.data : [];
            for (const r of list) {
              collectUser(r.user, r.text_raw || r.text, "转发");
            }
            if (list.length < 15) break;
          }
        }

        return {
          mid,
          authorScreenName: Engine.normalizeText(post.user && post.user.screen_name),
          postText: Engine.normalizeText(post.text_raw || post.text).slice(0, 100),
          users: Array.from(userMap.values())
        };
      }, LONG_TASK_TIMEOUT_MS);
    }

    async function fetchSelfInteractors(params = {}) {
      const account = await detectAccount();
      return runSerialized(async () => {
        await assertNotTripped();
        const postCount = Math.min(10, Math.max(1, Number(params.postCount) || 5));

        // 1) Collect my own recent following UIDs (cached in memory for 20 min to prevent burst requests)
        const now = nowImpl();
        let myFollowingUids;
        if (
          !params.forceRefreshFollowing &&
          myFollowingCache.uid === account.uid &&
          now - myFollowingCache.fetchedAt < MY_FOLLOWING_CACHE_TTL_MS
        ) {
          myFollowingUids = new Set(myFollowingCache.uids);
        } else {
          myFollowingUids = new Set([account.uid]);
          for (let page = 1; page <= 10; page += 1) {
            if (page > 1) await sleepImpl(pageCooldownMs());
            const fRes = await guardedFetchJson(
              `https://weibo.com/ajax/friendships/friends?uid=${account.uid}&page=${page}`
            );
            const users = Array.isArray(fRes.users) ? fRes.users : [];
            if (users.length === 0) break;
            for (const u of users) {
              const fu = Engine.normalizeUid(u.idstr || u.id);
              if (fu) myFollowingUids.add(fu);
            }
            if (fRes.total_number && myFollowingUids.size >= fRes.total_number) break;
            if (fRes.next_cursor === 0) break;
          }
          myFollowingCache = {
            uid: account.uid,
            fetchedAt: nowImpl(),
            uids: new Set(myFollowingUids)
          };
          await sleepImpl(pageCooldownMs());
        }

        // 2) Fetch my recent posts
        const myRes = await guardedFetchJson(
          `https://weibo.com/ajax/statuses/mymblog?uid=${account.uid}&page=1&feature=0`
        );
        const posts = ((myRes && myRes.data && myRes.data.list) || []).slice(0, postCount);

        const userMap = new Map();
        for (const p of posts) {
          const mid = String(p.idstr || p.id || "");
          if (!mid) continue;
          await sleepImpl(pageCooldownMs());
          const cRes = await guardedFetchJson(
            `https://weibo.com/ajax/statuses/buildComments?is_reload=1&id=${mid}&is_show_bulletin=2&is_mix=0&max_id=0&count=20&uid=${account.uid}&fetch_level=0`
          );
          const comments = Array.isArray(cRes.data) ? cRes.data : [];
          for (const c of comments) {
            const u = c.user;
            if (!u) continue;
            const uid = Engine.normalizeUid(u.idstr || u.id);
            if (!uid || myFollowingUids.has(uid)) continue;
            if (!userMap.has(uid)) {
              userMap.set(uid, {
                uid,
                screenName: Engine.normalizeText(u.screen_name || u.name),
                followersCount: Number(u.followers_count) || 0,
                friendsCount: Number(u.friends_count) || 0,
                snippet: Engine.normalizeText(c.text_raw || c.text).slice(0, 120),
                interactionType: "评论互动"
              });
            }
          }
        }

        return {
          account,
          scannedPosts: posts.length,
          users: Array.from(userMap.values())
        };
      }, LONG_TASK_TIMEOUT_MS);
    }

    async function runBatchScan(params = {}) {
      batchStopRequested = false;
      const users = Array.isArray(params.users) ? params.users : [];
      const delayMs = Math.max(INTER_USER_AUTO_DELAY_MS, Number(params.delayMs) || INTER_USER_AUTO_DELAY_MS);
      const st = await getState();
      const results = [];

      let processed = 0;
      let networkUserCount = 0;
      let breakerTripped = false;
      let breakerError = "";
      let statusCode = 0;

      for (const u of users) {
        if (batchStopRequested) break;
        const uid = Engine.normalizeUid(u.uid);
        const screenName = Engine.normalizeText(u.screenName);
        if (!uid && !screenName) continue;

        if (Engine.findMutedMatch({ uid, screenName }, st)) {
          processed += 1;
          await broadcastMessage({
            type: "WBR_BATCH_PROGRESS",
            phase: "scan",
            processed,
            total: users.length,
            skippedMuted: true,
            uid,
            screenName
          });
          continue;
        }

        const cached = await cacheStore.get(uid, screenName, st.cacheTtlDays, nowImpl());
        if (cached) {
          const item = { ...cached, snippet: u.snippet || "", interactionType: u.interactionType || "", fromCache: true };
          results.push(item);
          processed += 1;
          await broadcastMessage({
            type: "WBR_BATCH_PROGRESS",
            phase: "scan",
            processed,
            total: users.length,
            result: item
          });
          continue;
        }

        let res;
        try {
          res = await runSerialized(() =>
            checkUserFollowingUncached({
              uid,
              screenName,
              profileHint: u.profileHint,
              mode: "batch"
            })
          );
        } catch (err) {
          if (err && err.isCircuitBreaker) {
            breakerTripped = true;
            breakerError = err.message;
            statusCode = err.statusCode || 0;
            break;
          }
          throw err;
        }

        const item = { ...res, snippet: u.snippet || "", interactionType: u.interactionType || "", fromCache: false };
        results.push(item);
        processed += 1;
        await broadcastMessage({
          type: "WBR_BATCH_PROGRESS",
          phase: "scan",
          processed,
          total: users.length,
          result: item
        });

        if (!res.fastSkippedExempt) {
          networkUserCount += 1;
          if (processed < users.length && !batchStopRequested) {
            const jitter = Math.floor(Math.random() * INTER_USER_AUTO_JITTER_MS);
            await sleepImpl(delayMs + jitter);
            if (networkUserCount % 12 === 0 && !batchStopRequested) {
              await sleepImpl(1100);
            }
          }
        }
      }

      results.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.hitCount || 0) - (a.hitCount || 0));
      return {
        stopped: batchStopRequested || breakerTripped,
        breakerTripped,
        breakerError,
        statusCode,
        results
      };
    }

    async function runCleanupQueue(params = {}) {
      batchStopRequested = false;
      const items = Array.isArray(params.items) ? params.items : [];
      if (items.length === 0) {
        return { stopped: false, executed: 0, logs: [] };
      }
      if (items.length > CLEANUP_MAX_BATCH) {
        throw new Error(`为保护微博账号安全，单次最多勾选 ${CLEANUP_MAX_BATCH} 人，请分批处理`);
      }

      const logs = [];
      let executed = 0;

      for (let i = 0; i < items.length; i += 1) {
        if (batchStopRequested) break;
        const item = items[i];
        const uid = Engine.normalizeUid(item.uid);
        const screenName = Engine.normalizeText(item.screenName);
        const action = item.action || "mute";

        if (action === "mute") {
          const st = await getState();
          await saveState(
            Engine.upsertMutedUser(st, {
              uid,
              screenName,
              source: "radar_queue",
              reason: item.reason || "批量排查加入屏蔽"
            })
          );
          logs.push({ uid, screenName, action, ok: true, message: "✓ 已屏蔽" });
          executed += 1;
        } else if (action === "block") {
          const res = await blockUserOfficial({
            uid,
            screenName,
            alsoMute: true,
            source: "radar_queue",
            reason: item.reason || "批量排查拉黑屏蔽"
          });
          logs.push({
            uid,
            screenName,
            action,
            ok: res.officialBlocked,
            message: res.officialBlocked ? "✓ 已拉黑" : "⚠ 暂未成功（已本地屏蔽）"
          });
          executed += 1;
        } else if (action === "remove_fan") {
          await removeFollowerOfficial({ uid });
          logs.push({ uid, screenName, action, ok: true, message: "✓ 已移除粉丝" });
          executed += 1;
        }

        await broadcastMessage({
          type: "WBR_CLEANUP_PROGRESS",
          processed: executed,
          total: items.length,
          lastLog: logs[logs.length - 1]
        });

        if (i < items.length - 1 && !batchStopRequested && action !== "mute") {
          const jitter = Math.floor(Math.random() * WRITE_JITTER_MS);
          await sleepImpl(WRITE_MIN_DELAY_MS + jitter);
        }
      }

      return { stopped: batchStopRequested, executed, logs };
    }

    async function clearActionBadge(tabId) {
      if (!actionApi || !actionApi.setBadgeText) return;
      try {
        await actionApi.setBadgeText({ text: "" });
        if (tabId) {
          await actionApi.setBadgeText({ text: "", tabId });
        }
      } catch (_) {}
    }

    async function updateActionBadge(_msg = {}, sender = null) {
      const tabId = sender && sender.tab && sender.tab.id ? sender.tab.id : undefined;
      await clearActionBadge(tabId);
      return { ok: true, text: "", color: "" };
    }

    async function handleMessage(msg, sender = null) {
      if (!msg || typeof msg !== "object") return { ok: false, error: "Invalid message" };
      try {
        switch (msg.type) {
          case "WBR_GET_STATE": {
            const state = await getState();
            return { ok: true, state };
          }
          case "WBR_SAVE_STATE": {
            const state = await saveState(msg.state || {});
            return { ok: true, state };
          }
          case "WBR_RESET_BREAKER": {
            const state = await resetBreaker();
            return { ok: true, state };
          }
          case "WBR_DETECT_ACCOUNT": {
            const senderTabId = sender && sender.tab && sender.tab.id ? sender.tab.id : msg.senderTabId;
            const account = await detectAccount(senderTabId || null);
            return { ok: true, account };
          }
          case "WBR_CHECK_USER": {
            const senderTabId = sender && sender.tab && sender.tab.id ? sender.tab.id : msg.senderTabId;
            const result = await checkUser({ ...msg, senderTabId });
            return { ok: true, result };
          }
          case "WBR_UPDATE_BADGE": {
            return await updateActionBadge(msg, sender);
          }
          case "WBR_GET_CACHED_BATCH": {
            const st = await getState();
            const map = await cacheStore.getMany(msg.uids || [], st.cacheTtlDays, nowImpl());
            return { ok: true, map };
          }
          case "WBR_CACHE_STATS": {
            const st = await getState();
            const count = await cacheStore.count(st.cacheTtlDays, nowImpl());
            return { ok: true, count };
          }
          case "WBR_CLEAR_CACHE": {
            await cacheStore.clear();
            return { ok: true };
          }
          case "WBR_MUTE_USER": {
            const st = await getState();
            const state = await saveState(Engine.upsertMutedUser(st, msg.user || msg));
            return { ok: true, state };
          }
          case "WBR_UNMUTE_USER": {
            const st = await getState();
            const state = await saveState(Engine.removeMutedUser(st, msg.user || msg));
            return { ok: true, state };
          }
          case "WBR_BLOCK_USER": {
            const senderTabId = sender && sender.tab && sender.tab.id ? sender.tab.id : msg.senderTabId;
            const res = await blockUserOfficial({ ...msg, senderTabId });
            return res;
          }
          case "WBR_REMOVE_FOLLOWER": {
            const senderTabId = sender && sender.tab && sender.tab.id ? sender.tab.id : msg.senderTabId;
            const res = await removeFollowerOfficial({ ...msg, senderTabId });
            return res;
          }
          case "WBR_SYNC_BLOCKLIST": {
            const res = await syncOfficialBlocklist();
            return { ...res, ok: res.ok !== false };
          }
          case "WBR_IMPORT_BLOCKLIST_ITEMS": {
            let st = await getState();
            const items = Array.isArray(msg.items) ? msg.items : [];
            for (const item of items) {
              st = Engine.upsertMutedUser(st, { ...item, source: "weibo_block" });
            }
            st.lastSyncAt = nowImpl();
            const state = await saveState(st);
            return { ok: true, importedCount: items.length, state };
          }
          case "WBR_FETCH_POST_INTERACTORS": {
            const data = await fetchPostInteractors(msg);
            return { ok: true, data };
          }
          case "WBR_FETCH_SELF_INTERACTORS": {
            const data = await fetchSelfInteractors(msg);
            return { ok: true, data };
          }
          case "WBR_RUN_BATCH_SCAN": {
            const data = await runBatchScan(msg);
            return { ok: true, ...data };
          }
          case "WBR_RUN_CLEANUP_QUEUE": {
            const data = await runCleanupQueue(msg);
            return { ok: true, ...data };
          }
          case "WBR_STOP_BATCH": {
            batchStopRequested = true;
            return { ok: true };
          }
          case "WBR_OPEN_DASHBOARD": {
            const hash = msg.hash ? `#${String(msg.hash).replace(/^#/, "")}` : "";
            if (tabsApi && tabsApi.create && runtimeApi && runtimeApi.getURL) {
              await tabsApi.create({ url: runtimeApi.getURL(`dashboard.html${hash}`) });
              return { ok: true };
            }
            return { ok: false, error: "Tabs API unavailable" };
          }
          default:
            return { ok: false, error: `Unknown message type: ${msg.type}` };
        }
      } catch (err) {
        return {
          ok: false,
          error: err && err.message ? err.message : String(err),
          isCircuitBreaker: Boolean(err && err.isCircuitBreaker),
          statusCode: err && err.statusCode ? err.statusCode : 0,
          endpoint: err && err.endpoint ? err.endpoint : ""
        };
      }
    }

    return {
      getState,
      saveState,
      resetBreaker,
      detectAccount,
      syncViewerFollowingSoft,
      checkUser,
      blockUserOfficial,
      removeFollowerOfficial,
      syncOfficialBlocklist,
      fetchPostInteractors,
      fetchSelfInteractors,
      runBatchScan,
      runCleanupQueue,
      handleMessage,
      getActiveTaskCount: () => activeTaskCount,
      CLEANUP_MAX_BATCH,
      WRITE_MIN_DELAY_MS
    };
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    const controller = createController();
    const wipeToolbarBadge = () => {
      if (chrome.action && typeof chrome.action.setBadgeText === "function") {
        try {
          const p = chrome.action.setBadgeText({ text: "" });
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (_) {}
      }
    };
    wipeToolbarBadge();
    if (chrome.runtime.onInstalled && typeof chrome.runtime.onInstalled.addListener === "function") {
      chrome.runtime.onInstalled.addListener(() => wipeToolbarBadge());
    }
    if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === "function") {
      chrome.runtime.onStartup.addListener(() => wipeToolbarBadge());
    }
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      controller
        .handleMessage(msg, sender)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err && err.message ? err.message : String(err || "Unknown error")
          });
        });
      return true;
    });
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { createController, CircuitBreakerError };
  } else {
    root.WBRBackground = { createController, CircuitBreakerError };
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
