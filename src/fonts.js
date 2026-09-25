/**
 * Font loading + text helpers.
 *
 * UI fonts (Outfit, Noto Sans Thai) are declared statically in
 * src/styles/fonts.css. Card-only fonts are injected on demand:
 *
 *   import { loadCardFont } from './fonts.js';
 *   await loadCardFont('playfair');      // card config id ('playfair' | 'great-vibes' | 'outfit')
 *   await loadCardFont('Great Vibes');   // or a family name
 *
 * The promise resolves (never rejects) once the faces are usable, or after a
 * timeout, with `true` when the font actually loaded. Pairs are loaded
 * together so Thai text renders in a matching face: Playfair Display + Noto
 * Serif Thai, Great Vibes + Mali. CSS stacks already name these families with
 * generic fallbacks, so calling this late only swaps (font-display: swap).
 *
 * Canvas text (the cake topper) must await the font before drawing, or the
 * fallback face gets baked into the texture: see fontReadyForCanvas().
 */

// Latin/Thai subsets only; each import injects one small @font-face sheet.
const FAMILY_LOADERS = {
    'Playfair Display': () => Promise.all([
        import('@fontsource/playfair-display/latin-600.css'),
        import('@fontsource/playfair-display/latin-700.css'),
        import('@fontsource/playfair-display/latin-400-italic.css'),
        import('@fontsource/playfair-display/latin-600-italic.css')
    ]),
    'Noto Serif Thai': () => Promise.all([
        import('@fontsource/noto-serif-thai/thai-600.css'),
        import('@fontsource/noto-serif-thai/thai-700.css')
    ]),
    'Great Vibes': () => import('@fontsource/great-vibes/latin-400.css'),
    Mali: () => Promise.all([
        import('@fontsource/mali/thai-500.css'),
        import('@fontsource/mali/thai-600.css')
    ])
};

// Descriptor used to force the browser to fetch each face (weight matters).
const PROBES = {
    'Playfair Display': ['600 1em "Playfair Display"', 'italic 600 1em "Playfair Display"'],
    'Noto Serif Thai': ['600 1em "Noto Serif Thai"'],
    'Great Vibes': ['400 1em "Great Vibes"'],
    Mali: ['500 1em "Mali"'],
    Outfit: ['700 1em "Outfit"'],
    'Noto Sans Thai': ['700 1em "Noto Sans Thai"']
};

const THAI_SAMPLE = 'กขคสุขสันต์';
const THAI_FAMILIES = new Set(['Noto Serif Thai', 'Mali', 'Noto Sans Thai']);

/** Card config id or family name -> families to load together. */
const ALIASES = {
    playfair: ['Playfair Display', 'Noto Serif Thai'],
    'playfair display': ['Playfair Display', 'Noto Serif Thai'],
    serif: ['Playfair Display', 'Noto Serif Thai'],
    'great-vibes': ['Great Vibes', 'Mali'],
    'great vibes': ['Great Vibes', 'Mali'],
    handwriting: ['Great Vibes', 'Mali'],
    mali: ['Mali'],
    'noto serif thai': ['Noto Serif Thai'],
    outfit: ['Outfit', 'Noto Sans Thai'],
    sans: ['Outfit', 'Noto Sans Thai'],
    'noto sans thai': ['Noto Sans Thai']
};

const pending = new Map();

function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
}

function loadFamily(family) {
    if (pending.has(family)) return pending.get(family);
    const task = (async () => {
        try {
            if (FAMILY_LOADERS[family]) await FAMILY_LOADERS[family]();
            if (typeof document === 'undefined' || !document.fonts) return false;
            const sample = THAI_FAMILIES.has(family) ? THAI_SAMPLE : 'Happy Birthday';
            const faces = await Promise.all((PROBES[family] || [`1em "${family}"`]).map((d) => document.fonts.load(d, sample)));
            return faces.some((list) => list.length > 0);
        } catch {
            // Offline or blocked: the CSS fallback stack keeps text visible.
            pending.delete(family);
            return false;
        }
    })();
    pending.set(family, task);
    return task;
}

/**
 * Loads a card font (and its Thai partner). Safe to call repeatedly.
 * @param {string} name  card config id or family name
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export function loadCardFont(name, { timeoutMs = 3000 } = {}) {
    if (!name) return Promise.resolve(false);
    const families = ALIASES[String(name).toLowerCase()] || [name];
    return withTimeout(
        Promise.all(families.map(loadFamily)).then((ok) => ok.every(Boolean)),
        timeoutMs
    );
}

/**
 * Resolves when every family in a canvas `font` stack is ready to draw
 * `text`. Families are loaded first when they are on-demand card fonts.
 * @param {string[]} families  e.g. ['Playfair Display', 'Noto Serif Thai']
 * @param {string} text
 */
export function fontReadyForCanvas(families, text, { weight = 700, timeoutMs = 3000 } = {}) {
    if (typeof document === 'undefined' || !document.fonts) return Promise.resolve(false);
    const jobs = families.map(async (family) => {
        if (FAMILY_LOADERS[family]) await loadFamily(family);
        return document.fonts.load(`${weight} 48px "${family}"`, text);
    });
    return withTimeout(Promise.all(jobs).then(() => true).catch(() => false), timeoutMs);
}

/** True when `families` can already draw `text` without a fallback. */
export function fontsAvailable(families, text, weight = 700) {
    if (typeof document === 'undefined' || !document.fonts) return true;
    try {
        return families.every((family) => document.fonts.check(`${weight} 48px "${family}"`, text));
    } catch {
        return true;
    }
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * User-perceived characters. Thai stacks vowels and tone marks on a base
 * consonant ('สุ' is 2 code units, 1 character), so `.length` over-counts
 * Thai by up to ~2x and cut names short.
 */
export function splitGraphemes(text) {
    const str = String(text ?? '');
    if (segmenter) return Array.from(segmenter.segment(str), (s) => s.segment);
    // Fallback: attach Thai combining marks (above/below vowels, tone marks)
    // to the previous character.
    return str.match(/[\s\S][ัิ-ฺ็-๎̀-ͯ‌‍]*/gu) || [];
}

export function countGraphemes(text) {
    return splitGraphemes(text).length;
}

/** Truncates to `max` user-perceived characters (never splits a Thai cluster). */
export function truncateGraphemes(text, max) {
    const parts = splitGraphemes(text);
    return parts.length > max ? parts.slice(0, max).join('') : String(text ?? '');
}

/** Word segments for line breaking (Thai has no spaces between words). */
export function splitWords(text) {
    const str = String(text ?? '');
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        return Array.from(new Intl.Segmenter('th', { granularity: 'word' }).segment(str), (s) => s.segment);
    }
    return str.split(/(\s+)/).filter(Boolean);
}

// The receiver's envelope heading uses the display serif. Fetch it once the
// page is idle so it never competes with first render (LCP) but is usually
// ready before the card opens.
if (typeof window !== 'undefined' && /^#\/view\//.test(window.location.hash)) {
    const warm = () => loadCardFont('playfair', { timeoutMs: 8000 });
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1200));
    if (document.readyState === 'complete') idle(warm);
    else window.addEventListener('load', () => idle(warm), { once: true });
}
