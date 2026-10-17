#!/usr/bin/env python3
"""信用卡市場指標計算程式。

依據：
- CLAUDE.md
- docs/data-dictionary.md
- docs/calculation-rules.md

本程式只讀取 data/processed 既有標準資料
（credit_card_monthly.json、market_totals.json），
不直接讀取或修改 data/raw，也不修改 scripts/process_raw_data.py。

所有計算以未四捨五入的原始值進行；null 不得輸出成 0、空字串、NaN 或 Infinity。
"""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path
from typing import Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"

MONTHLY_INPUT = PROCESSED_DIR / "credit_card_monthly.json"
MARKET_INPUT = PROCESSED_DIR / "market_totals.json"

# ---------------------------------------------------------------------------
# 指標欄位規格（依 docs/calculation-rules.md）
# ---------------------------------------------------------------------------

BASE_FIELDS = [
    "period", "roc_year", "month", "issuer_name_raw", "issuer_name", "issuer_type",
    "institution_name", "cards_in_force", "active_cards", "cards_issued_month",
    "cards_cancelled_month", "revolving_credit_balance", "installment_balance_not_due",
    "purchase_amount_month", "cash_advance_amount_month", "delinquency_ratio_3m",
    "delinquency_ratio_6m", "reserve_coverage_ratio", "charge_off_amount_month",
    "charge_off_amount_ytd", "source_file", "source_sha256",
]

# 可計算月增率／年增率之數量與金額欄位
GROWTH_FIELDS = [
    "cards_in_force", "active_cards", "cards_issued_month", "cards_cancelled_month",
    "revolving_credit_balance", "installment_balance_not_due", "purchase_amount_month",
    "cash_advance_amount_month", "charge_off_amount_month",
]

# 年度累計值：只計算年增率，不計算月增率
YOY_ONLY_FIELDS = ["charge_off_amount_ytd"]

# 比率欄位：計算百分點（pp）差異，不計算一般成長率
RATIO_PP_FIELDS = [
    "delinquency_ratio_3m", "delinquency_ratio_6m", "reserve_coverage_ratio",
    "effective_card_rate_pct",
]

# 市占率：(來源欄位, 輸出欄位名稱)
MARKET_SHARE_SPEC = [
    ("cards_in_force", "cards_in_force_market_share_pct"),
    ("active_cards", "active_cards_market_share_pct"),
    ("purchase_amount_month", "purchase_amount_market_share_pct"),
    ("cards_issued_month", "cards_issued_month_market_share_pct"),
]

# 排名指標（發卡機構排名 32 家、銀行同業排名 30 家，與既有排名規則共用同一套標準競賽排名邏輯）
# 注意：cards_issued_month／cards_issued_ytd 於資訊架構改版階段新增 YTD 累計時，
# 原始實作疏漏將其納入排名與市占率計算清單，導致前端長期顯示「—」；本階段補齊。
RANK_FIELDS = [
    "cards_in_force", "active_cards", "purchase_amount_month", "purchase_amount_ytm",
    "purchase_plus_cash_amount_month", "purchase_plus_cash_amount_ytd",
    "cards_issued_month", "cards_issued_ytd",
    # 比率型／每卡平均型指標：市占率對其無意義（無法計算「比率的市占率」），
    # 但排名（依數值大小排序）仍是有效的比較方式，故僅納入排名、不納入 MARKET_SHARE_SPEC。
    "effective_card_rate_pct", "per_card_spending_month", "per_card_spending_ytd",
    # 總資產為可加總之金額型存量指標，市占率與排名皆有意義（見下方 total_assets_market_share_pct 手動計算）。
    "total_assets",
]

# 金額億元換算欄位（原始單位為新臺幣千元）
AMOUNT_100M_FIELDS = [
    "revolving_credit_balance", "installment_balance_not_due", "purchase_amount_month",
    "cash_advance_amount_month", "charge_off_amount_month", "charge_off_amount_ytd",
]
# 注意：purchase_amount_ytm 為計算欄位（非原始欄位），其億元換算另行處理，
# 不納入上方 AMOUNT_100M_FIELDS（該清單的轉換迴圈直接讀取原始記錄欄位）。

# YTM（年初至今簽帳金額，Year-To-Month）欄位名稱
YTM_FIELD = "purchase_amount_ytm"

# 新增流量型指標之 YTD 累計欄位（來源原始欄位 → 輸出欄位名稱）；計算規則與 YTM 相同
# （每年 1 月重新起算，1 月至當月任一月缺資料即回傳 None）。
YTD_FLOW_FIELD_MAP = {
    "cards_issued_month": "cards_issued_ytd",
    "cash_advance_amount_month": "cash_advance_amount_ytd",
}

# 簽帳金額＋預借現金（合計指標，來源為 H 欄＋I 欄相加）欄位名稱
PURCHASE_PLUS_CASH_MONTH_FIELD = "purchase_plus_cash_amount_month"
PURCHASE_PLUS_CASH_YTD_FIELD = "purchase_plus_cash_amount_ytd"

# 總資產（合計指標，依使用者確認之業務口徑：F 欄循環信用餘額＋G 欄未到期分期付款餘額）。
# 性質為存量（月底時點值），不計算 YTD 累計；YoY 外另計算「較上年12月底（即本年年初）變動」。
TOTAL_ASSETS_FIELD = "total_assets"


# ---------------------------------------------------------------------------
# 計算工具函式
# ---------------------------------------------------------------------------

def prev_month_period(period: str) -> str:
    year, month = map(int, period.split("-"))
    month -= 1
    if month == 0:
        month = 12
        year -= 1
    return f"{year:04d}-{month:02d}"


def prev_year_period(period: str) -> str:
    year, month = map(int, period.split("-"))
    return f"{year - 1:04d}-{month:02d}"


def prev_year_december_period(period: str) -> str:
    """上年12月底（＝本年年初基準點），供存量型指標之「較年初變動」計算使用。"""
    year, _month = map(int, period.split("-"))
    return f"{year - 1:04d}-12"


def safe_growth_pct(current: Optional[float], previous: Optional[float]) -> Optional[float]:
    """(current ÷ previous - 1) × 100；比較期不存在或分母為 0 時回傳 None。"""
    if current is None or previous is None:
        return None
    if previous == 0:
        return None
    return (current / previous - 1) * 100


def safe_pp_diff(current: Optional[float], previous: Optional[float]) -> Optional[float]:
    """百分點差異：current - previous；任一方缺值時回傳 None。"""
    if current is None or previous is None:
        return None
    return current - previous


def safe_ratio_pct(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    """numerator ÷ denominator × 100；分母為 0 或缺值時回傳 None。"""
    if numerator is None or denominator is None:
        return None
    if denominator == 0:
        return None
    return numerator / denominator * 100


def effective_card_rate(record: Optional[dict]) -> Optional[float]:
    if record is None:
        return None
    return safe_ratio_pct(record.get("active_cards"), record.get("cards_in_force"))


def combine_optional(a: Optional[float], b: Optional[float]) -> Optional[float]:
    """兩值相加；任一方為 None 時回傳 None（不得以 0 補值掩蓋缺值）。"""
    if a is None or b is None:
        return None
    return a + b


def compute_ytd_sum(lookup_fn, year: int, month: int, field: str) -> Optional[float]:
    """任一流量型欄位之年初至今累計（YTD）＝該年度 1 月至 month 月之該欄位加總。

    - 每年 1 月重新起算，不得跨年度累加（迴圈固定自 1 月起算，從不往前跨入上一年）。
    - 1 月至 month 月之間任一月份缺資料時，回傳 None，不得自行補值、省略該月或沿用其他月份數字。
    - 內部計算保留原始精度，不在此處四捨五入或轉換單位。
    """
    total = 0
    for m in range(1, month + 1):
        period = f"{year:04d}-{m:02d}"
        rec = lookup_fn(period)
        if rec is None:
            return None
        v = rec.get(field)
        if v is None:
            return None
        total += v
    return total


def compute_ytm_value(lookup_fn, year: int, month: int) -> Optional[float]:
    """YTM（年初至今簽帳金額）＝該年度 1 月至 month 月之『當月簽帳金額』加總。

    來源僅為每月「當月簽帳金額」（purchase_amount_month），不得誤用「當年度轉銷呆帳金額累計」。
    規則細節與 compute_ytd_sum 相同（見其 docstring）。
    """
    return compute_ytd_sum(lookup_fn, year, month, "purchase_amount_month")


def per_card_value(amount_thousand: Optional[float], card_count: Optional[float]) -> Optional[float]:
    """流通卡每卡金額（新臺幣元／張）＝ amount_thousand（新臺幣千元）× 1000 ÷ card_count。

    card_count 缺值或為 0 時回傳 None（不得除以 0）。
    """
    if amount_thousand is None or card_count is None or card_count == 0:
        return None
    return amount_thousand * 1000 / card_count


def standard_competition_rank(values_with_ids: list[tuple[Optional[float], object]]) -> dict:
    """標準競賽排名（1、2、2、4）。數值由大至小；None 值不納入排名。"""
    present = [(v, i) for v, i in values_with_ids if v is not None]
    present.sort(key=lambda x: x[0], reverse=True)
    ranks: dict = {}
    rank = 0
    prev_value = None
    for position, (v, i) in enumerate(present, start=1):
        if v != prev_value:
            rank = position
            prev_value = v
        ranks[i] = rank
    return ranks


# ---------------------------------------------------------------------------
# 資料載入
# ---------------------------------------------------------------------------

def load_json(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def build_issuer_lookup(monthly: list[dict]) -> dict:
    return {(r["issuer_name"], r["period"]): r for r in monthly}


def build_market_lookup(market: list[dict]) -> dict:
    return {r["period"]: r for r in market}


# ---------------------------------------------------------------------------
# 指標計算
# ---------------------------------------------------------------------------

def _apply_growth_and_pp(metrics: dict, current: dict, prev_m: Optional[dict], prev_y: Optional[dict],
                          eff_now: Optional[float], eff_prev_m: Optional[float], eff_prev_y: Optional[float]) -> None:
    for field in GROWTH_FIELDS:
        cur_v = current.get(field)
        prev_m_v = prev_m.get(field) if prev_m else None
        prev_y_v = prev_y.get(field) if prev_y else None
        metrics[f"{field}_mom_pct"] = safe_growth_pct(cur_v, prev_m_v)
        metrics[f"{field}_yoy_pct"] = safe_growth_pct(cur_v, prev_y_v)

    for field in YOY_ONLY_FIELDS:
        cur_v = current.get(field)
        prev_y_v = prev_y.get(field) if prev_y else None
        metrics[f"{field}_yoy_pct"] = safe_growth_pct(cur_v, prev_y_v)

    for field in RATIO_PP_FIELDS:
        if field == "effective_card_rate_pct":
            cur_v, prev_m_v, prev_y_v = eff_now, eff_prev_m, eff_prev_y
        else:
            cur_v = current.get(field)
            prev_m_v = prev_m.get(field) if prev_m else None
            prev_y_v = prev_y.get(field) if prev_y else None
        metrics[f"{field}_mom_pp"] = safe_pp_diff(cur_v, prev_m_v)
        metrics[f"{field}_yoy_pp"] = safe_pp_diff(cur_v, prev_y_v)


def compute_issuer_metrics(monthly: list[dict], market_lookup: dict) -> list[dict]:
    issuer_lookup = build_issuer_lookup(monthly)

    # 市場 YTM／合計 YTD 指標每個期間只需計算一次，供全部機構計算市占率使用
    market_ytm_by_period = {
        period: compute_ytm_value(lambda p: market_lookup.get(p), *map(int, period.split("-")))
        for period in market_lookup
    }
    market_cash_advance_ytd_by_period = {
        period: compute_ytd_sum(lambda p: market_lookup.get(p), *map(int, period.split("-")), "cash_advance_amount_month")
        for period in market_lookup
    }
    market_purchase_plus_cash_ytd_by_period = {
        period: combine_optional(market_ytm_by_period.get(period), market_cash_advance_ytd_by_period.get(period))
        for period in market_lookup
    }
    market_cards_issued_ytd_by_period = {
        period: compute_ytd_sum(lambda p: market_lookup.get(p), *map(int, period.split("-")), "cards_issued_month")
        for period in market_lookup
    }

    out: list[dict] = []

    for r in monthly:
        period = r["period"]
        issuer_name = r["issuer_name"]
        year, month = map(int, period.split("-"))
        prev_m = issuer_lookup.get((issuer_name, prev_month_period(period)))
        prev_y = issuer_lookup.get((issuer_name, prev_year_period(period)))
        market_now = market_lookup.get(period)

        metrics = dict(r)

        eff_now = effective_card_rate(r)
        eff_prev_m = effective_card_rate(prev_m)
        eff_prev_y = effective_card_rate(prev_y)
        metrics["effective_card_rate_pct"] = eff_now

        _apply_growth_and_pp(metrics, r, prev_m, prev_y, eff_now, eff_prev_m, eff_prev_y)

        for src_field, share_field in MARKET_SHARE_SPEC:
            cur_v = r.get(src_field)
            mkt_v = market_now.get(src_field) if market_now else None
            metrics[share_field] = safe_ratio_pct(cur_v, mkt_v)

        for field in AMOUNT_100M_FIELDS:
            v = r.get(field)
            metrics[f"{field}_100m"] = (v / 100000) if v is not None else None

        # YTM（年初至今簽帳金額）：每年 1 月重新起算，不跨年度累加
        issuer_lookup_fn = lambda p, name=issuer_name: issuer_lookup.get((name, p))  # noqa: E731
        ytm_now = compute_ytm_value(issuer_lookup_fn, year, month)
        ytm_prev_year = compute_ytm_value(issuer_lookup_fn, year - 1, month)
        market_ytm_now = market_ytm_by_period.get(period)

        metrics[YTM_FIELD] = ytm_now
        metrics[f"{YTM_FIELD}_yoy_pct"] = safe_growth_pct(ytm_now, ytm_prev_year)
        metrics[f"{YTM_FIELD}_market_share_pct"] = safe_ratio_pct(ytm_now, market_ytm_now)
        metrics[f"{YTM_FIELD}_100m"] = (ytm_now / 100000) if ytm_now is not None else None

        # 新增 YTD 累計欄位（發卡數、預借現金金額）：每年 1 月重新起算
        ytd_values: dict[str, Optional[float]] = {}
        ytd_prev_year_values: dict[str, Optional[float]] = {}
        for src_field, ytd_field in YTD_FLOW_FIELD_MAP.items():
            ytd_now = compute_ytd_sum(issuer_lookup_fn, year, month, src_field)
            ytd_prev_year = compute_ytd_sum(issuer_lookup_fn, year - 1, month, src_field)
            ytd_values[src_field] = ytd_now
            ytd_prev_year_values[src_field] = ytd_prev_year
            metrics[ytd_field] = ytd_now
            metrics[f"{ytd_field}_yoy_pct"] = safe_growth_pct(ytd_now, ytd_prev_year)
        metrics["cash_advance_amount_ytd_100m"] = (
            ytd_values["cash_advance_amount_month"] / 100000
            if ytd_values["cash_advance_amount_month"] is not None else None
        )
        # 發卡數 YTD 市占率（發卡數為張數，無金額單位，不需 100m 換算）
        metrics["cards_issued_ytd_market_share_pct"] = safe_ratio_pct(
            ytd_values["cards_issued_month"], market_cards_issued_ytd_by_period.get(period)
        )

        # 簽帳金額＋預借現金（單月）：H 欄＋I 欄相加，任一方缺值即為 None
        pc_month_now = combine_optional(r.get("purchase_amount_month"), r.get("cash_advance_amount_month"))
        pc_month_prev_m = combine_optional(
            prev_m.get("purchase_amount_month") if prev_m else None,
            prev_m.get("cash_advance_amount_month") if prev_m else None,
        )
        pc_month_prev_y = combine_optional(
            prev_y.get("purchase_amount_month") if prev_y else None,
            prev_y.get("cash_advance_amount_month") if prev_y else None,
        )
        market_pc_month_now = combine_optional(
            market_now.get("purchase_amount_month") if market_now else None,
            market_now.get("cash_advance_amount_month") if market_now else None,
        )
        metrics[PURCHASE_PLUS_CASH_MONTH_FIELD] = pc_month_now
        metrics[f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_mom_pct"] = safe_growth_pct(pc_month_now, pc_month_prev_m)
        metrics[f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_yoy_pct"] = safe_growth_pct(pc_month_now, pc_month_prev_y)
        metrics[f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_100m"] = (pc_month_now / 100000) if pc_month_now is not None else None
        metrics[f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_market_share_pct"] = safe_ratio_pct(pc_month_now, market_pc_month_now)

        # 簽帳金額＋預借現金（YTD）：YTM（簽帳金額YTD）＋預借現金YTD
        cash_advance_ytd_now = ytd_values["cash_advance_amount_month"]
        cash_advance_ytd_prev_year = ytd_prev_year_values["cash_advance_amount_month"]
        pc_ytd_now = combine_optional(ytm_now, cash_advance_ytd_now)
        pc_ytd_prev_year = combine_optional(ytm_prev_year, cash_advance_ytd_prev_year)
        market_pc_ytd_now = market_purchase_plus_cash_ytd_by_period.get(period)
        metrics[PURCHASE_PLUS_CASH_YTD_FIELD] = pc_ytd_now
        metrics[f"{PURCHASE_PLUS_CASH_YTD_FIELD}_yoy_pct"] = safe_growth_pct(pc_ytd_now, pc_ytd_prev_year)
        metrics[f"{PURCHASE_PLUS_CASH_YTD_FIELD}_100m"] = (pc_ytd_now / 100000) if pc_ytd_now is not None else None
        metrics[f"{PURCHASE_PLUS_CASH_YTD_FIELD}_market_share_pct"] = safe_ratio_pct(pc_ytd_now, market_pc_ytd_now)

        # 總資產（存量，月底值）＝ F欄循環信用餘額 ＋ G欄未到期分期付款餘額（依使用者確認之業務口徑）。
        # 不計算 YTD 累計；另計算「較上年12月底（本年年初）變動」，與一般 YoY 意義不同。
        prev_dec = issuer_lookup.get((issuer_name, prev_year_december_period(period)))
        total_assets_now = combine_optional(r.get("revolving_credit_balance"), r.get("installment_balance_not_due"))
        total_assets_prev_m = combine_optional(
            prev_m.get("revolving_credit_balance") if prev_m else None,
            prev_m.get("installment_balance_not_due") if prev_m else None,
        )
        total_assets_prev_y = combine_optional(
            prev_y.get("revolving_credit_balance") if prev_y else None,
            prev_y.get("installment_balance_not_due") if prev_y else None,
        )
        total_assets_prev_dec = combine_optional(
            prev_dec.get("revolving_credit_balance") if prev_dec else None,
            prev_dec.get("installment_balance_not_due") if prev_dec else None,
        )
        metrics[TOTAL_ASSETS_FIELD] = total_assets_now
        metrics[f"{TOTAL_ASSETS_FIELD}_mom_pct"] = safe_growth_pct(total_assets_now, total_assets_prev_m)
        metrics[f"{TOTAL_ASSETS_FIELD}_yoy_pct"] = safe_growth_pct(total_assets_now, total_assets_prev_y)
        metrics[f"{TOTAL_ASSETS_FIELD}_ytd_change_pct"] = safe_growth_pct(total_assets_now, total_assets_prev_dec)
        metrics[f"{TOTAL_ASSETS_FIELD}_100m"] = (total_assets_now / 100000) if total_assets_now is not None else None
        # 總資產為可加總金額（非比率），市占率計算有意義；市場總資產＝市場合計列循環信用餘額＋未到期分期付款餘額。
        market_total_assets_now = combine_optional(
            market_now.get("revolving_credit_balance") if market_now else None,
            market_now.get("installment_balance_not_due") if market_now else None,
        )
        metrics[f"{TOTAL_ASSETS_FIELD}_market_share_pct"] = safe_ratio_pct(total_assets_now, market_total_assets_now)

        # 流通卡每卡簽帳金額（不含預借現金）：單月與 YTD，皆除以「當月」流通卡數
        per_card_month_now = per_card_value(r.get("purchase_amount_month"), r.get("cards_in_force"))
        per_card_month_prev_y = per_card_value(
            prev_y.get("purchase_amount_month") if prev_y else None,
            prev_y.get("cards_in_force") if prev_y else None,
        )
        metrics["per_card_spending_month"] = per_card_month_now
        metrics["per_card_spending_month_yoy_pct"] = safe_growth_pct(per_card_month_now, per_card_month_prev_y)

        per_card_ytd_now = per_card_value(ytm_now, r.get("cards_in_force"))
        per_card_ytd_prev_y = per_card_value(
            ytm_prev_year,
            prev_y.get("cards_in_force") if prev_y else None,
        )
        metrics["per_card_spending_ytd"] = per_card_ytd_now
        metrics["per_card_spending_ytd_yoy_pct"] = safe_growth_pct(per_card_ytd_now, per_card_ytd_prev_y)

        out.append(metrics)

    _assign_ranks(out)
    return out


def _assign_ranks(records: list[dict]) -> None:
    """依期間分組，計算 32 家發卡機構排名（issuer_rank）與 30 家銀行排名（bank_rank）。
    非銀行發卡機構的 bank_rank 恆為 None。主要同業名單（未來若設定）不影響此排名母體。"""
    periods = sorted({r["period"] for r in records})
    for period in periods:
        period_records = [r for r in records if r["period"] == period]
        bank_records = [r for r in period_records if r["issuer_type"] == "bank"]
        for field in RANK_FIELDS:
            issuer_ranks = standard_competition_rank([(r.get(field), id(r)) for r in period_records])
            bank_ranks = standard_competition_rank([(r.get(field), id(r)) for r in bank_records])
            for r in period_records:
                r[f"{field}_issuer_rank"] = issuer_ranks.get(id(r))
                r[f"{field}_bank_rank"] = bank_ranks.get(id(r)) if r["issuer_type"] == "bank" else None


def compute_market_metrics(market: list[dict]) -> list[dict]:
    lookup = build_market_lookup(market)
    out: list[dict] = []

    for r in market:
        period = r["period"]
        year, month = map(int, period.split("-"))
        prev_m = lookup.get(prev_month_period(period))
        prev_y = lookup.get(prev_year_period(period))

        metrics = dict(r)

        eff_now = effective_card_rate(r)
        eff_prev_m = effective_card_rate(prev_m)
        eff_prev_y = effective_card_rate(prev_y)
        metrics["effective_card_rate_pct"] = eff_now

        _apply_growth_and_pp(metrics, r, prev_m, prev_y, eff_now, eff_prev_m, eff_prev_y)

        for field in AMOUNT_100M_FIELDS:
            v = r.get(field)
            metrics[f"{field}_100m"] = (v / 100000) if v is not None else None

        # YTM（年初至今簽帳金額）：市場 YTM＝當年度截至該月之官方合計「當月簽帳金額」加總，
        # 依規則等於 32 家發卡機構 YTM 之加總（見 tests 驗證）。每年 1 月重新起算。
        market_lookup_fn = lambda p: lookup.get(p)  # noqa: E731
        ytm_now = compute_ytm_value(market_lookup_fn, year, month)
        ytm_prev_year = compute_ytm_value(market_lookup_fn, year - 1, month)

        metrics[YTM_FIELD] = ytm_now
        metrics[f"{YTM_FIELD}_yoy_pct"] = safe_growth_pct(ytm_now, ytm_prev_year)
        metrics[f"{YTM_FIELD}_100m"] = (ytm_now / 100000) if ytm_now is not None else None

        # 新增 YTD 累計欄位（發卡數、預借現金金額）：每年 1 月重新起算
        ytd_values: dict[str, Optional[float]] = {}
        for src_field, ytd_field in YTD_FLOW_FIELD_MAP.items():
            ytd_now = compute_ytd_sum(market_lookup_fn, year, month, src_field)
            ytd_prev_year = compute_ytd_sum(market_lookup_fn, year - 1, month, src_field)
            ytd_values[src_field] = ytd_now
            metrics[ytd_field] = ytd_now
            metrics[f"{ytd_field}_yoy_pct"] = safe_growth_pct(ytd_now, ytd_prev_year)
        metrics["cash_advance_amount_ytd_100m"] = (
            ytd_values["cash_advance_amount_month"] / 100000
            if ytd_values["cash_advance_amount_month"] is not None else None
        )

        # 簽帳金額＋預借現金（單月）：H 欄＋I 欄相加，任一方缺值即為 None
        pc_month_now = combine_optional(r.get("purchase_amount_month"), r.get("cash_advance_amount_month"))
        pc_month_prev_m = combine_optional(
            prev_m.get("purchase_amount_month") if prev_m else None,
            prev_m.get("cash_advance_amount_month") if prev_m else None,
        )
        pc_month_prev_y = combine_optional(
            prev_y.get("purchase_amount_month") if prev_y else None,
            prev_y.get("cash_advance_amount_month") if prev_y else None,
        )
        metrics[PURCHASE_PLUS_CASH_MONTH_FIELD] = pc_month_now
        metrics[f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_mom_pct"] = safe_growth_pct(pc_month_now, pc_month_prev_m)
        metrics[f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_yoy_pct"] = safe_growth_pct(pc_month_now, pc_month_prev_y)
        metrics[f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_100m"] = (pc_month_now / 100000) if pc_month_now is not None else None

        # 簽帳金額＋預借現金（YTD）：YTM（簽帳金額YTD）＋預借現金YTD
        cash_advance_ytd_now = ytd_values["cash_advance_amount_month"]
        cash_advance_ytd_prev_year = compute_ytd_sum(market_lookup_fn, year - 1, month, "cash_advance_amount_month")
        pc_ytd_now = combine_optional(ytm_now, cash_advance_ytd_now)
        pc_ytd_prev_year = combine_optional(ytm_prev_year, cash_advance_ytd_prev_year)
        metrics[PURCHASE_PLUS_CASH_YTD_FIELD] = pc_ytd_now
        metrics[f"{PURCHASE_PLUS_CASH_YTD_FIELD}_yoy_pct"] = safe_growth_pct(pc_ytd_now, pc_ytd_prev_year)
        metrics[f"{PURCHASE_PLUS_CASH_YTD_FIELD}_100m"] = (pc_ytd_now / 100000) if pc_ytd_now is not None else None

        # 總資產（存量，月底值）＝ F欄循環信用餘額 ＋ G欄未到期分期付款餘額（依使用者確認之業務口徑）。
        # 不計算 YTD 累計；另計算「較上年12月底（本年年初）變動」，與一般 YoY 意義不同。
        prev_dec = lookup.get(prev_year_december_period(period))
        total_assets_now = combine_optional(r.get("revolving_credit_balance"), r.get("installment_balance_not_due"))
        total_assets_prev_m = combine_optional(
            prev_m.get("revolving_credit_balance") if prev_m else None,
            prev_m.get("installment_balance_not_due") if prev_m else None,
        )
        total_assets_prev_y = combine_optional(
            prev_y.get("revolving_credit_balance") if prev_y else None,
            prev_y.get("installment_balance_not_due") if prev_y else None,
        )
        total_assets_prev_dec = combine_optional(
            prev_dec.get("revolving_credit_balance") if prev_dec else None,
            prev_dec.get("installment_balance_not_due") if prev_dec else None,
        )
        metrics[TOTAL_ASSETS_FIELD] = total_assets_now
        metrics[f"{TOTAL_ASSETS_FIELD}_mom_pct"] = safe_growth_pct(total_assets_now, total_assets_prev_m)
        metrics[f"{TOTAL_ASSETS_FIELD}_yoy_pct"] = safe_growth_pct(total_assets_now, total_assets_prev_y)
        metrics[f"{TOTAL_ASSETS_FIELD}_ytd_change_pct"] = safe_growth_pct(total_assets_now, total_assets_prev_dec)
        metrics[f"{TOTAL_ASSETS_FIELD}_100m"] = (total_assets_now / 100000) if total_assets_now is not None else None

        # 流通卡每卡簽帳金額（不含預借現金）：單月與 YTD，皆除以「當月」流通卡數
        per_card_month_now = per_card_value(r.get("purchase_amount_month"), r.get("cards_in_force"))
        per_card_month_prev_y = per_card_value(
            prev_y.get("purchase_amount_month") if prev_y else None,
            prev_y.get("cards_in_force") if prev_y else None,
        )
        metrics["per_card_spending_month"] = per_card_month_now
        metrics["per_card_spending_month_yoy_pct"] = safe_growth_pct(per_card_month_now, per_card_month_prev_y)

        per_card_ytd_now = per_card_value(ytm_now, r.get("cards_in_force"))
        per_card_ytd_prev_y = per_card_value(
            ytm_prev_year,
            prev_y.get("cards_in_force") if prev_y else None,
        )
        metrics["per_card_spending_ytd"] = per_card_ytd_now
        metrics["per_card_spending_ytd_yoy_pct"] = safe_growth_pct(per_card_ytd_now, per_card_ytd_prev_y)

        out.append(metrics)

    return out


# ---------------------------------------------------------------------------
# 輸出
# ---------------------------------------------------------------------------

def _new_derived_field_block() -> list[str]:
    """113年YoY基期階段後新增之指標（發卡數YTD、預借現金YTD、簽帳金額＋預借現金、
    流通卡每卡簽帳金額），issuer 與 market 兩份輸出共用同一順序。"""
    fields: list[str] = []
    for _, ytd_field in YTD_FLOW_FIELD_MAP.items():
        fields.append(ytd_field)
        fields.append(f"{ytd_field}_yoy_pct")
    fields.append("cash_advance_amount_ytd_100m")
    fields.append(PURCHASE_PLUS_CASH_MONTH_FIELD)
    fields.append(f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_mom_pct")
    fields.append(f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_yoy_pct")
    fields.append(f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_100m")
    fields.append(PURCHASE_PLUS_CASH_YTD_FIELD)
    fields.append(f"{PURCHASE_PLUS_CASH_YTD_FIELD}_yoy_pct")
    fields.append(f"{PURCHASE_PLUS_CASH_YTD_FIELD}_100m")
    fields.append(TOTAL_ASSETS_FIELD)
    fields.append(f"{TOTAL_ASSETS_FIELD}_mom_pct")
    fields.append(f"{TOTAL_ASSETS_FIELD}_yoy_pct")
    fields.append(f"{TOTAL_ASSETS_FIELD}_ytd_change_pct")
    fields.append(f"{TOTAL_ASSETS_FIELD}_100m")
    fields.append("per_card_spending_month")
    fields.append("per_card_spending_month_yoy_pct")
    fields.append("per_card_spending_ytd")
    fields.append("per_card_spending_ytd_yoy_pct")
    return fields


def issuer_fieldnames() -> list[str]:
    fields = list(BASE_FIELDS)
    fields.append("effective_card_rate_pct")
    # YTM（年初至今簽帳金額）：計算欄位，置於原始欄位之後、其餘衍生指標之前
    fields.append(YTM_FIELD)
    for f in GROWTH_FIELDS:
        fields.append(f"{f}_mom_pct")
        fields.append(f"{f}_yoy_pct")
    for f in YOY_ONLY_FIELDS:
        fields.append(f"{f}_yoy_pct")
    fields.append(f"{YTM_FIELD}_yoy_pct")
    for f in RATIO_PP_FIELDS:
        fields.append(f"{f}_mom_pp")
        fields.append(f"{f}_yoy_pp")
    fields.extend(_new_derived_field_block())
    for _, share_field in MARKET_SHARE_SPEC:
        fields.append(share_field)
    fields.append(f"{YTM_FIELD}_market_share_pct")
    fields.append(f"{PURCHASE_PLUS_CASH_MONTH_FIELD}_market_share_pct")
    fields.append(f"{PURCHASE_PLUS_CASH_YTD_FIELD}_market_share_pct")
    fields.append("cards_issued_ytd_market_share_pct")
    fields.append(f"{TOTAL_ASSETS_FIELD}_market_share_pct")
    for f in RANK_FIELDS:
        fields.append(f"{f}_issuer_rank")
        fields.append(f"{f}_bank_rank")
    for f in AMOUNT_100M_FIELDS:
        fields.append(f"{f}_100m")
    fields.append(f"{YTM_FIELD}_100m")
    return fields


def market_fieldnames() -> list[str]:
    fields = list(BASE_FIELDS)
    fields.append("effective_card_rate_pct")
    fields.append(YTM_FIELD)
    for f in GROWTH_FIELDS:
        fields.append(f"{f}_mom_pct")
        fields.append(f"{f}_yoy_pct")
    for f in YOY_ONLY_FIELDS:
        fields.append(f"{f}_yoy_pct")
    fields.append(f"{YTM_FIELD}_yoy_pct")
    for f in RATIO_PP_FIELDS:
        fields.append(f"{f}_mom_pp")
        fields.append(f"{f}_yoy_pp")
    fields.extend(_new_derived_field_block())
    for f in AMOUNT_100M_FIELDS:
        fields.append(f"{f}_100m")
    fields.append(f"{YTM_FIELD}_100m")
    return fields


def _clean(value):
    """null 不得輸出成 NaN 或 Infinity；一律轉為 None。"""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _ordered(records: list[dict], fieldnames: list[str]) -> list[dict]:
    return [{k: _clean(r.get(k)) for k in fieldnames} for r in records]


def write_csv(records: list[dict], path: Path, fieldnames: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in records:
            row = {k: ("" if r.get(k) is None else r.get(k)) for k in fieldnames}
            writer.writerow(row)


def write_json(records: list[dict], path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
        f.write("\n")


def build_all_metrics() -> tuple[list[dict], list[dict]]:
    monthly = load_json(MONTHLY_INPUT)
    market = load_json(MARKET_INPUT)
    market_lookup = build_market_lookup(market)

    issuer_metrics = compute_issuer_metrics(monthly, market_lookup)
    market_metrics = compute_market_metrics(market)
    return issuer_metrics, market_metrics


def write_outputs(issuer_metrics: list[dict], market_metrics: list[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    issuer_fields = issuer_fieldnames()
    market_fields = market_fieldnames()

    issuer_ordered = _ordered(issuer_metrics, issuer_fields)
    market_ordered = _ordered(market_metrics, market_fields)

    write_csv(issuer_ordered, out_dir / "issuer_metrics.csv", issuer_fields)
    write_json(issuer_ordered, out_dir / "issuer_metrics.json")
    write_csv(market_ordered, out_dir / "market_metrics.csv", market_fields)
    write_json(market_ordered, out_dir / "market_metrics.json")


def main() -> int:
    if not MONTHLY_INPUT.exists() or not MARKET_INPUT.exists():
        print(
            "[錯誤] 找不到 data/processed 標準資料，請先執行 scripts/process_raw_data.py",
            file=sys.stderr,
        )
        return 1

    issuer_metrics, market_metrics = build_all_metrics()
    write_outputs(issuer_metrics, market_metrics, PROCESSED_DIR)

    print(
        f"指標計算完成：issuer_metrics {len(issuer_metrics)} 筆、"
        f"market_metrics {len(market_metrics)} 筆。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
