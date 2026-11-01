import { describe, expect, it } from 'vitest';
import {
  ManifiestoSchema,
  VERSION_MANIFIESTO,
  buscarCampoHablado,
  buscarEntidadHablada,
  createAttribute,
  createClass,
  createDiagram,
} from '@app/shared';
import { CORPUS, minimoDiagram, rrhhDiagram, tiendaDiagram } from '../fixtures/corpus.js';
import { normalize } from '../ir/normalize.js';
import { buildEntityView, generateProject } from '../render/generate.js';
import { buildManifiesto, renderManifiesto } from './manifiesto.js';

const tienda = buildManifiesto(normalize(tiendaDiagram()));

function entidad(nombre: string) {
  const encontrada = tienda.entidades.find((e) => e.nombre === nombre);
  if (!encontrada) throw new Error(`El manifiesto de tienda no tiene ${nombre}`);
  return encontrada;
}

describe('manifiesto: contrato', () => {
  it('todo el corpus produce un manifiesto que valida contra el esquema', () => {
    for (const entry of CORPUS) {
      const manifiesto = buildManifiesto(normalize(entry.diagram()));
      expect(() => ManifiestoSchema.parse(manifiesto), entry.name).not.toThrow();
      expect(manifiesto.version).toBe(VERSION_MANIFIESTO);
    }
  });

  it('es determinista: dos generaciones del mismo diagrama dan el mismo texto', () => {
    // Es la propiedad que permite volver a lanzar el generador y comparar. Se
    // rompería en cuanto alguien metiera una fecha de generación en el
    // documento, que es exactamente por lo que no la lleva.
    const primera = renderManifiesto(normalize(tiendaDiagram()));
    const segunda = renderManifiesto(normalize(tiendaDiagram()));
    expect(primera).toBe(segunda);
  });

  it('el JSON emitido se puede volver a leer y validar', () => {
    const texto = renderManifiesto(normalize(rrhhDiagram()));
    expect(texto.endsWith('\n')).toBe(true);
    expect(() => ManifiestoSchema.parse(JSON.parse(texto))).not.toThrow();
  });
});

describe('manifiesto: campos', () => {
  it('expone exactamente los campos que acepta el DTO de entrada', () => {
    // Esta es la prueba que de verdad sostiene el contrato. El emisor repite el
    // recorrido de herencia de `buildEntityView` en lugar de importarlo, para no
    // crear un ciclo entre `asistente` y `render`; lo que impide que las dos
    // copias se separen es esta comparación, no compartir la función.
    for (const entry of CORPUS) {
      const ir = normalize(entry.diagram());
      const manifiesto = buildManifiesto(ir);

      for (const entidadIR of ir.entities.filter((e) => !e.isAbstract)) {
        const vista = buildEntityView(ir, entidadIR);
        const enManifiesto = manifiesto.entidades
          .find((e) => e.nombre === entidadIR.className)!
          .campos.map((c) => c.nombre);
        // Las listas de una N:M son opcionales en el DTO y no se dictan: el
        // manifiesto no tiene un tipo de campo para ellas.
        const listas = new Set(vista.toManyIdLists.map((l) => l.name));
        const enDto = vista.requestComponents.map((c) => c.name).filter((n) => !listas.has(n));

        expect(enManifiesto, `${entry.name}/${entidadIR.className}`).toEqual(enDto);
      }
    }
  });

  it('marca obligatorio lo mismo que el DTO valida con @NotNull o @NotBlank', () => {
    for (const entry of CORPUS) {
      const ir = normalize(entry.diagram());
      const manifiesto = buildManifiesto(ir);

      for (const entidadIR of ir.entities.filter((e) => !e.isAbstract)) {
        const vista = buildEntityView(ir, entidadIR);
        const exigidoPorElDto = new Map(
          vista.requestComponents.map((c) => [
            c.name,
            c.validations.some((v) => v.startsWith('@NotNull') || v.startsWith('@NotBlank')),
          ]),
        );

        for (const campo of manifiesto.entidades.find((e) => e.nombre === entidadIR.className)!
          .campos) {
          expect(campo.obligatorio, `${entidadIR.className}.${campo.nombre}`).toBe(
            exigidoPorElDto.get(campo.nombre),
          );
        }
      }
    }
  });

  it('traduce los tipos Java al vocabulario del móvil', () => {
    const producto = entidad('Producto');
    const porNombre = new Map(producto.campos.map((c) => [c.nombre, c]));

    expect(porNombre.get('nombre')?.tipo).toBe('texto');
    expect(porNombre.get('precio')?.tipo).toBe('decimal');
    expect(porNombre.get('activo')?.tipo).toBe('booleano');
  });

  it('un enumerado del diagrama llega con su lista cerrada de valores', () => {
    const estado = entidad('Pedido').campos.find((c) => c.nombre === 'estado');
    expect(estado?.tipo).toBe('enumerado');
    // Sin la lista, el móvil no puede ofrecer las opciones ni validar antes de
    // enviar: dictar un estado inexistente acabaría en un 400 del servidor.
    expect(estado?.valores).toEqual(['BORRADOR', 'CONFIRMADO', 'ENVIADO', 'ENTREGADO', 'CANCELADO']);
  });

  it('una asociación *-a-uno se ve como referencia con el nombre que espera el DTO', () => {
    const cliente = entidad('Pedido').campos.find((c) => c.nombre === 'clienteId');
    expect(cliente).toBeDefined();
    expect(cliente?.tipo).toBe('referencia');
    expect(cliente?.entidad).toBe('Cliente');
    expect(cliente?.obligatorio).toBe(true);
  });

  it('propaga la longitud máxima declarada por @Size', () => {
    const nombre = entidad('Cliente').campos.find((c) => c.nombre === 'nombre');
    expect(nombre?.maxLongitud).toBe(255);
  });

  it('no expone el identificador como campo editable', () => {
    for (const e of tienda.entidades) {
      expect(e.campos.map((c) => c.nombre)).not.toContain(e.identificador.nombre);
    }
  });

  it('las colecciones no son campos: no se dictan, se gestionan desde el otro lado', () => {
    // `Pedido.lineas` es el lado inverso; el DTO tampoco lo acepta. Ofrecerlo en
    // un formulario hablado sería pedir al usuario que dicte una lista entera.
    expect(entidad('Pedido').campos.map((c) => c.nombre)).not.toContain('lineas');
  });
});

describe('manifiesto: acciones y avisos', () => {
  it('solo el borrado exige confirmación hablada', () => {
    for (const e of tienda.entidades) {
      expect(e.acciones).toEqual(['listar', 'ver', 'crear', 'actualizar', 'borrar']);
      expect(e.criticas).toEqual(['borrar']);
    }
  });

  it('avisa de lo que se lleva por delante borrar el todo de una composición', () => {
    // El aviso hablado tiene que ser honesto: «borrar este pedido eliminará
    // también sus líneas» solo puede saberlo quien vio el rombo relleno.
    expect(entidad('Pedido').borradoEnCascada).toEqual(['LineaPedido']);
  });

  it('no avisa de cascada donde solo hay una asociación', () => {
    // `Producto` también tiene líneas, pero sin cascada: borrar un producto no
    // borra las líneas de pedido que lo mencionan.
    expect(entidad('Producto').borradoEnCascada).toEqual([]);
  });

  it('omite las entidades abstractas: no se instancian ni tienen controlador', () => {
    const ir = normalize(rrhhDiagram());
    const manifiesto = buildManifiesto(ir);
    const abstractas = ir.entities.filter((e) => e.isAbstract).map((e) => e.className);

    for (const nombre of abstractas) {
      expect(manifiesto.entidades.map((e) => e.nombre)).not.toContain(nombre);
    }
  });
});

describe('manifiesto: lo que se dicta', () => {
  it('cada entidad se reconoce por su singular y por su plural', () => {
    expect(buscarEntidadHablada(tienda, 'pedido')?.nombre).toBe('Pedido');
    expect(buscarEntidadHablada(tienda, 'pedidos')?.nombre).toBe('Pedido');
    expect(buscarEntidadHablada(tienda, 'linea pedido')?.nombre).toBe('LineaPedido');
    expect(buscarEntidadHablada(tienda, 'linea pedidos')?.nombre).toBe('LineaPedido');
  });

  it('el plural hablado sale de la misma ruta que usa la app para pedir', () => {
    // Si se pluralizara dos veces por separado, la app pediría `/citas` y diría
    // «citaes», y nadie sabría cuál de las dos está mal.
    for (const e of tienda.entidades) {
      expect(e.etiquetaHablada).toContain(e.ruta.slice(1).replace(/-/g, ' '));
    }
  });

  it('reconoce un campo compuesto por su etiqueta en palabras', () => {
    const linea = entidad('LineaPedido');
    expect(buscarCampoHablado(linea, 'precio unitario')?.nombre).toBe('precioUnitario');
    // Y también por el nombre exacto, para las órdenes escritas.
    expect(buscarCampoHablado(linea, 'precioUnitario')?.nombre).toBe('precioUnitario');
  });

  it('propone como etiqueta el primer texto obligatorio', () => {
    expect(entidad('Cliente').campoEtiqueta).toBe('nombre');
    expect(entidad('Producto').campoEtiqueta).toBe('nombre');
    // Una entidad sin texto obligatorio no tiene con qué nombrarse: mejor
    // ausente que un campo numérico que nadie reconocería al oírlo.
    expect(entidad('LineaPedido').campoEtiqueta).toBeUndefined();
  });
});

describe('manifiesto: seguridad de los nombres (RNF-SEG-06)', () => {
  it('toda ruta emitida es kebab-case con barra inicial', () => {
    for (const entry of CORPUS) {
      for (const e of buildManifiesto(normalize(entry.diagram())).entidades) {
        expect(e.ruta, `${entry.name}/${e.nombre}`).toMatch(/^\/[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });

  it('un nombre que escaparía de la ruta hace fallar la generación, no se sanea', () => {
    // La regla es lista blanca: nunca se «limpia» una cadena peligrosa quitando
    // caracteres, porque ese enfoque siempre deja huecos. Se construye una IR a
    // mano porque el validador previo ya rechazaría el diagrama.
    const ir = normalize(
      createDiagram({
        id: 'D',
        name: 'Fuga',
        classes: {
          C1: createClass({
            id: 'C1',
            name: 'Cosa',
            attributes: [createAttribute({ id: 'A1', name: 'id', type: 'Long', isIdentifier: true })],
          }),
        },
      }),
    );
    ir.entities[0]!.restPath = '../admin';

    expect(() => buildManifiesto(ir)).toThrow(/no segura/);
  });
});

describe('manifiesto: integración con el árbol de ficheros', () => {
  it('se emite como recurso del classpath junto al controlador que lo sirve', () => {
    const files = generateProject(normalize(minimoDiagram()));
    const rutas = files.map((f) => f.path);

    expect(rutas).toContain('src/main/resources/asistente/manifiesto.json');
    expect(rutas.some((r) => r.endsWith('controller/ManifiestoController.java'))).toBe(true);
    expect(rutas.some((r) => r.endsWith('infraestructura/FiltroIdempotencia.java'))).toBe(true);
    expect(rutas.some((r) => r.endsWith('infraestructura/AlmacenIdempotencia.java'))).toBe(true);
    expect(rutas).toContain('src/main/resources/db/migration/V3__idempotencia.sql');
  });

  it('el recurso emitido es el manifiesto del propio diagrama', () => {
    const ir = normalize(tiendaDiagram());
    const files = generateProject(ir);
    const recurso = files.find((f) => f.path === 'src/main/resources/asistente/manifiesto.json')!;

    expect(JSON.parse(recurso.content)).toEqual(buildManifiesto(ir));
  });

  it('anuncia la cabecera de idempotencia que el filtro implementa de verdad', () => {
    // Si el campo faltara, la app sabría que reenviar es peligroso. Anunciarlo
    // sin el filtro sería peor que no anunciarlo.
    const files = generateProject(normalize(tiendaDiagram()));
    const filtro = files.find((f) => f.path.endsWith('FiltroIdempotencia.java'))!;

    expect(tienda.cabeceraIdempotencia).toBe('Idempotency-Key');
    expect(filtro.content).toContain('String CABECERA = "Idempotency-Key"');
  });
});
