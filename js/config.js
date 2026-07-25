// ================================================================
// CONFIG.JS — Configuración global de ARM TALLER
// Incluir PRIMERO antes que cualquier otro script
// Mismo patrón que ARM Universal (ROL_MODULOS × modulos_activos)
// ================================================================

// ── Supabase (misma instancia que ARM Universal) ─────────────────
const SUPABASE_URL  = 'https://rhggndoqjnlzmfxsllto.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_u1IIm1z1Ke3g-6SHBs1CQg_BBcqYup1';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Roles y permisos ─────────────────────────────────────────────
// Define qué paneles puede ver cada rol dentro del taller.
// Se cruza con modulos_activos de la empresa (planes) para el menú.
const ROL_MODULOS = {
    'admin': [
        'panel-dashboard',
        'panel-ordenes', 'panel-clientes', 'panel-vehiculos',
        'panel-ventas', 'panel-inventario',
        'panel-empresa', 'panel-usuarios'
    ],
    'recepcion': [
        'panel-dashboard',
        'panel-ordenes', 'panel-clientes', 'panel-vehiculos'
    ],
    'mecanico': [
        'panel-ordenes'
    ],
    'vendedor': [
        'panel-dashboard',
        'panel-ventas', 'panel-clientes', 'panel-inventario'
    ],
    'lector': [
        'panel-dashboard',
        'panel-ordenes', 'panel-clientes', 'panel-vehiculos',
        'panel-ventas', 'panel-inventario'
    ]
};

// ── Módulos de empresa → paneles ─────────────────────────────────
// Paneles que requieren que la empresa (taller) tenga el módulo
// activo en modulos_activos (jsonb). Los del Plan Básico no
// requieren nada; los de Profesional/Premium se agregarán aquí:
// ej. 'panel-agenda': 'agenda', 'panel-reportes': 'reportes'
const MODULO_REQUIERE = {
    // Plan Básico: sin requisitos
    // Profesional/Premium (futuro):
    // 'panel-agenda':    'agenda',
    // 'panel-compras':   'compras',
    // 'panel-reportes':  'reportes'
};

// ── Catálogo de paneles (título, tag y color) ────────────────────
const PANEL_INFO = {
    'panel-dashboard':  { titulo: 'Dashboard',          tag: 'admin',      label: 'GENERAL'    },
    'panel-ordenes':    { titulo: 'Órdenes de trabajo', tag: 'ordenes',    label: 'TALLER'     },
    'panel-clientes':   { titulo: 'Clientes',           tag: 'clientes',   label: 'CLIENTES'   },
    'panel-vehiculos':  { titulo: 'Vehículos',          tag: 'vehiculos',  label: 'VEHÍCULOS'  },
    'panel-ventas':     { titulo: 'Ventas',             tag: 'ventas',     label: 'VENTAS'     },
    'panel-inventario': { titulo: 'Inventario',         tag: 'inventario', label: 'REPUESTOS'  },
    'panel-empresa':    { titulo: 'Empresa',            tag: 'admin',      label: 'ADMIN'      },
    'panel-usuarios':   { titulo: 'Usuarios',           tag: 'admin',      label: 'ADMIN'      }
};

// ── Estados de órdenes de trabajo ────────────────────────────────
const OT_ESTADOS = [
    'recepcion', 'diagnostico', 'presupuesto', 'aprobada',
    'reparacion', 'lista', 'entregada', 'anulada'
];

// ── Estado global de la app ───────────────────────────────────────
window.appData = {
    usuario:  null,   // objeto usuario logueado
    empresa:  null,   // objeto empresa (taller) del usuario
    modulos:  [],     // paneles disponibles para este usuario+empresa
    cargado:  false
};
