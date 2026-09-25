/**
 * Writes public/room/CREDITS.md from scripts/room/cache/manifest.json
 * (written by fetch-assets.mjs): every downloaded file with its source URL
 * and licence.
 *
 *   node scripts/room/build-credits.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const man = JSON.parse(fs.readFileSync(path.join(HERE, 'cache', 'manifest.json'), 'utf8'));
const lines = [
    '# Party room credits',
    '',
    'The surprise-party room (`public/room/*`) is built by `scripts/room/` from the assets below.',
    'Every third-party asset is **CC0 1.0** (public domain dedication) from Poly Haven,',
    'https://polyhaven.com/license. Attribution is not required; we credit the authors anyway.',
    '',
    '| Asset | Authors | Used for | Page |',
    '|---|---|---|---|'
];
const use = {
    round_wooden_table_01: 'dining table (scaled to 0.745 m)',
    Sofa_01: 'sofa',
    wooden_display_shelves_01: 'display shelves',
    side_table_01: 'side table',
    modern_ceiling_lamp_01: 'pendant lamp over the table',
    standing_picture_frame_01: 'photo frame (artwork replaced by the card photo)',
    ceramic_vase_01: 'vase (decimated)',
    herringbone_parquet: 'floor',
    plastered_wall_04: 'walls (re-tinted)'
};
for (const [id, a] of Object.entries(man.assets)) {
    lines.push(`| ${a.name} | ${a.authors.join(', ')} | ${use[id] || ''} | ${a.page} |`);
}
lines.push('', '## Downloaded files (licence CC0 1.0)', '');
for (const a of Object.values(man.assets)) {
    for (const f of a.files) lines.push(`- \`${f.file.split(path.sep).join('/')}\` from ${f.url}`);
}
lines.push('',
    '## Made for this project',
    '',
    '- Room shell, window, curtains, rug, floor lamp, downlights, lighting and lightmap bakes: `scripts/room/room.py` (Blender 5.2, Cycles).',
    '- Night-city skyline image (`city-night.webp`): procedurally painted by `scripts/room/make_city.py`.',
    '- Balloons, foil letters, bunting, fairy lights, gifts, party hats, confetti: procedural at runtime (`src/room/party/`).',
    '- Text on the name sign and the foil letters is drawn with the project\'s self-hosted fonts (Outfit, Noto Sans Thai; SIL Open Font License 1.1, via @fontsource). No font file is added for the room.',
    '');
fs.writeFileSync(path.join(HERE, '..', '..', 'public', 'room', 'CREDITS.md'), lines.join('\n'));
console.log('credits ok');
