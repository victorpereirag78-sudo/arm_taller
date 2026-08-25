// ================================================================
// utils.js — Utilidades compartidas de ARM TALLER
// Incluir después de config.js y antes de los módulos.
// ================================================================

// ── Formato y validación ──────────────────────────────────────────

/** "12.345.678-9" → "12345678-9" (siempre normalizar antes de guardar/comparar) */
function normalizarRut(rut) {
    return (rut || '').replace(/\./g, '').toUpperCase().trim();
}

/** "ab-cd·12" → "ABCD12" (mayúsculas, sin guiones/puntos/espacios) */
function normalizarPatente(patente) {
    return (patente || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().trim();
}

/** 34990 → "$34.990" */
function fmtCLP(n) {
    const num = Number(n) || 0;
    return '$' + num.toLocaleString('es-CL', { maximumFractionDigits: 0 });
}

/** ISO → "24-07-2026". Las columnas DATE ("2026-07-24") se parsean como
    UTC y en Chile (UTC-4/-3) mostraban el día anterior: se fuerzan a local. */
function fmtFecha(iso) {
    if (!iso) return '—';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-CL');
}

/** ISO → "24-07-2026 15:42" */
function fmtFechaHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' :
        d.toLocaleDateString('es-CL') + ' ' +
        d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

/** Escapar HTML para no inyectar nada raro en las tablas */
function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Modal genérico ────────────────────────────────────────────────
// abrirModal(html) crea un overlay con la tarjeta; cerrarModal() lo saca.
// Los módulos ponen su form adentro y enganchan sus botones después.

function abrirModal(html, ancho = '560px') {
    cerrarModal();
    const overlay = document.createElement('div');
    overlay.className = 'tll-modal-overlay';
    overlay.id = 'tllModalOverlay';
    overlay.innerHTML = `<div class="tll-modal" style="max-width:${ancho}">${html}</div>`;
    document.body.appendChild(overlay);

    // Cerrar con click fuera o con Escape
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarModal(); });
    document.addEventListener('keydown', _escCerrar);
}

function cerrarModal() {
    document.getElementById('tllModalOverlay')?.remove();
    document.removeEventListener('keydown', _escCerrar);
}

function _escCerrar(e) { if (e.key === 'Escape') cerrarModal(); }

// ── Aviso flotante (toast) ────────────────────────────────────────
function avisar(mensaje, tipo = 'ok') {
    document.getElementById('tllToast')?.remove();
    const t = document.createElement('div');
    t.id = 'tllToast';
    t.className = `tll-toast tll-toast--${tipo}`;
    t.textContent = mensaje;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

// ── Validaciones (RUT, email, teléfono) ───────────────────────────

/** Valida RUT chileno con dígito verificador (acepta con o sin puntos) */
function validarRutChileno(rut) {
    if (!rut || typeof rut !== 'string') return false;
    const limpio = rut.replace(/[.\-]/g, '').toUpperCase();
    if (limpio.length < 2) return false;

    const cuerpo = limpio.slice(0, -1);
    const dv     = limpio.slice(-1);
    if (!/^\d+$/.test(cuerpo)) return false;

    let suma = 0, mult = 2;
    for (let i = cuerpo.length - 1; i >= 0; i--) {
        suma += parseInt(cuerpo[i]) * mult;
        mult = mult === 7 ? 2 : mult + 1;
    }
    const dvEsperado = 11 - (suma % 11);
    const dvCalc = dvEsperado === 11 ? '0' : dvEsperado === 10 ? 'K' : String(dvEsperado);
    return dv === dvCalc;
}

/** "123456789" → "12.345.678-9" (formato en vivo mientras escribe) */
function formatearRut(rut) {
    let limpio = (rut || '').replace(/[^0-9kK]/g, '').toUpperCase();
    if (limpio.length <= 1) return limpio;
    const dv = limpio.slice(-1);
    const cuerpo = limpio.slice(0, -1);
    let f = '';
    for (let i = cuerpo.length - 1, c = 0; i >= 0; i--, c++) {
        if (c > 0 && c % 3 === 0) f = '.' + f;
        f = cuerpo[i] + f;
    }
    return `${f}-${dv}`;
}

/** Email con formato razonable */
function validarEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((email || '').trim());
}

/** Teléfono chileno: 9 dígitos (móvil/fijo actual) u 8 (fijo antiguo).
    Acepta +56, espacios, guiones. Devuelve true/false. */
function validarTelefono(tel) {
    let digitos = (tel || '').replace(/\D/g, '');
    if (digitos.startsWith('56') && digitos.length > 9) digitos = digitos.slice(2);
    return digitos.length === 8 || digitos.length === 9;
}

// ── Por qué no cargó un panel ─────────────────────────────────────
// Muestra el error REAL de la base, no un genérico. Si falta el script
// SQL lo dice con nombre y apellido; si es otra cosa, muestra el código
// y el mensaje de Postgres para no tener que abrir la consola.
function errorCarga(err, script, que) {
    const codigo = err?.code || '';
    const falta  = ['PGRST205', '42P01', 'PGRST202', '42883', 'PGRST200'].includes(codigo);
    const detalle = [err?.message, err?.details, err?.hint]
        .filter(Boolean).map(esc).join('<br>');

    return `
    <div class="placeholder-text" style="text-align:left;padding:1.4rem 1.6rem">
        ${falta
            ? `<strong>Falta ejecutar <code>sql/${esc(script)}</code> en Supabase.</strong><br>
               Ese script crea lo que ${esc(que)} necesita para funcionar.`
            : `<strong>No se pudo cargar ${esc(que)}.</strong>`}
        <div style="margin-top:0.8rem;font-size:0.74rem;font-family:var(--font-mono);
                    color:var(--text-muted);line-height:1.6">
            ${codigo ? esc(codigo) + ' · ' : ''}${detalle || 'sin detalle'}
        </div>
        <div style="margin-top:0.9rem;font-size:0.78rem">
            Para ver de una vez qué scripts te faltan, ejecuta
            <code>sql/00_diagnostico.sql</code> en el editor SQL de Supabase.
        </div>
    </div>`;
}
