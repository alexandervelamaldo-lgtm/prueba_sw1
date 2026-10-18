import { describe, expect, it } from 'vitest';
import type { ChatMessage, ConversationStore } from '../storage/conversaciones.js';
import type { AssistantEngine } from './assistant.js';
import type { CupoDeIA } from './cupo-ia.js';
import { crearResumidor } from './memoria-resumida.js';

/**
 * El resumen de lo que sale de la ventana de un hilo, sin red ni disco: lo que
 * hay que sujetar es la fila por hilo (cada resumen parte del anterior), que
 * sin cupo no se llama al modelo y que lo gastado se cuenta.
 */

const mensaje = (texto: string): ChatMessage => ({ role: 'user', texto, autorId: 'ana', creadoEn: '', tipo: 'respuesta' });

function preparar(opciones: { conCupo?: boolean } = {}) {
  const resumenes = new Map<string, string>();
  const conversaciones = {
    getResumen: async (p: string, u: string) => resumenes.get(`${p}/${u}`) ?? null,
    setResumen: async (p: string, u: string, r: string) => {
      resumenes.set(`${p}/${u}`, r);
    },
  } as unknown as ConversationStore;
  const llamadas: { previo: string | null; textos: string[] }[] = [];
  const asistente = {
    resumirConversacion: async (previo: string | null, mensajes: ChatMessage[], registrar?: (n: number) => void) => {
      llamadas.push({ previo, textos: mensajes.map((m) => m.texto) });
      registrar?.(30);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [previo, mensajes.map((m) => m.texto).join(',')].filter(Boolean).join(' | ');
    },
  } as unknown as AssistantEngine;
  const gastado: number[] = [];
  const cupo: CupoDeIA = {
    reservar: async () => {
      if (opciones.conCupo === false) return null;
      let total = 0;
      return {
        registrar: (n) => {
          total += n;
        },
        cerrar: async () => {
          gastado.push(total);
        },
      };
    },
  };
  const resumidor = crearResumidor({ conversations: conversaciones, assistant: asistente, cupo });
  return { resumidor, resumenes, llamadas, gastado };
}

describe('crearResumidor', () => {
  it('en fila por hilo: el segundo resumen parte del que dejó el primero', async () => {
    const { resumidor, resumenes, llamadas } = preparar();

    resumidor.resumir('P', 'ana', [mensaje('a')]);
    resumidor.resumir('P', 'ana', [mensaje('b')]);
    await resumidor.esperar('P', 'ana');

    expect(llamadas.map((l) => l.previo)).toEqual([null, 'a']);
    expect(resumenes.get('P/ana')).toBe('a | b');
  });

  it('lo que gasta el modelo se cuenta para el dueño del hilo', async () => {
    const { resumidor, gastado } = preparar();

    resumidor.resumir('P', 'ana', [mensaje('a')]);
    await resumidor.esperar('P', 'ana');

    expect(gastado).toEqual([30]);
  });

  it('sin cupo no llama al modelo: guarda el resumen local', async () => {
    const { resumidor, resumenes, llamadas } = preparar({ conCupo: false });

    resumidor.resumir('P', 'ana', [mensaje('crea Pedido')]);
    await resumidor.esperar('P', 'ana');

    expect(llamadas).toEqual([]);
    expect(resumenes.get('P/ana')).toContain('crea Pedido');
  });

  it('sin mensajes que resumir no hace nada', async () => {
    const { resumidor, llamadas } = preparar();

    resumidor.resumir('P', 'ana', []);
    await resumidor.esperar('P', 'ana');

    expect(llamadas).toEqual([]);
  });
});
