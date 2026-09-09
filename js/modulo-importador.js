// ================================================================
// modulo-importador.js — Importar clientes y vehículos desde CSV
// ----------------------------------------------------------------
// Para migrar un taller que viene de otro sistema (o de una planilla).
// Lee un CSV, deja mapear las columnas, revisa contra lo que ya existe
// y crea solo lo nuevo. Nada se pisa: los duplicados se omiten.
//
// Solo rol admin (panel-importador en ROL_MODULOS).
// ================================================================

const ModuloImportador = (() => {

    let _tipo     = 'ambos';     // 'clientes' | 'vehiculos' | 'ambos'
    let _headers  = [];
    let _filas    = [];          // array de objetos {header: valor}
    let _map      = {};          // campo destino -> header del CSV
    let _analisis = null;

    // Campos destino por tipo
    const CAMPOS = {
        clientes: [
            ['rut',        'RUT',            false],
            ['nombre',     'Nombre',         true ],
            ['telefono',   'Teléfono',       false],
            ['email',      'Email',          false],
            ['direccion',  'Dirección',      false],
            ['tipo',       'Tipo (persona/empresa)', false],
        ],
        vehiculos: [
            ['patente',       'Patente',            true ],
            ['marca',         'Marca',              false],
            ['modelo',        'Modelo',             false],
            ['anio',          'Año',                false],
            ['color',         'Color',              false],
            ['kilometraje',   'Kilometraje',        false],
            ['vin',           'VIN / N° chasis',    false],
            ['observaciones', 'Observaciones',      false],
            ['cliente_ref',   'RUT o nombre del dueño', false],
        ],
    };

    const ALIAS = {
        rut:          ['rut', 'run', 'r.u.t', 'rut cliente'],
        nombre:       ['nombre', 'cliente', 'nombre cliente', 'nombre completo', 'razon social', 'nombres'],
        telefono:     ['telefono', 'fono', 'celular', 'movil', 'contacto', 'whatsapp', 'numero', 'telefono 1'],
        email:        ['email', 'correo', 'e mail', 'mail', 'correo electronico'],
        direccion:    ['direccion', 'domicilio', 'calle', 'ubicacion'],
        tipo:         ['tipo', 'tipo cliente', 'persona empresa'],
        patente:      ['patente', 'ppu', 'placa', 'placa patente', 'matricula'],
        marca:        ['marca', 'fabricante'],
        modelo:       ['modelo'],
        anio:         ['anio', 'ano', 'year', 'ano fab', 'ano fabricacion', 'modelo ano'],
        color:        ['color'],
        kilometraje:  ['kilometraje', 'km', 'kms', 'kilometros', 'odometro', 'mileage'],
        vin:          ['vin', 'chasis', 'n chasis', 'numero de chasis', 'serie', 'nro chasis'],
        observaciones:['observaciones', 'obs', 'notas', 'comentarios', 'nota', 'detalle'],
        cliente_ref:  ['rut', 'run', 'cliente', 'nombre cliente', 'dueno', 'propietario', 'rut cliente'],
    };

    // ── init ──────────────────────────────────────────────────────
    function init() {
        const cont = document.getElementById('contenido-importador');
        if (!cont) return;
        _reset();

        cont.innerHTML = `
        <div class="imp">
          <div class="tll-rep-card">
            <h3 style="margin:0 0 4px">1 · ¿Qué vas a importar?</h3>
            <p class="tll-rep-nota" style="margin:0 0 12px">
              Un archivo <strong>.csv</strong> (Excel → "Guardar como CSV").
              Acepta separador coma o punto y coma.</p>
            <div class="tll-tabs" id="imp-tipo">
              <button class="tll-tab" data-t="clientes">Solo clientes</button>
              <button class="tll-tab" data-t="vehiculos">Solo vehículos</button>
              <button class="tll-tab is-activo" data-t="ambos">Clientes + vehículos</button>
            </div>
            <p style="margin:12px 0 0">
              <a href="#" class="tll-link" id="imp-plantilla">↓ Descargar plantilla de ejemplo</a>
            </p>
          </div>

          <div class="tll-rep-card">
            <h3 style="margin:0 0 12px">2 · Sube el archivo</h3>
            <div class="imp-drop" id="imp-drop">
              <input type="file" id="imp-file" accept=".csv,text/csv" hidden>
              <p>Arrastra el CSV aquí o <button class="tll-btn tll-btn--ghost" id="imp-pick">elígelo</button></p>
              <p class="tll-rep-nota">o pega el contenido:</p>
              <textarea class="tll-textarea" id="imp-paste" rows="4"
                placeholder="rut,nombre,telefono,patente,marca,modelo&#10;12345678-9,Juan Pérez,+56912345678,ABCD12,Toyota,Yaris"></textarea>
              <button class="tll-btn tll-btn--ghost" id="imp-leer-paste" style="margin-top:8px">Leer texto pegado</button>
            </div>
          </div>

          <div id="imp-paso3"></div>
          <div id="imp-paso4"></div>
          <div id="imp-paso5"></div>
        </div>`;

        _inyectarCss();

        cont.querySelectorAll('#imp-tipo .tll-tab').forEach(b =>
            b.addEventListener('click', () => {
                _tipo = b.dataset.t;
                cont.querySelectorAll('#imp-tipo .tll-tab').forEach(x => x.classList.toggle('is-activo', x === b));
                if (_filas.length) _renderMapeo();   // re-mapear con los campos nuevos
            }));

        document.getElementById('imp-plantilla').addEventListener('click', e => { e.preventDefault(); _descargarPlantilla(); });
        document.getElementById('imp-pick').addEventListener('click', () => document.getElementById('imp-file').click());
        document.getElementById('imp-file').addEventListener('change', e => {
            const f = e.target.files[0];
            if (f) f.text().then(_cargarTexto);
        });
        document.getElementById('imp-leer-paste').addEventListener('click', () => {
            const t = document.getElementById('imp-paste').value;
            if (t.trim()) _cargarTexto(t);
        });

        const drop = document.getElementById('imp-drop');
        ['dragover', 'dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
            e.preventDefault();
            drop.classList.toggle('imp-drop--over', ev === 'dragover');
            if (ev === 'drop' && e.dataTransfer.files[0]) e.dataTransfer.files[0].text().then(_cargarTexto);
        }));
    }

    function _reset() {
        _headers = []; _filas = []; _map = {}; _analisis = null;
    }

    // ── Parseo de CSV ─────────────────────────────────────────────
    function _parseCSV(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // BOM de Excel
        const cabecera = text.slice(0, (text.indexOf('\n') + 1) || text.length);
        const cont = ch => (cabecera.split(ch).length - 1);
        const delim = [[',', cont(',')], [';', cont(';')], ['\t', cont('\t')]]
            .sort((a, b) => b[1] - a[1])[0][0] || ',';

        const filas = [];
        let fila = [], campo = '', enComillas = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (enComillas) {
                if (c === '"' && text[i + 1] === '"') { campo += '"'; i++; }
                else if (c === '"') enComillas = false;
                else campo += c;
            } else {
                if (c === '"') enComillas = true;
                else if (c === delim) { fila.push(campo); campo = ''; }
                else if (c === '\r') { /* nada */ }
                else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
                else campo += c;
            }
        }
        if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }
        return filas.filter(r => r.some(v => (v || '').trim() !== ''));
    }

    function _cargarTexto(text) {
        const filas = _parseCSV(text);
        if (filas.length < 2) {
            avisar('El archivo no tiene datos (necesita una fila de títulos y al menos una fila más).', 'error');
            return;
        }
        _headers = filas[0].map(h => (h || '').trim());
        _filas = filas.slice(1).map(r => {
            const o = {};
            _headers.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
            return o;
        });
        _analisis = null;
        document.getElementById('imp-paso4').innerHTML = '';
        document.getElementById('imp-paso5').innerHTML = '';
        _renderMapeo();
    }

    // ── Paso 3: mapeo de columnas ─────────────────────────────────
    const _norm = s => (s || '').toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9]+/g, ' ').trim();

    function _adivinar(campo) {
        const alias = (ALIAS[campo] || [campo]).map(_norm);
        const hn = _headers.map(h => ({ h, n: _norm(h) }));
        let hit = hn.find(x => alias.includes(x.n));
        if (!hit) hit = hn.find(x => alias.some(a => x.n.includes(a) || a.includes(x.n)));
        return hit ? hit.h : '';
    }

    function _camposActivos() {
        if (_tipo === 'clientes') return CAMPOS.clientes;
        if (_tipo === 'vehiculos') return CAMPOS.vehiculos;
        return [...CAMPOS.clientes, ...CAMPOS.vehiculos.filter(c => c[0] !== 'cliente_ref')];
    }

    function _opciones(sel) {
        return ['<option value="">— ninguna —</option>',
            ..._headers.map(h => `<option value="${esc(h)}"${h === sel ? ' selected' : ''}>${esc(h)}</option>`)].join('');
    }

    function _renderMapeo() {
        const campos = _camposActivos();
        _map = {};
        campos.forEach(([f]) => { _map[f] = _adivinar(f); });

        document.getElementById('imp-paso3').innerHTML = `
        <div class="tll-rep-card">
          <h3 style="margin:0 0 4px">3 · Relaciona las columnas</h3>
          <p class="tll-rep-nota" style="margin:0 0 12px">
            ${_filas.length} fila${_filas.length === 1 ? '' : 's'} leída${_filas.length === 1 ? '' : 's'}.
            Revisa que cada dato apunte a la columna correcta.</p>
          <div class="imp-map">
            ${campos.map(([f, label, req]) => `
              <label class="imp-map-row">
                <span>${label}${req ? ' <b style="color:var(--rojo,#dc2626)">*</b>' : ''}</span>
                <select class="tll-select" data-campo="${f}">${_opciones(_map[f])}</select>
              </label>`).join('')}
          </div>
          <div id="imp-preview" class="tll-tabla-wrap" style="margin-top:14px"></div>
          <button class="tll-btn tll-btn--primary" id="imp-analizar" style="margin-top:12px">Analizar</button>
        </div>`;

        document.querySelectorAll('#imp-paso3 select[data-campo]').forEach(s =>
            s.addEventListener('change', () => { _map[s.dataset.campo] = s.value; _renderPreview(); }));
        document.getElementById('imp-analizar').addEventListener('click', _analizar);
        _renderPreview();
    }

    function _renderPreview() {
        const campos = _camposActivos().filter(([f]) => _map[f]);
        const cont = document.getElementById('imp-preview');
        if (!cont) return;
        const muestra = _filas.slice(0, 5);
        cont.innerHTML = `
        <table class="tll-tabla">
          <thead><tr>${campos.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
          <tbody>
            ${muestra.map(r => `<tr>${campos.map(([f]) => `<td>${esc(r[_map[f]] || '')}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
        ${_filas.length > 5 ? `<p class="tll-rep-nota">… y ${_filas.length - 5} más</p>` : ''}`;
    }

    // ── Paso 4: análisis ─────────────────────────────────────────
    const _val = (r, f) => (_map[f] ? (r[_map[f]] || '').trim() : '');
    const _anioOk = v => { const n = parseInt(v, 10); return n >= 1900 && n <= new Date().getFullYear() + 1 ? n : null; };
    const _kmOk = v => { const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n >= 0 ? n : null; };

    async function _analizar() {
        const btn = document.getElementById('imp-analizar');
        btn.disabled = true; btn.textContent = 'Analizando…';
        try {
            const eid = window.appData.usuario.empresa_id;
            const [cRes, vRes] = await Promise.all([
                (_tipo !== 'vehiculos')
                    ? db.from('taller_clientes').select('id,rut,nombre').eq('empresa_id', eid).limit(20000)
                    : Promise.resolve({ data: [] }),
                (_tipo !== 'clientes')
                    ? db.from('taller_vehiculos').select('patente_norm').eq('empresa_id', eid).limit(20000)
                    : Promise.resolve({ data: [] }),
            ]);
            if (cRes.error) throw cRes.error;
            if (vRes.error) throw vRes.error;

            const rutToId = new Map();
            const nombreToId = new Map();
            (cRes.data || []).forEach(c => {
                if (c.rut) rutToId.set(normalizarRut(c.rut), c.id);
                nombreToId.set(_norm(c.nombre), c.id);
            });
            const patentesBD = new Set((vRes.data || []).map(v => v.patente_norm).filter(Boolean));

            const vistosRut = new Set();       // dedupe dentro del archivo
            const vistosNombre = new Set();
            const vistosPat = new Set();

            const filas = _filas.map((r, idx) => {
                const res = { n: idx + 2, cliente: null, vehiculo: null, avisos: [], estado: 'ok' };

                // ── Cliente ──
                if (_tipo !== 'vehiculos') {
                    const nombre = _val(r, 'nombre');
                    if (!nombre) { res.estado = 'error'; res.avisos.push('sin nombre'); }
                    else {
                        const rutRaw = _val(r, 'rut');
                        const rut = rutRaw ? normalizarRut(rutRaw) : '';
                        if (rut && !validarRutChileno(rut)) res.avisos.push('RUT con dígito verificador dudoso');
                        let tipo = _norm(_val(r, 'tipo'));
                        tipo = tipo.startsWith('emp') ? 'empresa' : 'persona';

                        const clave = rut || ('n:' + _norm(nombre));
                        const existeBD = rut ? rutToId.has(rut) : nombreToId.has(_norm(nombre));
                        const dupArchivo = rut ? vistosRut.has(rut) : vistosNombre.has(_norm(nombre));

                        res.cliente = {
                            _clave: clave, _nuevo: !existeBD && !dupArchivo,
                            data: {
                                empresa_id: null, rut: rut || null, nombre,
                                telefono: _val(r, 'telefono') || null,
                                email: _val(r, 'email') || null,
                                direccion: _val(r, 'direccion') || null,
                                tipo,
                            },
                        };
                        if (existeBD) res.avisos.push('cliente ya existe');
                        else if (dupArchivo) res.avisos.push('cliente repetido en el archivo');
                        if (rut) vistosRut.add(rut); else vistosNombre.add(_norm(nombre));
                    }
                }

                // ── Vehículo ──
                if (_tipo !== 'clientes' && res.estado !== 'error') {
                    const patRaw = _val(r, 'patente');
                    const pat = normalizarPatente(patRaw);
                    if (!pat) {
                        if (_tipo === 'vehiculos') { res.estado = 'error'; res.avisos.push('sin patente'); }
                    } else {
                        const existeBD = patentesBD.has(pat);
                        const dupArchivo = vistosPat.has(pat);
                        vistosPat.add(pat);
                        const anioRaw = _val(r, 'anio');
                        const anio = anioRaw ? _anioOk(anioRaw) : null;
                        if (anioRaw && anio === null) res.avisos.push('año ignorado');

                        let refRut = '', refNombre = '';
                        if (_tipo === 'ambos') {
                            refRut = res.cliente?.data.rut || '';
                            refNombre = res.cliente?.data.nombre || '';
                        } else {
                            const ref = _val(r, 'cliente_ref');
                            if (validarRutChileno(normalizarRut(ref))) refRut = normalizarRut(ref);
                            else refNombre = ref;
                        }

                        res.vehiculo = {
                            _nuevo: !existeBD && !dupArchivo,
                            _pat: pat, _refRut: refRut, _refNombre: refNombre, _clienteFila: !!res.cliente,
                            data: {
                                empresa_id: null, cliente_id: null,
                                patente: patRaw.trim().toUpperCase(),
                                marca: _val(r, 'marca') || null,
                                modelo: _val(r, 'modelo') || null,
                                anio,
                                color: _val(r, 'color') || null,
                                kilometraje: _kmOk(_val(r, 'kilometraje')),
                                vin: _val(r, 'vin') || null,
                                observaciones: _val(r, 'observaciones') || null,
                            },
                        };
                        if (existeBD) res.avisos.push('patente ya existe');
                        else if (dupArchivo) res.avisos.push('patente repetida en el archivo');

                        if (_tipo === 'vehiculos' && !refRut && !refNombre) res.avisos.push('sin dueño');
                        else if (_tipo === 'vehiculos') {
                            const found = refRut ? rutToId.get(refRut) : nombreToId.get(_norm(refNombre));
                            if (!found) res.avisos.push('dueño no encontrado — quedará sin cliente');
                        }
                    }
                }

                if (res.estado !== 'error') {
                    const nada = (!res.cliente || !res.cliente._nuevo) && (!res.vehiculo || !res.vehiculo._nuevo);
                    res.estado = nada ? 'omitir' : 'ok';
                }
                return res;
            });

            _analisis = { filas, rutToId, nombreToId };
            _renderAnalisis();
        } catch (err) {
            console.error('[Importador] analizar:', err);
            avisar('No se pudo leer lo que ya existe. ' + (err.message || ''), 'error');
        } finally {
            btn.disabled = false; btn.textContent = 'Analizar';
        }
    }

    function _renderAnalisis() {
        const f = _analisis.filas;
        const cNuevos = f.filter(x => x.cliente?._nuevo).length;
        const vNuevos = f.filter(x => x.vehiculo?._nuevo).length;
        const omit = f.filter(x => x.estado === 'omitir').length;
        const errs = f.filter(x => x.estado === 'error').length;

        document.getElementById('imp-paso4').innerHTML = `
        <div class="tll-rep-card">
          <h3 style="margin:0 0 12px">4 · Revisión</h3>
          <div class="tll-kpis">
            ${_kpi('👤', cNuevos, 'Clientes nuevos')}
            ${_kpi('🚗', vNuevos, 'Vehículos nuevos')}
            ${_kpi('⏭', omit, 'Se omiten (ya existen)')}
            ${_kpi('⚠', errs, 'Con error')}
          </div>
          <div class="tll-tabla-wrap" style="margin-top:12px;max-height:320px;overflow:auto">
            <table class="tll-tabla">
              <thead><tr><th>Fila</th><th>Cliente</th><th>Vehículo</th><th>Estado</th></tr></thead>
              <tbody>
                ${f.map(x => `
                  <tr>
                    <td style="font-family:var(--font-mono)">${x.n}</td>
                    <td>${x.cliente ? esc(x.cliente.data.nombre) : '—'}</td>
                    <td>${x.vehiculo ? esc(x.vehiculo.data.patente) : '—'}</td>
                    <td>${_badge(x)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <button class="tll-btn tll-btn--primary" id="imp-importar" style="margin-top:14px"
            ${(cNuevos + vNuevos) === 0 ? 'disabled' : ''}>
            Importar ${cNuevos + vNuevos} registro${(cNuevos + vNuevos) === 1 ? '' : 's'}
          </button>
        </div>`;

        document.getElementById('imp-importar').addEventListener('click', _importar);
        document.getElementById('imp-paso4').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function _badge(x) {
        const av = x.avisos.length ? ` <span class="tll-rep-nota">(${x.avisos.map(esc).join(', ')})</span>` : '';
        if (x.estado === 'error')  return `<span class="tll-badge" style="background:#fee2e2;color:#b91c1c">Error</span>${av}`;
        if (x.estado === 'omitir') return `<span class="tll-badge" style="background:#f3f4f6;color:#6b7280">Se omite</span>${av}`;
        return `<span class="tll-badge" style="background:#dcfce7;color:#15803d">Se crea</span>${av}`;
    }

    // ── Paso 5: importar ─────────────────────────────────────────
    async function _importar() {
        const btn = document.getElementById('imp-importar');
        btn.disabled = true; btn.textContent = 'Importando…';
        const eid = window.appData.usuario.empresa_id;
        const { filas, rutToId, nombreToId } = _analisis;
        const errores = [];
        let clientesOk = 0, vehiculosOk = 0;

        try {
            // 1) Clientes nuevos (deduplicados por _clave)
            const nuevosCli = [];
            const yaEnLote = new Set();
            filas.forEach(x => {
                if (x.cliente?._nuevo && !yaEnLote.has(x.cliente._clave)) {
                    yaEnLote.add(x.cliente._clave);
                    nuevosCli.push({ fila: x.n, clave: x.cliente._clave, data: { ...x.cliente.data, empresa_id: eid } });
                }
            });

            for (const lote of _lotes(nuevosCli, 100)) {
                const ins = await _insertar('taller_clientes', lote.map(l => l.data), 'id,rut,nombre');
                lote.forEach((l, i) => {
                    const r = ins[i];
                    if (r && r.error) errores.push({ fila: l.fila, que: 'cliente', motivo: r.error });
                    else if (r && r.row) {
                        clientesOk++;
                        if (r.row.rut) rutToId.set(normalizarRut(r.row.rut), r.row.id);
                        nombreToId.set(_norm(r.row.nombre), r.row.id);
                    }
                });
            }

            // 2) Vehículos nuevos — resolver cliente_id
            const nuevosVeh = [];
            filas.forEach(x => {
                if (!x.vehiculo?._nuevo) return;
                let cid = null;
                if (x.cliente) {
                    cid = x.cliente.data.rut ? rutToId.get(normalizarRut(x.cliente.data.rut))
                                             : nombreToId.get(_norm(x.cliente.data.nombre));
                } else if (x.vehiculo._refRut) cid = rutToId.get(x.vehiculo._refRut);
                else if (x.vehiculo._refNombre) cid = nombreToId.get(_norm(x.vehiculo._refNombre));
                nuevosVeh.push({ fila: x.n, data: { ...x.vehiculo.data, empresa_id: eid, cliente_id: cid || null } });
            });

            for (const lote of _lotes(nuevosVeh, 100)) {
                const ins = await _insertar('taller_vehiculos', lote.map(l => l.data), 'id');
                lote.forEach((l, i) => {
                    const r = ins[i];
                    if (r && r.error) errores.push({ fila: l.fila, que: 'vehículo', motivo: r.error });
                    else vehiculosOk++;
                });
            }

            _renderResultado(clientesOk, vehiculosOk, errores);
        } catch (err) {
            console.error('[Importador] importar:', err);
            avisar('Falló la importación. ' + (err.message || 'Revisa la consola.'), 'error');
            btn.disabled = false; btn.textContent = 'Reintentar';
        }
    }

    /** Inserta un lote; si el lote falla, reintenta fila por fila para aislar el problema.
     *  Devuelve un array alineado con `filas`: { row } | { error }. */
    async function _insertar(tabla, filas, select) {
        if (!filas.length) return [];
        const { data, error } = await db.from(tabla).insert(filas).select(select);
        if (!error) return filas.map((_, i) => ({ row: (data || [])[i] || null }));

        const salida = [];
        for (const f of filas) {
            const r = await db.from(tabla).insert(f).select(select).single();
            salida.push(r.error ? { error: _motivo(r.error) } : { row: r.data });
        }
        return salida;
    }

    function _motivo(err) {
        const m = (err.message || '').toLowerCase();
        if (m.includes('_rut_key') || m.includes('_patente_key') || m.includes('duplicate')) return 'ya existía';
        if (m.includes('violates check')) return 'valor no válido para un campo';
        if (m.includes('null value')) return 'falta un dato obligatorio';
        return err.message || 'error desconocido';
    }

    function _renderResultado(cOk, vOk, errores) {
        document.getElementById('imp-paso5').innerHTML = `
        <div class="tll-rep-card">
          <h3 style="margin:0 0 12px">✓ Listo</h3>
          <p style="margin:0 0 6px"><strong>${cOk}</strong> cliente${cOk === 1 ? '' : 's'} y
             <strong>${vOk}</strong> vehículo${vOk === 1 ? '' : 's'} importados.</p>
          ${errores.length ? `
            <p class="tll-rep-nota" style="margin:0 0 8px">
              ${errores.length} fila${errores.length === 1 ? '' : 's'} no se pudo${errores.length === 1 ? '' : 'ieron'} crear:</p>
            <div class="tll-tabla-wrap" style="max-height:220px;overflow:auto">
              <table class="tll-tabla"><thead><tr><th>Fila</th><th>Qué</th><th>Motivo</th></tr></thead>
              <tbody>${errores.map(e => `<tr><td>${e.fila}</td><td>${esc(e.que)}</td><td>${esc(e.motivo)}</td></tr>`).join('')}</tbody></table>
            </div>
            <button class="tll-btn tll-btn--ghost" id="imp-dl-err" style="margin-top:10px">↓ Descargar errores (CSV)</button>
          ` : '<p class="tll-rep-nota">Sin errores.</p>'}
          <div style="margin-top:14px">
            <button class="tll-btn tll-btn--primary" id="imp-otra">Importar otro archivo</button>
          </div>
        </div>`;

        document.getElementById('imp-otra').addEventListener('click', init);
        document.getElementById('imp-dl-err')?.addEventListener('click', () =>
            _descargar('errores-importacion.csv',
                'fila,que,motivo\n' + errores.map(e => `${e.fila},${e.que},"${(e.motivo || '').replace(/"/g, '""')}"`).join('\n')));

        avisar(`Importados ${cOk + vOk} registros`);
        document.getElementById('imp-paso5').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ── Helpers ──────────────────────────────────────────────────
    function* _lotes(arr, n) { for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n); }

    function _kpi(icono, valor, label) {
        return `<div class="tll-kpi"><div class="tll-kpi-icono">${icono}</div>
            <div><div class="tll-kpi-valor">${esc(String(valor))}</div>
            <div class="tll-kpi-label">${esc(label)}</div></div></div>`;
    }

    function _descargar(nombre, contenido) {
        const blob = new Blob([String.fromCharCode(0xFEFF) + contenido], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = nombre;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    }

    function _descargarPlantilla() {
        const P = {
            clientes: ['rut,nombre,telefono,email,direccion,tipo',
                       '12.345.678-9,Juan Pérez,+56 9 1234 5678,juan@correo.cl,Av. Siempre Viva 123,persona',
                       '76.543.210-K,Transportes Ltda,+56 2 2345 6789,contacto@transportes.cl,Camino Industrial 45,empresa'],
            vehiculos: ['patente,marca,modelo,anio,color,kilometraje,vin,observaciones,rut_dueno',
                        'ABCD12,Toyota,Yaris,2019,Gris,84500,9BWZZZ377VT004251,Mantención al día,12.345.678-9',
                        'GHIJ34,Nissan,V16,2008,Blanco,210000,,Cambiar correa,76.543.210-K'],
            ambos: ['rut,nombre,telefono,email,patente,marca,modelo,anio,color,kilometraje',
                    '12.345.678-9,Juan Pérez,+56 9 1234 5678,juan@correo.cl,ABCD12,Toyota,Yaris,2019,Gris,84500',
                    '12.345.678-9,Juan Pérez,+56 9 1234 5678,juan@correo.cl,WXYZ99,Honda,Civic,2015,Negro,120000'],
        };
        _descargar(`plantilla-${_tipo}.csv`, P[_tipo].join('\n'));
    }

    function _inyectarCss() {
        if (document.getElementById('imp-css')) return;
        const s = document.createElement('style');
        s.id = 'imp-css';
        s.textContent = `
        .imp{display:flex;flex-direction:column;gap:16px;max-width:820px}
        .imp .tll-rep-card{padding:18px}
        .imp-drop{border:2px dashed var(--borde,#d1d5db);border-radius:10px;padding:18px;text-align:center}
        .imp-drop--over{border-color:var(--acento,#2563eb);background:rgba(37,99,235,.05)}
        .imp-drop p{margin:6px 0}
        .imp-map{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        @media(max-width:640px){.imp-map{grid-template-columns:1fr}}
        .imp-map-row{display:flex;flex-direction:column;gap:4px;font-size:.85rem;color:var(--txt-2,#6b7280)}
        .imp-map-row .tll-select{width:100%}`;
        document.head.appendChild(s);
    }

    return { init };

})();
