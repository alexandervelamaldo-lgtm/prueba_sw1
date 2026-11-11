import { describe, expect, it } from 'vitest';
import {
  createAttribute,
  createClass,
  createDiagram,
  listSupportedTypes,
  type AssistantResponse,
  type ClassDiagram,
  type EventoAsistente,
  type Operation,
} from '@app/shared';
import { cargarEnv, loadConfig } from '../config.js';
import { createAssistant, LlmAssistant, type AssistantContext } from './assistant.js';

/**
 * Evaluación del Modo IA contra el modelo de verdad.
 *
 * Se salta sola si no hay `EVALUAR_IA=1`, que es el caso normal: cada caso es
 * una llamada al proveedor, cuesta dinero y depende de la red. Para ejecutarla,
 * con la clave del modelo configurada en el `.env` de siempre:
 *
 * ```
 * EVALUAR_IA=1 npx vitest run backend-tool/src/ai/assistant.evaluacion.test.ts
 * ```
 *
 * Existe para detectar regresiones al tocar el `SYSTEM_PROMPT`: las pruebas de
 * `assistant.test.ts` usan un proveedor simulado y comprueban el código, no lo
 * que el modelo entiende del prompt. Aquí, como en la evaluación de Ollama, no
 * se exige una frase concreta —eso falla al cambiar de versión de modelo sin
 * que nada se haya roto—, sino las reglas del prompt: qué operación, sobre qué
 * clase, que una pregunta no cambia nada, que no se borra lo que nadie pidió
 * borrar.
 */

const activa = process.env.EVALUAR_IA === '1';

function motor(): LlmAssistant {
  cargarEnv();
  const config = loadConfig();
  const asistente = createAssistant(config);
  if (!(asistente instanceof LlmAssistant)) throw new Error('EVALUAR_IA=1 necesita LLM_API_KEY en el .env');
  return asistente;
}

/** Cliente (id, nombre) 1 → * Pedido: el diagrama de partida de casi todos los casos. */
function diagramaBase(): ClassDiagram {
  const cliente = createClass({
    id: 'C1',
    name: 'Cliente',
    position: { x: 0, y: 0 },
    attributes: [
      createAttribute({ id: 'A1', name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: 'A2', name: 'nombre', type: 'String' }),
    ],
  });
  const pedido = createClass({ id: 'C2', name: 'Pedido', position: { x: 300, y: 0 } });
  const diagrama = createDiagram({ id: 'D1', name: 'Tienda', classes: { C1: cliente, C2: pedido } });
  return {
    ...diagrama,
    relations: {
      R1: {
        id: 'R1',
        kind: 'association',
        source: { classId: 'C1', multiplicity: '1' },
        target: { classId: 'C2', multiplicity: '*' },
      } as ClassDiagram['relations'][string],
    },
  };
}

/** Una tienda de 8 clases y 7 relaciones: el tamaño de un proyecto real pequeño. */
function diagramaDeOchoClases(): ClassDiagram {
  const clase = (id: string, name: string, x: number, atributos: [string, string][]) =>
    createClass({
      id,
      name,
      position: { x, y: 0 },
      attributes: [
        createAttribute({ id: `${id}A0`, name: 'id', type: 'Long', isIdentifier: true }),
        ...atributos.map(([nombre, tipo], i) => createAttribute({ id: `${id}A${i + 1}`, name: nombre, type: tipo })),
      ],
    });
  const classes = {
    C1: clase('C1', 'Cliente', 0, [['nombre', 'String'], ['email', 'String']]),
    C2: clase('C2', 'Pedido', 300, [['numero', 'String']]),
    C3: clase('C3', 'LineaPedido', 600, [['cantidad', 'Integer'], ['precio', 'Double']]),
    C4: clase('C4', 'Producto', 900, [['nombre', 'String'], ['stock', 'Integer']]),
    C5: clase('C5', 'Categoria', 1200, [['nombre', 'String']]),
    C6: clase('C6', 'Pago', 1500, [['importe', 'Double']]),
    C7: clase('C7', 'Direccion', 1800, [['calle', 'String'], ['ciudad', 'String']]),
    C8: clase('C8', 'Empleado', 2100, [['nombre', 'String'], ['cargo', 'String']]),
  };
  const relacion = (id: string, origen: string, destino: string, multiplicidadDestino: '1' | '*') =>
    ({
      id,
      kind: 'association',
      source: { classId: origen, multiplicity: '1' },
      target: { classId: destino, multiplicity: multiplicidadDestino },
    }) as ClassDiagram['relations'][string];
  return {
    ...createDiagram({ id: 'D2', name: 'Tienda', classes }),
    relations: {
      R1: relacion('R1', 'C1', 'C2', '*'),
      R2: relacion('R2', 'C2', 'C3', '*'),
      R3: relacion('R3', 'C4', 'C3', '*'),
      R4: relacion('R4', 'C5', 'C4', '*'),
      R5: relacion('R5', 'C2', 'C6', '1'),
      R6: relacion('R6', 'C1', 'C7', '*'),
      R7: relacion('R7', 'C8', 'C2', '*'),
    },
  };
}

const contextoVacio: AssistantContext = { historial: [], otrosProyectos: [] };

async function pedir(texto: string, contexto: AssistantContext = contextoVacio, diagrama = diagramaBase()) {
  const respuesta = await motor().interpret(texto, diagrama, contexto);
  return respuesta;
}

const operaciones = <K extends Operation['op']>(r: AssistantResponse, op: K) =>
  r.operations.filter((o): o is Extract<Operation, { op: K }> => o.op === op);
const nombreDeRef = (ref: unknown): string | undefined =>
  typeof ref === 'object' && ref !== null && 'name' in ref ? String((ref as { name: string }).name) : undefined;
const borra = (r: AssistantResponse) => r.operations.some((o) => o.op.startsWith('remove'));
const texto = (r: AssistantResponse) => `${r.explanation} ${r.clarification ?? ''}`.trim();

// Por encima del plazo del modelo: si vencieran a la vez, la prueba se cortaría
// antes de ver la respuesta de la gramática.
const PLAZO = Math.max(60_000, (Number(process.env.LLM_TIMEOUT_MS) || 0) + 5_000);

describe.runIf(activa)('evaluación del Modo IA contra el modelo real', () => {
  describe('órdenes de cambio', () => {
    it('crear una clase', async () => {
      const r = await pedir('crea la clase Producto');
      expect(operaciones(r, 'addClass').map((o) => o.name)).toContain('Producto');
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('crear una interfaz', async () => {
      const r = await pedir('crea una interfaz Pagable');
      expect(operaciones(r, 'addClass')).toContainEqual(expect.objectContaining({ name: 'Pagable', kind: 'interface' }));
    }, PLAZO);

    it('añadir un atributo con su tipo a una clase existente', async () => {
      const r = await pedir('añade el atributo email de tipo String a Cliente');
      expect(operaciones(r, 'addAttribute')).toContainEqual(
        expect.objectContaining({ classRef: { name: 'Cliente' }, name: 'email', type: 'String' }),
      );
    }, PLAZO);

    it('renombrar una clase', async () => {
      const r = await pedir('renombra Cliente a Comprador');
      expect(operaciones(r, 'renameClass')).toContainEqual(expect.objectContaining({ name: 'Comprador' }));
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('borrar una clase cuando se pide', async () => {
      const r = await pedir('elimina la clase Pedido');
      expect(operaciones(r, 'removeClass').map((o) => nombreDeRef(o.ref))).toContain('Pedido');
    }, PLAZO);

    it('una relación «tiene muchos» lleva 1 y *', async () => {
      const r = await pedir('crea la clase Direccion; un Cliente tiene muchas Direcciones');
      const relacion = operaciones(r, 'addRelation')[0];
      expect(relacion).toBeDefined();
      expect([relacion!.sourceMultiplicity, relacion!.targetMultiplicity].sort()).toEqual(['*', '1']);
    }, PLAZO);

    it('añadir un método con tipo de retorno', async () => {
      const r = await pedir('añade a Pedido un método calcularTotal que devuelva Double');
      expect(operaciones(r, 'addMethod')).toContainEqual(
        expect.objectContaining({ classRef: { name: 'Pedido' }, name: 'calcularTotal', returnType: 'Double' }),
      );
    }, PLAZO);

    it('un enum con sus literales', async () => {
      const r = await pedir('crea un enum EstadoPedido con los valores PENDIENTE y ENVIADO');
      expect(operaciones(r, 'addClass')).toContainEqual(expect.objectContaining({ name: 'EstadoPedido', kind: 'enum' }));
      expect(operaciones(r, 'addEnumLiteral').map((o) => o.literal).sort()).toEqual(['ENVIADO', 'PENDIENTE']);
    }, PLAZO);

    it('cambiar el tipo de clase', async () => {
      const r = await pedir('haz que Pedido sea una clase abstracta');
      expect(operaciones(r, 'setClassKind')).toContainEqual(expect.objectContaining({ kind: 'abstract' }));
    }, PLAZO);

    it('composición', async () => {
      const r = await pedir('crea la clase LineaPedido; un Pedido se compone de muchas LineaPedido');
      expect(operaciones(r, 'addRelation').map((o) => o.kind)).toContain('composition');
    }, PLAZO);

    it('herencia', async () => {
      const r = await pedir('crea la clase ClienteVip, que hereda de Cliente');
      expect(operaciones(r, 'addRelation').map((o) => o.kind)).toContain('inheritance');
    }, PLAZO);

    it('quitar un atributo', async () => {
      const r = await pedir('quita el atributo nombre de Cliente');
      expect(operaciones(r, 'removeAttribute')).toContainEqual(expect.objectContaining({ attributeName: 'nombre' }));
    }, PLAZO);

    it('clase de asociación sobre una relación muchos a muchos', async () => {
      const r = await pedir(
        'crea la clase Producto y relaciónala muchos a muchos con Pedido, con una clase intermedia LineaPedido',
      );
      const intermedia =
        operaciones(r, 'addRelation').some((o) => o.associationClassName === 'LineaPedido') ||
        operaciones(r, 'setAssociationClass').length > 0;
      expect(intermedia).toBe(true);
    }, PLAZO);

    it('modificar el tipo de una relación la cambia, no la borra y la vuelve a crear', async () => {
      const r = await pedir('cambia la relación entre Cliente y Pedido a una agregación');
      expect(operaciones(r, 'updateRelation')).toContainEqual(
        expect.objectContaining({ id: 'R1', changes: expect.objectContaining({ kind: 'aggregation' }) }),
      );
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('modificar la multiplicidad de una relación', async () => {
      const r = await pedir('en la relación entre Cliente y Pedido, un cliente tiene como máximo un pedido');
      const cambio = operaciones(r, 'updateRelation')[0];
      expect(cambio?.id).toBe('R1');
      // «Como máximo uno» es 0..1 en UML; 1 también es aceptable si el modelo lo lee como «exactamente uno».
      const extremos = [cambio?.changes.sourceMultiplicity, cambio?.changes.targetMultiplicity];
      expect(extremos.some((m) => m === '0..1' || m === '1')).toBe(true);
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('una orden con un cambio y un borrado no esconde el borrado', async () => {
      const r = await pedir('crea la clase Factura y borra la clase Pedido');
      expect(operaciones(r, 'addClass').map((o) => o.name)).toContain('Factura');
      expect(operaciones(r, 'removeClass').map((o) => nombreDeRef(o.ref))).toContain('Pedido');
    }, PLAZO);
  });

  describe('reglas del prompt', () => {
    it('una pregunta no cambia nada y tiene respuesta', async () => {
      const r = await pedir('¿qué te parece mi diagrama?');
      expect(r.operations).toEqual([]);
      expect(texto(r).length).toBeGreaterThan(10);
    }, PLAZO);

    it('una pregunta sobre el diagrama se contesta con el diagrama', async () => {
      const r = await pedir('¿cuántas clases tiene mi diagrama? no cambies nada');
      expect(r.operations).toEqual([]);
      expect(texto(r)).toMatch(/\b(2|dos)\b/i);
    }, PLAZO);

    it('una orden ambigua pregunta en vez de adivinar', async () => {
      const r = await pedir('añade un atributo');
      expect(r.operations).toEqual([]);
      expect(texto(r).length).toBeGreaterThan(5);
    }, PLAZO);

    it('no borra nada que no se haya pedido borrar', async () => {
      const r = await pedir('mejora el diagrama como te parezca');
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('solo usa tipos admitidos', async () => {
      const r = await pedir('añade a Pedido un atributo fecha de tipo Fecha');
      const tipos = operaciones(r, 'addAttribute').map((o) => o.type);
      for (const tipo of tipos) expect(listSupportedTypes()).toContain(tipo);
    }, PLAZO);
  });

  describe('contexto', () => {
    it('entiende «ahora añádele…» por el turno anterior', async () => {
      const r = await pedir('ahora añádele un atributo total de tipo Double', {
        ...contextoVacio,
        historial: [
          { role: 'user', texto: 'háblame de la clase Pedido', autorId: 'u', autorNombre: 'Ana', creadoEn: '', tipo: 'respuesta' },
          { role: 'assistant', texto: 'Pedido no tiene atributos todavía.', autorId: null, autorNombre: null, creadoEn: '', tipo: 'respuesta' },
        ],
      });
      expect(operaciones(r, 'addAttribute')).toContainEqual(expect.objectContaining({ classRef: { name: 'Pedido' } }));
    }, PLAZO);

    it('entiende «esta clase» por la selección', async () => {
      const r = await pedir('añade a esta clase un atributo telefono de tipo String', {
        ...contextoVacio,
        seleccion: 'Cliente',
      });
      expect(operaciones(r, 'addAttribute')).toContainEqual(expect.objectContaining({ classRef: { name: 'Cliente' } }));
    }, PLAZO);

    it('contesta «quién cambió» con los cambios recientes, sin cambiar nada', async () => {
      const r = await pedir('¿quién creó la clase Pedido?', {
        ...contextoVacio,
        cambiosRecientes: ['2026-10-17 10:00 UTC · Beto · Crear clase «Pedido»'],
      });
      expect(r.operations).toEqual([]);
      expect(texto(r)).toContain('Beto');
    }, PLAZO);

    it('no inventa el contenido de otros proyectos', async () => {
      const r = await pedir('¿qué clases tiene mi proyecto Clínica?', {
        ...contextoVacio,
        otrosProyectos: ['Clínica (owner)'],
      });
      expect(r.operations).toEqual([]);
      expect(texto(r)).not.toMatch(/\bPaciente\b|\bMédico\b|\bCita\b/);
    }, PLAZO);
  });

  // Un tamaño de proyecto real: comprueba que el modelo acierta la clase entre
  // varias, y deja en el registro lo que tarda y los tokens que gasta cada pedido.
  describe('diagrama de 8 clases', () => {
    const pedirGrande = async (orden: string) => {
      let tokens = 0;
      const inicio = Date.now();
      const r = await motor().interpret(orden, diagramaDeOchoClases(), {
        ...contextoVacio,
        registrarUso: (usados) => {
          tokens += usados;
        },
      });
      console.log(`[8 clases] ${Date.now() - inicio} ms, ${tokens} tokens: ${orden}`);
      return r;
    };

    it('añade un atributo a la clase correcta', async () => {
      const r = await pedirGrande('añade el atributo salario de tipo Double a Empleado');
      expect(operaciones(r, 'addAttribute')).toContainEqual(
        expect.objectContaining({ classRef: { name: 'Empleado' }, name: 'salario', type: 'Double' }),
      );
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('renombra sin borrar', async () => {
      const r = await pedirGrande('renombra Categoria a Rubro');
      expect(operaciones(r, 'renameClass')).toContainEqual(expect.objectContaining({ name: 'Rubro' }));
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('relaciona dos clases existentes', async () => {
      const r = await pedirGrande('crea una asociación entre Pago y Empleado');
      const relacion = JSON.stringify(operaciones(r, 'addRelation'));
      expect(relacion).toContain('Pago');
      expect(relacion).toContain('Empleado');
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('cambia la relación correcta entre siete', async () => {
      const r = await pedirGrande('cambia la relación entre Categoria y Producto a una agregación');
      expect(operaciones(r, 'updateRelation')).toContainEqual(
        expect.objectContaining({ id: 'R4', changes: expect.objectContaining({ kind: 'aggregation' }) }),
      );
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('una orden con clase, atributo y relación', async () => {
      const r = await pedirGrande('crea la clase Proveedor con un atributo nombre de tipo String; un Proveedor tiene muchos Producto');
      expect(operaciones(r, 'addClass').map((o) => o.name)).toContain('Proveedor');
      expect(operaciones(r, 'addAttribute')).toContainEqual(expect.objectContaining({ name: 'nombre' }));
      expect(operaciones(r, 'addRelation').length).toBeGreaterThan(0);
      expect(borra(r)).toBe(false);
    }, PLAZO);

    it('toca dos clases en la misma orden', async () => {
      const r = await pedirGrande('añade a Pago un atributo metodo de tipo String y a Pedido un atributo total de tipo Double');
      const destinos = operaciones(r, 'addAttribute').map((o) => nombreDeRef(o.classRef));
      expect(destinos).toEqual(expect.arrayContaining(['Pago', 'Pedido']));
    }, PLAZO);

    it('borra solo la clase pedida', async () => {
      const r = await pedirGrande('elimina la clase Direccion');
      const borradas = operaciones(r, 'removeClass').map((o) => nombreDeRef(o.ref));
      expect(borradas).toEqual(['Direccion']);
    }, PLAZO);

    it('una pregunta se contesta con el diagrama y no cambia nada', async () => {
      const r = await pedirGrande('¿con qué clases está relacionada Pedido?');
      expect(r.operations).toEqual([]);
      expect(texto(r)).toContain('Cliente');
      expect(texto(r)).toContain('Pago');
    }, PLAZO);
  });

  // El caso que las demás pruebas no cubren: un hilo largo agota el contexto de
  // un modelo pequeño, y sus respuestas anteriores lo llevan a decir que hizo un
  // cambio sin escribir la operación.
  describe('conversación larga', () => {
    const hiloLargo: AssistantContext['historial'] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      texto:
        i % 2 === 0
          ? `añade a Pedido un atributo campo${i} de tipo String`
          : `He añadido el atributo campo${i - 1} de tipo String a la clase Pedido. ¿Quieres que añada algo más al diagrama o prefieres revisar primero cómo ha quedado?`,
      autorId: null,
      autorNombre: null,
      creadoEn: '',
      tipo: 'respuesta' as const,
    }));
    const conHilo = { ...contextoVacio, historial: hiloLargo };

    it('una orden sigue generando su operación', async () => {
      const r = await motor().interpret('añade a Empleado un atributo edad de tipo Integer', diagramaDeOchoClases(), conHilo);
      expect(operaciones(r, 'addAttribute')).toContainEqual(
        expect.objectContaining({ classRef: { name: 'Empleado' }, name: 'edad' }),
      );
    }, PLAZO);

    it('crear una clase sigue generando su operación', async () => {
      const r = await motor().interpret('crea la clase Sucursal', diagramaDeOchoClases(), conHilo);
      expect(operaciones(r, 'addClass').map((o) => o.name)).toContain('Sucursal');
    }, PLAZO);

    it('en streaming también', async () => {
      const eventos: EventoAsistente[] = [];
      for await (const evento of motor().interpretarEnStream('añade a Pago un atributo moneda de tipo String', diagramaDeOchoClases(), conHilo)) {
        eventos.push(evento);
      }
      expect(eventos.some((e) => e.tipo === 'operacion' && e.operacion.op === 'addAttribute')).toBe(true);
      expect(eventos.at(-1)).toEqual(expect.objectContaining({ tipo: 'fin', motor: expect.stringContaining('modelo-remoto') }));
    }, PLAZO);
  });

  describe('frases habituales de multiplicidad', () => {
    const cambios = (r: AssistantResponse) => operaciones(r, 'updateRelation')[0]?.changes;

    it('de muchos a muchos', async () => {
      const r = await pedir('Cambia la relación entre Cliente y Pedido de muchos a muchos.');
      expect(cambios(r)).toEqual(expect.objectContaining({ sourceMultiplicity: '*', targetMultiplicity: '*' }));
    }, PLAZO);

    it('de muchos a uno', async () => {
      const r = await pedir('Cambia la relación entre Cliente y Pedido de muchos a uno.');
      expect(cambios(r)).toEqual(expect.objectContaining({ sourceMultiplicity: '*', targetMultiplicity: '1' }));
    }, PLAZO);

    it('de uno a uno', async () => {
      const r = await pedir('Cambia la relación entre Cliente y Pedido de uno a uno.');
      expect(cambios(r)).toEqual(expect.objectContaining({ sourceMultiplicity: '1', targetMultiplicity: '1' }));
    }, PLAZO);
  });

  // Respuestas anteriores que niegan algo: el modelo no debe tomarlas por ciertas.
  it('elimina un atributo aunque antes se haya negado', async () => {
    const r = await pedir('elimina el atributo nombre de la clase Cliente', {
      ...contextoVacio,
      historial: [
        { role: 'user', texto: 'quita el atributo nombre de Cliente', autorId: 'u', autorNombre: 'Ana', creadoEn: '', tipo: 'respuesta' },
        { role: 'assistant', texto: 'El atributo «nombre» no existe en la clase Cliente, por lo que no se puede eliminar.', autorId: null, autorNombre: null, creadoEn: '', tipo: 'respuesta' },
        { role: 'user', texto: 'te digo que elimines nombre de Cliente', autorId: 'u', autorNombre: 'Ana', creadoEn: '', tipo: 'respuesta' },
        { role: 'assistant', texto: 'El atributo «nombre» no está presente en el diagrama actual. No se puede eliminar.', autorId: null, autorNombre: null, creadoEn: '', tipo: 'respuesta' },
      ],
    });
    expect(operaciones(r, 'removeAttribute')).toContainEqual(expect.objectContaining({ attributeName: 'nombre' }));
  }, PLAZO);

  it('en streaming llega la operación y el cierre', async () => {
    const eventos: EventoAsistente[] = [];
    for await (const evento of motor().interpretarEnStream('crea la clase Producto', diagramaBase(), contextoVacio)) {
      eventos.push(evento);
    }
    expect(eventos.some((e) => e.tipo === 'operacion' && e.operacion.op === 'addClass')).toBe(true);
    expect(eventos.at(-1)?.tipo).toBe('fin');
  }, PLAZO);
});
