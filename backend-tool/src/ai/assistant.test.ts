import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiagram, createClass, createAttribute, type EventoAsistente } from '@app/shared';
import { GrammarAssistant, LlmAssistant, createAssistant, extractJson } from './assistant.js';
import { OpenAiVisionEngine, createVisionEngine } from './vision.js';
import { ErrorDeModelo } from './transporte.js';

/**
 * Pruebas del asistente y del motor de visión contra un proveedor simulado.
 *
 * Se levanta un servidor HTTP local que habla el mismo protocolo que DeepSeek u
 * OpenAI. No se llama al proveedor real: una prueba que depende de la red, del
 * saldo de una clave y de que el modelo repita hoy lo de ayer no comprueba el
 * código, comprueba el clima. Lo que sí se comprueba —y es lo que importa— es
 * qué hace este código cuando el modelo devuelve basura, tarda demasiado, o
 * responde con un JSON que valida a medias.
 */

let server: Server;
let baseUrl: string;
/** Lo que el proveedor falso responderá a la siguiente petición. */
let responder: (body: unknown) => { status: number; payload: unknown };
/** Los bloques SSE que responderá la siguiente petición, si la prueba lo necesita. */
let bloquesSse: string[] | null;
let dejarStreamAbierto: boolean;
/** Los cuerpos que ha recibido, para comprobar qué se le manda. */
let recibidos: Record<string, unknown>[];

const diagrama = createDiagram({
  id: 'D1',
  name: 'Prueba',
  classes: {
    C1: createClass({
      id: 'C1',
      name: 'Cliente',
      attributes: [createAttribute({ id: 'A1', name: 'id', type: 'Long', isIdentifier: true })],
    }),
  },
});

/** Respuesta con forma de OpenAI, que es la que hablan DeepSeek y compañía. */
function comoOpenAi(contenido: string, extra: Record<string, unknown> = {}) {
  return { choices: [{ message: { content: contenido, ...extra } }] };
}

beforeEach(async () => {
  recibidos = [];
  bloquesSse = null;
  dejarStreamAbierto = false;
  responder = () => ({ status: 200, payload: comoOpenAi('{"operations":[]}') });

  server = createServer((request, response) => {
    let cuerpo = '';
    request.on('data', (trozo) => (cuerpo += trozo));
    request.on('end', () => {
      const parseado = cuerpo ? JSON.parse(cuerpo) : {};
      recibidos.push(parseado);
      if (bloquesSse) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const bloque of bloquesSse) response.write(bloque);
        if (!dejarStreamAbierto) response.end();
        return;
      }
      const { status, payload } = responder(parseado);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function motor(overrides: Record<string, unknown> = {}) {
  return new LlmAssistant({
    apiKey: 'clave-de-prueba',
    provider: 'openai',
    baseUrl,
    model: 'modelo-de-prueba',
    timeoutMs: 1000,
    ...overrides,
  });
}

describe('extractJson', () => {
  it('acepta el JSON pelado', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('recorta las vallas de código que algunos modelos añaden igualmente', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('descarta la prosa alrededor del objeto', () => {
    expect(extractJson('Claro, aquí tienes:\n{"a":1}\nEspero que te sirva.')).toEqual({ a: 1 });
  });

  it('falla si no hay ningún objeto, en lugar de devolver algo inventado', () => {
    expect(() => extractJson('lo siento, no puedo ayudarte con eso')).toThrow();
  });
});

describe('LlmAssistant contra un proveedor simulado', () => {
  it('manda el resumen del diagrama y no el documento entero', async () => {
    await motor().interpret('crea la clase Pedido', diagrama);

    const mensajes = recibidos[0]?.messages as { role: string; content: string }[];
    const usuario = mensajes.find((m) => m.role === 'user')?.content ?? '';
    expect(usuario).toContain('Cliente');
    // Ni identificadores internos ni posiciones: gastan contexto y le dan al
    // modelo material para inventarse referencias.
    expect(usuario).not.toContain('C1');
    expect(usuario).not.toContain('position');
  });

  it('autentica con Bearer en el protocolo de OpenAI', async () => {
    const conCabecera = new Promise<string | undefined>((resolve) => {
      server.once('request', (request) => resolve(request.headers.authorization));
    });
    await motor().interpret('crea la clase Pedido', diagrama);

    expect(await conCabecera).toBe('Bearer clave-de-prueba');
  });

  it('devuelve las operaciones que el modelo propone', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({
          operations: [{ op: 'addClass', name: 'Pedido', kind: 'class' }],
          confidence: 0.9,
          clarification: null,
          explanation: 'Se crea la clase Pedido.',
        }),
      ),
    });

    const respuesta = await motor().interpret('crea la clase Pedido', diagrama);

    expect(respuesta.operations).toEqual([{ op: 'addClass', name: 'Pedido', kind: 'class' }]);
    expect(respuesta.confidence).toBe(0.9);
  });

  it('ignora el razonamiento en voz alta y se queda con «content»', async () => {
    // Los modelos que razonan devuelven en `reasoning_content` borradores de
    // JSON que ellos mismos descartaron. Quedarse con el primero que parsee
    // sería aprobar una versión que el modelo rechazó.
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({ operations: [{ op: 'addClass', name: 'Correcta', kind: 'class' }] }),
        {
          reasoning_content:
            'Podría ser {"operations":[{"op":"removeClass","ref":{"name":"Cliente"}}]}… no, mejor no.',
        },
      ),
    });

    const respuesta = await motor().interpret('crea la clase Correcta', diagrama);

    expect(respuesta.operations).toEqual([{ op: 'addClass', name: 'Correcta', kind: 'class' }]);
  });

  it('descarta entera una respuesta que no valida y recurre a la gramática', async () => {
    // Aceptar la mitad válida sería peor: el usuario vería una propuesta
    // coherente a medias y la aprobaría sin notar lo que falta.
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({
          operations: [
            { op: 'addClass', name: 'Pedido', kind: 'class' },
            { op: 'esto_no_existe', cosa: 'rara' },
          ],
        }),
      ),
    });

    const respuesta = await motor().interpret('crea la clase Pedido', diagrama);

    expect(respuesta.operations).toEqual([{ op: 'addClass', name: 'Pedido', kind: 'class' }]);
    // La operación inventada no aparece por ninguna parte, ni siquiera la
    // válida que la acompañaba: lo que se muestra viene de la gramática.
    expect(respuesta.explanation).toMatch(/sin conexión|sin el modelo remoto/);
  });

  it('degrada a la gramática cuando el proveedor devuelve un error', async () => {
    responder = () => ({ status: 402, payload: { error: 'Insufficient Balance' } });

    const respuesta = await motor().interpret('crea la clase Pedido', diagrama);

    // Degradación, no fallo: es la misma experiencia que sin conexión.
    expect(respuesta.operations).toEqual([{ op: 'addClass', name: 'Pedido', kind: 'class' }]);
  });

  it('degrada a la gramática cuando el modelo no responde a tiempo', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi('{}') });
    server.removeAllListeners('request');
    server.on('request', () => {
      /* se deja colgada a propósito */
    });

    const respuesta = await motor({ timeoutMs: 100 }).interpret('crea la clase Pedido', diagrama);

    expect(respuesta.operations).toEqual([{ op: 'addClass', name: 'Pedido', kind: 'class' }]);
  });

  it('sin gramática que lo entienda, pide una aclaración en vez de inventar', async () => {
    responder = () => ({ status: 500, payload: { error: 'boom' } });

    const respuesta = await motor().interpret('ya sabes lo que quiero', diagrama);

    expect(respuesta.operations).toHaveLength(0);
    expect(respuesta.clarification).toBeTruthy();
  });

  it('pide la respuesta como una lista de acciones', async () => {
    await motor().interpret('crea la clase Pedido', diagrama);

    const sistema = (recibidos[0]?.messages as { role: string; content: string }[])[0];
    expect(sistema?.role).toBe('system');
    expect(sistema?.content).toContain('"actions"');
  });

  it('lee las operaciones y los mensajes de la lista de acciones, en orden', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({
          actions: [
            { _type: 'think', text: 'Hace falta una clase nueva.' },
            { _type: 'message', text: 'Creo la clase Pedido.' },
            { _type: 'operation', operation: { op: 'addClass', name: 'Pedido', kind: 'class' } },
            { _type: 'message', text: '¿Le agrego atributos?' },
          ],
          confidence: 0.8,
        }),
      ),
    });

    const respuesta = await motor().interpret('crea la clase Pedido', diagrama);

    expect(respuesta.operations).toEqual([{ op: 'addClass', name: 'Pedido', kind: 'class' }]);
    expect(respuesta.explanation).toBe('Creo la clase Pedido. ¿Le agrego atributos?');
    expect(respuesta.confidence).toBe(0.8);
    expect(respuesta.clarification).toBeNull();
  });

  it('una respuesta con solo mensajes es una charla válida y no recurre a la gramática', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({
          actions: [{ _type: 'message', text: 'Tu diagrama se ve bien; a Cliente le falta un email.' }],
          confidence: 1,
        }),
      ),
    });

    const respuesta = await motor().interpret('¿qué te parece mi diagrama?', diagrama);

    expect(respuesta.operations).toEqual([]);
    expect(respuesta.explanation).toBe('Tu diagrama se ve bien; a Cliente le falta un email.');
    expect(respuesta.clarification).toBeNull();
  });

  it('descarta entera una lista de acciones con una operación inválida', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({
          actions: [
            { _type: 'message', text: 'Creo la clase.' },
            { _type: 'operation', operation: { op: 'inventada' } },
          ],
        }),
      ),
    });

    const respuesta = await motor().interpret('crea la clase Pedido', diagrama);

    // La gramática local entiende la orden: la respuesta viene de ella.
    expect(respuesta.operations).toEqual([expect.objectContaining({ op: 'addClass', name: 'Pedido' })]);
    expect(respuesta.explanation).not.toBe('Creo la clase.');
  });

  it('usa el protocolo de Anthropic cuando se le pide', async () => {
    responder = () => ({
      status: 200,
      payload: {
        // La respuesta empieza sin la llave porque se fuerza como prefijo.
        content: [{ type: 'text', text: '"operations":[],"confidence":0,"explanation":"nada"}' }],
      },
    });

    const conCabecera = new Promise<string | undefined>((resolve) => {
      server.once('request', (request) => resolve(request.headers['x-api-key'] as string));
    });

    const respuesta = await new LlmAssistant({
      apiKey: 'clave-de-prueba',
      provider: 'anthropic',
      baseUrl,
      model: 'modelo-de-prueba',
      timeoutMs: 1000,
    }).interpret('no importa qué', diagrama);

    expect(await conCabecera).toBe('clave-de-prueba');
    expect(respuesta.operations).toHaveLength(0);
  });
});

describe('LlmAssistant.interpretarEnStream contra un proveedor simulado', () => {
  it('reconoce eventos OpenAI aunque los fragmentos corten claves y cadenas, y no envía think', async () => {
    const json = JSON.stringify({
      actions: [
        { _type: 'message', text: 'Creo Pedido.' },
        { _type: 'think', text: 'razonamiento privado' },
        { _type: 'operation', operation: { op: 'addClass', name: 'Pedido', kind: 'class' } },
        { _type: 'message', text: 'Listo.' },
      ],
      confidence: 0.8,
    });
    const cortes = [json.indexOf('_type') + 2, json.indexOf('Creo') + 2].sort((a, b) => a - b);
    const trozos = [json.slice(0, cortes[0]), json.slice(cortes[0], cortes[1]), json.slice(cortes[1])];
    bloquesSse = [
      ...trozos.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
      'data: [DONE]\n\n',
    ];

    const eventos: EventoAsistente[] = [];
    for await (const evento of motor().interpretarEnStream('crea Pedido', diagrama)) eventos.push(evento);

    expect(eventos.some((evento) => evento.tipo === 'mensaje-parcial' && evento.texto.length > 0)).toBe(true);
    expect(eventos.filter((evento) => evento.tipo === 'mensaje').map((evento) => evento.texto)).toEqual([
      'Creo Pedido.',
      'Listo.',
    ]);
    expect(eventos.find((evento) => evento.tipo === 'operacion')).toMatchObject({
      tipo: 'operacion',
      operacion: { op: 'addClass', name: 'Pedido' },
    });
    expect(eventos.some((evento) => JSON.stringify(evento).includes('razonamiento privado'))).toBe(false);
    expect(eventos.at(-1)).toEqual({ tipo: 'fin', motor: motor().name, confianza: 0.8 });
    expect(recibidos[0]).toMatchObject({ stream: true, max_tokens: 4096 });
  });

  it('lee content_block_delta de Anthropic y mantiene el prefijo JSON abierto', async () => {
    const jsonSinLlave = '"actions":[{"_type":"message","text":"Hola"}],"confidence":1}';
    bloquesSse = [
      ...[jsonSinLlave.slice(0, 18), jsonSinLlave.slice(18)].map((text) =>
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        })}\n\n`,
      ),
      'event: message_stop\ndata: {}\n\n',
    ];

    const asistente = new LlmAssistant({ apiKey: 'clave', provider: 'anthropic', baseUrl, timeoutMs: 1000 });
    const eventos: EventoAsistente[] = [];
    for await (const evento of asistente.interpretarEnStream('hola', diagrama)) eventos.push(evento);

    expect(eventos).toContainEqual({ tipo: 'mensaje', texto: 'Hola' });
    expect(eventos.at(-1)).toMatchObject({ tipo: 'fin', confianza: 1 });
    expect(recibidos[0]).toMatchObject({ max_tokens: 4096, messages: [{ role: 'user' }, { role: 'assistant', content: '{' }] });
  });

  it('usa la gramática si el proveedor falla antes de producir un evento', async () => {
    responder = () => ({ status: 500, payload: { error: 'fallo del modelo' } });

    const eventos: EventoAsistente[] = [];
    for await (const evento of motor().interpretarEnStream('crea la clase Pedido', diagrama)) eventos.push(evento);

    expect(eventos).toContainEqual(expect.objectContaining({ tipo: 'operacion', operacion: expect.objectContaining({ op: 'addClass', name: 'Pedido' }) }));
    expect(eventos.at(-1)).toMatchObject({ tipo: 'fin', motor: 'gramatica-local' });
  });

  it('propaga como error una operación inválida después de haber enviado el mensaje anterior', async () => {
    const json = JSON.stringify({ actions: [
      { _type: 'message', text: 'Empiezo.' },
      { _type: 'operation', operation: { op: 'no-existe' } },
    ] });
    bloquesSse = [`data: ${JSON.stringify({ choices: [{ delta: { content: json } }] })}\n\n`, 'data: [DONE]\n\n'];
    const eventos: EventoAsistente[] = [];

    await expect(async () => {
      for await (const evento of motor().interpretarEnStream('hazlo', diagrama)) eventos.push(evento);
    }).rejects.toThrow();
    expect(eventos).toContainEqual({ tipo: 'mensaje', texto: 'Empiezo.' });
    expect(eventos.some((evento) => evento.tipo === 'operacion' || evento.tipo === 'fin')).toBe(false);
  });

  it('aplica el plazo máximo hasta recibir el primer byte del cuerpo', async () => {
    bloquesSse = [];
    dejarStreamAbierto = true;

    const eventos: EventoAsistente[] = [];
    for await (const evento of motor({ timeoutMs: 60 }).interpretarEnStream('crea la clase Pedido', diagrama)) {
      eventos.push(evento);
    }

    expect(eventos.at(-1)).toMatchObject({ tipo: 'fin', motor: 'gramatica-local' });
  });

  it('entiende una respuesta envuelta en vallas de código o con texto delante, como interpret', async () => {
    const json = JSON.stringify({
      actions: [
        { _type: 'message', text: 'Hola, creo la clase.' },
        { _type: 'operation', operation: { op: 'addClass', name: 'Pedido', kind: 'class' } },
      ],
      confidence: 0.9,
    });
    const respuesta = `Claro:\n\`\`\`json\n${json}\n\`\`\``;
    bloquesSse = [
      ...[respuesta.slice(0, 12), respuesta.slice(12, 40), respuesta.slice(40)].map(
        (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      ),
      'data: [DONE]\n\n',
    ];

    const eventos: EventoAsistente[] = [];
    for await (const evento of motor().interpretarEnStream('crea Pedido', diagrama)) eventos.push(evento);

    expect(eventos).toContainEqual({ tipo: 'mensaje', texto: 'Hola, creo la clase.' });
    expect(eventos.find((evento) => evento.tipo === 'operacion')).toMatchObject({
      operacion: { op: 'addClass', name: 'Pedido' },
    });
    expect(eventos.at(-1)).toEqual({ tipo: 'fin', motor: motor().name, confianza: 0.9 });
  });

  it('una respuesta cortada a medias no da por completa su última acción', async () => {
    const json = JSON.stringify({
      actions: [
        { _type: 'message', text: 'Creo Pedido.' },
        { _type: 'operation', operation: { op: 'addClass', name: 'Pedido', kind: 'class' } },
      ],
    });
    const cortada = json.slice(0, json.indexOf('Pedido",') + 3);
    bloquesSse = [`data: ${JSON.stringify({ choices: [{ delta: { content: cortada } }] })}\n\n`, 'data: [DONE]\n\n'];
    const eventos: EventoAsistente[] = [];

    await expect(async () => {
      for await (const evento of motor().interpretarEnStream('crea Pedido', diagrama)) eventos.push(evento);
    }).rejects.toThrow('la respuesta del modelo llegó incompleta');
    expect(eventos).toContainEqual({ tipo: 'mensaje', texto: 'Creo Pedido.' });
    expect(eventos.some((evento) => evento.tipo === 'operacion' || evento.tipo === 'fin')).toBe(false);
  });

  it('corta el stream si el proveedor deja de mandar trozos a mitad de respuesta', async () => {
    const empiezo = '{"actions":[{"_type":"message","text":"Empiezo.';
    bloquesSse = [`data: ${JSON.stringify({ choices: [{ delta: { content: empiezo } }] })}\n\n`];
    dejarStreamAbierto = true;

    const flujo = motor({ timeoutMs: 80 }).interpretarEnStream('crea Pedido', diagrama);
    const resultado = (async () => {
      for await (const _evento of flujo) {
        // Se consume hasta que se corta.
      }
    })();

    await expect(resultado).rejects.toThrow(/dejó de responder|no respondió/);
  });

  it('propaga la cancelación externa en vez de degradar a la gramática', async () => {
    const json = JSON.stringify({ actions: [{ _type: 'message', text: 'Hola' }] });
    bloquesSse = [`data: ${JSON.stringify({ choices: [{ delta: { content: json } }] })}\n\n`];
    dejarStreamAbierto = true;
    const abortador = new AbortController();
    const eventos: EventoAsistente[] = [];
    const flujo = motor().interpretarEnStream('hola', diagrama, undefined, abortador.signal);

    await expect(async () => {
      for await (const evento of flujo) {
        eventos.push(evento);
        if (evento.tipo === 'mensaje-parcial') abortador.abort();
      }
    }).rejects.toThrow();
    expect(eventos.some((evento) => evento.tipo === 'mensaje-parcial')).toBe(true);
    expect(eventos.some((evento) => evento.tipo === 'fin')).toBe(false);
  });
});

const diagramaProblematico = createDiagram({
  id: 'D2',
  name: 'Prueba',
  classes: {
    C1: createClass({
      id: 'C1',
      name: 'Factura',
      attributes: [createAttribute({ id: 'A1', name: 'precio', type: 'String' })],
    }),
  },
});

describe('GrammarAssistant.revisar', () => {
  it('un diagrama sin nada que objetar no produce comentario', async () => {
    expect(await new GrammarAssistant().revisar(diagrama)).toBeNull();
  });

  it('con un hallazgo, lo convierte en un comentario en primera persona', async () => {
    const comentario = await new GrammarAssistant().revisar(diagramaProblematico);
    expect(comentario).toContain('He revisado el diagrama');
    expect(comentario).toContain('Factura.precio');
  });
});

describe('LlmAssistant.revisar contra un proveedor simulado', () => {
  it('manda el prompt de revisión, no el de interpretar órdenes', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi('NADA') });
    await motor().revisar(diagrama);

    const mensajes = recibidos[0]?.messages as { role: string; content: string }[];
    const sistema = mensajes.find((m) => m.role === 'system')?.content ?? '';
    expect(sistema).toContain('hablas sin que nadie te haya preguntado nada');
  });

  it('cuando el modelo responde NADA, no hay comentario', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi('NADA') });
    expect(await motor().revisar(diagrama)).toBeNull();
  });

  it('devuelve el comentario del modelo tal cual, sin pasarlo por JSON', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi('Esta relación entre Factura y Cliente parece de agregación.'),
    });

    const comentario = await motor().revisar(diagrama);
    expect(comentario).toBe('Esta relación entre Factura y Cliente parece de agregación.');
  });

  it('degrada al revisor local cuando el proveedor falla', async () => {
    responder = () => ({ status: 500, payload: { error: 'boom' } });

    const comentario = await motor().revisar(diagramaProblematico);
    // La misma salida que daría GrammarAssistant.revisar sobre el mismo diagrama.
    expect(comentario).toContain('He revisado el diagrama');
    expect(comentario).toContain('Factura.precio');
  });
});

describe('createAssistant', () => {
  it('sin clave devuelve la gramática, que no es un modo degradado', () => {
    const motorSinClave = createAssistant({});
    expect(motorSinClave).toBeInstanceOf(GrammarAssistant);
  });

  it('con clave devuelve el motor remoto, con el modelo en el nombre', () => {
    const remoto = createAssistant({ llmApiKey: 'k', llmProvider: 'openai', llmModel: 'algo' });
    expect(remoto).toBeInstanceOf(LlmAssistant);
    expect(remoto.name).toContain('algo');
  });
});

describe('createVisionEngine', () => {
  it('sin modelo de visión no hay motor, aunque sobre la clave', () => {
    expect(createVisionEngine({ llmApiKey: 'k' })).toBeUndefined();
  });

  it('hereda la clave del texto cuando la visión va al mismo proveedor', () => {
    const motor = createVisionEngine({
      llmApiKey: 'k',
      llmBaseUrl: 'https://api.deepseek.com',
      llmVisionModel: 'algo-con-vision',
    });
    expect(motor?.model).toBe('algo-con-vision');
  });

  /*
   * Esta es la importante. Con la visión apuntando a Google y sin clave propia,
   * heredar la del texto le entregaría a Google la clave de DeepSeek: un secreto
   * enviado a un tercero por un descuido de configuración, sin que nadie lo pida
   * ni se entere. Antes que eso, la lectura de fotos se queda desactivada.
   */
  it('no le presta a un proveedor la clave de otro', () => {
    const motor = createVisionEngine({
      llmApiKey: 'clave-de-deepseek',
      llmBaseUrl: 'https://api.deepseek.com',
      llmVisionModel: 'gemini-3.6-flash',
      llmVisionBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      llmVisionApiKey: '',
    });
    expect(motor).toBeUndefined();
  });

  it('trata una variable escrita pero vacía como si no estuviera', () => {
    // `LLM_VISION_API_KEY=` en un .env llega como cadena vacía, no como
    // `undefined`; con `??` habría pasado por clave buena.
    expect(
      createVisionEngine({ llmApiKey: '', llmVisionApiKey: '', llmVisionModel: 'm' }),
    ).toBeUndefined();
  });

  /*
   * La reserva se configura en la misma variable, separada por comas, y no en
   * una `LLM_VISION_MODEL_2` aparte. Dos variables obligan a acordarse de que la
   * segunda existe; una lista se lee de un vistazo y admite tres modelos sin
   * inventar `LLM_VISION_MODEL_3`. Lo que sí hay que sujetar es que un solo
   * nombre —el caso normal, y el que hay hoy en todas las instalaciones— siga
   * comportándose exactamente igual que antes de que existiera la cadena.
   */
  it('reparte LLM_VISION_MODEL en preferido y reserva', () => {
    const motor = createVisionEngine({
      llmApiKey: 'k',
      llmVisionModel: 'gemini-3-flash, gemini-2.5-flash',
    });
    // `model` es la cadena configurada, para diagnóstico; quién contestó de
    // verdad viaja en cada lectura.
    expect(motor?.model).toBe('gemini-3-flash, gemini-2.5-flash');
  });

  it('aguanta comas sobrantes sin fabricar un modelo vacío', () => {
    // `LLM_VISION_MODEL=algo,` es un descuido corriente al editar un .env, y un
    // nombre vacío en la cadena sería una llamada garantizada a fallar.
    const motor = createVisionEngine({ llmApiKey: 'k', llmVisionModel: ' algo-con-vision , ' });
    expect(motor?.model).toBe('algo-con-vision');
  });

  it('una variable con solo comas no monta motor', () => {
    expect(createVisionEngine({ llmApiKey: 'k', llmVisionModel: ' , ' })).toBeUndefined();
  });
});

describe('OpenAiVisionEngine contra un proveedor simulado', () => {
  function vision(overrides: Record<string, unknown> = {}) {
    return new OpenAiVisionEngine({
      apiKey: 'clave-de-prueba',
      model: 'vision-de-prueba',
      baseUrl,
      timeoutMs: 1000,
      // La espera entre reintentos es de casi un segundo en producción, a
      // propósito. Aquí se baja a 1 ms: lo que hay que comprobar es a cuántos
      // fallos se reintenta y a cuáles no, no cuánto se duerme entre medias.
      pausaMs: 1,
      ...overrides,
    });
  }

  const tablaValida = {
    tabla: 'Empleado',
    columnas: [{ nombre: 'id', tipo: 'Long', esClave: true }],
    filas: [['1']],
    confianza: 0.8,
    ilegible: [],
  };

  it('empotra la imagen en la petición en lugar de exponerla en una URL', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi(JSON.stringify(tablaValida)) });

    await vision().extraerTabla('QUJD', 'image/png');

    const mensajes = recibidos[0]?.messages as { content: { type: string; image_url?: { url: string } }[] }[];
    const imagen = mensajes[0]?.content.find((parte) => parte.type === 'image_url');
    expect(imagen?.image_url?.url).toBe('data:image/png;base64,QUJD');
  });

  it('devuelve la tabla cuando el modelo responde con la forma esperada', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi(JSON.stringify(tablaValida)) });

    const { datos: tabla, modelo } = await vision().extraerTabla('QUJD', 'image/png');
    expect(tabla.tabla).toBe('Empleado');
    // La lectura dice quién la hizo. Con un solo modelo configurado es el mismo
    // de siempre; lo que importa es que el dato viaje con ella y no en el motor.
    expect(modelo).toBe('vision-de-prueba');
  });

  it('descarta entera una tabla a medias en vez de devolverla incompleta', async () => {
    // Columnas sí, filas rotas: parece una lectura correcta y no lo es, y quien
    // revisa aprobaría lo que ve sin saber que falta la mitad.
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({
          tabla: 'Empleado',
          columnas: [{ nombre: 'id', tipo: 'Long', esClave: true }],
          filas: 'no es lista',
        }),
      ),
    });

    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.toBeInstanceOf(ErrorDeModelo);
  });

  /*
   * «No hay ninguna tabla aquí» es la respuesta que la propia instrucción le
   * pide al modelo cuando no ve una, y sin embargo el esquema exige al menos una
   * columna. Esa contradicción salía a la pantalla como «la respuesta del modelo
   * no tiene la forma esperada: columnas: Array must contain at least 1
   * element(s)», que parece una avería del programa. Es además el síntoma exacto
   * de haber configurado en LLM_VISION_MODEL un modelo que no sabe mirar
   * imágenes: no ve nada, dice que no hay tabla, y el mensaje no ayudaba a
   * descubrirlo.
   */
  it('no llama avería a que el modelo diga que no hay ninguna tabla', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(JSON.stringify({ tabla: '', columnas: [], ilegible: ['un gato'] })),
    });

    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.toThrow(
      /no ha encontrado ninguna tabla/,
    );
    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.not.toThrow(/forma esperada/);
  });

  it('cuenta lo que el modelo dice ver, que es la única pista de por qué falló', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({ tabla: '', columnas: [], ilegible: ['una foto de un perro'] }),
      ),
    });

    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.toThrow(
      /una foto de un perro/,
    );
  });

  it('sin explicación, apunta al modelo mal configurado', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(JSON.stringify({ tabla: '', columnas: [], ilegible: [] })),
    });

    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.toThrow(/LLM_VISION_MODEL/);
  });

  it('avisa cuando la respuesta ni siquiera es JSON', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi('no veo ninguna tabla en la imagen') });

    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.toThrow(/JSON/);
  });

  /*
   * Una respuesta cortada por el límite de tokens llegaba disfrazada de error de
   * sintaxis, y ese disfraz costó una tarde.
   *
   * Lo que se veía en pantalla era «la respuesta no era JSON: Expected ',' or
   * ']' after array element in JSON at position 1503»: un mensaje que señala una
   * posición exacta del texto y que por tanto invita a buscar el fallo en el
   * parseador o en lo que el modelo escribió mal. No había nada mal escrito. Al
   * modelo no le dejaron terminar, y `extractJson` —que recorta de la primera
   * `{` a la última `}`— cerró el recorte en la llave de un objeto interior,
   * dejando una lista abierta.
   *
   * Estas tres pruebas fijan que la causa se diga con su nombre. La tercera es
   * la que más se olvida: un modelo que razona puede gastarse el presupuesto
   * entero pensando y devolver el contenido vacío, y eso salía como «el modelo
   * devolvió una respuesta vacía», que suena a avería del proveedor cuando se
   * arregla subiendo un número.
   */
  it('llama corte a un corte, en vez de error de sintaxis', async () => {
    const truncado = '{"tabla":"Empleado","columnas":[{"nombre":"id","tipo":"Long"}';
    responder = () => ({
      status: 200,
      payload: { choices: [{ message: { content: truncado }, finish_reason: 'length' }] },
    });

    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.toThrow(/se cortó/);
  });

  it('no manda a depurar el JSON cuando el problema es el presupuesto', async () => {
    const truncado = '{"clases":[{"nombre":"Cliente","atributos":[{"nombre":"id"}';
    responder = () => ({
      status: 200,
      payload: { choices: [{ message: { content: truncado }, finish_reason: 'length' }] },
    });

    // Lo que NO debe decir importa tanto como lo que dice: mientras el mensaje
    // hable de sintaxis, se busca el fallo donde no está.
    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.not.toThrow(
      /no era JSON|Expected/,
    );
    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /LLM_VISION_MAX_TOKENS/,
    );
  });

  it('un modelo que se gasta el presupuesto pensando no es una respuesta vacía', async () => {
    responder = () => ({
      status: 200,
      payload: { choices: [{ message: { content: '' }, finish_reason: 'length' }] },
    });

    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(/se cortó/);
    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.not.toThrow(
      /respuesta vacía/,
    );
  });

  it('pide sitio de sobra por defecto, y respeta el techo configurado', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi(JSON.stringify(tablaValida)) });

    await vision().extraerTabla('QUJD', 'image/png');
    // 4096 era el valor viejo y es justo el que provocaba el corte con un
    // diagrama mediano; que la prueba nombre el número evita volver a bajarlo
    // sin darse cuenta.
    expect(recibidos[0]?.max_tokens).toBe(32_768);

    await vision({ maxTokens: 8000 }).extraerTabla('QUJD', 'image/png');
    expect(recibidos[1]?.max_tokens).toBe(8000);
  });

  it('avisa cuando la respuesta viene vacía', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi('   ') });

    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.toThrow(/vacía/);
  });

  it('propaga el motivo del proveedor, que es lo único accionable', async () => {
    responder = () => ({ status: 402, payload: 'Insufficient Balance' });

    await expect(vision().extraerTabla('QUJD', 'image/png')).rejects.toThrow(
      /Insufficient Balance/,
    );
  });

  // -------------------------------------------------------------------------
  // Lectura de un diagrama de clases entero
  // -------------------------------------------------------------------------

  const diagramaValido = {
    clases: [
      { nombre: 'Class A', estereotipo: 'class', atributos: [], filas: [] },
      { nombre: 'Class B', estereotipo: 'class', atributos: [], filas: [] },
    ],
    relaciones: [
      {
        origen: 'Class A',
        destino: 'Class B',
        tipo: 'association',
        cardinalidadOrigen: '1',
        cardinalidadDestino: '0..*',
        nombre: 'Association A',
      },
    ],
    confianza: 0.8,
    ilegible: [],
  };

  it('devuelve el diagrama cuando el modelo responde con la forma esperada', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi(JSON.stringify(diagramaValido)) });

    const { datos: diagrama } = await vision().extraerDiagrama('QUJD', 'image/png');
    expect(diagrama.clases).toHaveLength(2);
    // La cardinalidad llega cruda hasta aquí; canonizarla es trabajo del
    // intérprete, no del transporte.
    expect(diagrama.relaciones[0]?.cardinalidadDestino).toBe('0..*');
  });

  it('le pide al modelo que deje la cardinalidad vacía antes que suponerla', async () => {
    responder = () => ({ status: 200, payload: comoOpenAi(JSON.stringify(diagramaValido)) });

    await vision().extraerDiagrama('QUJD', 'image/png');

    const mensajes = recibidos[0]?.messages as { content: { type: string; text?: string }[] }[];
    const texto = mensajes[0]?.content.find((parte) => parte.type === 'text')?.text ?? '';
    // Es la instrucción de la que depende que una cardinalidad ilegible se marque
    // como dudosa en vez de colarse inventada en el esquema.
    expect(texto).toMatch(/NO la supongas/);
    expect(texto).toMatch(/diagrama de clases/);
  });

  it('descarta entero un diagrama con las relaciones rotas', async () => {
    // Clases bien y relaciones mal se aprueba de un vistazo, y genera un esquema
    // al que le faltan claves foráneas que nadie echa en falta hasta muy tarde.
    responder = () => ({
      status: 200,
      payload: comoOpenAi(
        JSON.stringify({ clases: [{ nombre: 'A' }], relaciones: 'no es lista' }),
      ),
    });

    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.toBeInstanceOf(
      ErrorDeModelo,
    );
  });

  it('no llama avería a que el modelo diga que no hay ningún diagrama', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(JSON.stringify({ clases: [], ilegible: ['una foto de un perro'] })),
    });

    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /una foto de un perro/,
    );
    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.not.toThrow(
      /forma esperada/,
    );
  });

  it('sin explicación, apunta al modelo mal configurado', async () => {
    responder = () => ({
      status: 200,
      payload: comoOpenAi(JSON.stringify({ clases: [], ilegible: [] })),
    });

    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /LLM_VISION_MODEL/,
    );
  });

  // -------------------------------------------------------------------------
  // Reintentos ante un fallo pasajero del proveedor
  //
  // Un `503 UNAVAILABLE` de la capa gratuita de Gemini le costaba al usuario
  // volver a subir la foto por algo que se arregla solo esperando un segundo.
  // Lo que hay que sujetar con pruebas es la frontera: qué se reintenta y qué
  // no. Reintentar de más es peor que no reintentar, porque convierte una clave
  // mal escrita en una espera larga que acaba en el mismo error.
  // -------------------------------------------------------------------------

  it('reintenta un 503 y devuelve el diagrama cuando el proveedor se recupera', async () => {
    let llamadas = 0;
    responder = () => {
      llamadas += 1;
      return llamadas === 1
        ? { status: 503, payload: { error: { code: 503, message: 'high demand' } } }
        : { status: 200, payload: comoOpenAi(JSON.stringify(diagramaValido)) };
    };

    const { datos: leido } = await vision().extraerDiagrama('QUJD', 'image/png');

    expect(leido.clases).toHaveLength(2);
    expect(llamadas).toBe(2);
  });

  it('se rinde tras agotar los reintentos y deja ver el motivo', async () => {
    responder = () => ({
      status: 503,
      payload: { error: { code: 503, message: 'high demand' } },
    });

    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(/high demand/);
    // Tres intentos: el original más los dos reintentos por defecto.
    expect(recibidos).toHaveLength(3);
  });

  it('no reintenta un 402: sin saldo no se arregla insistiendo', async () => {
    responder = () => ({ status: 402, payload: 'Insufficient Balance' });

    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /Insufficient Balance/,
    );
    expect(recibidos).toHaveLength(1);
  });

  it('no reintenta un 404: el modelo retirado lo sigue estando', async () => {
    responder = () => ({ status: 404, payload: 'no longer available' });

    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /no longer available/,
    );
    expect(recibidos).toHaveLength(1);
  });

  it('respeta que le pidan no reintentar', async () => {
    responder = () => ({ status: 503, payload: 'high demand' });

    await expect(
      vision({ reintentos: 0 }).extraerDiagrama('QUJD', 'image/png'),
    ).rejects.toThrow(/high demand/);
    expect(recibidos).toHaveLength(1);
  });

  it('la lectura de tablas se reintenta igual que la de diagramas', async () => {
    // Las dos comparten transporte justamente para que no se arreglen por
    // separado. Si un día alguien mete el reintento solo en una, esto lo dice.
    let llamadas = 0;
    responder = () => {
      llamadas += 1;
      return llamadas === 1
        ? { status: 503, payload: 'high demand' }
        : { status: 200, payload: comoOpenAi(JSON.stringify(tablaValida)) };
    };

    const { datos: tabla } = await vision().extraerTabla('QUJD', 'image/png');

    expect(tabla.tabla).toBe('Empleado');
    expect(llamadas).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Cadena de modelos de reserva
  //
  // Lo de arriba reintenta contra el mismo modelo, y eso tiene un techo: tres
  // intentos con espera creciente son unos dos segundos y medio, mientras que un
  // `503 UNAVAILABLE` de la capa gratuita de Gemini dura minutos. Insistirle más
  // al mismo modelo no lo despierta; preguntarle a otro sí.
  //
  // Lo que hay que sujetar aquí no es que la cadena funcione —eso es un bucle—
  // sino su frontera, que es donde está el daño: encadenar de más convierte una
  // clave sin saldo, o una foto ilegible, en tres llamadas de pago que acaban en
  // el mismo error y de paso tapan el diagnóstico bueno.
  // -------------------------------------------------------------------------

  /** Los modelos que se han pedido, en orden, según lo que recibió el servidor. */
  function modelosPedidos(): string[] {
    return recibidos.map((cuerpo) => cuerpo.model as string);
  }

  const conReserva = { model: 'saturado', modelosDeReserva: ['de-reserva'] };

  it('cuando el preferido da 503, contesta el de reserva', async () => {
    responder = (cuerpo) =>
      (cuerpo as { model: string }).model === 'saturado'
        ? { status: 503, payload: { error: { code: 503, message: 'high demand' } } }
        : { status: 200, payload: comoOpenAi(JSON.stringify(diagramaValido)) };

    const { datos: leido, modelo } = await vision(conReserva).extraerDiagrama('QUJD', 'image/png');

    expect(leido.clases).toHaveLength(2);
    // Y la lectura dice quién la hizo de verdad. Si esto devolviera «saturado»,
    // la línea «modelo: X» de la pantalla de revisión sería una mentira, y es
    // justo la línea que alguien mirará dentro de un mes para explicar por qué
    // dos lecturas de la misma foto salieron distintas.
    expect(modelo).toBe('de-reserva');
    // Al preferido se le insistió las tres veces antes de pasar al siguiente.
    expect(modelosPedidos()).toEqual(['saturado', 'saturado', 'saturado', 'de-reserva']);
  });

  it('cuando el preferido está retirado (404), pregunta al siguiente', async () => {
    // Un 404 no se reintenta —el modelo retirado lo sigue estando— pero sí
    // cambia de modelo, que es el caso de quien deja en el .env el nombre de una
    // versión que el proveedor ya jubiló.
    responder = (cuerpo) =>
      (cuerpo as { model: string }).model === 'saturado'
        ? { status: 404, payload: 'model not found' }
        : { status: 200, payload: comoOpenAi(JSON.stringify(diagramaValido)) };

    const { modelo } = await vision(conReserva).extraerDiagrama('QUJD', 'image/png');

    expect(modelo).toBe('de-reserva');
    expect(modelosPedidos()).toEqual(['saturado', 'de-reserva']);
  });

  it('un 402 no pasa al siguiente: la cadena entera comparte la misma clave', async () => {
    // Sin esta frontera, quedarse sin saldo costaría el doble de espera para
    // enseñar exactamente el mismo mensaje.
    responder = () => ({ status: 402, payload: 'Insufficient Balance' });

    await expect(vision(conReserva).extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /Insufficient Balance/,
    );
    expect(modelosPedidos()).toEqual(['saturado']);
  });

  it('una clave rechazada tampoco pasa al siguiente', async () => {
    responder = () => ({ status: 401, payload: 'invalid api key' });

    await expect(vision(conReserva).extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /invalid api key/,
    );
    expect(modelosPedidos()).toEqual(['saturado']);
  });

  it('una respuesta ilegible no pasa al siguiente: el modelo sí contestó', async () => {
    // El modelo miró la foto y dijo que no había ningún diagrama. Eso no es un
    // modelo caído, y preguntarle a otro no va a hacer que aparezca uno: solo
    // gastaría otra llamada para acabar en el mismo sitio, tapando el único
    // diagnóstico que sirve cuando la foto está mal.
    responder = () => ({
      status: 200,
      payload: comoOpenAi(JSON.stringify({ clases: [], ilegible: ['una foto de un gato'] })),
    });

    await expect(vision(conReserva).extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /una foto de un gato/,
    );
    expect(modelosPedidos()).toEqual(['saturado']);
  });

  it('agotar la cadena deja dicho qué contestó cada modelo', async () => {
    // Agotar la cadena y fallar el primer intento producían el mismo texto, y
    // significan cosas distintas: lo primero es que no queda nada por probar;
    // lo segundo, que sí. De esa diferencia depende que alguien espere un minuto
    // o se vaya al XMI. Y no basta con decir a quién se preguntó: lo accionable
    // es qué respondió cada uno.
    responder = () => ({ status: 503, payload: { error: { code: 503, message: 'high demand' } } });

    await expect(vision(conReserva).extraerDiagrama('QUJD', 'image/png')).rejects.toThrow(
      /se probaron 2 modelos → saturado: 503 saturado; de-reserva: 503 saturado/,
    );
    // Tres intentos contra cada uno de los dos.
    expect(recibidos).toHaveLength(6);
  });

  /*
   * El caso que se vio en pantalla, y que este código llegó a empeorar.
   *
   * Con `gemini-3.6-flash,gemini-2.5-flash` el preferido cayó saturado y el de
   * reserva contestó un 404: «gemini-2.5-flash ya no está disponible, use
   * gemini-3.6-flash». Como el error que se propagaba era el último, lo que
   * llegó al usuario fue ese 404, con una explicación que mandaba a corregir
   * LLM_VISION_MODEL nombrando como sustituto **el modelo que ya estaba en
   * primera posición**. Un error que describe al suplente y manda a arreglar lo
   * que ya estaba bien.
   */
  it('el titular es el fallo del preferido, no el del suplente', async () => {
    responder = (cuerpo) =>
      (cuerpo as { model: string }).model === 'saturado'
        ? { status: 503, payload: { error: { code: 503, message: 'high demand' } } }
        : { status: 404, payload: 'gemini-2.5-flash is no longer available, use gemini-3.6-flash' };

    let fallo: unknown;
    try {
      await vision(conReserva).extraerDiagrama('QUJD', 'image/png');
    } catch (error) {
      fallo = error;
    }

    expect(fallo).toBeInstanceOf(ErrorDeModelo);
    const { status, message } = fallo as ErrorDeModelo;
    // El estado que sobrevive es el del preferido: 503 y no 404. De él cuelga la
    // explicación que ve el usuario, y la del 404 mandaba a mirar donde no había
    // nada que arreglar.
    expect(status).toBe(503);
    expect(message).toMatch(/high demand/);
    // Pero el suplente no se pierde: sin esta parte, «se probaron 2 modelos» no
    // dice que el segundo nombre está muerto, que es lo único que hay que tocar.
    expect(message).toMatch(/de-reserva: 404 el proveedor no lo conoce/);
  });

  it('sin reserva configurada el mensaje no habla de una cadena que no existe', async () => {
    responder = () => ({ status: 503, payload: { error: { code: 503, message: 'high demand' } } });

    await expect(vision().extraerDiagrama('QUJD', 'image/png')).rejects.not.toThrow(/se probaron/);
  });

  it('la lectura de tablas también encadena', async () => {
    // Igual que con los reintentos: las dos lecturas comparten camino para que
    // no se arreglen por separado.
    responder = (cuerpo) =>
      (cuerpo as { model: string }).model === 'saturado'
        ? { status: 503, payload: 'high demand' }
        : { status: 200, payload: comoOpenAi(JSON.stringify(tablaValida)) };

    const { datos: tabla, modelo } = await vision(conReserva).extraerTabla('QUJD', 'image/png');

    expect(tabla.tabla).toBe('Empleado');
    expect(modelo).toBe('de-reserva');
  });
});
