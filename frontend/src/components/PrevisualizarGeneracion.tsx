import { useEffect, useMemo, useState } from 'react';
import { validateDiagram, type Aplicar, type ClassDiagram, type DatabaseTarget } from '@app/shared';
import { api, descargarFlutter, descargarProyecto, type FicheroGenerado, type Proyecto } from '../services/api';
import { ArreglarGeneracion } from './ArreglarGeneracion';
import { Icono } from './iconos';
import {
  ROTULO_CAPA,
  nombreDe,
  porCapas,
  porCarpetas,
  prefijoComun,
  tamaño,
} from './generacion';

/**
 * Ver el backend generado antes de descargarlo. **RF-GEN-13.**
 *
 * El requisito estaba escrito desde el principio —«vista previa del código
 * generado, archivo por archivo, antes de descargarlo»— y era el único de la
 * familia RF-GEN que seguía sin implementar. No es una pantalla que se añade
 * porque quede bien: es una casilla que llevaba meses sin marcar.
 *
 * Hasta ahora «Generar proyecto Spring Boot» bajaba un ZIP a ciegas: si el
 * generador se equivocaba en un nombre de paquete o dejaba una entidad fuera,
 * eso no se sabía hasta descomprimir y abrir un editor. El servidor ya sabía
 * contestar a esto —`/generacion/previsualizacion` devuelve cada fichero con su
 * contenido— y no lo llamaba nadie.
 *
 * Es también lo que hace falta enseñar en una defensa. El enunciado pide un
 * backend de cuatro capas más DTO; el recuento por capas de aquí arriba lo
 * responde en un vistazo y sin salir de la aplicación, y sale de contar los
 * ficheros que se van a escribir, no de una afirmación en una diapositiva.
 *
 * La previsualización no descarga nada y la descarga no vuelve a generar en
 * balde: son dos llamadas distintas al mismo generador, y el ZIP sigue
 * armándose en el servidor como antes.
 *
 * ## Se valida aquí antes de preguntar al servidor
 *
 * Un diagrama que no se puede generar acababa en el `catch` de abajo, con el
 * mensaje del servidor —los seis motivos separados por punto y coma, sin decir
 * en qué clase estaba cada uno— pintado en rojo y nada que hacer con él.
 *
 * Ahora la misma pregunta se contesta antes de salir a la red. `validateDiagram`
 * vive en `shared` desde que se mudó de `generator`, así que el navegador la
 * puede ejecutar; si el diagrama no pasa, no se llama al servidor —la respuesta
 * ya se sabe— y en su lugar se pinta `ArreglarGeneracion`, que enseña qué
 * bloquea y ofrece arreglarlo.
 *
 * Que la validación esté en el `useMemo` sobre el diagrama es lo que hace que
 * la pantalla se resuelva sola: al aplicar los arreglos cambia el diagrama,
 * cambia la validación, y esta ventana pasa de la lista de problemas a la vista
 * previa del proyecto sin que haya que cerrar nada ni volver a pulsar.
 */

interface Props {
  proyecto: Proyecto;
  /**
   * El diagrama del documento Yjs, no el del servidor: es el que tiene delante
   * quien pulsó «Generar», incluidos los cambios que todavía no se han
   * sincronizado.
   */
  diagrama: ClassDiagram;
  aplicar: Aplicar;
  soloLectura: boolean;
  onCerrar: () => void;
}

type Estado =
  | { fase: 'cargando' }
  | { fase: 'error'; mensaje: string }
  | { fase: 'listo'; ficheros: FicheroGenerado[]; avisos: number };

/**
 * Motores que el generador produce de verdad.
 *
 * Los tres tienen plantillas propias (`generateProject` en
 * `generator/src/render/generate.ts`): PostgreSQL con JPA/Flyway, y
 * MongoDB/Cassandra compartiendo el mismo esquema de asociación por id
 * plano, sin joins.
 */
const MOTORES_DISPONIBLES: { valor: DatabaseTarget; etiqueta: string }[] = [
  { valor: 'postgres', etiqueta: 'PostgreSQL' },
  { valor: 'mongodb', etiqueta: 'MongoDB' },
  { valor: 'cassandra', etiqueta: 'Cassandra' },
];

export function PrevisualizarGeneracion({
  proyecto,
  diagrama,
  aplicar,
  soloLectura,
  onCerrar,
}: Props) {
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });
  const [abierto, setAbierto] = useState<string | null>(null);
  const [bajando, setBajando] = useState(false);
  const [bajandoFlutter, setBajandoFlutter] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Arranca con el motor guardado en el diagrama; cambiarlo aquí solo afecta
  // a esta generación (RF-GEN-01), igual que `estrategiaHerencia`, sin tocar
  // `diagrama.meta.motorBD`.
  const [motorBD, setMotorBD] = useState<DatabaseTarget>(diagrama.meta.motorBD);

  const validacion = useMemo(() => validateDiagram(diagrama), [diagrama]);
  const bloqueado = !validacion.ok;

  useEffect(() => {
    // Con errores de validación la respuesta ya se conoce, y es un 400: pedirla
    // gastaría un viaje para enterarse de lo que se acaba de calcular aquí.
    if (bloqueado) return undefined;

    let vivo = true;
    api
      .previsualizarGeneracion(proyecto.id, { motorBD })
      .then((respuesta) => {
        if (!vivo) return;
        setEstado({ fase: 'listo', ficheros: respuesta.ficheros, avisos: respuesta.avisos.length });
        /*
          Se abre el primero por defecto. Un panel de código vacío junto a una
          lista de cuarenta ficheros obliga a adivinar que hay que pulsar uno;
          con uno abierto, la interacción queda enseñada sin escribirla.
        */
        setAbierto(respuesta.ficheros[0]?.ruta ?? null);
      })
      .catch((error: unknown) => {
        if (!vivo) return;
        setEstado({
          fase: 'error',
          mensaje:
            error instanceof Error ? error.message : 'No se pudo previsualizar la generación',
        });
      });
    return () => {
      vivo = false;
    };
  }, [proyecto.id, bloqueado, motorBD]);

  const ficheros = estado.fase === 'listo' ? estado.ficheros : [];
  const capas = useMemo(() => porCapas(ficheros), [ficheros]);
  const carpetas = useMemo(() => porCarpetas(ficheros), [ficheros]);
  const prefijo = useMemo(() => prefijoComun(ficheros.map((f) => f.ruta)), [ficheros]);
  const activo = ficheros.find((f) => f.ruta === abierto) ?? null;
  const totalBytes = ficheros.reduce((suma, f) => suma + f.bytes, 0);

  const bajarFlutter = async (): Promise<void> => {
    setBajandoFlutter(true);
    try {
      const { donde } = await descargarFlutter(proyecto.id, proyecto.name, { motorBD });
      const ruta = donde ? ` Guardado en ${donde}.` : '';
      setAviso(`Frontend Flutter descargado.${ruta}`);
    } catch (error) {
      setAviso(error instanceof Error ? error.message : 'No se pudo generar el frontend Flutter');
    } finally {
      setBajandoFlutter(false);
    }
  };

  const bajar = async (): Promise<void> => {
    setBajando(true);
    try {
      const { avisos, donde } = await descargarProyecto(proyecto.id, proyecto.name, { motorBD });
      // `donde` viene vacío en el navegador, que guarda en su carpeta de
      // descargas y no lo cuenta. En el móvil el ZIP ha pasado por el diálogo
      // de compartir del sistema, y ahí sí hace falta decir la ruta: si se ha
      // mandado por WhatsApp no queda rastro visible en el teléfono y luego no
      // hay manera de encontrarlo.
      const ruta = donde ? ` Guardado en ${donde}.` : '';
      setAviso(
        avisos > 0
          ? `Proyecto descargado con ${String(avisos)} aviso${avisos === 1 ? '' : 's'}.${ruta}`
          : `Proyecto descargado.${ruta}`,
      );
    } catch (error) {
      setAviso(error instanceof Error ? error.message : 'No se pudo generar el proyecto');
    } finally {
      setBajando(false);
    }
  };

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={bloqueado ? 'El diagrama no se puede generar todavía' : 'Proyecto generado'}
    >
      <div className="modal__caja generado">
        <header className="generado__cabecera">
          <div>
            <h2>{bloqueado ? 'Todavía no se puede generar' : 'Proyecto generado'}</h2>
            <p className="generado__resumen">
              {bloqueado
                ? 'El diagrama no llega a compilar como backend.'
                : estado.fase === 'listo'
                  ? `${String(ficheros.length)} ficheros · ${tamaño(totalBytes)}`
                  : 'Preparando…'}
            </p>
          </div>
          <div className="generado__acciones">
            {/*
              El botón de descarga desaparece mientras está bloqueado en vez de
              salir deshabilitado: deshabilitado invita a pulsarlo para
              averiguar por qué, y el porqué ya está escrito debajo con más
              detalle del que cabe en un `title`.
            */}
            {!bloqueado && (
              <>
                <label className="campo campo--motor-bd">
                  <span>Motor de base de datos</span>
                  <select
                    value={motorBD}
                    disabled={bajando || bajandoFlutter}
                    onChange={(e) => setMotorBD(e.target.value as DatabaseTarget)}
                  >
                    {MOTORES_DISPONIBLES.map((motor) => (
                      <option key={motor.valor} value={motor.valor}>
                        {motor.etiqueta}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="boton boton--primario"
                  disabled={estado.fase !== 'listo' || bajando}
                  onClick={() => void bajar()}
                >
                  {bajando ? 'Descargando…' : 'Descargar ZIP'}
                </button>
                <button
                  type="button"
                  className="boton boton--discreto"
                  disabled={estado.fase !== 'listo' || bajandoFlutter}
                  onClick={() => void bajarFlutter()}
                  title="Genera un proyecto Flutter con pantallas CRUD y dictado offline (Whisper)"
                >
                  {bajandoFlutter ? 'Generando…' : '📱 Frontend Flutter'}
                </button>
              </>
            )}
            <button
              type="button"
              className="boton boton--icono"
              aria-label="Cerrar"
              onClick={onCerrar}
            >
              <Icono nombre="cerrar" />
            </button>
          </div>
        </header>

        {bloqueado && (
          <ArreglarGeneracion
            diagrama={diagrama}
            validacion={validacion}
            aplicar={aplicar}
            soloLectura={soloLectura}
          />
        )}

        {!bloqueado && estado.fase === 'cargando' && (
          <p className="panel__vacio">Generando la vista previa…</p>
        )}

        {estado.fase === 'error' && <p className="panel__error">{estado.mensaje}</p>}

        {estado.fase === 'listo' && (
          <>
            {/*
              El aviso de validación no impide generar —el servidor genera con
              avisos— pero tiene que verse antes de descargar, no después.
            */}
            {estado.avisos > 0 && (
              <p className="generado__avisos">
                <Icono nombre="alerta" /> La validación deja {estado.avisos} aviso
                {estado.avisos === 1 ? '' : 's'}. El proyecto se genera igualmente; los avisos no
                son errores.
              </p>
            )}

            {/*
              El reparto por capas: la respuesta a «¿están las cuatro capas y el
              DTO?» sin descomprimir nada. Se cuentan los ficheros que se van a
              escribir, no se afirma nada de antemano.
            */}
            <ul className="generado__capas">
              {capas.map((recuento) => (
                <li key={recuento.capa}>
                  <span className="generado__capa-nombre">{ROTULO_CAPA[recuento.capa]}</span>
                  <span className="generado__capa-cuenta">{recuento.ficheros}</span>
                </li>
              ))}
            </ul>

            {prefijo !== '' && (
              <p className="generado__prefijo">
                Todas las rutas cuelgan de <code>{prefijo}</code>
              </p>
            )}

            <div className="generado__cuerpo">
              <nav className="generado__arbol" aria-label="Ficheros generados">
                {carpetas.map((carpeta) => (
                  <div key={carpeta.carpeta} className="generado__carpeta">
                    <p className="generado__carpeta-nombre">
                      {carpeta.carpeta === '' ? 'raíz' : carpeta.carpeta}
                    </p>
                    {carpeta.ficheros.map((fichero) => (
                      <button
                        key={fichero.ruta}
                        type="button"
                        className={`generado__fichero${
                          fichero.ruta === abierto ? ' generado__fichero--activo' : ''
                        }`}
                        aria-current={fichero.ruta === abierto}
                        onClick={() => setAbierto(fichero.ruta)}
                      >
                        <span className="generado__fichero-nombre">{nombreDe(fichero.ruta)}</span>
                        <span className="generado__fichero-tamano">{tamaño(fichero.bytes)}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </nav>

              {/*
                El código va en un `<pre>` sin coloreado. Un resaltador de
                sintaxis para Java, XML, SQL y properties son cuatro gramáticas
                y una dependencia nueva para que un fichero que se va a leer una
                vez salga en colores; el contenido se lee igual en monoespaciada.
              */}
              <div className="generado__codigo">
                {activo ? (
                  <>
                    <p className="generado__codigo-ruta">{activo.ruta}</p>
                    <pre>
                      <code>
                        {activo.contenido.split('\n').map((linea, num) => (
                          <span key={num} className="generado__linea">
                            <span className="generado__linea-num">{num + 1}</span>
                            <span className="generado__linea-texto">{linea}</span>
                          </span>
                        ))}
                      </code>
                    </pre>
                  </>
                ) : (
                  <p className="panel__vacio">Elija un fichero de la lista.</p>
                )}
              </div>
            </div>
          </>
        )}

        {aviso !== null && <p className="generado__nota">{aviso}</p>}
      </div>
    </div>
  );
}
