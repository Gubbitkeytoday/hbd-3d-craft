/**
 * Creator UI: a 3-step flow (who, cake, message & send) around the live 3D
 * preview in creator-scene.js.
 *
 * The form controls are the source of truth for values; this module adds the
 * state the DOM cannot hold: which templated texts the sender has edited
 * (dirty), which colors they explicitly picked (touched), the current step
 * and the draft. Everything visible goes through i18n.
 */
import { applyDOMTranslations, getCurrentLang, saveLanguageSetting, translations } from './i18n.js';
import { mountPreview, updatePreview, destroyPreview, hasWebGL, noteInteraction } from './creator-scene.js';
import { buildShareUrl } from './card-link.js';
import { buildTemplates } from './card-templates.js';
import { NEW_CARD_BACKDROP } from './backdrop-names.js';
import { loadCardFont } from './fonts.js';

// Looks: one tap sets the whole cake. Keys are form control names.
const LOOKS = {
    'pink-dream': { theme: 'neon-rose', cakeModel: 'vintage-heart', plate: 'crystal', glaze: 'strawberry', topperChoice: 'best-senpai', strawberries: 8, cherries: 2, rolls: 2, sprinkles: true, font: 'great-vibes', music: 'happy-birthday-synth' },
    'chocolate-royal': { theme: 'midnight-gold', cakeModel: 'triple-luxury', plate: 'golden', glaze: 'chocolate', topperChoice: 'star', strawberries: 0, cherries: 6, rolls: 5, sprinkles: false, font: 'playfair', music: 'happy-birthday-piano' },
    'mint-chocolate': { theme: 'pastel-mint', cakeModel: 'korean-bento', plate: 'cosmic', glaze: 'mint', topperChoice: 'star', strawberries: 4, cherries: 4, rolls: 4, sprinkles: true, font: 'outfit', music: 'happy-birthday-synth' },
    'midnight-gold': { theme: 'midnight-gold', cakeModel: 'cyber-prism', plate: 'cosmic', glaze: 'cream', topperChoice: 'hbd', strawberries: 0, cherries: 4, rolls: 6, sprinkles: true, font: 'playfair', music: 'happy-birthday-piano' },
    'sakura-sweet': { theme: 'sakura-blossom', cakeModel: 'classic-tiered', plate: 'ceramic', glaze: 'strawberry', topperChoice: 'best-senpai', strawberries: 6, cherries: 0, rolls: 0, sprinkles: true, font: 'great-vibes', music: 'happy-birthday-lofi' },
    'cosmic-crystal': { theme: 'cosmic-nebula', cakeModel: 'cyber-prism', plate: 'cosmic', glaze: 'mint', topperChoice: 'star', strawberries: 0, cherries: 3, rolls: 4, sprinkles: true, font: 'outfit', music: 'happy-birthday-synth' }
};

// Controls that change the 3D preview (anything else is text-only).
const CAKE_FIELDS = new Set(['theme', 'backdrop', 'cakeModel', 'plate', 'glaze', 'topperChoice', 'topperText', 'candles',
    'strawberries', 'cherries', 'rolls', 'sprinkles', 'decorHearts', 'decorStars', 'letterEnabled', 'letterTheme',
    'glazeColor', 'creamColor', 'plateColor', 'candleColor', 'topperColor', 'envBaseColor', 'envFlapColor', 'envSealColor']);
const ROOM_TEXT_FIELDS = new Set(['recipientName', 'sender', 'photo']);
let roomTextTimer = 0;
const COLOR_FIELDS = ['glazeColor', 'creamColor', 'plateColor', 'candleColor', 'topperColor', 'envBaseColor', 'envFlapColor', 'envSealColor'];
const TEMPLATED = ['title', 'message', 'letterTitle', 'letterBody'];
const TEXT_FIELDS_THAT_RETEMPLATE = new Set(['recipientName', 'sender', 'bdate', 'relation']);

const DRAFT_KEY = 'hbd_creator_draft_v2';
const HINT_KEY = 'hbd_creator_drag_hint_seen';
const BELATED_WINDOW_DAYS = 45;

let els = null;
let step = 1;
let dirty = { title: false, message: false, letterTitle: false, letterBody: false };
let touchedColors = new Set();
let nameErrorShown = false;
let draftTimer = 0;
let photoTimer = 0;
let toastTimer = 0;
let lastShareUrl = '';
let bound = false;
let bootToken = 0; // invalidates a deferred preview boot after destroy

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export function initCreator() {
    els = collectElements();
    const firstMount = !bound;
    if (firstMount) {
        bindUI();
        restoreDraft();
        bound = true;
    }
    applyLanguage();
    applyThemeClass();
    setBrowserThemeColor(true);
    syncColorPickers();
    refreshTemplates();
    refreshToggles();
    refreshLookEdited();
    goToStep(step, { focus: false, save: false });
    refreshPhotoCheck();

    startPreview();
}

export function destroyCreator() {
    bootToken++;
    destroyPreview();
    setBrowserThemeColor(false);
    clearTimeout(draftTimer);
    clearTimeout(photoTimer);
    if (els?.dialog?.open) els.dialog.close();
    if (els) delete els.root.dataset.kb;
    els?.canvasHost.classList.remove('is-ready', 'is-busy', 'is-error');
}

function collectElements() {
    const $ = (id) => document.getElementById(id);
    const form = $('creator-form');
    return {
        root: $('creator-view'),
        form,
        f: form.elements,
        canvasHost: $('preview-canvas-wrapper'),
        stage: document.querySelector('.cr-stage'),
        caption: $('cr-stage-caption'),
        dragHint: $('cr-drag-hint'),
        steps: [...document.querySelectorAll('.cr-step')],
        stepButtons: [...document.querySelectorAll('.cr-step-btn')],
        back: $('btn-step-back'),
        next: $('btn-step-next'),
        send: $('btn-generate-card'),
        stepOf: $('cr-step-of'),
        draftStatus: $('cr-draft-status'),
        startOver: $('btn-start-over'),
        nameInput: $('recipient-name'),
        nameError: $('recipient-name-error'),
        dateHint: $('birth-date-hint'),
        clearDate: $('btn-clear-date'),
        lookEdited: $('cr-look-edited'),
        topperGroup: $('custom-topper-text-group'),
        letterGroup: $('letter-details-group'),
        photoThumb: $('memory-photo-thumb'),
        photoStatus: $('memory-photo-status'),
        preview: $('btn-preview-recipient'),
        dialog: $('share-modal'),
        shareInput: $('share-url-input'),
        copyBtn: $('btn-copy-url'),
        copyFail: $('copy-fail-hint'),
        lineBtn: $('btn-share-line'),
        nativeBtn: $('btn-share-native'),
        testLink: $('btn-test-link'),
        closeDialog: $('btn-modal-close'),
        qrWrap: $('share-qr-wrap'),
        qrCanvas: $('share-qr'),
        toast: $('cr-toast'),
        actionbar: document.querySelector('.cr-actionbar'),
        example: $('cr-example-link'),
        langButtons: [...document.querySelectorAll('.cr-lang-btn')]
    };
}

/* ------------------------------------------------------------------ *
 * i18n helpers
 * ------------------------------------------------------------------ */

function dict() {
    return translations[getCurrentLang()] || translations.en;
}

function t(key, vars = {}) {
    const raw = dict()[key] ?? translations.en[key] ?? key;
    return raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Creator-only attribute translations (placeholders, aria-labels, {name} strings). */
function applyCreatorI18n() {
    const root = els.root;
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
        const key = el.dataset.i18nAria;
        let item = '';
        const target = el.dataset.stepFor && document.querySelector(`label[for="${el.dataset.stepFor}"]`);
        if (target) item = target.textContent.trim();
        el.setAttribute('aria-label', t(key, { item }));
    });
    refreshNameStrings();
    els.stepOf.textContent = t('crStepOf', { n: step });
}

/** Strings that include the recipient's name. */
function refreshNameStrings() {
    const name = nameValue();
    els.root.querySelectorAll('[data-i18n-tpl]').forEach((el) => {
        const key = el.dataset.i18nTpl;
        const anonKey = `${key}Anon`;
        el.textContent = !name && dict()[anonKey] ? t(anonKey) : t(key, { name: name || '…' });
    });
    wrapThaiPhrases();
}

/* ------------------------------------------------------------------ *
 * Thai line breaks
 *
 * Thai has no spaces between words, so the browser breaks lines at its
 * dictionary's word boundaries, and that dictionary splits compounds:
 * "วัน|เกิด" (birthday) ends up across two lines, which reads careless. For
 * headings and short copy only, runs of words that belong together are
 * wrapped in nowrap spans; breaks stay allowed between them. textContent is
 * unchanged, so screen readers and copy/paste see the same string.
 * ------------------------------------------------------------------ */

const WRAP_TARGETS = '.cr-step-title, .cr-hero, .cr-benefits span, .cr-step-label, .cr-label, .cr-label > span, .cr-hint, .cr-loader p, .cr-sheet-head h2, .cr-privacy, .cr-switch-title';
const THAI_RE = /[฀-๿]/;
/** Compounds the word dictionary splits but a Thai reader sees as one word
 *  (checked against every Thai creator string with Intl.Segmenter). */
const THAI_GLUE = new Set(['วันเกิด', 'เป่าเทียน', 'พร้อมส่ง', 'ย้อนหลัง', 'พื้นหลัง', 'คำอวยพร', 'ตัวอักษร', 'เนื้อความ',
    'ปิดผนึก', 'ขึ้นต้น', 'มือถือ', 'คัดลอก', 'จะบันทึก']);
/** Runs up to this long (UTF-16 units, marks included) stay whole. */
const THAI_SHORT_RUN = 12;
/** Longer nowrap chunks could overflow a phone line; leave them to the browser. */
const THAI_MAX_CHUNK = 18;
const wrapState = new WeakMap();
let thaiSegmenter;

function getThaiSegmenter() {
    if (thaiSegmenter === undefined) {
        try {
            thaiSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
        } catch {
            thaiSegmenter = null;
        }
    }
    return thaiSegmenter;
}

/** Splits one space-free Thai run into chunks that must not break inside. */
function thaiRunChunks(run, keep) {
    // The recipient's name is never split ("มิ้|นท์" is what the dictionary does).
    if (keep && keep.length <= THAI_MAX_CHUNK && run.includes(keep)) {
        if (run === keep) return [run];
        const at = run.indexOf(keep);
        return [
            ...(at > 0 ? thaiRunChunks(run.slice(0, at), '') : []),
            keep,
            ...thaiRunChunks(run.slice(at + keep.length), keep)
        ].filter(Boolean);
    }
    if (run.length <= THAI_SHORT_RUN || !THAI_RE.test(run)) return [run];
    const seg = getThaiSegmenter();
    if (!seg) return [run];
    const chunks = []; // { text, lastWord }
    let openBracket = '';
    for (const { segment, isWordLike } of seg.segment(run)) {
        const last = chunks[chunks.length - 1];
        if (!isWordLike && /^[([{“‘"']+$/.test(segment)) {
            openBracket += segment;
        } else if (!isWordLike && last && !openBracket) {
            last.text += segment; // punctuation sticks to the word before it
        } else if (last && !openBracket && THAI_GLUE.has(last.lastWord + segment)) {
            last.text += segment;
            last.lastWord += segment;
        } else {
            chunks.push({ text: openBracket + segment, lastWord: segment });
            openBracket = '';
        }
    }
    if (openBracket) chunks.push({ text: openBracket, lastWord: '' });
    // No orphan: a short last word ("แล้ว!") rides with the one before it.
    if (chunks.length >= 2) {
        const tail = chunks[chunks.length - 1];
        const bare = tail.text.replace(/[^฀-๿\w]/g, '');
        if (bare.length <= 4) {
            chunks.pop();
            chunks[chunks.length - 1].text += tail.text;
        }
    }
    return chunks.map((c) => c.text);
}

/** Tokens for a whole string: { text, glue } where glue marks a nowrap chunk. */
function thaiTokens(text, keep) {
    const seg = getThaiSegmenter();
    const words = (s) => (seg ? [...seg.segment(s)].filter((x) => x.isWordLike).length : 1);
    const tokens = [];
    for (const part of text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
            tokens.push({ text: part, space: true });
            continue;
        }
        for (const chunk of thaiRunChunks(part, keep)) {
            tokens.push({ text: chunk, glue: THAI_RE.test(chunk) && chunk.length <= THAI_MAX_CHUNK && words(chunk) > 1 });
        }
    }
    // A number stays with the word it counts: "3 มิติ".
    for (let i = 0; i + 2 < tokens.length; i++) {
        const [a, sp, b] = [tokens[i], tokens[i + 1], tokens[i + 2]];
        if (/^\d+$/.test(a.text) && sp.space && sp.text === ' ' && !b.space && THAI_RE.test(b.text)) {
            tokens.splice(i, 3, { text: a.text + sp.text + b.text, glue: true });
        }
    }
    return tokens;
}

function wrapThaiPhrases() {
    if (!els || getCurrentLang() !== 'th' || !getThaiSegmenter()) return;
    const keep = nameValue();
    els.root.querySelectorAll(WRAP_TARGETS).forEach((el) => {
        // Only plain-text elements (or ones this pass already wrapped).
        if (![...el.childNodes].every((n) => n.nodeType === 3 || (n.nodeType === 1 && n.classList.contains('cr-w')))) return;
        const text = el.textContent;
        const prev = wrapState.get(el);
        if (prev && prev.text === text && prev.keep === keep && (!prev.probe || prev.probe.parentNode === el)) return;
        if (!THAI_RE.test(text)) {
            wrapState.set(el, { text, keep, probe: null });
            return;
        }
        const frag = document.createDocumentFragment();
        let probe = null;
        for (const tok of thaiTokens(text, keep)) {
            if (tok.glue) {
                const span = document.createElement('span');
                span.className = 'cr-w';
                span.textContent = tok.text;
                probe ||= span;
                frag.appendChild(span);
            } else {
                frag.appendChild(document.createTextNode(tok.text));
            }
        }
        if (probe) el.replaceChildren(frag);
        else if (el.children.length) el.textContent = text;
        wrapState.set(el, { text, keep, probe });
    });
}

function applyLanguage() {
    const lang = getCurrentLang();
    applyDOMTranslations();
    applyCreatorI18n();
    els.langButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    refreshExampleLink();
}

/* ------------------------------------------------------------------ *
 * Form access
 * ------------------------------------------------------------------ */

function radioValue(name) {
    const checked = els.form.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : '';
}

function setRadio(name, value) {
    const input = els.form.querySelector(`input[name="${name}"][value="${CSS.escape(String(value))}"]`);
    if (input) input.checked = true;
}

function intValue(name) {
    const el = els.f[name];
    const n = parseInt(el.value, 10);
    const min = parseInt(el.min, 10);
    const max = parseInt(el.max, 10);
    if (!Number.isFinite(n)) return parseInt(el.defaultValue, 10);
    return Math.min(max, Math.max(min, n));
}

function nameValue() {
    return els.nameInput.value.trim();
}

/** The card as the viewer will receive it (full key names). */
function readConfig() {
    const f = els.f;
    const topperChoice = radioValue('topperChoice');
    const topperText = topperChoice === 'custom' ? f.topperText.value.trim() : '';
    const letterEnabled = f.letterEnabled.checked;
    const config = {
        recipientName: nameValue(),
        sender: f.sender.value.trim(),
        bdate: f.bdate.value || '',
        title: f.title.value.trim(),
        message: f.message.value.trim(),
        theme: radioValue('theme'),
        // New cards always carry a backdrop; only old links (none) fall back to night.
        backdrop: radioValue('backdrop') || NEW_CARD_BACKDROP,
        candles: intValue('candles'),
        music: radioValue('music'),
        font: radioValue('font'),
        photo: f.photo.value.trim(),
        cakeModel: radioValue('cakeModel'),
        plate: radioValue('plate'),
        glaze: radioValue('glaze'),
        // "Custom" is a UI choice: the plaque is drawn whenever topperText is set.
        topper: topperChoice === 'custom' ? 'hbd' : topperChoice,
        topperText,
        strawberries: intValue('strawberries'),
        cherries: intValue('cherries'),
        rolls: intValue('rolls'),
        sprinkles: f.sprinkles.checked,
        decorHearts: f.decorHearts.checked,
        decorStars: f.decorStars.checked,
        letterEnabled,
        letterTheme: radioValue('letterTheme'),
        // A disabled letter carries no text, which also keeps the link short.
        letterTitle: letterEnabled ? f.letterTitle.value.trim() : '',
        letterBody: letterEnabled ? f.letterBody.value.trim() : ''
    };
    // Untouched pickers stay '' so the link omits them and the receiver
    // derives the same colors from the chosen styles.
    COLOR_FIELDS.forEach((key) => { config[key] = touchedColors.has(key) ? f[key].value : ''; });
    return config;
}

/* ------------------------------------------------------------------ *
 * Templates (name-driven title, message and letter)
 * ------------------------------------------------------------------ */

/** Belated only when the birthday passed recently this year. */
function isBelated(bdate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bdate || '');
    if (!m) return false;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisYear = new Date(now.getFullYear(), Number(m[2]) - 1, Number(m[3]));
    const days = Math.round((today - thisYear) / 86400000);
    return days >= 1 && days <= BELATED_WINDOW_DAYS;
}

/** Inputs the shared template builder needs; also what a link carries instead of the text. */
function templateParams() {
    return {
        name: nameValue(),
        sender: els.f.sender.value.trim(),
        relation: radioValue('relation') || 'friend',
        belated: isBelated(els.f.bdate.value),
        lang: getCurrentLang()
    };
}

function templates() {
    const params = templateParams();
    return { ...buildTemplates(params), belated: params.belated };
}

/** Re-renders every templated field the sender has not edited. */
function refreshTemplates() {
    const name = nameValue();
    const tpl = templates();
    TEMPLATED.forEach((key) => {
        const el = els.f[key];
        // Without a name there is nothing sensible to greet; leave untouched
        // fields empty rather than "Happy birthday, !".
        if (!dirty[key]) el.value = name ? tpl[key] : '';
        const resetBtn = els.form.querySelector(`[data-reset-template="${key}"]`);
        if (resetBtn) resetBtn.hidden = !dirty[key] || !name;
    });
    els.dateHint.textContent = t(tpl.belated ? 'crDateBelated' : 'crDateHint');
    els.dateHint.classList.toggle('is-active', tpl.belated);
    els.clearDate.hidden = !els.f.bdate.value;
    refreshCounters();
    refreshNameStrings();
    refreshCaption();
}

function refreshCaption() {
    const title = els.f.title.value.trim();
    els.caption.textContent = nameValue() ? title : '';
    els.caption.hidden = !els.caption.textContent;
}

function refreshCounters() {
    els.form.querySelectorAll('[data-counter-for]').forEach((out) => {
        const input = document.getElementById(out.dataset.counterFor);
        const max = input.maxLength;
        const len = input.value.length;
        // Only speak up near the limit; a permanent counter is noise.
        out.textContent = max > 0 && len >= max * 0.8 ? `${len}/${max}` : '';
        out.classList.toggle('is-limit', len >= max);
    });
}

/* ------------------------------------------------------------------ *
 * Event wiring (bound once; #creator-view is static markup)
 * ------------------------------------------------------------------ */

function bindUI() {
    const { form } = els;

    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('input', onFieldChange);
    form.addEventListener('change', onFieldChange);

    // Enter in a single-line field moves on instead of submitting.
    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input[type="text"], input[type="date"], input[type="url"]')) {
            e.preventDefault();
            if (e.target === els.nameInput || e.target.name === 'sender') goToStep(step + 1);
        }
    });

    els.stepButtons.forEach((btn) => btn.addEventListener('click', () => goToStep(Number(btn.dataset.goto))));
    els.back.addEventListener('click', () => goToStep(step - 1));
    els.next.addEventListener('click', () => goToStep(step + 1));
    els.send.addEventListener('click', openShareSheet);
    els.preview.addEventListener('click', previewAsRecipient);

    // Steppers: − / + buttons around a number input.
    form.querySelectorAll('.cr-num-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.stepFor);
            const next = Math.min(Number(input.max), Math.max(Number(input.min), intValue(input.name) + Number(btn.dataset.delta)));
            if (String(next) === input.value) return;
            input.value = String(next);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    });

    form.querySelectorAll('[data-reset-template]').forEach((btn) => {
        btn.addEventListener('click', () => {
            dirty[btn.dataset.resetTemplate] = false;
            refreshTemplates();
            scheduleDraftSave();
        });
    });

    els.clearDate.addEventListener('click', () => {
        els.f.bdate.value = '';
        els.f.bdate.dispatchEvent(new Event('input', { bubbles: true }));
        els.f.bdate.focus();
    });

    document.getElementById('btn-reset-colors').addEventListener('click', () => {
        touchedColors.clear();
        syncColorPickers();
        pushPreview();
        scheduleDraftSave();
    });

    els.lookEdited.addEventListener('click', () => {
        const look = radioValue('preset');
        if (look) applyLook(look);
    });

    els.startOver.addEventListener('click', startOver);

    els.langButtons.forEach((btn) => btn.addEventListener('click', () => {
        saveLanguageSetting(btn.dataset.lang);
        applyLanguage();
        refreshTemplates();
        pushPreview(); // the envelope label is baked into a texture
    }));

    bindShareSheet();
    bindKeyboard();
}

/* ------------------------------------------------------------------ *
 * On-screen keyboard (phones)
 *
 * Android (interactive-widget=resizes-content) shrinks the layout viewport;
 * iOS keeps it and shrinks only the visual viewport. Either way the visible
 * height drops well below the tallest height seen at this width. While that
 * holds and a text field has focus, data-kb on the root collapses the preview
 * to a strip and hides the action bar (CSS), and the field plus its label are
 * scrolled into the band between the strip and the keyboard. Focus alone is
 * not enough: Android's back key closes the keyboard but keeps focus.
 * ------------------------------------------------------------------ */

const TEXT_ENTRY = 'input[type="text"], input[type="url"], input[type="number"], input[type="search"], input:not([type]), textarea';
const KB_MIN_DROP = 120; // px the viewport must lose to count as a keyboard
const KB_SHORT = 500;    // a touch viewport this short while typing is treated the same
const KB_TIGHT = 360;    // below this the preview strip goes entirely
const kbBaseline = new Map(); // viewport width -> tallest height seen
let kbFrame = 0;
let kbTimer = 0;
let kbLastHeight = 0;

function bindKeyboard() {
    const schedule = (reveal) => {
        cancelAnimationFrame(kbFrame);
        kbFrame = requestAnimationFrame(() => updateKeyboard(reveal));
    };
    els.form.addEventListener('focusin', (e) => {
        if (!e.target.matches?.(TEXT_ENTRY)) return;
        schedule(true);
        // The keyboard slides in over ~250 ms; settle again once it is up.
        clearTimeout(kbTimer);
        kbTimer = setTimeout(() => updateKeyboard(true), 320);
    });
    els.form.addEventListener('focusout', () => schedule(false));
    const onResize = () => {
        const h = viewportHeight();
        const shrank = h < kbLastHeight - 1;
        kbLastHeight = h;
        schedule(shrank);
    };
    window.visualViewport?.addEventListener('resize', onResize);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => kbBaseline.clear());
}

function viewportHeight() {
    return window.visualViewport ? window.visualViewport.height : window.innerHeight;
}

function isPhoneLayout() {
    return window.matchMedia('(max-width: 1023.98px)').matches;
}

function typingField() {
    const el = document.activeElement;
    return el && els.form.contains(el) && el.matches(TEXT_ENTRY) && !el.readOnly ? el : null;
}

function updateKeyboard(reveal) {
    kbFrame = 0;
    if (!els || !els.root.classList.contains('active-view')) return;
    const width = Math.round(window.innerWidth);
    const h = viewportHeight();
    const base = Math.max(kbBaseline.get(width) || 0, window.innerHeight, h);
    kbBaseline.set(width, base);
    kbLastHeight = h;
    const field = typingField();
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const open = !!field && isPhoneLayout() && (base - h >= KB_MIN_DROP || (coarse && h < KB_SHORT));
    const state = open ? (h < KB_TIGHT ? 'tight' : 'open') : '';
    if ((els.root.dataset.kb || '') !== state) {
        if (state) els.root.dataset.kb = state;
        else delete els.root.dataset.kb;
    }
    if (field && reveal && isPhoneLayout()) revealField(field);
}

/** Scrolls the page so the field and its label sit between the pinned
 *  preview and the keyboard (or the action bar when that is showing). */
function revealField(field) {
    const vv = window.visualViewport;
    const viewTop = vv ? vv.offsetTop : 0;
    const viewBottom = viewTop + viewportHeight();
    const stage = els.stage.getBoundingClientRect();
    const top = Math.max(viewTop, stage.height ? stage.bottom : 0) + 8;
    let bottom = viewBottom - 8;
    const bar = els.actionbar?.getBoundingClientRect();
    if (bar && bar.height && bar.top < bottom) bottom = bar.top - 8;
    if (bottom - top < 40) return;
    const box = field.getBoundingClientRect();
    const label = field.labels?.[0] || field.closest('.cr-field')?.querySelector('.cr-label');
    const labelBox = label && label.getBoundingClientRect();
    const wantTop = labelBox && labelBox.height ? Math.min(labelBox.top, box.top) : box.top;
    // The whole field when it fits; otherwise its label and first lines.
    const wantBottom = Math.min(box.bottom, wantTop + (bottom - top));
    let delta = 0;
    if (wantBottom > bottom) delta = wantBottom - bottom;
    if (wantTop - delta < top) delta = wantTop - top;
    if (Math.abs(delta) >= 2) window.scrollBy({ top: delta, behavior: 'auto' });
}

function onFieldChange(e) {
    const el = e.target;
    const name = el.name;
    if (!name) return;
    noteInteraction();

    if (name === 'recipientName' && nameErrorShown && nameValue()) showNameError(false);

    if (TEMPLATED.includes(name)) {
        if (e.type === 'input') dirty[name] = el.value !== (nameValue() ? templates()[name] : '');
        const resetBtn = els.form.querySelector(`[data-reset-template="${name}"]`);
        if (resetBtn) resetBtn.hidden = !dirty[name];
        refreshCounters();
        if (name === 'title') refreshCaption();
    } else if (TEXT_FIELDS_THAT_RETEMPLATE.has(name)) {
        refreshTemplates();
    }

    if (name === 'preset' && e.type === 'change') {
        applyLook(el.value);
        return;
    }
    if (COLOR_FIELDS.includes(name)) touchedColors.add(name);
    if (name === 'theme' || name === 'backdrop') applyThemeClass();
    if (['theme', 'glaze', 'plate', 'letterTheme'].includes(name)) syncColorPickers();
    if (name === 'topperChoice' || name === 'letterEnabled') refreshToggles();
    if (name === 'photo') refreshPhotoCheck();
    if (el.type === 'number' && e.type === 'change') el.value = String(intValue(name));
    if (el.type === 'number') refreshSteppers();

    if (CAKE_FIELDS.has(name)) {
        // Text inputs fire per keystroke; colors fire continuously while
        // dragging. updatePreview coalesces both into one build per frame.
        pushPreview();
        refreshLookEdited();
    } else if (ROOM_TEXT_FIELDS.has(name)) {
        // The party room's name sign and frame print follow these; they are
        // redrawn textures, so wait for a pause in typing.
        clearTimeout(roomTextTimer);
        roomTextTimer = setTimeout(pushPreview, 300);
    }
    refreshCounters();
    scheduleDraftSave();
}

function refreshToggles() {
    els.topperGroup.hidden = radioValue('topperChoice') !== 'custom';
    els.letterGroup.hidden = !els.f.letterEnabled.checked;
    refreshSteppers();
}

function refreshSteppers() {
    els.form.querySelectorAll('.cr-num-btn').forEach((btn) => {
        const input = document.getElementById(btn.dataset.stepFor);
        const v = intValue(input.name);
        btn.disabled = Number(btn.dataset.delta) < 0 ? v <= Number(input.min) : v >= Number(input.max);
    });
}

/* ------------------------------------------------------------------ *
 * Looks, theme, colors
 * ------------------------------------------------------------------ */

function applyLook(lookId) {
    const look = LOOKS[lookId];
    if (!look) return;
    setRadio('preset', lookId);
    for (const [key, value] of Object.entries(look)) {
        const el = els.f[key];
        if (!el) continue;
        if (typeof value === 'boolean') el.checked = value;
        else if (typeof value === 'number') el.value = String(value);
        else setRadio(key, value);
    }
    // A look is a fresh start for colors too.
    touchedColors.clear();
    applyThemeClass();
    syncColorPickers();
    refreshToggles();
    refreshLookEdited();
    pushPreview();
    scheduleDraftSave();
}

function currentValue(key) {
    const el = els.f[key];
    if (!el) return undefined;
    if (el instanceof RadioNodeList) return radioValue(key);
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return intValue(key);
    return el.value;
}

function refreshLookEdited() {
    const lookId = radioValue('preset');
    const look = LOOKS[lookId];
    const edited = !!look && (touchedColors.size > 0 || Object.entries(look).some(([k, v]) => currentValue(k) !== v));
    els.lookEdited.hidden = !edited;
}

/** The creator's chrome follows the chosen theme (one source of truth). The
 *  backdrop also tints the preview frame, so it matches before WebGL paints. */
function applyThemeClass() {
    const theme = radioValue('theme') || 'neon-rose';
    document.body.className = `theme-${theme}`;
    els.root.dataset.backdrop = radioValue('backdrop') || NEW_CARD_BACKDROP;
}

/** The creator is a light page: match the browser chrome (restored on leave). */
let prevThemeColor = null;
function setBrowserThemeColor(on) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    if (on) {
        if (prevThemeColor === null) prevThemeColor = meta.content;
        meta.content = '#fbf6f1';
    } else if (prevThemeColor !== null) {
        meta.content = prevThemeColor;
        prevThemeColor = null;
    }
}

const STYLE_COLORS = {
    glaze: { chocolate: '#311a11', strawberry: '#e92e52', mint: '#7be2a6', cream: '#fffcf7' },
    plate: { ceramic: '#fbfbf8', crystal: '#ffe6f2', golden: '#d4af37', cosmic: '#090712' },
    cream: { 'neon-rose': '#ed004c', 'midnight-gold': '#151310', 'pastel-mint': '#3d8df5', 'lavender-dream': '#22003c', 'sakura-blossom': '#ffb3c6', 'cyber-retro': '#ff5e62', 'forest-moss': '#004b23', 'cosmic-nebula': '#0f0c20', 'choco-monarch': '#241108' },
    topper: { 'neon-rose': '#ff0055', 'midnight-gold': '#ffd700', 'pastel-mint': '#00f2fe', 'lavender-dream': '#8000ff', 'sakura-blossom': '#ff758f', 'cyber-retro': '#ff3399', 'forest-moss': '#00ff88', 'cosmic-nebula': '#8a2be2', 'choco-monarch': '#cca43b' },
    candle: { 'neon-rose': '#ff0055', 'midnight-gold': '#ffd700', 'pastel-mint': '#00f2fe', 'lavender-dream': '#d155ff', 'sakura-blossom': '#ffccd5', 'cyber-retro': '#ff9966', 'forest-moss': '#ffd700', 'cosmic-nebula': '#00ffd5', 'choco-monarch': '#5c3d2e' },
    envelope: {
        cyber: ['#1a1b22', '#00f2fe', '#ff0055'],
        royal: ['#111111', '#111111', '#d4af37'],
        romance: ['#fff0f3', '#fff0f3', '#900c3f'],
        steampunk: ['#5c3d2e', '#5c3d2e', '#b87333']
    }
};

/** Shows the style-derived color in every picker the sender has not touched. */
function syncColorPickers() {
    const theme = radioValue('theme');
    const env = STYLE_COLORS.envelope[radioValue('letterTheme')] || STYLE_COLORS.envelope.royal;
    const derived = {
        glazeColor: STYLE_COLORS.glaze[radioValue('glaze')],
        creamColor: STYLE_COLORS.cream[theme],
        plateColor: STYLE_COLORS.plate[radioValue('plate')],
        candleColor: STYLE_COLORS.candle[theme],
        topperColor: STYLE_COLORS.topper[theme],
        envBaseColor: env[0],
        envFlapColor: env[1],
        envSealColor: env[2]
    };
    COLOR_FIELDS.forEach((key) => {
        if (!touchedColors.has(key) && derived[key]) els.f[key].value = derived[key];
    });
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

function showNameError(show) {
    nameErrorShown = show;
    els.nameError.hidden = !show;
    els.nameInput.setAttribute('aria-invalid', String(show));
}

/** Only the name is required; every later step and Send checks it. */
function requireName() {
    if (nameValue()) return true;
    showNameError(true);
    if (step !== 1) goToStep(1, { focus: false });
    els.nameInput.focus();
    return false;
}

function goToStep(target, { focus = true, save = true } = {}) {
    const n = Math.min(3, Math.max(1, target));
    if (n > 1 && !requireName()) return;
    step = n;
    els.root.dataset.step = String(n);
    els.steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== n; });
    els.stepButtons.forEach((b) => {
        const i = Number(b.dataset.goto);
        if (i === n) b.setAttribute('aria-current', 'step');
        else b.removeAttribute('aria-current');
        b.classList.toggle('is-complete', i < n);
    });
    els.back.classList.toggle('is-hidden', n === 1);
    els.back.disabled = n === 1;
    els.next.hidden = n === 3;
    els.send.hidden = n !== 3;
    els.stepOf.textContent = t('crStepOf', { n });
    if (n === 3) ['playfair', 'great-vibes'].forEach((id) => loadCardFont(id));

    const scroller = els.form;
    if (focus) {
        scroller.scrollTop = 0;
        // On phones the page itself scrolls; bring the step heading into view.
        const title = els.steps[n - 1].querySelector('.cr-step-title');
        title?.focus({ preventScroll: true });
        if (window.matchMedia('(max-width: 1023px)').matches) {
            els.stage.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        }
    }
    if (save) scheduleDraftSave();
}

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------------ *
 * Preview
 * ------------------------------------------------------------------ */

function startPreview() {
    const host = els.canvasHost;
    host.classList.remove('is-ready', 'is-error');
    if (!hasWebGL()) {
        showPreviewError();
        return;
    }
    // Paint the form first; boot WebGL once the browser is idle (or after
    // 1.2 s at the latest), so typing works from the first frame.
    const token = ++bootToken;
    const boot = () => token === bootToken && mountPreview(host, readConfig(), {
        labelText: () => t('tapToOpen'),
        onReady: () => {
            host.classList.add('is-ready');
            maybeShowDragHint();
        },
        onError: showPreviewError,
        onBusy: (busy) => els.stage.classList.toggle('is-busy', busy),
        onDrag: hideDragHint
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if ('requestIdleCallback' in window) requestIdleCallback(boot, { timeout: 1200 });
        else setTimeout(boot, 50);
    }));
}

function pushPreview() {
    updatePreview(readConfig());
}

function showPreviewError() {
    const host = els.canvasHost;
    host.classList.add('is-error');
    const loader = host.querySelector('.cr-loader p');
    if (loader) loader.textContent = t('crNoWebgl');
    wrapThaiPhrases();
}

function maybeShowDragHint() {
    let seen = false;
    try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch { /* storage blocked */ }
    els.dragHint.classList.toggle('is-visible', !seen);
}

function hideDragHint() {
    if (!els.dragHint.classList.contains('is-visible')) return;
    els.dragHint.classList.remove('is-visible');
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* storage blocked */ }
}

/* ------------------------------------------------------------------ *
 * Photo check
 * ------------------------------------------------------------------ */

function refreshPhotoCheck() {
    clearTimeout(photoTimer);
    const value = els.f.photo.value.trim();
    const status = els.photoStatus;
    const thumb = els.photoThumb;
    status.className = 'cr-status';
    if (!value) {
        status.textContent = '';
        thumb.hidden = true;
        thumb.removeAttribute('src');
        return;
    }
    let url;
    try { url = new URL(value); } catch { url = null; }
    if (!url || url.protocol !== 'https:') {
        status.textContent = t('crPhotoHttps');
        status.classList.add('is-warn');
        thumb.hidden = true;
        return;
    }
    status.textContent = t('crPhotoChecking');
    photoTimer = setTimeout(() => {
        // Same requirement as the viewer: the image must allow CORS.
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (els.f.photo.value.trim() !== value) return;
            thumb.src = value;
            thumb.hidden = false;
            status.textContent = t('crPhotoOk');
            status.className = 'cr-status is-ok';
        };
        img.onerror = () => {
            if (els.f.photo.value.trim() !== value) return;
            thumb.hidden = true;
            status.textContent = t('crPhotoFail');
            status.className = 'cr-status is-warn';
        };
        img.src = value;
    }, 450);
}

/* ------------------------------------------------------------------ *
 * Share sheet
 * ------------------------------------------------------------------ */

function isMobileDevice() {
    const ua = navigator.userAgent;
    return /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

function shareText() {
    const name = nameValue();
    const sender = els.f.sender.value.trim();
    let text = t('crShareText', { name });
    if (sender) text += `\n${t('crShareTextFrom', { sender })}`;
    return text;
}

async function makeLink() {
    // Untouched fields travel as a "template" flag and are rebuilt by the
    // receiver from the same inputs, which is most of the link's length.
    const { relation, belated, lang } = templateParams();
    const templated = TEMPLATED.filter((key) => !dirty[key]);
    return buildShareUrl({ ...readConfig(), relation, belated, lang, templated });
}

async function openShareSheet() {
    if (!requireName()) return;
    let url;
    try {
        url = await makeLink();
    } catch (err) {
        console.error('Could not build the share link:', err);
        showToast(t('crLinkError'));
        return;
    }
    lastShareUrl = url;
    const text = shareText();

    els.shareInput.value = url;
    els.testLink.href = url;
    els.copyFail.hidden = true;
    resetCopyButton();
    els.lineBtn.href = isMobileDevice()
        ? `https://line.me/R/share?text=${encodeURIComponent(`${text}\n${url}`)}`
        : `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`;
    els.nativeBtn.hidden = typeof navigator.share !== 'function';
    refreshNameStrings();

    // Desktop: a QR code moves the link to a phone. Phones don't need it.
    const wantQr = !isMobileDevice() && window.matchMedia('(min-width: 768px)').matches;
    els.qrWrap.hidden = true;
    if (wantQr) {
        import('./vendor/qr.js').then(({ drawQr }) => {
            if (lastShareUrl !== url) return;
            try {
                drawQr(els.qrCanvas, url, { cssSize: 208 });
                els.qrWrap.hidden = false;
            } catch (err) {
                // Longer than a QR can hold: the sheet simply goes without one.
                console.warn('QR code skipped:', err);
            }
        });
    }

    if (!els.dialog.open) els.dialog.showModal();
    els.lineBtn.focus();
}

function bindShareSheet() {
    const { dialog } = els;
    els.closeDialog.addEventListener('click', () => dialog.close());
    // Click on the backdrop closes the sheet (the dialog box itself is padded).
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            const r = dialog.getBoundingClientRect();
            const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            if (!inside) dialog.close();
        }
    });
    // Return focus to the Send button (native dialog does this, but only if
    // the trigger is still focusable; be explicit).
    dialog.addEventListener('close', () => {
        if (step === 3 && !els.send.hidden) els.send.focus();
    });

    els.copyBtn.addEventListener('click', copyLink);
    els.nativeBtn.addEventListener('click', () => {
        navigator.share({ title: t('crSheetTitle', { name: nameValue() }), text: shareText(), url: lastShareUrl })
            .catch(() => { /* dismissed by the user */ });
    });
}

async function copyLink() {
    const url = els.shareInput.value;
    let ok = false;
    try {
        await navigator.clipboard.writeText(url);
        ok = true;
    } catch {
        // Older in-app browsers and insecure contexts: legacy path.
        try {
            els.shareInput.focus();
            els.shareInput.select();
            ok = document.execCommand('copy');
        } catch {
            ok = false;
        }
    }
    if (ok) {
        els.copyFail.hidden = true;
        els.copyBtn.classList.add('is-done');
        els.copyBtn.querySelector('use').setAttribute('href', '#cr-i-check');
        showToast(t('crCopied'));
        setTimeout(resetCopyButton, 2200);
    } else {
        els.shareInput.focus();
        els.shareInput.select();
        els.copyFail.hidden = false;
    }
}

function resetCopyButton() {
    els.copyBtn.classList.remove('is-done');
    els.copyBtn.querySelector('use').setAttribute('href', '#cr-i-copy');
}

function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 2500);
}

async function previewAsRecipient() {
    if (!requireName()) return;
    // Open synchronously (popup blockers need the user gesture), then point
    // the tab at the link once it is built.
    const tab = window.open('', '_blank');
    try {
        const url = await makeLink();
        if (tab) {
            tab.opener = null;
            tab.location.href = url;
        } else {
            window.location.href = url;
        }
    } catch (err) {
        tab?.close();
        console.error('Could not build the preview link:', err);
        showToast(t('crLinkError'));
    }
}

async function refreshExampleLink() {
    const name = t('crExampleName');
    const example = {
        recipientName: name,
        title: t('tplTitle', { name }),
        message: t('tplMsgFriend'),
        theme: 'neon-rose',
        backdrop: NEW_CARD_BACKDROP,
        cakeModel: 'vintage-heart',
        plate: 'crystal',
        glaze: 'strawberry',
        topper: 'best-senpai',
        strawberries: 8,
        cherries: 2,
        rolls: 2,
        letterEnabled: true,
        letterTheme: 'romance',
        letterTitle: t('tplLetterTitle', { name }),
        letterBody: t('tplLetterFriend', { name })
    };
    try {
        els.example.href = await buildShareUrl(example);
    } catch {
        els.example.hidden = true;
    }
}

/* ------------------------------------------------------------------ *
 * Draft autosave
 * ------------------------------------------------------------------ */

function collectDraft() {
    const values = {};
    [...els.form.elements].forEach((el) => {
        if (!el.name) return;
        if (el.type === 'radio') {
            if (el.checked) values[el.name] = el.value;
        } else if (el.type === 'checkbox') {
            values[el.name] = el.checked;
        } else {
            values[el.name] = el.value;
        }
    });
    return { v: 1, values, dirty, touched: [...touchedColors], step, savedAt: Date.now() };
}

function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify(collectDraft()));
            els.draftStatus.textContent = t('crDraftSaved');
            els.startOver.hidden = false;
        } catch {
            // Private mode or storage full: the card still works, just no draft.
        }
    }, 400);
}

function restoreDraft() {
    let draft = null;
    try {
        draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    } catch {
        draft = null;
    }
    if (!draft || draft.v !== 1 || !draft.values) return;
    for (const [name, value] of Object.entries(draft.values)) {
        const el = els.f[name];
        if (!el) continue;
        if (el instanceof RadioNodeList) setRadio(name, value);
        else if (el.type === 'checkbox') el.checked = !!value;
        else if (typeof value === 'string') el.value = value;
    }
    TEMPLATED.forEach((key) => { dirty[key] = !!draft.dirty?.[key]; });
    touchedColors = new Set((draft.touched || []).filter((k) => COLOR_FIELDS.includes(k)));
    step = nameValue() ? Math.min(3, Math.max(1, Number(draft.step) || 1)) : 1;
    els.startOver.hidden = false;
}

function startOver() {
    if (!window.confirm(t('crStartOverConfirm'))) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage blocked */ }
    els.form.reset();
    dirty = { title: false, message: false, letterTitle: false, letterBody: false };
    touchedColors.clear();
    showNameError(false);
    els.draftStatus.textContent = '';
    els.startOver.hidden = true;
    applyThemeClass();
    syncColorPickers();
    refreshTemplates();
    refreshToggles();
    refreshLookEdited();
    refreshPhotoCheck();
    goToStep(1, { save: false });
    pushPreview();
    els.nameInput.focus();
}
