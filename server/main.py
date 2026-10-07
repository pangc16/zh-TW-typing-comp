"""中文打字競速 —— 伺服器進入點。

只負責 WebSocket 的收發與訊息分派；
房間與比賽的狀態機在 rooms.py，計分在 scoring.py，文章在 texts.py，
開發者專區的 API 在 dev.py。
"""

import asyncio
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from server import config, dev
from server.rooms import RoomError, RoomManager

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="zh-TW Typing Competition")
manager = RoomManager()
app.include_router(dev.create_router(manager))


@app.get("/health")
def health():
    """給雲端平台檢查服務是否還活著用的。"""
    return {"status": "ok", "rooms": len(manager.rooms), "version": config.VERSION}


@app.get("/designs/site.css")
def site_design():
    """目前全站的介面設計。每個頁面都載入這個網址，開發者專區切換設計後所有人重新整理就套用。"""
    headers = {"Cache-Control": "no-cache"}  # 每次都向伺服器確認，切換後才不會卡在舊的
    path = STATIC_DIR / "designs" / f"{config.SITE_DESIGN}.css"
    if config.SITE_DESIGN == "classic" or not path.is_file():
        # classic 就是 style.css 本身，不用再疊任何樣式
        return Response("/* classic */", media_type="text/css", headers=headers)
    return FileResponse(path, media_type="text/css", headers=headers)


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
        if first.get("type") == "spectate":
            return await spectate(ws, first)
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


async def spectate(ws: WebSocket, first: dict) -> None:
    """管理員觀戰：要帶開發者密碼。只能看，送什麼都不會影響比賽（ping 除外）。"""
    accounts = dev.dev_accounts()
    password = str(first.get("password") or "")
    if not accounts or dev.match_account(password, accounts) is None:
        await asyncio.sleep(1)  # 跟開發者 API 一樣拖慢猜密碼
        return await _reject(ws, "開發者密碼錯誤，請重新登入開發者專區")

    code = str(first.get("room") or "")
    room = manager.find_room(code)
    if room is None:
        return await _reject(ws, f"找不到房號 {code.strip().upper()}")

    room.spectators.add(ws)
    try:
        await ws.send_json({"type": "spectating", "code": room.code})
        await ws.send_json(room.to_dict())
        while True:
            try:
                message = await ws.receive_json()
            except ValueError:
                continue
            if message.get("type") == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        room.spectators.discard(ws)


async def handle_message(room, player, message: dict) -> None:
    kind = message.get("type")

    if kind == "ping":
        await player.ws.send_json({"type": "pong"})

    elif kind == "input":
        await manager.submit_input(room, player, str(message.get("text") or ""))

    elif kind == "start":
        try:
            await manager.start_game(
                room,
                player,
                str(message.get("text") or ""),
                str(message.get("category") or ""),
            )
        except RoomError as exc:
            await player.ws.send_json({"type": "notice", "message": str(exc)})

    elif kind == "category":
        try:
            await manager.set_category(room, player, str(message.get("category") or ""))
        except RoomError as exc:
            await player.ws.send_json({"type": "notice", "message": str(exc)})

    elif kind == "restart":
        try:
            await manager.restart(room, player)
        except RoomError as exc:
            await player.ws.send_json({"type": "notice", "message": str(exc)})

    elif kind == "stop":
        try:
            await manager.stop_game(room, player)
        except RoomError as exc:
            await player.ws.send_json({"type": "notice", "message": str(exc)})

    elif kind == "kick":
        try:
            await manager.kick(room, player, str(message.get("playerId") or ""))
        except RoomError as exc:
            await player.ws.send_json({"type": "notice", "message": str(exc)})

    elif kind == "reset_scores":
        try:
            await manager.reset_scores(room, player)
        except RoomError as exc:
            await player.ws.send_json({"type": "notice", "message": str(exc)})

    elif kind == "rename":
        nickname = str(message.get("nickname") or "").strip()[: config.MAX_NICKNAME_LENGTH]
        if nickname:
            player.nickname = nickname
            await manager.broadcast(room)


class NoCacheStaticFiles(StaticFiles):
    """每次都向伺服器確認檔案有沒有改。

    不加的話瀏覽器會自己猜快取多久，更新版本後玩家可能還在跑舊的 app.js。
    檔案沒變時伺服器只回 304，不會重新下載，所以幾乎沒有額外負擔。
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# 掛在最後面：把 static/ 當成網站根目錄，/ 會自動送出 index.html
app.mount("/", NoCacheStaticFiles(directory=STATIC_DIR, html=True), name="static")
