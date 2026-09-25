/**
 * Latex balloons: one lathe geometry, one InstancedMesh for every balloon in
 * the room (clusters + the finale drop share the program and the geometry;
 * they are two meshes only so the drop can be hidden until it is needed
 * without touching the clusters).
 *
 * Latex is not transmissive in real time on a phone; what sells it is a
 * clearcoat highlight over a softer base, a touch of sheen, and light that
 * seems to pass through the thin rubber: a view-dependent rim that lets the
 * colour glow brighter and more saturated at grazing angles (onBeforeCompile,
 * a few ALU ops, no extra pass).
 */
import * as THREE from 'three';

/** Balloon profile (radius by height), 30 cm latex at metre scale. */
function balloonGeometry() {
    const pts = [];
    const N = 22;
    for (let i = 0; i <= N; i++) {
        const t = i / N; // 0 bottom (knot) -> 1 top
        const a = t * Math.PI;
        // Egg: fuller near the top, pinched to the knot.
        let r = Math.sin(a) * (0.135 + 0.028 * Math.sin(a * 0.5 + 0.9)) * (1 - 0.3 * Math.pow(1 - t, 5));
        if (i === 0) r = 0.012;
        const y = -Math.cos(a) * 0.165 + 0.02 * Math.sin(a);
        pts.push(new THREE.Vector2(Math.max(r, 0.0001), y));
    }
    // Knot
    pts.unshift(new THREE.Vector2(0.001, -0.2), new THREE.Vector2(0.014, -0.192), new THREE.Vector2(0.01, -0.178));
    const geo = new THREE.LatheGeometry(pts, 28);
    geo.computeVertexNormals();
    return geo;
}

const RIM_PARS = /* glsl */`
uniform float uRimK;
`;
const RIM_FRAG = /* glsl */`
{
    // Thin-rubber look: brighter, deeper colour where the view grazes the
    // surface (light travelling through less rubber reaches the eye).
    float ndv = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
    float rim = pow( 1.0 - ndv, 2.2 );
    totalEmissiveRadiance += diffuseColor.rgb * diffuseColor.rgb * rim * uRimK;
}
`;

export function createLatexMaterial(uniforms) {
    const mat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.36,
        metalness: 0,
        clearcoat: 0.6,
        clearcoatRoughness: 0.18,
        sheen: 0.25,
        sheenRoughness: 0.5,
        sheenColor: new THREE.Color(0xffffff)
    });
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uRimK = uniforms.uRimK;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${RIM_PARS}`)
            .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${RIM_FRAG}`);
    };
    mat.customProgramCacheKey = () => 'room-latex-v1';
    return mat;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * @param {object} opts
 * @param {Array<{pos:number[], count:number, spread:number}>} opts.clusters  metre positions
 * @param {number[]} opts.palette  hex colours
 * @param {function} opts.rand     seeded random
 */
export function createBalloonClusters({ clusters, palette, rand, material, geometry }) {
    const items = [];
    for (const c of clusters) {
        for (let i = 0; i < c.count; i++) {
            const a = rand() * Math.PI * 2;
            const r = c.spread * Math.sqrt(rand());
            const size = 0.82 + rand() * 0.36;
            items.push({
                base: new THREE.Vector3(c.pos[0] + Math.cos(a) * r, c.pos[1] + (rand() - 0.3) * c.spread * 1.2, c.pos[2] + Math.sin(a) * r * 0.6),
                tilt: new THREE.Vector2((rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5),
                size,
                phase: rand() * Math.PI * 2,
                color: palette[Math.floor(rand() * palette.length)]
            });
        }
    }
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    mesh.name = 'room-balloons';
    const col = new THREE.Color();
    items.forEach((it, i) => mesh.setColorAt(i, col.setHex(it.color)));
    mesh.frustumCulled = false;

    function update(time, amount = 1) {
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const sway = Math.sin(time * 0.7 + it.phase) * 0.06 * amount;
            _e.set(it.tilt.x + sway, it.phase, it.tilt.y + Math.cos(time * 0.55 + it.phase) * 0.05 * amount);
            _q.setFromEuler(_e);
            _p.copy(it.base);
            _p.y += Math.sin(time * 0.9 + it.phase) * 0.008 * amount;
            _s.setScalar(it.size);
            mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
        }
        mesh.instanceMatrix.needsUpdate = true;
    }
    update(0);
    return { mesh, items, update };
}

/**
 * Finale: balloons released from a net under the ceiling. Time-based, pooled
 * (the same instances every replay), gravity with air drag and a soft
 * bounce, settling on the floor / table and rolling to rest.
 */
export function createBalloonDrop({ count, palette, rand, material, geometry, area, ceilingY, tableTop }) {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = 'room-balloon-drop';
    mesh.frustumCulled = false;
    const col = new THREE.Color();
    const items = [];
    for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, col.setHex(palette[i % palette.length]));
        items.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), size: 0.85 + rand() * 0.3, delay: 0, rest: false });
    }
    let active = false;
    let clock = 0;

    function park() {
        _s.setScalar(0);
        for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _m.compose(_p.set(0, -50, 0), _q.identity(), _s));
        mesh.instanceMatrix.needsUpdate = true;
    }
    park();

    function drop() {
        active = true;
        clock = 0;
        items.forEach((it) => {
            it.p.set(area.x0 + rand() * (area.x1 - area.x0), ceilingY - 0.18 - rand() * 0.08, area.z0 + rand() * (area.z1 - area.z0));
            it.v.set((rand() - 0.5) * 0.3, -0.2 - rand() * 0.3, (rand() - 0.5) * 0.3);
            it.rot.set(rand() * 6, rand() * 6, rand() * 6);
            it.spin.set((rand() - 0.5) * 3, (rand() - 0.5) * 3, (rand() - 0.5) * 3);
            it.delay = rand() * 0.45;
            it.rest = false;
        });
    }

    function update(dt) {
        if (!active) return;
        clock += dt;
        const step = Math.min(dt, 1 / 30);
        let moving = false;
        for (let i = 0; i < count; i++) {
            const it = items[i];
            if (clock >= it.delay && !it.rest) {
                // Latex balloons fall slowly: terminal speed ~1.3 m/s.
                it.v.y -= 2.4 * step;
                it.v.multiplyScalar(1 - 1.6 * step);
                it.p.addScaledVector(it.v, step);
                it.rot.x += it.spin.x * step;
                it.rot.y += it.spin.y * step;
                it.rot.z += it.spin.z * step;
                const r = 0.16 * it.size;
                const onTable = Math.hypot(it.p.x - tableTop.x, it.p.z - tableTop.z) < tableTop.radius;
                const floor = (onTable ? tableTop.y : 0) + r;
                if (it.p.y < floor) {
                    it.p.y = floor;
                    it.v.y = Math.abs(it.v.y) * 0.45;
                    it.v.x *= 0.7;
                    it.v.z *= 0.7;
                    it.spin.multiplyScalar(0.6);
                    if (Math.abs(it.v.y) < 0.06) {
                        it.v.y = 0;
                        if (it.v.lengthSq() < 0.002) it.rest = true;
                    }
                }
                // Walls
                it.p.x = THREE.MathUtils.clamp(it.p.x, area.wx0 + r, area.wx1 - r);
                it.p.z = THREE.MathUtils.clamp(it.p.z, area.wz0 + r, area.wz1 - r);
                moving = true;
            }
            const visible = clock >= it.delay;
            _s.setScalar(visible ? it.size : 0);
            _q.setFromEuler(it.rot);
            mesh.setMatrixAt(i, _m.compose(visible ? it.p : _p.set(0, -50, 0), _q, _s));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (!moving && clock > 1) active = false;
    }

    return { mesh, drop, update, reset: () => { active = false; park(); } };
}

export { balloonGeometry };
