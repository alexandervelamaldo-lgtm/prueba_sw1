import { describeBatchImpact, isDestructiveOperation, type ClassDiagram, type EventoAsistente, type Operation } from '@app/shared';
import type { PropuestaOperacion } from './asistente-voz';

/**
 * Qué hace el Modo IA con cada evento de una respuesta en streaming
 * (`EventoAsistente`): el texto que pinta mientras la IA escribe, lo que dice
 * en voz alta, lo que aplica sola y lo que deja esperando su «Aplicar».
 *
 * Separado de `ModoIA.tsx` para probarlo sin red, sin DOM y sin voz: el
 * ejecutor (`crearEjecutorEnCola`) y la cola de voz (`crearColaDeVoz`) llegan
 * como dependencias.
 *
 * Lo que borra algo nunca se aplica solo. En cuanto llega una operación así se
 * retiene, y con ella todo lo que llegue después: lo posterior puede depender
 * de ese borrado (o chocar con él), y aplicarlo antes de que la persona
 * confirme el borrado sería aplicar a medias lo que la IA pensó como un todo.
 *
 * La narración sigue el orden en que la IA la escribió: el modelo escribe más
 * rápido de lo que el cursor anima, así que un mensaje que llega después de
 * una operación espera a que esa operación esté aplicada para pintarse y
 * decirse. Si no, «Listo.» sonaría antes de que pasara nada en el lienzo.
 */

const SIN_RESPUESTA = 'Orden no reconocida. Cabe reformularla con otras palabras.';

export interface EstadoRespuesta {
  /** Los mensajes completos y, al final, el que se está escribiendo. */
  texto: string;
  /** Operaciones retenidas: se ofrecen con «Aplicar». */
  propuesta: PropuestaOperacion[];
  /** Descripciones de lo que la IA ya aplicó sola, en orden. */
  aplicadas: string[];
  motor: string | null;
  terminado: boolean;
  error: string | null;
}

interface Ejecutor {
  encolar(operacion: Operation): void;
  terminar(): Promise<{ aplicadas: number; error: string | null }>;
}

export function crearManejadorDeStream(opciones: {
  /** El diagrama de ahora, para calcular si una operación borra algo. */
  diagrama: () => ClassDiagram;
  autoAplicar: boolean;
  soloLectura: boolean;
  crearEjecutor(avisos: { alAplicar(operacion: Operation): void }): Ejecutor;
  /** `null` si la orden fue escrita: entonces no se habla. */
  voz: { decir(texto: string): void; terminar(): void } | null;
  alCambiar(estado: EstadoRespuesta): void;
}): { alEvento(evento: EventoAsistente): void; terminar(): Promise<{ aplicadas: number; error: string | null }> } {
  const completos: string[] = [];
  let parcial = '';
  const propuesta: PropuestaOperacion[] = [];
  const aplicadas: string[] = [];
  const descripciones = new Map<Operation, string>();
  let motor: string | null = null;
  let terminado = false;
  let error: string | null = null;
  let retener = !opciones.autoAplicar || opciones.soloLectura;
  let huboOperaciones = false;
  // Cuántas operaciones se mandaron al ejecutor y cuántas ya terminó, y los
  // eventos que esperan a que se aplique la operación que los precede.
  let encoladas = 0;
  let enEspera: { umbral: number; evento: EventoAsistente }[] = [];

  const soltar = (todo: boolean): void => {
    while (enEspera.length > 0 && (todo || enEspera[0]!.umbral <= aplicadas.length)) {
      procesar(enEspera.shift()!.evento);
    }
  };

  const ejecutor = opciones.crearEjecutor({
    alAplicar: (operacion) => {
      aplicadas.push(descripciones.get(operacion) ?? operacion.op);
      avisar();
      soltar(false);
    },
  });

  function avisar(): void {
    let texto = [...completos, parcial].filter(Boolean).join(' ');
    if (terminado && !texto && !huboOperaciones && !error) texto = SIN_RESPUESTA;
    opciones.alCambiar({
      texto,
      propuesta: [...propuesta],
      aplicadas: [...aplicadas],
      motor,
      terminado,
      error,
    });
  }

  const borraAlgo = (operacion: Operation): boolean =>
    isDestructiveOperation(operacion) || describeBatchImpact(opciones.diagrama(), [operacion]).destructiva;

  function procesar(evento: EventoAsistente): void {
    if (terminado) return;
    switch (evento.tipo) {
      case 'mensaje-parcial':
        parcial = evento.texto;
        break;
      case 'mensaje':
        completos.push(evento.texto.trim());
        parcial = '';
        opciones.voz?.decir(evento.texto);
        break;
      case 'operacion':
        huboOperaciones = true;
        descripciones.set(evento.operacion, evento.descripcion);
        if (!retener && borraAlgo(evento.operacion)) retener = true;
        if (retener) {
          propuesta.push({ operacion: evento.operacion, descripcion: evento.descripcion });
        } else {
          encoladas += 1;
          ejecutor.encolar(evento.operacion);
        }
        break;
      case 'fin':
        motor = evento.motor;
        terminado = true;
        parcial = '';
        opciones.voz?.terminar();
        break;
      case 'error':
        error = evento.mensaje;
        terminado = true;
        parcial = '';
        opciones.voz?.terminar();
        break;
    }
    avisar();
  }

  return {
    alEvento(evento) {
      // Las operaciones van al ejecutor (o a la propuesta) en cuanto llegan;
      // lo demás espera si hay una operación anterior todavía sin aplicar.
      if (evento.tipo !== 'operacion' && (enEspera.length > 0 || aplicadas.length < encoladas)) {
        enEspera.push({ umbral: encoladas, evento });
        return;
      }
      procesar(evento);
    },
    async terminar() {
      try {
        return await ejecutor.terminar();
      } finally {
        // Si el ejecutor se detuvo antes de alcanzarlos, lo retenido se
        // muestra igual: es lo que la IA dijo.
        soltar(true);
        enEspera = [];
      }
    },
  };
}
