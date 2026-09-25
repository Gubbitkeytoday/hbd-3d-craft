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
import { loadCardFont } from './fonts.js';

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
const SONG_LENGTH = 13.5;

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const IS_LINE_APP = /\bLine\//i.test(ua);
const IS_IOS = /iPad|iPhone|iPod/.test(ua) ||
    (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeConfig = null;
let phase = 'idle';            // idle | gate | intro | wish | blow | climax | message
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
let balloons = null;
let gifts = null;

let audio = null;
let muted = false;
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
    const raw = dict()[key] ?? translations.en[key] ?? '';
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
    reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    phase = 'gate';
    isReady = false;
    opening = false;
    muted = false;
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
    anime.remove([dim, glow, spin, shift]);
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
        clearTimeout(audio.loopTimer);
        audio.ctx.close().catch(() => {});
        audio = null;
    }

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

function disposeScene() {
    // Capture everything now; module state is reset immediately so a new
    // mount can start, while the GPU teardown may have to wait (below).
    const r = renderer;
    const sc = scene;
    const cake = cakeGroup;
    const roots = ownedRoots;
    const bloom = bloomComposer;
    const env = envMap;
    const ctl = controls;
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
    embers = smoke = sparkles = stars = balloons = gifts = null;
    appliedShift = null;

    const teardown = () => {
        if (cake) {
            sc?.remove(cake);
            disposeCakeGroup(cake, { defer: false });
        }
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
    $('btn-open-envelope')?.addEventListener('click', onOpenClick);
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
        if (phase === 'wish') { e.preventDefault(); startBlow(); }
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
    ['rcv-wish', 'rcv-blow', 'rcv-mic-sheet', 'btn-hud-card', 'btn-hud-reset', 'btn-wish-ready'].forEach((id) => {
        const el = $(id);
        if (el) el.hidden = true;
    });
    setOpen($('rcv-card'), false);
    const lang = $('lang-switcher-receiver');
    if (lang) lang.value = getCurrentLang();
    // The speaker always reflects the real state (v1 showed "muted" while playing).
    const audioBtn = $('btn-hud-audio');
    if (audioBtn) {
        audioBtn.setAttribute('aria-pressed', 'true');
        const icon = audioBtn.querySelector('i');
        if (icon) icon.className = 'fa-solid fa-volume-high';
    }
    mic.state = 'off';
    const rv = $('receiver-view');
    rv?.classList.toggle('rcv-reduce', reduceMotion);
    rv?.classList.remove('is-dim');
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
    updateOpenLabel();

    // HUD
    fillTemplate($('rcv-title'), 'rcvHappyBirthday', { name });
    setHudLabel('btn-hud-audio', 'rcv-audio-label', t('rcvMusic'));
    setHudLabel('btn-hud-card', 'rcv-card-label', t('rcvShowCard'));
    setHudLabel('btn-hud-reset', 'rcv-reset-label', t('rcvReplay'));
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
    $('rcv-replay-label') && ($('rcv-replay-label').textContent = t('rcvReplay'));
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
    label.textContent = btn.dataset.state === 'waiting' ? t('rcvPreparing') : t('rcvOpen');
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

        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        // In production three then skips the synchronous per-program status
        // query, which is exactly the call that used to block for seconds.
        renderer.debug.checkShaderErrors = import.meta.env.DEV;
        renderer.setSize(width, height);
        applyCinematicRenderer(renderer, { exposure: 1.05, maxPixelRatio: mobile ? 1.5 : 2 });
        container.appendChild(renderer.domElement);
        renderer.domElement.setAttribute('aria-hidden', 'true');
        scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x06020f, 0.015);
        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
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
        lightBase = {
            ambient: sceneLights.ambient.intensity,
            key: sceneLights.key.intensity,
            fill: sceneLights.fill.intensity,
            rim: sceneLights.rim.intensity,
            exposure: renderer.toneMappingExposure
        };
        cakeGroup = new THREE.Group();
        buildCake(mobile);
        scene.add(cakeGroup);
        await step(0.35, 'cake');

        setupCandles();
        measureCake();
        tuneMaterialsForEnvironment(cakeGroup, 0.6);
        await step(0.4, 'candles');
        setupParticles();
        setupStars();
        setupFloorGlow(theme);
        await step(0.44, 'set');
        setupDecor(theme);
        await step(0.48, 'decor');

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.06;
        controls.enablePan = false;
        controls.maxPolarAngle = Math.PI / 2 - 0.05;
        controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
        computeHero();
        camera.position.copy(hero.pos);
        controls.target.copy(hero.target);
        camera.lookAt(hero.target);
        controls.update();
        bloomComposer = createBloomComposer(renderer, scene, camera, { mobile });
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
        await step(0.98, 'warm');

        governor = createQualityGovernor({
            renderer,
            bloom: bloomComposer,
            onLevelChange: (level) => {
                decorEnabled = level < QUALITY_LEVELS.DECOR_BUDGET;
                updatePointScale();
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

function buildCake(mobile) {
    buildCakeModel(cakeGroup, {
        cakeModel: activeConfig.cakeModel || 'classic-tiered',
        plateStyle: activeConfig.plate || 'ceramic',
        glazeStyle: activeConfig.glaze || 'chocolate',
        topperStyle: activeConfig.topper || 'hbd',
        topperText: activeConfig.topperText || '',
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
    const built = buildCandles(cakeGroup, layout, { count, candleColor: activeConfig.candleColor || '' });
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
    cakeGroup.add(candleLight);
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
    embers = new PointPool(reduceMotion ? 24 : 80, { color: [1.9, 1.0, 0.35], lift: 0.3, drag: 0.5 });
    smoke = new PointPool(reduceMotion ? 40 : 110, { color: [0.72, 0.7, 0.76], opacity: 0.32, additive: false, grow: 2.4, lift: 0.18, drag: 0.9 });
    sparkles = new PointPool(reduceMotion ? 30 : 160, { color: [2.2, 1.7, 0.6], lift: -0.9, drag: 0.4 });
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

function tweenCamera(pos, target, duration, easing = 'easeInOutCubic') {
    if (!camera || !controls) return;
    anime.remove(camera.position);
    anime.remove(controls.target);
    if (!duration) {
        camera.position.copy(pos);
        controls.target.copy(target);
        return;
    }
    controls.enabled = false;
    anime({ targets: camera.position, x: pos.x, y: pos.y, z: pos.z, duration, easing });
    anime({
        targets: controls.target, x: target.x, y: target.y, z: target.z, duration, easing,
        complete: () => { if (controls) controls.enabled = true; }
    });
}

/** The framing used after the climax: slightly back and up so smoking wicks stay in view. */
function afterglowPose() {
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
    if (wasHero && !anime.running.length) {
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

    if (cakeGroup && !reduceMotion) cakeGroup.rotation.y += dt * 0.12 * spin.v;
    if (stars && !reduceMotion) stars.rotation.y += dt * 0.01;
    controls.update();
    if (flameMaterial?.uniforms?.uTime) flameMaterial.uniforms.uTime.value = elapsed;

    applyLights(dt);
    spawnEmbers(dt);
    embers?.update(dt);
    smoke?.update(dt);
    sparkles?.update(dt);
    updateDecor(dt);
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
    // dim: the wish beat (flames stay bright, the room falls away).
    // glow: the warm bloom at the climax.
    const k = 1 - 0.55 * dim.v + 0.6 * glow.v;
    sceneLights.key.intensity = lightBase.key * k;
    sceneLights.fill.intensity = lightBase.fill * k;
    sceneLights.ambient.intensity = lightBase.ambient * (1 - 0.5 * dim.v + 0.8 * glow.v);
    sceneLights.rim.intensity = lightBase.rim * (1 - 0.3 * dim.v);
    renderer.toneMappingExposure = lightBase.exposure * (1 - 0.18 * dim.v + 0.12 * glow.v);

    if (candleLight) {
        let lit = 0;
        for (const c of candles) if (c.isLit) lit++;
        const target = lit * CANDLE_LIGHT_PER_FLAME;
        candleLightLevel += (target - candleLightLevel) * Math.min(1, dt * 6);
        candleLight.intensity = candleLightLevel *
            (0.9 + Math.sin(elapsed * 13.0) * 0.06 + Math.sin(elapsed * 29.0 + 1.3) * 0.04);
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

function onOpenClick() {
    if (phase !== 'gate' || opening) return;
    opening = true;
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
    candles.forEach((c, i) => {
        later(() => {
            c.isLit = true;
            anime.remove(c.flame.scale);
            c.flame.rotation.z = 0;
            anime({ targets: c.flame.scale, x: 1, y: 1, z: 1, duration: ms(420) || 1, easing: 'easeOutBack' });
            playTick(i);
        }, i * stagger);
    });
    later(done, candles.length * stagger + ms(300));
}

function startWish() {
    if (phase !== 'intro') return;
    phase = 'wish';
    spin.v = 0.6;
    anime.remove(spin);
    anime({ targets: spin, v: 0, duration: ms(900), easing: 'easeOutQuad' });
    anime({ targets: dim, v: 1, duration: ms(900), easing: 'easeInOutQuad' });
    $('receiver-view')?.classList.add('is-dim');
    duckMusic(0.3);
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
        const top = new THREE.Vector3(0, cakeBounds.topY + 0.4, 0);
        burstSparkles(top, reduceMotion ? 20 : 110, 2.4);
        const pose = afterglowPose();
        tweenCamera(pose.pos, pose.target, ms(1800));
        anime.remove(spin);
        anime({ targets: spin, v: 0.35, duration: ms(1600), easing: 'easeInOutQuad' });
        showDecor();
        later(() => {
            phase = 'message';
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
            tweenCamera(pose.pos, pose.target, ms(1000));
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
    ctx.drawImage(src, 0, 0);

    // Caption: the name, crisp and in a Thai-capable font.
    const caption = t('rcvHappyBirthday', { name: recipientName() });
    const size = Math.round(Math.min(out.width * 0.07, out.height * 0.055));
    ctx.font = `700 ${size}px "Noto Sans Thai", "Outfit", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = size * 0.4;
    ctx.fillStyle = '#fff6e8';
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
// Audio: one master bus (compressor + light reverb), lookahead scheduling
// ---------------------------------------------------------------------------

function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (audio) {
        audio.ctx.resume().catch(() => {});
        return;
    }
    try {
        // Safari 16.4+: play through the ring/silent switch like a video would.
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* not supported */ }
    try {
        const ctx = new AC();
        ctx.resume?.().catch(() => {});
        // A one-sample silent buffer started inside the gesture unlocks WebKit.
        const silent = ctx.createBufferSource();
        silent.buffer = ctx.createBuffer(1, 1, 22050);
        silent.connect(ctx.destination);
        silent.start(0);

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 24;
        comp.ratio.value = 6;
        comp.attack.value = 0.004;
        comp.release.value = 0.25;
        comp.connect(ctx.destination);
        const master = ctx.createGain();
        master.gain.value = muted ? 0 : 1;
        master.connect(comp);
        const music = ctx.createGain();
        music.gain.value = 0;
        music.connect(master);
        const sfx = ctx.createGain();
        sfx.gain.value = 0.9;
        sfx.connect(master);
        const reverb = ctx.createConvolver();
        reverb.buffer = makeImpulse(ctx, 1.6);
        const wet = ctx.createGain();
        wet.gain.value = 0.22;
        reverb.connect(wet);
        wet.connect(master);
        audio = { ctx, master, music, sfx, reverb, voices: new Set(), loopTimer: 0, nextLoopAt: 0, loopsLeft: 0, level: 0.85 };
    } catch (err) {
        console.warn('[viewer] Web Audio unavailable:', err);
        audio = null;
    }
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

const NOTE = {
    C2: 65.41, F2: 87.31, G2: 98.0, C3: 130.81, F3: 174.61, G3: 196.0, A3: 220.0,
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
    C6: 1046.5, E6: 1318.5, G6: 1568.0
};
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

function melodyWave() {
    const track = activeConfig?.music;
    if (track === 'happy-birthday-synth') return 'sawtooth';
    if (track === 'happy-birthday-piano') return 'sine';
    return 'triangle';
}

function voice(freq, dur, at, kind, dest) {
    if (!audio || !freq) return;
    const { ctx } = audio;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    let peak = 0.16;
    let attack = 0.02;
    let tail = 0.18;
    if (kind === 'melody') {
        osc.type = melodyWave();
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
    if (kind === 'melody' || kind === 'chord' || kind === 'shimmer') gain.connect(audio.reverb);
    osc.start(at);
    osc.stop(at + dur + tail + 0.05);
    audio.voices.add(osc);
    osc.onended = () => audio?.voices.delete(osc);
}

function schedulePass(start) {
    MELODY.forEach(([n, d, o]) => voice(NOTE[n], d, start + o, 'melody', audio.music));
    HARMONY.forEach(([n, d, o]) => voice(NOTE[n], d, start + o, 'harmony', audio.music));
    BASS.forEach(([n, d, o]) => voice(NOTE[n], d, start + o, 'bass', audio.music));
}

function pumpMusic() {
    if (!audio) return;
    clearTimeout(audio.loopTimer);
    // Schedule against the audio clock; setInterval drifted and stacked when
    // the tab was throttled.
    while (audio.loopsLeft > 0 && audio.nextLoopAt - audio.ctx.currentTime < 2.5) {
        schedulePass(audio.nextLoopAt);
        audio.nextLoopAt += SONG_LENGTH;
        audio.loopsLeft--;
    }
    if (audio.loopsLeft > 0) audio.loopTimer = setTimeout(pumpMusic, 1000);
}

function startMusic({ level = 0.85, fadeIn = 1.5, passes = Infinity, delay = 0.05 } = {}) {
    if (!audio) return;
    stopMusic(0);
    const now = audio.ctx.currentTime;
    const g = audio.music.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(level, now + delay + fadeIn);
    audio.level = level;
    audio.nextLoopAt = now + delay;
    audio.loopsLeft = passes;
    pumpMusic();
}

function stopMusic(fade = 0.6) {
    if (!audio) return;
    clearTimeout(audio.loopTimer);
    audio.loopsLeft = 0;
    const now = audio.ctx.currentTime;
    const g = audio.music.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.0001, now + Math.max(0.02, fade));
    const stopAt = now + Math.max(0.03, fade);
    audio.voices.forEach((osc) => { try { osc.stop(stopAt); } catch { /* already stopped */ } });
}

function duckMusic(level) {
    if (!audio) return;
    const now = audio.ctx.currentTime;
    const g = audio.music.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(level, now, 0.35);
}

/** "...happy birthday to you" plus a ringing major chord, instead of cutting the song. */
function playFinalPhrase() {
    if (!audio) return;
    stopMusic(0.02);
    const { ctx } = audio;
    const t0 = ctx.currentTime + 0.06;
    const g = audio.music.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.9, t0);
    MELODY.filter(([, , o]) => o >= 9.7).forEach(([n, d, o]) => voice(NOTE[n], d, t0 + o - 9.7, 'melody', audio.music));
    BASS.filter(([, , o]) => o >= 9.7).forEach(([n, d, o]) => voice(NOTE[n], d, t0 + o - 9.7, 'bass', audio.music));
    const ring = t0 + 2.1;
    ['C4', 'E4', 'G4', 'C5'].forEach((n) => voice(NOTE[n], 2.6, ring, 'chord', audio.music));
    ['C6', 'E6', 'G6'].forEach((n, i) => voice(NOTE[n], 0.25, ring + 0.08 * i, 'shimmer', audio.music));
    // Then the song once more, softly, under the message.
    later(() => {
        if (phase === 'message' || phase === 'climax') startMusic({ level: 0.35, fadeIn: 2.5, passes: 1 });
    }, 5200);
}

function sfxNode(pan = 0) {
    const { ctx } = audio;
    const gain = ctx.createGain();
    if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan * 0.8;
        gain.connect(p);
        p.connect(audio.sfx);
    } else {
        gain.connect(audio.sfx);
    }
    return gain;
}

function noiseBuffer(seconds) {
    const { ctx } = audio;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
}

function playPuff(pan) {
    if (!audio) return;
    const { ctx } = audio;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.35);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1400, now);
    bp.frequency.exponentialRampToValueAtTime(500, now + 0.3);
    bp.Q.value = 0.9;
    const out = sfxNode(pan);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(0.5, now + 0.02);
    out.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    src.connect(bp);
    bp.connect(out);
    src.start(now);
    src.stop(now + 0.35);
}

function playTick(i) {
    if (!audio) return;
    const { ctx } = audio;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880 * Math.pow(2, i / 12), now);
    const out = sfxNode(0);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(0.08, now + 0.01);
    out.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(out);
    osc.start(now);
    osc.stop(now + 0.3);
}

function playPop() {
    if (!audio) return;
    const { ctx } = audio;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.12);
    const out = sfxNode(0);
    out.gain.setValueAtTime(0.4, now);
    out.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(out);
    osc.start(now);
    osc.stop(now + 0.15);
}

function playChime(freq) {
    if (!audio) return;
    const { ctx } = audio;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq || [523.25, 659.25, 783.99, 1046.5][(Math.random() * 4) | 0], now);
    const out = sfxNode(0);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(0.18, now + 0.015);
    out.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
    osc.connect(out);
    out.connect(audio.reverb);
    osc.start(now);
    osc.stop(now + 1.15);
}

function playPaper() {
    if (!audio) return;
    const { ctx } = audio;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.45);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(700, now);
    bp.frequency.exponentialRampToValueAtTime(1600, now + 0.4);
    bp.Q.value = 2.5;
    const out = sfxNode(0);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(0.22, now + 0.04);
    out.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    src.connect(bp);
    bp.connect(out);
    src.start(now);
    src.stop(now + 0.45);
    later(() => playChime(1046.5), 120);
}

function playSfxShutter() {
    if (!audio) return;
    const { ctx } = audio;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.08);
    const out = sfxNode(0);
    out.gain.setValueAtTime(0.25, now);
    out.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    src.connect(out);
    src.start(now);
}

function toggleMute() {
    muted = !muted;
    if (audio) {
        const now = audio.ctx.currentTime;
        audio.master.gain.cancelScheduledValues(now);
        audio.master.gain.setTargetAtTime(muted ? 0 : 1, now, 0.08);
    }
    const btn = $('btn-hud-audio');
    if (btn) {
        btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
        const icon = btn.querySelector('i');
        if (icon) icon.className = `fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}`;
    }
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
