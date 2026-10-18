import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorDeVoz, crearVozElevenLabs } from './voz-elevenlabs.js';

/**
 * El cliente de ElevenLabs contra un servidor que habla su protocolo: lo que
 * se comprueba es qué se le manda (la clave en `xi-api-key`, el modelo y el
 * formato) y qué se hace con lo que responde, no la voz de verdad.
 */

let server: Server;
let baseUrl: string;
let recibido: { ruta: string; clave: string | undefined; cuerpo: Record<string, unknown> } | null;
let responder: () => { status: number; cuerpo: Buffer | string; tipo: string };

beforeEach(async () => {
  recibido = null;
  responder = () => ({ status: 200, cuerpo: Buffer.from([1, 2, 3]), tipo: 'audio/mpeg' });
  server = createServer((request, response) => {
    let texto = '';
    request.on('data', (trozo) => (texto += trozo));
    request.on('end', () => {
      recibido = {
        ruta: request.url ?? '',
        clave: request.headers['xi-api-key'] as string | undefined,
        cuerpo: texto ? JSON.parse(texto) : {},
      };
      const { status, cuerpo, tipo } = responder();
      response.writeHead(status, { 'content-type': tipo });
      response.end(cuerpo);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const voz = () =>
  crearVozElevenLabs({ apiKey: 'clave-de-prueba', voiceId: 'VOZ1', modelo: 'eleven_flash_v2_5', baseUrl, timeoutMs: 1000 });

describe('crearVozElevenLabs', () => {
  it('pide el audio con la clave, la voz, el modelo y mp3, y devuelve los bytes', async () => {
    const audio = await voz().sintetizar('Hola, Demo.');

    expect(recibido).toEqual({
      ruta: '/v1/text-to-speech/VOZ1?output_format=mp3_44100_128',
      clave: 'clave-de-prueba',
      cuerpo: { text: 'Hola, Demo.', model_id: 'eleven_flash_v2_5' },
    });
    expect(audio.tipo).toBe('audio/mpeg');
    expect([...new Uint8Array(audio.datos)]).toEqual([1, 2, 3]);
  });

  it('una respuesta de error del proveedor es un ErrorDeVoz con su estado', async () => {
    responder = () => ({ status: 401, cuerpo: JSON.stringify({ detail: { status: 'quota_exceeded' } }), tipo: 'application/json' });

    const fallo = await voz().sintetizar('Hola').catch((error: unknown) => error);

    expect(fallo).toBeInstanceOf(ErrorDeVoz);
    expect((fallo as ErrorDeVoz).status).toBe(401);
  });

  it('si no responde a tiempo, es un ErrorDeVoz', async () => {
    responder = () => {
      throw new Error('no debería llegar');
    };
    server.removeAllListeners('request');
    server.on('request', () => {
      // No contesta nunca.
    });

    await expect(voz().sintetizar('Hola')).rejects.toBeInstanceOf(ErrorDeVoz);
  });
});
