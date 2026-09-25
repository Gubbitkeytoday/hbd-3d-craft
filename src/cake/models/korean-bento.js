import * as THREE from 'three';
import {
    addShellBorder,
    createBearFaceMesh,
    createBeveledCylinder,
    createButtercreamMaterial,
    createButtercreamPipingMaterial,
    createSatinBowMesh,
    createSugarHeartMesh,
    instanceRing,
    roundedRectShape,
    scaleCount
} from '../parts.js';

/**
 * Korean Pastel Bento ("lunchbox cake").
 *
 * What makes one read as a bento cake rather than "a small cake": it is short
 * and wide (about 2.5:1), scraped to a crisp edge in one soft pastel, trimmed
 * with a delicate shell border and retro string-work, and it sits snugly in a
 * kraft takeout clamshell barely bigger than itself. The previous version was
 * a tall cylinder in an oversized white tray, which read as neither.
 *
 * The clamshell lid is deliberately left off: the cake auto-rotates, so an
 * opened lid would sweep in front of it half the time, and a full-size lid
 * folded back flat doubles the footprint past the camera frame. The front
 * locking tab, rolled rim and kraft stock carry the "takeout box" read instead.
 */

// Vertical stack, bottom up. The top surface (CAKE_TOP + cap) is what
// CAKE_LAYOUTS['korean-bento'] keys candles, fruit and topper off.
const BOX_FLOOR_Y = -0.61;          // top of the box floor
const BOARD_H = 0.04;               // gold/ceramic cake board (plate style)
const CAKE_H = 0.98;
const CAKE_R = 1.45;
const CAKE_BOTTOM = BOX_FLOOR_Y + BOARD_H;
const CAKE_TOP = CAKE_BOTTOM + CAKE_H; // 0.41

const BOX = 3.4;                   // box floor width, a snug fit round the board
const BOX_CORNER = 0.42;
const WALL_H = 0.4;
const WALL_FLARE = 0.07;            // takeout trays widen toward the rim

export function buildKoreanBento(group, ctx) {
    const { plateMat, glazeMat, crumbBumpTex, colorTier1, accentColor, creamTint, detail } = ctx;

    // "Pastel" is the model's identity, so the body colour is re-keyed into
    // the pastel band instead of used raw: same hue, lightness lifted, chroma
    // capped. A near-neutral tier (midnight-gold's obsidian) has no hue to
    // keep, so it borrows the theme accent's, giving champagne rather than a
    // dead grey drum.
    const bodyColor = toPastel(colorTier1, accentColor);
    const pastelAccent = new THREE.Color(accentColor).lerp(new THREE.Color(0xffffff), 0.35).getHex();

    buildKraftBox(group, crumbBumpTex, pastelAccent, accentColor, detail);

    // --- Cake board --------------------------------------------------------
    // The thin round every bakery cake sits on; it also gives the plate-style
    // choice something visible to do on this model.
    const board = new THREE.Mesh(createBeveledCylinder(CAKE_R + 0.11, BOARD_H, 0.012), plateMat);
    board.position.y = BOX_FLOOR_Y + BOARD_H / 2;
    board.receiveShadow = true;
    board.castShadow = true;
    group.add(board);

    // --- Cake --------------------------------------------------------------
    // Scraped to a near-90° edge, so the bevel is tiny; low bump so the side
    // reads smooth buttercream rather than crumb coat.
    const cake = new THREE.Mesh(
        createBeveledCylinder(CAKE_R, CAKE_H, 0.03),
        createButtercreamMaterial(bodyColor, crumbBumpTex, 0.05)
    );
    cake.position.y = CAKE_BOTTOM + CAKE_H / 2;
    cake.castShadow = true;
    cake.receiveShadow = true;
    group.add(cake);

    // Glaze flood inside the border: flat, so toppings and candles sit level.
    const cap = new THREE.Mesh(createBeveledCylinder(CAKE_R - 0.08, 0.035, 0.012), glazeMat);
    cap.position.y = CAKE_TOP + 0.005;
    cap.receiveShadow = true;
    group.add(cap);

    // --- Piping ------------------------------------------------------------
    // Fine shells along both rims: small and tightly spaced is what makes the
    // border look delicate instead of like the chunky wedding-cake version.
    addShellBorder(group, 50, CAKE_R - 0.04, CAKE_TOP + 0.03, 4.1, creamTint, 0.78, detail);
    addShellBorder(group, 50, CAKE_R + 0.02, CAKE_BOTTOM + 0.05, 9.3, creamTint, 0.85, detail);

    const pipingMat = createButtercreamPipingMaterial(creamTint);
    addStringWork(group, pipingMat, pastelAccent, detail);

    // Inner dot ring in the accent: the "double border" common on the tops.
    const dotCount = scaleCount(40, detail, 20);
    const dotR = CAKE_R - 0.26;
    group.add(instanceRing(
        new THREE.SphereGeometry(0.03, 10, 8),
        createButtercreamPipingMaterial(pastelAccent),
        dotCount,
        (d, i) => {
            const a = (i / dotCount) * Math.PI * 2;
            d.position.set(Math.cos(a) * dotR, CAKE_TOP + 0.03, Math.sin(a) * dotR);
            d.rotation.set(0, 0, 0);
            d.scale.set(1, 0.7, 1);
        }
    ));

    // --- Cute motif --------------------------------------------------------
    // The piped bear lives on the front face, not on top: the top is shared
    // with the user's fruit, sprinkles, candles and topper and stays clear.
    const bear = createBearFaceMesh(
        new THREE.Color(accentColor).lerp(new THREE.Color(0xffffff), 0.55).getHex(),
        new THREE.Color(accentColor).multiplyScalar(0.4).getHex()
    );
    // Face built lying on +y with ears toward -z; tip it onto the side wall.
    // It faces the front-left diagonal so the box's front tab never hides it.
    const BEAR_A = Math.PI * 0.75;
    bear.rotation.set(Math.PI / 2, Math.PI / 2 - BEAR_A, 0, 'YXZ');
    bear.position.set(Math.cos(BEAR_A) * (CAKE_R + 0.03), CAKE_BOTTOM + 0.36, Math.sin(BEAR_A) * (CAKE_R + 0.03));
    bear.scale.setScalar(1.3);
    group.add(bear);

    // Two tiny hearts flanking the bear, pressed into the side
    [-1, 1].forEach((dir) => {
        const h = createSugarHeartMesh(pastelAccent, 0.05);
        const a = BEAR_A - dir * 0.3;
        h.position.set(Math.cos(a) * (CAKE_R + 0.015), CAKE_BOTTOM + 0.33, Math.sin(a) * (CAKE_R + 0.015));
        // Heart is built facing +y; tip it to face +z, then swing it radial.
        h.rotation.set(Math.PI / 2, Math.PI / 2 - a, 0, 'YXZ');
        group.add(h);
    });
}

// HSL is read and written in sRGB on purpose: three's default is the linear
// working space, where "lightness 0.78" comes out nearly white on screen.
function toPastel(base, fallbackHue) {
    const SRGB = THREE.SRGBColorSpace;
    const hsl = new THREE.Color(base).getHSL({}, SRGB);
    if (hsl.s < 0.18 || hsl.l < 0.06) {
        const acc = new THREE.Color(fallbackHue).getHSL({}, SRGB);
        hsl.h = acc.h;
        hsl.s = acc.s * 0.55;
    }
    return new THREE.Color().setHSL(
        hsl.h,
        Math.min(hsl.s, 0.6),
        THREE.MathUtils.clamp(hsl.l + 0.3, 0.74, 0.82),
        SRGB
    );
}

/**
 * Retro Korean string-work: a single piped line draped in scallops just under
 * the top border, with a bead at each cusp and a drop at each scallop's low
 * point. One tube + two instanced rings, whatever the scallop count.
 */
function addStringWork(group, pipingMat, beadColor, detail) {
    const SCALLOPS = 12;
    const r = CAKE_R + 0.008;
    const yTop = CAKE_TOP - 0.1;
    const sag = 0.17;

    const pts = [];
    const n = 240;
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // |sin| gives pointed cusps at the top and round bellies below —
        // exactly how a draped piped line hangs between two anchor points.
        const y = yTop - sag * Math.abs(Math.sin(a * SCALLOPS / 2));
        pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, scaleCount(360, detail, 180), 0.017, 6, true),
        pipingMat
    );
    tube.castShadow = true;
    group.add(tube);

    // Beads at the anchor cusps
    group.add(instanceRing(
        new THREE.SphereGeometry(0.038, 12, 10),
        pipingMat,
        SCALLOPS,
        (d, i) => {
            const a = (i / SCALLOPS) * Math.PI * 2;
            d.position.set(Math.cos(a) * (r + 0.01), yTop, Math.sin(a) * (r + 0.01));
            d.rotation.set(0, 0, 0);
            d.scale.setScalar(1);
        }
    ));

    // Accent drops hanging from each belly
    group.add(instanceRing(
        new THREE.SphereGeometry(0.028, 10, 8),
        createButtercreamPipingMaterial(beadColor),
        SCALLOPS,
        (d, i) => {
            const a = ((i + 0.5) / SCALLOPS) * Math.PI * 2;
            d.position.set(Math.cos(a) * (r + 0.012), yTop - sag - 0.05, Math.sin(a) * (r + 0.012));
            d.rotation.set(0, 0, 0);
            d.scale.set(1, 1.25, 1);
        }
    ));
}

/**
 * Kraft-paper takeout tray: flared walls, a rolled rim, the clamshell's front
 * locking tab with a little satin bow, a round sticker, and a wooden fork
 * tucked into one of the free corners.
 */
function buildKraftBox(group, bumpTex, stickerColor, bowColor, detail) {
    const kraft = new THREE.MeshStandardMaterial({
        color: 0xc49a6c,
        roughness: 0.88,
        metalness: 0.0,
        bumpMap: bumpTex,
        bumpScale: 0.02,
        side: THREE.DoubleSide
    });

    // Floor
    const floorGeo = new THREE.ExtrudeGeometry(roundedRectShape(BOX, BOX, BOX_CORNER), {
        depth: 0.05, bevelEnabled: false, curveSegments: 10
    });
    floorGeo.center();
    floorGeo.rotateX(Math.PI / 2);
    const floor = new THREE.Mesh(floorGeo, kraft);
    floor.position.y = BOX_FLOOR_Y - 0.025;
    floor.receiveShadow = true;
    floor.castShadow = true;
    group.add(floor);

    // Walls: a thin extruded ring, then flared by pushing the upper vertices
    // outward so the tray has the tapered pressed-paper silhouette.
    const T = 0.045;
    const ring = roundedRectShape(BOX, BOX, BOX_CORNER);
    ring.holes.push(roundedRectShape(BOX - T * 2, BOX - T * 2, BOX_CORNER - T, THREE.Path));
    const wallGeo = new THREE.ExtrudeGeometry(ring, { depth: WALL_H, bevelEnabled: false, curveSegments: 10 });
    wallGeo.center();
    wallGeo.rotateX(Math.PI / 2);
    const wp = wallGeo.attributes.position;
    for (let i = 0; i < wp.count; i++) {
        const t = (wp.getY(i) + WALL_H / 2) / WALL_H;
        const s = 1 + WALL_FLARE * t;
        wp.setXYZ(i, wp.getX(i) * s, wp.getY(i), wp.getZ(i) * s);
    }
    wallGeo.computeVertexNormals();
    const walls = new THREE.Mesh(wallGeo, kraft);
    walls.position.y = BOX_FLOOR_Y + WALL_H / 2;
    walls.castShadow = true;
    walls.receiveShadow = true;
    group.add(walls);

    // Rolled rim along the top edge
    const rimY = BOX_FLOOR_Y + WALL_H;
    const rimSize = (BOX - T) * (1 + WALL_FLARE);
    const rimPts = roundedRectShape(rimSize, rimSize, BOX_CORNER * (1 + WALL_FLARE))
        .getSpacedPoints(scaleCount(160, detail, 80))
        .map((p) => new THREE.Vector3(p.x, rimY, p.y));
    rimPts.pop(); // closed curve: drop the duplicate end point
    const rim = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPts, true, 'catmullrom', 0.1), rimPts.length * 2, 0.03, 6, true),
        kraft
    );
    rim.castShadow = true;
    group.add(rim);

    // Front locking tab: the tongue that normally slots into the lid.
    const frontZ = (BOX / 2) * (1 + WALL_FLARE);
    const tabShape = roundedRectShape(0.62, 0.36, 0.14);
    const tabGeo = new THREE.ExtrudeGeometry(tabShape, {
        depth: 0.025, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2, curveSegments: 8
    });
    tabGeo.center();
    const tab = new THREE.Mesh(tabGeo, kraft);
    tab.position.set(0, rimY + 0.1, frontZ + 0.01);
    tab.rotation.x = -0.12;
    tab.castShadow = true;
    group.add(tab);

    const bow = createSatinBowMesh(bowColor, 0.62);
    bow.position.set(0, rimY + 0.14, frontZ + 0.05);
    group.add(bow);

    // Round sticker seal on the front wall
    const sticker = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.17, 0.008, 32),
        new THREE.MeshStandardMaterial({ color: stickerColor, roughness: 0.45 })
    );
    sticker.rotation.x = Math.PI / 2 - WALL_FLARE * 0.9;
    sticker.position.set(0.95, BOX_FLOOR_Y + WALL_H * 0.5, (BOX / 2) * (1 + WALL_FLARE * 0.5) + 0.012);
    group.add(sticker);
    const stickerHeart = createSugarHeartMesh(0xffffff, 0.07);
    stickerHeart.rotation.x = Math.PI / 2 - WALL_FLARE * 0.9;
    stickerHeart.position.set(0.95, sticker.position.y, sticker.position.z + 0.02);
    group.add(stickerHeart);

    // Wooden fork in the front-right corner, tines on the floor and handle
    // propped on the rim: lying flat it hid entirely behind the wall.
    const fork = createWoodenForkMesh();
    const d = 1.95;
    fork.position.set(d / Math.SQRT2, BOX_FLOOR_Y + 0.19, d / Math.SQRT2);
    // local +x (tines) points in toward the cake; negative z-tilt lifts the handle
    fork.rotation.set(0, Math.PI * 0.75, -0.52);
    group.add(fork);
}

/** Flat disposable wooden fork: one extruded outline with three tines. */
function createWoodenForkMesh() {
    const s = new THREE.Shape();
    const L = 0.36; // half length
    s.moveTo(-L, -0.035);
    s.lineTo(0.08, -0.03);
    s.quadraticCurveTo(0.14, -0.075, 0.2, -0.075);
    // three tines, drawn as two notches along the fork head
    s.lineTo(L, -0.075);
    s.lineTo(L, -0.045);
    s.lineTo(0.24, -0.03);
    s.lineTo(L, -0.015);
    s.lineTo(L, 0.015);
    s.lineTo(0.24, 0.03);
    s.lineTo(L, 0.045);
    s.lineTo(L, 0.075);
    s.lineTo(0.2, 0.075);
    s.quadraticCurveTo(0.14, 0.075, 0.08, 0.03);
    s.lineTo(-L, 0.035);
    s.quadraticCurveTo(-L - 0.04, 0, -L, -0.035);

    const geo = new THREE.ExtrudeGeometry(s, {
        depth: 0.014, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 1, curveSegments: 6
    });
    geo.center();
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe8cf9f, roughness: 0.7 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}
