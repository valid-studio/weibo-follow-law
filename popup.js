/* global WBRRadar */
(function () {
  "use strict";

  const Engine = window.WBRRadar;
  let currentState = Engine.defaultState();

  function sendMessage(msg) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ ok: false, error: "预览模式" });
        return;
      }
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(resp || { ok: false, error: "无响应" });
      });
    });
  }

  function setStatus(text) {
    const el = document.getElementById("wbr-pop-status");
    if (el) el.textContent = text;
  }

  function formatCooldownText(cb) {
    if (!cb || !cb.tripped) return "";
    const now = Date.now();
    const until = Number(cb.until) || 0;
    const remainMin = until > now ? Math.max(1, Math.ceil((until - now) / 60000)) : 1;
    return `请求有点快，休息冷却中（约 ${remainMin} 分钟后自动恢复，本地屏蔽仍正常生效）`;
  }

  function renderState(st) {
    currentState = Engine.normalizeState(st);
    const isEnabled = Boolean(currentState.enabled && currentState.enableMainSite);
    document.getElementById("wbr-opt-enabled").checked = isEnabled;
    document.getElementById("wbr-opt-chatsync").checked = currentState.enableChatSync;

    const manualBtn = document.getElementById("wbr-mode-manual");
    const autoBtn = document.getElementById("wbr-mode-auto");
    const modeDesc = document.getElementById("wbr-mode-desc");
    const isAuto = Boolean(currentState.autoScanViewport);
    if (manualBtn && autoBtn) {
      manualBtn.classList.toggle("is-active", !isAuto);
      manualBtn.setAttribute("aria-selected", !isAuto ? "true" : "false");
      autoBtn.classList.toggle("is-active", isAuto);
      autoBtn.setAttribute("aria-selected", isAuto ? "true" : "false");
    }
    if (modeDesc) {
      modeDesc.textContent = isAuto
        ? "浏览时自动快检当前屏幕内的陌生账号，仅对高倾向账号挂标提醒"
        : "默认省流零打扰：鼠标悬停用户名点「查成分」，或点击下方按钮按需扫描";
    }

    const dashBtn = document.getElementById("wbr-btn-dashboard");
    if (dashBtn) {
      dashBtn.textContent = `屏蔽名单 (${currentState.mutedUsers.length}) 与规则设置`;
    }

    const scanBtn = document.getElementById("wbr-btn-scan-page");
    if (scanBtn) {
      scanBtn.disabled = !isEnabled;
    }

    const accLine = document.getElementById("wbr-account-line");
    if (!isEnabled) {
      accLine.textContent = "已暂停保护";
    } else if (currentState.account && (currentState.account.screenName || currentState.account.uid)) {
      accLine.textContent = `已登录 @${currentState.account.screenName || "微博用户"} · 纯本地运行`;
    } else {
      accLine.textContent = "纯本地运行 · 待登录微博";
    }

    const alertBox = document.getElementById("wbr-breaker-alert");
    const alertText = document.getElementById("wbr-breaker-text");
    if (currentState.circuitBreaker && currentState.circuitBreaker.tripped) {
      alertBox.classList.remove("hidden");
      alertText.textContent = formatCooldownText(currentState.circuitBreaker);
    } else {
      alertBox.classList.add("hidden");
    }
  }

  async function persistPatch(patch) {
    const next = Engine.normalizeState({ ...currentState, ...patch });
    const resp = await sendMessage({ type: "WBR_SAVE_STATE", state: next });
    if (resp && resp.ok) {
      renderState(resp.state);
      setStatus("设置已保存并同步");
    }
  }

  function openDashboard() {
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.runtime && chrome.runtime.getURL) {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    } else {
      window.open("dashboard.html", "_blank");
    }
  }

  function sendScanViewportToActiveTab() {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.query || !chrome.tabs.sendMessage) {
        resolve({ ok: false, error: "当前为预览模式" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve({ ok: false, error: "请先切换到微博网页版标签页" });
          return;
        }
        const activeTab = Array.isArray(tabs) && tabs[0];
        if (!activeTab || typeof activeTab.id !== "number") {
          resolve({ ok: false, error: "请先切换到微博网页版标签页" });
          return;
        }
        chrome.tabs.sendMessage(activeTab.id, { type: "WBR_SCAN_CURRENT_VIEWPORT" }, (resp) => {
          if ((chrome.runtime && chrome.runtime.lastError) || !resp) {
            resolve({ ok: false, error: "请先切换到微博网页版标签页" });
            return;
          }
          resolve(resp);
        });
      });
    });
  }

  async function init() {
    const stResp = await sendMessage({ type: "WBR_GET_STATE" });
    renderState(stResp && stResp.state);

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "WBR_STATE_UPDATED" && msg.state) {
          renderState(msg.state);
        } else if (msg.type === "WBR_BREAKER_TRIPPED" && msg.circuitBreaker) {
          renderState({ ...currentState, circuitBreaker: msg.circuitBreaker });
        }
      });
    }

    const syncAge = Date.now() - (Number(currentState.viewerFollowingSyncedAt) || 0);
    const needDetect = !currentState.account || !currentState.account.uid || syncAge >= 12 * 60 * 60 * 1000;
    if (needDetect && (!currentState.circuitBreaker || !currentState.circuitBreaker.tripped)) {
      sendMessage({ type: "WBR_DETECT_ACCOUNT" }).then((accResp) => {
        if (accResp && accResp.ok && accResp.account) {
          renderState({ ...currentState, account: accResp.account });
        }
      });
    }

    document.getElementById("wbr-opt-enabled").addEventListener("change", (e) => {
      const checked = Boolean(e.target.checked);
      persistPatch({ enabled: checked, enableMainSite: checked });
    });
    document.getElementById("wbr-opt-chatsync").addEventListener("change", (e) => {
      persistPatch({ enableChatSync: e.target.checked });
    });

    document.getElementById("wbr-mode-manual").addEventListener("click", () => {
      if (currentState.autoScanViewport) {
        persistPatch({ autoScanViewport: false });
      }
    });
    document.getElementById("wbr-mode-auto").addEventListener("click", () => {
      if (!currentState.autoScanViewport) {
        persistPatch({ autoScanViewport: true });
      }
    });

    document.getElementById("wbr-btn-scan-page").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      setStatus("正在扫描当前屏幕可见用户...");
      const resp = await sendScanViewportToActiveTab();
      btn.disabled = !Boolean(currentState.enabled && currentState.enableMainSite);
      if (resp && resp.ok) {
        const count = Number(resp.queuedCount) || 0;
        setStatus(
          count > 0
            ? `已开始扫描本页 ${count} 位可见用户`
            : "当前屏幕内用户均已检测过"
        );
      } else {
        setStatus((resp && resp.error) || "请先切换到微博网页版标签页");
      }
    });

    document.getElementById("wbr-btn-dashboard").addEventListener("click", openDashboard);

    document.getElementById("wbr-btn-sync-blocklist").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      setStatus("正在同步微博黑名单...");
      const resp = await sendMessage({ type: "WBR_SYNC_BLOCKLIST" });
      btn.disabled = false;
      if (resp && resp.ok) {
        renderState(resp.state);
        setStatus(`同步完成：导入 ${resp.importedCount || 0} 人`);
      } else {
        setStatus((resp && resp.error) || "请先登录微博网页版再试");
      }
    });

    document.getElementById("wbr-btn-reset-breaker").addEventListener("click", async () => {
      const resp = await sendMessage({ type: "WBR_RESET_BREAKER" });
      if (resp && resp.ok) {
        renderState(resp.state);
        setStatus("已恢复正常查询");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
