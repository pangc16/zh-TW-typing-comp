"use strict";

// 開發者專區。API 在 server/dev.py，每個請求都要帶密碼。

const $ = (id) => document.getElementById(id);
const KEY_PASSWORD = "typing:dev-password";

const STATE_LABELS = { lobby: "Lobby", countdown: "倒數中", racing: "比賽中", finished: "結算" };

let password = "";
let statusTimer = null;

// ---------- 共用 ----------

let toastTimer = null;
function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add("hidden"), 2400);
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const response = await fetch(`/api/dev${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Dev-Password": password },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // FastAPI 的錯誤格式是 {detail: "..."}；欄位驗證錯誤則是陣列
    const detail = typeof data.detail === "string" ? data.detail : "請求格式錯誤";
    throw new ApiError(response.status, detail);
  }
  return data;
}

/** 按鈕送出時的共用處理：失敗就跳提示，密碼失效就回登入畫面。 */
async function run(action) {
  try {
    await action();
  } catch (error) {
    if (error.status === 401 || error.status === 503) {
      logout(error.message);
    } else {
      toast(error.message || "發生錯誤");
    }
  }
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小時`;
  if (hours) return `${hours} 小時 ${minutes} 分`;
  return `${minutes} 分 ${seconds % 60} 秒`;
}

// ---------- 登入 ----------

async function login(candidate) {
  password = candidate;
  let me;
  try {
    me = await api("GET", "/me");
  } catch (error) {
    password = "";
    const box = $("login-error");
    box.textContent = error.message || "無法連線";
    box.classList.remove("hidden");
    return;
  }
  // 存在 sessionStorage：關掉分頁就要重新輸入
  try { sessionStorage.setItem(KEY_PASSWORD, candidate); } catch { /* 忽略 */ }
  // DEV_PASSWORD 裡這組密碼沒寫名字的話，就叫「開發者」
  const name = me.name || "開發者";
  $("dev-name").textContent = name;
  showAvatar(me.avatar, name);
  // 副標在環境變數 DEV_PROFILES 設定（見 server/dev.py）；沒設定就顯示登入時間
  const time = new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  $("dev-hello-sub").textContent = me.subtitle || `已登入開發者專區 · ${time}`;
  $("login-error").classList.add("hidden");
  $("login").classList.add("hidden");
  $("panel").classList.remove("hidden");
  refreshStatus();
  loadSettings();
  loadSiteDesign();
  clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, 3000);
}

/** 有設定頭像圖片就顯示圖片；沒設定或圖片讀不到，就顯示名字的第一個字。 */
function showAvatar(url, name) {
  const box = $("dev-avatar");
  box.textContent = Array.from(name)[0];
  if (!url) return;
  const img = document.createElement("img");
  img.alt = "";
  img.addEventListener("load", () => box.replaceChildren(img));
  img.src = url;
}

function logout(message) {
  password = "";
  clearInterval(statusTimer);
  try { sessionStorage.removeItem(KEY_PASSWORD); } catch { /* 忽略 */ }
  $("panel").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("password-input").value = "";
  if (message) {
    $("login-error").textContent = message;
    $("login-error").classList.remove("hidden");
  }
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  login($("password-input").value);
});

$("logout").addEventListener("click", () => logout());

// ---------- 伺服器狀態 ----------

function statCell(label, value) {
  const cell = document.createElement("div");
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = String(value);
  cell.append(small, strong);
  return cell;
}

async function refreshStatus() {
  if (!password) return;
  await run(async () => {
    const status = await api("GET", "/status");
    renderStatus(status);
  });
}

// ---------- 房間控制面板：房主能做的事，開發者對每間房間都能做 ----------

const openRooms = new Set();  // 展開中的房間；每 3 秒重畫時保留展開狀態

function smallButton(label, onClick, extraClass = "") {
  const button = document.createElement("button");
  button.className = `secondary small ${extraClass}`.trim();
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/** 對房間做一個操作，成功後跳提示並立刻更新狀態。 */
function roomAction(room, path, body, message) {
  run(async () => {
    await api("POST", `/rooms/${room.code}/${path}`, body);
    toast(message);
    refreshStatus();
  });
}

function buildRoomPanel(room, categoryNames) {
  const panel = document.createElement("details");
  panel.className = "room-panel";
  panel.open = openRooms.has(room.code);
  panel.addEventListener("toggle", () => {
    if (panel.open) openRooms.add(room.code);
    else openRooms.delete(room.code);
  });

  // 摘要列：房號、狀態、人數
  const summary = document.createElement("summary");
  const code = document.createElement("strong");
  code.className = "room-row-code";
  code.textContent = room.code;
  const info = document.createElement("span");
  info.className = "room-row-info";
  const round = room.round ? ` · 第 ${room.round} 局` : "";
  info.textContent = `${STATE_LABELS[room.state] || room.state} · ${room.category}${round}`;
  const count = document.createElement("span");
  count.className = "hint-inline";
  count.textContent = room.spectators
    ? `${room.players.length} 人 · ${room.spectators} 觀戰`
    : `${room.players.length} 人`;
  summary.append(code, info, count);
  panel.append(summary);

  const body = document.createElement("div");
  body.className = "room-panel-body";

  // 玩家：每個人都可以踢
  const players = document.createElement("ul");
  players.className = "room-players";
  for (const player of room.players) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "player-name";
    // 用 textContent：暱稱是玩家輸入的，不能當 HTML
    name.textContent = player.nickname;
    const marks = document.createElement("span");
    marks.className = "hint-inline";
    marks.textContent = [
      player.host && "房主",
      player.bot && "機器人",
      !player.online && "離線",
      player.finished && "已完成",
      room.round > 0 && `${player.wins} 勝`,
    ].filter(Boolean).join(" · ");
    const kick = smallButton("踢出", () => {
      if (!confirm(`確定要把「${player.nickname}」請出房間 ${room.code}？`)) return;
      roomAction(room, "kick", { playerId: player.id }, `已把「${player.nickname}」請出房間`);
    }, "danger");
    li.append(name, marks, kick);
    players.append(li);
  }
  if (room.players.length === 0) {
    const li = document.createElement("li");
    li.className = "stats-sub";
    li.textContent = "（沒有人）";
    players.append(li);
  }

  // 文章分類
  const categoryField = document.createElement("label");
  categoryField.className = "room-category";
  categoryField.textContent = "文章分類";
  const select = document.createElement("select");
  for (const name of categoryNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  select.value = room.category;
  select.disabled = !["lobby", "finished"].includes(room.state);
  select.addEventListener("change", () => {
    roomAction(room, "category", { category: select.value }, `分類已改成「${select.value}」`);
    select.blur();
  });
  categoryField.append(select);

  // 比賽控制：依目前狀態只開放合理的按鈕
  const idle = room.state === "lobby" || room.state === "finished";
  const controls = document.createElement("div");
  controls.className = "room-controls";
  const start = smallButton(room.state === "finished" ? "再來一局" : "開始比賽", () => {
    roomAction(room, "start", { category: room.category }, `房間 ${room.code} 開始倒數`);
  });
  start.disabled = !idle || room.players.length === 0;
  const stop = smallButton("結束比賽", () => {
    const waiting = room.players.filter((p) => p.online && !p.finished).length;
    if (waiting && !confirm(`還有 ${waiting} 人沒打完，確定要強制結束？`)) return;
    roomAction(room, "stop", undefined, `房間 ${room.code} 已結束比賽`);
  });
  stop.disabled = room.state !== "racing";
  const lobby = smallButton("回到 Lobby", () => {
    roomAction(room, "restart", undefined, `房間 ${room.code} 回到 Lobby`);
  });
  lobby.disabled = room.state === "lobby";
  const reset = smallButton("重設勝場", () => {
    if (!confirm(`確定要把房間 ${room.code} 所有人的勝場歸零？`)) return;
    roomAction(room, "reset-scores", undefined, "勝場已歸零");
  });
  reset.disabled = !idle || room.round === 0;
  controls.append(start, stop, lobby, reset);

  // 房間管理
  const manage = document.createElement("div");
  manage.className = "room-controls";
  // 開新分頁觀戰：用 window.open 開的分頁會複製一份 sessionStorage，所以不用再登入
  const watch = smallButton("觀戰", () => {
    window.open(`/?spectate=${room.code}`, "_blank");
  });
  const bots = smallButton("加機器人", () => {
    $("bot-room").value = room.code;
    $("bot-form").scrollIntoView({ behavior: "smooth", block: "center" });
    $("bot-count").focus();
  });
  const rename = smallButton("改房號", () => {
    const input = prompt(`把房間 ${room.code} 改成什麼房號？（4 個英文字母或數字）`, "");
    if (input === null || !input.trim()) return;
    run(async () => {
      const result = await api("POST", `/rooms/${room.code}/rename`, { code: input.trim() });
      openRooms.delete(room.code);
      openRooms.add(result.code);
      toast(`房號已從 ${room.code} 改成 ${result.code}`);
      refreshStatus();
    });
  });
  const close = smallButton("關閉房間", () => {
    if (!confirm(`確定要關閉房間 ${room.code}？裡面的人會被踢回首頁。`)) return;
    roomAction(room, "close", undefined, `已關閉房間 ${room.code}`);
  }, "danger");
  manage.append(watch, bots, rename, close);

  body.append(players, categoryField, controls, manage);
  panel.append(body);
  return panel;
}

function renderStatus(status) {
  $("status-grid").replaceChildren(
    statCell("版本", `v${status.version}`),
    statCell("運作時間", formatUptime(status.uptime)),
    statCell("房間數", status.rooms.length),
    statCell("在線玩家", status.onlinePlayers),
    statCell("玩家總數", status.totalPlayers),
  );
  $("status-updated").textContent = `更新於 ${new Date().toLocaleTimeString()}`;

  const list = $("room-list");
  // 正在用下拉選單時不要重畫，不然選單會在手上被關掉
  if (document.activeElement && document.activeElement.tagName === "SELECT"
      && list.contains(document.activeElement)) {
    return;
  }
  list.innerHTML = "";
  if (status.rooms.length === 0) {
    const empty = document.createElement("p");
    empty.className = "stats-sub";
    empty.textContent = "目前沒有房間";
    list.append(empty);
  }
  const categoryNames = Object.keys(status.categories);
  for (const room of status.rooms) {
    list.append(buildRoomPanel(room, categoryNames));
  }

  // 已經不存在的房間，順便忘掉它的展開狀態
  const codes = new Set(status.rooms.map((room) => room.code));
  for (const code of openRooms) if (!codes.has(code)) openRooms.delete(code);

  $("category-summary").textContent = "文章庫：" + Object.entries(status.categories)
    .map(([name, count]) => `${name} ${count} 篇`).join("、");
}

// ---------- 測試工具 ----------

$("bot-room").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase();
});

$("bot-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const result = await api("POST", "/bots", {
      room: $("bot-room").value.trim(),
      count: Number($("bot-count").value) || 1,
      cpm: Number($("bot-cpm").value) || 120,
    });
    toast(`加入了 ${result.added} 個機器人`);
    refreshStatus();
  });
});

$("bot-clear").addEventListener("click", () => {
  const code = $("bot-room").value.trim();
  if (!code) {
    toast("請先填房號");
    return;
  }
  run(async () => {
    const result = await api("DELETE", `/bots/${encodeURIComponent(code)}`);
    toast(`移除了 ${result.removed} 個機器人`);
    refreshStatus();
  });
});

$("announce-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const result = await api("POST", "/announce", { message: $("announce-text").value });
    toast(`已發送到 ${result.rooms} 間房間`);
    $("announce-text").value = "";
  });
});

// ---------- 設定 ----------

function renderSettings(settings) {
  const box = $("settings-fields");
  box.innerHTML = "";
  for (const [name, item] of Object.entries(settings)) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.htmlFor = `setting-${name}`;
    label.textContent = `${item.label}（${item.min}～${item.max}）`;
    const input = document.createElement("input");
    input.id = `setting-${name}`;
    input.type = "number";
    input.min = item.min;
    input.max = item.max;
    input.value = item.value;
    input.dataset.name = name;
    field.append(label, input);
    box.append(field);
  }
}

async function loadSettings() {
  await run(async () => renderSettings(await api("GET", "/settings")));
}

$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = {};
  for (const input of $("settings-fields").querySelectorAll("input")) {
    body[input.dataset.name] = Number(input.value);
  }
  run(async () => {
    renderSettings(await api("PUT", "/settings", body));
    toast("設定已儲存");
  });
});

$("reload-articles").addEventListener("click", () => {
  run(async () => {
    const categories = await api("POST", "/reload-articles");
    const total = Object.values(categories).reduce((sum, n) => sum + n, 0);
    toast(`已重新載入：${Object.keys(categories).length} 個分類、${total} 篇文章`);
    refreshStatus();
  });
});

// ---------- 全站設計 ----------

function renderSiteDesign(data) {
  const box = $("site-design-options");
  box.innerHTML = "";
  for (const [value, label] of Object.entries(data.options)) {
    const option = document.createElement("label");
    option.className = "design-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "site-design";
    radio.value = value;
    radio.checked = value === data.design;
    radio.addEventListener("change", () => {
      if (!confirm(`要把所有玩家的介面換成「${label}」嗎？大家重新整理網頁後就會套用。`)) {
        renderSiteDesign(data);  // 取消就把選擇改回去
        return;
      }
      run(async () => {
        renderSiteDesign(await api("PUT", "/design", { design: value }));
        toast(`全站設計已換成「${label}」`);
      });
    });
    const text = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = label;
    const small = document.createElement("small");
    small.textContent = value === data.design ? "目前所有玩家看到的設計" : "點選後套用到所有玩家";
    text.append(strong, small);
    option.append(radio, text);
    box.append(option);
  }
}

async function loadSiteDesign() {
  await run(async () => renderSiteDesign(await api("GET", "/design")));
}

// ---------- 介面設計預覽 ----------
// 實際載入樣式的是 theme.js；這裡只負責記住選擇，然後重新整理讓它生效

const KEY_DESIGN = "typing:design";

let currentDesign = "";
try { currentDesign = localStorage.getItem(KEY_DESIGN) || ""; } catch { /* 忽略 */ }
for (const radio of document.querySelectorAll('input[name="design"]')) {
  radio.checked = radio.value === currentDesign;
  radio.addEventListener("change", () => {
    try {
      if (radio.value) localStorage.setItem(KEY_DESIGN, radio.value);
      else localStorage.removeItem(KEY_DESIGN);
    } catch { /* 忽略 */ }
    location.reload();
  });
}

// ---------- 啟動 ----------

let savedPassword = null;
try { savedPassword = sessionStorage.getItem(KEY_PASSWORD); } catch { /* 忽略 */ }
if (savedPassword) login(savedPassword);
