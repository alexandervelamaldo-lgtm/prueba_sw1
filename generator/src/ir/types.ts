/**
 * Representación intermedia (IR) de generación.
 *
 * Existe por una razón concreta ([Arquitectura §2.7.1], decisión D4): las
 * plantillas deben ser tontas. Si una plantilla tiene que decidir si una
 * relación es bidireccional o cuál es el lado propietario, esa lógica queda
 * duplicada en cada plantilla y es imposible de probar por separado.
 *
 * La IR toma todas esas decisiones una sola vez, en `normalize.ts`, y las deja
 * explícitas. Todo lo que aparece aquí es un dato ya resuelto: nombres en su
 * convención final, anotaciones JPA elegidas, columnas calculadas.
 */

export type DatabaseTarget = 'postgres' | 'mongodb' | 'cassandra';

export interface ProjectIR {
  groupId: string;
  artifactId: string;
  basePackage: string;
  /** `com/ejemplo/proyecto` — derivado de basePackage. */
  basePackagePath: string;
  name: string;
  description: string;
  javaVersion: string;
  springBootVersion: string;
  databaseName: string;
  /** Motor de persistencia objetivo: decide qué plantillas usa generate.ts. */
  databaseTarget: DatabaseTarget;
}

export type JpaAssociationKind = 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';

export interface FieldIR {
  /** camelCase. */
  name: string;
  /** snake_case, validado como identificador SQL. */
  columnName: string;
  javaType: string;
  postgresType: string;
  /** Import necesario para el tipo, si lo hay. */
  javaImport?: string;
  nullable: boolean;
  unique: boolean;
  isIdentifier: boolean;
  /** La clave primaria se genera con @GeneratedValue. */
  generated: boolean;
  /** Tipo enumerado del propio diagrama: requiere @Enumerated. */
  isEnum: boolean;
  /** Anotaciones Bean Validation ya resueltas. */
  validations: string[];
  getterName: string;
  setterName: string;
  columnDefinition: string;
  defaultValue?: string;
}

export interface JoinTableIR {
  name: string;
  joinColumn: string;
  inverseJoinColumn: string;
}

export interface AssociationIR {
  /** Nombre del campo Java en la entidad que la declara. */
  fieldName: string;
  targetClass: string;
  targetVar: string;
  targetTable: string;
  kind: JpaAssociationKind;
  /** El lado propietario es el que lleva la clave ajena. */
  owning: boolean;
  /** Solo en el lado inverso. */
  mappedBy?: string;
  /** Solo en el lado propietario de OneToOne y ManyToOne. */
  joinColumn?: string;
  joinTable?: JoinTableIR;
  /** `CascadeType.ALL` en composición; vacío en agregación y asociación. */
  cascade?: string;
  /**
   * Este extremo es la «parte» de una composición: su clave ajena apunta al
   * «todo», y borrar el todo debe llevarse la parte por delante.
   *
   * Es un campo aparte de `cascade`, y no un sinónimo suyo. `cascade` es la
   * cascada de JPA y vive en el lado **inverso** —la colección del todo—, que
   * no tiene clave ajena; esta bandera vive en el lado **propietario**, que sí
   * la tiene, y es la que gobierna el `ON DELETE` de la restricción.
   *
   * Reutilizar `cascade` para esto sería un error grave: pondría
   * `CascadeType.ALL` en el `@ManyToOne` de la parte y borrar una línea de
   * pedido borraría el pedido entero, y con él sus demás líneas.
   */
  partOfComposition?: boolean;
  orphanRemoval: boolean;
  fetch: 'LAZY' | 'EAGER';
  /** true para OneToMany y ManyToMany: el campo es una colección. */
  collection: boolean;
  /** Tipo Java completo del campo: `Set<Pedido>` o `Cliente`. */
  javaType: string;
  nullable: boolean;
  getterName: string;
  setterName: string;
}

export interface EntityIR {
  className: string;
  varName: string;
  tableName: string;
  /** Segmento de la ruta REST, en plural y kebab-case: `linea-pedidos`. */
  restPath: string;
  description: string;
  isAbstract: boolean;
  fields: FieldIR[];
  identifier: FieldIR;
  associations: AssociationIR[];
  superclass?: string;
  inheritanceStrategy?: 'SINGLE_TABLE' | 'JOINED' | 'TABLE_PER_CLASS';
  /** true si otra entidad la extiende: necesita @Inheritance. */
  isSuperclass: boolean;
  /**
   * Estrategia de la jerarquía a la que pertenece, también en las subclases
   * (`inheritanceStrategy` solo la lleva la raíz, que es quien la declara).
   * Decide qué anotaciones admite cada subclase: `@Table` y
   * `@PrimaryKeyJoinColumn` solo tienen sentido con JOINED, y Hibernate se
   * niega a arrancar si aparecen en SINGLE_TABLE o TABLE_PER_CLASS.
   */
  hierarchyStrategy?: 'SINGLE_TABLE' | 'JOINED' | 'TABLE_PER_CLASS';
  /**
   * Cómo se genera la clave primaria. IDENTITY para Long e Integer; UUID para
   * UUID y String, porque una columna de texto no puede ser autoincremental;
   * SEQUENCE en una jerarquía TABLE_PER_CLASS, donde Hibernate no admite
   * IDENTITY (las filas de varias tablas comparten el espacio de ids).
   */
  idGeneration: 'IDENTITY' | 'UUID' | 'SEQUENCE';
  /** Secuencia compartida por la jerarquía cuando `idGeneration` es SEQUENCE. */
  idSequence?: string;
  /**
   * Columna discriminadora de una raíz SINGLE_TABLE. `dtype` salvo que algún
   * atributo de la jerarquía ya se llame así.
   */
  discriminatorColumn?: string;
  implementsInterfaces: string[];
  imports: string[];
  /**
   * Operaciones del diagrama que van a la capa de servicio. Ya filtradas: sin
   * las que chocarían con el CRUD generado ni con un accesor de la entidad.
   */
  methods: MethodIR[];
  /** Imports que solo necesita el servicio, por los tipos de esos métodos. */
  methodImports: string[];
  /**
   * Paquete del que cuelgan las capas de esta clase.
   *
   * Sin módulos es el paquete base y todo queda como estaba. Con módulos es
   * `base.ventas`, y de aquí salen tanto el `package …;` de cada fichero como
   * la carpeta en la que se escribe. Está en la IR y no se calcula en la
   * plantilla porque una clase de un módulo puede referirse a otra de un módulo
   * distinto, y entonces hace falta el paquete *del destino*, que la plantilla
   * no tiene forma de averiguar.
   */
  packageName: string;
}

export interface EnumIR {
  className: string;
  values: string[];
  packageName: string;
}

/**
 * Una operación declarada en el diagrama.
 *
 * La comparten las interfaces y las entidades. En una interfaz es el contrato
 * que la clase se compromete a cumplir; en una entidad es una operación de
 * negocio que alguien dibujó —a mano, dictada, o deducida de un diagrama de
 * comunicación— y que acaba en la **capa de servicio**, no en la entidad.
 */
export interface MethodIR {
  name: string;
  returnType: string;
  parameters: { name: string; javaType: string }[];
  /** `BigDecimal calcularTotal(Long clienteId)`, ya montada. */
  signature: string;
}

export interface InterfaceIR {
  className: string;
  methods: MethodIR[];
  imports: string[];
  packageName: string;
}

export interface ColumnDDL {
  name: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  primaryKey: boolean;
  /** Definición ya montada: `id BIGSERIAL NOT NULL`. */
  definition: string;
}

export interface ForeignKeyDDL {
  constraintName: string;
  column: string;
  referencesTable: string;
  referencesColumn: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'NO ACTION';
}

export interface TableDDL {
  name: string;
  columns: ColumnDDL[];
  primaryKey: string[];
  foreignKeys: ForeignKeyDDL[];
  /** Tabla de unión de un ManyToMany: no tiene entidad asociada. */
  isJoinTable: boolean;
}

export interface MigrationIR {
  version: string;
  description: string;
  /** Ordenadas por dependencias: una tabla nunca precede a aquella a la que referencia. */
  tables: TableDDL[];
  /** Secuencias de las jerarquías TABLE_PER_CLASS (`idSequence`). */
  sequences: string[];
}

/**
 * Datos iniciales de una tabla, ya convertidos a literales SQL.
 *
 * El escapado se hace en `normalize.ts` y no en la plantilla. Handlebars no
 * sabe de SQL —su escapado es para HTML— y una plantilla que interpolase un
 * valor sin comillas convertiría el generador en una inyección SQL con el
 * diagrama como vector. Aquí llega todo listo para pegar entre paréntesis.
 */
export interface SeedInsertIR {
  tableName: string;
  /** Columnas en el orden en que aparecen los valores de cada fila. */
  columns: string[];
  /** Literales SQL: `'Ana Torres'`, `'2500.50'`, `NULL`. Nunca valores crudos. */
  rows: string[][];
  /**
   * Nombre de la columna de clave primaria si es autoincremental y las filas
   * traen su valor.
   *
   * Sin esto el proyecto generado arranca bien y falla al primer POST: insertar
   * ids explícitos no adelanta la secuencia de PostgreSQL, así que el siguiente
   * `nextval` devuelve 1 y choca con la fila que ya existe. Con el nombre aquí,
   * la plantilla emite el `setval` que lo evita.
   */
  resetSequenceFor?: string;
  /**
   * Lo mismo para una secuencia con nombre (TABLE_PER_CLASS), que
   * `pg_get_serial_sequence` no encuentra porque no pertenece a la columna.
   */
  resetNamedSequence?: { sequence: string; column: string };
}

export interface GenerationIR {
  project: ProjectIR;
  entities: EntityIR[];
  enums: EnumIR[];
  interfaces: InterfaceIR[];
  migration: MigrationIR;
  /** Vacío si ninguna clase tiene filas de ejemplo. */
  seed: SeedInsertIR[];
}

export interface GeneratedFile {
  /** Ruta relativa a la raíz del proyecto generado. Validada contra escape de directorio. */
  path: string;
  content: string;
}
