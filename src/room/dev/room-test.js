/**
 * Dev-only harness for the party room (not part of the build: only
 * index.html is a Vite input). Open
 *   /src/room/dev/room-test.html?state=dark|mid|lit|dim&shot=entry|wide|cake|closeUp&q=0..2&theme=..&name=..
 * window.__room exposes the room and measurement helpers for the scripts.
 */
import * as THREE from 'three';
import { applyCinematicRenderer, createBloomComposer, precompileScene, attachStudioEnvironmentAsync } from '../../render-quality.js';
import { buildCakeModel, getCakeLayout } from '../../cake-models.js';
import { buildCandles } from '../../cake/candles.js';
import { createPartyRoom } from '../index.js';
import { ROOM_SCALE } from '../layout.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const qs = new URLSearchParams(location.search);
const hud = document.getElementById('hud');
if (qs.has('clean')) document.body.classList.add('clean');
const quality = Number(qs.get('q') ?? (innerWidth < 700 ? 1 : 2));
const theme = qs.get('theme') || 'neon-rose';
const model = qs.get('model') || 'classic-tiered';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
applyCinematicRenderer(renderer, { exposure: 1.05, maxPixelRatio: 2 });
// Measure like production (no synchronous shader status queries), ?checks to re-enable.
renderer.debug.checkShaderErrors = qs.has('checks');
if (qs.has('trace')) {
    // ?trace: log every compile() call slower than 20 ms (what it compiled).
    const compile = renderer.compile.bind(renderer);
    window.__slow = [];
    renderer.compile = (root, cam, target) => {
        const t = performance.now();
        const out = compile(root, cam, target);
        const d = performance.now() - t;
        if (d > 20) window.__slow.push([root.name || root.type, Math.round(d), out.length, [...new Set(out.map((m) => m.type + ':' + (m.name || '')))].join(',')]);
        return out;
    };
}
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 400);
await attachStudioEnvironmentAsync(renderer, scene);
const bloom = createBloomComposer(renderer, scene, camera);

const t0 = performance.now();
const room = await createPartyRoom({
    renderer, scene, camera, quality,
    config: { recipientName: qs.get('name') ?? 'Ploy', theme, photo: qs.get('photo') || '' },
    onProgress: (p) => { hud.textContent = `loading ${(p * 100) | 0}%`; (window.__prog ||= []).push([Math.round(performance.now()), +p.toFixed(3)]); }
});
const loadMs = performance.now() - t0;

// Cake + candles, as the viewer builds them.
const cake = new THREE.Group();
const layout = buildCakeModel(cake, { cakeModel: model, themeName: theme, tagDecor: true });
const candles = buildCandles(cake, getCakeLayout(model), { count: 5, look: 'dark' });
room.seatCake(cake);
room.trackEnvMaterials(cake, 0.8);
void layout;

function setShot(name) {
    const shot = room.shots[name] || room.shots.cake;
    const s = shot.forAspect ? shot.forAspect(innerWidth / innerHeight) : shot;
    camera.position.copy(s.position);
    camera.lookAt(s.target);
    if (s.fov) camera.fov = s.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
}
setShot(qs.get('shot') || 'cake');

const states = { dark: [0, 0], mid: [0.35, 0], lit: [1, 0], dim: [1, 1] };
function setState(name) {
    const [l, d] = states[name] || states.dark;
    room.setLights(l);
    room.setDim(d);
    renderer.toneMappingExposure = THREE.MathUtils.lerp(room.exposure.dark, room.exposure.lit, l) * 1.05;
}
setState(qs.get('state') || 'dark');

await precompileScene(renderer, scene, camera, { bloom, sliceMs: 8 });

const clock = new THREE.Clock();
let frames = 0;
let fpsT = 0;
let fps = 0;
let elapsed = 0;
function frame() {
    const dt = clock.getDelta();
    elapsed += dt;
    room.update(dt, elapsed);
    candles.flameMaterial.uniforms.uTime.value = elapsed;
    renderer.info.reset();
    bloom.composer.render();
    frames++;
    fpsT += dt;
    if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    hud.textContent = `room ${room.baked ? 'baked' : 'greybox'}  q${quality}  load ${loadMs | 0} ms\n` +
        `fps ${fps.toFixed(0)}  calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}\n` +
        `programs ${renderer.info.programs.length}  lit ${room.lit.toFixed(2)} dim ${room.dim.toFixed(2)}`;
    requestAnimationFrame(frame);
}
renderer.info.autoReset = false;
requestAnimationFrame(frame);

addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    bloom.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
});

/**
 * Exports the procedural props + cake in room metres for the Cycles poster
 * render (scripts/room/room.py poster imports cache/props.glb). Instances
 * become plain meshes, unlit HDR bits become emissive, flames become
 * CANDLE_n markers (Blender puts a point light there).
 */
async function exportProps() {
    const out = new THREE.Scene();
    const toMetres = new THREE.Matrix4().makeScale(1 / ROOM_SCALE, 1 / ROOM_SCALE, 1 / ROOM_SCALE);
    const skip = new Set(['room-baked', 'room-greybox', 'city', 'room-rig', 'switch-hit', 'switch-halo', 'room-contact', 'contact-shadow']);
    const mats = new Map();
    const convert = (m, color) => {
        if (Array.isArray(m)) return m.map((x) => convert(x, color));
        const key = m.uuid + (color ? color.getHexString() + color.r.toFixed(2) : '');
        if (mats.has(key)) return mats.get(key);
        let r;
        if (m.isMeshBasicMaterial) {
            const c = (color || m.color).clone();
            const k = Math.max(c.r, c.g, c.b, 1e-4);
            r = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c.clone().multiplyScalar(1 / Math.max(k, 1)), emissiveIntensity: Math.max(k, 1), emissiveMap: m.map || null, map: m.transparent ? m.map : null, transparent: m.transparent, opacity: m.opacity, alphaTest: m.transparent && m.map ? 0.02 : 0 });
            r.name = 'emitprop_' + (m.name || 'basic');
        } else {
            r = m.clone();
            r.onBeforeCompile = () => {};
            if (color) r.color = r.color.clone().multiply(color);
        }
        mats.set(key, r);
        return r;
    };
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    let candles = 0;
    const visit = (o) => {
        if (skip.has(o.name) || o.visible === false) return;
        if (o.isSprite || o.isPoints || o.isLight) return;
        if (o.isMesh && o.material?.isShaderMaterial) {
            if (o.name === 'flame') {
                const mk = new THREE.Object3D();
                mk.name = `CANDLE_${candles++}`;
                mk.applyMatrix4(toMetres.clone().multiply(o.matrixWorld));
                out.add(mk);
            }
            return;
        }
        if (o.isInstancedMesh) {
            for (let i = 0; i < o.count; i++) {
                o.getMatrixAt(i, m4);
                const e = m4.elements;
                if (Math.abs(e[0]) + Math.abs(e[5]) + Math.abs(e[10]) < 1e-6) continue;
                if (o.instanceColor) o.getColorAt(i, col);
                const mesh = new THREE.Mesh(o.geometry, convert(o.material, o.instanceColor ? col.clone() : null));
                mesh.name = `${o.name}_${i}`;
                mesh.applyMatrix4(toMetres.clone().multiply(o.matrixWorld).multiply(m4));
                out.add(mesh);
            }
        } else if (o.isMesh) {
            const mesh = new THREE.Mesh(o.geometry, convert(o.material, null));
            mesh.name = o.name || 'prop';
            mesh.applyMatrix4(toMetres.clone().multiply(o.matrixWorld));
            out.add(mesh);
        }
        o.children.forEach(visit);
    };
    scene.updateMatrixWorld(true);
    room.group.children.forEach(visit);
    const glb = await new GLTFExporter().parseAsync(out, { binary: true });
    const bytes = new Uint8Array(glb);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

window.__room = {
    exportProps,
    room, renderer, scene, camera, setShot, setState, loadMs, t0,
    stats: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, programs: renderer.info.programs.length, fps, baked: room.baked, loadMs }),
    ready: true
};
