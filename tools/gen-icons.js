// ================================================================
// tools/gen-icons.js — Genera los PNG del ícono de la app desde icons/icon.svg
// Uso (una vez, cuando cambie el SVG):
//   npm i sharp --no-save   &&   node tools/gen-icons.js
// Los PNG resultantes se suben al repo; sharp NO es dependencia del sitio.
// ================================================================
const sharp = require('sharp'), path = require('path'), fs = require('fs');
const DIR = path.resolve(__dirname, '..', 'icons');
const svg = fs.readFileSync(path.join(DIR, 'icon.svg'));

const SALIDAS = [
    ['icon-192.png', 192], ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],          // mismo dibujo: ya es full-bleed con zona segura
    ['apple-touch-icon.png', 180],
    ['favicon-32.png', 32], ['favicon-16.png', 16]
];
(async () => {
    for (const [nombre, px] of SALIDAS) {
        await sharp(svg, { density: 384 }).resize(px, px).png().toFile(path.join(DIR, nombre));
        console.log('✓', nombre);
    }
})();
