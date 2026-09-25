/* global process */
/**
 * Party room: raw Blender export -> web assets in public/room/.
 *
 *   node scripts/room/optimize.mjs
 *
 * In:  scripts/room/cache/room-raw.glb, lm-dark.png, lm-party.png, bake.json,
 *      poster-dark.png, poster-lit.png (optional)
 * Out: public/room/room-high.glb   desktop tier (textures <= 1024)
 *      public/room/room-low.glb    phones (textures <= 512, floor/walls 1024)
 *      public/room/lm-{dark,party}-{2k,1k}.webp
 *      public/room/poster-{dark,lit}.webp
 *      public/room/room.json       manifest read by src/room/loader.js
 *
 * Geometry: weld + reorder + quantize + EXT_meshopt_compression (the
 * decoder ships with three). Textures: WebP via sharp. Lightmaps stay 8-bit
 * sqrt-encoded (room.py) and are written as high-quality WebP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, reorder, quantize, meshopt, textureCompress } from '@gltf-transform/functions';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');
const OUT = path.join(HERE, '..', '..', 'public', 'room');
fs.mkdirSync(OUT, { recursive: true });

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder
});

const BIG = /floor|wall|plaster|parquet/i;

async function variant(name, maxSize, bigSize) {
    const doc = await io.read(path.join(CACHE, 'room-raw.glb'));
    // The standing frame's artwork is replaced at runtime (card photo).
    for (const mat of doc.getRoot().listMaterials()) {
        if (/artwork/i.test(mat.getName())) {
            mat.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null);
        }
    }
    // Lightmap UVs arrive as the custom attribute _LM (see room.py export):
    // make them TEXCOORD_1 and drop any other extra UV sets (no material
    // samples anything but TEXCOORD_0).
    for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
            const lm = prim.getAttribute('_LM');
            for (const sem of prim.listSemantics()) {
                if (/^TEXCOORD_[1-9]$/.test(sem)) prim.setAttribute(sem, null);
            }
            if (lm) {
                prim.setAttribute('TEXCOORD_1', lm);
                prim.setAttribute('_LM', null);
            }
        }
    }
    await doc.transform(
        dedup(),
        prune({ keepAttributes: true }),
        weld(),
        textureCompress({
            encoder: sharp, targetFormat: 'webp', quality: 80,
            resize: [maxSize, maxSize],
            pattern: /^(?!.*(floor|wall|plaster|parquet)).*/i
        }),
        textureCompress({
            encoder: sharp, targetFormat: 'webp', quality: 80,
            resize: [bigSize, bigSize],
            pattern: BIG
        }),
        reorder({ encoder: MeshoptEncoder }),
        quantize({ quantizeTexcoord: 14, quantizeNormal: 10, quantizePosition: 14 }),
        meshopt({ encoder: MeshoptEncoder, level: 'medium' })
    );
    const file = path.join(OUT, `room-${name}.glb`);
    await io.write(file, doc);
    return { file: path.basename(file), bytes: fs.statSync(file).size };
}

async function lightmap(state, size, tag) {
    const src = path.join(CACHE, `lm-${state}.png`);
    const file = `lm-${state}-${tag}.webp`;
    await sharp(src).resize(size, size, { kernel: 'lanczos3' }).webp({ quality: 90, smartSubsample: true, effort: 6 }).toFile(path.join(OUT, file));
    return { file, bytes: fs.statSync(path.join(OUT, file)).size };
}

async function poster(state) {
    const src = path.join(CACHE, `poster-${state}.png`);
    if (!fs.existsSync(src)) return null;
    const file = `poster-${state}.webp`;
    await sharp(src).resize({ width: 1280 }).webp({ quality: 82, effort: 6 }).toFile(path.join(OUT, file));
    return { file, bytes: fs.statSync(path.join(OUT, file)).size };
}

const bake = JSON.parse(fs.readFileSync(path.join(CACHE, 'bake.json'), 'utf8'));
const high = await variant('high', 1024, 1024);
const low = await variant('low', 512, 1024);
const lm = {
    dark: { high: await lightmap('dark', 2048, '2k'), low: await lightmap('dark', 1024, '1k') },
    party: { high: await lightmap('party', 2048, '2k'), low: await lightmap('party', 1024, '1k') }
};
const posters = { dark: await poster('dark'), lit: await poster('lit') };

const manifest = {
    version: 1,
    generated: new Date().toISOString(),
    glb: { high: high.file, low: low.file },
    lightmaps: {
        dark: { high: lm.dark.high.file, low: lm.dark.low.file },
        party: { high: lm.party.high.file, low: lm.party.low.file }
    },
    // Lightmaps store sqrt(E / emax): E = texel^2 * emax (Blender irradiance units).
    emax: { dark: bake.dark.emax, party: bake.party.emax },
    bytes: {
        high: high.bytes + lm.dark.high.bytes + lm.party.high.bytes,
        low: low.bytes + lm.dark.low.bytes + lm.party.low.bytes
    }
};
fs.writeFileSync(path.join(OUT, 'room.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ high, low, lm, posters, total: manifest.bytes }, null, 1));
process.exitCode = 0;
