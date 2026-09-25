import * as THREE from 'three';
import {
    addStandDebris,
    createBeveledCylinder,
    createButtercreamPipingMaterial,
    createPipedShellMesh,
    createSatinBowMesh,
    instanceRing,
    makeRng,
    part,
    partsToMesh,
    scaleCount
} from '../parts.js';

/**
 * Classic Royal 2-Tier — the default everyone sees first, so it has to read
 * as a bakery-window cake: soft hand-smoothed buttercream with a crown lip,
 * a poured glaze cap with uneven drips, star-tip swirls instead of cones,
 * shell borders, and a satin ribbon with a bow.
 *
 * Every repeated decoration is baked into one mesh (partsToMesh) or one
 * instanced draw, so the whole cake costs roughly a dozen draw calls.
 */

const TIER1 = { radius: 2.0, height: 1.0, y: 0.0 };
const TIER2 = { radius: 1.4, height: 0.8, y: 0.9 };
const GLAZE_TOP = 1.362; // must stay in sync with CAKE_LAYOUTS['classic-tiered']

/* ------------------------------------------------------------------ *
 * Local geometry helpers
 * ------------------------------------------------------------------ */

/**
 * A buttercream tier as a lathe, not an extruded disc. The profile carries
 * what a spatula actually leaves: a raised "crown" lip where the side
 * frosting is dragged up past the top, a softly rounded shoulder, a slightly
 * dished centre and a faint foot at the base. Low-frequency angular noise
 * then breaks the perfect circle — a turned-on-a-lathe tier is the main
 * thing that made the old cake read as plastic.
 */
function createButtercreamTierGeometry(radius, height, seed, detail, lip = 0.02) {
    const top = height / 2;
    const bottom = -height / 2;
    const r = radius;

    const profile = new THREE.SplineCurve([
        new THREE.Vector2(0.0, top - 0.006),
        new THREE.Vector2(r * 0.55, top - 0.004),
        new THREE.Vector2(r - 0.11, top + lip * 0.1),
        new THREE.Vector2(r - 0.045, top + lip),
        new THREE.Vector2(r - 0.012, top + lip * 0.55),
        new THREE.Vector2(r + 0.002, top - 0.03),
        new THREE.Vector2(r + 0.004, top - 0.12),
        new THREE.Vector2(r + 0.006, 0.0),
        new THREE.Vector2(r + 0.004, bottom + 0.1),
        new THREE.Vector2(r + 0.008, bottom + 0.025),
        new THREE.Vector2(r - 0.01, bottom),
        new THREE.Vector2(0.0, bottom)
    ]).getPoints(detail < 1 ? 36 : 56).reverse(); // lathe winds bottom-to-top

    const segments = detail < 1 ? 72 : 128;
    const geo = new THREE.LatheGeometry(profile, segments);

    const rng = makeRng(seed);
    const waves = [2, 3, 5, 7].map((k) => ({ k, phase: rng() * Math.PI * 2, amp: 0.0045 / Math.sqrt(k) }));
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const radial = Math.hypot(x, z);
        if (radial < 1e-5) continue;

        // Fade the wobble in toward the rim so the flat top stays flat
        const rimT = THREE.MathUtils.smoothstep(radial, r * 0.7, r);
        const theta = Math.atan2(z, x);
        let n = 0;
        for (const w of waves) n += Math.sin(theta * w.k + w.phase + y * 3.1) * w.amp;
        // The lip itself undulates in height as the spatula lifts on and off
        const lipWave = Math.sin(theta * 9 + waves[0].phase) * 0.004 * THREE.MathUtils.smoothstep(y, top - 0.04, top + lip);

        const s = (radial + n * rimT) / radial;
        pos.setXYZ(i, x * s, y + lipWave, z * s);
    }
    geo.computeVertexNormals();
    fixLatheSeam(geo, profile.length, segments);
    return geo;
}

/**
 * computeVertexNormals() sees the lathe's duplicated seam column as two
 * separate edges and leaves a visible vertical line; average them back.
 */
function fixLatheSeam(geo, points, segments) {
    const nrm = geo.attributes.normal;
    const last = segments * points;
    for (let j = 0; j < points; j++) {
        const a = j;
        const b = last + j;
        const nx = nrm.getX(a) + nrm.getX(b);
        const ny = nrm.getY(a) + nrm.getY(b);
        const nz = nrm.getZ(a) + nrm.getZ(b);
        const len = Math.hypot(nx, ny, nz) || 1;
        nrm.setXYZ(a, nx / len, ny / len, nz / len);
        nrm.setXYZ(b, nx / len, ny / len, nz / len);
    }
    nrm.needsUpdate = true;
}

/**
 * Star-tip swirl ("drop-flower swirl"): a star-profiled tube wound inward
 * and upward, closing into a soft peak. The ridges twist slightly along the
 * sweep the way a turning piping bag twists them. This replaces the old
 * deformed-sphere cone, which read as a row of spikes from any distance.
 * Sits on y = 0, about 0.24 units across at scale 1.
 */
function createStarSwirlGeometry(detail) {
    const STEPS = detail < 1 ? 44 : 80;
    const RING = detail < 1 ? 18 : 24;
    const RIDGES = 6;
    const TURNS = 2.4;

    const positions = [];
    const P = (t) => {
        const theta = t * TURNS * Math.PI * 2;
        const R = 0.078 * Math.pow(1 - t, 0.9);
        // Stacked coils climb steeply at the end into a pulled-off peak
        const h = 0.034 + 0.1 * t + 0.07 * Math.pow(t, 3);
        return new THREE.Vector3(Math.cos(theta) * R, h, Math.sin(theta) * R);
    };
    const up = new THREE.Vector3(0, 1, 0);
    const T = new THREE.Vector3();
    const N = new THREE.Vector3();
    const B = new THREE.Vector3();

    for (let s = 0; s <= STEPS; s++) {
        const t = s / STEPS;
        const p = P(t);
        T.subVectors(P(Math.min(1, t + 0.002)), P(Math.max(0, t - 0.002))).normalize();
        N.crossVectors(T, up);
        if (N.lengthSq() < 1e-8) N.set(1, 0, 0);
        N.normalize();
        B.crossVectors(N, T).normalize();

        // Tail fades in over the first few percent; the tube thins to a peak
        const taper = THREE.MathUtils.smoothstep(t, 0.0, 0.07) * Math.pow(1 - t, 0.55);
        const tube = 0.04 * taper;
        for (let k = 0; k < RING; k++) {
            const phi = (k / RING) * Math.PI * 2;
            const rr = tube * (1 + 0.2 * Math.cos(phi * RIDGES + t * 2.2));
            positions.push(
                p.x + (N.x * Math.cos(phi) + B.x * Math.sin(phi)) * rr,
                p.y + (N.y * Math.cos(phi) + B.y * Math.sin(phi)) * rr,
                p.z + (N.z * Math.cos(phi) + B.z * Math.sin(phi)) * rr
            );
        }
    }

    const index = [];
    for (let s = 0; s < STEPS; s++) {
        for (let k = 0; k < RING; k++) {
            const a = s * RING + k;
            const b = s * RING + ((k + 1) % RING);
            const c = a + RING;
            const d = b + RING;
            index.push(a, c, b, b, c, d);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return geo;
}

/**
 * One glaze drip as a lathe: flared where it leaves the rim, a slightly
 * pinched neck, and a swollen bead at the tip where the glaze pooled.
 */
function createDripGeometry(length, width, radialSegments) {
    const bead = width * 1.22;
    const cy = -length + bead;
    const neckEnd = cy + bead * 0.73;
    const pts = [new THREE.Vector2(width * 1.5, 0.03), new THREE.Vector2(width * 1.15, 0.0)];
    const NECK = 6;
    for (let i = 1; i <= NECK; i++) {
        const u = i / NECK;
        const y = neckEnd * u;
        pts.push(new THREE.Vector2(width * (0.8 + 0.3 * (1 - u) * (1 - u)), y));
    }
    const ARC = 7;
    const a0 = Math.acos(0.8 / 1.22);
    for (let i = 1; i <= ARC; i++) {
        const a = a0 + (-Math.PI / 2 - a0) * (i / ARC);
        pts.push(new THREE.Vector2(Math.max(0, bead * Math.cos(a)), cy + bead * Math.sin(a)));
    }
    // Lathe winds outward when the profile runs bottom-to-top
    return new THREE.LatheGeometry(pts.reverse(), radialSegments);
}

/** Satin band with a rounded, slightly padded cross-section instead of a flat sheet. */
function createRibbonGeometry(radius, height, thickness) {
    const h = height / 2;
    const pts = [
        new THREE.Vector2(radius - 0.004, -h),
        new THREE.Vector2(radius + thickness * 0.7, -h + 0.004),
        new THREE.Vector2(radius + thickness, -h * 0.6),
        new THREE.Vector2(radius + thickness * 1.15, 0),
        new THREE.Vector2(radius + thickness, h * 0.6),
        new THREE.Vector2(radius + thickness * 0.7, h - 0.004),
        new THREE.Vector2(radius - 0.004, h)
    ];
    return new THREE.LatheGeometry(new THREE.SplineCurve(pts).getPoints(16), 128);
}

/**
 * Buttercream body. The kit's version uses a near-white sheen, which on a
 * dark theme colour lifts the whole tier to flat grey. Tinting the sheen
 * from the body colour keeps the soft velvet rim light but lets dark
 * frosting stay rich (ganache) and pale frosting stay creamy.
 */
function createFrostingMaterial(color, bumpTex) {
    const c = new THREE.Color(color);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    const dark = hsl.l < 0.25;
    return new THREE.MeshPhysicalMaterial({
        color: c,
        roughness: dark ? 0.42 : 0.56,
        metalness: 0.0,
        bumpMap: bumpTex,
        bumpScale: 0.14,
        sheen: dark ? 0.35 : 0.5,
        sheenRoughness: 0.5,
        sheenColor: c.clone().lerp(new THREE.Color(0xfff4e8), dark ? 0.25 : 0.5),
        clearcoat: dark ? 0.3 : 0.1,
        clearcoatRoughness: 0.45
    });
}

/* ------------------------------------------------------------------ *
 * Builder
 * ------------------------------------------------------------------ */

export function buildClassicTiered(group, ctx) {
    const { plateMat, glazeMat, crumbBumpTex, colorTier1, colorTier2, accentColor, creamTint, detail } = ctx;

    // --- Cake stand ------------------------------------------------------
    const standPlate = new THREE.Mesh(createBeveledCylinder(2.6, 0.12, 0.02), plateMat);
    standPlate.position.y = -0.55;
    const standStem = new THREE.Mesh(createBeveledCylinder(0.5, 0.5, 0.03), plateMat);
    standStem.position.y = -0.85;
    const standBase = new THREE.Mesh(createBeveledCylinder(1.3, 0.08, 0.02), plateMat);
    standBase.position.y = -1.1;
    for (const m of [standPlate, standStem, standBase]) {
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
    }

    // --- Tiers ------------------------------------------------------------
    const tier1 = new THREE.Mesh(
        createButtercreamTierGeometry(TIER1.radius, TIER1.height, 0x51a7e1, detail, 0.024),
        createFrostingMaterial(colorTier1, crumbBumpTex)
    );
    tier1.position.y = TIER1.y;

    const tier2 = new THREE.Mesh(
        // No lip: the top of this tier is hidden under the glaze cap
        createButtercreamTierGeometry(TIER2.radius, TIER2.height, 0x7e2b19, detail, 0.0),
        createFrostingMaterial(colorTier2, crumbBumpTex)
    );
    // A hair off-centre and off-level: stacked by hand, not by CNC
    tier2.position.set(0.012, TIER2.y, -0.008);
    tier2.rotation.set(-0.004, 0.3, 0.006);
    for (const m of [tier1, tier2]) {
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
    }

    // --- Glaze cap and drips on the top tier ------------------------------
    // The glaze is poured, so it domes slightly, rolls over the rim in a
    // rounded bead and only then breaks into drips.
    const t2Top = TIER2.y + TIER2.height / 2;
    const capProfile = new THREE.SplineCurve([
        new THREE.Vector2(0.0, GLAZE_TOP),
        new THREE.Vector2(1.1, GLAZE_TOP - 0.002),
        new THREE.Vector2(1.34, GLAZE_TOP - 0.008),
        new THREE.Vector2(1.405, t2Top + 0.04),
        new THREE.Vector2(1.43, t2Top + 0.0),
        new THREE.Vector2(1.422, t2Top - 0.035),
        new THREE.Vector2(1.401, t2Top - 0.05)
    ]).getPoints(28).reverse();
    const glazeCap = new THREE.Mesh(new THREE.LatheGeometry(capProfile, detail < 1 ? 72 : 112), glazeMat);
    glazeCap.castShadow = true;
    glazeCap.receiveShadow = true;
    group.add(glazeCap);

    // Drips: irregular spacing, a mix of short runs and a few long ones,
    // width tied to length (more glaze runs further). All baked into one mesh.
    const rng = makeRng(0xd41b5eed);
    const dripCount = scaleCount(30, detail, 18);
    const dripSegs = detail < 1 ? 8 : 12;
    const dripParts = [];
    let angle = rng() * Math.PI * 2;
    for (let i = 0; i < dripCount; i++) {
        angle += ((Math.PI * 2) / dripCount) * (0.55 + rng() * 0.9);
        const roll = rng();
        const length = roll < 0.25 ? 0.04 + rng() * 0.05 // barely broke over the edge
            : roll < 0.82 ? 0.1 + rng() * 0.1
                : 0.26 + rng() * 0.16; // the odd long run
        const width = 0.02 + length * 0.07 + rng() * 0.006;
        const geo = createDripGeometry(length, width, dripSegs);
        const rOut = TIER2.radius + width * 0.25;
        dripParts.push(part(geo, {
            pos: [Math.cos(angle) * rOut, t2Top - 0.02, Math.sin(angle) * rOut],
            rot: [0, Math.PI / 2 - angle, (rng() - 0.5) * 0.08],
            scale: [1, 1, 0.55] // flattened against the side, not free-hanging tubes
        }));
        geo.dispose();
    }
    group.add(partsToMesh(dripParts, glazeMat));

    // --- Piping -----------------------------------------------------------
    const pipingMat = createButtercreamPipingMaterial(creamTint);
    // The kit's piping sheen is pink-white; match it to the cream instead
    pipingMat.sheenColor = new THREE.Color(creamTint);
    pipingMat.roughness = 0.4;
    pipingMat.clearcoat = 0.35;
    pipingMat.clearcoatRoughness = 0.25;

    const swirlGeo = createStarSwirlGeometry(detail);

    // Crown of star swirls around the ledge of the bottom tier
    const ledgeY = TIER1.y + TIER1.height / 2;
    const ledgeCount = scaleCount(24, detail, 16);
    const ledgeR = 1.78;
    const swirlParts = [];
    for (let i = 0; i < ledgeCount; i++) {
        const a = (i / ledgeCount) * Math.PI * 2 + (rng() - 0.5) * 0.03;
        const r = ledgeR + (rng() - 0.5) * 0.02;
        const s = 1.45 + (rng() - 0.5) * 0.12;
        swirlParts.push(part(swirlGeo, {
            pos: [Math.cos(a) * r, ledgeY - 0.012, Math.sin(a) * r],
            rot: [(rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08],
            scale: [s, s * (0.92 + rng() * 0.16), s]
        }));
    }

    // Smaller swirls ringing the glazed top, just inside the rim
    const topCount = scaleCount(14, detail, 10);
    const topR = 1.27;
    for (let i = 0; i < topCount; i++) {
        const a = (i / topCount) * Math.PI * 2 + 0.17 + (rng() - 0.5) * 0.03;
        const s = 1.0 + (rng() - 0.5) * 0.08;
        swirlParts.push(part(swirlGeo, {
            pos: [Math.cos(a) * topR, GLAZE_TOP - 0.01, Math.sin(a) * topR],
            rot: [0, rng() * Math.PI * 2, 0],
            scale: [s, s * (0.92 + rng() * 0.16), s]
        }));
    }
    swirlGeo.dispose();
    group.add(partsToMesh(swirlParts, pipingMat));

    // Shell borders at both tier bases — the classic bakery finish that hides
    // where frosting meets board. Baked from the kit's shell into one mesh.
    const shellParts = [];
    const addShells = (count, radius, y, scale, seedBase) => {
        for (let i = 0; i < count; i++) {
            const seed = seedBase + i * 2.31;
            const shell = createPipedShellMesh(creamTint, seed, detail, pipingMat);
            const a = (i / count) * Math.PI * 2;
            const s = scale * (1 + Math.sin(seed * 3.7) * 0.06);
            shellParts.push(part(shell.geometry, {
                pos: [Math.cos(a) * radius, y + Math.sin(seed * 2.9) * 0.005, Math.sin(a) * radius],
                rot: [0, -a + Math.PI / 2, 0.14 + Math.sin(seed) * 0.05],
                scale: s
            }));
            shell.geometry.dispose();
        }
    };
    addShells(scaleCount(58, detail, 36), TIER1.radius + 0.035, TIER1.y - TIER1.height / 2 + 0.045, 1.45, 11);
    addShells(scaleCount(44, detail, 28), TIER2.radius + 0.03, TIER2.y - TIER2.height / 2 + 0.035, 1.1, 47);
    group.add(partsToMesh(shellParts, pipingMat));

    // Accent dragées tucked between the ledge swirls — the one small metallic
    // note that ties the cake to the theme accent (gold / cherry / ...).
    const drageeMat = new THREE.MeshPhysicalMaterial({
        color: accentColor,
        roughness: 0.18,
        metalness: 0.75,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08
    });
    group.add(instanceRing(new THREE.SphereGeometry(0.032, 14, 12), drageeMat, ledgeCount, (d, i) => {
        const a = ((i + 0.5) / ledgeCount) * Math.PI * 2;
        d.position.set(Math.cos(a) * (ledgeR + 0.1), ledgeY + 0.028, Math.sin(a) * (ledgeR + 0.1));
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(1);
    }));

    // --- Satin ribbon and bow ---------------------------------------------
    // Anisotropy stretches the highlight along the weave, which is what makes
    // satin read as satin rather than painted plastic.
    const ribbonY = -0.24;
    const ribbon = new THREE.Mesh(
        createRibbonGeometry(TIER1.radius + 0.012, 0.2, 0.012),
        new THREE.MeshPhysicalMaterial({
            color: accentColor,
            roughness: 0.32,
            metalness: 0.0,
            anisotropy: 0.8,
            anisotropyRotation: Math.PI / 2,
            sheen: 1.0,
            sheenRoughness: 0.3,
            sheenColor: new THREE.Color(accentColor).lerp(new THREE.Color(0xffffff), 0.5),
            clearcoat: 0.4,
            clearcoatRoughness: 0.2
        })
    );
    ribbon.position.y = ribbonY;
    ribbon.castShadow = true;
    ribbon.receiveShadow = true;
    group.add(ribbon);

    const ribbonBow = createSatinBowMesh(accentColor, 1.5);
    ribbonBow.position.set(0, ribbonY + 0.01, TIER1.radius + 0.06);
    group.add(ribbonBow);

    addStandDebris(group, -0.49, 2.6, creamTint);
}
