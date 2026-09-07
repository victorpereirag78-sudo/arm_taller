// ================================================================
// modulo-ventas.js — Venta de mostrador
// ================================================================
// El cobro entero (venta + ítems + stock + entrada de caja) ocurre
// dentro de fn_registrar_venta. Si falta stock de un ítem, no queda
// media venta grabada: falla completa. Ver sql/03_ventas_caja.sql.
//
// Los precios se manejan CON IVA incluido; el neto y el IVA los
// calcula la base al cerrar la venta.
// ================================================================

const ModuloVentas = (() => {

    let _repuestos = [];
    let _clientes  = [];
    let _carro     = [];      // [{ tipo, codigo, descripcion, cantidad, precio_unitario, descuento, stock }]
    let _ventas    = [];      // ventas del día
    let _caja      = null;    // caja abierta, o null
    let _cobrando  = false;

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-ventas');
        if (!cont) return;

        cont.innerHTML = `
            <div id="ven-aviso"></div>
            <div class="tll-pos">
                <div class="tll-pos-catalogo">
                    <div class="tll-toolbar" style="margin-bottom:0.6rem">
                        <input class="tll-input" id="ven-buscar"
                               placeholder="Buscar repuesto por código, nombre o marca…" autofocus>
                        <button class="tll-btn tll-btn--ghost" id="ven-servicio">+ Servicio</button>
                    </div>
                    <div id="ven-resultados" class="tll-tabla-wrap"></div>
                </div>

                <div class="tll-pos-carro">
                    <div class="panel-header" style="margin-bottom:0.6rem">
                        <h2 style="font-size:0.95rem">Venta actual</h2>
                        <button class="tll-btn tll-btn--ghost" id="ven-limpiar">Vaciar</button>
                    </div>
                    <div id="ven-carro"></div>
                    <div id="ven-totales" class="tll-ot-totales" style="flex-direction:column;align-items:stretch"></div>

                    <div class="tll-form-grid" style="margin-top:0.6rem">
                        <div class="tll-field tll-field--full">
                            <label>Cliente (opcional)</label>
                            <select class="tll-select" id="ven-cliente">
                                <option value="">— Cliente ocasional —</option>
                            </select>
                        </div>
                        <div class="tll-field">
                            <label>Medio de pago</label>
                            <select class="tll-select" id="ven-medio">
                                <option value="efectivo">Efectivo</option>
                                <option value="debito">Débito</option>
                                <option value="credito">Crédito</option>
                                <option value="transferencia">Transferencia</option>
                                <option value="cheque">Cheque</option>
                                <option value="otro">Otro</option>
                            </select>
                        </div>
                        <div class="tll-field">
                            <label>Descuento total</label>
                            <input class="tll-input" id="ven-descuento" type="number" min="0" value="0">
                        </div>
                    </div>

                    <button class="tll-btn tll-btn--primary" id="ven-cobrar"
                            style="width:100%;margin-top:0.8rem;padding:0.8rem">Cobrar</button>
                </div>
            </div>

            <div class="panel-header" style="margin-top:1.6rem">
                <h2 style="font-size:1rem">Ventas de hoy</h2>
                <button class="tll-btn tll-btn--ghost" id="ven-reload">↻ Actualizar</button>
            </div>
            <div id="ven-historial" class="tll-tabla-wrap"></div>`;

        document.getElementById('ven-buscar').addEventListener('input', _renderCatalogo);
        document.getElementById('ven-servicio').addEventListener('click', _agregarServicio);
        document.getElementById('ven-limpiar').addEventListener('click', () => {
            if (_carro.length && !confirm('¿Vaciar la venta actual?')) return;
            _carro = []; _renderCarro();
        });
        document.getElementById('ven-descuento').addEventListener('input', _renderTotales);
        document.getElementById('ven-cobrar').addEventListener('click', _cobrar);
        document.getElementById('ven-reload').addEventListener('click', recargar);

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [rRes, cRes] = await Promise.all([
                db.from('taller_repuestos')
                  .select('id, codigo, nombre, marca, unidad, stock, precio_venta, ubicacion')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre').range(0, 4999),
                db.from('taller_clientes')
                  .select('id, nombre, rut')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre')
            ]);

            if (rRes.error) throw rRes.error;
            _repuestos = rRes.data || [];
            _clientes  = cRes.data || [];

            const sel = document.getElementById('ven-cliente');
            if (sel) {
                const actual = sel.value;
                sel.innerHTML = '<option value="">— Cliente ocasional —</option>' +
                    _clientes.map(c => `<option value="${c.id}">${esc(c.nombre)}${c.rut ? ' · ' + esc(c.rut) : ''}</option>`).join('');
                sel.value = actual;
            }

            await Promise.all([_cargarCaja(), _cargarHistorial()]);
            _renderCatalogo();
            _renderCarro();
        } catch (err) {
            console.error('[Ventas] cargar:', err);
            avisar('Error cargando el módulo de ventas', 'error');
        }
    }

    // ── Caja ──────────────────────────────────────────────────────
    async function _cargarCaja() {
        const aviso = document.getElementById('ven-aviso');
        if (!aviso) return;

        // Si el taller no usa el módulo Caja, se vende sin turno abierto
        if (!_usaCaja()) { _caja = null; aviso.innerHTML = ''; return; }

        try {
            const { data, error } = await db.from('taller_cajas')
                .select('id, numero, fecha_apertura')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .eq('estado', 'abierta')
                .limit(1);
            if (error) throw error;

            _caja = data?.[0] || null;

            aviso.innerHTML = _caja
                ? `<div class="tll-recep-found" style="margin-bottom:0.8rem">
                     Caja N° ${esc(_caja.numero)} abierta desde ${fmtFechaHora(_caja.fecha_apertura)}.
                   </div>`
                : `<div class="tll-recep-notfound" style="margin-bottom:0.8rem">
                     No hay caja abierta. Ábrela en <strong>Caja</strong> antes de cobrar.
                   </div>`;
        } catch (err) {
            console.error('[Ventas] caja:', err);
            _caja = null;
            aviso.innerHTML = `<div class="tll-recep-notfound" style="margin-bottom:0.8rem">
                No se pudo leer el estado de la caja. ¿Ejecutaste <strong>sql/03_ventas_caja.sql</strong>?
            </div>`;
        }
    }

    function _usaCaja() {
        return moduloHabilitado('caja', window.appData.empresa?.modulos_activos);
    }

    // ── Catálogo ──────────────────────────────────────────────────
    function _renderCatalogo() {
        const cont = document.getElementById('ven-resultados');
        if (!cont) return;

        const q = (document.getElementById('ven-buscar')?.value || '').toLowerCase().trim();

        const lista = (q
            ? _repuestos.filter(r =>
                (r.codigo || '').toLowerCase().includes(q) ||
                (r.nombre || '').toLowerCase().includes(q) ||
                (r.marca || '').toLowerCase().includes(q))
            : _repuestos).slice(0, 60);

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_repuestos.length === 0
                    ? 'No hay repuestos en el catálogo. Créalos en <strong>Inventario</strong>.'
                    : 'Sin resultados para esa búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Código</th><th>Repuesto</th>
                <th style="text-align:right">Stock</th>
                <th style="text-align:right">Precio</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(r => `
                <tr>
                    <td style="font-family:var(--font-mono)">${esc(r.codigo)}</td>
                    <td>${esc(r.nombre)}
                        ${r.marca ? `<div style="font-size:0.7rem;color:var(--text-secondary)">${esc(r.marca)}</div>` : ''}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        ${_num(r.stock) <= 0
                            ? '<span class="tll-badge anulada">0</span>'
                            : _fmtCant(r.stock)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(r.precio_venta)}</td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost ven-add" data-codigo="${esc(r.codigo)}"
                                ${_num(r.stock) <= 0 ? 'disabled' : ''}>Agregar</button></td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        cont.querySelectorAll('.ven-add').forEach(b =>
            b.addEventListener('click', () => _agregarRepuesto(b.dataset.codigo)));
    }

    // ── Carro ─────────────────────────────────────────────────────
    function _agregarRepuesto(codigo) {
        const rep = _repuestos.find(r => r.codigo === codigo);
        if (!rep) return;

        const enCarro = _carro.find(i => i.tipo === 'repuesto' && i.codigo === codigo);
        const yaLleva = enCarro ? enCarro.cantidad : 0;

        if (yaLleva + 1 > _num(rep.stock)) {
            avisar(`Solo quedan ${_fmtCant(rep.stock)} de ${rep.nombre}`, 'error');
            return;
        }

        if (enCarro) {
            enCarro.cantidad += 1;
        } else {
            _carro.push({
                tipo: 'repuesto',
                codigo: rep.codigo,
                descripcion: rep.nombre,
                cantidad: 1,
                precio_unitario: _num(rep.precio_venta),
                descuento: 0,
                stock: _num(rep.stock)
            });
        }
        _renderCarro();
    }

    function _agregarServicio() {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Agregar servicio</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Descripción *</label>
                <input class="tll-input" id="ven-s-desc" placeholder="Ej: cambio de aceite, escaneo computarizado">
            </div>
            <div class="tll-field">
                <label>Cantidad</label>
                <input class="tll-input" id="ven-s-cant" type="number" min="1" step="1" value="1">
            </div>
            <div class="tll-field">
                <label>Precio unitario</label>
                <input class="tll-input" id="ven-s-precio" type="number" min="0" value="0">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="ven-s-ok">Agregar</button>
        </div>`);

        document.getElementById('ven-s-ok').addEventListener('click', () => {
            const desc = document.getElementById('ven-s-desc').value.trim();
            if (!desc) { avisar('Describe el servicio', 'error'); return; }
            const cant = Math.floor(_num(document.getElementById('ven-s-cant').value));
            if (cant < 1) { avisar('La cantidad debe ser al menos 1 unidad', 'error'); return; }

            _carro.push({
                tipo: 'servicio',
                codigo: null,
                descripcion: desc,
                cantidad: cant,
                precio_unitario: _num(document.getElementById('ven-s-precio').value),
                descuento: 0,
                stock: null
            });
            cerrarModal();
            _renderCarro();
        });
    }

    function _renderCarro() {
        const cont = document.getElementById('ven-carro');
        if (!cont) return;

        if (_carro.length === 0) {
            cont.innerHTML = `<div class="placeholder-text" style="padding:1.6rem 1rem">
                Agrega repuestos o servicios para empezar la venta.</div>`;
            _renderTotales();
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Detalle</th>
                <th style="text-align:center;width:110px">Cant.</th>
                <th style="text-align:right">Precio</th>
                <th style="text-align:right">Subtotal</th><th></th>
            </tr></thead>
            <tbody>
            ${_carro.map((i, idx) => `
                <tr>
                    <td>${esc(i.descripcion)}
                        ${i.codigo ? `<div style="font-size:0.68rem;color:var(--text-muted);font-family:var(--font-mono)">${esc(i.codigo)}</div>` : ''}</td>
                    <td style="text-align:center">
                        <input class="tll-input ven-cant" data-idx="${idx}" type="number"
                               min="1" step="1" value="${i.cantidad}"
                               style="width:80px;text-align:center;padding:0.3rem"></td>
                    <td style="text-align:right">
                        <input class="tll-input ven-precio" data-idx="${idx}" type="number"
                               min="0" value="${i.precio_unitario}"
                               style="width:100px;text-align:right;padding:0.3rem"></td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(_subtotal(i))}</td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--danger ven-quitar" data-idx="${idx}">✕</button></td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        cont.querySelectorAll('.ven-cant').forEach(inp =>
            inp.addEventListener('change', () => _cambiarCantidad(+inp.dataset.idx, _num(inp.value))));
        cont.querySelectorAll('.ven-precio').forEach(inp =>
            inp.addEventListener('change', () => {
                _carro[+inp.dataset.idx].precio_unitario = _num(inp.value);
                _renderCarro();
            }));
        cont.querySelectorAll('.ven-quitar').forEach(b =>
            b.addEventListener('click', () => { _carro.splice(+b.dataset.idx, 1); _renderCarro(); }));

        _renderTotales();
    }

    function _cambiarCantidad(idx, cantidad) {
        const item = _carro[idx];
        if (!item) return;

        cantidad = Math.floor(_num(cantidad));   // ventas: solo unidades completas
        if (cantidad <= 0) { _carro.splice(idx, 1); _renderCarro(); return; }

        if (item.tipo === 'repuesto' && cantidad > _num(item.stock)) {
            avisar(`Solo hay ${_fmtCant(item.stock)} de ${item.descripcion}`, 'error');
            cantidad = Math.floor(_num(item.stock));
        }
        item.cantidad = cantidad;
        _renderCarro();
    }

    function _renderTotales() {
        const cont = document.getElementById('ven-totales');
        if (!cont) return;

        const bruto = _carro.reduce((s, i) => s + _subtotal(i), 0);
        const desc  = Math.min(_num(document.getElementById('ven-descuento')?.value), bruto);
        const total = Math.max(bruto - desc, 0);
        const neto  = Math.round(total / (1 + IVA_TASA));
        const iva   = total - neto;

        cont.innerHTML = `
            <span style="display:flex;justify-content:space-between">
                <span>Neto</span><strong>${fmtCLP(neto)}</strong></span>
            <span style="display:flex;justify-content:space-between">
                <span>IVA ${Math.round(IVA_TASA * 100)}%</span><strong>${fmtCLP(iva)}</strong></span>
            ${desc > 0 ? `<span style="display:flex;justify-content:space-between">
                <span>Descuento</span><strong>−${fmtCLP(desc)}</strong></span>` : ''}
            <span style="display:flex;justify-content:space-between;font-size:1.05rem;margin-top:0.3rem">
                <span>Total</span>
                <strong style="color:var(--accent)">${fmtCLP(total)}</strong></span>`;
    }

    // ── Cobrar ────────────────────────────────────────────────────
    async function _cobrar() {
        if (_cobrando) return;
        if (_carro.length === 0) { avisar('La venta está vacía', 'error'); return; }
        if (_usaCaja() && !_caja) { avisar('Abre la caja antes de cobrar', 'error'); return; }

        const bruto = _carro.reduce((s, i) => s + _subtotal(i), 0);
        const desc  = Math.min(_num(document.getElementById('ven-descuento').value), bruto);
        const total = Math.max(bruto - desc, 0);

        if (!confirm(`Cobrar ${fmtCLP(total)} en ${document.getElementById('ven-medio').value}?`)) return;

        _cobrando = true;
        const btn = document.getElementById('ven-cobrar');
        btn.disabled = true;
        btn.textContent = 'Cobrando…';

        try {
            const { data, error } = await db.rpc('fn_registrar_venta', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_items: _carro.map(i => ({
                    tipo: i.tipo,
                    codigo: i.codigo,
                    descripcion: i.descripcion,
                    cantidad: i.cantidad,
                    precio_unitario: i.precio_unitario,
                    descuento: i.descuento || 0
                })),
                p_medio_pago: document.getElementById('ven-medio').value,
                p_caja_id: _caja?.id || null,
                p_cliente_id: document.getElementById('ven-cliente').value || null,
                p_descuento_global: desc,
                p_observacion: null,
                p_usuario: window.appData.usuario.rut
            });

            if (error) {
                if (error.code === 'PGRST202' || error.code === '42883') {
                    avisar('Falta ejecutar sql/03_ventas_caja.sql en Supabase', 'error');
                } else throw error;
                return;
            }
            if (!data?.ok) { avisar(data?.error || 'No se pudo registrar la venta', 'error'); return; }

            avisar(`Venta N° ${data.numero} · ${fmtCLP(data.total)}`);
            _carro = [];
            document.getElementById('ven-descuento').value = 0;
            await recargar();

        } catch (err) {
            console.error('[Ventas] cobrar:', err);
            avisar('Error al cobrar. Revisa la consola.', 'error');
        } finally {
            _cobrando = false;
            btn.disabled = false;
            btn.textContent = 'Cobrar';
        }
    }

    // ── Historial del día ─────────────────────────────────────────
    async function _cargarHistorial() {
        const cont = document.getElementById('ven-historial');
        if (!cont) return;

        try {
            const { data, error } = await db.from('taller_ventas')
                .select('*, taller_clientes(nombre)')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .gte('created_at', _inicioDeHoy())
                .order('created_at', { ascending: false })
                .limit(100);
            if (error) throw error;

            _ventas = data || [];

            if (_ventas.length === 0) {
                cont.innerHTML = `<div class="placeholder-text">Aún no hay ventas hoy.</div>`;
                return;
            }

            const totalDia = _ventas
                .filter(v => v.estado !== 'anulada')
                .reduce((s, v) => s + _num(v.total), 0);

            cont.innerHTML = `
            <table class="tll-tabla">
                <thead><tr>
                    <th>N°</th><th>Hora</th><th>Cliente</th><th>Medio</th>
                    <th style="text-align:right">Total</th><th>Estado</th><th></th>
                </tr></thead>
                <tbody>
                ${_ventas.map(v => `
                    <tr${v.estado === 'anulada' ? ' style="opacity:0.5"' : ''}>
                        <td style="font-family:var(--font-mono)"><strong>${esc(v.numero)}</strong></td>
                        <td>${fmtFechaHora(v.created_at).split(' ')[1] || '—'}</td>
                        <td>${esc(v.taller_clientes?.nombre) || 'Ocasional'}</td>
                        <td>${esc(v.medio_pago) || '—'}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(v.total)}</td>
                        <td><span class="tll-badge ${v.estado === 'anulada' ? 'anulada' : 'lista'}">${esc(v.estado)}</span></td>
                        <td style="text-align:right;white-space:nowrap">
                            <button class="tll-btn tll-btn--ghost ven-detalle" data-id="${v.id}">Detalle</button>
                            ${v.estado !== 'anulada'
                                ? `<button class="tll-btn tll-btn--danger ven-anular" data-id="${v.id}">Anular</button>`
                                : ''}
                        </td>
                    </tr>`).join('')}
                </tbody>
                <tfoot><tr>
                    <td colspan="4" style="text-align:right"><strong>Total del día</strong></td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        <strong style="color:var(--accent)">${fmtCLP(totalDia)}</strong></td>
                    <td colspan="2"></td>
                </tr></tfoot>
            </table>`;

            cont.querySelectorAll('.ven-detalle').forEach(b =>
                b.addEventListener('click', () => _verDetalle(_ventas.find(v => v.id === b.dataset.id))));
            cont.querySelectorAll('.ven-anular').forEach(b =>
                b.addEventListener('click', () => _anular(_ventas.find(v => v.id === b.dataset.id))));

        } catch (err) {
            console.error('[Ventas] historial:', err);
            cont.innerHTML = `<div class="placeholder-text">
                No se pudo cargar el historial de ventas.</div>`;
        }
    }

    async function _verDetalle(venta) {
        if (!venta) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Venta N° ${esc(venta.numero)}
                <span class="tll-badge ${venta.estado === 'anulada' ? 'anulada' : 'lista'}"
                      style="margin-left:0.5rem">${esc(venta.estado)}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="ven-d-body"><div class="placeholder-text">Cargando…</div></div>`, '640px');

        try {
            const { data: items, error } = await db.from('taller_ventas_items')
                .select('*').eq('venta_id', venta.id).order('created_at');
            if (error) throw error;

            const body = document.getElementById('ven-d-body');
            if (!body) return;

            body.innerHTML = `
            <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:0.7rem">
                ${fmtFechaHora(venta.created_at)} ·
                ${esc(venta.taller_clientes?.nombre) || 'Cliente ocasional'} ·
                ${esc(venta.medio_pago)} · vendió ${esc(venta.usuario_rut) || '—'}
            </div>
            <table class="tll-tabla">
                <thead><tr>
                    <th>Detalle</th><th style="text-align:right">Cant.</th>
                    <th style="text-align:right">P. unit</th><th style="text-align:right">Subtotal</th>
                </tr></thead>
                <tbody>
                ${(items || []).map(i => `
                    <tr>
                        <td>${i.tipo === 'repuesto' ? '🔩' : '🔧'} ${esc(i.descripcion)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${_fmtCant(i.cantidad)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(i.precio_unitario)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(i.subtotal)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
            <div class="tll-ot-totales" style="flex-direction:column;align-items:stretch">
                <span style="display:flex;justify-content:space-between"><span>Neto</span><strong>${fmtCLP(venta.neto)}</strong></span>
                <span style="display:flex;justify-content:space-between"><span>IVA</span><strong>${fmtCLP(venta.iva)}</strong></span>
                ${_num(venta.descuento) > 0 ? `<span style="display:flex;justify-content:space-between">
                    <span>Descuento</span><strong>−${fmtCLP(venta.descuento)}</strong></span>` : ''}
                <span style="display:flex;justify-content:space-between;font-size:1.05rem">
                    <span>Total</span><strong style="color:var(--accent)">${fmtCLP(venta.total)}</strong></span>
            </div>`;
        } catch (err) {
            console.error('[Ventas] detalle:', err);
            const body = document.getElementById('ven-d-body');
            if (body) body.innerHTML = `<div class="placeholder-text">Error cargando el detalle.</div>`;
        }
    }

    async function _anular(venta) {
        if (!venta) return;

        const motivo = prompt(
            `Anular la venta N° ${venta.numero} por ${fmtCLP(venta.total)}.\n\n` +
            `Se devuelve el stock y se descuenta de la caja.\n\nMotivo:`);
        if (motivo === null) return;

        try {
            const { data, error } = await db.rpc('fn_anular_venta', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_venta_id: venta.id,
                p_motivo: motivo.trim() || null,
                p_usuario: window.appData.usuario.rut
            });
            if (error) throw error;
            if (!data?.ok) { avisar(data?.error || 'No se pudo anular', 'error'); return; }

            avisar(`Venta N° ${venta.numero} anulada`);
            await recargar();
        } catch (err) {
            console.error('[Ventas] anular:', err);
            avisar('Error al anular la venta', 'error');
        }
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _subtotal(i) {
        return Math.max(Math.round(i.cantidad * i.precio_unitario) - (i.descuento || 0), 0);
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function _fmtCant(v) {
        const n = _num(v);
        return Number.isInteger(n) ? String(n) : n.toLocaleString('es-CL', { maximumFractionDigits: 2 });
    }

    function _inicioDeHoy() {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    }

    return { init, recargar };

})();
