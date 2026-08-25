// ================================================================
// modulo-cxc.js — Cuentas por cobrar
// ================================================================
// Lo que le deben al taller, de sus dos orígenes:
//   · Órdenes entregadas con saldo (el auto ya se fue sin pagar todo)
//   · Documentos cargados a mano (convenios con flotas, fletes)
//
// Todo cobro entra por la caja, igual que una venta. Las órdenes se
// cobran con fn_registrar_pago_orden; los documentos, con
// fn_cobrar_cuenta. Ver sql/11_cxc_usuarios.sql.
// ================================================================

const ModuloCxc = (() => {

    let _docs     = [];
    let _clientes = [];
    let _filtro   = 'pendientes';
    let _vista    = 'documentos';   // documentos | clientes

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-cxc');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-kpis" id="cxc-kpis"></div>
            <div class="tll-tabs">
                <button class="tll-tab active" data-vista="documentos">Documentos</button>
                <button class="tll-tab" data-vista="clientes">Por cliente</button>
            </div>
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="cxc-nuevo">+ Cargar documento</button>
                <select class="tll-select" id="cxc-filtro" style="max-width:200px">
                    <option value="pendientes">Con saldo pendiente</option>
                    <option value="vencidas">Solo vencidas</option>
                    <option value="ordenes">Solo órdenes</option>
                    <option value="documentos">Solo documentos</option>
                    <option value="todas">Todas</option>
                </select>
                <input class="tll-input" id="cxc-buscar" placeholder="Buscar por cliente, documento o N° de OT…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="cxc-reload">↻ Actualizar</button>
            </div>
            <div id="cxc-cuerpo" class="tll-tabla-wrap"></div>`;

        cont.querySelectorAll('.tll-tab').forEach(t =>
            t.addEventListener('click', () => {
                _vista = t.dataset.vista;
                cont.querySelectorAll('.tll-tab').forEach(x => x.classList.toggle('active', x === t));
                _render();
            }));

        document.getElementById('cxc-nuevo').addEventListener('click', _abrirNuevo);
        document.getElementById('cxc-reload').addEventListener('click', recargar);
        document.getElementById('cxc-buscar').addEventListener('input', _render);
        document.getElementById('cxc-filtro').addEventListener('change', (e) => {
            _filtro = e.target.value;
            _render();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [dRes, cRes] = await Promise.all([
                db.from('v_taller_cxc').select('*')
                  .eq('empresa_id', eid).order('fecha_vencimiento').range(0, 2999),
                db.from('taller_clientes').select('id, nombre, rut, telefono')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre')
            ]);

            if (dRes.error) throw dRes.error;
            _docs     = dRes.data || [];
            _clientes = cRes.data || [];
            _renderKpis();
            _render();
        } catch (err) {
            console.error('[CxC] cargar:', err);
            const cont = document.getElementById('cxc-cuerpo');
            if (cont) cont.innerHTML = errorCarga(err, '11_cxc_usuarios.sql', 'las cuentas por cobrar');
        }
    }

    // ── KPIs ──────────────────────────────────────────────────────
    function _renderKpis() {
        const cont = document.getElementById('cxc-kpis');
        if (!cont) return;

        const pend    = _docs.filter(d => _num(d.saldo) > 0);
        const total   = pend.reduce((s, d) => s + _num(d.saldo), 0);
        const vencido = pend.filter(_vencida).reduce((s, d) => s + _num(d.saldo), 0);
        const viejo   = pend.filter(d => d.antiguedad === 'vencida_mas_60')
                            .reduce((s, d) => s + _num(d.saldo), 0);

        cont.innerHTML = `
            ${_kpi('📈', fmtCLP(total), 'Por cobrar')}
            ${_kpi('🔴', fmtCLP(vencido), 'Vencido', vencido > 0 ? '#f87171' : '')}
            ${_kpi('⏳', fmtCLP(viejo), 'Más de 60 días', viejo > 0 ? '#f87171' : '')}
            ${_kpi('👤', new Set(pend.map(d => d.cliente_id)).size, 'Clientes con deuda')}`;
    }

    // ── Render según pestaña ──────────────────────────────────────
    function _render() {
        if (_vista === 'clientes') _renderPorCliente();
        else _renderDocumentos();
    }

    function _filtrados() {
        const q = (document.getElementById('cxc-buscar')?.value || '').toLowerCase().trim();

        let lista = _docs.filter(d => {
            const saldo = _num(d.saldo);
            switch (_filtro) {
                case 'pendientes': return saldo > 0;
                case 'vencidas':   return saldo > 0 && _vencida(d);
                case 'ordenes':    return saldo > 0 && d.origen === 'orden';
                case 'documentos': return saldo > 0 && d.origen === 'documento';
                default:           return true;
            }
        });

        if (q) {
            lista = lista.filter(d =>
                (d.cliente || '').toLowerCase().includes(q) ||
                (d.documento || '').toLowerCase().includes(q) ||
                (d.descripcion || '').toLowerCase().includes(q));
        }
        return lista;
    }

    function _renderDocumentos() {
        const cont = document.getElementById('cxc-cuerpo');
        if (!cont) return;

        const lista = _filtrados();

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_docs.length === 0
                    ? 'Nadie le debe nada al taller. Las órdenes entregadas con saldo aparecen solas aquí.'
                    : 'Sin resultados para ese filtro.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Documento</th><th>Cliente</th><th>Emisión</th><th>Vence</th>
                <th style="text-align:right">Total</th>
                <th style="text-align:right">Pagado</th>
                <th style="text-align:right">Saldo</th>
                <th>Situación</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(d => `
                <tr${_num(d.saldo) <= 0 ? ' style="opacity:0.5"' : ''}>
                    <td>${d.origen === 'orden' ? '🛠' : '🧾'}
                        <strong style="font-family:var(--font-mono)">${esc(d.documento)}</strong>
                        <div style="font-size:0.7rem;color:var(--text-muted)">${esc(d.descripcion) || ''}</div></td>
                    <td>${esc(d.cliente) || '<span style="color:var(--text-muted)">Sin cliente</span>'}
                        ${d.telefono ? `<div style="font-size:0.72rem;color:var(--text-secondary)">${esc(d.telefono)}</div>` : ''}</td>
                    <td>${fmtFecha(d.fecha_emision)}</td>
                    <td>${fmtFecha(d.fecha_vencimiento)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(d.total)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(d.pagado)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        <strong>${fmtCLP(d.saldo)}</strong></td>
                    <td>${_badge(d)}</td>
                    <td style="text-align:right;white-space:nowrap">
                        ${_num(d.saldo) > 0
                            ? `<button class="tll-btn tll-btn--primary cxc-cobrar"
                                       data-id="${esc(d.documento_id)}">Cobrar</button>` : ''}
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

        cont.querySelectorAll('.cxc-cobrar').forEach(b =>
            b.addEventListener('click', () =>
                _abrirCobro(_docs.find(d => String(d.documento_id) === b.dataset.id))));
    }

    function _renderPorCliente() {
        const cont = document.getElementById('cxc-cuerpo');
        if (!cont) return;

        const q = (document.getElementById('cxc-buscar')?.value || '').toLowerCase().trim();

        // Agrupar en el front: la vista por cliente es solo otra mirada
        const porCliente = {};
        for (const d of _docs.filter(x => _num(x.saldo) > 0)) {
            const k = d.cliente_id || 'sin';
            (porCliente[k] ||= {
                cliente: d.cliente || 'Sin cliente', telefono: d.telefono,
                docs: 0, saldo: 0, vencido: 0, masAntiguo: null
            });
            const g = porCliente[k];
            g.docs++;
            g.saldo += _num(d.saldo);
            if (_vencida(d)) g.vencido += _num(d.saldo);
            if (d.fecha_vencimiento && (!g.masAntiguo || d.fecha_vencimiento < g.masAntiguo))
                g.masAntiguo = d.fecha_vencimiento;
        }

        let filas = Object.values(porCliente).sort((a, b) => b.saldo - a.saldo);
        if (q) filas = filas.filter(f => f.cliente.toLowerCase().includes(q));

        if (filas.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">Sin clientes con deuda.</div>`;
            return;
        }

        const max = Math.max(...filas.map(f => f.saldo), 1);

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Cliente</th><th style="width:26%">Deuda</th>
                <th style="text-align:right">Documentos</th>
                <th style="text-align:right">Saldo</th>
                <th style="text-align:right">Vencido</th>
                <th>Más antiguo</th>
            </tr></thead>
            <tbody>
            ${filas.map(f => `
                <tr>
                    <td><strong>${esc(f.cliente)}</strong>
                        ${f.telefono ? `<div style="font-size:0.72rem;color:var(--text-secondary)">${esc(f.telefono)}</div>` : ''}</td>
                    <td><div class="tll-barra"><div class="tll-barra-fill"
                        style="width:${(f.saldo / max * 100).toFixed(1)}%"></div></div></td>
                    <td style="text-align:right;font-family:var(--font-mono)">${f.docs}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        <strong>${fmtCLP(f.saldo)}</strong></td>
                    <td style="text-align:right;font-family:var(--font-mono);
                               color:${f.vencido > 0 ? '#f87171' : 'var(--text-muted)'}">
                        ${f.vencido > 0 ? fmtCLP(f.vencido) : '—'}</td>
                    <td>${f.masAntiguo ? fmtFecha(f.masAntiguo) : '—'}</td>
                </tr>`).join('')}
            </tbody>
        </table>`;
    }

    // ── Cargar documento a mano ───────────────────────────────────
    function _abrirNuevo() {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Cargar documento por cobrar</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.7rem 1rem;text-align:left">
            Para deuda que no viene de una orden: convenios con flotas, fletes,
            trabajos facturados aparte. Las órdenes entregadas con saldo aparecen solas.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Cliente *</label>
                <select class="tll-select" id="cxc-f-cliente">
                    <option value="">— Selecciona —</option>
                    ${_clientes.map(c => `<option value="${c.id}">${esc(c.nombre)}${c.rut ? ' · ' + esc(c.rut) : ''}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Tipo</label>
                <select class="tll-select" id="cxc-f-tipo">
                    ${[['factura','Factura'],['boleta','Boleta'],['convenio','Convenio'],['otro','Otro']]
                        .map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>N° de documento</label>
                <input class="tll-input" id="cxc-f-numero" style="font-family:var(--font-mono)">
            </div>
            <div class="tll-field tll-field--full">
                <label>Descripción *</label>
                <input class="tll-input" id="cxc-f-desc" placeholder="Ej: mantención flota agosto">
            </div>
            <div class="tll-field">
                <label>Fecha de emisión</label>
                <input class="tll-input" id="cxc-f-emision" type="date" value="${_hoy()}">
            </div>
            <div class="tll-field">
                <label>Fecha de vencimiento</label>
                <input class="tll-input" id="cxc-f-vence" type="date" value="${_hoy()}">
            </div>
            <div class="tll-field">
                <label>Monto total *</label>
                <input class="tll-input" id="cxc-f-total" type="number" min="0" value="0">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="cxc-f-ok">Cargar documento</button>
        </div>`, '660px');

        document.getElementById('cxc-f-ok').addEventListener('click', async () => {
            const cliente = document.getElementById('cxc-f-cliente').value;
            const desc    = document.getElementById('cxc-f-desc').value.trim();
            const total   = _num(document.getElementById('cxc-f-total').value);

            if (!cliente) { avisar('Selecciona el cliente', 'error'); return; }
            if (!desc) { avisar('Describe el documento', 'error'); return; }
            if (total <= 0) { avisar('El monto debe ser mayor que cero', 'error'); return; }

            const btn = document.getElementById('cxc-f-ok');
            btn.disabled = true;

            try {
                const { error } = await db.from('taller_cuentas_cobrar').insert({
                    empresa_id:        window.appData.usuario.empresa_id,
                    cliente_id:        cliente,
                    tipo_documento:    document.getElementById('cxc-f-tipo').value,
                    numero_documento:  document.getElementById('cxc-f-numero').value.trim() || null,
                    descripcion:       desc,
                    fecha_emision:     document.getElementById('cxc-f-emision').value || _hoy(),
                    fecha_vencimiento: document.getElementById('cxc-f-vence').value || null,
                    total,
                    usuario_rut:       window.appData.usuario.rut
                });
                if (error) throw error;

                avisar('Documento cargado');
                cerrarModal();
                await recargar();
            } catch (err) {
                console.error('[CxC] cargar documento:', err);
                btn.disabled = false;
                avisar('No se pudo cargar el documento', 'error');
            }
        });
    }

    // ── Cobrar ────────────────────────────────────────────────────
    function _abrirCobro(d) {
        if (!d) return;
        const saldo = _num(d.saldo);

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Cobrar a ${esc(d.cliente) || 'cliente'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            ${esc(d.documento)} · total ${fmtCLP(d.total)} · ya pagado ${fmtCLP(d.pagado)}<br>
            <strong>Saldo: ${fmtCLP(saldo)}</strong>
            ${_vencida(d) ? ` · <span style="color:#f87171">vencido hace ${d.dias_vencida} días</span>` : ''}
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Monto a cobrar *</label>
                <input class="tll-input" id="cxc-c-monto" type="number" min="0" value="${saldo}">
                <span class="tll-field-msg">Puede abonar menos y dejar saldo.</span>
            </div>
            <div class="tll-field">
                <label>Medio de pago</label>
                <select class="tll-select" id="cxc-c-medio">
                    ${['efectivo', 'transferencia', 'debito', 'credito', 'cheque', 'otro']
                        .map(m => `<option value="${m}">${m}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <label>Referencia</label>
                <input class="tll-input" id="cxc-c-ref" style="font-family:var(--font-mono)"
                       placeholder="N° de transferencia o documento">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="cxc-c-ok">Registrar cobro</button>
        </div>`, '560px');

        document.getElementById('cxc-c-ok').addEventListener('click', async () => {
            const monto = _num(document.getElementById('cxc-c-monto').value);
            if (monto <= 0) { avisar('El monto debe ser mayor que cero', 'error'); return; }

            const btn = document.getElementById('cxc-c-ok');
            btn.disabled = true;

            const medio = document.getElementById('cxc-c-medio').value;
            const ref   = document.getElementById('cxc-c-ref').value.trim() || null;

            // Una orden se cobra por su propia RPC; un documento, por la suya
            const res = d.origen === 'orden'
                ? await _rpc('fn_registrar_pago_orden', {
                      p_empresa_id: window.appData.usuario.empresa_id,
                      p_orden_id: d.orden_id,
                      p_monto: monto,
                      p_medio_pago: medio,
                      p_caja_id: null,
                      p_usuario: window.appData.usuario.rut
                  })
                : await _rpc('fn_cobrar_cuenta', {
                      p_empresa_id: window.appData.usuario.empresa_id,
                      p_cxc_id: d.cxc_id,
                      p_monto: monto,
                      p_medio_pago: medio,
                      p_caja_id: null,
                      p_referencia: ref,
                      p_usuario: window.appData.usuario.rut
                  });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo cobrar', 'error'); btn.disabled = false; return; }

            avisar(_num(res.saldo) > 0
                ? `Abono registrado · queda un saldo de ${fmtCLP(res.saldo)}`
                : 'Documento cobrado por completo');
            cerrarModal();
            await recargar();
        });
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _vencida(d) {
        return String(d.antiguedad || '').startsWith('vencida');
    }

    function _badge(d) {
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
            console.error('[CxC] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar el script SQL que crea ${nombre}`
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

    function _kpi(icono, valor, label, color = '') {
        return `
        <div class="tll-kpi">
            <span class="tll-kpi-icono">${icono}</span>
            <div class="tll-kpi-valor" style="font-size:1.5rem;${color ? `color:${color}` : ''}">${valor}</div>
            <div class="tll-kpi-label">${label}</div>
        </div>`;
    }

    return { init, recargar };

})();
