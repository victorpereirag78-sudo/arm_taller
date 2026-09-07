// ================================================================
// modulo-taller.js — Datos del taller y administración de talleres
// ================================================================
// Dos caras:
//   · "Mi taller"  — cualquier admin: datos que salen en los
//                    documentos impresos y parámetros de operación.
//   · "Talleres"   — solo el superadmin de arm-sur: crear talleres,
//                    asignarles módulos y ENTRAR a trabajar en uno.
//
// Los datos propios del taller viven en taller_config, no en la tabla
// 'empresas': esa la comparte esta app con ARM Universal y no se toca.
// Ver sql/10_taller_admin.sql.
// ================================================================

const ModuloTaller = (() => {

    let _empresa  = null;    // fila de 'empresas' del taller actual
    let _config   = null;    // fila de taller_config
    let _talleres = [];      // solo superadmin
    let _vista    = 'mio';   // mio | talleres

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-taller');
        if (!cont) return;

        const superadmin = Auth.esSuperadmin();

        cont.innerHTML = `
            ${superadmin ? `
            <div class="tll-tabs">
                <button class="tll-tab active" data-vista="mio">Mi taller</button>
                <button class="tll-tab" data-vista="talleres">Talleres</button>
            </div>` : ''}
            <div id="tll-cuerpo"><div class="placeholder-text">Cargando…</div></div>`;

        cont.querySelectorAll('.tll-tab').forEach(t =>
            t.addEventListener('click', () => {
                _vista = t.dataset.vista;
                cont.querySelectorAll('.tll-tab').forEach(x => x.classList.toggle('active', x === t));
                _render();
            }));

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [eRes, cRes] = await Promise.all([
                db.from('empresas')
                  .select('id, nombre, slug, logo_url, tipo, activo, modulos_activos')
                  .eq('id', eid).single(),
                db.rpc('fn_taller_config', { p_empresa_id: eid })
            ]);

            if (eRes.error) throw eRes.error;
            _empresa = eRes.data;
            _config  = cRes.data?.ok ? cRes.data.config : null;

            if (cRes.error) console.warn('[Taller] config:', cRes.error);

            if (Auth.esSuperadmin()) await _cargarTalleres();
            _render();
        } catch (err) {
            console.error('[Taller] cargar:', err);
            const cont = document.getElementById('tll-cuerpo');
            if (cont) {
                cont.innerHTML = errorCarga(err, '10_taller_admin.sql', 'los datos del taller');
            }
        }
    }

    async function _cargarTalleres() {
        const { data, error } = await db.from('v_taller_empresas').select('*').order('nombre');
        if (error) { console.warn('[Taller] talleres:', error); _talleres = []; return; }
        _talleres = data || [];
    }

    function _render() {
        if (_vista === 'talleres' && Auth.esSuperadmin()) _renderTalleres();
        else _renderMiTaller();
    }

    // ══ MI TALLER ═════════════════════════════════════════════════
    function _renderMiTaller() {
        const cont = document.getElementById('tll-cuerpo');
        if (!cont) return;

        const mods = _empresa?.modulos_activos || {};
        const activos = Object.keys(MODULOS_CATALOGO).filter(c => moduloHabilitado(c, mods));
        const plan = _planoDelTaller(activos);

        cont.innerHTML = `
            <div class="tll-rep-grid">
                <div class="tll-rep-card">
                    <h3>Identificación</h3>
                    <div class="tll-form-grid">
                        <div class="tll-field tll-field--full">
                            <label>Nombre del taller *</label>
                            <input class="tll-input" id="tll-f-nombre" value="${esc(_empresa?.nombre || '')}">
                        </div>
                        <div class="tll-field">
                            <label>RUT</label>
                            <input class="tll-input" id="tll-f-rut" style="font-family:var(--font-mono)"
                                   placeholder="76.543.210-K" value="${esc(_config?.rut || '')}">
                        </div>
                        <div class="tll-field">
                            <label>Giro</label>
                            <input class="tll-input" id="tll-f-giro"
                                   placeholder="Servicio técnico automotriz" value="${esc(_config?.giro || '')}">
                        </div>
                        <div class="tll-field tll-field--full">
                            <label>Dirección</label>
                            <input class="tll-input" id="tll-f-direccion" value="${esc(_config?.direccion || '')}">
                        </div>
                        <div class="tll-field">
                            <label>Comuna</label>
                            <input class="tll-input" id="tll-f-comuna" value="${esc(_config?.comuna || '')}">
                        </div>
                        <div class="tll-field">
                            <label>Ciudad</label>
                            <input class="tll-input" id="tll-f-ciudad" value="${esc(_config?.ciudad || '')}">
                        </div>
                        <div class="tll-field">
                            <label>Teléfono</label>
                            <input class="tll-input" id="tll-f-telefono" value="${esc(_config?.telefono || '')}">
                        </div>
                        <div class="tll-field">
                            <label>Email</label>
                            <input class="tll-input" id="tll-f-email" type="email" value="${esc(_config?.email || '')}">
                        </div>
                        <div class="tll-field tll-field--full">
                            <label>Logo (URL)</label>
                            <input class="tll-input" id="tll-f-logo" value="${esc(_empresa?.logo_url || '')}">
                            <span class="tll-field-msg">Aparece en la barra lateral.</span>
                        </div>
                    </div>
                </div>

                <div class="tll-rep-card">
                    <h3>Documentos y operación</h3>
                    <div class="tll-form-grid">
                        <div class="tll-field">
                            <label>Validez de presupuestos (días)</label>
                            <input class="tll-input" id="tll-f-validez" type="number" min="1"
                                   value="${_config?.dias_validez_presupuesto ?? 15}">
                        </div>
                        <div class="tll-field">
                            <label>Sitio web</label>
                            <input class="tll-input" id="tll-f-web" value="${esc(_config?.sitio_web || '')}">
                        </div>
                        <div class="tll-field tll-field--full">
                            <label>Condiciones del presupuesto</label>
                            <textarea class="tll-textarea" id="tll-f-condiciones" rows="3"
                                placeholder="Ej: los precios pueden variar según disponibilidad del repuesto…">${esc(_config?.condiciones_presupuesto || '')}</textarea>
                            <span class="tll-field-msg">Se imprime al pie de cada presupuesto.</span>
                        </div>
                        <div class="tll-field tll-field--full">
                            <label>Pie de documentos</label>
                            <input class="tll-input" id="tll-f-pie"
                                   placeholder="Gracias por preferirnos" value="${esc(_config?.pie_documentos || '')}">
                        </div>
                    </div>

                    <div class="tll-rep-sep"></div>
                    <div class="tll-rep-fila fuerte"><span>Plan</span><strong>${esc(plan)}</strong></div>
                    <div class="tll-rep-fila">
                        <span>Módulos activos</span>
                        <strong>${activos.length} de ${Object.keys(MODULOS_CATALOGO).length}</strong></div>
                    <div class="tll-rep-fila">
                        <span>Identificador</span>
                        <strong style="font-family:var(--font-mono)">${esc(_empresa?.slug || '—')}</strong></div>
                    <p class="tll-rep-nota">
                        Los módulos se encienden en <strong>Admin › Módulos</strong>.
                        El identificador no se cambia: es la llave del taller.
                    </p>
                </div>
            </div>

            <div class="tll-rep-card" style="margin-top:1rem">
                <h3>Perfil público · Directorio de Mi Vehículo</h3>
                <p class="tll-rep-nota" style="margin-top:0">
                    Si publicas, tu taller aparece en “Talleres ARM” dentro de la app Mi Vehículo,
                    donde los propietarios pueden encontrarte y pedir hora.</p>
                <div class="tll-form-grid" style="margin-top:0.6rem">
                    <div class="tll-field">
                        <label>
                            <input type="checkbox" id="tll-f-publicado" ${_config?.publicado ? 'checked' : ''}>
                            Publicar en el directorio
                        </label>
                    </div>
                    <div class="tll-field">
                        <label>WhatsApp de contacto</label>
                        <input class="tll-input" id="tll-f-whatsapp" placeholder="+56 9 …" value="${esc(_config?.whatsapp || '')}">
                    </div>
                    <div class="tll-field tll-field--full">
                        <label>Descripción breve</label>
                        <input class="tll-input" id="tll-f-descripcion" maxlength="200"
                               placeholder="Servicio automotriz multimarca, atención el mismo día…"
                               value="${esc(_config?.descripcion || '')}">
                    </div>
                    <div class="tll-field tll-field--full">
                        <label>Horario</label>
                        <input class="tll-input" id="tll-f-horario"
                               placeholder="Lun a Vie 9:00–18:30 · Sáb 9:00–13:00"
                               value="${esc(_config?.horario || '')}">
                    </div>
                    <div class="tll-field">
                        <label>Latitud</label>
                        <input class="tll-input" id="tll-f-lat" type="number" step="any"
                               placeholder="-33.45" value="${_config?.lat ?? ''}">
                    </div>
                    <div class="tll-field">
                        <label>Longitud</label>
                        <input class="tll-input" id="tll-f-lng" type="number" step="any"
                               placeholder="-70.66" value="${_config?.lng ?? ''}">
                        <span class="tll-field-msg">Para ordenar por cercanía. Cópialas de Google Maps.</span>
                    </div>
                    <div class="tll-field tll-field--full">
                        <label>Servicios (separados por coma)</label>
                        <input class="tll-input" id="tll-f-servicios"
                               placeholder="Mantención general, Frenos, Cambio de aceite"
                               value="${esc((_config?.servicios || []).join(', '))}">
                    </div>
                    <div class="tll-field tll-field--full">
                        <label>Especialidades (separadas por coma)</label>
                        <input class="tll-input" id="tll-f-especialidades"
                               placeholder="Autos, Motos, Diésel"
                               value="${esc((_config?.especialidades || []).join(', '))}">
                    </div>
                    <div class="tll-field tll-field--full">
                        <label>Marcas que atiende (separadas por coma)</label>
                        <input class="tll-input" id="tll-f-marcas"
                               placeholder="Toyota, Peugeot, Hyundai"
                               value="${esc((_config?.marcas || []).join(', '))}">
                    </div>
                </div>
            </div>

            <div class="tll-toolbar" style="margin-top:1.2rem">
                <button class="tll-btn tll-btn--primary" id="tll-guardar">Guardar datos del taller</button>
                <button class="tll-btn tll-btn--ghost" id="tll-recargar">↻ Descartar cambios</button>
            </div>`;

        const inpRut = document.getElementById('tll-f-rut');
        inpRut.addEventListener('input', () => { inpRut.value = formatearRut(inpRut.value); });

        document.getElementById('tll-guardar').addEventListener('click', _guardarMiTaller);
        document.getElementById('tll-recargar').addEventListener('click', recargar);
    }

    /** "a, b ,c" → ['a','b','c'] (sin vacíos ni duplicados). */
    function _listaDesde(id) {
        const vistos = new Set();
        return (document.getElementById(id)?.value || '')
            .split(',').map(s => s.trim()).filter(s => {
                if (!s || vistos.has(s.toLowerCase())) return false;
                vistos.add(s.toLowerCase());
                return true;
            });
    }

    async function _guardarMiTaller() {
        const nombre = document.getElementById('tll-f-nombre').value.trim();
        if (!nombre) { avisar('El nombre del taller es obligatorio', 'error'); return; }

        const rut = normalizarRut(document.getElementById('tll-f-rut').value);
        if (rut && !validarRutChileno(rut)) {
            avisar('RUT inválido — revisa el dígito verificador', 'error'); return;
        }
        const email = document.getElementById('tll-f-email').value.trim();
        if (email && !validarEmail(email)) { avisar('Email con formato inválido', 'error'); return; }

        const btn = document.getElementById('tll-guardar');
        btn.disabled = true;

        try {
            const eid = window.appData.usuario.empresa_id;
            const logo = document.getElementById('tll-f-logo').value.trim() || null;

            // 'empresas' es la tabla compartida: solo nombre y logo
            const { error: e1 } = await db.from('empresas')
                .update({ nombre, logo_url: logo }).eq('id', eid);
            if (e1) throw e1;

            const { error: e2 } = await db.from('taller_config').upsert({
                empresa_id:  eid,
                rut:         rut || null,
                giro:        document.getElementById('tll-f-giro').value.trim() || null,
                direccion:   document.getElementById('tll-f-direccion').value.trim() || null,
                comuna:      document.getElementById('tll-f-comuna').value.trim() || null,
                ciudad:      document.getElementById('tll-f-ciudad').value.trim() || null,
                telefono:    document.getElementById('tll-f-telefono').value.trim() || null,
                email:       email || null,
                sitio_web:   document.getElementById('tll-f-web').value.trim() || null,
                dias_validez_presupuesto: Number(document.getElementById('tll-f-validez').value) || 15,
                condiciones_presupuesto:  document.getElementById('tll-f-condiciones').value.trim() || null,
                pie_documentos:           document.getElementById('tll-f-pie').value.trim() || null,
                publicado:      document.getElementById('tll-f-publicado').checked,
                whatsapp:       document.getElementById('tll-f-whatsapp').value.trim() || null,
                descripcion:    document.getElementById('tll-f-descripcion').value.trim() || null,
                horario:        document.getElementById('tll-f-horario').value.trim() || null,
                lat:            parseFloat(document.getElementById('tll-f-lat').value) || null,
                lng:            parseFloat(document.getElementById('tll-f-lng').value) || null,
                servicios:      _listaDesde('tll-f-servicios'),
                especialidades: _listaDesde('tll-f-especialidades'),
                marcas:         _listaDesde('tll-f-marcas'),
                updated_at: new Date().toISOString()
            }, { onConflict: 'empresa_id' });
            if (e2) throw e2;

            // Reflejar el nombre nuevo en la barra lateral sin recargar
            window.appData.empresa.nombre   = nombre;
            window.appData.empresa.logo_url = logo;
            Auth.refrescarModulos(window.appData.empresa.modulos_activos);
            refrescarShell();

            avisar('Datos del taller guardados');
            await recargar();
        } catch (err) {
            console.error('[Taller] guardar:', err);
            btn.disabled = false;
            avisar('Error al guardar. Revisa la consola.', 'error');
        }
    }

    // ══ TALLERES (superadmin) ═════════════════════════════════════
    function _renderTalleres() {
        const cont = document.getElementById('tll-cuerpo');
        if (!cont) return;

        const actual = window.appData.usuario.empresa_id;

        cont.innerHTML = `
            <div class="tll-kpis">
                ${_kpi('🏭', _talleres.length, 'Talleres')}
                ${_kpi('✅', _talleres.filter(t => t.activo).length, 'Activos')}
                ${_kpi('👥', _talleres.reduce((s, t) => s + Number(t.usuarios || 0), 0), 'Usuarios')}
                ${_kpi('🛠', _talleres.reduce((s, t) => s + Number(t.ordenes || 0), 0), 'Órdenes totales')}
            </div>

            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="tll-nuevo">+ Nuevo taller</button>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="tll-reload">↻ Actualizar</button>
            </div>

            <div class="tll-tabla-wrap">
            <table class="tll-tabla">
                <thead><tr>
                    <th>Taller</th><th>Identificador</th>
                    <th style="text-align:right">Módulos</th>
                    <th style="text-align:right">Usuarios</th>
                    <th style="text-align:right">Órdenes</th>
                    <th>Último acceso</th><th>Estado</th><th></th>
                </tr></thead>
                <tbody>
                ${_talleres.length === 0
                    ? `<tr><td colspan="8"><div class="placeholder-text">
                         Sin talleres registrados. Crea el primero con <strong>+ Nuevo taller</strong>.</div></td></tr>`
                    : _talleres.map(t => `
                    <tr${t.activo ? '' : ' style="opacity:0.5"'}>
                        <td><strong>${esc(t.nombre)}</strong>
                            ${t.id === actual ? '<span class="tll-badge aprobada">estás aquí</span>' : ''}
                            ${t.ciudad ? `<div style="font-size:0.72rem;color:var(--text-secondary)">${esc(t.ciudad)}</div>` : ''}</td>
                        <td style="font-family:var(--font-mono);font-size:0.78rem">${esc(t.slug)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${t.modulos_activos_n}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${t.usuarios}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${t.ordenes}</td>
                        <td style="font-size:0.78rem">${t.ultimo_acceso ? fmtFechaHora(t.ultimo_acceso) : '—'}</td>
                        <td><span class="tll-badge ${t.activo ? 'lista' : 'anulada'}">
                            ${t.activo ? 'activo' : 'inactivo'}</span></td>
                        <td style="text-align:right;white-space:nowrap">
                            <button class="tll-btn tll-btn--ghost tll-mods" data-id="${t.id}">Módulos</button>
                            <button class="tll-btn tll-btn--ghost tll-toggle" data-id="${t.id}"
                                    data-activo="${t.activo}">${t.activo ? 'Desactivar' : 'Activar'}</button>
                            ${t.id !== actual && t.activo
                                ? `<button class="tll-btn tll-btn--primary tll-entrar" data-id="${t.id}">Entrar</button>`
                                : ''}
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table></div>

            <p class="tll-rep-nota">
                <strong>Entrar</strong> te deja trabajar dentro de ese taller con tu mismo usuario,
                para probar los módulos con sus datos. La barra superior te avisa mientras estés adentro.
            </p>`;

        document.getElementById('tll-nuevo').addEventListener('click', _abrirNuevoTaller);
        document.getElementById('tll-reload').addEventListener('click', recargar);

        const porId = (b) => _talleres.find(t => t.id === b.dataset.id);
        cont.querySelectorAll('.tll-mods').forEach(b =>
            b.addEventListener('click', () => _abrirModulos(porId(b))));
        cont.querySelectorAll('.tll-toggle').forEach(b =>
            b.addEventListener('click', () => _toggleTaller(porId(b), b.dataset.activo !== 'true')));
        cont.querySelectorAll('.tll-entrar').forEach(b =>
            b.addEventListener('click', () => _entrar(porId(b))));
    }

    // ── Crear taller ──────────────────────────────────────────────
    function _abrirNuevoTaller() {
        abrirModal(`
        <div class="tll-modal-header">
            <h3>Nuevo taller</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            Se crea el taller y su usuario administrador. La contraseña se guarda
            hasheada: el sistema nunca la almacena en texto plano.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Nombre del taller *</label>
                <input class="tll-input" id="tll-n-nombre" placeholder="Taller San Miguel">
            </div>
            <div class="tll-field tll-field--full">
                <label>Identificador (opcional)</label>
                <input class="tll-input" id="tll-n-slug" style="font-family:var(--font-mono)"
                       placeholder="se genera del nombre">
                <span class="tll-field-msg">Solo minúsculas y guiones. No se puede cambiar después.</span>
            </div>
            <div class="tll-field">
                <label>RUT del administrador *</label>
                <input class="tll-input" id="tll-n-rut" style="font-family:var(--font-mono)"
                       placeholder="12.345.678-9">
            </div>
            <div class="tll-field">
                <label>Contraseña *</label>
                <input class="tll-input" id="tll-n-pass" type="password" placeholder="mínimo 6 caracteres">
            </div>
            <div class="tll-field tll-field--full">
                <label>Módulos iniciales</label>
                <div class="tll-modulos-mini" id="tll-n-modulos">
                    ${Object.entries(MODULOS_CATALOGO).filter(([, m]) => !m.base).map(([c, m]) => `
                        <label class="tll-check">
                            <input type="checkbox" value="${esc(c)}"> ${m.icono} ${esc(m.nombre)}
                        </label>`).join('')}
                </div>
                <span class="tll-field-msg">Se pueden cambiar después. Las dependencias se resuelven solas.</span>
            </div>

            <div class="tll-field tll-field--full">
                <div class="tll-rep-sep"></div>
                <label>Tu contraseña de superadmin *</label>
                <input class="tll-input" id="tll-n-adminpass" type="password">
                <span class="tll-field-msg">
                    Crear un taller genera credenciales nuevas: la base la verifica antes de hacer nada.</span>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="tll-n-ok">Crear taller</button>
        </div>`, '680px');

        const inpRut = document.getElementById('tll-n-rut');
        inpRut.addEventListener('input', () => { inpRut.value = formatearRut(inpRut.value); });

        document.getElementById('tll-n-ok').addEventListener('click', async () => {
            const nombre = document.getElementById('tll-n-nombre').value.trim();
            const rut    = normalizarRut(document.getElementById('tll-n-rut').value);
            const pass   = document.getElementById('tll-n-pass').value;
            const admin  = document.getElementById('tll-n-adminpass').value;

            if (!nombre) { avisar('El nombre del taller es obligatorio', 'error'); return; }
            if (!rut || !validarRutChileno(rut)) { avisar('RUT del administrador inválido', 'error'); return; }
            if (pass.length < 6) { avisar('La contraseña debe tener al menos 6 caracteres', 'error'); return; }
            if (!admin) { avisar('Ingresa tu contraseña de superadmin', 'error'); return; }

            // Encender también las dependencias de lo marcado
            const marcados = [...document.querySelectorAll('#tll-n-modulos input:checked')].map(i => i.value);
            const modulos = {};
            const encender = (c) => {
                if (modulos[c]) return;
                modulos[c] = true;
                (MODULOS_CATALOGO[c]?.requiere || []).forEach(encender);
            };
            marcados.forEach(encender);

            const btn = document.getElementById('tll-n-ok');
            btn.disabled = true;

            const res = await _rpc('fn_crear_taller', {
                p_admin_rut:    window.appData.usuario.rut,
                p_admin_pass:   admin,
                p_nombre:       nombre,
                p_slug:         document.getElementById('tll-n-slug').value.trim() || null,
                p_usuario_rut:  rut,
                p_usuario_pass: pass,
                p_modulos:      modulos
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo crear el taller', 'error'); btn.disabled = false; return; }

            avisar(`Taller "${nombre}" creado · identificador ${res.slug}`);
            cerrarModal();
            await recargar();
        });
    }

    // ── Módulos de otro taller ────────────────────────────────────
    function _abrirModulos(t) {
        if (!t) return;
        const mods = { ...(t.modulos_activos || {}) };

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Módulos de ${esc(t.nombre)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="tll-m-lista"></div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="tll-m-ok">Guardar módulos</button>
        </div>`, '640px');

        const pintar = () => {
            document.getElementById('tll-m-lista').innerHTML = `
            <div class="tll-modulos-mini">
                ${Object.entries(MODULOS_CATALOGO).map(([c, m]) => {
                    const activo = moduloHabilitado(c, mods);
                    const faltan = (m.requiere || []).filter(d => !moduloHabilitado(d, mods));
                    return `
                    <label class="tll-check" ${m.base ? 'style="opacity:0.55"' : ''}>
                        <input type="checkbox" data-clave="${esc(c)}"
                               ${activo ? 'checked' : ''} ${m.base || faltan.length ? 'disabled' : ''}>
                        ${m.icono} ${esc(m.nombre)}
                        ${m.base ? '<span class="tll-badge lista">base</span>' : ''}
                        ${faltan.length ? `<span class="tll-modulo-nota">necesita ${
                            faltan.map(f => esc(MODULOS_CATALOGO[f].nombre)).join(', ')}</span>` : ''}
                    </label>`;
                }).join('')}
            </div>`;

            document.querySelectorAll('#tll-m-lista input[data-clave]').forEach(chk =>
                chk.addEventListener('change', () => {
                    const c = chk.dataset.clave;
                    if (chk.checked) mods[c] = true;
                    else {
                        mods[c] = false;
                        // apagar en cascada lo que dependía
                        Object.keys(MODULOS_CATALOGO).forEach(o => {
                            if (!moduloHabilitado(o, mods)) mods[o] = false;
                        });
                    }
                    pintar();
                }));
        };
        pintar();

        document.getElementById('tll-m-ok').addEventListener('click', async () => {
            const btn = document.getElementById('tll-m-ok');
            btn.disabled = true;
            try {
                const { error } = await db.from('empresas')
                    .update({ modulos_activos: mods }).eq('id', t.id);
                if (error) throw error;

                // Si es el taller en el que estoy, refrescar mi propio menú
                if (t.id === window.appData.usuario.empresa_id) {
                    Auth.refrescarModulos(mods);
                    refrescarShell();
                }
                avisar('Módulos actualizados');
                cerrarModal();
                await recargar();
            } catch (err) {
                console.error('[Taller] módulos:', err);
                btn.disabled = false;
                avisar('No se pudieron guardar los módulos', 'error');
            }
        });
    }

    async function _toggleTaller(t, activo) {
        if (!t) return;
        if (!activo && !confirm(
            `Desactivar "${t.nombre}".\n\nSus ${t.usuarios} usuario(s) no podrán entrar.\n\n¿Continuar?`)) return;

        try {
            const { error } = await db.from('empresas').update({ activo }).eq('id', t.id);
            if (error) throw error;
            avisar(activo ? 'Taller activado' : 'Taller desactivado');
            await recargar();
        } catch (err) {
            console.error('[Taller] toggle:', err);
            avisar('No se pudo cambiar el estado', 'error');
        }
    }

    // ── Entrar a trabajar en otro taller ──────────────────────────
    async function _entrar(t) {
        if (!t) return;
        if (!confirm(
            `Entrar a "${t.nombre}".\n\n` +
            `Vas a ver y modificar los datos de ese taller con tu mismo usuario.\n` +
            `Puedes volver desde la barra superior.\n\n¿Continuar?`)) return;

        const res = await Auth.entrarComoTaller({
            id: t.id, nombre: t.nombre, slug: t.slug, logo_url: t.logo_url,
            tipo: 'taller', activo: t.activo, modulos_activos: t.modulos_activos
        });

        if (!res.ok) { avisar(res.error, 'error'); return; }

        // La cabecera con el token se arma en config.js al cargar la página,
        // así que hay que recargar para que el cliente hable como este taller.
        if (res.recargar) { window.location.reload(); return; }

        avisar(`Estás trabajando en ${t.nombre}`);
        refrescarShell({ reiniciarPaneles: true });
        mostrarPanel(window.appData.modulos[0] || 'panel-dashboard');
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _planoDelTaller(activos) {
        const orden = activos
            .map(c => PLANES[MODULOS_CATALOGO[c].plan]?.orden || 1)
            .reduce((a, b) => Math.max(a, b), 1);
        return Object.values(PLANES).find(p => p.orden === orden)?.nombre || 'Básico';
    }

    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Taller] rpc ' + nombre + ':', error);
            avisar(error.code === 'PGRST202' || error.code === '42883'
                ? `Falta ejecutar sql/10_taller_admin.sql (${nombre})`
                : 'Error en la operación. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _kpi(icono, valor, label) {
        return `
        <div class="tll-kpi">
            <span class="tll-kpi-icono">${icono}</span>
            <div class="tll-kpi-valor">${valor}</div>
            <div class="tll-kpi-label">${label}</div>
        </div>`;
    }

    return { init, recargar };

})();
