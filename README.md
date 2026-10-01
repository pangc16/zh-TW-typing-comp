# 中文打字競速

多人連線的中文打字競速網站。開房間、分享連結、朋友加入，同步倒數後一起打同一篇文章，
依完成時間排名。不需要註冊帳號，瀏覽器就能玩。

線上版本：<https://zh-tw-typing-comp.onrender.com>

## 遊戲規則

- 所有玩家打同一篇文章
- **必須完全打對才算完成**，所以正確率永遠是 100%，排名直接比時間
- 只看最終結果：過程中打錯再用 Backspace 改掉，不扣分
- 速度以 CPM（字/分鐘）呈現
- 半形標點（`,` `.` `!` `?`）會自動視為對應的全形標點，空白與換行一律忽略
- 第一名完成後，其他人還有 60 秒追趕時間，時間到強制結算
- 未完成的玩家排在完成者之後，依進度（連續正確字數）多寡排序

## 本機開發

第一次要先建虛擬環境並安裝套件：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

之後每次啟動：

```powershell
.\.venv\Scripts\python.exe -m uvicorn server.main:app --reload
```

開 <http://127.0.0.1:8000>。`--reload` 會在改完程式碼後自動重啟。
要測多人就開好幾個分頁 —— 身分存在 `sessionStorage`，每個分頁是獨立的玩家。

## 部署

程式碼推上 GitHub 之後，Render 會自動偵測並重新部署：

```powershell
git add .
git commit -m "說明這次改了什麼"
git push
```

Render 上的設定：

| 欄位 | 值 |
| --- | --- |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn server.main:app --host 0.0.0.0 --port $PORT` |

`--host 0.0.0.0` 和 `--port $PORT` 都是必要的：容器裡必須聽所有來源，
而 port 號由平台透過環境變數指定，不能寫死。

免費方案閒置 15 分鐘會休眠，下一個人連進來要等約 30 秒冷啟動。

## 檔案結構

```
server/
  main.py      FastAPI 進入點，WebSocket 收發與訊息分派
  rooms.py     房間／玩家狀態機：加入、斷線重連、房主交棒、比賽流程
  scoring.py   正規化、進度計算、完成判定、CPM
  texts.py     讀取內建文章庫
  config.py    所有可調參數
data/
  articles.txt 內建文章，純文字檔
static/
  index.html   四個畫面：進入、Lobby、比賽、結果
  app.js       連線、自動重連、IME 處理、畫面渲染
  style.css    樣式（支援淺色／深色模式）
```

房間狀態全部放在記憶體，所以伺服器重啟時所有房間會消失，而且只能跑單一個 process。
第一版夠用，要擴充再換 Redis。

## 增減文章與分類

編輯 `data/articles.txt`：

```
== 古文15 ==
---
第一篇文章…
---
第二篇文章…

== 白話文 ==
---
第一篇文章…
```

- `== 名稱 ==` 開一個新分類，房主在 Lobby 可以從下拉選單挑
- 同一分類裡，每篇文章之間用一行 `---` 分隔
- 以 `#` 開頭的行是註解
- 一篇文章可以斷成好幾行寫，載入時會自動接成一整段
- 標點請用全形，建議長度約 100 字

還沒有文章、只想先在選單裡預告的分類，寫在 `server/config.py` 的
`UPCOMING_CATEGORIES`，會顯示成不可選的項目。等真的寫好文章就把它從那裡刪掉。

改完 `git push` 就會生效。注意本機開發時 `--reload` 只監看 `.py` 檔，
改完文章要手動重啟伺服器。

## 調整規則

全部集中在 `server/config.py`：房間人數上限、倒數秒數、追趕時間、
斷線寬限秒數、自訂文章長度限制。
