import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  CollabProvider,
  applyOperations,
  componerEntrada,
  getClassesMap,
  getHistorialArray,
  getMetaMap,
  getModulesMap,
  getRelationsMap,
  leerHistorial,
  readDiagram,
  registrarCambio,
  type Aplicar,
  type Autor,
  type ClassDiagram,
  type ContextoCambio,
  type EntradaLeida,
  type EstadoConexion,
  type Operation,
} from '@app/shared';
import { aBase64, api, deBase64, getToken, urlColaboracion } from '../services/api';
import { useReconexion } from './useReconexion';
import { useRespaldo } from './useRespaldo';

/**
 * El diagrama, tal y como lo ve la interfaz.
 *
 * Aquí se junta todo lo que hace que esta aplicación sea colaborativa y offline
 * a la vez, y conviene ver por qué son la misma cosa: un compañero que edita a
 * la vez y uno mismo editando en el metro son el mismo problema —dos réplicas
 * que divergen— con latencias distintas. El CRDT resuelve los dos con el mismo
 * mecanismo, y por eso no hay aquí ninguna lógica de «modo offline»: hay un
 * documento local que siempre se puede editar y un transporte que a veces
 * funciona.
 *
 * Las tres piezas:
 *
 *   `Y.Doc`                 el documento; único sitio donde vive el diagrama
 *   `IndexeddbPersistence`  lo conserva en el navegador entre recargas
 *   `CollabProvider`        lo sincroniza con los demás cuando hay red
 *
 * Ninguna sabe de React. Lo que hace este hook es traducir sus cambios a
 * repintados, y nada más.
 */

export interface EstadoDiagrama {
  /** El diagrama en forma plana, listo para pintar. */
  diagrama: ClassDiagram;
  /** Quién cambió qué, de lo más antiguo a lo más reciente. */
  historial: EntradaLeida[];
  /** Estado del canal colaborativo; es lo que muestra el indicador. */
  conexion: EstadoConexion;
  detalleConexion: string | undefined;
  /** ¿Se ha cargado ya lo que hubiera guardado en este navegador? */
  listoLocal: boolean;
  /** ¿Se ha puesto al día con el servidor al menos una vez en esta sesión? */
  sincronizado: boolean;
  /** El documento, para quien necesite el objeto Yjs (presencia, deshacer). */
  doc: Y.Doc;
  /**
   * Sube uno en cada actualización del documento, venga de donde venga.
   *
   * Es para lo que **no** está en `diagrama`. Aquel es el diagrama de clases y
   * es lo que casi todo el mundo mira, pero el documento guarda más cosas —los
   * diagramas de comunicación importados, sin ir más lejos— y quien las lea con
   * `useMemo` necesita algo que cambie para volver a leerlas. Un `Y.Doc` es
   * siempre el mismo objeto: mutarlo no dispara ningún repintado por sí solo, y
   * sin este contador un diagrama importado por otro colaborador no aparecería
   * hasta que alguien tocase una clase.
   */
  version: number;
  /** `null` hasta que la conexión se abre por primera vez. */
  provider: CollabProvider | null;
  /**
   * Aplica operaciones de dominio sobre el documento local.
   *
   * Es el único camino de escritura de toda la interfaz (decisión D6): ningún
   * componente toca el `Y.Doc` directamente. Devuelve el error si la operación
   * no era aplicable —un nombre repetido, una clase que no existe— para que el
   * panel lo enseñe en vez de que el cambio desaparezca sin explicación.
   */
  aplicar: Aplicar;
  /** Deshacer y rehacer, limitados a lo que ha hecho este usuario. */
  deshacer: () => void;
  rehacer: () => void;
}

/**
 * Origen de las transacciones que nacen en esta pestaña.
 *
 * El gestor de deshacer solo revierte las transacciones con este origen. Sin esa
 * restricción, pulsar «deshacer» borraría lo último que hubiera escrito otro
 * participante, que es la forma más rápida de que nadie vuelva a usar el botón.
 */
const ORIGEN_LOCAL = Symbol('edicion-local');

/**
 * @param autor quién firma los cambios en el historial. `null` mientras la
 * sesión no ha cargado; los cambios hechos en ese hueco quedan sin firmar en
 * vez de atribuidos a nadie en concreto.
 */
export function useDiagrama(proyectoId: string, autor: Autor | null = null): EstadoDiagrama {
  // El documento se crea una sola vez por proyecto y sobrevive a los
  // repintados. Recrearlo en cada render tiraría el historial, la conexión y lo
  // que hubiera sin guardar.
  const [doc] = useState(() => new Y.Doc());
  const [diagrama, setDiagrama] = useState<ClassDiagram>(() => readDiagram(doc));
  const [version, setVersion] = useState(0);
  const [historial, setHistorial] = useState<EntradaLeida[]>([]);
  const [conexion, setConexion] = useState<EstadoConexion>('conectando');
  const [detalleConexion, setDetalleConexion] = useState<string | undefined>(undefined);
  const [listoLocal, setListoLocal] = useState(false);
  const [sincronizado, setSincronizado] = useState(false);
  const [provider, setProvider] = useState<CollabProvider | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);

  // -------------------------------------------------------------------------
  // Documento local: IndexedDB
  // -------------------------------------------------------------------------

  useEffect(() => {
    // El nombre incluye el proyecto: dos diagramas en el mismo navegador no
    // pueden compartir almacén o se mezclarían sus contenidos.
    const persistencia = new IndexeddbPersistence(`diagrama-${proyectoId}`, doc);
    persistencia.on('synced', () => setListoLocal(true));

    return () => {
      // `destroy` cierra la base sin borrarla. `clearData` la borraría, y eso es
      // justo lo que no debe pasar al salir del diagrama: lo editado sin
      // conexión tiene que seguir ahí a la vuelta.
      void persistencia.destroy();
    };
  }, [doc, proyectoId]);

  /*
    Y una copia fuera del navegador, para cuando el almacén de arriba no está.

    No es redundancia: dentro del WebView de Android, el IndexedDB es
    almacenamiento desechable y **no hay forma de pedir que deje de serlo**
    —`navigator.storage.persist()` no se concede ahí—, así que el sistema puede
    desalojarlo cuando le falte sitio. Y basta con que el APK cambie de URL para
    que el origen sea otro y el almacén aparezca vacío sin que nadie haya
    borrado nada. Lo que se juega es lo editado sin conexión, que es lo único
    que no tiene copia en el servidor. El detalle está en `respaldo.ts`.

    Fuera de la app esto no hace nada: si no hay puente, no hay canal.
  */
  useRespaldo({ doc, proyectoId, conexion, sincronizado, listoLocal });

  // -------------------------------------------------------------------------
  // Repintado
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Se relee el diagrama entero en cada cambio en lugar de aplicar deltas.
    // Es deliberado: `readDiagram` es una lectura de mapas en memoria, y en los
    // tamaños que maneja un diagrama de clases —decenas de clases, no miles—
    // cuesta menos que mantener sincronizadas dos representaciones del mismo
    // estado, que es la clase de duplicidad que acaba divergiendo.
    const alCambiar = (): void => {
      setDiagrama(readDiagram(doc));
      setVersion((n) => n + 1);
    };
    doc.on('update', alCambiar);
    alCambiar();
    return () => doc.off('update', alCambiar);
  }, [doc]);

  // El historial se observa por separado y no dentro del efecto de arriba: el
  // diagrama se relee en cada cambio, incluidos los cientos que llegan mientras
  // alguien arrastra una caja, y esos no tocan el historial. Escuchar solo al
  // array evita recorrer cuatrocientas entradas por cada píxel recorrido.
  useEffect(() => {
    const array = getHistorialArray(doc);
    const alCambiar = (): void => setHistorial(leerHistorial(doc));
    array.observe(alCambiar);
    alCambiar();
    return () => array.unobserve(alCambiar);
  }, [doc]);

  // -------------------------------------------------------------------------
  // Deshacer
  // -------------------------------------------------------------------------

  /**
   * El resumen de lo que se está aplicando ahora mismo.
   *
   * Yjs avisa de que ha apilado un elemento deshacible justo después de la
   * transacción, y en ese momento ya no hay forma de saber qué operación lo
   * produjo. Se deja aquí antes de aplicar para poder grapárselo al elemento y
   * que, al deshacerlo, el historial pueda decir *qué* se deshizo en vez de un
   * «deshizo algo» que no ayuda a nadie.
   */
  const enCurso = useRef<string | null>(null);
  const autorRef = useRef<Autor | null>(autor);
  autorRef.current = autor;

  useEffect(() => {
    // Los tipos raíz se piden a `shared`, no por su nombre. El nombre es un
    // detalle del formato del documento y escribirlo aquí sería una segunda
    // copia que nadie actualizaría al cambiar la primera: el resultado no sería
    // un error de compilación, sino un «deshacer» que deja de funcionar.
    // Los módulos están en la lista por la misma razón que las clases: crear un
    // módulo y asignarle clases es un solo lote, y si el gestor no vigilase el
    // mapa de módulos, `Ctrl+Z` devolvería las clases a su sitio y dejaría el
    // módulo puesto.
    const manager = new Y.UndoManager(
      [getClassesMap(doc), getRelationsMap(doc), getModulesMap(doc), getMetaMap(doc)],
      { trackedOrigins: new Set([ORIGEN_LOCAL]) },
    );

    // El array del historial no está entre los tipos vigilados, y no por
    // descuido: si lo estuviera, `Ctrl+Z` borraría la entrada que acaba de
    // registrar el cambio y el historial se iría quedando sin las cosas que se
    // deshicieron —justo las que interesa poder rastrear—. Deshacer añade, no
    // borra.
    // `StackItem` no está entre los tipos que Yjs exporta, así que se describe
    // aquí lo único que se usa de él. Es preferible a un `any`: si mañana el
    // `meta` dejara de ser un mapa, esto dejaría de compilar.
    interface ElementoDeshacer {
      meta: Map<unknown, unknown>;
    }

    const alApilar = ({ stackItem }: { stackItem: ElementoDeshacer }): void => {
      if (enCurso.current) stackItem.meta.set('resumen', enCurso.current);
    };
    const alDesapilar = ({
      stackItem,
      type,
    }: {
      stackItem: ElementoDeshacer;
      type: 'undo' | 'redo';
    }): void => {
      const resumen = stackItem.meta.get('resumen');
      const verbo = type === 'undo' ? 'Deshizo' : 'Rehízo';
      registrarCambio(doc, {
        autor: autorRef.current,
        origen: type === 'undo' ? 'deshacer' : 'rehacer',
        operaciones: [],
        resumen: typeof resumen === 'string' ? `${verbo}: ${resumen}` : `${verbo} un cambio`,
      });
    };

    manager.on('stack-item-added', alApilar);
    manager.on('stack-item-popped', alDesapilar);
    undoRef.current = manager;
    return () => {
      manager.off('stack-item-added', alApilar);
      manager.off('stack-item-popped', alDesapilar);
      manager.destroy();
      undoRef.current = null;
    };
  }, [doc]);

  // -------------------------------------------------------------------------
  // Canal colaborativo
  // -------------------------------------------------------------------------

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const p = new CollabProvider({
      url: urlColaboracion(proyectoId, token),
      doc,
      onEstado: (estado, detalle) => {
        setConexion(estado);
        setDetalleConexion(detalle);
      },
      onSincronizado: () => setSincronizado(true),
    });
    setProvider(p);

    return () => {
      p.destroy();
      setProvider(null);
      setSincronizado(false);
    };
  }, [doc, proyectoId]);

  /*
    Y volver en sí cuando el aparato vuelve en sí.

    Va aquí, en el hook, y no en las pantallas: el fallo que cubre —el socket
    que Android mató sin avisar mientras la pantalla estaba bloqueada— no es de
    la interfaz táctil, es de cualquiera que se ejecute en un teléfono. Ponerlo
    en `PantallaMovil` habría dejado al escritorio con el mismo agujero el día
    que alguien abra el editor grande en una tableta.
  */
  useReconexion(provider);

  // -------------------------------------------------------------------------
  // Reconciliación por HTTP
  // -------------------------------------------------------------------------

  /**
   * Vuelta de una sesión sin conexión (RF-OFF-04).
   *
   * El WebSocket ya reconcilia al reconectar, así que esto puede parecer
   * redundante. No lo es: cubre el caso de que el socket no llegue a abrirse
   * —un proxy corporativo que bloquea WebSocket, una red que solo deja pasar
   * HTTP— y entonces es la única vía por la que el trabajo hecho offline sale
   * del navegador. Con una sola petición: se manda lo local y se recibe lo
   * ajeno.
   */
  useEffect(() => {
    if (!listoLocal) return;
    if (conexion === 'conectado' || conexion === 'sin-permiso') return;

    let cancelado = false;

    const reconciliar = async (): Promise<void> => {
      try {
        const respuesta = await api.sincronizarEstado(
          proyectoId,
          aBase64(Y.encodeStateAsUpdate(doc)),
          aBase64(Y.encodeStateVector(doc)),
        );
        if (cancelado) return;
        // Origen ajeno: lo que llega del servidor no es del usuario y no debe
        // poder deshacerse con Ctrl+Z.
        Y.applyUpdate(doc, deBase64(respuesta.actualizacion), 'http');
      } catch {
        // Sin conexión no hay nada que hacer y no es un error que mostrar: se
        // seguirá editando en local y el socket lo intentará por su cuenta.
      }
    };

    void reconciliar();
    return () => {
      cancelado = true;
    };
  }, [proyectoId, doc, listoLocal, conexion]);

  /**
   * Único camino de escritura, y por eso único sitio donde se registra quién
   * escribe (decisión D6). Si mañana alguien añadiera una segunda vía, el
   * historial tendría agujeros sin que fallara ninguna comprobación de tipos:
   * es la razón por la que ese camino único merece defenderse.
   */
  const aplicar = useCallback(
    (operaciones: Operation[], contexto: ContextoCambio = {}) => {
      const origen = contexto.origen ?? 'manual';

      // Se calcula antes de aplicar porque Yjs apila el elemento deshacible
      // durante la propia transacción, y para entonces ya tiene que estar
      // disponible el texto que se le grapa.
      const previa = componerEntrada({ autor: autorRef.current, origen, operaciones });
      enCurso.current = previa?.resumen ?? null;

      const resultado = applyOperations(doc, operaciones, { origin: ORIGEN_LOCAL });
      enCurso.current = null;
      if (!resultado.ok) return { ok: false as const, error: resultado.error };

      // Los identificadores salen de lo que devolvió cada operación y no del
      // diagrama: `addClass` inventa el suyo dentro, y sin recogerlo aquí no
      // habría manera de saber a qué clase pertenece la entrada —que es la
      // pregunta que motivó todo esto—.
      const clases: string[] = [];
      const relaciones: string[] = [];
      const creadas: string[] = [];
      for (const [indice, r] of resultado.results.entries()) {
        if (!r.ok) continue;
        if (r.classId) {
          clases.push(r.classId);
          // La "asociación de clase" rápida también crea una clase (ver
          // `associationClassName` en `addRelation`): sin este segundo caso
          // esa clase quedaría fuera del historial de creación aunque el
          // usuario la acabe de crear en el mismo gesto.
          const operacion = operaciones[indice];
          if (
            operacion?.op === 'addClass' ||
            (operacion?.op === 'addRelation' && operacion.associationClassName)
          ) {
            creadas.push(r.classId);
          }
        }
        if (r.relationId) relaciones.push(r.relationId);
      }

      registrarCambio(doc, {
        autor: autorRef.current,
        origen,
        ...(contexto.propuestoPor ? { propuestoPor: contexto.propuestoPor } : {}),
        operaciones,
        clases,
        relaciones,
        creadas,
      });

      return { ok: true as const };
    },
    [doc],
  );

  const deshacer = useCallback(() => undoRef.current?.undo(), []);
  const rehacer = useCallback(() => undoRef.current?.redo(), []);

  return {
    diagrama,
    historial,
    conexion,
    detalleConexion,
    listoLocal,
    sincronizado,
    doc,
    version,
    provider,
    aplicar,
    deshacer,
    rehacer,
  };
}
