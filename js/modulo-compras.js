// ================================================================
// modulo-compras.js — Órdenes de compra y recepción de mercadería
// ================================================================
// Flujo: borrador → emitida → recibida.
//
// El stock se mueve SOLO al recibir, y lo hace la base (fn_recibir_compra),
// que sube cada ítem con costo promedio ponderado, deja el kardex y crea
// la cuenta por pagar. Emitir una OC no toca nada del inventario.
//
// Los costos de compra van NETOS (sin IVA), como en la factura del
// proveedor. El IVA se calcula sobre el total. Ver sql/05_compras_cxp.sql.
// ================================================================

const ModuloCompras = (() => {

    let _compras     = [];
    let _proveedores = [];
    let _repuestos   = [];
    let _abierta     = null;   // compra en el modal de detalle
    let _filtro      = 'activas';

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-compras');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="cmp-nueva">+ Nueva orden de compra</button>
                <select class="tll-select" id="cmp-filtro" style="max-width:180px">
                    <option value="activas">En curso</option>
                    <option value="borrador">Borrador</option>
                    <option value="emitida">Emitidas</option>
                    <option value="recibida">Recibidas</option>
                    <option value="anulada">Anuladas</option>
                    <option value="todas">Todas</option>
                </select>
                <input class="tll-input" id="cmp-buscar" placeholder="Buscar por N°, proveedor o documento…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="cmp-reload">↻ Actualizar</button>
            </div>
            <div id="cmp-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('cmp-nueva').addEventListener('click', _abrirNueva);
        document.getElementById('cmp-reload').addEventListener('click', recargar);
        document.getElementById('cmp-buscar').addEventListener('input', _renderLista);
        document.getElementById('cmp-filtro').addEventListener('change', (e) => {
            _filtro = e.target.value;
            _renderLista();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [cRes, pRes, rRes] = await Promise.all([
                db.from('taller_compras')
                  .select('*, taller_proveedores(razon_social)')
                  .eq('empresa_id', eid)
                  .order('numero', { ascending: false })
                  .limit(300),
                db.from('taller_proveedores').select('id, razon_social, condicion_pago, dias_credito')
                  .eq('empresa_id', eid).eq('activo', true).order('razon_social'),
                db.from('taller_repuestos').select('id, codigo, nombre, unidad, stock, precio_costo')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre').range(0, 4999)
            ]);

            if (cRes.error) throw cRes.error;
            _compras     = cRes.data || [];
            _proveedores = pRes.data || [];
            _repuestos   = rRes.data || [];
            _renderLista();
        } catch (err) {
            console.error('[Compras] cargar:', err);
            const cont = document.getElementById('cmp-lista');
            if (cont) {
                cont.innerHTML = errorCarga(err, '05_compras_cxp.sql', 'el módulo Compras');
            }
        }
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('cmp-lista');
        if (!cont) return;

        const q = (document.getElementById('cmp-buscar')?.value || '').toLowerCase().trim();

        let lista = _compras.filter(c => {
            if (_filtro === 'todas')   return true;
            if (_filtro === 'activas') return c.estado === 'borrador' || c.estado === 'emitida';
            return c.estado === _filtro;
        });

        if (q) {
            lista = lista.filter(c =>
                String(c.numero || '').includes(q) ||
                (c.taller_proveedores?.razon_social || '').toLowerCase().includes(q) ||
                (c.numero_documento || '').toLowerCase().includes(q));
        }

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_compras.length === 0
                    ? 'Sin órdenes de compra. Crea la primera con <strong>+ Nueva orden de compra</strong>.'
                    : 'Sin resultados para ese filtro o búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>N°</th><th>Proveedor</th><th>Documento</th><th>Emisión</th>
                <th style="text-align:right">Neto</th>
                <th style="text-align:right">Total</th>
                <th>Estado</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(c => `
                <tr${c.estado === 'anulada' ? ' style="opacity:0.5"' : ''}>
                    <td style="font-family:var(--font-mono)"><strong>${esc(c.numero)}</strong></td>
                    <td>${esc(c.taller_proveedores?.razon_social) || '—'}</td>
                    <td style="font-family:var(--font-mono);font-size:0.78rem">
                        ${esc(c.numero_documento) || '—'}
                        <div style="font-size:0.68rem;color:var(--text-muted)">${esc(c.tipo_documento)}</div></td>
                    <td>${fmtFecha(c.fecha_emision)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(c.neto)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(c.total)}</td>
                    <td><span class="tll-badge ${_badge(c.estado)}">${esc(c.estado)}</span></td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost cmp-abrir" data-id="${c.id}">Abrir</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        cont.querySelectorAll('.cmp-abrir').forEach(b =>
            b.addEventListener('click', () => _abrirDetalle(_compras.find(c => c.id === b.dataset.id))));
    }

    // ── Nueva orden de compra ─────────────────────────────────────
    function _abrirNueva() {
        if (_proveedores.length === 0) {
            avisar('Primero crea un proveedor en el módulo Proveedores', 'error');
            return;
        }

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Nueva orden de compra</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Proveedor *</label>
                <select class="tll-select" id="cmp-f-proveedor">
                    <option value="">— Selecciona —</option>
                    ${_proveedores.map(p => `
                        <option value="${p.id}" data-condicion="${p.condicion_pago}" data-dias="${p.dias_credito}">
                            ${esc(p.razon_social)}
                        </option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Tipo de documento</label>
                <select class="tll-select" id="cmp-f-tipodoc">
                    ${[['factura','Factura'],['boleta','Boleta'],['guia','Guía de despacho'],
                       ['sin_documento','Sin documento']]
                        .map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>N° de documento</label>
                <input class="tll-input" id="cmp-f-numdoc" style="font-family:var(--font-mono)">
            </div>
            <div class="tll-field">
                <label>Fecha de emisión</label>
                <input class="tll-input" id="cmp-f-emision" type="date" value="${_hoy()}">
            </div>
            <div class="tll-field">
                <label>Condición de pago</label>
                <select class="tll-select" id="cmp-f-condicion">
                    <option value="contado">Contado</option>
                    <option value="credito">Crédito</option>
                </select>
            </div>
            <div class="tll-field">
                <label>Días de crédito</label>
                <input class="tll-input" id="cmp-f-dias" type="number" min="0" value="0">
            </div>
            <div class="tll-field tll-field--full">
                <label>Observación</label>
                <input class="tll-input" id="cmp-f-obs">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="cmp-f-crear">Crear y agregar ítems</button>
        </div>`, '640px');

        // La condición del proveedor manda por defecto
        document.getElementById('cmp-f-proveedor').addEventListener('change', (e) => {
            const opt = e.target.selectedOptions[0];
            if (!opt?.value) return;
            document.getElementById('cmp-f-condicion').value = opt.dataset.condicion || 'contado';
            document.getElementById('cmp-f-dias').value = opt.dataset.dias || 0;
        });

        document.getElementById('cmp-f-crear').addEventListener('click', _crear);
    }

    async function _crear() {
        const proveedorId = document.getElementById('cmp-f-proveedor').value;
        if (!proveedorId) { avisar('Selecciona el proveedor', 'error'); return; }

        const btn = document.getElementById('cmp-f-crear');
        btn.disabled = true;

        try {
            const eid = window.appData.usuario.empresa_id;

            const { data: max } = await db.from('taller_compras')
                .select('numero').eq('empresa_id', eid)
                .order('numero', { ascending: false }).limit(1);
            const numero = (max?.[0]?.numero || 0) + 1;

            const { data: creada, error } = await db.from('taller_compras').insert({
                empresa_id:       eid,
                numero,
                proveedor_id:     proveedorId,
                estado:           'borrador',
                tipo_documento:   document.getElementById('cmp-f-tipodoc').value,
                numero_documento: document.getElementById('cmp-f-numdoc').value.trim() || null,
                fecha_emision:    document.getElementById('cmp-f-emision').value || _hoy(),
                condicion_pago:   document.getElementById('cmp-f-condicion').value,
                dias_credito:     Number(document.getElementById('cmp-f-dias').value) || 0,
                observacion:      document.getElementById('cmp-f-obs').value.trim() || null,
                usuario_rut:      window.appData.usuario.rut
            }).select('*, taller_proveedores(razon_social)').single();
            if (error) throw error;

            avisar(`Orden de compra N° ${numero} creada`);
            cerrarModal();
            await recargar();
            _abrirDetalle(creada);
        } catch (err) {
            console.error('[Compras] crear:', err);
            btn.disabled = false;
            avisar('Error al crear la orden de compra', 'error');
        }
    }

    // ── Detalle ───────────────────────────────────────────────────
    async function _abrirDetalle(compra) {
        if (!compra) return;
        _abierta = compra;

        const editable = compra.estado === 'borrador' || compra.estado === 'emitida';

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Orden de compra N° ${esc(compra.numero)}
                <span class="tll-badge ${_badge(compra.estado)}" style="margin-left:0.5rem">${esc(compra.estado)}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>

        <div class="tll-form-grid" style="margin-bottom:1rem">
            <div class="tll-field">
                <label>Proveedor</label>
                <div>${esc(compra.taller_proveedores?.razon_social) || '—'}</div>
            </div>
            <div class="tll-field">
                <label>Documento</label>
                <div style="font-family:var(--font-mono)">${esc(compra.numero_documento) || '—'}</div>
                <div style="font-size:0.72rem;color:var(--text-secondary)">${esc(compra.tipo_documento)}</div>
            </div>
            <div class="tll-field">
                <label>Condición</label>
                <div>${compra.condicion_pago === 'credito'
                    ? `Crédito ${compra.dias_credito} días` : 'Contado'}</div>
                ${compra.fecha_vencimiento
                    ? `<div style="font-size:0.72rem;color:var(--text-secondary)">vence ${fmtFecha(compra.fecha_vencimiento)}</div>` : ''}
            </div>
        </div>

        <div class="panel-header" style="margin-bottom:0.6rem">
            <h2 style="font-size:0.95rem">Ítems (costos netos, sin IVA)</h2>
        </div>
        <div id="cmp-items"></div>

        ${editable ? `
        <div class="tll-form-grid" style="margin-top:0.8rem;align-items:end">
            <div class="tll-field tll-field--full" style="grid-column:span 2">
                <label>Repuesto</label>
                <select class="tll-select" id="cmp-i-repuesto">
                    <option value="">— Selecciona del inventario —</option>
                    ${_repuestos.map(r => `
                        <option value="${esc(r.codigo)}" data-costo="${r.precio_costo}">
                            ${esc(r.codigo)} · ${esc(r.nombre)} · stock ${r.stock}
                        </option>`).join('')}
                    <option value="__nuevo__">➕ Repuesto nuevo (crear en el catálogo)</option>
                    <option value="__insumo__">📎 Insumo sin control de stock</option>
                </select>
            </div>
            <div class="tll-field tll-field--full oculto" id="cmp-i-libre-wrap" style="grid-column:span 2">
                <label>Descripción</label>
                <input class="tll-input" id="cmp-i-descripcion" placeholder="Nombre del repuesto o insumo">
            </div>
            <div class="tll-field oculto" id="cmp-i-codigo-wrap">
                <label>Código nuevo</label>
                <input class="tll-input" id="cmp-i-codigo" style="font-family:var(--font-mono)">
            </div>
            <div class="tll-field">
                <label>Cantidad</label>
                <input class="tll-input" id="cmp-i-cantidad" type="number" min="0.5" step="0.5" value="1">
            </div>
            <div class="tll-field">
                <label>Costo unitario neto</label>
                <input class="tll-input" id="cmp-i-costo" type="number" min="0" value="0">
            </div>
            <div class="tll-field">
                <label>&nbsp;</label>
                <button class="tll-btn tll-btn--primary" id="cmp-i-agregar" style="width:100%">+ Agregar</button>
            </div>
        </div>` : ''}

        <div class="tll-ot-totales" id="cmp-totales" style="flex-direction:column;align-items:stretch"></div>

        <div class="tll-modal-footer">
            ${compra.estado === 'borrador'
                ? `<button class="tll-btn tll-btn--ghost" id="cmp-emitir">Marcar como emitida</button>` : ''}
            ${editable
                ? `<button class="tll-btn tll-btn--primary" id="cmp-recibir">📦 Recibir mercadería</button>` : ''}
            ${compra.estado !== 'anulada'
                ? `<button class="tll-btn tll-btn--danger" id="cmp-anular">Anular</button>` : ''}
            <div class="tll-toolbar-sep"></div>
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cerrar</button>
        </div>`, '820px');

        await _cargarItems();

        if (editable) {
            document.getElementById('cmp-i-repuesto').addEventListener('change', _cambiarTipoItem);
            document.getElementById('cmp-i-agregar').addEventListener('click', _agregarItem);
            document.getElementById('cmp-recibir').addEventListener('click', _recibir);
        }
        document.getElementById('cmp-emitir')?.addEventListener('click', _emitir);
        document.getElementById('cmp-anular')?.addEventListener('click', _anular);
    }

    function _cambiarTipoItem(e) {
        const v = e.target.value;
        const esNuevo  = v === '__nuevo__';
        const esInsumo = v === '__insumo__';

        document.getElementById('cmp-i-libre-wrap').classList.toggle('oculto', !esNuevo && !esInsumo);
        document.getElementById('cmp-i-codigo-wrap').classList.toggle('oculto', !esNuevo);

        const opt = e.target.selectedOptions[0];
        if (opt?.dataset.costo) document.getElementById('cmp-i-costo').value = opt.dataset.costo;
    }

    async function _cargarItems() {
        const cont = document.getElementById('cmp-items');
        if (!cont || !_abierta) return;

        try {
            const { data: items, error } = await db.from('taller_compras_items')
                .select('*').eq('compra_id', _abierta.id).order('created_at');
            if (error) throw error;

            const editable = _abierta.estado === 'borrador' || _abierta.estado === 'emitida';

            if (!items || items.length === 0) {
                cont.innerHTML = `<div class="placeholder-text" style="padding:1.2rem">
                    Sin ítems todavía.</div>`;
            } else {
                cont.innerHTML = `
                <table class="tll-tabla">
                    <thead><tr>
                        <th>Código</th><th>Descripción</th>
                        <th style="text-align:right">Cant.</th>
                        <th style="text-align:right">Costo neto</th>
                        <th style="text-align:right">Subtotal</th>${editable ? '<th></th>' : ''}
                    </tr></thead>
                    <tbody>
                    ${items.map(i => `
                        <tr>
                            <td style="font-family:var(--font-mono)">
                                ${i.repuesto_codigo
                                    ? esc(i.repuesto_codigo)
                                    : '<span style="color:var(--text-muted)">insumo</span>'}</td>
                            <td>${esc(i.descripcion)}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${_fmtCant(i.cantidad)}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(i.costo_unitario)}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(i.subtotal)}</td>
                            ${editable ? `<td style="text-align:right">
                                <button class="tll-btn tll-btn--danger cmp-i-quitar" data-id="${i.id}">✕</button></td>` : ''}
                        </tr>`).join('')}
                    </tbody>
                </table>`;

                cont.querySelectorAll('.cmp-i-quitar').forEach(b =>
                    b.addEventListener('click', () => _quitarItem(b.dataset.id)));
            }

            const neto  = (items || []).reduce((s, i) => s + _num(i.subtotal), 0);
            const iva   = Math.round(neto * IVA_TASA);

            document.getElementById('cmp-totales').innerHTML = `
                <span style="display:flex;justify-content:space-between">
                    <span>Neto</span><strong>${fmtCLP(neto)}</strong></span>
                <span style="display:flex;justify-content:space-between">
                    <span>IVA ${Math.round(IVA_TASA * 100)}% (crédito fiscal)</span><strong>${fmtCLP(iva)}</strong></span>
                <span style="display:flex;justify-content:space-between;font-size:1.05rem;margin-top:0.3rem">
                    <span>Total a pagar</span>
                    <strong style="color:var(--accent)">${fmtCLP(neto + iva)}</strong></span>`;

            // Mantener los totales guardados al día mientras se edita
            if (editable) {
                await db.from('taller_compras')
                    .update({ neto, iva, total: neto + iva }).eq('id', _abierta.id);
                Object.assign(_abierta, { neto, iva, total: neto + iva });
            }
        } catch (err) {
            console.error('[Compras] items:', err);
        }
    }

    async function _agregarItem() {
        if (!_abierta) return;

        const sel      = document.getElementById('cmp-i-repuesto');
        const seleccion = sel.value;
        const cantidad  = _num(document.getElementById('cmp-i-cantidad').value);
        const costo     = _num(document.getElementById('cmp-i-costo').value);

        if (!seleccion) { avisar('Selecciona el repuesto o insumo', 'error'); return; }
        if (cantidad <= 0) { avisar('Cantidad inválida', 'error'); return; }

        let codigo = null, descripcion = '';

        if (seleccion === '__insumo__') {
            descripcion = document.getElementById('cmp-i-descripcion').value.trim();
            if (!descripcion) { avisar('Describe el insumo', 'error'); return; }

        } else if (seleccion === '__nuevo__') {
            codigo      = document.getElementById('cmp-i-codigo').value.trim().toUpperCase();
            descripcion = document.getElementById('cmp-i-descripcion').value.trim();
            if (!codigo || !descripcion) { avisar('El repuesto nuevo necesita código y descripción', 'error'); return; }
            if (_repuestos.some(r => r.codigo === codigo)) {
                avisar(`El código ${codigo} ya existe: selecciónalo de la lista`, 'error'); return;
            }
        } else {
            codigo = seleccion;
            descripcion = _repuestos.find(r => r.codigo === codigo)?.nombre || codigo;
        }

        const btn = document.getElementById('cmp-i-agregar');
        btn.disabled = true;

        try {
            const eid = window.appData.usuario.empresa_id;

            // Crear el repuesto en el catálogo, con stock 0: lo sube la recepción
            if (seleccion === '__nuevo__') {
                const { error: errRep } = await db.from('taller_repuestos').insert({
                    empresa_id: eid, codigo, nombre: descripcion,
                    unidad: 'unidad', stock: 0, precio_costo: costo,
                    precio_venta: 0, stock_minimo: 0, activo: true
                });
                if (errRep) throw errRep;
                avisar(`Repuesto ${codigo} creado en el catálogo — ponle precio de venta en Inventario`);
            }

            const { error } = await db.from('taller_compras_items').insert({
                empresa_id: eid,
                compra_id: _abierta.id,
                repuesto_codigo: codigo,
                descripcion,
                cantidad,
                costo_unitario: costo,
                subtotal: Math.round(cantidad * costo)
            });
            if (error) throw error;

            document.getElementById('cmp-i-cantidad').value = 1;
            document.getElementById('cmp-i-costo').value = 0;
            document.getElementById('cmp-i-descripcion').value = '';
            document.getElementById('cmp-i-codigo').value = '';
            sel.value = '';
            sel.dispatchEvent(new Event('change'));

            await _cargarItems();
            if (seleccion === '__nuevo__') await recargar();
        } catch (err) {
            console.error('[Compras] agregar item:', err);
            avisar(err.code === '23505' ? 'Ese código de repuesto ya existe' : 'Error al agregar el ítem', 'error');
        }
        btn.disabled = false;
    }

    async function _quitarItem(id) {
        try {
            const { error } = await db.from('taller_compras_items').delete().eq('id', id);
            if (error) throw error;
            await _cargarItems();
        } catch (err) {
            console.error('[Compras] quitar item:', err);
            avisar('Error al quitar el ítem', 'error');
        }
    }

    // ── Acciones ──────────────────────────────────────────────────
    async function _emitir() {
        try {
            const { error } = await db.from('taller_compras')
                .update({ estado: 'emitida' }).eq('id', _abierta.id);
            if (error) throw error;
            avisar(`Orden N° ${_abierta.numero} marcada como emitida`);
            cerrarModal();
            await recargar();
        } catch (err) {
            console.error('[Compras] emitir:', err);
            avisar('No se pudo emitir la orden', 'error');
        }
    }

    async function _recibir() {
        if (!_abierta) return;

        if (!confirm(
            `Recibir la mercadería de la OC N° ${_abierta.numero}.\n\n` +
            `Sube el stock de cada repuesto, recalcula el costo promedio ` +
            `y deja la cuenta por pagar por ${fmtCLP(_abierta.total)}.\n\n` +
            `Esto no se deshace sin anular la compra. ¿Continuar?`)) return;

        const btn = document.getElementById('cmp-recibir');
        btn.disabled = true;

        const res = await _rpc('fn_recibir_compra', {
            p_empresa_id: window.appData.usuario.empresa_id,
            p_compra_id: _abierta.id,
            p_usuario: window.appData.usuario.rut
        });

        if (!res) { btn.disabled = false; return; }
        if (!res.ok) { avisar(res.error || 'No se pudo recibir', 'error'); btn.disabled = false; return; }

        avisar(`Mercadería recibida · ${res.items_en_stock} repuesto(s) en stock · ` +
               `vence ${fmtFecha(res.vencimiento)}`);
        cerrarModal();
        await recargar();
    }

    async function _anular() {
        if (!_abierta) return;

        const motivo = prompt(
            `Anular la OC N° ${_abierta.numero}.\n\n` +
            (_abierta.estado === 'recibida'
                ? 'Se devolverá el stock que trajo esta compra.\n\n'
                : '') + 'Motivo:');
        if (motivo === null) return;

        const res = await _rpc('fn_anular_compra', {
            p_empresa_id: window.appData.usuario.empresa_id,
            p_compra_id: _abierta.id,
            p_motivo: motivo.trim() || null,
            p_usuario: window.appData.usuario.rut
        });

        if (!res) return;
        if (!res.ok) { avisar(res.error || 'No se pudo anular', 'error'); return; }

        avisar(`Orden N° ${_abierta.numero} anulada`);
        cerrarModal();
        await recargar();
    }

    // ── Helpers ───────────────────────────────────────────────────
    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Compras] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/05_compras_cxp.sql (${nombre})`
                : 'Error en la operación. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _badge(estado) {
        return { borrador: 'diagnostico', emitida: 'aprobada',
                 recibida: 'lista', anulada: 'anulada' }[estado] || 'entregada';
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function _fmtCant(v) {
        const n = _num(v);
        return Number.isInteger(n) ? String(n) : n.toLocaleString('es-CL', { maximumFractionDigits: 2 });
    }

    function _hoy() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    return { init, recargar };

})();
