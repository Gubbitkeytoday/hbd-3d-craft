/**
 * Regenerates the README screenshot set in screenshots/ from a running app.
 *
 *   npm run dev                  (or: npx vite build && npx vite preview)
 *   npm run screenshots          BASE=http://localhost:4173 npm run screenshots
 *
 * Env:
 *   BASE         app origin (default http://localhost:5173)
 *   CHROME_PATH  Chrome/Chromium executable (default: Playwright's own
 *                install; `npx playwright-core install chromium` fetches it)
 *   SHOTS        comma list of groups to (re)write: creator, room, hero,
 *                mobile, montage (default: all). The card link is always
 *                made first by the creator itself.
 *
 * Everything is driven the way a person would: the creator fills the form
 * and makes the #/c/... link, the receiver opens that link, taps the
 * envelope, flips the switch (Space), skips the song and blows the candles
 * (Space). Frames are taken at fixed moments inside each beat, after the
 * beat's own DOM signal, so a slow first load only makes the run longer.
 * The UI language is Thai. Montages and the hero are composed in the app's
 * own page so they use its Thai web fonts. Needs a real GPU for good frames
 * (on Windows ANGLE/D3D11 is forced; headless SwiftShader is slow and flat).
 */
/* global process, Buffer */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/+$/, '');
const ONLY = new Set((process.env.SHOTS || 'creator,room,hero,mobile,montage').split(',').map((s) => s.trim()).filter(Boolean));
const QUALITY = 82;
const RECIPIENT = 'มายด์';
const SENDER = 'ต้น';

const DESKTOP = { width: 1440, height: 900, dpr: 1 };
const PHONE = { width: 390, height: 844, dpr: 2, mobile: true };
const HERO = { width: 1600, height: 800, dpr: 1 };

const GPU_ARGS = process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [];

const t0 = Date.now();
const log = (msg) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${msg}`);
const written = [];

// Dev-only overlays never belong in a picture.
const HIDE_DEV_CSS = 'vite-error-overlay { display: none !important; }';

async function newPage(browser, vp) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.dpr,
        isMobile: !!vp.mobile,
        hasTouch: !!vp.mobile,
        locale: 'th-TH',
        colorScheme: 'light',
        reducedMotion: 'no-preference'
    });
    await ctx.addInitScript((css) => {
        try { localStorage.setItem('hbd_craft_lang', 'th'); } catch { /* storage blocked */ }
        const add = () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
        if (document.head) add(); else document.addEventListener('DOMContentLoaded', add, { once: true });
    }, HIDE_DEV_CSS);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log(`  page error: ${e.message.slice(0, 160)}`));
    return page;
}

async function save(page, name, opts = {}) {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file, type: 'jpeg', quality: QUALITY, ...opts });
    const kb = Math.round(fs.statSync(file).size / 1024);
    written.push([name, kb]);
    log(`wrote ${name} (${kb} KB)`);
}

const frames = (page, n = 4) => page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);

/** Blur whatever has focus so Space reaches the scene, then press it. */
async function space(page) {
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Space');
}

// ---------------------------------------------------------------- creator

/** Waits for the live preview, including the party room when it is chosen. */
async function waitPreview(page) {
    await page.waitForSelector('#preview-canvas-wrapper.is-ready', { timeout: 90000 });
    await page.waitForTimeout(300);
    await page.waitForFunction(() => {
        const stage = document.querySelector('.cr-stage');
        const wantsRoom = document.querySelector('input[name="backdrop"]:checked')?.value === 'party';
        const p = window.__hbdPreview; // dev builds only
        const roomOk = !wantsRoom || !p || !!p.scene.getObjectByName('room-baked');
        return roomOk && !stage?.classList.contains('is-busy');
    }, null, { timeout: 90000, polling: 200 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForFunction(() => !document.querySelector('.cr-stage')?.classList.contains('is-busy'), null, { timeout: 30000 });
    await page.waitForTimeout(1800);
}

async function fillStep1(page) {
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector('#recipient-name');
    await page.fill('#recipient-name', RECIPIENT);
    await page.fill('#sender-name', SENDER);
    await page.evaluate(() => document.activeElement?.blur?.());
}

async function nextStep(page) {
    await page.click('#btn-step-next');
    await page.waitForTimeout(600);
    await page.evaluate(() => document.activeElement?.blur?.());
}

/** Desktop creator: steps 1 and 2, then the share sheet. Returns the card link. */
async function creatorDesktop(browser) {
    const page = await newPage(browser, DESKTOP);
    await fillStep1(page);
    await waitPreview(page);
    if (ONLY.has('creator')) await save(page, 'creator-desktop.jpg');
    await nextStep(page);
    await waitPreview(page);
    if (ONLY.has('creator')) await save(page, 'creator-cake-desktop.jpg');
    await nextStep(page);
    await page.click('#btn-generate-card');
    await page.waitForFunction(() => (document.getElementById('share-url-input')?.value || '').includes('#/c/'), null, { timeout: 15000 });
    await page.waitForFunction(() => { const q = document.getElementById('share-qr-wrap'); return q && !q.hidden; }, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200); // sheet transition and QR paint
    if (ONLY.has('creator')) await save(page, 'share-sheet.jpg');
    const link = await page.inputValue('#share-url-input');
    await page.context().close();
    return link.replace(/^https?:\/\/[^/]+/, BASE);
}

async function creatorMobile(browser) {
    const page = await newPage(browser, PHONE);
    await fillStep1(page);
    await waitPreview(page);
    await nextStep(page);
    await waitPreview(page);
    await page.evaluate(() => { document.scrollingElement.scrollTop = 0; document.querySelector('.cr-form')?.scrollTo?.(0, 0); });
    await page.waitForTimeout(400);
    await save(page, 'creator-mobile.jpg');
    await page.context().close();
}

// ---------------------------------------------------------------- receiver

async function openCard(page, link) {
    await page.goto(link);
    await page.waitForSelector('#btn-open-envelope', { state: 'visible', timeout: 90000 });
    await page.waitForFunction(() => document.getElementById('btn-open-envelope')?.dataset.state === 'ready', null, { timeout: 120000, polling: 200 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
}

async function tapOpen(page) {
    await page.evaluate(() => document.getElementById('btn-open-envelope').click());
    await page.waitForSelector('#receiver-view.is-dark', { timeout: 20000 });
    const poster = await page.evaluate(() => document.getElementById('receiver-view').classList.contains('is-2d'));
    if (poster) log('  note: the receiver fell back to the 2D poster (slow GPU?)');
}

/** Dark beat: waits for the second hint (eyes fully adapted), flips the switch. */
async function darkThenFlip(page, { shot } = {}) {
    await page.waitForSelector('#rcv-dark-hint[data-key="rcvDarkHint2"]', { timeout: 15000 });
    await page.waitForTimeout(1700); // the +0.4 EV adaptation settles
    if (shot) await save(page, shot);
    await space(page);
    await page.waitForFunction(() => !document.getElementById('receiver-view').classList.contains('is-dark'), null, { timeout: 5000 });
    return Date.now();
}

/** From the reveal to the finale: skip the song, make the wish, blow every candle. */
async function songToFinale(page, { onSong } = {}) {
    await page.waitForSelector('#rcv-lyrics:not([hidden])', { timeout: 30000 });
    if (onSong) await onSong();
    await page.waitForSelector('#btn-skip-song:not([hidden])', { timeout: 20000 });
    await page.click('#btn-skip-song');
    await page.waitForSelector('#rcv-wish:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(1200);
    await space(page);
    await page.waitForSelector('#rcv-blow:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(900);
    for (let i = 0; i < 16; i++) {
        const left = await page.evaluate(() => {
            const b = document.getElementById('rcv-blow');
            if (!b || b.hidden) return 0;
            const n = (document.getElementById('rcv-count')?.textContent || '').match(/\d+/);
            return n ? +n[0] : 1;
        });
        if (!left) break;
        await space(page);
        await page.waitForTimeout(320);
    }
    return Date.now();
}

async function receiverDesktop(browser, link) {
    const page = await newPage(browser, DESKTOP);
    await openCard(page, link);
    await tapOpen(page);
    const flipAt = await darkThenFlip(page, { shot: 'room-dark.jpg' });
    // Lights on: the doorway framing holds 1.9 s, then one 1.8 s glide to the
    // table; this is where it lands (letters, neon name, table and cake).
    await page.waitForTimeout(Math.max(0, 4200 - (Date.now() - flipAt)));
    await save(page, 'room-reveal.jpg');
    const outAt = await songToFinale(page);
    // Lights snap back ~0.4 s after the last flame and the camera backs off
    // for 1.8 s; the card slides in at ~2.7 s. Balloons are mid-fall here.
    await page.waitForTimeout(Math.max(0, 2450 - (Date.now() - outAt)));
    await save(page, 'room-finale.jpg');
    await page.context().close();
}

async function receiverMobile(browser, link) {
    const page = await newPage(browser, PHONE);
    await openCard(page, link);
    await save(page, 'gate-mobile.jpg');
    await tapOpen(page);
    await darkThenFlip(page);
    await songToFinale(page, {
        onSong: async () => {
            // The third line carries the name in the accent colour.
            await page.waitForFunction((name) => (document.getElementById('rcv-lyric-line')?.textContent || '').includes(name), RECIPIENT, { timeout: 20000 });
            await page.waitForTimeout(1300);
            await save(page, 'room-song-mobile.jpg');
        }
    });
    await page.waitForSelector('#rcv-card.is-open', { timeout: 20000 });
    await page.waitForTimeout(1800);
    await save(page, 'message-card-mobile.jpg');
    await page.context().close();
}

/**
 * README banner: the doorway shot the moment the lights come on, HUD hidden,
 * with the product name over the ceiling (a calm, title-safe band).
 */
const HERO_TITLE = 'HBD 3D Craft';
const HERO_TAGLINE = 'ทำเค้กวันเกิด 3 มิติให้เพื่อนเป่าเทียนได้จริง ส่งผ่าน LINE ได้เลย'; // i18n th.crHero

async function hero(browser, link) {
    const page = await newPage(browser, HERO);
    await openCard(page, link);
    await page.addStyleTag({ content: '.rcv-lang, #rcv-hud { visibility: hidden !important; }' });
    await page.evaluate(async ({ title, tagline }) => {
        const el = document.createElement('div');
        el.id = 'shots-hero';
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;opacity:0;' +
            'background:linear-gradient(180deg, rgba(22,11,6,.62) 0%, rgba(22,11,6,.28) 24%, rgba(22,11,6,0) 42%);';
        const h = document.createElement('p');
        h.textContent = title;
        h.style.cssText = "margin:0;position:absolute;left:64px;top:48px;font:700 58px/1.1 'Outfit','Noto Sans Thai',sans-serif;letter-spacing:-.01em;color:#fff7ef;text-shadow:0 2px 18px rgba(0,0,0,.35)";
        const sub = document.createElement('p');
        sub.textContent = tagline;
        sub.style.cssText = "margin:0;position:absolute;left:66px;top:124px;font:500 25px/1.5 'Noto Sans Thai','Outfit',sans-serif;color:#f6e6d8;text-shadow:0 1px 10px rgba(0,0,0,.4)";
        el.append(h, sub);
        document.body.appendChild(el);
        await Promise.all([document.fonts.load("700 58px 'Outfit'"), document.fonts.load("500 25px 'Noto Sans Thai'", tagline)]);
    }, { title: HERO_TITLE, tagline: HERO_TAGLINE });
    await tapOpen(page);
    await page.waitForTimeout(1500);
    await space(page);
    await page.waitForTimeout(1750); // the shout has faded, confetti is still up
    await page.evaluate(() => { document.getElementById('shots-hero').style.opacity = '1'; });
    await frames(page, 2);
    await save(page, 'hero.jpg');
    await page.context().close();
}

// ---------------------------------------------------------------- montages

/** Shows `html` over the app page (its fonts included) at the given size and saves it. */
async function composeInPage(page, { width, height, html, name }) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async (html) => {
        const el = document.createElement('div');
        el.id = 'shots-compose';
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:hidden;';
        el.innerHTML = html; // static markup built by this script, no user data
        document.body.appendChild(el);
        await Promise.all([...el.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
        await document.fonts.ready;
    }, html);
    await frames(page, 2);
    await save(page, name, { clip: { x: 0, y: 0, width, height } });
    await page.evaluate(() => document.getElementById('shots-compose')?.remove());
}

const dataUrl = (buf) => `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`;

async function pick(page, name, value) {
    await page.locator(`label:has(> input[name="${name}"][value="${value}"])`).click();
    await frames(page, 2);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function montages(browser) {
    const page = await newPage(browser, DESKTOP);
    await fillStep1(page);
    await waitPreview(page);
    // No secret letter here, so the floating envelope stays out of the tiles.
    await nextStep(page);
    await nextStep(page);
    await page.locator('label:has(> #letter-enabled)').click();
    await page.click('#btn-step-back');
    await page.waitForTimeout(600);
    await waitPreview(page);
    await page.addStyleTag({ content: '.cr-stage-caption, .cr-drag-hint, .cr-loader { visibility: hidden !important; }' });
    const labelOf = (name, value) => page.evaluate(({ name, value }) =>
        document.querySelector(`input[name="${name}"][value="${value}"]`)?.closest('label')?.innerText.trim() || value, { name, value });
    /** A centred crop of the preview with the given aspect (w/h), `fill` of the limiting side. */
    const grab = async (aspect, fill = 1, dy = 0) => {
        const box = await page.locator('#preview-canvas-wrapper').boundingBox();
        let h = box.height * fill, w = h * aspect;
        if (w > box.width * fill) { w = box.width * fill; h = w / aspect; }
        const clip = { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2 + dy * box.height, width: w, height: h };
        return page.screenshot({ type: 'jpeg', quality: 92, clip });
    };

    // The seven backdrops, with the default classic cake.
    const backdrops = ['party', 'night', 'blush', 'cream', 'sky', 'mint', 'lavender'];
    const bd = [];
    for (const b of backdrops) {
        await pick(page, 'backdrop', b);
        await waitPreview(page);
        await page.waitForTimeout(2500); // the camera eases to the new framing
        bd.push({ img: dataUrl(await grab(300 / 380, 1)), label: await labelOf('backdrop', b) });
        log(`  backdrop ${b}`);
    }

    // The five cake shapes on the blush studio backdrop.
    await pick(page, 'backdrop', 'blush');
    await waitPreview(page);
    const models = ['classic-tiered', 'vintage-heart', 'korean-bento', 'triple-luxury', 'cyber-prism'];
    const cakes = [];
    for (const m of models) {
        await pick(page, 'cakeModel', m);
        await waitPreview(page);
        await page.waitForTimeout(1500);
        cakes.push({ img: dataUrl(await grab(380 / 430, 0.86, 0.02)), label: await labelOf('cakeModel', m) });
        log(`  cake ${m}`);
    }

    const tile = (t, style = '') => `<figure style="margin:0;position:relative;border-radius:18px;overflow:hidden;${style}">
        <img src="${t.img}" alt="" style="display:block;width:100%;height:100%;object-fit:cover">
        <figcaption style="position:absolute;left:14px;bottom:14px;padding:6px 14px;border-radius:999px;background:rgba(255,255,255,.9);color:#3a1d29;font-size:18px;font-weight:600;box-shadow:0 1px 2px rgba(58,29,41,.12)">${esc(t.label)}</figcaption>
    </figure>`;

    // Five cakes in a row.
    await composeInPage(page, {
        width: 2000, height: 470, name: 'cakes-montage.jpg',
        html: `<div style="width:100%;height:100%;box-sizing:border-box;padding:20px;display:grid;grid-template-columns:repeat(5,1fr);gap:20px;background:#fdf1ef">
            ${cakes.map((c) => tile(c)).join('')}</div>`
    });

    // The party room large on the left, the six studio backdrops in a 3 x 2 grid.
    await composeInPage(page, {
        width: 1620, height: 820, name: 'backdrops-montage.jpg',
        html: `<div style="width:100%;height:100%;box-sizing:border-box;padding:20px;display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(2,1fr);gap:20px;background:#f6efec">
            ${tile(bd[0], 'grid-column:span 2;grid-row:span 2')}
            ${bd.slice(1).map((b) => tile(b)).join('')}</div>`
    });
    await page.context().close();
}

// ---------------------------------------------------------------- main

async function main() {
    try {
        const res = await fetch(BASE + '/');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        throw new Error(`No app at ${BASE} (${err.message}). Start it with \`npm run dev\` or set BASE.`);
    }
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || undefined,
        args: [...GPU_ARGS, '--autoplay-policy=no-user-gesture-required']
    });
    try {
        log(`app ${BASE}, groups: ${[...ONLY].join(', ')}`);
        const link = await creatorDesktop(browser);
        log(`card link ${link}`);
        if (ONLY.has('room')) await receiverDesktop(browser, link);
        if (ONLY.has('hero')) await hero(browser, link);
        if (ONLY.has('mobile')) {
            await creatorMobile(browser);
            await receiverMobile(browser, link);
        }
        if (ONLY.has('montage')) await montages(browser);
    } finally {
        await browser.close();
    }
    log(`done: ${written.length} files`);
    for (const [n, kb] of written) console.log(`  ${n.padEnd(28)} ${String(kb).padStart(4)} KB`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
