import { z } from 'zod';

/**
 * Modelo canónico UML. Fuente única de verdad para frontend, backend y generador
 * (RNF-MAN-04). Los esquemas Zod son la definición primaria; los tipos de
 * TypeScript se infieren de ellos para que validación y tipado no diverjan.
 */

export const IdSchema = z.string().min(1).max(64);

export const VisibilitySchema = z.enum(['+', '-', '#', '~']);

export const ClassKindSchema = z.enum(['class', 'interface', 'enum', 'abstract']);

export const RelationKindSchema = z.enum([
  'association',
  'aggregation',
  'composition',
  'inheritance',
  'realization',
  'dependency',
]);

/** `1`, `0..1`, `*`, `1..*`, `0..*`, `2..5` */
export const MULTIPLICITY_PATTERN = /^(\*|\d+|\d+\.\.(\d+|\*))$/;

export const MultiplicitySchema = z
  .string()
  .regex(MULTIPLICITY_PATTERN, 'Multiplicidad no válida (use 1, 0..1, *, 1..*, n..m)');

export const TypeRefSchema = z.object({
  /** Nombre del tipo: primitivo del catálogo o nombre de una clase del diagrama. */
  name: z.string().min(1),
  /** Colección: el atributo es una lista del tipo indicado. */
  collection: z.boolean().default(false),
});

export const AttributeSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  type: TypeRefSchema,
  visibility: VisibilitySchema.default('-'),
  multiplicity: MultiplicitySchema.optional(),
  defaultValue: z.string().optional(),
  isStatic: z.boolean().default(false),
  isFinal: z.boolean().default(false),
  /** Marca de clave primaria. Requerido para entidades persistentes (RF-GEN-11). */
  isIdentifier: z.boolean().default(false),
  /** Restricción de unicidad a nivel de columna. */
  isUnique: z.boolean().default(false),
  /** Admite nulos. Las claves primarias siempre son no nulas. */
  isNullable: z.boolean().default(true),
});

export const ParameterSchema = z.object({
  name: z.string().min(1),
  type: TypeRefSchema,
});

export const MethodSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  parameters: z.array(ParameterSchema).default([]),
  returnType: TypeRefSchema.nullable().default(null),
  visibility: VisibilitySchema.default('+'),
  isStatic: z.boolean().default(false),
  isAbstract: z.boolean().default(false),
});

export const PositionSchema = z.object({ x: z.number(), y: z.number() });
export const SizeSchema = z.object({ w: z.number().positive(), h: z.number().positive() });

/**
 * Una fila de datos iniciales, indexada por *nombre de atributo*.
 *
 * Podría haber sido una lista posicional —es lo que devuelve el OCR y lo que
 * ocupa menos— pero entonces reordenar o borrar un atributo desplazaría en
 * silencio todos los valores una columna, y nadie relacionaría el desaguisado
 * con el clic que lo causó. Con nombres, borrar un atributo deja huérfano su
 * valor y ya está.
 *
 * Todos los valores son cadenas. La conversión al tipo de la columna la hace el
 * generador al escribir el SQL, que es el único sitio que sabe si `2500.50` va
 * entre comillas o no. Un valor ausente significa NULL; la cadena vacía
 * significa cadena vacía, y son cosas distintas.
 */
export const SeedRowSchema = z.record(z.string().min(1), z.string());

/**
 * Un módulo: un trozo del diagrama que se genera en su propio subpaquete.
 *
 * Existe por una razón concreta y comprobable: cambia las rutas que escribe el
 * generador. Sin módulos, `Pedido` sale en `com.ejemplo.tienda.domain`; dentro
 * del módulo `ventas` sale en `com.ejemplo.tienda.ventas.domain`, con su
 * repositorio, su servicio y su controlador al lado. Si no cambiara nada de lo
 * que se escribe sería una pegatina, y para eso no hace falta un esquema.
 *
 * `packageSegment` es **un solo segmento**, no una ruta. El paquete completo lo
 * compone el generador concatenando `meta.basePackage`. Esa decisión no es
 * estética: al no aceptar puntos, un módulo no puede colocarse fuera del
 * paquete base ni subir por el árbol, por mucho que se escriba en su nombre
 * (RNF-SEG-06).
 */
export const UmlModuleSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /** Segmento de paquete Java en minúsculas: `ventas`, `inventario`. */
  packageSegment: z.string().min(1),
  description: z.string().default(''),
});

export const UmlClassSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  kind: ClassKindSchema.default('class'),
  stereotype: z.string().optional(),
  attributes: z.array(AttributeSchema).default([]),
  methods: z.array(MethodSchema).default([]),
  /** Solo para kind === 'enum'. */
  literals: z.array(z.string().min(1)).default([]),
  position: PositionSchema.default({ x: 0, y: 0 }),
  size: SizeSchema.default({ w: 220, h: 120 }),
  /** Excluir de la generación de persistencia (clase auxiliar, DTO manual, etc.). */
  transient: z.boolean().default(false),
  /**
   * Filas de ejemplo que el proyecto generado insertará al arrancar.
   *
   * Es lo que hace que una tabla leída de una foto llegue entera al destino: la
   * estructura se convierte en clase y las filas viajan hasta el `data.sql` de
   * la migración. No son datos de producción ni pretenden serlo.
   */
  seedRows: z.array(SeedRowSchema).default([]),
  /**
   * Módulo al que pertenece la clase, o `null` si cuelga directamente del
   * paquete base.
   *
   * El valor por omisión es `null` a propósito: un diagrama que nunca ha oído
   * hablar de módulos genera exactamente los mismos ficheros que antes de que
   * esto existiera. La funcionalidad se activa creando un módulo, no con un
   * interruptor de configuración.
   */
  moduleId: IdSchema.nullable().default(null),
});

export const EndPointSchema = z.object({
  classId: IdSchema,
  role: z.string().optional(),
  multiplicity: MultiplicitySchema.default('1'),
  navigable: z.boolean().default(true),
});

export const UmlRelationSchema = z.object({
  id: IdSchema,
  kind: RelationKindSchema,
  name: z.string().optional(),
  source: EndPointSchema,
  target: EndPointSchema,
  /**
   * Clase de asociación (UML): una clase que cuelga de esta relación —no de uno
   * de sus dos extremos— y guarda los atributos propios del vínculo (`cantidad`,
   * `subtotal`... en una relación Venta–Producto). Es un campo de la relación y
   * no una relación aparte porque no hay un tercer extremo: es la misma relación
   * N:M vista con datos, como en el símbolo de StarUML/Visual Paradigm.
   *
   * Solo tiene sentido sobre una asociación muchos a muchos: `setAssociationClass`
   * (`shared/src/ops/operations.ts`) y `validateAssociationClasses`
   * (`shared/src/validation/validate.ts`) lo exigen antes de que llegue aquí.
   * Sobre cualquier otra multiplicidad la clase del lado «muchos» ya es esa fila,
   * y no hace falta una tercera clase para guardar lo mismo.
   */
  associationClassId: IdSchema.optional(),
});

export const DiagramMetaSchema = z.object({
  /** Paquete base del proyecto generado. */
  basePackage: z.string().default('com.ejemplo.proyecto'),
  artifactId: z.string().default('proyecto'),
  description: z.string().default(''),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const ClassDiagramSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  classes: z.record(IdSchema, UmlClassSchema).default({}),
  relations: z.record(IdSchema, UmlRelationSchema).default({}),
  modules: z.record(IdSchema, UmlModuleSchema).default({}),
  meta: DiagramMetaSchema.default({}),
});

export type Id = z.infer<typeof IdSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type ClassKind = z.infer<typeof ClassKindSchema>;
export type RelationKind = z.infer<typeof RelationKindSchema>;
export type Multiplicity = z.infer<typeof MultiplicitySchema>;
export type TypeRef = z.infer<typeof TypeRefSchema>;
export type Attribute = z.infer<typeof AttributeSchema>;
export type Parameter = z.infer<typeof ParameterSchema>;
export type Method = z.infer<typeof MethodSchema>;
export type SeedRow = z.infer<typeof SeedRowSchema>;
export type UmlModule = z.infer<typeof UmlModuleSchema>;
export type UmlClass = z.infer<typeof UmlClassSchema>;
export type EndPoint = z.infer<typeof EndPointSchema>;
export type UmlRelation = z.infer<typeof UmlRelationSchema>;
export type DiagramMeta = z.infer<typeof DiagramMetaSchema>;
export type ClassDiagram = z.infer<typeof ClassDiagramSchema>;

// ---------------------------------------------------------------------------
// Utilidades de multiplicidad
// ---------------------------------------------------------------------------

/**
 * Si un tipo de relación admite cardinalidad.
 *
 * La herencia y la realización no la llevan: «Perro hereda de Animal» no tiene
 * multiplicidad en ninguno de sus dos extremos, y no es que se desconozca, es
 * que no existe.
 *
 * Vive aquí, junto a `RelationKind`, porque es un hecho del modelo UML y no de
 * ninguno de sus tres consumidores. Estuvo escrita tres veces —en el intérprete
 * de fotos, en el descriptor de operaciones y, a medias, en la pantalla de
 * revisión— y las copias se separaron: el servidor sabía que una herencia sin
 * cardinalidad está bien; la pantalla no, y pintaba de rojo dos filas correctas
 * pidiendo que se arreglara algo que no estaba roto. Un aviso que no
 * corresponde a un problema es peor que ninguno: enseña a ignorar los avisos, y
 * el día que uno sea de verdad también se ignorará.
 */
export function llevaCardinalidad(kind: RelationKind): boolean {
  return kind !== 'inheritance' && kind !== 'realization';
}

export interface ParsedMultiplicity {
  lower: number;
  /** `null` representa `*` (sin cota superior). */
  upper: number | null;
}

export function parseMultiplicity(value: string): ParsedMultiplicity {
  if (value === '*') return { lower: 0, upper: null };
  if (!value.includes('..')) {
    const n = Number.parseInt(value, 10);
    return { lower: n, upper: n };
  }
  const [rawLower, rawUpper] = value.split('..') as [string, string];
  return {
    lower: Number.parseInt(rawLower, 10),
    upper: rawUpper === '*' ? null : Number.parseInt(rawUpper, 10),
  };
}

/** Un extremo es "a muchos" si su cota superior es mayor que 1 o no está acotada. */
export function isToMany(multiplicity: string): boolean {
  const { upper } = parseMultiplicity(multiplicity);
  return upper === null || upper > 1;
}

export function isRequired(multiplicity: string): boolean {
  return parseMultiplicity(multiplicity).lower >= 1;
}

/**
 * La cardinalidad de una relación dicha en castellano: «uno a muchos».
 *
 * Se usa en la interfaz y en las descripciones del asistente porque `1` y `0..*`
 * son notación UML, y quien está montando el modelo de datos piensa en «un
 * cliente tiene muchos pedidos». Que las dos formas aparezcan juntas es
 * deliberado: la frase enseña a leer la notación, que es la que acaba
 * decidiendo si el generador emite `@OneToMany` o `@ManyToMany`.
 */
export function describeCardinality(source: string, target: string): string {
  const lado = (m: string): string => (isToMany(m) ? 'muchos' : 'uno');
  return `${lado(source)} a ${lado(target)}`;
}

// ---------------------------------------------------------------------------
// Consultas sobre el diagrama
// ---------------------------------------------------------------------------

export function listClasses(diagram: ClassDiagram): UmlClass[] {
  return Object.values(diagram.classes);
}

export function listRelations(diagram: ClassDiagram): UmlRelation[] {
  return Object.values(diagram.relations);
}

export function getClass(diagram: ClassDiagram, id: Id): UmlClass | undefined {
  return diagram.classes[id];
}

export function listModules(diagram: ClassDiagram): UmlModule[] {
  return Object.values(diagram.modules);
}

export function getModule(diagram: ClassDiagram, id: Id): UmlModule | undefined {
  return diagram.modules[id];
}

/**
 * Clases asignadas a un módulo. Con `null`, las que no están en ninguno.
 *
 * Un `moduleId` que apunta a un módulo borrado cuenta como sin asignar. Es la
 * situación normal cuando dos personas editan a la vez: una borra el módulo
 * mientras la otra le mete una clase, y el CRDT deja las dos operaciones. La
 * alternativa —tratarlo como error— convertiría una carrera perfectamente
 * corriente en un diagrama que no se puede generar.
 */
export function classesInModule(diagram: ClassDiagram, moduleId: Id | null): UmlClass[] {
  return listClasses(diagram).filter((cls) => resolveModuleId(diagram, cls) === moduleId);
}

/** El `moduleId` de la clase, o `null` si no tiene o si apunta a un módulo que ya no existe. */
export function resolveModuleId(diagram: ClassDiagram, cls: UmlClass): Id | null {
  if (cls.moduleId === null) return null;
  return diagram.modules[cls.moduleId] ? cls.moduleId : null;
}

/**
 * El paquete del que cuelgan las capas de esta clase.
 *
 * Es la función que hace que un módulo sea algo más que una etiqueta: el
 * generador construye desde aquí las rutas de `domain/`, `repository/`,
 * `service/`, `controller/` y `dto/`. Sin módulo devuelve el paquete base tal
 * cual, que es exactamente lo que devolvía antes de que los módulos
 * existieran.
 */
export function packageForClass(diagram: ClassDiagram, cls: UmlClass): string {
  const moduleId = resolveModuleId(diagram, cls);
  if (moduleId === null) return diagram.meta.basePackage;
  const modulo = diagram.modules[moduleId];
  if (!modulo) return diagram.meta.basePackage;
  return `${diagram.meta.basePackage}.${modulo.packageSegment}`;
}

/** Clases que se materializan como tabla: ni interfaces, ni enums, ni transitorias. */
export function isPersistent(cls: UmlClass): boolean {
  return !cls.transient && cls.kind !== 'interface' && cls.kind !== 'enum';
}

/** Superclase directa según las relaciones de herencia (`source` extiende `target`). */
export function findSuperclass(
  diagram: ClassDiagram,
  classId: Id,
): UmlClass | undefined {
  const relation = listRelations(diagram).find(
    (r) => r.kind === 'inheritance' && r.source.classId === classId,
  );
  if (!relation) return undefined;
  return diagram.classes[relation.target.classId];
}

/** Interfaces que la clase realiza. */
export function findRealizedInterfaces(
  diagram: ClassDiagram,
  classId: Id,
): UmlClass[] {
  return listRelations(diagram)
    .filter((r) => r.kind === 'realization' && r.source.classId === classId)
    .map((r) => diagram.classes[r.target.classId])
    .filter((c): c is UmlClass => c !== undefined);
}
