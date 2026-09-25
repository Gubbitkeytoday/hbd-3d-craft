/**
 * Streams the baked room (public/room/): a manifest, one meshopt-compressed
 * GLB with WebP material textures, and two lightmap WebPs (DARK / PARTY) at
 * a tier-dependent size. Abortable; every failure rejects so the caller can
 * keep the procedural greybox.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder as BundledMeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { makeBaked } from './materials.js';

const BASE = `${import.meta.env.BASE_URL || '/'}room/`;

export function roomAssetUrl(file) {
    return BASE + file;
}

function abortError() {
    return new DOMException('Aborted', 'AbortError');
}

/**
 * Decoded off the main thread (createImageBitmap, or img.decode() where
 * ImageBitmap options are unreliable), so the upload in initTexture() is a
 * copy, not a 100-200 ms synchronous WebP decode.
 */
async function loadTexture(url, signal) {
    if (signal?.aborted) throw abortError();
    let image;
    if (typeof createImageBitmap === 'function' && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent)) {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`room: failed ${url}`);
        image = await createImageBitmap(await res.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } else {
        image = new Image();
        image.crossOrigin = 'anonymous';
        image.src = url;
        try {
            await image.decode();
        } catch {
            throw new Error(`room: failed ${url}`);
        }
    }
    if (signal?.aborted) throw abortError();
    const tex = new THREE.Texture(image);
    tex.needsUpdate = true;
    return tex;
}

let decoderPromise = null;

/**
 * The meshopt decoder spawns its workers from its own function source, and
 * minification renames what that source refers to ("workerProcess is not
 * defined"), so the bundled copy can only decode on the main thread. The
 * worker-capable copy is served untouched from public/room/vendor/ (MIT,
 * copied from three/examples/jsm/libs) and loaded at runtime; if that fails,
 * the bundled one decodes on the main thread.
 */
function getMeshoptDecoder() {
    // Dev serves the bundled copy unminified (and refuses to import from
    // public/), so workers already work there.
    const source = import.meta.env.DEV
        ? Promise.resolve({ MeshoptDecoder: BundledMeshoptDecoder })
        : import(/* @vite-ignore */ roomAssetUrl('vendor/meshopt_decoder.module.js'));
    decoderPromise ??= source
        .then(async ({ MeshoptDecoder }) => {
            await MeshoptDecoder.ready;
            // Geometry decodes in workers (it was a ~130 ms main-thread block
            // on a throttled phone profile).
            if (typeof Worker === 'function') MeshoptDecoder.useWorkers(2);
            return MeshoptDecoder;
        })
        .catch((err) => {
            console.warn('room: worker decoder unavailable, decoding on the main thread', err);
            return BundledMeshoptDecoder;
        });
    return decoderPromise;
}
const glassCache = new Map();
function glassMaterial(src) {
    const key = src.name;
    if (!glassCache.has(key)) {
        const win = /window/i.test(key);
        const lamp = /lamp/i.test(key);
        // Window: clear sheet. Pendant: frosted (it read as a soap bubble).
        glassCache.set(key, new THREE.MeshStandardMaterial({
            name: src.name, color: lamp ? 0xf4efe6 : 0x9aa4b0, roughness: lamp ? 0.5 : 0.04, metalness: 0,
            transparent: true, opacity: win ? 0.1 : lamp ? 0.35 : 0.16, depthWrite: false
        }));
    }
    src.dispose();
    return glassCache.get(key);
}

/**
 * @returns {Promise<{ group, bakedMaterials, emissive: THREE.Material[], manifest, textures }>}
 */
export async function loadBakedRoom({ quality, uniforms, signal, onProgress }) {
    const res = await fetch(roomAssetUrl('room.json'), { signal });
    if (!res.ok) throw new Error(`room: manifest ${res.status}`);
    const manifest = await res.json();
    const tier = quality >= 2 ? 'high' : 'low';
    const glbFile = manifest.glb[tier] || manifest.glb.low;
    const lm = manifest.lightmaps;
    onProgress?.(0.1);

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(await getMeshoptDecoder());
    const [gltf, dark, party] = await Promise.all([
        new Promise((resolve, reject) => loader.load(roomAssetUrl(glbFile), resolve,
            (e) => { if (e.total) onProgress?.(0.1 + 0.7 * e.loaded / e.total); }, reject)),
        loadTexture(roomAssetUrl(lm.dark[tier] || lm.dark.low), signal),
        loadTexture(roomAssetUrl(lm.party[tier] || lm.party.low), signal)
    ]);
    if (signal?.aborted) throw abortError();

    // Lightmaps are data (sqrt-encoded irradiance), on glTF's uv1, not flipped.
    [dark, party].forEach((t) => {
        t.flipY = false;
        t.colorSpace = THREE.NoColorSpace;
        t.channel = 1;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.needsUpdate = true;
    });
    uniforms.uLmParty.value = party;

    const bakedMaterials = new Set();
    const emissive = new Set();
    const group = gltf.scene;
    group.name = 'room-baked';
    group.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.matrixAutoUpdate = false;
        obj.updateMatrix();
        const mat = obj.material;
        const name = (mat.name || '').toLowerCase();
        if (name.startsWith('emit')) {
            // Lamp shades / bulbs / LED strips: switched with the party lights.
            mat.userData.emitBase = mat.emissiveIntensity || 1;
            emissive.add(mat);
            return;
        }
        if (name.includes('glass')) {
            // Blender's transmissive glass would make three render a whole
            // extra transmission pass every frame: a thin reflective sheet
            // reads the same at this size.
            obj.material = glassMaterial(mat);
            return;
        }
        if (!obj.geometry.attributes.uv1) return;
        if (!mat.userData.roomBaked) {
            // Glossy parquet mirrored the pink bunting/balloons as blotches:
            // keep its reflection a sheen, not a mirror.
            if (/floor|parquet/.test(name)) mat.envMapIntensity = 0.45;
            mat.lightMap = dark;
            makeBaked(mat, uniforms);
        }
        bakedMaterials.add(mat);
    });
    onProgress?.(0.95);
    return { group, bakedMaterials: [...bakedMaterials], emissive: [...emissive], manifest, textures: [dark, party] };
}
