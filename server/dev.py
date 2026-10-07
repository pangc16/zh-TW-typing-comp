"""開發者專區的 API：伺服器狀態、測試機器人、即時調整設定。

全部都要在 header 帶 X-Dev-Password，值要等於環境變數 DEV_PASSWORD 裡的其中一組。
DEV_PASSWORD 可以用逗號分隔多組密碼，例如「aaa111,bbb222」，方便分給不同的人。
每組前面可以加「名字:」，例如「小明:aaa111,小美:bbb222」，登入後專區會顯示「嗨，小明」。

每個人的副標與頭像放在環境變數 DEV_PROFILES（不寫在程式碼裡，GitHub 上就看不到），格式：
    名字|副標|頭像圖片網址;名字|副標|頭像圖片網址
例如「小明|主要開發者|https://github.com/xiaoming.png;小美|文章庫維護」。
人與人之間用分號隔開；副標或頭像不需要就留空或省略。
沒設定 DEV_PASSWORD 時整個專區停用，避免上線後忘了設密碼就門戶大開。
"""

from __future__ import annotations

import asyncio
import os
import random
import secrets
import time

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from server import config, texts
from server.rooms import Player, Room, RoomError, RoomManager

STARTED_AT = time.time()

# 可以在專區裡即時調整的設定：名稱 → (說明, 最小值, 最大值)
EDITABLE_SETTINGS = {
    "MAX_PLAYERS": ("一間房間最多幾人", 2, 20),
    "COUNTDOWN_SECONDS": ("開始前的倒數秒數", 1, 10),
    "RECONNECT_GRACE_SECONDS": ("斷線後保留身分的秒數", 5, 300),
    "MIN_TEXT_LENGTH": ("自訂文章最少字數", 1, 100),
    "MAX_TEXT_LENGTH": ("自訂文章最多字數", 50, 2000),
}

BOT_NAMES = ["打字機器人", "鍵盤俠", "注音達人", "倉頡小子", "嘸蝦米", "快打旋風", "無影手", "一指神功"]


def dev_accounts() -> list[tuple[str, str]]:
    """把 DEV_PASSWORD 拆成 (名字, 密碼) 清單。

    逗號分隔多組，前後空白不算，空的忽略。「名字:密碼」用第一個冒號切開；
    名字裡不能有冒號，密碼可以；沒寫名字的那組名字是空字串。
    """
    raw = os.environ.get("DEV_PASSWORD", "")
    accounts = []
    for item in raw.split(","):
        name, _, password = item.partition(":") if ":" in item else ("", "", item)
        name, password = name.strip(), password.strip()
        if password:
            accounts.append((name, password))
    return accounts


def dev_profiles() -> dict[str, dict[str, str]]:
    """把 DEV_PROFILES 拆成 {名字: {"subtitle": ..., "avatar": ...}}。"""
    raw = os.environ.get("DEV_PROFILES", "")
    profiles = {}
    for item in raw.split(";"):
        name, subtitle, avatar = (item.split("|", 2) + ["", ""])[:3]
        name = name.strip()
        if not name:
            continue
        avatar = avatar.strip()
        # 只接受 http(s) 網址，避免 javascript: 之類的東西被塞進 <img src>
        if not avatar.startswith(("https://", "http://")):
            avatar = ""
        profiles[name] = {"subtitle": subtitle.strip(), "avatar": avatar}
    return profiles


def match_account(candidate: str, accounts: list[tuple[str, str]]) -> str | None:
    """密碼對了就回傳那組的名字（沒寫名字是空字串），都不對回傳 None。"""
    # 每一組都比過一遍、而且用固定時間的比較，回應時間才不會透露是哪一組接近
    matched = None
    for name, password in accounts:
        if secrets.compare_digest(candidate.encode(), password.encode()):
            matched = name
    return matched


# 請求格式要定義在模組最外層：檔案開頭有 from __future__ import annotations，
# 定義在函式裡的話 FastAPI 解析不到型別，會誤當成網址參數。
class BotRequest(BaseModel):
    room: str
    count: int = 1
    cpm: int = 120


class Announcement(BaseModel):
    message: str


class RenameRequest(BaseModel):
    code: str


class StartRequest(BaseModel):
    category: str = ""


class CategoryRequest(BaseModel):
    category: str


class KickRequest(BaseModel):
    playerId: str


class DesignRequest(BaseModel):
    design: str


def create_router(manager: RoomManager) -> APIRouter:
    router = APIRouter(prefix="/api/dev")

    async def require_password(x_dev_password: str = Header(default="")) -> str:
        accounts = dev_accounts()
        if not accounts:
            raise HTTPException(503, "開發者專區未啟用：請先設定環境變數 DEV_PASSWORD")
        name = match_account(x_dev_password, accounts)
        if name is None:
            await asyncio.sleep(1)  # 拖慢猜密碼的速度
            raise HTTPException(401, "密碼錯誤")
        return name

    guarded = [Depends(require_password)]

    def get_room(code: str) -> Room:
        room = manager.rooms.get(code.strip().upper())
        if room is None:
            raise HTTPException(404, f"找不到房號 {code}")
        return room

    # ---------- 登入者 ----------

    @router.get("/me")
    def me(name: str = Depends(require_password)):
        profile = dev_profiles().get(name, {}) if name else {}
        return {
            "name": name,
            "avatar": profile.get("avatar", ""),
            "subtitle": profile.get("subtitle", ""),
        }

    # ---------- 狀態 ----------

    @router.get("/status", dependencies=guarded)
    def status():
        rooms = []
        for room in sorted(manager.rooms.values(), key=lambda r: r.code):
            players = room.ordered_players()
            rooms.append({
                "code": room.code,
                "state": room.state,
                "category": room.category,
                "round": room.round,
                "players": [
                    {"id": p.id, "nickname": p.nickname, "online": p.online, "bot": p.is_bot,
                     "host": p.id == room.host_id, "wins": p.wins,
                     "finished": p.finish_seconds is not None}
                    for p in players
                ],
            })
        humans = [p for r in manager.rooms.values() for p in r.players.values() if not p.is_bot]
        return {
            "version": config.VERSION,
            "uptime": round(time.time() - STARTED_AT),
            "rooms": rooms,
            "onlinePlayers": sum(1 for p in humans if p.online),
            "totalPlayers": len(humans),
            "categories": {name: len(items) for name, items in texts.CATEGORIES.items()},
        }

    @router.post("/rooms/{code}/close", dependencies=guarded)
    async def close_room(code: str):
        room = get_room(code)
        await manager.close_room(room, "這個房間已被管理員關閉")
        return {"ok": True}

    async def act(action) -> dict:
        """執行房間操作；RoomError 的訊息直接回給開發者頁面顯示。"""
        try:
            await action
        except RoomError as exc:
            raise HTTPException(400, str(exc))
        return {"ok": True}

    @router.post("/rooms/{code}/rename", dependencies=guarded)
    async def rename_room(code: str, body: RenameRequest):
        room = get_room(code)
        await act(manager.rename_room(room, body.code))
        return {"code": room.code}

    # ---------- 房主權限：開發者對任何房間都能做房主能做的事 ----------
    # 傳 None 當作操作者，rooms.py 會把它當成開發者、略過房主檢查

    @router.post("/rooms/{code}/start", dependencies=guarded)
    async def start_room(code: str, body: StartRequest):
        return await act(manager.start_game(get_room(code), None, "", body.category))

    @router.post("/rooms/{code}/stop", dependencies=guarded)
    async def stop_room(code: str):
        return await act(manager.stop_game(get_room(code), None))

    @router.post("/rooms/{code}/restart", dependencies=guarded)
    async def restart_room(code: str):
        return await act(manager.restart(get_room(code), None))

    @router.post("/rooms/{code}/reset-scores", dependencies=guarded)
    async def reset_room_scores(code: str):
        return await act(manager.reset_scores(get_room(code), None))

    @router.post("/rooms/{code}/category", dependencies=guarded)
    async def set_room_category(code: str, body: CategoryRequest):
        return await act(manager.set_category(get_room(code), None, body.category))

    @router.post("/rooms/{code}/kick", dependencies=guarded)
    async def kick_player(code: str, body: KickRequest):
        return await act(manager.kick(get_room(code), None, body.playerId))

    # ---------- 全站設計 ----------

    @router.get("/design", dependencies=guarded)
    def get_design():
        return {"design": config.SITE_DESIGN, "options": config.DESIGNS}

    @router.put("/design", dependencies=guarded)
    def put_design(body: DesignRequest):
        if body.design not in config.DESIGNS:
            raise HTTPException(400, f"沒有「{body.design}」這套設計")
        config.SITE_DESIGN = body.design
        return get_design()

    # ---------- 測試機器人 ----------

    @router.post("/bots", dependencies=guarded)
    async def add_bots(body: BotRequest):
        room = get_room(body.room)
        if room.state not in ("lobby", "finished"):
            raise HTTPException(409, "比賽進行中，等這局結束再加機器人")
        count = max(1, min(body.count, config.MAX_PLAYERS - len(room.players)))
        if len(room.players) >= config.MAX_PLAYERS:
            raise HTTPException(409, "房間已經滿了")
        cpm = max(10, min(body.cpm, 1000))
        used = {p.nickname for p in room.players.values()}
        for _ in range(count):
            name = next((n for n in BOT_NAMES if n not in used), f"機器人{len(used) + 1}")
            used.add(name)
            bot = Player(id=secrets.token_urlsafe(12), nickname=name, joined_at=time.time(), is_bot=True)
            bot.ws = BotSocket(manager, room, bot, cpm)
            room.players[bot.id] = bot
        await manager.broadcast(room)
        return {"added": count}

    @router.delete("/bots/{code}", dependencies=guarded)
    async def remove_bots(code: str):
        room = get_room(code)
        removed = await manager.remove_bots(room)
        return {"removed": removed}

    # ---------- 公告 ----------

    @router.post("/announce", dependencies=guarded)
    async def announce(body: Announcement):
        message = body.message.strip()[:100]
        if not message:
            raise HTTPException(400, "公告內容是空的")
        for room in list(manager.rooms.values()):
            await manager.broadcast(room, {"type": "notice", "message": f"📢 {message}"})
        return {"rooms": len(manager.rooms)}

    # ---------- 設定 ----------

    @router.get("/settings", dependencies=guarded)
    def get_settings():
        return {
            name: {"label": label, "min": low, "max": high, "value": getattr(config, name)}
            for name, (label, low, high) in EDITABLE_SETTINGS.items()
        }

    @router.put("/settings", dependencies=guarded)
    def put_settings(body: dict[str, int]):
        updates = {}
        for name, value in body.items():
            if name not in EDITABLE_SETTINGS:
                raise HTTPException(400, f"不能調整 {name}")
            label, low, high = EDITABLE_SETTINGS[name]
            if not isinstance(value, int) or not low <= value <= high:
                raise HTTPException(400, f"{label} 要介於 {low}～{high}")
            updates[name] = value
        low_len = updates.get("MIN_TEXT_LENGTH", config.MIN_TEXT_LENGTH)
        high_len = updates.get("MAX_TEXT_LENGTH", config.MAX_TEXT_LENGTH)
        if low_len >= high_len:
            raise HTTPException(400, "自訂文章最少字數要小於最多字數")
        # 直接改 config 模組上的值：其他程式都是用 config.X 讀，所以立刻生效
        for name, value in updates.items():
            setattr(config, name, value)
        return get_settings()

    @router.post("/reload-articles", dependencies=guarded)
    def reload_articles():
        try:
            texts.reload()
        except RuntimeError as exc:
            raise HTTPException(400, str(exc))
        return {name: len(items) for name, items in texts.CATEGORIES.items()}

    return router


class BotSocket:
    """假的 WebSocket：伺服器廣播時把訊息「送」給它，它收到 go 就開始照速度打字。

    這樣機器人走的是跟真人完全一樣的 submit_input 流程，可以拿來測排名、勝場、結束比賽。
    """

    def __init__(self, manager: RoomManager, room: Room, player: Player, cpm: int) -> None:
        self.manager = manager
        self.room = room
        self.player = player
        # 每隻機器人速度上下浮動一點，比賽才不會每次都同時抵達
        self.chars_per_second = cpm / 60 * random.uniform(0.8, 1.2)
        self.task: asyncio.Task | None = None

    async def send_json(self, message: dict) -> None:
        if message.get("type") == "go":
            self.stop()
            self.task = asyncio.create_task(self._type())

    async def close(self) -> None:
        self.stop()

    def stop(self) -> None:
        if self.task is not None:
            self.task.cancel()
            self.task = None

    async def _type(self) -> None:
        typed = 0.0
        text = self.room.text
        try:
            while self.room.state == "racing" and self.player.finish_seconds is None:
                await asyncio.sleep(0.4)
                typed += self.chars_per_second * 0.4 * random.uniform(0.6, 1.4)
                await self.manager.submit_input(self.room, self.player, text[: int(typed)])
        except asyncio.CancelledError:
            pass
