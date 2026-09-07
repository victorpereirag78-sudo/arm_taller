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
    const KEY_TOKEN      = 'tll_token';       // token de sesión para la cabecera
    const KEY_RECORDAR   = 'tll_usuario_rut'; // localStorage: RUT recordado
    const KEY_EMPRESA    = 'tll_empresa_id';  // localStorage: empresa recordada

    // ── Login ─────────────────────────────────────────────────────
    // Vía RPC fn_login_taller: la contraseña se compara dentro de
    // Postgres contra un hash bcrypt y nunca viaja en la query string.
    // Ver sql/01_seguridad_login.sql.
    async function login(rut, pass, recordar = false) {
        try {
            const { data, error } = await db.rpc('fn_login_taller', {
                p_rut: rut, p_pass: pass, p_dias: recordar ? 30 : 1
            });

            // Todavía no se ejecutó el script SQL: no dejar al taller afuera.
            if (error && _rpcNoExiste(error)) {
                console.warn('[Auth] fn_login_taller no existe todavía — ' +
                             'usando el login antiguo. Ejecuta sql/01_seguridad_login.sql.');
                return await _loginLegacy(rut, pass, recordar);
            }
            if (error) throw new Error('Error de conexión con la base de datos.');
            if (!data?.ok) return { ok: false, error: data?.error || 'RUT o contraseña incorrectos.' };

            const modulos = calcularModulos(data.usuario.rol, data.empresa.modulos_activos);
            if (modulos.length === 0) {
                return { ok: false, error: 'Tu usuario no tiene módulos asignados. Contacta al administrador.' };
            }

            const sesion = {
                id:          data.usuario.id,
                empresa_id:  data.usuario.empresa_id,
                empleado_id: data.usuario.empleado_id,
                rut:         data.usuario.rut,
                rol:         data.usuario.rol,
                empresa:     data.empresa,
                modulos:     modulos,
                login_at:    new Date().toISOString()
            };

            _guardarSesion(sesion, recordar);
            _guardarToken(data.token, recordar);
            _poblarAppData(sesion);

            return { ok: true, usuario: sesion };

        } catch (err) {
            console.error('[Auth.login]', err);
            return { ok: false, error: err.message || 'Error inesperado. Intenta de nuevo.' };
        }
    }

    /** ¿El error dice que la función RPC no está creada? */
    function _rpcNoExiste(error) {
        return error.code === 'PGRST202'
            || error.code === '42883'
            || /function .*fn_login_taller/i.test(error.message || '');
    }

    // ── Login antiguo (compara la contraseña en el navegador) ─────
    // TEMPORAL: borrar en cuanto sql/01_seguridad_login.sql esté aplicado.
    async function _loginLegacy(rut, pass, recordar) {
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
            .eq('activo', true);

        if (errU) throw new Error('Error de conexión con la base de datos.');
        if (!usuarios || usuarios.length === 0) {
            return { ok: false, error: 'RUT o contraseña incorrectos.' };
        }

        // Un RUT puede tener cuenta en varias empresas (ARM Universal es
        // multiempresa): elegir la que sirve para entrar al taller.
        const usuario = [...usuarios].sort((a, b) => {
            const s = u => (u.empresas?.tipo === 'taller' ? 2 : 0)
                         + (u.empresas?.slug === 'arm-sur' && u.rol === 'admin' ? 1 : 0);
            return s(b) - s(a);
        })[0];

        if (!usuario.empresas || !usuario.empresas.activo) {
            return { ok: false, error: 'El taller no está habilitado. Contacta al administrador.' };
        }

        const _esSuper = usuario.empresas.slug === 'arm-sur' && usuario.rol === 'admin';
        if (usuario.empresas.tipo !== 'taller' && !_esSuper) {
            return { ok: false, error: 'Este acceso es solo para talleres. Para telecom usa ARM Universal.' };
        }

        const modulos = calcularModulos(usuario.rol, usuario.empresas.modulos_activos);
        if (modulos.length === 0) {
            return { ok: false, error: 'Tu usuario no tiene módulos asignados. Contacta al administrador.' };
        }

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

        _guardarSesion(sesion, recordar);
        _poblarAppData(sesion);

        db.from('usuarios')
          .update({ ultimo_acceso: new Date().toISOString() })
          .eq('id', usuario.id)
          .then(() => {});

        return { ok: true, usuario: sesion };
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
            window.appData.impersonando = estaImpersonando();
            return sesion;

        } catch (err) {
            console.error('[Auth.restaurarSesion]', err);
            _limpiarStorage();
            return null;
        }
    }

    /** Comprueba con la base que el token de sesión siga siendo válido.
        Si venció o fue revocado, con la RLS por token la app vería todo
        vacío en vez de "sesión expirada": mejor mandar al login. */
    async function verificarToken() {
        if (!getToken()) return true;   // sin token (aún no aplicado sql/14): no molestar
        try {
            const { data, error } = await db.rpc('fn_diag_sesion');
            if (error) return true;      // RPC no existe todavía: no molestar
            // La base recibió el request pero el token no resuelve → sesión muerta
            if (data && data.hay_contexto_request && !data.token_valido) {
                console.warn('[Auth] token de sesión vencido o revocado');
                return false;
            }
            return true;
        } catch {
            return true;                 // ante la duda, no cerrar sesión
        }
    }

    // ── Logout ────────────────────────────────────────────────────
    function logout() {
        // Revocar en la base antes de soltar el token (sin await: no bloquear)
        try { db.rpc('fn_cerrar_sesion').then(() => {}, () => {}); } catch { /* da igual */ }
        _limpiarStorage();
        window.appData = { usuario: null, empresa: null, modulos: [], cargado: false };
        window.location.href = 'login.html';
    }

    // ── RUT recordado ─────────────────────────────────────────────
    function getRutRecordado() {
        return localStorage.getItem(KEY_RECORDAR) || '';
    }

    // ── Superadmin: entrar a un taller a trabajar ─────────────────
    // Guarda la sesión de arm-sur y adopta el contexto del taller
    // elegido. No es un login: es el mismo usuario mirando otro taller,
    // y la barra superior lo deja en evidencia para que nadie se confunda.
    const KEY_ORIGEN = 'tll_sesion_origen';

    // Pide a la base un token nuevo apuntando al otro taller. La base
    // verifica que la sesión actual sea de un admin de arm-sur: no se
    // confía en que el navegador diga la verdad.
    //
    // Devuelve { ok, recargar } — hay que recargar la página porque el
    // cliente de Supabase lleva el token en una cabecera fija, y esa
    // cabecera se arma en config.js al cargar.
    async function entrarComoTaller(empresa) {
        if (!empresa?.id) return { ok: false, error: 'Taller inválido.' };
        if (!esSuperadmin()) {
            return { ok: false, error: 'Solo el superadmin puede cambiar de taller.' };
        }

        const modulos = calcularModulos(window.appData.usuario.rol, empresa.modulos_activos);
        if (modulos.length === 0) {
            return { ok: false, error: 'Ese taller no tiene módulos activos para tu rol.' };
        }

        // Guardar sesión y token originales, una sola vez
        if (!sessionStorage.getItem(KEY_ORIGEN)) {
            sessionStorage.setItem(KEY_ORIGEN, JSON.stringify({
                sesion: sessionStorage.getItem(KEY_SESSION) || localStorage.getItem(KEY_SESSION) || '',
                token:  getToken()
            }));
        }

        // Token del taller destino
        try {
            const { data, error } = await db.rpc('fn_sesion_cambiar_taller', {
                p_empresa_id: empresa.id
            });
            if (error && !_rpcNoExiste(error)) throw error;

            if (data && !data.ok) {
                sessionStorage.removeItem(KEY_ORIGEN);
                return { ok: false, error: data.error };
            }
            if (data?.token) _guardarToken(data.token, false);
            // Si la RPC no existe todavía (sin script 14), se sigue con el
            // filtro del front: el comportamiento es el de antes.
        } catch (err) {
            console.error('[Auth.entrarComoTaller]', err);
            sessionStorage.removeItem(KEY_ORIGEN);
            return { ok: false, error: 'No se pudo cambiar de taller.' };
        }

        const sesion = {
            ...window.appData.usuario,
            empresa_id: empresa.id,
            empresa,
            modulos,
            impersonando: true,
            login_at: new Date().toISOString()
        };

        sessionStorage.setItem(KEY_SESSION, JSON.stringify(sesion));
        localStorage.removeItem(KEY_SESSION);   // el contexto prestado no se recuerda
        _poblarAppData(sesion);
        window.appData.impersonando = true;

        return { ok: true, recargar: true };
    }

    function volverASuperadmin() {
        const raw = sessionStorage.getItem(KEY_ORIGEN);
        sessionStorage.removeItem(KEY_ORIGEN);

        if (!raw) { logout(); return; }

        let origen;
        try { origen = JSON.parse(raw); } catch { logout(); return; }

        // Formato antiguo: era el JSON de la sesión pelado
        const sesionRaw = typeof origen === 'string' ? origen : origen.sesion;
        const tokenOrig = typeof origen === 'string' ? null   : origen.token;

        if (!sesionRaw) { logout(); return; }

        sessionStorage.setItem(KEY_SESSION, sesionRaw);
        if (tokenOrig) _guardarToken(tokenOrig, false);
        _poblarAppData(JSON.parse(sesionRaw));
        window.appData.impersonando = false;
    }

    function estaImpersonando() {
        return !!sessionStorage.getItem(KEY_ORIGEN);
    }

    function esSuperadmin() {
        const s = sessionStorage.getItem(KEY_ORIGEN);
        const base = s ? JSON.parse(s) : window.appData;
        const empresa = s ? base.empresa : window.appData.empresa;
        const rol = s ? base.rol : window.appData.usuario?.rol;
        return empresa?.slug === 'arm-sur' && rol === 'admin';
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
            if (!requiere) return true;                       // módulo base
            return moduloHabilitado(requiere, modulosEmpresa); // incluye dependencias
        });
    }

    // ── Refrescar módulos tras cambiarlos en el panel Módulos ─────
    // Recalcula los paneles visibles y reescribe la sesión guardada,
    // para que el cambio sobreviva al F5 sin volver a loguearse.
    function refrescarModulos(modulosActivos) {
        if (!window.appData?.empresa) return [];

        window.appData.empresa.modulos_activos = modulosActivos;
        const modulos = calcularModulos(window.appData.usuario.rol, modulosActivos);
        window.appData.modulos = modulos;

        for (const store of [sessionStorage, localStorage]) {
            const raw = store.getItem(KEY_SESSION);
            if (!raw) continue;
            try {
                const s = JSON.parse(raw);
                s.empresa = window.appData.empresa;
                s.modulos = modulos;
                store.setItem(KEY_SESSION, JSON.stringify(s));
            } catch { /* sesión corrupta: se limpia sola en el próximo restaurar */ }
        }
        return modulos;
    }

    // ── Privados ──────────────────────────────────────────────────
    /** El token es una credencial: se guarda aparte y se limpia con el logout.
        config.js lo lee al arrancar para armar el cliente con la cabecera. */
    function _guardarToken(token, recordar) {
        if (!token) return;
        try {
            sessionStorage.setItem(KEY_TOKEN, token);
            if (recordar) localStorage.setItem(KEY_TOKEN, token);
            else localStorage.removeItem(KEY_TOKEN);
        } catch (e) { console.warn('[Auth] no se pudo guardar el token:', e); }
    }

    function getToken() {
        try {
            return sessionStorage.getItem(KEY_TOKEN) || localStorage.getItem(KEY_TOKEN) || null;
        } catch { return null; }
    }

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
        sessionStorage.removeItem(KEY_TOKEN);
        localStorage.removeItem(KEY_TOKEN);
        // No borrar KEY_RECORDAR: el RUT puede persistir
    }

    // ── API pública ───────────────────────────────────────────────
    return {
        login,
        logout,
        restaurarSesion,
        verificarToken,
        calcularModulos,
        refrescarModulos,
        getToken,
        entrarComoTaller,
        volverASuperadmin,
        estaImpersonando,
        esSuperadmin,
        puedeAcceder,
        getRutRecordado
    };

})();
