import { Router } from 'express';
import { z } from 'zod';
import type { SintetizadorDeVoz } from '../ai/voz-elevenlabs.js';
import { diaDeHoy } from '../storage/uso-ia.js';
import { HttpError, handler, parseBody } from './http.js';

/**
 * La voz del servidor (ElevenLabs) para el Modo IA. `app.ts` la monta con
 * sesión obligatoria y límite de tasa, porque cada audio gasta créditos de la
 * cuenta configurada.
 *
 * Cualquier fallo —sin voz configurada, sin créditos, clave inválida, sin
 * red— es un 503 con `code: 'voz_no_disponible'`: el navegador lo entiende
 * como «habla con tu propia voz», que es lo que hacía antes de que existiera
 * esta ruta.
 */

/** Las respuestas de la IA son de una o dos frases; mil caracteres sobran y acotan el gasto. */
const MAXIMO_CARACTERES = 1000;

/**
 * Caracteres por usuario y día. El plan gratuito da unos 20 000 caracteres al
 * mes con el modelo Flash; 3 000 al día (unas 20 respuestas) evitan que una
 * sola persona, o un bucle, se los lleve en una tarde. Al pasarlo, esa persona
 * sigue con la voz del navegador. La cuenta vive en este proceso: un reinicio
 * la pone a cero, que es aceptable para un tope de cortesía.
 */
export const MAXIMO_CARACTERES_DIARIOS = 3000;

const PeticionSchema = z.object({
  texto: z.string().trim().min(1).max(MAXIMO_CARACTERES),
});

export function vozRouter(voz: SintetizadorDeVoz | null, maximoDiario = MAXIMO_CARACTERES_DIARIOS): Router {
  const router = Router();
  const gastado = new Map<string, number>();

  router.get(
    '/estado',
    handler(async (_request, response) => {
      response.json({ elevenlabs: voz !== null });
    }),
  );

  router.post(
    '/sintetizar',
    handler(async (request, response) => {
      const body = parseBody(PeticionSchema, request.body);
      if (!voz) throw new HttpError(503, 'No hay voz del servidor configurada.', 'voz_no_disponible');
      const clave = `${request.user.id}\u0000${diaDeHoy()}`;
      const hoy = gastado.get(clave) ?? 0;
      if (hoy + body.texto.length > maximoDiario) {
        throw new HttpError(503, 'Por hoy se acabó la voz del servidor.', 'voz_no_disponible');
      }
      // Se cuenta antes de llamar: dos pedidos a la vez no pasan con el mismo cupo.
      // Las claves de otros días se olvidan para que el mapa no crezca.
      for (const otra of gastado.keys()) if (!otra.endsWith(diaDeHoy())) gastado.delete(otra);
      gastado.set(clave, hoy + body.texto.length);
      let audio: { datos: ArrayBuffer; tipo: string };
      try {
        audio = await voz.sintetizar(body.texto);
      } catch (error) {
        // Solo el estado: el cuerpo del error del proveedor no se registra.
        console.warn('La voz del servidor falló:', (error as { status?: number }).status ?? 'sin respuesta');
        throw new HttpError(503, 'La voz del servidor no está disponible ahora.', 'voz_no_disponible');
      }
      response.setHeader('content-type', audio.tipo);
      response.setHeader('cache-control', 'no-store');
      response.end(Buffer.from(audio.datos));
    }),
  );

  return router;
}
