import type { FitViewOptions } from '@xyflow/react';
import type { Acoplado } from './paneles';
import type { EstadoAvatarIA } from './AvatarIA';

/**
 * Decisiones puras de visibilidad y estado para el Modo IA inmersivo.
 *
 * Mantiene separada la lógica de control visual respecto a los componentes de
 * React, facilitando su prueba unitaria sin DOM ni efectos secundarios.
 */

/**
 * Determina si un panel acoplado debe mostrarse o esconderse según si el editor
 * está en Modo IA o en modo normal.
 *
 * En Modo IA se mantiene el árbol del proyecto (`arbol`) y la conversación de
 * la IA (`ia`). Los demás paneles (`paleta`, `propiedades`, `historial`,
 * `tablon`, `versiones`) quedan ocultos para enfocar la vista en el lienzo y la IA.
 */
export function panelVisibleEnModoIA(acoplado: Acoplado, enModoIA: boolean): boolean {
  if (!enModoIA) return true;
  return acoplado === 'arbol' || acoplado === 'ia';
}

/**
 * Filtra la lista de paneles de una columna acoplada respetando las reglas del
 * Modo IA. Si no se está en Modo IA, devuelve el arreglo original intacto para
 * no generar referencias innecesarias.
 */
export function filtrarPanelesParaModoIA<T extends { acoplado: Acoplado }>(
  paneles: T[],
  enModoIA: boolean,
): T[] {
  if (!enModoIA) return paneles;
  return paneles.filter((panel) => panelVisibleEnModoIA(panel.acoplado, true));
}

/**
 * Define si la bienvenida del Modo IA debe mantenerse fija en pantalla.
 *
 * En un diagrama vacío (sin clases creadas todavía), el mensaje se retiene
 * hasta que aparezca la primera clase en el diagrama.
 */
export function debeRetenerBienvenida(totalClases: number): boolean {
  return totalClases === 0;
}

/**
 * Valida si pulsar la tecla Escape debe abandonar el Modo IA.
 *
 * Si hay un diálogo modal abierto (importación, generación, etc.), la tecla
 * Escape debe cerrarlo a él y no cerrar el Modo IA.
 */
export function debeSalirConEscape(
  evento: { key: string },
  hayModalAbierto: boolean,
  enModoIA: boolean = true,
): boolean {
  if (evento.key !== 'Escape') return false;
  if (!enModoIA) return false;
  return !hayModalAbierto;
}

/**
 * Decide si un atajo de teclado debe ignorarse cuando el foco está en un campo
 * de entrada (`input`, `textarea`, `select`).
 *
 * Fuera del Modo IA, todos los atajos se ignoran mientras se escribe en un campo.
 * En Modo IA, la tecla Escape NO se ignora (permite abandonar el modo desde el chat),
 * pero las demás teclas siguen ignorándose para poder escribir normalmente.
 */
export function debeIgnorarAtajoEnCampo(
  esCampo: boolean,
  tecla: string,
  enModoIA: boolean,
): boolean {
  if (!esCampo) return false;
  if (enModoIA && tecla === 'Escape') return false;
  return true;
}

/**
 * Determina las acciones al entrar al Modo IA según el origen del gesto.
 *
 * Pulsar el avatar inicia el saludo y la conversación por voz (micrófono abierto).
 * Entrar por el menú (Ver > Modo IA) entra al modo y lanza el efecto visual Lumina,
 * pero no abre el micrófono ni saluda automáticamente.
 */
export function accionEntradaModoIA(origen: 'avatar' | 'menu'): {
  iniciarSaludo: boolean;
  iniciarConversacion: boolean;
  dispararEfecto: boolean;
} {
  if (origen === 'avatar') {
    return {
      iniciarSaludo: true,
      iniciarConversacion: true,
      dispararEfecto: true,
    };
  }
  return {
    iniciarSaludo: false,
    iniciarConversacion: false,
    dispararEfecto: true,
  };
}

/**
 * Etiqueta accesible y de ayuda para el avatar de la IA.
 *
 * En Modo IA inmersivo describe la acción concreta del avatar:
 * si la conversación ya está abierta, ofrece salir del modo conversación;
 * si no, ofrece iniciarla. Fuera del modo inmersivo devuelve `undefined`
 * para que el componente use su etiqueta por defecto.
 */
export function etiquetaAvatarIA(
  enModoIA: boolean,
  conversacionActiva: boolean,
): string | undefined {
  if (!enModoIA) return undefined;
  return conversacionActiva ? 'Salir del modo conversación' : 'Iniciar conversación';
}

/**
 * Define si el orbe de pensamiento de la IA debe estar visible.
 *
 * Se muestra exclusivamente cuando el editor está en Modo IA inmersivo
 * y el avatar/motor de IA se encuentra en estado 'pensando'.
 */
export function debeMostrarOrbe(enModoIA: boolean, estadoIA: EstadoAvatarIA): boolean {
  return enModoIA && estadoIA === 'pensando';
}

/**
 * Determina el icono y la descripción accesible del botón de alternar tema
 * en la cabecera del Modo IA inmersivo (S7).
 *
 * Mantiene la misma correspondencia que el comando del menú: si el tema
 * actual es oscuro, el icono ofrece pasar a claro con la etiqueta
 * "Cambiar a modo día"; si es claro, ofrece pasar a oscuro con
 * "Cambiar a modo noche".
 */
export function botonTemaModoIA(tema: 'claro' | 'oscuro'): {
  icono: 'tema-claro' | 'tema-oscuro';
  etiqueta: 'Cambiar a modo día' | 'Cambiar a modo noche';
} {
  if (tema === 'oscuro') {
    return {
      icono: 'tema-claro',
      etiqueta: 'Cambiar a modo día',
    };
  }
  return {
    icono: 'tema-oscuro',
    etiqueta: 'Cambiar a modo noche',
  };
}

export const ETIQUETAS_PENSANDO = [
  'Pensando',
  'Buscando',
  'Analizando',
  'Redactando',
] as const;

export type EtiquetaPensando = (typeof ETIQUETAS_PENSANDO)[number];

/**
 * Devuelve el estado de texto y de pulso del orbe a partir del índice de paso.
 */
export function estadoProgresoOrbe(paso: number): {
  prog: number;
  etiqueta: EtiquetaPensando;
} {
  const prog = ((paso % 4) + 4) % 4;
  return {
    prog,
    etiqueta: ETIQUETAS_PENSANDO[prog] ?? 'Pensando',
  };
}

/**
 * Calcula el siguiente paso de rotación de etiquetas para el orbe.
 */
export function siguientePasoOrbe(pasoActual: number): {
  paso: number;
  prog: number;
  etiqueta: EtiquetaPensando;
} {
  const paso = pasoActual + 1;
  const { prog, etiqueta } = estadoProgresoOrbe(paso);
  return {
    paso,
    prog,
    etiqueta,
  };
}


/**
 * El margen con el que encuadrar el lienzo.
 *
 * En el Modo IA la barra flotante cubre el 45 % inferior: lo que se encuadre
 * tiene que caer por encima de ella, o la IA crearía clases que no se ven.
 */
export function paddingDeEncuadre(padding: number, enModoIA: boolean): FitViewOptions['padding'] {
  if (!enModoIA) return padding;
  return { top: padding, left: padding, right: padding, bottom: '50%' };
}
