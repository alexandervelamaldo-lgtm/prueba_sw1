import { useCallback, useEffect, useRef, useState } from 'react';
import { describeOperation, interpretCommand, type Aplicar, type ClassDiagram } from '@app/shared';
import { ApiError, api, type Proyecto, type TurnoAsistente } from '../services/api';
import { puntuarPorVocabulario } from '../services/dictado';
import { dictadoDisponible, dictar, hablar, motivoSinVoz, type SesionDictado } from '../services/voz';
import { Icono } from './iconos';
import { type Propuesta, PropuestaOperaciones } from './PropuestaOperaciones';
import { textoDeRespuesta } from './asistente-voz';

/**
 * Modo IA: la conversación con memoria del proyecto (RF-IA-01, RF-IA-04), ahora
 * un panel acoplado más en vez de una vista a pantalla completa.
 *
 * Es la misma IA que la burbuja flotante de `Asistente.tsx` —mismo servidor,
 * mismo motor, misma regla de que nunca escribe sola (decisión D6)— vista
 * como una conversación en vez de una orden suelta. La diferencia la hace el
 * servidor, no este componente: `POST /:proyectoId/asistente` carga y guarda
 * el historial del proyecto en cada llamada, así que el modelo ve los turnos
 * anteriores sin que este componente tenga que reenviarlos.
 *
 * El hilo ya no es privado por persona: es del proyecto entero
 * (`storage/conversaciones.ts`, clave `proyectoId`), y cada turno de usuario
 * llega del servidor firmado con `autorId`/`autorNombre`. Por eso se sondea
 * igual que el tablón (`PanelTablon.tsx`): un compañero puede escribirle a la
 * IA mientras esta vista está abierta, y su turno tiene que aparecer sin
 * recargar.
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

export function ModoIA({ proyecto, diagrama, aplicar, soloLectura, usuario }: Props): JSX.Element {
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [cargando, setCargando] = useState(true);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [escuchando, setEscuchando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dictadoRef = useRef<SesionDictado | null>(null);
  const hayDictado = dictadoDisponible();
  // Qué `creadoEn` ya se pintó, para que el sondeo no duplique un turno que
  // ya llegó por la carga inicial o por una vuelta de sondeo anterior.
  const vistosRef = useRef<Set<string>>(new Set());

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

  const enviar = async (orden: string, porVoz = false): Promise<void> => {
    const limpia = orden.trim();
    if (!limpia) return;

    setError(null);
    setTexto('');
    setTurnos((previos) => [
      ...previos,
      {
        id: idTurno(),
        role: 'user',
        texto: limpia,
        autorId: usuario.id,
        autorNombre: usuario.nombre,
        creadoEn: null,
        propuesta: [],
        motor: null,
        tipo: 'respuesta',
      },
    ]);
    setEnviando(true);

    let motor: string | null = null;
    let propuesta: Propuesta[] = [];
    let explicacion = '';

    try {
      const respuesta = await api.interpretar(proyecto.id, limpia);
      motor = respuesta.motor;
      propuesta = respuesta.propuesta;
      explicacion = textoDeRespuesta(respuesta);
    } catch (fallo) {
      // Mismo criterio que la burbuja flotante: sin servidor se usa la
      // gramática local, y se dice de dónde viene la respuesta. Este turno no
      // queda en el historial del servidor —nunca llegó a verlo—, así que al
      // reabrir la conversación no aparecerá.
      if (fallo instanceof ApiError && (fallo.esDeRed || fallo.status >= 500)) {
        const local = interpretCommand(limpia);
        motor = 'gramática local (sin conexión)';
        propuesta = local.operations.map((operacion) => ({
          operacion,
          descripcion: describeOperation(operacion),
        }));
        explicacion =
          local.operations.length === 0
            ? (local.clarification ??
                'Sin conexión solo entiendo órdenes sencillas: «crea la clase Cliente», «añade el atributo nombre de tipo String a Cliente».')
            : local.explanation;
      } else {
        explicacion = fallo instanceof Error ? fallo.message : 'No se pudo interpretar la orden';
        setError(explicacion);
        setEnviando(false);
        return;
      }
    }

    setEnviando(false);
    setTurnos((previos) => [
      ...previos,
      {
        id: idTurno(),
        role: 'assistant',
        texto: explicacion,
        autorId: null,
        autorNombre: null,
        creadoEn: null,
        propuesta,
        motor,
        tipo: 'respuesta',
      },
    ]);
    // Se habla la respuesta solo si la orden llegó por voz: quien escribió no
    // necesita que el ordenador le lea lo que ya tiene delante.
    if (porVoz) hablar(explicacion);
  };

  const alternarMicrofono = (): void => {
    if (escuchando) {
      dictadoRef.current?.detener();
      return;
    }
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
    <div className="modo-ia">
      <p className="modo-ia__resumen">
        <span className="modo-ia__insignia" aria-hidden="true">
          IA
        </span>{' '}
        Conversación compartida por todo el equipo sobre <code>{proyecto.name}</code>. Cada propuesta
        sigue pidiendo su «Aplicar»: nada se escribe solo.
      </p>

      <div className="modo-ia__transcripcion" role="log">
        {cargando && <p className="modo-ia__vacio">Cargando la conversación…</p>}

        {!cargando && turnos.length === 0 && (
          <p className="modo-ia__vacio">
            Sin mensajes todavía. Puede empezar con algo como «crea la clase Pedido con el atributo
            total de tipo Double».
          </p>
        )}

        {turnos.map((turno) => (
          <div
            key={turno.id}
            className={`modo-ia__turno modo-ia__turno--${turno.role}${
              turno.tipo === 'observacion' ? ' modo-ia__turno--observacion' : ''
            }`}
          >
            {turno.role === 'user' && (
              <p className="modo-ia__autor">
                {turno.autorId === usuario.id ? 'Usted' : turno.autorNombre ?? 'Alguien del equipo'}
              </p>
            )}
            {turno.tipo === 'observacion' && (
              <p className="modo-ia__autor modo-ia__autor--observacion">
                <Icono nombre="revisar" /> Observación de la IA
              </p>
            )}
            <p className="modo-ia__burbuja">{turno.texto}</p>
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
          disabled={soloLectura || enviando}
          placeholder="crea la clase Pedido con el atributo total de tipo Double"
          onChange={(evento) => setTexto(evento.target.value)}
        />
        <button
          type="button"
          className={`boton-microfono${escuchando ? ' boton-microfono--activo' : ''}`}
          disabled={soloLectura || !hayDictado}
          title={hayDictado ? 'Dictar un mensaje' : motivoSinVoz()}
          aria-label={escuchando ? 'Detener el dictado' : 'Dictar un mensaje'}
          aria-pressed={escuchando}
          onClick={alternarMicrofono}
        >
          <Icono nombre="microfono" />
          {escuchando && <span className="boton-microfono__estado">Grabando</span>}
        </button>
        <button type="submit" disabled={soloLectura || enviando || !texto.trim()}>
          {enviando ? '…' : 'Enviar'}
        </button>
      </form>
    </div>
  );
}
