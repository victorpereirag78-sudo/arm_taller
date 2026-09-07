// ================================================================
// modulo-gastos.js — Gastos del taller
// CRUD sobre taller_gastos. Alimenta el resultado del periodo
// (fn_reporte_resumen suma taller_gastos, ver sql/30).
// ================================================================

const ModuloGastos = (() => {

    let _gastos   = [];
    let _editando = null;
    let _mes      = new Date().toISOString().slice(0, 7);   // YYYY-MM

    const CATEGORIAS = [
        ['arriendo', 'Arriendo'], ['electricidad', 'Electricidad'], ['agua', 'Agua'],
        ['internet', 'Internet / teléfono'], ['herramientas', 'Herramientas'],
        ['insumos', 'Insumos'], ['combustible', 'Combustible'], ['sueldos', 'Sueldos'],
        ['mantencion_local', 'Mantención del local'], ['marketing', 'Marketing'],
        ['impuestos', 'Impuestos y patentes'], ['otros', 'Otros']
    ];
    const MEDIOS = [
        ['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['debito', 'Débito'],
        ['credito', 'Crédito'], ['cheque', 'Cheque'], ['otro', 'Otro']
    ];
    const _lbl = (arr, k) => (arr.find(x => x[0] === k) || [k, k])[1];
    const _num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

    async function init() {
        const cont = document.getElementById('contenido-gastos');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-kpis" id="gas-kpis"></div>
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="gas-nuevo">+ Nuevo gasto</button>
                <input class="tll-input" id="gas-mes" type="month" value="${_mes}" style="max-width:170px">
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="gas-reload">↻ Actualizar</button>
            </div>
            <div id="gas-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('gas-nuevo').addEventListener('click', () => _abrirForm(null));
        document.getElementById('gas-reload').addEventListener('click', recargar);
        document.getElementById('gas-mes').addEventListener('change', (e) => {
            _mes = e.target.value; recargar();
        });

        await recargar();
    }

    function _rango() {
        const desde = _mes + '-01';
        const d = new Date(_mes + '-01T00:00:00');
        d.setMonth(d.getMonth() + 1); d.setDate(0);
        return { desde, hasta: d.toISOString().slice(0, 10) };
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;
            const { desde, hasta } = _rango();
            const { data, error } = await db.from('taller_gastos')
                .select('*').eq('empresa_id', eid)
                .gte('fecha', desde).lte('fecha', hasta)
                .order('fecha', { ascending: false });
            if (error) throw error;
            _gastos = data || [];
            _render();
        } catch (err) {
            console.error('[Gastos] cargar:', err);
            const cont = document.getElementById('gas-lista');
            if (cont) cont.innerHTML = errorCarga(err, '30_gastos.sql', 'los gastos');
        }
    }

    function _render() {
        _renderKpis();
        _renderLista();
    }

    function _renderKpis() {
        const cont = document.getElementById('gas-kpis');
        if (!cont) return;
        const total = _gastos.reduce((s, g) => s + _num(g.monto), 0);
        const porCat = {};
        _gastos.forEach(g => { porCat[g.categoria] = (porCat[g.categoria] || 0) + _num(g.monto); });
        const top = Object.entries(porCat).sort((a, b) => b[1] - a[1])[0];
        cont.innerHTML = `
            ${_kpi('🧾', fmtCLP(total), 'Total del mes')}
            ${_kpi('📄', _gastos.length, 'Registros')}
            ${_kpi('🔝', top ? _lbl(CATEGORIAS, top[0]) : '—', top ? fmtCLP(top[1]) : 'Sin gastos')}`;
    }

    function _kpi(icono, valor, label) {
        return `<div class="tll-kpi"><div class="tll-kpi-ico">${icono}</div>
            <div><div class="tll-kpi-val">${esc(valor)}</div>
            <div class="tll-kpi-lbl">${esc(label)}</div></div></div>`;
    }

    function _renderLista() {
        const cont = document.getElementById('gas-lista');
        if (!cont) return;
        if (_gastos.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                Sin gastos en ${esc(_mes)}. Registra el primero con <strong>+ Nuevo gasto</strong>.</div>`;
            return;
        }
        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Fecha</th><th>Categoría</th><th>Descripción</th><th>Proveedor</th>
                <th>Medio</th><th style="text-align:right">Monto</th><th></th>
            </tr></thead>
            <tbody>
            ${_gastos.map(g => `
                <tr>
                    <td style="font-family:var(--font-mono)">${fmtFecha(g.fecha)}</td>
                    <td>${esc(_lbl(CATEGORIAS, g.categoria))}</td>
                    <td>${esc(g.descripcion) || '—'}</td>
                    <td>${esc(g.proveedor) || '—'}</td>
                    <td>${g.medio_pago ? esc(_lbl(MEDIOS, g.medio_pago)) : '—'}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(g.monto)}</td>
                    <td style="text-align:right">
                        <button class="tll-btn tll-btn--ghost gas-editar" data-id="${g.id}">Editar</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;
        cont.querySelectorAll('.gas-editar').forEach(b =>
            b.addEventListener('click', () => _abrirForm(_gastos.find(g => g.id === b.dataset.id))));
    }

    function _abrirForm(gasto) {
        _editando = gasto;
        abrirModal(`
        <div class="tll-modal-header">
            <h3>${gasto ? 'Editar gasto' : 'Nuevo gasto'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field">
                <label>Fecha *</label>
                <input class="tll-input" id="gas-f-fecha" type="date"
                       value="${gasto?.fecha || new Date().toISOString().slice(0, 10)}">
            </div>
            <div class="tll-field">
                <label>Categoría *</label>
                <select class="tll-select" id="gas-f-cat">
                    ${CATEGORIAS.map(([v, t]) => `<option value="${v}" ${gasto?.categoria === v ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field">
                <label>Monto *</label>
                <input class="tll-input" id="gas-f-monto" type="number" min="0" step="1" value="${gasto?.monto ?? ''}">
            </div>
            <div class="tll-field">
                <label>Medio de pago</label>
                <select class="tll-select" id="gas-f-medio">
                    <option value="">—</option>
                    ${MEDIOS.map(([v, t]) => `<option value="${v}" ${gasto?.medio_pago === v ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="tll-field tll-field--full">
                <label>Descripción</label>
                <input class="tll-input" id="gas-f-desc" value="${esc(gasto?.descripcion || '')}"
                       placeholder="Ej: cuenta de luz agosto">
            </div>
            <div class="tll-field">
                <label>Proveedor</label>
                <input class="tll-input" id="gas-f-prov" value="${esc(gasto?.proveedor || '')}">
            </div>
            <div class="tll-field">
                <label>N° documento</label>
                <input class="tll-input" id="gas-f-doc" value="${esc(gasto?.documento || '')}">
            </div>
        </div>
        <div class="tll-modal-footer">
            ${gasto ? '<button class="tll-btn tll-btn--danger" id="gas-borrar">Eliminar</button><div class="tll-toolbar-sep"></div>' : ''}
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="gas-guardar">Guardar</button>
        </div>`);

        document.getElementById('gas-guardar').addEventListener('click', _guardar);
        document.getElementById('gas-borrar')?.addEventListener('click', _borrar);
    }

    async function _guardar() {
        const monto = _num(document.getElementById('gas-f-monto').value);
        if (!(monto >= 0) || monto === 0) { avisar('Ingresa un monto', 'error'); return; }

        const fila = {
            empresa_id:  window.appData.usuario.empresa_id,
            fecha:       document.getElementById('gas-f-fecha').value,
            categoria:   document.getElementById('gas-f-cat').value,
            monto,
            medio_pago:  document.getElementById('gas-f-medio').value || null,
            descripcion: document.getElementById('gas-f-desc').value.trim() || null,
            proveedor:   document.getElementById('gas-f-prov').value.trim() || null,
            documento:   document.getElementById('gas-f-doc').value.trim() || null,
            usuario_rut: window.appData.usuario.rut
        };
        const btn = document.getElementById('gas-guardar');
        btn.disabled = true;
        try {
            if (_editando) {
                const { error } = await db.from('taller_gastos').update(fila).eq('id', _editando.id);
                if (error) throw error;
                avisar('Gasto actualizado');
            } else {
                const { error } = await db.from('taller_gastos').insert(fila);
                if (error) throw error;
                avisar('Gasto registrado');
            }
            cerrarModal();
            await recargar();
        } catch (err) {
            console.error('[Gastos] guardar:', err);
            btn.disabled = false;
            avisar('Error al guardar. Revisa la consola.', 'error');
        }
    }

    async function _borrar() {
        if (!_editando || !confirm('¿Eliminar este gasto?')) return;
        const { error } = await db.from('taller_gastos').delete().eq('id', _editando.id);
        if (error) { avisar('No se pudo eliminar', 'error'); return; }
        avisar('Gasto eliminado');
        cerrarModal();
        await recargar();
    }

    return { init, recargar };

})();
