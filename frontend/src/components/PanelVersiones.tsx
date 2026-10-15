import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  diffDiagramas,
  hayDiferencias,
  type CambioDeCampo,
  type CambioDeClase,
  type CambioDeModulo,
  type CambioDeRelacion,
  type ClassDiagram,
  type DiferenciaDiagramas,
} from '@app/shared';
import { ApiError, api, type Rol, type VersionResumen } from '../services/api';
import { Icono } from './iconos';

/**
 * El panel de puntos de control (checkpoints) del proyecto.
 *
 * Crear una versión es barato —un mensaje y listo— porque lo caro, decidir
 * qué cambió, se deja para cuando alguien lo pide: comparar una versión
 * guardada contra el diagrama en curso es `diffDiagramas`, ya probado sin
 * navegador en `shared/model/diff.test.ts`. Este fichero solo pide la lista,
 * pide el diagrama de la versión elegida y pinta lo que esa función devuelve.
 */

export interface PanelVersionesProps {
  proyectoId: string;
  usuarioId: string;
  rol: Rol;
  diagrama: ClassDiagram;
}

const MAXIMO_MENSAJE = 200;

function fecha(iso: string): string {
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return 'fecha desconocida';
  return momento.toLocaleString('es', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* --------------------------------------------------------------------------
   Pintar una diferencia
   -------------------------------------------------------------------------- */

function Campos({ campos }: { campos: CambioDeCampo[] }): JSX.Element | null {
  if (campos.length === 0) return null;
  return (
    <ul className="versiones__campos">
      {campos.map((campo) => (
        <li key={campo.campo}>
          <strong>{campo.campo}:</strong> {campo.antes || '(vacío)'} → {campo.despues || '(vacío)'}
        </li>
      ))}
    </ul>
  );
}

function Listado({ titulo, items }: { titulo: string; items: string[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <p className="versiones__sublista">
      {titulo}
      <ul>
        {items.map((item, i) => (
          <li key={`${titulo}-${String(i)}`}>{item}</li>
        ))}
      </ul>
    </p>
  );
}

function CambioClase({ cambio }: { cambio: CambioDeClase }): JSX.Element {
  return (
    <li className={`versiones__cambio versiones__cambio--${cambio.tipo}`}>
      <p className="versiones__titulo-cambio">
        {cambio.nombre} <span className="versiones__etiqueta-tipo">({cambio.tipo})</span>
      </p>
      <Campos campos={cambio.campos} />
      <Listado titulo="Atributos añadidos" items={cambio.atributosAñadidos} />
      <Listado titulo="Atributos eliminados" items={cambio.atributosEliminados} />
      <Campos campos={cambio.atributosModificados} />
      <Listado titulo="Métodos añadidos" items={cambio.metodosAñadidos} />
      <Listado titulo="Métodos eliminados" items={cambio.metodosEliminados} />
      <Campos campos={cambio.metodosModificados} />
      <Listado titulo="Literales añadidos" items={cambio.literalesAñadidos} />
      <Listado titulo="Literales eliminados" items={cambio.literalesEliminados} />
    </li>
  );
}

function CambioRelacion({ cambio }: { cambio: CambioDeRelacion }): JSX.Element {
  return (
    <li className={`versiones__cambio versiones__cambio--${cambio.tipo}`}>
      <p className="versiones__titulo-cambio">
        {cambio.descripcion} <span className="versiones__etiqueta-tipo">({cambio.tipo})</span>
      </p>
      <Campos campos={cambio.campos} />
    </li>
  );
}

function CambioModulo({ cambio }: { cambio: CambioDeModulo }): JSX.Element {
  return (
    <li className={`versiones__cambio versiones__cambio--${cambio.tipo}`}>
      <p className="versiones__titulo-cambio">
        {cambio.nombre} <span className="versiones__etiqueta-tipo">({cambio.tipo})</span>
      </p>
      <Campos campos={cambio.campos} />
    </li>
  );
}

function Diferencia({ diferencia }: { diferencia: DiferenciaDiagramas }): JSX.Element {
  if (!hayDiferencias(diferencia)) {
    return <p className="panel__vacio">Sin cambios: esta versión es igual al diagrama actual.</p>;
  }
  return (
    <div className="versiones__diferencia">
      <Campos campos={diferencia.meta} />
      {diferencia.clases.length > 0 && (
        <ul className="versiones__lista-cambios">
          {diferencia.clases.map((cambio) => (
            <CambioClase key={cambio.id} cambio={cambio} />
          ))}
        </ul>
      )}
      {diferencia.relaciones.length > 0 && (
        <ul className="versiones__lista-cambios">
          {diferencia.relaciones.map((cambio) => (
            <CambioRelacion key={cambio.id} cambio={cambio} />
          ))}
        </ul>
      )}
      {diferencia.modulos.length > 0 && (
        <ul className="versiones__lista-cambios">
          {diferencia.modulos.map((cambio) => (
            <CambioModulo key={cambio.id} cambio={cambio} />
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Una versión de la lista
   -------------------------------------------------------------------------- */

function Version({
  version,
  usuarioId,
  puedeRestaurar,
  seleccionada,
  diferencia,
  cargandoDiferencia,
  errorDiferencia,
  restaurando,
  alSeleccionar,
  alRestaurar,
}: {
  version: VersionResumen;
  usuarioId: string;
  puedeRestaurar: boolean;
  seleccionada: boolean;
  diferencia: DiferenciaDiagramas | null;
  cargandoDiferencia: boolean;
  errorDiferencia: string | null;
  restaurando: boolean;
  alSeleccionar: () => void;
  alRestaurar: () => void;
}): JSX.Element {
  return (
    <li className="versiones__version">
      <p className="versiones__mensaje">{version.mensaje}</p>
      <p className="versiones__meta">
        <time dateTime={version.creadoEn}>{fecha(version.creadoEn)}</time>
        {version.autorId === usuarioId && <span className="tablon__yo"> (usted)</span>}
      </p>

      <div className="versiones__fila-botones">
        <button type="button" className="boton boton--sutil" onClick={alSeleccionar}>
          {seleccionada ? 'Ocultar cambios' : 'Ver cambios'}
        </button>
        {puedeRestaurar && (
          <button
            type="button"
            className="boton boton--sutil"
            onClick={alRestaurar}
            disabled={restaurando}
          >
            {restaurando ? 'Restaurando…' : 'Restaurar'}
          </button>
        )}
      </div>

      {seleccionada &&
        (cargandoDiferencia ? (
          <p className="panel__vacio">Comparando…</p>
        ) : errorDiferencia !== null ? (
          <p className="versiones__error" role="alert">
            {errorDiferencia}
          </p>
        ) : diferencia !== null ? (
          <Diferencia diferencia={diferencia} />
        ) : null)}
    </li>
  );
}

/* --------------------------------------------------------------------------
   El panel
   -------------------------------------------------------------------------- */

export function PanelVersiones({ proyectoId, usuarioId, rol, diagrama }: PanelVersionesProps): JSX.Element {
  const [versiones, setVersiones] = useState<VersionResumen[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mensaje, setMensaje] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [errorCrear, setErrorCrear] = useState<string | null>(null);

  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
  const [diferencia, setDiferencia] = useState<DiferenciaDiagramas | null>(null);
  const [cargandoDiferencia, setCargandoDiferencia] = useState(false);
  const [errorDiferencia, setErrorDiferencia] = useState<string | null>(null);

  const [restaurandoId, setRestaurandoId] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const recargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const { versiones: lista } = await api.listarVersiones(proyectoId);
      setVersiones(lista);
    } catch (fallo) {
      setError(fallo instanceof ApiError ? fallo.message : 'No se han podido consultar las versiones.');
    } finally {
      setCargando(false);
    }
  }, [proyectoId]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  const recientes = useMemo(() => [...versiones].reverse(), [versiones]);

  const crear = useCallback(async () => {
    const texto = mensaje.trim();
    if (texto === '' || guardando) return;
    setGuardando(true);
    setErrorCrear(null);
    try {
      const { version } = await api.crearVersion(proyectoId, texto);
      setVersiones((previas) => [...previas, version]);
      setMensaje('');
      setAviso(`Versión «${version.mensaje}» guardada.`);
    } catch (fallo) {
      setErrorCrear(fallo instanceof ApiError ? fallo.message : 'No se ha podido guardar la versión.');
    } finally {
      setGuardando(false);
    }
  }, [guardando, mensaje, proyectoId]);

  const seleccionar = useCallback(
    (versionId: string) => {
      if (seleccionadaId === versionId) {
        setSeleccionadaId(null);
        return;
      }
      setSeleccionadaId(versionId);
      setDiferencia(null);
      setErrorDiferencia(null);
      setCargandoDiferencia(true);
      void api
        .verVersion(proyectoId, versionId)
        .then(({ diagrama: diagramaDeLaVersion }) => {
          setDiferencia(diffDiagramas(diagramaDeLaVersion, diagrama));
        })
        .catch((fallo: unknown) => {
          setErrorDiferencia(
            fallo instanceof ApiError ? fallo.message : 'No se ha podido comparar esta versión.',
          );
        })
        .finally(() => {
          setCargandoDiferencia(false);
        });
    },
    [diagrama, proyectoId, seleccionadaId],
  );

  const restaurar = useCallback(
    (version: VersionResumen) => {
      // Mismo aviso que el `PUT` de diagrama completo: restaurar reemplaza el
      // documento entero y se lleva por delante lo que los demás no hayan
      // guardado todavía.
      if (
        !confirm(
          `¿Restaurar el proyecto al estado de «${version.mensaje}»? Se perderá el trabajo sin guardar de los demás.`,
        )
      ) {
        return;
      }
      setRestaurandoId(version.id);
      setAviso(null);
      void api
        .restaurarVersion(proyectoId, version.id)
        .then(() => {
          setAviso(`Restaurada la versión «${version.mensaje}».`);
          setSeleccionadaId(null);
        })
        .catch((fallo: unknown) => {
          setAviso(null);
          setError(fallo instanceof ApiError ? fallo.message : 'No se ha podido restaurar la versión.');
        })
        .finally(() => {
          setRestaurandoId(null);
        });
    },
    [proyectoId],
  );

  const restantes = MAXIMO_MENSAJE - mensaje.length;

  return (
    <div className="versiones">
      <div className="versiones__hilo">
        {cargando ? (
          <p className="panel__vacio">Cargando las versiones…</p>
        ) : recientes.length === 0 ? (
          <p className="panel__vacio">Todavía no se ha guardado ninguna versión de este proyecto.</p>
        ) : (
          <ul className="versiones__lista">
            {recientes.map((version) => (
              <Version
                key={version.id}
                version={version}
                usuarioId={usuarioId}
                puedeRestaurar={rol === 'owner'}
                seleccionada={seleccionadaId === version.id}
                diferencia={seleccionadaId === version.id ? diferencia : null}
                cargandoDiferencia={seleccionadaId === version.id && cargandoDiferencia}
                errorDiferencia={seleccionadaId === version.id ? errorDiferencia : null}
                restaurando={restaurandoId === version.id}
                alSeleccionar={() => seleccionar(version.id)}
                alRestaurar={() => restaurar(version)}
              />
            ))}
          </ul>
        )}
      </div>

      {error !== null && (
        <p className="versiones__error" role="status">
          {error}
        </p>
      )}
      {aviso !== null && <p className="versiones__aviso">{aviso}</p>}

      {rol !== 'viewer' && (
        <form
          className="versiones__crear"
          onSubmit={(evento) => {
            evento.preventDefault();
            void crear();
          }}
        >
          <textarea
            className="versiones__entrada"
            value={mensaje}
            maxLength={MAXIMO_MENSAJE}
            rows={2}
            placeholder="Describir este punto de control"
            aria-label="Mensaje de la versión"
            onChange={(evento) => {
              setMensaje(evento.target.value);
            }}
          />
          {errorCrear !== null && (
            <p className="versiones__error" role="alert">
              {errorCrear}
            </p>
          )}
          <div className="versiones__acciones">
            {restantes < 50 && <span className="versiones__restantes">{restantes} caracteres</span>}
            <button
              type="submit"
              className="boton boton--principal"
              disabled={mensaje.trim() === '' || guardando}
            >
              <Icono nombre="comprobado" />
              {guardando ? 'Guardando…' : 'Guardar versión'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
