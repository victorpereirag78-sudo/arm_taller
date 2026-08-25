// ================================================================
// modulo-usuarios.js — Usuarios y roles del taller
// ================================================================
// El admin gestiona sus propios usuarios sin depender del superadmin.
//
// Crear un usuario o resetear una contraseña es sensible, así que cada
// operación pide la contraseña del admin y la VERIFICA en la base
// (fn_admin_de_taller). Las contraseñas se guardan hasheadas: el
// sistema nunca las almacena ni las muestra en texto plano.
//
// Ver sql/11_cxc_usuarios.sql.
// ================================================================

const ModuloUsuarios = (() => {

    let _usuarios  = [];
    let _empleados = [];
    let _verInactivos = false;

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-usuarios');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="usr-nuevo">+ Nuevo usuario</button>
                <input class="tll-input" id="usr-buscar" placeholder="Buscar por RUT o rol…">
                <label class="tll-check">
                    <input type="checkbox" id="usr-inactivos"> Ver inactivos
                </label>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="usr-reload">↻ Actualizar</button>
            </div>
            <div id="usr-lista" class="tll-tabla-wrap"></div>
            <div id="usr-roles"></div>`;

        document.getElementById('usr-nuevo').addEventListener('click', _abrirNuevo);
        document.getElementById('usr-reload').addEventListener('click', recargar);
        document.getElementById('usr-buscar').addEventListener('input', _renderLista);
        document.getElementById('usr-inactivos').addEventListener('change', (e) => {
            _verInactivos = e.target.checked;
            _renderLista();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [uRes, eRes] = await Promise.all([
                db.from('v_taller_usuarios').select('*')
                  .eq('empresa_id', eid).order('rut'),
                db.from('taller_empleados').select('id, nombre, cargo, rut')
                  .eq('empresa_id', eid).eq('activo', true).order('nombre')
            ]);

            if (uRes.error) throw uRes.error;
            _usuarios  = uRes.data || [];
            _empleados = eRes.data || [];
            _renderLista();
            _renderRoles();
        } catch (err) {
            console.error('[Usuarios] cargar:', err);
            const cont = document.getElementById('usr-lista');
            if (cont) cont.innerHTML = errorCarga(err, '11_cxc_usuarios.sql', 'el módulo Usuarios');
        }
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('usr-lista');
        if (!cont) return;

        const q = (document.getElementById('usr-buscar')?.value || '').toLowerCase().trim();
        const yo = window.appData.usuario.id;

        let lista = _verInactivos ? _usuarios : _usuarios.filter(u => u.activo);
        if (q) {
            lista = lista.filter(u =>
                (u.rut || '').toLowerCase().includes(q) ||
                (u.rol || '').toLowerCase().includes(q) ||
                (ROL_INFO[u.rol]?.nombre || '').toLowerCase().includes(q) ||
                (u.empleado_nombre || '').toLowerCase().includes(q));
        }

        const admins = _usuarios.filter(u => u.rol === 'admin' && u.activo).length;

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_usuarios.length === 0
                    ? 'Sin usuarios. Crea el primero con <strong>+ Nuevo usuario</strong>.'
                    : 'Sin resultados para esa búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        ${admins === 1 ? `
        <div class="tll-recep-notfound" style="margin-bottom:0.8rem">
            El taller tiene <strong>un solo administrador activo</strong>.
            Si pierde el acceso, nadie puede gestionar usuarios ni módulos.
        </div>` : ''}

        <table class="tll-tabla">
            <thead><tr>
                <th>RUT</th><th>Rol</th><th>Empleado</th>
                <th>Paneles</th><th>Último acceso</th><th>Estado</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(u => {
                const paneles = Auth.calcularModulos(u.rol, window.appData.empresa?.modulos_activos).length;
                return `
                <tr${u.activo ? '' : ' style="opacity:0.5"'}>
                    <td style="font-family:var(--font-mono)"><strong>${esc(u.rut)}</strong>
                        ${u.id === yo ? '<span class="tll-badge aprobada">tú</span>' : ''}
                        ${!u.pass_segura ? '<div style="font-size:0.66rem;color:#fbbf24">contraseña sin hashear</div>' : ''}</td>
                    <td>${esc(ROL_INFO[u.rol]?.nombre || u.rol)}
                        <div style="font-size:0.68rem;color:var(--text-muted);font-family:var(--font-mono)">${esc(u.rol)}</div></td>
                    <td>${u.empleado_nombre
                        ? esc(u.empleado_nombre) + (u.empleado_cargo
                            ? `<div style="font-size:0.7rem;color:var(--text-secondary)">${esc(u.empleado_cargo)}</div>` : '')
                        : '<span style="color:var(--text-muted)">sin vincular</span>'}</td>
                    <td style="font-family:var(--font-mono)">${paneles}</td>
                    <td style="font-size:0.78rem">${u.ultimo_acceso ? fmtFechaHora(u.ultimo_acceso) : 'nunca'}</td>
                    <td><span class="tll-badge ${u.activo ? 'lista' : 'anulada'}">
                        ${u.activo ? 'activo' : 'inactivo'}</span></td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="tll-btn tll-btn--ghost usr-editar" data-id="${u.id}">Editar</button>
                        <button class="tll-btn tll-btn--ghost usr-pass" data-id="${u.id}">Contraseña</button>
                    </td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>`;

        const porId = (b) => _usuarios.find(u => u.id === b.dataset.id);
        cont.querySelectorAll('.usr-editar').forEach(b =>
            b.addEventListener('click', () => _abrirEditar(porId(b))));
        cont.querySelectorAll('.usr-pass').forEach(b =>
            b.addEventListener('click', () => _abrirPass(porId(b))));
    }

    // ── Qué ve cada rol, con los módulos de ESTE taller ───────────
    function _renderRoles() {
        const cont = document.getElementById('usr-roles');
        if (!cont) return;

        const mods = window.appData.empresa?.modulos_activos || {};

        cont.innerHTML = `
        <div class="panel-header" style="margin-top:1.6rem">
            <h2 style="font-size:1rem">Qué ve cada rol en este taller</h2>
        </div>
        <div class="tll-tabla-wrap">
        <table class="tll-tabla">
            <thead><tr><th>Rol</th><th style="text-align:right">Usuarios</th><th>Paneles que verá</th></tr></thead>
            <tbody>
            ${Object.keys(ROL_MODULOS).map(rol => {
                const paneles = Auth.calcularModulos(rol, mods);
                const n = _usuarios.filter(u => u.rol === rol && u.activo).length;
                return `
                <tr${n ? '' : ' style="opacity:0.55"'}>
                    <td><strong>${esc(ROL_INFO[rol]?.nombre || rol)}</strong>
                        <div style="font-size:0.68rem;color:var(--text-muted);font-family:var(--font-mono)">${esc(rol)}</div></td>
                    <td style="text-align:right;font-family:var(--font-mono)">${n}</td>
                    <td class="tll-td-chips">${paneles.length
                        ? `<span class="tll-chips-total">${paneles.length} panel${paneles.length === 1 ? '' : 'es'}</span>
                           <div class="tll-chips">
                             ${paneles.map(p =>
                                `<span class="tll-chip">${esc(PANEL_INFO[p]?.titulo || p)}</span>`).join('')}
                           </div>`
                        : `<span class="tll-chip tll-chip--vacio">sin acceso — no podría entrar</span>`}</td>
                </tr>`;
            }).join('')}
            </tbody>
        </table></div>
        <p class="tll-rep-nota">
            Los paneles dependen de los módulos activos del taller. Si un rol queda
            sin ninguno, ese usuario no puede iniciar sesión: enciende el módulo
            correspondiente en <strong>Admin › Módulos</strong>.
        </p>`;
    }

    // ── Nuevo usuario ─────────────────────────────────────────────
    function _abrirNuevo() {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Nuevo usuario</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>RUT *</label>
                <input class="tll-input" id="usr-n-rut" style="font-family:var(--font-mono)"
                       placeholder="12.345.678-9">
                <span class="tll-field-msg">Con este RUT inicia sesión.</span>
            </div>
            <div class="tll-field">
                <label>Contraseña *</label>
                <input class="tll-input" id="usr-n-pass" type="password" placeholder="mínimo 6 caracteres">
            </div>
            <div class="tll-field">
                <label>Rol *</label>
                <select class="tll-select" id="usr-n-rol">
                    ${Object.keys(ROL_MODULOS).map(r =>
                        `<option value="${r}" ${r === 'recepcion' ? 'selected' : ''}>${esc(ROL_INFO[r]?.nombre || r)}</option>`).join('')}
                </select>
                <span class="tll-field-msg" id="usr-n-aviso"></span>
            </div>
            <div class="tll-field">
                <label>Empleado (opcional)</label>
                <select class="tll-select" id="usr-n-empleado">
                    <option value="">— Sin vincular —</option>
                    ${_empleados.map(e => `<option value="${e.id}">${esc(e.nombre)} · ${esc(e.cargo)}</option>`).join('')}
                </select>
                <span class="tll-field-msg">Vincular sirve para comisiones y productividad.</span>
            </div>
            <div class="tll-field tll-field--full">
                <div class="tll-rep-sep"></div>
                <label>Tu contraseña de administrador *</label>
                <input class="tll-input" id="usr-n-adminpass" type="password">
                <span class="tll-field-msg">
                    Crear un usuario genera credenciales: la base la verifica antes de hacer nada.</span>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="usr-n-ok">Crear usuario</button>
        </div>`, '660px');

        const inpRut = document.getElementById('usr-n-rut');
        inpRut.addEventListener('input', () => { inpRut.value = formatearRut(inpRut.value); });

        // Avisar si el rol elegido no ve ningún panel en este taller
        const selRol = document.getElementById('usr-n-rol');
        const avisar_ = () => {
            const n = Auth.calcularModulos(selRol.value, window.appData.empresa?.modulos_activos).length;
            const msg = document.getElementById('usr-n-aviso');
            msg.textContent = n === 0
                ? 'Con los módulos activos, este rol no vería ningún panel y no podría entrar.'
                : `Verá ${n} panel(es).`;
            msg.className = 'tll-field-msg' + (n === 0 ? ' tll-field-msg--error' : '');
        };
        selRol.addEventListener('change', avisar_);
        avisar_();

        // Autocompletar el empleado si el RUT calza con uno cargado
        inpRut.addEventListener('blur', () => {
            const rut = normalizarRut(inpRut.value);
            const emp = _empleados.find(e => normalizarRut(e.rut || '') === rut);
            if (emp) document.getElementById('usr-n-empleado').value = emp.id;
        });

        document.getElementById('usr-n-ok').addEventListener('click', async () => {
            const rut   = normalizarRut(document.getElementById('usr-n-rut').value);
            const pass  = document.getElementById('usr-n-pass').value;
            const admin = document.getElementById('usr-n-adminpass').value;

            if (!rut || !validarRutChileno(rut)) { avisar('RUT inválido', 'error'); return; }
            if (pass.length < 6) { avisar('La contraseña debe tener al menos 6 caracteres', 'error'); return; }
            if (!admin) { avisar('Ingresa tu contraseña de administrador', 'error'); return; }

            const btn = document.getElementById('usr-n-ok');
            btn.disabled = true;

            const res = await _rpc('fn_usuario_crear', {
                p_admin_rut:   window.appData.usuario.rut,
                p_admin_pass:  admin,
                p_empresa_id:  window.appData.usuario.empresa_id,
                p_rut:         rut,
                p_pass:        pass,
                p_rol:         document.getElementById('usr-n-rol').value,
                p_empleado_id: document.getElementById('usr-n-empleado').value || null
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo crear', 'error'); btn.disabled = false; return; }

            avisar(`Usuario ${rut} creado`);
            cerrarModal();
            await recargar();
        });
    }

    // ── Editar rol / estado / empleado ────────────────────────────
    function _abrirEditar(u) {
        if (!u) return;
        const esYo = u.id === window.appData.usuario.id;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Usuario ${esc(u.rut)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        ${esYo ? `
        <div class="tll-recep-notfound" style="margin-bottom:0.8rem">
            Este eres tú. Si te quitas el rol de administrador, pierdes el acceso a esta pantalla.
        </div>` : ''}
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Rol</label>
                <select class="tll-select" id="usr-e-rol">
                    ${Object.keys(ROL_MODULOS).map(r =>
                        `<option value="${r}" ${u.rol === r ? 'selected' : ''}>${esc(ROL_INFO[r]?.nombre || r)}</option>`).join('')}
                </select>
                <span class="tll-field-msg" id="usr-e-aviso"></span>
            </div>
            <div class="tll-field">
                <label>Estado</label>
                <select class="tll-select" id="usr-e-activo">
                    <option value="true"  ${u.activo ? 'selected' : ''}>Activo</option>
                    <option value="false" ${!u.activo ? 'selected' : ''}>Inactivo</option>
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <label>Empleado vinculado</label>
                <select class="tll-select" id="usr-e-empleado">
                    <option value="">— Sin vincular —</option>
                    ${_empleados.map(e => `<option value="${e.id}"
                        ${u.empleado_id === e.id ? 'selected' : ''}>${esc(e.nombre)} · ${esc(e.cargo)}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <div class="tll-rep-sep"></div>
                <label>Tu contraseña de administrador *</label>
                <input class="tll-input" id="usr-e-adminpass" type="password">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="usr-e-ok">Guardar</button>
        </div>`, '620px');

        const selRol = document.getElementById('usr-e-rol');
        const avisar_ = () => {
            const n = Auth.calcularModulos(selRol.value, window.appData.empresa?.modulos_activos).length;
            const msg = document.getElementById('usr-e-aviso');
            msg.textContent = n === 0
                ? 'Con los módulos activos, este rol no vería ningún panel.'
                : `Verá ${n} panel(es).`;
            msg.className = 'tll-field-msg' + (n === 0 ? ' tll-field-msg--error' : '');
        };
        selRol.addEventListener('change', avisar_);
        avisar_();

        document.getElementById('usr-e-ok').addEventListener('click', async () => {
            const admin = document.getElementById('usr-e-adminpass').value;
            if (!admin) { avisar('Ingresa tu contraseña de administrador', 'error'); return; }

            const rolNuevo = selRol.value;
            const activo   = document.getElementById('usr-e-activo').value === 'true';

            if (esYo && (rolNuevo !== 'admin' || !activo) &&
                !confirm('Estás cambiando tu propio usuario.\n\nPuedes perder el acceso a esta pantalla.\n\n¿Continuar?')) return;

            const btn = document.getElementById('usr-e-ok');
            btn.disabled = true;

            const empleado = document.getElementById('usr-e-empleado').value;

            const res = await _rpc('fn_usuario_actualizar', {
                p_admin_rut:   window.appData.usuario.rut,
                p_admin_pass:  admin,
                p_usuario_id:  u.id,
                p_rol:         rolNuevo,
                p_activo:      activo,
                p_empleado_id: empleado || null
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo guardar', 'error'); btn.disabled = false; return; }

            // Desvincular necesita su propia llamada: el update ignora los nulos
            if (!empleado && u.empleado_id) {
                await _rpc('fn_usuario_desvincular_empleado', {
                    p_admin_rut: window.appData.usuario.rut,
                    p_admin_pass: admin,
                    p_usuario_id: u.id
                });
            }

            avisar('Usuario actualizado');
            cerrarModal();
            await recargar();
        });
    }

    // ── Resetear contraseña ───────────────────────────────────────
    function _abrirPass(u) {
        if (!u) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Contraseña de ${esc(u.rut)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            Se guarda hasheada. Nadie —ni tú— puede volver a verla:
            si el usuario la olvida, se resetea desde aquí.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Contraseña nueva *</label>
                <input class="tll-input" id="usr-p-nueva" type="password" placeholder="mínimo 6 caracteres">
            </div>
            <div class="tll-field">
                <label>Repetir *</label>
                <input class="tll-input" id="usr-p-repite" type="password">
            </div>
            <div class="tll-field tll-field--full">
                <div class="tll-rep-sep"></div>
                <label>Tu contraseña de administrador *</label>
                <input class="tll-input" id="usr-p-adminpass" type="password">
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="usr-p-ok">Cambiar contraseña</button>
        </div>`, '560px');

        document.getElementById('usr-p-ok').addEventListener('click', async () => {
            const nueva  = document.getElementById('usr-p-nueva').value;
            const repite = document.getElementById('usr-p-repite').value;
            const admin  = document.getElementById('usr-p-adminpass').value;

            if (nueva.length < 6) { avisar('La contraseña debe tener al menos 6 caracteres', 'error'); return; }
            if (nueva !== repite) { avisar('Las dos contraseñas no coinciden', 'error'); return; }
            if (!admin) { avisar('Ingresa tu contraseña de administrador', 'error'); return; }

            const btn = document.getElementById('usr-p-ok');
            btn.disabled = true;

            const res = await _rpc('fn_usuario_resetear_pass', {
                p_admin_rut:  window.appData.usuario.rut,
                p_admin_pass: admin,
                p_usuario_id: u.id,
                p_pass_nueva: nueva
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo cambiar', 'error'); btn.disabled = false; return; }

            avisar(`Contraseña de ${u.rut} actualizada`);
            cerrarModal();
            await recargar();
        });
    }

    // ── Helpers ───────────────────────────────────────────────────
    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Usuarios] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/11_cxc_usuarios.sql (${nombre})`
                : 'Error en la operación. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    return { init, recargar };

})();
