// ================================================================
// modulo-ordenes.js — Órdenes de trabajo del taller
// Flujo (12 estados): recepcion → diagnostico → diagnostico_terminado
//   → presupuesto → aprobada/rechazado → esperando_repuestos
//   → reparacion → trabajo_terminado → lista → entregada (+ anulada)
// Los estados y sus transiciones se leen de la base
// (taller_ot_estados / taller_ot_transiciones, ver sql/20); si no
// están, se usa el fallback de config.js.
// Correlativo vía RPC fn_taller_siguiente_numero.
// Repuestos descuentan/devuelven stock SOLO vía RPC (FOR UPDATE).
// ================================================================

const ModuloOrdenes = (() => {

    let _ordenes   = [];
    let _clientes  = [];
    let _vehiculos = [];
    let _repuestos = [];
    let _empleados = [];
    let _estados      = [];      // [{codigo, etiqueta, posicion, ...}]
    let _transiciones = null;    // { desde: [hasta, ...] }  o null → fallback
    let _catalogosListos = false;
    let _ordenAbierta = null;   // orden en el modal de detalle
    let _filtroEstado = 'activas';

    // ── Estados y transiciones (base → fallback config.js) ────────
    async function _cargarEstados() {
        if (_estados.length) return;
        try {
            const [eRes, tRes] = await Promise.all([
                db.from('taller_ot_estados').select('*').eq('activo', true).order('posicion'),
                db.from('taller_ot_transiciones').select('desde, hasta')
            ]);
            if (!eRes.error && eRes.data?.length) {
                _estados = eRes.data;
            }
            if (!tRes.error && tRes.data?.length) {
                _transiciones = {};
                tRes.data.forEach(({ desde, hasta }) => {
                    (_transiciones[desde] = _transiciones[desde] || []).push(hasta);
                });
            }
        } catch (err) {
            console.warn('[Órdenes] estados desde la base:', err);
        }
        if (!_estados.length) {
            _estados = OT_ESTADOS.map((codigo, i) => ({
                codigo, etiqueta: otEstadoLabel(codigo), posicion: (i + 1) * 10
            }));
        }
    }

    function _estadoOpciones(seleccionado, filtro) {
        return _estados
            .filter(e => !filtro || filtro(e.codigo))
            .map(e => `<option value="${e.codigo}" ${e.codigo === seleccionado ? 'selected' : ''}>`
                    + `${esc(e.etiqueta)}</option>`)
            .join('');
    }

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-ordenes');
        if (!cont) return;

        await _cargarEstados();

        cont.innerHTML = `
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="ot-nueva">+ Nueva orden</button>
                <select class="tll-select" id="ot-filtro" style="max-width:190px">
                    <option value="activas">En curso</option>
                    <option value="todas">Todas</option>
                    ${_estados.map(e => `<option value="${e.codigo}">${esc(e.etiqueta)}</option>`).join('')}
                </select>
                <input class="tll-input" id="ot-buscar" placeholder="Buscar por N°, patente o cliente…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="ot-reload">↻ Actualizar</button>
            </div>
            <div id="ot-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('ot-nueva').addEventListener('click', _abrirNueva);
        document.getElementById('ot-reload').addEventListener('click', recargar);
        document.getElementById('ot-buscar').addEventListener('input', _renderLista);
        document.getElementById('ot-filtro').addEventListener('change', (e) => {
            _filtroEstado = e.target.value;
            recargar();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            let query = db.from('taller_ordenes')
                .select('*, taller_vehiculos(patente, marca, modelo), taller_clientes(nombre, telefono)')
                .eq('empresa_id', eid)
                .order('numero', { ascending: false })
                .limit(200);

            if (_filtroEstado === 'activas') {
                query = query.not('estado', 'in', '("entregada","anulada")');
            } else if (_filtroEstado !== 'todas') {
                query = query.eq('estado', _filtroEstado);
            }

            const [oRes, cRes, vRes, rRes, eRes] = await Promise.all([
                query,
                db.from('taller_clientes').select('id, nombre, rut')
                    .eq('empresa_id', eid).eq('activo', true).order('nombre'),
                db.from('taller_vehiculos').select('id, patente, marca, modelo, cliente_id, kilometraje')
                    .eq('empresa_id', eid).eq('activo', true).order('patente'),
                db.from('taller_repuestos').select('id, codigo, nombre, precio_venta, stock, unidad')
                    .eq('empresa_id', eid).eq('activo', true).order('nombre'),
                db.from('taller_empleados').select('id, nombre, cargo')
                    .eq('empresa_id', eid).eq('activo', true).order('nombre')
            ]);

            if (oRes.error) throw oRes.error;
            [['clientes', cRes], ['vehículos', vRes], ['repuestos', rRes], ['empleados', eRes]]
                .filter(([, r]) => r.error)
                .forEach(([n, r]) => console.warn('[Órdenes] catálogo ' + n + ':', r.error));
            _ordenes   = oRes.data || [];
            _clientes  = cRes.data || [];
            _vehiculos = vRes.data || [];
            _repuestos = rRes.data || [];
            _empleados = eRes.data || [];
            _catalogosListos = true;
            _renderLista();
        } catch (err) {
            console.error('[Órdenes] cargar:', err);
            avisar('Error cargando órdenes', 'error');
        }
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('ot-lista');
        if (!cont) return;

        const q = (document.getElementById('ot-buscar')?.value || '').toLowerCase();
        const filtradas = q
            ? _ordenes.filter(o =>
                String(o.numero).includes(q) ||
                (o.taller_vehiculos?.patente || '').toLowerCase().includes(q) ||
                (o.taller_clientes?.nombre || '').toLowerCase().includes(q))
            : _ordenes;

        if (filtradas.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_ordenes.length === 0
                    ? 'Sin órdenes en esta vista. Crea una con <strong>+ Nueva orden</strong>.'
                    : 'Sin resultados para esa búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>N°</th><th>Patente</th><th>Cliente</th><th>Motivo</th>
                <th>Estado</th><th>Ingreso</th><th>Total</th><th></th>
            </tr></thead>
            <tbody>
            ${filtradas.map(o => `
                <tr>
                    <td style="font-family:var(--font-mono)"><strong>${esc(o.numero)}</strong></td>
                    <td style="font-family:var(--font-mono)">${esc(o.taller_vehiculos?.patente) || '—'}</td>
                    <td>${esc(o.taller_clientes?.nombre) || '—'}</td>
                    <td>${esc(o.motivo_ingreso) || '—'}</td>
                    <td><span class="tll-badge ${otEstadoClase(o.estado)}">${esc(otEstadoLabel(o.estado))}</span></td>
                    <td>${fmtFecha(o.fecha_ingreso)}</td>
                    <td style="font-family:var(--font-mono)">${fmtCLP(o.total)}</td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost ot-abrir" data-id="${o.id}">Abrir</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        cont.querySelectorAll('.ot-abrir').forEach(btn =>
            btn.addEventListener('click', () =>
                _abrirDetalle(_ordenes.find(o => o.id === btn.dataset.id))));
    }

    // ── Nueva orden (recepción) ───────────────────────────────────
    function _abrirNueva() {
        if (_clientes.length === 0) {
            avisar('Primero crea un cliente en el módulo Clientes', 'error');
            return;
        }

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Nueva orden de trabajo · Recepción</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Cliente *</label>
                <select class="tll-select" id="ot-f-cliente">
                    <option value="">— Selecciona —</option>
                    ${_clientes.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Vehículo *</label>
                <select class="tll-select" id="ot-f-vehiculo" disabled>
                    <option value="">— Primero el cliente —</option>
                </select>
            </div>
            <div class="tll-field">
                <label>Kilometraje de ingreso</label>
                <input class="tll-input" id="ot-f-km" type="number" min="0">
            </div>
            <div class="tll-field">
                <label>Nivel de combustible</label>
                <select class="tll-select" id="ot-f-combustible">
                    <option value="">—</option>
                    <option value="1/4">1/4</option>
                    <option value="1/2">1/2</option>
                    <option value="3/4">3/4</option>
                    <option value="lleno">Lleno</option>
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <label>Motivo de ingreso (lo que declara el cliente) *</label>
                <textarea class="tll-textarea" id="ot-f-motivo"
                    placeholder="Ej: ruido al frenar, pérdida de potencia, mantención 40.000 km…"></textarea>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="ot-crear">Recepcionar vehículo</button>
        </div>`);

        // Al elegir cliente → cargar sus vehículos
        document.getElementById('ot-f-cliente').addEventListener('change', (e) => {
            const sel = document.getElementById('ot-f-vehiculo');
            const delCliente = _vehiculos.filter(v => v.cliente_id === e.target.value);
            if (delCliente.length === 0) {
                sel.innerHTML = '<option value="">Este cliente no tiene vehículos — créalo en Vehículos</option>';
                sel.disabled = true;
            } else {
                sel.innerHTML = '<option value="">— Selecciona —</option>' +
                    delCliente.map(v => `<option value="${v.id}" data-km="${v.kilometraje || 0}">
                        ${esc(v.patente)} · ${esc([v.marca, v.modelo].filter(Boolean).join(' '))}
                    </option>`).join('');
                sel.disabled = false;
            }
        });

        // Al elegir vehículo → sugerir su último kilometraje
        document.getElementById('ot-f-vehiculo').addEventListener('change', (e) => {
            const opt = e.target.selectedOptions[0];
            if (opt?.dataset.km && !document.getElementById('ot-f-km').value) {
                document.getElementById('ot-f-km').value = opt.dataset.km;
            }
        });

        document.getElementById('ot-crear').addEventListener('click', _crearOrden);
    }

    async function _crearOrden() {
        const clienteId  = document.getElementById('ot-f-cliente').value;
        const vehiculoId = document.getElementById('ot-f-vehiculo').value;
        const motivo     = document.getElementById('ot-f-motivo').value.trim();

        if (!clienteId || !vehiculoId) { avisar('Cliente y vehículo son obligatorios', 'error'); return; }
        if (!motivo) { avisar('Describe el motivo de ingreso', 'error'); return; }

        const btn = document.getElementById('ot-crear');
        btn.disabled = true;

        try {
            const eid = window.appData.usuario.empresa_id;
            const km  = parseInt(document.getElementById('ot-f-km').value) || null;

            // 1. Correlativo por empresa (RPC, sin race conditions)
            const { data: numero, error: errNum } = await db.rpc('fn_taller_siguiente_numero', {
                p_empresa_id: eid, p_tipo: 'orden'
            });
            if (errNum) throw errNum;

            // 2. Insertar la orden
            const { data: creada, error } = await db.from('taller_ordenes').insert({
                empresa_id: eid,
                numero,
                cliente_id: clienteId,
                vehiculo_id: vehiculoId,
                estado: 'recepcion',
                kilometraje_ingreso: km,
                nivel_combustible: document.getElementById('ot-f-combustible').value || null,
                motivo_ingreso: motivo,
                usuario_creacion: window.appData.usuario.rut
            }).select().single();
            if (error) throw error;

            // 3. Actualizar el kilometraje del vehículo (dato vivo)
            if (km) {
                await db.from('taller_vehiculos')
                    .update({ kilometraje: km }).eq('id', vehiculoId);
            }

            avisar(`Orden N° ${numero} creada`);
            cerrarModal();
            await recargar();
            _abrirDetalle(_ordenes.find(o => o.id === creada.id) || creada);

        } catch (err) {
            console.error('[Órdenes] crear:', err);
            btn.disabled = false;
            avisar('Error al crear la orden. Revisa la consola.', 'error');
        }
    }

    // ── Detalle de orden ──────────────────────────────────────────
    async function _abrirDetalle(orden) {
        if (!orden) return;
        _ordenAbierta = orden;

        const veh = orden.taller_vehiculos || _vehiculos.find(v => v.id === orden.vehiculo_id) || {};
        const cli = orden.taller_clientes || _clientes.find(c => c.id === orden.cliente_id) || {};
        const cerrada = orden.estado === 'entregada' || orden.estado === 'anulada';

        abrirModal(`
        <div class="tll-modal-header">
            <h3>OT N° ${esc(orden.numero)}
                <span class="tll-badge ${otEstadoClase(orden.estado)}" style="margin-left:0.5rem">${esc(otEstadoLabel(orden.estado))}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>

        <div class="tll-form-grid" style="margin-bottom:1rem">
            <div class="tll-field">
                <label>Vehículo</label>
                <div style="font-family:var(--font-mono)">${esc(veh.patente) || '—'}</div>
                <div style="font-size:0.78rem;color:var(--text-secondary)">
                    ${esc([veh.marca, veh.modelo].filter(Boolean).join(' '))}</div>
            </div>
            <div class="tll-field">
                <label>Cliente</label>
                <div>${esc(cli.nombre) || '—'}</div>
                <div style="font-size:0.78rem;color:var(--text-secondary)">${esc(cli.telefono) || ''}</div>
            </div>
            ${_empleados.length === 0 ? '' : `
            <div class="tll-field">
                <label>Mecánico a cargo</label>
                ${cerrada
                    ? `<div>${esc(_empleados.find(e => e.id === orden.mecanico_id)?.nombre) || '—'}</div>`
                    : `<select class="tll-select" id="ot-d-mecanico">
                        <option value="">— Sin asignar —</option>
                        ${_empleados.map(e => `<option value="${e.id}" ${orden.mecanico_id === e.id ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}
                       </select>`}
            </div>`}
            <div class="tll-field">
                <label>Ingreso</label>
                <div>${fmtFecha(orden.fecha_ingreso)}
                    ${orden.kilometraje_ingreso ? `· <span style="font-family:var(--font-mono)">${orden.kilometraje_ingreso.toLocaleString('es-CL')} km</span>` : ''}
                </div>
            </div>
        </div>

        <div class="tll-field tll-field--full" style="margin-bottom:0.8rem">
            <label>Motivo de ingreso</label>
            <div style="font-size:0.85rem">${esc(orden.motivo_ingreso) || '—'}</div>
        </div>

        ${(Array.isArray(orden.danos_recepcion) && orden.danos_recepcion.length) || orden.recepcion_observaciones ? `
        <div class="tll-field tll-field--full" style="margin-bottom:0.8rem">
            <label>Estado al ingresar</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.3rem">
                ${(orden.danos_recepcion || []).map(d => `<span class="tll-badge diagnostico">${esc(d.tipo)} · ${esc(d.zona)}${d.nota ? ' (' + esc(d.nota) + ')' : ''}</span>`).join('')}
            </div>
            ${orden.recepcion_observaciones ? `<div style="font-size:0.82rem;color:var(--text-secondary)">${esc(orden.recepcion_observaciones)}</div>` : ''}
        </div>` : ''}

        <div class="tll-form-grid" style="margin-bottom:1rem">
            <div class="tll-field tll-field--full">
                <label>Diagnóstico</label>
                <textarea class="tll-textarea" id="ot-d-diagnostico" ${cerrada ? 'disabled' : ''}>${esc(orden.diagnostico || '')}</textarea>
            </div>
            <div class="tll-field tll-field--full">
                <label>Trabajos realizados</label>
                <textarea class="tll-textarea" id="ot-d-trabajos" ${cerrada ? 'disabled' : ''}>${esc(orden.trabajos_realizados || '')}</textarea>
            </div>
        </div>

        <div class="panel-header" style="margin-bottom:0.8rem">
            <h2 style="font-size:0.95rem">Repuestos y mano de obra</h2>
        </div>
        <div id="ot-items"></div>

        ${!cerrada ? `
        <div class="tll-form-grid" style="margin-top:0.8rem;align-items:end">
            <div class="tll-field">
                <label>Tipo</label>
                <select class="tll-select" id="ot-i-tipo">
                    <option value="repuesto">Repuesto</option>
                    <option value="mano_obra">Mano de obra</option>
                </select>
            </div>
            <div class="tll-field tll-field--full" id="ot-i-rep-wrap" style="grid-column:span 2">
                <label>Repuesto</label>
                <select class="tll-select" id="ot-i-repuesto">
                    <option value="">— Selecciona —</option>
                    ${_repuestos.map(r => `
                        <option value="${r.codigo}" data-precio="${r.precio_venta}" data-stock="${r.stock}">
                            ${esc(r.nombre)} · stock ${r.stock} · ${fmtCLP(r.precio_venta)}
                        </option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full oculto" id="ot-i-desc-wrap" style="grid-column:span 2">
                <label>Descripción</label>
                <input class="tll-input" id="ot-i-descripcion" placeholder="Ej: cambio de pastillas y rectificado de discos">
            </div>
            <div class="tll-field">
                <label>Cantidad</label>
                <input class="tll-input" id="ot-i-cantidad" type="number" min="0.5" step="0.5" value="1">
            </div>
            <div class="tll-field">
                <label>Precio unit.</label>
                <input class="tll-input" id="ot-i-precio" type="number" min="0" value="0">
            </div>
            <div class="tll-field">
                <label>&nbsp;</label>
                <button class="tll-btn tll-btn--primary" id="ot-i-agregar" style="width:100%">+ Agregar</button>
            </div>
        </div>` : ''}

        <div class="tll-ot-totales" id="ot-totales"></div>

        <details class="tll-ot-actividad" style="margin-top:0.75rem">
            <summary style="cursor:pointer;color:var(--text-secondary);font-size:0.85rem">Actividad y avisos al cliente</summary>
            <div id="ot-actividad" style="margin-top:0.5rem"><span style="color:var(--text-muted);font-size:0.8rem">Cargando…</span></div>
        </details>

        <div class="tll-modal-footer">
            ${!cerrada ? `
            <select class="tll-select" id="ot-d-estado" style="max-width:210px">
                ${_estadoOpciones(orden.estado, e => _transicionValida(orden.estado, e))}
            </select>
            <div class="tll-toolbar-sep"></div>
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cerrar</button>
            <button class="tll-btn tll-btn--primary" id="ot-d-guardar">Guardar cambios</button>
            ` : `<button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cerrar</button>`}
        </div>`, '760px');

        await _cargarItems();
        _cargarActividad(orden.id);

        if (!cerrada) {
            // Alternar repuesto / mano de obra
            document.getElementById('ot-i-tipo').addEventListener('change', (e) => {
                const esRepuesto = e.target.value === 'repuesto';
                document.getElementById('ot-i-rep-wrap').classList.toggle('oculto', !esRepuesto);
                document.getElementById('ot-i-desc-wrap').classList.toggle('oculto', esRepuesto);
            });

            // Precio sugerido al elegir repuesto
            document.getElementById('ot-i-repuesto').addEventListener('change', (e) => {
                const opt = e.target.selectedOptions[0];
                if (opt?.dataset.precio) {
                    document.getElementById('ot-i-precio').value = opt.dataset.precio;
                }
            });

            document.getElementById('ot-i-agregar').addEventListener('click', _agregarItem);
            document.getElementById('ot-d-guardar').addEventListener('click', _guardarDetalle);
        }
    }

    /** Línea de tiempo de estados + avisos enviados al cliente. Silencioso
        si faltan los scripts SQL de la integración. */
    async function _cargarActividad(ordenId) {
        const cont = document.getElementById('ot-actividad');
        if (!cont) return;
        try {
            const [tl, nt] = await Promise.all([
                db.from('v_taller_ot_timeline').select('estado_nuevo, estado_etiqueta, ts, origen')
                    .eq('orden_id', ordenId).order('ts'),
                db.from('taller_notificacion_eventos')
                    .select('titulo, creado_at, taller_notificaciones(canal, estado)')
                    .eq('orden_id', ordenId).order('creado_at')
            ]);
            if (tl.error && nt.error) { cont.innerHTML = ''; return; }

            const filas = [];
            (tl.data || []).forEach(h => filas.push({
                t: h.ts,
                txt: `${esc(h.estado_etiqueta || h.estado_nuevo)}${h.origen && h.origen !== 'sistema' ? ' · ' + esc(h.origen) : ''}`,
                tipo: 'estado'
            }));
            (nt.data || []).forEach(e => {
                const canales = (e.taller_notificaciones || [])
                    .map(n => `${n.canal === 'mi_vehiculo' ? 'Mi Vehículo' : n.canal}${n.estado !== 'pendiente' ? ' (' + n.estado + ')' : ''}`)
                    .join(', ');
                filas.push({
                    t: e.creado_at,
                    txt: `📣 ${esc(e.titulo)}${canales ? ' → ' + esc(canales) : ' → sin canal'}`,
                    tipo: 'aviso'
                });
            });
            filas.sort((a, b) => new Date(a.t) - new Date(b.t));

            cont.innerHTML = filas.length === 0
                ? '<span style="color:var(--text-muted);font-size:0.8rem">Sin actividad registrada.</span>'
                : `<ul style="list-style:none;padding:0;margin:0;font-size:0.82rem;line-height:1.6">
                    ${filas.map(f => `<li>
                        <span style="color:var(--text-muted);font-family:var(--font-mono)">${fmtFecha(f.t)}</span>
                        · ${f.txt}</li>`).join('')}
                   </ul>`;
        } catch (err) {
            console.warn('[Órdenes] actividad:', err);
            cont.innerHTML = '';
        }
    }

    async function _cargarItems() {
        const cont = document.getElementById('ot-items');
        if (!cont || !_ordenAbierta) return;

        try {
            const { data: items, error } = await db
                .from('taller_ordenes_items')
                .select('*')
                .eq('orden_id', _ordenAbierta.id)
                .order('created_at');
            if (error) throw error;

            const cerrada = _ordenAbierta.estado === 'entregada' || _ordenAbierta.estado === 'anulada';

            if (!items || items.length === 0) {
                cont.innerHTML = `<div class="placeholder-text" style="padding:1.2rem">Sin repuestos ni mano de obra aún.</div>`;
            } else {
                cont.innerHTML = `
                <table class="tll-tabla">
                    <thead><tr>
                        <th>Tipo</th><th>Descripción</th><th>Cant.</th>
                        <th>P. unit</th><th>Subtotal</th>${!cerrada ? '<th></th>' : ''}
                    </tr></thead>
                    <tbody>
                    ${items.map(i => `
                        <tr>
                            <td>${i.tipo === 'repuesto' ? '🔩 Repuesto' : '🔧 M. obra'}</td>
                            <td>${esc(i.descripcion)}</td>
                            <td style="font-family:var(--font-mono)">${i.cantidad}</td>
                            <td style="font-family:var(--font-mono)">${fmtCLP(i.precio_unitario)}</td>
                            <td style="font-family:var(--font-mono)">${fmtCLP(i.subtotal)}</td>
                            ${!cerrada ? `<td style="text-align:right">
                                <button class="tll-btn tll-btn--danger ot-i-quitar" data-id="${i.id}"
                                        data-tipo="${i.tipo}" data-codigo="${i.articulo_codigo || ''}"
                                        data-cantidad="${i.cantidad}">Quitar</button></td>` : ''}
                        </tr>`).join('')}
                    </tbody>
                </table>`;

                cont.querySelectorAll('.ot-i-quitar').forEach(btn =>
                    btn.addEventListener('click', () => _quitarItem(btn.dataset)));
            }

            // Totales
            const totRep = (items || []).filter(i => i.tipo === 'repuesto')
                .reduce((s, i) => s + Number(i.subtotal), 0);
            const totMO = (items || []).filter(i => i.tipo === 'mano_obra')
                .reduce((s, i) => s + Number(i.subtotal), 0);

            document.getElementById('ot-totales').innerHTML = `
                <span>Repuestos: <strong>${fmtCLP(totRep)}</strong></span>
                <span>Mano de obra: <strong>${fmtCLP(totMO)}</strong></span>
                <span>Total: <strong style="color:var(--accent)">${fmtCLP(totRep + totMO)}</strong></span>`;

            // Persistir totales solo en órdenes abiertas: una entregada o
            // anulada es un documento cerrado y no debe reescribirse al mirarla.
            if (!cerrada) {
                await db.from('taller_ordenes').update({
                    total_repuestos: totRep,
                    total_mano_obra: totMO,
                    total: totRep + totMO
                }).eq('id', _ordenAbierta.id);
                _ordenAbierta.total_repuestos = totRep;
                _ordenAbierta.total_mano_obra = totMO;
                _ordenAbierta.total = totRep + totMO;
            }

        } catch (err) {
            console.error('[Órdenes] items:', err);
        }
    }

    async function _agregarItem() {
        if (!_ordenAbierta) return;
        const tipo     = document.getElementById('ot-i-tipo').value;
        const cantidad = parseFloat(document.getElementById('ot-i-cantidad').value) || 0;
        const precio   = parseInt(document.getElementById('ot-i-precio').value) || 0;

        if (cantidad <= 0) { avisar('Cantidad inválida', 'error'); return; }

        let descripcion, codigo = null;

        if (tipo === 'repuesto') {
            const sel = document.getElementById('ot-i-repuesto');
            codigo = sel.value;
            if (!codigo) { avisar('Selecciona un repuesto', 'error'); return; }
            const rep = _repuestos.find(r => r.codigo === codigo);
            descripcion = rep ? rep.nombre : sel.selectedOptions[0].textContent.trim();
        } else {
            descripcion = document.getElementById('ot-i-descripcion').value.trim();
            if (!descripcion) { avisar('Describe la mano de obra', 'error'); return; }
        }

        const btn = document.getElementById('ot-i-agregar');
        btn.disabled = true;

        try {
            const eid = window.appData.usuario.empresa_id;

            // Repuesto: descontar stock PRIMERO vía RPC (lock en BD)
            if (tipo === 'repuesto') {
                const res = await _descontarStock(eid, codigo, cantidad);
                if (!res?.ok) { avisar(res?.error || 'No se pudo descontar stock', 'error'); btn.disabled = false; return; }
            }

            const { error } = await db.from('taller_ordenes_items').insert({
                empresa_id: eid,
                orden_id: _ordenAbierta.id,
                tipo,
                articulo_codigo: codigo,
                descripcion,
                cantidad,
                precio_unitario: precio,
                subtotal: Math.round(cantidad * precio)
            });
            if (error) throw error;

            document.getElementById('ot-i-cantidad').value = 1;
            document.getElementById('ot-i-precio').value = 0;
            if (tipo === 'mano_obra') document.getElementById('ot-i-descripcion').value = '';

            await _cargarItems();
            await _refrescarRepuestos();
        } catch (err) {
            console.error('[Órdenes] agregar item:', err);
            avisar('Error al agregar. Revisa la consola.', 'error');
        }
        btn.disabled = false;
    }

    /** Descuenta stock dejando el N° de OT en el kardex.
        Si aún no se aplicó sql/02_inventario.sql, la función sigue
        teniendo 3 parámetros: se reintenta con la firma antigua. */
    async function _descontarStock(eid, codigo, cantidad) {
        const completo = {
            p_empresa_id: eid, p_codigo: codigo, p_cantidad: cantidad,
            p_referencia: 'OT ' + _ordenAbierta.numero,
            p_usuario: window.appData.usuario.rut,
            p_motivo: 'orden_trabajo'
        };
        let { data, error } = await db.rpc('fn_descontar_stock_repuesto', completo);

        if (error && (error.code === 'PGRST202' || error.code === '42883')) {
            ({ data, error } = await db.rpc('fn_descontar_stock_repuesto', {
                p_empresa_id: eid, p_codigo: codigo, p_cantidad: cantidad
            }));
        }
        if (error) throw error;
        return data;
    }

    async function _quitarItem(ds) {
        try {
            const eid = window.appData.usuario.empresa_id;

            const { error } = await db.from('taller_ordenes_items')
                .delete().eq('id', ds.id);
            if (error) throw error;

            // Devolver stock si era repuesto (si falla, avisar: queda descuadrado)
            if (ds.tipo === 'repuesto' && ds.codigo) {
                const { error: errDev } = await db.rpc('fn_devolver_stock_repuesto', {
                    p_empresa_id: eid, p_codigo: ds.codigo, p_cantidad: parseFloat(ds.cantidad)
                });
                if (errDev) {
                    console.error('[Órdenes] devolver stock:', errDev);
                    avisar(`Ítem eliminado, pero NO se devolvió el stock de ${ds.codigo}. Ajústalo en Inventario.`, 'error');
                }
            }

            await _cargarItems();
            await _refrescarRepuestos();
        } catch (err) {
            console.error('[Órdenes] quitar item:', err);
            avisar('Error al quitar el ítem', 'error');
        }
    }

    async function _refrescarRepuestos() {
        // Refrescar stocks del select sin recargar todo el modal
        const { data } = await db.from('taller_repuestos')
            .select('id, codigo, nombre, precio_venta, stock, unidad')
            .eq('empresa_id', window.appData.usuario.empresa_id)
            .eq('activo', true).order('nombre');
        _repuestos = data || [];

        const sel = document.getElementById('ot-i-repuesto');
        if (sel) {
            const valor = sel.value;
            sel.innerHTML = '<option value="">— Selecciona —</option>' +
                _repuestos.map(r => `
                    <option value="${r.codigo}" data-precio="${r.precio_venta}" data-stock="${r.stock}">
                        ${esc(r.nombre)} · stock ${r.stock} · ${fmtCLP(r.precio_venta)}
                    </option>`).join('');
            sel.value = valor;
        }
    }

    async function _guardarDetalle() {
        if (!_ordenAbierta) return;
        const btn = document.getElementById('ot-d-guardar');
        btn.disabled = true;

        try {
            const nuevoEstado = document.getElementById('ot-d-estado').value;

            if (!_transicionValida(_ordenAbierta.estado, nuevoEstado)) {
                avisar(`No se puede pasar de "${_ordenAbierta.estado}" a "${nuevoEstado}"`, 'error');
                btn.disabled = false;
                return;
            }

            if (nuevoEstado === 'entregada' && !await _confirmarCobro()) {
                btn.disabled = false;
                return;
            }

            const cambios = {
                diagnostico: document.getElementById('ot-d-diagnostico').value.trim() || null,
                trabajos_realizados: document.getElementById('ot-d-trabajos').value.trim() || null,
                estado: nuevoEstado
            };

            // Solo se manda si el módulo Empleados está en uso (si no, la
            // columna puede no existir todavía y el update fallaría entero)
            const selMec = document.getElementById('ot-d-mecanico');
            if (selMec) cambios.mecanico_id = selMec.value || null;
            if (nuevoEstado === 'entregada' && !_ordenAbierta.fecha_entrega) {
                cambios.fecha_entrega = new Date().toISOString();
            }

            const { error } = await db.from('taller_ordenes')
                .update(cambios).eq('id', _ordenAbierta.id);
            if (error) throw error;

            avisar(`Orden N° ${_ordenAbierta.numero} guardada`);
            cerrarModal();
            await recargar();
        } catch (err) {
            console.error('[Órdenes] guardar:', err);
            btn.disabled = false;
            avisar(/transici[oó]n de ot/i.test(err?.message || '')
                ? err.message
                : 'Error al guardar la orden', 'error');
        }
    }

    /** Antes de entregar el vehículo, revisar que la orden esté pagada.
        Si el taller no usa el módulo Caja, no hay nada que revisar. */
    async function _confirmarCobro() {
        if (!moduloHabilitado('caja', window.appData.empresa?.modulos_activos)) return true;

        try {
            const { data, error } = await db.from('v_taller_ordenes_saldo')
                .select('total, pagado, saldo')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .eq('orden_id', _ordenAbierta.id)
                .single();

            // Sin la vista creada todavía: no bloquear el trabajo del taller
            if (error) { console.warn('[Órdenes] saldo:', error); return true; }
            if (!data || Number(data.saldo) <= 0) return true;

            return confirm(
                `La orden N° ${_ordenAbierta.numero} tiene un saldo pendiente de ` +
                `${fmtCLP(data.saldo)} (total ${fmtCLP(data.total)}, pagado ${fmtCLP(data.pagado)}).\n\n` +
                `¿Entregar el vehículo igual y dejarla a crédito?`);
        } catch (err) {
            console.warn('[Órdenes] saldo:', err);
            return true;
        }
    }

    // ── Flujo de estados permitido ────────────────────────────────
    // El grafo vive en taller_ot_transiciones (sql/20). Si no cargó,
    // se usa OT_TRANSICIONES_DEFAULT de config.js. La base lo revalida
    // igual con un trigger, esto es solo para armar el menú.
    function _transicionValida(actual, nuevo) {
        if (actual === nuevo) return true;
        const grafo = _transiciones || OT_TRANSICIONES_DEFAULT;
        return (grafo[actual] || []).includes(nuevo);
    }

    // ── Abrir una orden por id (usado desde Recepción) ────────────
    async function abrirPorId(ordenId) {
        try {
            const eid = window.appData.usuario.empresa_id;

            await _cargarEstados();

            // Asegurar catálogos si el panel Órdenes aún no se abrió.
            // Incluye empleados: sin ellos el selector de mecánico no se
            // dibuja, y la OT quedaría sin quién comisiona.
            if (!_catalogosListos) {
                const [cRes, vRes, rRes, eRes] = await Promise.all([
                    db.from('taller_clientes').select('id, nombre, rut, telefono')
                        .eq('empresa_id', eid).eq('activo', true),
                    db.from('taller_vehiculos').select('id, patente, marca, modelo, cliente_id, kilometraje')
                        .eq('empresa_id', eid),
                    db.from('taller_repuestos').select('id, codigo, nombre, precio_venta, stock, unidad')
                        .eq('empresa_id', eid).eq('activo', true).order('nombre'),
                    db.from('taller_empleados').select('id, nombre, cargo')
                        .eq('empresa_id', eid).eq('activo', true).order('nombre')
                ]);
                _clientes  = cRes.data || [];
                _vehiculos = vRes.data || [];
                _repuestos = rRes.data || [];
                _empleados = eRes.data || [];
                _catalogosListos = true;
            }

            const { data: orden, error } = await db.from('taller_ordenes')
                .select('*, taller_vehiculos(patente, marca, modelo), taller_clientes(nombre, telefono)')
                .eq('id', ordenId)
                .single();
            if (error) throw error;

            _abrirDetalle(orden);
        } catch (err) {
            console.error('[Órdenes] abrirPorId:', err);
            avisar('No se pudo abrir la orden', 'error');
        }
    }

    return { init, recargar, abrirPorId };

})();
