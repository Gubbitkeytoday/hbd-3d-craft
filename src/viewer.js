/**
 * Receiver experience (route #/view/...).
 *
 * Beats: gate -> intro (establishing move, name, candles ignite) -> wish ->
 * blow (tap flames; mic is opt-in) -> climax (silence, puff, final phrase,
 * confetti) -> message card with end actions (thank you, replay, photo,
 * make your own).
 *
 * The whole 3D scene is built and its shaders compiled behind the gate while
 * the recipient reads it, so tapping "Open" only reveals an already-warm
 * scene. Everything that moves is time-based (per second, not per frame).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import anime from 'animejs';
import confetti from 'canvas-confetti';
import { applyDOMTranslations, getCurrentLang, saveLanguageSetting, translations } from './i18n.js';
import {
    applyCinematicRenderer,
    attachStudioEnvironmentAsync,
    setupStudioLighting,
    tuneMaterialsForEnvironment,
    createBloomComposer,
    isMobileViewport,
    tintRimLight,
    precompileScene,
    createQualityGovernor,
    QUALITY_LEVELS
} from './render-quality.js';
import { buildCakeModel, getCakeLayout, disposeCakeGroup } from './cake-models.js';
import { buildCandles } from './cake/candles.js';
import { applyBackdrop, backdropCss, createContactShadow, fitContactShadow, paintBackdrop, resolveBackdrop } from './backdrops.js';
import { loadCardFont } from './fonts.js';
import { createAudioEngine } from './audio/engine.js';
import { createSong, SONG_LENGTH, LYRIC_STARTS } from './audio/song.js';
import * as cues from './audio/cues.js';

// The party room (src/room/index.js, lazy chunk). Optional at build time:
// without it, or if it fails to load, the card plays on the classic night stage.
const ROOM_MODULES = import.meta.glob('./room/index.js');
const loadRoomModule = ROOM_MODULES['./room/index.js'] || null;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// One warm light for all candles; it dims to 0 instead of being toggled,
// because changing the light count recompiles every material.
const CANDLE_LIGHT_PER_FLAME = 1.2;
const WISH_AUTO_ADVANCE_MS = 5000;
const CLIMAX_SILENCE_MS = 380;
const MIC_SUSTAIN_S = 0.12;   // a puff must last this long before it counts
const MIC_CADENCE_S = 0.18;   // then one candle goes out per this interval

// Party storyboard (ms). T0 = the switch tap; see research-surprise.md.
const DARK_HINT_MS = 1100;     // the hint must be up within 1.2 s
const DARK_ESCALATE_MS = 5000;
const DARK_AUTO_FLIP_MS = 9000;
const LIGHTS_ON_MS = 120;      // held beat of darkness after the click
const SHOUT_MS = 150;
const HEAD_TURN_DELAY_MS = 60; // after the cut: the head turns toward the shout
const HEAD_TURN_MS = 650;
const TOUR_MS = 1900;          // the reveal framing holds, then one glide to the table
const TOUR_GLIDE_MS = 1800;
const CAKE_IN_MS = 4400;
const SONG_DRIFT_DEG = 8;      // the camera never stands still through the song
const ROOM_TIMEOUT_MS = 20000; // then the card falls back to the classic stage

// Fallback reveal framing (room.shots.reveal wins when the room provides
// one): from the doorway, aim between the foil letters (x -0.3, y ~1.85,
// z -2.36 m) and the cake (y ~0.9, z -0.8 m), so letters, name, table and
// cake all fit (letters ~10 deg above centre, cake ~8 deg below; inside a
// 62 deg portrait lens). Metres x ROOM_SCALE (14).
const REVEAL_TARGET_WORLD = [-0.3 * 14, 1.42 * 14, -1.66 * 14];

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const IS_LINE_APP = /\bLine\//i.test(ua);
const IS_IOS = /iPad|iPhone|iPod/.test(ua) ||
    (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeConfig = null;
// idle | gate | intro | wish | blow | climax | message; the party room adds
// dark (switch) | reveal (lights on, tour) | song before wish.
let phase = 'idle';
let reduceMotion = false;
let domBound = false;

let prepToken = 0;
let sceneReady = null;         // Promise<boolean>
let isReady = false;
let opening = false;

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let bloomComposer = null;
let governor = null;
let envMap = null;
let sceneLights = null;
let lightBase = null;
let cakeGroup = null;
let candleLight = null;
let candleLightLevel = 0;
let flameMaterial = null;
let candles = [];              // { group, flame, hit, isLit }
let hitMeshes = [];
let cakeBounds = { radius: 2.8, floorY: -1.15, topY: 1.4 };
let ownedRoots = [];           // non-kit objects this module disposes itself
let rafId = 0;
let lastFrameTime = 0;
let elapsed = 0;
let decorEnabled = true;
let compileInFlight = null;   // settles once every pending compileAsync has finished

// Values tweened by anime.js and applied in the render loop.
// Separate objects because anime.remove() works per target, not per property.
const dim = { v: 0 };
const glow = { v: 0 };
const spin = { v: 0.6 };
const shift = { x: 0, y: 0 };
let appliedShift = null;

const hero = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
const timers = new Set();
const pointerDown = { x: 0, y: 0, t: 0, id: -1 };
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();

// Particle pools, decor, audio and mic are grouped for easy teardown.
let embers = null;
let smoke = null;
let sparkles = null;
let emberBudget = 0;
const pointScale = { value: 400 };
let stars = null;
let floorGlow = null;
let backdrop = resolveBackdrop('night');
let balloons = null;
let gifts = null;

let audio = null;              // createAudioEngine() result
let song = null;
let roomTone = null;
let partyLoop = null;
let muted = false;
let quietMode = false;

// Party room state. Light values are tweened here and pushed to the room as
// uniforms once per frame (never a light count or material change).
let partyMode = false;
let room = null;
let roomAbort = null;
let roomShots = null;          // shots fitted to the current viewport
const lens = { v: 45 };        // camera fov, tweened between shots (projection only)
const roomLight = { v: 0 };    // 0 dark .. 1 party lights
const roomDim = { v: 0 };      // 0 lit .. 1 "cake is coming" dim
const exposureKick = { v: 1 }; // auto-exposure overshoot after the switch
let appliedRoom = null;
let cakeMaterials = [];        // { mat, env } for dimming the environment on the cake
let darkLowerThird = false;
let songStartedAt = 0;         // performance.now() fallback clock for lyrics
let lyricIndex = -1;
const mic = { state: 'off', stream: null, analyser: null, data: null, floor: 0, samples: [], calibrating: false, above: 0, cadence: 0 };

let focusBeforeCard = null;
let letterTimer = 0;
let letterSegments = null;
let letterIndex = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function dict() {
    return translations[getCurrentLang()] || translations.en;
}

function t(key, vars = {}) {
    const raw = dict()[key] ?? translations.en[key] ?? '';
    return raw.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

function recipientName() {
    return (activeConfig?.recipientName || '').trim() || t('rcvNameFallback');
}

function senderName() {
    return (activeConfig?.sender || '').trim();
}

/** Fills `el` from a translation template, wrapping each {placeholder} in a highlight span. */
function fillTemplate(el, key, vars) {
    if (!el) return;
    fillRaw(el, dict()[key] ?? translations.en[key] ?? '', vars);
}

function fillRaw(el, raw, vars) {
    el.textContent = '';
    raw.split(/(\{\w+\})/).forEach((part) => {
        const m = part.match(/^\{(\w+)\}$/);
        if (m) {
            const span = document.createElement('span');
            span.className = `rcv-hl rcv-hl-${m[1]}`;
            span.textContent = vars[m[1]] ?? '';
            el.append(span);
        } else if (part) {
            el.append(part);
        }
    });
}

function firstGrapheme(text) {
    if (!text) return '';
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]().next();
        return seg.value?.segment || '';
    }
    return Array.from(text)[0] || '';
}

function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
}

function clearTimers() {
    timers.forEach((id) => clearTimeout(id));
    timers.clear();
}

const yieldToMain = () => new Promise((resolve) => {
    if (globalThis.scheduler?.yield) globalThis.scheduler.yield().then(resolve);
    else setTimeout(resolve, 0);
});

function ms(value) {
    return reduceMotion ? 0 : value;
}

function setOpen(el, open) {
    if (!el) return;
    el.classList.toggle('is-open', open);
    el.inert = !open;
    el.setAttribute('aria-hidden', open ? 'false' : 'true');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function initViewer(config) {
    activeConfig = config || {};
    partyMode = activeConfig.backdrop === 'party';
    // The party room carries its own light; the cake rig and receiver chrome
    // start from the night set (dark frosted pills read over both states).
    backdrop = resolveBackdrop(partyMode ? 'night' : activeConfig.backdrop);
    applyBackdropDom();
    reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    phase = 'gate';
    isReady = false;
    opening = false;
    muted = false;
    quietMode = false;
    decorEnabled = true;

    // The card's typeface downloads while the gate is read (on-demand font).
    loadCardFont(activeConfig.font || 'outfit');

    bindDomOnce();
    resetDom();
    translateReceiver();

    const token = ++prepToken;
    sceneReady = prepareScene(token).catch((err) => {
        console.error('[viewer] 3D scene failed, showing the card without it:', err);
        return false;
    });
}

export function destroyViewer() {
    prepToken++;
    phase = 'idle';
    clearTimers();
    anime.remove([dim, glow, spin, shift, roomLight, roomDim, exposureKick, lens]);
    if (camera) anime.remove(camera.position);
    if (controls) anime.remove(controls.target);
    candles.forEach((c) => { anime.remove(c.flame.scale); anime.remove(c.flame.rotation); });

    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);

    stopMic();
    closeLetter(false);
    if (letterTimer) clearInterval(letterTimer);
    letterTimer = 0;
    if (audio) {
        song?.stop(0.05);
        partyLoop?.stop(0.05);
        roomTone?.stop(0.05);
        audio.close();
        audio = song = roomTone = partyLoop = null;
    }
    roomAbort?.abort();
    roomAbort = null;
    hideDarkUi();

    disposeScene();
    const container = $('greeting-canvas-container');
    if (container) {
        container.innerHTML = '';
        container.classList.remove('is-live');
    }
    setOpen($('rcv-card'), false);
    const hud = $('rcv-hud');
    if (hud) { hud.inert = true; hud.classList.remove('is-live'); }
}

/**
 * Receiver chrome follows the backdrop: data-backdrop switches the light
 * token set in receiver.css, and the gradient/ink come from backdrops.js so
 * the page, the gate and the 3D frame are one surface.
 */
function applyBackdropDom() {
    const rv = $('receiver-view');
    if (!rv) return;
    rv.dataset.backdrop = partyMode ? 'party' : backdrop.name;
    const set = (k, v) => (v ? rv.style.setProperty(k, v) : rv.style.removeProperty(k));
    set('--rcv-backdrop', backdropCss(backdrop.name));
    set('--rcv-bd-ink', backdrop.ink);
    set('--rcv-bd-soft', backdrop.soft);
    set('--rcv-bd-accent', backdrop.accent);
    set('--rcv-bd-mid', backdrop.mid);
}

function disposeScene() {
    // Capture everything now; module state is reset immediately so a new
    // mount can start, while the GPU teardown may have to wait (below).
    const r = renderer;
    const cake = cakeGroup;
    const roots = ownedRoots;
    const bloom = bloomComposer;
    const env = envMap;
    const ctl = controls;
    const rm = room;
    if (r) {
        r.domElement.removeEventListener('pointerdown', onPointerDown);
        r.domElement.removeEventListener('pointerup', onPointerUp);
    }
    ctl?.dispose();
    renderer = scene = camera = controls = bloomComposer = governor = envMap = null;
    sceneLights = lightBase = cakeGroup = candleLight = flameMaterial = null;
    ownedRoots = [];
    candles = [];
    hitMeshes = [];
    embers = smoke = sparkles = stars = floorGlow = balloons = gifts = null;
    appliedShift = null;
    room = roomShots = appliedRoom = null;
    cakeMaterials = [];

    const teardown = () => {
        if (cake) {
            cake.parent?.remove(cake);
            disposeCakeGroup(cake, { defer: false });
        }
        try { rm?.dispose(); } catch (err) { console.warn('[viewer] room dispose failed', err); }
        roots.forEach((root) => {
            root.parent?.remove(root);
            disposeOwned(root);
        });
        if (bloom) {
            bloom.bloom?.dispose?.();
            bloom.composer.passes.forEach((p) => p.dispose?.());
            bloom.composer.dispose?.();
        }
        env?.dispose();
        if (r) {
            r.dispose();
            // Frees the context now instead of waiting for GC; Chrome caps live
            // contexts at 16 and iOS evicts pages that hold several.
            r.forceContextLoss();
        }
    };
    // three's compileAsync keeps polling program status; disposing the
    // renderer under it throws. Leaving mid-compile waits for it to settle.
    if (compileInFlight) compileInFlight.finally(() => setTimeout(teardown, 30));
    else teardown();
}

function disposeOwned(root) {
    root.traverse((obj) => {
        obj.geometry?.dispose();
        if (obj.isInstancedMesh) obj.dispose();
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        list.forEach((m) => {
            if (!m) return;
            Object.values(m).forEach((v) => { if (v?.isTexture) v.dispose(); });
            m.dispose();
        });
    });
}

// ---------------------------------------------------------------------------
// DOM: static bindings (the receiver markup survives route changes)
// ---------------------------------------------------------------------------

function bindDomOnce() {
    if (domBound) return;
    domBound = true;

    $('lang-switcher-receiver')?.addEventListener('change', (e) => {
        saveLanguageSetting(e.target.value);
        applyDOMTranslations();
        translateReceiver();
    });
    $('btn-open-envelope')?.addEventListener('click', () => onOpenClick(false));
    $('btn-open-quiet')?.addEventListener('click', () => onOpenClick(true));
    $('rcv-switch')?.addEventListener('click', () => flipSwitch(false));
    $('btn-dark-skip')?.addEventListener('click', () => flipSwitch(false));
    $('btn-skip-song')?.addEventListener('click', endSong);
    $('btn-hud-audio')?.addEventListener('click', toggleMute);
    $('btn-hud-card')?.addEventListener('click', () => openCard());
    $('btn-hud-reset')?.addEventListener('click', replay);
    $('btn-wish-ready')?.addEventListener('click', startBlow);
    $('btn-hud-mic')?.addEventListener('click', onMicButton);
    $('btn-mic-use')?.addEventListener('click', requestMic);
    $('btn-mic-tap')?.addEventListener('click', () => closeMicSheet(true));
    $('btn-close-greeting-card')?.addEventListener('click', () => closeCard());
    $('btn-read-letter')?.addEventListener('click', showLetter);
    $('btn-thanks')?.addEventListener('click', sendThanks);
    $('btn-replay')?.addEventListener('click', replay);
    $('btn-save-photo')?.addEventListener('click', savePhoto);
    $('btn-close-letter')?.addEventListener('click', () => closeLetter(true));
    $('btn-photo-close')?.addEventListener('click', closePhotoPreview);

    const env = $('letter-envelope-container');
    env?.addEventListener('click', () => {
        if (!env.classList.contains('open')) openEnvelope();
        else finishLetterTyping();
    });
    env?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!env.classList.contains('open')) openEnvelope();
            else finishLetterTyping();
        }
    });

    // Capture phase so this runs before the app-wide Escape handler and the
    // topmost layer closes exactly once.
    window.addEventListener('keydown', onKeyDown, true);
}

function onKeyDown(e) {
    if (!document.getElementById('receiver-view')?.classList.contains('active-view')) return;
    if (e.key === 'Escape') {
        let handled = true;
        if (!$('rcv-photo-preview')?.hidden) closePhotoPreview();
        else if ($('letter-popup-overlay')?.classList.contains('active')) closeLetter(true);
        else if (!$('rcv-mic-sheet')?.hidden) closeMicSheet(true);
        else if ($('rcv-card')?.classList.contains('is-open')) closeCard();
        else handled = false;
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
        return;
    }
    // Keyboard can blow candles too (Space / Enter on the scene, not on a control).
    const tag = e.target?.tagName;
    const onControl = tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ||
        e.target?.getAttribute?.('role') === 'button';
    if (!onControl && (e.key === ' ' || e.key === 'Enter')) {
        if (phase === 'dark') { e.preventDefault(); flipSwitch(false); }
        else if (phase === 'wish') { e.preventDefault(); startBlow(); }
        else if (phase === 'blow') { e.preventDefault(); blowNextCandle(); }
    }
}

function resetDom() {
    const gate = $('envelope-gate');
    if (gate) {
        gate.classList.add('active-gate');
        gate.classList.remove('is-leaving');
        gate.inert = false;
    }
    const btn = $('btn-open-envelope');
    if (btn) {
        btn.dataset.state = 'loading';
        btn.removeAttribute('aria-busy');
    }
    setProgress(0);
    const hud = $('rcv-hud');
    if (hud) { hud.inert = true; hud.classList.remove('is-live'); }
    $('rcv-title')?.classList.remove('is-hero', 'is-docked');
    ['rcv-wish', 'rcv-blow', 'rcv-mic-sheet', 'btn-hud-card', 'btn-hud-reset', 'btn-wish-ready',
        'rcv-lyrics', 'btn-skip-song', 'rcv-cake-coming'].forEach((id) => {
        const el = $(id);
        if (el) el.hidden = true;
    });
    setOpen($('rcv-card'), false);
    const lang = $('lang-switcher-receiver');
    if (lang) lang.value = getCurrentLang();
    syncAudioButton();
    mic.state = 'off';
    const rv = $('receiver-view');
    rv?.classList.toggle('rcv-reduce', reduceMotion);
    rv?.classList.remove('is-dim', 'is-dark', 'is-quiet');
    hideDarkUi();
    // Party gate: the dark room poster behind the envelope (when ROOM ships one).
    if (gate) {
        gate.style.removeProperty('--rcv-gate-poster');
        if (partyMode) loadPoster(gate);
    }
}

async function loadPoster(gate) {
    try {
        if (!loadRoomModule) return;
        const mod = await loadRoomModule();
        const url = mod.getPartyPoster?.('dark');
        if (url && phase === 'gate') gate.style.setProperty('--rcv-gate-poster', `url("${url}")`);
    } catch { /* the CSS gradient stays */ }
}

/** Every visible receiver string, re-run on language change. */
function translateReceiver() {
    const name = recipientName();
    const sender = senderName();
    const lang = $('lang-switcher-receiver');
    if (lang) {
        lang.value = getCurrentLang();
        lang.setAttribute('aria-label', t('rcvLang'));
    }

    // Gate
    const eyebrow = $('rcv-gate-eyebrow');
    if (eyebrow) eyebrow.textContent = t('rcvEyebrow');
    fillTemplate($('rcv-gate-headline'), sender ? 'rcvGateHeadline' : 'rcvGateHeadlineAnon', { name, sender });
    const seal = $('rcv-seal-initial');
    if (seal) seal.textContent = firstGrapheme(sender) || '🎂';
    const sound = $('rcv-gate-sound');
    if (sound) sound.textContent = t('rcvGateSound');
    const quiet = $('btn-open-quiet');
    if (quiet) quiet.textContent = t('rcvOpenQuiet');
    updateOpenLabel();

    // Party: dark room, switch, lyrics
    $('rcv-switch')?.setAttribute('aria-label', t('rcvSwitchLabel'));
    $('btn-dark-skip') && ($('btn-dark-skip').textContent = t('rcvSkip'));
    $('btn-skip-song') && ($('btn-skip-song').textContent = t('rcvSkipSong'));
    $('rcv-surprise') && ($('rcv-surprise').textContent = t('rcvSurprise'));
    $('rcv-cake-coming') && ($('rcv-cake-coming').textContent = t('rcvCakeComing'));
    if (phase === 'dark') setDarkHint($('rcv-dark-hint')?.dataset.key || 'rcvDarkHint');
    lyricIndex = -1;

    // HUD
    fillTemplate($('rcv-title'), 'rcvHappyBirthday', { name });
    setHudLabel('btn-hud-audio', 'rcv-audio-label', t('rcvMusic'));
    setHudLabel('btn-hud-card', 'rcv-card-label', t('rcvShowCard'));
    setHudLabel('btn-hud-reset', 'rcv-reset-label', t('rcvReplay'));
    $('rcv-replay-label') && ($('rcv-replay-label').textContent = partyMode ? t('rcvReplaySurprise') : t('rcvReplay'));
    $('rcv-wish-text') && ($('rcv-wish-text').textContent = t('rcvWish'));
    $('btn-wish-ready') && ($('btn-wish-ready').textContent = t('rcvWishReady'));
    $('rcv-mic-explain') && ($('rcv-mic-explain').textContent = t('rcvMicExplain'));
    $('btn-mic-use') && ($('btn-mic-use').textContent = t('rcvMicUse'));
    $('btn-mic-tap') && ($('btn-mic-tap').textContent = t('rcvMicJustTap'));
    $('rcv-mic-external-label') && ($('rcv-mic-external-label').textContent = t('rcvMicOpenBrowser'));
    updateBlowUi();

    // Card + end actions
    $('rcv-card-close-label') && ($('rcv-card-close-label').textContent = t('rcvClose'));
    $('rcv-letter-close-label') && ($('rcv-letter-close-label').textContent = t('rcvClose'));
    $('rcv-save-label') && ($('rcv-save-label').textContent = t('rcvSavePhoto'));
    $('rcv-make-label') && ($('rcv-make-label').textContent = t('rcvMakeOwn'));
    $('btn-photo-close') && ($('btn-photo-close').textContent = t('rcvClose'));
    $('rcv-photo-hint') && ($('rcv-photo-hint').textContent = t('rcvSaveHint'));
    $('letter-envelope-container')?.setAttribute('aria-label', t('rcvLetterSeal'));
    fillCard();
}

function setHudLabel(btnId, labelId, text) {
    const label = $(labelId);
    if (label) label.textContent = text;
    $(btnId)?.setAttribute('title', text);
}

function updateOpenLabel() {
    const btn = $('btn-open-envelope');
    const label = $('rcv-open-label');
    if (!btn || !label) return;
    label.textContent = btn.dataset.state === 'waiting' ? t('rcvPreparing') : t(partyMode ? 'rcvOpenSound' : 'rcvOpen');
}

function setProgress(p) {
    const bar = $('rcv-open-bar');
    if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`;
}

// ---------------------------------------------------------------------------
// Scene preparation (behind the gate)
// ---------------------------------------------------------------------------

// Main-thread budget per slice while the gate is on screen. Each slice stays
// well under the 50 ms long-task line on desktop so the gate (and a Lighthouse
// run with 4x CPU throttling) stays responsive.
const SLICE_MS = 12;

async function prepareScene(token) {
    const alive = () => token === prepToken;
    const step = async (p, label) => {
        if (label) performance.mark(`rcv:${label}`);
        setProgress(p);
        await yieldToMain();
        if (!alive()) throw new PrepCancelled();
    };

    try {
        // Let the gate paint first: two frames, then start the heavy work.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await step(0.03, 'start');
        // Canvas-baked text (topper) must not bake a fallback font.
        await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1200))]);
        await step(0.06, 'fonts');

        const container = $('greeting-canvas-container');
        if (!container) return false;
        container.innerHTML = '';
        container.classList.remove('is-live');

        const width = window.innerWidth;
        const height = window.innerHeight;
        const mobile = isMobileViewport();

        // alpha: light backdrops are CSS behind a transparent frame (backdrops.js).
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
        // In production three then skips the synchronous per-program status
        // query, which is exactly the call that used to block for seconds.
        renderer.debug.checkShaderErrors = import.meta.env.DEV;
        renderer.setSize(width, height);
        applyCinematicRenderer(renderer, { exposure: 1.05, maxPixelRatio: mobile ? 1.5 : 2 });
        container.appendChild(renderer.domElement);
        renderer.domElement.setAttribute('aria-hidden', 'true');
        scene = new THREE.Scene();
        // The party room is a closed interior at x14 scale: no fog, far plane out past its walls.
        scene.fog = partyMode ? null : new THREE.FogExp2(0x06020f, 0.015);
        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, partyMode ? 800 : 100);
        await step(0.12, 'renderer');

        // Async variant compiles the PMREM shaders off the main thread (was a
        // ~160 ms block while the gate is on screen).
        envMap = await attachStudioEnvironmentAsync(renderer, scene);
        await step(0.2, 'environment');

        const theme = getThemeRGBColors(activeConfig.theme);
        sceneLights = setupStudioLighting(scene, { rimColor: theme.cream, mobile });
        tintRimLight(sceneLights.rim, theme.cream);
        // Softer rim: at full strength it bloomed into a hot flare on the plate.
        sceneLights.rim.intensity *= 0.7;
        sceneLights.rim.userData.baseIntensity = sceneLights.rim.intensity;
        cakeGroup = new THREE.Group();
        buildCake(mobile);
        scene.add(cakeGroup);
        await step(0.35, 'cake');

        setupCandles();
        measureCake();
        tuneMaterialsForEnvironment(cakeGroup, backdrop.light ? 0.85 : 0.6);
        await step(0.4, 'candles');
        if (partyMode) {
            try {
                await buildRoom(alive, mobile, (p) => setProgress(0.2 + 0.26 * p));
                // The dark room's ambience, synthesized now instead of in the tap.
                await cues.prepareRoomTone(yieldToMain);
            } catch (err) {
                if (err instanceof PrepCancelled || !alive()) throw new PrepCancelled();
                console.warn('[viewer] party room unavailable, using the classic stage:', err);
                fallBackToClassic();
            }
        }
        collectCakeMaterials();
        setupParticles();
        let shadow = null;
        if (!partyMode) {
            setupStars();
            setupFloorGlow(theme);
            shadow = createContactShadow(cakeBounds.radius);
            fitContactShadow(shadow, cakeBounds.radius, cakeBounds.floorY);
            scene.add(shadow);
            ownedRoots.push(shadow);
            await step(0.44, 'set');
            setupDecor(theme);
        }
        await step(0.48, 'decor');

        controls = new OrbitControls(camera, renderer.domElement);
        controls.addEventListener('start', stopDriftOnDrag);
        controls.enableDamping = true;
        controls.dampingFactor = 0.06;
        controls.enablePan = false;
        controls.maxPolarAngle = Math.PI / 2 - 0.05;
        controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
        computeHero();
        // The party opens in the doorway; the warm-up frame below renders that view.
        const startShot = partyMode && roomShots ? roomShots.entry : hero;
        camera.position.copy(startShot.pos);
        controls.target.copy(startShot.target);
        camera.lookAt(startShot.target);
        controls.update();
        bloomComposer = createBloomComposer(renderer, scene, camera, { mobile });
        applyBackdrop(scene, renderer, bloomComposer, sceneLights, backdrop.name, {
            contactShadow: shadow,
            // Stars and the theme-coloured light pool only read on black; on
            // paper the contact shadow grounds the cake instead.
            nightOnly: [stars, floorGlow]
        });
        // The beat animation (applyLights) scales from the backdrop's rig.
        lightBase = {
            ambient: sceneLights.ambient.intensity,
            key: sceneLights.key.intensity,
            fill: sceneLights.fill.intensity,
            rim: sceneLights.rim.intensity,
            exposure: renderer.toneMappingExposure,
            bloom: bloomComposer?.bloom?.strength ?? 0,
            // The wish dims the room. A pale backdrop cannot dim with it (it is
            // CSS), so the cake dims less there and a CSS vignette does the rest.
            dimK: backdrop.light ? 0.28 : 0.55
        };
        updatePointScale();
        await step(0.52, 'composer');

        // Parallel shader compile (KHR_parallel_shader_compile), fed in
        // small slices so the main thread stays free.
        await precompileForComposer(alive, (p) => setProgress(0.52 + p * 0.33));
        await step(0.86, 'compiled');

        // Upload textures one slice at a time instead of all on the first frame.
        await uploadTextures(alive);
        await step(0.94, 'uploaded');

        // One hidden frame builds the shadow map and the last few programs
        // now rather than on the first visible frame.
        renderFrame();
        // Party: the doorway view only sees part of the room, and three
        // binds a program (uniform lookup, link check) on its first draw, so
        // the reveal and the tour would pay for it. One more hidden frame
        // with culling off draws everything once, now.
        if (room) {
            await step(0.96, 'warm');
            warmEverything();
        }
        await step(0.98, 'warm');

        governor = createQualityGovernor({
            renderer,
            bloom: bloomComposer,
            onLevelChange: (level) => {
                decorEnabled = level < QUALITY_LEVELS.DECOR_BUDGET;
                updatePointScale();
                if (room) {
                    const base = roomQuality(isMobileViewport());
                    room.setQuality?.(level >= QUALITY_LEVELS.SHADOWS_THROTTLED ? 0 : level >= QUALITY_LEVELS.DPR_MIN ? Math.min(base, 1) : base);
                }
            }
        });

        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', onVisibility);

        setProgress(1);
        performance.mark('rcv:ready');
        isReady = true;
        const btn = $('btn-open-envelope');
        if (btn && btn.dataset.state === 'loading') btn.dataset.state = 'ready';
        return true;
    } catch (err) {
        if (err instanceof PrepCancelled) return false;
        throw err;
    }
}

class PrepCancelled extends Error {}

function warmEverything() {
    const culled = [];
    scene.traverse((obj) => {
        if ((obj.isMesh || obj.isPoints || obj.isLine) && obj.frustumCulled) {
            obj.frustumCulled = false;
            culled.push(obj);
        }
    });
    try {
        renderFrame();
    } finally {
        culled.forEach((obj) => { obj.frustumCulled = true; });
    }
}

/** 0 = low-end phone, 1 = phone, 2 = desktop (ROOM contract). */
function roomQuality(mobile) {
    if (!mobile) return 2;
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;
    return cores <= 4 || memory <= 3 ? 0 : 1;
}

/**
 * Builds the party room behind the gate (the room streams its assets and
 * yields between steps), then stands the cake on its table. The room starts
 * in its dark state, which is also the state precompiled below; the lit
 * state is uniforms only.
 */
async function buildRoom(alive, mobile, onProgress) {
    if (!loadRoomModule) throw new Error('src/room/index.js is not part of this build');
    const mod = await loadRoomModule();
    if (!alive()) throw new PrepCancelled();
    roomAbort = new AbortController();
    const building = mod.createPartyRoom({
        renderer, scene, camera,
        quality: roomQuality(mobile),
        config: activeConfig,
        onProgress,
        signal: roomAbort.signal
    });
    // A room that never settles (a stalled download, a decoder worker that
    // died) must not keep the gate on "preparing" forever: after the limit
    // the card plays on the classic stage and a late room is thrown away.
    let timer = 0;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`party room not ready after ${ROOM_TIMEOUT_MS} ms`)), ROOM_TIMEOUT_MS);
    });
    let built;
    try {
        built = await Promise.race([building, limit]);
    } catch (err) {
        roomAbort.abort();
        building.then((late) => late?.dispose?.(), () => {});
        throw err;
    } finally {
        clearTimeout(timer);
    }
    if (!alive()) {
        built?.dispose?.();
        throw new PrepCancelled();
    }
    room = built;
    scene.remove(cakeGroup);
    if (room.seatCake) {
        room.seatCake(cakeGroup);
    } else {
        // Contract minimum: the anchor is the table top; the plate is at cakeBounds.floorY.
        room.cakeAnchor.add(cakeGroup);
        cakeGroup.position.y = -cakeBounds.floorY;
    }
    room.group.updateMatrixWorld(true);
    // Environment reflections on the cake follow the room light (the room
    // tracks them when it can; otherwise applyLights does).
    if (room.trackEnvMaterials) room.trackEnvMaterials(cakeGroup, backdrop.light ? 0.85 : 0.6);
    room.setCandles?.(0);
    // The key light (and its shadow frustum, sized for the cake) follows the
    // cake onto the table; fill and rim are directional, so only their
    // direction matters.
    const key = sceneLights.key;
    const at = room.cakeAnchor.getWorldPosition(new THREE.Vector3());
    key.target = room.cakeAnchor;
    key.position.copy(at).add(new THREE.Vector3(5, 10, 7));
    roomLight.v = 0;
    roomDim.v = 0;
    exposureKick.v = 1;
    room.setLights(0);
    room.setDim(0);
    appliedRoom = '0|0';
}

/** The room failed: the card still plays, on the classic night stage. */
function fallBackToClassic() {
    try { room?.dispose(); } catch { /* ignore */ }
    room = null;
    roomShots = null;
    partyMode = false;
    if (cakeGroup && cakeGroup.parent !== scene) {
        cakeGroup.parent?.remove(cakeGroup);
        cakeGroup.position.set(0, 0, 0);
        scene.add(cakeGroup);
    }
    if (candleLight && !candleLight.parent) cakeGroup.add(candleLight);
    sceneLights.key.target = new THREE.Object3D();
    sceneLights.key.position.set(5, 10, 7);
    scene.fog = new THREE.FogExp2(0x06020f, 0.015);
    camera.far = 100;
    camera.fov = 45;
    camera.updateProjectionMatrix();
    applyBackdropDom();
    translateReceiver();
}

/** Cake materials whose environment reflections follow the room light. */
function collectCakeMaterials() {
    cakeMaterials = [];
    if (!partyMode || !cakeGroup || room?.trackEnvMaterials) return;
    const seen = new Set();
    cakeGroup.traverse((obj) => {
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        list.forEach((m) => {
            if (!m || seen.has(m) || !('envMapIntensity' in m) || m.isShaderMaterial) return;
            seen.add(m);
            cakeMaterials.push({ mat: m, env: m.envMapIntensity });
        });
    });
}

/**
 * Program keys depend on the render target: the composer draws the scene
 * into a linear, un-tonemapped target, while a plain compile assumes the
 * sRGB canvas. Compiling against the wrong one made the first real frame
 * relink 26 programs synchronously (3.7 s). So the scene and the
 * intermediate passes compile with the composer's target bound, and only
 * the final output pass against the canvas. compile() builds the keys
 * synchronously, so switching the target around each call is enough.
 *
 * Objects are compiled one by one in time slices; programs are shared, so
 * only the first object using a material pays, and the driver links them in
 * parallel while we wait.
 */
async function precompileForComposer(alive, onProgress) {
    const composer = bloomComposer?.composer;
    const quad = new THREE.PlaneGeometry(2, 2);
    const offscreenPasses = new THREE.Scene();
    const onscreenPasses = new THREE.Scene();
    (composer?.passes || []).forEach((pass, i) => {
        const target = i === composer.passes.length - 1 ? onscreenPasses : offscreenPasses;
        Object.values(pass).forEach((value) => {
            const list = Array.isArray(value) ? value : [value];
            list.forEach((m) => { if (m?.isMaterial) target.add(new THREE.Mesh(quad, m)); });
        });
    });

    const units = [];
    scene.traverse((obj) => { if (obj.material) units.push({ root: obj, target: scene, rt: composer?.readBuffer || null }); });
    units.push({ root: offscreenPasses, target: offscreenPasses, rt: composer?.readBuffer || null });
    units.push({ root: onscreenPasses, target: onscreenPasses, rt: null });

    const seen = new Set();
    const jobs = [];
    const previous = renderer.getRenderTarget();
    let sliceStart = performance.now();
    for (let i = 0; i < units.length; i++) {
        const { root, target, rt } = units[i];
        const mats = Array.isArray(root.material) ? root.material : [root.material];
        // Skip objects whose materials were already handed to the compiler.
        if (root.material && mats.every((m) => seen.has(m))) continue;
        mats.forEach((m) => m && seen.add(m));
        renderer.setRenderTarget(rt);
        try {
            jobs.push(precompileScene(renderer, root, camera, { targetScene: target }));
        } finally {
            renderer.setRenderTarget(previous);
        }
        compileInFlight = Promise.allSettled(jobs);
        if (performance.now() - sliceStart > SLICE_MS) {
            onProgress?.((i / units.length) * 0.6);
            await yieldToMain();
            if (!alive()) throw new PrepCancelled();
            sliceStart = performance.now();
        }
    }
    // Wait for the parallel links without blocking; progress creeps meanwhile.
    let done = 0;
    await Promise.all(jobs.map((j) => j.then(() => onProgress?.(0.6 + (++done / jobs.length) * 0.4))));
    compileInFlight = null;
    quad.dispose();
}

async function uploadTextures(alive) {
    const textures = new Set();
    scene.traverse((obj) => {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
            if (!m) return;
            Object.values(m).forEach((v) => { if (v?.isTexture && !v.isRenderTargetTexture) textures.add(v); });
        });
    });
    let sliceStart = performance.now();
    for (const tex of textures) {
        renderer.initTexture(tex);
        if (performance.now() - sliceStart > SLICE_MS) {
            await yieldToMain();
            if (!alive()) throw new PrepCancelled();
            sliceStart = performance.now();
        }
    }
}

/**
 * In the party room the stock "Happy Birthday" plaque becomes a personal
 * "HBD {name}" (the acrylic topper every Thai bakery sells). Only for the
 * default topper with no custom text; anything the sender chose is kept.
 */
function topperTextFor() {
    const custom = (activeConfig.topperText || '').trim();
    if (custom || !partyMode) return custom;
    const name = (activeConfig.recipientName || '').trim();
    return (activeConfig.topper || 'hbd') === 'hbd' && name ? `HBD ${name}` : '';
}

function buildCake(mobile) {
    buildCakeModel(cakeGroup, {
        cakeModel: activeConfig.cakeModel || 'classic-tiered',
        plateStyle: activeConfig.plate || 'ceramic',
        glazeStyle: activeConfig.glaze || 'chocolate',
        topperStyle: activeConfig.topper || 'hbd',
        topperText: topperTextFor(),
        themeName: activeConfig.theme || 'neon-rose',
        themeColors: getThemeRGBColors(activeConfig.theme),
        strawberries: numberOr(activeConfig.strawberries, 4),
        cherries: numberOr(activeConfig.cherries, 4),
        rolls: numberOr(activeConfig.rolls, 3),
        sprinkles: activeConfig.sprinkles !== undefined ? !!activeConfig.sprinkles : true,
        glazeColor: activeConfig.glazeColor || '',
        creamColor: activeConfig.creamColor || '',
        plateColor: activeConfig.plateColor || '',
        topperColor: activeConfig.topperColor || '',
        detail: mobile ? 0.6 : 1,
        // Fruit meshes are named so a tap after the climax can bounce them.
        tagDecor: true
    });
}

function numberOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function setupCandles() {
    const layout = getCakeLayout(activeConfig.cakeModel || 'classic-tiered');
    const count = Math.min(10, Math.max(1, numberOr(activeConfig.candles, 5)));
    const built = buildCandles(cakeGroup, layout, {
        count, candleColor: activeConfig.candleColor || '', look: backdrop.light ? 'light' : 'dark'
    });
    flameMaterial = built.flameMaterial;

    // Invisible, generous hit spheres: flames project to ~9x17 px on phones,
    // far below the 44 px a thumb needs. material.visible=false costs no draw
    // call but still raycasts.
    const hitGeo = new THREE.SphereGeometry(0.3, 10, 8);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    hitMeshes = [];
    candles = built.candles.map(({ group, flame }) => {
        const hit = new THREE.Mesh(hitGeo, hitMat);
        hit.position.set(0, 0.42, 0);
        group.add(hit);
        hitMeshes.push(hit);
        // Flames start out and ignite during the intro.
        flame.scale.setScalar(0.0001);
        const candle = { group, flame, hit, isLit: false };
        hit.userData.candle = candle;
        return candle;
    });

    candleLight = new THREE.PointLight(0xffa24a, 0, 5, 2);
    candleLight.position.set(built.center.x, layout.candleBaseY + 0.62, built.center.z);
    // The party room's rig already has the candle light (room.setCandles);
    // a second point light would cost every lit shader a light for nothing.
    if (!partyMode) cakeGroup.add(candleLight);
    candleLightLevel = 0;
}

function measureCake() {
    const box = new THREE.Box3().setFromObject(cakeGroup);
    const radius = Math.max(Math.abs(box.min.x), box.max.x, Math.abs(box.min.z), box.max.z);
    cakeBounds = {
        radius: Number.isFinite(radius) ? radius : 2.8,
        floorY: Number.isFinite(box.min.y) ? box.min.y : -1.15,
        topY: getCakeLayout(activeConfig.cakeModel || 'classic-tiered').candleBaseY
    };
}

// ---------------------------------------------------------------------------
// Particles: pooled Points, one shared shader program for all three pools
// ---------------------------------------------------------------------------

const POINT_VERT = /* glsl */ `
    attribute float aLife;
    attribute float aSize;
    uniform float uScale;
    uniform float uGrow;
    varying float vLife;
    void main() {
        vLife = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float grow = mix(1.0, 1.0 + uGrow, 1.0 - aLife);
        gl_PointSize = aLife > 0.0 ? aSize * grow * uScale / max(0.1, -mv.z) : 0.0;
        gl_Position = projectionMatrix * mv;
    }
`;
const POINT_FRAG = /* glsl */ `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vLife;
    void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * uOpacity * min(1.0, vLife * 2.5);
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
    }
`;

class PointPool {
    constructor(max, { color, opacity = 1, additive = true, grow = 0, lift = 0, drag = 0.8 }) {
        this.max = max;
        this.cursor = 0;
        this.active = 0;
        this.lift = lift;
        this.drag = drag;
        this.pos = new Float32Array(max * 3);
        this.vel = new Float32Array(max * 3);
        this.life = new Float32Array(max);
        this.ttl = new Float32Array(max).fill(1);
        this.size = new Float32Array(max);
        const geo = new THREE.BufferGeometry();
        this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
        this.lifeAttr = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
        this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', this.posAttr);
        geo.setAttribute('aLife', this.lifeAttr);
        geo.setAttribute('aSize', this.sizeAttr);
        const mat = new THREE.ShaderMaterial({
            vertexShader: POINT_VERT,
            fragmentShader: POINT_FRAG,
            uniforms: {
                uColor: { value: new THREE.Color().setRGB(...color) },
                uOpacity: { value: opacity },
                uScale: pointScale,
                uGrow: { value: grow }
            },
            transparent: true,
            depthWrite: false,
            blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
        });
        this.points = new THREE.Points(geo, mat);
        this.points.frustumCulled = false;
        this.points.renderOrder = 3;
    }

    spawn(x, y, z, vx, vy, vz, ttl, size) {
        const i = this.cursor;
        this.cursor = (this.cursor + 1) % this.max;
        const k = i * 3;
        this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
        this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
        this.life[i] = 1;
        this.ttl[i] = ttl;
        this.size[i] = size;
        this.active = this.max; // cheap upper bound until the next update pass
    }

    update(dt) {
        if (!this.active) return;
        let alive = 0;
        const damp = Math.max(0, 1 - this.drag * dt);
        for (let i = 0; i < this.max; i++) {
            if (this.life[i] <= 0) continue;
            this.life[i] = Math.max(0, this.life[i] - dt / this.ttl[i]);
            const k = i * 3;
            this.vel[k + 1] += this.lift * dt;
            this.vel[k] *= damp; this.vel[k + 1] *= damp; this.vel[k + 2] *= damp;
            this.pos[k] += this.vel[k] * dt;
            this.pos[k + 1] += this.vel[k + 1] * dt;
            this.pos[k + 2] += this.vel[k + 2] * dt;
            if (this.life[i] > 0) alive++;
        }
        this.active = alive;
        this.posAttr.needsUpdate = true;
        this.lifeAttr.needsUpdate = true;
        this.sizeAttr.needsUpdate = true;
    }
}

function setupParticles() {
    // Colours above 1.0 cross the bloom threshold so embers and sparkles glow.
    // Additive glitter vanishes on pale paper, so light backdrops draw embers
    // and sparkles as solid warm-gold specks, and smoke a shade darker.
    const light = backdrop.light;
    embers = new PointPool(reduceMotion ? 24 : 80, { color: light ? [1.0, 0.45, 0.08] : [1.9, 1.0, 0.35], additive: !light, lift: 0.3, drag: 0.5 });
    smoke = new PointPool(reduceMotion ? 40 : 110, { color: light ? [0.5, 0.47, 0.5] : [0.72, 0.7, 0.76], opacity: light ? 0.26 : 0.32, additive: false, grow: 2.4, lift: 0.18, drag: 0.9 });
    sparkles = new PointPool(reduceMotion ? 30 : 160, { color: light ? [1.05, 0.66, 0.1] : [2.2, 1.7, 0.6], additive: !light, lift: -0.9, drag: 0.4 });
    const root = new THREE.Group();
    root.add(embers.points, smoke.points, sparkles.points);
    scene.add(root);
    ownedRoots.push(root);
}

function updatePointScale() {
    if (!renderer || !camera) return;
    const h = renderer.getDrawingBufferSize(tmpV2).y;
    pointScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
const tmpV2 = new THREE.Vector2();

function flameWorldPos(candle, out) {
    return candle.flame.getWorldPosition(out);
}

function emitSmoke(candle) {
    if (!smoke) return;
    flameWorldPos(candle, tmpV);
    const n = reduceMotion ? 4 : 12;
    for (let i = 0; i < n; i++) {
        smoke.spawn(
            tmpV.x + (Math.random() - 0.5) * 0.03, tmpV.y + 0.02 + i * 0.01, tmpV.z + (Math.random() - 0.5) * 0.03,
            (Math.random() - 0.5) * 0.12, 0.25 + Math.random() * 0.25, (Math.random() - 0.5) * 0.12,
            1.3 + Math.random() * 0.8, 0.07 + Math.random() * 0.05
        );
    }
}

function burstSparkles(origin, count, speed = 2.2) {
    if (!sparkles) return;
    for (let i = 0; i < count; i++) {
        const theta = Math.random() * Math.PI * 2;
        const up = 0.55 + Math.random() * 0.45;
        const s = speed * (0.5 + Math.random() * 0.5);
        sparkles.spawn(
            origin.x, origin.y, origin.z,
            Math.cos(theta) * s * (1 - up * 0.6), s * up, Math.sin(theta) * s * (1 - up * 0.6),
            1.2 + Math.random() * 0.8, 0.035 + Math.random() * 0.03
        );
    }
}

// ---------------------------------------------------------------------------
// Ambient set dressing (clutter budget: nothing crosses the cake)
// ---------------------------------------------------------------------------

function glowTexture(inner, outer) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function setupStars() {
    // 40 static twinkles on a far shell: depth without motion noise.
    const count = reduceMotion ? 24 : 40;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const theta = Math.random() * Math.PI * 2;
        const r = 9 + Math.random() * 6;
        positions[i * 3] = Math.cos(theta) * r;
        positions[i * 3 + 1] = -1 + Math.random() * 9;
        positions[i * 3 + 2] = Math.sin(theta) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
        size: 0.16,
        map: glowTexture('rgba(255,236,190,1)', 'rgba(255,200,120,0)'),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.75,
        fog: false
    });
    stars = new THREE.Points(geo, mat);
    scene.add(stars);
    ownedRoots.push(stars);
}

function setupFloorGlow(theme) {
    // A soft theme-coloured pool of light replaces the neon scanner rings.
    const c = new THREE.Color(theme.cream);
    const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
    const size = cakeBounds.radius * 3.2;
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
            map: glowTexture(`rgba(${rgb},0.55)`, `rgba(${rgb},0)`),
            transparent: true,
            depthWrite: false,
            opacity: 0.16,
            fog: false
        })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = cakeBounds.floorY + 0.01;
    mesh.renderOrder = -1;
    scene.add(mesh);
    ownedRoots.push(mesh);
    floorGlow = mesh;
}

function decorPalette(theme) {
    const base = [theme.cream, theme.tier1, theme.tier2, 0xffd76a, 0xff8fb1];
    return base.map((h) => {
        const c = new THREE.Color(h);
        // Keep balloons readable against the dark set: no near-black shells.
        const hsl = {};
        c.getHSL(hsl);
        if (hsl.l < 0.35) c.setHSL(hsl.h, Math.max(0.5, hsl.s), 0.5);
        return c;
    });
}

function setupDecor(theme) {
    const palette = decorPalette(theme);

    // Balloons: 3 instances, after the climax only, always behind the cake.
    const bGeo = new THREE.SphereGeometry(0.34, 24, 16);
    const bMat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.05 });
    const bMesh = new THREE.InstancedMesh(bGeo, bMat, 3);
    bMesh.name = 'balloon';
    const sGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.9, 4);
    sGeo.translate(0, -0.85, 0);
    const sMesh = new THREE.InstancedMesh(sGeo, new THREE.MeshBasicMaterial({ color: 0xf2e6da }), 3);
    const state = [];
    for (let i = 0; i < 3; i++) {
        bMesh.setColorAt(i, palette[i % palette.length]);
        state.push({ pos: new THREE.Vector3(), speed: 0.28 + Math.random() * 0.15, phase: Math.random() * 6, scale: 1, popped: false });
    }
    bMesh.visible = sMesh.visible = false;
    const bRoot = new THREE.Group();
    bRoot.add(bMesh, sMesh);
    scene.add(bRoot);
    ownedRoots.push(bRoot);
    balloons = { mesh: bMesh, strings: sMesh, state };

    // Gifts: 3 instances resting on the table around the plate after the climax.
    const boxGeo = new THREE.BoxGeometry(0.5, 0.42, 0.5);
    boxGeo.translate(0, 0.21, 0);
    const boxMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.05 });
    const boxMesh = new THREE.InstancedMesh(boxGeo, boxMat, 3);
    boxMesh.name = 'gift';
    const ribbonParts = [
        new THREE.BoxGeometry(0.53, 0.44, 0.08),
        new THREE.BoxGeometry(0.08, 0.44, 0.53),
        new THREE.TorusGeometry(0.07, 0.022, 6, 14).rotateZ(Math.PI / 4).translate(-0.05, 0.25, 0),
        new THREE.TorusGeometry(0.07, 0.022, 6, 14).rotateZ(-Math.PI / 4).translate(0.05, 0.25, 0)
    ];
    ribbonParts[0].translate(0, 0.21, 0);
    ribbonParts[1].translate(0, 0.21, 0);
    ribbonParts.forEach((g) => { g.deleteAttribute('uv'); });
    const ribbonGeo = mergeGeometries(ribbonParts.map((g) => g.index ? g.toNonIndexed() : g));
    ribbonParts.forEach((g) => g.dispose());
    const ribbonMesh = new THREE.InstancedMesh(ribbonGeo, new THREE.MeshStandardMaterial({ color: 0xfff4e0, roughness: 0.35 }), 3);
    const giftState = [];
    for (let i = 0; i < 3; i++) {
        boxMesh.setColorAt(i, palette[(i + 1) % palette.length]);
        giftState.push({ pos: new THREE.Vector3(), rot: Math.random() * Math.PI, scale: 0, target: 0, popped: false });
    }
    boxMesh.visible = ribbonMesh.visible = false;
    const gRoot = new THREE.Group();
    gRoot.add(boxMesh, ribbonMesh);
    scene.add(gRoot);
    ownedRoots.push(gRoot);
    gifts = { mesh: boxMesh, ribbons: ribbonMesh, state: giftState };
}

/** Azimuth (around Y) of the current camera, so decor can be kept behind the cake. */
function cameraAzimuth() {
    return camera ? Math.atan2(camera.position.x, camera.position.z) : 0;
}

function placeBalloon(b, fromBelow) {
    // Behind the cake as seen from the current camera, well outside its
    // radius, so nothing ever crosses in front of or through it.
    const az = cameraAzimuth() + Math.PI + (Math.random() - 0.5) * 1.3;
    const r = cakeBounds.radius + 2 + Math.random() * 1.6;
    const y = fromBelow ? cakeBounds.topY - 1.2 - Math.random() * 1.5 : cakeBounds.topY + Math.random() * 3;
    b.pos.set(Math.sin(az) * r, y, Math.cos(az) * r);
    b.popped = false;
    b.scale = 1;
}

function showDecor() {
    if (!balloons || !gifts) return;
    balloons.state.forEach((b) => placeBalloon(b, true));
    balloons.mesh.visible = balloons.strings.visible = !reduceMotion;
    const az = cameraAzimuth();
    const angles = [az + 1.35, az - 1.25, az + Math.PI - 0.5];
    gifts.state.forEach((g, i) => {
        const r = cakeBounds.radius + 0.55;
        g.pos.set(Math.sin(angles[i]) * r, cakeBounds.floorY, Math.cos(angles[i]) * r);
        g.popped = false;
        g.scale = 0;
        g.target = 1;
    });
    gifts.mesh.visible = gifts.ribbons.visible = true;
}

function hideDecor() {
    if (!balloons || !gifts) return;
    balloons.mesh.visible = balloons.strings.visible = false;
    gifts.mesh.visible = gifts.ribbons.visible = false;
    gifts.state.forEach((g) => { g.scale = 0; g.target = 0; });
}

function updateDecor(dt) {
    if (balloons?.mesh.visible) {
        const { mesh, strings, state } = balloons;
        state.forEach((b, i) => {
            if (!b.popped) {
                b.pos.y += b.speed * dt;
                if (b.pos.y > 8) placeBalloon(b, true);
            } else {
                b.scale = Math.max(0, b.scale - dt * 6);
                if (b.scale === 0 && !b.respawn) {
                    b.respawn = true;
                    later(() => { b.respawn = false; placeBalloon(b, true); }, 3500);
                }
            }
            const sway = Math.sin(elapsed * 0.8 + b.phase) * 0.18;
            tmpV.set(b.pos.x + sway, b.pos.y, b.pos.z);
            tmpQ.setFromAxisAngle(AXIS_Z, sway * 0.4);
            tmpS.set(b.scale, b.scale * 1.18, b.scale);
            tmpM.compose(tmpV, tmpQ, tmpS);
            mesh.setMatrixAt(i, tmpM);
            tmpS.set(b.scale, b.scale, b.scale);
            tmpM.compose(tmpV, tmpQ, tmpS);
            strings.setMatrixAt(i, tmpM);
        });
        mesh.instanceMatrix.needsUpdate = true;
        strings.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
    }
    if (gifts?.mesh.visible) {
        const { mesh, ribbons, state } = gifts;
        state.forEach((g, i) => {
            g.scale += (g.target - g.scale) * Math.min(1, dt * (g.popped ? 14 : 5));
            tmpV.copy(g.pos);
            tmpQ.setFromAxisAngle(AXIS_Y, g.rot);
            const s = Math.max(0.0001, g.scale);
            tmpS.set(s, s, s);
            tmpM.compose(tmpV, tmpQ, tmpS);
            mesh.setMatrixAt(i, tmpM);
            ribbons.setMatrixAt(i, tmpM);
        });
        mesh.instanceMatrix.needsUpdate = true;
        ribbons.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
    }
}
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

function computeHero() {
    if (room) {
        fitRoomShots();
        return;
    }
    const aspect = window.innerWidth / window.innerHeight;
    // Framing was tuned on the classic cake (radius ~2.8); smaller models
    // (heart, bento) come closer so the cake stays the hero.
    const fit = THREE.MathUtils.clamp(cakeBounds.radius / 2.8, 0.72, 1.15);
    if (aspect < 1.0) {
        // Portrait: pull back until the whole plate fits the *horizontal*
        // field of view (the old fixed curve clipped the plate on phones).
        const vfov = THREE.MathUtils.degToRad(camera?.fov ?? 45);
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
        const z = Math.max(13 * fit, (cakeBounds.radius * 1.1) / Math.sin(hfov / 2));
        hero.pos.set(0, z * 0.38, z);
        hero.target.set(0, 0.4, 0);
        if (controls) { controls.minDistance = 5; controls.maxDistance = 25; }
    } else {
        hero.pos.set(0, 4.5, 9.5).multiplyScalar(fit);
        hero.target.set(0, 0.5, 0);
        if (controls) { controls.minDistance = 3.5; controls.maxDistance = 20; }
    }
}

/**
 * Room shots, fitted to this viewport. Portrait phones get a wider lens (the
 * room is authored landscape-first) and the cake shots back off until the
 * plate fits the horizontal field of view.
 */
function fitRoomShots() {
    const aspect = window.innerWidth / window.innerHeight;
    const portrait = aspect < 1;
    const plate = cakeBounds.radius * 2;
    const shots = { ...room.shots };
    if (!shots.reveal) {
        shots.reveal = { position: shots.entry.position.clone(), target: new THREE.Vector3(...REVEAL_TARGET_WORLD) };
    }
    roomShots = {};
    for (const [name, shot] of Object.entries(shots)) {
        const pos = shot.position.clone();
        const target = shot.target.clone();
        // Lens: the room's own per-aspect fov when it gives one; portrait
        // phones otherwise get a wider lens (the room is authored landscape-
        // first), wider still in the doorway so the reveal holds the party.
        let fov = portrait ? (name === 'entry' || name === 'reveal' ? 62 : 58) : 45;
        const f = shot.fov;
        if (typeof f === 'number') fov = f;
        else if (f && typeof f === 'object') fov = (portrait ? f.portrait : f.landscape) ?? fov;
        if (portrait && name === 'cake') {
            // A phone cannot hold the 2.4 m foil row from the table (it
            // would need a ~76 deg lens), so it was cut to "BIRTHDA". Step
            // 30 % closer and a touch lower: the cake is the hero, the name
            // sign stays, the letters leave through the top edge.
            pos.lerp(target, 0.3);
            pos.y -= 0.06 * 14;
            target.y -= 0.3 * 14;
        }
        const vfov = THREE.MathUtils.degToRad(fov);
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
        const need = name === 'cake' ? plate * 1.25 : name === 'closeUp' ? plate * 0.95 : 0;
        if (need) {
            const dir = pos.clone().sub(target);
            // closeUp also backs off 10 %: nothing on the table between lens and cake.
            const base = dir.length() * (name === 'closeUp' ? 1.1 : 1);
            const want = Math.max(base, need / 2 / Math.tan(Math.min(hfov, vfov * 1.2) / 2));
            pos.copy(target).addScaledVector(dir.normalize(), want);
        }
        roomShots[name] = { pos, target, fov };
    }
    fitRevealToParty(roomShots.reveal, aspect, portrait);
    if (phase === 'gate' || phase === 'idle' || phase === 'dark') setLens(roomShots.entry.fov);
    hero.pos.copy(roomShots.cake.pos);
    hero.target.copy(roomShots.cake.target);
}

/**
 * The reveal must hold the whole party: both ends of the foil letters and
 * the cake. Starting from the room's framing, the view turns toward the cake
 * (and, on phones, the lens widens by up to 10 deg) only as far as needed.
 */
function fitRevealToParty(shot, aspect, portrait) {
    if (!shot || !cakeGroup) return;
    const points = [];
    ['foil-HAPPY', 'foil-BIRTHDAY'].forEach((n) => {
        const mesh = room.group.getObjectByName(n);
        if (!mesh) return;
        const box = new THREE.Box3().setFromObject(mesh);
        const c = box.getCenter(new THREE.Vector3());
        points.push(new THREE.Vector3(box.min.x, c.y, box.max.z), new THREE.Vector3(box.max.x, c.y, box.max.z));
    });
    if (!points.length) points.push(shot.target.clone());
    const letterCount = points.length;
    const cakeBox = new THREE.Box3().setFromObject(cakeGroup);
    const cake = cakeBox.getCenter(new THREE.Vector3());
    points.push(cake, new THREE.Vector3(cake.x, cakeBox.min.y, cake.z));
    const probe = new THREE.PerspectiveCamera(shot.fov, aspect, 0.1, 800);
    const target = new THREE.Vector3();
    const fits = () => {
        probe.updateProjectionMatrix();
        probe.position.copy(shot.pos);
        probe.lookAt(target);
        probe.updateMatrixWorld();
        return points.every((p, i) => {
            const v = tmpV.copy(p).project(probe);
            if (v.z >= 1) return false;
            // Letter ends: on screen, below the HUD row. The cake: well inside
            // the frame (at the edge it hides behind the props on the table).
            if (i < letterCount) return Math.abs(v.x) <= 0.95 && v.y <= 0.8 && v.y >= -0.2;
            return Math.abs(v.x) <= 0.55 && v.y >= -0.62 && v.y <= 0.5;
        });
    };
    const base = shot.target.clone();
    const extra = portrait ? 10 : 4;
    for (let widen = 0; widen <= extra; widen += 2) {
        probe.fov = shot.fov + widen;
        for (let k = 0; k <= 14; k++) {
            target.copy(base).lerp(cake, k * 0.05);
            if (fits()) {
                shot.target.copy(target);
                shot.fov = probe.fov;
                return;
            }
        }
    }
    // Cannot hold everything: favour the cake and the name over the letter ends.
    shot.target.copy(base).lerp(cake, 0.4);
    shot.fov += extra;
}

/** Lets the recipient look around the cake a little, never behind the set. */
function enableRoomOrbit(shot) {
    if (!controls || !shot) return;
    const off = tmpV.copy(shot.pos).sub(shot.target);
    const az = Math.atan2(off.x, off.z);
    const polar = Math.acos(THREE.MathUtils.clamp(off.y / off.length(), -1, 1));
    controls.minAzimuthAngle = az - 0.45;
    controls.maxAzimuthAngle = az + 0.45;
    controls.minPolarAngle = Math.max(0.2, polar - 0.3);
    controls.maxPolarAngle = Math.min(Math.PI / 2 - 0.05, polar + 0.22);
    // Distance limits only while the recipient can orbit: OrbitControls
    // applies them on every update(), even disabled, and limits sized for
    // the cake used to drag the doorway camera toward the wall.
    const d = off.length();
    controls.minDistance = d * 0.55;
    controls.maxDistance = d * 1.3;
    controls.enabled = true;
}

function lockRoomOrbit() {
    if (!controls) return;
    controls.enabled = false;
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
}

function setLens(fov) {
    anime.remove(lens);
    lens.v = fov;
    applyLens();
}

function applyLens() {
    if (!camera || Math.abs(camera.fov - lens.v) < 0.001) return;
    camera.fov = lens.v;
    camera.updateProjectionMatrix();
    updatePointScale();
}

function tweenCamera(pos, target, duration, easing = 'easeInOutCubic', { unlock = true, fov } = {}) {
    if (!camera || !controls) return;
    anime.remove(camera.position);
    anime.remove(controls.target);
    if (fov !== undefined) {
        anime.remove(lens);
        if (duration) anime({ targets: lens, v: fov, duration, easing });
        else lens.v = fov;
    }
    if (!duration) {
        camera.position.copy(pos);
        controls.target.copy(target);
        return;
    }
    controls.enabled = false;
    anime({ targets: camera.position, x: pos.x, y: pos.y, z: pos.z, duration, easing });
    anime({
        targets: controls.target, x: target.x, y: target.y, z: target.z, duration, easing,
        complete: () => { if (controls && unlock) controls.enabled = true; }
    });
}

/** The framing used after the climax: slightly back and up so smoking wicks stay in view. */
function afterglowPose() {
    if (room && roomShots) {
        // Party: back off toward the room so the balloon drop and the letters read.
        const { cake, wide } = roomShots;
        // 0.4 toward wide: the balloons are seen falling, not hitting the lens.
        return { pos: cake.pos.clone().lerp(wide.pos, 0.4), target: cake.target.clone().lerp(wide.target, 0.12), fov: cake.fov };
    }
    const dir = tmpV.copy(hero.pos).sub(hero.target);
    const pos = hero.target.clone().add(dir.multiplyScalar(1.06));
    pos.y += 0.35;
    return { pos, target: hero.target.clone() };
}

function tweenShift(x, y, duration) {
    anime.remove(shift);
    anime({ targets: shift, x, y, duration: ms(duration), easing: 'easeInOutCubic' });
}

function applyViewShift() {
    const x = Math.round(shift.x);
    const y = Math.round(shift.y);
    const key = `${x},${y},${window.innerWidth},${window.innerHeight}`;
    if (key === appliedShift) return;
    appliedShift = key;
    if (!x && !y) camera.clearViewOffset();
    else camera.setViewOffset(window.innerWidth, window.innerHeight, x, y, window.innerWidth, window.innerHeight);
}

function onResize() {
    if (!renderer || !camera) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    bloomComposer?.setSize(w, h);
    const wasHero = phase === 'gate' || phase === 'intro';
    computeHero();
    if (room && (phase === 'gate' || phase === 'dark') && !anime.running.length) {
        camera.position.copy(roomShots.entry.pos);
        controls.target.copy(roomShots.entry.target);
    } else if (!room && wasHero && !anime.running.length) {
        camera.position.copy(hero.pos);
        controls.target.copy(hero.target);
    }
    appliedShift = null;
    if ($('rcv-card')?.classList.contains('is-open')) updateCardShift(0);
    updatePointScale();
}

function onVisibility() {
    if (!audio) return;
    if (document.hidden) audio.ctx.suspend().catch(() => {});
    else if (phase !== 'gate') audio.ctx.resume().catch(() => {});
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function startLoop() {
    if (rafId) return;
    lastFrameTime = performance.now();
    rafId = requestAnimationFrame(loop);
}

function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (document.hidden || !renderer) {
        lastFrameTime = now;
        return;
    }
    const dt = Math.min(0.05, Math.max(0, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    elapsed += dt;

    // A real cake on a real table does not spin; the studio one still does.
    if (cakeGroup && !reduceMotion && !room) cakeGroup.rotation.y += dt * 0.12 * spin.v;
    if (stars && !reduceMotion) stars.rotation.y += dt * 0.01;
    controls.update();
    if (flameMaterial?.uniforms?.uTime) flameMaterial.uniforms.uTime.value = elapsed;

    applyLights(dt);
    spawnEmbers(dt);
    embers?.update(dt);
    smoke?.update(dt);
    sparkles?.update(dt);
    updateDecor(dt);
    room?.update(dt, elapsed);
    if (room) applyLens();
    if (phase === 'dark') placeSwitchMarker();
    if (phase === 'song') updateLyrics();
    updateMic(dt);
    applyViewShift();
    governor?.sample(dt);
    renderFrame();
}

function renderFrame() {
    if (!renderer || !scene || !camera) return;
    if (bloomComposer) bloomComposer.composer.render();
    else renderer.render(scene, camera);
}

function applyLights(dt) {
    if (!sceneLights || !lightBase) return;
    // Party room: the cake rig follows the room (faint in the dark, full
    // under the party lights, candle-led in the dim) plus the auto-exposure
    // overshoot after the switch. All plain uniforms.
    let roomK = 1;
    let kick = 1;
    if (room) {
        const L = roomLight.v;
        const D = roomDim.v;
        const key = `${L.toFixed(3)}|${D.toFixed(3)}`;
        if (key !== appliedRoom) {
            appliedRoom = key;
            room.setLights(L);
            room.setDim(D);
            const envK = (0.08 + 0.92 * L) * (1 - 0.55 * D);
            for (const { mat, env } of cakeMaterials) mat.envMapIntensity = env * envK;
        }
        roomK = (0.1 + 0.9 * L) * (1 - 0.6 * D);
        // Dark-adapted eyes: exposure sits higher in the dark (the room's
        // suggestion), and the switch then overshoots before it settles.
        const ex = room.exposure || { dark: 1.25, lit: 1 };
        kick = exposureKick.v * THREE.MathUtils.lerp(ex.dark, ex.lit, L);
        const pass = bloomComposer?.bloom;
        if (pass) pass.strength = lightBase.bloom * (1 + (exposureKick.v - 1) * 0.9);
    }
    // dim: the wish beat (flames stay bright, the room falls away).
    // glow: the warm bloom at the climax.
    const k = (1 - lightBase.dimK * dim.v + 0.6 * glow.v) * roomK;
    sceneLights.key.intensity = lightBase.key * k;
    sceneLights.fill.intensity = lightBase.fill * k;
    sceneLights.ambient.intensity = lightBase.ambient * (1 - 0.5 * dim.v + 0.8 * glow.v) * roomK;
    sceneLights.rim.intensity = lightBase.rim * (1 - 0.3 * dim.v) * roomK;
    renderer.toneMappingExposure = lightBase.exposure * kick * (1 - 0.18 * dim.v + 0.12 * glow.v);

    if (candleLight) {
        let lit = 0;
        for (const c of candles) if (c.isLit) lit++;
        const target = lit * CANDLE_LIGHT_PER_FLAME;
        candleLightLevel += (target - candleLightLevel) * Math.min(1, dt * 6);
        if (room) {
            // The room's candle light flickers itself; it only needs the level.
            room.setCandles?.(candles.length ? candleLightLevel / (candles.length * CANDLE_LIGHT_PER_FLAME) : 0);
        } else {
            candleLight.intensity = candleLightLevel *
                (0.9 + Math.sin(elapsed * 13.0) * 0.06 + Math.sin(elapsed * 29.0 + 1.3) * 0.04);
        }
    }
}

function spawnEmbers(dt) {
    if (!embers || !decorEnabled) return;
    // ~2.5 embers per second per lit flame (1 under reduced motion),
    // independent of the display's refresh rate.
    const rate = reduceMotion ? 1 : 2.5;
    for (const c of candles) {
        if (!c.isLit) continue;
        emberBudget += rate * dt;
    }
    const lit = litCount();
    while (emberBudget >= 1) {
        emberBudget -= 1;
        if (!lit) { emberBudget = 0; break; }
        // Pick the k-th lit candle without allocating a filtered array.
        let k = (Math.random() * lit) | 0;
        let c = candles[0];
        for (const cand of candles) { if (cand.isLit && k-- === 0) { c = cand; break; } }
        flameWorldPos(c, tmpV);
        embers.spawn(
            tmpV.x + (Math.random() - 0.5) * 0.03, tmpV.y + 0.12, tmpV.z + (Math.random() - 0.5) * 0.03,
            (Math.random() - 0.5) * 0.12, 0.35 + Math.random() * 0.35, (Math.random() - 0.5) * 0.12,
            1.0 + Math.random() * 0.8, 0.022 + Math.random() * 0.015
        );
    }
}

// ---------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------

function onOpenClick(quiet) {
    if (phase !== 'gate' || opening) return;
    opening = true;
    // Quiet: everything plays, silently, until the speaker is tapped (then a
    // 1.5 s fade-in). The surprise is carried by light, text and vibration.
    quietMode = !!quiet;
    muted = quietMode;
    $('receiver-view')?.classList.toggle('is-quiet', quietMode);
    syncAudioButton();
    // Must run synchronously inside the tap: iOS only unlocks audio here.
    unlockAudio();
    if (isReady) {
        startReveal();
        return;
    }
    const btn = $('btn-open-envelope');
    if (btn) {
        btn.dataset.state = 'waiting';
        btn.setAttribute('aria-busy', 'true');
        updateOpenLabel();
    }
    sceneReady.then((ok) => {
        if (phase !== 'gate') return;
        if (ok) startReveal();
        else startWithoutScene();
    });
}

function leaveGate() {
    const gate = $('envelope-gate');
    if (!gate) return;
    gate.classList.add('is-leaving');
    gate.inert = true;
    later(() => gate.classList.remove('active-gate', 'is-leaving'), ms(500) + 20);
}

function startReveal() {
    if (room) {
        startDark();
        return;
    }
    phase = 'intro';
    leaveGate();
    $('greeting-canvas-container')?.classList.add('is-live');
    const hud = $('rcv-hud');
    if (hud) { hud.inert = false; hud.classList.add('is-live'); }
    startLoop();
    startMusic({ level: 0.85, fadeIn: 1.5 });

    // Establishing move: high and wide down to the hero framing.
    if (!reduceMotion) {
        const dir = hero.pos.clone().sub(hero.target);
        const start = hero.target.clone().add(dir.multiplyScalar(1.35));
        start.y += 2.2;
        camera.position.copy(start);
        controls.target.copy(hero.target);
        tweenCamera(hero.pos, hero.target, 2400, 'easeOutCubic');
        spin.v = 0.6;
    }

    const title = $('rcv-title');
    if (title) {
        title.classList.add('is-hero');
        later(() => { title.classList.remove('is-hero'); title.classList.add('is-docked'); }, ms(2800) || 1200);
    }
    later(() => igniteCandles(() => later(startWish, ms(700))), ms(1300));
}

function igniteCandles(done) {
    const stagger = ms(150);
    if (room && audio) cues.matchStrike(audio, audio.now(), 0.1);
    const lead = room ? ms(220) : 0;
    candles.forEach((c, i) => {
        later(() => {
            c.isLit = true;
            anime.remove(c.flame.scale);
            c.flame.rotation.z = 0;
            anime({ targets: c.flame.scale, x: 1, y: 1, z: 1, duration: ms(420) || 1, easing: 'easeOutBack' });
            playTick(i);
        }, lead + i * stagger);
    });
    later(done, lead + candles.length * stagger + ms(300));
}

// ---------------------------------------------------------------------------
// Party beats: dark room -> switch -> SURPRISE -> tour -> cake + song
// ---------------------------------------------------------------------------

const darkTimers = new Set();
function darkLater(fn, delay) {
    const id = later(() => { darkTimers.delete(id); fn(); }, delay);
    darkTimers.add(id);
    return id;
}
function clearDarkTimers() {
    darkTimers.forEach((id) => { clearTimeout(id); timers.delete(id); });
    darkTimers.clear();
}

function haptic(pattern) {
    // Android Chrome only (iOS has no Vibration API); needs a recent tap,
    // which the gate and switch taps provide. Silent, so quiet mode keeps it.
    try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

function announce(text) {
    const live = $('rcv-live');
    if (live) live.textContent = text;
}

/**
 * Beat 1-4: we are standing in the doorway of a dark room. Never a black
 * screen: the window, the switch glow and the hint all appear at once, room
 * tone proves it is alive, and the lights come on by themselves after 9 s.
 */
function startDark({ fromReplay = false } = {}) {
    phase = 'dark';
    if (!fromReplay) leaveGate();
    const rv = $('receiver-view');
    rv?.classList.add('is-dark');
    rv?.classList.remove('is-dim');
    $('greeting-canvas-container')?.classList.add('is-live');
    const hud = $('rcv-hud');
    if (hud) { hud.inert = false; hud.classList.add('is-live'); }
    $('rcv-title')?.classList.remove('is-hero', 'is-docked', 'is-tucked');
    spin.v = 0;
    anime.remove([roomLight, roomDim, exposureKick, dim, glow]);
    setLens(roomShots.entry.fov);
    warmSurpriseText();
    roomLight.v = 0;
    roomDim.v = 0;
    exposureKick.v = 1;
    dim.v = 0;
    glow.v = 0;
    room.reset?.();
    lockRoomOrbit();
    darkLowerThird = false;
    const entry = roomShots.entry;
    anime.remove(camera.position);
    anime.remove(controls.target);
    camera.position.copy(entry.pos);
    controls.target.copy(entry.target);
    // A slow 3 % step into the room while the eyes adjust.
    if (!reduceMotion) {
        const inward = entry.pos.clone().lerp(entry.target, 0.03);
        tweenCamera(inward, entry.target, 7000, 'easeOutSine', { unlock: false });
    }
    startLoop();

    if (audio) {
        roomTone.start(0.09, 1.2);
        // Someone hiding in here: only with a real recording (public/audio/README.md).
        audio.playClip('whisper', { at: audio.now() + 0.9, gain: 0.5, pan: -0.5, dest: audio.ambience });
    }
    showSwitchMarker();
    darkLater(() => {
        setDarkHint('rcvDarkHint');
        const skip = $('btn-dark-skip');
        if (skip) skip.hidden = false;
    }, DARK_HINT_MS);
    darkLater(escalateDark, DARK_ESCALATE_MS);
    darkLater(() => {
        if (phase !== 'dark') return;
        setDarkHint('rcvAutoLight');
        darkLater(() => flipSwitch(true), 700);
    }, DARK_AUTO_FLIP_MS);
}

function setDarkHint(key) {
    const hint = $('rcv-dark-hint');
    if (!hint) return;
    hint.dataset.key = key;
    hint.textContent = t(key);
    hint.hidden = false;
    // Restart the fade-in for each new line.
    hint.classList.remove('is-in');
    void hint.offsetWidth;
    hint.classList.add('is-in');
}

/** Beat 3: the hint gets explicit and the view drifts toward the switch. */
function escalateDark() {
    if (phase !== 'dark') return;
    setDarkHint('rcvDarkHint2');
    $('rcv-switch')?.classList.add('is-urgent');
    darkLowerThird = true;
    if (reduceMotion || !room.switchWorld) return;
    const pos = camera.position.clone();
    const look = controls.target.clone().sub(pos);
    const toSwitch = room.switchWorld.clone().sub(pos).normalize();
    const dir = look.clone().normalize();
    const angle = dir.angleTo(toSwitch);
    if (angle < 0.01) return;
    const q = new THREE.Quaternion().setFromUnitVectors(dir, toSwitch);
    const part = new THREE.Quaternion().slerp(q, Math.min(1, THREE.MathUtils.degToRad(10) / angle));
    const target = pos.clone().add(look.applyQuaternion(part));
    anime.remove(controls.target);
    anime({ targets: controls.target, x: target.x, y: target.y, z: target.z, duration: 1800, easing: 'easeInOutSine' });
}

function showSwitchMarker() {
    const marker = $('rcv-switch');
    if (!marker) return;
    marker.classList.remove('is-pressed', 'is-urgent');
    marker.hidden = false;
    placeSwitchMarker();
}

/** Keeps the DOM switch target (>= 64 px, focusable) over the 3D switch. */
function placeSwitchMarker() {
    const marker = $('rcv-switch');
    if (!marker || marker.hidden || !room?.switchWorld || !camera) return;
    tmpV.copy(room.switchWorld).project(camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const onScreen = tmpV.z < 1 && Math.abs(tmpV.x) < 1.05 && Math.abs(tmpV.y) < 1.05;
    const x = THREE.MathUtils.clamp((tmpV.x + 1) / 2 * w, 44, w - 44);
    const y = THREE.MathUtils.clamp((1 - tmpV.y) / 2 * h, 90, h - 150);
    marker.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    marker.classList.toggle('is-offscreen', !onScreen);
    const hint = $('rcv-dark-hint');
    if (hint) {
        // The hint sits under the switch, kept inside the screen.
        const hw = Math.min(hint.offsetWidth || 260, w - 32);
        const hx = THREE.MathUtils.clamp(x, 16 + hw / 2, w - 16 - hw / 2);
        const below = y + 56 + (hint.offsetHeight || 48) < h - 90;
        hint.style.transform = `translate(${(hx - hw / 2).toFixed(1)}px, ${(below ? y + 52 : y - 52 - (hint.offsetHeight || 48)).toFixed(1)}px)`;
    }
}

function hideDarkUi() {
    const marker = $('rcv-switch');
    if (marker) marker.hidden = true;
    const hint = $('rcv-dark-hint');
    if (hint) { hint.hidden = true; hint.classList.remove('is-in'); }
    const skip = $('btn-dark-skip');
    if (skip) skip.hidden = true;
    darkLowerThird = false;
}

/** Beat 5: the recipient's own tap. Click, a held beat of darkness, then light. */
function flipSwitch(auto) {
    if (phase !== 'dark') return;
    phase = 'reveal';
    clearDarkTimers();
    const marker = $('rcv-switch');
    marker?.classList.add('is-pressed');
    later(hideDarkUi, 90);
    if (!auto) haptic(12);
    if (audio) {
        audio.resume();
        const t0 = audio.now() + 0.01;
        cues.switchClick(audio, t0);
        // Guests hold their breath: the room goes quiet just before the hit.
        roomTone.duck(t0 + 0.04);
    }
    anime.remove(camera.position);
    anime.remove(controls.target);
    later(lightsOn, LIGHTS_ON_MS);
}

/** Beat 6-7: lights, SURPRISE, poppers, confetti. */
function lightsOn() {
    if (phase !== 'reveal' || !room) return;
    const rv = $('receiver-view');
    rv?.classList.remove('is-dark');
    // Hard cut, like a real switch; the "camera" then adapts.
    anime.remove([roomLight, exposureKick]);
    roomLight.v = 1;
    exposureKick.v = reduceMotion ? 1.05 : 1.35;
    anime({ targets: exposureKick, v: 1, duration: reduceMotion ? 1200 : 700, easing: 'easeOutCubic' });
    if (reduceMotion) {
        crossCut(roomShots.reveal);
    } else {
        flinch();
        // The head turns toward the shout: letters, name, table and cake are
        // in frame within ~0.3 s of the cut.
        later(() => {
            const r = roomShots.reveal;
            anime.remove(controls.target);
            anime({ targets: controls.target, x: r.target.x, y: r.target.y, z: r.target.z, duration: HEAD_TURN_MS, easing: 'easeOutCubic' });
            anime.remove(lens);
            anime({ targets: lens, v: r.fov, duration: HEAD_TURN_MS, easing: 'easeOutCubic' });
        }, HEAD_TURN_DELAY_MS);
    }

    if (audio) {
        const now = audio.now();
        const hit = now + (SHOUT_MS - LIGHTS_ON_MS) / 1000;
        cues.surpriseShout(audio, hit, { soft: reduceMotion });
        if (!reduceMotion) {
            cues.popper(audio, hit + 0.04, -0.6);
            cues.popper(audio, hit + 0.12, 0.6, 0.85);
        }
        partyLoop.start(now + 0.58, 0.3, 1.2);
    }
    later(() => haptic([0, 30, 40, 60]), SHOUT_MS - LIGHTS_ON_MS);
    later(showSurpriseText, 40);
    later(() => {
        if (!reduceMotion) room.popConfetti?.();
        sideConfetti();
    }, 70);
    announce(t('rcvLiveSurprise'));
    later(startTour, TOUR_MS - LIGHTS_ON_MS);
}

/** The camera flinches back 2.5 % and settles (a person startled, not a crane move). */
function flinch() {
    const settle = roomShots.reveal.pos;
    const from = camera.position.clone();
    const back = from.clone().add(from.clone().sub(controls.target).multiplyScalar(0.025));
    anime.remove(camera.position);
    anime.timeline()
        .add({ targets: camera.position, x: back.x, y: back.y, z: back.z, duration: 140, easing: 'easeOutQuad' })
        .add({ targets: camera.position, x: settle.x, y: settle.y, z: settle.z, duration: 900, easing: 'easeOutCubic' });
}

/**
 * The huge outlined word is rasterized once during the dark phase (an
 * almost-transparent, promoted layer), so the reveal frame only changes
 * opacity and transform. Its first raster was a ~110 ms frame at +450 ms.
 */
function warmSurpriseText() {
    const el = $('rcv-surprise');
    if (!el) return;
    el.textContent = t('rcvSurprise');
    el.classList.remove('is-hit');
    el.classList.add('is-warm');
}

function showSurpriseText() {
    const el = $('rcv-surprise');
    if (!el) return;
    if (el.textContent !== t('rcvSurprise')) el.textContent = t('rcvSurprise');
    el.classList.add('is-warm', 'is-hit');
    later(() => el.classList.remove('is-hit', 'is-warm'), 2000);
}

/** Streamers from both sides of the doorway (the poppers are off-frame). */
function sideConfetti() {
    const colors = themeCssColors();
    const n = reduceMotion ? 20 : 70;
    confetti({ particleCount: n, angle: 58, spread: 55, startVelocity: 55, origin: { x: -0.02, y: 0.62 }, colors, ticks: 220 });
    later(() => confetti({ particleCount: n, angle: 122, spread: 55, startVelocity: 55, origin: { x: 1.02, y: 0.62 }, colors, ticks: 220 }), 80);
}

/** Beat 8: glide from the doorway, past the room, to the table; the name docks. */
function startTour() {
    if (phase !== 'reveal') return;
    const { cake } = roomShots;
    if (reduceMotion) {
        crossCut(cake);
    } else {
        // One glide from the reveal framing straight to the table.
        tweenCamera(cake.pos, cake.target, TOUR_GLIDE_MS, 'easeInOutCubic', { unlock: false, fov: cake.fov });
        if (audio) cues.whoosh(audio, audio.now() + 0.15, 1.1, 0.1);
    }
    // No hero title in the room: the foil letters and the name sign are the
    // headline. The pill docks once the glide is under way, never over the foil.
    const title = $('rcv-title');
    if (title) later(() => { title.classList.remove('is-hero', 'is-tucked'); title.classList.add('is-docked'); }, 900);
    later(cakeComing, CAKE_IN_MS - TOUR_MS);
}

/** Reduced motion: a quick dissolve between fixed framings instead of a glide. */
function crossCut(shot) {
    const stage = $('greeting-canvas-container');
    stage?.classList.add('is-cut');
    later(() => {
        tweenCamera(shot.pos, shot.target, 0, 'linear', { fov: shot.fov });
        stage?.classList.remove('is-cut');
    }, 180);
}

/** Tucks the docked name away while the lyrics and the wish carry it. */
function tuckTitle(tucked) {
    $('rcv-title')?.classList.toggle('is-tucked', tucked);
}

/** Beat 10: a slow arc and push while everyone sings; a drag takes over. */
function driftDuringSong() {
    if (reduceMotion || !roomShots) return;
    const { cake } = roomShots;
    const off = camera.position.clone().sub(controls.target);
    off.applyAxisAngle(AXIS_Y, THREE.MathUtils.degToRad(SONG_DRIFT_DEG) * (off.x > 0 ? -1 : 1));
    off.multiplyScalar(0.95);
    const to = cake.target.clone().add(off);
    anime.remove(camera.position);
    anime({ targets: camera.position, x: to.x, y: to.y, z: to.z, duration: SONG_LENGTH * 1000, easing: 'easeInOutSine' });
}

function stopDriftOnDrag() {
    if (phase === 'song') anime.remove(camera.position);
}

/** Beat 9: the Thai part. Lights down, candles lit, then everyone sings. */
function cakeComing() {
    if (phase !== 'reveal') return;
    const note = $('rcv-cake-coming');
    if (note) {
        note.textContent = t('rcvCakeComing');
        note.hidden = false;
        later(() => { note.hidden = true; }, 1600);
    }
    anime.remove(roomDim);
    anime({ targets: roomDim, v: 1, duration: 800, easing: 'easeInOutQuad' });
    partyLoop?.stop(0.6);
    roomTone?.set(0.03, 1);
    later(() => igniteCandles(() => later(startSong, ms(300))), 500);
}

function startSong() {
    if (phase !== 'reveal') return;
    phase = 'song';
    enableRoomOrbit(roomShots.cake);
    tuckTitle(true);
    driftDuringSong();
    lyricIndex = -1;
    songStartedAt = performance.now() + 50;
    song?.start({ level: 0.8, fadeIn: 0.3, passes: 1, claps: 0.09 });
    const strip = $('rcv-lyrics');
    if (strip) strip.hidden = false;
    updateLyrics();
    later(() => { const b = $('btn-skip-song'); if (b && phase === 'song') b.hidden = false; }, 3000);
    later(endSong, SONG_LENGTH * 1000 + 300);
}

/** Karaoke strip: the current line, with the name in the accent colour. */
function updateLyrics() {
    const pos = audio && song ? song.position() : (performance.now() - songStartedAt) / 1000;
    let idx = 0;
    for (let i = 0; i < LYRIC_STARTS.length; i++) if (pos >= LYRIC_STARTS[i]) idx = i;
    if (idx === lyricIndex) return;
    lyricIndex = idx;
    const line = $('rcv-lyric-line');
    const raw = (dict().rcvLyrics ?? translations.en.rcvLyrics ?? '').split('|')[idx] || '';
    if (line) fillRaw(line, raw, { name: recipientName() });
}

function endSong() {
    if (phase !== 'song') return;
    const early = song ? song.position() < SONG_LENGTH - 0.5 : false;
    const strip = $('rcv-lyrics');
    if (strip) strip.hidden = true;
    const skip = $('btn-skip-song');
    if (skip) skip.hidden = true;
    if (early) song?.stop(0.4);
    roomTone?.set(0.045, 1.5);
    // Push in toward the flames for the wish.
    lockRoomOrbit();
    tweenCamera(roomShots.closeUp.pos, roomShots.closeUp.target, ms(2600), 'easeInOutSine', { unlock: false, fov: roomShots.closeUp.fov });
    later(() => enableRoomOrbit(roomShots.closeUp), ms(2600) + 50);
    phase = 'intro';
    startWish();
}

function startWish() {
    if (phase !== 'intro') return;
    phase = 'wish';
    spin.v = room ? 0 : 0.6;
    anime.remove(spin);
    anime({ targets: spin, v: 0, duration: ms(900), easing: 'easeOutQuad' });
    anime({ targets: dim, v: 1, duration: ms(900), easing: 'easeInOutQuad' });
    $('receiver-view')?.classList.add('is-dim');
    if (!room) duckMusic(0.3);
    const wish = $('rcv-wish');
    if (wish) wish.hidden = false;
    later(() => {
        const ready = $('btn-wish-ready');
        if (ready && phase === 'wish') ready.hidden = false;
    }, 1800);
    later(() => { if (phase === 'wish') startBlow(); }, WISH_AUTO_ADVANCE_MS);
}

function startBlow() {
    if (phase !== 'wish') return;
    phase = 'blow';
    $('rcv-wish').hidden = true;
    $('btn-wish-ready').hidden = true;
    anime.remove(dim);
    anime({ targets: dim, v: 0.35, duration: ms(700), easing: 'easeInOutQuad' });
    // Silence under the blowing so every puff lands.
    stopMusic(1.2);
    const blow = $('rcv-blow');
    if (blow) blow.hidden = false;
    updateBlowUi();
}

function litCount() {
    let n = 0;
    for (const c of candles) if (c.isLit) n++;
    return n;
}

function updateBlowUi() {
    const text = $('instruction-text');
    const count = $('rcv-count');
    const icon = $('rcv-pill-icon');
    if (!text) return;
    let key = 'rcvTapFlames';
    if (mic.state === 'listening' || mic.state === 'calibrating') key = 'rcvMicListening';
    else if (mic.state === 'denied') key = 'rcvMicDenied';
    text.textContent = t(key);
    if (count) count.textContent = phase === 'blow' ? t('rcvCandlesLeft', { n: litCount() }) : '';
    if (icon) icon.className = `fa-solid ${key === 'rcvMicListening' ? 'fa-microphone' : 'fa-hand-pointer'}`;

    const micBtn = $('btn-hud-mic');
    const ext = $('rcv-mic-external');
    const micLabel = $('rcv-mic-label');
    const supported = micSupported();
    if (micBtn) {
        micBtn.hidden = !supported || mic.state === 'denied' || (IS_LINE_APP && IS_IOS);
        micBtn.setAttribute('aria-pressed', mic.state === 'listening' || mic.state === 'calibrating' ? 'true' : 'false');
    }
    if (micLabel) micLabel.textContent = mic.state === 'listening' || mic.state === 'calibrating' ? t('rcvMicStop') : t('rcvMicButton');
    if (ext) {
        // LINE's iOS in-app browser cannot capture audio; LINE honours this
        // query parameter by reopening the link in the system browser.
        const showExt = IS_LINE_APP && IS_IOS;
        ext.hidden = !showExt;
        if (showExt) {
            const sep = location.search ? '&' : '?';
            ext.href = `${location.origin}${location.pathname}${location.search}${sep}openExternalBrowser=1${location.hash}`;
        }
    }
    const viz = $('mic-visualizer');
    if (viz) viz.hidden = !(mic.state === 'listening' || mic.state === 'calibrating');
}

function extinguishCandle(candle) {
    if (!candle?.isLit) return;
    if (phase === 'wish') startBlow();
    if (phase !== 'blow') return;
    candle.isLit = false;
    haptic(8);

    flameWorldPos(candle, tmpV);
    const screen = tmpV.clone().project(camera);
    playPuff(THREE.MathUtils.clamp(screen.x, -1, 1));
    emitSmoke(candle);

    // Lean away from the breath, then shrink.
    anime.remove(candle.flame.scale);
    anime.timeline({ easing: 'easeOutQuad' })
        .add({ targets: candle.flame.rotation, z: 0.45, duration: ms(110) || 1 })
        .add({ targets: candle.flame.scale, x: 0.0001, y: 0.0001, z: 0.0001, duration: ms(280) || 1, easing: 'easeInQuad' }, ms(60));
    updateBlowUi();
    if (litCount() === 0) later(startClimax, ms(450) + 50);
}

function blowNextCandle() {
    const next = candles.find((c) => c.isLit);
    if (next) extinguishCandle(next);
}

function startClimax() {
    if (phase !== 'blow') return;
    phase = 'climax';
    stopMic();
    $('rcv-blow').hidden = true;
    closeMicSheet(false);
    anime.remove(dim);
    anime({ targets: dim, v: 0.75, duration: ms(250), easing: 'easeOutQuad' });
    // Party: the room holds its breath too.
    roomTone?.set(0.0001, 0.2);
    if (room) lockRoomOrbit();

    // A beat of darkness and silence, then the payoff.
    later(() => {
        $('receiver-view')?.classList.remove('is-dim');
        anime.remove(dim);
        anime({ targets: dim, v: 0, duration: ms(900), easing: 'easeOutQuad' });
        anime.timeline()
            .add({ targets: glow, v: 1, duration: ms(450) || 1, easing: 'easeOutQuad' })
            .add({ targets: glow, v: 0.15, duration: ms(1800) || 1, easing: 'easeInOutSine' });
        playFinalPhrase();
        celebrate();
        const top = cakeGroup.localToWorld(new THREE.Vector3(0, cakeBounds.topY + 0.4, 0));
        burstSparkles(top, reduceMotion ? 20 : 110, 2.4);
        const pose = afterglowPose();
        tweenCamera(pose.pos, pose.target, ms(1800), 'easeInOutCubic', { unlock: !room, fov: pose.fov });
        if (room) {
            // Beat 14: lights snap back to full, balloons fall, everyone cheers.
            anime.remove([roomDim, exposureKick]);
            anime({ targets: roomDim, v: 0, duration: 250, easing: 'easeOutQuad' });
            exposureKick.v = reduceMotion ? 1.03 : 1.15;
            anime({ targets: exposureKick, v: 1, duration: 900, easing: 'easeOutCubic' });
            if (!reduceMotion) room.dropBalloons?.();
            if (audio) {
                cues.cheer(audio, audio.now() + 0.05, reduceMotion ? 0.5 : 1);
                if (!reduceMotion) cues.whoosh(audio, audio.now() + 0.1, 1.4, 0.08);
            }
            haptic([0, 40, 30, 40]);
            later(() => enableRoomOrbit(pose), ms(1800) + 50);
            later(() => roomTone?.set(0.035, 2), 2500);
        } else {
            anime.remove(spin);
            anime({ targets: spin, v: 0.35, duration: ms(1600), easing: 'easeInOutQuad' });
            showDecor();
        }
        later(() => {
            phase = 'message';
            tuckTitle(false);
            $('btn-hud-card').hidden = false;
            $('btn-hud-reset').hidden = false;
            openCard();
        }, ms(2300) || 400);
    }, ms(CLIMAX_SILENCE_MS));
}

function themeCssColors() {
    const cs = getComputedStyle(document.body);
    return ['--primary-color', '--secondary-color', '--accent-color']
        .map((v) => cs.getPropertyValue(v).trim())
        .filter(Boolean)
        .concat(['#ffd76a', '#ffffff']);
}

function celebrate() {
    const colors = themeCssColors();
    if (reduceMotion) {
        confetti({ particleCount: 40, spread: 70, startVelocity: 25, gravity: 1.2, ticks: 90, origin: { x: 0.5, y: 0.45 }, colors });
        return;
    }
    // One generous centred burst plus two side cannons: one payoff, not four.
    confetti({ particleCount: 110, spread: 100, startVelocity: 42, origin: { x: 0.5, y: 0.5 }, colors, scalar: 1.05 });
    later(() => {
        confetti({ particleCount: 45, angle: 60, spread: 60, origin: { x: 0, y: 0.75 }, colors });
        confetti({ particleCount: 45, angle: 120, spread: 60, origin: { x: 1, y: 0.75 }, colors });
    }, 220);
}

function replay() {
    if (!renderer || (phase !== 'message' && phase !== 'climax')) return;
    closeLetter(false);
    closeCard(false);
    clearTimers();
    hideDecor();
    if (room) {
        // "Watch the surprise again": someone switched the lights off.
        $('btn-hud-card').hidden = true;
        $('btn-hud-reset').hidden = true;
        song?.stop(0.4);
        partyLoop?.stop(0.3);
        tweenShift(0, 0, 0);
        candles.forEach((c) => { c.isLit = false; c.flame.scale.setScalar(0.0001); c.flame.rotation.z = 0; });
        if (audio) cues.switchClick(audio, audio.now() + 0.01);
        later(() => startDark({ fromReplay: true }), 120);
        return;
    }
    phase = 'intro';
    $('btn-hud-card').hidden = true;
    $('btn-hud-reset').hidden = true;
    tweenCamera(hero.pos, hero.target, ms(1200));
    anime.remove([spin, glow, dim]);
    anime({ targets: spin, v: 0.6, duration: ms(600) });
    anime({ targets: [glow, dim], v: 0, duration: ms(600) });
    candles.forEach((c) => { c.isLit = false; c.flame.scale.setScalar(0.0001); c.flame.rotation.z = 0; });
    startMusic({ level: 0.85, fadeIn: 1 });
    later(() => igniteCandles(() => later(startWish, ms(600))), ms(900));
}

/** WebGL unavailable or failed: still deliver the message. */
function startWithoutScene() {
    phase = 'message';
    leaveGate();
    startMusic({ level: 0.7, fadeIn: 1.5 });
    const hud = $('rcv-hud');
    if (hud) { hud.inert = false; hud.classList.add('is-live'); }
    const title = $('rcv-title');
    title?.classList.add('is-docked');
    const to = $('rcv-card-to');
    if (to) to.dataset.note = t('rcvNoWebGL');
    celebrate();
    openCard();
}

// ---------------------------------------------------------------------------
// Tap handling (tap on pointerup, so a rotate-drag never blows a candle)
// ---------------------------------------------------------------------------

function onPointerDown(e) {
    pointerDown.x = e.clientX;
    pointerDown.y = e.clientY;
    pointerDown.t = performance.now();
    pointerDown.id = e.pointerId;
}

function onPointerUp(e) {
    if (e.pointerId !== pointerDown.id) return;
    const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y);
    if (moved > 10 || performance.now() - pointerDown.t > 700) return;
    handleTap(e.clientX, e.clientY);
}

function setRay(x, y) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
}

function handleTap(x, y) {
    if (!renderer || !camera) return;
    setRay(x, y);

    if (phase === 'dark') {
        // The switch itself, or (after the hint escalates) anywhere low on the screen.
        if (room?.switchHit && raycaster.intersectObject(room.switchHit, true).length) flipSwitch(false);
        else if (darkLowerThird && y > window.innerHeight * 2 / 3) flipSwitch(false);
        return;
    }

    if (phase === 'blow' || phase === 'wish') {
        const hit = raycaster.intersectObjects(hitMeshes, false)[0];
        if (hit?.object.userData.candle?.isLit) {
            extinguishCandle(hit.object.userData.candle);
            return;
        }
        // A tap anywhere on the cake blows the nearest lit candle.
        if (raycaster.intersectObject(cakeGroup, true).length) {
            extinguishCandle(nearestLitCandle(x, y));
        }
        return;
    }

    if (phase !== 'message') return;
    const giftHit = gifts?.mesh.visible && raycaster.intersectObject(gifts.mesh, false)[0];
    if (giftHit && giftHit.instanceId !== undefined) {
        popGift(giftHit.instanceId, x, y);
        return;
    }
    const balloonHit = balloons?.mesh.visible && raycaster.intersectObject(balloons.mesh, false)[0];
    if (balloonHit && balloonHit.instanceId !== undefined) {
        popBalloon(balloonHit.instanceId, x, y);
        return;
    }
    const cakeHit = raycaster.intersectObject(cakeGroup, true)[0];
    if (cakeHit) {
        let obj = cakeHit.object;
        while (obj && obj !== cakeGroup) {
            if (obj.name === 'strawberry' || obj.name === 'cherry' || obj.name === 'wafer-roll') {
                bounceTopping(obj);
                return;
            }
            obj = obj.parent;
        }
    }
}

function nearestLitCandle(x, y) {
    const rect = renderer.domElement.getBoundingClientRect();
    let best = null;
    let bestD = Infinity;
    for (const c of candles) {
        if (!c.isLit) continue;
        flameWorldPos(c, tmpV).project(camera);
        const sx = rect.left + (tmpV.x + 1) / 2 * rect.width;
        const sy = rect.top + (1 - tmpV.y) / 2 * rect.height;
        const d = Math.hypot(sx - x, sy - y);
        if (d < bestD) { bestD = d; best = c; }
    }
    return best;
}

function popGift(i, x, y) {
    const g = gifts.state[i];
    if (!g || g.popped) return;
    g.popped = true;
    g.target = 0;
    playPop();
    later(() => playChime(), 90);
    burstSparkles(tmpV.copy(g.pos).setY(g.pos.y + 0.3), reduceMotion ? 8 : 26, 1.8);
    const list = t('rcvBlessings', { name: recipientName() }).split('|').filter(Boolean);
    showBubble(list[(Math.random() * list.length) | 0] || '', x, y);
}

function popBalloon(i, x, y) {
    const b = balloons.state[i];
    if (!b || b.popped) return;
    b.popped = true;
    playPop();
    if (!reduceMotion) {
        confetti({ particleCount: 24, spread: 55, startVelocity: 20, ticks: 70,
            origin: { x: x / window.innerWidth, y: y / window.innerHeight }, colors: themeCssColors() });
    }
}

function bounceTopping(obj) {
    if (obj.userData.isAnimating) return;
    obj.userData.isAnimating = true;
    const angle = Math.atan2(obj.position.z, obj.position.x);
    const freqs = [523.25, 587.33, 659.25, 698.46, 783.99, 880.0, 987.77, 1046.5];
    playChime(freqs[Math.max(0, Math.min(7, Math.floor((angle + Math.PI) / (Math.PI * 2) * 8)))]);
    burstSparkles(obj.getWorldPosition(new THREE.Vector3()), reduceMotion ? 4 : 10, 1.2);
    const s = obj.scale.clone();
    anime.timeline({ complete: () => { obj.userData.isAnimating = false; } })
        .add({ targets: obj.scale, x: s.x * 1.3, y: s.y * 0.7, z: s.z * 1.3, duration: ms(100) || 1, easing: 'easeOutQuad' })
        .add({ targets: obj.scale, x: s.x * 0.88, y: s.y * 1.2, z: s.z * 0.88, duration: ms(150) || 1, easing: 'easeOutQuad' })
        .add({ targets: obj.scale, x: s.x, y: s.y, z: s.z, duration: ms(200) || 1, easing: 'easeOutQuad' });
}

function showBubble(text, x, y) {
    const layer = $('rcv-bubbles');
    if (!layer || !text) return;
    const el = document.createElement('div');
    el.className = 'rcv-bubble';
    el.textContent = text;
    el.style.left = `${Math.min(window.innerWidth - 24, Math.max(24, x))}px`;
    el.style.top = `${y}px`;
    layer.append(el);
    setTimeout(() => el.remove(), 2600);
}

// ---------------------------------------------------------------------------
// Message card
// ---------------------------------------------------------------------------

function formatBirthDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (Number.isNaN(date.getTime())) return '';
    const lang = getCurrentLang();
    // Buddhist-era year only for Thai viewers; everyone else gets their own calendar.
    const locale = lang === 'th' ? 'th-TH-u-ca-buddhist' : lang === 'ja' ? 'ja-JP' : 'en-GB';
    try {
        return `🎂 ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(date)}`;
    } catch {
        return `🎂 ${iso}`;
    }
}

function fillCard() {
    if (!activeConfig) return;
    const name = recipientName();
    const sender = senderName();

    const to = $('rcv-card-to');
    if (to) {
        fillTemplate(to, 'rcvTo', { name });
        if (to.dataset.note) to.dataset.note = t('rcvNoWebGL');
    }
    const date = $('view-date');
    if (date) date.textContent = formatBirthDate(activeConfig.bdate);
    const title = $('view-title');
    if (title) title.textContent = (activeConfig.title || '').trim() || t('rcvDefaultTitle', { name });
    const message = $('view-message');
    if (message) message.textContent = (activeConfig.message || '').trim() || t('rcvDefaultMessage', { name });
    const sig = $('rcv-card-signature');
    if (sig) {
        if (sender) fillTemplate(sig, 'rcvSignedBy', { sender });
        else sig.textContent = t('rcvSignedAnon');
    }

    const text = $('rcv-card-text');
    if (text) {
        text.classList.remove('font-sans', 'font-serif', 'font-handwriting');
        text.classList.add(activeConfig.font === 'playfair' ? 'font-serif'
            : activeConfig.font === 'great-vibes' ? 'font-handwriting' : 'font-sans');
    }

    const photo = $('rcv-card-photo');
    if (photo) {
        if (activeConfig.photo && photo.dataset.src !== activeConfig.photo) {
            photo.dataset.src = activeConfig.photo;
            photo.hidden = true;
            photo.onload = () => { photo.hidden = false; };
            // A link that cannot be loaded simply leaves no photo, never a broken image.
            photo.onerror = () => { photo.hidden = true; };
            photo.src = activeConfig.photo;
        } else if (!activeConfig.photo) {
            photo.hidden = true;
            photo.removeAttribute('src');
            delete photo.dataset.src;
        }
        photo.alt = t('rcvTo', { name });
    }

    const letterBtn = $('btn-read-letter');
    if (letterBtn) {
        letterBtn.hidden = !(activeConfig.letterEnabled && (activeConfig.letterBody || '').trim());
        letterBtn.textContent = sender ? t('rcvReadLetter', { sender }) : t('rcvReadLetterAnon');
    }
    const thanks = $('btn-thanks');
    if (thanks) thanks.textContent = sender ? t('rcvThanks', { sender }) : t('rcvThanksAnon');
}

function openCard() {
    const card = $('rcv-card');
    if (!card) return;
    fillCard();
    focusBeforeCard = document.activeElement;
    setOpen(card, true);
    $('btn-hud-card')?.setAttribute('aria-expanded', 'true');
    card.querySelector('.rcv-card-scroll')?.scrollTo(0, 0);
    // Move focus to the heading once the sheet is on screen.
    later(() => $('view-title')?.focus({ preventScroll: true }), ms(350));
    updateCardShift(700);
}

function updateCardShift(duration) {
    if (!camera) return;
    const card = $('rcv-card');
    const wide = window.innerWidth >= 900;
    const rect = card.getBoundingClientRect();
    // Keep the cake centred in the space the card leaves free.
    if (wide) tweenShift(Math.round(rect.width / 2 + 12), 0, duration);
    else tweenShift(0, Math.round(Math.min(rect.height, window.innerHeight * 0.66) / 2), duration);
}

function closeCard(restoreFocus = true) {
    const card = $('rcv-card');
    if (!card?.classList.contains('is-open')) return;
    setOpen(card, false);
    $('btn-hud-card')?.setAttribute('aria-expanded', 'false');
    if (camera) {
        tweenShift(0, 0, 600);
        if (phase === 'message') {
            const pose = afterglowPose();
            tweenCamera(pose.pos, pose.target, ms(1000), 'easeInOutCubic', { fov: pose.fov });
        }
    }
    if (restoreFocus) {
        const back = $('btn-hud-card');
        (back && !back.hidden ? back : focusBeforeCard)?.focus?.({ preventScroll: true });
    }
}

// ---------------------------------------------------------------------------
// End actions
// ---------------------------------------------------------------------------

function sendThanks() {
    const sender = senderName();
    const text = sender ? t('rcvThanksText', { sender }) : t('rcvThanksTextAnon');
    const lineUrl = `https://line.me/R/share?text=${encodeURIComponent(text)}`;
    playChime(783.99);
    if (IS_LINE_APP) {
        window.location.href = lineUrl;
    } else if (navigator.share) {
        navigator.share({ text }).catch(() => {});
    } else {
        window.open(lineUrl, '_blank', 'noopener');
    }
}

function savePhoto() {
    if (!renderer) return;
    // preserveDrawingBuffer is off, so render and read back in the same task.
    camera.clearViewOffset();
    appliedShift = null;
    renderFrame();
    const src = renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    // Light backdrops live in CSS behind the transparent frame; paint them in.
    paintBackdrop(ctx, out.width, out.height, backdrop.name);
    ctx.drawImage(src, 0, 0);

    // Caption: the name, crisp and in a Thai-capable font.
    const caption = t('rcvHappyBirthday', { name: recipientName() });
    const size = Math.round(Math.min(out.width * 0.07, out.height * 0.055));
    ctx.font = `700 ${size}px "Noto Sans Thai", "Outfit", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (backdrop.light) {
        ctx.shadowColor = 'rgba(255,255,255,0.85)';
        ctx.shadowBlur = size * 0.35;
        ctx.fillStyle = backdrop.ink;
    } else {
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = size * 0.4;
        ctx.fillStyle = '#fff6e8';
    }
    ctx.fillText(caption, out.width / 2, out.height * 0.06, out.width * 0.92);
    ctx.shadowBlur = 0;

    const fileName = `happy-birthday-${recipientName().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 30) || 'card'}.jpg`;
    playSfxShutter();
    if (IS_IOS || IS_LINE_APP) {
        // In-app browsers and iOS ignore download links; long-press saving works everywhere.
        const img = $('rcv-photo-img');
        const preview = $('rcv-photo-preview');
        if (img && preview) {
            img.src = out.toDataURL('image/jpeg', 0.9);
            img.alt = caption;
            preview.hidden = false;
            $('btn-photo-close')?.focus();
        }
        return;
    }
    out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/jpeg', 0.92);
}

function closePhotoPreview() {
    const preview = $('rcv-photo-preview');
    if (!preview || preview.hidden) return;
    preview.hidden = true;
    $('rcv-photo-img')?.removeAttribute('src');
    $('btn-save-photo')?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Letter
// ---------------------------------------------------------------------------

const LETTER_COLORS = {
    cyber: { base: '#1a1b22', flap: '#00f2fe', seal: '#ff0055' },
    royal: { base: '#111111', flap: '#111111', seal: '#d4af37' },
    romance: { base: '#fff0f3', flap: '#fff0f3', seal: '#900c3f' },
    steampunk: { base: '#5c3d2e', flap: '#5c3d2e', seal: '#b87333' }
};

function showLetter() {
    const overlay = $('letter-popup-overlay');
    const env = $('letter-envelope-container');
    if (!overlay || !env) return;
    const theme = activeConfig.letterTheme || 'royal';
    const colors = LETTER_COLORS[theme] || LETTER_COLORS.royal;
    env.classList.remove('open');
    env.style.setProperty('--env-base-color', activeConfig.envBaseColor || colors.base);
    env.style.setProperty('--env-flap-color', activeConfig.envFlapColor || colors.flap);
    env.style.setProperty('--env-seal-color', activeConfig.envSealColor || colors.seal);
    const paper = $('letter-paper');
    if (paper) paper.className = `envelope-paper theme-${theme}`;
    const title = $('letter-popup-title');
    if (title) title.textContent = (activeConfig.letterTitle || '').trim() || t('rcvLetterDefaultTitle', { name: recipientName() });
    const body = $('letter-popup-body');
    if (body) body.textContent = '';
    const sr = $('letter-popup-sr');
    if (sr) sr.textContent = '';
    const hint = $('letter-open-hint');
    if (hint) hint.classList.add('is-visible');
    overlay.classList.add('active');
    overlay.inert = false;
    duckMusic(0.15);
    later(() => env.focus({ preventScroll: true }), ms(300));
}

function openEnvelope() {
    const env = $('letter-envelope-container');
    const body = $('letter-popup-body');
    if (!env || env.classList.contains('open')) return;
    playPaper();
    env.classList.add('open');
    $('letter-open-hint')?.classList.remove('is-visible');
    const text = activeConfig.letterBody || '';
    // The whole letter is announced at once; the typing is visual only.
    const sr = $('letter-popup-sr');
    if (sr) sr.textContent = text;
    if (!body) return;
    body.textContent = '';
    letterSegments = segmentLetter(text);
    letterIndex = 0;
    if (letterTimer) clearInterval(letterTimer);
    if (reduceMotion) {
        finishLetterTyping();
        return;
    }
    later(() => {
        letterTimer = setInterval(() => {
            if (!letterSegments || letterIndex >= letterSegments.length) {
                finishLetterTyping();
                return;
            }
            // Whitespace rides along with the next word so the pace stays even.
            let chunk = letterSegments[letterIndex++];
            while (letterIndex < letterSegments.length && !letterSegments[letterIndex].trim()) chunk += letterSegments[letterIndex++];
            body.append(chunk);
            const scroller = body.closest('.letter-body-scroll');
            if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollTop = scroller.scrollHeight;
        }, 60);
    }, 800);
}

/** Word segments (Thai has no spaces, so Intl.Segmenter finds the breaks). */
function segmentLetter(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        return Array.from(new Intl.Segmenter(getCurrentLang(), { granularity: 'word' }).segment(text), (s) => s.segment);
    }
    return text.split(/(\s+)/);
}

function finishLetterTyping() {
    if (letterTimer) clearInterval(letterTimer);
    letterTimer = 0;
    const body = $('letter-popup-body');
    if (body && activeConfig) body.textContent = activeConfig.letterBody || '';
    letterSegments = null;
}

function closeLetter(restoreFocus) {
    const overlay = $('letter-popup-overlay');
    if (!overlay?.classList.contains('active')) return;
    if (letterTimer) clearInterval(letterTimer);
    letterTimer = 0;
    overlay.classList.remove('active');
    overlay.inert = true;
    $('letter-envelope-container')?.classList.remove('open');
    $('letter-open-hint')?.classList.remove('is-visible');
    if (phase === 'message') duckMusic(0.35);
    if (restoreFocus) $('btn-read-letter')?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Audio: src/audio/ (engine with a master limiter, the song, synthesized cues)
// ---------------------------------------------------------------------------

function unlockAudio() {
    if (audio) {
        audio.resume();
        return;
    }
    audio = createAudioEngine({ muted });
    if (!audio) return;
    song = createSong(audio, melodyWave);
    roomTone = cues.createRoomTone(audio);
    partyLoop = cues.createPartyLoop(audio);
    // Recorded voices, if the owner has added them (one small JSON request).
    if (partyMode) audio.preloadClips();
}

function melodyWave() {
    const track = activeConfig?.music;
    if (track === 'happy-birthday-synth') return 'sawtooth';
    if (track === 'happy-birthday-piano') return 'sine';
    return 'triangle';
}

function startMusic(opts) {
    song?.start(opts);
}

function stopMusic(fade = 0.6) {
    song?.stop(fade);
}

function duckMusic(level) {
    song?.duck(level);
}

/** "...happy birthday to you" plus a ringing chord, then the song softly under the message. */
function playFinalPhrase() {
    if (!song) return;
    song.finalPhrase();
    later(() => {
        if (phase === 'message' || phase === 'climax') startMusic({ level: 0.35, fadeIn: 2.5, passes: 1 });
    }, 5200);
}

function playPuff(pan) { if (audio) cues.puff(audio, pan); }
function playTick(i) { if (audio) cues.tick(audio, i); }
function playPop() { if (audio) cues.pop(audio); }
function playChime(freq) { if (audio) cues.chime(audio, freq); }
function playPaper() {
    if (!audio) return;
    cues.paper(audio);
    later(() => playChime(1046.5), 120);
}
function playSfxShutter() { if (audio) cues.shutter(audio); }

function toggleMute() {
    muted = !muted;
    // Turning sound on mid-flow always fades in (1.5 s): never a loud start.
    audio?.setMuted(muted, 1.5);
    if (!muted) $('receiver-view')?.classList.remove('is-quiet');
    syncAudioButton();
}

/** The speaker always reflects the real state (v1 showed "muted" while playing). */
function syncAudioButton() {
    const btn = $('btn-hud-audio');
    if (!btn) return;
    btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    const icon = btn.querySelector('i');
    if (icon) icon.className = `fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}`;
}

// ---------------------------------------------------------------------------
// Microphone (opt-in, explained before the permission prompt)
// ---------------------------------------------------------------------------

function micSupported() {
    return !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

function onMicButton() {
    if (mic.state === 'listening' || mic.state === 'calibrating') {
        stopMic();
        updateBlowUi();
        return;
    }
    const sheet = $('rcv-mic-sheet');
    if (sheet) {
        sheet.hidden = false;
        $('btn-mic-use')?.focus();
    }
}

function closeMicSheet(restoreFocus) {
    const sheet = $('rcv-mic-sheet');
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    if (restoreFocus) $('btn-hud-mic')?.focus({ preventScroll: true });
}

async function requestMic() {
    closeMicSheet(false);
    if (!micSupported() || !audio) {
        mic.state = 'denied';
        updateBlowUi();
        return;
    }
    try {
        await audio.ctx.resume();
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
            video: false
        });
        if (phase !== 'blow') {
            stream.getTracks().forEach((tr) => tr.stop());
            return;
        }
        mic.stream = stream;
        const source = audio.ctx.createMediaStreamSource(stream);
        mic.analyser = audio.ctx.createAnalyser();
        mic.analyser.fftSize = 256;
        mic.analyser.smoothingTimeConstant = 0.5;
        source.connect(mic.analyser);
        mic.data = new Uint8Array(mic.analyser.frequencyBinCount);
        mic.samples = [];
        mic.calibrating = true;
        mic.calibT = 0;
        mic.above = 0;
        mic.cadence = 0;
        mic.state = 'calibrating';
    } catch (err) {
        console.warn('[viewer] microphone unavailable, tap mode:', err?.name || err);
        mic.state = 'denied';
    }
    updateBlowUi();
}

function stopMic() {
    mic.stream?.getTracks().forEach((tr) => tr.stop());
    mic.stream = null;
    mic.analyser = null;
    mic.data = null;
    if (mic.state !== 'denied') mic.state = 'off';
    const bar = $('mic-bar');
    if (bar) bar.style.transform = 'scaleX(0)';
}

function updateMic(dt) {
    if (!mic.analyser || phase !== 'blow') return;
    mic.analyser.getByteFrequencyData(mic.data);
    // 2.8-7.5 kHz: where breath noise lives and speech/music is weaker.
    const binHz = audio.ctx.sampleRate / mic.analyser.fftSize;
    const lo = Math.max(1, Math.floor(2800 / binHz));
    const hi = Math.min(mic.data.length - 1, Math.ceil(7500 / binHz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += mic.data[i];
    const level = sum / (hi - lo + 1);

    if (mic.calibrating) {
        mic.samples.push(level);
        mic.calibT += dt;
        if (mic.calibT >= 0.5) {
            const sorted = mic.samples.sort((a, b) => a - b);
            mic.floor = sorted[Math.floor(sorted.length * 0.8)] || 0;
            mic.calibrating = false;
            mic.state = 'listening';
            updateBlowUi();
        }
        return;
    }

    const threshold = Math.max(mic.floor + 26, 60);
    const bar = mic.bar || (mic.bar = $('mic-bar'));
    if (bar) bar.style.transform = `scaleX(${Math.min(1, level / (threshold * 1.3)).toFixed(3)})`;

    // Flames lean with the breath before they go out: feedback below threshold.
    const lean = THREE.MathUtils.clamp((level - mic.floor) / Math.max(1, threshold - mic.floor), 0, 1);
    for (const c of candles) if (c.isLit) c.flame.rotation.z = lean * 0.35 * Math.sin(elapsed * 30 + c.group.id);

    if (level > threshold) {
        mic.above += dt;
        if (mic.above >= MIC_SUSTAIN_S) {
            mic.cadence -= dt;
            if (mic.cadence <= 0) {
                blowNextCandle();
                mic.cadence = MIC_CADENCE_S;
            }
        }
    } else {
        mic.above = 0;
        mic.cadence = 0;
    }
}

// ---------------------------------------------------------------------------
// Theme colours for 3D (the CSS themes live in style.css)
// ---------------------------------------------------------------------------

function getThemeRGBColors(themeName) {
    switch (themeName) {
        case 'midnight-gold': return { tier1: 0x151310, tier2: 0x2b2214, cream: 0xffd700 };
        case 'pastel-mint': return { tier1: 0x3d8df5, tier2: 0x00d2ec, cream: 0xffffff };
        case 'lavender-dream': return { tier1: 0x22003c, tier2: 0x7000df, cream: 0xca4cff };
        case 'sakura-blossom': return { tier1: 0xffb3c6, tier2: 0xffe3ec, cream: 0xff758f };
        case 'cyber-retro': return { tier1: 0xff5e62, tier2: 0xff9966, cream: 0xff3399 };
        case 'forest-moss': return { tier1: 0x004b23, tier2: 0x38b000, cream: 0xd4af37 };
        case 'cosmic-nebula': return { tier1: 0x0f0c20, tier2: 0x00f2fe, cream: 0x00ffd5 };
        case 'choco-monarch': return { tier1: 0x241108, tier2: 0x4a2c11, cream: 0xcca43b };
        case 'neon-rose':
        default: return { tier1: 0xed004c, tier2: 0x3f0085, cream: 0xffffff };
    }
}
