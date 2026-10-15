import type {
  Attribute,
  ClassDiagram,
  ClassKind,
  DatabaseTarget,
  DiagramMeta,
  EndPoint,
  Id,
  Method,
  RelationKind,
  TypeRef,
  UmlClass,
  UmlModule,
  UmlRelation,
} from './uml.js';

/**
 * Diferencia estructural entre dos diagramas (dominio, no CRDT).
 *
 * `crdt/historial.ts` registra operaciones a medida que ocurren, por
 * navegador y sin memoria más allá de 400 entradas. Comparar dos snapshots
 * completos —una versión guardada contra el diagrama en curso— es un problema
 * distinto: no hay operaciones que leer, solo dos árboles de datos, y lo que
 * hace falta es decir qué cambió entre ellos. Diffear el estado CRDT
 * directamente sería caro y perdería la intención; diffear los dos
 * `ClassDiagram` ya resueltos es barato y es justo la pregunta que hace el
 * panel de versiones: «¿en qué se diferencia esto de lo que tengo ahora?».
 */

export type TipoCambio = 'añadido' | 'eliminado' | 'modificado';

export interface CambioDeCampo {
  campo: string;
  antes: string;
  despues: string;
}

export interface CambioDeClase {
  id: Id;
  nombre: string;
  tipo: TipoCambio;
  campos: CambioDeCampo[];
  atributosAñadidos: string[];
  atributosEliminados: string[];
  atributosModificados: CambioDeCampo[];
  metodosAñadidos: string[];
  metodosEliminados: string[];
  metodosModificados: CambioDeCampo[];
  literalesAñadidos: string[];
  literalesEliminados: string[];
}

export interface CambioDeRelacion {
  id: Id;
  tipo: TipoCambio;
  /** Lectura humana del vínculo, por ejemplo «Pedido (1) — composición → Línea (*)». */
  descripcion: string;
  campos: CambioDeCampo[];
}

export interface CambioDeModulo {
  id: Id;
  nombre: string;
  tipo: TipoCambio;
  campos: CambioDeCampo[];
}

export interface DiferenciaDiagramas {
  clases: CambioDeClase[];
  relaciones: CambioDeRelacion[];
  modulos: CambioDeModulo[];
  /** Cambios en `meta` (paquete, artefacto, descripción, motor). Sin fechas: siempre difieren. */
  meta: CambioDeCampo[];
}

export function hayDiferencias(diferencia: DiferenciaDiagramas): boolean {
  return (
    diferencia.clases.length > 0 ||
    diferencia.relaciones.length > 0 ||
    diferencia.modulos.length > 0 ||
    diferencia.meta.length > 0
  );
}

const ETIQUETA_RELACION: Record<RelationKind, string> = {
  association: 'asociación',
  aggregation: 'agregación',
  composition: 'composición',
  inheritance: 'herencia',
  realization: 'realización',
  dependency: 'dependencia',
};

const ETIQUETA_TIPO_CLASE: Record<ClassKind, string> = {
  class: 'clase',
  interface: 'interfaz',
  enum: 'enumeración',
  abstract: 'clase abstracta',
};

const ETIQUETA_MOTOR: Record<DatabaseTarget, string> = {
  postgres: 'PostgreSQL',
  mongodb: 'MongoDB',
  cassandra: 'Cassandra',
};

/**
 * Separa dos listas de elementos con `id` en añadidos, eliminados y comunes.
 *
 * Las clases y relaciones viven en el diagrama como `Record<Id,T>`, pero los
 * atributos y métodos de una clase son arrays; ambos casos son «empareja por
 * id, no por posición» y por eso esta función no asume ni Record ni índice:
 * recibe arrays y listo, y el llamador decide si venían de `Object.values`.
 */
function compararPorId<T extends { id: Id }>(
  anteriores: T[],
  actuales: T[],
): { añadidos: T[]; eliminados: T[]; comunes: Array<{ anterior: T; actual: T }> } {
  const mapaAnterior = new Map(anteriores.map((item) => [item.id, item]));
  const mapaActual = new Map(actuales.map((item) => [item.id, item]));
  return {
    añadidos: actuales.filter((item) => !mapaAnterior.has(item.id)),
    eliminados: anteriores.filter((item) => !mapaActual.has(item.id)),
    comunes: actuales
      .filter((item) => mapaAnterior.has(item.id))
      .map((item) => ({ anterior: mapaAnterior.get(item.id) as T, actual: item })),
  };
}

function agregarSiDistinto(campos: CambioDeCampo[], campo: string, antes: string, despues: string): void {
  if (antes !== despues) campos.push({ campo, antes, despues });
}

function formatTypeRef(tipo: TypeRef): string {
  return tipo.collection ? `${tipo.name}[]` : tipo.name;
}

/**
 * Representación textual completa de un atributo.
 *
 * Se usa para decidir si cambió algo y, a la vez, como el texto que ve el
 * usuario en el diff: comparar cadena contra cadena evita mantener una lista
 * separada de qué campos de `Attribute` «cuentan», que es la que se olvida de
 * actualizar el día que se añade uno nuevo.
 */
function formatAttribute(atributo: Attribute): string {
  const banderas = [
    atributo.isStatic ? 'static' : '',
    atributo.isFinal ? 'final' : '',
    atributo.isIdentifier ? 'PK' : '',
    atributo.isUnique ? 'unique' : '',
    atributo.isNullable ? '' : 'not null',
  ]
    .filter(Boolean)
    .join(' ');
  const multiplicidad = atributo.multiplicity ? `[${atributo.multiplicity}]` : '';
  const porDefecto = atributo.defaultValue !== undefined ? ` = ${atributo.defaultValue}` : '';
  return `${atributo.visibility} ${atributo.name}: ${formatTypeRef(atributo.type)}${multiplicidad}${porDefecto}${
    banderas ? ` {${banderas}}` : ''
  }`;
}

function formatMethod(metodo: Method): string {
  const parametros = metodo.parameters.map((p) => `${p.name}: ${formatTypeRef(p.type)}`).join(', ');
  const retorno = metodo.returnType ? formatTypeRef(metodo.returnType) : 'void';
  const banderas = [metodo.isStatic ? 'static' : '', metodo.isAbstract ? 'abstract' : '']
    .filter(Boolean)
    .join(' ');
  return `${metodo.visibility} ${metodo.name}(${parametros}): ${retorno}${banderas ? ` {${banderas}}` : ''}`;
}

function diffAtributos(
  anteriores: Attribute[],
  actuales: Attribute[],
): { añadidos: string[]; eliminados: string[]; modificados: CambioDeCampo[] } {
  const { añadidos, eliminados, comunes } = compararPorId(anteriores, actuales);
  const modificados: CambioDeCampo[] = [];
  for (const { anterior, actual } of comunes) {
    const antes = formatAttribute(anterior);
    const despues = formatAttribute(actual);
    if (antes !== despues) modificados.push({ campo: anterior.name, antes, despues });
  }
  return {
    añadidos: añadidos.map(formatAttribute),
    eliminados: eliminados.map(formatAttribute),
    modificados,
  };
}

function diffMetodos(
  anteriores: Method[],
  actuales: Method[],
): { añadidos: string[]; eliminados: string[]; modificados: CambioDeCampo[] } {
  const { añadidos, eliminados, comunes } = compararPorId(anteriores, actuales);
  const modificados: CambioDeCampo[] = [];
  for (const { anterior, actual } of comunes) {
    const antes = formatMethod(anterior);
    const despues = formatMethod(actual);
    if (antes !== despues) modificados.push({ campo: anterior.name, antes, despues });
  }
  return {
    añadidos: añadidos.map(formatMethod),
    eliminados: eliminados.map(formatMethod),
    modificados,
  };
}

function diffLiterales(
  anteriores: string[],
  actuales: string[],
): { añadidos: string[]; eliminados: string[] } {
  const anterioresSet = new Set(anteriores);
  const actualesSet = new Set(actuales);
  return {
    añadidos: actuales.filter((literal) => !anterioresSet.has(literal)),
    eliminados: anteriores.filter((literal) => !actualesSet.has(literal)),
  };
}

function diffCamposClase(anterior: UmlClass, actual: UmlClass): CambioDeCampo[] {
  const campos: CambioDeCampo[] = [];
  agregarSiDistinto(campos, 'nombre', anterior.name, actual.name);
  agregarSiDistinto(campos, 'tipo', ETIQUETA_TIPO_CLASE[anterior.kind], ETIQUETA_TIPO_CLASE[actual.kind]);
  agregarSiDistinto(campos, 'estereotipo', anterior.stereotype ?? '', actual.stereotype ?? '');
  agregarSiDistinto(campos, 'transitoria', anterior.transient ? 'sí' : 'no', actual.transient ? 'sí' : 'no');
  agregarSiDistinto(campos, 'módulo', anterior.moduleId ?? '(ninguno)', actual.moduleId ?? '(ninguno)');
  return campos;
}

function claseVacia(id: Id, nombre: string, tipo: TipoCambio): CambioDeClase {
  return {
    id,
    nombre,
    tipo,
    campos: [],
    atributosAñadidos: [],
    atributosEliminados: [],
    atributosModificados: [],
    metodosAñadidos: [],
    metodosEliminados: [],
    metodosModificados: [],
    literalesAñadidos: [],
    literalesEliminados: [],
  };
}

function diffClases(anterior: ClassDiagram, actual: ClassDiagram): CambioDeClase[] {
  const { añadidos, eliminados, comunes } = compararPorId(
    Object.values(anterior.classes),
    Object.values(actual.classes),
  );
  const cambios: CambioDeClase[] = [];
  for (const clase of añadidos) cambios.push(claseVacia(clase.id, clase.name, 'añadido'));
  for (const clase of eliminados) cambios.push(claseVacia(clase.id, clase.name, 'eliminado'));
  for (const { anterior: a, actual: b } of comunes) {
    const campos = diffCamposClase(a, b);
    const atributos = diffAtributos(a.attributes, b.attributes);
    const metodos = diffMetodos(a.methods, b.methods);
    const literales = diffLiterales(a.literals, b.literals);
    const sinCambios =
      campos.length === 0 &&
      atributos.añadidos.length === 0 &&
      atributos.eliminados.length === 0 &&
      atributos.modificados.length === 0 &&
      metodos.añadidos.length === 0 &&
      metodos.eliminados.length === 0 &&
      metodos.modificados.length === 0 &&
      literales.añadidos.length === 0 &&
      literales.eliminados.length === 0;
    if (sinCambios) continue;
    cambios.push({
      id: b.id,
      nombre: b.name,
      tipo: 'modificado',
      campos,
      atributosAñadidos: atributos.añadidos,
      atributosEliminados: atributos.eliminados,
      atributosModificados: atributos.modificados,
      metodosAñadidos: metodos.añadidos,
      metodosEliminados: metodos.eliminados,
      metodosModificados: metodos.modificados,
      literalesAñadidos: literales.añadidos,
      literalesEliminados: literales.eliminados,
    });
  }
  return cambios;
}

function nombreClase(diagrama: ClassDiagram, classId: Id): string {
  return diagrama.classes[classId]?.name ?? classId;
}

function describirExtremo(diagrama: ClassDiagram, extremo: EndPoint): string {
  const detalle = [extremo.multiplicity, extremo.role, extremo.navigable ? '' : 'no navegable']
    .filter(Boolean)
    .join(', ');
  return `${nombreClase(diagrama, extremo.classId)} (${detalle})`;
}

function describirRelacion(diagrama: ClassDiagram, relacion: UmlRelation): string {
  return `${describirExtremo(diagrama, relacion.source)} — ${ETIQUETA_RELACION[relacion.kind]} → ${describirExtremo(
    diagrama,
    relacion.target,
  )}`;
}

function diffCamposRelacion(
  anterior: UmlRelation,
  actual: UmlRelation,
  diagramaAnterior: ClassDiagram,
  diagramaActual: ClassDiagram,
): CambioDeCampo[] {
  const campos: CambioDeCampo[] = [];
  agregarSiDistinto(campos, 'tipo', ETIQUETA_RELACION[anterior.kind], ETIQUETA_RELACION[actual.kind]);
  agregarSiDistinto(campos, 'nombre', anterior.name ?? '', actual.name ?? '');
  agregarSiDistinto(
    campos,
    'origen',
    describirExtremo(diagramaAnterior, anterior.source),
    describirExtremo(diagramaActual, actual.source),
  );
  agregarSiDistinto(
    campos,
    'destino',
    describirExtremo(diagramaAnterior, anterior.target),
    describirExtremo(diagramaActual, actual.target),
  );
  agregarSiDistinto(
    campos,
    'clase de asociación',
    anterior.associationClassId ? nombreClase(diagramaAnterior, anterior.associationClassId) : '(ninguna)',
    actual.associationClassId ? nombreClase(diagramaActual, actual.associationClassId) : '(ninguna)',
  );
  return campos;
}

function diffRelaciones(anterior: ClassDiagram, actual: ClassDiagram): CambioDeRelacion[] {
  const { añadidos, eliminados, comunes } = compararPorId(
    Object.values(anterior.relations),
    Object.values(actual.relations),
  );
  const cambios: CambioDeRelacion[] = [];
  for (const relacion of añadidos) {
    cambios.push({ id: relacion.id, tipo: 'añadido', descripcion: describirRelacion(actual, relacion), campos: [] });
  }
  for (const relacion of eliminados) {
    cambios.push({
      id: relacion.id,
      tipo: 'eliminado',
      descripcion: describirRelacion(anterior, relacion),
      campos: [],
    });
  }
  for (const { anterior: a, actual: b } of comunes) {
    const campos = diffCamposRelacion(a, b, anterior, actual);
    if (campos.length === 0) continue;
    cambios.push({ id: b.id, tipo: 'modificado', descripcion: describirRelacion(actual, b), campos });
  }
  return cambios;
}

function diffCamposModulo(anterior: UmlModule, actual: UmlModule): CambioDeCampo[] {
  const campos: CambioDeCampo[] = [];
  agregarSiDistinto(campos, 'nombre', anterior.name, actual.name);
  agregarSiDistinto(campos, 'segmento de paquete', anterior.packageSegment, actual.packageSegment);
  agregarSiDistinto(campos, 'descripción', anterior.description, actual.description);
  return campos;
}

function diffModulos(anterior: ClassDiagram, actual: ClassDiagram): CambioDeModulo[] {
  const { añadidos, eliminados, comunes } = compararPorId(
    Object.values(anterior.modules),
    Object.values(actual.modules),
  );
  const cambios: CambioDeModulo[] = [];
  for (const modulo of añadidos) cambios.push({ id: modulo.id, nombre: modulo.name, tipo: 'añadido', campos: [] });
  for (const modulo of eliminados) cambios.push({ id: modulo.id, nombre: modulo.name, tipo: 'eliminado', campos: [] });
  for (const { anterior: a, actual: b } of comunes) {
    const campos = diffCamposModulo(a, b);
    if (campos.length === 0) continue;
    cambios.push({ id: b.id, nombre: b.name, tipo: 'modificado', campos });
  }
  return cambios;
}

/**
 * Cambios en los metadatos del diagrama.
 *
 * Sin `createdAt`/`updatedAt`: son marcas de tiempo, no decisiones de diseño,
 * y siempre difieren entre una versión guardada y el presente aunque nadie
 * haya tocado nada. Mostrarlas en el diff sería ruido garantizado.
 */
function diffMeta(anterior: DiagramMeta, actual: DiagramMeta): CambioDeCampo[] {
  const campos: CambioDeCampo[] = [];
  agregarSiDistinto(campos, 'paquete base', anterior.basePackage, actual.basePackage);
  agregarSiDistinto(campos, 'identificador de artefacto', anterior.artifactId, actual.artifactId);
  agregarSiDistinto(campos, 'descripción', anterior.description, actual.description);
  agregarSiDistinto(campos, 'motor de base de datos', ETIQUETA_MOTOR[anterior.motorBD], ETIQUETA_MOTOR[actual.motorBD]);
  return campos;
}

/** Diferencia estructural entre dos diagramas, pensada para comparar una versión guardada contra la actual. */
export function diffDiagramas(anterior: ClassDiagram, actual: ClassDiagram): DiferenciaDiagramas {
  return {
    clases: diffClases(anterior, actual),
    relaciones: diffRelaciones(anterior, actual),
    modulos: diffModulos(anterior, actual),
    meta: diffMeta(anterior.meta, actual.meta),
  };
}
