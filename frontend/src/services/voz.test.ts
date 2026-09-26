import { afterEach, describe, expect, it, vi } from 'vitest';
import { callar, dictar, elegirVoz, hablar, sintesisDisponible } from './voz';
import { MS_MAXIMO_ESCUCHANDO, MS_SILENCIO_ANTES_DE_HABLAR, MS_SILENCIO_TRAS_HABLAR } from './dictado';

/**
 * La lectura en voz alta, comprobada sin navegador.
 *
 * Estas pruebas existen por una razón concreta: la guía ahora lee la respuesta
 * **sola** cuando la pregunta se hizo hablando, y para poder enseñar «está
 * sonando» hay que saber cuándo deja de sonar. Ese aviso pasa por tres sitios
 * donde es fácil equivocarse —el `cancel()` que dispara el final de la locución
 * anterior, el error que no llega a arrancar, y el puente nativo que no avisa
 * nunca— y los tres se ven igual desde fuera: un botón que se queda en
 * «Detener» para siempre.
 *
 * No hace falta jsdom. `voz.ts` solo mira `window` para saber qué hay, así que
 * un `window` de mentira con lo justo basta, y a cambio esto corre en Node como
 * el resto de la suite. Lo que no se prueba aquí es que el altavoz suene: eso se
 * comprueba con el oído y está en la lista de verificación manual.
 */

/** Una locución de mentira: guarda lo que le enganchan y deja dispararlo. */
class LocucionFalsa {
  lang = '';
  rate = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly text: string) {}
}

interface Sintesis {
  hablado: LocucionFalsa[];
  cancelaciones: number;
}

/**
 * Monta un `window` con síntesis y devuelve lo que se ha dicho por él.
 *
 * `cancel` dispara `onerror` de lo que estuviera sonando, como hace el navegador
 * de verdad, y **de forma asíncrona**: ahí está el fallo que esto vigila. Si el
 * aviso se emitiera sin comprobar de quién es, la segunda lectura encendería el
 * indicador y el final de la primera lo apagaría un instante después.
 *
 * `voces`, si se da, monta también `getVoices()` —opcional a propósito: el
 * `speechSynthesis` de verdad a veces tarda en tenerlas cargadas, y `hablar`
 * tiene que seguir funcionando sin ellas.
 */
function montarNavegador(voces?: unknown[]): Sintesis {
  const estado: Sintesis = { hablado: [], cancelaciones: 0 };
  let sonando: LocucionFalsa | null = null;

  const speechSynthesis = {
    cancel: (): void => {
      estado.cancelaciones += 1;
      const previa = sonando;
      sonando = null;
      if (previa) queueMicrotask(() => previa.onerror?.());
    },
    speak: (locucion: LocucionFalsa): void => {
      sonando = locucion;
      estado.hablado.push(locucion);
    },
    ...(voces ? { getVoices: (): unknown[] => voces } : {}),
  };

  Object.assign(globalThis, {
    window: { speechSynthesis },
    speechSynthesis,
    SpeechSynthesisUtterance: LocucionFalsa,
  });
  return estado;
}

/** Un `window` con el canal de Flutter y sin nada de la Web Speech API. */
function montarPuente(): string[] {
  const enviados: string[] = [];
  const VozNativa = { postMessage: (m: string): void => void enviados.push(m) };
  Object.assign(globalThis, { window: { VozNativa } });
  return enviados;
}

afterEach(() => {
  const global = globalThis as Record<string, unknown>;
  delete global['window'];
  delete global['speechSynthesis'];
  delete global['SpeechSynthesisUtterance'];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Dictado                                                                     */
/* -------------------------------------------------------------------------- */

interface HipotesisFalsa {
  transcript: string;
}

interface ResultadoFalso {
  isFinal: boolean;
  length: number;
  [indice: number]: HipotesisFalsa | undefined;
}

interface EventoFalso {
  resultIndex: number;
  results: ResultadoFalso[];
}

/** Una frase oída, con las hipótesis en el orden en que las da el motor. */
function oido(isFinal: boolean, ...alternativas: string[]): ResultadoFalso {
  const resultado: ResultadoFalso = { isFinal, length: alternativas.length };
  alternativas.forEach((transcript, indice) => {
    resultado[indice] = { transcript };
  });
  return resultado;
}

/**
 * Un `SpeechRecognition` de mentira, con lo justo para poder contar arranques.
 *
 * Los arranques son la mitad de lo que se comprueba aquí: el dictado largo se
 * sostiene sobre volver a arrancar el motor cada vez que él decide cortar, y esa
 * cuenta es la única forma de ver desde fuera si eso pasa.
 */
class ReconocedorFalso {
  static ultimo: ReconocedorFalso | null = null;

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  arranques = 0;
  paradas = 0;
  onresult: ((evento: EventoFalso) => void) | null = null;
  onerror: ((evento: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    ReconocedorFalso.ultimo = this;
  }

  start(): void {
    this.arranques += 1;
  }

  stop(): void {
    this.paradas += 1;
  }

  /** Lo que hace el motor de verdad: entrega resultados desde una posición. */
  entregar(desde: number, ...resultados: ResultadoFalso[]): void {
    this.onresult?.({ resultIndex: desde, results: resultados });
  }
}

/** Un `window` con reconocimiento y un aparato que habla castellano de Bolivia. */
function montarDictado(idiomas: string[] = ['es-BO']): void {
  ReconocedorFalso.ultimo = null;
  Object.assign(globalThis, { window: { SpeechRecognition: ReconocedorFalso } });
  vi.stubGlobal('navigator', { languages: idiomas, language: idiomas[0], userAgent: 'pruebas' });
  vi.useFakeTimers();
}

/** El motor que acaba de crear `dictar`. */
function motorUsado(): ReconocedorFalso {
  const motor = ReconocedorFalso.ultimo;
  if (!motor) throw new Error('dictar no creó ningún reconocedor');
  return motor;
}

function oyentes(): {
  onParcial: ReturnType<typeof vi.fn>;
  onFinal: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onFin: ReturnType<typeof vi.fn>;
} {
  return { onParcial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onFin: vi.fn() };
}

describe('dictar', () => {
  it('escucha en la variante del aparato y pide varias hipótesis', () => {
    montarDictado(['es-BO', 'en-US']);
    dictar(oyentes());

    const motor = ReconocedorFalso.ultimo;
    expect(motor?.lang).toBe('es-BO');
    expect(motor?.continuous).toBe(true);
    expect(motor?.maxAlternatives).toBeGreaterThan(1);
    expect(motor?.arranques).toBe(1);
  });

  /*
    El fallo que motivó todo esto. El motor corta en la primera pausa y antes esa
    pausa enviaba la orden a medias: «crea la clase» salía al asistente sin el
    nombre de la clase, y quien dictaba veía una interpretación absurda de algo
    que no había terminado de decir.
  */
  it('una pausa no envía la frase: se vuelve a escuchar y se junta', () => {
    montarDictado();
    const escucha = oyentes();
    dictar(escucha);
    const motor = motorUsado();

    motor.entregar(0, oido(true, 'crea la clase'));
    expect(escucha.onFinal).not.toHaveBeenCalled();

    // El motor se cansa del silencio y corta por su cuenta.
    motor.onend?.();
    expect(motor.arranques).toBe(2);
    expect(escucha.onFin).not.toHaveBeenCalled();

    motor.entregar(0, oido(true, 'Pedido con el atributo total'));
    vi.advanceTimersByTime(MS_SILENCIO_TRAS_HABLAR);

    expect(escucha.onFinal).toHaveBeenCalledTimes(1);
    expect(escucha.onFinal).toHaveBeenCalledWith('crea la clase Pedido con el atributo total');
    expect(escucha.onFin).toHaveBeenCalledTimes(1);
  });

  it('mientras se habla se ve lo acumulado y lo que se está oyendo', () => {
    montarDictado();
    const escucha = oyentes();
    dictar(escucha);
    const motor = motorUsado();

    const yaDicho = oido(true, 'crea la clase');
    motor.entregar(0, yaDicho);
    // El motor manda la lista entera y dice desde dónde es nuevo: lo anterior ya
    // está contado y volver a leerlo duplicaría la frase.
    motor.entregar(1, yaDicho, oido(false, 'Pedido'));

    expect(escucha.onParcial).toHaveBeenLastCalledWith('crea la clase Pedido');
  });

  it('de las hipótesis del motor se queda la que tiene sentido aquí', () => {
    montarDictado();
    const escucha = oyentes();
    dictar(escucha);
    const motor = motorUsado();

    motor.entregar(0, oido(true, 'crea la plaza pedido', 'crea la clase pedido'));
    vi.advanceTimersByTime(MS_SILENCIO_TRAS_HABLAR);

    expect(escucha.onFinal).toHaveBeenCalledWith('crea la clase pedido');
  });

  it('quien tiene una gramática decide con ella', () => {
    montarDictado();
    const escucha = oyentes();
    dictar({ ...escucha, puntuar: (texto) => (texto.endsWith('Pedido') ? 1 : 0) });
    const motor = motorUsado();

    motor.entregar(0, oido(true, 'crea la clase pedido', 'crea la clase Pedido'));
    vi.advanceTimersByTime(MS_SILENCIO_TRAS_HABLAR);

    expect(escucha.onFinal).toHaveBeenCalledWith('crea la clase Pedido');
  });

  /*
    Antes de la primera palabra se espera más: entre pulsar el botón y hablar hay
    que decidir qué se pide, y medir eso con el reloj de una pausa apagaba el
    micrófono antes de empezar.
  */
  it('da tiempo a arrancar a hablar', () => {
    montarDictado();
    const escucha = oyentes();
    dictar(escucha);

    vi.advanceTimersByTime(MS_SILENCIO_TRAS_HABLAR + 1);
    expect(escucha.onFin).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MS_SILENCIO_ANTES_DE_HABLAR);
    expect(escucha.onFin).toHaveBeenCalledTimes(1);
    // Nada dicho, nada que interpretar: no se manda una orden vacía.
    expect(escucha.onFinal).not.toHaveBeenCalled();
  });

  it('un silencio del motor no se cuenta como avería', () => {
    montarDictado();
    const escucha = oyentes();
    dictar(escucha);
    const motor = motorUsado();

    motor.onerror?.({ error: 'no-speech' });
    motor.onend?.();

    expect(escucha.onError).not.toHaveBeenCalled();
    expect(escucha.onFin).not.toHaveBeenCalled();
    expect(motor.arranques).toBe(2);
  });

  it('lo que no se arregla esperando se dice y apaga el micrófono', () => {
    montarDictado();
    const escucha = oyentes();
    dictar(escucha);
    const motor = motorUsado();

    motor.onerror?.({ error: 'not-allowed' });
    motor.onend?.();

    expect(escucha.onError).toHaveBeenCalledTimes(1);
    expect(escucha.onError.mock.calls[0]?.[0]).toContain('permiso');
    expect(escucha.onFin).toHaveBeenCalledTimes(1);
    // No se rearranca: insistir sin permiso solo repite la pregunta al navegador.
    expect(motor.arranques).toBe(1);
  });

  it('el botón de parar entrega lo dicho hasta ese momento', () => {
    montarDictado();
    const escucha = oyentes();
    const sesion = dictar(escucha);
    const motor = motorUsado();

    motor.entregar(0, oido(true, 'crea la clase Pedido'));
    sesion?.detener();

    expect(motor.paradas).toBe(1);
    expect(escucha.onFinal).toHaveBeenCalledWith('crea la clase Pedido');
    expect(escucha.onFin).toHaveBeenCalledTimes(1);
  });

  /*
    `stop()` sobre un motor que ya había terminado no dispara `onend`, y el aviso
    de fin se emite en los dos sitios para que no falte. Esto vigila que no
    sobre: dos avisos dejan a la interfaz apagando un micrófono que ya estaba
    apagado, o peor, apagando el de la sesión siguiente.
  */
  it('el fin se avisa una sola vez aunque el motor conteste después', () => {
    montarDictado();
    const escucha = oyentes();
    const sesion = dictar(escucha);
    const motor = motorUsado();

    sesion?.detener();
    motor.onend?.();
    sesion?.detener();

    expect(escucha.onFin).toHaveBeenCalledTimes(1);
  });

  it('un micrófono olvidado se cierra solo', () => {
    montarDictado();
    const escucha = oyentes();
    dictar(escucha);
    const motor = motorUsado();

    // Se sigue hablando cerca del teléfono sin querer dictar nada: cada trozo
    // rearma el reloj del silencio, así que sin el tope esto no acabaría nunca.
    const pasadas = Math.ceil((MS_MAXIMO_ESCUCHANDO / MS_SILENCIO_TRAS_HABLAR) * 2);
    for (let pasada = 0; pasada < pasadas && escucha.onFin.mock.calls.length === 0; pasada += 1) {
      motor.entregar(pasada, oido(false, 'ruido'));
      vi.advanceTimersByTime(MS_SILENCIO_TRAS_HABLAR - 1);
    }

    expect(escucha.onFin).toHaveBeenCalledTimes(1);
  });
});

describe('hablar', () => {
  it('dice el texto en castellano', () => {
    const sintesis = montarNavegador();
    hablar('hola');
    expect(sintesis.hablado.map((l) => l.text)).toEqual(['hola']);
    expect(sintesis.hablado[0]?.lang).toBe('es-ES');
  });

  it('avisa del final una sola vez y devuelve que va a avisar', () => {
    const sintesis = montarNavegador();
    const fin = vi.fn();

    expect(hablar('hola', fin)).toBe(true);
    expect(fin).not.toHaveBeenCalled();

    sintesis.hablado[0]?.onend?.();
    expect(fin).toHaveBeenCalledTimes(1);
  });

  it('avisa también cuando la voz no llega a arrancar', () => {
    const sintesis = montarNavegador();
    const fin = vi.fn();
    hablar('hola', fin);
    sintesis.hablado[0]?.onerror?.();
    expect(fin).toHaveBeenCalledTimes(1);
  });

  it('sin voces que ofrecer, sigue hablando con la voz por defecto', () => {
    // Sin `getVoices` en absoluto —el `speechSynthesis` de mentira de arriba— y
    // con `getVoices` devolviendo una lista vacía son el mismo caso desde aquí:
    // ninguno debe romper `hablar` ni impedir que se diga el texto.
    const sintesis = montarNavegador([]);
    hablar('hola');
    expect(sintesis.hablado[0]?.voice).toBeNull();
  });

  it('con una voz «Online (Natural)» disponible, se usa esa', () => {
    const natural = { lang: 'es-ES', name: 'Microsoft X Online (Natural)', localService: false };
    const local = { lang: 'es-ES', name: 'Spanish (Spain)', localService: true };
    const sintesis = montarNavegador([local, natural]);
    hablar('hola');
    expect(sintesis.hablado[0]?.voice).toBe(natural);
  });

  /*
    El caso que motivó el contador. Sin él, el `cancel()` de la segunda lectura
    llama al `onerror` de la primera y apaga el indicador de una lectura que
    acaba de empezar: en pantalla, «no está sonando» mientras suena.
  */
  it('el final de una lectura cancelada no apaga la que la sustituye', async () => {
    const sintesis = montarNavegador();
    const primera = vi.fn();
    const segunda = vi.fn();

    hablar('la primera', primera);
    hablar('la segunda', segunda);
    await Promise.resolve();

    expect(sintesis.cancelaciones).toBe(2);
    expect(primera).not.toHaveBeenCalled();
    expect(segunda).not.toHaveBeenCalled();

    sintesis.hablado[1]?.onend?.();
    expect(segunda).toHaveBeenCalledTimes(1);
  });

  it('callar no vuelve a avisar del final: quien calló ya lo sabe', async () => {
    const sintesis = montarNavegador();
    const fin = vi.fn();
    hablar('algo largo', fin);

    callar();
    await Promise.resolve();

    expect(sintesis.cancelaciones).toBe(2);
    expect(fin).not.toHaveBeenCalled();
  });

  it('sin síntesis no se promete un aviso que nadie va a dar', () => {
    Object.assign(globalThis, { window: {} });
    expect(sintesisDisponible()).toBe(false);
    expect(hablar('hola', vi.fn())).toBe(false);
  });

  /*
    El puente nativo habla, pero el lado Dart llama a `speak` y no devuelve nada
    al terminar. El `false` es lo que impide que el móvil se quede con un
    «Detener» permanente: la interfaz no enciende un indicador que no podría
    apagar.
  */
  it('por el puente nativo se habla pero no se promete el final', () => {
    const enviados = montarPuente();
    expect(hablar('hola', vi.fn())).toBe(false);
    expect(enviados.map((m) => JSON.parse(m))).toEqual([{ tipo: 'hablar', texto: 'hola' }]);
  });

  it('callar por el puente manda callar y no toca la síntesis', () => {
    const enviados = montarPuente();
    callar();
    expect(enviados.map((m) => JSON.parse(m))).toEqual([{ tipo: 'callar' }]);
  });
});

describe('elegirVoz', () => {
  it('sin ninguna voz, no elige nada', () => {
    expect(elegirVoz([])).toBeUndefined();
  });

  it('descarta las voces que no son de castellano', () => {
    const ingles = { lang: 'en-US', name: 'English Online (Natural)', localService: false };
    expect(elegirVoz([ingles])).toBeUndefined();
  });

  it('con una marcada «Online» o «Natural», gana esa aunque haya otras', () => {
    const local = { lang: 'es-MX', name: 'Sabina', localService: true };
    const enLaNube = { lang: 'es-US', name: 'X Online', localService: false };
    expect(elegirVoz([local, enLaNube])).toBe(enLaNube);
  });

  it('sin ninguna marcada así, gana la que no es del sistema', () => {
    const local = { lang: 'es-ES', name: 'Spanish (Spain)', localService: true };
    const enLaNube = { lang: 'es-ES', name: 'Google español', localService: false };
    expect(elegirVoz([local, enLaNube])).toBe(enLaNube);
  });

  it('si todas son locales, la primera de castellano es mejor que ninguna', () => {
    const primera = { lang: 'es-BO', name: 'Spanish (Bolivia)', localService: true };
    const segunda = { lang: 'es-AR', name: 'Spanish (Argentina)', localService: true };
    expect(elegirVoz([primera, segunda])).toBe(primera);
  });
});
