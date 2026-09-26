import * as Y from 'yjs';
import { ulid } from '../model/id.js';
import type { Operation } from '../ops/operations.js';
import { describeOperation } from '../ops/operations.js';
import {
  getClassesMap,
  getModulesMap,
  getRelationsMap,
  writeClass,
  writeSeedRow,
} from './document.js';
import { createClass } from '../model/factory.js';
import type { RelationKind } from '../model/uml.js';
import { isToMany } from '../model/uml.js';

/**
 * Aplicación de operaciones de dominio sobre el documento CRDT.
 *
 * Este módulo es el único que escribe en el documento. El ratón, el teclado, el
 * asistente de voz y el reconocimiento de pizarra producen todos `Operation` y
 * pasan por aquí (decisión D6), lo que hace que deshacer una intervención del
 * asistente sea deshacer una transacción y no un caso especial (RF-IA-05).
 *
 * Cada operación se aplica dentro de una transacción con origen: el proveedor de
 * red usa el origen para no reenviar al autor lo que él mismo acaba de escribir,
 * y el `UndoManager` para saber qué cambios son suyos y puede revertir.
 */

export interface ApplyContext {
  /** Origen de la transacción Yjs. Por defecto, `'local'`. */
  origin?: unknown;
}

export type ApplyResult =
  | { ok: true; description: string; classId?: string; relationId?: string; moduleId?: string }
  | { ok: false; error: string };

/**
 * Resuelve una referencia a clase.
 *
 * El asistente habla de clases por nombre («añade un campo a Cliente») y la
 * interfaz por identificador. Buscar por nombre es case-insensitive porque el
 * reconocimiento de voz no respeta mayúsculas, y ambigua a propósito: si hay dos
 * clases con el mismo nombre se falla en vez de elegir una, porque elegir mal
 * modifica silenciosamente la clase equivocada.
 */
function resolveClass(
  doc: Y.Doc,
  ref: { id: string } | { name: string },
): { ok: true; id: string; map: Y.Map<unknown> } | { ok: false; error: string } {
  const classes = getClassesMap(doc);

  if ('id' in ref) {
    const found = classes.get(ref.id);
    if (!(found instanceof Y.Map)) return { ok: false, error: `No existe la clase ${ref.id}` };
    return { ok: true, id: ref.id, map: found };
  }

  const wanted = ref.name.trim().toLowerCase();
  const matches: { id: string; map: Y.Map<unknown> }[] = [];
  for (const [id, value] of classes.entries()) {
    if (!(value instanceof Y.Map)) continue;
    const name = value.get('name');
    if (typeof name === 'string' && name.toLowerCase() === wanted) matches.push({ id, map: value });
  }

  const first = matches[0];
  if (!first) return { ok: false, error: `No hay ninguna clase llamada «${ref.name}»` };
  if (matches.length > 1) {
    return { ok: false, error: `Hay ${matches.length} clases llamadas «${ref.name}»` };
  }
  return { ok: true, id: first.id, map: first.map };
}

function arrayAt(map: Y.Map<unknown>, key: string): Y.Array<unknown> {
  const existing = map.get(key);
  if (existing instanceof Y.Array) return existing;
  const created = new Y.Array<unknown>();
  map.set(key, created);
  return created;
}

/** Índice de un elemento con el nombre dado dentro de un `Y.Array` de mapas. */
function indexOfNamed(array: Y.Array<unknown>, name: string): number {
  const wanted = name.trim().toLowerCase();
  const items = array.toArray();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!(item instanceof Y.Map)) continue;
    const itemName = item.get('name');
    if (typeof itemName === 'string' && itemName.toLowerCase() === wanted) return i;
  }
  return -1;
}

/**
 * Aplica una operación. Devuelve un resultado en lugar de lanzar: una operación
 * que no se puede aplicar —el asistente nombró una clase que no existe— es un
 * caso corriente que hay que explicar al usuario, no un fallo del programa.
 */
export function applyOperation(
  doc: Y.Doc,
  operation: Operation,
  context: ApplyContext = {},
): ApplyResult {
  const origin = context.origin ?? 'local';
  let outcome: ApplyResult = { ok: true, description: describeOperation(operation) };

  doc.transact(() => {
    outcome = applyInsideTransaction(doc, operation);
  }, origin);

  return outcome;
}

/**
 * Aplica varias operaciones como una sola transacción.
 *
 * Es lo que consume una propuesta del asistente: o entran todas o no entra
 * ninguna, para que un «crea Pedido con sus campos y relaciónalo con Cliente» no
 * pueda dejar la mitad hecha ni requerir varios deshacer.
 */
export function applyOperations(
  doc: Y.Doc,
  operations: Operation[],
  context: ApplyContext = {},
): { ok: true; results: ApplyResult[] } | { ok: false; error: string; failedAt: number } {
  const origin = context.origin ?? 'local';
  const results: ApplyResult[] = [];
  let error = '';
  let failedAt = -1;

  // Los tres mapas, no dos: si el `UndoManager` no vigilase los módulos, un
  // lote que crea un módulo y falla en la operación siguiente revertiría las
  // clases y dejaría el módulo puesto, que es justo el estado a medias que este
  // método existe para evitar.
  const undoable = new Y.UndoManager(
    [getClassesMap(doc), getRelationsMap(doc), getModulesMap(doc)],
    { trackedOrigins: new Set([origin]) },
  );

  doc.transact(() => {
    for (const [index, operation] of operations.entries()) {
      const result = applyInsideTransaction(doc, operation);
      results.push(result);
      if (!result.ok) {
        error = result.error;
        failedAt = index;
        return;
      }
    }
  }, origin);

  if (failedAt !== -1) {
    // La transacción ya se cerró: revertirla es la única forma de que un fallo a
    // mitad de lote no deje el diagrama en un estado que nadie pidió.
    undoable.undo();
    undoable.destroy();
    return { ok: false, error, failedAt };
  }

  undoable.destroy();
  return { ok: true, results };
}

function applyInsideTransaction(doc: Y.Doc, operation: Operation): ApplyResult {
  const description = describeOperation(operation);
  const classes = getClassesMap(doc);
  const relations = getRelationsMap(doc);

  switch (operation.op) {
    case 'addClass': {
      const cls = createClass({
        name: operation.name,
        kind: operation.kind,
        position: operation.position ?? nextFreePosition(doc, classes),
      });
      classes.set(cls.id, writeClass(cls));
      return { ok: true, description, classId: cls.id };
    }

    case 'renameClass': {
      const target = resolveClass(doc, operation.ref);
      if (!target.ok) return { ok: false, error: target.error };
      target.map.set('name', operation.name);
      return { ok: true, description, classId: target.id };
    }

    case 'removeClass': {
      const target = resolveClass(doc, operation.ref);
      if (!target.ok) return { ok: false, error: target.error };
      // Las relaciones que la tocaban se borran aquí. Dejarlas colgando las
      // haría invisibles (el lector las omite) pero seguirían ocupando el
      // documento y reaparecerían si se deshace solo el borrado de la clase.
      for (const [relationId, value] of [...relations.entries()]) {
        if (!(value instanceof Y.Map)) continue;
        if (value.get('sourceId') === target.id || value.get('targetId') === target.id) {
          relations.delete(relationId);
        } else if (value.get('associationClassId') === target.id) {
          // Aquí la clase borrada no es un extremo, solo colgaba de la
          // relación como clase de asociación: se limpia esa referencia y la
          // relación sigue existiendo (igual que borrar un módulo deja
          // huérfano el `moduleId` de una clase en vez de borrar la clase).
          value.delete('associationClassId');
        }
      }
      classes.delete(target.id);
      return { ok: true, description, classId: target.id };
    }

    case 'moveClass': {
      const target = resolveClass(doc, operation.ref);
      if (!target.ok) return { ok: false, error: target.error };
      target.map.set('x', operation.position.x);
      target.map.set('y', operation.position.y);
      return { ok: true, description, classId: target.id };
    }

    case 'setClassKind': {
      const target = resolveClass(doc, operation.ref);
      if (!target.ok) return { ok: false, error: target.error };
      target.map.set('kind', operation.kind);
      return { ok: true, description, classId: target.id };
    }

    case 'addAttribute': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      const attributes = arrayAt(target.map, 'attributes');
      if (indexOfNamed(attributes, operation.name) !== -1) {
        return {
          ok: false,
          error: `«${operation.name}» ya existe en esa clase`,
        };
      }

      const entry = new Y.Map<unknown>();
      entry.set('id', ulid());
      entry.set('name', operation.name);
      entry.set('type', operation.type);
      entry.set('collection', false);
      entry.set('visibility', operation.visibility);
      entry.set('isStatic', false);
      entry.set('isFinal', false);
      entry.set('isIdentifier', operation.isIdentifier);
      entry.set('isUnique', operation.isUnique);
      // Un identificador nunca es nulo, diga lo que diga quien lo pidió.
      entry.set('isNullable', operation.isIdentifier ? false : operation.isNullable);
      attributes.push([entry]);
      return { ok: true, description, classId: target.id };
    }

    case 'updateAttribute': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      const attributes = arrayAt(target.map, 'attributes');
      const index = indexOfNamed(attributes, operation.attributeName);
      if (index === -1) {
        return { ok: false, error: `No existe el atributo «${operation.attributeName}»` };
      }
      const entry = attributes.get(index);
      if (!(entry instanceof Y.Map)) {
        return { ok: false, error: `El atributo «${operation.attributeName}» está corrupto` };
      }

      const { changes } = operation;
      if (changes.name !== undefined) entry.set('name', changes.name);
      if (changes.type !== undefined) entry.set('type', changes.type);
      if (changes.visibility !== undefined) entry.set('visibility', changes.visibility);
      if (changes.isIdentifier !== undefined) entry.set('isIdentifier', changes.isIdentifier);
      if (changes.isUnique !== undefined) entry.set('isUnique', changes.isUnique);
      if (changes.isNullable !== undefined) entry.set('isNullable', changes.isNullable);
      if (entry.get('isIdentifier') === true) entry.set('isNullable', false);
      return { ok: true, description, classId: target.id };
    }

    case 'removeAttribute': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      const attributes = arrayAt(target.map, 'attributes');
      const index = indexOfNamed(attributes, operation.attributeName);
      if (index === -1) {
        return { ok: false, error: `No existe el atributo «${operation.attributeName}»` };
      }
      attributes.delete(index, 1);
      return { ok: true, description, classId: target.id };
    }

    case 'addMethod': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      const methods = arrayAt(target.map, 'methods');
      if (indexOfNamed(methods, operation.name) !== -1) {
        return { ok: false, error: `«${operation.name}» ya existe en esa clase` };
      }

      const entry = new Y.Map<unknown>();
      entry.set('id', ulid());
      entry.set('name', operation.name);
      entry.set('visibility', operation.visibility);
      entry.set('isStatic', false);
      entry.set('isAbstract', false);
      entry.set('returnType', operation.returnType ?? '');
      entry.set('returnCollection', false);

      const parameters = new Y.Array<unknown>();
      for (const parameter of operation.parameters) {
        const item = new Y.Map<unknown>();
        item.set('name', parameter.name);
        item.set('type', parameter.type);
        item.set('collection', false);
        parameters.push([item]);
      }
      entry.set('parameters', parameters);
      methods.push([entry]);
      return { ok: true, description, classId: target.id };
    }

    case 'removeMethod': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      const methods = arrayAt(target.map, 'methods');
      const index = indexOfNamed(methods, operation.methodName);
      if (index === -1) {
        return { ok: false, error: `No existe el método «${operation.methodName}»` };
      }
      methods.delete(index, 1);
      return { ok: true, description, classId: target.id };
    }

    case 'addRelation': {
      const source = resolveClass(doc, operation.source);
      if (!source.ok) return { ok: false, error: source.error };
      const target = resolveClass(doc, operation.target);
      if (!target.ok) return { ok: false, error: target.error };

      if (operation.kind === 'inheritance' && source.id === target.id) {
        return { ok: false, error: 'Una clase no puede heredar de sí misma' };
      }
      if (operation.kind === 'inheritance' && createsCycle(doc, source.id, target.id)) {
        return { ok: false, error: 'Esa herencia crearía un ciclo' };
      }

      // La herencia no tiene multiplicidad; forzarla a '1' evita que un valor
      // heredado del esquema por defecto acabe en el generador.
      const isInheritance = operation.kind === 'inheritance' || operation.kind === 'realization';
      const sourceMultiplicity = isInheritance ? '1' : operation.sourceMultiplicity;
      const targetMultiplicity = isInheritance ? '1' : operation.targetMultiplicity;

      // "Asociación de clase" rápida: el lienzo la ofrece como una única
      // acción de arrastre que crea la relación Y la clase intermedia a la
      // vez, así que valida y crea aquí mismo en lugar de exigir un segundo
      // `setAssociationClass` (que además no podría referenciar un id que
      // esta misma operación todavía no ha generado). La restricción de N:M
      // es la misma que `setAssociationClass`: fuera de N:M la clase de
      // asociación sería una tabla redundante con el lado "muchos".
      if (operation.associationClassName) {
        const esManyToMany =
          operation.kind === 'association' &&
          isToMany(sourceMultiplicity) &&
          isToMany(targetMultiplicity);
        if (!esManyToMany) {
          return {
            ok: false,
            error: 'Una clase de asociación solo se puede crear sobre una relación muchos a muchos',
          };
        }
      }

      const id = ulid();
      const entry = new Y.Map<unknown>();
      entry.set('id', id);
      entry.set('kind', operation.kind);
      if (operation.name) entry.set('name', operation.name);
      entry.set('sourceId', source.id);
      entry.set('targetId', target.id);
      entry.set('sourceMultiplicity', sourceMultiplicity);
      entry.set('targetMultiplicity', targetMultiplicity);
      entry.set('sourceNavigable', true);
      entry.set('targetNavigable', true);

      let associationClassId: string | undefined;
      if (operation.associationClassName) {
        // Este atajo siempre crea una clase nueva (ver el comentario de más
        // arriba): a diferencia de `addClass`, aquí sí se comprueba el nombre
        // antes de crear, porque el paso siguiente casi siempre es un
        // `addAttribute` sobre esa misma clase **por nombre**, en el mismo
        // lote. Si ya hubiera otra clase con ese nombre, `addRelation` crearía
        // una segunda y el `addAttribute` posterior encontraría dos —el error
        // sería «Hay 2 clases llamadas «X»», que no dice nada de la relación
        // que se estaba creando y deja creer que no ha pasado nada al pulsar
        // Aplicar, porque el lote entero se revierte. Fallar aquí, con la
        // relación todavía sin crear, señala el problema real: el nombre
        // elegido para la clase de asociación ya está en uso.
        const nombreBuscado = operation.associationClassName.trim().toLowerCase();
        const yaExiste = [...classes.values()].some(
          (value) =>
            value instanceof Y.Map && String(value.get('name') ?? '').toLowerCase() === nombreBuscado,
        );
        if (yaExiste) {
          return {
            ok: false,
            error: `Ya existe una clase llamada «${operation.associationClassName}»; la clase de asociación necesita un nombre distinto`,
          };
        }

        const assocClass = createClass({
          name: operation.associationClassName,
          position: nextFreePosition(doc, classes),
        });
        classes.set(assocClass.id, writeClass(assocClass));
        entry.set('associationClassId', assocClass.id);
        associationClassId = assocClass.id;
      }

      relations.set(id, entry);
      return { ok: true, description, relationId: id, classId: associationClassId };
    }

    case 'updateRelation': {
      const entry: unknown = relations.get(operation.id);
      if (!(entry instanceof Y.Map)) {
        return { ok: false, error: `No existe la relación ${operation.id}` };
      }

      const { changes } = operation;
      const kind = changes.kind ?? (entry.get('kind') as RelationKind);

      // Cambiar a herencia se comprueba igual que crearla: si no, la validación
      // de ciclos sería trivial de esquivar dibujando una asociación y
      // convirtiéndola después, y el ciclo aparecería en el generador como una
      // recursión infinita en vez de como un error del diagrama.
      if (changes.kind === 'inheritance' || changes.kind === 'realization') {
        const sourceId = entry.get('sourceId') as string;
        const targetId = entry.get('targetId') as string;
        if (sourceId === targetId) {
          return { ok: false, error: 'Una clase no puede heredar de sí misma' };
        }
        if (changes.kind === 'inheritance' && createsCycle(doc, sourceId, targetId)) {
          return { ok: false, error: 'Esa herencia crearía un ciclo' };
        }
      }

      if (changes.kind !== undefined) entry.set('kind', changes.kind);
      if (changes.name !== undefined) {
        // Vaciar el nombre lo quita en vez de guardar una cadena vacía, que el
        // generador trataría como un nombre y colaría en el código Java.
        if (changes.name.trim()) entry.set('name', changes.name.trim());
        else entry.delete('name');
      }

      // La herencia no tiene multiplicidad. Se normaliza a '1' en vez de
      // rechazar el cambio: quien convierte una asociación «1..*» en herencia
      // está pidiendo una herencia, no discutiendo sobre cardinalidades.
      const sinCardinalidad = kind === 'inheritance' || kind === 'realization';
      if (sinCardinalidad) {
        entry.set('sourceMultiplicity', '1');
        entry.set('targetMultiplicity', '1');
      } else {
        if (changes.sourceMultiplicity !== undefined) {
          entry.set('sourceMultiplicity', changes.sourceMultiplicity);
        }
        if (changes.targetMultiplicity !== undefined) {
          entry.set('targetMultiplicity', changes.targetMultiplicity);
        }
      }

      if (changes.sourceRole !== undefined) {
        if (changes.sourceRole.trim()) entry.set('sourceRole', changes.sourceRole.trim());
        else entry.delete('sourceRole');
      }
      if (changes.targetRole !== undefined) {
        if (changes.targetRole.trim()) entry.set('targetRole', changes.targetRole.trim());
        else entry.delete('targetRole');
      }

      return { ok: true, description, relationId: operation.id };
    }

    case 'removeRelation': {
      if (!relations.has(operation.id)) {
        return { ok: false, error: `No existe la relación ${operation.id}` };
      }
      relations.delete(operation.id);
      return { ok: true, description, relationId: operation.id };
    }

    case 'setAssociationClass': {
      const entry = relations.get(operation.relationId);
      if (!(entry instanceof Y.Map)) {
        return { ok: false, error: `No existe la relación ${operation.relationId}` };
      }

      // `classRef: null` descuelga la clase de asociación sin tocar nada más:
      // no es destructiva (no borra atributos ni clases), por eso no está en
      // el conjunto DESTRUCTIVAS de operations.ts.
      if (operation.classRef === null) {
        entry.delete('associationClassId');
        return { ok: true, description, relationId: operation.relationId };
      }

      // Solo tiene sentido sobre una asociación N:M real: sobre cualquier otra
      // cardinalidad la clase del lado "muchos" ya guarda esos mismos datos en
      // su propia fila, y una clase de asociación sería una tabla redundante.
      const kind = entry.get('kind');
      const sourceMultiplicity = entry.get('sourceMultiplicity');
      const targetMultiplicity = entry.get('targetMultiplicity');
      const esManyToMany =
        kind === 'association' &&
        typeof sourceMultiplicity === 'string' &&
        typeof targetMultiplicity === 'string' &&
        isToMany(sourceMultiplicity) &&
        isToMany(targetMultiplicity);
      if (!esManyToMany) {
        return {
          ok: false,
          error: 'Una clase de asociación solo se puede colgar de una relación muchos a muchos',
        };
      }

      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      if (target.id === entry.get('sourceId') || target.id === entry.get('targetId')) {
        return {
          ok: false,
          error: 'La clase de asociación no puede ser a la vez uno de los extremos de la relación',
        };
      }

      entry.set('associationClassId', target.id);
      return { ok: true, description, relationId: operation.relationId, classId: target.id };
    }

    case 'addEnumLiteral': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      if (target.map.get('kind') !== 'enum') {
        return { ok: false, error: 'Solo una enumeración admite literales' };
      }
      const literals = arrayAt(target.map, 'literals');
      const existing = literals.toArray().filter((l): l is string => typeof l === 'string');
      if (existing.some((l) => l.toLowerCase() === operation.literal.toLowerCase())) {
        return { ok: false, error: `«${operation.literal}» ya está en la enumeración` };
      }
      literals.push([operation.literal]);
      return { ok: true, description, classId: target.id };
    }

    case 'setSeedRows': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };

      // Solo tienen sentido en algo que se convierta en tabla. Aceptarlos en una
      // interfaz o una enumeración crearía datos que el generador ignoraría en
      // silencio, y el usuario los daría por guardados.
      const kind = target.map.get('kind');
      if (kind === 'interface' || kind === 'enum') {
        return { ok: false, error: `«${kind}» no se materializa como tabla: no admite datos` };
      }

      // Un valor cuya columna no existe en la clase no se guarda a medias: se
      // rechaza la operación entera. Ese desajuste solo puede venir de una
      // importación mal mapeada, y aceptarla dejaría datos que nunca llegarían
      // al SQL generado y que nadie volvería a mirar.
      const attributes = arrayAt(target.map, 'attributes');
      const conocidos = new Set(
        attributes
          .toArray()
          .flatMap((a) => (a instanceof Y.Map ? [a.get('name')] : []))
          .filter((n): n is string => typeof n === 'string'),
      );
      for (const [indice, row] of operation.rows.entries()) {
        for (const columna of Object.keys(row)) {
          if (!conocidos.has(columna)) {
            return {
              ok: false,
              error: `La fila ${indice + 1} trae la columna «${columna}», que no es un atributo de la clase`,
            };
          }
        }
      }

      const filas = arrayAt(target.map, 'seedRows');
      filas.delete(0, filas.length);
      filas.push(operation.rows.map(writeSeedRow));
      return { ok: true, description, classId: target.id };
    }

    case 'removeSeedRow': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      const filas = arrayAt(target.map, 'seedRows');
      if (operation.index > filas.length) {
        return {
          ok: false,
          error: `Esa clase tiene ${filas.length} fila(s) de datos; no hay una ${operation.index}`,
        };
      }
      filas.delete(operation.index - 1, 1);
      return { ok: true, description, classId: target.id };
    }

    case 'addModule': {
      const modules = getModulesMap(doc);
      const chocado = segmentoOcupado(modules, operation.packageSegment, null);
      if (chocado !== null) {
        return {
          ok: false,
          error: `El módulo «${chocado}» ya usa el paquete «${operation.packageSegment}»`,
        };
      }
      const id = ulid();
      const entry = new Y.Map<unknown>();
      entry.set('id', id);
      entry.set('name', operation.name);
      entry.set('packageSegment', operation.packageSegment);
      entry.set('description', operation.description);
      modules.set(id, entry);
      return { ok: true, description, moduleId: id };
    }

    case 'updateModule': {
      const modules = getModulesMap(doc);
      const entry = modules.get(operation.id);
      if (!(entry instanceof Y.Map)) {
        return { ok: false, error: `No existe el módulo ${operation.id}` };
      }
      const { changes } = operation;
      if (changes.packageSegment !== undefined) {
        const chocado = segmentoOcupado(modules, changes.packageSegment, operation.id);
        if (chocado !== null) {
          return {
            ok: false,
            error: `El módulo «${chocado}» ya usa el paquete «${changes.packageSegment}»`,
          };
        }
        entry.set('packageSegment', changes.packageSegment);
      }
      if (changes.name !== undefined) entry.set('name', changes.name);
      if (changes.description !== undefined) entry.set('description', changes.description);
      return { ok: true, description, moduleId: operation.id };
    }

    case 'removeModule': {
      const modules = getModulesMap(doc);
      if (!(modules.get(operation.id) instanceof Y.Map)) {
        return { ok: false, error: `No existe el módulo ${operation.id}` };
      }
      // Se limpia la referencia en cada clase en lugar de dejarla colgando. El
      // lector ya tolera un `moduleId` huérfano, pero si más tarde reapareciera
      // un módulo con ese mismo identificador —deshacer y rehacer basta— las
      // clases volverían solas a un módulo del que se las había sacado.
      for (const value of classes.values()) {
        if (!(value instanceof Y.Map)) continue;
        if (value.get('moduleId') === operation.id) value.delete('moduleId');
      }
      modules.delete(operation.id);
      return { ok: true, description, moduleId: operation.id };
    }

    case 'assignClassToModule': {
      const target = resolveClass(doc, operation.classRef);
      if (!target.ok) return { ok: false, error: target.error };
      if (operation.moduleId === null) {
        target.map.delete('moduleId');
        return { ok: true, description, classId: target.id };
      }
      if (!(getModulesMap(doc).get(operation.moduleId) instanceof Y.Map)) {
        return { ok: false, error: `No existe el módulo ${operation.moduleId}` };
      }
      target.map.set('moduleId', operation.moduleId);
      return { ok: true, description, classId: target.id, moduleId: operation.moduleId };
    }
  }
}

/**
 * Nombre del módulo que ya ocupa ese segmento de paquete, o `null` si está libre.
 *
 * Dos módulos con el mismo segmento no dan un error de compilación: dan algo
 * peor, que es que sus clases acaben mezcladas en la misma carpeta del proyecto
 * generado sin que nada lo avise. Por eso se rechaza al escribir y no al
 * generar.
 */
function segmentoOcupado(
  modules: Y.Map<unknown>,
  segmento: string,
  exceptoId: string | null,
): string | null {
  for (const [id, value] of modules.entries()) {
    if (!(value instanceof Y.Map) || id === exceptoId) continue;
    if (value.get('packageSegment') !== segmento) continue;
    const name = value.get('name');
    return typeof name === 'string' ? name : id;
  }
  return null;
}

/**
 * Detecta si añadir `hijo extends padre` cerraría un ciclo, recorriendo hacia
 * arriba desde el padre propuesto. Se comprueba al crear la relación y no al
 * generar porque un ciclo dibujado es un error que el usuario puede corregir
 * mientras recuerda qué intentaba hacer.
 */
function createsCycle(doc: Y.Doc, childId: string, parentId: string): boolean {
  const relations = getRelationsMap(doc);

  const superclassOf = (classId: string): string | null => {
    for (const value of relations.values()) {
      if (!(value instanceof Y.Map)) continue;
      if (value.get('kind') !== 'inheritance') continue;
      if (value.get('sourceId') !== classId) continue;
      const parent = value.get('targetId');
      if (typeof parent === 'string') return parent;
    }
    return null;
  };

  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current !== null && !seen.has(current)) {
    if (current === childId) return true;
    seen.add(current);
    current = superclassOf(current);
  }
  return false;
}

/**
 * Coloca una clase nueva donde no tape a las existentes.
 *
 * Sin esto, todo lo que crea el asistente aparece en el mismo punto y el usuario
 * ve una sola caja en lugar de las cinco que pidió.
 *
 * Contar las que ya hay resuelve el caso de uno solo y falla en cuanto son dos
 * sin conexión: ambos ven las mismas cuatro clases, ambos crean la quinta y
 * ambos calculan la misma casilla, así que al reconectar una queda exactamente
 * debajo de la otra. El documento converge —no se pierde nada— pero en pantalla
 * parece que la fusión se comió una clase, que es de las cosas que hacen que
 * alguien deje de fiarse del modo sin conexión. El identificador del cliente
 * deshace el empate sin necesidad de hablar con nadie: cada navegador tiene el
 * suyo, y offline es justo cuando no se puede preguntar.
 *
 * El desvío reparte sobre 256 carriles y no sobre cuatro o cinco: con pocos, dos
 * clientes cualquiera caen en el mismo con una probabilidad que se nota —una de
 * cada cinco veces hace que la prueba parpadee, y lo que parpadea en una prueba
 * le pasa de verdad a alguien—.
 *
 * Lo que se consigue es que no queden *exactamente* encima. Solaparse a medias
 * sigue siendo posible, y por eso el desvío vertical va en pasos de 12 px: basta
 * para que asome la cabecera, que es donde está el nombre, y quien mira sabe que
 * hay dos cajas y puede arrastrar una. Garantizarlo del todo exigiría que los
 * dos clientes se pusieran de acuerdo, que es justo lo que no se puede hacer sin
 * conexión.
 */
function nextFreePosition(doc: Y.Doc, classes: Y.Map<unknown>): { x: number; y: number } {
  const step = 260;
  const perRow = 4;
  const count = classes.size;
  const carril = doc.clientID % 256;
  return {
    x: 60 + (count % perRow) * step + (carril % 16) * 10,
    y: 60 + Math.floor(count / perRow) * 200 + Math.floor(carril / 16) * 12,
  };
}
