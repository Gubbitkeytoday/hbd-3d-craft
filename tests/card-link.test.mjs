// Link codec tests: every link ever shared must keep opening, and the
// fields added later (handwriting, midnight lock) must survive a round trip.
// Run with `npm test` (node --test, no extra dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareUrl, decodeCardHash, CARD_DEFAULTS } from '../src/card-link.js';
import { finishStroke, strokesToString, strokesFromString } from '../src/signature.js';

const BASE = 'https://example.test/';
const hashOf = (url) => url.slice(BASE.length);

// Links made by the creator before signatures and locks existed (v2.1,
// commit 2a2013f), with what that version decoded them to.
const OLD_LINKS = [
    {
        hash: '#/c/IgQIQBzRBhgFobKilMwCA5XJmQQRqriCqrGZlcynsZnAgbSUmbAFFaOxgcCYrZe1yKq4lMCloiB_8J-SlgYIlraHobKilMwHGIKtmoS4k5e1yK2iuciUyaeigbGZwKqhrUQqRX9w_wAA',
        expect: {
            recipientName: 'มายด์', sender: 'ต้น', bdate: '1999-10-15', title: 'สุขสันต์วันเกิดนะ',
            message: 'รักเธอที่สุดเลย 💖', letterTitle: 'ถึงมายด์', letterBody: 'ขอบคุณที่อยู่ด้วยกันเสมอ',
            theme: 'sakura-blossom', candles: 7, cakeModel: 'vintage-heart', letterEnabled: true,
            backdrop: 'party', glazeColor: '#ff0000'
        }
    },
    {
        hash: '#/c/I2NjYBG5KCTA7J2ax8LnkVhQUKmQlFlUkpGSWMlaMVAAAA',
        expect: {
            recipientName: 'Ken', title: 'Happy birthday', message: 'x'.repeat(120), letterEnabled: false,
            backdrop: 'mint', theme: 'forest-moss', topper: 'star', decorStars: true
        }
    }
];

function wave(x0, y0, len, n, amp) {
    return Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        return [x0 + t * len, y0 + Math.sin(t * 14) * amp];
    });
}

const SIGNATURE = strokesToString([finishStroke(wave(20, 60, 180, 200, 24)), finishStroke([[210, 96]]), finishStroke(wave(24, 100, 200, 80, 4))]);

test('links from before signatures and locks still decode the same', async () => {
    for (const { hash, expect } of OLD_LINKS) {
        const { config, format } = await decodeCardHash(hash);
        assert.equal(format, 'v2');
        for (const [key, value] of Object.entries(expect)) assert.deepEqual(config[key], value, key);
        assert.equal(config.signature, '');
        assert.equal(config.lockDate, '');
    }
});

test('signature and lock date survive the compact link', async () => {
    const card = {
        recipientName: 'มายด์', sender: 'ต้น', relation: 'partner', lang: 'th',
        templated: ['title', 'message', 'letterTitle', 'letterBody'],
        backdrop: 'party', letterEnabled: true, signature: SIGNATURE, lockDate: '2026-10-16'
    };
    const url = await buildShareUrl(card, BASE);
    assert.match(url, /#\/c\//);
    const { config } = await decodeCardHash(hashOf(url));
    assert.equal(config.signature, SIGNATURE);
    assert.equal(config.lockDate, '2026-10-16');
    assert.equal(config.recipientName, 'มายด์');
    // The handwriting costs a few hundred characters, not kilobytes.
    assert.ok(url.length < 600, `link is ${url.length} characters`);
});

test('a long custom letter with a signature takes the deflated path and round-trips', async () => {
    const letterBody = 'จำได้ไหม ตอนที่เราเจอกันครั้งแรก '.repeat(12);
    const url = await buildShareUrl({ recipientName: 'Mind', templated: [], letterEnabled: true, letterBody, signature: SIGNATURE }, BASE);
    const { config } = await decodeCardHash(hashOf(url));
    assert.equal(config.letterBody, letterBody);
    assert.equal(config.signature, SIGNATURE);
    assert.equal(config.lockDate, '');
});

test('cards without the new fields encode exactly as before', async () => {
    const card = { recipientName: 'Ken', templated: [], title: 'Happy birthday', message: 'x'.repeat(120), letterEnabled: false, backdrop: 'mint', theme: 'forest-moss', topper: 'star', decorStars: true };
    assert.equal(hashOf(await buildShareUrl(card, BASE)), OLD_LINKS[1].hash);
});

test('defaults carry the new fields empty', () => {
    assert.equal(CARD_DEFAULTS.signature, '');
    assert.equal(CARD_DEFAULTS.lockDate, '');
});

test('stroke codec: round trip, malformed input, clamping', () => {
    const strokes = strokesFromString(SIGNATURE);
    assert.equal(strokes.length, 3);
    assert.equal(strokesToString(strokes), SIGNATURE);
    for (const bad of ['', '!!', 'AAAA', 'AQ', 'Af____8', 42, null]) assert.deepEqual(strokesFromString(bad), []);
    for (const stroke of strokes) {
        for (const [x, y] of stroke) {
            assert.ok(x >= 0 && x <= 255 && y >= 0 && y <= 127);
        }
    }
});

test('finishStroke simplifies dense input and keeps a tap as a dot', () => {
    const dense = finishStroke(wave(10, 60, 200, 400, 20));
    assert.ok(dense.length > 4 && dense.length < 120, `${dense.length} points`);
    assert.deepEqual(finishStroke([[12.4, 30.6], [12.2, 30.9]]), [[12, 31]]);
});
