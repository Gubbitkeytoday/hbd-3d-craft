/**
 * The creator's live 3D preview: renderer, scene, render loop and the
 * build -> precompile -> swap pipeline. It knows nothing about the form; the
 * UI (creator.js) hands it plain card configs.
 *
 * Why the pipeline is shaped this way (see review-performance.md):
 *  - The first frame used to link ~35 programs synchronously (6 s freeze).
 *    The scene is now precompiled with KHR_parallel_shader_compile before the
 *    loop starts, behind a visible loader.
 *  - Every change used to dispose the old cake first, which released its GL
 *    programs, so the identical new materials recompiled from scratch. Now
 *    the new cake is built off-scene, precompiled while the old one stays on
 *    screen, then swapped in and only then is the old one disposed.
 *  - Bursts of changes (a held stepper, typing in the topper field) coalesce:
 *    at most one build runs and one more is queued with the latest config.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
    applyCinematicRenderer,
    attachStudioEnvironmentAsync,
    setupStudioLighting,
    tuneMaterialsForEnvironment,
    createBloomComposer,
    isMobileViewport,
    tintRimLight,
    precompileScene
} from './render-quality.js';
import {
    buildCakeModel,
    createHolographicScannerTexture,
    disposeCakeGroup,
    sharedTexture
} from './cake-models.js';
import { buildCandles } from './cake/candles.js';
import { applyBackdrop, createContactShadow, fitContactShadow, NEW_CARD_BACKDROP, resolveBackdrop } from './backdrops.js';

const SCENE_BG = 0x0b0714;
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let lights = null;
let bloom = null;
let container = null;
let animationId = null;
let resizeObserver = null;
let visibilityObserver = null;
let visible = true;
let lastInteraction = 0;
let frameCounter = 0;

// Current scene content (swapped atomically by the build pipeline).
let cakeRoot = null;      // rotates and bobs
let extrasRoot = null;    // envelope, pointer, label, floating ornaments
let flameMaterial = null;
let floatingSprinkles = [];
let envelopeRefs = { envelope: null, pointer: null, label: null };
let holographicRings = [];
let contactShadow = null;
let bounceLight = null;

// Build pipeline state. `generation` invalidates in-flight work on destroy.
let generation = 0;
let pendingConfig = null;
let building = false;
let ready = false;
let callbacks = {};

/**
 * Hands the main thread back to the browser (input, paint) between heavy
 * setup steps so no single task blocks for long. scheduler.yield keeps our
 * continuation at the front of the queue where supported.
 */
function yieldToMain() {
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * precompileScene() with the render target the scene is really drawn into.
 * RenderPass draws into the composer's buffer, and three keys programs on
 * the target (a render target gets no tone mapping and linear output), so
 * compiling against the canvas produced a different set of programs and the
 * first frame recompiled ~27 of them synchronously (3.5 s). three's
 * compile() runs synchronously inside precompileScene before its first
 * await, so the target only needs to be set around the call.
 */
function precompileForComposer(root, opts) {
    const previous = renderer.getRenderTarget();
    if (bloom) renderer.setRenderTarget(bloom.composer.readBuffer);
    const done = precompileScene(renderer, root, camera, opts);
    renderer.setRenderTarget(previous);
    return done;
}

/** Themes -> cake tier/accent colors (shared with the viewer's palette). */
export function getThemeRGBColors(themeName) {
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

/** True when this browser can create a WebGL context at all. */
let webglSupport = null;
export function hasWebGL() {
    if (webglSupport !== null) return webglSupport;
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        webglSupport = !!gl;
        // Release the probe right away; browsers cap live contexts at ~16.
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
        webglSupport = false;
    }
    return webglSupport;
}

/**
 * Creates the renderer and scene, builds the first cake, precompiles every
 * program off the main thread, then starts the loop.
 *
 * @param {HTMLElement} host
 * @param {object} config  card config (full key names)
 * @param {object} cbs     { onReady(), onError(err), onBusy(isBusy), labelText }
 */
export async function mountPreview(host, config, cbs = {}) {
    const myGeneration = ++generation;
    container = host;
    callbacks = cbs;

    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight || 320);

    try {
        // alpha: light backdrops are painted by CSS behind a transparent frame
        // (see backdrops.js); night still clears to an opaque colour.
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
        renderer = null;
        cbs.onError?.(err);
        return;
    }
    renderer.setSize(width, height);
    applyCinematicRenderer(renderer, { exposure: 0.98, maxPixelRatio: isMobileViewport() ? 1.5 : 2.0 });
    renderer.domElement.classList.add('cr-gl');
    host.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    // Night: the composer outputs an opaque frame, so the studio backdrop is
    // set explicitly (applyBackdrop restores it). Light backdrops clear to
    // transparent and the canvas paints the gradient behind the frame.
    scene.background = new THREE.Color(SCENE_BG);
    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 4.0, 9.5);
    camera.lookAt(0, 0.4, 0);

    setupControls();

    // Setup is split into steps with yields in between, so the form stays
    // responsive while the preview boots (Lighthouse TBT on the creator).
    await yieldToMain();
    if (myGeneration !== generation) return;
    await attachStudioEnvironmentAsync(renderer, scene);
    if (myGeneration !== generation) return;
    lights = setupStudioLighting(scene, { rimColor: 0xff0055 });
    bounceLight = new THREE.PointLight(0xff0055, 0.9, 10);
    bounceLight.position.set(0, 2, 0);
    scene.add(bounceLight);
    setupHolographicRings();
    contactShadow = createContactShadow();
    scene.add(contactShadow);
    bloom = createBloomComposer(renderer, scene, camera);
    applySceneBackdrop(config);

    await yieldToMain();
    if (myGeneration !== generation) return;
    const built = await buildContent(config, true);
    if (myGeneration !== generation) return;
    swapIn(built, config);
    // Every program (scene + bloom passes) compiles in parallel off the main
    // thread; the first rendered frame then only uploads uniforms.
    await precompileForComposer(scene, { bloom });
    if (myGeneration !== generation) return;

    if (import.meta.env.DEV) {
        window.__hbdPreview = { scene, camera, renderer, bloom };
    }

    visible = true;
    if ('IntersectionObserver' in window) {
        visibilityObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
        visibilityObserver.observe(host);
    }
    if ('ResizeObserver' in window) {
        let queued = false;
        resizeObserver = new ResizeObserver(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; resize(); });
        });
        resizeObserver.observe(host);
    }
    window.addEventListener('resize', resize);

    lastInteraction = performance.now();
    ready = true;
    startLoop();
    cbs.onReady?.();

    // A change made while the first compile ran is applied now.
    if (pendingConfig) runBuilds();
}

function setupControls() {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0.4, 0);
    controls.minDistance = 4.0;
    controls.maxDistance = 20.0;
    controls.maxPolarAngle = Math.PI / 2 + 0.1;
    // The preview sits inside a scrolling page: the wheel must scroll the
    // page, not silently zoom the cake out of frame.
    controls.enableZoom = false;
    controls.enablePan = false;
    // OrbitControls sets touch-action:none, which swallowed every vertical
    // swipe that started on the canvas. pan-y hands vertical swipes back to
    // the page; horizontal drags still reach the controls and spin the cake.
    renderer.domElement.style.touchAction = 'pan-y';
    if (window.matchMedia('(pointer: coarse)').matches) {
        // A finger drag is almost never meant to tilt; lock the polar angle
        // so touch rotation is a clean turntable spin.
        controls.update(); // getPolarAngle() is only valid after an update
        const polar = controls.getPolarAngle();
        controls.minPolarAngle = polar;
        controls.maxPolarAngle = polar;
    }
    renderer.domElement.addEventListener('pointerdown', () => {
        noteInteraction();
        callbacks.onDrag?.();
    });
}

/** Keeps the loop at full rate for a while (idle previews drop to ~half rate). */
export function noteInteraction() {
    lastInteraction = performance.now();
}

/**
 * Queues a rebuild with the latest config. Calls made while a build is in
 * flight collapse into one follow-up build.
 */
export function updatePreview(config) {
    pendingConfig = config;
    noteInteraction();
    if (!ready || building) return;
    runBuilds();
}

async function runBuilds() {
    building = true;
    const myGeneration = generation;
    let busyTimer = setTimeout(() => callbacks.onBusy?.(true), 180);
    try {
        while (pendingConfig && myGeneration === generation) {
            // One build per frame at most, with whatever arrived last.
            await new Promise(r => requestAnimationFrame(r));
            if (myGeneration !== generation) return;
            const config = pendingConfig;
            pendingConfig = null;

            const built = await buildContent(config, true);
            if (myGeneration !== generation) return;
            const staging = new THREE.Group();
            staging.add(built.cake, built.extras);
            await precompileForComposer(staging, { targetScene: scene });
            if (myGeneration !== generation) {
                disposeCakeGroup(staging, { defer: false });
                return;
            }
            swapIn(built, config);
        }
    } finally {
        clearTimeout(busyTimer);
        busyTimer = 0;
        building = false;
        if (myGeneration === generation) callbacks.onBusy?.(false);
    }
}

function backdropOf(config) {
    // The creator always sends one; a missing value previews a new card.
    return config.backdrop || NEW_CARD_BACKDROP;
}

/** Backdrop state for the live scene (cheap, idempotent; see backdrops.js). */
function applySceneBackdrop(config) {
    if (!scene || !renderer) return null;
    const applied = applyBackdrop(scene, renderer, bloom, lights, backdropOf(config), {
        nightBackground: SCENE_BG,
        contactShadow,
        nightOnly: holographicRings,
        paintHost: renderer.domElement
    });
    // The magenta bounce reads as neon spill on pale paper; keep a hint.
    if (bounceLight) bounceLight.intensity = applied.light ? 0.35 : 0.9;
    return applied;
}

/** Builds a complete cake + extras off-scene (nothing touches the live scene). */
async function buildContent(config, cooperative = false) {
    const look = resolveBackdrop(backdropOf(config));
    const cake = new THREE.Group();
    cake.name = 'cake-root';
    const extras = new THREE.Group();
    extras.name = 'extras-root';

    const { candlePlacerRadius, candleBaseY, isHeartShape } = buildCakeModel(cake, {
        cakeModel: config.cakeModel,
        plateStyle: config.plate,
        glazeStyle: config.glaze,
        topperStyle: config.topper,
        topperText: config.topperText,
        themeName: config.theme,
        themeColors: getThemeRGBColors(config.theme),
        strawberries: config.strawberries,
        cherries: config.cherries,
        rolls: config.rolls,
        sprinkles: config.sprinkles,
        glazeColor: config.glazeColor,
        creamColor: config.creamColor,
        plateColor: config.plateColor,
        topperColor: config.topperColor,
        detail: isMobileViewport() ? 0.6 : 1
    });

    if (cooperative) await yieldToMain();
    const candles = buildCandles(cake, { candlePlacerRadius, candleBaseY, isHeartShape }, {
        count: config.candles,
        candleColor: config.candleColor,
        look: look.light ? 'light' : 'dark'
    });

    // Environment reflections are a plain uniform; set before precompile.
    // Light backdrops get a little more: the room reflections read as the
    // bright studio the cake now stands in.
    tuneMaterialsForEnvironment(cake, look.light ? 0.85 : 0.6);

    // Footprint for the contact shadow, measured before the swap adds bob.
    cake.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(cake);
    const footprint = {
        radius: Math.max(Math.abs(box.min.x), box.max.x, Math.abs(box.min.z), box.max.z),
        floorY: box.min.y
    };

    if (cooperative) await yieldToMain();

    const envelope = config.letterEnabled ? buildEnvelopeGroup(config, extras) : { envelope: null, pointer: null, label: null };
    const sprinkles = buildFloatingSprinkles(extras, config);

    return { cake, extras, flameMaterial: candles.flameMaterial, envelope, sprinkles, footprint };
}

/** Puts freshly built content on screen and frees what it replaces. */
function swapIn(built, config) {
    const oldCake = cakeRoot;
    const oldExtras = extrasRoot;

    // Keep the turntable angle continuous across the swap.
    if (oldCake) {
        built.cake.rotation.copy(oldCake.rotation);
        built.cake.position.copy(oldCake.position);
    }
    scene.add(built.cake);
    scene.add(built.extras);
    cakeRoot = built.cake;
    extrasRoot = built.extras;
    flameMaterial = built.flameMaterial;
    envelopeRefs = built.envelope;
    floatingSprinkles = built.sprinkles;

    if (oldCake) {
        scene.remove(oldCake);
        disposeCakeGroup(oldCake);
    }
    if (oldExtras) {
        scene.remove(oldExtras);
        disposeCakeGroup(oldExtras);
    }

    // Rim light follows the theme accent so the silhouette always reads;
    // the backdrop then scales it (and everything else) for its paper.
    if (lights) tintRimLight(lights.rim, getThemeRGBColors(config.theme).cream);
    const { radius, floorY } = built.footprint;
    if (contactShadow && Number.isFinite(radius) && Number.isFinite(floorY)) fitContactShadow(contactShadow, radius, floorY);
    applySceneBackdrop(config);
}

function startLoop() {
    const clock = new THREE.Clock();
    const animate = () => {
        animationId = requestAnimationFrame(animate);

        // Nothing to draw while scrolled away or the tab is hidden.
        if (!visible || document.hidden) {
            clock.getDelta();
            return;
        }
        // Idle for a while: draw every other frame. A slowly turning cake
        // does not need 144 Hz, and laptops stay quiet.
        frameCounter++;
        const idle = performance.now() - lastInteraction > 2500;
        if (idle && frameCounter % 2 === 1) return;

        // getDelta() must come first: getElapsedTime() advances the clock
        // itself, which would leave delta at ~0.
        const delta = clock.getDelta();
        const elapsed = clock.elapsedTime;
        const still = reducedMotionQuery.matches;

        controls?.update();

        if (cakeRoot) {
            cakeRoot.rotation.y = still ? 0.5 : elapsed * 0.18;
            cakeRoot.position.y = still ? 0 : Math.sin(elapsed * 1.5) * 0.08;
        }
        if (flameMaterial) flameMaterial.uniforms.uTime.value = elapsed;

        if (!still) {
            if (holographicRings.length >= 2) {
                holographicRings[0].rotation.z += delta * 0.25;
                holographicRings[1].rotation.z -= delta * 0.38;
            }
            for (const s of floatingSprinkles) {
                s.angle += s.orbitSpeed * delta;
                s.mesh.position.x = Math.cos(s.angle) * s.radius;
                s.mesh.position.z = Math.sin(s.angle) * s.radius;
                s.mesh.position.y = s.baseY + Math.sin(elapsed * s.bobSpeed + s.bobOffset) * 0.15;
                s.mesh.rotation.x += s.rotSpeed.x * delta;
                s.mesh.rotation.y += s.rotSpeed.y * delta;
                s.mesh.rotation.z += s.rotSpeed.z * delta;
            }
            const { envelope, pointer, label } = envelopeRefs;
            if (envelope) {
                envelope.position.y = 1.6 + Math.sin(elapsed * 1.2) * 0.05;
                envelope.rotation.y = Math.PI / 4 + Math.cos(elapsed * 0.8) * 0.05;
            }
            if (pointer) {
                pointer.position.y = 2.2 + Math.sin(elapsed * 3.0) * 0.1;
                pointer.rotation.y = elapsed * 2.0;
            }
            if (label) {
                const pulse = 1.0 + Math.sin(elapsed * 2.5) * 0.05;
                label.scale.set(1.8 * pulse, 0.45 * pulse, 1.0);
            }
        }

        if (bloom) bloom.composer.render(delta);
        else renderer.render(scene, camera);
    };
    animate();
}

function resize() {
    if (!container || !camera || !renderer) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight || 320);
    const current = renderer.getSize(new THREE.Vector2());
    if (current.x === width && current.y === height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    bloom?.setSize(width, height);
}

/** Tears everything down and releases the WebGL context. */
export function destroyPreview() {
    generation++;
    pendingConfig = null;
    building = false;
    ready = false;
    window.removeEventListener('resize', resize);
    resizeObserver?.disconnect();
    resizeObserver = null;
    visibilityObserver?.disconnect();
    visibilityObserver = null;
    if (animationId) cancelAnimationFrame(animationId);
    animationId = null;

    if (renderer) {
        // Full dispose, shared kit materials included: each material keeps a
        // 'dispose' listener that references this renderer, so skipping them
        // would pin the dead renderer in memory. The kit re-creates GPU state
        // on the next renderer (the receiver's or a later creator mount).
        const materials = new Set();
        scene?.traverse((obj) => {
            if (obj.geometry && !obj.isSprite) obj.geometry.dispose();
            if (obj.isInstancedMesh) obj.dispose();
            const list = Array.isArray(obj.material) ? obj.material : [obj.material];
            list.forEach((m) => { if (m) materials.add(m); });
        });
        materials.forEach((m) => {
            Object.values(m).forEach((v) => { if (v?.isTexture) v.dispose(); });
            m.dispose();
        });
        scene?.environment?.dispose();
        if (bloom) {
            bloom.composer.dispose();
            bloom.bloom?.dispose();
        }
        controls?.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
    }
    if (import.meta.env.DEV && window.__hbdPreview?.renderer === renderer) delete window.__hbdPreview;

    renderer = scene = camera = controls = lights = bloom = null;
    contactShadow = bounceLight = null;
    cakeRoot = extrasRoot = flameMaterial = null;
    floatingSprinkles = [];
    holographicRings = [];
    envelopeRefs = { envelope: null, pointer: null, label: null };
    container = null;
    callbacks = {};
}

/* ------------------------------------------------------------------ *
 * Scene pieces
 * ------------------------------------------------------------------ */

function setupHolographicRings() {
    holographicRings = [];
    const ringGeo = new THREE.PlaneGeometry(6, 6);
    const make = (color, opacity, y) => {
        const mat = new THREE.MeshBasicMaterial({
            map: createHolographicScannerTexture(color),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            opacity
        });
        const ring = new THREE.Mesh(ringGeo, mat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = y;
        scene.add(ring);
        holographicRings.push(ring);
    };
    make('#00f2fe', 0.8, -1.14);
    make('#ff0055', 0.6, -1.13);
}

function paintPaperTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(256, 256);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
        const v = 128 + (Math.random() - 0.5) * 12;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // A few paper fibres, light and dark.
    for (const stroke of ['rgba(255,255,255,0.08)', 'rgba(0,0,0,0.08)']) {
        ctx.strokeStyle = stroke;
        for (let i = 0; i < 50; i++) {
            const sx = Math.random() * 256;
            const sy = Math.random() * 256;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.bezierCurveTo(sx + (Math.random() - 0.5) * 10, sy + (Math.random() - 0.5) * 10,
                sx + (Math.random() - 0.5) * 10, sy + (Math.random() - 0.5) * 10,
                sx + (Math.random() - 0.5) * 15, sy + (Math.random() - 0.5) * 15);
            ctx.stroke();
        }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 3);
    return texture;
}

function paintLabelTexture(text, colorStr) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(8, 4, 16, 0.9)';
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = 6;
    const r = 20;
    ctx.beginPath();
    ctx.moveTo(3 + r, 3);
    ctx.arcTo(509, 3, 509, 125, r);
    ctx.arcTo(509, 125, 3, 125, r);
    ctx.arcTo(3, 125, 3, 3, r);
    ctx.arcTo(3, 3, 509, 3, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const cleanText = text.replace(/✉️?/gu, '').trim();
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 28px "Outfit", "Noto Sans Thai", sans-serif';
    const textWidth = Math.min(ctx.measureText(cleanText).width, 400);
    const iconWidth = 36;
    const spacing = 12;
    const startX = (512 - (textWidth + spacing + iconWidth)) / 2;
    ctx.fillText(cleanText, startX, 64, 400);

    // Envelope glyph drawn as vectors (emoji rendering varies by platform).
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = 3.5;
    ctx.shadowBlur = 8;
    const ex = startX + textWidth + spacing;
    ctx.strokeRect(ex, 52, iconWidth, 24);
    ctx.beginPath();
    ctx.moveTo(ex, 52);
    ctx.lineTo(ex + iconWidth / 2, 66);
    ctx.lineTo(ex + iconWidth, 52);
    ctx.stroke();
    return new THREE.CanvasTexture(canvas);
}

const ENVELOPE_COLORS = {
    cyber: { base: 0x1a1b22, flap: 0x00f2fe, seal: 0xff0055, pointer: 0x00f2fe },
    royal: { base: 0x111111, flap: 0x111111, seal: 0xd4af37, pointer: 0xffd700 },
    romance: { base: 0xfff0f3, flap: 0xfff0f3, seal: 0x900c3f, pointer: 0xff3377 },
    steampunk: { base: 0x5c3d2e, flap: 0x5c3d2e, seal: 0xb87333, pointer: 0xb87333 }
};

function buildEnvelopeGroup(config, parent) {
    const palette = ENVELOPE_COLORS[config.letterTheme] || ENVELOPE_COLORS.royal;
    const envelope = create3DEnvelopeMesh(config.letterTheme, palette, config);
    envelope.scale.setScalar(1.6);
    envelope.position.set(-2.8, 1.6, -1.8);
    envelope.rotation.y = Math.PI / 4;
    parent.add(envelope);

    const pointerGeo = new THREE.ConeGeometry(0.18, 0.45, 4);
    pointerGeo.rotateX(Math.PI);
    const pointerColor = config.envFlapColor ? new THREE.Color(config.envFlapColor) : palette.pointer;
    const pointer = new THREE.Mesh(pointerGeo, new THREE.MeshBasicMaterial({ color: pointerColor, wireframe: true }));
    pointer.position.set(-2.8, 2.4, -1.8);
    parent.add(pointer);

    const labelColor = config.envFlapColor || '#00f2fe';
    const text = callbacks.labelText?.() || '';
    const map = sharedTexture(`creator-env-label|${text}|${labelColor}`, () => paintLabelTexture(text, labelColor));
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
    label.scale.set(1.8, 0.45, 1.0);
    label.position.set(-2.8, 2.8, -1.8);
    parent.add(label);

    return { envelope, pointer, label };
}

function create3DEnvelopeMesh(letterTheme, palette, config) {
    const group = new THREE.Group();
    group.name = 'envelope-group';

    const baseColor = config.envBaseColor ? new THREE.Color(config.envBaseColor) : palette.base;
    const flapColor = config.envFlapColor ? new THREE.Color(config.envFlapColor) : palette.flap;
    const sealColor = config.envSealColor ? new THREE.Color(config.envSealColor) : palette.seal;

    // Deterministic noise: painted once and shared across rebuilds.
    const paperBumpMap = sharedTexture('creator-paper-bump', paintPaperTexture);

    const paper = (color) => new THREE.MeshPhysicalMaterial({
        color, roughness: 0.9, metalness: 0.0, clearcoat: 0.0, bumpMap: paperBumpMap, bumpScale: 0.008
    });
    const baseMat = paper(baseColor);
    const flapMat = paper(flapColor);
    const sealMat = new THREE.MeshPhysicalMaterial({
        color: sealColor, roughness: 0.15, metalness: 0.1, clearcoat: 1.0, clearcoatRoughness: 0.08
    });

    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.04), baseMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    group.add(bodyMesh);

    const foldMesh = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.56, 0.045), baseMat);
    foldMesh.position.z = 0.005;
    group.add(foldMesh);

    const flapShape = new THREE.Shape();
    flapShape.moveTo(-0.45, 0.3);
    flapShape.lineTo(0.45, 0.3);
    flapShape.lineTo(0, -0.05);
    flapShape.closePath();
    const flapGeo = new THREE.ExtrudeGeometry(flapShape, {
        depth: 0.02, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.01, bevelThickness: 0.01
    });
    flapGeo.center();
    const flapMesh = new THREE.Mesh(flapGeo, flapMat);
    flapMesh.position.set(0, 0.12, 0.025);
    flapMesh.rotation.x = 0.05;
    flapMesh.castShadow = true;
    group.add(flapMesh);

    // Melted wax puddle: a circle perturbed by two sine waves.
    const sealShape = new THREE.Shape();
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const r = 0.075 + 0.007 * Math.sin(theta * 5.0) + 0.003 * Math.cos(theta * 8.0);
        if (i === 0) sealShape.moveTo(Math.cos(theta) * r, Math.sin(theta) * r);
        else sealShape.lineTo(Math.cos(theta) * r, Math.sin(theta) * r);
    }
    sealShape.closePath();
    const sealGeo = new THREE.ExtrudeGeometry(sealShape, {
        depth: 0.015, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.004, bevelThickness: 0.004
    });
    sealGeo.center();
    const sealMesh = new THREE.Mesh(sealGeo, sealMat);
    sealMesh.position.set(0, -0.02, 0.04);
    sealMesh.castShadow = true;
    group.add(sealMesh);

    const useHeart = letterTheme === 'romance' || letterTheme === 'cyber';
    const emblemGeo = new THREE.ExtrudeGeometry(useHeart ? heartShape(0.07) : starShape(0.04, 0.018), {
        depth: 0.005, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.001, bevelThickness: 0.001
    });
    emblemGeo.center();
    const emblemMesh = new THREE.Mesh(emblemGeo, new THREE.MeshPhysicalMaterial({
        color: sealColor, roughness: 0.25, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.1
    }));
    emblemMesh.position.set(0, -0.02, 0.0475);
    emblemMesh.castShadow = true;
    group.add(emblemMesh);

    return group;
}

function heartShape(s) {
    const k = s / 0.07;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(0, 0.02 * k, 0.02 * k, 0.04 * k, 0.04 * k, 0.04 * k);
    shape.bezierCurveTo(0.06 * k, 0.04 * k, 0.07 * k, 0.025 * k, 0.07 * k, 0.01 * k);
    shape.bezierCurveTo(0.07 * k, -0.01 * k, 0.04 * k, -0.04 * k, 0, -0.065 * k);
    shape.bezierCurveTo(-0.04 * k, -0.04 * k, -0.07 * k, -0.01 * k, -0.07 * k, 0.01 * k);
    shape.bezierCurveTo(-0.07 * k, 0.025 * k, -0.06 * k, 0.04 * k, -0.04 * k, 0.04 * k);
    shape.bezierCurveTo(-0.02 * k, 0.04 * k, 0, 0.02 * k, 0, 0);
    return shape;
}

function starShape(outer, inner) {
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
        const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? outer : inner;
        if (i === 0) shape.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
        else shape.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    shape.closePath();
    return shape;
}

/** Orbiting sugar pills, plus hearts/stars when those toggles are on. */
function buildFloatingSprinkles(parent, config) {
    const list = [];
    const colors = [0x00f2fe, 0xff0055, 0x05ffb0];
    const { decorHearts, decorStars } = config;
    const extrude = { depth: 0.03, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.008, bevelThickness: 0.008 };

    const sprinkleGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.12, 8);
    let heartGeo = null;
    let starGeo = null;
    if (decorHearts) {
        heartGeo = new THREE.ExtrudeGeometry(heartShape(0.28), extrude);
        heartGeo.center();
    }
    if (decorStars) {
        starGeo = new THREE.ExtrudeGeometry(starShape(0.18, 0.08), extrude);
        starGeo.center();
    }

    // One material per colour instead of one per ornament.
    const matCache = new Map();
    const matFor = (color, intensity) => {
        const key = `${color}|${intensity}`;
        if (!matCache.has(key)) {
            matCache.set(key, new THREE.MeshStandardMaterial({
                color, emissive: color, emissiveIntensity: intensity, roughness: 0.1, metalness: 0.8
            }));
        }
        return matCache.get(key);
    };

    const total = decorHearts || decorStars ? 24 : 12;
    for (let i = 0; i < total; i++) {
        let geom = sprinkleGeo;
        let color = colors[i % colors.length];
        let fancy = false;
        if (decorHearts && decorStars) {
            if (i % 3 === 1) { geom = heartGeo; color = 0xff3377; fancy = true; }
            else if (i % 3 === 2) { geom = starGeo; color = 0xffd700; fancy = true; }
        } else if (decorHearts && i % 2 === 1) {
            geom = heartGeo; color = 0xff3377; fancy = true;
        } else if (decorStars && i % 2 === 1) {
            geom = starGeo; color = 0xffd700; fancy = true;
        }

        const mesh = new THREE.Mesh(geom, matFor(color, fancy ? 1.2 : 0.9));
        const angle = (i / total) * Math.PI * 2 + Math.random() * 0.4;
        const radius = 2.4 + Math.random() * 1.2;
        const y = -0.5 + Math.random() * 2.5;
        mesh.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
        parent.add(mesh);
        list.push({
            mesh,
            baseY: y,
            angle,
            radius,
            orbitSpeed: 0.06 + Math.random() * 0.1,
            bobSpeed: 1.0 + Math.random() * 1.2,
            bobOffset: Math.random() * Math.PI,
            rotSpeed: { x: 0.2 + Math.random() * 0.4, y: 0.2 + Math.random() * 0.4, z: 0.2 + Math.random() * 0.4 }
        });
    }
    return list;
}
