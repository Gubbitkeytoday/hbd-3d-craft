/**
 * Room pieces that exist in every build:
 *   - the night city behind the window (baked skyline image, unlit)
 *   - the wall light switch (plate, rocker, breathing locator LED, hit box)
 *   - a procedural greybox of the room (shell + furniture proxies, lit by
 *     the real-time rig). It is what renders while the baked room streams in
 *     and the fallback if it fails to load, so the party always has a room.
 * All in metres, inside the room group.
 */
import * as THREE from 'three';
import { ROOM, TABLE, PENDANT, CITY } from './layout.js';

/* ------------------------------------------------------------------ */
/* City window                                                         */
/* ------------------------------------------------------------------ */

/**
 * The same skyline image the Blender bake used as the window's light
 * source (scripts/room/make_city.py), on the same panorama arc, so what you
 * see through the glass matches the light it throws into the room. Unlit
 * and a little HDR so the lit windows bloom. The texture object exists from
 * the start (dark blue placeholder); the WebP only swaps its image, which
 * keeps the program.
 */
export function createCity(url) {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#10183a';
    ctx.fillRect(0, 0, 4, 4);
    const tex = new THREE.Texture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    let alive = true;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
        if (!alive) return;
        tex.image = img;
        tex.needsUpdate = true;
    };
    img.src = url;
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(2.1, 2.1, 2.17), fog: false, side: THREE.DoubleSide });
    const geo = cityArc(CITY);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'city';
    // Aircraft beacon on a far tower.
    const beaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.4, 0.3), fog: false });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), beaconMat);
    beacon.position.set(3.4, 3.3, -10.6);
    const group = new THREE.Group().add(mesh, beacon);
    return {
        group,
        update(time) { beaconMat.color.setRGB(Math.sin(time * 2.4) > 0.6 ? 5 : 0.15, 0.3, 0.25); },
        dispose() { alive = false; tex.dispose(); mat.dispose(); geo.dispose(); beacon.geometry.dispose(); beaconMat.dispose(); }
    };
}

/** Vertical cylinder segment (x = cx + r cos t, z = cz + r sin t), as in room.py. */
function cityArc({ cx, cz, radius, theta0, theta1, y0, y1, repeat }) {
    const n = 48;
    const pos = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const th = THREE.MathUtils.degToRad(theta0 + (theta1 - theta0) * t);
        const x = cx + radius * Math.cos(th);
        const z = cz + radius * Math.sin(th);
        pos.push(x, y0, z, x, y1, z);
        uv.push(t * repeat, 0, t * repeat, 1);
    }
    for (let i = 0; i < n; i++) idx.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
}

/* ------------------------------------------------------------------ */
/* Light switch                                                        */
/* ------------------------------------------------------------------ */

export function createSwitch({ plateMaterial, accent = 0xffb060 }) {
    const group = new THREE.Group();
    group.name = 'light-switch';
    // On the pier face that looks at the doorway (+z).
    group.position.set(ROOM.switch.x, ROOM.switch.y, ROOM.switch.z);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.086, 0.086, 0.008), plateMaterial);
    plate.position.z = 0.004;
    const rocker = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.056, 0.01), plateMaterial);
    rocker.position.z = 0.011;
    // Locator LED ring around the rocker + a soft halo on the wall.
    const ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(accent), fog: false });
    const led = new THREE.Mesh(new THREE.RingGeometry(0.034, 0.038, 32), ledMat);
    led.position.z = 0.0085;
    const haloTex = haloTexture();
    const haloMat = new THREE.MeshBasicMaterial({
        map: haloTex, color: new THREE.Color(accent), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), haloMat);
    halo.name = 'switch-halo';
    halo.position.z = 0.0015;
    // Generous invisible hit target (>= 64 px on a phone at the entry shot).
    const hit = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.05), new THREE.MeshBasicMaterial());
    hit.visible = false;
    hit.name = 'switch-hit';
    group.add(halo, plate, rocker, led, hit);
    const base = new THREE.Color(accent);
    let on = false;
    return {
        group, hit, rocker,
        setOn(v) {
            if (v === on) return;
            on = v;
            rocker.rotation.x = v ? -0.2 : 0.2;
        },
        update(time, lit) {
            // Slow 1.6 s breathing, never a flash (WCAG 2.3.1).
            const breathe = 0.55 + 0.45 * (0.5 - 0.5 * Math.cos(time * Math.PI * 2 / 1.6));
            const k = (1 - lit) * breathe;
            ledMat.color.copy(base).multiplyScalar(0.4 + 3.2 * k);
            haloMat.opacity = 0.08 + 0.55 * k;
            // Lit room: the locator LED is off; two fewer draw calls.
            led.visible = halo.visible = lit < 0.5;
        },
        dispose() {
            [plate, rocker, led, halo, hit].forEach((m) => m.geometry.dispose());
            ledMat.dispose(); haloMat.dispose(); haloTex.dispose(); hit.material.dispose();
        }
    };
}

function haloTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/* ------------------------------------------------------------------ */
/* Greybox                                                             */
/* ------------------------------------------------------------------ */

/**
 * Real-time lit stand-in for the baked room. Its materials are ordinary
 * MeshStandardMaterials; the few programs they need are compiled with the
 * rest of the room.
 */
export function createGreybox() {
    const group = new THREE.Group();
    group.name = 'room-greybox';
    const geos = [];
    const mats = {
        floor: new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.45 }),
        wall: new THREE.MeshStandardMaterial({ color: 0xe8dccb, roughness: 0.9 }),
        ceiling: new THREE.MeshStandardMaterial({ color: 0xf2ece2, roughness: 0.95 }),
        wood: new THREE.MeshStandardMaterial({ color: 0xb58a5f, roughness: 0.5 }),
        fabric: new THREE.MeshStandardMaterial({ color: 0x9a8f86, roughness: 0.95 }),
        frame: new THREE.MeshStandardMaterial({ color: 0x2a2522, roughness: 0.4, metalness: 0.3 }),
        glass: new THREE.MeshStandardMaterial({ color: 0x0a0e18, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.18, depthWrite: false })
    };
    const add = (geo, mat, x, y, z, ry = 0) => {
        geos.push(geo);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.rotation.y = ry;
        group.add(m);
        return m;
    };
    const { halfX: X, halfZ: Z, height: H, window: W } = ROOM;
    // Floor & ceiling
    add(new THREE.PlaneGeometry(X * 2, Z * 2).rotateX(-Math.PI / 2), mats.floor, 0, 0, 0);
    add(new THREE.PlaneGeometry(X * 2, Z * 2).rotateX(Math.PI / 2), mats.ceiling, 0, H, 0);
    // Back wall with the window opening (4 pieces), left and front walls.
    const bw = (x0, x1, y0, y1) => add(new THREE.PlaneGeometry(x1 - x0, y1 - y0), mats.wall, (x0 + x1) / 2, (y0 + y1) / 2, -Z);
    bw(-X, W.x0, 0, H);
    bw(W.x1, X, 0, H);
    bw(W.x0, W.x1, W.y1, H);
    bw(W.x0, W.x1, 0, W.y0);
    add(new THREE.PlaneGeometry(W.x1 - W.x0, W.y1 - W.y0), mats.glass, (W.x0 + W.x1) / 2, (W.y0 + W.y1) / 2, -Z - 0.05);
    add(new THREE.PlaneGeometry(Z * 2, H).rotateY(Math.PI / 2), mats.wall, -X, H / 2, 0);
    add(new THREE.PlaneGeometry(X * 2, H).rotateY(Math.PI), mats.wall, 0, H / 2, Z);
    add(new THREE.PlaneGeometry(Z * 2, H).rotateY(-Math.PI / 2), mats.wall, X, H / 2, 0);
    // Column with the switch
    add(new THREE.BoxGeometry(X - ROOM.pierX0, H, ROOM.switch.z - ROOM.pierZ0), mats.wall, (X + ROOM.pierX0) / 2, H / 2, (ROOM.switch.z + ROOM.pierZ0) / 2);
    // Table: top + pedestal
    add(new THREE.CylinderGeometry(TABLE.radius, TABLE.radius, 0.035, 48), mats.wood, TABLE.x, TABLE.height - 0.0175, TABLE.z);
    add(new THREE.CylinderGeometry(0.05, 0.07, TABLE.height - 0.04, 16), mats.wood, TABLE.x, (TABLE.height - 0.04) / 2, TABLE.z);
    add(new THREE.CylinderGeometry(0.28, 0.3, 0.03, 32), mats.wood, TABLE.x, 0.015, TABLE.z);
    // Sofa on the left wall
    add(new THREE.BoxGeometry(0.9, 0.42, 2.0), mats.fabric, -X + 0.48, 0.21, 0.35);
    add(new THREE.BoxGeometry(0.22, 0.5, 2.0), mats.fabric, -X + 0.14, 0.62, 0.35);
    // Shelves (back wall left)
    add(new THREE.BoxGeometry(0.9, 1.6, 0.35), mats.wood, -2.0, 0.8, -Z + 0.18);
    // Side table by the sofa
    add(new THREE.CylinderGeometry(0.24, 0.24, 0.55, 24), mats.wood, -X + 0.45, 0.275, 1.6);
    // Pendant lamp over the table
    add(new THREE.CylinderGeometry(0.004, 0.004, H - PENDANT.y - 0.1, 4), mats.frame, PENDANT.x, (H + PENDANT.y + 0.1) / 2, PENDANT.z);
    add(new THREE.ConeGeometry(0.2, 0.18, 32, 1, true), mats.frame, PENDANT.x, PENDANT.y + 0.05, PENDANT.z);
    // Front door frame (dark opening)
    add(new THREE.PlaneGeometry(ROOM.door.x1 - ROOM.door.x0, ROOM.door.y1).rotateY(Math.PI), mats.frame, (ROOM.door.x0 + ROOM.door.x1) / 2, ROOM.door.y1 / 2, Z - 0.01);
    group.traverse((o) => { if (o.isMesh) o.matrixAutoUpdate = true; });
    return {
        group,
        materials: Object.values(mats),
        dispose() { geos.forEach((g) => g.dispose()); Object.values(mats).forEach((m) => m.dispose()); }
    };
}
