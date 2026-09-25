# Security Policy / นโยบายความปลอดภัย

## Reporting a vulnerability / การแจ้งช่องโหว่

**ไทย:** กรุณาอย่าเปิด issue สาธารณะ แจ้งแบบส่วนตัวผ่าน GitHub ที่แท็บ Security ของ repo แล้วเลือก "Report a vulnerability" (private vulnerability reporting) ใส่ลิงก์การ์ดหรือขั้นตอนที่ทำให้เกิดปัญหา เบราว์เซอร์และอุปกรณ์ที่ใช้ ผู้ดูแลจะตอบรับและแจ้งแผนแก้ไขในช่องทางเดียวกัน

**English:** Please do not open a public issue. Report privately through GitHub: the repository's **Security** tab, **Report a vulnerability**. Include the card link or steps to reproduce, and the browser and device. The maintainers acknowledge and follow up in that advisory thread. If private reporting is not enabled on the repository, contact a maintainer listed in `.github/CODEOWNERS` through their GitHub profile and ask for a private channel before sharing details.

Only the latest `main` is supported; there are no maintained release branches.
รองรับเฉพาะ `main` ล่าสุดเท่านั้น

## Threat model / แบบจำลองภัยคุกคาม

**ไทย:** แอปไม่มีเซิร์ฟเวอร์และไม่เก็บข้อมูลผู้ใช้ ความเสี่ยงหลักจึงอยู่ที่ลิงก์การ์ด ซึ่งใครก็สร้างขึ้นเองได้ ทุกค่าที่อ่านจากลิงก์จึงถือว่าไม่น่าเชื่อถือ

**English:** There is no server and no stored user data, so the main attack surface is the share link: anyone can craft one and send it. Everything decoded from a link is treated as hostile input.

| Risk | Control | Where |
|---|---|---|
| Script injection through names or messages | All user text reaches the DOM through `textContent`; `innerHTML` is only used to clear containers or insert fixed markup with no user data | `viewer.js`, `creator.js`, `i18n.js` |
| Unexpected values (unknown enums, huge numbers, odd types) | `sanitizeCardConfig()` rebuilds the config from defaults: enums must match the creator's own controls, text is trimmed and length-capped, counts clamped, colours must be `#rrggbb`, dates `YYYY-MM-DD`, switches real booleans | `main.js` |
| Decompression bomb / oversized link | Payloads over 12 000 characters are refused; inflated data is capped at 16 KB with a streaming reader that cancels past the cap | `card-link.js` |
| Malformed binary payload | Bounds checks on every read, varint length limited, unknown high tags rejected; decoding never throws and falls back to a default card | `card-link.js` |
| Photo link pointing somewhere unsafe | Only `https:` URLs survive the sanitizer; images load with `referrerpolicy="no-referrer"` (card) and `crossOrigin = 'anonymous'` (room frame) | `main.js`, `index.html`, `room/index.js` |
| Voice-clip manifest abuse | `audio/clips.json` entries must be plain file names with an audio extension in the same folder; anything else is ignored | `audio/engine.js` |
| Microphone misuse | Opt-in only, behind an explainer, only in a secure context; audio is analysed in memory and never recorded or sent; tracks are stopped when blowing ends | `viewer.js` |

## Data and privacy / ข้อมูลและความเป็นส่วนตัว

- Card content exists only in the link fragment, which browsers never send to the host. No analytics, no cookies, no accounts.
- Local storage: the creator's draft and language (`localStorage`), a 30-minute end-screen marker after the LINE thank-you (`sessionStorage`).
- Third-party requests happen only when the user causes them: the sender's photo host (if a photo link was added) and LINE or the system share sheet (when a share or thank-you button is tapped).
- Anyone holding a link can read that card. There is no way to revoke a link once sent.

## Hardening for deployments / การตั้งค่าเพิ่มเติมตอน deploy

A suggested Content Security Policy, `Permissions-Policy: microphone=(self)` and caching rules are in [DEPLOYMENT.md](DEPLOYMENT.md#headers). Serve the site over HTTPS only.
