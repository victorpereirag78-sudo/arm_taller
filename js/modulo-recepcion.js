// ================================================================
// modulo-recepcion.js — RECEPCIÓN DE VEHÍCULO (puerta de entrada)
// ================================================================
// Aquí nace todo: llega el cliente con su vehículo y puede pedir:
//   1. Solo un PRESUPUESTO  → orden en estado 'presupuesto'
//   2. RECEPCIÓN inmediata  → orden en estado 'recepcion' (deriva a OT)
//
// El formulario busca cliente por RUT y vehículo por patente;
// si no existen, los crea en el mismo flujo (cliente habitual = 2 clics).
// Patrón de panel completo, como el módulo de ingreso de Universal.
// ================================================================

const ModuloRecepcion = (() => {

    let _clienteSel  = null;   // cliente encontrado o creado
    let _vehiculoSel = null;   // vehículo encontrado o creado

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-recepcion');
        if (!cont) return;
        // Reset obligatorio: estas variables sobreviven al re-render y
        // sin limpiarlas la siguiente recepción se asocia al cliente anterior.
        _clienteSel  = null;
        _vehiculoSel = null;
        cont.innerHTML = _renderHTML();
        _bindEventos();
    }

    // ── HTML del formulario ───────────────────────────────────────
    function _renderHTML() {
        return `
        <!-- PASO 1: CLIENTE -->
        <div class="tll-recep-paso">
            <div class="tll-recep-num">1</div>
            <div class="tll-recep-body">
                <h3>Cliente</h3>
                <div class="tll-form-grid">
                    <div class="tll-field">
                        <label>RUT del cliente</label>
                        <input class="tll-input" id="rec-rut" placeholder="12.345.678-9"
                               style="font-family:var(--font-mono)">
                        <span class="tll-field-msg" id="rec-rut-msg"></span>
                    </div>
                </div>
                <div id="rec-cliente-resultado"></div>
                <div id="rec-cliente-nuevo" class="oculto">
                    <div class="tll-form-grid" style="margin-top:0.6rem">
                        <div class="tll-field">
                            <label>Nombre *</label>
                            <input class="tll-input" id="rec-cli-nombre">
                        </div>
                        <div class="tll-field">
                            <label>Teléfono</label>
                            <input class="tll-input" id="rec-cli-telefono" placeholder="+56 9 1234 5678">
                            <span class="tll-field-msg" id="rec-tel-msg"></span>
                        </div>
                        <div class="tll-field">
                            <label>Email</label>
                            <input class="tll-input" id="rec-cli-email" type="email">
                            <span class="tll-field-msg" id="rec-email-msg"></span>
                        </div>
                        <div class="tll-field">
                            <label>Tipo</label>
                            <select class="tll-select" id="rec-cli-tipo">
                                <option value="persona">Persona</option>
                                <option value="empresa">Empresa</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- PASO 2: VEHÍCULO -->
        <div class="tll-recep-paso">
            <div class="tll-recep-num">2</div>
            <div class="tll-recep-body">
                <h3>Vehículo</h3>
                <div class="tll-form-grid">
                    <div class="tll-field">
                        <label>Patente</label>
                        <input class="tll-input" id="rec-patente" placeholder="ABCD12"
                               style="font-family:var(--font-mono);text-transform:uppercase">
                        <span class="tll-field-msg" id="rec-pat-msg"></span>
                    </div>
                </div>
                <div id="rec-vehiculo-resultado"></div>
                <div id="rec-vehiculo-nuevo" class="oculto">
                    <div class="tll-form-grid" style="margin-top:0.6rem">
                        <div class="tll-field">
                            <label>Marca</label>
                            <input class="tll-input" id="rec-veh-marca" placeholder="Toyota">
                        </div>
                        <div class="tll-field">
                            <label>Modelo</label>
                            <input class="tll-input" id="rec-veh-modelo" placeholder="Yaris">
                        </div>
                        <div class="tll-field">
                            <label>Año</label>
                            <input class="tll-input" id="rec-veh-anio" type="number" min="1950" max="2030">
                        </div>
                        <div class="tll-field">
                            <label>Color</label>
                            <input class="tll-input" id="rec-veh-color">
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- PASO 3: DATOS DE INGRESO -->
        <div class="tll-recep-paso">
            <div class="tll-recep-num">3</div>
            <div class="tll-recep-body">
                <h3>Motivo de la visita</h3>
                <div class="tll-form-grid">
                    <div class="tll-field tll-field--full">
                        <label>¿Qué necesita el cliente? *</label>
                        <textarea class="tll-textarea" id="rec-motivo"
                            placeholder="Ej: ruido al frenar, mantención 40.000 km, cotizar cambio de embrague…"></textarea>
                    </div>
                    <div class="tll-field">
                        <label>Kilometraje actual</label>
                        <input class="tll-input" id="rec-km" type="number" min="0">
                    </div>
                    <div class="tll-field">
                        <label>Nivel de combustible</label>
                        <select class="tll-select" id="rec-combustible">
                            <option value="">—</option>
                            <option value="1/4">1/4</option>
                            <option value="1/2">1/2</option>
                            <option value="3/4">3/4</option>
                            <option value="lleno">Lleno</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>

        <!-- PASO 4: DERIVAR -->
        <div class="tll-recep-acciones">
            <button class="tll-btn tll-btn--ghost" id="rec-btn-presupuesto">
                📋 Generar presupuesto
                <span class="tll-recep-hint">el vehículo NO queda en el taller</span>
            </button>
            <button class="tll-btn tll-btn--primary" id="rec-btn-orden">
                🛠 Recepcionar → Orden de trabajo
                <span class="tll-recep-hint">el vehículo queda en el taller</span>
            </button>
        </div>`;
    }

    // ── Eventos ───────────────────────────────────────────────────
    function _bindEventos() {

        // RUT: formato en vivo + búsqueda al completar un RUT válido
        const inpRut = document.getElementById('rec-rut');
        inpRut.addEventListener('input', async () => {
            inpRut.value = formatearRut(inpRut.value);
            const msg = document.getElementById('rec-rut-msg');
            const rut = normalizarRut(inpRut.value);

            _clienteSel = null;
            document.getElementById('rec-cliente-resultado').innerHTML = '';
            document.getElementById('rec-cliente-nuevo').classList.add('oculto');

            if (rut.length < 8) { msg.textContent = ''; return; }

            if (!validarRutChileno(rut)) {
                msg.textContent = 'RUT inválido — revisa el dígito verificador';
                msg.className = 'tll-field-msg tll-field-msg--error';
                return;
            }
            msg.textContent = '';
            await _buscarCliente(rut);
        });

        // Patente: normalizar en vivo + buscar al tener largo válido
        const inpPat = document.getElementById('rec-patente');
        inpPat.addEventListener('input', async () => {
            inpPat.value = normalizarPatente(inpPat.value);

            _vehiculoSel = null;
            document.getElementById('rec-vehiculo-resultado').innerHTML = '';
            document.getElementById('rec-vehiculo-nuevo').classList.add('oculto');

            if (inpPat.value.length >= 5) await _buscarVehiculo(inpPat.value);
        });

        // Validación en vivo de teléfono y email del cliente nuevo
        document.getElementById('rec-cli-telefono').addEventListener('input', (e) => {
            const msg = document.getElementById('rec-tel-msg');
            if (!e.target.value.trim()) { msg.textContent = ''; return; }
            const ok = validarTelefono(e.target.value);
            msg.textContent = ok ? '' : 'Teléfono inválido — deben ser 8 o 9 dígitos';
            msg.className = 'tll-field-msg tll-field-msg--error';
        });
        document.getElementById('rec-cli-email').addEventListener('input', (e) => {
            const msg = document.getElementById('rec-email-msg');
            if (!e.target.value.trim()) { msg.textContent = ''; return; }
            const ok = validarEmail(e.target.value);
            msg.textContent = ok ? '' : 'Email con formato inválido';
            msg.className = 'tll-field-msg tll-field-msg--error';
        });

        document.getElementById('rec-btn-presupuesto').addEventListener('click', () => _derivar('presupuesto'));
        document.getElementById('rec-btn-orden').addEventListener('click', () => _derivar('recepcion'));
    }

    // ── Buscar cliente por RUT ────────────────────────────────────
    async function _buscarCliente(rut) {
        try {
            const { data, error } = await db.from('taller_clientes')
                .select('*')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .eq('rut', rut)
                .limit(1);
            if (error) throw error;

            const res = document.getElementById('rec-cliente-resultado');

            if (data && data.length > 0) {
                _clienteSel = data[0];
                res.innerHTML = `
                <div class="tll-recep-found">
                    ✓ Cliente habitual: <strong>${esc(_clienteSel.nombre)}</strong>
                    <span style="opacity:0.8;font-size:0.76rem">— datos precargados, actualízalos si cambiaron</span>
                </div>`;
                // Precargar campos editables con sus datos
                document.getElementById('rec-cli-nombre').value   = _clienteSel.nombre || '';
                document.getElementById('rec-cli-telefono').value = _clienteSel.telefono || '';
                document.getElementById('rec-cli-email').value    = _clienteSel.email || '';
                document.getElementById('rec-cli-tipo').value     = _clienteSel.tipo || 'persona';
                document.getElementById('rec-cliente-nuevo').classList.remove('oculto');
            } else {
                res.innerHTML = `<div class="tll-recep-notfound">Cliente nuevo — completa sus datos:</div>`;
                _limpiarCamposCliente();
                document.getElementById('rec-cliente-nuevo').classList.remove('oculto');
                document.getElementById('rec-cli-nombre').focus();
            }
        } catch (err) {
            console.error('[Recepción] buscar cliente:', err);
        }
    }

    // ── Buscar vehículo por patente ───────────────────────────────
    async function _buscarVehiculo(patente) {
        try {
            const { data, error } = await db.from('taller_vehiculos')
                .select('*, taller_clientes(id, nombre)')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .eq('patente', patente)
                .limit(1);
            if (error) throw error;

            const res = document.getElementById('rec-vehiculo-resultado');

            if (data && data.length > 0) {
                _vehiculoSel = data[0];
                const dueno = _vehiculoSel.taller_clientes?.nombre;
                res.innerHTML = `
                <div class="tll-recep-found">
                    ✓ Vehículo conocido
                    ${dueno ? `· dueño: <strong>${esc(dueno)}</strong>` : ''}
                    <span style="opacity:0.8;font-size:0.76rem">— datos precargados, actualízalos si cambiaron</span>
                </div>`;
                // Precargar campos editables con sus datos
                document.getElementById('rec-veh-marca').value  = _vehiculoSel.marca || '';
                document.getElementById('rec-veh-modelo').value = _vehiculoSel.modelo || '';
                document.getElementById('rec-veh-anio').value   = _vehiculoSel.anio || '';
                document.getElementById('rec-veh-color').value  = _vehiculoSel.color || '';
                document.getElementById('rec-vehiculo-nuevo').classList.remove('oculto');
                // Sugerir kilometraje conocido
                if (_vehiculoSel.kilometraje && !document.getElementById('rec-km').value) {
                    document.getElementById('rec-km').value = _vehiculoSel.kilometraje;
                }
            } else {
                res.innerHTML = `<div class="tll-recep-notfound">Vehículo nuevo — completa sus datos:</div>`;
                _limpiarCamposVehiculo();
                document.getElementById('rec-vehiculo-nuevo').classList.remove('oculto');
            }
        } catch (err) {
            console.error('[Recepción] buscar vehículo:', err);
        }
    }

    function _limpiarCamposCliente() {
        ['rec-cli-nombre','rec-cli-telefono','rec-cli-email'].forEach(id =>
            document.getElementById(id).value = '');
        document.getElementById('rec-cli-tipo').value = 'persona';
    }

    function _limpiarCamposVehiculo() {
        ['rec-veh-marca','rec-veh-modelo','rec-veh-anio','rec-veh-color'].forEach(id =>
            document.getElementById(id).value = '');
    }

    // ── Derivar: presupuesto u orden de trabajo ───────────────────
    async function _derivar(estadoInicial) {
        const motivo = document.getElementById('rec-motivo').value.trim();
        if (!motivo) { avisar('Describe qué necesita el cliente', 'error'); return; }

        // ── Validar cliente (nuevo o habitual: los campos siempre mandan) ──
        const rut = normalizarRut(document.getElementById('rec-rut').value);
        if (rut && !validarRutChileno(rut)) { avisar('El RUT del cliente es inválido', 'error'); return; }

        const cliNombre   = document.getElementById('rec-cli-nombre').value.trim();
        const cliTelefono = document.getElementById('rec-cli-telefono').value.trim();
        const cliEmail    = document.getElementById('rec-cli-email').value.trim();

        if (!cliNombre) { avisar('Ingresa el nombre del cliente (o su RUT si es habitual)', 'error'); return; }
        if (cliTelefono && !validarTelefono(cliTelefono)) { avisar('El teléfono es inválido (8 o 9 dígitos)', 'error'); return; }
        if (cliEmail && !validarEmail(cliEmail)) { avisar('El email tiene formato inválido', 'error'); return; }

        // ── Validar / resolver vehículo ──
        const patente = normalizarPatente(document.getElementById('rec-patente').value);
        if (!patente || patente.length < 5) { avisar('Ingresa la patente del vehículo', 'error'); return; }

        const btnP = document.getElementById('rec-btn-presupuesto');
        const btnO = document.getElementById('rec-btn-orden');
        btnP.disabled = btnO.disabled = true;

        try {
            const eid = window.appData.usuario.empresa_id;

            // 0. La patente existe pero pertenece a otro cliente: nunca mezclar
            //    (OT del cliente A sobre el vehículo de B). Pedir confirmación.
            if (_vehiculoSel && _vehiculoSel.cliente_id && _vehiculoSel.cliente_id !== _clienteSel?.id) {
                const dueno = _vehiculoSel.taller_clientes?.nombre || 'otro cliente';
                const ok = confirm(
                    `La patente ${patente} está registrada a nombre de ${dueno}.\n\n` +
                    `¿Traspasar el vehículo a ${cliNombre}?`);
                if (!ok) {
                    avisar('Recepción cancelada — corrige el RUT o la patente', 'error');
                    btnP.disabled = btnO.disabled = false;
                    return;
                }
            }

            // 1. Crear cliente si es nuevo, o actualizar sus datos si cambiaron
            const datosCliente = {
                nombre: cliNombre,
                telefono: cliTelefono || null,
                email: cliEmail || null,
                tipo: document.getElementById('rec-cli-tipo').value
            };
            if (!_clienteSel) {
                const { data: nuevo, error } = await db.from('taller_clientes')
                    .insert({ empresa_id: eid, rut: rut || null, ...datosCliente })
                    .select().single();
                if (error) throw error;
                _clienteSel = nuevo;
            } else {
                const cambio = datosCliente.nombre !== _clienteSel.nombre
                    || datosCliente.telefono !== (_clienteSel.telefono || null)
                    || datosCliente.email !== (_clienteSel.email || null)
                    || datosCliente.tipo !== _clienteSel.tipo;
                if (cambio) {
                    const { error } = await db.from('taller_clientes')
                        .update(datosCliente).eq('id', _clienteSel.id);
                    if (error) throw error;
                }
            }

            // 2. Crear vehículo si es nuevo, o actualizar sus datos si cambiaron
            const km = parseInt(document.getElementById('rec-km').value) || null;
            const datosVehiculo = {
                marca:  document.getElementById('rec-veh-marca').value.trim() || null,
                modelo: document.getElementById('rec-veh-modelo').value.trim() || null,
                anio:   parseInt(document.getElementById('rec-veh-anio').value) || null,
                color:  document.getElementById('rec-veh-color').value.trim() || null
            };
            if (!_vehiculoSel) {
                const { data: nuevoV, error } = await db.from('taller_vehiculos')
                    .insert({ empresa_id: eid, patente, cliente_id: _clienteSel.id,
                              kilometraje: km || 0, ...datosVehiculo })
                    .select().single();
                if (error) throw error;
                _vehiculoSel = nuevoV;
            } else {
                const cambios = { ...datosVehiculo };
                if (_vehiculoSel.cliente_id !== _clienteSel.id) cambios.cliente_id = _clienteSel.id;
                const hayCambio = Object.keys(cambios)
                    .some(k => cambios[k] !== (_vehiculoSel[k] ?? null));
                if (hayCambio) {
                    const { error } = await db.from('taller_vehiculos')
                        .update(cambios).eq('id', _vehiculoSel.id);
                    if (error) throw error;
                    Object.assign(_vehiculoSel, cambios);
                }
            }

            // 3. Si el taller usa el módulo Presupuestos, el botón de
            //    presupuesto crea un documento propio y NO una OT: así
            //    cotizar deja de descontar stock.
            if (estadoInicial === 'presupuesto'
                && moduloHabilitado('presupuestos', window.appData.empresa?.modulos_activos)) {

                const { data: max } = await db.from('taller_presupuestos')
                    .select('numero').eq('empresa_id', eid)
                    .order('numero', { ascending: false }).limit(1);
                const nro = (max?.[0]?.numero || 0) + 1;

                const { data: presup, error: errP } = await db.from('taller_presupuestos').insert({
                    empresa_id:    eid,
                    numero:        nro,
                    version:       1,
                    cliente_id:    _clienteSel.id,
                    vehiculo_id:   _vehiculoSel.id,
                    estado:        'borrador',
                    fecha_emision: new Date().toISOString().slice(0, 10),
                    dias_validez:  15,
                    kilometraje:   km,
                    motivo,
                    usuario_rut:   window.appData.usuario.rut
                }).select().single();
                if (errP) throw errP;

                if (km) {
                    await db.from('taller_vehiculos').update({ kilometraje: km }).eq('id', _vehiculoSel.id);
                }

                avisar(`Presupuesto N° ${nro} creado — agrégale los ítems`);
                init();
                await ModuloPresupuestos.abrirPorId(presup.id);
                return;
            }

            // 4. Correlativo + orden
            const { data: numero, error: errNum } = await db.rpc('fn_taller_siguiente_numero', {
                p_empresa_id: eid, p_tipo: 'orden'
            });
            if (errNum) throw errNum;

            const { data: orden, error: errOrd } = await db.from('taller_ordenes').insert({
                empresa_id: eid,
                numero,
                cliente_id: _clienteSel.id,
                vehiculo_id: _vehiculoSel.id,
                estado: estadoInicial,
                kilometraje_ingreso: km,
                nivel_combustible: document.getElementById('rec-combustible').value || null,
                motivo_ingreso: motivo,
                usuario_creacion: window.appData.usuario.rut
            }).select().single();
            if (errOrd) throw errOrd;

            // 5. Actualizar kilometraje vivo del vehículo
            if (km) {
                await db.from('taller_vehiculos').update({ kilometraje: km }).eq('id', _vehiculoSel.id);
            }

            avisar(estadoInicial === 'presupuesto'
                ? `Presupuesto N° ${numero} creado — agrégale los ítems`
                : `Vehículo recepcionado — OT N° ${numero} creada`);

            // 6. Limpiar el formulario y abrir el detalle para cargar ítems
            init();
            await ModuloOrdenes.abrirPorId(orden.id);

        } catch (err) {
            console.error('[Recepción] derivar:', err);
            avisar('Error al generar. Revisa la consola.', 'error');
            btnP.disabled = btnO.disabled = false;
        }
    }

    return { init };

})();
