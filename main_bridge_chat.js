/**
 * MAIN world bridge for Weibo Web Chat (api.weibo.com/chat* & /webim/*)
 * Binds message sender metadata via data-wbr-uid / data-wbr-uname / data-wbr-self attributes.
 * Zero inline scripts, 100% MV3 CSP compliant.
 */
(function () {
  "use strict";

  if (window.__wbrChatBridgeLoaded) return;
  window.__wbrChatBridgeLoaded = true;

  const msgMetaByMid = new Map();

  function recordApiMessages(data) {
    if (!data || typeof data !== "object") return;
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    for (const m of msgs) {
      if (!m || !m.id) continue;
      const mid = String(m.id);
      const fu = m.from_user || {};
      const uid = String(m.from_uid || fu.idstr || fu.id || "").trim();
      const screenName = String(fu.screen_name || fu.name || "").trim();
      if (uid || screenName) {
        msgMetaByMid.set(mid, { uid, screenName });
      }
    }
    if (msgs.length > 0) {
      setTimeout(enrichChatDom, 60);
    }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (_method, url) {
    this.__wbrUrl = typeof url === "string" ? url : "";
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__wbrUrl && this.__wbrUrl.includes("query_messages.json")) {
      this.addEventListener("load", () => {
        try {
          const parsed = JSON.parse(this.responseText);
          recordApiMessages(parsed);
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  function extractVueMetaFromElement(li) {
    const candidates = [li];
    const children = li.querySelectorAll("*");
    for (let i = 0; i < Math.min(children.length, 15); i += 1) {
      if (children[i].__vue__) {
        candidates.push(children[i]);
      }
    }
    for (const node of candidates) {
      const vm = node && node.__vue__;
      if (!vm) continue;
      const card = vm.cardobj || (vm.$props && vm.$props.cardobj);
      if (card && typeof card === "object") {
        const ui = card.userinfo || card.from_user || {};
        const uid = String(card.from_uid || ui.idstr || ui.id || "").trim();
        const screenName = String(ui.screen_name || ui.name || "").trim();
        const isSelf = Boolean(card.direct === "right");
        if (uid || screenName) {
          return { uid, screenName, isSelf };
        }
      }
    }
    return null;
  }

  function enrichChatDom() {
    const items = document.querySelectorAll("ul.chat-content > li[id], .message-wrapper li[id]");
    for (const li of items) {
      if (li.getAttribute("data-wbr-uid")) continue;
      const mid = li.id ? String(li.id) : "";
      const meta = extractVueMetaFromElement(li) || (mid && msgMetaByMid.get(mid));
      if (!meta) continue;
      if (meta.uid) li.setAttribute("data-wbr-uid", meta.uid);
      if (meta.screenName) li.setAttribute("data-wbr-uname", meta.screenName);
      if (meta.isSelf) li.setAttribute("data-wbr-self", "1");
    }
  }

  let timer = null;
  function scheduleEnrich() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        enrichChatDom();
      } catch (_) {}
    }, 100);
  }

  const mo = new MutationObserver(() => scheduleEnrich());
  const start = () => {
    if (document.body) {
      mo.observe(document.body, { childList: true, subtree: true });
      scheduleEnrich();
    } else {
      setTimeout(start, 100);
    }
  };
  start();
})();
