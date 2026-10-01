"use strict";

const $ = (id) => document.getElementById(id);

// ---------- 儲存 ----------
// localStorage 在隱私視窗或封鎖 cookie 時會丟錯，所以一律包 try
const KEY_NICKNAME = "typing:nickname";
const keyPlayer = (code) => `typing:player:${code}`;
const keyDraft = (code) => `typing:draft:${code}`;

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 忽略 */ }
}

// 身分 token 與打字內容放 sessionStorage，每個分頁各自獨立：
// 同一台電腦開兩個分頁就是兩個玩家（方便測試），
// 而重新整理同一個分頁時資料還在，所以能接回原本的身分與進度。
function loadSession(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function saveSession(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* 忽略 */ }
}
function dropSession(key) {
  try { sessionStorage.removeItem(key); } catch { /* 忽略 */ }
}

// ---------- 正規化 ----------
// 必須跟後端 server/scoring.py 的 PUNCTUATION_MAP 一致，
// 否則畫面上的高亮位置會跟伺服器判定的進度對不起來。
const PUNCTUATION_MAP = {
  ",": "，", ".": "。", "!": "！", "?": "？",
  ":": "：", ";": "；", "(": "（", ")": "）", "~": "～",
};

function normalize(text) {
  let result = "";
  for (const char of text) {
    if (/\s/.test(char)) continue;
    result += PUNCTUATION_MAP[char] ?? char;
  }
  return result;
}

function commonPrefixLength(typed, target) {
  const limit = Math.min(typed.length, target.length);
  let index = 0;
  while (index < limit && typed[index] === target[index]) index += 1;
  return index;
}

// ---------- 狀態 ----------

let ws = null;
let roomCode = null;
let pendingCode = "";
let myId = null;
let leaving = false;
let retryDelay = 1000;
let pingTimer = null;

let room = null;          // 最後一次收到的房間快照
let article = "";         // 這一局的文章
let raceStart = null;     // performance.now() 基準
let tickTimer = null;
let graceDeadline = null; // 追趕時間的截止時刻

// ---------- 畫面切換 ----------

const SCREENS = ["home", "lobby", "race", "result"];

function showScreen(name) {
  for (const screen of SCREENS) {
    $(`screen-${screen}`).classList.toggle("hidden", screen !== name);
  }
}

function showError(message) {
  const box = $("home-error");
  box.textContent = message;
  box.classList.remove("hidden");
}

function clearError() {
  $("home-error").classList.add("hidden");
}

let toastTimer = null;
function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add("hidden"), 2200);
}

// ---------- 連線 ----------

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function openSocket() {
  const code = roomCode || pendingCode;
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  ws = new WebSocket(url);

  ws.onopen = () => {
    send({
      type: "join",
      room: code,
      nickname: $("nickname-input").value.trim(),
      playerId: code ? loadSession(keyPlayer(code)) : null,
    });
  };

  ws.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handle(message);
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    if (leaving || !roomCode) return;
    // 非自願斷線 → 顯示提示並退避重連
    $("banner").classList.remove("hidden");
    setTimeout(openSocket, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  };
}

function handle(message) {
  switch (message.type) {
    case "joined":
      roomCode = message.code;
      myId = message.playerId;
      saveSession(keyPlayer(roomCode), myId);
      history.replaceState(null, "", `/?room=${roomCode}`);
      retryDelay = 1000;
      $("banner").classList.add("hidden");
      clearError();
      // 閒置太久中間的代理可能切斷連線，定時送 ping 保活
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ type: "ping" }), 25000);
      break;

    case "room":
      onRoom(message);
      break;

    case "countdown":
      runCountdown(message.seconds);
      break;

    case "go":
      onGo();
      break;

    case "notice":
      toast(message.message || "");
      break;

    case "error":
    case "kicked":
      leaving = true;
      if (roomCode) {
        dropSession(keyPlayer(roomCode));
        dropSession(keyDraft(roomCode));
      }
      resetToHome();
      showError(message.message || "發生錯誤");
      break;
  }
}

function resetToHome() {
  clearInterval(pingTimer);
  stopTimer();
  roomCode = null;
  myId = null;
  room = null;
  $("banner").classList.add("hidden");
  history.replaceState(null, "", "/");
  showScreen("home");
}

// ---------- 房間快照 ----------

function me() {
  return room ? room.players.find((p) => p.id === myId) : null;
}

function isHost() {
  return room !== null && room.hostId === myId;
}

function onRoom(snapshot) {
  const previousState = room ? room.state : null;
  room = snapshot;

  if (snapshot.state === "lobby") {
    if (previousState && previousState !== "lobby") {
      // 回到 Lobby（開下一局）→ 清掉上一局的殘留
      stopTimer();
      graceDeadline = null;
      article = "";
      $("typing-input").value = "";
      dropSession(keyDraft(roomCode));
    }
    renderLobby();
    showScreen("lobby");
    return;
  }

  if (snapshot.state === "countdown" || snapshot.state === "racing") {
    if (article !== snapshot.text) {
      article = snapshot.text;
      $("typing-input").value = "";
    }
    showScreen("race");

    // 中途重連：用伺服器給的 elapsed 把計時器接回正確秒數
    if (snapshot.state === "racing" && raceStart === null && typeof snapshot.elapsed === "number") {
      raceStart = performance.now() - snapshot.elapsed * 1000;
      const draft = loadSession(keyDraft(roomCode));
      if (draft && !$("typing-input").value) $("typing-input").value = draft;
      startTimer();
      enableInput();
    }

    renderProgress();
    refreshArticle();
    return;
  }

  if (snapshot.state === "finished") {
    stopTimer();
    graceDeadline = null;
    disableInput();
    renderResult();
    showScreen("result");
  }
}

// ---------- Lobby ----------

function makeTag(text, extraClass) {
  const span = document.createElement("span");
  span.className = extraClass ? `tag ${extraClass}` : "tag";
  span.textContent = text;
  return span;
}

function renderLobby() {
  $("room-code-display").textContent = room.code;
  $("player-count").textContent = `${room.players.length} / ${room.maxPlayers}`;

  const list = $("player-list");
  list.innerHTML = "";
  for (const player of room.players) {
    const li = document.createElement("li");
    if (!player.online) li.classList.add("offline");

    const dot = document.createElement("span");
    dot.className = player.online ? "dot" : "dot off";

    const name = document.createElement("span");
    name.className = "player-name";
    // 用 textContent 而不是 innerHTML：暱稱是別人輸入的，不能當成 HTML 執行
    name.textContent = player.nickname;

    li.append(dot, name);
    if (player.id === room.hostId) li.append(makeTag("房主"));
    if (player.id === myId) li.append(makeTag("你", "me"));
    list.append(li);
  }

  const host = isHost();
  renderCategories();
  $("category-field").classList.toggle("hidden", !host);
  $("custom-text-box").classList.toggle("hidden", !host);
  $("start-btn").disabled = !host;

  const note = $("category-note");
  note.classList.toggle("hidden", host);
  note.textContent = host ? "" : `文章分類：${room.category || "—"}`;

  $("lobby-hint").textContent = host
    ? "所有人會同時倒數、同時開始"
    : "等待房主開始遊戲";
}

function renderCategories() {
  const select = $("category-select");
  const available = room.categories || [];
  const upcoming = room.upcoming || [];

  // 每次廣播都重建選單會把房主選到一半的值清掉，所以內容沒變就不動
  const signature = JSON.stringify([available, upcoming]);
  if (select.dataset.signature !== signature) {
    select.innerHTML = "";
    for (const name of available) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    }
    for (const name of upcoming) {
      const option = document.createElement("option");
      option.textContent = name;
      option.disabled = true;   // 預告而已，選不了
      select.append(option);
    }
    select.dataset.signature = signature;
  }

  if (room.category && select.value !== room.category) {
    select.value = room.category;
  }
}

// ---------- 倒數與比賽 ----------

function runCountdown(seconds) {
  const overlay = $("countdown");
  const number = $("countdown-number");
  showScreen("race");
  disableInput();
  $("typing-input").value = "";
  $("typing-hint").textContent = "";
  $("grace-hint").textContent = "";
  $("race-timer").textContent = "0.0";
  overlay.classList.remove("hidden");

  let remaining = seconds;
  number.textContent = String(remaining);
  const timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
      overlay.classList.add("hidden");
    } else {
      number.textContent = String(remaining);
    }
  }, 1000);
}

function onGo() {
  $("countdown").classList.add("hidden");
  raceStart = performance.now();
  graceDeadline = null;
  enableInput();
  startTimer();
}

function enableInput() {
  const field = $("typing-input");
  field.disabled = false;
  field.placeholder = "在這裡輸入";
  field.focus();
}

function disableInput() {
  const field = $("typing-input");
  field.disabled = true;
  field.placeholder = "倒數結束後開始輸入…";
}

function startTimer() {
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 100);
  tick();
}

function stopTimer() {
  clearInterval(tickTimer);
  tickTimer = null;
  raceStart = null;
}

function tick() {
  const self = me();
  if (self && self.seconds !== null) {
    // 已完成 → 顯示伺服器算出來的正式秒數並停錶
    $("race-timer").textContent = self.seconds.toFixed(1);
    clearInterval(tickTimer);
    tickTimer = null;
    return;
  }
  if (raceStart !== null) {
    $("race-timer").textContent = ((performance.now() - raceStart) / 1000).toFixed(1);
  }
  if (graceDeadline !== null) {
    const left = Math.max(0, Math.ceil((graceDeadline - performance.now()) / 1000));
    $("grace-hint").textContent = `已經有人完成，追趕時間還剩 ${left} 秒`;
  }
}

// ---------- 文章顯示 ----------

function refreshArticle() {
  const typed = normalize($("typing-input").value);
  const prefix = commonPrefixLength(typed, article);
  const hasError = typed.length > prefix;

  $("art-done").textContent = article.slice(0, prefix);
  const cursor = $("art-cursor");
  cursor.textContent = article.slice(prefix, prefix + 1);
  cursor.className = hasError ? "cursor error" : "cursor";
  $("art-rest").textContent = article.slice(prefix + 1);

  $("race-progress").textContent = `${prefix} / ${article.length}`;
  const self = me();
  if (self && self.seconds !== null) return;
  $("typing-hint").textContent = hasError
    ? `第 ${prefix + 1} 個字不對，要退回去改掉才能繼續`
    : "";
}

// ---------- 其他玩家的進度 ----------

function renderProgress() {
  const list = $("progress-list");
  list.innerHTML = "";

  const total = room.total || 1;
  const sorted = [...room.players].sort((a, b) => {
    const aDone = a.seconds !== null;
    const bDone = b.seconds !== null;
    if (aDone !== bDone) return aDone ? -1 : 1;
    if (aDone && bDone) return a.seconds - b.seconds;
    return b.progress - a.progress;
  });

  let someoneFinished = false;

  for (const player of sorted) {
    if (player.seconds !== null) someoneFinished = true;

    const li = document.createElement("li");
    if (!player.online) li.classList.add("offline");

    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.id === myId ? `${player.nickname}（你）` : player.nickname;

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = player.seconds !== null ? "fill done" : "fill";
    fill.style.width = `${Math.round((player.progress / total) * 100)}%`;
    bar.append(fill);

    const stat = document.createElement("span");
    stat.className = "stat";
    stat.textContent = player.seconds !== null
      ? `${player.seconds.toFixed(1)}s`
      : String(player.progress);

    li.append(name, bar, stat);
    list.append(li);
  }

  const self = me();
  if (someoneFinished && graceDeadline === null && self && self.seconds === null) {
    graceDeadline = performance.now() + 60000;
  }
  if (self && self.seconds !== null) {
    disableInput();
    $("typing-hint").textContent = "完成！等其他人打完就會公布成績";
    $("grace-hint").textContent = "";
  }
}

// ---------- 結果 ----------

function renderResult() {
  const list = $("result-list");
  list.innerHTML = "";

  const byId = new Map(room.players.map((p) => [p.id, p]));
  const order = room.ranking || room.players.map((p) => p.id);

  order.forEach((id, index) => {
    const player = byId.get(id);
    if (!player) return;

    const li = document.createElement("li");
    if (player.id === myId) li.classList.add("mine");

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(index + 1);

    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.nickname;

    const score = document.createElement("span");
    score.className = "score";
    if (player.seconds !== null) {
      // 秒數為 0 時除法會變成 Infinity，雖然真人打不到，還是擋一下
      const cpm = player.seconds > 0 ? Math.round(room.total / (player.seconds / 60)) : 0;
      score.textContent = `${player.seconds.toFixed(1)} 秒 · ${cpm} 字/分`;
    } else {
      score.classList.add("dnf");
      score.textContent = `未完成 ${player.progress} / ${room.total} 字`;
    }

    li.append(rank, name, score);
    list.append(li);
  });

  const host = isHost();
  $("again-btn").disabled = !host;
  $("result-hint").textContent = host ? "" : "等待房主開始下一局";
}

// ---------- 打字輸入 ----------

const typingInput = $("typing-input");
let composing = false;
let sendTimer = null;
let pendingSend = false;

function flushInput() {
  pendingSend = false;
  send({ type: "input", text: typingInput.value });
}

function queueSend(immediate) {
  if (immediate) {
    clearTimeout(sendTimer);
    sendTimer = null;
    flushInput();
    return;
  }
  pendingSend = true;
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    if (pendingSend) flushInput();
  }, 200);
}

function onTyped() {
  if (typingInput.disabled) return;
  saveSession(keyDraft(roomCode), typingInput.value);
  refreshArticle();
  // 打完整篇時立刻送出，不要被節流延遲拖慢成績
  queueSend(normalize(typingInput.value) === article);
}

// 中文 IME 的關鍵：組字（注音／拼音還沒選字）過程中的內容不能拿去比對，
// 要等 compositionend 字真正確定之後才算。
typingInput.addEventListener("compositionstart", () => { composing = true; });
typingInput.addEventListener("compositionend", () => { composing = false; onTyped(); });
typingInput.addEventListener("input", (event) => {
  if (composing || event.isComposing) return;
  onTyped();
});
typingInput.addEventListener("paste", (event) => {
  event.preventDefault();
  toast("比賽中不能貼上");
});
typingInput.addEventListener("drop", (event) => event.preventDefault());

// ---------- 使用者操作 ----------

function enter(code) {
  const nickname = $("nickname-input").value.trim();
  if (!nickname) {
    showError("請先輸入暱稱");
    $("nickname-input").focus();
    return;
  }
  if (code === null) {
    showError("請輸入 4 位房號");
    $("room-code-input").focus();
    return;
  }
  save(KEY_NICKNAME, nickname);
  clearError();
  leaving = false;
  pendingCode = code;
  openSocket();
}

$("create-btn").addEventListener("click", () => enter(""));

$("join-btn").addEventListener("click", () => {
  const code = $("room-code-input").value.trim().toUpperCase();
  enter(code.length === 4 ? code : null);
});

$("room-code-input").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase();
});

$("room-code-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("join-btn").click();
});

$("nickname-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const code = $("room-code-input").value.trim();
    (code ? $("join-btn") : $("create-btn")).click();
  }
});

$("copy-btn").addEventListener("click", async () => {
  const link = `${location.origin}/?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("連結已複製");
  } catch {
    // 沒有剪貼簿權限時，至少讓他能手動複製
    prompt("請手動複製這個連結：", link);
  }
});

$("custom-text").addEventListener("input", (event) => {
  $("custom-count").textContent = String(normalize(event.target.value).length);
});

$("category-select").addEventListener("change", (event) => {
  // 立刻同步給其他人，他們的 Lobby 才看得到房主選了什麼
  send({ type: "category", category: event.target.value });
});

$("start-btn").addEventListener("click", () => {
  send({
    type: "start",
    text: $("custom-text").value,
    category: $("category-select").value,
  });
});

$("again-btn").addEventListener("click", () => send({ type: "restart" }));

function leave() {
  leaving = true;
  if (roomCode) {
    dropSession(keyPlayer(roomCode));
    dropSession(keyDraft(roomCode));
  }
  if (ws) ws.close();
  resetToHome();
}

$("leave-btn").addEventListener("click", leave);
$("leave-btn-2").addEventListener("click", leave);

// ---------- 啟動 ----------

const savedNickname = load(KEY_NICKNAME);
if (savedNickname) $("nickname-input").value = savedNickname;

const urlRoom = (new URLSearchParams(location.search).get("room") || "").trim().toUpperCase();
if (urlRoom) $("room-code-input").value = urlRoom;

// 重新整理網頁時，如果這間房間的身分還在，就自動接回去
if (urlRoom && savedNickname && loadSession(keyPlayer(urlRoom))) {
  enter(urlRoom);
}
