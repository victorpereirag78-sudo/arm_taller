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

    // Cómo avisó el cliente que aprueba, cuando lo registra el taller a mano.
    const VIAS = [['presencial', 'En el taller'], ['telefono', 'Por teléfono'],
                  ['whatsapp', 'Por WhatsApp'], ['email', 'Por email'], ['otro', 'Otro']];
    // Todas las vías posibles al mostrar (la App y el enlace las registra el sistema).
    const VIAS_ETIQ = Object.fromEntries([...VIAS, ['mi_vehiculo', 'Desde la App'],
                                          ['enlace', 'Desde el enlace']]);

    let _cfg = null;   // taller_config (condiciones, datos del taller) para el documento

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

            const [pRes, cRes, vRes, rRes, cfgRes] = await Promise.all([
                db.from('v_taller_presupuestos').select('*')
                  .eq('empresa_id', eid).order('numero', { ascending: false })
                  .order('version', { ascending: false }).range(0, 999),
                db.from('taller_clientes').select('id, nombre, rut, telefono, email, direccion, canal_pref')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre').range(0, 4999),
                db.from('taller_vehiculos').select('id, patente, marca, modelo, anio, color, vin, cliente_id, kilometraje')
                  .eq('empresa_id', eid).eq('activo', true).order('patente').range(0, 4999),
                db.from('taller_repuestos').select('id, codigo, nombre, precio_venta, precio_costo, stock')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre').range(0, 4999),
                db.rpc('fn_taller_config', { p_empresa_id: eid })
            ]);

            if (pRes.error) throw pRes.error;
            _cfg = cfgRes.data?.ok ? cfgRes.data.config : _cfg;
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
    // El presupuesto es lo primero que se hace cuando llega un cliente:
    // se llena con todos los datos y de él salen el cliente y el vehículo
    // (fn_taller_presupuesto_crear, sql/44).
    function abrirNuevo(preset = null) {
        const cli0 = preset?.cliente_id ? _clientes.find(c => c.id === preset.cliente_id) : null;
        const veh0 = preset?.vehiculo_id ? _vehiculos.find(v => v.id === preset.vehiculo_id) : null;

        const seccion = (t) => `<div class="tll-field tll-field--full">
            <div style="font-size:0.72rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;
                        color:var(--text-secondary);border-bottom:1px solid var(--border, #2a3350);
                        padding-bottom:0.25rem">${t}</div></div>`;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Nuevo presupuesto</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            ${seccion('Cliente')}
            <div class="tll-field">
                <label>RUT</label>
                <input class="tll-input" id="prs-f-rut" placeholder="12.345.678-9" autocomplete="off">
                <span class="tll-field-msg" id="prs-f-rut-msg"></span>
            </div>
            <div class="tll-field">
                <label>Nombre *</label>
                <input class="tll-input" id="prs-f-nombre" list="prs-dl-clientes" autocomplete="off">
                <datalist id="prs-dl-clientes">
                    ${_clientes.map(c => `<option value="${esc(c.nombre)}"></option>`).join('')}
                </datalist>
            </div>
            <div class="tll-field">
                <label>Teléfono</label>
                <input class="tll-input" id="prs-f-tel" placeholder="+56 9 …" inputmode="tel">
            </div>
            <div class="tll-field">
                <label>Correo</label>
                <input class="tll-input" id="prs-f-email" type="email">
            </div>
            <div class="tll-field tll-field--full">
                <label>Dirección</label>
                <input class="tll-input" id="prs-f-dir">
            </div>

            ${seccion('Vehículo')}
            <div class="tll-field">
                <label>Patente *</label>
                <input class="tll-input" id="prs-f-pat" placeholder="ABCD12" autocomplete="off"
                       style="font-family:var(--font-mono);text-transform:uppercase">
                <span class="tll-field-msg" id="prs-f-pat-msg"></span>
            </div>
            <div class="tll-field">
                <label>Marca</label>
                <input class="tll-input" id="prs-f-marca" placeholder="Volkswagen">
            </div>
            <div class="tll-field">
                <label>Modelo</label>
                <input class="tll-input" id="prs-f-modelo" placeholder="Gol 1.6">
            </div>
            <div class="tll-field">
                <label>Año</label>
                <input class="tll-input" id="prs-f-anio" type="number" min="1950" max="2035">
            </div>
            <div class="tll-field">
                <label>Color</label>
                <input class="tll-input" id="prs-f-color">
            </div>
            <div class="tll-field">
                <label>Kilometraje</label>
                <input class="tll-input" id="prs-f-km" type="number" min="0">
            </div>
            <div class="tll-field tll-field--full">
                <label>VIN / Chasis</label>
                <input class="tll-input" id="prs-f-vin" style="font-family:var(--font-mono);text-transform:uppercase">
            </div>

            ${seccion('Presupuesto')}
            <div class="tll-field tll-field--full">
                <label>Motivo / lo que pide el cliente *</label>
                <textarea class="tll-textarea" id="prs-f-motivo"
                    placeholder="Ej: ruido al frenar, cotizar cambio de embrague">${esc(preset?.motivo || '')}</textarea>
            </div>
            <div class="tll-field tll-field--full">
                <label>Diagnóstico</label>
                <textarea class="tll-textarea" id="prs-f-diagnostico"></textarea>
            </div>
            <div class="tll-field">
                <label>Validez (días)</label>
                <input class="tll-input" id="prs-f-validez" type="number" min="1"
                       value="${_cfg?.dias_validez_presupuesto || 15}">
                <span class="tll-field-msg">Con repuestos importados, 7 días es más realista.</span>
            </div>

            ${seccion('Cómo informar al cliente')}
            <div class="tll-field tll-field--full">
                <select class="tll-select" id="prs-f-canal">
                    ${CANAL_AVISO.map(([v, t]) => `<option value="${v}" ${v === 'ambos' ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
                <span class="tll-field-msg">
                    Al enviar el presupuesto, el cliente lo recibe en la App y/o por WhatsApp
                    con un enlace para verlo completo y aprobarlo.</span>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="prs-f-crear">Crear y cotizar</button>
        </div>`, '760px');

        const $ = (id) => document.getElementById(id);
        let cliSel = null;   // cliente existente reconocido por RUT, nombre o patente

        /** Llena solo lo que está vacío: nunca pisa lo que el usuario ya escribió. */
        const poner = (id, valor) => {
            const el = $(id);
            if (el && valor != null && String(valor).trim() !== '' && !el.value.trim()) el.value = valor;
        };

        const aplicarCliente = (c, aviso) => {
            cliSel = c;
            poner('prs-f-nombre', c.nombre);
            poner('prs-f-tel', c.telefono);
            poner('prs-f-email', c.email);
            poner('prs-f-dir', c.direccion);
            if (c.rut && !$('prs-f-rut').value.trim()) $('prs-f-rut').value = formatearRut(c.rut);
            $('prs-f-rut-msg').textContent = aviso || '✓ Cliente existente: se actualizan sus datos';
        };

        const aplicarVehiculo = (v) => {
            poner('prs-f-marca', v.marca);
            poner('prs-f-modelo', v.modelo);
            poner('prs-f-anio', v.anio);
            poner('prs-f-color', v.color);
            poner('prs-f-vin', v.vin);
            poner('prs-f-km', v.kilometraje || '');
            $('prs-f-pat-msg').textContent = '✓ Vehículo existente: se actualizan sus datos';
            const dueno = _clientes.find(c => c.id === v.cliente_id);
            if (dueno && !cliSel) aplicarCliente(dueno, '✓ Dueño del vehículo (cliente existente)');
        };

        $('prs-f-rut').addEventListener('input', (e) => {
            e.target.value = formatearRut(e.target.value);
            const rut = normalizarRut(e.target.value);
            const c = rut.length >= 8 ? _clientes.find(x => normalizarRut(x.rut) === rut) : null;
            if (c) aplicarCliente(c);
            else {
                if (cliSel && normalizarRut(cliSel.rut) !== rut) cliSel = null;
                $('prs-f-rut-msg').textContent = '';
            }
        });

        $('prs-f-nombre').addEventListener('change', (e) => {
            const nombre = e.target.value.trim().toLowerCase();
            const c = nombre && _clientes.find(x => (x.nombre || '').toLowerCase() === nombre);
            if (c) aplicarCliente(c);
        });

        $('prs-f-pat').addEventListener('input', (e) => {
            const pat = normalizarPatente(e.target.value);
            e.target.value = pat;
            const v = pat.length >= 5 ? _vehiculos.find(x => normalizarPatente(x.patente) === pat) : null;
            if (v) aplicarVehiculo(v);
            else $('prs-f-pat-msg').textContent = '';
        });

        // Preset (p. ej. desde otro módulo): se rellena como si lo hubieran escrito
        if (cli0) aplicarCliente(cli0);
        if (veh0) { $('prs-f-pat').value = normalizarPatente(veh0.patente); aplicarVehiculo(veh0); }
        if (preset?.kilometraje) $('prs-f-km').value = preset.kilometraje;

        $('prs-f-crear').addEventListener('click', () => _crear(() => cliSel));
    }

    async function _crear(clienteElegido) {
        const $ = (id) => document.getElementById(id);
        const v = (id) => $(id).value.trim();

        const nombre = v('prs-f-nombre');
        const patente = normalizarPatente(v('prs-f-pat'));
        const motivo = v('prs-f-motivo');

        if (!nombre)  { avisar('El nombre del cliente es obligatorio', 'error'); return; }
        if (!patente) { avisar('La patente es obligatoria', 'error'); return; }
        if (!motivo)  { avisar('Describe qué se está cotizando', 'error'); return; }

        const rut = normalizarRut(v('prs-f-rut'));
        if (rut && !validarRutChileno(rut)) { avisar('RUT inválido — revisa el dígito verificador', 'error'); return; }
        if (v('prs-f-tel') && !validarTelefono(v('prs-f-tel'))) {
            avisar('Teléfono inválido — deben ser 8 o 9 dígitos', 'error'); return;
        }
        if (v('prs-f-email') && !validarEmail(v('prs-f-email'))) {
            avisar('Correo con formato inválido', 'error'); return;
        }

        const sel = clienteElegido();
        const btn = $('prs-f-crear');
        btn.disabled = true;

        try {
            const { data, error } = await db.rpc('fn_taller_presupuesto_crear', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_cliente: {
                    id: sel?.id || null, nombre, rut: rut || null,
                    telefono: v('prs-f-tel'), email: v('prs-f-email'), direccion: v('prs-f-dir')
                },
                p_vehiculo: {
                    patente, marca: v('prs-f-marca'), modelo: v('prs-f-modelo'),
                    anio: v('prs-f-anio'), color: v('prs-f-color'), vin: v('prs-f-vin')
                },
                p_km:          $('prs-f-km').value === '' ? null : Number($('prs-f-km').value),
                p_validez:     Number($('prs-f-validez').value) || 15,
                p_motivo:      motivo,
                p_diagnostico: v('prs-f-diagnostico') || null,
                p_canal:       $('prs-f-canal').value,
                p_usuario:     window.appData.usuario.rut
            });
            if (error) throw error;
            if (!data?.ok) { avisar(data?.error || 'No se pudo crear el presupuesto', 'error'); btn.disabled = false; return; }

            avisar(`Presupuesto N° ${data.numero} creado — cliente y vehículo guardados`);
            cerrarModal();
            await recargar();
            abrirDetalle(_lista.find(p => p.id === data.presupuesto_id));
        } catch (err) {
            console.error('[Presupuestos] crear:', err);
            btn.disabled = false;
            avisar(err.code === 'PGRST202' || err.code === '42883'
                ? 'Falta ejecutar sql/44_presupuesto_completo.sql'
                : 'Error al crear el presupuesto. Revisa la consola.', 'error');
        }
    }

    // ── Detalle ───────────────────────────────────────────────────
    async function abrirDetalle(p) {
        if (!p) return;
        _abierto = p;

        await _cargarFicha(p);
        const cli = p._cli || {};
        const veh = p._veh || {};
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
                    ${esc([p.marca, p.modelo, veh.anio, veh.color].filter(Boolean).join(' · '))}</div>
                <div style="font-size:0.72rem;color:var(--text-muted)">
                    ${veh.vin ? 'VIN ' + esc(veh.vin) : ''}${veh.vin && p.kilometraje ? ' · ' : ''}${p.kilometraje ? Number(p.kilometraje).toLocaleString('es-CL') + ' km' : ''}</div>
            </div>
            <div class="tll-field">
                <label>Cliente</label>
                <div>${esc(p.cliente_nombre) || '—'}${cli.rut ? ` <span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-secondary)">${esc(cli.rut)}</span>` : ''}</div>
                <div style="font-size:0.75rem;color:var(--text-secondary)">
                    ${esc([p.cliente_telefono, p.cliente_email].filter(Boolean).join(' · '))}</div>
                <div style="font-size:0.72rem;color:var(--text-muted)">${esc(cli.direccion || '')}</div>
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

        ${p.estado === 'aprobado' || (p.estado === 'convertido' && p._firma) ? `
        <div class="tll-recep-found" style="margin-bottom:0.8rem">
            Aprobado por <strong>${esc(p.aprobado_por) || 'el cliente'}</strong>
            ${p.aprobado_via ? `(${esc(VIAS_ETIQ[p.aprobado_via] || p.aprobado_via)})` : ''}
            el ${fmtFechaHora(p.aprobado_at)}.
            ${p._firma ? `<div style="margin-top:0.5rem"><span style="font-size:0.72rem;opacity:0.8">Firma del cliente</span><br>
                <img src="${p._firma}" alt="Firma del cliente"
                     style="max-height:70px;max-width:100%;background:#fff;border-radius:6px;padding:4px"></div>` : ''}
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
        <div class="prs-item-grid">
            <div class="tll-field">
                <label>Tipo</label>
                <select class="tll-select" id="prs-i-tipo">
                    <option value="repuesto">Repuesto</option>
                    <option value="mano_obra">Mano de obra</option>
                </select>
            </div>
            <div class="tll-field prs-span2" id="prs-i-rep-wrap">
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
            <div class="tll-field prs-span2 oculto" id="prs-i-desc-wrap">
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
            <div class="tll-field prs-opcional">
                <label class="tll-check">
                    <input type="checkbox" id="prs-i-opcional"> Opcional
                </label>
            </div>
            <div class="tll-field prs-agregar">
                <button class="tll-btn tll-btn--primary" id="prs-i-agregar" style="width:100%">+ Agregar</button>
            </div>
        </div>` : ''}

        <div class="tll-ot-totales" id="prs-totales" style="flex-direction:column;align-items:stretch"></div>

        <div class="tll-modal-footer prs-pie">
            <button class="tll-btn tll-btn--ghost" id="prs-ver">${_btn('👁', 'Documento')}</button>
            ${['borrador', 'enviado'].includes(p.estado)
                ? `<button class="tll-btn tll-btn--primary" id="prs-enviar">${_btn('💬', 'Enviar')}</button>` : ''}
            <button class="tll-btn tll-btn--ghost" id="prs-mas">${_btn('⋯', 'Más')}</button>
            ${['borrador', 'enviado'].includes(p.estado) && !p.vencido
                ? `<button class="tll-btn tll-btn--ghost prs-b-ok" id="prs-aprobar">${_btn('✓', 'Aprobó')}</button>
                   <button class="tll-btn tll-btn--danger" id="prs-rechazar">${_btn('✕', 'Rechazó')}</button>` : ''}
            ${p.estado === 'aprobado'
                ? `<button class="tll-btn tll-btn--primary" id="prs-convertir">${_btn('🛠', 'Convertir a OT')}</button>` : ''}
        </div>`, '980px');

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
        }

        document.getElementById('prs-enviar')?.addEventListener('click', _abrirEnvio);
        document.getElementById('prs-mas').addEventListener('click', _abrirMas);
        document.getElementById('prs-ver').addEventListener('click', _verDocumento);
        document.getElementById('prs-aprobar')?.addEventListener('click', _abrirAprobacion);
        document.getElementById('prs-rechazar')?.addEventListener('click', _abrirRechazo);
        document.getElementById('prs-convertir')?.addEventListener('click', _convertir);
    }

    /** Botón del pie: icono arriba y texto abajo en el móvil, en línea en el notebook. */
    function _btn(icono, texto) {
        return `<span class="prs-b-i">${icono}</span><span class="prs-b-t">${texto}</span>`;
    }

    /** Acciones menos usadas, para que el pie no pase de 5 botones. */
    function _abrirMas() {
        const p = _abierto;
        const conEnlace = p._ext?.token_publico && p.estado !== 'borrador';
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Presupuesto N° ${esc(p.numero)} · más opciones</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="prs-mas">
            <button class="tll-btn tll-btn--ghost" id="prs-m-imprimir">🖨 Imprimir / guardar PDF</button>
            ${conEnlace ? `<button class="tll-btn tll-btn--ghost" id="prs-m-copiar">🔗 Copiar enlace del cliente</button>` : ''}
            ${!['convertido', 'reemplazado'].includes(p.estado)
                ? `<button class="tll-btn tll-btn--ghost" id="prs-m-version">📝 Nueva versión</button>` : ''}
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" id="prs-m-volver">‹ Volver</button>
        </div>`, '420px');

        // La impresión se abre en el mismo toque (si no, el celular bloquea la ventana)
        document.getElementById('prs-m-imprimir').addEventListener('click', () => { _imprimir(); abrirDetalle(p); });
        document.getElementById('prs-m-copiar')?.addEventListener('click', async () => { await _copiarEnlace(); abrirDetalle(p); });
        document.getElementById('prs-m-version')?.addEventListener('click', _nuevaVersion);
        document.getElementById('prs-m-volver').addEventListener('click', () => abrirDetalle(p));
    }

    async function _cargarItems() {
        const cont = document.getElementById('prs-items');
        if (!cont || !_abierto) return;

        try {
            const { data: items, error } = await db.from('taller_presupuestos_items')
                .select('*').eq('presupuesto_id', _abierto.id).order('orden').order('created_at');
            if (error) throw error;

            _abierto._items = items || [];

            // La vista de la lista quedó vieja si se agregaron ítems: traer los totales al día
            const { data: tot } = await db.from('v_taller_presupuestos')
                .select('neto, iva, total, costo, margen, margen_pct').eq('id', _abierto.id).maybeSingle();
            if (tot) Object.assign(_abierto, tot);

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
                        <th style="text-align:right">Margen</th>${editable ? '<th class="prs-i-acc"></th>' : ''}
                    </tr></thead>
                    <tbody>
                    ${items.map(i => {
                        const venta = _num(i.subtotal);
                        const costo = Math.round(_num(i.cantidad) * _num(i.costo_unitario));
                        const pct = venta > 0 ? (venta - costo) / venta * 100 : 0;
                        // Mismos botones en dos sitios: en el notebook van en su columna;
                        // en el móvil esa columna se oculta y van bajo el detalle.
                        const acciones = editable ? `
                                <button class="tll-btn tll-btn--ghost prs-i-opt" data-id="${i.id}"
                                        data-opcional="${i.opcional}">${i.opcional ? 'Incluir' : 'Opcional'}</button>
                                <button class="tll-btn tll-btn--danger prs-i-quitar" data-id="${i.id}">✕</button>` : '';
                        return `
                        <tr${i.opcional ? ' style="opacity:0.65"' : ''}>
                            <td>${i.tipo === 'repuesto' ? '🔩' : '🔧'} ${esc(i.descripcion)}
                                ${i.opcional ? '<span class="tll-badge presupuesto">opcional</span>' : ''}
                                ${i.articulo_codigo ? `<div style="font-size:0.68rem;color:var(--text-muted);font-family:var(--font-mono)">${esc(i.articulo_codigo)}</div>` : ''}
                                ${editable ? `<div class="prs-i-accm">${acciones}</div>` : ''}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${_fmtCant(i.cantidad)}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(i.precio_unitario)}</td>
                            <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(i.subtotal)}</td>
                            <td style="text-align:right;font-family:var(--font-mono);color:${_colorMargen(pct)}">
                                ${costo > 0 ? pct.toFixed(0) + '%' : '—'}</td>
                            ${editable ? `<td class="prs-i-acc" style="text-align:right;white-space:nowrap">${acciones}</td>` : ''}
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

        avisar({ aprobado: 'Aprobación registrada — ya puedes convertirlo en OT',
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

    // ── Ficha, documento y envío ──────────────────────────────────
    /** Cliente, vehículo y datos de envío del presupuesto (la vista no los trae). */
    async function _cargarFicha(p) {
        const [cli, veh, ext, vin, fir] = await Promise.all([
            p.cliente_id  ? db.from('taller_clientes').select('*').eq('id', p.cliente_id).maybeSingle() : null,
            p.vehiculo_id ? db.from('taller_vehiculos').select('*').eq('id', p.vehiculo_id).maybeSingle() : null,
            db.from('taller_presupuestos').select('token_publico, url_publica, canal_aviso').eq('id', p.id).maybeSingle(),
            p.vehiculo_id ? db.from('v_taller_vinculos').select('estado')
                .eq('taller_vehiculo_id', p.vehiculo_id).eq('estado', 'activo').limit(1) : null,
            // Aparte: si falta sql/49 esta consulta falla sola y no arrastra al resto
            ['aprobado', 'convertido'].includes(p.estado)
                ? db.from('taller_presupuestos').select('firma_imagen, firma_at').eq('id', p.id).maybeSingle() : null
        ]);
        const firma = fir?.data?.firma_imagen;
        p._firma     = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(firma || '') ? firma : null;
        p._firma_at  = fir?.data?.firma_at || null;
        p._cli   = cli?.data || null;
        p._veh   = veh?.data || null;
        p._ext   = ext?.data || {};
        p._appOk = (vin?.data || []).length > 0;
    }

    /** El mismo JSON que arma fn_presupuesto_documento (sin costos ni márgenes). */
    function _datosDoc(p) {
        const cfg = _cfg || {};
        const emp = window.appData.empresa || {};
        const items = (p._items || []).map(i => ({
            tipo: i.tipo, descripcion: i.descripcion, cantidad: i.cantidad,
            precio_unitario: i.precio_unitario, subtotal: i.subtotal, opcional: i.opcional
        }));
        return {
            presupuesto_id: p.id, numero: p.numero, version: p.version, estado: p.estado,
            vencido: !!p.vencido, fecha_emision: p.fecha_emision, fecha_vencimiento: p.fecha_vencimiento,
            dias_validez: p.dias_validez, kilometraje: p.kilometraje, motivo: p.motivo,
            diagnostico: p.diagnostico, condiciones: p.condiciones || cfg.condiciones_presupuesto || null,
            neto: p.neto, iva: p.iva, total: p.total,
            aprobado_por: p.aprobado_por, aprobado_at: p.aprobado_at,
            firma: p._firma, firma_at: p._firma_at,
            taller: {
                nombre: emp.nombre, logo_url: emp.logo_url, rut: cfg.rut, giro: cfg.giro,
                direccion: cfg.direccion, comuna: cfg.comuna, ciudad: cfg.ciudad,
                telefono: cfg.telefono, whatsapp: cfg.whatsapp, email: cfg.email,
                sitio_web: cfg.sitio_web, pie: cfg.pie_documentos
            },
            cliente: { nombre: p.cliente_nombre, rut: p._cli?.rut, telefono: p.cliente_telefono,
                       email: p.cliente_email, direccion: p._cli?.direccion },
            vehiculo: { patente: p.patente, marca: p.marca, modelo: p.modelo, anio: p._veh?.anio,
                        color: p._veh?.color, vin: p._veh?.vin },
            items
        };
    }

    /** Vista previa: lo que verá el cliente. */
    function _verDocumento() {
        const p = _abierto;
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Así lo ve el cliente · N° ${esc(p.numero)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div style="background:#e5e7eb;border-radius:8px;padding:10px;max-height:70vh;overflow:auto">
            ${PresupuestoDoc.html(_datosDoc(p))}
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" id="prs-v-volver">‹ Volver</button>
            <button class="tll-btn tll-btn--primary" id="prs-v-imprimir">🖨 Imprimir / PDF</button>
        </div>`, '920px');

        document.getElementById('prs-v-volver').addEventListener('click', () => abrirDetalle(p));
        document.getElementById('prs-v-imprimir').addEventListener('click', _imprimir);
    }

    function _imprimir() {
        if (!PresupuestoDoc.imprimir(_datosDoc(_abierto))) {
            avisar('El navegador bloqueó la ventana de impresión', 'error');
        }
    }

    /** Enlace que recibe el cliente (presupuesto.html está junto a app.html). */
    function _urlPublica(token) {
        const base = location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
        return `${base}presupuesto.html?t=${token}`;
    }

    async function _copiarEnlace() {
        const token = _abierto._ext?.token_publico;
        if (!token) { avisar('Este presupuesto aún no tiene enlace. Falta ejecutar sql/44.', 'error'); return; }
        const url = _abierto._ext.url_publica || _urlPublica(token);
        try {
            await navigator.clipboard.writeText(url);
            avisar('Enlace copiado');
        } catch {
            prompt('Copia el enlace del presupuesto:', url);
        }
    }

    /** WhatsApp "a mano": abre el chat con el cliente y el mensaje ya escrito, con el
        enlace del presupuesto. No depende del envío automático (API de Meta). */
    function _abrirWhatsApp() {
        const p = _abierto;
        let tel = String(p.cliente_telefono || '').replace(/\D/g, '');
        if (tel.length === 9 && tel.startsWith('9')) tel = '56' + tel;
        else if (tel.length === 8) tel = '569' + tel;
        if (tel.length < 11) { avisar('El cliente no tiene un teléfono válido', 'error'); return false; }

        const token = p._ext?.token_publico;
        if (!token) { avisar('Este presupuesto aún no tiene enlace. Falta ejecutar sql/44.', 'error'); return false; }
        const url = p._ext.url_publica || _urlPublica(token);
        const taller = window.appData.empresa?.nombre || 'el taller';

        const texto = `Hola ${p.cliente_nombre || ''}, te envío el presupuesto N° ${p.numero} de ${taller} ` +
            `por ${fmtCLP(p.total)}. Míralo completo, apruébalo y fírmalo aquí: ${url}`;
        const wa = `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;

        // Sin 'noopener' en el feature: con él window.open devuelve siempre null y no se
        // distingue un bloqueo. Si el celular bloquea la pestaña nueva, se navega en esta.
        const w = window.open(wa, '_blank');
        if (w) { try { w.opener = null; } catch { /* ya aislada */ } }
        else location.href = wa;
        return true;
    }

    /** Envía por WhatsApp y, si era borrador, lo deja marcado como enviado. */
    async function _enviarPorWhatsApp() {
        const p = _abierto;
        if (!(Number(p.total) > 0)) { avisar('Agrega al menos un ítem con precio antes de enviarlo', 'error'); return; }
        if (!p.cliente_telefono) { avisar('El cliente no tiene teléfono: cópiale el enlace', 'error'); return; }

        const btn = document.getElementById('prs-e-wa');
        btn.disabled = true;

        // Primero se marca (el celular pausa la página al abrir WhatsApp), pero el
        // WhatsApp se abre pase lo que pase con el registro.
        let marcado = p.estado !== 'borrador';
        if (!marcado) {
            try {
                const token = p._ext?.token_publico;
                if (token) {
                    const canal = p._appOk ? 'mi_vehiculo' : 'ninguno';   // WhatsApp ya lo manda el taller a mano
                    const { error: eUp } = await db.from('taller_presupuestos')
                        .update({ canal_aviso: canal, url_publica: _urlPublica(token) }).eq('id', p.id);
                    if (eUp) throw eUp;
                    const { data, error } = await db.rpc('fn_responder_presupuesto', {
                        p_empresa_id: window.appData.usuario.empresa_id,
                        p_presupuesto_id: p.id, p_respuesta: 'enviado' });
                    if (error) throw error;
                    marcado = !!data?.ok;
                }
            } catch (err) {
                console.error('[Presupuestos] marcar enviado:', err);
            }
        }

        if (!_abrirWhatsApp()) { btn.disabled = false; return; }

        if (!marcado) avisar('Se abrió WhatsApp, pero no se pudo marcar como enviado. Revisa y reintenta.', 'error');
        cerrarModal();
        await recargar();
        const nuevo = _lista.find(x => x.id === p.id);
        if (nuevo) abrirDetalle(nuevo);
    }

    /** Pregunta cómo informar y manda el presupuesto (o lo reenvía). */
    function _abrirEnvio() {
        const p = _abierto;
        const reenvio = p.estado === 'enviado';

        if (!(Number(p.total) > 0)) { avisar('Agrega al menos un ítem con precio antes de enviarlo', 'error'); return; }

        const inicial = p._ext?.canal_aviso || p._cli?.canal_pref || 'ambos';
        const tel = p.cliente_telefono;
        const app = p._appOk;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${reenvio ? 'Reenviar' : 'Enviar'} presupuesto N° ${esc(p.numero)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            <strong>${esc(p.cliente_nombre) || 'Cliente'}</strong> · ${esc(p.patente) || ''} ·
            <strong>${fmtCLP(p.total)}</strong>
        </div>
        <div class="prs-mas" style="margin-bottom:0.9rem">
            <button class="tll-btn tll-btn--primary" id="prs-e-wa" ${tel ? '' : 'disabled'}>
                💬 Enviar por WhatsApp</button>
            <div style="font-size:0.75rem;color:var(--text-muted);margin:-0.2rem 0 0.2rem">
                ${tel ? `Se abre WhatsApp con el mensaje y el enlace listos para ${esc(tel)}. Solo toca enviar.`
                      : 'El cliente no tiene teléfono. Cópiale el enlace.'}</div>
            <button class="tll-btn tll-btn--ghost" id="prs-e-copiar">🔗 Copiar enlace</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Aviso automático (App / WhatsApp del sistema)</label>
                <select class="tll-select" id="prs-e-canal">
                    ${CANAL_AVISO.map(([v, t]) =>
                        `<option value="${v}" ${v === inicial ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full" style="font-size:0.8rem;line-height:1.6">
                <div>${app ? '✅' : '⚠️'} <strong>App:</strong> ${app
                    ? 'el cliente tiene este vehículo vinculado y lo verá en la App.'
                    : 'este vehículo aún no está vinculado a la App del cliente, así que por ahí no le llega. Vincúlalo en Vehículos → App.'}</div>
                <div>${tel ? '✅' : '⚠️'} <strong>WhatsApp:</strong> ${tel
                    ? `se envía a ${esc(tel)} con un enlace para ver el presupuesto completo.`
                    : 'el cliente no tiene teléfono, por WhatsApp no le llega.'}</div>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--ghost" id="prs-e-ok">${reenvio ? 'Reenviar aviso' : 'Enviar aviso automático'}</button>
        </div>`, '600px');

        document.getElementById('prs-e-wa').addEventListener('click', _enviarPorWhatsApp);
        document.getElementById('prs-e-copiar').addEventListener('click', _copiarEnlace);
        document.getElementById('prs-e-ok').addEventListener('click', () =>
            _enviar(document.getElementById('prs-e-canal').value, reenvio));
    }

    async function _enviar(canal, reenvio) {
        const p = _abierto;
        const btn = document.getElementById('prs-e-ok');
        btn.disabled = true;

        try {
            const eid = window.appData.usuario.empresa_id;
            const token = p._ext?.token_publico;
            if (!token) throw Object.assign(new Error('sin token'), { code: 'SIN_SQL44' });

            // Canal y enlace van en el presupuesto: el aviso los lee de ahí
            const { error: eUp } = await db.from('taller_presupuestos')
                .update({ canal_aviso: canal, url_publica: _urlPublica(token) }).eq('id', p.id);
            if (eUp) throw eUp;

            let canales;
            if (reenvio) {
                const { data, error } = await db.rpc('fn_taller_presupuesto_reenviar', {
                    p_empresa_id: eid, p_presupuesto_id: p.id, p_canal: canal });
                if (error) throw error;
                if (!data?.ok) { avisar(data?.error || 'No se pudo reenviar', 'error'); btn.disabled = false; return; }
                canales = data.canales || [];
            } else {
                const { data, error } = await db.rpc('fn_responder_presupuesto', {
                    p_empresa_id: eid, p_presupuesto_id: p.id, p_respuesta: 'enviado' });
                if (error) throw error;
                if (!data?.ok) { avisar(data?.error || 'No se pudo enviar', 'error'); btn.disabled = false; return; }
                // El trigger arma el aviso: ver por dónde salió
                const { data: ev } = await db.from('taller_notificacion_eventos')
                    .select('taller_notificaciones(canal)').eq('presupuesto_id', p.id)
                    .order('creado_at', { ascending: false }).limit(1);
                canales = (ev?.[0]?.taller_notificaciones || []).map(n => n.canal);
            }

            const nombres = [...new Set(canales)].map(c => CANAL_NOMBRE[c] || c);
            if (canal === 'ninguno') {
                avisar(reenvio ? 'Nada que reenviar: elegiste no avisar'
                               : 'Presupuesto marcado como enviado (sin aviso). Entrégaselo en persona o copia el enlace.');
            } else if (nombres.length === 0) {
                avisar('Quedó enviado, pero al cliente no le llega por ningún canal: sin App vinculada ni teléfono.', 'error');
            } else {
                avisar(`Presupuesto ${reenvio ? 'reenviado' : 'enviado'} por ${nombres.join(' y ')}`);
            }
            cerrarModal();
            await recargar();
            abrirDetalle(_lista.find(x => x.id === p.id));
        } catch (err) {
            console.error('[Presupuestos] enviar:', err);
            btn.disabled = false;
            avisar(err.code === 'SIN_SQL44' || err.code === 'PGRST202' || err.code === '42883' || err.code === '42703'
                ? 'Falta ejecutar sql/44_presupuesto_completo.sql'
                : 'No se pudo enviar. Revisa la consola.', 'error');
        }
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
