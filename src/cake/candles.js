/**
 * Birthday candles and their flames, shared by the creator preview and the
 * viewer (they used to carry two drifting copies of the same builder and
 * shader).
 *
 * Draw-call budget: every stick of one colour is a single InstancedMesh and
 * all wicks are another, so ten candles cost ~7 calls for the wax instead of
 * 40. Flames stay individual meshes because the viewer raycasts them by name
 * ('flame') and scales each one to zero when it is blown out.
 *
 * Materials and textures come from the kit caches (sharedMaterial /
 * sharedTexture in ./parts.js): one stripe texture + material per wax colour,
 * one halo, one flame material. They survive rebuilds so the programs never
 * recompile; free candles with disposeCakeGroup() from cake-models.js, which
 * disposes only the geometries. (The old note here claimed textures were
 * released with their material; three never does that, which is where the
 * "+2 textures per rebuild" leak came from.)
 */
import * as THREE from 'three';
import { sharedMaterial, sharedTexture } from './parts.js';

export const CANDLE_HEIGHT = 0.44;
const CANDLE_RADIUS = 0.03;
const WICK_TOP = CANDLE_HEIGHT + 0.035;
const FLAME_HEIGHT = 0.17;
const FLAME_RADIUS = 0.034;
const STRIPE_TURNS = 5;

const DEFAULT_CANDLE_COLORS = [0x55ffaa, 0xffbb44, 0xff55aa, 0x44bbff, 0xdd88ff];

/* ------------------------------------------------------------------ *
 * Flame shader
 * ------------------------------------------------------------------ *
 *
 * Why the old flame read as a beige cone: it was alpha-blended with colours
 * capped at 1.0, so it never crossed the bloom threshold (1.35) and ACES
 * tone mapping washed the yellow out to grey-beige. This one is additive and
 * HDR-bright in the core (up to ~5x), so bloom picks it up and the tone
 * mapper rolls the core to white-hot while the rim stays orange.
 *
 * The "core vs rim" split uses view-facing (a fresnel term) rather than
 * object-space radius, so the flame looks like a glowing volume from every
 * angle instead of a painted cone.
 */
const flameVertexShader = /* glsl */ `
    uniform float uTime;
    varying float vH;
    varying float vPhase;
    varying vec3 vNormalV;
    varying vec3 vViewV;

    void main() {
        vec3 p = position;
        vH = clamp(p.y / ${FLAME_HEIGHT.toFixed(3)}, 0.0, 1.0);

        // Per-candle phase from the flame's world origin, so neighbouring
        // flames never flicker in lockstep (they share one material).
        vec3 origin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float ph = origin.x * 13.1 + origin.z * 7.7;
        vPhase = ph;

        // Height pulse + a sway that grows toward the tip (the base is
        // anchored to the wick, only the plume moves).
        p.y *= 1.0 + 0.07 * sin(uTime * 11.0 + ph) + 0.04 * sin(uTime * 23.0 + ph * 1.3);
        float bend = vH * vH;
        p.x += (sin(uTime * 3.1 + ph) * 0.6 + sin(uTime * 7.3 + ph * 2.1) * 0.4) * 0.018 * bend;
        p.z += (cos(uTime * 2.7 + ph * 1.7) * 0.6 + sin(uTime * 6.1 + ph) * 0.4) * 0.014 * bend;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vViewV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
    }
`;

const flameFragmentShader = /* glsl */ `
    uniform float uTime;
    uniform float uGain;
    uniform float uAlphaBoost;
    uniform float uCore;
    uniform float uSat;
    varying float vH;
    varying float vPhase;
    varying vec3 vNormalV;
    varying vec3 vViewV;

    void main() {
        float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
        float core = pow(facing, 3.0);

        vec3 blue   = vec3(0.18, 0.36, 1.00);
        vec3 orange = vec3(1.00, 0.36, 0.05);
        vec3 yellow = vec3(1.00, 0.76, 0.30);
        vec3 white  = vec3(1.00, 0.95, 0.84);

        // Orange rim, yellow body, white-hot core in the lower two thirds.
        vec3 col = mix(orange, yellow, smoothstep(0.1, 0.7, facing));
        col = mix(col, white, core * smoothstep(0.95, 0.25, vH) * uCore);

        // Thin blue combustion root just above the wick.
        float root = 1.0 - smoothstep(0.02, 0.24, vH);
        col = mix(col, blue, root * (1.0 - core * 0.5) * 0.85);
        // Pre-saturate: ACES rolls bright colours toward white, which is
        // the right read on black but turned the flame beige on paper.
        col = max(mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, uSat), 0.0);

        float intensity = mix(1.3, 5.0, core) * (1.0 - root * 0.65) * uGain;
        intensity *= 0.94 + 0.06 * sin(uTime * 31.0 + vPhase);

        // Soft silhouette, fading tip, faint root.
        float alpha = smoothstep(0.0, 0.45, facing) * (1.0 - smoothstep(0.72, 1.0, vH));
        alpha = min(1.0, alpha * mix(1.0, 0.4, root) * uAlphaBoost);

        gl_FragColor = vec4(col * intensity, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

/**
 * Two looks share one program (blending and uniform values are GL state, not
 * part of the program key), so switching backdrops never recompiles:
 *  - dark: additive and HDR-hot; bloom carries the glow (night backdrop).
 *  - light: on a pale backdrop additive light has nothing to add to and the
 *    flame vanished into the paper. It is alpha-blended instead, with less
 *    gain and a smaller white core so ACES keeps the body a saturated
 *    yellow-orange (a candle in daylight), a denser silhouette, and the halo
 *    becomes a warm amber haze.
 */
export const CANDLE_LOOKS = Object.freeze({
    dark: {
        flame: { gain: 1, alphaBoost: 1, core: 1, sat: 1, blending: THREE.AdditiveBlending },
        halo: { color: 0xffc27a, opacity: 0.55, blending: THREE.AdditiveBlending, scale: 0.3 }
    },
    light: {
        flame: { gain: 0.85, alphaBoost: 1.5, core: 0.5, sat: 2.1, blending: THREE.NormalBlending },
        halo: { color: 0xffa21f, opacity: 0.6, blending: THREE.NormalBlending, scale: 0.42 }
    }
});

/**
 * The flame material is shared by every candle of every build with the same
 * look (one uTime uniform drives them all), so a rebuild never recompiles
 * the flame shader.
 */
export function createFlameMaterial(look = 'dark') {
    const { gain, alphaBoost, core, sat, blending } = (CANDLE_LOOKS[look] || CANDLE_LOOKS.dark).flame;
    return sharedMaterial(THREE.ShaderMaterial, {
        vertexShader: flameVertexShader,
        fragmentShader: flameFragmentShader,
        uniforms: { uTime: { value: 0 }, uGain: { value: gain }, uAlphaBoost: { value: alphaBoost }, uCore: { value: core }, uSat: { value: sat } },
        transparent: true,
        depthWrite: false,
        blending
    });
}

/** Teardrop lathe: round belly low down, long tapering plume, origin at the wick. */
function createFlameGeometry() {
    const pts = [];
    const STEPS = 16;
    // sqrt(s) * (1 - s)^1.3 peaks at s ≈ 0.28 with value ≈ 0.345
    for (let k = 0; k <= STEPS; k++) {
        const s = k / STEPS;
        const r = (FLAME_RADIUS / 0.345) * Math.sqrt(s) * Math.pow(1 - s, 1.3);
        pts.push(new THREE.Vector2(r, s * FLAME_HEIGHT));
    }
    return new THREE.LatheGeometry(pts, 18);
}

/** Radial glow for the halo sprite: the soft light a flame throws on the air. */
function createHaloTexture() {
    return sharedTexture('candle-halo', paintHaloTexture);
}

function paintHaloTexture() {
    const SIZE = 64;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
    g.addColorStop(0, 'rgba(255,220,160,1)');
    g.addColorStop(0.25, 'rgba(255,170,80,0.45)');
    g.addColorStop(0.6, 'rgba(255,120,40,0.1)');
    g.addColorStop(1, 'rgba(255,100,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/* ------------------------------------------------------------------ *
 * Candle stick
 * ------------------------------------------------------------------ */

/**
 * Slim, slightly tapered stick with a melted lip, a shallow wax pool and a
 * few drips running down. One geometry for every candle; each instance gets
 * its own yaw so the drips never line up.
 */
function createCandleGeometry() {
    const RADIAL = 24;
    const HEIGHT_SEGS = 22;
    const geo = new THREE.CylinderGeometry(CANDLE_RADIUS, CANDLE_RADIUS * 1.08, CANDLE_HEIGHT, RADIAL, HEIGHT_SEGS);
    geo.translate(0, CANDLE_HEIGHT / 2, 0);

    // [angle, length, angular width] — uneven on purpose
    const drips = [[0.4, 0.12, 0.26], [2.1, 0.06, 0.22], [3.4, 0.16, 0.24], [5.0, 0.045, 0.3]];

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const r = Math.hypot(x, z);
        if (r < 1e-6) {
            // Cap centre: sink it into a shallow melt pool around the wick.
            if (y > CANDLE_HEIGHT - 1e-4) pos.setY(i, y - 0.008);
            continue;
        }

        const depth = CANDLE_HEIGHT - y;
        const theta = Math.atan2(z, x);
        let bulge = 0.004 * (1 - THREE.MathUtils.smoothstep(depth, 0, 0.02));
        for (const [a, len, w] of drips) {
            let d = Math.abs(theta - a) % (Math.PI * 2);
            if (d > Math.PI) d = Math.PI * 2 - d;
            const across = Math.exp(-Math.pow(d / w, 2) * 3);
            // Rounded drip tip: fades out over its last quarter.
            const along = 1 - THREE.MathUtils.smoothstep(depth, len * 0.72, len);
            bulge += across * along * 0.0045;
        }
        const s = (r + bulge) / r;
        pos.setXYZ(i, x * s, y, z * s);
    }

    // Caps sample a stripe-free spot of the spiral texture, so the top reads
    // as plain wax instead of a smeared stripe.
    const torsoCount = (RADIAL + 1) * (HEIGHT_SEGS + 1);
    const capU = (((0.65 - 0.5 * STRIPE_TURNS) % 1) + 1) % 1;
    const uv = geo.attributes.uv;
    for (let i = torsoCount; i < uv.count; i++) uv.setXY(i, capU, 0.5);

    geo.computeVertexNormals();
    return geo;
}

/** Wax colour with a cream spiral stripe — the classic birthday-candle twist. */
function createCandleStripeTexture(color) {
    const hex = new THREE.Color(color).getHexString();
    return sharedTexture(`candle-stripe|${hex}`, () => paintCandleStripeTexture(color));
}

function paintCandleStripeTexture(color) {
    const W = 64;
    const H = 128;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);

    const base = new THREE.Color(color);
    const stripe = new THREE.Color(0xfff6ea);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const t = ((x / W + (y / H) * STRIPE_TURNS) % 1 + 1) % 1;
            // Anti-aliased band edges
            const m = THREE.MathUtils.smoothstep(t, 0.0, 0.05) * (1 - THREE.MathUtils.smoothstep(t, 0.28, 0.33));
            const k = (y * W + x) * 4;
            img.data[k] = Math.round((base.r + (stripe.r - base.r) * m) * 255);
            img.data[k + 1] = Math.round((base.g + (stripe.g - base.g) * m) * 255);
            img.data[k + 2] = Math.round((base.b + (stripe.b - base.b) * m) * 255);
            img.data[k + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
}

/* ------------------------------------------------------------------ *
 * Builder
 * ------------------------------------------------------------------ */

/**
 * Adds `count` candles to `parent`, ringed per the cake layout.
 *
 * @param {THREE.Object3D} parent
 * @param {object} layout  { candlePlacerRadius, candleBaseY, isHeartShape }
 * @param {object} opts    { count, candleColor, look } — candleColor '' cycles the
 *                         palette; look is 'dark' or 'light' (see CANDLE_LOOKS)
 * @returns {{ candles: {group: THREE.Group, flame: THREE.Mesh}[], flameMaterial: THREE.ShaderMaterial, center: THREE.Vector3 }}
 */
export function buildCandles(parent, layout, { count = 5, candleColor = '', look = 'dark' } = {}) {
    const { candlePlacerRadius, candleBaseY, isHeartShape } = layout;

    const candleGeo = createCandleGeometry();
    const wickGeo = new THREE.CylinderGeometry(0.0045, 0.0055, 0.05, 6);
    wickGeo.translate(0, CANDLE_HEIGHT + 0.01, 0);
    const flameGeo = createFlameGeometry();
    const flameMaterial = createFlameMaterial(look);
    const halo = (CANDLE_LOOKS[look] || CANDLE_LOOKS.dark).halo;
    const haloMat = sharedMaterial(THREE.SpriteMaterial, {
        map: createHaloTexture(),
        color: halo.color,
        transparent: true,
        opacity: halo.opacity,
        depthWrite: false,
        blending: halo.blending
    });

    // Lay the candles out first, then batch the sticks by colour.
    const candles = [];
    const byColor = new Map();
    const center = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        let cX = Math.cos(angle) * candlePlacerRadius;
        let cZ = Math.sin(angle) * candlePlacerRadius;
        if (isHeartShape) cZ = (Math.sin(angle) * 0.85 - 0.2) * candlePlacerRadius;

        const group = new THREE.Group();
        group.position.set(cX, candleBaseY, cZ);
        // Hand-placed candles are never perfectly plumb.
        group.rotation.set(Math.cos(i * 1.7) * 0.025, i * 1.37, Math.sin(i * 2.4) * 0.03);
        group.updateMatrix();

        const flame = new THREE.Mesh(flameGeo, flameMaterial);
        flame.name = 'flame';
        flame.position.y = WICK_TOP - 0.012;
        const haloSprite = new THREE.Sprite(haloMat);
        haloSprite.position.y = FLAME_HEIGHT * 0.42;
        haloSprite.scale.setScalar(halo.scale);
        flame.add(haloSprite);
        group.add(flame);

        parent.add(group);
        candles.push({ group, flame });
        center.add(group.position);

        const color = candleColor || DEFAULT_CANDLE_COLORS[i % DEFAULT_CANDLE_COLORS.length];
        const key = new THREE.Color(color).getHexString();
        if (!byColor.has(key)) byColor.set(key, { color, matrices: [] });
        byColor.get(key).matrices.push(group.matrix.clone());
    }
    if (count > 0) center.divideScalar(count);

    // The parent's traverse-dispose frees shared geometry once per mesh;
    // dispose() is idempotent, so that is safe.
    byColor.forEach(({ color, matrices }) => {
        const mat = sharedMaterial(THREE.MeshStandardMaterial, {
            map: createCandleStripeTexture(color),
            roughness: 0.5,
            metalness: 0
        });
        const sticks = new THREE.InstancedMesh(candleGeo, mat, matrices.length);
        matrices.forEach((m, k) => sticks.setMatrixAt(k, m));
        sticks.castShadow = true;
        sticks.receiveShadow = true;
        parent.add(sticks);
    });

    const wicks = new THREE.InstancedMesh(
        wickGeo,
        sharedMaterial(THREE.MeshStandardMaterial, { color: 0x1a1410, roughness: 0.9 }),
        candles.length
    );
    candles.forEach((c, k) => wicks.setMatrixAt(k, c.group.matrix));
    parent.add(wicks);

    return { candles, flameMaterial, center };
}
