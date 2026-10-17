# scripts

存放資料下載、清理、驗證與轉換程式。

## 規則

- 程式應將 `data/raw` 的原始資料轉換為 `data/processed` 可用的格式，且不得修改 `data/raw` 內的原始檔。
- 所有指標（如月增率、年增率、排名、市占率、有效卡率等）須由程式計算，不可手動寫死數值。
- 程式應具備基本驗證邏輯，於資料缺漏、格式異常或口徑不明時明確標示，而非自行補齊或推估。
- 未來新增每月資料時，應可重複執行相同流程完成更新。

## Python 虛擬環境

本專案使用 `.venv`（已被 `.gitignore` 忽略，不納入版本控制）。

**啟用虛擬環境（Windows PowerShell）：**

```powershell
.venv\Scripts\Activate.ps1
```

**啟用虛擬環境（Git Bash）：**

```bash
source .venv/Scripts/activate
```

若尚未建立虛擬環境，於專案根目錄執行：

```powershell
python -m venv .venv
```

**安裝 requirements.txt：**

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 執行資料處理程式

於專案根目錄執行：

```powershell
.venv\Scripts\python.exe scripts\process_raw_data.py
```

程式會：
1. 讀取 `data/raw` 內所有 `.xlsx` 附表五檔案（忽略 `README.md`、`.zip`、`.ods` 及以 `~$` 開頭的 Excel 暫存檔）。
2. 逐檔驗證資料年月、欄位名稱、機構名單、加總一致性等（詳見程式內 `ValidationError` 相關邏輯與 `docs/calculation-rules.md` 第 12 項）。
3. 全部驗證通過後，於 `data/processed` 產生 5 個標準化輸出檔案。
4. 任一驗證失敗時，**不會輸出任何檔案**，並在終端機顯示清楚的錯誤訊息，結束代碼為非 0。

## 執行 unittest

於專案根目錄執行：

```powershell
.venv\Scripts\python.exe -m unittest discover -s tests -v
```

測試會直接使用 `data/raw` 內三個月份的真實原始檔進行驗證，包含年月辨識、筆數、機構家數、遠東國際商業銀行資料、SHA-256 完整性、連續執行兩次結果一致性等；同一指令會一併執行 `tests/test_calculate_metrics.py`（詳見下方「執行指標計算程式」）。

## 執行指標計算程式

於專案根目錄執行：

```powershell
.venv\Scripts\python.exe scripts\calculate_metrics.py
```

程式只讀取 `data/processed` 內既有的 `credit_card_monthly.json` 與 `market_totals.json`（**不會讀取或修改 `data/raw`**，也不會修改 `scripts/process_raw_data.py`），計算月增率、年增率、百分點差異、市占率、排名與億元換算後，於 `data/processed` 產生 4 個指標輸出檔案。若找不到 `credit_card_monthly.json` 或 `market_totals.json`，會提示先執行 `scripts\process_raw_data.py`。

## 輸出檔案說明

| 檔案 | 用途 |
|---|---|
| `data/processed/credit_card_monthly.csv` | 32 家發卡機構逐月明細（UTF-8 with BOM，供 Windows Excel 開啟中文不亂碼），三個月份共 96 筆 |
| `data/processed/credit_card_monthly.json` | 與 CSV 相同的 96 筆標準資料（UTF-8，中文不轉義） |
| `data/processed/market_totals.csv` | 每月官方合計列（「總計」），三個月份共 3 筆 |
| `data/processed/market_totals.json` | 與 CSV 相同的 3 筆市場合計資料 |
| `data/processed/source_metadata.json` | 每個月份的來源檔名、SHA-256、工作表名稱、單位說明、機構家數、驗證狀態等中繼資料 |
| `data/processed/issuer_metrics.csv` | 32 家發卡機構逐月指標（有效卡率、月增率、年增率、比率 pp 差異、市占率、排名、金額億元欄位），三個月份共 96 筆 |
| `data/processed/issuer_metrics.json` | 與 CSV 相同的 96 筆指標資料（UTF-8，中文不轉義） |
| `data/processed/market_metrics.csv` | 每月官方市場總值指標（市場有效卡率、月增率、年增率、比率 pp 差異、金額億元欄位），三個月份共 3 筆 |
| `data/processed/market_metrics.json` | 與 CSV 相同的 3 筆市場指標資料 |

## 指標計算說明（月增率、年增率、pp、市占率、排名範圍）

- **月增率（`_mom_pct`）／年增率（`_yoy_pct`）**：僅適用於數量與金額欄位（流通卡數、有效卡數、當月發卡數、當月停卡數、循環信用餘額、未到期分期付款餘額、當月簽帳金額、當月預借現金金額、當月轉銷呆帳金額）。公式為 `(本期 ÷ 比較期 - 1) × 100`，比較期必須是資料集中「真正存在」的前一曆月或去年同月，**不得以其他月份頂替**。
- **年度累計轉銷呆帳金額（`charge_off_amount_ytd`）**：只計算 `charge_off_amount_ytd_yoy_pct`（與去年同月累計數比較），**不產生 `_mom_pct`**，因累計值的「月差」不具備一般流量成長率意義。
- **百分點差異（`_mom_pp` / `_yoy_pp`）**：適用於本身已是百分比的欄位——逾期三個月以上比率（`delinquency_ratio_3m`）、逾期六個月以上比率（`delinquency_ratio_6m`）、備抵呆帳提足率（`reserve_coverage_ratio`）、有效卡率（`effective_card_rate_pct`）。這些欄位**不產生一般成長率欄位（`_mom_pct`/`_yoy_pct`）**，只計算「本期百分比值 - 比較期百分比值」的差，單位為 pp（百分點），不得寫成 %。
- **市占率（`_market_share_pct`）**：僅對 `issuer_metrics` 計算，分母一律取自**同一期間的官方 `market_totals` 合計列**，包含流通卡數市占率、有效卡數市占率、當月簽帳金額市占率（欄位名為 `purchase_amount_market_share_pct`）。
- **排名範圍**：僅對流通卡數、有效卡數、當月簽帳金額三個指標建立排名，每個指標各有兩種：
  - `{欄位}_issuer_rank`：以**全部 32 家發卡機構**（30 家銀行＋2 家非銀行發卡機構）為排名母體。
  - `{欄位}_bank_rank`：以**全部 30 家銀行**為排名母體；**非銀行發卡機構的 `bank_rank` 恆為 `null`**，因其不屬於銀行同業比較範圍。
  - 兩種排名皆由大至小、採標準競賽排名（同值同名次，如 1、2、2、4），未來若設定「主要同業名單」僅供篩選或醒目標示，**不會影響排名母體**（詳見 `docs/calculation-rules.md` 第 3、9 項）。

## 為何缺少比較月份時顯示 null

月增率／年增率／pp 差異的計算，要求資料集中**實際存在**對應的前一曆月或去年同月資料。目前 `data/processed` 僅有 2025-07、2026-06、2026-07 三個月份：
- 2025-07 的前一曆月（2025-06）與去年同月（2024-07）皆不存在 → 相關月增率／年增率為 `null`。
- 2026-06 的前一曆月（2026-05）與去年同月（2025-06）皆不存在 → 相關月增率／年增率為 `null`。
- 2026-07 的前一曆月（2026-06）與去年同月（2025-07）皆存在於資料集中 → 可正常計算。

程式**不會**以其他非連續月份的資料頂替缺少的比較期，以避免產生誤導性的成長率。未來每新增一個月資料，可比較的期間會自動增加。

## 為何非銀行發卡機構沒有 bank_rank

「銀行同業比較範圍」依 `docs/calculation-rules.md` 第 3 項規則，僅納入 30 家銀行；「台灣樂天信用卡股份有限公司」「台灣美國運通國際(股)公司」為非銀行發卡機構，不屬於銀行同業比較的排名母體，因此其 `bank_rank` 一律輸出為 `null`（而非 0 或排在最後一名），避免被誤解為「排名吊車尾的銀行」。這兩家機構仍會被納入 `issuer_rank`（32 家發卡機構排名）與整體市場統計。

## 新月份資料應放在哪裡

將金管會新下載的附表五 `.xlsx` 檔案放入 `data/raw`（原始 ZIP、ODS 可一併保留於同資料夾，程式會自動略過），**不得修改檔名內的年月數字或覆寫既有檔案**。接著依序執行：

```powershell
.venv\Scripts\python.exe scripts\process_raw_data.py
.venv\Scripts\python.exe scripts\calculate_metrics.py
```

`process_raw_data.py` 會自動納入新檔案並重新產生 `data/processed` 內的標準化輸出；`calculate_metrics.py` 則會基於最新的標準化資料重新計算月增率、年增率、排名等指標。

## 常見錯誤如何判讀

程式發生錯誤時會印出以「[錯誤]」開頭的訊息並以非 0 狀態結束，此時 `data/processed` 不會被覆寫：

| 錯誤訊息關鍵字 | 可能原因 | 處理方式 |
|---|---|---|
| 無法從工作表內容辨識資料年月 | 原始檔內找不到「ＸＸＸ年ＸＸ月」文字 | 確認原始檔是否為正確的附表五格式 |
| 無法從檔名辨識資料年月 | 檔名不符合既有兩種命名規則 | 確認檔名格式（如 `11407_...xlsx` 或含「115年7月」字樣） |
| 工作表年月與檔名年月不一致 | 檔名與內容標示的月份對不上 | 確認下載檔案是否放錯月份，或檔名是否手動改錯 |
| 表頭欄位比對失敗，缺少以下標準欄位 | 原始檔表頭文字與 `docs/data-dictionary.md` 記錄不同 | 確認金管會格式是否變更，需更新 `docs/data-dictionary.md` 與程式對照表 |
| 發卡機構筆數為 X，預期 32 家 | 機構筆數不符 | 確認原始檔機構名單是否有增減，需與使用者確認是否更新正式機構名單 |
| 銀行/非銀行發卡機構家數不符 | 機構分類與預期（30／2）不同 | 確認是否有新機構加入或名稱變更，需更新 `BANK_NAMES`／`NON_BANK_ISSUER_NAMES` |
| 「遠東國際商業銀行」出現 X 次 | 找不到或重複出現遠銀資料 | 確認原始檔機構名稱欄位是否正確 |
| 機構名稱重複出現 | 同一機構在同月出現兩次 | 確認原始檔是否有異常重複列 |
| 找不到官方合計列（總計） | 找不到「總計」列 | 確認原始檔「總計」列是否存在或文字是否變更 |
| 32 家發卡機構明細加總與官方合計列不一致 | 加總與官方合計不符（資料異常） | 依訊息列出的欄位與差額回報使用者，**不得自行修改任何數字** |
| 處理前後 SHA-256 不一致 | 原始檔在處理過程中被修改 | 確認是否有其他程式或防毒軟體正在存取該檔案 |
| 欄位 X 出現無法解析為數字的文字內容 | 數值欄位混入文字 | 檢查原始檔該儲存格內容，回報資料提供單位 |
