import {
  type ClassDiagram,
  createAttribute,
  createClass,
  createDiagram,
  createMethod,
  createRelation,
} from '@app/shared';

/**
 * Corpus de diagramas de referencia.
 *
 * Existe para que RNF-MAN-02 sea comprobable: cada diagrama cubre un camino de
 * mapeo distinto y el proyecto que produce debe compilar. Cuando aparezca un
 * caso de mapeo nuevo, se añade aquí antes de tocar el normalizador; si no, la
 * regresión no se detecta.
 */

function id(prefix: string, n: number): string {
  // Identificadores deterministas: las pruebas comparan salidas exactas y un
  // ULID aleatorio haría que dos ejecuciones no coincidan.
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** Comercio: uno-a-muchos, muchos-a-muchos, composición, enum y valor único. */
export function tiendaDiagram(): ClassDiagram {
  const cliente = createClass({
    id: id('C', 1),
    name: 'Cliente',
    attributes: [
      createAttribute({ id: id('A', 1), name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: id('A', 2), name: 'nombre', type: 'String', isNullable: false }),
      createAttribute({
        id: id('A', 3),
        name: 'email',
        type: 'String',
        isNullable: false,
        isUnique: true,
      }),
      createAttribute({ id: id('A', 4), name: 'fechaAlta', type: 'Date' }),
    ],
  });

  const pedido = createClass({
    id: id('C', 2),
    name: 'Pedido',
    attributes: [
      createAttribute({ id: id('A', 5), name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: id('A', 6), name: 'fecha', type: 'DateTime', isNullable: false }),
      createAttribute({ id: id('A', 7), name: 'total', type: 'Decimal', isNullable: false }),
      createAttribute({ id: id('A', 8), name: 'estado', type: 'EstadoPedido', isNullable: false }),
    ],
    // Operaciones de negocio en una clase normal: es lo que produce un diagrama
    // de comunicación importado, y hasta que no se cubrió aquí el generador las
    // descartaba sin decir nada. `confirmar` no devuelve nada y `calcularTotal`
    // devuelve un tipo de biblioteca, que son los dos casos de import distintos.
    methods: [
      createMethod({ id: id('M', 10), name: 'confirmar', returnType: null }),
      createMethod({
        id: id('M', 11),
        name: 'calcularTotal',
        returnType: { name: 'Decimal', collection: false },
      }),
    ],
  });

  const linea = createClass({
    id: id('C', 3),
    name: 'LineaPedido',
    attributes: [
      createAttribute({ id: id('A', 9), name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: id('A', 10), name: 'cantidad', type: 'Integer', isNullable: false }),
      createAttribute({
        id: id('A', 11),
        name: 'precioUnitario',
        type: 'Decimal',
        isNullable: false,
      }),
    ],
  });

  const producto = createClass({
    id: id('C', 4),
    name: 'Producto',
    attributes: [
      createAttribute({ id: id('A', 12), name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: id('A', 13), name: 'nombre', type: 'String', isNullable: false }),
      createAttribute({
        id: id('A', 14),
        name: 'sku',
        type: 'String',
        isNullable: false,
        isUnique: true,
      }),
      createAttribute({ id: id('A', 15), name: 'precio', type: 'Decimal', isNullable: false }),
      createAttribute({ id: id('A', 16), name: 'activo', type: 'Boolean', isNullable: false }),
    ],
  });

  const categoria = createClass({
    id: id('C', 5),
    name: 'Categoria',
    attributes: [
      createAttribute({ id: id('A', 17), name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: id('A', 18), name: 'nombre', type: 'String', isNullable: false }),
    ],
  });

  const estado = createClass({
    id: id('C', 6),
    name: 'EstadoPedido',
    kind: 'enum',
    literals: ['BORRADOR', 'CONFIRMADO', 'ENVIADO', 'ENTREGADO', 'CANCELADO'],
  });

  return createDiagram({
    id: 'D0001',
    name: 'Tienda',
    meta: {
      basePackage: 'com.ejemplo.tienda',
      artifactId: 'tienda',
      description: 'Modelo de comercio electrónico de referencia',
    },
    classes: Object.fromEntries(
      [cliente, pedido, linea, producto, categoria, estado].map((c) => [c.id, c]),
    ),
    relations: Object.fromEntries(
      [
        // Un cliente tiene muchos pedidos; un pedido tiene un cliente obligatorio.
        createRelation({
          id: id('R', 1),
          kind: 'association',
          sourceId: cliente.id,
          targetId: pedido.id,
          sourceMultiplicity: '1',
          targetMultiplicity: '*',
          targetRole: 'pedidos',
        }),
        // Composición: al borrar el pedido desaparecen sus líneas.
        createRelation({
          id: id('R', 2),
          kind: 'composition',
          sourceId: pedido.id,
          targetId: linea.id,
          sourceMultiplicity: '1',
          targetMultiplicity: '1..*',
          targetRole: 'lineas',
        }),
        // Cada línea referencia un producto.
        createRelation({
          id: id('R', 3),
          kind: 'association',
          sourceId: producto.id,
          targetId: linea.id,
          sourceMultiplicity: '1',
          targetMultiplicity: '*',
          targetRole: 'lineas',
        }),
        // Muchos a muchos con tabla de unión.
        createRelation({
          id: id('R', 4),
          kind: 'association',
          sourceId: producto.id,
          targetId: categoria.id,
          sourceMultiplicity: '*',
          targetMultiplicity: '*',
          targetRole: 'categorias',
          sourceRole: 'productos',
        }),
      ].map((r) => [r.id, r]),
    ),
  });
}

/** Herencia JOINED, interfaz realizada, uno-a-uno y auto-referencia. */
export function rrhhDiagram(): ClassDiagram {
  const persona = createClass({
    id: id('P', 1),
    name: 'Persona',
    kind: 'abstract',
    attributes: [
      createAttribute({ id: id('B', 1), name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: id('B', 2), name: 'nombre', type: 'String', isNullable: false }),
      createAttribute({
        id: id('B', 3),
        name: 'documento',
        type: 'String',
        isNullable: false,
        isUnique: true,
      }),
    ],
  });

  const empleado = createClass({
    id: id('P', 2),
    name: 'Empleado',
    attributes: [
      createAttribute({ id: id('B', 4), name: 'salario', type: 'Decimal', isNullable: false }),
      createAttribute({ id: id('B', 5), name: 'fechaIngreso', type: 'Date', isNullable: false }),
    ],
  });

  const cliente = createClass({
    id: id('P', 3),
    name: 'ClienteCorporativo',
    attributes: [createAttribute({ id: id('B', 6), name: 'razonSocial', type: 'String' })],
  });

  const departamento = createClass({
    id: id('P', 4),
    name: 'Departamento',
    attributes: [
      createAttribute({ id: id('B', 7), name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: id('B', 8), name: 'nombre', type: 'String', isNullable: false }),
    ],
  });

  const credencial = createClass({
    id: id('P', 5),
    name: 'Credencial',
    attributes: [
      createAttribute({ id: id('B', 9), name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: id('B', 10), name: 'usuario', type: 'String', isNullable: false }),
      createAttribute({ id: id('B', 11), name: 'hash', type: 'String', isNullable: false }),
    ],
  });

  const auditable = createClass({
    id: id('P', 6),
    name: 'Auditable',
    kind: 'interface',
    methods: [
      createMethod({
        id: id('M', 1),
        name: 'obtenerResumen',
        returnType: { name: 'String', collection: false },
      }),
    ],
  });

  return createDiagram({
    id: 'D0002',
    name: 'RecursosHumanos',
    meta: {
      basePackage: 'com.ejemplo.rrhh',
      artifactId: 'rrhh',
      description: 'Herencia, realización de interfaz y relaciones uno a uno',
    },
    classes: Object.fromEntries(
      [persona, empleado, cliente, departamento, credencial, auditable].map((c) => [c.id, c]),
    ),
    relations: Object.fromEntries(
      [
        createRelation({
          id: id('S', 1),
          kind: 'inheritance',
          sourceId: empleado.id,
          targetId: persona.id,
        }),
        createRelation({
          id: id('S', 2),
          kind: 'inheritance',
          sourceId: cliente.id,
          targetId: persona.id,
        }),
        createRelation({
          id: id('S', 3),
          kind: 'realization',
          sourceId: empleado.id,
          targetId: auditable.id,
        }),
        // Un departamento tiene muchos empleados.
        createRelation({
          id: id('S', 4),
          kind: 'association',
          sourceId: departamento.id,
          targetId: empleado.id,
          sourceMultiplicity: '1',
          targetMultiplicity: '*',
          targetRole: 'empleados',
        }),
        // Uno a uno obligatorio.
        createRelation({
          id: id('S', 5),
          kind: 'association',
          sourceId: empleado.id,
          targetId: credencial.id,
          sourceMultiplicity: '1',
          targetMultiplicity: '1',
          targetRole: 'credencial',
        }),
        // Auto-referencia: muchos empleados comparten un mismo responsable.
        createRelation({
          id: id('S', 6),
          kind: 'association',
          sourceId: empleado.id,
          targetId: empleado.id,
          sourceMultiplicity: '*',
          targetMultiplicity: '0..1',
          targetRole: 'responsable',
        }),
      ].map((r) => [r.id, r]),
    ),
  });
}

/** El diagrama mínimo que aún produce un proyecto ejecutable. */
export function minimoDiagram(): ClassDiagram {
  const nota = createClass({
    id: 'N0001',
    name: 'Nota',
    attributes: [
      createAttribute({ id: 'NA01', name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: 'NA02', name: 'texto', type: 'Text', isNullable: false }),
    ],
  });

  return createDiagram({
    id: 'D0003',
    name: 'Minimo',
    meta: {
      basePackage: 'com.ejemplo.minimo',
      artifactId: 'minimo',
      description: 'Una sola entidad, sin relaciones',
    },
    classes: { [nota.id]: nota },
  });
}

/**
 * Lo que la revisión del 2026-11-01 encontró sin cubrir: una entidad solo con
 * identificador, una herencia cuya raíz tiene una asociación obligatoria, una
 * asociación hacia una clase abstracta, y una N:M reflexiva junto a una corriente.
 */
export function mixtoDiagram(): ClassDiagram {
  const pk = (n: number) =>
    createAttribute({ id: id('X', n), name: 'id', type: 'Long', isIdentifier: true });
  const reporte = createClass({ id: id('M', 1), name: 'Reporte', attributes: [pk(1)] });
  const direccion = createClass({
    id: id('M', 2),
    name: 'Direccion',
    attributes: [pk(2), createAttribute({ id: id('X', 3), name: 'calle', type: 'String', isNullable: false })],
  });
  const persona = createClass({
    id: id('M', 3),
    name: 'Persona',
    kind: 'abstract',
    attributes: [pk(4), createAttribute({ id: id('X', 5), name: 'nombre', type: 'String', isNullable: false })],
  });
  const cliente = createClass({
    id: id('M', 4),
    name: 'Cliente',
    attributes: [createAttribute({ id: id('X', 6), name: 'telefono', type: 'String' })],
  });
  const articulo = createClass({
    id: id('M', 5),
    name: 'Articulo',
    attributes: [pk(7), createAttribute({ id: id('X', 8), name: 'titulo', type: 'String', isNullable: false })],
  });
  const pedido = createClass({
    id: id('M', 6),
    name: 'Pedido',
    attributes: [pk(9), createAttribute({ id: id('X', 10), name: 'total', type: 'Decimal', isNullable: false })],
  });

  return createDiagram({
    id: 'corpus-mixto',
    name: 'Mixto',
    meta: { basePackage: 'com.ejemplo.mixto', artifactId: 'mixto', description: 'Casos de la revisión' },
    classes: {
      [reporte.id]: reporte,
      [direccion.id]: direccion,
      [persona.id]: persona,
      [cliente.id]: cliente,
      [articulo.id]: articulo,
      [pedido.id]: pedido,
    },
    relations: Object.fromEntries(
      [
        createRelation({ id: id('T', 1), kind: 'inheritance', sourceId: cliente.id, targetId: persona.id }),
        createRelation({
          id: id('T', 2),
          kind: 'association',
          sourceId: persona.id,
          targetId: direccion.id,
          sourceMultiplicity: '*',
          targetMultiplicity: '1',
        }),
        createRelation({
          id: id('T', 3),
          kind: 'association',
          sourceId: pedido.id,
          targetId: cliente.id,
          sourceMultiplicity: '*',
          targetMultiplicity: '1',
        }),
        createRelation({
          id: id('T', 4),
          kind: 'association',
          sourceId: pedido.id,
          targetId: articulo.id,
          sourceMultiplicity: '*',
          targetMultiplicity: '*',
        }),
        createRelation({
          id: id('T', 6),
          kind: 'association',
          sourceId: articulo.id,
          targetId: persona.id,
          sourceMultiplicity: '*',
          targetMultiplicity: '0..1',
        }),
        createRelation({
          id: id('T', 5),
          kind: 'association',
          sourceId: articulo.id,
          targetId: articulo.id,
          sourceMultiplicity: '*',
          targetMultiplicity: '*',
        }),
      ].map((r) => [r.id, r]),
    ),
  });
}

export const CORPUS: { name: string; diagram: () => ClassDiagram }[] = [
  { name: 'tienda', diagram: tiendaDiagram },
  { name: 'rrhh', diagram: rrhhDiagram },
  { name: 'minimo', diagram: minimoDiagram },
  { name: 'mixto', diagram: mixtoDiagram },
];
