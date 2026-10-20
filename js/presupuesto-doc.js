// ================================================================
// presupuesto-doc.js — El presupuesto como documento
// ================================================================
// Un solo lugar que sabe dibujar el presupuesto: logo del taller, datos
// del taller, identificación del cliente y vehículo, trabajo a realizar y
// valores. Lo usan:
//   · el taller (vista previa, imprimir / guardar PDF)
//   · la página pública presupuesto.html (el enlace que va por WhatsApp)
// y la app Mi Vehículo dibuja el mismo documento con los mismos datos.
//
// Recibe el JSON de fn_presupuesto_documento (sql/44): sin costos, sin
// margen y sin códigos internos. No depende de utils.js a propósito.
// ================================================================

const PresupuestoDoc = (() => {

    const _esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const _clp = (n) => '$' + (Number(n) || 0).toLocaleString('es-CL', { maximumFractionDigits: 0 });

    const _cant = (v) => {
        const n = Number(v) || 0;
        return Number.isInteger(n) ? String(n) : n.toLocaleString('es-CL', { maximumFractionDigits: 2 });
    };

    /** Las columnas DATE ("2026-10-20") se leen como local: en Chile
        mostraban el día anterior si se parseaban como UTC. */
    function _fecha(iso, largo) {
        if (!iso) return '—';
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
        const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
        if (isNaN(d.getTime())) return '—';
        return largo
            ? d.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
            : d.toLocaleDateString('es-CL');
    }

    /** Solo se pinta un logo http(s) o una imagen base64 (el logo subido desde
        Mi taller): nada de javascript: ni otros esquemas. */
    function _logoSeguro(url) {
        const u = String(url || '').trim();
        return /^https?:\/\//i.test(u) || /^data:image\/(png|jpeg|webp);base64,/i.test(u) ? u : '';
    }

    function _filaId(k, v) {
        const t = String(v ?? '').trim();
        return t ? `<tr><th>${k}</th><td>${_esc(t)}</td></tr>` : '';
    }

    const CSS = `
    .pdoc { background:#fff; color:#111; font-family:Arial, Helvetica, sans-serif; font-size:13px;
            line-height:1.45; padding:28px 32px; max-width:820px; margin:0 auto; box-sizing:border-box; }
    .pdoc * { box-sizing:border-box; }
    .pdoc-titulo { text-align:center; font-size:22px; font-weight:800; letter-spacing:.02em; margin:0 0 18px; }
    .pdoc-cab { display:flex; gap:22px; align-items:center; margin-bottom:22px; }
    .pdoc-logo { flex:0 0 38%; display:flex; align-items:center; justify-content:center; min-height:70px; }
    .pdoc-logo img { max-width:100%; max-height:120px; object-fit:contain; }
    .pdoc-taller { flex:1; border-left:2px solid #111; padding-left:18px; }
    .pdoc-taller-nombre { font-size:15px; font-weight:800; margin-bottom:6px; }
    .pdoc table { border-collapse:collapse; width:100%; }
    .pdoc-taller th, .pdoc-id th { text-align:left; font-weight:700; padding:1px 10px 1px 0; vertical-align:top;
                                    white-space:nowrap; width:1%; }
    .pdoc-taller td, .pdoc-id td { padding:1px 0; vertical-align:top; word-break:break-word; }
    .pdoc-sec { font-size:15px; font-weight:800; margin:20px 0 8px; padding-bottom:3px; border-bottom:2px solid #111; }
    .pdoc-id th { font-weight:400; color:#444; padding-right:16px; }
    .pdoc-trabajo p { margin:0 0 6px; }
    .pdoc-grupo { margin:10px 0 2px; font-weight:800; text-transform:uppercase; font-size:12px; letter-spacing:.03em; }
    .pdoc-lista { margin:0 0 6px; padding-left:34px; }
    .pdoc-lista li { margin:1px 0; text-transform:uppercase; }
    .pdoc-valores td { padding:3px 0; vertical-align:top; }
    .pdoc-valores td.m { text-align:right; white-space:nowrap; padding-left:14px; font-variant-numeric:tabular-nums; }
    .pdoc-totales { margin:14px 0 0 auto; width:300px; border-top:2px solid #111; padding-top:6px; }
    .pdoc-totales div { display:flex; justify-content:space-between; padding:2px 0; font-size:15px; font-weight:700; }
    .pdoc-totales .tot { font-size:17px; font-weight:800; border-top:1px solid #111; margin-top:4px; padding-top:6px; }
    .pdoc-opc { margin-top:14px; font-size:12px; color:#333; }
    .pdoc-opc b { text-transform:uppercase; }
    .pdoc-nota { margin-top:22px; padding-top:10px; border-top:1px solid #bbb; font-size:11px; color:#555; line-height:1.6; }
    .pdoc-estado { margin:0 0 14px; padding:8px 12px; border-radius:6px; font-weight:700; font-size:13px; text-align:center; }
    .pdoc-estado.ok   { background:#e7f7ee; color:#146c3a; }
    .pdoc-estado.mal  { background:#fdecec; color:#9b1c1c; }
    .pdoc-estado.info { background:#eef3fb; color:#1d4d8f; }
    @media (max-width:560px) {
        .pdoc { padding:18px 14px; }
        .pdoc-cab { flex-direction:column; align-items:stretch; }
        .pdoc-logo { flex:none; }
        .pdoc-taller { border-left:0; padding-left:0; border-top:2px solid #111; padding-top:10px; }
        .pdoc-totales { width:100%; }
    }
    @media print { .pdoc { padding:0; max-width:none; } }`;

    /** Banner de estado (aprobado, rechazado, vencido…) o ''. */
    function _banner(d) {
        if (d.estado === 'aprobado' || d.estado === 'convertido') {
            return `<div class="pdoc-estado ok">✓ Presupuesto aprobado${d.aprobado_por ? ' por ' + _esc(d.aprobado_por) : ''}${d.aprobado_at ? ' el ' + _fecha(d.aprobado_at) : ''}</div>`;
        }
        if (d.estado === 'rechazado')   return `<div class="pdoc-estado mal">Presupuesto rechazado</div>`;
        if (d.estado === 'reemplazado') return `<div class="pdoc-estado info">Hay una versión más nueva de este presupuesto. Pídele el enlace actualizado al taller.</div>`;
        if (d.vencido)                  return `<div class="pdoc-estado mal">Presupuesto vencido el ${_fecha(d.fecha_vencimiento)}</div>`;
        return '';
    }

    /** HTML del presupuesto (solo el documento, con su <style>). */
    function html(d, { conEstado = true } = {}) {
        const t = d.taller || {};
        const c = d.cliente || {};
        const v = d.vehiculo || {};
        const items = d.items || [];
        const incl = items.filter(i => !i.opcional);
        const opc  = items.filter(i => i.opcional);

        const logo = _logoSeguro(t.logo_url);
        const num  = d.numero != null ? String(d.numero).padStart(2, '0') : '—';
        const ubic = [t.direccion, t.comuna, t.ciudad].filter(Boolean).join(', ');

        const vehiculoTxt = [
            v.marca  ? `Marca: ${v.marca}`   : '',
            v.modelo ? `Modelo: ${v.modelo}` : '',
            v.anio   ? `Año: ${v.anio}`      : '',
            v.color  ? `Color: ${v.color}`   : ''
        ].filter(Boolean).join('   ');

        const porTipo = (tipo) => incl.filter(i => i.tipo === tipo);
        const suma = (arr) => arr.reduce((s, i) => s + (Number(i.subtotal) || 0), 0);
        const mo = porTipo('mano_obra');
        const rp = porTipo('repuesto');

        const lista = (arr) => `<ul class="pdoc-lista">${arr.map(i =>
            `<li>${_esc(i.descripcion)}${Number(i.cantidad) !== 1 ? ` (x${_cant(i.cantidad)})` : ''}</li>`).join('')}</ul>`;

        const trabajo = `
            ${d.motivo ? `<p><b>Solicitud del cliente:</b> ${_esc(d.motivo)}</p>` : ''}
            ${d.diagnostico ? `<p><b>Diagnóstico:</b> ${_esc(d.diagnostico)}</p>` : ''}
            ${mo.length ? `<div class="pdoc-grupo">Trabajo mano de obra:</div>${lista(mo)}` : ''}
            ${rp.length ? `<div class="pdoc-grupo">Repuestos y materiales:</div>${lista(rp)}` : ''}
            ${incl.length === 0 ? '<p style="color:#777">Aún no hay trabajos cotizados.</p>' : ''}`;

        const filaValor = (txt, monto) =>
            `<tr><td>${txt}</td><td class="m">${_clp(monto)}</td></tr>`;

        const condiciones = d.condiciones
            ? `${_esc(d.condiciones)}<br>` : '';

        return `<style>${CSS}</style>
        <div class="pdoc">
            <h1 class="pdoc-titulo">PRESUPUESTO N°${_esc(num)}${d.version > 1 ? ` · v${d.version}` : ''}</h1>
            ${conEstado ? _banner(d) : ''}

            <div class="pdoc-cab">
                <div class="pdoc-logo">${logo
                    ? `<img src="${_esc(logo)}" alt="${_esc(t.nombre)}">`
                    : `<div style="font-size:20px;font-weight:800;text-align:center">${_esc(t.nombre)}</div>`}</div>
                <div class="pdoc-taller">
                    <div class="pdoc-taller-nombre">${_esc(t.nombre)}</div>
                    <table>
                        ${_filaId('RUT:', t.rut)}
                        ${_filaId('Giro:', t.giro)}
                        ${_filaId('Dirección:', ubic)}
                        ${_filaId('Teléfono:', t.telefono || t.whatsapp)}
                        ${_filaId('E-mail:', t.email)}
                        ${_filaId('Página web:', t.sitio_web)}
                        <tr><th>Fecha presupuesto:</th><td><b>${_fecha(d.fecha_emision, true)}</b></td></tr>
                    </table>
                </div>
            </div>

            <h2 class="pdoc-sec">Identificación Cliente y Vehículo</h2>
            <table class="pdoc-id">
                ${_filaId('Cliente', c.nombre)}
                ${_filaId('Rut', c.rut)}
                ${_filaId('Fono', c.telefono)}
                ${_filaId('Correo', c.email)}
                ${_filaId('Dirección', c.direccion)}
                ${_filaId('Vehículo', vehiculoTxt)}
                ${_filaId('Patente', v.patente)}
                ${_filaId('VIN', v.vin)}
                ${_filaId('Kilometraje', d.kilometraje ? Number(d.kilometraje).toLocaleString('es-CL') + ' km' : '')}
            </table>

            <h2 class="pdoc-sec">Trabajo a realizar</h2>
            <div class="pdoc-trabajo">${trabajo}</div>

            <h2 class="pdoc-sec">Valores</h2>
            <table class="pdoc-valores">
                ${mo.length ? filaValor('Mano de obra (IVA incl.)', suma(mo)) : ''}
                ${rp.length ? filaValor('Repuestos y materiales (IVA incl.)', suma(rp)) : ''}
            </table>
            <div class="pdoc-totales">
                <div><span>NETO:</span><span>${_clp(d.neto)}.-</span></div>
                <div><span>IVA ${Math.round((typeof IVA_TASA !== 'undefined' ? IVA_TASA : 0.19) * 100)}%:</span><span>${_clp(d.iva)}.-</span></div>
                <div class="tot"><span>TOTAL:</span><span>${_clp(d.total)}.-</span></div>
            </div>

            ${opc.length ? `
            <div class="pdoc-opc">
                <b>Trabajos opcionales recomendados</b> (no incluidos en el total):
                <table class="pdoc-valores" style="margin-top:4px">
                    ${opc.map(i => filaValor(_esc(i.descripcion) + (Number(i.cantidad) !== 1 ? ` (x${_cant(i.cantidad)})` : ''), i.subtotal)).join('')}
                </table>
            </div>` : ''}

            <div class="pdoc-nota">
                ${condiciones}
                Presupuesto válido hasta el ${_fecha(d.fecha_vencimiento)}${d.dias_validez ? ` (${d.dias_validez} días)` : ''}.
                Los precios pueden variar si cambia la disponibilidad de los repuestos.
                Trabajos adicionales detectados durante la reparación se informarán antes de ejecutarse.
                ${t.pie ? `<br>${_esc(t.pie)}` : ''}
            </div>
        </div>`;
    }

    /** Abre el presupuesto en una ventana lista para imprimir o guardar como PDF. */
    function imprimir(d) {
        const w = window.open('', '_blank');
        if (!w) return false;
        w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Presupuesto ${_esc(d.numero)}${d.taller?.nombre ? ' — ' + _esc(d.taller.nombre) : ''}</title>
            <style>body{margin:0;background:#fff}</style></head>
            <body>${html(d)}</body></html>`);
        w.document.close();
        // Esperar el logo: si no, el PDF sale sin él.
        let impreso = false;
        const ir = () => { if (!impreso) { impreso = true; w.focus(); w.print(); } };
        w.addEventListener('load', ir);
        setTimeout(ir, 1500);
        return true;
    }

    return { html, imprimir, css: CSS };

})();
