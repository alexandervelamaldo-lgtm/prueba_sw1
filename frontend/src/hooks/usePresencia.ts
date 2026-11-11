import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollabProvider } from '@app/shared';

/**
 * Quién más está mirando este diagrama y dónde tiene el ratón (RF-COL-04).
 *
 * La presencia va por un canal distinto del documento y esa separación es
 * intencionada: un cursor moviéndose genera decenas de mensajes por segundo y
 * ninguno de ellos merece guardarse en disco, formar parte del historial ni
 * poder deshacerse. Yjs lo llama «awareness»; es estado efímero, atado a la
 * conexión, y desaparece solo cuando alguien cierra la pestaña.
 */

export interface Participante {
  clientId: number;
  nombre: string;
  color: string;
  cursor: { x: number; y: number } | null;
  /** Clase que tiene seleccionada, para resaltarla con su color. */
  seleccion: string | null;
  /** Si está en el Modo IA inmersivo; a esto se le sigue (ver `EditorDiagrama`). */
  modoIA: boolean;
}

/**
 * Colores de participante.
 *
 * Se eligen de una lista fija en vez de generarse al azar para que sean
 * distinguibles entre sí y legibles sobre el lienzo; un color aleatorio acaba
 * dando dos azules casi iguales o algo ilegible.
 *
 * Los ocho son ocho tonos repartidos cada 45° con la misma saturación (44%) y
 * la misma luminosidad (62%). Compartir S y L es lo que hace que se lean como
 * un sistema y no como ocho rotuladores; que solo los separe el tono es lo que
 * los mantiene distinguibles. Los anteriores —`#5b9cff`, `#ffd24a`,
 * `#ff5b7f`…— eran la paleta saturada que se retiró del resto de la interfaz, y
 * se habían quedado aquí porque viven en un `.ts` y ningún barrido del CSS los
 * veía. Son, además, los colores más llamativos de la pantalla: se pintan como
 * ficha de presencia y como contorno de selección sobre el diagrama.
 *
 * Las tres propiedades que hay que conservar al tocarlos están comprobadas en
 * `estilos.test.ts`: rango de saturación ≤ 110, texto oscuro legible encima
 * (≥ 4.5:1) y separación suficiente entre dos cualesquiera.
 */
const COLORES = [
  '#739ec9',
  '#c99e73',
  '#73c973',
  '#c973c9',
  '#73c9b3',
  '#c9c973',
  '#8973c9',
  '#c97389',
];

/**
 * Huella estable de un texto: FNV-1a de 32 bits.
 *
 * Se escribe aquí en seis líneas en vez de traer una dependencia porque lo que
 * se le pide es poco: repartir identidades entre ocho casillas sin agruparlas.
 * No es una función criptográfica y no debe usarse como tal.
 */
function huella(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Reparte colores entre los participantes de una sala.
 *
 * Antes esto era `COLORES[clientId % 8]`, y tenía dos averías que se veían
 * justo cuando el sistema importa —con gente delante, colaborando—.
 *
 * El `clientID` de Yjs es un número aleatorio nuevo por sesión. O sea que el
 * color **no era de la persona, era de la pestaña**: al recargar cambiabas de
 * color, y nadie llegaba nunca a aprender que el verde era Juan. Y como
 * repartía ocho casillas al azar, dos personas coincidían de color con
 * probabilidad nada teórica: con cuatro participantes, una de cada tres salas.
 * Un diagrama con dos cursores del mismo color es peor que no tener colores,
 * porque parece que informa y no informa.
 *
 * Ahora el color sale de la **identidad** —el id de usuario, que sobrevive a
 * recargas y reconexiones— y las colisiones se resuelven: quien encuentra su
 * casilla ocupada avanza a la siguiente libre.
 *
 * Lo que hace que esto funcione sin mensajes de coordinación es que la función
 * es **pura y determinista**: todos los navegadores de la sala la ejecutan
 * sobre el mismo conjunto de participantes y llegan al mismo reparto por su
 * cuenta. Por eso se ordenan las identidades antes de repartir —para que el
 * orden en que llegaron los estados no cambie el resultado— y por eso el color
 * ya no se publica por la red: se deduce. Un dato que se puede derivar y se
 * transmite es un dato que puede llegar en desacuerdo.
 *
 * Dos consecuencias asumidas, que conviene conocer antes de que sorprendan:
 *
 * - La misma persona en dos pestañas sale del mismo color, porque es la misma
 *   persona. Al enseñarlo con una sola cuenta abierta dos veces parece que no
 *   funciona; hacen falta dos cuentas.
 * - Si entra alguien que colisiona, puede desplazar el color de otro que ya
 *   estaba. Solo ocurre al colisionar, todos lo ven igual y a la vez, y la
 *   alternativa —repartir por orden de llegada— exige un acuerdo entre pares
 *   que cuesta bastante más de lo que arregla.
 *
 * Con más de ocho participantes se repite color. Se repite de forma
 * predecible, no al azar, y la paleta está pensada para grupos de clase.
 */
export function repartirColores(identidades: readonly string[]): Map<string, string> {
  const unicas = [...new Set(identidades)].sort();
  const reparto = new Map<string, string>();
  const tomados = new Set<number>();

  for (const identidad of unicas) {
    const preferido = huella(identidad) % COLORES.length;
    let indice = preferido;

    if (tomados.has(indice)) {
      for (let salto = 1; salto < COLORES.length; salto++) {
        const candidato = (preferido + salto) % COLORES.length;
        if (!tomados.has(candidato)) {
          indice = candidato;
          break;
        }
      }
    }

    tomados.add(indice);
    reparto.set(identidad, COLORES[indice] ?? COLORES[0]!);
  }

  return reparto;
}

/**
 * Cuánto aguanta en pantalla un cursor que ha dejado de moverse.
 *
 * `onPointerLeave` retira el cursor de quien saca el ratón del lienzo, pero no
 * cubre el caso corriente: dejarlo quieto encima y ponerse a otra cosa. Esa
 * flecha se queda clavada sobre el diagrama diciendo «aquí está fulano», que es
 * información falsa —fulano se ha ido a por un café— y encima tapa una clase.
 *
 * Quince segundos son bastante más que cualquier pausa al pensar y bastante
 * menos que una ausencia. Al volver a moverse reaparece de inmediato: no hay
 * nada que restablecer, porque la persona nunca dejó de estar en la sala. Lo
 * que caduca es el cursor, no la presencia; en la barra de estado sigue
 * contando, y su selección resaltada sigue marcada.
 */
const INACTIVIDAD_MS = 15_000;

/**
 * Largo máximo del nombre que se pinta junto al cursor.
 *
 * El nombre llega por la red desde otro participante, así que es entrada no
 * confiable (RNF-SEG-06). Inyectar marcado no puede: React lo pinta como texto
 * y lo escapa. Lo que sí puede es medir dos mil caracteres y arrastrar una
 * cinta por encima del diagrama, tapándolo entero. Se corta aquí, en el borde
 * por donde entra el dato, y además se acota por CSS con puntos suspensivos.
 */
const NOMBRE_MAXIMO = 40;

interface EstadoLocal {
  usuario?: { id: string; nombre: string };
  cursor?: { x: number; y: number } | null;
  seleccion?: string | null;
  /** Si está en el Modo IA inmersivo (ver `EditorDiagrama`). */
  modoIA?: boolean;
}

/** Dónde y cuándo se vio por última vez moverse a un cursor. */
export interface Rastro {
  x: number;
  y: number;
  en: number;
}

/**
 * Apaga los cursores que llevan un rato sin moverse.
 *
 * Se separa del hook y se escribe sin depender del reloj —`ahora` entra como
 * argumento— porque si no, comprobar que un cursor caduca a los quince
 * segundos costaría quince segundos por prueba.
 *
 * Devuelve también el mapa de rastros nuevo en vez de modificar el que recibe:
 * quien ya no está en la sala no aparece en el mapa devuelto, así que la
 * memoria de una sesión larga no crece con la gente que pasó por ella.
 */
export function podarCursoresParados(
  participantes: readonly Participante[],
  anteriores: ReadonlyMap<number, Rastro>,
  ahora: number,
  ventanaMs: number,
): { visibles: Participante[]; vistos: Map<number, Rastro> } {
  const vistos = new Map<number, Rastro>();
  const visibles: Participante[] = [];

  for (const participante of participantes) {
    if (participante.cursor === null) {
      visibles.push(participante);
      continue;
    }

    const antes = anteriores.get(participante.clientId);
    const seMovio =
      !antes || antes.x !== participante.cursor.x || antes.y !== participante.cursor.y;
    const rastro: Rastro = seMovio
      ? { x: participante.cursor.x, y: participante.cursor.y, en: ahora }
      : antes;

    vistos.set(participante.clientId, rastro);
    // Se apaga el cursor y se conserva todo lo demás: sigue en la sala, sigue
    // contando en la barra de estado y su clase sigue resaltada con su color.
    visibles.push(ahora - rastro.en > ventanaMs ? { ...participante, cursor: null } : participante);
  }

  return { visibles, vistos };
}

/**
 * Si nada ha cambiado, se devuelve la lista anterior tal cual.
 *
 * El reloj que caduca cursores late una vez por segundo, y sin esta
 * comparación cada latido produciría una lista nueva, un `setState` y un
 * repintado del lienzo entero aunque no se hubiera movido nadie. Un redibujado
 * por segundo, para siempre, es justo la clase de coste que luego aparece como
 * tirones en el momento de enseñarlo.
 */
function mismos(a: readonly Participante[], b: readonly Participante[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((uno, i) => {
    const otro = b[i];
    return (
      otro !== undefined &&
      uno.clientId === otro.clientId &&
      uno.nombre === otro.nombre &&
      uno.color === otro.color &&
      uno.seleccion === otro.seleccion &&
      uno.modoIA === otro.modoIA &&
      uno.cursor?.x === otro.cursor?.x &&
      uno.cursor?.y === otro.cursor?.y
    );
  });
}

/**
 * Con qué nombre entra alguien en el reparto.
 *
 * Se prefiere el id de usuario porque es lo único estable entre recargas. El
 * `cliente:N` de reserva no es decorativo: cubre a un participante cuyo estado
 * aún no trae identidad, y le da una casilla propia en vez de dejar que todos
 * los indocumentados compartan color.
 */
function identidadDe(clientId: number, estado: EstadoLocal): string {
  return estado.usuario?.id ?? `cliente:${clientId}`;
}

export function usePresencia(
  provider: CollabProvider | null,
  yo: { id: string; nombre: string } | null,
): { participantes: Participante[]; anunciar: (parcial: EstadoLocal) => void } {
  const [participantes, setParticipantes] = useState<Participante[]>([]);

  // Cuándo se vio moverse por última vez a cada cursor. Va en una referencia y
  // no en estado porque cambiar esto no debe repintar nada por sí solo.
  const vistos = useRef<Map<number, Rastro>>(new Map());

  // Anunciarse: identidad y nombre. El color ya no viaja, se deduce.
  useEffect(() => {
    if (!provider || !yo) return;
    provider.awareness.setLocalStateField('usuario', { id: yo.id, nombre: yo.nombre });
  }, [provider, yo]);

  // Escuchar a los demás.
  useEffect(() => {
    if (!provider) {
      setParticipantes([]);
      return;
    }

    const { awareness } = provider;
    const propio = provider.doc.clientID;

    const recalcular = (): void => {
      const estados = [...awareness.getStates()].map(
        ([clientId, estado]) => [clientId, estado as EstadoLocal] as const,
      );

      /*
        El reparto se hace sobre la sala entera, incluido uno mismo.

        Excluirse antes de repartir sería el error obvio: el color propio
        quedaría sin reservar y el primer participante que colisionara con él
        se lo llevaría, así que cada uno vería una sala distinta. Uno se quita
        después, al construir la lista, que es cuando de verdad estorba.
      */
      const reparto = repartirColores(
        estados.filter(([, e]) => e.usuario).map(([clientId, e]) => identidadDe(clientId, e)),
      );

      const otros: Participante[] = [];
      for (const [clientId, e] of estados) {
        // El estado propio se excluye: uno no necesita ver su propio cursor
        // duplicado sobre el suyo real, con un retraso de ida y vuelta.
        if (clientId === propio) continue;
        if (!e.usuario) continue;
        otros.push({
          clientId,
          nombre: e.usuario.nombre.slice(0, NOMBRE_MAXIMO),
          color: reparto.get(identidadDe(clientId, e)) ?? COLORES[0]!,
          cursor: e.cursor ?? null,
          seleccion: e.seleccion ?? null,
          modoIA: e.modoIA ?? false,
        });
      }
      otros.sort((a, b) => a.clientId - b.clientId);

      const { visibles, vistos: nuevos } = podarCursoresParados(
        otros,
        vistos.current,
        Date.now(),
        INACTIVIDAD_MS,
      );
      vistos.current = nuevos;
      setParticipantes((previos) => (mismos(previos, visibles) ? previos : visibles));
    };

    awareness.on('change', recalcular);
    recalcular();

    /*
      Un latido para caducar cursores.

      Sin él, el cursor de quien deja el ratón quieto no se apaga nunca: no se
      apaga porque no llega ningún mensaje, y no llega ningún mensaje
      precisamente porque está quieto. La caducidad no la puede disparar el
      evento cuya ausencia es la condición.
    */
    const reloj = setInterval(recalcular, 1000);

    return () => {
      awareness.off('change', recalcular);
      clearInterval(reloj);
    };
  }, [provider]);

  const anunciar = useMemo(() => {
    if (!provider) return (): void => {};
    return (parcial: EstadoLocal): void => {
      for (const [clave, valor] of Object.entries(parcial)) {
        provider.awareness.setLocalStateField(clave, valor);
      }
    };
  }, [provider]);

  return { participantes, anunciar };
}
