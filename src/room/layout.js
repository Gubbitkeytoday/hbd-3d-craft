/**
 * Party-room layout: one source of truth for the runtime, the procedural
 * greybox and the Blender scripts (scripts/room/layout.json mirrors the
 * numbers that matter to the bake; keep them in sync).
 *
 * Authoring units are metres, y up, origin on the floor in the room centre,
 * the camera enters from +z. The whole room is scaled by ROOM_SCALE so the
 * existing cake keeps scale 1: a classic tiered cake at scale 1 measures
 * ~5.2 units across its plate, and at 14 units per metre that is a real
 * 37 cm cake on its stand. Keeping the cake (and everything the viewer does
 * around it: candle light, embers, camera maths) in its own units is far
 * less risky than shrinking it.
 */
import * as THREE from 'three';

export const ROOM_SCALE = 14;

export const ROOM = Object.freeze({
    halfX: 2.7,
    halfZ: 2.4,
    height: 2.65,
    // Balcony sliding door on the back wall (z = -halfZ), right of the letters.
    window: { x0: 0.95, x1: 2.45, y0: 0.08, y1: 2.42 },
    // Front door in the front wall (z = +halfZ), right corner: the camera
    // stands in it at the start.
    door: { x0: 1.55, x1: 2.45, y1: 2.1 },
    // Structural column on the right wall (x from pierX0 to the wall, z from
    // pierZ0 to switch.z); the light switch sits on the face that looks at
    // the door.
    switch: { x: 2.62, y: 1.18, z: -0.5 },
    pierX0: 2.54, pierZ0: -0.9
});

/** Round dining table under the pendant: the hero spot. */
export const TABLE = Object.freeze({ x: -0.3, z: -0.75, radius: 0.52, height: 0.745 });

/** The cake stands a little off-centre so gifts and the frame fit beside it. */
export const CAKE_SPOT = Object.freeze({ x: -0.3, z: -0.78 });

export const PENDANT = Object.freeze({ x: -0.3, y: 1.82, z: -0.75 });

/** Where the foil letters hang (back wall, centred behind the table). */
// 0.3 m letters: a real 12-inch foil kit; BIRTHDAY is ~2 m wide.
export const LETTERS = Object.freeze({ x: -0.3, z: -2.36, row1Y: 2.06, row2Y: 1.7, height: 0.3 });

/** The LED name sign under the letters (centre y, text height, max width). */
export const SIGN = Object.freeze({ y: 1.25, height: 0.4, maxWidth: 1.6 });

/**
 * Wall dressing on tall screens (aspect < 0.85). From the table a portrait
 * phone sees only ~1.4 m of the back wall, centred ~0.3 m left of the
 * letters (the lens looks at the cake from its right), between the cake top
 * (~0.95 m) and the HUD band (~1.6 m). The rows and the sign are re-hung
 * smaller, lower and shifted into that window: widest row <= letterWidth,
 * sign board <= signWidth. Measured against the receiver's portrait cake,
 * song, wish and blow framings on 360-430 px wide screens.
 */
export const PORTRAIT = Object.freeze({ x: -0.62, letterWidth: 0.95, rowY: [1.49, 1.3], signWidth: 0.95, signY: 1.07 });

/**
 * Camera presets in metres (converted to world units by shotsWorld()).
 *   entry    standing in the doorway: the glowing switch and the city window
 *   reveal   same spot, head turned to the party: HAPPY BIRTHDAY, the name
 *            sign and the table with the cake in one frame, portrait too
 *            (the letters' wall is ~5.2 m away; 62 deg portrait vfov shows
 *            ~2.9 m of it, BIRTHDAY is ~2.4 m). Tween controls.target from
 *            entry.target to here right after the lights come on.
 *   wide     the whole decorated room
 *   cake     table height, cake centred with the letters behind
 *   closeUp  the flames (nothing between the lens and the cake)
 *   preview  the creator's live preview (letters + name + cake)
 * fov: recommended vertical fov per aspect (portrait = height > width). The
 * letters' top edge stays below the top ~18 % of the frame (hero title
 * zone) at these values. portrait: optional position/target overrides for
 * tall screens (the letters leave the frame cleanly instead of being cut).
 */
export const SHOTS_M = Object.freeze({
    entry: { position: [1.9, 1.56, 2.3], target: [2.15, 1.3, -0.3], fov: { portrait: 58, landscape: 45 } },
    reveal: {
        position: [1.85, 1.58, 2.35], target: [-0.3, 1.52, -2.36], fov: { portrait: 62, landscape: 50 },
        portrait: { position: [1.85, 1.58, 2.35], target: [-0.3, 1.38, -2.36] }
    },
    wide: { position: [1.75, 1.62, 2.05], target: [-0.36, 1.15, -1.6], fov: { portrait: 60, landscape: 45 } },
    cake: {
        position: [0.1, 1.3, 0.95], target: [-0.3, 1.1, -0.85], fov: { portrait: 60, landscape: 45 },
        // Portrait: step back so all of BIRTHDAY fits (~2 m of wall visible).
        portrait: { position: [0.1, 1.25, 1.35], target: [-0.3, 1.0, -0.85] }
    },
    closeUp: { position: [-0.17, 1.1, -0.12], target: [-0.3, 0.9, -0.8], fov: { portrait: 55, landscape: 45 } },
    // Creator preview: cake, letters and name sign together (fit ~40 deg hfov).
    preview: { position: [0.4, 1.5, 1.75], target: [-0.3, 1.2, -1.1], fov: { portrait: 62, landscape: 42 } }
});

/** Night-city panorama arc outside the window (scripts/room/layout.json "city"). */
export const CITY = Object.freeze({ cx: 0.8, cz: -2.4, radius: 9, theta0: -165, theta1: -15, y0: -2.6, y1: 5.75, repeat: 2 });

export function toWorld(v, out = new THREE.Vector3()) {
    return out.set(v[0], v[1], v[2]).multiplyScalar(ROOM_SCALE);
}

/**
 * World-space shots: { position, target, fov: { portrait, landscape },
 * portrait?: { position, target } }, plus forAspect(aspect) returning the
 * { position, target, fov } to use for width / height = aspect.
 */
export function shotsWorld() {
    const shots = {};
    for (const [name, s] of Object.entries(SHOTS_M)) {
        const shot = { position: toWorld(s.position), target: toWorld(s.target), fov: { ...s.fov } };
        if (s.portrait) shot.portrait = { position: toWorld(s.portrait.position), target: toWorld(s.portrait.target) };
        shot.forAspect = (aspect) => {
            const tall = aspect < 1;
            const p = tall && shot.portrait ? shot.portrait : shot;
            return { position: p.position, target: p.target, fov: tall ? shot.fov.portrait : shot.fov.landscape };
        };
        shots[name] = shot;
    }
    return shots;
}
