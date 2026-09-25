/**
 * "Happy Birthday to You" (public-domain melody), synthesized: melody, a
 * soft harmony line and bass, scheduled in passes on the audio clock.
 */

export const SONG_LENGTH = 13.5;
/** Start time (s) of each sung line inside one pass, for the karaoke strip. */
export const LYRIC_STARTS = [0, 3.2, 6.4, 9.7];

const NOTE = {
    C2: 65.41, F2: 87.31, G2: 98.0, B3: 246.94, C3: 130.81, F3: 174.61, G3: 196.0, A3: 220.0,
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
    C6: 1046.5, E6: 1318.5, G6: 1568.0
};
export { NOTE };
const MELODY = [
    ['G4', 0.25, 0], ['G4', 0.25, 0.3], ['A4', 0.5, 0.6], ['G4', 0.5, 1.1], ['C5', 0.5, 1.6], ['B4', 1.0, 2.1],
    ['G4', 0.25, 3.2], ['G4', 0.25, 3.5], ['A4', 0.5, 3.8], ['G4', 0.5, 4.3], ['D5', 0.5, 4.8], ['C5', 1.0, 5.3],
    ['G4', 0.25, 6.4], ['G4', 0.25, 6.7], ['G5', 0.5, 7.0], ['E5', 0.5, 7.5], ['C5', 0.5, 8.0], ['B4', 0.5, 8.5], ['A4', 0.5, 9.0],
    ['F5', 0.25, 9.7], ['F5', 0.25, 10.0], ['E5', 0.5, 10.3], ['C5', 0.5, 10.8], ['D5', 0.5, 11.3], ['C5', 1.2, 11.8]
];
const HARMONY = [
    ['C4', 1.0, 0.0], ['E4', 0.5, 0.6], ['E4', 0.5, 1.6], ['G4', 1.0, 2.1],
    ['B3', 1.0, 3.2], ['F4', 0.5, 3.8], ['G4', 0.5, 4.8], ['E4', 1.0, 5.3],
    ['C4', 1.0, 6.4], ['E4', 0.5, 7.0], ['A3', 1.0, 8.0], ['F4', 0.5, 9.0],
    ['A4', 0.5, 9.7], ['G4', 0.5, 10.3], ['F4', 0.5, 11.3], ['E4', 1.2, 11.8]
];
const BASS = [['C2', 2.5, 0], ['G2', 2.5, 3.2], ['C2', 2.5, 6.4], ['F2', 1.2, 9.7], ['G2', 1.0, 10.8], ['C2', 1.5, 11.8]];

/**
 * @param {object} engine  createAudioEngine() result
 * @param {() => string} waveOf  oscillator type for the melody (card's music choice)
 */
export function createSong(engine, waveOf = () => 'triangle') {
    const { ctx } = engine;
    const state = { loopTimer: 0, nextLoopAt: 0, loopsLeft: 0, level: 0.85, startedAt: 0, clapGain: 0 };

    function voice(freq, dur, at, kind, dest = engine.music) {
        if (!freq) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        let peak = 0.16;
        let attack = 0.02;
        let tail = 0.18;
        if (kind === 'melody') {
            osc.type = waveOf();
            if (osc.type === 'sawtooth') {
                const lp = ctx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 1400;
                osc.connect(lp);
                lp.connect(gain);
            } else {
                osc.connect(gain);
            }
        } else if (kind === 'harmony') {
            osc.type = 'sine'; peak = 0.06; attack = 0.05; osc.connect(gain);
        } else if (kind === 'chord') {
            osc.type = 'sine'; peak = 0.07; attack = 0.08; tail = 1.4; osc.connect(gain);
        } else if (kind === 'shimmer') {
            osc.type = 'sine'; peak = 0.05; attack = 0.01; tail = 0.6; osc.connect(gain);
        } else {
            osc.type = 'triangle'; peak = 0.14; attack = 0.06; osc.connect(gain);
        }
        osc.frequency.setValueAtTime(freq, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(peak, at + attack);
        gain.gain.exponentialRampToValueAtTime(0.0008, at + dur + tail);
        gain.connect(dest);
        if (kind === 'melody' || kind === 'chord' || kind === 'shimmer') gain.connect(engine.reverb);
        osc.start(at);
        osc.stop(at + dur + tail + 0.05);
        engine.voices.add(osc);
        osc.onended = () => engine.voices.delete(osc);
    }

    /** Soft hand-claps on beats 1 and 3 of each bar (the room sings along). */
    function clap(at, level) {
        const src = ctx.createBufferSource();
        src.buffer = engine.noise(0.25);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1300;
        bp.Q.value = 0.8;
        const g = ctx.createGain();
        // Three micro-hits = several hands, not one click.
        g.gain.setValueAtTime(0.0001, at);
        [0, 0.012, 0.027].forEach((d, i) => {
            g.gain.linearRampToValueAtTime(level * (1 - i * 0.2), at + d + 0.003);
            g.gain.exponentialRampToValueAtTime(level * 0.08, at + d + 0.011);
        });
        g.gain.exponentialRampToValueAtTime(0.0005, at + 0.14);
        src.connect(bp);
        bp.connect(g);
        g.connect(engine.music);
        g.connect(engine.reverb);
        src.start(at);
        src.stop(at + 0.2);
        engine.voices.add(src);
        src.onended = () => engine.voices.delete(src);
    }

    function schedulePass(start) {
        MELODY.forEach(([n, d, o]) => voice(NOTE[n], d, start + o, 'melody'));
        HARMONY.forEach(([n, d, o]) => voice(NOTE[n], d, start + o, 'harmony'));
        BASS.forEach(([n, d, o]) => voice(NOTE[n], d, start + o, 'bass'));
        if (state.clapGain > 0) {
            // The song is in 3/4 at ~0.53 s per beat; claps on the downbeats.
            for (let o = 0.6; o < 12.4; o += 1.6) clap(start + o, state.clapGain);
        }
    }

    function pump() {
        clearTimeout(state.loopTimer);
        while (state.loopsLeft > 0 && state.nextLoopAt - ctx.currentTime < 2.5) {
            schedulePass(state.nextLoopAt);
            state.nextLoopAt += SONG_LENGTH;
            state.loopsLeft--;
        }
        if (state.loopsLeft > 0) state.loopTimer = setTimeout(pump, 1000);
    }

    function stop(fade = 0.6) {
        clearTimeout(state.loopTimer);
        state.loopsLeft = 0;
        const now = ctx.currentTime;
        const g = engine.music.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0.0001, now + Math.max(0.02, fade));
        const stopAt = now + Math.max(0.03, fade);
        engine.voices.forEach((osc) => { try { osc.stop(stopAt); } catch { /* already stopped */ } });
    }

    return {
        /** Starts looping passes; returns the audio time the first pass starts. */
        start({ level = 0.85, fadeIn = 1.5, passes = Infinity, delay = 0.05, claps = 0 } = {}) {
            stop(0);
            const now = ctx.currentTime;
            const g = engine.music.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(0.0001, now);
            g.linearRampToValueAtTime(level, now + delay + fadeIn);
            state.level = level;
            state.clapGain = claps;
            state.nextLoopAt = now + delay;
            state.startedAt = now + delay;
            state.loopsLeft = passes;
            pump();
            return state.startedAt;
        },
        stop,
        duck(level) {
            const now = ctx.currentTime;
            const g = engine.music.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            g.setTargetAtTime(level, now, 0.35);
        },
        /** Seconds into the current pass (for lyrics), or -1 before it starts. */
        position() {
            const t = ctx.currentTime - state.startedAt;
            return t < 0 ? -1 : t % SONG_LENGTH;
        },
        /** "...happy birthday to you" plus a ringing major chord, instead of cutting the song. */
        finalPhrase() {
            stop(0.02);
            const t0 = ctx.currentTime + 0.06;
            const g = engine.music.gain;
            g.cancelScheduledValues(t0);
            g.setValueAtTime(0.9, t0);
            MELODY.filter(([, , o]) => o >= 9.7).forEach(([n, d, o]) => voice(NOTE[n], d, t0 + o - 9.7, 'melody'));
            BASS.filter(([, , o]) => o >= 9.7).forEach(([n, d, o]) => voice(NOTE[n], d, t0 + o - 9.7, 'bass'));
            const ring = t0 + 2.1;
            ['C4', 'E4', 'G4', 'C5'].forEach((n) => voice(NOTE[n], 2.6, ring, 'chord'));
            ['C6', 'E6', 'G6'].forEach((n, i) => voice(NOTE[n], 0.25, ring + 0.08 * i, 'shimmer'));
        }
    };
}
