// ================================================================
// modulo-modulos.js — Activación de módulos por taller
// ================================================================
// Cada taller decide con qué trabaja. Escribe empresas.modulos_activos
// (jsonb) y recalcula el menú en caliente, sin volver a loguearse.
//
// Reglas:
//   · Los módulos base (núcleo, administración) no se pueden apagar.
//   · Un módulo con dependencias no se enciende si le falta alguna;
//     al apagar uno, se apagan en cascada los que dependían de él.
// ================================================================

const ModuloModulos = (() => {

    let _activos = {};      // copia de trabajo de empresas.modulos_activos
    let _guardando = false;

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-modulos');
        if (!cont) return;

        cont.innerHTML = `<div class="placeholder-text">Cargando módulos…</div>`;
        await recargar();
    }

    async function recargar() {
        const cont = document.getElementById('contenido-modulos');
        if (!cont) return;

        try {
            // Leer siempre desde la BD: la sesión puede estar desactualizada
            const { data, error } = await db.from('empresas')
                .select('id, nombre, modulos_activos')
                .eq('id', window.appData.usuario.empresa_id)
                .single();
            if (error) throw error;

            _activos = data.modulos_activos || {};
            window.appData.empresa.modulos_activos = _activos;
            _render();
        } catch (err) {
            console.error('[Módulos] cargar:', err);
            cont.innerHTML = `<div class="placeholder-text">
                No se pudieron cargar los módulos del taller. Revisa la consola.</div>`;
        }
    }

    // ── Render ────────────────────────────────────────────────────
    function _render() {
        const cont = document.getElementById('contenido-modulos');
        if (!cont) return;

        const claves = Object.keys(MODULOS_CATALOGO);
        const porPlan = Object.keys(PLANES)
            .sort((a, b) => PLANES[a].orden - PLANES[b].orden)
            .map(plan => ({ plan, claves: claves.filter(c => MODULOS_CATALOGO[c].plan === plan) }))
            .filter(g => g.claves.length > 0);

        const encendidos = claves.filter(c => moduloHabilitado(c, _activos)).length;

        cont.innerHTML = `
            <div class="tll-modulos-intro">
                <strong>${encendidos}</strong> de ${claves.length} módulos activos en
                <strong>${esc(window.appData.empresa?.nombre || 'este taller')}</strong>.
                Enciende solo lo que el taller usa: el menú se arma con eso.
            </div>
            ${porPlan.map(g => `
                <div class="tll-modulos-plan">
                    <div class="nav-section-label">Plan ${esc(PLANES[g.plan].nombre)}</div>
                    <div class="tll-modulos-grid">
                        ${g.claves.map(_tarjeta).join('')}
                    </div>
                </div>`).join('')}`;

        cont.querySelectorAll('.tll-modulo-switch').forEach(sw =>
            sw.addEventListener('change', () => _alternar(sw.dataset.clave, sw.checked)));
    }

    function _tarjeta(clave) {
        const m = MODULOS_CATALOGO[clave];
        const activo = moduloHabilitado(clave, _activos);
        const faltantes = (m.requiere || []).filter(d => !moduloHabilitado(d, _activos));
        const bloqueado = m.base || faltantes.length > 0;

        const dependientes = _dependientesDe(clave)
            .filter(d => moduloHabilitado(d, _activos));

        return `
        <div class="tll-modulo-card ${activo ? 'activo' : ''}">
            <div class="tll-modulo-top">
                <span class="tll-modulo-icono">${m.icono}</span>
                <label class="tll-switch" title="${bloqueado && m.base ? 'Módulo base: siempre activo' : ''}">
                    <input type="checkbox" class="tll-modulo-switch" data-clave="${esc(clave)}"
                           ${activo ? 'checked' : ''} ${bloqueado ? 'disabled' : ''}>
                    <span class="tll-switch-pista"></span>
                </label>
            </div>
            <h4>${esc(m.nombre)}</h4>
            <p>${esc(m.descripcion)}</p>
            <div class="tll-modulo-meta">
                ${m.base ? `<span class="tll-badge lista">base</span>` : ''}
                ${m.estado === 'pendiente' ? `<span class="tll-badge diagnostico">por construir</span>` : ''}
                ${m.estado === 'beta' ? `<span class="tll-badge presupuesto">beta</span>` : ''}
                ${faltantes.length ? `<span class="tll-modulo-nota">
                    Requiere: ${faltantes.map(f => esc(MODULOS_CATALOGO[f].nombre)).join(', ')}</span>` : ''}
                ${activo && dependientes.length ? `<span class="tll-modulo-nota">
                    Lo usan: ${dependientes.map(d => esc(MODULOS_CATALOGO[d].nombre)).join(', ')}</span>` : ''}
            </div>
        </div>`;
    }

    /** Módulos que declaran a `clave` como dependencia (directa o indirecta). */
    function _dependientesDe(clave) {
        const directos = Object.keys(MODULOS_CATALOGO)
            .filter(c => (MODULOS_CATALOGO[c].requiere || []).includes(clave));
        return [...new Set(directos.flatMap(d => [d, ..._dependientesDe(d)]))];
    }

    // ── Encender / apagar ─────────────────────────────────────────
    async function _alternar(clave, encender) {
        if (_guardando) return;
        const m = MODULOS_CATALOGO[clave];
        if (!m || m.base) return;

        const nuevos = { ..._activos };

        if (encender) {
            const faltantes = (m.requiere || []).filter(d => !moduloHabilitado(d, nuevos));
            if (faltantes.length) {
                avisar(`Primero activa: ${faltantes.map(f => MODULOS_CATALOGO[f].nombre).join(', ')}`, 'error');
                _render();
                return;
            }
            nuevos[clave] = true;
        } else {
            // Apagar arrastra a todo lo que dependía de este módulo
            const arrastrados = _dependientesDe(clave).filter(d => nuevos[d] === true);
            if (arrastrados.length) {
                const ok = confirm(
                    `Apagar "${m.nombre}" también apagará: ` +
                    `${arrastrados.map(d => MODULOS_CATALOGO[d].nombre).join(', ')}.\n\n¿Continuar?`);
                if (!ok) { _render(); return; }
            }
            nuevos[clave] = false;
            arrastrados.forEach(d => { nuevos[d] = false; });
        }

        await _guardar(nuevos, encender ? m.nombre + ' activado' : m.nombre + ' desactivado');
    }

    async function _guardar(nuevos, mensaje) {
        _guardando = true;
        try {
            const { error } = await db.from('empresas')
                .update({ modulos_activos: nuevos })
                .eq('id', window.appData.usuario.empresa_id);
            if (error) throw error;

            _activos = nuevos;
            Auth.refrescarModulos(nuevos);   // recalcula appData.modulos + sesión
            reconstruirMenu();               // vuelve a armar el sidebar
            _render();
            avisar(mensaje);
        } catch (err) {
            console.error('[Módulos] guardar:', err);
            avisar('No se pudo guardar el cambio de módulos', 'error');
            _render();
        }
        _guardando = false;
    }

    return { init, recargar };

})();
