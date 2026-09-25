/**
 * Foil letter balloons, inflated from the glyph itself: the letter is drawn
 * into a small canvas, a distance transform gives every inside cell its
 * distance to the outline, and the height field h = sqrt(distance) (flat in
 * a thin crimp band at the edge) is mirrored front/back. That is the real
 * shape of a heat-sealed Mylar balloon: pillowy in the middle, knife-thin
 * at the seam, with crinkles where the film is pulled (a little noise near
 * the edge). ~2-4k triangles per letter, built once in a few ms.
 *
 * All letters of the room share one material (metal + anisotropy, one
 * program) and are merged into one geometry per row, so HAPPY BIRTHDAY is
 * two draw calls. Bounding boxes are kept per letter for the sway.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const GRID = 72;

function rasterGlyph(ch, font) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = GRID;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const size = GRID * 0.86;
    ctx.font = `800 ${size}px ${font}`;
    const m = ctx.measureText(ch);
    const asc = m.actualBoundingBoxAscent || size * 0.72;
    const desc = m.actualBoundingBoxDescent || 0;
    const w = (m.actualBoundingBoxRight || m.width / 2) + (m.actualBoundingBoxLeft || m.width / 2);
    const scale = Math.min(1, (GRID * 0.84) / Math.max(asc + desc, 1), (GRID * 0.84) / Math.max(w, 1));
    ctx.translate(GRID / 2, GRID / 2 + (asc - desc) / 2 * scale);
    ctx.scale(scale, scale);
    ctx.fillText(ch, ((m.actualBoundingBoxLeft || 0) - (m.actualBoundingBoxRight || 0)) / 2, 0);
    const data = ctx.getImageData(0, 0, GRID, GRID).data;
    const alpha = new Float32Array(GRID * GRID);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] / 255;
    return { alpha, aspect: Math.min(1, (w * scale) / (GRID * 0.84)) };
}

/** Chamfer (3-4) distance to the nearest outside cell, in cells. */
function distanceInside(alpha) {
    const N = GRID;
    const INF = 1e9;
    const d = new Float32Array(N * N);
    for (let i = 0; i < d.length; i++) d[i] = alpha[i] >= 0.5 ? INF : 0;
    const at = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? 0 : d[y * N + x]);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const i = y * N + x;
            if (!d[i]) continue;
            d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
        }
    }
    for (let y = N - 1; y >= 0; y--) {
        for (let x = N - 1; x >= 0; x--) {
            const i = y * N + x;
            if (!d[i]) continue;
            d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
        }
    }
    for (let i = 0; i < d.length; i++) d[i] /= 3;
    return d;
}

function hash(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}

/**
 * One inflated letter, centred, `height` metres tall, facing +z.
 * @returns {THREE.BufferGeometry|null}
 */
export function inflateLetter(ch, { height = 0.36, depth = 0.05, font = '"Outfit", "Outfit Variable", Arial, sans-serif' } = {}) {
    if (!ch.trim()) return null;
    const { alpha } = rasterGlyph(ch, font);
    const dist = distanceInside(alpha);
    let dmax = 0;
    for (let i = 0; i < dist.length; i++) dmax = Math.max(dmax, dist[i]);
    if (dmax < 1) return null;
    const N = GRID;
    const cell = height / (N * 0.84);
    const lip = 0.9; // crimp band, in cells

    // Grid corners (N+1)^2: a corner is used when any adjacent cell is inside.
    const inside = (x, y) => x >= 0 && y >= 0 && x < N && y < N && alpha[y * N + x] >= 0.5;
    const cornerIndex = new Int32Array((N + 1) * (N + 1)).fill(-1);
    const pos = [];
    const sampleA = (x, y) => {
        const xi = THREE.MathUtils.clamp(Math.floor(x), 0, N - 1);
        const yi = THREE.MathUtils.clamp(Math.floor(y), 0, N - 1);
        return alpha[yi * N + xi];
    };
    for (let y = 0; y <= N; y++) {
        for (let x = 0; x <= N; x++) {
            if (!(inside(x - 1, y - 1) || inside(x, y - 1) || inside(x - 1, y) || inside(x, y))) continue;
            const edge = !(inside(x - 1, y - 1) && inside(x, y - 1) && inside(x - 1, y) && inside(x, y));
            let px = x;
            let py = y;
            let h = 0;
            if (edge) {
                // Pull the stair-stepped outline onto the anti-aliased contour.
                const gx = sampleA(x + 0.5, y - 0.5) + sampleA(x + 0.5, y + 0.5) - sampleA(x - 1.5, y - 0.5) - sampleA(x - 1.5, y + 0.5);
                const gy = sampleA(x - 0.5, y + 0.5) + sampleA(x + 0.5, y + 0.5) - sampleA(x - 0.5, y - 1.5) - sampleA(x + 0.5, y - 1.5);
                const gl = Math.hypot(gx, gy);
                const f = (sampleA(x - 0.5, y - 0.5) + sampleA(x + 0.5, y - 0.5) + sampleA(x - 0.5, y + 0.5) + sampleA(x + 0.5, y + 0.5)) / 4;
                if (gl > 1e-3) {
                    const k = THREE.MathUtils.clamp((0.5 - f) / (gl * 0.5), -0.7, 0.7);
                    px += (gx / gl) * k;
                    py += (gy / gl) * k;
                }
            } else {
                const dc = Math.min(dist[(y - 1) * N + (x - 1)], dist[(y - 1) * N + x], dist[y * N + (x - 1)], dist[y * N + x]);
                const t = THREE.MathUtils.clamp((dc - lip) / (dmax - lip), 0, 1);
                h = Math.sqrt(t);
                // Crinkles: strongest just inside the seam, where the film puckers.
                const pucker = Math.exp(-Math.pow((dc - lip - 1.5) / 1.6, 2));
                // plus a fine all-over crinkle so the mirror breaks up like real film.
                h += (hash(x, y) - 0.5) * (0.16 * pucker + 0.035);
                h = Math.max(0, h);
            }
            cornerIndex[y * (N + 1) + x] = pos.length / 4;
            pos.push((px - N / 2) * cell, (N / 2 - py) * cell, h * depth, edge ? 1 : 0);
        }
    }
    const count = pos.length / 4;
    const verts = new Float32Array(count * 2 * 3);
    for (let i = 0; i < count; i++) {
        verts[i * 3] = pos[i * 4];
        verts[i * 3 + 1] = pos[i * 4 + 1];
        verts[i * 3 + 2] = pos[i * 4 + 2];
        const j = (count + i) * 3;
        verts[j] = pos[i * 4];
        verts[j + 1] = pos[i * 4 + 1];
        verts[j + 2] = -pos[i * 4 + 2];
    }
    const index = [];
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            if (!inside(x, y)) continue;
            const a = cornerIndex[y * (N + 1) + x];
            const b = cornerIndex[y * (N + 1) + x + 1];
            const c = cornerIndex[(y + 1) * (N + 1) + x];
            const d = cornerIndex[(y + 1) * (N + 1) + x + 1];
            // front (+z), counter-clockwise seen from +z (y grows downwards in the grid)
            index.push(a, c, b, b, c, d);
            index.push(a + count, b + count, c + count, b + count, d + count, c + count);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    // UVs for anisotropy direction (along the letter's height).
    const uv = new Float32Array(count * 2 * 2);
    for (let i = 0; i < count * 2; i++) {
        uv[i * 2] = verts[i * 3] / height + 0.5;
        uv[i * 2 + 1] = verts[i * 3 + 1] / height + 0.5;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeBoundingBox();
    return geo;
}

/** Theme -> foil look (research-surprise 4.3). */
export function foilLook(theme) {
    switch (theme) {
        case 'neon-rose':
        case 'sakura-blossom': return { color: 0xffb49c, roughness: 0.07, iridescence: 0 }; // rose gold
        case 'pastel-mint':
        case 'lavender-dream':
        case 'cosmic-nebula': return { color: 0xeef1f6, roughness: 0.06, iridescence: 0 }; // silver
        case 'cyber-retro': return { color: 0xe6ecf6, roughness: 0.06, iridescence: 0.8 }; // holographic
        default: return { color: 0xffd27a, roughness: 0.07, iridescence: 0 }; // gold
    }
}

/**
 * Mylar: a near-mirror metal under a glossy clearcoat, with only a hint of
 * anisotropy. It reflects its own studio-style environment (set by the
 * room: envMap = the RoomEnvironment PMREM), not the warm room capture,
 * which turned "mirror" into brown bronze.
 */
export function createFoilMaterial(theme, envMap = null) {
    const look = foilLook(theme);
    return new THREE.MeshPhysicalMaterial({
        color: look.color,
        metalness: 1,
        roughness: look.roughness,
        anisotropy: 0.15,
        anisotropyRotation: Math.PI / 2,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        iridescence: look.iridescence,
        iridescenceIOR: 1.6,
        iridescenceThicknessRange: [180, 520],
        envMap,
        envMapIntensity: 2
    });
}

/**
 * A row of letters, merged into one geometry, centred on x = 0 (async:
 * yields between glyphs when given yieldFn).
 * Letters are strung slightly unevenly (tilt/offset), like real ones taped
 * to a wall.
 */
export async function buildLetterRow(text, { height, gap = 0.02, rand, font, yieldFn = null }) {
    const parts = [];
    let x = 0;
    const placed = [];
    for (const ch of text) {
        if (ch === ' ') {
            x += height * 0.4;
            continue;
        }
        // ~10-30 ms per glyph on a phone: hand the thread back in between.
        if (yieldFn) await yieldFn();
        const g = inflateLetter(ch, { height, depth: height * 0.14, font });
        if (!g) continue;
        const bb = g.boundingBox;
        const w = bb.max.x - bb.min.x;
        g.translate(-bb.min.x, 0, 0);
        const m = new THREE.Matrix4().compose(
            new THREE.Vector3(x, (rand() - 0.5) * height * 0.08, 0),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (rand() - 0.5) * 0.25, (rand() - 0.5) * 0.12)),
            new THREE.Vector3(1, 1, 1)
        );
        g.applyMatrix4(m);
        parts.push(g);
        placed.push({ ch, x0: x, x1: x + w });
        x += w + gap;
    }
    if (!parts.length) return null;
    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    const width = x - gap;
    merged.translate(-width / 2, 0, 0);
    merged.computeBoundingSphere();
    return { geometry: merged, width, letters: placed };
}
