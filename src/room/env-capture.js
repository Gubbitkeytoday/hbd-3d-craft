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

export async function captureRoomEnvironment(renderer, scene, position, { size = 256, near = 0.5, far = 200 } = {}) {
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(near, far, rt);
    cam.position.copy(position);
    scene.add(cam);
    // The cube faces render into a target (linear, no tone mapping): other
    // program variants than the screen. Compile those first, in parallel.
    await precompileScene(renderer, scene, cam.children[0], { renderTarget: rt, sliceMs: 8 });
    // scene.environment stays as it is: nulling it for the capture would
    // change every program key and compile a second set synchronously.
    // One face per task (CubeCamera.update would render all six at once).
    if (cam.coordinateSystem !== renderer.coordinateSystem) {
        cam.coordinateSystem = renderer.coordinateSystem;
        cam.updateCoordinateSystem();
    }
    cam.updateMatrixWorld(true);
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    for (let face = 0; face < 6; face++) {
        renderer.setRenderTarget(rt, face);
        renderer.render(scene, cam.children[face]);
        renderer.setRenderTarget(prevTarget);
        await yieldToMain();
    }
    renderer.xr.enabled = prevXr;
    scene.remove(cam);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromCubemap(rt.texture).texture;
    pmrem.dispose();
    rt.dispose();
    env.name = 'party-room-env';
    return env;
}
