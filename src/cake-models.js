/**
 * Shared 3D cake construction kit.
 *
 * The creator preview and the viewer used to carry byte-identical copies of
 * every geometry helper, decoration factory and model builder — ~820 lines
 * duplicated, plus a third copy of the candle-placement constants inside
 * setupViewerCandles(). Any fix had to be applied in three places or the
 * preview stopped matching the card the recipient actually opens.
 *
 * This module is the single source of truth: per-model layout metrics and the
 * model registry live here, the parts kit in ./cake/parts.js and one builder
 * per model in ./cake/models/. Nothing is cached at module scope
 * because the creator disposes every geometry and material on each rebuild.
 */
import * as THREE from 'three';
import {
    createCakeCrumbBumpTexture,
    createCherryMesh,
    createStrawberryMesh,
    createTopperMesh,
    createWaferRollTexture,
    getGlazeMaterial,
    getPlateMaterial,
    hashString,
    instanceRing,
    makeRng
} from './cake/parts.js';
import { buildVintageHeart } from './cake/models/vintage-heart.js';
import { buildKoreanBento } from './cake/models/korean-bento.js';
import { buildTripleLuxury } from './cake/models/triple-luxury.js';
import { buildCyberPrism } from './cake/models/cyber-prism.js';
import { buildClassicTiered } from './cake/models/classic-tiered.js';

// Callers import textures and helpers from here too.
export * from './cake/parts.js';

export const CAKE_LAYOUTS = {
    'classic-tiered': {
        topDecorY: 1.36,
        topDecorRadius: 1.12,
        sprinkleRadius: 1.02,
        candlePlacerRadius: 0.72,
        candleBaseY: 1.35,
        topperBaseY: 1.35,
        isHeartShape: false
    },
    'vintage-heart': {
        // Glazed top at ~0.74. The heart is ~3.2 wide but its cleft comes
        // within ~1.05 of the centre, and toppings are placed on a circle, so
        // the ring has to clear the inner shell border at the cleft.
        topDecorY: 0.75,
        topDecorRadius: 0.8,
        sprinkleRadius: 0.72,
        candlePlacerRadius: 0.5,
        candleBaseY: 0.73,
        topperBaseY: 0.75,
        isHeartShape: true
    },
    'korean-bento': {
        topDecorY: 0.44,
        topDecorRadius: 1.0,
        sprinkleRadius: 0.9,
        candlePlacerRadius: 0.52,
        candleBaseY: 0.43,
        topperBaseY: 0.44,
        isHeartShape: false
    },
    'triple-luxury': {
        topDecorY: 1.86,
        topDecorRadius: 0.72,
        sprinkleRadius: 0.66,
        candlePlacerRadius: 0.46,
        candleBaseY: 1.84,
        topperBaseY: 1.86,
        isHeartShape: false
    },
    'cyber-prism': {
        topDecorY: 1.24,
        topDecorRadius: 1.05,
        sprinkleRadius: 0.95,
        candlePlacerRadius: 0.62,
        candleBaseY: 1.22,
        topperBaseY: 1.24,
        isHeartShape: false
    }
};

export function getCakeLayout(cakeModel) {
    return { ...(CAKE_LAYOUTS[cakeModel] || CAKE_LAYOUTS['classic-tiered']) };
}

const MODEL_BUILDERS = {
    'vintage-heart': buildVintageHeart,
    'korean-bento': buildKoreanBento,
    'triple-luxury': buildTripleLuxury,
    'cyber-prism': buildCyberPrism,
    'classic-tiered': buildClassicTiered
};

/* ------------------------------------------------------------------ *
 * Shared toppings
 * ------------------------------------------------------------------ */

function addToppings(group, layout, opts, tagged) {
    const { topDecorY, topDecorRadius, sprinkleRadius } = layout;
    const { strawberries, cherries, rolls, sprinkles, seed } = opts;

    // Fruit sits in clusters (a strawberry with a cherry tucked beside it)
    // instead of a mechanical alternating ring, and wafer pairs take their own
    // slots between clusters so nothing collides. Everything is jittered from
    // the seeded rng, so the sender's preview and the recipient's card match.
    const rng = makeRng((seed ^ 0x2c1b3c6d) >>> 0);
    const clusters = Math.max(strawberries, cherries);
    const slotCount = clusters + rolls;
    // Bresenham-style spread: true for `k` of `n` evenly spaced indices.
    const spread = (i, k, n) => k > 0 && Math.floor((i * k) / n) !== Math.floor(((i + 1) * k) / n);
    const slotStep = slotCount > 0 ? (Math.PI * 2) / slotCount : 0;
    const slotStart = rng() * Math.PI * 2;

    let clusterIdx = 0;
    const waferSlots = [];
    for (let s = 0; s < slotCount; s++) {
        const angle = slotStart + s * slotStep + (rng() - 0.5) * slotStep * 0.35;
        if (spread(s, rolls, slotCount)) {
            waferSlots.push(angle);
            continue;
        }
        const i = clusterIdx++;
        // Tuck the cluster slightly inside the rim so fruit never overhangs.
        const r = topDecorRadius - 0.02 - rng() * 0.07;
        const hasBerry = spread(i, strawberries, clusters);
        const hasCherry = spread(i, cherries, clusters);

        if (hasBerry) {
            const strawberry = createStrawberryMesh();
            strawberry.position.set(Math.cos(angle) * r, topDecorY, Math.sin(angle) * r);
            // Most lie tipped over onto their side, as if set down by hand.
            strawberry.rotation.set(0.2 + rng() * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
            const sc = 0.9 + rng() * 0.2;
            strawberry.scale.set(sc, sc * (0.95 + rng() * 0.1), sc);
            if (tagged) strawberry.name = 'strawberry';
            group.add(strawberry);
        }

        if (hasCherry) {
            // Beside the berry (tangential offset, a little inward), or on
            // the slot itself when it's alone.
            const side = rng() < 0.5 ? -1 : 1;
            const off = hasBerry ? 0.15 + rng() * 0.04 : 0;
            const tx = -Math.sin(angle) * off * side;
            const tz = Math.cos(angle) * off * side;
            const rc = hasBerry ? r - 0.06 : r;
            const cherry = createCherryMesh();
            cherry.position.set(Math.cos(angle) * rc + tx, topDecorY + 0.05, Math.sin(angle) * rc + tz);
            cherry.rotation.set((rng() - 0.5) * 0.25, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
            cherry.scale.setScalar(0.9 + rng() * 0.15);
            if (tagged) cherry.name = 'cherry';
            group.add(cherry);
        }
    }

    if (waferSlots.length) {
        // Rolled wafer sticks stand in pairs, pushed into the cream and
        // splayed slightly outward — the way a pastry chef dresses a cake —
        // rather than one stick poking out of the side. One InstancedMesh for
        // all of them; the caps show the chocolate filling.
        const ROLL_LEN = 0.4;
        const ROLL_R = 0.026;
        const rollGeo = new THREE.CylinderGeometry(ROLL_R, ROLL_R, ROLL_LEN, 20, 1);
        rollGeo.translate(0, ROLL_LEN / 2, 0);
        const rollTexture = createWaferRollTexture();
        const sideMat = new THREE.MeshStandardMaterial({ map: rollTexture, roughness: 0.62, metalness: 0 });
        sideMat.addEventListener('dispose', () => rollTexture.dispose());
        const capMat = new THREE.MeshStandardMaterial({ color: 0x3a1d0c, roughness: 0.45 });

        const rollsMesh = new THREE.InstancedMesh(rollGeo, [sideMat, capMat, capMat], waferSlots.length * 2);
        const dummy = new THREE.Object3D();
        const r = topDecorRadius - 0.08;
        waferSlots.forEach((angle, w) => {
            for (let k = 0; k < 2; k++) {
                const side = k === 0 ? -1 : 1;
                const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
                const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
                dummy.position.set(Math.cos(angle) * r, topDecorY - 0.04, Math.sin(angle) * r)
                    .addScaledVector(tangent, side * ROLL_R * 1.15);
                // Lean outward, splay apart, and vary each stick's height a touch.
                const lean = 0.14 + rng() * 0.08;
                const splay = side * (0.07 + rng() * 0.05);
                dummy.quaternion.setFromAxisAngle(tangent, -lean)
                    .premultiply(new THREE.Quaternion().setFromAxisAngle(outward, splay));
                dummy.scale.set(1, 0.88 + rng() * 0.2, 1);
                dummy.updateMatrix();
                rollsMesh.setMatrixAt(w * 2 + k, dummy.matrix);
            }
        });
        rollsMesh.castShadow = true;
        rollsMesh.receiveShadow = true;
        if (tagged) rollsMesh.name = 'wafer-roll';
        group.add(rollsMesh);
    }

    if (sprinkles) {
        const colors = [0xff6b8b, 0xffd166, 0x06d6a0, 0x118ab2, 0xff9f1c, 0xb5179e];
        // Seeded: the scatter has to match between the sender's preview and
        // the card the recipient opens. It used to be Math.random, so it
        // re-rolled on every rebuild and never matched.
        const rng = makeRng((seed ^ 0x5f37a1b3) >>> 0);

        // Pre-roll the placements, then draw one instanced pass per colour —
        // 6 draw calls instead of 60 meshes with 60 separate materials.
        const placements = [];
        for (let i = 0; i < 60; i++) {
            placements.push({
                r: Math.sqrt(rng()) * sprinkleRadius,
                theta: rng() * Math.PI * 2,
                tiltX: (rng() - 0.5) * 0.15,
                spin: rng() * Math.PI * 2,
                tiltZ: (rng() - 0.5) * 0.15
            });
        }

        const sprinkleGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.06, 5);
        colors.forEach((color, c) => {
            const mine = placements.filter((_, i) => i % colors.length === c);
            if (!mine.length) return;
            group.add(instanceRing(
                sprinkleGeo.clone(),
                new THREE.MeshStandardMaterial({ color, roughness: 0.45 }),
                mine.length,
                (d, k) => {
                    const p = mine[k];
                    d.position.set(Math.cos(p.theta) * p.r, topDecorY + 0.005, Math.sin(p.theta) * p.r);
                    d.rotation.set(Math.PI / 2 + p.tiltX, p.spin, p.tiltZ);
                    d.scale.setScalar(1);
                }
            ));
        });
        sprinkleGeo.dispose();
    }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Builds a complete cake into `group` and returns its layout metrics.
 *
 * @param {THREE.Group} group          emptied by the caller beforehand
 * @param {object}      opts
 * @param {string}      opts.cakeModel one of CAKE_LAYOUTS' keys
 * @param {object}      opts.themeColors  { tier1, tier2, cream } hex numbers
 * @param {boolean}     opts.tagDecor  name fruit meshes for click interaction
 *                                     (the viewer raycasts them; the preview
 *                                     doesn't)
 * @returns {object} layout — see CAKE_LAYOUTS
 */
export function buildCakeModel(group, opts = {}) {
    const {
        cakeModel = 'classic-tiered',
        plateStyle = 'ceramic',
        glazeStyle = 'chocolate',
        topperStyle = 'best-senpai',
        topperText = '',
        themeName = 'neon-rose',
        themeColors = { tier1: 0xed004c, tier2: 0x3f0085, cream: 0xffffff },
        strawberries = 4,
        cherries = 4,
        rolls = 3,
        sprinkles = true,
        glazeColor = '',
        creamColor = '',
        plateColor = '',
        topperColor = '',
        tagDecor = false,
        detail = 1
    } = opts;

    const layout = getCakeLayout(cakeModel);

    const ctx = {
        plateMat: getPlateMaterial(plateStyle, plateColor),
        glazeMat: getGlazeMaterial(glazeStyle, glazeColor),
        crumbBumpTex: createCakeCrumbBumpTexture(),
        colorTier1: creamColor ? new THREE.Color(creamColor) : new THREE.Color(themeColors.tier1),
        colorTier2: creamColor ? new THREE.Color(creamColor) : new THREE.Color(themeColors.tier2),
        // Ribbons, bows and rosette highlights follow the theme's accent so a
        // sakura cake reads pink and a midnight-gold cake reads gold.
        accentColor: new THREE.Color(themeColors.cream).getHex(),
        // Piped cream picks up a whisper of the accent instead of pure white,
        // which is what stops the frosting looking like printer paper.
        creamTint: new THREE.Color(0xfffafb).lerp(new THREE.Color(themeColors.cream), 0.12).getHex(),
        // 1 on desktop, ~0.6 on phones. Thins out the decoration rings and
        // coarsens the piped-cream spheres rather than cutting features.
        detail: THREE.MathUtils.clamp(detail, 0.35, 1)
    };

    (MODEL_BUILDERS[cakeModel] || MODEL_BUILDERS['classic-tiered'])(group, ctx);

    addToppings(group, layout, {
        strawberries,
        cherries,
        rolls,
        sprinkles,
        seed: hashString(`${cakeModel}|${themeName}|${glazeStyle}|${plateStyle}`)
    }, tagDecor);

    const topper = createTopperMesh(topperStyle, topperText, topperColor, themeName);
    if (topper) {
        topper.position.set(0, layout.topperBaseY, 0);
        group.add(topper);
    }

    return layout;
}
