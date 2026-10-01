"""中文打字競速 —— 伺服器進入點。

目前是最小版本：只負責把前端網頁送給瀏覽器，
確認「本機 → GitHub → Render」整條部署路線可以走通。
遊戲邏輯（房間、同步、計分）之後再加進來。
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="zh-TW Typing Competition")


@app.get("/health")
def health():
    """給雲端平台檢查服務是否還活著用的。"""
    return {"status": "ok"}


# 掛在最後面：把 static/ 當成網站根目錄，/ 會自動送出 index.html
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
