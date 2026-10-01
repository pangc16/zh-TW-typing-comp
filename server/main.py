"""中文打字競速 —— 伺服器進入點。

只負責 WebSocket 的收發與訊息分派；
房間與比賽的狀態機在 rooms.py，計分在 scoring.py，文章在 texts.py。
"""

from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from server import config
from server.rooms import RoomError, RoomManager

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="zh-TW Typing Competition")
manager = RoomManager()


@app.get("/health")
def health():
    """給雲端平台檢查服務是否還活著用的。"""
    return {"status": "ok", "rooms": len(manager.rooms)}


async def _reject(ws: WebSocket, message: str) -> None:
    await ws.send_json({"type": "error", "message": message})
    await ws.close()


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    room = None
    player = None
    try:
        # 第一個訊息必須是 join，之後才算正式進房
        first = await ws.receive_json()
        if first.get("type") != "join":
            return await _reject(ws, "連線協定錯誤")

        nickname = str(first.get("nickname") or "").strip()[: config.MAX_NICKNAME_LENGTH]
        if not nickname:
            return await _reject(ws, "請輸入暱稱")

        code = str(first.get("room") or "").strip().upper()
        player_id = first.get("playerId") or None

        try:
            room, player = await manager.join(ws, code, nickname, player_id)
        except RoomError as exc:
            return await _reject(ws, str(exc))

        # 把身分回傳給前端存起來，斷線重連時用得到
        await ws.send_json({"type": "joined", "code": room.code, "playerId": player.id})
        await manager.broadcast(room)

        while True:
            try:
                message = await ws.receive_json()
            except ValueError:
                continue  # 收到不是 JSON 的東西就忽略
            await handle_message(room, player, message)

    except WebSocketDisconnect:
        pass
    finally:
        if room is not None and player is not None:
            await manager.disconnect(room, player)


async def handle_message(room, player, message: dict) -> None:
    kind = message.get("type")

    if kind == "ping":
        await player.ws.send_json({"type": "pong"})

    elif kind == "input":
        await manager.submit_input(room, player, str(message.get("text") or ""))

    elif kind == "start":
        try:
            await manager.start_game(room, player, str(message.get("text") or ""))
        except RoomError as exc:
            await player.ws.send_json({"type": "notice", "message": str(exc)})

    elif kind == "restart":
        try:
            await manager.restart(room, player)
        except RoomError as exc:
            await player.ws.send_json({"type": "notice", "message": str(exc)})

    elif kind == "rename":
        nickname = str(message.get("nickname") or "").strip()[: config.MAX_NICKNAME_LENGTH]
        if nickname:
            player.nickname = nickname
            await manager.broadcast(room)


# 掛在最後面：把 static/ 當成網站根目錄，/ 會自動送出 index.html
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
