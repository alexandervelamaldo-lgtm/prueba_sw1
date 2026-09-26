import { ulid } from './id.js';
import type {
  Attribute,
  ClassDiagram,
  Method,
  RelationKind,
  UmlClass,
  UmlRelation,
} from './uml.js';

/** Constructores con valores por defecto sensatos, para no repetirlos en cada llamada. */

export function createClass(init: Partial<UmlClass> & { name: string }): UmlClass {
  return {
    id: init.id ?? ulid(),
    name: init.name,
    kind: init.kind ?? 'class',
    stereotype: init.stereotype,
    attributes: init.attributes ?? [],
    methods: init.methods ?? [],
    literals: init.literals ?? [],
    position: init.position ?? { x: 0, y: 0 },
    size: init.size ?? { w: 220, h: 120 },
    transient: init.transient ?? false,
    seedRows: init.seedRows ?? [],
    moduleId: init.moduleId ?? null,
  };
}

export function createAttribute(
  // `Omit` antes de intersecar: si no, `type` queda como `TypeRef & string`,
  // que no admite ningún valor y hace inusable el atajo de pasar el nombre suelto.
  init: Omit<Partial<Attribute>, 'type'> & { name: string; type: string | Attribute['type'] },
): Attribute {
  const type =
    typeof init.type === 'string' ? { name: init.type, collection: false } : init.type;
  return {
    id: init.id ?? ulid(),
    name: init.name,
    type,
    visibility: init.visibility ?? '-',
    multiplicity: init.multiplicity,
    defaultValue: init.defaultValue,
    isStatic: init.isStatic ?? false,
    isFinal: init.isFinal ?? false,
    isIdentifier: init.isIdentifier ?? false,
    isUnique: init.isUnique ?? false,
    isNullable: init.isNullable ?? !(init.isIdentifier ?? false),
  };
}

export function createMethod(init: Partial<Method> & { name: string }): Method {
  return {
    id: init.id ?? ulid(),
    name: init.name,
    parameters: init.parameters ?? [],
    returnType: init.returnType ?? null,
    visibility: init.visibility ?? '+',
    isStatic: init.isStatic ?? false,
    isAbstract: init.isAbstract ?? false,
  };
}

export function createRelation(init: {
  id?: string;
  kind: RelationKind;
  name?: string;
  sourceId: string;
  targetId: string;
  sourceMultiplicity?: string;
  targetMultiplicity?: string;
  sourceRole?: string;
  targetRole?: string;
  associationClassId?: string;
}): UmlRelation {
  return {
    id: init.id ?? ulid(),
    kind: init.kind,
    name: init.name,
    source: {
      classId: init.sourceId,
      role: init.sourceRole,
      multiplicity: init.sourceMultiplicity ?? '1',
      navigable: true,
    },
    target: {
      classId: init.targetId,
      role: init.targetRole,
      multiplicity: init.targetMultiplicity ?? '1',
      navigable: true,
    },
    associationClassId: init.associationClassId,
  };
}

export function createDiagram(init: Partial<ClassDiagram> & { name: string }): ClassDiagram {
  return {
    id: init.id ?? ulid(),
    name: init.name,
    classes: init.classes ?? {},
    relations: init.relations ?? {},
    modules: init.modules ?? {},
    meta: {
      basePackage: init.meta?.basePackage ?? 'com.ejemplo.proyecto',
      artifactId: init.meta?.artifactId ?? 'proyecto',
      description: init.meta?.description ?? '',
      createdAt: init.meta?.createdAt,
      updatedAt: init.meta?.updatedAt,
    },
  };
}

/** Añade una clase al diagrama devolviendo una copia. Útil en pruebas y fixtures. */
export function withClass(diagram: ClassDiagram, cls: UmlClass): ClassDiagram {
  return { ...diagram, classes: { ...diagram.classes, [cls.id]: cls } };
}

export function withRelation(diagram: ClassDiagram, relation: UmlRelation): ClassDiagram {
  return { ...diagram, relations: { ...diagram.relations, [relation.id]: relation } };
}
