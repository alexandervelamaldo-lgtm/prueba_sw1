import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatearEventoSse, type EventoAsistente } from '@app/shared';
import { ApiError, api, setToken } from './api';

/**
 * El cliente del Modo IA en streaming contra un `fetch` de mentira que entrega
 * el cuerpo en trozos, cortados a propósito por la mitad de un evento: es como
 * llega de verdad por la red.
 */

function respuestaEnTrozos(trozos: string[], status = 200): Response {
  const codificador = new TextEncoder();
  const cuerpo = new ReadableStream<Uint8Array>({
    start(controlador) {
      for (const trozo of trozos) controlador.enqueue(codificador.encode(trozo));
      controlador.close();
    },
  });
  return new Response(cuerpo, { status, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

describe('api.interpretarEnStream', () => {
  it('llama a la ruta de streaming con el token y entrega cada evento en orden', async () => {
    const eventos: EventoAsistente[] = [
      { tipo: 'mensaje', texto: 'Creo Pedido.' },
      { tipo: 'operacion', operacion: { op: 'addClass', name: 'Pedido', kind: 'class' }, descripcion: 'Crear' },
      { tipo: 'fin', motor: 'prueba', confianza: 1 },
    ];
    const texto = eventos.map(formatearEventoSse).join('');
    const fetchFalso = vi.fn(async () => respuestaEnTrozos([texto.slice(0, 17), texto.slice(17, 60), texto.slice(60)]));
    vi.stubGlobal('fetch', fetchFalso);
    setToken('token-de-prueba');

    const recibidos: EventoAsistente[] = [];
    await api.interpretarEnStream('P1', 'crea Pedido', (evento) => recibidos.push(evento));

    expect(recibidos).toEqual(eventos);
    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/proyectos/P1/asistente/stream');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ texto: 'crea Pedido' }));
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-de-prueba');
  });

  it('una revisión lo dice en el cuerpo de la petición', async () => {
    const fetchFalso = vi.fn(async () => respuestaEnTrozos([formatearEventoSse({ tipo: 'fin', motor: 'm', confianza: 1 })]));
    vi.stubGlobal('fetch', fetchFalso);

    await api.interpretarEnStream('P1', 'Revisa mi diagrama', () => {}, undefined, { revision: true });

    const [, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ texto: 'Revisa mi diagrama', revision: true }));
  });

  it('la clase seleccionada viaja en el cuerpo de la petición', async () => {
    const fetchFalso = vi.fn(async () => respuestaEnTrozos([formatearEventoSse({ tipo: 'fin', motor: 'm', confianza: 1 })]));
    vi.stubGlobal('fetch', fetchFalso);

    await api.interpretarEnStream('P1', 'añádele un email', () => {}, undefined, { seleccion: 'C1' });

    const [, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ texto: 'añádele un email', seleccion: 'C1' }));
  });

  it('una respuesta de error del servidor es un ApiError con su mensaje', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Sin permiso' }), { status: 403 })),
    );

    await expect(api.interpretarEnStream('P1', 'hola', () => {})).rejects.toMatchObject({
      status: 403,
      message: 'Sin permiso',
    });
  });

  it('sin red es un ApiError de red', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const fallo = await api.interpretarEnStream('P1', 'hola', () => {}).catch((error: unknown) => error);
    expect(fallo).toBeInstanceOf(ApiError);
    expect((fallo as ApiError).esDeRed).toBe(true);
  });
});
