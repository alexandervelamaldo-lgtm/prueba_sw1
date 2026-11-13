import {
  isValidJavaIdentifier,
  toCamelCase,
  toPascalCase,
} from '../model/naming.js';
import { resolveTypeName } from '../model/type-catalog.js';
import {
  isToMany,
  MULTIPLICITY_PATTERN,
  type ClassDiagram,
  type ClassKind,
  type Multiplicity,
  type RelationKind,
  type Visibility,
} from '../model/uml.js';
import { comprobarIntegridad, type ProblemaIntegridad } from '../model/comunicacion-integridad.js';
import type { DiagramaComunicacionUml } from '../model/comunicacion-uml.js';
import type { Operation } from '../ops/operations.js';
import { esVerdadero, idDe, refDe, tipoUml, type AvisoXmi } from './comun.js';
import { leerComunicacion, type ContextoComunicacion } from './comunicacion.js';
import { leerDiagramasComunicacion } from './diagrama-comunicacion.js';
import { EXTENDER } from './export.js';
import { attr, descendientes, hijos, parseXml, type XmlNode } from './xml.js';

/**
 * Importación de un fichero XMI (RF-DIAG-12).
 *
 * NO ESCRIBE NADA. Devuelve `Operation[]`, las mismas que produce el ratón o la
 * voz, y quien las aplique es la pantalla de revisión después de que una
 * persona diga que sí (decisión D6). Un XMI ajeno puede traer doscientas clases
 * y volcarlas directamente sobre un diagrama compartido sería irreversible para
 * todos los que estén conectados; además, deshacer la importación entera pasa a
 * ser un solo Ctrl+Z porque el lote viaja junto.
 *
 * SEGURIDAD (RNF-SEG-06). Un `.xmi` es un fichero que llega de fuera y cada
 * nombre que trae acaba siendo un identificador Java, una columna SQL y parte
 * de una ruta dentro del ZIP generado. Se valida contra lista blanca *después*
 * de convertirlo a la convención del modelo, y lo que no pasa se rechaza
 * diciendo por qué. Nunca se «limpia» quitando caracteres. El análisis del XML
 * corre por `xml.ts`, que se salta el DOCTYPE y por tanto no resuelve entidades
 * externas (ver la nota de XXE allí).
 *
 * TOLERANCIA. No hay una sola forma de escribir un diagrama de clases en XMI, y
 * este código está escrito contra la especificación sin un fichero real de
 * Enterprise Architect con el que contrastarlo. Así que acepta las variantes
 * que sé que existen y lo dice cuando algo no encaja, en vez de fallar entero:
 *
 * - `xmi:type` o `xsi:type`, con prefijo o sin él, y también el estilo antiguo
 *   de XMI 1.x donde el tipo es el propio nombre del elemento (`<UML:Class>`).
 * - Tipos referenciados como hijo `<type xmi:idref="…"/>`, como atributo
 *   `type="…"` o como `href` de una biblioteca de primitivos.
 * - Multiplicidades en `lowerValue`/`upperValue` o en atributos `lower`/`upper`.
 * - Extremos de asociación como `ownedEnd` de la asociación o como
 *   `ownedAttribute` de la clase apuntados por `memberEnd`.
 * - La marca `aggregation` en cualquiera de los dos extremos.
 *
 * DIAGRAMAS DE COMUNICACIÓN. Un mismo `.xmi` puede traer, además del diagrama
 * de clases, una interacción con objetos y mensajes. Esa parte la lee
 * `comunicacion.ts` y se añade a lo de aquí; los dos lectores comparten el
 * fichero pero no la lógica, porque las reglas son distintas: este crea clases
 * y omite las que ya existen, el otro las amplía.
 */

const MAX_CLASES = 300;
const MAX_ATRIBUTOS_POR_CLASE = 100;

export type { AvisoXmi } from './comun.js';

export interface ResumenXmi {
  readonly clases: number;
  readonly atributos: number;
  readonly metodos: number;
  readonly relaciones: number;
  readonly filas: number;
  /** Métodos deducidos de los mensajes de un diagrama de comunicación. */
  readonly mensajes: number;
  /** Dependencias deducidas de los enlaces y de quién llama a quién. */
  readonly enlaces: number;
}

export interface ResultadoImportacionXmi {
  readonly operaciones: Operation[];
  readonly avisos: AvisoXmi[];
  readonly aplicable: boolean;
  readonly resumen: ResumenXmi;
  /** Nombres de las clases que se crearían, en orden. */
  readonly clases: string[];
  /** Clases que ya estaban en el diagrama y a las que se les añade algo. */
  readonly ampliadas: string[];
  /** El fichero traía una interacción: objetos y mensajes. */
  readonly comunicacion: boolean;
  /**
   * Los diagramas de comunicación del fichero, enteros y sin traducir.
   *
   * Son lo mismo que `operaciones` mira por otro lado y no un sustituto: las
   * operaciones añaden los métodos y las dependencias al diagrama de clases,
   * que es la mitad útil de importar un diagrama de comunicación, y esto
   * conserva el diagrama en sí, con su numeración, para guardarlo en el
   * proyecto y dibujarlo. Se aplican los dos.
   */
  readonly diagramas: readonly DiagramaComunicacionUml[];
  /**
   * Lo que le falta o le sobra a esos diagramas.
   *
   * Va aparte de `avisos` porque cada uno responde a una pregunta distinta:
   * `avisos` habla de la traducción a diagrama de clases —«este mensaje no da
   * un nombre de método válido»— y esto habla del diagrama importado —«este
   * mensaje apunta a un objeto que no existe». Mezclarlos dejaría una lista en
   * la que no se distingue lo que se va a escribir de lo que se va a dibujar.
   *
   * Un `error` aquí **no** bloquea la importación: el diagrama de clases se
   * puede aplicar igual, y bloquearlo por un mensaje colgante sería tirar lo
   * que sí se pudo leer. Lo que hace es marcar ese diagrama concreto como
   * incompleto.
   */
  readonly problemas: readonly ProblemaIntegridad[];
}

// ---------------------------------------------------------------------------
// Utilidades de lectura
// ---------------------------------------------------------------------------

/**
 * Multiplicidad de un elemento con extremos, en las dos notaciones.
 *
 * Cuando falta una de las dos cotas se aplica el valor por defecto del
 * estándar, que es **uno**: en UML 2.5 un `MultiplicityElement` sin
 * `lowerValue` vale `1`, no `0`. Así, un extremo que solo declara
 * `upperValue="*"` se lee como `1..*` y no como `0..*`, y eso decide si la
 * columna generada admite nulos. Es discutible —hay herramientas que omiten la
 * cota inferior queriendo decir cero— pero seguir la especificación es lo único
 * defendible cuando no se puede preguntar.
 *
 * El resultado se canoniza a la forma corta. No es cosmética: `0..*` y `*`
 * significan lo mismo, pero el desplegable del panel de propiedades ofrece
 * `1`, `0..1`, `*` y `1..*`, así que devolver `0..*` dejaría el selector de la
 * relación importada sin ninguna opción marcada.
 */
function multiplicidadDe(nodo: XmlNode): string {
  const leer = (etiqueta: string, atributo: string): string | undefined => {
    const hijo = hijos(nodo, etiqueta)[0];
    if (hijo) {
      const valor = attr(hijo, 'value');
      if (valor !== undefined && valor !== '') return valor;
    }
    return attr(nodo, atributo);
  };

  const normalizar = (valor: string): string => {
    const limpio = valor.trim();
    // `-1` es como XMI escribe «sin cota superior»; `unlimited` aparece en
    // ficheros generados por herramientas basadas en Eclipse.
    return limpio === '-1' || limpio === 'unlimited' || limpio === '*' ? '*' : limpio;
  };

  const bajo = normalizar(leer('lowerValue', 'lower') ?? '1');
  const alto = normalizar(leer('upperValue', 'upper') ?? '1');

  const candidata = canonizar(bajo, alto);
  return MULTIPLICITY_PATTERN.test(candidata) ? candidata : '1';
}

function canonizar(bajo: string, alto: string): string {
  if (bajo === '0' && alto === '*') return '*';
  if (bajo === alto) return bajo;
  return `${bajo}..${alto}`;
}

const VISIBILIDAD: Record<string, Visibility> = {
  public: '+',
  private: '-',
  protected: '#',
  package: '~',
};

function visibilidadDe(nodo: XmlNode, porDefecto: Visibility): Visibility {
  const bruta = attr(nodo, 'visibility');
  if (bruta === undefined) return porDefecto;
  return VISIBILIDAD[bruta.trim().toLowerCase()] ?? porDefecto;
}

// ---------------------------------------------------------------------------

interface ClaseLeida {
  readonly idXmi: string;
  readonly nombre: string;
  readonly kind: ClassKind;
  readonly nodo: XmlNode;
  /**
   * Es un `uml:AssociationClass`: a la vez clasificador y asociación N:M.
   *
   * No se crea con `addClass` como las demás (más abajo, en el bucle que
   * emite esa operación, se la salta a propósito): la crea el propio
   * `addRelation` de `leerRelaciones`, con `associationClassName`, porque es
   * la única operación del modelo que sabe enlazarla a su relación en el
   * mismo paso. Crearla antes con `addClass` chocaría con esa operación, que
   * rechaza una clase que ya exista con ese nombre.
   */
  readonly esClaseDeAsociacion: boolean;
}

/**
 * Elementos que se traen como clase del diagrama.
 *
 * `Component` está aquí por un caso real y no por completitud. Enterprise
 * Architect dibuja los participantes de un diagrama de comunicación como
 * componentes, no como clases: el fichero declara `uml:Component` con sus
 * `ownedOperation` dentro, y los objetos del diagrama son
 * `uml:InstanceSpecification` que apuntan a ellos. Sin esta línea, un XMI de
 * comunicación exportado por EA no trae ni una sola clase y la importación se
 * rendía diciendo que el fichero estaba vacío, cuando lo que estaba vacío era
 * la lista de tipos que este lector miraba.
 */
const TIPOS_CLASIFICADOR = new Set([
  'Class',
  'Interface',
  'Enumeration',
  'Component',
  'AssociationClass',
]);
const TIPOS_DATO = new Set([
  'PrimitiveType',
  'DataType',
  'Enumeration',
  'Class',
  'Interface',
  'Component',
]);

/**
 * Marcas con las que una herramienta dice «esta operación no devuelve nada».
 *
 * Enterprise Architect escribe `type="EAnone_void"` en el parámetro de retorno.
 * Sin reconocerlo, ese texto se busca como si fuera un tipo, no se encuentra, y
 * el método importado acaba devolviendo `String` con un aviso al lado —dos
 * errores a partir de un fichero que decía exactamente lo que quería decir.
 */
function esSinRetorno(nodo: XmlNode): boolean {
  const referencia = refDe(nodo, 'type');
  // Un `return` que no declara tipo es void; suponerle `String` es inventar.
  if (referencia === undefined) return hijos(nodo, 'type').length === 0;
  const nombre = referencia.trim().toLowerCase();
  return nombre === 'void' || nombre.startsWith('eanone_');
}

/**
 * @param fuente Nombre del fichero, solo para poder decir de dónde salió cada
 *   diagrama de comunicación en la interfaz. No se interpreta ni se usa para
 *   nada más; en particular, el dialecto no se deduce de la extensión.
 */
export function leerXmi(
  texto: string,
  diagrama: ClassDiagram,
  fuente = '',
): ResultadoImportacionXmi {
  const vacio: ResumenXmi = {
    clases: 0,
    atributos: 0,
    metodos: 0,
    relaciones: 0,
    filas: 0,
    mensajes: 0,
    enlaces: 0,
  };
  const fallo = (mensaje: string): ResultadoImportacionXmi => ({
    operaciones: [],
    avisos: [{ severidad: 'error', mensaje }],
    aplicable: false,
    resumen: vacio,
    clases: [],
    ampliadas: [],
    comunicacion: false,
    diagramas: [],
    problemas: [],
  });

  const analisis = parseXml(texto);
  if (!analisis.ok) return fallo(`El fichero no es XML válido: ${analisis.error}`);

  const raiz = analisis.root;
  const avisos: AvisoXmi[] = [];

  // ---- clasificadores -----------------------------------------------------

  const candidatos = descendientes(
    raiz,
    'packagedElement',
    'Class',
    'Interface',
    'Enumeration',
    'Component',
    'ownedMember',
    'ownedElement',
  );

  const clases: ClaseLeida[] = [];
  const nombrePorId = new Map<string, string>();
  const vistos = new Set<string>();
  /**
   * Clasificadores del fichero que ya estaban en el diagrama, por `xmi:id`.
   *
   * Aquí se omiten —esta importación viene a crear, no a mezclar—, pero un
   * diagrama de comunicación en el mismo fichero sí los necesita: sus objetos
   * son justo esas clases, y sin este mapa sus mensajes crearían un duplicado
   * con el mismo nombre en vez de añadir el método donde toca.
   */
  const yaEnDiagrama = new Map<string, string>();

  for (const nodo of candidatos) {
    const tipo = tipoUml(nodo);
    if (TIPOS_DATO.has(tipo)) {
      const id = idDe(nodo);
      const nombre = attr(nodo, 'name');
      if (id !== undefined && nombre !== undefined && nombre !== '') {
        nombrePorId.set(id, nombre);
      }
    }
    if (!TIPOS_CLASIFICADOR.has(tipo)) continue;

    const idXmi = idDe(nodo);
    const bruto = attr(nodo, 'name');
    if (idXmi === undefined) {
      avisos.push({ severidad: 'aviso', mensaje: 'Se ignora un clasificador sin xmi:id.' });
      continue;
    }
    if (bruto === undefined || bruto.trim() === '') {
      avisos.push({ severidad: 'aviso', mensaje: `Se ignora un clasificador sin nombre (${idXmi}).` });
      continue;
    }

    const nombre = toPascalCase(bruto);
    if (!nombre || !isValidJavaIdentifier(nombre)) {
      avisos.push({
        severidad: 'aviso',
        mensaje: `«${bruto}» no sirve como nombre de clase y se descarta junto con su contenido.`,
      });
      continue;
    }
    if (vistos.has(nombre.toLowerCase())) {
      avisos.push({
        severidad: 'aviso',
        mensaje: `El fichero trae dos clases que se llamarían «${nombre}»: se queda la primera.`,
      });
      continue;
    }
    const choca = Object.values(diagrama.classes).find(
      (c) => c.name.toLowerCase() === nombre.toLowerCase(),
    );
    if (choca) {
      avisos.push({
        severidad: 'aviso',
        mensaje: `«${nombre}» ya existe en el diagrama: se omite, junto con sus relaciones.`,
      });
      yaEnDiagrama.set(idXmi, choca.name);
      continue;
    }

    vistos.add(nombre.toLowerCase());
    const kind: ClassKind =
      tipo === 'Interface'
        ? 'interface'
        : tipo === 'Enumeration'
          ? 'enum'
          : esVerdadero(attr(nodo, 'isAbstract'))
            ? 'abstract'
            : 'class';

    clases.push({ idXmi, nombre, kind, nodo, esClaseDeAsociacion: tipo === 'AssociationClass' });
    if (clases.length > MAX_CLASES) {
      return fallo(`El fichero trae más de ${MAX_CLASES} clases; no se importa.`);
    }
  }

  // Sin clases todavía no se puede rendir: el fichero puede ser un diagrama de
  // comunicación, donde las clases están implícitas en los objetos. La decisión
  // se pospone hasta haber leído también esa parte.

  const claseDeId = new Map<string, ClaseLeida>();
  for (const clase of clases) claseDeId.set(clase.idXmi, clase);

  // ---- extensión propia ---------------------------------------------------

  const extension = leerExtension(raiz);

  // ---- operaciones --------------------------------------------------------

  const operaciones: Operation[] = [];
  let totalAtributos = 0;
  let totalMetodos = 0;
  let totalFilas = 0;

  for (const clase of clases) {
    // La crea `leerRelaciones` con `addRelation` + `associationClassName`:
    // ver el comentario en `ClaseLeida.esClaseDeAsociacion`.
    if (clase.esClaseDeAsociacion) continue;
    const extra = extension.clases.get(clase.idXmi);
    operaciones.push({
      op: 'addClass',
      name: clase.nombre,
      kind: clase.kind,
      ...(extra?.posicion ? { position: extra.posicion } : {}),
    });
  }

  /** Nombre de tipo utilizable a partir de la referencia del fichero. */
  const resolverTipo = (nodo: XmlNode, contexto: string): string => {
    const referencia =
      refDe(nodo, 'type') ??
      (() => {
        const hijoTipo = hijos(nodo, 'type')[0];
        if (!hijoTipo) return undefined;
        const href = attr(hijoTipo, 'href');
        // `pathmap://…/UMLPrimitiveTypes.library.uml#String` → `String`
        if (href !== undefined && href.includes('#')) return href.slice(href.lastIndexOf('#') + 1);
        return undefined;
      })();

    if (referencia === undefined) return 'String';

    const nombre = nombrePorId.get(referencia) ?? referencia;
    const canonico = resolveTypeName(nombre);
    if (canonico !== undefined) return canonico;

    // Un atributo tipado por otra clase del fichero conserva ese nombre; el
    // generador ya sabe qué hacer con un tipo que es una clase.
    const clase = clases.find((c) => c.nombre.toLowerCase() === toPascalCase(nombre).toLowerCase());
    if (clase) return clase.nombre;

    avisos.push({
      severidad: 'aviso',
      mensaje: `Tipo «${nombre}» desconocido en ${contexto}: se usa String.`,
    });
    return 'String';
  };

  // ---- relaciones ---------------------------------------------------------

  // Antes de los atributos: una clase de asociación no existe en el diagrama
  // hasta que `addRelation` la crea (ver `ClaseLeida.esClaseDeAsociacion`), así
  // que sus propios atributos no se podrían colgar de ella si este bloque
  // corriera primero.
  const relaciones = leerRelaciones(raiz, claseDeId, avisos);
  for (const relacion of relaciones) operaciones.push(relacion);

  // Una clase de asociación no acepta `position` en el `addRelation` que la
  // crea (ese campo es de `addClass`, que aquí no se usa para ella), así que
  // la posición guardada en nuestra extensión se restaura aparte con
  // `moveClass`, después de que la relación ya la haya creado.
  for (const relacion of relaciones) {
    if (relacion.op !== 'addRelation' || !relacion.associationClassName) continue;
    const clase = clases.find((c) => c.nombre === relacion.associationClassName);
    const posicion = clase ? extension.clases.get(clase.idXmi)?.posicion : undefined;
    if (!posicion) continue;
    operaciones.push({
      op: 'moveClass',
      ref: { name: relacion.associationClassName },
      position: posicion,
    });
  }

  for (const clase of clases) {
    const extra = extension.clases.get(clase.idXmi);
    const nombresAtributo = new Set<string>();

    for (const nodo of hijos(clase.nodo, 'ownedAttribute', 'Attribute')) {
      // Un `ownedAttribute` con `association` no es una columna: es un extremo
      // de asociación que la clase posee. Tratarlo como atributo crearía una
      // columna fantasma con el nombre del rol.
      if (refDe(nodo, 'association') !== undefined) continue;

      const bruto = attr(nodo, 'name');
      if (bruto === undefined || bruto.trim() === '') continue;

      const nombre = toCamelCase(bruto);
      if (!nombre || !isValidJavaIdentifier(nombre)) {
        avisos.push({
          severidad: 'aviso',
          mensaje: `El atributo «${bruto}» de «${clase.nombre}» no da un nombre válido y se descarta.`,
        });
        continue;
      }
      if (nombresAtributo.has(nombre.toLowerCase())) {
        avisos.push({
          severidad: 'aviso',
          mensaje: `«${clase.nombre}» repite el atributo «${nombre}»: se queda el primero.`,
        });
        continue;
      }
      if (nombresAtributo.size >= MAX_ATRIBUTOS_POR_CLASE) {
        avisos.push({
          severidad: 'aviso',
          mensaje: `«${clase.nombre}» pasa de ${MAX_ATRIBUTOS_POR_CLASE} atributos: se recorta.`,
        });
        break;
      }
      nombresAtributo.add(nombre.toLowerCase());

      const idAtributo = idDe(nodo);
      const marca = idAtributo !== undefined ? extra?.atributos.get(idAtributo) : undefined;
      const multiplicidad = multiplicidadDe(nodo);

      operaciones.push({
        op: 'addAttribute',
        classRef: { name: clase.nombre },
        name: nombre,
        type: resolverTipo(nodo, `${clase.nombre}.${nombre}`),
        visibility: visibilidadDe(nodo, '-'),
        isIdentifier: marca?.identificador ?? false,
        // Sin nuestra extensión, la nulabilidad se deduce de la multiplicidad:
        // cota inferior cero significa opcional.
        isNullable: marca?.nulo ?? multiplicidad.startsWith('0'),
        isUnique: marca?.unico ?? esVerdadero(attr(nodo, 'isUnique')),
      });
      totalAtributos++;
    }

    for (const nodo of hijos(clase.nodo, 'ownedLiteral', 'EnumerationLiteral')) {
      const bruto = attr(nodo, 'name');
      if (bruto === undefined || bruto.trim() === '') continue;
      operaciones.push({
        op: 'addEnumLiteral',
        classRef: { name: clase.nombre },
        literal: bruto.trim(),
      });
    }

    for (const nodo of hijos(clase.nodo, 'ownedOperation', 'Operation')) {
      const bruto = attr(nodo, 'name');
      if (bruto === undefined || bruto.trim() === '') continue;
      const nombre = toCamelCase(bruto);
      if (!nombre || !isValidJavaIdentifier(nombre)) {
        avisos.push({
          severidad: 'aviso',
          mensaje: `El método «${bruto}» de «${clase.nombre}» no da un nombre válido y se descarta.`,
        });
        continue;
      }

      const parametros: { name: string; type: string }[] = [];
      let devuelve: string | null = null;
      for (const parametro of hijos(nodo, 'ownedParameter', 'Parameter')) {
        const direccion = (attr(parametro, 'direction') ?? 'in').toLowerCase();
        if (direccion === 'return') {
          if (!esSinRetorno(parametro)) {
            devuelve = resolverTipo(parametro, `${clase.nombre}.${nombre}()`);
          }
          continue;
        }
        const brutoParametro = attr(parametro, 'name');
        if (brutoParametro === undefined || brutoParametro.trim() === '') continue;
        const nombreParametro = toCamelCase(brutoParametro);
        if (!nombreParametro || !isValidJavaIdentifier(nombreParametro)) continue;
        parametros.push({
          name: nombreParametro,
          type: resolverTipo(parametro, `${clase.nombre}.${nombre}()`),
        });
      }

      operaciones.push({
        op: 'addMethod',
        classRef: { name: clase.nombre },
        name: nombre,
        returnType: devuelve,
        parameters: parametros,
        visibility: visibilidadDe(nodo, '+'),
      });
      totalMetodos++;
    }
  }

  // ---- filas de datos -----------------------------------------------------

  for (const clase of clases) {
    const extra = extension.clases.get(clase.idXmi);
    if (!extra || extra.filas.length === 0) continue;
    operaciones.push({ op: 'setSeedRows', classRef: { name: clase.nombre }, rows: extra.filas });
    totalFilas += extra.filas.length;
  }

  // ---- diagrama de comunicación -------------------------------------------

  const comunicacion = leerComunicacion(raiz, contextoDeComunicacion(diagrama, clases, yaEnDiagrama, operaciones));
  operaciones.push(...comunicacion.operaciones);
  avisos.push(...comunicacion.avisos);

  /*
    El mismo fichero se lee dos veces y con dos propósitos distintos, que no se
    pueden fundir en uno.

    Lo de arriba **traduce**: convierte los mensajes en métodos del diagrama de
    clases y los enlaces en dependencias. Es lo que hace que importar un
    diagrama de comunicación sirva de algo aunque no se vaya a dibujar.

    Lo de aquí **conserva**: devuelve el diagrama con sus objetos, sus flechas y
    su numeración, para guardarlo en el proyecto como un documento más. No
    produce ni una operación sobre el diagrama de clases.

    Recorrer el árbol dos veces cuesta lo que cuesta —el documento ya está en
    memoria y limitado a 200 000 nodos— y sale mucho más barato que un lector
    único que hiciera las dos cosas: tendría que decidir, en cada mensaje que
    no da un nombre de método válido, si eso invalida también la flecha. Y no
    la invalida: un mensaje llamado «borrar(); DROP TABLE x» no se puede
    convertir en método y sí se puede dibujar, con su etiqueta entera a la
    vista, que además es como se ve lo que traía el fichero.
  */
  const lectura = leerDiagramasComunicacion(raiz, fuente);
  const problemas: ProblemaIntegridad[] = [];
  for (const importado of lectura.diagramas) {
    problemas.push(...comprobarIntegridad(importado).problemas);
  }
  avisos.push(...lectura.avisos);

  // Ahora sí se puede decidir si el fichero traía algo. Un XMI de un diagrama de
  // comunicación no tiene por qué declarar ni una sola clase: las clases están
  // implícitas en los objetos, y rendirse antes de mirarlos era justo lo que
  // hacía que estos ficheros no se pudieran importar.
  // Un fichero que no toca el diagrama de clases pero sí trae un diagrama de
  // comunicación **sí** se importa. Es justo el caso del fixture real de
  // Enterprise Architect —tres objetos y tres enlaces, ni un mensaje— y el de
  // cualquier diagrama dibujado sobre objetos que ya están en el proyecto: no
  // hay nada que añadir a las clases y hay un diagrama entero que guardar.
  if (operaciones.length === 0 && lectura.diagramas.length === 0) {
    return fallo(
      'No se ha encontrado ninguna clase en el fichero, ni objetos con mensajes de los que ' +
        'deducirlas. ¿Seguro que es un XMI de un diagrama de clases o de comunicación?',
    );
  }

  const aplicable = !avisos.some((a) => a.severidad === 'error');
  return {
    operaciones: aplicable ? operaciones : [],
    avisos,
    aplicable,
    resumen: {
      clases: clases.length + comunicacion.clasesNuevas.length,
      atributos: totalAtributos,
      metodos: totalMetodos,
      relaciones: relaciones.length,
      filas: totalFilas,
      mensajes: comunicacion.mensajes,
      enlaces: comunicacion.enlaces,
    },
    clases: [...clases.map((c) => c.nombre), ...comunicacion.clasesNuevas],
    ampliadas: comunicacion.ampliadas,
    comunicacion: comunicacion.hayInteraccion,
    diagramas: lectura.diagramas,
    problemas,
  };
}

/**
 * Lo que el lector de comunicación necesita saber de lo ya decidido.
 *
 * Se construye a partir de las operaciones ya emitidas y no de una lista
 * paralela: así no puede desincronizarse. Y hace falta entero porque
 * `applyOperations` es todo o nada — un `addMethod` sobre un método que ya
 * existe devuelve error y tumba la importación completa, de modo que
 * deduplicar no es una cortesía, es lo que hace que el lote se pueda aplicar.
 */
function contextoDeComunicacion(
  diagrama: ClassDiagram,
  nuevas: ClaseLeida[],
  yaEnDiagrama: ReadonlyMap<string, string>,
  operaciones: readonly Operation[],
): ContextoComunicacion {
  const clasificadores = new Map(yaEnDiagrama);
  for (const clase of nuevas) clasificadores.set(clase.idXmi, clase.nombre);

  const clases = new Map<string, string>();
  const enElDiagrama = new Set<string>();
  const metodos = new Map<string, Set<string>>();
  const nombreDeId = new Map<string, string>();

  for (const clase of Object.values(diagrama.classes)) {
    const clave = clase.name.toLowerCase();
    clases.set(clave, clase.name);
    enElDiagrama.add(clave);
    metodos.set(clave, new Set(clase.methods.map((m) => m.name.toLowerCase())));
    nombreDeId.set(clase.id, clase.name);
  }
  for (const clase of nuevas) clases.set(clase.nombre.toLowerCase(), clase.nombre);

  const par = (a: string, b: string): string => [a.toLowerCase(), b.toLowerCase()].sort().join('|');
  const relacionadas = new Set<string>();
  for (const relacion of Object.values(diagrama.relations)) {
    const origen = nombreDeId.get(relacion.source.classId);
    const destino = nombreDeId.get(relacion.target.classId);
    if (origen !== undefined && destino !== undefined) relacionadas.add(par(origen, destino));
  }

  for (const op of operaciones) {
    if (op.op === 'addMethod' && 'name' in op.classRef) {
      const clave = op.classRef.name.toLowerCase();
      const conjunto = metodos.get(clave) ?? new Set<string>();
      conjunto.add(op.name.toLowerCase());
      metodos.set(clave, conjunto);
    } else if (op.op === 'addRelation' && 'name' in op.source && 'name' in op.target) {
      relacionadas.add(par(op.source.name, op.target.name));
    }
  }

  return { clasificadores, clases, enElDiagrama, metodos, relacionadas };
}

// ---------------------------------------------------------------------------
// Relaciones
// ---------------------------------------------------------------------------

interface ExtremoLeido {
  readonly idClase: string;
  readonly multiplicidad: Multiplicity;
  readonly rol: string | undefined;
  readonly agregacion: string;
}

function leerRelaciones(
  raiz: XmlNode,
  claseDeId: Map<string, ClaseLeida>,
  avisos: AvisoXmi[],
): Operation[] {
  const operaciones: Operation[] = [];

  // Índice de todos los elementos por id, para resolver los `memberEnd` que
  // apuntan a propiedades declaradas dentro de las clases.
  const porId = new Map<string, XmlNode>();
  for (const nodo of descendientes(raiz, ...NOMBRES_INDEXABLES)) {
    const id = idDe(nodo);
    if (id !== undefined && !porId.has(id)) porId.set(id, nodo);
  }

  // ---- herencia y realización, que viven dentro de la clase ---------------

  for (const clase of claseDeId.values()) {
    for (const nodo of hijos(clase.nodo, 'generalization', 'Generalization')) {
      const general = refDe(nodo, 'general');
      const destino = general !== undefined ? claseDeId.get(general) : undefined;
      if (!destino) continue;
      if (destino.idXmi === clase.idXmi) continue;
      operaciones.push({
        op: 'addRelation',
        kind: 'inheritance',
        source: { name: clase.nombre },
        target: { name: destino.nombre },
        sourceMultiplicity: '1',
        targetMultiplicity: '1',
      });
    }

    for (const nodo of hijos(clase.nodo, 'interfaceRealization', 'InterfaceRealization')) {
      const contrato = refDe(nodo, 'contract', 'supplier');
      const destino = contrato !== undefined ? claseDeId.get(contrato) : undefined;
      if (!destino || destino.idXmi === clase.idXmi) continue;
      operaciones.push({
        op: 'addRelation',
        kind: 'realization',
        source: { name: clase.nombre },
        target: { name: destino.nombre },
        sourceMultiplicity: '1',
        targetMultiplicity: '1',
      });
    }
  }

  // ---- clases de asociación ------------------------------------------------

  /*
   * Una clase de asociación en UML es, a la vez, un clasificador y la propia
   * asociación entre otras dos clases: sus dos extremos no viven en un
   * `uml:Association` aparte, sino colgados del mismo elemento
   * `uml:AssociationClass` (igual que al exportar: ver el comentario de
   * `diagramaAXmi` en `export.ts`). Por eso esto no sale del bucle de
   * «asociaciones y dependencias» de más abajo, que busca `uml:Association`:
   * un `uml:AssociationClass` ya quedó fuera de ese tipo.
   *
   * El modelo interno solo admite una clase de asociación sobre una relación
   * N:M (`validateAssociationClasses`). Si el fichero la trae sobre una
   * relación que no lo es, o sus extremos no se pueden leer, no se inventa un
   * N:M que no estaba: se importa la clase suelta —y la relación, si se pudo
   * leer— con un aviso que explica que se perdió el enlace entre las dos.
   */
  for (const clase of claseDeId.values()) {
    if (!clase.esClaseDeAsociacion) continue;

    const sueltaConAviso = (motivo: string): void => {
      avisos.push({
        severidad: 'aviso',
        mensaje: `La clase de asociación «${clase.nombre}» ${motivo}: se importa como clase suelta.`,
      });
      operaciones.push({ op: 'addClass', name: clase.nombre, kind: clase.kind });
    };

    const extremos = extremosDe(clase.nodo, porId, claseDeId);
    if (extremos.length !== 2) {
      sueltaConAviso('no tiene dos extremos de asociación legibles');
      continue;
    }

    const [primero, segundo] = extremos as [ExtremoLeido, ExtremoLeido];
    const origen = claseDeId.get(primero.idClase);
    const destino = claseDeId.get(segundo.idClase);
    if (!origen || !destino) {
      sueltaConAviso('apunta a una clase que no se importó');
      continue;
    }
    if (origen.idXmi === clase.idXmi || destino.idXmi === clase.idXmi) {
      sueltaConAviso('no puede ser uno de los extremos de su propia relación');
      continue;
    }

    if (!isToMany(primero.multiplicidad) || !isToMany(segundo.multiplicidad)) {
      avisos.push({
        severidad: 'aviso',
        mensaje:
          `La clase de asociación «${clase.nombre}» cuelga de una relación que no ` +
          'es muchos a muchos, y aquí solo se admite sobre N:M: se importa la clase ' +
          'suelta y la relación por separado, sin el enlace entre las dos.',
      });
      operaciones.push({ op: 'addClass', name: clase.nombre, kind: clase.kind });
      operaciones.push({
        op: 'addRelation',
        kind: 'association',
        source: { name: origen.nombre },
        target: { name: destino.nombre },
        sourceMultiplicity: primero.multiplicidad,
        targetMultiplicity: segundo.multiplicidad,
      });
      continue;
    }

    operaciones.push({
      op: 'addRelation',
      kind: 'association',
      source: { name: origen.nombre },
      target: { name: destino.nombre },
      sourceMultiplicity: primero.multiplicidad,
      targetMultiplicity: segundo.multiplicidad,
      associationClassName: clase.nombre,
    });
  }

  // ---- asociaciones y dependencias ---------------------------------------

  for (const nodo of descendientes(raiz, 'packagedElement', 'Association', 'Dependency', 'Usage')) {
    const tipo = tipoUml(nodo);

    if (tipo === 'Dependency' || tipo === 'Usage' || tipo === 'Abstraction') {
      const cliente = refDe(nodo, 'client');
      const proveedor = refDe(nodo, 'supplier');
      const origen = cliente !== undefined ? claseDeId.get(cliente) : undefined;
      const destino = proveedor !== undefined ? claseDeId.get(proveedor) : undefined;
      if (!origen || !destino || origen.idXmi === destino.idXmi) continue;
      operaciones.push({
        op: 'addRelation',
        kind: 'dependency',
        source: { name: origen.nombre },
        target: { name: destino.nombre },
        sourceMultiplicity: '1',
        targetMultiplicity: '1',
      });
      continue;
    }

    if (tipo !== 'Association') continue;

    /*
     * Una asociación de UML declara sus extremos: o `ownedEnd`, o `memberEnd`
     * apuntando a propiedades. Si no trae ninguno de los dos, esto no es una
     * asociación mal importada — no es una asociación.
     *
     * Sin esta línea, el bloque de extensión de Enterprise Architect envenena la
     * importación. EA lista dentro de cada elemento las líneas que le tocan, con
     * la forma `<Association xmi:id="…" start="…" end="…"/>`, y este bucle busca
     * también por nombre de etiqueta, así que las recogía todas. El resultado
     * era que importar un fichero perfectamente sano de EA soltaba cinco avisos
     * de «se descarta» refiriéndose a relaciones que sí se habían importado, por
     * su otro nombre y desde su otro sitio. Un aviso que no corresponde a nada
     * que el usuario pueda arreglar es peor que no avisar: enseña a no leerlos.
     */
    if (hijos(nodo, 'ownedEnd', 'AssociationEnd', 'memberEnd').length === 0) continue;

    const extremos = extremosDe(nodo, porId, claseDeId);
    if (extremos.length !== 2) {
      const nombre = attr(nodo, 'name') ?? idDe(nodo) ?? '(sin nombre)';
      avisos.push({
        severidad: 'aviso',
        mensaje:
          `La asociación «${nombre}» no tiene dos extremos que apunten a clases ` +
          'importadas: se descarta.',
      });
      continue;
    }

    // Una autoasociación —«Empleado tiene jefe Empleado»— es legítima y pasa
    // tal cual; el generador ya la admite.
    const [primero, segundo] = extremos as [ExtremoLeido, ExtremoLeido];

    /*
     * Quién es el «todo». La marca `aggregation` la lleva la propiedad tipada
     * por la parte, así que el todo es el extremo *contrario* al marcado. Si la
     * marca viniera en el primero —convenio que algunas herramientas usan— hay
     * que invertir los extremos para que el generador propague el borrado en la
     * dirección correcta.
     */
    const marcado = (e: ExtremoLeido): boolean =>
      e.agregacion === 'composite' || e.agregacion === 'shared';

    let origen = primero;
    let destino = segundo;
    let kind: RelationKind = 'association';

    if (marcado(segundo)) {
      kind = segundo.agregacion === 'composite' ? 'composition' : 'aggregation';
    } else if (marcado(primero)) {
      kind = primero.agregacion === 'composite' ? 'composition' : 'aggregation';
      origen = segundo;
      destino = primero;
    }

    const origenClase = claseDeId.get(origen.idClase);
    const destinoClase = claseDeId.get(destino.idClase);
    if (!origenClase || !destinoClase) continue;

    const nombre = attr(nodo, 'name');
    operaciones.push({
      op: 'addRelation',
      kind,
      source: { name: origenClase.nombre },
      target: { name: destinoClase.nombre },
      sourceMultiplicity: origen.multiplicidad,
      targetMultiplicity: destino.multiplicidad,
      ...(nombre !== undefined && nombre.trim() !== '' ? { name: nombre.trim() } : {}),
    });
  }

  return operaciones;
}

const NOMBRES_INDEXABLES = [
  'packagedElement',
  'ownedAttribute',
  'ownedEnd',
  'Attribute',
  'AssociationEnd',
  'Class',
  'Interface',
  'Enumeration',
];

function extremosDe(
  asociacion: XmlNode,
  porId: Map<string, XmlNode>,
  claseDeId: Map<string, ClaseLeida>,
): ExtremoLeido[] {
  const nodos: XmlNode[] = [];

  // `ownedEnd` es lo que escribimos nosotros y lo más habitual cuando la
  // asociación no es navegable desde las clases.
  for (const hijo of hijos(asociacion, 'ownedEnd', 'AssociationEnd')) nodos.push(hijo);

  // `memberEnd` apunta a propiedades que pueden vivir dentro de las clases.
  if (nodos.length < 2) {
    for (const miembro of hijos(asociacion, 'memberEnd')) {
      const ref = attr(miembro, 'xmi:idref', 'idref');
      const apuntado = ref !== undefined ? porId.get(ref) : undefined;
      if (apuntado && !nodos.includes(apuntado)) nodos.push(apuntado);
    }
  }

  const extremos: ExtremoLeido[] = [];
  for (const nodo of nodos) {
    const referencia = refDe(nodo, 'type');
    if (referencia === undefined || !claseDeId.has(referencia)) continue;
    const multiplicidad = multiplicidadDe(nodo);
    const rol = attr(nodo, 'name');
    extremos.push({
      idClase: referencia,
      multiplicidad,
      rol: rol !== undefined && rol.trim() !== '' ? rol.trim() : undefined,
      agregacion: (attr(nodo, 'aggregation') ?? 'none').toLowerCase(),
    });
    if (extremos.length === 2) break;
  }
  return extremos;
}

// ---------------------------------------------------------------------------
// Extensión propia
// ---------------------------------------------------------------------------

interface ExtraAtributo {
  readonly identificador: boolean;
  readonly unico: boolean;
  readonly nulo: boolean;
}

interface ExtraClase {
  readonly posicion: { x: number; y: number } | undefined;
  readonly atributos: Map<string, ExtraAtributo>;
  readonly filas: Record<string, string>[];
}

interface Extension {
  readonly clases: Map<string, ExtraClase>;
}

/**
 * Recupera lo que el estándar no guarda, si el fichero lo trae.
 *
 * Solo se leen las extensiones cuyo `extender` es el nuestro. Las de otras
 * herramientas se ignoran a propósito: llevan su propio esquema, y adivinar qué
 * significa un campo ajeno que se llama parecido es justo la clase de error que
 * después nadie sabe de dónde salió.
 */
function leerExtension(raiz: XmlNode): Extension {
  const clases = new Map<string, ExtraClase>();

  for (const bloque of descendientes(raiz, 'Extension')) {
    if (attr(bloque, 'extender') !== EXTENDER) continue;

    for (const nodo of hijos(bloque, 'clase')) {
      const ref = attr(nodo, 'xmi:idref', 'idref');
      if (ref === undefined) continue;

      const x = Number.parseFloat(attr(nodo, 'x') ?? '');
      const y = Number.parseFloat(attr(nodo, 'y') ?? '');
      const posicion =
        Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;

      const atributos = new Map<string, ExtraAtributo>();
      for (const atributo of hijos(nodo, 'atributo')) {
        const idAtributo = attr(atributo, 'xmi:idref', 'idref');
        if (idAtributo === undefined) continue;
        atributos.set(idAtributo, {
          identificador: esVerdadero(attr(atributo, 'identificador')),
          unico: esVerdadero(attr(atributo, 'unico')),
          nulo: attr(atributo, 'nulo') !== 'false',
        });
      }

      const filas: Record<string, string>[] = [];
      for (const fila of hijos(nodo, 'fila')) {
        const valores: Record<string, string> = {};
        for (const celda of hijos(fila, 'celda')) {
          const columna = attr(celda, 'columna');
          const valor = attr(celda, 'valor');
          if (columna !== undefined && columna !== '' && valor !== undefined) {
            valores[columna] = valor;
          }
        }
        if (Object.keys(valores).length > 0) filas.push(valores);
      }

      clases.set(ref, { posicion, atributos, filas });
    }
  }

  return { clases };
}
