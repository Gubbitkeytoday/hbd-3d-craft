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
export const LETTERS = Object.freeze({ x: -0.3, z: -2.36, row1Y: 2.12, row2Y: 1.68, height: 0.36 });

/**
 * Camera presets in metres (converted to world units by shotsWorld()).
 * entry: standing in the doorway, the glowing switch and the city window in
 * frame (also on a 9:19.5 phone). wide: the whole decorated room. cake:
 * table height, cake centred with the letters behind. closeUp: the flames.
 */
export const SHOTS_M = Object.freeze({
    entry: { position: [1.9, 1.56, 2.3], target: [2.15, 1.3, -0.3] },
    wide: { position: [1.75, 1.62, 2.05], target: [-0.36, 1.15, -1.6] },
    cake: { position: [0.1, 1.3, 0.95], target: [-0.3, 1.1, -0.85] },
    closeUp: { position: [-0.18, 1.08, -0.18], target: [-0.3, 0.9, -0.8] }
});

/** Night-city panorama arc outside the window (scripts/room/layout.json "city"). */
export const CITY = Object.freeze({ cx: 0.8, cz: -2.4, radius: 9, theta0: -165, theta1: -15, y0: -2.6, y1: 5.75, repeat: 2 });

export function toWorld(v, out = new THREE.Vector3()) {
    return out.set(v[0], v[1], v[2]).multiplyScalar(ROOM_SCALE);
}

export function shotsWorld() {
    const shots = {};
    for (const [name, s] of Object.entries(SHOTS_M)) {
        shots[name] = { position: toWorld(s.position), target: toWorld(s.target) };
    }
    return shots;
}
