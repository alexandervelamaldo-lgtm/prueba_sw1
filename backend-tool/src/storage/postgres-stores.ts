import { randomBytes, randomUUID } from 'node:crypto';
import {
  AuthError,
  SesionFirmada,
  generarCodigoRecuperacion,
  hashPassword,
  marcaDeCredencial,
  normalizarCodigo,
  normalizarCorreo,
  safeEquals,
  toProfile,
  validarRegistro,
  type IdentityProvider,
  type Session,
  type StoredUser,
  type UserProfile,
} from '../auth/identity.js';
import {
  MAXIMO_MENSAJES_POR_PROYECTO,
  ordenarHilo,
  type Mensaje,
  type TipoAudio,
} from '@app/shared';
import type { Membership, Project, ProjectStore, Role } from './store.js';
import type { DocumentStore } from './documents.js';
import type {
  PaginaTablon,
  PublicacionTexto,
  PublicacionVoz,
  TablonStore,
} from './tablon.js';
import { MAXIMO_TURNOS, type ChatMessage, type ConversationStore } from './conversaciones.js';
import type { UsoIAStore } from './uso-ia.js';
import type { CrearVersion, Version, VersionResumen, VersionStore } from './versiones.js';
import {
  aIso,
  enTransaccion,
  esViolacionDeUnicidad,
  type ClientePostgres,
  type PoolPostgres,
} from './postgres.js';

/**
 * Las tres implementaciones contra PostgreSQL.
 *
 * Cumplen las mismas interfaces que las de fichero y no añaden ni un método:
 * si algo de aquí necesitara ampliar el contrato, sería señal de que la
 * interfaz se escribió mirando la implementación de fichero en lugar de
 * mirando lo que el servicio necesita.
 *
 * Las consultas van siempre parametrizadas (`$1`, `$2`). Ninguna cadena que
 * venga del usuario se concatena en el SQL, ni siquiera las que ya pasaron por
 * validación: el nombre de un proyecto lo escribe una persona, y RNF-SEG-06 dice
 * que eso es entrada no confiable en todo el recorrido, no solo en el primer
 * tramo.
 */

// ---------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------

interface FilaProyecto {
  id: string;
  nombre: string;
  descripcion: string;
  propietario_id: string;
  creado_en: Date | string;
  actualizado_en: Date | string;
}

function aProyecto(fila: FilaProyecto): Project {
  return {
    id: fila.id,
    name: fila.nombre,
    description: fila.descripcion,
    ownerId: fila.propietario_id,
    createdAt: aIso(fila.creado_en),
    updatedAt: aIso(fila.actualizado_en),
  };
}

const COLUMNAS_PROYECTO = 'id, nombre, descripcion, propietario_id, creado_en, actualizado_en';

export class PostgresProjectStore implements ProjectStore {
  constructor(private readonly pool: PoolPostgres) {}

  async createProject(input: {
    name: string;
    description: string;
    ownerId: string;
  }): Promise<Project> {
    // Las dos inserciones van juntas o no van. Un proyecto sin la pertenencia de
    // su propietario es un proyecto al que nadie puede entrar y que nadie puede
    // borrar: queda ocupando sitio y sin dueño que lo reclame.
    return enTransaccion(this.pool, async (cliente) => {
      const { rows } = await cliente.query<FilaProyecto>(
        `insert into proyectos (id, nombre, descripcion, propietario_id)
         values ($1, $2, $3, $4)
         returning ${COLUMNAS_PROYECTO}`,
        [randomUUID(), input.name, input.description, input.ownerId],
      );
      const fila = rows[0];
      if (!fila) throw new Error('La inserción del proyecto no devolvió ninguna fila');

      await cliente.query(
        `insert into miembros (proyecto_id, usuario_id, rol) values ($1, $2, 'owner')`,
        [fila.id, input.ownerId],
      );
      return aProyecto(fila);
    });
  }

  async getProject(id: string): Promise<Project | null> {
    const { rows } = await this.pool.query<FilaProyecto>(
      `select ${COLUMNAS_PROYECTO} from proyectos where id = $1`,
      [id],
    );
    const fila = rows[0];
    return fila ? aProyecto(fila) : null;
  }

  async listProjectsForUser(userId: string): Promise<(Project & { role: Role })[]> {
    const { rows } = await this.pool.query<FilaProyecto & { rol: Role }>(
      `select p.id, p.nombre, p.descripcion, p.propietario_id, p.creado_en,
              p.actualizado_en, m.rol
         from proyectos p
         join miembros m on m.proyecto_id = p.id
        where m.usuario_id = $1
        order by p.actualizado_en desc`,
      [userId],
    );
    return rows.map((fila) => ({ ...aProyecto(fila), role: fila.rol }));
  }

  async renameProject(id: string, name: string, description: string): Promise<Project | null> {
    const { rows } = await this.pool.query<FilaProyecto>(
      `update proyectos
          set nombre = $2, descripcion = $3, actualizado_en = now()
        where id = $1
      returning ${COLUMNAS_PROYECTO}`,
      [id, name, description],
    );
    const fila = rows[0];
    return fila ? aProyecto(fila) : null;
  }

  async deleteProject(id: string): Promise<boolean> {
    // Las pertenencias caen por la cascada de la tabla. El documento
    // colaborativo no: lo borra `RoomManager.discard()`, porque el almacén de
    // documentos puede no estar en esta misma base de datos.
    const { rows } = await this.pool.query<{ id: string }>(
      'delete from proyectos where id = $1 returning id',
      [id],
    );
    return rows.length > 0;
  }

  async addMember(projectId: string, userId: string, role: Role): Promise<Membership> {
    // Invitar a quien ya está no es un error: es cambiarle el permiso, que es lo
    // que la interfaz espera y lo que hace la implementación de fichero.
    await this.pool.query(
      `insert into miembros (proyecto_id, usuario_id, rol) values ($1, $2, $3)
       on conflict (proyecto_id, usuario_id) do update set rol = excluded.rol`,
      [projectId, userId, role],
    );
    return { projectId, userId, role };
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ usuario_id: string }>(
      'delete from miembros where proyecto_id = $1 and usuario_id = $2 returning usuario_id',
      [projectId, userId],
    );
    return rows.length > 0;
  }

  async listMembers(projectId: string): Promise<Membership[]> {
    const { rows } = await this.pool.query<{ usuario_id: string; rol: Role }>(
      'select usuario_id, rol from miembros where proyecto_id = $1',
      [projectId],
    );
    return rows.map((fila) => ({ projectId, userId: fila.usuario_id, role: fila.rol }));
  }

  async roleOf(projectId: string, userId: string): Promise<Role | null> {
    const { rows } = await this.pool.query<{ rol: Role }>(
      'select rol from miembros where proyecto_id = $1 and usuario_id = $2',
      [projectId, userId],
    );
    return rows[0]?.rol ?? null;
  }
}

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

interface FilaUsuario {
  id: string;
  correo: string;
  nombre: string;
  sal: string;
  hash: string;
  sal_recuperacion: string | null;
  hash_recuperacion: string | null;
}

/** Las columnas del usuario, en un solo sitio para que las cuatro consultas no se separen. */
const COLUMNAS_USUARIO = 'id, correo, nombre, sal, hash, sal_recuperacion, hash_recuperacion';

/**
 * Se comprueba antes de consultar porque la columna es `uuid`: PostgreSQL
 * rechaza compararla con texto que no lo sea, y eso llega como error en lugar de
 * como «no encontrado».
 */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function aUsuario(fila: FilaUsuario): StoredUser {
  const usuario: StoredUser = {
    id: fila.id,
    email: fila.correo,
    displayName: fila.nombre,
    salt: fila.sal,
    hash: fila.hash,
  };
  // Las columnas vacías se omiten en vez de convertirse en `null`: así el objeto
  // que sale de PostgreSQL es indistinguible del que sale del fichero, y el
  // código que los usa no tiene que saber de cuál de los dos vino.
  //
  // La comprobación es por valor y no `!== null` a propósito: una fila que venga
  // de un `select` sin estas columnas las trae como `undefined`, y `undefined
  // !== null` es cierto, con lo que se asignaría un `recoverySalt` indefinido y
  // el código de más abajo creería que hay recuperación pendiente.
  if (fila.sal_recuperacion) usuario.recoverySalt = fila.sal_recuperacion;
  if (fila.hash_recuperacion) usuario.recoveryHash = fila.hash_recuperacion;
  return usuario;
}

/**
 * Usuarios en PostgreSQL.
 *
 * La derivación de la contraseña, la comparación en tiempo constante y la firma
 * del token son las mismas funciones que usa la implementación local, importadas
 * y no copiadas. Es la única forma de que cambiar de almacén no cambie, de
 * paso, las propiedades de seguridad.
 */
export class PostgresIdentityProvider implements IdentityProvider {
  private readonly sesiones: SesionFirmada;

  constructor(
    private readonly pool: PoolPostgres,
    secret: string,
    ttlSeconds: number,
  ) {
    this.sesiones = new SesionFirmada(secret, ttlSeconds);
  }

  async register(email: string, password: string, displayName: string): Promise<UserProfile> {
    const normalized = validarRegistro(email, password);
    const sal = randomBytes(16).toString('hex');

    try {
      const { rows } = await this.pool.query<FilaUsuario>(
        `insert into usuarios (id, correo, nombre, sal, hash)
         values ($1, $2, $3, $4, $5)
         returning ${COLUMNAS_USUARIO}`,
        [
          randomUUID(),
          normalized,
          displayName.trim() || normalized.split('@')[0] || 'Usuario',
          sal,
          hashPassword(password, sal),
        ],
      );
      const fila = rows[0];
      if (!fila) throw new Error('La inserción del usuario no devolvió ninguna fila');
      return toProfile(aUsuario(fila));
    } catch (error) {
      // No se consulta antes si el correo existe: entre la consulta y la
      // inserción caben dos registros simultáneos con el mismo correo. La
      // restricción de unicidad de la tabla no tiene esa ventana.
      if (esViolacionDeUnicidad(error)) {
        throw new AuthError('Ese correo ya está registrado', 409, 'EMAIL_DUPLICADO');
      }
      throw error;
    }
  }

  async authenticate(email: string, password: string): Promise<Session | null> {
    const usuario = await this.buscar('correo', normalizarCorreo(email));

    // El hash se calcula también cuando el usuario no existe: si se saliera
    // antes, la diferencia de tiempo entre un correo registrado y uno que no lo
    // está permitiría averiguar quién tiene cuenta.
    const candidato = hashPassword(password, usuario?.salt ?? 'sal-inexistente');
    if (!usuario || !safeEquals(candidato, usuario.hash)) return null;

    return this.sesiones.emitir(toProfile(usuario), marcaDeCredencial(usuario));
  }

  async verify(token: string): Promise<UserProfile | null> {
    const userId = await this.sesiones.leer(token, async (id) => {
      // El identificador viene de un token todavía sin comprobar, así que se
      // filtra igual que en `findById`: si no es un UUID, PostgreSQL responde
      // con un error de tipo en lugar de con «no hay».
      if (!ES_UUID.test(id)) return null;
      const usuario = await this.buscar('id', id);
      return usuario ? marcaDeCredencial(usuario) : null;
    });
    if (!userId) return null;
    return this.findById(userId);
  }

  async emitirCodigoRecuperacion(userId: string): Promise<string> {
    if (!ES_UUID.test(userId)) {
      throw new AuthError('Ese usuario no existe', 404, 'USUARIO_DESCONOCIDO');
    }

    const codigo = generarCodigoRecuperacion();
    const sal = randomBytes(16).toString('hex');
    const { rows } = await this.pool.query<{ id: string }>(
      `update usuarios set sal_recuperacion = $2, hash_recuperacion = $3
       where id = $1
       returning id`,
      [userId, sal, hashPassword(normalizarCodigo(codigo), sal)],
    );
    if (rows.length === 0) {
      throw new AuthError('Ese usuario no existe', 404, 'USUARIO_DESCONOCIDO');
    }
    return codigo;
  }

  async restablecerConCodigo(
    email: string,
    codigo: string,
    passwordNueva: string,
  ): Promise<Session | null> {
    const normalizado = validarRegistro(email, passwordNueva);
    const usuario = await this.buscar('correo', normalizado);

    // Se deriva siempre, como en `authenticate`, para no delatar por el tiempo
    // ni quién tiene cuenta ni quién tiene una recuperación pendiente.
    const candidato = hashPassword(
      normalizarCodigo(codigo),
      usuario?.recoverySalt ?? 'sal-inexistente',
    );
    if (!usuario?.recoveryHash || !safeEquals(candidato, usuario.recoveryHash)) return null;

    const sal = randomBytes(16).toString('hex');
    // La condición sobre `hash_recuperacion` no es decorativa: dos peticiones
    // simultáneas con el mismo código llegarían las dos hasta aquí, y sin ella
    // las dos cambiarían la contraseña. Con ella, la segunda no actualiza nada y
    // se va con las manos vacías, que es lo que significa «un solo uso».
    const { rows } = await this.pool.query<FilaUsuario>(
      `update usuarios
          set sal = $2, hash = $3, sal_recuperacion = null, hash_recuperacion = null
        where id = $1 and hash_recuperacion = $4
       returning ${COLUMNAS_USUARIO}`,
      [usuario.id, sal, hashPassword(passwordNueva, sal), usuario.recoveryHash],
    );
    const fila = rows[0];
    if (!fila) return null;

    const actualizado = aUsuario(fila);
    return this.sesiones.emitir(toProfile(actualizado), marcaDeCredencial(actualizado));
  }

  async findById(id: string): Promise<UserProfile | null> {
    // El identificador llega de dentro del token ya verificado, pero sigue
    // siendo texto: si no es un UUID, PostgreSQL rechaza la comparación con un
    // error de tipo en lugar de devolver «no encontrado». Se distingue aquí.
    if (!ES_UUID.test(id)) return null;
    const usuario = await this.buscar('id', id);
    return usuario ? toProfile(usuario) : null;
  }

  async findByEmail(email: string): Promise<UserProfile | null> {
    const usuario = await this.buscar('correo', normalizarCorreo(email));
    return usuario ? toProfile(usuario) : null;
  }

  /**
   * El nombre de columna es literal en las dos llamadas de este fichero y nunca
   * viene de fuera; el valor sí, y por eso va parametrizado.
   */
  private async buscar(columna: 'id' | 'correo', valor: string): Promise<StoredUser | null> {
    const { rows } = await this.pool.query<FilaUsuario>(
      `select ${COLUMNAS_USUARIO} from usuarios where ${columna} = $1`,
      [valor],
    );
    const fila = rows[0];
    return fila ? aUsuario(fila) : null;
  }
}

// ---------------------------------------------------------------------------
// Documentos colaborativos
// ---------------------------------------------------------------------------

/**
 * El documento Yjs como un `bytea`.
 *
 * Se guarda el estado entero en cada volcado, no incrementos. Es más escritura,
 * pero deja una única fila que siempre se puede aplicar; con incrementos habría
 * que leerlos todos en orden y un hueco los invalidaría a partir de ahí. Con un
 * volcado cada dos segundos y diagramas de kilobytes, la diferencia no se nota.
 */
export class PostgresDocumentStore implements DocumentStore {
  constructor(
    private readonly pool: PoolPostgres,
    /**
     * Si este almacén es el dueño del pool compartido.
     *
     * `RoomManager.shutdown()` es el último paso del apagado del servicio
     * (`main.ts`), después de vaciar la cola de guardado, así que es el momento
     * correcto para cerrar el pool. Cerrarlo antes perdería exactamente el
     * trabajo que el apagado ordenado existe para salvar.
     */
    private readonly cierraElPool = true,
  ) {}

  async load(roomId: string): Promise<Uint8Array | null> {
    const { rows } = await this.pool.query<{ estado: Buffer }>(
      'select estado from documentos where sala_id = $1',
      [roomId],
    );
    const fila = rows[0];
    return fila ? new Uint8Array(fila.estado) : null;
  }

  async save(roomId: string, update: Uint8Array): Promise<void> {
    // `Buffer.from` sobre un `Uint8Array` copia: el documento se sigue editando
    // mientras esta consulta viaja, y compartir la memoria significaría mandar
    // un estado a medio reescribir.
    await this.pool.query(
      `insert into documentos (sala_id, estado, actualizado_en) values ($1, $2, now())
       on conflict (sala_id) do update
         set estado = excluded.estado, actualizado_en = now()`,
      [roomId, Buffer.from(update)],
    );
  }

  async delete(roomId: string): Promise<void> {
    await this.pool.query('delete from documentos where sala_id = $1', [roomId]);
  }

  async close(): Promise<void> {
    if (this.cierraElPool) await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Tablón
// ---------------------------------------------------------------------------

interface FilaMensaje {
  id: string;
  proyecto_id: string;
  autor_id: string;
  secuencia: string | number;
  version: string | number;
  creado_en: Date | string;
  tipo: 'texto' | 'voz';
  texto: string;
  audio_tipo: TipoAudio | null;
  audio_bytes: number | null;
  audio_ms: number | null;
  retirado: boolean;
}

/**
 * `bigint` llega como cadena.
 *
 * El driver de PostgreSQL no convierte `bigint` a `number` por su cuenta,
 * porque no todos los `bigint` caben en un `number`. Los nuestros sí —haría
 * falta que un proyecto pasara de nueve mil billones de mensajes— pero la
 * conversión hay que hacerla igual: sin ella, `secuencia` sería la cadena
 * `'10'`, y `'10' < '9'` es cierto. El hilo se ordenaría alfabéticamente y
 * nadie entendería por qué.
 */
function aNumero(valor: string | number): number {
  return typeof valor === 'number' ? valor : Number.parseInt(valor, 10);
}

function aMensaje(fila: FilaMensaje): Mensaje {
  return {
    id: fila.id,
    proyectoId: fila.proyecto_id,
    autorId: fila.autor_id,
    secuencia: aNumero(fila.secuencia),
    version: aNumero(fila.version),
    creadoEn: aIso(fila.creado_en),
    tipo: fila.tipo,
    texto: fila.texto,
    audio:
      fila.audio_tipo && fila.audio_bytes !== null
        ? {
            tipo: fila.audio_tipo,
            bytes: fila.audio_bytes,
            duracionMs: fila.audio_ms ?? 0,
          }
        : null,
    retirado: fila.retirado,
  };
}

const COLUMNAS_MENSAJE =
  'id, proyecto_id, autor_id, secuencia, version, creado_en, tipo, texto, ' +
  'audio_tipo, audio_bytes, audio_ms, retirado';

/**
 * El tablón en PostgreSQL.
 *
 * Las tres lecturas son las mismas tres del almacén de fichero y cada una usa
 * uno de los dos índices: `ultimos` y `anterioresA` van por `secuencia`,
 * `cambiosDesde` por `version`.
 *
 * Las escrituras van en transacción porque cada una toca dos o tres tablas
 * —contador, mensaje y, si es voz, audio— y dejarlas a medias produce
 * exactamente los estados que el resto del código da por imposibles: un
 * contador gastado sin mensaje, o una nota de voz sin bytes que reproducir.
 */
export class PostgresTablonStore implements TablonStore {
  constructor(private readonly pool: PoolPostgres) {}

  /**
   * Reserva el siguiente número del proyecto.
   *
   * Una sola sentencia, dentro de la transacción de quien llama. Con un
   * `select max(version) + 1` habría una ventana entre la lectura y la
   * inserción por la que dos mensajes simultáneos se llevarían el mismo
   * número; aquí el bloqueo de fila lo pone PostgreSQL.
   */
  private async siguiente(cliente: ClientePostgres, proyectoId: string): Promise<number> {
    const { rows } = await cliente.query<{ contador: string | number }>(
      `insert into tablon_contadores (proyecto_id, contador) values ($1, 1)
       on conflict (proyecto_id) do update set contador = tablon_contadores.contador + 1
       returning contador`,
      [proyectoId],
    );
    return aNumero(rows[0]!.contador);
  }

  /**
   * Borra los mensajes que sobran del tope, con sus audios por cascada.
   *
   * Se ejecuta dentro de la misma transacción que la publicación: si el
   * recorte fallara aparte, el hilo crecería en silencio y el problema
   * aparecería como un disco lleno meses después.
   */
  private async recortar(cliente: ClientePostgres, proyectoId: string): Promise<void> {
    await cliente.query(
      `delete from tablon_mensajes
        where proyecto_id = $1
          and secuencia <= coalesce((
            select secuencia from tablon_mensajes
             where proyecto_id = $1
             order by secuencia desc
             offset $2 limit 1
          ), -1)`,
      [proyectoId, MAXIMO_MENSAJES_POR_PROYECTO],
    );
  }

  async publicarTexto(entrada: PublicacionTexto): Promise<Mensaje> {
    return enTransaccion(this.pool, async (cliente) => {
      const n = await this.siguiente(cliente, entrada.proyectoId);
      const { rows } = await cliente.query<FilaMensaje>(
        `insert into tablon_mensajes
           (id, proyecto_id, autor_id, secuencia, version, tipo, texto, retirado)
         values ($1, $2, $3, $4, $4, 'texto', $5, false)
         returning ${COLUMNAS_MENSAJE}`,
        [randomUUID(), entrada.proyectoId, entrada.autorId, n, entrada.texto],
      );
      await this.recortar(cliente, entrada.proyectoId);
      return aMensaje(rows[0]!);
    });
  }

  async publicarVoz(entrada: PublicacionVoz): Promise<Mensaje> {
    return enTransaccion(this.pool, async (cliente) => {
      const n = await this.siguiente(cliente, entrada.proyectoId);
      const id = randomUUID();
      const { rows } = await cliente.query<FilaMensaje>(
        `insert into tablon_mensajes
           (id, proyecto_id, autor_id, secuencia, version, tipo, texto,
            audio_tipo, audio_bytes, audio_ms, retirado)
         values ($1, $2, $3, $4, $4, 'voz', '', $5, $6, $7, false)
         returning ${COLUMNAS_MENSAJE}`,
        [
          id,
          entrada.proyectoId,
          entrada.autorId,
          n,
          entrada.tipo,
          entrada.audio.byteLength,
          entrada.duracionMs,
        ],
      );
      await cliente.query('insert into tablon_audios (mensaje_id, datos) values ($1, $2)', [
        id,
        Buffer.from(entrada.audio),
      ]);
      await this.recortar(cliente, entrada.proyectoId);
      return aMensaje(rows[0]!);
    });
  }

  async ultimos(proyectoId: string, limite: number): Promise<PaginaTablon> {
    // Se piden uno más de los que caben: si vuelve, es que hay más. Contar con
    // un `count(*)` aparte costaría una segunda consulta para saber lo mismo.
    const { rows } = await this.pool.query<FilaMensaje>(
      `select ${COLUMNAS_MENSAJE} from tablon_mensajes
        where proyecto_id = $1 order by secuencia desc limit $2`,
      [proyectoId, limite + 1],
    );
    return this.pagina(proyectoId, rows, limite, (ms) => ordenarHilo(ms));
  }

  async cambiosDesde(proyectoId: string, desde: number, limite: number): Promise<PaginaTablon> {
    const { rows } = await this.pool.query<FilaMensaje>(
      `select ${COLUMNAS_MENSAJE} from tablon_mensajes
        where proyecto_id = $1 and version > $2 order by version asc limit $3`,
      [proyectoId, desde, limite + 1],
    );

    const hayMas = rows.length > limite;
    const mensajes = rows.slice(0, limite).map(aMensaje);
    return {
      mensajes: ordenarHilo(mensajes),
      // Truncada: el cursor se queda en el último entregado por versión —que no
      // es el último de la lista ya reordenada por secuencia— para que el
      // siguiente sondeo continúe justo donde se cortó.
      cursor: hayMas
        ? aNumero(rows[limite - 1]!.version)
        : await this.contador(proyectoId),
      hayMas,
    };
  }

  async anterioresA(proyectoId: string, secuencia: number, limite: number): Promise<PaginaTablon> {
    const { rows } = await this.pool.query<FilaMensaje>(
      `select ${COLUMNAS_MENSAJE} from tablon_mensajes
        where proyecto_id = $1 and secuencia < $2 order by secuencia desc limit $3`,
      [proyectoId, secuencia, limite + 1],
    );
    return this.pagina(proyectoId, rows, limite, (ms) => ordenarHilo(ms));
  }

  /** Lo común de `ultimos` y `anterioresA`: las dos piden en orden inverso. */
  private async pagina(
    proyectoId: string,
    filas: FilaMensaje[],
    limite: number,
    ordenar: (mensajes: Mensaje[]) => Mensaje[],
  ): Promise<PaginaTablon> {
    const hayMas = filas.length > limite;
    return {
      mensajes: ordenar(filas.slice(0, limite).map(aMensaje)),
      cursor: await this.contador(proyectoId),
      hayMas,
    };
  }

  /**
   * Se lee del contador y no de `max(version)`: si el último mensaje acaba de
   * ser podado por el tope, su versión ya no está en la tabla y el cursor
   * retrocedería, haciendo que el cliente volviera a recibir lo que ya tenía.
   */
  private async contador(proyectoId: string): Promise<number> {
    const { rows } = await this.pool.query<{ contador: string | number }>(
      'select contador from tablon_contadores where proyecto_id = $1',
      [proyectoId],
    );
    return rows[0] ? aNumero(rows[0].contador) : 0;
  }

  async obtener(proyectoId: string, mensajeId: string): Promise<Mensaje | null> {
    if (!ES_UUID.test(mensajeId)) return null;
    const { rows } = await this.pool.query<FilaMensaje>(
      `select ${COLUMNAS_MENSAJE} from tablon_mensajes where proyecto_id = $1 and id = $2`,
      [proyectoId, mensajeId],
    );
    return rows[0] ? aMensaje(rows[0]) : null;
  }

  async leerAudio(proyectoId: string, mensajeId: string): Promise<Uint8Array | null> {
    if (!ES_UUID.test(mensajeId)) return null;
    // El `join` contra el mensaje no es decorativo: sin él, conocer el
    // identificador de un audio bastaría para descargarlo desde cualquier
    // proyecto, y la comprobación de permiso de la ruta miraría un proyecto
    // que no es el del mensaje.
    const { rows } = await this.pool.query<{ datos: Buffer }>(
      `select a.datos from tablon_audios a
         join tablon_mensajes m on m.id = a.mensaje_id
        where m.proyecto_id = $1 and m.id = $2 and m.retirado = false`,
      [proyectoId, mensajeId],
    );
    return rows[0] ? new Uint8Array(rows[0].datos) : null;
  }

  async retirar(proyectoId: string, mensajeId: string): Promise<Mensaje | null> {
    if (!ES_UUID.test(mensajeId)) return null;
    return enTransaccion(this.pool, async (cliente) => {
      const actual = await cliente.query<FilaMensaje>(
        `select ${COLUMNAS_MENSAJE} from tablon_mensajes
          where proyecto_id = $1 and id = $2 for update`,
        [proyectoId, mensajeId],
      );
      const fila = actual.rows[0];
      if (!fila) return null;
      if (fila.retirado) return aMensaje(fila);

      const n = await this.siguiente(cliente, proyectoId);
      const { rows } = await cliente.query<FilaMensaje>(
        `update tablon_mensajes
            set texto = '', audio_tipo = null, audio_bytes = null, audio_ms = null,
                retirado = true, version = $3
          where proyecto_id = $1 and id = $2
          returning ${COLUMNAS_MENSAJE}`,
        [proyectoId, mensajeId, n],
      );
      // Los bytes se van de verdad. La fila sobrevive como lápida para que el
      // sondeo pueda contar que el mensaje ya no está; el audio no tiene por
      // qué sobrevivir a nada.
      await cliente.query('delete from tablon_audios where mensaje_id = $1', [mensajeId]);
      return aMensaje(rows[0]!);
    });
  }

  async borrarProyecto(proyectoId: string): Promise<void> {
    // Las dos tablas cuelgan de `proyectos` con `on delete cascade`, así que
    // borrar el proyecto ya se las lleva. Esto existe para el caso en que se
    // vacíe el tablón sin borrar el proyecto, y para que la interfaz signifique
    // lo mismo en las dos implementaciones.
    await this.pool.query('delete from tablon_mensajes where proyecto_id = $1', [proyectoId]);
    await this.pool.query('delete from tablon_contadores where proyecto_id = $1', [proyectoId]);
  }
}

// ---------------------------------------------------------------------------
// Conversación con el asistente de IA
// ---------------------------------------------------------------------------

interface FilaMensajeIA {
  id: string | number;
  usuario_id: string | null;
  rol: 'user' | 'assistant';
  contenido: string;
  creado_en: Date | string;
  tipo: 'respuesta' | 'observacion';
}

function aChatMessage(fila: FilaMensajeIA): ChatMessage {
  return {
    role: fila.rol,
    texto: fila.contenido,
    autorId: fila.usuario_id,
    creadoEn: aIso(fila.creado_en),
    tipo: fila.tipo,
  };
}

/**
 * El historial del Modo IA en PostgreSQL: un hilo por `(proyecto, usuario)`.
 * Ver la cabecera de `storage/conversaciones.ts` para el motivo.
 * `hilo_usuario_id` es el dueño del hilo y va en todas las filas;
 * `usuario_id` es quién escribió y queda `null` en las del asistente. Las
 * filas del hilo compartido anterior tienen `hilo_usuario_id` a `null` y no se
 * leen nunca.
 *
 * `id` es `bigserial` y no un contador por proyecto como en el tablón: aquí
 * no hace falta que el número tenga sentido de cara al cliente (no se manda
 * en ninguna URL), solo que ordene sin empates, y una clave autoincremental
 * ya lo garantiza sin una segunda tabla de contadores.
 */
export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly pool: PoolPostgres) {}

  /**
   * Recorta el hilo de `usuarioId` al tope; los demás hilos del proyecto no se
   * tocan. Devuelve las filas borradas, en orden.
   */
  private async recortar(cliente: ClientePostgres, proyectoId: string, usuarioId: string): Promise<ChatMessage[]> {
    const { rows } = await cliente.query<FilaMensajeIA>(
      `delete from conversaciones_ia
        where proyecto_id = $1
          and hilo_usuario_id = $2
          and id <= coalesce((
            select id from conversaciones_ia
             where proyecto_id = $1 and hilo_usuario_id = $2
             order by id desc
             offset $3 limit 1
          ), -1)
        returning id, usuario_id, rol, contenido, creado_en, tipo`,
      [proyectoId, usuarioId, MAXIMO_TURNOS * 2],
    );
    // `returning` no garantiza orden.
    return [...rows].sort((a, b) => Number(a.id) - Number(b.id)).map(aChatMessage);
  }

  async getHistory(proyectoId: string, usuarioId: string, limite: number): Promise<ChatMessage[]> {
    const { rows } = await this.pool.query<FilaMensajeIA>(
      `select id, usuario_id, rol, contenido, creado_en, tipo from (
         select id, usuario_id, rol, contenido, creado_en, tipo from conversaciones_ia
          where proyecto_id = $1 and hilo_usuario_id = $2
          order by id desc limit $3
       ) recientes order by id asc`,
      [proyectoId, usuarioId, Math.max(1, Math.trunc(limite))],
    );
    return rows.map(aChatMessage);
  }

  async appendTurn(
    proyectoId: string,
    usuarioId: string,
    usuario: string,
    asistente: string,
  ): Promise<ChatMessage[]> {
    return enTransaccion(this.pool, async (cliente) => {
      await cliente.query(
        `insert into conversaciones_ia (proyecto_id, hilo_usuario_id, usuario_id, rol, contenido)
         values ($1, $2, $2, 'user', $3), ($1, $2, null, 'assistant', $4)`,
        [proyectoId, usuarioId, usuario, asistente],
      );
      return this.recortar(cliente, proyectoId, usuarioId);
    });
  }

  async appendComentario(proyectoId: string, usuarioId: string, texto: string): Promise<ChatMessage[]> {
    return enTransaccion(this.pool, async (cliente) => {
      await cliente.query(
        `insert into conversaciones_ia (proyecto_id, hilo_usuario_id, usuario_id, rol, contenido, tipo)
         values ($1, $2, null, 'assistant', $3, 'observacion')`,
        [proyectoId, usuarioId, texto],
      );
      return this.recortar(cliente, proyectoId, usuarioId);
    });
  }

  async getResumen(proyectoId: string, usuarioId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ resumen: string }>(
      'select resumen from resumenes_ia where proyecto_id = $1 and usuario_id = $2',
      [proyectoId, usuarioId],
    );
    return rows[0]?.resumen ?? null;
  }

  async setResumen(proyectoId: string, usuarioId: string, resumen: string): Promise<void> {
    await this.pool.query(
      `insert into resumenes_ia (proyecto_id, usuario_id, resumen) values ($1, $2, $3)
       on conflict (proyecto_id, usuario_id) do update set resumen = excluded.resumen, actualizado_en = now()`,
      [proyectoId, usuarioId, resumen],
    );
  }

  async borrarProyecto(proyectoId: string): Promise<void> {
    // Cuelga de `proyectos` con `on delete cascade`; explícito por la misma
    // razón que `PostgresTablonStore.borrarProyecto`.
    await this.pool.query('delete from conversaciones_ia where proyecto_id = $1', [proyectoId]);
    await this.pool.query('delete from resumenes_ia where proyecto_id = $1', [proyectoId]);
  }
}

// ---------------------------------------------------------------------------
// Uso de la IA

/** Ver `storage/uso-ia.ts`. Un `upsert` por petición; la suma la hace la base de datos. */
export class PostgresUsoIAStore implements UsoIAStore {
  constructor(private readonly pool: PoolPostgres) {}

  async sumar(usuarioId: string, dia: string, tokens: number): Promise<number> {
    const cantidad = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
    const { rows } = await this.pool.query<{ tokens: string | number }>(
      `insert into uso_ia (usuario_id, dia, tokens) values ($1, $2, $3)
       on conflict (usuario_id, dia) do update set tokens = uso_ia.tokens + excluded.tokens
       returning tokens`,
      [usuarioId, dia, cantidad],
    );
    return Number(rows[0]?.tokens ?? 0);
  }

  async leer(usuarioId: string, dia: string): Promise<number> {
    const { rows } = await this.pool.query<{ tokens: string | number }>(
      'select tokens from uso_ia where usuario_id = $1 and dia = $2',
      [usuarioId, dia],
    );
    return Number(rows[0]?.tokens ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Versiones del proyecto
// ---------------------------------------------------------------------------

interface FilaVersionResumen {
  id: string;
  proyecto_id: string;
  mensaje: string;
  autor_id: string;
  creado_en: Date | string;
}

interface FilaVersion extends FilaVersionResumen {
  estado: Buffer;
}

function aVersionResumen(fila: FilaVersionResumen): VersionResumen {
  return {
    id: fila.id,
    proyectoId: fila.proyecto_id,
    mensaje: fila.mensaje,
    autorId: fila.autor_id,
    creadoEn: aIso(fila.creado_en),
  };
}

const COLUMNAS_VERSION_RESUMEN = 'id, proyecto_id, mensaje, autor_id, creado_en';
const COLUMNAS_VERSION = `id, proyecto_id, estado, mensaje, autor_id, creado_en`;

/**
 * Las versiones del proyecto en PostgreSQL.
 *
 * Sin recorte ni tope, a diferencia del tablón y la conversación con la IA:
 * ver el comentario de `versiones_proyecto` en `sql/esquema.sql` sobre por
 * qué podar aquí sería una decisión que no le corresponde al esquema.
 */
export class PostgresVersionStore implements VersionStore {
  constructor(private readonly pool: PoolPostgres) {}

  async crear(entrada: CrearVersion): Promise<VersionResumen> {
    const { rows } = await this.pool.query<FilaVersionResumen>(
      `insert into versiones_proyecto (id, proyecto_id, estado, mensaje, autor_id)
       values ($1, $2, $3, $4, $5)
       returning ${COLUMNAS_VERSION_RESUMEN}`,
      [randomUUID(), entrada.proyectoId, Buffer.from(entrada.estado), entrada.mensaje, entrada.autorId],
    );
    const fila = rows[0];
    if (!fila) throw new Error('La inserción de la versión no devolvió ninguna fila');
    return aVersionResumen(fila);
  }

  async listar(proyectoId: string): Promise<VersionResumen[]> {
    // Mismo orden que el índice `versiones_por_proyecto`: por fecha y, para
    // desempatar dos versiones del mismo instante, por id.
    const { rows } = await this.pool.query<FilaVersionResumen>(
      `select ${COLUMNAS_VERSION_RESUMEN} from versiones_proyecto
        where proyecto_id = $1 order by creado_en asc, id asc`,
      [proyectoId],
    );
    return rows.map(aVersionResumen);
  }

  async obtener(proyectoId: string, versionId: string): Promise<Version | null> {
    // La columna es `uuid`: sin este cerrojo, un identificador que no lo sea
    // llegaría como un error de tipo en vez de como «no encontrado».
    if (!ES_UUID.test(versionId)) return null;
    const { rows } = await this.pool.query<FilaVersion>(
      `select ${COLUMNAS_VERSION} from versiones_proyecto where proyecto_id = $1 and id = $2`,
      [proyectoId, versionId],
    );
    const fila = rows[0];
    if (!fila) return null;
    return { ...aVersionResumen(fila), estado: new Uint8Array(fila.estado) };
  }

  async borrarProyecto(proyectoId: string): Promise<void> {
    // Cuelga de `proyectos` con `on delete cascade`; explícito por la misma
    // razón que `PostgresTablonStore.borrarProyecto`.
    await this.pool.query('delete from versiones_proyecto where proyecto_id = $1', [proyectoId]);
  }
}
