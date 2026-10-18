/**
 * La voz del Modo IA en streaming: cada mensaje de la IA se dice en cuanto
 * llega completo, sin cortar el que está sonando (`hablar` de `services/voz.ts`
 * cancela lo anterior; esta cola espera a su aviso de final).
 *
 * El puente nativo del móvil no avisa de cuándo termina una frase (`hablar`
 * devuelve `false`): ahí se dice el primer mensaje y el resto se junta y se
 * dice de una vez al `terminar`, para no pisar frases a medias.
 *
 * `vaciar` es la interrupción (el botón del micrófono mientras la IA habla):
 * descarta lo pendiente y la cola ya no dice nada más, aunque sigan llegando
 * mensajes de la respuesta cortada.
 */
export type Hablar = (texto: string, alTerminar?: () => void) => boolean;

export function crearColaDeVoz(hablar: Hablar): {
  decir(texto: string): void;
  terminar(): void;
  vaciar(): void;
  /**
   * Avisa una vez cuando ya no queda nada por decir (enseguida, si no suena
   * nada). Es lo que espera el modo conversación para volver a escuchar sin
   * pisar a la IA.
   */
  cuandoTermine(aviso: () => void): void;
} {
  const pendientes: string[] = [];
  let avisos: (() => void)[] = [];
  const avisarFin = (): void => {
    const porAvisar = avisos;
    avisos = [];
    porAvisar.forEach((aviso) => aviso());
  };
  let sonando = false;
  let sinAviso = false;
  let generacion = 0;
  let cerrada = false;

  const siguiente = (): void => {
    const texto = pendientes.shift();
    if (texto === undefined) {
      sonando = false;
      avisarFin();
      return;
    }
    sonando = true;
    const mia = generacion;
    const avisa = hablar(texto, () => {
      if (mia === generacion) siguiente();
    });
    if (!avisa) sinAviso = true;
  };

  return {
    cuandoTermine(aviso) {
      if (!sonando && pendientes.length === 0) aviso();
      else avisos.push(aviso);
    },
    decir(texto) {
      const limpio = texto.trim();
      if (!limpio || cerrada) return;
      pendientes.push(limpio);
      if (!sonando) siguiente();
    },
    terminar() {
      if (cerrada || !sinAviso) return;
      // El puente del móvil no dice cuándo termina: no hay a qué esperar.
      if (pendientes.length > 0) hablar(pendientes.splice(0).join(' '));
      avisarFin();
    },
    vaciar() {
      cerrada = true;
      generacion += 1;
      pendientes.length = 0;
      sonando = false;
      avisarFin();
    },
  };
}
