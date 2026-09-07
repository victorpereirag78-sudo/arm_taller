// ================================================================
// modulo-agenda.js — Agenda de citas por bahía
// ================================================================
// Tablero del día: una columna por bahía, la hora en la izquierda.
// Es el pizarrón del taller, pero que no se borra.
//
// La unidad de capacidad es la BAHÍA, no la hora: con dos elevadores
// no importa que la agenda diga "9:00 libre" si los dos están
// ocupados. Los choques los bloquea la base (fn_agendar_cita).
//
// Ver sql/09_agenda.sql.
// ================================================================

const ModuloAgenda = (() => {

    let _fecha     = _hoy();
    let _citas     = [];
    let _bahias    = [];
    let _config    = null;
    let _clientes  = [];
    let _vehiculos = [];
    let _empleados = [];
    let _resumen   = null;
    let _solicitudes = [];        // solicitudes de hora desde Mi Vehículo
    let _vista     = 'tablero';   // tablero | lista

    const ESTADOS = [
        ['agendada',   'Agendada',    'presupuesto'],
        ['confirmada', 'Confirmada',  'aprobada'],
        ['en_taller',  'En el taller','reparacion'],
        ['completada', 'Completada',  'lista'],
        ['no_asistio', 'No asistió',  'anulada'],
        ['cancelada',  'Cancelada',   'entregada']
    ];

    const ORIGENES = [['telefono', 'Teléfono'], ['presencial', 'Presencial'],
                      ['whatsapp', 'WhatsApp'], ['email', 'Email'],
                      ['web', 'Web'], ['mantencion', 'Recordatorio de mantención']];

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-agenda');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-kpis" id="agd-kpis"></div>
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--ghost" id="agd-ayer">‹</button>
                <input class="tll-input" id="agd-fecha" type="date" value="${_fecha}" style="max-width:170px">
                <button class="tll-btn tll-btn--ghost" id="agd-manana">›</button>
                <button class="tll-btn tll-btn--ghost" id="agd-hoy">Hoy</button>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--primary" id="agd-nueva">+ Nueva cita</button>
                <select class="tll-select" id="agd-vista" style="max-width:150px">
                    <option value="tablero">Tablero</option>
                    <option value="lista">Lista</option>
                </select>
                <button class="tll-btn tll-btn--ghost" id="agd-reload">↻</button>
            </div>
            <div id="agd-solicitudes"></div>
            <div id="agd-cuerpo"><div class="placeholder-text">Cargando agenda…</div></div>`;

        document.getElementById('agd-fecha').addEventListener('change', (e) => {
            _fecha = e.target.value || _hoy();
            recargar();
        });
        document.getElementById('agd-ayer').addEventListener('click', () => _mover(-1));
        document.getElementById('agd-manana').addEventListener('click', () => _mover(1));
        document.getElementById('agd-hoy').addEventListener('click', () => {
            _fecha = _hoy();
            document.getElementById('agd-fecha').value = _fecha;
            recargar();
        });
        document.getElementById('agd-nueva').addEventListener('click', () => _abrirCita(null));
        document.getElementById('agd-reload').addEventListener('click', recargar);
        document.getElementById('agd-vista').addEventListener('change', (e) => {
            _vista = e.target.value;
            _render();
        });

        await recargar();
    }

    function _mover(dias) {
        const [a, m, d] = _fecha.split('-').map(Number);
        const f = new Date(a, m - 1, d + dias);
        _fecha = _iso(f);
        document.getElementById('agd-fecha').value = _fecha;
        recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [cRes, bRes, cfgRes, cliRes, vehRes, empRes, resRes] = await Promise.all([
                db.from('v_taller_citas').select('*')
                  .eq('empresa_id', eid).eq('fecha', _fecha)
                  .order('hora_inicio'),
                db.from('taller_bahias').select('*')
                  .eq('empresa_id', eid).eq('activo', true).order('orden'),
                db.from('taller_config_agenda').select('*').eq('empresa_id', eid).limit(1),
                db.from('taller_clientes').select('id, nombre, rut, telefono')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre'),
                db.from('taller_vehiculos').select('id, patente, marca, modelo, cliente_id, kilometraje')
                  .eq('empresa_id', eid).eq('activo', true).order('patente').range(0, 4999),
                db.from('taller_empleados').select('id, nombre, cargo')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre'),
                db.rpc('fn_resumen_agenda', { p_empresa_id: eid, p_fecha: _fecha })
            ]);

            if (cRes.error) throw cRes.error;
            _citas     = cRes.data || [];
            _bahias    = bRes.data || [];
            _config    = cfgRes.data?.[0] || null;
            _clientes  = cliRes.data || [];
            _vehiculos = vehRes.data || [];
            _empleados = empRes.data || [];
            _resumen   = resRes.data?.ok ? resRes.data : null;

            // Solicitudes de hora desde Mi Vehículo (silencioso si falta sql/25)
            try {
                const sRes = await db.from('v_taller_solicitudes_hora').select('*')
                    .eq('empresa_id', eid).in('estado', ['nueva', 'contactado'])
                    .order('creado_at', { ascending: false });
                _solicitudes = sRes.error ? [] : (sRes.data || []);
            } catch { _solicitudes = []; }

            _render();
        } catch (err) {
            console.error('[Agenda] cargar:', err);
            const cont = document.getElementById('agd-cuerpo');
            if (cont) {
                cont.innerHTML = errorCarga(err, '09_agenda.sql', 'la agenda');
            }
        }
    }

    // ── Solicitudes de hora (desde Mi Vehículo) ───────────────────
    function _renderSolicitudes() {
        const cont = document.getElementById('agd-solicitudes');
        if (!cont) return;
        const nuevas = _solicitudes.filter(s => s.estado === 'nueva').length;
        if (_solicitudes.length === 0) { cont.innerHTML = ''; return; }

        cont.innerHTML = `
        <details class="tll-rep-card" style="margin-bottom:1rem" ${nuevas ? 'open' : ''}>
            <summary style="cursor:pointer;font-weight:600">
                📨 Solicitudes de hora${nuevas ? ` · <span class="tll-badge presupuesto">${nuevas} nueva${nuevas > 1 ? 's' : ''}</span>` : ''}
            </summary>
            <div style="margin-top:0.7rem;display:flex;flex-direction:column;gap:0.6rem">
            ${_solicitudes.map(s => `
                <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.7rem;font-size:0.86rem">
                    <div style="display:flex;justify-content:space-between;gap:0.5rem">
                        <strong>${esc(s.nombre) || 'Sin nombre'}</strong>
                        <span class="tll-badge ${s.estado === 'nueva' ? 'presupuesto' : 'aprobada'}">${esc(s.estado)}</span>
                    </div>
                    <div style="color:var(--text-secondary);margin-top:0.2rem">
                        ${esc(s.patente || s.vehiculo_desc || '—')}
                        ${s.servicio ? ' · ' + esc(s.servicio) : ''}
                        ${s.telefono ? ' · ' + esc(s.telefono) : ''}
                    </div>
                    ${s.motivo ? `<div style="margin-top:0.2rem">${esc(s.motivo)}</div>` : ''}
                    <div style="color:var(--text-muted);margin-top:0.2rem">
                        ${s.fecha_preferida ? 'Prefiere ' + fmtFecha(s.fecha_preferida) : 'Sin fecha'}
                        ${s.franja && s.franja !== 'cualquiera' ? ' (' + esc(s.franja) + ')' : ''}
                        · pedida ${fmtFecha(s.creado_at)}
                    </div>
                    <div style="display:flex;gap:0.4rem;margin-top:0.5rem;flex-wrap:wrap">
                        <button class="tll-btn tll-btn--primary sol-agendar" data-id="${s.id}">Agendar</button>
                        ${s.telefono ? `<a class="tll-btn tll-btn--ghost" href="https://wa.me/${esc((s.telefono || '').replace(/\D/g, ''))}" target="_blank">WhatsApp</a>` : ''}
                        ${s.estado === 'nueva' ? `<button class="tll-btn tll-btn--ghost sol-contactado" data-id="${s.id}">Marcar contactado</button>` : ''}
                        <button class="tll-btn tll-btn--ghost sol-descartar" data-id="${s.id}">Descartar</button>
                    </div>
                </div>`).join('')}
            </div>
            <p class="tll-rep-nota">Al agendar, crea la cita con <strong>+ Nueva cita</strong>. Convertirla en cita automáticamente llega en una próxima versión.</p>
        </details>`;

        cont.querySelectorAll('.sol-contactado').forEach(b =>
            b.addEventListener('click', () => _marcarSolicitud(b.dataset.id, 'contactado')));
        cont.querySelectorAll('.sol-descartar').forEach(b =>
            b.addEventListener('click', () => _marcarSolicitud(b.dataset.id, 'descartada')));
        cont.querySelectorAll('.sol-agendar').forEach(b =>
            b.addEventListener('click', () =>
                _agendarSolicitud(_solicitudes.find(s => s.id === b.dataset.id))));
    }

    function _agendarSolicitud(s) {
        if (!s) return;
        const bahiasOpt = _bahias.map(x => `<option value="${x.id}">${esc(x.nombre)}</option>`).join('');
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Agendar solicitud</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <p style="color:var(--text-secondary);font-size:0.87rem">
            ${esc(s.nombre) || '—'} · ${esc(s.patente || s.vehiculo_desc || '')}${s.servicio ? ' · ' + esc(s.servicio) : ''}
            ${s.fecha_preferida ? '<br>Prefiere ' + fmtFecha(s.fecha_preferida) + (s.franja && s.franja !== 'cualquiera' ? ' (' + esc(s.franja) + ')' : '') : ''}
        </p>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Fecha *</label>
                <input class="tll-input" id="sol-a-fecha" type="date" value="${s.fecha_preferida || _hoy()}">
            </div>
            <div class="tll-field">
                <label>Hora *</label>
                <input class="tll-input" id="sol-a-hora" type="time" value="${s.franja === 'tarde' ? '15:00' : '09:30'}">
            </div>
            <div class="tll-field">
                <label>Duración (min)</label>
                <input class="tll-input" id="sol-a-dur" type="number" min="15" step="15" value="60">
            </div>
            <div class="tll-field">
                <label>Bahía</label>
                <select class="tll-select" id="sol-a-bahia">
                    <option value="">— Sin asignar —</option>${bahiasOpt}
                </select>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="sol-a-guardar">Crear cita</button>
        </div>`);

        document.getElementById('sol-a-guardar').addEventListener('click', async () => {
            const btn = document.getElementById('sol-a-guardar');
            btn.disabled = true;
            const { data, error } = await db.rpc('fn_solicitud_a_cita', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_solicitud_id: s.id,
                p_fecha: document.getElementById('sol-a-fecha').value,
                p_hora: document.getElementById('sol-a-hora').value,
                p_duracion: Number(document.getElementById('sol-a-dur').value) || 60,
                p_bahia_id: document.getElementById('sol-a-bahia').value || null,
                p_usuario: window.appData.usuario.rut
            });
            if (error || !data?.ok) {
                btn.disabled = false;
                avisar((data && data.error) || 'No se pudo agendar', 'error');
                return;
            }
            avisar('Cita creada y cliente avisado');
            cerrarModal();
            await recargar();
        });
    }

    async function _marcarSolicitud(id, estado) {
        const { error } = await db.from('taller_solicitudes_hora').update({ estado }).eq('id', id);
        if (error) { avisar('No se pudo actualizar', 'error'); return; }
        avisar(estado === 'descartada' ? 'Solicitud descartada' : 'Marcada como contactada');
        await recargar();
    }

    // ── Render ────────────────────────────────────────────────────
    function _render() {
        _renderKpis();
        _renderSolicitudes();
        if (_bahias.length === 0) { _renderSinBahias(); return; }
        if (_vista === 'lista') _renderLista();
        else _renderTablero();
    }

    function _renderKpis() {
        const cont = document.getElementById('agd-kpis');
        if (!cont) return;

        const r = _resumen || {};
        const ocup = _num(r.ocupacion_pct);
        const tasa = _num(r.tasa_inasistencia);

        cont.innerHTML = `
            ${_kpi('📅', _num(r.citas), 'Citas del día')}
            ${_kpi('📊', ocup + '%', 'Ocupación de bahías',
                   ocup > 90 ? '#fbbf24' : ocup > 0 ? '#34d399' : '')}
            ${_kpi('⏳', _num(r.sin_confirmar), 'Sin confirmar',
                   _num(r.sin_confirmar) ? '#fbbf24' : '')}
            ${_kpi('🚫', tasa + '%', 'Inasistencia (90 d)',
                   tasa > 15 ? '#f87171' : '')}`;
    }

    function _renderSinBahias() {
        const cont = document.getElementById('agd-cuerpo');
        if (!cont) return;

        cont.innerHTML = `
            <div class="placeholder-text" style="padding:2.5rem 1rem">
                <div style="font-size:2rem;margin-bottom:0.5rem">🅿️</div>
                <strong>Sin bahías configuradas</strong><br>
                La agenda se organiza por puesto de trabajo: sin bahías no hay dónde
                poner los autos.<br>
                <div style="margin-top:1rem">
                    <button class="tll-btn tll-btn--primary" id="agd-init">
                        Crear 3 bahías y horario por defecto</button>
                </div>
            </div>`;

        document.getElementById('agd-init').addEventListener('click', async () => {
            const res = await _rpc('fn_agenda_inicial', {
                p_empresa_id: window.appData.usuario.empresa_id
            });
            if (!res?.ok) { avisar(res?.error || 'No se pudo inicializar', 'error'); return; }
            avisar(`${res.bahias_creadas} bahías creadas — ajústalas a tu taller`);
            await recargar();
        });
    }

    // ── Tablero del día ───────────────────────────────────────────
    function _renderTablero() {
        const cont = document.getElementById('agd-cuerpo');
        if (!cont) return;

        const apertura = _min(_config?.hora_apertura || '09:00');
        const cierre   = _min(_config?.hora_cierre   || '18:30');
        const paso     = _num(_config?.intervalo_min) || 30;
        const slots    = Math.max(Math.ceil((cierre - apertura) / paso), 1);
        const ALTO     = 26;   // px por slot

        // Columna "sin bahía" solo si hace falta
        const sinBahia = _citas.filter(c => !c.bahia_id && c.estado !== 'cancelada');
        const columnas = [..._bahias, ...(sinBahia.length ? [{ id: null, nombre: 'Sin bahía' }] : [])];

        const horas = [];
        for (let i = 0; i <= slots; i++) {
            const m = apertura + i * paso;
            horas.push(`<div class="tll-agd-hora" style="height:${ALTO}px">${_hhmm(m)}</div>`);
        }

        const bloque = (c) => {
            const ini = _min(c.hora_inicio);
            const top = ((ini - apertura) / paso) * ALTO;
            const alto = Math.max((_num(c.duracion_min) / paso) * ALTO - 2, 18);
            const estado = ESTADOS.find(e => e[0] === c.estado);
            return `
            <div class="tll-agd-cita est-${esc(c.estado)}" data-id="${c.id}"
                 style="top:${top}px;height:${alto}px"
                 title="${esc(c.hora_inicio?.slice(0,5))} · ${esc(c.cliente_nombre) || 'Sin cliente'} · ${esc(estado?.[1] || c.estado)}">
                <div class="tll-agd-cita-hora">${esc(c.hora_inicio?.slice(0,5))}</div>
                <div class="tll-agd-cita-txt">
                    <strong>${esc(c.patente) || esc(c.cliente_nombre) || 'Cita'}</strong>
                    ${alto > 34 ? `<span>${esc(c.servicio || c.motivo || '')}</span>` : ''}
                </div>
            </div>`;
        };

        cont.innerHTML = `
        <div class="tll-agd-wrap">
            <div class="tll-agd-grid" style="grid-template-columns:64px repeat(${columnas.length}, minmax(140px, 1fr))">
                <div class="tll-agd-cabecera"></div>
                ${columnas.map(b => `
                    <div class="tll-agd-cabecera">${esc(b.nombre)}
                        ${b.tipo ? `<span>${esc(b.tipo)}</span>` : ''}</div>`).join('')}

                <div class="tll-agd-horas">${horas.join('')}</div>
                ${columnas.map(b => `
                    <div class="tll-agd-col" data-bahia="${b.id || ''}"
                         style="height:${slots * ALTO}px">
                        ${Array.from({ length: slots }, (_, i) =>
                            `<div class="tll-agd-slot" style="height:${ALTO}px"
                                  data-min="${apertura + i * paso}"></div>`).join('')}
                        ${_citas
                            .filter(c => (c.bahia_id || null) === b.id && c.estado !== 'cancelada')
                            .map(bloque).join('')}
                    </div>`).join('')}
            </div>
        </div>
        <p class="tll-rep-nota">
            Haz clic en un espacio libre para agendar ahí, o en una cita para abrirla.
            ${_citas.filter(c => c.estado === 'cancelada').length
                ? `${_citas.filter(c => c.estado === 'cancelada').length} cita(s) cancelada(s) no se muestran.`
                : ''}
        </p>`;

        // Clic en una cita → abrirla
        cont.querySelectorAll('.tll-agd-cita').forEach(el =>
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                _abrirCita(_citas.find(c => c.id === el.dataset.id));
            }));

        // Clic en un hueco → agendar en esa bahía y hora
        cont.querySelectorAll('.tll-agd-slot').forEach(el =>
            el.addEventListener('click', () => {
                const col = el.closest('.tll-agd-col');
                _abrirCita(null, {
                    bahia_id: col.dataset.bahia || null,
                    hora: _hhmm(Number(el.dataset.min))
                });
            }));
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('agd-cuerpo');
        if (!cont) return;

        if (_citas.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                Sin citas para el ${fmtFecha(_fecha)}.</div>`;
            return;
        }

        cont.innerHTML = `
        <div class="tll-tabla-wrap">
        <table class="tll-tabla">
            <thead><tr>
                <th>Hora</th><th>Vehículo</th><th>Cliente</th><th>Servicio</th>
                <th>Bahía</th><th>Estado</th><th></th>
            </tr></thead>
            <tbody>
            ${_citas.map(c => `
                <tr${c.estado === 'cancelada' ? ' style="opacity:0.45"' : ''}>
                    <td style="font-family:var(--font-mono);white-space:nowrap">
                        <strong>${esc(c.hora_inicio?.slice(0,5))}</strong>
                        <div style="font-size:0.68rem;color:var(--text-muted)">
                            ${c.duracion_min} min</div></td>
                    <td style="font-family:var(--font-mono)">${esc(c.patente) || '—'}
                        <div style="font-size:0.7rem;color:var(--text-secondary);font-family:inherit">
                            ${esc([c.marca, c.modelo].filter(Boolean).join(' '))}</div></td>
                    <td>${esc(c.cliente_nombre) || '—'}
                        ${c.cliente_telefono ? `<div style="font-size:0.72rem;color:var(--text-secondary)">${esc(c.cliente_telefono)}</div>` : ''}</td>
                    <td>${esc(c.servicio || c.motivo) || '—'}</td>
                    <td>${esc(c.bahia_nombre) || '<span style="color:var(--text-muted)">—</span>'}</td>
                    <td>${_badge(c.estado)}</td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost agd-abrir" data-id="${c.id}">Abrir</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table></div>`;

        cont.querySelectorAll('.agd-abrir').forEach(b =>
            b.addEventListener('click', () => _abrirCita(_citas.find(c => c.id === b.dataset.id))));
    }

    // ── Crear / editar cita ───────────────────────────────────────
    function _abrirCita(cita, preset = {}) {
        const esNueva = !cita;
        const dur = cita?.duracion_min || _config?.duracion_default || 60;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${esNueva ? 'Nueva cita' : `Cita N° ${esc(cita.numero)}`}
                ${!esNueva ? `<span class="tll-badge ${_clase(cita.estado)}"
                    style="margin-left:0.4rem">${esc(cita.estado)}</span>` : ''}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>

        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Fecha *</label>
                <input class="tll-input" id="agd-c-fecha" type="date"
                       value="${esc(cita?.fecha || _fecha)}">
            </div>
            <div class="tll-field">
                <label>Hora *</label>
                <input class="tll-input" id="agd-c-hora" type="time"
                       value="${esc(cita?.hora_inicio?.slice(0,5) || preset.hora || '09:00')}">
            </div>
            <div class="tll-field">
                <label>Duración (min)</label>
                <select class="tll-select" id="agd-c-duracion">
                    ${[30, 60, 90, 120, 180, 240, 480].map(m =>
                        `<option value="${m}" ${m === dur ? 'selected' : ''}>${_durTxt(m)}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Bahía</label>
                <select class="tll-select" id="agd-c-bahia">
                    <option value="">— Sin asignar —</option>
                    ${_bahias.map(b => `<option value="${b.id}"
                        ${(cita?.bahia_id || preset.bahia_id) === b.id ? 'selected' : ''}>
                        ${esc(b.nombre)}</option>`).join('')}
                </select>
            </div>
            ${_empleados.length ? `
            <div class="tll-field">
                <label>Mecánico</label>
                <select class="tll-select" id="agd-c-mecanico">
                    <option value="">— Sin asignar —</option>
                    ${_empleados.map(e => `<option value="${e.id}"
                        ${cita?.mecanico_id === e.id ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}
                </select>
            </div>` : ''}
            <div class="tll-field">
                <label>Origen</label>
                <select class="tll-select" id="agd-c-origen">
                    ${ORIGENES.map(([v, t]) => `<option value="${v}"
                        ${(cita?.origen || 'telefono') === v ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>

            <div class="tll-field tll-field--full">
                <label>Cliente</label>
                <select class="tll-select" id="agd-c-cliente">
                    <option value="">— Cliente nuevo / no registrado —</option>
                    ${_clientes.map(c => `<option value="${c.id}"
                        ${cita?.cliente_id === c.id ? 'selected' : ''}>
                        ${esc(c.nombre)}${c.rut ? ' · ' + esc(c.rut) : ''}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <label>Vehículo</label>
                <select class="tll-select" id="agd-c-vehiculo">
                    <option value="">— No registrado —</option>
                </select>
            </div>

            <div class="tll-field tll-field--full oculto" id="agd-c-libre">
                <div class="tll-form-grid">
                    <div class="tll-field">
                        <label>Nombre del cliente</label>
                        <input class="tll-input" id="agd-c-nombre" value="${esc(cita?.cliente_texto || '')}">
                    </div>
                    <div class="tll-field">
                        <label>Teléfono</label>
                        <input class="tll-input" id="agd-c-telefono" value="${esc(cita?.telefono || '')}">
                    </div>
                    <div class="tll-field">
                        <label>Patente</label>
                        <input class="tll-input" id="agd-c-patente"
                               style="font-family:var(--font-mono);text-transform:uppercase"
                               value="${esc(cita?.patente_texto || '')}">
                    </div>
                </div>
                <span class="tll-field-msg">
                    Se registran como texto. Al llegar el auto se crean de verdad en Recepción.</span>
            </div>

            <div class="tll-field tll-field--full">
                <label>Servicio</label>
                <input class="tll-input" id="agd-c-servicio"
                       placeholder="Ej: mantención 40.000 km, cambio de frenos"
                       value="${esc(cita?.servicio || '')}">
            </div>
            <div class="tll-field tll-field--full">
                <label>Notas</label>
                <textarea class="tll-textarea" id="agd-c-motivo">${esc(cita?.motivo || '')}</textarea>
            </div>
        </div>

        <div class="tll-modal-footer">
            ${!esNueva ? `
                <select class="tll-select" id="agd-c-estado" style="max-width:170px">
                    ${ESTADOS.map(([v, t]) => `<option value="${v}"
                        ${cita.estado === v ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
                ${cita.vehiculo_id && !cita.orden_id && cita.estado !== 'cancelada'
                    ? `<button class="tll-btn tll-btn--primary" id="agd-c-llego">🚗 Llegó → crear OT</button>` : ''}
                <div class="tll-toolbar-sep"></div>` : ''}
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="agd-c-guardar">
                ${esNueva ? 'Agendar' : 'Guardar'}</button>
        </div>`, '720px');

        // Cliente → sus vehículos, o campos libres si no está registrado
        const selCli = document.getElementById('agd-c-cliente');
        const cargarVeh = () => {
            const sel = document.getElementById('agd-c-vehiculo');
            const libre = document.getElementById('agd-c-libre');

            if (!selCli.value) {
                sel.innerHTML = '<option value="">— No registrado —</option>';
                sel.disabled = true;
                libre.classList.remove('oculto');
                return;
            }
            libre.classList.add('oculto');
            const suyos = _vehiculos.filter(v => v.cliente_id === selCli.value);
            sel.innerHTML = '<option value="">— No registrado —</option>' +
                suyos.map(v => `<option value="${v.id}"
                    ${cita?.vehiculo_id === v.id ? 'selected' : ''}>
                    ${esc(v.patente)} · ${esc([v.marca, v.modelo].filter(Boolean).join(' '))}
                </option>`).join('');
            sel.disabled = false;
        };
        selCli.addEventListener('change', cargarVeh);
        cargarVeh();

        document.getElementById('agd-c-guardar')
            .addEventListener('click', () => _guardar(cita));
        document.getElementById('agd-c-llego')?.addEventListener('click', () => _llego(cita));
    }

    async function _guardar(cita) {
        const fecha = document.getElementById('agd-c-fecha').value;
        const hora  = document.getElementById('agd-c-hora').value;
        if (!fecha || !hora) { avisar('Fecha y hora son obligatorias', 'error'); return; }

        const clienteId = document.getElementById('agd-c-cliente').value || null;
        const nombre    = document.getElementById('agd-c-nombre')?.value.trim() || null;

        if (!clienteId && !nombre) {
            avisar('Indica el cliente: elígelo de la lista o escribe su nombre', 'error');
            return;
        }

        const btn = document.getElementById('agd-c-guardar');
        btn.disabled = true;

        const res = await _rpc('fn_agendar_cita', {
            p_empresa_id:    window.appData.usuario.empresa_id,
            p_fecha:         fecha,
            p_hora:          hora,
            p_duracion:      Number(document.getElementById('agd-c-duracion').value) || 60,
            p_cliente_id:    clienteId,
            p_vehiculo_id:   document.getElementById('agd-c-vehiculo').value || null,
            p_bahia_id:      document.getElementById('agd-c-bahia').value || null,
            p_mecanico_id:   document.getElementById('agd-c-mecanico')?.value || null,
            p_servicio:      document.getElementById('agd-c-servicio').value.trim() || null,
            p_motivo:        document.getElementById('agd-c-motivo').value.trim() || null,
            p_origen:        document.getElementById('agd-c-origen').value,
            p_cliente_texto: clienteId ? null : nombre,
            p_patente_texto: clienteId ? null : (document.getElementById('agd-c-patente')?.value.trim() || null),
            p_telefono:      clienteId ? null : (document.getElementById('agd-c-telefono')?.value.trim() || null),
            p_mantencion_id: cita?.mantencion_id || null,
            p_cita_id:       cita?.id || null,
            p_usuario:       window.appData.usuario.rut
        });

        if (!res) { btn.disabled = false; return; }
        if (!res.ok) { avisar(res.error || 'No se pudo agendar', 'error'); btn.disabled = false; return; }

        // El estado se guarda aparte: el RPC solo mueve horario y asignaciones
        const selEstado = document.getElementById('agd-c-estado');
        if (cita && selEstado && selEstado.value !== cita.estado) {
            await db.from('taller_citas')
                .update({ estado: selEstado.value }).eq('id', cita.id);
        }

        avisar(cita
            ? `Cita N° ${cita.numero} actualizada`
            : `Cita N° ${res.numero} agendada · ${document.getElementById('agd-c-hora').value} a ${res.hora_fin}`);
        cerrarModal();
        await recargar();
    }

    async function _llego(cita) {
        const km = prompt(
            `El auto ${cita.patente || ''} llegó al taller.\n\n` +
            `Se crea la orden de trabajo en estado "recepción".\n\n` +
            `Kilometraje actual (opcional):`, cita.kilometraje || '');
        if (km === null) return;

        const btn = document.getElementById('agd-c-llego');
        btn.disabled = true;

        const res = await _rpc('fn_cita_a_orden', {
            p_empresa_id: window.appData.usuario.empresa_id,
            p_cita_id: cita.id,
            p_km: Number(km) || null,
            p_usuario: window.appData.usuario.rut
        });

        if (!res) { btn.disabled = false; return; }
        if (!res.ok) { avisar(res.error || 'No se pudo crear la OT', 'error'); btn.disabled = false; return; }

        avisar(`Orden de trabajo N° ${res.numero} creada`);
        cerrarModal();
        await recargar();

        if (typeof ModuloOrdenes !== 'undefined') ModuloOrdenes.abrirPorId(res.orden_id);
    }

    // ── Helpers ───────────────────────────────────────────────────
    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Agenda] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/09_agenda.sql (${nombre})`
                : 'Error en la operación. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _clase(estado) {
        return ESTADOS.find(e => e[0] === estado)?.[2] || 'entregada';
    }

    function _badge(estado) {
        const e = ESTADOS.find(x => x[0] === estado);
        return `<span class="tll-badge ${_clase(estado)}">${esc(e?.[1] || estado)}</span>`;
    }

    /** "09:30:00" → 570 minutos desde medianoche */
    function _min(hhmm) {
        const [h, m] = String(hhmm || '0:0').split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    }

    function _hhmm(min) {
        return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    }

    function _durTxt(m) {
        if (m < 60) return m + ' min';
        const h = m / 60;
        return (Number.isInteger(h) ? h : h.toFixed(1).replace('.', ',')) + ' h';
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function _iso(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function _hoy() { return _iso(new Date()); }

    function _kpi(icono, valor, label, color = '') {
        return `
        <div class="tll-kpi">
            <span class="tll-kpi-icono">${icono}</span>
            <div class="tll-kpi-valor" style="${color ? `color:${color}` : ''}">${valor}</div>
            <div class="tll-kpi-label">${label}</div>
        </div>`;
    }

    return { init, recargar };

})();
