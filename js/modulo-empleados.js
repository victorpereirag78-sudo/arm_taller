// ================================================================
// modulo-empleados.js — Personal del taller
// ================================================================
// Ficha del empleado + sus reglas de comisión. Las reglas viven aquí
// (no en Comisiones) porque son parte del acuerdo con la persona;
// en Comisiones solo se liquidan y se pagan.
//
// El RUT es la llave: por él se conecta el empleado con el usuario
// que cobra en Ventas. Ver sql/04_empleados_comisiones.sql.
// ================================================================

const ModuloEmpleados = (() => {

    let _empleados = [];
    let _reglas    = [];
    let _editando  = null;
    let _verInactivos = false;

    const CARGOS = [
        ['mecanico',      'Mecánico'],
        ['jefe_taller',   'Jefe de taller'],
        ['recepcionista', 'Recepcionista / asesor'],
        ['vendedor',      'Vendedor'],
        ['bodeguero',     'Bodeguero'],
        ['administrativo','Administrativo'],
        ['ayudante',      'Ayudante']
    ];

    const BASES = [
        ['mano_obra',    'Mano de obra de sus OT',   'El clásico del mecánico: comisiona lo que él ejecutó.'],
        ['total_ot',     'Total de sus OT',          'Sobre el total de las órdenes donde figura como mecánico.'],
        ['repuestos_ot', 'Repuestos de sus OT',      'Para quien también gestiona los repuestos del trabajo.'],
        ['total_venta',  'Total de sus ventas',      'Sobre el total vendido en mostrador.'],
        ['margen_venta', 'Margen de sus ventas',     'Lo correcto para vendedores: si regalan descuento, comisionan menos.']
    ];

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-empleados');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="emp-nuevo">+ Nuevo empleado</button>
                <input class="tll-input" id="emp-buscar" placeholder="Buscar por nombre, RUT o especialidad…">
                <label class="tll-check">
                    <input type="checkbox" id="emp-inactivos"> Ver inactivos
                </label>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="emp-reload">↻ Actualizar</button>
            </div>
            <div id="emp-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('emp-nuevo').addEventListener('click', () => _abrirForm(null));
        document.getElementById('emp-reload').addEventListener('click', recargar);
        document.getElementById('emp-buscar').addEventListener('input', _renderLista);
        document.getElementById('emp-inactivos').addEventListener('change', (e) => {
            _verInactivos = e.target.checked;
            _renderLista();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [eRes, rRes] = await Promise.all([
                db.from('taller_empleados').select('*')
                  .eq('empresa_id', eid).order('nombre'),
                db.from('taller_reglas_comision').select('*')
                  .eq('empresa_id', eid)
            ]);

            if (eRes.error) throw eRes.error;
            _empleados = eRes.data || [];
            _reglas    = rRes.data || [];
            _renderLista();
        } catch (err) {
            console.error('[Empleados] cargar:', err);
            const cont = document.getElementById('emp-lista');
            if (cont) {
                cont.innerHTML = errorCarga(err, '04_empleados_comisiones.sql', 'el módulo Empleados');
            }
        }
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('emp-lista');
        if (!cont) return;

        const q = (document.getElementById('emp-buscar')?.value || '').toLowerCase().trim();

        let lista = _verInactivos ? _empleados : _empleados.filter(e => e.activo);
        if (q) {
            lista = lista.filter(e =>
                (e.nombre || '').toLowerCase().includes(q) ||
                (e.rut || '').toLowerCase().includes(q) ||
                (e.especialidad || '').toLowerCase().includes(q));
        }

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_empleados.length === 0
                    ? 'Sin empleados registrados. Crea el primero con <strong>+ Nuevo empleado</strong>.'
                    : 'Sin resultados para esa búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Nombre</th><th>RUT</th><th>Cargo</th><th>Especialidad</th>
                <th>Ingreso</th><th>Comisiones</th><th>Estado</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(e => {
                const suyas = _reglas.filter(r => r.empleado_id === e.id && r.activo);
                return `
                <tr${e.activo ? '' : ' style="opacity:0.5"'}>
                    <td><strong>${esc(e.nombre)}</strong></td>
                    <td style="font-family:var(--font-mono)">${esc(e.rut) || '—'}</td>
                    <td>${esc(_cargo(e.cargo))}</td>
                    <td>${esc(e.especialidad) || '—'}</td>
                    <td>${e.fecha_ingreso ? fmtFecha(e.fecha_ingreso) : '—'}</td>
                    <td>${suyas.length
                        ? suyas.map(r => `<span class="tll-badge aprobada">${r.porcentaje}% ${esc(_baseCorta(r.base))}</span>`).join(' ')
                        : '<span style="color:var(--text-muted)">sin reglas</span>'}</td>
                    <td><span class="tll-badge ${e.activo ? 'lista' : 'anulada'}">${e.activo ? 'activo' : 'inactivo'}</span></td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="tll-btn tll-btn--ghost emp-reglas" data-id="${e.id}">Comisiones</button>
                        <button class="tll-btn tll-btn--ghost emp-editar" data-id="${e.id}">Editar</button>
                    </td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>`;

        const porId = (b) => _empleados.find(e => e.id === b.dataset.id);
        cont.querySelectorAll('.emp-editar').forEach(b =>
            b.addEventListener('click', () => _abrirForm(porId(b))));
        cont.querySelectorAll('.emp-reglas').forEach(b =>
            b.addEventListener('click', () => _abrirReglas(porId(b))));
    }

    // ── Ficha del empleado ────────────────────────────────────────
    function _abrirForm(emp) {
        _editando = emp;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${emp ? 'Editar ' + esc(emp.nombre) : 'Nuevo empleado'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Nombre completo *</label>
                <input class="tll-input" id="emp-f-nombre" value="${esc(emp?.nombre || '')}">
            </div>
            <div class="tll-field">
                <label>RUT</label>
                <input class="tll-input" id="emp-f-rut" placeholder="12.345.678-9"
                       style="font-family:var(--font-mono)" value="${esc(emp?.rut || '')}">
                <span class="tll-field-msg">Con este RUT se conecta al usuario que cobra en Ventas.</span>
            </div>
            <div class="tll-field">
                <label>Cargo</label>
                <select class="tll-select" id="emp-f-cargo">
                    ${CARGOS.map(([v, t]) => `<option value="${v}" ${emp?.cargo === v ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Especialidad</label>
                <input class="tll-input" id="emp-f-especialidad" placeholder="Motor, frenos, electricidad…"
                       value="${esc(emp?.especialidad || '')}">
            </div>
            <div class="tll-field">
                <label>Teléfono</label>
                <input class="tll-input" id="emp-f-telefono" value="${esc(emp?.telefono || '')}">
            </div>
            <div class="tll-field">
                <label>Email</label>
                <input class="tll-input" id="emp-f-email" type="email" value="${esc(emp?.email || '')}">
            </div>
            <div class="tll-field">
                <label>Tipo de contrato</label>
                <select class="tll-select" id="emp-f-contrato">
                    ${[['indefinido','Indefinido'],['plazo_fijo','Plazo fijo'],
                       ['honorarios','Honorarios'],['part_time','Part time']]
                        .map(([v, t]) => `<option value="${v}" ${(emp?.tipo_contrato || 'indefinido') === v ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Fecha de ingreso</label>
                <input class="tll-input" id="emp-f-ingreso" type="date" value="${esc(emp?.fecha_ingreso || '')}">
            </div>
            <div class="tll-field">
                <label>Sueldo base</label>
                <input class="tll-input" id="emp-f-sueldo" type="number" min="0" value="${emp?.sueldo_base ?? 0}">
            </div>
            <div class="tll-field">
                <label>Tarifa por hora</label>
                <input class="tll-input" id="emp-f-tarifa" type="number" min="0" value="${emp?.tarifa_hora ?? 0}">
                <span class="tll-field-msg">Para valorizar la mano de obra de sus OT.</span>
            </div>
            <div class="tll-field tll-field--full">
                <label>Notas</label>
                <textarea class="tll-textarea" id="emp-f-notas">${esc(emp?.notas || '')}</textarea>
            </div>
            ${emp ? `
            <div class="tll-field">
                <label>Estado</label>
                <select class="tll-select" id="emp-f-activo">
                    <option value="true"  ${emp.activo ? 'selected' : ''}>Activo</option>
                    <option value="false" ${!emp.activo ? 'selected' : ''}>Inactivo</option>
                </select>
            </div>
            <div class="tll-field">
                <label>Fecha de salida</label>
                <input class="tll-input" id="emp-f-salida" type="date" value="${esc(emp.fecha_salida || '')}">
            </div>` : ''}
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="emp-guardar">Guardar empleado</button>
        </div>`, '720px');

        const inpRut = document.getElementById('emp-f-rut');
        inpRut.addEventListener('input', () => { inpRut.value = formatearRut(inpRut.value); });

        document.getElementById('emp-guardar').addEventListener('click', _guardar);
    }

    async function _guardar() {
        const nombre = document.getElementById('emp-f-nombre').value.trim();
        if (!nombre) { avisar('El nombre es obligatorio', 'error'); return; }

        const rut = normalizarRut(document.getElementById('emp-f-rut').value);
        if (rut && !validarRutChileno(rut)) {
            avisar('RUT inválido — revisa el dígito verificador', 'error'); return;
        }
        const email = document.getElementById('emp-f-email').value.trim();
        if (email && !validarEmail(email)) { avisar('Email con formato inválido', 'error'); return; }

        const tel = document.getElementById('emp-f-telefono').value.trim();
        if (tel && !validarTelefono(tel)) { avisar('Teléfono inválido — 8 o 9 dígitos', 'error'); return; }

        const fila = {
            empresa_id:    window.appData.usuario.empresa_id,
            nombre,
            rut:           rut || null,
            cargo:         document.getElementById('emp-f-cargo').value,
            especialidad:  document.getElementById('emp-f-especialidad').value.trim() || null,
            telefono:      tel || null,
            email:         email || null,
            tipo_contrato: document.getElementById('emp-f-contrato').value,
            fecha_ingreso: document.getElementById('emp-f-ingreso').value || null,
            sueldo_base:   Number(document.getElementById('emp-f-sueldo').value) || 0,
            tarifa_hora:   Number(document.getElementById('emp-f-tarifa').value) || 0,
            notas:         document.getElementById('emp-f-notas').value.trim() || null
        };

        const btn = document.getElementById('emp-guardar');
        btn.disabled = true;

        try {
            if (_editando) {
                fila.activo       = document.getElementById('emp-f-activo').value === 'true';
                fila.fecha_salida = document.getElementById('emp-f-salida').value || null;
                const { error } = await db.from('taller_empleados')
                    .update(fila).eq('id', _editando.id);
                if (error) throw error;
                avisar('Empleado actualizado');
            } else {
                const { error } = await db.from('taller_empleados').insert(fila);
                if (error) throw error;
                avisar('Empleado creado');
            }
            cerrarModal();
            await recargar();
        } catch (err) {
            console.error('[Empleados] guardar:', err);
            btn.disabled = false;
            avisar(err.code === '23505'
                ? 'Ya existe un empleado con ese RUT'
                : 'Error al guardar. Revisa la consola.', 'error');
        }
    }

    // ── Reglas de comisión ────────────────────────────────────────
    function _abrirReglas(emp) {
        if (!emp) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Comisiones de ${esc(emp.nombre)}
                <span style="color:var(--text-secondary);font-weight:400;font-size:0.85rem">
                    ${esc(_cargo(emp.cargo))}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="emp-r-lista"></div>

        <div class="panel-header" style="margin-top:1rem;margin-bottom:0.6rem">
            <h2 style="font-size:0.9rem">Agregar regla</h2>
        </div>
        <div class="tll-form-grid" style="align-items:end">
            <div class="tll-field tll-field--full">
                <label>Base de cálculo</label>
                <select class="tll-select" id="emp-r-base">
                    ${BASES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
                </select>
                <span class="tll-field-msg" id="emp-r-ayuda"></span>
            </div>
            <div class="tll-field">
                <label>Porcentaje</label>
                <input class="tll-input" id="emp-r-pct" type="number" min="0" max="100" step="0.5" value="5">
            </div>
            <div class="tll-field">
                <label>&nbsp;</label>
                <button class="tll-btn tll-btn--primary" id="emp-r-add" style="width:100%">+ Agregar</button>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cerrar</button>
        </div>`, '680px');

        const ayuda = () => {
            const base = document.getElementById('emp-r-base').value;
            document.getElementById('emp-r-ayuda').textContent =
                BASES.find(b => b[0] === base)?.[2] || '';
        };
        document.getElementById('emp-r-base').addEventListener('change', ayuda);
        ayuda();

        document.getElementById('emp-r-add').addEventListener('click', () => _agregarRegla(emp));
        _renderReglas(emp);
    }

    function _renderReglas(emp) {
        const cont = document.getElementById('emp-r-lista');
        if (!cont) return;

        const suyas = _reglas.filter(r => r.empleado_id === emp.id);

        if (suyas.length === 0) {
            cont.innerHTML = `<div class="placeholder-text" style="padding:1.2rem">
                Sin reglas de comisión. Este empleado no aparecerá en las liquidaciones.</div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr><th>Base</th><th style="text-align:right">%</th><th>Estado</th><th></th></tr></thead>
            <tbody>
            ${suyas.map(r => `
                <tr${r.activo ? '' : ' style="opacity:0.5"'}>
                    <td>${esc(BASES.find(b => b[0] === r.base)?.[1] || r.base)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)"><strong>${r.porcentaje}%</strong></td>
                    <td><span class="tll-badge ${r.activo ? 'lista' : 'anulada'}">${r.activo ? 'activa' : 'inactiva'}</span></td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost emp-r-toggle" data-id="${r.id}" data-activo="${r.activo}">
                            ${r.activo ? 'Desactivar' : 'Activar'}</button>
                        <button class="tll-btn tll-btn--danger emp-r-del" data-id="${r.id}">Eliminar</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        cont.querySelectorAll('.emp-r-toggle').forEach(b =>
            b.addEventListener('click', () => _toggleRegla(emp, b.dataset.id, b.dataset.activo !== 'true')));
        cont.querySelectorAll('.emp-r-del').forEach(b =>
            b.addEventListener('click', () => _borrarRegla(emp, b.dataset.id)));
    }

    async function _agregarRegla(emp) {
        const base = document.getElementById('emp-r-base').value;
        const pct  = Number(document.getElementById('emp-r-pct').value);

        if (!(pct > 0 && pct <= 100)) { avisar('El porcentaje debe estar entre 0 y 100', 'error'); return; }

        if (_reglas.some(r => r.empleado_id === emp.id && r.base === base && r.activo)) {
            avisar('Ya hay una regla activa con esa base', 'error'); return;
        }

        try {
            const { error } = await db.from('taller_reglas_comision').insert({
                empresa_id:  window.appData.usuario.empresa_id,
                empleado_id: emp.id,
                nombre:      BASES.find(b => b[0] === base)?.[1] || base,
                base,
                porcentaje:  pct
            });
            if (error) throw error;
            await recargar();
            _renderReglas(emp);
            avisar('Regla agregada');
        } catch (err) {
            console.error('[Empleados] regla:', err);
            avisar('No se pudo agregar la regla', 'error');
        }
    }

    async function _toggleRegla(emp, id, activo) {
        try {
            const { error } = await db.from('taller_reglas_comision')
                .update({ activo }).eq('id', id);
            if (error) throw error;
            await recargar();
            _renderReglas(emp);
        } catch (err) {
            console.error('[Empleados] toggle regla:', err);
            avisar('No se pudo cambiar la regla', 'error');
        }
    }

    async function _borrarRegla(emp, id) {
        if (!confirm('Eliminar la regla.\n\nLas liquidaciones ya generadas conservan su detalle.')) return;
        try {
            const { error } = await db.from('taller_reglas_comision').delete().eq('id', id);
            if (error) throw error;
            await recargar();
            _renderReglas(emp);
            avisar('Regla eliminada');
        } catch (err) {
            console.error('[Empleados] borrar regla:', err);
            avisar('No se pudo eliminar la regla', 'error');
        }
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _cargo(v) {
        return CARGOS.find(c => c[0] === v)?.[1] || v || '—';
    }

    function _baseCorta(v) {
        return ({ mano_obra: 'm. obra', total_ot: 'total OT', repuestos_ot: 'repuestos',
                  total_venta: 'ventas', margen_venta: 'margen' })[v] || v;
    }

    return { init, recargar };

})();
