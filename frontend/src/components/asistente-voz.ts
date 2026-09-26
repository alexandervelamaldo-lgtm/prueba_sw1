import { describeBatchImpact, type ClassDiagram, type Operation } from '@app/shared';

/**
 * Qué hacer con una orden ya interpretada, cuando llegó dictada (RF-IA-04, D6).
 *
 * Separado de `Asistente.tsx` para poder probarlo con un diagrama y una lista
 * de operaciones, sin `speechSynthesis` ni un componente montado — el mismo
 * motivo por el que `barra-pulgar.ts` o `movil-acciones.ts` viven fuera del
 * `.tsx` que los usa.
 *
 * Solo decide para la voz. Lo escrito a mano siempre para en la propuesta con
 * botón «Aplicar»: ese camino no pasa por aquí porque no hay nada que decidir,
 * la respuesta es siempre la misma.
 */

export interface PropuestaOperacion {
  operacion: Operation;
  descripcion: string;
}

/**
 * Une las descripciones de una propuesta en una sola frase, para hablarla o
 * escribirla de un tirón. Con una sola operación es su descripción tal cual;
 * con varias, la lista separada por «;» — la misma puntuación que ya usa el
 * texto en pantalla, para que lo hablado y lo escrito no diverjan.
 */
export function resumirPropuesta(propuesta: PropuestaOperacion[]): string {
  if (propuesta.length === 1) return propuesta[0]?.descripcion ?? '';
  return propuesta.map((p) => p.descripcion).join('; ');
}

/**
 * Lo que se dice en voz alta cuando una orden no destructiva se aplicó sola.
 *
 * Deliberadamente no es la descripción de la operación. Antes lo era —«Hecho:
 * añadir el atributo correo a Cliente»— y sonaba a que la aplicación leía su
 * propio registro de cambios en vez de contestar a quien le habló: nadie dice
 * «he abierto la puerta con la llave que llevaba en la mano derecha» cuando le
 * piden que abra una puerta, dice «ya está». El detalle de qué se hizo sigue
 * en pantalla (`AccionVoz['aplicar']['detalle']`) para quien quiera revisarlo
 * con la vista.
 */
const CONFIRMACION_HABLADA = 'Trabajo hecho.';

export type AccionVoz =
  /**
   * Hay que enseñar la propuesta y esperar el botón, exactamente como con lo
   * escrito a mano. D6 no cede aquí: `anuncio` es lo que se habla para que
   * quien dictó, y quizá no está mirando la pantalla, sepa que algo espera su
   * confirmación en vez de asumir que ya se hizo. Aquí sí hace falta detallar
   * qué se perdería: no es un resultado que contar, es la pregunta en sí.
   */
  | { tipo: 'confirmar'; anuncio: string }
  /**
   * No destruye nada: se puede aplicar sola. `anuncio` es la frase corta que
   * se dice si `aplicar` tiene éxito — quien llama decide qué hacer si falla.
   * `detalle` es la descripción completa, para el texto en pantalla, que
   * quien mira sí puede querer repasar aunque quien escucha no lo necesite.
   */
  | { tipo: 'aplicar'; anuncio: string; detalle: string };

/**
 * Decide entre las dos ramas de arriba a partir del impacto real sobre el
 * diagrama — no del tipo de operación a secas, porque la misma operación
 * destruye cosas distintas según lo que haya (`setSeedRows` sobre una clase
 * vacía no borra nada; ver `describeBatchImpact`).
 *
 * Solo tiene sentido llamarla con al menos una operación: la orden que no
 * produjo ninguna («no entendí eso») se resuelve antes, en `Asistente.tsx`,
 * igual para voz que para texto.
 */
export function decidirAccionVoz(
  diagrama: ClassDiagram,
  propuesta: PropuestaOperacion[],
): AccionVoz {
  const impacto = describeBatchImpact(
    diagrama,
    propuesta.map((p) => p.operacion),
  );
  const resumen = resumirPropuesta(propuesta);

  if (impacto.destructiva) {
    return {
      tipo: 'confirmar',
      anuncio: `${resumen}. Esto borraría ${impacto.perdidas.join(', ')}. Toca aplicar para confirmarlo.`,
    };
  }
  return { tipo: 'aplicar', anuncio: CONFIRMACION_HABLADA, detalle: `Hecho: ${resumen}.` };
}
