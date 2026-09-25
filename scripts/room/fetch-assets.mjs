/* global process, Buffer */
/**
 * Downloads the approved CC0 Poly Haven assets for the party room into
 * scripts/room/cache/ (git-ignored) via api.polyhaven.com, and writes
 * cache/manifest.json (asset -> files, URLs, authors, licence) that
 * build-credits.mjs turns into public/room/CREDITS.md.
 *
 *   node scripts/room/fetch-assets.mjs
 *
 * Only models/textures on the owner-approved list (room-brief.md), 1k
 * glTF / 1k JPG variants. Poly Haven assets are all CC0
 * (https://polyhaven.com/license); the script still records each one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');

const MODELS = [
    'round_wooden_table_01', 'Sofa_01', 'wooden_display_shelves_01', 'side_table_01',
    'modern_ceiling_lamp_01', 'standing_picture_frame_01', 'ceramic_vase_01'
];
const TEXTURES = ['herringbone_parquet', 'plastered_wall_04'];
const TEX_MAPS = ['Diffuse', 'nor_gl', 'arm'];

async function json(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'hbd-party-room-pipeline' } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
}

async function download(url, dest) {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return 'cached';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return 'downloaded';
}

const manifest = { fetched: new Date().toISOString(), license: 'CC0 1.0 (https://polyhaven.com/license)', assets: {} };

for (const id of [...MODELS, ...TEXTURES]) {
    const info = await json(`https://api.polyhaven.com/info/${id}`);
    const files = await json(`https://api.polyhaven.com/files/${id}`);
    const entry = {
        name: info.name, type: info.type === 2 ? 'model' : 'texture', authors: Object.keys(info.authors || {}),
        page: `https://polyhaven.com/a/${id}`, dimensions_mm: info.dimensions, files: []
    };
    const dir = path.join(CACHE, id);
    if (MODELS.includes(id)) {
        const g = files.gltf['1k'].gltf;
        const main = path.join(dir, path.basename(new URL(g.url).pathname));
        await download(g.url, main);
        entry.files.push({ file: path.relative(CACHE, main), url: g.url });
        for (const [rel, f] of Object.entries(g.include)) {
            const dest = path.join(dir, rel);
            await download(f.url, dest);
            entry.files.push({ file: path.relative(CACHE, dest), url: f.url });
        }
        entry.gltf = path.relative(CACHE, main);
    } else {
        for (const map of TEX_MAPS) {
            const f = files[map]?.['1k']?.jpg;
            if (!f) continue;
            const dest = path.join(dir, path.basename(new URL(f.url).pathname));
            await download(f.url, dest);
            entry.files.push({ file: path.relative(CACHE, dest), url: f.url, map });
        }
    }
    manifest.assets[id] = entry;
    console.log(`${id}: ${entry.files.length} files`);
}
fs.writeFileSync(path.join(CACHE, 'manifest.json'), JSON.stringify(manifest, null, 2));
process.stdout.write('ok\n');
