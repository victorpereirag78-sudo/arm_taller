// ================================================================
// CONFIG.JS — Configuración global de ARM TALLER
// Incluir PRIMERO antes que cualquier otro script
//
// Modelo de permisos (3 capas, se cruzan en Auth.calcularModulos):
//   1. MODULOS_CATALOGO  → qué módulos existen y qué paneles aporta cada uno
//   2. empresas.modulos_activos (jsonb) → qué contrató ESTE taller
//   3. ROL_MODULOS       → qué puede ver cada rol dentro del taller
// ================================================================

// ── Supabase (misma instancia que ARM Universal) ─────────────────
const SUPABASE_URL  = 'https://rhggndoqjnlzmfxsllto.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_u1IIm1z1Ke3g-6SHBs1CQg_BBcqYup1';

// El token de sesión (sql/14_sesiones_taller.sql) viaja en una cabecera.
// Con él, las políticas RLS resuelven el empresa_id DENTRO de Postgres,
// en vez de confiar en el filtro que pone el navegador.
// En login.html no hay token todavía: el login va por RPC y no lo necesita.
const TLL_KEY_TOKEN = 'tll_token';

function _tllTokenGuardado() {
    try {
        return sessionStorage.getItem(TLL_KEY_TOKEN)
            || localStorage.getItem(TLL_KEY_TOKEN)
            || null;
    } catch { return null; }
}

const db = (() => {
    const token = _tllTokenGuardado();
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY,
        token ? { global: { headers: { 'x-taller-token': token } } } : undefined);
})();

// ── Planes comerciales ───────────────────────────────────────────
const PLANES = {
    basico:      { nombre: 'Básico',      orden: 1 },
    profesional: { nombre: 'Profesional', orden: 2 },
    premium:     { nombre: 'Premium',     orden: 3 }
};

// ================================================================
// CATÁLOGO DE MÓDULOS
// ================================================================
// Cada taller enciende/apaga módulos desde el panel "Módulos".
//   base:     true  → siempre activo, no se puede apagar
//   requiere: []    → módulos que deben estar activos antes que éste
//   paneles:  []    → paneles que aporta al menú
//   estado:   'ok' | 'beta' | 'pendiente'  (pendiente = aún no construido)
// ================================================================
const MODULOS_CATALOGO = {

    nucleo: {
        nombre: 'Núcleo del taller',
        icono: '🛠',
        descripcion: 'Recepción de vehículos, órdenes de trabajo, clientes y vehículos.',
        plan: 'basico', base: true, requiere: [], estado: 'ok',
        paneles: ['panel-dashboard', 'panel-recepcion', 'panel-ordenes',
                  'panel-clientes', 'panel-vehiculos']
    },

    presupuestos: {
        nombre: 'Presupuestos',
        icono: '📋',
        descripcion: 'Cotizaciones con vigencia, versiones, margen y aprobación antes de convertirlas en OT.',
        plan: 'basico', requiere: [], estado: 'ok',
        paneles: ['panel-presupuestos']
    },

    inventario: {
        nombre: 'Inventario de repuestos',
        icono: '📦',
        descripcion: 'Catálogo, stock, costo promedio ponderado, kardex, mínimos y alertas.',
        plan: 'basico', requiere: [], estado: 'ok',
        paneles: ['panel-inventario']
    },

    ventas: {
        nombre: 'Ventas de mostrador',
        icono: '🧾',
        descripcion: 'Venta directa de repuestos y servicios, con descuento de stock e IVA.',
        plan: 'basico', requiere: ['inventario'], estado: 'ok',
        paneles: ['panel-ventas']
    },

    caja: {
        nombre: 'Caja y pagos de clientes',
        icono: '💵',
        descripcion: 'Apertura y cierre de turno, cobro de órdenes, medios de pago y arqueo.',
        plan: 'basico', requiere: [], estado: 'ok',
        paneles: ['panel-caja']
    },

    cxc: {
        nombre: 'Cuentas por cobrar',
        icono: '📈',
        descripcion: 'Deuda de clientes por órdenes y documentos, antigüedad y cobro desde caja.',
        plan: 'profesional', requiere: ['caja'], estado: 'ok',
        paneles: ['panel-cxc']
    },

    compras: {
        nombre: 'Compras y proveedores',
        icono: '🚚',
        descripcion: 'Órdenes de compra, recepción de mercadería y costo promedio ponderado.',
        plan: 'profesional', requiere: ['inventario'], estado: 'ok',
        paneles: ['panel-proveedores', 'panel-compras']
    },

    cxp: {
        nombre: 'Cuentas por pagar',
        icono: '📉',
        descripcion: 'Facturas de proveedor, antigüedad de la deuda y pagos desde caja.',
        plan: 'profesional', requiere: ['compras'], estado: 'ok',
        paneles: ['panel-cxp']
    },

    empleados: {
        nombre: 'Empleados',
        icono: '👷',
        descripcion: 'Ficha del personal, cargo, especialidad, tarifa hora y reglas de comisión.',
        plan: 'profesional', requiere: [], estado: 'ok',
        paneles: ['panel-empleados']
    },

    comisiones: {
        nombre: 'Comisiones',
        icono: '💰',
        descripcion: 'Liquidación mensual por mecánico y vendedor, aprobación y pago desde caja.',
        plan: 'profesional', requiere: ['empleados'], estado: 'ok',
        paneles: ['panel-comisiones']
    },

    agenda: {
        nombre: 'Agenda de citas',
        icono: '📅',
        descripcion: 'Tablero por bahía y mecánico, con bloqueo de choques y control de inasistencia.',
        plan: 'profesional', requiere: [], estado: 'ok',
        paneles: ['panel-agenda']
    },

    mantenciones: {
        nombre: 'Mantenciones programadas',
        icono: '🔔',
        descripcion: 'Recordatorios por kilometraje o fecha, revisión técnica, permiso y SOAP.',
        plan: 'profesional', requiere: [], estado: 'ok',
        paneles: ['panel-mantenciones']
    },

    reportes: {
        nombre: 'Reportes y rentabilidad',
        icono: '📊',
        descripcion: 'Resultado del periodo, margen por OT, productividad y capital dormido.',
        plan: 'premium', requiere: [], estado: 'ok',
        paneles: ['panel-reportes']
    },

    facturacion: {
        nombre: 'Facturación electrónica (SII)',
        icono: '🧮',
        descripcion: 'Boleta y factura electrónica, folios CAF y libro de ventas.',
        plan: 'premium', requiere: ['ventas'], estado: 'pendiente',
        paneles: ['panel-dte']
    },

    administracion: {
        nombre: 'Administración',
        icono: '⚙',
        descripcion: 'Datos del taller, usuarios, roles, módulos y administración de talleres.',
        plan: 'basico', base: true, requiere: [], estado: 'ok',
        paneles: ['panel-taller', 'panel-usuarios', 'panel-modulos']
    }
};

// ── Derivados del catálogo (no editar a mano) ────────────────────
// panel → módulo que lo habilita. Los módulos base no exigen nada.
const MODULO_REQUIERE = Object.entries(MODULOS_CATALOGO)
    .reduce((acc, [clave, m]) => {
        if (!m.base) m.paneles.forEach(p => { acc[p] = clave; });
        return acc;
    }, {});

// panel → módulo (incluye los base), para saber de dónde viene un panel
const PANEL_MODULO = Object.entries(MODULOS_CATALOGO)
    .reduce((acc, [clave, m]) => {
        m.paneles.forEach(p => { acc[p] = clave; });
        return acc;
    }, {});

/** ¿El módulo está activo para esta empresa, con todas sus dependencias? */
function moduloHabilitado(clave, modulosEmpresa, _visitados = new Set()) {
    const m = MODULOS_CATALOGO[clave];
    if (!m) return false;
    if (m.base) return true;
    if (modulosEmpresa?.[clave] !== true) return false;

    // Dependencias (con corte de ciclos por si el catálogo queda mal armado)
    if (_visitados.has(clave)) return true;
    _visitados.add(clave);
    return (m.requiere || []).every(dep => moduloHabilitado(dep, modulosEmpresa, _visitados));
}

// ── Roles y permisos ─────────────────────────────────────────────
// Qué paneles puede ver cada rol. Se cruza con los módulos activos:
// si el taller no contrató el módulo, el panel no aparece aunque el rol lo tenga.
const ROL_MODULOS = {
    'admin': [
        'panel-dashboard', 'panel-recepcion', 'panel-ordenes', 'panel-presupuestos',
        'panel-clientes', 'panel-vehiculos', 'panel-agenda', 'panel-mantenciones',
        'panel-ventas', 'panel-caja', 'panel-cxc', 'panel-inventario',
        'panel-proveedores', 'panel-compras', 'panel-cxp',
        'panel-empleados', 'panel-comisiones',
        'panel-reportes', 'panel-dte',
        'panel-taller', 'panel-usuarios', 'panel-modulos'
    ],
    'jefe_taller': [
        'panel-dashboard', 'panel-recepcion', 'panel-ordenes', 'panel-presupuestos',
        'panel-clientes', 'panel-vehiculos', 'panel-agenda', 'panel-mantenciones',
        'panel-inventario', 'panel-empleados', 'panel-comisiones', 'panel-reportes'
    ],
    'recepcion': [
        'panel-dashboard', 'panel-recepcion', 'panel-ordenes', 'panel-presupuestos',
        'panel-clientes', 'panel-vehiculos', 'panel-agenda', 'panel-mantenciones'
    ],
    'mecanico': [
        'panel-ordenes'
    ],
    'vendedor': [
        'panel-dashboard', 'panel-ventas', 'panel-presupuestos',
        'panel-clientes', 'panel-inventario'
    ],
    'bodeguero': [
        'panel-inventario', 'panel-proveedores', 'panel-compras'
    ],
    'cajero': [
        'panel-dashboard', 'panel-caja', 'panel-ventas', 'panel-cxc', 'panel-clientes'
    ],
    'contador': [
        'panel-dashboard', 'panel-caja', 'panel-cxc', 'panel-cxp',
        'panel-compras', 'panel-comisiones', 'panel-reportes', 'panel-dte'
    ],
    'lector': [
        'panel-dashboard', 'panel-ordenes', 'panel-clientes', 'panel-vehiculos',
        'panel-ventas', 'panel-inventario', 'panel-reportes'
    ]
};

const ROL_INFO = {
    admin:       { nombre: 'Administrador' },
    jefe_taller: { nombre: 'Jefe de taller' },
    recepcion:   { nombre: 'Recepción' },
    mecanico:    { nombre: 'Mecánico' },
    vendedor:    { nombre: 'Vendedor' },
    bodeguero:   { nombre: 'Bodeguero' },
    cajero:      { nombre: 'Cajero' },
    contador:    { nombre: 'Contador' },
    lector:      { nombre: 'Solo lectura' }
};

// ── Catálogo de paneles (título, tag y color) ────────────────────
const PANEL_INFO = {
    'panel-dashboard':    { titulo: 'Dashboard',          tag: 'admin',      label: 'GENERAL'   },
    'panel-recepcion':    { titulo: 'Recepción',          tag: 'ordenes',    label: 'INGRESO'   },
    'panel-ordenes':      { titulo: 'Órdenes de trabajo', tag: 'ordenes',    label: 'TALLER'    },
    'panel-presupuestos': { titulo: 'Presupuestos',       tag: 'ordenes',    label: 'COTIZAR'   },
    'panel-clientes':     { titulo: 'Clientes',           tag: 'clientes',   label: 'CLIENTES'  },
    'panel-vehiculos':    { titulo: 'Vehículos',          tag: 'vehiculos',  label: 'VEHÍCULOS' },
    'panel-agenda':       { titulo: 'Agenda',             tag: 'ordenes',    label: 'CITAS'     },
    'panel-mantenciones': { titulo: 'Mantenciones',       tag: 'vehiculos',  label: 'RECORDAR'  },
    'panel-ventas':       { titulo: 'Ventas',             tag: 'ventas',     label: 'VENTAS'    },
    'panel-caja':         { titulo: 'Caja',               tag: 'ventas',     label: 'PAGOS'     },
    'panel-cxc':          { titulo: 'Cuentas por cobrar', tag: 'ventas',     label: 'COBRAR'    },
    'panel-inventario':   { titulo: 'Inventario',         tag: 'inventario', label: 'REPUESTOS' },
    'panel-proveedores':  { titulo: 'Proveedores',        tag: 'inventario', label: 'COMPRAS'   },
    'panel-compras':      { titulo: 'Compras',            tag: 'inventario', label: 'COMPRAS'   },
    'panel-cxp':          { titulo: 'Cuentas por pagar',  tag: 'inventario', label: 'PAGAR'     },
    'panel-empleados':    { titulo: 'Empleados',          tag: 'clientes',   label: 'PERSONAL'  },
    'panel-comisiones':   { titulo: 'Comisiones',         tag: 'ventas',     label: 'PERSONAL'  },
    'panel-reportes':     { titulo: 'Reportes',           tag: 'admin',      label: 'ANÁLISIS'  },
    'panel-dte':          { titulo: 'Facturación',        tag: 'ventas',     label: 'SII'       },
    'panel-taller':       { titulo: 'Mi taller',          tag: 'admin',      label: 'ADMIN'     },
    'panel-usuarios':     { titulo: 'Usuarios',           tag: 'admin',      label: 'ADMIN'     },
    'panel-modulos':      { titulo: 'Módulos',            tag: 'admin',      label: 'ADMIN'     }
};

// ── Estados de órdenes de trabajo ────────────────────────────────
const OT_ESTADOS = [
    'recepcion', 'diagnostico', 'presupuesto', 'aprobada',
    'reparacion', 'lista', 'entregada', 'anulada'
];

// ── Parámetros de negocio (por ahora fijos; luego por empresa) ────
const IVA_TASA = 0.19;

// ── Estado global de la app ───────────────────────────────────────
window.appData = {
    usuario:  null,   // objeto usuario logueado
    empresa:  null,   // objeto empresa (taller) del usuario
    modulos:  [],     // paneles disponibles para este usuario+empresa
    cargado:  false
};
