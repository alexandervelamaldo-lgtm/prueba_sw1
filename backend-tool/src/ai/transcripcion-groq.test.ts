import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorDeVoz } from './voz-elevenlabs.js';
import { crearTranscriptorGroq } from './transcripcion-groq.js';

/**
 * El cliente de Groq (Whisper) contra un servidor que habla su protocolo
 * (el de OpenAI): lo que se comprueba es lo que se le manda —la clave, el
 * modelo, el idioma y el audio en un formulario— y lo que se hace con lo que
 * responde.
 */

let server: Server;
let baseUrl: string;
let recibido: { ruta: string; autorizacion: string | undefined; tipo: string | undefined; cuerpo: string } | null;
let responder: () => { status: number; cuerpo: string };

beforeEach(async () => {
  recibido = null;
  responder = () => ({ status: 200, cuerpo: JSON.stringify({ text: ' quisiera que crees la clase Producto ' }) });
  server = createServer((request, response) => {
    const trozos: Buffer[] = [];
    request.on('data', (t: Buffer) => trozos.push(t));
    request.on('end', () => {
      recibido = {
        ruta: request.url ?? '',
        autorizacion: request.headers.authorization,
        tipo: request.headers['content-type'],
        cuerpo: Buffer.concat(trozos).toString('latin1'),
      };
      const { status, cuerpo } = responder();
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(cuerpo);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const transcriptor = () => crearTranscriptorGroq({ apiKey: 'clave-de-prueba', baseUrl, timeoutMs: 1000 });

describe('crearTranscriptorGroq', () => {
  it('manda el audio en un formulario con la clave, el modelo y el castellano, y devuelve el texto limpio', async () => {
    const texto = await transcriptor().transcribir(Buffer.from('AUDIO-DE-PRUEBA'), 'audio/webm');

    expect(texto).toBe('quisiera que crees la clase Producto');
    expect(recibido?.ruta).toBe('/openai/v1/audio/transcriptions');
    expect(recibido?.autorizacion).toBe('Bearer clave-de-prueba');
    expect(recibido?.tipo).toMatch(/^multipart\/form-data/);
    expect(recibido?.cuerpo).toContain('whisper-large-v3-turbo');
    expect(recibido?.cuerpo).toContain('name="language"');
    expect(recibido?.cuerpo).toContain('AUDIO-DE-PRUEBA');
    expect(recibido?.cuerpo).toMatch(/filename="voz\.webm"/);
  });

  it('una respuesta de error es un ErrorDeVoz con su estado, sin el cuerpo del error', async () => {
    responder = () => ({ status: 429, cuerpo: JSON.stringify({ error: { message: 'secreto interno' } }) });

    const fallo = await transcriptor().transcribir(Buffer.from('x'), 'audio/ogg').catch((e: unknown) => e);

    expect(fallo).toBeInstanceOf(ErrorDeVoz);
    expect((fallo as ErrorDeVoz).status).toBe(429);
    expect((fallo as ErrorDeVoz).message).not.toContain('secreto');
  });
});
