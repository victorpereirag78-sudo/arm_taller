// ================================================================
// AUTH.JS — Módulo de autenticación de ARM TALLER
// Mismo patrón que ARM Universal. Cambios:
//   1. Solo permite empresas con tipo='taller'
//      (excepción: superadmin arm-sur, para administrar talleres)
//   2. Claves de storage con prefijo tll_
// Depende de: config.js (db, ROL_MODULOS, MODULO_REQUIERE, appData)
// ================================================================

const Auth = (() => {

    // ── Claves de storage ─────────────────────────────────────────
    const KEY_SESSION    = 'tll_session';     // sessionStorage: sesión activa
    const KEY_RECORDAR   = 'tll_usuario_rut'; // localStorage: RUT recordado
    const KEY_EMPRESA    = 'tll_empresa_id';  // localStorage: empresa recordada

    // ── Login ─────────────────────────────────────────────────────
    async function login(rut, pass, recordar = false) {
        try {
            // 1. Buscar usuario activo con ese RUT y contraseña
            const { data: usuarios, error: errU } = await db
                .from('usuarios')
                .select(`
                    id,
                    empresa_id,
                    empleado_id,
                    rut,
                    rol,
                    activo,
                    empresas (
                        id,
                        nombre,
                        slug,
                        logo_url,
                        tipo,
                        modulos_activos,
                        activo
                    )
                `)
                .eq('rut', rut)
                .eq('pass', pass)
                .eq('activo', true)
                .limit(1);

            if (errU) throw new Error('Error de conexión con la base de datos.');
            if (!usuarios || usuarios.length === 0) {
                return { ok: false, error: 'RUT o contraseña incorrectos.' };
            }

            const usuario = usuarios[0];

            // 2. Verificar que la empresa está activa
            if (!usuario.empresas || !usuario.empresas.activo) {
                return { ok: false, error: 'La empresa no está habilitada. Contacta al administrador.' };
            }

            // 3. Verificar que la empresa es un TALLER
            //    (o el superadmin de ARM, que administra los talleres)
            const esSuperadmin = usuario.empresas.slug === 'arm-sur' && usuario.rol === 'admin';
            if (usuario.empresas.tipo !== 'taller' && !esSuperadmin) {
                return { ok: false, error: 'Este acceso es solo para talleres. Para telecom usa ARM Universal.' };
            }

            // 4. Calcular módulos disponibles (rol × empresa)
            const modulos = calcularModulos(usuario.rol, usuario.empresas.modulos_activos);

            if (modulos.length === 0) {
                return { ok: false, error: 'Tu usuario no tiene módulos asignados. Contacta al administrador.' };
            }

            // 5. Construir objeto de sesión
            const sesion = {
                id:          usuario.id,
                empresa_id:  usuario.empresa_id,
                empleado_id: usuario.empleado_id,
                rut:         usuario.rut,
                rol:         usuario.rol,
                empresa:     usuario.empresas,
                modulos:     modulos,
                login_at:    new Date().toISOString()
            };

            // 6. Guardar sesión
            _guardarSesion(sesion, recordar);

            // 7. Poblar appData global
            _poblarAppData(sesion);

            // 8. Registrar último acceso (sin await para no bloquear)
            db
                .from('usuarios')
                .update({ ultimo_acceso: new Date().toISOString() })
                .eq('id', usuario.id)
                .then(() => {});

            return { ok: true, usuario: sesion };

        } catch (err) {
            console.error('[Auth.login]', err);
            return { ok: false, error: err.message || 'Error inesperado. Intenta de nuevo.' };
        }
    }

    // ── Restaurar sesión ──────────────────────────────────────────
    function restaurarSesion() {
        try {
            const raw = sessionStorage.getItem(KEY_SESSION)
                     || localStorage.getItem(KEY_SESSION);

            if (!raw) return null;

            const sesion = JSON.parse(raw);

            if (!sesion?.id || !sesion?.empresa_id || !sesion?.rol) {
                _limpiarStorage();
                return null;
            }

            _poblarAppData(sesion);
            return sesion;

        } catch (err) {
            console.error('[Auth.restaurarSesion]', err);
            _limpiarStorage();
            return null;
        }
    }

    // ── Logout ────────────────────────────────────────────────────
    function logout() {
        _limpiarStorage();
        window.appData = { usuario: null, empresa: null, modulos: [], cargado: false };
        window.location.href = 'login.html';
    }

    // ── RUT recordado ─────────────────────────────────────────────
    function getRutRecordado() {
        return localStorage.getItem(KEY_RECORDAR) || '';
    }

    // ── Verificar acceso a un panel ───────────────────────────────
    function puedeAcceder(panel) {
        return window.appData?.modulos?.includes(panel) ?? false;
    }

    // ── Calcular módulos disponibles ──────────────────────────────
    function calcularModulos(rol, modulosEmpresa) {
        const panelesDelRol = ROL_MODULOS[rol] || [];

        return panelesDelRol.filter(panel => {
            const requiere = MODULO_REQUIERE[panel];
            if (!requiere) return true;
            return modulosEmpresa?.[requiere] === true;
        });
    }

    // ── Privados ──────────────────────────────────────────────────
    function _guardarSesion(sesion, recordar) {
        const json = JSON.stringify(sesion);
        sessionStorage.setItem(KEY_SESSION, json);
        if (recordar) {
            localStorage.setItem(KEY_SESSION, json);
            localStorage.setItem(KEY_RECORDAR, sesion.rut);
            localStorage.setItem(KEY_EMPRESA, sesion.empresa_id);
        } else {
            localStorage.removeItem(KEY_SESSION);
        }
    }

    function _poblarAppData(sesion) {
        window.appData.usuario = {
            id:          sesion.id,
            empresa_id:  sesion.empresa_id,
            empleado_id: sesion.empleado_id,
            rut:         sesion.rut,
            rol:         sesion.rol
        };
        window.appData.empresa  = sesion.empresa;
        window.appData.modulos  = sesion.modulos;
        window.appData.cargado  = true;
    }

    function _limpiarStorage() {
        sessionStorage.removeItem(KEY_SESSION);
        localStorage.removeItem(KEY_SESSION);
        // No borrar KEY_RECORDAR: el RUT puede persistir
    }

    // ── API pública ───────────────────────────────────────────────
    return {
        login,
        logout,
        restaurarSesion,
        calcularModulos,
        puedeAcceder,
        getRutRecordado
    };

})();
