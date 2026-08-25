// ================================================================
// tools/version.js — Sube el cache-busting de los HTML
//
//   node tools/version.js            → usa la fecha de hoy
//   node tools/version.js 20260901   → usa la que le pases
//
// ── Para qué ────────────────────────────────────────────────────
// Los <script> y <link> llevan ?v=YYYYMMDD. Si se edita un .js y NO
// se sube ese número, el navegador y el CDN siguen sirviendo la copia
// vieja bajo la misma URL: el archivo en el servidor está nuevo, pero
// nadie lo descarga. Pasó con login.html, que quedó en ?v=20260725
// mientras config.js y auth.js cambiaban una decena de veces.
//
// Correr esto ANTES de cada push que toque js/ o css/.
// ================================================================

const fs   = require('fs');
const path = require('path');

const ROOT  = path.resolve(__dirname, '..');
const HTMLS = ['app.html', 'login.html', 'index.html'];

const arg = process.argv[2];
const hoy = new Date();
const version = arg && /^\d{8}$/.test(arg)
    ? arg
    : `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}${String(hoy.getDate()).padStart(2, '0')}`;

if (arg && !/^\d{8}$/.test(arg)) {
    console.error(`Versión inválida: "${arg}". Usa 8 dígitos, ej: 20260901`);
    process.exit(1);
}

let total = 0;

for (const archivo of HTMLS) {
    const ruta = path.join(ROOT, archivo);
    if (!fs.existsSync(ruta)) continue;

    const antes = fs.readFileSync(ruta, 'utf8');
    // Acepta la letra de sufijo que se usaba antes (20260725c)
    const despues = antes.replace(/\?v=\d{8}[a-z]?/g, `?v=${version}`);

    const cambios = (antes.match(/\?v=\d{8}[a-z]?/g) || []).length;
    const distintos = antes === despues ? 0 : cambios;

    if (antes !== despues) fs.writeFileSync(ruta, despues);

    console.log(`  ${archivo.padEnd(12)} ${cambios} referencia(s)` +
                (distintos ? ` → ?v=${version}` : '  (ya estaba al día)'));
    total += distintos;
}

console.log(total
    ? `\n✓ ${total} referencia(s) actualizadas a ?v=${version}`
    : `\n✓ todo ya estaba en ?v=${version}`);

// Aviso si quedaron archivos js/ o css/ sin cache-busting
const sinVersion = [];
for (const archivo of HTMLS) {
    const ruta = path.join(ROOT, archivo);
    if (!fs.existsSync(ruta)) continue;
    const s = fs.readFileSync(ruta, 'utf8');
    for (const m of s.matchAll(/(?:src|href)="((?:js|css)\/[^"?]+)"/g)) {
        sinVersion.push(`${archivo}: ${m[1]}`);
    }
}
if (sinVersion.length) {
    console.log('\n⚠ Sin ?v= (el navegador los va a cachear sin control):');
    sinVersion.forEach(x => console.log('   · ' + x));
}
