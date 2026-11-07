import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { loadConfig } from '../config.js';
import { createApp, createDependencies, type AppDependencies } from '../app.js';
import { LocalIdentityProvider } from '../auth/identity.js';
import { cabecerasDeSeguridad, limiteDeTasa } from './proteccion.js';
import { HttpError } from './http.js';

/**
 * Pruebas de las dos protecciones transversales.
 *
 * Las de la unidad usan un reloj inyectado en vez de temporizadores falsos: una
 * ventana de un minuto probada con esperas reales tarda un minuto, y probada con
 * relojes globales falsos rompe cualquier otra cosa del proceso que mire la hora.
 *
 * Las de integración levantan el servicio entero, porque lo que puede fallar de
 * verdad no es el middleware —son quince líneas— sino que esté *montado* donde
 * se cree. Un límite de tasa colgado del router equivocado pasa igual de
 * inadvertido que uno que no existe.
 */

interface Espia {
  cabeceras: Record<string, string>;
  error: unknown;
  siguio: boolean;
}

/** Ejecuta el middleware una vez sobre una petición inventada. */
function ejecutar(
  handler: RequestHandler,
  peticion: Partial<Request> & Record<string, unknown> = {},
): Espia {
  const espia: Espia = { cabeceras: {}, error: undefined, siguio: false };
  const respuesta = {
    setHeader(nombre: string, valor: string | number) {
      espia.cabeceras[nombre] = String(valor);
    },
  } as unknown as Response;
  const next: NextFunction = (error?: unknown) => {
    if (error === undefined) espia.siguio = true;
    else espia.error = error;
  };

  handler({ ip: '10.0.0.1', headers: {}, ...peticion } as Request, respuesta, next);
  return espia;
}

describe('límite de tasa', () => {
  it('deja pasar hasta el máximo y rechaza el siguiente con 429', () => {
    let reloj = 1_000;
    const limite = limiteDeTasa({
      ventanaMs: 60_000,
      maximo: 3,
      nombre: 'de prueba',
      ahora: () => reloj,
    });

    for (let i = 0; i < 3; i += 1) {
      reloj += 100;
      expect(ejecutar(limite).siguio).toBe(true);
    }

    reloj += 100;
    const rechazo = ejecutar(limite);
    expect(rechazo.siguio).toBe(false);
    expect(rechazo.error).toBeInstanceOf(HttpError);
    expect((rechazo.error as HttpError).status).toBe(429);
    expect((rechazo.error as HttpError).code).toBe('DEMASIADAS_PETICIONES');
  });

  it('dice cuántos segundos hay que esperar', () => {
    let reloj = 0;
    const limite = limiteDeTasa({
      ventanaMs: 10_000,
      maximo: 1,
      nombre: 'de prueba',
      ahora: () => reloj,
    });

    ejecutar(limite);
    reloj += 4_000;
    const rechazo = ejecutar(limite);

    // La primera visita fue en 0 y la ventana dura 10 s: quedan 6.
    expect(rechazo.cabeceras['Retry-After']).toBe('6');
    expect(rechazo.cabeceras['X-RateLimit-Remaining']).toBe('0');
  });

  /**
   * Esta es la razón de que la ventana sea móvil y no un cubo por minuto. Con un
   * cubo, la cuota entera vuelve de golpe al cambiar de minuto y se pueden hacer
   * el doble de peticiones en dos segundos.
   */
  it('la cuota se recupera poco a poco, no de golpe', () => {
    let reloj = 0;
    const limite = limiteDeTasa({
      ventanaMs: 1_000,
      maximo: 2,
      nombre: 'de prueba',
      ahora: () => reloj,
    });

    ejecutar(limite); // en 0
    reloj = 500;
    ejecutar(limite); // en 500
    reloj = 900;
    expect(ejecutar(limite).siguio).toBe(false);

    // En 1 100 ha caducado la de 0, pero no la de 500: entra una y solo una.
    reloj = 1_100;
    expect(ejecutar(limite).siguio).toBe(true);
    expect(ejecutar(limite).siguio).toBe(false);
  });

  it('cuenta por usuario cuando hay sesión, no por dirección', () => {
    const limite = limiteDeTasa({ ventanaMs: 60_000, maximo: 1, nombre: 'de prueba' });

    // Dos usuarios distintos detrás de la misma IP: el aula entera comparte
    // salida a internet y uno no debe gastar la cuota del otro.
    expect(ejecutar(limite, { user: { id: 'ana' } }).siguio).toBe(true);
    expect(ejecutar(limite, { user: { id: 'beto' } }).siguio).toBe(true);
    expect(ejecutar(limite, { user: { id: 'ana' } }).siguio).toBe(false);
  });

  it('sin sesión cuenta por dirección', () => {
    const limite = limiteDeTasa({ ventanaMs: 60_000, maximo: 1, nombre: 'de prueba' });

    expect(ejecutar(limite, { ip: '1.1.1.1' }).siguio).toBe(true);
    expect(ejecutar(limite, { ip: '2.2.2.2' }).siguio).toBe(true);
    expect(ejecutar(limite, { ip: '1.1.1.1' }).siguio).toBe(false);
  });
});

describe('cabeceras de seguridad', () => {
  it('la política de contenido no permite scripts en línea', () => {
    const { cabeceras } = ejecutar(cabecerasDeSeguridad());
    const politica = cabeceras['Content-Security-Policy'] ?? '';

    expect(politica).toContain("script-src 'self'");
    expect(politica).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(politica).toContain("object-src 'none'");
    expect(politica).toContain("frame-ancestors 'none'");
  });

  /**
   * El lienzo coloca cada caja con un atributo `style` calculado, así que sin
   * esto el diagrama se dibuja apilado en la esquina. Queda escrito en una
   * prueba para que quien endurezca la política sepa qué se rompe.
   */
  it('permite estilos en línea, que es lo que el lienzo necesita', () => {
    const { cabeceras } = ejecutar(cabecerasDeSeguridad());
    expect(cabeceras['Content-Security-Policy']).toContain("style-src 'self' 'unsafe-inline'");
  });

  /**
   * La voz de ElevenLabs llega como un `Blob` y se reproduce desde una URL
   * `blob:`. Sin `media-src`, la política cae en `default-src 'self'`, el audio
   * no carga y el Modo IA habla con la voz del navegador.
   */
  it('deja reproducir el audio de la voz del servidor', () => {
    const { cabeceras } = ejecutar(cabecerasDeSeguridad());
    expect(cabeceras['Content-Security-Policy']).toContain("media-src 'self' blob:");
  });

  it('deja hablar con Ollama, que corre en la máquina del usuario', () => {
    const { cabeceras } = ejecutar(cabecerasDeSeguridad());
    expect(cabeceras['Content-Security-Policy']).toContain('http://localhost:11434');
  });

  /**
   * Enviar HSTS desde `http://localhost` deja el navegador obligado a usar HTTPS
   * contra localhost durante un año. Eso rompe la defensa, que corre en claro, y
   * se arregla borrando el estado del navegador: es de los errores más caros de
   * los baratos.
   */
  it('no envía HSTS en claro y sí detrás de un balanceador con TLS', () => {
    expect(ejecutar(cabecerasDeSeguridad()).cabeceras['Strict-Transport-Security']).toBeUndefined();

    const detras = ejecutar(cabecerasDeSeguridad(), {
      headers: { 'x-forwarded-proto': 'https,http' },
    });
    expect(detras.cabeceras['Strict-Transport-Security']).toContain('max-age=31536000');
  });

  it('concede micrófono y cámara a este origen y niega la geolocalización', () => {
    const { cabeceras } = ejecutar(cabecerasDeSeguridad());
    expect(cabeceras['Permissions-Policy']).toBe(
      'microphone=(self), camera=(self), geolocation=()',
    );
  });
});

describe('montado en el servicio', () => {
  let app: Express;
  let deps: AppDependencies;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'uml-proteccion-'));
    deps = await createDependencies({
      ...loadConfig({ SESSION_SECRET: 'secreto-de-prueba' }),
      dataDir,
    });
    app = createApp(deps).app;
  });

  afterEach(async () => {
    await deps.rooms.shutdown();
    if (deps.identity instanceof LocalIdentityProvider) await deps.identity.flush();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('toda respuesta lleva las cabeceras, incluida la de salud', async () => {
    const salud = await request(app).get('/salud');

    expect(salud.status).toBe(200);
    expect(salud.headers['content-security-policy']).toContain("default-src 'self'");
    expect(salud.headers['x-content-type-options']).toBe('nosniff');
    expect(salud.headers['x-powered-by']).toBeUndefined();
  });

  it('la generación se corta al undécimo intento del mismo minuto', async () => {
    const registro = await request(app)
      .post('/api/auth/registro')
      .send({ email: 'ana@ejemplo.com', password: 'contraseña-larga', nombre: 'Ana' });
    const token = registro.body.token as string;

    const proyecto = await request(app)
      .post('/api/proyectos')
      .set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'Tienda', descripcion: '' });
    const id = proyecto.body.proyecto.id as string;

    const generar = (): Promise<request.Response> =>
      request(app)
        .post(`/api/proyectos/${id}/generacion`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

    // El diagrama está vacío, así que las diez primeras responden 422: da igual,
    // lo que se comprueba es que se cuentan y que la undécima no llega a la ruta.
    for (let i = 0; i < 10; i += 1) {
      const respuesta = await generar();
      expect(respuesta.status).not.toBe(429);
    }

    const cortada = await generar();
    expect(cortada.status).toBe(429);
    expect(cortada.body.code).toBe('DEMASIADAS_PETICIONES');
    expect(cortada.headers['retry-after']).toBeDefined();
  });

  /**
   * El límite se monta por camino justamente para esto: si se hubiera puesto
   * envolviendo el router, abrir un diagrama gastaría cuota de generación y el
   * usuario se quedaría sin poder generar por haber trabajado.
   */
  it('leer el diagrama no gasta la cuota de generar', async () => {
    const registro = await request(app)
      .post('/api/auth/registro')
      .send({ email: 'beto@ejemplo.com', password: 'contraseña-larga', nombre: 'Beto' });
    const token = registro.body.token as string;

    const proyecto = await request(app)
      .post('/api/proyectos')
      .set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'Tienda', descripcion: '' });
    const id = proyecto.body.proyecto.id as string;

    for (let i = 0; i < 15; i += 1) {
      const respuesta = await request(app)
        .get(`/api/proyectos/${id}/diagrama`)
        .set('Authorization', `Bearer ${token}`);
      expect(respuesta.status).toBe(200);
      expect(respuesta.headers['x-ratelimit-limit']).toBeUndefined();
    }

    const generacion = await request(app)
      .post(`/api/proyectos/${id}/generacion`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(generacion.status).not.toBe(429);
  });
});
