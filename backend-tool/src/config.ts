import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Configuración del servicio.
 *
 * Todo lo que cambia entre entornos entra por variables de entorno.
 *
 * El secreto de sesión merece un párrafo. Antes se generaba al azar en cada
 * arranque cuando faltaba, con la idea de que fallar pronto es mejor que fallar
 * tarde. En la práctica el fallo no era evidente sino desconcertante: al
 * reiniciar el servidor todos los tokens dejaban de valer, y como el navegador
 * no puede leer el código de estado del apretón de manos rechazado, la
 * aplicación se quedaba diciendo «Sin conexión» contra un servidor que estaba
 * perfectamente. Media hora buscando un fallo de red que no existía.
 *
 * Ahora, si no viene por entorno, se genera una vez y se guarda junto a los
 * datos. Sigue avisándose —en producción el secreto debe venir del entorno, y
 * más aún con varias instancias, porque un fichero por máquina significa que
 * cada una rechaza los tokens de las otras—, pero reiniciar en desarrollo deja
 * de echar a todo el mundo.
 */

export interface Config {
  port: number;
  host: string;
  /** Orígenes admitidos por CORS. `*` solo en desarrollo. */
  corsOrigins: string[];
  sessionSecret: string;
  sessionSecretIsGenerated: boolean;
  /** Duración de la sesión en segundos. */
  sessionTtl: number;
  /** Directorio donde se persisten los documentos colaborativos. */
  dataDir: string;
  /**
   * Cadena de conexión a PostgreSQL.
   *
   * Su presencia es lo que decide el almacén: con ella, usuarios, proyectos y
   * documentos van a la base de datos; sin ella, a ficheros bajo `dataDir`.
   * Se elige así y no con un `STORAGE=postgres` aparte porque tener el modo y
   * la conexión en variables distintas permite el estado incoherente de pedir
   * PostgreSQL sin decir cuál, que solo se descubre al arrancar.
   *
   * En cualquier despliegue con sistema de ficheros efímero —App Runner, ECS,
   * Render— esto no es opcional: sin base de datos, cada despliegue borra todos
   * los proyectos.
   */
  databaseUrl?: string;
  /**
   * Directorio del frontend construido, si este servicio también lo sirve.
   *
   * Ausente en desarrollo, donde Vite sirve el frontend y hace de proxy contra
   * este servicio.
   */
  frontendDir?: string;
  /** Intervalo de volcado a disco del documento colaborativo, en ms. */
  persistIntervalMs: number;
  /** Tamaño máximo de un mensaje del canal colaborativo, en bytes. */
  maxMessageBytes: number;
  architechBaseUrl?: string;
  architechApiKey?: string;
  llmApiKey?: string;
  /**
   * Protocolo del proveedor de modelo.
   *
   * `anthropic` habla `/v1/messages` con cabecera `x-api-key`; `openai` habla
   * `/chat/completions` con `Authorization: Bearer`. DeepSeek, OpenAI, Groq,
   * Together y casi todo lo demás usan el segundo, así que un único motor
   * compatible cubre el resto del mercado sin escribir un cliente por servicio.
   */
  llmProvider: 'anthropic' | 'openai';
  llmBaseUrl?: string;
  llmModel?: string;
  /**
   * Modelo con visión, para leer tablas fotografiadas.
   *
   * Puede no existir aunque haya clave: no todos los proveedores sirven visión,
   * y el que la sirve no siempre con el mismo modelo que el texto. Si falta, la
   * importación por foto se rechaza con un mensaje claro en lugar de intentarlo
   * contra un modelo que no sabe mirar.
   */
  llmVisionModel?: string;
  /**
   * Proveedor propio para la visión, si es distinto del del texto.
   *
   * Lo habitual es dejarlos vacíos y usar un solo proveedor para todo. Existen
   * porque el reparto natural es tener el asistente de texto en algo barato y la
   * visión en el que mejor lee fotos, y sin estas dos variables había que elegir
   * un único proveedor que hiciera las dos cosas bien, que no siempre existe.
   */
  llmVisionApiKey?: string;
  llmVisionBaseUrl?: string;
  /**
   * Tokens de la IA que cada usuario puede gastar por día (UTC). Sin variable,
   * o con un valor que no sea un entero positivo, no hay límite: solo se cuenta.
   */
  llmLimiteDiarioTokens?: number;
  /**
   * Techo de la respuesta del modelo de visión, en tokens.
   *
   * Se saca a variable porque el valor bueno depende del modelo y del diagrama,
   * y el día que se quede corto conviene poder subirlo sin recompilar ni volver
   * a desplegar. Ver `MAX_TOKENS_POR_DEFECTO` en `ai/vision.ts` para el porqué
   * del valor y para qué aspecto tiene el fallo cuando este número es bajo.
   */
  llmVisionMaxTokens?: number;
  /**
   * Tamaño máximo de una imagen para OCR, en bytes.
   *
   * No es solo memoria: la imagen viaja al modelo en base64, que la agranda un
   * tercio, y cada píxel se paga en tokens. 4 MiB admite de sobra una foto de
   * móvil ya recortada y corta de raíz el envío accidental de un vídeo.
   */
  maxImageBytes: number;
  /**
   * Dónde están los documentos que la guía busca.
   *
   * Se puede cambiar por entorno porque la ruta relativa que vale en el
   * repositorio no vale dentro del contenedor, donde `docs/` se copia al lado
   * del código compilado. Si el directorio no existe, la guía no arranca y el
   * resto del servicio sí: es una función de ayuda, no un requisito para editar
   * diagramas.
   */
  docsDir: string;
}

/**
 * Carga un fichero `.env` sin sobrescribir lo que ya venga del entorno real.
 *
 * No se usa `--env-file` de Node porque esa bandera no se admite dentro de
 * `NODE_OPTIONS`, y el backend arranca a través de `tsx`, que no reenvía
 * banderas de Node. Antes que envolver el arranque en otro proceso, se leen
 * cuatro líneas aquí.
 *
 * El orden importa: lo que ya está definido en el entorno gana. Un `.env` de
 * desarrollo olvidado en el disco de producción no debe poder pisar la
 * configuración real del contenedor.
 */
export function cargarEnv(ruta?: string): void {
  const candidatos = ruta
    ? [ruta]
    : [
        resolve(process.cwd(), '.env'),
        // El backend se arranca desde su propio directorio con `--workspace`,
        // pero el `.env` vive en la raíz del repositorio, que es donde el
        // usuario espera encontrarlo.
        resolve(process.cwd(), '..', '.env'),
        resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'),
      ];

  const encontrado = candidatos.find((c) => existsSync(c));
  if (!encontrado) return;

  /*
    Las claves repetidas dentro del mismo fichero se avisan.

    `process.env[clave] !== undefined` mezcla dos situaciones que no se parecen
    en nada. Una es que la variable venga del entorno real, y ahí saltársela es
    justo lo que se quiere: el entorno manda sobre el fichero. La otra es que la
    haya puesto una línea anterior de este mismo `.env`, y eso no es una
    política, es una errata.

    Callarse la segunda sale caro, y no en teoría: alguien pegó un bloque nuevo
    de configuración al final de su `.env` sin borrar el viejo, y el backend
    siguió usando el viejo sin decir nada. Lo que veía en la pantalla al abrir
    el fichero —el bloque nuevo, treinta líneas más abajo— no era lo que el
    programa estaba usando. Tardó una tarde y dos errores del proveedor en
    aparecer, y el segundo apuntaba al modelo, que era lo único que estaba bien.

    No se aborta el arranque. Una clave repetida tiene un ganador definido y
    predecible —la primera—, así que el programa puede seguir; lo que no puede
    es dejar creer que se está aplicando la última.

    Se avisa del nombre y **nunca del valor**: en este fichero viven las claves
    de API y la cadena de conexión con su contraseña. Un aviso que las imprimiera
    en el registro las publicaría en cualquier sitio donde se recojan los
    registros, que es de las formas más tontas de filtrar un secreto.
  */
  const vistas = new Set<string>();
  const repetidas = new Set<string>();

  for (const linea of readFileSync(encontrado, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const corte = limpia.indexOf('=');
    if (corte <= 0) continue;
    const clave = limpia.slice(0, corte).trim();

    if (vistas.has(clave)) {
      repetidas.add(clave);
      continue;
    }
    vistas.add(clave);

    if (process.env[clave] !== undefined) continue;
    // Las comillas son un artefacto de escritura, no parte del valor.
    process.env[clave] = limpia
      .slice(corte + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }

  if (repetidas.size > 0) {
    console.warn(
      `Aviso: ${encontrado} define ${[...repetidas].join(', ')} más de una vez. ` +
        'Vale la primera aparición y se descartan las siguientes: si acabas de añadir ' +
        'configuración al final del fichero, no se está aplicando. Borra la vieja.',
    );
  }
}

/** Un entero positivo, o `undefined` si falta o no lo es. */
function enteroPositivo(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const valor = Number(raw.trim());
  return Number.isInteger(valor) && valor > 0 ? valor : undefined;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Lee el secreto guardado o crea uno nuevo.
 *
 * Si el fichero no se puede escribir —disco de solo lectura, permisos— se
 * devuelve igualmente un secreto en memoria: quedarse sin arrancar por no poder
 * guardar una comodidad de desarrollo sería peor que el problema que resuelve.
 */
function secretoPersistente(dataDir: string): string {
  const ruta = join(dataDir, 'secreto-de-sesion');

  try {
    const guardado = readFileSync(ruta, 'utf8').trim();
    if (guardado.length >= 32) return guardado;
  } catch {
    /* todavía no existe */
  }

  const nuevo = randomBytes(32).toString('hex');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(ruta, nuevo, { encoding: 'utf8', mode: 0o600 });
    // `mode` en `writeFileSync` no se aplica si el fichero ya existía.
    chmodSync(ruta, 0o600);
  } catch {
    /* se usa solo en memoria; el aviso de arranque ya lo cuenta */
  }
  return nuevo;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.SESSION_SECRET;
  const dataDir = env.DATA_DIR ?? './datos';

  return {
    port: intFromEnv('PORT', 3001),
    host: env.HOST ?? '0.0.0.0',
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    sessionSecret: secret ?? secretoPersistente(dataDir),
    sessionSecretIsGenerated: !secret,
    sessionTtl: intFromEnv('SESSION_TTL', 60 * 60 * 12),
    dataDir: env.DATA_DIR ?? './datos',
    databaseUrl: env.DATABASE_URL,
    frontendDir: env.FRONTEND_DIR,
    persistIntervalMs: intFromEnv('PERSIST_INTERVAL_MS', 2000),
    // 1 MiB. Una actualización Yjs normal ocupa decenas de bytes; este límite
    // solo corta mensajes anómalos antes de que lleguen a memoria.
    maxMessageBytes: intFromEnv('MAX_MESSAGE_BYTES', 1024 * 1024),
    architechBaseUrl: env.ARCHITECH_BASE_URL,
    architechApiKey: env.ARCHITECH_API_KEY,
    llmApiKey: env.LLM_API_KEY,
    llmProvider: proveedor(env.LLM_PROVIDER),
    llmBaseUrl: env.LLM_BASE_URL,
    llmModel: env.LLM_MODEL,
    llmVisionModel: env.LLM_VISION_MODEL,
    llmVisionApiKey: env.LLM_VISION_API_KEY,
    llmVisionBaseUrl: env.LLM_VISION_BASE_URL,
    llmLimiteDiarioTokens: enteroPositivo(env.LLM_LIMITE_DIARIO_TOKENS),
    // Sin variable se deja `undefined` en vez de poner aquí un número: así el
    // valor por defecto vive en un solo sitio, junto a la explicación de por qué
    // es ese, y no repetido en dos ficheros que se separarán con el tiempo.
    llmVisionMaxTokens: env.LLM_VISION_MAX_TOKENS
      ? intFromEnv('LLM_VISION_MAX_TOKENS', 0) || undefined
      : undefined,
    maxImageBytes: intFromEnv('MAX_IMAGE_BYTES', 4 * 1024 * 1024),
    // Por defecto, `docs/` de la raíz del repositorio: se resuelve desde este
    // fichero y no desde `process.cwd()`, que cambia según desde dónde se
    // arranque el servicio.
    docsDir:
      env.DOCS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs'),
  };
}

/**
 * Traduce el nombre del servicio al protocolo que habla.
 *
 * Se acepta el nombre comercial («deepseek», «openai») además del protocolo
 * porque es lo que el usuario tiene en la cabeza al escribir el `.env`. Ante un
 * nombre desconocido se elige el compatible con OpenAI, que es lo que sirve casi
 * todo el mundo; equivocarse hacia Anthropic dejaría sin funcionar a cualquier
 * proveedor nuevo.
 */
function proveedor(raw: string | undefined): 'anthropic' | 'openai' {
  return (raw ?? '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}
