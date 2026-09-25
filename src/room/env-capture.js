/**
 * Reflections of THIS room: cube captures of the room from above the table,
 * prefiltered with PMREM. Foil, the ganache, the plate and glossy wood then
 * mirror the real bunting, fairy lights and the window instead of a generic
 * studio (research-photoreal 1.4 option c).
 *
 * Two phases, so the gate never waits on the captures:
 *   prepareRoomCapture()  behind the gate: compiles the program variants the
 *                         cube faces and PMREM need (parallel compile) so the
 *                         captures later add no program, and uploads the
 *                         room's buffers in small batches
 *   renderRoomCapture()   any time after: one face per task; `around(fn)`
 *                         lets the room put its lit/dark state in place for
 *                         exactly the synchronous face render (no visible
 *                         frame ever shows the capture state)
 * Cost: six renders of the room at 128-256 px + one PMREM pass per capture.
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


export async function prepareRoomCapture(renderer, scene, position, { size = 256, near = 0.5, far = 200, mark = () => {} } = {}) {
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(near, far, rt);
    cam.position.copy(position);
    // The faces render into a target (linear, no tone mapping): other program
    // variants than the screen. Compile them now, in parallel.
    scene.add(cam);
    await precompileScene(renderer, scene, cam.children[0], { renderTarget: rt, sliceMs: 8 });
    mark('env:compiled');
    // Also uploads every vertex buffer now, in batches, instead of all of
    // them in the first dark frame.
    await warmUploads(renderer, scene, cam.children[0], mark);
    scene.remove(cam);
    // One generator for the room's lifetime: disposing it would delete its
    // programs and every capture would link them again.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileCubemapShader();
    mark('env:pmrem-compiled');
    return { rt, cam, pmrem };
}

/**
 * @param {object} prepared   prepareRoomCapture() result (reusable)
 * @param {(fn: () => void) => void} [around]  wraps each synchronous face render
 * @returns {Promise<THREE.Texture>} a new PMREM texture (caller owns it)
 */
export async function renderRoomCapture(renderer, scene, prepared, { around = (fn) => fn(), mark = () => {}, name = 'party-room-env' } = {}) {
    const { rt, cam } = prepared;
    scene.add(cam);
    if (cam.coordinateSystem !== renderer.coordinateSystem) {
        cam.coordinateSystem = renderer.coordinateSystem;
        cam.updateCoordinateSystem();
    }
    cam.updateMatrixWorld(true);
    try {
        for (let face = 0; face < 6; face++) {
            around(() => {
                const prevTarget = renderer.getRenderTarget();
                const prevXr = renderer.xr.enabled;
                renderer.xr.enabled = false;
                renderer.setRenderTarget(rt, face);
                renderer.render(scene, cam.children[face]);
                renderer.setRenderTarget(prevTarget);
                renderer.xr.enabled = prevXr;
            });
            mark(`env:face${face}`);
            await yieldToMain();
        }
    } finally {
        scene.remove(cam);
    }
    const env = prepared.pmrem.fromCubemap(rt.texture).texture;
    env.name = name;
    mark('env:pmrem');
    return env;
}

export function disposeRoomCapture(prepared) {
    prepared?.rt.dispose();
    prepared?.pmrem.dispose();
}
