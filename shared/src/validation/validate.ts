import {
  type ClassDiagram,
  type UmlClass,
  isPersistent,
  isToMany,
  listClasses,
  listModules,
  listRelations,
  parseMultiplicity,
} from '../model/uml.js';
import { isPrimitiveType, resolveTypeName } from '../model/type-catalog.js';
import {
  isValidJavaIdentifier,
  isValidJavaPackage,
  isValidJavaPackageSegment,
  isValidSqlIdentifier,
  pluralize,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
} from '../model/naming.js';

/**
 * Validación bloqueante previa a la generación (RF-GEN-11).
 *
 * Los errores impiden generar; los avisos no. La distinción importa: generar un
 * proyecto que no compila desplaza el diagnóstico del problema a un stack trace
 * de Maven, donde el usuario no tiene forma de relacionarlo con su diagrama.
 *
 * ## Por qué vive en `shared` y no en `generator`
 *
 * Estuvo en `generator/src/validation/` desde el principio, y tenía sentido
 * mientras la única pregunta fuese «¿emito el ZIP o devuelvo los errores?». Pero
 * el fichero nunca importó nada del generador: ni una plantilla, ni la IR, ni
 * Handlebars. Solo el modelo y las convenciones de nombres, que ya vivían aquí.
 *
 * Lo que forzó la mudanza fue el navegador. `frontend` depende de `@app/shared` y
 * no puede depender de `@app/generator`, que arrastra `handlebars` y `archiver`
 * —código de Node que no se empaqueta—. Mientras esto viviera allí, la única
 * forma que tenía el editor de saber si un diagrama se podía generar era
 * preguntárselo al servidor, y eso convierte en dependiente de la red una
 * pregunta que es puramente local; el requisito de trabajar sin conexión
 * (RF-OFF-04) no lo admite. La reparación automática —`reparacion/reparar.ts`—
 * lo habría hecho inviable de todos modos: valida, aplica y vuelve a validar en
 * bucle, y eso son varias pasadas por pulsación.
 *
 * `generator` la sigue reexportando, así que nada de lo que ya la importaba tuvo
 * que cambiar.
 */

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  severity: Severity;
  /** Código estable, para agregación de métricas (Arquitectura §2.10.3). */
  code: string;
  message: string;
  /** Identificador del elemento afectado, para resaltarlo en el lienzo. */
  elementId?: string;
  elementName?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function validateDiagram(diagram: ClassDiagram): ValidationResult {
  const issues: ValidationIssue[] = [];

  validateProjectMeta(diagram, issues);
  validateModules(diagram, issues);
  validateClassNames(diagram, issues);
  validateNameCollisions(diagram, issues);
  validateIdentifiers(diagram, issues);
  validateAttributeTypes(diagram, issues);
  validateMethodSignatures(diagram, issues);
  validateEnums(diagram, issues);
  validateRelationEndpoints(diagram, issues);
  validateInheritance(diagram, issues);
  validateCompositionCycles(diagram, issues);
  validateMultiplicities(diagram, issues);
  validateAssociationClasses(diagram, issues);
  validateMethods(diagram, issues);

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------

function validateProjectMeta(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  const { basePackage, artifactId } = diagram.meta;

  if (!isValidJavaPackage(basePackage)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_BASE_PACKAGE',
      message:
        `El paquete base «${basePackage}» no es válido. Use minúsculas y segmentos ` +
        `separados por punto, sin palabras reservadas de Java (por ejemplo: com.ejemplo.proyecto).`,
    });
  }

  if (!/^[a-z][a-z0-9-]*$/.test(artifactId)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_ARTIFACT_ID',
      message: `El identificador de artefacto «${artifactId}» debe ser minúsculas, dígitos y guiones.`,
    });
  }

  if (listClasses(diagram).length === 0) {
    issues.push({
      severity: 'error',
      code: 'EMPTY_DIAGRAM',
      message: 'El diagrama no contiene ninguna clase.',
    });
  }
}

/**
 * Los módulos, que aportan un tramo al paquete de las clases que contienen.
 *
 * Se comprueba aquí además de en la operación que los crea porque un diagrama
 * puede llegar de otro sitio —un XMI importado, un fichero copiado a mano, una
 * versión futura del formato— y este es el último punto antes de que el
 * segmento se convierta en un `package …;` y en una carpeta del ZIP.
 *
 * Los dos módulos con el mismo segmento no son un error de compilación sino
 * algo peor: sus ficheros se mezclan en una carpeta y nadie lo advierte hasta
 * que dos clases con el mismo nombre se pisan.
 */
function validateModules(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  const porSegmento = new Map<string, string[]>();

  for (const modulo of listModules(diagram)) {
    if (!isValidJavaPackageSegment(modulo.packageSegment)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_MODULE_SEGMENT',
        message:
          `El módulo «${modulo.name}» usa el paquete «${modulo.packageSegment}», que no es ` +
          `un único segmento Java en minúsculas (por ejemplo: ventas, inventario).`,
        elementId: modulo.id,
        elementName: modulo.name,
      });
      continue;
    }

    const bucket = porSegmento.get(modulo.packageSegment) ?? [];
    bucket.push(modulo.name);
    porSegmento.set(modulo.packageSegment, bucket);
  }

  for (const [segmento, nombres] of porSegmento) {
    if (nombres.length > 1) {
      issues.push({
        severity: 'error',
        code: 'MODULE_SEGMENT_COLLISION',
        message:
          `${nombres.length} módulos (${nombres.map((n) => `«${n}»`).join(', ')}) usan el ` +
          `paquete «${segmento}»: sus clases acabarían mezcladas en la misma carpeta.`,
      });
    }
  }
}

/** Regla 5: nombres válidos y no reservados en Java y en SQL. */
function validateClassNames(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  for (const cls of listClasses(diagram)) {
    const javaName = toPascalCase(cls.name);

    if (!isValidJavaIdentifier(javaName)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_CLASS_NAME',
        message:
          `«${cls.name}» no produce un identificador Java válido. Use solo letras, ` +
          `dígitos y guion bajo, y evite palabras reservadas.`,
        elementId: cls.id,
        elementName: cls.name,
      });
      continue;
    }

    if (isPersistent(cls)) {
      const tableName = toSnakeCase(pluralize(cls.name));
      if (!isValidSqlIdentifier(tableName)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_TABLE_NAME',
          message:
            `La clase «${cls.name}» generaría la tabla «${tableName}», que no es un ` +
            `nombre válido en PostgreSQL (palabra reservada o longitud excesiva). Renómbrela.`,
          elementId: cls.id,
          elementName: cls.name,
        });
      }
    }

    for (const attr of cls.attributes) {
      const fieldName = attr.name;
      if (!isValidJavaIdentifier(fieldName)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_ATTRIBUTE_NAME',
          message: `El atributo «${attr.name}» de «${cls.name}» no es un identificador Java válido.`,
          elementId: cls.id,
          elementName: cls.name,
        });
      }
      const columnName = toSnakeCase(attr.name);
      if (!isValidSqlIdentifier(columnName)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_COLUMN_NAME',
          message:
            `El atributo «${attr.name}» de «${cls.name}» generaría la columna ` +
            `«${columnName}», reservada o no válida en PostgreSQL.`,
          elementId: cls.id,
          elementName: cls.name,
        });
      }
    }

    for (const method of cls.methods) {
      if (!isValidJavaIdentifier(method.name)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_METHOD_NAME',
          message: `El método «${method.name}» de «${cls.name}» no es un identificador Java válido.`,
          elementId: cls.id,
          elementName: cls.name,
        });
      }
    }
  }
}

/** Regla 6: sin colisiones de nombre tras aplicar convenciones. */
function validateNameCollisions(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  const byJavaName = new Map<string, UmlClass[]>();
  for (const cls of listClasses(diagram)) {
    const key = toPascalCase(cls.name);
    const bucket = byJavaName.get(key);
    if (bucket) bucket.push(cls);
    else byJavaName.set(key, [cls]);
  }

  for (const [javaName, classes] of byJavaName) {
    if (classes.length > 1) {
      issues.push({
        severity: 'error',
        code: 'CLASS_NAME_COLLISION',
        message:
          `${classes.length} clases (${classes.map((c) => `«${c.name}»`).join(', ')}) ` +
          `generarían el mismo tipo Java «${javaName}» y el mismo archivo. Renombre una de ellas.`,
        elementId: classes[0]!.id,
        elementName: classes[0]!.name,
      });
    }
  }

  for (const cls of listClasses(diagram)) {
    const seen = new Set<string>();
    for (const attr of cls.attributes) {
      const key = attr.name.toLowerCase();
      if (seen.has(key)) {
        issues.push({
          severity: 'error',
          code: 'ATTRIBUTE_NAME_COLLISION',
          message: `«${cls.name}» tiene dos atributos llamados «${attr.name}».`,
          elementId: cls.id,
          elementName: cls.name,
        });
      }
      seen.add(key);
    }
  }
}

/** Regla 1: toda entidad persistente tiene identificador, y uno solo. */
function validateIdentifiers(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  for (const cls of listClasses(diagram)) {
    if (!isPersistent(cls)) continue;

    const identifiers = cls.attributes.filter((a) => a.isIdentifier);
    const inherited = hasInheritedIdentifier(diagram, cls);

    /*
      Una subclase que declara su propia clave primaria.

      Esto se escapaba porque las dos comprobaciones de abajo lo dan por bueno:
      hay exactamente un identificador y no falta ninguno. Y sin embargo lo que
      se genera está roto de tres formas a la vez, todas silenciosas:

      1. `resolveIdentifier` (generator/src/ir/normalize.ts) prefiere el propio
         al heredado, así que la clave de la subclase gana.
      2. `generate.ts` excluye el identificador de la lista de campos, y la
         plantilla de entidad no emite `@Id` cuando hay superclase. Resultado:
         el atributo **desaparece** del Java generado. Un `Check.holderName`
         marcado como clave no sale por ningún lado, y nadie lo echa en falta
         hasta buscar el dato en producción.
      3. El DDL cuelga la clave ajena al padre de esa misma columna, con el
         tipo de la subclase apuntando al tipo del padre. `checks.holder_name
         VARCHAR(255)` referenciando `payments.payment_id BIGINT` es una FK que
         PostgreSQL rechaza al arrancar.

      Es error y no aviso porque ninguno de los tres efectos es recuperable
      leyendo el código: el proyecto se descarga, compila a medias y falla al
      levantar el esquema, que es el peor sitio para enterarse.

      Se comprueba también en las abstractas —al contrario que las dos reglas
      siguientes— porque una clase abstracta puede heredar de otra, y el
      generador la trata igual.
    */
    if (inherited && identifiers.length > 0) {
      const nombres = identifiers.map((a) => `«${a.name}»`).join(', ');
      issues.push({
        severity: 'error',
        code: 'SUBCLASS_DECLARES_IDENTIFIER',
        message:
          `«${cls.name}» hereda la clave primaria de su superclase y además declara ` +
          `${nombres} como identificador. La identidad se hereda, no se vuelve a ` +
          `declarar: desmarque ${identifiers.length === 1 ? 'ese atributo' : 'esos atributos'} ` +
          `para que ${identifiers.length === 1 ? 'siga siendo un dato' : 'sigan siendo datos'} ` +
          `de «${cls.name}».`,
        elementId: cls.id,
        elementName: cls.name,
      });
    }

    if (cls.kind === 'abstract') continue;

    if (identifiers.length === 0 && !inherited) {
      issues.push({
        severity: 'error',
        code: 'MISSING_IDENTIFIER',
        message:
          `La entidad «${cls.name}» no tiene ningún atributo marcado como identificador. ` +
          `JPA no puede mapearla sin clave primaria: marque un atributo como identificador ` +
          `o añada uno de tipo Long.`,
        elementId: cls.id,
        elementName: cls.name,
      });
    }

    if (identifiers.length > 1) {
      issues.push({
        severity: 'error',
        code: 'MULTIPLE_IDENTIFIERS',
        message:
          `«${cls.name}» tiene ${identifiers.length} atributos marcados como identificador. ` +
          `Las claves primarias compuestas no están soportadas en esta versión.`,
        elementId: cls.id,
        elementName: cls.name,
      });
    }
  }
}

function hasInheritedIdentifier(diagram: ClassDiagram, cls: UmlClass): boolean {
  const seen = new Set<string>([cls.id]);
  let current: UmlClass | undefined = cls;

  while (current) {
    const relation = listRelations(diagram).find(
      (r) => r.kind === 'inheritance' && r.source.classId === current!.id,
    );
    if (!relation) return false;
    const parent = diagram.classes[relation.target.classId];
    if (!parent || seen.has(parent.id)) return false;
    if (parent.attributes.some((a) => a.isIdentifier)) return true;
    seen.add(parent.id);
    current = parent;
  }
  return false;
}

/** Regla 2: los tipos de atributo pertenecen al catálogo o son clases del diagrama. */
function validateAttributeTypes(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  const classNames = new Set(listClasses(diagram).map((c) => toPascalCase(c.name)));

  for (const cls of listClasses(diagram)) {
    for (const attr of cls.attributes) {
      const typeName = attr.type.name;
      const known = isPrimitiveType(typeName) || classNames.has(toPascalCase(typeName));

      if (!known) {
        issues.push({
          severity: 'error',
          code: 'UNKNOWN_TYPE',
          message:
            `El atributo «${cls.name}.${attr.name}» usa el tipo «${typeName}», que no ` +
            `está en el catálogo soportado ni corresponde a una clase del diagrama.`,
          elementId: cls.id,
          elementName: cls.name,
        });
        continue;
      }

      if (attr.isIdentifier) {
        const canonical = resolveTypeName(typeName);
        if (!canonical || !['Long', 'Integer', 'UUID', 'String'].includes(canonical)) {
          issues.push({
            severity: 'error',
            code: 'INVALID_IDENTIFIER_TYPE',
            message:
              `El identificador «${cls.name}.${attr.name}» es de tipo «${typeName}». ` +
              `Use Long, Integer, UUID o String.`,
            elementId: cls.id,
            elementName: cls.name,
          });
        }
      }
    }
  }
}

/**
 * Regla 2b: la firma completa de cada método —parámetros y tipo de retorno—.
 *
 * SEGURIDAD (RNF-SEG-06). La regla 5 valida el *nombre* del método, y la regla 2
 * los tipos de los *atributos*. Entre las dos quedaba un hueco por el que pasaba
 * todo lo demás de la firma: el nombre de cada parámetro, su tipo y el tipo de
 * retorno. Ese hueco importa porque `normalize.ts` compone con esos tres valores
 * la cadena `signature`, y las plantillas la interpolan sin escapar
 * (`{{{signature}}}` en `interface`, `entity`, `service` y `service-impl`). Un
 * parámetro llamado `a) { } public static void otro(` se colaba con la
 * validación en verde y salía como Java que no compila.
 *
 * Se valida **la forma que se emite**, no la que se escribió. `toCamelCase` es
 * lo que acaba en la plantilla, así que es lo que tiene que encajar con la lista
 * blanca; comprobar el original dejaría pasar lo que la conversión estropee y
 * rechazaría un `fecha alta` que es perfectamente legítimo.
 *
 * Los tipos se comprueban contra el catálogo o contra las clases del diagrama,
 * igual que en la regla 2, en lugar de con un patrón de identificador: un tipo
 * que no existe tampoco compila, aunque se escriba con letras.
 */
function validateMethodSignatures(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  const classNames = new Set(listClasses(diagram).map((c) => toPascalCase(c.name)));
  const tipoConocido = (nombre: string): boolean =>
    isPrimitiveType(nombre) || classNames.has(toPascalCase(nombre));

  for (const cls of listClasses(diagram)) {
    for (const method of cls.methods) {
      const donde = `${cls.name}.${method.name}()`;

      if (method.returnType && !tipoConocido(method.returnType.name)) {
        issues.push({
          severity: 'error',
          code: 'UNKNOWN_RETURN_TYPE',
          message:
            `${donde} devuelve «${method.returnType.name}», que no está en el catálogo ` +
            `soportado ni corresponde a una clase del diagrama.`,
          elementId: cls.id,
          elementName: cls.name,
        });
      }

      const vistos = new Set<string>();
      for (const param of method.parameters) {
        const javaName = toCamelCase(param.name);

        if (!isValidJavaIdentifier(javaName)) {
          issues.push({
            severity: 'error',
            code: 'INVALID_PARAMETER_NAME',
            message:
              `El parámetro «${param.name}» de ${donde} no produce un identificador Java ` +
              `válido. Use solo letras, dígitos y guion bajo, y evite palabras reservadas.`,
            elementId: cls.id,
            elementName: cls.name,
          });
        } else if (vistos.has(javaName)) {
          // Dos parámetros que se llamen igual tras la conversión no compilan,
          // y el diagrama puede distinguirlos («fecha alta» y «fechaAlta»)
          // aunque el Java resultante ya no.
          issues.push({
            severity: 'error',
            code: 'DUPLICATE_PARAMETER_NAME',
            message: `${donde} tiene dos parámetros que se llamarían «${javaName}» en Java.`,
            elementId: cls.id,
            elementName: cls.name,
          });
        }
        vistos.add(javaName);

        if (!tipoConocido(param.type.name)) {
          issues.push({
            severity: 'error',
            code: 'UNKNOWN_PARAMETER_TYPE',
            message:
              `El parámetro «${param.name}» de ${donde} es de tipo «${param.type.name}», que ` +
              `no está en el catálogo soportado ni corresponde a una clase del diagrama.`,
            elementId: cls.id,
            elementName: cls.name,
          });
        }
      }
    }
  }
}

function validateEnums(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  for (const cls of listClasses(diagram)) {
    if (cls.kind !== 'enum') continue;

    if (cls.literals.length === 0) {
      issues.push({
        severity: 'error',
        code: 'EMPTY_ENUM',
        message: `La enumeración «${cls.name}» no tiene ningún literal.`,
        elementId: cls.id,
        elementName: cls.name,
      });
    }

    // El generador emite cada literal en mayúsculas (`normalize.ts`), así que
    // `activo` y `ACTIVO` son válidos por separado pero acaban en el mismo
    // valor Java, y una enumeración con un valor repetido no compila.
    const vistos = new Map<string, string>();
    for (const literal of cls.literals) {
      if (!isValidJavaIdentifier(literal)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_ENUM_LITERAL',
          message: `El literal «${literal}» de «${cls.name}» no es un identificador Java válido.`,
          elementId: cls.id,
          elementName: cls.name,
        });
        continue;
      }
      const generado = literal.toUpperCase();
      const anterior = vistos.get(generado);
      if (anterior !== undefined) {
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_ENUM_LITERAL',
          message:
            `Los literales «${anterior}» y «${literal}» de «${cls.name}» generan el mismo ` +
            `valor Java «${generado}».`,
          elementId: cls.id,
          elementName: cls.name,
        });
        continue;
      }
      vistos.set(generado, literal);
    }
  }
}

function validateRelationEndpoints(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  for (const relation of listRelations(diagram)) {
    const source = diagram.classes[relation.source.classId];
    const target = diagram.classes[relation.target.classId];

    if (!source || !target) {
      issues.push({
        severity: 'error',
        code: 'DANGLING_RELATION',
        message: 'Una relación apunta a una clase que ya no existe en el diagrama.',
        elementId: relation.id,
      });
      continue;
    }

    if (relation.kind !== 'dependency' && source.id === target.id) {
      const selfSupported = ['association', 'aggregation'].includes(relation.kind);
      if (!selfSupported) {
        issues.push({
          severity: 'error',
          code: 'INVALID_SELF_RELATION',
          message: `«${source.name}» no puede tener una relación de tipo ${relation.kind} consigo misma.`,
          elementId: relation.id,
          elementName: source.name,
        });
      }
    }

    if (relation.kind === 'realization' && target.kind !== 'interface') {
      issues.push({
        severity: 'error',
        code: 'REALIZATION_TARGET_NOT_INTERFACE',
        message:
          `«${source.name}» realiza «${target.name}», que no es una interfaz. ` +
          `Use herencia en su lugar.`,
        elementId: relation.id,
        elementName: source.name,
      });
    }

    if (relation.kind === 'inheritance' && target.kind === 'interface') {
      issues.push({
        severity: 'warning',
        code: 'INHERITANCE_FROM_INTERFACE',
        message: `«${source.name}» hereda de la interfaz «${target.name}»; se generará como realización.`,
        elementId: relation.id,
        elementName: source.name,
      });
    }
  }
}

/** Regla 4: sin herencia múltiple entre clases, y sin ciclos de herencia. */
function validateInheritance(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  const parentsByChild = new Map<string, string[]>();

  for (const relation of listRelations(diagram)) {
    if (relation.kind !== 'inheritance') continue;
    const target = diagram.classes[relation.target.classId];
    if (target?.kind === 'interface') continue;

    const list = parentsByChild.get(relation.source.classId) ?? [];
    list.push(relation.target.classId);
    parentsByChild.set(relation.source.classId, list);
  }

  for (const [childId, parents] of parentsByChild) {
    if (parents.length > 1) {
      const child = diagram.classes[childId];
      const names = parents.map((p) => diagram.classes[p]?.name ?? p);
      issues.push({
        severity: 'error',
        code: 'MULTIPLE_INHERITANCE',
        message:
          `«${child?.name ?? childId}» hereda de ${parents.length} clases (${names.join(', ')}). ` +
          `Java no admite herencia múltiple: use interfaces.`,
        elementId: childId,
        elementName: child?.name,
      });
    }
  }

  const cycle = findCycle(parentsByChild);
  if (cycle) {
    const names = cycle.map((id) => diagram.classes[id]?.name ?? id);
    issues.push({
      severity: 'error',
      code: 'INHERITANCE_CYCLE',
      message: `Ciclo de herencia: ${names.join(' → ')}.`,
      elementId: cycle[0],
    });
  }
}

/** Regla 3: sin ciclos de composición (cascada de borrado infinita). */
function validateCompositionCycles(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  const graph = new Map<string, string[]>();

  for (const relation of listRelations(diagram)) {
    if (relation.kind !== 'composition') continue;
    const list = graph.get(relation.source.classId) ?? [];
    list.push(relation.target.classId);
    graph.set(relation.source.classId, list);
  }

  const cycle = findCycle(graph);
  if (cycle) {
    const names = cycle.map((id) => diagram.classes[id]?.name ?? id);
    issues.push({
      severity: 'error',
      code: 'COMPOSITION_CYCLE',
      message:
        `Ciclo de composición: ${names.join(' → ')}. Produciría una cascada de borrado ` +
        `infinita. Convierta alguna de las relaciones en agregación.`,
      elementId: cycle[0],
    });
  }
}

/** Regla 7 y 8: multiplicidades coherentes y resolubles a una anotación JPA. */
function validateMultiplicities(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  for (const relation of listRelations(diagram)) {
    if (relation.kind === 'inheritance' || relation.kind === 'realization') continue;
    if (relation.kind === 'dependency') continue;

    const source = diagram.classes[relation.source.classId];
    const target = diagram.classes[relation.target.classId];
    if (!source || !target) continue;

    for (const [end, label] of [
      [relation.source, source.name],
      [relation.target, target.name],
    ] as const) {
      const { lower, upper } = parseMultiplicity(end.multiplicity);
      if (upper !== null && lower > upper) {
        issues.push({
          severity: 'error',
          code: 'INVALID_MULTIPLICITY_RANGE',
          message:
            `La multiplicidad «${end.multiplicity}» en el extremo «${label}» tiene la cota ` +
            `inferior mayor que la superior.`,
          elementId: relation.id,
          elementName: label,
        });
      }
    }

    if (relation.kind === 'composition' && isToMany(relation.source.multiplicity)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_COMPOSITION_MULTIPLICITY',
        message:
          `La composición entre «${source.name}» y «${target.name}» tiene multiplicidad ` +
          `«${relation.source.multiplicity}» en el lado del todo. Una parte pertenece a un ` +
          `único todo: use 1 o 0..1, o convierta la relación en agregación.`,
        elementId: relation.id,
        elementName: source.name,
      });
    }

    if (target.kind === 'interface' || source.kind === 'interface') {
      issues.push({
        severity: 'error',
        code: 'ASSOCIATION_WITH_INTERFACE',
        message:
          `No se puede generar una asociación persistente entre «${source.name}» y ` +
          `«${target.name}» porque una de las dos es una interfaz.`,
        elementId: relation.id,
      });
    }

    if (target.kind === 'enum' || source.kind === 'enum') {
      issues.push({
        severity: 'error',
        code: 'ASSOCIATION_WITH_ENUM',
        message:
          `«${source.name}» y «${target.name}»: una enumeración no puede participar en una ` +
          `asociación. Úsela como tipo de un atributo.`,
        elementId: relation.id,
      });
    }
  }
}

/**
 * Regla 9: la clase de asociación (UML) solo tiene sentido colgada de una
 * relación N:M real, sin ser ella misma uno de los extremos, y debe poder
 * materializarse como tabla (el generador la usa como tabla de unión).
 */
function validateAssociationClasses(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  for (const relation of listRelations(diagram)) {
    if (!relation.associationClassId) continue;

    const assocClass = diagram.classes[relation.associationClassId];
    if (!assocClass) {
      issues.push({
        severity: 'error',
        code: 'DANGLING_ASSOCIATION_CLASS',
        message: 'Una relación señala como clase de asociación a una clase que ya no existe.',
        elementId: relation.id,
      });
      continue;
    }

    if (
      relation.kind !== 'association' ||
      !isToMany(relation.source.multiplicity) ||
      !isToMany(relation.target.multiplicity)
    ) {
      issues.push({
        severity: 'error',
        code: 'ASSOCIATION_CLASS_REQUIRES_MANY_TO_MANY',
        message:
          `«${assocClass.name}» está marcada como clase de asociación de una relación que no ` +
          `es muchos a muchos. Solo tiene sentido sobre una asociación N:M: sobre cualquier ` +
          `otra multiplicidad, la clase del lado "muchos" ya guarda esos mismos datos en su ` +
          `propia fila.`,
        elementId: relation.id,
        elementName: assocClass.name,
      });
    }

    if (
      relation.source.classId === relation.associationClassId ||
      relation.target.classId === relation.associationClassId
    ) {
      issues.push({
        severity: 'error',
        code: 'ASSOCIATION_CLASS_IS_ENDPOINT',
        message: `«${assocClass.name}» no puede ser a la vez un extremo de la relación y su clase de asociación.`,
        elementId: relation.id,
        elementName: assocClass.name,
      });
    }

    if (!isPersistent(assocClass) || assocClass.kind === 'interface' || assocClass.kind === 'enum') {
      issues.push({
        severity: 'error',
        code: 'ASSOCIATION_CLASS_NOT_PERSISTENT',
        message:
          `«${assocClass.name}» está marcada como clase de asociación pero no se genera como ` +
          `tabla (es transitoria, una interfaz o una enumeración), así que no hay dónde guardar ` +
          `la clave ajena a cada extremo.`,
        elementId: relation.id,
        elementName: assocClass.name,
      });
    }
  }
}

// ---------------------------------------------------------------------------

/** Detección de ciclos por DFS. Devuelve el ciclo encontrado, o null. */
function findCycle(graph: Map<string, string[]>): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  function visit(node: string): string[] | null {
    color.set(node, GREY);
    stack.push(node);

    for (const next of graph.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GREY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (state === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }

    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Operaciones que el generador va a dejar fuera de la capa de servicio.
 *
 * No es un error —el proyecto compila igual— pero sí algo que hay que decir.
 * Un método dibujado en el lienzo que no aparece por ningún lado del código
 * generado es exactamente la clase de silencio que hace desconfiar de un
 * generador. Aquí se avisa una vez por método, con su clase y su motivo.
 */
function validateMethods(diagram: ClassDiagram, issues: ValidationIssue[]): void {
  // Las que ocupa el CRUD generado. Debe coincidir con `METODOS_DEL_CRUD` de
  // `normalize.ts`; están separadas porque este módulo no importa de aquel.
  const delCrud = new Set(['findAll', 'findById', 'create', 'update', 'delete']);

  for (const cls of listClasses(diagram)) {
    // Las interfaces sí emiten todos sus métodos, con su visibilidad o sin
    // ella: son el contrato, no una entidad con CRUD alrededor.
    if (cls.kind === 'interface' || !isPersistent(cls)) continue;

    const accesores = new Set(
      cls.attributes.flatMap((a) => {
        const pascal = toPascalCase(a.name);
        return [`get${pascal}`, `set${pascal}`, `is${pascal}`];
      }),
    );

    for (const method of cls.methods) {
      const javaName = toCamelCase(method.name);
      const nombre = `${cls.name}.${method.name}()`;

      if (method.visibility !== '+') {
        issues.push({
          severity: 'warning',
          code: 'METHOD_NOT_PUBLIC',
          message:
            `${nombre} no es público, así que no entra en la interfaz del servicio: ` +
            'un contrato solo declara lo que se puede llamar desde fuera.',
          elementId: cls.id,
        });
      } else if (delCrud.has(javaName)) {
        issues.push({
          severity: 'warning',
          code: 'METHOD_CLASHES_WITH_CRUD',
          message:
            `${nombre} se llamaría «${javaName}», que es una de las operaciones que el ` +
            'servicio ya genera. Se descarta la del diagrama y se conserva la generada.',
          elementId: cls.id,
        });
      } else if (accesores.has(javaName)) {
        issues.push({
          severity: 'warning',
          code: 'METHOD_IS_ACCESSOR',
          message: `${nombre} ya lo genera el atributo correspondiente: se descarta.`,
          elementId: cls.id,
        });
      }
    }
  }
}
