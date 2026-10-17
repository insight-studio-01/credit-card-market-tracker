/* 信用卡市場追蹤儀表板 — 前端邏輯（四頁籤主管決策儀表板版）
 *
 * 資料來源僅使用：
 *   data/processed/issuer_metrics.json
 *   data/processed/market_metrics.json
 * 不讀取、不推估任何其他資料；null 一律顯示「—」，不得顯示 NaN / Infinity / null / undefined。
 * 所有文字結論皆由資料動態產生，不得將任何月份之文字或數值寫死於本檔案。
 * 本頁只陳述資料可直接支持的事實，不推測數據背後原因。
 *
 * 重要判讀原則（本階段修正重點）：
 *   1.「本行自身變化」（遠銀 YoY 本身）與「相對市場表現」（遠銀YoY－市場YoY）
 *      必須分開呈現，不得混為一談：遠銀正成長但落後市場，不得描述為「本行衰退」。
 *   2. 比率型指標（有效卡率等）一律使用 pp（百分點），不得寫成一般百分比成長率。
 *   3.「遠銀－市場」一律保留正負號，並以「領先／落後／高於／低於市場 X pp」等明確文字呈現。
 *   4. 排名數字越小越好；排名變化＝去年（或比較期）排名－本期排名，正值＝進步。
 */

(function () {
  "use strict";

  var ISSUER_URL = "data/processed/issuer_metrics.json";
  var MARKET_URL = "data/processed/market_metrics.json";
  var FAR_EASTERN_NAME = "遠東國際商業銀行";
  var SVGNS = "http://www.w3.org/2000/svg";

  // 網站可瀏覽範圍固定自民國114年1月（2025-01）起；民國113年資料僅於後端
  // 用於114年 YoY／YTD YoY 計算基期，確保選單、趨勢圖、排名表、明細查詢
  // 皆不會出現113年資料點。
  var DISPLAY_START_MONTH = "2025-01";

  // 資料明細預設依發卡機構排名由1至32排列（非銀行發卡機構與銀行一併排序，不得先分組）。
  var DETAIL_DEFAULT_SORT = { field: "issuer_rank", dir: "asc" };

  var state = {
    issuerData: [],
    marketData: [],
    periods: [],
    selectedPeriod: null,
    activeTab: "overview",            // "overview" | "trends" | "peers" | "custom"
    activeMetricId: "purchase_amount",
    periodType: "ytd",                // "month" | "ytd"（僅流量型指標適用）
    trendRange: "6",                  // "6" | "12" | "custom"
    customStart: null,
    customEnd: null,
    peersScope: "top12",
    peersSearch: "",
    overviewBasis: "ytd",
    peersSortField: "value",
    peersSortDir: "desc",
  };

  // ==================================================================
  // 一、格式化工具
  // ==================================================================

  function isFiniteNumber(v) { return typeof v === "number" && isFinite(v); }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmtInt(v) {
    if (!isFiniteNumber(v)) return "—";
    return Math.round(v).toLocaleString("zh-TW");
  }

  function deltaClass(rounded) {
    return rounded > 0 ? "delta-pos" : rounded < 0 ? "delta-neg" : "delta-zero";
  }

  function fmtPct(v, digits) {
    if (digits === undefined) digits = 2;
    if (!isFiniteNumber(v)) return { text: "—", cls: "delta-na" };
    var rounded = Number(v.toFixed(digits));
    var sign = rounded > 0 ? "+" : "";
    return { text: sign + rounded.toFixed(digits) + "%", cls: deltaClass(rounded) };
  }

  function fmtPp(v, digits) {
    if (digits === undefined) digits = 2;
    if (!isFiniteNumber(v)) return { text: "—", cls: "delta-na" };
    var rounded = Number(v.toFixed(digits));
    var sign = rounded > 0 ? "+" : "";
    return { text: sign + rounded.toFixed(digits) + " pp", cls: deltaClass(rounded) };
  }

  function fmtPlainPct(v, digits) {
    if (digits === undefined) digits = 2;
    if (!isFiniteNumber(v)) return "—";
    return v.toFixed(digits) + "%";
  }

  function fmtRank(v) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return String(Math.round(v));
  }

  function fmt100m(v, digits) {
    if (digits === undefined) digits = 2;
    if (!isFiniteNumber(v)) return "—";
    return v.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits }) + " 億元";
  }

  function fmtYuanPerCard(v) {
    if (!isFiniteNumber(v)) return "—";
    return Math.round(v).toLocaleString("zh-TW") + " 元/張";
  }

  function fmtWanZhang(v, digits) {
    if (digits === undefined) digits = 2;
    if (!isFiniteNumber(v)) return "—";
    return (v / 10000).toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits }) + " 萬張";
  }

  function spanHtml(formatted) {
    return '<span class="' + formatted.cls + '">' + escapeHtml(formatted.text) + "</span>";
  }

  function periodLabel(rec) {
    if (!rec) return "—";
    return "民國 " + rec.roc_year + " 年 " + rec.month + " 月（" + rec.period + "）";
  }

  function periodShortLabel(rec) {
    if (!rec) return "—";
    return rec.roc_year + "年" + rec.month + "月";
  }

  /** 可瀏覽（可選月份、趨勢資料點）之月份：排除113年基期資料，但不影響其作為比較基期。 */
  function displayPeriods(periods) {
    return periods.filter(function (p) { return p >= DISPLAY_START_MONTH; }).sort();
  }

  function prevMonthPeriod(period) {
    var parts = period.split("-");
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10) - 1;
    if (month === 0) { month = 12; year -= 1; }
    return year + "-" + (month < 10 ? "0" + month : String(month));
  }

  function prevYearPeriod(period) {
    var parts = period.split("-");
    var year = parseInt(parts[0], 10) - 1;
    return year + "-" + parts[1];
  }

  // 「遠銀－市場」方向文字：保留正負號，並以明確詞彙描述（領先／落後／高於／低於）
  function relativeText(gap, verbPair, digits) {
    if (digits === undefined) digits = 2;
    if (!isFiniteNumber(gap)) return { text: "—", cls: "delta-na" };
    var rounded = Number(Math.abs(gap).toFixed(digits));
    var verb = gap >= 0 ? verbPair[0] : verbPair[1];
    var cls = deltaClass(Number(gap.toFixed(digits)));
    return { text: verb + "市場 " + rounded.toFixed(digits) + " pp", cls: cls };
  }

  // ------------------------------------------------------------------
  // 方向感知比較工具（純函式，供同業競爭位置／排名方向判讀使用，亦可於
  // Node 環境下單獨測試，見檔案末端的 module.exports 匯出區塊）。
  // ------------------------------------------------------------------

  /**
   * 依指標方向（higher_is_better／lower_is_better）比較 self 與 other 兩數值。
   * 回傳 1＝self領先、-1＝self落後、0＝兩者相同、null＝任一值缺失無法比較。
   * 排名本身（名次）恆為數字越小越好，與指標自身方向無關，不適用本函式。
   */
  function compareByDirection(metric, selfRaw, otherRaw) {
    if (!isFiniteNumber(selfRaw) || !isFiniteNumber(otherRaw)) return null;
    if (selfRaw === otherRaw) return 0;
    var selfIsNumericallyBigger = selfRaw > otherRaw;
    var direction = metric && metric.direction === "lower_is_better" ? "lower_is_better" : "higher_is_better";
    var selfIsBetter = direction === "lower_is_better" ? !selfIsNumericallyBigger : selfIsNumericallyBigger;
    return selfIsBetter ? 1 : -1;
  }

  /**
   * 排名變化方向：名次數字越小越好，恆定不受指標方向影響。
   * 回傳 1＝進步（名次數字變小）、-1＝退步、0＝持平、null＝資料不足。
   */
  function rankChangeDirection(currentRank, compareRank) {
    if (!isFiniteNumber(currentRank) || !isFiniteNumber(compareRank)) return null;
    if (currentRank === compareRank) return 0;
    return currentRank < compareRank ? 1 : -1;
  }

  /**
   * 排名變化徽章（純函式）：依臺灣股票看盤習慣，排名進步＝紅色，退步＝綠色，
   * 持平＝灰色；同時以箭頭與文字雙重表示方向，不得只靠顏色傳達。
   * 回傳 {text, cls}；cls 沿用全站 delta-pos／delta-neg／delta-zero／delta-na 色彩類別。
   */
  function rankChangeBadge(currentRank, compareRank, basisLabel) {
    var basis = basisLabel || "較去年同月";
    var dir = rankChangeDirection(currentRank, compareRank);
    if (dir === null) return { text: "", cls: "delta-na" };
    if (dir === 0) return { text: basis + "持平", cls: "delta-zero" };
    var diff = Math.abs(compareRank - currentRank);
    return dir > 0
      ? { text: basis + "上升" + diff + "名", cls: "delta-pos" }
      : { text: basis + "下降" + diff + "名", cls: "delta-neg" };
  }

  /** 排名比較基期：當月指標為去年同月；YTD 指標為去年同期（相同月份之累計數據方式）。 */
  function rankBasisLabel(pType) {
    return pType === "ytd" ? "較去年同期" : "較去年同月";
  }

  // ==================================================================
  // 二、資料查找工具
  // ==================================================================

  function findMarket(period) {
    for (var i = 0; i < state.marketData.length; i++) {
      if (state.marketData[i].period === period) return state.marketData[i];
    }
    return null;
  }

  function findFarEastern(period) {
    for (var i = 0; i < state.issuerData.length; i++) {
      var r = state.issuerData[i];
      if (r.period === period && r.issuer_name === FAR_EASTERN_NAME) return r;
    }
    return null;
  }

  function issuersInPeriod(period) {
    return state.issuerData.filter(function (r) { return r.period === period; });
  }

  function periodsForRange(period, range, customStart, customEnd) {
    var idx = state.periods.indexOf(period);
    if (idx < 0) return [];
    if (range === "custom" && customStart && customEnd) {
      return state.periods.filter(function (p) { return p >= customStart && p <= customEnd; });
    }
    var n = parseInt(range, 10);
    if (!isFiniteNumber(n)) n = 6;
    var start = Math.max(0, idx - n + 1);
    return state.periods.slice(start, idx + 1);
  }

  // ==================================================================
  // 三、指標目錄（集中管理之指標 metadata：方向、單位、數據方式、是否支援市占率／排名）
  // ==================================================================

  var CATEGORIES = [
    { id: "cards", label: "卡量與活躍" },
    { id: "spending", label: "消費與現金" },
    { id: "assets", label: "資產與效率" },
  ];

  var METRIC_CATALOG = {
    cards_in_force: {
      id: "cards_in_force", label: "流通卡數", category: "cards", kind: "stock",
      direction: "higher_is_better", changeUnit: "pct", availableViews: ["level"],
      supportsShare: true, supportsRank: true,
      fmtRaw: fmtInt, unit: "張", trendUnit: "萬張", toTrendValue: function (v) { return isFiniteNumber(v) ? v / 10000 : v; },
      f: {
        raw: "cards_in_force", mom: "cards_in_force_mom_pct", yoy: "cards_in_force_yoy_pct",
        share: "cards_in_force_market_share_pct",
        issuerRank: "cards_in_force_issuer_rank", bankRank: "cards_in_force_bank_rank",
      },
    },
    active_cards: {
      id: "active_cards", label: "有效卡數", category: "cards", kind: "stock",
      direction: "higher_is_better", changeUnit: "pct", availableViews: ["level"],
      supportsShare: true, supportsRank: true,
      fmtRaw: fmtInt, unit: "張", trendUnit: "萬張", toTrendValue: function (v) { return isFiniteNumber(v) ? v / 10000 : v; },
      f: {
        raw: "active_cards", mom: "active_cards_mom_pct", yoy: "active_cards_yoy_pct",
        share: "active_cards_market_share_pct",
        issuerRank: "active_cards_issuer_rank", bankRank: "active_cards_bank_rank",
      },
    },
    cards_issued: {
      id: "cards_issued", label: "發卡數", category: "cards", kind: "flow",
      direction: "higher_is_better", changeUnit: "pct", availableViews: ["month", "ytd"],
      supportsShare: true, supportsRank: true,
      fmtRaw: fmtInt, unit: "張",
      month: {
        raw: "cards_issued_month", mom: "cards_issued_month_mom_pct", yoy: "cards_issued_month_yoy_pct",
        share: "cards_issued_month_market_share_pct",
        issuerRank: "cards_issued_month_issuer_rank", bankRank: "cards_issued_month_bank_rank",
      },
      ytd: {
        raw: "cards_issued_ytd", yoy: "cards_issued_ytd_yoy_pct",
        share: "cards_issued_ytd_market_share_pct",
        issuerRank: "cards_issued_ytd_issuer_rank", bankRank: "cards_issued_ytd_bank_rank",
      },
    },
    effective_card_rate_pct: {
      // 比率型指標：市占率對其數學上無意義（無法計算「比率的市占率」），故 supportsShare=false；
      // 但依數值排序仍是有效的同業比較方式，故 supportsRank=true。詳見 calculation-rules.md 8b.4.1。
      id: "effective_card_rate_pct", label: "有效卡率", category: "assets", kind: "ratio",
      direction: "higher_is_better", changeUnit: "pp", availableViews: ["ratio"],
      supportsShare: false, supportsRank: true,
      fmtRaw: fmtPlainPct, unit: "%",
      f: {
        raw: "effective_card_rate_pct", mom: "effective_card_rate_pct_mom_pp", yoy: "effective_card_rate_pct_yoy_pp", yoyIsPp: true,
        issuerRank: "effective_card_rate_pct_issuer_rank", bankRank: "effective_card_rate_pct_bank_rank",
      },
    },
    purchase_amount: {
      id: "purchase_amount", label: "簽帳金額（不含預借現金）", shortLabel: "累計簽帳金額", category: "spending", kind: "flow",
      direction: "higher_is_better", changeUnit: "pct", availableViews: ["month", "ytd"],
      supportsShare: true, supportsRank: true,
      fmtRaw: fmt100m, unit: "億元",
      month: {
        raw: "purchase_amount_month", raw100m: "purchase_amount_month_100m", mom: "purchase_amount_month_mom_pct",
        yoy: "purchase_amount_month_yoy_pct", share: "purchase_amount_market_share_pct",
        issuerRank: "purchase_amount_month_issuer_rank", bankRank: "purchase_amount_month_bank_rank",
      },
      ytd: {
        raw: "purchase_amount_ytm", raw100m: "purchase_amount_ytm_100m",
        yoy: "purchase_amount_ytm_yoy_pct", share: "purchase_amount_ytm_market_share_pct",
        issuerRank: "purchase_amount_ytm_issuer_rank", bankRank: "purchase_amount_ytm_bank_rank",
      },
    },
    purchase_plus_cash_amount: {
      id: "purchase_plus_cash_amount", label: "簽帳金額＋預借現金", category: "spending", kind: "flow",
      direction: "higher_is_better", changeUnit: "pct", availableViews: ["month", "ytd"],
      supportsShare: true, supportsRank: true,
      fmtRaw: fmt100m, unit: "億元",
      month: {
        raw: "purchase_plus_cash_amount_month", raw100m: "purchase_plus_cash_amount_month_100m",
        mom: "purchase_plus_cash_amount_month_mom_pct", yoy: "purchase_plus_cash_amount_month_yoy_pct",
        share: "purchase_plus_cash_amount_month_market_share_pct",
        issuerRank: "purchase_plus_cash_amount_month_issuer_rank", bankRank: "purchase_plus_cash_amount_month_bank_rank",
      },
      ytd: {
        raw: "purchase_plus_cash_amount_ytd", raw100m: "purchase_plus_cash_amount_ytd_100m",
        yoy: "purchase_plus_cash_amount_ytd_yoy_pct", share: "purchase_plus_cash_amount_ytd_market_share_pct",
        issuerRank: "purchase_plus_cash_amount_ytd_issuer_rank", bankRank: "purchase_plus_cash_amount_ytd_bank_rank",
      },
    },
    per_card_spending: {
      // 每卡平均型指標：市占率對其數學上無意義，故 supportsShare=false；排名有意義，supportsRank=true。
      id: "per_card_spending", label: "流通卡每卡簽帳金額", category: "assets", kind: "flow_no_share",
      direction: "higher_is_better", changeUnit: "pct", availableViews: ["month", "ytd"],
      supportsShare: false, supportsRank: true,
      fmtRaw: fmtYuanPerCard, unit: "元/張",
      month: {
        raw: "per_card_spending_month", yoy: "per_card_spending_month_yoy_pct",
        issuerRank: "per_card_spending_month_issuer_rank", bankRank: "per_card_spending_month_bank_rank",
      },
      ytd: {
        raw: "per_card_spending_ytd", yoy: "per_card_spending_ytd_yoy_pct",
        issuerRank: "per_card_spending_ytd_issuer_rank", bankRank: "per_card_spending_ytd_bank_rank",
      },
    },
    total_assets: {
      // 業務數據方式（使用者確認）：信用卡應收帳款＝循環信用餘額＋未到期分期付款餘額。
      // 注意：這不是銀行整體資產負債表之「總資產」，顯示文字一律使用「信用卡應收帳款」，
      // 不得單獨顯示「總資產」，避免誤讀為銀行整體資產規模。詳見 calculation-rules.md 8b.4。
      // 性質為存量（月底值），不計算YTD；為可加總金額（非比率），故市占率與排名皆提供。
      id: "total_assets", label: "信用卡應收帳款", category: "assets", kind: "stock",
      direction: "higher_is_better", changeUnit: "pct", availableViews: ["level"],
      supportsShare: true, supportsRank: true,
      fmtRaw: fmt100m, unit: "億元",
      f: {
        raw: "total_assets", mom: "total_assets_mom_pct", yoy: "total_assets_yoy_pct",
        share: "total_assets_market_share_pct",
        issuerRank: "total_assets_issuer_rank", bankRank: "total_assets_bank_rank",
      },
      ytdChangeField: "total_assets_ytd_change_pct",
      scopeNote: "循環信用餘額＋未到期分期付款餘額；為信用卡應收帳款規模，非銀行整體資產負債表總資產。",
    },
  };

  var METRIC_ORDER = [
    "purchase_amount", "purchase_plus_cash_amount", "cards_issued",
    "cards_in_force", "active_cards",
    "effective_card_rate_pct", "per_card_spending", "total_assets",
  ];

  /**
   * 首頁「全指標管理總覽」專用分類（僅供本月總覽頁表格分組呈現），與
   * METRIC_CATALOG.category／CATEGORIES（供趨勢／同業比較／資料明細頁之
   * 指標下拉選單使用）各自獨立，互不影響，避免調整首頁分組牽動其他頁面。
   */
  var OVERVIEW_GROUPS = [
    { id: "cards_activity", label: "卡量與活躍", metrics: ["cards_in_force", "active_cards", "effective_card_rate_pct", "cards_issued"] },
    { id: "spending", label: "簽帳表現", metrics: ["purchase_amount", "purchase_plus_cash_amount", "per_card_spending"] },
    { id: "assets", label: "帳款規模", metrics: ["total_assets"] },
  ];

  function metricSupportsPeriodType(metric) {
    return metric.kind === "flow" || metric.kind === "flow_no_share";
  }

  /** 市占率是否有意義：僅可加總之金額／存量型指標支援；比率型、每卡平均型指標數學上無意義。 */
  function metricSupportsShare(metric) {
    return !!metric.supportsShare;
  }

  /** 排名是否有意義：依數值排序對任何可比較數值皆有意義，涵蓋金額、存量、比率、每卡平均型指標。 */
  function metricSupportsRank(metric) {
    return !!metric.supportsRank;
  }

  function currentPeriodType(metric) {
    return metricSupportsPeriodType(metric) ? state.periodType : "month";
  }

  function compareModeLabel(metric) {
    if (metric.kind === "unavailable") return "尚無資料來源";
    if (metric.kind === "ratio") return "比率（pp）";
    if (metric.kind === "stock") return metric.ytdChangeField ? "月底值／較年初變動" : "月底值";
    return state.periodType === "ytd" ? "YTD（年初至今累計）" : "單月";
  }

  /** 讀取某指標於某筆紀錄之統一視圖。periodType 僅對流量型指標生效。 */
  function metricView(metric, record, periodType) {
    if (!record || !metric || metric.kind === "unavailable") return {};
    var spec;
    if (metric.kind === "stock" || metric.kind === "ratio") {
      spec = metric.f;
    } else {
      spec = (periodType === "ytd") ? metric.ytd : metric.month;
    }
    if (!spec) return {};
    return {
      raw: record[spec.raw],
      raw100m: spec.raw100m ? record[spec.raw100m] : undefined,
      mom: spec.mom ? record[spec.mom] : undefined,
      yoy: record[spec.yoy],
      yoyIsPp: metric.changeUnit === "pp",
      share: spec.share ? record[spec.share] : undefined,
      issuerRank: spec.issuerRank ? record[spec.issuerRank] : undefined,
      bankRank: spec.bankRank ? record[spec.bankRank] : undefined,
      ytdChange: metric.ytdChangeField ? record[metric.ytdChangeField] : undefined,
    };
  }

  function formatMetricValue(metric, raw, raw100m) {
    if (metric.fmtRaw === fmt100m) {
      return fmt100m(raw100m !== undefined ? raw100m : (isFiniteNumber(raw) ? raw / 100000 : null));
    }
    return metric.fmtRaw(raw);
  }

  function formatMetricTrendValue(metric, raw, raw100m) {
    if (metric.toTrendValue) return metric.toTrendValue(raw);
    if (metric.fmtRaw === fmt100m) return raw100m !== undefined ? raw100m : (isFiniteNumber(raw) ? raw / 100000 : null);
    return raw;
  }

  function formatMetricYoy(view) {
    return view.yoyIsPp ? fmtPp(view.yoy) : fmtPct(view.yoy);
  }

  /** 比率型指標（changeUnit==='pp'）之期間變化一律用 pp，不得顯示為一般百分比成長率。 */
  function formatYoyLikeValue(metric, v) {
    return metric.changeUnit === "pp" ? fmtPp(v).text : fmtPct(v).text;
  }

  function metricPeriodSuffix(metric) {
    if (metric.kind === "unavailable") return "";
    if (metric.kind === "ratio" || metric.kind === "stock") return "｜月底";
    return state.periodType === "ytd" ? "｜YTD" : "｜單月";
  }

  // ==================================================================
  // 四、迷你趨勢線（sparkline）
  // ==================================================================

  function buildSparklineSVG(values, colorKey, invert) {
    var width = 160, height = 32, pad = 3;
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("class", "spark-svg");
    svg.setAttribute("aria-hidden", "true");

    var n = values.length;
    var pts = [];
    for (var i = 0; i < n; i++) { if (isFiniteNumber(values[i])) pts.push({ i: i, v: values[i] }); }
    if (pts.length < 2 || n < 2) return svg;

    var vals = pts.map(function (p) { return p.v; });
    var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
    if (minV === maxV) { minV -= 1; maxV += 1; }

    function X(i) { return pad + (i / (n - 1)) * (width - pad * 2); }
    function Y(v) {
      var t = (v - minV) / (maxV - minV);
      if (invert) t = 1 - t;
      return height - pad - t * (height - pad * 2);
    }

    var d = "";
    pts.forEach(function (p, idx) { d += (idx === 0 ? "M" : "L") + X(p.i).toFixed(1) + " " + Y(p.v).toFixed(1) + " "; });

    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", d.trim());
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--series-" + colorKey + ")");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);

    var last = pts[pts.length - 1];
    var dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("cx", X(last.i).toFixed(1));
    dot.setAttribute("cy", Y(last.v).toFixed(1));
    dot.setAttribute("r", "2.6");
    dot.setAttribute("fill", "var(--series-" + colorKey + ")");
    svg.appendChild(dot);
    return svg;
  }

  // ==================================================================
  // 五、通用折線圖（SVG 依容器實際寬度繪製；字級、線寬、圓點皆為實際 px，不隨寬度縮放）
  // ==================================================================

  var CHART_AXIS_PX = 13;
  var CHART_LINE_WIDTH = 2.4;
  var CHART_DOT_R = 2.8;
  var CHART_DOT_R_SELECTED = 4.2;
  var CHART_H_MAIN = 300;
  var CHART_H_SMALL = 260;

  /** 分析期間說明：「分析期間：民國114年8月至115年7月｜共12個月」（依實際序列動態產生）。 */
  function customRangeCaption(startPeriod, endPeriod) {
    var a = rocYearMonthShort(startPeriod), b = rocYearMonthShort(endPeriod);
    return a + "–" + b;
  }

  function analysisPeriodCaption(periods) {
    if (!periods.length) return "";
    var first = periods[0], last = periods[periods.length - 1];
    var fy = parseInt(first.slice(0, 4), 10) - 1911, ly = parseInt(last.slice(0, 4), 10) - 1911;
    return "分析期間：民國" + fy + "年" + parseInt(first.slice(5, 7), 10) + "月至" + ly + "年" +
      parseInt(last.slice(5, 7), 10) + "月｜共" + periods.length + "個月";
  }

  function textWidthEstimate(text, fontPx) {
    var w = 0;
    String(text).split("").forEach(function (ch) {
      w += /[^\x00-\xff]/.test(ch) ? fontPx : fontPx * 0.6;
    });
    return w;
  }

  /** 民國年月短格式（X 軸），例如 "2025-08" → "114/08"。 */
  function rocYearMonthShort(period) {
    var y = parseInt(period.slice(0, 4), 10) - 1911;
    return y + "/" + period.slice(5, 7);
  }

  /** 民國年月完整格式（tooltip），例如 "2026-01" → "民國115年1月（2026-01）"。 */
  function periodFullLabel(period) {
    var y = parseInt(period.slice(0, 4), 10) - 1911;
    return "民國" + y + "年" + parseInt(period.slice(5, 7), 10) + "月（" + period + "）";
  }

  /** 是否為跨年度之1月（非序列第一筆），用於年度交界標示與 YTD 斷線。 */
  function isYearBoundary(periods, i) {
    return i > 0 && periods[i].slice(5, 7) === "01";
  }

  /** 依Y軸最長刻度文字動態保留左側空間，刻度不得被 SVG 邊界裁切。 */
  function axisPadLeft(tickLabels) {
    var w = 0;
    tickLabels.forEach(function (t) { w = Math.max(w, textWidthEstimate(t, CHART_AXIS_PX)); });
    return Math.max(48, Math.ceil(w) + 16);
  }

  function decimalsForStep(step) {
    for (var d = 0; d <= 6; d++) {
      var x = step * Math.pow(10, d);
      if (Math.abs(x - Math.round(x)) < 1e-9) return d;
    }
    return 6;
  }

  /** 依資料範圍產生容易閱讀之整數或常見級距刻度（1、2、2.5、5 × 10^k）。 */
  function niceTicks(dataMin, dataMax, targetCount, includeZero) {
    var lo = dataMin, hi = dataMax;
    if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    var raw = (hi - lo) / Math.max(1, targetCount || 4);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / mag;
    var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    var decimals = decimalsForStep(step);
    var min = Math.floor(lo / step + 1e-9) * step;
    var max = Math.ceil(hi / step - 1e-9) * step;
    var ticks = [];
    for (var k = 0; k < 60; k++) {
      var v = Number((min + k * step).toFixed(decimals));
      ticks.push(v);
      if (v >= max - 1e-9) break;
    }
    return { min: Number(min.toFixed(decimals)), max: Number(max.toFixed(decimals)), step: step, ticks: ticks, decimals: decimals };
  }

  function formatTickLabel(v, unit, decimals) {
    var value = v === 0 ? 0 : v;
    return value.toLocaleString("zh-TW", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + (unit || "");
  }

  /**
   * X 軸標籤選擇：起點、跨年度 1 月、終點一律保留；其餘依寬度自動略過，
   * 不以壓縮字寬或縮放文字的方式塞入。回傳應顯示之索引陣列（遞增）。
   */
  /** 月份刻度：保留最後一個月份；較早的刻度若與之重疊則略去，避免端點刻度互相壓字。 */
  function selectAxisLabelIndices(periods, xOf, fontPx) {
    var raw = selectAxisLabelIndicesRaw(periods, xOf, fontPx);
    if (raw.length < 2) return raw;
    var n = periods.length;
    function labelW(i) { return textWidthEstimate(rocYearMonthShort(periods[i]), fontPx) + 8; }
    var out = [raw[raw.length - 1]];
    for (var k = raw.length - 2; k >= 0; k--) {
      var a = raw[k], b = out[0];
      if (xOf(b) - xOf(a) >= (labelW(a) + labelW(b)) / 2 + 14) out.unshift(a);
    }
    return out;
  }

  function selectAxisLabelIndicesRaw(periods, xOf, fontPx) {
    var n = periods.length;
    var mandatory = {};
    mandatory[0] = true;
    mandatory[n - 1] = true;
    for (var m = 1; m < n; m++) { if (isYearBoundary(periods, m)) mandatory[m] = true; }
    function labelW(i) { return textWidthEstimate(rocYearMonthShort(periods[i]), fontPx) + 8; }
    function collisionFree(list) {
      for (var k = 1; k < list.length; k++) {
        var a = list[k - 1], b = list[k];
        if (xOf(b) - xOf(a) < (labelW(a) + labelW(b)) / 2 + 14) return false;
      }
      return true;
    }
    for (var step = 1; step <= n; step++) {
      var cands = [];
      for (var j = 0; j < n; j++) { if (mandatory[j] || j % step === 0) cands.push(j); }
      if (collisionFree(cands)) return cands;
    }
    return Object.keys(mandatory).map(Number).sort(function (a, b) { return a - b; });
  }

  /**
   * 數值刻度標籤選擇（與 selectAxisLabelIndicesRaw 同一套「依步距遞增找無碰撞組合」演算法，
   * 泛化為任意刻度陣列使用，避免橫向長條圖另外土法煉鋼出一套可能重疊的邏輯）。
   * labelAt(i)／xAt(i)：取得第 i 個刻度的文字與繪圖座標；必保留首尾刻度。
   */
  function selectNumericTickIndices(n, labelAt, xAt, fontPx) {
    if (n <= 2) { var all = []; for (var i0 = 0; i0 < n; i0++) all.push(i0); return all; }
    function labelW(i) { return textWidthEstimate(labelAt(i), fontPx) + 8; }
    function collisionFree(list) {
      for (var k = 1; k < list.length; k++) {
        var a = list[k - 1], b = list[k];
        if (xAt(b) - xAt(a) < (labelW(a) + labelW(b)) / 2 + 14) return false;
      }
      return true;
    }
    for (var step = 1; step <= n; step++) {
      var cands = [];
      for (var j = 0; j < n; j++) { if (j === 0 || j === n - 1 || j % step === 0) cands.push(j); }
      if (collisionFree(cands)) return cands;
    }
    return [0, n - 1];
  }

  /** 系列顏色：可指定 s.color（自訂比較之銀行顏色），否則使用全站對象識別色變數。 */
  function seriesCss(s) { return s.color ? s.color : "var(--series-" + s.colorVar + ")"; }

  function buildLineChart(wrapEl, periods, seriesArr, opts) {
    opts = opts || {};
    wrapEl.innerHTML = "";

    var n = periods.length;
    var height = opts.height || 260;
    var width = Math.max(280, Math.floor(wrapEl.clientWidth || opts.width || 640));
    var padR = 18, padT = 26, padB = 30;

    if (seriesArr.length > 1 && opts.showLegend !== false) {
      var legend = document.createElement("div");
      legend.className = "chart-legend";
      seriesArr.forEach(function (s) {
        var item = document.createElement("span");
        item.className = "chart-legend-item";
        // 圖例以線段樣式呈現（實線／虛線），與圖上線條一致，避免只靠色塊辨識。
        var dash = s.dashed ? ' stroke-dasharray="5 3"' : "";
        var op = s.opacity ? ' stroke-opacity="' + s.opacity + '"' : "";
        item.innerHTML = '<svg class="chart-legend-line" width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="' + seriesCss(s) + '" stroke-width="3" stroke-linecap="round"' + dash + op + '/></svg>' + escapeHtml(s.label);
        legend.appendChild(item);
      });
      wrapEl.appendChild(legend);
    }

    var holder = document.createElement("div");
    holder.className = "linechart-holder";
    wrapEl.appendChild(holder);

    var srTable = document.createElement("table");
    srTable.className = "sr-only";
    var srHead = "<thead><tr><th>月份</th>" + seriesArr.map(function (s) { return "<th>" + escapeHtml(s.label) + "</th>"; }).join("") + "</tr></thead>";
    var srBody = "<tbody>" + periods.map(function (p, i) {
      return "<tr><td>" + escapeHtml(periodFullLabel(p)) + "</td>" + seriesArr.map(function (s) {
        var v = s.values[i];
        return "<td>" + escapeHtml(isFiniteNumber(v) ? s.fmt(v) : "—") + "</td>";
      }).join("") + "</tr>";
    }).join("") + "</tbody>";
    srTable.innerHTML = srHead + srBody;
    wrapEl.appendChild(srTable);

    if (n < 2) {
      var emptyMsg = document.createElement("p");
      emptyMsg.className = "scope-note";
      emptyMsg.textContent = "資料不足，無法繪製趨勢圖。";
      holder.appendChild(emptyMsg);
      return;
    }

    var allVals = [];
    seriesArr.forEach(function (s) { s.values.forEach(function (v) { if (isFiniteNumber(v)) allVals.push(v); }); });
    if (!allVals.length) allVals = [0, 1];
    var dataMin = Math.min.apply(null, allVals);
    var dataMax = Math.max.apply(null, allVals);

    var domain;
    if (opts.yDomainMin !== undefined && opts.yDomainMax !== undefined) {
      domain = { min: opts.yDomainMin, max: opts.yDomainMax, ticks: opts.yTicks || [opts.yDomainMin, opts.yDomainMax], decimals: 0 };
    } else {
      domain = niceTicks(dataMin, dataMax, 4, !!opts.zeroBaseline);
    }
    var tickFmt = opts.yTickFormat || function (v) { return formatTickLabel(v, opts.unit || "", domain.decimals); };

    var padL = axisPadLeft(domain.ticks.map(tickFmt));

    var plotL = padL + 10, plotR = width - padR - 10;
    var plotW = plotR - plotL;
    var plotH = height - padT - padB;
    var domainRange = (domain.max - domain.min) || 1;

    function X(i) { return n === 1 ? plotL + plotW / 2 : plotL + (i / (n - 1)) * plotW; }
    function Y(v) {
      var t = (v - domain.min) / domainRange;
      if (opts.invertY) t = 1 - t;
      return padT + (1 - t) * plotH;
    }

    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("class", "linechart-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.ariaLabel || "趨勢圖");
    svg.setAttribute("tabindex", "0");
    holder.appendChild(svg);

    var tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    holder.appendChild(tooltip);

    domain.ticks.forEach(function (tv) {
      var ty = Y(tv);
      var gline = document.createElementNS(SVGNS, "line");
      gline.setAttribute("x1", padL); gline.setAttribute("x2", width - padR);
      gline.setAttribute("y1", ty); gline.setAttribute("y2", ty);
      gline.setAttribute("class", "chart-gridline");
      svg.appendChild(gline);

      var tlabel = document.createElementNS(SVGNS, "text");
      tlabel.setAttribute("x", padL - 8);
      tlabel.setAttribute("y", ty + 4.5);
      tlabel.setAttribute("text-anchor", "end");
      tlabel.setAttribute("class", "chart-axis-label");
      tlabel.textContent = tickFmt(tv);
      svg.appendChild(tlabel);
    });

    if (opts.zeroBaseline && domain.min < 0 && domain.max > 0) {
      var zy = Y(0);
      var zline = document.createElementNS(SVGNS, "line");
      zline.setAttribute("x1", padL); zline.setAttribute("x2", width - padR);
      zline.setAttribute("y1", zy); zline.setAttribute("y2", zy);
      zline.setAttribute("class", "chart-zero-line");
      svg.appendChild(zline);
    }

    for (var yi = 1; yi < n; yi++) {
      if (!isYearBoundary(periods, yi)) continue;
      var dx = (X(yi - 1) + X(yi)) / 2;
      var dline = document.createElementNS(SVGNS, "line");
      dline.setAttribute("x1", dx); dline.setAttribute("x2", dx);
      dline.setAttribute("y1", padT); dline.setAttribute("y2", padT + plotH);
      dline.setAttribute("class", "chart-year-divider");
      svg.appendChild(dline);
      var ylabel = document.createElementNS(SVGNS, "text");
      ylabel.setAttribute("x", dx + 5);
      ylabel.setAttribute("y", padT - 8);
      ylabel.setAttribute("text-anchor", "start");
      ylabel.setAttribute("class", "chart-year-label");
      ylabel.textContent = "民國" + (parseInt(periods[yi].slice(0, 4), 10) - 1911) + "年";
      svg.appendChild(ylabel);
    }

    selectAxisLabelIndices(periods, X, CHART_AXIS_PX).forEach(function (li) {
      var lx = X(li);
      var ltext = document.createElementNS(SVGNS, "text");
      ltext.setAttribute("x", lx);
      ltext.setAttribute("y", height - 8);
      ltext.setAttribute("text-anchor", li === 0 ? "start" : li === n - 1 ? "end" : "middle");
      ltext.setAttribute("class", "chart-axis-label");
      ltext.textContent = opts.xLabelFn ? opts.xLabelFn(periods[li]) : rocYearMonthShort(periods[li]);
      svg.appendChild(ltext);
    });

    var selIdx = periods.indexOf(opts.selectedPeriod);
    if (selIdx >= 0) {
      var selX = X(selIdx);
      var selLine = document.createElementNS(SVGNS, "line");
      selLine.setAttribute("x1", selX); selLine.setAttribute("x2", selX);
      selLine.setAttribute("y1", padT); selLine.setAttribute("y2", padT + plotH);
      selLine.setAttribute("class", "chart-selected-line");
      svg.appendChild(selLine);
    }

    seriesArr.forEach(function (s) {
      var pts = [];
      var d = "";
      var prevConnected = false;
      for (var i = 0; i < n; i++) {
        var v = s.values[i];
        if (!isFiniteNumber(v)) { prevConnected = false; continue; }
        var px = X(i), py = Y(v);
        // YTD 系列跨年度（12月→隔年1月）不得直接連線：YTD 於每年1月重新起算，
        // 12月至隔年1月的數值落差是「歸零重算」而非業務驟降，連線會造成誤導。
        var breakHere = opts.breakAtNewYear && isYearBoundary(periods, i);
        d += (!prevConnected || breakHere ? "M" : "L") + px.toFixed(1) + " " + py.toFixed(1) + " ";
        pts.push({ i: i, x: px, y: py, v: v });
        prevConnected = true;
      }
      var path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", d.trim());
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", seriesCss(s));
      if (s.dashed) path.setAttribute("stroke-dasharray", "6 4");
      if (s.opacity) path.setAttribute("stroke-opacity", s.opacity);
      path.setAttribute("stroke-width", CHART_LINE_WIDTH);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);

      pts.forEach(function (p) {
        var c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
        c.setAttribute("r", p.i === selIdx ? CHART_DOT_R_SELECTED : CHART_DOT_R);
        c.setAttribute("fill", seriesCss(s));
        svg.appendChild(c);
      });
    });

    if (opts.endLabel) {
      var ends = [];
      seriesArr.forEach(function (s) {
        for (var q = n - 1; q >= 0; q--) {
          if (isFiniteNumber(s.values[q])) {
            // deltaColor：變動數字端點依全站紅漲綠跌著色（文字仍保留正負號）
            var endCls = s.deltaColor ? deltaClass(Number(s.values[q].toFixed(2))) : "";
            // 找前一個有效點判斷線段走向：若線段從上方降至端點，標示改放端點下方，避免壓在線上（單一序列時尤其明顯）。
            var prevIdx = -1;
            for (var pq = q - 1; pq >= 0; pq--) { if (isFiniteNumber(s.values[pq])) { prevIdx = pq; break; } }
            var fromAbove = prevIdx >= 0 && Y(s.values[prevIdx]) < Y(s.values[q]);
            ends.push({ x: X(q), y: Y(s.values[q]), text: (s.endName || "") + s.fmt(s.values[q]), cls: endCls, fromAbove: fromAbove });
            break;
          }
        }
      });
      // 數值接近時，較高者標示於點上方、較低者標示於點下方，不移動點位本身，避免標籤壓在另一條線或另一個標籤上。
      ends.sort(function (p, r) { return p.y - r.y; });
      for (var ei = 1; ei < ends.length; ei++) {
        if (ends[ei].y - ends[ei - 1].y < 16) ends[ei].below = true;
      }
      ends.forEach(function (en) {
        var et = document.createElementNS(SVGNS, "text");
        var below = en.below || en.fromAbove;
        et.setAttribute("x", Math.min(en.x + 4, width - 2));
        et.setAttribute("y", below ? en.y + 16 : en.y - 7);
        et.setAttribute("text-anchor", "end");
        et.setAttribute("class", "chart-end-label" + (en.cls ? " " + en.cls : ""));
        et.textContent = en.text;
        svg.appendChild(et);
      });
    }

    var hoverDots = seriesArr.map(function (s) {
      var c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("r", 4.6);
      c.setAttribute("fill", "var(--surface-1)");
      c.setAttribute("stroke", seriesCss(s));
      c.setAttribute("stroke-width", "2");
      c.setAttribute("visibility", "hidden");
      svg.appendChild(c);
      return c;
    });

    function showIndex(idx) {
      idx = Math.max(0, Math.min(n - 1, idx));
      var lines = [periodFullLabel(periods[idx])];
      var vals = [];
      seriesArr.forEach(function (s, si) {
        var v = s.values[idx];
        vals.push(v);
        lines.push(s.label + "：" + (isFiniteNumber(v) ? s.fmt(v) : "—"));
        var dot = hoverDots[si];
        if (isFiniteNumber(v)) {
          dot.setAttribute("cx", X(idx)); dot.setAttribute("cy", Y(v));
          dot.setAttribute("visibility", "visible");
        } else {
          dot.setAttribute("visibility", "hidden");
        }
      });
      if (opts.showGap && vals.length === 2 && isFiniteNumber(vals[0]) && isFiniteNumber(vals[1])) {
        var gap = vals[0] - vals[1];
        lines.push((opts.gapLabel || "遠銀－市場") + "：" + fmtPp(gap).text);
      }
      tooltip.innerHTML = lines.map(function (t) { return escapeHtml(t); }).join("<br>");
      tooltip.hidden = false;
      var leftPx = X(idx);
      tooltip.style.left = leftPx + "px";
      tooltip.style.transform = leftPx > width * 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)";
    }

    function hideTooltip() {
      tooltip.hidden = true;
      hoverDots.forEach(function (d) { d.setAttribute("visibility", "hidden"); });
    }

    var overlay = document.createElementNS(SVGNS, "rect");
    overlay.setAttribute("x", plotL); overlay.setAttribute("y", padT);
    overlay.setAttribute("width", plotW); overlay.setAttribute("height", plotH);
    overlay.setAttribute("fill", "transparent");
    overlay.style.cursor = "crosshair";
    svg.appendChild(overlay);

    overlay.addEventListener("mousemove", function (evt) {
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      var scaleX = width / rect.width;
      var mx = (evt.clientX - rect.left) * scaleX;
      var idx = Math.round(((mx - plotL) / plotW) * (n - 1));
      showIndex(idx);
    });
    overlay.addEventListener("mouseleave", hideTooltip);

    var focusIdx = selIdx >= 0 ? selIdx : n - 1;
    svg.addEventListener("focus", function () { showIndex(focusIdx); });
    svg.addEventListener("blur", hideTooltip);
    svg.addEventListener("keydown", function (evt) {
      if (evt.key === "ArrowLeft") { focusIdx = Math.max(0, focusIdx - 1); showIndex(focusIdx); evt.preventDefault(); }
      else if (evt.key === "ArrowRight") { focusIdx = Math.min(n - 1, focusIdx + 1); showIndex(focusIdx); evt.preventDefault(); }
    });
  }

  // ==================================================================
  // 六、同業／競爭位置工具
  // ==================================================================

  /** 銀行簡稱對照（完整名稱保留於 title 與資料明細頁；不隨意截字）。 */
  var BANK_SHORT_NAMES = {
    "臺灣銀行": "臺灣銀行", "臺灣土地銀行": "臺灣土地銀行", "合作金庫商業銀行": "合作金庫",
    "第一商業銀行": "第一銀行", "華南商業銀行": "華南銀行", "彰化商業銀行": "彰化銀行",
    "上海商業儲蓄銀行": "上海銀行", "台北富邦商業銀行": "台北富邦", "國泰世華商業銀行": "國泰世華",
    "高雄銀行": "高雄銀行", "兆豐國際商業銀行": "兆豐銀行", "花旗(台灣)商業銀行": "花旗台灣",
    "臺灣中小企業銀行": "臺灣中小企銀", "渣打國際商業銀行": "渣打銀行", "台中商業銀行": "台中銀行",
    "滙豐(台灣)商業銀行": "滙豐台灣", "華泰商業銀行": "華泰銀行", "臺灣新光商業銀行": "新光銀行",
    "陽信商業銀行": "陽信銀行", "三信商業銀行": "三信銀行", "聯邦商業銀行": "聯邦銀行",
    "遠東國際商業銀行": "遠東商銀", "元大商業銀行": "元大銀行", "永豐商業銀行": "永豐銀行",
    "玉山商業銀行": "玉山銀行", "凱基商業銀行": "凱基銀行", "星展(台灣)商業銀行": "星展台灣",
    "台新國際商業銀行": "台新銀行", "安泰商業銀行": "安泰銀行", "中國信託商業銀行": "中國信託",
  };

  var METRIC_SHORT_NAMES = {
    cards_in_force: "流通卡數", active_cards: "有效卡數", effective_card_rate_pct: "有效卡率",
    cards_issued: "發卡數", purchase_amount: "簽帳金額", purchase_plus_cash_amount: "簽帳金額＋預借",
    per_card_spending: "每卡簽帳金額", total_assets: "信用卡應收帳款",
  };

  function bankShortName(name) {
    if (name === CMP_MARKET_TOTAL) return "整體市場（總計）";
    return Object.prototype.hasOwnProperty.call(BANK_SHORT_NAMES, name) ? BANK_SHORT_NAMES[name] : name;
  }

  /**
   * 標準競賽排名（1、2、2、4）：數值由大至小；缺值不納入排名。
   * 與 scripts/calculate_metrics.py 的 standard_competition_rank 同一套規則，用於需要「在子集合內重新排名」
   * 的情境（例如：流通卡前12大銀行內的排名），既有 processed 欄位（bankRank／issuerRank）本身是全母體排名，
   * 不適用於子集合，故在前端另以同一規則重算，不改變既有排名公式本身。
   */
  function standardCompetitionRank(items) {
    var present = items.filter(function (x) { return isFiniteNumber(x.value); });
    present.sort(function (a, b) { return b.value - a.value; });
    var ranks = {}, rank = 0, prevValue = null;
    present.forEach(function (x, idx) {
      var position = idx + 1;
      if (x.value !== prevValue) { rank = position; prevValue = x.value; }
      ranks[x.id] = rank;
    });
    return ranks;
  }

  /** 主要比較名單：所選月份月底流通卡數排名前12家銀行（依流通卡數名次；同名次以名稱穩定排序）。 */
  function top12Banks(period) {
    return issuersInPeriod(period)
      .filter(function (r) { return r.issuer_type === "bank" && isFiniteNumber(r.cards_in_force_bank_rank); })
      .sort(function (a, b) {
        if (a.cards_in_force_bank_rank !== b.cards_in_force_bank_rank) return a.cards_in_force_bank_rank - b.cards_in_force_bank_rank;
        return a.issuer_name < b.issuer_name ? -1 : a.issuer_name > b.issuer_name ? 1 : 0;
      })
      .slice(0, 12);
  }

  /** 第12名與第13名之流通卡數名次相同（並列）時為 true，須回報，不得默默擴增名單。 */
  function top12BoundaryTie(period) {
    var ranked = issuersInPeriod(period)
      .filter(function (r) { return r.issuer_type === "bank" && isFiniteNumber(r.cards_in_force_bank_rank); })
      .map(function (r) { return r.cards_in_force_bank_rank; })
      .sort(function (a, b) { return a - b; });
    return ranked.length > 12 && ranked[11] === ranked[12];
  }

  /**
   * 「遠銀排名與同業差距」用名單（純資料，依範圍）：
   * - top12：所選月份流通卡前12大銀行，名次於此12家內重新計算（標準競賽排名，與既有規則一致，不改變既有30/32家排名）。
   * - all：當月完整發卡機構名單，名次沿用既有 issuerRank 欄位（該欄位本身即為全量排名，不重算）。
   * 回傳 [{row, view, rankVal}]；rankVal 可能為 null（無排名資料）。
   */
  function peerSummaryPool(period, metric, pType, scope) {
    if (scope === "all") {
      return issuersInPeriod(period).map(function (r) {
        var view = metricView(metric, r, pType);
        return { row: r, view: view, rankVal: isFiniteNumber(view.issuerRank) ? view.issuerRank : null };
      }).filter(function (x) { return x.rankVal !== null; });
    }
    var members = top12Banks(period);
    var values = members.map(function (r) { return { id: r.issuer_name, value: displayNumber(metric, metricView(metric, r, pType)) }; });
    var ranks = standardCompetitionRank(values);
    return members.map(function (r) {
      return { row: r, view: metricView(metric, r, pType), rankVal: Object.prototype.hasOwnProperty.call(ranks, r.issuer_name) ? ranks[r.issuer_name] : null };
    });
  }

  /** 相鄰名次群組（純函式）：並列者一併列出，不任意挑選一家冒充唯一相鄰對象。rankVal 由呼叫端依範圍提供。 */
  function rankNeighbors(pool, feRank) {
    var prevRank = null, nextRank = null;
    pool.forEach(function (x) {
      var rk = x.rankVal;
      if (rk == null) return;
      if (rk < feRank && (prevRank === null || rk > prevRank)) prevRank = rk;
      if (rk > feRank && (nextRank === null || rk < nextRank)) nextRank = rk;
    });
    return {
      prev: prevRank === null ? [] : pool.filter(function (x) { return x.rankVal === prevRank; }),
      next: nextRank === null ? [] : pool.filter(function (x) { return x.rankVal === nextRank; }),
    };
  }

  /**
   * 「遠銀排名與同業差距」四張卡（純函式，依範圍動態產生）。
   * scope："top12"｜"all"；pool／prevPool：peerSummaryPool 回傳之本期／去年同期名單（各自獨立依範圍計算，
   * 前12大模式下兩期名單可能不同，不強算遠銀未入選期間的排名變化）。
   * feEntry／prevFeEntry：pool／prevPool 中屬於遠銀的項目，可能為 null（遠銀未入選）。
   */
  function buildPeerCards(metric, scope, pool, feEntry, prevPool, prevFeEntry, basisLabel) {
    var scopeWord = scope === "all" ? "全" + pool.length + "家發卡機構" : "前" + pool.length + "大銀行內";
    var rankLabel = scope === "all" ? "遠銀發卡機構排名" : "遠銀排名（" + scopeWord + "）";
    var cards = [];

    if (!feEntry) {
      cards.push({
        label: rankLabel,
        value: scope === "all" ? "缺排名資料" : "未列入當月流通卡前12大銀行",
        sub: scope === "top12" ? "名單依所選月份流通卡數選取，遠銀未入選前12大時不額外加入第13家。" : "",
      });
      cards.push({ label: "距前一名（" + scopeWord + "）", value: "不適用", sub: "遠銀未列入比較名單" });
      cards.push({ label: "領先後一名（" + scopeWord + "）", value: "不適用", sub: "遠銀未列入比較名單" });
      cards.push({ label: "同期排名變化", value: "不適用", cls: "delta-na", sub: "遠銀未列入比較名單，無法計算排名變化" });
      return cards;
    }

    var feRank = feEntry.rankVal;
    var feVal = displayNumber(metric, feEntry.view);
    var nb = rankNeighbors(pool, feRank);
    var namesOf = function (group) { return group.map(function (x) { return bankShortName(x.row.issuer_name); }).join("、"); };
    var tied = pool.filter(function (x) { return x.rankVal === feRank && x.row.issuer_name !== FAR_EASTERN_NAME; });

    cards.push({
      label: rankLabel,
      value: isFiniteNumber(feRank) ? "第" + feRank + "名／" + pool.length + "家" : "缺排名資料",
      sub: tied.length ? "與" + namesOf(tied) + "並列" : (scope === "all" ? "發卡機構排名母體為" + pool.length + "家" : "排名僅於前12大銀行內計算，不等同全部30家銀行排名"),
    });

    function priorValueOf(name) {
      var row = (prevPool || []).find(function (x) { return x.row.issuer_name === name; });
      return row ? displayNumber(metric, row.view) : null;
    }

    if (!nb.prev.length) {
      cards.push({ label: "距前一名（" + scopeWord + "）", value: "已為第1名", sub: "" });
    } else {
      var dPrev = safeDiff(displayNumber(metric, nb.prev[0].view), feVal);
      var namePrev = bankShortName(nb.prev[0].row.issuer_name);
      var changePrev = null;
      if (prevFeEntry) {
        var priorPrev = safeDiff(priorValueOf(nb.prev[0].row.issuer_name), displayNumber(metric, prevFeEntry.view));
        changePrev = isFiniteNumber(priorPrev) ? sameBankGapText(metric, "prev", dPrev, priorPrev, namePrev) : null;
      }
      cards.push({
        label: "距前一名（" + scopeWord + "）",
        value: isFiniteNumber(dPrev) ? fmtDistance(metric, dPrev) : "缺資料",
        sub: "第" + nb.prev[0].rankVal + "名・" + namesOf(nb.prev),
        extra: changePrev,
      });
    }

    if (!nb.next.length) {
      cards.push({ label: "領先後一名（" + scopeWord + "）", value: "無後一名", sub: "" });
    } else {
      var dNext = safeDiff(feVal, displayNumber(metric, nb.next[0].view));
      var nameNext = bankShortName(nb.next[0].row.issuer_name);
      var changeNext = null;
      if (prevFeEntry) {
        var priorNext = safeDiff(displayNumber(metric, prevFeEntry.view), priorValueOf(nb.next[0].row.issuer_name));
        changeNext = isFiniteNumber(priorNext) ? sameBankGapText(metric, "next", dNext, priorNext, nameNext) : null;
      }
      cards.push({
        label: "領先後一名（" + scopeWord + "）",
        value: isFiniteNumber(dNext) ? fmtDistance(metric, dNext) : "缺資料",
        sub: "第" + nb.next[0].rankVal + "名・" + namesOf(nb.next),
        extra: changeNext,
      });
    }

    if (!prevFeEntry) {
      cards.push({
        label: "同期排名變化", value: "不適用", cls: "delta-na",
        sub: scope === "top12" ? "去年同期遠銀未列入流通卡前12大銀行，無法計算排名變化" : "缺去年同期排名資料",
      });
    } else {
      var parts = rankChangeParts(feRank, prevFeEntry.rankVal, basisLabel);
      cards.push({ label: "同期排名變化", value: parts.main, cls: parts.cls, sub: parts.sub });
    }
    return cards;
  }

  function displayUnit(metric) {
    if (metric.fmtRaw === fmt100m) return "億元";
    if (metric.fmtRaw === fmtYuanPerCard) return "元/張";
    if (metric.fmtRaw === fmtPlainPct) return "%";
    return "張";
  }

  function displayDecimals(metric) {
    return metric.fmtRaw === fmt100m || metric.fmtRaw === fmtPlainPct ? 2 : 0;
  }

  /** 以顯示單位表示之數值（金額為億元、比率為%、卡數與每卡金額為張／元）。 */
  function displayNumber(metric, view) {
    if (metric.fmtRaw === fmt100m) {
      if (isFiniteNumber(view.raw100m)) return view.raw100m;
      return isFiniteNumber(view.raw) ? view.raw / 100000 : null;
    }
    return isFiniteNumber(view.raw) ? view.raw : null;
  }

  function fmtDisplayNumber(metric, n) {
    if (!isFiniteNumber(n)) return "—";
    var d = displayDecimals(metric);
    return Number(n.toFixed(d)).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtSignedDisplay(metric, n) {
    if (!isFiniteNumber(n)) return "—";
    var d = displayDecimals(metric);
    var r = Number(n.toFixed(d));
    return (r > 0 ? "+" : "") + fmtDisplayNumber(metric, n);
  }

  /** 差距的絕對值文字（無正負號），單位依指標；比率型為 pp。 */
  function fmtDistance(metric, n) {
    if (!isFiniteNumber(n)) return "—";
    var unit = metric.fmtRaw === fmtPlainPct ? "pp" : displayUnit(metric);
    return fmtDisplayNumber(metric, Math.abs(n)) + unit;
  }

  function safeDiff(a, b) {
    return isFiniteNumber(a) && isFiniteNumber(b) ? a - b : null;
  }

  /** 排名變化（數字越小越好）：上升＝名次數字變小。缺基期不得視為持平。 */
  function rankChangeParts(curRank, prevRank, basisLabel) {
    var dir = rankChangeDirection(curRank, prevRank);
    if (dir === null) return { main: "缺同期資料", cls: "delta-na", sub: basisLabel };
    if (dir === 0) return { main: "持平", cls: "delta-zero", sub: basisLabel };
    var diff = Math.abs(prevRank - curRank);
    return dir > 0
      ? { main: "上升" + diff + "名", cls: "delta-pos", sub: basisLabel }
      : { main: "下降" + diff + "名", cls: "delta-neg", sub: basisLabel };
  }

  /**
   * 同一家銀行之差距變化（純函式）：比較本期與去年同期「同一家銀行」與遠銀的實際差額。
   * side="prev"：該行在前一名側，距離＝該行－遠銀（遠銀落後為正）；side="next"：距離＝遠銀－該行（遠銀領先為正）。
   * 任一期缺資料回傳 null；超越、反超、同值另有文字。
   */
  function sameBankGapText(metric, side, curDist, priorDist, bankShort) {
    if (!isFiniteNumber(curDist) || !isFiniteNumber(priorDist)) return null;
    // 差額一律由未取整的數值相減，四捨五入只用於顯示與同值判斷，避免以已取整數字相減造成誤差。
    var curRaw = curDist, priorRaw = priorDist;
    var curShown = Math.round(curDist * 100) / 100;
    var priorShown = Math.round(priorDist * 100) / 100;
    var curAmt = fmtDistance(metric, Math.abs(curRaw));
    var lead = side === "prev" ? "遠銀落後" : "遠銀領先";
    // 同值與超越以顯示精度判斷，避免浮點誤差把同值誤判為擴大或縮小。
    if (curShown === 0) return "本期與" + bankShort + "同值";
    if (curShown < 0) return side === "prev" ? "遠銀已超越" + bankShort : bankShort + "已超越遠銀";
    if (priorShown < 0) {
      return (side === "prev" ? bankShort + "已反超遠銀" : "遠銀已反超" + bankShort) +
        "（去年位置相反），本期" + lead + bankShort + " " + curAmt;
    }
    if (priorShown === 0) return "去年與" + bankShort + "同值，本期" + lead + bankShort + " " + curAmt;
    var diff = curRaw - priorRaw;
    if (Math.round(Math.abs(diff) * 100) === 0) return "與去年同期差距相同";
    var word = diff < 0 ? "縮小" : "擴大";
    return lead + bankShort + "的差距較去年同期" + word + " " + fmtDistance(metric, Math.abs(diff));
  }


  /** 同業表排序（純函式）：缺值一律排最後，不當作0；只改顯示順序。 */
  function sortPeerRows(rows, field, sortDir) {
    var dir = sortDir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var va = a[field], vb = b[field];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  function formatGapValue(metric, diffRaw, prevRaw100m, curRaw100m) {
    if (metric.fmtRaw === fmt100m) {
      var diff100m = (isFiniteNumber(prevRaw100m) && isFiniteNumber(curRaw100m)) ? (prevRaw100m - curRaw100m) : diffRaw / 100000;
      return Math.abs(diff100m).toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " 億元";
    }
    if (metric.fmtRaw === fmtYuanPerCard) return Math.abs(Math.round(diffRaw)).toLocaleString("zh-TW") + " 元/張";
    if (metric.fmtRaw === fmtInt) return fmtInt(Math.abs(diffRaw)) + " 張";
    return fmtInt(Math.abs(diffRaw)) + " " + (metric.unit || "");
  }

  /**
   * 產生「{主詞}領先/落後{受詞} {差距}」之明確句子，主詞固定在句首，避免
   * 「{受詞}領先{差距}」這種易被誤讀為受詞領先的模糊句型。方向由
   * compareByDirection 依指標 direction 動態計算，不寫死「較大即領先」。
   */
  function leadBehindText(metric, selfLabel, otherLabel, selfRaw, otherRaw, selfRaw100m, otherRaw100m) {
    var cmp = compareByDirection(metric, selfRaw, otherRaw);
    if (cmp === null) return selfLabel + "與" + otherLabel + "資料不足，無法比較。";
    var gapText = formatGapValue(metric, selfRaw - otherRaw, otherRaw100m, selfRaw100m);
    if (cmp === 0) return selfLabel + "與" + otherLabel + "持平（" + gapText + "差距為0）。";
    return cmp > 0
      ? selfLabel + "領先" + otherLabel + " " + gapText
      : selfLabel + "落後" + otherLabel + " " + gapText;
  }

  // ==================================================================
  // 七、首頁「全指標主管總覽」共用工具
  // ==================================================================

  /**
   * 指標「相對市場表現」之統一公式：比率型指標（如有效卡率）採本期水準差
   * （遠銀本期比率－市場本期比率）；其餘指標採成長率差（遠銀YoY－市場YoY）。
   * 兩者意義不同，不可混用同一公式——詳見 docs/calculation-rules.md。
   * 診斷表、首頁總覽表、首頁管理摘要皆共用本函式，避免各處邏輯各自為政。
   */
  function metricRelativeGap(metric, feView, mktView) {
    if (metric.kind === "ratio") {
      return (isFiniteNumber(feView.raw) && isFiniteNumber(mktView.raw)) ? feView.raw - mktView.raw : null;
    }
    return (isFiniteNumber(feView.yoy) && isFiniteNumber(mktView.yoy)) ? feView.yoy - mktView.yoy : null;
  }

  // ------------------------------------------------------------------
  // 本期重點：候選指標挑選（純函式，不讀取全域狀態，可於 Node 測試）。
  // 百分比成長差與比率水準差不是同一尺度，不得互相比較排序，因此「最大差異」與
  // 「持續觀察」只在成長型指標間排序；比率型指標僅能以排名退步的理由入選。
  // ------------------------------------------------------------------


  /** 相對市場之措辭：信用卡應收帳款與比率型固定用「高於／低於」（中性），其餘成長型用「超前／落後」。 */
  function summaryVerbPair(metric) {
    if (metric.id === "total_assets") return ["成長高於市場", "成長低於市場"];
    if (metric.kind === "ratio") return ["當期高於市場", "當期低於市場"];
    return ["成長超前市場", "成長落後市場"];
  }

  function signedPp(v) {
    if (!isFiniteNumber(v)) return null;
    var r = Number(v.toFixed(2));
    return (r > 0 ? "+" : "") + r.toFixed(2) + " pp";
  }

  function signedPct(v) {
    if (!isFiniteNumber(v)) return null;
    var r = Number(v.toFixed(2));
    return (r > 0 ? "+" : "") + r.toFixed(2) + "%";
  }



  /** 建立本期重點候選（數據方式與首頁總覽一致）。 */
  /**
   * 首頁本期重點（純函式）：固定三類，缺資料即省略，不以「落差最大／最小」機械選取。
   *   core   — 核心業務：簽帳金額（不含預借現金）與市場的同期成長比較。
   *   change — 明顯變化：排名變動最大的指標（排除信用卡應收帳款與比率型）。
   *   watch  — 值得追查：有效卡率高於市場，但較去年同月下降。
   */
  function homeSummaryPick(candidates) {
    function byId(id) {
      for (var i = 0; i < candidates.length; i++) { if (candidates[i].id === id) return candidates[i]; }
      return null;
    }
    var items = [];
    var core = byId("purchase_amount");
    if (core && isFiniteNumber(core.feV.yoy) && isFiniteNumber(core.mktV.yoy) && isFiniteNumber(core.gap)) {
      items.push({ role: "core", c: core });
    }
    var changePool = candidates.filter(function (c) {
      return c.id !== "purchase_amount" && c.id !== "total_assets" && !c.isRatio &&
        isFiniteNumber(c.rankChangeAmt) && c.rankChangeAmt !== 0;
    });
    changePool.sort(function (a, b) {
      return (Math.abs(b.rankChangeAmt) - Math.abs(a.rankChangeAmt)) ||
        (METRIC_ORDER.indexOf(a.id) - METRIC_ORDER.indexOf(b.id));
    });
    if (changePool.length) items.push({ role: "change", c: changePool[0] });
    var rate = byId("effective_card_rate_pct");
    if (rate && isFiniteNumber(rate.gap) && rate.gap > 0 && isFiniteNumber(rate.feV.yoy) && rate.feV.yoy < 0) {
      items.push({ role: "watch", c: rate });
    }
    return items;
  }

  /** 核心結論：依選定數據方式（單月／年初至今累計）與市場、遠銀 YOY 動態產生。 */
  function homeCoreConclusion(fe, mkt, gap, basisWord) {
    var b = basisWord + "簽帳金額";
    if (mkt > 0 && fe < 0) return "市場" + b + "成長，遠銀仍低於去年同期";
    if (mkt > 0 && gap < 0) return "市場" + b + "成長，遠銀成長幅度較小";
    if (mkt > 0) return "市場與遠銀" + b + "皆成長，遠銀不低於市場";
    if (fe >= 0) return "市場" + b + "下降，遠銀仍成長";
    return "市場" + b + "下降，遠銀" + (gap >= 0 ? "降幅較小" : "降幅較大");
  }

  /** 摘要標籤依指標內容對應，描述指標類別，不使用業務重要性或異常意涵的名稱。 */
  var SUMMARY_TAG_BY_METRIC = {
    purchase_amount: "簽帳表現", purchase_plus_cash_amount: "簽帳表現", per_card_spending: "簽帳表現",
    cards_issued: "發卡表現",
    cards_in_force: "卡片活躍度", active_cards: "卡片活躍度", effective_card_rate_pct: "卡片活躍度",
    total_assets: "帳款規模",
  };
  function summaryTagFor(metric) { return SUMMARY_TAG_BY_METRIC[metric.id] || "其他指標"; }

  /** 將單則重點轉為 {tag, html}：結論一行（加粗），支持數字另起一行；指標名稱為可點擊連結。 */
  function homeSummaryLine(item) {
    var c = item.c, metric = c.metric;
    var tabFor = item.role === "change" ? "peers" : "trends";
    var link = '<button type="button" class="mgmt-summary-link" data-metric="' + escapeHtml(metric.id) +
      '" data-tab="' + tabFor + '">' + escapeHtml(metric.label) + '</button>：';
    var basisWord = c.pType === "ytd" ? "年初至今累計" : "單月";
    var rankBasis = rankBasisLabel(c.pType);
    // 數字與單位不拆行
    function num(text, cls) {
      return '<span class="nowrap' + (cls ? " " + cls : "") + '">' + escapeHtml(text) + '</span>';
    }
    if (item.role === "core") {
      var fe = c.feV.yoy, mk = c.mktV.yoy;
      return {
        tag: summaryTagFor(metric),
        html: link + "<strong>" + escapeHtml(homeCoreConclusion(fe, mk, c.gap, basisWord)) + "</strong>。" +
          '<span class="mgmt-support">（' + escapeHtml(basisWord) + '）遠銀 YOY ' + num(signedPct(fe), deltaClass(Number(fe.toFixed(2)))) +
          '，市場 YOY ' + num(signedPct(mk), deltaClass(Number(mk.toFixed(2)))) + '，遠銀與市場相差 ' +
          num(signedPp(c.gap), deltaClass(Number(c.gap.toFixed(2)))) + '。</span>',
      };
    }
    if (item.role === "change") {
      var up = c.rankChangeAmt > 0;
      var valueWord = isFiniteNumber(c.feV.yoy) && c.feV.yoy < 0 ? "減少" : "增加";
      var shortName = METRIC_SHORT_NAMES[metric.id] || metric.label;
      var yoyOk = isFiniteNumber(c.feV.yoy);
      return {
        tag: summaryTagFor(metric),
        html: link + "<strong>" + escapeHtml("遠銀" + basisWord + shortName + valueWord + "，排名" + rankBasis +
          (up ? "上升 " : "下降 ") + Math.abs(c.rankChangeAmt) + " 名") + "</strong>。" +
          '<span class="mgmt-support">遠銀' + escapeHtml(metric.label) + ' YOY ' +
          num(yoyOk ? signedPct(c.feV.yoy) : "缺同期資料", yoyOk ? deltaClass(Number(c.feV.yoy.toFixed(2))) : "delta-na") +
          '，目前排名第 ' + escapeHtml(String(c.feV.bankRank)) + ' 名。</span>',
      };
    }
    var rate = c.feV.raw, mkRate = c.mktV.raw;
    return {
      tag: summaryTagFor(metric),
      html: link + "<strong>遠銀有效卡率仍高於市場，但較去年同期下降</strong>。" +
        '<span class="mgmt-support">遠銀 ' + num(fmtPlainPct(rate)) + '，市場 ' + num(fmtPlainPct(mkRate)) + '，高於市場 ' +
        num(signedPp(c.gap), deltaClass(Number(c.gap.toFixed(2)))) + '；較去年同期 ' +
        num(signedPp(c.feV.yoy), deltaClass(Number(c.feV.yoy.toFixed(2)))) + '。</span>',
    };
  }

  function buildSummaryCandidates(period, fe, mkt) {
    var prevY = findFarEastern(prevYearPeriod(period));
    return METRIC_ORDER.map(function (id) {
      var metric = METRIC_CATALOG[id];
      var pType = overviewPeriodType(metric);
      var feV = metricView(metric, fe, pType);
      var mktV = metricView(metric, mkt, pType);
      var gap = metricRelativeGap(metric, feV, mktV);
      var prevYV = metricView(metric, prevY, pType);
      var rankChangeAmt = (isFiniteNumber(feV.bankRank) && isFiniteNumber(prevYV.bankRank)) ? (prevYV.bankRank - feV.bankRank) : null;
      return { id: id, metric: metric, pType: pType, feV: feV, mktV: mktV, gap: gap, rankChangeAmt: rankChangeAmt, isRatio: metric.kind === "ratio" };
    });
  }

  // ------------------------------------------------------------------
  // 首頁發卡與消費數據方式：僅影響四項流量型指標（預設年初至今 YTD，可切換為單月）；
  // 其餘指標固定依既定數據方式（月底值或當月比率）。
  // ------------------------------------------------------------------
  var OVERVIEW_BASIS_METRICS = ["cards_issued", "purchase_amount", "purchase_plus_cash_amount", "per_card_spending"];

  function overviewPeriodType(metric) {
    return OVERVIEW_BASIS_METRICS.indexOf(metric.id) >= 0 ? state.overviewBasis : "month";
  }

  // ==================================================================
  // 八、首頁 A 區：本期重點（最多三則；指標名稱可點擊，關鍵數字加粗）
  // ==================================================================

  function renderManagementSummary(period) {
    var listEl = document.getElementById("management-summary-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    var fe = findFarEastern(period), mkt = findMarket(period);
    if (!fe || !mkt) { listEl.innerHTML = "<li>此月份資料不足。</li>"; return; }

    var items = homeSummaryPick(buildSummaryCandidates(period, fe, mkt));
    if (!items.length) { listEl.innerHTML = "<li>此月份資料不足，無法產生本期重點。</li>"; return; }
    items.forEach(function (item) {
      var line = homeSummaryLine(item);
      var li = document.createElement("li");
      li.innerHTML = '<span class="mgmt-summary-tag tag-kind">' + escapeHtml(line.tag) + '</span>' + line.html;
      listEl.appendChild(li);
    });
  }

  // ==================================================================
  // 九、首頁 B 區：全指標總覽（五欄；主值與同期變化依所選數據方式，一格只顯示一套數字）
  // ==================================================================

  function changeMissing() { return '<span class="ov-missing">缺同期資料</span>'; }

  /** 卡數三項以「萬張」顯示，其餘沿用既有格式（金額為億元、比率為%、每卡金額為元）。 */
  var WAN_ZHANG_METRICS = ["cards_in_force", "active_cards", "cards_issued"];
  function metricDisplayText(metric, view) {
    if (WAN_ZHANG_METRICS.indexOf(metric.id) >= 0) return fmtWanZhang(view.raw);
    return formatMetricValue(metric, view.raw, view.raw100m);
  }

  /**
   * 相對市場差異條共同尺度（YOY 列）：預設 ±20 pp；若任一列超出，所有 YOY 列共同擴展為 5 pp 進位的對稱尺度。
   * 有效卡率（當月比率差）不納入此尺度。
   */
  function overviewGapScale(period) {
    var fe = findFarEastern(period), mkt = findMarket(period);
    if (!fe || !mkt) return 20;
    var maxAbs = 0;
    OVERVIEW_GROUPS.forEach(function (group) {
      group.metrics.forEach(function (id) {
        var metric = METRIC_CATALOG[id];
        if (!metric || metric.kind === "ratio" || metric.kind === "unavailable") return;
        var pType = overviewPeriodType(metric);
        var gap = metricRelativeGap(metric, metricView(metric, fe, pType), metricView(metric, mkt, pType));
        if (isFiniteNumber(gap)) maxAbs = Math.max(maxAbs, Math.abs(Number(gap.toFixed(2))));
      });
    });
    return Math.max(20, Math.ceil(maxAbs / 5) * 5);
  }

  /**
   * 相對市場表現欄：上方為「高於／低於市場」與帶正負號差值（僅差值使用紅綠），下方為共同尺度差異條。
   * 有效卡率：小標「當月比率比較」，只顯示當月比率差，不畫差異條。缺同期資料不畫條、不視為 0。
   */
  function overviewRelHtml(metric, feP, mktP, gap, scale) {
    if (metric.kind === "ratio") {
      if (!isFiniteNumber(gap)) return '<span class="ov-rel-tag">當月比率比較</span><div class="ov-missing">無資料</div>';
      var g = Number(gap.toFixed(2));
      var rWord = g > 0 ? "高於市場" : (g < 0 ? "低於市場" : "與市場相同");
      return '<span class="ov-rel-tag">當月比率比較</span>' +
        '<div class="ov-rel-text"><span class="ov-rel-word">' + rWord + '</span> <span class="ov-rel-num ' + deltaClass(g) + '">' + escapeHtml(signedPp(gap)) + '</span></div>';
    }
    if (!isFiniteNumber(gap) || !isFiniteNumber(feP.yoy) || !isFiniteNumber(mktP.yoy)) {
      return '<div class="ov-missing">無同期資料</div>';
    }
    var g2 = Number(gap.toFixed(2));
    var word = g2 > 0 ? "高於市場" : (g2 < 0 ? "低於市場" : "與市場持平");
    var pct = Math.min(Math.abs(g2) / scale, 1) * 50;
    var bar = g2 === 0 ? "" : '<span class="ov-diff-bar ' + (g2 > 0 ? "pos" : "neg") + '" style="width:' + pct.toFixed(2) + '%"></span>';
    var tip = "遠銀YOY－市場YOY ＝ " + signedPp(gap) + "（遠銀YOY " + signedPct(feP.yoy) + "，市場YOY " + signedPct(mktP.yoy) + "）";
    return '<div class="ov-rel-text"><span class="ov-rel-word">' + word + '</span> <span class="ov-rel-num ' + deltaClass(g2) + '">' + escapeHtml(signedPp(gap)) + '</span></div>' +
      '<div class="ov-diff-track" role="img" aria-label="' + escapeHtml(tip) + '" title="' + escapeHtml(tip) + '">' +
      '<span class="ov-diff-zero"></span>' + bar + '</div>';
  }

  /** 排名欄：上方為本期名次（可點擊），下方為變化（表頭說明「變化較去年同期」）。上升紅、退步綠。 */
  function overviewRankHtml(metricId, feP, prevP, pType) {
    if (!isFiniteNumber(feP.bankRank)) return '<div class="ov-missing">缺排名資料</div>';
    var main = '<button type="button" class="ov-link-btn ov-peers-link ov-rank-main" data-metric="' + metricId + '">第' +
      escapeHtml(fmtRank(feP.bankRank)) + '名</button>';
    var sub;
    if (!isFiniteNumber(prevP.bankRank)) {
      sub = '<span class="ov-missing">缺同期資料</span>';
    } else {
      var d = prevP.bankRank - feP.bankRank;
      if (d > 0) sub = '<span class="ov-rank-change delta-pos">↑' + d + '名</span>';
      else if (d < 0) sub = '<span class="ov-rank-change delta-neg">↓' + (-d) + '名</span>';
      else sub = '<span class="ov-rank-change delta-zero">持平</span>';
    }
    return main + '<div class="ov-rank-sub">' + sub + '</div>';
  }

  /** 市場或遠銀數值格：上方為本期值，下方為同期變化（YOY 或較去年同期 pp）。 */
  function overviewValueCell(metric, view, id, label) {
    var isRatio = metric.kind === "ratio";
    var yoyHtml;
    if (!isFiniteNumber(view.yoy)) {
      yoyHtml = changeMissing();
    } else if (isRatio) {
      yoyHtml = '<span class="ov-yoy-label">較去年同期</span> <span class="ov-yoy ' + deltaClass(Number(view.yoy.toFixed(2))) + '">' + escapeHtml(signedPp(view.yoy)) + '</span>';
    } else {
      yoyHtml = '<span class="ov-yoy-label">YOY</span> <span class="ov-yoy ' + deltaClass(Number(view.yoy.toFixed(2))) + '">' + escapeHtml(signedPct(view.yoy)) + '</span>';
    }
    return '<td class="ov-value-cell ov-detail-link ' + (label === "整體市場" ? "ov-col-market" : "ov-col-fareast") + '" data-metric="' + id + '" data-label="' + label + '" tabindex="0" role="button">' +
      '<div class="ov-main"><span class="ov-link-value">' + escapeHtml(metricDisplayText(metric, view)) + '</span></div>' +
      '<div class="ov-yoy-line">' + yoyHtml + '</div></td>';
  }

  function renderAllMetricsOverview(period) {
    var fe = findFarEastern(period), mkt = findMarket(period);
    var tbody = document.getElementById("overview-table-tbody");
    if (!tbody || !fe || !mkt) return;
    tbody.innerHTML = "";
    var prevFe = findFarEastern(prevYearPeriod(period));
    var basisLine = document.getElementById("overview-basis-line");
    if (basisLine) {
      basisLine.textContent = "民國" + periodShortLabel(mkt) + "｜卡數、有效卡率與應收帳款呈現當月值；發卡與消費指標採" +
        (state.overviewBasis === "ytd" ? "年初至今累計。" : "單月值。");
    }
    var scale = overviewGapScale(period);
    var scaleNote = document.getElementById("overview-scale-note");
    if (scaleNote) {
      scaleNote.textContent = "差異條：低於市場 ← 0 → 高於市場｜共同尺度 ±" + scale + " pp（所有 YOY 列一致；有效卡率不納入）。相對市場差＝遠銀YOY－市場YOY。";
    }

    OVERVIEW_GROUPS.forEach(function (group) {
      var groupTr = document.createElement("tr");
      groupTr.className = "ov-group-row";
      groupTr.innerHTML = '<th scope="colgroup" colspan="5" class="ov-group-th">' + escapeHtml(group.label) + '</th>';
      tbody.appendChild(groupTr);

      group.metrics.forEach(function (id) {
        var metric = METRIC_CATALOG[id];
        var pType = overviewPeriodType(metric);
        var mktP = metricView(metric, mkt, pType), feP = metricView(metric, fe, pType);
        var prevP = metricView(metric, prevFe, pType);
        var gap = metricRelativeGap(metric, feP, mktP);
        // 只有受口徑切換影響的指標標示「年初至今累計」或「單月」，其他指標不重複標示。
        var basisTag = OVERVIEW_BASIS_METRICS.indexOf(id) >= 0
          ? '<span class="ov-basis-tag">' + (pType === "ytd" ? "年初至今（YTD）" : "單月") + '</span>' : "";

        var tr = document.createElement("tr");
        tr.className = "ov-row";
        tr.innerHTML =
          '<th scope="row"><button type="button" class="ov-link-btn ov-trend-link ov-link-value" data-metric="' + id + '">' + escapeHtml(metric.label) + '</button>' + basisTag + '</th>' +
          overviewValueCell(metric, mktP, id, "整體市場") +
          overviewValueCell(metric, feP, id, "遠銀") +
          '<td class="ov-rel" data-label="相對市場表現">' + overviewRelHtml(metric, feP, mktP, gap, scale) + '</td>' +
          '<td class="ov-rank-cell" data-label="銀行排名（30家）">' + overviewRankHtml(id, feP, prevP, pType) + '</td>';
        tbody.appendChild(tr);
      });
    });
  }

  function goToMetricTab(tabId, metricId) {
    var metric = METRIC_CATALOG[metricId];
    // 原「資料明細」入口已併入同業比較：開啟全部發卡機構模式；同業比較入口回到前12大銀行預設範圍。
    if (tabId === "detail") { tabId = "peers"; state.peersScope = "all"; state.peersSearch = ""; }
    else if (tabId === "peers") { state.peersScope = "top12"; state.peersSearch = ""; }
    state.activeMetricId = metricId;
    state.periodType = metric && metricSupportsPeriodType(metric) ? overviewPeriodType(metric) : "month";
    document.querySelectorAll(".metric-select").forEach(function (sel) { sel.value = metricId; });
    renderStickyBar();
    renderAllTabs();
    switchTab(tabId);
    var panel = document.getElementById("tab-" + tabId);
    if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bindOverviewRowActions() {
    var tbody = document.getElementById("overview-table-tbody");
    if (tbody) {
      tbody.addEventListener("click", function (evt) {
        var trendBtn = evt.target.closest(".ov-trend-link");
        if (trendBtn) { goToMetricTab("trends", trendBtn.getAttribute("data-metric")); return; }
        var peersBtn = evt.target.closest(".ov-peers-link");
        if (peersBtn) { goToMetricTab("peers", peersBtn.getAttribute("data-metric")); return; }
        var detailCell = evt.target.closest(".ov-detail-link");
        if (detailCell) { goToMetricTab("detail", detailCell.getAttribute("data-metric")); return; }
      });
      tbody.addEventListener("keydown", function (evt) {
        if (evt.key !== "Enter" && evt.key !== " " && evt.key !== "Spacebar") return;
        var detailCell = evt.target.closest(".ov-detail-link");
        if (detailCell) { evt.preventDefault(); goToMetricTab("detail", detailCell.getAttribute("data-metric")); }
      });
    }
    var summaryList = document.getElementById("management-summary-list");
    if (summaryList) {
      summaryList.addEventListener("click", function (evt) {
        var link = evt.target.closest(".mgmt-summary-link");
        if (link) goToMetricTab(link.getAttribute("data-tab"), link.getAttribute("data-metric"));
      });
    }
  }

  function bindStickyToggle() {
    var btn = document.getElementById("sticky-toggle");
    var bar = document.getElementById("sticky-bar");
    if (!btn || !bar) return;
    btn.addEventListener("click", function () {
      var open = !bar.classList.contains("is-open");
      bar.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      renderStickyBar();
    });
  }

  function bindOverviewBasisSwitch() {
    document.querySelectorAll("#ov-basis-switch .period-type-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.overviewBasis = btn.getAttribute("data-basis");
        document.querySelectorAll("#ov-basis-switch .period-type-btn").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        renderManagementSummary(state.selectedPeriod);
        renderAllMetricsOverview(state.selectedPeriod);
      });
    });
  }

  // ==================================================================
  // 九、趨勢分析頁籤
  // ==================================================================

  // ==================================================================
  // 趨勢分析：四張固定用途圖（整體市場、遠銀、同期比較、市場定位）
  // 指標判斷集中於 trendPlanFor()；渲染函式只負責繪製。數值一律讀取 processed 已計算欄位（經 metricView），
  // 缺值不補 0、不跨缺值連線；YTD 每年 1 月重新起算，跨年度分段。
  // ==================================================================

  var TREND_MARKET_COLOR = "#6f8196";
  var TREND_FE_COLOR = "#e07b1a";
  var TREND_POS_COLOR = "#173458";
  var TREND_ZERO_COLOR = "#9AA3B0";
  var TREND_RANK_COUNT = 30;

  function isCardMetric(metric) {
    return metric.id === "cards_in_force" || metric.id === "active_cards" || metric.id === "cards_issued";
  }

  /** 趨勢數值單位：金額為億元、流通卡／有效卡／發卡數為萬張、每卡金額為元／張、比率為%。 */
  function trendUnitOf(metric) {
    if (metric.fmtRaw === fmt100m) return "億元";
    if (metric.fmtRaw === fmtYuanPerCard) return "元/張";
    if (metric.fmtRaw === fmtPlainPct) return "%";
    if (isCardMetric(metric)) return "萬張";
    return "張";
  }

  /** 趨勢數值（與單位一致、保留原始精度）；缺值回傳 null，不視為 0。 */
  function trendNum(metric, view) {
    var n = displayNumber(metric, view);
    if (!isFiniteNumber(n)) return null;
    return trendUnitOf(metric) === "萬張" ? n / 10000 : n;
  }

  function trendDecimals(metric) {
    var u = trendUnitOf(metric);
    return (u === "億元" || u === "萬張" || u === "%") ? 2 : 0;
  }

  /** 數值格式；full=true 時卡數另附完整張數（tooltip 用，端點標示不附）。 */
  function trendValueFmt(metric, full) {
    var u = trendUnitOf(metric), dec = trendDecimals(metric);
    return function (v) {
      if (!isFiniteNumber(v)) return "缺資料";
      var base = v.toLocaleString("zh-TW", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + (u === "%" ? "%" : " " + u);
      if (full && isCardMetric(metric)) return base + "（" + Math.round(v * 10000).toLocaleString("zh-TW") + " 張）";
      return base;
    };
  }

  /**
   * 期間起訖變化（流通卡數、有效卡數、應收帳款與單月流量）：以期間第一與最後一個月份的實際值計算，
   * 未四捨五入後才格式化；起點為 0 不計百分比；應收帳款只描述增加或減少。
   */
  function periodChangeNote(s, periods, metric) {
    if (periods.length < 2) return "較期間起點：期間僅一個月，無法計算。";
    var a = s.value(periods[0]), b = s.value(periods[periods.length - 1]);
    if (!isFiniteNumber(a) || !isFiniteNumber(b)) return "較期間起點：期初或期末缺資料，無法計算。";
    var diff = b - a, dec = trendDecimals(metric), u = trendUnitOf(metric);
    var absTxt = Math.abs(diff).toLocaleString("zh-TW", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + " " + u;
    var pctNum = a === 0 ? null : (b / a - 1) * 100;
    if (metric.id === "total_assets") {
      var word = diff >= 0 ? "增加" : "減少";
      return "較期間起點：" + word + " " + absTxt + (pctNum === null ? "（起點為0，不計百分比）" : "（" + Math.abs(pctNum).toFixed(2) + "%）");
    }
    var sign = diff > 0 ? "+" : (diff < 0 ? "−" : "");
    return "較期間起點：" + sign + absTxt + (pctNum === null ? "（起點為0，不計百分比）" : "（" + signedPct(pctNum).replace("-", "−") + "）");
  }

  /**
   * 四張圖的設定（單一來源）。回傳 { market, fareast, compare, position }。
   * 系列：value(p) 處理後數值（缺值 null）、label、prev（去年同期虛線）、periodOf（tooltip 實際年月）、fmt（端點）、tipFmt（tooltip）。
   */
  function trendPlanFor(metric, pType) {
    var kind = metric.kind;
    var flow = kind === "flow" || kind === "flow_no_share";
    var ytd = flow && pType === "ytd";
    var isRatio = kind === "ratio";
    var unit = trendUnitOf(metric);
    var prefix = flow ? (ytd ? "YTD" : "單月") : "";
    var name = flow ? prefix + metric.label : metric.label + (isRatio ? "（當月比率）" : "（月底值）");
    var shortFmt = trendValueFmt(metric, false), fullFmt = trendValueFmt(metric, true);
    var periodChangeApplies = !ytd && (kind === "stock" || (kind === "flow" && pType === "month"));

    function recordOf(side, p) { return side === "market" ? findMarket(p) : findFarEastern(p); }

    function levelSeries(side, prev) {
      var label = side === "market" ? "市場" : "遠銀";
      if (ytd) label += prev ? "去年同期累計" : "當年累計";
      return {
        key: side + (prev ? "-prev" : "-cur"),
        label: label,
        prev: !!prev,
        color: side === "market" ? TREND_MARKET_COLOR : TREND_FE_COLOR,
        periodOf: function (p) { return prev ? prevYearPeriod(p) : p; },
        value: function (p) {
          var per = prev ? prevYearPeriod(p) : p;
          return trendNum(metric, metricView(metric, recordOf(side, per), pType));
        },
        fmt: shortFmt,
        tipFmt: fullFmt,
      };
    }

    function levelSlot(side) {
      var series = [levelSeries(side, false)];
      if (ytd) series.push(levelSeries(side, true));
      var bar = kind === "flow" && pType === "month";
      return {
        kind: bar ? "bar" : "line",
        title: (side === "market" ? "整體市場" : "遠銀") + "｜" + name,
        unit: unit,
        series: series,
        zeroBase: bar,
        nonNegative: true,
        breakAtNewYear: ytd,
        noteFn: function (periods) {
          return periodChangeApplies ? periodChangeNote(levelSeries(side, false), periods, metric) : "";
        },
      };
    }

    function yoySeries(side) {
      return {
        key: side + "-yoy",
        label: side === "market" ? "市場" : "遠銀",
        prev: false,
        color: side === "market" ? TREND_MARKET_COLOR : TREND_FE_COLOR,
        periodOf: function (p) { return p; },
        value: function (p) {
          var v = metricView(metric, recordOf(side, p), pType);
          return isFiniteNumber(v.yoy) ? v.yoy : null;
        },
        fmt: function (v) { return isRatio ? signedPp(v) : signedPct(v); },
        endFmt: function (v) { return (side === "market" ? "市場" : "遠銀") + (isRatio ? signedPp(v) : signedPct(v)); },
        tipFmt: function (v) { return isRatio ? signedPp(v) : signedPct(v); },
      };
    }

    var compare = {
      kind: "line",
      title: isRatio ? "有效卡率｜較去年同期變化" : name + "｜較去年同期變化（YOY）",
      unit: isRatio ? "pp" : "%",
      series: [yoySeries("market"), yoySeries("fareast")],
      zeroBase: true,
      breakAtNewYear: false,
      noteFn: function () { return ""; },
    };

    var position;
    if (isRatio) {
      position = {
        kind: "line",
        title: "有效卡率差｜遠銀－市場",
        unit: "pp",
        series: [{
          key: "gap", label: "遠銀－市場（當期比率差）", prev: false, color: TREND_POS_COLOR,
          periodOf: function (p) { return p; },
          value: function (p) {
            var fv = metricView(metric, findFarEastern(p), pType), mv = metricView(metric, findMarket(p), pType);
            return (isFiniteNumber(fv.raw) && isFiniteNumber(mv.raw)) ? fv.raw - mv.raw : null;
          },
          fmt: signedPp,
          tipFmt: signedPp,
        }],
        zeroBase: true,
        breakAtNewYear: false,
        noteFn: function () { return "當期比率差為水準差，非同期變化；不計算市占率。"; },
      };
    } else if (kind === "flow_no_share") {
      position = {
        kind: "line",
        title: "遠銀｜" + name + "銀行同業排名（" + TREND_RANK_COUNT + "家）",
        unit: "名次（第1名在上）",
        series: [{
          key: "rank", label: "遠銀銀行同業排名", prev: false, color: TREND_FE_COLOR,
          periodOf: function (p) { return p; },
          value: function (p) {
            var v = metricView(metric, findFarEastern(p), pType);
            return isFiniteNumber(v.bankRank) ? v.bankRank : null;
          },
          fmt: function (v) { return "第" + v + "名"; },
          tipFmt: function (v) { return "第" + v + "名"; },
        }],
        invert: true,
        domain: [1, TREND_RANK_COUNT],
        breakAtNewYear: ytd,
        noteFn: function () { return "排名母體為全部30家銀行，不因顯示範圍重新排名；每卡金額不計算市占率。"; },
      };
    } else {
      var shareOf = function (p) {
        var v = metricView(metric, findFarEastern(p), pType);
        return isFiniteNumber(v.share) ? v.share : null;
      };
      position = {
        kind: "line",
        title: "遠銀｜" + name + "市占率",
        unit: "%",
        series: [{
          key: "share", label: "遠銀市占率", prev: false, color: TREND_FE_COLOR,
          periodOf: function (p) { return p; },
          value: shareOf,
          fmt: function (v) { return fmtPlainPct(v, 2); },
          tipFmt: function (v) { return fmtPlainPct(v, 2); },
        }],
        zeroBase: true,
        breakAtNewYear: ytd,
        noteFn: function (periods) {
          var a = shareOf(periods[0]), b = shareOf(periods[periods.length - 1]);
          if (!isFiniteNumber(a) || !isFiniteNumber(b)) return "市占率：期初或期末缺資料，無法計算期間變化。";
          var diff = Number((b - a).toFixed(2));
          var dirWord = diff > 0 ? "上升" : (diff < 0 ? "下降" : "持平");
          return rocYearMonthShort(periods[0]) + "：" + fmtPlainPct(a, 2) + " → " + rocYearMonthShort(periods[periods.length - 1]) + "：" + fmtPlainPct(b, 2) +
            "，" + dirWord + (diff === 0 ? "" : Math.abs(diff).toFixed(2) + " pp");
        },
      };
    }

    return {
      market: levelSlot("market"),
      fareast: levelSlot("fareast"),
      compare: compare,
      position: position,
    };
  }

  /** 圖例：實線／虛線與色塊與圖上線條一致；去年同期以虛線標示，不另加「（虛線）」字樣。 */
  function renderTrendLegend(el, slot) {
    el.innerHTML = "";
    slot.series.forEach(function (s) {
      var item = document.createElement("span");
      item.className = "trend-legend-item";
      if (slot.kind === "bar") {
        item.innerHTML = '<span class="trend-legend-bar" style="background:' + s.color + '"></span>' + escapeHtml(s.label);
      } else {
        item.innerHTML = '<svg class="trend-legend-line" width="28" height="10" aria-hidden="true"><line x1="1" y1="5" x2="27" y2="5" stroke="' + s.color +
          '" stroke-width="2.4" stroke-linecap="round"' + (s.prev ? ' stroke-dasharray="6 4"' : "") + "/></svg>" + escapeHtml(s.label);
      }
      el.appendChild(item);
    });
  }

  /**
   * 趨勢圖（SVG，依容器寬度排版，字級與線寬固定，不拉伸）。
   * 左邊距依最寬刻度文字量測；缺值不畫點、不連線；YTD 於每年 1 月分段；
   * 端點標示位於最新點上方並保持間距；tooltip 分別列出當期與去年同期的實際年月。
   */
  function buildTrendSvg(wrap, periods, slot) {
    var minusFix = function (t) { return String(t).replace(/-/g, "−"); };
    wrap.innerHTML = "";
    var n = periods.length;
    if (!n) { wrap.innerHTML = '<p class="scope-note">期間內無資料。</p>'; return; }
    var W = Math.max(300, Math.floor(wrap.clientWidth || 520));
    var H = 290, padT = 16, padB = 34, padR = 24;
    var values = slot.series.map(function (s) { return periods.map(function (p) { return s.value(p); }); });
    var all = [];
    values.forEach(function (arr) { arr.forEach(function (v) { if (isFiniteNumber(v)) all.push(v); }); });
    var dom;
    if (slot.domain) {
      dom = { min: slot.domain[0], max: slot.domain[1], ticks: [1, 5, 10, 15, 20, 25, 30], decimals: 0 };
    } else if (!all.length) {
      wrap.innerHTML = '<p class="scope-note">此期間無可用資料。</p>';
      return;
    } else {
      // 折線圖上下留白（約12%），避免端點貼齊座標底線；柱狀與含0基準者不向下留白
      var lo0 = Math.min.apply(null, all), hi0 = Math.max.apply(null, all);
      var pad0 = (hi0 - lo0) * 0.12 || Math.abs(hi0) * 0.05 || 1;
      dom = niceTicks(lo0 - (slot.zeroBase ? 0 : pad0), hi0 + pad0, 4, !!slot.zeroBase);
      if (slot.nonNegative && dom.min < 0) {
        dom.min = 0;
        dom.ticks = dom.ticks.filter(function (t) { return t >= 0; });
        if (!dom.ticks.length || dom.ticks[0] !== 0) dom.ticks.unshift(0);
      }
    }
    var tickText = function (t) {
      return minusFix(t.toLocaleString("zh-TW", { minimumFractionDigits: dom.decimals, maximumFractionDigits: dom.decimals }));
    };
    var maxLabelW = 0;
    dom.ticks.forEach(function (t) { maxLabelW = Math.max(maxLabelW, textWidthEstimate(tickText(t), 13)); });
    var plotL = Math.ceil(maxLabelW) + 22, plotR = W - padR, plotT = padT, plotB = H - padB;
    var xOf = function (i) { return n === 1 ? (plotL + plotR) / 2 : plotL + i / (n - 1) * (plotR - plotL); };
    var yOf = slot.invert
      ? function (v) { return plotT + (v - dom.min) / (dom.max - dom.min) * (plotB - plotT); }
      : function (v) { return plotB - (v - dom.min) / (dom.max - dom.min) * (plotB - plotT); };

    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "trend-svg");
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", slot.title);
    function el(name, attrs, text) {
      var e = document.createElementNS(SVGNS, name);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      if (text !== undefined) e.textContent = text;
      svg.appendChild(e);
      return e;
    }

    // 格線與刻度（格線淡色；0 基準線為 1px 中灰，畫在資料線下層）
    dom.ticks.forEach(function (t) {
      var y = yOf(t);
      el("line", { x1: plotL, x2: plotR, y1: y, y2: y, stroke: "#E4E7EC", "stroke-width": 1 });
      el("text", { x: plotL - 10, y: y + 4, "font-size": 13, fill: "#52545c", "text-anchor": "end" }, tickText(t));
    });
    if (!slot.invert && dom.min < 0 && dom.max > 0) {
      el("line", { x1: plotL, x2: plotR, y1: yOf(0), y2: yOf(0), stroke: TREND_ZERO_COLOR, "stroke-width": 1 });
    }
    // 年度分界（虛線淡色）
    for (var i = 1; i < n; i++) {
      if (isYearBoundary(periods, i)) el("line", { x1: xOf(i), x2: xOf(i), y1: plotT, y2: plotB, stroke: "#B8C4D2", "stroke-width": 1, "stroke-dasharray": "4 3" });
    }
    // 月份刻度：首尾必顯示，中間依寬度略過
    selectAxisLabelIndices(periods, xOf, 13).forEach(function (j) {
      var anchor = j === 0 ? "start" : (j === n - 1 ? "end" : "middle");
      var x = j === 0 ? plotL : (j === n - 1 ? plotR : xOf(j));
      el("text", { x: x, y: H - 12, "font-size": 13, fill: "#52545c", "text-anchor": anchor }, rocYearMonthShort(periods[j]));
    });

    // 系列
    var endLabels = [];
    if (slot.kind === "bar") {
      var bw = Math.max(4, Math.min(18, (plotR - plotL) / n * 0.6));
      var y0 = yOf(0);
      values[0].forEach(function (v, k) {
        if (!isFiniteNumber(v)) return;
        var yv = yOf(v);
        el("rect", { x: xOf(k) - bw / 2, y: Math.min(yv, y0), width: bw, height: Math.max(1, Math.abs(yv - y0)), fill: slot.series[0].color });
      });
    } else {
      slot.series.forEach(function (s, si) {
        var vs = values[si];
        var d = "", connected = false;
        vs.forEach(function (v, k) {
          if (!isFiniteNumber(v)) { connected = false; return; }
          var breakHere = slot.breakAtNewYear && k > 0 && isYearBoundary(periods, k);
          d += (!connected || breakHere ? "M" : "L") + xOf(k).toFixed(1) + " " + yOf(v).toFixed(1) + " ";
          connected = true;
        });
        var pathAttrs = { d: d.trim(), fill: "none", stroke: s.color, "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" };
        if (s.prev) { pathAttrs["stroke-dasharray"] = "6 4"; pathAttrs["stroke-opacity"] = 0.85; }
        el("path", pathAttrs);
        vs.forEach(function (v, k) {
          if (!isFiniteNumber(v)) return;
          if (s.prev) el("circle", { cx: xOf(k), cy: yOf(v), r: 3, fill: "#ffffff", stroke: s.color, "stroke-width": 1.5 });
          else el("circle", { cx: xOf(k), cy: yOf(v), r: 3, fill: s.color });
        });
        if (!s.prev) {
          for (var q = n - 1; q >= 0; q--) {
            if (isFiniteNumber(vs[q])) {
              // 線段自左上下降至端點時，標示放在端點下方，避免壓在線上
              var fromAbove = q > 0 && isFiniteNumber(vs[q - 1]) && yOf(vs[q - 1]) < yOf(vs[q]);
              endLabels.push({ x: xOf(q), y: yOf(vs[q]) + (fromAbove ? 18 : -8), text: minusFix((s.endFmt || s.fmt)(vs[q])) });
              break;
            }
          }
        }
      });
    }
    // 端點標示：位於最新點上方，不超出繪圖區上緣，彼此保持至少15px間距，白色描邊避免壓線
    endLabels.forEach(function (lb) { lb.y = Math.min(plotB - 4, Math.max(plotT + 12, lb.y)); });
    endLabels.sort(function (a, b) { return a.y - b.y; });
    for (var e = 1; e < endLabels.length; e++) {
      if (endLabels[e].y - endLabels[e - 1].y < 15) endLabels[e].y = endLabels[e - 1].y + 15;
    }
    endLabels.forEach(function (lb) {
      el("text", { x: lb.x - 6, y: lb.y, "font-size": 13, "font-weight": 800, fill: TREND_POS_COLOR, "text-anchor": "end",
        stroke: "#ffffff", "stroke-width": 3, "paint-order": "stroke" }, lb.text);
    });

    // 懸停導引線與 tooltip（只在圖區內顯示）
    var guide = el("line", { x1: 0, x2: 0, y1: plotT, y2: plotB, stroke: TREND_POS_COLOR, "stroke-width": 1, "stroke-dasharray": "2 3", visibility: "hidden" });
    var overlay = el("rect", { x: plotL, y: plotT, width: plotR - plotL, height: plotB - plotT, fill: "transparent" });
    var tip = document.createElement("div");
    tip.className = "trend-tip";
    tip.hidden = true;
    wrap.appendChild(svg);
    wrap.appendChild(tip);

    overlay.addEventListener("pointermove", function (ev) {
      var rect = svg.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var k = n === 1 ? 0 : Math.round((x - plotL) / (plotR - plotL) * (n - 1));
      k = Math.max(0, Math.min(n - 1, k));
      var p = periods[k];
      guide.setAttribute("x1", xOf(k));
      guide.setAttribute("x2", xOf(k));
      guide.setAttribute("visibility", "visible");
      var lines = ["<strong>" + escapeHtml(periodFullLabel(p)) + "</strong>"];
      slot.series.forEach(function (s, si) {
        var v = values[si][k];
        var fmtFn = s.tipFmt || s.fmt;
        lines.push(escapeHtml(s.label) + "（" + escapeHtml(periodFullLabel(s.periodOf(p))) + "）：" + escapeHtml(isFiniteNumber(v) ? fmtFn(v) : "缺資料"));
      });
      tip.innerHTML = lines.join("<br>");
      tip.hidden = false;
      var left = xOf(k) + 12;
      if (left > W * 0.55) left = xOf(k) - 12 - tip.offsetWidth;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = (plotT + 4) + "px";
    });
    overlay.addEventListener("pointerleave", function () {
      guide.setAttribute("visibility", "hidden");
      tip.hidden = true;
    });

    // 無障礙：隱藏數據表（供螢幕閱讀器與 CSV 對照）
    var srTable = document.createElement("table");
    srTable.className = "sr-only";
    srTable.innerHTML = "<thead><tr><th>月份</th>" + slot.series.map(function (s) { return "<th>" + escapeHtml(s.label) + "</th>"; }).join("") +
      "</tr></thead><tbody>" + periods.map(function (p, k) {
        return "<tr><td>" + escapeHtml(periodFullLabel(p)) + "</td>" + slot.series.map(function (s, si) {
          var v = values[si][k];
          return "<td>" + escapeHtml(isFiniteNumber(v) ? s.fmt(v) : "缺資料") + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody>";
    wrap.appendChild(srTable);
  }

  function renderTrendCard(key, slot, periods) {
    var t = document.getElementById("trend-title-" + key);
    var u = document.getElementById("trend-unit-" + key);
    var lg = document.getElementById("trend-legend-" + key);
    var ch = document.getElementById("trend-chart-" + key);
    var nt = document.getElementById("trend-note-" + key);
    if (t) t.textContent = slot.title;
    if (u) u.textContent = "單位：" + slot.unit;
    if (lg) renderTrendLegend(lg, slot);
    if (ch) buildTrendSvg(ch, periods, slot);
    if (nt) nt.textContent = slot.noteFn ? slot.noteFn(periods) : "";
  }

  /** 趨勢期間：近6／近12以資料月份為截止；自訂以所選結束月為截止（與匯出共用 resolveRange）。 */
  function trendPeriodsFor(period) {
    return resolveRange(period, state.trendRange, state.customStart, state.customEnd);
  }

  function renderTrendsTab(period) {
    var metric = METRIC_CATALOG[state.activeMetricId];
    var pType = currentPeriodType(metric);
    var unavailEl = document.getElementById("trends-unavailable");
    var bodyEl = document.getElementById("trends-body");
    if (metric.kind === "unavailable") {
      if (bodyEl) bodyEl.hidden = true;
      if (unavailEl) { unavailEl.hidden = false; unavailEl.textContent = metric.unavailableReason; }
      return;
    }
    if (bodyEl) bodyEl.hidden = false;
    if (unavailEl) unavailEl.hidden = true;

    var periods = trendPeriodsFor(period);
    var endP = periods.length ? periods[periods.length - 1] : period;
    var captionEl = document.getElementById("trend-period-caption");
    if (captionEl && periods.length) {
      var parts = ["實際期間：" + rocYearMonthShort(periods[0]) + "至" + rocYearMonthShort(endP) + "（共" + periods.length + "個月）"];
      if (metricSupportsPeriodType(metric) && pType === "ytd") parts.push("YTD為年初至今累計，每年1月重新起算，跨年度分段顯示");
      captionEl.textContent = parts.join("｜");
    }

    var plan = trendPlanFor(metric, pType);
    renderTrendCard("market", plan.market, periods);
    renderTrendCard("fareast", plan.fareast, periods);
    renderTrendCard("compare", plan.compare, periods);
    renderTrendCard("position", plan.position, periods);

    renderDiagnosisSelected(endP, metric, pType);
    renderDiagnosisTable(endP);
  }

  /** 診斷標題的數據方式字樣：流量型依單月／年初至今累計，存量與比率為當月值。 */
  function diagBasisWord(metric, pType) {
    return metricSupportsPeriodType(metric) ? (pType === "ytd" ? "年初至今累計" : "單月") : "當月值";
  }

  /** 數字負號統一為「−」（U+2212）；僅用於診斷與同期變化數字的顯示，不改動計算。 */
  function diagSign(text) {
    return String(text).replace(/-/g, "−");
  }

  /** 指標短名：去除括號說明，例如「簽帳金額（不含預借現金）」→「簽帳金額」。 */
  function diagShortName(metric) {
    return String(metric.label).split("（")[0];
  }

  /** 同期變化數值文字（YOY 為 %，比率為 pp）；無法計算時回傳原因與樣式。 */
  function diagChangeResult(v, isRatio, prevRaw) {
    if (isFiniteNumber(v)) {
      var r = Number(v.toFixed(2));
      return { text: diagSign(isRatio ? signedPp(v) : signedPct(v)), cls: deltaClass(r), ok: true };
    }
    if (prevRaw === 0) return { text: "去年同期為0，無法計算YOY", cls: "delta-na", ok: false };
    return { text: "去年同期資料不足", cls: "delta-na", ok: false };
  }

  /** 銀行同業排名結果：第X名｜較去年持平／上升X名／下降X名；以既有30家銀行排名為準。 */
  function diagRankResult(curRank, prevRank) {
    if (!isFiniteNumber(curRank)) return { text: "缺資料", cls: "delta-na" };
    var dir = rankChangeDirection(curRank, prevRank);
    if (dir === null) return { text: "第" + curRank + "名｜去年同期資料不足", cls: "delta-na" };
    if (dir === 0) return { text: "第" + curRank + "名｜較去年持平", cls: "delta-zero" };
    var diff = Math.abs(prevRank - curRank);
    return dir > 0
      ? { text: "第" + curRank + "名｜較去年上升" + diff + "名", cls: "delta-pos" }
      : { text: "第" + curRank + "名｜較去年下降" + diff + "名", cls: "delta-neg" };
  }

  /** 診斷組：項目在上、結果在下，兩者同字級；isGap 為遠銀－市場比較組（淡底色）。 */
  function diagItemHtml(label, text, cls, isGap) {
    return '<div class="diag-item' + (isGap ? " is-gap" : "") + '">' +
      '<div class="diag-item-label">' + escapeHtml(label) + '</div>' +
      '<div class="diag-item-value ' + (cls || "") + '">' + escapeHtml(text) + '</div></div>';
  }

  /**
   * 整合摘要句（純函式，可於 Node 測試）：一句話，數字由程式帶入，不寫死、不推論原因。
   * f＝遠銀同期變化、m＝市場同期變化（非比率為 %，比率為 pp）、gap＝遠銀－市場（非比率為 YOY 差；比率為當期比率差）、
   * sd＝市占率同期變化（pp；不適用為 null）、subj＝指標短名（YTD 加「累計」）。
   */
  function diagSummarySentences(f0, m0, gap0, sd0, isRatio, subj) {
    var f = Number(f0.toFixed(2)), m = Number(m0.toFixed(2));
    function sg(v, unit) { return (v > 0 ? "+" : (v < 0 ? "−" : "")) + Math.abs(v).toFixed(2) + unit; }
    var head = isRatio
      ? "市場" + subj + "較去年同期" + sg(m, " pp") + "，遠銀" + sg(f, " pp")
      : "市場" + subj + "YOY" + sg(m, "%") + "，遠銀" + sg(f, "%");
    var clause = "";
    if (isFiniteNumber(gap0)) {
      var g = Number(gap0.toFixed(2));
      var word = g > 0 ? "高於" : (g < 0 ? "低於" : "");
      var who = isRatio ? "當期遠銀比率" : "遠銀";
      clause = "，" + who + (g === 0 ? "與市場持平" : word + "市場" + Math.abs(g).toFixed(2) + " pp");
    }
    if (!isRatio && f < 0 && m < 0) clause += "，兩者皆減少，遠銀減幅" + (f < m ? "較大" : (f > m ? "較小" : "相同"));
    var share = "";
    if (isFiniteNumber(sd0)) {
      var s = Number(sd0.toFixed(2));
      share = s === 0 ? "；市占率較去年同期持平" : "；市占率較去年同期" + (s > 0 ? "上升" : "下降") + Math.abs(s).toFixed(2) + " pp";
    }
    return head + clause + share + "。";
  }

  /** 整合摘要（診斷區上方）：資料缺漏時明確說明；比較基準與期末月份由區塊副標題標示。 */
  function diagSummaryHtml(period, metric, pType) {
    var fe = findFarEastern(period), mkt = findMarket(period);
    if (!fe || !mkt) return "";
    var isRatio = metric.kind === "ratio";
    var ytd = metricSupportsPeriodType(metric) && pType === "ytd";
    var feV = metricView(metric, fe, pType), mktV = metricView(metric, mkt, pType);
    var prevPeriod = prevYearPeriod(period);
    var prevFe = metricView(metric, findFarEastern(prevPeriod), pType);
    var prevMkt = metricView(metric, findMarket(prevPeriod), pType);
    var subj = (ytd ? "累計" : "") + diagShortName(metric);
    if (!isFiniteNumber(feV.yoy) || !isFiniteNumber(mktV.yoy)) {
      var zero = prevFe.raw === 0 || prevMkt.raw === 0;
      return "<p>" + escapeHtml("市場與遠銀" + subj + "的去年同期" + (zero ? "為0，無法計算同期變化" : "資料不足，無法比較同期變化") + "。") + "</p>";
    }
    var applicable = !isRatio && metric.kind !== "flow_no_share" && metricSupportsShare(metric);
    var sd = applicable ? safeDiff(feV.share, prevFe.share) : null;
    var gap = metricRelativeGap(metric, feV, mktV);
    return "<p>" + escapeHtml(diagSummarySentences(feV.yoy, mktV.yoy, gap, sd, isRatio, subj)) + "</p>";
  }

  /** 遠銀表現診斷（所選指標）：滿寬兩排、每排三組「項目＋結果」；不適用項目顯示「不適用」，不另行計算。 */
  function renderDiagnosisSelected(period, metric, pType) {
    var grid = document.getElementById("diagnosis-selected-grid");
    var subEl = document.getElementById("diagnosis-subtitle");
    var sumEl = document.getElementById("diagnosis-summary");
    if (!grid) return;
    grid.innerHTML = "";
    var mkt = findMarket(period), fe = findFarEastern(period);
    if (subEl) subEl.textContent = metric.label + "｜" + diagBasisWord(metric, pType) + "｜資料月份：民國" + (mkt ? periodShortLabel(mkt) : "—") + "（所選期間最後一個月）";
    if (sumEl) sumEl.innerHTML = diagSummaryHtml(period, metric, pType);
    if (!fe || !mkt) return;

    var prevPeriod = prevYearPeriod(period);
    var prevFeV = metricView(metric, findFarEastern(prevPeriod), pType);
    var prevMktV = metricView(metric, findMarket(prevPeriod), pType);
    var feV = metricView(metric, fe, pType), mktV = metricView(metric, mkt, pType);
    var isRatio = metric.kind === "ratio";
    var ytd = metricSupportsPeriodType(metric) && pType === "ytd";
    var items = [];

    items.push(diagItemHtml("遠銀" + (ytd ? "累計" : "") + diagShortName(metric), metricDisplayText(metric, feV), ""));

    var feChg = diagChangeResult(feV.yoy, isRatio, prevFeV.raw);
    items.push(diagItemHtml(isRatio ? "遠銀較去年同期變化" : "遠銀YOY", feChg.text, feChg.cls));

    var mkChg = diagChangeResult(mktV.yoy, isRatio, prevMktV.raw);
    items.push(diagItemHtml(isRatio ? "市場較去年同期變化" : "市場YOY", mkChg.text, mkChg.cls));

    var gap = metricRelativeGap(metric, feV, mktV);
    items.push(diagItemHtml(isRatio ? "遠銀－市場當期比率差" : "YOY差距（遠銀－市場）",
      isFiniteNumber(gap) ? diagSign(signedPp(gap)) : "缺資料",
      isFiniteNumber(gap) ? deltaClass(Number(gap.toFixed(2))) : "delta-na", true));

    var shareApplicable = !isRatio && metric.kind !== "flow_no_share" && metricSupportsShare(metric);
    if (!shareApplicable) {
      items.push(diagItemHtml("市占率較去年同期變化", "不適用", "delta-na"));
    } else {
      var sd = safeDiff(feV.share, prevFeV.share);
      items.push(isFiniteNumber(sd)
        ? diagItemHtml("市占率較去年同期變化", diagSign(signedPp(sd)), deltaClass(Number(sd.toFixed(2))))
        : diagItemHtml("市占率較去年同期變化", "去年同期資料不足", "delta-na"));
    }

    var rk = diagRankResult(feV.bankRank, prevFeV.bankRank);
    items.push(diagItemHtml("銀行同業排名（30家）", rk.text, rk.cls));

    grid.innerHTML = items.join("");
  }

  /** 其他指標表（七欄）：同期變化以去年同期為基期；相對市場欄分兩行，比率型用當期比率差。 */
  function renderDiagnosisTable(period) {
    var tbody = document.getElementById("diagnosis-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    var prevYear = prevYearPeriod(period);
    var fe = findFarEastern(period), mkt = findMarket(period);
    if (!fe || !mkt) return;
    var feRecPrevY = findFarEastern(prevYear), mktRecPrevY = findMarket(prevYear);

    METRIC_ORDER.forEach(function (id) {
      var metric = METRIC_CATALOG[id];
      if (metric.kind === "unavailable") return;
      var pType = metricSupportsPeriodType(metric) ? "ytd" : "month";
      var isRatio = metric.kind === "ratio";
      var feV = metricView(metric, fe, pType);
      var mktV = metricView(metric, mkt, pType);
      var feP = metricView(metric, feRecPrevY, pType);
      var mktP = metricView(metric, mktRecPrevY, pType);
      var prefix = isRatio ? "較去年同期 " : "YOY ";

      var feC = diagChangeResult(feV.yoy, isRatio, feP.raw);
      var mkC = diagChangeResult(mktV.yoy, isRatio, mktP.raw);
      var gap = metricRelativeGap(metric, feV, mktV);
      var gapCls = isFiniteNumber(gap) ? deltaClass(Number(gap.toFixed(2))) : "delta-na";
      var relWord = isFiniteNumber(gap)
        ? (isRatio ? "當期" : "YOY") + (gap > 0 ? "高於市場" : (gap < 0 ? "低於市場" : "與市場持平"))
        : "缺資料";
      var relVal = isFiniteNumber(gap) ? diagSign(signedPp(gap)) : "";

      var shareApplicable = !isRatio && metric.kind !== "flow_no_share" && metricSupportsShare(metric);
      var shareChange = (shareApplicable && isFiniteNumber(feV.share) && isFiniteNumber(feP.share)) ? feV.share - feP.share : null;
      var shareCell = !shareApplicable ? "不適用" : (isFiniteNumber(shareChange) ? diagSign(signedPp(shareChange)) : "缺同期資料");
      var shareCls = !shareApplicable ? "delta-na" : (isFiniteNumber(shareChange) ? deltaClass(Number(shareChange.toFixed(2))) : "delta-na");

      var rankChange = (isFiniteNumber(feV.bankRank) && isFiniteNumber(feP.bankRank)) ? feP.bankRank - feV.bankRank : null;
      var rankText = isFiniteNumber(rankChange) ? (rankChange > 0 ? "上升" + rankChange + "名" : rankChange < 0 ? "下降" + (-rankChange) + "名" : "持平") : "—";
      var rankCls = isFiniteNumber(rankChange) ? deltaClass(rankChange > 0 ? 1 : (rankChange < 0 ? -1 : 0)) : "";

      var ytdTag = (metricSupportsPeriodType(metric) && pType === "ytd") ? '<span class="diag-period-tag">年初至今</span>' : "";
      // 有效卡率「較去年同期」字樣較長，拆成兩行避免與下個欄位擠在一起；YOY 較短維持單行。
      function changeCellHtml(c) {
        if (!c.ok) return escapeHtml(c.text);
        if (!isRatio) return escapeHtml(prefix + c.text);
        return '<span class="diag-change-prefix">' + escapeHtml(prefix.trim()) + '</span><br>' + escapeHtml(c.text);
      }
      var tr = document.createElement("tr");
      if (id === state.activeMetricId) tr.className = "is-selected-metric";
      tr.innerHTML =
        '<th scope="row"><span class="diag-metric-name">' + escapeHtml(diagShortName(metric)) + '</span>' + ytdTag + '</th>' +
        '<td class="num">' + escapeHtml(metricDisplayText(metric, feV)) + '</td>' +
        '<td class="num ' + feC.cls + '">' + changeCellHtml(feC) + '</td>' +
        '<td class="num ' + mkC.cls + '">' + changeCellHtml(mkC) + '</td>' +
        '<td class="num rel-cell"><span class="rel-word ' + gapCls + '">' + escapeHtml(relWord) + '</span>' +
          (relVal ? '<span class="rel-val ' + gapCls + '">' + escapeHtml(relVal) + '</span>' : "") + '</td>' +
        '<td class="num ' + shareCls + '">' + escapeHtml(shareCell) + '</td>' +
        '<td class="num ' + rankCls + '">' + escapeHtml(rankText) + '</td>';
      tbody.appendChild(tr);
    });
  }

  // ==================================================================
  // 十、同業比較頁籤
  // ==================================================================

  /** 單月／YTD 僅適用於流量型指標；其他指標不加數據方式標籤。 */
  function peerBasisTag(metric, pType) {
    if (!metricSupportsPeriodType(metric)) return "";
    return pType === "ytd" ? "年初至今（YTD）" : "單月";
  }

  function peerCaptionSuffix(metric, pType) {
    var tag = peerBasisTag(metric, pType);
    return tag ? "｜" + tag : "";
  }

  /** 匯出檔名用數據方式標籤：流量指標為單月／YTD，存量與比率為月底。 */
  function exportBasisTag(metric, pType) {
    if (metricSupportsPeriodType(metric)) return pType === "ytd" ? "YTD" : "單月";
    return "月底";
  }

  function peerRankBasis(pType) {
    return pType === "ytd" ? "較去年同期" : "較去年同月";
  }

  // ==================================================================
  // 十、同業比較（已合併原「資料明細」）：比較範圍切換為「流通卡前12大銀行」或「全部發卡機構」。
  // 名單、數值、YOY、市占率與排名皆沿用 processed 既有欄位；範圍、搜尋與排序只改變顯示與匯出列，不重算排名或市占率。
  // ==================================================================

  /** 同業比較列（純資料）：依範圍取得名單；排名以既有母體（銀行30家、發卡機構32家）為準。 */
  function peerRowsFor(period, metric, pType, scope) {
    var pool = scope === "all" ? issuersInPeriod(period) : top12Banks(period);
    var prevByName = {};
    issuersInPeriod(prevYearPeriod(period)).forEach(function (r) { prevByName[r.issuer_name] = r; });
    var fe = findFarEastern(period);
    var feVal = fe ? displayNumber(metric, metricView(metric, fe, pType)) : null;
    // 前12大模式：「所選指標排名」於這12家銀行內重新計算（標準競賽排名），與全30家的既有 bankRank 欄位不同母體，不可混用。
    var subsetRanks = scope === "all" ? null : standardCompetitionRank(
      pool.map(function (r) { return { id: r.issuer_name, value: displayNumber(metric, metricView(metric, r, pType)) }; })
    );
    return pool.map(function (r) {
      var v = metricView(metric, r, pType);
      var prev = prevByName[r.issuer_name];
      var val = displayNumber(metric, v);
      var isFe = r.issuer_name === FAR_EASTERN_NAME;
      return {
        isFe: isFe,
        name: r.issuer_name,
        type: r.issuer_type,
        cardsRank: (r.issuer_type === "bank" && isFiniteNumber(r.cards_in_force_bank_rank)) ? r.cards_in_force_bank_rank : null,
        issuerRank: isFiniteNumber(v.issuerRank) ? v.issuerRank : null,
        rank: scope === "all" ? null : (subsetRanks && Object.prototype.hasOwnProperty.call(subsetRanks, r.issuer_name) ? subsetRanks[r.issuer_name] : null),
        value: isFiniteNumber(val) ? val : null,
        yoy: isFiniteNumber(v.yoy) ? v.yoy : null,
        prevRaw: prev ? metricView(metric, prev, pType).raw : undefined,
        share: isFiniteNumber(v.share) ? v.share : null,
        gap: (isFe || !isFiniteNumber(val) || !isFiniteNumber(feVal)) ? null : val - feVal,
      };
    });
  }

  /** 表格欄位（依範圍）：全部發卡機構模式不含銀行排名；選流通卡數時只保留一個排名欄。 */
  function peerColumns(scope, metric) {
    var cols = scope === "all"
      ? [{ k: "issuerRank", label: "發卡機構排名", cls: "col-rank" }, { k: "name", label: "機構名稱", cls: "col-name" },
         { k: "type", label: "類型", sortable: false, cls: "col-type" }]
      : [{ k: "cardsRank", label: "流通卡排名", cls: "col-rank" }, { k: "name", label: "銀行", cls: "col-name" }];
    cols.push({ k: "value", label: (METRIC_SHORT_NAMES[metric.id] || metric.label), unit: displayUnit(metric), cls: "col-value" });
    cols.push({ k: "yoy", label: "同期變化", cls: "col-yoy" });
    cols.push({ k: "share", label: "市占率", cls: "col-share" });
    if (scope !== "all" && metric.id !== "cards_in_force") cols.push({ k: "rank", label: "範圍內排名", cls: "col-rank" });
    cols.push({ k: "gap", label: "與遠銀差額", unit: gapUnit(metric), help: true, cls: "col-gap" });
    return cols;
  }

  /** 切換範圍後，若新範圍不支援目前排序欄位，改回所選指標數值由大至小（純函式）。 */
  function peerSortFor(scope, metric, field, dir) {
    var ok = peerColumns(scope, metric).some(function (c) { return c.k === field && c.sortable !== false; });
    return ok ? { field: field, dir: dir } : { field: "value", dir: "desc" };
  }

  function resolvePeerSort(scope, metric) {
    var s = peerSortFor(scope, metric, state.peersSortField, state.peersSortDir);
    state.peersSortField = s.field;
    state.peersSortDir = s.dir;
  }

  /** 搜尋（純函式）：機構全名或既有簡稱包含關鍵字即符合，不分大小寫。 */
  function filterPeerRows(rows, query) {
    var q = String(query || "").trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(function (x) {
      return x.name.toLowerCase().indexOf(q) >= 0 || bankShortName(x.name).toLowerCase().indexOf(q) >= 0;
    });
  }

  function gapUnit(metric) {
    return metric.fmtRaw === fmtPlainPct ? "pp" : displayUnit(metric);
  }

  /** 與遠銀差額文字：正值「+」、負值「−」，保留單位；未四捨五入計算後才格式化。 */
  function peerGapText(metric, n) {
    if (!isFiniteNumber(n)) return "—";
    var r = Number(n.toFixed(displayDecimals(metric)));
    var sign = r > 0 ? "+" : (r < 0 ? "−" : "");
    return sign + fmtDisplayNumber(metric, Math.abs(n)) + " " + gapUnit(metric);
  }

  /** 表格用與遠銀差額文字：欄名已標示單位，儲存格不重複單位（CSV 仍由 peerGapText／headMap 保留完整單位）。 */
  function peerGapCellText(metric, n) {
    if (!isFiniteNumber(n)) return "—";
    var r = Number(n.toFixed(displayDecimals(metric)));
    var sign = r > 0 ? "+" : (r < 0 ? "−" : "");
    return sign + fmtDisplayNumber(metric, Math.abs(n));
  }

  /** 同期變化文字：數量、金額、每卡金額為「YOY ±X%」；有效卡率為「較去年同期 ±X pp」。缺值與去年同期為0分開說明。 */
  function peerChangeText(x, metric) {
    var isRatio = metric.kind === "ratio";
    if (isFiniteNumber(x.yoy)) {
      var s = isRatio ? signedPp(x.yoy) : signedPct(x.yoy);
      return (isRatio ? "較去年同期 " : "YOY ") + s.replace("-", "−");
    }
    if (x.prevRaw === 0) return "去年同期為0，無法計算YOY";
    return "缺同期資料";
  }

  function peerNotApplicableShare(metric) {
    return metric.kind === "ratio" || metric.kind === "flow_no_share" || !metricSupportsShare(metric);
  }

  function peerCellHtml(k, x, metric) {
    switch (k) {
      case "issuerRank": return '<td class="num col-rank-cell">' + fmtRank(x.issuerRank) + '</td>';
      case "cardsRank": return '<td class="num col-rank-cell">' + (x.type === "bank" ? fmtRank(x.cardsRank) : "—") + '</td>';
      case "name": return '<td class="col-name"><span title="' + escapeHtml(x.name) + '">' + escapeHtml(bankShortName(x.name)) + '</span>' +
        (x.isFe ? ' <span class="tag-self">本行</span>' : "") + '</td>';
      case "type": return '<td>' + (x.type === "bank" ? "銀行" : "非銀行發卡機構") + '</td>';
      case "value": return '<td class="num">' + escapeHtml(fmtDisplayNumber(metric, x.value)) + '</td>';
      case "yoy": return '<td class="num ' + (isFiniteNumber(x.yoy) ? deltaClass(Number(x.yoy.toFixed(2))) : "delta-na") + '">' + escapeHtml(peerChangeText(x, metric)) + '</td>';
      case "share": return '<td class="num">' + (peerNotApplicableShare(metric) ? "不適用" : (isFiniteNumber(x.share) ? fmtPlainPct(x.share) : "—")) + '</td>';
      case "rank": return '<td class="num col-rank-cell">' + fmtRank(x.rank) + '</td>';
      case "gap": return '<td class="num">' + (x.isFe ? "—" : escapeHtml(peerGapCellText(metric, x.gap))) + '</td>';
    }
    return "<td></td>";
  }

  /** 表格列（畫面與匯出共用）：範圍名單 → 搜尋 → 排序。 */
  function peerVisibleRows(period, metric, pType) {
    var all = peerRowsFor(period, metric, pType, state.peersScope);
    return sortPeerRows(filterPeerRows(all, state.peersSearch), state.peersSortField, state.peersSortDir);
  }

  function renderPeersTab(period) {
    var metric = METRIC_CATALOG[state.activeMetricId];
    var pType = currentPeriodType(metric);
    var market = findMarket(period);
    var condEl = document.getElementById("peers-condition");
    if (condEl) condEl.textContent = (market ? periodShortLabel(market) : "—") + "｜" + metric.label + peerCaptionSuffix(metric, pType);

    // 上方遠銀排名與相鄰同業：依目前選定的比較範圍（前12大銀行／全部發卡機構）計算，與下方表格範圍同步。
    var summaryEl = document.getElementById("peers-summary");
    var scopeNow = state.peersScope;
    var pool = peerSummaryPool(period, metric, pType, scopeNow);
    var feEntry = pool.find(function (x) { return x.row.issuer_name === FAR_EASTERN_NAME; }) || null;
    if (summaryEl) {
      var prevPeriod = prevYearPeriod(period);
      var prevPool = peerSummaryPool(prevPeriod, metric, pType, scopeNow);
      var prevFeEntry = prevPool.find(function (x) { return x.row.issuer_name === FAR_EASTERN_NAME; }) || null;
      var cards = buildPeerCards(metric, scopeNow, pool, feEntry, prevPool, prevFeEntry, peerRankBasis(pType));
      summaryEl.innerHTML = cards.map(function (c) {
        return '<div class="peer-stat"><div class="peer-stat-label">' + escapeHtml(c.label) + '</div>' +
          '<div class="peer-stat-value ' + (c.cls || "") + '">' + escapeHtml(c.value) + '</div>' +
          (c.sub ? '<div class="peer-stat-sub">' + escapeHtml(c.sub) + '</div>' : '') +
          (c.extra ? '<div class="peer-stat-extra">' + escapeHtml(c.extra) + '</div>' : '') + '</div>';
      }).join("");
    }
    var scopeTitleEl = document.getElementById("peers-summary-title");
    if (scopeTitleEl) scopeTitleEl.textContent = "遠銀排名與同業差距（" + (scopeNow === "all" ? "全部發卡機構" : "流通卡前12大銀行") + "）";

    var marketLineEl = document.getElementById("peers-market-line");
    if (marketLineEl) {
      var mv = metricView(metric, findMarket(period), pType);
      var isRatio = metric.kind === "ratio";
      var mvText = isRatio ? (isFiniteNumber(mv.yoy) ? "較去年同期 " + signedPp(mv.yoy) : "缺同期資料")
        : (isFiniteNumber(mv.yoy) ? "YOY " + signedPct(mv.yoy) : "缺同期資料");
      var mvCls = isFiniteNumber(mv.yoy) ? deltaClass(Number(mv.yoy.toFixed(2))) : "delta-na";
      marketLineEl.innerHTML = escapeHtml("整體市場" + metric.label + "年度變動：") + '<strong class="' + mvCls + '">' + escapeHtml(mvText) + '</strong>' +
        escapeHtml("（比較基準：" + (pType === "ytd" ? "去年同期年初至今累計" : "去年同月") + "）");
    }

    renderPeersTable(period, metric, pType);
  }

  function renderPeersTable(period, metric, pType) {
    var table = document.getElementById("peers-table");
    var tbody = document.getElementById("peers-tbody");
    var thead = table ? table.querySelector("thead") : null;
    if (!tbody || !thead) return;
    var scope = state.peersScope;
    resolvePeerSort(scope, metric);
    var cols = peerColumns(scope, metric);
    var all = peerRowsFor(period, metric, pType, scope);
    var q = state.peersSearch.trim();
    var rows = sortPeerRows(filterPeerRows(all, q), state.peersSortField, state.peersSortDir);

    thead.innerHTML = "<tr>" + cols.map(function (c) {
      var sortable = c.sortable !== false;
      var active = sortable && state.peersSortField === c.k;
      var arrow = active ? (state.peersSortDir === "asc" ? " ▲" : " ▼") : "";
      var help = c.help
        ? '<details class="col-help"><summary>說明</summary>正值表示同業數值高於遠銀，負值表示低於遠銀；差額為數值比較，不代表經營優劣。</details>'
        : "";
      var unitLine = c.unit ? '<br><span class="col-unit">（' + escapeHtml(c.unit) + '）</span>' : "";
      var cls = (c.cls || "") + (sortable ? " is-sortable" + (active ? " is-sorted" : "") : "");
      return '<th scope="col" class="' + cls + '"' + (sortable ? ' data-sort="' + c.k + '"' : "") +
        ' aria-sort="' + (active ? (state.peersSortDir === "asc" ? "ascending" : "descending") : "none") + '">' +
        '<span class="col-label">' + escapeHtml(c.label) + escapeHtml(arrow) + '</span>' + unitLine + help + "</th>";
    }).join("") + "</tr>";

    tbody.innerHTML = "";
    if (!rows.length) {
      var empty = document.createElement("tr");
      empty.className = "empty-row";
      var msg = q
        ? "沒有符合「" + escapeHtml(q) + "」的" + (scope === "all" ? "發卡機構" : "銀行") + "。" +
          (scope === "top12" ? "搜尋只作用於前12大銀行；可切換至「全部發卡機構」再查詢。" : "") +
          ' <button type="button" class="ghost-btn peers-clear-search">清除搜尋</button>'
        : "目前範圍沒有可顯示的資料。";
      empty.innerHTML = '<td colspan="' + cols.length + '">' + msg + "</td>";
      tbody.appendChild(empty);
    }
    rows.forEach(function (x) {
      var tr = document.createElement("tr");
      if (x.isFe) tr.className = "is-far-eastern";
      tr.innerHTML = cols.map(function (c) { return peerCellHtml(c.k, x, metric); }).join("");
      tbody.appendChild(tr);
    });

    var titleEl = document.getElementById("peers-table-title");
    if (titleEl) titleEl.textContent = (scope === "all" ? "全部發卡機構" : "流通卡前12大銀行") + "｜同業比較";
    var captionEl = document.getElementById("peers-table-caption");
    if (captionEl) {
      var mkt = findMarket(period);
      captionEl.textContent = (mkt ? periodShortLabel(mkt) : "—") + "｜" + metric.label + peerCaptionSuffix(metric, pType) +
        "｜單位：" + displayUnit(metric) + (metric.kind === "ratio" ? "（差額單位 pp）" : "") +
        "｜排名母體：" + (scope === "all" ? "當月全部" + all.length + "家發卡機構" : "前" + all.length + "大銀行內");
    }
    var noteEl = document.getElementById("peers-table-note");
    if (noteEl) {
      noteEl.textContent = scope === "all"
        ? "類型欄區分銀行與非銀行發卡機構；「" + metric.label + "」發卡機構排名以當月全部" + all.length + "家發卡機構為母體，搜尋與排序不改變排名。"
        : "「流通卡排名」為名單依據：所選月份流通卡數前12大銀行，切換指標不更換名單；「範圍內排名」為「" + metric.label + "」於這12家銀行內重新計算之排名（不等於全部30家銀行排名），搜尋與排序不改變排名。";
    }
    var countEl = document.getElementById("peers-count");
    if (countEl) {
      var unitWord = scope === "all" ? "家發卡機構" : "家銀行";
      countEl.textContent = (q ? "搜尋「" + q + "」：符合 " + rows.length + " " + unitWord : "顯示 " + rows.length + " " + unitWord) +
        "（範圍內共 " + all.length + " " + unitWord + "）";
    }
    syncPeersControls(q);
  }

  /** 同步範圍按鈕、搜尋框與清除鈕的狀態。 */
  function syncPeersControls(q) {
    document.querySelectorAll("#tab-peers .scope-btn").forEach(function (b) {
      var on = b.getAttribute("data-scope") === state.peersScope;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var input = document.getElementById("peers-search");
    if (input && input.value !== state.peersSearch) input.value = state.peersSearch;
    var clearBtn = document.getElementById("peers-search-clear");
    if (clearBtn) clearBtn.hidden = !q;
  }

  /** 切換比較範圍：保留月份、指標與數據方式；清除搜尋，避免舊搜尋造成空白結果。 */
  function setPeersScope(scope) {
    if (state.peersScope === scope) return;
    state.peersScope = scope;
    state.peersSearch = "";
    renderPeersTab(state.selectedPeriod);
  }

  function clearPeersSearch() {
    state.peersSearch = "";
    renderPeersTab(state.selectedPeriod);
    var input = document.getElementById("peers-search");
    if (input) input.focus();
  }

  function bindPeersControls() {
    document.querySelectorAll("#tab-peers .scope-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { setPeersScope(btn.getAttribute("data-scope")); });
    });
    var input = document.getElementById("peers-search");
    if (input) input.addEventListener("input", function () {
      state.peersSearch = input.value;
      renderPeersTab(state.selectedPeriod);
    });
    var clearBtn = document.getElementById("peers-search-clear");
    if (clearBtn) clearBtn.addEventListener("click", clearPeersSearch);

    var table = document.getElementById("peers-table");
    if (table) {
      table.addEventListener("click", function (evt) {
        if (evt.target.closest(".peers-clear-search")) { clearPeersSearch(); return; }
        if (evt.target.closest(".col-help")) return;
        var th = evt.target.closest("thead th[data-sort]");
        if (!th) return;
        var f = th.getAttribute("data-sort");
        if (state.peersSortField === f) state.peersSortDir = state.peersSortDir === "asc" ? "desc" : "asc";
        else { state.peersSortField = f; state.peersSortDir = "asc"; }
        renderPeersTab(state.selectedPeriod);
      });
    }
    var exportBtn = document.getElementById("export-btn");
    if (exportBtn) exportBtn.addEventListener("click", handleExportClick);
  }

  /**
   * 匯出同業比較（CSV）：與畫面相同之範圍、搜尋與排序結果；資料月份、比較範圍與排名母體寫入欄位與檔名。
   * 數值為未四捨五入計算後的格式化結果；缺值留空，不輸出 NaN／Infinity。
   */
  function exportPeersCsv() {
    var metric = METRIC_CATALOG[state.activeMetricId];
    if (!metric || metric.kind === "unavailable") return;
    var pType = currentPeriodType(metric);
    var period = state.selectedPeriod;
    var scope = state.peersScope;
    resolvePeerSort(scope, metric);
    var rows = peerVisibleRows(period, metric, pType);
    var cols = peerColumns(scope, metric);
    var isRatio = metric.kind === "ratio";
    var dec = displayDecimals(metric);
    var short = METRIC_SHORT_NAMES[metric.id] || metric.label;
    var basis = peerBasisTag(metric, pType);
    var valueHead = short + "（" + displayUnit(metric) + "）" + (basis ? "｜" + basis : "");
    var scopeLabel = scope === "all" ? "全部發卡機構" : "流通卡前12大銀行";
    var q = state.peersSearch.trim();
    var issuerCountNow = issuersInPeriod(period).length;
    var headMap = {
      issuerRank: short + "發卡機構排名（" + issuerCountNow + "家母體）", cardsRank: "流通卡數銀行排名（名單依據，全30家母體）",
      name: scope === "all" ? "機構名稱" : "銀行", type: "類型", value: valueHead,
      yoy: isRatio ? "較去年同期變化（pp）" : "YOY（%）", share: "市占率（%）",
      rank: short + "排名（前12大銀行內）", gap: "與遠銀差額（" + gapUnit(metric) + "）",
    };
    var header = ["資料月份（西元）", "比較範圍", "本行"].concat(cols.map(function (c) { return headMap[c.k]; }));
    var lines = [header.join(",")];
    function num(v, d) { return isFiniteNumber(v) ? Number(v).toFixed(d) : ""; }
    rows.forEach(function (x) {
      var cells = cols.map(function (c) {
        switch (c.k) {
          case "issuerRank": return x.issuerRank === null ? "" : x.issuerRank;
          case "cardsRank": return x.cardsRank === null ? "" : x.cardsRank;
          case "rank": return x.rank === null ? "" : x.rank;
          case "name": return csvCell(x.name);
          case "type": return x.type === "bank" ? "銀行" : "非銀行發卡機構";
          case "value": return num(x.value, dec);
          case "yoy": return num(x.yoy, 2);
          case "share": return peerNotApplicableShare(metric) ? "" : num(x.share, 2);
          case "gap": return x.isFe ? "" : num(x.gap, dec);
        }
        return "";
      });
      lines.push([csvCell(period), csvCell(scopeLabel), x.isFe ? "是" : ""].concat(cells).join(","));
    });
    var fileScope = scopeLabel + "_" + metric.label + "_" + exportBasisTag(metric, pType) + "_" + period;
    downloadCsv("信用卡市場與同業分析_同業比較_" + fileScope + (q ? "_搜尋_" + q : "") + ".csv", lines);
  }

  /** 數值欄位純數字（不重複單位，單位統一放欄名）。 */
  function metricNumberText(metric, raw, raw100m) {
    if (metric.fmtRaw === fmt100m) {
      var v = raw100m !== undefined ? raw100m : (isFiniteNumber(raw) ? raw / 100000 : null);
      return isFiniteNumber(v) ? v.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
    }
    if (metric.fmtRaw === fmtYuanPerCard) return fmtInt(raw);
    if (metric.fmtRaw === fmtPlainPct) return isFiniteNumber(raw) ? raw.toFixed(2) : "—";
    return metric.fmtRaw(raw);
  }

  /** 明細排序（純函式）：缺值一律排在最後，不論升冪或降冪。保留供測試與既有排序規則使用。 */
  function sortDetailRows(rows, field, sortDir) {
    var dir = sortDir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var va, vb;
      if (field === "issuer_rank") { va = a.view.issuerRank; vb = b.view.issuerRank; }
      else if (field === "bank_rank") { va = a.view.bankRank; vb = b.view.bankRank; }
      else if (field === "value") { va = a.view.raw; vb = b.view.raw; }
      else if (field === "yoy") { va = a.view.yoy; vb = b.view.yoy; }
      else { va = a.row.issuer_name; vb = b.row.issuer_name; }
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  function downloadCsv(filename, lines) {
    var csv = "﻿" + lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** 匯出市場總覽：與畫面相同之八項指標、相同數據方式（發卡與消費指標依所選單月／YTD），欄位與畫面一致。 */
  function exportOverviewCsv() {
    var period = state.selectedPeriod;
    var fe = findFarEastern(period), mkt = findMarket(period);
    if (!fe || !mkt) return;
    var prevFe = findFarEastern(prevYearPeriod(period));
    var basisWord = state.overviewBasis === "ytd" ? "年初至今累計" : "單月";
    var header = ["指標", "數據方式", "單位", "整體市場數值", "市場同期變化（%或pp）", "遠銀數值", "遠銀同期變化（%或pp）",
      "遠銀與市場比較（pp）", "遠銀銀行排名（30家）", "排名同期變化（名，正值為上升）"];
    var lines = [header.join(",")];
    OVERVIEW_GROUPS.forEach(function (group) {
      group.metrics.forEach(function (id) {
        var metric = METRIC_CATALOG[id];
        var pType = overviewPeriodType(metric);
        var mktV = metricView(metric, mkt, pType), feV = metricView(metric, fe, pType), prevV = metricView(metric, prevFe, pType);
        var gap = metricRelativeGap(metric, feV, mktV);
        var rankChange = (isFiniteNumber(feV.bankRank) && isFiniteNumber(prevV.bankRank)) ? prevV.bankRank - feV.bankRank : null;
        var basis = OVERVIEW_BASIS_METRICS.indexOf(id) >= 0 ? basisWord : (metric.kind === "ratio" ? "當月值" : "月底值");
        var unit = metric.kind === "ratio" ? "%" : displayUnit(metric);
        var mktNum = displayNumber(metric, mktV), feNum = displayNumber(metric, feV);
        lines.push([
          csvCell(metric.label), basis, unit,
          isFiniteNumber(mktNum) ? mktNum : "", isFiniteNumber(mktV.yoy) ? mktV.yoy.toFixed(2) : "",
          isFiniteNumber(feNum) ? feNum : "", isFiniteNumber(feV.yoy) ? feV.yoy.toFixed(2) : "",
          isFiniteNumber(gap) ? gap.toFixed(2) : "",
          isFiniteNumber(feV.bankRank) ? feV.bankRank : "", isFiniteNumber(rankChange) ? rankChange : "",
        ].join(","));
      });
    });
    downloadCsv("信用卡市場與同業分析_市場總覽_" + period + "_" + basisWord + ".csv", lines);
  }

  /** 匯出趨勢資料：目前指標、數據方式與趨勢期間每月之圖表數值（與趨勢頁共用同一資料來源）。 */
  function exportTrendCsv() {
    var metric = METRIC_CATALOG[state.activeMetricId];
    if (!metric || metric.kind === "unavailable") return;
    var period = state.selectedPeriod;
    var pType = currentPeriodType(metric);
    var periods = trendPeriodsFor(period);
    if (!periods.length) return;
    var isRatio = metric.kind === "ratio";
    var basisTag = exportBasisTag(metric, pType);
    var valUnit = displayUnit(metric);
    var yoyUnit = isRatio ? "pp" : "%";
    var gapLabel = isRatio ? "遠銀－市場比率差（pp）" : "遠銀－市場同期變化差（pp）";
    var header = ["月份（西元）", "月份（民國）", "指標", "數據方式", "遠銀數值（" + valUnit + "）", "市場數值（" + valUnit + "）",
      "遠銀同期變化（" + yoyUnit + "）", "市場同期變化（" + yoyUnit + "）", gapLabel,
      "去年同期遠銀數值（" + valUnit + "）", "去年同期市場數值（" + valUnit + "）",
      "遠銀市占率（%）", "去年同期遠銀市占率（%）", "遠銀銀行排名（30家）"];
    var lines = [header.join(",")];
    var supportsShare = metricSupportsShare(metric);
    periods.forEach(function (p) {
      var fe = findFarEastern(p), mkt = findMarket(p);
      var feV = metricView(metric, fe, pType), mktV = metricView(metric, mkt, pType);
      var prevFeV = metricView(metric, findFarEastern(prevYearPeriod(p)), pType);
      var prevMktV = metricView(metric, findMarket(prevYearPeriod(p)), pType);
      var gap = metricRelativeGap(metric, feV, mktV);
      function num(x) { var n = displayNumber(metric, x); return isFiniteNumber(n) ? n : ""; }
      function fx(n) { return isFiniteNumber(n) ? n.toFixed(2) : ""; }
      var yr = parseInt(p.slice(0, 4), 10) - 1911, mo = parseInt(p.slice(5, 7), 10);
      lines.push([
        p, yr + "年" + mo + "月", csvCell(metric.label), basisTag,
        num(feV), num(mktV), fx(feV.yoy), fx(mktV.yoy), fx(gap),
        num(prevFeV), num(prevMktV),
        supportsShare && isFiniteNumber(feV.share) ? fx(feV.share) : "",
        supportsShare && isFiniteNumber(prevFeV.share) ? fx(prevFeV.share) : "",
        isFiniteNumber(feV.bankRank) ? feV.bankRank : "",
      ].join(","));
    });
    downloadCsv("信用卡市場與同業分析_趨勢資料_" + metric.label + "_" + basisTag + "_" + periods[0] + "至" + periods[periods.length - 1] + ".csv", lines);
  }

  /** CSV 欄位跳脫：含逗號、引號或換行時以雙引號包覆。 */
  function csvCell(text) {
    var s = String(text == null ? "" : text);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function updateExportButtonLabel() {
    var btn = document.getElementById("export-btn");
    if (!btn) return;
    // 自訂比較頁籤已有專屬的「下載數據 CSV」／「下載圖片 PNG」按鈕，全域匯出按鈕在此隱藏，避免出現做不了事的重複入口。
    btn.hidden = state.activeTab === "custom";
    if (btn.hidden) return;
    var labels = {
      overview: "⭳ 匯出市場總覽（CSV）",
      trends: "⭳ 匯出趨勢資料（CSV）",
      peers: "⭳ 匯出同業比較（CSV）",
    };
    btn.textContent = labels[state.activeTab] || "⭳ 匯出（CSV）";
  }

  function handleExportClick() {
    if (state.activeTab === "overview") exportOverviewCsv();
    else if (state.activeTab === "trends") exportTrendCsv();
    else if (state.activeTab === "peers") exportPeersCsv();
  }

  // ==================================================================
  // 十二、頁籤切換、sticky 操作列、全域控制項
  // ==================================================================

  var TABS = [
    { id: "overview", label: "市場總覽" },
    { id: "trends", label: "趨勢分析" },
    { id: "peers", label: "同業比較" },
    { id: "custom", label: "自訂比較" },
  ];

  function renderTabsNav() {
    var nav = document.getElementById("main-tabs");
    if (!nav) return;
    nav.innerHTML = "";
    TABS.forEach(function (t) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "main-tab" + (state.activeTab === t.id ? " is-active" : "");
      btn.textContent = t.label;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", state.activeTab === t.id ? "true" : "false");
      btn.addEventListener("click", function () { switchTab(t.id); });
      nav.appendChild(btn);
    });
  }

  function switchTab(tabId) {
    state.activeTab = tabId;
    TABS.forEach(function (t) {
      var panel = document.getElementById("tab-" + t.id);
      if (panel) panel.hidden = t.id !== tabId;
    });
    renderTabsNav();
    renderStickyBar();
    if (tabId === "trends") renderTrendsTab(state.selectedPeriod);
    if (tabId === "overview") { renderManagementSummary(state.selectedPeriod); renderAllMetricsOverview(state.selectedPeriod); }
    if (tabId === "custom") renderCustomTab();
  }

  /**
   * 首頁（本月總覽）為「全指標主管總覽」，不受全域指標／數據方式／期間選單影響，
   * 只受資料月份控制，因此進入首頁時 sticky 操作列只保留月份徽章，
   * 其餘控制項（指標、數據方式、期間）一律隱藏，避免使用者誤以為這些控制項
   * 會影響首頁內容（舊版正是因此造成狀態混亂）。
   */
  function renderStickyBar() {
    var isOverview = state.activeTab === "overview";
    var isCustom = state.activeTab === "custom";

    var overviewHint = document.getElementById("sticky-overview-hint");
    var metricField = document.getElementById("sticky-metric-field");
    var rangeGroup = document.getElementById("sticky-range-group");
    var customPanel = document.getElementById("custom-range-panel");

    if (overviewHint) overviewHint.hidden = !isOverview;
    if (metricField) metricField.hidden = isOverview || isCustom;
    if (rangeGroup) rangeGroup.hidden = isOverview || isCustom || state.activeTab === "peers";
    if (customPanel && (isOverview || state.activeTab === "peers")) customPanel.hidden = true;

    var metric = METRIC_CATALOG[state.activeMetricId];
    var compareLabel = document.getElementById("sticky-compare-label");
    var periodTypeToggle = document.getElementById("sticky-period-type-toggle");
    if (isOverview || isCustom) {
      if (compareLabel) compareLabel.hidden = true;
      if (periodTypeToggle) periodTypeToggle.hidden = true;
    } else if (metricSupportsPeriodType(metric)) {
      if (compareLabel) compareLabel.hidden = true;
      if (periodTypeToggle) {
        periodTypeToggle.hidden = false;
        periodTypeToggle.querySelectorAll(".period-type-btn").forEach(function (b) {
          b.classList.toggle("is-active", b.getAttribute("data-period-type") === state.periodType);
        });
      }
    } else {
      if (periodTypeToggle) periodTypeToggle.hidden = true;
      if (compareLabel) { compareLabel.hidden = false; compareLabel.textContent = compareModeLabel(metric); }
    }

    var customPeriodEl = document.getElementById("sticky-custom-period");
    if (customPeriodEl) {
      var showCustom = state.activeTab === "trends" && state.trendRange === "custom" && state.customStart && state.customEnd;
      customPeriodEl.hidden = !showCustom;
      if (showCustom) {
        customPeriodEl.textContent = "自訂期間｜" + customRangeCaption(state.customStart, state.customEnd);
      }
    }

    var stickyBar = document.getElementById("sticky-bar");
    var toggleEl = document.getElementById("sticky-toggle");
    if (toggleEl) {
      var mktNow = findMarket(state.selectedPeriod);
      var tmetric = METRIC_CATALOG[state.activeMetricId];
      var openNow = stickyBar && stickyBar.classList.contains("is-open");
      toggleEl.textContent = (openNow ? "收合操作列 ▴" : "操作列：") + (openNow ? "" : (mktNow ? periodShortLabel(mktNow) : "—") + "｜" + tmetric.label +
        (metricSupportsPeriodType(tmetric) ? "｜" + (state.periodType === "ytd" ? "年初至今（YTD）" : "單月") : "") + " ▾");
    }
    if (stickyBar) document.documentElement.style.setProperty("--sticky-h", stickyBar.offsetHeight + "px");

    updateExportButtonLabel();
  }

  function populateMetricSelects() {
    var selects = document.querySelectorAll(".metric-select");
    selects.forEach(function (sel) {
      sel.innerHTML = "";
      var optgroups = {};
      CATEGORIES.forEach(function (cat) {
        var og = document.createElement("optgroup");
        og.label = cat.label;
        optgroups[cat.id] = og;
        sel.appendChild(og);
      });
      METRIC_ORDER.forEach(function (id) {
        var metric = METRIC_CATALOG[id];
        var opt = document.createElement("option");
        opt.value = id;
        opt.textContent = metric.label + (metric.kind === "unavailable" ? "（未提供）" : "");
        if (metric.kind === "unavailable") opt.disabled = true;
        optgroups[metric.category].appendChild(opt);
      });
      sel.value = state.activeMetricId;
      sel.addEventListener("change", function () {
        state.activeMetricId = sel.value;
        var m = METRIC_CATALOG[sel.value];
        document.querySelectorAll(".metric-select").forEach(function (other) { other.value = sel.value; });
        renderStickyBar();
        renderAllTabs();
      });
    });
  }

  function populateCustomRangeSelects() {
    ["custom-start", "custom-end"].forEach(function (id) {
      var sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = "";
      state.periods.forEach(function (p) {
        var opt = document.createElement("option");
        opt.value = p;
        opt.textContent = periodShortLabel(findMarket(p));
        sel.appendChild(opt);
      });
    });
    var startSel = document.getElementById("custom-start");
    var endSel = document.getElementById("custom-end");
    if (startSel) startSel.value = state.periods[Math.max(0, state.periods.length - 6)];
    if (endSel) endSel.value = state.periods[state.periods.length - 1];
  }

  function bindPeriodTypeToggle() {
    var wrap = document.getElementById("sticky-period-type-toggle");
    if (!wrap) return;
    wrap.querySelectorAll(".period-type-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.periodType = btn.getAttribute("data-period-type");
        renderStickyBar();
        renderAllTabs();
      });
    });
  }

  function bindRangeSwitch() {
    var customPanel = document.getElementById("custom-range-panel");
    document.querySelectorAll("#sticky-range-group .range-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("#sticky-range-group .range-btn").forEach(function (b) { b.classList.remove("is-active"); });
        btn.classList.add("is-active");
        var range = btn.getAttribute("data-range");
        state.trendRange = range;
        if (customPanel) customPanel.hidden = range !== "custom";
        if (range !== "custom") renderAllTabs();
      });
    });
    var applyBtn = document.getElementById("custom-range-apply");
    var resetBtn = document.getElementById("custom-range-reset");
    if (applyBtn) applyBtn.addEventListener("click", function () {
      var startSel = document.getElementById("custom-start");
      var endSel = document.getElementById("custom-end");
      var start = startSel.value, end = endSel.value;
      var warnEl = document.getElementById("custom-range-warning");
      if (start > end) {
        if (warnEl) { warnEl.hidden = false; warnEl.textContent = "開始月份不得晚於結束月份。"; }
        return;
      }
      if (warnEl) warnEl.hidden = true;
      state.customStart = start;
      state.customEnd = end;
      renderStickyBar();
      renderAllTabs();
    });
    if (resetBtn) resetBtn.addEventListener("click", function () {
      state.trendRange = "6";
      document.querySelectorAll("#sticky-range-group .range-btn").forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-range") === "6");
      });
      if (customPanel) customPanel.hidden = true;
      renderStickyBar();
      renderAllTabs();
    });
  }

  function populatePeriodSelect() {
    var select = document.getElementById("period-select");
    select.innerHTML = "";
    state.periods.forEach(function (p) {
      var m = findMarket(p);
      var opt = document.createElement("option");
      opt.value = p;
      opt.textContent = periodLabel(m);
      if (p === state.selectedPeriod) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", function () {
      state.selectedPeriod = select.value;
      renderStickyBar();
      renderAllTabs();
    });
  }

  function renderMeta(period) {
    var m = findMarket(period);
    var metaPeriod = document.getElementById("meta-period");
    if (metaPeriod) metaPeriod.textContent = "資料期間：" + periodLabel(m);
    var metaSource = document.getElementById("meta-source");
    if (metaSource) metaSource.textContent = "來源檔案：" + (m ? m.source_file : "—");
    var metaLoaded = document.getElementById("meta-loaded");
    if (metaLoaded) {
      var now = new Date();
      metaLoaded.textContent = "頁面資料讀取時間：" + now.toLocaleString("zh-TW", { hour12: false });
    }
  }

  function renderAllTabs() {
    var period = state.selectedPeriod;
    renderMeta(period);
    renderManagementSummary(period);
    renderAllMetricsOverview(period);
    renderTrendsTab(period);
    renderPeersTab(period);
    if (state.activeTab === "custom") renderCustomTab();
  }

  // ==================================================================
  // 十二之二、自訂比較頁籤：銀行整體概況、多銀行指標比較（製圖與下載皆於瀏覽器內完成）
  // ==================================================================

  var CUSTOM_METRIC_IDS = ["cards_in_force", "active_cards", "effective_card_rate_pct", "cards_issued",
    "purchase_amount", "purchase_plus_cash_amount", "per_card_spending", "total_assets"];
  var CMP_MAX = 12;
  var CMP_MARKET_TOTAL = "__MARKET_TOTAL__"; // 非真實機構名稱，代表「整體市場（總計）」；不占銀行名額，不參與排名。
  var CMP_MARKET_COLOR = "#6f8196";
  var CMP_FE_COLOR = "#e07b1a";
  var CMP_PALETTE = ["#1f5aa6", "#7b3fa0", "#2a9d8f", "#8c564b", "#c9a227", "#17becf", "#3b3b98", "#9e2a7b", "#4d7c0f", "#e377c2", "#5b5b5b"];
  var CMP_DEFAULT_BANKS = [FAR_EASTERN_NAME, "元大商業銀行", "兆豐國際商業銀行"];

  var customState = {
    mode: "bank",
    bank: { name: FAR_EASTERN_NAME, range: "12", customStart: null, customEnd: null, basis: "ytd" },
    cmp: { draft: null, applied: null, hidden: {} },
  };

  function findIssuer(period, name) {
    for (var i = 0; i < state.issuerData.length; i++) {
      var r = state.issuerData[i];
      if (r.period === period && r.issuer_name === name) return r;
    }
    return null;
  }

  /** 銀行清單（30家）：遠銀置頂，其餘依所選月份流通卡數銀行排名排列；非銀行發卡機構不納入。 */
  function customBankList(period) {
    var rows = issuersInPeriod(period).filter(function (r) { return r.issuer_type === "bank"; });
    rows.sort(function (a, b) {
      if (a.issuer_name === FAR_EASTERN_NAME) return -1;
      if (b.issuer_name === FAR_EASTERN_NAME) return 1;
      var ra = isFiniteNumber(a.cards_in_force_bank_rank) ? a.cards_in_force_bank_rank : 999;
      var rb = isFiniteNumber(b.cards_in_force_bank_rank) ? b.cards_in_force_bank_rank : 999;
      return (ra - rb) || (a.issuer_name < b.issuer_name ? -1 : 1);
    });
    return rows.map(function (r) { return r.issuer_name; });
  }

  /** 標題用銀行名稱：正式名稱去除「商業」（例：元大商業銀行→元大銀行）。 */
  function bankTitleName(name) { return name.replace("商業銀行", "銀行"); }

  function bankColor(name) {
    if (name === CMP_MARKET_TOTAL) return CMP_MARKET_COLOR;
    if (name === FAR_EASTERN_NAME) return CMP_FE_COLOR;
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return CMP_PALETTE[h % CMP_PALETTE.length];
  }

  /** 數值單位：金額為億元、卡數為萬張、比率為%、每卡金額為元／張。 */
  function customUnit(metric) {
    if (metric.fmtRaw === fmt100m) return { unit: "億元", dec: 2 };
    if (metric.fmtRaw === fmtYuanPerCard) return { unit: "元/張", dec: 0 };
    if (metric.fmtRaw === fmtPlainPct) return { unit: "%", dec: 2 };
    return { unit: "萬張", dec: 2 };
  }

  /** 顯示單位之數值（原始精度，不四捨五入）；缺值回傳 null，不視為 0。 */
  function customValue(metric, view) {
    var n = displayNumber(metric, view);
    if (!isFiniteNumber(n)) return null;
    return metric.fmtRaw === fmt100m || metric.fmtRaw === fmtYuanPerCard || metric.fmtRaw === fmtPlainPct ? n : n / 10000;
  }

  function customFmt(metric, v) {
    if (!isFiniteNumber(v)) return "—";
    var u = customUnit(metric);
    return v.toLocaleString("zh-TW", { minimumFractionDigits: u.dec, maximumFractionDigits: u.dec }) + (u.unit === "%" ? "" : " ") + u.unit;
  }

  /** 同期變化文字：比率型為「較去年同期 ±X pp」，其餘為「YOY ±X%」。 */
  function customChangeText(metric, view) {
    if (!isFiniteNumber(view.yoy)) return "缺同期資料";
    return metric.kind === "ratio" ? "較去年同期 " + signedPp(view.yoy) : "YOY " + signedPct(view.yoy);
  }

  function customPType(metric, basis) { return metricSupportsPeriodType(metric) ? basis : "month"; }

  function customBasisTag(metric, basis) {
    if (metricSupportsPeriodType(metric)) return basis === "ytd" ? "年初至今累計" : "單月";
    return metric.kind === "ratio" ? "當月值" : "月底值";
  }

  function customBasisFile(metric, basis) {
    if (metricSupportsPeriodType(metric)) return basis === "ytd" ? "YTD" : "單月";
    return metric.kind === "ratio" ? "當月值" : "月底值";
  }

  function rocShort(p) { return rocYearMonthShort(p); }

  function customRangeCaptionFor(periods) {
    if (!periods.length) return "—";
    return rocShort(periods[0]) + "－" + rocShort(periods[periods.length - 1]);
  }

  function fillPeriodOptions(sel, selected) {
    if (!sel) return;
    sel.innerHTML = "";
    state.periods.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p;
      opt.textContent = periodLabel(findMarket(p));
      if (p === selected) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function fillRangeOptions(sel, selected) {
    if (!sel) return;
    sel.innerHTML = "";
    state.periods.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p;
      opt.textContent = rocShort(p);
      if (p === selected) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  // ------------------------------------------------------------------
  // 銀行整體概況
  // ------------------------------------------------------------------

  /** 分析期間（共用）：近6／近12個月以選定資料月份為截止；自訂期間未設定時預設為最早可用月至選定月份。 */
  function resolveRange(period, range, cs, ce) {
    if (range === "custom") {
      cs = cs || state.periods[0];
      ce = ce || period;
      if (cs > ce) { var t = cs; cs = ce; ce = t; }
      return periodsForRange(period, "custom", cs, ce);
    }
    return periodsForRange(period, range, null, null);
  }

  /** 分析期間說明文字：實際期間與月份數；資料不足時說明實際可用期間；截止月與資料月份不同時分別說明。 */
  function rangeNoteText(period, range, cs, ce) {
    var periods = resolveRange(period, range, cs, ce);
    if (!periods.length) return "分析期間：無可用資料";
    var n = periods.length;
    var parts = ["分析期間：" + rocShort(periods[0]) + "－" + rocShort(periods[n - 1]) + "（共" + n + "個月）"];
    var req = parseInt(range, 10);
    if (isFiniteNumber(req) && n < req) parts.push("資料僅有 " + n + " 個月，已顯示可用期間");
    if (periods[n - 1] !== period) {
      parts.push("資料月份 " + periodShortLabel(findMarket(period)) + " 用於本期數值與排名；分析期間用於趨勢圖");
    }
    return parts.join("。");
  }

  function setCustomMsg(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text || "";
  }

  function bankPeriods() {
    var cfg = customState.bank;
    return resolveRange(state.selectedPeriod, cfg.range, cfg.customStart, cfg.customEnd);
  }

  function renderBankOverview() {
    var titleEl = document.getElementById("bank-title");
    var metaEl = document.getElementById("bank-meta");
    var cardsEl = document.getElementById("bank-cards");
    if (!titleEl || !cardsEl) return;
    var period = state.selectedPeriod;
    var cfg = customState.bank;
    var periods = bankPeriods();
    var mkt = findMarket(period);
    titleEl.textContent = bankTitleName(cfg.name) + "｜信用卡業務概況";
    if (metaEl) metaEl.textContent = "資料月份：" + (mkt ? "民國" + periodShortLabel(mkt) : "—") +
      "｜趨勢期間：" + customRangeCaptionFor(periods);
    var rec = findIssuer(period, cfg.name);
    cardsEl.innerHTML = "";
    if (!rec) {
      cardsEl.innerHTML = '<p class="scope-note">此銀行於所選月份無資料。</p>';
      return;
    }
    var bankShort = bankShortName(cfg.name);
    CUSTOM_METRIC_IDS.forEach(function (id) {
      var metric = METRIC_CATALOG[id];
      if (!metric || metric.kind === "unavailable") return;
      var pType = customPType(metric, cfg.basis);
      var view = metricView(metric, rec, pType);
      var now = customValue(metric, view);
      var values = periods.map(function (p) { return customValue(metric, metricView(metric, findIssuer(p, cfg.name), pType)); });
      var rank = isFiniteNumber(view.bankRank) ? "第" + fmtRank(view.bankRank) + "名" : "無排名資料";
      var delta = isFiniteNumber(view.yoy) ? deltaClass(Number(view.yoy.toFixed(2))) : "delta-na";

      var card = document.createElement("article");
      card.className = "bank-card";
      card.setAttribute("data-metric", id);
      card.innerHTML =
        '<div class="bank-card-head">' +
          '<h3 class="bank-card-name">' + escapeHtml(metric.label) + '</h3>' +
          '<span class="basis-tag">' + escapeHtml(customBasisTag(metric, cfg.basis)) + '</span>' +
          '<button type="button" class="png-btn" data-card-png="' + id + '">下載 PNG</button>' +
        '</div>' +
        '<div class="bank-card-body">' +
          '<div class="bank-card-stats">' +
            '<div class="bank-card-value">' + escapeHtml(customFmt(metric, now)) + '</div>' +
            '<div class="bank-card-change ' + delta + '">' + escapeHtml(customChangeText(metric, view)) + '</div>' +
            '<div class="bank-card-rank"><span class="rank-label">銀行排名</span><span class="rank-value">' + escapeHtml(rank) + '</span></div>' +
          '</div>' +
          '<div class="bank-card-chart"></div>' +
        '</div>';
      cardsEl.appendChild(card);
      var holder = card.querySelector(".bank-card-chart");
      buildLineChart(holder, periods, [{
        label: bankShort, color: bankColor(cfg.name), values: values,
        fmt: function (v) { return customFmt(metric, v); },
      }], {
        height: 190, showLegend: false, endLabel: true, breakAtNewYear: pType === "ytd",
        unit: customUnit(metric).unit, ariaLabel: bankShort + metric.label + "趨勢",
      });
    });
  }

  function bankCsvRows() {
    var cfg = customState.bank;
    var period = state.selectedPeriod;
    var periods = bankPeriods();
    var header = ["月份（西元）", "月份（民國）", "銀行", "指標", "數據方式", "單位", "本期值", "去年同期值", "同期變化", "同期變化單位", "銀行排名（30家）"];
    var lines = [header.join(",")];
    periods.forEach(function (p) {
      var rec = findIssuer(p, cfg.name);
      var prevRec = findIssuer(prevYearPeriod(p), cfg.name);
      CUSTOM_METRIC_IDS.forEach(function (id) {
        var metric = METRIC_CATALOG[id];
        if (!metric || metric.kind === "unavailable") return;
        var pType = customPType(metric, cfg.basis);
        var view = metricView(metric, rec, pType);
        var prevView = metricView(metric, prevRec, pType);
        var isRatio = metric.kind === "ratio";
        var nowV = customValue(metric, view), prevV = customValue(metric, prevView);
        lines.push([
          p, (parseInt(p.slice(0, 4), 10) - 1911) + "年" + parseInt(p.slice(5, 7), 10) + "月",
          csvCell(cfg.name), csvCell(metric.label), customBasisFile(metric, cfg.basis), customUnit(metric).unit,
          isFiniteNumber(nowV) ? nowV : "", isFiniteNumber(prevV) ? prevV : "",
          isFiniteNumber(view.yoy) ? view.yoy.toFixed(2) : "", isRatio ? "pp" : "%",
          isFiniteNumber(view.bankRank) ? view.bankRank : "",
        ].join(","));
      });
    });
    return { lines: lines, periods: periods, period: period };
  }

  function exportBankCsv() {
    var res = bankCsvRows();
    var cfg = customState.bank;
    if (!res.periods.length) return;
    downloadCsv("信用卡市場與同業分析_銀行概況_" + bankTitleName(cfg.name) + "_" + res.periods[0] + "至" +
      res.periods[res.periods.length - 1] + "_" + (cfg.basis === "ytd" ? "流量指標YTD" : "流量指標單月") + ".csv", res.lines);
  }

  // ------------------------------------------------------------------
  // 圖片輸出（SVG 內嵌樣式後繪入 Canvas；不依賴伺服器）
  // ------------------------------------------------------------------

  var INLINE_STYLE_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "stroke-linecap",
    "stroke-linejoin", "opacity", "font-size", "font-weight", "font-family", "text-anchor", "visibility", "paint-order"];

  function svgDataUrl(svg, cb) {
    var clone = svg.cloneNode(true);
    var origEls = svg.querySelectorAll("*"), cloneEls = clone.querySelectorAll("*");
    for (var i = 0; i < origEls.length && i < cloneEls.length; i++) {
      var cs = getComputedStyle(origEls[i]);
      var st = "";
      INLINE_STYLE_PROPS.forEach(function (p) { st += p + ":" + cs.getPropertyValue(p) + ";"; });
      cloneEls[i].setAttribute("style", st);
    }
    var rect = svg.getBoundingClientRect();
    var w = Math.round(rect.width) || 800, h = Math.round(rect.height) || 300;
    clone.setAttribute("xmlns", SVGNS);
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    var xml = new XMLSerializer().serializeToString(clone);
    var rootStyle = getComputedStyle(document.documentElement);
    xml = xml.replace(/var\((--[\w-]+)\)/g, function (m, name) { return rootStyle.getPropertyValue(name).trim() || "#000000"; });
    var img = new Image();
    img.onload = function () { cb(img, w, h); };
    img.onerror = function () { cb(null, w, h); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  }

  function downloadCanvasPng(canvas, filename) {
    canvas.toBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }, "image/png");
  }

  /** 將圖表 SVG 與文字說明繪於 Canvas 上（16:9 簡報版型）。圖例自動換行，頁尾保留空間，圖表不與文字重疊。 */
  function composeCanvas(svgEl, opts, cb) {
    svgDataUrl(svgEl, function (img, sw, sh) {
      var canvas = document.createElement("canvas");
      canvas.width = opts.w; canvas.height = opts.h;
      var ctx = canvas.getContext("2d");
      var left = 60, right = canvas.width - 60;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 標題：過長時自動縮小字級
      var tsz = opts.titleSize;
      ctx.font = "bold " + tsz + "px sans-serif";
      while (ctx.measureText(opts.title).width > right - left && tsz > 18) { tsz -= 2; ctx.font = "bold " + tsz + "px sans-serif"; }
      ctx.fillStyle = "#10304f";
      var y = 60;
      ctx.fillText(opts.title, left, y);

      // 副標題（期間、數據方式、單位）
      ctx.fillStyle = "#52545c"; ctx.font = opts.subSize + "px sans-serif";
      opts.subtitleLines.forEach(function (line) { y += opts.subSize + 12; ctx.fillText(line, left, y); });
      y += 22;

      // 圖例：超出寬度時換行
      if (opts.legend && opts.legend.length) {
        var lx = left;
        opts.legend.forEach(function (lg) {
          ctx.font = "22px sans-serif";
          var itemW = 42 + ctx.measureText(lg.label).width + 34;
          if (lx + itemW > right && lx > left) { lx = left; y += 36; }
          ctx.strokeStyle = lg.color; ctx.lineWidth = 4;
          ctx.setLineDash(lg.dashed ? [10, 6] : []);
          ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(lx + 34, y); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#0b0b0b";
          ctx.fillText(lg.label, lx + 42, y + 8);
          lx += itemW;
        });
        y += 30;
      }

      // 頁尾（資料來源與說明）保留於圖表區下方
      var footerH = opts.footer.length * 28 + 24;
      var areaTop = y + 20, areaBottom = canvas.height - footerH - 20;
      var areaH = areaBottom - areaTop, areaW = right - left;
      if (img && sw && sh && areaH > 40) {
        var scale = Math.min(areaW / sw, areaH / sh);
        var dw = sw * scale, dh = sh * scale;
        ctx.drawImage(img, left + (areaW - dw) / 2, areaTop + (areaH - dh) / 2, dw, dh);
      }
      ctx.fillStyle = "#52545c"; ctx.font = "20px sans-serif";
      opts.footer.forEach(function (line, i) { ctx.fillText(line, left, canvas.height - footerH + 20 + i * 28); });
      cb(canvas);
    });
  }

  function exportBankCardPng(metricId) {
    var card = document.querySelector('#bank-cards .bank-card[data-metric="' + metricId + '"]');
    if (!card) return;
    var svg = card.querySelector("svg.linechart-svg");
    var metric = METRIC_CATALOG[metricId];
    var cfg = customState.bank;
    var periods = bankPeriods();
    var mkt = findMarket(state.selectedPeriod);
    var title = bankTitleName(cfg.name) + "｜" + metric.label;
    var sub = [
      "資料月份：民國" + (mkt ? periodShortLabel(mkt) : "—") + "｜趨勢期間：" + customRangeCaptionFor(periods),
      "數據方式：" + customBasisTag(metric, cfg.basis) + "｜單位：" + customUnit(metric).unit,
    ];
    var footer = ["資料來源：金管會銀行局信用卡業務統計附表五（processed 標準資料）"];
    composeCanvas(svg, { w: 1200, h: 620, title: title, titleSize: 30, subSize: 19, subtitleLines: sub, footer: footer }, function (canvas) {
      downloadCanvasPng(canvas, "信用卡市場與同業分析_銀行概況_" + bankTitleName(cfg.name) + "_" + metric.label + "_" +
        customBasisFile(metric, cfg.basis) + "_" + state.selectedPeriod + ".png");
    });
  }

  // ------------------------------------------------------------------
  // 多銀行指標比較
  // ------------------------------------------------------------------

  /** 比較對象的資料來源：整體市場（總計）取市場合計紀錄（沿用既有 findMarket 與市場計算，不另建公式）；其餘為發卡機構。 */
  function cmpRecordFor(period, name) {
    return name === CMP_MARKET_TOTAL ? findMarket(period) : findIssuer(period, name);
  }

  function cmpDefaultDraft() {
    var period = state.selectedPeriod;
    var banks = CMP_DEFAULT_BANKS.filter(function (n) { return !!findIssuer(period, n); });
    return {
      metric: "purchase_amount", analysis: "trend", display: "value", basis: customState.bank.basis,
      period: period, range: "6", cs: null, ce: null, banks: banks, marketTotal: false, title: "",
    };
  }

  function cmpSnapshot(d) {
    return JSON.stringify({ metric: d.metric, analysis: d.analysis, display: d.display, basis: d.basis, period: d.period,
      range: d.range, cs: d.cs, ce: d.ce, banks: d.banks, marketTotal: !!d.marketTotal });
  }

  function cmpPeriods(d) { return resolveRange(d.period, d.range, d.cs, d.ce); }

  function cmpIsDirty() {
    var c = customState.cmp;
    return !c.applied || cmpSnapshot(c.draft) !== cmpSnapshot(c.applied);
  }

  function cmpUnitLabel(metric, display) {
    if (display === "yoy") return metric.kind === "ratio" ? "pp" : "%";
    return customUnit(metric).unit;
  }

  /** 依控制項產生預設標題（使用者可於標題欄修改）。 */
  function cmpDefaultTitle(d) {
    var metric = METRIC_CATALOG[d.metric];
    var names = d.banks.map(bankShortName).concat(d.marketTotal ? ["整體市場（總計）"] : []).join("、");
    var what = d.display === "yoy" ? (metric.kind === "ratio" ? "較去年同期變化" : "同期變化") : "";
    return (names || "未選比較對象") + "｜" + metric.label + what;
  }

  /** 依畫面數據取得一列（銀行）之值與同期變化。 */
  function cmpPointValue(d, name, period) {
    var metric = METRIC_CATALOG[d.metric];
    var pType = customPType(metric, d.basis);
    var view = metricView(metric, cmpRecordFor(period, name), pType);
    if (d.display === "yoy") return isFiniteNumber(view.yoy) ? view.yoy : null;
    return customValue(metric, view);
  }

  function cmpRankFor(d, name, period) {
    if (name === CMP_MARKET_TOTAL) return null; // 整體市場（總計）不參與銀行排名。
    var metric = METRIC_CATALOG[d.metric];
    var view = metricView(metric, cmpRecordFor(period, name), customPType(metric, d.basis));
    return isFiniteNumber(view.bankRank) ? view.bankRank : null;
  }

  /** 排名欄名稱：沿用指標既有本期值排名（30家銀行），依數據方式標示，避免被誤認為 YOY 排名。 */
  function cmpRankHeaderLabel(metric, basis) {
    var short = METRIC_SHORT_NAMES[metric.id] || metric.label;
    var prefix = metricSupportsPeriodType(metric) ? (basis === "ytd" ? "YTD" : "單月") : "";
    return prefix + short + "排名（30家）";
  }

  function cmpCsvFileTag(d) {
    var metric = METRIC_CATALOG[d.metric];
    return metric.label + "_" + cmpUnitLabel(metric, d.display) + "_" + customBasisFile(metric, d.basis);
  }

  // --- 控制項同步 ---

  function renderCmpControls() {
    var c = customState.cmp, d = c.draft;
    if (!d) return;
    var metric = METRIC_CATALOG[d.metric];
    var dirty = cmpIsDirty();
    var setText = function (id, t) { var el = document.getElementById(id); if (el) el.textContent = t; };
    var setPressed = function (sel, attr, val) {
      document.querySelectorAll(sel).forEach(function (b) {
        var on = b.getAttribute(attr) === String(val);
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    };
    setPressed("[data-cmp-analysis]", "data-cmp-analysis", d.analysis);
    setPressed("[data-cmp-display]", "data-cmp-display", d.display);
    setPressed("[data-cmp-basis]", "data-cmp-basis", d.basis);
    setPressed("[data-cmp-range]", "data-cmp-range", d.range);
    var metricSel = document.getElementById("cmp-metric");
    if (metricSel) metricSel.value = d.metric;
    var isTrend = d.analysis === "trend";
    var rangeWrap = document.getElementById("cmp-range-wrap");
    var monthWrap = document.getElementById("cmp-month-wrap");
    var customWrap = document.getElementById("cmp-custom-wrap");
    if (rangeWrap) rangeWrap.hidden = !isTrend;
    if (monthWrap) monthWrap.hidden = isTrend;
    setText("cmp-month-note", "民國" + (findMarket(d.period) ? periodShortLabel(findMarket(d.period)) : "—") + "（請於上方操作列選擇資料月份）");
    setText("cmp-range-note", isTrend ? rangeNoteText(d.period, d.range, d.cs, d.ce) : "");
    if (customWrap) customWrap.hidden = !(isTrend && d.range === "custom");
    var basisWrap = document.getElementById("cmp-basis-wrap");
    if (basisWrap) basisWrap.hidden = !metricSupportsPeriodType(metric);
    var dispWrap = document.getElementById("cmp-display-wrap");
    if (dispWrap) dispWrap.hidden = false;
    setText("cmp-ref-note", "參考月份：民國" + (findMarket(d.period) ? periodShortLabel(findMarket(d.period)) : "—") +
      "（流通卡前12大依此月份月底流通卡數選取）");

    // 已選銀行 chips 與清單勾選
    var n = d.banks.length;
    setText("cmp-count", "已選 " + n + "／" + CMP_MAX + " 家銀行" + (d.marketTotal ? "；已加入整體市場（總計）" : ""));
    var marketCb = document.getElementById("cmp-market-total");
    if (marketCb) marketCb.checked = !!d.marketTotal;
    var chips = document.getElementById("cmp-chips");
    if (chips) {
      chips.innerHTML = "";
      d.banks.forEach(function (name) {
        var b = document.createElement("span");
        b.className = "cmp-chip";
        b.innerHTML = '<span class="cmp-chip-swatch" style="background:' + bankColor(name) + '"></span>' + escapeHtml(bankShortName(name)) +
          ' <button type="button" class="cmp-chip-remove" data-cmp-remove="' + escapeHtml(name) + '" aria-label="移除' + escapeHtml(bankShortName(name)) + '">×</button>';
        chips.appendChild(b);
      });
      if (!n) chips.innerHTML = '<span class="scope-note">尚未選擇銀行。</span>';
    }
    var list = document.getElementById("cmp-list");
    if (list) {
      var q = (document.getElementById("cmp-search") || { value: "" }).value.trim();
      var names = customBankList(d.period);
      list.innerHTML = "";
      names.forEach(function (name) {
        if (q && name.indexOf(q) < 0 && bankShortName(name).indexOf(q) < 0) return;
        var checked = d.banks.indexOf(name) >= 0;
        var row = document.createElement("label");
        row.className = "cmp-list-row" + (name === FAR_EASTERN_NAME ? " is-far-eastern" : "");
        row.innerHTML = '<input type="checkbox" data-cmp-bank="' + escapeHtml(name) + '"' + (checked ? " checked" : "") + '>' +
          '<span class="cmp-list-name">' + escapeHtml(bankShortName(name)) + '</span>' +
          (name === FAR_EASTERN_NAME ? '<span class="tag-self">本行</span>' : "");
        list.appendChild(row);
      });
    }
    var warn = document.getElementById("cmp-limit-msg");
    if (warn) { warn.hidden = true; warn.textContent = ""; }

    var empty = n === 0 && !d.marketTotal;
    var empties = document.getElementById("cmp-empty");
    if (empties) empties.hidden = !empty;
    var upd = document.getElementById("cmp-update");
    if (upd) upd.disabled = empty;
    var dn = document.getElementById("cmp-dirty");
    if (dn) dn.hidden = !dirty;
    ["cmp-png", "cmp-csv"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = empty || dirty || !c.applied;
    });
    var titleInput = document.getElementById("cmp-title-input");
    if (titleInput && document.activeElement !== titleInput && !titleInput.dataset.userEdited) titleInput.value = cmpDefaultTitle(d);
  }

  function cmpSetDraft(patch) {
    var c = customState.cmp;
    Object.keys(patch).forEach(function (k) { c.draft[k] = patch[k]; });
    if (patch.metric || patch.display || patch.analysis) {
      var ti = document.getElementById("cmp-title-input");
      if (ti) ti.dataset.userEdited = "";
    }
    renderCmpControls();
  }

  function cmpToggleMarketTotal() {
    var c = customState.cmp;
    c.draft.marketTotal = !c.draft.marketTotal;
    renderCmpControls();
  }

  function cmpAddBank(name) {
    var c = customState.cmp;
    if (c.draft.banks.indexOf(name) >= 0) return;
    if (c.draft.banks.length >= CMP_MAX) {
      var warn = document.getElementById("cmp-limit-msg");
      if (warn) { warn.textContent = "最多可選 " + CMP_MAX + " 家銀行，請先移除一家再新增。目前選取未變動。"; warn.hidden = false; }
      return;
    }
    c.draft.banks.push(name);
    renderCmpControls();
  }

  function cmpRemoveBank(name) {
    var c = customState.cmp;
    c.draft.banks = c.draft.banks.filter(function (n) { return n !== name; });
    renderCmpControls();
  }

  /** 更新圖表：將目前控制項套用為圖表條件（下載只使用已更新的圖表）。 */
  function cmpApply() {
    var c = customState.cmp;
    if (!c.draft.banks.length) return;
    var ti = document.getElementById("cmp-title-input");
    var copy = JSON.parse(cmpSnapshot(c.draft));
    copy.title = (ti && ti.value.trim()) ? ti.value.trim() : cmpDefaultTitle(c.draft);
    c.applied = copy;
    c.hidden = {};
    renderCmpChart();
    renderCmpControls();
  }

  function cmpVisibleBanks() {
    var a = customState.cmp.applied;
    if (!a) return [];
    var list = a.banks.filter(function (n) { return !customState.cmp.hidden[n]; });
    if (a.marketTotal && !customState.cmp.hidden[CMP_MARKET_TOTAL]) list = list.concat([CMP_MARKET_TOTAL]);
    return list;
  }

  /** 標籤文字裁切（含省略號）：依實際字寬裁切，避免長銀行名稱裁切時仍溢出保留區域。 */
  function truncateToWidth(text, maxW, fontPx) {
    if (textWidthEstimate(text, fontPx) <= maxW) return text;
    var t = String(text);
    while (t.length > 1 && textWidthEstimate(t + "…", fontPx) > maxW) t = t.slice(0, -1);
    return t.length ? t + "…" : text.slice(0, 1);
  }

  /** 刻度單位後綴：百分比緊接數字，其餘單位（含 pp）前留一個空格，與全站數值格式一致。 */
  function axisUnitSuffix(unit) { return unit === "%" ? unit : " " + unit; }

  /**
   * 橫向長條圖（SVG）。rows: [{name,label,value,isFe}]，value 為 null 時顯示「缺資料」。
   * 銀行名稱固定於獨立欄位；數值標籤依文字實際寬度保留邊距（正值在長條右側外、負值在左側外），
   * 不與名稱欄重疊；底部補上數值刻度與單位；0 基準線為細灰線，正負混合時以同一線性尺度呈現。
   */
  function buildHBarChart(wrapEl, rows, opts) {
    wrapEl.innerHTML = "";
    var nameFont = 15, valFont = 15, tickFont = 12;
    var valid = rows.filter(function (r) { return isFiniteNumber(r.value); });
    var width = Math.max(300, Math.floor(wrapEl.clientWidth || 720));
    var rowH = 36, padT = 26, padB = 40;
    var height = padT + rows.length * rowH + padB;
    var vals = valid.length ? valid.map(function (r) { return r.value; }) : [0];
    var dom = niceTicks(Math.min.apply(null, vals.concat([0])), Math.max.apply(null, vals.concat([0])), 4, true);

    function fmtVal(v) { return opts.signed ? (opts.isRatio ? signedPp(v) : signedPct(v)) : customFmt(opts.metric, v); }

    // 名稱欄寬度：依實際文字寬度（含遠銀「本行」標籤），上限為圖寬的 34%，避免擠壓繪圖區。
    var nameMaxW = Math.max(70, width * 0.34);
    var nameW = Math.min(nameMaxW, Math.max.apply(null, [50].concat(rows.map(function (r) {
      var w = textWidthEstimate(r.label, nameFont) + 2;
      if (r.isFe) w += 34;
      return w;
    }))));

    // 數值標籤寬度：正值與負值分開量測，各自保留獨立邊距，不共用繪圖區位置。
    var negW = Math.max.apply(null, [0].concat(valid.filter(function (r) { return r.value < 0; }).map(function (r) { return textWidthEstimate(fmtVal(r.value), valFont) + 2; })));
    var posW = Math.max.apply(null, [30].concat(valid.filter(function (r) { return r.value >= 0; }).map(function (r) { return textWidthEstimate(fmtVal(r.value), valFont) + 2; })));
    var GAP = 10, GAP2 = 8;
    var plotL = Math.ceil(nameW) + GAP + Math.ceil(negW) + (negW > 0 ? GAP2 : 0);
    var plotR = width - (Math.ceil(posW) + GAP2 + GAP);
    if (plotR - plotL < 60) { var shortfall = 60 - (plotR - plotL); plotL -= shortfall / 2; plotR += shortfall / 2; }
    var plotW = plotR - plotL;

    function xOf(v) { return plotL + (v - dom.min) / (dom.max - dom.min) * plotW; }
    var x0 = xOf(0);

    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "hbar-svg");
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.ariaLabel || "橫向長條圖");
    function el(name, attrs, text) {
      var e = document.createElementNS(SVGNS, name);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      if (text !== undefined) e.textContent = text;
      svg.appendChild(e);
      return e;
    }

    // 數值刻度與單位（含 0 線，正負混合時位置依實際比例計算，不截斷座標）。
    // 格線全部保留；標籤是否顯示依實際文字寬度判斷是否會互相重疊（與趨勢圖 X 軸同一套演算法，避免各圖各自土法煉鋼）。
    var tickTexts = dom.ticks.map(function (t) { return formatTickLabel(t, axisUnitSuffix(opts.unit || ""), dom.decimals); });
    var showTickIdx = {};
    selectNumericTickIndices(dom.ticks.length, function (i) { return tickTexts[i]; }, function (i) { return xOf(dom.ticks[i]); }, tickFont)
      .forEach(function (i) { showTickIdx[i] = true; });
    dom.ticks.forEach(function (t, ti) {
      var x = xOf(t);
      el("line", { x1: x, x2: x, y1: padT - 6, y2: height - padB, stroke: "#E7ECF2", "stroke-width": 1 });
      if (showTickIdx[ti]) el("text", { x: x, y: height - padB + 18, "font-size": tickFont, fill: "#6b7280", "text-anchor": "middle" }, tickTexts[ti]);
    });
    el("line", { x1: x0, x2: x0, y1: padT - 6, y2: height - padB, stroke: "#9AA3B0", "stroke-width": 1.2 });

    rows.forEach(function (r, i) {
      var y = padT + i * rowH;
      var cy = y + rowH / 2;
      var label = truncateToWidth(r.label, nameW - (r.isFe ? 36 : 2), nameFont);
      var nameEl = el("text", { x: 0, y: cy + 5, "font-size": nameFont, "font-weight": r.isFe ? 800 : 600, fill: "#173458" }, label);
      if (label !== r.label) { var titleEl = document.createElementNS(SVGNS, "title"); titleEl.textContent = r.label; nameEl.appendChild(titleEl); }
      if (r.isFe) {
        var bx = textWidthEstimate(label, nameFont) + 6;
        el("rect", { x: bx, y: cy - 10, width: 28, height: 16, rx: 8, fill: CMP_FE_COLOR });
        el("text", { x: bx + 14, y: cy + 3, "font-size": 11, "font-weight": 700, fill: "#ffffff", "text-anchor": "middle" }, "本行");
      }
      if (!isFiniteNumber(r.value)) {
        el("text", { x: plotL, y: cy + 5, "font-size": 14, fill: "#8a8d96" }, "缺資料");
        return;
      }
      var xv = xOf(r.value);
      var bx2 = Math.min(x0, xv), bw = Math.max(1, Math.abs(xv - x0));
      var fill = opts.signed ? (r.value > 0 ? "#c8102e" : (r.value < 0 ? "#00803c" : "#8a8d96")) : bankColor(r.name);
      el("rect", { x: bx2, y: y + 7, width: bw, height: rowH - 14, rx: 3, fill: fill, "fill-opacity": 0.92 });
      var txt = fmtVal(r.value);
      var tx = r.value >= 0 ? xv + 8 : xv - 8;
      var color = opts.signed ? (r.value > 0 ? "#c8102e" : (r.value < 0 ? "#00803c" : "#52545c")) : "#173458";
      el("text", {
        x: tx, y: cy + 5, "font-size": valFont, "font-weight": 800, fill: color,
        "text-anchor": r.value >= 0 ? "start" : "end",
      }, txt);
    });
    wrapEl.appendChild(svg);
    return svg;
  }

  function renderCmpChart() {
    var a = customState.cmp.applied;
    var wrap = document.getElementById("cmp-chart");
    var legendEl = document.getElementById("cmp-legend");
    var tableEl = document.getElementById("cmp-table-wrap");
    var titleEl = document.getElementById("cmp-title-text");
    var notesEl = document.getElementById("cmp-notes");
    if (!wrap) return;
    if (!a) {
      wrap.innerHTML = '<p class="scope-note">請設定條件後按「更新圖表」。</p>';
      if (legendEl) legendEl.innerHTML = "";
      if (tableEl) tableEl.innerHTML = "";
      return;
    }
    var metric = METRIC_CATALOG[a.metric];
    var pType = customPType(metric, a.basis);
    var unit = cmpUnitLabel(metric, a.display);
    var isRatio = metric.kind === "ratio";
    var vis = cmpVisibleBanks();
    if (titleEl) titleEl.textContent = a.title;
    var periods = cmpPeriods(a);
    if (notesEl) {
      var basisTxt = metricSupportsPeriodType(metric) ? (a.basis === "ytd" ? "年初至今累計" : "單月") : (isRatio ? "當月值" : "月底值");
      notesEl.innerHTML = "";
      [
        a.analysis === "month" ? "資料月份：民國" + periodShortLabel(findMarket(a.period)) : "分析期間：" + customRangeCaptionFor(periods),
        "數據方式：" + basisTxt + "｜單位：" + unit + "｜" + (a.display === "yoy" ? (isRatio ? "顯示：較去年同期變化（pp）" : "顯示：同期變化（YOY，%）") : "顯示：本期值"),
        "資料來源：金管會銀行局信用卡業務統計附表五",
      ].forEach(function (t) { var p = document.createElement("p"); p.textContent = t; notesEl.appendChild(p); });
    }

    // 圖例（可點選隱藏／顯示）：僅在長條／線條顏色即為銀行識別色時顯示，避免圖例與長條顏色不符
    var showBankLegend = !(a.analysis === "month" && a.display === "yoy");
    if (legendEl) {
      legendEl.innerHTML = "";
      if (!showBankLegend) {
        var key = document.createElement("p");
        key.className = "scope-note cmp-color-key";
        key.textContent = "長條顏色：紅色為較去年同期上升、綠色為下降、灰色為持平；遠銀以粗體名稱與「本行」標籤識別，不另以顏色區分銀行。";
        legendEl.appendChild(key);
      }
      a.banks.concat(a.marketTotal ? [CMP_MARKET_TOTAL] : []).forEach(function (name, idx) {
        if (!showBankLegend) return;
        var hidden = !!customState.cmp.hidden[name];
        var b = document.createElement("button");
        b.type = "button";
        b.className = "cmp-legend-btn" + (hidden ? " is-hidden" : "");
        b.setAttribute("data-cmp-legend", name);
        b.setAttribute("aria-pressed", hidden ? "false" : "true");
        b.innerHTML = '<svg width="28" height="8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" stroke="' + bankColor(name) +
          '" stroke-width="3" stroke-linecap="round"' + (a.analysis === "trend" && idx % 2 === 1 && name !== FAR_EASTERN_NAME && name !== CMP_MARKET_TOTAL ? ' stroke-dasharray="5 3"' : "") + '/></svg>' +
          escapeHtml(bankShortName(name));
        legendEl.appendChild(b);
      });
      if (vis.length > 5) {
        var note = document.createElement("span");
        note.className = "scope-note";
        note.textContent = "線條較多，可點選上方銀行名稱隱藏／顯示，或以滑鼠移至圖上查看數值。";
        legendEl.appendChild(note);
      }
    }

    wrap.innerHTML = "";
    var rows;
    if (a.analysis === "month") {
      rows = vis.map(function (name) {
        return { name: name, label: bankShortName(name), value: cmpPointValue(a, name, a.period), isFe: name === FAR_EASTERN_NAME, rank: cmpRankFor(a, name, a.period) };
      });
      rows.sort(function (x, y) {
        if (!isFiniteNumber(x.value) && !isFiniteNumber(y.value)) return 0;
        if (!isFiniteNumber(x.value)) return 1;
        if (!isFiniteNumber(y.value)) return -1;
        return y.value - x.value;
      });
      if (!rows.length) {
        wrap.innerHTML = '<p class="scope-note">目前沒有可顯示的銀行（已全部隱藏）。</p>';
      } else {
        buildHBarChart(wrap, rows, { metric: metric, unit: unit, signed: a.display === "yoy", isRatio: isRatio, ariaLabel: a.title });
      }
    } else {
      var series = vis.map(function (name) {
        var idx = a.banks.indexOf(name);
        return {
          label: bankShortName(name), color: bankColor(name),
          dashed: idx % 2 === 1 && name !== FAR_EASTERN_NAME,
          values: periods.map(function (p) { return cmpPointValue(a, name, p); }),
          fmt: function (v) { return a.display === "yoy" ? (isRatio ? signedPp(v) : signedPct(v)) : customFmt(metric, v); },
        };
      });
      if (!series.length || !periods.length) {
        wrap.innerHTML = '<p class="scope-note">目前沒有可顯示的銀行（已全部隱藏）或期間資料不足。</p>';
      } else {
        buildLineChart(wrap, periods, series, {
          height: 380, showLegend: false, breakAtNewYear: pType === "ytd", zeroBaseline: a.display === "yoy",
          unit: unit, ariaLabel: a.title,
        });
      }
    }

    // 數據表（與圖表相同之資料與排序）
    if (tableEl) {
      var tRows = [];
      if (a.analysis === "month") {
        tRows = rows || [];
      } else {
        tRows = vis.map(function (name) {
          return { name: name, label: bankShortName(name), value: cmpPointValue(a, name, periods[periods.length - 1]), isFe: name === FAR_EASTERN_NAME, rank: cmpRankFor(a, name, periods[periods.length - 1]) };
        });
      }
      var endP = a.analysis === "month" ? a.period : (periods[periods.length - 1] || a.period);
      var valHead = (a.display === "yoy" ? (isRatio ? "較去年同期（pp）" : "YOY（%）") : "本期值（" + unit + "）");
      var rankHead = cmpRankHeaderLabel(metric, a.basis);
      var html = '<table class="cmp-table"><thead><tr><th scope="col">銀行</th><th scope="col">' + escapeHtml(valHead) + '</th>' +
        (a.display === "value" ? '<th scope="col">' + escapeHtml(isRatio ? "較去年同期（pp）" : "YOY（%）") + '</th>' : "") +
        '<th scope="col">' + escapeHtml(rankHead) + '</th></tr></thead><tbody>';
      tRows.forEach(function (r) {
        var yoyVal = a.display === "value" ? (function () { var v = metricView(metric, cmpRecordFor(endP, r.name), pType); return isFiniteNumber(v.yoy) ? v.yoy : null; })() : null;
        var isMarketRow = r.name === CMP_MARKET_TOTAL;
        html += '<tr class="' + (r.isFe ? "is-far-eastern" : "") + '"><th scope="row">' + escapeHtml(r.label) +
          (r.isFe ? ' <span class="tag-self">本行</span>' : "") + '</th>' +
          '<td class="num">' + escapeHtml(a.display === "yoy" ? (isFiniteNumber(r.value) ? (isRatio ? signedPp(r.value) : signedPct(r.value)) : "缺同期資料") : (isFiniteNumber(r.value) ? customFmt(metric, r.value) : "缺資料")) + '</td>' +
          (a.display === "value" ? '<td class="num ' + (isFiniteNumber(yoyVal) ? deltaClass(Number(yoyVal.toFixed(2))) : "delta-na") + '">' +
            escapeHtml(isFiniteNumber(yoyVal) ? (isRatio ? signedPp(yoyVal) : signedPct(yoyVal)) : "缺同期資料") + '</td>' : "") +
          '<td class="num">' + (isMarketRow ? "不適用" : (isFiniteNumber(r.rank) ? "第" + fmtRank(r.rank) + "名" : "—")) + '</td></tr>';
      });
      html += "</tbody></table>";
      var cap = a.analysis === "month" ? "數據（資料月份：" + periodShortLabel(findMarket(endP)) + "）" : "數據（資料月份：" + periodShortLabel(findMarket(endP)) + "，所選期間最後一個月）";
      tableEl.innerHTML = '<p class="cmp-table-caption">' + escapeHtml(cap) + '</p>' + html;
    }
  }

  /** 多銀行比較 PNG：16:9 簡報版型；包含標題、期間、數據方式、單位、圖例（僅目前可見系列）與資料來源。 */
  function exportCmpPng() {
    var a = customState.cmp.applied;
    if (!a || cmpIsDirty()) return;
    var wrap = document.getElementById("cmp-chart");
    var svg = wrap.querySelector("svg.linechart-svg, svg.hbar-svg");
    if (!svg) return;
    var metric = METRIC_CATALOG[a.metric];
    var vis = cmpVisibleBanks();
    var unit = cmpUnitLabel(metric, a.display);
    var periods = cmpPeriods(a);
    var basisTxt = metricSupportsPeriodType(metric) ? (a.basis === "ytd" ? "年初至今累計" : "單月") : (metric.kind === "ratio" ? "當月值" : "月底值");
    var sub = [
      a.analysis === "month" ? "資料月份：民國" + periodShortLabel(findMarket(a.period)) + "（月份比較）" : "分析期間：" + customRangeCaptionFor(periods) + "（期間趨勢）",
      "數據方式：" + basisTxt + "｜單位：" + unit + "｜顯示：" + (a.display === "yoy" ? (metric.kind === "ratio" ? "較去年同期變化（pp）" : "同期變化（YOY，%）") : "本期值"),
    ];
    var legend = vis.map(function (name, idx) {
      return { label: bankShortName(name), color: bankColor(name), dashed: a.analysis === "trend" && a.banks.indexOf(name) % 2 === 1 && name !== FAR_EASTERN_NAME };
    });
    var footer = ["資料來源：金管會銀行局信用卡業務統計附表五（processed 標準資料）", "僅顯示圖例中目前可見之銀行；排名母體為完整30家銀行。"];
    var hiddenNames = a.banks.filter(function (n) { return customState.cmp.hidden[n]; });
    if (hiddenNames.length) footer.push("已隱藏：" + hiddenNames.map(bankShortName).join("、"));
    composeCanvas(svg, { w: 1600, h: 900, title: a.title, titleSize: 34, subSize: 22, subtitleLines: sub, legend: a.analysis === "trend" ? legend : [], footer: footer }, function (canvas) {
      downloadCanvasPng(canvas, "信用卡市場與同業分析_多銀行比較_" + cmpCsvFileTag(a) + "_" + (a.analysis === "month" ? a.period : periods[0] + "至" + periods[periods.length - 1]) + "_" + vis.length + "家.png");
    });
  }

  /** 多銀行比較 CSV：僅輸出目前可見之系列（圖例隱藏者不輸出）。 */
  function exportCmpCsv() {
    var a = customState.cmp.applied;
    if (!a || cmpIsDirty()) return;
    var metric = METRIC_CATALOG[a.metric];
    var isRatio = metric.kind === "ratio";
    var unit = cmpUnitLabel(metric, a.display);
    var vis = cmpVisibleBanks();
    var lines;
    if (a.analysis === "month") {
      lines = [["銀行", "資料月份（西元）", "資料月份（民國）", "指標", "數據方式", "顯示數據", "單位", "數值", cmpRankHeaderLabel(metric, a.basis)].join(",")];
      vis.forEach(function (name) {
        var v = cmpPointValue(a, name, a.period);
        lines.push([csvCell(name), a.period, (parseInt(a.period.slice(0, 4), 10) - 1911) + "年" + parseInt(a.period.slice(5, 7), 10) + "月",
          csvCell(metric.label), customBasisFile(metric, a.basis), a.display === "yoy" ? (isRatio ? "較去年同期變化" : "同期變化") : "本期值",
          unit, isFiniteNumber(v) ? v : "", cmpRankFor(a, name, a.period) == null ? "" : cmpRankFor(a, name, a.period)].join(","));
      });
    } else {
      var periods = cmpPeriods(a);
      lines = [["月份（西元）", "月份（民國）", "銀行", "指標", "數據方式", "顯示數據", "單位", "數值", cmpRankHeaderLabel(metric, a.basis)].join(",")];
      periods.forEach(function (p) {
        vis.forEach(function (name) {
          var v = cmpPointValue(a, name, p);
          lines.push([p, (parseInt(p.slice(0, 4), 10) - 1911) + "年" + parseInt(p.slice(5, 7), 10) + "月", csvCell(name),
            csvCell(metric.label), customBasisFile(metric, a.basis), a.display === "yoy" ? (isRatio ? "較去年同期變化" : "同期變化") : "本期值",
            unit, isFiniteNumber(v) ? v : "", cmpRankFor(a, name, p) == null ? "" : cmpRankFor(a, name, p)].join(","));
        });
      });
    }
    var fileTail = a.analysis === "month" ? a.period : cmpPeriods(a)[0] + "至" + cmpPeriods(a).slice(-1)[0];
    downloadCsv("信用卡市場與同業分析_多銀行比較_" + cmpCsvFileTag(a) + "_" + fileTail + "_" + vis.length + "家.csv", lines);
  }

  // ------------------------------------------------------------------
  // 分頁切換與事件
  // ------------------------------------------------------------------

  function renderCustomTab() {
    var bankMode = document.getElementById("custom-bank-mode");
    var cmpMode = document.getElementById("custom-compare-mode");
    document.querySelectorAll("[data-custom-mode]").forEach(function (b) {
      var on = b.getAttribute("data-custom-mode") === customState.mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (bankMode) bankMode.hidden = customState.mode !== "bank";
    if (cmpMode) cmpMode.hidden = customState.mode !== "compare";
    if (customState.mode === "bank") {
      var combo = document.getElementById("bank-combo");
      var dl = document.getElementById("bank-datalist");
      if (dl) {
        dl.innerHTML = "";
        customBankList(state.selectedPeriod).forEach(function (n) {
          var o = document.createElement("option");
          o.value = bankShortName(n);
          dl.appendChild(o);
        });
      }
      if (combo && document.activeElement !== combo) combo.value = bankShortName(customState.bank.name);
      var cfgB = customState.bank;
      if (!cfgB.customStart) cfgB.customStart = (periodsForRange(state.selectedPeriod, "12", null, null)[0] || state.periods[0]);
      if (!cfgB.customEnd) cfgB.customEnd = state.selectedPeriod;
      fillRangeOptions(document.getElementById("bank-custom-start"), cfgB.customStart);
      fillRangeOptions(document.getElementById("bank-custom-end"), cfgB.customEnd);
      document.querySelectorAll("[data-bank-basis]").forEach(function (b) {
        var on = b.getAttribute("data-bank-basis") === cfgB.basis;
        b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      document.querySelectorAll("[data-bank-range]").forEach(function (b) {
        var on = b.getAttribute("data-bank-range") === cfgB.range;
        b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      var cust = document.getElementById("bank-custom-wrap");
      if (cust) cust.hidden = cfgB.range !== "custom";
      var bn = document.getElementById("bank-range-note");
      if (bn) bn.textContent = rangeNoteText(state.selectedPeriod, cfgB.range, cfgB.customStart, cfgB.customEnd);
      renderBankOverview();
    } else {
      if (!customState.cmp.draft) customState.cmp.draft = cmpDefaultDraft();
      var mSel = document.getElementById("cmp-metric");
      if (mSel && !mSel.options.length) {
        CUSTOM_METRIC_IDS.forEach(function (id) {
          var o = document.createElement("option");
          o.value = id; o.textContent = METRIC_CATALOG[id].label;
          mSel.appendChild(o);
        });
      }
      // 資料月份沿用全域操作列，不在此重複放置月份選單
      customState.cmp.draft.period = state.selectedPeriod;
      if (!customState.cmp.draft.cs) customState.cmp.draft.cs = (periodsForRange(state.selectedPeriod, "12", null, null)[0] || state.periods[0]);
      if (!customState.cmp.draft.ce) customState.cmp.draft.ce = state.selectedPeriod;
      fillRangeOptions(document.getElementById("cmp-custom-start"), customState.cmp.draft.cs);
      fillRangeOptions(document.getElementById("cmp-custom-end"), customState.cmp.draft.ce);
      renderCmpControls();
      if (!customState.cmp.applied) cmpApply();
    }
  }

  function bindCustomTab() {
    document.querySelectorAll("[data-custom-mode]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = btn.getAttribute("data-custom-mode");
        if (target === customState.mode) return;
        // 切換模式時保留銀行、月份與數據方式
        if (target === "compare") {
          if (!customState.cmp.draft) customState.cmp.draft = cmpDefaultDraft();
          customState.cmp.draft.period = state.selectedPeriod;
          customState.cmp.draft.basis = customState.bank.basis;
          if (!customState.cmp.draft.banks.length) customState.cmp.draft.banks = [customState.bank.name];
        } else if (customState.cmp.draft) {
          customState.bank.basis = customState.cmp.draft.basis;
          customState.bank.name = customState.cmp.draft.banks[0] || customState.bank.name;
        }
        customState.mode = target;
        renderCustomTab();
      });
    });

    var bindTo = function (id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    var pickBankFromCombo = function (e) {
      var v = e.target.value.trim();
      var hit = customBankList(state.selectedPeriod).filter(function (n) { return n === v || bankShortName(n) === v; })[0];
      if (hit) customState.bank.name = hit;
      renderCustomTab();
    };
    bindTo("bank-combo", "change", pickBankFromCombo);
    bindTo("bank-combo", "keydown", function (e) { if (e.key === "Enter") pickBankFromCombo(e); });
    bindTo("bank-switch-fe", "click", function () { customState.bank.name = FAR_EASTERN_NAME; renderCustomTab(); });
    document.querySelectorAll("[data-bank-range]").forEach(function (b) {
      b.addEventListener("click", function () { customState.bank.range = b.getAttribute("data-bank-range"); renderCustomTab(); });
    });
    document.querySelectorAll("[data-bank-basis]").forEach(function (b) {
      b.addEventListener("click", function () { customState.bank.basis = b.getAttribute("data-bank-basis"); renderCustomTab(); });
    });
    bindTo("bank-custom-start", "change", function (e) {
      var c = customState.bank, msg = "";
      c.customStart = e.target.value;
      if (c.customEnd && c.customStart > c.customEnd) { c.customEnd = c.customStart; msg = "已將結束月份調整為 " + rocShort(c.customEnd) + "（開始月份不得晚於結束月份）"; }
      setCustomMsg("bank-custom-msg", msg);
      renderCustomTab();
    });
    bindTo("bank-custom-end", "change", function (e) {
      var c = customState.bank, msg = "";
      c.customEnd = e.target.value;
      if (c.customStart && c.customStart > c.customEnd) { c.customStart = c.customEnd; msg = "已將開始月份調整為 " + rocShort(c.customStart) + "（結束月份不得早於開始月份）"; }
      setCustomMsg("bank-custom-msg", msg);
      renderCustomTab();
    });
    bindTo("bank-print-btn", "click", function () { window.print(); });
    bindTo("bank-csv-btn", "click", function () { exportBankCsv(); });
    var cards = document.getElementById("bank-cards");
    if (cards) cards.addEventListener("click", function (e) {
      var b = e.target.closest("[data-card-png]");
      if (b) exportBankCardPng(b.getAttribute("data-card-png"));
    });

    // 多銀行比較
    document.querySelectorAll("[data-cmp-analysis]").forEach(function (b) {
      b.addEventListener("click", function () { cmpSetDraft({ analysis: b.getAttribute("data-cmp-analysis") }); });
    });
    document.querySelectorAll("[data-cmp-display]").forEach(function (b) {
      b.addEventListener("click", function () { cmpSetDraft({ display: b.getAttribute("data-cmp-display") }); });
    });
    document.querySelectorAll("[data-cmp-basis]").forEach(function (b) {
      b.addEventListener("click", function () { cmpSetDraft({ basis: b.getAttribute("data-cmp-basis") }); });
    });
    document.querySelectorAll("[data-cmp-range]").forEach(function (b) {
      b.addEventListener("click", function () { cmpSetDraft({ range: b.getAttribute("data-cmp-range") }); renderCustomTab(); });
    });
    bindTo("cmp-metric", "change", function (e) { cmpSetDraft({ metric: e.target.value }); });
    bindTo("cmp-custom-start", "change", function (e) {
      var d = customState.cmp.draft, msg = "", ce = d.ce;
      if (ce && e.target.value > ce) { ce = e.target.value; msg = "已將結束月份調整為 " + rocShort(ce) + "（開始月份不得晚於結束月份）"; }
      setCustomMsg("cmp-custom-msg", msg);
      cmpSetDraft({ cs: e.target.value, ce: ce });
    });
    bindTo("cmp-custom-end", "change", function (e) {
      var d = customState.cmp.draft, msg = "", cs = d.cs;
      if (cs && e.target.value < cs) { cs = e.target.value; msg = "已將開始月份調整為 " + rocShort(cs) + "（結束月份不得早於開始月份）"; }
      setCustomMsg("cmp-custom-msg", msg);
      cmpSetDraft({ ce: e.target.value, cs: cs });
    });
    bindTo("cmp-search", "input", function () { renderCmpControls(); });
    bindTo("cmp-title-input", "input", function (e) { e.target.dataset.userEdited = "1"; renderCmpControls(); });
    bindTo("cmp-top12", "click", function () {
      var top = top12Banks(customState.cmp.draft.period).map(function (r) { return r.issuer_name; });
      cmpSetDraft({ banks: top });
    });
    bindTo("cmp-clear", "click", function () { cmpSetDraft({ banks: [] }); });
    bindTo("cmp-market-total", "change", function () { cmpToggleMarketTotal(); });
    bindTo("cmp-update", "click", function () { cmpApply(); });
    bindTo("cmp-png", "click", function () { exportCmpPng(); });
    bindTo("cmp-csv", "click", function () { exportCmpCsv(); });
    var list = document.getElementById("cmp-list");
    if (list) list.addEventListener("change", function (e) {
      var name = e.target.getAttribute("data-cmp-bank");
      if (!name) return;
      if (e.target.checked) cmpAddBank(name); else cmpRemoveBank(name);
      if (e.target.checked && customState.cmp.draft.banks.indexOf(name) < 0) e.target.checked = false;
    });
    var chips = document.getElementById("cmp-chips");
    if (chips) chips.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cmp-remove]");
      if (b) cmpRemoveBank(b.getAttribute("data-cmp-remove"));
    });
    var legend = document.getElementById("cmp-legend");
    if (legend) legend.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cmp-legend]");
      if (!b) return;
      var name = b.getAttribute("data-cmp-legend");
      customState.cmp.hidden[name] = !customState.cmp.hidden[name];
      renderCmpChart();
      renderCmpControls();
    });
  }

  // ==================================================================
  // 十三、初始化
  // ==================================================================

  function showPanels() {
    var status = document.getElementById("load-status");
    if (status) status.hidden = true;
    var appRoot = document.getElementById("app-root");
    if (appRoot) { appRoot.hidden = false; appRoot.setAttribute("aria-busy", "false"); }
  }

  function showError(message) {
    var status = document.getElementById("load-status");
    if (!status) return;
    status.hidden = false;
    status.classList.add("is-error");
    status.textContent = message;
  }

  function init() {
    Promise.all([
      fetch(ISSUER_URL).then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); }),
      fetch(MARKET_URL).then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); }),
    ])
      .then(function (results) {
        // 113年資料保留於查詢陣列，僅作為114年同期比較基期（YOY、同期排名）；
        // 可選月份與趨勢期間只取 DISPLAY_START_MONTH 起之月份。
        state.issuerData = results[0];
        state.marketData = results[1];
        state.periods = displayPeriods(state.marketData.map(function (r) { return r.period; }));
        state.selectedPeriod = state.periods[state.periods.length - 1] || null;

        if (!state.selectedPeriod) {
          showError("找不到任何月份資料，請確認 data/processed 內容是否完整。");
          return;
        }

        populatePeriodSelect();
        populateCustomRangeSelects();
        populateMetricSelects();
        renderTabsNav();
        bindPeriodTypeToggle();
        bindRangeSwitch();
        bindPeersControls();
        bindOverviewRowActions();
        bindOverviewBasisSwitch();
        bindCustomTab();
        bindStickyToggle();
        renderStickyBar();
        showPanels();
        renderAllTabs();
      })
      .catch(function (err) {
        showError(
          "無法讀取 data/processed 標準資料（" + err.message + "）。" +
          "若您是以 file:// 直接開啟本頁面，瀏覽器會封鎖本機 JSON 讀取，" +
          "請改用本機伺服器開啟：於專案根目錄執行「.venv\\Scripts\\python.exe -m http.server 8000」，" +
          "再開啟 http://localhost:8000 。"
        );
      });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", init);
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        // 操作列高度會隨寬度換行而改變（--sticky-h），不重算會讓固定表頭（同業比較等）的垂直位置與操作列不同步，
        // 視覺上像是表頭貼著／蓋住資料列第一行，不是欄寬本身跑掉。
        renderStickyBar();
        if (state.activeTab === "trends" && state.selectedPeriod) renderTrendsTab(state.selectedPeriod);
        if (state.activeTab === "custom") { if (customState.mode === "bank") renderBankOverview(); else renderCmpChart(); }

      }, 150);
    });
  }

  // 僅供 Node 環境下之單元測試使用（瀏覽器中 module 未定義，不影響實際行為）。
  // 見 tests/test_frontend_logic.js。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      isFiniteNumber: isFiniteNumber,
      bankTitleName: bankTitleName,
      customUnit: customUnit,
      customFmt: customFmt,
      bankColor: bankColor,
      seriesCss: seriesCss,
      overviewRelHtml: overviewRelHtml,
      trendPlanFor: trendPlanFor,
      trendUnitOf: trendUnitOf,
      periodChangeNote: periodChangeNote,
      diagSign: diagSign,
      diagItemHtml: diagItemHtml,
      standardCompetitionRank: standardCompetitionRank,
      peerSummaryPool: peerSummaryPool,
      peerColumns: peerColumns,
      peerSortFor: peerSortFor,
      filterPeerRows: filterPeerRows,
      peerGapText: peerGapText,
      peerChangeText: peerChangeText,
      diagRankResult: diagRankResult,
      diagSummarySentences: diagSummarySentences,
      homeCoreConclusion: homeCoreConclusion,
      summaryTagFor: summaryTagFor,
      compareByDirection: compareByDirection,
      rankChangeDirection: rankChangeDirection,
      rankChangeBadge: rankChangeBadge,
      rankBasisLabel: rankBasisLabel,
      relativeText: relativeText,
      leadBehindText: leadBehindText,
      formatGapValue: formatGapValue,
      fmtPct: fmtPct,
      fmtPp: fmtPp,
      fmtInt: fmtInt,
      fmt100m: fmt100m,
      fmtYuanPerCard: fmtYuanPerCard,
      deltaClass: deltaClass,
      metricRelativeGap: metricRelativeGap,
      homeSummaryPick: homeSummaryPick,
      homeSummaryLine: homeSummaryLine,
      summaryVerbPair: summaryVerbPair,
      fmtRank: fmtRank,
      sortDetailRows: sortDetailRows,
      DETAIL_DEFAULT_SORT: DETAIL_DEFAULT_SORT,
      overviewPeriodType: overviewPeriodType,
      displayPeriods: displayPeriods,
      bankShortName: bankShortName,
      rankNeighbors: rankNeighbors,
      buildPeerCards: buildPeerCards,
      sortPeerRows: sortPeerRows,
      sameBankGapText: sameBankGapText,
      rankChangeParts: rankChangeParts,
      fmtDistance: fmtDistance,
      fmtSignedDisplay: fmtSignedDisplay,
      niceTicks: niceTicks,
      formatTickLabel: formatTickLabel,
      axisPadLeft: axisPadLeft,
      selectAxisLabelIndices: selectAxisLabelIndices,
      rocYearMonthShort: rocYearMonthShort,
      periodFullLabel: periodFullLabel,
      isYearBoundary: isYearBoundary,
      analysisPeriodCaption: analysisPeriodCaption,
      customRangeCaption: customRangeCaption,
      metricNumberText: metricNumberText,
      METRIC_CATALOG: METRIC_CATALOG,
      METRIC_ORDER: METRIC_ORDER,
      OVERVIEW_GROUPS: OVERVIEW_GROUPS,
    };
  }
})();
