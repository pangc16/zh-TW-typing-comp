"""房間、玩家與比賽流程的狀態管理。

狀態全部放在記憶體的 dict 裡，所以要知道兩個限制：
  1. 伺服器重啟 → 所有房間消失
  2. 只能跑單一個 process（多個 instance 之間不共享記憶體）
第一版可以接受，之後要擴充再換 Redis。

房間狀態機：
    lobby ──開始遊戲──> countdown ──倒數結束──> racing ──結算──> finished
      ^                                                            │
      └──────────────────── 再來一局 ──────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import random
import secrets
import time
from dataclasses import dataclass, field

from server import config, scoring, texts

# 去掉容易看錯的 I、O、0、1，剩下 32 個字元
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class RoomError(Exception):
    """訊息可以直接顯示給玩家看的錯誤。"""


@dataclass
class Player:
    id: str
    nickname: str
    joined_at: float
    # WebSocket 連線。斷線時設成 None，但玩家本身還留在房間裡等重連。
    ws: object | None = None
    removal_task: asyncio.Task | None = None
    # 比賽中的狀態
    progress: int = 0                    # 從頭算起連續正確的字數
    finish_seconds: float | None = None  # None = 還沒完成

    @property
    def online(self) -> bool:
        return self.ws is not None

    def reset_race(self) -> None:
        self.progress = 0
        self.finish_seconds = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "nickname": self.nickname,
            "online": self.online,
            "progress": self.progress,
            "seconds": self.finish_seconds,
        }


@dataclass
class Room:
    code: str
    host_id: str | None = None
    state: str = "lobby"
    players: dict[str, Player] = field(default_factory=dict)
    cleanup_task: asyncio.Task | None = None
    # 比賽資料
    text: str = ""                       # 正規化後的文章，顯示與比對都用這一份
    started_at: float | None = None      # time.monotonic()，用伺服器自己的時鐘計時
    countdown_task: asyncio.Task | None = None
    grace_task: asyncio.Task | None = None

    def ordered_players(self) -> list[Player]:
        """依加入時間排序，Lobby 的顯示順序才不會跳動。"""
        return sorted(self.players.values(), key=lambda p: p.joined_at)

    def ranking(self) -> list[str]:
        """完成的人依時間由短到長；沒完成的人排在後面，依進度由多到少。"""
        finished = [p for p in self.players.values() if p.finish_seconds is not None]
        unfinished = [p for p in self.players.values() if p.finish_seconds is None]
        finished.sort(key=lambda p: p.finish_seconds)
        unfinished.sort(key=lambda p: (-p.progress, p.joined_at))
        return [p.id for p in finished + unfinished]

    def to_dict(self) -> dict:
        """一個訊息就包含前端畫面需要的全部資訊，重連時也靠這個還原畫面。"""
        data = {
            "type": "room",
            "code": self.code,
            "state": self.state,
            "hostId": self.host_id,
            "maxPlayers": config.MAX_PLAYERS,
            "players": [p.to_dict() for p in self.ordered_players()],
            "text": self.text,
            "total": len(self.text),
        }
        if self.state == "racing" and self.started_at is not None:
            # 中途重連的人靠這個把計時器接回正確的秒數
            data["elapsed"] = round(time.monotonic() - self.started_at, 2)
        if self.state == "finished":
            data["ranking"] = self.ranking()
        return data


async def _safe_close(ws, message: str) -> None:
    try:
        await ws.send_json({"type": "kicked", "message": message})
        await ws.close()
    except Exception:
        pass


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    # ---------- 房間生命週期 ----------

    def _new_code(self) -> str:
        for _ in range(100):
            code = "".join(
                random.choice(ROOM_CODE_ALPHABET) for _ in range(config.ROOM_CODE_LENGTH)
            )
            if code not in self.rooms:
                return code
        raise RoomError("目前房間太多，請稍後再試")

    def create_room(self) -> Room:
        room = Room(code=self._new_code())
        self.rooms[room.code] = room
        return room

    # ---------- 加入與離開 ----------

    async def join(self, ws, code: str, nickname: str, player_id: str | None):
        """回傳 (room, player)。code 傳空字串代表開新房間。"""
        if code:
            room = self.rooms.get(code)
            if room is None:
                raise RoomError(f"找不到房號 {code}")
        else:
            room = self.create_room()

        # 有人進來了，取消房間回收
        if room.cleanup_task is not None:
            room.cleanup_task.cancel()
            room.cleanup_task = None

        player = room.players.get(player_id) if player_id else None

        if player is not None:
            # 重連：沿用原本的身分，進度與成績都還在
            if player.removal_task is not None:
                player.removal_task.cancel()
                player.removal_task = None
            if player.ws is not None:
                # 同一個身分在別的分頁也開著 → 把舊的那個踢掉
                await _safe_close(player.ws, "你在另一個視窗加入了這個房間")
            player.ws = ws
            if nickname:
                player.nickname = nickname
        else:
            if len(room.players) >= config.MAX_PLAYERS:
                raise RoomError(f"房間已滿（上限 {config.MAX_PLAYERS} 人）")
            if room.state not in ("lobby", "finished"):
                raise RoomError("這個房間的比賽正在進行中，等這局結束再加入")
            player = Player(
                id=secrets.token_urlsafe(12),
                nickname=nickname,
                joined_at=time.time(),
                ws=ws,
            )
            room.players[player.id] = player

        if room.host_id is None:
            room.host_id = player.id

        return room, player

    async def disconnect(self, room: Room, player: Player) -> None:
        """標記離線，並給一段重連寬限期，而不是立刻踢掉。"""
        if player.ws is None:
            return
        player.ws = None
        self._maybe_transfer_host(room)
        await self.broadcast(room)
        player.removal_task = asyncio.create_task(self._remove_later(room, player))
        # 比賽中如果剩下的人都打完了，不要為了等離線的人乾等
        await self._finish_if_everyone_done(room)

    async def _remove_later(self, room: Room, player: Player) -> None:
        try:
            await asyncio.sleep(config.RECONNECT_GRACE_SECONDS)
        except asyncio.CancelledError:
            return
        if player.ws is not None:  # 寬限期內回來了
            return
        room.players.pop(player.id, None)
        self._maybe_transfer_host(room)
        await self.broadcast(room)
        if not room.players:
            room.cleanup_task = asyncio.create_task(self._delete_later(room))

    async def _delete_later(self, room: Room) -> None:
        try:
            await asyncio.sleep(config.EMPTY_ROOM_TTL_SECONDS)
        except asyncio.CancelledError:
            return
        if not room.players:
            self.rooms.pop(room.code, None)

    def _maybe_transfer_host(self, room: Room) -> None:
        """房主離線或離開時，交棒給還在線上、最早加入的玩家。"""
        host = room.players.get(room.host_id) if room.host_id else None
        if host is not None and host.online:
            return
        for candidate in room.ordered_players():
            if candidate.online:
                room.host_id = candidate.id
                return

    # ---------- 比賽流程 ----------

    async def start_game(self, room: Room, player: Player, custom_text: str) -> None:
        if player.id != room.host_id:
            raise RoomError("只有房主可以開始遊戲")
        if room.state not in ("lobby", "finished"):
            raise RoomError("比賽已經開始了")

        if custom_text.strip():
            text = scoring.normalize(custom_text)
            if len(text) < config.MIN_TEXT_LENGTH:
                raise RoomError(f"自訂文章太短，至少要 {config.MIN_TEXT_LENGTH} 個字")
            if len(text) > config.MAX_TEXT_LENGTH:
                raise RoomError(f"自訂文章太長，上限 {config.MAX_TEXT_LENGTH} 個字")
        else:
            text = texts.pick_random(exclude=room.text)

        room.text = text
        room.started_at = None
        for member in room.players.values():
            member.reset_race()

        self._cancel_race_timers(room)
        room.state = "countdown"
        # 文章跟著倒數一起送出，讓玩家在倒數時可以先看文章
        await self.broadcast(room)
        await self.broadcast(room, {"type": "countdown", "seconds": config.COUNTDOWN_SECONDS})
        room.countdown_task = asyncio.create_task(self._run_countdown(room))

    async def _run_countdown(self, room: Room) -> None:
        try:
            await asyncio.sleep(config.COUNTDOWN_SECONDS)
        except asyncio.CancelledError:
            return
        room.countdown_task = None
        room.state = "racing"
        # 用伺服器自己的時鐘計時，玩家改本機時間也沒用
        room.started_at = time.monotonic()
        await self.broadcast(room, {"type": "go"})
        await self.broadcast(room)

    async def submit_input(self, room: Room, player: Player, typed: str) -> None:
        """收到玩家目前的輸入內容，由伺服器判定進度與是否完成。"""
        if room.state != "racing" or room.started_at is None:
            return
        if player.finish_seconds is not None:
            return

        # 正規化後再比，並限制長度避免有人塞超長字串
        normalized = scoring.normalize(typed)[: config.MAX_TEXT_LENGTH + 50]
        player.progress = scoring.correct_prefix_length(normalized, room.text)

        if scoring.is_complete(normalized, room.text):
            player.finish_seconds = round(time.monotonic() - room.started_at, 2)
            if room.grace_task is None:
                # 第一名出現 → 開始跑追趕時間
                room.grace_task = asyncio.create_task(self._grace_then_finish(room))

        await self.broadcast(room)
        await self._finish_if_everyone_done(room)

    async def _finish_if_everyone_done(self, room: Room) -> None:
        if room.state != "racing":
            return
        active = [p for p in room.players.values() if p.online]
        if active and all(p.finish_seconds is not None for p in active):
            await self.finish(room)

    async def _grace_then_finish(self, room: Room) -> None:
        try:
            await asyncio.sleep(config.FINISH_GRACE_SECONDS)
        except asyncio.CancelledError:
            return
        room.grace_task = None
        await self.finish(room)

    async def finish(self, room: Room) -> None:
        if room.state != "racing":
            return
        room.state = "finished"
        self._cancel_race_timers(room)
        await self.broadcast(room)

    async def restart(self, room: Room, player: Player) -> None:
        if player.id != room.host_id:
            raise RoomError("只有房主可以重新開始")
        self._cancel_race_timers(room)
        room.state = "lobby"
        room.started_at = None
        for member in room.players.values():
            member.reset_race()
        await self.broadcast(room)

    def _cancel_race_timers(self, room: Room) -> None:
        """取消倒數與追趕計時器。注意不要取消自己所在的那個 task。"""
        current = asyncio.current_task()
        for attribute in ("countdown_task", "grace_task"):
            task = getattr(room, attribute)
            setattr(room, attribute, None)
            if task is not None and task is not current:
                task.cancel()

    # ---------- 廣播 ----------

    async def broadcast(self, room: Room, payload: dict | None = None) -> None:
        message = payload if payload is not None else room.to_dict()
        broken = []
        for player in room.ordered_players():
            if player.ws is None:
                continue
            try:
                await player.ws.send_json(message)
            except Exception:
                broken.append(player)
        for player in broken:
            await self.disconnect(room, player)
