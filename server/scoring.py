"""比對與計分。

規則（已定案）：
  - 必須「完全打對」才算完成，所以正確率永遠是 100%，排名直接比時間
  - 只看最終結果，過程中打錯再用 Backspace 改掉不扣分
  - 速度用 CPM（字/分鐘）呈現
"""

# 半形標點 → 全形。玩家忘記切換全半形時不會被判錯。
PUNCTUATION_MAP = {
    ",": "，",
    ".": "。",
    "!": "！",
    "?": "？",
    ":": "：",
    ";": "；",
    "(": "（",
    ")": "）",
    "、": "、",
    "~": "～",
}


def normalize(text: str) -> str:
    """比對前的正規化：去掉所有空白與換行，半形標點統一成全形。

    前端顯示的也是正規化後的文字，這樣「第幾個字」在兩邊才會一致。
    """
    return "".join(
        PUNCTUATION_MAP.get(char, char) for char in text if not char.isspace()
    )


def correct_prefix_length(typed: str, target: str) -> int:
    """從第一個字開始，連續正確的字數。

    因為規則是必須全部打對才能完成，玩家一定得從前往後修，
    所以這一個數字同時代表兩件事：
      1. 進度條的數值
      2. 第一個錯字的位置（前綴斷掉的地方就是錯的那個字）
    """
    limit = min(len(typed), len(target))
    index = 0
    while index < limit and typed[index] == target[index]:
        index += 1
    return index


def is_complete(typed: str, target: str) -> bool:
    return typed == target


def cpm(char_count: int, seconds: float) -> float:
    """每分鐘字數。"""
    if seconds <= 0:
        return 0.0
    return round(char_count / (seconds / 60), 1)
