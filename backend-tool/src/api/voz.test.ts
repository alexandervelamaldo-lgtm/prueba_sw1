import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorDeVoz, type SintetizadorDeVoz } from '../ai/voz-elevenlabs.js';
import { errorHandler } from './http.js';
import { vozRouter } from './voz.js';

/**
 * Las rutas de la voz del servidor. La sesión y el límite de tasa los pone
 * `app.ts` al montarlas; aquí se prueba lo que deciden ellas: si hay voz, qué
 * texto aceptan y cómo avisan al navegador de que use su propia voz.
 */
function app(voz: SintetizadorDeVoz | null, maximoDiario?: number) {
  const aplicacion = express();
  aplicacion.use(express.json());
  // Lo que pone `requireAuth`: el tope diario es por usuario.
  aplicacion.use((request, _response, next) => {
    (request as unknown as { user: { id: string } }).user = { id: String(request.headers['x-usuario'] ?? 'ana') };
    next();
  });
  aplicacion.use('/api/voz', vozRouter(voz, maximoDiario));
  aplicacion.use(errorHandler);
  return aplicacion;
}

const vozFalsa = (resultado: () => Promise<{ datos: ArrayBuffer; tipo: string }>): SintetizadorDeVoz => ({
  sintetizar: resultado,
});

describe('vozRouter', () => {
  it('estado dice si hay voz de ElevenLabs', async () => {
    expect((await request(app(null)).get('/api/voz/estado')).body).toEqual({ elevenlabs: false });
    const conVoz = app(vozFalsa(async () => ({ datos: new ArrayBuffer(1), tipo: 'audio/mpeg' })));
    expect((await request(conVoz).get('/api/voz/estado')).body).toEqual({ elevenlabs: true });
  });

  it('sintetizar devuelve el audio tal cual', async () => {
    const respuesta = await request(app(vozFalsa(async () => ({ datos: new Uint8Array([7, 8]).buffer, tipo: 'audio/mpeg' }))))
      .post('/api/voz/sintetizar')
      .send({ texto: 'Hola' })
      .buffer(true)
      .parse((res, callback) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () => callback(null, Buffer.concat(trozos)));
      });

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers['content-type']).toBe('audio/mpeg');
    expect([...(respuesta.body as Buffer)]).toEqual([7, 8]);
  });

  it('sin voz configurada, o si el proveedor falla, responde 503 para que el navegador use la suya', async () => {
    const sinVoz = await request(app(null)).post('/api/voz/sintetizar').send({ texto: 'Hola' });
    const falla = await request(app(vozFalsa(async () => { throw new ErrorDeVoz('sin créditos', 401); })))
      .post('/api/voz/sintetizar')
      .send({ texto: 'Hola' });

    expect(sinVoz.status).toBe(503);
    expect(falla.status).toBe(503);
    expect(falla.body).toMatchObject({ code: 'voz_no_disponible' });
  });

  it('rechaza un texto vacío o demasiado largo', async () => {
    const voz = app(vozFalsa(async () => ({ datos: new ArrayBuffer(1), tipo: 'audio/mpeg' })));

    expect((await request(voz).post('/api/voz/sintetizar').send({ texto: '  ' })).status).toBe(400);
    expect((await request(voz).post('/api/voz/sintetizar').send({ texto: 'a'.repeat(1001) })).status).toBe(400);
  });
});

describe('tope diario de caracteres por usuario', () => {
  it('al pasarlo, ese usuario recibe 503 y usa la voz del navegador; los demás siguen', async () => {
    let llamadas = 0;
    const voz = app(
      vozFalsa(async () => {
        llamadas += 1;
        return { datos: new ArrayBuffer(1), tipo: 'audio/mpeg' };
      }),
      10,
    );

    const primera = await request(voz).post('/api/voz/sintetizar').send({ texto: 'Hola ana' });
    const segunda = await request(voz).post('/api/voz/sintetizar').send({ texto: 'Otra vez' });
    const deBeto = await request(voz).post('/api/voz/sintetizar').set('x-usuario', 'beto').send({ texto: 'Hola beto' });

    expect([primera.status, segunda.status, deBeto.status]).toEqual([200, 503, 200]);
    expect(segunda.body).toMatchObject({ code: 'voz_no_disponible' });
    expect(llamadas).toBe(2);
  });
});
