// ================================================================
// modulo-reportes.js — Rentabilidad, productividad y rotación
// ================================================================
// Todo se calcula en la base (ver sql/06_reportes.sql). Aquí solo se
// pide el periodo y se dibuja. Sin librerías externas: las barras son
// divs, para no meterle una dependencia de CDN al taller.
//
// Ojo con el resultado: es OPERATIVO, no contable. Sirve para decidir
// si el taller está ganando plata, no para declarar impuestos.
// ================================================================

const ModuloReportes = (() => {

    let _desde = null;
    let _hasta = null;
    let _resumen = null;

    // ── Init ──────────────────────────────────────────────────────
    async function init() {
        const cont = document.getElementById('contenido-reportes');
        if (!cont) return;

        const [d, h] = _rangoMes(0);
        _desde = d; _hasta = h;

        cont.innerHTML = `
            <div class="tll-toolbar">
                <select class="tll-select" id="rep-rango" style="max-width:190px">
                    <option value="mes">Este mes</option>
                    <option value="mes_anterior">Mes anterior</option>
                    <option value="90">Últimos 90 días</option>
                    <option value="anio">Este año</option>
                    <option value="custom">Personalizado…</option>
                </select>
                <input class="tll-input" id="rep-desde" type="date" value="${_desde}" style="max-width:170px">
                <input class="tll-input" id="rep-hasta" type="date" value="${_hasta}" style="max-width:170px">
                <button class="tll-btn tll-btn--primary" id="rep-aplicar">Ver</button>
                <div class="tll-toolbar-sep"></div>
                <button class="tll-btn tll-btn--ghost" id="rep-csv">↓ Exportar CSV</button>
            </div>
            <div id="rep-cuerpo"><div class="placeholder-text">Cargando reportes…</div></div>`;

        document.getElementById('rep-rango').addEventListener('change', _cambiarRango);
        document.getElementById('rep-aplicar').addEventListener('click', recargar);
        document.getElementById('rep-csv').addEventListener('click', _exportarCSV);

        await recargar();
    }

    function _cambiarRango(e) {
        const v = e.target.value;
        if (v === 'custom') return;

        let d, h;
        if (v === 'mes')                 [d, h] = _rangoMes(0);
        else if (v === 'mes_anterior')   [d, h] = _rangoMes(-1);
        else if (v === 'anio')           [d, h] = _rangoAnio();
        else                             [d, h] = _rangoDias(90);

        document.getElementById('rep-desde').value = d;
        document.getElementById('rep-hasta').value = h;
        recargar();
    }

    async function recargar() {
        const cont = document.getElementById('rep-cuerpo');
        if (!cont) return;

        _desde = document.getElementById('rep-desde').value;
        _hasta = document.getElementById('rep-hasta').value;

        if (!_desde || !_hasta) { avisar('Selecciona el rango de fechas', 'error'); return; }
        if (_desde > _hasta)    { avisar('La fecha "desde" es posterior a "hasta"', 'error'); return; }

        cont.innerHTML = `<div class="placeholder-text">Calculando…</div>`;

        try {
            const eid = window.appData.usuario.empresa_id;

            const { data: resumen, error } = await db.rpc('fn_reporte_resumen', {
                p_empresa_id: eid, p_desde: _desde, p_hasta: _hasta
            });

            if (error) {
                cont.innerHTML = (error.code === 'PGRST202' || error.code === '42883')
                    ? `<div class="placeholder-text">
                         Faltan las vistas y funciones de reportes.<br>
                         Ejecuta <strong>sql/06_reportes.sql</strong> en Supabase.</div>`
                    : `<div class="placeholder-text">Error calculando los reportes.</div>`;
                console.error('[Reportes] resumen:', error);
                return;
            }
            if (!resumen?.ok) {
                cont.innerHTML = `<div class="placeholder-text">
                    ${esc(resumen?.error || 'No se pudo calcular el resumen.')}</div>`;
                return;
            }

            _resumen = resumen;

            const [mecanicos, ordenes, rotacion, medios, gastos, presup] = await Promise.all([
                _cargarMecanicos(eid),
                _cargarOrdenes(eid),
                _cargarRotacion(eid),
                _cargarMedios(eid),
                _cargarGastos(eid),
                _cargarPresupuestos(eid)
            ]);

            _render(resumen, mecanicos, ordenes, rotacion, medios);
            _renderExtra(gastos, presup);

        } catch (err) {
            console.error('[Reportes] cargar:', err);
            cont.innerHTML = `<div class="placeholder-text">Error cargando los reportes.</div>`;
        }
    }

    // ── Consultas de apoyo ────────────────────────────────────────
    async function _cargarGastos(eid) {
        const { data } = await db.rpc('fn_reporte_gastos', {
            p_empresa_id: eid, p_desde: _desde, p_hasta: _hasta
        });
        return data?.ok ? data : null;
    }

    async function _cargarPresupuestos(eid) {
        const { data } = await db.rpc('fn_reporte_presupuestos', {
            p_empresa_id: eid, p_desde: _desde, p_hasta: _hasta
        });
        return data?.ok ? data : null;
    }

    const _CAT_GASTO = {
        arriendo: 'Arriendo', electricidad: 'Electricidad', agua: 'Agua',
        internet: 'Internet / teléfono', herramientas: 'Herramientas', insumos: 'Insumos',
        combustible: 'Combustible', sueldos: 'Sueldos', mantencion_local: 'Mantención local',
        marketing: 'Marketing', impuestos: 'Impuestos', otros: 'Otros'
    };
    const _MOT_PERD = {
        precio: 'Precio', postergado: 'Postergado', no_responde: 'No responde',
        otro_taller: 'Otro taller', otro: 'Otro', sin_motivo: 'Sin registrar'
    };

    function _renderExtra(gastos, presup) {
        const cont = document.getElementById('rep-cuerpo');
        if (!cont) return;
        const bloques = [];

        if (gastos && Number(gastos.total) > 0) {
            const filas = Object.entries(gastos.por_categoria || {})
                .sort((a, b) => Number(b[1]) - Number(a[1]))
                .map(([k, v]) => `<div class="tll-rep-fila"><span>${esc(_CAT_GASTO[k] || k)}</span>
                    <strong>${fmtCLP(v)}</strong></div>`).join('');
            bloques.push(`<div class="tll-rep-card">
                <h3>Gastos del periodo · ${fmtCLP(gastos.total)}</h3>
                ${filas}</div>`);
        }

        if (presup && Number(presup.emitidos) > 0) {
            const motivos = Object.entries(presup.perdida_por_motivo || {})
                .map(([k, v]) => `<div class="tll-rep-fila"><span>${esc(_MOT_PERD[k] || k)}</span>
                    <strong>${v}</strong></div>`).join('');
            bloques.push(`<div class="tll-rep-card">
                <h3>Presupuestos</h3>
                <div class="tll-rep-fila"><span>Emitidos</span><strong>${presup.emitidos} · ${fmtCLP(presup.monto_emitido)}</strong></div>
                <div class="tll-rep-fila"><span>Aprobados</span><strong>${presup.aprobados} · ${fmtCLP(presup.monto_aprobado)}</strong></div>
                <div class="tll-rep-fila"><span>Rechazados</span><strong>${presup.rechazados} · ${fmtCLP(presup.monto_perdido)}</strong></div>
                <div class="tll-rep-fila fuerte"><span>Tasa de conversión</span><strong>${presup.tasa_conversion}%</strong></div>
                ${motivos ? '<div class="tll-rep-sep"></div><div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.3rem">Perdidos por motivo</div>' + motivos : ''}</div>`);
        }

        if (bloques.length) {
            const wrap = document.createElement('div');
            wrap.className = 'tll-rep-grid';
            wrap.style.marginTop = '1rem';
            wrap.innerHTML = bloques.join('');
            cont.appendChild(wrap);
        }
    }

    async function _cargarMecanicos(eid) {
        const { data, error } = await db.rpc('fn_reporte_mecanicos', {
            p_empresa_id: eid, p_desde: _desde, p_hasta: _hasta
        });
        if (error || !data?.ok) { console.warn('[Reportes] mecánicos:', error || data?.error); return []; }
        return data.mecanicos || [];
    }

    async function _cargarOrdenes(eid) {
        const { data, error } = await db.from('v_taller_ot_rentabilidad')
            .select('*')
            .eq('empresa_id', eid)
            .eq('estado', 'entregada')
            .gte('fecha_entrega', _desde)
            .lte('fecha_entrega', _hasta + 'T23:59:59')
            .order('margen', { ascending: false })
            .limit(500);
        if (error) { console.warn('[Reportes] órdenes:', error); return []; }
        return data || [];
    }

    async function _cargarRotacion(eid) {
        const { data, error } = await db.from('v_taller_rotacion_repuestos')
            .select('*')
            .eq('empresa_id', eid)
            .order('capital_inmovilizado', { ascending: false })
            .limit(500);
        if (error) { console.warn('[Reportes] rotación:', error); return []; }
        return data || [];
    }

    async function _cargarMedios(eid) {
        const { data, error } = await db.from('taller_movimientos_caja')
            .select('medio_pago, monto, tipo')
            .eq('empresa_id', eid)
            .eq('tipo', 'ingreso')
            .gte('created_at', _desde)
            .lte('created_at', _hasta + 'T23:59:59')
            .range(0, 4999);
        if (error) { console.warn('[Reportes] medios:', error); return []; }

        const acc = {};
        for (const m of (data || [])) {
            acc[m.medio_pago] = (acc[m.medio_pago] || 0) + _num(m.monto);
        }
        return Object.entries(acc).sort((a, b) => b[1] - a[1]);
    }

    // ── Render ────────────────────────────────────────────────────
    function _render(r, mecanicos, ordenes, rotacion, medios) {
        const cont = document.getElementById('rep-cuerpo');
        if (!cont) return;

        const resultado = _num(r.resultado);
        const dormido = rotacion.filter(x => x.rotacion === 'dormido' && _num(x.capital_inmovilizado) > 0);
        const capitalDormido = dormido.reduce((s, x) => s + _num(x.capital_inmovilizado), 0);
        const capitalTotal   = rotacion.reduce((s, x) => s + _num(x.capital_inmovilizado), 0);

        cont.innerHTML = `
            <!-- ── Resultado del periodo ── -->
            <div class="tll-kpis">
                ${_kpi('💵', fmtCLP(r.ingresos), 'Ingresos')}
                ${_kpi('📦', fmtCLP(r.costo_repuestos), 'Costo de repuestos')}
                ${_kpi('📊', fmtCLP(r.margen_bruto), `Margen bruto · ${r.margen_pct}%`)}
                ${_kpi(resultado >= 0 ? '✅' : '🔻', fmtCLP(resultado), 'Resultado operativo',
                       resultado >= 0 ? '#34d399' : '#f87171')}
            </div>

            <div class="tll-rep-grid">
                <!-- Cascada del resultado -->
                <div class="tll-rep-card">
                    <h3>De dónde sale el resultado</h3>
                    ${_fila('Órdenes de trabajo', r.ordenes_total, `${r.ordenes_cantidad} OT`)}
                    ${_fila('Ventas de mostrador', r.ventas_total, `${r.ventas_cantidad} ventas`)}
                    <div class="tll-rep-sep"></div>
                    ${_fila('Ingresos', r.ingresos, '', true)}
                    ${_fila('− Costo de repuestos', -_num(r.costo_repuestos))}
                    <div class="tll-rep-sep"></div>
                    ${_fila('Margen bruto', r.margen_bruto, `${r.margen_pct}%`, true)}
                    ${_fila('− Gastos', -_num(r.gastos))}
                    ${_fila('− Comisiones pagadas', -_num(r.comisiones))}
                    <div class="tll-rep-sep"></div>
                    ${_fila('Resultado operativo', resultado, '', true,
                            resultado >= 0 ? '#34d399' : '#f87171')}
                    <p class="tll-rep-nota">
                        Aproximación operativa, no contabilidad: no incluye sueldos fijos,
                        arriendo ni depreciación, salvo que los cargues como gasto en Caja.
                    </p>
                </div>

                <!-- Situación -->
                <div class="tll-rep-card">
                    <h3>Cómo está el taller hoy</h3>
                    ${_fila('Ticket promedio por OT', r.ticket_promedio_ot)}
                    ${_fila('Mano de obra vendida', r.mano_obra)}
                    <div class="tll-rep-sep"></div>
                    ${_fila('Por cobrar a clientes', r.por_cobrar, '', false, '#fbbf24')}
                    ${_fila('Por pagar a proveedores', r.por_pagar, '', false, '#f87171')}
                    <div class="tll-rep-sep"></div>
                    ${_fila('Capital en bodega', capitalTotal)}
                    ${_fila('Capital dormido (90 d sin salida)', capitalDormido,
                            capitalTotal > 0 ? `${Math.round(capitalDormido / capitalTotal * 100)}% del stock` : '',
                            false, capitalDormido > 0 ? '#fbbf24' : '')}
                    <p class="tll-rep-nota">
                        La deuda es la foto de hoy, no del periodo seleccionado.
                    </p>
                </div>
            </div>

            <!-- ── Productividad ── -->
            <div class="panel-header" style="margin-top:1.5rem">
                <h2 style="font-size:1rem">Productividad por mecánico</h2>
            </div>
            ${_tablaMecanicos(mecanicos)}

            <!-- ── Rentabilidad por OT ── -->
            <div class="panel-header" style="margin-top:1.5rem">
                <h2 style="font-size:1rem">Órdenes del periodo</h2>
            </div>
            ${_tablaOrdenes(ordenes)}

            <!-- ── Repuestos ── -->
            <div class="tll-rep-grid" style="margin-top:1.5rem">
                <div>
                    <div class="panel-header"><h2 style="font-size:1rem">Capital dormido</h2></div>
                    ${_tablaDormidos(dormido)}
                </div>
                <div>
                    <div class="panel-header"><h2 style="font-size:1rem">Ingresos por medio de pago</h2></div>
                    ${_tablaMedios(medios)}
                </div>
            </div>`;
    }

    // ── Bloques ───────────────────────────────────────────────────
    function _tablaMecanicos(mecanicos) {
        if (!mecanicos.length) {
            return `<div class="placeholder-text">
                Sin órdenes entregadas con mecánico asignado en el periodo.<br>
                <span style="font-size:0.78rem;color:var(--text-muted)">
                    Asigna el mecánico a cargo en el detalle de cada orden de trabajo.</span>
            </div>`;
        }

        const max = Math.max(...mecanicos.map(m => _num(m.mano_obra)), 1);

        return `
        <div class="tll-tabla-wrap">
        <table class="tll-tabla">
            <thead><tr>
                <th>Mecánico</th><th style="width:26%">Mano de obra</th>
                <th style="text-align:right">OT</th>
                <th style="text-align:right">Facturado</th>
                <th style="text-align:right">Ticket prom.</th>
                <th style="text-align:right">Margen</th>
            </tr></thead>
            <tbody>
            ${mecanicos.map(m => `
                <tr>
                    <td><strong>${esc(m.nombre)}</strong>
                        ${m.especialidad ? `<div style="font-size:0.7rem;color:var(--text-secondary)">${esc(m.especialidad)}</div>` : ''}</td>
                    <td>
                        <div class="tll-barra"><div class="tll-barra-fill"
                             style="width:${(_num(m.mano_obra) / max * 100).toFixed(1)}%"></div></div>
                        <div style="font-size:0.72rem;font-family:var(--font-mono);margin-top:0.15rem">
                            ${fmtCLP(m.mano_obra)}</div></td>
                    <td style="text-align:right;font-family:var(--font-mono)">${m.ordenes}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(m.facturado)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(m.ticket_promedio)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(m.margen)}</td>
                </tr>`).join('')}
            </tbody>
        </table></div>`;
    }

    function _tablaOrdenes(ordenes) {
        if (!ordenes.length) {
            return `<div class="placeholder-text">Sin órdenes entregadas en el periodo.</div>`;
        }

        // Las 8 mejores y las 5 peores: lo interesante está en los extremos
        const mejores = ordenes.slice(0, 8);
        const peores  = ordenes.slice(-5).reverse().filter(o => !mejores.includes(o));

        const fila = (o) => `
            <tr>
                <td style="font-family:var(--font-mono)"><strong>${esc(o.numero)}</strong></td>
                <td>${fmtFecha(o.fecha_entrega)}</td>
                <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(o.total)}</td>
                <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(o.venta_repuestos)}</td>
                <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(o.mano_obra)}</td>
                <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(o.costo_repuestos)}</td>
                <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(o.margen)}</td>
                <td style="text-align:right;font-family:var(--font-mono);color:${_colorMargen(o.margen_pct)}">
                    ${_num(o.margen_pct).toFixed(0)}%</td>
            </tr>`;

        return `
        <div class="tll-tabla-wrap">
        <table class="tll-tabla">
            <thead><tr>
                <th>N°</th><th>Entrega</th>
                <th style="text-align:right">Total</th>
                <th style="text-align:right">Repuestos</th>
                <th style="text-align:right">M. obra</th>
                <th style="text-align:right">Costo</th>
                <th style="text-align:right">Margen</th>
                <th style="text-align:right">%</th>
            </tr></thead>
            <tbody>
            ${mejores.map(fila).join('')}
            ${peores.length ? `
                <tr><td colspan="8" style="background:var(--bg-hover, rgba(255,255,255,0.03));
                        font-size:0.75rem;color:var(--text-secondary);text-align:center">
                    las de menor margen</td></tr>
                ${peores.map(fila).join('')}` : ''}
            </tbody>
        </table></div>
        <p class="tll-rep-nota">
            ${ordenes.length} orden(es) entregada(s) en el periodo. Se muestran los extremos.
        </p>`;
    }

    function _tablaDormidos(dormido) {
        if (!dormido.length) {
            return `<div class="placeholder-text">
                Sin repuestos dormidos: todo el stock tuvo movimiento en los últimos 90 días.</div>`;
        }

        return `
        <div class="tll-tabla-wrap">
        <table class="tll-tabla">
            <thead><tr>
                <th>Repuesto</th><th>Ubicación</th>
                <th style="text-align:right">Stock</th>
                <th style="text-align:right">Capital</th>
                <th style="text-align:right">Sin salida</th>
            </tr></thead>
            <tbody>
            ${dormido.slice(0, 12).map(x => `
                <tr>
                    <td><strong style="font-family:var(--font-mono)">${esc(x.codigo)}</strong>
                        <div style="font-size:0.72rem;color:var(--text-secondary)">${esc(x.nombre)}</div></td>
                    <td style="font-family:var(--font-mono);font-size:0.78rem">${esc(x.ubicacion) || '—'}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">${_fmtCant(x.stock)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        <strong>${fmtCLP(x.capital_inmovilizado)}</strong></td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        ${x.dias_sin_salida != null ? x.dias_sin_salida + ' d' : 'nunca'}</td>
                </tr>`).join('')}
            </tbody>
        </table></div>`;
    }

    function _tablaMedios(medios) {
        if (!medios.length) {
            return `<div class="placeholder-text">Sin ingresos registrados en caja en el periodo.</div>`;
        }

        const total = medios.reduce((s, [, v]) => s + v, 0);

        return `
        <div class="tll-tabla-wrap">
        <table class="tll-tabla">
            <thead><tr><th>Medio</th><th style="width:40%"></th>
                <th style="text-align:right">Monto</th><th style="text-align:right">%</th></tr></thead>
            <tbody>
            ${medios.map(([medio, monto]) => `
                <tr>
                    <td>${esc(medio)}</td>
                    <td><div class="tll-barra"><div class="tll-barra-fill"
                        style="width:${(monto / total * 100).toFixed(1)}%"></div></div></td>
                    <td style="text-align:right;font-family:var(--font-mono)">${fmtCLP(monto)}</td>
                    <td style="text-align:right;font-family:var(--font-mono)">
                        ${(monto / total * 100).toFixed(0)}%</td>
                </tr>`).join('')}
            </tbody>
            <tfoot><tr>
                <td colspan="2" style="text-align:right"><strong>Total</strong></td>
                <td style="text-align:right;font-family:var(--font-mono)"><strong>${fmtCLP(total)}</strong></td>
                <td></td>
            </tr></tfoot>
        </table></div>`;
    }

    // ── Exportar ──────────────────────────────────────────────────
    function _exportarCSV() {
        if (!_resumen) { avisar('Primero genera el reporte', 'error'); return; }

        const filas = [
            ['Reporte', `${_desde} a ${_hasta}`],
            ['Empresa', window.appData.empresa?.nombre || ''],
            [],
            ['Concepto', 'Monto'],
            ['Órdenes de trabajo', _resumen.ordenes_total],
            ['Cantidad de OT', _resumen.ordenes_cantidad],
            ['Ventas de mostrador', _resumen.ventas_total],
            ['Cantidad de ventas', _resumen.ventas_cantidad],
            ['Ingresos', _resumen.ingresos],
            ['Costo de repuestos', _resumen.costo_repuestos],
            ['Margen bruto', _resumen.margen_bruto],
            ['Margen %', _resumen.margen_pct],
            ['Gastos', _resumen.gastos],
            ['Comisiones pagadas', _resumen.comisiones],
            ['Resultado operativo', _resumen.resultado],
            ['Ticket promedio OT', _resumen.ticket_promedio_ot],
            ['Por cobrar', _resumen.por_cobrar],
            ['Por pagar', _resumen.por_pagar]
        ];

        // Separador ';' y BOM: así Excel en español lo abre en columnas
        const csv = '﻿' + filas.map(f => f.join(';')).join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `reporte-${_desde}-a-${_hasta}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        avisar('Reporte exportado');
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _fila(label, monto, nota = '', fuerte = false, color = '') {
        const v = _num(monto);
        return `
        <div class="tll-rep-fila${fuerte ? ' fuerte' : ''}">
            <span>${esc(label)}${nota ? `<span class="tll-rep-nota-inline">${esc(nota)}</span>` : ''}</span>
            <strong style="${color ? `color:${color}` : ''}">${v < 0 ? '−' : ''}${fmtCLP(Math.abs(v))}</strong>
        </div>`;
    }

    function _colorMargen(pct) {
        const p = _num(pct);
        return p < 0 ? '#f87171' : p < 20 ? '#fbbf24' : '#34d399';
    }

    function _kpi(icono, valor, label, color = '') {
        return `
        <div class="tll-kpi">
            <span class="tll-kpi-icono">${icono}</span>
            <div class="tll-kpi-valor" style="font-size:1.5rem;${color ? `color:${color}` : ''}">${valor}</div>
            <div class="tll-kpi-label">${label}</div>
        </div>`;
    }

    function _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function _fmtCant(v) {
        const n = _num(v);
        return Number.isInteger(n) ? String(n) : n.toLocaleString('es-CL', { maximumFractionDigits: 2 });
    }

    function _iso(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function _rangoMes(offset) {
        const hoy = new Date();
        const ini = new Date(hoy.getFullYear(), hoy.getMonth() + offset, 1);
        const fin = new Date(hoy.getFullYear(), hoy.getMonth() + offset + 1, 0);
        return [_iso(ini), _iso(fin)];
    }

    function _rangoAnio() {
        const hoy = new Date();
        return [_iso(new Date(hoy.getFullYear(), 0, 1)), _iso(hoy)];
    }

    function _rangoDias(dias) {
        const hoy = new Date();
        const ini = new Date(hoy);
        ini.setDate(ini.getDate() - dias);
        return [_iso(ini), _iso(hoy)];
    }

    return { init, recargar };

})();
