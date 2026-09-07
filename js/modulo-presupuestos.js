// ================================================================
// modulo-presupuestos.js — Presupuestos como documento propio
// ================================================================
// Flujo: borrador → enviado → aprobado → convertido en OT.
//        (o rechazado / reemplazado por una versión nueva)
//
// Un presupuesto NO toca el stock. El stock se mueve una sola vez,
// al convertirlo en orden de trabajo. Ver sql/08_presupuestos.sql.
//
// El margen se muestra SIEMPRE mientras se cotiza: cotizar bajo costo
// es el error más caro y más silencioso de un taller.
// ================================================================

const ModuloPresupuestos = (() => {

    let _lista     = [];
    let _clientes  = [];
    let _vehiculos = [];
    let _repuestos = [];
    let _abierto   = null;
    let _filtro    = 'vigentes';

    const VIAS = [['presencial', 'En el taller'], ['telefono', 'Por teléfono'],
                  ['whatsapp', 'Por WhatsApp'], ['email', 'Por email'], ['otro', 'Otro']];

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-presupuestos');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-kpis" id="prs-kpis"></div>
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="prs-nuevo">+ Nuevo presupuesto</button>
                <select class="tll-select" id="prs-filtro" style="max-width:200px">
                    <option value="vigentes">Vigentes</option>
                    <option value="borrador">Borradores</option>
                    <option value="enviado">Enviados</option>
                    <option value="aprobado">Aprobados sin convertir</option>
                    <option value="rechazado">Rechazados</option>
                    <option value="vencidos">Vencidos</option>
                    <option value="todos">Todos</option>
                </select>
                <input class="tll-input" id="prs-buscar" placeholder="Buscar por N°, patente o cliente…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="prs-reload">↻ Actualizar</button>
            </div>
            <div id="prs-perdidos"></div>
            <div id="prs-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('prs-nuevo').addEventListener('click', () => abrirNuevo());
        document.getElementById('prs-reload').addEventListener('click', recargar);
        document.getElementById('prs-buscar').addEventListener('input', _renderLista);
        document.getElementById('prs-filtro').addEventListener('change', (e) => {
            _filtro = e.target.value;
            _renderLista();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [pRes, cRes, vRes, rRes] = await Promise.all([
                db.from('v_taller_presupuestos').select('*')
                  .eq('empresa_id', eid).order('numero', { ascending: false })
                  .order('version', { ascending: false }).range(0, 999),
                db.from('taller_clientes').select('id, nombre, rut, telefono')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre'),
                db.from('taller_vehiculos').select('id, patente, marca, modelo, cliente_id, kilometraje')
                  .eq('empresa_id', eid).eq('activo', true).order('patente').range(0, 4999),
                db.from('taller_repuestos').select('id, codigo, nombre, precio_venta, precio_costo, stock')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre').range(0, 4999)
            ]);

            if (pRes.error) throw pRes.error;
            _lista     = pRes.data || [];
            _clientes  = cRes.data || [];
            _vehiculos = vRes.data || [];
            _repuestos = rRes.data || [];
            _renderKpis();
            _renderLista();
        } catch (err) {
            console.error('[Presupuestos] cargar:', err);
            const cont = document.getElementById('prs-lista');
            if (cont) {
                cont.innerHTML = errorCarga(err, '08_presupuestos.sql', 'los presupuestos');
            }
        }
    }

    function _renderKpis() {
        const cont = document.getElementById('prs-kpis');
        if (!cont) return;

        const activos   = _lista.filter(p => p.estado !== 'reemplazado');
        const abiertos  = activos.filter(p => ['borrador', 'enviado'].includes(p.estado) && !p.vencido);
        const aprobados = activos.filter(p => p.estado === 'aprobado');
        const cerrados  = activos.filter(p => ['aprobado', 'convertido', 'rechazado'].includes(p.estado));
        const ganados   = activos.filter(p => ['aprobado', 'convertido'].includes(p.estado));
        const perdidos  = activos.filter(p => p.estado === 'rechazado');
        const tasa = cerrados.length ? Math.round(ganados.length / cerrados.length * 100) : 0;
        const montoPerdido = perdidos.reduce((s, p) => s + _num(p.total), 0);

        cont.innerHTML = `
            ${_kpi('📋', abiertos.length, 'Esperando respuesta')}
            ${_kpi('💰', fmtCLP(abiertos.reduce((s, p) => s + _num(p.total), 0)), 'Monto en juego')}
            ${_kpi('✅', aprobados.length, 'Aprobados por convertir',
                   aprobados.length ? '#34d399' : '')}
            ${_kpi('📈', tasa + '%', 'Tasa de conversión')}
            ${_kpi('📉', fmtCLP(montoPerdido), 'Perdido (rechazados)', montoPerdido ? '#f87171' : '')}`;

        _renderPerdidos(perdidos);
    }

    /** Desglose de por qué se pierden presupuestos. */
    function _renderPerdidos(perdidos) {
        const cont = document.getElementById('prs-perdidos');
        if (!cont) return;
        if (perdidos.length === 0) { cont.innerHTML = ''; return; }

        const ETIQ = { precio: 'Precio', postergado: 'Postergado', no_responde: 'No responde',
                       otro_taller: 'Otro taller', otro: 'Otro', sin_motivo: 'Sin registrar' };
        const porMotivo = {};
        perdidos.forEach(p => {
            const k = p.motivo_rechazo_cat || 'sin_motivo';
            porMotivo[k] = porMotivo[k] || { n: 0, monto: 0 };
            porMotivo[k].n++;
            porMotivo[k].monto += _num(p.total);
        });

        cont.innerHTML = `
        <details class="tll-rep-card" style="margin:0.5rem 0 1rem">
            <summary style="cursor:pointer;font-weight:600">📉 Presupuestos perdidos · ${perdidos.length}</summary>
            <table class="tll-tabla" style="margin-top:0.6rem">
                <thead><tr><th>Motivo</th><th>Cantidad</th><th>Monto</th></tr></thead>
                <tbody>
                ${Object.entries(porMotivo)
                    .sort((a, b) => b[1].monto - a[1].monto)
                    .map(([k, v]) => `<tr>
                        <td>${esc(ETIQ[k] || k)}</td>
                        <td style="font-family:var(--font-mono)">${v.n}</td>
                        <td style="font-family:var(--font-mono)">${fmtCLP(v.monto)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </details>`;
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('prs-lista');
        if (!cont) return;

        const q = (document.getElementById('prs-buscar')?.value || '').toLowerCase().trim();

        let lista = _lista.filter(p => {
            switch (_filtro) {
                case 'vigentes':  return ['borrador', 'enviado', 'aprobado'].includes(p.estado) && !p.vencido;
                case 'vencidos':  return p.vencido;
                case 'todos':     return true;
                case 'aprobado':  return p.estado === 'aprobado';
                default:          return p.estado === _filtro;
            }
        });

        if (q) {
            lista = lista.filter(p =>
                String(p.numero || '').includes(q) ||
                (p.patente || '').toLowerCase().includes(q) ||
                (p.cliente_nombre || '').toLowerCase().includes(q) ||
                (p.motivo || '').toLowerCase().includes(q));
        }

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_lista.length === 0
                    ? 'Sin presupuestos. Crea el primero con <strong>+ Nuevo presupuesto</strong>.'
                    : 'Sin resultados para ese filtro.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>N°</th><th>Vehículo</th><th>Cliente</th><th>Motivo</th>
                <th style="text-align:right">Total</th>
                <th style="text-align:right">Margen</th>
                <th>Estado</th><th>Vigencia</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(p => `
                <tr${['rechazado', 'reemplazado', 'anulado'].includes(p.estado) ? ' style="opacity:0.5"' : ''}>
                    <td style="font-family:var(--font-mono)"><strong>${esc(p.numero)}</strong>
                        ${p.version > 1 ? `<span class="tll-badge presupuesto">v${p.version}</span>` : ''}</td>
                    <td style="font-family:var(--font-mono)">${esc(p.patente) || '—'}
                        <div style="font-size:0.7rem;color:var(--text-secondary);font-family:inherit">
                            ${esc([p.marca, p.modelo].filter(Boolean).join(' '))}</div></td>
                    <td>${esc(p.cliente_nombre) || '—'}</td>
                    <td style="max-width:220px">${esc(p.motivo) || '—'}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(p.total)}</td>
                    <td style="text-align:right;font-family:var(--font-mono);
                               color:${_colorMargen(p.margen_pct)}">
                        ${_num(p.margen_pct).toFixed(0)}%</td>
                    <td>${_badge(p)}</td>
                    <td>${_vigencia(p)}</td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost prs-abrir" data-id="${p.id}">Abrir</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        cont.querySelectorAll('.prs-abrir').forEach(b =>
            b.addEventListener('click', () => abrirDetalle(_lista.find(p => p.id === b.dataset.id))));
    }

    // ── Nuevo ─────────────────────────────────────────────────────
    function abrirNuevo(preset = null) {
        if (_clientes.length === 0) {
            avisar('Primero crea un cliente en el módulo Clientes', 'error');
            return;
        }

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Nuevo presupuesto</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Cliente *</label>
                <select class="tll-select" id="prs-f-cliente">
                    <option value="">— Selecciona —</option>
                    ${_clientes.map(c => `
                        <option value="${c.id}" ${preset?.cliente_id === c.id ? 'selected' : ''}>
                            ${esc(c.nombre)}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Vehículo *</label>
                <select class="tll-select" id="prs-f-vehiculo" ${preset?.cliente_id ? '' : 'disabled'}>
                    <option value="">— Primero el cliente —</option>
                </select>
            </div>
            <div class="tll-field">
                <label>Kilometraje</label>
                <input class="tll-input" id="prs-f-km" type="number" min="0"
                       value="${preset?.kilometraje ?? ''}">
            </div>
            <div class="tll-field">
                <label>Validez (días)</label>
                <input class="tll-input" id="prs-f-validez" type="number" min="1" value="15">
                <span class="tll-field-msg">Con repuestos importados, 7 días es más realista.</span>
            </div>
            <div class="tll-field tll-field--full">
                <label>Motivo / lo que pide el cliente *</label>
                <textarea class="tll-textarea" id="prs-f-motivo"
                    placeholder="Ej: ruido al frenar, cotizar cambio de embrague">${esc(preset?.motivo || '')}</textarea>
            </div>
            <div class="tll-field tll-field--full">
                <label>Diagnóstico</label>
                <textarea class="tll-textarea" id="prs-f-diagnostico"></textarea>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="prs-f-crear">Crear y cotizar</button>
        </div>`, '660px');

        const selCli = document.getElementById('prs-f-cliente');
        const cargarVehiculos = () => {
            const sel = document.getElementById('prs-f-vehiculo');
            const suyos = _vehiculos.filter(v => v.cliente_id === selCli.value);
            if (suyos.length === 0) {
                sel.innerHTML = '<option value="">Sin vehículos — créalo en Vehículos</option>';
                sel.disabled = true;
                return;
            }
            sel.innerHTML = '<option value="">— Selecciona —</option>' +
                suyos.map(v => `<option value="${v.id}" data-km="${v.kilometraje || 0}"
                    ${preset?.vehiculo_id === v.id ? 'selected' : ''}>
                    ${esc(v.patente)} · ${esc([v.marca, v.modelo].filter(Boolean).join(' '))}
                </option>`).join('');
            sel.disabled = false;
        };
        selCli.addEventListener('change', cargarVehiculos);
        if (preset?.cliente_id) cargarVehiculos();

        document.getElementById('prs-f-vehiculo').addEventListener('change', (e) => {
            const km = e.target.selectedOptions[0]?.dataset.km;
            if (km && !document.getElementById('prs-f-km').value) {
                document.getElementById('prs-f-km').value = km;
            }
        });

        document.getElementById('prs-f-crear').addEventListener('click', _crear);
    }

    async function _crear() {
        const clienteId  = document.getElementById('prs-f-cliente').value;
        const vehiculoId = document.getElementById('prs-f-vehiculo').value;
        const motivo     = document.getElementById('prs-f-motivo').value.trim();

        if (!clienteId || !vehiculoId) { avisar('Cliente y vehículo son obligatorios', 'error'); return; }
        if (!motivo) { avisar('Describe qué se está cotizando', 'error'); return; }

        const btn = document.getElementById('prs-f-crear');
        btn.disabled = true;

        try {
            const eid = window.appData.usuario.empresa_id;

            const { data: max } = await db.from('taller_presupuestos')
                .select('numero').eq('empresa_id', eid)
                .order('numero', { ascending: false }).limit(1);
            const numero = (max?.[0]?.numero || 0) + 1;

            const { data: creado, error } = await db.from('taller_presupuestos').insert({
                empresa_id:   eid,
                numero,
                version:      1,
                cliente_id:   clienteId,
                vehiculo_id:  vehiculoId,
                estado:       'borrador',
                fecha_emision: _hoy(),
                dias_validez: Number(document.getElementById('prs-f-validez').value) || 15,
                kilometraje:  Number(document.getElementById('prs-f-km').value) || null,
                motivo,
                diagnostico:  document.getElementById('prs-f-diagnostico').value.trim() || null,
                usuario_rut:  window.appData.usuario.rut
            }).select().single();
            if (error) throw error;

            avisar(`Presupuesto N° ${numero} creado`);
            cerrarModal();
            await recargar();
            abrirDetalle(_lista.find(p => p.id === creado.id));
        } catch (err) {
            console.error('[Presupuestos] crear:', err);
            btn.disabled = false;
            avisar('Error al crear el presupuesto', 'error');
        }
    }

    // ── Detalle ───────────────────────────────────────────────────
    async function abrirDetalle(p) {
        if (!p) return;
        _abierto = p;

        const editable = ['borrador', 'enviado'].includes(p.estado);

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Presupuesto N° ${esc(p.numero)}
                ${p.version > 1 ? `<span class="tll-badge presupuesto">v${p.version}</span>` : ''}
                <span class="tll-badge ${_claseBadge(p)}" style="margin-left:0.4rem">${esc(p.estado)}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>

        <div class="tll-form-grid" style="margin-bottom:0.8rem">
            <div class="tll-field">
                <label>Vehículo</label>
                <div style="font-family:var(--font-mono)">${esc(p.patente) || '—'}</div>
                <div style="font-size:0.75rem;color:var(--text-secondary)">
                    ${esc([p.marca, p.modelo].filter(Boolean).join(' '))}</div>
            </div>
            <div class="tll-field">
                <label>Cliente</label>
                <div>${esc(p.cliente_nombre) || '—'}</div>
                <div style="font-size:0.75rem;color:var(--text-secondary)">${esc(p.cliente_telefono) || ''}</div>
            </div>
            <div class="tll-field">
                <label>Vigencia</label>
                <div>${fmtFecha(p.fecha_emision)} → ${fmtFecha(p.fecha_vencimiento)}</div>
                <div style="font-size:0.75rem">${_vigencia(p)}</div>
            </div>
        </div>

        <div class="tll-field tll-field--full" style="margin-bottom:0.8rem">
            <label>Motivo</label>
            <div style="font-size:0.85rem">${esc(p.motivo) || '—'}</div>
        </div>

        ${p.estado === 'aprobado' ? `
        <div class="tll-recep-found" style="margin-bottom:0.8rem">
            Aprobado por <strong>${esc(p.aprobado_por) || 'el cliente'}</strong>
            ${p.aprobado_via ? `(${esc(VIAS.find(v => v[0] === p.aprobado_via)?.[1] || p.aprobado_via)})` : ''}
            el ${fmtFechaHora(p.aprobado_at)}.
        </div>` : ''}
        ${p.estado === 'rechazado' && p.motivo_rechazo ? `
        <div class="tll-recep-notfound" style="margin-bottom:0.8rem">
            Rechazado: ${esc(p.motivo_rechazo)}
        </div>` : ''}
        ${p.estado === 'convertido' ? `
        <div class="tll-recep-found" style="margin-bottom:0.8rem">
            Convertido en orden de trabajo. El stock ya se descontó.
        </div>` : ''}

        <div class="panel-header" style="margin-bottom:0.6rem">
            <h2 style="font-size:0.95rem">Detalle cotizado</h2>
        </div>
        <div id="prs-items"></div>

        ${editable ? `
        <div class="tll-form-grid" style="margin-top:0.8rem;align-items:end">
            <div class="tll-field">
                <label>Tipo</label>
                <select class="tll-select" id="prs-i-tipo">
                    <option value="repuesto">Repuesto</option>
                    <option value="mano_obra">Mano de obra</option>
                </select>
            </div>
            <div class="tll-field tll-field--full" id="prs-i-rep-wrap" style="grid-column:span 2">
                <label>Repuesto</label>
                <select class="tll-select" id="prs-i-repuesto">
                    <option value="">— Selecciona —</option>
                    ${_repuestos.map(r => `
                        <option value="${esc(r.codigo)}" data-precio="${r.precio_venta}"
                                data-costo="${r.precio_costo}" data-stock="${r.stock}">
                            ${esc(r.nombre)} · stock ${r.stock} · ${fmtCLP(r.precio_venta)}
                        </option>`).join('')}
                </select>
                <span class="tll-field-msg">Cotizar no descuenta stock. Se descuenta al convertir en OT.</span>
            </div>
            <div class="tll-field tll-field--full oculto" id="prs-i-desc-wrap" style="grid-column:span 2">
                <label>Descripción</label>
                <input class="tll-input" id="prs-i-descripcion" placeholder="Ej: desarme y cambio de embrague">
            </div>
            <div class="tll-field">
                <label>Cantidad</label>
                <input class="tll-input" id="prs-i-cantidad" type="number" min="0.5" step="0.5" value="1">
            </div>
            <div class="tll-field">
                <label>Precio unit.</label>
                <input class="tll-input" id="prs-i-precio" type="number" min="0" value="0">
            </div>
            <div class="tll-field">
                <label>Costo unit.</label>
                <input class="tll-input" id="prs-i-costo" type="number" min="0" value="0">
            </div>
            <div class="tll-field">
                <label class="tll-check" style="margin-top:1.4rem">
                    <input type="checkbox" id="prs-i-opcional"> Opcional
                </label>
            </div>
            <div class="tll-field">
                <label>&nbsp;</label>
                <button class="tll-btn tll-btn--primary" id="prs-i-agregar" style="width:100%">+ Agregar</button>
            </div>
        </div>` : ''}

        <div class="tll-ot-totales" id="prs-totales" style="flex-direction:column;align-items:stretch"></div>

        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" id="prs-imprimir">🖨 Imprimir</button>
            ${editable ? `<button class="tll-btn tll-btn--ghost" id="prs-enviar">Marcar enviado</button>` : ''}
            ${['borrador', 'enviado'].includes(p.estado) && !p.vencido
                ? `<button class="tll-btn tll-btn--primary" id="prs-aprobar">✓ Cliente aprobó</button>
                   <button class="tll-btn tll-btn--danger" id="prs-rechazar">Rechazó</button>` : ''}
            ${p.estado === 'aprobado'
                ? `<button class="tll-btn tll-btn--primary" id="prs-convertir">🛠 Convertir en OT</button>` : ''}
            ${!['convertido', 'reemplazado'].includes(p.estado)
                ? `<button class="tll-btn tll-btn--ghost" id="prs-version">Nueva versión</button>` : ''}
            <div class="tll-toolbar-sep"></div>
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cerrar</button>
        </div>`, '860px');

        await _cargarItems();

        if (editable) {
            document.getElementById('prs-i-tipo').addEventListener('change', (e) => {
                const esRep = e.target.value === 'repuesto';
                document.getElementById('prs-i-rep-wrap').classList.toggle('oculto', !esRep);
                document.getElementById('prs-i-desc-wrap').classList.toggle('oculto', esRep);
            });
            document.getElementById('prs-i-repuesto').addEventListener('change', (e) => {
                const o = e.target.selectedOptions[0];
                if (o?.dataset.precio) document.getElementById('prs-i-precio').value = o.dataset.precio;
                if (o?.dataset.costo)  document.getElementById('prs-i-costo').value  = o.dataset.costo;
            });
            document.getElementById('prs-i-agregar').addEventListener('click', _agregarItem);
            document.getElementById('prs-enviar').addEventListener('click', () => _responder('enviado'));
        }

        document.getElementById('prs-imprimir').addEventListener('click', _imprimir);
        document.getElementById('prs-aprobar')?.addEventListener('click', _abrirAprobacion);
        document.getElementById('prs-rechazar')?.addEventListener('click', _abrirRechazo);
        document.getElementById('prs-convertir')?.addEventListener('click', _convertir);
        document.getElementById('prs-version')?.addEventListener('click', _nuevaVersion);
    }

    async function _cargarItems() {
        const cont = document.getElementById('prs-items');
        if (!cont || !_abierto) return;

        try {
            const { data: items, error } = await db.from('taller_presupuestos_items')
                .select('*').eq('presupuesto_id', _abierto.id).order('orden').order('created_at');
            if (error) throw error;

            _abierto._items = items || [];
            const editable = ['borrador', 'enviado'].includes(_abierto.estado);

            if (!items || items.length === 0) {
                cont.innerHTML = `<div class="placeholder-text" style="padding:1.2rem">
                    Sin ítems cotizados todavía.</div>`;
            } else {
                cont.innerHTML = `
                <table class="tll-tabla">
                    <thead><tr>
                        <th>Detalle</th><th style="text-align:right">Cant.</th>
                        <th style="text-align:right">P. unit</th>
                        <th style="text-align:right">Subtotal</th>
                        <th style="text-align:right">Margen</th>${editable ? '<th></th>' : ''}
                    </tr></thead>
                    <tbody>
                    ${items.map(i => {
                        const venta = _num(i.subtotal);
                        const costo = Math.round(_num(i.cantidad) * _num(i.costo_unitario));
                        const pct = venta > 0 ? (venta - costo) / venta * 100 : 0;
                        return `
                        <tr${i.opcional ? ' style="opacity:0.65"' : ''}>
                            <td>${i.tipo === 'repuesto' ? '🔩' : '🔧'} ${esc(i.descripcion)}
                                ${i.opcional ? '<span class="tll-badge presupuesto">opcional</span>' : ''}
                                ${i.articulo_codigo ? `<div style="font-size:0.68rem;color:var(--text-muted);font-family:var(--font-mono)">${esc(i.articulo_codigo)}</div>` : ''}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${_fmtCant(i.cantidad)}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(i.precio_unitario)}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(i.subtotal)}</td>
                            <td style="text-align:right;font-family:var(--font-mono);color:${_colorMargen(pct)}">
                                ${costo > 0 ? pct.toFixed(0) + '%' : '—'}</td>
                            ${editable ? `<td style="text-align:right;white-space:nowrap">
                                <button class="tll-btn tll-btn--ghost prs-i-opt" data-id="${i.id}"
                                        data-opcional="${i.opcional}">${i.opcional ? 'Incluir' : 'Opcional'}</button>
                                <button class="tll-btn tll-btn--danger prs-i-quitar" data-id="${i.id}">✕</button></td>` : ''}
                        </tr>`;
                    }).join('')}
                    </tbody>
                </table>`;

                cont.querySelectorAll('.prs-i-quitar').forEach(b =>
                    b.addEventListener('click', () => _quitarItem(b.dataset.id)));
                cont.querySelectorAll('.prs-i-opt').forEach(b =>
                    b.addEventListener('click', () =>
                        _marcarOpcional(b.dataset.id, b.dataset.opcional !== 'true')));
            }

            _renderTotales(items || []);

        } catch (err) {
            console.error('[Presupuestos] items:', err);
        }
    }

    function _renderTotales(items) {
        const cont = document.getElementById('prs-totales');
        if (!cont) return;

        const incluidos = items.filter(i => !i.opcional);
        const total  = incluidos.reduce((s, i) => s + _num(i.subtotal), 0);
        const costo  = incluidos.reduce((s, i) => s + Math.round(_num(i.cantidad) * _num(i.costo_unitario)), 0);
        const opcional = items.filter(i => i.opcional).reduce((s, i) => s + _num(i.subtotal), 0);
        const neto   = Math.round(total / (1 + IVA_TASA));
        const margen = total - costo;
        const pct    = total > 0 ? margen / total * 100 : 0;

        cont.innerHTML = `
            <span style="display:flex;justify-content:space-between">
                <span>Neto</span><strong>${fmtCLP(neto)}</strong></span>
            <span style="display:flex;justify-content:space-between">
                <span>IVA ${Math.round(IVA_TASA * 100)}%</span><strong>${fmtCLP(total - neto)}</strong></span>
            <span style="display:flex;justify-content:space-between;font-size:1.05rem;margin-top:0.2rem">
                <span>Total</span><strong style="color:var(--accent)">${fmtCLP(total)}</strong></span>
            ${opcional > 0 ? `
            <span style="display:flex;justify-content:space-between;font-size:0.8rem;
                         color:var(--text-secondary);margin-top:0.3rem">
                <span>Opcionales (no incluidos)</span><strong>${fmtCLP(opcional)}</strong></span>` : ''}
            <div class="tll-rep-sep"></div>
            <span style="display:flex;justify-content:space-between;font-size:0.85rem">
                <span>Costo de repuestos</span><strong>${fmtCLP(costo)}</strong></span>
            <span style="display:flex;justify-content:space-between;font-size:0.9rem">
                <span>Margen del presupuesto</span>
                <strong style="color:${_colorMargen(pct)}">${fmtCLP(margen)} · ${pct.toFixed(1)}%</strong></span>
            ${pct < 0 && total > 0 ? `
            <div class="tll-recep-notfound" style="margin-top:0.5rem">
                Estás cotizando <strong>bajo el costo</strong> de los repuestos.
            </div>` : ''}`;
    }

    // ── Ítems ─────────────────────────────────────────────────────
    async function _agregarItem() {
        if (!_abierto) return;

        const tipo     = document.getElementById('prs-i-tipo').value;
        const cantidad = _num(document.getElementById('prs-i-cantidad').value);
        const precio   = _num(document.getElementById('prs-i-precio').value);
        const costo    = _num(document.getElementById('prs-i-costo').value);

        if (cantidad <= 0) { avisar('Cantidad inválida', 'error'); return; }

        let descripcion, codigo = null;

        if (tipo === 'repuesto') {
            const sel = document.getElementById('prs-i-repuesto');
            codigo = sel.value;
            if (!codigo) { avisar('Selecciona un repuesto', 'error'); return; }
            descripcion = _repuestos.find(r => r.codigo === codigo)?.nombre || codigo;

            const stock = _num(sel.selectedOptions[0]?.dataset.stock);
            if (cantidad > stock) {
                // Se permite cotizar sin stock: para eso está el módulo Compras
                avisar(`Aviso: hay ${_fmtCant(stock)} en stock. Se puede cotizar igual.`);
            }
        } else {
            descripcion = document.getElementById('prs-i-descripcion').value.trim();
            if (!descripcion) { avisar('Describe la mano de obra', 'error'); return; }
        }

        const btn = document.getElementById('prs-i-agregar');
        btn.disabled = true;

        try {
            const { error } = await db.from('taller_presupuestos_items').insert({
                empresa_id:      window.appData.usuario.empresa_id,
                presupuesto_id:  _abierto.id,
                tipo,
                articulo_codigo: codigo,
                descripcion,
                cantidad,
                precio_unitario: precio,
                costo_unitario:  costo,
                subtotal:        Math.round(cantidad * precio),
                opcional:        document.getElementById('prs-i-opcional').checked,
                orden:           (_abierto._items?.length || 0) + 1
            });
            if (error) throw error;

            document.getElementById('prs-i-cantidad').value = 1;
            document.getElementById('prs-i-precio').value = 0;
            document.getElementById('prs-i-costo').value = 0;
            document.getElementById('prs-i-opcional').checked = false;
            if (tipo === 'mano_obra') document.getElementById('prs-i-descripcion').value = '';

            await _cargarItems();
        } catch (err) {
            console.error('[Presupuestos] agregar item:', err);
            avisar('Error al agregar el ítem', 'error');
        }
        btn.disabled = false;
    }

    async function _quitarItem(id) {
        try {
            const { error } = await db.from('taller_presupuestos_items').delete().eq('id', id);
            if (error) throw error;
            await _cargarItems();
        } catch (err) {
            console.error('[Presupuestos] quitar item:', err);
            avisar('Error al quitar el ítem', 'error');
        }
    }

    async function _marcarOpcional(id, opcional) {
        try {
            const { error } = await db.from('taller_presupuestos_items')
                .update({ opcional }).eq('id', id);
            if (error) throw error;
            await _cargarItems();
        } catch (err) {
            console.error('[Presupuestos] opcional:', err);
            avisar('No se pudo cambiar el ítem', 'error');
        }
    }

    // ── Respuestas del cliente ────────────────────────────────────
    async function _responder(respuesta, extra = {}) {
        const res = await _rpc('fn_responder_presupuesto', {
            p_empresa_id: window.appData.usuario.empresa_id,
            p_presupuesto_id: _abierto.id,
            p_respuesta: respuesta,
            p_via: extra.via || null,
            p_por: extra.por || null,
            p_motivo: extra.motivo || null
        });
        if (!res) return false;
        if (!res.ok) { avisar(res.error || 'No se pudo registrar', 'error'); return false; }

        avisar({ enviado: 'Presupuesto marcado como enviado',
                 aprobado: 'Aprobación registrada — ya puedes convertirlo en OT',
                 rechazado: 'Rechazo registrado' }[respuesta]);
        cerrarModal();
        await recargar();
        return true;
    }

    function _abrirAprobacion() {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Registrar aprobación del cliente</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            Presupuesto N° ${esc(_abierto.numero)} por <strong>${fmtCLP(_abierto.total)}</strong>.<br>
            Deja constancia de quién autorizó y cómo: si después hay reclamo,
            esto es lo único que respalda al taller.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>¿Quién autorizó? *</label>
                <input class="tll-input" id="prs-a-por"
                       value="${esc(_abierto.cliente_nombre || '')}">
            </div>
            <div class="tll-field">
                <label>¿Por qué vía?</label>
                <select class="tll-select" id="prs-a-via">
                    ${VIAS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="prs-a-ok">Registrar aprobación</button>
        </div>`, '560px');

        document.getElementById('prs-a-ok').addEventListener('click', async () => {
            const por = document.getElementById('prs-a-por').value.trim();
            if (!por) { avisar('Indica quién autorizó', 'error'); return; }
            document.getElementById('prs-a-ok').disabled = true;
            await _responder('aprobado', { por, via: document.getElementById('prs-a-via').value });
        });
    }

    const MOTIVOS_PERDIDA = [
        ['precio',      'El precio'],
        ['postergado',  'Lo va a pensar / postergó'],
        ['no_responde', 'No responde'],
        ['otro_taller', 'Se fue a otro taller'],
        ['otro',        'Otro']
    ];

    function _abrirRechazo() {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Presupuesto rechazado</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            N° ${esc(_abierto.numero)} por <strong>${fmtCLP(_abierto.total)}</strong>.
            Registrar el motivo ayuda a ver qué se está perdiendo y por qué.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Motivo *</label>
                <select class="tll-select" id="prs-r-cat">
                    ${MOTIVOS_PERDIDA.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <label>Detalle (opcional)</label>
                <input class="tll-input" id="prs-r-detalle" placeholder="Ej: encontró el repuesto más barato">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--danger" id="prs-r-ok">Registrar rechazo</button>
        </div>`, '560px');

        document.getElementById('prs-r-ok').addEventListener('click', async () => {
            document.getElementById('prs-r-ok').disabled = true;
            const cat = document.getElementById('prs-r-cat').value;
            const detalle = document.getElementById('prs-r-detalle').value.trim() || null;
            const id = _abierto.id;
            const ok = await _responder('rechazado', { motivo: detalle });
            if (ok) {
                await _rpc('fn_taller_presup_motivo_perdida', {
                    p_empresa_id: window.appData.usuario.empresa_id,
                    p_presupuesto_id: id,
                    p_categoria: cat,
                    p_detalle: detalle
                });
            }
        });
    }

    async function _convertir() {
        if (!confirm(
            `Convertir el presupuesto N° ${_abierto.numero} en orden de trabajo.\n\n` +
            `Se crea la OT en estado "aprobada" y AHÍ se descuenta el stock de los ` +
            `repuestos incluidos (los opcionales no).\n\n¿Continuar?`)) return;

        const btn = document.getElementById('prs-convertir');
        btn.disabled = true;

        const res = await _rpc('fn_convertir_presupuesto_ot', {
            p_empresa_id: window.appData.usuario.empresa_id,
            p_presupuesto_id: _abierto.id,
            p_usuario: window.appData.usuario.rut
        });

        if (!res) { btn.disabled = false; return; }
        if (!res.ok) { avisar(res.error || 'No se pudo convertir', 'error'); btn.disabled = false; return; }

        avisar(`Orden de trabajo N° ${res.numero} creada`);
        cerrarModal();
        await recargar();

        if (typeof ModuloOrdenes !== 'undefined') ModuloOrdenes.abrirPorId(res.orden_id);
    }

    async function _nuevaVersion() {
        if (!confirm(
            `Crear la versión ${_abierto.version + 1} del presupuesto N° ${_abierto.numero}.\n\n` +
            `Se copian todos los ítems y la versión actual queda como "reemplazado".\n\n¿Continuar?`)) return;

        const res = await _rpc('fn_nueva_version_presupuesto', {
            p_empresa_id: window.appData.usuario.empresa_id,
            p_presupuesto_id: _abierto.id,
            p_usuario: window.appData.usuario.rut
        });

        if (!res) return;
        if (!res.ok) { avisar(res.error || 'No se pudo versionar', 'error'); return; }

        avisar(`Versión ${res.version} creada`);
        cerrarModal();
        await recargar();
        abrirDetalle(_lista.find(p => p.id === res.presupuesto_id));
    }

    // ── Impresión ─────────────────────────────────────────────────
    function _imprimir() {
        const p = _abierto;
        const items = p._items || [];
        const incluidos = items.filter(i => !i.opcional);
        const opcionales = items.filter(i => i.opcional);
        const total = incluidos.reduce((s, i) => s + _num(i.subtotal), 0);
        const neto  = Math.round(total / (1 + IVA_TASA));

        const filas = (arr) => arr.map(i => `
            <tr>
                <td>${esc(i.descripcion)}</td>
                <td class="r">${_fmtCant(i.cantidad)}</td>
                <td class="r">${fmtCLP(i.precio_unitario)}</td>
                <td class="r">${fmtCLP(i.subtotal)}</td>
            </tr>`).join('');

        const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
        <title>Presupuesto ${esc(p.numero)}</title>
        <style>
            body { font-family: system-ui, -apple-system, sans-serif; color:#111; margin:32px; font-size:13px; }
            h1 { font-size:20px; margin:0 0 2px; }
            .sub { color:#666; font-size:12px; margin-bottom:20px; }
            .caja { border:1px solid #ddd; border-radius:6px; padding:12px 14px; margin-bottom:16px; }
            .cols { display:flex; gap:24px; }
            .cols > div { flex:1; }
            .lbl { color:#666; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; }
            table { width:100%; border-collapse:collapse; margin-top:8px; }
            th { text-align:left; font-size:11px; text-transform:uppercase; color:#666;
                 border-bottom:1px solid #ddd; padding:6px 4px; }
            td { padding:6px 4px; border-bottom:1px solid #f0f0f0; }
            .r { text-align:right; }
            .tot { margin-top:14px; margin-left:auto; width:260px; }
            .tot div { display:flex; justify-content:space-between; padding:3px 0; }
            .tot .big { font-size:16px; font-weight:700; border-top:2px solid #111;
                        margin-top:6px; padding-top:8px; }
            .opc { margin-top:22px; }
            .opc h3 { font-size:13px; margin:0 0 4px; }
            .nota { margin-top:26px; font-size:11px; color:#666; line-height:1.6;
                    border-top:1px solid #ddd; padding-top:12px; }
            .firma { margin-top:44px; display:flex; gap:40px; }
            .firma div { flex:1; border-top:1px solid #999; padding-top:6px;
                         font-size:11px; color:#666; text-align:center; }
            @media print { body { margin:0; } }
        </style></head><body>
            <h1>Presupuesto N° ${esc(p.numero)}${p.version > 1 ? ' · v' + p.version : ''}</h1>
            <div class="sub">${esc(window.appData.empresa?.nombre || 'Taller')} ·
                Emitido ${fmtFecha(p.fecha_emision)} ·
                Válido hasta ${fmtFecha(p.fecha_vencimiento)}</div>

            <div class="caja cols">
                <div>
                    <div class="lbl">Cliente</div>
                    <div>${esc(p.cliente_nombre) || '—'}</div>
                    <div>${esc(p.cliente_telefono) || ''}</div>
                </div>
                <div>
                    <div class="lbl">Vehículo</div>
                    <div>${esc(p.patente) || '—'} · ${esc([p.marca, p.modelo].filter(Boolean).join(' '))}</div>
                    <div>${p.kilometraje ? _fmtCant(p.kilometraje) + ' km' : ''}</div>
                </div>
            </div>

            ${p.motivo ? `<div class="caja"><div class="lbl">Motivo</div>${esc(p.motivo)}</div>` : ''}
            ${p.diagnostico ? `<div class="caja"><div class="lbl">Diagnóstico</div>${esc(p.diagnostico)}</div>` : ''}

            <table>
                <thead><tr><th>Detalle</th><th class="r">Cant.</th>
                    <th class="r">P. unitario</th><th class="r">Subtotal</th></tr></thead>
                <tbody>${filas(incluidos)}</tbody>
            </table>

            <div class="tot">
                <div><span>Neto</span><span>${fmtCLP(neto)}</span></div>
                <div><span>IVA ${Math.round(IVA_TASA * 100)}%</span><span>${fmtCLP(total - neto)}</span></div>
                <div class="big"><span>Total</span><span>${fmtCLP(total)}</span></div>
            </div>

            ${opcionales.length ? `
            <div class="opc">
                <h3>Trabajos opcionales recomendados (no incluidos en el total)</h3>
                <table><tbody>${filas(opcionales)}</tbody></table>
            </div>` : ''}

            <div class="nota">
                ${p.condiciones ? esc(p.condiciones) + '<br>' : ''}
                Este presupuesto tiene una validez de ${p.dias_validez} días desde su emisión.
                Los precios pueden variar si cambia la disponibilidad de los repuestos.
                Trabajos adicionales detectados durante la reparación se informarán antes de ejecutarse.
            </div>

            <div class="firma">
                <div>Firma del cliente</div>
                <div>${esc(window.appData.empresa?.nombre || 'Taller')}</div>
            </div>
        </body></html>`;

        const w = window.open('', '_blank');
        if (!w) { avisar('El navegador bloqueó la ventana de impresión', 'error'); return; }
        w.document.write(html);
        w.document.close();
        setTimeout(() => w.print(), 300);
    }

    // ── Helpers ───────────────────────────────────────────────────
    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Presupuestos] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/08_presupuestos.sql (${nombre})`
                : 'Error en la operación. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _claseBadge(p) {
        return { borrador: 'diagnostico', enviado: 'presupuesto', aprobado: 'aprobada',
                 convertido: 'lista', rechazado: 'anulada', reemplazado: 'entregada',
                 anulado: 'anulada' }[p.estado] || 'entregada';
    }

    function _badge(p) {
        if (p.vencido) return `<span class="tll-badge anulada">vencido</span>`;
        return `<span class="tll-badge ${_claseBadge(p)}">${esc(p.estado)}</span>`;
    }

    function _vigencia(p) {
        if (['convertido', 'rechazado', 'reemplazado'].includes(p.estado)) return '—';
        const d = _num(p.dias_para_vencer);
        if (d < 0)  return `<span style="color:#f87171">venció hace ${-d} d</span>`;
        if (d <= 3) return `<span style="color:#fbbf24">quedan ${d} d</span>`;
        return `<span style="color:var(--text-muted)">quedan ${d} d</span>`;
    }

    function _colorMargen(pct) {
        const p = _num(pct);
        return p < 0 ? '#f87171' : p < 20 ? '#fbbf24' : '#34d399';
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function _fmtCant(v) {
        const n = _num(v);
        return Number.isInteger(n) ? n.toLocaleString('es-CL') : n.toLocaleString('es-CL', { maximumFractionDigits: 2 });
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

    /** Abre un presupuesto por id, aunque el panel no se haya inicializado. */
    async function abrirPorId(id) {
        try {
            const { data, error } = await db.from('v_taller_presupuestos')
                .select('*').eq('id', id).single();
            if (error) throw error;

            if (_repuestos.length === 0) {
                const { data: reps } = await db.from('taller_repuestos')
                    .select('id, codigo, nombre, precio_venta, precio_costo, stock')
                    .eq('empresa_id', window.appData.usuario.empresa_id)
                    .eq('activo', true).order('nombre').range(0, 4999);
                _repuestos = reps || [];
            }
            abrirDetalle(data);
        } catch (err) {
            console.error('[Presupuestos] abrirPorId:', err);
            avisar('No se pudo abrir el presupuesto', 'error');
        }
    }

    return { init, recargar, abrirNuevo, abrirDetalle, abrirPorId };

})();
