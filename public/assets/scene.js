/* =========================================================
   ROCKET RACE
   MODERN SEQUENTIAL MULTI-ROCKET CANVAS ENGINE
   
   ⚡ FULLY COMPATIBLE WITH app.js ⚡
   
   All public API methods preserved:
   - startRound(roundData)
   - rocketCrash({roundId, color, multiplier, crashedAt})
   - completeRound(roundData)
   - setRoundWaiting(roundId, nextRoundAt)
   - selectRocket(color)
   - clear()
   - getRound()
   - getSelectedRocket()
   - getMultiplier(color)
========================================================= */

const canvas = document.getElementById("canvas");

if (!canvas) {
    console.error("❌ #canvas ვერ მოიძებნა HTML-ში");
}

const ctx = canvas ? canvas.getContext("2d") : null;

if (!ctx) {
    console.error("❌ Canvas 2D context ვერ შეიქმნა");
}

/* =========================================================
   COLORS
========================================================= */

const COLORS = {
    red: "#ff3355",
    green: "#00ff88",
    blue: "#3b82ff"
};

const COLORS_LIGHT = {
    red: "#ff88aa",
    green: "#88ffcc",
    blue: "#88bbff"
};

const COLORS_DARK = {
    red: "#aa0022",
    green: "#00aa55",
    blue: "#0044aa"
};

const ROCKET_ORDER = ["red", "green", "blue"];

const LANE_POSITIONS = {
    red: 0.22,
    green: 0.50,
    blue: 0.78
};

/* =========================================================
   MULTIPLIER CURVE – იდენტურია server.js-თან (GROWTH_RATE = 0.035)
========================================================= */

const GROWTH_RATE = 0.035;
const MAX_MULTIPLIER = 1000;

function calculateMultiplier(startAt, now = gameNow()) {
    if (!Number.isFinite(Number(startAt))) {
        return 1;
    }

    const elapsed = Math.max(0, now - Number(startAt));
    const seconds = elapsed / 1000;

    let multiplier = Math.exp(GROWTH_RATE * seconds);

    if (!Number.isFinite(multiplier)) {
        multiplier = MAX_MULTIPLIER;
    }

    multiplier = Math.max(1, multiplier);
    multiplier = Math.min(MAX_MULTIPLIER, multiplier);

    return Number(multiplier.toFixed(2));
}

/* =========================================================
   STATE
========================================================= */

let activeRound = null;
let selectedRocket = null;

let width = 1;
let height = 1;
let dpr = 1;

let animationStarted = false;
let lastGameTime = Date.now();

const explosions = [];
const stars = [];
const nebulas = [];
const floatingParticles = [];

/* =========================================================
   SERVER / GAME CLOCK
========================================================= */

function gameNow() {
    if (typeof window.getServerNow === "function") {
        return window.getServerNow();
    }
    return Date.now();
}

/* =========================================================
   RESIZE
========================================================= */

function resize() {
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();

    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);

    dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    createStars();
    createNebulas();
    createFloatingParticles();

    if (activeRound) {
        for (const color of ROCKET_ORDER) {
            const rocket = activeRound.rockets[color];
            if (!rocket) continue;
            updateRocketPosition(rocket, gameNow());
        }
    }
}

window.addEventListener("resize", resize);

/* =========================================================
   STARS – პარალაქსის ეფექტით
========================================================= */

function createStars() {
    stars.length = 0;

    const count = Math.max(120, Math.floor((width * height) / 7000));

    for (let i = 0; i < count; i++) {
        const layer = Math.random();
        stars.push({
            x: Math.random() * width,
            y: Math.random() * height,
            size: Math.random() * 1.8 + 0.3,
            alpha: Math.random() * 0.7 + 0.2,
            twinkle: Math.random() * Math.PI * 2,
            speed: 0.1 + layer * 0.5,
            layer: layer,
            color: Math.random() > 0.9 ? "#88ccff" : "#ffffff"
        });
    }
}

/* =========================================================
   NEBULAS – კოსმოსური ნისლეულები
========================================================= */

function createNebulas() {
    nebulas.length = 0;

    const colors = [
        "rgba(59, 130, 255, 0.08)",
        "rgba(255, 51, 85, 0.06)",
        "rgba(0, 255, 136, 0.05)",
        "rgba(147, 51, 234, 0.07)"
    ];

    for (let i = 0; i < 4; i++) {
        nebulas.push({
            x: Math.random() * width,
            y: Math.random() * height,
            radius: Math.random() * 300 + 200,
            color: colors[i],
            pulse: Math.random() * Math.PI * 2,
            speed: 0.0001 + Math.random() * 0.0002
        });
    }
}

/* =========================================================
   FLOATING PARTICLES – კოსმოსური მტვერი
========================================================= */

function createFloatingParticles() {
    floatingParticles.length = 0;

    const count = Math.max(30, Math.floor((width * height) / 25000));

    for (let i = 0; i < count; i++) {
        floatingParticles.push({
            x: Math.random() * width,
            y: Math.random() * height,
            size: Math.random() * 1.5 + 0.5,
            speedX: (Math.random() - 0.5) * 0.3,
            speedY: -Math.random() * 0.4 - 0.1,
            alpha: Math.random() * 0.4 + 0.1,
            color: Math.random() > 0.5 ? "#3b82ff" : "#00ff88"
        });
    }
}

/* =========================================================
   CREATE ROCKET
========================================================= */

function createRocket(round, color, data) {
    if (!data) return null;

    const lane = LANE_POSITIONS[color];

    const startAt = Number(data.startAt);
    const safeStartAt = Number.isFinite(startAt)
        ? startAt
        : Number(round.startAt) || gameNow();

    const baseX = width * lane;
    const baseY = height * 0.82;

    return {
        color,
        roundId: Number(round.id),
        startAt: safeStartAt,
        crashAt: null,
        crashed: false,
        crashedAt: null,
        crashMultiplier: null,
        baseX,
        baseY,
        x: baseX,
        y: baseY,
        rotation: 0,
        trail: [],
        trailParticles: [],
        launchProgress: 0,
        opacity: 0,
        scale: 0.90 + Math.random() * 0.12,
        wobble: Math.random() * Math.PI * 2,
        flamePhase: Math.random() * Math.PI * 2
    };
}

/* =========================================================
   START NEW ROUND
========================================================= */

function startRound(roundData) {
    if (!roundData) {
        console.warn("⚠️ startRound: roundData არ არსებობს");
        return;
    }

    const roundId = Number(roundData.id);
    if (!Number.isFinite(roundId)) {
        console.warn("⚠️ არასწორი roundId:", roundData.id);
        return;
    }

    if (activeRound && activeRound.id === roundId) {
        return;
    }

    console.log("🚀 START ROUND", roundId, "startAt:", roundData.startAt);

    activeRound = {
        id: roundId,
        startAt: Number(roundData.startAt) || gameNow(),
        rockets: {},
        finished: false,
        finishedAt: null,
        waiting: false
    };

    for (const color of ROCKET_ORDER) {
        const rocketData = roundData.rockets && roundData.rockets[color];
        if (!rocketData) {
            console.warn(`⚠️ Round ${roundId}: ${color} data არ არსებობს`);
            continue;
        }

        const rocket = createRocket(activeRound, color, rocketData);
        if (rocket) {
            activeRound.rockets[color] = rocket;
        }
    }

    explosions.length = 0;
    selectedRocket = null;

    const now = gameNow();
    for (const color of ROCKET_ORDER) {
        const rocket = activeRound.rockets[color];
        if (rocket) {
            updateRocketPosition(rocket, now);
        }
    }

    startAnimationLoop();
}

/* =========================================================
   ROCKET CRASH
========================================================= */

function crashRocket(roundId, color, crashedAt, multiplier) {
    if (!activeRound) return;

    const id = Number(roundId);
    if (activeRound.id !== id) return;

    const rocket = activeRound.rockets[color];
    if (!rocket) return;

    if (rocket.crashed) return;

    const safeCrashAt = Number(crashedAt);
    rocket.crashedAt = Number.isFinite(safeCrashAt) ? safeCrashAt : gameNow();

    if (Number.isFinite(Number(multiplier))) {
        rocket.crashMultiplier = Number(multiplier);
    } else {
        rocket.crashMultiplier = calculateMultiplier(rocket.startAt, rocket.crashedAt);
    }

    updateRocketPosition(rocket, rocket.crashedAt);

    rocket.crashed = true;

    createExplosion(rocket.x, rocket.y, COLORS[color] || "#ffffff");

    rocket.trail = [];
    rocket.trailParticles = [];

    console.log(`💥 CRASH | Round ${id} | ${color} | ${rocket.crashMultiplier}x`);

    checkRoundFinished();
}

/* =========================================================
   CHECK ROUND FINISHED
========================================================= */

function checkRoundFinished() {
    if (!activeRound) return;
    if (activeRound.finished) return;

    let crashedCount = 0;

    for (const color of ROCKET_ORDER) {
        const rocket = activeRound.rockets[color];
        if (rocket && rocket.crashed) crashedCount++;
    }

    if (crashedCount !== 3) {
        console.log(`⏳ Round ${activeRound.id}: ${crashedCount}/3 crashed`);
        return;
    }

    activeRound.finished = true;
    activeRound.finishedAt = gameNow();

    console.log(`🏁 ROUND ${activeRound.id} COMPLETE — 3/3 CRASHED`);
}

/* =========================================================
   COMPLETE ROUND
========================================================= */

function completeRound(roundData) {
    if (!activeRound) return;

    if (roundData && Number(roundData.id) !== activeRound.id) return;

    console.log("📦 COMPLETE ROUND", roundData.id);

    activeRound.finished = true;
    activeRound.finishedAt = Number(roundData?.completedAt) || gameNow();

    if (roundData && roundData.results) {
        for (const color of ROCKET_ORDER) {
            const rocket = activeRound.rockets[color];
            const finalMultiplier = Number(roundData.results[color]?.multiplier);

            if (rocket && Number.isFinite(finalMultiplier)) {
                rocket.crashMultiplier = finalMultiplier;
            }
        }
    }
}

/* =========================================================
   ROUND WAITING
========================================================= */

function setRoundWaiting(roundId, nextRoundAt) {
    if (!activeRound) return;
    if (Number(roundId) !== activeRound.id) return;

    console.log("⏸️ ROUND WAITING", roundId);

    activeRound.waiting = true;
    activeRound.finished = true;
    activeRound.finishedAt = activeRound.finishedAt || gameNow();

    for (const color of ROCKET_ORDER) {
        const rocket = activeRound.rockets[color];
        if (!rocket) continue;
        rocket.opacity = 0;
        rocket.trail = [];
        rocket.trailParticles = [];
    }

    activeRound.nextRoundAt = Number(nextRoundAt) || (activeRound.finishedAt + 5000);
}

/* =========================================================
   UPDATE ROCKET POSITION
========================================================= */

function updateRocketPosition(rocket, now) {
    if (!rocket) return;

    if (now < rocket.startAt) {
        rocket.opacity = 0;
        return;
    }

    const sinceStart = Math.max(0, now - rocket.startAt);
    const launchDuration = 500;

    rocket.launchProgress = Math.min(1, sinceStart / launchDuration);

    const ease = 1 - Math.pow(1 - rocket.launchProgress, 3);
    rocket.opacity = ease;

    if (rocket.opacity < 0.1 && sinceStart > 0) {
        rocket.opacity = 0.1;
    }

    if (rocket.crashed) return;

    const multiplier = calculateMultiplier(rocket.startAt, now);

    const VISUAL_MAX = 100;
    const normalized = Math.min(1, Math.max(0,
        Math.log(Math.max(1, multiplier)) / Math.log(VISUAL_MAX)
    ));

    const lift = Math.pow(normalized, 0.65);

    const lane = LANE_POSITIONS[rocket.color];
    const targetX = width * lane;

    const wobble = Math.sin(now / 500 + rocket.wobble) * 4 * (1 - normalized * 0.5);

    rocket.x = targetX + wobble;
    rocket.y = height * (0.82 - lift * 0.72);

    rocket.rotation = Math.sin(now / 400 + rocket.wobble) * 0.035;

    // Trail points
    rocket.trail.push({ x: rocket.x, y: rocket.y, time: now });

    if (rocket.trail.length > 35) {
        rocket.trail.shift();
    }

    rocket.trail = rocket.trail.filter(point => now - point.time < 500);

    // Trail particles (ნაპერწკლები კვალზე)
    if (Math.random() > 0.3) {
        rocket.trailParticles.push({
            x: rocket.x + (Math.random() - 0.5) * 15,
            y: rocket.y + Math.random() * 20,
            vx: (Math.random() - 0.5) * 30,
            vy: Math.random() * 30 + 20,
            life: 1,
            size: Math.random() * 2 + 1
        });
    }

    // Update trail particles
    for (let i = rocket.trailParticles.length - 1; i >= 0; i--) {
        const p = rocket.trailParticles[i];
        p.x += p.vx * 0.016;
        p.y += p.vy * 0.016;
        p.life -= 0.03;

        if (p.life <= 0) {
            rocket.trailParticles.splice(i, 1);
        }
    }
}

/* =========================================================
   UPDATE
========================================================= */

function updateActiveRound(now) {
    if (!activeRound) return;

    if (activeRound.waiting) {
        updateExplosions(now);
        updateFloatingParticles(now);
        return;
    }

    for (const color of ROCKET_ORDER) {
        const rocket = activeRound.rockets[color];
        if (!rocket) continue;
        updateRocketPosition(rocket, now);
    }

    updateExplosions(now);
    updateFloatingParticles(now);
}

function updateFloatingParticles(now) {
    for (const p of floatingParticles) {
        p.x += p.speedX;
        p.y += p.speedY;

        if (p.y < -10) {
            p.y = height + 10;
            p.x = Math.random() * width;
        }

        if (p.x < -10) p.x = width + 10;
        if (p.x > width + 10) p.x = -10;
    }
}

/* =========================================================
   BACKGROUND – კოსმოსური
========================================================= */

function drawBackground(now) {
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    // Deep space gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);

    gradient.addColorStop(0, "#02030a");
    gradient.addColorStop(0.3, "#050818");
    gradient.addColorStop(0.65, "#080b1e");
    gradient.addColorStop(1, "#02030a");

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Nebulas
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const nebula of nebulas) {
        const pulse = 1 + Math.sin(now * nebula.speed + nebula.pulse) * 0.15;
        const radius = nebula.radius * pulse;

        const nebulaGradient = ctx.createRadialGradient(
            nebula.x, nebula.y, 0,
            nebula.x, nebula.y, radius
        );

        nebulaGradient.addColorStop(0, nebula.color);
        nebulaGradient.addColorStop(1, "rgba(0,0,0,0)");

        ctx.fillStyle = nebulaGradient;
        ctx.beginPath();
        ctx.arc(nebula.x, nebula.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();

    // Stars – parallax + twinkle
    for (const star of stars) {
        const twinkle = 0.6 + Math.sin(now / 800 + star.twinkle) * 0.4;
        const alpha = star.alpha * twinkle;

        // Slow drift
        star.y += star.speed * 0.02;
        if (star.y > height + 5) {
            star.y = -5;
            star.x = Math.random() * width;
        }

        ctx.globalAlpha = alpha;
        ctx.fillStyle = star.color;

        if (star.layer > 0.7) {
            // Bright stars with glow
            ctx.shadowBlur = 6;
            ctx.shadowColor = star.color;
        }

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // Floating particles
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const p of floatingParticles) {
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.shadowBlur = 8;
        ctx.shadowColor = p.color;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
    ctx.globalAlpha = 1;

    // Horizon glow
    const glow = ctx.createRadialGradient(
        width / 2, height * 0.95, 10,
        width / 2, height * 0.95, width * 0.8
    );

    glow.addColorStop(0, "rgba(59, 130, 255, 0.15)");
    glow.addColorStop(0.5, "rgba(0, 255, 136, 0.05)");
    glow.addColorStop(1, "rgba(0, 255, 136, 0)");

    ctx.fillStyle = glow;
    ctx.fillRect(0, height * 0.40, width, height * 0.60);

    drawGrid(now);
}

/* =========================================================
   GRID – დინამიური
========================================================= */

function drawGrid(now) {
    if (!ctx) return;

    ctx.save();

    const pulse = 0.06 + Math.sin(now / 2000) * 0.02;
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = "#3b82ff";
    ctx.lineWidth = 1;

    // Horizontal lines
    for (let i = 0; i <= 8; i++) {
        const y = height * (0.45 + i * 0.065);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    // Perspective lines
    for (let i = -10; i <= 10; i++) {
        const x = width / 2 + i * 100;
        ctx.beginPath();
        ctx.moveTo(width / 2, height * 0.45);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
}

/* =========================================================
   TRAIL – გრადიენტული
========================================================= */

function drawTrail(rocket) {
    if (!rocket || rocket.trail.length < 2) return;

    const color = COLORS[rocket.color];
    if (!color) return;

    ctx.save();
    ctx.shadowBlur = 18;
    ctx.shadowColor = color;

    for (let i = 1; i < rocket.trail.length; i++) {
        const a = rocket.trail[i - 1];
        const b = rocket.trail[i];
        const progress = i / rocket.trail.length;

        ctx.globalAlpha = progress * 0.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 + progress * 3;
        ctx.lineCap = "round";

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;

    // Trail particles
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const p of rocket.trailParticles) {
        ctx.globalAlpha = p.life * 0.7;
        ctx.fillStyle = COLORS_LIGHT[rocket.color];
        ctx.shadowBlur = 8;
        ctx.shadowColor = color;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
}

/* =========================================================
   DRAW ROCKET – დეტალური
========================================================= */

function drawRocket(rocket, now) {
    if (!rocket) return;
    if (rocket.opacity <= 0) return;

    let alpha = rocket.opacity;

    if (rocket.crashed && rocket.crashedAt) {
        const age = now - rocket.crashedAt;
        alpha *= Math.max(0, 1 - age / 350);
    }

    if (alpha <= 0) return;

    const color = COLORS[rocket.color];
    const colorLight = COLORS_LIGHT[rocket.color];
    const colorDark = COLORS_DARK[rocket.color];

    if (!color) return;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Outer glow
    const glowGradient = ctx.createRadialGradient(
        rocket.x, rocket.y, 0,
        rocket.x, rocket.y, 60
    );
    glowGradient.addColorStop(0, `${color}44`);
    glowGradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glowGradient;
    ctx.beginPath();
    ctx.arc(rocket.x, rocket.y, 60, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(rocket.x, rocket.y);
    ctx.rotate(rocket.rotation);
    ctx.scale(rocket.scale, rocket.scale);

    ctx.shadowBlur = 25;
    ctx.shadowColor = color;

    /* ===== FLAME ===== */
    if (!rocket.crashed) {
        const flameWave = Math.sin(now / 60 + rocket.flamePhase) * 5;
        const flameLength = 45 + Math.abs(flameWave) * 2;

        // Outer flame
        const outerFlame = ctx.createLinearGradient(0, 20, 0, flameLength + 20);
        outerFlame.addColorStop(0, color);
        outerFlame.addColorStop(0.5, colorLight);
        outerFlame.addColorStop(1, "rgba(255,255,255,0)");

        ctx.fillStyle = outerFlame;
        ctx.beginPath();
        ctx.moveTo(-10, 18);
        ctx.quadraticCurveTo(-6, 30, 0, flameLength + flameWave);
        ctx.quadraticCurveTo(6, 30, 10, 18);
        ctx.closePath();
        ctx.fill();

        // Inner flame
        const innerFlame = ctx.createLinearGradient(0, 20, 0, flameLength);
        innerFlame.addColorStop(0, "#ffffff");
        innerFlame.addColorStop(0.4, colorLight);
        innerFlame.addColorStop(1, "rgba(255,255,255,0)");

        ctx.fillStyle = innerFlame;
        ctx.beginPath();
        ctx.moveTo(-5, 18);
        ctx.quadraticCurveTo(-3, 25, 0, flameLength * 0.7 + flameWave);
        ctx.quadraticCurveTo(3, 25, 5, 18);
        ctx.closePath();
        ctx.fill();
    }

    /* ===== BODY ===== */
    const body = ctx.createLinearGradient(-13, -30, 13, 20);
    body.addColorStop(0, "#ffffff");
    body.addColorStop(0.3, "#e8ecf1");
    body.addColorStop(0.7, "#a0a8b8");
    body.addColorStop(1, "#4a5260");

    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -32);
    ctx.quadraticCurveTo(14, -16, 13, 12);
    ctx.lineTo(9, 20);
    ctx.lineTo(-9, 20);
    ctx.lineTo(-13, 12);
    ctx.quadraticCurveTo(-14, -16, 0, -32);
    ctx.closePath();
    ctx.fill();

    // Outline
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Body accent line
    ctx.strokeStyle = `${color}88`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-8, -20);
    ctx.lineTo(-8, 15);
    ctx.moveTo(8, -20);
    ctx.lineTo(8, 15);
    ctx.stroke();

    /* ===== NOSE ===== */
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -32);
    ctx.lineTo(-8, -20);
    ctx.lineTo(8, -20);
    ctx.closePath();
    ctx.fill();

    // Nose highlight
    ctx.fillStyle = colorLight;
    ctx.beginPath();
    ctx.moveTo(0, -32);
    ctx.lineTo(-3, -24);
    ctx.lineTo(3, -24);
    ctx.closePath();
    ctx.fill();

    /* ===== WINDOW ===== */
    const windowGradient = ctx.createRadialGradient(-3, -7, 1, 0, -5, 10);
    windowGradient.addColorStop(0, "#ffffff");
    windowGradient.addColorStop(0.3, colorLight);
    windowGradient.addColorStop(0.7, color);
    windowGradient.addColorStop(1, "#0a0e18");

    ctx.fillStyle = windowGradient;
    ctx.beginPath();
    ctx.arc(0, -5, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Window shine
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.beginPath();
    ctx.arc(-3, -8, 2.5, 0, Math.PI * 2);
    ctx.fill();

    /* ===== WINGS ===== */
    ctx.fillStyle = colorDark;

    // Left wing
    ctx.beginPath();
    ctx.moveTo(-9, 5);
    ctx.lineTo(-26, 20);
    ctx.lineTo(-11, 18);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Right wing
    ctx.beginPath();
    ctx.moveTo(9, 5);
    ctx.lineTo(26, 20);
    ctx.lineTo(11, 18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Wing highlights
    ctx.fillStyle = colorLight;
    ctx.beginPath();
    ctx.moveTo(-9, 5);
    ctx.lineTo(-18, 12);
    ctx.lineTo(-11, 14);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(9, 5);
    ctx.lineTo(18, 12);
    ctx.lineTo(11, 14);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
    ctx.globalAlpha = 1;
}

/* =========================================================
   EXPLOSION – შოკის ტალღა + ნაწილაკები
========================================================= */

function createExplosion(x, y, color) {
    if (!Number.isFinite(x)) return;
    if (!Number.isFinite(y)) return;

    const particles = [];
    const count = 60;

    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * 250;
        const size = Math.random() * 5 + 1;

        particles.push({
            x,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size,
            life: 1,
            decay: 0.008 + Math.random() * 0.012,
            color: Math.random() > 0.5 ? color : "#ffffff"
        });
    }

    // Smoke particles (ნელი, დიდი)
    for (let i = 0; i < 15; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 20 + Math.random() * 60;

        particles.push({
            x,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 20,
            size: Math.random() * 8 + 4,
            life: 1,
            decay: 0.005 + Math.random() * 0.008,
            color: "rgba(100, 100, 120, 0.5)",
            isSmoke: true
        });
    }

    explosions.push({
        x,
        y,
        color,
        createdAt: gameNow(),
        particles,
        shockwaveRadius: 0,
        shockwaveAlpha: 1
    });
}

function updateExplosions(now) {
    const dt = Math.min(0.033, Math.max(0.001, (now - lastGameTime) / 1000));

    for (let i = explosions.length - 1; i >= 0; i--) {
        const explosion = explosions[i];
        const age = now - explosion.createdAt;
        const life = 1800;

        if (age >= life) {
            explosions.splice(i, 1);
            continue;
        }

        // Shockwave
        explosion.shockwaveRadius += 400 * dt;
        explosion.shockwaveAlpha = Math.max(0, 1 - age / 600);

        // Particles
        for (const p of explosion.particles) {
            p.x += p.vx * dt;
            p.y += p.vy * dt;

            if (!p.isSmoke) {
                p.vy += 150 * dt;
                p.vx *= 0.98;
                p.vy *= 0.98;
            } else {
                p.vx *= 0.95;
                p.vy *= 0.95;
            }

            p.life = Math.max(0, p.life - p.decay);
        }
    }
}

function drawExplosions() {
    if (!ctx) return;

    for (const explosion of explosions) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";

        // Shockwave
        if (explosion.shockwaveAlpha > 0) {
            ctx.globalAlpha = explosion.shockwaveAlpha * 0.6;
            ctx.strokeStyle = explosion.color;
            ctx.lineWidth = 3 * explosion.shockwaveAlpha;
            ctx.shadowBlur = 20;
            ctx.shadowColor = explosion.color;

            ctx.beginPath();
            ctx.arc(explosion.x, explosion.y, explosion.shockwaveRadius, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Particles
        for (const p of explosion.particles) {
            ctx.globalAlpha = p.life;

            if (p.isSmoke) {
                ctx.fillStyle = p.color;
                ctx.shadowBlur = 0;
            } else {
                ctx.fillStyle = p.color;
                ctx.shadowBlur = 15;
                ctx.shadowColor = p.color;
            }

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * (p.isSmoke ? (2 - p.life) : p.life), 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    ctx.globalAlpha = 1;
}

/* =========================================================
   DRAW ACTIVE ROUND
========================================================= */

function drawActiveRound(now) {
    if (!activeRound) return;
    if (activeRound.waiting) return;

    // Trails first
    for (const color of ROCKET_ORDER) {
        const rocket = activeRound.rockets[color];
        if (!rocket) continue;
        drawTrail(rocket);
    }

    // Rockets
    for (const color of ROCKET_ORDER) {
        const rocket = activeRound.rockets[color];
        if (!rocket) continue;
        drawRocket(rocket, now);
    }
}

/* =========================================================
   MAIN ANIMATION LOOP
========================================================= */

function animate() {
    if (!ctx) return;

    const now = gameNow();

    updateActiveRound(now);

    drawBackground(now);
    drawActiveRound(now);
    drawExplosions();

    lastGameTime = now;

    requestAnimationFrame(animate);
}

/* =========================================================
   START ANIMATION
========================================================= */

function startAnimationLoop() {
    if (animationStarted) return;

    animationStarted = true;
    lastGameTime = gameNow();

    requestAnimationFrame(animate);
}

/* =========================================================
   SELECT ROCKET
========================================================= */

function selectRocket(color) {
    if (!activeRound) {
        selectedRocket = null;
        return;
    }

    if (activeRound.finished || activeRound.waiting) {
        selectedRocket = null;
        return;
    }

    const rocket = activeRound.rockets[color];
    if (!rocket) return;
    if (rocket.crashed) return;

    selectedRocket = color;

    console.log(`🎯 Selected rocket: ${color}`);
}

/* =========================================================
   CLEAR SCENE
========================================================= */

function clearScene() {
    activeRound = null;
    selectedRocket = null;
    explosions.length = 0;

    if (ctx) {
        ctx.clearRect(0, 0, width, height);
    }

    console.log("🧹 Rocket scene cleared");
}

/* =========================================================
   PUBLIC API (უცვლელია – app.js თავსებადია)
========================================================= */

window.RocketScene = {

    startRound,

    rocketCrash({ roundId, color, multiplier, crashedAt }) {
        crashRocket(roundId, color, crashedAt, multiplier);
    },

    completeRound,

    setRoundWaiting,

    selectRocket,

    clear: clearScene,

    getRound() {
        return activeRound;
    },

    getSelectedRocket() {
        return selectedRocket;
    },

    getMultiplier(color) {
        if (!activeRound) return 1;

        const rocket = activeRound.rockets[color];
        if (!rocket) return 1;

        if (rocket.crashed && rocket.crashMultiplier !== null) {
            return rocket.crashMultiplier;
        }

        return calculateMultiplier(rocket.startAt, gameNow());
    }
};

/* =========================================================
   START
========================================================= */

resize();
startAnimationLoop();

console.log("🚀 Modern Rocket Scene loaded — fully compatible with app.js");