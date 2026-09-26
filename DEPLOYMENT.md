<a id="top"></a>

# Deployment / การนำขึ้นระบบ

> แต่ละหัวข้อมีคำอธิบายภาษาไทยก่อน ตามด้วยภาษาอังกฤษ คำสั่งแสดงครั้งเดียวเพราะใช้เหมือนกัน
> Each section is in Thai first, then English. Commands are shown once; they are the same for both.

## Contents

1. [What gets deployed](#build)
2. [Cloudflare Pages with Git integration (recommended)](#pages-git)
3. [Manual deploy with Wrangler](#wrangler)
4. [Other static hosts](#other)
5. [Headers, caching and CSP](#headers)
6. [Values to change for your domain](#domain)
7. [After each deploy](#smoke)
8. [Rebuilding the room assets with Blender](#rebuild-room)

---

<a id="build"></a>

## 1. What gets deployed

**ไทย:** แอปเป็นไฟล์ static ล้วน ไม่มีเซิร์ฟเวอร์ ไม่มีฐานข้อมูล ไม่ต้องตั้งค่าตัวแปรสภาพแวดล้อม คำสั่ง build จะตรวจ ESLint ก่อน ถ้ามี error จะ build ไม่ผ่าน ผลลัพธ์อยู่ในโฟลเดอร์ `dist/` ซึ่งรวมไฟล์ใน `public/` (ห้อง เสียง ภาพปก) มาด้วย แอปออกแบบให้อยู่ที่รากโดเมน (`/`)

**English:** The app is purely static: no server, no database, no environment variables. The build runs ESLint first and fails on a lint error. Output goes to `dist/`, which includes everything in `public/` (room assets, audio slot, social cover image). The app expects to be served from the domain root.

| Setting | Value |
|---|---|
| Install | `npm ci` |
| Build command | `npm run build` (= `eslint . && vite build`) |
| Output directory | `dist` |
| Node.js | 20 LTS (same as CI) |
| Environment variables | None required |
| Routing | Hash routes (`#/`, `#/c/...`); no rewrite rules needed |
| HTTPS | Required for the microphone and for `navigator.share`; every modern host provides it |

```bash
npm ci
npm run build
npm run preview    # serves dist/ on http://localhost:4173 for a last check
```

> Sub-path hosting (for example `https://example.com/hbd/`) is not supported as is: the creator's room swatch in `index.html` points at `/room/poster-lit.webp`. Fix that reference before building with `--base`.
> การวางใต้ path ย่อยยังไม่รองรับ เพราะ `index.html` อ้าง `/room/poster-lit.webp` แบบ absolute ต้องแก้ก่อนใช้ `--base`

<a id="pages-git"></a>

## 1a. GitHub Pages (live now) / GitHub Pages (ใช้งานจริงตอนนี้)

**ไทย:** เว็บจริงอยู่ที่ https://gubbitkeytoday.github.io/hbd-3d-craft/ ทุกครั้งที่ push ขึ้น `main` workflow `.github/workflows/deploy-pages.yml` จะ build ด้วย `BASE_PATH=/hbd-3d-craft/` (เว็บอยู่ใต้ชื่อ repo) คัดลอก `index.html` เป็น `404.html` แล้ว deploy ให้เอง ไม่ต้องตั้งค่าอะไรเพิ่ม ดูสถานะได้ที่แท็บ Actions ของ repo

**English:** The live site is https://gubbitkeytoday.github.io/hbd-3d-craft/. Every push to `main` runs `.github/workflows/deploy-pages.yml`, which builds with `BASE_PATH=/hbd-3d-craft/` (the site lives under the repo name), copies `index.html` to `404.html` and deploys. Nothing else to configure; watch progress in the repo's Actions tab.

| Setting | Value |
|---|---|
| Pages source | GitHub Actions |
| Build command | `npm run build` with `BASE_PATH=/<repo>/` |
| Output | `dist/` |
| Local sub-path build | `BASE_PATH=/hbd-3d-craft/ npm run build` (in Git Bash prefix `MSYS_NO_PATHCONV=1`) |

## 2. Cloudflare Pages with Git integration (recommended)

**ไทย:** เชื่อม GitHub กับ Cloudflare Pages ครั้งเดียว หลังจากนั้นทุกครั้งที่ push ขึ้น `main` จะ deploy อัตโนมัติ และทุก branch หรือ pull request จะได้ลิงก์ preview แยก ชื่อเมนูใน Cloudflare อาจเปลี่ยนไปตามเวลา

**English:** Connect the repository once; every push to `main` then deploys to production and every other branch or pull request gets its own preview URL. Dashboard labels change from time to time; the values are what matter.

| ขั้น | Step |
|---|---|
| 1. เข้า Cloudflare dashboard เลือก Workers & Pages แล้วสร้าง Pages project ใหม่แบบเชื่อม Git | Open the Cloudflare dashboard, Workers & Pages, create a Pages project and choose to connect to Git |
| 2. อนุญาตการเข้าถึง GitHub แล้วเลือก repo `hbd-3d-craft` | Authorize GitHub and pick the `hbd-3d-craft` repository |
| 3. Production branch: `main` | Production branch: `main` |
| 4. Framework preset: None (หรือ Vite), Build command: `npm run build`, Build output directory: `dist` | Framework preset: None (or Vite), build command `npm run build`, output directory `dist` |
| 5. Environment variables: `NODE_VERSION` = `20` | Environment variables: `NODE_VERSION` = `20` |
| 6. กด Save and Deploy แล้วรอ build แรกเสร็จ จะได้โดเมน `<project>.pages.dev` | Save and Deploy; the first build gives you `<project>.pages.dev` |
| 7. (ไม่บังคับ) ผูกโดเมนของตัวเองในแท็บ Custom domains | Optional: add your own domain under Custom domains |
| 8. แก้ค่าในหัวข้อ [6](#domain) ให้เป็นโดเมนจริง แล้ว push อีกครั้ง | Update the values in [section 6](#domain) to the real domain and push again |

Rollback: every deployment stays listed in the project; promote an earlier one from the Deployments tab if a release goes wrong.
ย้อนเวอร์ชัน: ทุก deploy ถูกเก็บไว้ เลือก deploy ก่อนหน้าในแท็บ Deployments แล้วตั้งเป็น production ได้ทันที

<a id="wrangler"></a>

## 3. Manual deploy with Wrangler

**ไทย:** ใช้เมื่อไม่ต้องการเชื่อม Git หรืออยากส่ง build จากเครื่องตัวเอง Wrangler ไม่ได้อยู่ใน dependencies ของโปรเจกต์ `npx` จะดาวน์โหลดให้ ต้องล็อกอิน Cloudflare ในเบราว์เซอร์ครั้งแรก

**English:** For deploying a local build without Git integration. Wrangler is not a project dependency; `npx` fetches it. The first run opens a browser to log in to Cloudflare.

```bash
npx wrangler login
npm run build
npx wrangler pages deploy dist --project-name hbd-3d-craft
# a preview deployment instead of production:
npx wrangler pages deploy dist --project-name hbd-3d-craft --branch preview
```

<a id="other"></a>

## 4. Other static hosts

**ไทย:** โฮสต์ static ใดก็ได้ (Vercel, Netlify, GitHub Pages, nginx) ใช้ค่าชุดเดียวกัน: build ด้วย `npm run build` แล้วเสิร์ฟโฟลเดอร์ `dist` ที่รากโดเมนผ่าน HTTPS สิ่งเดียวที่ต้องระวังคือไฟล์ `room/vendor/meshopt_decoder.module.js` ต้องถูกเสิร์ฟแบบไม่ถูกแก้ไข

**English:** Any static host works with the same settings: build with `npm run build`, serve `dist` from the domain root over HTTPS. The one requirement is that `room/vendor/meshopt_decoder.module.js` is served byte-for-byte.

**Why the vendor file matters / ทำไมไฟล์ vendor สำคัญ:** the meshopt decoder starts its Web Workers from its own source code. Minifying it renames the names that source refers to and the workers fail ("workerProcess is not defined"), so production imports this untouched MIT copy at runtime. Turn off any host-side JavaScript minification or "optimization" for `/room/vendor/`. If it still fails, the room loads anyway with the bundled decoder on the main thread (slower on phones).
ตัวถอดรหัส meshopt สร้าง worker จากซอร์สของตัวเอง ถ้าถูกย่อโค้ดจะใช้งาน worker ไม่ได้ จึงต้องปิดการย่อหรือปรับแต่ง JS ของโฮสต์สำหรับ `/room/vendor/`

<a id="headers"></a>

## 5. Headers, caching and CSP

**ไทย:** โปรเจกต์ยังไม่มีไฟล์ header ตัวอย่างข้างล่างเป็นข้อเสนอสำหรับ Cloudflare Pages (วางเป็น `public/_headers` แล้วจะถูกคัดลอกไป `dist/`) ควรเปิด CSP แบบ Report-Only ก่อน ตรวจว่าไม่มีอะไรถูกบล็อก แล้วค่อยเปลี่ยนเป็นบังคับใช้ นโยบายนี้ทดสอบแบบบังคับใช้กับ build จริงบน Chromium เดสก์ท็อปแล้ว ไม่พบการบล็อก (ยังไม่ได้ทดสอบบนมือถือ ลิงก์รูป และไมโครโฟน)

**English:** The repository ships no header file yet. Below is a suggested starting point for Cloudflare Pages (save as `public/_headers`; Vite copies it into `dist/`). Start the CSP in Report-Only mode, play a full card on desktop and on a phone, check the console, then enforce it. This policy was checked enforced against a production build in desktop Chromium (creator, share link, full party card: no violations); phones, the photo link and the microphone were not part of that check.

```text
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: microphone=(self), camera=(), geolocation=()
  Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/room/*
  Cache-Control: public, max-age=86400

/room/room.json
  Cache-Control: no-cache

/audio/*
  Cache-Control: no-cache
```

Why each CSP source is there / เหตุผลของแต่ละค่า:

| Directive | Needed for |
|---|---|
| `script-src 'unsafe-inline'` | The one-line route-preload script Vite injects into `index.html` (its content changes every build, so a fixed hash would go stale) |
| `script-src 'wasm-unsafe-eval'` | The meshopt decoder is WebAssembly |
| `worker-src blob:` | The meshopt decoder's workers are created from a Blob URL |
| `style-src 'unsafe-inline'` | The `style="--sw: ..."` swatch attributes in `index.html` |
| `img-src https: data: blob:` | The sender's photo link (any https host), inline SVG icon masks and the favicon (`data:`), decoded room textures and the saved photo (`blob:`, `data:`) |
| `connect-src 'self' blob: data:` | Room assets, `room.json`, `audio/clips.json` and voice clips come from the same origin; the glTF loader fetches the room's embedded textures through `blob:` URLs |
| `frame-ancestors 'none'` | Optional: blocks embedding the card in other sites; remove it if you want to embed |

Caching notes: files under `/assets/` have content hashes and can be cached forever. Files under `/room/` keep their names between releases, so a re-baked room needs either new file names or a cache purge; `room.json` is kept `no-cache` so a new manifest is picked up. `audio/clips.json` is requested with `cache: 'force-cache'`, so a long max-age would pin an old list.
ไฟล์ใน `/assets/` มี hash ในชื่อ เก็บแคชได้ถาวร ไฟล์ห้องใน `/room/` ชื่อไม่เปลี่ยน ถ้าเบคห้องใหม่ต้องล้างแคชหรือเปลี่ยนชื่อไฟล์

<a id="domain"></a>

## 6. Values to change for your domain

**ไทย:** ลิงก์พรีวิวใน LINE และ Facebook อ่านค่าจากเมตาแท็ก ซึ่งตอนนี้ตั้งเป็น `https://gubbitkeytoday.github.io/hbd-3d-craft/` ถ้าใช้โดเมนอื่นต้องแก้ทุกจุดข้างล่าง ข้อมูลการ์ดอยู่ในแฮชซึ่งโปรแกรมพรีวิวลิงก์มองไม่เห็น ทุกการ์ดจึงแสดงภาพปกเดียวกัน

**English:** Link previews (LINE, Facebook, X) read the meta tags, which currently point at `https://gubbitkeytoday.github.io/hbd-3d-craft/`. Change every item below if you deploy elsewhere. Card data lives in the fragment, which crawlers never see, so every card shares the same preview image.

| File | What to update |
|---|---|
| `index.html` | `<link rel="canonical">`, `og:url`, `og:image`, `twitter:image` |
| `public/robots.txt` | `Sitemap:` URL |
| `public/sitemap.xml` | `<loc>` and `<lastmod>` |
| `public/og-cover.jpg` | Optional: the 1200x630 preview image |

<a id="smoke"></a>

## 7. After each deploy

**ไทย:** ทดสอบสั้น ๆ ทุกครั้งหลัง deploy ใช้เวลาไม่เกิน 10 นาที ผู้รับผิดชอบ: IT (deploy) และ QA (ทดสอบ)

**English:** A short smoke test after every production deploy (about 10 minutes). Owner: IT deploys, QA verifies.

| ตรวจ / Check | ผ่านเมื่อ / Pass when |
|---|---|
| เปิดหน้าแรก / Open the site root | The creator loads, no console errors |
| สร้างการ์ดภาษาไทย ฉากห้องเซอร์ไพรส์ / Make a Thai card with the surprise room | The share sheet shows a `#/c/...` link and, on desktop, a QR code |
| เปิดลิงก์บนมือถือในแอป LINE / Open the link on a phone inside LINE | Gate names sender and recipient; the dark room, reveal, song, candles and message all play |
| ดู Network ของ `room-low.glb` / `room-high.glb` | 200 responses; `room/vendor/meshopt_decoder.module.js` served as JavaScript and unmodified |
| เปิดลิงก์เก่าแบบ `#/view/...` หนึ่งลิงก์ / Open one old `#/view/...` link | It still shows its original cake |
| พรีวิวลิงก์ในแชต / Paste the site URL in a chat | The preview card shows the title and `og-cover.jpg` |

<a id="rebuild-room"></a>

## 8. Rebuilding the room assets with Blender

**ไทย:** ทำเฉพาะเมื่อต้องการแก้ห้อง (เฟอร์นิเจอร์ แสง ขนาด) ไฟล์ผลลัพธ์ใน `public/room/` ถูก commit ไว้แล้ว การ deploy ปกติไม่ต้องทำขั้นนี้ ขั้นตอนใช้เวลานาน (การเบคคุณภาพเต็มอาจใช้หลายสิบนาทีขึ้นกับ GPU) ไฟล์ชั่วคราวอยู่ใน `scripts/room/cache/` ซึ่งไม่ถูก commit ผู้รับผิดชอบ: RD/Tech Lead

**English:** Only needed to change the room itself (furniture, lighting, layout). The processed files in `public/room/` are committed, so a normal deploy never runs this. It is slow (a full-quality bake can take tens of minutes depending on the GPU). Intermediate files go to `scripts/room/cache/`, which is git-ignored. Owner: RD/Tech Lead.

**Prerequisites / สิ่งที่ต้องมี**

| Tool | Why |
|---|---|
| Blender 5.2 (headless is fine) with Cycles; GPU (OptiX / CUDA) recommended | Build, bake, export, posters |
| Python 3 with Pillow (`pip install pillow`) | `make_city.py` paints the night skyline |
| Node 20 + `npm ci` | `sharp`, `meshoptimizer` and `@gltf-transform/*` (devDependencies) for `optimize.mjs` |
| Internet access to `api.polyhaven.com` | Downloads the approved CC0 assets |

**Steps / ขั้นตอน**

```bash
# 1. Download the CC0 Poly Haven assets and paint the city image
#    (writes scripts/room/cache/ and public/room/city-night.webp)
npm run room:fetch

# 2. Build, bake and export in Blender (use your Blender path, e.g. D:\blender.exe on Windows)
blender --background --factory-startup --python scripts/room/room.py -- build
blender --background --factory-startup --python scripts/room/room.py -- bake --size 2048 --samples 1536
blender --background --factory-startup --python scripts/room/room.py -- export

# 3. Optional: poster stills (dark / lit) for the gate, poster mode and the creator swatch
blender --background --factory-startup --python scripts/room/room.py -- poster

# 4. Convert to web assets and regenerate the credits
#    (writes public/room/*.glb, *.webp, room.json, CREDITS.md)
npm run room:optimize
```

| Stage | Output | Notes |
|---|---|---|
| `build` | `cache/room.blend` | Room shell, Poly Haven furniture, procedural sofa / TV / AC, practical lights, two light groups, lightmap UVs; layout from `scripts/room/layout.json` |
| `preview` | quick renders | Optional look-dev of both light groups (`--res WxH`) |
| `bake` | `cache/lm-dark.*`, `cache/lm-party.*`, `cache/bake.json` | DARK and PARTY irradiance lightmaps, 8-bit `sqrt(E / Emax)` PNGs |
| `export` | `cache/room-raw.glb` | UV0 material textures + UV1 lightmap UVs |
| `poster` | `cache/poster-dark.png`, `cache/poster-lit.png` | Options `--res 1280x800`, `--samples 256`, `--states dark,lit`; imports `cache/props.glb` when present |
| `room:optimize` | `public/room/` | Two tiers (high / low), WebP textures, meshopt geometry, lightmaps, posters, `room.json`, `CREDITS.md` |

**Party props in the posters (optional):** the poster stage shows the balloons, letters and cake only if `scripts/room/cache/props.glb` exists. Export it from the dev harness: run `npm run dev`, open `http://localhost:5173/src/room/dev/room-test.html?state=lit`, then in the browser console:

```js
const b64 = await __room.exportProps();
const a = document.createElement('a');
a.href = 'data:model/gltf-binary;base64,' + b64;
a.download = 'props.glb';
a.click();
```

Move the downloaded file to `scripts/room/cache/props.glb` and run the `poster` stage again.

**Before committing new room assets / ก่อน commit ไฟล์ห้องใหม่**

- Keep `scripts/room/layout.json` and `src/room/layout.js` in sync.
- Phone tier stays within budget: `room-low.glb` plus both 1k lightmaps well under 3.5 MB (today 1.33 MB).
- Open the harness at `?state=dark` and `?state=lit` with `q=0`, `1` and `2`; compare `__room.stats().programs` between dark and lit (must be equal).
- Every new third-party asset is CC0 and appears in `public/room/CREDITS.md` (regenerated by `room:optimize`). See [CONTRIBUTING.md](CONTRIBUTING.md#assets).
- Regenerate the documentation images with `npm run screenshots`.

<p align="right"><a href="#top">Back to top</a></p>
