import * as THREE from 'three';
import { applyDOMTranslations, getCurrentLang, saveLanguageSetting, translations } from './i18n.js';
import {
    applyCinematicRenderer,
    attachStudioEnvironment,
    setupStudioLighting,
    tuneMaterialsForEnvironment,
    createBloomComposer,
    isMobileViewport
} from './render-quality.js';

// Shaders for Volumetric Quantum Plasma Flame
const flameVertexShader = `
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vPosition;
    
    void main() {
        vUv = uv;
        vPosition = position;
        
        // Twisting plasma vortex: tip sways organically in electromagnetic fields
        float angle = uTime * 2.5 + position.y * 3.0;
        float r = 0.08 * (position.y + 0.1);
        vec3 pos = position;
        pos.x += sin(angle) * r;
        pos.z += cos(angle) * r;
        
        // High-frequency magnetic pulse
        float pulse = 1.0 + sin(uTime * 18.0) * 0.05 * position.y;
        pos.y *= pulse;
        
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
`;

const flameFragmentShader = `
    varying vec2 vUv;
    varying vec3 vPosition;
    uniform float uTime;
    
    // Simplex 3D Noise procedural generator in GLSL
    vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

    float snoise(vec3 v){
      const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
      const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

      vec3 i  = floor(v + dot(v, C.yyy) );
      vec3 x0 =   v - i + dot(i, C.xxx) ;

      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min( g.xyz, l.zxy );
      vec3 i2 = max( g.xyz, l.zxy );

      vec3 x1 = x0 - i1 + 1.0 * C.xxx;
      vec3 x2 = x0 - i2 + 2.0 * C.xxx;
      vec3 x3 = x0 - D.yyy;

      i = mod(i, 289.0 );
      vec4 p = permute( permute( permute(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

      float n_ = 1.0/7.0;
      vec3  ns = n_ * D.wyz - D.xzx;

      vec4 j = p - 49.0 * floor(p * ns.z *ns.z);

      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_ );

      vec4 x = x_ *ns.x + ns.yyyy;
      vec4 y = y_ *ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);

      vec4 b0 = vec4( x.xy, y.xy );
      vec4 b1 = vec4( x.zw, y.zw );

      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));

      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

      vec3 p0 = vec3(a0.xy,h.x);
      vec3 p1 = vec3(a0.zw,h.y);
      vec3 p2 = vec3(a1.xy,h.z);
      vec3 p3 = vec3(a1.zw,h.w);

      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;

      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                    dot(p2,x2), dot(p3,x3) ) );
    }
    
    void main() {
        // Map local cone height [-0.1, 0.1] to [0, 1]
        float h = (vPosition.y + 0.1) / 0.20;
        
        // Dynamic twisting simplex noise coordinate
        vec3 noiseCoord = vec3(vPosition.x * 12.0, vPosition.y * 8.0 - uTime * 6.0, vPosition.z * 12.0);
        float n = snoise(noiseCoord) * 0.5 + 0.5;
        
        // Beautiful glowing color gradient (Cyan base, Hot Pink mid, High-energy Gold tip)
        vec3 colorBlue = vec3(0.0, 0.95, 1.0);    // glowing electric blue
        vec3 colorOrange = vec3(1.0, 0.0, 0.55);  // hot pink middle
        vec3 colorGold = vec3(1.0, 0.95, 0.0);    // golden top tip
        vec3 colorWhite = vec3(1.0, 1.0, 1.0);    // core white glow
        
        vec3 color = vec3(0.0);
        
        if (h < 0.25) {
            color = mix(colorBlue, colorOrange, h / 0.25);
        } else if (h < 0.7) {
            color = mix(colorOrange, colorGold, (h - 0.25) / 0.45);
        } else {
            color = mix(colorGold, colorWhite, (h - 0.7) / 0.3);
        }
        
        // Smooth edge alpha affected by Simplex noise
        float edge = sin(vUv.x * 3.14159) * sin(vUv.y * 3.14159);
        float alpha = smoothstep(0.0, 0.25, edge * n);
        
        // Fast dynamic micro-flicker for realistic heat convection
        float flicker = 0.88 + sin(uTime * 40.0) * 0.12;
        
        gl_FragColor = vec4(color, alpha * flicker * (1.2 - h * 0.4));
    }
`;

// Presets Configuration
const presets = {
    'chocolate-royal': {
        theme: 'midnight-gold',
        plate: 'golden',
        glaze: 'chocolate',
        topper: 'star',
        strawberries: 0,
        cherries: 6,
        rolls: 5,
        sprinkles: false,
        font: 'playfair',
        music: 'happy-birthday-piano'
    },
    'pink-dream': {
        theme: 'neon-rose',
        plate: 'crystal',
        glaze: 'strawberry',
        topper: 'best-senpai',
        strawberries: 8,
        cherries: 2,
        rolls: 2,
        sprinkles: true,
        font: 'great-vibes',
        music: 'happy-birthday-synth'
    },
    'mint-chocolate': {
        theme: 'pastel-mint',
        plate: 'cosmic',
        glaze: 'mint',
        topper: 'star',
        strawberries: 4,
        cherries: 4,
        rolls: 4,
        sprinkles: true,
        font: 'outfit',
        music: 'happy-birthday-synth'
    },
    'midnight-gold': {
        theme: 'midnight-gold',
        plate: 'cosmic',
        glaze: 'cream',
        topper: 'hbd',
        strawberries: 0,
        cherries: 4,
        rolls: 6,
        sprinkles: true,
        font: 'playfair',
        music: 'happy-birthday-piano'
    }
};

// State management for Creator View
let previewRenderer = null;
let previewScene = null;
let previewLights = null;
let previewBloom = null;
let previewCamera = null;
let previewAnimationId = null;
let cakeGroup = null;
let candleMeshes = [];
let flameMaterial = null; // Shared dynamic flame material
let holographicRings = [];
let floatingSprinkles = [];
let emCoils = [];
let previewEnvelope = null;
let previewEnvelopePointer = null;
let previewEnvelopeLabel = null;

export function initCreator() {
    setupFormListeners();
    syncColorPickers();
    init3DPreview();

    // Initialize Language Switcher
    const langSwitcher = document.getElementById('lang-switcher');
    if (langSwitcher) {
        langSwitcher.value = getCurrentLang();
        langSwitcher.addEventListener('change', (e) => {
            saveLanguageSetting(e.target.value);
            applyDOMTranslations();
            updateCake(); // Rebuild 3D label dynamically
        });
    }
    applyDOMTranslations();
}

export function destroyCreator() {
    // Stop animation loop
    if (previewAnimationId) {
        cancelAnimationFrame(previewAnimationId);
        previewAnimationId = null;
    }

    // Clean up Three.js objects
    if (previewRenderer) {
        const container = document.getElementById('preview-canvas-wrapper');
        if (container && previewRenderer.domElement.parentNode === container) {
            container.removeChild(previewRenderer.domElement);
        }
        
        // Traverse and dispose
        if (previewScene) {
            previewScene.traverse((object) => {
                if (object.geometry) object.geometry.dispose();
                if (object.material) {
                    if (Array.isArray(object.material)) {
                        object.material.forEach(mat => mat.dispose());
                    } else {
                        object.material.dispose();
                    }
                }
            });
        }

        if (flameMaterial) {
            flameMaterial.dispose();
            flameMaterial = null;
        }

        // Dispose scanner rings and sprinkles
        holographicRings.forEach(r => {
            if (previewScene) previewScene.remove(r);
            if (r.geometry) r.geometry.dispose();
            if (r.material) {
                if (r.material.map) r.material.map.dispose();
                r.material.dispose();
            }
        });
        holographicRings = [];

        floatingSprinkles.forEach(s => {
            if (previewScene) previewScene.remove(s.mesh);
            if (s.mesh.geometry) s.mesh.geometry.dispose();
            if (s.mesh.material) s.mesh.material.dispose();
        });
        floatingSprinkles = [];

        emCoils = [];

        if (previewEnvelope) {
            if (previewScene) previewScene.remove(previewEnvelope);
            previewEnvelope.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
            previewEnvelope = null;
        }
        if (previewEnvelopePointer) {
            if (previewScene) previewScene.remove(previewEnvelopePointer);
            if (previewEnvelopePointer.geometry) previewEnvelopePointer.geometry.dispose();
            if (previewEnvelopePointer.material) previewEnvelopePointer.material.dispose();
            previewEnvelopePointer = null;
        }
        if (previewEnvelopeLabel) {
            if (previewScene) previewScene.remove(previewEnvelopeLabel);
            if (previewEnvelopeLabel.material) {
                if (previewEnvelopeLabel.material.map) previewEnvelopeLabel.material.map.dispose();
                previewEnvelopeLabel.material.dispose();
            }
            previewEnvelopeLabel = null;
        }

        previewRenderer.dispose();
        previewRenderer = null;
        previewScene = null;
        previewCamera = null;
        cakeGroup = null;
        candleMeshes = [];
    }
}

// 1. SETUP FORM LISTENERS & MODAL LOGIC
function setupFormListeners() {
    const slider = document.getElementById('candle-count');
    const sliderVal = document.getElementById('candle-count-display');
    const themeButtons = document.querySelectorAll('.theme-btn');
    const presetButtons = document.querySelectorAll('.preset-btn');
    const btnGenerate = document.getElementById('btn-generate-card');
    const modal = document.getElementById('share-modal');
    const btnCloseModal = document.getElementById('btn-modal-close');
    const btnCopyUrl = document.getElementById('btn-copy-url');
    const shareUrlInput = document.getElementById('share-url-input');
    const testLink = document.getElementById('btn-test-link');

    // Sidebar Tabs navigation
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const tabId = btn.dataset.tab;
            document.querySelectorAll('.tab-panel').forEach(panel => {
                panel.classList.remove('active');
            });
            document.getElementById(tabId)?.classList.add('active');
        });
    });

    // Reset active preset when manual changes occur
    const clearActivePresets = () => {
        presetButtons.forEach(b => b.classList.remove('active'));
    };

    // Sync candle range slider value in real-time
    if (slider && sliderVal) {
        slider.addEventListener('input', (e) => {
            sliderVal.textContent = e.target.value;
            clearActivePresets();
            updateCake();
        });
    }

    // Sync slider values for toppings in real-time
    const sStrawberries = document.getElementById('decor-strawberries');
    const sStrawberriesDisplay = document.getElementById('decor-strawberries-display');
    if (sStrawberries && sStrawberriesDisplay) {
        sStrawberries.addEventListener('input', (e) => {
            sStrawberriesDisplay.textContent = e.target.value;
            clearActivePresets();
            updateCake();
        });
    }

    const sCherries = document.getElementById('decor-cherries');
    const sCherriesDisplay = document.getElementById('decor-cherries-display');
    if (sCherries && sCherriesDisplay) {
        sCherries.addEventListener('input', (e) => {
            sCherriesDisplay.textContent = e.target.value;
            clearActivePresets();
            updateCake();
        });
    }

    const sRolls = document.getElementById('decor-rolls');
    const sRollsDisplay = document.getElementById('decor-rolls-display');
    if (sRolls && sRollsDisplay) {
        sRolls.addEventListener('input', (e) => {
            sRollsDisplay.textContent = e.target.value;
            clearActivePresets();
            updateCake();
        });
    }

    // Rebuild cake on dropdowns & switches change
    const sPlate = document.getElementById('plate-style');
    if (sPlate) {
        sPlate.addEventListener('change', () => {
            clearActivePresets();
            syncColorPickers();
            updateCake();
        });
    }
    
    const sGlaze = document.getElementById('glaze-style');
    if (sGlaze) {
        sGlaze.addEventListener('change', () => {
            clearActivePresets();
            syncColorPickers();
            updateCake();
        });
    }
    
    const sTopper = document.getElementById('topper-style');
    if (sTopper) {
        sTopper.addEventListener('change', () => {
            clearActivePresets();
            syncColorPickers();
            updateCake();
        });
    }
    
    const sSprinkles = document.getElementById('decor-sprinkles');
    if (sSprinkles) {
        sSprinkles.addEventListener('change', () => {
            clearActivePresets();
            updateCake();
        });
    }

    const sLetterEnabled = document.getElementById('letter-enabled');
    const sLetterDetailsGroup = document.getElementById('letter-details-group');
    if (sLetterEnabled && sLetterDetailsGroup) {
        sLetterEnabled.addEventListener('change', (e) => {
            sLetterDetailsGroup.style.display = e.target.checked ? 'block' : 'none';
            updateCake();
        });
    }

    const sLetterTheme = document.getElementById('letter-theme');
    if (sLetterTheme) {
        sLetterTheme.addEventListener('change', () => {
            syncColorPickers();
            updateCake();
        });
    }

    const sLetterTitle = document.getElementById('letter-title');
    if (sLetterTitle) {
        sLetterTitle.addEventListener('input', () => {
            updateCake();
        });
    }

    const sLetterBody = document.getElementById('letter-body');
    if (sLetterBody) {
        sLetterBody.addEventListener('input', () => {
            updateCake();
        });
    }

    const sCustomTopperText = document.getElementById('custom-topper-text');
    if (sCustomTopperText) {
        sCustomTopperText.addEventListener('input', () => {
            updateCake();
        });
    }

    const sDecorHearts = document.getElementById('decor-hearts');
    if (sDecorHearts) {
        sDecorHearts.addEventListener('change', () => {
            updateCake();
        });
    }

    const sDecorStars = document.getElementById('decor-stars');
    if (sDecorStars) {
        sDecorStars.addEventListener('change', () => {
            updateCake();
        });
    }

    // Theme selector buttons
    themeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            themeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            clearActivePresets();
            
            const selectedTheme = btn.dataset.theme;
            
            // Swap global CSS HSL variables
            document.body.className = '';
            document.body.classList.add(`theme-${selectedTheme}`);

            syncColorPickers();

            // Re-render cake materials to reflect theme color palettes in real-time
            updateCake();
        });
    });

    // Preset selection logic
    presetButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            presetButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const presetName = btn.dataset.preset;
            const p = presets[presetName];
            if (!p) return;
            
            // Set theme button active
            themeButtons.forEach(b => {
                if (b.dataset.theme === p.theme) {
                    b.classList.add('active');
                } else {
                    b.classList.remove('active');
                }
            });
            document.body.className = '';
            document.body.classList.add(`theme-${p.theme}`);
            
            // Set selects
            const setSelectValue = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = val;
            };
            setSelectValue('plate-style', p.plate);
            setSelectValue('glaze-style', p.glaze);
            setSelectValue('topper-style', p.topper);
            setSelectValue('music-track', p.music);
            setSelectValue('card-font', p.font);
            
            // Set sliders
            const setSliderValue = (id, val) => {
                const el = document.getElementById(id);
                if (el) {
                    el.value = val;
                    const valDisp = document.getElementById(`${id}-display`);
                    if (valDisp) valDisp.textContent = val;
                }
            };
            setSliderValue('decor-strawberries', p.strawberries);
            setSliderValue('decor-cherries', p.cherries);
            setSliderValue('decor-rolls', p.rolls);
            
            // Set checkbox
            const chk = document.getElementById('decor-sprinkles');
            if (chk) chk.checked = p.sprinkles;
            
            syncColorPickers();

            updateCake();
        });
    });

    // Share link generation
    if (btnGenerate) {
        btnGenerate.addEventListener('click', () => {
            const recipientName = document.getElementById('recipient-name').value.trim() || 'คุณพลอย';
            const title = document.getElementById('wish-title').value.trim() || 'สุขสันต์วันเกิดย้อนหลังนะค้าบคุณพลอย! 🎂🖤';
            const message = document.getElementById('wish-message').value.trim() || 'Happy Belated Birthday นะค้าบคุณพลอย! 🎂✨';
            const bdate = document.getElementById('birth-date')?.value || '2026-08-28';
            const theme = document.querySelector('.theme-btn.active').dataset.theme || 'neon-rose';
            const candles = parseInt(document.getElementById('candle-count').value) || 5;
            const music = document.getElementById('music-track').value;
            const font = document.getElementById('card-font')?.value || 'outfit';
            const photo = document.getElementById('memory-photo-url')?.value.trim() || '';

            // Gather toppings configuration
            const plate = document.getElementById('plate-style')?.value || 'ceramic';
            const glaze = document.getElementById('glaze-style')?.value || 'chocolate';
            const topper = document.getElementById('topper-style')?.value || 'best-senpai';
            const strawberries = parseInt(document.getElementById('decor-strawberries')?.value) || 0;
            const cherries = parseInt(document.getElementById('decor-cherries')?.value) || 0;
            const rolls = parseInt(document.getElementById('decor-rolls')?.value) || 0;
            const sprinkles = document.getElementById('decor-sprinkles')?.checked ?? true;

            const letterEnabled = document.getElementById('letter-enabled')?.checked ?? true;
            const letterTheme = document.getElementById('letter-theme')?.value || 'cyber';
            const letterTitle = document.getElementById('letter-title')?.value.trim() || 'A Special Secret Message';
            const letterBody = document.getElementById('letter-body')?.value.trim() || '';
            const topperText = document.getElementById('custom-topper-text')?.value.trim() || '';
            const decorHearts = document.getElementById('decor-hearts')?.checked ?? false;
            const decorStars = document.getElementById('decor-stars')?.checked ?? false;

            // Gather color customizations
            const glazeColor = document.getElementById('glaze-color')?.value || '';
            const creamColor = document.getElementById('cream-color')?.value || '';
            const plateColor = document.getElementById('plate-color')?.value || '';
            const candleColor = document.getElementById('candle-color')?.value || '';
            const topperColor = document.getElementById('topper-color')?.value || '';
            const envBaseColor = document.getElementById('env-base-color')?.value || '';
            const envFlapColor = document.getElementById('env-flap-color')?.value || '';
            const envSealColor = document.getElementById('env-seal-color')?.value || '';

            // Form data object with toppings state
            const dataToEncode = { 
                title,
                message,
                bdate,
                theme,
                candles, 
                music,
                plate,
                glaze,
                topper,
                strawberries,
                cherries,
                rolls,
                sprinkles,
                font,
                photo,
                letterEnabled,
                letterTheme,
                letterTitle,
                letterBody,
                topperText,
                decorHearts,
                decorStars,
                glazeColor,
                creamColor,
                plateColor,
                candleColor,
                topperColor,
                envBaseColor,
                envFlapColor,
                envSealColor
            };

            // Encode to Base64 (UTF-8 safe)
            const encodedString = encodeCardData(dataToEncode);

            // Construct full URL link
            const shareableUrl = `${window.location.origin}${window.location.pathname}#/view/${encodeURIComponent(recipientName)}?d=${encodedString}`;
            
            // Populate modal
            if (shareUrlInput) shareUrlInput.value = shareableUrl;
            if (testLink) testLink.href = shareableUrl;
            if (modal) modal.classList.add('active');
        });
    }

    // Close Modal
    if (btnCloseModal && modal) {
        btnCloseModal.addEventListener('click', () => {
            modal.classList.remove('active');
        });
    }

    // Copy to clipboard
    if (btnCopyUrl && shareUrlInput) {
        btnCopyUrl.addEventListener('click', () => {
            shareUrlInput.select();
            navigator.clipboard.writeText(shareUrlInput.value)
                .then(() => {
                    const originalHTML = btnCopyUrl.innerHTML;
                    btnCopyUrl.innerHTML = `<i class="fa-solid fa-check"></i> Copied!`;
                    btnCopyUrl.style.background = '#05ffb0';
                    btnCopyUrl.style.color = '#000000';
                    setTimeout(() => {
                        btnCopyUrl.innerHTML = originalHTML;
                        btnCopyUrl.style.background = '';
                        btnCopyUrl.style.color = '';
                    }, 2000);
                })
                .catch(err => console.error('Failed to copy link:', err));
        });
    }

    // Custom color input listeners
    const colorIds = [
        'glaze-color', 'cream-color', 'plate-color', 'candle-color',
        'topper-color', 'env-base-color', 'env-flap-color', 'env-seal-color'
    ];
    colorIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                updateCake();
            });
        }
    });
}

function syncColorPickers() {
    const glazeStyle = document.getElementById('glaze-style')?.value || 'chocolate';
    const plateStyle = document.getElementById('plate-style')?.value || 'ceramic';
    const themeName = document.querySelector('.theme-btn.active')?.dataset.theme || 'neon-rose';
    const letterTheme = document.getElementById('letter-theme')?.value || 'cyber';

    const glazeColors = { chocolate: '#311a11', strawberry: '#e92e52', mint: '#7be2a6', cream: '#fffcf7' };
    const plateColors = { ceramic: '#fbfbf8', crystal: '#ffe6f2', golden: '#d4af37', cosmic: '#090712' };
    const creamColors = { 
        'neon-rose': '#ed004c', 
        'midnight-gold': '#151310', 
        'pastel-mint': '#3d8df5', 
        'lavender-dream': '#22003c',
        'sakura-blossom': '#ffb3c6',
        'cyber-retro': '#ff5e62',
        'forest-moss': '#004b23',
        'cosmic-nebula': '#0f0c20',
        'choco-monarch': '#241108'
    };
    const topperColors = { 
        'neon-rose': '#ff0055', 
        'midnight-gold': '#ffd700', 
        'pastel-mint': '#00f2fe', 
        'lavender-dream': '#8000ff',
        'sakura-blossom': '#ff758f',
        'cyber-retro': '#ff3399',
        'forest-moss': '#00ff88',
        'cosmic-nebula': '#8a2be2',
        'choco-monarch': '#cca43b'
    };
    const candleColors = { 
        'neon-rose': '#ff0055', 
        'midnight-gold': '#ffd700', 
        'pastel-mint': '#00f2fe', 
        'lavender-dream': '#d155ff',
        'sakura-blossom': '#ffccd5',
        'cyber-retro': '#ff9966',
        'forest-moss': '#ffd700',
        'cosmic-nebula': '#00ffd5',
        'choco-monarch': '#5c3d2e'
    };

    const envColors = {
        cyber: { base: '#1a1b22', flap: '#00f2fe', seal: '#ff0055' },
        royal: { base: '#111111', flap: '#111111', seal: '#d4af37' },
        romance: { base: '#fff0f3', flap: '#fff0f3', seal: '#900c3f' },
        steampunk: { base: '#5c3d2e', flap: '#5c3d2e', seal: '#b87333' }
    };

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };

    setVal('glaze-color', glazeColors[glazeStyle] || '#311a11');
    setVal('cream-color', creamColors[themeName] || '#ed004c');
    setVal('plate-color', plateColors[plateStyle] || '#fbfbf8');
    setVal('candle-color', candleColors[themeName] || '#ff0055');
    setVal('topper-color', topperColors[themeName] || '#00f2fe');

    const env = envColors[letterTheme] || envColors.cyber;
    setVal('env-base-color', env.base);
    setVal('env-flap-color', env.flap);
    setVal('env-seal-color', env.seal);
}

// Safely encodes custom state using Base64 URI encoder
function encodeCardData(obj) {
    try {
        const jsonStr = JSON.stringify(obj);
        // UTF-8 safe base64 encoding
        const base64 = btoa(
            encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, (match, p1) => {
                return String.fromCharCode(parseInt(p1, 16));
            })
        );
        // Make it URL safe
        return base64
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    } catch (e) {
        console.error('Failed to encode card state:', e);
        return '';
    }
}

// Procedural Canvas Texture Generators
function createCakeCrumbBumpTexture() {
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

    // Fill base gray (middle height)
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Palette-knife swipe marks. Fine crumb noise alone left the tier sides
    // looking like smooth plastic — the broad vertical strokes a spatula
    // leaves while smoothing buttercream are the real tell of a frosted cake.
    // Deterministic (no Math.random) so the finish doesn't visibly reshuffle
    // every time the form is edited.
    const SWIPES = 34;
    ctx.lineCap = 'round';
    for (let i = 0; i < SWIPES; i++) {
        const t = i / SWIPES;
        const x = t * SIZE;
        // Alternate raised/recessed edges of each stroke
        const lift = Math.sin(i * 2.7) * 26;
        const width = 12 + Math.abs(Math.cos(i * 1.9)) * 20;
        const bow = Math.sin(i * 1.3) * 26;

        ctx.strokeStyle = `rgba(${128 + lift}, ${128 + lift}, ${128 + lift}, 0.55)`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x, -10);
        ctx.quadraticCurveTo(x + bow, SIZE / 2, x + Math.sin(i * 2.1) * 14, SIZE + 10);
        ctx.stroke();

        // Thin bright ridge on one side of the stroke, where frosting piles up
        ctx.strokeStyle = `rgba(${150 + lift * 0.4}, ${150 + lift * 0.4}, ${150 + lift * 0.4}, 0.3)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + width * 0.4, -10);
        ctx.quadraticCurveTo(x + bow + width * 0.4, SIZE / 2, x + Math.sin(i * 2.1) * 14 + width * 0.4, SIZE + 10);
        ctx.stroke();
    }

    // Generate organic micro-pores and cake crumbs over the swipes
    for (let i = 0; i < 26000; i++) {
        const x = Math.random() * SIZE;
        const y = Math.random() * SIZE;
        const radius = 0.4 + Math.random() * 1.6;
        const heightVal = Math.floor(Math.random() * 60) - 30;
        const color = Math.min(255, Math.max(0, 128 + heightVal));
        ctx.fillStyle = `rgba(${color}, ${color}, ${color}, 0.55)`;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    // Fewer repeats than before: the swipe marks have to read at cake scale,
    // not tile into fine noise.
    texture.repeat.set(3, 1);
    return texture;
}

function createCarbonFiberTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111113';
    ctx.fillRect(0, 0, 64, 64);
    
    ctx.fillStyle = '#1c1c1f';
    for (let y = 0; y < 64; y += 8) {
        for (let x = 0; x < 64; x += 8) {
            if ((x + y) % 16 === 0) {
                ctx.fillRect(x, y, 4, 8);
                ctx.fillRect(x + 4, y + 4, 4, 8);
            }
        }
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 12);
    return texture;
}

function createHolographicScannerTexture(colorStr) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 512);
    
    // Draw concentric neon rings
    ctx.strokeStyle = colorStr;
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 18;
    
    // Ring 1 (Dashed outer)
    ctx.lineWidth = 4;
    ctx.setLineDash([20, 20, 5, 20]);
    ctx.beginPath();
    ctx.arc(256, 256, 220, 0, Math.PI * 2);
    ctx.stroke();
    
    // Ring 2 (Solid thinner)
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(256, 256, 185, 0, Math.PI * 2);
    ctx.stroke();
    
    // Ring 3 (Inner complex dashed with ticks)
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 15]);
    ctx.beginPath();
    ctx.arc(256, 256, 140, 0, Math.PI * 2);
    ctx.stroke();
    
    // Ticks & Tech markings
    ctx.shadowBlur = 6;
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.fillStyle = colorStr;
    ctx.textAlign = 'center';
    ctx.fillText('QUANTUM GRID PROJ V4.0', 256, 256 - 95);
    ctx.fillText('STATUS // ACTIVE_SCAN', 256, 256 + 105);
    
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

function createFloatingLabelSprite(text, colorStr) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, 512, 128);
    
    // Draw neon glassmorphic plate
    ctx.fillStyle = 'rgba(8, 4, 16, 0.9)'; // Dense premium neon glass
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = 6;
    
    const r = 20;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(512 - r, 0);
    ctx.quadraticCurveTo(512, 0, 512, r);
    ctx.lineTo(512, 128 - r);
    ctx.quadraticCurveTo(512, 128, 512 - r, 128);
    ctx.lineTo(r, 128);
    ctx.quadraticCurveTo(0, 128, 0, 128 - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Strip raw emoji characters to guarantee zero font rendering blocks
    const cleanText = text.replace(/[✉️]/g, '').trim();
    
    // Set text alignment to left to draw icon beside it
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 28px "Outfit", sans-serif';
    
    // Calculate total centered width of text + vector envelope icon
    const textWidth = ctx.measureText(cleanText).width;
    const iconWidth = 36;
    const spacing = 12;
    const totalWidth = textWidth + spacing + iconWidth;
    const startX = (512 - totalWidth) / 2;
    
    ctx.fillText(cleanText, startX, 64);
    
    // Draw crisp, glowing procedural vector envelope icon next to the text
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = 3.5;
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 8;
    
    const ex = startX + textWidth + spacing;
    const ey = 52;
    const ew = iconWidth;
    const eh = 24;
    
    ctx.strokeRect(ex, ey, ew, eh);
    
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex + ew / 2, ey + eh / 2 + 2);
    ctx.lineTo(ex + ew, ey);
    ctx.stroke();
    
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false
    });
    
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.8, 0.45, 1.0);
    return sprite;
}

function setupHolographicRings() {
    holographicRings = [];
    const tex1 = createHolographicScannerTexture('#00f2fe');
    const tex2 = createHolographicScannerTexture('#ff0055');

    const ringGeo = new THREE.PlaneGeometry(6, 6);
    const ringMat1 = new THREE.MeshBasicMaterial({
        map: tex1,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 0.8
    });
    const ringMat2 = new THREE.MeshBasicMaterial({
        map: tex2,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 0.6
    });

    const ring1 = new THREE.Mesh(ringGeo, ringMat1);
    ring1.rotation.x = -Math.PI / 2;
    ring1.position.y = -1.14;
    if (previewScene) previewScene.add(ring1);
    holographicRings.push(ring1);

    const ring2 = new THREE.Mesh(ringGeo, ringMat2);
    ring2.rotation.x = -Math.PI / 2;
    ring2.position.y = -1.13;
    if (previewScene) previewScene.add(ring2);
    holographicRings.push(ring2);
}

function createCustomTopperTexture(text, themeName, customGlowColor = '') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    // Clear canvas
    ctx.clearRect(0, 0, 512, 256);
    
    // Background plate colors based on theme
    let bgColor = 'rgba(15, 10, 25, 0.85)';
    let textColor = '#ff0055';
    let borderColor = '#00f2fe';
    let glowColor = '#ff0055';
    let fontName = 'Outfit';

    if (themeName === 'midnight-gold') {
        bgColor = 'rgba(10, 8, 5, 0.9)';
        textColor = '#ffd700'; // Gold
        borderColor = '#ffd700';
        glowColor = '#ffd700';
        fontName = 'Playfair Display';
    } else if (themeName === 'pastel-mint') {
        bgColor = 'rgba(5, 15, 20, 0.85)';
        textColor = '#00f2fe'; // Cyan-mint
        borderColor = '#4facfe';
        glowColor = '#00f2fe';
        fontName = 'Outfit';
    } else if (themeName === 'lavender-dream') {
        bgColor = 'rgba(15, 5, 20, 0.88)';
        textColor = '#f355ff'; // Lavender
        borderColor = '#8000ff';
        glowColor = '#f355ff';
        fontName = 'Outfit';
    } else if (themeName === 'sakura-blossom') {
        bgColor = 'rgba(31, 12, 17, 0.9)';
        textColor = '#ff758f'; // Cherry bloom pink
        borderColor = '#ffb3c6';
        glowColor = '#ff758f';
        fontName = 'Great Vibes';
    } else if (themeName === 'cyber-retro') {
        bgColor = 'rgba(24, 0, 38, 0.9)';
        textColor = '#ff3399'; // Hot neon pink
        borderColor = '#ff9966';
        glowColor = '#ff3399';
        fontName = 'Outfit';
    } else if (themeName === 'forest-moss') {
        bgColor = 'rgba(0, 23, 10, 0.9)';
        textColor = '#00ff88'; // Emerald green
        borderColor = '#ffd700';
        glowColor = '#00ff88';
        fontName = 'Playfair Display';
    } else if (themeName === 'cosmic-nebula') {
        bgColor = 'rgba(7, 0, 20, 0.9)';
        textColor = '#8a2be2'; // Celestial violet
        borderColor = '#00f2fe';
        glowColor = '#00ffd5';
        fontName = 'Outfit';
    } else if (themeName === 'choco-monarch') {
        bgColor = 'rgba(20, 9, 4, 0.9)';
        textColor = '#cca43b'; // Honey gold
        borderColor = '#5c3d2e';
        glowColor = '#cca43b';
        fontName = 'Playfair Display';
    }

    if (customGlowColor) {
        textColor = customGlowColor;
        borderColor = customGlowColor;
        glowColor = customGlowColor;
    }

    // Draw glassmorphic background with rounded corners
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 12;
    
    // Draw rounded rect
    const r = 24;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(512 - r, 0);
    ctx.quadraticCurveTo(512, 0, 512, r);
    ctx.lineTo(512, 256 - r);
    ctx.quadraticCurveTo(512, 256, 512 - r, 256);
    ctx.lineTo(r, 256);
    ctx.quadraticCurveTo(0, 256, 0, 256 - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Draw text with glow
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 15;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Adjust font size based on text length
    let fontSize = 56;
    if (text.length > 10) fontSize = 44;
    if (text.length > 14) fontSize = 36;
    
    ctx.font = `bold ${fontSize}px "${fontName}", "Outfit", sans-serif`;
    ctx.fillText(text, 256, 128);
    
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

function createPaperTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    // Fill with middle gray base for bump mapping
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 512, 512);
    
    // Add fine-grained noise
    const imgData = ctx.getImageData(0, 0, 512, 512);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 12;
        data[i] = Math.min(255, Math.max(0, 128 + noise));
        data[i+1] = Math.min(255, Math.max(0, 128 + noise));
        data[i+2] = Math.min(255, Math.max(0, 128 + noise));
    }
    ctx.putImageData(imgData, 0, 0);
    
    // Draw some micro-fibers
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1.0;
    for (let i = 0; i < 100; i++) {
        ctx.beginPath();
        const sx = Math.random() * 512;
        const sy = Math.random() * 512;
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(
            sx + (Math.random() - 0.5) * 20, sy + (Math.random() - 0.5) * 20,
            sx + (Math.random() - 0.5) * 20, sy + (Math.random() - 0.5) * 20,
            sx + (Math.random() - 0.5) * 30, sy + (Math.random() - 0.5) * 30
        );
        ctx.stroke();
    }
    
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    for (let i = 0; i < 100; i++) {
        ctx.beginPath();
        const sx = Math.random() * 512;
        const sy = Math.random() * 512;
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(
            sx + (Math.random() - 0.5) * 20, sy + (Math.random() - 0.5) * 20,
            sx + (Math.random() - 0.5) * 20, sy + (Math.random() - 0.5) * 20,
            sx + (Math.random() - 0.5) * 30, sy + (Math.random() - 0.5) * 30
        );
        ctx.stroke();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 3);
    return texture;
}

function create3DEnvelopeMesh(letterTheme, customBaseColor = '', customFlapColor = '', customSealColor = '') {
    const group = new THREE.Group();
    group.name = 'envelope-group';

    let baseColor = 0x1a1b22; // default cyber dark charcoal
    let flapColor = 0x00f2fe; // default cyber cyan accent
    let sealColor = 0xff0055; // default cyber pink

    switch (letterTheme) {
        case 'cyber':
            baseColor = 0x1a1b22; // Charcoal
            flapColor = 0x00f2fe; // Glowing cyan accent
            sealColor = 0xff0055; // Neon pink
            break;
        case 'royal':
            baseColor = 0x111111; // Obsidian black
            flapColor = 0x111111; // Obsidian black
            sealColor = 0xd4af37; // Royal gold
            break;
        case 'romance':
            baseColor = 0xfff0f3; // Blush cotton paper
            flapColor = 0xfff0f3;
            sealColor = 0x900c3f; // Deep burgundy
            break;
        case 'steampunk':
            baseColor = 0x5c3d2e; // Woven craft brown
            flapColor = 0x5c3d2e;
            sealColor = 0xb87333; // Copper
            break;
    }

    if (customBaseColor) baseColor = new THREE.Color(customBaseColor);
    if (customFlapColor) flapColor = new THREE.Color(customFlapColor);
    if (customSealColor) sealColor = new THREE.Color(customSealColor);

    // Create the procedural paper texture
    const paperBumpMap = createPaperTexture();

    // Matte premium paper material
    const baseMat = new THREE.MeshPhysicalMaterial({
        color: baseColor,
        roughness: 0.90,
        metalness: 0.0,
        clearcoat: 0.0,
        bumpMap: paperBumpMap,
        bumpScale: 0.008
    });

    const flapMat = new THREE.MeshPhysicalMaterial({
        color: flapColor,
        roughness: 0.90,
        metalness: 0.0,
        clearcoat: 0.0,
        bumpMap: paperBumpMap,
        bumpScale: 0.008
    });

    // Premium Glossy Resinous Wax Material
    const sealMat = new THREE.MeshPhysicalMaterial({
        color: sealColor,
        roughness: 0.15,
        metalness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08
    });

    // 1. Envelope body (thin box)
    const bodyGeo = new THREE.BoxGeometry(0.9, 0.6, 0.04);
    const bodyMesh = new THREE.Mesh(bodyGeo, baseMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    group.add(bodyMesh);

    // 2. Back folds
    const foldGeo = new THREE.BoxGeometry(0.86, 0.56, 0.045);
    const foldMesh = new THREE.Mesh(foldGeo, baseMat);
    foldMesh.position.z = 0.005;
    group.add(foldMesh);

    // 3. Triangular top flap (closed/partially open look)
    const flapShape = new THREE.Shape();
    flapShape.moveTo(-0.45, 0.3);
    flapShape.lineTo(0.45, 0.3);
    flapShape.lineTo(0, -0.05);
    flapShape.closePath();

    const extrudeSettings = {
        depth: 0.02,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.01,
        bevelThickness: 0.01
    };

    const flapGeo = new THREE.ExtrudeGeometry(flapShape, extrudeSettings);
    flapGeo.center();
    const flapMesh = new THREE.Mesh(flapGeo, flapMat);
    flapMesh.position.set(0, 0.12, 0.025);
    flapMesh.rotation.x = 0.05;
    flapMesh.castShadow = true;
    group.add(flapMesh);

    // 4. Melted Hot Wax Seal shape (Sinusoidal Wave Perturbed organic puddle)
    const sealShape = new THREE.Shape();
    const segments = 64;
    const baseRadius = 0.075;
    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const r = baseRadius + 0.007 * Math.sin(theta * 5.0) + 0.003 * Math.cos(theta * 8.0);
        const x = Math.cos(theta) * r;
        const y = Math.sin(theta) * r;
        if (i === 0) {
            sealShape.moveTo(x, y);
        } else {
            sealShape.lineTo(x, y);
        }
    }
    sealShape.closePath();

    const sealExtSettings = {
        depth: 0.015,
        bevelEnabled: true,
        bevelSegments: 3,
        steps: 1,
        bevelSize: 0.004,
        bevelThickness: 0.004
    };

    const sealGeo = new THREE.ExtrudeGeometry(sealShape, sealExtSettings);
    sealGeo.center();

    const sealMesh = new THREE.Mesh(sealGeo, sealMat);
    sealMesh.position.set(0, -0.02, 0.04);
    sealMesh.castShadow = true;
    group.add(sealMesh);

    // 5. Pressed Stamp Central Emblem (raised heart/star badge)
    const heartShape = new THREE.Shape();
    heartShape.moveTo(0, 0);
    heartShape.bezierCurveTo(0, 0.02, 0.02, 0.04, 0.04, 0.04);
    heartShape.bezierCurveTo(0.06, 0.04, 0.07, 0.025, 0.07, 0.01);
    heartShape.bezierCurveTo(0.07, -0.01, 0.04, -0.04, 0, -0.065);
    heartShape.bezierCurveTo(-0.04, -0.04, -0.07, -0.01, -0.07, 0.01);
    heartShape.bezierCurveTo(-0.07, 0.025, -0.06, 0.04, -0.04, 0.04);
    heartShape.bezierCurveTo(-0.02, 0.04, 0, 0.02, 0, 0);

    const starShape = new THREE.Shape();
    const spikes = 5;
    const outer = 0.04;
    const inner = 0.018;
    for (let i = 0; i < spikes * 2; i++) {
        const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? outer : inner;
        if (i === 0) starShape.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
        else starShape.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    starShape.closePath();

    const emblemExtSettings = {
        depth: 0.005,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.001,
        bevelThickness: 0.001
    };

    const useHeart = (letterTheme === 'romance' || letterTheme === 'cyber');
    const emblemGeo = new THREE.ExtrudeGeometry(useHeart ? heartShape : starShape, emblemExtSettings);
    emblemGeo.center();

    const emblemMat = new THREE.MeshPhysicalMaterial({
        color: sealColor,
        roughness: 0.25,
        metalness: 0.15,
        clearcoat: 0.8,
        clearcoatRoughness: 0.1
    });

    const emblemMesh = new THREE.Mesh(emblemGeo, emblemMat);
    emblemMesh.position.set(0, -0.02, 0.0475);
    emblemMesh.castShadow = true;
    group.add(emblemMesh);

    return group;
}

function rebuildFloatingSprinkles() {
    // Clean up previous floating sprinkles
    floatingSprinkles.forEach(s => {
        if (previewScene) previewScene.remove(s.mesh);
        if (s.mesh.geometry) s.mesh.geometry.dispose();
        if (s.mesh.material) s.mesh.material.dispose();
    });
    floatingSprinkles = [];

    const colors = [0x00f2fe, 0xff0055, 0x05ffb0];
    const decorHearts = document.getElementById('decor-hearts')?.checked ?? false;
    const decorStars = document.getElementById('decor-stars')?.checked ?? false;

    // Create heart geometry helper
    const createHeartGeo = () => {
        const heartShape = new THREE.Shape();
        heartShape.moveTo(0, 0);
        heartShape.bezierCurveTo(0, 0.08, 0.08, 0.15, 0.15, 0.15);
        heartShape.bezierCurveTo(0.22, 0.15, 0.28, 0.10, 0.28, 0.04);
        heartShape.bezierCurveTo(0.28, -0.04, 0.18, -0.12, 0, -0.22);
        heartShape.bezierCurveTo(-0.18, -0.12, -0.28, -0.04, -0.28, 0.04);
        heartShape.bezierCurveTo(-0.28, 0.10, -0.22, 0.15, -0.15, 0.15);
        heartShape.bezierCurveTo(-0.08, 0.15, 0, 0.08, 0, 0);
        
        const extrudeSettings = { depth: 0.03, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.008, bevelThickness: 0.008 };
        const geo = new THREE.ExtrudeGeometry(heartShape, extrudeSettings);
        geo.center();
        return geo;
    };

    // Create star geometry helper
    const createStarGeo = () => {
        const starShape = new THREE.Shape();
        const spikes = 5;
        const outer = 0.18;
        const inner = 0.08;
        for (let i = 0; i < spikes * 2; i++) {
            const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
            const r = i % 2 === 0 ? outer : inner;
            if (i === 0) starShape.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
            else starShape.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
        }
        starShape.closePath();
        const extrudeSettings = { depth: 0.03, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.008, bevelThickness: 0.008 };
        const geo = new THREE.ExtrudeGeometry(starShape, extrudeSettings);
        geo.center();
        return geo;
    };

    // Standard cylinder sprinkle geometry
    const sprinkleGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.12, 8);
    const heartGeo = decorHearts ? createHeartGeo() : null;
    const starGeo = decorStars ? createStarGeo() : null;

    const totalCount = (decorHearts || decorStars) ? 24 : 12;

    for (let i = 0; i < totalCount; i++) {
        let geom = sprinkleGeo;
        let color = colors[i % colors.length];
        let type = 'sprinkle';

        if (decorHearts && decorStars) {
            if (i % 3 === 1) {
                geom = heartGeo;
                color = 0xff3377; // neon pink
                type = 'heart';
            } else if (i % 3 === 2) {
                geom = starGeo;
                color = 0xffd700; // gold
                type = 'star';
            }
        } else if (decorHearts) {
            if (i % 2 === 1) {
                geom = heartGeo;
                color = 0xff3377;
                type = 'heart';
            }
        } else if (decorStars) {
            if (i % 2 === 1) {
                geom = starGeo;
                color = 0xffd700;
                type = 'star';
            }
        }

        const sprinkleMat = new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: type !== 'sprinkle' ? 1.2 : 0.9,
            roughness: 0.1,
            metalness: 0.8
        });

        const mesh = new THREE.Mesh(geom, sprinkleMat);
        
        const angle = (i / totalCount) * Math.PI * 2 + Math.random() * 0.4;
        const radius = 2.4 + Math.random() * 1.2;
        const y = -0.5 + Math.random() * 2.5;

        mesh.position.set(
            Math.cos(angle) * radius,
            y,
            Math.sin(angle) * radius
        );

        mesh.rotation.set(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI
        );

        if (previewScene) previewScene.add(mesh);

        floatingSprinkles.push({
            mesh: mesh,
            baseY: y,
            angle: angle,
            radius: radius,
            orbitSpeed: 0.06 + Math.random() * 0.1,
            bobSpeed: 1.0 + Math.random() * 1.2,
            bobOffset: Math.random() * Math.PI,
            rotSpeed: {
                x: 0.2 + Math.random() * 0.4,
                y: 0.2 + Math.random() * 0.4,
                z: 0.2 + Math.random() * 0.4
            }
        });
    }

    if (heartGeo) heartGeo.dispose();
    if (starGeo) starGeo.dispose();
}

// 2. 3D PREVIEW REAL-TIME RENDERING (Three.js)
function init3DPreview() {
    const container = document.getElementById('preview-canvas-wrapper');
    if (!container) return;

    // Reset container loaders
    container.innerHTML = '';

    const width = container.clientWidth;
    const height = container.clientHeight || 480;

    // Create Scene, Camera & WebGLRenderer
    previewScene = new THREE.Scene();
    // The bloom composer outputs an opaque frame, so set the studio backdrop
    // explicitly to match the surrounding panel rather than clearing to black.
    previewScene.background = new THREE.Color(0x0b0714);
    previewCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    previewCamera.position.set(0, 4.5, 9);

    previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    previewRenderer.setSize(width, height);
    applyCinematicRenderer(previewRenderer, {
        exposure: 0.98,
        maxPixelRatio: isMobileViewport() ? 2 : 2.5
    });

    container.appendChild(previewRenderer.domElement);

    // Studio IBL — gives the glaze, cherries and cake stand real reflections
    attachStudioEnvironment(previewRenderer, previewScene);

    // Three-point studio rig (key / fill / themed rim)
    previewLights = setupStudioLighting(previewScene, { rimColor: 0xff0055 });

    // Soft colored bounce from inside the cake area
    const pointLight = new THREE.PointLight(0xff0055, 0.9, 10);
    pointLight.position.set(0, 2, 0);
    previewScene.add(pointLight);

    // Build the Cake
    cakeGroup = new THREE.Group();
    previewScene.add(cakeGroup);
    
    // Initial render based on default form values
    updateCake();

    // Initialize scanner rings and floating space sprinkles
    setupHolographicRings();
    rebuildFloatingSprinkles();

    // Initial Camera Focus
    previewCamera.lookAt(new THREE.Vector3(0, 0.5, 0));

    // Bloom post-processing so flames, rings and the neon topper actually glow
    previewBloom = createBloomComposer(previewRenderer, previewScene, previewCamera);

    // Animation Render Loop
    const clock = new THREE.Clock();
    
    function animatePreview() {
        previewAnimationId = requestAnimationFrame(animatePreview);

        const elapsed = clock.getElapsedTime();
        const delta = clock.getDelta();

        // Rotate Cake Group slowly
        if (cakeGroup) {
            cakeGroup.rotation.y = elapsed * 0.18;
            
            // Subtle hover effect
            cakeGroup.position.y = Math.sin(elapsed * 1.5) * 0.08;
        }

        // Animate tiny candle flame shapes
        candleMeshes.forEach(candle => {
            const flame = candle.getObjectByName('flame');
            if (flame) {
                const scaleTime = elapsed * 8 + candle.position.x * 10;
                flame.scale.y = 1.0 + Math.sin(scaleTime) * 0.15;
                flame.scale.x = 1.0 + Math.cos(scaleTime * 1.2) * 0.1;
                flame.scale.z = 1.0 + Math.sin(scaleTime * 1.5) * 0.1;
            }
        });

        if (flameMaterial) {
            flameMaterial.uniforms.uTime.value = elapsed;
        }

        // Animate Holographic scanner rings counter-rotating
        if (holographicRings.length >= 2) {
            holographicRings[0].rotation.z += delta * 0.25;
            holographicRings[1].rotation.z -= delta * 0.38;
        }

        // Animate Floating Space Sprinkles
        floatingSprinkles.forEach(sprinkle => {
            sprinkle.angle += sprinkle.orbitSpeed * delta;
            sprinkle.mesh.position.x = Math.cos(sprinkle.angle) * sprinkle.radius;
            sprinkle.mesh.position.z = Math.sin(sprinkle.angle) * sprinkle.radius;
            sprinkle.mesh.position.y = sprinkle.baseY + Math.sin(elapsed * sprinkle.bobSpeed + sprinkle.bobOffset) * 0.15;
            sprinkle.mesh.rotation.x += sprinkle.rotSpeed.x * delta;
            sprinkle.mesh.rotation.y += sprinkle.rotSpeed.y * delta;
            sprinkle.mesh.rotation.z += sprinkle.rotSpeed.z * delta;
        });

        // Animate neo-candle electromagnetic coils
        emCoils.forEach(coil => {
            const bob = Math.sin(elapsed * coil.speedY + coil.offsetY) * 0.03;
            coil.mesh.position.y = coil.baseY + bob;
            coil.mesh.rotation.z += delta * coil.rotSpeed;
        });

        // Animate floating envelope and pointer in live editor preview
        if (previewEnvelope) {
            previewEnvelope.position.y = 1.6 + Math.sin(elapsed * 1.2) * 0.05;
            previewEnvelope.rotation.y = Math.PI / 4 + Math.cos(elapsed * 0.8) * 0.05;
        }
        if (previewEnvelopePointer) {
            previewEnvelopePointer.position.y = 2.2 + Math.sin(elapsed * 3.0) * 0.1;
            previewEnvelopePointer.rotation.y = elapsed * 2.0;
        }
        if (previewEnvelopeLabel) {
            const pulse = 1.0 + Math.sin(elapsed * 2.5) * 0.05;
            previewEnvelopeLabel.scale.set(1.8 * pulse, 0.45 * pulse, 1.0);
        }

        if (previewBloom) {
            previewBloom.composer.render(delta);
        } else if (previewRenderer && previewScene && previewCamera) {
            previewRenderer.render(previewScene, previewCamera);
        }
    }

    animatePreview();

    // Resize Handler
    window.addEventListener('resize', onPreviewResize);
}

function onPreviewResize() {
    const container = document.getElementById('preview-canvas-wrapper');
    if (!container || !previewCamera || !previewRenderer) return;

    const width = container.clientWidth;
    const height = container.clientHeight || 480;

    previewCamera.aspect = width / height;
    previewCamera.updateProjectionMatrix();
    previewRenderer.setSize(width, height);
    if (previewBloom) previewBloom.setSize(width, height);
}

// 3. PROCEDURAL 3D CAKE & THEMES BUILDER

// Helper: Creates a smooth cylinder with rounded (beveled) edges using ExtrudeGeometry.
// This allows specular highlights to catch organic rounded cake curves, looking extremely realistic!
function createBeveledCylinder(radius, height, bevelRadius) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, radius - bevelRadius, 0, Math.PI * 2, false);

    // Scale the silhouette resolution with the actual radius. A flat 24 left
    // the big 2-unit tiers visibly faceted while over-tessellating the small
    // stand parts nobody looks at.
    const curveSegments = Math.min(96, Math.max(24, Math.round(radius * 36)));

    const extrudeSettings = {
        depth: height - bevelRadius * 2,
        steps: 1,
        bevelEnabled: true,
        bevelSegments: 6,
        bevelSize: bevelRadius,
        bevelThickness: bevelRadius,
        curveSegments
    };
    
    const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    geo.center(); // Center geometry relative to its bounding box
    geo.rotateX(Math.PI / 2); // Orient Z axis to Y axis
    return geo;
}

// Helper: Dynamic premium material based on cake plate/stand selection
function getPlateMaterial(plateStyle, customColor = '') {
    let mat;
    switch (plateStyle) {
        case 'crystal':
            mat = new THREE.MeshPhysicalMaterial({
                color: 0xffe6f2,
                roughness: 0.04,
                metalness: 0.05,
                transmission: 0.9,
                thickness: 0.4,
                ior: 1.52,
                transparent: true,
                opacity: 0.85,
                clearcoat: 1.0,
                clearcoatRoughness: 0.02
            });
            break;
        case 'golden':
            // Physical, not Standard: clearcoat is a MeshPhysicalMaterial
            // property and was being silently dropped here.
            mat = new THREE.MeshPhysicalMaterial({
                color: 0xd4af37,
                roughness: 0.12,
                metalness: 0.95,
                clearcoat: 0.8,
                clearcoatRoughness: 0.08
            });
            break;
        case 'cosmic':
            mat = new THREE.MeshPhysicalMaterial({
                color: 0x090712,
                roughness: 0.22,
                metalness: 0.88,
                bumpMap: createCarbonFiberTexture(),
                bumpScale: 0.015,
                clearcoat: 1.0,
                clearcoatRoughness: 0.02
            });
            break;
        case 'ceramic':
        default:
            mat = new THREE.MeshPhysicalMaterial({
                color: 0xfbfbf8,
                roughness: 0.15,
                metalness: 0.02,
                clearcoat: 0.9,
                clearcoatRoughness: 0.05
            });
            break;
    }
    if (customColor && mat) {
        mat.color.set(customColor);
    }
    return mat;
}

// Helper: Beautiful glazed cream material from selected flavor
function getGlazeMaterial(glazeStyle, customColor = '') {
    let colorHex = 0xfffaf0;
    let roughness = 0.2;
    let clearcoat = 1.0;
    
    switch (glazeStyle) {
        case 'chocolate':
            colorHex = 0x311a11; // Rich cocoa dark brown
            roughness = 0.12;
            break;
        case 'strawberry':
            colorHex = 0xe92e52; // Juicy glossy strawberry pink-red
            roughness = 0.08;
            break;
        case 'mint':
            colorHex = 0x7be2a6; // Creamy soft mint pastel green
            roughness = 0.15;
            break;
        case 'cream':
        default:
            colorHex = 0xfffcf7; // Creamy vanilla fluffy white
            roughness = 0.18;
            break;
    }

    if (customColor) {
        colorHex = new THREE.Color(customColor);
    }
    
    return new THREE.MeshPhysicalMaterial({
        color: colorHex,
        roughness: roughness,
        metalness: 0.02,
        clearcoat: clearcoat,
        clearcoatRoughness: 0.08,
        transmission: 0.88,
        thickness: 0.55,
        ior: 1.333,
        transparent: true
    });
}

// Helper: Builds a dynamic 2D canvas with diagonal striped lines to wrap choco wafer rolls.
function createWaferRollTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    
    // Wafer roll pastry color
    ctx.fillStyle = '#edd1b8';
    ctx.fillRect(0, 0, 128, 128);
    
    // Diagonal chocolate lines
    ctx.strokeStyle = '#42250d';
    ctx.lineWidth = 14;
    for (let offset = -128; offset < 256; offset += 32) {
        ctx.beginPath();
        ctx.moveTo(offset, 0);
        ctx.lineTo(offset + 128, 128);
        ctx.stroke();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 1);
    return texture;
}

/**
 * Scatters crumbs and stray sprinkles on the cake stand.
 *
 * A spotless stand is one of the strongest CG tells — a cake that was actually
 * assembled and decorated always sheds a little onto the plate.
 */
function addStandDebris(group, standY, standRadius, creamColorHex) {
    const crumbGeo = new THREE.DodecahedronGeometry(0.022, 0);
    const crumbMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(creamColorHex).multiplyScalar(0.75),
        roughness: 0.9,
        metalness: 0.0
    });
    const strayGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.055, 6);
    const strayColors = [0xff6b8b, 0xffd166, 0x06d6a0, 0x118ab2, 0xff9f1c];

    for (let i = 0; i < 26; i++) {
        const seed = 2.4 + i * 1.61;
        // Keep debris in the visible ring between the cake base and the rim.
        // Starts at 2.2 to clear the bottom piping, which reaches out to ~2.17.
        const r = 2.2 + Math.abs(Math.sin(seed * 1.7)) * (standRadius - 2.3);
        const theta = seed * 2.399; // golden-angle-ish spread, no clumping

        if (i % 3 === 0) {
            const stray = new THREE.Mesh(
                strayGeo,
                new THREE.MeshStandardMaterial({
                    color: strayColors[i % strayColors.length],
                    roughness: 0.45
                })
            );
            stray.position.set(Math.cos(theta) * r, standY + 0.028, Math.sin(theta) * r);
            // Lying flat on the plate, not standing up
            stray.rotation.set(Math.PI / 2, seed * 1.3, Math.sin(seed) * 0.9);
            stray.castShadow = true;
            group.add(stray);
        } else {
            const crumb = new THREE.Mesh(crumbGeo, crumbMat);
            crumb.position.set(Math.cos(theta) * r, standY + 0.022, Math.sin(theta) * r);
            crumb.rotation.set(seed, seed * 1.7, seed * 0.6);
            const s = 0.5 + Math.abs(Math.sin(seed * 3.1)) * 0.8;
            crumb.scale.setScalar(s);
            crumb.castShadow = true;
            group.add(crumb);
        }
    }
}

/**
 * Hangs a ring of glaze drips off the top edge.
 *
 * Running glaze is uneven: each drip has its own length, thickness, taper and
 * a slight sideways lean, and the bead at the tip swells by how far it ran.
 * Even spacing with identical 6-sided cylinders was the giveaway before.
 */
function addGlazeDrips(group, glazeMat, count, radius, topY, seedBase) {
    // Shared bead geometry — only the per-instance scale differs.
    const beadGeo = new THREE.SphereGeometry(0.04, 14, 12);

    for (let i = 0; i < count; i++) {
        const seed = seedBase + i * 2.11;
        const angle = (i / count) * Math.PI * 2 + Math.sin(seed * 1.7) * 0.02;
        const dripLength = 0.14 + Math.sin(i * 2.3 + 1.2) * 0.08;
        // Thicker drips run further, so tie thickness to length
        const thickness = 0.023 + (dripLength - 0.14) * 0.06 + Math.sin(seed) * 0.003;

        const dripGroup = new THREE.Group();

        const dripCylGeo = new THREE.CylinderGeometry(thickness * 1.15, thickness * 0.85, dripLength, 12);
        const dripCyl = new THREE.Mesh(dripCylGeo, glazeMat);
        dripCyl.position.y = -dripLength / 2;
        dripCyl.castShadow = true;
        dripGroup.add(dripCyl);

        const dripBulb = new THREE.Mesh(beadGeo, glazeMat);
        dripBulb.position.y = -dripLength;
        // Longer runs pool into a fatter, more elongated bead
        const beadScale = 0.85 + dripLength * 1.1;
        dripBulb.scale.set(beadScale, beadScale * 1.25, beadScale);
        dripBulb.castShadow = true;
        dripGroup.add(dripBulb);

        dripGroup.position.set(
            Math.cos(angle) * radius,
            topY,
            Math.sin(angle) * radius
        );
        // Lean each run slightly off plumb
        dripGroup.rotation.set(
            Math.sin(seed * 1.4) * 0.06,
            0,
            Math.cos(seed * 1.9) * 0.06
        );
        group.add(dripGroup);
    }
}

/**
 * Pipes a ring of cream rosettes around a tier.
 *
 * Hand-piped cream is never evenly spaced or uniformly sized, so every rosette
 * gets its own deterministic jitter in angle, radius, height, scale and spin.
 * The offsets are derived from the index (no Math.random) so the cake rebuilds
 * identically every time the form changes.
 */
function addPipingRing(group, count, radius, y, seedBase) {
    for (let i = 0; i < count; i++) {
        const seed = seedBase + i * 1.7;
        const angle = (i / count) * Math.PI * 2 + Math.sin(seed * 2.3) * 0.012;
        const r = radius + Math.sin(seed * 1.9) * 0.012;
        const cream = createPipedCreamMesh(0xfffafb, seed);

        cream.position.set(
            Math.cos(angle) * r,
            y + Math.sin(seed * 3.1) * 0.008,
            Math.sin(angle) * r
        );
        // Tilt outward slightly, plus a touch of per-rosette wobble
        cream.rotation.set(
            0.1 + Math.sin(seed * 1.3) * 0.05,
            -angle + Math.cos(seed) * 0.25,
            Math.sin(seed * 2.7) * 0.04
        );

        const s = 1.5 + Math.sin(seed * 4.1) * 0.11;
        // Slightly taller than wide — cream holds its peak
        cream.scale.set(s, s * (1.0 + Math.cos(seed * 1.6) * 0.06), s);
        group.add(cream);
    }
}

// Helper: Fluffy whipped cream mesh generated via point deformation on a SphereGeometry
function createPipedCreamMesh(colorHex = 0xfffafb, seed = 0) {
    const R = 0.1;
    // Ridges need enough segments around the circumference to resolve cleanly.
    const geo = new THREE.SphereGeometry(R, 28, 18);
    const pos = geo.attributes.position;

    // A real star nozzle leaves 5 vertical ridges, and lifting the bag while
    // piping twists them into a spiral. That silhouette — not a smooth dome —
    // is what reads as piped cream rather than a white ball.
    const RIDGE_COUNT = 5;

    for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        let y = pos.getY(i);
        let z = pos.getZ(i);

        if (y > 0) {
            // Clamp at 0: the top pole vertex can land a hair above the radius
            // in float math, and Math.pow(negative, 0.45) is NaN — which
            // poisoned the whole geometry's bounding sphere.
            const factor = Math.max(0, 1.0 - (y / R));
            x *= Math.pow(factor, 0.45);
            z *= Math.pow(factor, 0.45);
            y *= 1.35; // pull tip upwards
        }

        const radial = Math.hypot(x, z);
        if (radial > 1e-6) {
            const theta = Math.atan2(z, x);
            // 0 at the base, 1 at the tip
            const heightT = THREE.MathUtils.clamp((y + R) / (R * 2), 0, 1);
            // Ridges are deepest at the base and smooth out into the tip.
            // Keep this shallow — around a tenth of the radius. Deeper than
            // that and the rosette turns into sharp fins instead of cream.
            const depth = R * 0.11 * (1 - heightT);
            const ridge = Math.cos(theta * RIDGE_COUNT + heightT * 2.4 + seed) * depth;
            const scale = (radial + ridge) / radial;
            x *= scale;
            z *= scale;
        }

        // Per-instance lean so a ring of them never looks stamped from one mold
        const lean = Math.sin(seed) * 0.07;
        x += y * lean;

        pos.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshPhysicalMaterial({
        color: colorHex,
        roughness: 0.28,
        metalness: 0.02,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        sheen: 0.95,
        sheenColor: new THREE.Color(0xffe6eb)
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

// Helper: Strawberry mesh with green leafy crown and organic tapered shape
function createStrawberryMesh() {
    const group = new THREE.Group();
    
    // 1. Strawberry body
    // Enough segments to resolve the seed dimples below.
    const bodyGeo = new THREE.SphereGeometry(0.12, 34, 26);
    const pos = bodyGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        const y = pos.getY(i);
        let z = pos.getZ(i);

        if (y < 0) {
            let scaleFactor = 1.0 + y * 2.2;
            if (scaleFactor < 0.15) scaleFactor = 0.15;
            x *= scaleFactor;
            z *= scaleFactor;
        }

        // Seed pits. A smooth red teardrop reads as plastic; the achene
        // dimples are what make it legible as a strawberry at a glance.
        const radial = Math.hypot(x, z);
        if (radial > 1e-6) {
            const theta = Math.atan2(z, x);
            const phi = Math.asin(THREE.MathUtils.clamp(y / 0.12, -1, 1));
            // Staggered lattice: offsetting rings by latitude avoids visible columns
            const pit = Math.cos(theta * 9 + phi * 3) * Math.cos(phi * 13);
            const depth = Math.max(0, pit) * 0.009;
            const scale = (radial - depth) / radial;
            x *= scale;
            z *= scale;
        }

        pos.setXYZ(i, x, y, z);
    }
    bodyGeo.computeVertexNormals();

    // Physical, for the waxy skin highlight a real strawberry has
    const bodyMat = new THREE.MeshPhysicalMaterial({
        color: 0xcc1124,
        roughness: 0.32,
        metalness: 0.02,
        clearcoat: 0.55,
        clearcoatRoughness: 0.25
    });
    
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.scale.set(1.0, 1.35, 1.0);
    body.rotation.x = Math.PI; // point downwards
    body.position.y = 0.08;
    body.castShadow = true;
    group.add(body);
    
    // 2. Leafy green crown (sepals)
    const leafGeo = new THREE.ConeGeometry(0.05, 0.03, 5);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x276336, roughness: 0.7 });
    for (let i = 0; i < 5; i++) {
        const leaf = new THREE.Mesh(leafGeo, leafMat);
        const angle = (i / 5) * Math.PI * 2;
        leaf.position.set(Math.cos(angle) * 0.045, 0.15, Math.sin(angle) * 0.045);
        leaf.rotation.set(0.18, angle, 0.25);
        group.add(leaf);
    }
    
    return group;
}

// Helper: Cherry sphere with low roughness and procedurally curved green stem
function createCherryMesh() {
    const group = new THREE.Group();
    
    // 1. Cherry berry body
    const cherryGeo = new THREE.SphereGeometry(0.1, 30, 22);
    const cPos = cherryGeo.attributes.position;
    for (let i = 0; i < cPos.count; i++) {
        let x = cPos.getX(i);
        let y = cPos.getY(i);
        let z = cPos.getZ(i);

        // Stem dimple: real cherries are pressed in where the stalk attaches,
        // not perfectly round on top.
        const topT = Math.max(0, y / 0.1);
        y -= Math.pow(topT, 6) * 0.035;

        // Suture line — the shallow crease running down one side
        const theta = Math.atan2(z, x);
        const radial = Math.hypot(x, z);
        if (radial > 1e-6) {
            const crease = Math.exp(-Math.pow(Math.sin(theta / 2), 2) * 40) * 0.006;
            const scale = (radial - crease) / radial;
            x *= scale;
            z *= scale;
        }

        cPos.setXYZ(i, x, y, z);
    }
    cherryGeo.computeVertexNormals();

    const cherryMat = new THREE.MeshPhysicalMaterial({
        color: 0x730211,
        roughness: 0.03,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02
    });
    const body = new THREE.Mesh(cherryGeo, cherryMat);
    body.castShadow = true;
    group.add(body);
    
    // 2. Cherry stem curved using cylinder segments
    const stemGroup = new THREE.Group();
    const segmentCount = 6;
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x567527, roughness: 0.85 });
    const stemRadius = 0.008;
    const segmentHeight = 0.045;
    
    let lastY = 0.08;
    let lastX = 0;
    
    for (let i = 0; i < segmentCount; i++) {
        const segGeo = new THREE.CylinderGeometry(stemRadius, stemRadius, segmentHeight, 6);
        const seg = new THREE.Mesh(segGeo, stemMat);
        
        const angle = 0.15 + (i * 0.08); // curve rate
        seg.rotation.z = angle;
        
        const dx = Math.sin(angle) * segmentHeight;
        const dy = Math.cos(angle) * segmentHeight;
        seg.position.set(lastX + dx/2, lastY + dy/2, 0);
        lastX += dx;
        lastY += dy;
        
        stemGroup.add(seg);
    }
    group.add(stemGroup);
    return group;
}

// Helper: Custom 3D extruded mesh shapes for center crown/heart/star sign toppers
function createTopperMesh(topperStyle, customText = '', customRimColor = '') {
    if (topperStyle === 'none' && !customText) return null;
    
    const group = new THREE.Group();
    
    // Ground stick
    const rodGeo = new THREE.CylinderGeometry(0.015, 0.015, 1.25, 8);
    const rodMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, metalness: 0.9, roughness: 0.1 });
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.y = 0.6;
    rod.castShadow = true;
    group.add(rod);
    
    let signMesh = null;
    const extrudeSettings = {
        depth: 0.06,
        bevelEnabled: true,
        bevelSegments: 4,
        steps: 1,
        bevelSize: 0.015,
        bevelThickness: 0.015
    };
    
    if (customText) {
        const activeThemeBtn = document.querySelector('.theme-btn.active');
        const themeName = activeThemeBtn ? activeThemeBtn.dataset.theme : 'neon-rose';
        const canvasTexture = createCustomTopperTexture(customText, themeName, customRimColor);
        
        const frontBackMat = new THREE.MeshPhysicalMaterial({
            map: canvasTexture,
            transparent: true,
            roughness: 0.1,
            metalness: 0.1,
            clearcoat: 1.0,
            clearcoatRoughness: 0.05
        });
        
        let sideColor = 0xffd700; // Gold rim by default
        if (themeName === 'neon-rose') sideColor = 0xff0055;
        else if (themeName === 'pastel-mint') sideColor = 0x00f2fe;
        else if (themeName === 'lavender-dream') sideColor = 0x8000ff;
        
        if (customRimColor) {
            sideColor = new THREE.Color(customRimColor);
        }
        
        const sideMat = new THREE.MeshStandardMaterial({
            color: sideColor,
            roughness: 0.1,
            metalness: 0.9
        });
        
        const materials = [
            sideMat, // right
            sideMat, // left
            sideMat, // top
            sideMat, // bottom
            frontBackMat, // front
            frontBackMat  // back
        ];
        
        const plaqueGeo = new THREE.BoxGeometry(1.2, 0.6, 0.04);
        signMesh = new THREE.Mesh(plaqueGeo, materials);
        signMesh.position.y = 1.25;
    } else if (topperStyle === 'best-senpai') {
        const heartShape = new THREE.Shape();
        heartShape.moveTo(0, 0.1);
        heartShape.bezierCurveTo(0, 0.3, 0.15, 0.5, 0.35, 0.5);
        heartShape.bezierCurveTo(0.55, 0.5, 0.65, 0.35, 0.65, 0.2);
        heartShape.bezierCurveTo(0.65, 0.0, 0.4, -0.25, 0, -0.55);
        heartShape.bezierCurveTo(-0.4, -0.25, -0.65, 0, -0.65, 0.2);
        heartShape.bezierCurveTo(-0.65, 0.35, -0.55, 0.5, -0.35, 0.5);
        heartShape.bezierCurveTo(-0.15, 0.5, 0, 0.3, 0, 0.1);
        
        const heartGeo = new THREE.ExtrudeGeometry(heartShape, extrudeSettings);
        heartGeo.center();
        
        let heartColor = 0xec1a4e;
        if (customRimColor) heartColor = new THREE.Color(customRimColor);
        
        const heartMat = new THREE.MeshPhysicalMaterial({
            color: heartColor,
            roughness: 0.1,
            metalness: 0.15,
            clearcoat: 1.0,
            clearcoatRoughness: 0.02,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x3d0006
        });
        signMesh = new THREE.Mesh(heartGeo, heartMat);
        signMesh.position.y = 1.25;
        
    } else if (topperStyle === 'star') {
        const starShape = new THREE.Shape();
        const spikes = 5;
        const outer = 0.42;
        const inner = 0.18;
        for (let i = 0; i < spikes * 2; i++) {
            const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
            const r = i % 2 === 0 ? outer : inner;
            const x = Math.cos(angle) * r;
            const y = Math.sin(angle) * r;
            if (i === 0) starShape.moveTo(x, y);
            else starShape.lineTo(x, y);
        }
        starShape.closePath();
        
        const starGeo = new THREE.ExtrudeGeometry(starShape, extrudeSettings);
        starGeo.center();
        
        let starColor = 0xffd700;
        if (customRimColor) starColor = new THREE.Color(customRimColor);
        
        const starMat = new THREE.MeshStandardMaterial({
            color: starColor,
            roughness: 0.1,
            metalness: 0.92,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x3f2f00
        });
        
        signMesh = new THREE.Mesh(starGeo, starMat);
        signMesh.position.y = 1.25;
        
    } else if (topperStyle === 'hbd') {
        const crownShape = new THREE.Shape();
        crownShape.moveTo(-0.5, -0.2);
        crownShape.lineTo(-0.5, 0.2);
        crownShape.lineTo(-0.35, 0.14);
        crownShape.lineTo(-0.18, 0.32);
        crownShape.lineTo(0, 0.18);
        crownShape.lineTo(0.18, 0.32);
        crownShape.lineTo(0.35, 0.14);
        crownShape.lineTo(0.5, 0.2);
        crownShape.lineTo(0.5, -0.2);
        crownShape.closePath();
        
        const crownGeo = new THREE.ExtrudeGeometry(crownShape, extrudeSettings);
        crownGeo.center();
        
        let crownColor = 0xffa500;
        if (customRimColor) crownColor = new THREE.Color(customRimColor);
        
        const crownMat = new THREE.MeshStandardMaterial({
            color: crownColor,
            roughness: 0.1,
            metalness: 0.95,
            emissive: customRimColor ? new THREE.Color(customRimColor).multiplyScalar(0.25) : 0x331a00
        });
        
        signMesh = new THREE.Mesh(crownGeo, crownMat);
        signMesh.position.y = 1.25;
    }
    
    if (signMesh) {
        signMesh.castShadow = true;
        group.add(signMesh);
    }
    
    return group;
}

// 4. GENERAL REALTIME CAKE RENDER REBUILDER
function updateCake() {
    if (!cakeGroup || !previewScene) return;

    // Gather latest configurations from UI controls
    const plateStyle = document.getElementById('plate-style')?.value || 'ceramic';
    const glazeStyle = document.getElementById('glaze-style')?.value || 'chocolate';
    const topperStyle = document.getElementById('topper-style')?.value || 'best-senpai';
    
    const strawberriesCount = parseInt(document.getElementById('decor-strawberries')?.value) || 0;
    const cherriesCount = parseInt(document.getElementById('decor-cherries')?.value) || 0;
    const rollsCount = parseInt(document.getElementById('decor-rolls')?.value) || 0;
    const sprinklesEnabled = document.getElementById('decor-sprinkles')?.checked ?? true;
    const candleCount = parseInt(document.getElementById('candle-count')?.value) || 5;

    // Gather custom color overrides
    const glazeColor = document.getElementById('glaze-color')?.value || '';
    const creamColor = document.getElementById('cream-color')?.value || '';
    const plateColor = document.getElementById('plate-color')?.value || '';
    const candleColor = document.getElementById('candle-color')?.value || '';
    const topperColor = document.getElementById('topper-color')?.value || '';
    const envBaseColor = document.getElementById('env-base-color')?.value || '';
    const envFlapColor = document.getElementById('env-flap-color')?.value || '';
    const envSealColor = document.getElementById('env-seal-color')?.value || '';

    // 1. Deep clean previous meshes to free GPU buffers and prevent leaks
    while (cakeGroup.children.length > 0) {
        const obj = cakeGroup.children[0];
        cakeGroup.remove(obj);
        obj.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else {
                    child.material.dispose();
                }
            }
        });
    }

    candleMeshes = [];
    emCoils = [];

    // 2. Reconstruct dynamic custom meshes
    const themeColors = getThemeRGBColors();
    const glazeMat = getGlazeMaterial(glazeStyle, glazeColor);
    const plateMat = getPlateMaterial(plateStyle, plateColor);

    // Cake Pedestal/Stand base geometry
    const standPlateGeo = createBeveledCylinder(2.6, 0.12, 0.02);
    const standPlate = new THREE.Mesh(standPlateGeo, plateMat);
    standPlate.position.y = -0.55;
    standPlate.receiveShadow = true;
    standPlate.castShadow = true;
    cakeGroup.add(standPlate);

    const standStemGeo = createBeveledCylinder(0.5, 0.5, 0.03);
    const standStem = new THREE.Mesh(standStemGeo, plateMat);
    standStem.position.y = -0.85;
    standStem.receiveShadow = true;
    standStem.castShadow = true;
    cakeGroup.add(standStem);

    const standBaseGeo = createBeveledCylinder(1.3, 0.08, 0.02);
    const standBase = new THREE.Mesh(standBaseGeo, plateMat);
    standBase.position.y = -1.1;
    standBase.receiveShadow = true;
    standBase.castShadow = true;
    cakeGroup.add(standBase);

    // Cake crumb bump mapping
    const crumbBumpTex = createCakeCrumbBumpTexture();

    // Determine custom cream colors
    const colorTier1 = creamColor ? new THREE.Color(creamColor) : themeColors.tier1;
    const colorTier2 = creamColor ? new THREE.Color(creamColor) : themeColors.tier2;

    // Cake Tier 1 (Bottom)
    const tier1Geo = createBeveledCylinder(2.0, 1.0, 0.08);
    const tier1Mat = new THREE.MeshStandardMaterial({
        color: colorTier1,
        roughness: 0.65,
        metalness: 0.05,
        bumpMap: crumbBumpTex,
        // Raised from 0.06: at that strength the frosting texture was
        // invisible and the tier sides read as smooth plastic.
        bumpScale: 0.16
    });
    const tier1 = new THREE.Mesh(tier1Geo, tier1Mat);
    tier1.position.y = 0.0;
    tier1.castShadow = true;
    tier1.receiveShadow = true;
    cakeGroup.add(tier1);

    // Cake Tier 2 (Top)
    const tier2Geo = createBeveledCylinder(1.4, 0.8, 0.06);
    const tier2Mat = new THREE.MeshStandardMaterial({
        color: colorTier2,
        roughness: 0.55,
        metalness: 0.05,
        bumpMap: crumbBumpTex,
        // Raised from 0.06: at that strength the frosting texture was
        // invisible and the tier sides read as smooth plastic.
        bumpScale: 0.16
    });
    const tier2 = new THREE.Mesh(tier2Geo, tier2Mat);
    // Nobody stacks a tier perfectly concentric or perfectly level. A couple
    // of millimetres of offset and under a degree of tilt is invisible as a
    // "mistake" but kills the machined-CG feel.
    tier2.position.set(0.018, 0.9, -0.012);
    tier2.rotation.z = 0.008;
    tier2.rotation.x = -0.005;
    tier2.castShadow = true;
    tier2.receiveShadow = true;
    cakeGroup.add(tier2);

    // Procedural Whipped Cream Star Piping Rings
    addPipingRing(cakeGroup, 36, 2.02, -0.46, 11);
    addPipingRing(cakeGroup, 28, 1.42, 0.52, 47);

    // Glazed frosting cap
    const glazeTopGeo = createBeveledCylinder(1.44, 0.12, 0.03);
    const glazeTop = new THREE.Mesh(glazeTopGeo, glazeMat);
    glazeTop.position.y = 1.3;
    glazeTop.castShadow = true;
    glazeTop.receiveShadow = true;
    cakeGroup.add(glazeTop);

    // Procedural glazed cream drips hanging from top edge
    addGlazeDrips(cakeGroup, glazeMat, 24, 1.425, 1.3, 5);

    // Crumbs and stray sprinkles shed onto the stand during decorating
    addStandDebris(cakeGroup, -0.49, 2.6, creamColor || themeColors.tier1);

    // Dynamic rings of fruits (Strawberries & Cherries)
    const baseDecorY = 1.36;

    // Fruit was placed on a mathematically perfect circle at one exact height.
    // Hand-placed fruit varies in distance from the edge, sits at slightly
    // different depths in the glaze, and is never uniformly sized.
    if (strawberriesCount > 0) {
        for (let i = 0; i < strawberriesCount; i++) {
            const seed = 3.7 + i * 2.3;
            const angle = (i / strawberriesCount) * Math.PI * 2 + Math.sin(seed) * 0.07;
            const r = 1.12 + Math.sin(seed * 1.7) * 0.05;
            const strawberry = createStrawberryMesh();
            strawberry.position.set(
                Math.cos(angle) * r,
                baseDecorY + Math.sin(seed * 2.9) * 0.018,
                Math.sin(angle) * r
            );
            strawberry.rotation.set(
                0.12 + Math.sin(seed * 1.4) * 0.09,
                angle + Math.PI / 2 + Math.cos(seed) * 0.35,
                Math.sin(seed * 3.3) * 0.13
            );
            const s = 1.0 + Math.sin(seed * 2.1) * 0.09;
            strawberry.scale.set(s, s * (1 + Math.cos(seed) * 0.05), s);
            cakeGroup.add(strawberry);
        }
    }

    if (cherriesCount > 0) {
        for (let i = 0; i < cherriesCount; i++) {
            const seed = 8.1 + i * 1.9;
            const angleOffset = (strawberriesCount > 0) ? (Math.PI / cherriesCount) : 0;
            const angle = (i / cherriesCount) * Math.PI * 2 + angleOffset + Math.sin(seed) * 0.06;
            const r = 1.12 + Math.cos(seed * 1.6) * 0.05;
            const cherry = createCherryMesh();
            cherry.position.set(
                Math.cos(angle) * r,
                baseDecorY + 0.04 + Math.sin(seed * 2.4) * 0.015,
                Math.sin(angle) * r
            );
            cherry.rotation.set(
                Math.sin(seed * 1.8) * 0.12,
                angle - Math.PI / 2 + Math.cos(seed * 1.2) * 0.4,
                Math.sin(seed * 2.6) * 0.16
            );
            const s = 0.94 + Math.sin(seed * 3.1) * 0.1;
            cherry.scale.setScalar(s);
            cakeGroup.add(cherry);
        }
    }

    // Striped Choco Wafer Rolls sticking out of the top tier
    if (rollsCount > 0) {
        const rollTexture = createWaferRollTexture();
        // 8 sides made these read as octagonal sticks at this scale
        const rollGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.75, 18);
        const rollMat = new THREE.MeshStandardMaterial({
            map: rollTexture,
            roughness: 0.65,
            metalness: 0.05
        });
        
        for (let i = 0; i < rollsCount; i++) {
            const angle = (i / rollsCount) * Math.PI * 2 + Math.PI / 8;
            const rollGroup = new THREE.Group();
            
            const rollMesh = new THREE.Mesh(rollGeo, rollMat);
            rollMesh.castShadow = true;
            rollGroup.add(rollMesh);
            
            // Vary how deep each roll is pushed in and how far it leans
            const seed = 1.3 + i * 2.7;
            const lean = 0.55 + Math.sin(seed) * 0.13;
            rollGroup.position.set(
                Math.cos(angle) * (1.25 + Math.sin(seed * 1.5) * 0.04),
                1.1 + Math.sin(seed * 2.2) * 0.03,
                Math.sin(angle) * (1.25 + Math.sin(seed * 1.5) * 0.04)
            );
            rollGroup.rotation.x = -Math.sin(angle) * lean;
            rollGroup.rotation.z = Math.cos(angle) * lean;
            rollGroup.rotation.y = -angle;
            
            cakeGroup.add(rollGroup);
        }
    }

    // Colorful Scattered Rainbow Sprinkles on top glaze
    if (sprinklesEnabled) {
        const colors = [0xff6b8b, 0xffd166, 0x06d6a0, 0x118ab2, 0xff9f1c, 0xb5179e];
        const sprinkleGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.06, 5);
        
        for (let i = 0; i < 60; i++) {
            const color = colors[i % colors.length];
            const sprinkleMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
            const sprinkle = new THREE.Mesh(sprinkleGeo, sprinkleMat);
            
            const r = Math.sqrt(Math.random()) * 1.25;
            const theta = Math.random() * Math.PI * 2;
            
            sprinkle.position.set(
                Math.cos(theta) * r,
                1.365,
                Math.sin(theta) * r
            );
            
            sprinkle.rotation.set(
                Math.PI / 2 + (Math.random() - 0.5) * 0.15,
                Math.random() * Math.PI * 2,
                (Math.random() - 0.5) * 0.15
            );
            sprinkle.castShadow = true;
            cakeGroup.add(sprinkle);
        }
    }

    // Extruded Crown/Heart Topper Sign
    const customText = document.getElementById('custom-topper-text')?.value.trim() || '';
    const topper = createTopperMesh(topperStyle, customText, topperColor);
    if (topper) {
        topper.position.set(0, 1.35, 0);
        cakeGroup.add(topper);
    }

    // Candles preview builder
    const candlePlacerRadius = 0.72;
    // 20 sides instead of 8: at this scale an 8-gon candle reads as an octagon.
    // Slight taper toward the top, like a real dipped/extruded wax candle.
    const candleGeo = new THREE.CylinderGeometry(0.046, 0.052, 0.45, 20);
    const wickGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.08, 8);
    const flameGeo = new THREE.ConeGeometry(0.07, 0.20, 12);
    // Molten wax collar that pools at the top of a burning candle
    const waxCollarGeo = new THREE.SphereGeometry(0.05, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);

    const candleColors = [0x55ffaa, 0xffbb44, 0xff55aa, 0x44bbff, 0xdd88ff];
    const wickMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });

    if (flameMaterial) flameMaterial.dispose();
    flameMaterial = new THREE.ShaderMaterial({
        vertexShader: flameVertexShader,
        fragmentShader: flameFragmentShader,
        uniforms: {
            uTime: { value: 0.0 }
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false
    });

    for (let i = 0; i < candleCount; i++) {
        const angle = (i / candleCount) * Math.PI * 2;
        const candleGroup = new THREE.Group();

        // Stagger/cycle colors on candle wax sticks
        const cColor = candleColor ? new THREE.Color(candleColor) : candleColors[i % candleColors.length];
        const candleMat = new THREE.MeshStandardMaterial({ color: cColor, roughness: 0.5 });

        const stick = new THREE.Mesh(candleGeo, candleMat);
        stick.position.y = 0.225;
        stick.castShadow = true;
        // Lean each candle a hair — nobody pushes candles in perfectly straight
        stick.rotation.z = Math.sin(i * 2.4) * 0.03;
        candleGroup.add(stick);

        const waxCollar = new THREE.Mesh(waxCollarGeo, candleMat);
        waxCollar.position.y = 0.442;
        waxCollar.scale.set(1.0, 0.42, 1.0);
        waxCollar.castShadow = true;
        candleGroup.add(waxCollar);

        const wick = new THREE.Mesh(wickGeo, wickMat);
        wick.position.y = 0.48;
        candleGroup.add(wick);

        const flame = new THREE.Mesh(flameGeo, flameMaterial);
        flame.position.y = 0.58;
        flame.name = 'flame';
        candleGroup.add(flame);

        candleGroup.position.set(
            Math.cos(angle) * candlePlacerRadius,
            1.35,
            Math.sin(angle) * candlePlacerRadius
        );

        cakeGroup.add(candleGroup);
        candleMeshes.push(candleGroup);
    }

    // 3. Rebuild Floating 3D Envelope and Pointer if enabled
    const letterEnabled = document.getElementById('letter-enabled')?.checked ?? true;
    const letterTheme = document.getElementById('letter-theme')?.value || 'cyber';

    // Clean up old envelope and pointer
    if (previewEnvelope) {
        previewScene.remove(previewEnvelope);
        previewEnvelope.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                else child.material.dispose();
            }
        });
        previewEnvelope = null;
    }
    if (previewEnvelopePointer) {
        previewScene.remove(previewEnvelopePointer);
        if (previewEnvelopePointer.geometry) previewEnvelopePointer.geometry.dispose();
        if (previewEnvelopePointer.material) previewEnvelopePointer.material.dispose();
        previewEnvelopePointer = null;
    }
    if (previewEnvelopeLabel) {
        previewScene.remove(previewEnvelopeLabel);
        if (previewEnvelopeLabel.material) {
            if (previewEnvelopeLabel.material.map) previewEnvelopeLabel.material.map.dispose();
            previewEnvelopeLabel.material.dispose();
        }
        previewEnvelopeLabel = null;
    }

    if (letterEnabled) {
        previewEnvelope = create3DEnvelopeMesh(letterTheme, envBaseColor, envFlapColor, envSealColor);
        previewEnvelope.scale.set(1.6, 1.6, 1.6);
        previewEnvelope.position.set(-2.8, 1.6, -1.8);
        previewEnvelope.rotation.y = Math.PI / 4;
        previewScene.add(previewEnvelope);

        // Pointer Cone Geometry pointing down (scaled up to match)
        const pointerGeo = new THREE.ConeGeometry(0.18, 0.45, 4);
        pointerGeo.rotateX(Math.PI);
        
        let pointerColor = envFlapColor ? new THREE.Color(envFlapColor) : 0x00f2fe;
        if (!envFlapColor) {
            if (letterTheme === 'royal') pointerColor = 0xffd700;
            else if (letterTheme === 'romance') pointerColor = 0xff3377;
            else if (letterTheme === 'steampunk') pointerColor = 0xb87333;
        }

        const pointerMat = new THREE.MeshBasicMaterial({
            color: pointerColor,
            wireframe: true
        });

        previewEnvelopePointer = new THREE.Mesh(pointerGeo, pointerMat);
        previewEnvelopePointer.position.set(-2.8, 2.4, -1.8);
        previewScene.add(previewEnvelopePointer);

        // Pulsating 3D billboard sprite label above envelope
        const labelColor = envFlapColor || '#00f2fe';
        const dict = translations[getCurrentLang()];
        previewEnvelopeLabel = createFloatingLabelSprite(dict.tapToOpen, labelColor);
        previewEnvelopeLabel.position.set(-2.8, 2.8, -1.8);
        previewScene.add(previewEnvelopeLabel);
    }

    // 4. Rebuild Floating Space Sprinkles/Ornaments in real-time
    rebuildFloatingSprinkles();

    // 5. Re-apply environment reflections and re-tint the rim light, since the
    //    cake (and every material on it) was rebuilt from scratch above.
    tuneMaterialsForEnvironment(cakeGroup, 0.6);
    if (previewLights) {
        // Rim light follows the theme's accent so the silhouette always reads
        // against the dark background, whatever palette is picked.
        previewLights.rim.color.set(creamColor || getThemeRGBColors().cream);
    }
}

// Helper: Retrieves color tokens matching current selected active theme button
function getThemeRGBColors(themeName = null) {
    if (!themeName) {
        const activeThemeBtn = document.querySelector('.theme-btn.active');
        themeName = activeThemeBtn ? activeThemeBtn.dataset.theme : 'neon-rose';
    }

    switch (themeName) {
        case 'midnight-gold':
            return {
                tier1: 0x151310, // Dark elegant obsidian
                tier2: 0x2b2214, // Midnight gold brown
                cream: 0xffd700  // Gold glaze
            };
        case 'pastel-mint':
            return {
                tier1: 0x3d8df5, // Sky ocean blue
                tier2: 0x00d2ec, // Bright mint teal
                cream: 0xffffff  // Vanilla snow cream
            };
        case 'lavender-dream':
            return {
                tier1: 0x22003c, // Dark plum velvet
                tier2: 0x7000df, // Lavender violet
                cream: 0xca4cff  // Bright magenta cream
            };
        case 'sakura-blossom':
            return {
                tier1: 0xffb3c6, // Cherry blossom pink
                tier2: 0xffe3ec, // Soft petal cream
                cream: 0xff758f  // Cherry glaze
            };
        case 'cyber-retro':
            return {
                tier1: 0xff5e62, // Sunset peach
                tier2: 0xff9966, // Warm orange
                cream: 0xff3399  // Hot neon pink
            };
        case 'forest-moss':
            return {
                tier1: 0x004b23, // Royal emerald
                tier2: 0x38b000, // Glowing lime
                cream: 0xd4af37  // Antique bronze gold
            };
        case 'cosmic-nebula':
            return {
                tier1: 0x0f0c20, // Void violet
                tier2: 0x00f2fe, // Supernova cyan
                cream: 0x00ffd5  // Interstellar turquoise
            };
        case 'choco-monarch':
            return {
                tier1: 0x241108, // Dark chocolate
                tier2: 0x4a2c11, // Velvety caramel
                cream: 0xcca43b  // Honey gold glaze
            };
        case 'neon-rose':
        default:
            return {
                tier1: 0xed004c, // Vivid neon magenta
                tier2: 0x3f0085, // Glossy deep violet
                cream: 0xffffff  // Fresh white cream
            };
    }
}
