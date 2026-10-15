# Sender voice messages / ข้อความเสียงของผู้ส่ง

**ไทย:** โฟลเดอร์นี้เก็บไฟล์ข้อความเสียงที่ผู้ส่งอัดเองสำหรับการ์ดแต่ละใบ ไฟล์ `public/voices/<ชื่อ>.m4a` จะอยู่ที่
`https://gubbitkeytoday.github.io/hbd-3d-craft/voices/<ชื่อ>.m4a` นำลิงก์นี้ไปใส่ในช่อง "ลิงก์ข้อความเสียงของคุณ" ในขั้นที่ 3 ของหน้าสร้างการ์ด
เสียงจะเล่นหลังเป่าเทียนเล่มสุดท้าย และผู้รับกดปุ่มฟังซ้ำได้ ไฟล์ในนี้เป็นสาธารณะ ใครมีลิงก์ก็ฟังได้

**English:** Voice messages recorded by senders, one file per card. A file at
`public/voices/<name>.m4a` is served at `https://gubbitkeytoday.github.io/hbd-3d-craft/voices/<name>.m4a`;
paste that link into "Your voice message link" in creator step 3. It plays after the
last candle goes out and has a replay button on the message card. Files here are
public: anyone with the link can play them.

Any https audio link works if its host allows CORS (the receiver decodes the file
with Web Audio). Prefer `.m4a` (AAC) or `.mp3` for iPhone; keep it under about 1 MB.
