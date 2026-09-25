/**
 * Synthesized sound cues for the receiver (no downloads, no licences).
 * Non-word sounds only: clicks, poppers, room tone, crowd texture, music.
 * Voices (a whisper, the shout, the cheer) come only from real recordings
 * dropped into public/audio/ (see README.md there).
 *
 * All take an audio-clock time `at` so a beat can be laid out in one go and
 * stay sample-accurate: switch click at T0, shout at T0+0.15, poppers at
 * T0+0.19 / +0.27 ... Levels are pre-balanced under the engine's limiter
 * (room tone ~ -32 LUFS, music ~ -18, shout peak ~ 6 dB below the ceiling).
 */

const rand = (a, b) => a + Math.random() * (b - a);

/** Envelope helper: silent -> peak in `attack` -> exponential decay to `end`. */
function env(param, at, peak, attack, end, floor = 0.0005) {
    param.setValueAtTime(0.0001, at);
    param.linearRampToValueAtTime(peak, at + attack);
    param.exponentialRampToValueAtTime(floor, end);
}

function noiseSource(engine, seconds, at) {
    const src = engine.ctx.createBufferSource();
    src.buffer = engine.noise(seconds);
    // A random offset so two cues never share the same grain.
    src.start(at, Math.random() * Math.max(0, src.buffer.duration - seconds));
    src.stop(at + seconds + 0.02);
    return src;
}

function filter(ctx, type, freq, q = 0.7) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
}

/* ------------------------------------------------------------------ *
 * Room tone: AC hum + distant traffic, looped
 * ------------------------------------------------------------------ */

// Room tone is synthesized once, at a low rate (it is low-passed at 700 Hz
// anyway), and ideally behind the gate: generating it inside the "open" tap
// cost the first visible frame ~40 ms (160 ms on a throttled phone).
const TONE_RATE = 22050;
const TONE_SECONDS = 8;
let toneData = null;

function synthToneChannel(ch) {
    const len = TONE_RATE * TONE_SECONDS;
    const d = new Float32Array(len);
    let brown = 0;
    let b0 = 0, b1 = 0, b2 = 0;
    // Traffic swells: two slow, unrelated sines (loop-aligned) on the low band.
    const w1 = (2 * Math.PI * 3) / len;
    const w2 = (2 * Math.PI * 5) / len;
    for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        brown = (brown + 0.02 * white) / 1.02;
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        const pink = (b0 + b1 + b2 + white * 0.1848) * 0.11;
        const swell = 0.75 + 0.25 * Math.sin(w1 * i + ch) * Math.sin(w2 * i + 1.7);
        d[i] = brown * 3.2 * swell + pink * 0.18;
    }
    // Crossfade the seam so the loop never ticks.
    const fade = Math.floor(TONE_RATE * 0.25);
    for (let i = 0; i < fade; i++) {
        const k = i / fade;
        d[i] = d[i] * k + d[len - fade + i] * (1 - k);
    }
    return d;
}

/** Precomputes the room tone (no AudioContext needed). `pause` yields between channels. */
export async function prepareRoomTone(pause = () => Promise.resolve()) {
    if (toneData) return;
    const left = synthToneChannel(0);
    await pause();
    const right = synthToneChannel(1);
    toneData = [left, right];
}

function roomToneBuffer(ctx) {
    if (!toneData) toneData = [synthToneChannel(0), synthToneChannel(1)];
    const buf = ctx.createBuffer(2, toneData[0].length, TONE_RATE);
    buf.copyToChannel(toneData[0], 0);
    buf.copyToChannel(toneData[1], 1);
    return buf;
}

export function createRoomTone(engine) {
    const { ctx } = engine;
    let nodes = null;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(engine.ambience);

    function build() {
        const src = ctx.createBufferSource();
        src.buffer = roomToneBuffer(ctx);
        src.loop = true;
        const lp = filter(ctx, 'lowpass', 700, 0.5);
        src.connect(lp);
        lp.connect(gain);
        // Mains hum (50 Hz grid -> 100/150 Hz from the AC compressor), barely there.
        const hum = ctx.createOscillator();
        hum.frequency.value = 100;
        const hum2 = ctx.createOscillator();
        hum2.frequency.value = 150;
        const hg = ctx.createGain();
        hg.gain.value = 0.012;
        const hg2 = ctx.createGain();
        hg2.gain.value = 0.005;
        hum.connect(hg); hg.connect(gain);
        hum2.connect(hg2); hg2.connect(gain);
        const t = ctx.currentTime;
        src.start(t); hum.start(t); hum2.start(t);
        nodes = [src, hum, hum2];
    }

    const ramp = (level, seconds, at = ctx.currentTime) => {
        const g = gain.gain;
        g.cancelScheduledValues(at);
        g.setValueAtTime(Math.max(0.0001, g.value), at);
        g.linearRampToValueAtTime(Math.max(0.0001, level), at + Math.max(0.02, seconds));
    };

    return {
        /** Fades in (1.2 s by default). */
        start(level = 0.09, fadeS = 1.2) {
            if (!nodes) build();
            ramp(level, fadeS);
        },
        /** Everyone holds their breath: the room goes quiet at `at`. */
        duck(at, level = 0.0001, seconds = 0.06) { ramp(level, seconds, at); },
        set: ramp,
        stop(fadeS = 0.6) {
            ramp(0.0001, fadeS);
            const list = nodes;
            nodes = null;
            if (list) list.forEach((n) => { try { n.stop(ctx.currentTime + fadeS + 0.05); } catch { /* stopped */ } });
        }
    };
}

/* ------------------------------------------------------------------ *
 * One-shots
 * ------------------------------------------------------------------ */

/** A dry wall rocker switch: a tiny broadband tick plus a 180 Hz body. */
export function switchClick(engine, at) {
    const { ctx } = engine;
    const out = engine.out(0);
    const tick = noiseSource(engine, 0.03, at);
    const hp = filter(ctx, 'highpass', 2000);
    const tg = ctx.createGain();
    env(tg.gain, at, 0.55, 0.0015, at + 0.018);
    tick.connect(hp); hp.connect(tg); tg.connect(out);
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(190, at);
    body.frequency.exponentialRampToValueAtTime(120, at + 0.04);
    const bg = ctx.createGain();
    env(bg.gain, at, 0.35, 0.002, at + 0.045);
    body.connect(bg); bg.connect(out);
    body.start(at); body.stop(at + 0.06);
    // The rocker settling a moment later, softer.
    const tick2 = noiseSource(engine, 0.02, at + 0.028);
    const hp2 = filter(ctx, 'highpass', 3200);
    const tg2 = ctx.createGain();
    env(tg2.gain, at + 0.028, 0.18, 0.001, at + 0.04);
    tick2.connect(hp2); hp2.connect(tg2); tg2.connect(out);
    // Close and dry but small: it must never be louder than the shout.
    out.gain.value = 0.28;
}

/** Party popper: a crack, then paper streamers fluttering out. */
export function popper(engine, at, pan = 0, level = 1) {
    const { ctx } = engine;
    const out = engine.out(pan);
    // Poppers are off-frame, across the room: a crack, not a gunshot.
    out.gain.value = 0.45 * level;
    const crack = noiseSource(engine, 0.08, at);
    const bp = filter(ctx, 'bandpass', 1500, 0.6);
    const cg = ctx.createGain();
    env(cg.gain, at, 0.7, 0.004, at + 0.07);
    crack.connect(bp); bp.connect(cg); cg.connect(out); cg.connect(engine.reverb);
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(140, at);
    thump.frequency.exponentialRampToValueAtTime(55, at + 0.08);
    const thg = ctx.createGain();
    env(thg.gain, at, 0.35, 0.004, at + 0.1);
    thump.connect(thg); thg.connect(out);
    thump.start(at); thump.stop(at + 0.12);
    // Streamers: high rustle with a random flutter.
    const rustle = noiseSource(engine, 0.5, at + 0.02);
    const hp = filter(ctx, 'bandpass', 4200, 0.9);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, at + 0.02);
    for (let i = 0; i < 9; i++) {
        const t = at + 0.03 + i * 0.045;
        rg.gain.linearRampToValueAtTime(rand(0.05, 0.16) * (1 - i / 10), t);
    }
    rg.gain.exponentialRampToValueAtTime(0.0005, at + 0.5);
    rustle.connect(hp); hp.connect(rg); rg.connect(out);
}

/** A soft air whoosh (camera glide, balloon drop). */
export function whoosh(engine, at, dur = 0.9, level = 0.22, pan = 0) {
    const { ctx } = engine;
    const src = noiseSource(engine, dur + 0.1, at);
    const bp = filter(ctx, 'bandpass', 300, 1.2);
    bp.frequency.setValueAtTime(300, at);
    bp.frequency.exponentialRampToValueAtTime(1800, at + dur * 0.55);
    bp.frequency.exponentialRampToValueAtTime(500, at + dur);
    const g = engine.out(pan);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(level, at + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0005, at + dur);
    src.connect(bp); bp.connect(g); g.connect(engine.reverb);
}

/** Match strike: a scratch, then a soft flare. */
export function matchStrike(engine, at, pan = 0, level = 0.2) {
    const { ctx } = engine;
    const out = engine.out(pan);
    out.gain.value = level;
    const scratch = noiseSource(engine, 0.2, at);
    const bp = filter(ctx, 'bandpass', 2600, 1.1);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, at);
    for (let i = 0; i < 6; i++) sg.gain.linearRampToValueAtTime(rand(0.3, 1), at + 0.012 + i * 0.022);
    sg.gain.exponentialRampToValueAtTime(0.0005, at + 0.16);
    scratch.connect(bp); bp.connect(sg); sg.connect(out);
    const flare = noiseSource(engine, 0.6, at + 0.12);
    const lp = filter(ctx, 'lowpass', 900, 0.6);
    const fg = ctx.createGain();
    env(fg.gain, at + 0.12, 0.6, 0.05, at + 0.7);
    flare.connect(lp); lp.connect(fg); fg.connect(out);
}

/* ------------------------------------------------------------------ *
 * The crowd: texture only, no synthesized words
 * ------------------------------------------------------------------ *
 * Worded synthesis of a Thai crowd lands as robotic (review-room.md #2), so
 * until real recordings exist the people are heard as an unpitched roar of
 * breath and voices-in-a-room plus applause, and the DOM word carries
 * "เซอร์ไพรส์!". Real clips (public/audio/README.md) replace this.
 */

/**
 * A room of friends going "woo": band-passed noise in the vowel region,
 * each band swelling and fluttering on its own, with a rising then falling
 * centre (the shape of a cheer, not of a word).
 */
function crowdRoar(engine, at, dur, level) {
    const { ctx } = engine;
    const bands = [[420, 1.4, 0.9], [900, 1.6, 1], [1600, 1.8, 0.7], [2600, 2.2, 0.35]];
    bands.forEach(([freq, q, lv], i) => {
        const src = noiseSource(engine, dur + 0.2, at);
        const bp = filter(ctx, 'bandpass', freq, q);
        bp.frequency.setValueAtTime(freq * 0.85, at);
        bp.frequency.linearRampToValueAtTime(freq * 1.12, at + dur * 0.3);
        bp.frequency.linearRampToValueAtTime(freq * 0.95, at + dur);
        const g = engine.out((i % 2 ? 0.35 : -0.35) * (i / 3));
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(level * lv, at + 0.06 + i * 0.02);
        // A few voices joining and dropping out.
        for (let k = 1; k < 7; k++) {
            const t = at + (dur * 0.7 * k) / 7;
            g.gain.linearRampToValueAtTime(level * lv * rand(0.55, 1), t);
        }
        g.gain.exponentialRampToValueAtTime(0.0005, at + dur);
        src.connect(bp); bp.connect(g); g.connect(engine.reverb);
    });
}

/**
 * Lights-on crowd: roar + applause. soft = reduced motion / gentle (-6 dB,
 * slower attack). A recorded clip named "surprise" replaces all of it.
 */
export function surpriseShout(engine, at, { soft = false, level = 1 } = {}) {
    const lv = level * (soft ? 0.5 : 1);
    if (engine.playClip('surprise', { at, gain: 0.8 * lv })) return;
    crowdRoar(engine, at, soft ? 1.2 : 1.5, 0.22 * lv);
    setTimeout(() => {
        if (engine.ctx.state !== 'closed') applause(engine, Math.max(at + 0.35, engine.ctx.currentTime + 0.02), soft ? 1.2 : 1.8, 0.2 * lv);
    }, soft ? 0 : 200);
}

/** Finale: a bigger roar + applause (or the recorded "cheer" clip). */
export function cheer(engine, at, level = 1) {
    if (engine.playClip('cheer', { at, gain: 0.7 * level })) return;
    crowdRoar(engine, at, 1.8, 0.2 * level);
    setTimeout(() => {
        if (engine.ctx.state !== 'closed') applause(engine, Math.max(at + 0.2, engine.ctx.currentTime + 0.05), 2.4, 0.22 * level);
    }, 120);
}

/** Crowd applause: many hands, random, decaying. */
export function applause(engine, at, dur = 1.6, level = 0.18) {
    const { ctx } = engine;
    const out = engine.out(0);
    out.gain.value = level;
    const bus = filter(ctx, 'bandpass', 1400, 0.6);
    bus.connect(out);
    bus.connect(engine.reverb);
    const rate = 30; // claps per second across the room
    const n = Math.floor(dur * rate);
    // Built in three batches (a few hundred nodes at once was a 150 ms task
    // on a throttled phone, right on the reveal frame). Times stay absolute.
    const batch = (from, to) => {
        if (ctx.state === 'closed') return;
        for (let i = from; i < to; i++) {
            const t = Math.max(at + (i / n) * dur + (Math.random() - 0.5) * (dur / n) * 2, ctx.currentTime + 0.02);
            const fall = 1 - (t - at) / dur;
            const src = noiseSource(engine, 0.05, t);
            const g = ctx.createGain();
            env(g.gain, t, rand(0.3, 1) * (0.35 + 0.65 * fall), 0.002, t + rand(0.02, 0.045));
            if (ctx.createStereoPanner) {
                const p = ctx.createStereoPanner();
                p.pan.value = rand(-0.8, 0.8);
                src.connect(g); g.connect(p); p.connect(bus);
            } else {
                src.connect(g); g.connect(bus);
            }
        }
    };
    const third = Math.ceil(n / 3);
    batch(0, third);
    setTimeout(() => batch(third, third * 2), 90);
    setTimeout(() => batch(third * 2, n), 180);
}


/* ------------------------------------------------------------------ *
 * Party groove (plays under the tour to the cake)
 * ------------------------------------------------------------------ */

const CHORDS = [
    [261.63, 329.63, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]
];
const BASSLINE = [65.41, 55.0, 43.65, 49.0];

export function createPartyLoop(engine) {
    const { ctx } = engine;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(engine.master);
    const beat = 60 / 112;
    const bar = beat * 4;
    let timer = 0;
    let next = 0;
    let barIndex = 0;
    let running = false;

    function note(freq, t, dur, type, peak, dest = out) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        const g = ctx.createGain();
        env(g.gain, t, peak, 0.012, t + dur);
        o.connect(g); g.connect(dest);
        o.start(t); o.stop(t + dur + 0.05);
    }
    function kick(t) {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(120, t);
        o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
        const g = ctx.createGain();
        env(g.gain, t, 0.5, 0.004, t + 0.22);
        o.connect(g); g.connect(out);
        o.start(t); o.stop(t + 0.25);
    }
    function hat(t, lv) {
        const src = noiseSource(engine, 0.05, t);
        const hp = filter(ctx, 'highpass', 7500);
        const g = ctx.createGain();
        env(g.gain, t, lv, 0.002, t + 0.04);
        src.connect(hp); hp.connect(g); g.connect(out);
    }
    function snap(t) {
        const src = noiseSource(engine, 0.15, t);
        const bp = filter(ctx, 'bandpass', 1800, 0.9);
        const g = ctx.createGain();
        env(g.gain, t, 0.22, 0.003, t + 0.12);
        src.connect(bp); bp.connect(g); g.connect(out); g.connect(engine.reverb);
    }
    function scheduleBar(t) {
        const chord = CHORDS[barIndex % 4];
        for (let b = 0; b < 4; b++) {
            const bt = t + b * beat;
            kick(bt);
            if (b % 2) snap(bt);
            hat(bt + beat / 2, 0.06);
            // Off-beat stabs: bright, short, a party not a lullaby.
            chord.forEach((f) => note(f * 2, bt + beat / 2, 0.16, 'triangle', 0.035));
        }
        note(BASSLINE[barIndex % 4], t, bar * 0.9, 'triangle', 0.18);
        barIndex++;
    }
    function pump() {
        clearTimeout(timer);
        if (!running) return;
        while (next - ctx.currentTime < 1.5) {
            scheduleBar(next);
            next += bar;
        }
        timer = setTimeout(pump, 500);
    }
    return {
        start(at, level = 0.4, fadeS = 1.2) {
            running = true;
            barIndex = 0;
            next = Math.max(at, ctx.currentTime + 0.02);
            out.gain.cancelScheduledValues(ctx.currentTime);
            out.gain.setValueAtTime(0.0001, next);
            out.gain.linearRampToValueAtTime(level, next + fadeS);
            pump();
        },
        stop(fadeS = 0.6) {
            if (!running) return;
            running = false;
            clearTimeout(timer);
            const now = ctx.currentTime;
            out.gain.cancelScheduledValues(now);
            out.gain.setValueAtTime(out.gain.value, now);
            out.gain.linearRampToValueAtTime(0.0001, now + fadeS);
        }
    };
}

/* ------------------------------------------------------------------ *
 * Small UI cues (moved from viewer.js)
 * ------------------------------------------------------------------ */

export function puff(engine, pan = 0) {
    const { ctx } = engine;
    const now = ctx.currentTime;
    const src = noiseSource(engine, 0.35, now);
    const bp = filter(ctx, 'bandpass', 1400, 0.9);
    bp.frequency.setValueAtTime(1400, now);
    bp.frequency.exponentialRampToValueAtTime(500, now + 0.3);
    const out = engine.out(pan * 0.8);
    env(out.gain, now, 0.5, 0.02, now + 0.32, 0.001);
    src.connect(bp); bp.connect(out);
}

export function tick(engine, i = 0) {
    const { ctx } = engine;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880 * Math.pow(2, i / 12), now);
    const out = engine.out(0);
    env(out.gain, now, 0.08, 0.01, now + 0.25, 0.001);
    osc.connect(out);
    osc.start(now); osc.stop(now + 0.3);
}

export function pop(engine) {
    const { ctx } = engine;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.12);
    const out = engine.out(0);
    env(out.gain, now, 0.4, 0.004, now + 0.14, 0.001);
    osc.connect(out);
    osc.start(now); osc.stop(now + 0.15);
}

export function chime(engine, freq) {
    const { ctx } = engine;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq || [523.25, 659.25, 783.99, 1046.5][(Math.random() * 4) | 0], now);
    const out = engine.out(0);
    env(out.gain, now, 0.18, 0.015, now + 1.1, 0.001);
    osc.connect(out);
    out.connect(engine.reverb);
    osc.start(now); osc.stop(now + 1.15);
}

export function paper(engine) {
    const { ctx } = engine;
    const now = ctx.currentTime;
    const src = noiseSource(engine, 0.45, now);
    const bp = filter(ctx, 'bandpass', 700, 2.5);
    bp.frequency.setValueAtTime(700, now);
    bp.frequency.exponentialRampToValueAtTime(1600, now + 0.4);
    const out = engine.out(0);
    env(out.gain, now, 0.22, 0.04, now + 0.45, 0.001);
    src.connect(bp); bp.connect(out);
}

export function shutter(engine) {
    const { ctx } = engine;
    const now = ctx.currentTime;
    const src = noiseSource(engine, 0.08, now);
    const out = engine.out(0);
    env(out.gain, now, 0.25, 0.003, now + 0.08, 0.001);
    src.connect(out);
}
