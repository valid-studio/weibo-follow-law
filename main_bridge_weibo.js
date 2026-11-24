/**
 * MAIN world bridge for Weibo Main Site (weibo.com/*)
 * - Passively observes Weibo Pro Next XHR/Fetch API payloads to build screenName <-> uid index
 *   and capture loaded buildComments commenters for virtual-scroller posts
 * - Walks Vue3 __vueParentComponent metadata on Feed cards, Comment items, and ProfileHeader
 * - Stamps & updates authoritative data-wbr-uid / data-wbr-uname onto DOM nodes (recycled-safe)
 */
(function () {
  "use strict";

  if (window.__wbrWeiboBridgeLoaded) return;
  window.__wbrWeiboBridgeLoaded = true;

  const nameToUid = new Map();
  const uidToName = new Map();
  const uidToMeta = new Map();
  const MAX_UID_META = 2000;
  const capturedCommentsByKey = new Map(); // uid -> { uid, screenName, snippet, profileHint }
  const MAX_CAPTURED_COMMENTS = 200;
  let lastPathForComments = "";
  let lastKnownPath = window.location ? (window.location.pathname || "") : "";
  let bridgeEnabled = true;
  const rawFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  const WBR_USER_ATTRS = [
    "data-wbr-uid",
    "data-wbr-uname",
    "data-wbr-ufollowing",
    "data-wbr-uvtype",
    "data-wbr-ufriends",
    "data-wbr-ufollowers"
  ];

  const NON_PROFILE_FIRST_SEGMENTS = new Set([
    "home",
    "mygroups",
    "fav",
    "detail",
    "set",
    "p",
    "u",
    "n",
    "search",
    "hot",
    "tv",
    "a",
    "login",
    "signup",
    "ajax",
    "ttarticle",
    "newlogin"
  ]);

  function clearWbrUserAttrs(el) {
    if (!el || typeof el.removeAttribute !== "function") return;
    for (const attr of WBR_USER_ATTRS) {
      el.removeAttribute(attr);
    }
  }

  function clearProfileRouteAttrs() {
    if (!document.documentElement) return;
    document.documentElement.removeAttribute("data-wbr-profile-uid");
    document.documentElement.removeAttribute("data-wbr-profile-uname");
    document.documentElement.removeAttribute("data-wbr-profile-route");
  }

  function handleRouteMaybeChanged() {
    const curPath = window.location ? (window.location.pathname || "") : "";
    if (curPath !== lastKnownPath) {
      lastKnownPath = curPath;
      lastPathForComments = curPath;
      capturedCommentsByKey.clear();
      clearProfileRouteAttrs();
    }
  }

  function installRouteChangeHooks() {
    if (window.history && typeof window.history.pushState === "function") {
      const origPushState = window.history.pushState;
      window.history.pushState = function () {
        const ret = origPushState.apply(this, arguments);
        try {
          handleRouteMaybeChanged();
        } catch (_) {}
        return ret;
      };
    }
    if (window.history && typeof window.history.replaceState === "function") {
      const origReplaceState = window.history.replaceState;
      window.history.replaceState = function () {
        const ret = origReplaceState.apply(this, arguments);
        try {
          handleRouteMaybeChanged();
        } catch (_) {}
        return ret;
      };
    }
    if (typeof window.addEventListener === "function") {
      window.addEventListener("popstate", handleRouteMaybeChanged, true);
      window.addEventListener("hashchange", handleRouteMaybeChanged, true);
    }
  }

  installRouteChangeHooks();

  function safeDecodeUriComponent(val) {
    try {
      return decodeURIComponent(String(val || ""));
    } catch (_) {
      return String(val || "");
    }
  }

  function doesProfileInfoMatchCurrentRoute(reqUrl, u, curPath) {
    if (!curPath || !u) return false;
    const uid = String(u.uid || u.idstr || u.id || "").trim();
    if (!/^\d{5,}$/.test(uid)) return false;
    const uname = String(u.screenName || u.screen_name || u.name || "").trim().toLowerCase();
    const udomain = String(u.domain || "").trim().toLowerCase();

    let reqUid = "";
    let reqScreenName = "";
    let reqCustom = "";
    if (reqUrl) {
      try {
        const parsed = new URL(String(reqUrl), window.location.origin);
        reqUid = String(parsed.searchParams.get("uid") || "").trim();
        reqScreenName = String(parsed.searchParams.get("screen_name") || "").trim().toLowerCase();
        reqCustom = String(parsed.searchParams.get("custom") || "").trim().toLowerCase();
      } catch (_) {}
    }

    const uMatch = curPath.match(/^\/u\/(\d{5,})(?:[/?#]|$)/);
    if (uMatch) {
      return uid === uMatch[1];
    }

    const nMatch = curPath.match(/^\/n\/([^/?#]+)/);
    if (nMatch) {
      const pathNick = safeDecodeUriComponent(nMatch[1]).trim().toLowerCase();
      if (!pathNick) return false;
      if (uname && uname === pathNick) return true;
      if (udomain && udomain === pathNick) return true;
      if (reqScreenName && reqScreenName === pathNick) return true;
      if (reqCustom && reqCustom === pathNick) return true;
      return false;
    }

    const segMatch = curPath.match(/^\/([^/?#]+)(?:[/?#]|$)/);
    if (segMatch) {
      const firstSeg = safeDecodeUriComponent(segMatch[1]).trim().toLowerCase();
      if (!firstSeg || NON_PROFILE_FIRST_SEGMENTS.has(firstSeg)) return false;
      if (/^\d{5,}$/.test(firstSeg)) {
        return uid === firstSeg;
      }
      if (udomain && udomain === firstSeg) return true;
      if (reqCustom && reqCustom === firstSeg) return true;
      if (uname && uname === firstSeg && !reqUid) return true;
      return false;
    }

    return false;
  }

  function scheduleIdleTask(fn) {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => {
        try { fn(); } catch (_) {}
      }, { timeout: 300 });
    } else {
      setTimeout(() => {
        try { fn(); } catch (_) {}
      }, 0);
    }
  }

  function syncLoginUidAttr() {
    if (window.$CONFIG && window.$CONFIG.uid) {
      const uid = String(window.$CONFIG.uid).trim();
      if (/^\d{5,}$/.test(uid) && document.documentElement.getAttribute("data-wbr-login-uid") !== uid) {
        document.documentElement.setAttribute("data-wbr-login-uid", uid);
      }
    }
  }

  function readCookieValue(name) {
    try {
      const m = String(document.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
      return m ? decodeURIComponent(m[1]) : "";
    } catch (_) {
      return "";
    }
  }

  function validateSameOriginWeiboUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""), window.location.origin);
      if (parsed.origin !== "https://weibo.com") return "";
      if (!parsed.pathname.startsWith("/ajax/") && parsed.pathname !== "/") return "";
      return parsed.toString();
    } catch (_) {
      return "";
    }
  }

  function readConfigAccount() {
    const cfg = window.$CONFIG || {};
    const user = cfg.user && typeof cfg.user === "object" ? cfg.user : {};
    const uid = String(cfg.uid || user.idstr || user.id || document.documentElement.getAttribute("data-wbr-login-uid") || "").trim();
    const screenName = String(user.screen_name || cfg.nick || cfg.screen_name || "").trim();
    return {
      uid: /^\d{5,}$/.test(uid) ? uid : "",
      screenName
    };
  }

  function resetCapturedCommentsIfNavigated() {
    handleRouteMaybeChanged();
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== "wbr-content") return;
    const msg = ev.data;
    if (msg.type === "WBR_PAGE_SET_ENABLED") {
      bridgeEnabled = msg.enabled !== false;
      return;
    }

    if (msg.type === "WBR_PAGE_STAMP_VISIBLE") {
      if (bridgeEnabled) {
        try { stampVisibleDom(); } catch (_) {}
      }
      window.postMessage(
        {
          source: "wbr-main",
          type: "WBR_PAGE_STAMP_VISIBLE_RESULT",
          requestId: msg.requestId,
          ok: true
        },
        "*"
      );
      return;
    }

    if (msg.type === "WBR_PAGE_GET_ACCOUNT") {
      syncLoginUidAttr();
      let acc = readConfigAccount();
      if (!acc.uid && rawFetch) {
        try {
          const cfgResp = await rawFetch("https://weibo.com/ajax/config/get_config", {
            method: "GET",
            credentials: "include",
            headers: {
              Accept: "application/json, text/plain, */*",
              "X-Requested-With": "XMLHttpRequest"
            }
          });
          if (cfgResp && cfgResp.ok) {
            const cfgData = await cfgResp.json().catch(() => null);
            const cfgUid = String((cfgData && cfgData.data && cfgData.data.uid) || (cfgData && cfgData.uid) || "").trim();
            if (/^\d{5,}$/.test(cfgUid)) {
              document.documentElement.setAttribute("data-wbr-login-uid", cfgUid);
              acc = {
                uid: cfgUid,
                screenName: acc.screenName || String((cfgData && cfgData.data && cfgData.data.screen_name) || "").trim()
              };
            }
          }
        } catch (_) {}
      }
      window.postMessage(
        {
          source: "wbr-main",
          type: "WBR_PAGE_GET_ACCOUNT_RESULT",
          requestId: msg.requestId,
          ok: true,
          uid: acc.uid,
          screenName: acc.screenName,
          xsrfToken: readCookieValue("XSRF-TOKEN")
        },
        "*"
      );
      return;
    }

    if (msg.type === "WBR_PAGE_GET_XSRF") {
      let xsrf = readCookieValue("XSRF-TOKEN");
      if (!xsrf && rawFetch) {
        try {
          await rawFetch("https://weibo.com/ajax/config/get_config", {
            method: "GET",
            credentials: "include",
            headers: {
              Accept: "application/json, text/plain, */*",
              "X-Requested-With": "XMLHttpRequest"
            }
          });
          xsrf = readCookieValue("XSRF-TOKEN");
        } catch (_) {}
      }
      window.postMessage(
        {
          source: "wbr-main",
          type: "WBR_PAGE_GET_XSRF_RESULT",
          requestId: msg.requestId,
          ok: Boolean(xsrf),
          xsrfToken: xsrf || ""
        },
        "*"
      );
      return;
    }

    if (msg.type === "WBR_PAGE_GET_CAPTURED_COMMENTS") {
      resetCapturedCommentsIfNavigated();
      window.postMessage(
        {
          source: "wbr-main",
          type: "WBR_PAGE_GET_CAPTURED_COMMENTS_RESULT",
          requestId: msg.requestId,
          ok: true,
          comments: Array.from(capturedCommentsByKey.values())
        },
        "*"
      );
      return;
    }

    if (msg.type === "WBR_PAGE_FETCH") {
      const targetUrl = validateSameOriginWeiboUrl(msg.url);
      if (!targetUrl || !rawFetch) {
        window.postMessage(
          {
            source: "wbr-main",
            type: "WBR_PAGE_FETCH_RESULT",
            requestId: msg.requestId,
            ok: false,
            error: "Invalid same-origin Weibo URL"
          },
          "*"
        );
        return;
      }

      const timeoutMs = Math.max(2000, Math.min(20000, Number(msg.timeoutMs) || 7500));
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let aborted = false;
      const fetchTimer = setTimeout(() => {
        aborted = true;
        if (controller) {
          try { controller.abort(); } catch (_) {}
        }
      }, timeoutMs);

      try {
        const method = String(msg.method || "GET").toUpperCase();
        const headers = {
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          ...(msg.headers && typeof msg.headers === "object" ? msg.headers : {})
        };
        delete headers.Referer;
        delete headers.referer;
        let xsrf = readCookieValue("XSRF-TOKEN");
        if (!xsrf && !headers["X-XSRF-TOKEN"] && method !== "GET" && method !== "HEAD" && rawFetch) {
          try {
            await rawFetch("https://weibo.com/ajax/config/get_config", {
              method: "GET",
              credentials: "include",
              headers: {
                Accept: "application/json, text/plain, */*",
                "X-Requested-With": "XMLHttpRequest"
              }
            });
            xsrf = readCookieValue("XSRF-TOKEN");
          } catch (_) {}
        }
        if (xsrf && !headers["X-XSRF-TOKEN"]) {
          headers["X-XSRF-TOKEN"] = xsrf;
        }
        const fetchOpts = {
          method,
          credentials: "include",
          headers,
          ...(controller ? { signal: controller.signal } : {})
        };
        if (method !== "GET" && method !== "HEAD" && msg.body !== undefined) {
          if (!headers["Content-Type"]) {
            headers["Content-Type"] = "application/json;charset=UTF-8";
          }
          fetchOpts.body = typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body);
        }
        const resp = await rawFetch(targetUrl, fetchOpts);
        const text = await resp.text();
        window.postMessage(
          {
            source: "wbr-main",
            type: "WBR_PAGE_FETCH_RESULT",
            requestId: msg.requestId,
            ok: true,
            status: resp.status,
            httpOk: resp.ok,
            text,
            xsrfToken: readCookieValue("XSRF-TOKEN")
          },
          "*"
        );
      } catch (err) {
        const errMsg = aborted || (err && err.name === "AbortError")
          ? "请求超时，请重试"
          : (err && err.message ? err.message : "Page fetch failed");
        window.postMessage(
          {
            source: "wbr-main",
            type: "WBR_PAGE_FETCH_RESULT",
            requestId: msg.requestId,
            ok: false,
            error: errMsg
          },
          "*"
        );
      } finally {
        clearTimeout(fetchTimer);
      }
    }
  });

  function buildProfileHintFromMeta(meta) {
    if (!meta || typeof meta !== "object") return undefined;
    const hint = {};
    if (typeof meta.viewerFollowing === "boolean") hint.viewerFollowing = meta.viewerFollowing;
    if (typeof meta.verifiedType === "number") hint.verifiedType = meta.verifiedType;
    if (typeof meta.friendsCount === "number") hint.friendsCount = meta.friendsCount;
    if (typeof meta.followersCount === "number") hint.followersCount = meta.followersCount;
    return Object.keys(hint).length > 0 ? hint : undefined;
  }

  function recordUser(u) {
    if (!u || typeof u !== "object") return;
    const uid = String(u.idstr || u.id || "").trim();
    const screenName = String(u.screen_name || u.name || "").trim();
    if (!/^\d{5,}$/.test(uid)) return;
    if (screenName) {
      nameToUid.set(screenName.toLowerCase(), { uid, screenName });
      uidToName.set(uid, screenName);
    }

    const prev = uidToMeta.get(uid) || { uid };
    const next = {
      uid,
      screenName: screenName || prev.screenName || "",
      followersCount: typeof u.followers_count === "number" ? u.followers_count : prev.followersCount,
      friendsCount: typeof u.friends_count === "number" ? u.friends_count : prev.friendsCount,
      viewerFollowing: typeof u.following === "boolean" ? u.following : prev.viewerFollowing,
      verifiedType: typeof u.verified_type === "number" ? u.verified_type : prev.verifiedType
    };
    if (!uidToMeta.has(uid) && uidToMeta.size >= MAX_UID_META) {
      const oldestKey = uidToMeta.keys().next().value;
      if (oldestKey !== undefined) uidToMeta.delete(oldestKey);
    }
    uidToMeta.set(uid, next);
  }

  function recordCommentItem(c) {
    if (!c || typeof c !== "object") return;
    const userObj = c.user || (c.idstr && c.screen_name ? c : null);
    if (!userObj) return;
    recordUser(userObj);
    const uid = String(userObj.idstr || userObj.id || "").trim();
    const screenName = String(userObj.screen_name || userObj.name || "").trim();
    if (/^\d{5,}$/.test(uid) && !capturedCommentsByKey.has(uid) && capturedCommentsByKey.size < MAX_CAPTURED_COMMENTS) {
      const snippet = String(c.text_raw || c.text || "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      const profileHint = buildProfileHintFromMeta(uidToMeta.get(uid));
      capturedCommentsByKey.set(uid, { uid, screenName, snippet, profileHint });
    }
    if (Array.isArray(c.comments)) {
      for (const sub of c.comments) {
        recordCommentItem(sub);
      }
    }
  }

  function walkAndCollectUsers(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 5) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i += 1) {
        walkAndCollectUsers(obj[i], depth + 1);
      }
      return;
    }
    if (obj.user && typeof obj.user === "object") {
      recordUser(obj.user);
    }
    if (obj.from_user && typeof obj.from_user === "object") {
      recordUser(obj.from_user);
    }
    if (obj.retweeted_status && typeof obj.retweeted_status === "object") {
      walkAndCollectUsers(obj.retweeted_status, depth + 1);
    }
    if (Array.isArray(obj.comments)) {
      walkAndCollectUsers(obj.comments, depth + 1);
    }
    if (Array.isArray(obj.statuses)) {
      walkAndCollectUsers(obj.statuses, depth + 1);
    }
    if (Array.isArray(obj.list)) {
      walkAndCollectUsers(obj.list, depth + 1);
    }
    if (obj.data && typeof obj.data === "object") {
      walkAndCollectUsers(obj.data, depth + 1);
    }
  }

  const WATCH_APIS = [
    "/ajax/statuses/buildComments",
    "/ajax/statuses/repostTimeline",
    "/ajax/statuses/show",
    "/ajax/statuses/mymblog",
    "/ajax/feed/friendstimeline",
    "/ajax/feed/groupstimeline",
    "/ajax/feed/hottimeline",
    "/ajax/profile/info",
    "/ajax/profile/side",
    "/ajax/friendships/friends"
  ];

  function shouldInspectUrl(url) {
    if (typeof url !== "string") return false;
    return WATCH_APIS.some((p) => url.includes(p));
  }

  function handlePayloadText(text, url = "") {
    if (!bridgeEnabled) return;
    if (!text || typeof text !== "string" || text.length > 524288) return;
    if (!text.includes('"user"') && !text.includes('"screen_name"')) return;
    handleRouteMaybeChanged();
    const scheduledPath = window.location ? (window.location.pathname || "") : "";
    scheduleIdleTask(() => {
      if (!bridgeEnabled) return;
      handleRouteMaybeChanged();
      try {
        const parsed = JSON.parse(text);
        walkAndCollectUsers(parsed, 0);
        if (url.includes("/ajax/statuses/buildComments") && parsed && Array.isArray(parsed.data)) {
          resetCapturedCommentsIfNavigated();
          for (const c of parsed.data) {
            recordCommentItem(c);
          }
        }
        if (url.includes("/ajax/statuses/repostTimeline") && parsed) {
          const list = Array.isArray(parsed.data)
            ? parsed.data
            : (parsed.data && Array.isArray(parsed.data.data) ? parsed.data.data : []);
          if (list.length > 0) {
            resetCapturedCommentsIfNavigated();
            for (const item of list) {
              recordCommentItem(item);
            }
          }
        }
        if (url.includes("/ajax/profile/info") && parsed && parsed.data && parsed.data.user) {
          const u = parsed.data.user;
          const uid = String(u.idstr || u.id || "").trim();
          const uname = String(u.screen_name || "").trim();
          const curPath = window.location ? (window.location.pathname || "") : "";
          if (curPath === scheduledPath && doesProfileInfoMatchCurrentRoute(url, u, curPath)) {
            document.documentElement.setAttribute("data-wbr-profile-uid", uid);
            if (uname) {
              document.documentElement.setAttribute("data-wbr-profile-uname", uname);
            } else {
              document.documentElement.removeAttribute("data-wbr-profile-uname");
            }
            document.documentElement.setAttribute("data-wbr-profile-route", curPath);
          }
          setTimeout(() => {
            try {
              stampUserCardPopovers();
              window.postMessage({ source: "wbr-main", type: "WBR_PAGE_USER_CARD_READY" }, "*");
            } catch (_) {}
          }, 40);
        }
      } catch (_) {}
    });
  }

  // Passive XHR observer
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (_method, url) {
    this.__wbrUrl = typeof url === "string" ? url : "";
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (bridgeEnabled && shouldInspectUrl(this.__wbrUrl)) {
      const reqUrl = this.__wbrUrl;
      this.addEventListener("load", () => {
        if (bridgeEnabled && typeof this.responseText === "string") {
          handlePayloadText(this.responseText, reqUrl);
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // Passive Fetch observer
  if (typeof window.fetch === "function") {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const p = origFetch.apply(this, arguments);
      if (bridgeEnabled && shouldInspectUrl(url)) {
        p.then((resp) => {
          if (bridgeEnabled && resp && typeof resp.clone === "function") {
            resp.clone().text().then((txt) => handlePayloadText(txt, url)).catch(() => {});
          }
        }).catch(() => {});
      }
      return p;
    };
  }

  function pickVueUserObject(bag) {
    if (!bag || typeof bag !== "object") return null;
    if (bag.commentData && bag.commentData.user) return bag.commentData.user;
    if (bag.data && bag.data.user) return bag.data.user;
    if (bag.item && bag.item.user) return bag.item.user;
    if (bag.userInfo && (bag.userInfo.idstr || bag.userInfo.id || bag.userInfo.screen_name)) return bag.userInfo;
    if (bag.cardInfo && (bag.cardInfo.idstr || bag.cardInfo.id || bag.cardInfo.screen_name)) return bag.cardInfo;
    if (bag.cardData && (bag.cardData.idstr || bag.cardData.id || bag.cardData.screen_name)) return bag.cardData;
    if (bag.info && (bag.info.idstr || bag.info.id || bag.info.screen_name)) return bag.info;
    if (bag.user && (bag.user.idstr || bag.user.id || bag.user.screen_name)) return bag.user;
    if (bag.data && bag.data.idstr && bag.data.screen_name) return bag.data;
    if (bag.item && bag.item.idstr && bag.item.screen_name) return bag.item;
    return null;
  }

  function extractVueUserFromEl(el) {
    let cur = el;
    for (let step = 0; step < 5 && cur; step += 1) {
      try {
        const comp = cur.__vueParentComponent;
        if (comp) {
          const fromProps = pickVueUserObject(comp.props);
          if (fromProps) return fromProps;
          const fromSetup = pickVueUserObject(comp.setupState);
          if (fromSetup) return fromSetup;
        }
      } catch (_) {}
      cur = cur.parentElement;
    }
    return null;
  }

  function extractCleanAnchorText(a) {
    if (!a) return "";
    const titleRaw = String(a.getAttribute("title") || "").replace(/^@/, "").trim();
    if (titleRaw && !/^\d+\+?$/.test(titleRaw)) {
      return titleRaw;
    }
    let raw = "";
    if (a.children && a.children.length > 0 && typeof a.cloneNode === "function" && typeof a.querySelectorAll === "function") {
      const clone = a.cloneNode(true);
      for (const noise of clone.querySelectorAll(
        '.woo-badge, [class*="woo-badge"], [class*="fans" i], [class*="medal" i], [class*="woo-tag"], [class*="Mute" i], [data-wbr-badge], [data-wbr-self-badge], [data-wbr-muted-badge], .wbr-profile-inline-btn, .wbr-hover-check-btn, button, svg, img'
      )) {
        if (noise && typeof noise.remove === "function") noise.remove();
      }
      raw = String(clone.textContent || "");
    } else {
      raw = String(a.textContent || "");
    }
    raw = raw.replace(/^@/, "").trim();
    if (!raw || /^\d+\+?$/.test(raw)) return "";
    return raw;
  }

  function extractAnchorUid(a) {
    if (!a) return "";
    const href = String(a.getAttribute("href") || "");
    if (href.includes("bigFans") || href.includes("page.star.weibo.com") || href.includes("vip.weibo")) return "";
    const mHref = href.match(/\/u\/(\d{5,})/) || href.match(/^(?:https?:)?\/\/weibo\.com\/(\d{5,})(?:[/?#]|$)/);
    if (mHref) return mHref[1];
    const uc = String(a.getAttribute("usercard") || "");
    const mUc = uc.match(/(?:^|&)id=(\d{5,})/) || uc.match(/^(\d{5,})$/);
    return mUc ? mUc[1] : "";
  }

  function syncAnchorEl(a) {
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.includes("bigFans") || href.includes("page.star.weibo.com") || href.includes("vip.weibo")) return;
    const text = extractCleanAnchorText(a);
    const oldUname = String(a.getAttribute("data-wbr-uname") || "").trim();
    const oldUid = String(a.getAttribute("data-wbr-uid") || "").trim();
    const directUid = extractAnchorUid(a);
    if (
      (text && oldUname && text.toLowerCase() !== oldUname.toLowerCase()) ||
      (directUid && oldUid && oldUid !== directUid)
    ) {
      clearWbrUserAttrs(a);
    }
    if (directUid) {
      const stored = uidToMeta.get(directUid);
      stampEl(a, {
        ...(stored || {}),
        uid: directUid,
        screenName: text || (stored && stored.screenName) || ""
      });
      return;
    }
    if (text) {
      const hit = nameToUid.get(text.toLowerCase());
      if (hit) {
        stampEl(a, hit);
      }
    }
  }

  function syncVueUserToEl(el, vueUser) {
    if (!el || !vueUser) return;
    const vUid = String(vueUser.uid || vueUser.idstr || vueUser.id || "").trim();
    const vName = String(vueUser.screenName || vueUser.screen_name || vueUser.name || "").trim();
    const oldUname = String(el.getAttribute("data-wbr-uname") || "").trim();
    if (!/^\d{5,}$/.test(vUid)) {
      clearWbrUserAttrs(el);
      if (vName) el.setAttribute("data-wbr-uname", vName);
      return;
    }
    if (oldUname && vName && oldUname.toLowerCase() !== vName.toLowerCase()) {
      clearWbrUserAttrs(el);
    }
    recordUser(vueUser);
    stampEl(el, vueUser);
  }

  function stampEl(el, user) {
    if (!el || !user) return;
    const uid = String(user.uid || user.idstr || user.id || "").trim();
    const storedMeta = /^\d{5,}$/.test(uid) ? uidToMeta.get(uid) : null;
    const uname = String(
      user.screenName || user.screen_name || user.name || (storedMeta && storedMeta.screenName) || ""
    ).trim();
    const prevUid = String(el.getAttribute("data-wbr-uid") || "").trim();
    const prevUname = String(el.getAttribute("data-wbr-uname") || "").trim();
    const identityChanged =
      (/^\d{5,}$/.test(uid) && prevUid && prevUid !== uid) ||
      (uname && prevUname && prevUname.toLowerCase() !== uname.toLowerCase());
    if (identityChanged) {
      clearWbrUserAttrs(el);
    }
    // Always update when Vue recycles the DOM element to a different user
    if (/^\d{5,}$/.test(uid) && el.getAttribute("data-wbr-uid") !== uid) {
      el.setAttribute("data-wbr-uid", uid);
    }
    if (uname && el.getAttribute("data-wbr-uname") !== uname) {
      el.setAttribute("data-wbr-uname", uname);
    }

    const viewerFollowing = typeof user.following === "boolean"
      ? user.following
      : (storedMeta && typeof storedMeta.viewerFollowing === "boolean" ? storedMeta.viewerFollowing : undefined);
    const verifiedType = typeof user.verified_type === "number"
      ? user.verified_type
      : (storedMeta && typeof storedMeta.verifiedType === "number" ? storedMeta.verifiedType : undefined);
    const friendsCount = typeof user.friends_count === "number"
      ? user.friends_count
      : (storedMeta && typeof storedMeta.friendsCount === "number" ? storedMeta.friendsCount : undefined);
    const followersCount = typeof user.followers_count === "number"
      ? user.followers_count
      : (storedMeta && typeof storedMeta.followersCount === "number" ? storedMeta.followersCount : undefined);

    if (typeof viewerFollowing === "boolean") {
      const v = viewerFollowing ? "1" : "0";
      if (el.getAttribute("data-wbr-ufollowing") !== v) el.setAttribute("data-wbr-ufollowing", v);
    }
    if (typeof verifiedType === "number") {
      const v = String(verifiedType);
      if (el.getAttribute("data-wbr-uvtype") !== v) el.setAttribute("data-wbr-uvtype", v);
    }
    if (typeof friendsCount === "number") {
      const v = String(friendsCount);
      if (el.getAttribute("data-wbr-ufriends") !== v) el.setAttribute("data-wbr-ufriends", v);
    }
    if (typeof followersCount === "number") {
      const v = String(followersCount);
      if (el.getAttribute("data-wbr-ufollowers") !== v) el.setAttribute("data-wbr-ufollowers", v);
    }
  }

  function stampFeedCard(card) {
    if (!card) return;
    const comp = card.__vueParentComponent;
    if (comp && comp.props && comp.props.data) {
      const d = comp.props.data;
      if (d.user) {
        syncVueUserToEl(card, d.user);
      }
      if (d.retweeted_status && d.retweeted_status.user) {
        const reBox = card.querySelector('.retweet, [class*="_retweet_"], [class*="wbpro-feed-reText"], [class*="Feed_retweet"]');
        if (reBox) {
          syncVueUserToEl(reBox, d.retweeted_status.user);
        } else {
          recordUser(d.retweeted_status.user);
        }
      }
    } else {
      const vueUser = extractVueUserFromEl(card);
      if (vueUser) {
        syncVueUserToEl(card, vueUser);
      }
    }
  }

  function stampVisibleDom() {
    handleRouteMaybeChanged();
    syncLoginUidAttr();
    const vh = window.innerHeight || 900;
    const isNearViewport = (el) => {
      try {
        const rect = el.getBoundingClientRect();
        return rect.bottom >= -vh * 1.2 && rect.top <= vh * 2.2;
      } catch (_) {
        return true;
      }
    };

    const comments = document.querySelectorAll(".wbpro-list");
    for (const row of comments) {
      if (!isNearViewport(row)) continue;
      const vueUser = extractVueUserFromEl(row);
      if (vueUser) {
        syncVueUserToEl(row, vueUser);
      }
      const subItems = row.querySelectorAll(".list2 > .item2");
      for (const sub of subItems) {
        const subVueUser = extractVueUserFromEl(sub);
        if (subVueUser) {
          syncVueUserToEl(sub, subVueUser);
        }
      }
    }

    const feeds = document.querySelectorAll('article, [class*="Feed_wrap"]');
    for (const card of feeds) {
      if (!isNearViewport(card)) continue;
      stampFeedCard(card);
    }

    const genericItems = document.querySelectorAll('.vue-recycle-scroller__item-view, .wbpro-scroller-item, [class*="UserCard"], [class*="Repost"], [class*="_user_"]');
    for (const item of genericItems) {
      if (!isNearViewport(item)) continue;
      const vueUser = extractVueUserFromEl(item);
      if (vueUser) {
        syncVueUserToEl(item, vueUser);
      }
    }

    stampUserCardPopovers();

    const anchors = document.querySelectorAll('a[href^="/n/"], a[href*="weibo.com/n/"], a[usercard], a[href*="/u/"]');
    for (const a of anchors) {
      if (!isNearViewport(a)) continue;
      syncAnchorEl(a);
    }

    const profileHeader =
      document.querySelector('[class*="ProfileHeader"], [data-wbr-profile-header]') ||
      (() => {
        const nameEl = document.querySelector(
          'main [class*="_box1_"] [class*="_name_"], main [class*="_name_"][class*="_1yc79"], main [class*="_h3_"] [class*="_name_"]'
        );
        if (!nameEl) return null;
        return nameEl.closest(".woo-panel-main") || nameEl.closest('[class*="_box1_"]') || nameEl;
      })();
    if (profileHeader) {
      const curPath = window.location ? (window.location.pathname || "") : "";
      const vueUser = extractVueUserFromEl(profileHeader);
      if (vueUser) {
        const vUid = String(vueUser.uid || vueUser.idstr || vueUser.id || "").trim();
        const vName = String(vueUser.screenName || vueUser.screen_name || vueUser.name || "").trim();
        if (!/^\d{5,}$/.test(vUid) || !doesProfileInfoMatchCurrentRoute("", vueUser, curPath)) {
          clearWbrUserAttrs(profileHeader);
        } else {
          recordUser(vueUser);
          stampEl(profileHeader, vueUser);
          document.documentElement.setAttribute("data-wbr-profile-uid", vUid);
          if (vName) {
            document.documentElement.setAttribute("data-wbr-profile-uname", vName);
          } else {
            document.documentElement.removeAttribute("data-wbr-profile-uname");
          }
          document.documentElement.setAttribute("data-wbr-profile-route", curPath);
        }
      }
    }
  }

  function stampUserCardPopovers() {
    const cards = document.querySelectorAll('.woo-pop-main, .woo-pop-wrap-main, [class*="UserCard"], [class*="userCard" i], [class*="PopCard" i]');
    for (const card of cards) {
      const vueUser = extractVueUserFromEl(card);
      if (vueUser) {
        syncVueUserToEl(card, vueUser);
      }
      const links = card.querySelectorAll('a[href^="/n/"], a[href*="weibo.com/n/"], a[usercard], a[href*="/u/"]');
      for (const a of links) {
        syncAnchorEl(a);
      }
    }
  }

  let lastHoverTarget = null;
  function onPointerOver(ev) {
    if (!bridgeEnabled) return;
    handleRouteMaybeChanged();
    const rawTarget = ev && ev.target;
    if (!rawTarget || rawTarget.nodeType !== 1) return;
    if (rawTarget === lastHoverTarget) return;
    lastHoverTarget = rawTarget;

    let a = rawTarget.closest ? rawTarget.closest('a[href^="/n/"], a[href*="weibo.com/n/"], a[usercard], a[href*="/u/"]') : null;
    if (a && ((a.getAttribute("href") || "").includes("bigFans") || (a.getAttribute("href") || "").includes("page.star.weibo.com"))) {
      a = null;
    }
    if (!a && rawTarget.closest) {
      const badgeHost = rawTarget.closest('a[href*="bigFans"], a[href*="page.star.weibo.com"], [class*="fans" i], .woo-badge');
      if (badgeHost) {
        let cur = badgeHost.previousSibling;
        let steps = 0;
        while (cur && steps < 4) {
          if (cur.nodeType === 3) {
            if (String(cur.textContent || "").trim()) break;
          } else if (cur.nodeType === 1) {
            if (cur.matches && cur.matches('a[href^="/n/"], a[href*="weibo.com/n/"], a[usercard], a[href*="/u/"]')) {
              const h = cur.getAttribute("href") || "";
              if (!h.includes("bigFans") && !h.includes("page.star.weibo.com")) {
                a = cur;
                break;
              }
            }
          }
          cur = cur.previousSibling;
          steps += 1;
        }
      }
    }
    if (a) {
      syncAnchorEl(a);
    }

    const sub = rawTarget.closest
      ? rawTarget.closest('.wbpro-list .list2 > .item2, .wbpro-list, .retweet, [class*="_retweet_"], [class*="Feed_retweet"], .vue-recycle-scroller__item-view, .wbpro-scroller-item, [class*="UserCard"], [class*="Repost"], [class*="_user_"]')
      : null;
    if (sub) {
      const vueUser = extractVueUserFromEl(sub);
      if (vueUser) {
        syncVueUserToEl(sub, vueUser);
      }
    }

    const card = rawTarget.closest ? rawTarget.closest('article, [class*="Feed_wrap"]') : null;
    if (card) {
      stampFeedCard(card);
    }
  }

  document.addEventListener("pointerover", onPointerOver, { capture: true, passive: true });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncLoginUidAttr, { once: true });
  } else {
    syncLoginUidAttr();
  }
})();
