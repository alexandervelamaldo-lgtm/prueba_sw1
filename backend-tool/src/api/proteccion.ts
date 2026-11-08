import type { Request, RequestHandler } from 'express';
import { HttpError, type AuthenticatedRequest } from './http.js';

/**
 * Las dos protecciones que se aplican a todo el servicio: cabeceras y tasa.
 *
 * Están juntas porque responden a la misma clase de problema —lo que se puede
 * hacer contra el servicio desde fuera— y separadas de `http.ts`, que trata de
 * lo que hace cada ruta con su petición.
 *
 * Cierran RNF-SEG-07 (política de contenido restrictiva) y RNF-SEG-08 (límite de
 * tasa en las rutas de IA y generación), que estaban escritos en el documento de
 * requisitos y no en el código. Un requisito no verificable no es un requisito:
 * por eso los dos vienen con pruebas que fallan si alguien quita el middleware.
 */

/**
 * Dónde puede el navegador conectarse además de a este mismo origen.
 *
 * Ollama corre en la máquina del usuario, no en la nuestra, y el navegador le
 * habla directamente para que el dictado y la guía funcionen sin conexión. Sin
 * estas dos entradas la política bloquearía justo la funcionalidad que hace que
 * la herramienta sirva en un aula sin internet.
 */
const CONEXIONES_LOCALES = ['http://localhost:11434', 'http://127.0.0.1:11434'] as const;

/**
 * La política de contenido, escrita una vez.
 *
 * `'unsafe-inline'` aparece en `style-src` y en ningún otro sitio: React escribe
 * atributos `style` en el lienzo —posición y tamaño de cada caja se calculan en
 * tiempo de ejecución— y sin eso el diagrama se dibuja apilado en la esquina. En
 * `script-src` no aparece, que es donde importaría: el `index.html` no lleva
 * ningún script en línea y Vite emite módulos con su propia URL.
 *
 * `frame-ancestors 'none'` no molesta a la aplicación de Android: un WebView
 * carga la página como documento principal, no dentro de un marco.
 */
const POLITICA_DE_CONTENIDO = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // `data:` y `blob:` son la foto que el usuario acaba de hacer: el navegador la
  // enseña antes de subirla y la referencia con una de esas dos formas.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // La voz de ElevenLabs se reproduce desde una URL `blob:`; sin esto el audio
  // no carga y el Modo IA cae a la voz del navegador.
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  `connect-src 'self' ${CONEXIONES_LOCALES.join(' ')}`,
].join('; ');

/** ¿Llegó la petición por HTTPS, directamente o a través del balanceador? */
function porHttps(request: Request): boolean {
  if (request.secure) return true;
  const reenviado = request.headers['x-forwarded-proto'];
  const valor = Array.isArray(reenviado) ? reenviado[0] : reenviado;
  return typeof valor === 'string' && valor.split(',')[0]?.trim() === 'https';
}

/**
 * Cabeceras de seguridad para todas las respuestas.
 *
 * No usa `helmet` porque son ocho cabeceras fijas y una dependencia con su
 * propio ciclo de vida por ocho cabeceras es peor trato del que parece; además
 * la política de contenido habría que escribirla igual, porque la de serie
 * bloquea el lienzo y Ollama.
 */
export function cabecerasDeSeguridad(): RequestHandler {
  return (request, response, next) => {
    response.setHeader('Content-Security-Policy', POLITICA_DE_CONTENIDO);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // El micrófono y la cámara son dos funciones de la herramienta —dictado e
    // importación desde foto—, así que se conceden a este origen y se niegan a
    // cualquier cosa incrustada. La geolocalización no se usa en ningún sitio.
    response.setHeader('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()');

    // HSTS solo cuando ya se está en HTTPS. Enviarlo desde `http://localhost`
    // dejaría el navegador del usuario obligado a usar HTTPS contra localhost
    // durante un año, y eso rompe la defensa del examen, que corre en claro.
    if (porHttps(request)) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  };
}

export interface OpcionesDeTasa {
  /** Anchura de la ventana móvil, en milisegundos. */
  ventanaMs: number;
  /** Peticiones admitidas dentro de la ventana. */
  maximo: number;
  /** Aparece en el mensaje de rechazo: «… de importación desde imagen». */
  nombre: string;
  /** Inyectable para las pruebas: evita relojes falsos globales. */
  ahora?: () => number;
}

/**
 * A quién se le cuentan las peticiones.
 *
 * Al usuario cuando hay sesión, y solo a la dirección cuando no la hay. Contar
 * siempre por dirección castigaría a un aula entera detrás del mismo NAT: uno
 * gastaría la cuota de los demás. Contar solo por usuario dejaría sin proteger
 * las rutas anteriores al inicio de sesión.
 */
function claveDe(request: Request): string {
  const usuario = (request as AuthenticatedRequest).user;
  if (usuario) return `u:${usuario.id}`;
  return `ip:${request.ip ?? 'desconocida'}`;
}

/**
 * Límite de tasa con ventana móvil, en memoria del proceso.
 *
 * En memoria porque hoy hay un proceso; el día que haya varios detrás de un
 * balanceador cada uno permitirá el máximo por su cuenta, y entonces esto se
 * cambia por el mismo contador en Redis sin tocar las rutas. Se deja dicho aquí
 * para que no se descubra en producción.
 *
 * Ventana móvil y no cubo por minuto: con un cubo, quien gaste su cuota en el
 * segundo 59 vuelve a tenerla entera en el 61, que es el doble del máximo en dos
 * segundos, justamente lo que un límite de tasa existe para impedir.
 */
export function limiteDeTasa(opciones: OpcionesDeTasa): RequestHandler {
  const { ventanaMs, maximo, nombre } = opciones;
  const ahora = opciones.ahora ?? Date.now;
  const visitas = new Map<string, number[]>();

  return (request, response, next) => {
    const instante = ahora();
    const desde = instante - ventanaMs;

    // Barrido perezoso: sin esto el mapa crece con cada dirección que haya
    // pasado alguna vez, y un servicio de larga vida acaba guardando memoria de
    // visitantes que no vuelven. Se hace solo cuando hay bastantes claves para
    // que valga la pena recorrerlas.
    if (visitas.size > 1000) {
      for (const [clave, marcas] of visitas) {
        if (marcas.length === 0 || marcas[marcas.length - 1]! <= desde) visitas.delete(clave);
      }
    }

    const clave = claveDe(request);
    const recientes = (visitas.get(clave) ?? []).filter((marca) => marca > desde);

    if (recientes.length >= maximo) {
      // El cliente necesita saber cuánto esperar; sin esto reintenta en bucle y
      // el límite acaba generando más carga de la que evita.
      const espera = Math.max(1, Math.ceil((recientes[0]! + ventanaMs - instante) / 1000));
      response.setHeader('Retry-After', String(espera));
      response.setHeader('X-RateLimit-Limit', String(maximo));
      response.setHeader('X-RateLimit-Remaining', '0');
      visitas.set(clave, recientes);
      next(
        new HttpError(
          429,
          `Demasiadas peticiones ${nombre}. Vuelve a intentarlo en ${espera} s.`,
          'DEMASIADAS_PETICIONES',
        ),
      );
      return;
    }

    recientes.push(instante);
    visitas.set(clave, recientes);
    response.setHeader('X-RateLimit-Limit', String(maximo));
    response.setHeader('X-RateLimit-Remaining', String(maximo - recientes.length));
    next();
  };
}
