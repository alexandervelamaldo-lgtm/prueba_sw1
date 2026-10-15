import { isSafeRelativePath } from '@app/shared';
import { renderManifiesto } from '../asistente/manifiesto.js';
import type {
  AssociationIR,
  EntityIR,
  FieldIR,
  GeneratedFile,
  GenerationIR,
  MethodIR,
  ProjectIR,
} from '../ir/types.js';
import { render } from './engine.js';
import { buildPostmanCollection } from './postman.js';

/**
 * Construcción de los modelos de vista y del árbol de ficheros.
 *
 * La IR describe el *modelo*; esta capa describe la *proyección* de ese modelo
 * sobre cada plantilla concreta. La separación importa: qué campos incluye el
 * DTO de entrada, o cómo se accede al identificador de una asociación al
 * serializar, son decisiones de la capa de presentación del código generado, no
 * del modelo. Mantenerlas aquí evita que la IR crezca con campos que solo una
 * plantilla usa.
 *
 * Todo lo que las plantillas necesitan se calcula aquí, una sola vez y con
 * tipos. Una plantilla nunca deduce nada.
 */

export interface DtoComponent {
  name: string;
  javaType: string;
  validations: string[];
  /** Expresión Java que obtiene el valor desde la entidad. Solo en respuesta. */
  accessor: string;
}

export interface ToOneView {
  fieldName: string;
  setterName: string;
  targetClass: string;
  targetVar: string;
  idComponentName: string;
  nullable: boolean;
  /**
   * Campo de id plano y sus accesores. Solo los usa la variante MongoDB, que
   * no guarda un objeto de referencia sino directamente el identificador del
   * documento referido (ver `entity-mongo.java.hbs`).
   */
  idFieldName: string;
  idJavaType: string;
  idGetterName: string;
  idSetterName: string;
}

export interface RepositoryDependency {
  className: string;
  varName: string;
  /** Paquete de la clase referida, que puede ser el de otro módulo. */
  packageName: string;
}

export interface InterfaceMethodStub {
  name: string;
  signature: string;
}

export interface EntityView {
  project: ProjectIR;
  entity: EntityIR;
  /**
   * Paquete del que cuelgan las capas de *esta* entidad.
   *
   * Las plantillas lo usan en lugar de `project.basePackage` para el `package`
   * de cabecera y para importarse entre sí. Sin módulos vale exactamente lo
   * mismo que `project.basePackage`, que es la razón de que un diagrama sin
   * módulos siga generando los mismos ficheros byte a byte.
   */
  pkg: string;
  /** Imports de la entidad más los que arrastran las interfaces que realiza. */
  imports: string[];
  /** Métodos que la entidad debe implementar por realizar una interfaz. */
  interfaceMethods: InterfaceMethodStub[];
  /** Campos propios sin el identificador: la plantilla lo emite por separado. */
  fields: FieldIR[];
  /** Campos propios más heredados. Los DTOs sí exponen lo heredado. */
  allFields: FieldIR[];
  hasValidations: boolean;
  hasInterfaces: boolean;
  interfaceList: string;
  hasUniqueFields: boolean;
  uniqueFields: (FieldIR & { pascalName: string })[];
  /**
   * Solo lo que el repositorio nombra de verdad: el tipo del identificador y el
   * de cada campo único. Volcar aquí todos los imports de la entidad dejaba
   * `BigDecimal` y `Set` sin usar en cada repositorio generado; compila, pero es
   * la clase de ruido que hace parecer descuidado al que lo escribió.
   */
  repositoryImports: string[];
  identifierImport?: string;
  dtoImports: string[];
  requestComponents: DtoComponent[];
  responseComponents: DtoComponent[];
  toOneAssociations: ToOneView[];
  repositoryDependencies: RepositoryDependency[];
  /** Operaciones del diagrama, que se declaran en la capa 3. */
  serviceMethods: MethodIR[];
  hasServiceMethods: boolean;
  /** Imports que esas firmas añaden al servicio y a su implementación. */
  serviceImports: string[];
  /** Solo la interfaz: la implementación ya importa la entidad para el CRUD. */
  serviceNeedsOwnEntity: boolean;
}

// ---------------------------------------------------------------------------

export function buildEntityView(ir: GenerationIR, entity: EntityIR): EntityView {
  const byName = new Map(ir.entities.map((e) => [e.className, e]));
  const paquetes = paquetesDeDominio(ir);

  const fields = entity.fields.filter((f) => !f.isIdentifier);
  const allFields = [...inheritedFields(entity, byName), ...fields];

  // Solo el lado propietario: es el que lleva la clave ajena. Fijar el extremo
  // inverso desde el DTO no escribiría nada en la base de datos.
  const owningToOne = entity.associations.filter((a) => !a.collection && a.owning);
  const toOneAssociations = owningToOne.map((a) =>
    toOneView(a, byName.get(a.targetClass)?.identifier?.javaType ?? 'Long'),
  );

  const identifierComponent: DtoComponent = {
    name: 'id',
    javaType: entity.identifier.javaType,
    validations: [],
    accessor: `entity.${entity.identifier.getterName}()`,
  };

  const fieldComponents = allFields.map(
    (field): DtoComponent => ({
      name: field.name,
      javaType: field.javaType,
      validations: field.validations,
      accessor: `entity.${field.getterName}()`,
    }),
  );

  // Mongo y Cassandra comparten el mismo esquema de asociación: id plano en
  // la propia entidad, sin objeto de referencia ni joins (ver `ToOneView`).
  const usaIdPlano =
    ir.project.databaseTarget === 'mongodb' || ir.project.databaseTarget === 'cassandra';
  const associationComponents = owningToOne.map((association): DtoComponent => {
    const targetId = byName.get(association.targetClass)?.identifier;
    const idGetter = targetId?.getterName ?? 'getId';
    // Con id plano la asociación ya vive en la propia entidad (ver
    // `toOneAssociations`), así que el DTO lo lee directo en vez de recorrer
    // un objeto de referencia que esta variante no tiene.
    const accessor = usaIdPlano
      ? `entity.get${capitalize(association.fieldName)}Id()`
      : `entity.${association.getterName}() == null ? null ` +
        `: entity.${association.getterName}().${idGetter}()`;
    return {
      name: `${association.fieldName}Id`,
      javaType: targetId?.javaType ?? 'Long',
      validations: association.nullable ? [] : ['@NotNull'],
      accessor,
    };
  });

  const uniqueFields = fields
    .filter((f) => f.unique)
    .map((f) => ({ ...f, pascalName: f.name.charAt(0).toUpperCase() + f.name.slice(1) }));

  const repositoryDependencies = dedupeByClassName(toOneAssociations, paquetes, ir.project);
  const realized = realizedInterfaces(ir, entity);

  return {
    project: ir.project,
    entity,
    pkg: entity.packageName,
    imports: [
      ...new Set([
        ...entity.imports,
        ...realized.imports,
        ...importsEntreModulos(ir, entity, paquetes),
      ]),
    ].sort(),
    interfaceMethods: realized.methods,
    fields,
    allFields,
    hasValidations: fields.some((f) => f.validations.length > 0),
    hasInterfaces: entity.implementsInterfaces.length > 0,
    interfaceList: entity.implementsInterfaces.join(', '),
    hasUniqueFields: uniqueFields.length > 0,
    uniqueFields,
    repositoryImports: [
      ...new Set(
        [entity.identifier.javaImport, ...uniqueFields.map((f) => f.javaImport)].filter(
          (i): i is string => i !== undefined,
        ),
      ),
    ].sort(),
    identifierImport: entity.identifier.javaImport,
    dtoImports: dtoImportsFor(ir, allFields, associationComponents, paquetes),
    requestComponents: [...fieldComponents, ...associationComponents],
    responseComponents: [identifierComponent, ...fieldComponents, ...associationComponents],
    toOneAssociations,
    repositoryDependencies,
    serviceMethods: entity.methods,
    hasServiceMethods: entity.methods.length > 0,
    serviceImports: serviceImportsFor(ir, entity, paquetes),
    serviceNeedsOwnEntity: mentionsOwnEntity(entity),
  };
}

/**
 * Imports que las firmas del diagrama añaden al servicio.
 *
 * Dos fuentes. Las de biblioteca (`java.math.BigDecimal`) vienen ya resueltas
 * en la IR. Las del propio diagrama no pueden venir de ahí: una firma que
 * menciona `Producto` o `EstadoPedido` necesita importarlos de `…domain`, y el
 * paquete base solo se conoce aquí. Es el mismo reparto que ya hace
 * `dtoImportsFor`, por el mismo motivo.
 *
 * Se descarta el import del identificador porque la plantilla ya lo emite por
 * su cuenta, y un `import` repetido no compila.
 */
function serviceImportsFor(
  ir: GenerationIR,
  entity: EntityIR,
  paquetes: Map<string, string>,
): string[] {
  const imports = new Set(entity.methodImports);

  for (const method of entity.methods) {
    for (const tipo of [method.returnType, ...method.parameters.map((p) => p.javaType)]) {
      // `List<Producto>` referencia a `Producto`: hay que mirar dentro.
      const base = tipo.replace(/^List<(.+)>$/, '$1');
      // La propia entidad va aparte: la implementación ya la importa para el
      // CRUD y repetir el import no compila. Ver `serviceNeedsOwnEntity`.
      if (base === entity.className) continue;
      const paquete = paquetes.get(base);
      if (paquete !== undefined) imports.add(`${paquete}.domain.${base}`);
    }
  }

  imports.delete(entity.identifier.javaImport ?? '');
  return [...imports].sort();
}

/**
 * Todas las clases del diagrama con el paquete en el que se van a escribir.
 *
 * Es el índice que permite que una clase de un módulo importe a otra de un
 * módulo distinto. Antes de los módulos no hacía falta —todo colgaba de
 * `basePackage.domain`— y por eso las plantillas lo construían con una
 * concatenación; ahora el destino manda, y solo se sabe mirándolo.
 */
function paquetesDeDominio(ir: GenerationIR): Map<string, string> {
  const paquetes = new Map<string, string>();
  for (const enumeration of ir.enums) paquetes.set(enumeration.className, enumeration.packageName);
  for (const contract of ir.interfaces) paquetes.set(contract.className, contract.packageName);
  for (const entity of ir.entities) paquetes.set(entity.className, entity.packageName);
  return paquetes;
}

/**
 * Imports que la entidad necesita por referirse a clases de otro módulo.
 *
 * Sin módulos esta función no devuelve nada: todo el dominio comparte paquete y
 * Java no pide import para el paquete propio. En cuanto `Pedido` vive en
 * `ventas` y `Cliente` en `clientes`, la referencia deja de resolverse sola y
 * falta el import — que es exactamente el fallo de compilación que hay que
 * evitar, y la razón por la que el reparto en módulos no puede ser cosmético.
 *
 * Se mira todo lo que la clase generada nombra: el tipo de las asociaciones,
 * los enumerados de sus campos, la superclase y las interfaces que realiza.
 */
function importsEntreModulos(
  ir: GenerationIR,
  entity: EntityIR,
  paquetes: Map<string, string>,
): string[] {
  const referidas = new Set<string>([
    ...entity.associations.map((a) => a.targetClass),
    ...entity.fields.filter((f) => f.isEnum).map((f) => f.javaType),
    ...entity.implementsInterfaces,
  ]);
  if (entity.superclass) referidas.add(entity.superclass);

  const imports: string[] = [];
  for (const nombre of referidas) {
    const paquete = paquetes.get(nombre);
    if (paquete === undefined || paquete === entity.packageName) continue;
    imports.push(`${paquete}.domain.${nombre}`);
  }
  return imports;
}

/**
 * ¿Alguna firma del diagrama menciona la propia entidad?
 *
 * Solo lo necesita la **interfaz** del servicio: la implementación ya importa
 * la entidad para el CRUD, y declararlo dos veces es un error de compilación.
 */
function mentionsOwnEntity(entity: EntityIR): boolean {
  return entity.methods.some((method) =>
    [method.returnType, ...method.parameters.map((p) => p.javaType)]
      .map((t) => t.replace(/^List<(.+)>$/, '$1'))
      .includes(entity.className),
  );
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function toOneView(association: AssociationIR, targetIdJavaType: string): ToOneView {
  const idFieldName = `${association.fieldName}Id`;
  return {
    fieldName: association.fieldName,
    setterName: association.setterName,
    targetClass: association.targetClass,
    targetVar: association.targetVar,
    idComponentName: idFieldName,
    nullable: association.nullable,
    idFieldName,
    idJavaType: targetIdJavaType,
    idGetterName: `get${capitalize(idFieldName)}`,
    idSetterName: `set${capitalize(idFieldName)}`,
  };
}

/**
 * Campos que la entidad hereda por la cadena de superclases.
 *
 * La plantilla de entidad no los declara —los hereda de verdad en Java— pero el
 * DTO sí debe transportarlos: un cliente de la API no sabe ni le importa que
 * `nombre` esté declarado en la clase padre.
 */
function inheritedFields(entity: EntityIR, byName: Map<string, EntityIR>): FieldIR[] {
  const result: FieldIR[] = [];
  const visited = new Set<string>([entity.className]);

  let current = entity.superclass ? byName.get(entity.superclass) : undefined;
  while (current && !visited.has(current.className)) {
    visited.add(current.className);
    result.unshift(...current.fields.filter((f) => !f.isIdentifier));
    current = current.superclass ? byName.get(current.superclass) : undefined;
  }
  return result;
}

/**
 * Métodos que la entidad hereda por realizar una interfaz.
 *
 * Sin esto el código no compila: el diagrama declara la realización pero no el
 * cuerpo del método. Se genera un esqueleto que lanza `UnsupportedOperationException`
 * en lugar de devolver un valor por defecto —un `return null` silencioso
 * convertiría una tarea pendiente en un fallo en tiempo de ejecución mucho más
 * tarde y en otro sitio.
 *
 * Se omiten los métodos que coincidirían con un accesor ya generado: el campo ya
 * los satisface y declararlos dos veces sí sería un error de compilación.
 */
function realizedInterfaces(
  ir: GenerationIR,
  entity: EntityIR,
): { methods: InterfaceMethodStub[]; imports: string[] } {
  const generatedMethods = new Set<string>([
    entity.identifier.getterName,
    entity.identifier.setterName,
    ...entity.fields.flatMap((f) => [f.getterName, f.setterName]),
    ...entity.associations.flatMap((a) => [a.getterName, a.setterName]),
    'equals',
    'hashCode',
  ]);

  const methods = new Map<string, InterfaceMethodStub>();
  const imports = new Set<string>();

  for (const name of entity.implementsInterfaces) {
    const contract = ir.interfaces.find((i) => i.className === name);
    if (!contract) continue;
    for (const imported of contract.imports) imports.add(imported);
    for (const method of contract.methods) {
      if (generatedMethods.has(method.name)) continue;
      if (methods.has(method.signature)) continue;
      methods.set(method.signature, { name: method.name, signature: method.signature });
    }
  }

  return { methods: [...methods.values()], imports: [...imports] };
}

function dedupeByClassName(
  associations: ToOneView[],
  paquetes: Map<string, string>,
  project: ProjectIR,
): RepositoryDependency[] {
  const seen = new Map<string, RepositoryDependency>();
  for (const assoc of associations) {
    if (seen.has(assoc.targetClass)) continue;
    seen.set(assoc.targetClass, {
      className: assoc.targetClass,
      varName: assoc.targetVar,
      packageName: paquetes.get(assoc.targetClass) ?? project.basePackage,
    });
  }
  return [...seen.values()];
}

/**
 * Imports de los DTOs. Además de los tipos de biblioteca (`java.time`,
 * `java.math`), incluye los enumerados del propio diagrama: viven en el paquete
 * `domain` y los records están en `dto`, así que sin import no compilan.
 */
function dtoImportsFor(
  ir: GenerationIR,
  fields: FieldIR[],
  associationComponents: DtoComponent[],
  paquetes: Map<string, string>,
): string[] {
  const imports = new Set<string>();
  const enumNames = new Set(ir.enums.map((e) => e.className));

  for (const field of fields) {
    if (field.javaImport) imports.add(field.javaImport);
    if (enumNames.has(field.javaType)) {
      imports.add(`${paquetes.get(field.javaType) ?? ir.project.basePackage}.domain.${field.javaType}`);
    }
  }
  for (const component of associationComponents) {
    if (component.javaType === 'UUID') imports.add('java.util.UUID');
  }
  return [...imports].sort();
}

// ---------------------------------------------------------------------------
// Árbol de ficheros
// ---------------------------------------------------------------------------

/** `com.tienda.ventas` → `src/main/java/com/tienda/ventas`. */
function raizDe(packageName: string): string {
  return `src/main/java/${packageName.split('.').join('/')}`;
}

export function generateProject(ir: GenerationIR): GeneratedFile[] {
  switch (ir.project.databaseTarget) {
    case 'mongodb':
      return generateMongoProject(ir);
    case 'cassandra':
      return generateCassandraProject(ir);
    default:
      return generatePostgresProject(ir);
  }
}

function generatePostgresProject(ir: GenerationIR): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const javaRoot = `src/main/java/${ir.project.basePackagePath}`;
  const context = {
    project: ir.project,
    entities: ir.entities,
    migration: ir.migration,
    seed: ir.seed,
  };

  files.push({ path: 'pom.xml', content: render('pom.xml.hbs', context) });
  files.push({ path: 'run.bat', content: render('run.bat.hbs', context) });
  files.push({ path: 'README.md', content: render('README.md.hbs', context) });
  files.push({ path: '.gitignore', content: render('gitignore.hbs', context) });
  files.push({ path: 'docker-compose.yml', content: render('docker-compose.yml.hbs', context) });
  files.push({
    path: 'src/main/resources/application.yml',
    content: render('application.yml.hbs', context),
  });
  files.push({
    path: `src/main/resources/db/migration/V${ir.migration.version}__esquema_inicial.sql`,
    content: render('migration.sql.hbs', context),
  });

  // Solo si hay algo que insertar. Una migración vacía no rompe nada, pero deja
  // en el proyecto un fichero que invita a preguntarse qué falta ahí.
  if (ir.seed.length > 0) {
    files.push({
      path: 'src/main/resources/db/migration/V2__datos_iniciales.sql',
      content: render('data.sql.hbs', context),
    });
  }

  // Idempotencia de las escrituras que llegan del móvil sin conexión. Va en la
  // versión 3 y no en la 1 porque la 1 puede estar ya aplicada en una base de
  // datos existente y reescribirla rompería su checksum; la 2 la ocupan los
  // datos iniciales cuando los hay.
  files.push({
    path: 'src/main/resources/db/migration/V3__idempotencia.sql',
    content: render('idempotencia.sql.hbs', context),
  });

  // El manifiesto que lee la app móvil genérica. Se emite como recurso del
  // classpath en vez de incrustarlo en una cadena Java: así se puede abrir y
  // leer en el proyecto generado, y el controlador se queda sin lógica.
  files.push({
    path: 'src/main/resources/asistente/manifiesto.json',
    content: renderManifiesto(ir),
  });

  files.push({
    path: `${javaRoot}/Application.java`,
    content: render('Application.java.hbs', context),
  });

  files.push({
    path: `${javaRoot}/controller/ManifiestoController.java`,
    content: render('ManifiestoController.java.hbs', context),
  });

  for (const name of ['AlmacenIdempotencia', 'FiltroIdempotencia']) {
    files.push({
      path: `${javaRoot}/infraestructura/${name}.java`,
      content: render(`${name}.java.hbs`, context),
    });
  }

  for (const name of ['ResourceNotFoundException', 'GlobalExceptionHandler', 'ErrorResponse']) {
    files.push({
      path: `${javaRoot}/exception/${name}.java`,
      content: render(`${name}.java.hbs`, context),
    });
  }

  for (const enumeration of ir.enums) {
    files.push({
      path: `${raizDe(enumeration.packageName)}/domain/${enumeration.className}.java`,
      content: render('enum.java.hbs', {
        project: ir.project,
        enumeration,
        pkg: enumeration.packageName,
      }),
    });
  }

  for (const contract of ir.interfaces) {
    files.push({
      path: `${raizDe(contract.packageName)}/domain/${contract.className}.java`,
      content: render('interface.java.hbs', {
        project: ir.project,
        contract,
        pkg: contract.packageName,
      }),
    });
  }

  const entityViews: EntityView[] = [];

  for (const entity of ir.entities) {
    const view = buildEntityView(ir, entity);
    const name = entity.className;
    // La carpeta sale del paquete de la entidad, no del paquete base. Es lo
    // que hace que el módulo se vea en el árbol del ZIP y no solo en la
    // primera línea del fichero.
    const raiz = raizDe(entity.packageName);

    files.push({
      path: `${raiz}/domain/${name}.java`,
      content: render('entity.java.hbs', view),
    });

    // Una entidad abstracta no se instancia: no tiene sentido darle un CRUD.
    // Sus subclases exponen el suyo y arrastran los campos heredados.
    if (entity.isAbstract) continue;

    entityViews.push(view);

    files.push({
      path: `${raiz}/repository/${name}Repository.java`,
      content: render('repository.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/${name}Request.java`,
      content: render('dto-request.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/${name}Response.java`,
      content: render('dto-response.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/mapper/${name}Mapper.java`,
      content: render('mapper.java.hbs', view),
    });
    files.push({
      path: `${raiz}/service/${name}Service.java`,
      content: render('service.java.hbs', view),
    });
    files.push({
      path: `${raiz}/service/impl/${name}ServiceImpl.java`,
      content: render('service-impl.java.hbs', view),
    });
    files.push({
      path: `${raiz}/controller/${name}Controller.java`,
      content: render('controller.java.hbs', view),
    });
  }

  // Al final: necesita la vista de cada entidad concreta, que solo existe una
  // vez recorrido el bucle de arriba.
  files.push({
    path: 'postman_collection.json',
    content: buildPostmanCollection(ir, entityViews),
  });

  assertSafePaths(files);
  return files;
}

/**
 * Variante MongoDB.
 *
 * Mismo árbol de capas 2/3/4 que la variante PostgreSQL —misma `EntityView`,
 * mismos DTOs y controlador—, pero sin Flyway, sin JPA y sin datos iniciales:
 * `ir.seed` llega en forma de literales SQL (ver `SeedInsertIR`) y no hay
 * conversión a documentos Mongo todavía, así que un diagrama con filas de
 * ejemplo genera igual pero sin sembrarlas. La herencia tampoco se modela con
 * `extends`: cada entidad concreta lleva sus campos ya aplanados (ver
 * `entity-mongo.java.hbs` y `allFields` en `buildEntityView`), así que las
 * clases abstractas no generan documento propio.
 */
function generateMongoProject(ir: GenerationIR): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const javaRoot = `src/main/java/${ir.project.basePackagePath}`;
  const context = { project: ir.project, entities: ir.entities };

  files.push({ path: 'pom.xml', content: render('pom-mongo.xml.hbs', context) });
  files.push({ path: 'run.bat', content: render('run.bat.hbs', context) });
  files.push({ path: 'README.md', content: render('README.md.hbs', context) });
  files.push({ path: '.gitignore', content: render('gitignore.hbs', context) });
  files.push({
    path: 'docker-compose.yml',
    content: render('docker-compose-mongo.yml.hbs', context),
  });
  files.push({
    path: 'src/main/resources/application.yml',
    content: render('application-mongo.yml.hbs', context),
  });

  files.push({
    path: 'src/main/resources/asistente/manifiesto.json',
    content: renderManifiesto(ir),
  });

  files.push({
    path: `${javaRoot}/Application.java`,
    content: render('Application.java.hbs', context),
  });

  files.push({
    path: `${javaRoot}/controller/ManifiestoController.java`,
    content: render('ManifiestoController.java.hbs', context),
  });

  files.push({
    path: `${javaRoot}/infraestructura/AlmacenIdempotencia.java`,
    content: render('AlmacenIdempotencia-mongo.java.hbs', context),
  });
  files.push({
    path: `${javaRoot}/infraestructura/FiltroIdempotencia.java`,
    content: render('FiltroIdempotencia.java.hbs', context),
  });

  for (const name of ['ResourceNotFoundException', 'GlobalExceptionHandler', 'ErrorResponse']) {
    files.push({
      path: `${javaRoot}/exception/${name}.java`,
      content: render(`${name}.java.hbs`, context),
    });
  }

  for (const enumeration of ir.enums) {
    files.push({
      path: `${raizDe(enumeration.packageName)}/domain/${enumeration.className}.java`,
      content: render('enum.java.hbs', {
        project: ir.project,
        enumeration,
        pkg: enumeration.packageName,
      }),
    });
  }

  for (const contract of ir.interfaces) {
    files.push({
      path: `${raizDe(contract.packageName)}/domain/${contract.className}.java`,
      content: render('interface.java.hbs', {
        project: ir.project,
        contract,
        pkg: contract.packageName,
      }),
    });
  }

  const entityViews: EntityView[] = [];

  for (const entity of ir.entities) {
    // Una entidad abstracta no se instancia y aquí no hay `extends`: sus
    // campos ya viven aplanados en cada subclase concreta (`allFields`), así
    // que no le corresponde ni documento ni CRUD propio.
    if (entity.isAbstract) continue;

    const view = buildEntityView(ir, entity);
    const name = entity.className;
    const raiz = raizDe(entity.packageName);
    entityViews.push(view);

    files.push({
      path: `${raiz}/domain/${name}.java`,
      content: render('entity-mongo.java.hbs', view),
    });
    files.push({
      path: `${raiz}/repository/${name}Repository.java`,
      content: render('repository-mongo.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/${name}Request.java`,
      content: render('dto-request.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/${name}Response.java`,
      content: render('dto-response.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/mapper/${name}Mapper.java`,
      content: render('mapper-mongo.java.hbs', view),
    });
    files.push({
      path: `${raiz}/service/${name}Service.java`,
      content: render('service.java.hbs', view),
    });
    files.push({
      path: `${raiz}/service/impl/${name}ServiceImpl.java`,
      content: render('service-impl-mongo.java.hbs', view),
    });
    files.push({
      path: `${raiz}/controller/${name}Controller.java`,
      content: render('controller.java.hbs', view),
    });
  }

  files.push({
    path: 'postman_collection.json',
    content: buildPostmanCollection(ir, entityViews),
  });

  assertSafePaths(files);
  return files;
}

/**
 * Variante Cassandra.
 *
 * Mismo árbol de capas 2/3/4 que la variante MongoDB —mismo esquema de
 * asociación por id plano, misma ausencia de Flyway/JPA/datos iniciales—,
 * pero con dos diferencias que no admiten reutilizar las plantillas de Mongo
 * tal cual: `CassandraRepository` no extiende `PagingAndSortingRepository`
 * (la paginación de `findAll` se hace a mano en `service-impl-cassandra`), y
 * las consultas derivadas sobre un campo que no es la clave de partición
 * necesitan un índice secundario explícito (`@Indexed` en
 * `entity-cassandra.java.hbs`) para no caer en `ALLOW FILTERING`.
 */
function generateCassandraProject(ir: GenerationIR): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const javaRoot = `src/main/java/${ir.project.basePackagePath}`;
  const context = { project: ir.project, entities: ir.entities };

  files.push({ path: 'pom.xml', content: render('pom-cassandra.xml.hbs', context) });
  files.push({ path: 'run.bat', content: render('run.bat.hbs', context) });
  files.push({ path: 'README.md', content: render('README.md.hbs', context) });
  files.push({ path: '.gitignore', content: render('gitignore.hbs', context) });
  files.push({
    path: 'docker-compose.yml',
    content: render('docker-compose-cassandra.yml.hbs', context),
  });
  files.push({
    path: 'src/main/resources/application.yml',
    content: render('application-cassandra.yml.hbs', context),
  });

  files.push({
    path: 'src/main/resources/asistente/manifiesto.json',
    content: renderManifiesto(ir),
  });

  files.push({
    path: `${javaRoot}/Application.java`,
    content: render('Application.java.hbs', context),
  });

  files.push({
    path: `${javaRoot}/controller/ManifiestoController.java`,
    content: render('ManifiestoController.java.hbs', context),
  });

  files.push({
    path: `${javaRoot}/infraestructura/AlmacenIdempotencia.java`,
    content: render('AlmacenIdempotencia-cassandra.java.hbs', context),
  });
  files.push({
    path: `${javaRoot}/infraestructura/FiltroIdempotencia.java`,
    content: render('FiltroIdempotencia.java.hbs', context),
  });

  for (const name of ['ResourceNotFoundException', 'GlobalExceptionHandler', 'ErrorResponse']) {
    files.push({
      path: `${javaRoot}/exception/${name}.java`,
      content: render(`${name}.java.hbs`, context),
    });
  }

  for (const enumeration of ir.enums) {
    files.push({
      path: `${raizDe(enumeration.packageName)}/domain/${enumeration.className}.java`,
      content: render('enum.java.hbs', {
        project: ir.project,
        enumeration,
        pkg: enumeration.packageName,
      }),
    });
  }

  for (const contract of ir.interfaces) {
    files.push({
      path: `${raizDe(contract.packageName)}/domain/${contract.className}.java`,
      content: render('interface.java.hbs', {
        project: ir.project,
        contract,
        pkg: contract.packageName,
      }),
    });
  }

  const entityViews: EntityView[] = [];

  for (const entity of ir.entities) {
    // Igual que en Mongo: sin `extends`, cada entidad concreta ya lleva sus
    // campos heredados aplanados, así que una superclase abstracta no tiene
    // tabla ni CRUD propios.
    if (entity.isAbstract) continue;

    const view = buildEntityView(ir, entity);
    const name = entity.className;
    const raiz = raizDe(entity.packageName);
    entityViews.push(view);

    files.push({
      path: `${raiz}/domain/${name}.java`,
      content: render('entity-cassandra.java.hbs', view),
    });
    files.push({
      path: `${raiz}/repository/${name}Repository.java`,
      content: render('repository-cassandra.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/${name}Request.java`,
      content: render('dto-request.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/${name}Response.java`,
      content: render('dto-response.java.hbs', view),
    });
    files.push({
      path: `${raiz}/dto/mapper/${name}Mapper.java`,
      content: render('mapper-cassandra.java.hbs', view),
    });
    files.push({
      path: `${raiz}/service/${name}Service.java`,
      content: render('service.java.hbs', view),
    });
    files.push({
      path: `${raiz}/service/impl/${name}ServiceImpl.java`,
      content: render('service-impl-cassandra.java.hbs', view),
    });
    files.push({
      path: `${raiz}/controller/${name}Controller.java`,
      content: render('controller.java.hbs', view),
    });
  }

  files.push({
    path: 'postman_collection.json',
    content: buildPostmanCollection(ir, entityViews),
  });

  assertSafePaths(files);
  return files;
}

/**
 * Última línea de defensa de RNF-SEG-06.
 *
 * Los nombres ya se validaron contra lista blanca antes de llegar aquí, pero
 * esta comprobación es barata y cubre el caso de que una ruta se componga mal
 * en el futuro. Escribir fuera del directorio de salida convierte un generador
 * de código en una escritura arbitraria de ficheros.
 */
function assertSafePaths(files: GeneratedFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`Ruta de fichero generada no segura: ${file.path}`);
    }
    if (seen.has(file.path)) {
      throw new Error(`Dos ficheros generados comparten la ruta ${file.path}`);
    }
    seen.add(file.path);
  }
}
