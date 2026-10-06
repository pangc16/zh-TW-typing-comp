"""遊戲設定值。想調整規則就改這裡，不用翻程式碼。"""

# 版本號：每次發布新版就改這裡，網頁標題旁與開發者專區都會跟著顯示
VERSION = "0.3.0"


# ---------- 介面設計 ----------

# 可以選的設計：名稱 → 說明。classic 是 style.css 本身，其他的是 static/designs/ 底下的樣式檔
DESIGNS = {
    "timing": "賽事計時看板",
    "classic": "原始版",
}

# 所有玩家看到的設計。開發者專區可以即時切換，但伺服器重啟後會回到這裡的值
SITE_DESIGN = "timing"


# ---------- 房間 ----------

# 一間房間最多幾人
MAX_PLAYERS = 8

# 暱稱長度上限
MAX_NICKNAME_LENGTH = 12

# 房號長度
ROOM_CODE_LENGTH = 4

# 玩家斷線後，保留身分等他重連的秒數；超過才真正移除
RECONNECT_GRACE_SECONDS = 30

# 房間空了之後，延遲多久才回收（避免房主只是重整網頁就把房間弄掉）
EMPTY_ROOM_TTL_SECONDS = 60


# ---------- 比賽 ----------

# 按下開始後的同步倒數秒數
COUNTDOWN_SECONDS = 3

# 自訂文章的長度限制（正規化後的字數）
MIN_TEXT_LENGTH = 10
MAX_TEXT_LENGTH = 400


# ---------- 文章分類 ----------

# 還沒有文章的分類。會出現在 Lobby 的選單裡但不能選，純粹預告。
# 真的要開放時，就在 data/articles.txt 加一行「== 名稱 ==」並寫文章，
# 然後把這裡對應的項目刪掉。
UPCOMING_CATEGORIES = ["持續更新中..."]
