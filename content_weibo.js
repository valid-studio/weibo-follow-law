/* global WBRRadar */
(function (root, factory) {
  const api = factory(
    root.WBRRadar || (typeof require === "function" ? require("./shared/radar_engine.js") : null)
  );
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.WBRWeiboContent = api;
    if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) {
      api.bootChromeWeibo();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function (Engine) {
  "use strict";

  function createWeiboInjector(deps = {}) {
    const doc = deps.document || document;
    const win = deps.window || window;
    const callPageBridge = deps.callPageBridge || null;
    function resolveSendMessageTimeout(msg, explicitTimeout) {
      if (Number(explicitTimeout) > 0) return Number(explicitTimeout);
      const t = msg && msg.type;
      if (t === "WBR_CHECK_USER") return 35000;
      if (t === "WBR_RUN_BATCH_SCAN" || t === "WBR_RUN_CLEANUP_QUEUE" || t === "WBR_SYNC_BLOCKLIST") {
        return 180000;
      }
      if (t === "WBR_FETCH_POST_INTERACTORS" || t === "WBR_FETCH_SELF_INTERACTORS") return 60000;
      return 12000;
    }

    function formatRuntimeErrorMessage(rawErr) {
      const msg = String((rawErr && rawErr.message) || rawErr || "");
      if (msg.includes("Extension context invalidated")) {
        return "插件刚刚更新或重载，请刷新当前微博页面后再试";
      }
      if (msg.includes("message port closed") || msg.includes("Receiving end does not exist")) {
        return "后台服务连接中断，请再试一次或刷新页面";
      }
      return msg || "请求后台服务失败，请稍后再试";
    }

    const sendMessage =
      deps.sendMessage ||
      ((msg, explicitTimeout = 0) =>
        new Promise((resolve) => {
          const timeoutMs = resolveSendMessageTimeout(msg, explicitTimeout);
          let settled = false;
          const finish = (res) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(res);
          };
          const timer = setTimeout(() => {
            finish({ ok: false, error: "查询超时（服务未及时响应），请再试一次" });
          }, timeoutMs);
          try {
            chrome.runtime.sendMessage(msg, (resp) => {
              const lastErr = chrome.runtime && chrome.runtime.lastError;
              if (lastErr) {
                finish({ ok: false, error: formatRuntimeErrorMessage(lastErr) });
                return;
              }
              finish(resp || { ok: false, error: "后台未返回结果，请重试" });
            });
          } catch (err) {
            finish({ ok: false, error: formatRuntimeErrorMessage(err) });
          }
        }));

    let state = Engine.normalizeState(deps.initialState || {});
    let cacheMap = {};
    let popoverEl = null;
    let popoverCleanup = null;
    let isApplyingDom = false;
    let activeObserver = null;
    let hoverTimer = null;
    let scanTimer = null;
    let batchScanning = false;
    let activeStatusEl = null;
    let activeProgressWrap = null;
    let activeProgressFill = null;
    let activeBatchHighCount = 0;
    let lastBatchResults = [];
    const pageRegistry = new Map();
    let currentRouteKey = "";
    let autoInFlight = false;
    let currentScanningKey = null;
    let oneShotViewportScan = false;
    const oneShotTargets = new Set();
    let oneShotSessionTotal = 0;
    let oneShotSessionDone = 0;
    let autoBatchDone = 0;
    let liveWidgetEl = null;
    let lastLiveWidgetSig = "";
    let transientDoneTimer = null;
    let transientDoneInfo = null;
    let breakerDismissedUntil = 0;
    let hoverBtnEl = null;
    let hoverHideTimer = null;
    let hoverCurrentHost = null;
    let hoverCurrentUser = null;
    let hoverDelegationBound = false;
    let accountDetectTriggered = false;
    let lastAutoStampAt = 0;
    let scrollPumpTimer = null;
    let pumpScheduledTimer = null;
    let activeLoadingTarget = null;
    let activeLoadingReqSeq = 0;

    const SVG_NS = "http://www.w3.org/2000/svg";
    const ICON_SHAPES = {
      search: [
        ["circle", { cx: "7", cy: "7", r: "4.6" }],
        ["path", { d: "M10.6 10.6L14 14" }]
      ],
      refresh: [
        ["path", { d: "M13.5 8a5.5 5.5 0 1 1-1.35-3.6" }],
        ["path", { d: "M13.5 2.5v2.8h-2.8" }]
      ],
      eye: [
        ["path", { d: "M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z" }],
        ["circle", { cx: "8", cy: "8", r: "1.9" }]
      ],
      ban: [
        ["circle", { cx: "8", cy: "8", r: "5.5" }],
        ["path", { d: "M4.1 4.1L11.9 11.9" }]
      ],
      alert: [
        ["path", { d: "M8 2.2L14.2 13H1.8L8 2.2z" }],
        ["path", { d: "M8 6.2v3.2" }],
        ["circle", { cx: "8", cy: "11.2", r: "0.5", fill: "currentColor", stroke: "none" }]
      ],
      check: [
        ["path", { d: "M3 8.4L6.4 11.8L13.2 4.8" }]
      ]
    };

    function createSvgIcon(name, size) {
      const shapes = ICON_SHAPES[name];
      if (!shapes || typeof doc.createElement !== "function") return null;
      const svg = typeof doc.createElementNS === "function"
        ? doc.createElementNS(SVG_NS, "svg")
        : doc.createElement("svg");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("class", "wbr-ico");
      if (size) {
        svg.style.width = `${size}px`;
        svg.style.height = `${size}px`;
      }
      for (const [tag, attrs] of shapes) {
        const node = typeof doc.createElementNS === "function"
          ? doc.createElementNS(SVG_NS, tag)
          : doc.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
          node.setAttribute(k, v);
        }
        svg.appendChild(node);
      }
      return svg;
    }

    function setBtnIconLabel(el, iconName, label, size) {
      el.textContent = "";
      const ico = iconName ? createSvgIcon(iconName, size) : null;
      if (ico) el.appendChild(ico);
      const span = doc.createElement("span");
      span.textContent = label;
      el.appendChild(span);
    }

    function ensureAccountDetectedLazy() {
      if (accountDetectTriggered) return;
      const syncAge = Date.now() - (Number(state.viewerFollowingSyncedAt) || 0);
      if (!state.account || !state.account.uid || syncAge >= 12 * 60 * 60 * 1000) {
        accountDetectTriggered = true;
        sendMessage({ type: "WBR_DETECT_ACCOUNT" }).catch(() => {});
      }
    }

    function getUserKey(user) {
      if (!user) return "";
      const uid = Engine.normalizeUid(user.uid);
      if (uid) return `uid:${uid}`;
      const nk = Engine.normalizeKey(user.screenName);
      return nk ? `name:${nk}` : "";
    }

    function getRegistryEntry(user) {
      if (!user) return null;
      const uid = Engine.normalizeUid(user.uid);
      if (uid && pageRegistry.has(`uid:${uid}`)) return pageRegistry.get(`uid:${uid}`);
      const nk = Engine.normalizeKey(user.screenName);
      if (nk && pageRegistry.has(`name:${nk}`)) return pageRegistry.get(`name:${nk}`);
      return null;
    }

    function mergeProfileHint(prevHint, nextHint) {
      if (!prevHint && !nextHint) return undefined;
      const out = { ...(prevHint || {}) };
      if (nextHint && typeof nextHint === "object") {
        if (typeof nextHint.viewerFollowing === "boolean") out.viewerFollowing = nextHint.viewerFollowing;
        if (typeof nextHint.verifiedType === "number") out.verifiedType = nextHint.verifiedType;
        if (typeof nextHint.friendsCount === "number") out.friendsCount = nextHint.friendsCount;
        if (typeof nextHint.followersCount === "number") out.followersCount = nextHint.followersCount;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }

    function getLoginUid() {
      return (
        (doc.documentElement && doc.documentElement.getAttribute("data-wbr-login-uid")) ||
        (state.account && state.account.uid) ||
        ""
      );
    }

    const WBR_ELEMENT_USER_ATTRS = [
      "data-wbr-uid",
      "data-wbr-uname",
      "data-wbr-ufollowing",
      "data-wbr-uvtype",
      "data-wbr-ufriends",
      "data-wbr-ufollowers"
    ];

    function clearElementWbrAttrs(el) {
      if (!el || typeof el.removeAttribute !== "function") return;
      for (const attr of WBR_ELEMENT_USER_ATTRS) {
        el.removeAttribute(attr);
      }
    }

    function namesMatchInsensitive(a, b) {
      const na = Engine.normalizeText(a).replace(/^@/, "").toLowerCase();
      const nb = Engine.normalizeText(b).replace(/^@/, "").toLowerCase();
      return Boolean(na && nb && na === nb);
    }

    function isSameUserIdentity(u1, u2) {
      if (!u1 || !u2) return false;
      const uid1 = Engine.normalizeUid(u1.uid);
      const uid2 = Engine.normalizeUid(u2.uid);
      if (uid1 && uid2) return uid1 === uid2;
      if (uid1 !== uid2) return false;
      const n1 = Engine.normalizeKey(u1.screenName);
      const n2 = Engine.normalizeKey(u2.screenName);
      return Boolean(n1 && n2 && n1 === n2);
    }

    function findOwnedBadges(anchorEl) {
      const parent = anchorEl && anchorEl.parentNode;
      if (!parent || typeof parent.querySelectorAll !== "function") return [];
      const owned = [];
      for (const b of parent.querySelectorAll(':scope > [data-wbr-badge="1"], :scope > [data-wbr-self-badge="1"], :scope > [data-wbr-muted-badge="1"]')) {
        if (b.__wbrOwnerAnchor === anchorEl) {
          owned.push(b);
        }
      }
      if (owned.length > 0) return owned;
      // Fallback for unowned legacy badges directly following anchorEl
      const legacy = [];
      let cur = anchorEl.nextElementSibling;
      while (cur && cur.getAttribute) {
        if (
          !cur.__wbrOwnerAnchor &&
          (cur.getAttribute("data-wbr-badge") === "1" ||
            cur.getAttribute("data-wbr-self-badge") === "1" ||
            cur.getAttribute("data-wbr-muted-badge") === "1")
        ) {
          legacy.push(cur);
          cur = cur.nextElementSibling;
          continue;
        }
        break;
      }
      return legacy;
    }

    function clearAnchorBadges(anchorEl) {
      if (!anchorEl) return;
      if (typeof anchorEl.removeAttribute === "function") {
        anchorEl.removeAttribute("data-wbr-badge-sig");
      }
      for (const b of findOwnedBadges(anchorEl)) {
        b.remove();
      }
    }

    function syncDocProfileRouteAttrs() {
      if (!doc || !doc.documentElement) return;
      const curPath = (win.location && win.location.pathname) || "";
      const rootEl = doc.documentElement;
      const boundRoute = rootEl.getAttribute("data-wbr-profile-route") || "";
      if (
        (rootEl.hasAttribute("data-wbr-profile-uid") ||
          rootEl.hasAttribute("data-wbr-profile-uname") ||
          boundRoute) &&
        boundRoute !== curPath
      ) {
        rootEl.removeAttribute("data-wbr-profile-uid");
        rootEl.removeAttribute("data-wbr-profile-uname");
        rootEl.removeAttribute("data-wbr-profile-route");
      }
    }

    function syncRouteScopeIfChanged() {
      syncDocProfileRouteAttrs();
      const nextRoute = win.location ? `${win.location.pathname || ""}${win.location.search || ""}` : "";
      if (nextRoute && nextRoute !== currentRouteKey) {
        const hadPrevRoute = Boolean(currentRouteKey);
        currentRouteKey = nextRoute;
        pageRegistry.clear();
        currentScanningKey = null;
        oneShotViewportScan = false;
        oneShotTargets.clear();
        oneShotSessionTotal = 0;
        oneShotSessionDone = 0;
        autoBatchDone = 0;
        transientDoneInfo = null;
        if (transientDoneTimer) {
          clearTimeout(transientDoneTimer);
          transientDoneTimer = null;
        }
        hideHoverCheckBtn();
        if (hoverBtnEl) {
          hoverBtnEl.__wbrUser = null;
        }
        if (hadPrevRoute && doc) {
          const prevApplying = isApplyingDom;
          isApplyingDom = true;
          try {
            for (const oldBtn of doc.querySelectorAll('.wbr-profile-inline-btn[data-wbr-profile-btn="1"]')) {
              oldBtn.remove();
            }
            for (const oldBanner of doc.querySelectorAll('[data-wbr-profile-banner], .wbr-profile-banner[data-wbr-profile="1"]')) {
              oldBanner.remove();
            }
            const staleHeader = findProfileHeaderElement();
            if (staleHeader) {
              clearElementWbrAttrs(staleHeader);
              const staleAnchor =
                staleHeader.querySelector('[class*="ProfileHeader_name"], [class*="_name_"], h1') || staleHeader;
              clearAnchorBadges(staleAnchor);
            }
          } finally {
            if (activeObserver && typeof activeObserver.takeRecords === "function") {
              activeObserver.takeRecords();
            }
            isApplyingDom = prevApplying;
          }
        }
      }
    }

    function registerUserToPage(user, anchorEl, rowEl, collectedUids) {
      if (!user || (!user.uid && !user.screenName)) return null;
      if (user.uid && collectedUids) collectedUids.add(user.uid);
      const key = getUserKey(user);
      if (!key) return null;

      // Migrate name-only entry if UID just resolved
      if (user.uid && user.screenName) {
        const nameKey = `name:${Engine.normalizeKey(user.screenName)}`;
        if (nameKey !== key && pageRegistry.has(nameKey) && !pageRegistry.has(key)) {
          const oldEntry = pageRegistry.get(nameKey);
          pageRegistry.delete(nameKey);
          oldEntry.key = key;
          oldEntry.uid = user.uid;
          pageRegistry.set(key, oldEntry);
        }
      }

      let entry = pageRegistry.get(key);
      if (!entry) {
        entry = {
          key,
          uid: user.uid || "",
          screenName: user.screenName || "",
          profileHint: user.profileHint,
          elements: new Set(),
          rowElements: new Set(),
          status: "queued",
          currentPage: 0,
          maxPages: 0
        };
        pageRegistry.set(key, entry);
      } else {
        if (user.uid && !entry.uid) entry.uid = user.uid;
        if (user.screenName) entry.screenName = user.screenName;
        entry.profileHint = mergeProfileHint(entry.profileHint, user.profileHint);
      }

      if (anchorEl) {
        for (const el of Array.from(entry.elements)) {
          if (!el || !el.isConnected) entry.elements.delete(el);
        }
        entry.elements.add(anchorEl);
      }
      if (rowEl) {
        for (const r of Array.from(entry.rowElements)) {
          if (!r || !r.isConnected) entry.rowElements.delete(r);
        }
        entry.rowElements.add(rowEl);
      }

      const muted = Engine.findMutedMatch(entry, state);
      if (muted) {
        entry.status = "muted";
        return entry;
      }

      const cached = getCachedResult(entry);
      if (cached) {
        entry.status = "done";
        return entry;
      }

      const loginUid = getLoginUid();
      if (loginUid && entry.uid && entry.uid === loginUid) {
        const selfEval = Engine.evaluateFollowing([], state, {
          uid: entry.uid,
          screenName: entry.screenName || entry.uid,
          isSelf: true,
          viewerFollowing: false,
          verifiedType: -1,
          scannedCount: 0,
          scanMode: "exempt_fast",
          fastSkippedExempt: true,
          checkedAt: Date.now()
        });
        storeCachedResult(selfEval, entry);
        entry.status = "done";
        return entry;
      }

      if (entry.status !== "scanning") {
        if (state.circuitBreaker && state.circuitBreaker.tripped) {
          entry.status = "paused";
        } else if (state.autoScanViewport || (oneShotViewportScan && oneShotTargets.has(entry.key))) {
          entry.status = "queued";
        } else {
          entry.status = "paused";
        }
      }
      return entry;
    }

    function getCachedResult(user) {
      if (!user) return null;
      if (user.uid && cacheMap[user.uid]) return cacheMap[user.uid];
      if (user.screenName) {
        const nk = `name:${Engine.normalizeKey(user.screenName)}`;
        if (cacheMap[nk]) return cacheMap[nk];
      }
      return null;
    }

    function storeCachedResult(res, fallbackUser) {
      if (!res) return;
      if (res.uid) cacheMap[res.uid] = res;
      if (fallbackUser && fallbackUser.uid) cacheMap[fallbackUser.uid] = res;
      if (res.screenName) cacheMap[`name:${Engine.normalizeKey(res.screenName)}`] = res;
      if (fallbackUser && fallbackUser.screenName) {
        cacheMap[`name:${Engine.normalizeKey(fallbackUser.screenName)}`] = res;
      }
    }

    function showToast(text, duration = 2600) {
      try {
        for (const old of doc.querySelectorAll(".wbr-toast")) old.remove();
        const el = doc.createElement("div");
        el.className = "wbr-toast";
        el.textContent = text;
        doc.body.appendChild(el);
        setTimeout(() => el.remove(), duration);
      } catch (_) {}
    }

    function extractUidFromHref(href) {
      if (!href) return "";
      const s = String(href);
      if (s.includes("bigFans") || s.includes("page.star.weibo.com")) return "";
      const m = s.match(/\/u\/(\d{5,})/);
      if (m) return m[1];
      const m2 = s.match(/^(?:https?:)?\/\/weibo\.com\/(\d{5,})(?:[/?#]|$)/);
      return m2 ? m2[1] : "";
    }

    function extractUidFromUsercard(val) {
      if (!val) return "";
      const m = String(val).match(/(?:^|&)id=(\d{5,})/);
      if (m) return m[1];
      const m2 = String(val).match(/^(\d{5,})$/);
      return m2 ? m2[1] : "";
    }

    const WEIBO_CHROME_UI_SELECTOR = [
      "nav",
      '[role="navigation"]',
      '[class*="Nav_"]',
      '[class*="Frame_top"]',
      '[class*="TopNav"]',
      '[class*="Frame_side"]',
      '[class*="LeftNav"]',
      '[class*="SideNav"]',
      "#webchat",
      '[id*="webchat"]',
      '[class*="webchat"]',
      '[class*="WebChat"]',
      '[class*="Chat_"]',
      '[class*="MessagePop"]',
      '[class*="Notice_"]',
      ".woo-badge"
    ].join(", ");

    const USER_LINK_SELECTOR = 'a[href*="/u/"], a[usercard], a[href^="/n/"], a[href*="weibo.com/n/"]';

    const ANCHOR_NOISE_SELECTOR = [
      ".woo-badge",
      '[class*="woo-badge"]',
      '[class*="badge"]',
      '[class*="Badge"]',
      '[class*="fans" i]',
      '[class*="medal" i]',
      '[class*="woo-tag"]',
      '[class*="Mute" i]',
      '[class*="unread"]',
      ".wbr-badge",
      "[data-wbr-badge]",
      "[data-wbr-self-badge]",
      "[data-wbr-muted-badge]",
      ".wbr-inline-muted-quote",
      ".wbr-profile-inline-btn",
      "[data-wbr-profile-btn]",
      ".wbr-hover-check-btn",
      "[data-wbr-hover-btn]",
      "button",
      "svg",
      "img"
    ].join(", ");

    function extractCleanProfileName(el) {
      if (!el) return "";
      let raw = "";
      if (typeof el.cloneNode === "function" && typeof el.querySelectorAll === "function") {
        const clone = el.cloneNode(true);
        for (const noise of clone.querySelectorAll(`${ANCHOR_NOISE_SELECTOR}, button`)) {
          if (noise && typeof noise.remove === "function") noise.remove();
        }
        raw = Engine.normalizeText(clone.textContent || "").replace(/^@/, "");
      } else {
        raw = Engine.normalizeText(el.textContent || "").replace(/^@/, "");
      }
      if (!raw || isPureNumericBadgeText(raw)) return "";
      return raw;
    }

    function isInsideWeiboChromeUi(el) {
      if (!el || typeof el.closest !== "function") return false;
      return Boolean(el.closest(WEIBO_CHROME_UI_SELECTOR));
    }

    function isPureNumericBadgeText(txt) {
      return /^\d+\+?$/.test(txt);
    }

    function extractNameFromAnchor(a) {
      if (!a) return "";
      const titleRaw = Engine.normalizeText(a.getAttribute("title") || "").replace(/^@/, "");
      if (titleRaw && !isPureNumericBadgeText(titleRaw)) {
        return titleRaw;
      }
      let raw = "";
      if (typeof a.cloneNode === "function" && typeof a.querySelectorAll === "function") {
        const clone = a.cloneNode(true);
        for (const noise of clone.querySelectorAll(ANCHOR_NOISE_SELECTOR)) {
          if (noise && typeof noise.remove === "function") noise.remove();
        }
        raw = Engine.normalizeText(clone.textContent || "").replace(/^@/, "");
      } else {
        raw = Engine.normalizeText(a.textContent || "").replace(/^@/, "");
      }
      if (!raw || isPureNumericBadgeText(raw)) return "";
      return raw;
    }

    function isDecorativeTrailingBadgeEl(el) {
      if (!el || el.nodeType !== 1) return false;
      if (isWbrOwnedNode(el)) return false;
      if (el.matches && el.matches('a[href*="bigFans"], a[href*="page.star.weibo.com"], a[href*="vip.weibo"]')) {
        return true;
      }
      if (el.matches && el.matches(USER_LINK_SELECTOR)) {
        return false;
      }
      if (
        el.matches &&
        el.matches('.woo-badge, [class*="woo-badge"], [class*="fans" i], [class*="medal" i], [class*="vip" i], [class*="woo-tag"], img, svg')
      ) {
        return true;
      }
      if (el.tagName === "SPAN" && !el.querySelector(USER_LINK_SELECTOR)) {
        const cls = String(el.className || "");
        const txt = Engine.normalizeText(el.textContent || "");
        if (
          /(?:fan|medal|vip|badge|icon|tag|level)/i.test(cls) ||
          /^(?:真爱粉|铁粉|钻粉|金粉|银粉|新粉|V\d+|SVIP|VIP)$/i.test(txt)
        ) {
          return true;
        }
      }
      return false;
    }

    function findAnchorFollowingInsertRef(anchorEl, includeWbrNodes = false) {
      if (!anchorEl) return anchorEl;
      let insertRef = anchorEl;
      let cur = anchorEl.nextSibling;
      let steps = 0;
      while (cur && steps < 10) {
        if (cur.nodeType === 3) {
          if (String(cur.textContent || "").trim()) break;
          cur = cur.nextSibling;
          steps += 1;
          continue;
        }
        if (cur.nodeType !== 1) break;
        const isWbrBadgeSibling =
          cur.getAttribute &&
          (cur.getAttribute("data-wbr-badge") === "1" ||
            cur.getAttribute("data-wbr-self-badge") === "1" ||
            cur.getAttribute("data-wbr-muted-badge") === "1" ||
            cur.getAttribute("data-wbr-inline-muted") === "1");
        if (isWbrBadgeSibling) {
          if (!includeWbrNodes) break;
          insertRef = cur;
          cur = cur.nextSibling;
          steps += 1;
          continue;
        }
        if (isDecorativeTrailingBadgeEl(cur)) {
          insertRef = cur;
          cur = cur.nextSibling;
          steps += 1;
          continue;
        }
        break;
      }
      return insertRef;
    }

    function isDecorativeUserLink(a) {
      if (!a) return true;
      if (isInsideWeiboChromeUi(a)) return true;
      const href = String(a.getAttribute("href") || "");
      if (href.includes("bigFans") || href.includes("page.star.weibo.com") || href.includes("vip.weibo")) {
        return true;
      }
      if (a.querySelector('img, svg, .woo-avatar-main, [class*="Avatar"], [class*="avatar"], .woo-badge')) {
        const txt = extractNameFromAnchor(a);
        if (!txt) return true;
      }
      return false;
    }

    function findBestAuthorAnchor(container) {
      if (!container || isInsideWeiboChromeUi(container)) return null;
      // In Weibo Pro Next comments, the author anchor is ALWAYS before span[class*="_colon_"]
      const colonEl = container.querySelector('[class*="_colon_"]');
      const selectors = [
        'a[href*="/u/"]',
        'a[usercard]',
        'a[href^="/n/"]',
        'a[href*="weibo.com/n/"]',
        'header a[href*="weibo.com/"]'
      ];
      for (const sel of selectors) {
        const candidates = container.querySelectorAll(sel);
        for (const a of candidates) {
          if (isDecorativeUserLink(a)) continue;
          if (colonEl && typeof colonEl.compareDocumentPosition === "function") {
            const pos = colonEl.compareDocumentPosition(a);
            // Skip @mentions that appear AFTER the colon
            if (pos & 4) continue;
          }
          const txt = extractNameFromAnchor(a);
          if (txt && txt.length <= 40) return a;
        }
      }
      for (const a of container.querySelectorAll(USER_LINK_SELECTOR)) {
        if (isDecorativeUserLink(a)) continue;
        const txt = extractNameFromAnchor(a);
        if (!txt && !a.getAttribute("data-wbr-uname")) continue;
        return a;
      }
      return null;
    }

    function extractUserFromContainer(container, fallbackAnchor) {
      // Prefer anchor attributes (live from Vue) before container attributes (may lag during recycle)
      const liveAnchorName = extractNameFromAnchor(fallbackAnchor);
      const stampedAnchorName = Engine.normalizeText(fallbackAnchor && fallbackAnchor.getAttribute("data-wbr-uname"));
      const anchorAttrStale = Boolean(
        liveAnchorName && stampedAnchorName && !namesMatchInsensitive(liveAnchorName, stampedAnchorName)
      );

      const anchorUid =
        extractUidFromHref(fallbackAnchor && fallbackAnchor.getAttribute("href")) ||
        extractUidFromUsercard(fallbackAnchor && fallbackAnchor.getAttribute("usercard")) ||
        (!anchorAttrStale ? Engine.normalizeUid(fallbackAnchor && fallbackAnchor.getAttribute("data-wbr-uid")) : "");
      const anchorName = liveAnchorName || stampedAnchorName;

      const containerName = Engine.normalizeText(container && container.getAttribute("data-wbr-uname"));
      const containerStale = Boolean(
        anchorName && containerName && !namesMatchInsensitive(anchorName, containerName)
      );
      const containerUid = !containerStale ? Engine.normalizeUid(container && container.getAttribute("data-wbr-uid")) : "";
      const uid = anchorUid || containerUid;
      const screenName = anchorName || containerName;

      function readAttr(attrName) {
        if (!anchorAttrStale) {
          const v1 = fallbackAnchor && fallbackAnchor.getAttribute(attrName);
          if (v1 !== null && v1 !== undefined && v1 !== "") return v1;
        }
        if (!containerStale) {
          const v2 = container && container.getAttribute(attrName);
          if (v2 !== null && v2 !== undefined && v2 !== "") return v2;
        }
        return null;
      }

      const profileHint = {};
      const rawFollowing = readAttr("data-wbr-ufollowing");
      if (rawFollowing === "1" || rawFollowing === "0") {
        profileHint.viewerFollowing = rawFollowing === "1";
      }
      const rawVType = readAttr("data-wbr-uvtype");
      if (rawVType !== null && /^-?\d+$/.test(rawVType)) {
        profileHint.verifiedType = Number(rawVType);
      }
      const rawFriends = readAttr("data-wbr-ufriends");
      if (rawFriends !== null && /^\d+$/.test(rawFriends)) {
        profileHint.friendsCount = Number(rawFriends);
      }
      const rawFollowers = readAttr("data-wbr-ufollowers");
      if (rawFollowers !== null && /^\d+$/.test(rawFollowers)) {
        profileHint.followersCount = Number(rawFollowers);
      }

      return Object.keys(profileHint).length > 0
        ? { uid, screenName, profileHint }
        : { uid, screenName };
    }

    function closePopover() {
      activeLoadingTarget = null;
      activeLoadingReqSeq += 1;
      if (popoverCleanup) {
        try {
          popoverCleanup();
        } catch (_) {}
        popoverCleanup = null;
      }
      if (popoverEl) {
        popoverEl.remove();
        popoverEl = null;
      }
    }

    function getTopCategoryShorts(categoryCounts, maxCount = 3) {
      return Object.entries(categoryCounts || {})
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxCount)
        .map(([cid]) => (Engine.CATEGORY_META[cid] && Engine.CATEGORY_META[cid].shortLabel) || cid);
    }

    function bindInlineConfirmBlock(btn, getTargetUser, normalLabel, confirmLabel, onCompleted) {
      let confirmTimer = null;
      const resetConfirm = () => {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        delete btn.dataset.wbrConfirming;
        btn.classList.remove("wbr-act-btn-confirming");
        btn.textContent = normalLabel;
      };
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        if (state.confirmBeforeBlock && btn.dataset.wbrConfirming !== "1") {
          btn.dataset.wbrConfirming = "1";
          btn.textContent = confirmLabel;
          btn.classList.add("wbr-act-btn-confirming");
          confirmTimer = setTimeout(() => {
            if (btn.isConnected) resetConfirm();
          }, 3500);
          return;
        }
        resetConfirm();
        btn.disabled = true;
        try {
          await handleBlockUser(getTargetUser());
          if (typeof onCompleted === "function") onCompleted();
        } finally {
          if (btn.isConnected) btn.disabled = false;
        }
      });
    }

    function resolveAnchorRect(anchorEl) {
      let anchorRect = { left: 20, top: 20, bottom: 20, width: 0, height: 0 };
      if (anchorEl && typeof anchorEl.getBoundingClientRect === "function") {
        const r = anchorEl.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0 || r.left > 0 || r.top > 0)) {
          anchorRect = r;
        }
      } else if (anchorEl && typeof anchorEl.left === "number") {
        anchorRect = anchorEl;
      }
      return anchorRect;
    }

    function mountPopoverShell(anchorEl, targetUser) {
      const anchorRect = resolveAnchorRect(anchorEl);
      closePopover();
      const pop = doc.createElement("div");
      pop.className = "wbr-popover";
      pop.setAttribute("data-wbr-popover", "1");
      pop.__wbrTargetKey = targetUser.uid || Engine.normalizeKey(targetUser.screenName);

      const head = doc.createElement("div");
      head.className = "wbr-popover-head";
      const headLeft = doc.createElement("div");
      headLeft.className = "wbr-popover-head-left";
      const title = doc.createElement("div");
      title.className = "wbr-popover-title";
      title.textContent = `微博关注列表定律 · @${targetUser.screenName || "用户"}`;
      headLeft.appendChild(title);
      const headActions = doc.createElement("div");
      headActions.className = "wbr-popover-head-actions";
      const helpBtn = doc.createElement("button");
      helpBtn.type = "button";
      helpBtn.className = "wbr-popover-help";
      helpBtn.textContent = "?";
      helpBtn.title = "规则与防误伤说明：单人权重低于预警线（标准 3.1 分），点击打开设置页";
      helpBtn.setAttribute("aria-label", "规则与设置");
      helpBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        sendMessage({ type: "WBR_OPEN_DASHBOARD", hash: "features" });
      });
      const closeBtn = doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "wbr-popover-close";
      closeBtn.textContent = "×";
      closeBtn.setAttribute("aria-label", "关闭");
      closeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        closePopover();
      });
      headActions.append(helpBtn, closeBtn);
      head.append(headLeft, headActions);
      pop.appendChild(head);
      pop.addEventListener("click", (ev) => ev.stopPropagation());
      doc.body.appendChild(pop);

      const positionPopover = () => {
        const vw = win.innerWidth || 1024;
        const vh = win.innerHeight || 768;
        const popW = pop.offsetWidth || 320;
        const popH = pop.offsetHeight || 200;
        const left = Math.min(vw - popW - 12, Math.max(12, anchorRect.left || 20));
        let top = (anchorRect.bottom || 20) + 6;
        if (top + popH > vh - 12 && (anchorRect.top || 0) > popH + 18) {
          top = Math.max(12, anchorRect.top - popH - 6);
        } else {
          top = Math.min(vh - popH - 12, Math.max(12, top));
        }
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
      };

      const onDocClick = (ev) => {
        const t = ev && ev.target;
        if (
          t &&
          (pop.contains(t) ||
            (t.closest &&
              t.closest(
                '[data-wbr-popover="1"], [data-wbr-badge="1"], [data-wbr-self-badge="1"], [data-wbr-muted-badge="1"], [data-wbr-actions="1"], [data-wbr-usercard-btn="1"], .wbr-live-widget'
              )))
        ) {
          return;
        }
        closePopover();
      };
      const onDocKeyDown = (ev) => {
        if (ev && ev.key === "Escape") closePopover();
      };
      const timerId = setTimeout(() => {
        if (popoverEl !== pop) return;
        doc.addEventListener("click", onDocClick);
        doc.addEventListener("keydown", onDocKeyDown);
      }, 0);
      popoverCleanup = () => {
        clearTimeout(timerId);
        doc.removeEventListener("click", onDocClick);
        doc.removeEventListener("keydown", onDocKeyDown);
      };
      popoverEl = pop;
      return { pop, headLeft, title, positionPopover };
    }

    function openLoadingPopover(anchorEl, user, errorText = "", opts = {}) {
      const targetUser = {
        uid: (user && user.uid) || "",
        screenName: (user && user.screenName) || "",
        profileHint: user && user.profileHint
      };
      const isVisitorLoading = Boolean(opts && opts.simulateVisitor);
      const { pop, positionPopover } = mountPopoverShell(anchorEl, targetUser);
      activeLoadingReqSeq += 1;
      const reqSeq = activeLoadingReqSeq;
      activeLoadingTarget = errorText
        ? null
        : {
            uid: targetUser.uid,
            screenName: targetUser.screenName,
            simulateVisitor: isVisitorLoading
          };
      const body = doc.createElement("div");
      body.className = "wbr-popover-loading";
      body.textContent = errorText
        ? errorText
        : (isVisitorLoading
          ? `正在测算 @${targetUser.screenName || "您"} 的近期关注...`
          : `正在查看 @${targetUser.screenName || "用户"} 的近期关注...`);
      pop.appendChild(body);
      if (errorText) {
        const footer = doc.createElement("div");
        footer.className = "wbr-popover-footer";
        const retryBtn = doc.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "wbr-act-btn";
        retryBtn.textContent = "再试一次";
        retryBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          triggerUserCheck(targetUser, anchorEl && anchorEl.isConnected ? anchorEl : pop.getBoundingClientRect(), true, opts);
        });
        footer.appendChild(retryBtn);
        pop.appendChild(footer);
      }
      positionPopover();
      return reqSeq;
    }

    function openDetailPopover(anchorEl, data, user) {
      activeLoadingTarget = null;
      activeLoadingReqSeq += 1;
      const anchorRect = resolveAnchorRect(anchorEl);
      const targetUser = {
        uid: (user && user.uid) || (data && data.uid) || "",
        screenName: (user && user.screenName) || (data && data.screenName) || "",
        profileHint: (user && user.profileHint) || undefined
      };
      const loginUid = getLoginUid();
      const isSelfTarget = Boolean(
        data.exemptReason === "self" ||
          data.simulateVisitor ||
          (loginUid && targetUser.uid && targetUser.uid === loginUid)
      );
      const isVisitorSim = Boolean(data && data.simulateVisitor);
      const { pop, headLeft, title, positionPopover } = mountPopoverShell(anchorEl, targetUser);
      title.textContent = `微博关注列表定律 · @${(data && data.screenName) || targetUser.screenName || "未知用户"}`;
      if (isVisitorSim && headLeft) {
        const vTag = doc.createElement("span");
        vTag.className = "wbr-visitor-tag";
        vTag.textContent = "访客视角自测";
        headLeft.appendChild(vTag);
      }

      const summary = doc.createElement("div");
      summary.className = "wbr-popover-summary";
      const topCats = getTopCategoryShorts(data.categoryCounts, 2);
      if (data._isSelfPlaceholder) {
        summary.textContent = `属于「${data.selfCategoryFull || data.selfCategoryLabel}」特征源账号`;
      } else if (data._isMutedPlaceholder) {
        summary.textContent = `已在屏蔽名单中（${data.mutedReason || "手动屏蔽"}）`;
      } else if (isVisitorSim) {
        if (data.hiddenFollowing) {
          summary.textContent = "关注列表不可见，访客视角无法查看";
        } else if (!data.hitCount || data.hitCount <= 0) {
          summary.textContent = "访客视角：近期公开关注无明显特征重合";
        } else if (data.level !== "warn" && data.level !== "high") {
          const prob = data.probability || Engine.computeProbabilityFromScore(data.score ?? data.hitCount, data.hitCount);
          summary.textContent = `访客视角：未达预警线（重合 ${data.hitCount} 位 · 得分 ${data.score ?? 0} · 特征倾向 ${prob}%）`;
        } else {
          const catText = topCats.length > 0 ? topCats.map((c) => `「${c}」`).join("") : "特定圈层";
          const prob = data.probability || Engine.computeProbabilityFromScore(data.score ?? data.hitCount, data.hitCount);
          summary.textContent = data.level === "warn"
            ? `访客视角：存在关注倾向 · ${prob}%（命中 ${data.hitCount} 位，偏${catText}）`
            : `访客视角：显著特征倾向 · ${prob}%（命中 ${data.hitCount} 位，集中在${catText}）`;
        }
      } else if (data.exemptReason === "self") {
        summary.textContent = "本人账号 · 默认免预警";
      } else if (data.exemptReason === "following") {
        summary.textContent = `已关注账号 · 默认免预警${data.hitCount > 0 ? `（重合 ${data.hitCount} 位）` : ""}`;
      } else if (data.exemptReason === "org_verified") {
        summary.textContent = `官方蓝V机构号 · 免预警${data.hitCount > 0 ? `（重合 ${data.hitCount} 位）` : ""}`;
      } else if (data.hiddenFollowing) {
        summary.textContent = "对方隐藏了关注列表";
      } else if (!data.hitCount || data.hitCount <= 0) {
        summary.textContent = "近期公开关注无明显特征重合";
      } else if (data.level !== "warn" && data.level !== "high") {
        summary.textContent = `未达预警线（重合 ${data.hitCount} 位 · 得分 ${data.score ?? 0}）`;
      } else {
        const catText = topCats.length > 0 ? topCats.map((c) => `「${c}」`).join("") : "特定圈层";
        const prob = data.probability || Engine.computeProbabilityFromScore(data.score ?? data.hitCount, data.hitCount);
        summary.textContent = data.level === "warn"
          ? `存在关注倾向 · ${prob}%（命中 ${data.hitCount} 位，偏${catText}）`
          : `显著特征倾向 · ${prob}%（命中 ${data.hitCount} 位，集中在${catText}）`;
      }
      pop.appendChild(summary);

      if (!data._isSelfPlaceholder && !data._isMutedPlaceholder) {
        const meta = doc.createElement("div");
        meta.className = "wbr-popover-meta";
        const followers = Engine.formatCompactCount(data.followersCount);
        const friends = Engine.formatCompactCount(data.friendsCount);
        const scoreText = data.score !== undefined ? data.score : (data.hitCount || 0);
        const hitList = Array.isArray(data.hitItems) ? data.hitItems : [];
        const exemptSharedCnt = hitList.filter((x) => x.sharedWithViewer && x.sharedExempt !== false).length;
        const coreSharedCnt = hitList.filter((x) => x.sharedWithViewer && x.sharedExempt === false).length;
        let sharedSuffix = "";
        if (!isVisitorSim && (exemptSharedCnt > 0 || coreSharedCnt > 0)) {
          if (exemptSharedCnt > 0 && coreSharedCnt > 0) {
            sharedSuffix = ` · 共同关注 ${exemptSharedCnt} 免计/${coreSharedCnt} 核心计分`;
          } else if (coreSharedCnt > 0) {
            sharedSuffix = ` · 含 ${coreSharedCnt} 位共同关注核心(保留计分)`;
          } else {
            sharedSuffix = ` · 含 ${exemptSharedCnt} 位共同关注免计`;
          }
        }
        if (isVisitorSim) {
          meta.textContent = `粉丝 ${followers} · 关注 ${friends} · 已检 ${data.scannedCount || 0} 位 · 真实得分 ${scoreText}（仅自测参考）`;
        } else if (data.exemptReason === "self") {
          meta.textContent = data.fastSkippedExempt
            ? `粉丝 ${followers} · 关注 ${friends} · 本人默认免预警`
            : `粉丝 ${followers} · 关注 ${friends} · 已检 ${data.scannedCount || 0} 位（免计分）`;
        } else if (data.fastSkippedExempt) {
          meta.textContent = `粉丝 ${followers} · 关注 ${friends} · 已快速豁免`;
        } else if (data.scanMode === "fast_clean" || data.scanMode === "fast_high") {
          meta.textContent = `粉丝 ${followers} · 关注 ${friends} · 快筛 ${data.scannedCount || 0} 位 · 得分 ${scoreText}${sharedSuffix}`;
        } else {
          meta.textContent = `粉丝 ${followers} · 关注 ${friends} · 已检 ${data.scannedCount || 0} 位 · 得分 ${scoreText}${sharedSuffix}`;
        }
        pop.appendChild(meta);
      }

      const catCounts = data.categoryCounts || {};
      const activeCats = Object.entries(catCounts).filter(([, count]) => count > 0);
      if (activeCats.length > 0) {
        const cats = doc.createElement("div");
        cats.className = "wbr-popover-cats";
        for (const [cid, count] of activeCats) {
          const cMeta = Engine.CATEGORY_META[cid] || { shortLabel: cid };
          const chip = doc.createElement("span");
          chip.className = "wbr-cat-chip";
          chip.textContent = `${cMeta.shortLabel} ${count} 位`;
          cats.appendChild(chip);
        }
        pop.appendChild(cats);
      }

      if (Array.isArray(data.hitItems) && data.hitItems.length > 0) {
        const hits = doc.createElement("div");
        hits.className = "wbr-popover-hits";
        for (const item of data.hitItems) {
          const pill = doc.createElement("span");
          const isSharedExempt = Boolean(item.sharedWithViewer && item.sharedExempt !== false);
          const isSharedCore = Boolean(item.sharedWithViewer && item.sharedExempt === false);
          if (isSharedExempt) {
            pill.className = "wbr-hit-pill wbr-hit-pill-shared";
            pill.textContent = `${item.name} · 共同免计`;
            pill.title = "您也关注的泛话题/股评特征，默认不计入倾向分";
          } else if (isSharedCore) {
            pill.className = "wbr-hit-pill wbr-hit-pill-shared-core";
            pill.textContent = `${item.name} · 您也关注`;
            pill.title = `高纯度核心特征（权重 ${item.weight ?? 1}），默认保留计分；可在设置页开启「严格同圈豁免」`;
          } else {
            pill.className = "wbr-hit-pill";
            pill.textContent = item.viaAlias
              ? `${item.name} (${item.viaAlias}) · ${item.categoryLabel}`
              : `${item.name} · ${item.categoryLabel}`;
            pill.title = `特征权重 ${item.weight ?? 1}`;
          }
          hits.appendChild(pill);
        }
        pop.appendChild(hits);
      }

      if (!data._isSelfPlaceholder && !data._isMutedPlaceholder && ((data.hitCount || 0) > 0 || isVisitorSim)) {
        const note = doc.createElement("div");
        note.className = "wbr-popover-note";
        note.textContent = "统计倾向与结构相似参考，不构成对账号的定性判断";
        pop.appendChild(note);
      }

      const footer = doc.createElement("div");
      footer.className = "wbr-popover-footer";

      if (isSelfTarget && !data._isSelfPlaceholder && !data._isMutedPlaceholder) {
        const visitorBtn = doc.createElement("button");
        visitorBtn.type = "button";
        visitorBtn.className = isVisitorSim ? "wbr-act-btn" : "wbr-act-btn wbr-act-btn-primary";
        const visitorIcon = isVisitorSim ? "refresh" : "eye";
        const visitorBtnLabel = isVisitorSim ? "重新自测" : "模拟访客自测";
        setBtnIconLabel(visitorBtn, visitorIcon, visitorBtnLabel, 11);
        visitorBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          visitorBtn.disabled = true;
          setBtnIconLabel(visitorBtn, "refresh", "测算中...", 11);
          try {
            const fallbackAnchor = anchorEl && anchorEl.isConnected ? anchorEl : anchorRect;
            const res = await triggerUserCheck(targetUser, fallbackAnchor, true, {
              forceDeepScan: true,
              fullScan: true,
              simulateVisitor: true
            });
            if (!res && visitorBtn.isConnected) {
              visitorBtn.disabled = false;
              setBtnIconLabel(visitorBtn, visitorIcon, visitorBtnLabel, 11);
            }
          } catch (_) {
            if (visitorBtn.isConnected) {
              visitorBtn.disabled = false;
              setBtnIconLabel(visitorBtn, visitorIcon, visitorBtnLabel, 11);
            }
          }
        });
        footer.appendChild(visitorBtn);

        if (isVisitorSim) {
          const backBtn = doc.createElement("button");
          backBtn.type = "button";
          backBtn.className = "wbr-act-btn";
          backBtn.textContent = "返回免预警视图";
          backBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const cachedSelf = getCachedResult(targetUser);
            const fallbackSelf = cachedSelf && !cachedSelf.simulateVisitor
              ? cachedSelf
              : Engine.evaluateFollowing([], state, {
                  uid: targetUser.uid || loginUid,
                  screenName: targetUser.screenName || data.screenName,
                  followersCount: data.followersCount,
                  friendsCount: data.friendsCount,
                  isSelf: true,
                  scannedCount: 0,
                  scanMode: "exempt_fast",
                  fastSkippedExempt: true,
                  checkedAt: Date.now()
                });
            openDetailPopover(anchorEl && anchorEl.isConnected ? anchorEl : anchorRect, fallbackSelf, targetUser);
          });
          footer.appendChild(backBtn);
        }
      } else {
        const isPlaceholder = Boolean(data._isSelfPlaceholder || data._isMutedPlaceholder);
        const isFastExempt = Boolean(!isPlaceholder && data.fastSkippedExempt);
        const isFastMode = Boolean(!isPlaceholder && !isFastExempt && (data.scanMode === "fast_clean" || data.scanMode === "fast_high"));
        const recheckIcon = isPlaceholder || isFastExempt ? "search" : "refresh";
        const recheckLabel = isPlaceholder
          ? "查近期关注"
          : (isFastExempt ? "深查明细" : (isFastMode ? "查全量" : "重新查询"));
        const recheckOpts = isFastExempt
          ? { forceDeepScan: true, fullScan: true }
          : (isFastMode ? { fullScan: true } : {});

        const recheckBtn = doc.createElement("button");
        recheckBtn.type = "button";
        recheckBtn.className = "wbr-act-btn";
        setBtnIconLabel(recheckBtn, recheckIcon, recheckLabel, 11);
        recheckBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          recheckBtn.disabled = true;
          setBtnIconLabel(recheckBtn, "refresh", "查询中...", 11);
          try {
            const fallbackAnchor = anchorEl && anchorEl.isConnected ? anchorEl : anchorRect;
            const res = await triggerUserCheck(targetUser, fallbackAnchor, true, recheckOpts);
            if (!res && recheckBtn.isConnected) {
              recheckBtn.disabled = false;
              setBtnIconLabel(recheckBtn, recheckIcon, recheckLabel, 11);
            }
          } catch (_) {
            if (recheckBtn.isConnected) {
              recheckBtn.disabled = false;
              setBtnIconLabel(recheckBtn, recheckIcon, recheckLabel, 11);
            }
          }
        });

        const alreadyMuted = Boolean(Engine.findMutedMatch(targetUser, state));
        const muteBtn = doc.createElement("button");
        muteBtn.type = "button";
        muteBtn.className = "wbr-act-btn";
        muteBtn.textContent = alreadyMuted ? "取消屏蔽" : "屏蔽";
        muteBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (alreadyMuted) {
            await handleUnmuteUser(targetUser);
          } else {
            await handleMuteUser(targetUser, "manual");
          }
          closePopover();
        });

        footer.append(recheckBtn, muteBtn);

        if (!alreadyMuted) {
          const blockBtn = doc.createElement("button");
          blockBtn.type = "button";
          blockBtn.className = "wbr-act-btn wbr-act-btn-danger";
          blockBtn.textContent = "官方拉黑";
          bindInlineConfirmBlock(blockBtn, () => targetUser, "官方拉黑", "点此确认拉黑", () => {
            closePopover();
          });
          footer.appendChild(blockBtn);
        }
      }

      pop.appendChild(footer);
      positionPopover();
    }

    function getBadgeAppearance(result, runtimeEntry = null, st = state) {
      if (result) {
        if ((result.level === "high" || result.level === "warn") && !result.hiddenFollowing && !result.exemptReason && result.hitCount > 0) {
          const activeCats = Object.entries(result.categoryCounts || {})
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1]);
          const topCatId = activeCats[0] && activeCats[0][0];
          const topCat = topCatId
            ? (Engine.CATEGORY_META[topCatId] && Engine.CATEGORY_META[topCatId].shortLabel) || topCatId
            : "";
          const prob = result.probability || Engine.computeProbabilityFromScore(result.score ?? result.hitCount, result.hitCount);
          if (result.level === "high") {
            return {
              className: "wbr-badge wbr-badge-high",
              text: `定律 ${prob}% · ${result.hitCount}`,
              title: "点击查看关注列表定律匹配明细"
            };
          }
          const label = topCat && activeCats.length === 1
            ? `倾向 ${prob}% · 偏${topCat} ${result.hitCount}`
            : `倾向 ${prob}% · ${result.hitCount}`;
          return {
            className: "wbr-badge wbr-badge-warn",
            text: label,
            title: "点击查看关注列表定律匹配明细"
          };
        }

        if (!st || st.showCleanCheckmark === false) {
          return null;
        }
        if (result.exemptReason) {
          let exemptTooltip = "已检 · 已豁免（点击查看详情）";
          if (result.exemptReason === "self") {
            exemptTooltip = "已检 · 您本人的账号（免预警，点击查看详情）";
          } else if (result.exemptReason === "following") {
            exemptTooltip = "已检 · 您已关注（免预警，点击查看详情）";
          } else if (result.exemptReason === "org_verified") {
            exemptTooltip = "已检 · 官方蓝V机构号（免预警，点击查看详情）";
          }
          return {
            className: "wbr-badge wbr-badge-exempt",
            text: "✓",
            title: exemptTooltip
          };
        }
        if (result.hiddenFollowing) {
          return {
            className: "wbr-badge wbr-badge-hidden-list",
            text: "—",
            title: "已检 · 对方隐藏了关注列表（点击查看）"
          };
        }
        return {
          className: "wbr-badge wbr-badge-clean",
          text: "✓",
          title: `已检最近 ${result.scannedCount || 0} 位关注 · 未发现明显定律倾向（点击查看详情）`
        };
      }

      if (runtimeEntry) {
        if (runtimeEntry.status === "scanning") {
          return {
            className: "wbr-badge wbr-badge-scanning",
            text: runtimeEntry.currentPage > 0 ? `检测中 P${runtimeEntry.currentPage}` : "检测中…",
            title: "正在拉取关注列表，点击查看实时状态"
          };
        }
        if (runtimeEntry.status === "queued") {
          return {
            className: "wbr-badge wbr-badge-queued",
            text: "· 待检",
            title: "已在待检队列中 · 点击立即插队优先检测"
          };
        }
      }
      return null;
    }

    function applyBadgeProps(badge, result, user, runtimeEntry = null, precomputedAppearance = null) {
      const appearance = precomputedAppearance || getBadgeAppearance(result, runtimeEntry, state);
      if (!appearance) return false;
      if (badge.className !== appearance.className) {
        badge.className = appearance.className;
      }
      if (badge.textContent !== appearance.text) {
        badge.textContent = appearance.text;
      }
      const nextTitle = appearance.title || "点击查看关注列表定律匹配明细";
      if (badge.title !== nextTitle) {
        badge.title = nextTitle;
      }
      badge.__wbrResult = result || null;
      badge.__wbrRuntimeStatus = !result && runtimeEntry ? runtimeEntry.status : "";
      badge.__wbrUser = {
        uid: (user && user.uid) || (result && result.uid) || "",
        screenName: (user && user.screenName) || (result && result.screenName) || "",
        profileHint: user && user.profileHint
      };
      return true;
    }

    function bindStopPropagation(el) {
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    }

    function renderBadgeElement(result, user, runtimeEntry = null, precomputedAppearance = null) {
      const badge = doc.createElement("span");
      badge.setAttribute("data-wbr-badge", "1");
      if (!applyBadgeProps(badge, result, user, runtimeEntry, precomputedAppearance)) return null;
      bindStopPropagation(badge);
      badge.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const targetUser = badge.__wbrUser || user;
        const latestCached = badge.__wbrResult || getCachedResult(targetUser);
        if (latestCached) {
          openDetailPopover(badge, latestCached, targetUser);
        } else {
          triggerUserCheck(targetUser, badge, false);
        }
      });
      return badge;
    }

    async function handleMuteUser(user, source = "manual") {
      if (!user || (!user.uid && !user.screenName)) return;
      const resp = await sendMessage({
        type: "WBR_MUTE_USER",
        user: {
          uid: user.uid,
          screenName: user.screenName,
          source,
          reason: "主站快捷屏蔽"
        }
      });
      if (resp && resp.ok && resp.state) {
        state = Engine.normalizeState(resp.state);
        applyAll();
        showToast(`已屏蔽 @${user.screenName || "该用户"}`);
      }
    }

    async function handleUnmuteUser(user) {
      if (!user || (!user.uid && !user.screenName)) return;
      const resp = await sendMessage({
        type: "WBR_UNMUTE_USER",
        user: { uid: user.uid, screenName: user.screenName }
      });
      if (resp && resp.ok && resp.state) {
        state = Engine.normalizeState(resp.state);
        applyAll();
        showToast(`已取消屏蔽 @${user.screenName || "该用户"}`);
      }
    }

    async function handleBlockUser(user) {
      if (!user || (!user.uid && !user.screenName)) return;
      const resp = await sendMessage({
        type: "WBR_BLOCK_USER",
        uid: user.uid,
        screenName: user.screenName,
        alsoMute: true
      });
      if (resp && resp.state) {
        state = Engine.normalizeState(resp.state);
        applyAll();
      }
      if (resp && resp.officialBlocked) {
        showToast(`已官方拉黑并屏蔽 @${user.screenName || "该用户"}`);
      } else {
        showToast(`官方拉黑暂未成功，已为您本地屏蔽 @${user.screenName || "该用户"}`);
      }
    }

    async function triggerUserCheck(user, anchorEl, forceRefresh = false, extraOpts = {}) {
      const fullScan = Boolean(extraOpts && extraOpts.fullScan);
      const forceDeepScan = Boolean(extraOpts && extraOpts.forceDeepScan);
      const simulateVisitor = Boolean(extraOpts && extraOpts.simulateVisitor);
      if (!forceRefresh && !fullScan && !forceDeepScan && !simulateVisitor) {
        const cached = getCachedResult(user);
        if (cached) {
          openDetailPopover(anchorEl, cached, user);
          return cached;
        }
      }
      ensureAccountDetectedLazy();
      const prevPopRect = popoverEl && popoverEl.isConnected
        ? popoverEl.getBoundingClientRect()
        : resolveAnchorRect(anchorEl);
      const myReqSeq = openLoadingPopover(
        anchorEl && anchorEl.isConnected ? anchorEl : prevPopRect,
        user,
        "",
        { simulateVisitor }
      );

      const entry = getRegistryEntry(user);
      if (!simulateVisitor && entry && entry.status !== "muted") {
        entry.status = "scanning";
        entry.currentPage = 0;
        refreshBadgesForEntry(entry);
        renderLiveWidget();
      }

      let resp = null;
      try {
        resp = await sendMessage({
          type: "WBR_CHECK_USER",
          uid: user.uid,
          screenName: user.screenName,
          profileHint: user.profileHint || (entry && entry.profileHint),
          mode: "manual",
          forceRefresh: Boolean(forceRefresh || fullScan || forceDeepScan || simulateVisitor),
          fullScan,
          forceDeepScan,
          simulateVisitor
        }, 35000);
      } catch (err) {
        resp = { ok: false, error: (err && err.message) || "查询关注列表失败，请稍后再试" };
      }

      if (!resp || !resp.ok || !resp.result) {
        if (!simulateVisitor && entry && entry.status === "scanning") {
          entry.status = resp && resp.isCircuitBreaker ? "paused" : "queued";
          refreshBadgesForEntry(entry);
          renderLiveWidget();
        }
        const msg = (resp && resp.error) || "查询关注列表失败，请稍后再试";
        if (myReqSeq === activeLoadingReqSeq) {
          openLoadingPopover(anchorEl && anchorEl.isConnected ? anchorEl : prevPopRect, user, msg, { simulateVisitor });
          showToast(msg, resp && resp.isCircuitBreaker ? 4500 : 2800);
        }
        return null;
      }

      const res = resp.result;
      if (!res.simulateVisitor) {
        storeCachedResult(res, user);
        if (entry) entry.status = "done";
        await applyAll(false);
      }
      if (myReqSeq !== activeLoadingReqSeq) {
        return res;
      }
      if (anchorEl && anchorEl.isConnected) {
        openDetailPopover(anchorEl, res, user);
      } else if (popoverEl && popoverEl.isConnected) {
        openDetailPopover(popoverEl.getBoundingClientRect(), res, user);
      } else {
        openDetailPopover(prevPopRect, res, user);
      }
      return res;
    }

    function findOwnedSingleBadge(anchorEl, attrName) {
      const parent = anchorEl && anchorEl.parentNode;
      if (!parent || typeof parent.querySelectorAll !== "function") return null;
      for (const el of parent.querySelectorAll(`:scope > [${attrName}="1"]`)) {
        if (el.__wbrOwnerAnchor === anchorEl) return el;
      }
      // Fallback only for adjacent unowned legacy badges
      let cur = anchorEl.nextElementSibling;
      while (cur && cur.getAttribute) {
        if (cur.__wbrOwnerAnchor && cur.__wbrOwnerAnchor !== anchorEl) break;
        if (cur.getAttribute(attrName) === "1") return cur;
        if (
          isDecorativeTrailingBadgeEl(cur) ||
          cur.getAttribute("data-wbr-badge") === "1" ||
          cur.getAttribute("data-wbr-self-badge") === "1" ||
          cur.getAttribute("data-wbr-muted-badge") === "1"
        ) {
          cur = cur.nextElementSibling;
          continue;
        }
        break;
      }
      return null;
    }

    function ensureBadgesOnAnchor(anchorEl, user, opts = {}) {
      if (!anchorEl || !anchorEl.parentNode) return;
      const skipMuted = Boolean(opts && opts.skipMuted);

      const mutedMatch = skipMuted ? null : Engine.findMutedMatch(user, state);
      const selfHit = Engine.matchSelfFeature(user, state);
      const cached = getCachedResult(user);
      const runtimeEntry = mutedMatch ? null : getRegistryEntry(user);
      const badgeAppearance = cached
        ? getBadgeAppearance(cached, runtimeEntry, state)
        : (mutedMatch ? null : getBadgeAppearance(null, runtimeEntry, state));

      const runtimeStatusKey = runtimeEntry ? `${runtimeEntry.status}:${runtimeEntry.currentPage || 0}` : "";
      const sig = [
        user.uid || "",
        user.screenName || "",
        state.showCleanCheckmark ? "1" : "0",
        skipMuted ? "1" : "0",
        runtimeStatusKey,
        mutedMatch ? `${mutedMatch.key}:${mutedMatch.mode}:${mutedMatch.source}` : "",
        selfHit ? selfHit.entry.id : "",
        badgeAppearance
          ? `${cached ? `${cached.checkedAt || 0}:${cached.hitCount || 0}:${cached.score || 0}:${cached.probability || 0}:${cached.level || ""}:` : ""}${badgeAppearance.className}:${badgeAppearance.text}`
          : ""
      ].join("|");

      const existingBadge = findOwnedSingleBadge(anchorEl, "data-wbr-badge");
      const existingSelf = findOwnedSingleBadge(anchorEl, "data-wbr-self-badge");
      const existingMuted = findOwnedSingleBadge(anchorEl, "data-wbr-muted-badge");

      const domConsistent =
        Boolean(badgeAppearance) === Boolean(existingBadge) &&
        Boolean(selfHit) === Boolean(existingSelf) &&
        Boolean(mutedMatch) === Boolean(existingMuted);

      if (anchorEl.getAttribute("data-wbr-badge-sig") === sig && domConsistent) {
        if (existingBadge && badgeAppearance) {
          existingBadge.__wbrOwnerAnchor = anchorEl;
          applyBadgeProps(existingBadge, cached, user, runtimeEntry, badgeAppearance);
        }
        if (existingSelf && selfHit) {
          existingSelf.__wbrOwnerAnchor = anchorEl;
          existingSelf.__wbrUser = { uid: user.uid, screenName: user.screenName };
          existingSelf.__wbrSelf = selfHit;
        }
        if (existingMuted && mutedMatch) {
          existingMuted.__wbrOwnerAnchor = anchorEl;
          existingMuted.__wbrUser = { uid: user.uid, screenName: user.screenName };
          existingMuted.__wbrMuted = mutedMatch;
        }
        return;
      }

      const insertRef = findAnchorFollowingInsertRef(anchorEl, false);

      if (mutedMatch) {
        const mutedText = mutedMatch.source === "weibo_block" ? "已拉黑" : "已屏蔽";
        if (existingMuted) {
          if (existingMuted.textContent !== mutedText) existingMuted.textContent = mutedText;
          existingMuted.__wbrOwnerAnchor = anchorEl;
          existingMuted.__wbrUser = { uid: user.uid, screenName: user.screenName };
          existingMuted.__wbrMuted = mutedMatch;
        } else {
          const mb = doc.createElement("span");
          mb.className = "wbr-badge wbr-badge-muted";
          mb.setAttribute("data-wbr-muted-badge", "1");
          mb.__wbrOwnerAnchor = anchorEl;
          mb.textContent = mutedText;
          mb.title = "点击查看详情或取消屏蔽";
          mb.__wbrUser = { uid: user.uid, screenName: user.screenName };
          mb.__wbrMuted = mutedMatch;
          bindStopPropagation(mb);
          mb.addEventListener("click", (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const u = mb.__wbrUser || user;
            const m = mb.__wbrMuted || mutedMatch;
            const c = getCachedResult(u);
            if (c) {
              openDetailPopover(mb, c, u);
            } else {
              openDetailPopover(mb, {
                uid: u.uid,
                screenName: u.screenName,
                _isMutedPlaceholder: true,
                mutedReason: m.reason || (m.source === "weibo_block" ? "微博黑名单" : "手动屏蔽"),
                hitItems: [],
                categoryCounts: {}
              }, u);
            }
          });
          insertRef.insertAdjacentElement("afterend", mb);
        }
      } else if (existingMuted) {
        existingMuted.remove();
      }

      if (selfHit) {
        const selfText = `特征源 · ${selfHit.categoryLabel}`;
        if (existingSelf) {
          if (existingSelf.textContent !== selfText) existingSelf.textContent = selfText;
          existingSelf.__wbrOwnerAnchor = anchorEl;
          existingSelf.__wbrUser = { uid: user.uid, screenName: user.screenName };
          existingSelf.__wbrSelf = selfHit;
        } else {
          const sb = doc.createElement("span");
          sb.className = "wbr-badge wbr-badge-self";
          sb.setAttribute("data-wbr-self-badge", "1");
          sb.__wbrOwnerAnchor = anchorEl;
          sb.textContent = selfText;
          sb.title = "点击查看圈层说明或近期关注";
          sb.__wbrUser = { uid: user.uid, screenName: user.screenName };
          sb.__wbrSelf = selfHit;
          bindStopPropagation(sb);
          sb.addEventListener("click", (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const u = sb.__wbrUser || user;
            const sh = sb.__wbrSelf || selfHit;
            const c = getCachedResult(u);
            if (c) {
              openDetailPopover(sb, c, u);
            } else {
              openDetailPopover(sb, {
                uid: u.uid,
                screenName: u.screenName,
                _isSelfPlaceholder: true,
                selfCategoryLabel: sh.categoryLabel,
                selfCategoryFull: sh.categoryFullLabel,
                hitItems: [],
                categoryCounts: {}
              }, u);
            }
          });
          insertRef.insertAdjacentElement("afterend", sb);
        }
      } else if (existingSelf) {
        existingSelf.remove();
      }

      if (badgeAppearance) {
        if (existingBadge) {
          existingBadge.__wbrOwnerAnchor = anchorEl;
          applyBadgeProps(existingBadge, cached, user, runtimeEntry, badgeAppearance);
        } else {
          const badge = renderBadgeElement(cached, user, runtimeEntry, badgeAppearance);
          if (badge) {
            badge.__wbrOwnerAnchor = anchorEl;
            insertRef.insertAdjacentElement("afterend", badge);
          }
        }
      } else if (existingBadge) {
        existingBadge.remove();
      }

      anchorEl.setAttribute("data-wbr-badge-sig", sig);
    }

    function hideHoverCheckBtn() {
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
      clearTimeout(hoverTimer);
      hoverCurrentHost = null;
      hoverCurrentUser = null;
      if (hoverBtnEl) {
        hoverBtnEl.__wbrUser = null;
        if (hoverBtnEl.parentNode) {
          isApplyingDom = true;
          try {
            hoverBtnEl.remove();
          } finally {
            if (activeObserver && typeof activeObserver.takeRecords === "function") {
              activeObserver.takeRecords();
            }
            isApplyingDom = false;
          }
        }
      }
    }

    function scheduleHideHoverBtn(delay = 80) {
      if (hoverHideTimer) clearTimeout(hoverHideTimer);
      hoverHideTimer = setTimeout(() => {
        hoverHideTimer = null;
        hideHoverCheckBtn();
      }, delay);
    }

    function refreshHoverButtonState() {
      if (!hoverBtnEl || !hoverCurrentUser) return;
      const user = hoverCurrentUser;
      const entry = getRegistryEntry(user);
      const cached = getCachedResult(user);
      const isScanning = Boolean(entry && entry.status === "scanning");
      hoverBtnEl.__wbrUser = {
        uid: user.uid,
        screenName: user.screenName,
        profileHint: user.profileHint
      };
      if (isScanning) {
        hoverBtnEl.textContent = "检测中…";
        hoverBtnEl.disabled = true;
        hoverBtnEl.className = "wbr-hover-check-btn is-scanning";
        hoverBtnEl.title = "正在查询关注列表…";
      } else if (cached) {
        const isFlagged = Boolean(
          (cached.level === "warn" || cached.level === "high") &&
            !cached.hiddenFollowing &&
            !cached.exemptReason &&
            cached.hitCount > 0
        );
        if (isFlagged) {
          hoverBtnEl.textContent = "详情";
        } else {
          setBtnIconLabel(hoverBtnEl, "check", "已查", 11);
        }
        hoverBtnEl.disabled = false;
        hoverBtnEl.className = "wbr-hover-check-btn is-checked";
        hoverBtnEl.title = "点击查看关注列表检测详情";
      } else {
        setBtnIconLabel(hoverBtnEl, "search", "查成分", 11);
        hoverBtnEl.disabled = false;
        hoverBtnEl.className = "wbr-hover-check-btn";
        hoverBtnEl.title = "看看TA平时关注哪些圈子";
      }
    }

    function getOrCreateHoverCheckBtn() {
      if (hoverBtnEl) return hoverBtnEl;
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "wbr-hover-check-btn";
      btn.setAttribute("data-wbr-hover-btn", "1");
      setBtnIconLabel(btn, "search", "查成分", 11);
      bindStopPropagation(btn);
      btn.addEventListener("pointerenter", () => {
        if (hoverHideTimer) {
          clearTimeout(hoverHideTimer);
          hoverHideTimer = null;
        }
      });
      btn.addEventListener("pointerleave", () => {
        scheduleHideHoverBtn(80);
      });
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const target = btn.__wbrUser || hoverCurrentUser;
        if (!target || (!target.uid && !target.screenName)) return;
        btn.disabled = true;
        try {
          await triggerUserCheck(target, btn, false);
        } finally {
          refreshHoverButtonState();
        }
      });
      hoverBtnEl = btn;
      return btn;
    }

    function isInlineTextMentionLink(link) {
      if (!link || isDecorativeUserLink(link)) return false;
      // Ignore main feed header author links (handled by feed header right mount)
      if (link.closest && link.closest('article header, [class*="Feed_wrap"] header, [class*="head_"]')) {
        return false;
      }
      // Check if link is inside a comment/repost row BEFORE its colon (that's the row's main author)
      const commentRow = link.closest
        ? link.closest('.wbpro-list .list2 > .item2, .wbpro-list, [data-wbr-comment-row]')
        : null;
      if (commentRow) {
        const mainAuthor = findBestAuthorAnchor(commentRow);
        if (mainAuthor === link) return false;
        const colonEl = commentRow.querySelector('[class*="_colon_"]');
        if (colonEl && typeof colonEl.compareDocumentPosition === "function") {
          const pos = colonEl.compareDocumentPosition(link);
          if (!(pos & 4)) return false;
        }
        return true;
      }
      // Check if link is inside a generic/repost scroller row
      const genericRow = link.closest
        ? link.closest('.vue-recycle-scroller__item-view, .wbpro-scroller-item, [class*="Repost_"], [class*="repostItem" i]')
        : null;
      if (genericRow && !genericRow.querySelector('article, [class*="Feed_wrap"]')) {
        const rowAuthor = findBestAuthorAnchor(genericRow);
        if (rowAuthor === link) return false;
        if (link.closest('[class*="text"], [class*="Text"], [class*="content"]')) {
          return true;
        }
      }
      // Check if link is inside a retweet box as its leading main author
      const reBox = link.closest ? link.closest('.retweet, [class*="_retweet_"], [class*="Feed_retweet"]') : null;
      if (reBox) {
        const reAuthor = findBestAuthorAnchor(reBox);
        if (reAuthor === link) return false;
        return true;
      }
      // Inside a feed card or post text block (not header)
      if (
        link.closest &&
        link.closest('[class*="wbpro-feed-ogText"], [class*="wbpro-feed-reText"], [class*="Feed_text"], [class*="detail_wbtext"], [class*="Detail_text"], [class*="wbpro-feed-content"], article, [class*="Feed_wrap"]')
      ) {
        return true;
      }
      return false;
    }

    function findHoveredInlineMention(rawTarget) {
      if (!rawTarget || !rawTarget.closest) return null;
      let link = rawTarget.closest(USER_LINK_SELECTOR);
      if (link && isDecorativeUserLink(link)) {
        link = null;
      }
      if (!link) {
        let badgeNode = rawTarget;
        while (badgeNode && badgeNode !== doc.body && !isDecorativeTrailingBadgeEl(badgeNode)) {
          if (badgeNode.matches && badgeNode.matches(USER_LINK_SELECTOR)) break;
          badgeNode = badgeNode.parentElement;
        }
        if (badgeNode && isDecorativeTrailingBadgeEl(badgeNode)) {
          let cur = badgeNode.previousSibling;
          let steps = 0;
          while (cur && steps < 6) {
            if (cur.nodeType === 3) {
              if (String(cur.textContent || "").trim()) break;
              cur = cur.previousSibling;
              steps += 1;
              continue;
            }
            if (cur.nodeType !== 1) break;
            if (cur.matches && cur.matches(USER_LINK_SELECTOR) && !isDecorativeUserLink(cur)) {
              link = cur;
              break;
            }
            if (isDecorativeTrailingBadgeEl(cur)) {
              cur = cur.previousSibling;
              steps += 1;
              continue;
            }
            break;
          }
        }
      }
      if (!link || !isInlineTextMentionLink(link)) return null;
      const user = extractUserFromContainer(null, link);
      if (!user || (!user.uid && !user.screenName) || Engine.findMutedMatch(user, state)) {
        return null;
      }
      const mount = link.parentElement
        ? { host: link.parentElement, mode: "afterAnchor", extraClass: "wbr-hover-inline-mention" }
        : null;
      return { hostEl: link, user, mount, anchorEl: link };
    }

    function resolveHoverTargetFromNode(rawTarget) {
      if (!rawTarget || rawTarget.nodeType !== 1) return null;
      if (hoverBtnEl && (rawTarget === hoverBtnEl || (hoverBtnEl.contains && hoverBtnEl.contains(rawTarget)))) {
        return { keepExisting: true };
      }
      if (rawTarget.closest && rawTarget.closest(".wbr-popover, .wbr-drawer, .wbr-live-widget, .wbr-muted-banner, .wbr-comment-toolbar, .wbr-shield-banner, [data-wbr-usercard-pop='1'], .wbr-usercard-bar, .wbr-usercard-btn")) {
        return null;
      }

      // 0. Inline @user / //@repost-chain mention (including hovering its adjacent fan badge)
      const inlineMention = findHoveredInlineMention(rawTarget);
      if (inlineMention) {
        return inlineMention;
      }

      // 1. Sub-comment (.item2)
      const subComment = rawTarget.closest ? rawTarget.closest(".wbpro-list .list2 > .item2") : null;
      if (subComment && !isInsideWeiboChromeUi(subComment)) {
        const subCon = subComment.querySelector(".con2");
        const subAnchor = findBestAuthorAnchor((subCon && subCon.querySelector(":scope > .text")) || subComment) || findBestAuthorAnchor(subComment);
        if (subAnchor) {
          const user = extractUserFromContainer(subComment, subAnchor);
          if (user && (user.uid || user.screenName) && !Engine.findMutedMatch(user, state)) {
            return {
              hostEl: subComment,
              user,
              mount: findCommentActionMount(subCon, subAnchor),
              anchorEl: subAnchor
            };
          }
        }
      }

      // 2. Main comment row (.wbpro-list / [data-wbr-comment-row])
      const commentRow = rawTarget.closest ? rawTarget.closest(".wbpro-list, [data-wbr-comment-row]") : null;
      if (commentRow && !isInsideWeiboChromeUi(commentRow)) {
        const item1 = commentRow.querySelector(":scope > .item1");
        const mainCon = (item1 && item1.querySelector(".con1")) || commentRow.querySelector(".con1");
        const textScope = (mainCon && mainCon.querySelector(":scope > .text")) || item1 || commentRow;
        const anchor = findBestAuthorAnchor(textScope) || findBestAuthorAnchor(item1 || commentRow);
        if (anchor) {
          const user = extractUserFromContainer(commentRow, anchor);
          if (user && (user.uid || user.screenName) && !Engine.findMutedMatch(user, state)) {
            return {
              hostEl: commentRow,
              user,
              mount: findCommentActionMount(mainCon, anchor),
              anchorEl: anchor
            };
          }
        }
      }

      // 3. Retweet box inside feed card
      const reBox = rawTarget.closest ? rawTarget.closest('.retweet, [class*="_retweet_"], [class*="Feed_retweet"]') : null;
      if (reBox && !isInsideWeiboChromeUi(reBox)) {
        const reAnchor = findBestAuthorAnchor(reBox);
        if (reAnchor) {
          const reUser = extractUserFromContainer(reBox, reAnchor);
          if (reUser && (reUser.uid || reUser.screenName) && !Engine.findMutedMatch(reUser, state)) {
            const mount = reAnchor.parentElement
              ? { host: reAnchor.parentElement, mode: "append", extraClass: "wbr-hover-row-end" }
              : null;
            return { hostEl: reBox, user: reUser, mount, anchorEl: reAnchor };
          }
        }
      }

      // 4. Feed card
      const card = rawTarget.closest ? rawTarget.closest('article, [class*="Feed_wrap"]') : null;
      if (card && !isInsideWeiboChromeUi(card)) {
        const headerScope = card.querySelector('header, [class*="head_"]') || card;
        const anchor = findBestAuthorAnchor(headerScope);
        if (anchor) {
          const user = extractUserFromContainer(card, anchor);
          if (user && (user.uid || user.screenName) && !Engine.findMutedMatch(user, state)) {
            return {
              hostEl: card,
              user,
              mount: findFeedHeaderActionMount(card, anchor),
              anchorEl: anchor
            };
          }
        }
      }

      // 5. Generic user row (lists, search, repost list)
      const genericRow = rawTarget.closest
        ? rawTarget.closest('main .vue-recycle-scroller__item-view, main .wbpro-scroller-item, main [class*="UserCard"], main [class*="Repost_"], main [class*="repostItem" i], .woo-modal-main .vue-recycle-scroller__item-view, [role="dialog"] .vue-recycle-scroller__item-view')
        : null;
      if (genericRow && !isInsideWeiboChromeUi(genericRow) && !genericRow.querySelector('article, [class*="Feed_wrap"]')) {
        const anchor = findBestAuthorAnchor(genericRow);
        if (anchor) {
          const user = extractUserFromContainer(genericRow, anchor);
          if (user && (user.uid || user.screenName) && !Engine.findMutedMatch(user, state)) {
            const mount = anchor.parentElement ? { host: anchor.parentElement, mode: "afterAnchor" } : null;
            return { hostEl: genericRow, user, mount, anchorEl: anchor };
          }
        }
      }

      // 6. Direct user link fallback
      const directLink = rawTarget.closest ? rawTarget.closest(USER_LINK_SELECTOR) : null;
      if (directLink && !isDecorativeUserLink(directLink)) {
        const user = extractUserFromContainer(null, directLink);
        if (user && (user.uid || user.screenName) && !Engine.findMutedMatch(user, state)) {
          const mount = directLink.parentElement ? { host: directLink.parentElement, mode: "afterAnchor" } : null;
          return { hostEl: directLink, user, mount, anchorEl: directLink };
        }
      }

      return null;
    }

    function mountHoverBtnAt(resolved) {
      if (!resolved || !resolved.mount || !resolved.mount.host) {
        scheduleHideHoverBtn(80);
        return;
      }
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
      const btn = getOrCreateHoverCheckBtn();
      const { hostEl, user, mount, anchorEl } = resolved;
      const prevKey = getUserKey(hoverCurrentUser);
      const nextKey = getUserKey(user);
      hoverCurrentHost = hostEl;
      hoverCurrentUser = user;
      refreshHoverButtonState();

      const extraClass = mount.extraClass || "";
      btn.classList.toggle("wbr-hover-in-info", extraClass === "wbr-actions-in-info");
      btn.classList.toggle("wbr-hover-header-right", extraClass === "wbr-actions-header-right");
      btn.classList.toggle("wbr-hover-row-end", extraClass === "wbr-actions-row-end" || extraClass === "wbr-hover-row-end");
      btn.classList.toggle("wbr-hover-inline-mention", extraClass === "wbr-hover-inline-mention");

      const host = mount.host;
      const mode = mount.mode || "append";
      const insertRef = mode === "afterAnchor" && anchorEl ? findAnchorFollowingInsertRef(anchorEl, true) : null;
      const alreadyMountedAtTarget =
        btn.parentNode === host &&
        (mode !== "before" || btn.nextSibling === mount.beforeEl) &&
        (mode !== "afterAnchor" || (insertRef && insertRef.nextElementSibling === btn));

      if (!alreadyMountedAtTarget) {
        isApplyingDom = true;
        try {
          if (mode === "before" && mount.beforeEl && mount.beforeEl.parentNode === host) {
            host.insertBefore(btn, mount.beforeEl);
          } else if (mode === "prepend") {
            host.prepend(btn);
          } else if (mode === "afterAnchor" && insertRef && insertRef.parentNode === host) {
            insertRef.insertAdjacentElement("afterend", btn);
          } else {
            host.appendChild(btn);
          }
        } finally {
          if (activeObserver && typeof activeObserver.takeRecords === "function") {
            activeObserver.takeRecords();
          }
          isApplyingDom = false;
        }
      }

      if (prevKey !== nextKey) {
        clearTimeout(hoverTimer);
        if (state.hoverAutoCheck && !getCachedResult(user)) {
          hoverTimer = setTimeout(() => {
            if (hoverCurrentUser && getUserKey(hoverCurrentUser) === nextKey && btn.isConnected) {
              triggerUserCheck(hoverCurrentUser, btn, false);
            }
          }, 450);
        }
      }
    }

    function bindHoverDelegation() {
      if (hoverDelegationBound || !doc || typeof doc.addEventListener !== "function") return;
      hoverDelegationBound = true;
      doc.addEventListener(
        "pointerover",
        (ev) => {
          syncRouteScopeIfChanged();
          if (!state.enabled || !state.enableMainSite) {
            hideHoverCheckBtn();
            return;
          }
          const t = ev && ev.target;
          if (t && t.closest && t.closest('[data-wbr-usercard-pop="1"], .wbr-usercard-bar, .wbr-usercard-btn')) {
            hideHoverCheckBtn();
            return;
          }
          const resolved = resolveHoverTargetFromNode(t);
          if (!resolved) {
            scheduleHideHoverBtn(80);
            return;
          }
          if (resolved.keepExisting) {
            if (hoverHideTimer) {
              clearTimeout(hoverHideTimer);
              hoverHideTimer = null;
            }
            return;
          }
          mountHoverBtnAt(resolved);
        },
        { passive: true }
      );
      doc.addEventListener("pointerleave", () => {
        scheduleHideHoverBtn(80);
      });
    }

    function removeStrayInlineActions() {
      const strayBars = doc.querySelectorAll('.wbr-inline-actions[data-wbr-actions="1"]');
      for (const bar of strayBars) {
        bar.remove();
      }
    }

    function applyCollapseOrExpand(containerEl, user, mutedMatch, labelPrefix = "已收起") {
      if (!containerEl) return;
      const existingBanner = containerEl.querySelector(':scope > .wbr-muted-banner[data-wbr-banner="1"]');
      const targetKey = (user && (user.uid || Engine.normalizeKey(user.screenName))) || "";
      const prevKey = containerEl.getAttribute("data-wbr-muted-key") || "";
      if (prevKey !== targetKey) {
        containerEl.setAttribute("data-wbr-muted-key", targetKey);
        containerEl.removeAttribute("data-wbr-temp-expanded");
      }

      if (!mutedMatch) {
        if (containerEl.classList.contains("wbr-hidden-node")) {
          containerEl.classList.remove("wbr-hidden-node");
        }
        if (containerEl.hasAttribute("data-wbr-hidden")) {
          containerEl.removeAttribute("data-wbr-hidden");
        }
        if (existingBanner) existingBanner.remove();
        for (const child of Array.from(containerEl.children)) {
          if (child.classList.contains("wbr-collapsed-child")) {
            child.classList.remove("wbr-collapsed-child");
          }
        }
        return;
      }

      if (mutedMatch.mode === "hide") {
        if (existingBanner) existingBanner.remove();
        containerEl.classList.add("wbr-hidden-node");
        containerEl.setAttribute("data-wbr-hidden", "1");
        return;
      }

      containerEl.classList.remove("wbr-hidden-node");
      containerEl.removeAttribute("data-wbr-hidden");
      const tempExpanded = containerEl.getAttribute("data-wbr-temp-expanded") === "1";

      for (const child of Array.from(containerEl.children)) {
        if (child.classList.contains("wbr-muted-banner")) continue;
        if (tempExpanded) {
          child.classList.remove("wbr-collapsed-child");
        } else {
          child.classList.add("wbr-collapsed-child");
        }
      }

      const displayTarget = `@${user.screenName || mutedMatch.screenName || user.uid}`;
      if (!existingBanner) {
        const banner = doc.createElement("div");
        banner.className = "wbr-muted-banner";
        banner.setAttribute("data-wbr-banner", "1");

        const info = doc.createElement("span");
        info.className = "wbr-muted-banner-text";
        info.textContent = `${labelPrefix} ${displayTarget} 的内容`;

        const acts = doc.createElement("span");
        acts.className = "wbr-muted-banner-actions";

        const toggleBtn = doc.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "wbr-link-btn";
        toggleBtn.textContent = tempExpanded ? "重新收起" : "看一眼";
        toggleBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const cur = containerEl.getAttribute("data-wbr-temp-expanded") === "1";
          containerEl.setAttribute("data-wbr-temp-expanded", cur ? "0" : "1");
          applyAll();
        });

        const unmuteBtn = doc.createElement("button");
        unmuteBtn.type = "button";
        unmuteBtn.className = "wbr-link-btn wbr-link-btn-muted";
        unmuteBtn.textContent = "取消屏蔽";
        unmuteBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const curUser = {
            uid: containerEl.getAttribute("data-wbr-muted-uid") || user.uid,
            screenName: containerEl.getAttribute("data-wbr-muted-uname") || user.screenName || mutedMatch.screenName
          };
          handleUnmuteUser(curUser);
        });

        acts.append(toggleBtn, unmuteBtn);
        banner.append(info, acts);
        containerEl.prepend(banner);
      } else {
        const info = existingBanner.querySelector(".wbr-muted-banner-text");
        if (info) info.textContent = `${labelPrefix} ${displayTarget} 的内容`;
        const btn = existingBanner.querySelector(".wbr-link-btn");
        if (btn) btn.textContent = tempExpanded ? "重新收起" : "看一眼";
      }
      containerEl.setAttribute("data-wbr-muted-uid", user.uid || "");
      containerEl.setAttribute("data-wbr-muted-uname", user.screenName || mutedMatch.screenName || "");
    }

    function isRepostChainMentionAnchor(a) {
      if (!a) return false;
      let cur = a.previousSibling;
      let steps = 0;
      while (cur && steps < 4) {
        if (cur.nodeType === 3) {
          const txt = String(cur.textContent || "");
          if (/\/\/\s*@?\s*$/.test(txt) || /回复\s*@?\s*$/.test(txt)) return true;
          if (txt.trim()) break;
          cur = cur.previousSibling;
          steps += 1;
          continue;
        }
        if (cur.nodeType === 1) {
          const txt = String(cur.textContent || "").trim();
          if (/\/\/\s*@?$/.test(txt) || /回复\s*@?$/.test(txt)) return true;
          break;
        }
        break;
      }
      return false;
    }

    function findOwnedInlineMutedChip(anchorEl) {
      const parent = anchorEl && anchorEl.parentNode;
      if (!parent || typeof parent.querySelectorAll !== "function") return null;
      for (const el of parent.querySelectorAll(':scope > [data-wbr-inline-muted="1"]')) {
        if (el.__wbrOwnerAnchor === anchorEl) return el;
      }
      return null;
    }

    function processInlineRepostMentions(container, collectedUids) {
      if (!container) return;
      const textSel = '[class*="wbpro-feed-ogText"], [class*="wbpro-feed-reText"], [class*="Feed_text"], [class*="detail_wbtext"], [class*="Detail_text"], .wbpro-list .text, [class*="Repost"] [class*="text"]';
      const matchedEls = Array.from(container.querySelectorAll(textSel));
      if (container.matches && container.matches(textSel)) {
        matchedEls.unshift(container);
      }
      const processedEls = new Set();
      for (const el of matchedEls) {
        if (processedEls.has(el)) continue;
        processedEls.add(el);
        if (isInsideWeiboChromeUi(el)) continue;

        // Remove legacy unowned inline muted chips only when text length changed
        const textLenSig = String((el.textContent || "").length);
        if (el.getAttribute("data-wbr-mention-sig") !== textLenSig) {
          for (const oldChip of el.querySelectorAll(':scope > [data-wbr-inline-muted="1"]')) {
            if (!oldChip.__wbrOwnerAnchor || !oldChip.__wbrOwnerAnchor.isConnected) {
              oldChip.remove();
            }
          }
          el.setAttribute("data-wbr-mention-sig", textLenSig);
        }

        const parentCommentRow = el.closest ? el.closest('.wbpro-list, [data-wbr-comment-row]') : null;
        const parentColon = parentCommentRow ? parentCommentRow.querySelector('[class*="_colon_"]') : null;
        const parentRetweet = el.closest ? el.closest('.retweet, [class*="_retweet_"], [class*="Feed_retweet"]') : null;
        const parentRetweetAuthor = parentRetweet ? findBestAuthorAnchor(parentRetweet) : null;

        const links = el.querySelectorAll(USER_LINK_SELECTOR);
        for (const a of links) {
          if (isDecorativeUserLink(a)) continue;
          if (parentRetweetAuthor && a === parentRetweetAuthor) continue;
          if (parentColon && typeof parentColon.compareDocumentPosition === "function") {
            const pos = parentColon.compareDocumentPosition(a);
            if (!(pos & 4)) continue;
          }
          const u = extractUserFromContainer(null, a);
          if (!u.uid && !u.screenName) continue;

          const isRepostChain = isRepostChainMentionAnchor(a);
          const muted = Engine.findMutedMatch(u, state);
          const existingChip = findOwnedInlineMutedChip(a);

          if (isRepostChain) {
            registerUserToPage(u, a, el, collectedUids);
            if (muted) {
              const chipText = `[已屏蔽原博主 @${u.screenName || muted.screenName}]`;
              if (existingChip) {
                if (existingChip.textContent !== chipText) existingChip.textContent = chipText;
              } else {
                const chip = doc.createElement("span");
                chip.className = "wbr-inline-muted-quote";
                chip.setAttribute("data-wbr-inline-muted", "1");
                chip.__wbrOwnerAnchor = a;
                chip.textContent = chipText;
                const ref = findAnchorFollowingInsertRef(a, false);
                ref.insertAdjacentElement("afterend", chip);
              }
            } else if (existingChip) {
              existingChip.remove();
            }
            ensureBadgesOnAnchor(a, u, { skipMuted: Boolean(muted) });
          } else {
            if (existingChip) existingChip.remove();
            if (muted || Engine.matchSelfFeature(u, state) || getCachedResult(u)) {
              ensureBadgesOnAnchor(a, u);
            } else {
              clearAnchorBadges(a);
            }
          }
        }
      }
    }

    function findFeedHeaderActionMount(card, authorAnchor) {
      const header = card.querySelector("header");
      if (header && header.children) {
        const nativeChildren = Array.from(header.children).filter(
          (ch) => !isWbrOwnedNode(ch)
        );
        if (nativeChildren.length >= 3) {
          const rightSlot = nativeChildren[nativeChildren.length - 1];
          if (rightSlot && rightSlot !== authorAnchor.parentElement && !rightSlot.contains(authorAnchor)) {
            return { host: rightSlot, mode: "prepend", extraClass: "wbr-actions-header-right" };
          }
        }
      }
      // Fallback: end of author's parent flex row (after VIP badges, pushed right)
      if (authorAnchor && authorAnchor.parentElement) {
        return { host: authorAnchor.parentElement, mode: "append", extraClass: "wbr-actions-row-end" };
      }
      return null;
    }

    function processFeedCards(collectedUids) {
      const cards = doc.querySelectorAll('article, [class*="Feed_wrap"]');
      for (const card of cards) {
        if (isInsideWeiboChromeUi(card)) continue;
        const headerScope = card.querySelector('header, [class*="head_"]') || card;
        const authorAnchor = findBestAuthorAnchor(headerScope);
        if (authorAnchor) {
          const user = extractUserFromContainer(card, authorAnchor);
          registerUserToPage(user, authorAnchor, card, collectedUids);
          const muted = Engine.findMutedMatch(user, state);
          applyCollapseOrExpand(card, user, muted, "已收起");
          ensureBadgesOnAnchor(authorAnchor, user);
        }

        // Prefer outer .retweet wrapper so collapsing hides media/retweetBar too
        const reBox =
          card.querySelector('.retweet, [class*="_retweet_"], [class*="Feed_retweet"]') ||
          card.querySelector('[class*="wbpro-feed-reText"]');
        if (reBox) {
          const reAnchor = findBestAuthorAnchor(reBox);
          if (reAnchor) {
            const reUser = extractUserFromContainer(reBox, reAnchor);
            registerUserToPage(reUser, reAnchor, reBox, collectedUids);
            const reMuted = Engine.findMutedMatch(reUser, state);
            applyCollapseOrExpand(reBox, reUser, reMuted, "已收起");
            ensureBadgesOnAnchor(reAnchor, reUser);
          }
        }

        processInlineRepostMentions(card, collectedUids);
      }
    }

    function findCommentActionMount(conEl, anchorEl) {
      if (conEl) {
        const infoEl = conEl.querySelector(":scope > .info");
        if (infoEl) {
          const optEl = infoEl.querySelector(":scope > .opt");
          if (optEl) {
            return { host: infoEl, mode: "before", beforeEl: optEl, extraClass: "wbr-actions-in-info" };
          }
          return { host: infoEl, mode: "append", extraClass: "wbr-actions-in-info" };
        }
      }
      if (anchorEl && anchorEl.parentElement) {
        return { host: anchorEl.parentElement, mode: "afterAnchor" };
      }
      return null;
    }

    function processCommentRows(collectedUids) {
      const rows = doc.querySelectorAll(".wbpro-list, [data-wbr-comment-row]");
      for (const row of rows) {
        if (isInsideWeiboChromeUi(row)) continue;
        const item1 = row.querySelector(":scope > .item1");
        if (item1) {
          const mainCon = item1.querySelector(".con1");
          const mainTextScope = (mainCon && mainCon.querySelector(":scope > .text")) || item1;
          const mainAnchor = findBestAuthorAnchor(mainTextScope) || findBestAuthorAnchor(item1);
          if (mainAnchor) {
            const user = extractUserFromContainer(row, mainAnchor);
            registerUserToPage(user, mainAnchor, row, collectedUids);
            const muted = Engine.findMutedMatch(user, state);
            applyCollapseOrExpand(row, user, muted, "已收起");
            ensureBadgesOnAnchor(mainAnchor, user);
          }

          const subItems = row.querySelectorAll(".list2 > .item2");
          for (const sub of subItems) {
            const subCon = sub.querySelector(".con2");
            const subTextScope = (subCon && subCon.querySelector(":scope > .text")) || sub;
            const subAnchor = findBestAuthorAnchor(subTextScope) || findBestAuthorAnchor(sub);
            if (!subAnchor) continue;
            const subUser = extractUserFromContainer(sub, subAnchor);
            registerUserToPage(subUser, subAnchor, sub, collectedUids);
            const subMuted = Engine.findMutedMatch(subUser, state);
            applyCollapseOrExpand(sub, subUser, subMuted, "已收起");
            ensureBadgesOnAnchor(subAnchor, subUser);
          }
          processInlineRepostMentions(row, collectedUids);
          continue;
        }

        const anchor = findBestAuthorAnchor(row);
        if (!anchor) continue;
        const user = extractUserFromContainer(row, anchor);
        registerUserToPage(user, anchor, row, collectedUids);
        const muted = Engine.findMutedMatch(user, state);
        applyCollapseOrExpand(row, user, muted, "已收起");
        ensureBadgesOnAnchor(anchor, user);
        processInlineRepostMentions(row, collectedUids);
      }
    }

    function processGenericUserRows(collectedUids) {
      const rows = doc.querySelectorAll(
        'main .vue-recycle-scroller__item-view, main .wbpro-scroller-item, main [class*="UserCard"], main [class*="Repost_"], main [class*="repostItem" i], .woo-modal-main .vue-recycle-scroller__item-view, [role="dialog"] .vue-recycle-scroller__item-view'
      );
      for (const row of rows) {
        if (isInsideWeiboChromeUi(row)) continue;
        if (row.closest && row.closest('.wbpro-list, [data-wbr-comment-row]')) {
          continue;
        }
        const insideArticle = row.closest ? row.closest('article, [class*="Feed_wrap"]') : null;
        if (insideArticle && !row.matches('[class*="Repost_"], [class*="repostItem" i]')) {
          continue;
        }
        if (row.querySelector('article, [class*="Feed_wrap"], .wbpro-list, [data-wbr-comment-row]')) {
          continue;
        }
        const anchor = findBestAuthorAnchor(row);
        if (!anchor) continue;
        const user = extractUserFromContainer(row, anchor);
        if (!user.uid && !user.screenName) continue;
        registerUserToPage(user, anchor, row, collectedUids);
        const muted = Engine.findMutedMatch(user, state);
        applyCollapseOrExpand(row, user, muted, "已收起");
        ensureBadgesOnAnchor(anchor, user);
        processInlineRepostMentions(row, collectedUids);
      }
    }

    function isHorizontalLayoutContainer(el) {
      if (!el || el === doc.body || el === doc.documentElement) return false;
      if (typeof win.getComputedStyle === "function") {
        try {
          const cs = win.getComputedStyle(el);
          if (cs) {
            const disp = cs.display || "";
            const dir = cs.flexDirection || "row";
            if ((disp === "flex" || disp === "inline-flex") && !dir.startsWith("column")) return true;
            if (disp === "grid" || disp === "inline-grid") return true;
          }
        } catch (_) {}
      }
      return Boolean(
        el.classList &&
          (el.classList.contains("wbpro-scroller-item") || el.classList.contains("woo-box-flex"))
      );
    }

    function isDetailPagePath() {
      const path = (win.location && win.location.pathname) || "";
      return /^\/detail\//.test(path) || /^\/\d{5,}\/[A-Za-z0-9]+/.test(path);
    }

    function findCommentToolbarMount(firstRow) {
      if (!firstRow) return null;
      const hostArticle = firstRow.closest ? firstRow.closest('article, [class*="Feed_wrap"]') : null;
      // v1.5.0: NEVER inject comment toolbar inside feed card inline comments!
      if (hostArticle) return null;

      // Dedicated detail page: step outside .vue-recycle-scroller / .wbpro-scroller
      const scroller = firstRow.closest
        ? firstRow.closest(".vue-recycle-scroller, .wbpro-scroller")
        : null;
      let anchorNode = scroller || firstRow;
      let parent = anchorNode.parentElement;
      while (parent && parent !== doc.body && isHorizontalLayoutContainer(parent)) {
        anchorNode = parent;
        parent = parent.parentElement;
      }
      if (!parent) return null;
      return { mountParent: parent, insertBeforeNode: anchorNode, scopeRoot: doc };
    }

    function isDetailRepostTabActive() {
      const tabs = doc.querySelectorAll('.woo-tab-item-active, [role="tab"][aria-selected="true"], [class*="tab"][class*="active"]');
      for (const tab of tabs) {
        const txt = Engine.normalizeText(tab.textContent || "");
        if (/^转发(?:\s|\d|$)/.test(txt) || (txt.includes("转发") && !txt.includes("评论") && txt.length <= 16)) {
          return true;
        }
      }
      return false;
    }

    function createToolbarForMount(mount) {
      const { mountParent, insertBeforeNode, scopeRoot } = mount;
      const existingBar = mountParent.querySelector(':scope > .wbr-comment-toolbar[data-wbr-toolbar="1"]');
      if (existingBar) {
        const existingScanBtn = existingBar.querySelector(".wbr-primary-btn");
        if (existingScanBtn && !batchScanning) {
          setBtnIconLabel(existingScanBtn, "search", isDetailRepostTabActive() ? "扫描可见转发" : "扫描可见评论", 12);
        }
        return;
      }

      const bar = doc.createElement("div");
      bar.className = "wbr-comment-toolbar is-minimal";
      bar.setAttribute("data-wbr-toolbar", "1");

      const left = doc.createElement("div");
      left.className = "wbr-toolbar-left";
      const scanBtn = doc.createElement("button");
      scanBtn.type = "button";
      scanBtn.className = "wbr-primary-btn";
      setBtnIconLabel(scanBtn, "search", isDetailRepostTabActive() ? "扫描可见转发" : "扫描可见评论", 12);

      const progressWrap = doc.createElement("div");
      progressWrap.className = "wbr-inline-progress";
      const progressFill = doc.createElement("div");
      progressFill.className = "wbr-inline-progress-fill";
      progressWrap.appendChild(progressFill);

      const statusSpan = doc.createElement("span");
      statusSpan.className = "wbr-toolbar-status";
      statusSpan.textContent = "";

      const stopBtn = doc.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "wbr-act-btn";
      stopBtn.textContent = "停止";
      stopBtn.style.display = "none";

      const reviewBtn = doc.createElement("button");
      reviewBtn.type = "button";
      reviewBtn.className = "wbr-act-btn";
      reviewBtn.textContent = "重点名单 (0)";
      reviewBtn.style.display = "none";

      left.append(scanBtn, progressWrap, statusSpan, stopBtn, reviewBtn);
      bar.appendChild(left);
      mountParent.insertBefore(bar, insertBeforeNode);

      stopBtn.addEventListener("click", async () => {
        await sendMessage({ type: "WBR_STOP_BATCH" });
        batchScanning = false;
        activeStatusEl = null;
        if (activeProgressWrap) activeProgressWrap.classList.remove("is-active");
        activeProgressWrap = null;
        activeProgressFill = null;
        stopBtn.style.display = "none";
        scanBtn.disabled = false;
        statusSpan.textContent = "已暂停查看";
      });

      reviewBtn.addEventListener("click", () => {
        toggleHighRiskDrawer(mountParent, bar, lastBatchResults);
      });

      scanBtn.addEventListener("click", async () => {
        if (batchScanning) return;
        if (callPageBridge) {
          try {
            await callPageBridge("WBR_PAGE_STAMP_VISIBLE", {}, 2000);
          } catch (_) {}
        }
        const MAX_COMMENT_BATCH = 80;
        const rows = (scopeRoot || doc).querySelectorAll(".wbpro-list, [data-wbr-comment-row]");
        const seen = new Set();
        const targets = [];
        const loginUid = getLoginUid();

        function pushTarget(uid, screenName, snippet, profileHint) {
          const cleanUid = Engine.normalizeUid(uid);
          const cleanName = Engine.normalizeText(screenName);
          const key = cleanUid || Engine.normalizeKey(cleanName);
          if (!key || seen.has(key)) return;
          if (loginUid && cleanUid === loginUid) return;
          if (Engine.findMutedMatch({ uid: cleanUid, screenName: cleanName }, state)) return;
          seen.add(key);
          targets.push({
            uid: cleanUid,
            screenName: cleanName,
            snippet: Engine.normalizeText(snippet).slice(0, 80),
            ...(profileHint ? { profileHint } : {})
          });
        }

        function pushDomTarget(containerEl, anchorEl, textNode) {
          if (!anchorEl) return;
          const u = extractUserFromContainer(containerEl, anchorEl);
          pushTarget(u.uid, u.screenName, textNode ? textNode.textContent : "", u.profileHint);
        }

        // Include main post author, retweeted author & inline //@ repost chain in scope
        const authorHost = scopeRoot && scopeRoot !== doc
          ? [scopeRoot]
          : Array.from(doc.querySelectorAll('article, [class*="Feed_wrap"]')).slice(0, 2);
        for (const card of authorHost) {
          const headerScope = card.querySelector('header, [class*="head_"]') || card;
          const mainPostAnchor = findBestAuthorAnchor(headerScope);
          if (mainPostAnchor) {
            pushDomTarget(card, mainPostAnchor, null);
          }
          const reBox = card.querySelector('.retweet, [class*="_retweet_"], [class*="Feed_retweet"]');
          if (reBox) {
            const reAnchor = findBestAuthorAnchor(reBox);
            if (reAnchor) pushDomTarget(reBox, reAnchor, null);
          }
          const textBlocks = card.querySelectorAll('[class*="wbpro-feed-ogText"], [class*="wbpro-feed-reText"], [class*="Feed_text"], [class*="detail_wbtext"], [class*="Detail_text"]');
          for (const tb of textBlocks) {
            for (const link of tb.querySelectorAll(USER_LINK_SELECTOR)) {
              if (targets.length >= MAX_COMMENT_BATCH) break;
              if (!isDecorativeUserLink(link) && isRepostChainMentionAnchor(link)) {
                pushDomTarget(null, link, tb);
              }
            }
          }
        }

        for (const row of rows) {
          const item1 = row.querySelector(":scope > .item1");
          if (item1) {
            const mainText = item1.querySelector(".con1 > .text") || item1;
            const mainAnchor = findBestAuthorAnchor(mainText) || findBestAuthorAnchor(item1);
            pushDomTarget(row, mainAnchor, mainText);
            if (targets.length >= MAX_COMMENT_BATCH) break;

            for (const sub of row.querySelectorAll(".list2 > .item2")) {
              const subText = sub.querySelector(".con2 > .text") || sub;
              const subAnchor = findBestAuthorAnchor(subText) || findBestAuthorAnchor(sub);
              pushDomTarget(sub, subAnchor, subText);
              if (targets.length >= MAX_COMMENT_BATCH) break;
            }
          } else {
            const anchor = findBestAuthorAnchor(row);
            const textNode = row.querySelector('[class*="text"], .con1');
            pushDomTarget(row, anchor, textNode);
          }
          for (const link of row.querySelectorAll(USER_LINK_SELECTOR)) {
            if (targets.length >= MAX_COMMENT_BATCH) break;
            if (!isDecorativeUserLink(link) && isRepostChainMentionAnchor(link)) {
              pushDomTarget(null, link, row);
            }
          }
          if (targets.length >= MAX_COMMENT_BATCH) break;
        }

        // Repost list rows outside .wbpro-list
        if (targets.length < MAX_COMMENT_BATCH) {
          const genericRows = (scopeRoot || doc).querySelectorAll(
            'main .vue-recycle-scroller__item-view, main .wbpro-scroller-item, main [class*="Repost_"], main [class*="repostItem" i]'
          );
          for (const grow of genericRows) {
            if (targets.length >= MAX_COMMENT_BATCH) break;
            if (isInsideWeiboChromeUi(grow)) continue;
            if (grow.closest && grow.closest('article, [class*="Feed_wrap"], .wbpro-list, [data-wbr-comment-row]')) continue;
            if (grow.querySelector('article, [class*="Feed_wrap"], .wbpro-list, [data-wbr-comment-row]')) continue;
            const anchor = findBestAuthorAnchor(grow);
            const textNode = grow.querySelector('[class*="text"], [class*="Text"]');
            pushDomTarget(grow, anchor, textNode);
            for (const link of grow.querySelectorAll(USER_LINK_SELECTOR)) {
              if (targets.length >= MAX_COMMENT_BATCH) break;
              if (!isDecorativeUserLink(link) && isRepostChainMentionAnchor(link)) {
                pushDomTarget(null, link, grow);
              }
            }
          }
        }

        // Detail page virtual-scroller supplement: pull passively captured buildComments / repostTimeline users up to 80
        if (scopeRoot === doc && targets.length < MAX_COMMENT_BATCH && callPageBridge) {
          try {
            const cap = await callPageBridge("WBR_PAGE_GET_CAPTURED_COMMENTS", {}, 1500);
            if (cap && cap.ok && Array.isArray(cap.comments)) {
              for (const c of cap.comments) {
                if (targets.length >= MAX_COMMENT_BATCH) break;
                pushTarget(c.uid, c.screenName, c.snippet || "", c.profileHint);
              }
            }
          } catch (_) {}
        }

        if (targets.length === 0) {
          statusSpan.textContent = "暂无需要查看的新评论用户";
          return;
        }

        batchScanning = true;
        activeStatusEl = statusSpan;
        activeProgressWrap = progressWrap;
        activeProgressFill = progressFill;
        activeBatchHighCount = 0;
        progressFill.style.width = "0%";
        progressWrap.classList.add("is-active");
        scanBtn.disabled = true;
        stopBtn.style.display = "inline-flex";
        statusSpan.textContent = `正在查看 0/${targets.length}`;

        const resp = await sendMessage({
          type: "WBR_RUN_BATCH_SCAN",
          users: targets,
          delayMs: 350
        });

        batchScanning = false;
        activeStatusEl = null;
        progressWrap.classList.remove("is-active");
        activeProgressWrap = null;
        activeProgressFill = null;
        scanBtn.disabled = false;
        stopBtn.style.display = "none";

        if (resp && Array.isArray(resp.results) && resp.results.length > 0) {
          lastBatchResults = resp.results;
          for (const r of lastBatchResults) {
            storeCachedResult(r);
          }
          const flaggedCount = lastBatchResults.filter((r) => r.level === "warn" || r.level === "high").length;
          reviewBtn.textContent = flaggedCount > 0
            ? `查看本帖重点名单 (${flaggedCount})`
            : `查看本帖排查结果 (${lastBatchResults.length})`;
          reviewBtn.style.display = "inline-flex";
          applyAll();
        }

        if (!resp || !resp.ok || resp.breakerTripped) {
          const errText = (resp && (resp.breakerError || resp.error)) || "已暂停查看";
          statusSpan.textContent = errText;
          if (resp && (resp.breakerTripped || resp.isCircuitBreaker)) {
            showToast(errText, 4500);
          }
          return;
        }
        const flaggedCount = lastBatchResults.filter((r) => r.level === "warn" || r.level === "high").length;
        statusSpan.textContent = flaggedCount > 0
          ? `已查看 ${lastBatchResults.length} 人 · 发现 ${flaggedCount} 位达到预警倾向`
          : `已查看 ${lastBatchResults.length} 人 · 未发现明显定律倾向`;
      });
    }

    function ensureCommentToolbar() {
      // Clean up any legacy toolbar inside feed cards or non-detail pages
      const onDetailPage = isDetailPagePath();
      for (const stray of doc.querySelectorAll('.wbr-comment-toolbar[data-wbr-toolbar="1"]')) {
        if (!onDetailPage || (stray.closest && stray.closest('article, [class*="Feed_wrap"], .wbpro-scroller-item'))) {
          stray.remove();
        }
      }
      if (!onDetailPage) return;

      const allRows = Array.from(
        doc.querySelectorAll('.wbpro-list, [data-wbr-comment-row], main .vue-recycle-scroller__item-view, main .wbpro-scroller-item, main [class*="Repost_"], main [class*="repostItem" i]')
      );
      if (allRows.length === 0) return;

      for (const row of allRows) {
        if (isInsideWeiboChromeUi(row)) continue;
        const art = row.closest ? row.closest('article, [class*="Feed_wrap"]') : null;
        if (art) continue;
        if (row.querySelector('article, [class*="Feed_wrap"]')) continue;
        if (!row.matches('.wbpro-list, [data-wbr-comment-row]') && !findBestAuthorAnchor(row)) continue;
        const mount = findCommentToolbarMount(row);
        if (mount && mount.mountParent) {
          createToolbarForMount(mount);
          break;
        }
      }
    }

    function formatDrawerBenignLine(r) {
      const prefix = `@${r.screenName || r.uid}`;
      if (r.exemptReason === "self") return `${prefix} · 本人账号免标警`;
      if (r.exemptReason === "following") return `${prefix} · 已关注免标警`;
      if (r.exemptReason === "org_verified") return `${prefix} · 官方蓝V机构号免标警`;
      if (r.hiddenFollowing) return `${prefix} · 对方隐藏了关注列表`;
      if (r.hitCount > 0) return `${prefix} · 未达预警（重合 ${r.hitCount} 位泛圈层号）`;
      return `${prefix} · 未发现明显倾向`;
    }

    function toggleHighRiskDrawer(listHost, toolbar, results) {
      const drawerHost = (toolbar && toolbar.parentElement) || listHost;
      if (!drawerHost) return;
      const old = drawerHost.querySelector(':scope > .wbr-drawer[data-wbr-drawer="1"]');
      if (old) {
        old.remove();
        return;
      }
      const drawer = doc.createElement("div");
      drawer.className = "wbr-drawer";
      drawer.setAttribute("data-wbr-drawer", "1");

      const flagged = results.filter((r) => r.level === "warn" || r.level === "high");
      const benign = results.filter((r) => r.level !== "warn" && r.level !== "high");

      const head = doc.createElement("div");
      head.style.display = "flex";
      head.style.justifyContent = "space-between";
      head.style.alignItems = "center";
      const headTitle = doc.createElement("strong");
      headTitle.textContent = `本帖重点关注倾向名单（重点 ${flagged.length} 人 / 共查 ${results.length} 人）`;
      const closeBtn = doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "wbr-act-btn";
      closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", () => drawer.remove());
      head.append(headTitle, closeBtn);
      drawer.appendChild(head);

      const listEl = doc.createElement("div");
      listEl.className = "wbr-drawer-list";
      const checkboxes = [];

      if (flagged.length === 0) {
        const emptyTip = doc.createElement("div");
        emptyTip.className = "wbr-drawer-empty";
        emptyTip.textContent = `本帖已排查 ${results.length} 人，均未达到定律预警线（0 人异常）`;
        listEl.appendChild(emptyTip);
      } else {
        for (const r of flagged) {
          const row = doc.createElement("label");
          row.className = "wbr-drawer-row";
          const cb = doc.createElement("input");
          cb.type = "checkbox";
          cb.checked = false;
          checkboxes.push({ cb, r });

          const info = doc.createElement("span");
          info.style.flex = "1";
          const hitPreview = (r.hitItems || []).slice(0, 4).map((x) => x.name).join("、");
          const levelTag = r.level === "high" ? "定律" : "倾向";
          info.textContent = `@${r.screenName || r.uid} · ${levelTag} ${r.probability || 0}% / 命中 ${r.hitCount} 位${hitPreview ? ` (${hitPreview})` : ""}`;

          row.append(cb, info);
          listEl.appendChild(row);
        }
      }
      drawer.appendChild(listEl);

      if (benign.length > 0) {
        const details = doc.createElement("details");
        details.className = "wbr-drawer-benign";
        const sum = doc.createElement("summary");
        sum.textContent = `查看其余未达标/已豁免用户 (${benign.length} 人)`;
        details.appendChild(sum);
        const benignList = doc.createElement("div");
        benignList.className = "wbr-drawer-benign-list";
        for (const r of benign) {
          const row = doc.createElement("div");
          row.className = "wbr-drawer-row wbr-drawer-row-benign";
          row.textContent = formatDrawerBenignLine(r);
          benignList.appendChild(row);
        }
        details.appendChild(benignList);
        drawer.appendChild(details);
      }

      if (flagged.length > 0) {
        const foot = doc.createElement("div");
        foot.style.display = "flex";
        foot.style.gap = "8px";
        foot.style.flexWrap = "wrap";
        const selHighBtn = doc.createElement("button");
        selHighBtn.type = "button";
        selHighBtn.className = "wbr-act-btn";
        selHighBtn.textContent = "一键勾选高倾向";
        selHighBtn.addEventListener("click", () => {
          for (const item of checkboxes) {
            item.cb.checked = item.r.level === "high";
          }
        });

        const muteSelBtn = doc.createElement("button");
        muteSelBtn.type = "button";
        muteSelBtn.className = "wbr-act-btn";
        muteSelBtn.textContent = "屏蔽所选";
        muteSelBtn.addEventListener("click", async () => {
          const picked = checkboxes.filter((x) => x.cb.checked).map((x) => ({
            uid: x.r.uid,
            screenName: x.r.screenName,
            action: "mute"
          }));
          if (picked.length === 0) return;
          const resp = await sendMessage({ type: "WBR_RUN_CLEANUP_QUEUE", items: picked });
          if (resp && resp.ok) {
            const stResp = await sendMessage({ type: "WBR_GET_STATE" });
            if (stResp && stResp.ok && stResp.state) {
              state = Engine.normalizeState(stResp.state);
              applyAll(false);
            }
          }
          showToast(`已屏蔽 ${picked.length} 人`);
          drawer.remove();
        });

        const blockSelBtn = doc.createElement("button");
        blockSelBtn.type = "button";
        blockSelBtn.className = "wbr-act-btn wbr-act-btn-danger";
        blockSelBtn.textContent = "官方拉黑所选";
        blockSelBtn.addEventListener("click", async () => {
          const picked = checkboxes.filter((x) => x.cb.checked).map((x) => ({
            uid: x.r.uid,
            screenName: x.r.screenName,
            action: "block"
          }));
          if (picked.length === 0) return;
          blockSelBtn.disabled = true;
          const resp = await sendMessage({ type: "WBR_RUN_CLEANUP_QUEUE", items: picked });
          blockSelBtn.disabled = false;
          const stResp = await sendMessage({ type: "WBR_GET_STATE" });
          if (stResp && stResp.ok && stResp.state) {
            state = Engine.normalizeState(stResp.state);
            applyAll(false);
          }
          showToast(resp && resp.ok ? `已处理 ${resp.executed} 人` : (resp && resp.error) || "已暂停处理");
          drawer.remove();
        });

        foot.append(selHighBtn, muteSelBtn, blockSelBtn);
        drawer.appendChild(foot);
      }
      toolbar.insertAdjacentElement("afterend", drawer);
    }

    function isNonProfileRoutePath(path) {
      const p = String(path || "").trim();
      if (!p || p === "/") return true;
      return /^\/(?:home|mygroups|fav|detail|set|search|hot|tv|a|login|signup|newlogin|ttarticle|ajax)(?:[/?#]|$)/i.test(p);
    }

    function findProfileHeaderElement() {
      const legacy = doc.querySelector('[class*="ProfileHeader"], [data-wbr-profile-header]');
      if (legacy) return legacy;

      // Weibo Pro Next profile header card: woo-panel-main containing _box1_ and _name_
      const nameEl = doc.querySelector('main [class*="_box1_"] [class*="_name_"], main [class*="_name_"][class*="_1yc79"], main [class*="_h3_"] [class*="_name_"]');
      if (nameEl) {
        const panel = nameEl.closest(".woo-panel-main");
        if (panel) return panel;
        return nameEl.closest('[class*="_box1_"]') || nameEl;
      }
      return null;
    }

    function syncProfileInlineBtnUi(btn, nameAnchor, user, cached) {
      if (nameAnchor) {
        ensureBadgesOnAnchor(nameAnchor, user);
      }
      if (!btn) return;
      btn.__wbrUser = user;
      const loginUid = getLoginUid();
      const isSelfProfile = Boolean(
        (loginUid && user.uid && user.uid === loginUid) ||
          (cached && cached.exemptReason === "self") ||
          (state.account && state.account.screenName && user.screenName && namesMatchInsensitive(user.screenName, state.account.screenName))
      );
      if (isSelfProfile) {
        setBtnIconLabel(btn, "eye", "本人免预警 · 访客自测", 12);
        btn.className = "wbr-profile-inline-btn is-checked";
        btn.title = "您本人的主页默认免除预警，点击可查看说明或模拟访客视角自测真实得分";
      } else if (cached) {
        const isFlagged = Boolean(
          (cached.level === "warn" || cached.level === "high") &&
            !cached.hiddenFollowing &&
            !cached.exemptReason &&
            cached.hitCount > 0
        );
        if (isFlagged) {
          setBtnIconLabel(btn, "alert", "详情", 12);
        } else {
          setBtnIconLabel(btn, "check", "已查关注定律", 12);
        }
        btn.className = "wbr-profile-inline-btn is-checked";
        btn.title = "点击查看关注列表定律详情、重查或屏蔽拉黑";
      } else {
        setBtnIconLabel(btn, "search", "查关注定律", 12);
        btn.className = "wbr-profile-inline-btn";
        btn.title = "查看该博主近期关注圈层分布";
      }
    }

    function resolveSafeHeaderLinkUid(header, nameAnchor, expectedName) {
      if (!header || typeof header.querySelectorAll !== "function") return "";
      const links = header.querySelectorAll('a[href*="/u/"], [usercard]');
      for (const link of links) {
        if (isInsideWeiboChromeUi(link)) continue;
        const candUid =
          extractUidFromHref(link.getAttribute("href")) ||
          extractUidFromUsercard(link.getAttribute("usercard"));
        if (!candUid) continue;
        const inNameAnchor =
          nameAnchor &&
          nameAnchor !== header &&
          (link === nameAnchor ||
            (typeof nameAnchor.contains === "function" && nameAnchor.contains(link)) ||
            (typeof link.contains === "function" && link.contains(nameAnchor)));
        if (inNameAnchor) return candUid;
        const linkText = extractNameFromAnchor(link);
        if (linkText) {
          if (expectedName && namesMatchInsensitive(linkText, expectedName)) {
            return candUid;
          }
          // Ignore bio @mentions or other unrelated user links inside profile header
          continue;
        }
        // Avatar link with empty text inside header box (exclude links inside bio/intro/desc)
        if (!link.closest('[class*="_intro_"], [class*="_desc_"], [class*="bio" i]')) {
          return candUid;
        }
      }
      return "";
    }

    function ensureProfileBanner(collectedUids) {
      // Remove any legacy v1.4 full-width profile banner
      for (const oldBanner of doc.querySelectorAll('.wbr-profile-banner[data-wbr-profile="1"]')) {
        oldBanner.remove();
      }

      syncDocProfileRouteAttrs();
      const path = (win.location && win.location.pathname) || "";
      const m = path.match(/^\/(?:u\/(\d{5,})|n\/([^/?#]+))/);
      if (!m && isNonProfileRoutePath(path)) return;

      const header = findProfileHeaderElement();
      if (!header) return;
      const hasExplicitProfileCard = Boolean(
        header.matches('[class*="ProfileHeader"], [data-wbr-profile-header]') ||
          (header.querySelector('[class*="_box1_"]') && header.querySelector('[class*="_name_"]'))
      );
      if (!m && !hasExplicitProfileCard) return;

      const nameAnchor =
        header.querySelector('[class*="ProfileHeader_name"], [class*="_name_"], h1') || header;
      let domName = nameAnchor !== header ? extractCleanProfileName(nameAnchor) : "";
      if (!domName && nameAnchor === header) {
        const subNameEl = header.querySelector('a[href^="/n/"], a[href*="/u/"]');
        if (subNameEl) domName = extractNameFromAnchor(subNameEl);
      }

      const headerUid = Engine.normalizeUid(header.getAttribute("data-wbr-uid"));
      const headerUname = Engine.normalizeText(header.getAttribute("data-wbr-uname"));
      const rootEl = doc.documentElement;
      const docProfileRoute = rootEl ? (rootEl.getAttribute("data-wbr-profile-route") || "") : "";
      const docProfileUid =
        rootEl && docProfileRoute === path ? Engine.normalizeUid(rootEl.getAttribute("data-wbr-profile-uid")) : "";
      const docProfileUname =
        rootEl && docProfileRoute === path ? Engine.normalizeText(rootEl.getAttribute("data-wbr-profile-uname")) : "";

      let uid = "";
      let screenName = "";

      if (m && m[1]) {
        // Case A: /u/<uid> route - route UID is authoritative
        uid = Engine.normalizeUid(m[1]);
        if (headerUid && headerUid !== uid) {
          clearElementWbrAttrs(header);
          clearAnchorBadges(nameAnchor);
        }
        const trustedHeaderName = headerUid === uid ? headerUname : "";
        const trustedDocName = docProfileUid === uid ? docProfileUname : "";
        if (domName) {
          screenName = domName;
        } else {
          screenName = trustedHeaderName || trustedDocName || "";
        }
      } else if (m && m[2]) {
        // Case B: /n/<nickname> route - must verify nickname consistency before accepting any UID
        let urlNick = "";
        try {
          urlNick = Engine.normalizeText(decodeURIComponent(m[2])).replace(/^@/, "");
        } catch (_) {
          urlNick = Engine.normalizeText(m[2]).replace(/^@/, "");
        }
        const expectedName = domName || urlNick;
        screenName = expectedName;

        const matchesNick = (candidateName) =>
          Boolean(
            candidateName &&
              ((urlNick && namesMatchInsensitive(candidateName, urlNick)) ||
                (domName && namesMatchInsensitive(candidateName, domName)))
          );

        if (headerUid) {
          if (matchesNick(headerUname)) {
            uid = headerUid;
          } else {
            clearElementWbrAttrs(header);
            clearAnchorBadges(nameAnchor);
          }
        }
        if (!uid && docProfileUid && matchesNick(docProfileUname)) {
          uid = docProfileUid;
        }
        if (!uid) {
          uid = resolveSafeHeaderLinkUid(header, nameAnchor, expectedName);
        }
      } else {
        // Case C: Custom domain profile route (e.g. /tombkeeper)
        const matchesDomIfPresent = (candidateName) =>
          !domName || !candidateName || namesMatchInsensitive(candidateName, domName);
        if (headerUid) {
          if (matchesDomIfPresent(headerUname)) {
            uid = headerUid;
          } else {
            clearElementWbrAttrs(header);
            clearAnchorBadges(nameAnchor);
          }
        }
        if (!uid && docProfileUid && matchesDomIfPresent(docProfileUname)) {
          uid = docProfileUid;
        }
        if (!uid) {
          uid = resolveSafeHeaderLinkUid(header, nameAnchor, domName);
        }
        screenName =
          domName ||
          (docProfileUid && docProfileUid === uid ? docProfileUname : "") ||
          (headerUid && headerUid === uid ? headerUname : "");
      }

      const user = { uid: Engine.normalizeUid(uid), screenName };
      if (!user.uid && !user.screenName) return;
      registerUserToPage(user, nameAnchor, header, collectedUids);

      const cached = getCachedResult(user);
      const existingBtn = header.querySelector('.wbr-profile-inline-btn[data-wbr-profile-btn="1"]');
      if (existingBtn) {
        if (!isSameUserIdentity(existingBtn.__wbrUser, user)) {
          clearAnchorBadges(nameAnchor);
          existingBtn.disabled = false;
        }
        syncProfileInlineBtnUi(existingBtn, nameAnchor, user, cached);
        return;
      }

      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "wbr-profile-inline-btn";
      btn.setAttribute("data-wbr-profile-btn", "1");
      bindStopPropagation(btn);
      syncProfileInlineBtnUi(btn, nameAnchor, user, cached);

      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const target = btn.__wbrUser || user;
        btn.disabled = true;
        try {
          const res = await triggerUserCheck(target, btn, false);
          if (res) {
            if (res.uid && !target.uid) target.uid = Engine.normalizeUid(res.uid);
            syncProfileInlineBtnUi(btn, nameAnchor, target, res);
          }
        } finally {
          btn.disabled = false;
        }
      });

      if (nameAnchor && nameAnchor !== header && nameAnchor.parentNode) {
        let insertRef = nameAnchor;
        while (
          insertRef.nextElementSibling &&
          insertRef.nextElementSibling.getAttribute &&
          (insertRef.nextElementSibling.getAttribute("data-wbr-badge") === "1" ||
            insertRef.nextElementSibling.getAttribute("data-wbr-self-badge") === "1" ||
            insertRef.nextElementSibling.getAttribute("data-wbr-muted-badge") === "1")
        ) {
          insertRef = insertRef.nextElementSibling;
        }
        insertRef.insertAdjacentElement("afterend", btn);
      } else {
        header.appendChild(btn);
      }
    }

    function ensureShieldPageSyncBar() {
      const path = (win.location && win.location.pathname) || "";
      if (!path.startsWith("/set/shield")) return;
      if (doc.querySelector('.wbr-shield-banner[data-wbr-shield="1"]')) return;
      // Mount inside the 642px center column below the fixed top navbar (never directly on <main>)
      const tabPanel = doc.querySelector(".wbpro-tab2") && doc.querySelector(".wbpro-tab2").closest(".woo-panel-main");
      const host =
        (tabPanel && tabPanel.parentElement) ||
        doc.querySelector('main [class*="_full_"]') ||
        doc.querySelector(".wbpro-setup__box") ||
        doc.querySelector("main") ||
        doc.body;
      if (!host) return;

      const bar = doc.createElement("div");
      bar.className = "wbr-shield-banner";
      bar.setAttribute("data-wbr-shield", "1");
      const txt = doc.createElement("span");
      txt.textContent = "可以将本页黑名单一键同步到「微博关注列表定律」的屏蔽名单";
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "wbr-primary-btn";
      setBtnIconLabel(btn, "refresh", "同步到屏蔽名单", 12);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const resp = await sendMessage({ type: "WBR_SYNC_BLOCKLIST" });
        if (resp && resp.ok) {
          showToast(`已从微博黑名单同步 ${resp.importedCount || 0} 人`);
        } else {
          const items = [];
          const links = doc.querySelectorAll('a[href*="/n/"], a[href*="/u/"]');
          for (const a of links) {
            if (isDecorativeUserLink(a)) continue;
            const name = extractNameFromAnchor(a);
            const uid = extractUidFromHref(a.getAttribute("href"));
            if (name || uid) items.push({ uid, screenName: name });
          }
          if (items.length > 0) {
            const imp = await sendMessage({ type: "WBR_IMPORT_BLOCKLIST_ITEMS", items });
            showToast(`已从页面导入 ${(imp && imp.importedCount) || items.length} 人到屏蔽名单`);
          } else {
            showToast((resp && resp.error) || "同步失败，请确认已登录微博");
          }
        }
        btn.disabled = false;
      });
      bar.append(txt, btn);
      if (tabPanel && tabPanel.parentElement === host) {
        host.insertBefore(bar, tabPanel);
      } else {
        host.prepend(bar);
      }
    }

    function isOfficialUserCardPopover(cardEl) {
      if (!cardEl || cardEl.nodeType !== 1) return false;
      if (isInsideWeiboChromeUi(cardEl)) return false;
      if (cardEl.closest && cardEl.closest('.wbr-popover, .wbr-drawer, .wbr-live-widget, .wbr-toast, .wbr-comment-toolbar, .wbr-shield-banner')) {
        return false;
      }
      if (cardEl.closest && cardEl.closest('article, [class*="Feed_wrap"], .wbpro-list, [data-wbr-comment-row], [class*="ProfileHeader"], [data-wbr-profile-header]')) {
        return false;
      }
      const inMain = Boolean(cardEl.closest && cardEl.closest("main"));
      const inPopLayer = Boolean(cardEl.closest && cardEl.closest('.woo-pop-main, .woo-pop-wrap-main, [role="tooltip"]'));
      if (inMain && !inPopLayer) return false;

      const parentCard = cardEl.parentElement
        ? cardEl.parentElement.closest('.woo-pop-main, [class*="UserCard"], [class*="userCard" i], [class*="PopCard" i], [class*="user_card" i]')
        : null;
      if (parentCard && !cardEl.matches('.woo-pop-main')) return false;

      if (cardEl.hidden || (cardEl.style && cardEl.style.display === "none")) return false;
      if (typeof win.getComputedStyle === "function") {
        try {
          const cs = win.getComputedStyle(cardEl);
          if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
        } catch (_) {}
      }

      const txt = Engine.normalizeText(cardEl.textContent || "");
      const hasFollowStats = /关注\s*[\d万.+]+/.test(txt) && /粉丝\s*[\d万.+]+/.test(txt);
      const hasActionBtn = Array.from(cardEl.querySelectorAll('button, [role="button"], .woo-button-main, a')).some((el) => {
        if (isWbrOwnedNode(el)) return false;
        const bt = Engine.normalizeText(el.textContent || "");
        return /^(?:\+?\s*关注|已关注|互相关注|悄悄关注|回粉|留言|私信|编辑资料)$/.test(bt);
      });

      if (cardEl.querySelector('.woo-pop-item-main') && !hasFollowStats && !hasActionBtn) {
        return false;
      }
      return hasFollowStats || hasActionBtn;
    }

    function extractUserFromOfficialCard(cardEl) {
      if (!cardEl) return null;
      const stampedName = Engine.normalizeText(cardEl.getAttribute("data-wbr-uname"));
      const stampedUid = Engine.normalizeUid(cardEl.getAttribute("data-wbr-uid"));

      let bestAnchor = null;
      for (const a of cardEl.querySelectorAll(USER_LINK_SELECTOR)) {
        if (isDecorativeUserLink(a) || isWbrOwnedNode(a)) continue;
        const linkText = extractNameFromAnchor(a);
        if (linkText && /^(?:关注|粉丝|微博|全部|更多)\s*[\d万.+]*$/.test(linkText)) continue;
        if (linkText && /^(?:\+?\s*关注|已关注|互相关注|悄悄关注|回粉|留言|私信|编辑资料)$/.test(linkText)) continue;
        const linkUid = extractUidFromHref(a.getAttribute("href")) || extractUidFromUsercard(a.getAttribute("usercard"));
        if (linkText || linkUid) {
          bestAnchor = a;
          break;
        }
      }

      let domName = bestAnchor ? extractNameFromAnchor(bestAnchor) : "";
      if (!domName) {
        const nameCandidates = cardEl.querySelectorAll('[class*="name" i], [class*="nick" i], [class*="title" i], strong, h3, h4');
        for (const el of nameCandidates) {
          if (isWbrOwnedNode(el) || el.closest('button, [role="button"], .woo-button-main')) continue;
          const cand = extractCleanProfileName(el);
          if (!cand || cand.length > 40) continue;
          if (/^(?:关注|粉丝|微博|全部|更多)\s*[\d万.+]*$/.test(cand)) continue;
          if (/^(?:\+?\s*关注|已关注|互相关注|悄悄关注|回粉|留言|私信|编辑资料)$/.test(cand)) continue;
          domName = cand;
          break;
        }
      }

      if (bestAnchor) {
        const user = extractUserFromContainer(cardEl, bestAnchor);
        if (!user.screenName && domName) user.screenName = domName;
        if (user.uid || user.screenName) return { user, anchorEl: bestAnchor };
      }

      const staleCard = Boolean(domName && stampedName && !namesMatchInsensitive(domName, stampedName));
      const uid = !staleCard ? stampedUid : "";
      const screenName = domName || stampedName;
      if (!uid && !screenName) return null;

      const profileHint = {};
      if (!staleCard) {
        const rawFollowing = cardEl.getAttribute("data-wbr-ufollowing");
        if (rawFollowing === "1" || rawFollowing === "0") profileHint.viewerFollowing = rawFollowing === "1";
        const rawVType = cardEl.getAttribute("data-wbr-uvtype");
        if (rawVType !== null && /^-?\d+$/.test(rawVType)) profileHint.verifiedType = Number(rawVType);
        const rawFriends = cardEl.getAttribute("data-wbr-ufriends");
        if (rawFriends !== null && /^\d+$/.test(rawFriends)) profileHint.friendsCount = Number(rawFriends);
        const rawFollowers = cardEl.getAttribute("data-wbr-ufollowers");
        if (rawFollowers !== null && /^\d+$/.test(rawFollowers)) profileHint.followersCount = Number(rawFollowers);
      }

      return {
        user: Object.keys(profileHint).length > 0 ? { uid, screenName, profileHint } : { uid, screenName },
        anchorEl: bestAnchor || null
      };
    }

    function findUserCardMountTarget(cardEl) {
      if (!cardEl) return null;
      const actionEls = Array.from(cardEl.querySelectorAll('button, [role="button"], .woo-button-main, a')).filter((el) => {
        if (isWbrOwnedNode(el)) return false;
        const bt = Engine.normalizeText(el.textContent || "");
        return /^(?:\+?\s*关注|已关注|互相关注|悄悄关注|回粉|留言|私信|编辑资料)$/.test(bt);
      });
      if (actionEls.length > 0) {
        let row = actionEls[0].parentElement;
        while (row && row !== cardEl && row.parentElement && row.parentElement !== cardEl) {
          const allContained = actionEls.every((a) => row.contains(a));
          if (allContained) break;
          row = row.parentElement;
        }
        if (row && row !== cardEl && row.parentNode) {
          return { mode: "after", refEl: row };
        }
      }
      const statCandidates = Array.from(cardEl.querySelectorAll("div, p")).filter((el) => {
        if (el === cardEl || isWbrOwnedNode(el)) return false;
        const t = Engine.normalizeText(el.textContent || "");
        return /关注\s*[\d万.+]+/.test(t) && /粉丝\s*[\d万.+]+/.test(t) && t.length < 40;
      });
      if (statCandidates.length > 0) {
        const lastStat = statCandidates[statCandidates.length - 1];
        if (lastStat && lastStat.parentNode) {
          return { mode: "after", refEl: lastStat };
        }
      }
      return { mode: "append", refEl: cardEl };
    }

    function syncUserCardBtnUi(btn, user, cached, mutedMatch) {
      if (!btn) return;
      btn.__wbrUser = {
        uid: (user && user.uid) || (cached && cached.uid) || "",
        screenName: (user && user.screenName) || (cached && cached.screenName) || "",
        profileHint: user && user.profileHint
      };
      const entry = getRegistryEntry(user);
      const isScanning = Boolean(entry && entry.status === "scanning");
      if (isScanning) {
        btn.className = "wbr-usercard-btn is-scanning";
        btn.textContent = "检测中…";
        btn.disabled = true;
        btn.title = "正在查看 TA 的近期关注列表…";
        return;
      }
      btn.disabled = false;
      if (mutedMatch) {
        btn.className = "wbr-usercard-btn is-muted";
        setBtnIconLabel(btn, "ban", mutedMatch.source === "weibo_block" ? "已在微博黑名单 · 查看" : "已本地屏蔽 · 查看", 12);
        btn.title = "点击查看屏蔽详情或取消屏蔽";
        return;
      }
      if (cached) {
        if (cached.exemptReason === "self") {
          btn.className = "wbr-usercard-btn is-checked";
          setBtnIconLabel(btn, "eye", "本人免预警 · 访客自测", 12);
          btn.title = "点击打开详情浮窗或进行访客视角自测";
          return;
        }
        if (cached.exemptReason === "following") {
          btn.className = "wbr-usercard-btn is-checked";
          setBtnIconLabel(btn, "check", "已关注 · 免预警", 12);
          btn.title = "点击查看关注列表详情";
          return;
        }
        if (cached.exemptReason === "org_verified") {
          btn.className = "wbr-usercard-btn is-checked";
          setBtnIconLabel(btn, "check", "机构蓝V · 免预警", 12);
          btn.title = "点击查看详情";
          return;
        }
        if ((cached.level === "high" || cached.level === "warn") && !cached.hiddenFollowing && cached.hitCount > 0) {
          const prob = cached.probability || Engine.computeProbabilityFromScore(cached.score ?? cached.hitCount, cached.hitCount);
          btn.className = cached.level === "high" ? "wbr-usercard-btn is-high" : "wbr-usercard-btn is-warn";
          setBtnIconLabel(
            btn,
            "alert",
            cached.level === "high"
              ? `显著倾向 ${prob}% · 命中 ${cached.hitCount} 位`
              : `倾向提示 ${prob}% · 命中 ${cached.hitCount} 位`,
            12
          );
          btn.title = "点击查看关注列表倾向参考明细";
          return;
        }
        if (cached.hiddenFollowing) {
          btn.className = "wbr-usercard-btn is-checked";
          btn.textContent = "已隐藏关注列表 · 详情";
          btn.title = "对方隐藏了关注列表，点击查看详情";
          return;
        }
        btn.className = "wbr-usercard-btn is-checked";
        setBtnIconLabel(btn, "check", "已查 · 未见明显倾向", 12);
        btn.title = "点击查看关注列表检测详情";
        return;
      }
      btn.className = "wbr-usercard-btn";
      setBtnIconLabel(btn, "search", "查成分", 12);
      btn.title = "查看近期关注倾向";
    }

    function processOfficialUserCards(collectedUids) {
      const rawCandidates = Array.from(
        doc.querySelectorAll('.woo-pop-main, .woo-pop-wrap-main, [class*="UserCard"], [class*="userCard" i], [class*="PopCard" i], [class*="user_card" i], [role="tooltip"]')
      ).filter(isOfficialUserCardPopover);

      if (rawCandidates.length === 0) return;

      // Keep outermost valid card containers so inner sub-rows (stats/actions) are not treated as separate cards
      const cards = rawCandidates.filter((c) => !rawCandidates.some((other) => other !== c && other.contains(c)));

      for (const cardEl of cards) {
        const extracted = extractUserFromOfficialCard(cardEl);
        if (!extracted || !extracted.user) continue;
        const { user, anchorEl } = extracted;
        cardEl.setAttribute("data-wbr-usercard-pop", "1");

        const mutedMatch = Engine.findMutedMatch(user, state);
        const cached = getCachedResult(user);
        registerUserToPage(user, anchorEl || null, null, collectedUids);

        let bar = cardEl.querySelector('.wbr-usercard-bar[data-wbr-usercard-bar="1"]');
        let btn = bar ? bar.querySelector('.wbr-usercard-btn[data-wbr-usercard-btn="1"]') : null;

        if (!bar || !btn) {
          bar = doc.createElement("div");
          bar.className = "wbr-usercard-bar";
          bar.setAttribute("data-wbr-usercard-bar", "1");

          btn = doc.createElement("button");
          btn.type = "button";
          btn.className = "wbr-usercard-btn";
          btn.setAttribute("data-wbr-usercard-btn", "1");
          bindStopPropagation(btn);
          btn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const target = btn.__wbrUser || user;
            if (!target || (!target.uid && !target.screenName)) return;
            const latestMuted = Engine.findMutedMatch(target, state);
            const latestCached = getCachedResult(target);
            if (latestMuted && !latestCached) {
              openDetailPopover(btn, {
                uid: target.uid,
                screenName: target.screenName,
                _isMutedPlaceholder: true,
                mutedReason: latestMuted.reason || (latestMuted.source === "weibo_block" ? "微博黑名单" : "手动屏蔽"),
                hitItems: [],
                categoryCounts: {}
              }, target);
              return;
            }
            btn.disabled = true;
            try {
              const res = await triggerUserCheck(target, btn, false);
              if (res && btn.isConnected) {
                if (res.uid && !target.uid) target.uid = Engine.normalizeUid(res.uid);
                syncUserCardBtnUi(btn, target, res, Engine.findMutedMatch(target, state));
              }
            } finally {
              if (btn.isConnected) {
                syncUserCardBtnUi(btn, target, getCachedResult(target), Engine.findMutedMatch(target, state));
              }
            }
          });

          bar.appendChild(btn);
          const mount = findUserCardMountTarget(cardEl);
          if (mount && mount.mode === "after" && mount.refEl && mount.refEl.parentNode) {
            mount.refEl.insertAdjacentElement("afterend", bar);
          } else {
            cardEl.appendChild(bar);
          }
        }

        syncUserCardBtnUi(btn, user, cached, mutedMatch);
      }
    }

    function runDomPass(collectedUids) {
      syncRouteScopeIfChanged();
      isApplyingDom = true;
      try {
        removeStrayInlineActions();
        processFeedCards(collectedUids);
        processCommentRows(collectedUids);
        processGenericUserRows(collectedUids);
        processOfficialUserCards(collectedUids);
        ensureCommentToolbar();
        ensureProfileBanner(collectedUids);
        ensureShieldPageSyncBar();
      } finally {
        if (activeObserver && typeof activeObserver.takeRecords === "function") {
          activeObserver.takeRecords();
        }
        isApplyingDom = false;
      }
    }

    function refreshBadgesForEntry(entry) {
      if (!entry || !entry.elements || entry.elements.size === 0) return;
      isApplyingDom = true;
      try {
        for (const anchorEl of Array.from(entry.elements)) {
          if (!anchorEl || !anchorEl.isConnected) {
            entry.elements.delete(anchorEl);
            continue;
          }
          ensureBadgesOnAnchor(anchorEl, entry);
        }
      } finally {
        if (activeObserver && typeof activeObserver.takeRecords === "function") {
          activeObserver.takeRecords();
        }
        isApplyingDom = false;
      }
    }

    function computePageStats() {
      const all = Array.from(pageRegistry.values()).filter((e) => e.status !== "muted");
      const doneEntries = all.filter((e) => e.status === "done");
      const pendingEntries = all.filter((e) => e.status === "queued" || e.status === "scanning" || e.status === "paused");
      const scanningEntry = all.find((e) => e.status === "scanning") || null;
      const flaggedEntries = [];
      const safeEntries = [];
      for (const e of doneEntries) {
        const c = getCachedResult(e);
        if (c && (c.level === "warn" || c.level === "high")) {
          flaggedEntries.push(e);
        } else {
          safeEntries.push(e);
        }
      }
      return {
        all,
        total: all.length,
        done: doneEntries.length,
        doneEntries,
        pendingEntries,
        scanningEntry,
        flaggedEntries,
        safeEntries
      };
    }

    async function persistStatePatch(patch) {
      const next = Engine.normalizeState({ ...state, ...patch });
      const resp = await sendMessage({ type: "WBR_SAVE_STATE", state: next });
      if (resp && resp.ok && resp.state) {
        state = Engine.normalizeState(resp.state);
        await applyAll(false);
      } else {
        state = next;
        await applyAll(false);
      }
    }

    function syncLiveWidgetSafeOffset() {
      // v1.5.0: Pure CSS fixed bottom-left positioning (left: 18px; bottom: 18px) - zero forced reflow
      return;
    }

    function removeLiveWidgetDom() {
      lastLiveWidgetSig = "";
      if (liveWidgetEl) {
        isApplyingDom = true;
        try {
          liveWidgetEl.remove();
          liveWidgetEl = null;
        } finally {
          if (activeObserver && typeof activeObserver.takeRecords === "function") {
            activeObserver.takeRecords();
          }
          isApplyingDom = false;
        }
      }
    }

    function startTransientDone(doneCount, flaggedCount, mode = "manual") {
      if (transientDoneTimer) {
        clearTimeout(transientDoneTimer);
        transientDoneTimer = null;
      }
      if (!doneCount || doneCount <= 0) {
        transientDoneInfo = null;
        renderLiveWidget(true);
        return;
      }
      const durationMs = flaggedCount > 0 ? 5000 : (mode === "auto" ? 1500 : 2200);
      transientDoneInfo = {
        done: doneCount,
        flaggedCount,
        mode,
        expiresAt: Date.now() + durationMs
      };
      renderLiveWidget(true);
      transientDoneTimer = setTimeout(() => {
        transientDoneTimer = null;
        transientDoneInfo = null;
        renderLiveWidget(true);
      }, durationMs);
    }

    function renderLiveWidget(force = false) {
      if (!doc.body) return;
      if (!state.enabled || !state.enableMainSite) {
        removeLiveWidgetDom();
        return;
      }

      const stats = computePageStats();
      const now = Date.now();
      const breaker = state.circuitBreaker && state.circuitBreaker.tripped && (state.circuitBreaker.until > now || state.circuitBreaker.trippedAt > 0)
        ? state.circuitBreaker
        : null;
      const showBreaker = Boolean(breaker && breakerDismissedUntil !== (breaker.until || 1));

      const hasPendingAuto = Boolean(state.autoScanViewport && stats.pendingEntries.some((e) => e.status === "queued" || e.status === "scanning"));
      const hasPendingOneShot = Boolean(oneShotViewportScan && (oneShotTargets.size > 0 || stats.scanningEntry));
      const isScanning = Boolean(stats.scanningEntry || hasPendingOneShot || (state.autoScanViewport && (autoInFlight || hasPendingAuto)));
      const showTransientDone = Boolean(!isScanning && transientDoneInfo && transientDoneInfo.expiresAt > now);

      // v1.5.0: Completely invisible during idle browsing!
      if (!isScanning && !showTransientDone && !showBreaker) {
        removeLiveWidgetDom();
        return;
      }

      const flaggedCount = stats.flaggedEntries.length;
      const pillMode = showBreaker ? "breaker" : (isScanning ? "scanning" : "done");
      let displayDone = stats.done;
      let displayTotal = stats.total;
      if (oneShotViewportScan && oneShotSessionTotal > 0) {
        displayTotal = oneShotSessionTotal;
        displayDone = Math.min(oneShotSessionTotal, oneShotSessionDone);
      }

      const liveWidgetSig = [
        pillMode,
        breaker ? String(breaker.until || 1) : "0",
        displayDone,
        displayTotal,
        flaggedCount,
        stats.scanningEntry ? `${stats.scanningEntry.key}:${stats.scanningEntry.currentPage || 0}` : "",
        showTransientDone ? `${transientDoneInfo.done}:${transientDoneInfo.flaggedCount}:${transientDoneInfo.expiresAt}` : ""
      ].join("|");

      if (!force && liveWidgetEl && liveWidgetEl.isConnected && liveWidgetSig === lastLiveWidgetSig) {
        return;
      }
      lastLiveWidgetSig = liveWidgetSig;

      isApplyingDom = true;
      try {
        if (!liveWidgetEl || !liveWidgetEl.isConnected) {
          liveWidgetEl = doc.createElement("div");
          liveWidgetEl.className = "wbr-live-widget";
          liveWidgetEl.setAttribute("data-wbr-live-widget", "1");
          liveWidgetEl.addEventListener("click", (ev) => ev.stopPropagation());
          doc.body.appendChild(liveWidgetEl);
        }

        const capsule = doc.createElement("div");
        capsule.className = "wbr-live-capsule wbr-live-capsule-minimal";

        const dot = doc.createElement("span");
        dot.className = "wbr-live-dot";

        const textSpan = doc.createElement("span");
        textSpan.className = "wbr-live-main";

        const actBtn = doc.createElement("button");
        actBtn.type = "button";
        actBtn.className = "wbr-live-icon-btn";

        if (pillMode === "breaker") {
          dot.classList.add("is-breaker");
          const remainMin = breaker.until > now ? Math.max(1, Math.ceil((breaker.until - now) / 60000)) : 1;
          textSpan.textContent = `⚠ 接口请求较快，休息约 ${remainMin} 分钟后恢复`;
          actBtn.textContent = "✕";
          actBtn.title = "关闭提示";
          actBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            breakerDismissedUntil = breaker.until || 1;
            renderLiveWidget(true);
          });
        } else if (pillMode === "scanning") {
          dot.classList.add("is-scanning");
          textSpan.textContent = `正在检测 ${displayDone}/${displayTotal} · 预警 ${flaggedCount}`;
          actBtn.textContent = "停止";
          actBtn.title = oneShotViewportScan ? "停止本轮扫描" : "停止并切回手动模式";
          actBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (oneShotViewportScan) {
              oneShotViewportScan = false;
              oneShotTargets.clear();
              for (const e of pageRegistry.values()) {
                if (e.status === "queued") e.status = "paused";
              }
              removeLiveWidgetDom();
              showToast("已停止当前页扫描");
            } else if (state.autoScanViewport) {
              for (const e of pageRegistry.values()) {
                if (e.status === "queued") e.status = "paused";
              }
              persistStatePatch({ autoScanViewport: false });
              showToast("已停止自动检测并切换回手动模式");
            }
          });
        } else {
          dot.classList.add(transientDoneInfo.flaggedCount > 0 ? "is-flagged" : "is-clean");
          textSpan.textContent = transientDoneInfo.flaggedCount > 0
            ? `已完成 ${transientDoneInfo.done} 人检测 · 发现 ${transientDoneInfo.flaggedCount} 位倾向账号（已在昵称旁标记）`
            : `✓ 已检完 ${transientDoneInfo.done} 人 · 未见明显倾向`;
          actBtn.textContent = "✕";
          actBtn.title = "关闭";
          actBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (transientDoneTimer) {
              clearTimeout(transientDoneTimer);
              transientDoneTimer = null;
            }
            transientDoneInfo = null;
            renderLiveWidget(true);
          });
        }

        capsule.append(dot, textSpan, actBtn);
        liveWidgetEl.replaceChildren(capsule);
      } finally {
        if (activeObserver && typeof activeObserver.takeRecords === "function") {
          activeObserver.takeRecords();
        }
        isApplyingDom = false;
      }
    }

    async function pumpViewportQueue() {
      if (autoInFlight) return;
      if (!state.enabled || !state.enableMainSite) return;
      if (state.circuitBreaker && state.circuitBreaker.tripped) return;
      if (!state.autoScanViewport && !oneShotViewportScan) return;

      const vh = win.innerHeight || 768;
      let bestTier1 = null;
      let bestTier1Score = Infinity;
      let bestTier2 = null;
      let bestTier2Score = Infinity;
      let bestTier3 = null;

      for (const entry of pageRegistry.values()) {
        if (entry.status !== "queued") continue;
        if (oneShotViewportScan && !state.autoScanViewport && !oneShotTargets.has(entry.key)) {
          continue;
        }
        const el =
          Array.from(entry.elements).find((x) => x && x.isConnected) ||
          Array.from(entry.rowElements).find((x) => x && x.isConnected);
        if (!el) {
          if (oneShotViewportScan && !bestTier3) bestTier3 = entry;
          continue;
        }
        const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
        if (rect && rect.bottom > 0 && rect.top < vh && (rect.width > 0 || rect.height > 0)) {
          const score = Math.max(0, rect.top);
          if (score < bestTier1Score) {
            bestTier1Score = score;
            bestTier1 = entry;
          }
        } else if (rect && rect.bottom > -vh && rect.top < vh * 2.5) {
          const centerDist = Math.abs((rect.top + rect.bottom) / 2 - vh / 2);
          if (centerDist < bestTier2Score) {
            bestTier2Score = centerDist;
            bestTier2 = entry;
          }
        } else if (oneShotViewportScan && !bestTier3) {
          bestTier3 = entry;
        }
      }

      const candidate = bestTier1 || bestTier2 || (oneShotViewportScan ? bestTier3 : null);
      if (!candidate) {
        if (oneShotViewportScan) {
          const sessionDone = oneShotSessionDone;
          oneShotViewportScan = false;
          oneShotTargets.clear();
          oneShotSessionTotal = 0;
          oneShotSessionDone = 0;
          const stats = computePageStats();
          if (sessionDone > 0) {
            startTransientDone(sessionDone, stats.flaggedEntries.length, "manual");
          } else {
            renderLiveWidget(true);
          }
        } else if (state.autoScanViewport && autoBatchDone > 0) {
          const batchDone = autoBatchDone;
          autoBatchDone = 0;
          const stats = computePageStats();
          startTransientDone(batchDone, stats.flaggedEntries.length, "auto");
        } else {
          renderLiveWidget();
        }
        return;
      }

      candidate.status = "scanning";
      candidate.currentPage = 0;
      candidate.maxPages = 0;
      currentScanningKey = candidate.key;
      autoInFlight = true;
      refreshBadgesForEntry(candidate);
      renderLiveWidget();

      if ((!candidate.uid || !candidate.profileHint) && callPageBridge) {
        const nowTs = Date.now();
        if (nowTs - lastAutoStampAt >= 600) {
          lastAutoStampAt = nowTs;
          try {
            await callPageBridge("WBR_PAGE_STAMP_VISIBLE", {}, 1500);
          } catch (_) {}
        }
        const rowEl = Array.from(candidate.rowElements).find((x) => x && x.isConnected) || null;
        const anchorEl = Array.from(candidate.elements).find((x) => x && x.isConnected) || null;
        if (rowEl || anchorEl) {
          const refreshed = extractUserFromContainer(rowEl, anchorEl);
          if (refreshed.uid && !candidate.uid) candidate.uid = refreshed.uid;
          if (refreshed.screenName && !candidate.screenName) candidate.screenName = refreshed.screenName;
          if (refreshed.profileHint) candidate.profileHint = refreshed.profileHint;
        }
      }

      let resp;
      try {
        resp = await sendMessage({
          type: "WBR_CHECK_USER",
          uid: candidate.uid,
          screenName: candidate.screenName,
          profileHint: candidate.profileHint,
          mode: oneShotViewportScan ? "manual" : "auto"
        });
      } catch (_) {
        resp = { ok: false };
      } finally {
        autoInFlight = false;
        currentScanningKey = null;
      }

      if (oneShotViewportScan) {
        oneShotSessionDone += 1;
        oneShotTargets.delete(candidate.key);
      } else if (state.autoScanViewport) {
        autoBatchDone += 1;
      }

      if (resp && resp.ok && resp.result) {
        storeCachedResult(resp.result, candidate);
        candidate.status = "done";
        await applyAll(false);
      } else if (resp && resp.isCircuitBreaker) {
        for (const e of pageRegistry.values()) {
          if (e.status === "queued" || e.status === "scanning") {
            e.status = "paused";
          }
        }
        oneShotViewportScan = false;
        oneShotTargets.clear();
        autoBatchDone = 0;
        const stResp = await sendMessage({ type: "WBR_GET_STATE" });
        if (stResp && stResp.ok && stResp.state) {
          state = Engine.normalizeState(stResp.state);
        }
        await applyAll(false);
        return;
      } else {
        candidate.status = "done";
        refreshBadgesForEntry(candidate);
        renderLiveWidget();
      }

      if (state.enabled && state.enableMainSite && (state.autoScanViewport || oneShotViewportScan)) {
        if (!pumpScheduledTimer) {
          pumpScheduledTimer = setTimeout(() => {
            pumpScheduledTimer = null;
            pumpViewportQueue();
          }, 10);
        }
      }
    }

    async function scanCurrentViewport() {
      if (!state.enabled || !state.enableMainSite) {
        return { ok: false, error: "当前已暂停保护，请先开启插件总开关" };
      }
      if (state.circuitBreaker && state.circuitBreaker.tripped && state.circuitBreaker.until > Date.now()) {
        breakerDismissedUntil = 0;
        renderLiveWidget(true);
        return { ok: false, error: "接口限流冷却中，请稍后再试" };
      }
      ensureAccountDetectedLazy();

      if (callPageBridge) {
        try {
          await callPageBridge("WBR_PAGE_STAMP_VISIBLE", {}, 2000);
        } catch (_) {}
      }

      await applyAll(true);

      const vh = win.innerHeight || 768;
      oneShotTargets.clear();
      let queuedCount = 0;

      for (const entry of pageRegistry.values()) {
        if (entry.status === "muted") continue;
        if (getCachedResult(entry)) {
          entry.status = "done";
          continue;
        }
        const el =
          Array.from(entry.elements).find((x) => x && x.isConnected) ||
          Array.from(entry.rowElements).find((x) => x && x.isConnected);
        if (!el || typeof el.getBoundingClientRect !== "function") continue;
        const rect = el.getBoundingClientRect();
        if (rect && rect.bottom >= -vh * 0.8 && rect.top <= vh * 1.8 && (rect.width > 0 || rect.height > 0)) {
          entry.status = "queued";
          oneShotTargets.add(entry.key);
          queuedCount += 1;
        }
      }

      if (queuedCount === 0) {
        const stats = computePageStats();
        if (stats.done > 0) {
          startTransientDone(stats.done, stats.flaggedEntries.length, "manual");
        }
        return { ok: true, queuedCount: 0 };
      }

      transientDoneInfo = null;
      if (transientDoneTimer) {
        clearTimeout(transientDoneTimer);
        transientDoneTimer = null;
      }
      oneShotViewportScan = true;
      oneShotSessionTotal = queuedCount;
      oneShotSessionDone = 0;
      renderLiveWidget(true);
      pumpViewportQueue();
      return { ok: true, queuedCount };
    }

    function handleUserScanProgress(msg) {
      if (!msg || typeof msg !== "object") return;
      const entry = getRegistryEntry({ uid: msg.uid, screenName: msg.screenName });
      if (entry) {
        if (msg.uid && !entry.uid) entry.uid = Engine.normalizeUid(msg.uid);
        entry.currentPage = Number(msg.currentPage) || 0;
        entry.maxPages = Number(msg.maxPages) || 0;
        if (entry.status !== "done" && entry.status !== "muted") {
          entry.status = "scanning";
        }
        refreshBadgesForEntry(entry);
      }
      if (popoverEl && popoverEl.isConnected && activeLoadingTarget) {
        const msgUid = Engine.normalizeUid(msg.uid);
        const msgName = Engine.normalizeText(msg.screenName);
        const targetUid = Engine.normalizeUid(activeLoadingTarget.uid);
        const targetName = Engine.normalizeText(activeLoadingTarget.screenName);
        const matched =
          (targetUid && msgUid && targetUid === msgUid) ||
          (targetName && msgName && namesMatchInsensitive(targetName, msgName));
        if (matched) {
          if (msgUid && !activeLoadingTarget.uid) {
            activeLoadingTarget.uid = msgUid;
          }
          const loadBody = popoverEl.querySelector(".wbr-popover-loading");
          if (loadBody) {
            const displayName = msgName || targetName || "这位用户";
            const prefix = activeLoadingTarget.simulateVisitor
              ? `正在以访客视角测算 @${displayName} 的近期关注`
              : `正在查看 @${displayName} 的近期关注`;
            if ((Number(msg.currentPage) || 0) <= 0) {
              loadBody.textContent = `${prefix} (已定位账号，准备拉取关注列表)...`;
            } else {
              loadBody.textContent = `${prefix} (第 ${msg.currentPage}/${msg.maxPages} 页 · 已查 ${msg.scannedCount || 0} 位)...`;
            }
          }
        }
      }
      renderLiveWidget();
    }

    async function applyAll(fetchMissingCache = false) {
      if (!state.enabled || !state.enableMainSite) {
        isApplyingDom = true;
        try {
          for (const el of doc.querySelectorAll("[data-wbr-hidden='1']")) {
            el.classList.remove("wbr-hidden-node");
            el.removeAttribute("data-wbr-hidden");
          }
          for (const el of doc.querySelectorAll(".wbr-collapsed-child")) {
            el.classList.remove("wbr-collapsed-child");
          }
          for (const el of doc.querySelectorAll("[data-wbr-banner='1']")) {
            el.remove();
          }
        } finally {
          if (activeObserver && typeof activeObserver.takeRecords === "function") {
            activeObserver.takeRecords();
          }
          isApplyingDom = false;
        }
        renderLiveWidget();
        return;
      }

      const collectedUids = new Set();
      runDomPass(collectedUids);

      if (fetchMissingCache && collectedUids.size > 0) {
        const missing = Array.from(collectedUids).filter((u) => !(u in cacheMap));
        if (missing.length > 0) {
          const resp = await sendMessage({ type: "WBR_GET_CACHED_BATCH", uids: missing });
          if (resp && resp.ok && resp.map && Object.keys(resp.map).length > 0) {
            setCacheMap(resp.map);
            for (const entry of pageRegistry.values()) {
              if (entry.status !== "muted" && getCachedResult(entry)) {
                entry.status = "done";
              }
            }
            isApplyingDom = true;
            try {
              processFeedCards(new Set());
              processCommentRows(new Set());
              processGenericUserRows(new Set());
              processOfficialUserCards(new Set());
              ensureProfileBanner(new Set());
            } finally {
              if (activeObserver && typeof activeObserver.takeRecords === "function") {
                activeObserver.takeRecords();
              }
              isApplyingDom = false;
            }
          }
        }
      }

      renderLiveWidget();
      if (state.autoScanViewport || oneShotViewportScan) {
        pumpViewportQueue();
      }
    }

    function scheduleScan() {
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        applyAll(true).catch(() => {});
      }, 150);
    }

    function setState(nextState) {
      state = Engine.normalizeState(nextState || {});
      if (win && typeof win.postMessage === "function") {
        try {
          win.postMessage(
            {
              source: "wbr-content",
              type: "WBR_PAGE_SET_ENABLED",
              enabled: Boolean(state.enabled && state.enableMainSite)
            },
            "*"
          );
        } catch (_) {}
      }
      if (!state.enabled || !state.enableMainSite) {
        hideHoverCheckBtn();
      }
      if (state.autoScanViewport) {
        ensureAccountDetectedLazy();
      }
      for (const entry of pageRegistry.values()) {
        if (Engine.findMutedMatch(entry, state)) {
          entry.status = "muted";
        } else if (getCachedResult(entry)) {
          entry.status = "done";
        } else if (entry.status !== "scanning") {
          if (state.circuitBreaker && state.circuitBreaker.tripped) {
            entry.status = "paused";
          } else {
            entry.status = (state.autoScanViewport || (oneShotViewportScan && oneShotTargets.has(entry.key)))
              ? "queued"
              : "paused";
          }
        }
      }
      applyAll(false);
    }

    function setCacheMap(map) {
      if (!map || typeof map !== "object") return;
      for (const [k, val] of Object.entries(map)) {
        if (val && typeof val === "object") {
          storeCachedResult(val);
        }
        if (k) cacheMap[k] = val;
      }
    }

    function updateBatchProgress(msg) {
      if (!msg || typeof msg.processed !== "number" || typeof msg.total !== "number") return;
      if (msg.result && (msg.result.level === "warn" || msg.result.level === "high")) {
        activeBatchHighCount += 1;
      }
      if (activeProgressFill && msg.total > 0) {
        const pct = Math.min(100, Math.round((msg.processed / msg.total) * 100));
        activeProgressFill.style.width = `${pct}%`;
      }
      if (activeStatusEl) {
        activeStatusEl.textContent = `正在查看 ${msg.processed}/${msg.total} · 已发现 ${activeBatchHighCount} 位有倾向`;
      }
    }

    function isWbrOwnedNode(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.classList) {
        for (const cls of node.classList) {
          if (cls.startsWith("wbr-")) return true;
        }
      }
      if (node.attributes) {
        for (const attr of node.attributes) {
          if (attr.name.startsWith("data-wbr-")) return true;
        }
      }
      return false;
    }

    let scrollBound = false;
    let resizeBound = false;
    let routeBound = false;
    function onViewportScroll() {
      if (!state.autoScanViewport && !oneShotViewportScan) return;
      if (scrollPumpTimer) return;
      scrollPumpTimer = setTimeout(() => {
        scrollPumpTimer = null;
        pumpViewportQueue();
      }, 180);
    }

    function onViewportResize() {
      // No-op: pure CSS fixed layout
    }

    function onRouteNavEvent() {
      syncRouteScopeIfChanged();
      scheduleScan();
    }

    function startObserver() {
      if (!doc.body) return null;
      bindHoverDelegation();
      if (!scrollBound && win && typeof win.addEventListener === "function") {
        scrollBound = true;
        win.addEventListener("scroll", onViewportScroll, { passive: true });
      }
      if (!resizeBound && win && typeof win.addEventListener === "function") {
        resizeBound = true;
        win.addEventListener("resize", onViewportResize, { passive: true });
      }
      if (!routeBound && win && typeof win.addEventListener === "function") {
        routeBound = true;
        win.addEventListener("popstate", onRouteNavEvent, { passive: true });
        win.addEventListener("hashchange", onRouteNavEvent, { passive: true });
      }
      const mo = new MutationObserver((mutations) => {
        if (isApplyingDom) return;
        const external = mutations.some((m) => {
          const t = m.target;
          if (t && t.closest && t.closest(".wbr-popover, .wbr-drawer, .wbr-toast, .wbr-comment-toolbar, .wbr-shield-banner, .wbr-live-widget, .wbr-hover-check-btn, .wbr-usercard-bar, .wbr-usercard-btn")) {
            return false;
          }
          const changed = [...(m.addedNodes || []), ...(m.removedNodes || [])];
          if (changed.length > 0 && changed.every(isWbrOwnedNode)) {
            return false;
          }
          return true;
        });
        if (external) scheduleScan();
      });
      mo.observe(doc.body, { childList: true, subtree: true });
      activeObserver = mo;
      return mo;
    }

    return {
      applyAll,
      scheduleScan,
      setState,
      setCacheMap,
      updateBatchProgress,
      handleUserScanProgress,
      pumpViewportQueue,
      scanCurrentViewport,
      renderLiveWidget,
      syncLiveWidgetSafeOffset,
      isInsideWeiboChromeUi,
      extractNameFromAnchor,
      isDecorativeUserLink,
      getBadgeAppearance,
      startObserver,
      getPageRegistry: () => pageRegistry,
      getState: () => state
    };
  }

  function createPageBridgeCaller() {
    let seq = 0;
    const pending = new Map();

    if (typeof window !== "undefined") {
      window.addEventListener("message", (ev) => {
        if (ev.source !== window || !ev.data || ev.data.source !== "wbr-main") return;
        const msg = ev.data;
        if (!msg.requestId || !pending.has(msg.requestId)) return;
        const entry = pending.get(msg.requestId);
        pending.delete(msg.requestId);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      });
    }

    return function callMainBridge(type, payload = {}, timeoutMs = 15000) {
      return new Promise((resolve) => {
        seq += 1;
        const requestId = `wbr_req_${Date.now()}_${seq}`;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({ ok: false, error: "Page bridge timeout" });
        }, timeoutMs);
        pending.set(requestId, { resolve, timer });
        try {
          window.postMessage({ source: "wbr-content", type, requestId, ...payload }, "*");
        } catch (err) {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve({ ok: false, error: err && err.message ? err.message : "postMessage failed" });
        }
      });
    };
  }

  async function bootChromeWeibo() {
    const callMainBridge = createPageBridgeCaller();
    const resolveTimeout = (msg, explicitTimeout) => {
      if (Number(explicitTimeout) > 0) return Number(explicitTimeout);
      const t = msg && msg.type;
      if (t === "WBR_CHECK_USER") return 35000;
      if (t === "WBR_RUN_BATCH_SCAN" || t === "WBR_RUN_CLEANUP_QUEUE" || t === "WBR_SYNC_BLOCKLIST") {
        return 180000;
      }
      if (t === "WBR_FETCH_POST_INTERACTORS" || t === "WBR_FETCH_SELF_INTERACTORS") return 60000;
      return 12000;
    };
    const formatErr = (rawErr) => {
      const m = String((rawErr && rawErr.message) || rawErr || "");
      if (m.includes("Extension context invalidated")) {
        return "插件刚刚更新或重载，请刷新当前微博页面后再试";
      }
      if (m.includes("message port closed") || m.includes("Receiving end does not exist")) {
        return "后台服务连接中断，请再试一次或刷新页面";
      }
      return m || "请求后台服务失败，请稍后再试";
    };
    const sendMessage = (msg, explicitTimeout = 0) =>
      new Promise((resolve) => {
        const timeoutMs = resolveTimeout(msg, explicitTimeout);
        let settled = false;
        const finish = (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(res);
        };
        const timer = setTimeout(() => {
          finish({ ok: false, error: "查询超时（服务未及时响应），请再试一次" });
        }, timeoutMs);
        try {
          chrome.runtime.sendMessage(msg, (resp) => {
            const lastErr = chrome.runtime && chrome.runtime.lastError;
            if (lastErr) {
              finish({ ok: false, error: formatErr(lastErr) });
              return;
            }
            finish(resp || { ok: false, error: "后台未返回结果，请重试" });
          });
        } catch (err) {
          finish({ ok: false, error: formatErr(err) });
        }
      });
    const initResp = await sendMessage({ type: "WBR_GET_STATE" });
    const injector = createWeiboInjector({
      initialState: initResp && initResp.state,
      sendMessage,
      callPageBridge: callMainBridge
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object") return false;
      if (msg.type === "WBR_STATE_UPDATED" && msg.state) {
        injector.setState(msg.state);
        return false;
      }
      if (msg.type === "WBR_USER_SCAN_PROGRESS") {
        injector.handleUserScanProgress(msg);
        return false;
      }
      if (msg.type === "WBR_BREAKER_TRIPPED" && msg.circuitBreaker) {
        const cur = injector.getState();
        injector.setState({ ...cur, circuitBreaker: msg.circuitBreaker });
        return false;
      }
      if (msg.type === "WBR_BATCH_PROGRESS") {
        injector.updateBatchProgress(msg);
        if (msg.result && msg.result.uid) {
          injector.setCacheMap({ [msg.result.uid]: msg.result });
          injector.applyAll(false);
        }
        return false;
      }
      if (msg.type === "WBR_SCAN_CURRENT_VIEWPORT") {
        injector.scanCurrentViewport().then((res) => sendResponse(res)).catch(() => sendResponse({ ok: false }));
        return true;
      }
      if (msg.type === "WBR_TAB_FETCH") {
        const reqTimeout = Math.max(2500, Math.min(20000, Number(msg.timeoutMs) || 8500));
        callMainBridge("WBR_PAGE_FETCH", {
          url: msg.url,
          method: msg.method || "GET",
          headers: msg.headers || {},
          body: msg.body,
          timeoutMs: Math.max(2000, reqTimeout - 1000)
        }, reqTimeout)
          .then((res) => sendResponse(res))
          .catch(() => sendResponse({ ok: false, error: "Tab fetch failed" }));
        return true;
      }
      if (msg.type === "WBR_TAB_GET_ACCOUNT") {
        callMainBridge("WBR_PAGE_GET_ACCOUNT", {}, 3000)
          .then((res) => sendResponse(res))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
      if (msg.type === "WBR_TAB_GET_XSRF") {
        callMainBridge("WBR_PAGE_GET_XSRF", {}, 4000)
          .then((res) => sendResponse(res))
          .catch(() => sendResponse({ ok: false, xsrfToken: "" }));
        return true;
      }
      return false;
    });

    window.addEventListener("message", (ev) => {
      if (ev.source === window && ev.data && ev.data.source === "wbr-main" && ev.data.type === "WBR_PAGE_USER_CARD_READY") {
        injector.scheduleScan();
      }
    });

    const curState = injector.getState();
    try {
      window.postMessage(
        {
          source: "wbr-content",
          type: "WBR_PAGE_SET_ENABLED",
          enabled: Boolean(curState.enabled && curState.enableMainSite)
        },
        "*"
      );
    } catch (_) {}

    await injector.applyAll(true);
    injector.startObserver();

    if (curState.autoScanViewport) {
      const syncAge = Date.now() - (Number(curState.viewerFollowingSyncedAt) || 0);
      if (!curState.account || !curState.account.uid || syncAge >= 12 * 60 * 60 * 1000) {
        sendMessage({ type: "WBR_DETECT_ACCOUNT" }).catch(() => {});
      }
    }
  }

  return { createWeiboInjector, bootChromeWeibo };
});
