/**
 * 3D confetti: one InstancedMesh pool (paper + foil pieces share a metal-ish
 * standard material; per-instance colour), time-based flight with air drag
 * and flutter, landing flat on the floor or the table where it stays until
 * the pool is reused. No allocation per burst.
 */
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const HIDE = new THREE.Vector3(0, -50, 0);

export function createConfetti({ count, palette, rand, tableTop, bounds }) {
    const geo = new THREE.PlaneGeometry(0.014, 0.022);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.55, side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = 'room-confetti';
    mesh.frustumCulled = false;
    const col = new THREE.Color();
    const parts = [];
    for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, col.setHex(palette[i % palette.length]));
        parts.push({
            p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(),
            alive: false, landed: false, t: 0, size: 0.7 + rand() * 0.6
        });
        mesh.setMatrixAt(i, _m.compose(HIDE, _q.identity(), _s.setScalar(0)));
    }
    let cursor = 0;
    let active = 0;

    /** origin in metres (room space); count per burst */
    function burst(origin, n = Math.floor(count * 0.6), spread = 1) {
        for (let k = 0; k < n; k++) {
            const it = parts[cursor];
            cursor = (cursor + 1) % count;
            const a = rand() * Math.PI * 2;
            const up = 1.6 + rand() * 1.6;
            const out = (0.4 + rand() * 1.2) * spread;
            it.p.copy(origin);
            it.v.set(Math.cos(a) * out, up, Math.sin(a) * out);
            it.r.set(rand() * 6, rand() * 6, rand() * 6);
            it.w.set((rand() - 0.5) * 18, (rand() - 0.5) * 18, (rand() - 0.5) * 18);
            it.alive = true;
            it.landed = false;
            it.t = 0;
        }
        active = count;
    }

    function update(dt) {
        if (!active) return;
        const step = Math.min(dt, 1 / 30);
        let moving = 0;
        for (let i = 0; i < count; i++) {
            const it = parts[i];
            if (!it.alive || it.landed) continue;
            it.t += step;
            it.v.y -= 9.8 * step;
            // Paper falls at ~0.5 m/s once it flutters: strong drag.
            const drag = 1 - Math.min(0.9, 3.2 * step);
            it.v.multiplyScalar(drag);
            it.v.x += Math.sin(it.t * 7 + i) * 0.35 * step;
            it.p.addScaledVector(it.v, step);
            it.r.x += it.w.x * step;
            it.r.y += it.w.y * step;
            it.r.z += it.w.z * step;
            const onTable = Math.hypot(it.p.x - tableTop.x, it.p.z - tableTop.z) < tableTop.radius;
            const ground = onTable && it.p.y > tableTop.y - 0.05 ? tableTop.y + 0.002 : 0.002;
            if (it.p.y <= ground) {
                it.p.y = ground;
                it.landed = true;
                it.r.set(-Math.PI / 2, 0, it.r.z);
            }
            it.p.x = THREE.MathUtils.clamp(it.p.x, bounds.x0, bounds.x1);
            it.p.z = THREE.MathUtils.clamp(it.p.z, bounds.z0, bounds.z1);
            _q.setFromEuler(it.r);
            mesh.setMatrixAt(i, _m.compose(it.p, _q, _s.setScalar(it.size)));
            moving++;
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (!moving) active = 0;
    }

    function clear() {
        parts.forEach((it, i) => {
            it.alive = false;
            mesh.setMatrixAt(i, _m.compose(HIDE, _q.identity(), _s.setScalar(0)));
        });
        mesh.instanceMatrix.needsUpdate = true;
        active = 0;
    }

    return { mesh, material: mat, burst, update, clear, dispose() { geo.dispose(); mat.dispose(); } };
}
