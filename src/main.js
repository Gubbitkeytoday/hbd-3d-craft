import './style.css';
import './styles/icons.css';
import './styles/creator.css';
import './styles/receiver.css';

// Each route loads its own module, so a recipient opening a card never
// downloads the creator and vice versa. three.js lands in a shared chunk.
let creatorModule = null;
let viewerModule = null;
const loadCreator = () => import('./creator.js').then(m => (creatorModule = m));
const loadViewer = () => import('./viewer.js').then(m => (viewerModule = m));

// Main Application Controller & Router
class App {
    constructor() {
        this.creatorView = document.getElementById('creator-view');
        this.receiverView = document.getElementById('receiver-view');
        
        // Bind events
        window.addEventListener('hashchange', () => this.handleRouting());
        window.addEventListener('DOMContentLoaded', () => {
            this.handleRouting();
            this.setupGlobalEvents();
        });
    }

    async handleRouting() {
        const hash = window.location.hash || '#/';
        // A newer hashchange may land while a module is still downloading;
        // only the latest navigation is allowed to mount.
        const token = (this.routeToken = (this.routeToken || 0) + 1);

        // Clean up previous states to avoid memory/Three.js render leaks
        this.cleanupCurrentView();

        if (hash.startsWith('#/view/')) {
            // Receiver View (Senpai Interactive Card)
            this.creatorView.classList.remove('active-view');
            this.receiverView.classList.add('active-view');
            await loadViewer();
            if (token === this.routeToken) this.mountReceiverView(hash);
        } else {
            // Creator View / Dashboard (Default)
            this.receiverView.classList.remove('active-view');
            this.creatorView.classList.add('active-view');
            await loadCreator();
            if (token === this.routeToken) this.mountCreatorView();
        }
    }

    cleanupCurrentView() {
        creatorModule?.destroyCreator();
        viewerModule?.destroyViewer();
    }

    mountCreatorView() {
        // Set default theme for Dashboard
        this.applyTheme('neon-rose');
        creatorModule.initCreator();
    }

    mountReceiverView(hash) {
        // Syntax: #/view/RecipientName?d=BASE64_DATA
        const pathPart = hash.replace('#/view/', '');
        const queryIndex = pathPart.indexOf('?');
        
        let recipientName = 'คุณพลอย';
        let encodedData = '';

        if (queryIndex !== -1) {
            recipientName = safeDecode(pathPart.substring(0, queryIndex));
            const queryParams = new URLSearchParams(pathPart.substring(queryIndex));
            encodedData = queryParams.get('d') || '';
        } else if (pathPart && pathPart !== '#/' && pathPart !== '') {
            recipientName = safeDecode(pathPart);
        } else {
            recipientName = 'คุณพลอย';
        }

        // Decode URL Configuration data
        const cardConfig = this.decodeCardData(encodedData);
        if (!cardConfig.recipientName || cardConfig.recipientName === 'Senpai' || cardConfig.recipientName === 'ครีม') {
            cardConfig.recipientName = clampText(recipientName, 40) || 'คุณพลอย';
        }

        // Apply visual theme from the encoded greeting configuration
        this.applyTheme(cardConfig.theme || 'midnight-gold');

        // Initialize the interactive 3D WebGL card
        viewerModule.initViewer(cardConfig);
    }

    // Helper: Swaps body class to shift the entire CSS HSL variable design tokens
    applyTheme(themeName) {
        document.body.className = '';
        document.body.classList.add(`theme-${themeName}`);
    }

    // Helper: Safely compresses/decompresses custom state using Base64 URI encoder
    decodeCardData(base64String) {
        const defaults = {
            recipientName: 'คุณพลอย',
            bdate: '2026-08-17',
            title: 'สุขสันต์วันเกิดย้อนหลังนะค้าบคุณพลอย! 🎂🖤',
            message: 'Happy Belated Birthday นะค้าบคุณพลอย! 🎂✨ ถึงจะมาช้าไปนิด แต่ความหวังดีมีให้เสมอ ขอให้ปีนี้เป็นปีที่ดี มีรอยยิ้มเยอะๆ สุขภาพแข็งแรง และเท่/น่ารักขึ้นทุกวันเลยน้า 🎉🖤',
            theme: 'midnight-gold',
            candles: 5,
            music: 'happy-birthday-lofi',
            font: 'outfit',
            photo: '',
            preset: 'midnight-gold',
            cakeModel: 'classic-tiered',
            plate: 'ceramic',
            glaze: 'chocolate',
            topper: 'best-senpai',
            strawberries: 4,
            cherries: 4,
            rolls: 3,
            sprinkles: true,
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

        if (!base64String) return defaults;

        try {
            // Replace url safe chars back
            const normalizedBase64 = base64String
                .replace(/-/g, '+')
                .replace(/_/g, '/');
            
            // Decrypt UTF-8 safe string
            const decodedJSON = decodeURIComponent(
                atob(normalizedBase64)
                    .split('')
                    .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
                    .join('')
            );
            
            const parsed = JSON.parse(decodedJSON);
            return sanitizeCardConfig({ ...defaults, ...parsed }, defaults);
        } catch (e) {
            console.error('Failed to decode shareable URL data, fallback to defaults:', e);
            return defaults;
        }
    }

    setupGlobalEvents() {
        // Escape closes whichever dialog is on top.
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const closeIds = ['btn-close-letter', 'btn-close-greeting-card', 'btn-modal-close'];
            for (const id of closeIds) {
                const btn = document.getElementById(id);
                if (btn && isShown(btn)) {
                    btn.click();
                    break;
                }
            }
        });

        // Prevent default spacebar and arrow keys scrolling behavior in 3D receiver mode
        window.addEventListener('keydown', (e) => {
            if (this.receiverView.classList.contains('active-view')) {
                if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
                    e.preventDefault();
                }
            }
        });
    }
}

function isShown(el) {
    if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }
    return el.offsetParent !== null;
}

// A malformed %-escape in a hand-edited link must not take the whole card down.
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function clampText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Allowed values come straight from the creator's own controls, so the list
// can never drift from what the UI is able to produce.
function allowedValues(selector, attr = 'value') {
    return new Set([...document.querySelectorAll(selector)].map(el =>
        attr === 'value' ? el.value : el.dataset[attr]));
}

// Share links are attacker-controllable input: everything decoded from one is
// forced back into the shape the creator would have produced.
function sanitizeCardConfig(config, defaults) {
    const out = { ...defaults };
    const enums = {
        theme: allowedValues('.theme-btn[data-theme]', 'theme'),
        preset: allowedValues('.preset-btn[data-preset]', 'preset'),
        music: allowedValues('#music-track option'),
        font: allowedValues('#card-font option'),
        letterTheme: allowedValues('#letter-theme option'),
        cakeModel: allowedValues('#cake-model option'),
        plate: allowedValues('#plate-style option'),
        glaze: allowedValues('#glaze-style option'),
        topper: allowedValues('#topper-style option')
    };
    for (const [key, allowed] of Object.entries(enums)) {
        if (allowed.has(config[key])) out[key] = config[key];
    }

    const texts = { recipientName: 40, bdate: 10, title: 120, message: 2000,
        letterTitle: 120, letterBody: 4000, topperText: 16 };
    for (const [key, max] of Object.entries(texts)) {
        if (typeof config[key] === 'string') out[key] = clampText(config[key], max);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.bdate)) out.bdate = defaults.bdate;

    const ints = { candles: [1, 10], strawberries: [0, 8], cherries: [0, 8], rolls: [0, 6] };
    for (const [key, [min, max]] of Object.entries(ints)) {
        const n = parseInt(config[key], 10);
        if (Number.isFinite(n)) out[key] = Math.min(max, Math.max(min, n));
    }

    for (const key of ['sprinkles', 'letterEnabled', 'decorHearts', 'decorStars']) {
        if (typeof config[key] === 'boolean') out[key] = config[key];
    }

    for (const key of ['glazeColor', 'creamColor', 'plateColor', 'candleColor',
        'topperColor', 'envBaseColor', 'envFlapColor', 'envSealColor']) {
        if (typeof config[key] === 'string' && /^#[0-9a-f]{6}$/i.test(config[key])) {
            out[key] = config[key];
        }
    }

    // Only https images, so a link cannot point the recipient's browser at an
    // arbitrary scheme or a plain-http tracker.
    if (typeof config.photo === 'string') {
        try {
            const url = new URL(config.photo);
            if (url.protocol === 'https:') out.photo = url.href;
        } catch {
            out.photo = '';
        }
    }
    return out;
}

// Instantiate App
new App();
