// ================================================================
// tools/version.js — Sube el cache-busting de los HTML
//
//   node tools/version.js             → fecha de hoy, con sufijo si hace falta
//   node tools/version.js 20260901    → la versión que le pases
//   node tools/version.js 20260901c   → también acepta sufijo
//
// ── Para qué ────────────────────────────────────────────────────
// Los <script> y <link> llevan ?v=YYYYMMDD. Si se edita un .js y NO
// se sube ese número, el navegador y el CDN siguen sirviendo la copia
// vieja bajo la misma URL: el archivo en el servidor está nuevo, pero
// nadie lo descarga. Pasó con login.html, que quedó en ?v=20260725
// mientras config.js y auth.js cambiaban una decena de veces.
//
// ── El sufijo ───────────────────────────────────────────────────
// Si en un mismo día se hacen dos despliegues, la fecha sola no basta:
// la segunda vez la versión no cambiaría y el caché ganaría igual.
// Por eso, si la versión de hoy ya está en los HTML, se agrega b, c, d…
//
// Correr ANTES de cada push que toque js/ o css/.
// ================================================================

const fs   = require('fs');
const path = require('path');

const ROOT  = path.resolve(__dirname, '..');
const HTMLS = ['app.html', 'login.html', 'index.html'];

const arg = process.argv[2];

if (arg && !/^\d{8}[a-z]?$/.test(arg)) {
    console.error(`Versión inválida: "${arg}". Usa 8 dígitos, ej: 20260901 o 20260901b`);
    process.exit(1);
}

// Qué versiones están hoy en los HTML
const usadas = new Set();
for (const archivo of HTMLS) {
    const ruta = path.join(ROOT, archivo);
    if (!fs.existsSync(ruta)) continue;
    for (const m of fs.readFileSync(ruta, 'utf8').matchAll(/\?v=(\d{8}[a-z]?)/g)) {
        usadas.add(m[1]);
    }
}

/** Si la versión ya está publicada, hay que diferenciarla o el caché gana. */
function siguienteLibre(base) {
    if (!usadas.has(base)) return base;
    for (let i = 98; i <= 122; i++) {          // 'b' … 'z'
        const cand = base + String.fromCharCode(i);
        if (!usadas.has(cand)) return cand;
    }
    console.error('Se acabaron los sufijos de hoy. Pasa una versión a mano.');
    process.exit(1);
}

const hoy  = new Date();
const base = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}${String(hoy.getDate()).padStart(2, '0')}`;
const version = arg || siguienteLibre(base);

let total = 0;

for (const archivo of HTMLS) {
    const ruta = path.join(ROOT, archivo);
    if (!fs.existsSync(ruta)) continue;

    const antes    = fs.readFileSync(ruta, 'utf8');
    const cuantas  = (antes.match(/\?v=\d{8}[a-z]?/g) || []).length;
    const despues  = antes.replace(/\?v=\d{8}[a-z]?/g, `?v=${version}`);

    if (antes !== despues) {
        fs.writeFileSync(ruta, despues);
        total += cuantas;
        console.log(`  ${archivo.padEnd(12)} ${cuantas} referencia(s) → ?v=${version}`);
    } else {
        console.log(`  ${archivo.padEnd(12)} ${cuantas} referencia(s)  (sin cambios)`);
    }
}

console.log(total
    ? `\n✓ ${total} referencia(s) actualizadas a ?v=${version}`
    : `\n✓ ya estaban todas en ?v=${version}`);

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
