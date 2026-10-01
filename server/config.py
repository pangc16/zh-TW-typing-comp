"""遊戲設定值。想調整規則就改這裡，不用翻程式碼。"""

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

# 第一名完成後，其他人還有多少秒可以追；時間到強制結算
FINISH_GRACE_SECONDS = 60

# 自訂文章的長度限制（正規化後的字數）
MIN_TEXT_LENGTH = 10
MAX_TEXT_LENGTH = 400
