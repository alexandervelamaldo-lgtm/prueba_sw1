import { describe, expect, it } from 'vitest';
import { crearDetectorDeSilencio } from './grabacion-servidor';

/**
 * Cuándo deja de grabar el micrófono en los navegadores sin reconocimiento de
 * voz propio (Firefox): lo decide el nivel del audio, muestra a muestra. Se
 * prueba con niveles y relojes inventados, sin micrófono.
 */
const opciones = { umbral: 0.02, msSilencioTrasHablar: 1500, msEsperaSinVoz: 15_000, msMaximo: 30_000 };

describe('crearDetectorDeSilencio', () => {
  it('sigue mientras se habla y termina tras una pausa después de hablar', () => {
    const detector = crearDetectorDeSilencio(opciones);

    expect(detector.muestra(0.001, 0)).toBe('seguir');
    expect(detector.muestra(0.2, 500)).toBe('seguir');
    expect(detector.muestra(0.001, 1500)).toBe('seguir');
    expect(detector.muestra(0.001, 2100)).toBe('terminar');
  });

  it('una pausa corta en medio de la frase no corta', () => {
    const detector = crearDetectorDeSilencio(opciones);

    detector.muestra(0.2, 0);
    expect(detector.muestra(0.001, 1000)).toBe('seguir');
    expect(detector.muestra(0.2, 1400)).toBe('seguir');
    expect(detector.muestra(0.001, 2800)).toBe('seguir');
  });

  it('si nadie habla, se rinde sin mandar nada', () => {
    const detector = crearDetectorDeSilencio(opciones);

    expect(detector.muestra(0.001, 0)).toBe('seguir');
    expect(detector.muestra(0.005, 14_000)).toBe('seguir');
    expect(detector.muestra(0.001, 15_000)).toBe('sin-voz');
  });

  it('no graba sin fin: al máximo, termina aunque se siga hablando', () => {
    const detector = crearDetectorDeSilencio(opciones);

    detector.muestra(0.2, 0);
    expect(detector.muestra(0.2, 29_000)).toBe('seguir');
    expect(detector.muestra(0.2, 30_000)).toBe('terminar');
  });
});

import { afterEach, vi } from 'vitest';
import { dictarGrabando } from './grabacion-servidor';

/** Un micrófono de mentira que anota si se cerró. */
function microfonoFalso() {
  const pista = { detenida: false, stop() { pista.detenida = true; } };
  const flujo = { getTracks: () => [pista] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => flujo } });
  return pista;
}

class GrabadoraFalsa {
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x']) }); this.onstop?.(); }
}

class ContextoFalso {
  createAnalyser() { return { fftSize: 0, getFloatTimeDomainData() {} }; }
  createMediaStreamSource() { return { connect() {} }; }
  close() { return Promise.resolve(); }
}

const esperar = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(() => vi.unstubAllGlobals());

describe('dictarGrabando no deja el micrófono abierto', () => {
  it('si falla la preparación de la grabación, cierra el micrófono y lo dice', async () => {
    const pista = microfonoFalso();
    vi.stubGlobal('MediaRecorder', class { static isTypeSupported = () => true; constructor() { throw new Error('sin códec'); } });
    vi.stubGlobal('AudioContext', ContextoFalso);
    const avisos: string[] = [];

    dictarGrabando({ onFinal: () => avisos.push('final'), onError: () => avisos.push('error'), onFin: () => avisos.push('fin') }, async () => 'x');
    await esperar();

    expect(pista.detenida).toBe(true);
    expect(avisos).toEqual(['error', 'fin']);
  });

  it('cancelar (al cerrar el panel) cierra el micrófono y no manda nada a transcribir', async () => {
    const pista = microfonoFalso();
    vi.stubGlobal('MediaRecorder', GrabadoraFalsa);
    vi.stubGlobal('AudioContext', ContextoFalso);
    let transcritas = 0;
    const avisos: string[] = [];

    const sesion = dictarGrabando(
      { onFinal: () => avisos.push('final'), onError: () => avisos.push('error'), onFin: () => avisos.push('fin') },
      async () => {
        transcritas += 1;
        return 'x';
      },
    );
    await esperar();
    sesion.cancelar();
    await esperar();

    expect(pista.detenida).toBe(true);
    expect(transcritas).toBe(0);
    expect(avisos).toEqual(['fin']);
  });
});
