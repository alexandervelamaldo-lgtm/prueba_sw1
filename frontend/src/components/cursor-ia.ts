import type { CursorIA } from './ia-ejecucion';

/**
 * El cursor fantasma del Modo IA y el resaltado de la clase que toca: la parte
 * de `ia-ejecucion.ts` que sí necesita el DOM. Es un `div` fijo sobre toda la
 * página que se desplaza con una transición CSS (`.cursor-ia` en
 * `estilos.css`); no recibe eventos, así que nunca tapa un clic de verdad.
 */

/** Lo que dura el desplazamiento; igual que la transición de `.cursor-ia`. */
const DURACION_MOVIMIENTO_MS = 450;
const DURACION_CLIC_MS = 220;
const DURACION_RESALTADO_MS = 1600;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** El centro de un elemento, para colocar ahí la punta del cursor. */
function centroDe(elemento: Element): { x: number; y: number } {
  const caja = elemento.getBoundingClientRect();
  return { x: caja.left + caja.width / 2, y: caja.top + caja.height / 2 };
}

/**
 * Crea el cursor. Aparece sobre `desde` (el panel del Modo IA) para que se vea
 * salir de la conversación hacia el botón, en vez de surgir de la nada.
 */
export function crearCursorIA(desde: Element | null): CursorIA {
  let elemento: HTMLDivElement | null = null;

  const asegurar = (): HTMLDivElement => {
    if (elemento) return elemento;
    const nuevo = document.createElement('div');
    nuevo.className = 'cursor-ia';
    nuevo.setAttribute('aria-hidden', 'true');
    const inicio = desde ? centroDe(desde) : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    nuevo.style.transform = `translate(${inicio.x}px, ${inicio.y}px)`;
    document.body.append(nuevo);
    // Fuerza el primer pintado en la posición de inicio, para que el primer
    // `mover` sí se anime en vez de aparecer ya en el destino.
    void nuevo.offsetWidth;
    nuevo.classList.add('cursor-ia--visible');
    elemento = nuevo;
    return nuevo;
  };

  return {
    async mover(destino) {
      const cursor = asegurar();
      const { x, y } = centroDe(destino);
      cursor.style.transform = `translate(${x}px, ${y}px)`;
      await esperar(DURACION_MOVIMIENTO_MS);
    },
    async clic() {
      const cursor = asegurar();
      cursor.classList.remove('cursor-ia--clic');
      void cursor.offsetWidth;
      cursor.classList.add('cursor-ia--clic');
      await esperar(DURACION_CLIC_MS);
    },
    ocultar() {
      elemento?.remove();
      elemento = null;
    },
  };
}

/** El nodo del lienzo de una clase: React Flow pone el id del nodo en `data-id`. */
export function nodoDeClase(id: string): Element | null {
  return document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
}

/** Ilumina un momento la clase que la IA acaba de tocar. */
export function resaltarClase(id: string): void {
  // El nodo puede no existir todavía: React pinta la clase recién creada en el
  // siguiente fotograma.
  requestAnimationFrame(() => {
    const nodo = nodoDeClase(id);
    if (!nodo) return;
    nodo.classList.remove('nodo-ia');
    void (nodo as HTMLElement).offsetWidth;
    nodo.classList.add('nodo-ia');
    setTimeout(() => nodo.classList.remove('nodo-ia'), DURACION_RESALTADO_MS);
  });
}

/** Con «menos movimiento» pedido en el sistema, la IA aplica sin cursor. */
export function prefiereMenosMovimiento(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
