/**
 * Share-link codec, shared by the creator (encode) and the router (decode).
 *
 * Two formats exist in the wild and both must keep opening:
 *   legacy  #/view/<name>?d=<base64url(UTF-8 JSON)>      full key names, diffed
 *                                                        against LEGACY_DEFAULTS
 *   v1      #/view/?z=1.<base64url(deflate-raw(JSON))>   short keys, diffed
 *                                                        against CARD_DEFAULTS
 *
 * The v1 payload carries the recipient's name inside the compressed blob, so
 * it is not readable in plain text in the link. Decoded objects are NOT
 * trusted here: main.js runs them through sanitizeCardConfig().
 */

// Content fields are empty on purpose: a missing title/message must fall back
// to the receiver's neutral, name-driven wording, never to someone else's text.
const CONTENT_DEFAULTS = {
    recipientName: '',
    sender: '',
    bdate: '',
    title: '',
    message: '',
    letterTitle: '',
    letterBody: '',
    topperText: '',
    photo: ''
};

const COLOR_DEFAULTS = {
    glazeColor: '',
    creamColor: '',
    plateColor: '',
    candleColor: '',
    topperColor: '',
    envBaseColor: '',
    envFlapColor: '',
    envSealColor: ''
};

/** Defaults of the current creator; v1 links only carry what differs. */
export const CARD_DEFAULTS = Object.freeze({
    ...CONTENT_DEFAULTS,
    theme: 'neon-rose',
    preset: '',
    candles: 5,
    music: 'happy-birthday-lofi',
    font: 'outfit',
    cakeModel: 'classic-tiered',
    plate: 'ceramic',
    glaze: 'chocolate',
    topper: 'hbd',
    strawberries: 4,
    cherries: 4,
    rolls: 3,
    sprinkles: true,
    letterEnabled: true,
    letterTheme: 'royal',
    decorHearts: false,
    decorStars: false,
    ...COLOR_DEFAULTS
});

/**
 * What the pre-v2 creator diffed against. Old links omitted any key equal to
 * these (e.g. decorStars:true, topper:'best-senpai'), so they must be decoded
 * against the same values or the cake would silently change.
 */
export const LEGACY_DEFAULTS = Object.freeze({
    ...CONTENT_DEFAULTS,
    theme: 'midnight-gold',
    preset: 'midnight-gold',
    candles: 5,
    music: 'happy-birthday-lofi',
    font: 'outfit',
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
    decorHearts: false,
    decorStars: true,
    ...COLOR_DEFAULTS
});

// Short keys for the v1 payload. Append only: renaming a key breaks old links.
const SHORT_KEYS = {
    recipientName: 'n', sender: 'f', bdate: 'b', title: 't', message: 'm',
    theme: 'th', preset: 'pr', candles: 'c', music: 'mu', font: 'fo', photo: 'p',
    cakeModel: 'cm', plate: 'pl', glaze: 'g', topper: 'tp', strawberries: 's',
    cherries: 'ch', rolls: 'r', sprinkles: 'sp', letterEnabled: 'le',
    letterTheme: 'lt', letterTitle: 'ltt', letterBody: 'lb', topperText: 'tt',
    decorHearts: 'dh', decorStars: 'ds', glazeColor: 'gc', creamColor: 'cc',
    plateColor: 'pc', candleColor: 'kc', topperColor: 'tc', envBaseColor: 'eb',
    envFlapColor: 'ef', envSealColor: 'es'
};
const LONG_KEYS = Object.fromEntries(Object.entries(SHORT_KEYS).map(([k, v]) => [v, k]));

const VERSION_PREFIX = '1.';
// Inflated JSON above this is not something the creator can produce (the
// sanitizer caps all text at ~6 KB); refuse it instead of parsing a bomb.
const MAX_INFLATED_BYTES = 16 * 1024;
const MAX_PAYLOAD_CHARS = 12000;

export function canCompress() {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/* ---------------- base64url ---------------- */

function bytesToBase64url(bytes) {
    let bin = '';
    // Chunked so a long payload never hits the argument-count limit.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/* ---------------- deflate-raw ---------------- */

async function deflate(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateCapped(bytes, cap) {
    const reader = new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
        .getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > cap) {
            reader.cancel().catch(() => {});
            throw new Error('Card payload exceeds size cap');
        }
        chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        joined.set(c, offset);
        offset += c.length;
    }
    return new TextDecoder().decode(joined);
}

/* ---------------- encode ---------------- */

function diffAgainst(config, defaults) {
    const out = {};
    for (const key of Object.keys(defaults)) {
        if (key in config && config[key] !== defaults[key]) out[key] = config[key];
    }
    return out;
}

function legacyEncode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    return bytesToBase64url(bytes);
}

/**
 * Builds the shareable URL for a card config (full key names, as the viewer
 * receives them). Falls back to the legacy format on browsers without
 * CompressionStream so a link can always be made.
 */
export async function buildShareUrl(config, base = `${location.origin}${location.pathname}`) {
    if (canCompress()) {
        try {
            const diff = diffAgainst(config, CARD_DEFAULTS);
            const short = {};
            for (const [k, v] of Object.entries(diff)) short[SHORT_KEYS[k]] = v;
            const packed = bytesToBase64url(await deflate(JSON.stringify(short)));
            return `${base}#/view/?z=${VERSION_PREFIX}${packed}`;
        } catch (err) {
            console.warn('Compressed link failed, using the legacy format:', err);
        }
    }
    const name = encodeURIComponent(config.recipientName || '');
    const diff = diffAgainst(config, LEGACY_DEFAULTS);
    return Object.keys(diff).length
        ? `${base}#/view/${name}?d=${legacyEncode(diff)}`
        : `${base}#/view/${name}`;
}

/* ---------------- decode ---------------- */

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function legacyDecode(base64) {
    const bytes = base64urlToBytes(base64);
    return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Parses a `#/view/...` hash into a raw (unsanitized) card config merged
 * over the right defaults. Never throws: a broken link yields the defaults,
 * so the recipient still gets a card instead of a blank page.
 *
 * @returns {Promise<{ config: object, defaults: object, format: 'v1'|'legacy'|'empty'|'error' }>}
 */
export async function decodeCardHash(hash) {
    const pathPart = hash.replace(/^#\/view\//, '');
    const queryIndex = pathPart.indexOf('?');
    const pathName = safeDecodeURIComponent(queryIndex === -1 ? pathPart : pathPart.slice(0, queryIndex));
    const params = new URLSearchParams(queryIndex === -1 ? '' : pathPart.slice(queryIndex + 1));
    const z = params.get('z');
    const d = params.get('d');

    if (z) {
        try {
            if (!z.startsWith(VERSION_PREFIX)) throw new Error(`Unknown card link version: ${z.slice(0, 4)}`);
            if (z.length > MAX_PAYLOAD_CHARS) throw new Error('Card link too long');
            if (!canCompress()) throw new Error('This browser cannot decompress card links');
            const json = await inflateCapped(base64urlToBytes(z.slice(VERSION_PREFIX.length)), MAX_INFLATED_BYTES);
            const short = JSON.parse(json);
            const config = { ...CARD_DEFAULTS };
            if (short && typeof short === 'object') {
                for (const [k, v] of Object.entries(short)) {
                    if (LONG_KEYS[k]) config[LONG_KEYS[k]] = v;
                }
            }
            return { config, defaults: CARD_DEFAULTS, format: 'v1' };
        } catch (err) {
            console.error('Failed to decode card link:', err);
            return { config: { ...CARD_DEFAULTS }, defaults: CARD_DEFAULTS, format: 'error' };
        }
    }

    // Legacy links: the name lives in the path, the rest in ?d=.
    const config = { ...LEGACY_DEFAULTS };
    let format = 'empty';
    if (d) {
        try {
            if (d.length > MAX_PAYLOAD_CHARS) throw new Error('Card link too long');
            const parsed = legacyDecode(d);
            if (parsed && typeof parsed === 'object') Object.assign(config, parsed);
            format = 'legacy';
        } catch (err) {
            console.error('Failed to decode legacy card link:', err);
            format = 'error';
        }
    }
    // The old creator substituted placeholder names; treat those as missing.
    if (!config.recipientName || config.recipientName === 'Senpai' || config.recipientName === 'ครีม') {
        config.recipientName = pathName;
    }
    return { config, defaults: LEGACY_DEFAULTS, format };
}
