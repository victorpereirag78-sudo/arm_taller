// ================================================================
// modulo-clientes.js — Clientes del taller (persona y empresa)
// CRUD sobre taller_clientes, filtrado por empresa_id.
// ================================================================

const ModuloClientes = (() => {

    let _clientes = [];
    let _editando = null;   // fila en edición o null (nuevo)

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-clientes');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="cli-nuevo">+ Nuevo cliente</button>
                <input class="tll-input" id="cli-buscar" placeholder="Buscar por nombre, RUT o teléfono…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="cli-reload">↻ Actualizar</button>
            </div>
            <div id="cli-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('cli-nuevo').addEventListener('click', () => _abrirForm(null));
        document.getElementById('cli-reload').addEventListener('click', recargar);
        document.getElementById('cli-buscar').addEventListener('input', _renderLista);

        await recargar();
    }

    async function recargar() {
        try {
            const { data, error } = await db
                .from('taller_clientes')
                .select('*')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .order('nombre');
            if (error) throw error;
            _clientes = data || [];
            _renderLista();
        } catch (err) {
            console.error('[Clientes] cargar:', err);
            avisar('Error cargando clientes', 'error');
        }
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('cli-lista');
        if (!cont) return;

        const q = (document.getElementById('cli-buscar')?.value || '').toLowerCase();
        const filtrados = q
            ? _clientes.filter(c =>
                (c.nombre || '').toLowerCase().includes(q) ||
                (c.rut || '').toLowerCase().includes(q) ||
                (c.telefono || '').toLowerCase().includes(q))
            : _clientes;

        if (filtrados.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_clientes.length === 0
                    ? 'Sin clientes registrados. Crea el primero con <strong>+ Nuevo cliente</strong>.'
                    : 'Sin resultados para esa búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Nombre</th><th>RUT</th><th>Tipo</th><th>Teléfono</th>
                <th>Email</th><th>Estado</th><th></th>
            </tr></thead>
            <tbody>
            ${filtrados.map(c => `
                <tr>
                    <td><strong>${esc(c.nombre)}</strong></td>
                    <td style="font-family:var(--font-mono)">${esc(c.rut) || '—'}</td>
                    <td>${c.tipo === 'empresa' ? '🏢 Empresa' : '👤 Persona'}</td>
                    <td>${esc(c.telefono) || '—'}</td>
                    <td>${esc(c.email) || '—'}</td>
                    <td><span class="tll-badge ${c.activo ? 'lista' : 'anulada'}">${c.activo ? 'activo' : 'inactivo'}</span></td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost cli-editar" data-id="${c.id}">Editar</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        cont.querySelectorAll('.cli-editar').forEach(btn =>
            btn.addEventListener('click', () =>
                _abrirForm(_clientes.find(c => c.id === btn.dataset.id))));
    }

    // ── Formulario (crear / editar) ───────────────────────────────
    function _abrirForm(cliente) {
        _editando = cliente;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${cliente ? 'Editar cliente' : 'Nuevo cliente'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Nombre *</label>
                <input class="tll-input" id="cli-f-nombre" value="${esc(cliente?.nombre || '')}">
            </div>
            <div class="tll-field">
                <label>RUT</label>
                <input class="tll-input" id="cli-f-rut" placeholder="12345678-9" value="${esc(cliente?.rut || '')}">
            </div>
            <div class="tll-field">
                <label>Tipo</label>
                <select class="tll-select" id="cli-f-tipo">
                    <option value="persona" ${cliente?.tipo !== 'empresa' ? 'selected' : ''}>Persona</option>
                    <option value="empresa" ${cliente?.tipo === 'empresa' ? 'selected' : ''}>Empresa</option>
                </select>
            </div>
            <div class="tll-field">
                <label>Teléfono</label>
                <input class="tll-input" id="cli-f-telefono" placeholder="+56 9 …" value="${esc(cliente?.telefono || '')}">
            </div>
            <div class="tll-field">
                <label>Email</label>
                <input class="tll-input" id="cli-f-email" type="email" value="${esc(cliente?.email || '')}">
            </div>
            <div class="tll-field tll-field--full">
                <label>Dirección</label>
                <input class="tll-input" id="cli-f-direccion" value="${esc(cliente?.direccion || '')}">
            </div>
            <div class="tll-field tll-field--full">
                <label>Cómo avisarle (Mi Vehículo / WhatsApp)</label>
                <select class="tll-select" id="cli-f-canal">
                    ${[
                        ['auto', 'Automático (Mi Vehículo si está vinculado, si no WhatsApp)'],
                        ['mi_vehiculo', 'Solo Mi Vehículo'],
                        ['whatsapp', 'Solo WhatsApp'],
                        ['ambos', 'Ambos'],
                        ['ninguno', 'No enviar avisos']
                    ].map(([v, t]) => `<option value="${v}" ${
                        (cliente?.canal_pref || 'auto') === v ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            ${cliente ? `
            <div class="tll-field">
                <label>Estado</label>
                <select class="tll-select" id="cli-f-activo">
                    <option value="true" ${cliente.activo ? 'selected' : ''}>Activo</option>
                    <option value="false" ${!cliente.activo ? 'selected' : ''}>Inactivo</option>
                </select>
            </div>` : ''}
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="cli-guardar">Guardar cliente</button>
        </div>`);

        // Formato de RUT en vivo dentro del formulario
        const inpRut = document.getElementById('cli-f-rut');
        inpRut.addEventListener('input', () => { inpRut.value = formatearRut(inpRut.value); });

        document.getElementById('cli-guardar').addEventListener('click', _guardar);
    }

    async function _guardar() {
        const nombre = document.getElementById('cli-f-nombre').value.trim();
        if (!nombre) { avisar('El nombre es obligatorio', 'error'); return; }

        // Validaciones de formato
        const rutVal = normalizarRut(document.getElementById('cli-f-rut').value);
        if (rutVal && !validarRutChileno(rutVal)) {
            avisar('RUT inválido — revisa el dígito verificador', 'error'); return;
        }
        const telVal = document.getElementById('cli-f-telefono').value.trim();
        if (telVal && !validarTelefono(telVal)) {
            avisar('Teléfono inválido — deben ser 8 o 9 dígitos', 'error'); return;
        }
        const emailVal = document.getElementById('cli-f-email').value.trim();
        if (emailVal && !validarEmail(emailVal)) {
            avisar('Email con formato inválido', 'error'); return;
        }

        const fila = {
            empresa_id: window.appData.usuario.empresa_id,
            nombre,
            rut:       normalizarRut(document.getElementById('cli-f-rut').value) || null,
            tipo:      document.getElementById('cli-f-tipo').value,
            telefono:  document.getElementById('cli-f-telefono').value.trim() || null,
            email:     document.getElementById('cli-f-email').value.trim() || null,
            direccion: document.getElementById('cli-f-direccion').value.trim() || null,
            canal_pref: document.getElementById('cli-f-canal').value
        };

        const btn = document.getElementById('cli-guardar');
        btn.disabled = true;

        try {
            if (_editando) {
                fila.activo = document.getElementById('cli-f-activo').value === 'true';
                const { error } = await db.from('taller_clientes')
                    .update(fila).eq('id', _editando.id);
                if (error) throw error;
                avisar('Cliente actualizado');
            } else {
                const { error } = await db.from('taller_clientes').insert(fila);
                if (error) throw error;
                avisar('Cliente creado');
            }
            cerrarModal();
            await recargar();
        } catch (err) {
            console.error('[Clientes] guardar:', err);
            btn.disabled = false;
            avisar(err.code === '23505'
                ? 'Ya existe un cliente con ese RUT'
                : 'Error al guardar. Revisa la consola.', 'error');
        }
    }

    return { init, recargar };

})();
