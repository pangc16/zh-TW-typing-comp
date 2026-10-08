"use strict";

const $ = (id) => document.getElementById(id);

// ---------- 儲存 ----------
// localStorage 在隱私視窗或封鎖 cookie 時會丟錯，所以一律包 try
const KEY_NICKNAME = "typing:nickname";
const keyPlayer = (code) => `typing:player:${code}`;
const keyDraft = (code) => `typing:draft:${code}`;
const keyRound = (code) => `typing:round:${code}`;
const KEY_STATS = "typing:stats";
const KEY_DEV_PASSWORD = "typing:dev-password";  // 開發者專區登入時存的，觀戰要用

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

// ---------- 個人紀錄 ----------
// 只存在這台電腦的瀏覽器（localStorage），換電腦或清除網站資料就會不見。

const RECENT_LIMIT = 20;  // 平均 CPM 只算最近幾局

function emptyStats() {
  return { games: 0, finished: 0, bestCpm: 0, errors: 0, misses: {}, recent: [] };
}

function loadStats() {
  try {
    const data = JSON.parse(load(KEY_STATS) || "null");
    if (data && Array.isArray(data.recent) && data.misses) return data;
  } catch { /* 資料壞掉就重來 */ }
  return emptyStats();
}

function saveStats(stats) {
  save(KEY_STATS, JSON.stringify(stats));
}

function topEntries(counts, limit) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function formatMisses(counts, limit) {
  return topEntries(counts, limit).map(([char, count]) => `「${char}」×${count}`).join("、");
}

function cpmOf(chars, seconds) {
  // 秒數為 0 時除法會變成 Infinity，雖然真人打不到，還是擋一下
  return seconds > 0 ? Math.round(chars / (seconds / 60)) : 0;
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

// 觀戰模式：網址是 /?spectate=房號（從開發者專區的「觀戰」按鈕進來）。
// 只看不打：看得到所有人的進度，但不是玩家，也不會寫進個人紀錄。
const spectateCode = (new URLSearchParams(location.search).get("spectate") || "").trim().toUpperCase();
const spectating = spectateCode !== "";
// 觀戰時指定要看的玩家（點跑道切換）；null 代表自動跟著領先者
let focusId = null;
// 自動跟領先者時的防抖：新的領先者要維持領先一段時間才換人，兩個人一直互相超車時畫面才不會跳來跳去
const LEADER_SWITCH_DELAY = 1500;  // 毫秒
let autoLeaderId = null;    // 目前自動跟著的人
let leaderCandidate = null; // 想取代他的新領先者
let candidateSince = 0;     // 新領先者從什麼時候開始領先

// 這一局自己的打錯紀錄。存一份在 sessionStorage，重新整理也不會不見。
// { raceId, errors, misses: {字: 次數}, wasError, summary }
let roundLog = null;

// ---------- 畫面切換 ----------

const SCREENS = ["home", "lobby", "race", "result"];

function showScreen(name) {
  for (const screen of SCREENS) {
    $(`screen-${screen}`).classList.toggle("hidden", screen !== name);
  }
  // 比賽畫面要看長文章，版面放寬；其他畫面維持窄版
  document.querySelector(".app").classList.toggle("race-wide", name === "race");
  // 開發者專區的小卡片只放在首頁，免得比賽時擋到畫面
  $("dev-corner").classList.toggle("hidden", name !== "home");
}

// 首頁分三步：name（輸入暱稱）→ choose（建立或加入）→ join（輸入房號）
const HOME_STEPS = ["name", "choose", "join"];

function showStep(name) {
  for (const step of HOME_STEPS) {
    $(`step-${step}`).classList.toggle("hidden", step !== name);
  }
  clearError();
  if (name === "name") $("nickname-input").focus();
  if (name === "choose") $("greeting-name").textContent = $("nickname-input").value.trim();
  if (name === "join") $("room-code-input").focus();
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
    if (spectating) {
      send({ type: "spectate", room: code, password: loadSession(KEY_DEV_PASSWORD) || "" });
      return;
    }
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
    case "joined": {
      // 用舊房號重連時，伺服器會回傳改過的新房號
      const requested = roomCode || pendingCode;
      if (requested && requested !== message.code) moveRoomCode(requested, message.code);
      roomCode = message.code;
      myId = message.playerId;
      saveSession(keyPlayer(roomCode), myId);
      onConnected();
      break;
    }

    case "spectating":
      roomCode = message.code;
      $("spectate-code").textContent = roomCode;
      onConnected();
      break;

    case "renamed":
      // 管理員在開發者專區幫房間換了房號
      if (roomCode) moveRoomCode(roomCode, message.code);
      roomCode = message.code;
      pendingCode = message.code;
      history.replaceState(null, "", roomUrl(roomCode));
      if (spectating) $("spectate-code").textContent = roomCode;
      toast(`房號已改成 ${roomCode}`);
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
      if (spectating) {
        alert(message.message || "發生錯誤");
        location.href = "/dev.html";
        return;
      }
      if (roomCode) {
        dropSession(keyPlayer(roomCode));
        dropSession(keyDraft(roomCode));
        dropSession(keyRound(roomCode));
      }
      resetToHome();
      showError(message.message || "發生錯誤");
      break;
  }
}

function roomUrl(code) {
  return spectating ? `/?spectate=${code}` : `/?room=${code}`;
}

/** 連上房間之後（加入或觀戰）共用的收尾。 */
function onConnected() {
  history.replaceState(null, "", roomUrl(roomCode));
  retryDelay = 1000;
  $("banner").classList.add("hidden");
  clearError();
  // 閒置太久中間的代理可能切斷連線，定時送 ping 保活
  clearInterval(pingTimer);
  pingTimer = setInterval(() => send({ type: "ping" }), 25000);
}

/** 房號改了：把存在這個分頁的身分、草稿、本局紀錄搬到新房號底下。 */
function moveRoomCode(oldCode, newCode) {
  for (const makeKey of [keyPlayer, keyDraft, keyRound]) {
    const value = loadSession(makeKey(oldCode));
    if (value !== null) saveSession(makeKey(newCode), value);
    dropSession(makeKey(oldCode));
  }
}

function resetToHome() {
  clearInterval(pingTimer);
  stopTimer();
  roomCode = null;
  myId = null;
  room = null;
  roundLog = null;
  $("banner").classList.add("hidden");
  history.replaceState(null, "", "/");
  renderStats();
  showScreen("home");
}

// ---------- 這一局的打錯紀錄 ----------

function persistRoundLog() {
  if (roundLog && roomCode) saveSession(keyRound(roomCode), JSON.stringify(roundLog));
}

/** 取回這一局的紀錄；沒參加這局（例如結算後才進房）就回傳 null。 */
function restoreRoundLog(raceId) {
  if (roundLog && roundLog.raceId === raceId) return roundLog;
  try {
    const stored = JSON.parse(loadSession(keyRound(roomCode)) || "null");
    if (stored && stored.raceId === raceId) roundLog = stored;
  } catch { /* 忽略 */ }
  return roundLog && roundLog.raceId === raceId ? roundLog : null;
}

function beginRoundLog(raceId) {
  if (restoreRoundLog(raceId)) return;
  roundLog = { raceId, errors: 0, misses: {}, wasError: false, summary: null };
  persistRoundLog();
}

/** 從「打對」變成「打錯」的那一刻算一次，並記下原本該打的字。 */
function trackErrors(typed) {
  if (!roundLog || !room || roundLog.raceId !== room.raceId) return;
  const prefix = commonPrefixLength(typed, article);
  const hasError = typed.length > prefix;
  if (hasError && !roundLog.wasError) {
    roundLog.errors += 1;
    const expected = article[prefix];
    if (expected) roundLog.misses[expected] = (roundLog.misses[expected] || 0) + 1;
  }
  roundLog.wasError = hasError;
  persistRoundLog();
}

/** 比賽結束時把這一局寫進個人紀錄，每局只寫一次。 */
function recordRound() {
  const log = room.raceId ? restoreRoundLog(room.raceId) : null;
  if (!log || log.summary) return;

  const self = me();
  const cpm = self && self.seconds !== null ? cpmOf(room.total, self.seconds) : null;

  const stats = loadStats();
  const previousBest = stats.bestCpm;
  stats.games += 1;
  stats.errors += log.errors;
  for (const [char, count] of Object.entries(log.misses)) {
    stats.misses[char] = (stats.misses[char] || 0) + count;
  }
  if (cpm !== null) {
    stats.finished += 1;
    stats.bestCpm = Math.max(stats.bestCpm, cpm);
  }
  stats.recent = [...stats.recent, { cpm, errors: log.errors }].slice(-RECENT_LIMIT);
  saveStats(stats);

  log.summary = {
    cpm,
    errors: log.errors,
    best: stats.bestCpm,
    newRecord: cpm !== null && previousBest > 0 && cpm > previousBest,
  };
  persistRoundLog();
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
    if (!spectating) beginRoundLog(snapshot.raceId);
    showScreen("race");

    // 中途重連：用伺服器給的 elapsed 把計時器接回正確秒數
    if (snapshot.state === "racing" && raceStart === null && typeof snapshot.elapsed === "number") {
      raceStart = performance.now() - snapshot.elapsed * 1000;
      startTimer();
      if (!spectating) {
        const draft = loadSession(keyDraft(roomCode));
        if (draft && !$("typing-input").value) $("typing-input").value = draft;
        enableInput();
      }
    }

    renderProgress();
    refreshArticle();
    return;
  }

  if (snapshot.state === "finished") {
    stopTimer();
    disableInput();
    if (!spectating) recordRound();
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
    if (player.bot) li.append(makeTag("機器人", "me"));
    if (room.round > 0) li.append(makeTag(`${player.wins} 勝`, "wins"));
    if (isHost() && player.id !== myId) {
      const kick = document.createElement("button");
      kick.className = "kick-btn";
      kick.textContent = "踢出";
      kick.addEventListener("click", () => {
        if (confirm(`確定要把「${player.nickname}」請出房間嗎？`)) {
          send({ type: "kick", playerId: player.id });
        }
      });
      li.append(kick);
    }
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

  const played = room.round > 0 ? `（已比 ${room.round} 局）` : "";
  $("lobby-hint").textContent = host
    ? `所有人會同時倒數、同時開始${played}`
    : `等待房主開始遊戲${played}`;
  $("reset-scores-btn").classList.toggle("hidden", !(host && room.round > 0));
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
  if (roomCode) dropSession(keyDraft(roomCode));
  $("typing-hint").textContent = "";
  $("race-cpm").textContent = "0";
  $("grace-hint").textContent = "";
  $("race-timer").textContent = "0.0";
  overlay.classList.remove("hidden");
  autoLeaderId = null;  // 新的一局重新判斷要跟誰

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
  if (!spectating) enableInput();
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
  if (spectating) {
    spectatorTick();
    return;
  }
  const self = me();
  if (self && self.seconds !== null) {
    // 已完成 → 顯示伺服器算出來的正式秒數並停錶
    $("race-timer").textContent = self.seconds.toFixed(1);
    $("race-cpm").textContent = String(cpmOf(room.total, self.seconds));
    clearInterval(tickTimer);
    tickTimer = null;
    return;
  }
  if (raceStart !== null) {
    const elapsed = (performance.now() - raceStart) / 1000;
    $("race-timer").textContent = elapsed.toFixed(1);
    const typed = normalize($("typing-input").value);
    $("race-cpm").textContent = String(cpmOf(commonPrefixLength(typed, article), elapsed));
  }
  if (room && room.state === "racing") renderTrack();
}

// ---------- 文章顯示 ----------

// ---------- 觀戰：要看誰 ----------

/** 觀戰中正在看的玩家：有指定就看他，沒有就看還沒完成的人裡面領先的那位（有防抖）。 */
function watchedPlayer() {
  if (!room || room.players.length === 0) return null;
  const chosen = room.players.find((p) => p.id === focusId);
  if (chosen) return chosen;

  const byId = new Map(room.players.map((p) => [p.id, p]));
  const order = standingOrder().map((id) => byId.get(id));
  const leader = order.find((p) => p.seconds === null) || order[0];
  const current = byId.get(autoLeaderId);

  // 還沒在跟誰、原本跟的人離開了、或他已經完成 → 立刻換，不用等
  if (!current || (current.seconds !== null && leader.seconds === null)) {
    autoLeaderId = leader.id;
    leaderCandidate = null;
    return leader;
  }
  if (leader.id === current.id) {
    leaderCandidate = null;
    return current;
  }
  // 有人超前了：先記下來，維持領先夠久才真的換過去
  const now = performance.now();
  if (leaderCandidate !== leader.id) {
    leaderCandidate = leader.id;
    candidateSince = now;
  } else if (now - candidateSince >= LEADER_SWITCH_DELAY) {
    autoLeaderId = leader.id;
    leaderCandidate = null;
    return leader;
  }
  return current;
}

/** 點跑道：指定看這個人；再點一次同一個人就回到自動跟著領先者。 */
function toggleFocus(playerId) {
  focusId = focusId === playerId ? null : playerId;
  renderTrack();
  refreshArticle();
  spectatorTick();
}

function spectatorTick() {
  const watched = watchedPlayer();
  const name = watched ? watched.nickname : "—";
  $("spectate-focus").textContent = focusId ? `正在看：${name}` : `自動跟著領先者（${name}）`;
  if (watched && watched.seconds !== null) {
    $("race-timer").textContent = watched.seconds.toFixed(1);
    $("race-cpm").textContent = String(cpmOf(room.total, watched.seconds));
  } else if (raceStart !== null) {
    const elapsed = (performance.now() - raceStart) / 1000;
    $("race-timer").textContent = elapsed.toFixed(1);
    $("race-cpm").textContent = String(cpmOf(watched ? watched.progress : 0, elapsed));
  }
  if (room && room.state === "racing") renderTrack();
}

function refreshArticle() {
  const typed = spectating ? "" : normalize($("typing-input").value);
  // 觀戰時游標跟著正在看的人走
  const watched = spectating ? watchedPlayer() : null;
  const prefix = spectating
    ? (watched ? watched.progress : 0)
    : commonPrefixLength(typed, article);
  const hasError = typed.length > prefix;

  $("art-done").textContent = article.slice(0, prefix);
  const cursor = $("art-cursor");
  cursor.textContent = article.slice(prefix, prefix + 1);
  cursor.className = hasError ? "cursor error" : "cursor";
  $("art-rest").textContent = article.slice(prefix + 1);

  $("race-progress").textContent = `${prefix} / ${article.length}`;
  if (spectating) return;
  const self = me();
  if (self && self.seconds !== null) return;
  $("typing-hint").textContent = hasError
    ? `第 ${prefix + 1} 個字不對，要退回去改掉才能繼續`
    : "";
}

// ---------- 賽道：所有人的即時進度 ----------

const lanes = new Map();  // playerId → 跑道 DOM，原地更新才有平滑動畫

/** 目前名次：完成的依秒數，沒完成的依進度。 */
function standingOrder() {
  return [...room.players].sort((a, b) => {
    const aDone = a.seconds !== null;
    const bDone = b.seconds !== null;
    if (aDone !== bDone) return aDone ? -1 : 1;
    if (aDone && bDone) return a.seconds - b.seconds;
    return b.progress - a.progress;
  }).map((p) => p.id);
}

function buildLane() {
  const li = document.createElement("li");
  li.className = "lane";
  li.innerHTML = `
    <div class="lane-head">
      <span class="lane-rank"></span>
      <span class="player-name"></span>
      <span class="stat"></span>
    </div>
    <div class="track"><div class="runner"></div></div>`;
  if (spectating) {
    li.title = "點一下只看這個人，再點一次回到跟著領先者";
    li.addEventListener("click", () => toggleFocus(li.dataset.id));
  }
  return li;
}

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const REORDER_INTERVAL = 1000;  // 名次重排的最短間隔，跟滑動動畫一樣長
let displayOrder = [];          // 畫面上目前的名次順序（可能比實際名次慢一點點）
let lastReorder = 0;

/**
 * 依名次排好跑道，超車時用 FLIP 動畫滑到新位置：
 * 先記下每條跑道原本的位置，搬好 DOM 之後，再從舊位置動畫移到新位置。
 */
function reorderLanes(list, desired) {
  const current = [...list.children];
  if (desired.length === current.length && desired.every((lane, i) => lane === current[i])) return;

  // 量「畫面上看到的」位置：還在滑動中的跑道，從它目前滑到一半的地方接著滑
  const before = new Map(current.map((lane) => [lane, lane.getBoundingClientRect().top]));
  // 只搬位置不對的那幾條，其他跑道不動，進度條的動畫才不會被打斷
  desired.forEach((lane, index) => {
    if (list.children[index] !== lane) list.insertBefore(lane, list.children[index] || null);
  });

  if (reduceMotion.matches) return;
  // 停掉上一次的滑動（綠色閃光是 CSS 動畫，不要動它）
  for (const lane of desired) {
    for (const animation of lane.getAnimations()) {
      if (!(animation instanceof CSSAnimation)) animation.cancel();
    }
  }
  for (const lane of desired) {
    const top = before.get(lane);
    if (top === undefined) continue;  // 新加入的跑道不用動畫
    const delta = top - lane.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;
    // 像賽車轉播的名次塔：慢慢加速、慢慢停下，看得出是誰超過誰
    lane.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
      { duration: 1000, easing: "cubic-bezier(0.65, 0, 0.35, 1)" },
    );
    // 往前超車的那一列閃一下綠色（delta > 0 代表從下面往上移）
    if (delta > 0) {
      lane.classList.remove("gaining");
      void lane.offsetWidth;  // 強制重排，同一列連續超車時動畫才會重新播放
      lane.classList.add("gaining");
    }
  }
}

function renderTrack() {
  const list = $("track-list");
  const total = room.total || 1;
  const elapsed = raceStart !== null ? (performance.now() - raceStart) / 1000 : 0;
  const order = standingOrder();

  // 離開的人拿掉跑道，新來的人建跑道
  let membersChanged = false;
  for (const [id, lane] of lanes) {
    if (!order.includes(id)) {
      lane.remove();
      lanes.delete(id);
      membersChanged = true;
    }
  }
  for (const id of order) {
    if (!lanes.has(id)) {
      lanes.set(id, buildLane());
      membersChanged = true;
    }
  }

  // 名次最多每秒重排一次：速度接近的人會一直互換，每次都滑會一直抖。
  // 跟轉播的名次塔一樣，上一次滑完才換下一次；名次數字也跟著畫面上的順序走。
  const now = performance.now();
  const changed = order.join() !== displayOrder.join();
  if (membersChanged || (changed && now - lastReorder >= REORDER_INTERVAL)) {
    displayOrder = order;
    lastReorder = now;
  }
  reorderLanes(list, displayOrder.map((id) => lanes.get(id)));

  const watched = spectating ? watchedPlayer() : null;

  for (const player of room.players) {
    const lane = lanes.get(player.id);
    const done = player.seconds !== null;
    lane.dataset.id = player.id;
    // 觀戰時把正在看的那位標成跟「自己」一樣醒目
    const watching = spectating && watched !== null && player.id === watched.id;
    lane.classList.toggle("mine", spectating ? watching : player.id === myId);
    lane.classList.toggle("offline", !player.online);
    lane.classList.toggle("done", done);

    const position = displayOrder.indexOf(player.id) + 1;
    lane.querySelector(".lane-rank").textContent = String(position);
    lane.dataset.rank = String(position);  // 讓樣式可以標出領先者
    // 用 textContent 而不是 innerHTML：暱稱是別人輸入的
    lane.querySelector(".player-name").textContent =
      player.id === myId ? `${player.nickname}（你）`
        : watching ? `👁 ${player.nickname}` : player.nickname;

    let stat;
    if (done) stat = `完成 ${player.seconds.toFixed(1)} 秒`;
    else if (!player.online) stat = "離線";
    else if (elapsed >= 1) stat = `${cpmOf(player.progress, elapsed)} 字/分`;
    else stat = "—";
    lane.querySelector(".stat").textContent = stat;

    const percent = Math.min(100, (player.progress / total) * 100);
    const runner = lane.querySelector(".runner");
    runner.textContent = Array.from(player.nickname)[0] || "?";
    runner.style.left = `${percent}%`;
    runner.style.transform = `translateX(-${percent}%)`;
  }
}

function renderProgress() {
  renderTrack();
  const someoneFinished = room.players.some((p) => p.seconds !== null);

  const self = me();
  const host = isHost();
  // 沒有時間限制：有人完成後，由房主決定什麼時候結束
  const canStop = host && room.state === "racing" && someoneFinished;
  $("stop-btn").classList.toggle("hidden", !canStop);
  $("grace-hint").textContent = someoneFinished && room.state === "racing"
    ? (host ? "已經有人完成，你可以等大家打完，或直接結束比賽" : "已經有人完成，房主可以隨時結束比賽")
    : "";
  if (self && self.seconds !== null) {
    disableInput();
    $("typing-hint").textContent = "完成！等其他人打完，或房主結束比賽，就會公布成績";
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
      score.textContent = `${player.seconds.toFixed(1)} 秒 · ${cpmOf(room.total, player.seconds)} 字/分`;
    } else {
      score.classList.add("dnf");
      score.textContent = `未完成 ${player.progress} / ${room.total} 字`;
    }

    li.append(rank, name, score);
    if (player.won) li.append(makeTag("+1 勝", "wins"));
    list.append(li);
  });

  $("result-title").textContent = room.round > 0 ? `第 ${room.round} 局結果` : "比賽結果";
  renderMyRound();
  renderStandings();

  const host = isHost();
  $("again-btn").disabled = !host;
  $("lobby-btn").disabled = !host;
  $("result-hint").textContent = host
    ? `再來一局會從「${room.category}」隨機抽一篇，直接開始倒數`
    : "等待房主開始下一局";
}

function renderMyRound() {
  const box = $("my-round");
  const log = room.raceId && !spectating ? restoreRoundLog(room.raceId) : null;
  const summary = log && log.summary;
  box.classList.toggle("hidden", !summary);
  if (!summary) return;

  box.innerHTML = "";
  const speed = document.createElement("div");
  speed.className = "my-speed";
  if (summary.cpm === null) {
    speed.textContent = `這局沒完成 · 個人最佳 ${summary.best ? `${summary.best} 字/分` : "—"}`;
  } else if (summary.newRecord) {
    speed.textContent = `${summary.cpm} 字/分 · 打破個人紀錄！`;
    speed.classList.add("record");
  } else {
    speed.textContent = `${summary.cpm} 字/分 · 個人最佳 ${summary.best} 字/分`;
  }

  const errors = document.createElement("div");
  errors.className = "stats-sub";
  errors.textContent = summary.errors === 0
    ? "零失誤！"
    : `打錯 ${summary.errors} 次 · 卡住的字：${formatMisses(log.misses, 5)}`;

  box.append(speed, errors);
}

function renderStandings() {
  // 只比一局時，累計勝場一眼就看得出來，就不重複顯示
  const show = room.round >= 2;
  $("standings-box").classList.toggle("hidden", !show);
  if (!show) return;

  $("standings-round").textContent = `共 ${room.round} 局`;
  const list = $("standings");
  list.innerHTML = "";
  const sorted = [...room.players].sort((a, b) => b.wins - a.wins);
  for (const player of sorted) {
    const li = document.createElement("li");
    if (player.id === myId) li.classList.add("mine");
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.nickname;
    const wins = document.createElement("span");
    wins.className = "score";
    wins.textContent = `${player.wins} 勝`;
    li.append(name, wins);
    list.append(li);
  }
}

// ---------- 首頁：我的紀錄 ----------

function renderStats() {
  const stats = loadStats();
  $("my-stats").classList.toggle("hidden", stats.games === 0);
  if (stats.games === 0) return;

  const speeds = stats.recent.map((r) => r.cpm).filter((cpm) => cpm !== null);
  const average = speeds.length
    ? Math.round(speeds.reduce((sum, cpm) => sum + cpm, 0) / speeds.length)
    : 0;

  const items = [
    ["比賽局數", stats.games],
    ["完成局數", stats.finished],
    ["最佳速度", stats.bestCpm ? `${stats.bestCpm} 字/分` : "—"],
    [`近 ${RECENT_LIMIT} 局平均`, average ? `${average} 字/分` : "—"],
    ["累計打錯", `${stats.errors} 次`],
  ];
  const grid = $("stats-grid");
  grid.innerHTML = "";
  for (const [label, value] of items) {
    const cell = document.createElement("div");
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    cell.append(small, strong);
    grid.append(cell);
  }

  const misses = formatMisses(stats.misses, 10);
  $("stats-misses").textContent = misses ? `最常卡住的字：${misses}` : "";
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
  trackErrors(normalize(typingInput.value));
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
    showStep("name");
    showError("請先輸入暱稱");
    return;
  }
  if (code === null) {
    showError("請輸入 4 位房號");
    $("room-code-input").focus();
    return;
  }
  // 兩邊都存：sessionStorage 是這個分頁正在用的暱稱（重新整理時接回去用），
  // localStorage 只是下次開新分頁時預先填好的預設值
  saveSession(KEY_NICKNAME, nickname);
  save(KEY_NICKNAME, nickname);
  clearError();
  leaving = false;
  pendingCode = code;
  openSocket();
}

$("name-next-btn").addEventListener("click", () => {
  if (!$("nickname-input").value.trim()) {
    showError("請先輸入暱稱");
    $("nickname-input").focus();
    return;
  }
  // 從邀請連結進來的已經有房號，直接跳到加入那一步
  showStep($("room-code-input").value.trim() ? "join" : "choose");
});

$("nickname-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("name-next-btn").click();
});

$("rename-btn").addEventListener("click", () => showStep("name"));

$("create-btn").addEventListener("click", () => enter(""));

$("join-btn").addEventListener("click", () => showStep("join"));

$("join-back-btn").addEventListener("click", () => showStep("choose"));

$("join-go-btn").addEventListener("click", () => {
  const code = $("room-code-input").value.trim().toUpperCase();
  enter(code.length === 4 ? code : null);
});

$("room-code-input").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase();
});

$("room-code-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("join-go-btn").click();
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

// 再來一局：不回 Lobby，直接用同一個分類抽新文章開始
$("again-btn").addEventListener("click", () => {
  send({ type: "start", text: "", category: room ? room.category : "" });
});

$("lobby-btn").addEventListener("click", () => send({ type: "restart" }));

$("stop-btn").addEventListener("click", () => {
  const waiting = room.players.filter((p) => p.online && p.seconds === null).length;
  if (waiting === 0 || confirm(`還有 ${waiting} 人沒打完，確定要結束比賽嗎？`)) {
    send({ type: "stop" });
  }
});

$("reset-scores-btn").addEventListener("click", () => {
  if (confirm("確定要把所有人的勝場歸零嗎？")) send({ type: "reset_scores" });
});

$("clear-stats-btn").addEventListener("click", () => {
  if (!confirm("確定要清除這台電腦上的個人紀錄嗎？")) return;
  saveStats(emptyStats());
  renderStats();
});

function leave() {
  leaving = true;
  if (spectating) {
    if (ws) ws.close();
    location.href = "/dev.html";
    return;
  }
  if (roomCode) {
    dropSession(keyPlayer(roomCode));
    dropSession(keyDraft(roomCode));
    dropSession(keyRound(roomCode));
  }
  if (ws) ws.close();
  resetToHome();
  $("room-code-input").value = "";
  showStep("choose");
}

$("leave-btn").addEventListener("click", leave);
$("leave-btn-2").addEventListener("click", leave);

// ---------- 啟動 ----------

renderStats();

// 版本號只寫在 server/config.py，這裡向伺服器要，兩邊才不會不一致
fetch("/health")
  .then((response) => response.json())
  .then((data) => {
    if (!data.version) return;
    $("version-badge").textContent = `v${data.version}`;
    $("version-badge").classList.remove("hidden");
  })
  .catch(() => { /* 拿不到版本號就不顯示標籤 */ });

function startSpectating() {
  if (!loadSession(KEY_DEV_PASSWORD)) {
    alert("觀戰要先登入開發者專區");
    location.href = "/dev.html";
    return;
  }
  document.body.classList.add("spectating");
  $("spectate-bar").classList.remove("hidden");
  $("spectate-code").textContent = spectateCode;
  for (const id of ["leave-btn", "leave-btn-2"]) $(id).textContent = "結束觀戰，回開發者專區";
  showScreen("lobby");
  pendingCode = spectateCode;
  openSocket();
}

if (spectating) {
  startSpectating();
} else {
  // 先看這個分頁自己的暱稱：同一台電腦開好幾個分頁時，
  // 共用的 localStorage 會被最後一個分頁蓋掉，重新整理就會變成別人的名字
  const savedNickname = loadSession(KEY_NICKNAME) || load(KEY_NICKNAME);
  if (savedNickname) $("nickname-input").value = savedNickname;

  const urlRoom = (new URLSearchParams(location.search).get("room") || "").trim().toUpperCase();
  if (urlRoom) $("room-code-input").value = urlRoom;

  // 記得暱稱的話就跳過第一步；從邀請連結進來則直接到輸入房號
  if (savedNickname) showStep(urlRoom ? "join" : "choose");
  else showStep("name");

  // 重新整理網頁時，如果這間房間的身分還在，就自動接回去
  if (urlRoom && savedNickname && loadSession(keyPlayer(urlRoom))) {
    enter(urlRoom);
  }
}
