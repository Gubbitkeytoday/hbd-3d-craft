import * as THREE from 'three';
import {
    addHeartPipingRing,
    createBeveledCylinder,
    createButtercreamMaterial,
    createButtercreamPipingMaterial,
    createHeartCakeGeometry,
    createPipedCreamMesh,
    heartPerimeterPoints,
    partsToMesh,
    scaleCount,
    sharedMaterial
} from '../parts.js';

/**
 * Vintage Coquette Heart.
 *
 * Lambeth-revival heart cake: a double shell border top and bottom (plain
 * shells outside, zig-zag reverse shells inside), a ruffled collar hanging
 * from the top edge, two layers of string-work swags with pearl drops and
 * rosettes at the anchors, a pearl-rimmed heart plate on a footed stand, and
 * a satin bow on the point.
 *
 * Vertical layout (world y): plate top -0.49, body -0.49 .. 0.71, glaze to
 * ~0.74. Keep CAKE_LAYOUTS['vintage-heart'] in step if these move.
 */

const SCALE = 0.96;           // ~3.2 wide, ~3.0 deep
const BODY_BOTTOM = -0.49;
const BODY_H = 1.2;
const BODY_TOP = BODY_BOTTOM + BODY_H;
const EDGE_R = 0.1;           // rounded top edge of the body

export function buildVintageHeart(group, ctx) {
    const { plateMat, glazeMat, crumbBumpTex, colorTier1, accentColor, creamTint, detail } = ctx;

    const accent = new THREE.Color(accentColor);
    const ruffleColor = new THREE.Color(creamTint).lerp(accent, 0.28).getHex();
    const pearlMat = sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: 0xfff6ee,
        roughness: 0.14,
        metalness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        iridescence: 0.55,
        iridescenceIOR: 1.4,
        sheen: 0.4,
        sheenColor: new THREE.Color(0xffe8f0)
    });
    const creamMat = createButtercreamPipingMaterial(creamTint);
    const accentMat = createButtercreamPipingMaterial(accentColor);

    buildStand(group, plateMat, pearlMat, detail);

    // Body. A smooth-iced heart wants a much finer bump than a crumb-coated
    // tier; the palette-knife swipes only need to catch the light.
    const hsl = colorTier1.getHSL({});
    // Near-black icing under a white sheen reads as grey plastic. Dark
    // themes get a glossier ganache finish with the sheen tinted by the
    // accent, so the body stays deep and the piping does the sparkling.
    const bodyMat = createButtercreamMaterial(colorTier1, crumbBumpTex, 0.05, hsl.l < 0.22 ? {
        roughness: 0.4,
        clearcoat: 0.55,
        clearcoatRoughness: 0.28,
        sheen: 0.45,
        sheenColor: accent.clone().multiplyScalar(0.35)
    } : {});
    const body = new THREE.Mesh(createHeartCakeGeometry(SCALE, BODY_H, EDGE_R), bodyMat);
    body.position.y = BODY_BOTTOM + BODY_H / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Poured glaze on top, slightly inset; the top border hides its edge
    const glaze = new THREE.Mesh(createHeartCakeGeometry(SCALE * 0.975, 0.05, 0.022), glazeMat);
    glaze.position.y = BODY_TOP + 0.005;
    glaze.receiveShadow = true;
    group.add(glaze);

    // Ruffled collar hanging from the top edge: the coquette signature
    addRuffle(group, SCALE, {
        yTop: BODY_TOP - EDGE_R * 0.7,
        height: 0.2,
        outset: 0.004,
        flare: 0.06,
        amp: 0.035,
        waves: 64,
        color: ruffleColor,
        detail
    });

    // Top: double shell border. Plain shells lean out over the edge and sit
    // on the ruffle's seam; zig-zag reverse shells in the accent run inside.
    addHeartPipingRing(group, SCALE, BODY_TOP + 0.01, {
        count: 58, material: creamMat, color: creamTint, outset: -0.035,
        size: 0.82, tilt: 0.75, detail
    });
    addHeartPipingRing(group, SCALE, BODY_TOP + 0.045, {
        count: 46, material: accentMat, color: accentColor, outset: -0.2,
        size: 0.6, tilt: -0.15, zigzag: 0.42, reverse: true, detail
    });

    // Bottom: the same pairing, bigger shells at the foot
    addHeartPipingRing(group, SCALE, BODY_BOTTOM + 0.07, {
        count: 52, material: creamMat, color: creamTint, outset: 0.03,
        size: 1.0, tilt: 0.5, detail
    });
    addHeartPipingRing(group, SCALE, BODY_BOTTOM + 0.2, {
        count: 60, material: accentMat, color: accentColor, outset: 0.005,
        size: 0.55, tilt: 1.1, zigzag: 0.38, reverse: true, detail
    });

    // String-work swags, two layers on shared anchors. 12 swags keeps an
    // anchor on the cleft and one on the point, so both halves match.
    const SWAGS = 12;
    const anchorY = BODY_TOP - 0.33;
    addStringSwags(group, SCALE, {
        y: anchorY, sag: 0.26, swags: SWAGS, belly: 0.03, radius: 0.019,
        material: creamMat, detail
    });
    addStringSwags(group, SCALE, {
        y: anchorY, sag: 0.15, swags: SWAGS, belly: 0.02, radius: 0.016,
        material: accentMat, detail
    });

    // Pearls: a string along the top between the two shell rows, drops under
    // every swag and a bead at each anchor. All one instanced draw.
    const pearls = [];
    heartPerimeterPoints(SCALE, scaleCount(72, detail, 36), -0.115).forEach((p) => {
        pearls.push([p.x, BODY_TOP + 0.03, p.z, 0.026]);
    });
    const swagPts = heartPerimeterPoints(SCALE, SWAGS * 2, 0);
    swagPts.forEach((p, i) => {
        if (i % 2 === 0) {
            pearls.push([p.x + p.nx * 0.085, anchorY + 0.005, p.z + p.nz * 0.085, 0.03]);
        } else {
            // Drop hangs just below the deepest point of the lower swag
            const dy = anchorY - 0.26;
            pearls.push([p.x + p.nx * 0.05, dy - 0.045, p.z + p.nz * 0.05, 0.026]);
            pearls.push([p.x + p.nx * 0.05, dy - 0.095, p.z + p.nz * 0.05, 0.02]);
        }
    });
    addPearls(group, pearls, pearlMat);

    // Rosettes on the anchors, pointing out of the wall. The point gets the
    // bow instead.
    const rosetteParts = [];
    swagPts.forEach((p, i) => {
        if (i % 2 || i === SWAGS) return;
        const g = createPipedCreamMesh(accentColor, i * 1.3, detail, accentMat).geometry;
        rosetteParts.push(bakeAlong(g, p, [p.x + p.nx * 0.03, anchorY, p.z + p.nz * 0.03], 0.95));
    });
    if (rosetteParts.length) group.add(partsToMesh(rosetteParts, accentMat));

    // The bow on the point, facing +Z like the camera's default view
    const tip = swagPts[SWAGS];
    const bow = createRibbonBow(accentColor, detail);
    bow.position.set(tip.x, anchorY + 0.03, tip.z + 0.07);
    bow.rotation.x = -0.1;
    bow.scale.setScalar(1.6);
    group.add(bow);
}

/**
 * A satin bow built from real ribbon strips: two billowing loops pinched at
 * the knot and two tails with forked ends. The shared createSatinBowMesh is
 * torus tubing, which at this size read as bent wire rather than fabric.
 * Faces +Z, knot at the origin, ~0.62 wide.
 */
function createRibbonBow(colorHex, detail) {
    const seg = detail < 1 ? 20 : 34;
    const parts = [];

    // Strip along `centre(t)`, `width(t)` wide across `across(t)` (unit),
    // with an optional per-edge lengthwise offset to cut forked tails.
    const strip = (centre, across, width, steps, fork = 0) => {
        const pos = [];
        const idx = [];
        const COLS = 3;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const c = centre(t);
            const a = across(t);
            const w = width(t);
            for (let k = 0; k < COLS; k++) {
                const u = k / (COLS - 1) * 2 - 1;
                // The fork pulls the middle of the last row back up the tail
                const back = i === steps ? fork * (1 - Math.abs(u)) : 0;
                const cb = back ? centre(t - back) : c;
                pos.push(cb.x + a.x * u * w / 2, cb.y + a.y * u * w / 2, cb.z + a.z * u * w / 2);
            }
        }
        for (let i = 0; i < steps; i++) {
            for (let k = 0; k < COLS - 1; k++) {
                const p = i * COLS + k;
                idx.push(p, p + COLS, p + 1, p + 1, p + COLS, p + COLS + 1);
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        return g;
    };

    for (const side of [-1, 1]) {
        // Loop: a teardrop that leaves the knot, swings out and back, and
        // puffs toward the viewer at its widest
        const loop = new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.03, 0.015, 0), new THREE.Vector3(0.13, 0.11, 0.03),
            new THREE.Vector3(0.26, 0.14, 0.05), new THREE.Vector3(0.33, 0.05, 0.05),
            new THREE.Vector3(0.28, -0.06, 0.04), new THREE.Vector3(0.14, -0.06, 0.03),
            new THREE.Vector3(0.03, -0.015, 0)
        ].map((v) => v.set(v.x * side, v.y, v.z)), false, 'centripetal');
        parts.push(strip(
            (t) => loop.getPoint(t),
            // Width runs front-to-back, leaning so the loop shows its face
            () => new THREE.Vector3(0, 0.35, 1).normalize(),
            (t) => 0.05 + 0.1 * Math.sin(Math.PI * t),
            seg
        ));

        // Tail: falls from the knot, flares and flips slightly outward
        const tail = new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.015, -0.03, 0.01), new THREE.Vector3(0.06, -0.14, 0.03),
            new THREE.Vector3(0.1, -0.26, 0.035), new THREE.Vector3(0.16, -0.37, 0.03)
        ].map((v) => v.set(v.x * side, v.y, v.z)));
        parts.push(strip(
            (t) => tail.getPoint(t),
            (t) => {
                const d = tail.getTangent(t);
                // Perpendicular to the tail in the facing plane, twisting a
                // little toward the viewer as it falls
                return new THREE.Vector3(-d.y, d.x, 0.25 * t * side).normalize();
            },
            (t) => 0.06 + 0.035 * t,
            Math.round(seg * 0.6),
            0.14
        ));
    }

    const knot = new THREE.SphereGeometry(0.058, 16, 12);
    knot.scale(1.05, 1.0, 0.75);
    knot.deleteAttribute('uv');
    parts.push(knot);

    parts.forEach((g) => g.deleteAttribute('normal'));
    const mesh = partsToMesh(parts, sharedMaterial(THREE.MeshPhysicalMaterial, {
        color: colorHex,
        roughness: 0.32,
        metalness: 0.0,
        sheen: 1.0,
        sheenRoughness: 0.28,
        sheenColor: new THREE.Color(0xffffff),
        clearcoat: 0.6,
        clearcoatRoughness: 0.18,
        side: THREE.DoubleSide
    }));
    const g = new THREE.Group();
    g.add(mesh);
    return g;
}

/**
 * Footed cake stand: pearl-rimmed heart plate on a turned baluster stem.
 */
function buildStand(group, plateMat, pearlMat, detail) {
    const PLATE_SCALE = SCALE * 1.13;
    const plate = new THREE.Mesh(createHeartCakeGeometry(PLATE_SCALE, 0.1, 0.04), plateMat);
    plate.position.y = BODY_BOTTOM - 0.05;
    plate.castShadow = true;
    plate.receiveShadow = true;
    group.add(plate);

    // Pearl rim on the plate's edge
    const rim = heartPerimeterPoints(PLATE_SCALE, scaleCount(84, detail, 44), -0.035)
        .map((p) => [p.x, BODY_BOTTOM + 0.005, p.z, 0.022]);
    addPearls(group, rim, pearlMat);

    // Turned stem: collar, waist, a bead, then a flared foot
    const profile = [
        [0.0, -0.6], [0.3, -0.6], [0.3, -0.63], [0.2, -0.67], [0.13, -0.75],
        [0.115, -0.84], [0.17, -0.89], [0.17, -0.92], [0.13, -0.96],
        [0.2, -1.0], [0.42, -1.04], [0.6, -1.06], [0.0, -1.06]
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const stem = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), plateMat);
    stem.castShadow = true;
    group.add(stem);

    const foot = new THREE.Mesh(createBeveledCylinder(0.95, 0.08, 0.025), plateMat);
    foot.position.y = -1.1;
    foot.receiveShadow = true;
    group.add(foot);
}

/**
 * A pleated ruffle hanging from a heart perimeter: one double-sided strip
 * whose free edge flares out and folds in and out `waves` times.
 */
function addRuffle(group, scale, { yTop, height, outset, flare, amp, waves, color, detail }) {
    const perCol = detail < 1 ? 5 : 8;
    const cols = waves * perCol;
    const ROWS = 6;
    const pts = heartPerimeterPoints(scale, cols, 0);

    const pos = [];
    const idx = [];
    for (let i = 0; i <= cols; i++) {
        const p = pts[i % cols];
        const w = Math.sin((i / cols) * Math.PI * 2 * waves);
        for (let j = 0; j <= ROWS; j++) {
            const v = j / ROWS;
            // Folds grow toward the free edge; the seam stays flat to the wall
            const off = outset + Math.pow(v, 1.3) * flare + v * v * amp * w;
            pos.push(p.x + p.nx * off, yTop - height * v + v * v * amp * 0.5 * w, p.z + p.nz * off);
        }
    }
    for (let i = 0; i < cols; i++) {
        for (let j = 0; j < ROWS; j++) {
            const a = i * (ROWS + 1) + j;
            const b = a + ROWS + 1;
            idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = createButtercreamPipingMaterial(color, { side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
}

/**
 * Lambeth string work: one continuous piped line that sags into `swags`
 * scallops around the heart and bellies slightly off the wall. One tube.
 */
function addStringSwags(group, scale, { y, sag, swags, belly, radius, material, detail }) {
    const per = detail < 1 ? 10 : 16;
    const count = swags * per;
    const pts = heartPerimeterPoints(scale, count, 0);
    const path = pts.map((p, i) => {
        const dip = Math.abs(Math.sin((i / count) * Math.PI * swags));
        const off = 0.012 + belly * dip;
        return new THREE.Vector3(p.x + p.nx * off, y - sag * Math.pow(dip, 0.85), p.z + p.nz * off);
    });
    const curve = new THREE.CatmullRomCurve3(path, true, 'centripetal');
    const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, count * 2, radius, detail < 1 ? 5 : 7, true),
        material
    );
    tube.castShadow = true;
    group.add(tube);
}

/** Instanced pearls from [x, y, z, radius] tuples. */
function addPearls(group, list, material) {
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 10), material, list.length);
    const m = new THREE.Matrix4();
    list.forEach(([x, y, z, r], i) => {
        m.makeScale(r, r, r).setPosition(x, y, z);
        mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    group.add(mesh);
}

/**
 * Clones `geo` with its +Y turned along a perimeter point's outward normal
 * (and +X along the perimeter), scaled and moved to `at`.
 */
function bakeAlong(geo, p, at, scale) {
    const X = new THREE.Vector3(p.tx, 0, p.tz);
    const Y = new THREE.Vector3(p.nx, 0, p.nz);
    const Z = new THREE.Vector3().crossVectors(X, Y);
    const m = new THREE.Matrix4().makeBasis(X, Y, Z).scale(new THREE.Vector3(scale, scale, scale));
    m.setPosition(at[0], at[1], at[2]);
    const out = geo.clone().applyMatrix4(m);
    geo.dispose();
    return out;
}
