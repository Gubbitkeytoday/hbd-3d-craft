/**
 * The sender's handwriting: a signature or a small doodle drawn with a finger.
 *
 * The creator captures strokes on a 2:1 pad (createSignaturePad). They travel
 * inside the share link as a few hundred bytes (card-link.js stores them as
 * raw bytes under tag 10) and are replayed stroke by stroke for the
 * recipient: under the message on the card, at the end of the letter, and on
 * the framed print in the party room. Typed text says what the sender meant;
 * handwriting shows that they sat down and did it themselves.
 *
 * Wire format v1:
 *   0x01, then for each stroke: varint n (points), x0 and y0 as one byte
 *   each, then n - 1 pairs of zigzag varints (dx, dy).
 * Points sit on a SIG_W x SIG_H grid (2:1 like the pad), so a typical
 * signature of 60 to 120 points is 150 to 300 bytes before the link's
 * deflate pass.
 *
 * Dependency-free on purpose: the creator, the viewer and the room import it.
 */

export const SIG_W = 256;
export const SIG_H = 128;
/** Link budget for the drawing (base64 makes it about 1.33x longer). */
export const SIG_MAX_BYTES = 900;

const FORMAT = 1;
const MAX_STROKES = 64;
const MAX_POINTS_PER_STROKE = 2000;
/** Ramer-Douglas-Peucker tolerance in grid units: invisible at card size. */
const SIMPLIFY_EPSILON = 0.75;

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

function clampX(x) { return Math.max(0, Math.min(SIG_W - 1, x)); }
function clampY(y) { return Math.max(0, Math.min(SIG_H - 1, y)); }

/** Ramer-Douglas-Peucker (iterative): keeps the points the shape needs. */
export function simplify(points, epsilon = SIMPLIFY_EPSILON) {
    if (points.length < 3) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const [ax, ay] = points[a];
        const [bx, by] = points[b];
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        let worst = -1;
        let worstD = epsilon;
        for (let i = a + 1; i < b; i++) {
            const [px, py] = points[i];
            const d = len > 1e-6
                ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len
                : Math.hypot(px - ax, py - ay);
            if (d > worstD) { worstD = d; worst = i; }
        }
        if (worst > 0) {
            keep[worst] = 1;
            stack.push([a, worst], [worst, b]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

/** Float grid points -> integer grid points without repeats, then simplified. */
export function finishStroke(points) {
    const out = [];
    for (const [x, y] of points) {
        const p = [clampX(Math.round(x)), clampY(Math.round(y))];
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    return simplify(out);
}

/* ------------------------------------------------------------------ *
 * Wire format
 * ------------------------------------------------------------------ */

function pushVarint(out, n) {
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
    out.push(n);
}

const zigzag = (n) => (n << 1) ^ (n >> 31);
const unzigzag = (n) => (n >>> 1) ^ -(n & 1);

/** @param {number[][][]} strokes integer grid points @returns {Uint8Array} */
export function encodeStrokes(strokes) {
    const out = [FORMAT];
    for (const stroke of strokes.slice(0, MAX_STROKES)) {
        if (!stroke.length) continue;
        pushVarint(out, stroke.length);
        let [x, y] = stroke[0];
        out.push(clampX(x), clampY(y));
        for (let i = 1; i < stroke.length; i++) {
            const nx = clampX(stroke[i][0]);
            const ny = clampY(stroke[i][1]);
            pushVarint(out, zigzag(nx - x));
            pushVarint(out, zigzag(ny - y));
            x = nx;
            y = ny;
        }
    }
    return Uint8Array.from(out);
}

/**
 * Link data is untrusted: anything malformed yields no drawing rather than
 * a half-drawn one, and every point is clamped onto the grid.
 * @returns {number[][][]}
 */
export function decodeStrokes(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== FORMAT) return [];
    const strokes = [];
    let i = 1;
    const varint = () => {
        let n = 0;
        let shift = 0;
        for (;;) {
            if (i >= bytes.length || shift > 14) throw new Error('bad varint');
            const b = bytes[i++];
            n |= (b & 0x7f) << shift;
            if (!(b & 0x80)) return n;
            shift += 7;
        }
    };
    try {
        while (i < bytes.length) {
            if (strokes.length >= MAX_STROKES) throw new Error('too many strokes');
            const n = varint();
            if (n < 1 || n > MAX_POINTS_PER_STROKE || i + 2 > bytes.length) throw new Error('bad stroke');
            let x = clampX(bytes[i++]);
            let y = clampY(bytes[i++]);
            const stroke = [[x, y]];
            for (let k = 1; k < n; k++) {
                x = clampX(x + unzigzag(varint()));
                y = clampY(y + unzigzag(varint()));
                stroke.push([x, y]);
            }
            strokes.push(stroke);
        }
    } catch {
        return [];
    }
    return strokes;
}

function bytesToBase64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Strokes as the card config carries them (base64url, '' when empty). */
export function strokesToString(strokes) {
    const drawn = strokes.filter((s) => s.length);
    return drawn.length ? bytesToBase64url(encodeStrokes(drawn)) : '';
}

/** @returns {number[][][]} empty for '' or anything malformed */
export function strokesFromString(value) {
    if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) return [];
    try {
        return decodeStrokes(base64urlToBytes(value));
    } catch {
        return [];
    }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Chaikin corner cutting (twice): smooth curves from the simplified points. */
function smooth(points) {
    let pts = points;
    for (let pass = 0; pass < 2 && pts.length > 2; pass++) {
        const out = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[i + 1];
            out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
        }
        out.push(pts[pts.length - 1]);
        pts = out;
    }
    return pts;
}

/**
 * Dense paths with per-segment lengths, the content bounds, and the total
 * length, so replay can advance at an even pen speed.
 */
function prepare(strokes) {
    const paths = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let total = 0;
    for (const stroke of strokes) {
        if (!stroke.length) continue;
        const pts = smooth(stroke);
        const seg = [0];
        for (let i = 1; i < pts.length; i++) seg.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const length = seg.reduce((a, b) => a + b, 0);
        for (const [x, y] of pts) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        paths.push({ pts, seg, length });
        total += length;
    }
    return { paths, total, bounds: paths.length ? { minX, minY, maxX, maxY } : null };
}

/**
 * Where grid units land in `rect`. 'grid' maps the whole pad (what the
 * sender saw); 'content' trims to the ink and centres it, so a small
 * signature drawn in a corner still fills the space it is given.
 */
function layout(prep, rect, fit) {
    if (fit === 'grid' || !prep.bounds) {
        const s = Math.min(rect.w / SIG_W, rect.h / SIG_H);
        return { s, ox: rect.x + (rect.w - SIG_W * s) / 2, oy: rect.y + (rect.h - SIG_H * s) / 2 };
    }
    const { minX, minY, maxX, maxY } = prep.bounds;
    // A lone dot or a short dash must not be blown up to fill the card.
    const bw = Math.max(maxX - minX, SIG_W * 0.3);
    const bh = Math.max(maxY - minY, SIG_H * 0.3);
    const s = Math.min(rect.w / bw, rect.h / bh);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { s, ox: rect.x + rect.w / 2 - cx * s, oy: rect.y + rect.h / 2 - cy * s };
}

/** Pen width for a segment: a slanted nib, thicker on down-strokes. */
function nibWidth(base, dx, dy) {
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return base;
    // 1 across the nib, ~0.7 along it (nib held at 40 degrees).
    const along = Math.abs((dx * 0.766 + dy * -0.643) / len);
    return base * (1.08 - 0.38 * along);
}

/**
 * Draws the first `length` grid units of ink (all of it by default) into a
 * 2D context. Segments are opaque round-capped lines, so the replay can add
 * ink frame by frame without overlaps showing.
 */
function drawInk(ctx, prep, map, { color, width, from = 0, to = Infinity }) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let walked = 0;
    for (const path of prep.paths) {
        const start = walked;
        walked += path.length;
        if (walked < from || start > to) continue;
        const { pts, seg } = path;
        const X = (p) => map.ox + p[0] * map.s;
        const Y = (p) => map.oy + p[1] * map.s;
        if (pts.length === 1 || path.length < 0.5) {
            // A dot: the pen touching down.
            if (start >= from && start <= to) {
                ctx.beginPath();
                ctx.arc(X(pts[0]), Y(pts[0]), width * 0.62, 0, Math.PI * 2);
                ctx.fill();
            }
            continue;
        }
        let at = start;
        for (let i = 1; i < pts.length; i++) {
            const a = at;
            const b = at + seg[i];
            at = b;
            if (b < from || a > to) continue;
            const p0 = pts[i - 1];
            const p1 = pts[i];
            // Clip the segment to [from, to] along its own length.
            const t0 = seg[i] > 0 ? Math.max(0, (from - a) / seg[i]) : 0;
            const t1 = seg[i] > 0 ? Math.min(1, (to - a) / seg[i]) : 1;
            const x0 = p0[0] + (p1[0] - p0[0]) * t0;
            const y0 = p0[1] + (p1[1] - p0[1]) * t0;
            const x1 = p0[0] + (p1[0] - p0[0]) * t1;
            const y1 = p0[1] + (p1[1] - p0[1]) * t1;
            ctx.lineWidth = nibWidth(width, p1[0] - p0[0], p1[1] - p0[1]);
            ctx.beginPath();
            ctx.moveTo(X([x0, y0]), Y([x0, y0]));
            ctx.lineTo(X([x1, y1]), Y([x1, y1]));
            ctx.stroke();
        }
    }
    ctx.restore();
}

/** Base pen width in pixels for a given grid scale. */
function penWidth(scale, factor = 1) {
    return Math.max(1.4, scale * 2.1 * factor);
}

/**
 * Static drawing into any 2D context (the room's frame print, the pad).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[][][]} strokes
 * @param {{x:number,y:number,w:number,h:number}} rect  target box in ctx pixels
 * @param {{ color?: string, fit?: 'content'|'grid', weight?: number }} [opts]
 */
export function drawSignature(ctx, strokes, rect, { color = '#2a1f2d', fit = 'content', weight = 1 } = {}) {
    const prep = prepare(strokes);
    if (!prep.paths.length) return;
    const map = layout(prep, rect, fit);
    drawInk(ctx, prep, map, { color, width: penWidth(map.s, weight) });
}

/** Sizes a canvas backing store to its CSS box. Returns false while it has no size. */
function fitCanvas(canvas) {
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    return true;
}

/**
 * Writes the signature into `canvas` the way it was drawn: stroke by stroke
 * at an even pen speed, with a short lift between strokes. Instant when
 * `animate` is false (reduced motion). Returns a cancel function.
 */
export function playSignature(canvas, strokes, { color = '#2a1f2d', animate = true, weight = 1, delay = 0, onDone } = {}) {
    const prep = prepare(strokes);
    const ctx = canvas.getContext('2d');
    let raf = 0;
    let timer = 0;
    let cancelled = false;
    const cancel = () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        clearTimeout(timer);
    };
    if (!ctx || !prep.paths.length) {
        onDone?.();
        return cancel;
    }

    // A replay starts from a blank card, also while it waits for `delay`.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let map = null;
    let width = 1;
    // A canvas that never gets a size (closed before it was laid out) stops
    // asking after about two seconds instead of polling forever.
    let waits = 0;
    const setup = () => {
        if (++waits > 120) {
            cancel();
            return false;
        }
        if (!fitCanvas(canvas)) return false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const pad = canvas.height * 0.08;
        map = layout(prep, { x: pad, y: pad, w: canvas.width - pad * 2, h: canvas.height - pad * 2 }, 'content');
        width = penWidth(map.s, weight);
        return true;
    };

    // Only dots (nothing to trace): they simply appear.
    if (!animate || prep.total < 1) {
        const draw = () => {
            if (cancelled) return;
            if (!setup()) { raf = requestAnimationFrame(draw); return; }
            drawInk(ctx, prep, map, { color, width });
            onDone?.();
        };
        draw();
        return cancel;
    }

    // Pen speed in grid units per second, eased so short signatures do not
    // flash by and long doodles do not drag.
    const writeS = Math.min(3.2, Math.max(0.9, prep.total / 230));
    const speed = prep.total / writeS;
    const LIFT_S = Math.min(0.12, 0.9 / prep.paths.length);
    // Timeline: each stroke's ink, then a lift.
    const marks = [];
    let t = 0;
    let len = 0;
    for (const path of prep.paths) {
        marks.push({ t0: t, len0: len, dur: path.length / speed, length: path.length });
        t += path.length / speed + LIFT_S;
        len += path.length;
    }
    const totalS = t - LIFT_S;
    const inkAt = (s) => {
        for (const m of marks) {
            if (s < m.t0) return m.len0;
            if (s <= m.t0 + m.dur) return m.len0 + (m.dur > 0 ? (s - m.t0) / m.dur : 1) * m.length;
        }
        return prep.total;
    };

    let start = 0;
    let drawn = 0;
    const frame = (now) => {
        if (cancelled) return;
        if (!map && !setup()) { raf = requestAnimationFrame(frame); return; }
        if (!start) start = now;
        const s = (now - start) / 1000;
        const to = s >= totalS ? Infinity : inkAt(s);
        if (to > drawn) {
            // Overlap the previous end a hair so the joints stay round.
            drawInk(ctx, prep, map, { color, width, from: Math.max(0, drawn - 0.01), to });
            drawn = to;
        }
        if (to === Infinity) {
            onDone?.();
            return;
        }
        raf = requestAnimationFrame(frame);
    };
    timer = setTimeout(() => { raf = requestAnimationFrame(frame); }, Math.max(0, delay));
    return cancel;
}

/* ------------------------------------------------------------------ *
 * Capture (creator)
 * ------------------------------------------------------------------ */

/**
 * A finger/mouse/pen pad on a 2:1 canvas. Strokes are kept in grid units, so
 * what the sender sees after lifting the pen is exactly what the link
 * carries.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ color?: () => string, onChange?: (strokes:number[][][]) => void, onFull?: () => void, onStart?: () => void }} opts
 */
export function createSignaturePad(canvas, { color = () => '#2a1f2d', onChange, onFull, onStart } = {}) {
    const ctx = canvas.getContext('2d');
    let strokes = [];
    let live = null;      // float grid points of the stroke being drawn
    let pointerId = null;

    const scale = () => canvas.width / SIG_W;

    const redraw = () => {
        if (!fitCanvas(canvas)) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const all = live ? [...strokes, live] : strokes;
        if (!all.length) return;
        const prep = prepare(all);
        const map = { s: scale(), ox: 0, oy: 0 };
        drawInk(ctx, prep, map, { color: color(), width: penWidth(map.s) });
    };

    const toGrid = (e) => {
        const r = canvas.getBoundingClientRect();
        return [((e.clientX - r.left) / r.width) * SIG_W, ((e.clientY - r.top) / r.height) * SIG_H];
    };

    // Live ink: the raw pointer path, only the segments not drawn yet. On
    // lift the stroke is simplified and redrawn as the link will carry it.
    let liveDrawn = 0;
    const drawLiveTail = () => {
        const s = scale();
        const base = penWidth(s);
        ctx.save();
        ctx.strokeStyle = ctx.fillStyle = color();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (live.length === 1) {
            ctx.beginPath();
            ctx.arc(live[0][0] * s, live[0][1] * s, base * 0.62, 0, Math.PI * 2);
            ctx.fill();
        }
        for (let i = Math.max(1, liveDrawn); i < live.length; i++) {
            const [x0, y0] = live[i - 1];
            const [x1, y1] = live[i];
            ctx.lineWidth = nibWidth(base, x1 - x0, y1 - y0);
            ctx.beginPath();
            ctx.moveTo(x0 * s, y0 * s);
            ctx.lineTo(x1 * s, y1 * s);
            ctx.stroke();
        }
        ctx.restore();
        liveDrawn = live.length;
    };

    const onDown = (e) => {
        if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        const before = canvas.width;
        if (!fitCanvas(canvas)) return;
        // A resized backing store is blank: put the finished strokes back first.
        if (canvas.width !== before) redraw();
        pointerId = e.pointerId;
        try { canvas.setPointerCapture(e.pointerId); } catch { /* already released */ }
        live = [toGrid(e)];
        liveDrawn = 0;
        onStart?.();
        drawLiveTail();
    };

    const onMove = (e) => {
        if (e.pointerId !== pointerId || !live) return;
        e.preventDefault();
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        for (const ev of (events.length ? events : [e])) live.push(toGrid(ev));
        drawLiveTail();
    };

    const onUp = (e) => {
        if (e.pointerId !== pointerId) return;
        pointerId = null;
        const done = live ? finishStroke(live) : [];
        live = null;
        if (done.length) {
            const next = [...strokes, done];
            if (encodeStrokes(next).length > SIG_MAX_BYTES) {
                onFull?.();
            } else {
                strokes = next;
                onChange?.(strokes);
            }
        }
        redraw();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => redraw()) : null;
    ro?.observe(canvas);

    return {
        getStrokes: () => strokes,
        setStrokes(next) {
            strokes = Array.isArray(next) ? next : [];
            redraw();
        },
        undo() {
            if (!strokes.length) return;
            strokes = strokes.slice(0, -1);
            redraw();
            onChange?.(strokes);
        },
        clear() {
            if (!strokes.length) return;
            strokes = [];
            redraw();
            onChange?.(strokes);
        },
        redraw,
        destroy() {
            ro?.disconnect();
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', onUp);
            canvas.removeEventListener('pointercancel', onUp);
        }
    };
}
