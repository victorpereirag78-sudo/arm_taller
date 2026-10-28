// ================================================================
// presupuesto-publico.js — Página que abre el cliente desde el enlace
// ================================================================
// presupuesto.html?t=<token>. Sin login: el token (128 bits, sql/44) es la
// llave. Muestra el presupuesto completo y deja aprobarlo (con firma en
// línea, sql/49) o rechazarlo.
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
                <div id="pg-firma-caja" style="display:none">
                    <label>Firma con el dedo en el recuadro</label>
                    <canvas id="pg-firma" class="pg-firma-lienzo"></canvas>
                    <button class="pg-link" id="pg-firma-borrar" type="button">Borrar y firmar de nuevo</button>
                </div>
                <div id="pg-rechazo" style="display:none">
                    <label for="pg-motivo">Motivo (opcional)</label>
                    <textarea id="pg-motivo" rows="2" maxlength="300"
                        placeholder="Ej: el precio es alto, lo voy a pensar…"></textarea>
                </div>
                <div class="pg-barra" style="margin-top:0">
                    <button class="pg-btn mal" id="pg-rechazar">Rechazar</button>
                    <button class="pg-btn ok" id="pg-aprobar">✓ Aprobar y firmar</button>
                </div>
            </div>
            ${botones}`;

        document.getElementById('pg-imprimir').addEventListener('click', () => window.print());

        document.getElementById('pg-aprobar').addEventListener('click', () => {
            const caja = document.getElementById('pg-firma-caja');
            if (caja.style.display === 'none') {
                // Primer toque: aparece el recuadro de firma
                document.getElementById('pg-rechazo').style.display = 'none';
                document.getElementById('pg-rechazar').textContent = 'Rechazar';
                caja.style.display = 'block';
                _iniciarFirma(document.getElementById('pg-firma'));
                document.getElementById('pg-aprobar').textContent = '✓ Confirmar aprobación';
                caja.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
            responder('aprobado');
        });
        document.getElementById('pg-firma-borrar').addEventListener('click',
            () => _iniciarFirma(document.getElementById('pg-firma')));

        document.getElementById('pg-rechazar').addEventListener('click', () => {
            const caja = document.getElementById('pg-rechazo');
            if (caja.style.display === 'none') {
                caja.style.display = 'block';
                document.getElementById('pg-firma-caja').style.display = 'none';
                document.getElementById('pg-aprobar').textContent = '✓ Aprobar y firmar';
                document.getElementById('pg-rechazar').textContent = 'Confirmar rechazo';
                return;
            }
            responder('rechazado');
        });
    }

    // ── Firma en línea ────────────────────────────────────────────
    let _trazos = 0;     // largo dibujado: para no aceptar un recuadro vacío

    /** Deja el lienzo en blanco y listo para dibujar (táctil y mouse). */
    function _iniciarFirma(c) {
        const r = c.getBoundingClientRect();
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
        c.width = Math.round(r.width * dpr);
        c.height = Math.round(r.height * dpr);
        const g = c.getContext('2d');
        g.scale(dpr, dpr);
        g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = '#111'; g.fillStyle = '#111';
        _trazos = 0;

        let dibujando = false, ux = 0, uy = 0;
        const punto = (e) => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

        c.onpointerdown = (e) => {
            e.preventDefault();
            c.setPointerCapture?.(e.pointerId);
            dibujando = true;
            [ux, uy] = punto(e);
            g.beginPath(); g.arc(ux, uy, 1.2, 0, Math.PI * 2); g.fill();   // un toque suelto deja un punto
        };
        c.onpointermove = (e) => {
            if (!dibujando) return;
            e.preventDefault();
            const [x, y] = punto(e);
            g.beginPath(); g.moveTo(ux, uy); g.lineTo(x, y); g.stroke();
            _trazos += Math.hypot(x - ux, y - uy);
            ux = x; uy = y;
        };
        const fin = () => { dibujando = false; };
        c.onpointerup = fin; c.onpointercancel = fin;
    }

    /** PNG chico (máx. 480 px de ancho) con fondo transparente. */
    function _firmaPng(c) {
        const ancho = Math.min(480, c.width);
        const alto = Math.round(c.height * ancho / c.width);
        const o = document.createElement('canvas');
        o.width = ancho; o.height = alto;
        o.getContext('2d').drawImage(c, 0, 0, ancho, alto);
        return o.toDataURL('image/png');
    }

    async function responder(respuesta) {
        const nombre = document.getElementById('pg-nombre').value.trim();
        if (!nombre) { document.getElementById('pg-nombre').focus(); return; }

        let firma = null;
        if (respuesta === 'aprobado') {
            if (_trazos < 40) { alert('Firma en el recuadro antes de aprobar.'); return; }
            firma = _firmaPng(document.getElementById('pg-firma'));
        }

        const total = Number(_d.total || 0).toLocaleString('es-CL');
        const pregunta = respuesta === 'aprobado'
            ? `¿Aprobar el presupuesto N°${_d.numero} por $${total}?`
            : `¿Rechazar el presupuesto N°${_d.numero}?`;
        if (!confirm(pregunta)) return;

        document.querySelectorAll('.pg-btn').forEach(b => { b.disabled = true; });

        const { data, error } = await db.rpc('fn_presupuesto_publico_responder', {
            p_token: token, p_respuesta: respuesta, p_por: nombre,
            p_motivo: respuesta === 'rechazado' ? (document.getElementById('pg-motivo')?.value || null) : null,
            p_firma: firma
        });

        if (error || !data?.ok) {
            document.querySelectorAll('.pg-btn').forEach(b => { b.disabled = false; });
            alert(data?.error || 'No se pudo registrar tu respuesta. Inténtalo de nuevo.');
            return;
        }

        const { data: nuevo } = await db.rpc('fn_presupuesto_publico', { p_token: token });
        if (nuevo?.ok) _d = nuevo.presupuesto;
        pintar(respuesta === 'aprobado'
            ? '<div class="pg-aviso ok">¡Listo! Aprobaste y firmaste el presupuesto. El taller ya fue avisado' +
              (data.convertido ? ' y tu vehículo quedó ingresado.' : '.') + '</div>'
            : '<div class="pg-aviso mal">Registramos tu rechazo. El taller ya fue avisado.</div>');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    cargar();
})();
