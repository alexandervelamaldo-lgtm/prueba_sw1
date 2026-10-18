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

const PLAZO = 60_000;

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

  it('en streaming llega la operación y el cierre', async () => {
    const eventos: EventoAsistente[] = [];
    for await (const evento of motor().interpretarEnStream('crea la clase Producto', diagramaBase(), contextoVacio)) {
      eventos.push(evento);
    }
    expect(eventos.some((e) => e.tipo === 'operacion' && e.operacion.op === 'addClass')).toBe(true);
    expect(eventos.at(-1)?.tipo).toBe('fin');
  }, PLAZO);
});
