/**
 * The surprise-party room ('party' backdrop): a cozy Bangkok condo living
 * room at night, decorated by friends. Contract (room-brief.md):
 *
 *   const room = await createPartyRoom({ renderer, scene, camera, quality, config, onProgress, signal });
 *   cakeGroup -> room.cakeAnchor (room.seatCake(cakeGroup) rests any model on the table)
 *   room.setLights(0..1)  0 dark (city window, switch LED, candle) .. 1 party lights
 *   room.setDim(0..1)     singing dim over the lit room
 *   room.update(dt, t)    every frame
 *
 * How it stays hitch-free: the light rig is constant (rig.js), the static
 * room's light is two baked lightmaps blended by uniforms (materials.js),
 * props only animate matrices/colours, and everything that changes between
 * the dark and lit states is a uniform or a light intensity. Programs are
 * the same before and after the reveal (verified: renderer.info.programs).
 *
 * Streaming: the procedural greybox + party kit are built first (a few ms,
 * yielding between steps); the baked room (public/room/room.json) replaces
 * the greybox once it has downloaded. If it fails the greybox stays.
 *
 * Extras beyond the brief contract, all optional for the caller:
 *   room.lights { candle, pendant, hemi }   the constant rig (world space)
 *   room.setCandles(level)                  0..1 flames burning (default 0 = off)
 *   room.setCandleLight(on)                 shorthand for setCandles(on ? 1 : 0)
 *   room.trackEnvMaterials(root, base)      scale root's envMapIntensity with the lights
 *   room.envMap                             PMREM capture of the lit room (also scene.environment)
 *   room.exposure { dark, lit }             suggested toneMappingExposure per state
 */
import * as THREE from 'three';
import { precompileScene, attachStudioEnvironmentAsync } from '../render-quality.js';
import { ROOM, ROOM_SCALE, TABLE, CAKE_SPOT, LETTERS, SIGN, shotsWorld } from './layout.js';
import { createRig } from './rig.js';
import { createBakeUniforms } from './materials.js';
import { createCity, createSwitch, createGreybox } from './shell.js';
import { balloonGeometry, createLatexMaterial, createBalloonClusters, createBalloonDrop } from './party/balloons.js';
import { buildLetterRow, createFoilMaterial } from './party/foil-letters.js';
import { createFairyLights, createBunting, createNameSign, createGifts, createHats, catenary } from './party/decor.js';
import { createConfetti } from './party/confetti.js';
import { loadBakedRoom, roomAssetUrl } from './loader.js';
import { captureRoomEnvironment } from './env-capture.js';

/** Pre-rendered Cycles stills for the gate background / no-WebGL fallback. */
export function getPartyPoster(state = 'dark') {
    return roomAssetUrl(state === 'lit' ? 'poster-lit.webp' : 'poster-dark.webp');
}

/* ------------------------------------------------------------------ */
/* Theme palettes (research-surprise 4.3)                              */
/* ------------------------------------------------------------------ */

const PALETTES = {
    'neon-rose': { balloons: [0xff2d78, 0xf7f1ee, 0xf29bb2, 0xd81b60], sign: 0xff7fb0, paper: [0xff4f8b, 0xfff3f6, 0xf7b7c9, 0x6a2c91] },
    'midnight-gold': { balloons: [0x1b1a20, 0xd9b35b, 0xf1dfc0, 0x2b2a31], sign: 0xffe0a8, paper: [0x1b1a20, 0xd9b35b, 0xf1dfc0, 0x7a6030] },
    'pastel-mint': { balloons: [0x9fe3c9, 0xfff1d8, 0xffc4a8, 0x7fd1b9], sign: 0xa8ffe0, paper: [0x9fe3c9, 0xffc4a8, 0xfff1d8, 0x86b6f0] },
    'lavender-dream': { balloons: [0xc7a6f0, 0xf6f1fb, 0x9b7fe0, 0xe3d1ff], sign: 0xd6b0ff, paper: [0xc7a6f0, 0x9b7fe0, 0xf6f1fb, 0x6b4fc0] },
    'sakura-blossom': { balloons: [0xffc3d3, 0xfff6f8, 0xff8fab, 0xf7a6bd], sign: 0xffb3c8, paper: [0xffc3d3, 0xff8fab, 0xfff6f8, 0xe86f8e] },
    'cyber-retro': { balloons: [0x2de2e6, 0xff3cac, 0x7b2ff7, 0xf7f7ff], sign: 0x5ff5ff, paper: [0x2de2e6, 0xff3cac, 0x7b2ff7, 0xffd23f] },
    'forest-moss': { balloons: [0x9cb89a, 0x6b7a3a, 0xc9a57a, 0xf0ead8], sign: 0xffe6b0, paper: [0x6b7a3a, 0x9cb89a, 0xc9a57a, 0xf0ead8] },
    'cosmic-nebula': { balloons: [0x1f2a6b, 0x7a4fd6, 0xd8dde6, 0x3b3f9a], sign: 0xb49bff, paper: [0x1f2a6b, 0x7a4fd6, 0xd8dde6, 0x2de2e6] },
    'choco-monarch': { balloons: [0x5a3522, 0xc98a4b, 0xf3e2c6, 0x8a5a36], sign: 0xffd9a0, paper: [0x5a3522, 0xc98a4b, 0xf3e2c6, 0xa33b2e] }
};

function paletteFor(theme) {
    return PALETTES[theme] || PALETTES['neon-rose'];
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
}

function yieldToMain() {
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * What the frame shows without a card photo: a printed greeting card on
 * cream stock (theme ink), not a blurred "failed image". Name and sender are
 * drawn by the browser in the page's Noto Sans Thai.
 */
function paintPhotoPlaceholder(colors, name, sender) {
    const W = 512;
    const H = 640;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const hex = (v) => '#' + new THREE.Color(v).getHexString();
    // Ink: the darkest of the theme's paper colours, so it reads on cream.
    const ink = [...colors].sort((a, b) => new THREE.Color(a).getHSL({}).l - new THREE.Color(b).getHSL({}).l)[0];
    const accent = colors[0];
    ctx.fillStyle = '#f5eee3';
    ctx.fillRect(0, 0, W, H);
    // Paper tooth
    for (let i = 0; i < 1400; i++) {
        ctx.fillStyle = `rgba(90,70,50,${Math.random() * 0.05})`;
        ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
    }
    ctx.strokeStyle = hex(accent);
    ctx.lineWidth = 6;
    // The frame's mat hides ~12 % at each edge: keep everything inside.
    ctx.strokeRect(70, 80, W - 140, H - 160);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(84, 94, W - 168, H - 188);
    // Confetti dots
    for (let i = 0; i < 38; i++) {
        ctx.fillStyle = hex(colors[i % colors.length]);
        ctx.globalAlpha = 0.75;
        const x = 110 + Math.random() * (W - 220);
        const y = Math.random() < 0.5 ? 120 + Math.random() * 70 : H - 190 + Math.random() * 70;
        ctx.beginPath();
        ctx.arc(x, y, 3 + Math.random() * 5, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = hex(ink);
    ctx.font = '600 26px "Outfit", sans-serif';
    ctx.fillText('HAPPY BIRTHDAY', W / 2, 232);
    const who = String(name || '').trim().slice(0, 18);
    const big = who || 'HBD';
    let size = 120;
    ctx.font = `700 ${size}px "Noto Sans Thai", "Outfit", sans-serif`;
    while (ctx.measureText(big).width > W - 210 && size > 40) {
        size -= 6;
        ctx.font = `700 ${size}px "Noto Sans Thai", "Outfit", sans-serif`;
    }
    ctx.fillStyle = hex(accent);
    ctx.fillText(big, W / 2, 322);
    const from = String(sender || '').trim().slice(0, 24);
    if (from) {
        ctx.fillStyle = hex(ink);
        ctx.font = '500 30px "Noto Sans Thai", "Outfit", sans-serif';
        ctx.fillText(`จาก ${from}`, W / 2, 432);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
}

/** Dark-state lift of the DARK lightmap (see applyState). */
const DARK_GAIN = 1.15;
/** Party-bake exposure match (the greige feature wall darkened the lit frame). */
const PARTY_GAIN = 1.35;

/* ------------------------------------------------------------------ */

export async function createPartyRoom({ renderer, scene, camera, quality = 1, config = {}, onProgress, signal, bloom = null } = {}) {
    let q = THREE.MathUtils.clamp(Math.round(quality), 0, 2);
    const S = ROOM_SCALE;
    const disposers = [];
    let disposed = false;
    const abortIfNeeded = () => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    };
    // Dev: [tag, time] marks, matched against long tasks by the perf
    // scripts to keep every task behind the gate short.
    const timeline = [];
    const mark = (tag) => { if (import.meta.env.DEV) timeline.push([tag, Math.round(performance.now())]); };
    const step = async (p, tag = '') => {
        mark(tag || String(p));
        onProgress?.(p);
        await yieldToMain();
        abortIfNeeded();
    };
    const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pal = paletteFor(config.theme);
    const rand = mulberry32(hashString(`${config.recipientName || ''}|${config.theme || ''}`));

    const group = new THREE.Group();
    group.name = 'party-room';
    // Everything authored in metres lives in `room`, scaled to cake units.
    const room = new THREE.Group();
    room.name = 'party-room-metres';
    room.scale.setScalar(S);
    group.add(room);
    scene.add(group);

    const rig = createRig({ quality: q, shadows: renderer.shadowMap.enabled });
    group.add(rig.group);
    disposers.push(() => rig.dispose());
    const bake = createBakeUniforms();
    const latexUniforms = { uRimK: { value: 0.35 } };

    // Shared simple materials (one program each, reused by several props).
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x1a1512 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.35 });
    const pomMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    disposers.push(() => { wireMat.dispose(); plateMat.dispose(); pomMat.dispose(); });

    /** Materials whose envMapIntensity follows the lights: [material, base]. */
    const envTracked = new Map();
    const trackEnv = (mat, base = mat.envMapIntensity ?? 1) => {
        if (mat && 'envMapIntensity' in mat) envTracked.set(mat, base);
    };

    await step(0.02);

    // --- Shell ---------------------------------------------------------
    let greybox = createGreybox();
    room.add(greybox.group);
    greybox.materials.forEach((m) => trackEnv(m, 0.6));
    const city = createCity(roomAssetUrl('city-night.webp'));
    room.add(city.group);
    disposers.push(() => city.dispose());
    const lightSwitch = createSwitch({ plateMaterial: plateMat, accent: 0xffb35c });
    room.add(lightSwitch.group);
    disposers.push(() => lightSwitch.dispose());
    await step(0.06);

    // --- Party kit -------------------------------------------------------
    const latexMat = createLatexMaterial(latexUniforms);
    const bGeo = balloonGeometry();
    disposers.push(() => { latexMat.dispose(); bGeo.dispose(); });
    trackEnv(latexMat, 0.9);
    const clusters = createBalloonClusters({
        clusters: [
            { pos: [-2.25, 1.95, -2.05], count: 9, spread: 0.3 },
            { pos: [2.3, 1.95, -2.02], count: 8, spread: 0.28 },
            { pos: [-2.35, 1.7, 1.45], count: 6, spread: 0.26 },
            { pos: [1.2, 0.16, -2.05], count: 4, spread: 0.3 }
        ],
        palette: pal.balloons, rand, material: latexMat, geometry: bGeo
    });
    room.add(clusters.mesh);
    const drop = createBalloonDrop({
        // Released behind and around the table, well away from every shot.
        count: q === 0 ? 9 : 14, palette: pal.balloons, rand, material: latexMat, geometry: bGeo,
        area: { x0: -1.4, x1: 0.9, z0: -1.9, z1: -0.2, wx0: -ROOM.halfX, wx1: ROOM.halfX, wz0: -ROOM.halfZ, wz1: ROOM.halfZ },
        ceilingY: ROOM.height,
        tableTop: { x: TABLE.x, z: TABLE.z, radius: TABLE.radius, y: TABLE.height }
    });
    room.add(drop.mesh);
    // Balloon strings: one merged mesh with the fairy-light wire material.
    await step(0.12);

    // Foil letters: wait (briefly) for the display font or the letters bake
    // in a fallback face.
    try {
        await Promise.race([
            Promise.all([document.fonts?.load('800 64px "Outfit"'), document.fonts?.load('700 64px "Noto Sans Thai"')]),
            new Promise((r) => setTimeout(r, 1500))
        ]);
    } catch { /* fall back to the stack */ }
    abortIfNeeded();
    // The foil's own reflections: the (per-renderer cached) studio PMREM.
    let studioEnv = null;
    try {
        studioEnv = await attachStudioEnvironmentAsync(renderer, new THREE.Scene());
    } catch { /* falls back to scene.environment */ }
    abortIfNeeded();
    const foilMat = createFoilMaterial(config.theme, studioEnv);
    const foilBase = foilMat.color.clone();
    disposers.push(() => foilMat.dispose());
    const letterRows = [];
    for (const [text, y] of [['HAPPY', LETTERS.row1Y], ['BIRTHDAY', LETTERS.row2Y]]) {
        const row = await buildLetterRow(text, { height: LETTERS.height, gap: 0.015, rand, yieldFn: yieldToMain });
        await step(y === LETTERS.row1Y ? 0.2 : 0.26);
        if (!row) continue;
        const mesh = new THREE.Mesh(row.geometry, foilMat);
        mesh.name = `foil-${text}`;
        mesh.position.set(LETTERS.x, y, LETTERS.z + 0.03);
        room.add(mesh);
        letterRows.push({ mesh, phase: rand() * 6 });
        disposers.push(() => row.geometry.dispose());
    }

    const sign = createNameSign(config.recipientName, { color: pal.sign, height: SIGN.height, maxWidth: SIGN.maxWidth });
    if (sign) {
        sign.mesh.position.set(LETTERS.x, SIGN.y, LETTERS.z);
        room.add(sign.mesh);
        sign.materials.forEach((m) => trackEnv(m, 0.8));
        disposers.push(() => sign.dispose());
    }

    const X = ROOM.halfX;
    const Z = ROOM.halfZ;
    await step(0.28, 'sign');
    const bunting = createBunting([
        { a: new THREE.Vector3(-X + 0.05, 2.5, -Z + 0.03), b: new THREE.Vector3(0.9, 2.5, -Z + 0.03), sag: 0.2 },
        { a: new THREE.Vector3(-X + 0.03, 2.48, -Z + 0.05), b: new THREE.Vector3(-X + 0.03, 2.48, 1.2), sag: 0.24 }
    ], { palette: pal.paper, stringMaterial: wireMat });
    room.add(bunting.group);
    // Its paper reflected the lit capture at full strength in the dark (bug).
    bunting.materials.forEach((m) => trackEnv(m, 0.8));
    disposers.push(() => bunting.dispose());

    await step(0.3, 'bunting');
    // Fairy lights: a curtain over the window + a swag along the back wall.
    const strands = [];
    const W = ROOM.window;
    const nStr = q === 0 ? 7 : 11;
    for (let i = 0; i < nStr; i++) {
        const x = THREE.MathUtils.lerp(W.x0 + 0.34, W.x1 - 0.34, i / (nStr - 1));
        const len = 0.9 + rand() * 0.5;
        const z = -Z + 0.1;
        strands.push({
            points: [new THREE.Vector3(x, W.y1 - 0.02, z), new THREE.Vector3(x + 0.01, W.y1 - len * 0.5, z + 0.01), new THREE.Vector3(x, W.y1 - len, z)],
            bulbs: q === 0 ? 8 : 12
        });
    }
    strands.push({ points: catenary(new THREE.Vector3(-X + 0.05, 2.38, -Z + 0.04), new THREE.Vector3(0.85, 2.38, -Z + 0.04), 0.3, 16), bulbs: q === 0 ? 24 : 40 });
    const fairy = createFairyLights(strands, { wireMaterial: wireMat, rand });
    room.add(fairy.group);
    disposers.push(() => fairy.dispose());
    await step(0.32);

    // Gifts and hats (theme paper, contrasting ribbon).
    const ribbonFor = (paper) => (new THREE.Color(paper).getHSL({}).l > 0.6 ? pal.balloons[0] : 0xf4e6c8);
    const T = TABLE;
    const giftList = [
        { pos: [T.x + 0.31, T.height, T.z + 0.16], size: [0.1, 0.08, 0.1], yaw: 0.4 },
        { pos: [T.x - 0.33, T.height, T.z - 0.02], size: [0.08, 0.11, 0.08], yaw: -0.3 },
        { pos: [-1.7, 0, -1.85], size: [0.34, 0.26, 0.3], yaw: 0.2 },
        { pos: [-1.45, 0, -1.7], size: [0.22, 0.18, 0.22], yaw: -0.5 },
        { pos: [-1.62, 0.26, -1.85], size: [0.16, 0.14, 0.16], yaw: 0.9 },
        { pos: [-2.05, 0.84, -Z + 0.2], size: [0.2, 0.16, 0.18], yaw: 0.1 }
    ].map((g, i) => {
        const paper = pal.paper[i % pal.paper.length];
        return { ...g, paper, ribbon: ribbonFor(paper) };
    });
    const gifts = createGifts(giftList);
    room.add(gifts.group);
    gifts.materials.forEach((m) => trackEnv(m, 0.8));
    disposers.push(() => gifts.dispose());
    const hats = createHats([
        // Off the lens line of the cake / close-up shots (camera looks from +z).
        { pos: [T.x - 0.38, T.height, T.z + 0.2], yaw: 0, tilt: 0, color: pal.paper[0], pom: 0xffffff },
        { pos: [T.x + 0.42, T.height, T.z + 0.05], yaw: 0, tilt: 0, color: pal.paper[1], pom: pal.paper[3] },
        { pos: [T.x + 0.2, T.height + 0.035, T.z - 0.36], yaw: 0, tilt: 1.35, roll: 0.3, color: pal.paper[3], pom: 0xffffff }
    ], { pomMaterial: pomMat });
    room.add(hats.group);
    hats.materials.forEach((m) => trackEnv(m, 0.8));
    disposers.push(() => hats.dispose());

    await step(0.34, 'gifts');
    // Picture frame on the table (the card's photo when there is one).
    const photoTex = paintPhotoPlaceholder(pal.paper, config.recipientName, config.sender);
    const photoMat = new THREE.MeshStandardMaterial({ map: photoTex, color: 0xd6d0c8, roughness: 0.7 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.45 });
    trackEnv(photoMat, 0.6);
    trackEnv(frameMat, 0.6);
    const frame = new THREE.Group();
    frame.name = 'photo-frame';
    const fw = 0.15;
    const fh = 0.19;
    const frameBox = new THREE.Mesh(new THREE.BoxGeometry(fw + 0.024, fh + 0.024, 0.012), frameMat);
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), photoMat);
    photo.position.z = 0.0065;
    frame.add(frameBox, photo);
    frame.position.set(T.x + 0.36, T.height + (fh + 0.024) / 2 * Math.cos(0.2), T.z - 0.24);
    frame.rotation.set(-0.2, -0.55, 0, 'YXZ');
    room.add(frame);
    disposers.push(() => { frameBox.geometry.dispose(); photo.geometry.dispose(); photoMat.dispose(); frameMat.dispose(); photoTex.dispose(); });
    if (config.photo) {
        // Swapping the map image keeps the program (map stays non-null).
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => {
            if (disposed) return;
            photoTex.image = coverCrop(img, 512, 640);
            photoTex.needsUpdate = true;
        };
        img.src = config.photo;
    }

    await step(0.37, 'frame');
    const confetti = createConfetti({
        count: q === 0 ? 160 : 360,
        palette: [...pal.balloons, 0xf1c872, 0xffffff],
        rand,
        tableTop: { x: T.x, z: T.z, radius: T.radius, y: T.height },
        bounds: { x0: -X + 0.02, x1: X - 0.02, z0: -Z + 0.02, z1: Z - 0.02 }
    });
    room.add(confetti.mesh);
    trackEnv(confetti.material, 0.8);
    disposers.push(() => confetti.dispose());

    // Soft contact shadow under the cake (the baked table cannot receive
    // real-time shadows). Shares the program of every transparent basic map.
    const shadowTex = contactShadowTexture();
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false });
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52).rotateX(-Math.PI / 2), shadowMat);
    contact.position.set(CAKE_SPOT.x, T.height + 0.0015, CAKE_SPOT.z);
    contact.name = 'room-contact';
    contact.renderOrder = -1;
    room.add(contact);
    disposers.push(() => { contact.geometry.dispose(); shadowMat.dispose(); shadowTex.dispose(); });

    const cakeAnchor = new THREE.Object3D();
    cakeAnchor.name = 'cake-anchor';
    cakeAnchor.position.set(CAKE_SPOT.x * S, T.height * S, CAKE_SPOT.z * S);
    // The cake keeps scale 1 (the room is scaled to it). Its local origin is
    // not its base, so seatCake() lifts it by -box.min.y.
    cakeAnchor.userData.cakeScale = 1;
    cakeAnchor.userData.surfaceY = 0;
    group.add(cakeAnchor);
    await step(0.4);

    // --- Baked room --------------------------------------------------------
    let baked = null;
    try {
        mark('load:start');
        baked = await loadBakedRoom({ quality: q, uniforms: bake, signal, onProgress: (p) => onProgress?.(0.4 + p * 0.4) });
        abortIfNeeded();
        mark('load:done');
        room.add(baked.group);
        room.remove(greybox.group);
        greybox.materials.forEach((m) => envTracked.delete(m));
        greybox.dispose();
        greybox = null;
        // Baked materials scale their reflections in the shader (uEnvK).
        const photoMesh = baked.group.getObjectByName('PHOTO');
        if (photoMesh) {
            // glTF UV convention: the print must not be flipped.
            photoTex.flipY = false;
            photoTex.needsUpdate = true;
            photoMesh.material = photoMat;
            frame.visible = false;
        }
        const emax = baked.manifest.emax || { dark: 1, party: 1 };
        bake.emaxDark = emax.dark;
        bake.emaxParty = emax.party;
        // Decode + upload every texture now, one per task, rather than all at
        // once on the first frame (or inside the environment capture).
        const textures = new Set(baked.textures);
        baked.group.traverse((o) => {
            const m = o.material;
            if (!m) return;
            ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach((k) => { if (m[k]) textures.add(m[k]); });
        });
        for (const t of textures) {
            renderer.initTexture?.(t);
            await step(0.82);
        }
    } catch (err) {
        if (err?.name === 'AbortError') {
            disposeAll();
            throw err;
        }
        if (import.meta.env.DEV) console.warn('[party-room] baked room unavailable, using the greybox', err);
    }
    if (greybox) disposers.push(() => greybox?.dispose());
    if (baked) {
        disposers.push(() => {
            baked.group.traverse((o) => {
                if (!o.isMesh) return;
                o.geometry.dispose();
                const m = o.material;
                if (m === photoMat) return;
                ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach((k) => m[k]?.dispose());
                m.dispose();
            });
            baked.textures.forEach((t) => t.dispose());
        });
    }

    // --- State -----------------------------------------------------------
    let envMap = null;
    let envDark = null;
    const prevEnvironment = scene.environment;
    let lit = 0;
    let dim = 0;
    const emissive = baked ? baked.emissive : [];

    function applyState() {
        const party = lit * (1 - 0.88 * dim);
        rig.setLit(lit);
        rig.setDim(dim);
        // DARK_GAIN: the physically dark bake is "eye-adapted" so the dark
        // room stays readable (brief: >= ~12 % frame luma) without exposure
        // tricks that would also blow out the candles.
        bake.uLmK.value.set((bake.emaxDark ?? 1) * Math.PI * DARK_GAIN * (1 - 0.5 * lit), (bake.emaxParty ?? 1) * Math.PI * PARTY_GAIN * party);
        // Dark: the dark capture at 0.6 (city reflections). Lit: the lit
        // capture, ramping in with the lights.
        const useDark = lit < 0.001 && envDark;
        const env = useDark ? envDark : envMap;
        if (env && (scene.environment === envMap || scene.environment === envDark || scene.environment === prevEnvironment)) {
            if (scene.environment !== env) scene.environment = env;
        }
        const envK = useDark ? 0.6 : THREE.MathUtils.lerp(0.07, 1, lit) * (1 - 0.6 * dim * lit);
        bake.uEnvK.value = envK;
        envTracked.forEach((base, mat) => { mat.envMapIntensity = base * envK; });
        // Foil mirrors a bright studio: in the dark it is a dim film at the
        // wall's tone (pure black would silhouette), no glints. clearcoat
        // stays > 0 so the program (USE_CLEARCOAT) never changes.
        foilMat.envMapIntensity = 2 * lit * lit * (1 - 0.55 * dim * lit);
        foilMat.color.copy(foilBase).multiplyScalar(0.1 + 0.9 * lit);
        foilMat.clearcoat = 0.001 + 0.999 * lit;
        emissive.forEach((m) => { m.emissiveIntensity = m.userData.emitBase * party; });
        fairy.setLit(lit);
        fairy.setDim(dim);
        // Off (unlit acrylic, no glow) until the switch; the tube powers with the room.
        sign?.setLevel(2.92 * lit * (1 - 0.25 * dim));
        latexUniforms.uRimK.value = 0.42 * lit;
        lightSwitch.setOn(lit > 0.02);
    }

    // --- Environment captures ---------------------------------------------------
    // Two PMREMs of this room from above the table, same size: the lit party
    // and the dark room (the city window is its only light). In the dark the
    // TV, parquet, glass and latex become dark mirrors of the city; at the
    // switch the texture swaps. Same size = same program key: three re-runs
    // getProgram for each material once (a cache hit, no compile), verified
    // with renderer.info.programs before/after.
    const capturePos = new THREE.Vector3(TABLE.x * S, 1.25 * S, (TABLE.z + 0.4) * S);
    const captureOpts = { size: q >= 2 ? 256 : 128, near: 0.05 * S, far: 12 * S, mark };
    try {
        lit = 1;
        applyState();
        await step(0.86);
        mark('env:start');
        envMap = await captureRoomEnvironment(renderer, scene, capturePos, captureOpts);
        lit = 0;
        applyState();
        envDark = await captureRoomEnvironment(renderer, scene, capturePos, { ...captureOpts, warm: false });
        envDark.name = 'party-room-env-dark';
        mark('env:done');
    } catch (err) {
        if (import.meta.env.DEV) console.warn('[party-room] env capture failed', err);
    }
    lit = 0;
    applyState();
    abortIfNeeded();

    // Optional: compile for the composer the caller draws through.
    if (bloom) {
        await precompileScene(renderer, group, camera, { targetScene: scene, bloom, sliceMs: 8 });
    }
    await step(1);

    // --- Per frame ----------------------------------------------------------
    const tmpV = new THREE.Vector3();
    const camM = new THREE.Vector3();
    let time = 0;
    function update(dt, t) {
        if (disposed) return;
        time = Number.isFinite(t) ? t : time + (dt || 0);
        const d = Math.min(dt || 0, 0.1);
        rig.update(time);
        // Analytic candle term on the baked surfaces follows the real light.
        rig.candle.getWorldPosition(tmpV).applyMatrix4(camera.matrixWorldInverse);
        bake.uCandlePos.value.copy(tmpV);
        bake.uCandleCol.value.copy(rig.candle.color).multiplyScalar(rig.candle.intensity);
        bake.uCandleRange.value = rig.candle.distance;
        const sway = reduceMotion || q === 0 ? 0 : 1;
        clusters.update(time, sway);
        bunting.update(time, sway);
        fairy.update(time, reduceMotion);
        lightSwitch.update(time, lit);
        city.update(time);
        letterRows.forEach((r) => { r.mesh.rotation.y = Math.sin(time * 0.45 + r.phase) * 0.02 * sway; });
        confetti.update(d);
        drop.update(d, camera.getWorldPosition(camM).divideScalar(S));
    }

    function setLights(t) {
        lit = THREE.MathUtils.clamp(Number(t) || 0, 0, 1);
        applyState();
    }

    function setDim(t) {
        dim = THREE.MathUtils.clamp(Number(t) || 0, 0, 1);
        applyState();
    }

    function popConfetti(origin) {
        const o = origin ? origin.clone().divideScalar(S) : new THREE.Vector3(TABLE.x, TABLE.height + 0.45, TABLE.z + 0.3);
        const n = q === 0 ? 90 : reduceMotion ? 40 : 220;
        confetti.burst(o, n, 1);
    }

    function dropBalloons() {
        if (reduceMotion) return;
        drop.drop();
    }

    function seatCake(cake) {
        if (cake.parent !== cakeAnchor) cakeAnchor.add(cake);
        cake.position.set(0, 0, 0);
        cake.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(cake);
        const minY = box.min.y - cakeAnchor.getWorldPosition(tmpV).y;
        if (Number.isFinite(minY)) cake.position.y = -minY;
        return cake;
    }

    function disposeAll() {
        disposed = true;
        scene.remove(group);
        disposers.splice(0).reverse().forEach((fn) => {
            try { fn(); } catch { /* keep disposing */ }
        });
    }

    applyState();
    update(0, 0);

    const switchWorld = new THREE.Vector3();
    lightSwitch.group.updateWorldMatrix(true, false);
    lightSwitch.group.getWorldPosition(switchWorld);

    return {
        group,
        cakeAnchor,
        shots: shotsWorld(),
        setLights,
        setDim,
        switchWorld,
        switchHit: lightSwitch.hit,
        popConfetti,
        dropBalloons,
        update,
        setQuality(next) {
            q = THREE.MathUtils.clamp(Math.round(next), 0, 2);
        },
        dispose() {
            if (disposed) return;
            if (scene.environment === envMap || scene.environment === envDark) scene.environment = prevEnvironment;
            envMap?.dispose();
            envDark?.dispose();
            disposeAll();
        },
        // extras
        lights: { candle: rig.candle, pendant: rig.pendant, hemi: rig.hemi },
        // Candle light (room rig + the analytic glow on the baked walls). Off
        // by default: call setCandles(n / total) as candles ignite / go out.
        setCandles: (level) => rig.setCandles(THREE.MathUtils.clamp(level, 0, 1)),
        setCandleLight: (on) => rig.setCandles(on ? 1 : 0),
        trackEnvMaterials(root, base = 1) {
            root.traverse((o) => {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => { if (m && !m.isMeshBasicMaterial && !m.isShaderMaterial) trackEnv(m, base); });
            });
            applyState();
        },
        seatCake,
        envMap,
        baked: !!baked,
        exposure: { dark: 1.1, lit: 1.0 },
        timeline,
        get lit() { return lit; },
        get dim() { return dim; }
    };
}

function coverCrop(img, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * s;
    const dh = img.naturalHeight * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c;
}

function contactShadowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
