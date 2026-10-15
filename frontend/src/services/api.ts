import type {
  AvisoImportacion,
  ClassDiagram,
  DatabaseTarget,
  DiagramaExtraido,
  MensajePublico,
  Operation,
  OrigenCambio,
  RelationKind,
  RespuestaTablon,
  TablaExtraida,
} from '@app/shared';
import { descargar, nombreDeFichero } from './descarga';

/**
 * Cliente HTTP de la API.
 *
 * Las rutas son relativas a propósito. En desarrollo el servidor de Vite hace de
 * intermediario y en producción todo se sirve del mismo origen, así que no hay
 * ninguna URL de backend que configurar ni que equivocarse al desplegar.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** ¿Es un fallo de red y no una respuesta del servidor? Distingue «sin conexión». */
  get esDeRed(): boolean {
    return this.status === 0;
  }
}

export interface Usuario {
  id: string;
  email: string;
  displayName: string;
}

export type Rol = 'owner' | 'editor' | 'viewer';

export interface Proyecto {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  role: Rol;
}

/** Un punto de control guardado, sin el estado Yjs que lo respalda. */
export interface VersionResumen {
  id: string;
  proyectoId: string;
  mensaje: string;
  autorId: string;
  creadoEn: string;
}

export interface Miembro {
  usuarioId: string;
  rol: Rol;
  email: string | null;
  nombre: string | null;
}

/**
 * Las cifras de un proyecto, contadas por el servidor.
 *
 * Se declaran aquí y no en el componente que las pinta porque son la forma del
 * cable: quien las recibe es este cliente, y `components/panel.ts` las
 * reexporta para que las pruebas no tengan que subir hasta los servicios.
 */
export interface ResumenProyecto {
  clases: number;
  relaciones: number;
  miembros: number;
  /** Errores de validación: mientras haya uno, el backend no se puede generar. */
  problemas: number;
  avisos: number;
  cambios: number;
  porOrigen: Record<OrigenCambio, number>;
  fechasDudosas: number;
}

export interface FilaPanel {
  proyecto: Proyecto;
  /** `null` cuando el proyecto quedó fuera del tope que resume el servidor. */
  resumen: ResumenProyecto | null;
}

let tokenActual: string | null = null;

export function setToken(token: string | null): void {
  tokenActual = token;
}

export function getToken(): string | null {
  return tokenActual;
}

/**
 * Aviso de que el servidor ha rechazado nuestras credenciales.
 *
 * Existe porque el WebSocket no puede averiguarlo por su cuenta. Cuando el
 * apretón de manos se rechaza con un 401, la API del navegador oculta el código
 * de estado —por diseño, para no filtrar información entre orígenes— y el
 * cliente solo ve un cierre 1006, idéntico al de un servidor apagado. El canal
 * colaborativo se queda entonces reintentando y la interfaz dice «Sin conexión»,
 * que es una mentira tranquilizadora: promete que lo editado se enviará solo
 * cuando vuelva la red, y la red está perfectamente; lo caducado es la sesión.
 *
 * La respuesta HTTP sí trae el 401, así que es la petición de reconciliación la
 * que descubre la verdad y avisa por aquí. Un solo sitio, porque la sesión es
 * del usuario y no del diagrama que tenga abierto.
 */
type EscuchaNoAutorizado = () => void;
let alPerderLaSesion: EscuchaNoAutorizado | null = null;

export function alNoAutorizado(escucha: EscuchaNoAutorizado | null): void {
  alPerderLaSesion = escucha;
}

async function pedir<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  const cabeceras = new Headers(init.headers);
  cabeceras.set('Accept', 'application/json');
  if (init.body !== undefined) cabeceras.set('Content-Type', 'application/json');
  if (tokenActual) cabeceras.set('Authorization', `Bearer ${tokenActual}`);

  let respuesta: Response;
  try {
    respuesta = await fetch(`/api${ruta}`, { ...init, headers: cabeceras });
  } catch {
    // Estar sin conexión no es un error del servidor y la interfaz tiene que
    // poder distinguirlo: offline se sigue trabajando en local, mientras que un
    // 500 sí merece que el usuario deje de intentarlo.
    throw new ApiError(0, 'No hay conexión con el servidor');
  }

  if (respuesta.status === 204) return undefined as T;

  const cuerpo: unknown = await respuesta.json().catch(() => null);

  if (!respuesta.ok) {
    const detalle = cuerpo as { error?: string; code?: string } | null;
    // Se avisa solo si había un token: un 401 al intentar acceder con la
    // contraseña equivocada es una respuesta normal del formulario, no una
    // sesión que se ha caído por debajo de los pies del usuario.
    if (respuesta.status === 401 && tokenActual) alPerderLaSesion?.();
    // Un 5xx *sin cuerpo JSON* casi nunca viene del backend: viene del proxy de
    // desarrollo, que responde 500 cuando no encuentra a quién reenviar. Decir
    // «Error 500» a secas manda a buscar el fallo en el servidor cuando lo que
    // pasa es que no está arrancado. El backend, cuando falla de verdad,
    // contesta con `{ error, code }` y ese mensaje es el que se muestra.
    const generico =
      respuesta.status >= 500 && detalle?.error === undefined
        ? 'El servidor no responde. Comprueba que el backend esté arrancado (npm run dev:backend).'
        : `Error ${respuesta.status}`;
    throw new ApiError(respuesta.status, detalle?.error ?? generico, detalle?.code);
  }

  return cuerpo as T;
}

/**
 * Como `pedir`, pero para respuestas que no son JSON.
 *
 * El error sí que lo es —el backend contesta `{ error, code }` también cuando
 * falla una descarga—, así que se intenta leer de ahí el mensaje antes de
 * caer en un «Error 404» que no dice nada.
 */
async function pedirBinario(ruta: string): Promise<Blob> {
  const cabeceras = new Headers({ Accept: '*/*' });
  if (tokenActual) cabeceras.set('Authorization', `Bearer ${tokenActual}`);

  let respuesta: Response;
  try {
    respuesta = await fetch(`/api${ruta}`, { headers: cabeceras });
  } catch {
    throw new ApiError(0, 'No hay conexión con el servidor');
  }

  if (!respuesta.ok) {
    const detalle = (await respuesta.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    if (respuesta.status === 401 && tokenActual) alPerderLaSesion?.();
    throw new ApiError(respuesta.status, detalle?.error ?? `Error ${respuesta.status}`, detalle?.code);
  }

  return respuesta.blob();
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

interface RespuestaSesion {
  usuario: Usuario;
  token: string;
  expira: string;
}

interface RespuestaRegistro extends RespuestaSesion {
  /**
   * El código de recuperación, en claro y por única vez.
   *
   * El servidor solo guarda su hash, así que este valor no se puede volver a
   * pedir: o se enseña ahora o se pierde. De ahí que la pantalla de registro lo
   * muestre con un paso de confirmación en lugar de pasar de largo.
   */
  codigoRecuperacion: string;
}

export const api = {
  registro: (email: string, password: string, nombre: string) =>
    pedir<RespuestaRegistro>('/auth/registro', {
      method: 'POST',
      body: JSON.stringify({ email, password, nombre }),
    }),

  acceso: (email: string, password: string) =>
    pedir<RespuestaSesion>('/auth/acceso', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  /** Contraseña nueva a cambio del código de recuperación (ver `auth/identity.ts`). */
  recuperar: (email: string, codigo: string, password: string) =>
    pedir<RespuestaSesion>('/auth/recuperar', {
      method: 'POST',
      body: JSON.stringify({ email, codigo, password }),
    }),

  /** Emite un código nuevo para quien ya tiene sesión, e invalida el anterior. */
  codigoRecuperacion: () =>
    pedir<{ codigoRecuperacion: string }>('/auth/codigo-recuperacion', { method: 'POST' }),

  yo: () => pedir<{ usuario: Usuario }>('/auth/yo'),

  // -------------------------------------------------------------------------
  // Proyectos
  // -------------------------------------------------------------------------

  /**
   * La lista de proyectos y sus cifras, en una sola petición.
   *
   * Es la única forma de pedir la lista desde el cliente. Había un
   * `listarProyectos` contra `GET /api/proyectos` y se ha retirado al quedarse
   * sin llamadas: dos caminos para lo mismo se separan solos, y el que nadie usa
   * es el que nadie arregla. La ruta de servidor sigue existiendo —es la que
   * documenta el catálogo de casos de uso y la que prueba `api.test.ts`—, pero
   * la pantalla de entrada pide por aquí.
   *
   * Trae un `Proyecto` completo en cada `fila.proyecto`, más el recuento que de
   * otro modo costaría tres peticiones por tarjeta. No cuelga de `/proyectos`
   * porque no habla de un proyecto sino de todos a la vez, y ahí `/:proyectoId`
   * se habría tragado la ruta.
   */
  panel: () => pedir<{ filas: FilaPanel[]; tope: number }>('/panel'),

  crearProyecto: (nombre: string, descripcion: string, paqueteBase?: string) =>
    pedir<{ proyecto: Proyecto }>('/proyectos', {
      method: 'POST',
      body: JSON.stringify({ nombre, descripcion, paqueteBase }),
    }),

  verProyecto: (id: string) => pedir<{ proyecto: Proyecto }>(`/proyectos/${id}`),

  borrarProyecto: (id: string) => pedir<void>(`/proyectos/${id}`, { method: 'DELETE' }),

  listarMiembros: (id: string) => pedir<{ miembros: Miembro[] }>(`/proyectos/${id}/miembros`),

  invitar: (id: string, email: string, rol: 'editor' | 'viewer') =>
    pedir<{ miembro: Miembro }>(`/proyectos/${id}/miembros`, {
      method: 'POST',
      body: JSON.stringify({ email, rol }),
    }),

  expulsar: (id: string, usuarioId: string) =>
    pedir<void>(`/proyectos/${id}/miembros/${usuarioId}`, { method: 'DELETE' }),

  // -------------------------------------------------------------------------
  // Diagrama
  // -------------------------------------------------------------------------

  leerDiagrama: (id: string) => pedir<{ diagrama: ClassDiagram }>(`/proyectos/${id}/diagrama`),

  /**
   * Fusiona en el servidor lo que se hizo sin conexión y recoge lo que hicieron
   * los demás (RF-OFF-04).
   *
   * Se manda el vector de estado además de la actualización: es lo que permite
   * al servidor contestar solo con la diferencia. Sin él respondería el
   * documento entero en cada reconciliación, que en un diagrama grande es la
   * diferencia entre volver del túnel y que la aplicación se congele un segundo.
   */
  sincronizarEstado: (id: string, actualizacion: string, vectorEstado: string) =>
    pedir<{ actualizacion: string; vectorEstado: string }>(`/proyectos/${id}/diagrama/estado`, {
      method: 'POST',
      body: JSON.stringify({ actualizacion, vectorEstado }),
    }),

  descargarEstado: (id: string, desde?: string) =>
    pedir<{ actualizacion: string; vectorEstado: string }>(
      `/proyectos/${id}/diagrama/estado${desde ? `?desde=${encodeURIComponent(desde)}` : ''}`,
    ),

  aplicarOperaciones: (id: string, operaciones: Operation[]) =>
    pedir<{ aplicadas: number; descripciones: string[]; diagrama: ClassDiagram }>(
      `/proyectos/${id}/diagrama/operaciones`,
      { method: 'POST', body: JSON.stringify({ operaciones }) },
    ),

  // -------------------------------------------------------------------------
  // Asistente y generación
  // -------------------------------------------------------------------------

  interpretar: (id: string, texto: string) =>
    pedir<RespuestaAsistente>(`/proyectos/${id}/asistente`, {
      method: 'POST',
      body: JSON.stringify({ texto }),
    }),

  /** Lo ya hablado con el asistente en este proyecto: un hilo compartido por todo el equipo (Modo IA). */
  obtenerHistorialAsistente: (id: string) =>
    pedir<{ turnos: TurnoAsistente[] }>(`/proyectos/${id}/asistente/historial`),

  /**
   * Pregunta a la guía a través del servidor.
   *
   * Es el camino del móvil: allí no hay Ollama que valga, pero con red el
   * servidor redacta la respuesta usando el mismo manual y el mismo fragmento
   * recuperado. No cuelga de ningún proyecto porque no habla de ninguno: se
   * pregunta «¿por dónde empiezo?» antes de tener uno abierto.
   */
  preguntarGuia: (texto: string) =>
    pedir<RespuestaGuia>('/guia', { method: 'POST', body: JSON.stringify({ texto }) }),

  validar: (id: string) =>
    pedir<{ valido: boolean; errores: ProblemaValidacion[]; avisos: ProblemaValidacion[] }>(
      `/proyectos/${id}/validacion`,
    ),

  previsualizarGeneracion: (id: string, opciones: OpcionesGeneracion = {}) =>
    pedir<{ avisos: ProblemaValidacion[]; ficheros: FicheroGenerado[] }>(
      `/proyectos/${id}/generacion/previsualizacion`,
      { method: 'POST', body: JSON.stringify(opciones) },
    ),

  // -------------------------------------------------------------------------
  // Importación de una tabla fotografiada
  // -------------------------------------------------------------------------

  /**
   * Sube la foto y devuelve lo que el modelo ha leído. No escribe nada.
   *
   * `imagen` va en base64 sin el prefijo `data:`; el servidor lo tolera de todos
   * modos, pero mandarlo limpio evita cargar un tercio de más en la cadena.
   */
  leerTablaDeImagen: (id: string, imagen: string, mimeType: string) =>
    pedir<RespuestaLecturaTabla>(`/proyectos/${id}/importar-tabla/leer`, {
      method: 'POST',
      body: JSON.stringify({ imagen, mimeType }),
    }),

  /**
   * Pide las operaciones para la tabla *ya revisada por la persona*.
   *
   * Es una llamada aparte y no la continuación automática de la anterior porque
   * entre las dos ocurre lo único que garantiza que los datos sean correctos:
   * alguien mira la foto y la tabla lado a lado.
   */
  proponerImportacion: (id: string, tabla: TablaExtraida) =>
    pedir<RespuestaPropuestaTabla>(`/proyectos/${id}/importar-tabla/proponer`, {
      method: 'POST',
      body: JSON.stringify({ tabla }),
    }),

  // -------------------------------------------------------------------------
  // Importación de un diagrama de clases fotografiado
  // -------------------------------------------------------------------------

  /** Sube la foto de un diagrama entero y devuelve lo leído. No escribe nada. */
  leerDiagramaDeImagen: (id: string, imagen: string, mimeType: string) =>
    pedir<RespuestaLecturaDiagrama>(`/proyectos/${id}/importar-diagrama/leer`, {
      method: 'POST',
      body: JSON.stringify({ imagen, mimeType }),
    }),

  /** Pide las operaciones para el diagrama *ya revisado por la persona*. */
  proponerImportacionDiagrama: (id: string, diagrama: DiagramaExtraido) =>
    pedir<RespuestaPropuestaDiagrama>(`/proyectos/${id}/importar-diagrama/proponer`, {
      method: 'POST',
      body: JSON.stringify({ diagrama }),
    }),

  // -------------------------------------------------------------------------
  // Tablón del proyecto
  // -------------------------------------------------------------------------

  /**
   * Los últimos mensajes del tablón. Es la primera carga al abrir el panel.
   *
   * El cursor que devuelve es el que hay que pasar a `sondearTablon`, y lo
   * calcula el servidor: si lo dedujera el cliente del máximo recibido, una
   * primera carga vacía lo dejaría en cero y el siguiente sondeo se traería el
   * hilo entero otra vez.
   */
  leerTablon: (id: string) => pedir<RespuestaTablon>(`/proyectos/${id}/tablon`),

  /**
   * Lo que ha cambiado desde `desde`. Es la llamada que se repite cada pocos
   * segundos, así que devuelve una página vacía casi siempre y no gasta cuota.
   *
   * Trae también los mensajes *retirados* después de ese punto, y por eso la
   * retirada es un cambio de versión y no un borrado: a un cliente que sondea
   * no se le puede contar una ausencia.
   */
  sondearTablon: (id: string, desde: number) =>
    pedir<RespuestaTablon>(`/proyectos/${id}/tablon?desde=${String(desde)}`),

  /** La página anterior, para cuando alguien sube a leer lo de antes. */
  leerTablonAnterior: (id: string, antesDe: number) =>
    pedir<RespuestaTablon>(`/proyectos/${id}/tablon?antesDe=${String(antesDe)}`),

  publicarEnTablon: (id: string, texto: string) =>
    pedir<{ mensaje: MensajePublico }>(`/proyectos/${id}/tablon`, {
      method: 'POST',
      body: JSON.stringify({ texto }),
    }),

  /**
   * Sube una nota de voz. `audio` va en base64 sin el prefijo `data:`.
   *
   * La duración la mide el cliente porque el servidor tendría que descodificar
   * el audio para averiguarla, y eso es un decodificador de formatos ajenos
   * corriendo sobre bytes que manda cualquiera. Solo se usa para pintar la
   * barra del reproductor; el límite que de verdad protege es el de bytes.
   */
  publicarVozEnTablon: (id: string, audio: string, tipo: string, duracionMs: number) =>
    pedir<{ mensaje: MensajePublico }>(`/proyectos/${id}/tablon/voz`, {
      method: 'POST',
      body: JSON.stringify({ audio, tipo, duracionMs }),
    }),

  retirarDelTablon: (id: string, mensajeId: string) =>
    pedir<{ mensaje: MensajePublico }>(`/proyectos/${id}/tablon/${mensajeId}`, {
      method: 'DELETE',
    }),

  /**
   * Descarga los bytes de una nota de voz.
   *
   * No devuelve una URL con el token en la consulta, que es el atajo evidente
   * para poder escribirla directamente en el `src` de un `<audio>`. Esa URL
   * acaba en el historial, en la caché del disco y en cualquier registro de
   * accesos que haya delante, y ahí el token vale para todo, no solo para este
   * audio. Se baja con la cabecera de siempre y el componente hace un
   * `URL.createObjectURL` con lo que salga —y lo revoca al desmontarse, que si
   * no cada nota reproducida se queda en memoria hasta recargar la página.
   */
  descargarAudioDelTablon: (id: string, mensajeId: string) =>
    pedirBinario(`/proyectos/${id}/tablon/${mensajeId}/audio`),

  // -------------------------------------------------------------------------
  // Versiones del proyecto
  // -------------------------------------------------------------------------

  /** En orden cronológico ascendente, igual que la respuesta del servidor. */
  listarVersiones: (id: string) => pedir<{ versiones: VersionResumen[] }>(`/proyectos/${id}/versiones`),

  crearVersion: (id: string, mensaje: string) =>
    pedir<{ version: VersionResumen }>(`/proyectos/${id}/versiones`, {
      method: 'POST',
      body: JSON.stringify({ mensaje }),
    }),

  /** El diagrama de una versión guardada, sin tocar el documento en vivo: para comparar, no para restaurar. */
  verVersion: (id: string, versionId: string) =>
    pedir<{ version: VersionResumen; diagrama: ClassDiagram }>(`/proyectos/${id}/versiones/${versionId}`),

  /** Sustituye el diagrama en vivo por el de esta versión. Solo `owner`. */
  restaurarVersion: (id: string, versionId: string) =>
    pedir<{ diagrama: ClassDiagram }>(`/proyectos/${id}/versiones/${versionId}/restaurar`, {
      method: 'POST',
    }),
};

export interface RelacionRevisada {
  origen: string;
  destino: string;
  tipo: RelationKind;
  cardinalidadOrigen: string;
  cardinalidadDestino: string;
  /** El modelo no pudo leer la cardinalidad y esta es la que se ha supuesto. */
  dudosa: boolean;
}

export interface ResumenDiagramaLeido {
  clases: number;
  atributos: number;
  relaciones: number;
  filas: number;
  cardinalidadesDudosas: number;
}

export interface RespuestaLecturaDiagrama {
  modelo: string;
  diagrama: DiagramaExtraido;
  clases: string[];
  relaciones: RelacionRevisada[];
  avisos: AvisoImportacion[];
  aplicable: boolean;
  resumen: ResumenDiagramaLeido;
  confianzaDeclarada: number;
}

export interface RespuestaPropuestaDiagrama {
  clases: string[];
  relaciones: RelacionRevisada[];
  avisos: AvisoImportacion[];
  aplicable: boolean;
  resumen: ResumenDiagramaLeido;
  propuesta: PropuestaAsistente[];
}

export interface RespuestaLecturaTabla {
  modelo: string;
  tabla: TablaExtraida;
  clase: string;
  avisos: AvisoImportacion[];
  aplicable: boolean;
  /**
   * Lo que el modelo dice de sí mismo. Se enseña como dato y nunca como
   * permiso: en las pruebas que motivaron este diseño declaró 1.0 mientras
   * leía mal un correo electrónico.
   */
  confianzaDeclarada: number;
}

export interface RespuestaPropuestaTabla {
  clase: string;
  avisos: AvisoImportacion[];
  aplicable: boolean;
  propuesta: PropuestaAsistente[];
}

export interface PropuestaAsistente {
  operacion: Operation;
  descripcion: string;
}

export interface RespuestaAsistente {
  motor: string;
  confianza: number;
  aclaracion: string | null;
  explicacion: string;
  propuesta: PropuestaAsistente[];
}

/**
 * Un turno del historial del Modo IA (ver `GET /:proyectoId/asistente/historial`).
 *
 * `autorId`/`autorNombre` son `null` en los turnos del propio asistente. En
 * los de un integrante llevan quién escribió ese turno: el hilo es del
 * proyecto entero, no uno privado por persona.
 */
export interface TurnoAsistente {
  role: 'user' | 'assistant';
  texto: string;
  autorId: string | null;
  autorNombre: string | null;
  creadoEn: string;
  /**
   * `'observacion'` es un comentario que la IA soltó sola, sin que nadie le
   * escribiera —ver `ai/vigilancia.ts` en el backend—, y por eso solo aparece
   * en turnos de rol `assistant`. `'respuesta'` es un turno de los de siempre.
   */
  tipo: 'respuesta' | 'observacion';
}

/** Una sección del manual tal y como la manda el servidor. */
export interface FuenteDeLaGuia {
  documento: string;
  titulo: string;
  ruta: string[];
  ancla: string;
  texto: string;
}

export interface RespuestaGuia {
  /** El modelo que redactó, o `busqueda-en-el-manual` si nadie redactó. */
  motor: string;
  /** Nulo cuando no hubo modelo: entonces la respuesta son las `fuentes`. */
  texto: string | null;
  /** Por qué no hubo modelo, cuando se esperaba que lo hubiera. */
  aviso: string | null;
  fuentes: FuenteDeLaGuia[];
}

/**
 * Un problema de validación tal y como lo manda el servidor.
 *
 * Estaba declarado como `string[]`, y como nadie compara los tipos de una
 * respuesta HTTP con lo que de verdad llega, el error salía a pantalla como
 * «[object Object]» repetido cinco veces. La lección: el tipo de una respuesta
 * ajena es una afirmación sobre el otro lado, no una comprobación.
 */
export interface ProblemaValidacion {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  elementId?: string;
  elementName?: string;
}

/** «Pedido: una clase persistente necesita identificador» */
export function describirProblema(problema: ProblemaValidacion): string {
  return problema.elementName ? `${problema.elementName}: ${problema.message}` : problema.message;
}

export interface FicheroGenerado {
  ruta: string;
  bytes: number;
  contenido: string;
}

export interface OpcionesGeneracion {
  paqueteBase?: string;
  artifactId?: string;
  estrategiaHerencia?: string;
  motorBD?: DatabaseTarget;
}

/**
 * Descarga el ZIP generado.
 *
 * Va aparte del resto porque la respuesta es binaria y con cabeceras propias:
 * pasarla por el mismo camino obligaría a que el ayudante genérico supiera de
 * `Blob`, de `Content-Disposition` y del aviso que el servidor manda en
 * `X-Avisos`, y todo eso solo lo necesita esta llamada.
 *
 * La entrega la hace `descarga.ts` y no un `<a download>` aquí mismo, porque
 * dentro de la app Android ese enlace no hace nada: no hay `DownloadListener`,
 * una `blob:` no la resuelve el `DownloadManager`, y este ZIP además sale de un
 * POST con autorización, así que no hay ninguna URL que se le pueda dar. Ver la
 * cabecera de `descarga.ts`.
 *
 * @returns los avisos del generador y dónde quedó el fichero —cadena vacía en
 * un navegador, donde la carpeta la elige él y no lo cuenta—.
 */
export async function descargarProyecto(
  id: string,
  nombreSugerido: string,
  opciones: OpcionesGeneracion = {},
): Promise<{ avisos: number; donde: string }> {
  const cabeceras = new Headers({ 'Content-Type': 'application/json' });
  if (tokenActual) cabeceras.set('Authorization', `Bearer ${tokenActual}`);

  const respuesta = await fetch(`/api/proyectos/${id}/generacion`, {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify(opciones),
  }).catch(() => {
    throw new ApiError(0, 'No hay conexión con el servidor');
  });

  if (!respuesta.ok) {
    const detalle = (await respuesta.json().catch(() => null)) as {
      error?: string;
      errores?: ProblemaValidacion[];
    } | null;
    throw new ApiError(
      respuesta.status,
      detalle?.errores?.length
        ? `${detalle.error}: ${detalle.errores.map(describirProblema).join('; ')}`
        : (detalle?.error ?? `Error ${respuesta.status}`),
      'GENERACION_FALLIDA',
    );
  }

  // Los avisos se leen antes de tocar el cuerpo: si la entrega falla lanzará, y
  // entonces ya no habría ocasión de mirar las cabeceras.
  const avisos = Number(respuesta.headers.get('X-Avisos') ?? 0);
  const bytes = new Uint8Array(await respuesta.arrayBuffer());

  const donde = await descargar(
    nombreDeFichero(nombreSugerido || 'proyecto', '.zip'),
    'application/zip',
    bytes,
  );

  return { avisos, donde };
}

/**
 * Genera el frontend Flutter y lo descarga como ZIP.
 * Llama a POST /api/proyectos/:id/generacion/flutter.
 */
export async function descargarFlutter(
  id: string,
  nombreSugerido: string,
  opciones: OpcionesGeneracion = {},
): Promise<{ donde: string }> {
  const cabeceras = new Headers({ 'Content-Type': 'application/json' });
  if (tokenActual) cabeceras.set('Authorization', `Bearer ${tokenActual}`);

  const respuesta = await fetch(`/api/proyectos/${id}/generacion/flutter`, {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify(opciones),
  }).catch(() => { throw new ApiError(0, 'No hay conexión con el servidor'); });

  if (!respuesta.ok) {
    const d = (await respuesta.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(respuesta.status, d?.error ?? `Error ${respuesta.status}`);
  }

  const bytes = new Uint8Array(await respuesta.arrayBuffer());
  const donde = await descargar(
    nombreDeFichero(`${nombreSugerido || 'proyecto'}-flutter`, '.zip'),
    'application/zip',
    bytes,
  );
  return { donde };
}

/** URL del canal colaborativo para un proyecto, con el token en la consulta. */
export function urlColaboracion(proyectoId: string, token: string): string {
  const protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocolo}//${location.host}/colaboracion?proyecto=${encodeURIComponent(
    proyectoId,
  )}&token=${encodeURIComponent(token)}`;
}

/** Utilidades de base64 para las actualizaciones Yjs, que son binarias. */
export function aBase64(bytes: Uint8Array): string {
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario);
}

export function deBase64(base64: string): Uint8Array {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return bytes;
}
