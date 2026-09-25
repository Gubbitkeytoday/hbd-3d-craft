import * as THREE from 'three';
import {
    addShellBorder,
    addStandDebris,
    createBearFaceMesh,
    createBeveledCylinder,
    createButtercreamMaterial,
    createButtercreamPipingMaterial,
    createDaisyFlowerMesh,
    createPipedCreamMesh,
    createSatinBowMesh,
    createSugarHeartMesh,
    roundedRectShape,
    scaleCount
} from '../parts.js';

/**
 * Korean Pastel Bento.
 *
 * The real thing is a single small cake sitting inside its takeout container:
 * knife-sharp edges, one pastel colour, a shell border top and bottom, and one
 * hand-piped cute motif. The old version was a plain wide cylinder on a disc.
 */
export function buildKoreanBento(group, ctx) {
    const { plateMat, glazeMat, crumbBumpTex, colorTier1, accentColor, creamTint, detail } = ctx;

    // --- Takeout container -------------------------------------------------
    const TRAY = 4.7;
    const trayFloorGeo = new THREE.ExtrudeGeometry(roundedRectShape(TRAY, TRAY, 0.55), {
        depth: 0.1,
        bevelEnabled: true,
        bevelSegments: 3,
        steps: 1,
        bevelSize: 0.03,
        bevelThickness: 0.03,
        curveSegments: 12
    });
    trayFloorGeo.center();
    trayFloorGeo.rotateX(Math.PI / 2);
    const trayFloor = new THREE.Mesh(trayFloorGeo, plateMat);
    trayFloor.position.y = -0.62;
    trayFloor.receiveShadow = true;
    trayFloor.castShadow = true;
    group.add(trayFloor);

    // Walls: an extruded ring (outer profile with the inner profile as a hole),
    // so the box is genuinely open rather than a solid block behind the cake.
    const wallOuter = roundedRectShape(TRAY, TRAY, 0.55);
    wallOuter.holes.push(roundedRectShape(TRAY - 0.16, TRAY - 0.16, 0.5, THREE.Path));
    const wallGeo = new THREE.ExtrudeGeometry(wallOuter, {
        depth: 0.62,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.015,
        bevelThickness: 0.015,
        curveSegments: 12
    });
    wallGeo.center();
    wallGeo.rotateX(Math.PI / 2);
    const walls = new THREE.Mesh(wallGeo, plateMat);
    walls.position.y = -0.26;
    walls.castShadow = true;
    walls.receiveShadow = true;
    group.add(walls);

    // --- Cake --------------------------------------------------------------
    // Bento cakes are scraped to a crisp 90° edge, so the bevel is tiny.
    const bentoMesh = new THREE.Mesh(
        createBeveledCylinder(1.85, 1.3, 0.035),
        createButtercreamMaterial(colorTier1, crumbBumpTex, 0.09)
    );
    bentoMesh.position.y = 0.12;
    bentoMesh.castShadow = true;
    bentoMesh.receiveShadow = true;
    group.add(bentoMesh);

    const bentoGlaze = new THREE.Mesh(createBeveledCylinder(1.8, 0.06, 0.015), glazeMat);
    bentoGlaze.position.y = 0.75;
    bentoGlaze.castShadow = true;
    group.add(bentoGlaze);

    // --- Piping ------------------------------------------------------------
    // Shell borders at the two rims — the actual bento signature. The previous
    // "scalloped wave" used sin(i * 4), which aliases into noise rather than a
    // wave; the scallop now follows the angle so the lobes are real.
    addShellBorder(group, 40, 1.86, 0.755, 4.1, creamTint, 1.2, detail);
    addShellBorder(group, 44, 1.86, -0.5, 9.3, creamTint, 1.25, detail);

    // Scalloped garland just under the top rim, 8 clean lobes
    const garlandCount = scaleCount(48, detail, 24);
    const garlandMat = createButtercreamPipingMaterial(creamTint);
    for (let i = 0; i < garlandCount; i++) {
        const a = (i / garlandCount) * Math.PI * 2;
        const piped = createPipedCreamMesh(creamTint, i * 1.31, detail, garlandMat);
        piped.position.set(
            Math.cos(a) * 1.87,
            0.5 + Math.sin(a * 8) * 0.075,
            Math.sin(a) * 1.87
        );
        piped.rotation.set(0.2, -a, 0);
        piped.scale.setScalar(0.85);
        group.add(piped);
    }

    // --- Cute motifs -------------------------------------------------------
    const bear = createBearFaceMesh(
        new THREE.Color(accentColor).lerp(new THREE.Color(0xffffff), 0.55).getHex(),
        new THREE.Color(accentColor).multiplyScalar(0.45).getHex()
    );
    bear.position.set(-0.72, 0.79, 0.62);
    bear.rotation.y = -0.35;
    group.add(bear);

    const bow = createSatinBowMesh(accentColor, 0.9);
    bow.position.set(0.85, 0.83, 0.5);
    bow.rotation.set(-Math.PI / 2 + 0.35, 0, -0.3);
    group.add(bow);

    // Piped hearts trailing between the motifs
    [
        { x: 0.1, z: 1.0, s: 0.085 },
        { x: 0.5, z: 1.15, s: 0.065 },
        { x: -0.25, z: 1.22, s: 0.055 }
    ].forEach((p, i) => {
        const h = createSugarHeartMesh(accentColor, p.s);
        h.position.set(p.x, 0.79, p.z);
        h.rotation.y = i * 0.9;
        group.add(h);
    });

    // Minimal sugar daisies, varied in size so the top doesn't read stamped
    const daisyMats = { petal: null, center: null };
    for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 2.1;
        const daisy = createDaisyFlowerMesh(0xfffdfa, accentColor, daisyMats);
        daisy.position.set(Math.cos(a) * 1.35, 0.79, Math.sin(a) * 1.35);
        daisy.rotation.y = a;
        daisy.scale.setScalar(0.85 + Math.sin(i * 2.7) * 0.25);
        group.add(daisy);
    }

    // Crumbs on the tray floor, inside the walls
    addStandDebris(group, -0.55, TRAY / 2 - 0.2, creamTint, 1.95);
}
