import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buscar, type Resultado } from '@app/shared';
import { ApiError, api } from '../services/api';
import { indiceDeLaGuia } from '../services/documentos';
import {
  guardarUrlOllama,
  modelosDisponibles,
  OLLAMA_POR_DEFECTO,
  preguntar,
  urlOllama,
} from '../services/ollama';
import {
  callar,
  dictadoDisponible,
  dictar,
  hablar,
  motivoSinVoz,
  sintesisDisponible,
  type SesionDictado,
} from '../services/voz';
import { Icono } from './iconos';

/**
 * La guía: preguntar cómo se hace algo y que el manual conteste.
 *
 * Tiene tres caminos, y no los elige el usuario sino lo que haya disponible:
 *
 *   1. **Ollama en esta máquina.** Redacta la respuesta sin salir del equipo y
 *      sin gastar nada. Es lo que se enseña en la defensa.
 *   2. **El servidor, si hay red.** Mismo manual, mismo fragmento recuperado, y
 *      un modelo remoto que redacta. Es el camino del móvil, donde Ollama no
 *      existe.
 *   3. **La búsqueda, aquí mismo.** Sin red, sin modelo y sin servidor. Enseña
 *      las secciones del manual que responden a la pregunta.
 *
 * El tercero no es un mensaje de error disfrazado: es una respuesta útil, y de
 * hecho la más fiable de las tres, porque es texto que alguien escribió a
 * propósito en vez de una paráfrasis. Por eso la búsqueda se hace **siempre y
 * primero**, aunque haya modelo: hay algo que leer mientras el modelo escribe,
 * y si el modelo falla a media frase no se pierde nada.
 *
 * ## Lo que entra por voz sale por voz
 *
 * Si la pregunta se hizo hablando, la respuesta se lee sola. Si se escribió, no.
 *
 * La regla no es una preferencia de estilo: es la única que no sorprende. Quien
 * pregunta hablando suele tener las manos ocupadas o la pantalla lejos —es el
 * caso del móvil apoyado mientras se dibuja—, y tener que buscar un botón para
 * oír la respuesta anula el motivo de haber hablado. Y al revés, un portátil que
 * se pone a hablar en una sala porque alguien escribió una pregunta es un fallo,
 * no una función: no hay forma de saber si había gente delante.
 *
 * De ahí que el disparador sea **cómo entró la pregunta** y no una casilla de
 * ajustes. Una casilla obliga a decidir antes de saber, y se queda mal puesta.
 */

interface Estado {
  readonly pregunta: string;
  readonly respuesta: string | null;
  readonly fuentes: readonly Resultado[];
  readonly pensando: boolean;
  readonly error: string | null;
}

const VACIO: Estado = {
  pregunta: '',
  respuesta: null,
  fuentes: [],
  pensando: false,
  error: null,
};

/**
 * Lo que se dice en voz alta cuando el manual no tiene nada.
 *
 * Es más corto que el texto de la pantalla y a propósito: leído, un párrafo con
 * la ruta `docs/` dentro suena a error de sistema. La pantalla sigue diciendo lo
 * demás para quien esté mirando.
 */
const SIN_RESULTADOS = 'No encuentro eso en el manual. Cabe preguntarlo de otra forma.';

/** Lo que se dice cuando hay secciones del manual pero nadie las ha redactado. */
const SIN_REDACCION = 'Hay secciones del manual sobre eso. Están en pantalla.';

const EJEMPLOS = [
  '¿cómo exporto a Enterprise Architect?',
  '¿qué órdenes entiende la voz?',
  '¿cómo leo un diagrama de una foto?',
  '¿qué base de datos genera el backend?',
];

export interface GuiaProps {
  onCerrar: () => void;
  /**
   * Volver a abrir el recorrido de primer acceso.
   *
   * Es opcional porque el recorrido solo lo monta `App`, y esta guía se puede
   * usar sin él. Y entra por aquí, y no por un segundo botón flotante en la
   * esquina, porque una vez visto el recorrido se busca donde se busca todo lo
   * demás que se olvidó: en la ayuda.
   */
  onRecorrido?: () => void;
}

export function Guia({ onCerrar, onRecorrido }: GuiaProps): JSX.Element {
  const indice = useMemo(() => indiceDeLaGuia(), []);
  const [texto, setTexto] = useState('');
  const [estado, setEstado] = useState<Estado>(VACIO);
  const [modelo, setModelo] = useState<string | null>(null);
  const [escuchando, setEscuchando] = useState(false);
  const [sonando, setSonando] = useState(false);
  // La URL de Ollama: `localhost` salvo que alguien haya guardado la de un
  // túnel (ver `ollama.ts`). Vive en estado, y no se lee de nuevo en cada
  // pregunta, para que cambiarla dispare la comprobación de qué modelo hay.
  const [urlModelo, setUrlModelo] = useState(() => urlOllama());
  const [editandoUrl, setEditandoUrl] = useState(false);
  const dictadoRef = useRef<SesionDictado | null>(null);
  const abortoRef = useRef<AbortController | null>(null);
  const entradaRef = useRef<HTMLInputElement>(null);

  // Se pregunta una sola vez al abrir —y otra vez si cambia la URL—, con un
  // tiempo de espera corto. Que no haya modelo es el caso normal, no una
  // avería, así que esto no muestra nada rojo: solo decide qué se puede ofrecer.
  useEffect(() => {
    let cancelado = false;
    void modelosDisponibles({ url: urlModelo }).then((modelos) => {
      if (!cancelado) setModelo(modelos[0] ?? null);
    });
    return () => {
      cancelado = true;
    };
  }, [urlModelo]);

  useEffect(() => {
    entradaRef.current?.focus();
    return () => {
      abortoRef.current?.abort();
      dictadoRef.current?.detener();
      // Cerrar la guía calla la lectura. Sin esto, la respuesta se sigue oyendo
      // sobre el diagrama y no queda ningún botón en pantalla para pararla.
      callar();
    };
  }, []);

  /**
   * Lee una respuesta y deja constancia de que está sonando.
   *
   * El estado se enciende con lo que devuelve `hablar`, no con un `true` fijo:
   * en el puente nativo nadie avisa del final, así que encenderlo allí dejaría
   * un «Detener» que no se apaga nunca. Vale más no prometer el indicador que
   * dejarlo mintiendo.
   */
  const leer = useCallback((texto: string): void => {
    const plano = sinMarkdown(texto);
    if (!plano) return;
    setSonando(hablar(plano, () => setSonando(false)));
  }, []);

  const parar = useCallback((): void => {
    callar();
    setSonando(false);
  }, []);

  useEffect(() => {
    const alPulsar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCerrar();
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [onCerrar]);

  const consultar = useCallback(
    async (pregunta: string, porVoz = false): Promise<void> => {
      const limpia = pregunta.trim();
      if (!limpia) return;

      abortoRef.current?.abort();
      const aborto = new AbortController();
      abortoRef.current = aborto;
      // Una pregunta nueva calla la anterior. Es lo que hace cualquier asistente
      // y lo que espera quien vuelve a hablar: seguir oyendo la respuesta vieja
      // mientras se prepara la nueva es la forma más rápida de perder las dos.
      parar();

      // La búsqueda primero y sin esperar a nadie: es instantánea y no necesita
      // red, así que no hay razón para que el usuario mire una pantalla vacía
      // mientras se decide si hay modelo.
      const fuentes = buscar(indice, limpia, 4);
      setEstado({
        pregunta: limpia,
        respuesta: null,
        fuentes,
        pensando: fuentes.length > 0,
        error: null,
      });

      if (fuentes.length === 0) {
        // Quedarse callado tras una pregunta hablada no se distingue de un
        // micrófono que no captó nada, y lo que se hace entonces es repetir la
        // frase más alto. Decirlo cuesta una línea y ahorra ese bucle.
        if (porVoz) leer(SIN_RESULTADOS);
        return;
      }

      // Con Ollama delante se usa Ollama: no gasta clave, no sale del equipo y
      // escribe según piensa. El servidor solo entra donde Ollama no puede.
      if (modelo !== null) {
        try {
          const r = await preguntar(indice, limpia, {
            modelo,
            url: urlModelo,
            signal: aborto.signal,
            // Se pinta según llega. Un modelo de 3B en un portátil tarda varios
            // segundos en la respuesta entera, pero la primera palabra sale casi
            // enseguida, y eso distingue «está pensando» de «se colgó».
            onTrozo: (trozo) => {
              setEstado((previo) => ({ ...previo, respuesta: (previo.respuesta ?? '') + trozo }));
            },
          });
          if (aborto.signal.aborted) return;
          setEstado((previo) => ({ ...previo, respuesta: r.texto, pensando: false }));
          // Al final y una sola vez, no en cada trozo: leer según se escribe
          // sonaría entrecortado y encima se solaparía consigo mismo.
          if (porVoz) leer(r.texto);
        } catch (error) {
          if (aborto.signal.aborted) return;
          // El fallo del modelo no deja al usuario sin nada: las secciones ya
          // están puestas y siguen respondiendo a la pregunta.
          setEstado((previo) => ({
            ...previo,
            pensando: false,
            respuesta: null,
            error:
              error instanceof Error
                ? `El modelo local falló (${error.message}). Abajo están las secciones del manual.`
                : 'El modelo local falló. Abajo están las secciones del manual.',
          }));
        }
        return;
      }

      // Sin Ollama se prueba el servidor. Es el camino del móvil. Si tampoco
      // hay red, la búsqueda que ya está en pantalla es la respuesta, y no se
      // muestra ningún error: quedarse sin conexión no es una avería de la
      // aplicación y no tiene por qué parecerlo.
      try {
        const r = await api.preguntarGuia(limpia);
        if (aborto.signal.aborted) return;
        setEstado((previo) => ({
          ...previo,
          respuesta: r.texto,
          pensando: false,
          error: r.aviso,
        }));
        // El texto es nulo cuando no hubo modelo: entonces la respuesta son las
        // fuentes, que no se leen —son párrafos enteros del manual y sonarían
        // como un documento dictado—, y lo que se dice es por qué no la hay.
        if (porVoz) leer(r.texto ?? r.aviso ?? SIN_REDACCION);
      } catch (error) {
        if (aborto.signal.aborted) return;
        const sinRed = error instanceof ApiError && error.esDeRed;
        setEstado((previo) => ({
          ...previo,
          pensando: false,
          error: sinRed ? null : error instanceof Error ? error.message : null,
        }));
      }
    },
    [indice, modelo, urlModelo, leer, parar],
  );

  const alternarMicrofono = useCallback((): void => {
    if (escuchando) {
      dictadoRef.current?.detener();
      return;
    }
    setEscuchando(true);
    dictadoRef.current = dictar({
      onParcial: setTexto,
      onFinal: (final) => {
        setTexto(final);
        // El `true` es lo único que separa «pregunta hablada» de «pregunta
        // escrita», y por tanto lo único que decide si la respuesta suena.
        void consultar(final, true);
      },
      onError: (mensaje) => {
        setEstado((previo) => ({ ...previo, error: mensaje }));
        setEscuchando(false);
      },
      // Mismo sitio que el error pero sin apagar el micrófono: aquí `error` es
      // la línea donde ya se cuentan los avisos del servidor, no solo las
      // averías.
      onAviso: (aviso) => setEstado((previo) => ({ ...previo, error: aviso })),
      onFin: () => setEscuchando(false),
    });
    if (!dictadoRef.current) setEscuchando(false);
  }, [escuchando, consultar]);

  const respondido = estado.pregunta !== '';

  /*
   * Dictado y lectura se preguntan por separado porque no son la misma
   * capacidad. En un navegador de escritorio la síntesis ocurre en el aparato y
   * funciona sin conexión, mientras que el dictado de Chrome manda el audio a
   * Google; y dentro del WebView de Android no hay ninguna de las dos salvo que
   * exista el puente nativo. Un único `vozDisponible()` obligaba a apagar las
   * dos cuando fallaba una.
   */
  const hayDictado = dictadoDisponible();
  const haySintesis = sintesisDisponible();

  return (
    <div className="guia" role="dialog" aria-modal="true" aria-label="Guía de la herramienta">
      <div className="guia__caja">
        <header className="guia__cabecera">
          <h2>¿Cómo se hace…?</h2>
          {/*
            Se dice con qué se está respondiendo. No es un detalle técnico de
            adorno: las tres respuestas se parecen en pantalla y no se fían
            igual, y quien lee tiene derecho a saber cuál está leyendo.
          */}
          <p className="guia__estado">
            {modelo === null
              ? 'Buscando en el manual, aquí mismo. Sin conexión también funciona.'
              : urlModelo === OLLAMA_POR_DEFECTO
                ? `Respondiendo con ${modelo}, en este equipo.`
                : `Respondiendo con ${modelo}, en un equipo remoto.`}
            {!editandoUrl && (
              <button
                type="button"
                className="boton boton--enlace guia__cambiar-modelo"
                onClick={() => setEditandoUrl(true)}
              >
                {urlModelo === OLLAMA_POR_DEFECTO ? 'Usar un modelo remoto' : 'Cambiar'}
              </button>
            )}
          </p>
          {editandoUrl && (
            // Para cuando el modelo no está en esta máquina sino en la de quien
            // sí lo tiene instalado, alcanzado con un túnel (`ngrok http 11434`):
            // la URL del túnel cambia cada vez que se reinicia, así que hay que
            // poder pegarla aquí en vez de dejarla fija en el código.
            <form
              className="guia__url-modelo"
              onSubmit={(e) => {
                e.preventDefault();
                const nueva = new FormData(e.currentTarget).get('url');
                const valor = typeof nueva === 'string' ? nueva : '';
                guardarUrlOllama(valor);
                setUrlModelo(urlOllama());
                setEditandoUrl(false);
              }}
            >
              <input
                name="url"
                defaultValue={urlModelo === OLLAMA_POR_DEFECTO ? '' : urlModelo}
                placeholder="https://algo.ngrok-free.app"
              />
              <button type="submit" className="boton">
                Guardar
              </button>
              <button type="button" className="boton" onClick={() => setEditandoUrl(false)}>
                Cancelar
              </button>
            </form>
          )}
          <div className="guia__cerrar">
            {onRecorrido && (
              <button type="button" className="boton guia__recorrido" onClick={onRecorrido}>
                Ver el recorrido
              </button>
            )}
            <button type="button" className="boton" onClick={onCerrar}>
              Cerrar
            </button>
          </div>
        </header>

        <form
          className="guia__entrada"
          onSubmit={(e) => {
            e.preventDefault();
            void consultar(texto);
          }}
        >
          <input
            ref={entradaRef}
            value={texto}
            placeholder="¿cómo exporto el diagrama a Enterprise Architect?"
            onChange={(e) => setTexto(e.target.value)}
          />
          <button
            type="button"
            className={`boton-microfono${escuchando ? ' boton-microfono--activo' : ''}`}
            disabled={!hayDictado}
            title={hayDictado ? 'Preguntar hablando' : motivoSinVoz()}
            aria-label={escuchando ? 'Detener el dictado' : 'Preguntar hablando'}
            aria-pressed={escuchando}
            onClick={alternarMicrofono}
          >
            <Icono nombre="microfono" />
            {escuchando && <span className="boton-microfono__estado">Grabando</span>}
          </button>
          <button type="submit" className="boton boton--primario" disabled={!texto.trim()}>
            Preguntar
          </button>
        </form>

        {/*
          Aquí no bastaba con el rótulo «Grabando» del botón. Una pregunta se
          piensa mientras se dice —«cómo exporto… el diagrama… a Enterprise
          Architect»— y antes cada una de esas pausas enviaba media pregunta. Ya
          no corta, pero eso hay que decirlo: si no, quien lo sufrió una vez
          atropella la frase para llegar antes del corte que ya no existe.
        */}
        {escuchando && (
          <p className="guia__escuchando" role="status">
            Escuchando… Se puede pensar a mitad de la pregunta. Al terminar, pulse el micrófono.
          </p>
        )}

        {!respondido && (
          <div className="guia__ejemplos">
            <p>Por ejemplo:</p>
            <ul>
              {EJEMPLOS.map((ejemplo) => (
                <li key={ejemplo}>
                  <button
                    type="button"
                    className="guia__ejemplo"
                    onClick={() => {
                      setTexto(ejemplo);
                      void consultar(ejemplo);
                    }}
                  >
                    {ejemplo}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {estado.error && <p className="guia__error">{estado.error}</p>}

        {(estado.respuesta !== null || estado.pensando) && (
          <div className="guia__respuesta">
            {/* El disco de origen. `aria-hidden` porque no aporta nada leído en
                voz alta: quien usa un lector de pantalla ya sabe de qué región
                viene el texto, y «imagen» a secas solo estorba. */}
            <span className="guia__marca" aria-hidden="true">
              <Icono nombre="altavoz" />
            </span>
            <div>
              <p>{estado.respuesta ?? 'Pensando…'}</p>
              {/*
                El botón se dibuja siempre que haya algo que leer, y es él quien
                dice si puede o no. Antes se escondía cuando faltaba
                `speechSynthesis` —que es justo lo que pasa dentro del WebView de
                Android—, y desde fuera eso era indistinguible de una función que
                nadie había programado: no había nada que pulsar ni nada que leer.
              */}
              {estado.respuesta !== null && !estado.pensando && (
                <div className="guia__acciones">
                  {haySintesis ? (
                    <button
                      type="button"
                      className="boton guia__leer"
                      title={sonando ? 'Callar' : 'Leer la respuesta en voz alta'}
                      onClick={() => (sonando ? parar() : leer(estado.respuesta ?? ''))}
                    >
                      <Icono nombre={sonando ? 'altavoz-mudo' : 'altavoz'} />
                      {sonando ? 'Detener' : 'Escuchar'}
                    </button>
                  ) : (
                    // El motivo va escrito y no en un `title`: esto se lee sobre
                    // todo en el móvil, donde no hay puntero que pueda posarse
                    // encima y un botón gris no explica nada por sí solo.
                    <p className="guia__leer-nota">
                      <Icono nombre="altavoz-mudo" />
                      {motivoSinVoz()}
                    </p>
                  )}
                  {/*
                    Las barras acompañan al botón mientras suena. Se anuncian con
                    `aria-live` porque una respuesta que empieza a sonar sola es
                    justo el cambio de estado que no se ve venir.
                  */}
                  {sonando && (
                    <span className="guia__sonando" role="status">
                      <span aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      Leyendo en voz alta
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {respondido && estado.fuentes.length === 0 && (
          // Es la respuesta honesta y hay que darla como tal: un resultado
          // irrelevante presentado como respuesta es peor que un «no está»,
          // porque parece una respuesta.
          <p className="guia__vacio">
            Sin resultados en el manual. Cabe reformular la consulta o consultar los documentos de{' '}
            <code>docs/</code>.
          </p>
        )}

        {estado.fuentes.length > 0 && (
          <div className="guia__fuentes">
            <h3>{estado.respuesta === null ? 'En el manual' : 'De dónde sale'}</h3>
            {estado.fuentes.map((resultado) => (
              <article key={`${resultado.fragmento.documento}/${resultado.fragmento.ancla}`}>
                <h4>{resultado.fragmento.ruta.join(' › ')}</h4>
                <p>{resumir(resultado.fragmento.texto)}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * El texto sin la sintaxis de Markdown.
 *
 * Se escribió para recortar fragmentos del manual y ahora sirve además para leer
 * en voz alta, que es donde más se nota: un sintetizador dice «asterisco» y
 * deletrea las comillas invertidas, y una respuesta con tres términos en negrita
 * se vuelve incomprensible sin que nadie entienda por qué.
 */
function sinMarkdown(texto: string): string {
  return texto
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[>\s|-]+$/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Los primeros párrafos de una sección, sin la sintaxis de Markdown.
 *
 * Se corta por el final de una frase y no por el número de caracteres: un texto
 * que termina a media palabra parece un fallo de la aplicación, y quien lo lee
 * deja de fiarse del resto.
 */
function resumir(texto: string, maximo = 320): string {
  const plano = sinMarkdown(texto);

  if (plano.length <= maximo) return plano;
  const corte = plano.slice(0, maximo);
  const punto = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('.\n'));
  return punto > maximo / 2 ? corte.slice(0, punto + 1) : `${corte.trimEnd()}…`;
}
