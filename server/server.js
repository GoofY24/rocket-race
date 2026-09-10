import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

/* =========================================================
   PATH
========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT) || 3000;
const CASINO_API_URL = process.env.CASINO_API_URL || "http://localhost:4000";

const INTERMISSION_MS = 5000;
const EXPLOSION_DELAY_MS = 1500;

const ROCKET_COLORS = ["red", "green", "blue"];

/* =========================================================
   MULTIPLIER CONFIG
========================================================= */

const MIN_MULTIPLIER = 1.00;
const MAX_MULTIPLIER = 1000.00;
const HOUSE_EDGE = 0.03;
const GROWTH_RATE = 0.035;

/* =========================================================
   PROVABLY FAIR CONFIG
========================================================= */

const LUCKY_PLAYER_COUNT = 5;

// Default seeds – გამოიყენება თუ 5-ზე ნაკლები მოთამაშეა
const DEFAULT_CLIENT_SEEDS = [
    crypto.randomBytes(8).toString("hex"),
    crypto.randomBytes(8).toString("hex"),
    crypto.randomBytes(8).toString("hex"),
    crypto.randomBytes(8).toString("hex"),
    crypto.randomBytes(8).toString("hex")
];

/* =========================================================
   LEADERBOARD / HISTORY CONFIG
========================================================= */

const MAX_HISTORY = 50;
const MAX_LEADERBOARD = 10;

/* =========================================================
   PUBLIC DIRECTORY
========================================================= */

const PUBLIC_DIR = path.join(__dirname, "..", "public");

/* =========================================================
   STATE
========================================================= */

let roundCounter = 0;
let currentRound = null;
let nextRoundTimer = null;
let waitingTimer = null;
const clients = new Set();

const sessions = new Map();
const roundHistory = [];
const playerStats = new Map();

/* =========================================================
   TIME
========================================================= */

function now() {
    return Date.now();
}

/* =========================================================
   MULTIPLIER CURVE
========================================================= */

function multiplierAtElapsed(ms) {
    const seconds = Math.max(0, ms) / 1000;
    const multiplier = Math.exp(GROWTH_RATE * seconds);

    return Number(
        Math.min(
            MAX_MULTIPLIER,
            Math.max(MIN_MULTIPLIER, multiplier)
        ).toFixed(2)
    );
}

/* =========================================================
   RANDOM SEED
========================================================= */

function randomSeed() {
    return crypto.randomBytes(32).toString("hex");
}

function sha256Hex(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

/* =========================================================
   DETERMINISTIC RANDOM (HMAC-SHA256)
========================================================= */

function deterministicUnit(serverSeed, message) {
    const digest = crypto
        .createHmac("sha256", serverSeed)
        .update(message)
        .digest("hex");

    const number = parseInt(digest.slice(0, 8), 16);

    return number / 0xffffffff;
}

/* =========================================================
   LUCKY PLAYER SELECTION (Provably Fair)
========================================================= */

function selectLuckyPlayers(allPlayers, serverSeed, count = LUCKY_PLAYER_COUNT) {
    if (allPlayers.length === 0) {
        return DEFAULT_CLIENT_SEEDS.map((seed, i) => ({
            userId: `system_${i}`,
            username: `System ${i + 1}`,
            seed,
            isSystem: true
        }));
    }

    if (allPlayers.length >= count) {
        const indexed = allPlayers.map((player, index) => ({
            player,
            sortKey: deterministicUnit(
                serverSeed,
                `select:${player.userId}:${index}`
            )
        }));

        indexed.sort((a, b) => a.sortKey - b.sortKey);

        return indexed.slice(0, count).map(item => item.player);
    }

    const result = [...allPlayers];
    const needed = count - result.length;

    for (let i = 0; i < needed; i++) {
        result.push({
            userId: `system_${i}`,
            username: `System ${i + 1}`,
            seed: DEFAULT_CLIENT_SEEDS[i],
            isSystem: true
        });
    }

    return result;
}

/* =========================================================
   CRASH MULTIPLIER (PROVABLY FAIR)
========================================================= */

function crashMultiplierFromSeed(serverSeed, luckyPlayers, roundId, color) {
    const seedsStr = luckyPlayers.map(p => p.seed).join(":");
    const message = `${seedsStr}:${roundId}:${color}`;

    const unit = deterministicUnit(serverSeed, message);

    const isInstantCrash = (Math.floor(unit * 100) % 100) === 0;
    if (isInstantCrash) {
        return 1.00;
    }

    const raw = (1 - HOUSE_EDGE) / (1 - unit);

    const multiplier = Math.max(
        MIN_MULTIPLIER,
        Math.min(MAX_MULTIPLIER, raw)
    );

    return Number(multiplier.toFixed(2));
}

/* =========================================================
   MULTIPLIER -> DURATION
========================================================= */

function multiplierToDuration(multiplier) {
    const safe = Math.max(
        MIN_MULTIPLIER,
        Math.min(MAX_MULTIPLIER, multiplier)
    );

    const seconds = Math.log(safe) / GROWTH_RATE;
    return Math.round(seconds * 1000);
}

/* =========================================================
   SEND
========================================================= */

function send(ws, type, data = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    try {
        ws.send(JSON.stringify({ type, ...data }));
    } catch (error) {
        console.error("WebSocket send error:", error.message);
    }
}

/* =========================================================
   BROADCAST
========================================================= */

function broadcast(type, data = {}) {
    const message = JSON.stringify({ type, ...data });

    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(message);
            } catch (error) {
                console.error("Broadcast error:", error.message);
            }
        }
    }
}

function broadcastPlayers() {
    broadcast("players:update", { players: clients.size });
}

/* =========================================================
   LEADERBOARD HELPERS
========================================================= */

function ensurePlayerStats(userId, username) {
    if (!playerStats.has(userId)) {
        playerStats.set(userId, {
            userId,
            username,
            profit: 0,
            wins: 0,
            losses: 0,
            totalBets: 0,
            highestMultiplier: 1
        });
    }
    return playerStats.get(userId);
}

function getLeaderboard() {
    const all = Array.from(playerStats.values());
    const active = all.filter(p => p.totalBets > 0);

    active.sort((a, b) => {
        if (b.profit !== a.profit) return b.profit - a.profit;
        if (b.highestMultiplier !== a.highestMultiplier) {
            return b.highestMultiplier - a.highestMultiplier;
        }
        return b.wins - a.wins;
    });

    return active.slice(0, MAX_LEADERBOARD);
}

function broadcastLeaderboard() {
    broadcast("leaderboard:update", {
        players: getLeaderboard()
    });
}

function broadcastHistory() {
    broadcast("history:update", {
        rounds: roundHistory.slice(0, MAX_HISTORY)
    });
}

/* =========================================================
   PUBLIC ROUND
========================================================= */

function publicRound(round) {
    return {
        id: round.id,
        startAt: round.startAt,
        hash: round.hash,
        rockets: {
            red: { startAt: round.rockets?.red?.startAt || round.startAt },
            green: { startAt: round.rockets?.green?.startAt || round.startAt },
            blue: { startAt: round.rockets?.blue?.startAt || round.startAt }
        }
    };
}

/* =========================================================
   CREATE ROUND
========================================================= */

function createRound() {
    if (currentRound && !currentRound.finished) {
        console.log("⚠️ Active round already exists");
        return;
    }

    if (nextRoundTimer) {
        clearTimeout(nextRoundTimer);
        nextRoundTimer = null;
    }

    if (waitingTimer) {
        clearTimeout(waitingTimer);
        waitingTimer = null;
    }

    roundCounter++;
    const roundId = roundCounter;
    const startAt = now();
    const serverSeed = randomSeed();
    const hash = sha256Hex(serverSeed);

    const round = {
        id: roundId,
        startAt,
        serverSeed,
        hash,
        finished: false,
        completedAt: null,
        clientSeeds: [],
        luckyPlayers: [],
        rockets: {
            red: { startAt, multiplier: null, crashed: false, crashedAt: null },
            green: { startAt, multiplier: null, crashed: false, crashedAt: null },
            blue: { startAt, multiplier: null, crashed: false, crashedAt: null }
        }
    };

    currentRound = round;

    console.log("");
    console.log("==========================================");
    console.log(`🚀 ROUND ${round.id} START (WAITING)`);
    console.log(`🔐 Server Seed Hash: ${hash.slice(0, 32)}...`);
    console.log(`👥 Collecting client seeds...`);
    console.log("==========================================");

    broadcast("round:start", publicRound(round));

    waitingTimer = setTimeout(() => {
        waitingTimer = null;
        startRunningPhase(round);
    }, INTERMISSION_MS);
}

/* =========================================================
   START RUNNING PHASE
========================================================= */

function startRunningPhase(round) {
    if (!currentRound || currentRound.id !== round.id) return;
    if (round.finished) return;

    console.log("");
    console.log("==========================================");
    console.log(`🎲 ROUND ${round.id} – SELECTING LUCKY PLAYERS`);
    console.log(`👥 Total client seeds: ${round.clientSeeds.length}`);

    const luckyPlayers = selectLuckyPlayers(
        round.clientSeeds,
        round.serverSeed,
        LUCKY_PLAYER_COUNT
    );

    round.luckyPlayers = luckyPlayers;

    console.log(`🎯 Lucky Players selected:`);
    luckyPlayers.forEach((p, i) => {
        const marker = p.isSystem ? "[SYS]" : "[USR]";
        console.log(`   ${i + 1}. ${marker} ${p.username} | seed: ${p.seed.slice(0, 12)}...`);
    });

    const runningStartAt = now();

    round.rockets = {
        red: createServerRocket("red", runningStartAt, round),
        green: createServerRocket("green", runningStartAt, round),
        blue: createServerRocket("blue", runningStartAt, round)
    };

    console.log("");
    console.log(`🚀 ROUND ${round.id} RUNNING`);
    console.log(`   🔴 RED   → ${round.rockets.red.multiplier}x`);
    console.log(`   🟢 GREEN → ${round.rockets.green.multiplier}x`);
    console.log(`   🔵 BLUE  → ${round.rockets.blue.multiplier}x`);
    console.log("==========================================");

    broadcast("round:running", {
        id: round.id,
        startAt: runningStartAt,
        luckyPlayers: luckyPlayers.map(p => ({
            userId: p.userId,
            username: p.username,
            isSystem: !!p.isSystem
        })),
        rockets: {
            red: { startAt: round.rockets.red.startAt },
            green: { startAt: round.rockets.green.startAt },
            blue: { startAt: round.rockets.blue.startAt }
        }
    });

    for (const color of ROCKET_COLORS) {
        scheduleRocketCrash(round, color);
    }
}

/* =========================================================
   CREATE SERVER ROCKET
========================================================= */

function createServerRocket(color, startAt, round) {
    const multiplier = crashMultiplierFromSeed(
        round.serverSeed,
        round.luckyPlayers,
        round.id,
        color
    );
    const duration = multiplierToDuration(multiplier);

    return {
        color,
        startAt,
        multiplier,
        duration,
        crashAt: startAt + duration,
        crashed: false,
        crashedAt: null,
        timer: null
    };
}

/* =========================================================
   SCHEDULE CRASH
========================================================= */

function scheduleRocketCrash(round, color) {
    const rocket = round.rockets[color];
    if (!rocket || rocket.multiplier === null) return;

    const delay = Math.max(0, rocket.crashAt - now());

    rocket.timer = setTimeout(() => {
        crashRocket(round.id, color);
    }, delay);
}

/* =========================================================
   CRASH ROCKET
========================================================= */

function crashRocket(roundId, color) {
    if (!currentRound || currentRound.id !== roundId) return;

    const round = currentRound;
    if (round.finished) return;

    const rocket = round.rockets[color];
    if (!rocket || rocket.crashed) return;
    if (rocket.multiplier === null) return;

    rocket.crashed = true;
    rocket.crashedAt = now();
    rocket.timer = null;

    broadcast("rocket:crash", {
        roundId: round.id,
        color,
        multiplier: rocket.multiplier,
        crashedAt: rocket.crashedAt
    });

    console.log(`💥 ${color.toUpperCase()} CRASH | ${rocket.multiplier}x | Round ${round.id}`);

    for (const [ws, session] of sessions.entries()) {
        const bet = session.activeBet;
        if (bet && bet.roundId === round.id && bet.color === color && !bet.cashedOut) {
            const stats = ensurePlayerStats(session.userId, session.username);
            stats.losses++;
            stats.profit = parseFloat((stats.profit - bet.amount).toFixed(2));

            console.log(`❌ [LOST] User: ${session.username} | Rocket: ${color} | -${bet.amount} ${session.currency}`);

            send(ws, "bet:lost", {
                roundId: round.id,
                rocket: color,
                multiplier: rocket.multiplier,
                amount: bet.amount,
                balance: session.balance,
                currency: session.currency
            });

            session.activeBet = null;
        }
    }

    checkRoundFinished(round);
}

/* =========================================================
   CHECK ROUND FINISHED
========================================================= */

function checkRoundFinished(round) {
    if (!round || round.finished) return;

    const crashed = ROCKET_COLORS.filter(
        color => round.rockets[color] && round.rockets[color].crashed
    ).length;

    console.log(`📊 Round ${round.id}: ${crashed}/3`);

    if (crashed !== 3) return;

    finishRound(round);
}

/* =========================================================
   BUILD RESULTS
========================================================= */

function buildResults(round) {
    return {
        red: {
            multiplier: round.rockets.red.multiplier,
            crashedAt: round.rockets.red.crashedAt
        },
        green: {
            multiplier: round.rockets.green.multiplier,
            crashedAt: round.rockets.green.crashedAt
        },
        blue: {
            multiplier: round.rockets.blue.multiplier,
            crashedAt: round.rockets.blue.crashedAt
        }
    };
}

/* =========================================================
   FINISH ROUND
========================================================= */

function finishRound(round) {
    if (!round || round.finished) return;

    round.finished = true;
    round.completedAt = now();

    for (const color of ROCKET_COLORS) {
        const rocket = round.rockets[color];
        if (rocket && rocket.timer) {
            clearTimeout(rocket.timer);
            rocket.timer = null;
        }
    }

    const results = buildResults(round);

    broadcast("round:complete", {
        id: round.id,
        completedAt: round.completedAt,
        results,
        serverSeed: round.serverSeed,
        serverSeedHash: round.hash,
        allClientSeeds: round.clientSeeds.map(p => ({
            userId: p.userId,
            username: p.username,
            seed: p.seed
        })),
        luckyPlayers: round.luckyPlayers.map(p => ({
            userId: p.userId,
            username: p.username,
            seed: p.seed,
            isSystem: !!p.isSystem
        })),
        nonce: round.id
    });

    console.log("");
    console.log(`🏁 ROUND ${round.id} COMPLETE`);
    console.log(`🔴 RED   ${results.red.multiplier}x`);
    console.log(`🟢 GREEN ${results.green.multiplier}x`);
    console.log(`🔵 BLUE  ${results.blue.multiplier}x`);

    roundHistory.unshift({
        roundId: round.id,
        serverSeed: round.serverSeed,
        serverSeedHash: round.hash,
        allClientSeeds: round.clientSeeds.map(p => ({
            userId: p.userId,
            username: p.username,
            seed: p.seed
        })),
        luckyPlayers: round.luckyPlayers.map(p => ({
            userId: p.userId,
            username: p.username,
            seed: p.seed,
            isSystem: !!p.isSystem
        })),
        nonce: round.id,
        red: results.red.multiplier,
        green: results.green.multiplier,
        blue: results.blue.multiplier,
        timestamp: round.completedAt
    });

    if (roundHistory.length > MAX_HISTORY) {
        roundHistory.length = MAX_HISTORY;
    }

    broadcastHistory();

    const nextRoundAt = round.completedAt + EXPLOSION_DELAY_MS + INTERMISSION_MS;

    if (waitingTimer) {
        clearTimeout(waitingTimer);
        waitingTimer = null;
    }

    waitingTimer = setTimeout(() => {
        waitingTimer = null;

        broadcast("round:waiting", {
            roundId: round.id,
            nextRoundAt,
            duration: INTERMISSION_MS
        });

        console.log(`⏳ Countdown started: ${INTERMISSION_MS / 1000} seconds...`);
    }, EXPLOSION_DELAY_MS);

    if (nextRoundTimer) {
        clearTimeout(nextRoundTimer);
        nextRoundTimer = null;
    }

    nextRoundTimer = setTimeout(() => {
        nextRoundTimer = null;

        if (currentRound && currentRound.id === round.id && currentRound.finished) {
            createRound();
        }
    }, EXPLOSION_DELAY_MS + INTERMISSION_MS);
}

/* =========================================================
   CASINO API CLIENT (HTTP)
========================================================= */

async function casinoFetch(endpoint, body) {
    const url = `${CASINO_API_URL}${endpoint}`;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const data = await response.json();
        return { ok: response.ok, status: response.status, data };
    } catch (error) {
        console.error(`❌ Casino API error [${endpoint}]:`, error.message);
        return {
            ok: false,
            status: 500,
            data: { error: "CASINO_API_UNREACHABLE", message: error.message }
        };
    }
}

async function casinoGetBalance(token) {
    return casinoFetch("/api/casino/balance", { token });
}

async function casinoBet(token, amount, roundId, transactionId) {
    return casinoFetch("/api/casino/bet", {
        token, amount, roundId, transactionId
    });
}

async function casinoWin(token, amount, roundId, transactionId) {
    return casinoFetch("/api/casino/win", {
        token, amount, roundId, transactionId
    });
}

async function casinoRollback(token, betTransactionId, roundId, rollbackTransactionId) {
    return casinoFetch("/api/casino/rollback", {
        token, betTransactionId, roundId, rollbackTransactionId
    });
}

/* =========================================================
   HANDLERS – AUTH
========================================================= */

async function handleAuthLogin(ws, data) {
    const token = typeof data?.token === "string" ? data.token.trim() : null;

    if (!token) {
        send(ws, "auth:error", { reason: "Missing token" });
        return;
    }

    console.log(`🔐 Auth request | Token: ${token.slice(0, 16)}...`);

    const result = await casinoGetBalance(token);

    if (!result.ok) {
        console.log(`❌ Auth failed: ${result.data?.message || "Unknown"}`);
        send(ws, "auth:error", {
            reason: result.data?.message || "Authentication failed"
        });
        return;
    }

    const clientSeed = (typeof data?.clientSeed === "string" && data.clientSeed.length > 0)
        ? data.clientSeed.slice(0, 64)
        : crypto.randomBytes(8).toString("hex");

    const session = {
        token,
        userId: result.data.userId,
        username: result.data.username,
        balance: result.data.balance,
        currency: result.data.currency,
        clientSeed,
        activeBet: null
    };

    sessions.set(ws, session);

    ensurePlayerStats(session.userId, session.username);

    console.log(`✅ Auth OK | User: ${session.username} | Balance: ${session.balance} ${session.currency}`);
    console.log(`🎲 Client Seed: ${clientSeed.slice(0, 16)}...`);

    send(ws, "auth:success", {
        userId: session.userId,
        username: session.username,
        balance: session.balance,
        currency: session.currency,
        clientSeed
    });

    send(ws, "leaderboard:update", {
        players: getLeaderboard()
    });

    send(ws, "history:update", {
        rounds: roundHistory.slice(0, MAX_HISTORY)
    });

    broadcastLeaderboard();
}

/* =========================================================
   HANDLERS – BET PLACE
   
   ⭐ გამოსწორებულია: targetRoundId = currentRound.id
========================================================= */

async function handleBetPlace(ws, data) {
    const session = sessions.get(ws);

    if (!session) {
        send(ws, "bet:error", { reason: "Not authenticated" });
        return;
    }

    if (session.activeBet) {
        send(ws, "bet:error", { reason: "You already have an active bet" });
        return;
    }

    const color = typeof data?.rocket === "string" ? data.rocket : null;
    const amount = Number(data?.amount);

    if (!color || !ROCKET_COLORS.includes(color)) {
        send(ws, "bet:error", { reason: "Invalid rocket" });
        return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        send(ws, "bet:error", { reason: "Invalid amount" });
        return;
    }

    // ⭐ შემოწმება: ფსონი მხოლოდ waiting ფაზაში
    if (!currentRound) {
        send(ws, "bet:error", { reason: "No active round" });
        return;
    }

    if (currentRound.rockets?.red?.multiplier !== null) {
        send(ws, "bet:error", {
            reason: "Round in progress. Wait for next round."
        });
        return;
    }

    if (amount > session.balance) {
        send(ws, "bet:error", {
            reason: "Insufficient balance",
            code: "INSUFFICIENT_FUNDS"
        });
        return;
    }

    // ⭐⭐⭐ მთავარი გამოსწორება: currentRound.id (არა roundCounter + 1)
    const targetRoundId = currentRound.id;
    const transactionId = `bet_${session.userId}_${targetRoundId}_${color}_${Date.now()}`;

    console.log(`💰 [BET] User: ${session.username} | Rocket: ${color} | Amount: ${amount} | Target Round: ${targetRoundId}`);

    const result = await casinoBet(session.token, amount, targetRoundId, transactionId);

    if (!result.ok) {
        console.log(`❌ [BET FAIL] ${result.data?.message || "Unknown"}`);
        send(ws, "bet:error", {
            reason: result.data?.message || "Bet failed",
            code: result.data?.error
        });
        return;
    }

    session.balance = result.data.newBalance;
    session.activeBet = {
        roundId: targetRoundId,
        color,
        amount,
        transactionId,
        placedAt: now(),
        cashedOut: false
    };

    const stats = ensurePlayerStats(session.userId, session.username);
    stats.totalBets++;

    // client seed-ის დამატება მიმდინარე round-ში (თუ waiting ფაზაა)
    if (currentRound && !currentRound.finished && currentRound.rockets?.red?.multiplier === null) {
        const alreadyAdded = currentRound.clientSeeds.some(
            p => p.userId === session.userId
        );

        if (!alreadyAdded) {
            currentRound.clientSeeds.push({
                userId: session.userId,
                username: session.username,
                seed: session.clientSeed
            });

            console.log(`🎲 Client seed added to round ${currentRound.id} | Total: ${currentRound.clientSeeds.length}`);
        }
    }

    console.log(`✅ [BET OK] Target Round: ${targetRoundId} | New balance: ${session.balance} ${session.currency}`);

    send(ws, "bet:success", {
        roundId: targetRoundId,
        rocket: color,
        amount,
        newBalance: session.balance,
        currency: session.currency,
        transactionId
    });
}

/* =========================================================
   HANDLERS – BET CASHOUT
========================================================= */

async function handleBetCashout(ws, data) {
    const session = sessions.get(ws);

    if (!session) {
        send(ws, "cashout:error", { reason: "Not authenticated" });
        return;
    }

    const bet = session.activeBet;

    if (!bet) {
        send(ws, "cashout:error", { reason: "No active bet" });
        return;
    }

    if (bet.cashedOut) {
        send(ws, "cashout:error", { reason: "Already cashed out" });
        return;
    }

    if (!currentRound || currentRound.id !== bet.roundId) {
        send(ws, "cashout:error", { reason: "Round mismatch" });
        return;
    }

    const rocket = currentRound.rockets[bet.color];

    if (!rocket || rocket.crashed) {
        send(ws, "cashout:error", { reason: "Rocket already crashed" });
        return;
    }

    if (rocket.multiplier === null) {
        send(ws, "cashout:error", { reason: "Round not started yet" });
        return;
    }

    const elapsed = now() - rocket.startAt;
    const multiplier = multiplierAtElapsed(elapsed);
    const winAmount = parseFloat((bet.amount * multiplier).toFixed(2));

    const transactionId = `win_${session.userId}_${bet.roundId}_${bet.color}_${Date.now()}`;

    console.log(`💸 [CASHOUT] User: ${session.username} | ${multiplier}x | Win: ${winAmount}`);

    const result = await casinoWin(session.token, winAmount, bet.roundId, transactionId);

    if (!result.ok) {
        console.log(`❌ [CASHOUT FAIL] ${result.data?.message || "Unknown"}`);
        send(ws, "cashout:error", {
            reason: result.data?.message || "Cashout failed"
        });
        return;
    }

    session.balance = result.data.newBalance;
    bet.cashedOut = true;
    session.activeBet = null;

    const profit = parseFloat((winAmount - bet.amount).toFixed(2));
    const stats = ensurePlayerStats(session.userId, session.username);
    stats.wins++;
    stats.profit = parseFloat((stats.profit + profit).toFixed(2));
    if (multiplier > stats.highestMultiplier) {
        stats.highestMultiplier = multiplier;
    }

    console.log(`✅ [CASHOUT OK] New balance: ${session.balance} ${session.currency} | Profit: ${profit}`);

    send(ws, "cashout:success", {
        roundId: bet.roundId,
        rocket: bet.color,
        multiplier,
        winAmount,
        newBalance: session.balance,
        currency: session.currency,
        transactionId
    });

    broadcastLeaderboard();
}

/* =========================================================
   HANDLERS – BALANCE REFRESH
========================================================= */

async function handleBalanceRefresh(ws) {
    const session = sessions.get(ws);
    if (!session) return;

    const result = await casinoGetBalance(session.token);
    if (!result.ok) return;

    session.balance = result.data.balance;

    send(ws, "balance:update", {
        balance: session.balance,
        currency: session.currency
    });
}

/* =========================================================
   HANDLERS – CLIENT SEED UPDATE
========================================================= */

function handleClientSeedUpdate(ws, data) {
    const session = sessions.get(ws);
    if (!session) return;

    const newSeed = typeof data?.clientSeed === "string" ? data.clientSeed.slice(0, 64) : null;
    if (!newSeed) return;

    session.clientSeed = newSeed;

    console.log(`🎲 [CLIENT SEED UPDATE] User: ${session.username} | New seed: ${newSeed.slice(0, 16)}...`);

    send(ws, "client:seed:updated", {
        clientSeed: newSeed
    });
}

/* =========================================================
   SCORE LOCK (ისტორიული API)
========================================================= */

function handleScoreLock(ws, data) {
    if (!currentRound || currentRound.finished) {
        send(ws, "score:locked", { success: false, reason: "No active round" });
        return;
    }

    const color = typeof data?.rocket === "string"
        ? data.rocket
        : typeof data?.color === "string"
            ? data.color
            : null;

    if (!color || !ROCKET_COLORS.includes(color)) {
        send(ws, "score:locked", { success: false, reason: "Invalid rocket" });
        return;
    }

    const rocket = currentRound.rockets[color];

    if (!rocket || rocket.multiplier === null) {
        send(ws, "score:locked", { success: false, reason: "Rocket not found" });
        return;
    }

    if (rocket.crashed) {
        send(ws, "score:locked", {
            success: false,
            roundId: currentRound.id,
            rocket: color,
            reason: "Rocket already crashed"
        });
        return;
    }

    const elapsed = now() - rocket.startAt;
    const multiplier = multiplierAtElapsed(elapsed);

    send(ws, "score:locked", {
        success: true,
        roundId: currentRound.id,
        rocket: color,
        multiplier,
        lockedAt: now()
    });
}

/* =========================================================
   TIME SYNC
========================================================= */

function handleTimeRequest(ws, data) {
    send(ws, "time:response", {
        clientTime: Number(data?.clientTime) || 0,
        serverTime: now()
    });
}

/* =========================================================
   CURRENT STATE
========================================================= */

function sendCurrentState(ws) {
    if (currentRound && !currentRound.finished) {
        send(ws, "round:start", publicRound(currentRound));

        if (currentRound.rockets?.red?.multiplier !== null && currentRound.luckyPlayers.length > 0) {
            send(ws, "round:running", {
                id: currentRound.id,
                startAt: currentRound.rockets.red.startAt,
                luckyPlayers: currentRound.luckyPlayers.map(p => ({
                    userId: p.userId,
                    username: p.username,
                    isSystem: !!p.isSystem
                })),
                rockets: {
                    red: { startAt: currentRound.rockets.red.startAt },
                    green: { startAt: currentRound.rockets.green.startAt },
                    blue: { startAt: currentRound.rockets.blue.startAt }
                }
            });
        }

        for (const color of ROCKET_COLORS) {
            const rocket = currentRound.rockets[color];
            if (rocket && rocket.crashed) {
                send(ws, "rocket:crash", {
                    roundId: currentRound.id,
                    color,
                    multiplier: rocket.multiplier,
                    crashedAt: rocket.crashedAt
                });
            }
        }
        return;
    }

    if (currentRound && currentRound.finished) {
        const results = buildResults(currentRound);

        send(ws, "round:complete", {
            id: currentRound.id,
            completedAt: currentRound.completedAt,
            results,
            serverSeed: currentRound.serverSeed,
            serverSeedHash: currentRound.hash,
            allClientSeeds: currentRound.clientSeeds.map(p => ({
                userId: p.userId,
                username: p.username,
                seed: p.seed
            })),
            luckyPlayers: currentRound.luckyPlayers.map(p => ({
                userId: p.userId,
                username: p.username,
                seed: p.seed,
                isSystem: !!p.isSystem
            })),
            nonce: currentRound.id
        });

        const nextRoundAt = currentRound.completedAt + EXPLOSION_DELAY_MS + INTERMISSION_MS;

        send(ws, "round:waiting", {
            roundId: currentRound.id,
            nextRoundAt,
            duration: INTERMISSION_MS
        });
    }
}

/* =========================================================
   WEBSOCKET SERVER
========================================================= */

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, request) => {
    clients.add(ws);

    console.log(`🔌 Client connected | Players: ${clients.size}`);

    send(ws, "server:hello", {
        serverTime: now(),
        players: clients.size,
        version: "rocket-race-v7-provably-fair"
    });

    sendCurrentState(ws);
    broadcastPlayers();

    ws.on("message", async raw => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            console.warn("⚠️ Invalid JSON");
            return;
        }

        if (!data || typeof data !== "object") return;

        switch (data.type) {
            case "auth:login":
                await handleAuthLogin(ws, data);
                break;
            case "bet:place":
                await handleBetPlace(ws, data);
                break;
            case "bet:cashout":
                await handleBetCashout(ws, data);
                break;
            case "balance:refresh":
                await handleBalanceRefresh(ws);
                break;
            case "client:seed:update":
                handleClientSeedUpdate(ws, data);
                break;
            case "leaderboard:request":
                send(ws, "leaderboard:update", {
                    players: getLeaderboard()
                });
                break;
            case "history:request":
                send(ws, "history:update", {
                    rounds: roundHistory.slice(0, MAX_HISTORY)
                });
                break;
            case "time:request":
                handleTimeRequest(ws, data);
                break;
            case "score:lock":
                handleScoreLock(ws, data);
                break;
            case "ping":
                send(ws, "pong", { serverTime: now() });
                break;
            default:
                console.log(`⚠️ Unknown event: ${data.type}`);
                break;
        }
    });

    ws.on("close", async () => {
        const session = sessions.get(ws);

        if (session && session.activeBet) {
            const bet = session.activeBet;
            const rocket = currentRound?.rockets?.[bet.color];

            if (rocket && !rocket.crashed && rocket.multiplier !== null && currentRound?.id === bet.roundId) {
                const elapsed = now() - rocket.startAt;
                const multiplier = multiplierAtElapsed(elapsed);
                const winAmount = parseFloat((bet.amount * multiplier).toFixed(2));
                const transactionId = `win_${session.userId}_${bet.roundId}_${bet.color}_${Date.now()}`;

                await casinoWin(session.token, winAmount, bet.roundId, transactionId);

                const profit = parseFloat((winAmount - bet.amount).toFixed(2));
                const stats = ensurePlayerStats(session.userId, session.username);
                stats.wins++;
                stats.profit = parseFloat((stats.profit + profit).toFixed(2));
                if (multiplier > stats.highestMultiplier) {
                    stats.highestMultiplier = multiplier;
                }

                console.log(`🔌 [AUTO-CASHOUT ON DISCONNECT] User: ${session.username} | ${multiplier}x | Win: ${winAmount}`);
                broadcastLeaderboard();
            }
        }

        sessions.delete(ws);
        clients.delete(ws);
        console.log(`🔌 Client disconnected | Players: ${clients.size}`);
        broadcastPlayers();
    });

    ws.on("error", error => {
        console.error("WebSocket error:", error.message);
    });
});

/* =========================================================
   MIME TYPES
========================================================= */

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf"
};

/* =========================================================
   SAFE FILE PATH
========================================================= */

function getSafeFilePath(pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }

    const normalized = path.normalize(decoded);
    const root = path.resolve(PUBLIC_DIR);
    const resolved = path.resolve(path.join(PUBLIC_DIR, normalized));

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null;
    }

    return resolved;
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer((req, res) => {
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
        res.writeHead(400);
        res.end("Bad Request");
        return;
    }

    let pathname = url.pathname;
    if (pathname === "/") {
        pathname = "/index.html";
    }

    const filePath = getSafeFilePath(pathname);
    if (!filePath) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.stat(filePath, (error, stats) => {
        if (error || !stats.isFile()) {
            res.writeHead(404);
            res.end("Not Found");
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
        });

        fs.createReadStream(filePath).pipe(res);
    });
});

/* =========================================================
   WEBSOCKET UPGRADE
========================================================= */

server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
        pathname = new URL(
            request.url,
            `http://${request.headers.host || "localhost"}`
        ).pathname;
    } catch {
        socket.destroy();
        return;
    }

    if (pathname !== "/ws" && pathname !== "/") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit("connection", ws, request);
    });
});

/* =========================================================
   START SERVER
========================================================= */

server.listen(PORT, () => {
    console.log("");
    console.log("==========================================");
    console.log("   🚀 ROCKET RACE SERVER (PROVABLY FAIR)");
    console.log("==========================================");
    console.log(`🌐 HTTP    : http://localhost:${PORT}`);
    console.log(`🔌 WS      : ws://localhost:${PORT}/ws`);
    console.log(`🎰 Casino  : ${CASINO_API_URL}`);
    console.log(`⏱️ Wait    : ${INTERMISSION_MS / 1000}s`);
    console.log(`💥 Explosion delay : ${EXPLOSION_DELAY_MS / 1000}s`);
    console.log(`📈 RTP     : ${((1 - HOUSE_EDGE) * 100).toFixed(0)}% (${(HOUSE_EDGE * 100).toFixed(0)}% House Edge)`);
    console.log(`🎲 Lucky Players : ${LUCKY_PLAYER_COUNT} (random selection)`);
    console.log(`🏆 Leaderboard : Top ${MAX_LEADERBOARD}`);
    console.log(`📜 History : Last ${MAX_HISTORY} rounds (full PF data)`);
    console.log(`🔐 Default Seeds : ${DEFAULT_CLIENT_SEEDS.length} generated`);
    console.log("==========================================");
    console.log("");

    createRound();
});

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown(signal) {
    console.log(`\n🛑 ${signal} received`);

    if (nextRoundTimer) {
        clearTimeout(nextRoundTimer);
        nextRoundTimer = null;
    }

    if (waitingTimer) {
        clearTimeout(waitingTimer);
        waitingTimer = null;
    }

    if (currentRound) {
        for (const color of ROCKET_COLORS) {
            const rocket = currentRound.rockets[color];
            if (rocket && rocket.timer) {
                clearTimeout(rocket.timer);
                rocket.timer = null;
            }
        }
    }

    for (const ws of clients) {
        try {
            ws.close();
        } catch {}
    }

    server.close(() => {
        process.exit(0);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));