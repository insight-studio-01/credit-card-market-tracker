# 信用卡市場追蹤與分析網站

本專案為信用卡市場追蹤與分析網站，主要使用者為遠東商銀主管及信用卡業務分析人員，
用以掌握信用卡市場現況、遠東商銀之市場定位、同業比較與歷史趨勢。

## 資料來源

主要資料來源為金管會銀行局每月公布之信用卡業務統計附表五。

## 資料夾結構

```
信用卡市場追蹤/
├─ index.html           # 網站首頁（純 HTML／CSS／JavaScript 儀表板）
├─ assets/
│  ├─ css/styles.css    # 樣式表
│  └─ js/app.js         # 前端邏輯（讀取 data/processed 的 JSON）
├─ data/
│  ├─ raw/              # 金管會下載的原始檔，不修改原檔
│  └─ processed/        # 清理後、供網站讀取的標準資料與指標結果
├─ scripts/             # 資料下載、清理、驗證與轉換程式
├─ tests/                # Python unittest 測試
├─ docs/                # 需求、欄位定義、計算口徑與資料來源說明
├─ CLAUDE.md            # Claude Code 的固定工作規則
└─ README.md            # 專案總說明
```

## 專案規則

本專案的開發規則詳見 [CLAUDE.md](./CLAUDE.md)。
專案需求與待確認事項詳見 [docs/project-requirements.md](./docs/project-requirements.md)。

## 在本機預覽網站

`index.html` 以 `fetch()` 讀取 `data/processed/issuer_metrics.json` 與 `data/processed/market_metrics.json`。若直接以瀏覽器開啟本機檔案（`file://...`），部分瀏覽器基於安全性限制會**封鎖本機 JSON 讀取**，導致頁面顯示「無法讀取 data/processed 標準資料」的錯誤訊息。

請改用 Python 內建的 HTTP 伺服器預覽（不需安裝任何套件）：

```powershell
.venv\Scripts\python.exe -m http.server 8000
```

接著在瀏覽器開啟：

```
http://localhost:8000
```

（若尚未建立 `.venv`，請先參考 [scripts/README.md](./scripts/README.md) 建立虛擬環境；只要系統已安裝 Python，也可直接使用系統 Python 執行 `python -m http.server 8000`。）

網站預設顯示資料集中**最新月份**，可透過頁首的「資料月份」選單切換至其他已收錄月份。若要更新網站資料，請先依 [scripts/README.md](./scripts/README.md) 的說明依序執行 `scripts/process_raw_data.py` 與 `scripts/calculate_metrics.py`，重新整理瀏覽器頁面即可看到最新結果。

## 測試

```powershell
.venv\Scripts\python.exe -m unittest discover -s tests -v
node tests/test_frontend_logic.js
```

## 目前狀態

第一版靜態網頁儀表板已建立，涵蓋整體市場摘要、遠東國際商業銀行摘要與排名、三個月份趨勢比較、發卡機構排名表。後續階段將視需求擴充更多頁面與功能。
