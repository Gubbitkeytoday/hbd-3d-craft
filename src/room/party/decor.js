/**
 * Procedural party dressing (metres, inside the room group):
 *   fairy lights  catenary wires (1 merged mesh) + instanced bulbs whose
 *                 HDR colour cascades on with the switch and twinkles
 *   bunting       paper pennants on a string, one InstancedMesh
 *   name sign     warm LED "neon" with the recipient's name, drawn by the
 *                 browser in the page's own Noto Sans Thai (correct Thai
 *                 shaping for free, no font file to ship)
 *   gifts         wrapped boxes (instanced box + ribbons + bows)
 *   party hats    instanced cones + pom-poms
 * Everything here is a handful of draw calls and shares programs.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Points on a sagging string between a and b (sag metres at the middle). */
export function catenary(a, b, sag, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        p.y -= sag * 4 * t * (1 - t);
        pts.push(p);
    }
    return pts;
}

/* ------------------------------------------------------------------ */
/* Fairy lights                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {Array<{points:THREE.Vector3[], bulbs:number}>} strings
 * @param {THREE.Material} wireMaterial shared basic material
 */
export function createFairyLights(strings, { wireMaterial, color = 0xffc98a, rand }) {
    const wires = [];
    const bulbs = [];
    strings.forEach((s, si) => {
        const curve = new THREE.CatmullRomCurve3(s.points);
        wires.push(new THREE.TubeGeometry(curve, Math.max(8, s.points.length * 3), 0.0016, 4, false));
        for (let i = 0; i < s.bulbs; i++) {
            const t = (i + 0.5) / s.bulbs;
            const p = curve.getPointAt(t);
            p.y -= 0.012;
            bulbs.push({ p, order: si * 0.07 + t, phase: rand() * Math.PI * 2, speed: 0.6 + rand() * 1.4 });
        }
    });
    const wire = new THREE.Mesh(mergeGeometries(wires, false), wireMaterial);
    wires.forEach((g) => g.dispose());
    wire.name = 'fairy-wire';

    const bulbGeo = new THREE.SphereGeometry(0.0085, 8, 6);
    bulbGeo.scale(1, 1.35, 1);
    // Unlit and HDR: the bloom pass turns > 1 into the halo.
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
    const mesh = new THREE.InstancedMesh(bulbGeo, bulbMat, bulbs.length);
    mesh.name = 'fairy-bulbs';
    mesh.frustumCulled = false;
    bulbs.forEach((b, i) => mesh.setMatrixAt(i, _m.compose(b.p, _q.identity(), _s.setScalar(1))));
    const base = new THREE.Color(color);
    const off = new THREE.Color(0x0c0a0a); // unlit glass, no warm dots
    let lit = 0;
    let dim = 0;

    function update(time, reduceMotion) {
        const n = bulbs.length;
        for (let i = 0; i < n; i++) {
            const b = bulbs[i];
            // Cascade: each bulb comes on a little after the previous one.
            const on = THREE.MathUtils.clamp((lit * 1.25 - b.order * 0.25) * 4, 0, 1);
            const tw = reduceMotion ? 1 : 0.78 + 0.22 * Math.sin(time * b.speed * 2.2 + b.phase);
            const k = on * tw * (5.2 - dim * 1.8);
            // Off bulbs keep a dull glass colour; lit ones are HDR (> 1).
            if (on > 0) _c.copy(base).multiplyScalar(k);
            else _c.copy(off);
            mesh.setColorAt(i, _c);
        }
        mesh.instanceColor.needsUpdate = true;
    }
    mesh.setColorAt(0, off);
    update(0, true);

    return {
        group: new THREE.Group().add(wire, mesh),
        setLit(t) { lit = t; },
        setDim(t) { dim = t; },
        update,
        dispose() { wire.geometry.dispose(); bulbGeo.dispose(); bulbMat.dispose(); }
    };
}

/* ------------------------------------------------------------------ */
/* Bunting                                                             */
/* ------------------------------------------------------------------ */

function paperTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 64, 64);
    // Faint fibres and a printed dot pattern.
    for (let i = 0; i < 260; i++) {
        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
        ctx.fillRect(Math.random() * 64, Math.random() * 64, 1, 3);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let y = 8; y < 64; y += 16) {
        for (let x = (y / 16) % 2 ? 8 : 0; x < 64; x += 16) {
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

export function createBunting(runs, { palette, stringMaterial }) {
    const flagGeo = new THREE.BufferGeometry();
    // Pennant: a triangle hanging from its top edge, slightly folded.
    flagGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        -0.07, 0, 0, 0.07, 0, 0, 0, -0.15, 0.004,
        0.07, 0, 0, -0.07, 0, 0, 0, -0.15, 0.004
    ], 3));
    flagGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0.5, 0, 1, 1, 0, 1, 0.5, 0], 2));
    flagGeo.computeVertexNormals();
    const tex = paperTexture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, side: THREE.DoubleSide });
    const flags = [];
    const strings = [];
    runs.forEach((r) => {
        const pts = catenary(r.a, r.b, r.sag, 24);
        const curve = new THREE.CatmullRomCurve3(pts);
        strings.push(new THREE.TubeGeometry(curve, 48, 0.0018, 4, false));
        const n = Math.max(2, Math.round(curve.getLength() / 0.19));
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n;
            const p = curve.getPointAt(t);
            const tan = curve.getTangentAt(t);
            flags.push({ p, yaw: Math.atan2(-tan.z, tan.x), phase: i * 0.7 + r.a.x });
        }
    });
    const mesh = new THREE.InstancedMesh(flagGeo, mat, flags.length);
    mesh.name = 'bunting';
    flags.forEach((f, i) => mesh.setColorAt(i, _c.setHex(palette[i % palette.length])));
    const string = new THREE.Mesh(mergeGeometries(strings, false), stringMaterial);
    strings.forEach((g) => g.dispose());
    const e = new THREE.Euler();
    function update(time, amount) {
        flags.forEach((f, i) => {
            e.set(Math.sin(time * 1.3 + f.phase) * 0.12 * amount, f.yaw, 0);
            mesh.setMatrixAt(i, _m.compose(f.p, _q.setFromEuler(e), _s.setScalar(1)));
        });
        mesh.instanceMatrix.needsUpdate = true;
    }
    update(0, 0);
    return {
        group: new THREE.Group().add(mesh, string),
        materials: [mat],
        update,
        dispose() { flagGeo.dispose(); mat.dispose(); tex.dispose(); string.geometry.dispose(); }
    };
}

/* ------------------------------------------------------------------ */
/* Name sign (LED neon on clear acrylic)                               */
/* ------------------------------------------------------------------ */

/**
 * The recipient's name as an LED neon sign on a clear acrylic board with
 * four standoffs, throwing a soft coloured glow on the wall behind it.
 * Three draw calls: board (standard, transparent), tube text (unlit HDR,
 * blooms), wall glow (additive).
 * @returns {{ mesh, width, height, setLevel(k), dispose() }}
 */
export function createNameSign(name, { color = 0xffb3cf, height = 0.4, maxWidth = 1.6 }) {
    const text = String(name || '').trim().slice(0, 24);
    if (!text) return null;
    const H = 200;
    const font = `600 ${Math.round(H * 0.58)}px "Noto Sans Thai", "Outfit", sans-serif`;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const tw = Math.ceil(probe.measureText(text).width);
    const W = Math.min(2048, tw + H * 0.9);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Neon tube: soft outer glow, the coloured tube, a hot white core.
    ctx.shadowColor = 'rgba(255,255,255,0.95)';
    ctx.shadowBlur = H * 0.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = H * 0.06;
    ctx.strokeText(text, W / 2, H * 0.54);
    ctx.shadowBlur = H * 0.05;
    ctx.fillStyle = '#fff';
    ctx.fillText(text, W / 2, H * 0.54);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    let w = height * (W / H);
    let h = height;
    if (w > maxWidth) { h *= maxWidth / w; w = maxWidth; }
    const base = new THREE.Color(color);
    const group = new THREE.Group();
    group.name = 'name-sign';

    const tubeMat = new THREE.MeshBasicMaterial({ map: tex, color: base.clone(), transparent: true, depthWrite: false });
    const tube = new THREE.Mesh(new THREE.PlaneGeometry(w, h), tubeMat);
    tube.position.z = 0.022;
    tube.renderOrder = 3;

    // Acrylic board: rounded rectangle, 1.15x the text, faint edge sheen.
    const bw = w * 1.08 + h * 0.2;
    const bh = h * 1.15;
    const r = bh * 0.18;
    const shape = new THREE.Shape();
    shape.moveTo(-bw / 2 + r, -bh / 2);
    shape.lineTo(bw / 2 - r, -bh / 2);
    shape.quadraticCurveTo(bw / 2, -bh / 2, bw / 2, -bh / 2 + r);
    shape.lineTo(bw / 2, bh / 2 - r);
    shape.quadraticCurveTo(bw / 2, bh / 2, bw / 2 - r, bh / 2);
    shape.lineTo(-bw / 2 + r, bh / 2);
    shape.quadraticCurveTo(-bw / 2, bh / 2, -bw / 2, bh / 2 - r);
    shape.lineTo(-bw / 2, -bh / 2 + r);
    shape.quadraticCurveTo(-bw / 2, -bh / 2, -bw / 2 + r, -bh / 2);
    const boardGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.006, bevelEnabled: false, curveSegments: 6 });
    const boardMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false });
    const board = new THREE.Mesh(boardGeo, boardMat);
    board.position.z = 0.012;
    board.renderOrder = 2;

    // Standoffs (brushed metal caps) at the corners.
    const capGeo = new THREE.CylinderGeometry(0.009, 0.009, 0.024, 12).rotateX(Math.PI / 2);
    const capMat = new THREE.MeshStandardMaterial({ color: 0xc9c6c0, roughness: 0.3, metalness: 1 });
    const caps = new THREE.InstancedMesh(capGeo, capMat, 4);
    const m = new THREE.Matrix4();
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => {
        caps.setMatrixAt(i, m.makeTranslation(sx * (bw / 2 - r * 0.6), sy * (bh / 2 - r * 0.6), 0.012));
    });

    // Coloured light on the wall behind (additive, so it never darkens).
    const glowTex = glowTexture();
    const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, color: base.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(bw * 1.7, bh * 2.4), glowMat);
    glow.position.z = 0.002;
    glow.renderOrder = 1;

    group.add(glow, board, caps, tube);
    return {
        mesh: group, width: w, height: h, boardWidth: bw, materials: [boardMat, capMat],
        /** k = 0: off (tube barely visible, no glow); ~3: full neon. */
        setLevel(k) {
            k = Math.max(0, k);
            tubeMat.color.copy(base).multiplyScalar(k > 0.001 ? 0.02 + k : 0.02);
            tubeMat.opacity = Math.min(1, 0.25 + k);
            glowMat.color.copy(base).multiplyScalar(0.35 * Math.min(k, 3) / 3);
        },
        dispose() {
            tex.dispose(); glowTex.dispose();
            [tubeMat, boardMat, capMat, glowMat].forEach((x) => x.dispose());
            [tube.geometry, boardGeo, capGeo, glow.geometry].forEach((g) => g.dispose());
        }
    };
}

function glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/* ------------------------------------------------------------------ */
/* Gifts                                                               */
/* ------------------------------------------------------------------ */

function wrapTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 128, 128);
    // White-on-white print: instanceColor tints the paper, the print stays lighter.
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.globalAlpha = 1;
    const g = ctx.createLinearGradient(0, 0, 128, 128);
    g.addColorStop(0, '#d9d9d9');
    g.addColorStop(1, '#cfcfcf');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#ffffff';
    for (let y = 0; y < 128; y += 32) {
        for (let x = (y / 32) % 2 ? 16 : 0; x < 128; x += 32) {
            ctx.beginPath();
            ctx.arc(x + 8, y + 8, 5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

/**
 * @param {Array<{pos:number[], size:number[], yaw:number, paper:number, ribbon:number}>} list
 */
export function createGifts(list) {
    const boxGeo = new RoundedBoxGeometry(1, 1, 1, 2, 0.02);
    const tex = wrapTexture();
    tex.repeat.set(2, 2);
    const boxMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0 });
    const boxes = new THREE.InstancedMesh(boxGeo, boxMat, list.length);
    boxes.name = 'gift-boxes';

    const ribbonGeo = new THREE.BoxGeometry(1, 1, 1);
    const ribbonMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.35 });
    const ribbons = new THREE.InstancedMesh(ribbonGeo, ribbonMat, list.length * 2);
    ribbons.name = 'gift-ribbons';

    const bowGeo = new THREE.TorusGeometry(0.5, 0.16, 6, 16);
    bowGeo.scale(1, 0.62, 0.6);
    const bows = new THREE.InstancedMesh(bowGeo, ribbonMat, list.length * 2);
    bows.name = 'gift-bows';

    const e = new THREE.Euler();
    list.forEach((g, i) => {
        const [w, h, d] = g.size;
        const q = _q.setFromEuler(e.set(0, g.yaw, 0)).clone();
        const center = new THREE.Vector3(g.pos[0], g.pos[1] + h / 2, g.pos[2]);
        boxes.setMatrixAt(i, _m.compose(center, q, _s.set(w, h, d)));
        boxes.setColorAt(i, _c.setHex(g.paper));
        const rw = Math.min(w, d) * 0.14;
        ribbons.setMatrixAt(i * 2, _m.compose(center, q, _s.set(w + 0.004, h + 0.004, rw)));
        ribbons.setMatrixAt(i * 2 + 1, _m.compose(center, q, _s.set(rw, h + 0.004, d + 0.004)));
        ribbons.setColorAt(i * 2, _c.setHex(g.ribbon));
        ribbons.setColorAt(i * 2 + 1, _c.setHex(g.ribbon));
        const bs = Math.min(w, d) * 0.22;
        for (let k = 0; k < 2; k++) {
            const bq = q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, k ? 0.6 : -0.6, k ? 0.5 : -0.5)));
            const off = new THREE.Vector3((k ? 1 : -1) * bs * 0.45, 0, 0).applyQuaternion(q);
            bows.setMatrixAt(i * 2 + k, _m.compose(new THREE.Vector3(center.x + off.x, g.pos[1] + h + bs * 0.28, center.z + off.z), bq, _s.setScalar(bs)));
            bows.setColorAt(i * 2 + k, _c.setHex(g.ribbon));
        }
    });
    return {
        group: new THREE.Group().add(boxes, ribbons, bows),
        materials: [boxMat, ribbonMat],
        dispose() { boxGeo.dispose(); ribbonGeo.dispose(); bowGeo.dispose(); boxMat.dispose(); ribbonMat.dispose(); tex.dispose(); }
    };
}

/* ------------------------------------------------------------------ */
/* Party hats                                                          */
/* ------------------------------------------------------------------ */

function stripeTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#c9c9c9';
    for (let x = -64; x < 128; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x + 8, 0); ctx.lineTo(x + 8 + 32, 64); ctx.lineTo(x + 32, 64);
        ctx.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 1);
    return t;
}

export function createHats(list, { pomMaterial }) {
    const cone = new THREE.ConeGeometry(0.055, 0.16, 20, 1, true);
    cone.translate(0, 0.08, 0);
    const tex = stripeTexture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.15, side: THREE.DoubleSide });
    const hats = new THREE.InstancedMesh(cone, mat, list.length);
    hats.name = 'party-hats';
    const pom = new THREE.IcosahedronGeometry(0.016, 1);
    const poms = new THREE.InstancedMesh(pom, pomMaterial, list.length);
    const e = new THREE.Euler();
    list.forEach((h, i) => {
        const q = _q.setFromEuler(e.set(h.tilt || 0, h.yaw || 0, h.roll || 0)).clone();
        const p = new THREE.Vector3(...h.pos);
        hats.setMatrixAt(i, _m.compose(p, q, _s.setScalar(1)));
        hats.setColorAt(i, _c.setHex(h.color));
        const tip = new THREE.Vector3(0, 0.16, 0).applyQuaternion(q).add(p);
        poms.setMatrixAt(i, _m.compose(tip, q, _s.setScalar(1)));
        poms.setColorAt(i, _c.setHex(h.pom));
    });
    return {
        group: new THREE.Group().add(hats, poms),
        materials: [mat],
        dispose() { cone.dispose(); pom.dispose(); mat.dispose(); tex.dispose(); }
    };
}
