/**
 * Scene backdrops, shared by the creator preview and the receiver.
 *
 * 'night' is the original dark stage and what every link made before
 * backdrops existed decodes to. The light ones are painted by CSS *behind a
 * transparent canvas* instead of inside the scene: the frame is tone-mapped
 * by OutputPass, and ACES cannot reach a pale #fff7f4 from any colour an
 * 8-bit gradient texture can hold (it would need ~4x overexposure, which
 * the bloom pass then smeared over the whole frame). CSS gives the exact
 * colours for free, the page UI can share them, and the frame costs nothing.
 *
 * What a light backdrop changes (all uniforms/GL state, no recompiles):
 *   clear alpha 0 + CSS gradient, exposure, key/fill/ambient/rim balance and
 *   fill tint (the paper bounces coloured light), bloom strength/threshold
 *   (a bright frame blooms everywhere), fog colour, a soft contact shadow
 *   under the plate (1 draw call; replaces the neon rings / stars, which only
 *   read on black). Candle flames switch look at build time (CANDLE_LOOKS).
 */
import * as THREE from 'three';
import { permanentTexture } from './cake/parts.js';

export { BACKDROP_NAMES, NEW_CARD_BACKDROP } from './backdrop-names.js';

const LIGHT_RIG = {
    exposure: 1.1,
    key: 1.12,
    fill: 1.7,
    ambient: 2.4,
    rim: 0.72,
    bloomStrength: 0.45,
    bloomThreshold: 2.4,
    envIntensity: 0.85,
    fogDensity: 0.011
};

/**
 * top/mid/bottom: the vertical sweep (a photographer's paper roll: bright
 * behind the subject, a touch deeper where it meets the floor). glow: the
 * soft light pool behind the cake. ink/soft/accent: receiver UI text tokens
 * over this backdrop (all >= 4.5:1 on `mid`, checked by the contrast script).
 */
export const BACKDROPS = Object.freeze({
    night: { name: 'night', light: false },
    blush: {
        name: 'blush', light: true,
        top: '#fff8f5', mid: '#fbe7e5', bottom: '#f2d0d2', glow: 'rgba(255,255,255,0.92)',
        fill: 0xffd6dc, fog: 0xf6dada, shadow: 0x5a2432, shadowOpacity: 0.44,
        ink: '#3a1d29', soft: '#6b4553', accent: '#a32a55'
    },
    cream: {
        name: 'cream', light: true,
        top: '#fffdf7', mid: '#f9efdf', bottom: '#eedcc0', glow: 'rgba(255,255,255,0.9)',
        fill: 0xffe6c4, fog: 0xf5ead6, shadow: 0x573816, shadowOpacity: 0.42,
        ink: '#34230f', soft: '#6a5236', accent: '#864a08'
    },
    sky: {
        name: 'sky', light: true,
        top: '#f8fbff', mid: '#e6f0fb', bottom: '#cfe0f3', glow: 'rgba(255,255,255,0.92)',
        fill: 0xcfe2ff, fog: 0xe2edf8, shadow: 0x1d3a5c, shadowOpacity: 0.38,
        ink: '#172a42', soft: '#475b73', accent: '#1f5fa8'
    },
    mint: {
        name: 'mint', light: true,
        top: '#f7fdf9', mid: '#e3f4ec', bottom: '#cbe7da', glow: 'rgba(255,255,255,0.9)',
        fill: 0xcff3e2, fog: 0xe0f2e9, shadow: 0x17463a, shadowOpacity: 0.38,
        ink: '#133528', soft: '#3f6155', accent: '#0f6e4f'
    },
    lavender: {
        name: 'lavender', light: true,
        top: '#fbf9ff', mid: '#eee8fb', bottom: '#dcd2f1', glow: 'rgba(255,255,255,0.92)',
        fill: 0xe0d6ff, fog: 0xebe5f8, shadow: 0x37265e, shadowOpacity: 0.42,
        ink: '#2a1d45', soft: '#5a4d74', accent: '#6a3fb5'
    }
});

/** Unknown or missing names resolve to night (the pre-backdrop look). */
export function resolveBackdrop(name) {
    return BACKDROPS[name] || BACKDROPS.night;
}

/** The CSS paint for a light backdrop ('' for night). */
export function backdropCss(name) {
    const b = resolveBackdrop(name);
    if (!b.light) return '';
    return `radial-gradient(ellipse 70% 55% at 50% 40%, ${b.glow} 0%, rgba(255,255,255,0) 72%), ` +
        `linear-gradient(180deg, ${b.top} 0%, ${b.mid} 58%, ${b.bottom} 100%)`;
}

/** Paints the same backdrop into a 2D canvas (saved photos). */
export function paintBackdrop(ctx, width, height, name) {
    const b = resolveBackdrop(name);
    if (!b.light) return false;
    const lin = ctx.createLinearGradient(0, 0, 0, height);
    lin.addColorStop(0, b.top);
    lin.addColorStop(0.58, b.mid);
    lin.addColorStop(1, b.bottom);
    ctx.fillStyle = lin;
    ctx.fillRect(0, 0, width, height);
    // Elliptical glow: a circle squashed by the canvas transform.
    const rx = width * 0.7;
    const ry = height * 0.55;
    ctx.save();
    ctx.translate(width / 2, height * 0.4);
    ctx.scale(1, ry / rx);
    const rad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 0.72);
    rad.addColorStop(0, b.glow);
    rad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rad;
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();
    return true;
}

/* ------------------------------------------------------------------ *
 * Contact shadow
 * ------------------------------------------------------------------ */

function paintContactShadow() {
    const SIZE = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
    // Plate rim sits at ~0.74 of the radius: dense right under it, then a
    // long soft falloff (ambient occlusion) out onto the paper.
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.62)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.26)');
    g.addColorStop(0.9, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/**
 * A baked blob shadow on the floor under the plate. Works on phones (no
 * shadow map there) and keeps the cake from floating on the pale paper.
 * Hidden on night. Its material shares the program of every other
 * transparent textured MeshBasicMaterial, so it adds no compile.
 *
 * @param {number} plateRadius  world radius of the plate/cake footprint
 */
export function createContactShadow(plateRadius = 2.8) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        map: permanentTexture('contact-shadow', paintContactShadow),
        color: 0x000000,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        fog: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'contact-shadow';
    mesh.renderOrder = -2;
    mesh.visible = false;
    fitContactShadow(mesh, plateRadius, -1.15);
    return mesh;
}

/** Sizes and places the shadow for the current cake (after every rebuild). */
export function fitContactShadow(mesh, plateRadius, floorY) {
    const size = Math.max(0.5, plateRadius) * 2.7;
    mesh.scale.set(size, 1, size);
    // A hair below the plate so a glass plate shows it and nothing z-fights.
    mesh.position.set(0, floorY - 0.004, 0);
}

/* ------------------------------------------------------------------ *
 * Apply
 * ------------------------------------------------------------------ */

const rendererBase = new WeakMap();

/**
 * Switches a live scene to a backdrop. Idempotent and cheap: call it on
 * mount and whenever the backdrop or theme changes (after tintRimLight).
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer  must be created with alpha: true
 * @param {object|null} bloom   createBloomComposer() result
 * @param {object|null} lights  setupStudioLighting() result
 * @param {string} name         backdrop name (unknown -> night)
 * @param {object} [opts]
 * @param {THREE.Color|number|null} [opts.nightBackground]  scene.background on night (null = clear to black)
 * @param {THREE.Mesh} [opts.contactShadow]  from createContactShadow()
 * @param {THREE.Object3D[]} [opts.nightOnly]  hidden on light backdrops (neon rings, stars)
 * @param {HTMLElement} [opts.paintHost]  element whose background paints the light backdrop
 * @returns {object} the resolved backdrop plus its rig numbers ({ envIntensity, exposure })
 */
export function applyBackdrop(scene, renderer, bloom, lights, name, opts = {}) {
    const b = resolveBackdrop(name);
    const light = b.light;
    const rig = light ? LIGHT_RIG : null;

    // Background: CSS behind a transparent frame, or the original opaque one.
    if (!scene.userData.backdropNight) {
        scene.userData.backdropNight = { background: opts.nightBackground ?? null };
    }
    const night = scene.userData.backdropNight;
    if (light) {
        scene.background = null;
        renderer.setClearColor(0x000000, 0);
    } else {
        scene.background = night.background == null ? null : new THREE.Color(night.background);
        renderer.setClearColor(0x000000, 1);
    }
    if (opts.paintHost) opts.paintHost.style.background = backdropCss(b.name);

    // Exposure: remembered per renderer so repeated calls never compound.
    if (!rendererBase.has(renderer)) rendererBase.set(renderer, { exposure: renderer.toneMappingExposure });
    const exposure = rendererBase.get(renderer).exposure * (rig ? rig.exposure : 1);
    renderer.toneMappingExposure = exposure;

    if (scene.fog) {
        if (!scene.userData.backdropFog) {
            scene.userData.backdropFog = { color: scene.fog.color.getHex(), density: scene.fog.density };
        }
        const base = scene.userData.backdropFog;
        scene.fog.color.setHex(light ? b.fog : base.color);
        if ('density' in scene.fog) scene.fog.density = light ? rig.fogDensity : base.density;
    }

    if (lights) {
        if (!lights.backdropBase) {
            lights.backdropBase = {
                ambient: lights.ambient.intensity,
                key: lights.key.intensity,
                fill: lights.fill.intensity,
                fillColor: lights.fill.color.getHex()
            };
        }
        const base = lights.backdropBase;
        lights.ambient.intensity = base.ambient * (rig ? rig.ambient : 1);
        lights.key.intensity = base.key * (rig ? rig.key : 1);
        lights.fill.intensity = base.fill * (rig ? rig.fill : 1);
        lights.fill.color.setHex(light ? b.fill : base.fillColor);
        const rimBase = lights.rim.userData.baseIntensity ?? lights.rim.intensity;
        lights.rim.intensity = rimBase * (rig ? rig.rim : 1);
    }

    const pass = bloom?.bloom;
    if (pass?.userData) {
        pass.strength = pass.userData.baseStrength * (rig ? rig.bloomStrength : 1);
        pass.threshold = light ? rig.bloomThreshold : pass.userData.baseThreshold;
    }

    const shadow = opts.contactShadow;
    if (shadow) {
        shadow.visible = light;
        if (light) {
            shadow.material.color.setHex(b.shadow);
            shadow.material.opacity = b.shadowOpacity;
        }
    }
    (opts.nightOnly || []).forEach((obj) => { if (obj) obj.visible = !light; });

    return { ...b, exposure, envIntensity: rig ? rig.envIntensity : 0.6, candleLook: light ? 'light' : 'dark' };
}
