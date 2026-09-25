/**
 * Reflections of THIS room: one cube capture of the lit party room from
 * above the table, prefiltered with PMREM. Foil letters, the ganache, the
 * plate and glossy wood then mirror the real bunting, fairy lights and the
 * window instead of a generic studio (research-photoreal 1.4 option c).
 * Cost: six renders of the room at 128-256 px, once, behind the gate.
 */
import * as THREE from 'three';
import { precompileScene } from '../render-quality.js';

function yieldToMain() {
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
}

const WARM_LAYER = 31;

/**
 * The first render of a mesh uploads its vertex buffers (and any texture not
 * yet on the GPU): for the whole room that was one ~140 ms task. Render the
 * meshes a handful at a time into a tiny target first (a spare layer picks
 * the batch; every light joins it so the light count, and so the programs,
 * stay the same), yielding in between.
 */
async function warmUploads(renderer, scene, camera, mark) {
    const meshes = [];
    const lights = [];
    scene.traverseVisible((o) => {
        if (o.isLight) lights.push(o);
        else if (o.isMesh || o.isPoints || o.isLine || o.isSprite) meshes.push(o);
    });
    const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType });
    const cam = camera.clone();
    cam.layers.set(WARM_LAYER);
    lights.forEach((l) => l.layers.enable(WARM_LAYER));
    const prevTarget = renderer.getRenderTarget();
    const prevCull = [];
    try {
        for (let i = 0; i < meshes.length; i += 16) {
            const batch = meshes.slice(i, i + 16);
            batch.forEach((m) => {
                m.layers.enable(WARM_LAYER);
                // Upload even what this 8x8 view cannot see.
                prevCull.push([m, m.frustumCulled]);
                m.frustumCulled = false;
            });
            renderer.setRenderTarget(rt);
            renderer.render(scene, cam);
            renderer.setRenderTarget(prevTarget);
            batch.forEach((m) => m.layers.disable(WARM_LAYER));
            prevCull.splice(0).forEach(([m, v]) => { m.frustumCulled = v; });
            mark(`env:warm${i}`);
            await yieldToMain();
        }
    } finally {
        lights.forEach((l) => l.layers.disable(WARM_LAYER));
        meshes.forEach((m) => m.layers.disable(WARM_LAYER));
        prevCull.forEach(([m, v]) => { m.frustumCulled = v; });
        renderer.setRenderTarget(prevTarget);
        rt.dispose();
    }
}

export async function captureRoomEnvironment(renderer, scene, position, { size = 256, near = 0.5, far = 200, mark = () => {} } = {}) {
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(near, far, rt);
    cam.position.copy(position);
    scene.add(cam);
    // The cube faces render into a target (linear, no tone mapping): other
    // program variants than the screen. Compile those first, in parallel.
    await precompileScene(renderer, scene, cam.children[0], { renderTarget: rt, sliceMs: 8 });
    mark('env:compiled');
    // scene.environment stays as it is: nulling it for the capture would
    // change every program key and compile a second set synchronously.
    // One face per task (CubeCamera.update would render all six at once).
    if (cam.coordinateSystem !== renderer.coordinateSystem) {
        cam.coordinateSystem = renderer.coordinateSystem;
        cam.updateCoordinateSystem();
    }
    cam.updateMatrixWorld(true);
    await warmUploads(renderer, scene, cam.children[0], mark);
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    for (let face = 0; face < 6; face++) {
        renderer.setRenderTarget(rt, face);
        renderer.render(scene, cam.children[face]);
        renderer.setRenderTarget(prevTarget);
        mark(`env:face${face}`);
        await yieldToMain();
    }
    renderer.xr.enabled = prevXr;
    scene.remove(cam);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromCubemap(rt.texture).texture;
    mark('env:pmrem');
    pmrem.dispose();
    rt.dispose();
    env.name = 'party-room-env';
    return env;
}
