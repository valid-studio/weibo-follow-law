/* global WBRRadar */
(function () {
  "use strict";

  const Engine = window.WBRRadar;
  let state = Engine.defaultState();
  let scanResults = [];
  const rowStatusMap = new Map();
  let toastTimer = null;

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

  function showToast(text, isError = false) {
    const el = document.getElementById("wbr-dash-toast");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", Boolean(isError));
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add("hidden");
    }, isError ? 4200 : 2600);
  }

  function formatCooldownText(cb) {
    if (!cb || !cb.tripped) return "";
    const now = Date.now();
    const until = Number(cb.until) || 0;
    const remainMin = until > now ? Math.max(1, Math.ceil((until - now) / 60000)) : 1;
    return `请求有点快，休息冷却中（约 ${remainMin} 分钟后自动恢复，本地屏蔽仍正常生效）`;
  }

  function sourceLabel(src) {
    if (src === "weibo_block") return "微博黑名单";
    if (src === "radar_queue") return "批量排查";
    return "手动屏蔽";
  }

  function setProgressUi(active, processed, total, highCount, textOverride = "") {
    const wrap = document.getElementById("wbr-scan-progress-wrap");
    const fill = document.getElementById("wbr-scan-progress-fill");
    const textEl = document.getElementById("wbr-scan-progress-text");
    if (wrap) wrap.classList.toggle("is-active", Boolean(active));
    if (fill) {
      const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
      fill.style.width = `${pct}%`;
    }
    if (textEl) {
      if (textOverride) {
        textEl.textContent = textOverride;
      } else if (active) {
        textEl.textContent = `正在查看第 ${processed}/${total} 位，已发现 ${highCount} 位高倾向账号`;
      } else {
        textEl.textContent = "就绪";
      }
    }
  }

  function renderHeaderAndBreaker() {
    const accEl = document.getElementById("wbr-dash-account");
    if (state.account && (state.account.screenName || state.account.uid)) {
      accEl.textContent = `已登录 @${state.account.screenName || "微博用户"}`;
    } else {
      accEl.textContent = "未登录微博网页版（本地屏蔽仍正常生效）";
    }

    const brEl = document.getElementById("wbr-dash-breaker");
    const brText = document.getElementById("wbr-dash-breaker-text");
    if (state.circuitBreaker && state.circuitBreaker.tripped) {
      brEl.classList.remove("hidden");
      brText.textContent = formatCooldownText(state.circuitBreaker);
    } else {
      brEl.classList.add("hidden");
    }
  }

  function renderMutedTable() {
    const tbody = document.getElementById("wbr-muted-tbody");
    const query = Engine.normalizeKey(document.getElementById("wbr-muted-search").value);
    const srcFilter = document.getElementById("wbr-muted-source-filter").value;
    document.getElementById("wbr-muted-total").textContent = String(state.mutedUsers.length);

    const list = state.mutedUsers.filter((item) => {
      if (srcFilter !== "all" && item.source !== srcFilter) return false;
      if (query) {
        const hay = `${Engine.normalizeKey(item.screenName)} ${Engine.normalizeKey(item.reason)}`;
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    tbody.innerHTML = "";
    if (list.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">暂无匹配的屏蔽账号</td>`;
      tbody.appendChild(tr);
      return;
    }

    for (const item of list) {
      const tr = document.createElement("tr");

      const tdUser = document.createElement("td");
      tdUser.textContent = `@${item.screenName || "微博用户"}`;

      const tdMode = document.createElement("td");
      const modeSel = document.createElement("select");
      modeSel.className = "wbr-select";
      modeSel.innerHTML = `<option value="collapse">收起为一行提示</option><option value="hide">直接完全隐藏</option>`;
      modeSel.value = item.mode;
      modeSel.addEventListener("change", async () => {
        const next = Engine.upsertMutedUser(state, { ...item, mode: modeSel.value });
        await saveState(next);
        showToast("已更新屏蔽显示方式");
      });
      tdMode.appendChild(modeSel);

      const tdSource = document.createElement("td");
      tdSource.textContent = sourceLabel(item.source);

      const tdReason = document.createElement("td");
      tdReason.textContent = item.reason || "-";

      const tdAct = document.createElement("td");
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "wbr-btn wbr-btn-sm";
      rmBtn.textContent = "取消屏蔽";
      rmBtn.addEventListener("click", async () => {
        const resp = await sendMessage({
          type: "WBR_UNMUTE_USER",
          user: { key: item.key, uid: item.uid, screenName: item.screenName }
        });
        if (resp && resp.ok) {
          state = Engine.normalizeState(resp.state);
          renderAll();
          showToast(`已取消屏蔽 @${item.screenName || "该用户"}`);
        }
      });
      tdAct.appendChild(rmBtn);

      tr.append(tdUser, tdMode, tdSource, tdReason, tdAct);
      tbody.appendChild(tr);
    }
  }

  function renderScanTable() {
    const tbody = document.getElementById("wbr-scan-tbody");
    const minHit = Number(document.getElementById("wbr-min-hit-filter").value) || 0;
    const rows = scanResults.filter((r) => (r.hitCount || 0) >= minHit);

    tbody.innerHTML = "";
    if (rows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="7" style="text-align:center;color:#94a3b8;padding:24px;">暂无排查记录，点击上方按钮开始排查</td>`;
      tbody.appendChild(tr);
      return;
    }

    for (const r of rows) {
      const tr = document.createElement("tr");
      const rowKey = r.uid || Engine.normalizeKey(r.screenName);

      const tdCb = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "wbr-scan-row-cb";
      cb.dataset.uid = r.uid || "";
      cb.dataset.name = r.screenName || "";
      cb.dataset.hit = String(r.hitCount || 0);
      cb.dataset.score = String(r.score ?? r.hitCount ?? 0);
      cb.dataset.level = r.level || "low";
      cb.checked = false;
      tdCb.appendChild(cb);

      const tdUser = document.createElement("td");
      tdUser.textContent = `@${r.screenName || "微博用户"}`;

      const tdLevel = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = `wbr-pill wbr-pill-${r.level === "high" ? "high" : r.level === "warn" ? "warn" : "low"}`;
      if (r.exemptReason) {
        pill.textContent = `已免标警 (${r.hitCount || 0}位)`;
        pill.title = r.exemptReason === "following"
          ? "您已关注的账号"
          : r.exemptReason === "org_verified"
            ? "官方认证机构蓝V"
            : "本人账号";
      } else if (r.hiddenFollowing) {
        pill.textContent = "已隐藏关注";
      } else if (!r.hitCount || r.hitCount <= 0) {
        pill.textContent = "未发现明显倾向";
      } else if (r.level === "low") {
        pill.textContent = `未达预警 (${r.hitCount}位)`;
        pill.title = `加权得分 ${r.score ?? 0}`;
      } else {
        const prob = r.probability || Engine.computeProbabilityFromScore(r.score ?? r.hitCount, r.hitCount);
        pill.textContent = r.level === "high"
          ? `定律 ${prob}% (${r.hitCount}位)`
          : `倾向 ${prob}% (${r.hitCount}位)`;
        pill.title = `加权得分 ${r.score ?? r.hitCount}`;
      }
      tdLevel.appendChild(pill);

      const tdCats = document.createElement("td");
      const cats = Object.entries(r.categoryCounts || {})
        .filter(([, c]) => c > 0)
        .map(([cid, c]) => `${(Engine.CATEGORY_META[cid] && Engine.CATEGORY_META[cid].shortLabel) || cid} ${c}`)
        .join("、");
      tdCats.textContent = cats || "-";

      const tdHits = document.createElement("td");
      const hitNames = (r.hitItems || []).map((x) => {
        if (x.sharedWithViewer) {
          return x.sharedExempt ? `${x.name}(共同免计)` : `${x.name}(您也关注)`;
        }
        return x.name;
      });
      tdHits.textContent = hitNames.slice(0, 8).join("、") || "-";
      if (hitNames.length > 0) {
        tdHits.title = hitNames.join("、");
      }

      const tdSnippet = document.createElement("td");
      tdSnippet.textContent = r.snippet || "-";

      const tdStatus = document.createElement("td");
      const stInfo = rowStatusMap.get(rowKey);
      if (stInfo) {
        const stPill = document.createElement("span");
        stPill.className = `wbr-pill ${stInfo.ok ? "wbr-pill-ok" : "wbr-pill-fail"}`;
        stPill.textContent = stInfo.text;
        tdStatus.appendChild(stPill);
      } else {
        tdStatus.textContent = "-";
      }

      tr.append(tdCb, tdUser, tdLevel, tdCats, tdHits, tdSnippet, tdStatus);
      tbody.appendChild(tr);
    }
  }

  function syncPresetCardsHighlight() {
    const activePreset = Engine.detectSensitivityPreset(state);
    for (const card of document.querySelectorAll("#wbr-preset-grid .wbr-preset-card")) {
      card.classList.toggle("is-selected", card.dataset.preset === activePreset);
    }
    const customBadge = document.getElementById("wbr-custom-preset-badge");
    if (customBadge) {
      customBadge.classList.toggle("hidden", activePreset !== "custom");
    }
  }

  function renderFeatureSettings() {
    syncPresetCardsHighlight();
    document.getElementById("wbr-cfg-warn").value = String(state.warnThreshold);
    document.getElementById("wbr-cfg-high").value = String(state.highThreshold);
    const scanSel = document.getElementById("wbr-cfg-scan-pages");
    if (scanSel) {
      const v = String(state.followScanMaxPages);
      if (Array.from(scanSel.options).some((opt) => opt.value === v)) {
        scanSel.value = v;
      } else {
        scanSel.value = "9";
      }
    }
    document.getElementById("wbr-cfg-cache-days").value = String(state.cacheTtlDays);
    document.getElementById("wbr-cfg-default-mode").value = state.muteDefaultMode;
    document.getElementById("wbr-cfg-exempt-followed").checked = state.exemptFollowedUsers;
    const strictSharedEl = document.getElementById("wbr-cfg-strict-shared");
    if (strictSharedEl) strictSharedEl.checked = Boolean(state.strictSharedExemption);
    document.getElementById("wbr-cfg-confirm-block").checked = state.confirmBeforeBlock;
    document.getElementById("wbr-cfg-hover-auto").checked = state.hoverAutoCheck;
    document.getElementById("wbr-cfg-autoscan").checked = state.autoScanViewport;
    document.getElementById("wbr-cfg-cleancheck").checked = state.showCleanCheckmark;

    const catWrap = document.getElementById("wbr-category-switches");
    catWrap.innerHTML = "";
    for (const cid of Object.keys(Engine.CATEGORY_META)) {
      const meta = Engine.CATEGORY_META[cid];
      const lbl = document.createElement("label");
      lbl.className = "wbr-cat-toggle";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Boolean(state.enabledCategories[cid]);
      cb.addEventListener("change", async () => {
        const next = Engine.normalizeState({
          ...state,
          enabledCategories: { ...state.enabledCategories, [cid]: cb.checked }
        });
        await saveState(next);
        showToast(`已${cb.checked ? "开启" : "关闭"}「${meta.label}」`);
      });
      const span = document.createElement("span");
      span.textContent = meta.label;
      lbl.append(cb, span);
      catWrap.appendChild(lbl);
    }

    const wlWrap = document.getElementById("wbr-wl-chips");
    wlWrap.innerHTML = "";
    for (const name of state.baselineExclusions) {
      const chip = document.createElement("span");
      chip.className = "wbr-chip";
      chip.textContent = name;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "×";
      rm.addEventListener("click", async () => {
        const next = Engine.normalizeState({
          ...state,
          baselineExclusions: state.baselineExclusions.filter((x) => x !== name)
        });
        await saveState(next);
        showToast(`已从跳过列表移除 ${name}`);
      });
      chip.appendChild(rm);
      wlWrap.appendChild(chip);
    }

    const featSelect = document.getElementById("wbr-feat-cat");
    featSelect.innerHTML = "";
    for (const cid of Object.keys(Engine.CATEGORY_META)) {
      const opt = document.createElement("option");
      opt.value = cid;
      opt.textContent = Engine.CATEGORY_META[cid].label;
      featSelect.appendChild(opt);
    }

    const matrixWrap = document.getElementById("wbr-feature-matrix-list");
    matrixWrap.innerHTML = "";
    const disabledSet = new Set(state.disabledFeatureIds || []);
    const allEntries = [
      ...Engine.DEFAULT_FEATURE_MATRIX.map((x) => ({ ...x, isCustom: false })),
      ...(state.customFeatures || []).map((x) => ({ ...x, isCustom: true }))
    ];
    for (const entry of allEntries) {
      const box = document.createElement("div");
      box.className = "wbr-matrix-item";
      const left = document.createElement("label");
      left.className = "wbr-inline-label";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !disabledSet.has(entry.id);
      cb.addEventListener("change", async () => {
        const nextSet = new Set(state.disabledFeatureIds || []);
        if (cb.checked) nextSet.delete(entry.id);
        else nextSet.add(entry.id);
        await saveState(Engine.normalizeState({ ...state, disabledFeatureIds: Array.from(nextSet) }));
      });
      const catShort = (Engine.CATEGORY_META[entry.category] && Engine.CATEGORY_META[entry.category].shortLabel) || entry.category;
      const txt = document.createElement("span");
      txt.textContent = `${entry.screenName} · ${catShort} · w=${entry.weight ?? 1}`;
      txt.title = entry.note ? `${entry.screenName}（${entry.note}）` : entry.screenName;
      left.append(cb, txt);
      box.appendChild(left);

      const isCoreEntry = entry.category !== "stock" && Number(entry.weight) >= 0.85;
      if (entry.isCustom) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "wbr-btn wbr-btn-sm";
        del.textContent = "删除";
        del.addEventListener("click", async () => {
          const nextCustom = (state.customFeatures || []).filter((x) => x.id !== entry.id);
          await saveState(Engine.normalizeState({ ...state, customFeatures: nextCustom }));
          showToast(`已删除 ${entry.screenName}`);
        });
        box.appendChild(del);
      } else {
        const tier = document.createElement("span");
        tier.className = `wbr-tier-tag ${isCoreEntry ? "wbr-tier-core" : "wbr-tier-pan"}`;
        tier.textContent = isCoreEntry ? "核心" : "伴生";
        box.appendChild(tier);
      }
      matrixWrap.appendChild(box);
    }
  }

  function renderAll() {
    renderHeaderAndBreaker();
    renderMutedTable();
    renderScanTable();
    renderFeatureSettings();
  }

  async function saveState(next) {
    const resp = await sendMessage({ type: "WBR_SAVE_STATE", state: next });
    if (resp && resp.ok && resp.state) {
      state = Engine.normalizeState(resp.state);
      renderAll();
    }
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function bindTabs() {
    const tabs = document.querySelectorAll(".wbr-tab");
    const activateTab = (tabName) => {
      const target = document.getElementById(`tab-${tabName}`);
      if (!target) return;
      for (const t of tabs) {
        t.classList.toggle("active", t.dataset.tab === tabName);
      }
      for (const p of document.querySelectorAll(".wbr-panel")) {
        p.classList.toggle("active", p === target);
      }
    };
    for (const btn of tabs) {
      btn.addEventListener("click", () => {
        activateTab(btn.dataset.tab);
      });
    }
    const initialHash = (window.location.hash || "").replace(/^#/, "");
    if (initialHash) {
      activateTab(initialHash);
    }
  }

  async function runTargetScan(users) {
    if (!Array.isArray(users) || users.length === 0) {
      setProgressUi(false, 0, 0, 0, "没有找到可排查的陌生用户");
      return;
    }
    rowStatusMap.clear();
    document.getElementById("wbr-stop-scan-btn").classList.remove("hidden");
    setProgressUi(true, 0, users.length, 0);

    const resp = await sendMessage({
      type: "WBR_RUN_BATCH_SCAN",
      users,
      delayMs: 2200
    });
    document.getElementById("wbr-stop-scan-btn").classList.add("hidden");

    if (resp && Array.isArray(resp.results)) {
      scanResults = resp.results;
      renderScanTable();
    }
    const highCount = scanResults.filter((r) => r.level === "high").length;
    if (!resp || !resp.ok || resp.breakerTripped) {
      const errText = (resp && (resp.breakerError || resp.error)) || "排查已暂停";
      setProgressUi(false, scanResults.length, users.length, highCount, errText);
      showToast(errText, true);
    } else {
      setProgressUi(
        false,
        scanResults.length,
        users.length,
        highCount,
        `已完成 ${scanResults.length} 位排查，发现 ${highCount} 位高倾向账号`
      );
      showToast(`排查完成，共 ${scanResults.length} 人`);
    }
  }

  async function init() {
    bindTabs();
    const stResp = await sendMessage({ type: "WBR_GET_STATE" });
    state = Engine.normalizeState(stResp && stResp.state);
    renderAll();

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      let highSeen = 0;
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "WBR_STATE_UPDATED" && msg.state) {
          state = Engine.normalizeState(msg.state);
          renderAll();
        } else if (msg.type === "WBR_BATCH_PROGRESS") {
          if (msg.processed === 1) highSeen = 0;
          if (msg.result && msg.result.level === "high") highSeen += 1;
          setProgressUi(true, msg.processed, msg.total, highSeen);
        } else if (msg.type === "WBR_BREAKER_TRIPPED" && msg.circuitBreaker) {
          state.circuitBreaker = msg.circuitBreaker;
          renderHeaderAndBreaker();
        }
      });
    }

    if (!state.circuitBreaker || !state.circuitBreaker.tripped) {
      sendMessage({ type: "WBR_DETECT_ACCOUNT" }).then((accResp) => {
        if (accResp && accResp.ok && accResp.account) {
          state.account = accResp.account;
          renderHeaderAndBreaker();
        }
      });
    }

    document.getElementById("wbr-dash-reset-breaker").addEventListener("click", async () => {
      const resp = await sendMessage({ type: "WBR_RESET_BREAKER" });
      if (resp && resp.ok) {
        state = Engine.normalizeState(resp.state);
        renderAll();
        showToast("已恢复正常查询");
      }
    });

    // Tab 1 events
    document.getElementById("wbr-muted-search").addEventListener("input", renderMutedTable);
    document.getElementById("wbr-muted-source-filter").addEventListener("change", renderMutedTable);

    document.getElementById("wbr-add-mute-btn").addEventListener("click", async () => {
      const raw = Engine.normalizeText(document.getElementById("wbr-add-mute-input").value);
      const mode = document.getElementById("wbr-add-mute-mode").value;
      if (!raw) {
        showToast("请先输入微博昵称", true);
        return;
      }
      const isUid = /^\d{5,15}$/.test(raw);
      const resp = await sendMessage({
        type: "WBR_MUTE_USER",
        user: {
          uid: isUid ? raw : "",
          screenName: isUid ? "" : raw,
          mode,
          source: "manual",
          reason: "手动添加屏蔽"
        }
      });
      if (resp && resp.ok) {
        document.getElementById("wbr-add-mute-input").value = "";
        state = Engine.normalizeState(resp.state);
        renderAll();
        showToast(`已屏蔽 @${raw}`);
      }
    });

    document.getElementById("wbr-sync-official").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const resp = await sendMessage({ type: "WBR_SYNC_BLOCKLIST" });
      btn.disabled = false;
      if (resp && resp.ok) {
        state = Engine.normalizeState(resp.state);
        renderAll();
        showToast(`已同步微博黑名单 ${resp.importedCount || 0} 人`);
      } else {
        showToast((resp && resp.error) || "同步失败，请先打开微博网页版重试", true);
      }
    });

    document.getElementById("wbr-export-muted").addEventListener("click", () => {
      downloadJson("weibo-radar-muted.json", { exportedAt: new Date().toISOString(), mutedUsers: state.mutedUsers });
      showToast("已导出屏蔽名单");
    });

    document.getElementById("wbr-import-muted-file").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const items = Array.isArray(parsed) ? parsed : (parsed.mutedUsers || []);
        let next = state;
        for (const item of items) {
          next = Engine.upsertMutedUser(next, item);
        }
        await saveState(next);
        showToast(`已导入 ${items.length} 条屏蔽记录`);
      } catch (_) {
        showToast("文件格式不对，导入失败", true);
      }
      e.target.value = "";
    });

    // Tab 2 events
    document.getElementById("wbr-scan-post-btn").addEventListener("click", async (e) => {
      const urlOrId = Engine.normalizeText(document.getElementById("wbr-post-url-input").value);
      if (!urlOrId) {
        showToast("请先贴入微博网页链接", true);
        return;
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      setProgressUi(true, 0, 1, 0, "正在读取该条微博的评论和转发列表...");
      const resp = await sendMessage({ type: "WBR_FETCH_POST_INTERACTORS", urlOrId, maxPages: 2 });
      btn.disabled = false;
      const users = (resp && resp.data && resp.data.users) || (resp && resp.users) || [];
      if (!resp || !resp.ok) {
        const err = (resp && resp.error) || "读取失败，请确认链接有效且已登录微博";
        setProgressUi(false, 0, 0, 0, err);
        showToast(err, true);
        return;
      }
      await runTargetScan(users);
    });

    document.getElementById("wbr-scan-self-btn").addEventListener("click", async (e) => {
      const maxPosts = Number(document.getElementById("wbr-self-posts-limit").value) || 5;
      const btn = e.currentTarget;
      btn.disabled = true;
      setProgressUi(true, 0, 1, 0, "正在读取最近微博评论区里的陌生人...");
      const resp = await sendMessage({ type: "WBR_FETCH_SELF_INTERACTORS", postCount: maxPosts });
      btn.disabled = false;
      const users = (resp && resp.data && resp.data.users) || (resp && resp.users) || [];
      if (!resp || !resp.ok) {
        const err = (resp && resp.error) || "读取失败，请确认已登录微博";
        setProgressUi(false, 0, 0, 0, err);
        showToast(err, true);
        return;
      }
      await runTargetScan(users);
    });

    document.getElementById("wbr-stop-scan-btn").addEventListener("click", async () => {
      await sendMessage({ type: "WBR_STOP_BATCH" });
      document.getElementById("wbr-stop-scan-btn").classList.add("hidden");
      setProgressUi(false, 0, 0, 0, "已停止排查");
      showToast("已停止排查");
    });

    document.getElementById("wbr-min-hit-filter").addEventListener("input", renderScanTable);

    document.getElementById("wbr-check-all-rows").addEventListener("change", (e) => {
      for (const cb of document.querySelectorAll(".wbr-scan-row-cb")) {
        cb.checked = e.target.checked;
      }
    });

    document.getElementById("wbr-select-high-btn").addEventListener("click", () => {
      for (const cb of document.querySelectorAll(".wbr-scan-row-cb")) {
        cb.checked = cb.dataset.level === "high";
      }
    });

    document.getElementById("wbr-clear-select-btn").addEventListener("click", () => {
      document.getElementById("wbr-check-all-rows").checked = false;
      for (const cb of document.querySelectorAll(".wbr-scan-row-cb")) {
        cb.checked = false;
      }
    });

    document.getElementById("wbr-exec-cleanup-btn").addEventListener("click", async (e) => {
      const action = document.getElementById("wbr-cleanup-action-select").value;
      const items = [];
      for (const cb of document.querySelectorAll(".wbr-scan-row-cb")) {
        if (!cb.checked) continue;
        items.push({ uid: cb.dataset.uid, screenName: cb.dataset.name, action });
      }
      if (items.length === 0) {
        showToast("请先勾选要处理的用户", true);
        return;
      }
      if (items.length > 30) {
        showToast("为保护微博账号安全，单次最多勾选 30 人，请分批处理", true);
        return;
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      const resp = await sendMessage({ type: "WBR_RUN_CLEANUP_QUEUE", items });
      btn.disabled = false;

      if (resp && Array.isArray(resp.logs)) {
        for (const l of resp.logs) {
          const k = l.uid || Engine.normalizeKey(l.screenName);
          if (k) rowStatusMap.set(k, { ok: Boolean(l.ok), text: l.message });
        }
      }
      const stResp = await sendMessage({ type: "WBR_GET_STATE" });
      if (stResp && stResp.ok && stResp.state) {
        state = Engine.normalizeState(stResp.state);
      }
      renderAll();
      if (resp && resp.ok) {
        showToast(`已处理 ${resp.executed} 人`);
      } else {
        showToast((resp && resp.error) || "部分处理未完成", true);
      }
    });

    // Tab 3 events: Layer 1 Presets & Preferences
    for (const card of document.querySelectorAll("#wbr-preset-grid .wbr-preset-card")) {
      card.addEventListener("click", async () => {
        const preset = Engine.SENSITIVITY_PRESETS[card.dataset.preset];
        if (!preset) return;
        const next = Engine.normalizeState({
          ...state,
          warnThreshold: preset.warnThreshold,
          highThreshold: preset.highThreshold,
          followScanMaxPages: preset.followScanMaxPages
        });
        await saveState(next);
        showToast(`已切换为「${preset.label}」敏感度`);
      });
    }

    document.getElementById("wbr-save-prefs-btn").addEventListener("click", async () => {
      const strictSharedEl = document.getElementById("wbr-cfg-strict-shared");
      const next = Engine.normalizeState({
        ...state,
        muteDefaultMode: document.getElementById("wbr-cfg-default-mode").value,
        exemptFollowedUsers: document.getElementById("wbr-cfg-exempt-followed").checked,
        strictSharedExemption: strictSharedEl ? strictSharedEl.checked : false,
        confirmBeforeBlock: document.getElementById("wbr-cfg-confirm-block").checked,
        hoverAutoCheck: document.getElementById("wbr-cfg-hover-auto").checked,
        autoScanViewport: document.getElementById("wbr-cfg-autoscan").checked,
        showCleanCheckmark: document.getElementById("wbr-cfg-cleancheck").checked
      });
      await saveState(next);
      showToast("偏好设置已保存");
    });

    // Tab 3 events: Layer 2 Advanced settings
    document.getElementById("wbr-save-adv-btn").addEventListener("click", async () => {
      const next = Engine.normalizeState({
        ...state,
        warnThreshold: Number(document.getElementById("wbr-cfg-warn").value) || 3.1,
        highThreshold: Number(document.getElementById("wbr-cfg-high").value) || 4.7,
        followScanMaxPages: Number(document.getElementById("wbr-cfg-scan-pages").value) || 9,
        cacheTtlDays: Number(document.getElementById("wbr-cfg-cache-days").value) || 7
      });
      await saveState(next);
      showToast("高级参数已保存");
    });

    document.getElementById("wbr-wl-add-btn").addEventListener("click", async () => {
      const name = Engine.normalizeText(document.getElementById("wbr-wl-input").value);
      if (!name) return;
      if (!state.baselineExclusions.includes(name)) {
        await saveState(Engine.normalizeState({ ...state, baselineExclusions: [...state.baselineExclusions, name] }));
        showToast(`已跳过 ${name}`);
      }
      document.getElementById("wbr-wl-input").value = "";
    });

    document.getElementById("wbr-feat-add-btn").addEventListener("click", async () => {
      const screenName = Engine.normalizeText(document.getElementById("wbr-feat-name").value);
      const aliasesRaw = Engine.normalizeText(document.getElementById("wbr-feat-aliases").value);
      const category = document.getElementById("wbr-feat-cat").value;
      if (!screenName) {
        showToast("请输入博主昵称", true);
        return;
      }
      const aliases = aliasesRaw ? aliasesRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean) : [];
      const nextCustom = [
        ...(state.customFeatures || []),
        {
          id: `custom-${Date.now()}`,
          screenName,
          aliases,
          category,
          weight: 1
        }
      ];
      await saveState(Engine.normalizeState({ ...state, customFeatures: nextCustom }));
      document.getElementById("wbr-feat-name").value = "";
      document.getElementById("wbr-feat-aliases").value = "";
      showToast(`已添加参考博主 ${screenName}`);
    });

    document.getElementById("wbr-export-all-btn").addEventListener("click", () => {
      downloadJson("weibo-radar-backup.json", Engine.exportConfigJson(state, "all"));
      showToast("已导出全部配置");
    });

    document.getElementById("wbr-import-all-file").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const next = Engine.importConfigJson(state, parsed, "merge");
        await saveState(next);
        showToast("配置导入成功");
      } catch (_) {
        showToast("配置文件格式不对，导入失败", true);
      }
      e.target.value = "";
    });

    let clearCacheConfirmTimer = null;
    const clearCacheBtn = document.getElementById("wbr-clear-cache-btn");
    clearCacheBtn.addEventListener("click", async () => {
      if (clearCacheBtn.dataset.confirming !== "1") {
        clearCacheBtn.dataset.confirming = "1";
        clearCacheBtn.textContent = "再点一次确认清空";
        clearCacheConfirmTimer = setTimeout(() => {
          delete clearCacheBtn.dataset.confirming;
          clearCacheBtn.textContent = "清空已查记录缓存";
        }, 3500);
        return;
      }
      clearTimeout(clearCacheConfirmTimer);
      delete clearCacheBtn.dataset.confirming;
      clearCacheBtn.textContent = "清空已查记录缓存";
      await sendMessage({ type: "WBR_CLEAR_CACHE" });
      showToast("已查记录缓存已清空");
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
