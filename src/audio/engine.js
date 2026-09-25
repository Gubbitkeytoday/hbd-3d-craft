/**
 * Receiver audio engine: one Web Audio graph for music, effects and room
 * ambience, with a mastering chain that makes a sudden loud sound impossible.
 *
 *   sources -> bus (music | sfx | ambience) -> master gain -> glue compressor
 *           -> brick-wall limiter (-3 dBFS ceiling) -> destination
 *   reverb send (short room convolver) -> master
 *
 * Everything is scheduled against ctx.currentTime (the audio clock), never
 * setTimeout, so cues stay locked together even when the main thread is busy
 * with the reveal frame. Every transient gets a >= 20 ms fade-in: it keeps
 * the energy but removes the click that makes people jump.
 *
 * Must be created synchronously inside a user gesture (iOS unlock).
 */

/**
 * Recorded clips the receiver knows how to use (public/audio/README.md).
 * public/audio/clips.json maps these names to files; a missing name, file or
 * manifest simply means that cue is synthesized (or, for voices, silent).
 */
export const CLIP_NAMES = Object.freeze(['surprise', 'cheer', 'whisper']);

export function createAudioEngine({ muted = false } = {}) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
        // Safari 16.4+: play through the ring/silent switch like a video would.
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* not supported */ }

    let ctx;
    try {
        ctx = new AC({ latencyHint: 'interactive' });
    } catch (err) {
        console.warn('[audio] Web Audio unavailable:', err);
        return null;
    }
    ctx.resume?.().catch(() => {});
    // A one-sample silent buffer started inside the gesture unlocks WebKit.
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, 22050);
    silent.connect(ctx.destination);
    silent.start(0);

    // Limiter: fast, hard knee, high ratio. Sits after a gentle glue
    // compressor so the mix breathes but nothing crosses the ceiling.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    limiter.connect(ctx.destination);

    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.knee.value = 24;
    glue.ratio.value = 4;
    glue.attack.value = 0.006;
    glue.release.value = 0.25;
    glue.connect(limiter);

    const master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(glue);

    const bus = (level) => {
        const g = ctx.createGain();
        g.gain.value = level;
        g.connect(master);
        return g;
    };
    const music = bus(0);
    const sfx = bus(0.9);
    const ambience = bus(1);

    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 1.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    reverb.connect(wet);
    wet.connect(master);

    const noiseCache = new Map();
    const clips = new Map();

    const engine = {
        ctx, master, music, sfx, ambience, reverb,
        voices: new Set(),
        muted,
        now: () => ctx.currentTime,

        /**
         * Mute toggles ramp. Turning sound ON mid-flow fades in over
         * `rampS` (quiet mode: 1.5 s) so it never starts loud.
         */
        setMuted(value, rampS = 0.08) {
            engine.muted = value;
            const now = ctx.currentTime;
            const g = master.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            if (value) g.setTargetAtTime(0, now, 0.06);
            else g.linearRampToValueAtTime(1, now + Math.max(0.02, rampS));
        },

        resume: () => ctx.resume().catch(() => {}),
        suspend: () => ctx.suspend().catch(() => {}),
        close: () => ctx.close().catch(() => {}),

        /** Cached white noise (generating 1 s of noise per puff was measurable on phones). */
        noise(seconds = 1) {
            const key = Math.ceil(seconds * 4) / 4;
            let buf = noiseCache.get(key);
            if (!buf) {
                buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * key), ctx.sampleRate);
                const d = buf.getChannelData(0);
                for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
                noiseCache.set(key, buf);
            }
            return buf;
        },

        /** A gain node routed to a bus, optionally panned (-1..1). */
        out(pan = 0, dest = sfx) {
            const gain = ctx.createGain();
            if (pan && ctx.createStereoPanner) {
                const p = ctx.createStereoPanner();
                p.pan.value = Math.max(-1, Math.min(1, pan));
                gain.connect(p);
                p.connect(dest);
            } else {
                gain.connect(dest);
            }
            return gain;
        },

        /** Decodes the clips listed in public/audio/clips.json; anything missing falls back. */
        async preloadClips(base = import.meta.env.BASE_URL || '/') {
            let manifest = {};
            try {
                const res = await fetch(`${base}audio/clips.json`, { cache: 'force-cache' });
                // SPA hosts answer unknown paths with index.html: only JSON counts.
                if (res.ok && (res.headers.get('content-type') || '').includes('json')) manifest = await res.json();
            } catch { return; }
            await Promise.all(CLIP_NAMES.map(async (name) => {
                const file = typeof manifest?.[name] === 'string' ? manifest[name] : '';
                // Plain file names only (no paths, no other origins).
                if (!/^[\w.-]+\.(ogg|opus|mp3|m4a|webm|wav)$/i.test(file)) return;
                try {
                    const res = await fetch(`${base}audio/${file}`);
                    if (!res.ok) return;
                    clips.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
                } catch { /* stays synthesized */ }
            }));
        },

        hasClip: (name) => clips.has(name),

        /** Plays a decoded clip at an audio-clock time, with a soft attack. */
        playClip(name, { at = ctx.currentTime, gain = 1, pan = 0, fadeIn = 0.025, dest = sfx } = {}) {
            const buf = clips.get(name);
            if (!buf) return false;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const out = engine.out(pan, dest);
            out.gain.setValueAtTime(0.0001, at);
            out.gain.linearRampToValueAtTime(gain, at + fadeIn);
            src.connect(out);
            src.start(at);
            return true;
        }
    };
    return engine;
}

function makeImpulse(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
}
