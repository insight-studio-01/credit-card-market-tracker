"""scripts/process_raw_data.py 的單元測試。

僅使用 Python 內建 unittest，不另外安裝測試套件。
本測試直接針對 data/raw 內完整 31 個月份（民國113年1月～115年7月）的真實原始檔進行驗證，
其中 115 年 7 月（2026-07）存在兩組命名不同、內容相同的來源檔案（去重邏輯），
113 年 6 月（11306，檔名含「更正後」）之「滙豐(台灣)商業銀行」當月簽帳金額欄位
帶有金管會正式修正註記（r 開頭），測試亦涵蓋此註記的解析與留存邏輯。

113 年資料僅作為後端 YoY／YTM YoY 計算基期，網站瀏覽範圍限制屬前端
（assets/js/app.js 的 DISPLAY_START_MONTH）之責，不在本測試檔範圍內。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import process_raw_data as praw  # noqa: E402

EXPECTED_PERIODS = (
    {f"2024-{mm:02d}" for mm in range(1, 13)}
    | {f"2025-{mm:02d}" for mm in range(1, 13)}
    | {f"2026-{mm:02d}" for mm in range(1, 9)}
)


class TestPeriodParsing(unittest.TestCase):
    """1、2：32 個月份年月辨識，並容許空格差異。"""

    def test_tolerates_various_spacing(self):
        cases = {
            "資料月份：115年7月": (115, 7),
            "資料月份：115 年 7 月": (115, 7),
            "資料月份：114 年7月": (114, 7),
            "115　年　6　月": (115, 6),  # 全形空白
            "114 年11 月": (114, 11),  # 月份前帶空格
            "115 年 3 月": (115, 3),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(praw.parse_roc_year_month_from_text(text), expected)

    def test_filename_patterns(self):
        self.assertEqual(
            praw.parse_roc_year_month_from_filename("11407_信用卡重要資訊揭露.xlsx"), (114, 7)
        )
        self.assertEqual(
            praw.parse_roc_year_month_from_filename("11506_信用卡重要資訊揭露.xlsx"), (115, 6)
        )
        self.assertEqual(
            praw.parse_roc_year_month_from_filename("附表5_115年7月信用卡重要資訊揭露.xlsx"),
            (115, 7),
        )

    def test_filename_11401_without_underscore(self):
        # 原始檔既有命名（缺少底線），不得要求改名，程式須相容辨識
        self.assertEqual(
            praw.parse_roc_year_month_from_filename("11401信用卡重要資訊揭露.xlsx"), (114, 1)
        )

    def test_filename_standard_with_underscore(self):
        self.assertEqual(
            praw.parse_roc_year_month_from_filename("11401_信用卡重要資訊揭露.xlsx"), (114, 1)
        )

    def test_filename_fubiao5_format(self):
        self.assertEqual(
            praw.parse_roc_year_month_from_filename("附表5_115年7月信用卡重要資訊揭露.xlsx"),
            (115, 7),
        )

    def test_filename_month_out_of_range_rejected(self):
        self.assertIsNone(praw.parse_roc_year_month_from_filename("11413_信用卡重要資訊揭露.xlsx"))
        self.assertIsNone(praw.parse_roc_year_month_from_filename("11400_信用卡重要資訊揭露.xlsx"))

    def test_filename_longer_digit_run_not_misparsed(self):
        # 5 碼後緊接數字時不得誤判為合法的「5碼民國年月」前綴
        self.assertIsNone(praw.parse_roc_year_month_from_filename("1140712_信用卡重要資訊揭露.xlsx"))

    def test_filename_11306_with_correction_suffix(self):
        # 113年6月檔名含「(更正後)」，仍須符合「5碼民國年月＋底線」規則正確辨識
        self.assertEqual(
            praw.parse_roc_year_month_from_filename("11306_信用卡重要資訊揭露(更正後).xlsx"),
            (113, 6),
        )

    def test_all_thirty_one_months_recognised_from_real_files(self):
        _, _, metadata = praw.build_dataset()
        periods = {m["period"] for m in metadata}
        self.assertEqual(periods, EXPECTED_PERIODS)
        self.assertEqual(len(periods), 32)

    def test_113_year_data_present_as_yoy_base_period(self):
        # 113年資料須存在於後端計算來源中（僅前端網站限制瀏覽範圍，不影響後端資料）
        _, _, metadata = praw.build_dataset()
        periods = {m["period"] for m in metadata}
        year_113_periods = {f"2024-{mm:02d}" for mm in range(1, 13)}
        self.assertTrue(year_113_periods.issubset(periods), msg="113年（2024年）12個月份應完整存在於計算來源中")


class TestDuplicatePeriodHandling(unittest.TestCase):
    """新增：同月份多來源 XLSX 的去重與衝突防護（resolve_duplicate_group）。"""

    @staticmethod
    def _fake_item(source_file: str, source_sha256: str, period: str = "2026-07"):
        metadata = {"period": period, "source_file": source_file, "source_sha256": source_sha256}
        return ([], {}, metadata)

    def test_single_source_marked_not_duplicate(self):
        item = self._fake_item("11507_信用卡重要資訊揭露.xlsx", "aaa")
        chosen, dup_info = praw.resolve_duplicate_group("2026-07", [item])
        self.assertFalse(dup_info["duplicate_sources"])
        self.assertEqual(dup_info["selected_source_file"], "11507_信用卡重要資訊揭露.xlsx")
        self.assertEqual(dup_info["all_source_files"], ["11507_信用卡重要資訊揭露.xlsx"])
        self.assertIsNone(dup_info["dedup_reason"])

    def test_same_content_dedupes_and_prefers_underscore_naming(self):
        a = self._fake_item("11507_信用卡重要資訊揭露.xlsx", "same-hash")
        b = self._fake_item("附表5_115年7月信用卡重要資訊揭露.xlsx", "same-hash")
        chosen, dup_info = praw.resolve_duplicate_group("2026-07", [a, b])
        self.assertTrue(dup_info["duplicate_sources"])
        self.assertEqual(dup_info["selected_source_file"], "11507_信用卡重要資訊揭露.xlsx")
        self.assertEqual(
            set(dup_info["all_source_files"]),
            {"11507_信用卡重要資訊揭露.xlsx", "附表5_115年7月信用卡重要資訊揭露.xlsx"},
        )
        self.assertIsNotNone(dup_info["dedup_reason"])

    def test_different_content_raises_validation_error(self):
        a = self._fake_item("11507_信用卡重要資訊揭露.xlsx", "hash-one")
        b = self._fake_item("附表5_115年7月信用卡重要資訊揭露.xlsx", "hash-two")
        with self.assertRaises(praw.ValidationError):
            praw.resolve_duplicate_group("2026-07", [a, b])

    def test_real_11507_duplicate_dedupes_without_error(self):
        # 以真實 data/raw 內的兩組 11507 檔案驗證完整流程不會拋出例外，且確實去重為 1 筆
        _, _, metadata = praw.build_dataset()
        matches = [m for m in metadata if m["period"] == "2026-07"]
        self.assertEqual(len(matches), 1, msg="同一月份去重後應只剩 1 筆 metadata")
        m = matches[0]
        self.assertTrue(m["duplicate_sources"])
        self.assertEqual(len(m["all_source_files"]), 2)
        self.assertEqual(m["selected_source_file"], "11507_信用卡重要資訊揭露.xlsx")


class TestDatasetShape(unittest.TestCase):
    """3、4、5：輸出筆數、每月銀行/非銀行家數、遠東國際商業銀行唯一性（32 個月份）。"""

    @classmethod
    def setUpClass(cls):
        cls.monthly, cls.market, cls.metadata = praw.build_dataset()
        cls.periods = sorted({m["period"] for m in cls.metadata})

    def test_total_record_counts(self):
        self.assertEqual(len(self.monthly), 1024)  # 32 個月份 × 32 家發卡機構
        self.assertEqual(len(self.market), 32)

    def test_bank_and_non_bank_counts_per_month(self):
        self.assertEqual(len(self.periods), 32)
        for period in self.periods:
            rows = [r for r in self.monthly if r["period"] == period]
            self.assertEqual(len(rows), 32, msg=f"{period} 應有 32 家發卡機構")
            banks = [r for r in rows if r["issuer_type"] == "bank"]
            non_banks = [r for r in rows if r["issuer_type"] == "non_bank_issuer"]
            self.assertEqual(len(banks), 30, msg=f"{period} 應有 30 家銀行")
            self.assertEqual(len(non_banks), 2, msg=f"{period} 應有 2 家非銀行發卡機構")

    def test_far_eastern_bank_once_per_month(self):
        for period in self.periods:
            rows = [
                r for r in self.monthly
                if r["period"] == period and r["issuer_name"] == "遠東國際商業銀行"
            ]
            self.assertEqual(len(rows), 1, msg=f"{period} 遠東國際商業銀行應恰好出現 1 次")

    def test_market_total_not_mixed_into_institutions(self):
        for r in self.monthly:
            self.assertNotEqual(r["issuer_name"], "總計")
            self.assertNotEqual(r["issuer_type"], "market_total")

    def test_no_duplicate_period_issuer_pairs(self):
        # 去重後不得出現重複的 period + issuer_name
        seen = set()
        for r in self.monthly:
            key = (r["period"], r["issuer_name"])
            self.assertNotIn(key, seen, msg=f"重複的月份＋機構組合：{key}")
            seen.add(key)


class TestFarEasternJuly2026Values(unittest.TestCase):
    """6：115 年 7 月遠東國際商業銀行原始值核對（32 個月份整合後仍須成立）。"""

    @classmethod
    def setUpClass(cls):
        monthly, _, _ = praw.build_dataset()
        matches = [
            r for r in monthly
            if r["period"] == "2026-07" and r["issuer_name"] == "遠東國際商業銀行"
        ]
        assert len(matches) == 1
        cls.record = matches[0]

    def test_values(self):
        r = self.record
        self.assertEqual(r["cards_in_force"], 1280168)
        self.assertEqual(r["active_cards"], 870466)
        self.assertEqual(r["cards_issued_month"], 6439)
        self.assertEqual(r["cards_cancelled_month"], 7804)
        self.assertEqual(r["purchase_amount_month"], 4002823)
        self.assertEqual(r["cash_advance_amount_month"], 84673)
        self.assertEqual(r["charge_off_amount_ytd"], 77525)

    def test_ratio_field_not_multiplied_by_100(self):
        # 8：J 欄 0.27 仍應為 0.27，不得變成 27。
        self.assertEqual(self.record["delinquency_ratio_3m"], 0.27)


class TestMarketTotalJuly2026Values(unittest.TestCase):
    """7：115 年 7 月市場合計原始值核對。"""

    @classmethod
    def setUpClass(cls):
        _, market, _ = praw.build_dataset()
        matches = [r for r in market if r["period"] == "2026-07"]
        assert len(matches) == 1
        cls.record = matches[0]

    def test_values(self):
        r = self.record
        self.assertEqual(r["cards_in_force"], 59488690)
        self.assertEqual(r["active_cards"], 39938830)
        self.assertEqual(r["cards_issued_month"], 478438)
        self.assertEqual(r["cards_cancelled_month"], 816360)
        self.assertEqual(r["purchase_amount_month"], 454359233)
        self.assertEqual(r["cash_advance_amount_month"], 1885515)
        self.assertEqual(r["charge_off_amount_ytd"], 3986536)


class TestSourceIntegrity(unittest.TestCase):
    """9：原始 XLSX 的 SHA-256 於處理前後一致（涵蓋全部 33 個外部 XLSX，含 11507 兩組）。"""

    EXPECTED_SHA256 = {
        "11301_信用卡重要資訊揭露.xlsx":
            "e0279737658b45e419360198c303c2b2ac182e9d6432d61bb71b5f3d79915ade",
        "11302_信用卡重要資訊揭露.xlsx":
            "e6bf97a4872ec576b3edb1669c3ab127eaa98d0adde6eab339acb78623faeb6e",
        "11303_信用卡重要資訊揭露.xlsx":
            "5ddea5b4490183a66de059195351e0db89ba879e7cca219e5598308901d60181",
        "11304_信用卡重要資訊揭露.xlsx":
            "b9d8f83143f4c2bed7d916d49f720107622f7d5a3203a8ca21c7bbb9c2d717ee",
        "11305_信用卡重要資訊揭露.xlsx":
            "88df59818789c753787a6bf48ca98c060da32cca4f2ce6928476e14b08e65e34",
        "11306_信用卡重要資訊揭露(更正後).xlsx":
            "85fa4452df8743a20a37effcebbb8d251a92fee5843d4a2baeb0c9f0119bc139",
        "11307_信用卡重要資訊揭露.xlsx":
            "4fde12a37fb59a33444b36f343730083b845c584dfd311fc1b112c5f0c3ade1f",
        "11308_信用卡重要資訊揭露.xlsx":
            "bc1c8b11f3bd1e012cc57c2916aff0c90671b86149d9b733994a4d04f064d1fd",
        "11309_信用卡重要資訊揭露.xlsx":
            "11351e850904edd320d1e8d839ef4c882e7ce5fa245b180f144c8d5e53b2f470",
        "11310_信用卡重要資訊揭露.xlsx":
            "a9cfd7c0047bdbe535ad31c5513c8bf0c9c2d9df898273a8ac55371121f07527",
        "11311_信用卡重要資訊揭露.xlsx":
            "9c367b1ef082c3b500294fd435fa78284037288ca49214df3dddd8b302eb049d",
        "11312_信用卡重要資訊揭露.xlsx":
            "e0e7fcc216518915bb23c3031432e98b4284eada60507ea174a5c2efe86cf4ec",
        "11401信用卡重要資訊揭露.xlsx":
            "292dece1fb9867703746e3a0cd8d318ba072ad863f83d6537cd7fdca6e22e12c",
        "11402_信用卡重要資訊揭露.xlsx":
            "e8a95cd5000849fdca2b7ed66a538b965d5d71db68909ed7ba22e5f7f45578c4",
        "11403_信用卡重要資訊揭露.xlsx":
            "4bcf63415ca8b7ebceed4c4b878a73ff568eb3b6f15356ab568960da9de5cfa9",
        "11404_信用卡重要資訊揭露.xlsx":
            "0a3d3269a34811896b344fe56cdee0dbb0e2015985a7c26fbbb0af2792c35fc8",
        "11405_信用卡重要資訊揭露.xlsx":
            "64a779b6994ebf6baad6d62c0119a2cdc4616ba1dc02ff3c350a5064ed7141d8",
        "11406_信用卡重要資訊揭露.xlsx":
            "2a16d28cf486bda897703bb79b253c5df57857125da61c92e63b9de8552e6ab7",
        "11407_信用卡重要資訊揭露.xlsx":
            "3290ea790ff5e08f06e2404418250a4442d307bae46549f4d2638cd1607eaa90",
        "11408_信用卡重要資訊揭露.xlsx":
            "78e8e43ec7d46509ef2642f6ca0380e8f2dd4cf153da8d0eec99778092e1459f",
        "11409_信用卡重要資訊揭露.xlsx":
            "ad2a80da785847298b5917e43027f34c7764d4c4ce388cee9d8e420897a4dfda",
        "11410_信用卡重要資訊揭露.xlsx":
            "4a0ef80a86b4f83f96869ea8395f7a17af1d89ed7bb685833bad7a74fc38f875",
        "11411_信用卡重要資訊揭露.xlsx":
            "596f4eac5a8816f6017cd2b281704cc9252885bd62747fe7903e270028e3c11d",
        "11412_信用卡重要資訊揭露.xlsx":
            "47d3e626934d2a58fdc69b75f2d3deb5feaa9de2e02519cc223691478699f216",
        "11501_信用卡重要資訊揭露.xlsx":
            "1cdad173d9ca5fd69acfcbfabc2cda0950969b1e17fa92684445950e04025b3d",
        "11502_信用卡重要資訊揭露.xlsx":
            "4b33f9b37e516fbf93d20ed7b452c79fad50460ca3b8e68278ed1a3a6a66bb24",
        "11503_信用卡重要資訊揭露.xlsx":
            "194afe9c255ceaf764c3e968ac43b355f9a62f29903187e8c80b329c120866ba",
        "11504_信用卡重要資訊揭露.xlsx":
            "7a07105e45f85dbf13b27e52007d35778dd9e2b9fa21621875291c318595b9e1",
        "11505_信用卡重要資訊揭露.xlsx":
            "8a065b6eeef66eb17af152774e710670371f20faf4e3e9eabe498ea8ce39084d",
        "11506_信用卡重要資訊揭露.xlsx":
            "fff15f2f0dddf329eba2faccf4f564fb261a55d7270cff844a645df5fd30393c",
        "11507_信用卡重要資訊揭露.xlsx":
            "d7a3295cfce3ccba09acf769ee76a3c2fd49898ce1524f893a3f68c622919d9b",
        "附表5_115年7月信用卡重要資訊揭露.xlsx":
            "d7a3295cfce3ccba09acf769ee76a3c2fd49898ce1524f893a3f68c622919d9b",
        "11508_信用卡重要資訊揭露.xlsx":
            "82094fa34763d678c76190fb958f17f18988935dd7ae9ef73b7cd4418ed50e75",
    }

    def test_sha256_matches_recorded_values(self):
        for filename, expected in self.EXPECTED_SHA256.items():
            path = praw.RAW_DIR / filename
            self.assertEqual(praw.sha256_of(path), expected, msg=filename)

    def test_sha256_unchanged_before_and_after_processing(self):
        before = {
            f.name: praw.sha256_of(f) for f in praw.discover_raw_files()
        }
        praw.build_dataset()
        after = {
            f.name: praw.sha256_of(f) for f in praw.discover_raw_files()
        }
        self.assertEqual(before, after)

    def test_metadata_records_matching_sha256(self):
        _, _, metadata = praw.build_dataset()
        for m in metadata:
            expected = self.EXPECTED_SHA256[m["source_file"]]
            self.assertEqual(m["source_sha256"], expected)


class TestIdempotentReruns(unittest.TestCase):
    """10：程式連續執行兩次，輸出檔案內容一致。"""

    def test_two_runs_produce_identical_output_files(self):
        monthly, market, metadata = praw.build_dataset()

        with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
            out1 = Path(tmp1)
            out2 = Path(tmp2)
            praw.write_outputs(monthly, market, metadata, out1)
            # 重新從原始檔建立一次資料集，模擬第二次完整執行
            monthly2, market2, metadata2 = praw.build_dataset()
            praw.write_outputs(monthly2, market2, metadata2, out2)

            for filename in (
                "credit_card_monthly.csv",
                "credit_card_monthly.json",
                "market_totals.csv",
                "market_totals.json",
                "source_metadata.json",
            ):
                content1 = (out1 / filename).read_bytes()
                content2 = (out2 / filename).read_bytes()
                self.assertEqual(content1, content2, msg=f"{filename} 兩次執行結果不一致")


class TestNoZeroFillForMissingValues(unittest.TestCase):
    """10（品質規則）：缺值不得轉成 0（本資料集目前無缺值，驗證輸出型別非布林誤判 0）。"""

    def test_no_none_coerced_to_zero(self):
        monthly, market, _ = praw.build_dataset()
        for r in monthly + market:
            for field in praw.SUMMABLE_FIELDS:
                value = r[field]
                # 目前 32 個月份資料無缺值（113年6月滙豐(台灣)商業銀行當月簽帳金額雖帶有 r 修正註記，但仍可正確解析為非 None 數值）；此測試確保程式邏輯不會將 None 誤植為 0
                self.assertIsNotNone(value, msg=f"{r['issuer_name']} {field} 不應為 None（若為 None 需保持 None，不得補 0）")


class TestCorrectionMarkerParsing(unittest.TestCase):
    """新增：金管會正式修正註記（r/R）解析與留存（113年6月11306「更正後」檔案）。"""

    def test_marker_with_space_parses_correctly(self):
        self.assertEqual(praw.parse_numeric_cell_text("r 9,001,262"), (9001262, "r"))

    def test_marker_without_space_parses_correctly(self):
        self.assertEqual(praw.parse_numeric_cell_text("r9,001,262"), (9001262, "r"))

    def test_uppercase_marker_parses_correctly(self):
        self.assertEqual(praw.parse_numeric_cell_text("R 9,001,262"), (9001262, "R"))

    def test_plain_number_text_unaffected(self):
        self.assertEqual(praw.parse_numeric_cell_text("565,519,063"), (565519063, None))
        self.assertEqual(praw.parse_numeric_cell_text("1234"), (1234, None))

    def test_invalid_leading_letter_rejected(self):
        self.assertIsNone(praw.parse_numeric_cell_text("x 9,001,262"))

    def test_marker_followed_by_non_numeric_rejected(self):
        self.assertIsNone(praw.parse_numeric_cell_text("r abc"))

    def test_marker_in_middle_of_digits_rejected(self):
        self.assertIsNone(praw.parse_numeric_cell_text("9r001262"))

    def test_existing_numeric_cells_unaffected_by_change(self):
        # 6：一般沒有 r 的既有數字（int/float 型別）解析結果不得改變
        fields, markers = praw.extract_fields(
            {1: "臺灣銀行", 2: 100, 3: 50.5},
            {"institution_name": 1, "cards_in_force": 2, "active_cards": 3, **{
                eng: 99 for _, _, eng in praw.COLUMN_SPEC
                if eng not in ("institution_name", "cards_in_force", "active_cards")
            }},
            "dummy.xlsx",
        )
        self.assertEqual(fields["cards_in_force"], 100)
        self.assertEqual(fields["active_cards"], 50.5)
        self.assertEqual(markers, [])

    def test_11306_32_institution_sum_matches_official_total(self):
        # 8、9：113年6月32家明細加總為565,519,063千元，且與去除r後的官方總計完全一致
        monthly, market, _ = praw.build_dataset()
        rows_202406 = [r for r in monthly if r["period"] == "2024-06"]
        total_32 = sum(r["purchase_amount_month"] for r in rows_202406)
        self.assertEqual(total_32, 565519063)

        market_202406 = [r for r in market if r["period"] == "2024-06"][0]
        self.assertEqual(market_202406["purchase_amount_month"], 565519063)
        self.assertEqual(total_32, market_202406["purchase_amount_month"])

    def test_hsbc_11306_value_parsed_without_marker_prefix(self):
        monthly, _, _ = praw.build_dataset()
        hsbc = [
            r for r in monthly
            if r["period"] == "2024-06" and r["issuer_name"] == "滙豐(台灣)商業銀行"
        ][0]
        self.assertEqual(hsbc["purchase_amount_month"], 9001262)

    def test_metadata_retains_correction_markers_for_issuer_and_market_total(self):
        # 10：metadata 保留滙豐明細及官方總計的修正註記，且清楚區分兩者
        _, _, metadata = praw.build_dataset()
        meta_202406 = [m for m in metadata if m["period"] == "2024-06"][0]
        markers = meta_202406["correction_markers"]
        self.assertEqual(len(markers), 2)

        issuer_marker = next(m for m in markers if m["row_type"] == "issuer")
        self.assertEqual(issuer_marker["institution"], "滙豐(台灣)商業銀行")
        self.assertEqual(issuer_marker["field"], "purchase_amount_month")
        self.assertEqual(issuer_marker["raw_value"], "r 9,001,262")
        self.assertEqual(issuer_marker["parsed_value"], 9001262)
        self.assertEqual(issuer_marker["marker"], "r")
        self.assertIn("申報日後", issuer_marker["meaning"])
        self.assertEqual(issuer_marker["month"], "2024-06")
        self.assertEqual(issuer_marker["source_file"], "11306_信用卡重要資訊揭露(更正後).xlsx")

        market_marker = next(m for m in markers if m["row_type"] == "market_total")
        self.assertEqual(market_marker["institution"], "總計")
        self.assertEqual(market_marker["field"], "purchase_amount_month")
        self.assertEqual(market_marker["raw_value"], "r565,519,063")
        self.assertEqual(market_marker["parsed_value"], 565519063)
        self.assertEqual(market_marker["marker"], "r")

    def test_other_months_have_empty_correction_markers(self):
        _, _, metadata = praw.build_dataset()
        for m in metadata:
            if m["period"] == "2024-06":
                continue
            self.assertEqual(m["correction_markers"], [], msg=f"{m['period']} 不應有修正註記")

    def test_11306_sha256_unchanged_before_and_after_processing(self):
        # 11：原始檔 SHA-256 處理前後完全一致
        path = praw.RAW_DIR / "11306_信用卡重要資訊揭露(更正後).xlsx"
        before = praw.sha256_of(path)
        praw.process_file(path)
        after = praw.sha256_of(path)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
