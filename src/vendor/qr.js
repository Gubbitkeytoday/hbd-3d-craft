/**
 * Minimal QR Code encoder (byte mode, versions 1-40, ECC L/M/Q/H).
 * MIT License. Written for HBD 3D Craft after the structure of Project
 * Nayuki's reference implementation (https://www.nayuki.io/page/qr-code-generator-library, MIT).
 *
 * Only what the share sheet needs: encode a URL, pick the smallest version,
 * choose the best mask, draw to a canvas. Lazy-loaded, ~4 KB minified.
 */

const ECL = {
    L: { ordinal: 0, formatBits: 1 },
    M: { ordinal: 1, formatBits: 0 },
    Q: { ordinal: 2, formatBits: 3 },
    H: { ordinal: 3, formatBits: 2 }
};

// Index 0 is padding. Rows: L, M, Q, H.
const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];
const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}

function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8)
        - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
}

/* ---------- Reed-Solomon over GF(2^8), polynomial 0x11D ---------- */

function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
    }
    return result;
}

/* ---------- Symbol construction ---------- */

class QrSymbol {
    constructor(version, ecl, dataCodewords) {
        this.version = version;
        this.ecl = ecl;
        this.size = version * 4 + 17;
        this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
        this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));

        this.drawFunctionPatterns();
        this.drawCodewords(this.addEccAndInterleave(dataCodewords));

        let bestMask = 0;
        let minPenalty = Infinity;
        for (let mask = 0; mask < 8; mask++) {
            this.applyMask(mask);
            this.drawFormatBits(mask);
            const penalty = this.penaltyScore();
            if (penalty < minPenalty) {
                bestMask = mask;
                minPenalty = penalty;
            }
            this.applyMask(mask); // XOR again to undo
        }
        this.mask = bestMask;
        this.applyMask(bestMask);
        this.drawFormatBits(bestMask);
        this.isFunction = null;
    }

    setFunction(x, y, dark) {
        this.modules[y][x] = dark;
        this.isFunction[y][x] = true;
    }

    drawFunctionPatterns() {
        const size = this.size;
        for (let i = 0; i < size; i++) {
            this.setFunction(6, i, i % 2 === 0);
            this.setFunction(i, 6, i % 2 === 0);
        }
        this.drawFinder(3, 3);
        this.drawFinder(size - 4, 3);
        this.drawFinder(3, size - 4);

        const pos = this.alignmentPositions();
        const n = pos.length;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const corner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
                if (!corner) this.drawAlignment(pos[i], pos[j]);
            }
        }
        this.drawFormatBits(0); // placeholder, overwritten after masking
        this.drawVersion();
    }

    drawFinder(x, y) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                const xx = x + dx;
                const yy = y + dy;
                if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
                    this.setFunction(xx, yy, dist !== 2 && dist !== 4);
                }
            }
        }
    }

    drawAlignment(x, y) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }

    alignmentPositions() {
        if (this.version === 1) return [];
        const numAlign = Math.floor(this.version / 7) + 2;
        const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
        const result = [6];
        for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
        return result;
    }

    drawFormatBits(mask) {
        const data = (this.ecl.formatBits << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412;
        const size = this.size;

        for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
        this.setFunction(8, 7, getBit(bits, 6));
        this.setFunction(8, 8, getBit(bits, 7));
        this.setFunction(7, 8, getBit(bits, 8));
        for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));

        for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, getBit(bits, i));
        for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, getBit(bits, i));
        this.setFunction(8, size - 8, true); // always-dark module
    }

    drawVersion() {
        if (this.version < 7) return;
        let rem = this.version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const bits = (this.version << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const bit = getBit(bits, i);
            const a = this.size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            this.setFunction(a, b, bit);
            this.setFunction(b, a, bit);
        }
    }

    addEccAndInterleave(data) {
        const ver = this.version;
        const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[this.ecl.ordinal][ver];
        const blockEccLen = ECC_CODEWORDS_PER_BLOCK[this.ecl.ordinal][ver];
        const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
        const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
        const shortBlockLen = Math.floor(rawCodewords / numBlocks);

        const blocks = [];
        const divisor = rsDivisor(blockEccLen);
        for (let i = 0, k = 0; i < numBlocks; i++) {
            const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
            k += dat.length;
            const ecc = rsRemainder(dat, divisor);
            if (i < numShortBlocks) dat.push(0);
            blocks.push(dat.concat(ecc));
        }

        const result = [];
        for (let i = 0; i < blocks[0].length; i++) {
            blocks.forEach((block, j) => {
                // Skip the padding cell of the short blocks.
                if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
            });
        }
        return result;
    }

    drawCodewords(data) {
        const size = this.size;
        let i = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5; // skip the vertical timing column
            for (let vert = 0; vert < size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? size - 1 - vert : vert;
                    if (!this.isFunction[y][x] && i < data.length * 8) {
                        this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
                        i++;
                    }
                }
            }
        }
    }

    applyMask(mask) {
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                let invert;
                switch (mask) {
                    case 0: invert = (x + y) % 2 === 0; break;
                    case 1: invert = y % 2 === 0; break;
                    case 2: invert = x % 3 === 0; break;
                    case 3: invert = (x + y) % 3 === 0; break;
                    case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                    case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                    default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                }
                if (invert && !this.isFunction[y][x]) this.modules[y][x] = !this.modules[y][x];
            }
        }
    }

    // ISO 18004 penalty rules N1-N4; only used to rank the eight masks.
    penaltyScore() {
        const size = this.size;
        const m = this.modules;
        let result = 0;
        const finderLike = (line) => {
            let count = 0;
            const s = line.map(v => (v ? 1 : 0)).join('');
            const patterns = ['00001011101', '10111010000'];
            for (const p of patterns) {
                let idx = s.indexOf(p);
                while (idx !== -1) {
                    count++;
                    idx = s.indexOf(p, idx + 1);
                }
            }
            return count;
        };
        const lineRuns = (line) => {
            let score = 0;
            let run = 1;
            for (let i = 1; i <= line.length; i++) {
                if (i < line.length && line[i] === line[i - 1]) {
                    run++;
                } else {
                    if (run >= 5) score += 3 + (run - 5);
                    run = 1;
                }
            }
            return score;
        };
        for (let y = 0; y < size; y++) {
            const row = m[y];
            const col = m.map(r => r[y]);
            result += lineRuns(row) + lineRuns(col);
            result += 40 * (finderLike(row) + finderLike(col));
        }
        for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
                const c = m[y][x];
                if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
            }
        }
        let dark = 0;
        m.forEach(row => row.forEach(v => { if (v) dark++; }));
        const total = size * size;
        const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
        result += Math.max(0, k) * 10;
        return result;
    }
}

/**
 * Encodes text (UTF-8, byte mode) into a QR symbol.
 * @returns {{ size: number, version: number, modules: boolean[][] }}
 */
export function encodeQr(text, eclName = 'L') {
    const bytes = new TextEncoder().encode(text);
    let ecl = ECL[eclName] || ECL.L;

    let version = 1;
    let dataUsedBits = 0;
    for (;; version++) {
        if (version > 40) throw new RangeError('Text too long for a QR code');
        const ccBits = version < 10 ? 8 : 16;
        dataUsedBits = 4 + ccBits + bytes.length * 8;
        if (dataUsedBits <= numDataCodewords(version, ecl) * 8) break;
    }
    // Spend spare capacity on stronger error correction at the same size.
    for (const name of ['M', 'Q', 'H']) {
        if (ECL[name].ordinal > ecl.ordinal && dataUsedBits <= numDataCodewords(version, ECL[name]) * 8) ecl = ECL[name];
    }

    const bits = [];
    const push = (val, len) => {
        for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(0x4, 4); // byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(b => push(b, 8));

    const capacityBits = numDataCodewords(version, ecl) * 8;
    push(0, Math.min(4, capacityBits - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        codewords.push(byte);
    }
    const symbol = new QrSymbol(version, ecl, codewords);
    return { size: symbol.size, version, modules: symbol.modules };
}

/** Draws a QR symbol onto a canvas, crisp at any device pixel ratio. */
export function drawQr(canvas, text, { cssSize = 200, quietZone = 4, dark = '#000000', light = '#ffffff' } = {}) {
    const qr = encodeQr(text);
    const cells = qr.size + quietZone * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // Whole device pixels per module keep the edges sharp for scanners.
    // At least 2 device pixels per module: 1px modules are unscannable.
    const scale = Math.max(2, Math.floor((cssSize * dpr) / cells));
    canvas.width = canvas.height = cells * scale;
    canvas.style.width = canvas.style.height = `${(cells * scale) / dpr}px`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = dark;
    for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
            if (qr.modules[y][x]) ctx.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
        }
    }
    return qr;
}
