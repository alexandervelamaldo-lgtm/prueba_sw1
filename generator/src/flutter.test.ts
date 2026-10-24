import { describe, expect, it } from 'vitest';
import {
  createAttribute,
  createClass,
  createDiagram,
} from '@app/shared';
import { tiendaDiagram } from './fixtures/corpus.js';
import { generateFlutter } from './flutter/generate-flutter.js';
import { normalize } from './ir/normalize.js';
import type { DatabaseTarget } from './ir/types.js';

function file(files: ReturnType<typeof generateFlutter>, path: string): string {
  const found = files.find((entry) => entry.path === path);
  if (!found) throw new Error(`Generated file not found: ${path}`);
  return found.content;
}

function diagramWithIds(
  sourceIdType = 'Long',
  stringTargetIdType = 'String',
  numericTargetIdType = 'Long',
) {
  const owner = createClass({
    id: 'owner',
    name: 'Owner',
    attributes: [
      createAttribute({ id: 'owner-id', name: 'id', type: sourceIdType, isIdentifier: true }),
      createAttribute({ id: 'owner-string-target', name: 'stringTarget', type: 'StringTarget', isNullable: false }),
      createAttribute({ id: 'owner-numeric-target', name: 'numericTarget', type: 'NumericTarget', isNullable: false }),
    ],
  });
  const stringTarget = createClass({
    id: 'string-target',
    name: 'StringTarget',
    attributes: [createAttribute({ id: 'string-target-id', name: 'id', type: stringTargetIdType, isIdentifier: true })],
  });
  const numericTarget = createClass({
    id: 'numeric-target',
    name: 'NumericTarget',
    attributes: [createAttribute({ id: 'numeric-target-id', name: 'id', type: numericTargetIdType, isIdentifier: true })],
  });

  return createDiagram({
    id: 'flutter-id-types',
    name: 'FlutterIdTypes',
    meta: { basePackage: 'com.example.ids', artifactId: 'flutter-ids', description: 'Flutter ID types' },
    classes: { owner, stringTarget, numericTarget },
  });
}

function flutterFiles(target: DatabaseTarget = 'postgres') {
  return generateFlutter(normalize(diagramWithIds(), { databaseTarget: target }));
}

describe('Flutter identifier types', () => {
  it('maps PostgreSQL String identifiers to Dart String in models and service routes', () => {
    const files = generateFlutter(normalize(diagramWithIds('String')));
    expect(file(files, 'lib/modelos/owner.dart')).toContain('final String id;');
    expect(file(files, 'lib/servicios/owner_servicio.dart')).toContain('obtener(String id)');
    expect(file(files, 'lib/servicios/owner_servicio.dart')).toContain('actualizar(String id,');
    expect(file(files, 'lib/pantallas/owner_lista.dart')).toContain('Future<void> _del(String id)');
  });

  it('keeps UUID identifiers as Dart String', () => {
    const files = generateFlutter(normalize(diagramWithIds('UUID')));
    expect(file(files, 'lib/modelos/owner.dart')).toContain('final String id;');
    expect(file(files, 'lib/servicios/owner_servicio.dart')).toContain('obtener(String id)');
  });

  it('keeps Long and Integer identifiers as Dart int', () => {
    const classes = {
      longEntity: createClass({
        id: 'long-entity', name: 'LongEntity',
        attributes: [createAttribute({ id: 'long-id', name: 'id', type: 'Long', isIdentifier: true })],
      }),
      integerEntity: createClass({
        id: 'integer-entity', name: 'IntegerEntity',
        attributes: [createAttribute({ id: 'integer-id', name: 'id', type: 'Integer', isIdentifier: true })],
      }),
    };
    const files = generateFlutter(normalize(createDiagram({
      id: 'numeric-ids', name: 'NumericIds',
      meta: { basePackage: 'com.example.numeric', artifactId: 'numeric-ids' },
      classes,
    })));
    expect(file(files, 'lib/modelos/long_entity.dart')).toContain('final int id;');
    expect(file(files, 'lib/modelos/integer_entity.dart')).toContain('final int id;');
    expect(file(files, 'lib/servicios/integer_entity_servicio.dart')).toContain('obtener(int id)');
  });

  it.each(['mongodb', 'cassandra'] as const)('%s normalizes entity and to-one IDs to String', (target) => {
    const files = flutterFiles(target);
    const owner = file(files, 'lib/modelos/owner.dart');
    const service = file(files, 'lib/servicios/owner_servicio.dart');
    expect(owner).toContain('final String id;');
    expect(owner).toContain('final String stringTargetId;');
    expect(owner).toContain('final String numericTargetId;');
    expect(service).toContain('obtener(String id)');
    expect(service).toContain('required String stringTargetId');
    expect(service).toContain('required String numericTargetId');
  });

  it('types each to-one ID from its target entity identifier', () => {
    const files = generateFlutter(normalize(diagramWithIds('Long', 'String', 'Long')));
    const model = file(files, 'lib/modelos/owner.dart');
    const service = file(files, 'lib/servicios/owner_servicio.dart');
    const form = file(files, 'lib/pantallas/owner_formulario.dart');
    expect(model).toContain('final String stringTargetId;');
    expect(model).toContain('final int numericTargetId;');
    expect(service).toContain('required String stringTargetId');
    expect(service).toContain('required int numericTargetId');
    expect(form).toContain('stringTargetId: _cStringTargetId.text.trim(),');
    expect(form).toContain('numericTargetId: int.parse(_cNumericTargetId.text.trim()),');
  });

  it('preserves int IDs for the default PostgreSQL tienda corpus', () => {
    const files = generateFlutter(normalize(tiendaDiagram()));
    expect(file(files, 'lib/modelos/pedido.dart')).toContain('final int id;');
    expect(file(files, 'lib/servicios/pedido_servicio.dart')).toContain('obtener(int id)');
  });
});

describe('generated Flutter compiles', () => {
  const files = generateFlutter(normalize(tiendaDiagram()));

  it('awaits list loading before the synchronous setState callback', () => {
    const listFiles = files.filter((entry) => entry.path.startsWith('lib/pantallas/') && entry.path.endsWith('_lista.dart'));
    expect(listFiles.length).toBeGreaterThan(0);
    for (const entry of listFiles) {
      expect(entry.content).toContain('final items = await ');
      expect(entry.content).toContain('setState(() { _items = items;');
      expect(entry.content).not.toContain('setState(() { _items = await ');
      expect(entry.content).not.toContain('items as List<');
    }
  });

  it('imports the voice widget only for forms that contain String fields', () => {
    expect(file(files, 'lib/pantallas/producto_formulario.dart')).toContain("import '../widgets/campo_con_voz.dart';");
    expect(file(files, 'lib/pantallas/linea_pedido_formulario.dart')).not.toContain("import '../widgets/campo_con_voz.dart';");
  });

  it('generates Boolean fields as Boolean state and switch controls', () => {
    const form = file(files, 'lib/pantallas/producto_formulario.dart');
    expect(form).toContain('bool _cActivo = false;');
    expect(form).toContain('SwitchListTile(title: const Text(\'Activo\'), value: _cActivo,');
    expect(form).toContain('activo: _cActivo,');
    expect(form).not.toContain('_cActivo.text');
  });
});
