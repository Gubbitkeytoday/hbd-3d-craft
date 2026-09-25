/**
 * The room's constant real-time light rig (research-photoreal 1.3). Three
 * lights exist from the first frame to the last, in the dark and in the lit
 * state, because three's program key counts lights per type: switching the
 * room on only animates intensity/colour, never visibility or castShadow.
 *
 *   candle  PointLight  warm, over the cake; the only real light in the dark
 *   pendant SpotLight   key over the table (shadow on tier 2 only)
 *   fill    HemisphereLight  city-blue in the dark, warm ceiling/floor bounce lit
 *
 * The static room does not take these lights (its light is baked, see
 * materials.js); they light the dynamic things: cake, balloons, letters,
 * gifts, confetti. Intensities are candela at metre scale times ROOM_SCALE^2
 * (inverse-square falloff in world units).
 */
import * as THREE from 'three';
import { ROOM_SCALE, PENDANT, TABLE, toWorld } from './layout.js';

const S2 = ROOM_SCALE * ROOM_SCALE;

/** Rig values per state (metre-scale candela). Lerped by setLights/setDim. */
const DARK = {
    candle: 0.6, pendant: 0, hemiSky: 0x33487a, hemiGround: 0x1a1216, hemi: 0.45
};
const LIT = {
    candle: 0.35, pendant: 15, hemiSky: 0xffe2c2, hemiGround: 0x6b4a36, hemi: 1.05
};
/** Singing dim over the lit room: practicals down, the candles carry it. */
const DIM = { pendant: 2.5, hemi: 0.22, candle: 0.7 };

export function createRig({ quality, shadows }) {
    const group = new THREE.Group();
    group.name = 'room-rig';

    const candle = new THREE.PointLight(0xff9a3c, 0, 2.2 * ROOM_SCALE, 2);
    candle.name = 'room-candle';
    toWorld([TABLE.x, TABLE.height + 0.32, TABLE.z], candle.position);
    group.add(candle);

    const pendant = new THREE.SpotLight(0xffd3a1, 0, 3.2 * ROOM_SCALE, THREE.MathUtils.degToRad(38), 0.65, 2);
    pendant.name = 'room-pendant';
    toWorld([PENDANT.x, PENDANT.y - 0.05, PENDANT.z], pendant.position);
    toWorld([TABLE.x, TABLE.height, TABLE.z], pendant.target.position);
    group.add(pendant, pendant.target);
    // Tier 2 only (shadow maps are off on phones anyway): the cake shades
    // its own tiers. The baked table never receives it (its light is baked),
    // a contact shadow grounds the cake instead.
    pendant.castShadow = !!(shadows && quality >= 2);
    if (pendant.castShadow) {
        pendant.shadow.mapSize.set(1024, 1024);
        pendant.shadow.camera.near = 0.3 * ROOM_SCALE;
        pendant.shadow.camera.far = 2.4 * ROOM_SCALE;
        pendant.shadow.bias = -0.0005;
        pendant.shadow.normalBias = 0.03;
        pendant.shadow.radius = 4;
    }

    const hemi = new THREE.HemisphereLight(DARK.hemiSky, DARK.hemiGround, 0);
    hemi.name = 'room-fill';
    group.add(hemi);

    const skyDark = new THREE.Color(DARK.hemiSky);
    const skyLit = new THREE.Color(LIT.hemiSky);
    const groundDark = new THREE.Color(DARK.hemiGround);
    const groundLit = new THREE.Color(LIT.hemiGround);

    let lit = 0;
    let dim = 0;
    let candleLevel = 1;
    let flicker = 1;

    function apply() {
        const l = lit;
        const d = dim * l;
        const pend = THREE.MathUtils.lerp(DARK.pendant, LIT.pendant, l);
        pendant.intensity = THREE.MathUtils.lerp(pend, DIM.pendant, d) * S2;
        hemi.intensity = THREE.MathUtils.lerp(THREE.MathUtils.lerp(DARK.hemi, LIT.hemi, l), DIM.hemi, d);
        hemi.color.copy(skyDark).lerp(skyLit, l);
        hemi.groundColor.copy(groundDark).lerp(groundLit, l);
        const c = THREE.MathUtils.lerp(THREE.MathUtils.lerp(DARK.candle, LIT.candle, l), DIM.candle, d);
        candle.intensity = c * candleLevel * flicker * S2;
    }

    return {
        group,
        candle,
        pendant,
        hemi,
        setLit(t) { lit = t; apply(); },
        setDim(t) { dim = t; apply(); },
        /** 0..1: how many candles still burn (SHOW calls room.setCandles). */
        setCandles(level) { candleLevel = level; apply(); },
        update(time) {
            // Two incommensurate sines + a slow drift: a flame, not a strobe.
            flicker = 0.9 + 0.06 * Math.sin(time * 11.3) + 0.04 * Math.sin(time * 23.7 + 1.3) + 0.03 * Math.sin(time * 1.7);
            apply();
        },
        get candleLevel() { return candleLevel * flicker; },
        dispose() {
            pendant.dispose();
            candle.dispose();
            hemi.dispose();
        }
    };
}
