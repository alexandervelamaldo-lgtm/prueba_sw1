import { describe, expect, it } from 'vitest';
import {
  type ClassDiagram,
  createAttribute,
  createClass,
  createDiagram,
  createMethod,
  createRelation,
} from '@app/shared';
import { CORPUS, minimoDiagram, rrhhDiagram, tiendaDiagram } from './fixtures/corpus.js';
import { normalize } from './ir/normalize.js';
import { buildEntityView, generateProject } from './render/generate.js';
import { validateDiagram } from '@app/shared';
import { generate } from './index.js';
import type { GeneratedFile } from './ir/types.js';

function fileNamed(files: GeneratedFile[], suffix: string): GeneratedFile {
  const found = files.find((f) => f.path.endsWith(suffix));
  if (!found) {
    throw new Error(`No se generó ningún fichero que termine en ${suffix}`);
  }
  return found;
}

describe('validación previa', () => {
  it('acepta todo el corpus de referencia', () => {
    for (const entry of CORPUS) {
      const result = validateDiagram(entry.diagram());
      expect(result.errors, `${entry.name}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it('rechaza una entidad sin identificador', () => {
    const cls = createClass({
      id: 'X1',
      name: 'SinId',
      attributes: [createAttribute({ id: 'XA1', name: 'nombre', type: 'String' })],
    });
    const diagram = createDiagram({ id: 'DX', name: 'X', classes: { X1: cls } });

    const result = validateDiagram(diagram);
    expect(result.ok).toBe(false);
  });

  it('rechaza un nombre de clase que no es identificador Java', () => {
    const cls = createClass({
      id: 'X1',
      name: 'Usuario; DROP TABLE usuarios',
      attributes: [createAttribute({ id: 'XA1', name: 'id', type: 'Long', isIdentifier: true })],
    });
    const diagram = createDiagram({ id: 'DX', name: 'X', classes: { X1: cls } });

    const result = validateDiagram(diagram);
    expect(result.ok).toBe(false);
  });

  it('rechaza un ciclo de herencia', () => {
    const a = createClass({
      id: 'A',
      name: 'Alfa',
      attributes: [createAttribute({ id: 'AA', name: 'id', type: 'Long', isIdentifier: true })],
    });
    const b = createClass({ id: 'B', name: 'Beta' });
    const diagram = createDiagram({
      id: 'DC',
      name: 'Ciclo',
      classes: { A: a, B: b },
      relations: {
        R1: createRelation({ id: 'R1', kind: 'inheritance', sourceId: 'A', targetId: 'B' }),
        R2: createRelation({ id: 'R2', kind: 'inheritance', sourceId: 'B', targetId: 'A' }),
      },
    });

    expect(validateDiagram(diagram).ok).toBe(false);
  });
});

/*
 * La firma de un método es entrada no confiable igual que el nombre de una clase
 * (RNF-SEG-06), y además es el único punto del generador donde una cadena del
 * diagrama se interpola SIN escapar: `{{{signature}}}` en las plantillas
 * `interface`, `entity`, `service` y `service-impl`. Estas pruebas existen
 * porque durante un tiempo se validó el nombre del método pero no el resto de
 * la firma, y un parámetro con paréntesis y llaves salía como Java roto sin que
 * la validación dijera nada.
 */
describe('la firma del método es entrada no confiable', () => {
  const conMetodo = (metodo: ReturnType<typeof createMethod>) =>
    createDiagram({
      id: 'DF',
      name: 'Firma',
      meta: { basePackage: 'com.firma', artifactId: 'firma', description: 'Firma' },
      classes: {
        C1: createClass({
          id: 'C1',
          name: 'Factura',
          attributes: [createAttribute({ id: 'A1', name: 'id', type: 'Long', isIdentifier: true })],
          methods: [metodo],
        }),
      },
    });

  it('rechaza un parámetro que cerraría el método e inyectaría código', () => {
    const diagram = conMetodo(
      createMethod({
        id: 'M1',
        name: 'marcar',
        returnType: null,
        parameters: [
          { name: 'a) { } public static void danio(', type: { name: 'String', collection: false } },
        ],
      }),
    );

    const resultado = validateDiagram(diagram);
    expect(resultado.ok).toBe(false);
    expect(resultado.errors.map((e) => e.code)).toContain('INVALID_PARAMETER_NAME');
  });

  it('rechaza un tipo de retorno que no existe', () => {
    const diagram = conMetodo(
      createMethod({
        id: 'M2',
        name: 'obtener',
        returnType: { name: 'String { } public static void otro() { } String', collection: false },
        parameters: [],
      }),
    );

    const resultado = validateDiagram(diagram);
    expect(resultado.ok).toBe(false);
    expect(resultado.errors.map((e) => e.code)).toContain('UNKNOWN_RETURN_TYPE');
  });

  it('rechaza un tipo de parámetro que no existe', () => {
    const diagram = conMetodo(
      createMethod({
        id: 'M3',
        name: 'guardar',
        returnType: null,
        parameters: [{ name: 'dato', type: { name: 'NoExisteEsteTipo', collection: false } }],
      }),
    );

    const resultado = validateDiagram(diagram);
    expect(resultado.ok).toBe(false);
    expect(resultado.errors.map((e) => e.code)).toContain('UNKNOWN_PARAMETER_TYPE');
  });

  it('rechaza dos parámetros que colisionan al convertirse a Java', () => {
    // «fecha alta» y «fechaAlta» son distintos en el diagrama y el mismo
    // `fechaAlta` en Java: el proyecto generado no compilaría.
    const diagram = conMetodo(
      createMethod({
        id: 'M4',
        name: 'programar',
        returnType: null,
        parameters: [
          { name: 'fecha alta', type: { name: 'String', collection: false } },
          { name: 'fechaAlta', type: { name: 'String', collection: false } },
        ],
      }),
    );

    const resultado = validateDiagram(diagram);
    expect(resultado.ok).toBe(false);
    expect(resultado.errors.map((e) => e.code)).toContain('DUPLICATE_PARAMETER_NAME');
  });

  it('acepta una firma legítima, incluida la que necesita convertirse', () => {
    // La validación mira lo que se emite, no lo que se escribió: «fecha alta»
    // es un nombre razonable en un diagrama y produce un `fechaAlta` válido.
    const diagram = conMetodo(
      createMethod({
        id: 'M5',
        name: 'programar',
        returnType: { name: 'String', collection: false },
        parameters: [
          { name: 'fecha alta', type: { name: 'String', collection: false } },
          { name: 'importe', type: { name: 'Long', collection: false } },
        ],
      }),
    );

    const resultado = validateDiagram(diagram);
    expect(resultado.errors).toEqual([]);
    expect(resultado.ok).toBe(true);
  });

  it('nada hostil llega a la plantilla: el generador nunca ve la firma rota', () => {
    // La prueba de arriba comprueba que se rechaza; esta comprueba lo que
    // importa de verdad, que es que el Java emitido para una firma válida no
    // contiene estructura inyectada.
    const diagram = conMetodo(
      createMethod({
        id: 'M6',
        name: 'marcar',
        returnType: null,
        parameters: [{ name: 'estado', type: { name: 'String', collection: false } }],
      }),
    );

    expect(validateDiagram(diagram).ok).toBe(true);
    const servicio = fileNamed(
      generateProject(normalize(diagram)),
      'service/FacturaService.java',
    ).content;
    expect(servicio).toContain('void marcar(String estado);');
    expect(servicio).not.toMatch(/\{\s*\}\s*[Pp]ublic/);
  });
});

describe('normalización a IR', () => {
  const ir = normalize(tiendaDiagram());

  it('excluye los enums de las entidades', () => {
    expect(ir.entities.map((e) => e.className).sort()).toEqual([
      'Categoria',
      'Cliente',
      'LineaPedido',
      'Pedido',
      'Producto',
    ]);
    expect(ir.enums.map((e) => e.className)).toEqual(['EstadoPedido']);
  });

  it('pone la clave ajena en el lado «muchos»', () => {
    const pedido = ir.entities.find((e) => e.className === 'Pedido');
    const cliente = ir.entities.find((e) => e.className === 'Cliente');

    const haciaCliente = pedido?.associations.find((a) => a.targetClass === 'Cliente');
    expect(haciaCliente?.kind).toBe('ManyToOne');
    expect(haciaCliente?.owning).toBe(true);
    expect(haciaCliente?.joinColumn).toBe('cliente_id');

    const haciaPedidos = cliente?.associations.find((a) => a.targetClass === 'Pedido');
    expect(haciaPedidos?.kind).toBe('OneToMany');
    expect(haciaPedidos?.owning).toBe(false);
    expect(haciaPedidos?.mappedBy).toBe('cliente');
  });

  it('propaga el borrado solo en composición', () => {
    const pedido = ir.entities.find((e) => e.className === 'Pedido');
    const lineas = pedido?.associations.find((a) => a.fieldName === 'lineas');
    expect(lineas?.cascade).toBe('CascadeType.ALL');
    expect(lineas?.orphanRemoval).toBe(true);

    const cliente = ir.entities.find((e) => e.className === 'Cliente');
    const pedidos = cliente?.associations.find((a) => a.fieldName === 'pedidos');
    expect(pedidos?.cascade).toBeUndefined();
    expect(pedidos?.orphanRemoval).toBe(false);
  });

  it('la composición propaga el borrado también en la base de datos, no solo en JPA', () => {
    // Lo de arriba comprueba la cascada de JPA, que solo actúa si el borrado
    // pasa por el repositorio. La clave ajena es la otra mitad: sin ella, un
    // `DELETE FROM pedidos` desde psql choca contra la restricción y falla,
    // cuando la composición dice justo lo contrario —las líneas no sobreviven
    // a su pedido—. Peor aún, la cascada de JPA sí funcionaría, así que la
    // incoherencia solo aparece por el camino que nadie prueba.
    const lineas = ir.migration.tables.find((t) => t.name === 'linea_pedidos');
    const haciaPedido = lineas?.foreignKeys.find((f) => f.column === 'pedido_id');
    expect(haciaPedido?.onDelete).toBe('CASCADE');

    // Y la asociación normal de al lado sigue sin propagarlo: borrar un cliente
    // no puede llevarse por delante su historial de pedidos.
    const pedidos = ir.migration.tables.find((t) => t.name === 'pedidos');
    const haciaCliente = pedidos?.foreignKeys.find((f) => f.column === 'cliente_id');
    expect(haciaCliente?.onDelete).toBe('NO ACTION');

    // El arreglo de arriba se puede estropear de una forma concreta y cara:
    // marcando la cascada de JPA en el `@ManyToOne` de la parte para que la
    // clave ajena la vea. Eso invierte el sentido del borrado —quitar una
    // línea borraría su pedido, y con él las demás líneas—, así que se ata.
    const linea = ir.entities.find((e) => e.className === 'LineaPedido');
    const haciaSuPedido = linea?.associations.find((a) => a.fieldName === 'pedido');
    expect(haciaSuPedido?.kind).toBe('ManyToOne');
    expect(haciaSuPedido?.partOfComposition).toBe(true);
    expect(haciaSuPedido?.cascade).toBeUndefined();
    expect(haciaSuPedido?.orphanRemoval).toBe(false);
  });

  it('crea tabla de unión para el muchos a muchos', () => {
    const producto = ir.entities.find((e) => e.className === 'Producto');
    const categorias = producto?.associations.find((a) => a.kind === 'ManyToMany');
    expect(categorias?.owning).toBe(true);
    expect(categorias?.joinTable?.name).toBeTruthy();

    const joinTable = ir.migration.tables.find((t) => t.isJoinTable);
    expect(joinTable?.primaryKey).toHaveLength(2);
    expect(joinTable?.foreignKeys).toHaveLength(2);
  });

  it('ordena las tablas antes que las que las referencian', () => {
    const order = new Map(ir.migration.tables.map((t, index) => [t.name, index]));
    for (const table of ir.migration.tables) {
      for (const fk of table.foreignKeys) {
        const referenced = order.get(fk.referencesTable);
        if (referenced === undefined || fk.referencesTable === table.name) continue;
        expect(referenced).toBeLessThan(order.get(table.name) ?? -1);
      }
    }
  });

  it('usa BIGSERIAL en la raíz y BIGINT en la hija con herencia JOINED', () => {
    const rrhh = normalize(rrhhDiagram());
    const personas = rrhh.migration.tables.find((t) => t.name === 'personas');
    const empleados = rrhh.migration.tables.find((t) => t.name === 'empleados');

    expect(personas?.columns[0]?.type).toBe('BIGSERIAL');
    expect(empleados?.columns[0]?.type).toBe('BIGINT');
    expect(empleados?.foreignKeys.some((fk) => fk.referencesTable === 'personas')).toBe(true);
  });

  it('resuelve el identificador heredado', () => {
    const rrhh = normalize(rrhhDiagram());
    const empleado = rrhh.entities.find((e) => e.className === 'Empleado');
    expect(empleado?.superclass).toBe('Persona');
    expect(empleado?.identifier.name).toBe('id');
    expect(empleado?.implementsInterfaces).toEqual(['Auditable']);
  });

  it('resuelve la auto-referencia sin colisionar los dos extremos', () => {
    const rrhh = normalize(rrhhDiagram());
    const empleado = rrhh.entities.find((e) => e.className === 'Empleado');

    const responsable = empleado?.associations.find((a) => a.fieldName === 'responsable');
    expect(responsable?.kind).toBe('ManyToOne');
    expect(responsable?.owning).toBe(true);
    expect(responsable?.joinColumn).toBe('responsable_id');
    expect(responsable?.nullable).toBe(true);

    const subordinados = empleado?.associations.find((a) => a.fieldName === 'children');
    expect(subordinados?.kind).toBe('OneToMany');
    expect(subordinados?.mappedBy).toBe('responsable');
  });

  it('implementa los métodos de las interfaces realizadas', () => {
    const rrhh = normalize(rrhhDiagram());
    const empleado = rrhh.entities.find((e) => e.className === 'Empleado');
    expect(empleado).toBeDefined();
    if (!empleado) return;

    const view = buildEntityView(rrhh, empleado);
    expect(view.interfaceMethods.map((m) => m.signature)).toEqual(['String obtenerResumen()']);
  });
});

/*
 * Clase de asociación (UML): una clase colgada del punto medio de una
 * relación N:M, no de uno de sus extremos (RF de la notación de asociación
 * completa, distinta del patrón «clase intermedia» manual con dos 1:N que ya
 * cubre `tiendaDiagram` con LineaPedido). El caso de referencia es
 * Venta–Producto con DetalleVenta guardando `cantidad` y `subtotal`.
 */
describe('clase de asociación (UML)', () => {
  function ventaDiagram(): ClassDiagram {
    const venta = createClass({
      id: 'V1',
      name: 'Venta',
      attributes: [createAttribute({ id: 'VA1', name: 'id', type: 'Long', isIdentifier: true })],
    });
    const producto = createClass({
      id: 'V2',
      name: 'Producto',
      attributes: [createAttribute({ id: 'VA2', name: 'id', type: 'Long', isIdentifier: true })],
    });
    const detalle = createClass({
      id: 'V3',
      name: 'DetalleVenta',
      attributes: [
        createAttribute({ id: 'VA3', name: 'id', type: 'Long', isIdentifier: true }),
        createAttribute({ id: 'VA4', name: 'cantidad', type: 'Integer', isNullable: false }),
        createAttribute({ id: 'VA5', name: 'subtotal', type: 'Decimal', isNullable: false }),
      ],
    });

    return createDiagram({
      id: 'DVENTA',
      name: 'Ventas',
      meta: { basePackage: 'com.ejemplo.ventas', artifactId: 'ventas', description: '' },
      classes: { V1: venta, V2: producto, V3: detalle },
      relations: {
        R1: createRelation({
          id: 'R1',
          kind: 'association',
          sourceId: venta.id,
          targetId: producto.id,
          sourceMultiplicity: '*',
          targetMultiplicity: '*',
          associationClassId: detalle.id,
        }),
      },
    });
  }

  it('el diagrama de referencia es válido', () => {
    expect(validateDiagram(ventaDiagram()).ok).toBe(true);
  });

  it('la clase de asociación lleva los dos ManyToOne, no un ManyToMany sintético', () => {
    const ir = normalize(ventaDiagram());
    const detalle = ir.entities.find((e) => e.className === 'DetalleVenta');

    expect(detalle?.associations.some((a) => a.kind === 'ManyToMany')).toBe(false);

    const haciaVenta = detalle?.associations.find((a) => a.targetClass === 'Venta');
    expect(haciaVenta?.kind).toBe('ManyToOne');
    expect(haciaVenta?.owning).toBe(true);
    expect(haciaVenta?.joinColumn).toBe('venta_id');
    expect(haciaVenta?.nullable).toBe(false);

    const haciaProducto = detalle?.associations.find((a) => a.targetClass === 'Producto');
    expect(haciaProducto?.kind).toBe('ManyToOne');
    expect(haciaProducto?.owning).toBe(true);
    expect(haciaProducto?.joinColumn).toBe('producto_id');
    expect(haciaProducto?.nullable).toBe(false);

    // No se fabrica ninguna tabla de unión sintética: DetalleVenta ya es la
    // tabla de unión, con sus propias columnas cantidad/subtotal.
    expect(ir.migration.tables.some((t) => t.isJoinTable)).toBe(false);
  });

  it('la tabla de la clase de asociación lleva las dos claves ajenas obligatorias', () => {
    const ir = normalize(ventaDiagram());
    const tabla = ir.migration.tables.find((t) => t.name === 'detalle_ventas');
    expect(tabla).toBeDefined();

    const columnas = tabla?.columns.map((c) => c.name) ?? [];
    expect(columnas).toEqual(expect.arrayContaining(['venta_id', 'producto_id', 'cantidad', 'subtotal']));

    const haciaVenta = tabla?.foreignKeys.find((fk) => fk.column === 'venta_id');
    expect(haciaVenta?.referencesTable).toBe('ventas');
    // Obligatoria (no nullable): borrar la venta con detalles pendientes lo
    // bloquea la base de datos en vez de dejar un detalle huérfano.
    expect(haciaVenta?.onDelete).toBe('NO ACTION');

    const haciaProducto = tabla?.foreignKeys.find((fk) => fk.column === 'producto_id');
    expect(haciaProducto?.referencesTable).toBe('productos');
    expect(haciaProducto?.onDelete).toBe('NO ACTION');
  });

  it('expone la colección inversa en los dos extremos cuando son navegables', () => {
    const ir = normalize(ventaDiagram());

    const venta = ir.entities.find((e) => e.className === 'Venta');
    const detallesDeVenta = venta?.associations.find((a) => a.targetClass === 'DetalleVenta');
    expect(detallesDeVenta?.kind).toBe('OneToMany');
    expect(detallesDeVenta?.owning).toBe(false);
    expect(detallesDeVenta?.mappedBy).toBe('venta');

    const producto = ir.entities.find((e) => e.className === 'Producto');
    const detallesDeProducto = producto?.associations.find((a) => a.targetClass === 'DetalleVenta');
    expect(detallesDeProducto?.kind).toBe('OneToMany');
    expect(detallesDeProducto?.mappedBy).toBe('producto');
  });

  it('cae al ManyToMany sintético si la clase de asociación referenciada no existe', () => {
    // Estado transitorio (p. ej. justo tras borrar la clase, antes de que la
    // limpieza del CRDT llegue): el generador no debe reventar, solo tratarlo
    // como si nunca hubiera habido clase de asociación.
    const diagram = ventaDiagram();
    diagram.relations.R1!.associationClassId = 'no-existe';

    const ir = normalize(diagram);
    const venta = ir.entities.find((e) => e.className === 'Venta');
    const productos = venta?.associations.find((a) => a.kind === 'ManyToMany');
    expect(productos?.joinTable).toBeDefined();
  });
});

describe('generación de ficheros', () => {
  const ir = normalize(tiendaDiagram());
  const files = generateProject(ir);

  it('produce las cuatro capas de cada entidad', () => {
    for (const layer of [
      'domain/Pedido.java',
      'repository/PedidoRepository.java',
      'service/PedidoService.java',
      'service/impl/PedidoServiceImpl.java',
      'controller/PedidoController.java',
      'dto/PedidoRequest.java',
      'dto/PedidoResponse.java',
      'dto/mapper/PedidoMapper.java',
    ]) {
      expect(files.some((f) => f.path.endsWith(layer)), layer).toBe(true);
    }
  });

  it('coloca las fuentes bajo la ruta del paquete base', () => {
    const entity = fileNamed(files, 'domain/Pedido.java');
    expect(entity.path).toBe('src/main/java/com/ejemplo/tienda/domain/Pedido.java');
    expect(entity.content).toContain('package com.ejemplo.tienda.domain;');
  });

  it('no genera rutas duplicadas ni de escape', () => {
    const paths = files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((p) => !p.includes('..'))).toBe(true);
  });

  it('anota la entidad con la cardinalidad correcta', () => {
    const pedido = fileNamed(files, 'domain/Pedido.java').content;
    expect(pedido).toContain('@ManyToOne(fetch = FetchType.LAZY)');
    expect(pedido).toContain('@JoinColumn(name = "cliente_id", nullable = false)');
    expect(pedido).toContain('@OneToMany(mappedBy = "pedido"');
    expect(pedido).toContain('cascade = CascadeType.ALL');
    expect(pedido).toContain('orphanRemoval = true');
  });

  it('mapea el enum con @Enumerated(EnumType.STRING)', () => {
    const pedido = fileNamed(files, 'domain/Pedido.java').content;
    expect(pedido).toContain('@Enumerated(EnumType.STRING)');
    expect(pedido).toContain('private EstadoPedido estado;');

    const enumFile = fileNamed(files, 'domain/EstadoPedido.java').content;
    expect(enumFile).toContain('public enum EstadoPedido');
    expect(enumFile).toContain('CONFIRMADO,');
  });

  it('expone las asociaciones como identificadores en los DTO', () => {
    const request = fileNamed(files, 'dto/PedidoRequest.java').content;
    expect(request).toContain('Long clienteId');
    expect(request).toContain('@NotNull');
    expect(request).not.toContain('Cliente cliente');

    const response = fileNamed(files, 'dto/PedidoResponse.java').content;
    expect(response).toContain('Long id');
    expect(response).toContain('Long clienteId');
  });

  it('importa en el DTO el enum del paquete domain', () => {
    const request = fileNamed(files, 'dto/PedidoRequest.java').content;
    expect(request).toContain('import com.ejemplo.tienda.domain.EstadoPedido;');
  });

  it('inyecta en el mapeador el repositorio de cada asociación a-uno', () => {
    const mapper = fileNamed(files, 'dto/mapper/PedidoMapper.java').content;
    expect(mapper).toContain('private final ClienteRepository clienteRepository;');
    expect(mapper).toContain('clienteRepository.findById(request.clienteId())');
    expect(mapper).toContain('ResourceNotFoundException');
  });

  it('genera consultas derivadas solo para los campos únicos', () => {
    const repo = fileNamed(files, 'repository/ClienteRepository.java').content;
    expect(repo).toContain('Optional<Cliente> findByEmail(String email);');
    expect(repo).toContain('boolean existsByEmail(String email);');
    expect(repo).not.toContain('findByNombre');
  });

  it('no importa en el repositorio tipos que el repositorio no nombra', () => {
    // El repositorio de Pedido solo declara `JpaRepository<Pedido, Long>`: los
    // tipos de los atributos (`BigDecimal`, `LocalDateTime`, `Set`) viven en la
    // entidad y aquí sobran. Importarlos compila, pero deja media docena de
    // imports muertos en cada uno de los ficheros generados.
    const repo = fileNamed(files, 'repository/PedidoRepository.java').content;
    expect(repo).not.toContain('import java.math.BigDecimal;');
    expect(repo).not.toContain('import java.util.Set;');
    expect(repo).toContain('import com.ejemplo.tienda.domain.Pedido;');
  });

  it('conserva en el repositorio el import que sí necesita una consulta derivada', () => {
    // El contraejemplo del test anterior: `findByEmail` devuelve un `Optional`,
    // y si el campo único tuviera un tipo con import haría falta traerlo.
    const repo = fileNamed(files, 'repository/ClienteRepository.java').content;
    expect(repo).toContain('import java.util.Optional;');
  });

  it('emite la migración con claves primarias y ajenas', () => {
    const sql = fileNamed(files, '__esquema_inicial.sql').content;
    expect(sql).toContain('CREATE TABLE clientes (');
    expect(sql).toContain('id BIGSERIAL NOT NULL');
    expect(sql).toContain('PRIMARY KEY (id)');
    expect(sql).toContain('FOREIGN KEY (cliente_id) REFERENCES clientes (id)');
    expect(sql).toContain('email VARCHAR(255) NOT NULL UNIQUE');
  });

  it('configura Flyway y deja Hibernate en validate', () => {
    const yml = fileNamed(files, 'application.yml').content;
    expect(yml).toContain('ddl-auto: validate');
    expect(yml).toContain('locations: classpath:db/migration');
  });

  it('no deja marcadores de plantilla sin sustituir', () => {
    // postman_collection.json no pasa por `render()`: su `{{baseUrl}}` es la
    // sintaxis de variable de Postman, no un marcador de Handlebars a medio
    // sustituir.
    for (const file of files.filter((f) => f.path !== 'postman_collection.json')) {
      expect(file.content, file.path).not.toContain('{{');
      expect(file.content, file.path).not.toContain('undefined');
    }
  });

  it('termina cada fichero con exactamente un salto de línea', () => {
    for (const file of files) {
      expect(file.content.endsWith('\n'), file.path).toBe(true);
      expect(file.content.endsWith('\n\n'), file.path).toBe(false);
      expect(file.content.includes('\r'), file.path).toBe(false);
    }
  });
});

describe('colección Postman', () => {
  const ir = normalize(tiendaDiagram());
  const files = generateProject(ir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collection = JSON.parse(fileNamed(files, 'postman_collection.json').content) as any;

  it('es JSON válido con el esquema de colección v2.1', () => {
    expect(collection.info.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    );
    expect(collection.variable).toContainEqual({
      key: 'baseUrl',
      value: 'http://localhost:8080',
      type: 'string',
    });
  });

  it('trae una carpeta con las 5 peticiones por cada entidad concreta', () => {
    const nombres = ir.entities.filter((e) => !e.isAbstract).map((e) => e.className);
    expect(collection.item.map((f: { name: string }) => f.name).sort()).toEqual(
      [...nombres].sort(),
    );

    const pedido = collection.item.find((f: { name: string }) => f.name === 'Pedido');
    expect(pedido.item.map((r: { name: string }) => r.name)).toEqual([
      'Listar Pedido',
      'Buscar Pedido por id',
      'Crear Pedido',
      'Actualizar Pedido',
      'Eliminar Pedido',
    ]);
  });

  it('usa las rutas REST reales y un cuerpo de ejemplo que pasa las validaciones', () => {
    const pedido = collection.item.find((f: { name: string }) => f.name === 'Pedido');
    const crear = pedido.item.find((r: { name: string }) => r.name === 'Crear Pedido');

    expect(crear.request.method).toBe('POST');
    expect(crear.request.url.raw).toBe('{{baseUrl}}/api/pedidos');
    expect(crear.request.header).toContainEqual({
      key: 'Content-Type',
      value: 'application/json',
    });

    const body = JSON.parse(crear.request.body.raw);
    // El enumerado usa su primer valor y no `null`: un `null` no pasaría el
    // `@NotNull` que `dto-request.java.hbs` pone en un campo obligatorio.
    expect(body.estado).toBe('BORRADOR');
    expect(typeof body.total).toBe('number');
    expect(body.clienteId).toBe(1);

    const listar = pedido.item.find((r: { name: string }) => r.name === 'Listar Pedido');
    expect(listar.request.url.raw).toBe('{{baseUrl}}/api/pedidos?page=0&size=20');

    const eliminar = pedido.item.find((r: { name: string }) => r.name === 'Eliminar Pedido');
    expect(eliminar.request.url.raw).toBe('{{baseUrl}}/api/pedidos/1');
    expect(eliminar.request.body).toBeUndefined();
  });

  it('no incluye carpeta para las entidades abstractas', () => {
    const rrhh = normalize(rrhhDiagram());
    const rrhhFiles = generateProject(rrhh);
    const rrhhCollection = JSON.parse(
      fileNamed(rrhhFiles, 'postman_collection.json').content,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;

    const nombres = rrhhCollection.item.map((f: { name: string }) => f.name);
    expect(nombres).not.toContain('Persona');
    expect(nombres).toContain('Empleado');
  });
});

describe('herencia y clases abstractas', () => {
  const files = generateProject(normalize(rrhhDiagram()));

  it('extiende la superclase y reutiliza su clave primaria', () => {
    const empleado = fileNamed(files, 'domain/Empleado.java').content;
    expect(empleado).toContain('public class Empleado extends Persona implements Auditable');
    expect(empleado).toContain('@PrimaryKeyJoinColumn(name = "id")');
    expect(empleado).not.toContain('@GeneratedValue');
  });

  it('marca la raíz de la jerarquía con @Inheritance', () => {
    const persona = fileNamed(files, 'domain/Persona.java').content;
    expect(persona).toContain('@Inheritance(strategy = InheritanceType.JOINED)');
    expect(persona).toContain('public abstract class Persona');
    expect(persona).toContain('@GeneratedValue');
  });

  it('no expone CRUD para una entidad abstracta', () => {
    expect(files.some((f) => f.path.endsWith('controller/PersonaController.java'))).toBe(false);
    expect(files.some((f) => f.path.endsWith('domain/Persona.java'))).toBe(true);
    expect(files.some((f) => f.path.endsWith('controller/EmpleadoController.java'))).toBe(true);
  });

  it('incluye los campos heredados en el DTO de la subclase', () => {
    const request = fileNamed(files, 'dto/EmpleadoRequest.java').content;
    expect(request).toContain('String nombre');
    expect(request).toContain('String documento');
    expect(request).toContain('BigDecimal salario');
  });

  it('genera la interfaz realizada y su esqueleto en la entidad', () => {
    const contract = fileNamed(files, 'domain/Auditable.java').content;
    expect(contract).toContain('public interface Auditable');
    expect(contract).toContain('String obtenerResumen();');

    // Sin el esqueleto, «implements Auditable» no compilaría.
    const empleado = fileNamed(files, 'domain/Empleado.java').content;
    expect(empleado).toContain('public String obtenerResumen() {');
    expect(empleado).toContain('throw new UnsupportedOperationException(');
  });
});

describe('datos iniciales importados de una foto', () => {
  /** Diagrama de una entidad con filas de ejemplo, como lo deja la importación. */
  function conDatos(seedRows: Record<string, string>[], identificadorGenerado = true) {
    const empleado = createClass({
      id: 'E0001',
      name: 'Empleado',
      attributes: [
        createAttribute({
          id: 'EA01',
          name: 'id',
          type: identificadorGenerado ? 'Long' : 'String',
          isIdentifier: true,
        }),
        createAttribute({ id: 'EA02', name: 'nombre', type: 'String' }),
        createAttribute({ id: 'EA03', name: 'salario', type: 'Double' }),
        createAttribute({ id: 'EA04', name: 'activo', type: 'Boolean' }),
      ],
      seedRows,
    });

    return createDiagram({
      id: 'DS01',
      name: 'ConDatos',
      meta: {
        basePackage: 'com.ejemplo.datos',
        artifactId: 'datos',
        description: 'Una entidad con filas importadas',
      },
      classes: { [empleado.id]: empleado },
    });
  }

  it('no genera migración de datos si ninguna clase trae filas', () => {
    const outcome = generate(minimoDiagram());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.files.some((f) => f.path.includes('V2__datos_iniciales.sql'))).toBe(false);
  });

  it('emite los INSERT en una migración aparte de la del esquema', () => {
    const outcome = generate(conDatos([{ id: '1', nombre: 'Ana', salario: '2500.50' }]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const sql = fileNamed(outcome.files, 'V2__datos_iniciales.sql').content;
    expect(sql).toContain('INSERT INTO empleado');
    expect(sql).toContain("'Ana'");
    // El esquema no se toca: reescribir V1 rompería el checksum de Flyway en
    // cualquier base de datos donde ya se hubiera aplicado.
    expect(fileNamed(outcome.files, 'V1__esquema_inicial.sql').content).not.toContain('INSERT');
  });

  it('deja fuera del INSERT la columna que ninguna fila rellena', () => {
    const outcome = generate(conDatos([{ id: '1', nombre: 'Ana' }]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const sql = fileNamed(outcome.files, 'V2__datos_iniciales.sql').content;
    expect(sql).toContain('nombre');
    // `activo` se queda con su valor por defecto en lugar de recibir un NULL.
    expect(sql).not.toContain('activo');
  });

  it('pone NULL donde la fila no trae valor, sin desplazar las demás', () => {
    const outcome = generate(
      conDatos([
        { id: '1', nombre: 'Ana', salario: '2500.50' },
        { id: '2', salario: '1800' },
      ]),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const sql = fileNamed(outcome.files, 'V2__datos_iniciales.sql').content;
    expect(sql).toContain("('2', NULL, '1800')");
  });

  it('escapa la comilla simple doblándola, no eliminándola', () => {
    const outcome = generate(conDatos([{ id: '1', nombre: "O'Brien" }]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const sql = fileNamed(outcome.files, 'V2__datos_iniciales.sql').content;
    expect(sql).toContain("'O''Brien'");
  });

  it('neutraliza un intento de inyección escrito en una celda', () => {
    // La celda viene de un modelo mirando una foto: es la entrada menos
    // confiable del sistema y aun así acaba dentro de un fichero SQL.
    const outcome = generate(conDatos([{ id: '1', nombre: "x'); DROP TABLE empleado; --" }]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const sql = fileNamed(outcome.files, 'V2__datos_iniciales.sql').content;
    // El DROP sigue ahí, pero como texto dentro del literal: la comilla que lo
    // habría cerrado está doblada.
    expect(sql).toContain("'x''); DROP TABLE empleado; --'");
    expect(sql).not.toContain("'x'); DROP");
    // Y el literal queda equilibrado: un número impar de comillas significaría
    // que algo escapó del valor.
    expect((sql.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it('reajusta la secuencia cuando las filas traen el id explícito', () => {
    const outcome = generate(conDatos([{ id: '7', nombre: 'Ana' }]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const sql = fileNamed(outcome.files, 'V2__datos_iniciales.sql').content;
    // Sin esto, el primer alta desde la aplicación reutilizaría el id 1 y
    // chocaría con la fila importada.
    expect(sql).toContain('setval');
    expect(sql).toContain('pg_get_serial_sequence');
  });

  it('no toca ninguna secuencia si la clave no es autoincremental', () => {
    const outcome = generate(conDatos([{ id: 'A1', nombre: 'Ana' }], false));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(fileNamed(outcome.files, 'V2__datos_iniciales.sql').content).not.toContain('setval');
  });

  it('rechaza un byte nulo en lugar de generar un SQL que no arranca', () => {
    expect(() => generate(conDatos([{ id: '1', nombre: 'A\0B' }]))).toThrow(/nulo/);
  });
});

describe('caso mínimo', () => {
  it('genera un proyecto completo con una sola entidad', () => {
    const outcome = generate(minimoDiagram());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const paths = outcome.files.map((f) => f.path);
    expect(paths).toContain('pom.xml');
    expect(paths).toContain('docker-compose.yml');
    expect(paths).toContain('src/main/java/com/ejemplo/minimo/Application.java');

    const mapper = fileNamed(outcome.files, 'dto/mapper/NotaMapper.java').content;
    expect(mapper).toContain('public NotaMapper() {');
  });
});

// ---------------------------------------------------------------------------

/**
 * Las operaciones que se dibujan en una clase.
 *
 * Importa más desde que se importan diagramas de comunicación: de ahí salen
 * métodos sobre clases normales, y antes el generador los tiraba en silencio.
 */
describe('métodos del diagrama en la capa de servicio', () => {
  const files = generateProject(normalize(tiendaDiagram()));
  const contrato = fileNamed(files, 'service/PedidoService.java').content;
  const implementacion = fileNamed(files, 'service/impl/PedidoServiceImpl.java').content;

  /** Diagrama de una sola clase con los métodos que se le pasen. */
  function conMetodos(metodos: ReturnType<typeof createMethod>[]) {
    const cls = createClass({
      id: 'MC1',
      name: 'Factura',
      attributes: [
        createAttribute({ id: 'MA1', name: 'id', type: 'Long', isIdentifier: true }),
        createAttribute({ id: 'MA2', name: 'numero', type: 'String' }),
      ],
      methods: metodos,
    });
    return createDiagram({
      id: 'DM',
      name: 'Metodos',
      meta: { basePackage: 'com.ejemplo.m', artifactId: 'm', description: 'Metodos' },
      classes: { MC1: cls },
    });
  }

  const servicioDe = (diagrama: ReturnType<typeof conMetodos>): string =>
    fileNamed(generateProject(normalize(diagrama)), 'service/FacturaService.java').content;

  it('declara la operación en el contrato del servicio', () => {
    expect(contrato).toContain('void confirmar();');
    expect(contrato).toContain('BigDecimal calcularTotal();');
  });

  it('la implementación lanza en vez de devolver un valor inventado', () => {
    // Un `return null` compilaría y reventaría más tarde, lejos de la causa.
    expect(implementacion).toContain('public void confirmar() {');
    expect(implementacion).toContain('throw new UnsupportedOperationException(');
    expect(implementacion).not.toContain('return null;');
  });

  it('cada operación lleva @Override: si el contrato cambia, deja de compilar', () => {
    const cuerpo = implementacion.slice(implementacion.indexOf('// Operaciones del diagrama.'));
    expect((cuerpo.match(/@Override/g) ?? []).length).toBe(2);
  });

  it('la operación no se convierte en un endpoint', () => {
    // El diagrama no dice ni el verbo HTTP ni la ruta: inventarlos sería peor
    // que no publicarla.
    const controlador = fileNamed(files, 'controller/PedidoController.java').content;
    expect(controlador).not.toContain('confirmar');
    expect(controlador).not.toContain('calcularTotal');
  });

  it('la operación no ensucia la entidad, que es un artefacto de persistencia', () => {
    const entidad = fileNamed(files, 'domain/Pedido.java').content;
    expect(entidad).not.toContain('confirmar');
    expect(entidad).not.toContain('UnsupportedOperationException');
  });

  it('importa el tipo de biblioteca que la firma necesita, en las dos capas', () => {
    // Sin esto `BigDecimal` no resuelve y el proyecto no compila.
    expect(contrato).toContain('import java.math.BigDecimal;');
    expect(implementacion).toContain('import java.math.BigDecimal;');
  });

  it('una colección en la firma se traduce a List y se importa', () => {
    const servicio = servicioDe(
      conMetodos([
        createMethod({
          id: 'MM1',
          name: 'buscarPendientes',
          returnType: { name: 'String', collection: true },
        }),
      ]),
    );
    expect(servicio).toContain('List<String> buscarPendientes();');
    expect(servicio).toContain('import java.util.List;');
  });

  it('importa del dominio los tipos del propio diagrama', () => {
    // Un enum del diagrama vive en `domain` y la firma está en `service`: sin
    // import no compila. Es el fallo que no se ve leyendo solo la plantilla,
    // porque la plantilla no sabe qué tipos son del diagrama y cuáles de Java.
    const factura = createClass({
      id: 'MC1',
      name: 'Factura',
      attributes: [createAttribute({ id: 'MA1', name: 'id', type: 'Long', isIdentifier: true })],
      methods: [
        createMethod({
          id: 'MM8',
          name: 'marcarComo',
          returnType: null,
          parameters: [{ name: 'estado', type: { name: 'EstadoFactura', collection: false } }],
        }),
      ],
    });
    const estado = createClass({
      id: 'MC2',
      name: 'EstadoFactura',
      kind: 'enum',
      literals: ['EMITIDA', 'PAGADA'],
    });
    const generados = generateProject(
      normalize(
        createDiagram({
          id: 'DM2',
          name: 'Metodos',
          meta: { basePackage: 'com.ejemplo.m', artifactId: 'm', description: 'Metodos' },
          classes: { MC1: factura, MC2: estado },
        }),
      ),
    );

    const servicio = fileNamed(generados, 'service/FacturaService.java').content;
    expect(servicio).toContain('void marcarComo(EstadoFactura estado);');
    expect(servicio).toContain('import com.ejemplo.m.domain.EstadoFactura;');
    expect(fileNamed(generados, 'service/impl/FacturaServiceImpl.java').content).toContain(
      'import com.ejemplo.m.domain.EstadoFactura;',
    );
  });

  it('un método que devuelve su propia clase la importa solo en el contrato', () => {
    // La implementación ya importa la entidad para el CRUD: repetirlo no
    // compila. Es una duplicación que solo aparece con este caso.
    const diagrama = conMetodos([
      createMethod({
        id: 'MM2',
        name: 'duplicar',
        returnType: { name: 'Factura', collection: false },
      }),
    ]);
    const generados = generateProject(normalize(diagrama));
    const servicio = fileNamed(generados, 'service/FacturaService.java').content;
    const impl = fileNamed(generados, 'service/impl/FacturaServiceImpl.java').content;

    expect(servicio).toContain('import com.ejemplo.m.domain.Factura;');
    expect((impl.match(/import com\.ejemplo\.m\.domain\.Factura;/g) ?? []).length).toBe(1);
  });

  it('descarta el método privado: un contrato solo declara lo llamable', () => {
    const diagrama = conMetodos([
      createMethod({ id: 'MM3', name: 'recalcularIva', returnType: null, visibility: '-' }),
    ]);
    expect(servicioDe(diagrama)).not.toContain('recalcularIva');

    const avisos = validateDiagram(diagrama).warnings;
    expect(avisos.some((a) => a.code === 'METHOD_NOT_PUBLIC')).toBe(true);
  });

  it('descarta el método que chocaría con el CRUD generado', () => {
    // Dos `create` en la misma interfaz no compilan. Se conserva el generado,
    // que además está implementado.
    const diagrama = conMetodos([
      createMethod({ id: 'MM4', name: 'create', returnType: null }),
    ]);
    const servicio = servicioDe(diagrama);
    expect((servicio.match(/create\(/g) ?? []).length).toBe(1);

    const avisos = validateDiagram(diagrama).warnings;
    expect(avisos.some((a) => a.code === 'METHOD_CLASHES_WITH_CRUD')).toBe(true);
  });

  it('descarta el accesor que el atributo ya genera', () => {
    const diagrama = conMetodos([
      createMethod({
        id: 'MM5',
        name: 'getNumero',
        returnType: { name: 'String', collection: false },
      }),
    ]);
    expect(servicioDe(diagrama)).not.toContain('getNumero');

    const avisos = validateDiagram(diagrama).warnings;
    expect(avisos.some((a) => a.code === 'METHOD_IS_ACCESSOR')).toBe(true);
  });

  it('no declara dos veces la misma firma', () => {
    // Java admite sobrecarga, pero dos métodos idénticos no compilan. Pasa al
    // importar dos veces el mismo diagrama de comunicación.
    const diagrama = conMetodos([
      createMethod({ id: 'MM6', name: 'anular', returnType: null }),
      createMethod({ id: 'MM7', name: 'anular', returnType: null }),
    ]);
    expect((servicioDe(diagrama).match(/void anular\(\);/g) ?? []).length).toBe(1);
  });

  it('una clase sin métodos no deja rastro de la sección', () => {
    const servicio = fileNamed(files, 'service/ClienteService.java').content;
    expect(servicio).not.toContain('Operaciones declaradas en el diagrama');
  });

  it('el método de una interfaz sigue yendo a la interfaz, no al servicio', () => {
    // La interfaz es un contrato de dominio: ahí los métodos se emiten enteros.
    const rrhh = generateProject(normalize(rrhhDiagram()));
    expect(fileNamed(rrhh, 'domain/Auditable.java').content).toContain('String obtenerResumen();');
  });
});

describe('generación con MongoDB', () => {
  const ir = normalize(tiendaDiagram(), { databaseTarget: 'mongodb' });
  const files = generateProject(ir);

  it('usa el starter de Mongo en el pom y no el de JPA/Flyway', () => {
    const pom = fileNamed(files, 'pom.xml').content;
    expect(pom).toContain('spring-boot-starter-data-mongodb');
    expect(pom).not.toContain('spring-boot-starter-data-jpa');
    expect(pom).not.toContain('flyway');
  });

  it('no emite migraciones ni datos semilla en SQL', () => {
    expect(files.some((f) => f.path.includes('db/migration'))).toBe(false);
    expect(files.some((f) => f.path.endsWith('.sql'))).toBe(false);
  });

  it('configura Mongo en application.yml y docker-compose.yml', () => {
    const yml = fileNamed(files, 'application.yml').content;
    expect(yml).toContain('mongodb:');
    expect(yml).toContain('uri: mongodb://');

    const compose = fileNamed(files, 'docker-compose.yml').content;
    expect(compose).toContain('image: mongo:');
  });

  it('declara la entidad como @Document, no @Entity', () => {
    const pedido = fileNamed(files, 'domain/Pedido.java').content;
    expect(pedido).toContain('@Document(collection = "pedidos")');
    expect(pedido).not.toContain('@Entity');
    expect(pedido).not.toContain('@ManyToOne');
    expect(pedido).not.toContain('@OneToMany');
  });

  it('guarda las asociaciones a-uno como identificador plano', () => {
    const pedido = fileNamed(files, 'domain/Pedido.java').content;
    expect(pedido).toContain('private String clienteId;');
    expect(pedido).toContain('public String getClienteId()');
    expect(pedido).not.toContain('private Cliente cliente;');

    const request = fileNamed(files, 'dto/PedidoRequest.java').content;
    expect(request).toContain('String clienteId');
  });

  it('usa MongoRepository en lugar de JpaRepository', () => {
    const repo = fileNamed(files, 'repository/PedidoRepository.java').content;
    expect(repo).toContain('extends MongoRepository<Pedido, String>');
  });

  it('no usa @Transactional sin un gestor de transacciones de Mongo configurado', () => {
    const impl = fileNamed(files, 'service/impl/PedidoServiceImpl.java').content;
    // La anotación real está en una línea propia; el comentario explicativo
    // la menciona entre comillas, así que una búsqueda de subcadena simple
    // marcaría ese comentario como un falso positivo.
    expect(impl).not.toMatch(/^\s*@Transactional\s*$/m);
    expect(impl).not.toContain('import org.springframework.transaction.annotation.Transactional;');
  });

  it('no deja marcadores de plantilla sin sustituir', () => {
    for (const file of files.filter((f) => f.path !== 'postman_collection.json')) {
      expect(file.content, file.path).not.toContain('{{');
      expect(file.content, file.path).not.toContain('undefined');
    }
  });

  it('no genera documento ni CRUD para una superclase abstracta', () => {
    const rrhhFiles = generateProject(normalize(rrhhDiagram(), { databaseTarget: 'mongodb' }));
    expect(rrhhFiles.some((f) => f.path.endsWith('domain/Persona.java'))).toBe(false);
    expect(rrhhFiles.some((f) => f.path.endsWith('controller/PersonaController.java'))).toBe(
      false,
    );
    expect(rrhhFiles.some((f) => f.path.endsWith('domain/Empleado.java'))).toBe(true);

    const empleado = fileNamed(rrhhFiles, 'domain/Empleado.java').content;
    // Herencia aplanada: sin `extends`, los campos de Persona viven aquí.
    expect(empleado).not.toContain('extends Persona');
    expect(empleado).toContain('private String nombre;');
    expect(empleado).toContain('private String documento;');
  });
});

describe('generación con Cassandra', () => {
  const ir = normalize(tiendaDiagram(), { databaseTarget: 'cassandra' });
  const files = generateProject(ir);

  it('usa el starter de Cassandra en el pom y no el de JPA/Flyway/Mongo', () => {
    const pom = fileNamed(files, 'pom.xml').content;
    expect(pom).toContain('spring-boot-starter-data-cassandra');
    expect(pom).not.toContain('spring-boot-starter-data-jpa');
    expect(pom).not.toContain('spring-boot-starter-data-mongodb');
    expect(pom).not.toContain('flyway');
  });

  it('no emite migraciones ni datos semilla en SQL', () => {
    expect(files.some((f) => f.path.includes('db/migration'))).toBe(false);
    expect(files.some((f) => f.path.endsWith('.sql'))).toBe(false);
  });

  it('configura Cassandra en application.yml y un keyspace en docker-compose.yml', () => {
    const yml = fileNamed(files, 'application.yml').content;
    expect(yml).toContain('cassandra:');
    expect(yml).toContain('schema-action: create-if-not-exists');

    const compose = fileNamed(files, 'docker-compose.yml').content;
    expect(compose).toContain('image: cassandra:');
    // La imagen oficial no crea el keyspace sola: hace falta el servicio aparte.
    expect(compose).toContain('db-init');
    expect(compose).toContain('CREATE KEYSPACE IF NOT EXISTS');
  });

  it('declara la entidad como @Table/@PrimaryKey, no @Entity ni @Document', () => {
    const pedido = fileNamed(files, 'domain/Pedido.java').content;
    expect(pedido).toContain('@Table("pedidos")');
    expect(pedido).toContain('@PrimaryKey');
    expect(pedido).not.toContain('@Entity');
    expect(pedido).not.toContain('@Document');
    expect(pedido).not.toContain('@ManyToOne');
    expect(pedido).not.toContain('@OneToMany');
  });

  it('guarda las asociaciones a-uno como identificador plano', () => {
    const pedido = fileNamed(files, 'domain/Pedido.java').content;
    expect(pedido).toContain('private String clienteId;');
    expect(pedido).toContain('public String getClienteId()');
    expect(pedido).not.toContain('private Cliente cliente;');

    const request = fileNamed(files, 'dto/PedidoRequest.java').content;
    expect(request).toContain('String clienteId');
  });

  it('usa CassandraRepository en lugar de JpaRepository/MongoRepository', () => {
    const repo = fileNamed(files, 'repository/PedidoRepository.java').content;
    expect(repo).toContain('extends CassandraRepository<Pedido, String>');
  });

  it('pagina en memoria en vez de usar findAll(Pageable), que CassandraRepository no ofrece', () => {
    const impl = fileNamed(files, 'service/impl/PedidoServiceImpl.java').content;
    expect(impl).not.toContain('findAll(pageable)');
    expect(impl).toContain('new PageImpl<>(');
  });

  it('no usa @Transactional sin un gestor de transacciones configurado', () => {
    const impl = fileNamed(files, 'service/impl/PedidoServiceImpl.java').content;
    expect(impl).not.toMatch(/^\s*@Transactional\s*$/m);
    expect(impl).not.toContain('import org.springframework.transaction.annotation.Transactional;');
  });

  it('no deja marcadores de plantilla sin sustituir', () => {
    for (const file of files.filter((f) => f.path !== 'postman_collection.json')) {
      expect(file.content, file.path).not.toContain('{{');
      expect(file.content, file.path).not.toContain('undefined');
    }
  });

  it('importa WriteResult del paquete donde Spring Data Cassandra lo publica', () => {
    const almacen = fileNamed(files, 'infraestructura/AlmacenIdempotencia.java').content;
    expect(almacen).toContain('import org.springframework.data.cassandra.core.WriteResult;');
    expect(almacen).not.toContain('core.cql.WriteResult');
  });

  it('asigna la clave primaria al crear, porque Cassandra no la genera', () => {
    const servicio = fileNamed(files, 'service/impl/ClienteServiceImpl.java').content;
    const crear = servicio.slice(servicio.indexOf('create(ClienteRequest request)'));
    expect(crear.slice(0, crear.indexOf('repository.save(entity)') + 40)).toMatch(
      /Cliente entity = mapper\.toEntity\(request\);[^}]*?entity\.setId\(java\.util\.UUID\.randomUUID\(\)\.toString\(\)\);\s+return mapper\.toResponse\(repository\.save\(entity\)\);/,
    );
  });

  it('no genera fila ni CRUD para una superclase abstracta', () => {
    const rrhhFiles = generateProject(normalize(rrhhDiagram(), { databaseTarget: 'cassandra' }));
    expect(rrhhFiles.some((f) => f.path.endsWith('domain/Persona.java'))).toBe(false);
    expect(rrhhFiles.some((f) => f.path.endsWith('controller/PersonaController.java'))).toBe(
      false,
    );
    expect(rrhhFiles.some((f) => f.path.endsWith('domain/Empleado.java'))).toBe(true);

    const empleado = fileNamed(rrhhFiles, 'domain/Empleado.java').content;
    expect(empleado).not.toContain('extends Persona');
    expect(empleado).toContain('private String nombre;');
    expect(empleado).toContain('private String documento;');
  });
});

describe('literales de enumeración', () => {
  function enumCon(literales: string[]): ClassDiagram {
    const estado = createClass({ id: 'E1', name: 'Estado', kind: 'enum', literals: literales });
    const tarea = createClass({
      id: 'C1',
      name: 'Tarea',
      attributes: [
        createAttribute({ id: 'A1', name: 'id', type: 'Long', isIdentifier: true }),
        createAttribute({ id: 'A2', name: 'estado', type: 'Estado' }),
      ],
    });
    return createDiagram({ id: 'D1', name: 'Tareas', classes: { E1: estado, C1: tarea } });
  }

  it('rechaza dos literales que coinciden al pasarlos a mayúsculas', () => {
    const result = validateDiagram(enumCon(['activo', 'ACTIVO', 'inactivo']));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'DUPLICATE_ENUM_LITERAL',
        elementId: 'E1',
        message:
          'Los literales «activo» y «ACTIVO» de «Estado» generan el mismo valor Java «ACTIVO».',
      }),
    ]);
  });

  it('sigue aceptando literales distintos', () => {
    const result = validateDiagram(enumCon(['activo', 'inactivo']));
    expect(result.errors).toEqual([]);
  });
});

describe('identificadores y herencia en PostgreSQL', () => {
  function conId(tipo: 'Long' | 'UUID' | 'String'): ClassDiagram {
    const producto = createClass({
      id: 'C1',
      name: 'Producto',
      attributes: [
        createAttribute({ id: 'A1', name: 'id', type: tipo, isIdentifier: true }),
        createAttribute({ id: 'A2', name: 'nombre', type: 'String' }),
      ],
    });
    return createDiagram({ id: 'D1', name: 'Catalogo', classes: { C1: producto } });
  }

  /** Persona (abstracta) ← Empleado (salario, * → 0..1 Sede), ← Cliente (atributo `dtype`). */
  function jerarquia(): ClassDiagram {
    const persona = createClass({
      id: 'C1',
      name: 'Persona',
      kind: 'abstract',
      attributes: [
        createAttribute({ id: 'A1', name: 'id', type: 'Long', isIdentifier: true }),
        createAttribute({ id: 'A2', name: 'nombre', type: 'String', isNullable: false }),
      ],
    });
    const empleado = createClass({
      id: 'C2',
      name: 'Empleado',
      attributes: [
        createAttribute({ id: 'A3', name: 'salario', type: 'Decimal', isNullable: false }),
      ],
    });
    const cliente = createClass({
      id: 'C3',
      name: 'Cliente',
      attributes: [createAttribute({ id: 'A4', name: 'dtype', type: 'String' })],
    });
    const sede = createClass({
      id: 'C4',
      name: 'Sede',
      attributes: [createAttribute({ id: 'A5', name: 'id', type: 'Long', isIdentifier: true })],
    });
    const diagram = createDiagram({
      id: 'D1',
      name: 'Personas',
      classes: { C1: persona, C2: empleado, C3: cliente, C4: sede },
    });
    return {
      ...diagram,
      relations: {
        R1: createRelation({ id: 'R1', kind: 'inheritance', sourceId: 'C2', targetId: 'C1' }),
        R2: createRelation({ id: 'R2', kind: 'inheritance', sourceId: 'C3', targetId: 'C1' }),
        R3: createRelation({
          id: 'R3',
          kind: 'association',
          sourceId: 'C2',
          targetId: 'C4',
          sourceMultiplicity: '*',
          targetMultiplicity: '0..1',
          targetRole: 'sede',
        }),
      },
    };
  }

  function generado(diagram: ClassDiagram, options: Parameters<typeof normalize>[1] = {}) {
    const outcome = generate(diagram, options);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.validation.errors));
    return outcome.files;
  }

  /** El `CREATE TABLE` de una tabla, hasta su cierre. */
  function tabla(files: GeneratedFile[], nombre: string): string {
    const sql = fileNamed(files, 'V1__esquema_inicial.sql').content;
    const desde = sql.indexOf(`CREATE TABLE ${nombre} (`);
    if (desde < 0) throw new Error(`No hay tabla ${nombre}:\n${sql}`);
    return sql.slice(desde, sql.indexOf(');', desde));
  }

  it('Long sigue siendo IDENTITY sobre BIGSERIAL', () => {
    const files = generado(conId('Long'));
    expect(fileNamed(files, 'domain/Producto.java').content).toContain(
      '@GeneratedValue(strategy = GenerationType.IDENTITY)',
    );
    expect(tabla(files, 'productos')).toContain('id BIGSERIAL NOT NULL');
  });

  for (const tipo of ['UUID', 'String'] as const) {
    it(`un id ${tipo} lo genera Hibernate y la columna no es SERIAL`, () => {
      const files = generado(conId(tipo));
      const entidad = fileNamed(files, 'domain/Producto.java').content;
      expect(entidad).toContain('@GeneratedValue(strategy = GenerationType.UUID)');
      expect(entidad).not.toContain('GenerationType.IDENTITY');
      expect(tabla(files, 'productos')).not.toContain('SERIAL');
    });
  }

  it('la respuesta importa UUID cuando el id lo es, y la petición no', () => {
    const files = generado(conId('UUID'));
    expect(fileNamed(files, 'dto/ProductoResponse.java').content).toContain(
      'import java.util.UUID;',
    );
    expect(fileNamed(files, 'dto/ProductoRequest.java').content).not.toContain('java.util.UUID');
  });

  it('JOINED: cada tabla con lo suyo y la subclase unida por la clave', () => {
    const files = generado(jerarquia(), { inheritanceStrategy: 'JOINED' });
    const empleado = fileNamed(files, 'domain/Empleado.java').content;
    expect(empleado).toContain('@Table(name = "empleados")');
    expect(empleado).toContain('@PrimaryKeyJoinColumn(name = "id")');
    expect(tabla(files, 'empleados')).not.toContain('nombre');
    expect(tabla(files, 'personas')).not.toContain('salario');
  });

  it('SINGLE_TABLE: una sola tabla con las columnas de todas las subclases', () => {
    const files = generado(jerarquia(), { inheritanceStrategy: 'SINGLE_TABLE' });
    const personas = tabla(files, 'personas');
    expect(personas).toContain('nombre VARCHAR(255) NOT NULL');
    // De una subclase: admite NULL porque los clientes no tienen salario.
    expect(personas).toContain('salario NUMERIC(19,2) NULL');
    expect(personas).toContain('sede_id BIGINT NULL');
    expect(() => tabla(files, 'empleados')).toThrow();

    const empleado = fileNamed(files, 'domain/Empleado.java').content;
    expect(empleado).not.toContain('@Table(');
    expect(empleado).not.toContain('@PrimaryKeyJoinColumn');
  });

  it('SINGLE_TABLE: el discriminador no choca con un atributo que se llame dtype', () => {
    const files = generado(jerarquia(), { inheritanceStrategy: 'SINGLE_TABLE' });
    const personas = tabla(files, 'personas');
    expect(personas).toContain('dtype_2 VARCHAR(64) NOT NULL');
    expect(personas).toContain('dtype VARCHAR(255) NULL');
    expect(fileNamed(files, 'domain/Persona.java').content).toContain(
      '@DiscriminatorColumn(name = "dtype_2")',
    );
  });

  it('TABLE_PER_CLASS: cada tabla repite lo heredado y la clave sale de una secuencia', () => {
    const files = generado(jerarquia(), { inheritanceStrategy: 'TABLE_PER_CLASS' });
    const empleados = tabla(files, 'empleados');
    expect(empleados).toContain('id BIGINT NOT NULL');
    expect(empleados).toContain('nombre VARCHAR(255) NOT NULL');
    expect(empleados).toContain('salario NUMERIC(19,2) NOT NULL');
    expect(fileNamed(files, 'V1__esquema_inicial.sql').content).toContain(
      'CREATE SEQUENCE personas_seq START WITH 1 INCREMENT BY 1;',
    );

    const persona = fileNamed(files, 'domain/Persona.java').content;
    expect(persona).toContain(
      '@GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "personas_seq")',
    );
    const empleado = fileNamed(files, 'domain/Empleado.java').content;
    expect(empleado).toContain('@Table(name = "empleados")');
    expect(empleado).not.toContain('@PrimaryKeyJoinColumn');
  });
});

describe('interfaces realizadas en MongoDB y Cassandra', () => {
  for (const databaseTarget of ['mongodb', 'cassandra'] as const) {
    it(`${databaseTarget}: la entidad declara la interfaz cuyos métodos sobrescribe`, () => {
      const files = generateProject(normalize(rrhhDiagram(), { databaseTarget }));
      const empleado = fileNamed(files, 'domain/Empleado.java').content;
      expect(empleado).toContain('@Override');
      expect(empleado).toMatch(/public class Empleado implements Auditable \{/);
    });
  }
});

describe('valores únicos', () => {
  for (const databaseTarget of ['postgres', 'mongodb', 'cassandra'] as const) {
    it(`${databaseTarget}: un duplicado responde 409 y no 500`, () => {
      const files = generateProject(normalize(tiendaDiagram(), { databaseTarget }));
      const manejador = fileNamed(files, 'exception/GlobalExceptionHandler.java').content;
      expect(manejador).toContain('@ExceptionHandler(DataIntegrityViolationException.class)');
      expect(manejador).toContain('HttpStatus.CONFLICT');
    });
  }

  it('mongodb: el campo único lleva un índice único que Spring crea al arrancar', () => {
    const files = generateProject(normalize(tiendaDiagram(), { databaseTarget: 'mongodb' }));
    const cliente = fileNamed(files, 'domain/Cliente.java').content;
    expect(cliente).toMatch(/@Indexed\(unique = true, sparse = true\)\s+private String email;/);
    expect(cliente).toContain('import org.springframework.data.mongodb.core.index.Indexed;');
    expect(fileNamed(files, 'application.yml').content).toContain('auto-index-creation: true');
  });

  it('cassandra: el servicio comprueba el valor único antes de guardar', () => {
    const files = generateProject(normalize(tiendaDiagram(), { databaseTarget: 'cassandra' }));
    const servicio = fileNamed(files, 'service/impl/ClienteServiceImpl.java').content;
    const crear = servicio.slice(servicio.indexOf('create(ClienteRequest request)'));
    expect(crear.slice(0, crear.indexOf('repository.save'))).toContain(
      'repository.existsByEmail(request.email())',
    );
    const actualizar = servicio.slice(servicio.indexOf('update(String id, ClienteRequest request)'));
    expect(actualizar.slice(0, actualizar.indexOf('repository.save'))).toContain(
      'repository.findByEmail(request.email()).filter(otro -> !otro.getId().equals(id)).isPresent()',
    );
    expect(servicio).toContain('throw new DuplicateKeyException(');
  });

  it('una entidad sin campos únicos no cambia su servicio Cassandra', () => {
    const files = generateProject(normalize(tiendaDiagram(), { databaseTarget: 'cassandra' }));
    const servicio = fileNamed(files, 'service/impl/PedidoServiceImpl.java').content;
    expect(servicio).not.toContain('DuplicateKeyException');
  });
});
