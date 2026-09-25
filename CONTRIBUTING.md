<a id="top"></a>

# Contributing / การมีส่วนร่วม

ขอบคุณที่ช่วยพัฒนา HBD 3D Craft เอกสารนี้สรุปวิธีตั้งเครื่อง กติกาของโค้ด และสิ่งที่ต้องเช็กก่อนเปิด pull request อ่าน [ARCHITECTURE.md](ARCHITECTURE.md) ก่อนแก้ส่วนที่ใหญ่
Thank you for helping. This page covers setup, the rules the code relies on and the checklist for a pull request. Read [ARCHITECTURE.md](ARCHITECTURE.md) before a larger change. Please also follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contents

1. [Setup](#setup)
2. [Lint gate and CI](#lint)
3. [Code conventions](#conventions)
4. [Share links must keep working](#links)
5. [Translations (en / th / ja)](#i18n)
6. [Assets and licences](#assets)
7. [Screenshots](#screenshots)
8. [Commits and branches](#commits)
9. [Pull request checklist](#checklist)

---

<a id="setup"></a>

## 1. Setup

**ไทย:** ใช้ Node.js 20 LTS ติดตั้งด้วย `npm ci` แล้วรัน `npm run dev` เปิด http://localhost:5173 สำหรับทดสอบบนมือถือจริงใช้ `npm run dev -- --host` (ไมโครโฟนต้องใช้ https หรือ localhost)

**English:** Node.js 20 LTS, then:

```bash
npm ci
npm run dev                 # http://localhost:5173
npm run dev -- --host       # reachable from a phone on the same network (mic needs https or localhost)
npm run build && npm run preview   # production check on http://localhost:4173
```

Useful while working: the room harness at `/src/room/dev/room-test.html` (see [ARCHITECTURE.md, Testing](ARCHITECTURE.md#testing)).

<a id="lint"></a>

## 2. Lint gate and CI

**ไทย:** `npm run build` รัน ESLint ก่อนเสมอ ถ้ามี error จะ build ไม่ผ่าน ทั้งบนเครื่องและใน CI (GitHub Actions, Node 20) warning ยอมให้มีได้ แต่อย่าเพิ่มใหม่

**English:** `npm run build` runs `eslint .` first; any error fails the build locally and in CI (`.github/workflows/ci.yml`: Node 20, `npm ci`, `npm run build` on pushes and pull requests to `main`). Warnings do not fail the build, but do not add new ones. The config is `eslint.config.js` (recommended rules, browser globals by default; Node scripts declare theirs with a `/* global */` comment).

```bash
npm run lint
```

<a id="conventions"></a>

## 3. Code conventions

**ไทย:** โค้ดเป็น JavaScript ล้วน (ES modules) ไม่มีเฟรมเวิร์ก กติกาข้างล่างมีไว้เพื่อความปลอดภัย ความลื่นบนมือถือ และลิงก์เก่าที่ต้องเปิดได้ตลอด

**English:** Vanilla JavaScript (ES modules), no framework, four-space indentation, comments that explain *why*. The rules below protect security, frame rate and old links.

| Rule | Why |
|---|---|
| User text goes into the DOM with `textContent` only; never `innerHTML` with anything from a link or a form | Share links are attacker-controlled (see [SECURITY.md](SECURITY.md)) |
| Every value decoded from a link passes `sanitizeCardConfig()` in `main.js`; a new card field needs a rule there | Keeps link data inside what the creator can produce |
| Animate by time (per second), never per frame | Phones run at 30 to 120 Hz |
| Never change the number of lights, `castShadow` or the material set during a show; dim to 0 instead of removing | three.js recompiles programs when the light setup changes, which stutters (the reveal is built to need zero compiles) |
| Free cakes with `disposeCakeGroup()`; never mutate a material from `sharedMaterial()` or the kit factories | Kit caches are shared across rebuilds |
| Keep draw calls low on phones: merge with `partsToMesh()`, instance repeats with `instanceRing()` or `InstancedMesh` | The phone budget is 150 draw calls |
| Heavy work behind the gate yields to the main thread (tasks under 100 ms) | The gate must stay responsive while the scene builds |
| Every new dependency is justified in the pull request | The receiver downloads on mobile data |

<a id="links"></a>

## 4. Share links must keep working

**ไทย:** ทุกลิงก์ที่เคยส่งออกไปต้องเปิดได้ตลอดไป รายการค่าและหมายเลขแท็กใน `card-link.js` และ `backdrop-names.js` เป็นแบบ "เพิ่มต่อท้ายเท่านั้น" และข้อความตั้งต้น `tpl*` ใน `i18n.js` เป็นส่วนหนึ่งของรูปแบบลิงก์ ถ้าแก้ การ์ดเก่าที่ใช้ข้อความนั้นจะเปลี่ยนตาม

**English:** Every link ever sent must keep opening, unchanged.

- Enum lists (`ENUMS` in `card-link.js`, `BACKDROP_NAMES`), `TAGS`, `SHORT_KEYS` and `PACK_LAYOUT` are **append-only**: never rename, remove or reorder. New packed fields go into the spare bits (3 left); new tagged fields take a free tag in the range that matches their size.
- `CARD_DEFAULTS` and `LEGACY_DEFAULTS` define what old links mean; changing a default changes old cards.
- The `tpl*` strings in `i18n.js` are rebuilt from the link on the recipient's side: editing one rewords every existing card that used it. Add a new key instead, and think twice.
- Before merging a codec change, encode a card with the old code, decode it with the new, and open one `#/view/` legacy link.

<a id="i18n"></a>

## 5. Translations (en / th / ja)

**ไทย:** ทุกข้อความบนหน้าจอต้องมีครบ 3 ภาษา ชื่อคีย์เหมือนกันทุกภาษา เพิ่มคีย์ใหม่ต้องเพิ่มพร้อมกันทั้ง `en`, `th`, `ja` ข้อความภาษาไทยเขียนแบบคนไทยพูดจริง ไม่ใช่แปลตรงตัว

**English:** Every visible string exists in `en`, `th` and `ja` with the same key set (308 keys each today). Add keys to all three in the same change; Thai copy should read the way people actually speak, not as a literal translation. Markup uses `data-i18n` / `data-i18n-aria`; code uses the receiver's `t(key, vars)` and `textContent`.

Parity check (Git Bash, macOS or Linux shell, from the repository root):

```bash
node --input-type=module -e "globalThis.localStorage={getItem:()=>null,setItem(){}};globalThis.document={querySelectorAll:()=>[],documentElement:{}};const {translations:t}=await import('./src/i18n.js');const en=Object.keys(t.en);for(const l of ['th','ja']){const k=Object.keys(t[l]);console.log(l,k.length,'missing:',en.filter(x=>!k.includes(x)).join(' ')||'none','extra:',k.filter(x=>!en.includes(x)).join(' ')||'none')}"
```

Expected output: `th 308 missing: none extra: none` and the same for `ja` (the count grows with new keys).

<a id="assets"></a>

## 6. Assets and licences

**ไทย:** ไฟล์ของบุคคลที่สามทุกชิ้น (โมเดล พื้นผิว เสียง รูป) ต้องเป็น CC0 หรือสาธารณสมบัติเท่านั้น และต้องบันทึกแหล่งที่มา ผู้สร้าง และสัญญาอนุญาต ห้ามใช้ไฟล์ CC-BY หรือไฟล์ที่ไม่ชัดเจน เสียงคนต้องอัดเองโดยได้รับความยินยอมจากผู้พูด

**English:**

- Third-party models, textures, images and sounds: **CC0 / public domain only**. Nothing CC-BY, nothing unclear.
- Room assets come from Poly Haven through `scripts/room/fetch-assets.mjs` (an explicit allow-list); `npm run room:optimize` regenerates `public/room/CREDITS.md` with every file, URL, author and licence.
- Voice clips in `public/audio/`: your own recordings made with the speakers' consent, or CC0; add a `CREDITS.md` there for anything you did not record (see [public/audio/README.md](public/audio/README.md)).
- Fonts are self-hosted from `@fontsource` (SIL OFL 1.1); icons are generated from Font Awesome Free by `npm run icons`. Do not add CDN links.
- Keep the phone room download under 3.5 MB and prefer WebP for textures.

<a id="screenshots"></a>

## 7. Screenshots

**ไทย:** ภาพใน README สร้างใหม่ได้ทั้งชุดด้วย `npm run screenshots` ต้องเปิดเซิร์ฟเวอร์ไว้ก่อน และต้องมี Chrome หรือ Chromium ใช้เมื่อหน้าตาแอปเปลี่ยน

**English:** The images in `screenshots/` are produced by `scripts/screenshots.mjs` (playwright-core), which drives the real flow: the creator makes a `#/c/...` link, the receiver opens it, flips the switch, skips the song and blows the candles.

```bash
npm run dev                                   # terminal 1
npm run screenshots                           # terminal 2 (BASE defaults to http://localhost:5173)
BASE=http://localhost:4173 npm run screenshots   # against npm run preview instead
SHOTS=room,hero npm run screenshots           # only some groups: creator, room, hero, mobile, montage
```

`CHROME_PATH` points at a Chrome or Chromium executable; without it Playwright's own browser is used (`npx playwright-core install chromium` downloads it). A real GPU gives the right look; software rendering is slow and flat. Keep each JPG under about 350 KB.

<a id="commits"></a>

## 8. Commits and branches

**ไทย:** ห้าม push ตรงเข้า `main` ให้แตก branch แล้วเปิด pull request หัวข้อ commit เขียนเป็นประโยคคำสั่งสั้น ๆ ส่วนเนื้อหาอธิบายเหตุผลและตัวเลขที่วัดได้

**English:**

- Work on a branch (`feat/...`, `fix/...`, `perf/...`, `docs/...`) and open a pull request to `main`.
- Subject line: imperative and specific, about 72 characters or fewer ("Fit the whole plate on portrait screens"). Body: why, and measured before/after numbers when performance or size changes.
- One logical change per commit; do not mix a refactor with a behaviour change.

<a id="checklist"></a>

## 9. Pull request checklist

The same list is in the pull request template.

- [ ] `npm run build` passes (lint included) with no new warnings
- [ ] Old links still open: one `#/c/...` card from before the change and one `#/view/...` legacy link
- [ ] New strings exist in `en`, `th` and `ja` (parity check above)
- [ ] User text is set with `textContent`; new link fields are sanitized in `main.js`
- [ ] Played a full card on a phone (or phone emulation): dark room, reveal, song, candles, message; with reduced motion as well
- [ ] No shader compile at the reveal (room harness: `__room.stats().programs` equal in dark and lit)
- [ ] New third-party assets are CC0 and credited
- [ ] Docs and screenshots updated if the behaviour or the look changed

<p align="right"><a href="#top">Back to top</a></p>
