// ================================================================
// modulo-cxp.js — Cuentas por pagar
// ================================================================
// Qué se le debe a cada proveedor, desde cuándo y cuánto está vencido.
// Los documentos nacen solos al recibir una compra, pero también se
// pueden cargar a mano (arriendo, luz, servicios).
//
// Pagar descuenta por la caja abierta, igual que cualquier egreso,
// para que el arqueo cuadre. Admite pagos parciales.
// Ver sql/05_compras_cxp.sql.
// ================================================================

const ModuloCxp = (() => {

    let _docs        = [];
    let _proveedores = [];
    let _filtro      = 'pendientes';

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-cxp');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-kpis" id="cxp-kpis"></div>
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="cxp-nuevo">+ Cargar documento</button>
                <select class="tll-select" id="cxp-filtro" style="max-width:200px">
                    <option value="pendientes">Con saldo pendiente</option>
                    <option value="vencidas">Solo vencidas</option>
                    <option value="pagadas">Pagadas</option>
                    <option value="todas">Todas</option>
                </select>
                <input class="tll-input" id="cxp-buscar" placeholder="Buscar por documento o proveedor…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="cxp-reload">↻ Actualizar</button>
            </div>
            <div id="cxp-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('cxp-nuevo').addEventListener('click', _abrirNuevo);
        document.getElementById('cxp-reload').addEventListener('click', recargar);
        document.getElementById('cxp-buscar').addEventListener('input', _renderLista);
        document.getElementById('cxp-filtro').addEventListener('change', (e) => {
            _filtro = e.target.value;
            _renderLista();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [dRes, pRes] = await Promise.all([
                db.from('v_taller_cxp_saldo').select('*')
                  .eq('empresa_id', eid).order('fecha_vencimiento').range(0, 2999),
                db.from('taller_proveedores').select('id, razon_social, condicion_pago, dias_credito')
                  .eq('empresa_id', eid).eq('activo', true).order('razon_social')
            ]);

            if (dRes.error) throw dRes.error;
            _docs        = dRes.data || [];
            _proveedores = pRes.data || [];
            _renderKpis();
            _renderLista();
        } catch (err) {
            console.error('[CxP] cargar:', err);
            const cont = document.getElementById('cxp-lista');
            if (cont) {
                cont.innerHTML = errorCarga(err, '05_compras_cxp.sql', 'las cuentas por pagar');
            }
        }
    }

    // ── KPIs: la foto de la deuda ─────────────────────────────────
    function _renderKpis() {
        const cont = document.getElementById('cxp-kpis');
        if (!cont) return;

        const pend    = _docs.filter(d => _num(d.saldo) > 0);
        const total   = pend.reduce((s, d) => s + _num(d.saldo), 0);
        const vencido = pend.filter(_vencida).reduce((s, d) => s + _num(d.saldo), 0);
        const semana  = pend.filter(d => _venceEnDias(d, 7)).reduce((s, d) => s + _num(d.saldo), 0);

        cont.innerHTML = `
            ${_kpi('📉', fmtCLP(total), 'Deuda total')}
            ${_kpi('🔴', fmtCLP(vencido), 'Vencido')}
            ${_kpi('📅', fmtCLP(semana), 'Vence esta semana')}
            ${_kpi('📄', pend.length, 'Documentos pendientes')}`;
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('cxp-lista');
        if (!cont) return;

        const q = (document.getElementById('cxp-buscar')?.value || '').toLowerCase().trim();
        const nombre = (id) => _proveedores.find(p => p.id === id)?.razon_social || '—';

        let lista = _docs.filter(d => {
            const saldo = _num(d.saldo);
            switch (_filtro) {
                case 'pendientes': return saldo > 0;
                case 'vencidas':   return saldo > 0 && _vencida(d);
                case 'pagadas':    return saldo <= 0;
                default:           return true;
            }
        });

        if (q) {
            lista = lista.filter(d =>
                (d.numero_documento || '').toLowerCase().includes(q) ||
                (d.descripcion || '').toLowerCase().includes(q) ||
                nombre(d.proveedor_id).toLowerCase().includes(q));
        }

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_docs.length === 0
                    ? 'Sin documentos por pagar. Se crean solos al recibir una compra, o cárgalos con <strong>+ Cargar documento</strong>.'
                    : 'Sin resultados para ese filtro.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Documento</th><th>Proveedor</th><th>Emisión</th><th>Vence</th>
                <th style="text-align:right">Total</th>
                <th style="text-align:right">Pagado</th>
                <th style="text-align:right">Saldo</th>
                <th>Situación</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(d => `
                <tr${_num(d.saldo) <= 0 ? ' style="opacity:0.5"' : ''}>
                    <td style="font-family:var(--font-mono)">
                        ${esc(d.numero_documento) || '—'}
                        <div style="font-size:0.68rem;color:var(--text-muted);font-family:var(--font-sans, inherit)">
                            ${esc(d.descripcion) || esc(d.tipo_documento)}</div></td>
                    <td>${esc(nombre(d.proveedor_id))}</td>
                    <td>${fmtFecha(d.fecha_emision)}</td>
                    <td>${fmtFecha(d.fecha_vencimiento)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(d.total)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(d.pagado)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        <strong${_num(d.saldo) > 0 ? '' : ' style="color:var(--text-muted)"'}>${fmtCLP(d.saldo)}</strong></td>
                    <td>${_badgeAntiguedad(d)}</td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="tll-btn tll-btn--ghost cxp-pagos" data-id="${d.cxp_id}">Pagos</button>
                        ${_num(d.saldo) > 0
                            ? `<button class="tll-btn tll-btn--primary cxp-pagar" data-id="${d.cxp_id}">Pagar</button>` : ''}
                    </td>
                </tr>`).join('')}
            </tbody>
            <tfoot><tr>
                <td colspan="6" style="text-align:right"><strong>Saldo mostrado</strong></td>
                <td style="text-align:right;font-family:var(--font-mono)">
                    <strong style="color:var(--accent)">
                        ${fmtCLP(lista.reduce((s, d) => s + Math.max(_num(d.saldo), 0), 0))}</strong></td>
                <td colspan="2"></td>
            </tr></tfoot>
        </table>`;

        const porId = (b) => _docs.find(d => d.cxp_id === b.dataset.id);
        cont.querySelectorAll('.cxp-pagar').forEach(b =>
            b.addEventListener('click', () => _abrirPago(porId(b), nombre(porId(b)?.proveedor_id))));
        cont.querySelectorAll('.cxp-pagos').forEach(b =>
            b.addEventListener('click', () => _verPagos(porId(b), nombre(porId(b)?.proveedor_id))));
    }

    // ── Cargar un documento a mano ────────────────────────────────
    function _abrirNuevo() {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Cargar documento por pagar</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.7rem 1rem;text-align:left">
            Para gastos que no vienen de una orden de compra: arriendo, servicios,
            fletes. Las compras de repuestos generan su documento solas al recibirlas.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Proveedor</label>
                <select class="tll-select" id="cxp-f-proveedor">
                    <option value="">— Sin proveedor —</option>
                    ${_proveedores.map(p => `
                        <option value="${p.id}" data-dias="${p.dias_credito}">${esc(p.razon_social)}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Tipo</label>
                <select class="tll-select" id="cxp-f-tipo">
                    ${[['factura','Factura'],['boleta','Boleta'],['gasto','Gasto'],['otro','Otro']]
                        .map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>N° de documento</label>
                <input class="tll-input" id="cxp-f-numero" style="font-family:var(--font-mono)">
            </div>
            <div class="tll-field tll-field--full">
                <label>Descripción *</label>
                <input class="tll-input" id="cxp-f-desc" placeholder="Ej: arriendo del local, agosto">
            </div>
            <div class="tll-field">
                <label>Fecha de emisión</label>
                <input class="tll-input" id="cxp-f-emision" type="date" value="${_hoy()}">
            </div>
            <div class="tll-field">
                <label>Fecha de vencimiento</label>
                <input class="tll-input" id="cxp-f-vence" type="date" value="${_hoy()}">
            </div>
            <div class="tll-field">
                <label>Monto total *</label>
                <input class="tll-input" id="cxp-f-total" type="number" min="0" value="0">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="cxp-f-ok">Cargar documento</button>
        </div>`, '660px');

        // Si el proveedor tiene días de crédito, precargar el vencimiento
        document.getElementById('cxp-f-proveedor').addEventListener('change', (e) => {
            const dias = Number(e.target.selectedOptions[0]?.dataset.dias) || 0;
            if (dias > 0) {
                const d = new Date();
                d.setDate(d.getDate() + dias);
                document.getElementById('cxp-f-vence').value =
                    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
        });

        document.getElementById('cxp-f-ok').addEventListener('click', async () => {
            const desc  = document.getElementById('cxp-f-desc').value.trim();
            const total = _num(document.getElementById('cxp-f-total').value);

            if (!desc) { avisar('Describe el documento', 'error'); return; }
            if (total <= 0) { avisar('El monto debe ser mayor que cero', 'error'); return; }

            const btn = document.getElementById('cxp-f-ok');
            btn.disabled = true;

            try {
                const { error } = await db.from('taller_cuentas_pagar').insert({
                    empresa_id:        window.appData.usuario.empresa_id,
                    proveedor_id:      document.getElementById('cxp-f-proveedor').value || null,
                    tipo_documento:    document.getElementById('cxp-f-tipo').value,
                    numero_documento:  document.getElementById('cxp-f-numero').value.trim() || null,
                    descripcion:       desc,
                    fecha_emision:     document.getElementById('cxp-f-emision').value || _hoy(),
                    fecha_vencimiento: document.getElementById('cxp-f-vence').value || null,
                    total,
                    usuario_rut:       window.appData.usuario.rut
                });
                if (error) throw error;

                avisar('Documento cargado');
                cerrarModal();
                await recargar();
            } catch (err) {
                console.error('[CxP] cargar:', err);
                btn.disabled = false;
                avisar('No se pudo cargar el documento', 'error');
            }
        });
    }

    // ── Pagar ─────────────────────────────────────────────────────
    function _abrirPago(doc, proveedor) {
        if (!doc) return;
        const saldo = _num(doc.saldo);

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Pagar a ${esc(proveedor)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            ${esc(doc.numero_documento) || esc(doc.descripcion) || 'Documento'} ·
            total ${fmtCLP(doc.total)} · ya pagado ${fmtCLP(doc.pagado)}<br>
            <strong>Saldo: ${fmtCLP(saldo)}</strong>
            ${_vencida(doc) ? ` · <span style="color:#f87171">vencido hace ${doc.dias_vencida} días</span>` : ''}
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Monto a pagar *</label>
                <input class="tll-input" id="cxp-p-monto" type="number" min="0" value="${saldo}">
                <span class="tll-field-msg">Puedes abonar menos y dejar saldo.</span>
            </div>
            <div class="tll-field">
                <label>Medio de pago</label>
                <select class="tll-select" id="cxp-p-medio">
                    ${['transferencia', 'efectivo', 'cheque', 'debito', 'credito', 'otro']
                        .map(m => `<option value="${m}">${m}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <label>Referencia</label>
                <input class="tll-input" id="cxp-p-ref" style="font-family:var(--font-mono)"
                       placeholder="N° de transferencia o cheque">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="cxp-p-ok">Registrar pago</button>
        </div>`, '560px');

        document.getElementById('cxp-p-ok').addEventListener('click', async () => {
            const monto = _num(document.getElementById('cxp-p-monto').value);
            if (monto <= 0) { avisar('El monto debe ser mayor que cero', 'error'); return; }

            const btn = document.getElementById('cxp-p-ok');
            btn.disabled = true;

            const res = await _rpc('fn_pagar_cuenta', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_cxp_id: doc.cxp_id,
                p_monto: monto,
                p_medio_pago: document.getElementById('cxp-p-medio').value,
                p_caja_id: null,
                p_referencia: document.getElementById('cxp-p-ref').value.trim() || null,
                p_usuario: window.appData.usuario.rut
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo pagar', 'error'); btn.disabled = false; return; }

            avisar(res.saldo > 0
                ? `Abono registrado · queda un saldo de ${fmtCLP(res.saldo)}`
                : 'Documento pagado por completo');
            cerrarModal();
            await recargar();
        });
    }

    // ── Historial de pagos ────────────────────────────────────────
    async function _verPagos(doc, proveedor) {
        if (!doc) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Pagos · ${esc(doc.numero_documento) || esc(doc.descripcion) || 'Documento'}
                <span style="color:var(--text-secondary);font-weight:400;font-size:0.85rem">
                    ${esc(proveedor)}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="cxp-h-body"><div class="placeholder-text">Cargando…</div></div>`, '700px');

        try {
            const { data: pagos, error } = await db.from('taller_movimientos_caja')
                .select('*')
                .eq('cxp_id', doc.cxp_id)
                .eq('motivo', 'proveedor')
                .order('created_at', { ascending: false });
            if (error) throw error;

            const body = document.getElementById('cxp-h-body');
            if (!body) return;

            if (!pagos || pagos.length === 0) {
                body.innerHTML = `<div class="placeholder-text">
                    Este documento todavía no tiene pagos registrados.</div>`;
                return;
            }

            body.innerHTML = `
            <table class="tll-tabla">
                <thead><tr>
                    <th>Fecha</th><th>Medio</th><th>Referencia</th>
                    <th style="text-align:right">Monto</th><th>Usuario</th>
                </tr></thead>
                <tbody>
                ${pagos.map(p => `
                    <tr>
                        <td>${fmtFechaHora(p.created_at)}</td>
                        <td>${esc(p.medio_pago)}</td>
                        <td style="font-family:var(--font-mono);font-size:0.78rem">${esc(p.referencia) || '—'}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(p.monto)}</td>
                        <td style="font-family:var(--font-mono);font-size:0.75rem">${esc(p.usuario_rut) || '—'}</td>
                    </tr>`).join('')}
                </tbody>
                <tfoot><tr>
                    <td colspan="3" style="text-align:right"><strong>Total pagado</strong></td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        <strong>${fmtCLP(doc.pagado)}</strong></td>
                    <td></td>
                </tr></tfoot>
            </table>`;
        } catch (err) {
            console.error('[CxP] pagos:', err);
            const body = document.getElementById('cxp-h-body');
            if (body) body.innerHTML = `<div class="placeholder-text">Error cargando los pagos.</div>`;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _vencida(d) {
        return String(d.antiguedad || '').startsWith('vencida');
    }

    function _venceEnDias(d, dias) {
        if (!d.fecha_vencimiento) return false;
        const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
        const limite = new Date(hoy); limite.setDate(limite.getDate() + dias);
        const [a, m, dd] = String(d.fecha_vencimiento).split('-').map(Number);
        const venc = new Date(a, m - 1, dd);
        return venc >= hoy && venc <= limite;
    }

    function _badgeAntiguedad(d) {
        if (_num(d.saldo) <= 0) return '<span class="tll-badge lista">pagada</span>';
        const mapa = {
            por_vencer:     ['aprobada',    'por vencer'],
            sin_fecha:      ['entregada',   'sin fecha'],
            vencida_30:     ['diagnostico', `vencida ${d.dias_vencida} d`],
            vencida_60:     ['reparacion',  `vencida ${d.dias_vencida} d`],
            vencida_mas_60: ['anulada',     `vencida ${d.dias_vencida} d`]
        };
        const [clase, texto] = mapa[d.antiguedad] || ['entregada', d.antiguedad];
        return `<span class="tll-badge ${clase}">${esc(texto)}</span>`;
    }

    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[CxP] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/05_compras_cxp.sql (${nombre})`
                : 'Error en la operación. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function _hoy() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
