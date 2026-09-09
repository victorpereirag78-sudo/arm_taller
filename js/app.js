// ================================================================
// APP.JS — Shell principal de ARM TALLER
// Guardia de sesión, menú dinámico, cambio de paneles, sidebar.
// Los paneles que no están escritos a mano en app.html se generan
// solos a partir de PANEL_INFO: agregar un módulo al catálogo basta.
// Depende de: config.js, auth.js, utils.js
// ================================================================

// ── Iconos SVG por panel ──────────────────────────────────────────
const ICONO_GENERICO = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const PANEL_ICONOS = {
    'panel-recepcion': '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-dashboard': '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="3" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="12" width="7" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="16" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>',
    'panel-ordenes':   '<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a4.5 4.5 0 0 0-5.9 5.9L3 18l3 3 5.8-5.8a4.5 4.5 0 0 0 5.9-5.9l-2.9 2.9-2.1-2.1 2.9-2.9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    'panel-presupuestos': '<svg viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M9 8h6M9 12h6M9 16h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-clientes':  '<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 20c.9-3.4 3.5-5 6.5-5s5.6 1.6 6.5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 15.5c1.6.7 2.7 2 3 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-vehiculos': '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12l1.5-4.5A2 2 0 0 1 8.4 6h7.2a2 2 0 0 1 1.9 1.5L19 12M5 12h14M5 12a2 2 0 0 0-2 2v3h2m14-5a2 2 0 0 1 2 2v3h-2m-14 0a2 2 0 1 0 4 0m-4 0h4m6 0a2 2 0 1 0 4 0m-4 0h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-agenda':    '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-mantenciones': '<svg viewBox="0 0 24 24" fill="none"><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10.5 19a2 2 0 0 0 3 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-ventas':    '<svg viewBox="0 0 24 24" fill="none"><path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-caja':      '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="6" width="19" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M6 10v4M18 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-cxc':       '<svg viewBox="0 0 24 24" fill="none"><path d="M3 17l6-6 4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 7h6v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'panel-inventario':'<svg viewBox="0 0 24 24" fill="none"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 8l9 5 9-5M12 13v8" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    'panel-proveedores':'<svg viewBox="0 0 24 24" fill="none"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="7" cy="18" r="1.8" stroke="currentColor" stroke-width="1.5"/><circle cx="17.5" cy="18" r="1.8" stroke="currentColor" stroke-width="1.5"/></svg>',
    'panel-compras':   '<svg viewBox="0 0 24 24" fill="none"><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.5a2 2 0 0 0 2-1.5L20.5 8H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="20" r="1.3" stroke="currentColor" stroke-width="1.5"/><circle cx="17" cy="20" r="1.3" stroke="currentColor" stroke-width="1.5"/></svg>',
    'panel-cxp':       '<svg viewBox="0 0 24 24" fill="none"><path d="M3 7l6 6 4-4 8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 11v6h-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'panel-empleados': '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="7" r="3.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 20c.8-3.9 3.8-6 7.5-6s6.7 2.1 7.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-comisiones':'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M14.5 9h-3.2a1.8 1.8 0 0 0 0 3.6h1.4a1.8 1.8 0 0 1 0 3.6H9.5M12 7.5v9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-reportes':  '<svg viewBox="0 0 24 24" fill="none"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-gastos':    '<svg viewBox="0 0 24 24" fill="none"><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 10h6M8 14h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-dte':       '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 8h8M8 12h8M8 16h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-taller':    '<svg viewBox="0 0 24 24" fill="none"><path d="M3 21V7l9-4 9 4v14" stroke="currentColor" stroke-width="1.5"/><path d="M9 21v-6h6v6" stroke="currentColor" stroke-width="1.5"/></svg>',
    'panel-usuarios':  '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.5"/></svg>',
    'panel-modulos':   '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>',
    'panel-importador':'<svg viewBox="0 0 24 24" fill="none"><path d="M12 15V3m0 12l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
};

// ── Secciones del menú ────────────────────────────────────────────
const NAV_SECCIONES = [
    { label: 'General',   paneles: ['panel-dashboard'] },
    { label: 'Taller',    paneles: ['panel-recepcion', 'panel-ordenes', 'panel-presupuestos',
                                    'panel-agenda', 'panel-vehiculos', 'panel-clientes',
                                    'panel-mantenciones'] },
    { label: 'Comercial', paneles: ['panel-ventas', 'panel-caja', 'panel-cxc', 'panel-inventario'] },
    { label: 'Compras',   paneles: ['panel-proveedores', 'panel-compras', 'panel-cxp'] },
    { label: 'Personal',  paneles: ['panel-empleados', 'panel-comisiones'] },
    { label: 'Análisis',  paneles: ['panel-gastos', 'panel-reportes', 'panel-dte'] },
    { label: 'Admin',     paneles: ['panel-taller', 'panel-usuarios', 'panel-modulos', 'panel-importador'] }
];

// ── Módulos con init() propio (patrón IIFE de Universal) ─────────
// Un panel sin entrada aquí muestra su placeholder "en construcción".
const PANEL_INIT = {
    'panel-dashboard': () => ModuloDashboard.init(),
    'panel-recepcion': () => ModuloRecepcion.init(),
    'panel-clientes':  () => ModuloClientes.init(),
    'panel-vehiculos': () => ModuloVehiculos.init(),
    'panel-ordenes':   () => ModuloOrdenes.init(),
    'panel-inventario':() => ModuloInventario.init(),
    'panel-ventas':    () => ModuloVentas.init(),
    'panel-caja':      () => ModuloCaja.init(),
    'panel-empleados': () => ModuloEmpleados.init(),
    'panel-comisiones':() => ModuloComisiones.init(),
    'panel-proveedores':() => ModuloProveedores.init(),
    'panel-compras':   () => ModuloCompras.init(),
    'panel-cxp':       () => ModuloCxp.init(),
    'panel-gastos':    () => ModuloGastos.init(),
    'panel-reportes':  () => ModuloReportes.init(),
    'panel-mantenciones':() => ModuloMantenciones.init(),
    'panel-presupuestos':() => ModuloPresupuestos.init(),
    'panel-agenda':    () => ModuloAgenda.init(),
    'panel-taller':    () => ModuloTaller.init(),
    'panel-cxc':       () => ModuloCxc.init(),
    'panel-usuarios':  () => ModuloUsuarios.init(),
    'panel-modulos':   () => ModuloModulos.init(),
    'panel-importador':() => ModuloImportador.init()
};

const _panelesIniciados = new Set();
let _panelActual = null;

// ── Arranque ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

    // Guardia: sin sesión → al login
    const sesion = Auth.restaurarSesion();
    if (!sesion) {
        window.location.href = 'login.html';
        return;
    }

    _pintarUsuarioEmpresa();
    _pintarAvisoContexto();
    reconstruirMenu();
    _bindSidebar();

    document.getElementById('btnLogout').addEventListener('click', Auth.logout);

    // Panel inicial: el primero disponible
    const inicial = window.appData.modulos[0] || 'panel-dashboard';
    mostrarPanel(inicial);

    // En segundo plano: si el token de sesión venció, al login
    Auth.verificarToken().then(ok => {
        if (!ok) {
            avisar('Tu sesión expiró. Vuelve a ingresar.', 'error');
            setTimeout(Auth.logout, 1200);
        }
    });
});

// ── Mostrar panel ─────────────────────────────────────────────────
function mostrarPanel(panelId) {
    if (!Auth.puedeAcceder(panelId)) {
        console.warn('[App] Sin acceso a', panelId);
        return;
    }

    _asegurarPanel(panelId);

    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(panelId)?.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(n =>
        n.classList.toggle('active', n.dataset.panel === panelId));

    const info = PANEL_INFO[panelId];
    document.getElementById('breadcrumbActual').textContent = info?.titulo || panelId;

    // Cerrar sidebar en móvil
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarOverlay').classList.remove('active');

    _panelActual = panelId;

    // Init del módulo (solo la primera vez que se abre)
    if (PANEL_INIT[panelId] && !_panelesIniciados.has(panelId)) {
        _panelesIniciados.add(panelId);
        PANEL_INIT[panelId]();
    }
}

/** Repinta cabecera, menú y aviso de contexto.
    Con reiniciarPaneles=true olvida qué módulos ya arrancaron, para que
    al cambiar de taller cada panel vuelva a pedir SUS datos y no siga
    mostrando los del taller anterior. */
function refrescarShell({ reiniciarPaneles = false } = {}) {
    if (reiniciarPaneles) _panelesIniciados.clear();
    _pintarUsuarioEmpresa();
    _pintarAvisoContexto();
    reconstruirMenu();
}

/** Barra de aviso mientras el superadmin trabaja dentro de otro taller. */
function _pintarAvisoContexto() {
    document.getElementById('avisoContexto')?.remove();
    if (!Auth.estaImpersonando?.()) return;

    const barra = document.createElement('div');
    barra.id = 'avisoContexto';
    barra.className = 'tll-aviso-contexto';
    barra.innerHTML =
        '<span>Estás trabajando dentro de <strong>'
        + esc(window.appData.empresa?.nombre || 'otro taller')
        + '</strong>. Todo lo que hagas queda en ese taller.</span>'
        + '<button class="tll-btn tll-btn--ghost" id="btnVolverSuper">Volver a ARM</button>';

    document.getElementById('appMain').prepend(barra);
    document.getElementById('btnVolverSuper').addEventListener('click', () => {
        Auth.volverASuperadmin();
        // Igual que al entrar: el token viaja en una cabecera fija
        window.location.reload();
    });
}

/** Rehacer el menú tras cambiar los módulos activos del taller. */
function reconstruirMenu() {
    _construirMenu();
    if (_panelActual && !Auth.puedeAcceder(_panelActual)) {
        mostrarPanel(window.appData.modulos[0] || 'panel-dashboard');
    } else if (_panelActual) {
        document.querySelectorAll('.nav-item').forEach(n =>
            n.classList.toggle('active', n.dataset.panel === _panelActual));
    }
}

// ── Privados ──────────────────────────────────────────────────────

/** Crea la <section> del panel si no está escrita a mano en app.html. */
function _asegurarPanel(panelId) {
    if (document.getElementById(panelId)) return;

    const info = PANEL_INFO[panelId] || { titulo: panelId, tag: 'admin', label: '' };
    const modulo = MODULOS_CATALOGO[PANEL_MODULO[panelId]];
    const slug = panelId.replace(/^panel-/, '');

    const sec = document.createElement('section');
    sec.className = 'panel';
    sec.id = panelId;
    sec.innerHTML = `
        <div class="panel-header">
            <h2>${esc(info.titulo)}</h2>
            <span class="panel-tag ${esc(info.tag)}">${esc(info.label)}</span>
        </div>
        <div class="panel-body" id="contenido-${esc(slug)}">
            <div class="placeholder-text">
                <strong>${esc(modulo?.nombre || info.titulo)}</strong> — módulo en construcción.<br>
                ${esc(modulo?.descripcion || '')}
            </div>
        </div>`;
    document.getElementById('panelArea').appendChild(sec);
}

function _pintarUsuarioEmpresa() {
    const { usuario, empresa } = window.appData;

    document.getElementById('empresaNombre').textContent = empresa?.nombre || 'Taller';
    document.getElementById('usuarioRol').textContent =
        ROL_INFO[usuario?.rol]?.nombre || usuario?.rol || '—';
    document.getElementById('userRut').textContent = usuario?.rut || '';
    document.getElementById('userAvatar').textContent =
        (usuario?.rut || '?').slice(0, 2);

    if (empresa?.logo_url) {
        document.getElementById('empresaLogo').innerHTML =
            `<img src="${esc(empresa.logo_url)}" alt="${esc(empresa.nombre)}"
                  style="width:100%;height:100%;object-fit:cover;border-radius:6px">`;
    }
}

function _construirMenu() {
    const nav = document.getElementById('sidebarNav');
    const disponibles = window.appData.modulos;

    nav.innerHTML = NAV_SECCIONES.map(sec => {
        const items = sec.paneles.filter(p => disponibles.includes(p));
        if (items.length === 0) return '';

        return `
        <div class="nav-section">
            <div class="nav-section-label">${sec.label}</div>
            ${items.map(p => `
                <button class="nav-item" data-panel="${p}" data-tooltip="${PANEL_INFO[p]?.titulo || p}">
                    <span class="nav-icon">${PANEL_ICONOS[p] || ICONO_GENERICO}</span>
                    <span class="nav-label">${PANEL_INFO[p]?.titulo || p}</span>
                </button>`).join('')}
        </div>`;
    }).join('');

    nav.querySelectorAll('.nav-item').forEach(btn =>
        btn.addEventListener('click', () => mostrarPanel(btn.dataset.panel)));
}

function _bindSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');

    // Desktop: colapsar/expandir
    document.getElementById('sidebarToggle').addEventListener('click', () =>
        sidebar.classList.toggle('collapsed'));

    // Móvil: abrir/cerrar con overlay
    document.getElementById('topbarToggle').addEventListener('click', () => {
        sidebar.classList.add('mobile-open');
        overlay.classList.add('active');
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('active');
    });
}
