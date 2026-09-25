import * as THREE from 'three';
import {
    addGlazeDrips,
    createBeveledCylinder,
    createButtercreamMaterial,
    createGoldLeafMesh,
    createGoldMaterial,
    createMacaronMesh,
    createRoseRosetteMesh,
    createSatinBowMesh,
    instanceRing,
    part,
    partsToMesh,
    scaleCount
} from '../parts.js';

/**
 * Grand Majestic 3-Tier.
 *
 * Styled as a wedding cake rather than a stack of cylinders: every tier sits
 * on a thin gilded board and wears a satin ribbon with a pearl border, so the
 * joints read even when both tiers share one colour (most themes override both
 * with a single cream colour). The base carries full fondant drapery, the
 * middle is pillow-quilted with pearl studs, and the top stays clean for the
 * fruit, candles and topper that land on it.
 *
 * The cascade is placed, not scattered: macarons and roses rest on the two
 * ledges and the stand, and the few that climb a wall are seated into it.
 * Every resting height is derived from the piece's own dimensions so nothing
 * hovers or pokes through.
 */

// Macaron half-thickness and rim radius at scale 1 (see createMacaronMesh:
// shells at ±0.024 with a 0.048 dome, foot torus out to ~0.11).
const MAC_HALF_T = 0.072;
const MAC_R = 0.11;

export function buildTripleLuxury(group, ctx) {
    const { plateMat, glazeMat, crumbBumpTex, colorTier1, colorTier2, accentColor, creamTint, detail } = ctx;

    const goldMat = createGoldMaterial();
    const accent = new THREE.Color(accentColor);

    // Ivory pearls: gold is kept for thin lines and a few accents, otherwise
    // the cake turns into brass. A touch of iridescence gives nacre, not plastic.
    const pearlMat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(0xfff8ee).lerp(accent, 0.06),
        roughness: 0.22,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        sheen: 0.6,
        sheenColor: new THREE.Color(0xffffff),
        iridescence: 0.45,
        iridescenceIOR: 1.6
    });

    // Satin ribbon follows the theme accent (gold satin on midnight, pink on
    // sakura). Low metalness: satin, not foil.
    const ribbonMat = new THREE.MeshPhysicalMaterial({
        color: accent.clone().lerp(new THREE.Color(0xffffff), 0.12),
        roughness: 0.3,
        metalness: 0.15,
        sheen: 1.0,
        sheenRoughness: 0.25,
        sheenColor: new THREE.Color(0xffffff),
        clearcoat: 0.5,
        clearcoatRoughness: 0.2
    });

    // --- Pedestal ------------------------------------------------------------
    const STAND_R = 2.4;
    const standPlate = new THREE.Mesh(createBeveledCylinder(STAND_R, 0.12, 0.02), plateMat);
    standPlate.position.y = -0.72;
    standPlate.receiveShadow = true;
    standPlate.castShadow = true;
    group.add(standPlate);

    const standRim = new THREE.Mesh(new THREE.TorusGeometry(STAND_R - 0.005, 0.018, 8, 120), goldMat);
    standRim.rotation.x = Math.PI / 2;
    standRim.position.y = -0.7;
    group.add(standRim);

    const standStem = new THREE.Mesh(createBeveledCylinder(0.55, 0.45, 0.03), plateMat);
    standStem.position.y = -0.99;
    group.add(standStem);

    const standBase = new THREE.Mesh(createBeveledCylinder(1.35, 0.08, 0.02), plateMat);
    standBase.position.y = -1.25;
    group.add(standBase);

    // --- Tiers ---------------------------------------------------------------
    // Each entry is the authority for everything that touches that tier. The
    // upper two sit on 0.025 boards, which is what makes the joint read as a
    // crisp shadow line instead of one tier melting into the next.
    const BOARD = 0.025;
    const tiers = [
        { r: 1.9, yBottom: -0.66, yTop: 0.3, color: colorTier1 },
        { r: 1.42, yBottom: 0.3 + BOARD, yTop: 1.125, color: colorTier2 },
        { r: 1.0, yBottom: 1.125 + BOARD, yTop: 1.82, color: colorTier1 }
    ];

    tiers.forEach((t, i) => {
        // The middle tier is lifted a hair so identical colours still separate
        const color = new THREE.Color(t.color).lerp(new THREE.Color(0xffffff), i === 1 ? 0.05 : 0);
        const mesh = new THREE.Mesh(
            createBeveledCylinder(t.r, t.yTop - t.yBottom, 0.04),
            createButtercreamMaterial(color, crumbBumpTex, 0.08)
        );
        mesh.position.y = (t.yBottom + t.yTop) / 2;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);

        if (i > 0) {
            const board = new THREE.Mesh(createBeveledCylinder(t.r + 0.03, BOARD, 0.008), goldMat);
            board.position.y = t.yBottom - BOARD / 2;
            board.receiveShadow = true;
            group.add(board);
        }
    });

    // --- Ribbon bands + pearl borders at every tier base ---------------------
    const RIBBON_H = 0.13;
    const pearlGeo = new THREE.SphereGeometry(1, 12, 10);
    tiers.forEach((t, i) => {
        const band = new THREE.Mesh(
            new THREE.CylinderGeometry(t.r + 0.012, t.r + 0.012, RIBBON_H, Math.min(128, Math.round(t.r * 56)), 1, true),
            ribbonMat
        );
        band.position.y = t.yBottom + RIBBON_H / 2 + 0.01;
        band.castShadow = true;
        group.add(band);

        // Pearls sit ON the ledge (or stand) in front of the ribbon's lower edge
        const pr = 0.036 - i * 0.003;
        const count = scaleCount(Math.round((Math.PI * 2 * (t.r + pr)) / (pr * 2.05)), detail, 40);
        group.add(instanceRing(pearlGeo, pearlMat, count, (d, k) => {
            const a = (k / count) * Math.PI * 2;
            d.position.set(Math.cos(a) * (t.r + pr), t.yBottom + pr, Math.sin(a) * (t.r + pr));
            d.rotation.set(0, 0, 0);
            d.scale.setScalar(pr);
        }));
    });

    // A single bow on the middle ribbon, on the side facing away from the
    // cascade, so each face of the cake has one focal point.
    const CASCADE_A = 0.55;
    {
        const a = CASCADE_A + Math.PI;
        const bow = createSatinBowMesh(ribbonMat.color.getHex(), 0.85);
        bow.position.set(Math.cos(a) * (tiers[1].r + 0.07), tiers[1].yBottom + 0.2, Math.sin(a) * (tiers[1].r + 0.07));
        bow.rotation.y = Math.PI / 2 - a;
        group.add(bow);
    }

    // --- Base tier: full fondant drapery -------------------------------------
    addFullSwags(group, {
        radius: tiers[0].r + 0.01,
        y: tiers[0].yTop - 0.07,
        count: scaleCount(8, detail, 6),
        color: creamTint,
        goldMat,
        pearlMat,
        detail
    });

    // --- Middle tier: pillow quilting with pearl studs -----------------------
    addPillowQuilting(group, {
        radius: tiers[1].r,
        yBottom: tiers[1].yBottom + RIBBON_H + 0.05,
        yTop: tiers[1].yTop - 0.06,
        diamonds: scaleCount(26, detail, 18),
        rows: 2,
        // Seams in a darker shade of the tier read as pressed-in, not as wire
        seamColor: new THREE.Color(colorTier2).lerp(new THREE.Color(0x000000), 0.35)
            .lerp(accent, 0.15).getHex(),
        pearlMat
    });

    // --- Top tier: glaze crown -----------------------------------------------
    const glazeTop = new THREE.Mesh(createBeveledCylinder(tiers[2].r + 0.02, 0.08, 0.02), glazeMat);
    glazeTop.position.y = tiers[2].yTop + 0.02;
    group.add(glazeTop);
    addGlazeDrips(group, glazeMat, scaleCount(16, detail, 10), tiers[2].r + 0.01, tiers[2].yTop + 0.02, 7);

    // --- Cascade -------------------------------------------------------------
    addCascade(group, { tiers, STAND_R, CASCADE_A, accent, creamTint, detail });
}

/* ------------------------------------------------------------------ *
 * Model-local decorations
 * ------------------------------------------------------------------ */

/**
 * Fondant swags as a real draped sheet rather than a tube: a curved strip
 * whose top edge sags a little and bottom edge a lot, bellying outward and
 * gathered into soft pleats. Anchors carry a pearl-and-gold jewel.
 */
function addFullSwags(group, { radius, y, count, color, goldMat, pearlMat, detail }) {
    const clothMat = new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.48,
        metalness: 0.0,
        sheen: 1.0,
        sheenRoughness: 0.3,
        sheenColor: new THREE.Color(0xffffff),
        side: THREE.DoubleSide
    });

    const span = (Math.PI * 2) / count;
    const NT = Math.round(28 * Math.max(detail, 0.6));
    const NS = 10;
    const PLEATS = 3;
    const parts = [];

    for (let i = 0; i < count; i++) {
        const start = i * span;
        const pos = [];
        const idx = [];
        for (let it = 0; it <= NT; it++) {
            const t = it / NT;
            const a = start + t * span;
            const hang = Math.sin(t * Math.PI);
            const yTopEdge = y - hang * 0.09;
            const yBotEdge = y - 0.035 - hang * 0.38;
            for (let is = 0; is <= NS; is++) {
                const s = is / NS;
                // Belly outward most at mid-span and mid-width; pleats are
                // ridges running along the swag, fading out at the gathers.
                const belly = hang * (0.02 + 0.06 * Math.sin(s * Math.PI));
                const pleat = 0.016 * Math.pow(hang, 0.6) * (0.5 + 0.5 * Math.cos(s * Math.PI * 2 * PLEATS));
                const r = radius + belly + pleat;
                pos.push(Math.cos(a) * r, yTopEdge + (yBotEdge - yTopEdge) * s, Math.sin(a) * r);
            }
        }
        for (let it = 0; it < NT; it++) {
            for (let is = 0; is < NS; is++) {
                const a0 = it * (NS + 1) + is;
                const b0 = a0 + NS + 1;
                idx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1);
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        parts.push(g);
    }
    group.add(partsToMesh(parts, clothMat));

    // Anchor jewels: gold collar, pearl, and a short gold drop below
    const collarGeo = new THREE.TorusGeometry(0.038, 0.012, 8, 16);
    const dropGeo = new THREE.ConeGeometry(0.03, 0.12, 10);
    const gold = [];
    const pearlGeo = new THREE.SphereGeometry(0.042, 14, 12);
    const pearls = [];
    for (let i = 0; i < count; i++) {
        const a = i * span;
        const r = radius + 0.035;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        gold.push(part(collarGeo, { pos: [x, y - 0.01, z], rot: [0, Math.PI / 2 - a, 0] }));
        gold.push(part(dropGeo, { pos: [x * 0.995, y - 0.12, z * 0.995], rot: [Math.PI, 0, 0] }));
        pearls.push(part(pearlGeo, { pos: [x, y - 0.01, z] }));
    }
    collarGeo.dispose();
    dropGeo.dispose();
    pearlGeo.dispose();
    group.add(partsToMesh(gold, goldMat));
    group.add(partsToMesh(pearls, pearlMat));
}

/**
 * Diamond quilting: helical seams in a darker shade of the tier (so they read
 * as pressed-in lines) crossing at pearl studs. `rows` diamonds stack up the
 * tier; seams and studs are each a single draw.
 */
function addPillowQuilting(group, { radius, yBottom, yTop, diamonds, rows, seamColor, pearlMat }) {
    const seamMat = new THREE.MeshPhysicalMaterial({ color: seamColor, roughness: 0.55, sheen: 0.4 });
    const height = yTop - yBottom;
    const turn = (Math.PI * 2) / diamonds;
    const seamR = radius + 0.004;

    const seams = [];
    for (const dir of [1, -1]) {
        for (let d = 0; d < diamonds; d++) {
            const pts = [];
            for (let k = 0; k <= 8 * rows; k++) {
                const t = k / (8 * rows);
                const a = d * turn + dir * t * turn * rows;
                pts.push(new THREE.Vector3(Math.cos(a) * seamR, yBottom + t * height, Math.sin(a) * seamR));
            }
            seams.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10 * rows, 0.0075, 5, false));
        }
    }
    group.add(partsToMesh(seams, seamMat));

    // Seams cross at t = j / (2·rows); odd levels sit half a diamond over
    const levels = rows * 2 + 1;
    const count = diamonds * levels;
    const studGeo = new THREE.SphereGeometry(0.027, 12, 10);
    group.add(instanceRing(studGeo, pearlMat, count, (dm, i) => {
        const j = Math.floor(i / diamonds);
        const d = i % diamonds;
        const a = d * turn + (j % 2 ? turn / 2 : 0);
        const r = radius + 0.014;
        dm.position.set(Math.cos(a) * r, yBottom + (j / (levels - 1)) * height, Math.sin(a) * r);
        dm.rotation.set(0, 0, 0);
        dm.scale.setScalar(1);
    }));
}

/**
 * Macaron-and-rose cascade down one side. Each piece is posed on a surface:
 *   flat  - lying on a ledge (centre half a thickness above it)
 *   stack - flat on top of the previous flat macaron
 *   lean  - stood on its rim and tipped back against the tier wall above
 *   wall  - a rose seated into a tier wall, facing out and slightly up
 */
function addCascade(group, { tiers, STAND_R, CASCADE_A, accent, creamTint, detail }) {
    const white = new THREE.Color(0xffffff);
    const macColors = [
        accent.clone().lerp(white, 0.35).getHex(),
        0xf3c1cb, // rose
        0xd3e4bd, // pistachio
        0xe4d4f0, // lavender
        0xf5e2bf // vanilla
    ];
    const roseColors = [
        new THREE.Color(creamTint).getHex(),
        new THREE.Color(0xf4c6cd).lerp(accent, 0.2).getHex(),
        accent.clone().lerp(new THREE.Color(0xd8466a), 0.45).getHex()
    ];

    const matCache = new Map();
    const matFor = (color, kind) => {
        const key = kind + color;
        if (!matCache.has(key)) {
            matCache.set(key, kind === 'mac'
                ? new THREE.MeshPhysicalMaterial({ color, roughness: 0.6, sheen: 0.5, sheenColor: white, clearcoat: 0.15 })
                : new THREE.MeshPhysicalMaterial({
                    color, roughness: 0.5, metalness: 0.02, sheen: 0.8,
                    sheenColor: white, clearcoat: 0.3, clearcoatRoughness: 0.4
                }));
        }
        return matCache.get(key);
    };

    // Ledges: the top of each lower tier between the upper tier's board and
    // the edge, plus the stand around the base tier.
    const ledges = [
        { y: tiers[1].yTop, rIn: tiers[2].r + 0.03, rOut: tiers[1].r, a: CASCADE_A },
        { y: tiers[0].yTop, rIn: tiers[1].r + 0.03, rOut: tiers[0].r, a: CASCADE_A + 0.28 },
        { y: tiers[0].yBottom, rIn: tiers[0].r + 0.04, rOut: STAND_R - 0.05, a: CASCADE_A + 0.5 },
        // A small echo under the bow, so the back of the cake is not bare
        { y: tiers[0].yTop, rIn: tiers[1].r + 0.03, rOut: tiers[0].r, a: CASCADE_A + Math.PI + 0.1 }
    ];

    // Arrangement per ledge. `da` is arc length (units) from the ledge's
    // cascade centre so clusters look equally dense on every radius.
    // `u` places the piece across the ledge: 0 = against the wall.
    const plans = [
        [
            { kind: 'rose', da: 0.0, u: 0.45, s: 0.95, c: 1 },
            { kind: 'mac', pose: 'lean', da: -0.26, s: 1.05, c: 0 },
            { kind: 'mac', pose: 'flat', da: 0.27, u: 0.2, s: 1.0, c: 2 },
            { kind: 'mac', pose: 'stack', da: 0.29, u: 0.2, s: 0.95, c: 1 },
            { kind: 'mac', pose: 'lean', da: 0.5, s: 1.0, c: 3 }
        ],
        [
            { kind: 'rose', da: -0.05, u: 0.5, s: 1.1, c: 0 },
            { kind: 'rose', da: 0.3, u: 0.35, s: 0.85, c: 2 },
            { kind: 'mac', pose: 'lean', da: -0.34, s: 1.1, c: 4 },
            { kind: 'mac', pose: 'flat', da: -0.6, u: 0.22, s: 1.05, c: 1 },
            { kind: 'mac', pose: 'stack', da: -0.58, u: 0.22, s: 1.0, c: 0 },
            { kind: 'mac', pose: 'lean', da: 0.6, s: 1.1, c: 2 },
            { kind: 'mac', pose: 'flat', da: 0.62, u: 0.85, s: 1.0, c: 3 }
        ],
        [
            { kind: 'mac', pose: 'lean', da: -0.2, s: 1.15, c: 1 },
            { kind: 'rose', da: 0.1, u: 0.4, s: 1.0, c: 1 },
            { kind: 'mac', pose: 'flat', da: 0.42, u: 0.3, s: 1.1, c: 0 },
            { kind: 'mac', pose: 'flat', da: 0.7, u: 0.35, s: 1.05, c: 3 }
        ],
        [
            { kind: 'rose', da: 0.0, u: 0.5, s: 1.1, c: 0 },
            { kind: 'mac', pose: 'lean', da: -0.3, s: 1.0, c: 2 },
            { kind: 'mac', pose: 'lean', da: 0.3, s: 1.0, c: 3 }
        ]
    ];

    // On phones, drop the secondary pieces (stacks and the last of each list)
    const lite = detail < 0.8;
    const MAC_K = 1.32;
    const ROSE_K = 1.25;
    const SPREAD_K = 1.3;
    const q = new THREE.Quaternion();
    const qSpin = new THREE.Quaternion();
    const Y = new THREE.Vector3(0, 1, 0);
    const axis = new THREE.Vector3();
    let lastFlat = null;

    plans.forEach((plan, li) => {
        const L = ledges[li];
        plan.forEach((p, pi) => {
            if (lite && (p.pose === 'stack' || pi === plan.length - 1)) return;

            // Plans are authored at unit size; the cascade is scaled up as a whole
            // so it reads at viewing distance, and spacing grows with it.
            const s = p.s * (p.kind === 'rose' ? ROSE_K : MAC_K);
            const R = MAC_R * s;
            const T = MAC_HALF_T * s;
            let r;
            let a;
            let obj;

            if (p.kind === 'rose') {
                const color = roseColors[p.c];
                obj = createRoseRosetteMesh(color, matFor(color, 'rose'));
                // Rose radius is ~0.2 at scale 1: keep it inside the ledge
                const rr = 0.19 * s;
                r = Math.min(L.rIn + rr * 0.8 + p.u * (L.rOut - L.rIn - rr * 1.6), L.rOut - rr * 0.6);
                a = L.a + (p.da * SPREAD_K) / r;
                // Tip the bloom outward a little so it faces the viewer
                axis.set(Math.sin(a), 0, -Math.cos(a));
                q.setFromAxisAngle(axis, 0.28);
                qSpin.setFromAxisAngle(Y, pi * 1.3);
                obj.quaternion.copy(q).multiply(qSpin);
                obj.scale.setScalar(s);
                obj.position.set(Math.cos(a) * r, L.y + 0.045 * s, Math.sin(a) * r);
                group.add(obj);
                return;
            }

            const color = macColors[p.c];
            obj = createMacaronMesh(color, matFor(color, 'mac'));
            obj.scale.setScalar(s);

            if (p.pose === 'lean') {
                // Rim on the ledge, top-back rim touching the wall behind
                const th = 1.1; // tilt of the macaron's axis from vertical
                r = L.rIn + R * Math.cos(th) + T * Math.sin(th) + 0.004;
                a = L.a + (p.da * SPREAD_K) / r;
                axis.set(Math.sin(a), 0, -Math.cos(a));
                q.setFromAxisAngle(axis, th);
                obj.quaternion.copy(q);
                obj.position.set(Math.cos(a) * r, L.y + R * Math.sin(th) + T * Math.cos(th) - 0.004, Math.sin(a) * r);
            } else if (p.pose === 'stack' && lastFlat) {
                // Nudged off-centre and tilted a touch, like a hand placed it
                r = lastFlat.r + 0.02;
                a = lastFlat.a + 0.015;
                axis.set(Math.sin(a), 0, -Math.cos(a));
                q.setFromAxisAngle(axis, 0.08);
                obj.quaternion.copy(q);
                obj.position.set(Math.cos(a) * r, lastFlat.top + T - 0.004, Math.sin(a) * r);
            } else {
                r = L.rIn + R + 0.01 + p.u * Math.max(0, L.rOut - L.rIn - 2 * R - 0.02);
                a = L.a + (p.da * SPREAD_K) / r;
                obj.position.set(Math.cos(a) * r, L.y + T - 0.003, Math.sin(a) * r);
                lastFlat = { r, a, top: L.y + 2 * T - 0.003 };
            }
            group.add(obj);
        });
    });

    // Wall roses link the ledge clusters into one falling line. Each is seated
    // with its base inside the wall so it reads as pressed into the cream.
    const wallRoses = [
        { tier: 2, t: 0.35, a: CASCADE_A + 0.12, s: 0.8, c: 1 },
        { tier: 1, t: 0.72, a: CASCADE_A + 0.02, s: 0.95, c: 0 },
        { tier: 1, t: 0.34, a: CASCADE_A + 0.16, s: 0.8, c: 2 },
        { tier: 0, t: 0.62, a: CASCADE_A + 0.34, s: 0.95, c: 1 },
        { tier: 0, t: 0.3, a: CASCADE_A + 0.47, s: 0.8, c: 0 }
    ];
    wallRoses.forEach((w, i) => {
        if (lite && i % 2 === 1) return;
        const tier = tiers[w.tier];
        const color = roseColors[w.c];
        const rose = createRoseRosetteMesh(color, matFor(color, 'rose'));
        // Local +Y (the bloom) turned to face outward, 20 degrees upward
        axis.set(Math.sin(w.a), 0, -Math.cos(w.a));
        q.setFromAxisAngle(axis, Math.PI / 2 - 0.35);
        qSpin.setFromAxisAngle(Y, i * 2.1);
        rose.quaternion.copy(q).multiply(qSpin);
        rose.scale.setScalar(w.s * ROSE_K);
        const r = tier.r + 0.035 * w.s * ROSE_K;
        const y = tier.yBottom + w.t * (tier.yTop - tier.yBottom);
        rose.position.set(Math.cos(w.a) * r, y, Math.sin(w.a) * r);
        group.add(rose);
    });

    // Gold leaf, sparingly: one torn patch of overlapping flakes on the top
    // tier above the cascade, where the eye already is. Scattered single
    // flakes read as debris; a patch reads as applied by hand. Baked into
    // one mesh with the first flake's material.
    const flakes = [
        { da: 0.0, t: 0.58, size: 0.17, roll: 0.3 },
        { da: 0.1, t: 0.5, size: 0.12, roll: 1.4 },
        { da: -0.09, t: 0.66, size: 0.1, roll: 2.3 },
        { da: 0.05, t: 0.72, size: 0.07, roll: 0.9 },
        { da: -0.13, t: 0.45, size: 0.06, roll: 1.9 }
    ];
    const top = tiers[2];
    const patchA = CASCADE_A - 0.42;
    let leafMat = null;
    const leafParts = flakes.map((fl, i) => {
        const leaf = createGoldLeafMesh(fl.size, i * 3.7 + 1);
        if (!leafMat) leafMat = leaf.material;
        else leaf.material.dispose();
        const a = patchA + fl.da / top.r;
        // Later flakes sit a hair further out so the overlaps never z-fight
        const r = top.r + 0.008 + i * 0.002;
        const g = part(leaf.geometry, {
            pos: [Math.cos(a) * r, top.yBottom + fl.t * (top.yTop - top.yBottom), Math.sin(a) * r],
            // Plane faces +Z: turn it to face outward, then roll it
            rot: [0, Math.PI / 2 - a, fl.roll]
        });
        leaf.geometry.dispose();
        return g;
    });
    const leafPatch = partsToMesh(leafParts, leafMat);
    leafPatch.castShadow = false;
    group.add(leafPatch);
}
