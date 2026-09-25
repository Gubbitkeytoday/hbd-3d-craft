/**
 * Share-link codec, shared by the creator (encode) and the router (decode).
 *
 * Three formats exist in the wild and all must keep opening:
 *   v2      #/c/<base64url(compact binary)>              current, see below
 *   legacy  #/view/<name>?d=<base64url(UTF-8 JSON)>      full key names, diffed
 *                                                        against LEGACY_DEFAULTS
 *   v1      #/view/?z=1.<base64url(deflate-raw(JSON))>   short keys, diffed
 *                                                        against CARD_DEFAULTS
 *
 * The v1 payload carries the recipient's name inside the compressed blob, so
 * it is not readable in plain text in the link. Decoded objects are NOT
 * trusted here: main.js runs them through sanitizeCardConfig().
 */

import { buildTemplates, RELATIONS, TEMPLATED_FIELDS } from './card-templates.js';
import { BACKDROP_NAMES } from './backdrop-names.js';

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
    // Links made before backdrops existed carry none and must keep their dark
    // stage. New cards get their backdrop from the creator (always written).
    backdrop: 'night',
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
    backdrop: 'night',
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
    envFlapColor: 'ef', envSealColor: 'es', backdrop: 'bd'
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

async function deflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateCapped(bytes, cap) {
    return new TextDecoder().decode(await inflateBytesCapped(bytes, cap));
}

async function inflateBytesCapped(bytes, cap) {
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
    return joined;
}

/* ---------------- v2: compact binary ---------------- *
 *
 * #/c/<base64url(header + fields)>
 *
 * Why not JSON: keys, quotes and enum strings dominated short cards, and Thai
 * costs 3 bytes a character in UTF-8. v2 writes each non-default field as a
 * one-byte tag plus a tight value, enums as list indexes, Thai at 1 byte per
 * character, and leaves out untouched template text entirely (the decoder
 * rebuilds it with card-templates.js). Typical cards drop from ~500 to well
 * under 100 characters.
 *
 * Tag ranges fix each value's size, so a decoder can skip tags it doesn't know
 * yet (append-only: never renumber or reorder a list below):
 *   1-31 string (varint length + packed text)    32-63 enum (1 byte index)
 *   64-95 small int (1 byte)                     96-111 byte (bit field)
 *   112-127 color (3 bytes RGB)
 */


const V2_ROUTE = '#/c/';
const V2_HEADER_RAW = 0x20;
const V2_HEADER_DEFLATED = 0x21;
// v2.1: every enum, count and switch bit-packed into one fixed 7-byte block
// (they cost 2 bytes each as tagged fields), then the name without a tag.
const V21_HEADER_RAW = 0x22;
const V21_HEADER_DEFLATED = 0x23;
const PACK_LAYOUT = [
    ['theme', 4], ['preset', 3], ['music', 2], ['font', 2], ['cakeModel', 3],
    ['plate', 2], ['glaze', 2], ['topper', 2], ['letterTheme', 2], ['relation', 2],
    ['lang', 2], ['candles', 4], ['strawberries', 4], ['cherries', 4], ['rolls', 3],
    ['sprinkles', 1], ['letterEnabled', 1], ['decorHearts', 1], ['decorStars', 1],
    ['belated', 1], ['templated', 4], ['backdrop', 3]
]; // 55 of 56 bits; append new fields into the spare bits only. Old v2.1
// links have zeros there, which is index 0 of each appended enum ('night').
const PACK_BYTES = 7;

const ENUMS = {
    theme: ['neon-rose', 'midnight-gold', 'pastel-mint', 'lavender-dream', 'sakura-blossom', 'cyber-retro', 'forest-moss', 'cosmic-nebula', 'choco-monarch'],
    preset: ['', 'pink-dream', 'chocolate-royal', 'mint-chocolate', 'midnight-gold', 'sakura-sweet', 'cosmic-crystal'],
    music: ['happy-birthday-lofi', 'happy-birthday-piano', 'happy-birthday-synth'],
    font: ['outfit', 'playfair', 'great-vibes'],
    cakeModel: ['classic-tiered', 'vintage-heart', 'korean-bento', 'triple-luxury', 'cyber-prism'],
    plate: ['ceramic', 'crystal', 'golden', 'cosmic'],
    glaze: ['chocolate', 'strawberry', 'mint', 'cream'],
    topper: ['hbd', 'star', 'best-senpai', 'none'],
    letterTheme: ['royal', 'romance', 'cyber', 'steampunk'],
    relation: RELATIONS,
    lang: ['th', 'en', 'ja'],
    backdrop: BACKDROP_NAMES
};

const TAGS = {
    // strings
    recipientName: 1, sender: 2, title: 4, message: 5, letterTitle: 6,
    letterBody: 7, topperText: 8, photo: 9,
    // enums
    theme: 32, preset: 33, music: 34, font: 35, cakeModel: 36, plate: 37,
    glaze: 38, topper: 39, letterTheme: 40, relation: 41, lang: 42, backdrop: 43,
    // small ints (bdate is days since 1970 split over two bytes)
    candles: 64, strawberries: 65, cherries: 66, rolls: 67, bdateHi: 68, bdateLo: 69,
    // bit fields
    flags: 96, templated: 97,
    // colors
    glazeColor: 112, creamColor: 113, plateColor: 114, candleColor: 115,
    topperColor: 116, envBaseColor: 117, envFlapColor: 118, envSealColor: 119
};
const TAG_NAMES = Object.fromEntries(Object.entries(TAGS).map(([k, v]) => [v, k]));
const FLAG_BITS = ['sprinkles', 'letterEnabled', 'decorHearts', 'decorStars', 'belated'];
const V2_EXTRA_DEFAULTS = { relation: 'friend', lang: 'th', belated: false };

/* Text packing: ASCII as-is, Thai block (U+0E00-0E7F) as one byte
   0x80-0xFF, anything else (emoji...) as 0x7F + its UTF-8 bytes. */
const ESCAPE = 0x7f;
const utf8 = new TextEncoder();

function packText(str) {
    const out = [];
    for (const ch of str) {
        const cp = ch.codePointAt(0);
        if (cp < 0x7f) out.push(cp);
        else if (cp >= 0x0e00 && cp <= 0x0e7f) out.push(0x80 + (cp - 0x0e00));
        else out.push(ESCAPE, ...utf8.encode(ch));
    }
    return out;
}

function unpackText(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b < 0x7f) s += String.fromCharCode(b);
        else if (b >= 0x80) s += String.fromCharCode(0x0e00 + (b - 0x80));
        else {
            // UTF-8 lead byte tells how many bytes this code point uses.
            const lead = bytes[i + 1];
            const len = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
            s += new TextDecoder().decode(bytes.subarray(i + 1, i + 1 + len));
            i += len;
        }
    }
    return s;
}

function pushVarint(out, n) {
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
    out.push(n);
}

function dateToDays(bdate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bdate || '');
    return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : -1;
}

function daysToDate(days) {
    return new Date(days * 86400000).toISOString().slice(0, 10);
}

function encodeV2Fields(config, { taggedExtrasOnly = false, templated: tpl = null } = {}) {
    const out = [];
    const defaults = { ...CARD_DEFAULTS, ...V2_EXTRA_DEFAULTS };
    const templated = tpl || new Set(config.recipientName ? (config.templated || []) : []);

    for (const [key, tag] of Object.entries(TAGS)) {
        const value = config[key];
        if (taggedExtrasOnly && tag >= 32) continue;
        if (tag < 32) {
            if (templated.has(key) || typeof value !== 'string' || value === defaults[key]) continue;
            const packed = packText(value);
            out.push(tag);
            pushVarint(out, packed.length);
            out.push(...packed);
        } else if (tag < 64) {
            const list = ENUMS[key];
            const idx = list.indexOf(value);
            if (value === undefined || value === defaults[key]) continue;
            if (idx < 0) { console.warn(`Link: unknown ${key} "${value}", using default`); continue; }
            out.push(tag, idx);
        } else if (tag < 68) {
            const n = parseInt(value, 10);
            if (!Number.isFinite(n) || n === defaults[key]) continue;
            out.push(tag, Math.max(0, Math.min(255, n)));
        }
    }

    const days = dateToDays(config.bdate);
    if (days >= 0 && days <= 0xffff) out.push(TAGS.bdateHi, days >> 8, TAGS.bdateLo, days & 0xff);

    if (!taggedExtrasOnly) {
    let flags = 0;
    let defaultFlags = 0;
    FLAG_BITS.forEach((key, i) => {
        if (config[key] ?? defaults[key]) flags |= 1 << i;
        if (defaults[key]) defaultFlags |= 1 << i;
    });
    if (flags !== defaultFlags) out.push(TAGS.flags, flags);

    let mask = 0;
    TEMPLATED_FIELDS.forEach((key, i) => { if (templated.has(key)) mask |= 1 << i; });
    if (mask) out.push(TAGS.templated, mask);
    }

    for (const [key, tag] of Object.entries(TAGS)) {
        if (tag < 112 || !/^#[0-9a-f]{6}$/i.test(config[key] || '')) continue;
        const rgb = parseInt(config[key].slice(1), 16);
        out.push(tag, rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff);
    }
    return Uint8Array.from(out);
}

function decodeV2Fields(bytes, preset = null) {
    const raw = preset?.raw || { ...CARD_DEFAULTS, ...V2_EXTRA_DEFAULTS };
    let flags = null;
    let mask = preset?.mask || 0;
    let days = 0;
    let i = 0;
    const need = (n) => { if (i + n > bytes.length) throw new Error('Truncated card link'); };
    while (i < bytes.length) {
        const tag = bytes[i++];
        const key = TAG_NAMES[tag];
        if (tag < 32) {
            let len = 0;
            let shift = 0;
            for (;;) {
                need(1);
                const b = bytes[i++];
                len |= (b & 0x7f) << shift;
                if (!(b & 0x80)) break;
                shift += 7;
                if (shift > 21) throw new Error('Bad length');
            }
            need(len);
            if (key) raw[key] = unpackText(bytes.subarray(i, i + len));
            i += len;
        } else if (tag < 112) {
            need(1);
            const v = bytes[i++];
            if (!key) continue;
            if (tag < 64) raw[key] = ENUMS[key][v] ?? raw[key];
            else if (key === 'bdateHi') days |= v << 8;
            else if (key === 'bdateLo') days |= v;
            else if (key === 'flags') flags = v;
            else if (key === 'templated') mask = v;
            else raw[key] = v;
        } else if (tag < 128) {
            need(3);
            if (key) raw[key] = '#' + [bytes[i], bytes[i + 1], bytes[i + 2]].map((b) => b.toString(16).padStart(2, '0')).join('');
            i += 3;
        } else {
            throw new Error(`Unknown card field ${tag}`);
        }
    }
    if (days) raw.bdate = daysToDate(days);
    if (flags !== null) FLAG_BITS.forEach((key, bit) => { raw[key] = !!(flags & (1 << bit)); });

    // Rebuild untouched wording exactly as the sender saw it (their language).
    if (mask && raw.recipientName) {
        const tpl = buildTemplates({
            name: raw.recipientName, sender: raw.sender, relation: raw.relation,
            belated: raw.belated, lang: raw.lang
        });
        TEMPLATED_FIELDS.forEach((key, bit) => { if (mask & (1 << bit)) raw[key] = tpl[key]; });
    }
    if (!raw.letterEnabled) { raw.letterTitle = ''; raw.letterBody = ''; }
    delete raw.relation; delete raw.lang; delete raw.belated; delete raw.bdateHi; delete raw.bdateLo;
    return raw;
}

function packSettings(config, templated) {
    const defaults = { ...CARD_DEFAULTS, ...V2_EXTRA_DEFAULTS };
    let bits = 0n;
    let shift = 0n;
    for (const [key, width] of PACK_LAYOUT) {
        let v;
        if (key === 'templated') {
            v = 0;
            TEMPLATED_FIELDS.forEach((k, i) => { if (templated.has(k)) v |= 1 << i; });
        } else if (ENUMS[key]) {
            v = ENUMS[key].indexOf(config[key] ?? defaults[key]);
            if (v < 0) v = ENUMS[key].indexOf(defaults[key]);
        } else if (width === 1) {
            v = (config[key] ?? defaults[key]) ? 1 : 0;
        } else {
            const n = parseInt(config[key] ?? defaults[key], 10);
            v = Number.isFinite(n) ? n : defaults[key];
        }
        v = Math.max(0, Math.min((1 << width) - 1, v));
        bits |= BigInt(v) << shift;
        shift += BigInt(width);
    }
    const out = [];
    for (let i = 0; i < PACK_BYTES; i++) { out.push(Number(bits & 0xffn)); bits >>= 8n; }
    return out;
}

function unpackSettings(bytes, raw) {
    let bits = 0n;
    for (let i = PACK_BYTES - 1; i >= 0; i--) bits = (bits << 8n) | BigInt(bytes[i]);
    let mask = 0;
    for (const [key, width] of PACK_LAYOUT) {
        const v = Number(bits & ((1n << BigInt(width)) - 1n));
        bits >>= BigInt(width);
        if (key === 'templated') mask = v;
        else if (ENUMS[key]) raw[key] = ENUMS[key][v] ?? raw[key];
        else if (width === 1) raw[key] = v === 1;
        else raw[key] = v;
    }
    return mask;
}

function encodePacked(config) {
    const templated = new Set(config.recipientName ? (config.templated || []) : []);
    const name = packText(config.recipientName || '');
    const out = packSettings(config, templated);
    pushVarint(out, name.length);
    out.push(...name);
    // Remaining free text, date and colors reuse the v2 tagged encoding.
    const rest = encodeV2Fields({ ...config, recipientName: '' }, { taggedExtrasOnly: true, templated });
    return Uint8Array.from([...out, ...rest]);
}

function decodePacked(bytes) {
    if (bytes.length < PACK_BYTES + 1) throw new Error('Truncated card link');
    const raw = { ...CARD_DEFAULTS, ...V2_EXTRA_DEFAULTS };
    const mask = unpackSettings(bytes, raw);
    let i = PACK_BYTES;
    let len = 0;
    let shift = 0;
    for (;;) {
        if (i >= bytes.length) throw new Error('Truncated card link');
        const b = bytes[i++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 21) throw new Error('Bad length');
    }
    if (i + len > bytes.length) throw new Error('Truncated card link');
    raw.recipientName = unpackText(bytes.subarray(i, i + len));
    return decodeV2Fields(bytes.subarray(i + len), { raw, mask });
}

async function encodeV2(config) {
    const body = encodePacked(config);
    let payload = Uint8Array.of(V21_HEADER_RAW, ...body);
    // Long hand-written messages still compress; short cards don't, so keep
    // whichever is smaller.
    if (canCompress() && body.length > 60) {
        try {
            const deflated = await deflate(body);
            if (deflated.length + 1 < payload.length) payload = Uint8Array.of(V21_HEADER_DEFLATED, ...deflated);
        } catch { /* raw payload is always valid */ }
    }
    return bytesToBase64url(payload);
}

async function decodeV2(b64) {
    if (b64.length > MAX_PAYLOAD_CHARS) throw new Error('Card link too long');
    const bytes = base64urlToBytes(b64);
    const inflate = async () => {
        if (!canCompress()) throw new Error('This browser cannot decompress card links');
        return inflateBytesCapped(bytes.subarray(1), MAX_INFLATED_BYTES);
    };
    if (bytes[0] === V21_HEADER_RAW) return decodePacked(bytes.subarray(1));
    if (bytes[0] === V21_HEADER_DEFLATED) return decodePacked(await inflate());
    if (bytes[0] === V2_HEADER_RAW) return decodeV2Fields(bytes.subarray(1));
    if (bytes[0] === V2_HEADER_DEFLATED) return decodeV2Fields(await inflate());
    throw new Error(`Unknown card link version: ${bytes[0]}`);
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
    try {
        return `${base}${V2_ROUTE}${await encodeV2(config)}`;
    } catch (err) {
        console.warn('Compact link failed, using an older format:', err);
    }
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
 * @returns {Promise<{ config: object, defaults: object, format: 'v2'|'v1'|'legacy'|'empty'|'error' }>}
 */
export async function decodeCardHash(hash) {
    if (hash.startsWith(V2_ROUTE)) {
        try {
            const config = await decodeV2(hash.slice(V2_ROUTE.length).split(/[?&#]/)[0]);
            return { config, defaults: CARD_DEFAULTS, format: 'v2' };
        } catch (err) {
            console.error('Failed to decode card link:', err);
            return { config: { ...CARD_DEFAULTS }, defaults: CARD_DEFAULTS, format: 'error' };
        }
    }
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
