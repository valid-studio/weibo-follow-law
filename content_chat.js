/* global WBRRadar */
(function (root, factory) {
  const api = factory(
    root.WBRRadar || (typeof require === "function" ? require("./shared/radar_engine.js") : null)
  );
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.WBRChatContent = api;
    if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) {
      api.bootChromeChat();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function (Engine) {
  "use strict";

  function parseGroupDisplayName(rawText) {
    const clean = Engine.normalizeText(rawText);
    if (!clean) return { groupNick: "", originName: "" };
    const m = clean.match(/^(.+?)\(([^()]+)\)$/);
    if (m) {
      return {
        groupNick: Engine.normalizeText(m[1]),
        originName: Engine.normalizeText(m[2])
      };
    }
    return { groupNick: "", originName: clean };
  }

  function createChatInjector(deps = {}) {
    const doc = deps.document || document;
    const sendMessage =
      deps.sendMessage ||
      ((msg) =>
        new Promise((resolve) => {
          let settled = false;
          const finish = (res) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(res);
          };
          const timer = setTimeout(() => finish({ ok: false, error: "Request timeout" }), 15000);
          try {
            chrome.runtime.sendMessage(msg, (resp) => {
              void (chrome.runtime && chrome.runtime.lastError);
              finish(resp || { ok: false });
            });
          } catch (err) {
            finish({ ok: false, error: err && err.message ? err.message : "Runtime error" });
          }
        }));

    let state = Engine.normalizeState(deps.initialState || {});
    let scanTimer = null;
    let isApplyingDom = false;
    let activeObserver = null;

    function extractSenderFromLi(li) {
      const uid = Engine.normalizeUid(li.getAttribute("data-wbr-uid"));
      let uname = Engine.normalizeText(li.getAttribute("data-wbr-uname"));
      const isSelf =
        li.getAttribute("data-wbr-self") === "1" || Boolean(li.querySelector(".message-item.mine"));

      let nameEl = li.querySelector(".message-box span.name, span.name");
      if (!uname && nameEl) {
        const clone = nameEl.cloneNode(true);
        for (const icon of clone.querySelectorAll(".icon-area, .wbr-chat-mute-btn, [data-wbh-ui='1'], .wbh-quick-star, .wbh-badge")) {
          icon.remove();
        }
        const parsed = parseGroupDisplayName(clone.textContent);
        uname = parsed.originName || parsed.groupNick;
      }

      return { uid, screenName: uname, isSelf, nameEl };
    }

    function setChatChildrenCollapsed(li, collapsed) {
      for (const child of Array.from(li.children)) {
        if (child.classList.contains("wbr-chat-muted-bar")) continue;
        // Keep hidden message id div untouched, collapse visible message/time/notice wrappers
        if (collapsed) {
          child.classList.add("wbr-collapsed-child");
        } else {
          child.classList.remove("wbr-collapsed-child");
        }
      }
    }

    function applyToChatDom() {
      isApplyingDom = true;
      try {
        const items = doc.querySelectorAll("ul.chat-content > li[id], .message-wrapper li[id]");
        const active = Boolean(state.enabled && state.enableChatSync);

        for (const li of items) {
          const existingBar = li.querySelector(':scope > .wbr-chat-muted-bar[data-wbr-chat-bar="1"]');

          if (!active) {
            li.classList.remove("wbr-hidden-node");
            li.removeAttribute("data-wbr-chat-hidden");
            setChatChildrenCollapsed(li, false);
            if (existingBar) existingBar.remove();
            continue;
          }

          const sender = extractSenderFromLi(li);
          if (sender.isSelf) continue;

          const muted = Engine.findMutedMatch(sender, state);
          if (muted) {
            if (muted.mode === "hide") {
              if (existingBar) existingBar.remove();
              li.classList.add("wbr-hidden-node");
              li.setAttribute("data-wbr-chat-hidden", "1");
            } else {
              li.classList.remove("wbr-hidden-node");
              li.removeAttribute("data-wbr-chat-hidden");
              const expanded = li.getAttribute("data-wbr-chat-expanded") === "1";
              setChatChildrenCollapsed(li, !expanded);

              const displayTarget = `@${sender.screenName || muted.screenName || sender.uid}`;
              if (!existingBar) {
                const bar = doc.createElement("div");
                bar.className = "wbr-chat-muted-bar";
                bar.setAttribute("data-wbr-chat-bar", "1");

                const txt = doc.createElement("span");
                txt.className = "wbr-chat-muted-text";
                txt.textContent = `已收起 ${displayTarget} 的发言`;

                const acts = doc.createElement("span");
                acts.className = "wbr-muted-banner-actions";

                const toggleBtn = doc.createElement("button");
                toggleBtn.type = "button";
                toggleBtn.className = "wbr-link-btn";
                toggleBtn.textContent = expanded ? "重新收起" : "看一眼";
                toggleBtn.addEventListener("click", (ev) => {
                  ev.stopPropagation();
                  ev.preventDefault();
                  const cur = li.getAttribute("data-wbr-chat-expanded") === "1";
                  li.setAttribute("data-wbr-chat-expanded", cur ? "0" : "1");
                  applyToChatDom();
                });

                const unmuteBtn = doc.createElement("button");
                unmuteBtn.type = "button";
                unmuteBtn.className = "wbr-link-btn wbr-link-btn-muted";
                unmuteBtn.textContent = "取消屏蔽";
                unmuteBtn.addEventListener("click", async (ev) => {
                  ev.stopPropagation();
                  ev.preventDefault();
                  const s = extractSenderFromLi(li);
                  const resp = await sendMessage({
                    type: "WBR_UNMUTE_USER",
                    user: { uid: s.uid, screenName: s.screenName || muted.screenName }
                  });
                  if (resp && resp.ok && resp.state) {
                    state = Engine.normalizeState(resp.state);
                    applyToChatDom();
                  }
                });

                acts.append(toggleBtn, unmuteBtn);
                bar.append(txt, acts);
                li.prepend(bar);
              } else {
                const txt = existingBar.querySelector(".wbr-chat-muted-text");
                if (txt) txt.textContent = `已收起 ${displayTarget} 的发言`;
                const btn = existingBar.querySelector(".wbr-link-btn");
                if (btn) btn.textContent = expanded ? "重新收起" : "看一眼";
              }
            }
          } else {
            li.classList.remove("wbr-hidden-node");
            li.removeAttribute("data-wbr-chat-hidden");
            setChatChildrenCollapsed(li, false);
            if (existingBar) existingBar.remove();
          }

          // Subtle hover-only [屏蔽] micro-button
          const hostBox = sender.nameEl || li.querySelector(".message-box");
          if (hostBox) {
            let btn = hostBox.querySelector(".wbr-chat-mute-btn");
            if (!btn) {
              btn = doc.createElement("button");
              btn.type = "button";
              btn.className = "wbr-chat-mute-btn";
              btn.setAttribute("data-wbr-chat-mute", "1");
              btn.textContent = "屏蔽";
              btn.title = "以后折叠TA的发言和微博（仅自己可见）";
              btn.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                const curSender = extractSenderFromLi(li);
                const resp = await sendMessage({
                  type: "WBR_MUTE_USER",
                  user: {
                    uid: curSender.uid,
                    screenName: curSender.screenName,
                    source: "manual",
                    reason: "群聊快捷屏蔽"
                  }
                });
                if (resp && resp.ok && resp.state) {
                  state = Engine.normalizeState(resp.state);
                  applyToChatDom();
                }
              });
              hostBox.appendChild(btn);
            }
          }
        }
      } finally {
        if (activeObserver && typeof activeObserver.takeRecords === "function") {
          activeObserver.takeRecords();
        }
        isApplyingDom = false;
      }
    }

    function scheduleScan() {
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        applyToChatDom();
      }, 150);
    }

    function setState(nextState) {
      state = Engine.normalizeState(nextState || {});
      applyToChatDom();
    }

    function isPluginOwnedNode(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.id && (node.id.startsWith("wbh-") || node.id.startsWith("wbr-"))) return true;
      if (node.classList) {
        for (const c of node.classList) {
          if (c.startsWith("wbr-") || c.startsWith("wbh-")) return true;
        }
      }
      if (node.attributes) {
        for (const a of node.attributes) {
          if (a.name.startsWith("data-wbr-") || a.name.startsWith("data-wbh-")) return true;
        }
      }
      return false;
    }

    function startObserver() {
      if (!doc.body) return null;
      const mo = new MutationObserver((mutations) => {
        if (isApplyingDom) return;
        const external = mutations.some((m) => {
          const t = m.target;
          if (t && t.closest && t.closest(".wbr-chat-muted-bar, #wbh-toolbar, #wbh-nav-drawer, #wbh-toast")) {
            return false;
          }
          const changed = [...(m.addedNodes || []), ...(m.removedNodes || [])];
          if (changed.length > 0 && changed.every(isPluginOwnedNode)) {
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
      applyToChatDom,
      scheduleScan,
      setState,
      startObserver,
      getState: () => state
    };
  }

  async function bootChromeChat() {
    const sendMessage = (msg) =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(res);
        };
        const timer = setTimeout(() => finish({ ok: false, error: "Request timeout" }), 15000);
        try {
          chrome.runtime.sendMessage(msg, (resp) => {
            void (chrome.runtime && chrome.runtime.lastError);
            finish(resp || { ok: false });
          });
        } catch (err) {
          finish({ ok: false, error: err && err.message ? err.message : "Runtime error" });
        }
      });
    const initResp = await sendMessage({ type: "WBR_GET_STATE" });
    const injector = createChatInjector({
      initialState: initResp && initResp.state,
      sendMessage
    });
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "WBR_STATE_UPDATED" && msg.state) {
        injector.setState(msg.state);
      }
    });
    injector.applyToChatDom();
    injector.startObserver();
  }

  return { createChatInjector, bootChromeChat, parseGroupDisplayName };
});
