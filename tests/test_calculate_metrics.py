"""scripts/calculate_metrics.py 的單元測試。

僅使用 Python 內建 unittest，不另外安裝測試套件。
本測試直接使用 data/processed 內既有的標準資料（credit_card_monthly.json、
market_totals.json）進行計算與驗證。
"""

from __future__ import annotations

import math
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import calculate_metrics as calc  # noqa: E402


def r2(value):
    """四捨五入至 2 位小數，僅供測試比對顯示結果使用。"""
    return None if value is None else round(value, 2)


class TestOutputShape(unittest.TestCase):
    """1、2：輸出筆數。"""

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, cls.market_metrics = calc.build_all_metrics()

    def test_issuer_metrics_has_1024_rows(self):
        self.assertEqual(len(self.issuer_metrics), 1024)  # 32 個月份 × 32 家發卡機構

    def test_market_metrics_has_32_rows(self):
        self.assertEqual(len(self.market_metrics), 32)


class TestMissingComparisonPeriod(unittest.TestCase):
    """3、4：缺少真正比較月份時回傳 null；具備真正前一曆月／去年同月時可正確計算
    （完整 32 個月份：民國113年1月～115年8月。113年僅作為114年YoY／YTM YoY基期，
    113年本身因資料集內無112年資料，YoY 恆為 null）。"""

    ALL_PERIODS_EXCEPT_FIRST = (
        [f"2024-{mm:02d}" for mm in range(2, 13)]
        + [f"2025-{mm:02d}" for mm in range(1, 13)]
        + [f"2026-{mm:02d}" for mm in range(1, 8)]
    )
    YEAR_114_115_PERIODS = (
        [f"2025-{mm:02d}" for mm in range(1, 13)]
        + [f"2026-{mm:02d}" for mm in range(1, 8)]
    )

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, cls.market_metrics = calc.build_all_metrics()

    def test_2024_01_mom_is_null_no_prior_month_in_dataset(self):
        # 2024-01（113年1月）為資料集最早月份，無前一曆月可比較
        rows = [r for r in self.issuer_metrics if r["period"] == "2024-01"]
        self.assertTrue(rows)
        for r in rows:
            for field in calc.GROWTH_FIELDS:
                self.assertIsNone(
                    r[f"{field}_mom_pct"],
                    msg=f"2024-01 {r['issuer_name']} {field}_mom_pct 應為 null（資料集內無前一曆月）",
                )

    def test_mom_non_null_from_2024_02_to_2026_07(self):
        # 於市場合計層級驗證：市場總量不會為 0，因此只要存在真正前一曆月，
        # 月增率即應有值。個別機構層級若「前一曆月原始值恰為 0」，依規則
        # （分母為 0 時回傳 null）本來就應為 null，屬正確行為而非缺陷，
        # 故不逐機構逐欄位斷言（見 test_mom_null_only_when_base_missing_or_zero_at_issuer_level）。
        for period in self.ALL_PERIODS_EXCEPT_FIRST:
            rows = [r for r in self.market_metrics if r["period"] == period]
            self.assertTrue(rows, msg=f"{period} 找不到市場合計資料")
            for r in rows:
                for field in calc.GROWTH_FIELDS:
                    self.assertIsNotNone(
                        r[f"{field}_mom_pct"],
                        msg=f"{period} 市場合計 {field}_mom_pct 應有值（存在真正前一曆月）",
                    )

    def test_mom_null_only_when_base_missing_or_zero_at_issuer_level(self):
        # 機構層級：月增率為 null 時，必為「無前一曆月資料」或「前一曆月原始值為 0」
        # 其中之一，不得無故為 null。
        lookup = {(r["period"], r["issuer_name"]): r for r in self.issuer_metrics}
        for period in self.ALL_PERIODS_EXCEPT_FIRST:
            prev_period = calc.prev_month_period(period)
            for r in self.issuer_metrics:
                if r["period"] != period:
                    continue
                prev = lookup.get((prev_period, r["issuer_name"]))
                for field in calc.GROWTH_FIELDS:
                    mom = r[f"{field}_mom_pct"]
                    if mom is None:
                        prev_value = prev[field] if prev else None
                        self.assertTrue(
                            prev is None or prev_value is None or prev_value == 0,
                            msg=(
                                f"{period} {r['issuer_name']} {field}_mom_pct 為 null，"
                                f"但前一曆月原始值為 {prev_value}（非缺值也非0），不應為 null"
                            ),
                        )

    def test_yoy_null_for_all_2024_months_no_2023_data(self):
        # 113年（2024年）因資料集內無 112年（2023年）資料，YoY 恆為 null；
        # 113年資料僅作為 114年（2025年）YoY 的比較基期，其本身不計算 YoY。
        for mm in range(1, 13):
            period = f"2024-{mm:02d}"
            rows = [r for r in self.issuer_metrics if r["period"] == period]
            self.assertTrue(rows, msg=f"{period} 找不到資料")
            for r in rows:
                for field in calc.GROWTH_FIELDS:
                    self.assertIsNone(
                        r[f"{field}_yoy_pct"],
                        msg=f"{period} {r['issuer_name']} {field}_yoy_pct 應為 null（資料集內無 2023 年同期資料，不得以其他月份替代）",
                    )
                self.assertIsNone(r["charge_off_amount_ytd_yoy_pct"])

    def test_yoy_non_null_from_2025_01_to_2026_07(self):
        # 114年（2025年）起因有 113年（2024年）同期資料可比較，YoY 應有值；
        # 115年（2026年）1月至7月與114年同期比較亦應有值。
        # 市場合計層級驗證（理由同 test_mom_non_null_from_2024_02_to_2026_07）
        for period in self.YEAR_114_115_PERIODS:
            rows = [r for r in self.market_metrics if r["period"] == period]
            self.assertTrue(rows, msg=f"{period} 找不到市場合計資料")
            for r in rows:
                for field in calc.GROWTH_FIELDS:
                    self.assertIsNotNone(
                        r[f"{field}_yoy_pct"],
                        msg=f"{period} 市場合計 {field}_yoy_pct 應有值（存在去年同月資料）",
                    )

    def test_yoy_null_only_when_base_missing_or_zero_at_issuer_level(self):
        lookup = {(r["period"], r["issuer_name"]): r for r in self.issuer_metrics}
        for period in self.YEAR_114_115_PERIODS:
            prev_period = calc.prev_year_period(period)
            for r in self.issuer_metrics:
                if r["period"] != period:
                    continue
                prev = lookup.get((prev_period, r["issuer_name"]))
                for field in calc.GROWTH_FIELDS:
                    yoy = r[f"{field}_yoy_pct"]
                    if yoy is None:
                        prev_value = prev[field] if prev else None
                        self.assertTrue(
                            prev is None or prev_value is None or prev_value == 0,
                            msg=(
                                f"{period} {r['issuer_name']} {field}_yoy_pct 為 null，"
                                f"但去年同月原始值為 {prev_value}（非缺值也非0），不應為 null"
                            ),
                        )

    def test_2026_07_has_non_null_growth_values(self):
        far_eastern = [
            r for r in self.issuer_metrics
            if r["period"] == "2026-07" and r["issuer_name"] == "遠東國際商業銀行"
        ][0]
        self.assertIsNotNone(far_eastern["cards_in_force_mom_pct"])
        self.assertIsNotNone(far_eastern["cards_in_force_yoy_pct"])


class TestFarEasternJuly2026Metrics(unittest.TestCase):
    """5：115 年 7 月遠東國際商業銀行顯示結果核對。"""

    @classmethod
    def setUpClass(cls):
        issuer_metrics, _ = calc.build_all_metrics()
        matches = [
            r for r in issuer_metrics
            if r["period"] == "2026-07" and r["issuer_name"] == "遠東國際商業銀行"
        ]
        assert len(matches) == 1
        cls.r = matches[0]

    def test_effective_card_rate(self):
        self.assertEqual(r2(self.r["effective_card_rate_pct"]), 68.00)

    def test_cards_in_force(self):
        self.assertEqual(r2(self.r["cards_in_force_mom_pct"]), -0.10)
        self.assertEqual(r2(self.r["cards_in_force_yoy_pct"]), -5.94)

    def test_active_cards(self):
        self.assertEqual(r2(self.r["active_cards_mom_pct"]), -0.39)
        self.assertEqual(r2(self.r["active_cards_yoy_pct"]), -6.89)

    def test_cards_issued_month(self):
        self.assertEqual(r2(self.r["cards_issued_month_mom_pct"]), 10.24)
        self.assertEqual(r2(self.r["cards_issued_month_yoy_pct"]), -26.08)

    def test_cards_cancelled_month(self):
        self.assertEqual(r2(self.r["cards_cancelled_month_mom_pct"]), 7.33)
        self.assertEqual(r2(self.r["cards_cancelled_month_yoy_pct"]), 0.84)

    def test_purchase_amount_month(self):
        self.assertEqual(r2(self.r["purchase_amount_month_mom_pct"]), -23.95)
        self.assertEqual(r2(self.r["purchase_amount_month_yoy_pct"]), -22.59)

    def test_cash_advance_amount_month(self):
        self.assertEqual(r2(self.r["cash_advance_amount_month_mom_pct"]), 12.04)
        self.assertEqual(r2(self.r["cash_advance_amount_month_yoy_pct"]), 4.25)

    def test_charge_off_amount_ytd_yoy_only(self):
        self.assertEqual(r2(self.r["charge_off_amount_ytd_yoy_pct"]), -16.63)

    def test_market_shares(self):
        self.assertEqual(r2(self.r["cards_in_force_market_share_pct"]), 2.15)
        self.assertEqual(r2(self.r["active_cards_market_share_pct"]), 2.18)
        self.assertEqual(r2(self.r["purchase_amount_market_share_pct"]), 0.88)


class TestMarketJuly2026(unittest.TestCase):
    """6：市場 115 年 7 月有效卡率。"""

    def test_market_effective_card_rate(self):
        _, market_metrics = calc.build_all_metrics()
        rec = [r for r in market_metrics if r["period"] == "2026-07"][0]
        self.assertEqual(r2(rec["effective_card_rate_pct"]), 67.14)


class TestRatioFieldsUsePpOnly(unittest.TestCase):
    """7：J、K、L 及有效卡率使用 pp 差異，不產生一般成長率欄位。"""

    def test_no_growth_pct_fields_for_ratio_fields(self):
        issuer_metrics, _ = calc.build_all_metrics()
        sample = issuer_metrics[0]
        for field in calc.RATIO_PP_FIELDS:
            self.assertNotIn(f"{field}_mom_pct", sample)
            self.assertNotIn(f"{field}_yoy_pct", sample)
            self.assertIn(f"{field}_mom_pp", sample)
            self.assertIn(f"{field}_yoy_pp", sample)


class TestChargeOffYtdNoMom(unittest.TestCase):
    """8：charge_off_amount_ytd 不產生 mom_pct。"""

    def test_no_mom_field(self):
        issuer_metrics, _ = calc.build_all_metrics()
        sample = issuer_metrics[0]
        self.assertNotIn("charge_off_amount_ytd_mom_pct", sample)
        self.assertIn("charge_off_amount_ytd_yoy_pct", sample)


class TestNonBankBankRank(unittest.TestCase):
    """9、10：非銀行發卡機構 bank_rank 為 null；issuer_rank 母體 32 家、bank_rank 母體 30 家。"""

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, _ = calc.build_all_metrics()

    def test_non_bank_bank_rank_is_null(self):
        non_bank = [r for r in self.issuer_metrics if r["issuer_type"] == "non_bank_issuer"]
        self.assertTrue(non_bank)
        for r in non_bank:
            for field in calc.RANK_FIELDS:
                self.assertIsNone(
                    r[f"{field}_bank_rank"],
                    msg=f"{r['period']} {r['issuer_name']} {field}_bank_rank 應為 null",
                )

    def test_issuer_rank_population_is_32(self):
        periods = sorted({r["period"] for r in self.issuer_metrics})
        self.assertEqual(len(periods), 32)
        for period in periods:
            rows = [r for r in self.issuer_metrics if r["period"] == period]
            for field in calc.RANK_FIELDS:
                ranks = [r[f"{field}_issuer_rank"] for r in rows]
                self.assertEqual(len(ranks), 32)
                self.assertTrue(all(v is not None for v in ranks))
                self.assertEqual(max(ranks), 32)  # 32 家皆有值，最大名次應為 32

    def test_bank_rank_population_is_30(self):
        periods = sorted({r["period"] for r in self.issuer_metrics})
        for period in periods:
            bank_rows = [
                r for r in self.issuer_metrics
                if r["period"] == period and r["issuer_type"] == "bank"
            ]
            self.assertEqual(len(bank_rows), 30)
            for field in calc.RANK_FIELDS:
                ranks = [r[f"{field}_bank_rank"] for r in bank_rows]
                self.assertTrue(all(v is not None for v in ranks))
                self.assertEqual(max(ranks), 30)


class TestStandardCompetitionRanking(unittest.TestCase):
    """11：同值排名符合 1、2、2、4 規則（以合成資料直接測試排名函式，
    因目前真實資料中三個排名指標皆無同值情形）。"""

    def test_ties_produce_1_2_2_4(self):
        values = [
            (100, "a"),
            (90, "b"),
            (90, "c"),
            (80, "d"),
        ]
        ranks = calc.standard_competition_rank(values)
        self.assertEqual(ranks["a"], 1)
        self.assertEqual(ranks["b"], 2)
        self.assertEqual(ranks["c"], 2)
        self.assertEqual(ranks["d"], 4)

    def test_none_values_excluded_from_ranking(self):
        values = [(100, "a"), (None, "b"), (50, "c")]
        ranks = calc.standard_competition_rank(values)
        self.assertNotIn("b", ranks)
        self.assertEqual(ranks["a"], 1)
        self.assertEqual(ranks["c"], 2)


class TestMarketShareUsesOfficialTotal(unittest.TestCase):
    """12：市占率分母使用官方合計列。"""

    def test_share_matches_manual_calc_against_market_totals(self):
        issuer_metrics, market_metrics = calc.build_all_metrics()
        far_eastern = [
            r for r in issuer_metrics
            if r["period"] == "2026-07" and r["issuer_name"] == "遠東國際商業銀行"
        ][0]
        market_2026_07 = [r for r in market_metrics if r["period"] == "2026-07"][0]

        expected_share = far_eastern["cards_in_force"] / market_2026_07["cards_in_force"] * 100
        self.assertAlmostEqual(far_eastern["cards_in_force_market_share_pct"], expected_share, places=9)


class TestAmount100mConversion(unittest.TestCase):
    """13：金額億元欄位換算正確。"""

    def test_far_eastern_purchase_amount_100m(self):
        issuer_metrics, _ = calc.build_all_metrics()
        far_eastern = [
            r for r in issuer_metrics
            if r["period"] == "2026-07" and r["issuer_name"] == "遠東國際商業銀行"
        ][0]
        # 4002823 千元 ÷ 100000 = 40.02823 億元
        self.assertAlmostEqual(far_eastern["purchase_amount_month_100m"], 40.02823, places=5)
        # 原始千元欄位必須保留，不得覆寫
        self.assertEqual(far_eastern["purchase_amount_month"], 4002823)


class TestNoNaNOrInfinity(unittest.TestCase):
    """14：輸出不得含 NaN 或 Infinity。"""

    def test_no_non_finite_floats(self):
        issuer_metrics, market_metrics = calc.build_all_metrics()
        for r in issuer_metrics + market_metrics:
            for key, value in r.items():
                if isinstance(value, float):
                    self.assertTrue(
                        math.isfinite(value),
                        msg=f"{key}={value} 為非有限浮點數（NaN 或 Infinity）",
                    )

    def test_clean_helper_converts_non_finite_to_none(self):
        self.assertIsNone(calc._clean(float("nan")))
        self.assertIsNone(calc._clean(float("inf")))
        self.assertIsNone(calc._clean(float("-inf")))
        self.assertEqual(calc._clean(1.5), 1.5)
        self.assertIsNone(calc._clean(None))


class TestIdempotentReruns(unittest.TestCase):
    """15：程式連續執行兩次時，四個輸出檔內容一致。"""

    def test_two_runs_produce_identical_output_files(self):
        issuer_metrics, market_metrics = calc.build_all_metrics()

        with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
            out1 = Path(tmp1)
            out2 = Path(tmp2)
            calc.write_outputs(issuer_metrics, market_metrics, out1)

            issuer_metrics2, market_metrics2 = calc.build_all_metrics()
            calc.write_outputs(issuer_metrics2, market_metrics2, out2)

            for filename in (
                "issuer_metrics.csv",
                "issuer_metrics.json",
                "market_metrics.csv",
                "market_metrics.json",
            ):
                content1 = (out1 / filename).read_bytes()
                content2 = (out2 / filename).read_bytes()
                self.assertEqual(content1, content2, msg=f"{filename} 兩次執行結果不一致")


class TestYTMMetrics(unittest.TestCase):
    """新增：YTM（年初至今簽帳金額，Year-To-Month）指標驗證。"""

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, cls.market_metrics = calc.build_all_metrics()
        cls.monthly_raw = calc.load_json(calc.MONTHLY_INPUT)
        cls.market_raw = calc.load_json(calc.MARKET_INPUT)

    def _raw_sum(self, records, issuer_name, year, up_to_month):
        """獨立於 calculate_metrics.py 本身，直接從原始標準資料加總，作為交叉驗證基準。"""
        total = 0
        for m in range(1, up_to_month + 1):
            period = f"{year:04d}-{m:02d}"
            matches = [
                r for r in records
                if r["period"] == period and (issuer_name is None or r["issuer_name"] == issuer_name)
            ]
            if not matches:
                return None
            total += matches[0]["purchase_amount_month"]
        return total

    def test_january_ytm_equals_single_month_value(self):
        # 每年 1 月重新累計：1 月的 YTM 應恰好等於該月當月簽帳金額本身
        for period in ("2025-01", "2026-01"):
            rows = [r for r in self.issuer_metrics if r["period"] == period]
            self.assertTrue(rows)
            for r in rows:
                self.assertEqual(
                    r["purchase_amount_ytm"], r["purchase_amount_month"],
                    msg=f"{period} {r['issuer_name']} 1月YTM應等於當月簽帳金額本身",
                )
        mkt_jan = [r for r in self.market_metrics if r["period"] in ("2025-01", "2026-01")]
        for r in mkt_jan:
            self.assertEqual(r["purchase_amount_ytm"], r["purchase_amount_month"])

    def test_ytm_accumulates_within_year_and_resets_each_january(self):
        # 年度中段：YTM 應為該年 1 月至所選月份之加總；跨年不得延續累加
        far_eastern = [
            r for r in self.issuer_metrics
            if r["period"] == "2026-06" and r["issuer_name"] == "遠東國際商業銀行"
        ][0]
        expected = self._raw_sum(self.monthly_raw, "遠東國際商業銀行", 2026, 6)
        self.assertEqual(far_eastern["purchase_amount_ytm"], expected)

        # 2025年12月（去年最後一月）與2026年1月不得接續累加：
        # 2026-01 的 YTM 必須只等於 2026-01 當月值，不含 2025-12 累計
        dec_2025 = [
            r for r in self.issuer_metrics
            if r["period"] == "2025-12" and r["issuer_name"] == "遠東國際商業銀行"
        ][0]
        jan_2026 = [
            r for r in self.issuer_metrics
            if r["period"] == "2026-01" and r["issuer_name"] == "遠東國際商業銀行"
        ][0]
        self.assertNotEqual(
            jan_2026["purchase_amount_ytm"],
            dec_2025["purchase_amount_ytm"] + jan_2026["purchase_amount_month"],
            msg="2026-01 YTM 不得等於 2025 年累計值加上本月（代表誤跨年度累加）",
        )
        self.assertEqual(jan_2026["purchase_amount_ytm"], jan_2026["purchase_amount_month"])

    def test_2024_ytm_yoy_is_null_no_2023_data(self):
        # 113年（2024年）為資料集最早年度，無112年（2023年）同期累計可比較，
        # YTM YoY 恆為 null；113年資料僅作為114年之比較基期，其本身不計算 YTM YoY。
        for mm in range(1, 13):
            period = f"2024-{mm:02d}"
            rows = [r for r in self.issuer_metrics if r["period"] == period]
            self.assertTrue(rows, msg=f"{period} 找不到資料")
            for r in rows:
                self.assertIsNone(
                    r["purchase_amount_ytm_yoy_pct"],
                    msg=f"{period} {r['issuer_name']} YTM YoY 應為 null（無 2023 年同期資料）",
                )
        mkt_rows = [r for r in self.market_metrics if r["period"].startswith("2024-")]
        for r in mkt_rows:
            self.assertIsNone(r["purchase_amount_ytm_yoy_pct"])

    def test_2025_01_to_12_ytm_yoy_computed_against_matching_2024_period(self):
        # 114年（2025年）1月至12月，因有113年（2024年）同期累計可比較，YTM YoY 應有值
        for mm in range(1, 13):
            period = f"2025-{mm:02d}"
            far_eastern = [
                r for r in self.issuer_metrics
                if r["period"] == period and r["issuer_name"] == "遠東國際商業銀行"
            ][0]
            ytm_2025 = far_eastern["purchase_amount_ytm"]
            ytm_2024_same_range = self._raw_sum(self.monthly_raw, "遠東國際商業銀行", 2024, mm)
            expected_yoy = calc.safe_growth_pct(ytm_2025, ytm_2024_same_range)
            self.assertIsNotNone(far_eastern["purchase_amount_ytm_yoy_pct"], msg=f"{period} 應可計算 YTM YoY")
            self.assertAlmostEqual(far_eastern["purchase_amount_ytm_yoy_pct"], expected_yoy, places=6)

    def test_2025_07_ytm_yoy_compares_jan_to_jul_both_years(self):
        # 114年7月YTM YoY：114年1月至7月累計 對比 113年1月至7月累計
        far_eastern = [
            r for r in self.issuer_metrics
            if r["period"] == "2025-07" and r["issuer_name"] == "遠東國際商業銀行"
        ][0]
        ytm_2025_jul = self._raw_sum(self.monthly_raw, "遠東國際商業銀行", 2025, 7)
        ytm_2024_jul = self._raw_sum(self.monthly_raw, "遠東國際商業銀行", 2024, 7)
        expected_yoy = calc.safe_growth_pct(ytm_2025_jul, ytm_2024_jul)
        self.assertEqual(far_eastern["purchase_amount_ytm"], ytm_2025_jul)
        self.assertIsNotNone(expected_yoy)
        self.assertAlmostEqual(far_eastern["purchase_amount_ytm_yoy_pct"], expected_yoy, places=6)

    def test_2026_01_to_07_ytm_yoy_computed_against_matching_2025_period(self):
        # 115年各月YTM YoY仍與114年同期累計比較（113年資料不影響此結果）
        for mm in range(1, 8):
            period = f"2026-{mm:02d}"
            far_eastern = [
                r for r in self.issuer_metrics
                if r["period"] == period and r["issuer_name"] == "遠東國際商業銀行"
            ][0]
            ytm_2026 = far_eastern["purchase_amount_ytm"]
            ytm_2025_same_range = self._raw_sum(self.monthly_raw, "遠東國際商業銀行", 2025, mm)
            expected_yoy = calc.safe_growth_pct(ytm_2026, ytm_2025_same_range)
            self.assertIsNotNone(far_eastern["purchase_amount_ytm_yoy_pct"], msg=f"{period} 應可計算 YTM YoY")
            self.assertAlmostEqual(far_eastern["purchase_amount_ytm_yoy_pct"], expected_yoy, places=6)

    def test_market_ytm_equals_sum_of_32_issuers(self):
        periods = sorted({r["period"] for r in self.issuer_metrics})
        for period in periods:
            issuer_total = sum(
                r["purchase_amount_ytm"] for r in self.issuer_metrics if r["period"] == period
            )
            market_rec = [r for r in self.market_metrics if r["period"] == period][0]
            self.assertEqual(
                issuer_total, market_rec["purchase_amount_ytm"],
                msg=f"{period} 32 家機構 YTM 加總應等於市場 YTM",
            )

    def test_far_eastern_ytm_matches_independent_raw_sum(self):
        for period in ("2026-01", "2026-06", "2026-07"):
            year, month = map(int, period.split("-"))
            far_eastern = [
                r for r in self.issuer_metrics
                if r["period"] == period and r["issuer_name"] == "遠東國際商業銀行"
            ][0]
            expected = self._raw_sum(self.monthly_raw, "遠東國際商業銀行", year, month)
            self.assertEqual(far_eastern["purchase_amount_ytm"], expected)

    def test_ytm_issuer_rank_population_is_32(self):
        periods = sorted({r["period"] for r in self.issuer_metrics})
        for period in periods:
            rows = [r for r in self.issuer_metrics if r["period"] == period]
            ranks = [r["purchase_amount_ytm_issuer_rank"] for r in rows]
            self.assertEqual(len(ranks), 32)
            self.assertTrue(all(v is not None for v in ranks))
            self.assertEqual(max(ranks), 32)

    def test_ytm_bank_rank_population_is_30(self):
        periods = sorted({r["period"] for r in self.issuer_metrics})
        for period in periods:
            bank_rows = [
                r for r in self.issuer_metrics
                if r["period"] == period and r["issuer_type"] == "bank"
            ]
            self.assertEqual(len(bank_rows), 30)
            ranks = [r["purchase_amount_ytm_bank_rank"] for r in bank_rows]
            self.assertTrue(all(v is not None for v in ranks))
            self.assertEqual(max(ranks), 30)

    def test_non_bank_ytm_bank_rank_is_null(self):
        non_bank = [r for r in self.issuer_metrics if r["issuer_type"] == "non_bank_issuer"]
        self.assertTrue(non_bank)
        for r in non_bank:
            self.assertIsNone(
                r["purchase_amount_ytm_bank_rank"],
                msg=f"{r['period']} {r['issuer_name']} YTM bank_rank 應為 null（非銀行發卡機構）",
            )
            self.assertIsNotNone(r["purchase_amount_ytm_issuer_rank"])

    def test_ytm_ties_use_same_standard_competition_ranking_function(self):
        # 排名規則沿用既有 standard_competition_rank，不另創規則：以合成資料驗證
        values = [(500, "a"), (300, "b"), (300, "c"), (100, "d")]
        ranks = calc.standard_competition_rank(values)
        self.assertEqual((ranks["a"], ranks["b"], ranks["c"], ranks["d"]), (1, 2, 2, 4))

    def test_ytm_no_nan_or_infinity_when_denominator_zero_or_missing(self):
        # compute_ytm_value／safe_growth_pct／safe_ratio_pct 對 0 或缺值分母的防呆
        self.assertIsNone(calc.safe_growth_pct(100, 0))
        self.assertIsNone(calc.safe_growth_pct(100, None))
        self.assertIsNone(calc.safe_ratio_pct(100, 0))
        self.assertIsNone(calc.safe_ratio_pct(100, None))
        self.assertIsNone(calc.compute_ytm_value(lambda p: None, 2025, 3))

        for r in self.issuer_metrics + self.market_metrics:
            for key in ("purchase_amount_ytm", "purchase_amount_ytm_yoy_pct",
                        "purchase_amount_ytm_100m"):
                v = r.get(key)
                if isinstance(v, float):
                    self.assertTrue(math.isfinite(v), msg=f"{key}={v} 非有限值")
            share = r.get("purchase_amount_ytm_market_share_pct")
            if isinstance(share, float):
                self.assertTrue(math.isfinite(share))

    def test_ytm_outputs_present_in_fieldnames(self):
        issuer_fields = calc.issuer_fieldnames()
        market_fields = calc.market_fieldnames()
        for f in (
            "purchase_amount_ytm", "purchase_amount_ytm_yoy_pct",
            "purchase_amount_ytm_market_share_pct",
            "purchase_amount_ytm_issuer_rank", "purchase_amount_ytm_bank_rank",
            "purchase_amount_ytm_100m",
        ):
            self.assertIn(f, issuer_fields)
        for f in ("purchase_amount_ytm", "purchase_amount_ytm_yoy_pct", "purchase_amount_ytm_100m"):
            self.assertIn(f, market_fields)

    def test_two_runs_produce_identical_ytm_values(self):
        issuer1, market1 = calc.build_all_metrics()
        issuer2, market2 = calc.build_all_metrics()
        ytm1 = [(r["period"], r["issuer_name"], r["purchase_amount_ytm"]) for r in issuer1]
        ytm2 = [(r["period"], r["issuer_name"], r["purchase_amount_ytm"]) for r in issuer2]
        self.assertEqual(ytm1, ytm2)
        mkt_ytm1 = [(r["period"], r["purchase_amount_ytm"]) for r in market1]
        mkt_ytm2 = [(r["period"], r["purchase_amount_ytm"]) for r in market2]
        self.assertEqual(mkt_ytm1, mkt_ytm2)


FAR_EASTERN_NAME = "遠東國際商業銀行"


class TestNewFlowAndRatioMetrics(unittest.TestCase):
    """資訊架構改版階段新增指標：發卡數YTD、預借現金YTD、簽帳金額＋預借現金（單月／YTD）、
    流通卡每卡簽帳金額（單月／YTD）。皆僅由現有原始欄位（D、H、I 欄）重新組合計算，
    不讀取 data/raw、不虛構任何數值。"""

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, cls.market_metrics = calc.build_all_metrics()
        cls.issuer_by_pp = {(r["period"], r["issuer_name"]): r for r in cls.issuer_metrics}
        cls.market_by_p = {r["period"]: r for r in cls.market_metrics}

    def _fe(self, period):
        return self.issuer_by_pp[(period, FAR_EASTERN_NAME)]

    # ---- 發卡數YTD／預借現金YTD：1 月值應等於當月值，且為既有 compute_ytd_sum 之結果 ----

    def test_january_ytd_equals_single_month_value_for_new_fields(self):
        fe_jan = self._fe("2025-01")
        self.assertEqual(fe_jan["cards_issued_ytd"], fe_jan["cards_issued_month"])
        self.assertEqual(fe_jan["cash_advance_amount_ytd"], fe_jan["cash_advance_amount_month"])

    def test_cards_issued_ytd_resets_each_january(self):
        fe_dec = self._fe("2025-12")
        fe_jan_next = self._fe("2026-01")
        # 跨年度不得延續累加：2026-01 之 YTD 必須等於當月值，不含 2025-12 之累計
        self.assertEqual(fe_jan_next["cards_issued_ytd"], fe_jan_next["cards_issued_month"])
        self.assertNotEqual(fe_jan_next["cards_issued_ytd"], fe_dec["cards_issued_ytd"] + fe_jan_next["cards_issued_month"])

    def test_cash_advance_ytd_market_equals_sum_of_32_issuers(self):
        period = "2026-07"
        issuer_rows = [r for r in self.issuer_metrics if r["period"] == period]
        self.assertEqual(len(issuer_rows), 32)
        total = sum(r["cash_advance_amount_ytd"] for r in issuer_rows)
        self.assertEqual(total, self.market_by_p[period]["cash_advance_amount_ytd"])

    # ---- 簽帳金額＋預借現金（單月）：必須為 H 欄＋I 欄原始值直接相加 ----

    def test_purchase_plus_cash_month_equals_raw_sum(self):
        for period in ("2025-01", "2025-07", "2026-07"):
            fe = self._fe(period)
            self.assertEqual(
                fe["purchase_plus_cash_amount_month"],
                fe["purchase_amount_month"] + fe["cash_advance_amount_month"],
            )
            mkt = self.market_by_p[period]
            self.assertEqual(
                mkt["purchase_plus_cash_amount_month"],
                mkt["purchase_amount_month"] + mkt["cash_advance_amount_month"],
            )

    def test_purchase_plus_cash_month_market_total_equals_sum_of_32_issuers(self):
        period = "2026-07"
        issuer_rows = [r for r in self.issuer_metrics if r["period"] == period]
        total = sum(r["purchase_plus_cash_amount_month"] for r in issuer_rows)
        self.assertEqual(total, self.market_by_p[period]["purchase_plus_cash_amount_month"])

    # ---- 簽帳金額＋預借現金（YTD）：必須等於 YTM（簽帳金額YTD）＋預借現金YTD ----

    def test_purchase_plus_cash_ytd_equals_ytm_plus_cash_advance_ytd(self):
        for period in ("2025-01", "2025-07", "2026-07"):
            fe = self._fe(period)
            self.assertEqual(
                fe["purchase_plus_cash_amount_ytd"],
                fe["purchase_amount_ytm"] + fe["cash_advance_amount_ytd"],
            )
            mkt = self.market_by_p[period]
            self.assertEqual(
                mkt["purchase_plus_cash_amount_ytd"],
                mkt["purchase_amount_ytm"] + mkt["cash_advance_amount_ytd"],
            )

    # ---- 流通卡每卡簽帳金額：單位換算與公式 ----

    def test_per_card_spending_month_formula_and_unit(self):
        fe = self._fe("2026-07")
        expected = fe["purchase_amount_month"] * 1000 / fe["cards_in_force"]
        self.assertAlmostEqual(fe["per_card_spending_month"], expected, places=6)

    def test_per_card_spending_ytd_formula_uses_current_month_card_count(self):
        fe = self._fe("2026-07")
        expected = fe["purchase_amount_ytm"] * 1000 / fe["cards_in_force"]
        self.assertAlmostEqual(fe["per_card_spending_ytd"], expected, places=6)

    def test_per_card_value_helper_guards_zero_and_none_denominator(self):
        self.assertIsNone(calc.per_card_value(1000, 0))
        self.assertIsNone(calc.per_card_value(1000, None))
        self.assertIsNone(calc.per_card_value(None, 500))
        self.assertEqual(calc.per_card_value(1000, 500), 2000.0)

    # ---- YoY 基期規則：114年（2025）可用113年基期計算，113年本身（2024）YoY 為 null ----

    def test_2024_new_fields_yoy_is_null_no_2023_data(self):
        rows = [r for r in self.issuer_metrics if r["period"] == "2024-06"]
        for r in rows:
            for field in (
                "cards_issued_ytd_yoy_pct", "cash_advance_amount_ytd_yoy_pct",
                "purchase_plus_cash_amount_month_yoy_pct", "purchase_plus_cash_amount_ytd_yoy_pct",
                "per_card_spending_month_yoy_pct", "per_card_spending_ytd_yoy_pct",
            ):
                self.assertIsNone(r[field], msg=f"2024-06 {r['issuer_name']} {field} 應為 null（無2023年基期）")

    def test_2025_new_fields_yoy_non_null_using_2024_base(self):
        fe = self._fe("2025-07")
        for field in (
            "cards_issued_ytd_yoy_pct", "cash_advance_amount_ytd_yoy_pct",
            "purchase_plus_cash_amount_month_yoy_pct", "purchase_plus_cash_amount_ytd_yoy_pct",
            "per_card_spending_month_yoy_pct", "per_card_spending_ytd_yoy_pct",
        ):
            self.assertIsNotNone(fe[field], msg=f"2025-07 遠銀 {field} 應有值（113年基期存在）")

    # ---- 排名與市占率：沿用既有 32家／30家排名母體規則 ----

    def test_purchase_plus_cash_rank_population_matches_existing_rules(self):
        period = "2026-07"
        rows = [r for r in self.issuer_metrics if r["period"] == period]
        for field in ("purchase_plus_cash_amount_month", "purchase_plus_cash_amount_ytd"):
            issuer_ranks = [r[f"{field}_issuer_rank"] for r in rows]
            self.assertEqual(len([v for v in issuer_ranks if v is not None]), 32)
            bank_rows = [r for r in rows if r["issuer_type"] == "bank"]
            non_bank_rows = [r for r in rows if r["issuer_type"] == "non_bank_issuer"]
            self.assertEqual(len([r for r in bank_rows if r[f"{field}_bank_rank"] is not None]), 30)
            for r in non_bank_rows:
                self.assertIsNone(r[f"{field}_bank_rank"], msg=f"非銀行發卡機構 {field}_bank_rank 應為 null")
                self.assertIsNotNone(r[f"{field}_issuer_rank"])

    def test_purchase_plus_cash_market_share_within_0_to_100(self):
        for r in self.issuer_metrics:
            for field in ("purchase_plus_cash_amount_month_market_share_pct", "purchase_plus_cash_amount_ytd_market_share_pct"):
                v = r.get(field)
                if v is not None:
                    self.assertGreaterEqual(v, 0)
                    self.assertLessEqual(v, 100)

    # ---- 不得輸出 NaN／Infinity ----

    def test_new_fields_no_nan_or_infinity(self):
        new_fields = [
            "cards_issued_ytd", "cards_issued_ytd_yoy_pct",
            "cash_advance_amount_ytd", "cash_advance_amount_ytd_yoy_pct", "cash_advance_amount_ytd_100m",
            "purchase_plus_cash_amount_month", "purchase_plus_cash_amount_month_mom_pct",
            "purchase_plus_cash_amount_month_yoy_pct", "purchase_plus_cash_amount_month_100m",
            "purchase_plus_cash_amount_ytd", "purchase_plus_cash_amount_ytd_yoy_pct",
            "purchase_plus_cash_amount_ytd_100m",
            "purchase_plus_cash_amount_month_market_share_pct", "purchase_plus_cash_amount_ytd_market_share_pct",
            "per_card_spending_month", "per_card_spending_month_yoy_pct",
            "per_card_spending_ytd", "per_card_spending_ytd_yoy_pct",
        ]
        for r in self.issuer_metrics + self.market_metrics:
            for field in new_fields:
                if field not in r:
                    continue
                v = r.get(field)
                if isinstance(v, float):
                    self.assertTrue(math.isfinite(v), msg=f"{field}={v} 於 {r['period']} {r.get('issuer_name')} 非有限值")

    def test_new_fields_present_in_fieldnames_output(self):
        issuer_fields = calc.issuer_fieldnames()
        market_fields = calc.market_fieldnames()
        for f in (
            "cards_issued_ytd", "cash_advance_amount_ytd",
            "purchase_plus_cash_amount_month", "purchase_plus_cash_amount_ytd",
            "purchase_plus_cash_amount_month_market_share_pct", "purchase_plus_cash_amount_ytd_market_share_pct",
            "purchase_plus_cash_amount_month_issuer_rank", "purchase_plus_cash_amount_month_bank_rank",
            "purchase_plus_cash_amount_ytd_issuer_rank", "purchase_plus_cash_amount_ytd_bank_rank",
            "per_card_spending_month", "per_card_spending_ytd",
        ):
            self.assertIn(f, issuer_fields)
        for f in ("cards_issued_ytd", "cash_advance_amount_ytd", "purchase_plus_cash_amount_month",
                   "purchase_plus_cash_amount_ytd", "per_card_spending_month", "per_card_spending_ytd"):
            self.assertIn(f, market_fields)

    def test_two_runs_produce_identical_new_field_values(self):
        issuer1, market1 = calc.build_all_metrics()
        issuer2, market2 = calc.build_all_metrics()
        fields = ["purchase_plus_cash_amount_month", "purchase_plus_cash_amount_ytd",
                   "per_card_spending_month", "per_card_spending_ytd"]
        v1 = [(r["period"], r["issuer_name"], tuple(r[f] for f in fields)) for r in issuer1]
        v2 = [(r["period"], r["issuer_name"], tuple(r[f] for f in fields)) for r in issuer2]
        self.assertEqual(v1, v2)


class TestCardsIssuedRankAndShare(unittest.TestCase):
    """發卡數（單月／YTD）排名與市占率修復驗證。

    上一階段新增發卡數 YTD 累計時，漏將 cards_issued_month／cards_issued_ytd
    納入 RANK_FIELDS 與市占率計算清單，導致前端長期顯示「—」。本階段於
    calculate_metrics.py 補齊後，須與既有簽帳金額等欄位適用完全相同的
    32家發卡機構／30家銀行排名規則，不得另立標準。"""

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, cls.market_metrics = calc.build_all_metrics()

    def _rows(self, period):
        return [r for r in self.issuer_metrics if r["period"] == period]

    def test_cards_issued_month_issuer_rank_population_is_32(self):
        rows = self._rows("2026-07")
        ranked = [r for r in rows if r["cards_issued_month_issuer_rank"] is not None]
        self.assertEqual(len(ranked), 32)

    def test_cards_issued_month_bank_rank_population_is_30(self):
        rows = self._rows("2026-07")
        bank_rows = [r for r in rows if r["issuer_type"] == "bank"]
        ranked = [r for r in bank_rows if r["cards_issued_month_bank_rank"] is not None]
        self.assertEqual(len(ranked), 30)

    def test_cards_issued_ytd_issuer_rank_population_is_32(self):
        rows = self._rows("2026-07")
        ranked = [r for r in rows if r["cards_issued_ytd_issuer_rank"] is not None]
        self.assertEqual(len(ranked), 32)

    def test_cards_issued_ytd_bank_rank_population_is_30(self):
        rows = self._rows("2026-07")
        bank_rows = [r for r in rows if r["issuer_type"] == "bank"]
        ranked = [r for r in bank_rows if r["cards_issued_ytd_bank_rank"] is not None]
        self.assertEqual(len(ranked), 30)

    def test_non_bank_issuer_cards_issued_bank_rank_is_null(self):
        rows = self._rows("2026-07")
        non_bank = [r for r in rows if r["issuer_type"] == "non_bank_issuer"]
        self.assertEqual(len(non_bank), 2)
        for r in non_bank:
            self.assertIsNone(r["cards_issued_month_bank_rank"])
            self.assertIsNone(r["cards_issued_ytd_bank_rank"])
            self.assertIsNotNone(r["cards_issued_month_issuer_rank"])
            self.assertIsNotNone(r["cards_issued_ytd_issuer_rank"])

    def test_cards_issued_month_market_share_matches_formula(self):
        period = "2026-07"
        fe = [r for r in self._rows(period) if r["issuer_name"] == FAR_EASTERN_NAME][0]
        mkt = [r for r in self.market_metrics if r["period"] == period][0]
        expected = fe["cards_issued_month"] / mkt["cards_issued_month"] * 100
        self.assertAlmostEqual(fe["cards_issued_month_market_share_pct"], expected, places=6)

    def test_cards_issued_ytd_market_share_matches_formula(self):
        period = "2026-07"
        fe = [r for r in self._rows(period) if r["issuer_name"] == FAR_EASTERN_NAME][0]
        mkt = [r for r in self.market_metrics if r["period"] == period][0]
        expected = fe["cards_issued_ytd"] / mkt["cards_issued_ytd"] * 100
        self.assertAlmostEqual(fe["cards_issued_ytd_market_share_pct"], expected, places=6)

    def test_cards_issued_month_market_share_within_0_to_100(self):
        for r in self.issuer_metrics:
            v = r.get("cards_issued_month_market_share_pct")
            if v is not None:
                self.assertGreaterEqual(v, 0)
                self.assertLessEqual(v, 100)

    def test_cards_issued_rank_fields_present_in_fieldnames(self):
        issuer_fields = calc.issuer_fieldnames()
        for f in (
            "cards_issued_month_market_share_pct", "cards_issued_ytd_market_share_pct",
            "cards_issued_month_issuer_rank", "cards_issued_month_bank_rank",
            "cards_issued_ytd_issuer_rank", "cards_issued_ytd_bank_rank",
        ):
            self.assertIn(f, issuer_fields)


class TestYtdResetsAtYearBoundary(unittest.TestCase):
    """所有 YTD 流量型指標之年度重置規則：跨年時 1 月 YTD 必須等於當月值本身，
    不得延續上一年度12月的累計（即前端趨勢圖不得將12月與隔年1月直接連線視為
    業務驟降，因為資料本身在此處本就是「重新起算」，非「下滑」）。"""

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, _ = calc.build_all_metrics()

    def _fe(self, period):
        return [r for r in self.issuer_metrics if r["issuer_name"] == FAR_EASTERN_NAME and r["period"] == period][0]

    def test_all_ytd_flow_fields_reset_at_2026_01(self):
        dec = self._fe("2025-12")
        jan = self._fe("2026-01")
        ytd_fields = [
            ("cards_issued_ytd", "cards_issued_month"),
            ("purchase_amount_ytm", "purchase_amount_month"),
            ("purchase_plus_cash_amount_ytd", "purchase_plus_cash_amount_month"),
            ("cash_advance_amount_ytd", "cash_advance_amount_month"),
        ]
        for ytd_field, month_field in ytd_fields:
            self.assertEqual(
                jan[ytd_field], jan[month_field],
                msg=f"{ytd_field}：114年1月YTD應等於當月值本身（重新起算），不得延續113年12月累計",
            )
            # 114年12月累計必為全年累計，理應遠大於115年1月單月值，確認資料本身確有「重置」而非平滑延續
            self.assertGreater(dec[ytd_field], jan[ytd_field])

    def test_per_card_spending_ytd_uses_reset_ytm_at_year_start(self):
        jan = self._fe("2026-01")
        expected = jan["purchase_amount_ytm"] * 1000 / jan["cards_in_force"]
        self.assertAlmostEqual(jan["per_card_spending_ytd"], expected, places=6)


class TestTotalAssets(unittest.TestCase):
    """總資產：依使用者確認之業務口徑＝F欄循環信用餘額＋G欄未到期分期付款餘額。
    性質為存量（月底值），不計算YTD累計；另提供「較上年12月底（本年年初）變動」，
    與一般YoY（較去年同期）意義不同，須分開驗證。"""

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, cls.market_metrics = calc.build_all_metrics()

    def _fe(self, period):
        return [r for r in self.issuer_metrics if r["issuer_name"] == FAR_EASTERN_NAME and r["period"] == period][0]

    def _market(self, period):
        return [r for r in self.market_metrics if r["period"] == period][0]

    def test_total_assets_equals_revolving_plus_installment_for_issuer(self):
        for period in ("2025-01", "2025-07", "2026-07"):
            r = self._fe(period)
            self.assertEqual(r["total_assets"], r["revolving_credit_balance"] + r["installment_balance_not_due"])

    def test_total_assets_equals_revolving_plus_installment_for_market(self):
        for period in ("2025-01", "2025-07", "2026-07"):
            r = self._market(period)
            self.assertEqual(r["total_assets"], r["revolving_credit_balance"] + r["installment_balance_not_due"])

    def test_market_total_assets_equals_sum_of_32_issuers(self):
        period = "2026-07"
        issuer_rows = [r for r in self.issuer_metrics if r["period"] == period]
        self.assertEqual(len(issuer_rows), 32)
        total = sum(r["total_assets"] for r in issuer_rows)
        self.assertEqual(total, self._market(period)["total_assets"])

    def test_total_assets_100m_conversion(self):
        r = self._fe("2026-07")
        self.assertAlmostEqual(r["total_assets_100m"], r["total_assets"] / 100000, places=6)

    def test_total_assets_yoy_compares_to_same_month_last_year(self):
        cur = self._fe("2026-07")
        prev_y = self._fe("2025-07")
        expected = (cur["total_assets"] / prev_y["total_assets"] - 1) * 100
        self.assertAlmostEqual(cur["total_assets_yoy_pct"], expected, places=6)

    def test_total_assets_ytd_change_compares_to_december_of_previous_year_not_same_year_january(self):
        # 114年1月的「較年初變動」須對比113年12月底，而非114年1月自己（避免恆為0或誤用同年1月基準）。
        jan = self._fe("2026-01")
        dec_prev_year = self._fe("2025-12")
        expected = (jan["total_assets"] / dec_prev_year["total_assets"] - 1) * 100
        self.assertAlmostEqual(jan["total_assets_ytd_change_pct"], expected, places=6)
        # 同時驗證與 YoY（對比114年1月）不同，證明兩者未被誤用為同一欄位
        self.assertNotAlmostEqual(jan["total_assets_ytd_change_pct"], jan["total_assets_yoy_pct"], places=2)

    def test_total_assets_ytd_change_for_december_itself_compares_to_prior_year_same_month(self):
        # 12月的「較年初變動」其比較基準（上年12月）恰等於 YoY 之比較基準，兩者應相等（特例驗證，非巧合）。
        dec = self._fe("2025-12")
        self.assertAlmostEqual(dec["total_assets_ytd_change_pct"], dec["total_assets_yoy_pct"], places=6)

    def test_total_assets_null_when_2024_has_no_2023_base(self):
        r = self._fe("2024-06")
        self.assertIsNone(r["total_assets_yoy_pct"])
        self.assertIsNone(r["total_assets_ytd_change_pct"])

    def test_total_assets_no_nan_or_infinity(self):
        fields = ["total_assets", "total_assets_mom_pct", "total_assets_yoy_pct",
                  "total_assets_ytd_change_pct", "total_assets_100m"]
        for r in self.issuer_metrics + self.market_metrics:
            for f in fields:
                v = r.get(f)
                if isinstance(v, float):
                    self.assertTrue(math.isfinite(v), msg=f"{f}={v} 於 {r['period']} {r.get('issuer_name')} 非有限值")

    def test_total_assets_fields_present_in_fieldnames(self):
        issuer_fields = calc.issuer_fieldnames()
        market_fields = calc.market_fieldnames()
        for f in ("total_assets", "total_assets_mom_pct", "total_assets_yoy_pct",
                  "total_assets_ytd_change_pct", "total_assets_100m"):
            self.assertIn(f, issuer_fields)
            self.assertIn(f, market_fields)

    def test_total_assets_has_rank_and_market_share(self):
        # 總資產為可加總金額（非比率），市占率與排名皆有意義，依使用者後續確認已納入兩者。
        # 市占率為手動計算（非透過 MARKET_SHARE_SPEC 之原始欄位通用迴圈，因 total_assets 為衍生欄位）。
        self.assertIn("total_assets", calc.RANK_FIELDS)
        share_src_fields = [src for src, _ in calc.MARKET_SHARE_SPEC]
        self.assertNotIn("total_assets", share_src_fields)
        r = self._fe("2026-07")
        self.assertIsNotNone(r["total_assets_issuer_rank"])
        self.assertIsNotNone(r["total_assets_bank_rank"])
        self.assertIsNotNone(r["total_assets_market_share_pct"])

    def test_total_assets_market_share_matches_formula(self):
        period = "2026-07"
        fe = self._fe(period)
        mkt = self._market(period)
        expected = fe["total_assets"] / mkt["total_assets"] * 100
        self.assertAlmostEqual(fe["total_assets_market_share_pct"], expected, places=6)

    def test_total_assets_rank_population_32_issuers_30_banks(self):
        period = "2026-07"
        rows = [r for r in self.issuer_metrics if r["period"] == period]
        self.assertEqual(len([r for r in rows if r["total_assets_issuer_rank"] is not None]), 32)
        bank_rows = [r for r in rows if r["issuer_type"] == "bank"]
        self.assertEqual(len([r for r in bank_rows if r["total_assets_bank_rank"] is not None]), 30)
        non_bank = [r for r in rows if r["issuer_type"] == "non_bank_issuer"]
        for r in non_bank:
            self.assertIsNone(r["total_assets_bank_rank"])
            self.assertIsNotNone(r["total_assets_issuer_rank"])


class TestRankOnlyMetricsWithoutMarketShare(unittest.TestCase):
    """有效卡率、流通卡每卡簽帳金額（單月／YTD）：皆屬比率或每卡平均型指標，
    「市占率」對其數學上無意義（無法計算「比率的市占率」），但排名（依數值大小排序）
    仍是有效的同業比較方式。本階段依使用者提問新增排名，並確認市占率仍正確地不存在。"""

    @classmethod
    def setUpClass(cls):
        cls.issuer_metrics, cls.market_metrics = calc.build_all_metrics()

    def _fe(self, period):
        return [r for r in self.issuer_metrics if r["issuer_name"] == FAR_EASTERN_NAME and r["period"] == period][0]

    def test_effective_card_rate_has_rank_but_no_market_share(self):
        self.assertIn("effective_card_rate_pct", calc.RANK_FIELDS)
        share_src_fields = [src for src, _ in calc.MARKET_SHARE_SPEC]
        self.assertNotIn("effective_card_rate_pct", share_src_fields)
        r = self._fe("2026-07")
        self.assertIsNotNone(r["effective_card_rate_pct_issuer_rank"])
        self.assertIsNotNone(r["effective_card_rate_pct_bank_rank"])
        self.assertNotIn("effective_card_rate_pct_market_share_pct", r)

    def test_per_card_spending_month_has_rank_but_no_market_share(self):
        self.assertIn("per_card_spending_month", calc.RANK_FIELDS)
        share_src_fields = [src for src, _ in calc.MARKET_SHARE_SPEC]
        self.assertNotIn("per_card_spending_month", share_src_fields)
        r = self._fe("2026-07")
        self.assertIsNotNone(r["per_card_spending_month_issuer_rank"])
        self.assertIsNotNone(r["per_card_spending_month_bank_rank"])
        self.assertNotIn("per_card_spending_month_market_share_pct", r)

    def test_per_card_spending_ytd_has_rank_but_no_market_share(self):
        self.assertIn("per_card_spending_ytd", calc.RANK_FIELDS)
        share_src_fields = [src for src, _ in calc.MARKET_SHARE_SPEC]
        self.assertNotIn("per_card_spending_ytd", share_src_fields)
        r = self._fe("2026-07")
        self.assertIsNotNone(r["per_card_spending_ytd_issuer_rank"])
        self.assertIsNotNone(r["per_card_spending_ytd_bank_rank"])
        self.assertNotIn("per_card_spending_ytd_market_share_pct", r)

    def test_effective_card_rate_rank_population_32_issuers_30_banks(self):
        period = "2026-07"
        rows = [r for r in self.issuer_metrics if r["period"] == period]
        self.assertEqual(len([r for r in rows if r["effective_card_rate_pct_issuer_rank"] is not None]), 32)
        bank_rows = [r for r in rows if r["issuer_type"] == "bank"]
        self.assertEqual(len([r for r in bank_rows if r["effective_card_rate_pct_bank_rank"] is not None]), 30)

    def test_per_card_spending_rank_population_32_issuers_30_banks(self):
        period = "2026-07"
        rows = [r for r in self.issuer_metrics if r["period"] == period]
        for field in ("per_card_spending_month", "per_card_spending_ytd"):
            self.assertEqual(len([r for r in rows if r[f"{field}_issuer_rank"] is not None]), 32)
            bank_rows = [r for r in rows if r["issuer_type"] == "bank"]
            self.assertEqual(len([r for r in bank_rows if r[f"{field}_bank_rank"] is not None]), 30)

    def test_non_bank_issuers_bank_rank_null_for_rank_only_metrics(self):
        period = "2026-07"
        rows = [r for r in self.issuer_metrics if r["period"] == period and r["issuer_type"] == "non_bank_issuer"]
        self.assertEqual(len(rows), 2)
        for r in rows:
            self.assertIsNone(r["effective_card_rate_pct_bank_rank"])
            self.assertIsNone(r["per_card_spending_month_bank_rank"])
            self.assertIsNone(r["per_card_spending_ytd_bank_rank"])
            self.assertIsNotNone(r["effective_card_rate_pct_issuer_rank"])

    def test_new_rank_fields_present_in_fieldnames(self):
        issuer_fields = calc.issuer_fieldnames()
        for f in (
            "effective_card_rate_pct_issuer_rank", "effective_card_rate_pct_bank_rank",
            "per_card_spending_month_issuer_rank", "per_card_spending_month_bank_rank",
            "per_card_spending_ytd_issuer_rank", "per_card_spending_ytd_bank_rank",
            "total_assets_issuer_rank", "total_assets_bank_rank", "total_assets_market_share_pct",
        ):
            self.assertIn(f, issuer_fields)

    def test_new_rank_values_no_nan_or_infinity(self):
        fields = [
            "effective_card_rate_pct_issuer_rank", "effective_card_rate_pct_bank_rank",
            "per_card_spending_month_issuer_rank", "per_card_spending_month_bank_rank",
            "per_card_spending_ytd_issuer_rank", "per_card_spending_ytd_bank_rank",
            "total_assets_issuer_rank", "total_assets_bank_rank", "total_assets_market_share_pct",
        ]
        for r in self.issuer_metrics:
            for f in fields:
                v = r.get(f)
                if isinstance(v, float):
                    self.assertTrue(math.isfinite(v), msg=f"{f}={v} 於 {r['period']} {r.get('issuer_name')} 非有限值")


if __name__ == "__main__":
    unittest.main()
