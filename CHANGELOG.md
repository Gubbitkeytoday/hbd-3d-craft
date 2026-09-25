# Changelog / บันทึกการเปลี่ยนแปลง

All notable changes to HBD 3D Craft. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **ไทย:** โปรเจกต์ยังไม่มี git tag และ `package.json` ยังเป็น 1.0.0 เลขเวอร์ชันข้างล่างเป็นชื่อเรียกช่วงงาน (milestone) ที่จัดกลุ่มจากประวัติ git แต่ละช่วงระบุ commit ไว้ให้ตรวจสอบได้
> **English:** There are no release tags and `package.json` still says 1.0.0. The versions below are milestone labels grouped from the git history; each lists its commits so it can be checked.

## [Unreleased]

**ไทย:** เขียนเอกสารใหม่ทั้งหมดจากโค้ดจริงแบบสองภาษา และสร้างภาพหน้าจอชุดใหม่ด้วยสคริปต์

### Added
- `scripts/screenshots.mjs` and `npm run screenshots`: regenerates every documentation image by driving the real creator and receiver flow (playwright-core, new devDependency).
- New screenshot set in `screenshots/` (creator, share sheet, gate, dark room, reveal, song, finale, message card, cake and backdrop montages, hero banner).

### Changed
- README, ARCHITECTURE, DEPLOYMENT, CONTRIBUTING, SECURITY and this changelog rewritten from the current code, Thai first with English; `docs/` now only points to the root documents.
- Pull request and issue templates updated for the current link format and checks.

### Removed
- `take_screenshots.js` (depended on puppeteer, which was never installed) and the four outdated PNG screenshots.

## [2.3.0] - 2026-09-25: Surprise-party room

**ไทย:** ห้องเซอร์ไพรส์ 3 มิติ เปิดไฟจากสวิตช์ กลายเป็นฉากเริ่มต้นของการ์ดใหม่ พร้อมปรับห้องมืดให้มืดจริง และรอบทดสอบมือถือ

Commits: 0e0504d, e8c3672, 89b14c6, d9f76ac (merged in a531647).

### Added
- The `party` backdrop (index 6), now the default for new cards: a condo living room at night, authored and baked headless in Blender 5.2 (Cycles), with CC0 Poly Haven furniture and credits in `public/room/CREDITS.md`.
- Two lightmap sets (dark: city window and switch; party: downlights, pendant, lamp, fairy lights) blended by uniforms, so the reveal compiles no shaders (67 programs on phones, constant).
- Procedural party props: balloon clusters and drop, foil HAPPY BIRTHDAY letters, LED name sign in Thai, bunting, fairy lights, gifts, hats, 3D confetti; theme palettes; the card photo in a frame; reflections captured from the room itself.
- Receiver storyboard: dark room with a glowing switch and hints, tap or auto flip, "เซอร์ไพรส์!" with poppers and haptics, camera glide, lights down for the song with karaoke lyrics, wish, blow, finale; quiet mode and reduced-motion variants.
- Web Audio engine with a limiter and audio-clock scheduling; all cues synthesized; a drop-in loader for real voice recordings (`public/audio/README.md`).
- Poster mode: the show starts at once on baked stills when opened before the room has loaded (early tap on a slow network: about 16 s to about 0.6 s) and stays 2D below 20 fps; big 2D candle buttons.
- Saved photo rendered from a composed shot at 1080x1350 or 1600x1200.

### Changed
- Dark state re-baked with the city window as the only source, eye adaptation from about 0.3x exposure, film grain and vignette; dark frame mean luminance 14.4 % to 5.1 % on desktop.
- Reveal framing per aspect ratio, including portrait variants that keep the letters and name sign in frame.
- Device tier from touch, screen size, cores and memory instead of viewport width (landscape phones keep the phone tier: texture memory 201 MB to 66 MB); per-tier pixel-ratio caps.
- Synthesized words removed in favour of a wordless crowd and applause.
- LINE thank-you keeps the card and resumes on the end screen; the microphone is replaced by "open in browser" where it cannot work; flame tap targets at least 44 px.
- Creator: keyboard-aware layout on phones, Thai word wrapping, no top-bar overflow at 320 to 360 px.

### Fixed
- The room never loaded in production because minification broke the meshopt decoder's workers; the untouched decoder is now served from `public/room/vendor/`.
- Reflections are rebuilt after a WebGL context restore.

## [2.2.0] - 2026-09-25: Light redesign and backdrops

**ไทย:** หน้าสร้างการ์ดโทนสว่างอบอุ่น และเลือกฉากหลังได้

Commit: d8a7bff.

### Added
- Backdrop picker: night plus five pale studio backdrops (blush, cream, sky, mint, lavender) painted by CSS behind a transparent canvas, with retuned exposure, lights and bloom, a contact shadow and a saturated flame look. The backdrop is packed into spare link bits; old links keep the night stage.

### Changed
- Creator restyled light (cream surfaces, warm ink, per-theme accents); every measured text element at 5.09:1 contrast or better.

## [2.1.0] - 2026-09-25: Short links

**ไทย:** ลิงก์สั้นลงประมาณ 8 เท่า ด้วยรูปแบบไบนารี `#/c/` และการอัดค่าตั้งค่าเป็นบล็อก 7 ไบต์

Commits: 3c45ed6, b519bfa.

### Added
- v2 link format `#/c/<payload>`: one-byte tags, enums as indexes, Thai at one byte per character, deflate only when it helps. Untouched template wording is flagged and rebuilt by the recipient instead of being sent. A typical card went from about 680 to 46 to 89 characters.
- v2.1: every enum, count and switch bit-packed into a fixed 7-byte block, the name untagged (a customized card 89 to 67 characters).

### Changed
- Short cards no longer need `CompressionStream`, so older iOS can open them. v1 (`?z=`) and legacy (`?d=`) links still decode.

## [2.0.0] - 2026-09-25: Guided creator and personal reveal

**ไทย:** ออกแบบใหม่ทั้งฝั่งผู้สร้างและผู้รับ เร็วขึ้นและเบาลงมาก

Commits: 8eb3a39, d8adad3, a0a6cc8, d5369b5, 6808c63, 45d8388, b9f08f4.

### Added
- Creator in three steps (who, cake, message) with name-driven templates, a sender field and a required name; share sheet with LINE first, native share, copy, QR on desktop and a privacy note; draft autosave; no-WebGL fallback.
- Receiver: the scene is built and precompiled behind the gate (tap to first 3D frame 7.9 s to 0.11 s desktop, 8.7 s to 0.45 s phone); gate names sender and recipient; opt-in microphone with an explainer; tap to blow; make-a-wish beat; message sheet with end actions (thank you on LINE, replay, save photo, make your own).
- Platform: `precompileScene`, FPS quality governor, async environment map; generated SVG-mask icons instead of the Font Awesome webfont; self-hosted fonts; chunk preloading; og:image link preview; ESLint gate before every build.

### Changed
- Cake models split into a parts kit and one file per model; all five rebuilt (heart silhouette, bento tray, separated 3-tier, hex prism, classic buttercream), shared candle and flame module with one flickering light.
- Kit caches for textures, materials and bodies: a rebuild 469 ms to 5 ms, no growth over repeated rebuilds; phone draw calls 392 to 116.
- Thai-aware topper text (grapheme counting, auto-fit, Thai fonts); complete Thai and Japanese translations.

### Fixed
- Blank receiver view (undefined candle count); a hidden creator layout painting over the receiver on wide screens; share-link payloads now sanitized and gift bubbles use `textContent` (XSS).

## [1.1.0] - 2026-08-18: Five cake models

**ไทย:** เพิ่มเค้ก 5 ทรง เปลวเทียนแบบใหม่ และหมุนดูเค้กได้ในหน้าสร้างการ์ด

Commits: 9100cf4, 4631ba6, 827c656, 2f3d725, b6424d3, 8d252e0, d7f2cef, f648163, a13c629 (2026-08-26, documentation).

### Added
- Five distinct cake architectures; teardrop candle flames; orbit controls in the creator preview; a close button for the card.

### Changed
- Shorter share URLs; mobile camera distance and lag fixes; a personalised belated-birthday build that was later generalised.

## [1.0.0] - 2026-08-02: First version

**ไทย:** เวอร์ชันแรก การ์ดเค้ก 3 มิติพร้อมเป่าเทียน

Commit: 3923b96.

### Added
- 3D cake card with customisation, envelope gate, candle blowing, URL-encoded cards and English, Thai and Japanese text.
