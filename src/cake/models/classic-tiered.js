import * as THREE from 'three';
import {
    addGlazeDrips,
    addPearlBorderRing,
    addPipingRing,
    addStandDebris,
    createBeveledCylinder,
    createButtercreamMaterial,
    createSatinBowMesh,
    scaleCount
} from '../parts.js';

/**
 * Classic Royal 2-Tier — the default, kept familiar and only refined:
 * a satin ribbon band at the base and a pearl string at the tier joint.
 */
export function buildClassicTiered(group, ctx) {
    const { plateMat, glazeMat, crumbBumpTex, colorTier1, colorTier2, accentColor, creamTint, detail } = ctx;

    const standPlate = new THREE.Mesh(createBeveledCylinder(2.6, 0.12, 0.02), plateMat);
    standPlate.position.y = -0.55;
    standPlate.receiveShadow = true;
    standPlate.castShadow = true;
    group.add(standPlate);

    const standStem = new THREE.Mesh(createBeveledCylinder(0.5, 0.5, 0.03), plateMat);
    standStem.position.y = -0.85;
    standStem.receiveShadow = true;
    standStem.castShadow = true;
    group.add(standStem);

    const standBase = new THREE.Mesh(createBeveledCylinder(1.3, 0.08, 0.02), plateMat);
    standBase.position.y = -1.1;
    standBase.receiveShadow = true;
    standBase.castShadow = true;
    group.add(standBase);

    const tier1 = new THREE.Mesh(
        createBeveledCylinder(2.0, 1.0, 0.08),
        createButtercreamMaterial(colorTier1, crumbBumpTex, 0.16)
    );
    tier1.position.y = 0.0;
    tier1.castShadow = true;
    tier1.receiveShadow = true;
    group.add(tier1);

    const tier2 = new THREE.Mesh(
        createBeveledCylinder(1.4, 0.8, 0.06),
        createButtercreamMaterial(colorTier2, crumbBumpTex, 0.16)
    );
    tier2.position.set(0.018, 0.9, -0.012);
    tier2.rotation.z = 0.008;
    tier2.rotation.x = -0.005;
    tier2.castShadow = true;
    tier2.receiveShadow = true;
    group.add(tier2);

    // Satin ribbon around the base tier — the one finishing touch a plain
    // two-tier cake is always missing.
    const ribbon = new THREE.Mesh(
        new THREE.CylinderGeometry(2.025, 2.025, 0.19, 72, 1, true),
        new THREE.MeshPhysicalMaterial({
            color: accentColor,
            roughness: 0.3,
            metalness: 0.0,
            sheen: 1.0,
            sheenRoughness: 0.25,
            sheenColor: new THREE.Color(0xffffff),
            clearcoat: 0.5,
            side: THREE.DoubleSide
        })
    );
    ribbon.position.y = -0.26;
    ribbon.castShadow = true;
    group.add(ribbon);

    const ribbonBow = createSatinBowMesh(accentColor, 1.15);
    ribbonBow.position.set(0, -0.26, 2.07);
    group.add(ribbonBow);

    addPipingRing(group, 36, 2.02, -0.46, 11, creamTint, detail);
    addPipingRing(group, 28, 1.42, 0.52, 47, creamTint, detail);

    // Pearl string tucked into the tier joint
    addPearlBorderRing(group, scaleCount(34, detail, 18), 1.44, 0.53, new THREE.MeshPhysicalMaterial({
        color: 0xfff6f8,
        roughness: 0.1,
        metalness: 0.2,
        clearcoat: 1.0,
        iridescence: 0.55
    }), 0.03);

    const glazeTop = new THREE.Mesh(createBeveledCylinder(1.44, 0.12, 0.03), glazeMat);
    glazeTop.position.y = 1.3;
    glazeTop.castShadow = true;
    glazeTop.receiveShadow = true;
    group.add(glazeTop);

    addGlazeDrips(group, glazeMat, 24, 1.425, 1.3, 5);
    addStandDebris(group, -0.49, 2.6, creamTint);
}
