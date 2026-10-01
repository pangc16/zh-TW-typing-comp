"""內建文章庫。

文章放在 data/articles.txt：
  - 「== 分類名稱 ==」開一個新分類
  - 同一分類裡用「---」分隔每篇文章
  - 「#」開頭是註解

要增減文章或分類只改那個檔案就好，不用動程式碼。
"""

import random
import re
from pathlib import Path

from server import scoring

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "articles.txt"

CATEGORY_PATTERN = re.compile(r"^==\s*(.+?)\s*==$")


def load_categories() -> dict[str, list[str]]:
    categories: dict[str, list[str]] = {}
    current: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        if current is not None and buffer:
            # 中文不用空格連接，直接接起來
            article = scoring.normalize("".join(buffer))
            if article:
                categories[current].append(article)
        buffer = []

    for line in DATA_FILE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue

        header = CATEGORY_PATTERN.match(stripped)
        if header:
            flush()
            current = header.group(1)
            categories.setdefault(current, [])
            continue

        if stripped == "---":
            flush()
            continue

        if stripped:
            buffer.append(stripped)

    flush()
    # 只留下真的有文章的分類
    return {name: articles for name, articles in categories.items() if articles}


CATEGORIES = load_categories()

if not CATEGORIES:
    raise RuntimeError("data/articles.txt 裡沒有任何分類與文章")


def category_names() -> list[str]:
    return list(CATEGORIES)


def default_category() -> str:
    return category_names()[0]


def pick_random(category: str, exclude: str = "") -> str:
    """從指定分類隨機抽一篇，盡量避開上一局抽過的那篇。"""
    articles = CATEGORIES.get(category)
    if not articles:
        raise KeyError(category)
    pool = [article for article in articles if article != exclude] or articles
    return random.choice(pool)
