/**
 * Voz: dictado y lectura en voz alta (RF-IA-02).
 *
 * Hay dos implementaciones detrás de esta puerta y la de arriba no es la mejor,
 * es la única que existe en un navegador:
 *
 * 1. **La del navegador.** `SpeechRecognition` para escuchar y `speechSynthesis`
 *    para hablar. No necesita ninguna clave de API. Ojo con la asimetría, que es
 *    la razón de que estas dos cosas no se puedan prometer igual: la síntesis
 *    ocurre en el aparato y funciona sin conexión, mientras que el dictado de
 *    Chrome manda el audio a Google. «Voz sin internet» es cierto para una mitad
 *    y falso para la otra.
 *
 * 2. **El puente nativo.** Existe solo dentro de la app Android, donde hace
 *    falta porque el WebView de Android **no implementa la Web Speech API** —ni
 *    escuchar ni hablar—. No es una versión vieja de Chrome: es otro componente,
 *    y aunque comparte motor de render, deja fuera esta API a propósito. Sin
 *    puente, en el móvil el micrófono está muerto y el botón de escuchar ni
 *    siquiera se dibuja, que es exactamente el fallo del que salió esto: la
 *    función desaparecía sin decir nada y desde fuera era indistinguible de algo
 *    que nadie había programado.
 *
 * La elección es automática y el orden es «nativo primero»: si estamos dentro de
 * la app, lo nativo es lo único que funciona; si estamos en un navegador, el
 * puente no existe y no hay nada que elegir.
 */

import { getToken } from './api';
import { crearVozDelServidor, type ReproductorAudio, type VozDelServidor } from './voz-servidor';
import { dictarGrabando, grabacionDisponible } from './grabacion-servidor';
import {
  ALTERNATIVAS_PEDIDAS,
  MS_MAXIMO_ESCUCHANDO,
  MS_SILENCIO_ANTES_DE_HABLAR,
  MS_SILENCIO_TRAS_HABLAR,
  errorQueTermina,
  idiomaDeDictado,
  mejorAlternativa,
  mensajeDeError,
  unirDictado,
} from './dictado';

/* -------------------------------------------------------------------------- */
/* El puente con Flutter                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Lo que `webview_flutter` inyecta al registrar un `JavaScriptChannel`.
 *
 * Un canal es un objeto con un único método `postMessage(String)`. No hay
 * valores de retorno ni promesas: todo lo que venga de vuelta llega por otro
 * lado, llamando a una función global que instalamos nosotros.
 */
interface PuenteNativo {
  postMessage(mensaje: string): void;
}

const NOMBRE_CANAL = 'VozNativa';

/** La función que Flutter llama con `runJavaScript` para contestar. */
const NOMBRE_RECEPTOR = '__vozNativa';

interface VentanaConVoz {
  [NOMBRE_CANAL]?: PuenteNativo;
  [NOMBRE_RECEPTOR]?: (crudo: string) => void;
  SpeechRecognition?: ConstructorReconocedor;
  webkitSpeechRecognition?: ConstructorReconocedor;
}

function ventana(): VentanaConVoz | null {
  return typeof window === 'undefined' ? null : (window as unknown as VentanaConVoz);
}

/**
 * El canal está registrado antes de cargar la página, así que si estamos dentro
 * de la app ya existe en el primer render y no hace falta que la interfaz esté
 * pendiente de que aparezca más tarde. Esa decisión —registrarlo siempre, aunque
 * los plugins de voz fallen luego— es lo que evita un saludo asíncrono entre las
 * dos partes y todos los estados intermedios que trae.
 *
 * A cambio, que el puente exista no garantiza que el micrófono funcione. Eso se
 * sabe al usarlo, y por eso los errores llegan con el motivo que da el sistema
 * en vez de con un «no disponible» genérico.
 */
function puente(): PuenteNativo | null {
  return ventana()?.[NOMBRE_CANAL] ?? null;
}

function enviarAlPuente(p: PuenteNativo, mensaje: Record<string, unknown>): void {
  p.postMessage(JSON.stringify(mensaje));
}

/* -------------------------------------------------------------------------- */
/* La API del navegador                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Un resultado del motor: la misma frase oída de varias formas.
 *
 * Se indexa como un array —`resultado[0]` es la hipótesis en la que el motor más
 * confía— y `length` dice cuántas hay. Antes esta interfaz solo declaraba la
 * posición `0`, y esa declaración a medias era la razón de que el resto del
 * código no pudiera mirar las otras aunque llegaran.
 */
interface ResultadoReconocimiento {
  isFinal: boolean;
  length: number;
  [indice: number]: { transcript: string } | undefined;
}

interface EventoReconocimiento {
  resultIndex: number;
  results: { length: number; [indice: number]: ResultadoReconocimiento };
}

interface Reconocedor {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort?(): void;
  onresult: ((evento: EventoReconocimiento) => void) | null;
  onerror: ((evento: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type ConstructorReconocedor = new () => Reconocedor;

function constructorDisponible(): ConstructorReconocedor | null {
  const w = ventana();
  if (!w) return null;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function sintesisDelNavegador(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/* -------------------------------------------------------------------------- */
/* Qué se puede hacer aquí                                                     */
/* -------------------------------------------------------------------------- */

/** Si se puede dictar: por el puente nativo o por el navegador. */
export function dictadoDisponible(): boolean {
  return puente() !== null || constructorDisponible() !== null || (transcripcionDelServidor && grabacionDisponible());
}

/** Si se puede leer una respuesta en voz alta. */
export function sintesisDisponible(): boolean {
  return puente() !== null || sintesisDelNavegador();
}

/**
 * Por qué no hay voz, dicho de forma que sirva a quien lo lee.
 *
 * El mensaje viejo era «Prueba con Chrome o Edge», y dentro de la app Android
 * ese consejo es imposible de seguir: no hay ninguna forma de cambiar de
 * navegador porque no se está en un navegador. Aquí se separan los dos casos,
 * porque tienen salidas distintas —una es instalar otro navegador y la otra es
 * actualizar la app— y quien lee necesita saber cuál le toca.
 */
export function motivoSinVoz(): string {
  if (puente() !== null) return '';
  if (typeof window !== 'undefined' && /\bwv\b|; wv\)/.test(navigator.userAgent)) {
    return 'Esta versión de la app no trae el puente de voz del sistema.';
  }
  return 'Este navegador no reconoce voz. Prueba con Chrome o Edge.';
}

/* -------------------------------------------------------------------------- */
/* Dictado                                                                     */
/* -------------------------------------------------------------------------- */

export interface SesionDictado {
  detener: () => void;
  /** Corta sin entregar nada (al cerrar el panel). Solo la tiene la grabación del servidor. */
  cancelar?: () => void;
}

interface OyentesDictado {
  onParcial: (texto: string) => void;
  onFinal: (texto: string) => void;
  onError: (mensaje: string) => void;
  onFin: () => void;
  /**
   * Con qué decidir entre las hipótesis que devuelve el motor.
   *
   * El motor las ordena por confianza acústica y no sabe nada de esta
   * herramienta: para él «crea la plaza pedido» y «crea la clase pedido» son la
   * misma frase con dos sonidos parecidos. Quien llama sí sabe cuál de las dos
   * tiene sentido aquí, y el asistente lo sabe mejor que nadie porque tiene una
   * gramática que puede probar a interpretarlas.
   *
   * Es opcional porque el criterio de serie —el vocabulario de la herramienta—
   * ya sirve para la guía, donde no hay ninguna gramática que consultar.
   */
  puntuar?: (texto: string) => number;
  /**
   * Algo que hay que saber pero que no ha impedido dictar.
   *
   * Va aparte de `onError` porque un aviso no cancela nada, y llegando por la
   * vía del error la interfaz apagaría el micrófono en mitad de una frase para
   * contar algo que no la impedía. El caso que lo justifica es el dictado que
   * sale a internet por no haber idioma descargado en el aparato: cambia lo que
   * se puede prometer, no lo que se puede hacer.
   */
  onAviso?: (mensaje: string) => void;
}

/**
 * La sesión que está escuchando ahora mismo, si la hay.
 *
 * Hace falta porque las respuestas del puente llegan a una función global y no
 * al sitio que pidió escuchar: el canal de `webview_flutter` no devuelve nada,
 * así que la conversación es de ida por un lado y de vuelta por otro. Solo puede
 * haber una: dos micrófonos a la vez no tendrían sentido y la interfaz tampoco
 * los ofrece.
 */
let sesionNativa: OyentesDictado | null = null;
let receptorInstalado = false;

/**
 * Instala la función que Flutter llama para contestar.
 *
 * Se hace al primer uso y no al cargar el módulo: montar una global como efecto
 * de un `import` hace que el orden de los imports pase a importar, y eso es una
 * dependencia invisible que se rompe el día que alguien reordena una línea.
 */
function instalarReceptor(): void {
  const w = ventana();
  if (receptorInstalado || !w) return;
  receptorInstalado = true;

  w[NOMBRE_RECEPTOR] = (crudo: string): void => {
    // Viene de nuestro propio código Dart, pero se valida igual. Un `JSON.parse`
    // sin comprobar la forma es una excepción no capturada dentro de una llamada
    // que nadie envuelve, y el síntoma sería que el dictado deja de responder
    // sin ningún error visible.
    let mensaje: unknown;
    try {
      mensaje = JSON.parse(crudo);
    } catch {
      return;
    }
    if (typeof mensaje !== 'object' || mensaje === null) return;

    const { tipo, texto, motivo } = mensaje as {
      tipo?: unknown;
      texto?: unknown;
      motivo?: unknown;
    };
    const oyentes = sesionNativa;
    if (!oyentes) return;

    if (tipo === 'parcial' && typeof texto === 'string') {
      oyentes.onParcial(texto);
      return;
    }
    if (tipo === 'final' && typeof texto === 'string') {
      oyentes.onFinal(texto.trim());
      return;
    }
    if (tipo === 'aviso') {
      // Se ignora si nadie escucha avisos, y no se degrada a error: un aviso
      // que nadie muestra es información perdida, pero un aviso disfrazado de
      // error es una sesión de dictado cortada por nada.
      if (typeof motivo === 'string') oyentes.onAviso?.(motivo);
      return;
    }
    if (tipo === 'error') {
      oyentes.onError(typeof motivo === 'string' ? motivo : 'No se pudo usar el micrófono.');
      return;
    }
    if (tipo === 'fin') {
      sesionNativa = null;
      oyentes.onFin();
    }
  };
}

/** Los idiomas que declara el aparato, del más querido al menos. */
function idiomasDelAparato(): string[] {
  if (typeof navigator === 'undefined') return [];
  const nav = navigator as Navigator & { languages?: readonly string[] };
  if (nav.languages && nav.languages.length > 0) return [...nav.languages];
  return nav.language ? [nav.language] : [];
}

/** Todas las hipótesis de un resultado, en el orden que las da el motor. */
function hipotesis(resultado: ResultadoReconocimiento): string[] {
  const todas: string[] = [];
  const cuantas = Math.max(1, resultado.length ?? 1);
  for (let i = 0; i < cuantas; i += 1) {
    const transcripcion = resultado[i]?.transcript;
    if (typeof transcripcion === 'string') todas.push(transcripcion);
  }
  return todas;
}

/**
 * Escucha hasta que se llama a `detener`, hasta un silencio largo o hasta el tope.
 *
 * **Una pausa ya no termina el dictado.** El motor del navegador corta solo a la
 * primera pausa —no hay forma de pedirle que no lo haga— así que aquí se vuelve a
 * arrancar cada vez que corta y se van juntando los trozos. Lo que decide que la
 * frase acabó es un temporizador de varios segundos, no el motor, y por eso se
 * puede pensar en mitad de la orden sin que se envíe a medias.
 *
 * `onFinal` se llama **una sola vez**, con la frase entera, cuando la sesión se
 * cierra. Antes llegaba en cada pausa, y en el asistente eso significaba una
 * consulta al modelo por cada trozo dictado.
 *
 * `onParcial` recibe lo acumulado más lo que se está oyendo ahora: sin esa
 * realimentación no hay forma de saber si el micrófono está captando algo, y el
 * usuario repite la frase entera pensando que falló.
 */
export function dictar(opciones: OyentesDictado): SesionDictado | null {
  const nativo = puente();
  if (nativo) {
    instalarReceptor();
    sesionNativa = opciones;
    enviarAlPuente(nativo, { tipo: 'escuchar' });
    return {
      detener: () => enviarAlPuente(nativo, { tipo: 'parar' }),
    };
  }

  const Constructor = constructorDisponible();
  if (!Constructor) {
    // Sin reconocimiento propio (Firefox): se graba y transcribe el servidor.
    if (transcripcionDelServidor && grabacionDisponible()) return dictarGrabando(opciones, transcribirEnElServidor);
    opciones.onError(motivoSinVoz());
    return null;
  }

  const reconocedor = new Constructor();
  reconocedor.lang = idiomaDeDictado(idiomasDelAparato());
  // El motor corta igual en la primera pausa, pero con `continuous` corta
  // bastante más tarde y devuelve varios resultados finales en una misma sesión.
  // El reinicio de `onend` es lo que cubre el resto.
  reconocedor.continuous = true;
  reconocedor.interimResults = true;
  reconocedor.maxAlternatives = ALTERNATIVAS_PEDIDAS;

  /** Los trozos ya dados por definitivos por el motor. */
  const partes: string[] = [];
  let cerrada = false;
  let finAvisado = false;
  let seHaOido = false;
  let silencio: ReturnType<typeof setTimeout> | null = null;
  let tope: ReturnType<typeof setTimeout> | null = null;

  const soltarRelojes = (): void => {
    if (silencio !== null) clearTimeout(silencio);
    if (tope !== null) clearTimeout(tope);
    silencio = null;
    tope = null;
  };

  /**
   * Da la frase por terminada: la entrega y deja de escuchar.
   *
   * El aviso de fin se emite aquí y no solo en `onend` porque `stop()` sobre un
   * motor que ya había terminado no dispara nada, y entonces el botón se quedaría
   * en «Grabando» para siempre. `finAvisado` hace que llegar por los dos caminos
   * no avise dos veces.
   */
  const cerrar = (): void => {
    if (cerrada) return;
    cerrada = true;
    soltarRelojes();
    const dicho = unirDictado(partes);
    try {
      reconocedor.stop();
    } catch {
      // Ya estaba parado. No hay nada que hacer y no es un error que contar.
    }
    if (dicho) opciones.onFinal(dicho);
    if (!finAvisado) {
      finAvisado = true;
      opciones.onFin();
    }
  };

  const rearmarSilencio = (): void => {
    if (silencio !== null) clearTimeout(silencio);
    silencio = setTimeout(cerrar, seHaOido ? MS_SILENCIO_TRAS_HABLAR : MS_SILENCIO_ANTES_DE_HABLAR);
  };

  reconocedor.onresult = (evento) => {
    let parcial = '';
    for (let i = evento.resultIndex; i < evento.results.length; i += 1) {
      const resultado = evento.results[i];
      if (!resultado) continue;
      const texto = mejorAlternativa(hipotesis(resultado), opciones.puntuar);
      if (!texto) continue;
      if (resultado.isFinal) partes.push(texto);
      else parcial += ` ${texto}`;
    }
    seHaOido = true;
    rearmarSilencio();
    opciones.onParcial(unirDictado([...partes, parcial]));
  };

  reconocedor.onerror = (evento) => {
    // Una pausa larga y el botón de parar llegan por aquí disfrazados de error.
    // Tratarlos como tal era lo que apagaba el micrófono a media frase.
    if (!errorQueTermina(evento.error)) return;
    cerrada = true;
    soltarRelojes();
    opciones.onError(mensajeDeError(evento.error));
    if (!finAvisado) {
      finAvisado = true;
      opciones.onFin();
    }
  };

  reconocedor.onend = () => {
    if (cerrada) {
      if (!finAvisado) {
        finAvisado = true;
        opciones.onFin();
      }
      return;
    }
    // El motor se ha cansado del silencio, pero el usuario no ha terminado: se
    // vuelve a escuchar. Si el navegador se niega a rearrancar se cierra con lo
    // que haya, que es mejor que un micrófono apagado con cara de encendido.
    try {
      reconocedor.start();
    } catch {
      cerrar();
    }
  };

  try {
    reconocedor.start();
  } catch {
    opciones.onError('No se pudo iniciar el micrófono.');
    return null;
  }

  rearmarSilencio();
  tope = setTimeout(cerrar, MS_MAXIMO_ESCUCHANDO);

  return { detener: cerrar };
}

/* -------------------------------------------------------------------------- */
/* Lectura en voz alta                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cuántas lecturas se han empezado. Sirve para saber si el `onend` que llega es
 * el de la lectura de ahora o el de una que se canceló.
 *
 * Hace falta porque `speechSynthesis.cancel()` no calla en silencio: dispara el
 * final de la locución anterior, y lo hace **después** de que `hablar` haya
 * devuelto. Sin este contador, pedir una segunda lectura apagaba el indicador de
 * la primera y dejaba la interfaz diciendo «no está sonando» mientras sonaba.
 */
let lecturaEnCurso = 0;

/**
 * La locución que se está diciendo, guardada solo para que no la recoja el
 * recolector de basura.
 *
 * No es paranoia: Chrome tiene la locución referenciada únicamente desde la cola
 * interna, y en textos largos se da el caso de que el objeto desaparece antes de
 * terminar y `onend` no llega nunca. La consecuencia aquí sería un botón que se
 * queda en «Detener» para siempre.
 */
let ultimaLocucion: SpeechSynthesisUtterance | null = null;

/** Desengancha la locución anterior antes de empezar otra o de callar. */
function soltarLocucion(): void {
  if (!ultimaLocucion) return;
  ultimaLocucion.onend = null;
  ultimaLocucion.onerror = null;
  ultimaLocucion = null;
}

/**
 * De las voces que ofrece el navegador, la que menos suena a máquina.
 *
 * `speechSynthesis` no da a elegir «una voz natural»: da una lista plana con
 * el motor local del sistema operativo —el mismo desde hace veinte años, y el
 * que de verdad suena mecánico porque es el más barato de traer instalado— y,
 * en Chrome y Edge, una o varias voces en la nube del propio navegador que sí
 * varían la entonación con el sentido de la frase. Estas se distinguen sin
 * mirar el nombre: `localService` es `false` porque piden red, y Edge además
 * las llama «Online» o «Online (Natural)» en el propio nombre. A falta de una
 * marcada así, mejor la local que ninguna voz.
 *
 * Aparte para poder probarla con una lista inventada de voces: `getVoices()`
 * del navegador de verdad no se puede llamar desde una prueba sin `jsdom`.
 */
export function elegirVoz(
  voces: readonly Pick<SpeechSynthesisVoice, 'lang' | 'name' | 'localService'>[],
): SpeechSynthesisVoice | undefined {
  const delCastellano = voces.filter((v) => v.lang.toLowerCase().startsWith('es'));
  if (delCastellano.length === 0) return undefined;
  const elegida =
    delCastellano.find((v) => /natural|online/i.test(v.name)) ??
    delCastellano.find((v) => !v.localService) ??
    delCastellano[0];
  return elegida as SpeechSynthesisVoice | undefined;
}

/**
 * Lee un texto en voz alta, por donde se pueda.
 *
 * Se cancela lo anterior antes de empezar: sin eso, tocar «Escuchar» dos veces
 * encola la segunda lectura detrás de la primera y hay que esperar a que termine
 * un párrafo entero para oír el siguiente, que no es lo que nadie espera de un
 * botón que ya está sonando.
 *
 * Devuelve **si se va a avisar del final**, y esa es toda la promesa: `true`
 * significa que `alTerminar` se llamará una vez, y `false` significa que nadie
 * dirá nada aunque el altavoz esté sonando. El segundo caso es el puente nativo,
 * donde el lado Dart llama a `speak` y no devuelve nada al terminar. Se dice con
 * un valor de retorno en vez de callarse porque una interfaz que muestre
 * «sonando» a partir de esto tiene que saber si alguna vez podrá quitarlo: sin
 * este `false`, el móvil se quedaría con un «Detener» permanente.
 */
export function hablar(texto: string, alTerminar?: () => void): boolean {
  const nativo = puente();
  if (nativo) {
    enviarAlPuente(nativo, { tipo: 'hablar', texto });
    return false;
  }
  // La voz del servidor (ElevenLabs), si la hay. Si falla, la del navegador; y
  // si tampoco hay, se avisa el final igual: quien espera a `alTerminar`
  // (la cola de frases del Modo IA) no puede quedarse esperando para siempre.
  if (vozDelServidor?.activa) {
    vozDelServidor.hablar(texto, alTerminar, () => {
      if (!hablarConElNavegador(texto, alTerminar)) alTerminar?.();
    });
    return alTerminar !== undefined;
  }
  return hablarConElNavegador(texto, alTerminar);
}

/** La voz del sistema (`speechSynthesis`), la de siempre. */
function hablarConElNavegador(texto: string, alTerminar?: () => void): boolean {
  if (!sintesisDelNavegador()) return false;

  lecturaEnCurso += 1;
  const mia = lecturaEnCurso;
  soltarLocucion();
  speechSynthesis.cancel();

  const locucion = new SpeechSynthesisUtterance(texto);
  locucion.lang = 'es-ES';
  // Un pelín más lento que el 1 por defecto: en las voces del sistema —las que
  // suenan más a máquina— es el propio ritmo, más que el tono, el que se
  // atropella con las frases cortas del asistente.
  locucion.rate = 0.95;
  // `getVoices` no existe en el `speechSynthesis` de mentira de las pruebas
  // (no hace falta: lo que se prueba ahí es `elegirVoz`, suelta), y en el
  // navegador de verdad puede devolver la lista vacía si se llama antes de que
  // termine de cargar. Las dos veces, sin voz explícita se cae a la voz por
  // defecto del sistema, que es lo que hacía antes de este cambio.
  if (typeof speechSynthesis.getVoices === 'function') {
    const voz = elegirVoz(speechSynthesis.getVoices());
    if (voz) locucion.voice = voz;
  }
  if (alTerminar) {
    const avisar = (): void => {
      if (mia === lecturaEnCurso) alTerminar();
    };
    // También en el error: una voz que no arranca deja el mismo estado que una
    // que termina, y no avisar ahí es exactamente el botón atascado que se
    // quería evitar.
    locucion.onend = avisar;
    locucion.onerror = avisar;
  }
  ultimaLocucion = locucion;
  speechSynthesis.speak(locucion);
  return alTerminar !== undefined;
}

/** Corta la lectura en curso. */
export function callar(): void {
  const nativo = puente();
  if (nativo) {
    enviarAlPuente(nativo, { tipo: 'callar' });
    return;
  }
  vozDelServidor?.callar();
  if (!sintesisDelNavegador()) return;
  // Se invalida el aviso antes de cancelar: quien llama a `callar` ya sabe que
  // ha parado, y el `onend` que provoca `cancel` llegaría después a contarlo
  // otra vez, encima cuando el componente puede estar ya desmontado.
  lecturaEnCurso += 1;
  soltarLocucion();
  speechSynthesis.cancel();
}

/* -------------------------------------------------------------------------- */
/* Voz del servidor (ElevenLabs)                                               */
/* -------------------------------------------------------------------------- */

let vozDelServidor: VozDelServidor | null = null;
let transcripcionDelServidor = false;
let preparando: Promise<EstadoVozDelServidor> | null = null;

export interface EstadoVozDelServidor {
  /** `hablar` usa la voz de ElevenLabs. */
  voz: boolean;
  /** El servidor transcribe la voz (Groq) para los navegadores sin reconocimiento propio. */
  transcripcion: boolean;
}

const SIN_VOZ_DEL_SERVIDOR: EstadoVozDelServidor = { voz: false, transcripcion: false };

/**
 * Pregunta una vez al servidor qué tiene: voz de ElevenLabs, para que `hablar`
 * la use, y transcripción, para que `dictar` funcione en Firefox. Sin sesión,
 * sin red o sin nada configurado, no cambia nada. En el móvil no se usa: allí
 * habla y escucha el puente nativo.
 */
export function prepararVozDelServidor(): Promise<EstadoVozDelServidor> {
  if (puente() !== null || typeof Audio === 'undefined') return Promise.resolve(SIN_VOZ_DEL_SERVIDOR);
  let consultado = false;
  preparando ??= (async () => {
    try {
      const respuesta = await fetch('/api/voz/estado', { headers: cabecerasConSesion() });
      const estado = respuesta.ok
        ? ((await respuesta.json()) as { elevenlabs?: boolean; transcripcion?: boolean })
        : null;
      consultado = estado !== null;
      transcripcionDelServidor = estado?.transcripcion === true;
      if (!estado?.elevenlabs) return { voz: false, transcripcion: transcripcionDelServidor };
      vozDelServidor = crearVozDelServidor({
        pedirAudio: async (texto, senal) => {
          const audio = await fetch('/api/voz/sintetizar', {
            method: 'POST',
            headers: { ...cabecerasConSesion(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ texto }),
            signal: senal,
          });
          if (!audio.ok) throw Object.assign(new Error(`voz ${audio.status}`), { status: audio.status });
          return audio.blob();
        },
        crearReproductor: (url) => reproductorDe(new Audio(url)),
        crearUrl: (audio) => URL.createObjectURL(audio),
        liberarUrl: (url) => URL.revokeObjectURL(url),
      });
      return { voz: true, transcripcion: transcripcionDelServidor };
    } catch {
      return SIN_VOZ_DEL_SERVIDOR;
    } finally {
      // Si no se pudo preguntar (por ejemplo, sin sesión todavía), se puede volver a probar.
      if (!consultado) preparando = null;
    }
  })();
  return preparando;
}

/** Manda la grabación a `POST /api/voz/transcribir` y devuelve el texto. */
async function transcribirEnElServidor(audio: Blob): Promise<string> {
  const respuesta = await fetch('/api/voz/transcribir', {
    method: 'POST',
    headers: { ...cabecerasConSesion(), 'Content-Type': audio.type || 'audio/webm' },
    body: audio,
  });
  if (!respuesta.ok) throw new Error('No se pudo transcribir la voz. Puedes escribir la orden.');
  const datos = (await respuesta.json()) as { texto?: unknown };
  return typeof datos.texto === 'string' ? datos.texto : '';
}

/** Si `hablar` está usando la voz de ElevenLabs (para mencionarla, como pide su plan gratuito). */
export function vozDelServidorActiva(): boolean {
  return vozDelServidor?.activa ?? false;
}

function cabecerasConSesion(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `HTMLAudioElement` con la forma mínima que usa `voz-servidor.ts`. */
function reproductorDe(audio: HTMLAudioElement): ReproductorAudio {
  let alTerminar: (() => void) | null = null;
  let alFallar: (() => void) | null = null;
  return {
    play: () => audio.play(),
    pause: () => audio.pause(),
    get onended() {
      return alTerminar;
    },
    set onended(fn) {
      alTerminar = fn;
      audio.onended = fn ? () => fn() : null;
    },
    get onerror() {
      return alFallar;
    },
    set onerror(fn) {
      alFallar = fn;
      audio.onerror = fn ? () => fn() : null;
    },
  };
}
