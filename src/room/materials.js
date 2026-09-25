/**
 * Baked-room shading: MeshStandardMaterial (so parquet and lacquer keep
 * their roughness/normal detail and reflect the captured room) whose diffuse
 * light comes only from two baked lightmaps, blended by uniforms:
 *
 *   irradiance = dark * kDark + party * kParty + candle(term)
 *
 *   dark   Cycles bake of the city window, corridor spill and switch LED
 *   party  Cycles bake of the ceiling downlights, pendant, floor lamp and
 *          fairy lights (everything the wall switch turns on)
 *   candle a cheap analytic point term following the real candle light, so
 *          the walls breathe with the flames and go dark when they are blown
 *
 * Both maps are 8-bit, stored as sqrt(E / Emax) (more code values in the
 * shadows, where banding shows), decoded here with their own Emax.
 * setLights/setDim only write uniforms: every baked material compiles once,
 * in the dark state, to exactly the program it uses lit (no reveal hitch).
 * Real-time lights are zeroed on these surfaces (they are already in the
 * bake) and the env map is scaled by uEnvK so a dark room does not mirror
 * the lit capture.
 */
import * as THREE from 'three';

export function createBakeUniforms() {
    return {
        uLmParty: { value: null },
        uLmK: { value: new THREE.Vector2(1, 0) },
        // White balance of the party bake (a camera would not render 3600 K
        // bulbs this orange; a touch cooler reads as clean warm white).
        uPartyWB: { value: new THREE.Color(0.93, 1.0, 1.12) },
        // Night is blue-ish: the dark bake (city glow + a warm corridor) is
        // cooled so the flip goes cool -> warm, not warm -> warmer.
        uDarkTint: { value: new THREE.Color(0.78, 0.86, 1.08) },
        uEnvK: { value: 0.1 },
        uCandlePos: { value: new THREE.Vector3() },
        uCandleCol: { value: new THREE.Color(0, 0, 0) },
        uCandleRange: { value: 30 }
    };
}

const FRAGMENT_PARS = /* glsl */`
uniform sampler2D uLmParty;
uniform vec2 uLmK;
uniform vec3 uPartyWB;
uniform vec3 uDarkTint;
uniform float uEnvK;
uniform vec3 uCandlePos;
uniform vec3 uCandleCol;
uniform float uCandleRange;
`;

// Runs after <lights_fragment_maps> (direct lights, hemisphere light and the
// stock lightmap have been accumulated) and before <lights_fragment_end>.
const FRAGMENT_BAKE = /* glsl */`
#ifdef USE_LIGHTMAP
{
    vec3 lmD = texture2D( lightMap, vLightMapUv ).rgb;
    vec3 lmP = texture2D( uLmParty, vLightMapUv ).rgb;
    irradiance = lmD * lmD * uLmK.x * uDarkTint + lmP * lmP * uLmK.y * uPartyWB;
    vec3 toC = uCandlePos - geometryPosition;
    float d2 = dot( toC, toC );
    float nl = dot( geometryNormal, toC * inversesqrt( max( d2, 1e-4 ) ) ) * 0.7 + 0.3;
    float fall = 1.0 - smoothstep( 0.3, 1.0, sqrt( d2 ) / uCandleRange );
    irradiance += uCandleCol * max( nl, 0.0 ) * fall / max( d2, 4.0 );
    iblIrradiance = vec3( 0.0 );
    radiance *= uEnvK;
    reflectedLight.directDiffuse = vec3( 0.0 );
    reflectedLight.directSpecular = vec3( 0.0 );
}
#endif
`;

/**
 * Turns a (glTF) MeshStandardMaterial into a baked-room material. Its
 * lightMap must already hold the DARK map on uv1 (TEXCOORD_1).
 */
export function makeBaked(material, uniforms) {
    material.lightMapIntensity = 0; // the stock add is replaced below
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
            .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${FRAGMENT_BAKE}`);
    };
    // Same key for every baked material: identical patches, so three reuses
    // the program wherever the rest of the parameters match.
    material.customProgramCacheKey = () => 'room-baked-v1';
    material.userData.roomBaked = true;
    return material;
}
