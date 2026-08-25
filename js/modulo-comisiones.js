// ================================================================
// modulo-comisiones.js — Liquidación mensual de comisiones
// ================================================================
// Flujo: generar (borrador) → revisar el detalle → aprobar → pagar.
//
// Regenerar un periodo NO toca las liquidaciones ya aprobadas o
// pagadas: una vez que se le dijo a alguien cuánto se le va a pagar,
// esa cifra no cambia sola. Ver sql/04_empleados_comisiones.sql.
// ================================================================

const ModuloComisiones = (() => {

    let _periodo      = _periodoActual();
    let _liquidaciones = [];
    let _empleados     = [];
    let _soloCobrado   = false;

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-comisiones');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <input class="tll-input" id="com-periodo" type="month" value="${_periodo}"
                       style="max-width:180px">
                <button class="tll-btn tll-btn--primary" id="com-generar">Calcular comisiones</button>
                <label class="tll-check">
                    <input type="checkbox" id="com-cobrado"> Solo lo ya cobrado
                </label>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="com-reload">↻ Actualizar</button>
            </div>
            <div class="tll-field-msg" id="com-nota" style="margin-bottom:1rem"></div>
            <div class="tll-kpis" id="com-kpis"></div>
            <div id="com-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('com-periodo').addEventListener('change', (e) => {
            _periodo = e.target.value || _periodoActual();
            recargar();
        });
        document.getElementById('com-cobrado').addEventListener('change', (e) => {
            _soloCobrado = e.target.checked;
            _renderNota();
        });
        document.getElementById('com-generar').addEventListener('click', _generar);
        document.getElementById('com-reload').addEventListener('click', recargar);

        _renderNota();
        await recargar();
    }

    function _renderNota() {
        const el = document.getElementById('com-nota');
        if (!el) return;
        el.textContent = _soloCobrado
            ? 'Solo comisiona lo cobrado: las órdenes entregadas con saldo pendiente quedan fuera.'
            : 'Comisiona todo lo entregado y vendido en el periodo, esté cobrado o no.';
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [lRes, eRes] = await Promise.all([
                db.from('taller_liquidaciones').select('*')
                  .eq('empresa_id', eid).eq('periodo', _periodo),
                db.from('taller_empleados').select('id, nombre, cargo, rut')
                  .eq('empresa_id', eid)
            ]);

            if (lRes.error) throw lRes.error;
            _liquidaciones = lRes.data || [];
            _empleados     = eRes.data || [];
            _render();
        } catch (err) {
            console.error('[Comisiones] cargar:', err);
            const cont = document.getElementById('com-lista');
            if (cont) {
                cont.innerHTML = errorCarga(err, '04_empleados_comisiones.sql', 'las comisiones');
            }
        }
    }

    // ── Render ────────────────────────────────────────────────────
    function _render() {
        const kpis = document.getElementById('com-kpis');
        const cont = document.getElementById('com-lista');
        if (!cont || !kpis) return;

        const total     = _liquidaciones.reduce((s, l) => s + _num(l.total_comision), 0);
        const pagado    = _liquidaciones.filter(l => l.estado === 'pagada')
                                        .reduce((s, l) => s + _num(l.total_comision), 0);
        const conMonto  = _liquidaciones.filter(l => _num(l.total_comision) > 0);

        kpis.innerHTML = `
            ${_kpi('💰', fmtCLP(total), 'Comisiones del periodo')}
            ${_kpi('✅', fmtCLP(pagado), 'Ya pagado')}
            ${_kpi('⏳', fmtCLP(total - pagado), 'Por pagar')}
            ${_kpi('👷', conMonto.length, 'Empleados con comisión')}`;

        if (_liquidaciones.length === 0) {
            cont.innerHTML = `<div class="placeholder-text" style="padding:2rem 1rem">
                No hay liquidaciones para <strong>${esc(_periodo)}</strong>.<br>
                Presiona <strong>Calcular comisiones</strong> para generarlas.
                <div style="margin-top:0.6rem;font-size:0.78rem;color:var(--text-muted)">
                    Necesitas empleados con reglas de comisión activas (módulo <strong>Empleados</strong>)
                    y órdenes entregadas o ventas en el periodo.
                </div>
            </div>`;
            return;
        }

        const nombre = (id) => _empleados.find(e => e.id === id)?.nombre || '—';

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Empleado</th>
                <th style="text-align:right">Base</th>
                <th style="text-align:right">Comisión</th>
                <th>Estado</th><th>Generada</th><th></th>
            </tr></thead>
            <tbody>
            ${_liquidaciones
                .slice()
                .sort((a, b) => _num(b.total_comision) - _num(a.total_comision))
                .map(l => `
                <tr${_num(l.total_comision) > 0 ? '' : ' style="opacity:0.45"'}>
                    <td><strong>${esc(nombre(l.empleado_id))}</strong>
                        ${l.solo_cobrado ? '<div style="font-size:0.68rem;color:var(--text-muted)">solo cobrado</div>' : ''}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(l.total_base)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        <strong style="color:var(--accent)">${fmtCLP(l.total_comision)}</strong></td>
                    <td><span class="tll-badge ${_badge(l.estado)}">${esc(l.estado)}</span></td>
                    <td>${fmtFechaHora(l.generada_at)}</td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="tll-btn tll-btn--ghost com-detalle" data-id="${l.id}">Detalle</button>
                        ${l.estado === 'borrador' && _num(l.total_comision) > 0
                            ? `<button class="tll-btn tll-btn--ghost com-aprobar" data-id="${l.id}">Aprobar</button>` : ''}
                        ${l.estado === 'aprobada'
                            ? `<button class="tll-btn tll-btn--primary com-pagar" data-id="${l.id}">Pagar</button>` : ''}
                    </td>
                </tr>`).join('')}
            </tbody>
            <tfoot><tr>
                <td style="text-align:right"><strong>Total</strong></td>
                <td style="text-align:right;font-family:var(--font-mono)">
                    ${fmtCLP(_liquidaciones.reduce((s, l) => s + _num(l.total_base), 0))}</td>
                <td style="text-align:right;font-family:var(--font-mono)">
                    <strong style="color:var(--accent)">${fmtCLP(total)}</strong></td>
                <td colspan="3"></td>
            </tr></tfoot>
        </table>`;

        const porId = (b) => _liquidaciones.find(l => l.id === b.dataset.id);
        cont.querySelectorAll('.com-detalle').forEach(b =>
            b.addEventListener('click', () => _verDetalle(porId(b), nombre(porId(b)?.empleado_id))));
        cont.querySelectorAll('.com-aprobar').forEach(b =>
            b.addEventListener('click', () => _aprobar(porId(b), nombre(porId(b)?.empleado_id))));
        cont.querySelectorAll('.com-pagar').forEach(b =>
            b.addEventListener('click', () => _pagar(porId(b), nombre(porId(b)?.empleado_id))));
    }

    // ── Generar ───────────────────────────────────────────────────
    async function _generar() {
        const aprobadas = _liquidaciones.filter(l => l.estado !== 'borrador').length;

        let msg = `Calcular las comisiones de ${_periodo}.`;
        if (aprobadas > 0) {
            msg += `\n\n${aprobadas} liquidación(es) ya aprobada(s) o pagada(s) NO se tocarán.`;
        }
        if (!confirm(msg + '\n\n¿Continuar?')) return;

        const btn = document.getElementById('com-generar');
        btn.disabled = true;
        btn.textContent = 'Calculando…';

        try {
            const { data, error } = await db.rpc('fn_generar_comisiones', {
                p_empresa_id:   window.appData.usuario.empresa_id,
                p_periodo:      _periodo,
                p_solo_cobrado: _soloCobrado,
                p_usuario:      window.appData.usuario.rut
            });

            if (error) {
                if (error.code === 'PGRST202' || error.code === '42883') {
                    avisar('Falta ejecutar sql/04_empleados_comisiones.sql en Supabase', 'error');
                } else throw error;
                return;
            }
            if (!data?.ok) { avisar(data?.error || 'No se pudieron calcular', 'error'); return; }

            if (data.reglas_aplicadas === 0) {
                avisar('No hay reglas de comisión activas. Créalas en Empleados.', 'error');
            } else {
                avisar(`Comisiones calculadas · ${fmtCLP(data.total_comisiones)}` +
                       (data.liquidaciones_protegidas
                           ? ` · ${data.liquidaciones_protegidas} protegida(s)` : ''));
            }
            await recargar();

        } catch (err) {
            console.error('[Comisiones] generar:', err);
            avisar('Error al calcular las comisiones', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Calcular comisiones';
        }
    }

    // ── Detalle ───────────────────────────────────────────────────
    async function _verDetalle(liq, nombre) {
        if (!liq) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${esc(nombre)} · ${esc(liq.periodo)}
                <span class="tll-badge ${_badge(liq.estado)}" style="margin-left:0.5rem">${esc(liq.estado)}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="com-d-body"><div class="placeholder-text">Cargando detalle…</div></div>`, '820px');

        try {
            const { data: det, error } = await db.from('taller_liquidaciones_detalle')
                .select('*')
                .eq('liquidacion_id', liq.id)
                .order('fecha');
            if (error) throw error;

            const body = document.getElementById('com-d-body');
            if (!body) return;

            if (!det || det.length === 0) {
                body.innerHTML = `<div class="placeholder-text">
                    Sin documentos que comisionen en este periodo.</div>`;
                return;
            }

            body.innerHTML = `
            <table class="tll-tabla">
                <thead><tr>
                    <th>Documento</th><th>Fecha</th><th>Regla</th>
                    <th style="text-align:right">Base</th>
                    <th style="text-align:right">%</th>
                    <th style="text-align:right">Comisión</th>
                </tr></thead>
                <tbody>
                ${det.map(d => `
                    <tr>
                        <td style="font-family:var(--font-mono)">
                            ${d.origen === 'orden' ? '🛠' : '🧾'} ${esc(d.documento_numero)}</td>
                        <td>${fmtFecha(d.fecha)}</td>
                        <td>${esc(d.descripcion)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(d.base)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${d.porcentaje}%</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(d.comision)}</td>
                    </tr>`).join('')}
                </tbody>
                <tfoot><tr>
                    <td colspan="3" style="text-align:right"><strong>Total</strong></td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(liq.total_base)}</td>
                    <td></td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        <strong style="color:var(--accent)">${fmtCLP(liq.total_comision)}</strong></td>
                </tr></tfoot>
            </table>`;
        } catch (err) {
            console.error('[Comisiones] detalle:', err);
            const body = document.getElementById('com-d-body');
            if (body) body.innerHTML = `<div class="placeholder-text">Error cargando el detalle.</div>`;
        }
    }

    // ── Aprobar / pagar ───────────────────────────────────────────
    async function _aprobar(liq, nombre) {
        if (!liq) return;
        if (!confirm(
            `Aprobar la comisión de ${nombre} por ${fmtCLP(liq.total_comision)}.\n\n` +
            `Después de aprobarla, recalcular el periodo ya no la modificará.\n\n¿Continuar?`)) return;

        const res = await _rpc('fn_aprobar_liquidacion', {
            p_empresa_id: window.appData.usuario.empresa_id,
            p_liquidacion_id: liq.id,
            p_usuario: window.appData.usuario.rut
        });
        if (!res) return;
        if (!res.ok) { avisar(res.error || 'No se pudo aprobar', 'error'); return; }

        avisar('Liquidación aprobada');
        await recargar();
    }

    async function _pagar(liq, nombre) {
        if (!liq) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Pagar comisión · ${esc(nombre)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            Periodo <strong>${esc(liq.periodo)}</strong> ·
            monto <strong>${fmtCLP(liq.total_comision)}</strong><br>
            Queda registrado como egreso en la caja abierta.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Medio de pago</label>
                <select class="tll-select" id="com-p-medio">
                    ${['efectivo', 'transferencia', 'cheque', 'otro']
                        .map(m => `<option value="${m}">${m}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="com-p-ok">Registrar pago</button>
        </div>`, '480px');

        document.getElementById('com-p-ok').addEventListener('click', async () => {
            const btn = document.getElementById('com-p-ok');
            btn.disabled = true;

            const res = await _rpc('fn_pagar_liquidacion', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_liquidacion_id: liq.id,
                p_medio_pago: document.getElementById('com-p-medio').value,
                p_caja_id: null,
                p_usuario: window.appData.usuario.rut
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo pagar', 'error'); btn.disabled = false; return; }

            avisar(`Comisión pagada · ${fmtCLP(res.monto)}`);
            cerrarModal();
            await recargar();
        });
    }

    // ── Helpers ───────────────────────────────────────────────────
    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Comisiones] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/04_empleados_comisiones.sql (${nombre})`
                : 'Error en la operación. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _badge(estado) {
        return { borrador: 'diagnostico', aprobada: 'aprobada', pagada: 'lista' }[estado] || 'entregada';
    }

    function _periodoActual() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function _kpi(icono, valor, label) {
        return `
        <div class="tll-kpi">
            <span class="tll-kpi-icono">${icono}</span>
            <div class="tll-kpi-valor" style="font-size:1.5rem">${valor}</div>
            <div class="tll-kpi-label">${label}</div>
        </div>`;
    }

    return { init, recargar };

})();
