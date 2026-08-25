// ================================================================
// modulo-caja.js — Caja diaria y pagos de clientes
// ================================================================
// Una caja es un TURNO: se abre con un fondo, recibe movimientos y
// se cierra contando la plata. El arqueo compara lo contado contra
// lo teórico, y solo cuenta EFECTIVO: las tarjetas y transferencias
// se registran pero no están en el cajón.
//
// Aquí también se cobran las órdenes de trabajo (total o en abonos).
// Ver sql/03_ventas_caja.sql.
// ================================================================

const ModuloCaja = (() => {

    let _caja       = null;   // caja abierta o null
    let _movs       = [];     // movimientos del turno
    let _pendientes = [];     // órdenes con saldo por cobrar

    const MEDIOS = ['efectivo', 'debito', 'credito', 'transferencia', 'cheque', 'otro'];

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-caja');
        if (!cont) return;
        cont.innerHTML = `<div class="placeholder-text">Cargando caja…</div>`;
        await recargar();
    }

    async function recargar() {
        const cont = document.getElementById('contenido-caja');
        if (!cont) return;

        try {
            const eid = window.appData.usuario.empresa_id;

            const { data, error } = await db.from('taller_cajas')
                .select('*')
                .eq('empresa_id', eid)
                .eq('estado', 'abierta')
                .limit(1);
            if (error) throw error;

            _caja = data?.[0] || null;

            if (_caja) {
                const { data: movs, error: errM } = await db.from('taller_movimientos_caja')
                    .select('*')
                    .eq('caja_id', _caja.id)
                    .order('created_at', { ascending: false })
                    .limit(500);
                if (errM) throw errM;
                _movs = movs || [];
            } else {
                _movs = [];
            }

            await _cargarPendientes();
            _render();

        } catch (err) {
            console.error('[Caja] cargar:', err);
            cont.innerHTML = errorCarga(err, '03_ventas_caja.sql', 'la caja');
        }
    }

    async function _cargarPendientes() {
        try {
            const { data, error } = await db.from('v_taller_ordenes_saldo')
                .select('*')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .gt('saldo', 0)
                .order('numero', { ascending: false })
                .limit(100);
            if (error) throw error;
            _pendientes = data || [];
        } catch (err) {
            console.warn('[Caja] órdenes pendientes:', err);
            _pendientes = [];
        }
    }

    // ── Render ────────────────────────────────────────────────────
    function _render() {
        const cont = document.getElementById('contenido-caja');
        if (!cont) return;

        if (!_caja) {
            cont.innerHTML = `
                <div class="placeholder-text" style="padding:2.5rem 1rem">
                    <div style="font-size:2rem;margin-bottom:0.5rem">💵</div>
                    <strong>No hay caja abierta</strong><br>
                    Abre el turno con el fondo inicial para empezar a registrar movimientos.
                    <div style="margin-top:1rem">
                        <button class="tll-btn tll-btn--primary" id="caja-abrir">Abrir caja</button>
                    </div>
                </div>
                <div class="panel-header" style="margin-top:1.5rem">
                    <h2 style="font-size:1rem">Turnos anteriores</h2>
                </div>
                <div id="caja-historial" class="tll-tabla-wrap"></div>`;

            document.getElementById('caja-abrir').addEventListener('click', _abrirCaja);
            _cargarHistorialCajas();
            return;
        }

        const t = _totales();

        cont.innerHTML = `
            <div class="tll-kpis">
                ${_kpi('💵', fmtCLP(t.efectivo), 'Efectivo en caja')}
                ${_kpi('💳', fmtCLP(t.tarjetas), 'Tarjetas y transferencias')}
                ${_kpi('📥', fmtCLP(t.ingresos), 'Ingresos del turno')}
                ${_kpi('📤', fmtCLP(t.egresos), 'Egresos del turno')}
            </div>

            <div class="tll-recep-found" style="margin-bottom:1rem">
                Caja N° <strong>${esc(_caja.numero)}</strong> abierta el
                ${fmtFechaHora(_caja.fecha_apertura)} por ${esc(_caja.usuario_apertura) || '—'}
                · fondo inicial ${fmtCLP(_caja.monto_inicial)}
            </div>

            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="caja-cobrar-ot">💰 Cobrar orden</button>
                <button class="tll-btn tll-btn--ghost" id="caja-ingreso">+ Ingreso</button>
                <button class="tll-btn tll-btn--ghost" id="caja-egreso">− Egreso</button>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="caja-reload">↻ Actualizar</button>
                <button class="tll-btn tll-btn--danger" id="caja-cerrar">Cerrar caja</button>
            </div>

            ${_pendientes.length ? `
            <div class="tll-recep-notfound" style="margin-bottom:1rem">
                <strong>${_pendientes.length}</strong>
                ${_pendientes.length === 1 ? 'orden pendiente' : 'órdenes pendientes'} de cobro
                por ${fmtCLP(_pendientes.reduce((s, o) => s + _num(o.saldo), 0))}.
            </div>` : ''}

            <div class="panel-header" style="margin-bottom:0.6rem">
                <h2 style="font-size:1rem">Movimientos del turno</h2>
            </div>
            <div id="caja-movs" class="tll-tabla-wrap"></div>`;

        document.getElementById('caja-cobrar-ot').addEventListener('click', _abrirCobroOrden);
        document.getElementById('caja-ingreso').addEventListener('click', () => _abrirMovimiento('ingreso'));
        document.getElementById('caja-egreso').addEventListener('click', () => _abrirMovimiento('egreso'));
        document.getElementById('caja-reload').addEventListener('click', recargar);
        document.getElementById('caja-cerrar').addEventListener('click', _cerrarCaja);

        _renderMovimientos();
    }

    function _renderMovimientos() {
        const cont = document.getElementById('caja-movs');
        if (!cont) return;

        if (_movs.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                Sin movimientos en este turno todavía.</div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Hora</th><th>Motivo</th><th>Detalle</th><th>Medio</th>
                <th style="text-align:right">Monto</th><th>Usuario</th>
            </tr></thead>
            <tbody>
            ${_movs.map(m => `
                <tr>
                    <td style="white-space:nowrap">${fmtFechaHora(m.created_at).split(' ')[1] || '—'}</td>
                    <td><span class="tll-badge ${m.tipo === 'ingreso' ? 'lista' : 'reparacion'}">
                        ${esc(m.motivo)}</span></td>
                    <td>${esc(m.descripcion) || esc(m.referencia) || '—'}</td>
                    <td>${esc(m.medio_pago)}</td>
                    <td style="text-align:right;font-family:var(--font-mono);
                               color:${m.tipo === 'ingreso' ? '#34d399' : '#f87171'}">
                        ${m.tipo === 'ingreso' ? '+' : '−'}${fmtCLP(m.monto)}</td>
                    <td style="font-family:var(--font-mono);font-size:0.75rem">${esc(m.usuario_rut) || '—'}</td>
                </tr>`).join('')}
            </tbody>
        </table>`;
    }

    // ── Abrir caja ────────────────────────────────────────────────
    function _abrirCaja() {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Abrir caja</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Fondo inicial (efectivo con el que parte el turno)</label>
                <input class="tll-input" id="caja-a-monto" type="number" min="0" value="0" autofocus>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="caja-a-ok">Abrir turno</button>
        </div>`, '440px');

        document.getElementById('caja-a-ok').addEventListener('click', async () => {
            const btn = document.getElementById('caja-a-ok');
            btn.disabled = true;

            const res = await _rpc('fn_abrir_caja', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_monto_inicial: _num(document.getElementById('caja-a-monto').value),
                p_usuario: window.appData.usuario.rut
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo abrir la caja', 'error'); btn.disabled = false; return; }

            avisar(`Caja N° ${res.numero} abierta`);
            cerrarModal();
            await recargar();
        });
    }

    // ── Cerrar caja (arqueo) ──────────────────────────────────────
    function _cerrarCaja() {
        const t = _totales();

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Cerrar caja N° ${esc(_caja.numero)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            Cuenta el efectivo del cajón y anótalo. El sistema no te muestra
            el teórico antes para que el conteo sea real.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Efectivo contado *</label>
                <input class="tll-input" id="caja-c-monto" type="number" min="0" value="" autofocus
                       style="font-size:1.1rem">
            </div>
            <div class="tll-field tll-field--full">
                <label>Observación</label>
                <textarea class="tll-textarea" id="caja-c-obs"
                    placeholder="Ej: faltan $2.000, se pagó un flete sin boleta"></textarea>
            </div>
            <div class="tll-field tll-field--full">
                <div class="tll-recep-found" id="caja-c-preview" style="display:none"></div>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--ghost" id="caja-c-verificar">Verificar</button>
            <button class="tll-btn tll-btn--primary" id="caja-c-ok">Cerrar turno</button>
        </div>`, '520px');

        // Verificar muestra la diferencia ANTES de cerrar, para poder corregir
        document.getElementById('caja-c-verificar').addEventListener('click', () => {
            const contado = _num(document.getElementById('caja-c-monto').value);
            const dif = contado - t.efectivo;
            const el = document.getElementById('caja-c-preview');
            el.style.display = '';
            el.innerHTML = dif === 0
                ? `Cuadra exacto: ${fmtCLP(t.efectivo)}.`
                : dif > 0
                    ? `Sobran <strong>${fmtCLP(dif)}</strong> (teórico ${fmtCLP(t.efectivo)}).`
                    : `Faltan <strong>${fmtCLP(-dif)}</strong> (teórico ${fmtCLP(t.efectivo)}).`;
        });

        document.getElementById('caja-c-ok').addEventListener('click', async () => {
            const raw = document.getElementById('caja-c-monto').value.trim();
            if (raw === '') { avisar('Ingresa el efectivo contado', 'error'); return; }

            const contado = _num(raw);
            const dif = contado - t.efectivo;

            if (dif !== 0 && !confirm(
                `El turno queda con una diferencia de ${fmtCLP(Math.abs(dif))} ` +
                `(${dif > 0 ? 'sobrante' : 'faltante'}).\n\n¿Cerrar igual?`)) return;

            const btn = document.getElementById('caja-c-ok');
            btn.disabled = true;

            const res = await _rpc('fn_cerrar_caja', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_caja_id: _caja.id,
                p_efectivo_contado: contado,
                p_observacion: document.getElementById('caja-c-obs').value.trim() || null,
                p_usuario: window.appData.usuario.rut
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo cerrar', 'error'); btn.disabled = false; return; }

            avisar(res.diferencia === 0
                ? 'Caja cerrada y cuadrada'
                : `Caja cerrada con ${res.diferencia > 0 ? 'sobrante' : 'faltante'} de ${fmtCLP(Math.abs(res.diferencia))}`);
            cerrarModal();
            await recargar();
        });
    }

    // ── Cobro de una orden de trabajo ─────────────────────────────
    function _abrirCobroOrden() {
        if (_pendientes.length === 0) {
            avisar('No hay órdenes con saldo pendiente', 'error');
            return;
        }

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Cobrar orden de trabajo</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Orden *</label>
                <select class="tll-select" id="caja-o-orden">
                    <option value="">— Selecciona —</option>
                    ${_pendientes.map(o => `
                        <option value="${o.orden_id}" data-saldo="${o.saldo}" data-total="${o.total}">
                            OT ${esc(o.numero)} · ${esc(o.estado)} · saldo ${fmtCLP(o.saldo)}
                        </option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Monto a cobrar *</label>
                <input class="tll-input" id="caja-o-monto" type="number" min="0" value="0">
            </div>
            <div class="tll-field">
                <label>Medio de pago</label>
                <select class="tll-select" id="caja-o-medio">
                    ${MEDIOS.map(m => `<option value="${m}">${m}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <div class="tll-recep-found" id="caja-o-info" style="display:none"></div>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="caja-o-ok">Registrar pago</button>
        </div>`, '560px');

        // Al elegir la orden, precargar el saldo completo (el caso normal)
        document.getElementById('caja-o-orden').addEventListener('change', (e) => {
            const opt = e.target.selectedOptions[0];
            const saldo = _num(opt?.dataset.saldo);
            const total = _num(opt?.dataset.total);
            document.getElementById('caja-o-monto').value = saldo;

            const info = document.getElementById('caja-o-info');
            if (!opt?.value) { info.style.display = 'none'; return; }
            info.style.display = '';
            info.innerHTML = `Total de la orden ${fmtCLP(total)} · ya pagado ` +
                             `${fmtCLP(total - saldo)} · <strong>saldo ${fmtCLP(saldo)}</strong>. ` +
                             `Puedes cobrar menos y dejarla con abono.`;
        });

        document.getElementById('caja-o-ok').addEventListener('click', async () => {
            const ordenId = document.getElementById('caja-o-orden').value;
            if (!ordenId) { avisar('Selecciona la orden', 'error'); return; }

            const monto = _num(document.getElementById('caja-o-monto').value);
            if (monto <= 0) { avisar('El monto debe ser mayor que cero', 'error'); return; }

            const btn = document.getElementById('caja-o-ok');
            btn.disabled = true;

            const res = await _rpc('fn_registrar_pago_orden', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_orden_id: ordenId,
                p_monto: monto,
                p_medio_pago: document.getElementById('caja-o-medio').value,
                p_caja_id: _caja.id,
                p_usuario: window.appData.usuario.rut
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo registrar el pago', 'error'); btn.disabled = false; return; }

            avisar(res.saldo > 0
                ? `Abono registrado · queda un saldo de ${fmtCLP(res.saldo)}`
                : 'Orden pagada por completo');
            cerrarModal();
            await recargar();
        });
    }

    // ── Ingreso / egreso manual ───────────────────────────────────
    function _abrirMovimiento(tipo) {
        const esIngreso = tipo === 'ingreso';
        const motivos = esIngreso
            ? [['abono', 'Abono de cliente'], ['otro', 'Otro ingreso']]
            : [['gasto', 'Gasto del taller'], ['retiro', 'Retiro de efectivo'], ['otro', 'Otro egreso']];

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${esIngreso ? 'Registrar ingreso' : 'Registrar egreso'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Motivo</label>
                <select class="tll-select" id="caja-m-motivo">
                    ${motivos.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Medio</label>
                <select class="tll-select" id="caja-m-medio">
                    ${MEDIOS.map(m => `<option value="${m}">${m}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Monto *</label>
                <input class="tll-input" id="caja-m-monto" type="number" min="0" value="0">
            </div>
            <div class="tll-field">
                <label>Referencia</label>
                <input class="tll-input" id="caja-m-ref" style="font-family:var(--font-mono)"
                       placeholder="N° boleta / documento">
            </div>
            <div class="tll-field tll-field--full">
                <label>Descripción *</label>
                <input class="tll-input" id="caja-m-desc"
                       placeholder="${esIngreso ? 'Ej: abono de cliente por OT 120' : 'Ej: compra de guantes y trapos'}">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="caja-m-ok">Registrar</button>
        </div>`);

        document.getElementById('caja-m-ok').addEventListener('click', async () => {
            const monto = _num(document.getElementById('caja-m-monto').value);
            if (monto <= 0) { avisar('El monto debe ser mayor que cero', 'error'); return; }

            const desc = document.getElementById('caja-m-desc').value.trim();
            if (!desc) { avisar('Describe el movimiento', 'error'); return; }

            const btn = document.getElementById('caja-m-ok');
            btn.disabled = true;

            try {
                const { error } = await db.from('taller_movimientos_caja').insert({
                    empresa_id:  window.appData.usuario.empresa_id,
                    caja_id:     _caja.id,
                    tipo,
                    motivo:      document.getElementById('caja-m-motivo').value,
                    medio_pago:  document.getElementById('caja-m-medio').value,
                    monto,
                    referencia:  document.getElementById('caja-m-ref').value.trim() || null,
                    descripcion: desc,
                    usuario_rut: window.appData.usuario.rut
                });
                if (error) throw error;

                avisar(esIngreso ? 'Ingreso registrado' : 'Egreso registrado');
                cerrarModal();
                await recargar();
            } catch (err) {
                console.error('[Caja] movimiento:', err);
                btn.disabled = false;
                avisar('No se pudo registrar el movimiento', 'error');
            }
        });
    }

    // ── Historial de turnos cerrados ──────────────────────────────
    async function _cargarHistorialCajas() {
        const cont = document.getElementById('caja-historial');
        if (!cont) return;

        try {
            const { data, error } = await db.from('taller_cajas')
                .select('*')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .eq('estado', 'cerrada')
                .order('fecha_apertura', { ascending: false })
                .limit(30);
            if (error) throw error;

            if (!data || data.length === 0) {
                cont.innerHTML = `<div class="placeholder-text">Aún no hay turnos cerrados.</div>`;
                return;
            }

            cont.innerHTML = `
            <table class="tll-tabla">
                <thead><tr>
                    <th>N°</th><th>Apertura</th><th>Cierre</th><th>Cerró</th>
                    <th style="text-align:right">Teórico</th>
                    <th style="text-align:right">Contado</th>
                    <th style="text-align:right">Diferencia</th>
                </tr></thead>
                <tbody>
                ${data.map(c => {
                    const dif = _num(c.diferencia);
                    const color = dif === 0 ? '#34d399' : dif > 0 ? '#fbbf24' : '#f87171';
                    return `
                    <tr>
                        <td style="font-family:var(--font-mono)"><strong>${esc(c.numero)}</strong></td>
                        <td>${fmtFechaHora(c.fecha_apertura)}</td>
                        <td>${fmtFechaHora(c.fecha_cierre)}</td>
                        <td style="font-family:var(--font-mono);font-size:0.75rem">${esc(c.usuario_cierre) || '—'}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(c.efectivo_teorico)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(c.efectivo_contado)}</td>
                        <td style="text-align:right;font-family:var(--font-mono);color:${color}">
                            ${dif > 0 ? '+' : ''}${fmtCLP(dif)}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>`;
        } catch (err) {
            console.error('[Caja] historial:', err);
            cont.innerHTML = `<div class="placeholder-text">No se pudo cargar el historial.</div>`;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────

    /** Efectivo teórico = solo lo que está físicamente en el cajón. */
    function _totales() {
        let efectivo = 0, tarjetas = 0, ingresos = 0, egresos = 0;

        for (const m of _movs) {
            const monto = _num(m.monto);
            const signo = m.tipo === 'ingreso' ? 1 : -1;

            if (m.tipo === 'ingreso') ingresos += monto; else egresos += monto;
            if (m.medio_pago === 'efectivo') efectivo += signo * monto;
            else tarjetas += signo * monto;
        }
        return { efectivo, tarjetas, ingresos, egresos };
    }

    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Caja] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/03_ventas_caja.sql en Supabase (${nombre})`
                : 'Error en la operación de caja. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _faltaEsquema(error) {
        return error?.code === 'PGRST205' || error?.code === '42P01';
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
