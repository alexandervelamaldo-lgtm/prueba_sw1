import { toCamelCase, pluralize } from '../model/naming.js';
import { isPrimitiveType } from '../model/type-catalog.js';
import {
  isToMany,
  listClasses,
  listRelations,
  parseMultiplicity,
  type Attribute,
  type ClassDiagram,
  type Method,
  type UmlClass,
  type UmlRelation,
  type Visibility,
} from '../model/uml.js';
import { Xml } from './escritor.js';

/**
 * Exportación del diagrama a XMI 2.1 (RF-DIAG-12).
 *
 * DOS OBJETIVOS QUE TIRAN EN DIRECCIONES DISTINTAS. Un fichero que otra
 * herramienta UML pueda abrir tiene que ceñirse al estándar; un fichero que
 * conserve *nuestro* diagrama entero tiene que guardar cosas que el estándar no
 * contempla (qué atributo es la clave primaria, dónde está la caja en el
 * lienzo, las filas de datos de ejemplo). Se resuelve con las dos mitades que
 * el propio XMI prevé para esto:
 *
 * - El cuerpo es **UML 2.x estándar**: `uml:Class`, `uml:Interface`,
 *   `uml:Enumeration`, `ownedAttribute`, `ownedOperation`, `generalization`,
 *   `uml:Association` con sus `ownedEnd`. Es lo que lee cualquier herramienta.
 * - Al final va un bloque **`xmi:Extension`** con lo nuestro. Un lector ajeno
 *   lo ignora —para eso existe `extender`— y el nuestro recupera con él lo que
 *   el estándar habría perdido.
 *
 * Así, abrirlo en otra herramienta da el diagrama de clases correcto, y volver
 * a abrirlo aquí lo devuelve completo.
 *
 * CONTRASTADO CONTRA UN FICHERO DE ENTERPRISE ARCHITECT. Esto se escribió
 * primero contra la especificación de la OMG a secas, y abrirlo en EA salió
 * mal. Hay un `.xmi` exportado por EA en `fixtures/ea-comunicacion.xmi`, y las
 * tres formas que se corrigieron son las que ese fichero usa y la
 * especificación no obliga a usar:
 *
 * - **Las clases van dentro de un `uml:Package`**, no colgando del `uml:Model`.
 *   El nombre del proyecto es el del paquete; el modelo se llama `EA_Model`,
 *   como en los ficheros de EA. Sin ese paquete intermedio, EA no tiene dónde
 *   meter lo que importa y el nombre del modelo acaba pegado a todo lo que
 *   entra.
 * - **El tipo de un extremo de asociación es un hijo `<type xmi:idref="…"/>`**,
 *   no un atributo `type="…"`. Las dos formas son XMI válido y el importador de
 *   aquí acepta las dos; EA solo escribe —y solo lee bien— la primera. Con el
 *   atributo, los extremos llegaban sin tipo y la asociación no se enganchaba a
 *   ninguna caja.
 * - **Los primitivos de UML se referencian a la biblioteca estándar** por
 *   `href`, en vez de declararse como elementos del modelo. Declararlos metía
 *   en el proyecto de EA un elemento «String» y otro «Integer» que nadie había
 *   dibujado.
 *
 * El punto que sigue sin contrastar está señalado abajo, en `aggregation`,
 * donde las herramientas no coinciden en qué extremo de la asociación lleva la
 * marca. El importador acepta las dos formas justamente por eso.
 *
 * LO QUE NO VIAJA A EA: la posición de las cajas. EA guarda la geometría de sus
 * diagramas en su propio `xmi:Extension extender="Enterprise Architect"`. Al
 * importar esto, EA crea los elementos en el navegador de proyecto y el diagrama
 * se compone arrastrándolos. Nuestra propia extensión sí lleva las coordenadas,
 * así que entre esta herramienta y ella misma no se pierde nada.
 *
 * Se sabe cómo se escribe ese bloque —`ea-comunicacion.ts` lo escribe, con la
 * plantilla sacada del mismo fichero de EA que corrigió las tres formas de
 * arriba—, así que esto ya no es «no se puede» sino «no se ha hecho». La razón
 * de que siga sin hacerse es que aquí no hay una posición que llevar: el lienzo
 * de esta herramienta coloca las clases donde el usuario las arrastra, y su
 * sistema de coordenadas no es el de EA. Trasladarlo es un trabajo aparte, con
 * su propia forma de equivocarse, y el diagrama de clases se entiende igual con
 * las cajas recolocadas. Un diagrama de comunicación no: ahí la posición *es*
 * parte de lo que se lee, y por eso el otro módulo sí paga ese precio.
 */

const CABECERA = '<?xml version="1.0" encoding="UTF-8"?>';
const NS_XMI = 'http://schema.omg.org/spec/XMI/2.1';
const NS_UML = 'http://schema.omg.org/spec/UML/2.1';

export const EXTENDER = 'uml-colaborativo';

const VISIBILIDAD: Record<Visibility, string> = {
  '+': 'public',
  '-': 'private',
  '#': 'protected',
  '~': 'package',
};

/**
 * Los cuatro tipos de nuestro catálogo que UML define de serie.
 *
 * Se referencian a la biblioteca estándar en vez de declararse en el modelo,
 * que es lo que hace Enterprise Architect y lo que evita que abrir el fichero
 * llene el navegador de proyecto de elementos «String» y «Boolean» que nadie
 * puso en el diagrama. El resto del catálogo —`Long`, `Decimal`, `Date`…— no
 * existe en UML, así que ese sí hay que declararlo.
 */
const BIBLIOTECA_UML = 'http://schema.omg.org/spec/UML/2.1/uml.xml#';
const PRIMITIVOS_DE_UML = new Set(['String', 'Integer', 'Boolean', 'UnlimitedNatural', 'Real']);

/**
 * Cómo se apunta al tipo de un elemento tipado: a algo que está en este fichero
 * (`idref`) o a algo que está fuera de él (`href`).
 */
type RefTipo = { idref: string } | { href: string };

/** El `<type>` de un atributo, un parámetro o un extremo de asociación. */
function escribirTipo(xml: Xml, tipo: RefTipo): void {
  if ('idref' in tipo) {
    xml.vacio('type', { 'xmi:idref': tipo.idref });
    return;
  }
  xml.vacio('type', { 'xmi:type': 'uml:PrimitiveType', href: tipo.href });
}

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

/**
 * Los `xmi:id` se tratan como identificadores XML en la práctica, así que no
 * pueden empezar por un dígito ni llevar cualquier carácter. Un ULID empieza
 * por dígito la mitad de las veces, de modo que todos se emiten con el prefijo
 * `id_`. Lo que no encaje en el patrón recibe un identificador sintético, y no
 * se pierde nada: el bloque de extensión referencia estos mismos ids.
 */
const ID_ADMISIBLE = /^[A-Za-z0-9_.-]+$/;

class Ids {
  private readonly asignados = new Map<string, string>();
  private readonly usados = new Set<string>();
  private contador = 0;

  /** Id estable para un elemento del diagrama. */
  para(original: string): string {
    const previo = this.asignados.get(original);
    if (previo !== undefined) return previo;

    let candidato = ID_ADMISIBLE.test(original) ? `id_${original}` : this.siguiente('x');
    while (this.usados.has(candidato)) candidato = this.siguiente('x');

    this.usados.add(candidato);
    this.asignados.set(original, candidato);
    return candidato;
  }

  /** Id para un elemento que solo existe en el XMI (extremos, valores límite). */
  nuevo(prefijo: string): string {
    let candidato = this.siguiente(prefijo);
    while (this.usados.has(candidato)) candidato = this.siguiente(prefijo);
    this.usados.add(candidato);
    return candidato;
  }

  private siguiente(prefijo: string): string {
    return `id_${prefijo}${++this.contador}`;
  }
}

// ---------------------------------------------------------------------------

function limites(multiplicidad: string): { lower: string; upper: string } {
  const { lower, upper } = parseMultiplicity(multiplicidad);
  return { lower: String(lower), upper: upper === null ? '*' : String(upper) };
}

/** Multiplicidad efectiva de un atributo, que el modelo guarda repartida. */
function multiplicidadDeAtributo(atributo: Attribute): string {
  if (atributo.multiplicity !== undefined) return atributo.multiplicity;
  if (atributo.type.collection) return '*';
  return atributo.isNullable && !atributo.isIdentifier ? '0..1' : '1';
}

export function diagramaAXmi(diagrama: ClassDiagram): string {
  const ids = new Ids();
  const xml = new Xml();
  const clases = listClasses(diagrama);
  const relaciones = listRelations(diagrama);

  // Los tipos que de verdad se usan y que UML no trae de serie se declaran una
  // vez y se referencian por id. Declararlos todos ensuciaría el fichero con
  // tipos que el diagrama no menciona.
  const primitivos = new Map<string, string>();
  const anotar = (nombre: string): void => {
    if (isPrimitiveType(nombre) && !PRIMITIVOS_DE_UML.has(nombre)) primitivos.set(nombre, '');
  };
  for (const clase of clases) {
    for (const atributo of clase.attributes) anotar(atributo.type.name);
    for (const metodo of clase.methods) {
      if (metodo.returnType) anotar(metodo.returnType.name);
      for (const parametro of metodo.parameters) anotar(parametro.type.name);
    }
  }
  for (const nombre of [...primitivos.keys()]) {
    primitivos.set(nombre, ids.para(`primitive:${nombre}`));
  }

  const porNombre = new Map<string, UmlClass>();
  for (const clase of clases) porNombre.set(clase.name.toLowerCase(), clase);

  /**
   * A qué apunta el `<type>` de un elemento tipado.
   *
   * El último caso —un nombre que no es ni clase ni tipo del catálogo— no puede
   * referenciarse a nada, así que se escribe el nombre tal cual en el `href`.
   * Es información que ninguna herramienta va a resolver, pero que sigue en el
   * fichero y que al reimportarlo aquí se vuelve a leer, en vez de perderse.
   */
  const refTipo = (nombre: string): RefTipo => {
    const clase = porNombre.get(nombre.toLowerCase());
    if (clase) return { idref: ids.para(clase.id) };
    if (PRIMITIVOS_DE_UML.has(nombre)) return { href: `${BIBLIOTECA_UML}${nombre}` };
    const declarado = primitivos.get(nombre);
    if (declarado !== undefined) return { idref: declarado };
    return { href: nombre };
  };

  xml.crudo(CABECERA);
  xml.abrir('xmi:XMI', {
    'xmi:version': '2.1',
    'xmlns:xmi': NS_XMI,
    'xmlns:uml': NS_UML,
  });

  xml.vacio('xmi:Documentation', {
    exporter: 'Herramienta colaborativa de diagramas UML',
    exporterVersion: '1.0',
  });

  /*
   * MODELO Y PAQUETE SON DOS COSAS. El nombre del proyecto va en el paquete,
   * que es el contenedor que la herramienta de destino crea y enseña en su
   * navegador; el modelo es la raíz del fichero y se llama `EA_Model`, igual
   * que en los ficheros que exporta Enterprise Architect.
   *
   * Sin este paquete de por medio —con las clases colgando directamente del
   * `uml:Model`— abrir el fichero en EA acababa con el nombre del proyecto
   * repetido por todas partes: no había ningún elemento al que ese nombre le
   * correspondiera, así que se quedaba pegado a lo que entraba.
   */
  xml.abrir('uml:Model', {
    'xmi:type': 'uml:Model',
    'xmi:id': ids.para(diagrama.id),
    name: 'EA_Model',
    visibility: 'public',
  });

  xml.abrir('packagedElement', {
    'xmi:type': 'uml:Package',
    'xmi:id': ids.para(`package:${diagrama.id}`),
    name: diagrama.name,
    visibility: 'public',
  });

  for (const [nombre, id] of primitivos) {
    xml.vacio('packagedElement', {
      'xmi:type': 'uml:PrimitiveType',
      'xmi:id': id,
      name: nombre,
    });
  }

  /*
   * UNA RELACIÓN PUEDE COLGAR UNA "CLASE DE ASOCIACIÓN" (UML): una clase que,
   * además de sus propios atributos, *es* la asociación entre las otras dos
   * (`relation.associationClassId`). Si se escribiera como una clase suelta
   * más una `uml:Association` aparte —que es lo que hacía este fichero
   * antes de corregirlo—, Enterprise Architect dibuja las dos cajas
   * asociadas y la línea entre ellas, pero la tercera clase entra como una
   * clase cualquiera, sin la línea discontinua que la conecta a esa
   * asociación: deja de leerse como clase de asociación. El tipo que sí lleva
   * esa conexión es `uml:AssociationClass`, que en UML es a la vez
   * clasificador y asociación en un solo elemento; por eso, para la relación
   * que cuelga de ella, no se escribe un `uml:Association` aparte más abajo.
   */
  const relacionDeClaseAsociacion = new Map<string, UmlRelation>();
  for (const relacion of relaciones) {
    if (
      relacion.associationClassId &&
      !relacionDeClaseAsociacion.has(relacion.associationClassId)
    ) {
      relacionDeClaseAsociacion.set(relacion.associationClassId, relacion);
    }
  }

  for (const clase of clases) {
    escribirClase(xml, ids, clase, diagrama, refTipo, relacionDeClaseAsociacion.get(clase.id));
  }

  for (const relacion of relaciones) {
    const yaEscritaComoClaseDeAsociacion =
      relacion.associationClassId !== undefined &&
      relacionDeClaseAsociacion.get(relacion.associationClassId) === relacion;
    if (yaEscritaComoClaseDeAsociacion) continue;
    escribirRelacion(xml, ids, relacion, diagrama);
  }

  xml.cerrar('packagedElement');
  xml.cerrar('uml:Model');
  escribirExtension(xml, ids, diagrama);
  xml.cerrar('xmi:XMI');

  return xml.texto();
}

// ---------------------------------------------------------------------------

function escribirClase(
  xml: Xml,
  ids: Ids,
  clase: UmlClass,
  diagrama: ClassDiagram,
  refTipo: (nombre: string) => RefTipo,
  comoClaseDeAsociacion: UmlRelation | undefined,
): void {
  const tipoXmi =
    clase.kind === 'interface'
      ? 'uml:Interface'
      : clase.kind === 'enum'
        ? 'uml:Enumeration'
        : comoClaseDeAsociacion
          ? 'uml:AssociationClass'
          : 'uml:Class';

  xml.abrir('packagedElement', {
    'xmi:type': tipoXmi,
    'xmi:id': ids.para(clase.id),
    name: clase.name,
    visibility: 'public',
    // `abstract` no es un tipo distinto en UML: es una clase con la marca.
    isAbstract: clase.kind === 'abstract' ? 'true' : undefined,
  });

  for (const literal of clase.literals) {
    xml.vacio('ownedLiteral', {
      'xmi:type': 'uml:EnumerationLiteral',
      'xmi:id': ids.nuevo('lit'),
      name: literal,
    });
  }

  for (const atributo of clase.attributes) {
    escribirAtributo(xml, ids, atributo, refTipo);
  }

  for (const metodo of clase.methods) {
    escribirMetodo(xml, ids, metodo, refTipo);
  }

  // Herencia y realización viven dentro de la clase que las declara, no como
  // elementos sueltos del paquete.
  for (const relacion of listRelations(diagrama)) {
    if (relacion.source.classId !== clase.id) continue;
    const general = diagrama.classes[relacion.target.classId];
    if (!general) continue;

    if (relacion.kind === 'inheritance') {
      xml.vacio('generalization', {
        'xmi:type': 'uml:Generalization',
        'xmi:id': ids.para(relacion.id),
        general: ids.para(general.id),
      });
    } else if (relacion.kind === 'realization') {
      xml.vacio('interfaceRealization', {
        'xmi:type': 'uml:InterfaceRealization',
        'xmi:id': ids.para(relacion.id),
        client: ids.para(clase.id),
        supplier: ids.para(general.id),
        contract: ids.para(general.id),
      });
    }
  }

  // Esta misma clase es, además, la asociación N:M que la cuelga: sus dos
  // extremos van aquí dentro, no en un `uml:Association` aparte (ver el
  // comentario de `diagramaAXmi` sobre por qué).
  if (comoClaseDeAsociacion) {
    escribirExtremosDeAsociacion(xml, ids, comoClaseDeAsociacion, diagrama, ids.para(clase.id));
  }

  xml.cerrar('packagedElement');
}

function escribirAtributo(
  xml: Xml,
  ids: Ids,
  atributo: Attribute,
  refTipo: (nombre: string) => RefTipo,
): void {
  xml.abrir('ownedAttribute', {
    'xmi:type': 'uml:Property',
    'xmi:id': ids.para(atributo.id),
    name: atributo.name,
    visibility: VISIBILIDAD[atributo.visibility],
    isStatic: atributo.isStatic ? 'true' : undefined,
    isReadOnly: atributo.isFinal ? 'true' : undefined,
    isUnique: atributo.isUnique ? 'true' : undefined,
  });

  escribirTipo(xml, refTipo(atributo.type.name));

  const { lower, upper } = limites(multiplicidadDeAtributo(atributo));
  xml.vacio('lowerValue', {
    'xmi:type': 'uml:LiteralInteger',
    'xmi:id': ids.nuevo('low'),
    value: lower,
  });
  xml.vacio('upperValue', {
    'xmi:type': 'uml:LiteralUnlimitedNatural',
    'xmi:id': ids.nuevo('up'),
    value: upper,
  });

  if (atributo.defaultValue !== undefined && atributo.defaultValue !== '') {
    xml.vacio('defaultValue', {
      'xmi:type': 'uml:LiteralString',
      'xmi:id': ids.nuevo('def'),
      value: atributo.defaultValue,
    });
  }

  xml.cerrar('ownedAttribute');
}

function escribirMetodo(
  xml: Xml,
  ids: Ids,
  metodo: Method,
  refTipo: (nombre: string) => RefTipo,
): void {
  xml.abrir('ownedOperation', {
    'xmi:type': 'uml:Operation',
    'xmi:id': ids.para(metodo.id),
    name: metodo.name,
    visibility: VISIBILIDAD[metodo.visibility],
    isStatic: metodo.isStatic ? 'true' : undefined,
    isAbstract: metodo.isAbstract ? 'true' : undefined,
  });

  for (const parametro of metodo.parameters) {
    xml.abrir('ownedParameter', {
      'xmi:type': 'uml:Parameter',
      'xmi:id': ids.nuevo('par'),
      name: parametro.name,
      direction: 'in',
    });
    escribirTipo(xml, refTipo(parametro.type.name));
    xml.cerrar('ownedParameter');
  }

  if (metodo.returnType) {
    xml.abrir('ownedParameter', {
      'xmi:type': 'uml:Parameter',
      'xmi:id': ids.nuevo('ret'),
      // EA llama «return» al parámetro de retorno y sin nombre lo enseña vacío.
      name: 'return',
      direction: 'return',
    });
    escribirTipo(xml, refTipo(metodo.returnType.name));
    xml.cerrar('ownedParameter');
  }

  xml.cerrar('ownedOperation');
}

function escribirRelacion(
  xml: Xml,
  ids: Ids,
  relacion: UmlRelation,
  diagrama: ClassDiagram,
): void {
  // La herencia y la realización ya se escribieron dentro de la clase.
  if (relacion.kind === 'inheritance' || relacion.kind === 'realization') return;

  const origen = diagrama.classes[relacion.source.classId];
  const destino = diagrama.classes[relacion.target.classId];
  if (!origen || !destino) return;

  const idRelacion = ids.para(relacion.id);

  if (relacion.kind === 'dependency') {
    xml.vacio('packagedElement', {
      'xmi:type': 'uml:Dependency',
      'xmi:id': idRelacion,
      name: relacion.name,
      client: ids.para(origen.id),
      supplier: ids.para(destino.id),
    });
    return;
  }

  xml.abrir('packagedElement', {
    'xmi:type': 'uml:Association',
    'xmi:id': idRelacion,
    name: relacion.name,
  });
  escribirExtremosDeAsociacion(xml, ids, relacion, diagrama, idRelacion);
  xml.cerrar('packagedElement');
}

/**
 * Los dos extremos de una asociación: `memberEnd` + `ownedEnd`, con la marca
 * de agregación, la multiplicidad y la navegabilidad. Los usa tanto un
 * `uml:Association` suelto como un `uml:AssociationClass` (clase de
 * asociación): en UML el segundo es a la vez clasificador y asociación, así
 * que sus extremos se escriben exactamente igual, solo que colgados del
 * elemento de la clase en vez de uno aparte.
 */
function escribirExtremosDeAsociacion(
  xml: Xml,
  ids: Ids,
  relacion: UmlRelation,
  diagrama: ClassDiagram,
  idAsociacion: string,
): void {
  const origen = diagrama.classes[relacion.source.classId];
  const destino = diagrama.classes[relacion.target.classId];
  if (!origen || !destino) return;

  const idExtremoOrigen = ids.nuevo('end');
  const idExtremoDestino = ids.nuevo('end');

  /*
   * DÓNDE VA `aggregation`. En UML la propiedad que lleva la marca es la que
   * pertenece al «todo» y está tipada por la «parte»: `Pedido::lineas : Linea
   * {composite}`. En nuestro modelo el todo es siempre `source` —así lo
   * interpreta el generador al decidir el borrado en cascada
   * (`ir/normalize.ts`)—, de modo que la marca cae en el extremo tipado por
   * `target`.
   *
   * No todas las herramientas lo escriben igual, y no he podido contrastarlo
   * con un fichero real de Enterprise Architect. Por eso el importador acepta
   * la marca en cualquiera de los dos extremos y deduce de ahí quién es el
   * todo, en vez de dar por hecho este convenio.
   */
  const marca = relacion.kind === 'composition' ? 'composite' : relacion.kind === 'aggregation' ? 'shared' : undefined;

  // Cada `memberEnd` va justo antes del `ownedEnd` al que apunta, que es como
  // lo escribe Enterprise Architect. Agrupar los dos `memberEnd` primero
  // también es válido, pero no hay razón para separarse de lo que la
  // herramienta de destino sabe leer con seguridad.
  escribirExtremo(xml, ids, {
    id: idExtremoOrigen,
    idAsociacion,
    idTipo: ids.para(origen.id),
    nombre: relacion.source.role ?? toCamelCase(origen.name),
    multiplicidad: relacion.source.multiplicity,
    navegable: relacion.source.navigable,
    agregacion: undefined,
  });
  escribirExtremo(xml, ids, {
    id: idExtremoDestino,
    idAsociacion,
    idTipo: ids.para(destino.id),
    nombre:
      relacion.target.role ??
      (isToMany(relacion.target.multiplicity)
        ? pluralize(toCamelCase(destino.name))
        : toCamelCase(destino.name)),
    multiplicidad: relacion.target.multiplicity,
    navegable: relacion.target.navigable,
    agregacion: marca,
  });
}

interface Extremo {
  id: string;
  idAsociacion: string;
  idTipo: string;
  nombre: string;
  multiplicidad: string;
  navegable: boolean;
  agregacion: string | undefined;
}

function escribirExtremo(xml: Xml, ids: Ids, extremo: Extremo): void {
  xml.vacio('memberEnd', { 'xmi:idref': extremo.id });
  xml.abrir('ownedEnd', {
    'xmi:type': 'uml:Property',
    'xmi:id': extremo.id,
    name: extremo.nombre,
    visibility: 'public',
    association: extremo.idAsociacion,
    aggregation: extremo.agregacion ?? 'none',
    isNavigable: extremo.navegable ? 'true' : 'false',
  });
  // El tipo del extremo va como hijo, no como atributo `type="…"`. Las dos
  // formas son XMI válido; con el atributo, EA dejaba los extremos sin tipo y
  // la asociación quedaba suelta, sin unir ninguna de las dos cajas.
  escribirTipo(xml, { idref: extremo.idTipo });
  const { lower, upper } = limites(extremo.multiplicidad);
  xml.vacio('lowerValue', {
    'xmi:type': 'uml:LiteralInteger',
    'xmi:id': ids.nuevo('low'),
    value: lower,
  });
  xml.vacio('upperValue', {
    'xmi:type': 'uml:LiteralUnlimitedNatural',
    'xmi:id': ids.nuevo('up'),
    value: upper,
  });
  xml.cerrar('ownedEnd');
}

// ---------------------------------------------------------------------------
// Extensión propia
// ---------------------------------------------------------------------------

/**
 * Lo que UML no sabe guardar y este diagrama sí necesita.
 *
 * Sin esto, exportar e importar perdería la clave primaria de cada tabla, la
 * posición de las cajas y todas las filas de datos de ejemplo: el proyecto
 * generado a partir del fichero reimportado no tendría ni `@Id` ni `data.sql`.
 * Va en `xmi:Extension` porque es el mecanismo que el propio estándar define
 * para esto, y las herramientas ajenas descartan las extensiones que no
 * reconocen por el atributo `extender`.
 */
function escribirExtension(xml: Xml, ids: Ids, diagrama: ClassDiagram): void {
  xml.abrir('xmi:Extension', { extender: EXTENDER, extenderID: '1' });
  xml.vacio('meta', {
    basePackage: diagrama.meta.basePackage,
    artifactId: diagrama.meta.artifactId,
    description: diagrama.meta.description,
  });

  for (const clase of listClasses(diagrama)) {
    xml.abrir('clase', {
      'xmi:idref': ids.para(clase.id),
      kind: clase.kind,
      stereotype: clase.stereotype,
      transient: clase.transient ? 'true' : undefined,
      x: String(clase.position.x),
      y: String(clase.position.y),
      w: String(clase.size.w),
      h: String(clase.size.h),
    });

    for (const atributo of clase.attributes) {
      xml.vacio('atributo', {
        'xmi:idref': ids.para(atributo.id),
        name: atributo.name,
        identificador: atributo.isIdentifier ? 'true' : undefined,
        unico: atributo.isUnique ? 'true' : undefined,
        nulo: atributo.isNullable ? 'true' : 'false',
        coleccion: atributo.type.collection ? 'true' : undefined,
      });
    }

    for (const fila of clase.seedRows) {
      xml.abrir('fila', {});
      for (const [columna, valor] of Object.entries(fila)) {
        xml.vacio('celda', { columna, valor });
      }
      xml.cerrar('fila');
    }

    xml.cerrar('clase');
  }

  xml.cerrar('xmi:Extension');
}
