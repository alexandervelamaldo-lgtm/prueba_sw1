import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { crearLectorSse, describeOperation, type EventoAsistente } from '@app/shared';
import { loadConfig } from './config.js';
import { createApp, createDependencies, type AppDependencies } from './app.js';
import { LocalIdentityProvider } from './auth/identity.js';
import type { AssistantEngine } from './ai/assistant.js';

/**
 * Pruebas de la API contra la aplicación entera.
 *
 * Se levanta el servicio real sobre un directorio temporal en vez de simular el
 * almacén: lo que hay que comprobar aquí es que las comprobaciones de permiso
 * están *conectadas*, y eso es justo lo que un doble de prueba oculta.
 */

let app: Express;
let deps: AppDependencies;
let dataDir: string;

async function registrarCompleto(
  email: string,
): Promise<{ token: string; codigoRecuperacion: string }> {
  const response = await request(app)
    .post('/api/auth/registro')
    .send({ email, password: 'contraseña-larga', nombre: email.split('@')[0] });
  expect(response.status).toBe(201);
  return response.body as { token: string; codigoRecuperacion: string };
}

async function registrar(email: string): Promise<string> {
  return (await registrarCompleto(email)).token;
}

async function crearProyecto(token: string, nombre = 'Tienda'): Promise<string> {
  const response = await request(app)
    .post('/api/proyectos')
    .set('Authorization', `Bearer ${token}`)
    .send({ nombre, descripcion: '' });
  expect(response.status).toBe(201);
  return response.body.proyecto.id as string;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'uml-api-'));
  const config = { ...loadConfig({ SESSION_SECRET: 'secreto-de-prueba' }), dataDir };
  deps = await createDependencies(config);
  app = createApp(deps).app;
});

afterEach(async () => {
  await deps.rooms.shutdown();
  // `LocalIdentityProvider.persist()` escribe el fichero de usuarios en segundo
  // plano y no devuelve nada que esperar. Sin este `flush`, el borrado del
  // directorio compite con una escritura a medio hacer y Windows responde
  // ENOTEMPTY: una prueba que falla por el desmontaje, no por lo que probaba.
  if (deps.identity instanceof LocalIdentityProvider) await deps.identity.flush();
  await rm(dataDir, { recursive: true, force: true });
});

describe('autenticación', () => {
  it('registra y devuelve un token utilizable', async () => {
    const token = await registrar('ana@ejemplo.com');
    const yo = await request(app).get('/api/auth/yo').set('Authorization', `Bearer ${token}`);

    expect(yo.status).toBe(200);
    expect(yo.body.usuario.email).toBe('ana@ejemplo.com');
  });

  it('rechaza una contraseña demasiado corta', async () => {
    const response = await request(app)
      .post('/api/auth/registro')
      .send({ email: 'ana@ejemplo.com', password: 'corta', nombre: 'Ana' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PASSWORD_CORTA');
  });

  it('no distingue correo inexistente de contraseña incorrecta', async () => {
    await registrar('ana@ejemplo.com');

    const malaPassword = await request(app)
      .post('/api/auth/acceso')
      .send({ email: 'ana@ejemplo.com', password: 'otra-contraseña' });
    const noExiste = await request(app)
      .post('/api/auth/acceso')
      .send({ email: 'nadie@ejemplo.com', password: 'otra-contraseña' });

    expect(malaPassword.status).toBe(401);
    expect(noExiste.status).toBe(401);
    expect(malaPassword.body.error).toBe(noExiste.body.error);
  });

  it('rechaza sin token', async () => {
    expect((await request(app).get('/api/proyectos')).status).toBe(401);
  });

  it('rechaza un token manipulado', async () => {
    const token = await registrar('ana@ejemplo.com');
    const manipulado = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;

    const response = await request(app)
      .get('/api/auth/yo')
      .set('Authorization', `Bearer ${manipulado}`);
    expect(response.status).toBe(401);
  });
});

/**
 * Recuperar la contraseña sin correo electrónico.
 *
 * Se prueba contra la aplicación entera y no contra el proveedor suelto porque
 * la mitad de lo que importa aquí son propiedades de la *ruta*: que no distinga
 * un correo desconocido de un código equivocado, y que la sesión que emite valga
 * de verdad para lo siguiente que se haga.
 */
describe('recuperación de contraseña', () => {
  const recuperar = (email: string, codigo: string, password = 'contraseña-nueva-larga') =>
    request(app).post('/api/auth/recuperar').send({ email, codigo, password });

  it('el registro entrega un código y el código cambia la contraseña', async () => {
    const { codigoRecuperacion } = await registrarCompleto('ana@ejemplo.com');
    expect(codigoRecuperacion).toBeTruthy();

    const respuesta = await recuperar('ana@ejemplo.com', codigoRecuperacion);
    expect(respuesta.status).toBe(200);

    // La sesión que devuelve tiene que servir para algo, no solo existir.
    const yo = await request(app)
      .get('/api/auth/yo')
      .set('Authorization', `Bearer ${respuesta.body.token}`);
    expect(yo.body.usuario.email).toBe('ana@ejemplo.com');

    const conLaNueva = await request(app)
      .post('/api/auth/acceso')
      .send({ email: 'ana@ejemplo.com', password: 'contraseña-nueva-larga' });
    expect(conLaNueva.status).toBe(200);
  });

  it('la contraseña anterior deja de servir', async () => {
    const { codigoRecuperacion } = await registrarCompleto('ana@ejemplo.com');
    await recuperar('ana@ejemplo.com', codigoRecuperacion);

    const conLaVieja = await request(app)
      .post('/api/auth/acceso')
      .send({ email: 'ana@ejemplo.com', password: 'contraseña-larga' });
    expect(conLaVieja.status).toBe(401);
  });

  it('el código no vale dos veces', async () => {
    const { codigoRecuperacion } = await registrarCompleto('ana@ejemplo.com');
    expect((await recuperar('ana@ejemplo.com', codigoRecuperacion)).status).toBe(200);

    // Si valiera otra vez, quien lo hubiera visto una sola vez —en una captura
    // de pantalla, en un mensaje reenviado— podría entrar cuando quisiera, aun
    // después de que el dueño lo hubiera usado.
    const segundo = await recuperar('ana@ejemplo.com', codigoRecuperacion, 'otra-contraseña-larga');
    expect(segundo.status).toBe(401);
  });

  it('acepta el código con o sin guiones y en minúsculas', async () => {
    // El código se copia a mano desde un papel o desde un mensaje. Los guiones
    // están para leerlo, no para escribirlo, y el teclado del móvil decide por
    // su cuenta cuándo pone mayúscula.
    const { codigoRecuperacion } = await registrarCompleto('ana@ejemplo.com');
    const maltratado = ` ${codigoRecuperacion.replaceAll('-', ' ').toLowerCase()} `;

    expect((await recuperar('ana@ejemplo.com', maltratado)).status).toBe(200);
  });

  it('el código de otra cuenta no sirve', async () => {
    await registrarCompleto('ana@ejemplo.com');
    const { codigoRecuperacion } = await registrarCompleto('bea@ejemplo.com');

    expect((await recuperar('ana@ejemplo.com', codigoRecuperacion)).status).toBe(401);
  });

  it('no distingue un correo desconocido de un código equivocado', async () => {
    // Es la misma regla que en `/acceso`: si las dos respuestas se diferenciaran,
    // esta ruta sería un buscador de cuentas registradas.
    const { codigoRecuperacion } = await registrarCompleto('ana@ejemplo.com');
    const codigoMalo = `${codigoRecuperacion.slice(0, -1)}${codigoRecuperacion.endsWith('Z') ? 'Y' : 'Z'}`;

    const cuentaQueNoExiste = await recuperar('nadie@ejemplo.com', codigoRecuperacion);
    const codigoQueNoEs = await recuperar('ana@ejemplo.com', codigoMalo);

    expect(cuentaQueNoExiste.status).toBe(401);
    expect(codigoQueNoEs.status).toBe(401);
    expect(cuentaQueNoExiste.body.error).toBe(codigoQueNoEs.body.error);
  });

  it('la contraseña nueva pasa por la misma regla que el registro', async () => {
    const { codigoRecuperacion } = await registrarCompleto('ana@ejemplo.com');

    const respuesta = await recuperar('ana@ejemplo.com', codigoRecuperacion, 'corta');
    expect(respuesta.status).toBe(400);
    expect(respuesta.body.code).toBe('PASSWORD_CORTA');
  });

  it('cambiar la contraseña invalida las sesiones anteriores', async () => {
    // El caso que da sentido a todo esto: alguien más ha entrado en la cuenta.
    // Si el token que ya tenía siguiera valiendo, cambiar la contraseña sería
    // cambiar la cerradura dejándole dentro.
    const { token, codigoRecuperacion } = await registrarCompleto('ana@ejemplo.com');
    expect((await request(app).get('/api/auth/yo').set('Authorization', `Bearer ${token}`)).status)
      .toBe(200);

    await recuperar('ana@ejemplo.com', codigoRecuperacion);

    const despues = await request(app).get('/api/auth/yo').set('Authorization', `Bearer ${token}`);
    expect(despues.status).toBe(401);
  });

  it('emitir un código nuevo anula el anterior', async () => {
    const { token, codigoRecuperacion } = await registrarCompleto('ana@ejemplo.com');

    const nuevo = await request(app)
      .post('/api/auth/codigo-recuperacion')
      .set('Authorization', `Bearer ${token}`);
    expect(nuevo.status).toBe(200);
    expect(nuevo.body.codigoRecuperacion).not.toBe(codigoRecuperacion);

    // Que el viejo deje de valer es el mecanismo con el que alguien que sospecha
    // de su código se lo quita de encima.
    expect((await recuperar('ana@ejemplo.com', codigoRecuperacion)).status).toBe(401);
    expect((await recuperar('ana@ejemplo.com', nuevo.body.codigoRecuperacion)).status).toBe(200);
  });

  it('pedir un código nuevo exige sesión', async () => {
    expect((await request(app).post('/api/auth/codigo-recuperacion')).status).toBe(401);
  });
});

describe('proyectos', () => {
  it('crea el proyecto con su documento ya inicializado', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token, 'Tienda en línea');

    const diagrama = await request(app)
      .get(`/api/proyectos/${proyectoId}/diagrama`)
      .set('Authorization', `Bearer ${token}`);

    expect(diagrama.status).toBe(200);
    expect(diagrama.body.diagrama.name).toBe('Tienda en línea');
    expect(diagrama.body.diagrama.meta.artifactId).toBe('tienda-en-linea');
  });

  it('solo lista los proyectos del usuario', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    await crearProyecto(ana);

    const listaBeto = await request(app)
      .get('/api/proyectos')
      .set('Authorization', `Bearer ${beto}`);
    expect(listaBeto.body.proyectos).toHaveLength(0);
  });

  it('responde 404 y no 403 a un extraño, para no revelar que existe', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    const proyectoId = await crearProyecto(ana);

    const response = await request(app)
      .get(`/api/proyectos/${proyectoId}`)
      .set('Authorization', `Bearer ${beto}`);
    expect(response.status).toBe(404);
  });

  it('invita a un colaborador por correo', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    const proyectoId = await crearProyecto(ana);

    const invitacion = await request(app)
      .post(`/api/proyectos/${proyectoId}/miembros`)
      .set('Authorization', `Bearer ${ana}`)
      .send({ email: 'beto@ejemplo.com', rol: 'viewer' });
    expect(invitacion.status).toBe(201);

    const lista = await request(app)
      .get('/api/proyectos')
      .set('Authorization', `Bearer ${beto}`);
    expect(lista.body.proyectos).toHaveLength(1);
    expect(lista.body.proyectos[0].role).toBe('viewer');
  });

  it('no deja expulsar al propietario', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(ana);
    const yo = await request(app).get('/api/auth/yo').set('Authorization', `Bearer ${ana}`);

    const response = await request(app)
      .delete(`/api/proyectos/${proyectoId}/miembros/${yo.body.usuario.id}`)
      .set('Authorization', `Bearer ${ana}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PROPIETARIO_INTOCABLE');
  });

  it('al borrar el proyecto borra también su documento', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(ana);

    expect(
      (
        await request(app)
          .delete(`/api/proyectos/${proyectoId}`)
          .set('Authorization', `Bearer ${ana}`)
      ).status,
    ).toBe(204);

    const despues = await request(app)
      .get(`/api/proyectos/${proyectoId}/diagrama`)
      .set('Authorization', `Bearer ${ana}`);
    expect(despues.status).toBe(404);
  });
});

describe('diagrama', () => {
  it('aplica operaciones y las refleja en el diagrama', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        operaciones: [
          { op: 'addClass', name: 'Cliente', kind: 'class' },
          {
            op: 'addAttribute',
            classRef: { name: 'Cliente' },
            name: 'id',
            type: 'Long',
            isIdentifier: true,
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.aplicadas).toBe(2);
    const clases = Object.values(response.body.diagrama.classes) as { name: string }[];
    expect(clases.map((c) => c.name)).toEqual(['Cliente']);
  });

  it('devuelve 422 y no aplica nada si una operación del lote falla', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        operaciones: [
          { op: 'addClass', name: 'Cliente', kind: 'class' },
          { op: 'removeClass', ref: { name: 'NoExiste' } },
        ],
      });

    expect(response.status).toBe(422);
    expect(response.body.operacion).toBe(1);

    const diagrama = await request(app)
      .get(`/api/proyectos/${proyectoId}/diagrama`)
      .set('Authorization', `Bearer ${token}`);
    expect(Object.keys(diagrama.body.diagrama.classes)).toHaveLength(0);
  });

  it('rechaza una operación mal formada antes de tocar el documento', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operaciones: [{ op: 'operacionInventada' }] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('CUERPO_INVALIDO');
  });

  it('un usuario de solo lectura puede leer pero no escribir', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    const proyectoId = await crearProyecto(ana);
    await request(app)
      .post(`/api/proyectos/${proyectoId}/miembros`)
      .set('Authorization', `Bearer ${ana}`)
      .send({ email: 'beto@ejemplo.com', rol: 'viewer' });

    expect(
      (
        await request(app)
          .get(`/api/proyectos/${proyectoId}/diagrama`)
          .set('Authorization', `Bearer ${beto}`)
      ).status,
    ).toBe(200);

    const escritura = await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set('Authorization', `Bearer ${beto}`)
      .send({ operaciones: [{ op: 'addClass', name: 'Cliente', kind: 'class' }] });
    expect(escritura.status).toBe(403);
  });

  /**
   * Es el camino de RF-OFF-04: el cliente vuelve con trabajo hecho sin conexión
   * y debe fusionarse con lo que hayan hecho los demás, sin perder ninguna de
   * las dos partes.
   */
  it('fusiona el trabajo hecho offline con el del servidor', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    const cabecera = { Authorization: `Bearer ${token}` };

    const inicial = await request(app)
      .get(`/api/proyectos/${proyectoId}/diagrama/estado`)
      .set(cabecera);

    // El servidor avanza mientras el cliente está desconectado.
    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set(cabecera)
      .send({ operaciones: [{ op: 'addClass', name: 'Servidor', kind: 'class' }] });

    // El cliente trabaja sobre su copia y luego envía lo suyo.
    const Y = await import('yjs');
    const { applyOperation } = await import('@app/shared');
    const local = new Y.Doc();
    Y.applyUpdate(local, new Uint8Array(Buffer.from(inicial.body.actualizacion, 'base64')));
    applyOperation(local, { op: 'addClass', name: 'Offline', kind: 'class' });

    const fusion = await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/estado`)
      .set(cabecera)
      .send({
        actualizacion: Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64'),
        // Sin el vector el servidor no puede saber qué le falta al cliente y
        // tiene que devolver el documento entero; se envía porque es lo que
        // hará el cliente real al reconectar.
        vectorEstado: Buffer.from(Y.encodeStateVector(local)).toString('base64'),
      });
    expect(fusion.status).toBe(200);

    const diagrama = await request(app)
      .get(`/api/proyectos/${proyectoId}/diagrama`)
      .set(cabecera);
    const nombres = (Object.values(diagrama.body.diagrama.classes) as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(nombres).toEqual(['Offline', 'Servidor']);

    // Y la respuesta trae al cliente lo que le faltaba.
    Y.applyUpdate(local, new Uint8Array(Buffer.from(fusion.body.actualizacion, 'base64')));
    const { readDiagram } = await import('@app/shared');
    expect(Object.keys(readDiagram(local).classes)).toHaveLength(2);
  });
});

describe('versiones', () => {
  it('crea una versión y la lista con su resumen, sin el estado', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const creada = await request(app)
      .post(`/api/proyectos/${proyectoId}/versiones`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mensaje: 'Antes de refactorizar' });
    expect(creada.status).toBe(201);
    expect(creada.body.version.mensaje).toBe('Antes de refactorizar');
    expect(creada.body.version).not.toHaveProperty('estado');

    const listado = await request(app)
      .get(`/api/proyectos/${proyectoId}/versiones`)
      .set('Authorization', `Bearer ${token}`);
    expect(listado.status).toBe(200);
    expect(listado.body.versiones.map((v: { mensaje: string }) => v.mensaje)).toEqual([
      'Antes de refactorizar',
    ]);
  });

  it('restaura el diagrama al estado de una versión guardada', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    const cabecera = { Authorization: `Bearer ${token}` };

    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set(cabecera)
      .send({ operaciones: [{ op: 'addClass', name: 'Cliente', kind: 'class' }] });

    const version = await request(app)
      .post(`/api/proyectos/${proyectoId}/versiones`)
      .set(cabecera)
      .send({ mensaje: 'con Cliente' });

    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set(cabecera)
      .send({ operaciones: [{ op: 'addClass', name: 'Pedido', kind: 'class' }] });

    const restaurada = await request(app)
      .post(`/api/proyectos/${proyectoId}/versiones/${version.body.version.id}/restaurar`)
      .set(cabecera);
    expect(restaurada.status).toBe(200);
    expect(Object.values(restaurada.body.diagrama.classes).map((c: any) => c.name)).toEqual([
      'Cliente',
    ]);

    const diagrama = await request(app)
      .get(`/api/proyectos/${proyectoId}/diagrama`)
      .set(cabecera);
    expect(Object.values(diagrama.body.diagrama.classes).map((c: any) => c.name)).toEqual([
      'Cliente',
    ]);
  });

  it('consulta el diagrama de una versión sin restaurarla', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    const cabecera = { Authorization: `Bearer ${token}` };

    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set(cabecera)
      .send({ operaciones: [{ op: 'addClass', name: 'Cliente', kind: 'class' }] });

    const version = await request(app)
      .post(`/api/proyectos/${proyectoId}/versiones`)
      .set(cabecera)
      .send({ mensaje: 'con Cliente' });

    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set(cabecera)
      .send({ operaciones: [{ op: 'addClass', name: 'Pedido', kind: 'class' }] });

    const vista = await request(app)
      .get(`/api/proyectos/${proyectoId}/versiones/${version.body.version.id}`)
      .set(cabecera);
    expect(vista.status).toBe(200);
    expect(vista.body.version.mensaje).toBe('con Cliente');
    expect(vista.body.version).not.toHaveProperty('estado');
    expect(Object.values(vista.body.diagrama.classes).map((c: any) => c.name)).toEqual(['Cliente']);

    // Consultar no restaura: el diagrama en vivo sigue con las dos clases.
    const diagrama = await request(app)
      .get(`/api/proyectos/${proyectoId}/diagrama`)
      .set(cabecera);
    expect(Object.values(diagrama.body.diagrama.classes).map((c: any) => c.name).sort()).toEqual([
      'Cliente',
      'Pedido',
    ]);
  });

  it('consultar una versión inexistente devuelve 404', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const respuesta = await request(app)
      .get(`/api/proyectos/${proyectoId}/versiones/no-existe`)
      .set('Authorization', `Bearer ${token}`);
    expect(respuesta.status).toBe(404);
  });

  it('restaurar una versión inexistente devuelve 404', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const respuesta = await request(app)
      .post(`/api/proyectos/${proyectoId}/versiones/no-existe/restaurar`)
      .set('Authorization', `Bearer ${token}`);
    expect(respuesta.status).toBe(404);
  });

  it('un editor puede crear una versión pero no restaurarla', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    const proyectoId = await crearProyecto(ana);
    await request(app)
      .post(`/api/proyectos/${proyectoId}/miembros`)
      .set('Authorization', `Bearer ${ana}`)
      .send({ email: 'beto@ejemplo.com', rol: 'editor' });

    const creada = await request(app)
      .post(`/api/proyectos/${proyectoId}/versiones`)
      .set('Authorization', `Bearer ${beto}`)
      .send({ mensaje: 'de beto' });
    expect(creada.status).toBe(201);

    const restaurar = await request(app)
      .post(`/api/proyectos/${proyectoId}/versiones/${creada.body.version.id}/restaurar`)
      .set('Authorization', `Bearer ${beto}`);
    expect(restaurar.status).toBe(403);
  });

  it('un lector no puede crear versiones, solo listarlas', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    const proyectoId = await crearProyecto(ana);
    await request(app)
      .post(`/api/proyectos/${proyectoId}/miembros`)
      .set('Authorization', `Bearer ${ana}`)
      .send({ email: 'beto@ejemplo.com', rol: 'viewer' });

    const creada = await request(app)
      .post(`/api/proyectos/${proyectoId}/versiones`)
      .set('Authorization', `Bearer ${beto}`)
      .send({ mensaje: 'intento' });
    expect(creada.status).toBe(403);

    const listado = await request(app)
      .get(`/api/proyectos/${proyectoId}/versiones`)
      .set('Authorization', `Bearer ${beto}`);
    expect(listado.status).toBe(200);
  });
});

describe('generación', () => {
  async function proyectoConDiagrama(): Promise<{ token: string; proyectoId: string }> {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        operaciones: [
          { op: 'addClass', name: 'Cliente', kind: 'class' },
          {
            op: 'addAttribute',
            classRef: { name: 'Cliente' },
            name: 'id',
            type: 'Long',
            isIdentifier: true,
          },
          {
            op: 'addAttribute',
            classRef: { name: 'Cliente' },
            name: 'nombre',
            type: 'String',
            isNullable: false,
          },
        ],
      });
    return { token, proyectoId };
  }

  it('avisa de que un diagrama vacío todavía no puede generarse', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const validacion = await request(app)
      .get(`/api/proyectos/${proyectoId}/validacion`)
      .set('Authorization', `Bearer ${token}`);
    expect(validacion.body.valido).toBe(false);

    const generacion = await request(app)
      .post(`/api/proyectos/${proyectoId}/generacion`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(generacion.status).toBe(422);
  });

  it('genera las cuatro capas a partir del diagrama del documento', async () => {
    const { token, proyectoId } = await proyectoConDiagrama();

    const previa = await request(app)
      .post(`/api/proyectos/${proyectoId}/generacion/previsualizacion`)
      .set('Authorization', `Bearer ${token}`)
      .send({ paqueteBase: 'com.tienda.api' });

    expect(previa.status).toBe(200);
    const rutas = (previa.body.ficheros as { ruta: string }[]).map((f) => f.ruta);
    expect(rutas).toContain('src/main/java/com/tienda/api/domain/Cliente.java');
    expect(rutas).toContain('src/main/java/com/tienda/api/repository/ClienteRepository.java');
    expect(rutas).toContain('src/main/java/com/tienda/api/service/ClienteService.java');
    expect(rutas).toContain('src/main/java/com/tienda/api/controller/ClienteController.java');
  });

  it('genera un backend MongoDB cuando se pide motorBD', async () => {
    const { token, proyectoId } = await proyectoConDiagrama();

    const previa = await request(app)
      .post(`/api/proyectos/${proyectoId}/generacion/previsualizacion`)
      .set('Authorization', `Bearer ${token}`)
      .send({ motorBD: 'mongodb' });

    expect(previa.status).toBe(200);
    const ficheros = previa.body.ficheros as { ruta: string; contenido: string }[];
    const pom = ficheros.find((f) => f.ruta === 'pom.xml');
    expect(pom?.contenido).toContain('spring-boot-starter-data-mongodb');

    const entidad = ficheros.find((f) => f.ruta.endsWith('domain/Cliente.java'));
    expect(entidad?.contenido).toContain('@Document(collection');
  });

  it('genera un backend Cassandra cuando se pide motorBD', async () => {
    const { token, proyectoId } = await proyectoConDiagrama();

    const previa = await request(app)
      .post(`/api/proyectos/${proyectoId}/generacion/previsualizacion`)
      .set('Authorization', `Bearer ${token}`)
      .send({ motorBD: 'cassandra' });

    expect(previa.status).toBe(200);
    const ficheros = previa.body.ficheros as { ruta: string; contenido: string }[];
    const pom = ficheros.find((f) => f.ruta === 'pom.xml');
    expect(pom?.contenido).toContain('spring-boot-starter-data-cassandra');

    const entidad = ficheros.find((f) => f.ruta.endsWith('domain/Cliente.java'));
    expect(entidad?.contenido).toContain('@Table(');
    expect(entidad?.contenido).toContain('@PrimaryKey');
  });

  it('devuelve un ZIP descargable', async () => {
    const { token, proyectoId } = await proyectoConDiagrama();

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/generacion`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    // Firma de un fichero ZIP: sin esto, un cuerpo JSON de error pasaría igual.
    expect((response.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('rechaza un paquete base que no es un paquete Java', async () => {
    const { token, proyectoId } = await proyectoConDiagrama();

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/generacion`)
      .set('Authorization', `Bearer ${token}`)
      .send({ paqueteBase: '../../etc/passwd' });

    expect(response.status).toBe(422);
    expect(response.body.errores[0].code).toBe('INVALID_BASE_PACKAGE');
  });
});

describe('asistente', () => {
  it('propone operaciones sin aplicarlas', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente`)
      .set('Authorization', `Bearer ${token}`)
      .send({ texto: 'crea la clase Cliente' });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['aclaracion', 'confianza', 'explicacion', 'motor', 'propuesta']);
    expect(response.body.propuesta).toHaveLength(1);
    expect(response.body.propuesta[0].descripcion).toContain('Cliente');

    // Lo importante: el diagrama sigue vacío hasta que el usuario acepte.
    const diagrama = await request(app)
      .get(`/api/proyectos/${proyectoId}/diagrama`)
      .set('Authorization', `Bearer ${token}`);
    expect(Object.keys(diagrama.body.diagrama.classes)).toHaveLength(0);
  });

  it('pide una aclaración en lugar de inventar', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente`)
      .set('Authorization', `Bearer ${token}`)
      .send({ texto: 'ya sabes lo que quiero' });

    expect(response.body.propuesta).toHaveLength(0);
    expect(response.body.aclaracion).toBeTruthy();
  });

  it('el historial devuelve lo que guardó una orden previa', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente`)
      .set('Authorization', `Bearer ${token}`)
      .send({ texto: 'crea la clase Cliente' });

    const historial = await request(app)
      .get(`/api/proyectos/${proyectoId}/asistente/historial`)
      .set('Authorization', `Bearer ${token}`);

    expect(historial.status).toBe(200);
    expect(historial.body.turnos.map((t: { texto: string }) => t.texto)).toContain(
      'crea la clase Cliente',
    );
  });

  it('con revision, el motor recibe la petición de revisión con las pistas del revisor local, y el turno guarda lo que se escribió', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operaciones: [{ op: 'addClass', name: 'Factura', kind: 'class' }] });
    const prompts: string[] = [];
    const fake: AssistantEngine = {
      name: 'motor-prueba',
      interpret: async () => ({ operations: [], confidence: 1, clarification: null, explanation: '' }),
      revisar: async () => null,
      async *interpretarEnStream(prompt: string): AsyncGenerator<EventoAsistente> {
        prompts.push(prompt);
        yield { tipo: 'mensaje', texto: 'Factura no tiene atributos.' };
        yield { tipo: 'fin', motor: 'motor-prueba', confianza: 1 };
      },
    };
    app = createApp({ ...deps, assistant: fake }).app;

    await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ texto: 'Revisa mi diagrama', revision: true })
      .buffer(true)
      .parse((res, callback) => {
        let cuerpo = '';
        res.setEncoding('utf8');
        res.on('data', (trozo) => (cuerpo += trozo));
        res.on('end', () => callback(null, cuerpo));
      });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Revisa este diagrama');
    expect(prompts[0]).toContain('Factura');
    const historial = await request(app)
      .get(`/api/proyectos/${proyectoId}/asistente/historial`)
      .set('Authorization', `Bearer ${token}`);
    expect(historial.body.turnos.map((turno: { texto: string }) => turno.texto)).toEqual([
      'Revisa mi diagrama',
      'Factura no tiene atributos.',
    ]);
  });

  it('envía mensajes, operaciones y el cierre en orden, calcula la descripción y guarda un único turno', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    const operacion = { op: 'addClass' as const, name: 'Pedido', kind: 'class' as const };
    const fake: AssistantEngine = {
      name: 'motor-prueba',
      interpret: async () => ({ operations: [], confidence: 1, clarification: null, explanation: '' }),
      revisar: async () => null,
      async *interpretarEnStream(): AsyncGenerator<EventoAsistente> {
        yield { tipo: 'mensaje-parcial', texto: 'Creo' };
        yield { tipo: 'mensaje', texto: 'Creo Pedido.' };
        yield { tipo: 'operacion', operacion, descripcion: 'descripción falsa' };
        yield { tipo: 'mensaje', texto: 'Listo.' };
        yield { tipo: 'fin', motor: 'motor-prueba', confianza: 0.7 };
      },
    };
    app = createApp({ ...deps, assistant: fake }).app;
    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ texto: 'crea Pedido' })
      .buffer(true)
      .parse((res, callback) => {
        let cuerpo = '';
        res.setEncoding('utf8');
        res.on('data', (trozo) => (cuerpo += trozo));
        res.on('end', () => callback(null, cuerpo));
      });

    const eventos: EventoAsistente[] = [];
    crearLectorSse((evento) => eventos.push(evento)).empujar(response.body as string);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-cache');
    expect(eventos.map((evento) => evento.tipo)).toEqual([
      'mensaje-parcial', 'mensaje', 'operacion', 'mensaje', 'fin',
    ]);
    expect(eventos[2]).toEqual({ tipo: 'operacion', operacion, descripcion: describeOperation(operacion) });

    const historial = await request(app)
      .get(`/api/proyectos/${proyectoId}/asistente/historial`)
      .set('Authorization', `Bearer ${token}`);
    expect(historial.body.turnos).toHaveLength(2);
    expect(historial.body.turnos.map((turno: { texto: string }) => turno.texto)).toEqual([
      'crea Pedido', 'Creo Pedido. Listo.',
    ]);
  });

  it('termina con error y no emite nada más si el stream falla después de un mensaje', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    const fake: AssistantEngine = {
      name: 'motor-prueba',
      interpret: async () => ({ operations: [], confidence: 1, clarification: null, explanation: '' }),
      revisar: async () => null,
      async *interpretarEnStream(): AsyncGenerator<EventoAsistente> {
        yield { tipo: 'mensaje', texto: 'Inicio.' };
        throw new Error('fallo de proveedor');
      },
    };
    app = createApp({ ...deps, assistant: fake }).app;

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ texto: 'hazlo' })
      .buffer(true)
      .parse((res, callback) => {
        let cuerpo = '';
        res.setEncoding('utf8');
        res.on('data', (trozo) => (cuerpo += trozo));
        res.on('end', () => callback(null, cuerpo));
      });
    const eventos: EventoAsistente[] = [];
    crearLectorSse((evento) => eventos.push(evento)).empujar(response.body as string);

    expect(eventos.map((evento) => evento.tipo)).toEqual(['mensaje', 'error']);
    expect(eventos[1]).toMatchObject({ tipo: 'error', mensaje: 'fallo de proveedor' });
  });

  it('aborta el modelo y no guarda el turno si el cliente se desconecta durante el stream', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    let registrarCancelacion!: () => void;
    const cancelacion = new Promise<void>((resolve) => { registrarCancelacion = resolve; });
    const fake: AssistantEngine = {
      name: 'motor-prueba',
      interpret: async () => ({ operations: [], confidence: 1, clarification: null, explanation: '' }),
      revisar: async () => null,
      async *interpretarEnStream(
        _prompt: string,
        _diagram: Parameters<AssistantEngine['interpret']>[1],
        _contexto?: Parameters<NonNullable<AssistantEngine['interpretarEnStream']>>[2],
        signal?: AbortSignal,
      ): AsyncGenerator<EventoAsistente> {
        yield { tipo: 'mensaje', texto: 'Todavía escribo.' };
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        registrarCancelacion();
      },
    };
    app = createApp({ ...deps, assistant: fake }).app;
    const servidor = app.listen(0);
    await new Promise<void>((resolve) => servidor.once('listening', resolve));
    const direccion = servidor.address();
    if (!direccion || typeof direccion === 'string') throw new Error('el servidor de prueba no abrió un puerto');

    const desconectado = new Promise<void>((resolve, reject) => {
      const cliente = httpRequest({
        hostname: '127.0.0.1',
        port: direccion.port,
        path: `/api/proyectos/${proyectoId}/asistente/stream`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
      }, (respuesta) => {
        respuesta.on('close', resolve);
        respuesta.on('data', (trozo: Buffer) => {
          if (trozo.toString().includes('Todavía escribo.')) cliente.destroy();
        });
      });
      cliente.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
      cliente.end(JSON.stringify({ texto: 'hola' }));
    });
    await desconectado;
    await cancelacion;
    await new Promise<void>((resolve, reject) => servidor.close((error) => error ? reject(error) : resolve()));

    const historial = await request(app)
      .get(`/api/proyectos/${proyectoId}/asistente/historial`)
      .set('Authorization', `Bearer ${token}`);
    expect(historial.body.turnos).toEqual([]);
  });

  it('sin clave de API devuelve eventos de la gramática local', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const response = await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ texto: 'crea la clase Pedido' })
      .buffer(true)
      .parse((res, callback) => {
        let cuerpo = '';
        res.setEncoding('utf8');
        res.on('data', (trozo) => (cuerpo += trozo));
        res.on('end', () => callback(null, cuerpo));
      });
    const eventos: EventoAsistente[] = [];
    crearLectorSse((evento) => eventos.push(evento)).empujar(response.body as string);

    expect(response.status).toBe(200);
    expect(eventos.some((evento) => evento.tipo === 'mensaje')).toBe(true);
    expect(eventos.some((evento) => evento.tipo === 'operacion')).toBe(true);
    expect(eventos.at(-1)).toMatchObject({ tipo: 'fin', motor: 'gramatica-local' });
  });

  it('cada integrante tiene su propio hilo: Beto no ve lo que Ana le pidió a la IA', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    const proyectoId = await crearProyecto(ana);
    await request(app)
      .post(`/api/proyectos/${proyectoId}/miembros`)
      .set('Authorization', `Bearer ${ana}`)
      .send({ email: 'beto@ejemplo.com', rol: 'editor' });

    await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente`)
      .set('Authorization', `Bearer ${ana}`)
      .send({ texto: 'crea la clase Cliente' });
    await request(app)
      .post(`/api/proyectos/${proyectoId}/asistente`)
      .set('Authorization', `Bearer ${beto}`)
      .send({ texto: 'crea la clase Pedido' });

    const historialDeBeto = await request(app)
      .get(`/api/proyectos/${proyectoId}/asistente/historial`)
      .set('Authorization', `Bearer ${beto}`);
    const historialDeAna = await request(app)
      .get(`/api/proyectos/${proyectoId}/asistente/historial`)
      .set('Authorization', `Bearer ${ana}`);

    expect(historialDeBeto.status).toBe(200);
    const textosDeBeto = historialDeBeto.body.turnos.map((t: { texto: string }) => t.texto);
    expect(textosDeBeto).toContain('crea la clase Pedido');
    expect(textosDeBeto).not.toContain('crea la clase Cliente');
    expect(historialDeBeto.body.turnos).toHaveLength(2);

    const textosDeAna = historialDeAna.body.turnos.map((t: { texto: string }) => t.texto);
    expect(textosDeAna).toContain('crea la clase Cliente');
    expect(textosDeAna).not.toContain('crea la clase Pedido');
  });
});

/**
 * El resumen agregado de la pantalla de entrada.
 *
 * Lo que hay que comprobar de esta ruta no es que sume bien —de eso se ocupan
 * las pruebas del módulo puro del frontend— sino lo que solo se puede comprobar
 * con el servicio montado: que la agregación no se salta ningún permiso. Una
 * ruta que junta datos de varios sitios es exactamente donde se cuela un dato
 * que por su camino normal estaba protegido.
 */
describe('panel', () => {
  it('exige sesión', async () => {
    expect((await request(app).get('/api/panel')).status).toBe(401);
  });

  it('resume solo los proyectos de quien pregunta', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    await crearProyecto(ana, 'De Ana');

    const response = await request(app).get('/api/panel').set('Authorization', `Bearer ${beto}`);

    expect(response.status).toBe(200);
    expect(response.body.filas).toEqual([]);
  });

  it('trae las cifras que la pantalla necesita, contadas del documento', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);
    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        operaciones: [
          { op: 'addClass', name: 'Cliente', kind: 'class' },
          { op: 'addClass', name: 'Pedido', kind: 'class' },
        ],
      });

    const response = await request(app).get('/api/panel').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.filas).toHaveLength(1);
    const [fila] = response.body.filas;
    expect(fila.proyecto.id).toBe(proyectoId);
    expect(fila.resumen.clases).toBe(2);
    expect(fila.resumen.miembros).toBe(1);
    // Dos clases sin identificador: el backend todavía no se puede generar, y
    // esa es justamente la lista que el tablero pide mirar.
    expect(fila.resumen.problemas).toBeGreaterThan(0);
  });

  /*
   * El reparto por vía de entrada, con el historial escrito como lo escribe el
   * cliente de verdad.
   *
   * Quien anota en el historial es el navegador, en `useDiagrama`, y no la ruta
   * HTTP de operaciones: por eso aquí se llama a `registrarCambio` sobre el
   * documento de la sala en vez de dar por hecho que aplicar operaciones por
   * HTTP deja rastro. Suponerlo era el error que tenía esta prueba escrita al
   * primer intento, y habría afirmado en verde algo que no ocurre.
   */
  it('reparte los cambios por vía de entrada y no cuenta deshacer como modelo', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token);

    const { registrarCambio } = await import('@app/shared');
    const room = await deps.rooms.open(proyectoId);
    const autor = { id: 'u1', nombre: 'Ana' };
    registrarCambio(room.doc, {
      operaciones: [{ op: 'addClass', name: 'Cliente', kind: 'class' }],
      origen: 'manual',
      autor,
    });
    registrarCambio(room.doc, {
      operaciones: [{ op: 'addClass', name: 'Pedido', kind: 'class' }],
      origen: 'foto',
      autor,
    });
    registrarCambio(room.doc, {
      operaciones: [],
      origen: 'deshacer',
      resumen: 'Deshizo la clase Pedido',
      autor,
    });

    const response = await request(app).get('/api/panel').set('Authorization', `Bearer ${token}`);
    const [fila] = response.body.filas;

    // Los tres cuentan como cambios…
    expect(fila.resumen.cambios).toBe(3);
    // …pero deshacer no es una forma de meter modelo, y el reparto lo separa.
    expect(fila.resumen.porOrigen).toMatchObject({ manual: 1, foto: 1, deshacer: 1 });
  });

  /*
   * Criterio explícito del tablero: no enseña ni un dato que quien solo lee no
   * pudiera pedir ya por su cuenta. Se comprueba comparando contra las rutas de
   * siempre, que llevan `requireRole(store, 'viewer')`, en vez de afirmarlo en
   * un comentario. Si algún día se añade un campo que exija más permiso, esta
   * prueba no lo detecta sola —por eso el listado de campos es explícito—, pero
   * sí detecta que el camino del lector se rompa.
   */
  it('un lector ve por el panel lo mismo que ya podía pedir suelto', async () => {
    const ana = await registrar('ana@ejemplo.com');
    const beto = await registrar('beto@ejemplo.com');
    const proyectoId = await crearProyecto(ana, 'Compartido');

    await request(app)
      .post(`/api/proyectos/${proyectoId}/diagrama/operaciones`)
      .set('Authorization', `Bearer ${ana}`)
      .send({ operaciones: [{ op: 'addClass', name: 'Cliente', kind: 'class' }] });

    await request(app)
      .post(`/api/proyectos/${proyectoId}/miembros`)
      .set('Authorization', `Bearer ${ana}`)
      .send({ email: 'beto@ejemplo.com', rol: 'viewer' });

    const cabecera = { Authorization: `Bearer ${beto}` };
    const panel = await request(app).get('/api/panel').set(cabecera);
    const diagrama = await request(app).get(`/api/proyectos/${proyectoId}/diagrama`).set(cabecera);
    const miembros = await request(app).get(`/api/proyectos/${proyectoId}/miembros`).set(cabecera);
    const validacion = await request(app)
      .get(`/api/proyectos/${proyectoId}/validacion`)
      .set(cabecera);

    // Las tres rutas sueltas ya le contestan hoy, sin el panel de por medio.
    expect([diagrama.status, miembros.status, validacion.status]).toEqual([200, 200, 200]);

    const [fila] = panel.body.filas;
    expect(fila.proyecto.role).toBe('viewer');
    expect(fila.resumen.clases).toBe(Object.keys(diagrama.body.diagrama.classes).length);
    expect(fila.resumen.miembros).toBe(miembros.body.miembros.length);
    expect(fila.resumen.problemas).toBe(validacion.body.errores.length);
    expect(fila.resumen.avisos).toBe(validacion.body.avisos.length);
  });

  /*
   * La consulta no puede notarse desde el lienzo de otro. `rooms.open` deja el
   * documento cargado en memoria, así que el panel cierra lo que abre; si algún
   * día se olvidara el `closeIfEmpty`, entrar a la pantalla de proyectos dejaría
   * un `Y.Doc` por proyecto vivo hasta reiniciar el proceso.
   */
  it('no deja los documentos abiertos detrás de sí', async () => {
    const token = await registrar('ana@ejemplo.com');
    const proyectoId = await crearProyecto(token, 'Uno');

    // Se parte de la sala cerrada para que lo que se mida sea el efecto del
    // panel y no el rastro de haber creado el proyecto.
    await deps.rooms.closeIfEmpty(proyectoId);
    expect(deps.rooms.get(proyectoId)).toBeUndefined();

    await request(app).get('/api/panel').set('Authorization', `Bearer ${token}`);

    expect(deps.rooms.get(proyectoId)).toBeUndefined();
  });
});

describe('salud', () => {
  it('responde sin autenticación', async () => {
    const response = await request(app).get('/salud');
    expect(response.status).toBe(200);
    expect(response.body.estado).toBe('ok');
  });
});
