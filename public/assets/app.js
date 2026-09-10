// ============================================================
// ROCKET RACE — APP.JS
// Provably Fair + History Modal + Lucky Players + Verification
// ============================================================

const WS_URL =
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// ------------------------------------------------------------
// CASINO TOKEN
// ------------------------------------------------------------

function getCasinoToken() {
    const urlParams = new URLSearchParams(location.search);
    const urlToken = urlParams.get("token");
    if (urlToken) return urlToken;

    const lsToken = localStorage.getItem("casino_token");
    if (lsToken) return lsToken;

    return "demo_token_123";
}

const CASINO_TOKEN = getCasinoToken();

// ------------------------------------------------------------
// CLIENT SEED (მოთამაშის საკუთარი seed)
// ------------------------------------------------------------

function getOrCreateClientSeed() {
    let seed = localStorage.getItem("player_client_seed");
    if (!seed || seed.length < 8) {
        // გენერირება: timestamp + random
        const randomPart = crypto.getRandomValues(new Uint8Array(8));
        const hexPart = Array.from(randomPart)
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");
        seed = `p_${Date.now().toString(36)}_${hexPart}`;
        localStorage.setItem("player_client_seed", seed);
        console.log("🎲 New client seed generated:", seed);
    }
    return seed;
}

let PLAYER_CLIENT_SEED = getOrCreateClientSeed();

// ------------------------------------------------------------
// DOM REFS
// ------------------------------------------------------------

const connectionDot = document.getElementById("connDot");
const connectionText = document.getElementById("connText");

const roundLabel = document.getElementById("roundId");
const countdownEl = document.getElementById("countdown");
const phaseEl = document.getElementById("phase");
const liveBadge = document.getElementById("liveBadge");
const onlineEl = document.getElementById("online");

const scoreEl = document.getElementById("score");
const roundsEl = document.getElementById("rounds");
const streakEl = document.getElementById("streak");
const bestEl = document.getElementById("best");

const soundBtn = document.getElementById("soundBtn");
const betBtn = document.getElementById("betBtn");
const cashoutBtn = document.getElementById("cashoutBtn");
const betAmountDisplay = document.getElementById("betAmountDisplay");
const balanceDisplay = document.getElementById("balanceDisplay");
const currencyDisplay = document.getElementById("currencyDisplay");
const betCurrencyDisplay = document.getElementById("betCurrencyDisplay");
const currentMultiplierDisplay = document.getElementById("currentMultiplierDisplay");

const resultEl = document.getElementById("result");
const resultTitleEl = document.getElementById("resultTitle");
const resultValueEl = document.getElementById("resultValue");
const hashEl = document.getElementById("hash");

const historyEl = document.getElementById("history");
const leaderboardEl = document.getElementById("leaderboard");

// Lucky Players
const luckyPlayersEl = document.getElementById("luckyPlayersList");

// History Modal
const historyModalEl = document.getElementById("historyModal");
const modalCloseBtn = document.getElementById("modalClose");
const modalRoundIdEl = document.getElementById("modalRoundId");
const modalTimestampEl = document.getElementById("modalTimestamp");
const modalRedEl = document.getElementById("modalRed");
const modalGreenEl = document.getElementById("modalGreen");
const modalBlueEl = document.getElementById("modalBlue");
const modalServerSeedEl = document.getElementById("modalServerSeed");
const modalServerSeedHashEl = document.getElementById("modalServerSeedHash");
const modalNonceEl = document.getElementById("modalNonce");
const modalLuckyPlayersEl = document.getElementById("modalLuckyPlayers");
const modalAllSeedsEl = document.getElementById("modalAllSeeds");
const modalVerifyBtn = document.getElementById("modalVerifyBtn");
const modalVerifyResultEl = document.getElementById("modalVerifyResult");

// Rocket buttons
const rocketBetBtns = Array.from(document.querySelectorAll(".rocket-btn"));
const statusEls = {
    red: document.getElementById("statusRed"),
    green: document.getElementById("statusGreen"),
    blue: document.getElementById("statusBlue")
};
const multEls = {
    red: document.getElementById("multRed"),
    green: document.getElementById("multGreen"),
    blue: document.getElementById("multBlue")
};

// Bet amount buttons
const betAmountBtns = Array.from(document.querySelectorAll(".bet-btn"));

// ------------------------------------------------------------
// GAME STATE
// ------------------------------------------------------------

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

let currentRound = null;
let currentRoundId = null;
let currentRoundHash = null;
let currentLuckyPlayers = [];

let roundState = "connecting";

let waitingUntil = 0;
let selectedRocket = null;

let betAmount = 10;
let balance = 0;
let currency = "GEL";
let username = "Player";
let userId = null;
let hasBet = false;
let betRocket = null;
let betPlacedBeforeRound = false;
let bestMultiplier = 1;

let isAuthenticated = false;

let sessionProfit = 0;
let sessionWins = 0;
let sessionLosses = 0;
let highestMultiplier = 1;

const rocketState = {
    red: { crashed: false, multiplier: 1, locked: false },
    green: { crashed: false, multiplier: 1, locked: false },
    blue: { crashed: false, multiplier: 1, locked: false }
};

// ------------------------------------------------------------
// SCORE
// ------------------------------------------------------------

let score = 0;
let rounds = 0;
let streak = 0;

// ------------------------------------------------------------
// HISTORY
// ------------------------------------------------------------

const historyItems = [];
const MAX_HISTORY = 50;

// ------------------------------------------------------------
// LEADERBOARD
// ------------------------------------------------------------

const leaderboard = [];

// ------------------------------------------------------------
// SERVER TIME SYNC
// ------------------------------------------------------------

let serverOffset = 0;
let serverTimeReady = false;

function serverNow() {
    return Date.now() + serverOffset;
}

window.getServerNow = serverNow;

// ------------------------------------------------------------
// MULTIPLIER CURVE
// ------------------------------------------------------------

const GROWTH_RATE = 0.035;
const MAX_DISPLAY_MULTIPLIER = 1000;

function calculateMultiplier(startAt, now = serverNow()) {
    if (!startAt) return 1.0;
    const elapsedMs = Math.max(0, now - Number(startAt));
    const seconds = elapsedMs / 1000;
    let multiplier = Math.exp(GROWTH_RATE * seconds);
    if (!Number.isFinite(multiplier)) multiplier = MAX_DISPLAY_MULTIPLIER;
    multiplier = Math.max(1, multiplier);
    multiplier = Math.min(MAX_DISPLAY_MULTIPLIER, multiplier);
    return Number(multiplier.toFixed(2));
}

// ------------------------------------------------------------
// CRYPTO HELPERS (Web Crypto API)
// ------------------------------------------------------------

async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

async function hmacSha256Hex(keyStr, message) {
    const keyBuf = new TextEncoder().encode(keyStr);
    const msgBuf = new TextEncoder().encode(message);

    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyBuf,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgBuf);
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

async function deterministicUnit(serverSeed, message) {
    const digest = await hmacSha256Hex(serverSeed, message);
    const number = parseInt(digest.slice(0, 8), 16);
    return number / 0xffffffff;
}

// ------------------------------------------------------------
// CRASH MULTIPLIER (client-side verification)
// ------------------------------------------------------------

const MIN_MULTIPLIER = 1.00;
const MAX_MULTIPLIER = 1000.00;
const HOUSE_EDGE = 0.03;

async function calculateCrashMultiplier(serverSeed, luckyPlayers, roundId, color) {
    const seedsStr = luckyPlayers.map(p => p.seed).join(":");
    const message = `${seedsStr}:${roundId}:${color}`;

    const unit = await deterministicUnit(serverSeed, message);

    const isInstantCrash = (Math.floor(unit * 100) % 100) === 0;
    if (isInstantCrash) return 1.00;

    const raw = (1 - HOUSE_EDGE) / (1 - unit);
    const multiplier = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, raw));
    return Number(multiplier.toFixed(2));
}

// ------------------------------------------------------------
// LUCKY PLAYER SELECTION (client-side verification)
// ------------------------------------------------------------

const LUCKY_PLAYER_COUNT = 5;

async function selectLuckyPlayersClientSide(allPlayers, serverSeed, count = LUCKY_PLAYER_COUNT) {
    if (allPlayers.length === 0) return [];
    if (allPlayers.length <= count) return [...allPlayers];

    const indexed = await Promise.all(
        allPlayers.map(async (player, index) => ({
            player,
            sortKey: await deterministicUnit(
                serverSeed,
                `select:${player.userId}:${index}`
            )
        }))
    );

    indexed.sort((a, b) => a.sortKey - b.sortKey);
    return indexed.slice(0, count).map(item => item.player);
}

// ------------------------------------------------------------
// CONNECTION UI
// ------------------------------------------------------------

function setConnectionState(state) {
    const wrap = document.getElementById("connWrap");
    if (!wrap) return;
    wrap.className = "connection";
    if (state === "online") {
        wrap.classList.add("ok");
        if (connectionText) connectionText.textContent = "CONNECTED";
        return;
    }
    if (state === "offline") {
        if (connectionText) connectionText.textContent = "DISCONNECTED";
        return;
    }
    if (connectionText) connectionText.textContent = "CONNECTING";
}

function updateLiveBadge() {
    if (!liveBadge) return;
    if (roundState === "running") {
        liveBadge.textContent = "● LIVE";
        liveBadge.className = "live-badge";
    } else if (roundState === "waiting") {
        liveBadge.textContent = "● WAITING";
        liveBadge.className = "live-badge offline";
    } else {
        liveBadge.textContent = "● OFFLINE";
        liveBadge.className = "live-badge offline";
    }
}

// ------------------------------------------------------------
// SOCKET
// ------------------------------------------------------------

function connect() {
    clearTimeout(reconnectTimer);
    setConnectionState("connecting");
    roundState = "connecting";

    try {
        socket = new WebSocket(WS_URL);
    } catch (error) {
        console.error("WebSocket creation failed:", error);
        scheduleReconnect();
        return;
    }

    socket.addEventListener("open", () => {
        console.log("✅ WebSocket connected");
        setConnectionState("online");
        reconnectDelay = 1000;

        // ⭐ Auth-ში clientSeed-ის გაგზავნა
        send({
            type: "auth:login",
            token: CASINO_TOKEN,
            clientSeed: PLAYER_CLIENT_SEED
        });

        send({ type: "time:request", clientNow: Date.now() });
    });

    socket.addEventListener("message", event => {
        handleServerMessage(event.data);
    });

    socket.addEventListener("close", () => {
        console.warn("❌ WebSocket disconnected");
        setConnectionState("offline");
        roundState = "disconnected";
        isAuthenticated = false;
        scheduleReconnect();
    });

    socket.addEventListener("error", error => {
        console.error("WebSocket error:", error);
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
}

function send(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
        socket.send(JSON.stringify(data));
        return true;
    } catch (error) {
        console.error("WebSocket send failed:", error);
        return false;
    }
}

// ------------------------------------------------------------
// SERVER MESSAGE HANDLER
// ------------------------------------------------------------

function handleServerMessage(rawData) {
    let data;
    try {
        data = JSON.parse(rawData);
    } catch (error) {
        console.warn("Invalid server message:", rawData);
        return;
    }
    if (!data || !data.type) return;

    switch (data.type) {
        case "server:hello":         handleServerHello(data); break;
        case "time:response":        handleTimeResponse(data); break;
        case "auth:success":         handleAuthSuccess(data); break;
        case "auth:error":           handleAuthError(data); break;
        case "balance:update":       handleBalanceUpdate(data); break;
        case "round:start":          handleRoundStart(data); break;
        case "round:running":        handleRoundRunning(data); break;
        case "round:waiting":        handleRoundWaiting(data); break;
        case "rocket:crash":         handleRocketCrash(data); break;
        case "round:complete":       handleRoundComplete(data); break;
        case "bet:success":          handleBetSuccess(data); break;
        case "bet:error":            handleBetError(data); break;
        case "bet:lost":             handleBetLost(data); break;
        case "cashout:success":      handleCashoutSuccess(data); break;
        case "cashout:error":        handleCashoutError(data); break;
        case "score:locked":         handleScoreLocked(data); break;
        case "players:update":       handlePlayersUpdate(data); break;
        case "leaderboard:update":   handleLeaderboardUpdate(data); break;
        case "history:update":       handleHistoryUpdate(data); break;
        case "client:seed:updated":  handleClientSeedUpdated(data); break;
        default:
            console.log("Unknown server event:", data.type);
    }
}

// ------------------------------------------------------------
// AUTH HANDLERS
// ------------------------------------------------------------

function handleAuthSuccess(data) {
    console.log("✅ Auth success:", data);
    isAuthenticated = true;
    balance = Number(data.balance) || 0;
    currency = data.currency || "GEL";
    username = data.username || "Player";
    userId = data.userId || null;

    if (data.clientSeed) {
        PLAYER_CLIENT_SEED = data.clientSeed;
        localStorage.setItem("player_client_seed", PLAYER_CLIENT_SEED);
    }

    if (currencyDisplay) currencyDisplay.textContent = currency;
    if (betCurrencyDisplay) betCurrencyDisplay.textContent = currency;

    updateBalanceUI();
    updateBetUI();

    setPhase(`👤 ${username} — მზადაა`);

    addOrUpdateLeaderboardSelf();
}

function handleAuthError(data) {
    console.error("❌ Auth error:", data.reason);
    isAuthenticated = false;
    setPhase("❌ AUTH FAILED: " + (data.reason || "Unknown"));
}

function handleBalanceUpdate(data) {
    const oldBalance = balance;
    balance = Number(data.balance) || 0;
    if (data.currency) {
        currency = data.currency;
        if (currencyDisplay) currencyDisplay.textContent = currency;
        if (betCurrencyDisplay) betCurrencyDisplay.textContent = currency;
    }
    updateBalanceUI(oldBalance !== balance);
}

function handleClientSeedUpdated(data) {
    if (data.clientSeed) {
        PLAYER_CLIENT_SEED = data.clientSeed;
        localStorage.setItem("player_client_seed", PLAYER_CLIENT_SEED);
        console.log("🎲 Client seed updated:", PLAYER_CLIENT_SEED);
    }
}

// ------------------------------------------------------------
// SERVER HELLO
// ------------------------------------------------------------

function handleServerHello(data) {
    if (typeof data.serverTime === "number") {
        serverOffset = data.serverTime - Date.now();
        serverTimeReady = true;
    }
    if (typeof data.players === "number") {
        updatePlayers(data.players);
    }
    send({ type: "time:request", clientNow: Date.now() });
}

// ------------------------------------------------------------
// TIME SYNC
// ------------------------------------------------------------

function handleTimeResponse(data) {
    const serverTime = Number(data.serverTime);
    if (!Number.isFinite(serverTime)) return;

    const clientSent = Number(data.clientTime);
    const clientReceived = Date.now();

    if (Number.isFinite(clientSent) && clientSent > 0) {
        const roundTrip = clientReceived - clientSent;
        const estimatedClientNow = clientSent + roundTrip / 2;
        serverOffset = serverTime - estimatedClientNow;
    } else {
        serverOffset = serverTime - clientReceived;
    }
    serverTimeReady = true;
}

// ------------------------------------------------------------
// ROUND START (WAITING ფაზა)
// ------------------------------------------------------------

function handleRoundStart(data) {
    if (!data) return;
    data = data.round || data;
    if (!data || !data.id) return;

    console.log("🚀 ROUND START (WAITING):", data.id);

    currentRound = data;
    currentRoundId = data.id;
    currentRoundHash = data.hash || null;
    roundState = "waiting";
    waitingUntil = data.startAt + 5000;
    currentLuckyPlayers = [];

    hideResult();
    clearLuckyPlayersUI();

    if (hashEl && data.hash) hashEl.textContent = data.hash;

    for (const color of ["red", "green", "blue"]) {
        if (!(hasBet && betRocket === color)) {
            rocketState[color].crashed = false;
            rocketState[color].multiplier = 1;
            rocketState[color].locked = false;
        }
    }

    if (!hasBet) selectedRocket = null;

    rounds += 1;
    updateRoundsUI();
    updateRoundLabel();
    updateRocketButtons();
    updateBetUI();
    updateLiveBadge();

    setPhase("⏳ PLACE YOUR BET");
    if (countdownEl) countdownEl.textContent = "";

    if (betBtn) {
        betBtn.disabled = !isAuthenticated;
        betBtn.textContent = "🚀 PLACE BET";
    }
    if (cashoutBtn) {
        cashoutBtn.disabled = true;
        cashoutBtn.textContent = "⏳ WAITING";
    }

    // RocketScene-ს ვაცნობოთ
    if (window.RocketScene?.setRoundWaiting) {
        window.RocketScene.setRoundWaiting(data.id, waitingUntil);
    }
}

// ------------------------------------------------------------
// ROUND RUNNING (Lucky Players reveal + rockets start)
// ------------------------------------------------------------

function handleRoundRunning(data) {
    if (!data) return;
    if (currentRoundId !== null && data.id !== currentRoundId) return;

    console.log("🎲 ROUND RUNNING:", data.id);

    roundState = "running";
    waitingUntil = 0;

    // ⭐ შევინახოთ lucky players
    if (Array.isArray(data.luckyPlayers)) {
        currentLuckyPlayers = data.luckyPlayers;
    }

    // ⭐ განვაახლოთ currentRound-ის rockets startAt
    if (currentRound && data.rockets) {
        currentRound.rockets = data.rockets;
    }

    if (betBtn) {
        betBtn.disabled = true;
        betBtn.textContent = "⏳ IN PROGRESS";
    }
    if (cashoutBtn) {
        cashoutBtn.disabled = !hasBet;
        cashoutBtn.textContent = hasBet ? "💰 CASHOUT" : "⏳ NO BET";
    }

    updateLiveBadge();
    setPhase("🚀 ROUND IN PROGRESS");

    if (countdownEl) countdownEl.textContent = "";

    // ⭐ ვაჩვენოთ lucky players
    renderLuckyPlayers(currentLuckyPlayers);

    // RocketScene-ს ვაცნობოთ
    if (window.RocketScene?.startRound) {
        window.RocketScene.startRound(data);
    }
}

// ------------------------------------------------------------
// ROUND WAITING
// ------------------------------------------------------------

function handleRoundWaiting(data) {
    if (!data) return;
    if (currentRoundId !== null && data.roundId !== currentRoundId) return;

    waitingUntil = Number(data.nextRoundAt) || 0;
    roundState = "waiting";

    hasBet = false;
    betRocket = null;
    betPlacedBeforeRound = false;

    selectedRocket = null;
    resetRocketState();
    updateRocketButtons();
    updateBetUI();
    updateLiveBadge();

    if (betBtn) {
        betBtn.disabled = !isAuthenticated;
        betBtn.textContent = "🚀 PLACE BET";
    }
    if (cashoutBtn) {
        cashoutBtn.disabled = true;
        cashoutBtn.textContent = "⏳ WAITING";
    }

    updateCountdownUI();
    setPhase(isAuthenticated ? "⏳ PLACE YOUR BET" : "⏳ AUTHENTICATING...");

    if (window.RocketScene?.setRoundWaiting) {
        window.RocketScene.setRoundWaiting(data.roundId, data.nextRoundAt);
    }
}

// ------------------------------------------------------------
// ROCKET CRASH
// ------------------------------------------------------------

function handleRocketCrash(data) {
    if (!data || !data.color) return;
    const color = data.color;
    if (!rocketState[color]) return;
    if (currentRoundId !== null && data.roundId !== currentRoundId) return;

    const rocket = rocketState[color];
    rocket.crashed = true;

    if (typeof data.multiplier === "number") {
        rocket.multiplier = Number(data.multiplier.toFixed(2));
    } else {
        rocket.multiplier = calculateMultiplier(
            currentRound?.rockets?.[color]?.startAt || currentRound?.startAt
        );
    }

    if (rocket.multiplier > bestMultiplier) {
        bestMultiplier = rocket.multiplier;
        if (bestEl) bestEl.textContent = bestMultiplier.toFixed(2) + 'x';
    }

    if (rocket.multiplier > highestMultiplier) {
        highestMultiplier = rocket.multiplier;
    }

    updateRocketButtons();
    updateRocketMultiplierUI(color, rocket.multiplier, true);
    updateBetUI();

    if (window.AudioFX && soundEnabled) {
        window.AudioFX.crash();
    }

    if (window.RocketScene?.rocketCrash) {
        window.RocketScene.rocketCrash({
            roundId: data.roundId,
            color,
            crashedAt: data.crashedAt,
            multiplier: rocket.multiplier
        });
    }

    if (selectedRocket === color) {
        selectedRocket = null;
    }
}

// ------------------------------------------------------------
// BET LOST
// ------------------------------------------------------------

function handleBetLost(data) {
    console.log("❌ Bet lost:", data);

    hasBet = false;
    betRocket = null;
    betPlacedBeforeRound = false;

    sessionLosses++;
    sessionProfit -= Number(data.amount) || 0;

    if (typeof data.balance === "number") {
        balance = data.balance;
        updateBalanceUI(true);
    }

    setPhase(`💥 CRASH! Lost ${data.amount} ${data.currency || currency} on ${data.rocket.toUpperCase()}`);

    showResult("💥 CRASHED", `-${data.amount} ${data.currency || currency}`, "lose");

    updateRocketButtons();
    updateBetUI();
    updateLeaderboardSelf();

    if (cashoutBtn) {
        cashoutBtn.disabled = true;
        cashoutBtn.textContent = "💥 CRASHED";
    }
    if (betBtn) {
        betBtn.disabled = true;
        betBtn.textContent = "⏳ WAIT";
    }
}

// ------------------------------------------------------------
// ROUND COMPLETE
// ------------------------------------------------------------

function handleRoundComplete(data) {
    if (!data) return;
    if (currentRoundId !== null && data.id !== currentRoundId) return;

    console.log("🏁 ROUND COMPLETE:", data.id);

    roundState = "complete";
    selectedRocket = null;

    if (betBtn) {
        betBtn.disabled = true;
        betBtn.textContent = "⏳ WAIT";
    }
    if (cashoutBtn) {
        cashoutBtn.disabled = true;
        cashoutBtn.textContent = "⏳ WAIT";
    }

    updateRocketButtons();
    updateBetUI();
    updateLiveBadge();

    const results = data.results || {};

    // ⭐ სრული Provably Fair history item
    const historyItem = {
        roundId: data.id,
        serverSeed: data.serverSeed || null,
        serverSeedHash: data.serverSeedHash || data.hash || null,
        allClientSeeds: Array.isArray(data.allClientSeeds) ? data.allClientSeeds : [],
        luckyPlayers: Array.isArray(data.luckyPlayers) ? data.luckyPlayers : [],
        nonce: data.nonce || data.id,
        red: results.red?.multiplier || 1,
        green: results.green?.multiplier || 1,
        blue: results.blue?.multiplier || 1,
        timestamp: data.completedAt || Date.now()
    };

    addHistoryItem(historyItem);

    if (data.results && typeof data.results === "object") {
        for (const color of ["red", "green", "blue"]) {
            if (typeof data.results[color]?.multiplier === "number") {
                rocketState[color].multiplier = Number(data.results[color].multiplier.toFixed(2));
                rocketState[color].crashed = true;
                if (rocketState[color].multiplier > bestMultiplier) {
                    bestMultiplier = rocketState[color].multiplier;
                    if (bestEl) bestEl.textContent = bestMultiplier.toFixed(2) + 'x';
                }
            }
        }
    }

    updateAllMultiplierUI();
    setPhase("🏁 ROUND COMPLETE");
    if (countdownEl) countdownEl.textContent = "";

    if (window.RocketScene?.completeRound) {
        window.RocketScene.completeRound(data);
    }

    if (hashEl && (data.serverSeedHash || data.hash)) {
        hashEl.textContent = data.serverSeedHash || data.hash;
    }
}

// ------------------------------------------------------------
// SCORE LOCK
// ------------------------------------------------------------

function handleScoreLocked(data) {
    if (!data) return;
    if (data.roundId && currentRoundId && data.roundId !== currentRoundId) return;

    const color = data.color || data.rocket;
    if (color && rocketState[color]) {
        rocketState[color].locked = true;
        if (window.AudioFX && soundEnabled) window.AudioFX.lock();
    }
    updateRocketButtons();
}

// ------------------------------------------------------------
// PLAYERS
// ------------------------------------------------------------

function handlePlayersUpdate(data) {
    if (typeof data.players === "number") {
        updatePlayers(data.players);
    }
}

function updatePlayers(count) {
    if (onlineEl) onlineEl.textContent = String(count);
}

// ------------------------------------------------------------
// LUCKY PLAYERS UI
// ------------------------------------------------------------

function clearLuckyPlayersUI() {
    if (!luckyPlayersEl) return;
    luckyPlayersEl.innerHTML = `
        <div class="lucky-empty">
            <span>🎲 5 Lucky Players will be selected...</span>
        </div>
    `;
}

function renderLuckyPlayers(players) {
    if (!luckyPlayersEl) return;

    if (!players || players.length === 0) {
        clearLuckyPlayersUI();
        return;
    }

    let html = "";
    players.forEach((p, i) => {
        const rank = i + 1;
        const isMe = p.userId === userId;
        const isSystem = !!p.isSystem;
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;

        const classes = [
            "lucky-player-item",
            isMe ? "me" : "",
            isSystem ? "system" : ""
        ].filter(Boolean).join(" ");

        html += `
            <div class="${classes}">
                <div class="lucky-rank">${medal}</div>
                <div class="lucky-name">
                    ${escapeHtml(p.username)}${isMe ? " ⭐" : ""}${isSystem ? " (SYS)" : ""}
                </div>
            </div>
        `;
    });

    luckyPlayersEl.innerHTML = html;
}

// ------------------------------------------------------------
// LEADERBOARD
// ------------------------------------------------------------

function handleLeaderboardUpdate(data) {
    if (!data || !Array.isArray(data.players)) return;

    leaderboard.length = 0;
    for (const player of data.players) {
        leaderboard.push({
            userId: player.userId,
            username: player.username,
            profit: Number(player.profit) || 0,
            wins: Number(player.wins) || 0,
            highestMultiplier: Number(player.highestMultiplier) || 0,
            isMe: player.userId === userId
        });
    }

    renderLeaderboard();
}

function addOrUpdateLeaderboardSelf() {
    if (!userId) return;

    const existing = leaderboard.find(p => p.userId === userId);
    if (!existing) {
        leaderboard.push({
            userId,
            username,
            profit: sessionProfit,
            wins: sessionWins,
            highestMultiplier,
            isMe: true
        });
    } else {
        existing.username = username;
        existing.profit = sessionProfit;
        existing.wins = sessionWins;
        existing.highestMultiplier = highestMultiplier;
        existing.isMe = true;
    }

    renderLeaderboard();
}

function updateLeaderboardSelf() {
    const me = leaderboard.find(p => p.userId === userId);
    if (me) {
        me.profit = sessionProfit;
        me.wins = sessionWins;
        me.highestMultiplier = highestMultiplier;
        renderLeaderboard();
    }
}

function renderLeaderboard() {
    if (!leaderboardEl) return;

    const sorted = [...leaderboard].sort((a, b) => {
        if (b.profit !== a.profit) return b.profit - a.profit;
        return b.highestMultiplier - a.highestMultiplier;
    });

    const top = sorted.slice(0, 10);

    if (top.length === 0) {
        leaderboardEl.innerHTML = `
            <div class="leaderboard-empty">
                <span class="empty-icon">🏁</span>
                <span>Waiting for players...</span>
            </div>
        `;
        return;
    }

    let html = "";
    top.forEach((player, index) => {
        const rank = index + 1;
        const rankClass = rank <= 3 ? `top-${rank}` : "";
        const meClass = player.isMe ? "me" : "";
        const profitClass = player.profit > 0 ? "positive" : player.profit < 0 ? "negative" : "neutral";
        const profitText = (player.profit >= 0 ? "+" : "") + player.profit.toFixed(2);
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;

        html += `
            <div class="leaderboard-item ${rankClass} ${meClass}">
                <div class="lb-rank">${medal}</div>
                <div class="lb-info">
                    <div class="lb-name">${escapeHtml(player.username)}${player.isMe ? " (You)" : ""}</div>
                    <div class="lb-stats">${player.wins} wins · best ${player.highestMultiplier.toFixed(2)}x</div>
                </div>
                <div class="lb-profit ${profitClass}">${profitText}</div>
            </div>
        `;
    });

    leaderboardEl.innerHTML = html;
}

// ------------------------------------------------------------
// HISTORY
// ------------------------------------------------------------

function handleHistoryUpdate(data) {
    if (!data || !Array.isArray(data.rounds)) return;

    historyItems.length = 0;
    for (const r of data.rounds) {
        historyItems.push({
            roundId: r.roundId,
            serverSeed: r.serverSeed || null,
            serverSeedHash: r.serverSeedHash || null,
            allClientSeeds: Array.isArray(r.allClientSeeds) ? r.allClientSeeds : [],
            luckyPlayers: Array.isArray(r.luckyPlayers) ? r.luckyPlayers : [],
            nonce: r.nonce || r.roundId,
            red: r.red || 1,
            green: r.green || 1,
            blue: r.blue || 1,
            timestamp: r.timestamp || Date.now()
        });
    }

    renderHistory();
}

function addHistoryItem(item) {
    historyItems.unshift(item);
    if (historyItems.length > MAX_HISTORY) {
        historyItems.length = MAX_HISTORY;
    }
    renderHistory();
}

function renderHistory() {
    if (!historyEl) return;

    if (historyItems.length === 0) {
        historyEl.innerHTML = `
            <div class="history-empty">
                <span class="empty-icon">⏳</span>
                <span>No rounds yet</span>
            </div>
        `;
        return;
    }

    let html = "";
    for (let i = 0; i < historyItems.length; i++) {
        const item = historyItems[i];
        const maxMult = Math.max(item.red, item.green, item.blue);
        const status = maxMult >= 10 ? "🔥" : maxMult >= 5 ? "⭐" : maxMult >= 2 ? "✅" : "💧";
        const hasPF = !!item.serverSeed;

        html += `
            <div class="history-item ${hasPF ? 'clickable' : ''}" data-history-index="${i}">
                <div class="h-round">#${item.roundId}</div>
                <div class="h-result">
                    <span style="color:var(--red)">${item.red.toFixed(2)}</span>
                    <span style="color:var(--txt-dim)">·</span>
                    <span style="color:var(--green)">${item.green.toFixed(2)}</span>
                    <span style="color:var(--txt-dim)">·</span>
                    <span style="color:var(--blue)">${item.blue.toFixed(2)}</span>
                </div>
                <div class="h-mult ${maxMult >= 2 ? 'win' : 'lose'}">${maxMult.toFixed(2)}x</div>
                <div class="h-status">${status}</div>
            </div>
        `;
    }

    historyEl.innerHTML = html;

    // ⭐ Click listeners
    historyEl.querySelectorAll(".history-item.clickable").forEach(el => {
        el.addEventListener("click", () => {
            const idx = parseInt(el.dataset.historyIndex);
            if (!isNaN(idx) && historyItems[idx]) {
                openHistoryModal(historyItems[idx]);
            }
        });
    });
}

// ------------------------------------------------------------
// HISTORY MODAL
// ------------------------------------------------------------

let currentModalItem = null;

function openHistoryModal(item) {
    if (!historyModalEl) return;
    if (!item || !item.serverSeed) return;

    currentModalItem = item;

    // Fill modal
    if (modalRoundIdEl) modalRoundIdEl.textContent = item.roundId;
    if (modalTimestampEl) modalTimestampEl.textContent = new Date(item.timestamp).toLocaleString();
    if (modalRedEl) modalRedEl.textContent = item.red.toFixed(2) + "x";
    if (modalGreenEl) modalGreenEl.textContent = item.green.toFixed(2) + "x";
    if (modalBlueEl) modalBlueEl.textContent = item.blue.toFixed(2) + "x";
    if (modalServerSeedEl) modalServerSeedEl.textContent = item.serverSeed;
    if (modalServerSeedHashEl) modalServerSeedHashEl.textContent = item.serverSeedHash || "—";
    if (modalNonceEl) modalNonceEl.textContent = item.nonce;

    // Lucky Players
    if (modalLuckyPlayersEl) {
        if (item.luckyPlayers && item.luckyPlayers.length > 0) {
            let lp = "";
            item.luckyPlayers.forEach((p, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1);
                const isMe = p.userId === userId;
                lp += `<div class="modal-lucky-item ${isMe ? 'me' : ''}">
                    <span class="modal-lucky-rank">${medal}</span>
                    <span class="modal-lucky-name">${escapeHtml(p.username)}${isMe ? " ⭐" : ""}${p.isSystem ? " (SYS)" : ""}</span>
                    <code class="modal-lucky-seed">${escapeHtml((p.seed || "").slice(0, 16))}...</code>
                </div>`;
            });
            modalLuckyPlayersEl.innerHTML = lp;
        } else {
            modalLuckyPlayersEl.innerHTML = "<div class='modal-empty'>No lucky players data</div>";
        }
    }

    // All Seeds
    if (modalAllSeedsEl) {
        if (item.allClientSeeds && item.allClientSeeds.length > 0) {
            let as = `<div class="modal-all-seeds-count">Total: ${item.allClientSeeds.length} players</div>`;
            item.allClientSeeds.forEach((p, i) => {
                as += `<div class="modal-all-seed-item">
                    <span class="modal-seed-idx">${i + 1}.</span>
                    <span class="modal-seed-name">${escapeHtml(p.username)}</span>
                    <code class="modal-seed-val">${escapeHtml((p.seed || "").slice(0, 16))}...</code>
                </div>`;
            });
            modalAllSeedsEl.innerHTML = as;
        } else {
            modalAllSeedsEl.innerHTML = "<div class='modal-empty'>No client seeds data</div>";
        }
    }

    // Reset verify result
    if (modalVerifyResultEl) {
        modalVerifyResultEl.innerHTML = "<div class='verify-pending'>Click VERIFY to check</div>";
    }

    historyModalEl.classList.remove("hidden");
}

function closeHistoryModal() {
    if (historyModalEl) historyModalEl.classList.add("hidden");
    currentModalItem = null;
}

// ------------------------------------------------------------
// VERIFICATION
// ------------------------------------------------------------

async function verifyCurrentRound() {
    if (!currentModalItem || !modalVerifyResultEl) return;

    const item = currentModalItem;
    modalVerifyResultEl.innerHTML = "<div class='verify-pending'>🔄 Verifying...</div>";

    const steps = [];

    try {
        // Step 1: Server Seed Hash verification
        const computedHash = await sha256Hex(item.serverSeed);
        const hashMatch = computedHash === item.serverSeedHash;
        steps.push({
            name: "Server Seed Hash (commitment)",
            expected: item.serverSeedHash?.slice(0, 24) + "...",
            computed: computedHash.slice(0, 24) + "...",
            pass: hashMatch
        });

        // Step 2: Lucky Players verification (recompute)
        let luckyMatch = true;
        if (item.allClientSeeds.length > 0 && item.luckyPlayers.length > 0) {
            const expectedLucky = await selectLuckyPlayersClientSide(
                item.allClientSeeds,
                item.serverSeed,
                LUCKY_PLAYER_COUNT
            );

            // Compare user IDs
            const expIds = expectedLucky.map(p => p.userId).sort().join(",");
            const gotIds = item.luckyPlayers.map(p => p.userId).sort().join(",");

            // ⚠️ default seeds-ის შემთხვევაში (system) ეს არ ემთხვევა
            // ამიტომ შევამოწმოთ მხოლოდ თუ საკმარისი მოთამაშე იყო
            if (item.allClientSeeds.length >= LUCKY_PLAYER_COUNT) {
                luckyMatch = expIds === gotIds;
            }

            steps.push({
                name: "Lucky Players Selection",
                expected: expIds.slice(0, 60),
                computed: gotIds.slice(0, 60),
                pass: luckyMatch,
                note: item.allClientSeeds.length < LUCKY_PLAYER_COUNT ? "Partial (default seeds used)" : null
            });
        }

        // Step 3: Crash multipliers verification
        const colors = ["red", "green", "blue"];
        for (const color of colors) {
            const expected = item[color];
            const computed = await calculateCrashMultiplier(
                item.serverSeed,
                item.luckyPlayers,
                item.nonce,
                color
            );

            steps.push({
                name: `${color.toUpperCase()} Crash`,
                expected: expected.toFixed(2) + "x",
                computed: computed.toFixed(2) + "x",
                pass: Math.abs(expected - computed) < 0.01
            });
        }

        // Render results
        let html = "";
        let allPass = true;

        for (const step of steps) {
            const statusIcon = step.pass ? "✅" : "❌";
            if (!step.pass) allPass = false;

            html += `
                <div class="verify-step ${step.pass ? 'pass' : 'fail'}">
                    <div class="verify-step-header">
                        <span class="verify-icon">${statusIcon}</span>
                        <span class="verify-name">${step.name}</span>
                    </div>
                    <div class="verify-step-body">
                        <div class="verify-row">
                            <span class="verify-label">Expected:</span>
                            <code class="verify-code">${escapeHtml(step.expected)}</code>
                        </div>
                        <div class="verify-row">
                            <span class="verify-label">Computed:</span>
                            <code class="verify-code">${escapeHtml(step.computed)}</code>
                        </div>
                        ${step.note ? `<div class="verify-note">ℹ️ ${step.note}</div>` : ""}
                    </div>
                </div>
            `;
        }

        const summaryClass = allPass ? "verify-summary-pass" : "verify-summary-fail";
        const summaryText = allPass ? "✅ ROUND VERIFIED — FAIR PLAY CONFIRMED" : "❌ VERIFICATION FAILED";

        html = `<div class="verify-summary ${summaryClass}">${summaryText}</div>` + html;

        modalVerifyResultEl.innerHTML = html;

    } catch (error) {
        console.error("Verification error:", error);
        modalVerifyResultEl.innerHTML = `<div class="verify-summary verify-summary-fail">❌ Verification error: ${escapeHtml(error.message)}</div>`;
    }
}

// ------------------------------------------------------------
// RESULT OVERLAY
// ------------------------------------------------------------

function showResult(title, value, type = "info") {
    if (!resultEl) return;
    if (resultTitleEl) resultTitleEl.textContent = title;
    if (resultValueEl) resultValueEl.textContent = value;

    resultEl.classList.remove("hidden");

    if (type === "win") {
        resultEl.style.color = "var(--green)";
    } else if (type === "lose") {
        resultEl.style.color = "var(--red)";
    } else {
        resultEl.style.color = "var(--txt)";
    }

    clearTimeout(showResult._timer);
    showResult._timer = setTimeout(() => {
        hideResult();
    }, 1800);
}

function hideResult() {
    if (resultEl) resultEl.classList.add("hidden");
}

// ------------------------------------------------------------
// BETTING UI FUNCTIONS
// ------------------------------------------------------------

function updateBalanceUI(animate = false) {
    if (balanceDisplay) {
        balanceDisplay.textContent = balance.toFixed(2);
        if (animate) {
            balanceDisplay.classList.remove("changed");
            void balanceDisplay.offsetWidth;
            balanceDisplay.classList.add("changed");
        }
    }
}

function updateBetUI() {
    if (betAmountDisplay) {
        betAmountDisplay.textContent = betAmount;
    }

    if (currentMultiplierDisplay && selectedRocket && rocketState[selectedRocket]) {
        const mult = rocketState[selectedRocket].multiplier || 1;
        currentMultiplierDisplay.textContent = mult.toFixed(2) + 'x';
    } else if (currentMultiplierDisplay) {
        currentMultiplierDisplay.textContent = '1.00x';
    }

    if (betBtn) {
        if (!isAuthenticated) {
            betBtn.disabled = true;
            betBtn.textContent = "⏳ CONNECTING";
        } else if (roundState === "waiting") {
            betBtn.disabled = !selectedRocket || hasBet || betAmount > balance;
            betBtn.textContent = "🚀 PLACE BET";
        } else if (roundState === "running") {
            betBtn.disabled = true;
            betBtn.textContent = "⏳ IN PROGRESS";
        } else {
            betBtn.disabled = true;
            betBtn.textContent = "⏳ WAIT";
        }
    }

    if (cashoutBtn) {
        if (hasBet && roundState === "running") {
            cashoutBtn.disabled = false;
            cashoutBtn.textContent = "💰 CASHOUT";
        } else if (hasBet && roundState === "waiting") {
            cashoutBtn.disabled = true;
            cashoutBtn.textContent = "⏳ WAITING";
        } else {
            cashoutBtn.disabled = true;
            cashoutBtn.textContent = "⏳ NO BET";
        }
    }
}

// ------------------------------------------------------------
// PLACE BET
// ------------------------------------------------------------

function placeBet() {
    if (!isAuthenticated) {
        setPhase("❌ NOT AUTHENTICATED");
        return;
    }

    if (hasBet) {
        setPhase("❌ ALREADY HAVE BET");
        return;
    }

    if (!selectedRocket) {
        setPhase("❌ SELECT A ROCKET");
        return;
    }

    if (roundState !== "waiting") {
        setPhase("❌ BET ONLY BEFORE ROUND");
        return;
    }

    const color = selectedRocket;
    const state = rocketState[color];

    if (!state || state.crashed) {
        setPhase("❌ ROCKET CRASHED");
        return;
    }

    if (betAmount > balance) {
        setPhase("❌ INSUFFICIENT BALANCE");
        return;
    }

    const sent = send({
        type: "bet:place",
        rocket: color,
        amount: betAmount,
        clientSeed: PLAYER_CLIENT_SEED
    });

    if (!sent) {
        setPhase("❌ CONNECTION ERROR");
        return;
    }

    hasBet = true;
    betRocket = color;
    betPlacedBeforeRound = true;
    state.locked = true;

    updateRocketButtons();
    updateBetUI();

    setPhase(`⏳ PLACING BET ON ${color.toUpperCase()}...`);
}

// ------------------------------------------------------------
// CASHOUT
// ------------------------------------------------------------

function cashout() {
    if (!isAuthenticated || !hasBet || !betRocket) return;
    if (roundState !== "running") return;

    const color = betRocket;
    const state = rocketState[color];

    if (state && state.crashed) return;

    send({ type: "bet:cashout" });

    setPhase(`⏳ CASHING OUT...`);
}

// ------------------------------------------------------------
// BET SUCCESS / ERROR HANDLERS
// ------------------------------------------------------------

function handleBetSuccess(data) {
    console.log("✅ Bet success:", data);

    if (typeof data.newBalance === "number") {
        balance = data.newBalance;
        updateBalanceUI(true);
    }

    setPhase(`💰 BET PLACED: ${data.amount} ${currency} on ${data.rocket.toUpperCase()}`);

    hasBet = true;
    betRocket = data.rocket;
    betPlacedBeforeRound = true;
    rocketState[data.rocket].locked = true;

    updateRocketButtons();
    updateBetUI();

    if (window.AudioFX && soundEnabled) window.AudioFX.lock();
}

function handleBetError(data) {
    console.error("❌ Bet error:", data.reason);

    hasBet = false;
    betRocket = null;
    betPlacedBeforeRound = false;

    if (selectedRocket) {
        rocketState[selectedRocket].locked = false;
    }

    updateRocketButtons();
    updateBetUI();

    setPhase("❌ BET FAILED: " + (data.reason || "Unknown"));
}

function handleCashoutSuccess(data) {
    console.log("✅ Cashout success:", data);

    if (typeof data.newBalance === "number") {
        balance = data.newBalance;
        updateBalanceUI(true);
    }

    sessionWins++;
    const profit = Number(data.winAmount) - betAmount;
    sessionProfit += profit;

    if (data.multiplier > highestMultiplier) {
        highestMultiplier = Number(data.multiplier);
    }

    hasBet = false;
    betRocket = null;
    betPlacedBeforeRound = false;

    updateRocketButtons();
    updateBetUI();
    updateLeaderboardSelf();

    setPhase(`💰 CASHOUT! ${data.winAmount.toFixed(2)} ${currency} @ ${data.multiplier.toFixed(2)}x`);

    showResult("💰 CASHOUT", `+${data.winAmount.toFixed(2)} ${currency} @ ${data.multiplier.toFixed(2)}x`, "win");

    if (window.AudioFX && soundEnabled) window.AudioFX.lock();
}

function handleCashoutError(data) {
    console.error("❌ Cashout error:", data.reason);
    setPhase("❌ CASHOUT FAILED: " + (data.reason || "Unknown"));
}

// ------------------------------------------------------------
// ROUND UI
// ------------------------------------------------------------

function updateRoundLabel() {
    if (!roundLabel) return;
    roundLabel.textContent = currentRoundId !== null ? currentRoundId : "—";
}

function setPhase(text) {
    if (!phaseEl) return;
    phaseEl.textContent = text;
}

function updateCountdownUI() {
    if (!countdownEl) return;
    const now = serverNow();

    if (roundState === "waiting" && waitingUntil > 0) {
        const remaining = Math.max(0, waitingUntil - now);
        const seconds = Math.ceil(remaining / 1000);

        if (seconds > 0) {
            countdownEl.textContent = seconds;
            setPhase(
                !isAuthenticated
                    ? "⏳ AUTHENTICATING..."
                    : !hasBet
                        ? `⏳ PLACE BET — ${seconds}s`
                        : `⏳ BET PLACED — ${seconds}s`
            );
        } else {
            countdownEl.textContent = "0";
            setPhase("🚀 STARTING...");
        }
        return;
    }

    countdownEl.textContent = "";
}

// ------------------------------------------------------------
// ROCKET STATE RESET
// ------------------------------------------------------------

function resetRocketState() {
    for (const color of ["red", "green", "blue"]) {
        if (hasBet && betRocket === color) continue;
        rocketState[color].crashed = false;
        rocketState[color].multiplier = 1;
        rocketState[color].locked = false;
    }
    updateAllMultiplierUI();
}

// ------------------------------------------------------------
// ROCKET SELECTION
// ------------------------------------------------------------

function selectRocket(color) {
    if (!color || !rocketState[color]) return;

    if (!isAuthenticated) {
        setPhase("⏳ AUTHENTICATING...");
        return;
    }

    if (roundState !== "waiting") {
        setPhase("⏳ SELECT ONLY BEFORE ROUND");
        return;
    }

    if (rocketState[color].crashed) return;
    if (hasBet) return;

    if (selectedRocket === color) {
        selectedRocket = null;
    } else {
        selectedRocket = color;
        if (window.AudioFX && soundEnabled) window.AudioFX.select();
    }

    updateRocketButtons();
    updateBetUI();

    if (window.RocketScene?.selectRocket) {
        window.RocketScene.selectRocket(selectedRocket);
    }
}

function updateRocketButtons() {
    rocketBetBtns.forEach(button => {
        const color = button.dataset.r;
        if (!color) return;
        const state = rocketState[color];
        const statusEl = statusEls[color];
        const multEl = multEls[color];

        const isSelected = selectedRocket === color && !hasBet;
        const isBetRocket = hasBet && betRocket === color;

        button.classList.toggle("selected", isSelected);
        button.classList.toggle("crashed", !!state?.crashed);
        button.classList.toggle("locked", !!state?.locked || isBetRocket);

        if (multEl) {
            multEl.textContent = `${(state?.multiplier || 1).toFixed(2)}x`;
        }

        if (statusEl) {
            if (state?.crashed) {
                statusEl.textContent = `💥 ${state.multiplier.toFixed(2)}x`;
                statusEl.className = "rocket-status crashed-text";
            } else if (isBetRocket) {
                statusEl.textContent = "🔒 BET";
                statusEl.className = "rocket-status locked-text";
            } else if (state?.locked) {
                statusEl.textContent = "🔒 LOCKED";
                statusEl.className = "rocket-status locked-text";
            } else if (isSelected) {
                statusEl.textContent = "✅ SELECTED";
                statusEl.className = "rocket-status selected-text";
            } else if (roundState === "waiting") {
                statusEl.textContent = "SELECT";
                statusEl.className = "rocket-status";
            } else if (roundState === "running" && !hasBet) {
                statusEl.textContent = "⏳ LIVE";
                statusEl.className = "rocket-status";
            } else {
                statusEl.textContent = "SELECT";
                statusEl.className = "rocket-status";
            }
        }
    });

    updateBetUI();
}

// ------------------------------------------------------------
// MULTIPLIER UI
// ------------------------------------------------------------

function updateRocketMultiplierUI(color, multiplier, crashed = false) {
    if (!color) return;
    const state = rocketState[color];
    if (!state) return;
    state.multiplier = Number(multiplier) || 1;

    const multEl = multEls[color];
    if (multEl) multEl.textContent = `${state.multiplier.toFixed(2)}x`;

    const statusEl = statusEls[color];
    if (statusEl && crashed) {
        statusEl.textContent = `💥 ${state.multiplier.toFixed(2)}x`;
        statusEl.className = "rocket-status crashed-text";
    }

    if (selectedRocket === color && currentMultiplierDisplay) {
        currentMultiplierDisplay.textContent = `${state.multiplier.toFixed(2)}x`;
    }
}

function updateAllMultiplierUI() {
    for (const color of ["red", "green", "blue"]) {
        const state = rocketState[color];
        if (!state) continue;
        updateRocketMultiplierUI(color, state.multiplier, state.crashed);
    }
}

// ------------------------------------------------------------
// LIVE MULTIPLIERS
// ------------------------------------------------------------

function updateLiveMultipliers() {
    if (!currentRound || roundState !== "running") return;
    const now = serverNow();

    for (const color of ["red", "green", "blue"]) {
        const state = rocketState[color];
        if (!state || state.crashed) continue;
        const rocket = currentRound.rockets?.[color];
        if (!rocket) continue;

        const multiplier = calculateMultiplier(rocket.startAt, now);
        state.multiplier = multiplier;

        const multEl = multEls[color];
        if (multEl) multEl.textContent = `${multiplier.toFixed(2)}x`;

        if (selectedRocket === color && currentMultiplierDisplay) {
            currentMultiplierDisplay.textContent = `${multiplier.toFixed(2)}x`;
        }

        const statusEl = statusEls[color];
        if (statusEl && !state.crashed && !state.locked && !(hasBet && betRocket === color)) {
            statusEl.textContent = `${multiplier.toFixed(2)}x`;
            statusEl.className = "rocket-status";
        }
    }
}

// ------------------------------------------------------------
// SCORE UI
// ------------------------------------------------------------

function updateScoreUI() {
    if (!scoreEl) return;
    scoreEl.textContent = score.toFixed(2);
}

function updateRoundsUI() {
    if (!roundsEl) return;
    roundsEl.textContent = String(rounds);
}

function updateStreakUI() {
    if (!streakEl) return;
    streakEl.textContent = String(streak);
}

// ------------------------------------------------------------
// SOUND
// ------------------------------------------------------------

let soundEnabled = true;

function updateSoundButton() {
    if (!soundBtn) return;
    soundBtn.textContent = soundEnabled ? "🔊" : "🔇";
}

function toggleSound() {
    if (window.AudioFX) {
        soundEnabled = window.AudioFX.toggle();
    } else {
        soundEnabled = !soundEnabled;
    }
    updateSoundButton();
}

if (soundBtn) soundBtn.addEventListener("click", toggleSound);
updateSoundButton();

// ------------------------------------------------------------
// BET AMOUNT BUTTONS
// ------------------------------------------------------------

betAmountBtns.forEach(btn => {
    btn.addEventListener("click", () => {
        if (hasBet) return;
        betAmountBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        betAmount = parseInt(btn.dataset.amount);
        updateBetUI();
    });
});

// ------------------------------------------------------------
// ROCKET BUTTON EVENTS
// ------------------------------------------------------------

rocketBetBtns.forEach(button => {
    button.addEventListener("click", () => {
        const color = button.dataset.r;
        if (!color) return;
        selectRocket(color);
    });
});

// ------------------------------------------------------------
// BET & CASHOUT BUTTON EVENTS
// ------------------------------------------------------------

if (betBtn) betBtn.addEventListener("click", placeBet);
if (cashoutBtn) cashoutBtn.addEventListener("click", cashout);

// ------------------------------------------------------------
// MODAL EVENTS
// ------------------------------------------------------------

if (modalCloseBtn) {
    modalCloseBtn.addEventListener("click", closeHistoryModal);
}

if (historyModalEl) {
    historyModalEl.addEventListener("click", (e) => {
        if (e.target === historyModalEl) {
            closeHistoryModal();
        }
    });
}

if (modalVerifyBtn) {
    modalVerifyBtn.addEventListener("click", verifyCurrentRound);
}

// Copy buttons
document.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.copyTarget;
        const targetEl = document.getElementById(targetId);
        if (!targetEl) return;

        try {
            await navigator.clipboard.writeText(targetEl.textContent || "");
            btn.textContent = "✅";
            setTimeout(() => { btn.textContent = "📋"; }, 1500);
        } catch (err) {
            console.error("Copy failed:", err);
        }
    });
});

// ESC to close modal
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && historyModalEl && !historyModalEl.classList.contains("hidden")) {
        closeHistoryModal();
    }
});

// ------------------------------------------------------------
// KEYBOARD CONTROLS
// ------------------------------------------------------------

document.addEventListener("keydown", event => {
    if (event.key === "1") selectRocket("red");
    if (event.key === "2") selectRocket("green");
    if (event.key === "3") selectRocket("blue");

    if (event.key === "Enter" || event.key === " ") {
        if (historyModalEl && !historyModalEl.classList.contains("hidden")) return;
        event.preventDefault();
        if (hasBet && roundState === "running") cashout();
        else if (!hasBet && roundState === "waiting") placeBet();
    }

    if (event.key === "4") {
        betAmountBtns.forEach(b => b.classList.remove("active"));
        const btn = betAmountBtns.find(b => parseInt(b.dataset.amount) === 1);
        if (btn) { btn.classList.add("active"); betAmount = 1; updateBetUI(); }
    }
    if (event.key === "5") {
        betAmountBtns.forEach(b => b.classList.remove("active"));
        const btn = betAmountBtns.find(b => parseInt(b.dataset.amount) === 5);
        if (btn) { btn.classList.add("active"); betAmount = 5; updateBetUI(); }
    }
    if (event.key === "6") {
        betAmountBtns.forEach(b => b.classList.remove("active"));
        const btn = betAmountBtns.find(b => parseInt(b.dataset.amount) === 10);
        if (btn) { btn.classList.add("active"); betAmount = 10; updateBetUI(); }
    }
    if (event.key === "7") {
        betAmountBtns.forEach(b => b.classList.remove("active"));
        const btn = betAmountBtns.find(b => parseInt(b.dataset.amount) === 50);
        if (btn) { btn.classList.add("active"); betAmount = 50; updateBetUI(); }
    }
});

// ------------------------------------------------------------
// MAIN UI LOOP
// ------------------------------------------------------------

function uiLoop() {
    updateCountdownUI();
    updateLiveMultipliers();
    updateBetUI();
    requestAnimationFrame(uiLoop);
}

// ------------------------------------------------------------
// UTILITIES
// ------------------------------------------------------------

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ------------------------------------------------------------
// INITIAL STATE
// ------------------------------------------------------------

updateScoreUI();
updateRoundsUI();
updateStreakUI();
updateRocketButtons();
updateRoundLabel();
updateBalanceUI();
updateBetUI();
updateLiveBadge();
renderHistory();
renderLeaderboard();
clearLuckyPlayersUI();
setConnectionState("connecting");

if (betBtn) {
    betBtn.disabled = true;
    betBtn.textContent = "⏳ CONNECTING";
}
if (cashoutBtn) {
    cashoutBtn.disabled = true;
    cashoutBtn.textContent = "⏳ CONNECTING";
}

uiLoop();

// ------------------------------------------------------------
// START CONNECTION
// ------------------------------------------------------------

connect();

// ------------------------------------------------------------
// DEBUG API
// ------------------------------------------------------------

window.RocketRace = {
    getState() {
        return {
            roundState,
            currentRound,
            currentRoundId,
            currentRoundHash,
            currentLuckyPlayers,
            selectedRocket,
            rocketState,
            score,
            rounds,
            streak,
            bestMultiplier,
            serverOffset,
            serverTimeReady,
            balance,
            currency,
            username,
            userId,
            betAmount,
            hasBet,
            betRocket,
            betPlacedBeforeRound,
            isAuthenticated,
            sessionProfit,
            sessionWins,
            sessionLosses,
            highestMultiplier,
            clientSeed: PLAYER_CLIENT_SEED.slice(0, 16) + "...",
            casinoToken: CASINO_TOKEN.slice(0, 12) + "..."
        };
    },
    selectRocket,
    placeBet,
    cashout,
    connect,
    serverNow,
    calculateMultiplier,
    send,
    getSocket() { return socket; },
    login(token = CASINO_TOKEN) {
        return send({
            type: "auth:login",
            token,
            clientSeed: PLAYER_CLIENT_SEED
        });
    },
    getLeaderboard() {
        return [...leaderboard].sort((a, b) => b.profit - a.profit);
    },
    getHistory() {
        return [...historyItems];
    },
    getClientSeed() {
        return PLAYER_CLIENT_SEED;
    },
    regenerateClientSeed() {
        const randomPart = crypto.getRandomValues(new Uint8Array(8));
        const hexPart = Array.from(randomPart)
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");
        PLAYER_CLIENT_SEED = `p_${Date.now().toString(36)}_${hexPart}`;
        localStorage.setItem("player_client_seed", PLAYER_CLIENT_SEED);
        send({ type: "client:seed:update", clientSeed: PLAYER_CLIENT_SEED });
        return PLAYER_CLIENT_SEED;
    },
    // Verification helpers (debug)
    sha256Hex,
    hmacSha256Hex,
    selectLuckyPlayersClientSide,
    calculateCrashMultiplier
};

console.log("🚀 Rocket Race Client loaded (Provably Fair)");
console.log("🎰 Token:", CASINO_TOKEN.slice(0, 12) + "...");
console.log("🎲 Client Seed:", PLAYER_CLIENT_SEED.slice(0, 16) + "...");