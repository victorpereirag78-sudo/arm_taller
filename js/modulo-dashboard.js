// ================================================================
// modulo-dashboard.js — Dashboard de ARM TALLER
// KPIs y órdenes en curso, filtrado por empresa_id.
// Mismo patrón IIFE que los módulos de Universal.
// ================================================================

const ModuloDashboard = (() => {

    async function init() {
        const cont = document.getElementById('contenido-dashboard');
        if (!cont) return;

        cont.innerHTML = `
            <div class="tll-kpis" id="dash-kpis">
                ${_kpi('🛠', '…', 'Órdenes activas')}
                ${_kpi('🚗', '…', 'Vehículos')}
                ${_kpi('👤', '…', 'Clientes')}
                ${_kpi('🧾', '…', 'Ventas del mes')}
            </div>
            <div class="panel-header" style="margin-top:0.5rem">
                <h2 style="font-size:1rem">Órdenes en curso</h2>
            </div>
            <div id="dash-ordenes" class="tll-tabla-wrap">
                <div class="placeholder-text">Cargando…</div>
            </div>`;

        await Promise.all([_cargarKpis(), _cargarOrdenes()]);
    }

    async function _cargarKpis() {
        try {
            const eid = window.appData.usuario.empresa_id;

            const [ordAct, veh, cli, ventas] = await Promise.all([
                db.from('taller_ordenes').select('id', { count: 'exact', head: true })
                    .eq('empresa_id', eid)
                    .not('estado', 'in', '("entregada","anulada")'),
                db.from('taller_vehiculos').select('id', { count: 'exact', head: true })
                    .eq('empresa_id', eid).eq('activo', true),
                db.from('taller_clientes').select('id', { count: 'exact', head: true })
                    .eq('empresa_id', eid).eq('activo', true),
                db.from('taller_ventas').select('id', { count: 'exact', head: true })
                    .eq('empresa_id', eid).eq('estado', 'pagada')
                    .gte('created_at', _inicioDeMes())
            ]);

            document.getElementById('dash-kpis').innerHTML = `
                ${_kpi('🛠', ordAct.count ?? 0, 'Órdenes activas')}
                ${_kpi('🚗', veh.count ?? 0, 'Vehículos')}
                ${_kpi('👤', cli.count ?? 0, 'Clientes')}
                ${_kpi('🧾', ventas.count ?? 0, 'Ventas del mes')}`;

        } catch (err) {
            console.error('[Dashboard] KPIs:', err);
        }
    }

    async function _cargarOrdenes() {
        const cont = document.getElementById('dash-ordenes');
        try {
            const eid = window.appData.usuario.empresa_id;

            const { data: ordenes, error } = await db
                .from('taller_ordenes')
                .select('numero, estado, motivo_ingreso, fecha_ingreso, taller_vehiculos(patente, marca, modelo)')
                .eq('empresa_id', eid)
                .not('estado', 'in', '("entregada","anulada")')
                .order('fecha_ingreso', { ascending: false })
                .limit(10);

            if (error) throw error;

            if (!ordenes || ordenes.length === 0) {
                cont.innerHTML = `<div class="placeholder-text">
                    Sin órdenes en curso. Crea la primera desde <strong>Órdenes de trabajo</strong>.
                </div>`;
                return;
            }

            cont.innerHTML = `
            <table class="tll-tabla">
                <thead><tr>
                    <th>N°</th><th>Patente</th><th>Vehículo</th>
                    <th>Motivo</th><th>Estado</th><th>Ingreso</th>
                </tr></thead>
                <tbody>
                ${ordenes.map(o => `
                    <tr>
                        <td style="font-family:var(--font-mono)"><strong>${esc(o.numero)}</strong></td>
                        <td style="font-family:var(--font-mono)">${esc(o.taller_vehiculos?.patente) || '—'}</td>
                        <td>${esc([o.taller_vehiculos?.marca, o.taller_vehiculos?.modelo].filter(Boolean).join(' ')) || '—'}</td>
                        <td>${esc(o.motivo_ingreso) || '—'}</td>
                        <td><span class="tll-badge ${esc(o.estado)}">${esc(o.estado)}</span></td>
                        <td>${fmtFecha(o.fecha_ingreso)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;

        } catch (err) {
            console.error('[Dashboard] Órdenes:', err);
            cont.innerHTML = `<div class="placeholder-text">Error cargando órdenes. Revisa la consola.</div>`;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _kpi(icono, valor, label) {
        return `
        <div class="tll-kpi">
            <span class="tll-kpi-icono">${icono}</span>
            <div class="tll-kpi-valor">${valor}</div>
            <div class="tll-kpi-label">${label}</div>
        </div>`;
    }

    function _inicioDeMes() {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
    }

    // ── API pública ───────────────────────────────────────────────
    return { init };

})();
