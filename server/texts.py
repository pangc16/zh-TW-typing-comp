"""內建文章庫。

文章放在 data/articles.txt，純文字檔，用「---」分隔每一篇。
要增減文章只改那個檔案就好，不用動程式碼。
"""

import random
from pathlib import Path

from server import scoring

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "articles.txt"


def load_articles() -> list[str]:
    articles: list[str] = []
    current: list[str] = []

    for line in DATA_FILE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if stripped == "---":
            if current:
                articles.append("".join(current))
                current = []
            continue
        if stripped:
            # 中文不用空格連接，直接接起來
            current.append(stripped)

    if current:
        articles.append("".join(current))

    return [scoring.normalize(article) for article in articles if article]


ARTICLES = load_articles()


def pick_random(exclude: str = "") -> str:
    """隨機抽一篇，盡量避開上一局抽過的那篇。"""
    if not ARTICLES:
        raise RuntimeError("data/articles.txt 裡沒有任何文章")
    pool = [article for article in ARTICLES if article != exclude] or ARTICLES
    return random.choice(pool)
