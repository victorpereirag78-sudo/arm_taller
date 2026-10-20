// ================================================================
// presupuesto-publico.js — Página que abre el cliente desde el enlace
// ================================================================
// presupuesto.html?t=<token>. Sin login: el token (128 bits, sql/44) es la
// llave. Muestra el presupuesto completo y deja aprobarlo o rechazarlo.
// Todo pasa por dos RPC públicas: fn_presupuesto_publico y
// fn_presupuesto_publico_responder.
// ================================================================

(() => {
    const token = new URLSearchParams(location.search).get('t') || '';
    const $doc = document.getElementById('pg-doc');
    const $acc = document.getElementById('pg-acciones');
    let _d = null;

    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function mensaje(titulo, detalle) {
        $doc.innerHTML = `<div class="pg-msg"><strong>${esc(titulo)}</strong>${esc(detalle || '')}</div>`;
        $acc.innerHTML = '';
    }

    async function cargar() {
        if (!token) { mensaje('Enlace no válido', 'Abre el enlace completo que te envió el taller.'); return; }

        const { data, error } = await db.rpc('fn_presupuesto_publico', { p_token: token });
        if (error || !data?.ok) {
            mensaje('No pudimos mostrar el presupuesto', data?.error || 'Revisa tu conexión e inténtalo de nuevo.');
            return;
        }
        _d = data.presupuesto;
        document.title = `Presupuesto N°${_d.numero ?? ''} — ${_d.taller?.nombre || ''}`.trim();
        pintar();
    }

    function pintar(aviso) {
        $doc.innerHTML = PresupuestoDoc.html(_d);

        const botones = `<div class="pg-barra">
            <button class="pg-btn" id="pg-imprimir">🖨 Imprimir / guardar PDF</button></div>`;

        if (!_d.puede_responder) {
            $acc.innerHTML = (aviso || '') + botones;
            document.getElementById('pg-imprimir').addEventListener('click', () => window.print());
            return;
        }

        $acc.innerHTML = `${aviso || ''}
            <div class="pg-panel">
                <label for="pg-nombre">Tu nombre (queda como constancia de quién autorizó)</label>
                <input id="pg-nombre" autocomplete="name" value="${esc(_d.cliente?.nombre || '')}" maxlength="80">
                <div id="pg-rechazo" style="display:none">
                    <label for="pg-motivo">Motivo (opcional)</label>
                    <textarea id="pg-motivo" rows="2" maxlength="300"
                        placeholder="Ej: el precio es alto, lo voy a pensar…"></textarea>
                </div>
                <div class="pg-barra" style="margin-top:0">
                    <button class="pg-btn mal" id="pg-rechazar">Rechazar</button>
                    <button class="pg-btn ok" id="pg-aprobar">✓ Aprobar presupuesto</button>
                </div>
            </div>
            ${botones}`;

        document.getElementById('pg-imprimir').addEventListener('click', () => window.print());
        document.getElementById('pg-aprobar').addEventListener('click', () => responder('aprobado'));
        document.getElementById('pg-rechazar').addEventListener('click', () => {
            const caja = document.getElementById('pg-rechazo');
            if (caja.style.display === 'none') { caja.style.display = 'block'; document.getElementById('pg-rechazar').textContent = 'Confirmar rechazo'; return; }
            responder('rechazado');
        });
    }

    async function responder(respuesta) {
        const nombre = document.getElementById('pg-nombre').value.trim();
        if (!nombre) { document.getElementById('pg-nombre').focus(); return; }

        const total = Number(_d.total || 0).toLocaleString('es-CL');
        const pregunta = respuesta === 'aprobado'
            ? `¿Aprobar el presupuesto N°${_d.numero} por $${total}?`
            : `¿Rechazar el presupuesto N°${_d.numero}?`;
        if (!confirm(pregunta)) return;

        document.querySelectorAll('.pg-btn').forEach(b => { b.disabled = true; });

        const { data, error } = await db.rpc('fn_presupuesto_publico_responder', {
            p_token: token, p_respuesta: respuesta, p_por: nombre,
            p_motivo: respuesta === 'rechazado' ? (document.getElementById('pg-motivo')?.value || null) : null
        });

        if (error || !data?.ok) {
            document.querySelectorAll('.pg-btn').forEach(b => { b.disabled = false; });
            alert(data?.error || 'No se pudo registrar tu respuesta. Inténtalo de nuevo.');
            return;
        }

        const { data: nuevo } = await db.rpc('fn_presupuesto_publico', { p_token: token });
        if (nuevo?.ok) _d = nuevo.presupuesto;
        pintar(respuesta === 'aprobado'
            ? '<div class="pg-aviso ok">¡Listo! Aprobaste el presupuesto. El taller ya fue avisado.</div>'
            : '<div class="pg-aviso mal">Registramos tu rechazo. El taller ya fue avisado.</div>');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    cargar();
})();
