// ================================================================
// APP.JS — Shell principal de ARM TALLER
// Guardia de sesión, menú dinámico, cambio de paneles, sidebar.
// Depende de: config.js, auth.js
// ================================================================

// ── Iconos SVG por panel ──────────────────────────────────────────
const PANEL_ICONOS = {
    'panel-dashboard': '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="3" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="12" width="7" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="16" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>',
    'panel-ordenes':   '<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a4.5 4.5 0 0 0-5.9 5.9L3 18l3 3 5.8-5.8a4.5 4.5 0 0 0 5.9-5.9l-2.9 2.9-2.1-2.1 2.9-2.9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    'panel-clientes':  '<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 20c.9-3.4 3.5-5 6.5-5s5.6 1.6 6.5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 15.5c1.6.7 2.7 2 3 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-vehiculos': '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12l1.5-4.5A2 2 0 0 1 8.4 6h7.2a2 2 0 0 1 1.9 1.5L19 12M5 12h14M5 12a2 2 0 0 0-2 2v3h2m14-5a2 2 0 0 1 2 2v3h-2m-14 0a2 2 0 1 0 4 0m-4 0h4m6 0a2 2 0 1 0 4 0m-4 0h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-ventas':    '<svg viewBox="0 0 24 24" fill="none"><path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'panel-inventario':'<svg viewBox="0 0 24 24" fill="none"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 8l9 5 9-5M12 13v8" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    'panel-empresa':   '<svg viewBox="0 0 24 24" fill="none"><path d="M3 21V7l9-4 9 4v14" stroke="currentColor" stroke-width="1.5"/><path d="M9 21v-6h6v6" stroke="currentColor" stroke-width="1.5"/></svg>',
    'panel-usuarios':  '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.5"/></svg>'
};

// ── Secciones del menú ────────────────────────────────────────────
const NAV_SECCIONES = [
    { label: 'General',   paneles: ['panel-dashboard'] },
    { label: 'Taller',    paneles: ['panel-ordenes', 'panel-vehiculos', 'panel-clientes'] },
    { label: 'Comercial', paneles: ['panel-ventas', 'panel-inventario'] },
    { label: 'Admin',     paneles: ['panel-empresa', 'panel-usuarios'] }
];

// ── Módulos con init() propio (patrón IIFE de Universal) ─────────
const PANEL_INIT = {
    'panel-dashboard': () => ModuloDashboard.init()
    // 'panel-clientes': () => ModuloClientes.init(),  // próximos
    // 'panel-ordenes':  () => ModuloOrdenes.init(),
};

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
    _construirMenu();
    _bindSidebar();

    document.getElementById('btnLogout').addEventListener('click', Auth.logout);

    // Panel inicial: el primero disponible
    const inicial = window.appData.modulos[0] || 'panel-dashboard';
    mostrarPanel(inicial);
});

// ── Mostrar panel ─────────────────────────────────────────────────
function mostrarPanel(panelId) {
    if (!Auth.puedeAcceder(panelId)) {
        console.warn('[App] Sin acceso a', panelId);
        return;
    }

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
    if (PANEL_INIT[panelId] && !PANEL_INIT[panelId]._done) {
        PANEL_INIT[panelId]();
        PANEL_INIT[panelId]._done = true;
    }
}

// ── Privados ──────────────────────────────────────────────────────
function _pintarUsuarioEmpresa() {
    const { usuario, empresa } = window.appData;

    document.getElementById('empresaNombre').textContent = empresa?.nombre || 'Taller';
    document.getElementById('usuarioRol').textContent = usuario?.rol || '—';
    document.getElementById('userRut').textContent = usuario?.rut || '';
    document.getElementById('userAvatar').textContent =
        (usuario?.rut || '?').slice(0, 2);

    if (empresa?.logo_url) {
        document.getElementById('empresaLogo').innerHTML =
            `<img src="${empresa.logo_url}" alt="${empresa.nombre}"
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
                    <span class="nav-icon">${PANEL_ICONOS[p] || ''}</span>
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
