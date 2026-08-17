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
    renderer.shadowMap.enabled = !mobile;
    renderer.setPixelRatio(mobile ? Math.min(window.devicePixelRatio, 1.25) : Math.min(window.devicePixelRatio, maxPixelRatio));
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

    const rim = new THREE.DirectionalLight(new THREE.Color(rimColor), 2.2);
    rim.position.set(-1.5, 3.5, -7);
    scene.add(rim);

    return { ambient, key, fill, rim };
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
