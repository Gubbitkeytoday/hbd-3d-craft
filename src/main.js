import './style.css';
import './styles/icons.css';
import './styles/creator.css';
import './styles/receiver.css';
import { decodeCardHash } from './card-link.js';
import { BACKDROP_NAMES } from './backdrop-names.js';

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

        if (hash.startsWith('#/view/') || hash.startsWith('#/c/')) {
            // Receiver View: decode the link while the viewer chunk downloads.
            this.creatorView.classList.remove('active-view');
            this.receiverView.classList.add('active-view');
            const decoded = decodeCardHash(hash);
            await loadViewer();
            if (token === this.routeToken) await this.mountReceiverView(decoded, token);
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
        // The creator owns its theme (restored drafts, looks), so it applies
        // the body class itself instead of a hard-coded default here.
        creatorModule.initCreator();
    }

    async mountReceiverView(decoded, token) {
        // Links: #/c/<compact> (current), #/view/?z=1.<deflate> or #/view/<name>?d=<base64>
        // (legacy). Both are decoded, then forced through the sanitizer.
        const { config, defaults } = await decoded;
        if (token !== this.routeToken) return;
        const cardConfig = sanitizeCardConfig(config, defaults);

        // Apply visual theme from the encoded greeting configuration
        this.applyTheme(cardConfig.theme);

        // Initialize the interactive 3D WebGL card
        viewerModule.initViewer(cardConfig);
    }

    // Helper: Swaps body class to shift the entire CSS HSL variable design tokens
    applyTheme(themeName) {
        document.body.className = '';
        document.body.classList.add(`theme-${themeName}`);
    }

    setupGlobalEvents() {
        // Escape closes whichever dialog is on top.
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            // The share sheet is a native <dialog>, which handles Escape itself.
            const closeIds = ['btn-close-letter', 'btn-close-greeting-card'];
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

function clampText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Allowed values come straight from the creator's own controls (radio groups
// and selects inside #creator-form), so the list can never drift from what
// the UI is able to produce. The creator markup is always in the document.
function allowedValues(name) {
    const values = new Set();
    document.querySelectorAll(`#creator-form [name="${name}"]`).forEach((el) => {
        if (el.tagName === 'SELECT') [...el.options].forEach(o => values.add(o.value));
        else values.add(el.value);
    });
    return values;
}

// The fixed, append-only list is the source of truth (the link codec packs
// its index); the creator's radios can only add to it, never hide a value a
// link may legitimately carry (e.g. 'party' before its picker exists).
function backdropValues() {
    const values = allowedValues('backdrop');
    BACKDROP_NAMES.forEach((name) => values.add(name));
    return values;
}

// Share links are attacker-controllable input: everything decoded from one is
// forced back into the shape the creator would have produced.
function sanitizeCardConfig(config, defaults) {
    const out = { ...defaults };
    const topperValues = allowedValues('topperChoice');
    topperValues.delete('custom');
    const presetValues = allowedValues('preset');
    presetValues.add('');
    const enums = {
        theme: allowedValues('theme'),
        preset: presetValues,
        music: allowedValues('music'),
        font: allowedValues('font'),
        letterTheme: allowedValues('letterTheme'),
        cakeModel: allowedValues('cakeModel'),
        plate: allowedValues('plate'),
        glaze: allowedValues('glaze'),
        topper: topperValues,
        backdrop: backdropValues()
    };
    for (const [key, allowed] of Object.entries(enums)) {
        if (allowed.has(config[key])) out[key] = config[key];
    }

    const texts = { recipientName: 40, sender: 40, bdate: 10, title: 120, message: 2000,
        letterTitle: 120, letterBody: 4000, topperText: 16 };
    for (const [key, max] of Object.entries(texts)) {
        out[key] = typeof config[key] === 'string' ? clampText(config[key], max) : (defaults[key] || '');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.bdate)) out.bdate = '';

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
        out[key] = typeof config[key] === 'string' && /^#[0-9a-f]{6}$/i.test(config[key]) ? config[key] : '';
    }

    // Only https images, so a link cannot point the recipient's browser at an
    // arbitrary scheme or a plain-http tracker.
    out.photo = '';
    if (typeof config.photo === 'string' && config.photo) {
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
