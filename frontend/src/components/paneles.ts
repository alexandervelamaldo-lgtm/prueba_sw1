/**
 * La disposición de los paneles acoplados, sin React.
 *
 * Está separada del hook por la misma razón que `geometria-lienzo.ts` lo está
 * del lienzo: son reglas —cuánto puede medir una columna, cuándo se pliega sola,
 * qué hacer con lo que había guardado de una versión anterior— y las reglas se
 * prueban sin montar un navegador. Aquí no se toca `localStorage` ni el DOM.
 */

/** Los seis paneles acoplados: dos a la izquierda y cuatro a la derecha. */
export type Acoplado = 'arbol' | 'paleta' | 'propiedades' | 'historial' | 'tablon' | 'ia' | 'versiones';

export type Lado = 'izquierda' | 'derecha';

/**
 * El tablón va a la derecha, con el historial, y la IA con ellos.
 *
 * Los tres contestan a «qué ha pasado aquí» —cambios, lo que se dijo sobre
 * ellos y lo que se le pidió a la IA— mientras que la izquierda es con lo que
 * se trabaja. Puestos en la misma columna se alternan en vez de competir por
 * el ancho, y abrir el Modo IA no obliga a estrechar el lienzo ni tapa el
 * resto del editor, que es justo lo que hacía el modal que este panel
 * sustituye.
 */
export const ACOPLADOS_POR_LADO: Record<Lado, readonly Acoplado[]> = {
  izquierda: ['arbol', 'paleta'],
  derecha: ['propiedades', 'historial', 'tablon', 'ia', 'versiones'],
};

export const TITULOS: Record<Acoplado, string> = {
  arbol: 'Proyecto',
  paleta: 'Paleta',
  propiedades: 'Propiedades',
  historial: 'Historial',
  tablon: 'Comunicación',
  ia: 'Modo IA',
  versiones: 'Versiones',
};

export interface EstadoColumna {
  /** Ancho en píxeles cuando está desplegada. Se conserva al plegar. */
  ancho: number;
  plegada: boolean;
}

export interface Disposicion {
  izquierda: EstadoColumna;
  derecha: EstadoColumna;
  /** Qué acoplados están desplegados dentro de su columna. */
  abiertos: Record<Acoplado, boolean>;
}

export const ANCHO_MINIMO = 180;
export const ANCHO_MAXIMO = 480;

/**
 * Por debajo de esto, arrastrar la canaleta pliega la columna en vez de
 * estrecharla más.
 *
 * Una columna de sesenta píxeles no es una columna estrecha: es un panel roto
 * que sigue ocupando sitio. Plegarla sola es lo que el usuario estaba
 * intentando conseguir cuando arrastró hasta ahí.
 */
export const ANCHO_DE_PLIEGUE = 140;

const POR_DEFECTO = { izquierda: 240, derecha: 300 } as const;

/**
 * Cómo arranca quien no ha tocado nada.
 *
 * En un teléfono las dos columnas empiezan plegadas: lo que se ha venido a ver
 * es el diagrama, y un panel abierto de partida obliga a cerrarlo antes de
 * poder trabajar. En escritorio empiezan abiertas, porque hay sitio y porque un
 * editor que arranca vacío parece que no tiene nada.
 */
export function disposicionInicial(estrecha: boolean): Disposicion {
  return {
    izquierda: { ancho: POR_DEFECTO.izquierda, plegada: estrecha },
    derecha: { ancho: POR_DEFECTO.derecha, plegada: estrecha },
    // El tablón y la IA empiezan cerrados como el historial: se abren cuando
    // hay algo que decir o preguntar, y abiertos de partida convertirían el
    // editor en un chat con un diagrama al lado.
    abiertos: {
      arbol: true,
      paleta: true,
      propiedades: true,
      historial: false,
      tablon: false,
      ia: false,
      versiones: false,
    },
  };
}

function numeroValido(valor: unknown, porDefecto: number): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return porDefecto;
  return Math.min(ANCHO_MAXIMO, Math.max(ANCHO_MINIMO, Math.round(valor)));
}

function columnaValida(valor: unknown, porDefecto: EstadoColumna): EstadoColumna {
  if (typeof valor !== 'object' || valor === null) return porDefecto;
  const bruto = valor as Record<string, unknown>;
  return {
    ancho: numeroValido(bruto.ancho, porDefecto.ancho),
    plegada: typeof bruto.plegada === 'boolean' ? bruto.plegada : porDefecto.plegada,
  };
}

/**
 * Interpreta lo que había guardado.
 *
 * Todo campo que no se entienda se sustituye por el de partida, campo a campo y
 * no el objeto entero: quien guardó una disposición con una versión anterior no
 * debe perder el ancho de sus columnas porque hayamos añadido un panel nuevo.
 * Y un `localStorage` manipulado a mano no puede dejar la aplicación con una
 * columna de nueve mil píxeles.
 */
export function leerDisposicion(bruto: string | null, estrecha: boolean): Disposicion {
  const inicial = disposicionInicial(estrecha);
  if (bruto === null) return inicial;

  let datos: unknown;
  try {
    datos = JSON.parse(bruto);
  } catch {
    return inicial;
  }
  if (typeof datos !== 'object' || datos === null) return inicial;

  const objeto = datos as Record<string, unknown>;
  const abiertosGuardados =
    typeof objeto.abiertos === 'object' && objeto.abiertos !== null
      ? (objeto.abiertos as Record<string, unknown>)
      : {};

  const abiertos = { ...inicial.abiertos };
  for (const acoplado of Object.keys(abiertos) as Acoplado[]) {
    const valor = abiertosGuardados[acoplado];
    if (typeof valor === 'boolean') abiertos[acoplado] = valor;
  }

  return {
    izquierda: columnaValida(objeto.izquierda, inicial.izquierda),
    derecha: columnaValida(objeto.derecha, inicial.derecha),
    abiertos,
  };
}

/**
 * El ancho que resulta de soltar la canaleta en `pedido`.
 *
 * Devuelve la columna entera y no solo un número porque arrastrar hasta el
 * fondo es una forma de plegar, y eso cambia dos campos a la vez.
 */
export function redimensionar(columna: EstadoColumna, pedido: number): EstadoColumna {
  if (pedido < ANCHO_DE_PLIEGUE) return { ancho: columna.ancho, plegada: true };
  return { ancho: Math.min(ANCHO_MAXIMO, Math.max(ANCHO_MINIMO, Math.round(pedido))), plegada: false };
}

/**
 * Abrir un panel de una columna plegada la despliega.
 *
 * Sin esto, tocar «Propiedades» en el riel lateral marcaría el panel como
 * abierto y no se vería nada, que es indistinguible de que el botón no
 * funcione.
 */
export function abrirAcoplado(disposicion: Disposicion, acoplado: Acoplado): Disposicion {
  const lado: Lado = ACOPLADOS_POR_LADO.izquierda.includes(acoplado) ? 'izquierda' : 'derecha';
  return {
    ...disposicion,
    [lado]: { ...disposicion[lado], plegada: false },
    abiertos: { ...disposicion.abiertos, [acoplado]: true },
  };
}

/**
 * Plegar el último panel abierto de una columna pliega la columna.
 *
 * Una columna con sus dos paneles cerrados es una franja de títulos que ocupa
 * doscientos píxeles para no decir nada.
 */
export function alternarAcoplado(disposicion: Disposicion, acoplado: Acoplado): Disposicion {
  if (!disposicion.abiertos[acoplado]) return abrirAcoplado(disposicion, acoplado);

  const lado: Lado = ACOPLADOS_POR_LADO.izquierda.includes(acoplado) ? 'izquierda' : 'derecha';
  const abiertos = { ...disposicion.abiertos, [acoplado]: false };
  const quedaAlguno = ACOPLADOS_POR_LADO[lado].some((otro) => abiertos[otro]);

  return {
    ...disposicion,
    [lado]: { ...disposicion[lado], plegada: !quedaAlguno },
    abiertos,
  };
}

/** Plegar o desplegar la columna entera desde su riel o su canaleta. */
export function alternarColumna(disposicion: Disposicion, lado: Lado): Disposicion {
  const plegada = !disposicion[lado].plegada;
  if (plegada) return { ...disposicion, [lado]: { ...disposicion[lado], plegada } };

  // Al desplegar una columna cuyos dos paneles quedaron cerrados, se abre el
  // primero: desplegar para encontrarse una columna vacía es peor que no haber
  // desplegado.
  const abiertos = { ...disposicion.abiertos };
  if (!ACOPLADOS_POR_LADO[lado].some((acoplado) => abiertos[acoplado])) {
    abiertos[ACOPLADOS_POR_LADO[lado][0]!] = true;
  }
  return { ...disposicion, [lado]: { ...disposicion[lado], plegada }, abiertos };
}
