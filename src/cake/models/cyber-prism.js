import * as THREE from 'three';
import {
    addHexNeonFrame,
    createCrystalShardMaterials,
    createCrystalShardMesh,
    createHexGridEmissiveTexture,
    createHexPrismGeometry,
    createHolographicScannerTexture,
    createNeonMaterial,
    part
} from '../parts.js';

/**
 * Neo-Prism Crystal.
 *
 * Previously two chrome hexagons — metalness 0.85 on a diffuse colour reads as
 * a machined nut, not a dessert. Now the mass stays translucent and faceted
 * while the *light* does the work: unlit neon edge frames, an emissive hex-grid
 * inlay, an energy core up the axis, a floor glow ring, and shards orbiting on
 * two levels. Unlit MeshBasicMaterial is deliberate — it's the only thing that
 * survives ACES tone mapping bright enough for the bloom pass.
 */
export function buildCyberPrism(group, ctx) {
    const { plateMat, glazeMat, colorTier1, colorTier2, accentColor } = ctx;

    const neonHex = new THREE.Color(accentColor);
    // Push the accent to full saturation and brightness; a muted theme colour
    // makes for very sad neon.
    const hsl = { h: 0, s: 0, l: 0 };
    neonHex.getHSL(hsl);
    neonHex.setHSL(hsl.h, Math.max(0.85, hsl.s), 0.6);
    const neonColor = neonHex.getHex();
    const gridTex = createHexGridEmissiveTexture(`#${neonHex.getHexString()}`);
    // One unlit material for every glowing part, one set for every shard.
    const pylonMat = createNeonMaterial(neonColor, 0.75);
    const capMat = createNeonMaterial(neonColor);
    const shardMats = createCrystalShardMaterials(neonColor);

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

    // Floor glow: a flat neon ring on the plate, the source of the up-light
    const glowRing = new THREE.Mesh(
        new THREE.RingGeometry(2.15, 2.42, 64),
        new THREE.MeshBasicMaterial({
            color: neonColor,
            toneMapped: false,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
            depthWrite: false
        })
    );
    glowRing.rotation.x = -Math.PI / 2;
    glowRing.position.y = -0.5;
    // Purely decorative overlays: opt them out of picking so they can never sit
    // between the pointer and a strawberry the viewer wants to be clickable.
    glowRing.raycast = () => {};
    group.add(glowRing);

    const prismMaterial = (color) => new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.14,
        metalness: 0.2,
        transmission: 0.42,
        thickness: 0.9,
        ior: 1.62,
        iridescence: 0.85,
        iridescenceIOR: 1.75,
        iridescenceThicknessRange: [160, 520],
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        emissive: neonHex.clone().multiplyScalar(0.12),
        emissiveMap: gridTex,
        emissiveIntensity: 1.6,
        transparent: true
    });

    const T1 = { r: 2.1, h: 0.95, y: -0.05, rot: 0 };
    const T2 = { r: 1.42, h: 0.8, y: 0.82, rot: Math.PI / 6 };

    const hexTier1 = new THREE.Mesh(createHexPrismGeometry(T1.r, T1.h, 0.05), prismMaterial(colorTier1));
    hexTier1.position.y = T1.y;
    hexTier1.rotation.y = T1.rot;
    hexTier1.castShadow = true;
    group.add(hexTier1);

    const hexTier2 = new THREE.Mesh(createHexPrismGeometry(T2.r, T2.h, 0.04), prismMaterial(colorTier2));
    hexTier2.position.y = T2.y;
    hexTier2.rotation.y = T2.rot;
    hexTier2.castShadow = true;
    group.add(hexTier2);

    // Neon edge frames — the shape-defining element
    addHexNeonFrame(group, { radius: T1.r, height: T1.h, centerY: T1.y, rotationY: T1.rot, colorHex: neonColor, thickness: 0.022 });
    addHexNeonFrame(group, { radius: T2.r, height: T2.h, centerY: T2.y, rotationY: T2.rot, colorHex: neonColor, thickness: 0.019 });

    // Glaze cap on top
    const hexGlaze = new THREE.Mesh(createHexPrismGeometry(1.44, 0.08, 0.02), glazeMat);
    hexGlaze.position.y = 1.2;
    hexGlaze.rotation.y = T2.rot;
    group.add(hexGlaze);

    // Holographic scan disc hovering over the top face
    const scanTex = createHolographicScannerTexture(`#${neonHex.getHexString()}`);
    const scanDisc = new THREE.Mesh(
        new THREE.PlaneGeometry(2.7, 2.7),
        new THREE.MeshBasicMaterial({
            map: scanTex,
            transparent: true,
            toneMapped: false,
            opacity: 0.7,
            depthWrite: false,
            side: THREE.DoubleSide
        })
    );
    scanDisc.rotation.x = -Math.PI / 2;
    scanDisc.position.y = 1.27;
    scanDisc.name = 'prism-scan-disc';
    scanDisc.raycast = () => {};
    group.add(scanDisc);

    // Energy core running up the axis, visible through the translucent tiers
    const core = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.11, 2.0, 12),
        createNeonMaterial(neonColor, 0.85)
    );
    core.position.y = 0.28;
    group.add(core);

    const coreHalo = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.28, 2.0, 16, 1, true),
        new THREE.MeshBasicMaterial({
            color: neonColor,
            toneMapped: false,
            transparent: true,
            opacity: 0.16,
            side: THREE.DoubleSide,
            depthWrite: false
        })
    );
    coreHalo.position.y = 0.28;
    coreHalo.raycast = () => {};
    group.add(coreHalo);

    // Data pylons standing at the lower hexagon's corners
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + T1.rot;
        const pylon = new THREE.Mesh(
            new THREE.CylinderGeometry(0.028, 0.045, 0.62, 6),
            pylonMat
        );
        pylon.position.set(Math.cos(a) * (T1.r + 0.16), -0.19, Math.sin(a) * (T1.r + 0.16));
        group.add(pylon);

        const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), capMat);
        cap.position.set(Math.cos(a) * (T1.r + 0.16), 0.16, Math.sin(a) * (T1.r + 0.16));
        cap.rotation.y = a;
        group.add(cap);
    }

    // Shards orbit on two levels at different scales, so the silhouette has
    // depth instead of one flat ring.
    for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const shard = createCrystalShardMesh(neonColor, shardMats);
        shard.position.set(Math.cos(a) * 2.45, 0.32 + Math.sin(i * 1.5) * 0.22, Math.sin(a) * 2.45);
        shard.rotation.set(0.3, a, 0.4);
        shard.scale.setScalar(1.0 + Math.sin(i * 2.1) * 0.22);
        group.add(shard);
    }
    for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.6;
        const shard = createCrystalShardMesh(neonColor, shardMats);
        shard.position.set(Math.cos(a) * 1.75, 1.45 + Math.cos(i * 1.7) * 0.2, Math.sin(a) * 1.75);
        shard.rotation.set(-0.35, a, -0.3);
        shard.scale.setScalar(0.68);
        group.add(shard);
    }
}
