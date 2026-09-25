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
        topDecorY: 0.9,
        // The heart is ~2.5 units wide; ringing decorations at 0.95 bunched
        // them into the middle and left the whole surface reading empty.
        topDecorRadius: 1.42,
        sprinkleRadius: 1.05,
        candlePlacerRadius: 0.6,
        candleBaseY: 0.88,
        topperBaseY: 0.9,
        isHeartShape: true
    },
    'korean-bento': {
        topDecorY: 0.78,
        topDecorRadius: 1.5,
        sprinkleRadius: 1.2,
        candlePlacerRadius: 0.58,
        candleBaseY: 0.77,
        topperBaseY: 0.78,
        isHeartShape: false
    },
    'triple-luxury': {
        topDecorY: 1.86,
        topDecorRadius: 0.66,
        sprinkleRadius: 0.6,
        candlePlacerRadius: 0.44,
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

    if (strawberries > 0) {
        for (let i = 0; i < strawberries; i++) {
            const s0 = 3.7 + i * 2.3;
            const angle = (i / strawberries) * Math.PI * 2 + Math.sin(s0) * 0.07;
            const r = topDecorRadius + Math.sin(s0 * 1.7) * 0.05;
            const strawberry = createStrawberryMesh();
            strawberry.position.set(
                Math.cos(angle) * r,
                topDecorY + Math.sin(s0 * 2.9) * 0.018,
                Math.sin(angle) * r
            );
            strawberry.rotation.set(
                0.12 + Math.sin(s0 * 1.4) * 0.09,
                angle + Math.PI / 2 + Math.cos(s0) * 0.35,
                Math.sin(s0 * 3.3) * 0.13
            );
            const s = 1.0 + Math.sin(s0 * 2.1) * 0.09;
            strawberry.scale.set(s, s * (1 + Math.cos(s0) * 0.05), s);
            if (tagged) strawberry.name = 'strawberry';
            group.add(strawberry);
        }
    }

    if (cherries > 0) {
        for (let i = 0; i < cherries; i++) {
            const s0 = 8.1 + i * 1.9;
            const angleOffset = strawberries > 0 ? Math.PI / cherries : 0;
            const angle = (i / cherries) * Math.PI * 2 + angleOffset + Math.sin(s0) * 0.06;
            const r = topDecorRadius + Math.cos(s0 * 1.6) * 0.05;
            const cherry = createCherryMesh();
            cherry.position.set(
                Math.cos(angle) * r,
                topDecorY + 0.04 + Math.sin(s0 * 2.4) * 0.015,
                Math.sin(angle) * r
            );
            cherry.rotation.set(
                Math.sin(s0 * 1.8) * 0.12,
                angle - Math.PI / 2 + Math.cos(s0) * 0.4,
                Math.sin(s0 * 2.6) * 0.16
            );
            cherry.scale.setScalar(0.94 + Math.sin(s0 * 3.1) * 0.1);
            if (tagged) cherry.name = 'cherry';
            group.add(cherry);
        }
    }

    if (rolls > 0) {
        const rollTexture = createWaferRollTexture();
        const rollGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.75, 18);
        const rollMat = new THREE.MeshStandardMaterial({
            map: rollTexture,
            roughness: 0.65,
            metalness: 0.05
        });

        for (let i = 0; i < rolls; i++) {
            const angle = (i / rolls) * Math.PI * 2 + Math.PI / 8;
            const rollGroup = new THREE.Group();

            const rollMesh = new THREE.Mesh(rollGeo, rollMat);
            rollMesh.castShadow = true;
            rollGroup.add(rollMesh);

            const s0 = 1.3 + i * 2.7;
            const lean = 0.55 + Math.sin(s0) * 0.13;
            const r = topDecorRadius * 1.08 + Math.sin(s0 * 1.5) * 0.04;
            rollGroup.position.set(
                Math.cos(angle) * r,
                topDecorY - 0.25 + Math.sin(s0 * 2.2) * 0.03,
                Math.sin(angle) * r
            );
            rollGroup.rotation.x = -Math.sin(angle) * lean;
            rollGroup.rotation.z = Math.cos(angle) * lean;
            rollGroup.rotation.y = -angle;
            if (tagged) rollGroup.name = 'wafer-roll';

            group.add(rollGroup);
        }
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
