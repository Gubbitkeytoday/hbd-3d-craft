import * as THREE from 'three';
import {
    addHeartPearlRing,
    addHeartPipingRing,
    createBeveledCylinder,
    createButtercreamMaterial,
    createButtercreamPipingMaterial,
    createHeartCakeGeometry,
    createPipedCreamMesh,
    createSatinBowMesh,
    createSugarHeartMesh,
    heartPerimeterPoints,
    scaleCount
} from '../parts.js';

/**
 * Vintage Coquette Heart.
 *
 * Lambeth-revival heart: a double ruffle skirt, a lace lattice of sugar pearls
 * pressed into the sides, a pearl string following the top edge, rosettes
 * placed from the real perimeter, and a satin bow at the point.
 */
export function buildVintageHeart(group, ctx) {
    const { plateMat, glazeMat, crumbBumpTex, colorTier1, accentColor, creamTint, detail } = ctx;
    const SPONGE_SCALE = 1.22;

    // Pedestal
    const standPlate = new THREE.Mesh(createHeartCakeGeometry(1.38, 0.12, 0.02), plateMat);
    standPlate.position.y = -0.55;
    standPlate.receiveShadow = true;
    standPlate.castShadow = true;
    group.add(standPlate);

    const standStem = new THREE.Mesh(createBeveledCylinder(0.5, 0.5, 0.03), plateMat);
    standStem.position.y = -0.85;
    group.add(standStem);

    const standBase = new THREE.Mesh(createBeveledCylinder(1.3, 0.08, 0.02), plateMat);
    standBase.position.y = -1.1;
    group.add(standBase);

    // Sponge
    const heartSponge = new THREE.Mesh(
        createHeartCakeGeometry(SPONGE_SCALE, 1.35, 0.08),
        createButtercreamMaterial(colorTier1, crumbBumpTex, 0.14)
    );
    heartSponge.position.y = 0.15;
    heartSponge.castShadow = true;
    heartSponge.receiveShadow = true;
    group.add(heartSponge);

    // Glaze cap
    const heartGlaze = new THREE.Mesh(createHeartCakeGeometry(SPONGE_SCALE - 0.05, 0.09, 0.02), glazeMat);
    heartGlaze.position.y = 0.84;
    heartGlaze.castShadow = true;
    group.add(heartGlaze);

    // Double ruffle skirt. Both rings now derive from the sponge's own scale,
    // so they hug the cake instead of floating a quarter-unit outside it.
    addHeartPipingRing(group, SPONGE_SCALE, -0.44, 40, creamTint, 0.04, 1.5, detail);
    addHeartPipingRing(group, SPONGE_SCALE, -0.24, 36, creamTint, 0.02, 1.15, detail);
    addHeartPipingRing(group, SPONGE_SCALE, 0.82, 34, creamTint, 0.03, 1.25, detail);

    // Lambeth lace: three staggered rows of sugar pearls pressed into the side
    const pearlMat = new THREE.MeshPhysicalMaterial({
        color: 0xfff4f7,
        roughness: 0.12,
        metalness: 0.15,
        clearcoat: 1.0,
        iridescence: 0.6,
        iridescenceIOR: 1.4
    });
    [
        { y: 0.05, count: 34, outset: 0.02 },
        { y: 0.3, count: 30, outset: 0.02 },
        { y: 0.55, count: 26, outset: 0.02 }
    ].forEach((row, i) => {
        addHeartPearlRing(group, SPONGE_SCALE, row.y, scaleCount(row.count, detail, 14),
            pearlMat, 0.03 - i * 0.003, row.outset);
    });

    // Pearl string tracing the top edge
    addHeartPearlRing(group, SPONGE_SCALE - 0.09, 0.9, scaleCount(46, detail, 22), pearlMat, 0.032, 0);

    // Rosettes placed from the actual perimeter, inset so they always land on
    // the cake. The old hardcoded set put one past the point, floating in air.
    const rosetteSpots = heartPerimeterPoints(SPONGE_SCALE, 9, -0.26);
    const rosetteMats = [createButtercreamPipingMaterial(accentColor), createButtercreamPipingMaterial(creamTint)];
    rosetteSpots.forEach((pt, i) => {
        const rMesh = createPipedCreamMesh(0, i * 1.7, detail, rosetteMats[i % 2]);
        rMesh.position.set(pt.x, 0.9, pt.z);
        rMesh.rotation.y = pt.angle;
        const s = 1.7 + Math.sin(i * 2.3) * 0.25;
        rMesh.scale.set(s, s * 0.85, s);
        group.add(rMesh);
    });

    // Tiny sugar hearts sprinkled between the rosettes
    const innerSpots = heartPerimeterPoints(SPONGE_SCALE, 7, -0.62);
    innerSpots.forEach((pt, i) => {
        const h = createSugarHeartMesh(i % 2 ? accentColor : 0xffffff, 0.075);
        h.position.set(pt.x, 0.9, pt.z);
        h.rotation.y = pt.angle + 0.4;
        group.add(h);
    });

    // The bow: coquette's whole point. Sits at the heart's front point,
    // facing the camera's default +Z.
    const bow = createSatinBowMesh(accentColor, 1.25);
    const tip = heartPerimeterPoints(SPONGE_SCALE, 48, 0.06)
        .reduce((best, p) => (p.z > best.z ? p : best));
    bow.position.set(tip.x, 0.28, tip.z + 0.06);
    bow.rotation.set(-0.18, 0, 0);
    group.add(bow);
}
