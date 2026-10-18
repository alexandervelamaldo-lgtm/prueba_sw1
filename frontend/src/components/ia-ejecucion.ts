import {
  describeBatchImpact,
  isDestructiveOperation,
  type Aplicar,
  type ClassDiagram,
  type ContextoCambio,
  type Operation,
} from '@app/shared';
import type { GrupoDeshacer } from '../hooks/deshacer-agrupado';
import type { PropuestaOperacion } from './asistente-voz';

/**
 * La IA del Modo IA aplicando sola sus cambios, paso a paso, con un cursor que
 * recorre los botones reales de la interfaz.
 *
 * Separado de `ModoIA.tsx` por el mismo motivo que `asistente-voz.ts`: así se
 * prueba con dobles del cursor y del lienzo, sin DOM ni temporizadores.
 *
 * El cursor es una representación: por detrás no se dispara ningún clic real,
 * se llama a `aplicar`, el único camino por el que se escribe en el diagrama.
 * Disparar clics de verdad dependería de qué paneles están abiertos y de los
 * estados intermedios de cada botón; aplicar directamente no.
 */

export type PlanEjecucion = 'nada' | 'automatico' | 'confirmar';

/**
 * Qué hacer con una propuesta del Modo IA. Se aplica sola solo si el
 * interruptor está encendido, se puede escribir y no se pierde nada: lo que
 * borra algo sigue pidiendo su «Aplicar», con el mismo cálculo de impacto que
 * usa `PropuestaOperaciones` para su confirmación. Además se mira la lista de
 * operaciones destructivas: el cálculo de impacto no cuenta todas (por
 * ejemplo `removeModule`), y aquí un hueco significaría borrar sin preguntar.
 */
export function planificarEjecucion(
  diagrama: ClassDiagram,
  propuesta: PropuestaOperacion[],
  opciones: { autoAplicar: boolean; soloLectura: boolean },
): PlanEjecucion {
  if (propuesta.length === 0) return 'nada';
  if (!opciones.autoAplicar || opciones.soloLectura) return 'confirmar';
  const operaciones = propuesta.map((p) => p.operacion);
  const destructiva =
    operaciones.some(isDestructiveOperation) || describeBatchImpact(diagrama, operaciones).destructiva;
  return destructiva ? 'confirmar' : 'automatico';
}

/**
 * El botón de la interfaz que haría lo mismo que la operación, marcado con
 * `data-ia` (ver `Paleta.tsx`). `null` cuando no hay un botón visible que la
 * represente —añadir un atributo se hace en el panel de propiedades de la
 * clase—: entonces el cursor va directo a la clase.
 */
export function selectorDeBoton(operacion: Operation): string | null {
  switch (operacion.op) {
    case 'addClass':
      return `[data-ia="addClass:${operacion.kind ?? 'class'}"]`;
    case 'addRelation':
      return `[data-ia="addRelation:${operacion.kind}"]`;
    default:
      return null;
  }
}

export interface CursorIA {
  mover(destino: Element): Promise<void>;
  clic(): Promise<void>;
  ocultar(): void;
}

export interface DependenciasEjecucion {
  aplicar: Aplicar;
  /** Va al historial: quién propuso el cambio. */
  contexto: ContextoCambio;
  /** Centra la cámara del lienzo en esas clases. */
  centrar(ids: string[]): void;
  resaltar(id: string): void;
  buscar(selector: string): Element | null;
  /** El nodo del lienzo de esa clase, si está pintado. */
  nodo(id: string): Element | null;
  /** `null` sin animación (por ejemplo, con `prefers-reduced-motion`). */
  cursor: CursorIA | null;
  /** Pausa entre dos pasos, para que se vea cada uno. */
  pausaMs: number;
  esperar(ms: number): Promise<void>;
  /** Abre un grupo de deshacer; ver `hooks/deshacer-agrupado.ts`. */
  agrupar?(): GrupoDeshacer;
  /** `true` si ya no hay que seguir (por ejemplo, se cerró el panel). */
  cancelado?(): boolean;
}

/** Lo que tarda `centrar` en mover la cámara (`LienzoFlow`, `fitView`). */
const ESPERA_CAMARA_MS = 260;

/**
 * Aplica las operaciones de una en una, en orden. Todas forman un solo paso de
 * deshacer: «deshaz lo último» revierte la respuesta entera de la IA, no solo
 * su último paso. Se detiene en la primera que falla o si se cancela; lo ya
 * aplicado se queda (se deshace junto con el grupo).
 */
export async function ejecutarPropuesta(
  operaciones: Operation[],
  deps: DependenciasEjecucion,
): Promise<{ aplicadas: number; error: string | null }> {
  const grupo = deps.agrupar?.();
  const { cursor } = deps;
  let aplicadas = 0;

  try {
    for (const [indice, operacion] of operaciones.entries()) {
      if (deps.cancelado?.()) break;
      const selector = selectorDeBoton(operacion);
      const boton = cursor && selector ? deps.buscar(selector) : null;
      if (cursor && boton) {
        await cursor.mover(boton);
        await cursor.clic();
      }

      const aplicarPaso = () => deps.aplicar([operacion], deps.contexto);
      const resultado = grupo ? grupo.propio(aplicarPaso) : aplicarPaso();
      if (!resultado.ok) return { aplicadas, error: resultado.error };
      aplicadas += 1;

      const clase = resultado.clases?.[0];
      if (clase) {
        deps.centrar([clase]);
        deps.resaltar(clase);
        if (cursor) {
          await deps.esperar(ESPERA_CAMARA_MS);
          const nodo = deps.nodo(clase);
          if (nodo) await cursor.mover(nodo);
        }
      }

      if (indice < operaciones.length - 1) await deps.esperar(deps.pausaMs);
    }
    return { aplicadas, error: null };
  } finally {
    cursor?.ocultar();
    grupo?.cerrar();
  }
}
