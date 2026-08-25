// ================================================================
// modulo-mantenciones.js — Mantenciones programadas y vencimientos
// ================================================================
// La lista de llamados de mañana. Una mantención vence por lo que
// ocurra primero: la fecha o el kilometraje.
//
// El sistema NO envía nada solo: prepara el mensaje y abre WhatsApp
// o el teléfono para que la persona lo revise y lo mande. Avisarle a
// un cliente equivocado cuesta más caro que no avisarle.
//
// Ver sql/07_mantenciones.sql.
// ================================================================

const ModuloMantenciones = (() => {

    let _pendientes = [];
    let _planes     = [];
    let _vehiculos  = [];
    let _vista      = 'pendientes';   // pendientes | planes
    let _filtro     = 'accionables';

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-mantenciones');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-tabs">
                <button class="tll-tab active" data-vista="pendientes">Por atender</button>
                <button class="tll-tab" data-vista="planes">Planes del taller</button>
            </div>
            <div id="mnt-cuerpo"><div class="placeholder-text">Cargando…</div></div>`;

        cont.querySelectorAll('.tll-tab').forEach(t =>
            t.addEventListener('click', () => {
                _vista = t.dataset.vista;
                cont.querySelectorAll('.tll-tab').forEach(x =>
                    x.classList.toggle('active', x === t));
                _render();
            }));

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [pRes, plRes, vRes] = await Promise.all([
                db.from('v_taller_mantenciones_pendientes').select('*')
                  .eq('empresa_id', eid)
                  .order('prioridad').order('dias_restantes', { nullsFirst: false })
                  .range(0, 1999),
                db.from('taller_planes_mantencion').select('*')
                  .eq('empresa_id', eid).order('nombre'),
                db.from('taller_vehiculos').select('id, patente, marca, modelo, kilometraje')
                  .eq('empresa_id', eid).eq('activo', true).order('patente').range(0, 4999)
            ]);

            if (pRes.error) throw pRes.error;
            _pendientes = pRes.data || [];
            _planes     = plRes.data || [];
            _vehiculos  = vRes.data || [];
            _render();
        } catch (err) {
            console.error('[Mantenciones] cargar:', err);
            const cont = document.getElementById('mnt-cuerpo');
            if (cont) {
                cont.innerHTML = errorCarga(err, '07_mantenciones.sql', 'las mantenciones');
            }
        }
    }

    function _render() {
        if (_vista === 'planes') _renderPlanes();
        else _renderPendientes();
    }

    // ══ POR ATENDER ═══════════════════════════════════════════════
    function _renderPendientes() {
        const cont = document.getElementById('mnt-cuerpo');
        if (!cont) return;

        const vencidas   = _pendientes.filter(m => m.situacion === 'vencida');
        const porVencer  = _pendientes.filter(m => m.situacion === 'por_vencer');
        const sinAvisar  = [...vencidas, ...porVencer].filter(m => !m.avisado_at);
        const sinTel     = [...vencidas, ...porVencer].filter(m => !m.telefono);

        cont.innerHTML = `
            <div class="tll-kpis">
                ${_kpi('🔴', vencidas.length, 'Vencidas', vencidas.length ? '#f87171' : '')}
                ${_kpi('🟡', porVencer.length, 'Por vencer')}
                ${_kpi('📞', sinAvisar.length, 'Sin contactar')}
                ${_kpi('🚗', _vehiculos.length, 'Vehículos con seguimiento')}
            </div>

            ${sinTel.length ? `
            <div class="tll-recep-notfound" style="margin-bottom:1rem">
                ${sinTel.length} vehículo(s) por atender <strong>sin teléfono del cliente</strong>.
                Cárgalo en Clientes o no hay a quién llamar.
            </div>` : ''}

            <div class="tll-toolbar">
                <select class="tll-select" id="mnt-filtro" style="max-width:210px">
                    <option value="accionables">Vencidas y por vencer</option>
                    <option value="vencida">Solo vencidas</option>
                    <option value="por_vencer">Solo por vencer</option>
                    <option value="sin_avisar">Sin contactar</option>
                    <option value="todas">Todas</option>
                </select>
                <input class="tll-input" id="mnt-buscar" placeholder="Buscar por patente, cliente o mantención…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="mnt-programar">+ Programar a un vehículo</button>
                <button class="tll-btn tll-btn--ghost" id="mnt-reload">↻ Actualizar</button>
            </div>
            <div id="mnt-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('mnt-filtro').value = _filtro;
        document.getElementById('mnt-filtro').addEventListener('change', (e) => {
            _filtro = e.target.value;
            _renderLista();
        });
        document.getElementById('mnt-buscar').addEventListener('input', _renderLista);
        document.getElementById('mnt-reload').addEventListener('click', recargar);
        document.getElementById('mnt-programar').addEventListener('click', _abrirProgramar);

        _renderLista();
    }

    function _renderLista() {
        const cont = document.getElementById('mnt-lista');
        if (!cont) return;

        const q = (document.getElementById('mnt-buscar')?.value || '').toLowerCase().trim();

        let lista = _pendientes.filter(m => {
            switch (_filtro) {
                case 'accionables': return m.situacion !== 'vigente';
                case 'vencida':     return m.situacion === 'vencida';
                case 'por_vencer':  return m.situacion === 'por_vencer';
                case 'sin_avisar':  return m.situacion !== 'vigente' && !m.avisado_at;
                default:            return true;
            }
        });

        if (q) {
            lista = lista.filter(m =>
                (m.patente || '').toLowerCase().includes(q) ||
                (m.cliente || '').toLowerCase().includes(q) ||
                (m.descripcion || '').toLowerCase().includes(q) ||
                (m.marca || '').toLowerCase().includes(q) ||
                (m.modelo || '').toLowerCase().includes(q));
        }

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_pendientes.length === 0
                    ? 'Sin mantenciones programadas. Carga los planes del taller y aplícalos a los vehículos.'
                    : 'Nada que atender con ese filtro. Buena señal.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Vehículo</th><th>Cliente</th><th>Mantención</th>
                <th>Vence</th><th>Situación</th><th>Contacto</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(m => `
                <tr>
                    <td style="font-family:var(--font-mono)"><strong>${esc(m.patente)}</strong>
                        <div style="font-size:0.7rem;color:var(--text-secondary);font-family:inherit">
                            ${esc([m.marca, m.modelo].filter(Boolean).join(' '))}</div>
                        <div style="font-size:0.68rem;color:var(--text-muted)">
                            ${_fmtKm(m.km_actual)} km</div></td>
                    <td>${esc(m.cliente) || '<span style="color:var(--text-muted)">Sin dueño</span>'}
                        ${m.telefono
                            ? `<div style="font-size:0.72rem;color:var(--text-secondary)">${esc(m.telefono)}</div>`
                            : '<div style="font-size:0.7rem;color:#f87171">sin teléfono</div>'}</td>
                    <td>${esc(m.descripcion)}
                        ${m.tipo === 'documento' ? '<span class="tll-badge presupuesto">documento</span>' : ''}</td>
                    <td>${_vence(m)}</td>
                    <td>${_badgeSituacion(m.situacion)}</td>
                    <td>${m.avisado_at
                        ? `<span class="tll-badge entregada">avisado</span>
                           <div style="font-size:0.68rem;color:var(--text-muted)">${fmtFecha(m.avisado_at)}</div>`
                        : '<span style="color:var(--text-muted);font-size:0.75rem">—</span>'}</td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="tll-btn tll-btn--ghost mnt-avisar" data-id="${m.mantencion_id}">Contactar</button>
                        <button class="tll-btn tll-btn--primary mnt-completar" data-id="${m.mantencion_id}">Hecha</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        const porId = (b) => _pendientes.find(m => m.mantencion_id === b.dataset.id);
        cont.querySelectorAll('.mnt-avisar').forEach(b =>
            b.addEventListener('click', () => _abrirContacto(porId(b))));
        cont.querySelectorAll('.mnt-completar').forEach(b =>
            b.addEventListener('click', () => _abrirCompletar(porId(b))));
    }

    // ── Contactar al cliente ──────────────────────────────────────
    function _abrirContacto(m) {
        if (!m) return;

        const mensaje = _mensaje(m);
        const tel = (m.telefono || '').replace(/\D/g, '');
        const wa  = tel ? `https://wa.me/${tel.length === 9 ? '56' + tel : tel}?text=${encodeURIComponent(mensaje)}` : null;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Contactar · ${esc(m.patente)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            <strong>${esc(m.cliente) || 'Sin dueño registrado'}</strong>
            ${m.telefono ? ` · ${esc(m.telefono)}` : ' · <span style="color:#f87171">sin teléfono</span>'}<br>
            ${esc(m.descripcion)} · ${_venceTexto(m)}
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Mensaje sugerido</label>
                <textarea class="tll-textarea" id="mnt-c-mensaje" rows="5">${esc(mensaje)}</textarea>
                <span class="tll-field-msg">Revísalo antes de enviarlo. El sistema no manda nada solo.</span>
            </div>
            <div class="tll-field tll-field--full">
                <label>Nota del contacto (queda en el historial)</label>
                <input class="tll-input" id="mnt-c-nota" placeholder="Ej: llamado, dijo que viene el viernes">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" id="mnt-c-copiar">📋 Copiar mensaje</button>
            ${wa ? `<a class="tll-btn tll-btn--ghost" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
            ${m.telefono ? `<a class="tll-btn tll-btn--ghost" href="tel:${esc(m.telefono)}">Llamar</a>` : ''}
            <div class="tll-toolbar-sep"></div>
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="mnt-c-ok">Marcar contactado</button>
        </div>`, '620px');

        document.getElementById('mnt-c-copiar').addEventListener('click', async () => {
            const txt = document.getElementById('mnt-c-mensaje').value;
            try {
                await navigator.clipboard.writeText(txt);
                avisar('Mensaje copiado');
            } catch {
                document.getElementById('mnt-c-mensaje').select();
                avisar('Selecciona y copia con Ctrl+C', 'error');
            }
        });

        document.getElementById('mnt-c-ok').addEventListener('click', async () => {
            const btn = document.getElementById('mnt-c-ok');
            btn.disabled = true;

            const res = await _rpc('fn_marcar_avisada', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_mantencion_id: m.mantencion_id,
                p_nota: document.getElementById('mnt-c-nota').value.trim() || null
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo registrar', 'error'); btn.disabled = false; return; }

            avisar('Contacto registrado');
            cerrarModal();
            await recargar();
        });
    }

    function _mensaje(m) {
        const taller = window.appData.empresa?.nombre || 'el taller';
        const nombre = (m.cliente || '').split(' ')[0] || 'Hola';
        const auto   = [m.marca, m.modelo].filter(Boolean).join(' ') || 'su vehículo';

        if (m.tipo === 'documento') {
            return `Hola ${nombre}, le escribimos de ${taller}. ` +
                   `Le recordamos que ${m.descripcion.toLowerCase()} de su ${auto} ` +
                   `patente ${m.patente} ${m.situacion === 'vencida' ? 'está vencida' : 'vence pronto'}` +
                   `${m.proxima_fecha ? ` (${fmtFecha(m.proxima_fecha)})` : ''}. ` +
                   `Cualquier consulta, quedamos atentos.`;
        }

        const detalle = m.gatillo === 'km' && m.proximo_km
            ? `ya alcanzó los ${_fmtKm(m.km_actual)} km y le corresponde a los ${_fmtKm(m.proximo_km)} km`
            : `le corresponde ${m.proxima_fecha ? 'el ' + fmtFecha(m.proxima_fecha) : 'próximamente'}`;

        return `Hola ${nombre}, le escribimos de ${taller}. ` +
               `Su ${auto} patente ${m.patente} tiene pendiente: ${m.descripcion}. ` +
               `Según nuestro registro ${detalle}. ` +
               `¿Le agendamos una hora esta semana?`;
    }

    // ── Marcar como hecha ─────────────────────────────────────────
    function _abrirCompletar(m) {
        if (!m) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Mantención realizada · ${esc(m.patente)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            <strong>${esc(m.descripcion)}</strong><br>
            Al marcarla hecha se agenda automáticamente la siguiente
            ${m.cada_km || m.cada_meses ? '' : '(esta no se repite)'}.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Fecha</label>
                <input class="tll-input" id="mnt-h-fecha" type="date" value="${_hoy()}">
            </div>
            <div class="tll-field">
                <label>Kilometraje</label>
                <input class="tll-input" id="mnt-h-km" type="number" min="0" value="${_num(m.km_actual)}">
            </div>
            <div class="tll-field tll-field--full">
                <label>Notas</label>
                <input class="tll-input" id="mnt-h-notas" placeholder="Ej: se cambió también el filtro de aire">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--danger" id="mnt-h-cancelar">No aplica (cancelar)</button>
            <button class="tll-btn tll-btn--primary" id="mnt-h-ok">Marcar hecha</button>
        </div>`, '560px');

        document.getElementById('mnt-h-ok').addEventListener('click', async () => {
            const btn = document.getElementById('mnt-h-ok');
            btn.disabled = true;

            const res = await _rpc('fn_completar_mantencion', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_mantencion_id: m.mantencion_id,
                p_km: Number(document.getElementById('mnt-h-km').value) || null,
                p_fecha: document.getElementById('mnt-h-fecha').value || null,
                p_orden_id: null,
                p_notas: document.getElementById('mnt-h-notas').value.trim() || null
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo completar', 'error'); btn.disabled = false; return; }

            avisar(res.siguiente_id
                ? 'Mantención hecha · la siguiente ya quedó agendada'
                : 'Mantención hecha');
            cerrarModal();
            await recargar();
        });

        document.getElementById('mnt-h-cancelar').addEventListener('click', async () => {
            if (!confirm('Cancelar esta mantención.\n\nNo se agendará la siguiente. ¿Continuar?')) return;
            try {
                const { error } = await db.from('taller_mantenciones')
                    .update({ estado: 'cancelada' }).eq('id', m.mantencion_id);
                if (error) throw error;
                avisar('Mantención cancelada');
                cerrarModal();
                await recargar();
            } catch (err) {
                console.error('[Mantenciones] cancelar:', err);
                avisar('No se pudo cancelar', 'error');
            }
        });
    }

    // ── Programar a un vehículo ───────────────────────────────────
    function _abrirProgramar() {
        if (_planes.filter(p => p.activo).length === 0) {
            avisar('Primero carga los planes del taller', 'error');
            _vista = 'planes';
            document.querySelectorAll('.tll-tab').forEach(t =>
                t.classList.toggle('active', t.dataset.vista === 'planes'));
            _render();
            return;
        }

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Programar mantenciones a un vehículo</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            Aplica todos los planes activos que el vehículo aún no tenga,
            tomando su kilometraje actual como punto de partida.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Vehículo *</label>
                <select class="tll-select" id="mnt-p-vehiculo">
                    <option value="">— Selecciona —</option>
                    ${_vehiculos.map(v => `
                        <option value="${v.id}" data-km="${v.kilometraje || 0}">
                            ${esc(v.patente)} · ${esc([v.marca, v.modelo].filter(Boolean).join(' '))}
                        </option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Kilometraje de referencia</label>
                <input class="tll-input" id="mnt-p-km" type="number" min="0" value="0">
            </div>
            <div class="tll-field">
                <label>Fecha de referencia</label>
                <input class="tll-input" id="mnt-p-fecha" type="date" value="${_hoy()}">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="mnt-p-ok">Programar</button>
        </div>`, '580px');

        document.getElementById('mnt-p-vehiculo').addEventListener('change', (e) => {
            document.getElementById('mnt-p-km').value = e.target.selectedOptions[0]?.dataset.km || 0;
        });

        document.getElementById('mnt-p-ok').addEventListener('click', async () => {
            const vehiculoId = document.getElementById('mnt-p-vehiculo').value;
            if (!vehiculoId) { avisar('Selecciona el vehículo', 'error'); return; }

            const btn = document.getElementById('mnt-p-ok');
            btn.disabled = true;

            const res = await _rpc('fn_aplicar_planes_vehiculo', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_vehiculo_id: vehiculoId,
                p_km_base: Number(document.getElementById('mnt-p-km').value) || 0,
                p_fecha_base: document.getElementById('mnt-p-fecha').value || null
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo programar', 'error'); btn.disabled = false; return; }

            avisar(res.creados > 0
                ? `${res.creados} mantención(es) programada(s)`
                : 'Este vehículo ya tenía todos los planes programados');
            cerrarModal();
            await recargar();
        });
    }

    // ══ PLANES ════════════════════════════════════════════════════
    function _renderPlanes() {
        const cont = document.getElementById('mnt-cuerpo');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="pln-nuevo">+ Nuevo plan</button>
                ${_planes.length === 0
                    ? `<button class="tll-btn tll-btn--ghost" id="pln-sugeridos">⚡ Cargar planes sugeridos</button>`
                    : ''}
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="pln-reload">↻ Actualizar</button>
            </div>
            <div id="pln-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('pln-nuevo').addEventListener('click', () => _abrirPlan(null));
        document.getElementById('pln-reload').addEventListener('click', recargar);
        document.getElementById('pln-sugeridos')?.addEventListener('click', _cargarSugeridos);

        const lista = document.getElementById('pln-lista');

        if (_planes.length === 0) {
            lista.innerHTML = `<div class="placeholder-text" style="padding:2rem 1rem">
                <div style="font-size:2rem;margin-bottom:0.5rem">🔔</div>
                <strong>Sin planes de mantención</strong><br>
                Los planes definen cada cuánto toca cada servicio.<br>
                <span style="font-size:0.78rem;color:var(--text-muted)">
                    Parte con los sugeridos (aceite, frenos, revisión técnica…) y ajústalos.</span>
            </div>`;
            return;
        }

        lista.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Plan</th><th>Tipo</th><th>Cada</th><th>Avisar con</th>
                <th style="text-align:right">Programadas</th><th>Estado</th><th></th>
            </tr></thead>
            <tbody>
            ${_planes.map(p => {
                const usos = _pendientes.filter(m => m.plan_id === p.id).length;
                return `
                <tr${p.activo ? '' : ' style="opacity:0.5"'}>
                    <td><strong>${esc(p.nombre)}</strong>
                        ${p.descripcion ? `<div style="font-size:0.72rem;color:var(--text-secondary)">${esc(p.descripcion)}</div>` : ''}</td>
                    <td>${p.tipo === 'documento'
                        ? '<span class="tll-badge presupuesto">documento</span>'
                        : p.tipo === 'garantia'
                            ? '<span class="tll-badge aprobada">garantía</span>'
                            : '<span class="tll-badge lista">mantención</span>'}</td>
                    <td style="font-family:var(--font-mono);font-size:0.8rem">${esc(_periodicidad(p))}</td>
                    <td style="font-family:var(--font-mono);font-size:0.78rem">
                        ${p.cada_km ? _fmtKm(p.aviso_km) + ' km' : ''}
                        ${p.cada_km && p.cada_meses ? ' / ' : ''}
                        ${p.cada_meses ? p.aviso_dias + ' días' : ''}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${usos}</td>
                    <td><span class="tll-badge ${p.activo ? 'lista' : 'anulada'}">${p.activo ? 'activo' : 'inactivo'}</span></td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost pln-editar" data-id="${p.id}">Editar</button>
                    </td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>`;

        lista.querySelectorAll('.pln-editar').forEach(b =>
            b.addEventListener('click', () => _abrirPlan(_planes.find(p => p.id === b.dataset.id))));
    }

    async function _cargarSugeridos() {
        const res = await _rpc('fn_planes_sugeridos', {
            p_empresa_id: window.appData.usuario.empresa_id
        });
        if (!res) return;
        if (!res.ok) { avisar(res.error || 'No se pudieron cargar', 'error'); return; }

        avisar(`${res.creados} plan(es) cargado(s) — ajústalos a tu taller`);
        await recargar();
    }

    function _abrirPlan(plan) {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>${plan ? 'Editar ' + esc(plan.nombre) : 'Nuevo plan de mantención'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Nombre *</label>
                <input class="tll-input" id="pln-f-nombre" placeholder="Cambio de aceite y filtro"
                       value="${esc(plan?.nombre || '')}">
            </div>
            <div class="tll-field tll-field--full">
                <label>Descripción</label>
                <input class="tll-input" id="pln-f-desc" value="${esc(plan?.descripcion || '')}">
            </div>
            <div class="tll-field">
                <label>Tipo</label>
                <select class="tll-select" id="pln-f-tipo">
                    ${[['mantencion','Mantención'],['documento','Documento del vehículo'],['garantia','Garantía']]
                        .map(([v, t]) => `<option value="${v}" ${(plan?.tipo || 'mantencion') === v ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field"></div>
            <div class="tll-field">
                <label>Cada cuántos km</label>
                <input class="tll-input" id="pln-f-km" type="number" min="0" value="${plan?.cada_km ?? ''}">
                <span class="tll-field-msg">Vacío si no depende del kilometraje.</span>
            </div>
            <div class="tll-field">
                <label>Cada cuántos meses</label>
                <input class="tll-input" id="pln-f-meses" type="number" min="0" value="${plan?.cada_meses ?? ''}">
                <span class="tll-field-msg">Vacío si no depende de la fecha.</span>
            </div>
            <div class="tll-field">
                <label>Avisar con … km de anticipación</label>
                <input class="tll-input" id="pln-f-avisokm" type="number" min="0" value="${plan?.aviso_km ?? 1000}">
            </div>
            <div class="tll-field">
                <label>Avisar con … días de anticipación</label>
                <input class="tll-input" id="pln-f-avisodias" type="number" min="0" value="${plan?.aviso_dias ?? 30}">
            </div>
            ${plan ? `
            <div class="tll-field">
                <label>Estado</label>
                <select class="tll-select" id="pln-f-activo">
                    <option value="true"  ${plan.activo ? 'selected' : ''}>Activo</option>
                    <option value="false" ${!plan.activo ? 'selected' : ''}>Inactivo</option>
                </select>
            </div>` : ''}
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="pln-guardar">Guardar plan</button>
        </div>`, '660px');

        document.getElementById('pln-guardar').addEventListener('click', async () => {
            const nombre = document.getElementById('pln-f-nombre').value.trim();
            if (!nombre) { avisar('El nombre es obligatorio', 'error'); return; }

            const km    = Number(document.getElementById('pln-f-km').value) || null;
            const meses = Number(document.getElementById('pln-f-meses').value) || null;
            if (!km && !meses) {
                avisar('Define al menos una periodicidad: km o meses', 'error'); return;
            }

            const fila = {
                empresa_id:  window.appData.usuario.empresa_id,
                nombre,
                descripcion: document.getElementById('pln-f-desc').value.trim() || null,
                tipo:        document.getElementById('pln-f-tipo').value,
                cada_km:     km,
                cada_meses:  meses,
                aviso_km:    Number(document.getElementById('pln-f-avisokm').value) || 0,
                aviso_dias:  Number(document.getElementById('pln-f-avisodias').value) || 0
            };

            const btn = document.getElementById('pln-guardar');
            btn.disabled = true;

            try {
                if (plan) {
                    fila.activo = document.getElementById('pln-f-activo').value === 'true';
                    const { error } = await db.from('taller_planes_mantencion')
                        .update(fila).eq('id', plan.id);
                    if (error) throw error;
                    avisar('Plan actualizado');
                } else {
                    const { error } = await db.from('taller_planes_mantencion').insert(fila);
                    if (error) throw error;
                    avisar('Plan creado — aplícalo a los vehículos desde "Por atender"');
                }
                cerrarModal();
                await recargar();
            } catch (err) {
                console.error('[Mantenciones] plan:', err);
                btn.disabled = false;
                avisar('Error al guardar el plan', 'error');
            }
        });
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _vence(m) {
        const partes = [];
        if (m.proximo_km != null) {
            const falta = _num(m.km_restantes);
            partes.push(`<div style="font-family:var(--font-mono);font-size:0.78rem">
                ${_fmtKm(m.proximo_km)} km
                <span style="color:${falta <= 0 ? '#f87171' : 'var(--text-muted)'}">
                    (${falta <= 0 ? 'pasado ' + _fmtKm(-falta) : 'faltan ' + _fmtKm(falta)} km)</span>
            </div>`);
        }
        if (m.proxima_fecha) {
            const dias = _num(m.dias_restantes);
            partes.push(`<div style="font-size:0.78rem">
                ${fmtFecha(m.proxima_fecha)}
                <span style="color:${dias < 0 ? '#f87171' : 'var(--text-muted)'}">
                    (${dias < 0 ? 'hace ' + (-dias) : 'en ' + dias} d)</span>
            </div>`);
        }
        return partes.join('') || '—';
    }

    function _venceTexto(m) {
        if (m.gatillo === 'km' && m.proximo_km != null) {
            const falta = _num(m.km_restantes);
            return falta <= 0
                ? `pasado por ${_fmtKm(-falta)} km`
                : `faltan ${_fmtKm(falta)} km`;
        }
        if (m.proxima_fecha) {
            const dias = _num(m.dias_restantes);
            return dias < 0 ? `vencida hace ${-dias} días` : `vence en ${dias} días`;
        }
        return 'sin fecha definida';
    }

    function _periodicidad(p) {
        const partes = [];
        if (p.cada_km)    partes.push(_fmtKm(p.cada_km) + ' km');
        if (p.cada_meses) partes.push(p.cada_meses + ' meses');
        return partes.join(' o ') || '—';
    }

    function _badgeSituacion(s) {
        const mapa = {
            vencida:    ['anulada',     'vencida'],
            por_vencer: ['diagnostico', 'por vencer'],
            vigente:    ['lista',       'vigente']
        };
        const [clase, texto] = mapa[s] || ['entregada', s];
        return `<span class="tll-badge ${clase}">${texto}</span>`;
    }

    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Mantenciones] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/07_mantenciones.sql (${nombre})`
                : 'Error en la operación. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function _fmtKm(v) {
        return _num(v).toLocaleString('es-CL', { maximumFractionDigits: 0 });
    }

    function _hoy() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

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
