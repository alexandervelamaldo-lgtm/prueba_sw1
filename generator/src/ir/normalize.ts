import {
  type Attribute,
  type ClassDiagram,
  type UmlClass,
  type UmlRelation,
  isPersistent,
  isPrimitiveType,
  isRequired,
  isToMany,
  listClasses,
  listRelations,
  lookupType,
  packageForClass,
  pluralize,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  toSnakeCase,
} from '@app/shared';
import type {
  AssociationIR,
  ColumnDDL,
  DatabaseTarget,
  EntityIR,
  EnumIR,
  FieldIR,
  ForeignKeyDDL,
  GenerationIR,
  InterfaceIR,
  MethodIR,
  MigrationIR,
  ProjectIR,
  SeedInsertIR,
  TableDDL,
} from './types.js';

/**
 * Normalización: modelo canónico UML → representación intermedia.
 *
 * Aquí se resuelve todo lo que de otro modo tendrían que decidir las plantillas:
 * qué lado de una asociación es el propietario, qué anotación JPA corresponde a
 * cada combinación de multiplicidades, cómo se llama cada columna y en qué orden
 * se crean las tablas.
 *
 * Presupone un diagrama ya validado (`shared/src/validation/validate.ts`). Llamar aquí con
 * un diagrama inválido es un error de programación, no una entrada esperada.
 */

export interface NormalizeOptions {
  javaVersion?: string;
  springBootVersion?: string;
  groupId?: string;
  inheritanceStrategy?: 'SINGLE_TABLE' | 'JOINED' | 'TABLE_PER_CLASS';
  /** Anula `diagram.meta.motorBD`, igual que `inheritanceStrategy` anula la estrategia persistida. */
  databaseTarget?: DatabaseTarget;
}

export function normalize(
  diagram: ClassDiagram,
  options: NormalizeOptions = {},
): GenerationIR {
  const project = buildProject(diagram, options);
  const strategy = options.inheritanceStrategy ?? 'JOINED';

  const allClasses = listClasses(diagram);
  const entityClasses = allClasses.filter(
    (c) => isPersistent(c) && (c.kind === 'class' || c.kind === 'abstract'),
  );
  const enumClasses = allClasses.filter((c) => c.kind === 'enum');
  const interfaceClasses = allClasses.filter((c) => c.kind === 'interface');

  const enumNames = new Set(enumClasses.map((c) => toPascalCase(c.name)));
  const entityNames = new Set(entityClasses.map((c) => toPascalCase(c.name)));

  const associationsByClass = buildAssociations(diagram, entityClasses, entityNames);

  const entities: EntityIR[] = entityClasses.map((cls) =>
    buildEntity(diagram, cls, {
      enumNames,
      associations: associationsByClass.get(cls.id) ?? [],
      strategy,
      entityClasses,
    }),
  );

  // Simplificación deliberada de las variantes MongoDB y Cassandra: todo
  // identificador pasa a String. El tipo por omisión (Long, pensado para una
  // secuencia de PostgreSQL) no se autogenera en ninguna de las dos, y forzar
  // String deja que tanto el id sintetizado como el de cualquier asociación
  // (ver `idJavaType` en `render/generate.ts`) salgan consistentes sin tocar
  // `buildEntity`.
  if (project.databaseTarget === 'mongodb' || project.databaseTarget === 'cassandra') {
    for (const entity of entities) {
      entity.identifier = { ...entity.identifier, javaType: 'String', javaImport: undefined };
    }
  }

  const enums: EnumIR[] = enumClasses.map((cls) => ({
    className: toPascalCase(cls.name),
    values: cls.literals.map((l) => l.toUpperCase()),
    packageName: packageForClass(diagram, cls),
  }));

  const interfaces: InterfaceIR[] = interfaceClasses.map((cls) =>
    buildInterface(cls, packageForClass(diagram, cls)),
  );

  const migration = buildMigration(entities, strategy);
  const seed = buildSeed(entityClasses, entities);

  return { project, entities, enums, interfaces, migration, seed };
}

// ---------------------------------------------------------------------------

function buildProject(diagram: ClassDiagram, options: NormalizeOptions): ProjectIR {
  const basePackage = diagram.meta.basePackage;
  const segments = basePackage.split('.');
  const groupId = options.groupId ?? segments.slice(0, -1).join('.') ?? 'com.ejemplo';

  return {
    groupId: groupId || 'com.ejemplo',
    artifactId: diagram.meta.artifactId,
    basePackage,
    basePackagePath: segments.join('/'),
    name: diagram.name,
    description: diagram.meta.description || `Backend generado a partir del diagrama ${diagram.name}`,
    javaVersion: options.javaVersion ?? '17',
    springBootVersion: options.springBootVersion ?? '3.3.5',
    databaseName: toSnakeCase(diagram.meta.artifactId) || 'app',
    databaseTarget: options.databaseTarget ?? diagram.meta.motorBD ?? 'postgres',
  };
}

// ---------------------------------------------------------------------------
// Asociaciones
// ---------------------------------------------------------------------------

interface PendingAssociation {
  ownerClassId: string;
  association: AssociationIR;
}

/**
 * Traduce relaciones y atributos de tipo entidad a asociaciones JPA.
 *
 * Convenio de lectura de multiplicidades: en una relación A→B, la multiplicidad
 * del extremo *target* indica cuántos B corresponden a cada A, y la del extremo
 * *source*, cuántos A corresponden a cada B.
 */
function buildAssociations(
  diagram: ClassDiagram,
  entityClasses: UmlClass[],
  entityNames: Set<string>,
): Map<string, AssociationIR[]> {
  const result = new Map<string, AssociationIR[]>();
  const pending: PendingAssociation[] = [];

  for (const relation of listRelations(diagram)) {
    if (!isPersistentAssociation(relation)) continue;

    const source = diagram.classes[relation.source.classId];
    const target = diagram.classes[relation.target.classId];
    if (!source || !target) continue;
    if (!entityNames.has(toPascalCase(source.name))) continue;
    if (!entityNames.has(toPascalCase(target.name))) continue;

    // Una clase de asociación que ya no es una entidad persistente (borrada, o
    // convertida en interfaz/enum tras marcarse) se trata como ausente: no es
    // el trabajo del generador rechazar un diagrama inválido —eso lo hace
    // `validateAssociationClasses`—, así que aquí simplemente se cae al M:N
    // con tabla de unión sintética de siempre.
    const associationClass = relation.associationClassId
      ? entityClasses.find((c) => c.id === relation.associationClassId)
      : undefined;

    pending.push(...associationsForRelation(relation, source, target, associationClass));
  }

  for (const cls of entityClasses) {
    for (const attr of cls.attributes) {
      const typeName = toPascalCase(attr.type.name);
      if (!entityNames.has(typeName)) continue;
      const target = entityClasses.find((c) => toPascalCase(c.name) === typeName);
      if (!target) continue;
      pending.push(associationForAttribute(cls, attr, target));
    }
  }

  for (const { ownerClassId, association } of pending) {
    const list = result.get(ownerClassId) ?? [];
    list.push(association);
    result.set(ownerClassId, list);
  }

  for (const [classId, list] of result) {
    result.set(classId, dedupeFieldNames(list));
  }

  return result;
}

function isPersistentAssociation(relation: UmlRelation): boolean {
  return (
    relation.kind === 'association' ||
    relation.kind === 'aggregation' ||
    relation.kind === 'composition'
  );
}

function associationsForRelation(
  relation: UmlRelation,
  source: UmlClass,
  target: UmlClass,
  associationClass?: UmlClass,
): PendingAssociation[] {
  const sourceToMany = isToMany(relation.source.multiplicity);
  const targetToMany = isToMany(relation.target.multiplicity);

  // Clase de asociación (UML): sustituye por completo la tabla de unión
  // sintética de la rama M:N de más abajo. Solo tiene sentido si de verdad es
  // N:M por los dos lados —lo mismo que exige `validateAssociationClasses`—;
  // si el diagrama quedó en un estado inconsistente (p. ej. alguien bajó la
  // multiplicidad después de colgar la clase) se prefiere caer al M:N de
  // siempre antes que fabricar un ManyToOne sin sentido.
  if (sourceToMany && targetToMany && associationClass) {
    return associationClassPair(source, target, associationClass, relation);
  }

  // En composición, el «todo» es el extremo source: es quien propaga el borrado.
  const cascadeOnSource = relation.kind === 'composition';

  const sourceName = toPascalCase(source.name);
  const targetName = toPascalCase(target.name);
  const selfReference = source.id === target.id;

  const roleOnSource = relation.target.role;
  const roleOnTarget = relation.source.role;

  if (!sourceToMany && !targetToMany) {
    // OneToOne. El extremo source es el propietario por convenio.
    const owningField = fieldNameFor(roleOnSource, targetName, false, selfReference, 'ref');
    const inverseField = fieldNameFor(roleOnTarget, sourceName, false, selfReference, 'owner');

    const owning: AssociationIR = {
      fieldName: owningField,
      targetClass: targetName,
      targetVar: toCamelCase(targetName),
      targetTable: tableNameFor(target),
      kind: 'OneToOne',
      owning: true,
      joinColumn: `${toSnakeCase(owningField)}_id`,
      cascade: cascadeOnSource ? 'CascadeType.ALL' : undefined,
      partOfComposition: cascadeOnSource,
      orphanRemoval: cascadeOnSource,
      fetch: 'LAZY',
      collection: false,
      javaType: targetName,
      nullable: !isRequired(relation.target.multiplicity),
      ...accessors(owningField),
    };

    const result: PendingAssociation[] = [{ ownerClassId: source.id, association: owning }];

    if (relation.source.navigable && !selfReference) {
      result.push({
        ownerClassId: target.id,
        association: {
          fieldName: inverseField,
          targetClass: sourceName,
          targetVar: toCamelCase(sourceName),
          targetTable: tableNameFor(source),
          kind: 'OneToOne',
          owning: false,
          mappedBy: owningField,
          orphanRemoval: false,
          fetch: 'LAZY',
          collection: false,
          javaType: sourceName,
          nullable: true,
          ...accessors(inverseField),
        },
      });
    }
    return result;
  }

  if (!sourceToMany && targetToMany) {
    // A tiene muchos B; B tiene un A. El propietario es B (lleva la clave ajena).
    return oneToManyPair({
      oneSide: source,
      manySide: target,
      oneSideRole: roleOnSource,
      manySideRole: roleOnTarget,
      cascade: cascadeOnSource,
      collectionRequired: isRequired(relation.source.multiplicity),
      navigableFromOne: relation.target.navigable,
      navigableFromMany: relation.source.navigable,
      selfReference,
    });
  }

  if (sourceToMany && !targetToMany) {
    // A tiene un B; B tiene muchos A. El propietario es A.
    return oneToManyPair({
      oneSide: target,
      manySide: source,
      oneSideRole: roleOnTarget,
      manySideRole: roleOnSource,
      cascade: false, // la composición se declara desde el todo, que aquí es target
      collectionRequired: isRequired(relation.target.multiplicity),
      navigableFromOne: relation.source.navigable,
      navigableFromMany: relation.target.navigable,
      selfReference,
    });
  }

  // ManyToMany: source es el propietario y declara la tabla de unión.
  const owningField = fieldNameFor(roleOnSource, targetName, true, selfReference, 'targets');
  const inverseField = fieldNameFor(roleOnTarget, sourceName, true, selfReference, 'sources');
  const joinTableName = joinTableNameFor(source, target, relation);

  const owning: AssociationIR = {
    fieldName: owningField,
    targetClass: targetName,
    targetVar: toCamelCase(targetName),
    targetTable: tableNameFor(target),
    kind: 'ManyToMany',
    owning: true,
    joinTable: {
      name: joinTableName,
      joinColumn: `${toSnakeCase(sourceName)}_id`,
      inverseJoinColumn: `${toSnakeCase(targetName)}${selfReference ? '_ref' : ''}_id`,
    },
    cascade: undefined,
    orphanRemoval: false,
    fetch: 'LAZY',
    collection: true,
    javaType: `Set<${targetName}>`,
    nullable: true,
    ...accessors(owningField),
  };

  const result: PendingAssociation[] = [{ ownerClassId: source.id, association: owning }];

  if (relation.source.navigable && !selfReference) {
    result.push({
      ownerClassId: target.id,
      association: {
        fieldName: inverseField,
        targetClass: sourceName,
        targetVar: toCamelCase(sourceName),
        targetTable: tableNameFor(source),
        kind: 'ManyToMany',
        owning: false,
        mappedBy: owningField,
        orphanRemoval: false,
        fetch: 'LAZY',
        collection: true,
        javaType: `Set<${sourceName}>`,
        nullable: true,
        ...accessors(inverseField),
      },
    });
  }
  return result;
}

function oneToManyPair(spec: {
  oneSide: UmlClass;
  manySide: UmlClass;
  oneSideRole?: string;
  manySideRole?: string;
  cascade: boolean;
  collectionRequired: boolean;
  navigableFromOne: boolean;
  navigableFromMany: boolean;
  selfReference: boolean;
}): PendingAssociation[] {
  const oneName = toPascalCase(spec.oneSide.name);
  const manyName = toPascalCase(spec.manySide.name);

  const collectionField = fieldNameFor(
    spec.oneSideRole,
    manyName,
    true,
    spec.selfReference,
    'children',
  );
  const referenceField = fieldNameFor(
    spec.manySideRole,
    oneName,
    false,
    spec.selfReference,
    'parent',
  );

  const owning: AssociationIR = {
    fieldName: referenceField,
    targetClass: oneName,
    targetVar: toCamelCase(oneName),
    targetTable: tableNameFor(spec.oneSide),
    kind: 'ManyToOne',
    owning: true,
    joinColumn: `${toSnakeCase(referenceField)}_id`,
    // Sin `cascade`: la cascada de JPA va en la colección del todo, más abajo.
    // Aquí solo se marca que la clave ajena apunta a un todo que compone, para
    // que la restricción salga con `ON DELETE CASCADE`.
    partOfComposition: spec.cascade,
    orphanRemoval: false,
    fetch: 'LAZY',
    collection: false,
    javaType: oneName,
    nullable: !spec.collectionRequired,
    ...accessors(referenceField),
  };

  const inverse: AssociationIR = {
    fieldName: collectionField,
    targetClass: manyName,
    targetVar: toCamelCase(manyName),
    targetTable: tableNameFor(spec.manySide),
    kind: 'OneToMany',
    owning: false,
    mappedBy: referenceField,
    cascade: spec.cascade ? 'CascadeType.ALL' : undefined,
    orphanRemoval: spec.cascade,
    fetch: 'LAZY',
    collection: true,
    javaType: `Set<${manyName}>`,
    nullable: true,
    ...accessors(collectionField),
  };

  const result: PendingAssociation[] = [];
  if (spec.navigableFromMany || true) {
    // El lado propietario siempre se genera: sin él no hay clave ajena.
    result.push({ ownerClassId: spec.manySide.id, association: owning });
  }
  if (spec.navigableFromOne) {
    result.push({ ownerClassId: spec.oneSide.id, association: inverse });
  }
  return result;
}

/**
 * Clase de asociación (UML) colgada de una relación N:M.
 *
 * A diferencia de la rama M:N de más abajo —que fabrica un `@JoinTable` sin
 * clase Java propia—, aquí la propia clase de asociación es la tabla de
 * unión: lleva dos `@ManyToOne` obligatorios (uno a cada extremo, con sus
 * columnas `..._id`) además de sus propios atributos (`cantidad`, `subtotal`,
 * lo que sea que el usuario le haya puesto). `buildTable` ya sabe emitir esas
 * columnas y sus claves ajenas porque son un `ManyToOne` corriente: no hace
 * falta tocar la generación de tablas para que esto funcione.
 *
 * Las dos colecciones inversas (`Set<ClaseAsociacion>` en cada extremo) son
 * opcionales y no siguen el convenio de «lado propietario» de la rama M:N:
 * ahí el propietario forzado existía porque alguien tenía que declarar el
 * `@JoinTable`, pero aquí el dueño de las dos claves ajenas es siempre la
 * clase de asociación, así que cada colección se añade según la navegabilidad
 * de su propio extremo, sin depender del otro.
 */
function associationClassPair(
  source: UmlClass,
  target: UmlClass,
  associationClass: UmlClass,
  relation: UmlRelation,
): PendingAssociation[] {
  const sourceName = toPascalCase(source.name);
  const targetName = toPascalCase(target.name);
  const assocName = toPascalCase(associationClass.name);
  const selfReference = source.id === target.id;

  const fieldToSource = fieldNameFor(relation.source.role, sourceName, false, selfReference, 'source');
  const fieldToTarget = fieldNameFor(relation.target.role, targetName, false, selfReference, 'target');

  const result: PendingAssociation[] = [
    { ownerClassId: associationClass.id, association: manyToOneField(fieldToSource, source) },
    { ownerClassId: associationClass.id, association: manyToOneField(fieldToTarget, target) },
  ];

  // Un extremo que es la propia clase de asociación consigo misma (relación
  // reflexiva) no tiene una colección inversa clara en qué extremo colgarla
  // sin ambigüedad, así que se omite: el vínculo ya es navegable a través de
  // los dos `@ManyToOne` de arriba.
  if (selfReference) return result;

  const collectionField = fieldNameFor(undefined, assocName, true, false, 'items');

  if (relation.source.navigable) {
    result.push({
      ownerClassId: source.id,
      association: {
        fieldName: collectionField,
        targetClass: assocName,
        targetVar: toCamelCase(assocName),
        targetTable: tableNameFor(associationClass),
        kind: 'OneToMany',
        owning: false,
        mappedBy: fieldToSource,
        orphanRemoval: false,
        fetch: 'LAZY',
        collection: true,
        javaType: `Set<${assocName}>`,
        nullable: true,
        ...accessors(collectionField),
      },
    });
  }

  if (relation.target.navigable) {
    result.push({
      ownerClassId: target.id,
      association: {
        fieldName: collectionField,
        targetClass: assocName,
        targetVar: toCamelCase(assocName),
        targetTable: tableNameFor(associationClass),
        kind: 'OneToMany',
        owning: false,
        mappedBy: fieldToTarget,
        orphanRemoval: false,
        fetch: 'LAZY',
        collection: true,
        javaType: `Set<${assocName}>`,
        nullable: true,
        ...accessors(collectionField),
      },
    });
  }

  return result;
}

/**
 * `@ManyToOne` obligatorio de una clase de asociación hacia uno de los dos
 * extremos de la relación que representa.
 *
 * Siempre `nullable: false`: una fila de la clase de asociación sin uno de
 * los dos extremos no es un vínculo válido, es un vínculo a medias. Por eso
 * el borrado de un extremo con filas de la clase de asociación pendientes
 * sale con `ON DELETE NO ACTION` (ver `buildTable`) en vez de dejar la fila
 * huérfana con la clave en NULL.
 */
function manyToOneField(fieldName: string, target: UmlClass): AssociationIR {
  const targetName = toPascalCase(target.name);
  return {
    fieldName,
    targetClass: targetName,
    targetVar: toCamelCase(targetName),
    targetTable: tableNameFor(target),
    kind: 'ManyToOne',
    owning: true,
    joinColumn: `${toSnakeCase(fieldName)}_id`,
    orphanRemoval: false,
    fetch: 'LAZY',
    collection: false,
    javaType: targetName,
    nullable: false,
    ...accessors(fieldName),
  };
}

/**
 * Atributo cuyo tipo es otra entidad. Convenio documentado: un atributo simple
 * produce ManyToOne y uno de colección produce ManyToMany, porque desde un
 * atributo no hay información del extremo inverso.
 */
function associationForAttribute(
  owner: UmlClass,
  attr: Attribute,
  target: UmlClass,
): PendingAssociation {
  const targetName = toPascalCase(target.name);
  const collection = attr.type.collection || (attr.multiplicity ? isToMany(attr.multiplicity) : false);
  const fieldName = toCamelCase(attr.name);

  if (collection) {
    return {
      ownerClassId: owner.id,
      association: {
        fieldName,
        targetClass: targetName,
        targetVar: toCamelCase(targetName),
        targetTable: tableNameFor(target),
        kind: 'ManyToMany',
        owning: true,
        joinTable: {
          name: `${tableNameFor(owner)}_${toSnakeCase(fieldName)}`,
          joinColumn: `${toSnakeCase(owner.name)}_id`,
          inverseJoinColumn: `${toSnakeCase(fieldName)}_id`,
        },
        orphanRemoval: false,
        fetch: 'LAZY',
        collection: true,
        javaType: `Set<${targetName}>`,
        nullable: true,
        ...accessors(fieldName),
      },
    };
  }

  return {
    ownerClassId: owner.id,
    association: {
      fieldName,
      targetClass: targetName,
      targetVar: toCamelCase(targetName),
      targetTable: tableNameFor(target),
      kind: 'ManyToOne',
      owning: true,
      joinColumn: `${toSnakeCase(fieldName)}_id`,
      orphanRemoval: false,
      fetch: 'LAZY',
      collection: false,
      javaType: targetName,
      nullable: attr.isNullable,
      ...accessors(fieldName),
    },
  };
}

function fieldNameFor(
  role: string | undefined,
  targetName: string,
  collection: boolean,
  selfReference: boolean,
  selfFallback: string,
): string {
  if (role && role.trim().length > 0) return toCamelCase(role);
  if (selfReference) return toCamelCase(selfFallback);
  return collection ? toCamelCase(pluralize(targetName)) : toCamelCase(targetName);
}

/** Evita que dos asociaciones de la misma entidad generen el mismo campo. */
function dedupeFieldNames(associations: AssociationIR[]): AssociationIR[] {
  const seen = new Map<string, number>();
  return associations.map((assoc) => {
    const count = seen.get(assoc.fieldName) ?? 0;
    seen.set(assoc.fieldName, count + 1);
    if (count === 0) return assoc;

    const fieldName = `${assoc.fieldName}${count + 1}`;
    return {
      ...assoc,
      fieldName,
      joinColumn: assoc.joinColumn ? `${toSnakeCase(fieldName)}_id` : undefined,
      ...accessors(fieldName),
    };
  });
}

function accessors(fieldName: string): { getterName: string; setterName: string } {
  const capitalized = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
  return { getterName: `get${capitalized}`, setterName: `set${capitalized}` };
}

function tableNameFor(cls: UmlClass): string {
  return toSnakeCase(pluralize(cls.name));
}

function joinTableNameFor(source: UmlClass, target: UmlClass, relation: UmlRelation): string {
  if (relation.name && relation.name.trim().length > 0) {
    return toSnakeCase(relation.name);
  }
  return `${toSnakeCase(source.name)}_${toSnakeCase(pluralize(target.name))}`;
}

// ---------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------

function buildEntity(
  diagram: ClassDiagram,
  cls: UmlClass,
  context: {
    enumNames: Set<string>;
    associations: AssociationIR[];
    strategy: 'SINGLE_TABLE' | 'JOINED' | 'TABLE_PER_CLASS';
    entityClasses: UmlClass[];
  },
): EntityIR {
  const className = toPascalCase(cls.name);
  const entityNames = new Set(context.entityClasses.map((c) => toPascalCase(c.name)));

  const fields: FieldIR[] = cls.attributes
    .filter((attr) => !entityNames.has(toPascalCase(attr.type.name)))
    .filter((attr) => !attr.isStatic)
    .map((attr) => buildField(attr, context.enumNames));

  const superclassRelation = listRelations(diagram).find(
    (r) =>
      r.kind === 'inheritance' &&
      r.source.classId === cls.id &&
      diagram.classes[r.target.classId]?.kind !== 'interface',
  );
  const superclass = superclassRelation
    ? diagram.classes[superclassRelation.target.classId]
    : undefined;

  const isSuperclass = listRelations(diagram).some(
    (r) => r.kind === 'inheritance' && r.target.classId === cls.id,
  );

  const implementsInterfaces = listRelations(diagram)
    .filter((r) => r.source.classId === cls.id)
    .filter((r) => r.kind === 'realization' || r.kind === 'inheritance')
    .map((r) => diagram.classes[r.target.classId])
    .filter((c): c is UmlClass => c?.kind === 'interface')
    .map((c) => toPascalCase(c.name));

  const identifier = resolveIdentifier(diagram, cls, fields);

  // Los imports de los métodos van aparte de los de la entidad: los métodos se
  // emiten en el servicio, y meter `java.time.LocalDate` en la entidad porque
  // lo pide una firma del servicio dejaría un import sin usar en un fichero y
  // faltando en el otro.
  const methodImports = new Set<string>();
  const methods = buildEntityMethods(cls, fields, identifier, methodImports);

  const entity: EntityIR = {
    className,
    varName: toCamelCase(className),
    tableName: tableNameFor(cls),
    restPath: toKebabCase(pluralize(cls.name)),
    description: cls.stereotype ?? '',
    isAbstract: cls.kind === 'abstract',
    fields,
    identifier,
    associations: context.associations,
    superclass: superclass ? toPascalCase(superclass.name) : undefined,
    inheritanceStrategy: isSuperclass ? context.strategy : undefined,
    isSuperclass,
    implementsInterfaces,
    imports: [],
    methods,
    methodImports: [...methodImports].sort(),
    packageName: packageForClass(diagram, cls),
  };

  entity.imports = computeImports(entity);
  return entity;
}

function buildField(attr: Attribute, enumNames: Set<string>): FieldIR {
  const typeName = toPascalCase(attr.type.name);
  const isEnum = enumNames.has(typeName);
  const mapping = isEnum ? undefined : lookupType(attr.type.name);

  const javaType = isEnum ? typeName : (mapping?.javaType ?? 'String');
  const postgresType = isEnum ? 'VARCHAR(64)' : (mapping?.postgresType ?? 'VARCHAR(255)');
  const columnName = toSnakeCase(attr.name);
  const nullable = attr.isIdentifier ? false : attr.isNullable;

  const validations: string[] = [];
  if (!nullable && !attr.isIdentifier) {
    validations.push(javaType === 'String' ? '@NotBlank' : '@NotNull');
  }
  if (javaType === 'String' && postgresType.startsWith('VARCHAR')) {
    const size = postgresType.match(/\((\d+)\)/)?.[1];
    if (size) validations.push(`@Size(max = ${size})`);
  }

  return {
    name: toCamelCase(attr.name),
    columnName,
    javaType,
    postgresType,
    javaImport: mapping?.javaImport,
    nullable,
    unique: attr.isUnique,
    isIdentifier: attr.isIdentifier,
    generated: attr.isIdentifier,
    isEnum,
    validations,
    columnDefinition: postgresType,
    defaultValue: attr.defaultValue,
    ...accessors(toCamelCase(attr.name)),
  };
}

function resolveIdentifier(
  diagram: ClassDiagram,
  cls: UmlClass,
  fields: FieldIR[],
): FieldIR {
  const own = fields.find((f) => f.isIdentifier);
  if (own) return own;

  // Heredado: la clase padre declara la clave primaria.
  const relation = listRelations(diagram).find(
    (r) => r.kind === 'inheritance' && r.source.classId === cls.id,
  );
  const parent = relation ? diagram.classes[relation.target.classId] : undefined;
  if (parent) {
    const parentAttr = parent.attributes.find((a) => a.isIdentifier);
    if (parentAttr) return buildField(parentAttr, new Set());
  }

  // Clase abstracta sin identificador propio: se sintetiza uno para la plantilla.
  return buildField(
    {
      id: 'synthetic-id',
      name: 'id',
      type: { name: 'Long', collection: false },
      visibility: '-',
      isStatic: false,
      isFinal: false,
      isIdentifier: true,
      isUnique: false,
      isNullable: false,
    },
    new Set(),
  );
}

function computeImports(entity: EntityIR): string[] {
  const imports = new Set<string>();

  for (const field of entity.fields) {
    if (field.javaImport) imports.add(field.javaImport);
  }
  if (entity.associations.some((a) => a.collection)) {
    imports.add('java.util.Set');
    imports.add('java.util.HashSet');
  }
  if (entity.identifier.javaImport) imports.add(entity.identifier.javaImport);

  return [...imports].sort();
}

/**
 * Traduce las operaciones de una clase UML a firmas Java.
 *
 * Lo usan las interfaces y las entidades. Una colección en el tipo de retorno o
 * en un parámetro se envuelve en `List<…>`: el diagrama lo dice con la
 * cardinalidad y perderlo aquí cambiaría la firma.
 *
 * Los imports se acumulan en el conjunto que recibe, porque quien llama los
 * necesita mezclados con los suyos y en un solo sitio.
 */
function buildMethods(cls: UmlClass, imports: Set<string>): MethodIR[] {
  const tipoDe = (ref: { name: string; collection?: boolean }): string => {
    const mapeado = lookupType(ref.name);
    const base = mapeado?.javaType ?? toPascalCase(ref.name);
    if (mapeado?.javaImport) imports.add(mapeado.javaImport);
    if (!ref.collection) return base;
    imports.add('java.util.List');
    return `List<${base}>`;
  };

  return cls.methods.map((method) => {
    const returnType = method.returnType ? tipoDe(method.returnType) : 'void';
    const parameters = method.parameters.map((p) => ({
      name: toCamelCase(p.name),
      javaType: tipoDe(p.type),
    }));
    const signature = `${returnType} ${toCamelCase(method.name)}(${parameters
      .map((p) => `${p.javaType} ${p.name}`)
      .join(', ')})`;
    return { name: toCamelCase(method.name), returnType, parameters, signature };
  });
}

/**
 * Nombres que el servicio generado ya ocupa.
 *
 * Una clase con un método `crear()` o `buscarPorId()` es de lo más normal, y al
 * traducirlo chocaría con el CRUD que esta plantilla emite siempre. Declararlo
 * dos veces en la misma interfaz no compila, así que se descarta el del
 * diagrama —el CRUD hace lo mismo y además está implementado— y se avisa.
 */
const METODOS_DEL_CRUD = new Set(['findAll', 'findById', 'create', 'update', 'delete']);

/**
 * Operaciones de una entidad que llegan a la capa de servicio.
 *
 * Solo las **públicas**: la interfaz del servicio es un contrato, y un método
 * marcado como privado en el diagrama es por definición un detalle interno que
 * nadie de fuera debería poder llamar. Los descartados se avisan en la
 * validación, no se pierden en silencio.
 *
 * Tampoco pasan las que chocarían con el CRUD ni con un accesor de la entidad:
 * un `getNombre()` dibujado a mano ya lo genera el campo.
 */
function buildEntityMethods(
  cls: UmlClass,
  fields: FieldIR[],
  identifier: FieldIR,
  imports: Set<string>,
): MethodIR[] {
  const ocupados = new Set<string>([
    ...METODOS_DEL_CRUD,
    identifier.getterName,
    identifier.setterName,
    ...fields.flatMap((f) => [f.getterName, f.setterName]),
    'equals',
    'hashCode',
    'toString',
  ]);

  const visibles = { ...cls, methods: cls.methods.filter((m) => m.visibility === '+') };
  const vistos = new Set<string>();

  return buildMethods(visibles, imports).filter((method) => {
    if (ocupados.has(method.name)) return false;
    // Java admite sobrecarga, pero dos métodos del diagrama con el mismo nombre
    // y los mismos tipos no compilan. La firma completa es la clave correcta.
    if (vistos.has(method.signature)) return false;
    vistos.add(method.signature);
    return true;
  });
}

function buildInterface(cls: UmlClass, packageName: string): InterfaceIR {
  const imports = new Set<string>();
  const methods = buildMethods(cls, imports);
  return {
    className: toPascalCase(cls.name),
    methods,
    imports: [...imports].sort(),
    packageName,
  };
}

// ---------------------------------------------------------------------------
// Migración SQL
// ---------------------------------------------------------------------------

function buildMigration(
  entities: EntityIR[],
  strategy: 'SINGLE_TABLE' | 'JOINED' | 'TABLE_PER_CLASS',
): MigrationIR {
  const tables: TableDDL[] = [];

  for (const entity of entities) {
    if (strategy === 'SINGLE_TABLE' && entity.superclass) continue;
    tables.push(buildTable(entity, entities, strategy));
  }

  for (const entity of entities) {
    for (const assoc of entity.associations) {
      if (assoc.kind !== 'ManyToMany' || !assoc.owning || !assoc.joinTable) continue;
      tables.push(buildJoinTable(entity, assoc.joinTable, assoc.targetTable, entities));
    }
  }

  return {
    version: '1',
    description: 'esquema inicial',
    tables: sortTablesByDependency(tables),
  };
}

function buildTable(
  entity: EntityIR,
  allEntities: EntityIR[],
  strategy: 'SINGLE_TABLE' | 'JOINED' | 'TABLE_PER_CLASS',
): TableDDL {
  const columns: ColumnDDL[] = [];
  const foreignKeys: ForeignKeyDDL[] = [];

  const isChildJoined = strategy === 'JOINED' && entity.superclass !== undefined;

  const idColumn: ColumnDDL = {
    name: entity.identifier.columnName,
    type: isChildJoined
      ? entity.identifier.postgresType
      : serialTypeFor(entity.identifier.postgresType),
    nullable: false,
    unique: false,
    primaryKey: true,
    definition: '',
  };
  idColumn.definition = `${idColumn.name} ${idColumn.type} NOT NULL`;
  columns.push(idColumn);

  if (isChildJoined) {
    const parent = allEntities.find((e) => e.className === entity.superclass);
    if (parent) {
      foreignKeys.push({
        constraintName: truncateIdentifier(`fk_${entity.tableName}_${parent.tableName}`),
        column: entity.identifier.columnName,
        referencesTable: parent.tableName,
        referencesColumn: parent.identifier.columnName,
        onDelete: 'CASCADE',
      });
    }
  }

  if (strategy === 'SINGLE_TABLE' && entity.isSuperclass) {
    const discriminator: ColumnDDL = {
      name: 'dtype',
      type: 'VARCHAR(64)',
      nullable: false,
      unique: false,
      primaryKey: false,
      definition: 'dtype VARCHAR(64) NOT NULL',
    };
    columns.push(discriminator);
  }

  for (const field of entity.fields) {
    if (field.isIdentifier) continue;
    const column: ColumnDDL = {
      name: field.columnName,
      type: field.postgresType,
      nullable: field.nullable,
      unique: field.unique,
      primaryKey: false,
      definition: '',
    };
    column.definition = [
      `${column.name} ${column.type}`,
      column.nullable ? 'NULL' : 'NOT NULL',
      column.unique ? 'UNIQUE' : '',
    ]
      .filter(Boolean)
      .join(' ');
    columns.push(column);
  }

  for (const assoc of entity.associations) {
    if (!assoc.owning) continue;
    if (assoc.kind !== 'ManyToOne' && assoc.kind !== 'OneToOne') continue;
    if (!assoc.joinColumn) continue;

    const targetEntity = allEntities.find((e) => e.className === assoc.targetClass);

    const column: ColumnDDL = {
      name: assoc.joinColumn,
      type: targetEntity?.identifier.postgresType ?? 'BIGINT',
      nullable: assoc.nullable,
      unique: assoc.kind === 'OneToOne',
      primaryKey: false,
      definition: '',
    };
    column.definition = [
      `${column.name} ${column.type}`,
      column.nullable ? 'NULL' : 'NOT NULL',
      column.unique ? 'UNIQUE' : '',
    ]
      .filter(Boolean)
      .join(' ');
    columns.push(column);

    foreignKeys.push({
      constraintName: truncateIdentifier(`fk_${entity.tableName}_${assoc.joinColumn}`),
      column: assoc.joinColumn,
      referencesTable: assoc.targetTable,
      referencesColumn: targetEntity?.identifier.columnName ?? 'id',
      // `partOfComposition` y no `cascade`: en un ManyToOne la cascada de JPA
      // está en el lado inverso, que no pasa por aquí porque no lleva clave
      // ajena. Mirando `cascade` la composición uno-a-muchos salía con
      // `NO ACTION` mientras la uno-a-uno salía con `CASCADE` —la misma
      // relación UML con dos semánticas distintas según la multiplicidad—.
      onDelete: assoc.partOfComposition
        ? 'CASCADE'
        : assoc.nullable
          ? 'SET NULL'
          : 'NO ACTION',
    });
  }

  return {
    name: entity.tableName,
    columns,
    primaryKey: [entity.identifier.columnName],
    foreignKeys,
    isJoinTable: false,
  };
}

function buildJoinTable(
  owner: EntityIR,
  joinTable: { name: string; joinColumn: string; inverseJoinColumn: string },
  targetTable: string,
  allEntities: EntityIR[],
): TableDDL {
  const targetEntity = allEntities.find((e) => e.tableName === targetTable);
  const ownerColumnType = owner.identifier.postgresType;
  const targetColumnType = targetEntity?.identifier.postgresType ?? 'BIGINT';
  const columns: ColumnDDL[] = [
    {
      name: joinTable.joinColumn,
      type: ownerColumnType,
      nullable: false,
      unique: false,
      primaryKey: true,
      definition: `${joinTable.joinColumn} ${ownerColumnType} NOT NULL`,
    },
    {
      name: joinTable.inverseJoinColumn,
      type: targetColumnType,
      nullable: false,
      unique: false,
      primaryKey: true,
      definition: `${joinTable.inverseJoinColumn} ${targetColumnType} NOT NULL`,
    },
  ];

  return {
    name: joinTable.name,
    columns,
    primaryKey: [joinTable.joinColumn, joinTable.inverseJoinColumn],
    foreignKeys: [
      {
        constraintName: truncateIdentifier(`fk_${joinTable.name}_${joinTable.joinColumn}`),
        column: joinTable.joinColumn,
        referencesTable: owner.tableName,
        referencesColumn: owner.identifier.columnName,
        onDelete: 'CASCADE',
      },
      {
        constraintName: truncateIdentifier(`fk_${joinTable.name}_${joinTable.inverseJoinColumn}`),
        column: joinTable.inverseJoinColumn,
        referencesTable: targetTable,
        referencesColumn: targetEntity?.identifier.columnName ?? 'id',
        onDelete: 'CASCADE',
      },
    ],
    isJoinTable: true,
  };
}

function serialTypeFor(postgresType: string): string {
  if (postgresType === 'BIGINT') return 'BIGSERIAL';
  if (postgresType === 'INTEGER') return 'SERIAL';
  return postgresType;
}

/** PostgreSQL limita los identificadores a 63 bytes. */
function truncateIdentifier(name: string): string {
  return name.length <= 63 ? name : name.slice(0, 63);
}

// ---------------------------------------------------------------------------
// Datos iniciales
// ---------------------------------------------------------------------------

/**
 * Convierte un valor de celda en un literal SQL.
 *
 * Todo sale entre comillas simples, sea cual sea el tipo de la columna. No es
 * pereza: en PostgreSQL un literal entrecomillado sin tipo explícito es de tipo
 * *unknown* y se convierte al de la columna en el momento de insertar, así que
 * `'2500.50'` entra en un DOUBLE PRECISION y `'true'` en un BOOLEAN sin más.
 * Emitir cada tipo con su sintaxis obligaría a decidir aquí si `2.500,50` es un
 * número —y a acertar—, cuando el valor viene de una foto de una pizarra.
 *
 * La única regla de escapado es doblar la comilla simple, que es la que cierra
 * el literal. Se dobla siempre y no «cuando hace falta»: una excepción es una
 * inyección esperando a que alguien la encuentre. La barra invertida no se toca
 * porque `standard_conforming_strings` lleva activo por defecto desde
 * PostgreSQL 9.1 y ahí no escapa nada.
 *
 * El byte nulo sí se rechaza lanzando: PostgreSQL no lo admite en `text` bajo
 * ninguna codificación, y dejarlo pasar daría un `data.sql` que revienta el
 * arranque del proyecto generado en lugar de fallar aquí.
 */
export function sqlLiteral(value: string | undefined): string {
  if (value === undefined) return 'NULL';
  if (value.includes('\0')) {
    throw new Error('Un valor de datos iniciales contiene un byte nulo, que PostgreSQL no admite');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Construye los INSERT de datos iniciales.
 *
 * Solo se emiten columnas propias de la entidad: las claves ajenas quedan
 * fuera. Rellenarlas exigiría saber a qué fila de la otra tabla apunta cada
 * una, y eso no está en una foto de una tabla suelta. Se prefiere un `data.sql`
 * que carga sin errores y deja las relaciones vacías a uno que inventa
 * referencias.
 */
function buildSeed(entityClasses: UmlClass[], entities: EntityIR[]): SeedInsertIR[] {
  const inserts: SeedInsertIR[] = [];

  for (const cls of entityClasses) {
    if (cls.seedRows.length === 0) continue;

    const entity = entities.find((e) => e.className === toPascalCase(cls.name));
    // Una clase abstracta no tiene tabla propia con todas las estrategias, y sus
    // filas no sabrían a qué subclase pertenecen.
    if (!entity || entity.isAbstract) continue;

    const porAtributo = new Map(entity.fields.map((f) => [f.name, f]));

    // Las columnas se fijan a partir de la unión de las claves presentes en las
    // filas, y no de los campos de la entidad: si ninguna fila trae `activo`, la
    // columna sobra en el INSERT y su valor por defecto hace mejor trabajo.
    const usadas = entity.fields
      .map((f) => f.name)
      .filter((nombre) => cls.seedRows.some((row) => row[nombre] !== undefined));
    if (usadas.length === 0) continue;

    const columns = usadas.map((nombre) => porAtributo.get(nombre)!.columnName);
    const rows = cls.seedRows.map((row) => usadas.map((nombre) => sqlLiteral(row[nombre])));

    const identificador = entity.identifier;
    const traeIdentificador = usadas.includes(identificador.name);

    // Solo hay secuencia que reajustar si la columna es de verdad SERIAL o
    // BIGSERIAL. Sobre una clave de texto, `pg_get_serial_sequence` devuelve
    // NULL y `setval(NULL, …)` aborta la migración: el proyecto generado no
    // arrancaría, y el error hablaría de una secuencia que nunca existió.
    const conSecuencia =
      serialTypeFor(identificador.columnDefinition ?? '') !== identificador.columnDefinition;

    inserts.push({
      tableName: entity.tableName,
      columns,
      rows,
      resetSequenceFor:
        traeIdentificador && identificador.generated && conSecuencia
          ? identificador.columnName
          : undefined,
    });
  }

  return inserts;
}

/**
 * Ordena las tablas para que ninguna preceda a aquella a la que referencia.
 * Ante un ciclo de claves ajenas (posible con asociaciones mutuas no nulas)
 * se conserva el orden restante: las restricciones se crean igualmente y es
 * PostgreSQL quien decide, porque en la misma migración no hay problema.
 */
function sortTablesByDependency(tables: TableDDL[]): TableDDL[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: TableDDL[] = [];

  function visit(table: TableDDL): void {
    if (visited.has(table.name) || visiting.has(table.name)) return;
    visiting.add(table.name);

    for (const fk of table.foreignKeys) {
      const dependency = byName.get(fk.referencesTable);
      if (dependency && dependency.name !== table.name) visit(dependency);
    }

    visiting.delete(table.name);
    visited.add(table.name);
    ordered.push(table);
  }

  for (const table of tables) visit(table);
  return ordered;
}
