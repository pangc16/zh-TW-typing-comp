"""遊戲流程的整合測試：多局勝場、結束比賽、踢人、重連、換房號。"""

import asyncio


def run(coroutine):
    return asyncio.run(coroutine)


async def start_race(host) -> dict:
    """房主按開始，等到真的進入比賽，回傳那一刻的房間快照（含文章）。"""
    await host.send(type="start", text="", category="")
    return await host.room("racing")


def test_join_unknown_room(server):
    async def scenario():
        player = await server.join("路人", room="ZZZZ")
        assert player.joined == {"type": "error", "message": "找不到房號 ZZZZ"}

    run(scenario())


def test_wins_accumulate_over_rounds(server):
    async def scenario():
        a = await server.join("甲")
        b = await server.join("乙", room=a.code)

        race = await start_race(a)
        assert race["round"] == 1
        await a.send(type="input", text=race["text"])
        await asyncio.sleep(0.1)
        await b.send(type="input", text=race["text"])
        result = await a.room("finished")
        wins = {p["nickname"]: (p["wins"], p["won"]) for p in result["players"]}
        assert wins == {"甲": (1, True), "乙": (0, False)}

        # 第二局直接從結算畫面開始（再來一局），這次乙先完成
        second = await start_race(a)
        assert second["round"] == 2
        assert second["raceId"] != race["raceId"]
        await b.send(type="input", text=second["text"])
        await asyncio.sleep(0.1)
        await a.send(type="input", text=second["text"])
        result = await a.room("finished")
        wins = {p["nickname"]: (p["wins"], p["won"]) for p in result["players"]}
        assert wins == {"甲": (1, False), "乙": (1, True)}

        # 只有房主能重設勝場
        await b.send(type="reset_scores")
        assert await b.notice() == "只有房主可以重設勝場"
        await a.send(type="reset_scores")
        reset = await a.room()
        assert reset["round"] == 0
        assert all(p["wins"] == 0 for p in reset["players"])

    run(scenario())


def test_host_stops_race_after_someone_finished(server):
    async def scenario():
        host = await server.join("房主")
        guest = await server.join("訪客", room=host.code)
        race = await start_race(host)

        # 還沒有人完成 → 不能結束
        await host.send(type="stop")
        assert await host.notice() == "要等至少一個人完成才能結束比賽"

        await guest.send(type="input", text=race["text"])
        await host.until(lambda m: m["type"] == "room"
                         and any(p["seconds"] is not None for p in m["players"]))

        # 非房主不能結束
        await guest.send(type="stop")
        assert await guest.notice() == "只有房主可以結束比賽"

        # 沒有時間限制：不會自己結算
        try:
            await host.room("finished", timeout=2)
            raise AssertionError("不應該自動結算")
        except asyncio.TimeoutError:
            pass

        await host.send(type="stop")
        result = await host.room("finished")
        assert result["ranking"][0] == guest.id
        assert next(p for p in result["players"] if p["id"] == host.id)["seconds"] is None

    run(scenario())


def test_kick(server):
    async def scenario():
        host = await server.join("房主")
        guest = await server.join("訪客", room=host.code)

        await guest.send(type="kick", playerId=host.id)
        assert await guest.notice() == "只有房主可以踢人"
        await host.send(type="kick", playerId=host.id)
        assert await host.notice() == "不能踢自己"

        await host.send(type="kick", playerId=guest.id)
        kicked = await guest.until(lambda m: m["type"] == "kicked")
        assert kicked["message"] == "你被房主請出了房間"
        snapshot = await host.room()
        assert [p["id"] for p in snapshot["players"]] == [host.id]

        # 被踢的人可以再進來，但會是新身分
        again = await server.join("訪客", room=host.code, player_id=guest.id)
        assert again.joined["type"] == "joined"
        assert again.id != guest.id

    run(scenario())


def test_reconnect_keeps_identity(server):
    async def scenario():
        host = await server.join("房主")
        guest = await server.join("訪客", room=host.code)
        await guest.close()
        back = await server.join("訪客", room=host.code, player_id=guest.id)
        assert back.id == guest.id
        # 房間裡還是兩個人（沒有多出一個新玩家），而且訪客回到線上
        snapshot = await host.until(lambda m: m["type"] == "room" and len(m["players"]) >= 2
                                    and all(p["online"] for p in m["players"]))
        assert [p["id"] for p in snapshot["players"]] == [host.id, guest.id]

    run(scenario())


def test_rename_room(server):
    async def scenario():
        host = await server.join("房主")
        guest = await server.join("訪客", room=host.code)
        other = await server.join("別房")
        old = host.code

        status, body = server.api("POST", f"/rooms/{old}/rename", {"code": "AB"})
        assert (status, body["detail"]) == (400, "房號要是 4 個英文字母或數字")
        status, body = server.api("POST", f"/rooms/{old}/rename", {"code": other.code})
        assert status == 400

        # 訪客先斷線，再改房號
        await guest.close()
        await asyncio.sleep(0.2)
        status, body = server.api("POST", f"/rooms/{old}/rename", {"code": "tst1"})
        assert (status, body) == (200, {"code": "TST1"})
        renamed = await host.until(lambda m: m["type"] == "renamed")
        assert renamed == {"type": "renamed", "code": "TST1", "oldCode": old}

        # 拿舊房號的新玩家進不來；帶著身分重連的人會被帶到新房號
        stranger = await server.join("陌生人", room=old)
        assert stranger.joined["type"] == "error"
        back = await server.join("訪客", room=old, player_id=guest.id)
        assert back.code == "TST1"

        # 舊房號不能給別間房間用
        status, _ = server.api("POST", f"/rooms/{other.code}/rename", {"code": old})
        assert status == 400

    run(scenario())
