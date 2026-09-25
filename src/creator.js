import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyDOMTranslations, getCurrentLang, saveLanguageSetting, translations } from './i18n.js';
import {
    applyCinematicRenderer,
    attachStudioEnvironment,
    setupStudioLighting,
    tuneMaterialsForEnvironment,
    createBloomComposer,
    isMobileViewport
} from './render-quality.js';
import {
    buildCakeModel,
    createHolographicScannerTexture
} from './cake-models.js';

// Realistic Organic Teardrop Candle Flame Shader with Natural S-curve Flicker & Heat Glow
const flameVertexShader = `
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vPosition;
    varying vec3 vNormal;
    
    void main() {
        vUv = uv;
        vPosition = position;
        vNormal = normal;
        
        vec3 pos = position;
        
        // Organic natural heat convection swaying (gentle wind and thermal lift)
        float swayFactor = smoothstep(0.0, 1.0, (pos.y + 0.1) / 0.28);
        float swayX = sin(uTime * 3.5 + pos.y * 10.0) * 0.022 * swayFactor;
        float swayZ = cos(uTime * 2.8 + pos.y * 8.0) * 0.016 * swayFactor;
        
        // Teardrop pulse and flicker
        float flicker = sin(uTime * 14.0) * 0.04 * swayFactor;
        
        pos.x += swayX;
        pos.z += swayZ;
        pos.y += flicker;
        
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
`;

const flameFragmentShader = `
    varying vec2 vUv;
    varying vec3 vPosition;
    varying vec3 vNormal;
    uniform float uTime;
    
    void main() {
        // Normalized height from candle wick base to tip [0.0 -> 1.0]
        float h = clamp((vPosition.y + 0.09) / 0.26, 0.0, 1.0);
        
        // Realistic candle flame color zones:
        // 1. Blue combustion oxygen base (h = 0.0 -> 0.15)
        // 2. Rich warm orange core (h = 0.15 -> 0.45)
        // 3. Bright golden yellow body (h = 0.45 -> 0.85)
        // 4. Brilliant white-hot incandescent center tip (h = 0.85 -> 1.0)
        vec3 blueBase   = vec3(0.12, 0.38, 0.98); // Blue base
        vec3 orangeCore = vec3(1.00, 0.42, 0.02); // Warm orange
        vec3 goldenBody = vec3(1.00, 0.82, 0.15); // Golden yellow
        vec3 whiteHot   = vec3(1.00, 0.98, 0.88); // White hot core
        
        vec3 flameColor;
        if (h < 0.18) {
            flameColor = mix(blueBase, orangeCore, h / 0.18);
        } else if (h < 0.55) {
            flameColor = mix(orangeCore, goldenBody, (h - 0.18) / 0.37);
        } else {
            flameColor = mix(goldenBody, whiteHot, (h - 0.55) / 0.45);
        }
        
        // Radial center core glow: inner is brilliant white, outer edge is translucent
        float distFromCenter = length(vPosition.xz) / 0.07;
        float coreGlow = smoothstep(0.8, 0.0, distFromCenter);
        flameColor = mix(flameColor, whiteHot, coreGlow * (1.0 - h * 0.5) * 0.7);
        
        // Soft outer opacity falloff (teardrop natural contour)
        float alpha = smoothstep(1.0, 0.1, distFromCenter);
        alpha *= smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.7, h);
        
        // Natural candle flame micro-shimmer
        float shimmer = 0.92 + sin(uTime * 25.0 + h * 8.0) * 0.08;
        
        gl_FragColor = vec4(flameColor, clamp(alpha * shimmer * 1.5, 0.0, 1.0));
    }
`;

// Presets Configuration
const presets = {
    'chocolate-royal': {
        theme: 'midnight-gold',
        cakeModel: 'triple-luxury',
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
        cakeModel: 'vintage-heart',
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
        cakeModel: 'korean-bento',
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
        cakeModel: 'cyber-prism',
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
let previewControls = null;
let previewAnimationId = null;
let cakeGroup = null;
let candleMeshes = [];
let flameMaterial = null; // Shared dynamic flame material
let holographicRings = [];
let floatingSprinkles = [];
let emCoils = [];
let previewEnvelope = null;
let previewVisible = true;
let previewVisibilityObserver = null;
let previewEnvelopePointer = null;
let previewEnvelopeLabel = null;

// #creator-view is static markup that is only shown/hidden, so its form
// listeners must be bound exactly once or they stack on every revisit.
let formListenersBound = false;

export function initCreator() {
    const firstMount = !formListenersBound;
    formListenersBound = true;
    if (firstMount) setupFormListeners();
    syncColorPickers();
    init3DPreview();

    // Initialize Language Switcher
    const langSwitcher = document.getElementById('lang-switcher');
    if (langSwitcher) {
        langSwitcher.value = getCurrentLang();
    }
    if (langSwitcher && firstMount) {
        langSwitcher.addEventListener('change', (e) => {
            saveLanguageSetting(e.target.value);
            applyDOMTranslations();
            updateCake(); // Rebuild 3D label dynamically
        });
    }
    applyDOMTranslations();
}

export function destroyCreator() {
    window.removeEventListener('resize', onPreviewResize);
    if (previewVisibilityObserver) {
        previewVisibilityObserver.disconnect();
        previewVisibilityObserver = null;
    }

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

        if (previewControls) {
            previewControls.dispose();
            previewControls = null;
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
    const sCakeModel = document.getElementById('cake-model');
    if (sCakeModel) {
        sCakeModel.addEventListener('change', () => {
            clearActivePresets();
            updateCake();
        });
    }

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
            setSelectValue('cake-model', p.cakeModel || 'classic-tiered');
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
            const bdate = document.getElementById('birth-date')?.value || '2026-08-17';
            const theme = document.querySelector('.theme-btn.active').dataset.theme || 'neon-rose';
            const candles = parseInt(document.getElementById('candle-count').value) || 5;
            const music = document.getElementById('music-track').value;
            const font = document.getElementById('card-font')?.value || 'outfit';
            const photo = document.getElementById('memory-photo-url')?.value.trim() || '';

            // Gather toppings configuration
            const cakeModel = document.getElementById('cake-model')?.value || 'classic-tiered';
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
                cakeModel,
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

            const defaults = {
                title: 'สุขสันต์วันเกิดย้อนหลังนะค้าบคุณพลอย! 🎂🖤',
                message: 'Happy Belated Birthday นะค้าบคุณพลอย! 🎂✨ ถึงจะมาช้าไปนิด แต่ความหวังดีมีให้เสมอ ขอให้ปีนี้เป็นปีที่ดี มีรอยยิ้มเยอะๆ สุขภาพแข็งแรง และเท่/น่ารักขึ้นทุกวันเลยน้า 🎉🖤',
                bdate: '2026-08-17',
                theme: 'midnight-gold',
                candles: 5,
                music: 'happy-birthday-lofi',
                cakeModel: 'classic-tiered',
                plate: 'ceramic',
                glaze: 'chocolate',
                topper: 'best-senpai',
                strawberries: 4,
                cherries: 4,
                rolls: 3,
                sprinkles: true,
                font: 'outfit',
                photo: '',
                letterEnabled: true,
                letterTheme: 'royal',
                letterTitle: 'ถึงคุณพลอยคนเท่ ✨',
                letterBody: 'ถึงคุณพลอย,\n\nจดหมายลับใบนี้ลอยข้ามกาลเวลามา HBD ย้อนหลังนะค้าบ ✉️✨\n\nขอให้ปีนี้ใจดีกับคุณพลอยเยอะๆ พบเจอแต่เรื่องราวดีๆ กินของอร่อยทุกวัน และมีความสุขกับทุกสิ่งที่ทำเลยน้า\n\nสุขสันต์วันเกิดย้อนหลังนะค้าบ! 🖤🎂✨',
                topperText: '',
                decorHearts: false,
                decorStars: true,
                glazeColor: '',
                creamColor: '',
                plateColor: '',
                candleColor: '',
                topperColor: '',
                envBaseColor: '',
                envFlapColor: '',
                envSealColor: ''
            };

            // Only encode keys that differ from defaults to keep URL ultra short
            const diffData = {};
            for (const key in dataToEncode) {
                if (dataToEncode[key] !== defaults[key]) {
                    diffData[key] = dataToEncode[key];
                }
            }

            const hasDiff = Object.keys(diffData).length > 0;
            const encodedString = hasDiff ? encodeCardData(diffData) : '';

            // Construct full URL link (Clean short URL if matching defaults)
            const shareableUrl = encodedString 
                ? `${window.location.origin}${window.location.pathname}#/view/${encodeURIComponent(recipientName)}?d=${encodedString}`
                : `${window.location.origin}${window.location.pathname}#/view/${encodeURIComponent(recipientName)}`;
            
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
    previewCamera.position.set(0, 4.0, 9.5);

    previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    previewRenderer.setSize(width, height);
    applyCinematicRenderer(previewRenderer, {
        exposure: 0.98,
        maxPixelRatio: isMobileViewport() ? 1.5 : 2.0
    });

    container.appendChild(previewRenderer.domElement);

    // Interactive OrbitControls for 3D Creator Preview
    previewControls = new OrbitControls(previewCamera, previewRenderer.domElement);
    previewControls.enableDamping = true;
    previewControls.dampingFactor = 0.05;
    previewControls.target.set(0, 0.4, 0);
    previewControls.minDistance = 4.0;
    previewControls.maxDistance = 20.0;
    previewControls.maxPolarAngle = Math.PI / 2 + 0.1;
    // The preview sits inside a scrolling page: a mouse wheel over it must
    // scroll the form, not silently zoom the cake out of frame.
    previewControls.enableZoom = false;

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
    rebuildCake();

    // Initialize scanner rings and floating space sprinkles
    setupHolographicRings();
    rebuildFloatingSprinkles();

    // Initial Camera Focus
    previewCamera.lookAt(new THREE.Vector3(0, 0.4, 0));

    // Bloom post-processing so flames, rings and the neon topper actually glow
    previewBloom = createBloomComposer(previewRenderer, previewScene, previewCamera);

    // Animation Render Loop
    const clock = new THREE.Clock();
    
    function animatePreview() {
        previewAnimationId = requestAnimationFrame(animatePreview);

        // Nothing to draw while the preview is scrolled away or the tab is
        // hidden; skip the whole frame instead of burning the GPU.
        if (!previewVisible || document.hidden) {
            clock.getDelta();
            return;
        }

        // getDelta() must come first: getElapsedTime() advances the clock
        // itself, which left delta at ~0 and froze the rings and sprinkles.
        const delta = clock.getDelta();
        const elapsed = clock.elapsedTime;

        if (previewControls) {
            previewControls.update();
        }

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

    previewVisible = true;
    if ('IntersectionObserver' in window) {
        previewVisibilityObserver = new IntersectionObserver(([entry]) => {
            previewVisible = entry.isIntersecting;
        });
        previewVisibilityObserver.observe(container);
    }

    animatePreview();

    // Resize Handler
    window.addEventListener('resize', onPreviewResize);
    setTimeout(onPreviewResize, 100);
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

// 4. GENERAL REALTIME CAKE RENDER REBUILDER
// Sliders fire dozens of input events a second and each full rebuild creates
// fresh geometry and textures, so coalesce them into one rebuild per frame.
let cakeRebuildQueued = false;
function updateCake() {
    if (cakeRebuildQueued) return;
    cakeRebuildQueued = true;
    requestAnimationFrame(() => {
        cakeRebuildQueued = false;
        if (cakeGroup) rebuildCake();
    });
}

function rebuildCake() {
    if (!cakeGroup || !previewScene) return;

    // Gather latest configurations from UI controls
    const cakeModel = document.getElementById('cake-model')?.value || 'classic-tiered';
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

    // 2. Build the cake from the shared model kit. This is literally the same
    //    code path the viewer runs, so what the sender previews and what the
    //    recipient opens can no longer drift apart.
    const customText = document.getElementById('custom-topper-text')?.value.trim() || '';
    const { candlePlacerRadius, candleBaseY, isHeartShape } = buildCakeModel(cakeGroup, {
        cakeModel,
        plateStyle,
        glazeStyle,
        topperStyle,
        topperText: customText,
        themeName: getActiveThemeName(),
        themeColors: getThemeRGBColors(),
        strawberries: strawberriesCount,
        cherries: cherriesCount,
        rolls: rollsCount,
        sprinkles: sprinklesEnabled,
        glazeColor,
        creamColor,
        plateColor,
        topperColor,
        detail: isMobileViewport() ? 0.6 : 1
    });

    // Realistic Candles builder
    const candleGeo = new THREE.CylinderGeometry(0.046, 0.052, 0.45, 20);
    const wickGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.08, 8);
    const waxCollarGeo = new THREE.SphereGeometry(0.05, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);

    // Realistic Organic Teardrop Flame Geometry
    const flameGeo = new THREE.SphereGeometry(0.065, 16, 16);
    const flamePos = flameGeo.attributes.position;
    for (let i = 0; i < flamePos.count; i++) {
        let x = flamePos.getX(i);
        let y = flamePos.getY(i);
        let z = flamePos.getZ(i);
        
        if (y > 0.0) {
            y *= 2.2;
            const taper = 1.0 - (y / 0.16);
            x *= Math.max(0.1, taper);
            z *= Math.max(0.1, taper);
        } else {
            y *= 0.8;
        }
        flamePos.setXYZ(i, x, y + 0.05, z);
    }
    flameGeo.computeVertexNormals();

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

        const cColor = candleColor ? new THREE.Color(candleColor) : candleColors[i % candleColors.length];
        const candleMat = new THREE.MeshStandardMaterial({ color: cColor, roughness: 0.5 });

        const stick = new THREE.Mesh(candleGeo, candleMat);
        stick.position.y = 0.225;
        stick.castShadow = true;
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

        let cX = Math.cos(angle) * candlePlacerRadius;
        let cZ = Math.sin(angle) * candlePlacerRadius;
        if (isHeartShape) {
            cZ = (Math.sin(angle) * 0.85 - 0.2) * candlePlacerRadius;
        }

        candleGroup.position.set(cX, candleBaseY, cZ);
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
/** Theme currently selected in the creator's theme picker. */
function getActiveThemeName() {
    const activeThemeBtn = document.querySelector('.theme-btn.active');
    return activeThemeBtn ? activeThemeBtn.dataset.theme : 'neon-rose';
}

function getThemeRGBColors(themeName = null) {
    if (!themeName) {
        themeName = getActiveThemeName();
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
