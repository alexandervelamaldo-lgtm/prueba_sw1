import { useCallback, useEffect, useRef, useState } from 'react';
import { describeOperation, interpretCommand, type Aplicar, type ClassDiagram } from '@app/shared';
import { ApiError, api, type Proyecto, type TurnoAsistente } from '../services/api';
import { puntuarPorVocabulario } from '../services/dictado';
import {
  callar,
  dictadoDisponible,
  dictar,
  hablar,
  motivoSinVoz,
  prepararVozDelServidor,
  type SesionDictado,
} from '../services/voz';
import { Icono } from './iconos';
import { type Propuesta, PropuestaOperaciones } from './PropuestaOperaciones';
import { crearCursorIA, nodoDeClase, prefiereMenosMovimiento, resaltarClase } from './cursor-ia';
import {
  avisosDeConflicto,
  clasesPorNombre,
  crearEjecutorEnCola,
  marcasDeBorrado,
  type MarcasDeBorrado,
} from './ia-ejecucion';
import { crearColaDeVoz } from './cola-voz';
import { textoDeBienvenida } from './bienvenida-ia';
import { crearManejadorDeStream, debeRepasar, textoParaCompartir, type EstadoRespuesta } from './respuesta-en-stream';
import type { GrupoDeshacer } from '../hooks/deshacer-agrupado';

/** Pausa entre dos pasos de la IA, para que se vea cada uno. */
const PAUSA_ENTRE_PASOS_MS = 350;
const CLAVE_AUTO_APLICAR = 'modo-ia:auto-aplicar';
/** Lo que se le pide a la IA cuando quiso repasar lo hecho (`debeRepasar`). */
const PETICION_DE_REPASO =
  'Repasa los cambios que acabas de hacer con el diagrama actual: si falta algo de lo que te pedí o hay un error, corrígelo; si está bien, dilo en una frase. No pidas otro repaso.';
/** Lo que se espera antes del repaso, para que el servidor ya tenga el diagrama aplicado. */
const ESPERA_ANTES_DE_REPASAR_MS = 1200;

/** Preferencia de este navegador; si no se puede leer, el valor por defecto (encendido). */
function leerAutoAplicar(): boolean {
  try {
    return localStorage.getItem(CLAVE_AUTO_APLICAR) !== 'no';
  } catch {
    return true;
  }
}

function guardarAutoAplicar(valor: boolean): void {
  try {
    localStorage.setItem(CLAVE_AUTO_APLICAR, valor ? 'si' : 'no');
  } catch {
    // Sin almacenamiento solo se pierde recordar la preferencia.
  }
}

/**
 * Modo IA: la conversación con memoria del proyecto (RF-IA-01, RF-IA-04), ahora
 * un panel acoplado más en vez de una vista a pantalla completa.
 *
 * Es la misma IA que la burbuja flotante de `Asistente.tsx` —mismo servidor,
 * mismo motor— vista como una conversación en vez de una orden suelta. Aquí,
 * a diferencia de la burbuja, la IA aplica sola lo que no borra nada, con un
 * cursor que recorre los botones (`ia-ejecucion.ts`); lo que borra algo sigue
 * pidiendo «Aplicar», como en la decisión D6. La diferencia la hace el
 * servidor, no este componente: `POST /:proyectoId/asistente` carga y guarda
 * el historial del proyecto en cada llamada, así que el modelo ve los turnos
 * anteriores sin que este componente tenga que reenviarlos.
 *
 * El hilo es privado de cada integrante (`storage/conversaciones.ts`, clave
 * `(proyectoId, usuario)`): los demás colaboradores no lo ven. Aun así se
 * sondea igual que el tablón (`PanelTablon.tsx`), porque la IA puede dejar un
 * comentario espontáneo en este hilo (`ai/vigilancia.ts`) mientras la vista
 * está abierta, y tiene que aparecer sin recargar.
 *
 * Los turnos cargados del historial no traen propuesta: lo único que se
 * guardó de ellos es el texto, no las operaciones. Quien vuelve a abrir esta
 * vista ve lo que se dijo, no una tarjeta de «Aplicar» para un cambio que ya
 * se aceptó o se descartó en otra sesión —reaparecer lo invitaría a aplicarse
 * dos veces contra un diagrama que puede haber cambiado desde entonces—.
 */

interface Props {
  proyecto: Proyecto;
  diagrama: ClassDiagram;
  aplicar: Aplicar;
  soloLectura: boolean;
  usuario: { id: string; nombre: string };
  /** Centra la cámara del lienzo en esas clases (`EditorDiagrama`). */
  centrar?: (ids: string[]) => void;
  /** Abre un grupo de deshacer; ver `hooks/deshacer-agrupado.ts`. */
  agruparDeshacer?: () => GrupoDeshacer;
  /** La clase seleccionada en el lienzo: la IA entiende «esta clase». */
  seleccion?: string | null;
  /** Lo que se perdería con los borrados propuestos aún sin aplicar, para marcarlo en el lienzo. */
  onVistaPrevia?: (marcas: MarcasDeBorrado | null) => void;
  /** Quién más está en el proyecto y qué clase tiene seleccionada (presencia de Yjs). */
  participantes?: { nombre: string; seleccion: string | null }[];
  /** Se pulsó el avatar de la IA: hay que dar la bienvenida (ver `bienvenida-ia.ts`). */
  saludoPendiente?: boolean;
  /** Avisa de que ya se dio la bienvenida, para no repetirla al volver a abrir el panel. */
  onSaludado?: () => void;
  /** Si la IA está trabajando, para que el avatar «piense». */
  onEstado?: (estado: 'reposo' | 'pensando') => void;
}

interface Turno {
  id: string;
  role: 'user' | 'assistant';
  texto: string;
  autorId: string | null;
  autorNombre: string | null;
  /** `null` mientras el turno es un envío propio en vuelo: aún no tiene marca del servidor con la que cruzarlo al sondear. */
  creadoEn: string | null;
  propuesta: Propuesta[];
  motor: string | null;
  /** Ver `TurnoAsistente.tipo`: una `'observacion'` es la IA hablando sin que nadie le haya preguntado. */
  tipo: 'respuesta' | 'observacion';
  /** Lo que la IA ya aplicó sola en este turno, descrito; ver `ia-ejecucion.ts`. */
  aplicadas?: string[];
  /** La IA todavía está escribiendo esta respuesta. */
  escribiendo?: boolean;
  /** Ya se publicó en el tablón del proyecto. */
  compartido?: boolean;
  /** Lo pidió el propio Modo IA (un repaso), no la persona. */
  automatico?: boolean;
  /** Avisos de clases que la IA tocó mientras otra persona las editaba. */
  conflictos?: string[];
}

let contadorTurno = 0;
function idTurno(): string {
  contadorTurno += 1;
  return `turno-${contadorTurno}`;
}

function deTurnoDelServidor(turno: TurnoAsistente): Turno {
  return {
    id: idTurno(),
    role: turno.role,
    texto: turno.texto,
    autorId: turno.autorId,
    autorNombre: turno.autorNombre,
    creadoEn: turno.creadoEn,
    propuesta: [],
    motor: null,
    tipo: turno.tipo,
  };
}

const INTERVALO_SONDEO_MS = 8000;

export function ModoIA({
  proyecto,
  diagrama,
  aplicar,
  soloLectura,
  usuario,
  centrar,
  agruparDeshacer,
  seleccion,
  onVistaPrevia,
  participantes,
  saludoPendiente,
  onSaludado,
  onEstado,
}: Props): JSX.Element {
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [autoAplicar, setAutoAplicar] = useState(leerAutoAplicar);
  const [ejecutando, setEjecutando] = useState(false);
  // Control de costos: solo se muestra si el servidor tiene un límite diario.
  const [uso, setUso] = useState<{ hoy: number; limite: number | null } | null>(null);
  // Si habla con la voz de ElevenLabs: su plan gratuito pide mencionarla.
  const [vozElevenLabs, setVozElevenLabs] = useState(false);
  useEffect(() => {
    let vigente = true;
    void prepararVozDelServidor().then((activa) => {
      if (vigente) setVozElevenLabs(activa);
    });
    return () => {
      vigente = false;
    };
  }, []);
  // Una orden a la vez, desde que sale hasta que la IA termina de aplicarla: la
  // siguiente espera a que esta termine (o se interrumpa). El estado llegaría
  // tarde para una orden que entra en el mismo instante (por voz); la
  // referencia no.
  const ordenEnCursoRef = useRef<Promise<void> | null>(null);
  // El micrófono pulsado mientras la IA responde: calla, corta y deja de aplicar.
  const interrumpidoRef = useRef(false);
  const colaVozRef = useRef<ReturnType<typeof crearColaDeVoz> | null>(null);
  // Al cerrar el panel, la IA deja de aplicar en el paso siguiente.
  const montadoRef = useRef(true);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // La respuesta en curso, para cortarla si se cierra el panel.
  const abortarRef = useRef<AbortController | null>(null);
  // El diagrama más reciente: una respuesta en streaming dura varios renders.
  const diagramaRef = useRef(diagrama);
  diagramaRef.current = diagrama;
  // Igual que el diagrama: una orden dictada se envía desde un `enviar` de un
  // render anterior, y tiene que llevar la selección de ahora.
  const seleccionRef = useRef(seleccion);
  seleccionRef.current = seleccion;
  const participantesRef = useRef(participantes ?? []);
  participantesRef.current = participantes ?? [];

  // Vista previa fantasma: mientras haya borrados propuestos sin aplicar, el
  // lienzo marca lo que se perdería. Se recalcula con el diagrama, porque lo
  // que se pierde depende de lo que haya ahora.
  // Solo se avisa cuando las marcas cambian: el diagrama cambia a cada paso de
  // un arrastre, y repintar el lienzo entero por eso no tiene sentido.
  const marcasAvisadasRef = useRef('');
  useEffect(() => {
    const pendientes = turnos.flatMap((turno) => turno.propuesta.map((p) => p.operacion));
    const marcas = marcasDeBorrado(diagrama, pendientes);
    const hayAlgo = marcas.clases.length > 0 || marcas.relaciones.length > 0;
    const clave = hayAlgo ? JSON.stringify(marcas) : '';
    if (clave === marcasAvisadasRef.current) return;
    marcasAvisadasRef.current = clave;
    onVistaPrevia?.(hayAlgo ? marcas : null);
  }, [turnos, diagrama, onVistaPrevia]);
  useEffect(() => () => onVistaPrevia?.(null), [onVistaPrevia]);

  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      abortarRef.current?.abort();
    };
  }, []);
  const [cargando, setCargando] = useState(true);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [escuchando, setEscuchando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dictadoRef = useRef<SesionDictado | null>(null);
  const hayDictado = dictadoDisponible();

  // El uso se vuelve a pedir al terminar cada orden (cuando `enviando` vuelve a
  // `false`): es lo que acaba de cambiarlo.
  useEffect(() => {
    if (enviando) return;
    let vigente = true;
    api
      .usoAsistente(proyecto.id)
      .then((datos) => {
        if (vigente) setUso(datos);
      })
      .catch(() => {
        // Sin el dato no se muestra la línea; no es un error que contar.
      });
    return () => {
      vigente = false;
    };
  }, [proyecto.id, enviando]);

  // Qué `creadoEn` ya se pintó, para que el sondeo no duplique un turno que
  // ya llegó por la carga inicial o por una vuelta de sondeo anterior.
  const vistosRef = useRef<Set<string>>(new Set());

  // La bienvenida del avatar: después de cargar el historial, para que quede al
  // final de la conversación. No se guarda en el hilo; solo se pinta y se dice.
  useEffect(() => {
    if (!saludoPendiente || cargando) return;
    const texto = textoDeBienvenida({ nombre: usuario.nombre, proyecto: proyecto.name });
    setTurnos((previos) => [
      ...previos,
      {
        id: idTurno(),
        role: 'assistant',
        texto,
        autorId: null,
        autorNombre: null,
        creadoEn: null,
        propuesta: [],
        motor: null,
        tipo: 'respuesta',
      },
    ]);
    hablar(texto);
    onSaludado?.();
  }, [saludoPendiente, cargando, usuario.nombre, proyecto.name, onSaludado]);

  useEffect(() => {
    onEstado?.(enviando || ejecutando ? 'pensando' : 'reposo');
  }, [enviando, ejecutando, onEstado]);
  useEffect(() => () => onEstado?.('reposo'), [onEstado]);


  const fusionar = useCallback((remotos: TurnoAsistente[]) => {
    setTurnos((previos) => {
      let siguientes = previos;
      for (const remoto of remotos) {
        if (vistosRef.current.has(remoto.creadoEn)) continue;
        vistosRef.current.add(remoto.creadoEn);

        // Un turno propio en vuelo ya está pintado de forma optimista (ver
        // `enviar`): lo que llega del servidor solo le pone fecha, no se
        // añade como si fuera uno nuevo.
        const pendiente = siguientes.find(
          (t) =>
            t.creadoEn === null &&
            t.role === remoto.role &&
            t.autorId === remoto.autorId &&
            t.texto === remoto.texto,
        );
        if (pendiente) {
          siguientes = siguientes.map((t) => (t.id === pendiente.id ? { ...t, creadoEn: remoto.creadoEn } : t));
          continue;
        }
        siguientes = [...siguientes, deTurnoDelServidor(remoto)];
      }
      return siguientes;
    });
  }, []);

  // Se restaura al abrir y no se vuelve a pedir entera mientras la vista esté
  // montada: lo que llega después entra por el sondeo de abajo.
  useEffect(() => {
    let cancelado = false;
    setCargando(true);
    vistosRef.current = new Set();
    setTurnos([]);
    api
      .obtenerHistorialAsistente(proyecto.id)
      .then((respuesta) => {
        if (cancelado) return;
        for (const turno of respuesta.turnos) vistosRef.current.add(turno.creadoEn);
        setTurnos(respuesta.turnos.map(deTurnoDelServidor));
      })
      .catch(() => {
        // Sin historial que recuperar no hay nada que perder: se empieza en
        // blanco, igual que la primera vez que alguien abre el Modo IA.
      })
      .finally(() => {
        if (!cancelado) setCargando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [proyecto.id]);

  // El mismo sondeo que el tablón (`PanelTablon.tsx`): un intervalo fijo y un
  // reintento inmediato al volver a la pestaña, porque esta conversación ya
  // no es solo mía y un compañero puede escribirle a la IA en paralelo.
  useEffect(() => {
    let detenido = false;
    let temporizador: ReturnType<typeof setTimeout> | null = null;

    const sondear = async (): Promise<void> => {
      try {
        const respuesta = await api.obtenerHistorialAsistente(proyecto.id);
        if (!detenido) fusionar(respuesta.turnos);
      } catch {
        // Un sondeo fallido no es un error que mostrar: se reintenta en el
        // siguiente ciclo sin interrumpir a quien está escribiendo.
      }
      if (!detenido) temporizador = setTimeout(sondear, INTERVALO_SONDEO_MS);
    };

    const alCambiarVisibilidad = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (temporizador) clearTimeout(temporizador);
      void sondear();
    };

    temporizador = setTimeout(sondear, INTERVALO_SONDEO_MS);
    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    return () => {
      detenido = true;
      if (temporizador) clearTimeout(temporizador);
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
    };
  }, [proyecto.id, fusionar]);

  const enviar = async (orden: string, porVoz = false, revision = false): Promise<void> => {
    while (ordenEnCursoRef.current) await ordenEnCursoRef.current;
    const enCurso = enviarUnaOrden(orden, porVoz, revision);
    ordenEnCursoRef.current = enCurso;
    try {
      await enCurso;
    } finally {
      if (ordenEnCursoRef.current === enCurso) ordenEnCursoRef.current = null;
    }
  };

  /**
   * Corta la respuesta en curso: la voz se calla al momento, lo que quedaba
   * por decir se descarta, el stream se cierra y el ejecutor no aplica el paso
   * siguiente. Lo ya aplicado se queda (se deshace de una vez, como siempre).
   */
  const interrumpir = (): void => {
    if (!ordenEnCursoRef.current) return;
    interrumpidoRef.current = true;
    colaVozRef.current?.vaciar();
    callar();
    abortarRef.current?.abort();
  };

  /**
   * `revision`: el botón «Revisar mi diagrama». La IA revisa con las pistas del
   * revisor local y propone arreglos, que nunca se aplican solos: son cambios
   * que nadie pidió, así que esperan su «Aplicar».
   */
  const enviarUnaOrden = async (
    orden: string,
    porVoz: boolean,
    revision: boolean,
    esRepaso = false,
  ): Promise<void> => {
    const limpia = orden.trim();
    if (!limpia) return;

    interrumpidoRef.current = false;
    setError(null);
    setTexto('');
    const idRespuesta = idTurno();
    setTurnos((previos) => [
      ...previos,
      {
        id: idTurno(),
        role: 'user',
        texto: esRepaso ? 'Repasando lo que acabo de hacer…' : limpia,
        autorId: usuario.id,
        autorNombre: usuario.nombre,
        creadoEn: null,
        propuesta: [],
        motor: null,
        tipo: 'respuesta',
        automatico: esRepaso,
      },
      {
        id: idRespuesta,
        role: 'assistant',
        texto: '',
        autorId: null,
        autorNombre: null,
        creadoEn: null,
        propuesta: [],
        motor: null,
        tipo: 'respuesta',
        aplicadas: [],
        escribiendo: true,
      },
    ]);
    setEnviando(true);
    setEjecutando(true);

    // La respuesta llega por partes (`api.interpretarEnStream`): el texto se
    // pinta mientras la IA escribe, cada mensaje se dice en cuanto está
    // completo (solo si la orden fue por voz) y cada operación que no borra
    // nada se aplica en cuanto llega, con el cursor. Lo retenido se ofrece con
    // «Aplicar» solo al final, para no confirmar algo a medio escribir.
    let ultimo: EstadoRespuesta | null = null;
    const manejador = crearManejadorDeStream({
      diagrama: () => diagramaRef.current,
      autoAplicar: autoAplicar && !revision,
      soloLectura,
      crearEjecutor: (avisos) =>
        crearEjecutorEnCola(
          {
            aplicar,
            contexto: { origen: 'asistente', propuestoPor: 'Modo IA' },
            centrar: centrar ?? (() => {}),
            resaltar: resaltarClase,
            buscar: (selector) => document.querySelector(selector),
            nodo: nodoDeClase,
            cursor: prefiereMenosMovimiento() ? null : crearCursorIA(panelRef.current),
            pausaMs: PAUSA_ENTRE_PASOS_MS,
            esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            ...(agruparDeshacer ? { agrupar: agruparDeshacer } : {}),
            cancelado: () => !montadoRef.current || interrumpidoRef.current,
          },
          avisos,
        ),
      voz: (colaVozRef.current = porVoz ? crearColaDeVoz(hablar) : null),
      conflictos: (clases) => avisosDeConflicto(diagramaRef.current, clases, participantesRef.current),
      senalar: (nombres) => {
        const ids = clasesPorNombre(diagramaRef.current, nombres);
        if (ids.length === 0) return;
        centrar?.(ids);
        ids.forEach(resaltarClase);
      },
      alCambiar: (estado) => {
        ultimo = estado;
        if (!montadoRef.current) return;
        setTurnos((previos) =>
          previos.map((t) =>
            t.id === idRespuesta
              ? {
                  ...t,
                  texto: estado.texto,
                  propuesta: estado.terminado ? estado.propuesta : [],
                  aplicadas: estado.aplicadas,
                  conflictos: estado.conflictos,
                  motor: estado.motor,
                  escribiendo: !estado.terminado,
                }
              : t,
          ),
        );
      },
    });

    const controlador = new AbortController();
    abortarRef.current = controlador;
    try {
      await api.interpretarEnStream(proyecto.id, limpia, manejador.alEvento, controlador.signal, {
        revision,
        seleccion: seleccionRef.current ?? null,
      });
      if (!(ultimo as EstadoRespuesta | null)?.terminado) {
        manejador.alEvento({ tipo: 'error', mensaje: 'La respuesta se cortó antes de terminar.' });
      }
    } catch (fallo) {
      if (controlador.signal.aborted) {
        // Se cerró el panel o se interrumpió con el micrófono. Al interrumpir,
        // la respuesta se da por terminada con lo que llegó hasta ahí.
        if (interrumpidoRef.current) manejador.alEvento({ tipo: 'error', mensaje: 'Interrumpida.' });
      } else if (ultimo === null && fallo instanceof ApiError && (fallo.esDeRed || fallo.status >= 500)) {
        // Mismo criterio que la burbuja flotante: sin servidor se usa la
        // gramática local, y se dice de dónde viene la respuesta. Este turno no
        // queda en el historial del servidor —nunca llegó a verlo—, así que al
        // reabrir la conversación no aparecerá.
        const local = interpretCommand(limpia);
        manejador.alEvento({
          tipo: 'mensaje',
          texto:
            local.operations.length === 0
              ? (local.clarification ??
                  'Sin conexión solo entiendo órdenes sencillas: «crea la clase Cliente», «añade el atributo nombre de tipo String a Cliente».')
              : local.explanation,
        });
        for (const operacion of local.operations) {
          manejador.alEvento({ tipo: 'operacion', operacion, descripcion: describeOperation(operacion) });
        }
        manejador.alEvento({ tipo: 'fin', motor: 'gramática local (sin conexión)', confianza: local.confidence });
      } else {
        manejador.alEvento({
          tipo: 'error',
          mensaje: fallo instanceof Error ? fallo.message : 'No se pudo interpretar la orden',
        });
      }
    } finally {
      abortarRef.current = null;
      setEnviando(false);
    }

    let resultado: { aplicadas: number; error: string | null } = { aplicadas: 0, error: null };
    try {
      resultado = await manejador.terminar();
    } catch (fallo) {
      resultado = { aplicadas: 0, error: fallo instanceof Error ? fallo.message : 'error inesperado' };
    } finally {
      setEjecutando(false);
    }
    if (!montadoRef.current) return;
    const final = ultimo as EstadoRespuesta | null;
    if (interrumpidoRef.current) return;
    if (final?.error) setError(final.error);
    else if (resultado.error) setError(`La IA se detuvo tras ${resultado.aplicadas} cambio(s): ${resultado.error}`);

    // Un paso más, si la IA lo pidió: repasa con el diagrama ya actualizado.
    if (final && !resultado.error && debeRepasar(final, esRepaso)) {
      // La orden sigue en curso: el campo queda ocupado durante la espera, para
      // que nadie escriba algo que `enviar` descartaría por estar ocupado.
      setEjecutando(true);
      await new Promise((resolve) => setTimeout(resolve, ESPERA_ANTES_DE_REPASAR_MS));
      if (montadoRef.current && !interrumpidoRef.current) {
        await enviarUnaOrden(PETICION_DE_REPASO, porVoz, false, true);
      } else {
        setEjecutando(false);
      }
    }
  };

  /** Publica una respuesta de la IA en el tablón, con la pregunta que la originó. */
  const compartir = async (indice: number): Promise<void> => {
    const turno = turnos[indice];
    if (!turno) return;
    const pregunta = turnos
      .slice(0, indice)
      .reverse()
      .find((t) => t.role === 'user')?.texto;
    try {
      await api.publicarEnTablon(
        proyecto.id,
        textoParaCompartir({
          pregunta: pregunta ?? '(comentario espontáneo de la IA)',
          respuesta: turno.texto,
          aplicadas: turno.aplicadas ?? [],
        }),
      );
      setTurnos((previos) => previos.map((t) => (t.id === turno.id ? { ...t, compartido: true } : t)));
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo compartir en el tablón');
    }
  };

  const cambiarAutoAplicar = (valor: boolean): void => {
    setAutoAplicar(valor);
    guardarAutoAplicar(valor);
  };

  const alternarMicrofono = (): void => {
    if (escuchando) {
      dictadoRef.current?.detener();
      return;
    }
    // Pulsarlo mientras la IA responde o habla la interrumpe, y se escucha la
    // orden nueva, que espera a que la anterior termine de cerrarse.
    interrumpir();
    setError(null);
    setEscuchando(true);
    dictadoRef.current = dictar({
      puntuar: puntuarPorVocabulario,
      onParcial: (parcial) => setTexto(parcial),
      onFinal: (final) => {
        setTexto(final);
        void enviar(final, true);
      },
      onError: (motivo) => {
        setError(motivo);
        setEscuchando(false);
      },
      onAviso: (aviso) => setError(aviso),
      onFin: () => setEscuchando(false),
    });
    if (!dictadoRef.current) setEscuchando(false);
  };

  return (
    <div className="modo-ia" ref={panelRef}>
      <p className="modo-ia__resumen">
        <span className="modo-ia__insignia" aria-hidden="true">
          IA
        </span>{' '}
        Su conversación privada con la IA sobre <code>{proyecto.name}</code>: el resto del equipo no
        la ve.
      </p>
      <label className="modo-ia__auto">
        <input
          type="checkbox"
          checked={autoAplicar}
          disabled={soloLectura}
          onChange={(evento) => cambiarAutoAplicar(evento.target.checked)}
        />{' '}
        La IA aplica sola los cambios. Lo que borra algo sigue pidiendo «Aplicar», y cada respuesta se
        deshace de una vez.
      </label>
      {vozElevenLabs && <p className="modo-ia__uso">Voz de ElevenLabs.</p>}
      {uso?.limite ? (
        <p className="modo-ia__uso">
          Uso de la IA hoy: {uso.hoy.toLocaleString('es')} de {uso.limite.toLocaleString('es')} tokens.
        </p>
      ) : null}
      <button
        type="button"
        className="modo-ia__revisar"
        disabled={soloLectura || enviando || ejecutando}
        onClick={() => void enviar('Revisa mi diagrama', false, true)}
        title="La IA señala lo que mejoraría y propone los arreglos; nada se aplica sin su «Aplicar»."
      >
        <Icono nombre="revisar" /> Revisar mi diagrama
      </button>

      <div className="modo-ia__transcripcion" role="log">
        {cargando && <p className="modo-ia__vacio">Cargando la conversación…</p>}

        {!cargando && turnos.length === 0 && (
          <p className="modo-ia__vacio">
            Sin mensajes todavía. Puede empezar con algo como «crea la clase Pedido con el atributo
            total de tipo Double».
          </p>
        )}

        {turnos.map((turno, indice) => (
          <div
            key={turno.id}
            className={`modo-ia__turno modo-ia__turno--${turno.role}${
              turno.tipo === 'observacion' ? ' modo-ia__turno--observacion' : ''
            }`}
          >
            {turno.role === 'user' && (
              <p className="modo-ia__autor">
                {turno.automatico
                  ? 'Repaso automático'
                  : turno.autorId === usuario.id
                    ? 'Usted'
                    : (turno.autorNombre ?? 'Alguien del equipo')}
              </p>
            )}
            {turno.tipo === 'observacion' && (
              <p className="modo-ia__autor modo-ia__autor--observacion">
                <Icono nombre="revisar" /> Observación de la IA
              </p>
            )}
            {/* Una respuesta que falló sin decir nada no deja una burbuja
                vacía: el error ya se muestra debajo de la conversación. */}
            {(turno.texto || turno.escribiendo) && (
              <p className="modo-ia__burbuja">{turno.texto || '…'}</p>
            )}
            {turno.role === 'assistant' && turno.texto && !turno.escribiendo && (
              <button
                type="button"
                className="modo-ia__compartir"
                disabled={turno.compartido}
                onClick={() => void compartir(indice)}
                title="Publica esta respuesta en el tablón del proyecto para el resto del equipo."
              >
                {turno.compartido ? 'Compartido en el tablón' : 'Compartir en el tablón'}
              </button>
            )}
            {turno.conflictos && turno.conflictos.length > 0 && (
              <ul className="modo-ia__conflictos" role="status">
                {turno.conflictos.map((aviso) => (
                  <li key={aviso}>{aviso}</li>
                ))}
              </ul>
            )}
            {turno.aplicadas && turno.aplicadas.length > 0 && (
              <ul className="modo-ia__aplicadas" aria-label="Cambios que aplicó la IA">
                {turno.aplicadas.map((descripcion, indice) => (
                  <li key={indice}>
                    <Icono nombre="revisar" /> {descripcion}
                  </li>
                ))}
              </ul>
            )}
            {turno.role === 'assistant' && turno.propuesta.length > 0 && (
              <PropuestaOperaciones
                propuestas={turno.propuesta}
                diagrama={diagrama}
                origen={turno.motor}
                aplicar={aplicar}
                onAplicar={(resultado) => {
                  setTurnos((previos) =>
                    previos.map((t) => (t.id === turno.id ? { ...t, propuesta: [] } : t)),
                  );
                  if (!resultado.ok) setError(resultado.error);
                }}
                onDescartar={() =>
                  setTurnos((previos) =>
                    previos.map((t) => (t.id === turno.id ? { ...t, propuesta: [] } : t)),
                  )
                }
              />
            )}
          </div>
        ))}
      </div>

      {error !== null && <p className="panel__error">{error}</p>}

      <form
        className="asistente__entrada modo-ia__entrada"
        onSubmit={(evento) => {
          evento.preventDefault();
          void enviar(texto);
        }}
      >
        <input
          value={texto}
          disabled={soloLectura || enviando || ejecutando}
          placeholder="crea la clase Pedido con el atributo total de tipo Double"
          onChange={(evento) => setTexto(evento.target.value)}
        />
        <button
          type="button"
          className={`boton-microfono${escuchando ? ' boton-microfono--activo' : ''}`}
          disabled={soloLectura || !hayDictado}
          title={
            !hayDictado
              ? motivoSinVoz()
              : ejecutando
                ? 'Interrumpir a la IA y dictar otra orden'
                : 'Dictar un mensaje'
          }
          aria-label={escuchando ? 'Detener el dictado' : 'Dictar un mensaje'}
          aria-pressed={escuchando}
          onClick={alternarMicrofono}
        >
          <Icono nombre="microfono" />
          {escuchando && <span className="boton-microfono__estado">Grabando</span>}
        </button>
        <button type="submit" disabled={soloLectura || enviando || ejecutando || !texto.trim()}>
          {enviando ? '…' : 'Enviar'}
        </button>
      </form>
    </div>
  );
}
