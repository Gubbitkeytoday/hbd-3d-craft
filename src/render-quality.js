/**
 * Shared cinematic render quality setup for both the creator preview and the
 * full viewer scene, so the cake looks identical (and good) in both places.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Phones get lighter shadows and a lower pixel ratio ceiling. */
export function isMobileViewport() {
    return window.matchMedia('(max-width: 768px)').matches;
}

/**
 * Filmic tone mapping + sRGB output. This is the single biggest quality jump:
 * without it, the bright cream and candle glow clip to flat white and the
 * theme colors read as washed out.
 */
export function applyCinematicRenderer(renderer, { exposure = 1.12, maxPixelRatio = 2 } = {}) {
    const mobile = isMobileViewport();
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // In production three skips the per-program status/info-log query, which
    // is the synchronous call that froze the page for seconds while ~35
    // programs linked. Dev builds keep the shader error reports.
    renderer.debug.checkShaderErrors = import.meta.env.DEV;
    renderer.shadowMap.enabled = !mobile;
    renderer.setPixelRatio(mobile ? Math.min(window.devicePixelRatio, 1.25) : Math.min(window.devicePixelRatio, maxPixelRatio));
}

/**
 * Generates a soft studio IBL from RoomEnvironment and assigns it as
 * scene.environment. Gives every PBR material real reflections — the glaze
 * looks wet, the cherries glossy, the cake stand like actual ceramic.
 *
 * Cached per renderer: calling it again (a second scene, a remount on the
 * same renderer) reuses the texture instead of re-rendering the room.
 * Pass { force: true } to regenerate.
 */
export function attachStudioEnvironment(renderer, scene, { force = false } = {}) {
    const cached = !force && envCache.get(renderer);
    if (cached) {
        scene.environment = cached;
        return cached;
    }
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomScene = new RoomEnvironment();
    const envMap = generateRoomEnv(renderer, pmrem, roomScene);
    scene.environment = envMap;
    return envMap;
}

/**
 * Same result as attachStudioEnvironment, but the room and prefilter shaders
 * are compiled with compileAsync first, so the synchronous part is only the
 * ~20 render passes. The driver compile/link waits were most of the 100 to
 * 300 ms main-thread block this used to cost on phones.
 *
 * @returns {Promise<THREE.Texture>}
 */
export async function attachStudioEnvironmentAsync(renderer, scene, { force = false } = {}) {
    const cached = !force && envCache.get(renderer);
    if (cached) {
        scene.environment = cached;
        return cached;
    }
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomScene = new RoomEnvironment();
    await precompilePmrem(renderer, pmrem, roomScene);
    // Another caller may have finished while we waited.
    const raced = !force && envCache.get(renderer);
    if (raced) {
        disposeRoom(roomScene);
        pmrem.dispose();
        scene.environment = raced;
        return raced;
    }
    const envMap = generateRoomEnv(renderer, pmrem, roomScene);
    scene.environment = envMap;
    return envMap;
}

const envCache = new WeakMap();

function disposeRoom(roomScene) {
    roomScene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
    });
}

function generateRoomEnv(renderer, pmrem, roomScene) {
    const envMap = pmrem.fromScene(roomScene, 0.04).texture;
    // The room is only a source for the prefilter pass — release it immediately.
    disposeRoom(roomScene);
    pmrem.dispose();
    envCache.set(renderer, envMap);
    envMap.addEventListener('dispose', () => {
        if (envCache.get(renderer) === envMap) envCache.delete(renderer);
    });
    return envMap;
}

/**
 * Warms the programs PMREMGenerator.fromScene is about to use. Relies on two
 * PMREMGenerator internals (_setSize/_allocateTargets, stable since r15x);
 * if they are missing it simply resolves and fromScene compiles as before.
 */
async function precompilePmrem(renderer, pmrem, roomScene) {
    if (typeof renderer.compileAsync !== 'function') return;
    const previous = renderer.getRenderTarget();
    const quad = new THREE.PlaneGeometry(2, 2);
    const passes = new THREE.Scene();
    try {
        let target = null;
        if (typeof pmrem._setSize === 'function' && typeof pmrem._allocateTargets === 'function') {
            pmrem._setSize(256);
            const probe = pmrem._allocateTargets();
            probe.dispose();
            target = pmrem._pingPongRenderTarget || null;
            if (pmrem._blurMaterial) passes.add(new THREE.Mesh(quad, pmrem._blurMaterial));
        }
        // Any render target gives the same program key (no tone mapping,
        // linear output) as the cube-UV targets fromScene renders into.
        renderer.setRenderTarget(target);
        const jobs = [renderer.compileAsync(roomScene, new THREE.PerspectiveCamera(), roomScene)];
        if (passes.children.length) jobs.push(renderer.compileAsync(passes, new THREE.PerspectiveCamera(), passes));
        renderer.setRenderTarget(previous);
        await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 4000))]);
    } catch (err) {
        if (import.meta.env.DEV) console.warn('[precompilePmrem]', err);
    } finally {
        renderer.setRenderTarget(previous);
        quad.dispose();
    }
}

/**
 * Three-point studio rig (warm key / cool fill / colored rim) instead of a
 * single flat directional light. The rim light is what separates the cake
 * silhouette from the dark space background.
 *
 * @param {THREE.Scene} scene
 * @param {object} opts
 * @param {number|string} opts.rimColor  Rim/back light color, normally the active theme accent.
 * @param {boolean} opts.mobile          Halves shadow resolution when true.
 * @returns {{key: THREE.DirectionalLight, fill: THREE.DirectionalLight, rim: THREE.DirectionalLight, ambient: THREE.AmbientLight}}
 */
export function setupStudioLighting(scene, { rimColor = 0xff0055, mobile = isMobileViewport() } = {}) {
    const ambient = new THREE.AmbientLight(0xffffff, mobile ? 0.25 : 0.08);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xfff2e0, 1.45);
    key.position.set(5, 10, 7);
    key.castShadow = !mobile;
    if (!mobile) {
        key.shadow.mapSize.width = 1024;
        key.shadow.mapSize.height = 1024;
        key.shadow.camera.left = -4;
        key.shadow.camera.right = 4;
        key.shadow.camera.top = 4;
        key.shadow.camera.bottom = -4;
        key.shadow.camera.near = 0.5;
        key.shadow.camera.far = 25;
        key.shadow.bias = -0.0004;
        key.shadow.normalBias = 0.02;
        key.shadow.radius = 3;
    }
    scene.add(key);

    const fill = new THREE.DirectionalLight(0x9dc4ff, 0.4);
    fill.position.set(-6, 4, -2);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, RIM_INTENSITY);
    rim.position.set(-1.5, 3.5, -7);
    tintRimLight(rim, rimColor);
    scene.add(rim);

    return { ambient, key, fill, rim };
}

const RIM_INTENSITY = 2.2;

/**
 * Tints the rim light while keeping its brightness constant. A pale accent at
 * full intensity grazed the glossy plate edge hard enough to bloom into a
 * white blob; a dark one switched the rim off entirely.
 */
export function tintRimLight(rim, color) {
    const c = new THREE.Color(color);
    const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    rim.color.copy(c);
    rim.intensity = RIM_INTENSITY * THREE.MathUtils.clamp(0.2 / Math.max(luminance, 0.05), 0.3, 1.2);
    // applyBackdrop() scales from this, so re-tinting and switching backdrops
    // in any order never compounds.
    rim.userData.baseIntensity = rim.intensity;
}

/**
 * Selective-looking bloom over the whole frame.
 */
export function createBloomComposer(renderer, scene, camera, { mobile = isMobileViewport() } = {}) {
    const size = renderer.getSize(new THREE.Vector2());

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(mobile ? 1.0 : Math.min(window.devicePixelRatio, 1.75));
    composer.setSize(size.x, size.y);

    composer.addPass(new RenderPass(scene, camera));

    const bloom = new UnrealBloomPass(
        mobile ? new THREE.Vector2(Math.floor(size.x * 0.5), Math.floor(size.y * 0.5)) : new THREE.Vector2(size.x, size.y),
        mobile ? 0.12 : 0.22, // strength
        0.4,                  // radius
        1.35                  // threshold
    );
    composer.addPass(bloom);
    bloom.userData = { baseStrength: bloom.strength, baseThreshold: bloom.threshold };
    keepBloomAlpha(bloom);

    composer.addPass(new OutputPass());

    return {
        composer,
        bloom,
        setSize(w, h) {
            composer.setSize(w, h);
            if (mobile) {
                bloom.setSize(Math.floor(w * 0.5), Math.floor(h * 0.5));
            } else {
                bloom.setSize(w, h);
            }
        }
    };
}

/**
 * UnrealBloomPass composites with plain additive blending, which also adds
 * its (~0.6) composite alpha to the frame. On an opaque night frame that is
 * invisible; on a transparent canvas (light backdrops are painted by CSS
 * behind it) it laid a grey veil over the page. Colour stays additive,
 * destination alpha is left alone. Blend state only: no recompile.
 */
function keepBloomAlpha(bloom) {
    const m = bloom.blendMaterial;
    if (!m) return;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
}

/**
 * Dials in how strongly each material picks up the environment map. Called
 * after the cake is (re)built, since the cake is rebuilt on every form change.
 */
export function tuneMaterialsForEnvironment(root, intensity = 1.0) {
    root.traverse((obj) => {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((mat) => {
            if (!mat || mat.isMeshBasicMaterial || mat.isShaderMaterial) return;
            if ('envMapIntensity' in mat) {
                // A plain uniform: no needsUpdate, which would force a
                // program-cache re-evaluation of every material on rebuild.
                mat.envMapIntensity = intensity;
            }
        });
    });
}

/* ------------------------------------------------------------------------ */
/* Shader precompile + adaptive quality                                      */
/* ------------------------------------------------------------------------ */

/**
 * Compiles every program the scene needs without blocking the main thread,
 * so the first rendered frame does not stall for seconds while the driver
 * links ~35 physical-material shaders.
 *
 *   await precompileScene(renderer, scene, camera);                 // plain renderer.render
 *   await precompileScene(renderer, scene, camera, { bloom });      // scene drawn through the composer
 *   await precompileScene(renderer, newCake, camera, { targetScene: scene, bloom });
 *
 * Program keys depend on WHERE a material is drawn: into a render target
 * three disables tone mapping and outputs linear colour, on screen it does
 * not. Compiling for the wrong target means every program is rebuilt on the
 * first real frame, so:
 * - `bloom` (the createBloomComposer object): scene materials are compiled
 *   for the composer's read buffer, pass materials for their real target
 *   (off-screen, except the last enabled pass on screen), and OutputPass gets
 *   the tone-mapping defines it would only set on its first render.
 * - `renderTarget`: explicit target for the scene materials (null = screen).
 *   Defaults to the composer read buffer with `bloom`, else the renderer's
 *   current target.
 * - `targetScene`: the live scene when precompiling a detached subtree (a
 *   rebuilt cake before it is added) so lights/environment/fog match.
 * - `sliceMs`: > 0 hands objects to the driver in slices of that many ms,
 *   yielding between slices (compile() itself is synchronous CPU work: shader
 *   source assembly and glCompileShader calls). `onProgress(0..1)` reports.
 * - Uses KHR_parallel_shader_compile readiness polling when available;
 *   otherwise resolves right after compile(). Never rejects, never hangs
 *   (capped by `timeoutMs`).
 *
 * @returns {Promise<void>}
 */
export async function precompileScene(renderer, scene, camera, {
    targetScene = null,
    bloom = null,
    renderTarget,
    sliceMs = 0,
    onProgress = null,
    timeoutMs = 10000
} = {}) {
    if (!renderer || !scene || !camera) return;
    const composer = bloom?.composer || null;
    const sceneTarget = renderTarget !== undefined
        ? renderTarget
        : composer ? composer.readBuffer : renderer.getRenderTarget();
    const liveScene = targetScene || scene;

    const quad = new THREE.PlaneGeometry(2, 2);
    const units = collectUnits(scene, liveScene, sceneTarget, sliceMs > 0);
    if (composer) units.push(...composerUnits(renderer, composer, quad));

    const previous = renderer.getRenderTarget();
    const materials = new Set();
    try {
        let sliceStart = performance.now();
        for (let i = 0; i < units.length; i++) {
            const { root, target, rt } = units[i];
            renderer.setRenderTarget(rt);
            try {
                renderer.compile(root, camera, target).forEach((m) => materials.add(m));
            } finally {
                renderer.setRenderTarget(previous);
            }
            if (sliceMs > 0 && performance.now() - sliceStart > sliceMs) {
                onProgress?.((i + 1) / units.length * 0.5);
                await yieldToMain();
                sliceStart = performance.now();
            }
        }
        await waitForPrograms(renderer, materials, timeoutMs, onProgress);
    } catch (err) {
        // A failed precompile only means the first frame compiles lazily.
        if (import.meta.env.DEV) console.warn('[precompileScene]', err);
    } finally {
        renderer.setRenderTarget(previous);
        // The quads only borrowed the pass materials; their programs stay
        // cached in the renderer because the passes still reference them.
        quad.dispose();
    }
    onProgress?.(1);
}

/** One unit per object when slicing (materials deduplicated), else the whole root. */
function collectUnits(root, liveScene, rt, perObject) {
    if (!perObject) return [{ root, target: liveScene, rt }];
    const units = [];
    const seen = new Set();
    root.traverse((obj) => {
        if (!obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        if (mats.every((m) => seen.has(m))) return;
        mats.forEach((m) => seen.add(m));
        units.push({ root: obj, target: liveScene, rt });
    });
    return units;
}

/** Full-screen pass materials, each compiled for the target it renders into. */
function composerUnits(renderer, composer, quad) {
    const passes = (composer.passes || []).filter((p) => p.enabled !== false);
    const offscreen = new THREE.Scene();
    const onscreen = new THREE.Scene();
    passes.forEach((pass, i) => {
        if (pass.isOutputPass) primeOutputPass(renderer, pass);
        const toScreen = i === passes.length - 1 && composer.renderToScreen !== false;
        const bucket = toScreen ? onscreen : offscreen;
        const seen = new Set();
        Object.values(pass).forEach((value) => {
            const list = Array.isArray(value) ? value : [value];
            list.forEach((m) => {
                if (m?.isMaterial && !seen.has(m)) {
                    seen.add(m);
                    bucket.add(new THREE.Mesh(quad, m));
                }
            });
        });
    });
    const units = [];
    if (offscreen.children.length) units.push({ root: offscreen, target: offscreen, rt: composer.readBuffer });
    if (onscreen.children.length) units.push({ root: onscreen, target: onscreen, rt: null });
    return units;
}

/** Mirrors OutputPass.render's lazy define setup so its program key is final now. */
function primeOutputPass(renderer, pass) {
    if (pass._outputColorSpace === renderer.outputColorSpace && pass._toneMapping === renderer.toneMapping) return;
    pass._outputColorSpace = renderer.outputColorSpace;
    pass._toneMapping = renderer.toneMapping;
    const defines = {};
    if (THREE.ColorManagement.getTransfer(renderer.outputColorSpace) === THREE.SRGBTransfer) defines.SRGB_TRANSFER = '';
    const toneDefine = {
        [THREE.LinearToneMapping]: 'LINEAR_TONE_MAPPING',
        [THREE.ReinhardToneMapping]: 'REINHARD_TONE_MAPPING',
        [THREE.CineonToneMapping]: 'CINEON_TONE_MAPPING',
        [THREE.ACESFilmicToneMapping]: 'ACES_FILMIC_TONE_MAPPING',
        [THREE.AgXToneMapping]: 'AGX_TONE_MAPPING'
    }[renderer.toneMapping];
    if (toneDefine) defines[toneDefine] = '';
    pass.material.defines = defines;
    pass.material.needsUpdate = true;
}

/** Polls KHR_parallel_shader_compile readiness without ever blocking. */
function waitForPrograms(renderer, materials, timeoutMs, onProgress) {
    const total = materials.size || 1;
    const pending = new Set(materials);
    const deadline = performance.now() + timeoutMs;
    return new Promise((resolve) => {
        const check = () => {
            pending.forEach((m) => {
                const program = renderer.properties.get(m).currentProgram;
                if (!program || program.isReady()) pending.delete(m);
            });
            onProgress?.(0.5 + (1 - pending.size / total) * 0.5);
            if (!pending.size || performance.now() > deadline) resolve();
            else setTimeout(check, 10);
        };
        check();
    });
}

function yieldToMain() {
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Quality levels used by createQualityGovernor (cumulative):
 *   0 full   1 pixel ratio x0.75   2 pixel ratio 1.0   3 bloom pass off
 *   4 shadow map refreshed every 4th frame (no recompile, unlike
 *     shadowMap.enabled = false which changes every program key)
 *   5 decoration budget: the governor changes nothing itself; onLevelChange
 *     is the caller's cue to hide or halve decor (balloons, gifts, embers).
 */
export const QUALITY_LEVELS = Object.freeze({
    FULL: 0, DPR_REDUCED: 1, DPR_MIN: 2, BLOOM_OFF: 3, SHADOWS_THROTTLED: 4, DECOR_BUDGET: 5, MAX: 5
});

/**
 * FPS governor (drei PerformanceMonitor pattern): steps quality down when the
 * device cannot keep up and back up when it has headroom.
 *
 *   const governor = createQualityGovernor({ renderer, bloom, onLevelChange });
 *   // in the render loop, once per frame:
 *   governor.sample(deltaSeconds);
 *   governor.level; // 0 (full) .. QUALITY_LEVELS.MAX
 *
 * Averages FPS over ~1 s windows, ignores the first 45 frames (compile and
 * upload hitches) and deltas > 0.25 s (tab switches). Steps down after 2 slow
 * windows (< 40 fps), up after 5 fast windows (>= 55 fps, so 60 Hz vsync can
 * still recover) and freezes after 3 direction reversals so it never
 * oscillates. `onLevelChange(level, previousLevel)` fires after the change is
 * applied. Call after applyCinematicRenderer/createBloomComposer so the
 * starting pixel ratios are captured as the level-0 baseline.
 */
export function createQualityGovernor({
    renderer,
    bloom = null,
    onLevelChange = null,
    initialLevel = 0,
    lowFps = 40,
    highFps = 55,
    windowSeconds = 1,
    warmupFrames = 45
} = {}) {
    const basePixelRatio = renderer.getPixelRatio();
    const baseComposerRatio = bloom?.composer?._pixelRatio ?? basePixelRatio;
    let level = 0;
    let frames = 0;
    let windowTime = 0;
    let windowFrames = 0;
    let slowWindows = 0;
    let fastWindows = 0;
    let lastDirection = 0;
    let reversals = 0;
    let shadowTick = 0;

    function pixelRatioFor(lvl, base) {
        if (lvl >= QUALITY_LEVELS.DPR_MIN) return Math.min(base, 1);
        if (lvl >= QUALITY_LEVELS.DPR_REDUCED) return Math.max(1, base * 0.75);
        return base;
    }

    function apply(next) {
        const prev = level;
        level = THREE.MathUtils.clamp(Math.round(next), 0, QUALITY_LEVELS.MAX);
        if (level === prev) return;

        const ratio = pixelRatioFor(level, basePixelRatio);
        if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
        if (bloom?.composer) {
            const composerRatio = pixelRatioFor(level, baseComposerRatio);
            if (bloom.composer._pixelRatio !== composerRatio) bloom.composer.setPixelRatio(composerRatio);
            if (bloom.bloom) bloom.bloom.enabled = level < QUALITY_LEVELS.BLOOM_OFF;
        }
        const throttleShadows = level >= QUALITY_LEVELS.SHADOWS_THROTTLED;
        renderer.shadowMap.autoUpdate = !throttleShadows;
        if (throttleShadows) renderer.shadowMap.needsUpdate = true;

        if (onLevelChange) onLevelChange(level, prev);
    }

    function sample(deltaSeconds) {
        if (renderer.shadowMap.enabled && !renderer.shadowMap.autoUpdate) {
            shadowTick = (shadowTick + 1) % 4;
            if (shadowTick === 0) renderer.shadowMap.needsUpdate = true;
        }
        if (!(deltaSeconds > 0) || deltaSeconds > 0.25) return level;
        frames++;
        if (frames <= warmupFrames || reversals >= 3) return level;

        windowTime += deltaSeconds;
        windowFrames++;
        if (windowTime < windowSeconds) return level;

        const fps = windowFrames / windowTime;
        windowTime = 0;
        windowFrames = 0;
        if (fps < lowFps) {
            slowWindows++;
            fastWindows = 0;
        } else if (fps >= highFps) {
            fastWindows++;
            slowWindows = 0;
        } else {
            slowWindows = 0;
            fastWindows = 0;
        }

        let direction = 0;
        if (slowWindows >= 2 && level < QUALITY_LEVELS.MAX) direction = 1;
        else if (fastWindows >= 5 && level > 0) direction = -1;
        if (direction) {
            if (lastDirection && direction !== lastDirection) reversals++;
            lastDirection = direction;
            slowWindows = 0;
            fastWindows = 0;
            apply(level + direction);
        }
        return level;
    }

    if (initialLevel) apply(initialLevel);

    return {
        sample,
        get level() { return level; },
        /** Force a level (e.g. a debug toggle); adaptation continues from there. */
        setLevel: apply
    };
}
