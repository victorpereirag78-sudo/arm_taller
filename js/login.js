// ================================================================
// LOGIN.JS — Lógica del formulario de login
// Depende de: config.js, auth.js
// ================================================================

// ── Elementos del DOM ─────────────────────────────────────────────
const form       = document.getElementById('loginForm');
const inputRut   = document.getElementById('rut');
const inputPass  = document.getElementById('pass');
const chkRecordar= document.getElementById('recordar');
const btnLogin   = document.getElementById('btnLogin');
const togglePass = document.getElementById('togglePass');
const alertError = document.getElementById('alertError');
const rutError   = document.getElementById('rutError');
const passError  = document.getElementById('passError');

// ── Al cargar la página ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

    // Si ya hay sesión activa → redirigir directamente al sistema
    const sesion = Auth.restaurarSesion();
    if (sesion) {
        redirigirAlSistema(sesion);
        return;
    }

    // Autocompletar RUT si fue guardado previamente
    const rutGuardado = Auth.getRutRecordado();
    if (rutGuardado) {
        inputRut.value = rutGuardado;
        chkRecordar.checked = true;
        inputPass.focus();
    } else {
        inputRut.focus();
    }

    // Formatear RUT mientras escribe
    inputRut.addEventListener('input', () => {
        inputRut.value = formatearRut(inputRut.value);
        limpiarError(inputRut, rutError);
    });

    inputPass.addEventListener('input', () => {
        limpiarError(inputPass, passError);
    });

    // Toggle mostrar/ocultar contraseña
    togglePass.addEventListener('click', () => {
        const esTexto = inputPass.type === 'text';
        inputPass.type = esTexto ? 'password' : 'text';
        togglePass.setAttribute('aria-label', esTexto ? 'Mostrar contraseña' : 'Ocultar contraseña');
    });

    // Submit del formulario
    form.addEventListener('submit', manejarLogin);
});

// ── Manejar login ─────────────────────────────────────────────────
async function manejarLogin(e) {
    e.preventDefault();

    const rut  = inputRut.value.trim();
    const pass = inputPass.value.trim();
    const recordar = chkRecordar.checked;

    // Validación local antes de ir a Supabase
    if (!validarCampos(rut, pass)) return;

    // Activar estado de carga
    setLoading(true);
    ocultarAlerta();

    const resultado = await Auth.login(normalizarRut(rut), pass, recordar);

    if (!resultado.ok) {
        setLoading(false);
        mostrarAlerta(resultado.error);
        // Si el error es de credenciales, limpiar contraseña
        if (resultado.error.includes('contraseña') || resultado.error.includes('RUT')) {
            inputPass.value = '';
            inputPass.focus();
        }
        return;
    }

    // Login exitoso → redirigir
    redirigirAlSistema(resultado.usuario);
}

// ── Redirección post-login ────────────────────────────────────────
function redirigirAlSistema(sesion) {
    // El primer módulo disponible determina la página de destino
    // Por ahora todo va a app.html; la app decide qué panel mostrar
    // según appData.modulos[0]
    window.location.href = 'app.html';
}

// ── Validaciones ──────────────────────────────────────────────────
function validarCampos(rut, pass) {
    let valido = true;

    if (!rut) {
        mostrarErrorCampo(inputRut, rutError, 'Ingresa tu RUT.');
        valido = false;
    } else if (!validarRutChileno(normalizarRut(rut))) {
        mostrarErrorCampo(inputRut, rutError, 'RUT inválido. Verifica el formato.');
        valido = false;
    }

    if (!pass) {
        mostrarErrorCampo(inputPass, passError, 'Ingresa tu contraseña.');
        valido = false;
    } else if (pass.length < 4) {
        mostrarErrorCampo(inputPass, passError, 'La contraseña es demasiado corta.');
        valido = false;
    }

    return valido;
}

// ── Validar RUT chileno ───────────────────────────────────────────
function validarRutChileno(rut) {
    if (!rut || typeof rut !== 'string') return false;
    const limpio = rut.replace(/[.\-]/g, '').toUpperCase();
    if (limpio.length < 2) return false;

    const cuerpo = limpio.slice(0, -1);
    const dv     = limpio.slice(-1);

    if (!/^\d+$/.test(cuerpo)) return false;

    let suma = 0;
    let mult = 2;
    for (let i = cuerpo.length - 1; i >= 0; i--) {
        suma += parseInt(cuerpo[i]) * mult;
        mult = mult === 7 ? 2 : mult + 1;
    }

    const dvEsperado = 11 - (suma % 11);
    const dvCalc = dvEsperado === 11 ? '0'
                 : dvEsperado === 10 ? 'K'
                 : String(dvEsperado);

    return dv === dvCalc;
}

// ── Normalizar RUT ────────────────────────────────────────────────
// Convierte "12.345.678-9" → "12345678-9"
function normalizarRut(rut) {
    return rut.replace(/\./g, '').toUpperCase().trim();
}

// ── Formatear RUT mientras escribe ───────────────────────────────
// Convierte "123456789" → "12.345.678-9"
function formatearRut(rut) {
    let limpio = rut.replace(/[^0-9kK]/g, '').toUpperCase();
    if (limpio.length === 0) return '';
    if (limpio.length === 1) return limpio;

    const dv     = limpio.slice(-1);
    const cuerpo = limpio.slice(0, -1);

    // Formatear cuerpo con puntos
    let cuerpoFormateado = '';
    for (let i = cuerpo.length - 1, count = 0; i >= 0; i--, count++) {
        if (count > 0 && count % 3 === 0) cuerpoFormateado = '.' + cuerpoFormateado;
        cuerpoFormateado = cuerpo[i] + cuerpoFormateado;
    }

    return `${cuerpoFormateado}-${dv}`;
}

// ── UI helpers ────────────────────────────────────────────────────
function setLoading(activo) {
    btnLogin.disabled = activo;
    btnLogin.classList.toggle('loading', activo);
}

function mostrarAlerta(mensaje) {
    alertError.textContent = mensaje;
    alertError.classList.add('visible');
}

function ocultarAlerta() {
    alertError.classList.remove('visible');
    alertError.textContent = '';
}

function mostrarErrorCampo(input, span, mensaje) {
    input.classList.add('error');
    span.textContent = mensaje;
}

function limpiarError(input, span) {
    input.classList.remove('error');
    span.textContent = '';
    ocultarAlerta();
}
