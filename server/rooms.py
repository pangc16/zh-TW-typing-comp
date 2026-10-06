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


def _require_host(room: "Room", player: "Player | None", message: str) -> None:
    """房主才能做的事。player 傳 None 代表開發者專區：開發者擁有所有房主權限。"""
    if player is not None and player.id != room.host_id:
        raise RoomError(message)


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
    # 連續多局的累計勝場
    wins: int = 0
    won: bool = False                    # 上一局是不是第一名
    # 開發者專區加進來的測試機器人（server/dev.py）
    is_bot: bool = False

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
            "wins": self.wins,
            "won": self.won,
            "bot": self.is_bot,
        }


@dataclass
class Room:
    code: str
    host_id: str | None = None
    state: str = "lobby"
    players: dict[str, Player] = field(default_factory=dict)
    cleanup_task: asyncio.Task | None = None
    # 比賽資料
    category: str = ""                   # 房主選的文章分類
    text: str = ""                       # 正規化後的文章，顯示與比對都用這一份
    custom: bool = False                 # 這一局是不是房主貼的自訂文章
    round: int = 0                       # 勝場重設後比了第幾局
    race_id: str = ""                    # 每局唯一的代號，前端靠它避免同一局重複記錄
    started_at: float | None = None      # time.monotonic()，用伺服器自己的時鐘計時
    countdown_task: asyncio.Task | None = None

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
            "custom": self.custom,
            "round": self.round,
            "raceId": self.race_id,
        }
        if self.state in ("lobby", "finished"):
            # 只有 Lobby 會用到分類選單，比賽中不必每次進度更新都重複送
            data["category"] = self.category
            data["categories"] = texts.category_names()
            data["upcoming"] = config.UPCOMING_CATEGORIES
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
        # 改過房號的舊房號 → 現在的房號。只給改名當下斷線的玩家重連用。
        self.aliases: dict[str, str] = {}

    # ---------- 房間生命週期 ----------

    def _code_taken(self, code: str) -> bool:
        # 舊房號也不能給新房間用，否則斷線的人回來會連錯房間
        return code in self.rooms or code in self.aliases

    def _new_code(self) -> str:
        for _ in range(100):
            code = "".join(
                random.choice(ROOM_CODE_ALPHABET) for _ in range(config.ROOM_CODE_LENGTH)
            )
            if not self._code_taken(code):
                return code
        raise RoomError("目前房間太多，請稍後再試")

    def _forget_room(self, room: Room) -> None:
        if self.rooms.get(room.code) is room:
            self.rooms.pop(room.code, None)
        for old, new in list(self.aliases.items()):
            if new == room.code:
                del self.aliases[old]

    def create_room(self) -> Room:
        room = Room(code=self._new_code(), category=texts.default_category())
        self.rooms[room.code] = room
        return room

    # ---------- 加入與離開 ----------

    async def join(self, ws, code: str, nickname: str, player_id: str | None):
        """回傳 (room, player)。code 傳空字串代表開新房間。"""
        if code:
            room = self.rooms.get(code)
            if room is None and code in self.aliases:
                # 舊房號：只有本來就在房裡的人（帶著身分重連）可以進去
                renamed = self.rooms.get(self.aliases[code])
                if renamed is not None and player_id in renamed.players:
                    room = renamed
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
        if not any(not p.is_bot for p in room.players.values()):
            # 真人都走光了，只剩機器人也沒意義，一起清掉房間才回收得了
            await self.remove_bots(room)
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
            self._forget_room(room)

    def _maybe_transfer_host(self, room: Room) -> None:
        """房主離線或離開時，交棒給還在線上、最早加入的真人玩家（機器人不當房主）。"""
        host = room.players.get(room.host_id) if room.host_id else None
        if host is not None and host.online:
            return
        for candidate in room.ordered_players():
            if candidate.online and not candidate.is_bot:
                room.host_id = candidate.id
                return

    # ---------- 開發者專區用 ----------

    async def remove_bots(self, room: Room) -> int:
        bots = [p for p in room.players.values() if p.is_bot]
        for bot in bots:
            await bot.ws.close()
            room.players.pop(bot.id, None)
        if bots:
            await self.broadcast(room)
            # 比賽中拿掉機器人後，剩下的人可能都已經完成了
            await self._finish_if_everyone_done(room)
        return len(bots)

    async def close_room(self, room: Room, message: str) -> None:
        """強制關閉房間：踢出所有人並立刻刪除。"""
        self._forget_room(room)
        self._cancel_race_timers(room)
        for task in (room.cleanup_task, *(p.removal_task for p in room.players.values())):
            if task is not None:
                task.cancel()
        for player in list(room.players.values()):
            if player.ws is not None:
                ws, player.ws = player.ws, None  # 先清掉，斷線處理才不會再排重連計時
                await _safe_close(ws, message)
        room.players.clear()

    async def kick(self, room: Room, host: Player | None, target_id: str) -> None:
        """房主（或開發者）把某位玩家請出房間。對方可以再用連結回來，只是會變成新玩家。"""
        _require_host(room, host, "只有房主可以踢人")
        if host is not None and target_id == host.id:
            raise RoomError("不能踢自己")
        target = room.players.get(target_id)
        if target is None:
            raise RoomError("這位玩家已經不在房間裡了")

        room.players.pop(target.id, None)
        if target.removal_task is not None:
            target.removal_task.cancel()
        if target.ws is not None:
            ws, target.ws = target.ws, None  # 先清掉，斷線處理才不會再排重連計時
            who = "管理員" if host is None else "房主"
            await _safe_close(ws, f"你被{who}請出了房間")
        # 開發者可能把房主本人踢掉，這時要交棒給下一位
        self._maybe_transfer_host(room)
        await self.broadcast(room)
        # 比賽中踢掉還沒打完的人，剩下的人可能都已經完成了
        await self._finish_if_everyone_done(room)

    async def rename_room(self, room: Room, new_code: str) -> None:
        """幫房間換房號。房裡的人會收到 renamed 訊息，前端自己改網址與存檔。"""
        new_code = new_code.strip().upper()
        length = config.ROOM_CODE_LENGTH
        if len(new_code) != length or not new_code.isascii() or not new_code.isalnum():
            raise RoomError(f"房號要是 {length} 個英文字母或數字")
        if new_code == room.code:
            raise RoomError("新房號跟原本一樣")
        # 改回自己以前用過的房號可以；被別間房間（或別間的舊房號）佔用就不行
        if new_code in self.rooms or self.aliases.get(new_code, room.code) != room.code:
            raise RoomError(f"房號 {new_code} 已經有人在用")

        old_code = room.code
        self.aliases.pop(new_code, None)
        for old, current in self.aliases.items():
            if current == old_code:
                self.aliases[old] = new_code
        self.aliases[old_code] = new_code
        del self.rooms[old_code]
        room.code = new_code
        self.rooms[new_code] = room

        await self.broadcast(room, {"type": "renamed", "code": new_code, "oldCode": old_code})
        await self.broadcast(room)

    # ---------- 比賽流程 ----------

    async def set_category(self, room: Room, player: Player | None, category: str) -> None:
        """房主換分類時立刻同步給全房，其他人才知道這局要打什麼類型。"""
        _require_host(room, player, "只有房主可以更換文章分類")
        if category not in texts.CATEGORIES:
            raise RoomError(f"找不到分類「{category}」")
        room.category = category
        await self.broadcast(room)

    async def start_game(
        self, room: Room, player: Player | None, custom_text: str, category: str
    ) -> None:
        _require_host(room, player, "只有房主可以開始遊戲")
        if room.state not in ("lobby", "finished"):
            raise RoomError("比賽已經開始了")

        if custom_text.strip():
            text = scoring.normalize(custom_text)
            if len(text) < config.MIN_TEXT_LENGTH:
                raise RoomError(f"自訂文章太短，至少要 {config.MIN_TEXT_LENGTH} 個字")
            if len(text) > config.MAX_TEXT_LENGTH:
                raise RoomError(f"自訂文章太長，上限 {config.MAX_TEXT_LENGTH} 個字")
        else:
            if category:
                room.category = category
            try:
                text = texts.pick_random(room.category, exclude=room.text)
            except KeyError:
                raise RoomError(f"找不到分類「{room.category}」")

        room.text = text
        room.custom = bool(custom_text.strip())
        room.round += 1
        room.race_id = secrets.token_hex(4)
        room.started_at = None
        for member in room.players.values():
            member.reset_race()
            member.won = False

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

        await self.broadcast(room)
        await self._finish_if_everyone_done(room)

    async def _finish_if_everyone_done(self, room: Room) -> None:
        if room.state != "racing":
            return
        active = [p for p in room.players.values() if p.online]
        if active and all(p.finish_seconds is not None for p in active):
            await self.finish(room)

    async def stop_game(self, room: Room, player: Player | None) -> None:
        """沒有時間限制，改由房主在有人完成後手動結束比賽。

        開發者可以隨時強制結束（例如卡住的房間）；沒人完成的話這局就沒有人得勝。
        """
        _require_host(room, player, "只有房主可以結束比賽")
        if room.state != "racing":
            raise RoomError("比賽不在進行中")
        someone_finished = any(p.finish_seconds is not None for p in room.players.values())
        if player is not None and not someone_finished:
            raise RoomError("要等至少一個人完成才能結束比賽")
        await self.finish(room)

    async def finish(self, room: Room) -> None:
        if room.state != "racing":
            return
        room.state = "finished"
        self._cancel_race_timers(room)
        self._award_win(room)
        await self.broadcast(room)

    def _award_win(self, room: Room) -> None:
        """第一名（而且有完成）記一勝。"""
        order = room.ranking()
        if not order:
            return
        winner = room.players[order[0]]
        if winner.finish_seconds is not None:
            winner.won = True
            winner.wins += 1

    async def reset_scores(self, room: Room, player: Player | None) -> None:
        _require_host(room, player, "只有房主可以重設勝場")
        if room.state not in ("lobby", "finished"):
            raise RoomError("比賽進行中不能重設勝場")
        room.round = 0
        for member in room.players.values():
            member.wins = 0
            member.won = False
        await self.broadcast(room)

    async def restart(self, room: Room, player: Player | None) -> None:
        _require_host(room, player, "只有房主可以重新開始")
        self._cancel_race_timers(room)
        room.state = "lobby"
        room.started_at = None
        for member in room.players.values():
            member.reset_race()
        await self.broadcast(room)

    def _cancel_race_timers(self, room: Room) -> None:
        """取消倒數計時器。注意不要取消自己所在的那個 task。"""
        task = room.countdown_task
        room.countdown_task = None
        if task is not None and task is not asyncio.current_task():
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
