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
} {
  const pendientes: string[] = [];
  let sonando = false;
  let sinAviso = false;
  let generacion = 0;
  let cerrada = false;

  const siguiente = (): void => {
    const texto = pendientes.shift();
    if (texto === undefined) {
      sonando = false;
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
    decir(texto) {
      const limpio = texto.trim();
      if (!limpio || cerrada) return;
      pendientes.push(limpio);
      if (!sonando) siguiente();
    },
    terminar() {
      if (cerrada || !sinAviso || pendientes.length === 0) return;
      const resto = pendientes.splice(0).join(' ');
      hablar(resto);
    },
    vaciar() {
      cerrada = true;
      generacion += 1;
      pendientes.length = 0;
      sonando = false;
    },
  };
}
