/**
 * 前端方向感知比較邏輯單元測試（純函式，對應 assets/js/app.js 之
 * compareByDirection／rankChangeDirection／relativeText／leadBehindText）。
 *
 * 執行方式：node tests/test_frontend_logic.js
 * 不依賴任何測試框架或 npm 套件，使用 Node 內建 assert 模組。
 *
 * 本檔案專門驗證「競爭位置方向」相關邏輯（領先／落後／前一名／後一名），
 * 對應使用者回報之「元大領先44,417張」方向錯誤問題的修正與迴歸防護。
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const app = require("../assets/js/app.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL - " + name);
    console.log("    " + err.message);
  }
}

// 模擬 METRIC_CATALOG 中「數值越大越好」與「數值越小越好」兩類指標（例如流通卡數 vs 逾期比率）。
const higherIsBetterMetric = { direction: "higher_is_better", fmtRaw: app.fmtInt, unit: "張" };
const lowerIsBetterMetric = { direction: "lower_is_better", fmtRaw: app.fmtInt, unit: "張" };

console.log("TestCompareByDirection");

test("1. 前一名數值高於遠銀（數值越大越好）：前一名領先", function () {
  // 對應使用者案例：元大1,235,751張 vs 遠銀1,280,168張（遠銀較大，遠銀領先）
  const cmp = app.compareByDirection(higherIsBetterMetric, 1280168, 1235751);
  assert.strictEqual(cmp, 1, "遠銀(1,280,168) > 元大(1,235,751)，遠銀應領先（回傳1）");
});

test("2. 後一名數值低於遠銀（數值越大越好）：遠銀領先後一名", function () {
  const cmp = app.compareByDirection(higherIsBetterMetric, 1280168, 1000000);
  assert.strictEqual(cmp, 1, "遠銀數值較大，應為領先");
});

test("3. 遠銀與相鄰銀行同值：回傳0（持平）", function () {
  const cmp = app.compareByDirection(higherIsBetterMetric, 500000, 500000);
  assert.strictEqual(cmp, 0, "數值相同應回傳0");
});

test("4. 數值越大排名越好的指標（higher_is_better）：較大值領先", function () {
  const cmp = app.compareByDirection(higherIsBetterMetric, 200, 100);
  assert.strictEqual(cmp, 1);
  const cmp2 = app.compareByDirection(higherIsBetterMetric, 100, 200);
  assert.strictEqual(cmp2, -1);
});

test("5. 數值越小排名越好的指標（lower_is_better）：較小值領先", function () {
  const cmp = app.compareByDirection(lowerIsBetterMetric, 100, 200);
  assert.strictEqual(cmp, 1, "lower_is_better下，100應領先200");
  const cmp2 = app.compareByDirection(lowerIsBetterMetric, 200, 100);
  assert.strictEqual(cmp2, -1, "lower_is_better下，200應落後100");
});

test("缺值時回傳null，不得誤判方向", function () {
  assert.strictEqual(app.compareByDirection(higherIsBetterMetric, null, 100), null);
  assert.strictEqual(app.compareByDirection(higherIsBetterMetric, 100, undefined), null);
});

console.log("TestRankChangeDirection");

test("6a. 排名改善：名次數字變小（例如第10名→第8名）", function () {
  // currentRank=8, compareRank=10：名次變小，應為改善(1)
  const dir = app.rankChangeDirection(8, 10);
  assert.strictEqual(dir, 1, "排名從第10名進步到第8名應為改善");
});

test("6b. 排名衰退：名次數字變大（例如第8名→第10名）", function () {
  const dir = app.rankChangeDirection(10, 8);
  assert.strictEqual(dir, -1, "排名從第8名退步到第10名應為衰退");
});

test("排名持平：名次相同", function () {
  const dir = app.rankChangeDirection(5, 5);
  assert.strictEqual(dir, 0);
});

test("排名方向與指標 higher/lower_is_better 無關，恆為數字越小越好", function () {
  // 即使指標本身是 lower_is_better（如逾期比率），排名這個「名次」概念本身仍是數字越小越好
  const dir = app.rankChangeDirection(3, 5);
  assert.strictEqual(dir, 1, "排名本身不受指標方向影響，第5名進步到第3名恆為改善");
});

console.log("TestLeadBehindTextWording");

test("遠銀領先元大（使用者回報案例）：句子主詞須為遠銀，不得產生「元大領先」之誤讀", function () {
  // 遠銀 1,280,168 張, 元大 1,235,751 張, 差距 44,417 張，遠銀較大
  const text = app.leadBehindText(higherIsBetterMetric, "遠銀", "元大商業銀行", 1280168, 1235751);
  assert.ok(text.indexOf("遠銀領先元大商業銀行") === 0, "句子應以「遠銀領先元大商業銀行」開頭，實際：" + text);
  assert.ok(text.indexOf("44,417") >= 0, "差距數字應為44,417，實際：" + text);
  assert.ok(text.indexOf("張") >= 0);
});

test("元大落後遠銀（受詞視角）：句子主詞為元大", function () {
  const text = app.leadBehindText(higherIsBetterMetric, "元大商業銀行", "遠銀", 1235751, 1280168);
  assert.ok(text.indexOf("元大商業銀行落後遠銀") === 0, "句子應以「元大商業銀行落後遠銀」開頭，實際：" + text);
});

test("前一名銀行數值高於遠銀：遠銀落後前一名", function () {
  const text = app.leadBehindText(higherIsBetterMetric, "遠銀", "台新國際商業銀行", 29341, 37515);
  assert.ok(text.indexOf("遠銀落後台新國際商業銀行") === 0, text);
});

test("後一名銀行數值低於遠銀：遠銀領先後一名", function () {
  const text = app.leadBehindText(higherIsBetterMetric, "遠銀", "彰化商業銀行", 29341, 17631);
  assert.ok(text.indexOf("遠銀領先彰化商業銀行") === 0, text);
});

test("同值時顯示持平，不得顯示領先或落後", function () {
  const text = app.leadBehindText(higherIsBetterMetric, "遠銀", "某銀行", 500000, 500000);
  assert.ok(text.indexOf("持平") >= 0, text);
  assert.ok(text.indexOf("領先") === -1 && text.indexOf("落後") === -1, "持平時不應同時出現領先/落後字樣：" + text);
});

test("lower_is_better指標：數值較小者應判定為領先", function () {
  const text = app.leadBehindText(lowerIsBetterMetric, "遠銀", "某銀行", 50, 80);
  assert.ok(text.indexOf("遠銀領先某銀行") === 0, "lower_is_better下遠銀(50)應領先某銀行(80)：" + text);
});

console.log("TestRelativeText");

test("相對市場表現正值＝領先，負值＝落後（保留正負號語意）", function () {
  const pos = app.relativeText(16.69, ["領先", "落後"]);
  assert.ok(pos.text.indexOf("領先") === 0, pos.text);
  const neg = app.relativeText(-16.69, ["領先", "落後"]);
  assert.ok(neg.text.indexOf("落後") === 0, neg.text);
});

test("有效卡率水準差：高於/低於市場語意正確", function () {
  const higher = app.relativeText(0.86, ["高於", "低於"]);
  assert.ok(higher.text.indexOf("高於") === 0, higher.text);
});

console.log("TestRedRiseGreenFallColorConvention");

test("CSS：--color-positive（成長／上升用色）於淺色模式須為紅色，--color-negative（下降／衰退用色）須為綠色", function () {
  const css = fs.readFileSync(path.join(__dirname, "../assets/css/styles.css"), "utf8");
  const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme"));
  const posMatch = rootBlock.match(/--color-positive:\s*(#[0-9a-fA-F]{6})/);
  const negMatch = rootBlock.match(/--color-negative:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(posMatch && negMatch, "應能於 :root 找到 --color-positive／--color-negative 定義");
  // 紅色：R通道明顯高於G、B通道；綠色：G通道明顯高於R、B通道。
  function isReddish(hex) { return parseInt(hex.slice(1, 3), 16) > parseInt(hex.slice(3, 5), 16) + 40; }
  function isGreenish(hex) { return parseInt(hex.slice(3, 5), 16) > parseInt(hex.slice(1, 3), 16) + 20; }
  assert.ok(isReddish(posMatch[1]), "--color-positive（" + posMatch[1] + "）應為紅色（成長／上升）");
  assert.ok(isGreenish(negMatch[1]), "--color-negative（" + negMatch[1] + "）應為綠色（下降／衰退）");
});

test("CSS：真正的系統錯誤／警示色（--color-error／--color-warning）須與漲跌判讀色脫鉤，不隨紅漲綠跌定義連動", function () {
  const css = fs.readFileSync(path.join(__dirname, "../assets/css/styles.css"), "utf8");
  assert.ok(/--color-error:\s*#[0-9a-fA-F]{6}/.test(css), "應定義獨立的 --color-error");
  assert.ok(/\.status-banner\.is-error\s*\{[^}]*var\(--color-error\)/.test(css), "狀態錯誤訊息應使用 --color-error，不應沿用 --color-negative");
  assert.ok(/\.scope-note\.is-warning\s*\{[^}]*var\(--color-warning\)/.test(css), "警示文字應使用 --color-warning，不應沿用 --color-negative");
});

test("deltaClass：正數（成長／上升）歸類為 delta-pos，負數（下降／衰退）歸類為 delta-neg，供 CSS 紅漲綠跌上色", function () {
  assert.strictEqual(app.deltaClass(4.25), "delta-pos");
  assert.strictEqual(app.deltaClass(-3.87), "delta-neg");
  assert.strictEqual(app.deltaClass(0), "delta-zero");
});

console.log("TestRankChangeBadge");

test("排名進步（名次數字變小）：delta-pos（紅漲綠跌下為紅色）＋↑箭頭＋文字", function () {
  const badge = app.rankChangeBadge(8, 10); // 第10名→第8名，進步2名
  assert.strictEqual(badge.cls, "delta-pos");
  assert.ok(badge.text.indexOf("較去年同月") === 0, badge.text);
  assert.strictEqual(badge.text, "較去年同月上升2名", badge.text);
});

test("排名退步（名次數字變大）：delta-neg（紅漲綠跌下為綠色）＋↓箭頭＋文字", function () {
  const badge = app.rankChangeBadge(10, 8); // 第8名→第10名，退步2名
  assert.strictEqual(badge.cls, "delta-neg");
  assert.ok(badge.text.indexOf("較去年同月") === 0, badge.text);
  assert.strictEqual(badge.text, "較去年同月下降2名", badge.text);
});

test("排名持平：delta-zero，不得出現箭頭方向", function () {
  const badge = app.rankChangeBadge(5, 5);
  assert.strictEqual(badge.cls, "delta-zero");
  assert.strictEqual(badge.text, "較去年同月持平", badge.text);
});

test("缺值時不得誤判方向，cls 應為 delta-na 且文字為空", function () {
  const badge = app.rankChangeBadge(null, 10);
  assert.strictEqual(badge.cls, "delta-na");
  assert.strictEqual(badge.text, "");
});

console.log("TestSelfChangeVsRelativeGapDualColoring");

test("正成長但落後市場：本行自身變化（正值）與相對市場表現（負值）須各自依其正負號獨立著色，不得因落後市場而把自身正成長改標為衰退色", function () {
  // 對應使用者規格範例：遠銀YoY+4.25%、市場YoY+8.12%、遠銀－市場=-3.87pp
  const selfChange = app.fmtPct(4.25);
  const gapText = app.relativeText(4.25 - 8.12, ["領先", "落後"]);
  assert.strictEqual(selfChange.cls, "delta-pos", "遠銀自身+4.25%成長應獨立判定為delta-pos（紅漲綠跌下為紅色）");
  assert.strictEqual(gapText.cls, "delta-neg", "相對市場-3.87pp落後應獨立判定為delta-neg（紅漲綠跌下為綠色），與自身變化顏色不同");
  assert.ok(gapText.text.indexOf("落後") === 0, gapText.text);
});

test("負成長但相對市場領先：兩種判讀須分別呈現，不得合併為單一結論", function () {
  const selfChange = app.fmtPct(-2.0);
  const gapText = app.relativeText(-2.0 - (-6.0), ["領先", "落後"]); // 自身-2.0% 優於市場-6.0%，領先4pp
  assert.strictEqual(selfChange.cls, "delta-neg", "遠銀自身-2.0%應判定為delta-neg（下降，紅漲綠跌下為綠色）");
  assert.strictEqual(gapText.cls, "delta-pos", "相對市場領先4pp應判定為delta-pos（紅漲綠跌下為紅色），與自身變化顏色不同");
});

console.log("TestTotalAssetsNeutralWording");

test("信用卡應收帳款之相對市場措辭為中性「成長高於市場／成長低於市場」，不加 YOY 前綴", function () {
  const verbPair = app.summaryVerbPair(app.METRIC_CATALOG.total_assets);
  assert.deepStrictEqual(verbPair, ["成長高於市場", "成長低於市場"]);
});

test("排名比較基期：當月指標為較去年同月，YTD 指標為較去年同期", function () {
  assert.strictEqual(app.rankBasisLabel("month"), "較去年同月");
  assert.strictEqual(app.rankBasisLabel("ytd"), "較去年同期");
});

test("排名持平與缺同期資料分開：缺基期時回傳空文字（顯示缺同期資料），不得顯示持平", function () {
  const badge = app.rankChangeBadge(7, null, "較去年同月");
  assert.strictEqual(badge.text, "");
  assert.notStrictEqual(badge.cls, "delta-zero");
});

test("比率型指標（有效卡率）相對市場措辭為「高於市場／低於市場」（水準差，非超前／落後）", function () {
  const verbPair = app.summaryVerbPair(app.METRIC_CATALOG.effective_card_rate_pct);
  assert.deepStrictEqual(verbPair, ["當期高於市場", "當期低於市場"]);
});

test("成長型指標（如簽帳金額）相對市場措辭為「超前市場／落後市場」", function () {
  const verbPair = app.summaryVerbPair(app.METRIC_CATALOG.purchase_amount);
  assert.deepStrictEqual(verbPair, ["成長超前市場", "成長落後市場"]);
});

console.log("TestEightMetricsNoGapsInCatalog");

test("METRIC_ORDER 固定為8項指標，皆存在於 METRIC_CATALOG 且具備 label／kind", function () {
  assert.strictEqual(app.METRIC_ORDER.length, 8, "指標數量不得增減：" + app.METRIC_ORDER.join(","));
  app.METRIC_ORDER.forEach(function (id) {
    const m = app.METRIC_CATALOG[id];
    assert.ok(m, "METRIC_CATALOG 缺少 " + id);
    assert.ok(m.label && typeof m.label === "string", id + " 缺少 label");
    assert.ok(m.kind && typeof m.kind === "string", id + " 缺少 kind");
  });
});

test("首頁分類（OVERVIEW_GROUPS）涵蓋全部8項指標、互不重複，且與 METRIC_ORDER 內容完全一致", function () {
  const grouped = [];
  app.OVERVIEW_GROUPS.forEach(function (g) { g.metrics.forEach(function (id) { grouped.push(id); }); });
  assert.strictEqual(grouped.length, 8, "分組後指標總數應為8：" + grouped.join(","));
  assert.strictEqual(new Set(grouped).size, 8, "分組不得重複納入同一指標：" + grouped.join(","));
  assert.deepStrictEqual(grouped.slice().sort(), app.METRIC_ORDER.slice().sort(), "分組指標集合須與 METRIC_ORDER 完全一致，不得增減指標");
});

test("簽帳金額（不含預借現金）與簽帳金額＋預借現金皆保留於資產規模外之「消費表現」分類中，不得刪除任一口徑", function () {
  const spendingGroup = app.OVERVIEW_GROUPS.find(function (g) { return g.id === "spending"; });
  assert.ok(spendingGroup, "應存在「消費表現」分類");
  assert.ok(spendingGroup.metrics.indexOf("purchase_amount") >= 0, "簽帳金額（不含預借現金）不得被刪除");
  assert.ok(spendingGroup.metrics.indexOf("purchase_plus_cash_amount") >= 0, "簽帳金額＋預借現金不得被刪除");
});

test("信用卡應收帳款（原總資產欄位）不得改名為「總資產」，分類標籤顯示", function () {
  assert.strictEqual(app.METRIC_CATALOG.total_assets.label, "信用卡應收帳款");
  const assetsGroup = app.OVERVIEW_GROUPS.find(function (g) { return g.id === "assets"; });
  assert.ok(assetsGroup && assetsGroup.metrics.indexOf("total_assets") >= 0);
});

console.log("TestFlowMetricsEligibleForYtdPrimaryDisplay");

test("簽帳金額（不含預借現金）／簽帳金額＋預借現金／發卡數／每卡簽帳金額皆為流量型（具單月與YTD口徑），首頁應以YTD為主要資訊", function () {
  ["purchase_amount", "purchase_plus_cash_amount", "cards_issued", "per_card_spending"].forEach(function (id) {
    const m = app.METRIC_CATALOG[id];
    assert.ok(m.kind === "flow" || m.kind === "flow_no_share", id + " 應為流量型（flow／flow_no_share），實際：" + m.kind);
    assert.ok(m.availableViews.indexOf("ytd") >= 0, id + " 應支援 YTD 口徑");
    assert.ok(m.availableViews.indexOf("month") >= 0, id + " 應同時保留單月口徑（降為次要資訊，不得刪除）");
  });
});

test("存量型指標（流通卡數／有效卡數／有效卡率／信用卡應收帳款）不得具備YTD口徑", function () {
  ["cards_in_force", "active_cards", "effective_card_rate_pct", "total_assets"].forEach(function (id) {
    const m = app.METRIC_CATALOG[id];
    assert.ok(m.availableViews.indexOf("ytd") === -1, id + " 為存量／比率型，不得具備YTD口徑");
  });
});

console.log("TestChartYAxisNotClipped");

test("三位數Y軸百分比不被截斷：左側保留空間不小於最長刻度文字寬度", function () {
  const labels = ["100%", "50%", "0%", "-50%"];
  const padL = app.axisPadLeft(["100.32%", "34.94%", "-30.45%"]);
  assert.ok(padL >= app.axisPadLeft(["100%"]), "最長刻度 100.32% 應使用不小於 100% 的左側空間");
  assert.ok(padL >= app.axisPadLeft(["100.32%"]), "左側空間應依實際最長刻度字寬動態計算，實際：" + padL);
  assert.ok(labels.length === 4);
});

test("負數刻度保留負號，不得截成正數", function () {
  assert.strictEqual(app.formatTickLabel(-50, "%", 0), "-50%");
  assert.strictEqual(app.formatTickLabel(-30.45, "%", 2), "-30.45%");
});

test("完整數值格式不被縮短：100.32%、+0.64pp 等原樣保留", function () {
  assert.strictEqual(app.formatTickLabel(100.32, "%", 2), "100.32%");
});

test("Y軸刻度為容易閱讀之級距，且包含0%並涵蓋資料範圍", function () {
  const t = app.niceTicks(-30.45, 100.32, 4, true);
  assert.ok(t.ticks.indexOf(0) >= 0, "正負成長圖必須包含0%：" + JSON.stringify(t.ticks));
  assert.ok(t.min <= -30.45 && t.max >= 100.32, "刻度上下界須涵蓋資料：" + JSON.stringify(t));
  t.ticks.forEach(function (v) { assert.ok(Math.abs(v - Math.round(v)) < 1e-9 || t.step < 1, "刻度應為整數級距：" + v); });
});

console.log("TestChartTimeAxis");

test("自訂期間起點與終點正確：民國114年8月至115年7月，共12個月", function () {
  const periods = ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  assert.strictEqual(app.analysisPeriodCaption(periods), "分析期間：民國114年8月至115年7月｜共12個月");
  assert.strictEqual(app.customRangeCaption("2025-08", "2026-07"), "114/08–115/07");
});

test("X軸使用民國年，不得只顯示月份", function () {
  assert.strictEqual(app.rocYearMonthShort("2025-08"), "114/08");
  assert.strictEqual(app.rocYearMonthShort("2026-01"), "115/01");
});

test("跨年度時強制顯示新年度1月，且起點與終點不被autoSkip移除", function () {
  const periods = ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  const xOf = function (i) { return 60 + (i / 11) * 160; }; // 窄圖：空間極有限
  const idx = app.selectAxisLabelIndices(periods, xOf, 13);
  assert.ok(idx.indexOf(0) >= 0, "起點必須顯示");
  assert.ok(idx.indexOf(5) >= 0, "跨年度1月（115/01）必須顯示");
  assert.ok(idx.indexOf(11) >= 0, "終點必須顯示");
});

test("相鄰標籤不得重疊：窄圖時略過中間月份，並保留必要標籤", function () {
  const periods = ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  const xOf = function (i) { return 60 + (i / 11) * 160; };
  const idx = app.selectAxisLabelIndices(periods, xOf, 13);
  assert.ok(idx.length < periods.length, "窄圖應略過部分中間月份");
  for (let k = 1; k < idx.length; k++) {
    assert.ok(xOf(idx[k]) - xOf(idx[k - 1]) > 20, "相鄰標籤間距不足：" + idx.join(","));
  }
});

test("寬圖時近6個月可全部顯示", function () {
  const periods = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  const xOf = function (i) { return 60 + (i / 5) * 800; };
  assert.strictEqual(app.selectAxisLabelIndices(periods, xOf, 13).length, 6);
});

test("Tooltip 顯示完整民國年月與西元年月", function () {
  assert.strictEqual(app.periodFullLabel("2026-01"), "民國115年1月（2026-01）");
});

test("YTD跨年度判定：12月→隔年1月為年度交界，不得直接連線", function () {
  assert.strictEqual(app.isYearBoundary(["2025-12", "2026-01"], 1), true);
  assert.strictEqual(app.isYearBoundary(["2025-11", "2025-12"], 1), false);
  assert.strictEqual(app.isYearBoundary(["2025-12", "2026-01"], 0), false, "第一筆不視為交界");
});

test("主圖與小圖共用同一字級設定（CSS 軸線字級變數一致，SVG 文字一律使用 chart-axis-label）", function () {
  const css = fs.readFileSync(path.join(__dirname, "../assets/css/styles.css"), "utf8");
  assert.ok(/--fs-axis:\s*13px/.test(css), "軸線字級應統一為 13px");
  assert.ok(/\.chart-axis-label\s*\{[^}]*font-size:\s*var\(--fs-axis\)/.test(css));
});

test("圖表不得以 preserveAspectRatio=none 拉伸文字（避免字形變形）", function () {
  const js = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  assert.ok(js.indexOf('preserveAspectRatio", "none"') < 0, "不得以 none 拉伸 SVG");
});

test("切換期間或指標後圖表重新繪製，視窗改變時 resize 重繪", function () {
  const js = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  assert.ok(/window\.addEventListener\("resize"/.test(js), "應監聽 resize");
  assert.ok(/if \(tabId === "trends"\) renderTrendsTab/.test(js), "切換至趨勢分析時應以實際寬度重繪");
});

test("切換指標時不得重設自訂期間（trendRange 不於指標切換處理）", function () {
  const js = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const a = js.indexOf('sel.addEventListener("change"');
  const block = js.slice(a, a + 400);
  assert.ok(block.indexOf("trendRange") < 0, "指標切換處理不應改動 trendRange");
});

console.log("TestPeerTableAndDetail");

test("資料明細數值欄不重複單位（單位統一放欄名）", function () {
  const metric = app.METRIC_CATALOG.purchase_amount;
  const txt = app.metricNumberText(metric, 4454300000, 44543.0);
  assert.ok(txt.indexOf("億元") < 0, txt);
  assert.ok(txt.indexOf("44,543") >= 0 || txt.indexOf("44543") >= 0, txt);
});

test("同業比較：全部發卡機構模式不含銀行排名欄；前12大模式選流通卡數時只保留一個排名欄", function () {
  const labels = (scope, key) => app.peerColumns(scope, app.METRIC_CATALOG[key]).map(function (c) { return c.label; });
  const all = labels("all", "cards_in_force");
  assert.ok(all.some(function (l) { return l.indexOf("發卡機構排名") >= 0; }), all.join("|"));
  assert.strictEqual(all.filter(function (l) { return l.indexOf("銀行排名") >= 0; }).length, 0, all.join("|"));
  const topCards = labels("top12", "cards_in_force");
  assert.strictEqual(topCards.filter(function (l) { return l.indexOf("排名") >= 0; }).length, 1, topCards.join("|"));
  const topActive = labels("top12", "active_cards");
  assert.strictEqual(topActive.filter(function (l) { return l.indexOf("排名") >= 0; }).length, 2, topActive.join("|"));
});

test("同業比較：切換範圍時新模式不支援的排序欄改回所選指標數值由大至小；支援的欄位保留", function () {
  const m = app.METRIC_CATALOG.purchase_amount;
  assert.deepStrictEqual(app.peerSortFor("all", m, "cardsRank", "asc"), { field: "value", dir: "desc" });
  assert.deepStrictEqual(app.peerSortFor("all", m, "rank", "asc"), { field: "value", dir: "desc" });
  assert.deepStrictEqual(app.peerSortFor("top12", m, "rank", "asc"), { field: "rank", dir: "asc" });
  assert.deepStrictEqual(app.peerSortFor("all", m, "issuerRank", "desc"), { field: "issuerRank", dir: "desc" });
});

test("同業比較搜尋：機構全名或既有簡稱皆可辨識；空字串不過濾", function () {
  const rows = [{ name: "台灣美國運通國際(股)公司" }, { name: "遠東國際商業銀行" }, { name: "中國信託商業銀行" }];
  assert.strictEqual(app.filterPeerRows(rows, "").length, 3);
  assert.strictEqual(app.filterPeerRows(rows, "  中國信託 ").length, 1);
  assert.strictEqual(app.filterPeerRows(rows, "AMERICAN").length, 0);
  assert.strictEqual(app.filterPeerRows(rows, "美國運通").length, 1);
});

test("同業比較差額與同期文字：有效卡率為 pp（含空格），數量金額為 YOY ％，去年同期為0與缺值分開說明", function () {
  const ratio = app.METRIC_CATALOG.effective_card_rate_pct;
  assert.strictEqual(app.peerGapText(ratio, 0.5), "+0.50 pp");
  assert.strictEqual(app.peerGapText(ratio, -0.69), "−0.69 pp");
  assert.strictEqual(app.peerGapText(ratio, NaN), "—");
  assert.strictEqual(app.peerChangeText({ yoy: 0.5, prevRaw: 1 }, ratio), "較去年同期 +0.50 pp");
  const amt = app.METRIC_CATALOG.purchase_amount;
  assert.strictEqual(app.peerChangeText({ yoy: -6.89, prevRaw: 5 }, amt), "YOY −6.89%");
  assert.strictEqual(app.peerChangeText({ yoy: null, prevRaw: 0 }, amt), "去年同期為0，無法計算YOY");
  assert.strictEqual(app.peerChangeText({ yoy: null, prevRaw: 3 }, amt), "缺同期資料");
});

console.log("TestDetailDefaultSortByIssuerRank");

test("資料明細預設排序為發卡機構排名由小至大（1至32連續排列）", function () {
  assert.strictEqual(app.DETAIL_DEFAULT_SORT.field, "issuer_rank");
  assert.strictEqual(app.DETAIL_DEFAULT_SORT.dir, "asc");
});

test("預設排序不先分組：銀行與非銀行依發卡機構排名交錯排列", function () {
  const rows = [
    { row: { issuer_name: "甲銀行", issuer_type: "bank" }, view: { issuerRank: 2, bankRank: 1 } },
    { row: { issuer_name: "台灣美國運通國際(股)公司", issuer_type: "non_bank_issuer" }, view: { issuerRank: 1, bankRank: null } },
    { row: { issuer_name: "乙銀行", issuer_type: "bank" }, view: { issuerRank: 3, bankRank: 2 } },
    { row: { issuer_name: "台灣樂天信用卡股份有限公司", issuer_type: "non_bank_issuer" }, view: { issuerRank: 4, bankRank: null } },
  ];
  const sorted = app.sortDetailRows(rows, "issuer_rank", "asc").map(function (x) { return x.view.issuerRank; });
  assert.deepStrictEqual(sorted, [1, 2, 3, 4], "應依發卡機構排名連續排列：" + sorted.join(","));
});

test("非銀行發卡機構的銀行同業排名為 null，明細顯示「—」", function () {
  const rows = [{ row: { issuer_name: "X", issuer_type: "non_bank_issuer" }, view: { issuerRank: 1, bankRank: null } }];
  assert.strictEqual(app.fmtRank(rows[0].view.bankRank), "—");
});

test("點擊銀行同業排名欄仍可切換排序：依銀行排名排序時，非銀行（null）排在最後", function () {
  const rows = [
    { row: { issuer_name: "非銀", issuer_type: "non_bank_issuer" }, view: { issuerRank: 1, bankRank: null } },
    { row: { issuer_name: "乙銀", issuer_type: "bank" }, view: { issuerRank: 3, bankRank: 2 } },
    { row: { issuer_name: "甲銀", issuer_type: "bank" }, view: { issuerRank: 2, bankRank: 1 } },
  ];
  const byBank = app.sortDetailRows(rows, "bank_rank", "asc").map(function (x) { return x.row.issuer_name; });
  assert.deepStrictEqual(byBank, ["甲銀", "乙銀", "非銀"]);
  const byBankDesc = app.sortDetailRows(rows, "bank_rank", "desc").map(function (x) { return x.row.issuer_name; });
  assert.strictEqual(byBankDesc[byBankDesc.length - 1], "非銀", "降冪時缺值仍排最後");
});

test("排序不改變原陣列（不得就地修改）", function () {
  const rows = [{ row: { issuer_name: "b" }, view: { issuerRank: 2 } }, { row: { issuer_name: "a" }, view: { issuerRank: 1 } }];
  app.sortDetailRows(rows, "issuer_rank", "asc");
  assert.strictEqual(rows[0].row.issuer_name, "b");
});

console.log("TestHomeBasisAndSummaryV3");

test("首頁發卡與消費口徑：流量型四項預設為年初至今（YTD），存量與比率型固定為月底／當月", function () {
  assert.strictEqual(app.overviewPeriodType(app.METRIC_CATALOG.purchase_amount), "ytd");
  assert.strictEqual(app.overviewPeriodType(app.METRIC_CATALOG.cards_issued), "ytd");
  assert.strictEqual(app.overviewPeriodType(app.METRIC_CATALOG.per_card_spending), "ytd");
  assert.strictEqual(app.overviewPeriodType(app.METRIC_CATALOG.total_assets), "month");
  assert.strictEqual(app.overviewPeriodType(app.METRIC_CATALOG.cards_in_force), "month");
  assert.strictEqual(app.overviewPeriodType(app.METRIC_CATALOG.effective_card_rate_pct), "month");
});

console.log("TestBasePeriodExclusion");

test("113年基期不得成為可選月份或趨勢資料點，但保留於比較查詢（displayPeriods 僅過濾可瀏覽月份）", function () {
  assert.deepStrictEqual(app.displayPeriods(["2024-12", "2025-01", "2024-10", "2026-07"]), ["2025-01", "2026-07"]);
});

console.log("TestPeersPageV4");

test("同業差額為正負號分明之數值，單位依指標（金額億元、比率pp）", function () {
  const amount = app.METRIC_CATALOG.purchase_amount;
  assert.strictEqual(app.fmtSignedDisplay(amount, 6194.81), "+6,194.81");
  assert.strictEqual(app.fmtSignedDisplay(amount, -121.86), "-121.86");
  assert.strictEqual(app.fmtDistance(app.METRIC_CATALOG.effective_card_rate_pct, 0.86), "0.86pp");
  assert.strictEqual(app.fmtDistance(amount, null), "—");
});

test("標準競賽排名（1、2、2、4）：數值由大至小，缺值不納入排名，與 scripts/calculate_metrics.py 同規則", function () {
  const ranks = app.standardCompetitionRank([
    { id: "a", value: 100 }, { id: "b", value: 80 }, { id: "c", value: 80 },
    { id: "d", value: 50 }, { id: "e", value: null },
  ]);
  assert.deepStrictEqual(ranks, { a: 1, b: 2, c: 2, d: 4 });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ranks, "e"), false);
});

test("相邻名次：並列銀行一併列出，不任意挑一家（rankVal 為該範圍下的名次，不再永遠是 view.bankRank）", function () {
  const pool = [
    { row: { issuer_name: "A" }, rankVal: 3 },
    { row: { issuer_name: "B" }, rankVal: 5 },
    { row: { issuer_name: "C" }, rankVal: 5 },
    { row: { issuer_name: "遠東國際商業銀行" }, rankVal: 6 },
    { row: { issuer_name: "D" }, rankVal: 8 },
  ];
  const nb = app.rankNeighbors(pool, 6);
  assert.deepStrictEqual(nb.prev.map(function (x) { return x.row.issuer_name; }), ["B", "C"]);
  assert.deepStrictEqual(nb.next.map(function (x) { return x.row.issuer_name; }), ["D"]);
});

test("無前一名（第1名）與無後一名時，明確顯示文字而非空白；去年同期未入選時排名變化顯示「不適用」（不強算）", function () {
  const metric = app.METRIC_CATALOG.purchase_amount;
  const fe = app.METRIC_CATALOG.purchase_amount && "遠東國際商業銀行";
  const pool = [
    { row: { issuer_name: fe }, view: { raw: 100, raw100m: 0.001 }, rankVal: 1 },
    { row: { issuer_name: "X" }, view: { raw: 50, raw100m: 0.0005 }, rankVal: 2 },
  ];
  const cards = app.buildPeerCards(metric, "all", pool, pool[0], [], null, "較去年同期");
  assert.strictEqual(cards[1].value, "已為第1名");
  assert.strictEqual(cards[3].value, "不適用", "去年同期無对應項時不強算排名變化");
  const cards2 = app.buildPeerCards(metric, "all", [pool[1], pool[0]], pool[1], [], null, "較去年同期");
  assert.strictEqual(cards2[2].value, "無後一名");
});

test("摘要卡：距前一名＝前一名−遠銀；領先後一名＝遠銀−後一名（數值正確、單位依指標）", function () {
  const metric = app.METRIC_CATALOG.purchase_amount;
  const feRow = { issuer_name: "遠東國際商業銀行" };
  const pool = [
    { row: { issuer_name: "前" }, view: { raw: 0, raw100m: 1000 }, rankVal: 15 },
    { row: feRow, view: { raw: 0, raw100m: 900 }, rankVal: 16 },
    { row: { issuer_name: "後" }, view: { raw: 0, raw100m: 778.14 }, rankVal: 17 },
  ];
  const prevFeEntry = { row: feRow, view: { raw: 0, raw100m: 0 }, rankVal: 18 };
  const cards = app.buildPeerCards(metric, "all", pool, pool[1], [prevFeEntry], prevFeEntry, "較去年同期");
  assert.strictEqual(cards[0].value, "第16名／3家");
  assert.strictEqual(cards[1].value, "100.00億元");
  assert.strictEqual(cards[2].value, "121.86億元");
  assert.strictEqual(cards[3].value, "上升2名");
  assert.strictEqual(cards[3].sub, "較去年同期");
});

test("前12大模式：遠鋶未列入當月排行正前12大時，摘要明確說明且不加入第13家", function () {
  const metric = app.METRIC_CATALOG.purchase_amount;
  const pool = [
    { row: { issuer_name: "A" }, view: { raw: 100, raw100m: 1 }, rankVal: 1 },
    { row: { issuer_name: "B" }, view: { raw: 90, raw100m: 0.9 }, rankVal: 2 },
  ];
  const cards = app.buildPeerCards(metric, "top12", pool, null, [], null, "較去年同期");
  assert.strictEqual(cards[0].value, "未列入當月流通卡前12大銀行");
  assert.strictEqual(cards[1].value, "不適用");
  assert.strictEqual(cards[2].value, "不適用");
  assert.strictEqual(cards[3].value, "不適用");
});

test("同業表排序：缺值排最後、不當作0；升冪與降冪一致", function () {
  const rows = [{ name: "a", value: 3 }, { name: "b", value: null }, { name: "c", value: 1 }];
  assert.deepStrictEqual(app.sortPeerRows(rows, "value", "asc").map(function (r) { return r.name; }), ["c", "a", "b"]);
  assert.deepStrictEqual(app.sortPeerRows(rows, "value", "desc").map(function (r) { return r.name; }), ["a", "c", "b"]);
});

test("銀行簡稱對照：30家銀行皆有對照，且不隨意截字（未知名稱原樣保留）", function () {
  assert.strictEqual(app.bankShortName("中國信託商業銀行"), "中國信託");
  assert.strictEqual(app.bankShortName("遠東國際商業銀行"), "遠東商銀");
  assert.strictEqual(app.bankShortName("某未知銀行"), "某未知銀行");
});

test("排名變化：上升與下降以名次數字判斷，持平與缺資料分開", function () {
  assert.strictEqual(app.rankChangeParts(8, 10, "較去年同月").main, "上升2名");
  assert.strictEqual(app.rankChangeParts(10, 8, "較去年同月").main, "下降2名");
  assert.strictEqual(app.rankChangeParts(10, 10, "較去年同月").main, "持平");
  assert.strictEqual(app.rankChangeParts(10, null, "較去年同月").main, "缺同期資料");
});

console.log("TestHomeSummaryV5");

function fakeCand(id, o) {
  return Object.assign({ id: id, metric: app.METRIC_CATALOG[id], pType: "ytd", isRatio: id === "effective_card_rate_pct",
    feV: { yoy: -1, bankRank: 10, raw: 1 }, mktV: { yoy: 1, raw: 1 }, gap: -2, rankChangeAmt: 0 }, o || {});
}

test("核心業務固定以簽帳金額（不含預借現金）為第一則；資料不足時省略", function () {
  const items = app.homeSummaryPick([fakeCand("purchase_amount", { gap: -16.69, feV: { yoy: -1.94 }, mktV: { yoy: 14.75 } })]);
  assert.strictEqual(items[0].role, "core");
  const none = app.homeSummaryPick([fakeCand("purchase_amount", { gap: null, feV: { yoy: null }, mktV: { yoy: 1 } })]);
  assert.ok(none.every(function (i) { return i.role !== "core"; }), "缺同期資料時不產生核心業務結論");
});

test("明顯變化選排名變動最大的指標，排除信用卡應收帳款與比率型", function () {
  const items = app.homeSummaryPick([
    fakeCand("purchase_amount", { rankChangeAmt: 0 }),
    fakeCand("total_assets", { rankChangeAmt: -5 }),
    fakeCand("cards_issued", { rankChangeAmt: 2 }),
    fakeCand("per_card_spending", { rankChangeAmt: -1 }),
  ]);
  const change = items.find(function (i) { return i.role === "change"; });
  assert.strictEqual(change.c.id, "cards_issued", "應選變動幅度最大（2名）且非應收帳款之指標");
});

test("值得追查：有效卡率高於市場且較去年同月下降才產生；否則省略", function () {
  const hit = app.homeSummaryPick([fakeCand("effective_card_rate_pct", { gap: 0.86, feV: { yoy: -0.69, raw: 68 }, mktV: { raw: 67.14 } })]);
  assert.ok(hit.some(function (i) { return i.role === "watch"; }));
  const miss = app.homeSummaryPick([fakeCand("effective_card_rate_pct", { gap: 0.86, feV: { yoy: 0.5, raw: 68 }, mktV: { raw: 67.14 } })]);
  assert.ok(miss.every(function (i) { return i.role !== "watch"; }));
});

test("摘要句結論在前並加粗，不含「建議持續觀察」及不推論原因", function () {
  const items = app.homeSummaryPick([fakeCand("purchase_amount", { gap: -16.69, feV: { yoy: -1.94 }, mktV: { yoy: 14.75 } })]);
  const line = app.homeSummaryLine(items[0]);
  assert.strictEqual(line.tag, "簽帳表現");
  assert.ok(line.html.indexOf("<strong>市場年初至今累計簽帳金額成長，遠銀仍低於去年同期</strong>") >= 0, line.html);
  assert.ok(line.html.indexOf("建議持續觀察") < 0);
  assert.ok(line.html.indexOf("因為") < 0 && line.html.indexOf("原因") < 0);
});

test("摘要結構：結論加粗於第一行，支持數字包於獨立區塊（mgmt-support）且數字不拆行", function () {
  const items = app.homeSummaryPick([fakeCand("purchase_amount", { gap: -16.69, feV: { yoy: -1.94 }, mktV: { yoy: 14.75 } })]);
  const line = app.homeSummaryLine(items[0]);
  assert.ok(line.html.indexOf('<span class="mgmt-support">') >= 0, line.html);
  assert.ok(line.html.indexOf('<span class="nowrap') >= 0, "數字需用 nowrap 包住");
});

test("摘要依口徑標示：單月與年初至今累計文字隨候選口徑變化", function () {
  const monthItem = app.homeSummaryPick([fakeCand("purchase_amount", { pType: "month", gap: -1, feV: { yoy: -1 }, mktV: { yoy: 1 } })])[0];
  assert.ok(app.homeSummaryLine(monthItem).html.indexOf("（單月）") >= 0);
  const ytdItem = app.homeSummaryPick([fakeCand("purchase_amount", { pType: "ytd", gap: -1, feV: { yoy: -1 }, mktV: { yoy: 1 } })])[0];
  assert.ok(app.homeSummaryLine(ytdItem).html.indexOf("（年初至今累計）") >= 0);
});

console.log("TestSameBankGapChange");

test("同一家銀行差距：落後差距縮小／擴大，依去年同期同一家銀行比較", function () {
  const m = app.METRIC_CATALOG.purchase_amount;
  assert.ok(app.sameBankGapText(m, "prev", 10, 20, "甲").indexOf("遠銀落後甲的差距較去年同期縮小 10.00億元") === 0 ||
    app.sameBankGapText(m, "prev", 10, 20, "甲").indexOf("縮小") >= 0);
  assert.ok(app.sameBankGapText(m, "prev", 30, 20, "甲").indexOf("擴大") >= 0);
});

test("同一家銀行差距：差額由未取整數值相減（2026-07 新光：10.20409 vs 18.93733 → 縮小 8.73億元）", function () {
  const m = app.METRIC_CATALOG.purchase_amount;
  const text = app.sameBankGapText(m, "prev", 10.20409, 18.93733, "新光");
  assert.ok(text.indexOf("縮小 8.73億元") >= 0, text);
});

test("同一家銀行差距：領先差距與超越、同值、缺資料的文字正確", function () {
  const m = app.METRIC_CATALOG.purchase_amount;
  assert.ok(app.sameBankGapText(m, "next", 30, 20, "乙").indexOf("遠銀領先乙的差距較去年同期擴大") === 0);
  assert.ok(app.sameBankGapText(m, "prev", -5, 20, "甲").indexOf("遠銀已超越甲") === 0);
  assert.ok(app.sameBankGapText(m, "next", -5, 20, "乙").indexOf("乙已超越遠銀") === 0);
  assert.ok(app.sameBankGapText(m, "prev", 0, 20, "甲").indexOf("同值") >= 0);
  assert.strictEqual(app.sameBankGapText(m, "prev", 10, null, "甲"), null, "去年缺資料時不得產生結論");
});

console.log("TestCustomComparison");

test("自訂比較：元大商業銀行標題去除「商業」，遠銀為橘色且同一家銀行顏色穩定", function () {
  assert.strictEqual(app.bankTitleName("元大商業銀行"), "元大銀行");
  assert.strictEqual(app.bankColor("遠東國際商業銀行"), "#e07b1a");
  assert.strictEqual(app.bankColor("元大商業銀行"), app.bankColor("元大商業銀行"), "同一家銀行顏色需穩定");
});

test("自訂比較：單位與格式—比率為%（無空格）、卡數為萬張、金額為億元、缺值顯示「—」", function () {
  const ratio = app.METRIC_CATALOG.effective_card_rate_pct, card = app.METRIC_CATALOG.cards_in_force, amt = app.METRIC_CATALOG.purchase_amount;
  assert.strictEqual(app.customUnit(ratio).unit, "%");
  assert.strictEqual(app.customUnit(card).unit, "萬張");
  assert.strictEqual(app.customUnit(amt).unit, "億元");
  assert.strictEqual(app.customFmt(ratio, 44.27), "44.27%");
  assert.strictEqual(app.customFmt(amt, null), "—", "缺值不得顯示為 0");
});

test("自訂比較：線圖系列可指定顏色，未指定時沿用全站對象識別色變數", function () {
  assert.strictEqual(app.seriesCss({ color: "#123456", colorVar: "fareast" }), "#123456");
  assert.strictEqual(app.seriesCss({ colorVar: "fareast" }), "var(--series-fareast)");
});

test("頁面不含 FEIB 字樣或示意數據標籤（示意圖僅作版面參考）", function () {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  assert.strictEqual(html.indexOf("FEIB"), -1);
  assert.strictEqual(js.indexOf("FEIB"), -1);
  assert.strictEqual(html.indexOf("示意數據"), -1);
});

test("相對市場差異條：負值向左綠、正值向右紅、0 不畫色條、缺同期資料不畫條、超出尺度不截斷", function () {
  const m = app.METRIC_CATALOG.purchase_amount;
  const neg = app.overviewRelHtml(m, { yoy: 1 }, { yoy: 6 }, -5, 20);
  assert.ok(neg.indexOf("ov-diff-bar neg") >= 0 && neg.indexOf("width:12.50%") >= 0, neg);
  assert.ok(neg.indexOf("低於市場") >= 0 && neg.indexOf("-5.00 pp") >= 0, neg);
  const pos = app.overviewRelHtml(m, { yoy: 9 }, { yoy: 6 }, 3, 20);
  assert.ok(pos.indexOf("ov-diff-bar pos") >= 0 && pos.indexOf("高於市場") >= 0 && pos.indexOf("+3.00 pp") >= 0, pos);
  const zero = app.overviewRelHtml(m, { yoy: 6 }, { yoy: 6 }, 0, 20);
  assert.strictEqual(zero.indexOf("ov-diff-bar"), -1, "0 值不得畫色條");
  const missing = app.overviewRelHtml(m, { yoy: null }, { yoy: 6 }, null, 20);
  assert.ok(missing.indexOf("無同期資料") >= 0 && missing.indexOf("ov-diff-bar") === -1, missing);
  const over = app.overviewRelHtml(m, { yoy: 30 }, { yoy: 0 }, 30, 20);
  assert.ok(over.indexOf("width:50.00%") >= 0, "超出尺度時不得超過半寬");
  const ratio = app.METRIC_CATALOG.effective_card_rate_pct;
  const rh = app.overviewRelHtml(ratio, { raw: 68 }, { raw: 67.14 }, 0.86, 20);
  assert.ok(rh.indexOf("當月比率比較") >= 0 && rh.indexOf("高於市場") >= 0 && rh.indexOf("+0.86 pp") >= 0 && rh.indexOf("ov-diff-bar") === -1, rh);
});

console.log("TestSummaryLabelsAndBasis");

test("摘要標籤依指標內容對應；核心結論依單月／YTD 產生且單月不寫累計", function () {
  assert.strictEqual(app.summaryTagFor(app.METRIC_CATALOG.purchase_amount), "簽帳表現");
  assert.strictEqual(app.summaryTagFor(app.METRIC_CATALOG.cards_issued), "發卡表現");
  assert.strictEqual(app.summaryTagFor(app.METRIC_CATALOG.effective_card_rate_pct), "卡片活躍度");
  assert.strictEqual(app.homeCoreConclusion(-2, 5, -7, "單月"), "市場單月簽帳金額成長，遠銀仍低於去年同期");
  assert.strictEqual(app.homeCoreConclusion(-1.94, 14.75, -16.69, "年初至今累計"), "市場年初至今累計簽帳金額成長，遠銀仍低於去年同期");
  assert.strictEqual(app.homeCoreConclusion(-5, -3, -2, "單月"), "市場單月簽帳金額下降，遠銀降幅較大");
  assert.strictEqual(app.homeCoreConclusion(-2, -3, 1, "單月"), "市場單月簽帳金額下降，遠銀降幅較小");
  assert.ok(app.homeCoreConclusion(-2, -3, 1, "單月").indexOf("累計") < 0, "單月結論不得出現累計");
});

console.log("TestTrendPlan");

test("趨勢四圖設定：單月流量為柱狀（市場／遠銀），YTD 為雙線且跨年分段", function () {
  const issued = app.trendPlanFor(app.METRIC_CATALOG.cards_issued, "month");
  assert.strictEqual(issued.market.kind, "bar");
  assert.strictEqual(issued.fareast.kind, "bar");
  assert.strictEqual(issued.position.series[0].key, "share", "發卡數市占率為位置圖");
  const ytd = app.trendPlanFor(app.METRIC_CATALOG.purchase_amount, "ytd");
  assert.strictEqual(ytd.market.kind, "line");
  assert.strictEqual(ytd.market.series.length, 2, "YTD 應有當年累計與去年同期累計");
  assert.strictEqual(ytd.market.series[1].prev, true);
  assert.strictEqual(ytd.market.breakAtNewYear, true);
  assert.strictEqual(ytd.fareast.breakAtNewYear, true);
  assert.strictEqual(ytd.position.breakAtNewYear, true);
  assert.ok(ytd.market.title.indexOf("YTD") === 0 || ytd.market.title.indexOf("YTD") > 0, ytd.market.title);
});

test("趨勢四圖設定：有效卡率同期比較為 pp、位置為當期比率差、不提供市占率", function () {
  const rate = app.trendPlanFor(app.METRIC_CATALOG.effective_card_rate_pct, "month");
  assert.strictEqual(rate.compare.unit, "pp");
  assert.strictEqual(rate.position.series[0].key, "gap");
  assert.ok(rate.position.title.indexOf("有效卡率差") >= 0, rate.position.title);
  assert.ok(rate.position.series.every(function (s) { return s.key !== "share"; }));
});

test("趨勢四圖設定：每卡金額位置為銀行同業排名（第1名在上，30家母體），不計算市占率", function () {
  const pc = app.trendPlanFor(app.METRIC_CATALOG.per_card_spending, "ytd");
  assert.strictEqual(pc.position.invert, true);
  assert.deepStrictEqual(pc.position.domain, [1, 30]);
  assert.ok(pc.position.series.every(function (s) { return s.key !== "share"; }));
  const assets = app.trendPlanFor(app.METRIC_CATALOG.total_assets, "month");
  assert.strictEqual(assets.position.series[0].key, "share", "應收帳款為金額型存量，提供市占率");
});

test("趨勢單位：卡數為萬張、金額為億元、每卡為元/張、比率為%", function () {
  assert.strictEqual(app.trendPlanFor.length >= 0, true);
  assert.strictEqual(app.trendPlanFor(app.METRIC_CATALOG.cards_in_force, "month").market.unit, "萬張");
  assert.strictEqual(app.trendPlanFor(app.METRIC_CATALOG.purchase_amount, "month").market.unit, "億元");
  assert.strictEqual(app.trendPlanFor(app.METRIC_CATALOG.per_card_spending, "month").market.unit, "元/張");
  assert.strictEqual(app.trendPlanFor(app.METRIC_CATALOG.effective_card_rate_pct, "month").fareast.unit, "%");
});

console.log("TestDiagnosisAndTrendV14");

test("診斷數字負號為「−」，正號保留；排名結果含當期名次與較去年變化", function () {
  assert.strictEqual(app.diagSign("-6.89%"), "−6.89%");
  assert.strictEqual(app.diagSign("+0.19%"), "+0.19%");
  assert.strictEqual(app.diagSign("-7.08 pp"), "−7.08 pp");
  var up = app.diagRankResult(5, 7);
  assert.strictEqual(up.text, "第5名｜較去年上升2名");
  assert.strictEqual(up.cls, "delta-pos");
  var down = app.diagRankResult(7, 5);
  assert.strictEqual(down.text, "第7名｜較去年下降2名");
  assert.strictEqual(down.cls, "delta-neg");
  var flat = app.diagRankResult(3, 3);
  assert.strictEqual(flat.text, "第3名｜較去年持平");
  assert.strictEqual(flat.cls, "delta-zero");
  assert.strictEqual(app.diagRankResult(4, null).cls, "delta-na");
  assert.strictEqual(app.diagRankResult(undefined, 4).text, "缺資料");
});

test("期間變化：以未取整實際值計算，起點為0不計百分比，應收帳款只描述增減", function () {
  var series = { value: function (p) { return { a: 100.004, b: 120.5 }[p]; } };
  var metric = { id: "cards_in_force", fmtRaw: function () { return ""; }, kind: "stock" };
  var note = app.periodChangeNote(series, ["a", "b"], metric);
  assert.ok(note.indexOf("較期間起點：+20.50") === 0 || note.indexOf("較期間起點：+20.49") === 0, note);
  assert.ok(note.indexOf("%") > 0, note);
  var zero = { value: function (p) { return { a: 0, b: 5 }[p]; } };
  assert.ok(app.periodChangeNote(zero, ["a", "b"], metric).indexOf("起點為0，不計百分比") > 0);
  var assetsMetric = { id: "total_assets", fmtRaw: function () { return ""; }, kind: "stock" };
  var dec = { value: function (p) { return { a: 200, b: 150 }[p]; } };
  var assetNote = app.periodChangeNote(dec, ["a", "b"], assetsMetric);
  assert.ok(assetNote.indexOf("減少") > 0 && assetNote.indexOf("良") < 0 && assetNote.indexOf("增加") < 0, assetNote);
  var missing = { value: function (p) { return { a: null, b: 5 }[p]; } };
  assert.ok(app.periodChangeNote(missing, ["a", "b"], metric).indexOf("無法計算") > 0);
});

test("趨勢單位：卡數為萬張（圖與座標），發卡數同樣為萬張；金額為億元", function () {
  var cards = { id: "cards_issued", fmtRaw: function () { return ""; }, kind: "flow" };
  assert.strictEqual(app.trendUnitOf(cards), "萬張");
  var inForce = { id: "cards_in_force", fmtRaw: function () { return ""; }, kind: "stock" };
  assert.strictEqual(app.trendUnitOf(inForce), "萬張");
});

test("整合摘要：單句、數字帶符號、遠銀低於市場與市占率下降動態帶入", function () {
  var s = app.diagSummarySentences(-6.89, 0.19, -7.08, -0.17, false, "有效卡數");
  assert.strictEqual(s, "市場有效卡數YOY+0.19%，遠銀−6.89%，遠銀低於市場7.08 pp；市占率較去年同期下降0.17 pp。");
  assert.strictEqual((s.match(/。/g) || []).length, 1);
});

test("整合摘要：成長但低於市場不寫成衰退；兩者皆減少時說明遠銀減幅", function () {
  var grow = app.diagSummarySentences(1, 3, -2, null, false, "簽帳金額");
  assert.ok(grow.indexOf("遠銀低於市場2.00 pp") >= 0 && grow.indexOf("減少") < 0, grow);
  var both = app.diagSummarySentences(-5, -3, -2, null, false, "簽帳金額");
  assert.ok(both.indexOf("兩者皆減少，遠銀減幅較大") >= 0, both);
  assert.ok(app.diagSummarySentences(-1, -3, 2, null, false, "簽帳金額").indexOf("遠銀減幅較小") >= 0);
});

test("整合摘要：比率型用較去年同期 pp 與當期比率差，不提市占率且不寫 YOY", function () {
  var s = app.diagSummarySentences(0.5, 0.3, 1.2, null, true, "有效卡率");
  assert.strictEqual(s, "市場有效卡率較去年同期+0.30 pp，遠銀+0.50 pp，當期遠銀比率高於市場1.20 pp。");
  assert.ok(s.indexOf("市占率") < 0 && s.indexOf("YOY") < 0, s);
});

test("整合摘要：YTD 加「累計」；市占率為 0 時寫持平", function () {
  var s = app.diagSummarySentences(2, 1, 1, 0, false, "累計簽帳金額");
  assert.ok(s.indexOf("市場累計簽帳金額YOY+1.00%") === 0 && s.indexOf("市占率較去年同期持平") > 0, s);
});

test("診斷組與排名結果：項目與結果同組、排名結果含當期名次", function () {
  var html = app.diagItemHtml("遠銀YOY", "−6.89%", "delta-neg", true);
  assert.ok(html.indexOf("is-gap") >= 0 && html.indexOf("diag-item-value delta-neg") >= 0 && html.indexOf("遠銀YOY") >= 0, html);
  assert.strictEqual(app.diagRankResult(5, 7).text, "第5名｜較去年上升2名");
  assert.strictEqual(app.diagRankResult(3, 3).text, "第3名｜較去年持平");
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
