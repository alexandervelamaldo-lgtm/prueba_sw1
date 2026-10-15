import { useCallback, useEffect, useRef, useState } from 'react';
import { type Aplicar, describeOperation, interpretCommand, type ClassDiagram } from '@app/shared';
import { ApiError, api } from '../services/api';
import { puntuarPorVocabulario } from '../services/dictado';
import { dictadoDisponible, dictar, hablar, motivoSinVoz, type SesionDictado } from '../services/voz';
import { decidirAccionVoz } from './asistente-voz';
import { Icono } from './iconos';
import { type Propuesta, PropuestaOperaciones } from './PropuestaOperaciones';

/**
 * Asistente por voz y texto (RF-IA-01, RF-IA-04).
 *
 * Nunca escribe en el diagrama sin que alguien lo acepte (decisión D6). Esa
 * separación es lo que hace que un modelo equivocado sea un incordio y no una
 * pérdida de trabajo, y es también lo que permite que la vía offline y la del
 * servidor sean intercambiables: las dos producen la misma lista de
 * operaciones.
 *
 * Quién acepta cambia según el canal: lo escrito a mano siempre para en una
 * propuesta con botón «Aplicar», porque quien teclea ya está mirando la
 * pantalla y revisar no le cuesta nada más. Lo dictado que **no** es
 * destructivo se acepta solo con haberlo dicho —parar a tocar la pantalla
 * después de hablar deshace la mitad de la ventaja de haber usado la voz— y
 * el asistente contesta hablado, «Hecho: …», en vez de esperar un clic. D6 no
 * se toca: sobre lo destructivo la voz vuelve a exigir el mismo botón que ve
 * quien escribe, solo que además lo anuncia en voz para que se sepa que hay
 * algo pendiente de confirmar sin tener que mirar la pantalla.
 *
 * Se intenta primero el servidor, que puede tener un modelo de lenguaje
 * detrás, y se recurre a la gramática local si no contesta. El orden importa:
 * al revés, la gramática —que solo entiende un repertorio cerrado— se comería
 * las órdenes que el modelo sí sabría interpretar.
 */

export interface AsistenteProps {
  proyectoId: string;
  soloLectura: boolean;
  /** Se necesita para calcular qué se pierde antes de confirmar un borrado. */
  diagrama: ClassDiagram;
  aplicar: Aplicar;
  /**
   * Empezar a escuchar nada más aparecer.
   *
   * Lo usa el móvil, donde esto no se abre desde un panel que ya estaba en
   * pantalla sino desde un botón de micrófono: quien lo pulsa ya ha dicho que
   * quiere dictar, y hacerle buscar otro micrófono dentro del panel que acaba de
   * abrir con un micrófono es pedirle el mismo gesto dos veces.
   *
   * En el escritorio no se usa: allí el asistente está siempre visible, y un
   * panel que se pone a escuchar solo por estar en pantalla sería un micrófono
   * abierto que nadie pidió.
   */
  dictarAlAbrir?: boolean;
  /**
   * `'panel'` (por defecto): la franja de siempre, en flujo normal — la usa
   * `PantallaMovil`, que ya decide desde fuera cuándo montarla (su propio
   * cajón).
   *
   * `'flotante'`: burbuja fija en la esquina que despliega el mismo contenido
   * en una tarjeta. La usa `EditorDiagrama`, donde antes esto era una barra de
   * ancho completo siempre presente: en una pantalla ancha era una franja vacía
   * la mayor parte del tiempo, y tapaba la esquina que también quiere el botón
   * de ayuda. El requisito de que el asistente esté «siempre disponible»
   * (RF-IA-01/04) lo sigue cumpliendo: la burbuja no se cierra sola ni se
   * esconde con el diagrama, solo empieza plegada.
   */
  modo?: 'panel' | 'flotante';
}

export function Asistente({
  proyectoId,
  soloLectura,
  diagrama,
  aplicar,
  dictarAlAbrir = false,
  modo = 'panel',
}: AsistenteProps): JSX.Element {
  const [texto, setTexto] = useState('');
  // Solo lo usa el modo flotante, pero se declara aquí y no dentro de un
  // `if` para que el orden de hooks no dependa de una prop.
  const [abierto, setAbierto] = useState(false);
  const [propuestas, setPropuestas] = useState<Propuesta[]>([]);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [origen, setOrigen] = useState<string | null>(null);
  const [pensando, setPensando] = useState(false);
  const [escuchando, setEscuchando] = useState(false);
  const dictadoRef = useRef<SesionDictado | null>(null);

  // Se pregunta una vez por render y no dos veces dentro del JSX: son la misma
  // respuesta y separarlas invita a que el botón y su explicación se
  // contradigan el día que una de las dos condiciones cambie.
  const hayDictado = dictadoDisponible();

  const interpretar = useCallback(
    async (orden: string, porVoz = false): Promise<void> => {
      const limpia = orden.trim();
      if (!limpia) return;

      setPensando(true);
      setPropuestas([]);
      setMensaje(null);

      let motor: string | null = null;
      let propuesta: Propuesta[] = [];
      let explicacion: string | null = null;

      try {
        const respuesta = await api.interpretar(proyectoId, limpia);
        motor = respuesta.motor;
        propuesta = respuesta.propuesta;
        explicacion = respuesta.aclaracion ?? respuesta.explicacion ?? null;
        if (respuesta.propuesta.length === 0 && !respuesta.aclaracion) {
          explicacion = 'Orden no reconocida. Cabe reformularla con otras palabras.';
        }
      } catch (error) {
        // Sin servidor se usa la gramática que viaja en el propio paquete. No es
        // una degradación silenciosa: se dice de dónde viene la propuesta, para
        // que el usuario sepa por qué de pronto solo entiende frases sencillas.
        if (error instanceof ApiError && (error.esDeRed || error.status >= 500)) {
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
          explicacion = error instanceof Error ? error.message : 'No se pudo interpretar la orden';
        }
      } finally {
        setPensando(false);
      }

      setOrigen(motor);

      if (propuesta.length === 0) {
        setPropuestas([]);
        setMensaje(explicacion);
        // Sin esto, dictar una orden que no se entendió deja el micrófono
        // callado y solo el texto en pantalla lo dice: quien tenía las manos
        // ocupadas —la razón de dictar— no se entera de que hay que repetirlo.
        if (porVoz) hablar(explicacion ?? 'No he entendido la orden.');
        return;
      }

      if (!porVoz) {
        setPropuestas(propuesta);
        setMensaje(explicacion);
        return;
      }

      // `decidirAccionVoz` (en `asistente-voz.ts`) es la que de verdad decide
      // entre las dos ramas de D6: aquí solo se ejecutan sus efectos —hablar,
      // aplicar, actualizar el estado— que es lo que no se puede probar sin
      // montar el componente.
      const accion = decidirAccionVoz(diagrama, propuesta);

      if (accion.tipo === 'confirmar') {
        setPropuestas(propuesta);
        setMensaje(explicacion);
        hablar(accion.anuncio);
        return;
      }

      // Lo dictado y no destructivo se acepta con haberlo dicho: pedir además
      // un toque en la pantalla es exactamente lo que se quería evitar al
      // dictar. `Ctrl+Z` sigue siendo la manera de deshacerlo si la
      // transcripción salió mal.
      const resultado = aplicar(
        propuesta.map((p) => p.operacion),
        { origen: 'asistente', ...(motor ? { propuestoPor: motor } : {}) },
      );
      if (!resultado.ok) {
        setPropuestas(propuesta);
        setMensaje(resultado.error);
        hablar(resultado.error);
        return;
      }
      setTexto('');
      // Lo que se ve y lo que se oye no tienen por qué decir lo mismo: en
      // pantalla vale la pena repasar qué se hizo, pero decirlo en voz suena a
      // que la aplicación lee su propio registro de cambios en vez de
      // contestar a quien le habló (ver el comentario de `CONFIRMACION_HABLADA`
      // en `asistente-voz.ts`).
      setMensaje(accion.detalle);
      hablar(accion.anuncio);
    },
    [proyectoId, aplicar, diagrama],
  );

  /**
   * De lo que el micrófono creyó oír, qué se parece más a una orden.
   *
   * El motor de voz devuelve varias hipótesis de la misma frase ordenadas por
   * parecido acústico, y «crea la plaza pedido» y «crea la clase pedido» suenan
   * casi igual para él. Aquí hay algo que él no tiene: una gramática que puede
   * intentar interpretar cada una. Que una hipótesis se convierta en operaciones
   * es la mejor prueba posible de que es la que se dijo, así que pesa mucho más
   * que el vocabulario suelto, que es lo único que queda cuando ninguna encaja
   * —el caso de las órdenes que solo entiende el modelo del servidor—.
   *
   * Se interpreta para elegir y se tira el resultado: la propuesta que se enseña
   * sale del camino normal, que empieza por el servidor. Hacerlo aquí sería
   * colarse por delante de él con la gramática, justo lo que el orden de
   * `interpretar` evita.
   */
  const puntuarOrden = useCallback((oida: string): number => {
    const local = interpretCommand(oida);
    if (local.operations.length > 0) return 10 + local.confidence;
    return puntuarPorVocabulario(oida);
  }, []);

  const alternarMicrofono = useCallback((): void => {
    if (escuchando) {
      dictadoRef.current?.detener();
      return;
    }
    setMensaje(null);
    setEscuchando(true);
    dictadoRef.current = dictar({
      puntuar: puntuarOrden,
      onParcial: (parcial) => setTexto(parcial),
      onFinal: (final) => {
        setTexto(final);
        // El `true` es lo que distingue «orden dictada» de «orden escrita» y
        // por tanto lo único que decide si se aplica sola o espera un clic.
        void interpretar(final, true);
      },
      onError: (error) => {
        setMensaje(error);
        setEscuchando(false);
      },
      // Se sigue escuchando: esto cuenta por dónde va el audio, no que haya
      // fallado algo.
      onAviso: (texto) => setMensaje(texto),
      onFin: () => setEscuchando(false),
    });
    if (!dictadoRef.current) setEscuchando(false);
  }, [escuchando, interpretar, puntuarOrden]);

  /*
    Arrancar escuchando, si quien nos puso aquí lo pidió.

    El pestillo es lo que impide que un repintado vuelva a abrir el micrófono
    después de que el usuario lo haya cerrado: `alternarMicrofono` cambia con
    cada render que cambie `interpretar`, y sin el pestillo este efecto se
    volvería a disparar en mitad de la sesión.

    No se hace si no se puede escribir: sería abrir el micrófono para acabar en
    una propuesta que no se puede aplicar.
  */
  const yaArrancado = useRef(false);
  useEffect(() => {
    if (!dictarAlAbrir || yaArrancado.current || soloLectura || !hayDictado) return;
    yaArrancado.current = true;
    alternarMicrofono();
  }, [dictarAlAbrir, soloLectura, hayDictado, alternarMicrofono]);

  const contenido = (
    <>
      <form
        className="asistente__entrada"
        onSubmit={(e) => {
          e.preventDefault();
          void interpretar(texto);
        }}
      >
        <input
          value={texto}
          disabled={soloLectura}
          placeholder="crea la clase Pedido con el atributo total de tipo Double"
          onChange={(e) => setTexto(e.target.value)}
        />
        <button
          type="button"
          className={`boton-microfono${escuchando ? ' boton-microfono--activo' : ''}`}
          disabled={soloLectura || !hayDictado}
          title={hayDictado ? 'Dictar una orden' : motivoSinVoz()}
          aria-label={escuchando ? 'Detener el dictado' : 'Dictar una orden'}
          aria-pressed={escuchando}
          onClick={alternarMicrofono}
        >
          {/* El icono no cambia al grabar: cambia el rótulo. Un micrófono que se
              convierte en otro dibujo obliga a recordar cuál de los dos significa
              «grabando»; la palabra no hay que recordarla. */}
          <Icono nombre="microfono" />
          {escuchando && <span className="boton-microfono__estado">Grabando</span>}
        </button>
        <button type="submit" disabled={soloLectura || pensando || !texto.trim()}>
          {pensando ? '…' : 'Interpretar'}
        </button>
      </form>

      {escuchando && (
        <div className="asistente__escuchando" role="status">
          <span className="asistente__onda">
            <span className="asistente__onda-barra" />
            <span className="asistente__onda-barra" />
            <span className="asistente__onda-barra" />
            <span className="asistente__onda-barra" />
          </span>
          {/* Se dice que las pausas no cortan, porque antes sí lo hacían y quien
              ya se llevó ese chasco habla deprisa y atropellado para llegar antes
              del corte. Y se dice cómo terminar: con el dictado continuo, el
              botón es lo que cierra la frase. */}
          <span className="asistente__escuchando-texto">
            Escuchando… Se puede pensar a mitad de la frase. Al terminar, pulse el micrófono.
          </span>
        </div>
      )}

      {mensaje && <p className="asistente__mensaje">{mensaje}</p>}

      <PropuestaOperaciones
        propuestas={propuestas}
        diagrama={diagrama}
        origen={origen}
        aplicar={aplicar}
        onAplicar={(resultado) => {
          if (resultado.ok) {
            setPropuestas([]);
            setTexto('');
            setMensaje('Aplicado.');
          } else {
            setMensaje(resultado.error);
          }
        }}
        onDescartar={() => setPropuestas([])}
      />
    </>
  );

  if (modo === 'panel') {
    return <section className="asistente">{contenido}</section>;
  }

  // Hay algo que contar y el panel está cerrado: el punto en la burbuja es lo
  // único que distingue «nada nuevo» de «hay una propuesta o un mensaje
  // esperando», sin obligar a abrir el panel solo para comprobarlo.
  const hayAvisoPendiente = !abierto && (mensaje !== null || propuestas.length > 0);

  return (
    <>
      <button
        type="button"
        className={`asistente-flotante__burbuja${
          hayAvisoPendiente ? ' asistente-flotante__burbuja--aviso' : ''
        }`}
        onClick={() => setAbierto((valor) => !valor)}
        aria-expanded={abierto}
        aria-label={abierto ? 'Cerrar el asistente' : 'Abrir el asistente'}
        title="Asistente: escriba o dicte una orden"
      >
        <Icono nombre="mensajes" />
      </button>

      {abierto && (
        <section className="asistente asistente-flotante__panel">{contenido}</section>
      )}
    </>
  );
}
