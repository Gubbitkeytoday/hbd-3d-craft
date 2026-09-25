/**
 * Low-level cake construction kit: geometry helpers, procedural textures,
 * materials and decoration factories shared by every model in ./models/.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fontReadyForCanvas, fontsAvailable, splitWords, truncateGraphemes } from '../fonts.js';

/* ------------------------------------------------------------------ *
 * Draw-call budget
 * ------------------------------------------------------------------ *
 *
 * These cakes are decoration-dense — a rose is a dozen petals, a pearl band is
 * fifty spheres — and on a phone the draw calls, not the triangles, are what
 * drop frames. Two tools keep that in check:
 *
 *   partsToMesh()  bakes a multi-part decoration that always shares one
 *                  material (rose, macaron, bow, daisy) into a single mesh
 *   instanceRing() draws a whole ring of identical beads in one call
 *
 * Between them, the three-tier cake went from ~700 meshes to well under half
 * that while looking identical.
 */

const _partDummy = new THREE.Object3D();

/**
 * Clones `geo` transformed by the given TRS. Collect several and hand them to
 * partsToMesh() to bake them into one geometry.
 */
export function part(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = 1 } = {}) {
    _partDummy.position.set(pos[0], pos[1], pos[2]);
    _partDummy.rotation.set(rot[0], rot[1], rot[2]);
    if (Array.isArray(scale)) _partDummy.scale.set(scale[0], scale[1], scale[2]);
    else _partDummy.scale.setScalar(scale);
    _partDummy.updateMatrix();

    const g = geo.clone();
    g.applyMatrix4(_partDummy.matrix);
    return g;
}

/** Merges baked parts into one shadow-casting mesh. */
export function partsToMesh(parts, material) {
    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

/**
 * One InstancedMesh for a ring of identical beads.
 * `place(dummy, i)` positions the shared Object3D for instance i.
 */
export function instanceRing(geo, material, count, place) {
    const mesh = new THREE.InstancedMesh(geo, material, count);
    for (let i = 0; i < count; i++) {
        place(_partDummy, i);
        _partDummy.updateMatrix();
        mesh.setMatrixAt(i, _partDummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

/** Scales a decoration count by the detail budget, never below a floor. */
export function scaleCount(n, detail, floor = 6) {
    return Math.max(floor, Math.round(n * detail));
}

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

/**
 * mulberry32. The cake has to be reproducible: the same share link must
 * render the same cake for the sender previewing it and the recipient opening
 * it a week later. Sprinkle scatter used Math.random and re-rolled on every
 * rebuild, so the preview and the delivered card never quite agreed.
 */
export function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function rng() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Stable 32-bit hash of a string, so a theme/model name can seed the RNG. */
export function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/* ------------------------------------------------------------------ *
 * Shared GPU resources (textures + materials)
 * ------------------------------------------------------------------ *
 *
 * The creator rebuilds the whole cake on every slider tick. Recreating every
 * canvas texture and material each time leaked two textures per rebuild
 * (material.dispose() never frees maps) and, worse, disposing the materials
 * released their GL programs, so the identical new materials recompiled from
 * scratch (13 program links per tick). Deterministic textures are now
 * lazy singletons, per-colour/per-text ones sit in small LRU caches, and
 * kit materials are memoised by their constructor parameters.
 *
 * Rules for kit code:
 *   - never mutate a material returned by sharedMaterial() or by the
 *     getXxxMaterial / createXxxMaterial factories; pass the variant as parameters instead
 *   - callers free a built cake with disposeCakeGroup() (cake-models.js),
 *     which skips everything isKitShared() reports
 * Disposing a shared resource by mistake is safe (three re-uploads or
 * recompiles it on next use); it only costs the time the cache saves.
 */

const SHARED = new WeakSet();

/** True for textures/materials owned by the kit caches (never dispose them per rebuild). */
export function isKitShared(resource) {
    return !!resource && SHARED.has(resource);
}

function markShared(resource) {
    SHARED.add(resource);
    return resource;
}

/** Tiny LRU: Map keeps insertion order, so re-inserting on hit moves a key to the end. */
function lruCache(limit, onEvict) {
    const map = new Map();
    return {
        get(key, create) {
            if (map.has(key)) {
                const value = map.get(key);
                map.delete(key);
                map.set(key, value);
                return value;
            }
            const value = create();
            map.set(key, value);
            while (map.size > limit) {
                const [oldKey, oldValue] = map.entries().next().value;
                map.delete(oldKey);
                // A material still on screen survives this: three re-creates
                // its GPU state on the next render.
                SHARED.delete(oldValue);
                onEvict(oldValue);
            }
            return value;
        }
    };
}

/** Marks every geometry under `root` as kit-owned (disposeCakeGroup skips it). */
export function adoptSharedGeometries(root) {
    root.traverse((obj) => { if (obj.geometry) SHARED.add(obj.geometry); });
    return root;
}

/** Reverses adoptSharedGeometries and frees the GPU copies. */
export function releaseSharedGeometries(root) {
    root.traverse((obj) => {
        if (obj.geometry && SHARED.has(obj.geometry)) {
            SHARED.delete(obj.geometry);
            obj.geometry.dispose();
        }
    });
}

const permanentTextures = new Map();
const keyedTextures = lruCache(40, (tex) => tex.dispose());
const materialCache = lruCache(192, (mat) => mat.dispose());

/** Deterministic texture, painted once per page load. */
export function permanentTexture(key, paint) {
    if (!permanentTextures.has(key)) permanentTextures.set(key, markShared(paint()));
    return permanentTextures.get(key);
}

/** Parameterised texture (colour, text...), kept in a small LRU cache. */
export function sharedTexture(key, paint) {
    return keyedTextures.get(key, () => markShared(paint()));
}

const ctorIds = new WeakMap();
let nextCtorId = 1;
function ctorId(Ctor) {
    // Class names are mangled by the minifier, so key constructors by identity.
    if (!ctorIds.has(Ctor)) ctorIds.set(Ctor, nextCtorId++);
    return ctorIds.get(Ctor);
}

// Hand-rolled instead of JSON.stringify: stringify calls toJSON() on every
// value before a replacer sees it, and Texture.toJSON() serialises the whole
// canvas to a data URL (~250 ms per cake build).
function paramKey(value) {
    if (value === null || typeof value !== 'object') {
        return typeof value === 'string' ? JSON.stringify(value) : String(value);
    }
    if (value.isColor) return `c(${value.r},${value.g},${value.b})`;
    if (value.isTexture) return `t(${value.uuid})`;
    if (value.isVector2) return `v(${value.x},${value.y})`;
    if (Array.isArray(value)) return `[${value.map(paramKey).join(',')}]`;
    return `{${Object.keys(value).map((k) => `${k}:${paramKey(value[k])}`).join(',')}}`;
}

const geometryCache = lruCache(700, (geo) => geo.dispose());

/**
 * Geometry memoised by a caller-chosen key. Decorations are rebuilt with the
 * same parameters on every slider tick (and a ring repeats one shape dozens
 * of times), so deforming spheres and merging parts once per key is what
 * brings a rebuild from ~400 ms down to tens of ms. Never mutate the result.
 */
export function sharedGeometry(key, build) {
    return geometryCache.get(key, () => markShared(build()));
}

/** Shared SphereGeometry by its constructor arguments. */
export function sharedSphere(radius, w, h) {
    return sharedGeometry(`sphere|${radius}|${w}|${h}`, () => new THREE.SphereGeometry(radius, w, h));
}

/** partsToMesh() whose merged geometry is built once per key. */
export function sharedPartsMesh(key, buildParts, material) {
    const geo = sharedGeometry(key, () => {
        const parts = buildParts();
        const merged = mergeGeometries(parts, false);
        parts.forEach((g) => g.dispose());
        merged.computeVertexNormals();
        return merged;
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

// Ridge phase and lean of piped cream only vary with sin/cos(seed), so 12
// phase variants look as hand-made as one per rosette and share geometry.
const TAU = Math.PI * 2;
const SEED_VARIANTS = 12;
function quantizeSeed(seed) {
    const t = (((seed % TAU) + TAU) % TAU) / TAU;
    return (Math.round(t * SEED_VARIANTS) % SEED_VARIANTS) * (TAU / SEED_VARIANTS);
}

/**
 * `new Ctor(params)`, memoised by (constructor, params). Identical requests
 * return the same instance, so a rebuild reuses both the material and its
 * compiled program. Do not mutate the result.
 */
export function sharedMaterial(Ctor, params = {}) {
    return materialCache.get(`${ctorId(Ctor)}|${paramKey(params)}`, () => markShared(new Ctor(params)));
}

/* ------------------------------------------------------------------ *
 * Procedural textures
 * ------------------------------------------------------------------ */

export function createCakeCrumbBumpTexture() {
    return permanentTexture('crumb-bump', paintCakeCrumbBumpTexture);
}

function paintCakeCrumbBumpTexture() {
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Palette-knife swipe marks. Fine crumb noise alone left the tier sides
    // looking like smooth plastic — the broad vertical strokes a spatula
    // leaves while smoothing buttercream are the real tell of a frosted cake.
    const SWIPES = 34;
    ctx.lineCap = 'round';
    for (let i = 0; i < SWIPES; i++) {
        const t = i / SWIPES;
        const x = t * SIZE;
        const lift = Math.sin(i * 2.7) * 26;
        const width = 12 + Math.abs(Math.cos(i * 1.9)) * 20;
        const bow = Math.sin(i * 1.3) * 26;

        ctx.strokeStyle = `rgba(${128 + lift}, ${128 + lift}, ${128 + lift}, 0.55)`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x, -10);
        ctx.quadraticCurveTo(x + bow, SIZE / 2, x + Math.sin(i * 2.1) * 14, SIZE + 10);
        ctx.stroke();

        // Thin bright ridge on one side of the stroke, where frosting piles up
        ctx.strokeStyle = `rgba(${150 + lift * 0.4}, ${150 + lift * 0.4}, ${150 + lift * 0.4}, 0.3)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + width * 0.4, -10);
        ctx.quadraticCurveTo(x + bow + width * 0.4, SIZE / 2, x + Math.sin(i * 2.1) * 14 + width * 0.4, SIZE + 10);
        ctx.stroke();
    }

    // Micro-pores and crumbs over the swipes. Seeded, not Math.random, so the
    // finish is identical in the preview and the delivered card. Stamped
    // straight into the pixel buffer: 26k canvas arc() fills with a fresh
    // fillStyle string each took ~45 ms, this takes a few.
    const rng = makeRng(0xc4ce0001);
    const img = ctx.getImageData(0, 0, SIZE, SIZE);
    const px = img.data;
    const ALPHA = 0.55;
    for (let i = 0; i < 26000; i++) {
        const x = rng() * SIZE;
        const y = rng() * SIZE;
        const radius = 0.4 + rng() * 1.6;
        const heightVal = Math.floor(rng() * 60) - 30;
        const color = Math.min(255, Math.max(0, 128 + heightVal));
        const r2 = radius * radius;
        const x0 = Math.max(0, Math.floor(x - radius));
        const x1 = Math.min(SIZE - 1, Math.ceil(x + radius));
        const y0 = Math.max(0, Math.floor(y - radius));
        const y1 = Math.min(SIZE - 1, Math.ceil(y + radius));
        for (let py = y0; py <= y1; py++) {
            for (let pxl = x0; pxl <= x1; pxl++) {
                const dx = pxl + 0.5 - x;
                const dy = py + 0.5 - y;
                if (dx * dx + dy * dy > r2) continue;
                const k = (py * SIZE + pxl) * 4;
                const v = px[k] + (color - px[k]) * ALPHA;
                px[k] = v;
                px[k + 1] = v;
                px[k + 2] = v;
            }
        }
    }
    ctx.putImageData(img, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 1);
    return texture;
}

export function createCarbonFiberTexture() {
    return permanentTexture('carbon-fiber', paintCarbonFiberTexture);
}

function paintCarbonFiberTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111113';
    ctx.fillRect(0, 0, 64, 64);

    ctx.fillStyle = '#1c1c1f';
    for (let y = 0; y < 64; y += 8) {
        for (let x = 0; x < 64; x += 8) {
            if ((x + y) % 16 === 0) {
                ctx.fillRect(x, y, 4, 8);
                ctx.fillRect(x + 4, y + 4, 4, 8);
            }
        }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 12);
    return texture;
}

export function createHolographicScannerTexture(colorStr) {
    return sharedTexture(`scanner|${colorStr}`, () => paintHolographicScannerTexture(colorStr));
}

function paintHolographicScannerTexture(colorStr) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 512);

    ctx.strokeStyle = colorStr;
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 18;

    ctx.lineWidth = 4;
    ctx.setLineDash([20, 20, 5, 20]);
    ctx.beginPath();
    ctx.arc(256, 256, 220, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(256, 256, 185, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 3;
    ctx.setLineDash([8, 15]);
    ctx.beginPath();
    ctx.arc(256, 256, 140, 0, Math.PI * 2);
    ctx.stroke();

    ctx.shadowBlur = 6;
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.fillStyle = colorStr;
    ctx.textAlign = 'center';
    ctx.fillText('QUANTUM GRID PROJ V4.0', 256, 256 - 95);
    ctx.fillText('STATUS // ACTIVE_SCAN', 256, 256 + 105);

    return new THREE.CanvasTexture(canvas);
}

/**
 * Side of a rolled wafer stick: golden baked wafer spiralling around the
 * tube with a chocolate cream stripe in the seam. The old texture was thick
 * dark diagonals on beige, which at stick scale read as a striped matchstick.
 * Painted per pixel so the spiral wraps seamlessly around the circumference
 * (u) and the length (v).
 */
export function createWaferRollTexture() {
    return permanentTexture('wafer-roll', paintWaferRollTexture);
}

function paintWaferRollTexture() {
    const W = 128;
    const H = 256;
    const TURNS = 3;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);

    const wafer = new THREE.Color(0xd99a52);
    const waferLight = new THREE.Color(0xf0c47e);
    const choco = new THREE.Color(0x3b1c0b);
    const c = new THREE.Color();
    const smooth = THREE.MathUtils.smoothstep;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const t = ((x / W + (y / H) * TURNS) % 1 + 1) % 1;
            // Baked colour: lighter mid-band on each wafer turn, fine grain
            // across it, darker where it tucks under the next turn.
            const band = Math.sin(t * Math.PI);
            c.copy(wafer).lerp(waferLight, band * 0.6);
            const grain = 0.94 + 0.06 * Math.sin((x / W) * Math.PI * 2 * 24 + y * 0.9);
            c.multiplyScalar(grain * (0.85 + 0.15 * smooth(t, 0.0, 0.1)));
            // Chocolate stripe in the seam, with soft edges.
            const m = smooth(t, 0.8, 0.83) * (1 - smooth(t, 0.95, 0.98));
            c.lerp(choco, m);
            const k = (y * W + x) * 4;
            img.data[k] = Math.round(Math.min(1, c.r) * 255);
            img.data[k + 1] = Math.round(Math.min(1, c.g) * 255);
            img.data[k + 2] = Math.round(Math.min(1, c.b) * 255);
            img.data[k + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

/**
 * Holographic hex-grid inlay for the Neo-Prism tiers. A flat metal hexagon
 * reads as a chrome nut; an emissive circuit lattice on its faces is what
 * sells "crystal data prism".
 */
export function createHexGridEmissiveTexture(colorStr) {
    return sharedTexture(`hex-grid|${colorStr}`, () => paintHexGridEmissiveTexture(colorStr));
}

function paintHexGridEmissiveTexture(colorStr) {
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, SIZE, SIZE);

    const R = 34;
    const h = R * Math.sqrt(3);
    ctx.strokeStyle = colorStr;
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2.2;

    for (let row = -1; row * (h / 2) < SIZE + h; row++) {
        for (let col = -1; col * (R * 1.5) < SIZE + R * 2; col++) {
            const cx = col * R * 1.5;
            const cy = row * h + (col % 2 ? h / 2 : 0);
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * Math.PI * 2;
                const px = cx + Math.cos(a) * R;
                const py = cy + Math.sin(a) * R;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.stroke();
        }
    }

    // A few brighter "live" cells, so the grid looks powered rather than printed
    const rng = makeRng(0x4e0f1d33);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = colorStr;
    for (let i = 0; i < 26; i++) {
        const cx = rng() * SIZE;
        const cy = rng() * SIZE;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            const px = cx + Math.cos(a) * R * 0.86;
            const py = cy + Math.sin(a) * R * 0.86;
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 1);
    return texture;
}

/** Per-theme plaque styling for the custom-text topper. */
const TOPPER_STYLES = {
    'neon-rose': { bg: 'rgba(15, 10, 25, 0.85)', text: '#ff0055', border: '#00f2fe', glow: '#ff0055', font: 'sans' },
    'midnight-gold': { bg: 'rgba(10, 8, 5, 0.9)', text: '#ffd700', border: '#ffd700', glow: '#ffd700', font: 'serif' },
    'pastel-mint': { bg: 'rgba(5, 15, 20, 0.85)', text: '#00f2fe', border: '#4facfe', glow: '#00f2fe', font: 'sans' },
    'lavender-dream': { bg: 'rgba(15, 5, 20, 0.88)', text: '#f355ff', border: '#8000ff', glow: '#f355ff', font: 'sans' },
    'sakura-blossom': { bg: 'rgba(31, 12, 17, 0.9)', text: '#ff758f', border: '#ffb3c6', glow: '#ff758f', font: 'script' },
    'cyber-retro': { bg: 'rgba(24, 0, 38, 0.9)', text: '#ff3399', border: '#ff9966', glow: '#ff3399', font: 'sans' },
    'forest-moss': { bg: 'rgba(0, 23, 10, 0.9)', text: '#00ff88', border: '#ffd700', glow: '#00ff88', font: 'serif' },
    'cosmic-nebula': { bg: 'rgba(7, 0, 20, 0.9)', text: '#8a2be2', border: '#00f2fe', glow: '#00ffd5', font: 'sans' },
    'choco-monarch': { bg: 'rgba(20, 9, 4, 0.9)', text: '#cca43b', border: '#5c3d2e', glow: '#cca43b', font: 'serif' }
};

// Latin face first, then its Thai partner: canvas falls back per glyph, so a
// mixed "Happy Birthday + Thai name" uses both. Before this, Thai was drawn
// in whatever system font the OS had, since none of the Latin faces has Thai.
const TOPPER_FONTS = {
    sans: { families: ['Outfit', 'Noto Sans Thai'], generic: 'sans-serif', weight: 700 },
    serif: { families: ['Playfair Display', 'Noto Serif Thai'], generic: 'serif', weight: 700 },
    // Great Vibes only ships 400; Mali (its Thai partner) is loaded at 500/600
    // and the browser picks the nearest weight.
    script: { families: ['Great Vibes', 'Mali'], generic: 'cursive', weight: 400 }
};

const TOPPER_W = 512;
const TOPPER_H = 256;
const TOPPER_MAX_GRAPHEMES = 28;

function topperSpec(text, themeName, customGlowColor) {
    const style = { ...(TOPPER_STYLES[themeName] || TOPPER_STYLES['neon-rose']) };
    if (customGlowColor) {
        style.text = customGlowColor;
        style.border = customGlowColor;
        style.glow = customGlowColor;
    }
    const clean = truncateGraphemes(String(text ?? '').trim(), TOPPER_MAX_GRAPHEMES);
    return { style, font: TOPPER_FONTS[style.font], text: clean };
}

function fontString(font, size) {
    const stack = font.families.map((f) => `"${f}"`).join(', ');
    return `${font.weight} ${Math.round(size)}px ${stack}, ${font.generic}`;
}

/**
 * Picks one or two lines and the largest size that fits the plaque. Thai has
 * no spaces, so candidate breaks come from Intl.Segmenter word boundaries.
 */
function layoutTopperText(ctx, text, font) {
    const MAX_W = TOPPER_W - 72;
    const MAX_H = TOPPER_H - 60;
    // Stacked Thai vowels and tone marks need extra leading above and below.
    const lineH = /[฀-๿]/.test(text) ? 1.4 : 1.18;
    const MAX_SIZE = 92;
    const REF = 100;
    ctx.font = fontString(font, REF);
    const widthAt = (str) => ctx.measureText(str).width;

    const single = Math.min(MAX_SIZE, MAX_H / lineH, (REF * MAX_W) / Math.max(1, widthAt(text)));
    let best = { lines: [text], size: single };

    const words = splitWords(text);
    if (single < 64 && words.length > 1) {
        for (let i = 1; i < words.length; i++) {
            const a = words.slice(0, i).join('').trim();
            const b = words.slice(i).join('').trim();
            if (!a || !b) continue;
            const w = Math.max(widthAt(a), widthAt(b));
            const size = Math.min(MAX_SIZE, MAX_H / (2 * lineH), (REF * MAX_W) / Math.max(1, w));
            // Two lines only when that buys a clearly bigger size.
            if (size > best.size * 1.12) best = { lines: [a, b], size };
        }
    }
    return { ...best, lineH };
}

function paintTopper(canvas, spec) {
    const ctx = canvas.getContext('2d');
    const { style, font, text } = spec;
    ctx.clearRect(0, 0, TOPPER_W, TOPPER_H);
    ctx.shadowBlur = 0;

    ctx.fillStyle = style.bg;
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 12;
    const r = 24;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(TOPPER_W - r, 0);
    ctx.quadraticCurveTo(TOPPER_W, 0, TOPPER_W, r);
    ctx.lineTo(TOPPER_W, TOPPER_H - r);
    ctx.quadraticCurveTo(TOPPER_W, TOPPER_H, TOPPER_W - r, TOPPER_H);
    ctx.lineTo(r, TOPPER_H);
    ctx.quadraticCurveTo(0, TOPPER_H, 0, TOPPER_H - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (!text) return;
    const { lines, size, lineH } = layoutTopperText(ctx, text, font);
    ctx.font = fontString(font, size);
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = Math.max(8, size * 0.22);
    ctx.fillStyle = style.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const step = size * lineH;
    const top = TOPPER_H / 2 - (step * (lines.length - 1)) / 2;
    lines.forEach((line, i) => ctx.fillText(line, TOPPER_W / 2, top + i * step));
}

/**
 * Canvas texture for the custom-text plaque, cached by text + theme + colour.
 *
 * Text is sized to fit (one or two lines) by measuring it, not by `.length`,
 * which over-counted Thai. If the plaque's font is not loaded yet, the
 * texture is painted with the fallback now and repainted in place once the
 * font arrives, so a build never bakes the wrong face in permanently. Callers
 * that want the right face on the very first frame can
 * `await preloadTopperFont(text, themeName)` before building.
 */
export function createCustomTopperTexture(text, themeName, customGlowColor = '') {
    const spec = topperSpec(text, themeName, customGlowColor);
    return sharedTexture(`topper|${spec.text}|${themeName}|${customGlowColor}`, () => {
        const canvas = document.createElement('canvas');
        canvas.width = TOPPER_W;
        canvas.height = TOPPER_H;
        paintTopper(canvas, spec);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        if (spec.text && !fontsAvailable(spec.font.families, spec.text, spec.font.weight)) {
            fontReadyForCanvas(spec.font.families, spec.text, { weight: spec.font.weight }).then(() => {
                paintTopper(canvas, spec);
                texture.needsUpdate = true;
            });
        }
        return texture;
    });
}

/** Resolves once the topper for this text/theme can be drawn in its real font. */
export function preloadTopperFont(text, themeName = 'neon-rose') {
    const spec = topperSpec(text, themeName, '');
    if (!spec.text) return Promise.resolve(true);
    return fontReadyForCanvas(spec.font.families, spec.text, { weight: spec.font.weight });
}

/* ------------------------------------------------------------------ *
 * Base geometry
 * ------------------------------------------------------------------ */

export function createBeveledCylinder(radius, height, bevelRadius) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, radius - bevelRadius, 0, Math.PI * 2, false);

    // Scale the silhouette resolution with the actual radius. A flat 24 left
    // the big 2-unit tiers visibly faceted while over-tessellating the small
    // stand parts nobody looks at.
    const curveSegments = Math.min(96, Math.max(24, Math.round(radius * 36)));

    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: height - bevelRadius * 2,
        steps: 1,
        bevelEnabled: true,
        bevelSegments: 6,
        bevelSize: bevelRadius,
        bevelThickness: bevelRadius,
        curveSegments
    });
    geo.center();
    geo.rotateX(Math.PI / 2);
    return geo;
}

/**
 * The heart profile every heart-shaped part is derived from.
 *
 * Local extents for a given `scale` (with s = scale * 0.95):
 *   x ∈ [-1.78s, 1.78s]   y ∈ [-1.85s, 1.5s]
 * The y range is asymmetric, which matters — see HEART_CENTER_RATIO.
 *
 * Proportions are what make it read as a heart from a 30° camera: a cleft
 * cut 0.55s deep between full round lobes, and sides that run almost straight
 * into the point. The previous profile's lobes bulged 2.15s out over a very
 * shallow, knife-sharp cleft, so from above it looked like two drums fused
 * together with a crack between them.
 */
export function getHeartShape(scale = 1.0) {
    const shape = new THREE.Shape();
    const s = scale * 0.95;
    shape.moveTo(0, 0.95 * s);
    shape.bezierCurveTo(0.14 * s, 1.24 * s, 0.46 * s, 1.5 * s, 0.9 * s, 1.5 * s);
    shape.bezierCurveTo(1.42 * s, 1.5 * s, 1.78 * s, 1.12 * s, 1.78 * s, 0.6 * s);
    shape.bezierCurveTo(1.78 * s, -0.12 * s, 0.62 * s, -1.08 * s, 0, -1.85 * s);
    shape.bezierCurveTo(-0.62 * s, -1.08 * s, -1.78 * s, -0.12 * s, -1.78 * s, 0.6 * s);
    shape.bezierCurveTo(-1.78 * s, 1.12 * s, -1.42 * s, 1.5 * s, -0.9 * s, 1.5 * s);
    shape.bezierCurveTo(-0.46 * s, 1.5 * s, -0.14 * s, 1.24 * s, 0, 0.95 * s);
    return shape;
}

/**
 * Heart parts are centred on the profile's bounding box, which shifts it up
 * by this fraction of s because the y range isn't symmetric about 0:
 *   centre = (1.5s + (-1.85s)) / 2 = -0.175s
 *
 * Every decoration that follows the heart perimeter has to apply the same
 * shift or it floats off the cake. heartPerimeterPoints() does it for you.
 */
export const HEART_CENTER_RATIO = 0.175;

/**
 * Dense, evenly spaced, slightly smoothed outline in shape space with outward
 * normals, starting at the cleft and running over one lobe to the point.
 *
 * The Laplacian passes round the point and the cleft by well under a tenth of
 * a unit. A mathematically sharp corner can't take a rounded top edge (the
 * inset rings cross over each other there), and the sharp cleft is exactly
 * what drew the old dark seam down the middle of the cake.
 */
function heartOutline(scale) {
    const n = 480;
    let pts = getHeartShape(scale).getSpacedPoints(n).slice(0, n).map((p) => [p.x, p.y]);
    for (let pass = 0; pass < 28; pass++) {
        pts = pts.map((p, i) => {
            const a = pts[(i - 1 + n) % n];
            const b = pts[(i + 1) % n];
            return [p[0] * 0.5 + (a[0] + b[0]) * 0.25, p[1] * 0.5 + (a[1] + b[1]) * 0.25];
        });
    }

    // The winding decides which side of the tangent is "out". A signed area
    // is robust where a centroid test isn't (along the flanks of the cleft).
    let area = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        area += a[0] * b[1] - b[0] * a[1];
    }
    const sign = area < 0 ? -1 : 1;

    const normals = [];
    const lengths = [0];
    for (let i = 0; i < n; i++) {
        const a = pts[(i - 1 + n) % n];
        const b = pts[(i + 1) % n];
        const tx = b[0] - a[0];
        const ty = b[1] - a[1];
        const len = Math.hypot(tx, ty) || 1;
        // CCW outline: outward = tangent rotated -90°
        normals.push([(sign * ty) / len, (sign * -tx) / len]);
        const c = pts[(i + 1) % n];
        lengths.push(lengths[i] + Math.hypot(c[0] - pts[i][0], c[1] - pts[i][1]));
    }
    return { pts, normals, lengths, total: lengths[n] };
}

/**
 * `count` points evenly spaced by arc length from the cleft, each with its
 * outward normal. For even counts index count/2 lands exactly on the point,
 * so decorations come out mirror-symmetric.
 */
function sampleHeart(scale, count) {
    const { pts, normals, lengths, total } = heartOutline(scale);
    const n = pts.length;
    const out = [];
    let k = 0;
    for (let i = 0; i < count; i++) {
        const target = (i / count) * total;
        while (k < n - 1 && lengths[k + 1] < target) k++;
        const f = (target - lengths[k]) / ((lengths[k + 1] - lengths[k]) || 1);
        const a = pts[k];
        const b = pts[(k + 1) % n];
        const na = normals[k];
        const nb = normals[(k + 1) % n];
        const nx = na[0] + (nb[0] - na[0]) * f;
        const ny = na[1] + (nb[1] - na[1]) * f;
        const nl = Math.hypot(nx, ny) || 1;
        out.push({
            x: a[0] + (b[0] - a[0]) * f,
            y: a[1] + (b[1] - a[1]) * f,
            nx: nx / nl,
            ny: ny / nl
        });
    }
    return { samples: out, perimeter: total };
}

/**
 * A heart slab: straight walls, a rounded top edge of radius `bevelSize`, a
 * tighter one at the foot, and flat caps. Centred on its bounding box with
 * the point facing +Z, like the ExtrudeGeometry version it replaces.
 *
 * Built by hand because ExtrudeGeometry emits non-indexed triangles: the
 * walls shaded as flat facets and the bevel creased where the lobes meet.
 * Here every ring shares vertices all the way round, so normals are smooth.
 * Note the wall sits exactly on the outline (Extrude's bevel pushed it out
 * by bevelSize).
 */
export function createHeartCakeGeometry(scale, height, bevelSize) {
    const N = 168;
    const { samples } = sampleHeart(scale, N);
    const zShift = HEART_CENTER_RATIO * scale * 0.95;
    const r = Math.min(bevelSize, height * 0.45);
    const rb = r * 0.5;
    const ARC = 6;

    // Profile rows: [offset along the outward normal, height, cos, sin]
    const prof = [];
    for (let k = 0; k <= ARC; k++) {
        const phi = -Math.PI / 2 + (k / ARC) * (Math.PI / 2);
        prof.push([-rb + rb * Math.cos(phi), rb + rb * Math.sin(phi), Math.cos(phi), Math.sin(phi)]);
    }
    for (let k = 0; k <= ARC; k++) {
        const phi = (k / ARC) * (Math.PI / 2);
        prof.push([-r + r * Math.cos(phi), height - r + r * Math.sin(phi), Math.cos(phi), Math.sin(phi)]);
    }
    const rows = prof.length;

    const pos = [];
    const nor = [];
    const uv = [];
    const idx = [];
    const toWorld = (p, d, h) => [p.x + p.nx * d, h - height / 2, -(p.y + p.ny * d + zShift)];

    // Side: N + 1 columns so the UV seam (at the cleft, facing away) can wrap
    for (let i = 0; i <= N; i++) {
        const p = samples[i % N];
        for (let j = 0; j < rows; j++) {
            const [d, h, c, sn] = prof[j];
            pos.push(...toWorld(p, d, h));
            nor.push(p.nx * c, sn, -p.ny * c);
            uv.push(i / N, h / height);
        }
    }
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < rows - 1; j++) {
            const a = i * rows + j;
            const b = (i + 1) * rows + j;
            idx.push(a, b, b + 1, a, b + 1, a + 1);
        }
    }
    const sideIndexCount = idx.length;

    // Caps: flat, with their own vertices (planar UVs), triangulated from the
    // innermost ring of the rounded edges.
    const up = new THREE.Vector3();
    const faceNormal = (a, b, c) => {
        const va = new THREE.Vector3().fromArray(pos, a * 3);
        const vb = new THREE.Vector3().fromArray(pos, b * 3).sub(va);
        const vc = new THREE.Vector3().fromArray(pos, c * 3).sub(va);
        return vb.cross(vc);
    };
    const cap = (row, dir) => {
        const base = pos.length / 3;
        const contour = [];
        for (let i = 0; i < N; i++) {
            const w = toWorld(samples[i], prof[row][0], prof[row][1]);
            pos.push(...w);
            nor.push(0, dir, 0);
            uv.push(w[0] / 3 + 0.5, w[2] / 3 + 0.5);
            contour.push(new THREE.Vector2(w[0], w[2]));
        }
        up.set(0, dir, 0);
        THREE.ShapeUtils.triangulateShape(contour, []).forEach(([a, b, c]) => {
            if (faceNormal(base + a, base + b, base + c).dot(up) >= 0) idx.push(base + a, base + b, base + c);
            else idx.push(base + a, base + c, base + b);
        });
    };
    cap(rows - 1, 1);
    cap(0, -1);

    // Side winding follows the outline's direction, so test one wall quad
    // against its intended normal and flip the side if it faces inward.
    const wall = ARC; // first vertex of the straight wall in column 0
    const wantN = new THREE.Vector3().fromArray(nor, wall * 3);
    if (faceNormal(wall, rows + wall, rows + wall + 1).dot(wantN) < 0) {
        for (let t = 0; t < sideIndexCount; t += 3) {
            const tmp = idx[t + 1];
            idx[t + 1] = idx[t + 2];
            idx[t + 2] = tmp;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return geo;
}

export function createHexPrismGeometry(radius, height, bevelRadius) {
    const shape = new THREE.Shape();
    const sides = 6;
    for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const x = Math.cos(a) * (radius - bevelRadius);
        const y = Math.sin(a) * (radius - bevelRadius);
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
    }
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: height - bevelRadius * 2,
        steps: 1,
        bevelEnabled: true,
        bevelSegments: 4,
        bevelSize: bevelRadius,
        bevelThickness: bevelRadius,
        curveSegments: 16
    });
    geo.center();
    geo.rotateX(Math.PI / 2);
    return geo;
}

/** Rounded-rectangle profile, used for the bento tray and its walls. */
export function roundedRectShape(width, depth, radius, PathClass = THREE.Shape) {
    const w = width / 2;
    const d = depth / 2;
    const r = Math.min(radius, w, d);
    const s = new PathClass();
    s.moveTo(-w + r, -d);
    s.lineTo(w - r, -d);
    s.quadraticCurveTo(w, -d, w, -d + r);
    s.lineTo(w, d - r);
    s.quadraticCurveTo(w, d, w - r, d);
    s.lineTo(-w + r, d);
    s.quadraticCurveTo(-w, d, -w, d - r);
    s.lineTo(-w, -d + r);
    s.quadraticCurveTo(-w, -d, -w + r, -d);
    s.closePath();
    return s;
}

/**
 * Samples the heart perimeter and returns world-space XZ points with matching
 * outward normals, already corrected for the centering shift. Points are
 * evenly spaced by arc length starting at the cleft; for even counts index
 * count/2 is the point of the heart.
 *
 * @param {number} scale  the same scale passed to createHeartCakeGeometry
 * @param {number} count  number of points
 * @param {number} outset positive pushes outward, negative insets
 * @returns {{x, z, nx, nz, tx, tz, angle}[]} n = outward normal, t = the
 *   direction of travel; `rotation.y = angle` turns a mesh's +X outward
 */
export function heartPerimeterPoints(scale, count, outset = 0) {
    const zShift = HEART_CENTER_RATIO * scale * 0.95;
    const { samples } = sampleHeart(scale, count);
    return samples.map((p, i) => {
        // Tangent from the neighbours, in world XZ (shape y maps to -z)
        const a = samples[(i - 1 + count) % count];
        const b = samples[(i + 1) % count];
        let tx = b.x - a.x;
        let tz = -(b.y - a.y);
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        return {
            x: p.x + p.nx * outset,
            z: -(p.y + p.ny * outset + zShift),
            nx: p.nx,
            nz: -p.ny,
            tx,
            tz,
            angle: Math.atan2(p.ny, p.nx)
        };
    });
}

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

export function getPlateMaterial(plateStyle, customColor = '') {
    // The custom colour is part of the cache key rather than a mutation.
    const plate = (params) => sharedMaterial(THREE.MeshPhysicalMaterial, customColor ? { ...params, color: new THREE.Color(customColor) } : params);
    let mat;
    switch (plateStyle) {
        case 'crystal':
            mat = plate({
                color: 0xffe6f2,
                roughness: 0.04,
                metalness: 0.05,
                transmission: 0.9,
                thickness: 0.4,
                ior: 1.52,
                transparent: true,
                opacity: 0.85,
                clearcoat: 1.0,
                clearcoatRoughness: 0.02
            });
            break;
        case 'golden':
            // Physical, not Standard: clearcoat is a MeshPhysicalMaterial
            // property and was being silently dropped here.
            mat = plate({
                color: 0xd4af37,
                roughness: 0.12,
                metalness: 0.95,
                clearcoat: 0.8,
                clearcoatRoughness: 0.08
            });
            break;
        case 'cosmic':
            mat = plate({
                color: 0x090712,
                roughness: 0.22,
                metalness: 0.88,
                bumpMap: createCarbonFiberTexture(),
                bumpScale: 0.015,
                clearcoat: 1.0,
                clearcoatRoughness: 0.02
            });
            break;
        case 'ceramic':
        default:
            // Glazed stoneware, not a mirror: a near-perfect clearcoat turned
            // the theme-tinted rim light into a pinpoint on the plate edge
            // bright enough to bloom into a white blob on light themes.
            mat = plate({
                color: 0xfbfbf8,
                roughness: 0.3,
                metalness: 0.02,
                clearcoat: 0.55,
                clearcoatRoughness: 0.22
            });
            break;
    }
    return mat;
}

/**
 * Mirror glaze: wet, mirror-bright, and *opaque*.
 *
 * Every flavour previously shared transmission 0.88, which turned the
 * chocolate cap into a slab of brown glass you could read the candles
 * through. Real ganache and mirror glaze reflect almost everything and
 * transmit almost nothing; only the pale fruit glazes let a little light
 * through at the edges. Transmission is now per-flavour and the shine comes
 * from clearcoat instead.
 */
export function getGlazeMaterial(glazeStyle, customColor = '') {
    let colorHex = 0xfffaf0;
    let roughness = 0.2;
    let transmission = 0.12;
    let thickness = 0.3;

    switch (glazeStyle) {
        case 'chocolate':
            colorHex = 0x3a1f14; // Rich cocoa, lifted slightly so ACES keeps detail
            roughness = 0.06;
            transmission = 0.0;
            thickness = 0.0;
            break;
        case 'strawberry':
            colorHex = 0xe92e52;
            roughness = 0.05;
            transmission = 0.22;
            thickness = 0.28;
            break;
        case 'mint':
            colorHex = 0x7be2a6;
            roughness = 0.1;
            transmission = 0.28;
            thickness = 0.32;
            break;
        case 'cream':
        default:
            colorHex = 0xfffcf7;
            roughness = 0.12;
            transmission = 0.18;
            thickness = 0.26;
            break;
    }

    if (customColor) {
        colorHex = new THREE.Color(customColor);
    }

    return sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: colorHex,
        roughness,
        metalness: 0.02,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        transmission,
        thickness,
        ior: 1.45,
        transparent: transmission > 0
    });
}

/** The glossy piped-cream surface, shared across a whole ring of rosettes. */
export function createButtercreamPipingMaterial(colorHex, overrides = {}) {
    return sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: colorHex,
        roughness: 0.28,
        metalness: 0.02,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        sheen: 0.95,
        sheenColor: new THREE.Color(0xffe6eb),
        ...overrides
    });
}

/** Buttercream: matte-ish body with the fabric-like sheen fat gives frosting. */
export function createButtercreamMaterial(color, crumbBumpTex, bumpScale = 0.16, overrides = {}) {
    return sharedMaterial(THREE.MeshPhysicalMaterial, {
        color,
        roughness: 0.62,
        metalness: 0.0,
        bumpMap: crumbBumpTex,
        bumpScale,
        sheen: 0.6,
        sheenRoughness: 0.7,
        sheenColor: new THREE.Color(0xfff2f5),
        clearcoat: 0.18,
        clearcoatRoughness: 0.6,
        ...overrides
    });
}

export function createGoldMaterial(colorHex = 0xffd76a) {
    return sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: colorHex,
        roughness: 0.16,
        metalness: 1.0,
        clearcoat: 0.7,
        clearcoatRoughness: 0.1
    });
}

/**
 * Unlit, un-tonemapped emissive. The scene runs ACES + UnrealBloom, so a
 * MeshBasicMaterial at full brightness is what actually blooms — an emissive
 * PBR material gets tone-mapped down before the bloom pass ever sees it.
 */
export function createNeonMaterial(colorHex, opacity = 1) {
    return sharedMaterial(THREE.MeshBasicMaterial, {
        color: colorHex,
        toneMapped: false,
        transparent: opacity < 1,
        opacity
    });
}

/* ------------------------------------------------------------------ *
 * Decoration factories
 * ------------------------------------------------------------------ */

/** Fluffy piped cream: sphere deformed into a star-nozzle rosette. */
export function createPipedCreamMesh(colorHex = 0xfffafb, seed = 0, detail = 1, sharedMat = null) {
    const q = quantizeSeed(seed);
    const geo = sharedGeometry(`piped-cream|${detail < 1 ? 0 : 1}|${q}`, () => buildPipedCreamGeometry(q, detail));
    // A ring can hold 40+ of these. Compiling a separate PBR material for
    // each one is pure overhead when they're all the same colour, so callers
    // that pipe a whole ring hand in one shared material.
    const mat = sharedMat || createButtercreamPipingMaterial(colorHex);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function buildPipedCreamGeometry(seed, detail) {
    const R = 0.1;
    // A rosette is ~0.15 units wide on screen; the ridges stop being
    // resolvable well before the segment count does, so phones drop to a
    // coarser sphere. There can be over a hundred of these on one cake.
    const geo = detail < 1
        ? new THREE.SphereGeometry(R, 18, 12)
        : new THREE.SphereGeometry(R, 28, 18);
    const pos = geo.attributes.position;

    // A real star nozzle leaves 5 vertical ridges, and lifting the bag while
    // piping twists them into a spiral. That silhouette — not a smooth dome —
    // is what reads as piped cream rather than a white ball.
    const RIDGE_COUNT = 5;

    for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        let y = pos.getY(i);
        let z = pos.getZ(i);

        if (y > 0) {
            // Clamp at 0: the top pole vertex can land a hair above the radius
            // in float math, and Math.pow(negative, 0.45) is NaN — which
            // poisoned the whole geometry's bounding sphere (breaking frustum
            // culling and raycast hits on the cream).
            const factor = Math.max(0, 1.0 - (y / R));
            x *= Math.pow(factor, 0.45);
            z *= Math.pow(factor, 0.45);
            y *= 1.35; // pull tip upwards
        }

        const radial = Math.hypot(x, z);
        if (radial > 1e-6) {
            const theta = Math.atan2(z, x);
            const heightT = THREE.MathUtils.clamp((y + R) / (R * 2), 0, 1);
            // Keep this shallow — around a tenth of the radius. Deeper than
            // that and the rosette turns into sharp fins instead of cream.
            const depth = R * 0.11 * (1 - heightT);
            const ridge = Math.cos(theta * RIDGE_COUNT + heightT * 2.4 + seed) * depth;
            const scale = (radial + ridge) / radial;
            x *= scale;
            z *= scale;
        }

        // Per-instance lean so a ring of them never looks stamped from one mold
        x += y * (Math.sin(seed) * 0.07);

        pos.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();
    return geo;
}

/**
 * A piped shell — the sideways teardrop a star nozzle leaves when you squeeze,
 * drag and release. Rings of these are the classic top-and-bottom cake border,
 * and they read very differently from a ring of upright rosettes.
 */
export function createPipedShellMesh(colorHex = 0xfffafb, seed = 0, detail = 1, sharedMat = null) {
    const q = quantizeSeed(seed);
    const geo = sharedGeometry(`piped-shell|${detail < 1 ? 0 : 1}|${q}`, () => buildPipedShellGeometry(q, detail));
    const mesh = new THREE.Mesh(geo, sharedMat || createButtercreamPipingMaterial(colorHex));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function buildPipedShellGeometry(seed, detail) {
    const geo = detail < 1
        ? new THREE.SphereGeometry(0.1, 16, 10)
        : new THREE.SphereGeometry(0.1, 24, 16);
    const pos = geo.attributes.position;
    const RIDGES = 5;

    for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        let y = pos.getY(i);
        let z = pos.getZ(i);

        // Fat head at -x tapering into a drag tail at +x
        const t = THREE.MathUtils.clamp((x + 0.1) / 0.2, 0, 1);
        const taper = Math.pow(1 - t, 0.55) * 0.9 + 0.1;
        y *= taper;
        z *= taper;
        x *= 1.45;

        // Ridges run along the drag direction
        const radial = Math.hypot(y, z);
        if (radial > 1e-6) {
            const theta = Math.atan2(z, y);
            const ridge = Math.cos(theta * RIDGES + seed) * 0.011 * (1 - t * 0.6);
            const scale = (radial + ridge) / radial;
            y *= scale;
            z *= scale;
        }

        pos.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();
    return geo;
}

/** Cute minimalist sugar daisy (bento aesthetic). */
export function createDaisyFlowerMesh(petalColor = 0xffffff, centerColor = 0xffd166, sharedMats = null) {
    const flowerGroup = new THREE.Group();

    if (sharedMats && !sharedMats.center) {
        sharedMats.center = sharedMaterial(THREE.MeshStandardMaterial, { color: centerColor, roughness: 0.35 });
        sharedMats.petal = sharedMaterial(THREE.MeshPhysicalMaterial, {
            color: petalColor,
            roughness: 0.45,
            sheen: 0.8,
            sheenColor: new THREE.Color(0xffffff),
            clearcoat: 0.4
        });
    }

    const centerMesh = new THREE.Mesh(
        sharedSphere(0.042, 12, 10),
        sharedMats ? sharedMats.center : sharedMaterial(THREE.MeshStandardMaterial, { color: centerColor, roughness: 0.35 })
    );
    centerMesh.scale.set(1, 0.5, 1);
    centerMesh.castShadow = true;
    flowerGroup.add(centerMesh);

    const buildPetals = () => {
        const petalGeo = new THREE.SphereGeometry(0.035, 10, 8);
        const petals = [];
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            petals.push(part(petalGeo, {
                pos: [Math.cos(a) * 0.058, 0.004, Math.sin(a) * 0.058],
                // Petals tilt up slightly at the tips
                rot: [0, -a, 0.12],
                scale: [1.6, 0.32, 0.8]
            }));
        }
        petalGeo.dispose();
        return petals;
    };

    flowerGroup.add(sharedPartsMesh('daisy-petals', buildPetals, sharedMats ? sharedMats.petal : sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: petalColor,
        roughness: 0.45,
        sheen: 0.8,
        sheenColor: new THREE.Color(0xffffff),
        clearcoat: 0.4
    })));
    return flowerGroup;
}

/** Edible sugar rose rosette. */
export function createRoseRosetteMesh(colorHex = 0xff3366, sharedMat = null) {
    return sharedPartsMesh('rose-rosette', buildRoseParts, sharedMat || sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: colorHex,
        roughness: 0.5,
        metalness: 0.02,
        sheen: 0.7,
        sheenColor: new THREE.Color(0xffffff),
        clearcoat: 0.35,
        clearcoatRoughness: 0.4
    }));
}

function buildRoseParts() {
    const budGeo = new THREE.SphereGeometry(0.06, 14, 12);
    const parts = [part(budGeo, { scale: [0.8, 1.2, 0.8] })];
    budGeo.dispose();

    // Petals spiral outward and open up as they go, like a real rose whorl
    const petalGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.02, 12, 1, false, 0, Math.PI * 1.35);
    const PETALS = 10;
    for (let p = 0; p < PETALS; p++) {
        const a = p * 2.399; // golden angle — never lines up into visible spokes
        const t = p / PETALS;
        parts.push(part(petalGeo, {
            pos: [Math.cos(a) * (0.035 + t * 0.06), 0.03 - t * 0.05, Math.sin(a) * (0.035 + t * 0.06)],
            rot: [0.18 + t * 0.45, -a, 0.12],
            scale: [0.55 + t * 0.85, 0.32, 0.5 + t * 0.7]
        }));
    }
    petalGeo.dispose();
    return parts;
}

// Module-level and shared by every macaron; never disposed per rebuild.
export const MACARON_FILLING_MAT = markShared(new THREE.MeshStandardMaterial({ color: 0xfff4e6, roughness: 0.75 }));

/** Gourmet French macaron. */
export function createMacaronMesh(colorHex = 0xffd700, sharedMat = null) {
    const macGroup = new THREE.Group();

    const buildParts = () => {
        const shellGeo = new THREE.SphereGeometry(0.08, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
        // The "foot" — the ruffled frill around each shell that defines a macaron
        const footGeo = new THREE.TorusGeometry(0.09, 0.014, 8, 20);
        const parts = [
            part(shellGeo, { pos: [0, 0.024, 0], scale: [1.2, 0.6, 1.2] }),
            part(shellGeo, { pos: [0, -0.024, 0], rot: [Math.PI, 0, 0], scale: [1.2, 0.6, 1.2] }),
            part(footGeo, { pos: [0, 0.016, 0], rot: [Math.PI / 2, 0, 0], scale: [1.06, 1.06, 0.8] }),
            part(footGeo, { pos: [0, -0.016, 0], rot: [Math.PI / 2, 0, 0], scale: [1.06, 1.06, 0.8] })
        ];
        shellGeo.dispose();
        footGeo.dispose();
        return parts;
    };

    macGroup.add(sharedPartsMesh('macaron-shells', buildParts, sharedMat || sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: colorHex,
        roughness: 0.55,
        metalness: 0.0,
        sheen: 0.5,
        clearcoat: 0.2
    })));

    const cream = new THREE.Mesh(
        sharedGeometry('macaron-cream', () => new THREE.CylinderGeometry(0.088, 0.088, 0.03, 18)),
        MACARON_FILLING_MAT
    );
    macGroup.add(cream);

    return macGroup;
}

/** Floating cyber crystal shard. */
export function createCrystalShardMaterials(colorHex) {
    return {
        body: sharedMaterial(THREE.MeshPhysicalMaterial, {
            color: colorHex,
            emissive: colorHex,
            emissiveIntensity: 0.75,
            roughness: 0.04,
            metalness: 0.0,
            transmission: 0.9,
            thickness: 0.4,
            ior: 1.75,
            iridescence: 1.0,
            iridescenceIOR: 1.9,
            iridescenceThicknessRange: [120, 460],
            transparent: true
        }),
        core: createNeonMaterial(colorHex, 0.9)
    };
}

export function createCrystalShardMesh(colorHex = 0x00f2fe, sharedMats = null) {
    const group = new THREE.Group();

    const shard = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.14, 0),
        sharedMats ? sharedMats.body : sharedMaterial(THREE.MeshPhysicalMaterial, {
            color: colorHex,
            emissive: colorHex,
            emissiveIntensity: 0.75,
            roughness: 0.04,
            metalness: 0.0,
            transmission: 0.9,
            thickness: 0.4,
            ior: 1.75,
            iridescence: 1.0,
            iridescenceIOR: 1.9,
            iridescenceThicknessRange: [120, 460],
            transparent: true
        })
    );
    shard.scale.set(0.75, 1.9, 0.75);
    shard.castShadow = true;
    group.add(shard);

    // Unlit core so the shard actually catches the bloom pass
    const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.07, 0),
        sharedMats ? sharedMats.core : createNeonMaterial(colorHex, 0.9)
    );
    core.scale.set(0.7, 1.85, 0.7);
    group.add(core);

    return group;
}

/**
 * Satin ribbon bow — the coquette signature.
 *
 * Built from two squashed half-tori for the loops, a knot, and two tapered
 * tails, all in a fabric material with strong sheen so it reads as ribbon
 * rather than plastic. Faces +Z.
 */
export function createSatinBowMesh(colorHex = 0xff9ab5, scale = 1) {
    const buildParts = () => {
        const loopGeo = new THREE.TorusGeometry(0.16, 0.045, 10, 26, Math.PI * 1.55);
        const knotGeo = new THREE.SphereGeometry(0.062, 14, 12);
        const tailGeo = new THREE.CylinderGeometry(0.05, 0.022, 0.3, 8, 3);

        const parts = [part(knotGeo, { scale: [1.15, 0.9, 0.85] })];
        for (const dir of [-1, 1]) {
            parts.push(part(loopGeo, {
                pos: [dir * 0.15, 0.02, 0],
                rot: [0.28 * dir, 0, dir === 1 ? -0.5 : Math.PI + 0.5],
                scale: [1, 0.85, 0.55] // flatten: ribbon, not tubing
            }));
            // Tails fall away and curl outward
            parts.push(part(tailGeo, {
                pos: [dir * 0.075, -0.17, 0.01],
                rot: [0.22, 0, dir * 0.42],
                scale: [1, 1, 0.4]
            }));
        }
        loopGeo.dispose();
        knotGeo.dispose();
        tailGeo.dispose();
        return parts;
    };

    const bow = sharedPartsMesh('satin-bow', buildParts, sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: colorHex,
        roughness: 0.34,
        metalness: 0.0,
        sheen: 1.0,
        sheenRoughness: 0.25,
        sheenColor: new THREE.Color(0xffffff),
        clearcoat: 0.55,
        clearcoatRoughness: 0.2,
        side: THREE.DoubleSide
    }));

    // Kept as a group so callers can position/rotate the bow as a unit
    const group = new THREE.Group();
    group.add(bow);
    group.scale.setScalar(scale);
    return group;
}

/** Small piped sugar heart, for scattering across a top surface. */
export function createSugarHeartMesh(colorHex = 0xff4d79, size = 0.09) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.35);
    shape.bezierCurveTo(0.05, 0.7, 0.55, 0.85, 0.85, 0.5);
    shape.bezierCurveTo(1.1, 0.2, 0.7, -0.35, 0, -0.9);
    shape.bezierCurveTo(-0.7, -0.35, -1.1, 0.2, -0.85, 0.5);
    shape.bezierCurveTo(-0.55, 0.85, -0.05, 0.7, 0, 0.35);

    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: 0.32,
        bevelEnabled: true,
        bevelSegments: 4,
        steps: 1,
        bevelSize: 0.16,
        bevelThickness: 0.16,
        curveSegments: 16
    });
    geo.center();
    geo.rotateX(-Math.PI / 2);
    geo.scale(size, size, size);

    const mesh = new THREE.Mesh(geo, sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: colorHex,
        roughness: 0.24,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        sheen: 0.6
    }));
    mesh.castShadow = true;
    return mesh;
}

/**
 * The piped bear face that shows up on nearly every Korean bento cake:
 * two ears, a muzzle, a nose and two dot eyes, all in buttercream.
 */
export function createBearFaceMesh(furColor = 0xf0c9a0, accentColor = 0x5c3626) {
    const group = new THREE.Group();
    const fur = sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: furColor,
        roughness: 0.55,
        sheen: 0.6,
        sheenColor: new THREE.Color(0xfff0e0),
        clearcoat: 0.3
    });
    const accent = sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: accentColor,
        roughness: 0.2,
        clearcoat: 1.0
    });

    const head = new THREE.Mesh(sharedSphere(0.17, 22, 18), fur);
    head.scale.set(1, 0.62, 1);
    head.castShadow = true;
    group.add(head);

    for (const dir of [-1, 1]) {
        const ear = new THREE.Mesh(sharedSphere(0.062, 14, 12), fur);
        ear.scale.set(1, 0.7, 1);
        ear.position.set(dir * 0.125, 0.055, -0.1);
        ear.castShadow = true;
        group.add(ear);

        const innerEar = new THREE.Mesh(sharedSphere(0.032, 10, 8), accent);
        innerEar.scale.set(1, 0.55, 1);
        innerEar.position.set(dir * 0.125, 0.085, -0.1);
        group.add(innerEar);

        const eye = new THREE.Mesh(sharedSphere(0.022, 10, 8), accent);
        eye.scale.set(1, 0.8, 1);
        eye.position.set(dir * 0.062, 0.1, 0.055);
        group.add(eye);
    }

    const muzzle = new THREE.Mesh(sharedSphere(0.075, 16, 12), fur);
    muzzle.scale.set(1.1, 0.5, 0.9);
    muzzle.position.set(0, 0.09, 0.1);
    muzzle.material = sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: new THREE.Color(furColor).lerp(new THREE.Color(0xffffff), 0.45),
        roughness: 0.5,
        sheen: 0.5
    });
    group.add(muzzle);

    const nose = new THREE.Mesh(sharedSphere(0.026, 10, 8), accent);
    nose.scale.set(1.25, 0.7, 0.9);
    nose.position.set(0, 0.115, 0.15);
    group.add(nose);

    return group;
}

/** Wafer-thin gold leaf flake — a bent plane, never flat. */
export function createGoldLeafMesh(size = 0.12, seed = 0) {
    const geo = new THREE.PlaneGeometry(size, size * 0.8, 4, 4);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        pos.setZ(i, Math.sin(x * 22 + seed) * size * 0.14 + Math.cos(y * 18 + seed) * size * 0.1);
    }
    geo.computeVertexNormals();

    return new THREE.Mesh(geo, sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: 0xffd76a,
        roughness: 0.22,
        metalness: 1.0,
        side: THREE.DoubleSide,
        clearcoat: 0.6
    }));
}

export function createStrawberryMesh() {
    const group = new THREE.Group();
    const bodyGeo = sharedGeometry('strawberry-body', buildStrawberryBodyGeometry);
    addStrawberryParts(group, bodyGeo);
    return group;
}

function buildStrawberryBodyGeometry() {
    // Enough segments to resolve the seed dimples below.
    const bodyGeo = new THREE.SphereGeometry(0.12, 34, 26);
    const pos = bodyGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        const y = pos.getY(i);
        let z = pos.getZ(i);

        if (y < 0) {
            let scaleFactor = 1.0 + y * 2.2;
            if (scaleFactor < 0.15) scaleFactor = 0.15;
            x *= scaleFactor;
            z *= scaleFactor;
        }

        // Seed pits. A smooth red teardrop reads as plastic; the achene
        // dimples are what make it legible as a strawberry at a glance.
        const radial = Math.hypot(x, z);
        if (radial > 1e-6) {
            const theta = Math.atan2(z, x);
            const phi = Math.asin(THREE.MathUtils.clamp(y / 0.12, -1, 1));
            const pit = Math.cos(theta * 9 + phi * 3) * Math.cos(phi * 13);
            const depth = Math.max(0, pit) * 0.009;
            const scale = (radial - depth) / radial;
            x *= scale;
            z *= scale;
        }

        pos.setXYZ(i, x, y, z);
    }
    bodyGeo.computeVertexNormals();
    return bodyGeo;
}

function addStrawberryParts(group, bodyGeo) {
    // Physical, for the waxy skin highlight a real strawberry has
    const body = new THREE.Mesh(bodyGeo, sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: 0xcc1124,
        roughness: 0.32,
        metalness: 0.02,
        clearcoat: 0.55,
        clearcoatRoughness: 0.25
    }));
    body.scale.set(1.0, 1.35, 1.0);
    body.rotation.x = Math.PI;
    body.position.y = 0.08;
    body.castShadow = true;
    group.add(body);

    const leafGeo = sharedGeometry('strawberry-leaf', () => new THREE.ConeGeometry(0.05, 0.03, 5));
    const leafMat = sharedMaterial(THREE.MeshStandardMaterial, { color: 0x276336, roughness: 0.7 });
    for (let i = 0; i < 5; i++) {
        const leaf = new THREE.Mesh(leafGeo, leafMat);
        const angle = (i / 5) * Math.PI * 2;
        leaf.position.set(Math.cos(angle) * 0.045, 0.15, Math.sin(angle) * 0.045);
        leaf.rotation.set(0.18, angle, 0.25);
        group.add(leaf);
    }
}

export function createCherryMesh() {
    const group = new THREE.Group();
    const cherryGeo = sharedGeometry('cherry-body', buildCherryBodyGeometry);
    addCherryParts(group, cherryGeo);
    return group;
}

function buildCherryBodyGeometry() {
    const cherryGeo = new THREE.SphereGeometry(0.1, 30, 22);
    const cPos = cherryGeo.attributes.position;
    for (let i = 0; i < cPos.count; i++) {
        let x = cPos.getX(i);
        let y = cPos.getY(i);
        let z = cPos.getZ(i);

        // Stem dimple: real cherries are pressed in where the stalk attaches,
        // not perfectly round on top.
        const topT = Math.max(0, y / 0.1);
        y -= Math.pow(topT, 6) * 0.035;

        // Suture line — the shallow crease running down one side
        const theta = Math.atan2(z, x);
        const radial = Math.hypot(x, z);
        if (radial > 1e-6) {
            const crease = Math.exp(-Math.pow(Math.sin(theta / 2), 2) * 40) * 0.006;
            const scale = (radial - crease) / radial;
            x *= scale;
            z *= scale;
        }

        cPos.setXYZ(i, x, y, z);
    }
    cherryGeo.computeVertexNormals();
    return cherryGeo;
}

function addCherryParts(group, cherryGeo) {
    const body = new THREE.Mesh(cherryGeo, sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: 0x730211,
        roughness: 0.03,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02
    }));
    body.castShadow = true;
    group.add(body);

    const stemGroup = new THREE.Group();
    const stemMat = sharedMaterial(THREE.MeshStandardMaterial, { color: 0x567527, roughness: 0.85 });
    const stemRadius = 0.008;
    const segmentHeight = 0.045;

    let lastY = 0.08;
    let lastX = 0;

    for (let i = 0; i < 6; i++) {
        const seg = new THREE.Mesh(
            sharedGeometry('cherry-stem', () => new THREE.CylinderGeometry(stemRadius, stemRadius, segmentHeight, 6)),
            stemMat
        );

        const angle = 0.15 + (i * 0.08);
        seg.rotation.z = angle;

        const dx = Math.sin(angle) * segmentHeight;
        const dy = Math.cos(angle) * segmentHeight;
        seg.position.set(lastX + dx / 2, lastY + dy / 2, 0);
        lastX += dx;
        lastY += dy;

        stemGroup.add(seg);
    }
    group.add(stemGroup);
}

export function createTopperMesh(topperStyle, customText = '', customRimColor = '', themeName = 'neon-rose') {
    if (topperStyle === 'none' && !customText) return null;

    const group = new THREE.Group();

    // Sized to complement the cake, not dominate it: the sign used to sit
    // 1.25 above the top at full size, towering over the candles and reading
    // as the whole silhouette. Now it stands at roughly twice candle height.
    const SIGN_Y = 0.82;
    const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.011, 0.011, SIGN_Y + 0.05, 8),
        sharedMaterial(THREE.MeshStandardMaterial, { color: 0xe0e0e0, metalness: 0.9, roughness: 0.1 })
    );
    // Pushed ~5cm into the cake so it looks planted.
    rod.position.y = (SIGN_Y + 0.05) / 2 - 0.05;
    rod.castShadow = true;
    group.add(rod);

    let signMesh = null;
    const extrudeSettings = {
        depth: 0.06,
        bevelEnabled: true,
        bevelSegments: 4,
        steps: 1,
        bevelSize: 0.015,
        bevelThickness: 0.015
    };

    if (customText) {
        const canvasTexture = createCustomTopperTexture(customText, themeName, customRimColor);

        const frontBackMat = sharedMaterial(THREE.MeshPhysicalMaterial, {
            map: canvasTexture,
            transparent: true,
            roughness: 0.1,
            metalness: 0.1,
            clearcoat: 1.0,
            clearcoatRoughness: 0.05
        });

        let sideColor = 0xffd700; // Gold rim by default
        if (themeName === 'neon-rose') sideColor = 0xff0055;
        else if (themeName === 'pastel-mint') sideColor = 0x00f2fe;
        else if (themeName === 'lavender-dream') sideColor = 0x8000ff;

        if (customRimColor) {
            sideColor = new THREE.Color(customRimColor);
        }

        const sideMat = sharedMaterial(THREE.MeshStandardMaterial, {
            color: sideColor,
            roughness: 0.1,
            metalness: 0.9
        });

        const materials = [sideMat, sideMat, sideMat, sideMat, frontBackMat, frontBackMat];
        signMesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.04), materials);
        signMesh.position.y = SIGN_Y;
    } else if (topperStyle === 'best-senpai') {
        const heartShape = new THREE.Shape();
        heartShape.moveTo(0, 0.1);
        heartShape.bezierCurveTo(0, 0.3, 0.15, 0.5, 0.35, 0.5);
        heartShape.bezierCurveTo(0.55, 0.5, 0.65, 0.35, 0.65, 0.2);
        heartShape.bezierCurveTo(0.65, 0.0, 0.4, -0.25, 0, -0.55);
        heartShape.bezierCurveTo(-0.4, -0.25, -0.65, 0, -0.65, 0.2);
        heartShape.bezierCurveTo(-0.65, 0.35, -0.55, 0.5, -0.35, 0.5);
        heartShape.bezierCurveTo(-0.15, 0.5, 0, 0.3, 0, 0.1);

        const heartGeo = new THREE.ExtrudeGeometry(heartShape, extrudeSettings);
        heartGeo.center();

        const heartColor = customRimColor ? new THREE.Color(customRimColor) : 0xec1a4e;
        signMesh = new THREE.Mesh(heartGeo, sharedMaterial(THREE.MeshPhysicalMaterial, {
            color: heartColor,
            roughness: 0.1,
            metalness: 0.15,
            clearcoat: 1.0,
            clearcoatRoughness: 0.02,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x3d0006
        }));
        signMesh.position.y = SIGN_Y;
    } else if (topperStyle === 'star') {
        const starShape = new THREE.Shape();
        const spikes = 5;
        for (let i = 0; i < spikes * 2; i++) {
            const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
            const r = i % 2 === 0 ? 0.42 : 0.18;
            const x = Math.cos(angle) * r;
            const y = Math.sin(angle) * r;
            if (i === 0) starShape.moveTo(x, y);
            else starShape.lineTo(x, y);
        }
        starShape.closePath();

        const starGeo = new THREE.ExtrudeGeometry(starShape, extrudeSettings);
        starGeo.center();

        const starColor = customRimColor ? new THREE.Color(customRimColor) : 0xffd700;
        signMesh = new THREE.Mesh(starGeo, sharedMaterial(THREE.MeshStandardMaterial, {
            color: starColor,
            roughness: 0.1,
            metalness: 0.92,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x3f2f00
        }));
        signMesh.position.y = SIGN_Y;
    } else if (topperStyle === 'hbd') {
        const crownShape = new THREE.Shape();
        crownShape.moveTo(-0.5, -0.2);
        crownShape.lineTo(-0.5, 0.2);
        crownShape.lineTo(-0.35, 0.14);
        crownShape.lineTo(-0.18, 0.32);
        crownShape.lineTo(0, 0.18);
        crownShape.lineTo(0.18, 0.32);
        crownShape.lineTo(0.35, 0.14);
        crownShape.lineTo(0.5, 0.2);
        crownShape.lineTo(0.5, -0.2);
        crownShape.closePath();

        const crownGeo = new THREE.ExtrudeGeometry(crownShape, extrudeSettings);
        crownGeo.center();

        const crownColor = customRimColor ? new THREE.Color(customRimColor) : 0xffa500;
        signMesh = new THREE.Mesh(crownGeo, sharedMaterial(THREE.MeshStandardMaterial, {
            color: crownColor,
            roughness: 0.1,
            metalness: 0.95,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x331a00
        }));
        signMesh.position.y = SIGN_Y;
    }

    if (signMesh) {
        // Text plaques stay larger so short names remain legible.
        signMesh.scale.setScalar(customText ? 0.72 : 0.56);
        signMesh.castShadow = true;
        group.add(signMesh);
    }

    return group;
}

/* ------------------------------------------------------------------ *
 * Ring / border helpers
 * ------------------------------------------------------------------ */

/**
 * Pipes a ring of cream rosettes around a tier.
 *
 * Hand-piped cream is never evenly spaced or uniformly sized, so every rosette
 * gets its own deterministic jitter in angle, radius, height, scale and spin.
 */
export function addPipingRing(group, count, radius, y, seedBase, colorHex = 0xfffafb, detail = 1) {
    count = scaleCount(count, detail, 14);
    const mat = createButtercreamPipingMaterial(colorHex);
    for (let i = 0; i < count; i++) {
        const seed = seedBase + i * 1.7;
        const angle = (i / count) * Math.PI * 2 + Math.sin(seed * 2.3) * 0.012;
        const r = radius + Math.sin(seed * 1.9) * 0.012;
        const cream = createPipedCreamMesh(colorHex, seed, detail, mat);

        cream.position.set(
            Math.cos(angle) * r,
            y + Math.sin(seed * 3.1) * 0.008,
            Math.sin(angle) * r
        );
        cream.rotation.set(
            0.1 + Math.sin(seed * 1.3) * 0.05,
            -angle + Math.cos(seed) * 0.25,
            Math.sin(seed * 2.7) * 0.04
        );

        const s = 1.5 + Math.sin(seed * 4.1) * 0.11;
        cream.scale.set(s, s * (1.0 + Math.cos(seed * 1.6) * 0.06), s);
        group.add(cream);
    }
}

/**
 * Classic shell border: teardrops laid head-to-tail around a rim, each one's
 * tail tucked under the next one's head.
 */
export function addShellBorder(group, count, radius, y, seedBase, colorHex = 0xfffafb, scale = 1.35, detail = 1) {
    count = scaleCount(count, detail, 16);
    const mat = createButtercreamPipingMaterial(colorHex);
    for (let i = 0; i < count; i++) {
        const seed = seedBase + i * 2.31;
        const angle = (i / count) * Math.PI * 2;
        const shell = createPipedShellMesh(colorHex, seed, detail, mat);

        shell.position.set(
            Math.cos(angle) * radius,
            y + Math.sin(seed * 2.9) * 0.006,
            Math.sin(angle) * radius
        );
        // The mesh's drag axis is +x, so spin it to run along the rim
        shell.rotation.set(0, -angle + Math.PI / 2, 0.16 + Math.sin(seed) * 0.05);

        const s = scale * (1 + Math.sin(seed * 3.7) * 0.07);
        shell.scale.set(s, s, s);
        group.add(shell);
    }
}

/**
 * Shell border along a heart perimeter: star-nozzle teardrops laid
 * head-to-tail, each tail tucked under the next head, baked into one mesh.
 *
 * Options:
 *   count   shells at detail 1 (thinned by detail; shells grow to stay joined)
 *   color   piping colour, or pass `material` to share one
 *   outset  offset from the wall along the outward normal
 *   size    shell scale (a size-1 shell is ~0.29 long)
 *   tilt    leans the shells outward (+) over an edge, radians
 *   zigzag  alternating yaw, radians: turns a plain border into the
 *           back-and-forth "reverse shell" of Lambeth piping
 *   reverse pipe in the opposite direction round the heart
 */
export function addHeartPipingRing(group, scale, y, {
    count = 48, color = 0xfffafb, material = null, outset = 0, size = 1,
    tilt = 0, zigzag = 0, reverse = false, detail = 1
} = {}) {
    const n = scaleCount(count, detail, 16);
    const pts = heartPerimeterPoints(scale, n, outset);
    const mat = material || createButtercreamPipingMaterial(color);

    // Each shell must overlap the next by ~35% to read as one continuous
    // border; on phones the count drops, so the shells get longer instead.
    let spacing = 0;
    for (let i = 0; i < n; i++) {
        const b = pts[(i + 1) % n];
        spacing += Math.hypot(b.x - pts[i].x, b.z - pts[i].z);
    }
    spacing /= n;
    const s = Math.max(size, (spacing * 1.35) / 0.29);

    // A few ridge-phase variants are plenty; building one per shell is waste
    const variants = [0, 1.7, 3.1, 4.6].map((seed) => {
        const m = createPipedShellMesh(color, seed, detail, mat);
        return m.geometry;
    });

    const X = new THREE.Vector3();
    const Y = new THREE.Vector3();
    const Z = new THREE.Vector3();
    const N = new THREE.Vector3();
    const m4 = new THREE.Matrix4();
    const parts = pts.map((p, i) => {
        const dir = reverse ? -1 : 1;
        N.set(p.nx, 0, p.nz);
        X.set(p.tx * dir, 0, p.tz * dir);
        Y.set(0, Math.cos(tilt), 0).addScaledVector(N, Math.sin(tilt));
        if (zigzag) X.applyAxisAngle(Y, i % 2 ? zigzag : -zigzag);
        Z.crossVectors(X, Y).normalize();
        const k = s * (1 + Math.sin(i * 2.31) * 0.05);
        m4.makeBasis(X, Y, Z).scale(new THREE.Vector3(k, k, k));
        m4.setPosition(p.x, y + Math.sin(i * 2.9) * 0.004, p.z);
        return variants[i % variants.length].clone().applyMatrix4(m4);
    });

    const mesh = partsToMesh(parts, mat);
    group.add(mesh);
    return mesh;
}

/** String of lustrous sugar pearls along a tier rim — one instanced draw. */
export function addPearlBorderRing(group, count, radius, y, material, pearlRadius = 0.045) {
    group.add(instanceRing(
        sharedSphere(pearlRadius, 12, 12),
        material,
        count,
        (d, i) => {
            const a = (i / count) * Math.PI * 2;
            d.position.set(Math.cos(a) * radius, y, Math.sin(a) * radius);
            d.rotation.set(0, 0, 0);
            d.scale.setScalar(1);
        }
    ));
}

/** String of pearls following a heart perimeter — one instanced draw. */
export function addHeartPearlRing(group, scale, y, count, material, pearlRadius = 0.038, outset = 0) {
    const pts = heartPerimeterPoints(scale, count, outset);
    group.add(instanceRing(
        sharedSphere(pearlRadius, 12, 12),
        material,
        pts.length,
        (d, i) => {
            d.position.set(pts[i].x, y, pts[i].z);
            d.rotation.set(0, 0, 0);
            d.scale.setScalar(1);
        }
    ));
}

/**
 * Hangs a ring of glaze drips off the top edge.
 *
 * Running glaze is uneven: each drip has its own length, thickness, taper and
 * a slight sideways lean, and the bead at the tip swells by how far it ran.
 */
export function addGlazeDrips(group, glazeMat, count, radius, topY, seedBase) {
    const beadGeo = new THREE.SphereGeometry(0.04, 14, 12);

    for (let i = 0; i < count; i++) {
        const seed = seedBase + i * 2.11;
        const angle = (i / count) * Math.PI * 2 + Math.sin(seed * 1.7) * 0.02;
        const dripLength = 0.14 + Math.sin(i * 2.3 + 1.2) * 0.08;
        // Thicker drips run further, so tie thickness to length
        const thickness = 0.023 + (dripLength - 0.14) * 0.06 + Math.sin(seed) * 0.003;

        const dripGroup = new THREE.Group();

        const dripCyl = new THREE.Mesh(
            new THREE.CylinderGeometry(thickness * 1.15, thickness * 0.85, dripLength, 12),
            glazeMat
        );
        dripCyl.position.y = -dripLength / 2;
        dripCyl.castShadow = true;
        dripGroup.add(dripCyl);

        const dripBulb = new THREE.Mesh(beadGeo, glazeMat);
        dripBulb.position.y = -dripLength;
        const beadScale = 0.85 + dripLength * 1.1;
        dripBulb.scale.set(beadScale, beadScale * 1.25, beadScale);
        dripBulb.castShadow = true;
        dripGroup.add(dripBulb);

        dripGroup.position.set(Math.cos(angle) * radius, topY, Math.sin(angle) * radius);
        dripGroup.rotation.set(Math.sin(seed * 1.4) * 0.06, 0, Math.cos(seed * 1.9) * 0.06);
        group.add(dripGroup);
    }
}

/**
 * Scatters crumbs and stray sprinkles on the cake stand.
 *
 * A spotless stand is one of the strongest CG tells — a cake that was actually
 * assembled and decorated always sheds a little onto the plate.
 */
export function addStandDebris(group, standY, standRadius, creamColorHex, innerRadius = 2.2) {
    // Nothing to scatter into if the visible ring collapsed.
    const band = standRadius - 0.1 - innerRadius;
    if (band <= 0) return;

    const at = (i) => {
        const seed = 2.4 + i * 1.61;
        const r = innerRadius + Math.abs(Math.sin(seed * 1.7)) * band;
        const theta = seed * 2.399; // golden-angle-ish spread, no clumping
        return { seed, x: Math.cos(theta) * r, z: Math.sin(theta) * r };
    };

    const strayIdx = [];
    const crumbIdx = [];
    for (let i = 0; i < 26; i++) (i % 3 === 0 ? strayIdx : crumbIdx).push(i);

    group.add(instanceRing(
        new THREE.DodecahedronGeometry(0.022, 0),
        sharedMaterial(THREE.MeshStandardMaterial, {
            color: new THREE.Color(creamColorHex).multiplyScalar(0.75),
            roughness: 0.9,
            metalness: 0.0
        }),
        crumbIdx.length,
        (d, k) => {
            const { seed, x, z } = at(crumbIdx[k]);
            d.position.set(x, standY + 0.022, z);
            d.rotation.set(seed, seed * 1.7, seed * 0.6);
            d.scale.setScalar(0.5 + Math.abs(Math.sin(seed * 3.1)) * 0.8);
        }
    ));

    // Stray sprinkles keep their own colours, so they get their own pass
    const strayColors = [0xff6b8b, 0xffd166, 0x06d6a0, 0x118ab2, 0xff9f1c];
    const strayGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.055, 6);
    strayColors.forEach((color, c) => {
        const mine = strayIdx.filter((i) => i % strayColors.length === c);
        if (!mine.length) return;
        group.add(instanceRing(
            strayGeo.clone(),
            sharedMaterial(THREE.MeshStandardMaterial, { color, roughness: 0.45 }),
            mine.length,
            (d, k) => {
                const { seed, x, z } = at(mine[k]);
                d.position.set(x, standY + 0.028, z);
                // Lying flat on the plate, not standing up
                d.rotation.set(Math.PI / 2, seed * 1.3, Math.sin(seed) * 0.9);
                d.scale.setScalar(1);
            }
        ));
    });
    strayGeo.dispose();
}

/**
 * Diamond quilting: two families of helical seams crossing on a tier's side,
 * with a gold pearl pressed into each intersection. This is the single most
 * recognisable "wedding cake" fondant treatment and it costs 2·N tube meshes.
 */
export function addQuiltedLattice(group, { radius, yBottom, yTop, diamonds = 12, seamColor = 0xffffff, studMat }) {
    const seamMat = sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: seamColor,
        roughness: 0.45,
        metalness: 0.0,
        sheen: 0.7
    });
    const height = yTop - yBottom;
    const turn = (Math.PI * 2) / diamonds;

    for (const dir of [1, -1]) {
        for (let d = 0; d < diamonds; d++) {
            const start = d * turn;
            const pts = [];
            for (let k = 0; k <= 10; k++) {
                const t = k / 10;
                const a = start + dir * t * turn;
                pts.push(new THREE.Vector3(
                    Math.cos(a) * radius,
                    yBottom + t * height,
                    Math.sin(a) * radius
                ));
            }
            const tube = new THREE.Mesh(
                new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 0.012, 6, false),
                seamMat
            );
            tube.castShadow = true;
            group.add(tube);
        }
    }

    // Studs sit where the two families cross: bottom, mid and top of each diamond
    if (studMat) {
        const studGeo = new THREE.SphereGeometry(0.032, 10, 10);
        for (const level of [0, 0.5, 1]) {
            const offset = level === 0.5 ? turn / 2 : 0;
            for (let d = 0; d < diamonds; d++) {
                const a = d * turn + offset;
                const stud = new THREE.Mesh(studGeo, studMat);
                stud.position.set(
                    Math.cos(a) * (radius + 0.012),
                    yBottom + level * height,
                    Math.sin(a) * (radius + 0.012)
                );
                stud.castShadow = true;
                group.add(stud);
            }
        }
    }
}

/**
 * Fondant drapery swags: fabric arcs that hang between anchor points around a
 * tier, each finished with a gold tassel. Built as tubes along a catenary-ish
 * curve so they actually sag instead of reading as flat arcs.
 */
export function addDraperySwags(group, { radius, y, count = 8, sag = 0.26, color = 0xffffff, tasselMat }) {
    const clothMat = sharedMaterial(THREE.MeshPhysicalMaterial, {
        color,
        roughness: 0.5,
        metalness: 0.0,
        sheen: 1.0,
        sheenRoughness: 0.35,
        sheenColor: new THREE.Color(0xffffff)
    });
    const span = (Math.PI * 2) / count;

    for (let i = 0; i < count; i++) {
        const start = i * span;
        const pts = [];
        for (let k = 0; k <= 12; k++) {
            const t = k / 12;
            const a = start + t * span;
            // sin(πt) gives the deepest sag at mid-span, zero at the anchors
            const dip = Math.sin(t * Math.PI) * sag;
            // The cloth also bellies outward where it hangs free
            const r = radius + Math.sin(t * Math.PI) * 0.05;
            pts.push(new THREE.Vector3(Math.cos(a) * r, y - dip, Math.sin(a) * r));
        }
        const swag = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.055, 8, false),
            clothMat
        );
        swag.castShadow = true;
        group.add(swag);

        if (tasselMat) {
            const tassel = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 10), tasselMat);
            tassel.position.set(Math.cos(start) * (radius + 0.03), y - 0.09, Math.sin(start) * (radius + 0.03));
            tassel.rotation.x = Math.PI;
            tassel.castShadow = true;
            group.add(tassel);

            const cap = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 10), tasselMat);
            cap.position.set(Math.cos(start) * (radius + 0.03), y, Math.sin(start) * (radius + 0.03));
            group.add(cap);
        }
    }
}

/**
 * Glowing neon frame along a hexagonal prism's edges.
 *
 * EdgesGeometry + LineSegments would be the obvious approach, but WebGL caps
 * line width at 1px on almost every platform, so the result is a hairline that
 * bloom barely registers. Thin unlit cylinders along the known hex edges give
 * real, controllable thickness.
 */
export function addHexNeonFrame(group, { radius, height, centerY, rotationY = 0, colorHex, thickness = 0.02 }) {
    const mat = createNeonMaterial(colorHex);
    const halfH = height / 2;
    const corners = [];
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rotationY;
        corners.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
    }

    // Vertical struts at every corner
    const strutGeo = new THREE.CylinderGeometry(thickness, thickness, height, 6);
    for (const c of corners) {
        const strut = new THREE.Mesh(strutGeo, mat);
        strut.position.set(c.x, centerY, c.y);
        group.add(strut);
    }

    // Top and bottom rims: one bar per hex side
    const sideLength = corners[0].distanceTo(corners[1]);
    const barGeo = new THREE.CylinderGeometry(thickness, thickness, sideLength, 6);
    for (const y of [centerY - halfH, centerY + halfH]) {
        for (let i = 0; i < 6; i++) {
            const a = corners[i];
            const b = corners[(i + 1) % 6];
            const bar = new THREE.Mesh(barGeo, mat);
            bar.position.set((a.x + b.x) / 2, y, (a.y + b.y) / 2);
            // Cylinders point along +Y; lay this one along the side direction
            bar.rotation.z = Math.PI / 2;
            bar.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
            group.add(bar);
        }
    }
}

/* ------------------------------------------------------------------ *
 * Layout table
 * ------------------------------------------------------------------ *
 *
 * These metrics used to be copy-pasted into updateCake(), build3DViewerCake()
 * and setupViewerCandles() — three places that had to agree and sometimes
 * didn't. Everything now reads from here.
 *
 *   topDecorY / topDecorRadius  where fruit, rolls and sprinkles land
 *   sprinkleRadius              scatter radius (tighter than the fruit ring on
 *                               non-round tops so nothing overhangs an edge)
 *   candlePlacerRadius / candleBaseY   candle ring
 *   topperBaseY                 base of the topper rod
 */
