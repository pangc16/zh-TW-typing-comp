"""開發者專區 API 的測試：密碼、設定、機器人、公告、關閉房間。"""

import asyncio

from server import dev


def test_password_required(server):
    assert server.api("GET", "/status", password=None)[0] == 401
    assert server.api("GET", "/status", password="wrong")[0] == 401
    status, body = server.api("GET", "/status")
    assert status == 200
    assert body["version"]


def test_multiple_passwords(monkeypatch):
    monkeypatch.setenv("DEV_PASSWORD", " aaa111 , bbb222,,")
    accounts = dev.dev_accounts()
    assert accounts == [("", "aaa111"), ("", "bbb222")]
    assert dev.match_account("aaa111", accounts) == ""
    assert dev.match_account("bbb222", accounts) == ""
    assert dev.match_account("aaa111,bbb222", accounts) is None
    assert dev.match_account("", accounts) is None


def test_named_passwords(monkeypatch):
    monkeypatch.setenv("DEV_PASSWORD", "小明:aaa111, 小美 : bbb:222 ,ccc333")
    accounts = dev.dev_accounts()
    assert accounts == [("小明", "aaa111"), ("小美", "bbb:222"), ("", "ccc333")]
    assert dev.match_account("aaa111", accounts) == "小明"
    assert dev.match_account("bbb:222", accounts) == "小美"
    assert dev.match_account("ccc333", accounts) == ""
    assert dev.match_account("小明:aaa111", accounts) is None


def test_profiles(monkeypatch):
    monkeypatch.setenv(
        "DEV_PROFILES",
        " 小明 | 主要開發者 | https://example.com/a.png ;小美|文章庫維護;;阿華||javascript:alert(1)",
    )
    assert dev.dev_profiles() == {
        "小明": {"subtitle": "主要開發者", "avatar": "https://example.com/a.png"},
        "小美": {"subtitle": "文章庫維護", "avatar": ""},
        "阿華": {"subtitle": "", "avatar": ""},
    }


def test_me_returns_name(server):
    status, data = server.api("GET", "/me")
    assert status == 200
    assert data == {"name": "", "avatar": "", "subtitle": ""}


def test_no_password_disables_dev_area(monkeypatch):
    monkeypatch.delenv("DEV_PASSWORD", raising=False)
    assert dev.dev_accounts() == []


def test_settings_validation(server):
    status, body = server.api("PUT", "/settings", {"MAX_PLAYERS": 99})
    assert (status, body["detail"]) == (400, "一間房間最多幾人 要介於 2～20")
    status, body = server.api("PUT", "/settings", {"MIN_TEXT_LENGTH": 60, "MAX_TEXT_LENGTH": 50})
    assert (status, body["detail"]) == (400, "自訂文章最少字數要小於最多字數")
    status, body = server.api("PUT", "/settings", {"UNKNOWN": 1})
    assert status == 400
    status, body = server.api("GET", "/settings")
    assert status == 200 and body["COUNTDOWN_SECONDS"]["value"] == 1


def test_reload_articles(server):
    status, body = server.api("POST", "/reload-articles")
    assert status == 200 and body


def test_bots_race(server):
    async def scenario():
        host = await server.join("房主")
        status, body = server.api("POST", "/bots", {"room": host.code, "count": 2, "cpm": 1000})
        assert (status, body) == (200, {"added": 2})
        lobby = await host.until(lambda m: m["type"] == "room" and len(m["players"]) == 3)
        assert sum(p["bot"] for p in lobby["players"]) == 2
        assert lobby["hostId"] == host.id

        await host.send(type="start", text="", category="")
        await host.room("racing")
        # 機器人會自己打字；等有一個完成，房主再結束比賽
        await host.until(lambda m: m["type"] == "room"
                         and any(p["bot"] and p["seconds"] is not None for p in m["players"]),
                         timeout=30)
        await host.send(type="stop")
        result = await host.room("finished")
        winner = next(p for p in result["players"] if p["id"] == result["ranking"][0])
        assert winner["bot"] and winner["won"]

        status, body = server.api("DELETE", f"/bots/{host.code}")
        assert (status, body) == (200, {"removed": 2})

    asyncio.run(scenario())


def test_announce_and_close_room(server):
    async def scenario():
        host = await server.join("房主")
        status, _ = server.api("POST", "/announce", {"message": "測試公告"})
        assert status == 200
        notice = await host.until(lambda m: m["type"] == "notice")
        assert notice["message"] == "📢 測試公告"

        status, _ = server.api("POST", f"/rooms/{host.code}/close")
        assert status == 200
        kicked = await host.until(lambda m: m["type"] == "kicked")
        assert kicked["message"] == "這個房間已被管理員關閉"
        assert server.api("POST", f"/rooms/{host.code}/close")[0] == 404

    asyncio.run(scenario())


def test_developer_has_host_powers(server):
    """開發者不在房間裡，也能對任何房間做房主能做的事。"""
    async def scenario():
        host = await server.join("房主")
        guest = await server.join("訪客", room=host.code)
        code = host.code
        categories = list(server.api("GET", "/status")[1]["categories"])

        status, _ = server.api("POST", f"/rooms/{code}/category", {"category": categories[0]})
        assert status == 200
        status, body = server.api("POST", f"/rooms/{code}/category", {"category": "不存在的分類"})
        assert status == 400

        # 開始比賽 → 沒人完成也能強制結束（房主不行，開發者可以）
        assert server.api("POST", f"/rooms/{code}/start", {})[0] == 200
        await host.room("racing")
        assert server.api("POST", f"/rooms/{code}/start", {})[1]["detail"] == "比賽已經開始了"
        assert server.api("POST", f"/rooms/{code}/stop")[0] == 200
        result = await host.room("finished")
        assert not any(p["won"] for p in result["players"])  # 沒人完成就沒人得勝

        assert server.api("POST", f"/rooms/{code}/restart")[0] == 200
        await host.room("lobby")
        assert server.api("POST", f"/rooms/{code}/reset-scores")[0] == 200

        # 開發者可以踢任何人，包括房主
        assert server.api("POST", f"/rooms/{code}/kick", {"playerId": host.id})[0] == 200
        kicked = await host.until(lambda m: m["type"] == "kicked")
        assert kicked["message"] == "你被管理員請出了房間"
        snapshot = await guest.until(lambda m: m["type"] == "room" and len(m["players"]) == 1)
        assert snapshot["hostId"] == guest.id  # 房主被踢走後交棒

        assert server.api("POST", "/rooms/ZZZZ/stop")[0] == 404

    asyncio.run(scenario())


def test_site_design(server):
    import urllib.request

    status, body = server.api("GET", "/design")
    assert status == 200 and body["design"] in body["options"]
    original = body["design"]
    try:
        assert server.api("PUT", "/design", {"design": "nope"})[0] == 400

        assert server.api("PUT", "/design", {"design": "timing"})[0] == 200
        css = urllib.request.urlopen(f"{server.http}/designs/site.css").read().decode()
        assert "賽事計時看板" in css

        assert server.api("PUT", "/design", {"design": "classic"})[0] == 200
        css = urllib.request.urlopen(f"{server.http}/designs/site.css").read().decode()
        assert css.strip() == "/* classic */"
    finally:
        server.api("PUT", "/design", {"design": original})
