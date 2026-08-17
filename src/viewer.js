import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import anime from 'animejs';
import confetti from 'canvas-confetti';
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

// State management for Receiver Viewer Mode
let renderer = null;
let scene = null;
let sceneLights = null;
let bloomComposer = null;
let camera = null;
let controls = null;
let animationId = null;
let cakeGroup = null;

// Dynamic arrays
let candles = [];       // { group, flame, light, isLit }
let balloons = [];      // { mesh, floatSpeed, swaySpeed, swayOffset }
let gifts = [];         // { mesh, floatSpeed, swaySpeed, swayOffset, rotSpeed }
let notes = [];         // { mesh, floatSpeed, swaySpeed, swayOffset, rotSpeed }
let embers = [];        // { mesh, speedY, speedX, life }
let holographicRings = [];
let floatingSprinkles = [];
let emCoils = [];
let celebrationConfetti = []; // V4.6 Orbiting and falling 3D WebGL confetti shards
let envelopeGroup = null;
let envelopePointer = null;
let envelopeLabel = null;
let isViewingLetter = false;
let preZoomCameraPos = new THREE.Vector3();
let preZoomControlsTarget = new THREE.Vector3();
let typewriterInterval = null;

// Cyberpunk Console Logging Utilities
function logToCyberConsole(text, type = 'default') {
    const container = document.getElementById('console-lines-container');
    if (!container) return;
    
    const line = document.createElement('div');
    line.className = 'console-line';
    if (type === 'cyan') line.className = 'console-line text-cyan';
    else if (type === 'pink') line.className = 'console-line text-pink';
    else if (type === 'green') line.className = 'console-line text-green';
    else if (type === 'warning') line.className = 'console-line text-warning';
    
    line.innerHTML = `&gt; ${text}`;
    container.appendChild(line);
    
    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
}

function streamBootSequence() {
    const container = document.getElementById('console-lines-container');
    if (container) container.innerHTML = '';
    
    const lines = [
        { text: 'SYSTEM INITIALIZING: QUANTUM_PASTRY CORE V4.0...', type: 'cyan', delay: 100 },
        { text: 'LOADING WEBGL CORE CONTEXT...', type: 'default', delay: 300 },
        { text: 'THREE.JS RENDER ENGINE INITIALIZED [OK]', type: 'green', delay: 500 },
        { text: 'MOUNTING PROCEDURAL CAKE CRUMB TEXTURE GENERATOR [OK]', type: 'green', delay: 700 },
        { text: 'COMPILING PHYSICAL CLEARCOAT REFRACTION SHADERS [OK]', type: 'green', delay: 900 },
        { text: 'GENERATING DYNAMIC HOLOGRAPHIC CONCENTRIC SCAN RINGS...', type: 'cyan', delay: 1100 },
        { text: 'CALIBRATING ELECTRO-MAGNETIC NEO-CANDLE COLLARS...', type: 'default', delay: 1300 },
        { text: 'SYNTHESIZING CHROMATIC 3-VOICE SYNTH NODES AT 48000HZ...', type: 'cyan', delay: 1500 },
        { text: 'ACTIVATING REAL-TIME MIC DECRYPTOR & BLOW ANALYSER...', type: 'pink', delay: 1700 },
        { text: 'AWAITING USER SURPRISE SECTOR IGNITION [READY]...', type: 'green', delay: 1900 }
    ];
    
    lines.forEach(item => {
        setTimeout(() => {
            logToCyberConsole(item.text, item.type);
            const statusEl = document.querySelector('.hud-status');
            if (statusEl && item.text.includes('READY')) {
                statusEl.textContent = 'STATUS: CORE_SYSTEMS_ACTIVE';
            }
        }, item.delay);
    });
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
    // Deterministic (no Math.random) so the finish stays stable per card.
    const SWIPES = 34;
    ctx.lineCap = 'round';
    for (let i = 0; i < SWIPES; i++) {
        const t = i / SWIPES;
        const x = t * SIZE;
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

// Parallax target tracking
let mouseParallax = { x: 0, y: 0 };

// Geometries cache for embers to optimize garbage collection
let emberGeo = null;
let emberMat = null;

// Web Audio API State
let audioCtx = null;
let micStream = null;
let micAnalyser = null;
let micDataArray = null;
let synthIntervalId = null;
let synthOscillators = [];
let isAudioPlaying = false;
let isMicActive = true;
let isMuted = false;

// Card Configuration (Passed from main.js)
let activeConfig = null;
let allCandlesExtinguished = false;

// Shared V3.0 Global variables
let flameMaterial = null;
let starDust = null;
let starGeometry = null;
let starMaterial = null;
let starData = [];
let photoFrameGroup = null;

const defaultBlessings = [
    "Wishing you joy! 💖",
    "You are the best! ⭐",
    "Have a sweet year! 🎂",
    "Sparkle on, คุณพลอย! ✨",
    "May your dreams come true! 🌈",
    "Cheers to another amazing year! 🥂",
    "You inspire us daily! 👑",
    "Health and happiness always! 🌸",
    "สุขสันต์วันเกิดนะคุณพลอย! 🎉"
];

export function initViewer(config) {
    activeConfig = config;
    allCandlesExtinguished = false;
    
    // Bind UI HUD controls
    setupHUDListeners();

    // Initialize Receiver Language Switcher
    const receiverLangSwitcher = document.getElementById('lang-switcher-receiver');
    if (receiverLangSwitcher) {
        receiverLangSwitcher.value = getCurrentLang();
        receiverLangSwitcher.addEventListener('change', (e) => {
            saveLanguageSetting(e.target.value);
            applyDOMTranslations();
            setupViewerEnvelope(); // Rebuild envelope and its 3D label dynamically
        });
    }
    applyDOMTranslations();

    // Setup Envelope Welcome Gate trigger
    const btnOpen = document.getElementById('btn-open-envelope');
    const gate = document.getElementById('envelope-gate');
    
    if (btnOpen) {
        btnOpen.addEventListener('click', () => {
            if (gate) {
                // Animate envelope opening transition
                anime({
                    targets: '.envelope',
                    scale: [1, 0.9, 1.1, 0],
                    rotate: '1turn',
                    opacity: 0,
                    duration: 1000,
                    easing: 'easeInOutBack',
                    complete: () => {
                        gate.classList.remove('active-gate');
                        
                        // Initialize Audio Context & Play music (triggered by user interaction)
                        initAudioContext();
                        
                        // Start full WebGL 3D experience
                        init3DScene();
                    }
                });
            }
        });
    }

    // Bind back to creator button
    const btnBack = document.getElementById('btn-back-creator');
    if (btnBack) {
        btnBack.addEventListener('click', () => {
            window.location.hash = '#/';
        });
    }

    // Bind close letter popup button
    const btnCloseLetter = document.getElementById('btn-close-letter');
    if (btnCloseLetter) {
        btnCloseLetter.addEventListener('click', () => {
            closeLetterPopup();
        });
    }

    // Bind click/tap listener to the interactive envelope container to open it manually
    const envContainer = document.getElementById('letter-envelope-container');
    if (envContainer) {
        envContainer.addEventListener('click', () => {
            if (!envContainer.classList.contains('open')) {
                openEnvelopeWithAnimation();
            }
        });
    }
}

export function destroyViewer() {
    // 1. Stop animation loop
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }

    // 2. Remove mouse listeners
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('resize', onViewerResize);

    // 3. Stop procedural synth audio
    stopBirthdaySynth();
    stopMicAnalysis();
    
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }

    // 4. Clean up DOM Elements & Canvas
    const container = document.getElementById('greeting-canvas-container');
    if (container) container.innerHTML = '';

    // 5. Dispose of Three.js Geometries & Materials
    if (renderer) {
        if (scene) {
            scene.traverse((object) => {
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
        renderer.dispose();
        renderer = null;
        scene = null;
        camera = null;
        controls = null;
        cakeGroup = null;
        candles = [];
        balloons = [];
        gifts = [];
        notes = [];
        
        holographicRings.forEach(r => {
            scene.remove(r);
            if (r.geometry) r.geometry.dispose();
            if (r.material) r.material.dispose();
        });
        holographicRings = [];

        floatingSprinkles.forEach(s => {
            scene.remove(s.mesh);
            if (s.mesh.geometry) s.mesh.geometry.dispose();
            if (s.mesh.material) s.mesh.material.dispose();
        });
        floatingSprinkles = [];

        emCoils = [];
        
        embers.forEach(e => {
            if (e.mesh.geometry) e.mesh.geometry.dispose();
        });
        embers = [];
        
        if (emberGeo) {
            emberGeo.dispose();
            emberGeo = null;
        }
        if (emberMat) {
            emberMat.dispose();
            emberMat = null;
        }

        if (celebrationConfetti) {
            celebrationConfetti.forEach(c => {
                scene.remove(c.mesh);
                if (c.mesh.geometry) c.mesh.geometry.dispose();
                if (c.mesh.material) c.mesh.material.dispose();
            });
            celebrationConfetti = [];
        }

        // V3.0 Clean up
        if (flameMaterial) {
            flameMaterial.dispose();
            flameMaterial = null;
        }
        if (starGeometry) {
            starGeometry.dispose();
            starGeometry = null;
        }
        if (starMaterial) {
            starMaterial.dispose();
            starMaterial = null;
        }
        starDust = null;
        starData = [];
        photoFrameGroup = null;

        // V4.1 Envelope and pointer cleanup
        if (envelopeGroup) {
            scene.remove(envelopeGroup);
            envelopeGroup.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else child.material.dispose();
                }
            });
            envelopeGroup = null;
        }
        if (envelopePointer) {
            scene.remove(envelopePointer);
            if (envelopePointer.geometry) envelopePointer.geometry.dispose();
            if (envelopePointer.material) envelopePointer.material.dispose();
            envelopePointer = null;
        }
        if (envelopeLabel) {
            scene.remove(envelopeLabel);
            if (envelopeLabel.material) {
                if (envelopeLabel.material.map) envelopeLabel.material.map.dispose();
                envelopeLabel.material.dispose();
            }
            envelopeLabel = null;
        }
    }

    if (typewriterInterval) {
        clearInterval(typewriterInterval);
        typewriterInterval = null;
    }
    isViewingLetter = false;

    // Reset overlay modal if open
    const overlay = document.getElementById('letter-popup-overlay');
    if (overlay) overlay.classList.remove('active');

    // 6. Hide Greeting card overlays
    const greetingCard = document.getElementById('greeting-card-wrapper');
    if (greetingCard) {
        greetingCard.classList.remove('active-card');
        greetingCard.classList.add('hidden-card');
    }
    
    // Hide instructions HUD
    const hudInst = document.getElementById('hud-instructions');
    if (hudInst) hudInst.style.display = '';

    // Reset mic visualizer HUD
    const micViz = document.getElementById('mic-visualizer');
    if (micViz) micViz.style.display = 'none';
}

// 1. RECEIVER VIEW HUD LISTENERS
function setupHUDListeners() {
    const btnMic = document.getElementById('btn-hud-mic');
    const btnAudio = document.getElementById('btn-hud-audio');
    const btnReset = document.getElementById('btn-hud-reset');

    if (btnMic) {
        // Toggle mic state
        btnMic.className = isMicActive ? 'hud-btn active' : 'hud-btn';
        btnMic.onclick = () => {
            isMicActive = !isMicActive;
            btnMic.className = isMicActive ? 'hud-btn active' : 'hud-btn';
            
            const micViz = document.getElementById('mic-visualizer');
            if (isMicActive) {
                initMicAnalysis();
            } else {
                stopMicAnalysis();
                if (micViz) micViz.style.display = 'none';
            }
        };
    }

    if (btnAudio) {
        btnAudio.className = isMuted ? 'hud-btn' : 'hud-btn active';
        btnAudio.onclick = () => {
            isMuted = !isMuted;
            btnAudio.className = isMuted ? 'hud-btn' : 'hud-btn active';
            btnAudio.innerHTML = isMuted ? `<i class="fa-solid fa-volume-xmark"></i>` : `<i class="fa-solid fa-volume-high"></i>`;
            
            if (isMuted) {
                stopBirthdaySynth();
            } else if (isAudioPlaying) {
                playBirthdaySynth(activeConfig.music);
            }
        };
    }

    if (btnReset) {
        btnReset.onclick = () => {
            relightCandles();
        };
    }
}

// 2. WEB AUDIO API SYNTHESIZED SOUND & MUSIC
function initAudioContext() {
    try {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        isAudioPlaying = true;

        if (!isMuted) {
            playBirthdaySynth(activeConfig.music);
        }
        
        if (isMicActive) {
            initMicAnalysis();
        }
    } catch (e) {
        console.error('Browser does not support Web Audio API:', e);
    }
}

// Procedural polyphonic 3-voice synthesizer that plays Happy Birthday
function playBirthdaySynth(trackType) {
    stopBirthdaySynth();
    if (!audioCtx) return;

    // Master Compressor routing to avoid clipping and keep warmth
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-20, audioCtx.currentTime);
    compressor.knee.setValueAtTime(30, audioCtx.currentTime);
    compressor.ratio.setValueAtTime(12, audioCtx.currentTime);
    compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
    compressor.release.setValueAtTime(0.25, audioCtx.currentTime);
    compressor.connect(audioCtx.destination);

    const melody = [
        ['G4', 0.25, 0], ['G4', 0.25, 0.3], ['A4', 0.5, 0.6], ['G4', 0.5, 1.1], ['C5', 0.5, 1.6], ['B4', 1.0, 2.1],
        ['G4', 0.25, 3.2], ['G4', 0.25, 3.5], ['A4', 0.5, 3.8], ['G4', 0.5, 4.3], ['D5', 0.5, 4.8], ['C5', 1.0, 5.3],
        ['G4', 0.25, 6.4], ['G4', 0.25, 6.7], ['G5', 0.5, 7.0], ['E5', 0.5, 7.5], ['C5', 0.5, 8.0], ['B4', 0.5, 8.5], ['A4', 0.5, 9.0],
        ['F5', 0.25, 9.7], ['F5', 0.25, 10.0], ['E5', 0.5, 10.3], ['C5', 0.5, 10.8], ['D5', 0.5, 11.3], ['C5', 1.2, 11.8]
    ];

    const harmony = [
        ['C3', 1.0, 0.0], ['E4', 0.5, 0.3], ['G4', 0.5, 0.6], ['C4', 0.5, 1.1], ['E4', 0.5, 1.6], ['G4', 1.0, 2.1],
        ['G2', 1.0, 3.2], ['D4', 0.5, 3.5], ['F4', 0.5, 3.8], ['B4', 0.5, 4.3], ['D4', 0.5, 4.8], ['G4', 1.0, 5.3],
        ['C3', 1.0, 6.4], ['E4', 0.5, 6.7], ['G4', 0.5, 7.0], ['C4', 0.5, 7.5], ['A3', 1.0, 8.0], ['C4', 0.5, 8.5], ['F4', 0.5, 9.0],
        ['F3', 1.0, 9.7], ['A4', 0.5, 10.0], ['G3', 1.0, 10.3], ['D4', 0.5, 10.8], ['E4', 0.5, 11.3], ['C4', 1.2, 11.8]
    ];

    const bass = [
        ['C2', 2.5, 0],
        ['G2', 2.5, 3.2],
        ['C2', 2.5, 6.4],
        ['F2', 1.2, 9.7], ['G2', 1.2, 10.8], ['C2', 1.5, 11.8]
    ];

    const noteFreqMap = {
        'C2': 65.41, 'F2': 87.31, 'G2': 98.00, 'C3': 130.81, 'F3': 174.61, 'G3': 196.00, 'A3': 220.00,
        'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'F4': 349.23, 'G4': 392.00, 'A4': 440.00, 'B4': 493.88,
        'C5': 523.25, 'D5': 587.33, 'E5': 659.25, 'F5': 698.46, 'G5': 783.99, 'A5': 880.00, 'B5': 987.77
    };

    let totalDuration = 13.5;

    function playVoice(freq, duration, delay, type = 'melody') {
        if (!audioCtx || audioCtx.state === 'suspended') return;

        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        osc.connect(gainNode);
        gainNode.connect(compressor);

        if (type === 'melody') {
            if (trackType === 'happy-birthday-synth') {
                osc.type = 'sawtooth';
                const filter = audioCtx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.setValueAtTime(800, audioCtx.currentTime);
                osc.disconnect(gainNode);
                osc.connect(filter);
                filter.connect(gainNode);
            } else if (trackType === 'happy-birthday-piano') {
                osc.type = 'sine';
            } else {
                osc.type = 'triangle';
            }
            
            osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
            gainNode.gain.setValueAtTime(0, audioCtx.currentTime + delay);
            gainNode.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + delay + 0.05);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + duration);

        } else if (type === 'harmony') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
            gainNode.gain.setValueAtTime(0, audioCtx.currentTime + delay);
            gainNode.gain.linearRampToValueAtTime(0.08, audioCtx.currentTime + delay + 0.08);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + duration);

        } else if (type === 'bass') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
            gainNode.gain.setValueAtTime(0, audioCtx.currentTime + delay);
            gainNode.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + delay + 0.1);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + duration);
        }

        osc.start(audioCtx.currentTime + delay);
        osc.stop(audioCtx.currentTime + delay + duration);
        
        synthOscillators.push(osc);
    }

    function loopSong() {
        if (isMuted || !isAudioPlaying) return;
        
        melody.forEach(note => {
            const freq = noteFreqMap[note[0]];
            if (freq) playVoice(freq, note[1], note[2], 'melody');
        });

        harmony.forEach(note => {
            const freq = noteFreqMap[note[0]];
            if (freq) playVoice(freq, note[1], note[2], 'harmony');
        });

        bass.forEach(note => {
            const freq = noteFreqMap[note[0]];
            if (freq) playVoice(freq, note[1], note[2], 'bass');
        });
    }

    loopSong();
    synthIntervalId = setInterval(loopSong, totalDuration * 1000);
}

function stopBirthdaySynth() {
    if (synthIntervalId) {
        clearInterval(synthIntervalId);
        synthIntervalId = null;
    }
    synthOscillators.forEach(osc => {
        try { osc.stop(); } catch (e) {}
    });
    synthOscillators = [];
}

// Procedural sound effect for puff/balloon pops
function playSoundEffect(type) {
    if (!audioCtx || isMuted) return;

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    if (type === 'puff') {
        const bufferSize = audioCtx.sampleRate * 0.15;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1000, audioCtx.currentTime);
        filter.Q.setValueAtTime(2, audioCtx.currentTime);

        noise.connect(filter);
        filter.connect(gainNode);
        
        gainNode.gain.setValueAtTime(0.4, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);

        noise.start();
    } else if (type === 'pop') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(200, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(80, audioCtx.currentTime + 0.12);

        gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.12);

        osc.start();
        osc.stop(audioCtx.currentTime + 0.12);
    } else if (type === 'triumphant') {
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
            const chordOsc = audioCtx.createOscillator();
            const chordGain = audioCtx.createGain();
            chordOsc.connect(chordGain);
            chordGain.connect(audioCtx.destination);
            
            chordOsc.type = 'sine';
            chordOsc.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.08);
            
            chordGain.gain.setValueAtTime(0.15, audioCtx.currentTime + idx * 0.08);
            chordGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + idx * 0.08 + 0.8);
            
            chordOsc.start(audioCtx.currentTime + idx * 0.08);
            chordOsc.stop(audioCtx.currentTime + idx * 0.08 + 0.8);
        });
    } else if (type === 'paper') {
        // Procedurally Synthesized Paper Rustle/Tear
        const duration = 0.5;
        const bufferSize = audioCtx.sampleRate * duration;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        // Fill white noise
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(600, audioCtx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(1400, audioCtx.currentTime + duration);
        filter.Q.setValueAtTime(3.0, audioCtx.currentTime);

        noise.connect(filter);
        filter.connect(gainNode);
        
        gainNode.gain.setValueAtTime(0.001, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.25, audioCtx.currentTime + 0.05);
        gainNode.gain.exponentialRampToValueAtTime(0.05, audioCtx.currentTime + 0.25);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

        noise.start();
        noise.stop(audioCtx.currentTime + duration);

        // Procedural chime tone sweep for magic envelope opening feedback
        const chime = audioCtx.createOscillator();
        const chimeGain = audioCtx.createGain();
        chime.connect(chimeGain);
        chimeGain.connect(audioCtx.destination);
        
        chime.type = 'sine';
        chime.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
        chime.frequency.exponentialRampToValueAtTime(1046.50, audioCtx.currentTime + duration); // C6
        
        chimeGain.gain.setValueAtTime(0.001, audioCtx.currentTime);
        chimeGain.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + 0.1);
        chimeGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        
        chime.start();
        chime.stop(audioCtx.currentTime + duration);
    }
}

// Procedural synthesizer sound effects when clicking a musical note
function playChimeEffect(freq) {
    if (!audioCtx || isMuted) return 0;
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    osc.type = 'sine';
    
    const notesFreqs = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50, 1174.66];
    const finalFreq = freq || notesFreqs[Math.floor(Math.random() * notesFreqs.length)];
    
    osc.frequency.setValueAtTime(finalFreq, audioCtx.currentTime);
    
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.2);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 1.2);
    return finalFreq;
}

// 3. MICROPHONE ANALYSIS FOR BLOW DETECTION
function initMicAnalysis() {
    if (!audioCtx) return;

    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(stream => {
            micStream = stream;
            const micSource = audioCtx.createMediaStreamSource(stream);
            micAnalyser = audioCtx.createAnalyser();
            micAnalyser.fftSize = 256;
            
            micSource.connect(micAnalyser);
            
            const bufferLength = micAnalyser.frequencyBinCount;
            micDataArray = new Uint8Array(bufferLength);

            const micViz = document.getElementById('mic-visualizer');
            if (micViz) micViz.style.display = 'block';
        })
        .catch(err => {
            console.warn('Microphone permission denied, falling back to mouse/click interaction:', err);
            isMicActive = false;
            const btnMic = document.getElementById('btn-hud-mic');
            if (btnMic) btnMic.className = 'hud-btn';
        });
}

function stopMicAnalysis() {
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    micAnalyser = null;
    micDataArray = null;
}

function checkMicBlowLevel() {
    if (!micAnalyser || !micDataArray || !isMicActive || allCandlesExtinguished) return;

    micAnalyser.getByteFrequencyData(micDataArray);

    let amplitudeSum = 0;
    const minBin = 15;
    const maxBin = 40;

    for (let i = minBin; i <= maxBin; i++) {
        amplitudeSum += micDataArray[i];
    }
    
    const averageBlowVolume = amplitudeSum / (maxBin - minBin + 1);

    const micBar = document.getElementById('mic-bar');
    if (micBar) {
        micBar.style.height = `${Math.min(100, (averageBlowVolume / 180) * 100)}%`;
    }

    if (averageBlowVolume > 115) {
        extinguishNextCandle();
    }
}

// 4. FULL IMMERSIVE 3D SCENE SETUP
function init3DScene() {
    const container = document.getElementById('greeting-canvas-container');
    if (!container) return;

    container.innerHTML = '';

    const width = window.innerWidth;
    const height = window.innerHeight;

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x06020f, 0.015);

    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 5, 10);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    applyCinematicRenderer(renderer, {
        exposure: 1.05,
        // The viewer runs a much heavier scene than the preview, so stay
        // conservative on phones.
        maxPixelRatio: isMobileViewport() ? 1.5 : 2
    });

    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 4;
    controls.maxDistance = 25;
    controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN
    };
    updateCameraForViewport();

    // Studio IBL — real reflections on glaze, cherries and the cake stand
    attachStudioEnvironment(renderer, scene);

    sceneLights = setupStudioLighting(scene, { rimColor: 0xff0055 });

    // Soft point light inside cake group area
    const pointLight = new THREE.PointLight(0xff0055, 0.9, 10);
    pointLight.position.set(0, 2, 0);
    scene.add(pointLight);

    // Initializing particle helpers
    emberGeo = new THREE.DodecahedronGeometry(0.015, 0);
    emberMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    // Start terminal boot sequence logging
    streamBootSequence();

    // Build the Cake Group
    cakeGroup = new THREE.Group();
    build3DViewerCake();
    scene.add(cakeGroup);

    // Setup asset layers
    setupViewerCandles();
    setupViewerBalloons();
    setupViewerGifts();
    setupViewerNotes();
    setupViewerStarDust();
    setupFloatingPhotoFrame();
    setupHolographicRings();
    setupFloatingSprinkles();
    setupViewerEnvelope();

    // Apply environment reflections to everything that was just built, and
    // tint the rim light with the card's own cream color.
    tuneMaterialsForEnvironment(cakeGroup, 0.6);
    if (sceneLights && activeConfig?.creamColor) {
        sceneLights.rim.color.set(activeConfig.creamColor);
    }

    camera.lookAt(new THREE.Vector3(0, 0.5, 0));
    controls.target.set(0, 0.5, 0);

    // Bloom post-processing — the candle flames and holo rings are the whole
    // point of this scene, so they get a real glow.
    bloomComposer = createBloomComposer(renderer, scene, camera);

    // Listeners
    renderer.domElement.addEventListener('pointerdown', onSceneClick);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('resize', onViewerResize);

    const clock = new THREE.Clock();

    function renderLoop() {
        animationId = requestAnimationFrame(renderLoop);

        const delta = clock.getDelta();
        const elapsed = clock.getElapsedTime();

        // Rotate Cake Group
        if (cakeGroup && !allCandlesExtinguished) {
            cakeGroup.rotation.y = elapsed * 0.12;
            cakeGroup.position.y = Math.sin(elapsed * 1.2) * 0.05;
        }

        // Camera Parallax
        if (controls && !allCandlesExtinguished) {
            controls.target.x += (mouseParallax.x * 1.5 - controls.target.x) * 0.05;
            controls.target.y += ((0.5 - mouseParallax.y * 1.0) - controls.target.y) * 0.05;
        }

        controls.update();

        // Update Flame Shader time
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

        // Update continuous HUD clock time
        const hudTimer = document.getElementById('hud-timer');
        if (hudTimer) {
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = Math.floor(elapsed % 60).toString().padStart(2, '0');
            const ms = Math.floor((elapsed % 1) * 100).toString().padStart(2, '0');
            hudTimer.textContent = `T+00:${minutes}:${seconds}.${ms}`;
        }

        // Update floating tech coordinates
        const hudCoords = document.querySelector('.hud-coords');
        if (hudCoords && camera) {
            const cx = (camera.position.x + Math.sin(elapsed) * 0.05).toFixed(3);
            const cy = (camera.position.y + Math.cos(elapsed) * 0.05).toFixed(3);
            const cz = camera.position.z.toFixed(3);
            hudCoords.textContent = `CAM_X:${cx} // CAM_Y:${cy} // CAM_Z:${cz}`;
        }

        // Update Star Dust particles
        if (starDust && starGeometry) {
            const positions = starGeometry.attributes.position.array;
            const count = positions.length / 3;
            for (let i = 0; i < count; i++) {
                const data = starData[i];
                positions[i * 3 + 1] += data.speedY;
                positions[i * 3] = data.x + Math.sin(elapsed * data.swaySpeed + data.swayOffset) * 0.25;
                if (positions[i * 3 + 1] > 6) {
                    positions[i * 3 + 1] = -3;
                }
            }
            starGeometry.attributes.position.needsUpdate = true;
        }

        // Update Floating Picture Frame Bobbing
        if (photoFrameGroup) {
            photoFrameGroup.position.y = 1.8 + Math.sin(elapsed * 1.2) * 0.15;
            photoFrameGroup.rotation.y = -Math.PI / 4 + Math.sin(elapsed * 0.6) * 0.1;
            photoFrameGroup.rotation.z = Math.sin(elapsed * 0.8) * 0.05;
        }

        // 1. Flicker Candle Flames & Spawn Particles
        candles.forEach(candle => {
            if (candle.isLit) {
                const scaleTime = elapsed * 10 + candle.group.position.x * 20;
                candle.flame.scale.y = 1.0 + Math.sin(scaleTime) * 0.2;
                candle.flame.scale.x = 1.0 + Math.cos(scaleTime * 1.5) * 0.15;
                candle.flame.scale.z = 1.0 + Math.sin(scaleTime * 1.2) * 0.15;
                
                candle.light.intensity = 1.8 + Math.sin(scaleTime * 2.0) * 0.3;

                // Candle Embers Spawn
                if (Math.random() < 0.08) {
                    const ember = new THREE.Mesh(emberGeo, emberMat);
                    const worldPos = new THREE.Vector3();
                    candle.flame.getWorldPosition(worldPos);
                    
                    ember.position.copy(worldPos);
                    ember.position.y += 0.1;
                    ember.position.x += (Math.random() - 0.5) * 0.05;
                    ember.position.z += (Math.random() - 0.5) * 0.05;
                    
                    scene.add(ember);
                    embers.push({
                        mesh: ember,
                        speedY: 0.01 + Math.random() * 0.015,
                        speedX: (Math.random() - 0.5) * 0.005,
                        life: 1.0
                    });
                }
            }
        });

        // Update Embers (V4.6 supports full 3D volumetric trajectory)
        embers.forEach(ember => {
            ember.mesh.position.y += ember.speedY;
            ember.mesh.position.x += ember.speedX;
            if (ember.speedZ) {
                ember.mesh.position.z += ember.speedZ;
            }
            ember.mesh.position.x += Math.sin(elapsed * 8) * 0.002;
            ember.life -= 0.02;
            ember.mesh.scale.setScalar(ember.life);
            if (ember.life <= 0) {
                scene.remove(ember.mesh);
            }
        });
        // Update celebrationConfetti particles (V4.6 volumetric confetti updates)
        celebrationConfetti.forEach(particle => {
            particle.angle += particle.orbitSpeed * delta;
            particle.mesh.position.x = Math.cos(particle.angle) * particle.radius;
            particle.mesh.position.z = Math.sin(particle.angle) * particle.radius;
            particle.mesh.position.y += particle.speedY;
            
            // Wobble
            particle.mesh.position.x += Math.sin(elapsed * 5 + particle.angle) * 0.02;
            
            // Rotations
            particle.mesh.rotation.x += particle.rotSpeed.x * delta;
            particle.mesh.rotation.y += particle.rotSpeed.y * delta;
            particle.mesh.rotation.z += particle.rotSpeed.z * delta;
            
            // Fade out when falling too low or naturally
            particle.life -= particle.fadeSpeed;
            if (particle.mesh.material) {
                particle.mesh.material.opacity = Math.max(0, Math.min(0.9, particle.life));
            }
            particle.mesh.scale.setScalar(Math.max(0, particle.life));
            
            if (particle.life <= 0 || particle.mesh.position.y < -2) {
                scene.remove(particle.mesh);
                if (particle.mesh.geometry) particle.mesh.geometry.dispose();
                if (particle.mesh.material) particle.mesh.material.dispose();
                particle.life = 0;
            }
        });
        celebrationConfetti = celebrationConfetti.filter(p => p.life > 0);

        // 2. Animate balloons
        balloons.forEach(balloon => {
            balloon.mesh.position.y += balloon.floatSpeed * delta * 50;
            if (balloon.mesh.position.y > 10) {
                balloon.mesh.position.y = -6;
                balloon.mesh.position.x = (Math.random() - 0.5) * 8;
                balloon.mesh.position.z = (Math.random() - 0.5) * 8;
            }
            balloon.mesh.position.x += Math.sin(elapsed * balloon.swaySpeed + balloon.swayOffset) * 0.008;
            balloon.mesh.position.z += Math.cos(elapsed * balloon.swaySpeed * 0.8 + balloon.swayOffset) * 0.0085;
            balloon.mesh.rotation.z = Math.sin(elapsed * 0.5 + balloon.swayOffset) * 0.1;
        });

        // 3. Animate gifts
        gifts.forEach(gift => {
            gift.mesh.position.y += gift.floatSpeed * delta * 50;
            if (gift.mesh.position.y > 8) {
                gift.mesh.position.y = -5;
                gift.mesh.position.x = (Math.random() - 0.5) * 8.5;
                gift.mesh.position.z = (Math.random() - 0.5) * 8.5;
            }
            gift.mesh.position.x += Math.sin(elapsed * gift.swaySpeed + gift.swayOffset) * 0.005;
            gift.mesh.position.z += Math.cos(elapsed * gift.swaySpeed * 0.7 + gift.swayOffset) * 0.005;
            gift.mesh.rotation.x += gift.rotSpeed.x;
            gift.mesh.rotation.y += gift.rotSpeed.y;
            gift.mesh.rotation.z += gift.rotSpeed.z;
        });

        // 4. Animate musical notes
        notes.forEach(note => {
            note.mesh.position.y += note.floatSpeed * delta * 50;
            if (note.mesh.position.y > 8) {
                note.mesh.position.y = -5;
                note.mesh.position.x = (Math.random() - 0.5) * 9.0;
                note.mesh.position.z = (Math.random() - 0.5) * 9.0;
            }
            note.mesh.position.x += Math.sin(elapsed * note.swaySpeed + note.swayOffset) * 0.006;
            note.mesh.position.z += Math.cos(elapsed * note.swaySpeed * 0.8 + note.swayOffset) * 0.006;
            note.mesh.rotation.y += note.rotSpeed;
            note.mesh.rotation.z = Math.sin(elapsed * 1.5 + note.swayOffset) * 0.15;
        });

        if (envelopeGroup) {
            envelopeGroup.position.y = 1.6 + Math.sin(elapsed * 1.2) * 0.05;
            envelopeGroup.rotation.y = Math.PI / 4 + Math.cos(elapsed * 0.8) * 0.05;
        }
        if (envelopePointer) {
            envelopePointer.position.y = 2.2 + Math.sin(elapsed * 3.0) * 0.1;
            envelopePointer.rotation.y = elapsed * 2.0;
        }
        if (envelopeLabel) {
            const pulse = 1.0 + Math.sin(elapsed * 2.5) * 0.05;
            envelopeLabel.scale.set(1.8 * pulse, 0.45 * pulse, 1.0);
        }

        checkMicBlowLevel();

        if (bloomComposer) {
            bloomComposer.composer.render(delta);
        } else if (renderer && scene && camera) {
            renderer.render(scene, camera);
        }
    }

    renderLoop();
}

function onMouseMove(event) {
    mouseParallax.x = (event.clientX / window.innerWidth) - 0.5;
    mouseParallax.y = (event.clientY / window.innerHeight) - 0.5;
}

function updateCameraForViewport() {
    if (!camera) return;
    const aspect = window.innerWidth / window.innerHeight;
    if (aspect < 1.0) {
        // Mobile portrait mode: extend camera distance so 3D scene fits mobile viewport
        const distFactor = Math.max(0.48, aspect);
        const zDist = 10 / (distFactor * 0.9);
        camera.position.set(0, zDist * 0.45, zDist);
    } else {
        camera.position.set(0, 5, 10);
    }
}

function onViewerResize() {
    if (!renderer || !camera) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    updateCameraForViewport();
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (bloomComposer) bloomComposer.setSize(window.innerWidth, window.innerHeight);
}

// 5. CAKE AND ASSETS BUILDERS FOR VIEW MODE

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
    geo.center();
    geo.rotateX(Math.PI / 2);
    return geo;
}

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

function getGlazeMaterial(glazeStyle, customColor = '') {
    let colorHex = 0xfffaf0;
    let roughness = 0.2;
    let clearcoat = 1.0;
    
    switch (glazeStyle) {
        case 'chocolate':
            colorHex = 0x311a11;
            roughness = 0.12;
            break;
        case 'strawberry':
            colorHex = 0xe92e52;
            roughness = 0.08;
            break;
        case 'mint':
            colorHex = 0x7be2a6;
            roughness = 0.15;
            break;
        case 'cream':
        default:
            colorHex = 0xfffcf7;
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

function createWaferRollTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#edd1b8';
    ctx.fillRect(0, 0, 128, 128);
    
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

function createStrawberryMesh() {
    const group = new THREE.Group();
    
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
    body.rotation.x = Math.PI;
    body.position.y = 0.08;
    body.castShadow = true;
    group.add(body);
    
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

function createCherryMesh() {
    const group = new THREE.Group();
    
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
        
        const angle = 0.15 + (i * 0.08);
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

function createTopperMesh(topperStyle, customText = '', customRimColor = '') {
    if (topperStyle === 'none' && !customText) return null;
    
    const group = new THREE.Group();
    
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
        const themeName = activeConfig.theme || 'neon-rose';
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
 * The offsets are derived from the index (no Math.random) so the same card link
 * always renders the same cake.
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
        cream.rotation.set(
            0.1 + Math.sin(seed * 1.3) * 0.05,
            -angle + Math.cos(seed) * 0.25,
            Math.sin(seed * 2.7) * 0.04
        );

        const s = 1.5 + Math.sin(seed * 4.1) * 0.11;
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
            // poisoned the whole geometry's bounding sphere (breaking frustum
            // culling and raycast hits on the cream).
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

function build3DViewerCake() {
    const plateStyle = activeConfig.plate || 'ceramic';
    const glazeStyle = activeConfig.glaze || 'chocolate';
    const topperStyle = activeConfig.topper || 'best-senpai';
    const strawberriesCount = activeConfig.strawberries !== undefined ? parseInt(activeConfig.strawberries) : 4;
    const cherriesCount = activeConfig.cherries !== undefined ? parseInt(activeConfig.cherries) : 4;
    const rollsCount = activeConfig.rolls !== undefined ? parseInt(activeConfig.rolls) : 3;
    const sprinklesEnabled = activeConfig.sprinkles !== undefined ? !!activeConfig.sprinkles : true;

    // Gather custom colors
    const glazeColor = activeConfig.glazeColor || '';
    const creamColor = activeConfig.creamColor || '';
    const plateColor = activeConfig.plateColor || '';
    const topperColor = activeConfig.topperColor || '';

    const themeColors = getThemeRGBColors(activeConfig.theme);
    const glazeMat = getGlazeMaterial(glazeStyle, glazeColor);
    const plateMat = getPlateMaterial(plateStyle, plateColor);

    // Cake Stand
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

    // Dynamic tier colors
    const colorTier1 = creamColor ? new THREE.Color(creamColor) : themeColors.tier1;
    const colorTier2 = creamColor ? new THREE.Color(creamColor) : themeColors.tier2;

    // Cake Tier 1
    const tier1Geo = createBeveledCylinder(2.0, 1.0, 0.08);
    const crumbBumpTex = createCakeCrumbBumpTexture();
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

    // Cake Tier 2
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

    // Glaze Cap
    const glazeTopGeo = createBeveledCylinder(1.44, 0.12, 0.03);
    const glazeTop = new THREE.Mesh(glazeTopGeo, glazeMat);
    glazeTop.position.y = 1.3;
    glazeTop.castShadow = true;
    glazeTop.receiveShadow = true;
    cakeGroup.add(glazeTop);

    // Glaze Drips
    addGlazeDrips(cakeGroup, glazeMat, 24, 1.425, 1.3, 5);

    // Crumbs and stray sprinkles shed onto the stand during decorating
    addStandDebris(cakeGroup, -0.49, 2.6, creamColor || themeColors.tier1);

    // Strawberries (V4.6 Tagged for click interactivity)
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
            strawberry.name = 'strawberry';
            cakeGroup.add(strawberry);
        }
    }

    // Cherries (V4.6 Tagged for click interactivity)
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
            cherry.name = 'cherry';
            cakeGroup.add(cherry);
        }
    }

    // Wafer Rolls (V4.6 Tagged for click interactivity)
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
            rollGroup.name = 'wafer-roll';
            
            cakeGroup.add(rollGroup);
        }
    }

    // Sprinkles
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

    // Center Topper
    const topper = createTopperMesh(topperStyle, activeConfig.topperText, topperColor);
    if (topper) {
        topper.position.set(0, 1.35, 0);
        cakeGroup.add(topper);
    }
}

function getThemeRGBColors(themeName) {
    switch (themeName) {
        case 'midnight-gold':
            return {
                tier1: 0x151310,
                tier2: 0x2b2214,
                cream: 0xffd700
            };
        case 'pastel-mint':
            return {
                tier1: 0x3d8df5,
                tier2: 0x00d2ec,
                cream: 0xffffff
            };
        case 'lavender-dream':
            return {
                tier1: 0x22003c,
                tier2: 0x7000df,
                cream: 0xca4cff
            };
        case 'sakura-blossom':
            return {
                tier1: 0xffb3c6,
                tier2: 0xffe3ec,
                cream: 0xff758f
            };
        case 'cyber-retro':
            return {
                tier1: 0xff5e62,
                tier2: 0xff9966,
                cream: 0xff3399
            };
        case 'forest-moss':
            return {
                tier1: 0x004b23,
                tier2: 0x38b000,
                cream: 0xd4af37
            };
        case 'cosmic-nebula':
            return {
                tier1: 0x0f0c20,
                tier2: 0x00f2fe,
                cream: 0x00ffd5
            };
        case 'choco-monarch':
            return {
                tier1: 0x241108,
                tier2: 0x4a2c11,
                cream: 0xcca43b
            };
        case 'neon-rose':
        default:
            return {
                tier1: 0xed004c,
                tier2: 0x3f0085,
                cream: 0xffffff
            };
    }
}

// Mount custom count of candles
function setupViewerCandles() {
    candles = [];
    const candleCount = activeConfig.candles || 5;
    const candlePlacerRadius = 0.72;

    // 20 sides instead of 8: at this scale an 8-gon candle reads as an octagon.
    // Slight taper toward the top, like a real dipped/extruded wax candle.
    const candleGeo = new THREE.CylinderGeometry(0.046, 0.052, 0.45, 20);
    const wickGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.08, 8);
    const flameGeo = new THREE.ConeGeometry(0.07, 0.20, 12);

    const candleColors = [0x55ffaa, 0xffbb44, 0xff55aa, 0x44bbff, 0xdd88ff];
    const wickMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });

    // Initialize shared GLSL flame material
    if (!flameMaterial) {
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
    }

    for (let i = 0; i < candleCount; i++) {
        const angle = (i / candleCount) * Math.PI * 2;
        const candleGroup = new THREE.Group();

        const cColor = activeConfig.candleColor ? new THREE.Color(activeConfig.candleColor) : candleColors[i % candleColors.length];
        const candleMat = new THREE.MeshStandardMaterial({ color: cColor, roughness: 0.5 });

        const stick = new THREE.Mesh(candleGeo, candleMat);
        stick.position.y = 0.225;
        stick.castShadow = true;
        candleGroup.add(stick);

        // Polished copper base collar at y = 0.03
        const copperCollarGeo = new THREE.CylinderGeometry(0.065, 0.065, 0.06, 24);
        const copperCollarMat = new THREE.MeshStandardMaterial({
            color: 0xd35400,
            roughness: 0.08,
            metalness: 0.95
        });
        const copperCollar = new THREE.Mesh(copperCollarGeo, copperCollarMat);
        copperCollar.position.y = 0.03;
        copperCollar.castShadow = true;
        candleGroup.add(copperCollar);

        // Polished chrome shaft collar below the wick at y = 0.44
        const chromeCollarGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 24);
        const chromeCollarMat = new THREE.MeshStandardMaterial({
            color: 0xcccccc,
            roughness: 0.05,
            metalness: 0.98
        });
        const chromeCollar = new THREE.Mesh(chromeCollarGeo, chromeCollarMat);
        chromeCollar.position.y = 0.44;
        chromeCollar.castShadow = true;
        candleGroup.add(chromeCollar);

        // Floating glowing neon Torus coil (emCoils) at y = 0.35
        const coilGeo = new THREE.TorusGeometry(0.08, 0.016, 12, 32);
        const coilMat = new THREE.MeshStandardMaterial({
            color: 0x00f2fe,
            emissive: 0x00f2fe,
            emissiveIntensity: 1.5,
            roughness: 0.1,
            metalness: 0.9
        });
        const coil = new THREE.Mesh(coilGeo, coilMat);
        coil.rotation.x = Math.PI / 2;
        coil.position.y = 0.35;
        candleGroup.add(coil);

        emCoils.push({
            mesh: coil,
            baseY: 0.35,
            speedY: 1.8 + Math.random() * 0.5,
            offsetY: Math.random() * Math.PI,
            rotSpeed: 1.0 + Math.random() * 1.5
        });

        const wick = new THREE.Mesh(wickGeo, wickMat);
        wick.position.y = 0.48;
        candleGroup.add(wick);

        const flame = new THREE.Mesh(flameGeo, flameMaterial);
        flame.position.y = 0.58;
        flame.name = 'flame';
        candleGroup.add(flame);

        const fireLight = new THREE.PointLight(0xffb800, 2.0, 4);
        fireLight.position.set(0, 0.7, 0);
        fireLight.castShadow = true;
        fireLight.shadow.bias = -0.002;
        candleGroup.add(fireLight);

        candleGroup.position.set(
            Math.cos(angle) * candlePlacerRadius,
            1.35,
            Math.sin(angle) * candlePlacerRadius
        );

        cakeGroup.add(candleGroup);

        candles.push({
            group: candleGroup,
            flame: flame,
            light: fireLight,
            isLit: true
        });
    }
}

// Floating colorful 3D balloons setup
function setupViewerBalloons() {
    balloons = [];
    const colors = [0xff0055, 0x00f2fe, 0xffd700, 0xd155ff, 0x05ffb0, 0xff9900];
    const balloonCount = 8;

    const sphereGeo = new THREE.SphereGeometry(0.35, 16, 16);
    const knotGeo = new THREE.ConeGeometry(0.06, 0.1, 8);

    for (let i = 0; i < balloonCount; i++) {
        const balloonMesh = new THREE.Group();

        const color = colors[i % colors.length];
        const balloonMat = new THREE.MeshStandardMaterial({
            color: color,
            roughness: 0.1,
            metalness: 0.4,
            transparent: true,
            opacity: 0.85
        });

        const bodyMesh = new THREE.Mesh(sphereGeo, balloonMat);
        bodyMesh.scale.set(1, 1.25, 1);
        bodyMesh.castShadow = true;
        balloonMesh.add(bodyMesh);

        const knotMesh = new THREE.Mesh(knotGeo, balloonMat);
        knotMesh.position.y = -0.45;
        knotMesh.rotation.x = Math.PI;
        balloonMesh.add(knotMesh);

        balloonMesh.name = 'balloon';

        balloonMesh.position.set(
            (Math.random() - 0.5) * 7.5,
            (Math.random() - 0.5) * 5 + 0.5,
            (Math.random() - 0.5) * 7.5
        );

        scene.add(balloonMesh);

        balloons.push({
            mesh: balloonMesh,
            floatSpeed: 0.01 + Math.random() * 0.015,
            swaySpeed: 1 + Math.random() * 1.5,
            swayOffset: Math.random() * Math.PI
        });
    }
}

// Setup drifting 3D Gift Boxes (V4.6 Base-Lid separated for unboxing animations)
function createGiftMesh() {
    const group = new THREE.Group();
    
    // We will separate the Base and the Lid so we can animate them independently during unboxing!
    const baseGroup = new THREE.Group();
    baseGroup.name = 'gift-base';
    
    const lidGroup = new THREE.Group();
    lidGroup.name = 'gift-lid';
    
    const colors = [0xff0055, 0x7a00ff, 0xffd700, 0x00f2fe, 0x05ffb0, 0xd155ff];
    const wrapperColor = colors[Math.floor(Math.random() * colors.length)];
    
    const boxMat = new THREE.MeshPhysicalMaterial({
        color: wrapperColor,
        roughness: 0.1,
        metalness: 0.3,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05
    });
    
    const ribbonMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.2,
        metalness: 0.1
    });
    
    // Lower Box Base (y from -0.225 to 0.1, height = 0.325)
    const baseBoxGeo = new THREE.BoxGeometry(0.44, 0.325, 0.44);
    const baseBox = new THREE.Mesh(baseBoxGeo, boxMat);
    baseBox.position.y = -0.05;
    baseBox.castShadow = true;
    baseGroup.add(baseBox);
    
    // Base ribbons
    const baseRib1Geo = new THREE.BoxGeometry(0.46, 0.33, 0.06);
    const baseRib1 = new THREE.Mesh(baseRib1Geo, ribbonMat);
    baseRib1.position.y = -0.05;
    baseGroup.add(baseRib1);
    
    const baseRib2Geo = new THREE.BoxGeometry(0.06, 0.33, 0.46);
    const baseRib2 = new THREE.Mesh(baseRib2Geo, ribbonMat);
    baseRib2.position.y = -0.05;
    baseGroup.add(baseRib2);
    
    // Upper Lid Box (y from 0.1 to 0.225, height = 0.125)
    const lidBoxGeo = new THREE.BoxGeometry(0.47, 0.125, 0.47);
    const lidBox = new THREE.Mesh(lidBoxGeo, boxMat);
    lidBox.position.y = 0.1625;
    lidBox.castShadow = true;
    lidGroup.add(lidBox);
    
    // Lid ribbons & bows
    const lidRib1Geo = new THREE.BoxGeometry(0.49, 0.13, 0.07);
    const lidRib1 = new THREE.Mesh(lidRib1Geo, ribbonMat);
    lidRib1.position.y = 0.1625;
    lidGroup.add(lidRib1);
    
    const lidRib2Geo = new THREE.BoxGeometry(0.07, 0.13, 0.49);
    const lidRib2 = new THREE.Mesh(lidRib2Geo, ribbonMat);
    lidRib2.position.y = 0.1625;
    lidGroup.add(lidRib2);
    
    const topRibGeo = new THREE.BoxGeometry(0.49, 0.02, 0.49);
    const topRib = new THREE.Mesh(topRibGeo, ribbonMat);
    topRib.position.y = 0.225;
    lidGroup.add(topRib);
    
    const bowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const torusGeo = new THREE.TorusGeometry(0.07, 0.022, 8, 16);
    
    const bowL = new THREE.Mesh(torusGeo, bowMat);
    bowL.position.set(-0.05, 0.25, 0);
    bowL.rotation.z = Math.PI / 4;
    bowL.scale.set(1.5, 1, 1);
    lidGroup.add(bowL);
    
    const bowR = new THREE.Mesh(torusGeo, bowMat);
    bowR.position.set(0.05, 0.25, 0);
    bowR.rotation.z = -Math.PI / 4;
    bowR.scale.set(1.5, 1, 1);
    lidGroup.add(bowR);
    
    group.add(baseGroup);
    group.add(lidGroup);
    
    group.name = 'gift';
    return group;
}

function setupViewerGifts() {
    gifts = [];
    const giftCount = 6;
    
    for (let i = 0; i < giftCount; i++) {
        const giftMesh = createGiftMesh();
        
        giftMesh.position.set(
            (Math.random() - 0.5) * 8.5,
            (Math.random() - 0.5) * 4 + 1.0,
            (Math.random() - 0.5) * 8.5
        );
        
        giftMesh.rotation.set(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI
        );
        
        scene.add(giftMesh);
        
        gifts.push({
            mesh: giftMesh,
            floatSpeed: 0.006 + Math.random() * 0.008,
            swaySpeed: 0.8 + Math.random() * 0.8,
            swayOffset: Math.random() * Math.PI,
            rotSpeed: {
                x: (Math.random() - 0.5) * 0.01,
                y: (Math.random() - 0.5) * 0.01,
                z: (Math.random() - 0.5) * 0.01
            }
        });
    }
}

// Setup drifting 3D Musical Notes
function createNoteMesh() {
    const group = new THREE.Group();
    
    const headGeo = new THREE.SphereGeometry(0.1, 12, 12);
    const noteMat = new THREE.MeshStandardMaterial({
        color: 0x00f2fe,
        roughness: 0.2,
        metalness: 0.8,
        emissive: 0x003344
    });
    
    const head = new THREE.Mesh(headGeo, noteMat);
    head.scale.set(1.3, 0.8, 1);
    head.rotation.z = -0.25;
    group.add(head);
    
    const stemGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.38, 6);
    const stem = new THREE.Mesh(stemGeo, noteMat);
    stem.position.set(0.1, 0.18, 0);
    group.add(stem);
    
    const flagGeo = new THREE.CylinderGeometry(0.016, 0.06, 0.15, 6);
    const flag = new THREE.Mesh(flagGeo, noteMat);
    flag.position.set(0.16, 0.32, 0);
    flag.rotation.z = -Math.PI / 3;
    group.add(flag);
    
    group.name = 'note';
    return group;
}

function setupViewerNotes() {
    notes = [];
    const noteCount = 8;
    
    for (let i = 0; i < noteCount; i++) {
        const noteMesh = createNoteMesh();
        
        noteMesh.position.set(
            (Math.random() - 0.5) * 9.0,
            (Math.random() - 0.5) * 5 + 1.5,
            (Math.random() - 0.5) * 9.0
        );
        
        scene.add(noteMesh);
        
        notes.push({
            mesh: noteMesh,
            floatSpeed: 0.008 + Math.random() * 0.01,
            swaySpeed: 1.0 + Math.random() * 1.0,
            swayOffset: Math.random() * Math.PI,
            rotSpeed: (Math.random() - 0.5) * 0.01
        });
    }
}

// V3.0 Twinkling Background Star Dust Points particle system
function createCircularGlowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255, 230, 160, 1.0)');
    gradient.addColorStop(0.3, 'rgba(255, 200, 80, 0.8)');
    gradient.addColorStop(0.6, 'rgba(255, 150, 40, 0.2)');
    gradient.addColorStop(1.0, 'rgba(255, 100, 20, 0.0)');
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

function setupViewerStarDust() {
    const starCount = 150;
    starGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(starCount * 3);
    starData = [];

    for (let i = 0; i < starCount; i++) {
        const x = (Math.random() - 0.5) * 12;
        const y = (Math.random() - 0.5) * 8 + 1.5;
        const z = (Math.random() - 0.5) * 12;

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        starData.push({
            x: x,
            speedY: 0.005 + Math.random() * 0.01,
            swaySpeed: 0.5 + Math.random() * 1.0,
            swayOffset: Math.random() * Math.PI * 2
        });
    }

    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    starMaterial = new THREE.PointsMaterial({
        color: 0xffddaa,
        size: 0.18,
        map: createCircularGlowTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.85
    });

    starDust = new THREE.Points(starGeometry, starMaterial);
    scene.add(starDust);
}

// V3.0 Floating 3D picture frame loading activeConfig.photo with canvas-drawn fallback
function setupFloatingPhotoFrame() {
    photoFrameGroup = new THREE.Group();
    photoFrameGroup.name = 'photo-frame';
    photoFrameGroup.position.set(2.8, 1.8, -1.8);
    
    // 1. Backing glassmorphic frame card
    const backGeo = new THREE.BoxGeometry(1.4, 1.4, 0.05);
    const backMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.1,
        metalness: 0.1,
        transmission: 0.6,
        thickness: 0.2,
        ior: 1.45,
        transparent: true,
        opacity: 0.5,
        clearcoat: 1.0
    });
    const backMesh = new THREE.Mesh(backGeo, backMat);
    backMesh.castShadow = true;
    backMesh.receiveShadow = true;
    photoFrameGroup.add(backMesh);
    
    // 2. Shiny gold borders
    const borderMat = new THREE.MeshStandardMaterial({
        color: 0xffd700,
        metalness: 0.9,
        roughness: 0.15
    });
    
    // Top border
    const topGeo = new THREE.BoxGeometry(1.44, 0.04, 0.06);
    const topBorder = new THREE.Mesh(topGeo, borderMat);
    topBorder.position.set(0, 0.7, 0);
    photoFrameGroup.add(topBorder);
    
    // Bottom border
    const bottomBorder = new THREE.Mesh(topGeo, borderMat);
    bottomBorder.position.set(0, -0.7, 0);
    photoFrameGroup.add(bottomBorder);

    // Left border
    const sideGeo = new THREE.BoxGeometry(0.04, 1.44, 0.06);
    const leftBorder = new THREE.Mesh(sideGeo, borderMat);
    leftBorder.position.set(-0.7, 0, 0);
    photoFrameGroup.add(leftBorder);
    
    // Right border
    const rightBorder = new THREE.Mesh(sideGeo, borderMat);
    rightBorder.position.set(0.7, 0, 0);
    photoFrameGroup.add(rightBorder);

    // 3. Picture plane
    const picGeo = new THREE.PlaneGeometry(1.2, 1.2);
    
    // Fallback Canvas drawing a beating heart silhouette and "To My Favorite Senpai! 💖"
    function createFallbackTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        
        const grad = ctx.createLinearGradient(0, 0, 256, 256);
        grad.addColorStop(0, '#ffeef8');
        grad.addColorStop(1, '#ffcce6');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 256);
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 6;
        ctx.strokeRect(12, 12, 232, 232);
        
        ctx.fillStyle = '#ec1a4e';
        ctx.beginPath();
        ctx.moveTo(128, 100);
        ctx.bezierCurveTo(128, 85, 98, 70, 98, 105);
        ctx.bezierCurveTo(98, 140, 128, 165, 128, 180);
        ctx.bezierCurveTo(128, 165, 158, 140, 158, 105);
        ctx.bezierCurveTo(158, 70, 128, 85, 128, 100);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = '#330011';
        ctx.font = 'bold 20px "Outfit", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('To My Favorite', 128, 205);
        ctx.fillText(`${activeConfig?.recipientName || 'คุณพลอย'}! 💖`, 128, 230);
        
        const tex = new THREE.CanvasTexture(canvas);
        return tex;
    }

    const loader = new THREE.TextureLoader();
    let picMat = null;

    if (activeConfig.photo) {
        picMat = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide
        });
        
        loader.crossOrigin = 'anonymous';
        loader.load(
            activeConfig.photo,
            (texture) => {
                picMat.map = texture;
                picMat.needsUpdate = true;
            },
            undefined,
            (err) => {
                console.warn('Memory photo CORS load failed. Using premium heart fallback:', err);
                picMat.map = createFallbackTexture();
                picMat.needsUpdate = true;
            }
        );
    } else {
        picMat = new THREE.MeshBasicMaterial({
            map: createFallbackTexture(),
            side: THREE.DoubleSide
        });
    }
    
    const picMesh = new THREE.Mesh(picGeo, picMat);
    picMesh.position.set(0, 0, 0.028);
    photoFrameGroup.add(picMesh);

    scene.add(photoFrameGroup);
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
    scene.add(ring1);
    holographicRings.push(ring1);

    const ring2 = new THREE.Mesh(ringGeo, ringMat2);
    ring2.rotation.x = -Math.PI / 2;
    ring2.position.y = -1.13;
    scene.add(ring2);
    holographicRings.push(ring2);
}

function setupFloatingSprinkles() {
    floatingSprinkles = [];
    const colors = [0x00f2fe, 0xff0055, 0x05ffb0];
    const decorHearts = activeConfig.decorHearts || false;
    const decorStars = activeConfig.decorStars || false;

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
            emissiveIntensity: type === 'sprinkle' ? 0.9 : 0.4,
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

        scene.add(mesh);

        floatingSprinkles.push({
            mesh: mesh,
            baseY: y,
            angle: angle,
            radius: radius,
            orbitSpeed: 0.08 + Math.random() * 0.12,
            bobSpeed: 1.2 + Math.random() * 1.5,
            bobOffset: Math.random() * Math.PI,
            rotSpeed: {
                x: 0.2 + Math.random() * 0.4,
                y: 0.2 + Math.random() * 0.4,
                z: 0.2 + Math.random() * 0.4
            }
        });
    }
}

function createCustomTopperTexture(text, themeName, customGlowColor = '') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, 512, 256);
    
    let bgColor = 'rgba(15, 10, 25, 0.85)';
    let textColor = '#ff0055';
    let borderColor = '#00f2fe';
    let glowColor = '#ff0055';
    let fontName = 'Outfit';

    if (themeName === 'midnight-gold') {
        bgColor = 'rgba(10, 8, 5, 0.9)';
        textColor = '#ffd700';
        borderColor = '#ffd700';
        glowColor = '#ffd700';
        fontName = 'Playfair Display';
    } else if (themeName === 'pastel-mint') {
        bgColor = 'rgba(5, 15, 20, 0.85)';
        textColor = '#00f2fe';
        borderColor = '#4facfe';
        glowColor = '#00f2fe';
        fontName = 'Outfit';
    } else if (themeName === 'lavender-dream') {
        bgColor = 'rgba(15, 5, 20, 0.88)';
        textColor = '#f355ff';
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
    
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 12;
    
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

    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 15;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    let fontSize = 56;
    if (text.length > 10) fontSize = 44;
    if (text.length > 14) fontSize = 36;
    
    ctx.font = `bold ${fontSize}px "${fontName}", "Outfit", sans-serif`;
    ctx.fillText(text, 256, 128);
    
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
    ctx.fillStyle = 'rgba(12, 6, 22, 0.82)';
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
    
    // Draw text with glow
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 28px "Outfit", sans-serif';
    ctx.fillText(text, 256, 64);
    
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

function setupViewerEnvelope() {
    if (envelopeGroup) {
        scene.remove(envelopeGroup);
        envelopeGroup.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                else child.material.dispose();
            }
        });
        envelopeGroup = null;
    }
    if (envelopePointer) {
        scene.remove(envelopePointer);
        if (envelopePointer.geometry) envelopePointer.geometry.dispose();
        if (envelopePointer.material) envelopePointer.material.dispose();
        envelopePointer = null;
    }
    if (envelopeLabel) {
        scene.remove(envelopeLabel);
        if (envelopeLabel.material) {
            if (envelopeLabel.material.map) envelopeLabel.material.map.dispose();
            envelopeLabel.material.dispose();
        }
        envelopeLabel = null;
    }

    if (activeConfig.letterEnabled) {
        const letterTheme = activeConfig.letterTheme || 'cyber';
        
        const envBaseColor = activeConfig.envBaseColor || '';
        const envFlapColor = activeConfig.envFlapColor || '';
        const envSealColor = activeConfig.envSealColor || '';

        envelopeGroup = create3DEnvelopeMesh(letterTheme, envBaseColor, envFlapColor, envSealColor);
        envelopeGroup.scale.set(1.6, 1.6, 1.6);
        envelopeGroup.position.set(-2.8, 1.6, -1.8);
        envelopeGroup.rotation.y = Math.PI / 4;

        // Add fat invisible box collider for 100% click/tap success
        const colliderGeo = new THREE.BoxGeometry(1.8, 1.4, 0.6);
        const colliderMat = new THREE.MeshBasicMaterial({
            visible: true,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            depthTest: false
        });
        const colliderMesh = new THREE.Mesh(colliderGeo, colliderMat);
        colliderMesh.name = 'envelope-collider';
        envelopeGroup.add(colliderMesh);

        scene.add(envelopeGroup);

        // Pointer Cone Geometry (scaled up to match)
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

        envelopePointer = new THREE.Mesh(pointerGeo, pointerMat);
        envelopePointer.position.set(-2.8, 2.4, -1.8);
        scene.add(envelopePointer);

        // Pulsating 3D billboard sprite label above envelope
        const labelColor = envFlapColor || '#00f2fe';
        const dict = translations[getCurrentLang()];
        envelopeLabel = createFloatingLabelSprite(dict.tapToOpen, labelColor);
        envelopeLabel.position.set(-2.8, 2.8, -1.8);
        scene.add(envelopeLabel);
    }
}

function clickEnvelope() {
    if (isViewingLetter) return;
    isViewingLetter = true;
    
    preZoomCameraPos.copy(camera.position);
    preZoomControlsTarget.copy(controls.target);
    
    controls.enabled = false;
    
    playSoundEffect('triumphant');
    confetti({
        particleCount: 50,
        spread: 60,
        origin: { x: 0.5, y: 0.5 },
        colors: ['#00f2fe', '#ff0055', '#ffd700', '#05ffb0']
    });
    
    logToCyberConsole('INTERACTIVE ENVELOPE SECTOR ENGAGED // ZOOMING CAMERA FOCUS', 'cyan');

    anime({
        targets: camera.position,
        x: -1.4,
        y: 1.7,
        z: -0.2,
        duration: 1500,
        easing: 'easeInOutCubic'
    });
    
    anime({
        targets: controls.target,
        x: -2.8,
        y: 1.6,
        z: -1.8,
        duration: 1500,
        easing: 'easeInOutCubic',
        complete: () => {
            showPopupLetter();
        }
    });
}

function showPopupLetter() {
    const overlay = document.getElementById('letter-popup-overlay');
    const letterPaper = document.getElementById('letter-paper');
    const envContainer = document.getElementById('letter-envelope-container');
    const letterTitle = document.getElementById('letter-popup-title');
    const letterBody = document.getElementById('letter-popup-body');
    const hint = document.getElementById('letter-open-hint');
    
    if (overlay) overlay.classList.add('active');
    
    // Reset Envelope to CLOSED state so user gets the tactile opening experience
    if (envContainer) {
        envContainer.classList.remove('open');
        
        const letterTheme = activeConfig.letterTheme || 'cyber';
        
        const envColors = {
            cyber: { base: '#1a1b22', flap: '#00f2fe', seal: '#ff0055' },
            royal: { base: '#111111', flap: '#111111', seal: '#d4af37' },
            romance: { base: '#fff0f3', flap: '#fff0f3', seal: '#900c3f' },
            steampunk: { base: '#5c3d2e', flap: '#5c3d2e', seal: '#b87333' }
        };
        const defaultEnv = envColors[letterTheme] || envColors.cyber;
        
        const baseColor = activeConfig.envBaseColor || defaultEnv.base;
        const flapColor = activeConfig.envFlapColor || defaultEnv.flap;
        const sealColor = activeConfig.envSealColor || defaultEnv.seal;
        
        envContainer.style.setProperty('--env-base-color', baseColor);
        envContainer.style.setProperty('--env-flap-color', flapColor);
        envContainer.style.setProperty('--env-seal-color', sealColor);
    }
    
    // Reveal the floating neon instruct-to-tap banner
    if (hint) {
        hint.style.display = 'flex';
        setTimeout(() => {
            hint.style.opacity = '1';
            hint.style.transform = 'translateX(-50%) translateY(0)';
        }, 50);
    }
    
    if (letterPaper) {
        letterPaper.className = 'envelope-paper glass-panel';
        letterPaper.classList.add(`theme-${activeConfig.letterTheme || 'cyber'}`);
    }
    
    if (letterTitle) {
        letterTitle.textContent = activeConfig.letterTitle || 'A Special Secret Message';
    }
    
    // Message remains empty until the user clicks open the wax seal!
    if (letterBody) {
        letterBody.textContent = '';
    }
}

function openEnvelopeWithAnimation() {
    const envContainer = document.getElementById('letter-envelope-container');
    const letterBody = document.getElementById('letter-popup-body');
    const hint = document.getElementById('letter-open-hint');
    
    if (!envContainer || envContainer.classList.contains('open')) return;
    
    // 1. Play procedural sound effect (paper rip + magic chime)
    playSoundEffect('paper');
    
    // 2. Unfold flap and slide up paper sheet
    envContainer.classList.add('open');
    
    // 3. Dismiss instructions seamlessly
    if (hint) {
        hint.style.opacity = '0';
        hint.style.transform = 'translateX(-50%) translateY(-20px) scale(0.9)';
        setTimeout(() => {
            hint.style.display = 'none';
        }, 400);
    }
    
    // 4. Begin the typewriter text sequence after the sheet slides up fully
    if (letterBody) {
        letterBody.textContent = '';
        const bodyText = activeConfig.letterBody || '';
        
        let index = 0;
        const speed = 25;
        
        if (typewriterInterval) clearInterval(typewriterInterval);
        
        setTimeout(() => {
            typewriterInterval = setInterval(() => {
                if (index < bodyText.length) {
                    letterBody.textContent += bodyText.charAt(index);
                    index++;
                    
                    const scrollContainer = document.querySelector('.letter-body-scroll');
                    if (scrollContainer) {
                        scrollContainer.scrollTop = scrollContainer.scrollHeight;
                    }
                } else {
                    clearInterval(typewriterInterval);
                    typewriterInterval = null;
                }
            }, speed);
        }, 1100);
    }
}

function closeLetterPopup() {
    if (typewriterInterval) {
        clearInterval(typewriterInterval);
        typewriterInterval = null;
    }
    
    const overlay = document.getElementById('letter-popup-overlay');
    if (overlay) overlay.classList.remove('active');
    
    const envContainer = document.getElementById('letter-envelope-container');
    if (envContainer) {
        envContainer.classList.remove('open');
    }
    
    // Reset opening instructions
    const hint = document.getElementById('letter-open-hint');
    if (hint) {
        hint.style.opacity = '0';
        hint.style.transform = 'translateX(-50%) translateY(10px)';
    }
    
    logToCyberConsole('RESTORING PRE-ZOOM SECTOR SCENE VIEWPORT', 'default');
    
    anime({
        targets: camera.position,
        x: preZoomCameraPos.x,
        y: preZoomCameraPos.y,
        z: preZoomCameraPos.z,
        duration: 1500,
        easing: 'easeInOutCubic'
    });
    
    anime({
        targets: controls.target,
        x: preZoomControlsTarget.x,
        y: preZoomControlsTarget.y,
        z: preZoomControlsTarget.z,
        duration: 1500,
        easing: 'easeInOutCubic',
        complete: () => {
            controls.enabled = true;
            isViewingLetter = false;
        }
    });
}
// Version 4.6: Squash-and-stretch anim and dynamic pentatonic audio chime for cake toppings
function bounceTopping(toppingGroup) {
    if (!toppingGroup || toppingGroup.userData.isAnimating) return;
    toppingGroup.userData.isAnimating = true;
    
    // Determine dynamic pitch freq based on position coordinate to act like a piano/chime array!
    const angleOffset = Math.atan2(toppingGroup.position.z, toppingGroup.position.x);
    const semitones = Math.floor((angleOffset + Math.PI) / (Math.PI * 2) * 8);
    const freqs = [523.25, 587.33, 659.25, 698.46, 783.99, 880.00, 987.77, 1046.50];
    const freq = freqs[Math.max(0, Math.min(7, semitones))];
    
    playChimeEffect(freq);
    logToCyberConsole(`TOPPING VIBRATING: SQUASH-STRETCH NOTE GIGAHURTZ [${freq.toFixed(2)}HZ]`, 'cyan');

    // Trigger volumetric neon particles
    triggerToppingSparkles(toppingGroup);

    // Bounce squash-and-stretch
    const originalScale = {
        x: toppingGroup.scale.x,
        y: toppingGroup.scale.y,
        z: toppingGroup.scale.z
    };

    anime.timeline({
        complete: () => {
            toppingGroup.userData.isAnimating = false;
        }
    })
    .add({
        targets: toppingGroup.scale,
        x: originalScale.x * 1.35,
        y: originalScale.y * 0.65,
        z: originalScale.z * 1.35,
        duration: 100,
        easing: 'easeOutQuad'
    })
    .add({
        targets: toppingGroup.scale,
        x: originalScale.x * 0.85,
        y: originalScale.y * 1.25,
        z: originalScale.z * 0.85,
        duration: 150,
        easing: 'easeOutElastic(1, 0.4)'
    })
    .add({
        targets: toppingGroup.scale,
        x: originalScale.x,
        y: originalScale.y,
        z: originalScale.z,
        duration: 200,
        easing: 'easeOutQuad'
    });
}

function triggerToppingSparkles(toppingGroup) {
    if (!scene) return;
    
    const worldPos = new THREE.Vector3();
    toppingGroup.getWorldPosition(worldPos);
    
    let colorHex = 0xff0055; // hot pink
    if (toppingGroup.name === 'strawberry') {
        colorHex = 0xff2a4b;
    } else if (toppingGroup.name === 'cherry') {
        colorHex = 0xee0520;
    } else if (toppingGroup.name === 'wafer-roll') {
        colorHex = 0xffaa00;
    }

    const sparkMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.95
    });

    const sparkGeo = new THREE.DodecahedronGeometry(0.018, 0);

    for (let i = 0; i < 10; i++) {
        const spark = new THREE.Mesh(sparkGeo, sparkMat);
        spark.position.copy(worldPos);
        spark.position.y += 0.05; // slightly above
        
        scene.add(spark);
        
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 2 - 1);
        const velocity = 0.015 + Math.random() * 0.02;
        
        embers.push({
            mesh: spark,
            speedY: Math.sin(phi) * Math.sin(theta) * velocity + 0.012, // upward motion
            speedX: Math.sin(phi) * Math.cos(theta) * velocity,
            speedZ: Math.cos(phi) * velocity,
            life: 1.0
        });
    }
}

// Version 4.6: Beautiful 3D Picture Frame flipping and chiming on click
function flipPhotoFrame() {
    if (!photoFrameGroup || photoFrameGroup.userData.isAnimating) return;
    photoFrameGroup.userData.isAnimating = true;
    
    playSoundEffect('paper');
    logToCyberConsole('ROTATING QUANTUM PICTURE CAPSULE // RECALIBRATING VISUAL LAYER', 'cyan');
    
    // Dynamic volumetric melodic sweeps as it flips
    setTimeout(() => { playChimeEffect(659.25); }, 150);
    setTimeout(() => { playChimeEffect(783.99); }, 300);
    setTimeout(() => { playChimeEffect(1046.50); }, 450);
    
    anime({
        targets: photoFrameGroup.rotation,
        y: photoFrameGroup.rotation.y + Math.PI * 2,
        duration: 1200,
        easing: 'easeInOutBack',
        complete: () => {
            photoFrameGroup.userData.isAnimating = false;
        }
    });
}

// 6. RAYCASTING INTERACTIVE CLICKS
function onSceneClick(event) {
    if (!renderer || !camera || !scene) return;

    const mouse = new THREE.Vector2();
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(scene.children, true);

    if (intersects.length > 0) {
        // Prioritized scanner to prevent floating particles, labels, or Stand meshes from blocking clicks.
        // Priority Order: Candle Flame > Envelope (Group, Collider, Label) > Gift Box > Balloon > Musical Notes
        
        // 1. Check for Candle Flames first (highest precision required)
        for (let hit of intersects) {
            let parent = hit.object;
            while (parent && parent !== scene) {
                if (parent.name === 'flame') {
                    const candleObj = candles.find(c => c.flame === parent);
                    if (candleObj && candleObj.isLit) {
                        extinguishCandle(candleObj);
                        return;
                    }
                }
                parent = parent.parent;
            }
        }

        // 2. Check for Envelope objects (Group, invisible Collider box, Arrow pointer, or Floating Label)
        for (let hit of intersects) {
            let parent = hit.object;
            while (parent && parent !== scene) {
                if (parent.name === 'envelope-group' || 
                    parent === envelopeGroup || 
                    parent === envelopePointer || 
                    parent === envelopeLabel || 
                    parent.name === 'envelope-collider' ||
                    parent.name === 'envelope-label') {
                    clickEnvelope();
                    return;
                }
                parent = parent.parent;
            }
        }

        // 3. Check for Gift Boxes
        for (let hit of intersects) {
            let parent = hit.object;
            while (parent && parent !== scene) {
                if (parent.name === 'gift') {
                    popGift(parent, event);
                    return;
                }
                parent = parent.parent;
            }
        }

        // 4. Check for Balloons
        for (let hit of intersects) {
            let parent = hit.object;
            while (parent && parent !== scene) {
                if (parent.name === 'balloon') {
                    popBalloon(parent, event);
                    return;
                }
                parent = parent.parent;
            }
        }

        // 5. Check for Musical Notes
        for (let hit of intersects) {
            let parent = hit.object;
            while (parent && parent !== scene) {
                if (parent.name === 'note') {
                    clickNote(parent, event);
                    return;
                }
                parent = parent.parent;
            }
        }

        // 6. Check for Toppings (Strawberries, Cherries, Wafer rolls) (V4.6 Playable Toppings)
        for (let hit of intersects) {
            let parent = hit.object;
            while (parent && parent !== scene) {
                if (parent.name === 'strawberry' || parent.name === 'cherry' || parent.name === 'wafer-roll') {
                    bounceTopping(parent);
                    return;
                }
                parent = parent.parent;
            }
        }

        // 7. Check for Photo Frame (V4.6 Photo Flip)
        for (let hit of intersects) {
            let parent = hit.object;
            while (parent && parent !== scene) {
                if (parent.name === 'photo-frame' || parent === photoFrameGroup) {
                    flipPhotoFrame();
                    return;
                }
                parent = parent.parent;
            }
        }
    }
}

// Pops a balloon
function popBalloon(balloonGroup, event) {
    balloons = balloons.filter(b => b.mesh !== balloonGroup);
    playSoundEffect('pop');
    logToCyberConsole('BALLOON DEFLATION DETECTED: FORCE POP INITIATED', 'pink');

    confetti({
        particleCount: 45,
        spread: 60,
        origin: {
            x: event.clientX / window.innerWidth,
            y: event.clientY / window.innerHeight
        },
        colors: ['#ff0055', '#00f2fe', '#ffd700', '#d155ff']
    });

    anime({
        targets: balloonGroup.scale,
        x: 0,
        y: 0,
        z: 0,
        duration: 250,
        easing: 'easeOutBack',
        complete: () => {
            scene.remove(balloonGroup);
        }
    });
}

// Pops a Gift Box with HTML text surprise bubbles and Version 4.6 advanced WebGL unboxing!
function popGift(giftGroup, event) {
    gifts = gifts.filter(g => g.mesh !== giftGroup);
    
    playSoundEffect('pop');
    setTimeout(() => {
        playChimeEffect();
    }, 100);
    
    const rName = activeConfig?.recipientName || 'คุณพลอย';
    const blessingsList = [
        "Wishing you joy! 💖",
        "You are the best! ⭐",
        "Have a sweet year! 🎂",
        `Sparkle on, ${rName}! ✨`,
        "May your dreams come true! 🌈",
        "Cheers to another amazing year! 🥂",
        "You inspire us daily! 👑",
        "Health and happiness always! 🌸",
        `สุขสันต์วันเกิดนะ ${rName}! 🎉`
    ];
    const text = blessingsList[Math.floor(Math.random() * blessingsList.length)];
    logToCyberConsole('DECRYPTING GIFT DATA CAPSULE... BLESSING READ: ' + text.toUpperCase(), 'cyan');

    confetti({
        particleCount: 30,
        spread: 50,
        origin: {
            x: event.clientX / window.innerWidth,
            y: event.clientY / window.innerHeight
        },
        colors: ['#ffd700', '#00f2fe', '#ff0055', '#ffffff']
    });

    const baseGroup = giftGroup.getObjectByName('gift-base');
    const lidGroup = giftGroup.getObjectByName('gift-lid');
    
    // Version 4.6: Volumetric 3D upward particle blast
    const worldPos = new THREE.Vector3();
    giftGroup.getWorldPosition(worldPos);
    
    const colors = [0xff0055, 0x7a00ff, 0xffd700, 0x00f2fe, 0x05ffb0, 0xd155ff];
    const particleColors = [
        colors[Math.floor(Math.random() * colors.length)],
        colors[Math.floor(Math.random() * colors.length)],
        0xffffff
    ];
    
    const particleGeo = new THREE.DodecahedronGeometry(0.025, 0);
    
    for (let i = 0; i < 18; i++) {
        const particleMat = new THREE.MeshBasicMaterial({
            color: particleColors[i % particleColors.length],
            transparent: true,
            opacity: 0.95
        });
        const particle = new THREE.Mesh(particleGeo, particleMat);
        particle.position.copy(worldPos);
        
        scene.add(particle);
        
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 2 - 1);
        const speed = 0.02 + Math.random() * 0.03;
        
        embers.push({
            mesh: particle,
            speedY: Math.sin(phi) * Math.sin(theta) * speed + 0.03, // upward burst
            speedX: Math.sin(phi) * Math.cos(theta) * speed,
            speedZ: Math.cos(phi) * speed,
            life: 1.2
        });
    }

    if (baseGroup && lidGroup) {
        // 1. Lid flies off: ascends rapidly, rotates, scales to 0
        anime({
            targets: lidGroup.position,
            y: [lidGroup.position.y, lidGroup.position.y + 1.2],
            x: [lidGroup.position.x, lidGroup.position.x + (Math.random() - 0.5) * 0.6],
            z: [lidGroup.position.z, lidGroup.position.z + (Math.random() - 0.5) * 0.6],
            duration: 600,
            easing: 'easeOutQuad'
        });
        
        anime({
            targets: lidGroup.rotation,
            x: [0, Math.random() * Math.PI * 2],
            y: [0, Math.random() * Math.PI * 2],
            z: [0, Math.random() * Math.PI * 2],
            duration: 600,
            easing: 'easeOutQuad'
        });
        
        anime({
            targets: lidGroup.scale,
            x: 0,
            y: 0,
            z: 0,
            delay: 150,
            duration: 450,
            easing: 'easeInQuad'
        });
        
        // 2. Base box squashes down, then scales to 0
        anime({
            targets: baseGroup.scale,
            x: [1, 1.35, 0],
            y: [1, 0.45, 0],
            z: [1, 1.35, 0],
            duration: 550,
            easing: 'easeOutBack',
            complete: () => {
                scene.remove(giftGroup);
            }
        });
    } else {
        // Fallback for flat geometry
        anime({
            targets: giftGroup.scale,
            x: 0,
            y: 0,
            z: 0,
            duration: 250,
            easing: 'easeOutBack',
            complete: () => {
                scene.remove(giftGroup);
            }
        });
    }
    
    // HTML Floating glassmorphic Surpise bubble!
    const bubble = document.createElement('div');
    bubble.innerHTML = text;
    
    bubble.style.position = 'absolute';
    bubble.style.left = `${event.clientX}px`;
    bubble.style.top = `${event.clientY}px`;
    bubble.style.transform = 'translate(-50%, -50%)';
    bubble.style.padding = '12px 20px';
    bubble.style.borderRadius = '20px';
    bubble.style.background = 'rgba(255, 255, 255, 0.12)';
    bubble.style.backdropFilter = 'blur(12px)';
    bubble.style.webkitBackdropFilter = 'blur(12px)';
    bubble.style.border = '1px solid rgba(255, 255, 255, 0.25)';
    bubble.style.color = '#ffffff';
    bubble.style.fontFamily = 'var(--font-primary)';
    bubble.style.fontWeight = '600';
    bubble.style.fontSize = '1.05rem';
    bubble.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3), var(--panel-glow)';
    bubble.style.zIndex = '999';
    bubble.style.pointerEvents = 'none';
    bubble.style.whiteSpace = 'nowrap';
    bubble.style.opacity = '0';
    bubble.style.transition = 'opacity 0.2s ease';
    
    document.body.appendChild(bubble);
    
    anime({
        targets: bubble,
        translateY: [0, -120],
        opacity: [0, 1, 1, 0],
        scale: [0.8, 1.1, 1, 0.8],
        duration: 2500,
        easing: 'easeOutQuad',
        complete: () => {
            document.body.removeChild(bubble);
        }
    });
}

// Clicks on drifting musical notes to play synthesized bells
function clickNote(noteGroup, event) {
    const freq = playChimeEffect();
    logToCyberConsole(`CHROMATIC HARMONIC WAVE RESONATED // Freq: ${freq.toFixed(2)}Hz`, 'cyan');
    
    anime({
        targets: noteGroup.scale,
        x: [1.0, 1.4, 1.0],
        y: [1.0, 1.4, 1.0],
        z: [1.0, 1.4, 1.0],
        duration: 600,
        easing: 'easeOutElastic(1, 0.4)'
    });
    
    confetti({
        particleCount: 10,
        spread: 30,
        origin: {
            x: event.clientX / window.innerWidth,
            y: event.clientY / window.innerHeight
        },
        colors: ['#00f2fe', '#05ffb0', '#ffffff']
    });
}

// Extinguishes next candle sequentially
function extinguishNextCandle() {
    const litCandle = candles.find(c => c.isLit);
    if (litCandle) {
        extinguishCandle(litCandle);
    }
}

// Extinguish specific candle
function extinguishCandle(candleObj) {
    candleObj.isLit = false;
    playSoundEffect('puff');
    logToCyberConsole('THERMAL DISPERSION ENCOUNTERED // CANDLE EXTINGUISHED', 'warning');

    confetti({
        particleCount: 15,
        spread: 40,
        origin: { x: 0.5, y: 0.45 },
        colors: ['#ffdd66', '#ffa800']
    });

    anime({
        targets: candleObj.flame.scale,
        x: 0,
        y: 0,
        z: 0,
        duration: 400,
        easing: 'easeOutQuint',
        complete: () => {
            candleObj.light.visible = false;
            checkAllExtinguished();
        }
    });

    anime({
        targets: candleObj.light,
        intensity: 0,
        duration: 400,
        easing: 'easeOutQuint'
    });
}

// Re-light all candles (Reset button)
function relightCandles() {
    allCandlesExtinguished = false;
    logToCyberConsole('SYSTEM RESTORATION: RELIGHTING CANDLE COILS', 'green');
    
    const wrapper = document.getElementById('greeting-card-wrapper');
    if (wrapper) {
        wrapper.classList.remove('active-card');
        wrapper.classList.add('hidden-card');
    }

    const hudInst = document.getElementById('hud-instructions');
    const hudTxt = document.getElementById('instruction-text');
    if (hudInst) hudInst.style.display = '';
    if (hudTxt) hudTxt.textContent = 'Blow into your mic or click on the candle flames to blow them out!';

    candles.forEach(candle => {
        candle.isLit = true;
        candle.light.visible = true;
        candle.light.intensity = 2.0;
        
        anime({
            targets: candle.flame.scale,
            x: 1.0,
            y: 1.0,
            z: 1.0,
            duration: 800,
            easing: 'elastic(1, 0.5)'
        });
    });

    if (!isMuted) {
        playBirthdaySynth(activeConfig.music);
    }
}

// Checks if all candles are blown out to trigger triumphant reveal
function checkAllExtinguished() {
    const activeCandles = candles.filter(c => c.isLit);
    if (activeCandles.length === 0 && !allCandlesExtinguished) {
        allCandlesExtinguished = true;
        
        stopMicAnalysis();
        const micViz = document.getElementById('mic-visualizer');
        if (micViz) micViz.style.display = 'none';

        stopBirthdaySynth();
        playSoundEffect('triumphant');

        const duration = 2.5 * 1000;
        const animationEnd = Date.now() + duration;
        const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 0 };

        function randomInRange(min, max) {
            return Math.random() * (max - min) + min;
        }

        const interval = setInterval(function() {
            const timeLeft = animationEnd - Date.now();

            if (timeLeft <= 0) {
                return clearInterval(interval);
            }

            const particleCount = 50 * (timeLeft / duration);
            confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } });
            confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } });
        }, 250);

        const hudInst = document.getElementById('hud-instructions');
        if (hudInst) hudInst.style.display = 'none';

        revealGreetingCard();
        trigger3DConfettiBlast();
    }
}

// Version 4.6: Volumetric 3D celebration confetti falling and orbiting in WebGL space
function trigger3DConfettiBlast() {
    if (!scene) return;
    logToCyberConsole('INJECTING VOLUMETRIC 3D WEBGL CONFETTI SHARDS...', 'cyan');
    
    const colors = [0xff0055, 0x00f2fe, 0xffd700, 0x05ffb0, 0xd155ff, 0xffffff];
    const geoTypes = [
        new THREE.DodecahedronGeometry(0.025, 0),
        new THREE.BoxGeometry(0.035, 0.035, 0.008),
        new THREE.ConeGeometry(0.025, 0.05, 5)
    ];

    for (let i = 0; i < 120; i++) {
        const color = colors[i % colors.length];
        const mat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.9,
            side: THREE.DoubleSide
        });
        
        const geo = geoTypes[i % geoTypes.length];
        const mesh = new THREE.Mesh(geo, mat);
        
        // Spawn randomly in a cylinder around the cake
        const angle = Math.random() * Math.PI * 2;
        const radius = 0.6 + Math.random() * 2.8;
        const y = 0.5 + Math.random() * 3.5;
        mesh.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        
        mesh.rotation.set(
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2
        );
        
        scene.add(mesh);
        
        celebrationConfetti.push({
            mesh: mesh,
            speedY: -0.01 - Math.random() * 0.025, // fall speed
            orbitSpeed: 0.4 + Math.random() * 1.2,
            radius: radius,
            angle: angle,
            rotSpeed: {
                x: (Math.random() - 0.5) * 4.5,
                y: (Math.random() - 0.5) * 4.5,
                z: (Math.random() - 0.5) * 4.5
            },
            life: 1.0,
            fadeSpeed: 0.0025 + Math.random() * 0.004
        });
    }
}

// Format an ISO date (YYYY-MM-DD) as a Thai date with the Buddhist-era year
function formatThaiBirthDate(iso) {
    if (!iso) return '';
    const months = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return '';
    return `🎂 ${d} ${months[m - 1]} ${y + 543}`;
}

// Cinematic Greeting wish revealing
function revealGreetingCard() {
    const wrapper = document.getElementById('greeting-card-wrapper');
    const viewTitle = document.getElementById('view-title');
    const viewMessage = document.getElementById('view-message');
    const viewDate = document.getElementById('view-date');

    if (!wrapper || !activeConfig) return;

    if (viewTitle) viewTitle.textContent = activeConfig.title;
    if (viewMessage) viewMessage.textContent = activeConfig.message;
    if (viewDate) viewDate.textContent = formatThaiBirthDate(activeConfig.bdate);

    // Apply premium typography classes based on config font selection
    const cardEl = wrapper.querySelector('.greeting-card');
    if (cardEl) {
        cardEl.classList.remove('font-sans', 'font-serif', 'font-handwriting');
        if (activeConfig.font === 'playfair') {
            cardEl.classList.add('font-serif');
        } else if (activeConfig.font === 'great-vibes') {
            cardEl.classList.add('font-handwriting');
        } else {
            cardEl.classList.add('font-sans');
        }
    }

    wrapper.classList.remove('hidden-card');
    wrapper.classList.add('active-card');

    if (camera && controls) {
        anime({
            targets: camera.position,
            x: 0,
            y: 0.9,
            z: 5.5,
            duration: 2500,
            easing: 'easeInOutCubic'
        });
        
        anime({
            targets: controls.target,
            x: 0,
            y: 0.9,
            z: 0,
            duration: 2500,
            easing: 'easeInOutCubic'
        });
    }

    anime.timeline({
        easing: 'easeOutQuad'
    })
    .add({
        targets: '.greeting-card',
        scale: [0.8, 1],
        opacity: [0, 1],
        translateY: [60, 0],
        duration: 1500,
        easing: 'spring(1, 80, 12, 0)'
    })
    .add({
        targets: '.greeting-card-header h2',
        opacity: [0, 1],
        translateY: [20, 0],
        duration: 800
    }, '-=1000')
    .add({
        targets: '.greeting-card-body p',
        opacity: [0, 1],
        translateY: [25, 0],
        duration: 1000
    }, '-=600')
    .add({
        targets: '.greeting-card-footer',
        opacity: [0, 1],
        duration: 800
    }, '-=500');
}
