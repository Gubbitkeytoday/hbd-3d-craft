import './style.css';
import { initCreator, destroyCreator } from './creator.js';
import { initViewer, destroyViewer } from './viewer.js';

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

    handleRouting() {
        const hash = window.location.hash || '#/';
        
        // Clean up previous states to avoid memory/Three.js render leaks
        this.cleanupCurrentView();

        if (hash.startsWith('#/view/')) {
            // Receiver View (Senpai Interactive Card)
            this.creatorView.classList.remove('active-view');
            this.receiverView.classList.add('active-view');
            this.mountReceiverView(hash);
        } else {
            // Creator View / Dashboard (Default)
            this.receiverView.classList.remove('active-view');
            this.creatorView.classList.add('active-view');
            this.mountCreatorView();
        }
    }

    cleanupCurrentView() {
        destroyCreator();
        destroyViewer();
    }

    mountCreatorView() {
        // Set default theme for Dashboard
        this.applyTheme('neon-rose');
        initCreator();
    }

    mountReceiverView(hash) {
        // Syntax: #/view/RecipientName?d=BASE64_DATA
        const pathPart = hash.replace('#/view/', '');
        const queryIndex = pathPart.indexOf('?');
        
        let recipientName = 'ครีม';
        let encodedData = '';

        if (queryIndex !== -1) {
            recipientName = decodeURIComponent(pathPart.substring(0, queryIndex));
            const queryParams = new URLSearchParams(pathPart.substring(queryIndex));
            encodedData = queryParams.get('d') || '';
        } else if (pathPart && pathPart !== '#/' && pathPart !== '') {
            recipientName = decodeURIComponent(pathPart);
        } else {
            recipientName = 'ครีม';
        }

        // Decode URL Configuration data
        const cardConfig = this.decodeCardData(encodedData);
        if (!cardConfig.recipientName || cardConfig.recipientName === 'Senpai') {
            cardConfig.recipientName = recipientName;
        }

        // Apply visual theme from the encoded greeting configuration
        this.applyTheme(cardConfig.theme || 'neon-rose');

        // Initialize the interactive 3D WebGL card
        initViewer(cardConfig);
    }

    // Helper: Swaps body class to shift the entire CSS HSL variable design tokens
    applyTheme(themeName) {
        document.body.className = '';
        document.body.classList.add(`theme-${themeName}`);
    }

    // Helper: Safely compresses/decompresses custom state using Base64 URI encoder
    decodeCardData(base64String) {
        const defaults = {
            title: 'สุขสันต์วันเกิดครีม!',
            message: 'สุขสันต์วันเกิดนะครีม! 🎂 ขอให้ปีนี้เป็นปีที่ดีที่สุดของครีม สุขภาพแข็งแรง สมหวังในทุกเรื่องที่ตั้งใจ และมีความสุขมาก ๆ ทุกวันเลยนะ ✨🍰',
            theme: 'neon-rose',
            candles: 5,
            music: 'happy-birthday-lofi',
            font: 'outfit',
            photo: '',
            preset: '',
            plate: 'ceramic',
            glaze: 'chocolate',
            topper: 'best-senpai',
            strawberries: 4,
            cherries: 4,
            rolls: 3,
            sprinkles: true,
            letterEnabled: true,
            letterTheme: 'cyber',
            letterTitle: 'ถึงครีมคนพิเศษ',
            letterBody: 'ถึงครีมที่รัก,\n\nอยากส่งจดหมายลับใบนี้ลอยมาในอวกาศเค้กวันเกิด 3 มิติ เพื่อบอกว่าครีมเป็นคนที่พิเศษมาก ๆ\n\nขอให้ปีนี้เต็มไปด้วยความสุข รอยยิ้ม และความทรงจำหวาน ๆ นะ ✨🍩🪐',
            topperText: '',
            decorHearts: false,
            decorStars: false,
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
            return { ...defaults, ...parsed };
        } catch (e) {
            console.error('Failed to decode shareable URL data, fallback to defaults:', e);
            return defaults;
        }
    }

    setupGlobalEvents() {
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

// Instantiate App
new App();
