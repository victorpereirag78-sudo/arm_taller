// ================================================================
// modulo-proveedores.js — Proveedores del taller
// ================================================================
// Ficha + condición de pago (contado o crédito con N días). Los días
// de crédito no son un dato decorativo: de ahí sale la fecha de
// vencimiento de la cuenta por pagar al recibir la mercadería.
//
// Ver sql/05_compras_cxp.sql.
// ================================================================

const ModuloProveedores = (() => {

    let _proveedores = [];
    let _saldos      = [];
    let _editando    = null;
    let _verInactivos = false;

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-proveedores');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <button class="tll-btn tll-btn--primary" id="prv-nuevo">+ Nuevo proveedor</button>
                <input class="tll-input" id="prv-buscar" placeholder="Buscar por razón social, RUT o giro…">
                <label class="tll-check">
                    <input type="checkbox" id="prv-inactivos"> Ver inactivos
                </label>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="prv-reload">↻ Actualizar</button>
            </div>
            <div id="prv-lista" class="tll-tabla-wrap"></div>`;

        document.getElementById('prv-nuevo').addEventListener('click', () => _abrirForm(null));
        document.getElementById('prv-reload').addEventListener('click', recargar);
        document.getElementById('prv-buscar').addEventListener('input', _renderLista);
        document.getElementById('prv-inactivos').addEventListener('change', (e) => {
            _verInactivos = e.target.checked;
            _renderLista();
        });

        await recargar();
    }

    async function recargar() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [pRes, sRes] = await Promise.all([
                db.from('taller_proveedores').select('*')
                  .eq('empresa_id', eid).order('razon_social'),
                db.from('v_taller_proveedores_saldo').select('*')
                  .eq('empresa_id', eid)
            ]);

            if (pRes.error) throw pRes.error;
            _proveedores = pRes.data || [];
            _saldos      = sRes.data || [];
            _renderLista();
        } catch (err) {
            console.error('[Proveedores] cargar:', err);
            const cont = document.getElementById('prv-lista');
            if (cont) {
                cont.innerHTML = errorCarga(err, '05_compras_cxp.sql', 'el módulo Proveedores');
            }
        }
    }

    // ── Lista ─────────────────────────────────────────────────────
    function _renderLista() {
        const cont = document.getElementById('prv-lista');
        if (!cont) return;

        const q = (document.getElementById('prv-buscar')?.value || '').toLowerCase().trim();

        let lista = _verInactivos ? _proveedores : _proveedores.filter(p => p.activo);
        if (q) {
            lista = lista.filter(p =>
                (p.razon_social || '').toLowerCase().includes(q) ||
                (p.nombre_fantasia || '').toLowerCase().includes(q) ||
                (p.rut || '').toLowerCase().includes(q) ||
                (p.giro || '').toLowerCase().includes(q));
        }

        if (lista.length === 0) {
            cont.innerHTML = `<div class="placeholder-text">
                ${_proveedores.length === 0
                    ? 'Sin proveedores registrados. Crea el primero con <strong>+ Nuevo proveedor</strong>.'
                    : 'Sin resultados para esa búsqueda.'}
            </div>`;
            return;
        }

        cont.innerHTML = `
        <table class="tll-tabla">
            <thead><tr>
                <th>Proveedor</th><th>RUT</th><th>Contacto</th><th>Condición</th>
                <th style="text-align:right">Saldo</th><th>Estado</th><th></th>
            </tr></thead>
            <tbody>
            ${lista.map(p => {
                const s = _saldos.find(x => x.proveedor_id === p.id);
                const saldo   = _num(s?.saldo_total);
                const vencido = _num(s?.saldo_vencido);
                return `
                <tr${p.activo ? '' : ' style="opacity:0.5"'}>
                    <td><strong>${esc(p.razon_social)}</strong>
                        ${p.nombre_fantasia ? `<div style="font-size:0.72rem;color:var(--text-secondary)">${esc(p.nombre_fantasia)}</div>` : ''}</td>
                    <td style="font-family:var(--font-mono)">${esc(p.rut) || '—'}</td>
                    <td>${esc(p.contacto_nombre) || '—'}
                        ${p.telefono ? `<div style="font-size:0.72rem;color:var(--text-secondary)">${esc(p.telefono)}</div>` : ''}</td>
                    <td>${p.condicion_pago === 'credito'
                        ? `<span class="tll-badge aprobada">crédito ${p.dias_credito} d</span>`
                        : '<span class="tll-badge entregada">contado</span>'}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        ${saldo > 0 ? `<strong>${fmtCLP(saldo)}</strong>` : '—'}
                        ${vencido > 0 ? `<div style="font-size:0.68rem;color:#f87171">vencido ${fmtCLP(vencido)}</div>` : ''}</td>
                    <td><span class="tll-badge ${p.activo ? 'lista' : 'anulada'}">${p.activo ? 'activo' : 'inactivo'}</span></td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="tll-btn tll-btn--ghost prv-cuenta" data-id="${p.id}">Estado de cuenta</button>
                        <button class="tll-btn tll-btn--ghost prv-editar" data-id="${p.id}">Editar</button>
                    </td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>`;

        const porId = (b) => _proveedores.find(p => p.id === b.dataset.id);
        cont.querySelectorAll('.prv-editar').forEach(b =>
            b.addEventListener('click', () => _abrirForm(porId(b))));
        cont.querySelectorAll('.prv-cuenta').forEach(b =>
            b.addEventListener('click', () => _verCuenta(porId(b))));
    }

    // ── Formulario ────────────────────────────────────────────────
    function _abrirForm(prv) {
        _editando = prv;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>${prv ? 'Editar ' + esc(prv.razon_social) : 'Nuevo proveedor'}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div class="tll-form-grid">
            <div class="tll-field tll-field--full">
                <label>Razón social *</label>
                <input class="tll-input" id="prv-f-razon" value="${esc(prv?.razon_social || '')}">
            </div>
            <div class="tll-field">
                <label>RUT</label>
                <input class="tll-input" id="prv-f-rut" placeholder="76.543.210-K"
                       style="font-family:var(--font-mono)" value="${esc(prv?.rut || '')}">
            </div>
            <div class="tll-field">
                <label>Nombre de fantasía</label>
                <input class="tll-input" id="prv-f-fantasia" value="${esc(prv?.nombre_fantasia || '')}">
            </div>
            <div class="tll-field">
                <label>Giro</label>
                <input class="tll-input" id="prv-f-giro" placeholder="Venta de repuestos automotrices"
                       value="${esc(prv?.giro || '')}">
            </div>
            <div class="tll-field">
                <label>Contacto</label>
                <input class="tll-input" id="prv-f-contacto" value="${esc(prv?.contacto_nombre || '')}">
            </div>
            <div class="tll-field">
                <label>Teléfono</label>
                <input class="tll-input" id="prv-f-telefono" value="${esc(prv?.telefono || '')}">
            </div>
            <div class="tll-field">
                <label>Email</label>
                <input class="tll-input" id="prv-f-email" type="email" value="${esc(prv?.email || '')}">
            </div>
            <div class="tll-field tll-field--full">
                <label>Dirección</label>
                <input class="tll-input" id="prv-f-direccion" value="${esc(prv?.direccion || '')}">
            </div>
            <div class="tll-field">
                <label>Ciudad</label>
                <input class="tll-input" id="prv-f-ciudad" value="${esc(prv?.ciudad || '')}">
            </div>
            <div class="tll-field">
                <label>Condición de pago</label>
                <select class="tll-select" id="prv-f-condicion">
                    <option value="contado" ${prv?.condicion_pago !== 'credito' ? 'selected' : ''}>Contado</option>
                    <option value="credito" ${prv?.condicion_pago === 'credito' ? 'selected' : ''}>Crédito</option>
                </select>
            </div>
            <div class="tll-field">
                <label>Días de crédito</label>
                <input class="tll-input" id="prv-f-dias" type="number" min="0" value="${prv?.dias_credito ?? 0}">
                <span class="tll-field-msg">De aquí sale el vencimiento al recibir mercadería.</span>
            </div>
            <div class="tll-field tll-field--full">
                <label>Notas</label>
                <textarea class="tll-textarea" id="prv-f-notas">${esc(prv?.notas || '')}</textarea>
            </div>
            ${prv ? `
            <div class="tll-field">
                <label>Estado</label>
                <select class="tll-select" id="prv-f-activo">
                    <option value="true"  ${prv.activo ? 'selected' : ''}>Activo</option>
                    <option value="false" ${!prv.activo ? 'selected' : ''}>Inactivo</option>
                </select>
            </div>` : ''}
        </div>
        <div class="tll-modal-footer">
            <button class="tll-btn tll-btn--ghost" onclick="cerrarModal()">Cancelar</button>
            <button class="tll-btn tll-btn--primary" id="prv-guardar">Guardar proveedor</button>
        </div>`, '720px');

        const inpRut = document.getElementById('prv-f-rut');
        inpRut.addEventListener('input', () => { inpRut.value = formatearRut(inpRut.value); });

        document.getElementById('prv-guardar').addEventListener('click', _guardar);
    }

    async function _guardar() {
        const razon = document.getElementById('prv-f-razon').value.trim();
        if (!razon) { avisar('La razón social es obligatoria', 'error'); return; }

        const rut = normalizarRut(document.getElementById('prv-f-rut').value);
        if (rut && !validarRutChileno(rut)) {
            avisar('RUT inválido — revisa el dígito verificador', 'error'); return;
        }
        const email = document.getElementById('prv-f-email').value.trim();
        if (email && !validarEmail(email)) { avisar('Email con formato inválido', 'error'); return; }

        const fila = {
            empresa_id:      window.appData.usuario.empresa_id,
            razon_social:    razon,
            rut:             rut || null,
            nombre_fantasia: document.getElementById('prv-f-fantasia').value.trim() || null,
            giro:            document.getElementById('prv-f-giro').value.trim() || null,
            contacto_nombre: document.getElementById('prv-f-contacto').value.trim() || null,
            telefono:        document.getElementById('prv-f-telefono').value.trim() || null,
            email:           email || null,
            direccion:       document.getElementById('prv-f-direccion').value.trim() || null,
            ciudad:          document.getElementById('prv-f-ciudad').value.trim() || null,
            condicion_pago:  document.getElementById('prv-f-condicion').value,
            dias_credito:    Number(document.getElementById('prv-f-dias').value) || 0,
            notas:           document.getElementById('prv-f-notas').value.trim() || null
        };

        const btn = document.getElementById('prv-guardar');
        btn.disabled = true;

        try {
            if (_editando) {
                fila.activo = document.getElementById('prv-f-activo').value === 'true';
                const { error } = await db.from('taller_proveedores')
                    .update(fila).eq('id', _editando.id);
                if (error) throw error;
                avisar('Proveedor actualizado');
            } else {
                const { error } = await db.from('taller_proveedores').insert(fila);
                if (error) throw error;
                avisar('Proveedor creado');
            }
            cerrarModal();
            await recargar();
        } catch (err) {
            console.error('[Proveedores] guardar:', err);
            btn.disabled = false;
            avisar(err.code === '23505'
                ? 'Ya existe un proveedor con ese RUT'
                : 'Error al guardar. Revisa la consola.', 'error');
        }
    }

    // ── Estado de cuenta ──────────────────────────────────────────
    async function _verCuenta(prv) {
        if (!prv) return;

        abrirModal(`
        <div class="tll-modal-header">
            <h3>Estado de cuenta · ${esc(prv.razon_social)}</h3>
            <button class="tll-modal-cerrar" onclick="cerrarModal()">✕</button>
        </div>
        <div id="prv-c-body"><div class="placeholder-text">Cargando…</div></div>`, '820px');

        try {
            const { data: docs, error } = await db.from('v_taller_cxp_saldo')
                .select('*')
                .eq('empresa_id', window.appData.usuario.empresa_id)
                .eq('proveedor_id', prv.id)
                .order('fecha_vencimiento');
            if (error) throw error;

            const body = document.getElementById('prv-c-body');
            if (!body) return;

            if (!docs || docs.length === 0) {
                body.innerHTML = `<div class="placeholder-text">
                    Este proveedor no tiene documentos registrados.</div>`;
                return;
            }

            const pendientes = docs.filter(d => _num(d.saldo) > 0);
            const total = pendientes.reduce((s, d) => s + _num(d.saldo), 0);

            body.innerHTML = `
            <div class="tll-recep-${total > 0 ? 'notfound' : 'found'}" style="margin-bottom:0.8rem">
                ${total > 0
                    ? `Saldo pendiente: <strong>${fmtCLP(total)}</strong> en ${pendientes.length} documento(s).`
                    : 'Sin saldo pendiente con este proveedor.'}
            </div>
            <table class="tll-tabla">
                <thead><tr>
                    <th>Documento</th><th>Emisión</th><th>Vence</th>
                    <th style="text-align:right">Total</th>
                    <th style="text-align:right">Pagado</th>
                    <th style="text-align:right">Saldo</th><th>Estado</th>
                </tr></thead>
                <tbody>
                ${docs.map(d => `
                    <tr>
                        <td style="font-family:var(--font-mono)">
                            ${esc(d.numero_documento) || esc(d.descripcion) || '—'}</td>
                        <td>${fmtFecha(d.fecha_emision)}</td>
                        <td>${fmtFecha(d.fecha_vencimiento)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(d.total)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(d.pagado)}</td>
                        <td style="text-align:right;font-family:var(--font-mono)">
                            <strong>${fmtCLP(d.saldo)}</strong></td>
                        <td>${_badgeAntiguedad(d)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
        } catch (err) {
            console.error('[Proveedores] estado de cuenta:', err);
            const body = document.getElementById('prv-c-body');
            if (body) body.innerHTML = `<div class="placeholder-text">Error cargando el estado de cuenta.</div>`;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _badgeAntiguedad(d) {
        if (_num(d.saldo) <= 0) return '<span class="tll-badge lista">pagada</span>';
        const mapa = {
            por_vencer:     ['aprobada',    'por vencer'],
            sin_fecha:      ['entregada',   'sin fecha'],
            vencida_30:     ['diagnostico', `vencida ${d.dias_vencida} d`],
            vencida_60:     ['reparacion',  `vencida ${d.dias_vencida} d`],
            vencida_mas_60: ['anulada',     `vencida ${d.dias_vencida} d`]
        };
        const [clase, texto] = mapa[d.antiguedad] || ['entregada', d.antiguedad];
        return `<span class="tll-badge ${clase}">${esc(texto)}</span>`;
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    return { init, recargar, badgeAntiguedad: _badgeAntiguedad };

})();
