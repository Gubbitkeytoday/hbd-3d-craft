import * as THREE from 'three';
import {
    createHexPrismGeometry,
    part,
    partsToMesh,
    scaleCount
} from '../parts.js';

/**
 * Neo-Prism Crystal.
 *
 * A two-tier hexagonal mirror-glaze entremet: dark iridescent glaze with a
 * faint luminous honeycomb, crisp HDR edge piping that actually reaches the
 * bloom pass, a poured glaze cap dripping down the upper tier, and faceted
 * quartz-point clusters growing from the pedestal corners.
 *
 * Earlier versions leaned on sci-fi props (pylons, HUD scan disc, energy core)
 * and read as a machine; the hex grid texture was tiled ~45 cells per unit on
 * ExtrudeGeometry's world-space UVs, which turned it into a leopard-print
 * noise. Everything here is either edible-looking or pure light.
 */

// Hex-grid tile: two flat-top hex columns across, one row down. Its aspect
// (3R : sqrt(3)R) is what keeps the cells regular once mapped in world units.
const GRID_TILE_ASPECT = Math.sqrt(3) / 3;

/**
 * Seamless honeycomb line tile, white on black, used as an emissive mask so
 * the theme's neon colour is applied by the material. Thin lines with a soft
 * halo read as a luminous print inside the glaze rather than a printed mesh.
 */
function createHoneycombTexture() {
    const W = 512;
    const H = Math.round(W * GRID_TILE_ASPECT);
    const R = W / 3;
    const h = Math.sqrt(3) * R;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const hexPath = (cx, cy, r) => {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            const x = cx + Math.cos(a) * r;
            const y = cy + Math.sin(a) * r;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
    };

    // Drawing every neighbour, including off-canvas ones, is what makes the
    // strokes and their glow wrap across the tile seams.
    const eachCell = (fn) => {
        for (let col = -1; col <= 3; col++) {
            for (let row = -1; row <= 2; row++) {
                fn(col * 1.5 * R, row * h + (Math.abs(col) % 2 ? h / 2 : 0));
            }
        }
    };

    ctx.strokeStyle = '#fff';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.4;
    eachCell((x, y) => { hexPath(x, y, R); ctx.stroke(); });

    // Crisp core line on top of the halo
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 1;
    eachCell((x, y) => { hexPath(x, y, R); ctx.stroke(); });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    return texture;
}

/**
 * Replaces ExtrudeGeometry's world-projected UVs on a createHexPrismGeometry
 * prism: each side face is unwrapped along the perimeter with a whole number
 * of grid tiles per face (so cells line up across corners), v runs with
 * height, and cap/bevel-top faces are pinned to the blank centre of a cell so
 * the ledges stay clean glaze.
 */
function remapHexPrismUVs(geo, radius, tileWidth) {
    const tilesPerFace = Math.max(1, Math.round(radius / tileWidth));
    const tileW = radius / tilesPerFace;
    const tileH = tileW * GRID_TILE_ASPECT;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const step = Math.PI / 3;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();

    // ExtrudeGeometry is non-indexed, so every triangle owns its 3 vertices.
    for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i);
        b.fromBufferAttribute(pos, i + 1);
        c.fromBufferAttribute(pos, i + 2);
        n.subVectors(c, b).cross(a.clone().sub(b)).normalize();

        if (Math.abs(n.y) > 0.6) {
            // Middle of a flat-top cell in the tile: (R, h/2) -> (1/3, 1/2)
            for (let k = 0; k < 3; k++) uv.setXY(i + k, 1 / 3, 0.5);
            continue;
        }

        let theta = Math.atan2((a.z + b.z + c.z) / 3, (a.x + b.x + c.x) / 3);
        if (theta < 0) theta += Math.PI * 2;
        const face = Math.min(5, Math.floor(theta / step));
        const ax = Math.cos(face * step) * radius;
        const az = Math.sin(face * step) * radius;
        const dx = Math.cos((face + 1) * step) * radius - ax;
        const dz = Math.sin((face + 1) * step) * radius - az;
        const len = Math.hypot(dx, dz);

        for (let k = 0; k < 3; k++) {
            const px = pos.getX(i + k);
            const pz = pos.getZ(i + k);
            const along = ((px - ax) * dx + (pz - az) * dz) / len;
            uv.setXY(i + k, (face * radius + along) / tileW, pos.getY(i + k) / tileH);
        }
    }
    uv.needsUpdate = true;
}

/**
 * Vertical ombre baked into vertex colours: a flat face of mirror glaze
 * reflects one patch of the environment and reads as flat paint, while a
 * bottom-to-top lift towards the neon gives the poured-glaze depth of a real
 * entremet. Geometry is centred, so y runs -height/2..height/2.
 */
function applyOmbre(geo, height, bottom, top) {
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
        // Caps (the exposed ledge) stay at the mid tone, or the ledge turns
        // into a flat slab of the brightest colour.
        const t = Math.abs(nrm.getY(i)) > 0.6 ? 0.55
            : THREE.MathUtils.clamp(pos.getY(i) / height + 0.5, 0, 1);
        c.copy(bottom).lerp(top, t * t);
        c.toArray(colors, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Hex corner positions in the XZ plane, matching createHexPrismGeometry. */
function hexCorners(radius, rotationY) {
    const out = [];
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rotationY;
        out.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
    }
    return out;
}

/**
 * Edge "piping" for a hex prism as baked parts (thin cylinders, since WebGL
 * line width is capped at 1px). All frames merge into a single draw call.
 */
function hexEdgeParts(out, { radius, yBottom, yTop, rotationY = 0, thickness, verticals = true, bottom = true }) {
    const corners = hexCorners(radius, rotationY);
    const height = yTop - yBottom;
    if (verticals) {
        const strut = new THREE.CylinderGeometry(thickness, thickness, height, 6, 1, true);
        for (const c of corners) out.push(part(strut, { pos: [c.x, yBottom + height / 2, c.y] }));
        strut.dispose();
    }
    const side = corners[0].distanceTo(corners[1]);
    // Slightly overlong so neighbouring bars meet cleanly at the corners
    const bar = new THREE.CylinderGeometry(thickness, thickness, side + thickness, 6, 1, true);
    const rims = bottom ? [yBottom, yTop] : [yTop];
    for (const y of rims) {
        for (let i = 0; i < 6; i++) {
            const p = corners[i];
            const q = corners[(i + 1) % 6];
            out.push(part(bar, {
                pos: [(p.x + q.x) / 2, y, (p.y + q.y) / 2],
                rot: [0, -Math.atan2(q.y - p.y, q.x - p.x), Math.PI / 2]
            }));
        }
    }
    bar.dispose();
}

/**
 * One quartz point: hexagonal column with a six-facet pyramidal termination,
 * base at the origin, pointing +Y. Flat shading on the material turns every
 * face into its own mirror, which is what makes it read as cut crystal.
 */
function createQuartzGeometry() {
    const colH = 1.0;
    const tipH = 0.55;
    const column = new THREE.CylinderGeometry(0.2, 0.24, colH, 6, 1, true);
    column.translate(0, colH / 2, 0);
    const tip = new THREE.ConeGeometry(0.2, tipH, 6, 1, true);
    tip.translate(0, colH + tipH / 2, 0);
    const parts = [column, tip].map((g) => g.toNonIndexed());
    column.dispose();
    tip.dispose();
    return parts;
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** A crystal part standing at `base`, pointing along `dir`, spun by `spin`. */
function quartzParts(out, quartz, base, dir, { length, girth, spin }) {
    _dir.copy(dir).normalize();
    _q.setFromUnitVectors(_up, _dir);
    _q.multiply(new THREE.Quaternion().setFromAxisAngle(_up, spin));
    _e.setFromQuaternion(_q);
    for (const g of quartz) {
        out.push(part(g, { pos: [base.x, base.y, base.z], rot: [_e.x, _e.y, _e.z], scale: [girth, length, girth] }));
    }
}

export function buildCyberPrism(group, ctx) {
    const { plateMat, glazeMat, colorTier1, colorTier2, accentColor, detail = 1 } = ctx;

    // Neon colour. White/grey accents (neon-rose, pastel-mint) have no hue to
    // saturate, so fall back to the lower tier's hue instead of drifting to red.
    const neon = new THREE.Color(accentColor);
    const hsl = { h: 0, s: 0, l: 0 };
    neon.getHSL(hsl);
    if (hsl.s < 0.2) new THREE.Color(colorTier1).getHSL(hsl);
    neon.setHSL(hsl.h, Math.max(0.85, hsl.s), 0.5);

    // The bloom pass thresholds at luminance 1.35 on an HDR target, so an
    // in-gamut colour never glows. Push the piping well above 1.
    const pipingMat = new THREE.MeshBasicMaterial({ color: neon.clone().multiplyScalar(3.2), toneMapped: false });
    const plateLineMat = new THREE.MeshBasicMaterial({ color: neon.clone().multiplyScalar(1.1), toneMapped: false });

    // Faceted pedestal
    const standPlate = new THREE.Mesh(createHexPrismGeometry(2.65, 0.12, 0.02), plateMat);
    standPlate.position.y = -0.58;
    standPlate.receiveShadow = true;
    standPlate.castShadow = true;
    group.add(standPlate);

    const standStem = new THREE.Mesh(createHexPrismGeometry(0.55, 0.5, 0.03), plateMat);
    standStem.position.y = -0.88;
    group.add(standStem);

    const standBase = new THREE.Mesh(createHexPrismGeometry(1.35, 0.08, 0.02), plateMat);
    standBase.position.y = -1.13;
    group.add(standBase);

    // Mirror-glaze tiers. Opaque on purpose: transmission on a dark body just
    // shows the backdrop through it (murky), and costs an extra scene pass.
    const honeycomb = createHoneycombTexture();
    const glazeTier = (gridStrength) => new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        roughness: 0.1,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        iridescence: 0.55,
        iridescenceIOR: 1.6,
        iridescenceThicknessRange: [260, 620],
        sheen: 0.4,
        sheenColor: neon.clone().multiplyScalar(0.6),
        sheenRoughness: 0.35,
        emissive: neon,
        emissiveMap: honeycomb,
        emissiveIntensity: gridStrength
    });

    const T1 = { r: 2.1, h: 0.95, y: -0.05, rot: 0 };
    const T2 = { r: 1.42, h: 0.8, y: 0.82, rot: Math.PI / 6 };
    const TILE = 0.42;

    // Bright tier colours already sit near the neon; keep the grid a whisper there.
    const gridFor = (c) => THREE.MathUtils.lerp(0.34, 0.12, Math.min(1, new THREE.Color(c).getHSL(hsl).l * 1.6));

    const tier1Geo = createHexPrismGeometry(T1.r, T1.h, 0.05);
    remapHexPrismUVs(tier1Geo, T1.r, TILE);
    applyOmbre(tier1Geo, T1.h, new THREE.Color(colorTier1), new THREE.Color(colorTier1).lerp(neon, 0.11));
    const hexTier1 = new THREE.Mesh(tier1Geo, glazeTier(gridFor(colorTier1)));
    hexTier1.position.y = T1.y;
    hexTier1.rotation.y = T1.rot;
    hexTier1.castShadow = true;
    hexTier1.receiveShadow = true;
    group.add(hexTier1);

    const tier2Geo = createHexPrismGeometry(T2.r, T2.h, 0.04);
    remapHexPrismUVs(tier2Geo, T2.r, TILE);
    // A touch more lift on the upper tier so the two stay distinct even when
    // a custom cream colour paints both tiers the same.
    applyOmbre(tier2Geo, T2.h, new THREE.Color(colorTier2), new THREE.Color(colorTier2).lerp(neon, 0.2));
    const hexTier2 = new THREE.Mesh(tier2Geo, glazeTier(gridFor(colorTier2)));
    hexTier2.position.y = T2.y;
    hexTier2.rotation.y = T2.rot;
    hexTier2.castShadow = true;
    hexTier2.receiveShadow = true;
    group.add(hexTier2);

    // Poured glaze cap on the top tier, plus drips running down its faces:
    // the one cue that makes a hexagonal prism unmistakably a cake.
    const T2top = T2.y + T2.h / 2;
    const hexGlaze = new THREE.Mesh(createHexPrismGeometry(1.45, 0.07, 0.025), glazeMat);
    hexGlaze.position.y = T2top - 0.015;
    hexGlaze.rotation.y = T2.rot;
    hexGlaze.receiveShadow = true;
    group.add(hexGlaze);

    // createHexPrismGeometry corners sit at k*60deg; mesh.rotation.y = rot turns
    // them to k*60deg - rot, which for a hexagon is the same set as +rot.
    const drips = [];
    const dripGeo = new THREE.CapsuleGeometry(0.034, 1, 3, 8);
    const perFace = Math.max(3, Math.round(scaleCount(36, detail, 18) / 6));
    const apothem = (T2.r + 0.012) * Math.cos(Math.PI / 6);
    const side = T2.r;
    for (let f = 0; f < 6; f++) {
        const faceAngle = f * (Math.PI / 3); // face centres for rot = 30deg
        const nx = Math.cos(faceAngle);
        const nz = Math.sin(faceAngle);
        for (let k = 0; k < perFace; k++) {
            const t = ((k + 0.5) / perFace - 0.5) * side * 0.86;
            // Deterministic length rhythm: long, short, medium...
            const len = 0.1 + 0.26 * (0.5 + 0.5 * Math.sin(f * 2.3 + k * 1.9));
            const x = nx * apothem - nz * t;
            const z = nz * apothem + nx * t;
            drips.push(part(dripGeo, {
                pos: [x, T2top - 0.02 - len / 2, z],
                rot: [0, -faceAngle, 0],
                scale: [0.55, len, 1]
            }));
        }
    }
    dripGeo.dispose();
    // Capsule scaled on Y would stretch its round ends; they are tiny at this
    // size and the stretch reads as a natural teardrop.
    const dripMesh = partsToMesh(drips, glazeMat);
    group.add(dripMesh);

    // Edge piping: both tiers merged into one unlit, blooming mesh
    const piping = [];
    hexEdgeParts(piping, { radius: T1.r, yBottom: T1.y - T1.h / 2, yTop: T1.y + T1.h / 2, rotationY: T1.rot, thickness: 0.016 });
    hexEdgeParts(piping, { radius: T2.r, yBottom: T2.y - T2.h / 2, yTop: T2top, rotationY: T2.rot, thickness: 0.014 });
    const pipingMesh = partsToMesh(piping, pipingMat);
    pipingMesh.castShadow = false;
    pipingMesh.receiveShadow = false;
    pipingMesh.raycast = () => {};
    group.add(pipingMesh);

    // Softer outline around the pedestal rim, below bloom threshold
    const plateLine = [];
    hexEdgeParts(plateLine, { radius: 2.635, yBottom: -0.52, yTop: -0.52, thickness: 0.009, verticals: false, bottom: false });
    const plateLineMesh = partsToMesh(plateLine, plateLineMat);
    plateLineMesh.castShadow = false;
    plateLineMesh.raycast = () => {};
    group.add(plateLineMesh);

    // Quartz clusters: three geode-like clusters at alternating pedestal
    // corners, and single small points on the lower tier's ledge at the other
    // three, so the crystals repeat the hexagon's rhythm instead of floating.
    const crystalMat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(0xffffff).lerp(neon, 0.7),
        emissive: neon,
        emissiveIntensity: 0.45,
        roughness: 0.03,
        metalness: 0.35,
        clearcoat: 1.0,
        clearcoatRoughness: 0.0,
        iridescence: 1.0,
        iridescenceIOR: 1.8,
        iridescenceThicknessRange: [200, 520],
        flatShading: true,
        side: THREE.DoubleSide
    });
    const quartz = createQuartzGeometry();
    const crystals = [];
    const plateTop = -0.52;
    // [lateral offset, outward lean, up, length, girth, spin]
    const cluster = [
        [0.0, 0.35, 1, 0.62, 0.62, 0.2],
        [-0.17, 0.75, 1, 0.42, 0.48, 0.9],
        [0.18, 0.65, 1, 0.46, 0.5, 1.7],
        [-0.07, 1.1, 0.8, 0.3, 0.38, 2.4],
        [0.1, 1.2, 0.7, 0.24, 0.34, 0.5]
    ];
    const clusterSize = detail < 0.75 ? 4 : 5;
    const outward = new THREE.Vector3();
    const lateral = new THREE.Vector3();
    const base = new THREE.Vector3();
    const dir = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
        const a = i * (Math.PI * 2 / 3) + T1.rot;
        outward.set(Math.cos(a), 0, Math.sin(a));
        lateral.set(-outward.z, 0, outward.x);
        for (let k = 0; k < clusterSize; k++) {
            const [off, lean, up, length, girth, spin] = cluster[k];
            base.copy(outward).multiplyScalar(2.3 + Math.abs(off) * 0.3).addScaledVector(lateral, off);
            base.y = plateTop - 0.03;
            dir.copy(outward).multiplyScalar(lean).addScaledVector(lateral, off * 2.2);
            dir.y = up;
            quartzParts(crystals, quartz, base, dir, { length, girth, spin: spin + i });
        }
    }
    const ledgeY = T1.y + T1.h / 2;
    for (let i = 0; i < 3; i++) {
        const a = i * (Math.PI * 2 / 3) + Math.PI / 3 + T1.rot;
        outward.set(Math.cos(a), 0, Math.sin(a));
        lateral.set(-outward.z, 0, outward.x);
        base.copy(outward).multiplyScalar(1.72);
        base.y = ledgeY - 0.02;
        quartzParts(crystals, quartz, base, dir.copy(outward).multiplyScalar(0.28).setY(1), { length: 0.34, girth: 0.4, spin: i });
        base.addScaledVector(lateral, 0.11).addScaledVector(outward, 0.05);
        quartzParts(crystals, quartz, base, dir.copy(outward).multiplyScalar(0.6).addScaledVector(lateral, 0.4).setY(1), { length: 0.2, girth: 0.3, spin: i + 1 });
    }
    quartz.forEach((g) => g.dispose());
    group.add(partsToMesh(crystals, crystalMat));
}
