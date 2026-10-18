import type * as Y from 'yjs';

/**
 * Grupos de deshacer para el Modo IA: todo lo que la IA aplica en una respuesta
 * es un solo paso, aunque lo aplique de una en una y con pausas más largas que
 * la ventana normal de Yjs (500 ms).
 *
 * Mientras hay un grupo abierto la ventana es infinita, y por eso hay que
 * separar lo de la IA de lo que haga la persona a mano en ese rato: los dos
 * llegan con el mismo origen local. Todo `aplicar` de `useDiagrama` pasa por
 * `ajeno`, que corta la captura antes y después del cambio; lo que aplica la
 * IA va además dentro de `propio`, que se salta ese corte. Así un cambio a
 * mano en medio del grupo es su propio paso y deshacer la IA nunca se lo
 * lleva. El precio es que esa respuesta de la IA queda partida en dos pasos.
 *
 * Los grupos se pueden anidar (dos respuestas seguidas): la ventana vuelve a
 * su valor cuando se cierra el último.
 */
export interface GrupoDeshacer {
  /** Ejecuta un cambio que pertenece al grupo. */
  propio<T>(cambio: () => T): T;
  /** Cierra el grupo. Llamarlo más de una vez no hace nada. */
  cerrar(): void;
}

export interface AgrupadorDeshacer {
  abrir(): GrupoDeshacer;
  /** Envuelve todo cambio que se escribe en el documento; ver la cabecera. */
  ajeno<T>(cambio: () => T): T;
}

export function crearAgrupadorDeshacer(gestor: () => Y.UndoManager | null): AgrupadorDeshacer {
  let abiertos = 0;
  let ventana = 0;
  let dentroDelGrupo = false;

  return {
    abrir() {
      const manager = gestor();
      if (!manager) return { propio: (cambio) => cambio(), cerrar: () => {} };

      if (abiertos === 0) {
        ventana = manager.captureTimeout;
        manager.stopCapturing();
        manager.captureTimeout = Number.POSITIVE_INFINITY;
      }
      abiertos += 1;

      let cerrado = false;
      return {
        propio(cambio) {
          dentroDelGrupo = true;
          try {
            return cambio();
          } finally {
            dentroDelGrupo = false;
          }
        },
        cerrar() {
          if (cerrado) return;
          cerrado = true;
          abiertos -= 1;
          if (abiertos === 0) {
            manager.captureTimeout = ventana;
            manager.stopCapturing();
          }
        },
      };
    },

    ajeno(cambio) {
      const manager = gestor();
      if (abiertos === 0 || dentroDelGrupo || !manager) return cambio();
      manager.stopCapturing();
      try {
        return cambio();
      } finally {
        manager.stopCapturing();
      }
    },
  };
}
