/**
 * Low-level cake construction kit: geometry helpers, procedural textures,
 * materials and decoration factories shared by every model in ./models/.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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
 * Procedural textures
 * ------------------------------------------------------------------ */

export function createCakeCrumbBumpTexture() {
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

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
    // finish is identical in the preview and the delivered card.
    const rng = makeRng(0xc4ce0001);
    for (let i = 0; i < 26000; i++) {
        const x = rng() * SIZE;
        const y = rng() * SIZE;
        const radius = 0.4 + rng() * 1.6;
        const heightVal = Math.floor(rng() * 60) - 30;
        const color = Math.min(255, Math.max(0, 128 + heightVal));
        ctx.fillStyle = `rgba(${color}, ${color}, ${color}, 0.55)`;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 1);
    return texture;
}

export function createCarbonFiberTexture() {
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

export function createWaferRollTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#edd1b8';
    ctx.fillRect(0, 0, 128, 128);

    ctx.strokeStyle = '#42250d';
    ctx.lineWidth = 14;
    for (let offset = -128; offset < 256; offset += 32) {
        ctx.beginPath();
        ctx.moveTo(offset, 0);
        ctx.lineTo(offset + 128, 128);
        ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 1);
    return texture;
}

/**
 * Holographic hex-grid inlay for the Neo-Prism tiers. A flat metal hexagon
 * reads as a chrome nut; an emissive circuit lattice on its faces is what
 * sells "crystal data prism".
 */
export function createHexGridEmissiveTexture(colorStr) {
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

export function createCustomTopperTexture(text, themeName, customGlowColor = '') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, 512, 256);

    let bgColor = 'rgba(15, 10, 25, 0.85)';
    let textColor = '#ff0055';
    let borderColor = '#00f2fe';
    let glowColor = '#ff0055';
    let fontName = 'Outfit';

    if (themeName === 'midnight-gold') {
        bgColor = 'rgba(10, 8, 5, 0.9)';
        textColor = '#ffd700';
        borderColor = '#ffd700';
        glowColor = '#ffd700';
        fontName = 'Playfair Display';
    } else if (themeName === 'pastel-mint') {
        bgColor = 'rgba(5, 15, 20, 0.85)';
        textColor = '#00f2fe';
        borderColor = '#4facfe';
        glowColor = '#00f2fe';
        fontName = 'Outfit';
    } else if (themeName === 'lavender-dream') {
        bgColor = 'rgba(15, 5, 20, 0.88)';
        textColor = '#f355ff';
        borderColor = '#8000ff';
        glowColor = '#f355ff';
        fontName = 'Outfit';
    } else if (themeName === 'sakura-blossom') {
        bgColor = 'rgba(31, 12, 17, 0.9)';
        textColor = '#ff758f';
        borderColor = '#ffb3c6';
        glowColor = '#ff758f';
        fontName = 'Great Vibes';
    } else if (themeName === 'cyber-retro') {
        bgColor = 'rgba(24, 0, 38, 0.9)';
        textColor = '#ff3399';
        borderColor = '#ff9966';
        glowColor = '#ff3399';
        fontName = 'Outfit';
    } else if (themeName === 'forest-moss') {
        bgColor = 'rgba(0, 23, 10, 0.9)';
        textColor = '#00ff88';
        borderColor = '#ffd700';
        glowColor = '#00ff88';
        fontName = 'Playfair Display';
    } else if (themeName === 'cosmic-nebula') {
        bgColor = 'rgba(7, 0, 20, 0.9)';
        textColor = '#8a2be2';
        borderColor = '#00f2fe';
        glowColor = '#00ffd5';
        fontName = 'Outfit';
    } else if (themeName === 'choco-monarch') {
        bgColor = 'rgba(20, 9, 4, 0.9)';
        textColor = '#cca43b';
        borderColor = '#5c3d2e';
        glowColor = '#cca43b';
        fontName = 'Playfair Display';
    }

    if (customGlowColor) {
        textColor = customGlowColor;
        borderColor = customGlowColor;
        glowColor = customGlowColor;
    }

    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 12;

    const r = 24;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(512 - r, 0);
    ctx.quadraticCurveTo(512, 0, 512, r);
    ctx.lineTo(512, 256 - r);
    ctx.quadraticCurveTo(512, 256, 512 - r, 256);
    ctx.lineTo(r, 256);
    ctx.quadraticCurveTo(0, 256, 0, 256 - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 15;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    let fontSize = 56;
    if (text.length > 10) fontSize = 44;
    if (text.length > 14) fontSize = 36;

    ctx.font = `bold ${fontSize}px "${fontName}", "Outfit", sans-serif`;
    ctx.fillText(text, 256, 128);

    return new THREE.CanvasTexture(canvas);
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
 *   x ∈ [-2.15s, 2.15s]   y ∈ [-1.85s, 1.5s]
 * The y range is asymmetric, which matters — see HEART_CENTER_RATIO.
 */
export function getHeartShape(scale = 1.0) {
    const shape = new THREE.Shape();
    const s = scale * 0.95;
    shape.moveTo(0, 0.45 * s);
    shape.bezierCurveTo(0.1 * s, 0.9 * s, 0.8 * s, 1.5 * s, 1.45 * s, 1.5 * s);
    shape.bezierCurveTo(2.15 * s, 1.5 * s, 2.15 * s, 0.85 * s, 2.15 * s, 0.45 * s);
    shape.bezierCurveTo(2.15 * s, -0.35 * s, 1.2 * s, -1.15 * s, 0, -1.85 * s);
    shape.bezierCurveTo(-1.2 * s, -1.15 * s, -2.15 * s, -0.35 * s, -2.15 * s, 0.45 * s);
    shape.bezierCurveTo(-2.15 * s, 0.85 * s, -2.15 * s, 1.5 * s, -1.45 * s, 1.5 * s);
    shape.bezierCurveTo(-0.8 * s, 1.5 * s, -0.1 * s, 0.9 * s, 0, 0.45 * s);
    return shape;
}

/**
 * geo.center() inside createHeartCakeGeometry shifts the profile up by this
 * fraction of s, because the heart's y range isn't symmetric about 0:
 *   centre = (1.5s + (-1.85s)) / 2 = -0.175s
 *
 * Every decoration that follows the heart perimeter has to apply the same
 * shift or it floats off the cake. The old piping ring didn't, and also
 * double-applied its scale — the base frill sat ~26% outside the sponge and a
 * quarter of a unit off in Z.
 */
export const HEART_CENTER_RATIO = 0.175;

export function createHeartCakeGeometry(scale, height, bevelSize) {
    const shape = getHeartShape(scale);
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: height - bevelSize * 2,
        steps: 1,
        bevelEnabled: true,
        bevelSegments: 6,
        bevelSize,
        bevelThickness: bevelSize,
        curveSegments: 56
    });
    geo.center();
    geo.rotateX(-Math.PI / 2); // Point faces toward front (+Z)
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
 * outward normals, already corrected for the centering shift.
 *
 * @param {number} scale  the same scale passed to createHeartCakeGeometry
 * @param {number} count  number of points (the closing duplicate is dropped)
 * @param {number} outset positive pushes outward, negative insets
 */
export function heartPerimeterPoints(scale, count, outset = 0) {
    const s = scale * 0.95;
    const zShift = HEART_CENTER_RATIO * s;
    const pts = getHeartShape(scale).getSpacedPoints(count);

    // getSpacedPoints returns count + 1 entries, the last one repeating the
    // first. Keeping it stamped a doubled rosette at the cleft.
    const ring = pts.slice(0, count);

    return ring.map((pt, i) => {
        const prev = ring[(i - 1 + count) % count];
        const next = ring[(i + 1) % count];

        // Outward normal = tangent rotated 90°, sign-corrected against the
        // vector from the centroid so it never points into the cake.
        let nx = -(next.y - prev.y);
        let ny = next.x - prev.x;
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        if (nx * pt.x + ny * (pt.y + zShift) < 0) {
            nx = -nx;
            ny = -ny;
        }

        const x = pt.x + nx * outset;
        const y = pt.y + ny * outset;
        return {
            x,
            z: -(y + zShift),
            // Facing angle in the XZ plane, for orienting the decoration
            angle: Math.atan2(-ny, nx)
        };
    });
}

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

export function getPlateMaterial(plateStyle, customColor = '') {
    let mat;
    switch (plateStyle) {
        case 'crystal':
            mat = new THREE.MeshPhysicalMaterial({
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
            mat = new THREE.MeshPhysicalMaterial({
                color: 0xd4af37,
                roughness: 0.12,
                metalness: 0.95,
                clearcoat: 0.8,
                clearcoatRoughness: 0.08
            });
            break;
        case 'cosmic':
            mat = new THREE.MeshPhysicalMaterial({
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
            mat = new THREE.MeshPhysicalMaterial({
                color: 0xfbfbf8,
                roughness: 0.15,
                metalness: 0.02,
                clearcoat: 0.9,
                clearcoatRoughness: 0.05
            });
            break;
    }
    if (customColor && mat) {
        mat.color.set(customColor);
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

    return new THREE.MeshPhysicalMaterial({
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
export function createButtercreamPipingMaterial(colorHex) {
    return new THREE.MeshPhysicalMaterial({
        color: colorHex,
        roughness: 0.28,
        metalness: 0.02,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        sheen: 0.95,
        sheenColor: new THREE.Color(0xffe6eb)
    });
}

/** Buttercream: matte-ish body with the fabric-like sheen fat gives frosting. */
export function createButtercreamMaterial(color, crumbBumpTex, bumpScale = 0.16) {
    return new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.62,
        metalness: 0.0,
        bumpMap: crumbBumpTex,
        bumpScale,
        sheen: 0.6,
        sheenRoughness: 0.7,
        sheenColor: new THREE.Color(0xfff2f5),
        clearcoat: 0.18,
        clearcoatRoughness: 0.6
    });
}

export function createGoldMaterial(colorHex = 0xffd76a) {
    return new THREE.MeshPhysicalMaterial({
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
    return new THREE.MeshBasicMaterial({
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

    // A ring can hold 40+ of these. Compiling a separate PBR material for
    // each one is pure overhead when they're all the same colour, so callers
    // that pipe a whole ring hand in one shared material.
    const mat = sharedMat || createButtercreamPipingMaterial(colorHex);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

/**
 * A piped shell — the sideways teardrop a star nozzle leaves when you squeeze,
 * drag and release. Rings of these are the classic top-and-bottom cake border,
 * and they read very differently from a ring of upright rosettes.
 */
export function createPipedShellMesh(colorHex = 0xfffafb, seed = 0, detail = 1, sharedMat = null) {
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

    const mesh = new THREE.Mesh(geo, sharedMat || createButtercreamPipingMaterial(colorHex));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

/** Cute minimalist sugar daisy (bento aesthetic). */
export function createDaisyFlowerMesh(petalColor = 0xffffff, centerColor = 0xffd166, sharedMats = null) {
    const flowerGroup = new THREE.Group();

    if (sharedMats && !sharedMats.center) {
        sharedMats.center = new THREE.MeshStandardMaterial({ color: centerColor, roughness: 0.35 });
        sharedMats.petal = new THREE.MeshPhysicalMaterial({
            color: petalColor,
            roughness: 0.45,
            sheen: 0.8,
            sheenColor: new THREE.Color(0xffffff),
            clearcoat: 0.4
        });
    }

    const centerMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.042, 12, 10),
        sharedMats ? sharedMats.center : new THREE.MeshStandardMaterial({ color: centerColor, roughness: 0.35 })
    );
    centerMesh.scale.set(1, 0.5, 1);
    centerMesh.castShadow = true;
    flowerGroup.add(centerMesh);

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

    flowerGroup.add(partsToMesh(petals, sharedMats ? sharedMats.petal : new THREE.MeshPhysicalMaterial({
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

    return partsToMesh(parts, sharedMat || new THREE.MeshPhysicalMaterial({
        color: colorHex,
        roughness: 0.5,
        metalness: 0.02,
        sheen: 0.7,
        sheenColor: new THREE.Color(0xffffff),
        clearcoat: 0.35,
        clearcoatRoughness: 0.4
    }));
}

export const MACARON_FILLING_MAT = new THREE.MeshStandardMaterial({ color: 0xfff4e6, roughness: 0.75 });

/** Gourmet French macaron. */
export function createMacaronMesh(colorHex = 0xffd700, sharedMat = null) {
    const macGroup = new THREE.Group();

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

    macGroup.add(partsToMesh(parts, sharedMat || new THREE.MeshPhysicalMaterial({
        color: colorHex,
        roughness: 0.55,
        metalness: 0.0,
        sheen: 0.5,
        clearcoat: 0.2
    })));

    const cream = new THREE.Mesh(
        new THREE.CylinderGeometry(0.088, 0.088, 0.03, 18),
        MACARON_FILLING_MAT.clone()
    );
    macGroup.add(cream);

    return macGroup;
}

/** Floating cyber crystal shard. */
export function createCrystalShardMaterials(colorHex) {
    return {
        body: new THREE.MeshPhysicalMaterial({
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
        sharedMats ? sharedMats.body : new THREE.MeshPhysicalMaterial({
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

    const bow = partsToMesh(parts, new THREE.MeshPhysicalMaterial({
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

    const mesh = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
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
    const fur = new THREE.MeshPhysicalMaterial({
        color: furColor,
        roughness: 0.55,
        sheen: 0.6,
        sheenColor: new THREE.Color(0xfff0e0),
        clearcoat: 0.3
    });
    const accent = new THREE.MeshPhysicalMaterial({
        color: accentColor,
        roughness: 0.2,
        clearcoat: 1.0
    });

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 22, 18), fur);
    head.scale.set(1, 0.62, 1);
    head.castShadow = true;
    group.add(head);

    for (const dir of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 12), fur);
        ear.scale.set(1, 0.7, 1);
        ear.position.set(dir * 0.125, 0.055, -0.1);
        ear.castShadow = true;
        group.add(ear);

        const innerEar = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), accent);
        innerEar.scale.set(1, 0.55, 1);
        innerEar.position.set(dir * 0.125, 0.085, -0.1);
        group.add(innerEar);

        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), accent);
        eye.scale.set(1, 0.8, 1);
        eye.position.set(dir * 0.062, 0.1, 0.055);
        group.add(eye);
    }

    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), fur);
    muzzle.scale.set(1.1, 0.5, 0.9);
    muzzle.position.set(0, 0.09, 0.1);
    muzzle.material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(furColor).lerp(new THREE.Color(0xffffff), 0.45),
        roughness: 0.5,
        sheen: 0.5
    });
    group.add(muzzle);

    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), accent);
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

    return new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
        color: 0xffd76a,
        roughness: 0.22,
        metalness: 1.0,
        side: THREE.DoubleSide,
        clearcoat: 0.6
    }));
}

export function createStrawberryMesh() {
    const group = new THREE.Group();

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

    // Physical, for the waxy skin highlight a real strawberry has
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshPhysicalMaterial({
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

    const leafGeo = new THREE.ConeGeometry(0.05, 0.03, 5);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x276336, roughness: 0.7 });
    for (let i = 0; i < 5; i++) {
        const leaf = new THREE.Mesh(leafGeo, leafMat);
        const angle = (i / 5) * Math.PI * 2;
        leaf.position.set(Math.cos(angle) * 0.045, 0.15, Math.sin(angle) * 0.045);
        leaf.rotation.set(0.18, angle, 0.25);
        group.add(leaf);
    }

    return group;
}

export function createCherryMesh() {
    const group = new THREE.Group();

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

    const body = new THREE.Mesh(cherryGeo, new THREE.MeshPhysicalMaterial({
        color: 0x730211,
        roughness: 0.03,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02
    }));
    body.castShadow = true;
    group.add(body);

    const stemGroup = new THREE.Group();
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x567527, roughness: 0.85 });
    const stemRadius = 0.008;
    const segmentHeight = 0.045;

    let lastY = 0.08;
    let lastX = 0;

    for (let i = 0; i < 6; i++) {
        const seg = new THREE.Mesh(
            new THREE.CylinderGeometry(stemRadius, stemRadius, segmentHeight, 6),
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
    return group;
}

export function createTopperMesh(topperStyle, customText = '', customRimColor = '', themeName = 'neon-rose') {
    if (topperStyle === 'none' && !customText) return null;

    const group = new THREE.Group();

    const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, 1.25, 8),
        new THREE.MeshStandardMaterial({ color: 0xe0e0e0, metalness: 0.9, roughness: 0.1 })
    );
    rod.position.y = 0.6;
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

        const frontBackMat = new THREE.MeshPhysicalMaterial({
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

        const sideMat = new THREE.MeshStandardMaterial({
            color: sideColor,
            roughness: 0.1,
            metalness: 0.9
        });

        const materials = [sideMat, sideMat, sideMat, sideMat, frontBackMat, frontBackMat];
        signMesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.04), materials);
        signMesh.position.y = 1.25;
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
        signMesh = new THREE.Mesh(heartGeo, new THREE.MeshPhysicalMaterial({
            color: heartColor,
            roughness: 0.1,
            metalness: 0.15,
            clearcoat: 1.0,
            clearcoatRoughness: 0.02,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x3d0006
        }));
        signMesh.position.y = 1.25;
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
        signMesh = new THREE.Mesh(starGeo, new THREE.MeshStandardMaterial({
            color: starColor,
            roughness: 0.1,
            metalness: 0.92,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x3f2f00
        }));
        signMesh.position.y = 1.25;
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
        signMesh = new THREE.Mesh(crownGeo, new THREE.MeshStandardMaterial({
            color: crownColor,
            roughness: 0.1,
            metalness: 0.95,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x331a00
        }));
        signMesh.position.y = 1.25;
    }

    if (signMesh) {
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

/** Pipes ruffled buttercream frills along a heart perimeter. */
export function addHeartPipingRing(group, scale, y, count = 38, colorHex = 0xfffafb, outset = 0, sizeScale = 1.4, detail = 1) {
    const points = heartPerimeterPoints(scale, scaleCount(count, detail, 16), outset);
    const mat = createButtercreamPipingMaterial(colorHex);
    points.forEach((pt, i) => {
        const seed = i * 2.1;
        const cream = createPipedCreamMesh(colorHex, seed, detail, mat);
        cream.position.set(pt.x, y + Math.sin(seed * 2.3) * 0.008, pt.z);
        cream.rotation.set(0.12, pt.angle, 0.05);
        const s = sizeScale + Math.sin(seed * 2.3) * 0.1;
        cream.scale.set(s, s * 1.2, s);
        group.add(cream);
    });
}

/** String of lustrous sugar pearls along a tier rim — one instanced draw. */
export function addPearlBorderRing(group, count, radius, y, material, pearlRadius = 0.045) {
    group.add(instanceRing(
        new THREE.SphereGeometry(pearlRadius, 12, 12),
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
        new THREE.SphereGeometry(pearlRadius, 12, 12),
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
        new THREE.MeshStandardMaterial({
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
            new THREE.MeshStandardMaterial({ color, roughness: 0.45 }),
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
    const seamMat = new THREE.MeshPhysicalMaterial({
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
    const clothMat = new THREE.MeshPhysicalMaterial({
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
