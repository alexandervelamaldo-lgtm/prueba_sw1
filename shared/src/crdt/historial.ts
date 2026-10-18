import * as Y from 'yjs';
import { ulid } from '../model/id.js';
import type { Operation } from '../ops/operations.js';
import { describeOperation } from '../ops/operations.js';

/**
 * Historial de cambios del diagrama.
 *
 * Responde a una pregunta que hasta ahora no tenía respuesta: quién creó esta
 * clase, y quién la tocó después. En un editor donde varias personas escriben a
 * la vez y además se puede editar sin conexión, un cambio que aparece sin más
 * es indistinguible de un error, y no había forma de saber a quién preguntar.
 *
 * ## Por qué vive dentro del documento CRDT
 *
 * La alternativa era un registro en el servidor. Se descartó por un motivo
 * técnico y no de comodidad: el servidor de colaboración recibe actualizaciones
 * binarias de Yjs, no operaciones de dominio. Para saber que «Ana creó la clase
 * Pedido» tendría que diferenciar dos estados del documento y deducirlo, que es
 * caro y además pierde la intención —un renombrado y un borrado seguido de un
 * alta se parecen mucho vistos desde el diff—. El único punto del sistema que
 * sabe qué quiso hacer el usuario es el cliente, en el momento de aplicar la
 * operación.
 *
 * Guardarlo en el documento tiene tres consecuencias buenas: funciona sin
 * conexión igual que el resto, se sincroniza por el mismo canal sin transporte
 * nuevo, y el servidor lo persiste junto al diagrama sin enterarse.
 *
 * ## Lo que esto NO es
 *
 * No es una auditoría a prueba de manipulación. Cualquier cliente con permiso de
 * escritura puede añadir una entrada con el nombre que quiera, igual que puede
 * escribir cualquier clase: en un CRDT el cliente es quien escribe. Es un
 * historial de colaboración entre gente que trabaja junta, y sirve para
 * reconstruir qué pasó, no para demostrar nada ante alguien que miente. Para lo
 * segundo haría falta que el servidor derivase el registro por su cuenta y
 * firmara cada entrada, y eso exige la identidad definitiva de Architech
 * (decisión D8, pregunta abierta Q2).
 */

/**
 * Tipo raíz, como los otros tres (ver `document.ts`).
 *
 * Es `Y.Array` y no `Y.Map` porque las entradas se añaden al final y nunca se
 * modifican. Dos réplicas que registran un cambio a la vez insertan cada una la
 * suya y ambas sobreviven; con un mapa indexado por clave habría que inventar
 * una clave única y no se ganaría nada.
 */
const HISTORIAL = 'diagrama.historial';

export function getHistorialArray(doc: Y.Doc): Y.Array<unknown> {
  return doc.getArray(HISTORIAL);
}

/**
 * De dónde salió el cambio.
 *
 * Se distingue del autor a propósito. En esta aplicación la foto de pizarra, la
 * voz y el XMI *proponen* y una persona *confirma*: si el historial guardara
 * solo «Ana añadió doce clases» estaría ocultando que las leyó un modelo de una
 * pizarra, que es justo lo que hay que saber cuando aparece un atributo que
 * nadie recuerda haber escrito.
 */
export type OrigenCambio = 'manual' | 'asistente' | 'foto' | 'xmi' | 'deshacer' | 'rehacer';

export const ETIQUETA_ORIGEN: Record<OrigenCambio, string> = {
  manual: 'a mano',
  asistente: 'con el asistente',
  foto: 'desde una foto',
  xmi: 'desde un XMI',
  deshacer: 'deshaciendo',
  rehacer: 'rehaciendo',
};

export interface Autor {
  id: string;
  nombre: string;
}

/**
 * Lo que acompaña a un lote de operaciones para poder atribuirlo.
 *
 * Viaja como segundo argumento de `aplicar` en toda la interfaz. Es opcional a
 * propósito: quien no lo pasa está diciendo «esto lo hizo una persona a mano»,
 * que es el caso mayoritario y el que no conviene tener que repetir.
 */
export interface ContextoCambio {
  origen?: OrigenCambio;
  /** El modelo o el fichero que propuso el cambio, si no fue una persona. */
  propuestoPor?: string;
}

/**
 * Firma de `aplicar`, compartida por todos los componentes que proponen cambios.
 * `clases` son las clases que tocó el lote (las creadas incluidas), para quien
 * quiera llevar la vista hasta ellas; es opcional para no obligar a los dobles
 * de las pruebas ni a otros implementadores a calcularlas.
 */
export type Aplicar = (
  operaciones: Operation[],
  contexto?: ContextoCambio,
) => { ok: true; clases?: string[] } | { ok: false; error: string };

export interface EntradaHistorial {
  id: string;
  /** Identificador del usuario. Vacío si el cambio se hizo sin sesión. */
  autorId: string;
  /**
   * El nombre tal y como era *en ese momento*.
   *
   * Se copia en vez de resolverse al leer, y no por ahorrar una consulta: el
   * historial tiene que poder leerse sin conexión y sin el directorio de
   * usuarios delante, y además quien cambia su nombre para mostrar no reescribe
   * lo que hizo el mes pasado.
   */
  autorNombre: string;
  /** ISO 8601, del reloj de quien hizo el cambio. Ver `marcarRelojesDudosos`. */
  momento: string;
  origen: OrigenCambio;
  /** Qué lo propuso, si no fue una persona: el modelo, o el fichero. */
  propuestoPor?: string;
  /** Una línea: «Creó la clase Pedido». */
  resumen: string;
  /** Una línea por operación, para desplegar. */
  detalles: string[];
  /** Identificadores de las clases tocadas; permite el historial de una clase. */
  clases: string[];
  relaciones: string[];
  /**
   * De las anteriores, las que este cambio creó.
   *
   * Va como dato y no se deduce del texto del resumen. Deducirlo —buscar si la
   * descripción empieza por «Crear»— ataría el historial al idioma y a la
   * redacción de `describeOperation`: cambiar una palabra en un mensaje de la
   * interfaz haría que «creada por Ana» dejase de aparecer, sin que fallara
   * ninguna comprobación de tipos.
   */
  creadas: string[];
}

/**
 * Tope de entradas conservadas.
 *
 * El documento entero viaja a cada cliente que se conecta, así que un historial
 * sin límite acaba siendo el grueso de lo que se descarga al abrir un proyecto
 * viejo. Cuatrocientas entradas son unos ochenta kilobytes y bastantes meses de
 * trabajo de un equipo pequeño.
 */
export const MAXIMO_ENTRADAS = 400;

/**
 * Longitud máxima de un texto guardado.
 *
 * Los nombres que aparecen aquí vienen de diagramas, de OCR y de ficheros XMI:
 * son entrada no confiable (RNF-SEG-06). No se saneaban quitando caracteres
 * —eso corrompe nombres legítimos— pero sí se recortan, porque un nombre de
 * cincuenta mil caracteres es una forma barata de inflar el documento de todos.
 */
const MAXIMO_TEXTO = 240;

function recortarTexto(texto: string): string {
  return texto.length <= MAXIMO_TEXTO ? texto : `${texto.slice(0, MAXIMO_TEXTO - 1)}…`;
}

/**
 * Operaciones que no merecen una entrada.
 *
 * Mover una caja es un cambio del documento pero no del modelo: no altera lo que
 * se genera ni lo que nadie tendría que revisar. Además llega en ráfagas de
 * decenas por segundo mientras se arrastra, así que registrarlas no solo sería
 * ruido: sepultaría el «Ana creó la clase Pedido» bajo doscientas líneas de
 * «Ana movió la clase Pedido» y dejaría el historial inservible justo por
 * intentar ser completo.
 */
const SIN_INTERES: ReadonlySet<Operation['op']> = new Set<Operation['op']>(['moveClass']);

export interface DatosCambio {
  autor: Autor | null;
  origen: OrigenCambio;
  propuestoPor?: string;
  operaciones: Operation[];
  /**
   * Resumen impuesto desde fuera.
   *
   * Existe por deshacer y rehacer, que son actos del usuario sin operaciones
   * detrás: lo que revierte `Ctrl+Z` es una transacción de Yjs, no una lista de
   * `Operation`. Sin esto habría que fabricar operaciones falsas para poder
   * registrarlos, y entonces el historial contendría cambios que nadie pidió.
   */
  resumen?: string;
  /** Identificadores devueltos por `applyOperations`, para el filtro por clase. */
  clases?: string[];
  relaciones?: string[];
  /** De las anteriores, las que nacieron en este lote. */
  creadas?: string[];
  /** Inyectable para las pruebas; por omisión, el reloj del sistema. */
  ahora?: Date;
}

/**
 * Construye la entrada que corresponde a un lote de operaciones, o `null` si ese
 * lote no merece quedar registrado.
 *
 * Separada de la escritura para poder probar la decisión —qué se registra y con
 * qué texto— sin montar un documento.
 */
export function componerEntrada(datos: DatosCambio): EntradaHistorial | null {
  const interesantes = datos.operaciones.filter((op) => !SIN_INTERES.has(op.op));
  if (interesantes.length === 0 && !datos.resumen) return null;

  const detalles = interesantes.map((op) => recortarTexto(describeOperation(op)));
  const primero = detalles[0] ?? 'Cambió el diagrama';

  // Con una sola operación el resumen ES el detalle, y repetirlo debajo al
  // desplegar sería ruido. Con varias, el resumen cuenta cuántas: una
  // importación es un solo acto del usuario aunque traiga doce clases.
  const resumen =
    datos.resumen ??
    (interesantes.length === 1
      ? primero
      : `${primero} y ${interesantes.length - 1} cambio${interesantes.length === 2 ? '' : 's'} más`);

  return {
    id: ulid(),
    autorId: datos.autor?.id ?? '',
    autorNombre: recortarTexto(datos.autor?.nombre ?? 'Alguien sin sesión'),
    momento: (datos.ahora ?? new Date()).toISOString(),
    origen: datos.origen,
    ...(datos.propuestoPor ? { propuestoPor: recortarTexto(datos.propuestoPor) } : {}),
    resumen: recortarTexto(resumen),
    detalles: interesantes.length === 1 && !datos.resumen ? [] : detalles,
    clases: [...new Set(datos.clases ?? [])],
    relaciones: [...new Set(datos.relaciones ?? [])],
    creadas: [...new Set(datos.creadas ?? [])],
  };
}

/**
 * Registra un cambio.
 *
 * Se escribe con origen `'historial'` y no con el del usuario: así el
 * `UndoManager` —que solo sigue los orígenes locales de edición— no mete la
 * entrada en su pila. Sin esa separación, `Ctrl+Z` borraría el registro de lo
 * que acaba de deshacer, que es la forma más rápida de tener un historial que
 * miente por omisión.
 *
 * Devuelve la entrada escrita, o `null` si no había nada que registrar.
 */
export function registrarCambio(doc: Y.Doc, datos: DatosCambio): EntradaHistorial | null {
  const entrada = componerEntrada(datos);
  if (!entrada) return null;

  const historial = getHistorialArray(doc);
  doc.transact(() => {
    historial.push([entrada]);
    podar(historial);
  }, 'historial');

  return entrada;
}

/**
 * Tira las entradas más antiguas cuando se pasa del tope.
 *
 * Dos réplicas que podan a la vez sin haberse visto borran cada una por índice y
 * pueden acabar tirando alguna entrada de más. Es aceptable y está acotado: solo
 * afecta a lo más viejo del historial, nunca a lo reciente, que es lo que
 * alguien va a mirar. La alternativa —coordinarse para podar— exige hablar con
 * el servidor, y sin conexión no hay con quién.
 */
function podar(historial: Y.Array<unknown>): void {
  const sobran = historial.length - MAXIMO_ENTRADAS;
  if (sobran > 0) historial.delete(0, sobran);
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

function esEntrada(valor: unknown): valor is EntradaHistorial {
  if (typeof valor !== 'object' || valor === null) return false;
  const e = valor as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    typeof e['autorNombre'] === 'string' &&
    typeof e['momento'] === 'string' &&
    typeof e['resumen'] === 'string'
  );
}

export interface EntradaLeida extends EntradaHistorial {
  /**
   * El reloj de quien escribió esta entrada no concuerda con el orden real.
   *
   * El orden del historial es el del CRDT —el orden en que las entradas
   * confluyeron—, no el de las fechas: las fechas las pone cada equipo con su
   * propio reloj, y un portátil con la hora mal puesta, o alguien que editó tres
   * días sin conexión, mete una fecha que contradice el orden. En vez de
   * reordenar por fecha (que sería creerse el reloj) o de callarlo (que sería
   * dar por buena una hora falsa), se marca y se dice.
   */
  relojDudoso: boolean;
}

/** El historial completo, del más antiguo al más reciente. */
export function leerHistorial(doc: Y.Doc): EntradaLeida[] {
  const crudo = getHistorialArray(doc).toArray().filter(esEntrada);

  let maximo = '';
  return crudo.map((entrada) => {
    const dudoso = entrada.momento < maximo;
    if (!dudoso) maximo = entrada.momento;
    return {
      ...entrada,
      // Se copian los arrays y se rellenan los que falten: una entrada escrita
      // por una versión anterior del cliente no los trae, y esta función tiene
      // que seguir devolviendo algo sobre lo que se pueda iterar sin comprobar.
      detalles: [...(entrada.detalles ?? [])],
      clases: [...(entrada.clases ?? [])],
      relaciones: [...(entrada.relaciones ?? [])],
      creadas: [...(entrada.creadas ?? [])],
      relojDudoso: dudoso,
    };
  });
}

/** Las entradas que tocaron una clase concreta, de la más reciente a la más antigua. */
export function historialDeClase(entradas: EntradaLeida[], classId: string): EntradaLeida[] {
  return entradas.filter((e) => e.clases.includes(classId)).reverse();
}

/**
 * Quién creó una clase y quién la tocó por última vez.
 *
 * Devuelve `null` en el hueco correspondiente cuando no consta, que es el caso
 * normal de todo lo anterior a esta función y de lo que llegó por una
 * importación masiva podada. Decir «creada por Ana» porque Ana es la primera que
 * aparece en un historial recortado sería inventar.
 */
export function autoriaDeClase(
  entradas: EntradaLeida[],
  classId: string,
): { creacion: EntradaLeida | null; ultima: EntradaLeida | null } {
  const propias = entradas.filter((e) => e.clases.includes(classId));
  return {
    creacion: propias.find((e) => e.creadas.includes(classId)) ?? null,
    ultima: propias[propias.length - 1] ?? null,
  };
}

/**
 * Cuántos cambios entró cada vía.
 *
 * El origen de cada entrada ya se enseña una por una en el panel de historial;
 * esto es la pregunta que ninguna lista responde: de todo lo que hay en el
 * modelo, qué proporción se dibujó a mano y qué proporción llegó dictada, leída
 * de una foto de pizarra o importada de un XMI.
 *
 * `deshacer` y `rehacer` cuentan aparte y no se reparten entre los demás. Son
 * actos sobre el historial, no formas de meter modelo: sumarlos a «a mano»
 * inflaría esa vía con trabajo que en realidad se estaba retirando.
 */
export interface ResumenOrigenes {
  /** Una entrada por vía, incluidas las que valen cero. */
  porOrigen: Record<OrigenCambio, number>;
  /** Total de entradas conservadas, incluidas deshacer y rehacer. */
  total: number;
  /**
   * Cuántas traen una fecha que contradice el orden del CRDT.
   *
   * Se cuenta y se devuelve en vez de descartarse en silencio: quien pinte esto
   * necesita poder decir «de 40 cambios, 3 traen la hora mal» en lugar de
   * enseñar 37 como si fueran todos.
   */
  fechasDudosas: number;
}

export function resumirOrigenes(entradas: EntradaLeida[]): ResumenOrigenes {
  // Se parte de todas las vías a cero en vez de acumular solo las que aparecen.
  // Un `Record` con huecos obliga a cada consumidor a comprobar si falta la
  // clave, y el primero que lo olvide pintará «undefined» en la interfaz.
  const porOrigen = Object.fromEntries(
    (Object.keys(ETIQUETA_ORIGEN) as OrigenCambio[]).map((clave) => [clave, 0]),
  ) as Record<OrigenCambio, number>;

  let fechasDudosas = 0;
  for (const entrada of entradas) {
    // Una entrada escrita por una versión anterior puede traer un origen que
    // esta ya no conoce. Se ignora en el reparto pero cuenta en el total: es un
    // cambio que existió, y esconderlo descuadraría la suma.
    if (entrada.origen in porOrigen) porOrigen[entrada.origen] += 1;
    if (entrada.relojDudoso) fechasDudosas += 1;
  }

  return { porOrigen, total: entradas.length, fechasDudosas };
}

/**
 * Las vías por las que entró modelo, sin las de gestión del historial.
 *
 * Es lo que se reparte en la barra de procedencia. Deshacer y rehacer quedan
 * fuera por lo dicho arriba, y las vías con cero también: una leyenda que
 * enumera cuatro formas de importar que nadie usó ocupa sitio para decir nada.
 */
export function viasDeEntrada(
  resumen: ResumenOrigenes,
): { origen: OrigenCambio; etiqueta: string; cambios: number }[] {
  const DE_GESTION: OrigenCambio[] = ['deshacer', 'rehacer'];
  return (Object.keys(resumen.porOrigen) as OrigenCambio[])
    .filter((origen) => !DE_GESTION.includes(origen) && resumen.porOrigen[origen] > 0)
    .map((origen) => ({
      origen,
      etiqueta: ETIQUETA_ORIGEN[origen],
      cambios: resumen.porOrigen[origen],
    }))
    .sort((a, b) => b.cambios - a.cambios);
}
