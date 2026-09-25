import * as THREE from 'three';
import {
    addDraperySwags,
    addGlazeDrips,
    addPearlBorderRing,
    addQuiltedLattice,
    addShellBorder,
    addStandDebris,
    createBeveledCylinder,
    createButtercreamMaterial,
    createGoldLeafMesh,
    createGoldMaterial,
    createMacaronMesh,
    createRoseRosetteMesh,
    scaleCount
} from '../parts.js';

/**
 * Grand Majestic 3-Tier.
 *
 * Reworked into a real wedding-cake silhouette: taller, narrower tiers with a
 * proper vertical rhythm, drapery swags on the base, diamond quilting on the
 * middle, and a rose-and-macaron cascade that is projected onto whichever tier
 * it passes — the old cascade used hardcoded coordinates and its lower half
 * hung ~0.3 units off the cake.
 */
export function buildTripleLuxury(group, ctx) {
    const { plateMat, glazeMat, crumbBumpTex, colorTier1, colorTier2, accentColor, creamTint, detail } = ctx;

    const goldMat = createGoldMaterial();

    // Gilded pedestal
    const standPlate = new THREE.Mesh(createBeveledCylinder(2.75, 0.12, 0.02), plateMat);
    standPlate.position.y = -0.72;
    standPlate.receiveShadow = true;
    standPlate.castShadow = true;
    group.add(standPlate);

    const standStem = new THREE.Mesh(createBeveledCylinder(0.55, 0.45, 0.03), plateMat);
    standStem.position.y = -0.99;
    group.add(standStem);

    const standBase = new THREE.Mesh(createBeveledCylinder(1.4, 0.08, 0.02), plateMat);
    standBase.position.y = -1.25;
    group.add(standBase);

    // Tiers. Each entry is the authority for anything that has to touch it.
    const tiers = [
        { r: 2.15, yBottom: -0.66, yTop: 0.34, color: colorTier1 },
        { r: 1.5, yBottom: 0.34, yTop: 1.19, color: colorTier2 },
        { r: 0.92, yBottom: 1.19, yTop: 1.82, color: colorTier1 }
    ];

    tiers.forEach((t, i) => {
        const h = t.yTop - t.yBottom;
        const mesh = new THREE.Mesh(
            createBeveledCylinder(t.r, h, 0.05),
            createButtercreamMaterial(t.color, crumbBumpTex, 0.13)
        );
        mesh.position.set(i === 1 ? 0.012 : -0.008, (t.yBottom + t.yTop) / 2, i === 1 ? -0.01 : 0.008);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
    });

    // Bottom tier: fondant drapery with gold tassels, plus a ruffle skirt
    addDraperySwags(group, {
        radius: tiers[0].r + 0.03,
        y: tiers[0].yTop - 0.16,
        count: scaleCount(9, detail, 6),
        sag: 0.34,
        color: creamTint,
        tasselMat: goldMat
    });
    addShellBorder(group, 52, tiers[0].r + 0.05, tiers[0].yBottom + 0.05, 3.3, creamTint, 1.3, detail);

    // Middle tier: diamond quilting with gold studs
    addQuiltedLattice(group, {
        radius: tiers[1].r + 0.015,
        yBottom: tiers[1].yBottom + 0.1,
        yTop: tiers[1].yTop - 0.1,
        diamonds: scaleCount(12, detail, 8),
        seamColor: creamTint,
        studMat: goldMat
    });

    // Gold pearl bands at every tier joint
    addPearlBorderRing(group, scaleCount(54, detail, 26), tiers[0].r + 0.03, tiers[0].yBottom + 0.02, goldMat, 0.042);
    addPearlBorderRing(group, scaleCount(40, detail, 20), tiers[1].r + 0.03, tiers[1].yBottom + 0.03, goldMat, 0.04);
    addPearlBorderRing(group, scaleCount(26, detail, 14), tiers[2].r + 0.03, tiers[2].yBottom + 0.03, goldMat, 0.038);

    // Crown: glaze cap and drips on the top two tiers
    const glazeTop = new THREE.Mesh(createBeveledCylinder(tiers[2].r + 0.02, 0.08, 0.02), glazeMat);
    glazeTop.position.y = tiers[2].yTop + 0.02;
    group.add(glazeTop);
    addGlazeDrips(group, glazeMat, 18, tiers[2].r + 0.01, tiers[2].yTop + 0.02, 7);
    addGlazeDrips(group, glazeMat, 24, tiers[1].r + 0.01, tiers[1].yTop - 0.01, 13);

    // --- Cascade -----------------------------------------------------------
    // Walk a spiral from the crown down to the plate; at each step, snap the
    // flower onto the radius of whichever tier that height belongs to. This is
    // what keeps the cascade in contact with the cake at every point.
    const radiusAt = (y) => {
        for (const t of tiers) {
            if (y >= t.yBottom && y <= t.yTop) return t.r;
        }
        return y > tiers[2].yTop ? tiers[2].r : tiers[0].r;
    };

    const blush = new THREE.Color(accentColor);
    const cascadeColors = [
        blush.getHex(),
        blush.clone().lerp(new THREE.Color(0xffffff), 0.45).getHex(),
        0xffd76a,
        blush.clone().lerp(new THREE.Color(0xff1155), 0.5).getHex()
    ];

    // Four colours across two shapes: eight materials, not one per flower.
    const matCache = new Map();
    const cascadeMat = (color, kind) => {
        const key = kind + color;
        if (!matCache.has(key)) {
            matCache.set(key, kind === 'mac'
                ? new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, sheen: 0.5, clearcoat: 0.2 })
                : new THREE.MeshPhysicalMaterial({
                    color, roughness: 0.5, metalness: 0.02, sheen: 0.7,
                    sheenColor: new THREE.Color(0xffffff),
                    clearcoat: 0.35, clearcoatRoughness: 0.4
                }));
        }
        return matCache.get(key);
    };

    const STEPS = scaleCount(22, detail, 12);
    for (let i = 0; i < STEPS; i++) {
        const t = i / (STEPS - 1);
        const y = tiers[2].yTop - 0.05 - t * (tiers[2].yTop - tiers[0].yBottom - 0.1);
        // Spiral just over a third of a turn, and let the cluster breathe
        // sideways so it reads as a garland rather than a stripe.
        const a = 2.35 + t * 2.2 + Math.sin(i * 1.9) * 0.16;
        const r = radiusAt(y) + 0.09;
        const wobble = Math.sin(i * 2.7) * 0.07;

        const color = cascadeColors[i % cascadeColors.length];
        const item = i % 3 === 1
            ? createMacaronMesh(color, cascadeMat(color, 'mac'))
            : createRoseRosetteMesh(color, cascadeMat(color, 'rose'));
        item.position.set(Math.cos(a) * r, y + wobble, Math.sin(a) * r);
        item.rotation.set(0.35 + Math.sin(i) * 0.25, -a, 0.2 + Math.cos(i * 1.4) * 0.3);
        item.scale.setScalar(i % 3 === 1 ? 1.25 : 1.35 + Math.sin(i * 3.1) * 0.2);
        group.add(item);

        // Gold leaf catches the light between the flowers
        if (i % 4 === 0) {
            const leaf = createGoldLeafMesh(0.13, i);
            leaf.position.set(Math.cos(a + 0.3) * (r - 0.03), y + 0.1, Math.sin(a + 0.3) * (r - 0.03));
            leaf.rotation.set(Math.sin(i) * 0.9, -a + 0.4, Math.cos(i) * 0.8);
            group.add(leaf);
        }
    }

    addStandDebris(group, -0.66, 2.75, creamTint, 2.28);
}
