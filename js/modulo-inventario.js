// ================================================================
// modulo-inventario.js — Repuestos y bodega
// ================================================================
// El stock NUNCA se edita con un UPDATE directo: toda variación pasa
// por una RPC que bloquea la fila y deja el movimiento en el kardex
// (ver sql/02_inventario.sql).
//
//   Entrada  → fn_entrada_stock_repuesto   (recalcula costo promedio)
//   Ajuste   → fn_ajustar_stock_repuesto   (toma física, mermas)
//   Salida   → fn_descontar_stock_repuesto (la usan Órdenes y Ventas)
// ================================================================

const ModuloInventario = (() => {

    let _repuestos = [];
    let _editando  = null;
    let _filtro    = 'activos';

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-inventario');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-kpis" id="inv-kpis"></div>
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="inv-nuevo">+ Nuevo repuesto</button>
                <select class="tll-select" id="inv-filtro" style="max-width:190px">
                    <option value="activos">Activos</option>
                    <option value="bajo_minimo">Bajo mínimo</option>
                    <option value="sin_stock">Sin stock</option>
                    <option value="inactivos">Inactivos</option>
                    <option value="todos">Todos</option>
                </select>
                <input class="tll-input" id="inv-buscar" placeholder="Buscar por código, nombre, marca o ubicación…">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="inv-reload">↻ Actualizar</button>
            </div>
            <div id="inv-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('inv-nuevo').addEventListener('click', () => _abrirForm(null));
        document.getElementById('inv-reload').addEventListener('click', recargar);
        document.getElementById('inv-buscar').addEventListener('input', _renderLista);
        document.getElementById('inv-filtro').addEventListener('change', (e) => {
            _filtro = e.target.value;
            _renderLista();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const { data, error } = await db
                .from('taller_repuestos')
                .select('*')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .order('nombre')
                .range(0, 4999);
            if (error) throw error;

            _repuestos = data || [];
            _renderKpis();
            _renderLista();
        } catch (err) {
            console.error('[Inventario] cargar:', err);
            avisar('Error cargando el inventario', 'error');
        }
    }

    // ── KPIs ──────────────────────────────────────────────────────
    function _renderKpis() {
        const cont = document.getElementById('inv-kpis');
        if (!cont) return;

        const activos = _repuestos.filter(r => r.activo);
        const valor   = activos.reduce((s, r) => s + _num(r.stock) * _num(r.precio_costo), 0);
        const bajos   = activos.filter(_bajoMinimo).length;
        const sin     = activos.filter(r => _num(r.stock) <= 0).length;

        cont.innerHTML = `
            ${_kpi('📦', activos.length, 'Repuestos activos')}
            ${_kpi('💲', fmtCLP(valor), 'Valor de inventario')}
            ${_kpi('⚠️', bajos, 'Bajo el mínimo')}
            ${_kpi('🚫', sin, 'Sin stock')}`;
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('inv-lista');
        if (!cont) return;

        const q = (document.getElementById('inv-buscar')?.value || '').toLowerCase().trim();

        let filtrados = _repuestos.filter(r => {
            switch (_filtro) {
                case 'activos':     return r.activo;
                case 'inactivos':   return !r.activo;
                case 'bajo_minimo': return r.activo && _bajoMinimo(r);
                case 'sin_stock':   return r.activo && _num(r.stock) <= 0;
                default:            return true;
            }
        });

        if (q) {
            filtrados = filtrados.filter(r =>
                (r.codigo || '').toLowerCase().includes(q) ||
                (r.nombre || '').toLowerCase().includes(q) ||
                (r.marca || '').toLowerCase().includes(q) ||
                (r.categoria || '').toLowerCase().includes(q) ||
                (r.codigo_oem || '').toLowerCase().includes(q) ||
                (r.ubicacion || '').toLowerCase().includes(q));
        }

        if (filtrados.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_repuestos.length === 0
                    ? 'Sin repuestos en el catálogo. Crea el primero con <strong>+ Nuevo repuesto</strong>.'
                    : 'Sin resultados para ese filtro o búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Código</th><th>Repuesto</th><th>Ubicación</th>
                <th style="text-align:right">Stock</th>
                <th style="text-align:right">Costo</th>
                <th style="text-align:right">Venta</th>
                <th style="text-align:right">Margen</th>
                <th></th>
            </tr></thead>
            <tbody>
            ${filtrados.map(r => `
                <tr${r.activo ? '' : ' style="opacity:0.5"'}>
                    <td style="font-family:var(--font-mono)"><strong>${esc(r.codigo)}</strong>
                        ${r.codigo_oem ? `<div style="font-size:0.7rem;color:var(--text-muted)">OEM ${esc(r.codigo_oem)}</div>` : ''}</td>
                    <td>${esc(r.nombre)}
                        ${r.marca || r.categoria ? `<div style="font-size:0.72rem;color:var(--text-secondary)">
                            ${esc([r.marca, r.categoria].filter(Boolean).join(' · '))}</div>` : ''}</td>
                    <td style="font-family:var(--font-mono);font-size:0.78rem">${esc(r.ubicacion) || '—'}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        ${_badgeStock(r)}
                        <div style="font-size:0.68rem;color:var(--text-muted)">mín ${_fmtCant(r.stock_minimo)}</div></td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(r.precio_costo)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(r.precio_venta)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${_margen(r)}</td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="tll-btn tll-btn--ghost inv-entrada" data-id="${r.id}">Entrada</button>
                        <button class="tll-btn tll-btn--ghost inv-ajuste"  data-id="${r.id}">Ajustar</button>
                        <button class="tll-btn tll-btn--ghost inv-kardex"  data-id="${r.id}">Kardex</button>
                        <button class="tll-btn tll-btn--ghost inv-editar"  data-id="${r.id}">Editar</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

        const porId = (btn) => _repuestos.find(r => r.id === btn.dataset.id);
        cont.querySelectorAll('.inv-editar') .forEach(b => b.addEventListener('click', () => _abrirForm(porId(b))));
        cont.querySelectorAll('.inv-entrada').forEach(b => b.addEventListener('click', () => _abrirEntrada(porId(b))));
        cont.querySelectorAll('.inv-ajuste') .forEach(b => b.addEventListener('click', () => _abrirAjuste(porId(b))));
        cont.querySelectorAll('.inv-kardex') .forEach(b => b.addEventListener('click', () => _abrirKardex(porId(b))));
    }

    // ── Formulario de repuesto ────────────────────────────────────
    function _abrirForm(rep) {
        _editando = rep;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${rep ? 'Editar ' + esc(rep.codigo) : 'Nuevo repuesto'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Código interno *</label>
                <input class="tll-input" id="inv-f-codigo" style="font-family:var(--font-mono)"
                       value="${esc(rep?.codigo || '')}" ${rep ? 'disabled' : ''}>
                ${rep ? '<span class="tll-field-msg">El código es la llave del kardex: no se cambia.</span>' : ''}
            </div>
            <div class="tll-field">
                <label>Código OEM / equivalencia</label>
                <input class="tll-input" id="inv-f-oem" style="font-family:var(--font-mono)"
                       value="${esc(rep?.codigo_oem || '')}">
            </div>
            <div class="tll-field tll-field--full">
                <label>Nombre *</label>
                <input class="tll-input" id="inv-f-nombre" placeholder="Filtro de aceite motor 1.5"
                       value="${esc(rep?.nombre || '')}">
            </div>
            <div class="tll-field">
                <label>Marca</label>
                <input class="tll-input" id="inv-f-marca" value="${esc(rep?.marca || '')}">
            </div>
            <div class="tll-field">
                <label>Categoría</label>
                <input class="tll-input" id="inv-f-categoria" placeholder="Filtros, frenos, lubricantes…"
                       value="${esc(rep?.categoria || '')}">
            </div>
            <div class="tll-field">
                <label>Unidad</label>
                <select class="tll-select" id="inv-f-unidad">
                    ${['unidad', 'litro', 'kilo', 'metro', 'juego', 'par']
                        .map(u => `<option value="${u}" ${(rep?.unidad || 'unidad') === u ? 'selected' : ''}>${u}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Ubicación en bodega</label>
                <input class="tll-input" id="inv-f-ubicacion" placeholder="Estante B-3"
                       style="font-family:var(--font-mono)" value="${esc(rep?.ubicacion || '')}">
            </div>
            <div class="tll-field">
                <label>Proveedor habitual</label>
                <input class="tll-input" id="inv-f-proveedor" value="${esc(rep?.proveedor || '')}">
            </div>
            <div class="tll-field">
                <label>Stock mínimo</label>
                <input class="tll-input" id="inv-f-minimo" type="number" min="0" step="0.5"
                       value="${rep?.stock_minimo ?? 0}">
            </div>
            <div class="tll-field">
                <label>Precio de costo</label>
                <input class="tll-input" id="inv-f-costo" type="number" min="0" value="${rep?.precio_costo ?? 0}">
                ${rep ? '<span class="tll-field-msg">Lo recalcula cada entrada de mercadería (promedio ponderado).</span>' : ''}
            </div>
            <div class="tll-field">
                <label>Precio de venta *</label>
                <input class="tll-input" id="inv-f-venta" type="number" min="0" value="${rep?.precio_venta ?? 0}">
            </div>
            <div class="tll-field">
                <label>Margen</label>
                <div id="inv-f-margen" style="font-family:var(--font-mono);padding-top:0.45rem">—</div>
            </div>
            ${rep ? '' : `
            <div class="tll-field">
                <label>Stock inicial</label>
                <input class="tll-input" id="inv-f-stock" type="number" min="0" step="0.5" value="0">
            </div>`}
            <div class="tll-field tll-field--full">
                <label>Notas</label>
                <textarea class="tll-textarea" id="inv-f-notas">${esc(rep?.notas || '')}</textarea>
            </div>
            ${rep ? `
            <div class="tll-field">
                <label>Estado</label>
                <select class="tll-select" id="inv-f-activo">
                    <option value="true"  ${rep.activo ? 'selected' : ''}>Activo</option>
                    <option value="false" ${!rep.activo ? 'selected' : ''}>Inactivo</option>
                </select>
            </div>` : ''}
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="inv-guardar">Guardar repuesto</button>
        </div>`, '720px');

        const refrescarMargen = () => {
            const c = _num(document.getElementById('inv-f-costo').value);
            const v = _num(document.getElementById('inv-f-venta').value);
            const el = document.getElementById('inv-f-margen');
            if (v <= 0) { el.textContent = '—'; el.style.color = ''; return; }
            const pct = ((v - c) / v) * 100;
            el.textContent = pct.toFixed(1) + '%';
            el.style.color = pct < 0 ? '#f87171' : pct < 15 ? '#fbbf24' : '#34d399';
        };
        document.getElementById('inv-f-costo').addEventListener('input', refrescarMargen);
        document.getElementById('inv-f-venta').addEventListener('input', refrescarMargen);
        refrescarMargen();

        document.getElementById('inv-guardar').addEventListener('click', _guardar);
    }

    async function _guardar() {
        const nombre = document.getElementById('inv-f-nombre').value.trim();
        if (!nombre) { avisar('El nombre es obligatorio', 'error'); return; }

        let codigo = _editando ? _editando.codigo
                               : document.getElementById('inv-f-codigo').value.trim().toUpperCase();
        if (!codigo) { avisar('El código es obligatorio', 'error'); return; }

        const venta = _num(document.getElementById('inv-f-venta').value);
        const costo = _num(document.getElementById('inv-f-costo').value);
        if (venta > 0 && costo > venta &&
            !confirm('El precio de venta es menor que el costo: venderías con pérdida.\n\n¿Guardar igual?')) return;

        const fila = {
            empresa_id:   window.appData.usuario.empresa_id,
            codigo,
            nombre,
            codigo_oem:   document.getElementById('inv-f-oem').value.trim() || null,
            marca:        document.getElementById('inv-f-marca').value.trim() || null,
            categoria:    document.getElementById('inv-f-categoria').value.trim() || null,
            unidad:       document.getElementById('inv-f-unidad').value,
            ubicacion:    document.getElementById('inv-f-ubicacion').value.trim() || null,
            proveedor:    document.getElementById('inv-f-proveedor').value.trim() || null,
            stock_minimo: _num(document.getElementById('inv-f-minimo').value),
            precio_costo: costo,
            precio_venta: venta,
            notas:        document.getElementById('inv-f-notas').value.trim() || null
        };

        const btn = document.getElementById('inv-guardar');
        btn.disabled = true;

        try {
            if (_editando) {
                fila.activo = document.getElementById('inv-f-activo').value === 'true';
                // Ojo: 'stock' no va aquí a propósito — solo lo mueven las RPC.
                const { error } = await db.from('taller_repuestos')
                    .update(fila).eq('id', _editando.id);
                if (error) throw error;
                avisar('Repuesto actualizado');
            } else {
                const stockInicial = _num(document.getElementById('inv-f-stock').value);
                const { error } = await db.from('taller_repuestos')
                    .insert({ ...fila, stock: 0, activo: true });
                if (error) throw error;

                // El stock inicial entra como movimiento, para que el kardex
                // arranque cuadrado desde el primer día.
                if (stockInicial > 0) {
                    const res = await _rpc('fn_entrada_stock_repuesto', {
                        p_empresa_id: fila.empresa_id,
                        p_codigo: codigo,
                        p_cantidad: stockInicial,
                        p_costo_unitario: costo,
                        p_motivo: 'inicial',
                        p_referencia: null,
                        p_usuario: window.appData.usuario.rut
                    });
                    if (res && !res.ok) avisar(res.error || 'Repuesto creado, pero sin stock inicial', 'error');
                }
                avisar('Repuesto creado');
            }
            cerrarModal();
            await recargar();
        } catch (err) {
            console.error('[Inventario] guardar:', err);
            btn.disabled = false;
            avisar(err.code === '23505'
                ? `Ya existe un repuesto con el código ${codigo}`
                : 'Error al guardar. Revisa la consola.', 'error');
        }
    }

    // ── Entrada de mercadería ─────────────────────────────────────
    function _abrirEntrada(rep) {
        if (!rep) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Entrada de mercadería · ${esc(rep.codigo)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            <strong>${esc(rep.nombre)}</strong><br>
            Stock actual: <span style="font-family:var(--font-mono)">${_fmtCant(rep.stock)} ${esc(rep.unidad || '')}</span>
            · Costo actual: <span style="font-family:var(--font-mono)">${fmtCLP(rep.precio_costo)}</span>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Cantidad recibida *</label>
                <input class="tll-input" id="inv-e-cantidad" type="number" min="0.5" step="0.5" value="1">
            </div>
            <div class="tll-field">
                <label>Costo unitario de esta compra</label>
                <input class="tll-input" id="inv-e-costo" type="number" min="0" value="${rep.precio_costo ?? 0}">
            </div>
            <div class="tll-field">
                <label>Motivo</label>
                <select class="tll-select" id="inv-e-motivo">
                    <option value="compra">Compra a proveedor</option>
                    <option value="devolucion">Devolución de cliente</option>
                    <option value="inicial">Carga inicial</option>
                </select>
            </div>
            <div class="tll-field">
                <label>Referencia (N° factura / guía)</label>
                <input class="tll-input" id="inv-e-ref" style="font-family:var(--font-mono)">
            </div>
            <div class="tll-field tll-field--full">
                <div class="tll-recep-found" id="inv-e-preview"></div>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="inv-e-confirmar">Registrar entrada</button>
        </div>`);

        const preview = () => {
            const cant  = _num(document.getElementById('inv-e-cantidad').value);
            const costo = _num(document.getElementById('inv-e-costo').value);
            const stockActual = _num(rep.stock);
            const nuevoStock  = stockActual + cant;
            const nuevoCosto  = nuevoStock > 0
                ? Math.round((stockActual * _num(rep.precio_costo) + cant * costo) / nuevoStock)
                : costo;
            document.getElementById('inv-e-preview').innerHTML =
                `Queda en <strong>${_fmtCant(nuevoStock)}</strong> unidades ` +
                `y el costo promedio pasa a <strong>${fmtCLP(nuevoCosto)}</strong>.`;
        };
        document.getElementById('inv-e-cantidad').addEventListener('input', preview);
        document.getElementById('inv-e-costo').addEventListener('input', preview);
        preview();

        document.getElementById('inv-e-confirmar').addEventListener('click', async () => {
            const cantidad = _num(document.getElementById('inv-e-cantidad').value);
            if (cantidad <= 0) { avisar('La cantidad debe ser mayor que cero', 'error'); return; }

            const btn = document.getElementById('inv-e-confirmar');
            btn.disabled = true;

            const res = await _rpc('fn_entrada_stock_repuesto', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_codigo: rep.codigo,
                p_cantidad: cantidad,
                p_costo_unitario: _num(document.getElementById('inv-e-costo').value),
                p_motivo: document.getElementById('inv-e-motivo').value,
                p_referencia: document.getElementById('inv-e-ref').value.trim() || null,
                p_usuario: window.appData.usuario.rut
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo registrar la entrada', 'error'); btn.disabled = false; return; }

            avisar(`Entrada registrada · stock ${_fmtCant(res.stock)}`);
            cerrarModal();
            await recargar();
        });
    }

    // ── Ajuste de inventario ──────────────────────────────────────
    function _abrirAjuste(rep) {
        if (!rep) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Ajustar stock · ${esc(rep.codigo)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="placeholder-text" style="padding:0.8rem 1rem;text-align:left">
            <strong>${esc(rep.nombre)}</strong><br>
            El sistema dice que hay
            <span style="font-family:var(--font-mono)">${_fmtCant(rep.stock)}</span>.
            Ingresa lo que contaste realmente.
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Stock real contado *</label>
                <input class="tll-input" id="inv-a-stock" type="number" min="0" step="0.5"
                       value="${_num(rep.stock)}">
            </div>
            <div class="tll-field">
                <label>Motivo</label>
                <select class="tll-select" id="inv-a-motivo">
                    <option value="inventario">Toma de inventario</option>
                    <option value="merma">Merma / daño</option>
                    <option value="correccion">Corrección de error</option>
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <label>Observación</label>
                <input class="tll-input" id="inv-a-obs" placeholder="Ej: 2 unidades quebradas en bodega">
            </div>
            <div class="tll-field tll-field--full">
                <div class="tll-recep-found" id="inv-a-preview"></div>
            </div>
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="inv-a-confirmar">Registrar ajuste</button>
        </div>`);

        const preview = () => {
            const real = _num(document.getElementById('inv-a-stock').value);
            const dif  = real - _num(rep.stock);
            const el   = document.getElementById('inv-a-preview');
            if (dif === 0) { el.textContent = 'Sin diferencia: no se registrará movimiento.'; return; }
            const valor = Math.abs(dif) * _num(rep.precio_costo);
            el.innerHTML = dif > 0
                ? `Sobran <strong>${_fmtCant(dif)}</strong> unidades (+${fmtCLP(valor)} de inventario).`
                : `Faltan <strong>${_fmtCant(-dif)}</strong> unidades (−${fmtCLP(valor)} de inventario).`;
        };
        document.getElementById('inv-a-stock').addEventListener('input', preview);
        preview();

        document.getElementById('inv-a-confirmar').addEventListener('click', async () => {
            const real = _num(document.getElementById('inv-a-stock').value);
            if (real < 0) { avisar('El stock no puede ser negativo', 'error'); return; }

            const btn = document.getElementById('inv-a-confirmar');
            btn.disabled = true;

            const res = await _rpc('fn_ajustar_stock_repuesto', {
                p_empresa_id: window.appData.usuario.empresa_id,
                p_codigo: rep.codigo,
                p_stock_real: real,
                p_motivo: document.getElementById('inv-a-motivo').value,
                p_observacion: document.getElementById('inv-a-obs').value.trim() || null,
                p_usuario: window.appData.usuario.rut
            });

            if (!res) { btn.disabled = false; return; }
            if (!res.ok) { avisar(res.error || 'No se pudo ajustar', 'error'); btn.disabled = false; return; }

            avisar(res.sin_cambio ? 'Sin diferencia que registrar' : 'Ajuste registrado en el kardex');
            cerrarModal();
            await recargar();
        });
    }

    // ── Kardex ────────────────────────────────────────────────────
    async function _abrirKardex(rep) {
        if (!rep) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Kardex · ${esc(rep.codigo)}
                <span style="color:var(--text-secondary);font-weight:400;font-size:0.85rem">
                    ${esc(rep.nombre)}</span></h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="inv-k-body"><div class="placeholder-text">Cargando movimientos…</div></div>`, '820px');

        try {
            const { data: movs, error } = await db
                .from('taller_movimientos_stock')
                .select('*')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .eq('codigo', rep.codigo)
                .order('created_at', { ascending: false })
                .limit(200);
            if (error) throw error;

            const body = document.getElementById('inv-k-body');
            if (!body) return;

            if (!movs || movs.length === 0) {
                body.innerHTML = `<div class="placeholder-text">
                    Sin movimientos registrados para este repuesto.</div>`;
                return;
            }

            const SIGNO = { entrada: '+', salida: '−', ajuste: '±' };

            body.innerHTML = `
            <table class="tll-tabla">
                <thead><tr>
                    <th>Fecha</th><th>Tipo</th><th>Motivo</th>
                    <th style="text-align:right">Cantidad</th>
                    <th style="text-align:right">Queda</th>
                    <th>Referencia</th><th>Usuario</th>
                </tr></thead>
                <tbody>
                ${movs.map(m => `
                    <tr>
                        <td style="white-space:nowrap">${fmtFechaHora(m.created_at)}</td>
                        <td><span class="tll-badge ${m.tipo === 'entrada' ? 'lista'
                                                   : m.tipo === 'salida' ? 'reparacion' : 'diagnostico'}">
                            ${esc(m.tipo)}</span></td>
                        <td>${esc(m.motivo)}
                            ${m.observacion ? `<div style="font-size:0.7rem;color:var(--text-muted)">${esc(m.observacion)}</div>` : ''}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">
                            ${SIGNO[m.tipo] || ''}${_fmtCant(m.cantidad)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${_fmtCant(m.stock_resultante)}</td>
                        <td style="font-family:var(--font-mono);font-size:0.75rem">${esc(m.referencia) || '—'}</td>
                        <td style="font-family:var(--font-mono);font-size:0.75rem">${esc(m.usuario_rut) || '—'}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
        } catch (err) {
            console.error('[Inventario] kardex:', err);
            const body = document.getElementById('inv-k-body');
            if (body) {
                body.innerHTML = _esTablaFaltante(err)
                    ? `<div class="placeholder-text">
                         Falta crear la tabla del kardex.<br>
                         Ejecuta <strong>sql/02_inventario.sql</strong> en Supabase.</div>`
                    : `<div class="placeholder-text">Error cargando el kardex.</div>`;
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────

    /** Llama una RPC y traduce el "no existe todavía" a un aviso claro. */
    async function _rpc(nombre, args) {
        const { data, error } = await db.rpc(nombre, args);
        if (error) {
            console.error('[Inventario] rpc ' + nombre + ':', error);
            avisar(_esFuncionFaltante(error)
                ? `Falta ejecutar sql/02_inventario.sql en Supabase (${nombre})`
                : 'Error en la operación de stock. Revisa la consola.', 'error');
            return null;
        }
        return data;
    }

    function _esFuncionFaltante(error) {
        return error?.code === 'PGRST202' || error?.code === '42883';
    }

    function _esTablaFaltante(error) {
        return error?.code === 'PGRST205' || error?.code === '42P01';
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    /** 3 → "3"   ·   2.5 → "2,5" */
    function _fmtCant(v) {
        const n = _num(v);
        return Number.isInteger(n) ? String(n) : n.toLocaleString('es-CL', { maximumFractionDigits: 2 });
    }

    function _bajoMinimo(r) {
        return _num(r.stock) <= _num(r.stock_minimo);
    }

    function _badgeStock(r) {
        const stock = _num(r.stock);
        if (stock <= 0)      return `<span class="tll-badge anulada">sin stock</span>`;
        if (_bajoMinimo(r))  return `<span class="tll-badge diagnostico">${_fmtCant(stock)}</span>`;
        return `<strong>${_fmtCant(stock)}</strong>`;
    }

    function _margen(r) {
        const v = _num(r.precio_venta), c = _num(r.precio_costo);
        if (v <= 0) return '—';
        const pct = ((v - c) / v) * 100;
        const color = pct < 0 ? '#f87171' : pct < 15 ? '#fbbf24' : '#34d399';
        return `<span style="color:${color}">${pct.toFixed(0)}%</span>`;
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
