/**
 * Weibo Follow Law Core Engine (shared/radar_engine.js)
 * - 6-category empirical feature matrix + UID/alias matching
 * - Real-world passerby baseline calibration & saturation damping
 * - Local mutedUsers matching (UID-first + screenName fallback)
 * - IndexedDB cache wrapper (wbr_radar_cache_db) with configurable TTL
 * - JSON import/export helpers
 * Zero external dependencies, 100% MV3 CSP compliant.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.WBRRadar = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  const STORAGE_KEY = "wbr_state";
  const DB_NAME = "wbr_radar_cache_db";
  const DB_VERSION = 3;
  const DB_STORE = "radar_results";
  const ALGO_VERSION = "1.5.4";
  const COMPATIBLE_ALGO_VERSIONS = new Set(["1.3.0", "1.3.1", "1.4.0", "1.4.1", "1.5.0", "1.5.1", "1.5.2", "1.5.3", "1.5.4"]);
  const MODEL_SCHEMA_VERSION = 3;
  const UX_MODE_VERSION = 2;

  const CATEGORY_META = {
    politics: { id: "politics", label: "时政与国际话题", shortLabel: "时政", color: "#d97706" },
    social: { id: "social", label: "情感锐评与热门大V", shortLabel: "情感", color: "#db2777" },
    tech_acg: { id: "tech_acg", label: "科技、科普与二次元", shortLabel: "科技ACG", color: "#2563eb" },
    stock: { id: "stock", label: "短线炒股资讯号", shortLabel: "炒股", color: "#ea580c" },
    military: { id: "military", label: "军事与防务话题", shortLabel: "军事", color: "#4d7c0f" },
    overseas: { id: "overseas", label: "海外猎奇与暗黑叙事", shortLabel: "猎奇", color: "#7c3aed" }
  };

  const SENSITIVITY_PRESETS = {
    loose: {
      id: "loose",
      label: "宽松",
      desc: "极低打扰，仅提示高纯度多圈层共现",
      warnThreshold: 3.9,
      highThreshold: 5.6,
      followScanMaxPages: 7
    },
    standard: {
      id: "standard",
      label: "标准",
      desc: "推荐平衡（真实路人校准最优分界）",
      warnThreshold: 3.1,
      highThreshold: 4.7,
      followScanMaxPages: 9
    },
    strict: {
      id: "strict",
      label: "严格",
      desc: "广域高敏排查（拉满 200 关注上限）",
      warnThreshold: 2.5,
      highThreshold: 4.1,
      followScanMaxPages: 10
    }
  };

  function detectSensitivityPreset(state) {
    const st = normalizeState(state);
    for (const preset of Object.values(SENSITIVITY_PRESETS)) {
      if (
        Math.abs(st.warnThreshold - preset.warnThreshold) < 0.05 &&
        Math.abs(st.highThreshold - preset.highThreshold) < 0.05 &&
        st.followScanMaxPages === preset.followScanMaxPages
      ) {
        return preset.id;
      }
    }
    return "custom";
  }

  function formatCompactCount(n) {
    if (n === null || n === undefined || n === "") return "-";
    const num = Number(n);
    if (!Number.isFinite(num) || num < 0) return "-";
    if (num < 10000) return String(Math.floor(num));
    const wan = (num / 10000).toFixed(1).replace(/\.0$/, "");
    return `${wan}万`;
  }

  function makeEntry(id, screenName, uid, category, weight = 1.0, aliases = [], aliasUids = [], note = "") {
    return {
      id,
      screenName,
      uid: String(uid || ""),
      aliases: Array.isArray(aliases) ? aliases : [],
      aliasUids: Array.isArray(aliasUids) ? aliasUids.map(String) : [],
      category,
      weight: Number(weight) || 1.0,
      note
    };
  }

  const DEFAULT_FEATURE_MATRIX = [
    // 1. 时政与地缘话题 (politics) - 33
    makeEntry("pol_baorong", "包容万物恒河水", "1671109627", "politics", 1.22),
    makeEntry("pol_guancha", "观察者网", "1887344341", "politics", 0.34, ["观察者网出行中心"], ["6060307497"], "含关联号 观察者网出行中心"),
    makeEntry("pol_xiangligang", "飞象网项立刚", "1481944214", "politics", 1.11),
    makeEntry("pol_lukewen", "卢克文", "1875293522", "politics", 0.80),
    makeEntry("pol_pingyuan", "平原公子赵胜", "1564834725", "politics", 1.16),
    makeEntry("pol_nanya", "南亚研究通讯", "5528109788", "politics", 0.68),
    makeEntry("pol_faguopiao", "法国漂", "2323101850", "politics", 0.85),
    makeEntry("pol_shuyu", "树语treetalk", "7942871901", "politics", 1.45),
    makeEntry("pol_daiyuxiao", "戴雨潇Dai", "1686096655", "politics", 1.17),
    makeEntry("pol_lijianqiu", "李建秋的世界", "1687813073", "politics", 1.21, ["李建秋的窝窝"], ["7991337010"], "含关联小号 李建秋的窝窝"),
    makeEntry("pol_creamy", "Creamy蕉", "7690478167", "politics", 1.09),
    makeEntry("pol_wuxin", "无心简影", "5564927603", "politics", 1.00),
    makeEntry("pol_shuita", "水獭一般编-阿怡", "6285204404", "politics", 1.02),
    makeEntry("pol_leige", "正直的磊哥", "1771474495", "politics", 1.05),
    makeEntry("pol_guyan", "孤烟暮蝉", "2150758415", "politics", 0.54),
    makeEntry("pol_yuyuan", "玉渊谭天", "7040797671", "politics", 0.41),
    makeEntry("pol_huaitudou", "一个坏土豆", "7384186077", "politics", 1.09),
    makeEntry("pol_shenyi", "沈逸", "1157864602", "politics", 0.52),
    makeEntry("pol_taiwanshashi", "台湾傻事", "5721376081", "politics", 0.66),
    makeEntry("pol_simapingbang", "司马平邦", "1400887105", "politics", 0.15),
    makeEntry("pol_ziwuxiashi", "子午侠士", "5067914848", "politics", 0.88),
    makeEntry("pol_zhaozheng", "赵铮-同志", "5365769881", "politics", 0.82),
    makeEntry("pol_jincanrong", "金灿荣教授", "7264589101", "politics", 0.53),
    makeEntry("pol_zhangbeihai", "胜利主义章北海", "2281157913", "politics", 0.49),
    makeEntry("pol_xudezhi", "徐德智不在UN", "1830834613", "politics", 0.80),
    makeEntry("pol_nanguiguyi", "南归孤夷", "7782884695", "politics", 0.83),
    makeEntry("pol_fanyongpeng", "范勇鹏-", "7508191062", "politics", 1.16),
    makeEntry("pol_shipindao", "食贫道", "6420726021", "politics", 0.72),
    makeEntry("pol_boston", "波士顿圆脸", "3903189121", "politics", 0.86),
    makeEntry("pol_sputnik", "俄罗斯卫星通讯社", "2181597154", "politics", 0.15),
    makeEntry("pol_wangxiao", "王骁Albert", "5649624264", "politics", 0.74),
    makeEntry("pol_diba", "帝吧官微", "7010131150", "politics", 0.71),
    makeEntry("pol_tuzhuxi", "兔主席", "1221171697", "politics", 0.62),

    // 2. 情感锐评与热门大V (social) - 14
    makeEntry("soc_ximen", "西门大妈", "6154203482", "social", 0.80, ["西门大妈没走丢"], ["7755237035"], "含关联小号 西门大妈没走丢"),
    makeEntry("soc_daobili", "皇城根下刀笔吏", "2032759640", "social", 0.95),
    makeEntry("soc_naiba", "奶霸知道", "1004853823", "social", 0.80, ["是奶霸"], ["5646157925"], "含关联小号 是奶霸"),
    makeEntry("soc_shuangye", "霜叶", "1980768563", "social", 0.30),
    makeEntry("soc_caozijian", "曹子建同学2000", "2290414064", "social", 1.18),
    makeEntry("soc_kailei", "凯雷", "1496883514", "social", 0.34),
    makeEntry("soc_situka98", "斯图卡98", "3279710155", "social", 0.34),
    makeEntry("soc_sven_shi", "sven_shi", "2382064902", "social", 0.55),
    makeEntry("soc_lushihan", "卢诗翰", "3276099007", "social", 0.69),
    makeEntry("soc_wuliufang", "吴柳芳", "2532395340", "social", 0.30),
    makeEntry("soc_wanghailin", "汪海林", "1497714867", "social", 0.76),
    makeEntry("soc_xionglvshi", "专业戳轮胎熊律师", "1471143571", "social", 0.60),
    makeEntry("soc_liji", "理记", "1907166177", "social", 0.48),
    makeEntry("soc_chenlan", "作家陈岚", "1463707815", "social", 0.80),

    // 3. 科技、科普与二次元 (tech_acg) - 5
    makeEntry("tacg_yili", "伊利达雷之怒", "3089487123", "tech_acg", 0.83),
    makeEntry("tacg_minv", "谜之免女郎X", "3689493785", "tech_acg", 1.04),
    makeEntry("tacg_aokamu", "奥卡姆剃刀", "1820201245", "tech_acg", 0.27),
    makeEntry("tacg_hanlu", "韩路", "1192966660", "tech_acg", 0.30),
    makeEntry("tacg_lishenle", "里神楽", "1842706721", "tech_acg", 0.74),

    // 4. 短线炒股资讯号 (stock) - 8
    makeEntry("stk_qiniu", "骑牛的靓仔", "7993971687", "stock", 0.28),
    makeEntry("stk_manman", "满满大牛场", "7558526914", "stock", 0.21),
    makeEntry("stk_dingji", "顶级Da野", "7985389235", "stock", 0.12),
    makeEntry("stk_haoyun", "好运股添乐", "7914027062", "stock", 0.31),
    makeEntry("stk_suidi", "随地大小股", "7397352101", "stock", 0.31),
    makeEntry("stk_wadigua", "挖地瓜的超级鹿鼎公", "3962719063", "stock", 0.27),
    makeEntry("stk_zhazha", "渣渣超短", "7350424564", "stock", 0.13),
    makeEntry("stk_xiaoyao", "逍遥图腾", "2965936722", "stock", 0.27),

    // 5. 军事与防务话题 (military) - 7
    makeEntry("mil_wanghu", "王虎的舰桥", "6545577536", "military", 1.17),
    makeEntry("mil_muxing", "牧星观海天", "1638620395", "military", 1.00, ["牧星观天海"], ["6080390942"], "含关联号 牧星观天海"),
    makeEntry("mil_nanhai", "南海的浪涛", "1142487595", "military", 0.75),
    makeEntry("mil_zhanjia", "战甲装研菌", "5035763146", "military", 0.25),
    makeEntry("mil_feiyang", "飞扬军事铁背心", "2139949234", "military", 0.93, ["飞扬军事"], ["1759354161"], "含原名号 飞扬军事"),
    makeEntry("mil_shamu", "沙姆雄狮_EL", "7399894004", "military", 1.09),
    makeEntry("mil_huanya", "寰亚SYHP", "5393135816", "military", 0.37),

    // 6. 海外猎奇与暗黑叙事 (overseas) - 5
    makeEntry("ovs_laoa", "斯奎奇大王牢A", "9133646850", "overseas", 1.33),
    makeEntry("ovs_hailanzhu", "海兰珠阿婶", "8013891733", "overseas", 1.31),
    makeEntry("ovs_jokie", "Jokielicious", "1930723113", "overseas", 1.45),
    makeEntry("ovs_paingod", "paingod", "1433680664", "overseas", 0.62),
    makeEntry("ovs_wanshiwu", "纯洁的万事屋", "3359389864", "overseas", 1.19)
  ];

  const DEFAULT_BASELINE_EXCLUSIONS = [
    "微博红包", "微博会员小秘书", "微博社交会员", "微博客服", "微博智搜", "头条文章",
    "人民日报", "央视新闻", "新华社", "人民网", "中国新闻网", "中国新闻周刊", "中国警方在线", "新浪新闻", "新浪热点",
    "开心鸭", "阑夕", "梁斌penny", "高飞", "来去之间", "宝玉xp", "楚团长聊聊天",
    "tombkeeper", "t0mbkeeper"
  ];

  function normalizeText(v) {
    if (v === null || v === undefined) return "";
    return String(v).trim().replace(/\s+/g, " ");
  }

  function normalizeKey(v) {
    return normalizeText(v).toLowerCase();
  }

  function normalizeUid(v) {
    const s = normalizeText(v);
    if (!s) return "";
    const m = s.match(/\d{5,}/);
    return m ? m[0] : "";
  }

  function defaultState() {
    return {
      modelSchemaVersion: MODEL_SCHEMA_VERSION,
      uxModeVersion: UX_MODE_VERSION,
      enabled: true,
      enableMainSite: true,
      autoScanViewport: false,
      showCleanCheckmark: false,
      progressPillCollapsed: false,
      progressPillPosition: "bottom-left",
      hoverAutoCheck: false,
      confirmBeforeBlock: true,
      exemptFollowedUsers: true,
      muteDefaultMode: "collapse",
      warnThreshold: 3.1,
      highThreshold: 4.7,
      cacheTtlDays: 7,
      followScanMaxPages: 9,
      enabledCategories: {
        politics: true,
        social: true,
        tech_acg: true,
        stock: true,
        military: true,
        overseas: true
      },
      customFeatures: [],
      disabledFeatureIds: [],
      baselineExclusions: DEFAULT_BASELINE_EXCLUSIONS.slice(),
      viewerFollowingUids: [],
      viewerFollowingSyncedAt: 0,
      mutedUsers: [],
      account: {
        uid: "",
        screenName: "",
        checkedAt: 0
      },
      circuitBreaker: {
        tripped: false,
        trippedAt: 0,
        until: 0,
        statusCode: 0,
        endpoint: "",
        reason: ""
      },
      lastSyncAt: 0
    };
  }

  function normalizeMutedEntry(item) {
    if (!item || typeof item !== "object") return null;
    const uid = normalizeUid(item.uid);
    const screenName = normalizeText(item.screenName || item.name || item.screen_name);
    if (!uid && !screenName) return null;
    const key = uid ? `uid:${uid}` : `name:${normalizeKey(screenName)}`;
    const mode = item.mode === "hide" ? "hide" : "collapse";
    const allowedSources = new Set(["manual", "weibo_block", "radar_queue"]);
    const source = allowedSources.has(item.source) ? item.source : "manual";
    return {
      key,
      uid,
      screenName: screenName || uid,
      mode,
      source,
      reason: normalizeText(item.reason),
      addedAt: Number(item.addedAt) || Date.now()
    };
  }

  function normalizeFeatureEntry(item) {
    if (!item || typeof item !== "object") return null;
    const screenName = normalizeText(item.screenName || item.name);
    if (!screenName) return null;
    const category = CATEGORY_META[item.category] ? item.category : "politics";
    const id = normalizeText(item.id) || `custom_${normalizeKey(screenName)}`;
    const uid = normalizeUid(item.uid);
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.map(normalizeText).filter(Boolean)
      : [];
    const aliasUids = Array.isArray(item.aliasUids)
      ? item.aliasUids.map(normalizeUid).filter(Boolean)
      : [];
    const rawW = Number(item.weight);
    const weight = Number.isFinite(rawW) && rawW > 0
      ? Math.round(Math.min(5, Math.max(0.1, rawW)) * 100) / 100
      : 1.0;
    return {
      id,
      screenName,
      uid,
      aliases,
      aliasUids,
      category,
      weight,
      note: normalizeText(item.note)
    };
  }

  function normalizeState(raw, now = Date.now()) {
    const base = defaultState();
    const src = raw && typeof raw === "object" ? raw : {};

    const isLegacyUxMode = !(Number(src.uxModeVersion) >= UX_MODE_VERSION);
    base.uxModeVersion = UX_MODE_VERSION;
    base.enabled = src.enabled !== false;
    base.enableMainSite = src.enableMainSite !== false;
    base.autoScanViewport = isLegacyUxMode ? false : Boolean(src.autoScanViewport);
    base.showCleanCheckmark = isLegacyUxMode ? false : Boolean(src.showCleanCheckmark);
    base.progressPillCollapsed = Boolean(src.progressPillCollapsed);
    base.progressPillPosition = src.progressPillPosition === "bottom-right" ? "bottom-right" : "bottom-left";
    base.hoverAutoCheck = Boolean(src.hoverAutoCheck);
    base.confirmBeforeBlock = src.confirmBeforeBlock !== false;
    base.exemptFollowedUsers = src.exemptFollowedUsers !== false;
    base.muteDefaultMode = src.muteDefaultMode === "hide" ? "hide" : "collapse";

    const rawWarn = Number(src.warnThreshold);
    const rawHigh = Number(src.highThreshold);
    const rawScanPages = Number(src.followScanMaxPages);
    const isLegacySchema = !(Number(src.modelSchemaVersion) >= MODEL_SCHEMA_VERSION);

    base.warnThreshold = Number.isFinite(rawWarn) && rawWarn >= 0.5
      ? Math.round(rawWarn * 100) / 100
      : 3.1;
    base.highThreshold = Number.isFinite(rawHigh) && rawHigh >= base.warnThreshold
      ? Math.round(rawHigh * 100) / 100
      : Math.max(4.7, Math.round((base.warnThreshold + 1.5) * 100) / 100);

    const ttl = Number(src.cacheTtlDays);
    base.cacheTtlDays = Number.isFinite(ttl) && ttl >= 1 ? Math.min(30, Math.floor(ttl)) : 7;

    base.followScanMaxPages = Number.isFinite(rawScanPages) && rawScanPages >= 1
      ? Math.min(10, Math.floor(rawScanPages))
      : 9;

    if (src.enabledCategories && typeof src.enabledCategories === "object") {
      for (const k of Object.keys(CATEGORY_META)) {
        base.enabledCategories[k] = src.enabledCategories[k] !== false;
      }
    }

    if (Array.isArray(src.customFeatures)) {
      const seen = new Set();
      base.customFeatures = [];
      for (const f of src.customFeatures) {
        const nf = normalizeFeatureEntry(f);
        if (nf && !seen.has(nf.id)) {
          seen.add(nf.id);
          base.customFeatures.push(nf);
        }
      }
    }

    if (Array.isArray(src.disabledFeatureIds)) {
      base.disabledFeatureIds = Array.from(
        new Set(src.disabledFeatureIds.map(normalizeText).filter(Boolean))
      );
    }

    if (Array.isArray(src.baselineExclusions)) {
      base.baselineExclusions = Array.from(
        new Set(src.baselineExclusions.map(normalizeText).filter(Boolean))
      );
    }

    if (Array.isArray(src.viewerFollowingUids)) {
      base.viewerFollowingUids = Array.from(
        new Set(src.viewerFollowingUids.map(normalizeUid).filter(Boolean))
      ).slice(0, 1000);
    }
    base.viewerFollowingSyncedAt = Number(src.viewerFollowingSyncedAt) || 0;

    if (isLegacySchema) {
      const hasNoThreshold = src.warnThreshold === undefined && src.highThreshold === undefined && src.followScanMaxPages === undefined;
      const isV1Standard = rawWarn === 3 && rawHigh === 5 && (!Number.isFinite(rawScanPages) || rawScanPages === 5);
      const isV1Loose = rawWarn === 4 && rawHigh === 7 && (!Number.isFinite(rawScanPages) || rawScanPages === 3);
      const isV1Strict = rawWarn === 2 && rawHigh === 4 && (!Number.isFinite(rawScanPages) || rawScanPages === 8);
      const isV2Standard = Math.abs(rawWarn - 3.4) < 0.05 && Math.abs(rawHigh - 5.5) < 0.05;
      const isV2Loose = Math.abs(rawWarn - 4.2) < 0.05 && Math.abs(rawHigh - 6.5) < 0.05;
      const isV2Strict = Math.abs(rawWarn - 2.4) < 0.05 && Math.abs(rawHigh - 4.2) < 0.05;

      if (hasNoThreshold || isV1Standard || isV2Standard) {
        base.warnThreshold = SENSITIVITY_PRESETS.standard.warnThreshold;
        base.highThreshold = SENSITIVITY_PRESETS.standard.highThreshold;
        base.followScanMaxPages = SENSITIVITY_PRESETS.standard.followScanMaxPages;
      } else if (isV1Loose || isV2Loose) {
        base.warnThreshold = SENSITIVITY_PRESETS.loose.warnThreshold;
        base.highThreshold = SENSITIVITY_PRESETS.loose.highThreshold;
        base.followScanMaxPages = SENSITIVITY_PRESETS.loose.followScanMaxPages;
      } else if (isV1Strict || isV2Strict) {
        base.warnThreshold = SENSITIVITY_PRESETS.strict.warnThreshold;
        base.highThreshold = SENSITIVITY_PRESETS.strict.highThreshold;
        base.followScanMaxPages = SENSITIVITY_PRESETS.strict.followScanMaxPages;
      }
      base.baselineExclusions = Array.from(
        new Set([...base.baselineExclusions, ...DEFAULT_BASELINE_EXCLUSIONS])
      );
    }
    base.modelSchemaVersion = MODEL_SCHEMA_VERSION;

    if (Array.isArray(src.mutedUsers)) {
      const byKey = new Map();
      for (const m of src.mutedUsers) {
        const nm = normalizeMutedEntry(m);
        if (!nm) continue;
        const existing = byKey.get(nm.key);
        if (!existing || (nm.uid && !existing.uid)) {
          byKey.set(nm.key, nm);
        }
      }
      base.mutedUsers = Array.from(byKey.values());
    }

    if (src.account && typeof src.account === "object") {
      base.account = {
        uid: normalizeUid(src.account.uid),
        screenName: normalizeText(src.account.screenName),
        checkedAt: Number(src.account.checkedAt) || 0
      };
    }

    if (src.circuitBreaker && typeof src.circuitBreaker === "object") {
      const rawTripped = Boolean(src.circuitBreaker.tripped);
      const trippedAt = Number(src.circuitBreaker.trippedAt) || 0;
      const endpoint = normalizeText(src.circuitBreaker.endpoint);
      let until = Number(src.circuitBreaker.until) || 0;
      if (rawTripped && until <= 0 && trippedAt > 0) {
        until = trippedAt + 10 * 60 * 1000;
      }
      // Official blacklist sync (/ajax/setting/getFilteredUsers) is auxiliary and must never lock radar scans
      const isAuxiliaryEndpoint = endpoint.includes("getFilteredUsers");
      const tripped = rawTripped && !isAuxiliaryEndpoint && until > 0 && now < until;
      base.circuitBreaker = {
        tripped,
        trippedAt: tripped ? trippedAt : 0,
        until: tripped ? until : 0,
        statusCode: tripped ? Number(src.circuitBreaker.statusCode) || 0 : 0,
        endpoint: tripped ? endpoint : "",
        reason: tripped ? normalizeText(src.circuitBreaker.reason) : ""
      };
    }

    base.lastSyncAt = Number(src.lastSyncAt) || 0;
    return base;
  }

  function formatBreakerSummary(cb, now = Date.now()) {
    if (!cb || !cb.tripped) return "";
    const until = Number(cb.until) || 0;
    const remainSec = until > now ? Math.max(1, Math.ceil((until - now) / 1000)) : 0;
    const min = Math.max(1, Math.ceil(remainSec / 60));
    const remainText = remainSec > 0
      ? (remainSec >= 60 ? `约 ${min} 分钟后自动恢复` : `约 ${remainSec} 秒后自动恢复`)
      : "即将恢复";
    return `请求有点快，休息冷却中（${remainText}，本地屏蔽仍正常生效）`;
  }

  function getActiveFeatureMatrix(state) {
    const st = normalizeState(state);
    const disabled = new Set(st.disabledFeatureIds);
    const all = [];
    const seenIds = new Set();

    for (const item of DEFAULT_FEATURE_MATRIX) {
      if (disabled.has(item.id)) continue;
      if (!st.enabledCategories[item.category]) continue;
      seenIds.add(item.id);
      all.push(item);
    }
    for (const item of st.customFeatures) {
      if (seenIds.has(item.id) || disabled.has(item.id)) continue;
      if (!st.enabledCategories[item.category]) continue;
      seenIds.add(item.id);
      all.push(item);
    }
    return all;
  }

  function buildFeatureLookup(state) {
    const matrix = getActiveFeatureMatrix(state);
    const byName = new Map();
    const byUid = new Map();
    for (const entry of matrix) {
      const names = [entry.screenName, ...(entry.aliases || [])];
      for (const n of names) {
        const k = normalizeKey(n);
        if (k) byName.set(k, { entry, matchedAlias: n !== entry.screenName ? n : "" });
      }
      if (entry.uid) {
        const u = normalizeUid(entry.uid);
        if (u) byUid.set(u, { entry, matchedAlias: "" });
      }
      const aliasUids = Array.isArray(entry.aliasUids) ? entry.aliasUids : [];
      for (let i = 0; i < aliasUids.length; i += 1) {
        const au = normalizeUid(aliasUids[i]);
        if (au && !byUid.has(au)) {
          const aliasName = (entry.aliases && entry.aliases[i]) || "关联小号";
          byUid.set(au, { entry, matchedAlias: aliasName });
        }
      }
    }
    return { matrix, byName, byUid };
  }

  function buildExclusionSet(state) {
    const st = normalizeState(state);
    const set = new Set();
    for (const item of st.baselineExclusions) {
      const k = normalizeKey(item);
      if (k) set.add(k);
    }
    return set;
  }

  function computeProbabilityFromScore(score, matchedCount = 1) {
    if (!(matchedCount > 0) || !(score > 0)) return 0;
    const p = 100 / (1 + Math.exp(-1.35 * (score - 2.95)));
    return Math.max(1, Math.min(99, Math.round(p)));
  }

  function classifyScoreLevel(score, matchedCount, state) {
    const st = normalizeState(state);
    if (!(matchedCount > 0) || !(score > 0)) return "none";
    if (score >= st.highThreshold) return "high";
    if (score >= st.warnThreshold) return "warn";
    return "low";
  }

  function classifyHitLevel(scoreOrCount, state) {
    return classifyScoreLevel(scoreOrCount, scoreOrCount > 0 ? 1 : 0, state);
  }

  function matchSelfFeature(user, state) {
    if (!user) return null;
    const st = normalizeState(state);
    const uid = normalizeUid(user.uid || user.idstr || user.id);
    if (uid && st.account && st.account.uid && uid === st.account.uid) return null;
    if (uid && Array.isArray(st.viewerFollowingUids) && st.viewerFollowingUids.includes(uid)) return null;

    const { byName, byUid } = buildFeatureLookup(st);
    const name = normalizeKey(user.screenName || user.screen_name || user.name);
    const exclusions = buildExclusionSet(st);
    if ((name && exclusions.has(name)) || (uid && exclusions.has(uid))) return null;
    const found = (uid && byUid.get(uid)) || (name && byName.get(name));
    if (!found) return null;
    const entryId = String(found.entry.id || "");
    const isCustom = entryId.startsWith("custom_") || entryId.startsWith("custom-");
    if (!isCustom && (found.entry.category === "stock" || !(Number(found.entry.weight) >= 1.05))) return null;
    const cat = CATEGORY_META[found.entry.category] || { label: found.entry.category, shortLabel: found.entry.category };
    return {
      entry: found.entry,
      categoryLabel: cat.shortLabel || cat.label,
      categoryFullLabel: cat.label
    };
  }

  function evaluateFollowing(followingList, state, meta = {}) {
    const st = normalizeState(state);
    const { byName, byUid } = buildFeatureLookup(st);
    const exclusions = buildExclusionSet(st);
    const viewerSet = new Set(st.viewerFollowingUids || []);

    const targetUid = normalizeUid(meta.uid);
    const simulateVisitor = Boolean(meta.simulateVisitor);
    const isSelf = Boolean(meta.isSelf || (targetUid && st.account && st.account.uid && targetUid === st.account.uid));
    const viewerFollowing = Boolean(meta.viewerFollowing || (targetUid && viewerSet.has(targetUid)));
    const verifiedType = meta.verifiedType !== undefined && meta.verifiedType !== null && meta.verifiedType !== ""
      ? Number(meta.verifiedType)
      : -1;
    const isOrgVerified = Number.isFinite(verifiedType) && verifiedType >= 1 && verifiedType <= 7;
    let exemptReason = "";
    if (!simulateVisitor) {
      if (isSelf) exemptReason = "self";
      else if (isOrgVerified) exemptReason = "org_verified";
      else if (st.exemptFollowedUsers && viewerFollowing) exemptReason = "following";
    }

    const list = Array.isArray(followingList) ? followingList : [];
    const hitByEntryId = new Map();
    const categoryCounts = {};
    for (const c of Object.keys(CATEGORY_META)) categoryCounts[c] = 0;

    let excludedCount = 0;
    for (const raw of list) {
      let uid = "";
      let name = "";
      if (typeof raw === "string") {
        name = normalizeText(raw);
        if (/^\d{5,}$/.test(name)) uid = name;
      } else if (raw && typeof raw === "object") {
        uid = normalizeUid(raw.uid || raw.idstr || raw.id);
        name = normalizeText(raw.screenName || raw.screen_name || raw.name);
      }
      const nameKey = normalizeKey(name);
      if ((nameKey && exclusions.has(nameKey)) || (uid && exclusions.has(uid))) {
        excludedCount += 1;
        continue;
      }

      const matched = (uid && byUid.get(uid)) || (nameKey && byName.get(nameKey));
      if (!matched) continue;

      const { entry, matchedAlias } = matched;
      if (!hitByEntryId.has(entry.id)) {
        const entryUids = [
          normalizeUid(entry.uid),
          ...(Array.isArray(entry.aliasUids) ? entry.aliasUids.map(normalizeUid) : [])
        ].filter(Boolean);
        const sharedWithViewer = !simulateVisitor && entryUids.some((u) => viewerSet.has(u));
        const baseWeight = Number(entry.weight) || 1.0;
        hitByEntryId.set(entry.id, {
          id: entry.id,
          uid: entry.uid || "",
          name: entry.screenName,
          category: entry.category,
          categoryLabel: (CATEGORY_META[entry.category] && CATEGORY_META[entry.category].shortLabel) || entry.category,
          weight: baseWeight,
          effectiveWeight: sharedWithViewer ? 0 : baseWeight,
          sharedWithViewer,
          matchedNames: new Set([name || entry.screenName]),
          viaAlias: matchedAlias || ""
        });
      } else {
        const rec = hitByEntryId.get(entry.id);
        rec.matchedNames.add(name || entry.screenName);
      }
    }

    const hitItems = [];
    for (const rec of hitByEntryId.values()) {
      categoryCounts[rec.category] = (categoryCounts[rec.category] || 0) + 1;
      hitItems.push({
        id: rec.id,
        uid: rec.uid,
        name: rec.name,
        category: rec.category,
        categoryLabel: rec.categoryLabel,
        weight: rec.weight,
        effectiveWeight: rec.effectiveWeight,
        sharedWithViewer: rec.sharedWithViewer,
        matchedNames: Array.from(rec.matchedNames),
        viaAlias: rec.viaAlias
      });
    }
    hitItems.sort((a, b) => (b.weight || 0) - (a.weight || 0));

    const matchedCount = hitItems.length;
    let coreSum = 0;
    let panSum = 0;
    let stockSum = 0;
    let maxNonStockWeight = 0;
    const nonStockCats = new Set();

    const byCategory = new Map();
    for (const item of hitItems) {
      if (!(item.effectiveWeight > 0)) continue;
      if (!byCategory.has(item.category)) byCategory.set(item.category, []);
      byCategory.get(item.category).push(item.effectiveWeight);
      if (item.category !== "stock") {
        nonStockCats.add(item.category);
        if (item.effectiveWeight > maxNonStockWeight) {
          maxNonStockWeight = item.effectiveWeight;
        }
      }
    }

    for (const [cat, weights] of byCategory.entries()) {
      weights.sort((a, b) => b - a);
      if (cat === "stock") {
        let sc = 0;
        const mults = [1.0, 0.60, 0.35];
        for (let i = 0; i < weights.length; i += 1) {
          const m = i < mults.length ? mults[i] : 0.20;
          sc += weights[i] * m;
        }
        stockSum = Math.min(0.70, sc);
      } else {
        for (let i = 0; i < weights.length; i += 1) {
          const m = i < 2 ? 1.0 : (i === 2 ? 0.82 : 0.65);
          const effW = weights[i] * m;
          if (weights[i] >= 0.85) {
            coreSum += effW;
          } else {
            panSum += effW;
          }
        }
      }
    }

    const panTotal = panSum + stockSum;
    const panEffective = 1.85 * Math.log(1 + panTotal / 1.85);
    const rawScore = coreSum + panEffective;

    const scannedCount = Number(meta.scannedCount) || list.length;
    const friendsCount = Math.max(Number(meta.friendsCount) || 0, scannedCount);
    const denom = 1 + 0.28 * Math.max(0, Math.log(Math.max(friendsCount, 150) / 350));
    let score = rawScore > 0 ? rawScore / denom : 0;

    // Specificity Gate: pure pan-topic / pure stock overlap without any >=0.78 anchor cannot cross warnThreshold
    if (score > 0 && maxNonStockWeight < 0.78 && nonStockCats.size < 3) {
      score = Math.min(score, Math.max(0, st.warnThreshold - 0.15));
    }
    score = Math.round(score * 100) / 100;

    const effectiveHitCount = hitItems.filter((x) => x.effectiveWeight > 0).length;
    const probability = exemptReason ? 0 : computeProbabilityFromScore(score, effectiveHitCount);
    const level = exemptReason ? "none" : classifyScoreLevel(score, effectiveHitCount, st);

    return {
      algoVersion: ALGO_VERSION,
      uid: targetUid,
      screenName: normalizeText(meta.screenName),
      followersCount: Number(meta.followersCount) || 0,
      friendsCount,
      scannedCount,
      excludedCount,
      hiddenFollowing: Boolean(meta.hiddenFollowing),
      viewerFollowing,
      verifiedType,
      exemptReason,
      simulateVisitor,
      scanMode: meta.scanMode || "full",
      fastSkippedExempt: Boolean(meta.fastSkippedExempt),
      hitCount: matchedCount,
      matchedCount,
      effectiveHitCount,
      rawScore: Math.round(rawScore * 100) / 100,
      score,
      probability,
      level,
      hitItems,
      categoryCounts,
      checkedAt: Number(meta.checkedAt) || Date.now()
    };
  }

  function findMutedMatch(user, stateOrMuted) {
    if (!user) return null;
    const mutedList = Array.isArray(stateOrMuted)
      ? stateOrMuted
      : (stateOrMuted && Array.isArray(stateOrMuted.mutedUsers) ? stateOrMuted.mutedUsers : []);
    if (mutedList.length === 0) return null;

    const uid = normalizeUid(user.uid || user.idstr || user.id);
    const nameKey = normalizeKey(user.screenName || user.screen_name || user.name);

    if (uid) {
      for (const m of mutedList) {
        if (m.uid && m.uid === uid) return m;
      }
    }
    if (nameKey) {
      for (const m of mutedList) {
        if (m.screenName && normalizeKey(m.screenName) === nameKey) return m;
      }
    }
    return null;
  }

  function upsertMutedUser(state, entry) {
    const st = normalizeState(state);
    const nm = normalizeMutedEntry({
      ...entry,
      mode: entry.mode || st.muteDefaultMode
    });
    if (!nm) return st;

    const out = [];
    let replaced = false;
    for (const cur of st.mutedUsers) {
      const sameUid = nm.uid && cur.uid && cur.uid === nm.uid;
      const sameName = nm.screenName && cur.screenName &&
        normalizeKey(cur.screenName) === normalizeKey(nm.screenName);
      if (sameUid || sameName || cur.key === nm.key) {
        if (!replaced) {
          out.push({
            ...cur,
            ...nm,
            uid: nm.uid || cur.uid,
            screenName: nm.screenName || cur.screenName,
            key: (nm.uid || cur.uid) ? `uid:${nm.uid || cur.uid}` : cur.key,
            addedAt: cur.addedAt || nm.addedAt
          });
          replaced = true;
        }
      } else {
        out.push(cur);
      }
    }
    if (!replaced) {
      out.unshift(nm);
    }
    return normalizeState({ ...st, mutedUsers: out });
  }

  function removeMutedUser(state, target) {
    const st = normalizeState(state);
    const uid = normalizeUid(target && (target.uid || target.key));
    const nameKey = normalizeKey(target && (target.screenName || target.name));
    const key = normalizeText(target && target.key);
    const next = st.mutedUsers.filter((m) => {
      if (key && m.key === key) return false;
      if (uid && m.uid === uid) return false;
      if (nameKey && normalizeKey(m.screenName) === nameKey) return false;
      return true;
    });
    return normalizeState({ ...st, mutedUsers: next });
  }

  function exportConfigJson(state, scope = "all") {
    const st = normalizeState(state);
    const payload = {
      schema: "wbr-config-v1",
      exportedAt: new Date().toISOString(),
      scope
    };
    if (scope === "muted" || scope === "all") {
      payload.mutedUsers = st.mutedUsers;
    }
    if (scope === "features" || scope === "all") {
      payload.warnThreshold = st.warnThreshold;
      payload.highThreshold = st.highThreshold;
      payload.cacheTtlDays = st.cacheTtlDays;
      payload.followScanMaxPages = st.followScanMaxPages;
      payload.exemptFollowedUsers = st.exemptFollowedUsers;
      payload.enabledCategories = st.enabledCategories;
      payload.customFeatures = st.customFeatures;
      payload.disabledFeatureIds = st.disabledFeatureIds;
      payload.baselineExclusions = st.baselineExclusions;
    }
    return payload;
  }

  function importConfigJson(currentState, rawJson, mode = "merge") {
    const st = normalizeState(currentState);
    const data = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    if (!data || typeof data !== "object") {
      throw new Error("无效的 JSON 配置格式");
    }

    const next = { ...st };
    if (Array.isArray(data.mutedUsers)) {
      if (mode === "replace") {
        next.mutedUsers = data.mutedUsers;
      } else {
        let merged = normalizeState(next);
        for (const m of data.mutedUsers) {
          merged = upsertMutedUser(merged, m);
        }
        next.mutedUsers = merged.mutedUsers;
      }
    }
    if (Array.isArray(data.customFeatures)) {
      if (mode === "replace") {
        next.customFeatures = data.customFeatures;
      } else {
        const byId = new Map(st.customFeatures.map((f) => [f.id, f]));
        for (const f of data.customFeatures) {
          const nf = normalizeFeatureEntry(f);
          if (nf) byId.set(nf.id, nf);
        }
        next.customFeatures = Array.from(byId.values());
      }
    }
    if (Array.isArray(data.baselineExclusions)) {
      next.baselineExclusions = mode === "replace"
        ? data.baselineExclusions
        : Array.from(new Set([...st.baselineExclusions, ...data.baselineExclusions]));
    }
    if (Array.isArray(data.disabledFeatureIds)) {
      next.disabledFeatureIds = data.disabledFeatureIds;
    }
    if (data.enabledCategories && typeof data.enabledCategories === "object") {
      next.enabledCategories = { ...st.enabledCategories, ...data.enabledCategories };
    }
    if (data.warnThreshold !== undefined) next.warnThreshold = data.warnThreshold;
    if (data.highThreshold !== undefined) next.highThreshold = data.highThreshold;
    if (data.cacheTtlDays !== undefined) next.cacheTtlDays = data.cacheTtlDays;
    if (data.followScanMaxPages !== undefined) next.followScanMaxPages = data.followScanMaxPages;
    if (data.exemptFollowedUsers !== undefined) next.exemptFollowedUsers = data.exemptFollowedUsers;

    return normalizeState(next);
  }

  function createCacheStore(idbFactory) {
    const idb = idbFactory || (typeof indexedDB !== "undefined" ? indexedDB : null);
    const mem = new Map();
    const IDB_TIMEOUT_MS = 3000;
    let dbPromise = null;

    function buildCacheKey(uid, screenName) {
      const nu = normalizeUid(uid);
      if (nu) return `uid:${nu}`;
      const nn = normalizeKey(screenName);
      return nn ? `name:${nn}` : "";
    }

    function openDb() {
      if (!idb) return Promise.resolve(null);
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve) => {
        let settled = false;
        const finish = (db) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!db) dbPromise = null;
          resolve(db || null);
        };
        const timer = setTimeout(() => finish(null), IDB_TIMEOUT_MS);
        try {
          const req = idb.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains(DB_STORE)) {
              const store = db.createObjectStore(DB_STORE, { keyPath: "cacheKey" });
              store.createIndex("uid", "uid", { unique: false });
              store.createIndex("checkedAt", "checkedAt", { unique: false });
            } else if (ev.oldVersion < DB_VERSION && ev.target.transaction) {
              ev.target.transaction.objectStore(DB_STORE).clear();
            }
          };
          req.onsuccess = () => finish(req.result);
          req.onerror = () => finish(null);
          req.onblocked = () => finish(null);
        } catch (_) {
          finish(null);
        }
      });
      return dbPromise;
    }

    function isFresh(record, ttlDays = 7, now = Date.now()) {
      if (!record || !record.checkedAt) return false;
      if (!COMPATIBLE_ALGO_VERSIONS.has(record.algoVersion)) return false;
      const ttlMs = Math.max(1, Number(ttlDays) || 7) * 86400 * 1000;
      return (now - Number(record.checkedAt)) <= ttlMs;
    }

    async function get(uid, screenName, ttlDays = 7, now = Date.now()) {
      const keys = [];
      const uKey = uid ? buildCacheKey(uid, "") : "";
      const nKey = screenName ? buildCacheKey("", screenName) : "";
      if (uKey) keys.push(uKey);
      if (nKey && nKey !== uKey) keys.push(nKey);
      if (keys.length === 0) return null;

      const db = await openDb();
      if (!db) {
        for (const k of keys) {
          const rec = mem.get(k);
          if (rec && isFresh(rec, ttlDays, now)) return rec;
        }
        return null;
      }

      for (const k of keys) {
        const rec = await new Promise((resolve) => {
          let settled = false;
          const done = (val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(val);
          };
          const timer = setTimeout(() => done(null), IDB_TIMEOUT_MS);
          try {
            const tx = db.transaction(DB_STORE, "readonly");
            const req = tx.objectStore(DB_STORE).get(k);
            req.onsuccess = () => done(req.result || null);
            req.onerror = () => done(null);
            tx.onabort = () => done(null);
            tx.onerror = () => done(null);
          } catch (_) {
            done(null);
          }
        });
        if (rec && isFresh(rec, ttlDays, now)) return rec;
      }
      return null;
    }

    async function put(record) {
      if (!record) return null;
      const cacheKey = buildCacheKey(record.uid, record.screenName);
      if (!cacheKey) return null;
      const full = {
        ...record,
        cacheKey,
        checkedAt: Number(record.checkedAt) || Date.now()
      };

      const db = await openDb();
      if (!db) {
        mem.set(cacheKey, full);
        if (record.uid && record.screenName) {
          mem.set(buildCacheKey("", record.screenName), full);
        }
        return full;
      }

      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, IDB_TIMEOUT_MS);
        try {
          const tx = db.transaction(DB_STORE, "readwrite");
          const store = tx.objectStore(DB_STORE);
          store.put(full);
          if (record.uid && record.screenName) {
            store.put({
              ...full,
              cacheKey: buildCacheKey("", record.screenName)
            });
          }
          tx.oncomplete = done;
          tx.onerror = done;
          tx.onabort = done;
        } catch (_) {
          done();
        }
      });
      return full;
    }

    async function getMany(uids, ttlDays = 7, now = Date.now()) {
      const list = Array.isArray(uids) ? uids.map(normalizeUid).filter(Boolean) : [];
      const out = {};
      if (list.length === 0) return out;
      const db = await openDb();
      if (!db) {
        for (const u of list) {
          const rec = mem.get(`uid:${u}`);
          if (rec && isFresh(rec, ttlDays, now)) out[u] = rec;
        }
        return out;
      }
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, IDB_TIMEOUT_MS);
        try {
          const tx = db.transaction(DB_STORE, "readonly");
          const store = tx.objectStore(DB_STORE);
          let pending = list.length;
          tx.onabort = done;
          tx.onerror = done;
          for (const u of list) {
            const req = store.get(`uid:${u}`);
            req.onsuccess = () => {
              const rec = req.result;
              if (rec && isFresh(rec, ttlDays, now)) out[u] = rec;
              pending -= 1;
              if (pending === 0) done();
            };
            req.onerror = () => {
              pending -= 1;
              if (pending === 0) done();
            };
          }
        } catch (_) {
          done();
        }
      });
      return out;
    }

    async function count(ttlDays = 7, now = Date.now()) {
      const db = await openDb();
      if (!db) {
        const uniq = new Set();
        for (const rec of mem.values()) {
          if (isFresh(rec, ttlDays, now)) {
            uniq.add(rec.uid || rec.cacheKey);
          }
        }
        return uniq.size;
      }
      return new Promise((resolve) => {
        let settled = false;
        const done = (val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(val);
        };
        const timer = setTimeout(() => done(0), IDB_TIMEOUT_MS);
        try {
          const tx = db.transaction(DB_STORE, "readonly");
          const req = tx.objectStore(DB_STORE).getAll();
          req.onsuccess = () => {
            const uniq = new Set();
            for (const rec of req.result || []) {
              if (isFresh(rec, ttlDays, now)) {
                uniq.add(rec.uid || rec.cacheKey);
              }
            }
            done(uniq.size);
          };
          req.onerror = () => done(0);
          tx.onabort = () => done(0);
          tx.onerror = () => done(0);
        } catch (_) {
          done(0);
        }
      });
    }

    async function clear() {
      mem.clear();
      const db = await openDb();
      if (!db) return;
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, IDB_TIMEOUT_MS);
        try {
          const tx = db.transaction(DB_STORE, "readwrite");
          tx.objectStore(DB_STORE).clear();
          tx.oncomplete = done;
          tx.onerror = done;
          tx.onabort = done;
        } catch (_) {
          done();
        }
      });
    }

    return { get, put, getMany, count, clear, buildCacheKey, isFresh };
  }

  return {
    STORAGE_KEY,
    DB_NAME,
    DB_VERSION,
    DB_STORE,
    ALGO_VERSION,
    COMPATIBLE_ALGO_VERSIONS,
    MODEL_SCHEMA_VERSION,
    CATEGORY_META,
    SENSITIVITY_PRESETS,
    detectSensitivityPreset,
    formatCompactCount,
    DEFAULT_FEATURE_MATRIX,
    DEFAULT_BASELINE_EXCLUSIONS,
    normalizeText,
    normalizeKey,
    normalizeUid,
    defaultState,
    normalizeState,
    formatBreakerSummary,
    getActiveFeatureMatrix,
    buildFeatureLookup,
    buildExclusionSet,
    computeProbabilityFromScore,
    classifyScoreLevel,
    classifyHitLevel,
    matchSelfFeature,
    evaluateFollowing,
    findMutedMatch,
    upsertMutedUser,
    removeMutedUser,
    exportConfigJson,
    importConfigJson,
    createCacheStore
  };
});
