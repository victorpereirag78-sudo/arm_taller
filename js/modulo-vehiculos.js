// ================================================================
// modulo-vehiculos.js — Vehículos del taller
// CRUD sobre taller_vehiculos + historial de órdenes por vehículo.
// La patente es la llave del negocio: única por empresa, normalizada.
// ================================================================

const ModuloVehiculos = (() => {

    let _vehiculos = [];
    let _clientes  = [];
    let _vinculos  = {};   // taller_vehiculo_id → vínculo Mi Vehículo (el más reciente)
    let _editando  = null;

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-vehiculos');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="veh-nuevo">+ Nuevo vehículo</button>
                <input class="tll-input" id="veh-buscar" placeholder="Buscar por patente, marca o dueño…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="veh-reload">↻ Actualizar</button>
            </div>
            <div id="veh-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('veh-nuevo').addEventListener('click', () => _abrirForm(null));
        document.getElementById('veh-reload').addEventListener('click', recargar);
        document.getElementById('veh-buscar').addEventListener('input', _renderLista);

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;
            const [vRes, cRes] = await Promise.all([
                db.from('taller_vehiculos')
                  .select('*, taller_clientes(id, nombre)')
                  .eq('empresa_id', eid)
                  .order('patente'),
                db.from('taller_clientes')
                  .select('id, nombre, rut')
                  .eq('empresa_id', eid)
                  .eq('activo', true)
                  .order('nombre')
            ]);
            if (vRes.error) throw vRes.error;
            if (cRes.error) throw cRes.error;
            _vehiculos = vRes.data || [];
            _clientes  = cRes.data || [];
            await _cargarVinculos(eid);
            _renderLista();
        } catch (err) {
            console.error('[Vehículos] cargar:', err);
            avisar('Error cargando vehículos', 'error');
        }
    }

    /** Vínculos con Mi Vehículo (el más reciente por vehículo). Si la
        vista aún no existe en la base, el módulo sigue funcionando. */
    async function _cargarVinculos(eid) {
        _vinculos = {};
        try {
            const { data, error } = await db.from('v_taller_vinculos')
                .select('*').eq('empresa_id', eid)
                .order('created_at', { ascending: false });
            if (error) { console.warn('[Vehículos] vínculos:', error); return; }
            (data || []).forEach(v => {
                if (!_vinculos[v.taller_vehiculo_id]) _vinculos[v.taller_vehiculo_id] = v;
            });
        } catch (err) {
            console.warn('[Vehículos] vínculos:', err);
        }
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('veh-lista');
        if (!cont) return;

        const q = (document.getElementById('veh-buscar')?.value || '').toLowerCase();
        const filtrados = q
            ? _vehiculos.filter(v =>
                (v.patente || '').toLowerCase().includes(q) ||
                (v.marca || '').toLowerCase().includes(q) ||
                (v.modelo || '').toLowerCase().includes(q) ||
                (v.taller_clientes?.nombre || '').toLowerCase().includes(q))
            : _vehiculos;

        if (filtrados.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_vehiculos.length === 0
                    ? 'Sin vehículos registrados. Crea el primero con <strong>+ Nuevo vehículo</strong>.'
                    : 'Sin resultados para esa búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Patente</th><th>Vehículo</th><th>Año</th><th>Dueño</th>
                <th>Kilometraje</th><th>Estado</th><th></th>
            </tr></thead>
            <tbody>
            ${filtrados.map(v => `
                <tr>
                    <td style="font-family:var(--font-mono)"><strong>${esc(v.patente)}</strong></td>
                    <td>${esc([v.marca, v.modelo].filter(Boolean).join(' ')) || '—'}
                        ${v.color ? `<span style="color:var(--text-muted);font-size:0.75rem"> · ${esc(v.color)}</span>` : ''}</td>
                    <td>${v.anio || '—'}</td>
                    <td>${esc(v.taller_clientes?.nombre) || '<span style="color:var(--text-muted)">Sin dueño</span>'}</td>
                    <td style="font-family:var(--font-mono)">${v.kilometraje ? v.kilometraje.toLocaleString('es-CL') + ' km' : '—'}</td>
                    <td>
                        <span class="tll-badge ${v.activo ? 'lista' : 'anulada'}">${v.activo ? 'activo' : 'inactivo'}</span>
                        ${_badgeMV(_vinculos[v.id])}
                    </td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="tll-btn tll-btn--ghost veh-mv" data-id="${v.id}">Mi Vehículo</button>
                        <button class="tll-btn tll-btn--ghost veh-historial" data-id="${v.id}">Historial</button>
                        <button class="tll-btn tll-btn--ghost veh-editar" data-id="${v.id}">Editar</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        cont.querySelectorAll('.veh-editar').forEach(btn =>
            btn.addEventListener('click', () =>
                _abrirForm(_vehiculos.find(v => v.id === btn.dataset.id))));

        cont.querySelectorAll('.veh-historial').forEach(btn =>
            btn.addEventListener('click', () =>
                _verHistorial(_vehiculos.find(v => v.id === btn.dataset.id))));

        cont.querySelectorAll('.veh-mv').forEach(btn =>
            btn.addEventListener('click', () =>
                _miVehiculo(_vehiculos.find(v => v.id === btn.dataset.id))));
    }

    /** Etiqueta del estado del vínculo con Mi Vehículo para la lista. */
    function _badgeMV(vin) {
        if (!vin) return '';
        const M = {
            activo:    ['aprobada',  '🔗 Mi Vehículo'],
            pendiente: ['diagnostico', '⏳ invitación enviada'],
            revocado:  ['anulada',   'vínculo revocado'],
            rechazado: ['anulada',   'invitación rechazada']
        };
        const e = M[vin.estado];
        return e ? ` <span class="tll-badge ${e[0]}">${e[1]}</span>` : '';
    }

    // ── Formulario ────────────────────────────────────────────────
    function _abrirForm(vehiculo) {
        _editando = vehiculo;

        const opcionesClientes = _clientes.map(c =>
            `<option value="${c.id}" ${vehiculo?.cliente_id === c.id ? 'selected' : ''}>
                ${esc(c.nombre)}${c.rut ? ' · ' + esc(c.rut) : ''}
            </option>`).join('');

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${vehiculo ? 'Editar vehículo ' + esc(vehiculo.patente) : 'Nuevo vehículo'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Patente *</label>
                <input class="tll-input" id="veh-f-patente" placeholder="ABCD12"
                       style="font-family:var(--font-mono);text-transform:uppercase"
                       value="${esc(vehiculo?.patente || '')}">
            </div>
            <div class="tll-field">
                <label>Dueño *</label>
                <select class="tll-select" id="veh-f-cliente">
                    <option value="">— Selecciona cliente —</option>
                    ${opcionesClientes}
                </select>
            </div>
            <div class="tll-field">
                <label>Marca</label>
                <input class="tll-input" id="veh-f-marca" placeholder="Toyota" value="${esc(vehiculo?.marca || '')}">
            </div>
            <div class="tll-field">
                <label>Modelo</label>
                <input class="tll-input" id="veh-f-modelo" placeholder="Yaris" value="${esc(vehiculo?.modelo || '')}">
            </div>
            <div class="tll-field">
                <label>Año</label>
                <input class="tll-input" id="veh-f-anio" type="number" min="1950" max="2030" value="${vehiculo?.anio || ''}">
            </div>
            <div class="tll-field">
                <label>Color</label>
                <input class="tll-input" id="veh-f-color" value="${esc(vehiculo?.color || '')}">
            </div>
            <div class="tll-field">
                <label>Kilometraje</label>
                <input class="tll-input" id="veh-f-km" type="number" min="0" value="${vehiculo?.kilometraje ?? ''}">
            </div>
            <div class="tll-field">
                <label>VIN / Chasis</label>
                <input class="tll-input" id="veh-f-vin" style="font-family:var(--font-mono)" value="${esc(vehiculo?.vin || '')}">
            </div>
            <div class="tll-field tll-field--full">
                <label>Observaciones</label>
                <textarea class="tll-textarea" id="veh-f-obs">${esc(vehiculo?.observaciones || '')}</textarea>
            </div>
            ${vehiculo ? `
            <div class="tll-field">
                <label>Estado</label>
                <select class="tll-select" id="veh-f-activo">
                    <option value="true" ${vehiculo.activo ? 'selected' : ''}>Activo</option>
                    <option value="false" ${!vehiculo.activo ? 'selected' : ''}>Inactivo</option>
                </select>
            </div>` : ''}
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="veh-guardar">Guardar vehículo</button>
        </div>`);

        document.getElementById('veh-guardar').addEventListener('click', _guardar);
    }

    /** Campo vacío al editar = "no tocar el odómetro", no "poner 0". */
    function _kmDelFormulario() {
        const raw = document.getElementById('veh-f-km').value.trim();
        if (raw === '') return _editando ? (_editando.kilometraje ?? 0) : 0;
        return parseInt(raw) || 0;
    }

    async function _guardar() {
        const patente   = normalizarPatente(document.getElementById('veh-f-patente').value);
        const clienteId = document.getElementById('veh-f-cliente').value;

        if (!patente) { avisar('La patente es obligatoria', 'error'); return; }
        if (!clienteId) { avisar('Selecciona el dueño del vehículo', 'error'); return; }

        const fila = {
            empresa_id:  window.appData.usuario.empresa_id,
            patente,
            cliente_id:  clienteId,
            marca:       document.getElementById('veh-f-marca').value.trim() || null,
            modelo:      document.getElementById('veh-f-modelo').value.trim() || null,
            anio:        parseInt(document.getElementById('veh-f-anio').value) || null,
            color:       document.getElementById('veh-f-color').value.trim() || null,
            kilometraje: _kmDelFormulario(),
            vin:         document.getElementById('veh-f-vin').value.trim() || null,
            observaciones: document.getElementById('veh-f-obs').value.trim() || null
        };

        const btn = document.getElementById('veh-guardar');
        btn.disabled = true;

        try {
            if (_editando) {
                fila.activo = document.getElementById('veh-f-activo').value === 'true';
                const { error } = await db.from('taller_vehiculos')
                    .update(fila).eq('id', _editando.id);
                if (error) throw error;
                avisar('Vehículo actualizado');
            } else {
                const { error } = await db.from('taller_vehiculos').insert(fila);
                if (error) throw error;
                avisar('Vehículo creado');
            }
            cerrarModal();
            await recargar();
        } catch (err) {
            console.error('[Vehículos] guardar:', err);
            btn.disabled = false;
            avisar(err.code === '23505'
                ? 'Ya existe un vehículo con la patente ' + patente
                : 'Error al guardar. Revisa la consola.', 'error');
        }
    }

    // ── Historial por vehículo ────────────────────────────────────
    async function _verHistorial(vehiculo) {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Historial · ${esc(vehiculo.patente)}
                <span style="color:var(--text-secondary);font-weight:400;font-size:0.85rem">
                    ${esc([vehiculo.marca, vehiculo.modelo].filter(Boolean).join(' '))}
                </span>
            </h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="veh-hist-body"><div class="placeholder-text">Cargando historial…</div></div>`, '700px');

        try {
            const { data: ordenes, error } = await db
                .from('taller_ordenes')
                .select('numero, estado, motivo_ingreso, trabajos_realizados, kilometraje_ingreso, fecha_ingreso, fecha_entrega, total')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .eq('vehiculo_id', vehiculo.id)
                .order('fecha_ingreso', { ascending: false });
            if (error) throw error;

            const body = document.getElementById('veh-hist-body');
            if (!ordenes || ordenes.length === 0) {
                body.innerHTML = `<div class="placeholder-text">Este vehículo aún no tiene órdenes de trabajo.</div>`;
                return;
            }

            body.innerHTML = `
            <table class="tll-tabla">
                <thead><tr>
                    <th>N°</th><th>Ingreso</th><th>Km</th><th>Motivo</th><th>Estado</th><th>Total</th>
                </tr></thead>
                <tbody>
                ${ordenes.map(o => `
                    <tr>
                        <td style="font-family:var(--font-mono)"><strong>${o.numero}</strong></td>
                        <td>${fmtFecha(o.fecha_ingreso)}</td>
                        <td style="font-family:var(--font-mono)">${o.kilometraje_ingreso ? o.kilometraje_ingreso.toLocaleString('es-CL') : '—'}</td>
                        <td>${esc(o.motivo_ingreso) || '—'}</td>
                        <td><span class="tll-badge ${otEstadoClase(o.estado)}">${esc(otEstadoLabel(o.estado))}</span></td>
                        <td style="font-family:var(--font-mono)">${fmtCLP(o.total)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
        } catch (err) {
            console.error('[Vehículos] historial:', err);
            document.getElementById('veh-hist-body').innerHTML =
                `<div class="placeholder-text">Error cargando el historial.</div>`;
        }
    }

    // ── Vínculo con Mi Vehículo ──────────────────────────────────
    async function _miVehiculo(vehiculo) {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Mi Vehículo · ${esc(vehiculo.patente)}
                <span style="color:var(--text-secondary);font-weight:400;font-size:0.85rem">
                    ${esc([vehiculo.marca, vehiculo.modelo].filter(Boolean).join(' '))}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="mv-body"><div class="placeholder-text">Cargando…</div></div>`, '520px');

        await _mvRender(vehiculo);
    }

    async function _mvRender(vehiculo) {
        const body = document.getElementById('mv-body');
        if (!body) return;

        let vin = null;
        try {
            const { data } = await db.from('v_taller_vinculos').select('*')
                .eq('taller_vehiculo_id', vehiculo.id)
                .order('created_at', { ascending: false }).limit(1);
            vin = data?.[0] || null;
        } catch (err) {
            body.innerHTML = `<div class="placeholder-text">No se pudo consultar el vínculo. ¿Aplicaste sql/18 y sql/19?</div>`;
            return;
        }

        // ── Vinculado ──────────────────────────────────────────────
        if (vin && vin.estado === 'activo') {
            body.innerHTML = `
                <p>Este vehículo está <strong>vinculado a Mi Vehículo</strong>.</p>
                <div class="tll-form-grid" style="margin:0.5rem 0 1rem">
                    <div class="tll-field"><label>Desde</label><div>${fmtFecha(vin.fecha_vinculacion)}</div></div>
                    <div class="tll-field"><label>Autorizado por</label><div>${esc(vin.autorizado_por) || '—'}</div></div>
                </div>
                <p style="color:var(--text-secondary);font-size:0.85rem">
                    El cliente ve el estado de sus órdenes, sus presupuestos y su historial.
                    Al revocar, deja de recibir novedades de este vehículo.</p>
                <div class="tll-modal-footer">
                    <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cerrar</button>
                    <button class="tll-btn tll-btn--danger" id="mv-revocar">Revocar vínculo</button>
                </div>`;
            document.getElementById('mv-revocar').addEventListener('click', async () => {
                if (!confirm('¿Revocar el vínculo con Mi Vehículo para este vehículo?')) return;
                const { data, error } = await db.rpc('fn_taller_vinculo_revocar', {
                    p_vinculo_id: vin.id,
                    p_empresa_id: window.appData.usuario.empresa_id,
                    p_por: window.appData.usuario.rut
                });
                if (error || !data?.ok) {
                    avisar((data && data.error) || 'No se pudo revocar', 'error'); return;
                }
                avisar('Vínculo revocado');
                await _mvRender(vehiculo);
                recargar();
            });
            return;
        }

        // ── Invitación pendiente ───────────────────────────────────
        if (vin && vin.estado === 'pendiente') {
            _mvPintarInvitacion(body, vehiculo, vin.token_invitacion, vin.invitacion_expira_at, vin.id);
            return;
        }

        // ── Sin vínculo (o revocado/rechazado) ─────────────────────
        body.innerHTML = `
            <p>Este vehículo <strong>no está vinculado</strong> a Mi Vehículo${
                vin ? ` (última invitación: ${esc(vin.estado)})` : ''}.</p>
            <p style="color:var(--text-secondary);font-size:0.85rem">
                Genera una invitación y compártela con el cliente. Al aceptarla desde
                Mi Vehículo, podrá seguir el estado de sus órdenes y aprobar presupuestos.</p>
            <div class="tll-modal-footer">
                <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cerrar</button>
                <button class="tll-btn tll-btn--primary" id="mv-invitar">Generar invitación</button>
            </div>`;
        document.getElementById('mv-invitar').addEventListener('click', async () => {
            const { data, error } = await db.rpc('fn_taller_vinculo_invitar', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_taller_vehiculo_id: vehiculo.id,
                p_usuario: window.appData.usuario.rut
            });
            if (error || !data?.ok) {
                avisar((data && data.error) || 'No se pudo generar la invitación', 'error'); return;
            }
            _mvPintarInvitacion(body, vehiculo, data.token, data.expira_at, data.vinculo_id);
            recargar();
        });
    }

    function _mvPintarInvitacion(body, vehiculo, token, expira, vinculoId) {
        const link = vinculoLink(token);
        body.innerHTML = `
            <p style="color:var(--text-secondary);font-size:0.85rem">
                El cliente abre <strong>Mi Vehículo</strong>, va a “Vincular con mi taller”
                y escanea este código (o ingresa el código de abajo).</p>
            <div id="mv-qr" style="display:flex;justify-content:center;padding:1rem;background:#fff;border-radius:var(--radius-sm);margin:0.5rem 0"></div>
            <div class="tll-field">
                <label>Código de vinculación</label>
                <input class="tll-input" id="mv-token" readonly value="${esc(token)}"
                       style="font-family:var(--font-mono);font-size:0.8rem" onclick="this.select()">
            </div>
            <p style="color:var(--text-muted);font-size:0.78rem">
                Vence el ${fmtFecha(expira)}. <span id="mv-link" style="word-break:break-all">${esc(link)}</span></p>
            <div class="tll-modal-footer">
                <button class="tll-btn tll-btn--ghost" id="mv-copiar">Copiar enlace</button>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cerrar</button>
                <button class="tll-btn tll-btn--danger" id="mv-cancelar">Cancelar invitación</button>
            </div>`;

        const cont = document.getElementById('mv-qr');
        if (typeof QRCode === 'function') {
            new QRCode(cont, { text: link, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
        } else {
            cont.innerHTML = `<span style="color:#888;font-size:0.8rem">Código QR no disponible — usa el código de abajo</span>`;
        }

        document.getElementById('mv-copiar').addEventListener('click', () => {
            navigator.clipboard?.writeText(link).then(
                () => avisar('Enlace copiado'),
                () => avisar('No se pudo copiar', 'error'));
        });
        document.getElementById('mv-cancelar').addEventListener('click', async () => {
            if (!confirm('¿Cancelar esta invitación? El código dejará de servir.')) return;
            const { error } = await db.from('taller_vehiculo_vinculo')
                .update({ estado: 'rechazado' }).eq('id', vinculoId);
            if (error) { avisar('No se pudo cancelar', 'error'); return; }
            avisar('Invitación cancelada');
            await _mvRender(vehiculo);
            recargar();
        });
    }

    return { init, recargar };

})();
