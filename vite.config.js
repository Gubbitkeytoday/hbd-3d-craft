import { defineConfig } from 'vite';
import { resolve } from 'path';
import { writeIconsCss } from './scripts/gen-icons.mjs';

/**
 * Keeps src/styles/icons.css in sync with the `fa-*` classes used in
 * index.html and src/: regenerated on dev start, on build, and whenever an
 * edited .js/.html file could have added an icon.
 */
function iconsPlugin() {
    let timer = null;
    return {
        name: 'hbd-icons',
        buildStart() {
            writeIconsCss({ quiet: true });
        },
        handleHotUpdate({ file }) {
            if (!/\.(js|html)$/.test(file) || file.includes('node_modules')) return;
            clearTimeout(timer);
            timer = setTimeout(() => writeIconsCss({ quiet: true }), 150);
        }
    };
}

/**
 * Route chunks are dynamic imports, so without help the browser only learns
 * about three.js and the cake kit after main.js has downloaded and run (a
 * second round trip on every visit). This injects:
 *   - <link rel="modulepreload"> for chunks BOTH routes import (three, kit)
 *   - a 1-line inline script that preloads the current route's own chunks
 *     (#/c/... or #/view/... -> viewer, otherwise creator)
 * so everything downloads in parallel with the HTML/CSS while the gate or
 * the creator shell paints.
 */
function routePreloadPlugin() {
    let base = '/';
    return {
        name: 'hbd-route-preload',
        apply: 'build',
        configResolved(config) {
            base = config.base || '/';
        },
        transformIndexHtml: {
            order: 'post',
            handler(html, ctx) {
                if (!ctx.bundle) return html;
                const chunks = Object.values(ctx.bundle).filter((c) => c.type === 'chunk');
                const byFile = new Map(chunks.map((c) => [c.fileName, c]));
                const entry = chunks.find((c) => c.isEntry && c.facadeModuleId?.replace(/\\/g, '/').endsWith('/index.html'));
                const alreadyLoaded = new Set();
                if (entry) {
                    alreadyLoaded.add(entry.fileName);
                    entry.imports.forEach((f) => alreadyLoaded.add(f));
                }
                const closure = (chunk) => {
                    const out = new Set([chunk.fileName]);
                    const visit = (c) => c.imports.forEach((f) => {
                        if (out.has(f)) return;
                        out.add(f);
                        if (byFile.has(f)) visit(byFile.get(f));
                    });
                    visit(chunk);
                    return [...out].filter((f) => !alreadyLoaded.has(f));
                };
                const routeChunk = (suffix) => chunks.find((c) => c.facadeModuleId?.replace(/\\/g, '/').endsWith(suffix));
                const viewer = routeChunk('/src/viewer.js');
                const creator = routeChunk('/src/creator.js');
                if (!viewer || !creator) return html;

                const v = closure(viewer);
                const c = closure(creator);
                const shared = v.filter((f) => c.includes(f));
                const onlyViewer = v.filter((f) => !shared.includes(f));
                const onlyCreator = c.filter((f) => !shared.includes(f));
                const url = (f) => base + f;

                const tags = shared.map((f) => ({
                    tag: 'link',
                    attrs: { rel: 'modulepreload', crossorigin: true, href: url(f) },
                    injectTo: 'head'
                }));
                const script = `(function(){var v=/^#\\/(view|c)\\//.test(location.hash);`
                    + `(v?${JSON.stringify(onlyViewer.map(url))}:${JSON.stringify(onlyCreator.map(url))}).forEach(function(h){`
                    + `var l=document.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href=h;document.head.appendChild(l);});})();`;
                tags.push({ tag: 'script', children: script, injectTo: 'head' });
                return { html, tags };
            }
        }
    };
}

export default defineConfig({
    plugins: [iconsPlugin(), routePreloadPlugin()],
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html')
            },
            output: {
                // three.js changes far less often than app code, so give it its own
                // long-cached chunk.
                manualChunks(id) {
                    if (id.includes('node_modules/three')) return 'three';
                }
            }
        },
        // three.js alone is ~560 kB minified; that chunk size is expected.
        chunkSizeWarningLimit: 650
    }
});
