import type { UmlClass, UmlRelation } from '@app/shared';

/**
 * La geometría del lienzo, separada del componente que la pinta.
 *
 * Vive en su propio fichero para que se pueda probar. Un error aquí no rompe
 * nada que TypeScript sepa detectar: la aplicación compila, arranca y dibuja
 * —solo que la flecha nace donde no debe, o dos relaciones se superponen, o una
 * cardinalidad cae encima de su propia línea—. Son fallos que solo se ven
 * mirando la pantalla, y por eso conviene poder afirmarlos en una prueba en vez
 * de confiar en que alguien se fije.
 *
 * No importa React a propósito: así las pruebas corren en Node, sin DOM.
 */

export const ANCHO_MINIMO = 200;

/**
 * Tope de anchura.
 *
 * Sin él, un método con cinco parámetros haría una caja de 700 px que tapa el
 * resto del diagrama. Con él, ese método se recorta con puntos suspensivos y se
 * lee entero en el panel lateral, que es donde se edita de todas formas.
 */
export const ANCHO_MAXIMO = 340;
export const ALTO_CABECERA = 34;
export const ALTO_FILA = 20;
export const PADDING = 10;

/**
 * Anchura aproximada de un carácter, en píxeles, para cada uso.
 *
 * Medir de verdad exige pintar el texto y leer el DOM, que en un lienzo que se
 * redibuja al arrastrar sale caro. Los miembros van en monoespaciada, donde la
 * estimación es exacta; el nombre va en proporcional y se estima por lo alto,
 * que falla del lado bueno: sobra caja, no falta.
 */
const ANCHO_CARACTER_MIEMBRO = 6.65;
const ANCHO_CARACTER_NOMBRE = 8;

export interface Punto {
  x: number;
  y: number;
}

export interface Medida {
  ancho: number;
  alto: number;
}

const SIMBOLO_VISIBILIDAD: Record<string, string> = { '+': '+', '-': '−', '#': '#', '~': '~' };

/**
 * La marca del atributo identificador.
 *
 * Fue un emoji de llave, y tenía tres problemas a la vez. El de aspecto es el
 * mismo que hizo retirar los demás pictogramas de la interfaz: la llave no está
 * en Fira Code, así que el navegador cae a la fuente de emoji del sistema y el
 * glifo sale distinto en cada teléfono —y en algunos, en color— dentro de una
 * caja que por lo demás es un dibujo plano.
 *
 * El de medida es propio de este fichero: la anchura de la caja se estima
 * multiplicando caracteres por `ANCHO_CARACTER_MIEMBRO`, y esa cuenta es exacta
 * *porque* el texto va en monoespaciada. Un glifo que viene de otra fuente ocupa
 * lo que diga esa fuente, así que la fila del identificador era justo la que se
 * medía mal, y se medía mal por debajo: el texto sobresalía de la caja.
 *
 * Y el de lectura: un lector de pantalla en castellano anuncia este emoji por su
 * nombre en inglés.
 *
 * `{id}` no es un apaño para esquivar esas tres cosas: es la notación de UML para
 * una propiedad de identidad, cabe en la monoespaciada y se lee en voz alta como
 * lo que es.
 */
const MARCA_IDENTIFICADOR = ' {id}';

/** El texto de una fila, en el mismo sitio donde se mide y donde se pinta. */
export function textoAtributo(atributo: UmlClass['attributes'][number]): string {
  return `${SIMBOLO_VISIBILIDAD[atributo.visibility] ?? atributo.visibility} ${atributo.name}: ${
    atributo.type.name
  }${atributo.isIdentifier ? MARCA_IDENTIFICADOR : ''}`;
}

export function textoMetodo(metodo: UmlClass['methods'][number]): string {
  const parametros = metodo.parameters.map((p) => p.name).join(', ');
  return `${SIMBOLO_VISIBILIDAD[metodo.visibility] ?? metodo.visibility} ${
    metodo.name
  }(${parametros})${metodo.returnType ? `: ${metodo.returnType.name}` : ''}`;
}

export function etiquetaClase(cls: UmlClass): string | null {
  if (cls.kind === 'interface') return '«interface»';
  if (cls.kind === 'enum') return '«enumeration»';
  if (cls.kind === 'abstract') return '«abstract»';
  return null;
}

/**
 * Cuánto ocupa una clase en el lienzo.
 *
 * La anchura era fija en 200 px y el texto que no cabía simplemente se salía de
 * la caja por la derecha, encima de lo que hubiera detrás. Ahora la caja crece
 * con su contenido hasta un tope, y lo que pasa del tope se recorta con puntos
 * suspensivos: sobresalir es peor que recortar, porque el texto de fuera se
 * mezcla con el de otra clase y no se sabe de quién es cada línea.
 */
export function medidasDe(cls: UmlClass): Medida {
  const filas = cls.attributes.length + cls.methods.length;
  const separador = cls.attributes.length > 0 && cls.methods.length > 0 ? 6 : 0;
  const alto = ALTO_CABECERA + Math.max(filas, 1) * ALTO_FILA + separador + PADDING;

  const miembros = [...cls.attributes.map(textoAtributo), ...cls.methods.map(textoMetodo)];
  const anchoMiembros = miembros.reduce(
    (mayor, texto) => Math.max(mayor, texto.length * ANCHO_CARACTER_MIEMBRO + PADDING * 2),
    0,
  );
  // El nombre va centrado, así que necesita holgura a los dos lados; si no, roza
  // los bordes redondeados de la caja.
  const anchoNombre = cls.name.length * ANCHO_CARACTER_NOMBRE + 24;
  const ancho = Math.min(
    ANCHO_MAXIMO,
    Math.max(ANCHO_MINIMO, Math.ceil(Math.max(anchoMiembros, anchoNombre))),
  );
  return { ancho, alto };
}

/** Recorta un texto a lo que quepa en la caja, con puntos suspensivos. */
export function recortar(texto: string, ancho: number): string {
  const caben = Math.floor((ancho - PADDING * 2) / ANCHO_CARACTER_MIEMBRO);
  return texto.length <= caben ? texto : `${texto.slice(0, Math.max(caben - 1, 1))}…`;
}

// ---------------------------------------------------------------------------
// La vista: qué trozo del diagrama se está mirando
// ---------------------------------------------------------------------------

export interface Vista {
  /** Esquina superior izquierda del diagrama que se ve, en coordenadas del modelo. */
  x: number;
  y: number;
  escala: number;
}

/**
 * Los topes del zoom.
 *
 * Por debajo de un cuarto las cajas son manchas sin texto y por encima del triple
 * se ve una clase y media: fuera de esa horquilla el lienzo deja de servir para
 * lo que se está usando.
 */
export const ESCALA_MINIMA = 0.25;
export const ESCALA_MAXIMA = 3;

/** Margen alrededor de lo encuadrado, en píxeles de pantalla. */
const MARGEN_ENCUADRE = 48;

export function limitarEscala(escala: number): number {
  return Math.min(ESCALA_MAXIMA, Math.max(ESCALA_MINIMA, escala));
}

/**
 * Amplía o reduce dejando quieto el centro de la ventana.
 *
 * Es lo que hacen los botones de la barra de estado. La rueda y el pellizco
 * anclan en el puntero —ahí el usuario señala dónde quiere mirar—, pero un botón
 * no señala nada, y anclarlo en la esquina haría que el diagrama se escapara
 * hacia abajo a la derecha en cada pulsación.
 */
export function ampliar(vista: Vista, ventana: Medida, factor: number): Vista {
  const escala = limitarEscala(vista.escala * factor);
  const centro = {
    x: vista.x + ventana.ancho / vista.escala / 2,
    y: vista.y + ventana.alto / vista.escala / 2,
  };
  return {
    escala,
    x: centro.x - ventana.ancho / escala / 2,
    y: centro.y - ventana.alto / escala / 2,
  };
}

export interface Caja extends Medida {
  x: number;
  y: number;
}

export function cajaDe(cls: UmlClass): Caja {
  const { ancho, alto } = medidasDe(cls);
  return { x: cls.position.x, y: cls.position.y, ancho, alto };
}

/**
 * Deja a la vista las cajas indicadas.
 *
 * Con `ajustar` la escala se recalcula para que quepan; sin él se conserva la
 * que hubiera, salvo que no quepan, en cuyo caso se reduce lo justo. La
 * diferencia importa: «Ajustar» de la barra de estado quiere ver el diagrama
 * entero, y pulsar Enter sobre una clase del árbol quiere ir hasta ella sin
 * cambiar el aumento con el que se estaba trabajando.
 *
 * Sin cajas devuelve el origen a escala 1: un diagrama vacío no tiene centro, y
 * cualquier otra cosa —dividir entre cero, dejar la vista donde estaba— acaba en
 * un lienzo en blanco del que no se sabe volver.
 */
export function encuadrar(cajas: Caja[], ventana: Medida, opciones: { ajustar: boolean; escala: number }): Vista {
  if (cajas.length === 0) return { x: 0, y: 0, escala: 1 };

  const izquierda = Math.min(...cajas.map((c) => c.x));
  const arriba = Math.min(...cajas.map((c) => c.y));
  const derecha = Math.max(...cajas.map((c) => c.x + c.ancho));
  const abajo = Math.max(...cajas.map((c) => c.y + c.alto));

  const cabe = Math.min(
    (ventana.ancho - MARGEN_ENCUADRE * 2) / Math.max(derecha - izquierda, 1),
    (ventana.alto - MARGEN_ENCUADRE * 2) / Math.max(abajo - arriba, 1),
  );
  const escala = limitarEscala(opciones.ajustar ? cabe : Math.min(opciones.escala, cabe));

  return {
    escala,
    x: (izquierda + derecha) / 2 - ventana.ancho / escala / 2,
    y: (arriba + abajo) / 2 - ventana.alto / escala / 2,
  };
}

/** Punto de la caja más cercano a un objetivo, para que las líneas no la crucen. */
export function anclaje(cls: UmlClass, medida: Medida, hacia: Punto): Punto {
  const cx = cls.position.x + medida.ancho / 2;
  const cy = cls.position.y + medida.alto / 2;
  const dx = hacia.x - cx;
  const dy = hacia.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  // Se escala el vector hasta que toca el borde del rectángulo. Es la
  // intersección de una recta con una caja, resuelta por el lado que se alcanza
  // antes: sin esto las flechas nacen en el centro y quedan tapadas por la caja.
  const escalaX = dx === 0 ? Infinity : medida.ancho / 2 / Math.abs(dx);
  const escalaY = dy === 0 ? Infinity : medida.alto / 2 / Math.abs(dy);
  const escala = Math.min(escalaX, escalaY);
  return { x: cx + dx * escala, y: cy + dy * escala };
}

/** Punto de una curva cuadrática en `t`, para colgar de ahí las etiquetas. */
export function puntoEnCurva(p0: Punto, c: Punto, p1: Punto, t: number): Punto {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/** Cuánto se abre el abanico entre relaciones que unen el mismo par. */
export const SEPARACION_ABANICO = 34;

/**
 * Cuánto se separa cada relación de la recta que une los dos centros.
 *
 * Dos clases pueden estar unidas por varias relaciones a la vez —una asociación
 * y una dependencia, o dos asociaciones con papeles distintos— y hasta ahora
 * todas se dibujaban exactamente sobre la misma recta: se veía una sola línea, y
 * sus cardinalidades se pisaban unas a otras hasta ser ilegibles. Separándolas
 * en abanico alrededor de la recta, cada una tiene su trazo y su hueco.
 *
 * La clave del par se ordena para que A→B y B→A cuenten como el mismo par: si
 * no, dos relaciones inversas volverían a superponerse.
 */
export function desviosPorPar(relaciones: UmlRelation[]): Map<string, number> {
  const porPar = new Map<string, string[]>();
  for (const relacion of relaciones) {
    const par = [relacion.source.classId, relacion.target.classId].sort().join('|');
    const lista = porPar.get(par);
    if (lista) lista.push(relacion.id);
    else porPar.set(par, [relacion.id]);
  }

  const desvios = new Map<string, number>();
  for (const lista of porPar.values()) {
    lista.forEach((id, indice) => {
      // Centrado en cero: con una sola relación sale 0 y la línea queda recta,
      // que es como debe verse el caso normal.
      desvios.set(id, indice - (lista.length - 1) / 2);
    });
  }
  return desvios;
}

/**
 * El punto medio de una relación, tal y como se ve dibujada en el lienzo.
 *
 * Existe por la clase de asociación de UML: esa clase no cuelga de ninguno de
 * los dos extremos de la relación N:M que documenta, sino de su **mitad**, así
 * que la línea punteada que la une a la relación tiene que apuntar exactamente
 * ahí y no al centro geométrico entre las dos cajas —que con el abanico de
 * `desviosPorPar` no coincide con la curva real en cuanto hay más de una
 * relación entre el mismo par—.
 *
 * Es la misma cuenta que ya hacía `AristaRelacionUml` para colgar de ahí el
 * nombre de la relación (`centro`, en su cierre), sacada a una función aparte
 * para poder darle el mismo punto a la arista de la clase de asociación sin
 * duplicar la cuadrática de Bézier ni el caso reflexivo.
 */
export function puntoMedioRelacion(
  origen: UmlClass,
  destino: UmlClass,
  medidaOrigen: Medida,
  medidaDestino: Medida,
  desvio: number,
): Punto {
  // Reflexiva: no hay curva entre dos cajas, solo el lazo por el lado derecho
  // que dibuja `AristaRelacionUml`; el punto que ahí hace de centro es este.
  if (origen.id === destino.id) {
    const x = origen.position.x + medidaOrigen.ancho;
    const y = origen.position.y + medidaOrigen.alto / 2;
    const fondo = 70 + Math.abs(desvio) * 26;
    return { x: x + fondo * 0.78, y };
  }

  const centroOrigen = {
    x: origen.position.x + medidaOrigen.ancho / 2,
    y: origen.position.y + medidaOrigen.alto / 2,
  };
  const centroDestino = {
    x: destino.position.x + medidaDestino.ancho / 2,
    y: destino.position.y + medidaDestino.alto / 2,
  };

  const dx = centroDestino.x - centroOrigen.x;
  const dy = centroDestino.y - centroOrigen.y;
  const largo = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / largo, y: dx / largo };

  const control = {
    x: (centroOrigen.x + centroDestino.x) / 2 + normal.x * desvio * SEPARACION_ABANICO,
    y: (centroOrigen.y + centroDestino.y) / 2 + normal.y * desvio * SEPARACION_ABANICO,
  };

  const desde = anclaje(origen, medidaOrigen, control);
  const hasta = anclaje(destino, medidaDestino, control);
  return puntoEnCurva(desde, control, hasta, 0.5);
}
