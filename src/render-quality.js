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
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
}

/**
 * Generates a soft studio IBL from RoomEnvironment and assigns it as
 * scene.environment. Gives every PBR material real reflections — the glaze
 * looks wet, the cherries glossy, the cake stand like actual ceramic.
 * One-time cost (~10ms); nothing per-frame.
 */
export function attachStudioEnvironment(renderer, scene) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomScene = new RoomEnvironment();
    const envMap = pmrem.fromScene(roomScene, 0.04).texture;

    scene.environment = envMap;

    // The room is only a source for the prefilter pass — release it immediately.
    roomScene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
    });
    pmrem.dispose();

    return envMap;
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
    // Low ambient: the environment map already supplies indirect light, so a
    // strong AmbientLight here would only flatten the shading back out.
    const ambient = new THREE.AmbientLight(0xffffff, 0.08);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xfff2e0, 1.45);
    key.position.set(5, 10, 7);
    key.castShadow = true;
    const shadowRes = mobile ? 1024 : 2048;
    key.shadow.mapSize.width = shadowRes;
    key.shadow.mapSize.height = shadowRes;
    // Tight frustum around the cake — a default 5-unit box wastes most of the
    // shadow map on empty space and makes contact shadows mushy.
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 25;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0x9dc4ff, 0.3);
    fill.position.set(-6, 4, -2);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(new THREE.Color(rimColor), 2.2);
    rim.position.set(-1.5, 3.5, -7);
    scene.add(rim);

    return { ambient, key, fill, rim };
}

/**
 * Selective-looking bloom over the whole frame. This is what makes the candle
 * flames, the holographic rings and the neon topper actually glow instead of
 * just being bright pixels.
 *
 * With an OutputPass at the end, tone mapping and color space conversion move
 * from the renderer to the composer, so the look stays identical to the
 * non-composited path — just with glow added.
 *
 * @returns {{composer: EffectComposer, bloom: UnrealBloomPass, setSize: (w:number,h:number)=>void}}
 */
export function createBloomComposer(renderer, scene, camera, { mobile = isMobileViewport() } = {}) {
    const size = renderer.getSize(new THREE.Vector2());

    const composer = new EffectComposer(renderer);
    // Half-res bloom buffers on phones: the blur is wide enough that the
    // resolution loss is invisible, and it roughly halves the pass cost.
    composer.setPixelRatio(mobile ? 1 : Math.min(window.devicePixelRatio, 2));
    composer.setSize(size.x, size.y);

    // Note: the composited output is opaque — OutputPass writes alpha 1 — so a
    // scene using this needs its own scene.background instead of relying on a
    // transparent canvas.
    composer.addPass(new RenderPass(scene, camera));

    // RenderPass output is linear HDR here, so lit white frosting sits around
    // 1.0. The threshold has to clear that or the cream and the cake stand
    // bloom into a single white blob — only emissive things should glow.
    // Deliberately restrained: enough to read as a glow around the flames and
    // holo rings, not enough to haze the frame or tire the eyes.
    const bloom = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        mobile ? 0.16 : 0.22, // strength
        0.4,                  // radius
        1.35                  // threshold
    );
    composer.addPass(bloom);

    composer.addPass(new OutputPass());

    return {
        composer,
        bloom,
        setSize(w, h) {
            composer.setSize(w, h);
            bloom.setSize(w, h);
        }
    };
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
                mat.envMapIntensity = intensity;
                mat.needsUpdate = true;
            }
        });
    });
}
