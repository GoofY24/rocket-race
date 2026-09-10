// ============================================================
// audio.js — Sound effects (UPDATED crash sound)
// ============================================================

let audioOn = true;
let audioCtx = null;

function getAudioCtx() {
    if (!audioOn) return null;
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") {
            audioCtx.resume();
        }
        return audioCtx;
    } catch (e) {
        console.warn("AudioContext not available:", e);
        return null;
    }
}

function playTone(freq, dur = 0.08, type = "sine", vol = 0.025) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + dur);
    } catch (e) {
        // silent fail
    }
}

// ============================================================
// აფეთქების ხმა — უფრო მძიმე და ეფექტური
// ============================================================

function playCrashSound() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
        // პირველი დარტყმა — დაბალი სიხშირე
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(150, ctx.currentTime);
        osc1.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.3);
        gain1.gain.setValueAtTime(0.04, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start();
        osc1.stop(ctx.currentTime + 0.3);

        // მეორე დარტყმა — მაღალი სიხშირე (აფეთქების ეფექტი)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'square';
        osc2.frequency.setValueAtTime(600, ctx.currentTime);
        osc2.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.2);
        gain2.gain.setValueAtTime(0.025, ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start();
        osc2.stop(ctx.currentTime + 0.25);

        // მესამე — ნოიზი (სტატიკა)
        const bufferSize = ctx.sampleRate * 0.15;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / bufferSize * 6);
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const gain3 = ctx.createGain();
        gain3.gain.setValueAtTime(0.06, ctx.currentTime);
        gain3.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        noise.connect(gain3);
        gain3.connect(ctx.destination);
        noise.start();
        noise.stop(ctx.currentTime + 0.15);

    } catch (e) {
        // fallback — უბრალო ტონი
        playTone(80, 0.3, 'sawtooth', 0.04);
        setTimeout(() => playTone(50, 0.2, 'sawtooth', 0.03), 50);
    }
}

// ============================================================
// AudioFX ობიექტი
// ============================================================

const AudioFX = {
    toggle() {
        audioOn = !audioOn;
        if (audioOn) playTone(600, 0.06);
        return audioOn;
    },
    select() {
        playTone(430, 0.05, "triangle");
    },
    turbo() {
        playTone(820, 0.12, "square");
        setTimeout(() => playTone(1100, 0.08, "square"), 70);
    },
    lock() {
        playTone(760, 0.07, "triangle");
        setTimeout(() => playTone(980, 0.08, "triangle"), 60);
    },
    crash() {
        playCrashSound();
    },
    win() {
        playTone(523, 0.1, "sine", 0.02);
        setTimeout(() => playTone(659, 0.1, "sine", 0.02), 100);
        setTimeout(() => playTone(784, 0.15, "sine", 0.02), 200);
    },
    lose() {
        playTone(330, 0.15, "sawtooth", 0.02);
        setTimeout(() => playTone(277, 0.2, "sawtooth", 0.02), 120);
    }
};

// Make AudioFX globally available
window.AudioFX = AudioFX;

console.log("🔊 AudioFX loaded with enhanced crash sound");