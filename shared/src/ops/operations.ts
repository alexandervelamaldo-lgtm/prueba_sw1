import { z } from 'zod';
import {
  ClassKindSchema,
  MultiplicitySchema,
  RelationKindSchema,
  VisibilitySchema,
  describeCardinality,
  llevaCardinalidad,
  type RelationKind,
} from '../model/uml.js';
import { isValidJavaPackageSegment } from '../model/naming.js';

/**
 * Operaciones de dominio.
 *
 * Es el único canal por el que se modifica el diagrama, lo use el ratón, el
 * teclado, el asistente de voz o el reconocimiento de pizarra
 * ([Arquitectura §2.6.2], decisión D6). Que todos compartan camino es lo que
 * hace que RF-IA-05 (deshacer atómico de una operación del asistente) sea
 * trivial en lugar de un caso especial.
 *
 * También es el esquema de salida obligatorio del intérprete de lenguaje
 * natural: el modelo nunca devuelve texto libre ni código, devuelve
 * operaciones que se validan aquí antes de mostrarse al usuario. Una salida
 * que no valida se descarta sin tocar el diagrama (RNF-IA-06).
 */

/** Referencia a una clase por identificador o por nombre. El asistente usa nombres. */
export const ClassRefSchema = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ name: z.string().min(1) }),
]);

export const AddClassOpSchema = z.object({
  op: z.literal('addClass'),
  name: z.string().min(1),
  kind: ClassKindSchema.default('class'),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const RenameClassOpSchema = z.object({
  op: z.literal('renameClass'),
  ref: ClassRefSchema,
  name: z.string().min(1),
});

export const RemoveClassOpSchema = z.object({
  op: z.literal('removeClass'),
  ref: ClassRefSchema,
});

export const MoveClassOpSchema = z.object({
  op: z.literal('moveClass'),
  ref: ClassRefSchema,
  position: z.object({ x: z.number(), y: z.number() }),
});

export const SetClassKindOpSchema = z.object({
  op: z.literal('setClassKind'),
  ref: ClassRefSchema,
  kind: ClassKindSchema,
});

export const AddAttributeOpSchema = z.object({
  op: z.literal('addAttribute'),
  classRef: ClassRefSchema,
  name: z.string().min(1),
  type: z.string().min(1),
  visibility: VisibilitySchema.default('-'),
  isIdentifier: z.boolean().default(false),
  isNullable: z.boolean().default(true),
  isUnique: z.boolean().default(false),
});

export const UpdateAttributeOpSchema = z.object({
  op: z.literal('updateAttribute'),
  classRef: ClassRefSchema,
  attributeName: z.string().min(1),
  changes: z.object({
    name: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    visibility: VisibilitySchema.optional(),
    isIdentifier: z.boolean().optional(),
    isNullable: z.boolean().optional(),
    isUnique: z.boolean().optional(),
  }),
});

export const RemoveAttributeOpSchema = z.object({
  op: z.literal('removeAttribute'),
  classRef: ClassRefSchema,
  attributeName: z.string().min(1),
});

export const AddMethodOpSchema = z.object({
  op: z.literal('addMethod'),
  classRef: ClassRefSchema,
  name: z.string().min(1),
  returnType: z.string().nullable().default(null),
  parameters: z
    .array(z.object({ name: z.string().min(1), type: z.string().min(1) }))
    .default([]),
  visibility: VisibilitySchema.default('+'),
});

export const RemoveMethodOpSchema = z.object({
  op: z.literal('removeMethod'),
  classRef: ClassRefSchema,
  methodName: z.string().min(1),
});

export const AddRelationOpSchema = z.object({
  op: z.literal('addRelation'),
  kind: RelationKindSchema,
  source: ClassRefSchema,
  target: ClassRefSchema,
  sourceMultiplicity: MultiplicitySchema.default('1'),
  targetMultiplicity: MultiplicitySchema.default('1'),
  name: z.string().optional(),
  /**
   * Atajo de "crear en un solo gesto": crea la clase de asociación y la
   * cuelga de esta relación en la misma operación, en vez de exigir un
   * `addClass` + `setAssociationClass` por separado. Existe porque el lienzo
   * ofrece la herramienta "asociación de clase" como una única acción de
   * arrastre, y las operaciones de un mismo array no pueden referenciar el id
   * que genera otra operación anterior del mismo array: sin este campo el
   * atajo sería imposible de construir desde el cliente.
   *
   * Solo tiene efecto si la relación resultante es N:M (ver `isToMany`); de lo
   * contrario la aplicación falla con un error, igual que `setAssociationClass`.
   */
  associationClassName: z.string().min(1).optional(),
});

/**
 * Cambia una relación ya dibujada sin tener que rehacerla.
 *
 * Existe porque la multiplicidad no es un adorno del diagrama: es lo que decide
 * si el generador emite `@ManyToOne`, `@OneToMany` o `@ManyToMany`, y con ello
 * si en la base de datos hay una clave foránea o una tabla de unión. Quien
 * arrastra una flecha entre dos clases todavía no está pensando en eso; lo
 * piensa después, mirando el diagrama entero. Sin esta operación, corregir un
 * «uno a muchos» obligaba a borrar la relación y volver a trazarla, que además
 * de incómodo pierde el nombre y los roles que ya se hubieran puesto.
 *
 * Los cambios son parciales a propósito: mandar la relación entera desde el
 * cliente haría que dos personas editando extremos distintos de la misma flecha
 * se pisaran, cuando en realidad no están tocando lo mismo.
 */
export const UpdateRelationOpSchema = z.object({
  op: z.literal('updateRelation'),
  id: z.string().min(1),
  changes: z
    .object({
      kind: RelationKindSchema,
      name: z.string(),
      sourceMultiplicity: MultiplicitySchema,
      targetMultiplicity: MultiplicitySchema,
      sourceRole: z.string(),
      targetRole: z.string(),
    })
    .partial(),
});

export const RemoveRelationOpSchema = z.object({
  op: z.literal('removeRelation'),
  id: z.string().min(1),
});

/**
 * Cuelga (o descuelga, con `classRef: null`) una clase de asociación (UML) de
 * una relación N:M ya existente.
 *
 * Es una operación aparte y no un campo más de `changes` en `updateRelation`
 * porque referencia otra entidad del diagrama —una clase— y hace falta
 * resolverla por nombre o por id igual que en `assignClassToModule`, mientras
 * que los `changes` de `updateRelation` son valores planos que se escriben tal
 * cual, sin resolución previa.
 */
export const SetAssociationClassOpSchema = z.object({
  op: z.literal('setAssociationClass'),
  relationId: z.string().min(1),
  classRef: ClassRefSchema.nullable(),
});

export const AddEnumLiteralOpSchema = z.object({
  op: z.literal('addEnumLiteral'),
  classRef: ClassRefSchema,
  literal: z.string().min(1),
});

/**
 * Sustituye por completo los datos iniciales de una clase.
 *
 * Reemplaza en vez de añadir porque es lo que hace falta para importar una tabla
 * leída de una foto: el usuario ha revisado *esa* tabla entera y aprueba *ese*
 * contenido. Una operación que añadiese dejaría duplicados en cuanto alguien
 * repitiera la importación tras corregir una errata, que es exactamente lo que
 * va a pasar.
 *
 * El límite de 500 filas no es arbitrario: cada fila viaja por el canal
 * colaborativo y se guarda en el documento CRDT, que se transmite entero a cada
 * usuario que se conecta. Esto son datos de ejemplo para arrancar un proyecto,
 * no un mecanismo de carga masiva.
 */
export const SetSeedRowsOpSchema = z.object({
  op: z.literal('setSeedRows'),
  classRef: ClassRefSchema,
  rows: z.array(z.record(z.string().min(1), z.string())).max(500),
});

/** Borra una fila de datos iniciales. El índice es de base 1, como se dicta. */
export const RemoveSeedRowOpSchema = z.object({
  op: z.literal('removeSeedRow'),
  classRef: ClassRefSchema,
  index: z.number().int().min(1),
});

// ---------------------------------------------------------------------------
// Módulos
// ---------------------------------------------------------------------------

/**
 * El segmento de paquete de un módulo, validado aquí y no más tarde.
 *
 * Este es el punto por el que un módulo entra al sistema, venga del formulario,
 * de una orden dictada o de la respuesta de un modelo de lenguaje. Y el valor
 * acaba siendo un tramo de `package …;` y un nombre de carpeta dentro del ZIP,
 * así que es entrada no confiable en el sentido de RNF-SEG-06: se acepta lo que
 * encaja con la lista blanca y se rechaza lo demás. No se limpia, no se
 * transforma, no se le quitan los puntos a `../..` para dejarlo pasar.
 */
const PackageSegmentSchema = z
  .string()
  .min(1)
  .refine(isValidJavaPackageSegment, {
    message:
      'El paquete del módulo debe ser un único segmento Java en minúsculas (ventas, inventario)',
  });

export const AddModuleOpSchema = z.object({
  op: z.literal('addModule'),
  name: z.string().min(1),
  packageSegment: PackageSegmentSchema,
  description: z.string().default(''),
});

export const UpdateModuleOpSchema = z.object({
  op: z.literal('updateModule'),
  id: z.string().min(1),
  changes: z
    .object({
      name: z.string().min(1),
      packageSegment: PackageSegmentSchema,
      description: z.string(),
    })
    .partial(),
});

/**
 * Borra el módulo, no sus clases.
 *
 * Las clases que estaban dentro vuelven a colgar del paquete base, que es donde
 * estaban antes de que existiera el módulo. Arrastrarlas al borrarlo convertiría
 * un cambio de organización en una pérdida de trabajo.
 */
export const RemoveModuleOpSchema = z.object({
  op: z.literal('removeModule'),
  id: z.string().min(1),
});

/** Mueve una clase a un módulo, o la saca de todos con `null`. */
export const AssignClassToModuleOpSchema = z.object({
  op: z.literal('assignClassToModule'),
  classRef: ClassRefSchema,
  moduleId: z.string().min(1).nullable(),
});

export const OperationSchema = z.discriminatedUnion('op', [
  AddClassOpSchema,
  RenameClassOpSchema,
  RemoveClassOpSchema,
  MoveClassOpSchema,
  SetClassKindOpSchema,
  AddAttributeOpSchema,
  UpdateAttributeOpSchema,
  RemoveAttributeOpSchema,
  AddMethodOpSchema,
  RemoveMethodOpSchema,
  AddRelationOpSchema,
  UpdateRelationOpSchema,
  RemoveRelationOpSchema,
  SetAssociationClassOpSchema,
  AddEnumLiteralOpSchema,
  SetSeedRowsOpSchema,
  RemoveSeedRowOpSchema,
  AddModuleOpSchema,
  UpdateModuleOpSchema,
  RemoveModuleOpSchema,
  AssignClassToModuleOpSchema,
]);

export type Operation = z.infer<typeof OperationSchema>;
export type OperationKind = Operation['op'];

/**
 * Respuesta del intérprete de lenguaje natural.
 * `clarification` permite al modelo pedir una aclaración en vez de inventar.
 */
export const AssistantResponseSchema = z.object({
  operations: z.array(OperationSchema).default([]),
  confidence: z.number().min(0).max(1).default(0),
  clarification: z.string().nullable().default(null),
  explanation: z.string().default(''),
});

export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;

/**
 * Valida una respuesta del modelo. Devuelve un resultado en lugar de lanzar,
 * porque una salida inválida es un caso esperado, no excepcional: se descarta y
 * se pide reformular.
 */
export function parseAssistantResponse(
  raw: unknown,
): { ok: true; value: AssistantResponse } | { ok: false; error: string } {
  const result = AssistantResponseSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('; '),
  };
}

/**
 * Los nombres de relación en castellano.
 *
 * Estaban saliendo a pantalla en inglés («association → Pedido») porque la
 * descripción interpolaba directamente el valor del enum. Es el idioma del
 * código filtrándose a la interfaz: quien lee el panel no tiene por qué saber
 * cómo se llama el literal en el esquema.
 */
export const RELATION_KIND_LABELS: Record<RelationKind, string> = {
  association: 'asociación',
  aggregation: 'agregación',
  composition: 'composición',
  inheritance: 'herencia',
  realization: 'realización',
  dependency: 'dependencia',
};

/** Descripción legible de una operación, para la previsualización (RF-IA-04). */
export function describeOperation(op: Operation): string {
  const refName = (ref: z.infer<typeof ClassRefSchema>): string =>
    'name' in ref ? ref.name : ref.id;

  switch (op.op) {
    case 'addClass':
      return `Crear ${op.kind === 'class' ? 'clase' : op.kind} «${op.name}»`;
    case 'renameClass':
      return `Renombrar «${refName(op.ref)}» a «${op.name}»`;
    case 'removeClass':
      return `Eliminar la clase «${refName(op.ref)}»`;
    case 'moveClass':
      return `Mover «${refName(op.ref)}»`;
    case 'setClassKind':
      return `Convertir «${refName(op.ref)}» en ${op.kind}`;
    case 'addAttribute':
      return `Añadir atributo «${op.name}: ${op.type}» a «${refName(op.classRef)}»`;
    case 'updateAttribute':
      return `Modificar el atributo «${op.attributeName}» de «${refName(op.classRef)}»`;
    case 'removeAttribute':
      return `Eliminar el atributo «${op.attributeName}» de «${refName(op.classRef)}»`;
    case 'addMethod':
      return `Añadir método «${op.name}()» a «${refName(op.classRef)}»`;
    case 'removeMethod':
      return `Eliminar el método «${op.methodName}» de «${refName(op.classRef)}»`;
    case 'addRelation': {
      const etiqueta = RELATION_KIND_LABELS[op.kind];
      const base = `Crear ${etiqueta} entre «${refName(op.source)}» y «${refName(op.target)}»`;
      // Decir «uno a uno» sobre una herencia sería ruido que además sugiere que
      // se puede cambiar, y no se puede.
      if (!llevaCardinalidad(op.kind)) return base;
      const conCardinalidad = `${base} (${describeCardinality(op.sourceMultiplicity, op.targetMultiplicity)})`;
      if (!op.associationClassName) return conCardinalidad;
      return `${conCardinalidad} con clase de asociación «${op.associationClassName}»`;
    }
    case 'updateRelation': {
      const { changes } = op;
      const partes: string[] = [];
      if (changes.kind) partes.push(`pasa a ser ${RELATION_KIND_LABELS[changes.kind]}`);
      if (changes.sourceMultiplicity !== undefined || changes.targetMultiplicity !== undefined) {
        partes.push(
          `queda en ${changes.sourceMultiplicity ?? '?'} → ${changes.targetMultiplicity ?? '?'}`,
        );
      }
      if (changes.sourceRole !== undefined || changes.targetRole !== undefined) {
        partes.push('cambia los roles');
      }
      if (changes.name !== undefined) partes.push(`se llama «${changes.name}»`);
      return partes.length > 0
        ? `Modificar la relación: ${partes.join(', ')}`
        : 'Modificar la relación';
    }
    case 'removeRelation':
      return `Eliminar una relación`;
    case 'setAssociationClass':
      return op.classRef === null
        ? 'Quitar la clase de asociación de una relación'
        : `Usar «${refName(op.classRef)}» como clase de asociación de una relación`;
    case 'addEnumLiteral':
      return `Añadir literal «${op.literal}» a «${refName(op.classRef)}»`;
    case 'setSeedRows':
      return op.rows.length === 0
        ? `Vaciar los datos iniciales de «${refName(op.classRef)}»`
        : `Fijar ${op.rows.length} fila(s) de datos iniciales en «${refName(op.classRef)}»`;
    case 'removeSeedRow':
      return `Eliminar la fila ${op.index} de datos de «${refName(op.classRef)}»`;
    case 'addModule':
      return `Crear el módulo «${op.name}» (paquete ${op.packageSegment})`;
    case 'updateModule': {
      const { changes } = op;
      const partes: string[] = [];
      if (changes.name !== undefined) partes.push(`se llama «${changes.name}»`);
      // El cambio de paquete se nombra aparte porque no es cosmético: mueve de
      // sitio todos los ficheros que el generador escriba para ese módulo.
      if (changes.packageSegment !== undefined) {
        partes.push(`pasa al paquete ${changes.packageSegment}`);
      }
      if (changes.description !== undefined) partes.push('cambia la descripción');
      return partes.length > 0
        ? `Modificar el módulo: ${partes.join(', ')}`
        : 'Modificar el módulo';
    }
    case 'removeModule':
      return 'Eliminar un módulo; sus clases vuelven al paquete base';
    case 'assignClassToModule':
      return op.moduleId === null
        ? `Sacar «${refName(op.classRef)}» de su módulo`
        : `Mover «${refName(op.classRef)}» a otro módulo`;
  }
}

// ---------------------------------------------------------------------------
// Acciones críticas
// ---------------------------------------------------------------------------

/**
 * Operaciones que destruyen trabajo (RF-IA-04, requisito de confirmación).
 *
 * La lista es explícita y no una heurística sobre el nombre de la operación
 * («empieza por remove») porque `setSeedRows` no empieza por remove y sin
 * embargo puede borrar quinientas filas, mientras que `removeSeedRow` borra
 * una. Una regla léxica se equivoca justo en los casos que importan.
 *
 * `moveClass` no está: mover no pierde nada. `renameClass` tampoco, aunque
 * asuste, porque el nombre anterior se recupera renombrando otra vez.
 */
const DESTRUCTIVAS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  'removeClass',
  'removeAttribute',
  'removeMethod',
  'removeRelation',
  'removeSeedRow',
  'setSeedRows',
  // Borrar el módulo no borra clases, pero devuelve todas al paquete base y
  // pierde el reparto, que es trabajo de organización hecho a mano.
  'removeModule',
]);

export function isDestructiveOperation(op: Operation): boolean {
  // Fijar filas sobre una clase que no tenía ninguna no destruye nada; es una
  // importación. Solo lo sabe quien mire el diagrama, así que aquí se es
  // conservador y se marca, y `describeImpact` afina con el diagrama delante.
  return DESTRUCTIVAS.has(op.op);
}
