import {
  CABECERA_IDEMPOTENCIA,
  ManifiestoSchema,
  VERSION_MANIFIESTO,
  isValidJavaIdentifier,
  type Accion,
  type CampoManifiesto,
  type EntidadManifiesto,
  type Manifiesto,
  type TipoCampo,
} from '@app/shared';
import type { AssociationIR, EntityIR, FieldIR, GenerationIR } from '../ir/types.js';

/**
 * Emisor del manifiesto del asistente.
 *
 * Es una **proyección** de la IR, no una segunda normalización. Todo lo que
 * necesita ya está resuelto en `ir/normalize.ts`: `restPath` viene en plural y
 * kebab-case, los tipos Java están elegidos, las validaciones decididas y las
 * asociaciones tienen lado propietario. Este fichero se limita a traducir eso al
 * vocabulario que entiende un móvil. Si aquí apareciera una decisión —qué campo
 * es la clave ajena, cómo se pluraliza algo— estaría en el sitio equivocado y
 * habría que subirla a la IR.
 *
 * La otra mitad de su trabajo es de seguridad. Los nombres del manifiesto no
 * acaban en un fichero Java, que es lo que ya vigila el generador: acaban en una
 * **URL que construye la app** y en las etiquetas que se leen en voz alta. Es
 * una frontera nueva, así que se vuelve a validar contra lista blanca aunque los
 * nombres ya pasaran la de `validate.ts` (RNF-SEG-06). El coste es una expresión
 * regular por entidad; el fallo que evita es que una clase llamada `../admin`
 * convierta a la app en un cliente de otro servidor.
 */

/**
 * Traducción de tipo Java a tipo hablado. Es intencionadamente con pérdida: a
 * la app le da igual la diferencia entre `Integer` y `Long` —abre el mismo
 * teclado y lee el número igual—, y arrastrarla solo serviría para que el
 * intérprete tuviera dos ramas donde necesita una.
 */
const TIPOS: Record<string, TipoCampo> = {
  String: 'texto',
  Integer: 'entero',
  Long: 'entero',
  Short: 'entero',
  BigDecimal: 'decimal',
  Double: 'decimal',
  Float: 'decimal',
  Boolean: 'booleano',
  LocalDate: 'fecha',
  LocalDateTime: 'fechaHora',
  Instant: 'fechaHora',
  OffsetDateTime: 'fechaHora',
  ZonedDateTime: 'fechaHora',
  LocalTime: 'hora',
  UUID: 'uuid',
};

/**
 * Tipo de reserva cuando el catálogo no reconoce el tipo Java.
 *
 * `texto` y no un fallo: la IR ya garantiza que el tipo compila en Java, y
 * negarse a emitir el manifiesto entero porque un campo usa un tipo exótico
 * dejaría sin asistente a un proyecto que por lo demás funciona. Un campo de
 * texto libre es la degradación honesta: se puede dictar, se envía tal cual y el
 * backend lo rechazará si no vale.
 */
const TIPO_POR_DEFECTO: TipoCampo = 'texto';

/** Las cinco que emite `controller.java.hbs` para toda entidad no abstracta. */
const ACCIONES_CRUD: Accion[] = ['listar', 'ver', 'crear', 'actualizar', 'borrar'];

export function buildManifiesto(ir: GenerationIR): Manifiesto {
  const enumValues = new Map(ir.enums.map((e) => [e.className, e.values]));
  const byName = new Map(ir.entities.map((e) => [e.className, e]));

  const manifiesto: Manifiesto = {
    version: VERSION_MANIFIESTO,
    proyecto: ir.project.name,
    baseUrl: '/api',
    idioma: 'es',
    cabeceraIdempotencia: CABECERA_IDEMPOTENCIA,
    // Una entidad abstracta no se instancia y su controlador no se genera; no
    // tiene sentido ofrecerla por voz. Sus campos ya viajan heredados en cada
    // subclase concreta, así que no se pierde nada.
    entidades: ir.entities
      .filter((entity) => !entity.isAbstract)
      .map((entity) => buildEntidad(ir, entity, byName, enumValues)),
    enumerados: ir.enums.map((e) => ({ nombre: e.className, valores: [...e.values] })),
  };

  // El esquema es el contrato; comprobarlo aquí convierte un manifiesto mal
  // formado en un fallo de generación con mensaje, en vez de en un 500 dentro
  // del móvil de alguien durante la defensa.
  return ManifiestoSchema.parse(manifiesto);
}

function buildEntidad(
  ir: GenerationIR,
  entity: EntityIR,
  byName: Map<string, EntityIR>,
  enumValues: Map<string, readonly string[]>,
): EntidadManifiesto {
  assertNombreSeguro(entity.className);
  const ruta = `/${entity.restPath}`;
  assertRutaSegura(ruta);

  // Los DTOs exponen lo heredado, así que el manifiesto también: si `Empleado`
  // extiende `Persona`, quien dicte un empleado tiene que poder dictar su
  // nombre. `allFieldsOf` reproduce la misma regla que `buildEntityView`.
  const propios = allFieldsOf(entity, byName).filter((f) => !f.isIdentifier);

  const campos: CampoManifiesto[] = [
    ...propios.map((field) => buildCampo(field, enumValues)),
    ...owningToOne(entity, byName).map((assoc) => buildCampoReferencia(assoc, byName)),
  ];

  const identificador = entity.identifier;
  assertNombreSeguro(identificador.name);

  return {
    nombre: entity.className,
    ruta,
    etiquetaHablada: etiquetasHabladas(entity),
    identificador: {
      nombre: identificador.name,
      tipo: TIPOS[identificador.javaType] ?? TIPO_POR_DEFECTO,
    },
    campoEtiqueta: campoEtiqueta(propios),
    campos,
    acciones: [...ACCIONES_CRUD],
    // Crear de más molesta; borrar de más pierde datos. Solo el borrado exige
    // que el usuario diga «sí» en voz alta antes de que salga la petición.
    criticas: ['borrar'],
    borradoEnCascada: cascadas(entity, ir),
  };
}

function buildCampo(
  field: FieldIR,
  enumValues: Map<string, readonly string[]>,
): CampoManifiesto {
  assertNombreSeguro(field.name);
  const valores = field.isEnum ? enumValues.get(field.javaType) : undefined;

  return {
    nombre: field.name,
    etiqueta: enPalabras(field.name),
    tipo: field.isEnum ? 'enumerado' : (TIPOS[field.javaType] ?? TIPO_POR_DEFECTO),
    // `nullable` es la propiedad de la columna; el DTO de entrada emite
    // `@NotNull`/`@NotBlank` exactamente en ese caso. Se deriva de ahí y no del
    // array de validaciones para no depender del texto de una anotación.
    obligatorio: !field.nullable,
    soloLectura: false,
    maxLongitud: maxLongitud(field),
    ...(valores ? { valores: [...valores] } : {}),
  };
}

/**
 * Una asociación *-a-uno del lado propietario se ve desde la API como un campo
 * más: el DTO la expone como `<campo>Id`. El manifiesto la presenta igual, con
 * el nombre exacto que espera el DTO, para que la app no tenga que reconstruir
 * esa convención por su cuenta —y quedarse atrás si algún día cambia.
 */
function buildCampoReferencia(
  assoc: AssociationIR,
  byName: Map<string, EntityIR>,
): CampoManifiesto {
  assertNombreSeguro(assoc.fieldName);
  assertNombreSeguro(assoc.targetClass);

  return {
    nombre: `${assoc.fieldName}Id`,
    etiqueta: enPalabras(assoc.fieldName),
    tipo: 'referencia',
    obligatorio: !assoc.nullable,
    soloLectura: false,
    entidad: assoc.targetClass,
  };
}

/**
 * Qué se lleva por delante borrar esta entidad.
 *
 * Se lee del lado **inverso** —la colección del «todo»— porque es donde la IR
 * pone la cascada de JPA. `orphanRemoval` se exige además de `cascade` para no
 * avisar de un borrado que en realidad solo desvincula.
 *
 * Solo se listan entidades del manifiesto: una parte abstracta no aparece como
 * entidad y nombrarla en el aviso confundiría a quien lo escucha.
 */
function cascadas(entity: EntityIR, ir: GenerationIR): string[] {
  const concretas = new Set(ir.entities.filter((e) => !e.isAbstract).map((e) => e.className));

  const nombres = entity.associations
    .filter(
      (assoc) =>
        assoc.collection &&
        assoc.orphanRemoval &&
        (assoc.cascade ?? '').includes('ALL') &&
        concretas.has(assoc.targetClass),
    )
    .map((assoc) => assoc.targetClass);

  return [...new Set(nombres)].sort();
}

/**
 * Formas habladas de la entidad: singular y plural, plegadas a minúsculas sin
 * tildes y con las palabras separadas.
 *
 * El plural sale de `restPath`, que la IR ya calculó, en vez de pluralizar otra
 * vez aquí: si las dos pluralizaciones se separasen, la app pediría `/citas` y
 * diría «citaes», y nadie sabría cuál de las dos está mal.
 */
function etiquetasHabladas(entity: EntityIR): string[] {
  const singular = enPalabras(entity.varName);
  const plural = entity.restPath.replace(/-/g, ' ');
  return [...new Set([singular, plural])];
}

/**
 * El primer campo de texto obligatorio: el que sirve para nombrar un registro
 * al hablar. Se exige que sea obligatorio porque un campo opcional estaría
 * vacío justo en los registros que más cuesta identificar.
 */
function campoEtiqueta(fields: FieldIR[]): string | undefined {
  return fields.find((f) => f.javaType === 'String' && !f.nullable && !f.isEnum)?.name;
}

function maxLongitud(field: FieldIR): number | undefined {
  const declarada = field.validations
    .map((v) => v.match(/^@Size\(max = (\d+)\)$/)?.[1])
    .find((v): v is string => v !== undefined);
  return declarada ? Number(declarada) : undefined;
}

/** Igual que los campos: heredadas primero, y una propia oculta a la heredada. */
function owningToOne(entity: EntityIR, byName: Map<string, EntityIR>): AssociationIR[] {
  const heredadas: AssociationIR[] = [];
  const nombres = new Set(entity.associations.map((a) => a.fieldName));
  const visitados = new Set<string>([entity.className]);
  let actual = entity.superclass ? byName.get(entity.superclass) : undefined;

  while (actual && !visitados.has(actual.className)) {
    visitados.add(actual.className);
    const nuevas = actual.associations.filter((a) => !nombres.has(a.fieldName));
    for (const a of nuevas) nombres.add(a.fieldName);
    heredadas.unshift(...nuevas);
    actual = actual.superclass ? byName.get(actual.superclass) : undefined;
  }
  return [...heredadas, ...entity.associations].filter((a) => !a.collection && a.owning);
}

/**
 * Los campos que el DTO expone: heredados primero, luego los propios.
 *
 * Reproduce a propósito el recorrido de `inheritedFields` en `render/generate.ts`
 * en vez de importarlo: hacerlo al revés dejaría `asistente` dependiendo de
 * `render`, que a su vez tiene que llamar a `asistente` para emitir el fichero,
 * y el ciclo resultante es peor que doce líneas repetidas. Lo que impide que las
 * dos copias se separen no es compartir el código, es la prueba que compara el
 * manifiesto con los componentes reales del DTO de cada entidad del corpus.
 */
function allFieldsOf(entity: EntityIR, byName: Map<string, EntityIR>): FieldIR[] {
  const heredados: FieldIR[] = [];
  const visitados = new Set<string>([entity.className]);
  let actual = entity.superclass ? byName.get(entity.superclass) : undefined;

  while (actual && !visitados.has(actual.className)) {
    visitados.add(actual.className);
    heredados.unshift(...actual.fields.filter((f) => !f.isIdentifier));
    actual = actual.superclass ? byName.get(actual.superclass) : undefined;
  }
  return [...heredados, ...entity.fields];
}

/** `precioUnitario` → `precio unitario`. Sin tildes: se compara con lo dictado. */
function enPalabras(nombre: string): string {
  return nombre
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .trim();
}

// ---------------------------------------------------------------------------
// RNF-SEG-06 — última verificación antes de que un nombre sea una URL
// ---------------------------------------------------------------------------

const RUTA_SEGURA = /^\/[a-z0-9]+(-[a-z0-9]+)*$/;

function assertRutaSegura(ruta: string): void {
  if (!RUTA_SEGURA.test(ruta)) {
    throw new Error(
      `Ruta de manifiesto no segura: «${ruta}». ` +
        'Solo se admiten segmentos en kebab-case; no se saneará quitando caracteres.',
    );
  }
}

function assertNombreSeguro(nombre: string): void {
  if (!isValidJavaIdentifier(nombre)) {
    throw new Error(`Nombre de manifiesto no válido como identificador: «${nombre}».`);
  }
}

/**
 * Serialización del manifiesto tal y como se escribe en el proyecto generado.
 *
 * Con sangría, y no minificado, porque este fichero acaba en el repositorio del
 * alumno: quien abra el proyecto generado tiene que poder leer qué le está
 * contando su backend al móvil sin pasarlo por un formateador. Dos espacios y un
 * salto de línea final, igual que el resto de la salida del generador.
 */
export function renderManifiesto(ir: GenerationIR): string {
  return `${JSON.stringify(buildManifiesto(ir), null, 2)}\n`;
}
