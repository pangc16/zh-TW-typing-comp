"""測試共用的工具。

整合測試會真的啟動一個伺服器（另一個 process、隨機 port），
再用 WebSocket 模擬好幾個玩家，走的是跟瀏覽器一模一樣的協定。
"""

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
import websockets

ROOT = Path(__file__).resolve().parent.parent
DEV_PASSWORD = "test-password"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Server:
    def __init__(self, port: int) -> None:
        self.http = f"http://127.0.0.1:{port}"
        self.ws_url = f"ws://127.0.0.1:{port}/ws"

    def api(self, method: str, path: str, body=None, password: str | None = DEV_PASSWORD):
        """呼叫開發者 API，回傳 (HTTP 狀態碼, JSON)。"""
        headers = {"Content-Type": "application/json"}
        if password is not None:
            headers["X-Dev-Password"] = password
        request = urllib.request.Request(
            f"{self.http}/api/dev{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    async def join(self, nickname: str, room: str = "", player_id: str | None = None) -> "Player":
        player = Player(await websockets.connect(self.ws_url))
        await player.send(type="join", room=room, nickname=nickname, playerId=player_id)
        first = await player.until(lambda m: m["type"] in ("joined", "error"))
        player.joined = first
        if first["type"] == "joined":
            player.id = first["playerId"]
            player.code = first["code"]
        return player


class Player:
    """一個用 WebSocket 連進來的假玩家。"""

    def __init__(self, ws) -> None:
        self.ws = ws
        self.id = None
        self.code = None
        self.joined = None

    async def send(self, **payload) -> None:
        await self.ws.send(json.dumps(payload))

    async def until(self, predicate, timeout: float = 10):
        """一直收訊息，直到收到符合條件的那一則。"""
        while True:
            message = json.loads(await asyncio.wait_for(self.ws.recv(), timeout))
            if predicate(message):
                return message

    async def room(self, state: str | None = None, timeout: float = 10) -> dict:
        return await self.until(
            lambda m: m["type"] == "room" and (state is None or m["state"] == state), timeout
        )

    async def notice(self) -> str:
        return (await self.until(lambda m: m["type"] == "notice"))["message"]

    async def close(self) -> None:
        await self.ws.close()


@pytest.fixture(scope="session")
def server():
    port = _free_port()
    env = {**os.environ, "DEV_PASSWORD": DEV_PASSWORD, "PYTHONIOENCODING": "utf-8"}
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.main:app", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    instance = Server(port)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"{instance.http}/health")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("測試用伺服器啟動失敗")
        # 倒數縮成 1 秒，測試才不會跑太久
        status, _ = instance.api("PUT", "/settings", {"COUNTDOWN_SECONDS": 1})
        assert status == 200
        yield instance
    finally:
        process.terminate()
        process.wait(timeout=10)
