import type { AssistantResponse, ClassDiagram, EventoAsistente } from '@app/shared';
import {
  AssistantActionSchema,
  describeOperation,
  interpretCommand,
  listSupportedTypes,
  parseAssistantResponse,
  revisarDiagrama,
} from '@app/shared';
import type { ChatMessage } from '../storage/conversaciones.js';
import { leerStreamDelModelo, pedirAlModelo } from './transporte.js';
import { cerrarYParsearJson } from './json-incompleto.js';

/**
 * Explicación general del módulo:
 * Este archivo gestiona el "asistente inteligente" para crear diagramas.
 * Funciona con dos motores: 
 * 1. Un modelo de inteligencia artificial (cuando hay internet).
 * 2. Una gramática local fija (cuando no hay internet o falla el modelo).
 */

/**
 * Un turno del historial ya con el nombre de quien lo escribió resuelto. El
 * propio `ChatMessage` solo guarda `autorId`; `api/assistant.ts` lo resuelve a
 * nombre (igual que `conNombres` en `api/tablon.ts`) para pintarlo en pantalla.
 */
export interface TurnoConAutor extends ChatMessage {
  autorNombre: string | null;
}

/**
 * Lo que el Modo IA sabe además del diagrama: la propia conversación de quien
 * pregunta (para que "ahora añádele X" se entienda sin repetir de qué clase se
 * habla) y, solo como dato de contexto, el nombre de otros proyectos de
 * este mismo usuario (nunca su contenido: ver `api/assistant.ts` y
 * `storage/conversaciones.ts` para la garantía de aislamiento por proyecto).
 */
export interface AssistantContext {
  historial: TurnoConAutor[];
  otrosProyectos: string[];
}

// Define la "plantilla" o contrato que debe cumplir cualquier motor de asistente:
// debe tener un nombre y una función para interpretar lo que pide el usuario.
export interface AssistantEngine {
  readonly name: string;
  interpret(prompt: string, diagram: ClassDiagram, contexto?: AssistantContext): Promise<AssistantResponse>;
  interpretarEnStream?(
    prompt: string,
    diagram: ClassDiagram,
    contexto?: AssistantContext,
    signal?: AbortSignal,
  ): AsyncIterable<EventoAsistente>;
  /**
   * Mira el diagrama sin que nadie haya preguntado nada y decide si hay algo
   * que merezca la pena decirle a quien lo acaba de cambiar. Devuelve
   * `null` cuando no hay nada que comentar, que es la respuesta correcta casi
   * siempre: hablar en cada cambio por hablar sería ruido, no ayuda.
   *
   * Nunca propone operaciones (decisión D6, también aquí): es solo texto, el
   * mismo tipo de voz que `explanation` en `interpret`.
   */
  revisar(diagram: ClassDiagram, contexto?: AssistantContext): Promise<string | null>;
}

/**
 * MOTOR 1: El asistente sin conexión (Gramática Local).
 * No necesita internet ni IA. Lee la petición del usuario y la traduce directamente
 * usando reglas fijas y predeterminadas.
 */
export class GrammarAssistant implements AssistantEngine {
  readonly name = 'gramatica-local';

  // Función que recibe la petición en texto y devuelve la orden traducida localmente.
  async interpret(prompt: string): Promise<AssistantResponse> {
    return interpretCommand(prompt);
  }

  async *interpretarEnStream(prompt: string, diagram: ClassDiagram): AsyncGenerator<EventoAsistente> {
    const respuesta = await this.interpret(prompt);
    const mensaje = respuesta.clarification || respuesta.explanation;
    if (mensaje) yield { tipo: 'mensaje', texto: mensaje };
    for (const operacion of respuesta.operations) {
      yield { tipo: 'operacion', operacion, descripcion: describeOperation(operacion) };
    }
    yield { tipo: 'fin', motor: this.name, confianza: respuesta.confidence };
  }

  // Versión sin conexión de "hablar sola": usa el mismo revisor de calidad de
  // modelado que ya tenía el proyecto (`revisarDiagrama`, en `@app/shared`),
  // pensado desde su propio comentario de cabecera para que lo reutilizara el
  // asistente. El hallazgo más grave ya viene primero (`revisarDiagrama`
  // ordena por gravedad), así que basta con tomar el primero.
  async revisar(diagram: ClassDiagram): Promise<string | null> {
    const [principal] = revisarDiagrama(diagram);
    if (!principal) return null;
    return `He revisado el diagrama: ${principal.titulo}. ${principal.detalle}`;
  }
}

// INSTRUCCIONES SECRETAS PARA LA IA (System Prompt):
// Este texto en mayúsculas es la "nota de entrenamiento" que se le envía a la IA
// para indicarle exactamente cómo debe comportarse, qué operaciones puede hacer
// y exigirle que responda ÚNICAMENTE en un formato estructurado (JSON).
const SYSTEM_PROMPT = `Eres un asistente de modelado UML con el que el usuario conversa, en castellano, sobre su diagrama de clases. Unas veces te pide cambios y los traduces a operaciones; otras te pregunta, te pide opinión o solo charla, y entonces contestas sin proponer ningún cambio.

Cuando el mensaje incluya turnos anteriores de esta misma conversación, ya los has leído: no te vuelvas a presentar ni repitas lo ya dicho, y entiende referencias como "ahora", "esa clase" o "lo de antes" igual que lo haría alguien que lleva un rato colaborando en este proyecto contigo. Tus mensajes son tu voz: pueden saludar, reconocer lo que ya se habló, opinar sobre el diagrama o hacer una pregunta de aclaración en tono natural y breve, sin dejar de ser precisos sobre qué cambios haces y por qué. Esto no cambia ninguna regla de las operaciones.

Esta conversación es solo entre tú y esta persona: otros integrantes del proyecto tienen su propio hilo contigo, y lo que hablaste con ellos no está aquí. El diagrama, en cambio, es compartido, y pueden haberlo cambiado otros.

Respondes ÚNICAMENTE con un objeto JSON, sin texto alrededor y sin vallas de código, con esta forma:
{"actions": [...], "confidence": 0.0-1.0}

Cada acción es uno de estos objetos, y "_type" va siempre primero:
- {"_type":"think","text":"..."}: razonamiento breve para ti; el usuario no lo ve.
- {"_type":"message","text":"..."}: lo que le dices al usuario. Una o dos frases.
- {"_type":"operation","operation":{...}}: un cambio en el diagrama.
- {"_type":"point","classes":["Nombre"]}: señala esas clases en el lienzo, por su nombre exacto, sin cambiarlas. Úsalo cuando hables de clases concretas («esta clase de aquí»), justo antes del mensaje que las menciona.

Las acciones se ejecutan en el orden en que las escribes. Intercala mensajes y operaciones como lo haría alguien que narra lo que va haciendo ("Creo Cliente y Pedido." → operaciones → "Listo, ¿les agrego atributos?"). Toda respuesta lleva al menos un "message". Si solo te preguntan o te piden opinión, responde solo con mensajes, sin operaciones.

Cada operación es uno de estos objetos:
- {"op":"addClass","name":"Pascal","kind":"class|interface|enum|abstract","position":{"x":n,"y":n}}
- {"op":"renameClass","ref":{"name":"X"},"name":"Y"}
- {"op":"removeClass","ref":{"name":"X"}}
- {"op":"moveClass","ref":{"name":"X"},"position":{"x":n,"y":n}}
- {"op":"setClassKind","ref":{"name":"X"},"kind":"class|interface|enum|abstract"}
- {"op":"addAttribute","classRef":{"name":"X"},"name":"camelCase","type":"T","visibility":"-","isIdentifier":false,"isNullable":true,"isUnique":false}
- {"op":"updateAttribute","classRef":{"name":"X"},"attributeName":"a","changes":{...}}
- {"op":"removeAttribute","classRef":{"name":"X"},"attributeName":"a"}
- {"op":"addMethod","classRef":{"name":"X"},"name":"m","returnType":"T"|null,"parameters":[{"name":"p","type":"T"}],"visibility":"+"}
- {"op":"removeMethod","classRef":{"name":"X"},"methodName":"m"}
- {"op":"addRelation","kind":"association|aggregation|composition|inheritance|realization|dependency","source":{"name":"A"},"target":{"name":"B"},"sourceMultiplicity":"1","targetMultiplicity":"*","associationClassName":"X"}
- {"op":"removeRelation","id":"..."}
- {"op":"setAssociationClass","relationId":"...","classRef":{"name":"X"}|null}
- {"op":"addEnumLiteral","classRef":{"name":"X"},"literal":"LITERAL"}
- {"op":"setSeedRows","classRef":{"name":"X"},"rows":[{"atributo":"valor"}]}
- {"op":"removeSeedRow","classRef":{"name":"X"},"index":1}

Reglas:
- Referencia las clases por nombre, exactamente como aparecen en el diagrama actual.
- Tipos admitidos: TIPOS. No inventes otros; para referirte a otra clase usa una relación, no un atributo.
- En "A tiene muchos B", la multiplicidad del extremo A es "1" y la de B es "*".
- Si la petición de un cambio es ambigua o falta un dato, no escribas operaciones: pregunta qué falta en un "message". No adivines.
- No elimines nada que el usuario no haya pedido eliminar explícitamente.
- "setSeedRows" sustituye TODAS las filas de datos de ejemplo de la clase. Úsala solo si el usuario dicta el contenido completo; para añadir una fila a las que ya hay, repite las anteriores. Las claves de cada fila son nombres de atributos de esa clase, y todos los valores van como texto.
- "removeSeedRow" usa índice de base 1, tal como se dice: «borra la segunda fila» es index 2.
- "associationClassName" en "addRelation" es opcional y solo tiene efecto si la relación es muchos a muchos (ambas multiplicidades "*" o "0..*", etc.): crea de una vez la clase intermedia con ese nombre y la cuelga de la relación. Úsalo cuando el usuario pida una "clase de asociación" o una "clase intermedia" entre dos clases con relación N:M; para colgar una clase que ya existe sobre una relación N:M ya creada usa "setAssociationClass" en su lugar.
- Los datos de ejemplo son filas de una tabla del proyecto generado, no registros de una base de datos en producción: no hay ninguna operación que borre datos reales, y no debes ofrecerla.
- Cada línea de relación del resumen del diagrama actual trae su id real entre corchetes, por ejemplo «[id:r1] A 1 --association--> * B»: cópialo tal cual en "removeRelation" cuando haya que borrar esa relación. No inventes ni adivines un id: si la relación a borrar no aparece con su id en el resumen, no propongas "removeRelation" y dilo en un "message".

Patrón de diseño — clase de asociación (clase intermedia sobre una relación muchos a muchos):
Cuando el usuario pida "crear una clase intermedia", "clase de asociación", "romper una relación muchos a muchos" o "normalizar una relación N:M" entre dos clases A y B, usa "setAssociationClass" en vez de fabricar relaciones 1:N a mano: es la forma real que tiene este modelo de decir "esta clase es la tabla de unión de esa relación N:M" (igual que la "Association Class" de StarUML/Visual Paradigm), y el generador ya sabe convertirla en las dos claves ajenas sin que haga falta partir la relación en dos.
1. Localiza A, B y la relación N:M entre ambas en el resumen del diagrama actual (necesitas su id real, el que aparece entre corchetes).
2. Si el usuario no dio nombre para la clase, elige uno lógico (p. ej. "ADetalle", "BA" o un sustantivo compuesto propio del dominio).
3. Si el usuario no dio atributos para la clase, añade los que sean razonables para el dominio (cantidad, subtotal, fecha, etc.); si ninguno es razonable, créala sin atributos propios en vez de preguntar.
4. Crea la clase ("addClass") y sus atributos ("addAttribute"), si hacía falta crearla.
5. Cuélgala de la relación N:M con {"op":"setAssociationClass","relationId":"<id real de esa relación>","classRef":{"name":"<nombre de la clase>"}}.
6. No crees relaciones 1:N nuevas ni elimines la relación N:M original: "setAssociationClass" reutiliza esa misma relación, no la reemplaza ni la duplica.
7. Si no puedes identificar con certeza el id real de la relación N:M en el resumen, no propongas "setAssociationClass": dilo en un "message" y pide al usuario que señale la relación en el lienzo.
Para quitarle a una relación su clase de asociación sin borrar la clase, usa "setAssociationClass" con "classRef": null.`;

/**
 * INSTRUCCIONES PARA "HABLAR SOLA":
 * A diferencia de `SYSTEM_PROMPT`, aquí no se pide traducir ninguna orden —no
 * hay orden, nadie ha escrito nada— sino decidir si el cambio que alguien
 * acaba de hacer en el diagrama merece un comentario espontáneo, y responder
 * en texto llano (nunca JSON) o con la palabra "NADA" cuando no lo merece.
 */
const REVIEW_SYSTEM_PROMPT = `Eres el mismo asistente de modelado UML de siempre, pero ahora hablas sin que nadie te haya preguntado nada: acabas de ver un cambio reciente en el diagrama de un proyecto y decides si vale la pena decir algo.

Responde con un comentario breve (una o dos frases), en castellano y en primera persona, como lo diría alguien del equipo que lleva un rato mirando el diagrama por encima del hombro: qué le preocupa, qué sugeriría o, si procede, qué le parece bien. No te presentes ni repitas lo que ya dijiste en turnos anteriores de esta conversación.

Si no hay nada que de verdad merezca un comentario, responde exactamente con la palabra NADA y nada más alrededor. No inventes un problema solo para tener algo que decir: la respuesta correcta casi siempre es NADA, y hablar en cada cambio sería ruido, no ayuda.

No propongas operaciones ni devuelvas JSON ni código: solo el comentario en texto llano, o NADA.`;

// Define las opciones de configuración para conectar con la IA (clave API, proveedor, modelo, etc.).
export interface LlmOptions {
  apiKey: string;
  provider?: 'anthropic' | 'openai';
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fallback?: AssistantEngine;
}

// Configuración por defecto para conectar con Anthropic (Claude) o OpenAI (ChatGPT).
const DEFECTOS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
} as const;

/**
 * MOTOR 2: El asistente con Inteligencia Artificial remota.
 * Se conecta a un servidor en la nube (como Claude o ChatGPT) para entender peticiones complejas.
 * Si falla la conexión o la IA responde algo incoherente, activa automáticamente el Motor 1 (sin conexión).
 */
export class LlmAssistant implements AssistantEngine {
  readonly name: string;
  private readonly fallback: AssistantEngine;
  private readonly provider: 'anthropic' | 'openai';

  // Configura el motor al crearlo (define qué proveedor usar y qué hacer si falla).
  constructor(private readonly options: LlmOptions) {
    this.fallback = options.fallback ?? new GrammarAssistant();
    this.provider = options.provider ?? 'anthropic';
    this.name = `modelo-remoto (${options.model ?? DEFECTOS[this.provider].model})`;
  }

  // FUNCIÓN PRINCIPAL DEL MOTOR CON IA:
  // Intenta pedirle la respuesta a la IA remota. Si la IA responde bien, devuelve el resultado.
  // Si la IA falla o la respuesta no es válida, recurre al sistema local sin conexión.
  async interpret(
    prompt: string,
    diagram: ClassDiagram,
    contexto?: AssistantContext,
  ): Promise<AssistantResponse> {
    try {
      // 1. Envía el texto, el dibujo actual y la conversación previa a la IA.
      const raw = await this.ask(prompt, diagram, contexto);
      // 2. Comprueba que la respuesta de la IA sea un código JSON correcto.
      const parsed = parseAssistantResponse(extractJson(raw));
      if (parsed.ok) return parsed.value;
      console.warn('El modelo devolvió una respuesta que no valida:', parsed.error);
    } catch (error) {
      console.warn('El modelo no respondió:', (error as Error).message);
    }

    // PLAN B (Degradación suave): Si la IA falló, usa la gramática local para no dejar colgado al usuario.
    const local = await this.fallback.interpret(prompt, diagram);
    return {
      ...local,
      explanation: local.explanation || 'Respuesta generada sin el modelo remoto.',
    };
  }

  async *interpretarEnStream(
    prompt: string,
    diagram: ClassDiagram,
    contexto?: AssistantContext,
    signal?: AbortSignal,
  ): AsyncGenerator<EventoAsistente> {
    let eventosEnviados = 0;
    const defectos = DEFECTOS[this.provider];
    const baseUrl = (this.options.baseUrl ?? defectos.baseUrl).replace(/\/+$/, '');
    const model = this.options.model ?? defectos.model;
    const { system, user, historial } = this.prepararInterpretacion(prompt, diagram, contexto);
    const mensajes = [...historial, { role: 'user' as const, content: user }];
    const prefijo = this.provider === 'anthropic' ? '{' : '';
    if (prefijo) mensajes.push({ role: 'assistant', content: prefijo });
    const body = this.provider === 'anthropic'
      ? { model, max_tokens: 4096, stream: true, system, messages: mensajes }
      : { model, max_tokens: 4096, stream: true, messages: [{ role: 'system' as const, content: system }, ...mensajes] };

    let texto = prefijo;
    let accionesProcesadas = 0;
    let ultimoParcial: string | undefined;
    let confianza = 1;

    const emitirAccion = (valor: unknown): EventoAsistente | null => {
      const validada = AssistantActionSchema.safeParse(valor);
      if (!validada.success) throw new Error(`acción del modelo no válida: ${validada.error.message}`);
      const accion = validada.data;
      if (accion._type === 'think') return null;
      if (accion._type === 'message') return { tipo: 'mensaje', texto: accion.text };
      if (accion._type === 'point') return { tipo: 'senalar', clases: accion.classes };
      return { tipo: 'operacion', operacion: accion.operation, descripcion: describeOperation(accion.operation) };
    };

    const registrar = async function* (evento: EventoAsistente | null): AsyncGenerator<EventoAsistente> {
      if (!evento) return;
      eventosEnviados += 1;
      yield evento;
    };

    try {
      for await (const fragmento of textoDelStream(
        leerStreamDelModelo({
          url: this.provider === 'anthropic' ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`,
          headers: this.provider === 'anthropic'
            ? { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01' }
            : { authorization: `Bearer ${this.options.apiKey}` },
          body,
          timeoutMs: this.options.timeoutMs ?? 20_000,
        }, signal),
        this.provider,
      )) {
        texto += fragmento;
        // Lo que el modelo escriba antes del objeto (una valla ```json o una
        // frase) no forma parte del JSON: igual que `extractJson`.
        const inicio = texto.indexOf('{');
        if (inicio === -1) continue;
        const parcial = cerrarYParsearJson(texto.slice(inicio));
        if (!esObjeto(parcial) || !Array.isArray(parcial.actions)) continue;
        const acciones = parcial.actions;
        while (accionesProcesadas < acciones.length - 1) {
          const evento = emitirAccion(acciones[accionesProcesadas]);
          accionesProcesadas += 1;
          ultimoParcial = undefined;
          yield* registrar(evento);
        }
        const actual = acciones[accionesProcesadas];
        if (esObjeto(actual) && actual._type === 'message' && typeof actual.text === 'string' && actual.text !== ultimoParcial) {
          const evento: EventoAsistente = { tipo: 'mensaje-parcial', texto: actual.text };
          ultimoParcial = actual.text;
          eventosEnviados += 1;
          yield evento;
        }
        if (typeof parcial.confidence === 'number' && Number.isFinite(parcial.confidence) && parcial.confidence >= 0 && parcial.confidence <= 1) {
          confianza = parcial.confidence;
        }
      }

      // Al final, el texto tiene que ser un JSON completo de verdad. Cerrarlo a
      // la fuerza daría por buena una respuesta truncada (por ejemplo, por el
      // tope de tokens) y aplicaría una clase llamada «Ped».
      let completa: unknown;
      try {
        completa = extractJson(texto);
      } catch {
        throw new Error('la respuesta del modelo llegó incompleta');
      }
      if (!esObjeto(completa) || !Array.isArray(completa.actions)) throw new Error('el modelo no terminó una lista de acciones válida');
      if (typeof completa.confidence === 'number' && Number.isFinite(completa.confidence) && completa.confidence >= 0 && completa.confidence <= 1) {
        confianza = completa.confidence;
      }
      // Todas las que falten, no solo la última: el trozo final puede traer
      // varias acciones de golpe (o el JSON entero, si venía tras una valla).
      for (const accion of completa.actions.slice(accionesProcesadas)) {
        yield* registrar(emitirAccion(accion));
      }
      if (eventosEnviados === 0) {
        yield* this.eventosDeFallback(prompt, diagram);
        return;
      }
      yield { tipo: 'fin', motor: this.name, confianza };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (eventosEnviados > 0) throw error;
      yield* this.eventosDeFallback(prompt, diagram);
    }
  }

  private async *eventosDeFallback(prompt: string, diagram: ClassDiagram): AsyncGenerator<EventoAsistente> {
    const respuesta = await this.fallback.interpret(prompt, diagram);
    const mensaje = respuesta.clarification || respuesta.explanation;
    if (mensaje) yield { tipo: 'mensaje', texto: mensaje };
    for (const operacion of respuesta.operations) {
      yield { tipo: 'operacion', operacion, descripcion: describeOperation(operacion) };
    }
    yield { tipo: 'fin', motor: this.fallback.name, confianza: respuesta.confidence };
  }

  // "HABLAR SOLA" CON MODELO REMOTO:
  // Mismo transporte que `interpret`, pero con el prompt de revisión y sin
  // exigir JSON: aquí la respuesta es texto llano o la palabra NADA. Si el
  // modelo falla, se recurre al mismo motor local que usa `interpret`.
  async revisar(diagram: ClassDiagram, contexto?: AssistantContext): Promise<string | null> {
    try {
      const raw = (await this.pedirRevision(diagram, contexto)).trim();
      if (raw === '' || raw.toUpperCase() === 'NADA') return null;
      return raw;
    } catch (error) {
      console.warn('El modelo no pudo revisar el diagrama en solitario:', (error as Error).message);
      return this.fallback.revisar(diagram, contexto);
    }
  }

  private historialComoMensajes(contexto?: AssistantContext): { role: 'user' | 'assistant'; content: string }[] {
    // Los turnos previos se mandan como mensajes reales de la conversación, no
    // como texto plano dentro del prompt: así el modelo conversa de verdad en
    // vez de releer un resumen cada vez. Sin firma: el hilo es de una sola
    // persona.
    return (contexto?.historial ?? []).map((turno) => ({ role: turno.role, content: turno.texto }));
  }

  // FUNCIÓN PRIVADA DE COMUNICACIÓN CON LA IA:
  // Se encarga de empaquetar la petición y enviarla por internet según el proveedor (Anthropic u OpenAI).
  private async ask(prompt: string, diagram: ClassDiagram, contexto?: AssistantContext): Promise<string> {
    const { system, user, historial } = this.prepararInterpretacion(prompt, diagram, contexto);
    return this.enviarConversacion(system, user, historial, 4096, true);
  }

  private prepararInterpretacion(
    prompt: string,
    diagram: ClassDiagram,
    contexto?: AssistantContext,
  ): { system: string; user: string; historial: { role: 'user' | 'assistant'; content: string }[] } {
    const system = SYSTEM_PROMPT.replace('TIPOS', listSupportedTypes().join(', '));
    const otrosProyectos = contexto?.otrosProyectos ?? [];
    const lineaOtrosProyectos = otrosProyectos.length > 0
      ? `\n\nOtros proyectos de este usuario (solo el nombre, para contexto; nunca mezcles su contenido con este diagrama): ${otrosProyectos.join(', ')}.`
      : '';
    const user = `Diagrama actual:\n${summarize(diagram)}${lineaOtrosProyectos}\n\nPetición: ${prompt}`;
    return { system, user, historial: this.historialComoMensajes(contexto) };
  }

  // PETICIÓN PRIVADA DE REVISIÓN ESPONTÁNEA:
  // Mismo transporte, con el prompt de "hablar sola" y sin forzar el "{" con
  // el que `ask` obliga al modelo a empezar un JSON: aquí la respuesta es
  // texto llano. Las pistas del revisor local (`revisarDiagrama`) viajan en el
  // mensaje para que el modelo no tenga que repetir ese trabajo desde cero,
  // aunque puede ignorarlas o fijarse en otra cosa que le parezca más
  // importante.
  private async pedirRevision(diagram: ClassDiagram, contexto?: AssistantContext): Promise<string> {
    const hallazgos = revisarDiagrama(diagram);
    const pistas =
      hallazgos.length > 0
        ? `\n\nUn revisor automático ya detectó esto (puedes mencionarlo con tus palabras, ignorarlo si no lo ves relevante, o fijarte en otra cosa que te parezca más importante):\n${hallazgos
            .slice(0, 5)
            .map((hallazgo) => `- ${hallazgo.titulo}: ${hallazgo.detalle}`)
            .join('\n')}`
        : '';
    const user = `Diagrama actual:\n${summarize(diagram)}${pistas}`;

    return this.enviarConversacion(REVIEW_SYSTEM_PROMPT, user, this.historialComoMensajes(contexto), 300, false);
  }

  /**
   * TRANSPORTE COMÚN A `ask` Y `pedirRevision`:
   * Empaqueta y envía la conversación al proveedor configurado. El único
   * comportamiento que varía entre los dos usos es `forzarJsonInicial`: lo
   * necesita `ask` (la respuesta tiene que ser JSON) y no `pedirRevision` (la
   * respuesta es texto llano o "NADA"), y solo tiene efecto con Anthropic —
   * OpenAI nunca lo necesitó, ni antes de este refactor.
   */
  private async enviarConversacion(
    system: string,
    user: string,
    historial: { role: 'user' | 'assistant'; content: string }[],
    maxTokens: number,
    forzarJsonInicial: boolean,
  ): Promise<string> {
    const defectos = DEFECTOS[this.provider];
    const baseUrl = (this.options.baseUrl ?? defectos.baseUrl).replace(/\/+$/, '');
    const model = this.options.model ?? defectos.model;

    // Caso A: Si el proveedor elegido es Anthropic (Claude).
    if (this.provider === 'anthropic') {
      const mensajes = [...historial, { role: 'user' as const, content: user }];
      if (forzarJsonInicial) {
        // Obliga a la IA a empezar respondiendo en formato JSON.
        mensajes.push({ role: 'assistant', content: '{' });
      }
      const payload = await pedirAlModelo<{ content?: { type: string; text?: string }[] }>({
        url: `${baseUrl}/v1/messages`,
        headers: {
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: { model, max_tokens: maxTokens, system, messages: mensajes },
        timeoutMs: this.options.timeoutMs ?? 20_000,
      });
      const texto = payload.content?.find((block) => block.type === 'text')?.text ?? '';
      return forzarJsonInicial ? `{${texto}` : texto;
    }

    // Caso B: Si el proveedor elegido es OpenAI (ChatGPT) u otro compatible.
    const payload = await pedirAlModelo<RespuestaOpenAi>({
      url: `${baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: {
        model,
        max_tokens: maxTokens,
        stream: false,
        messages: [{ role: 'system', content: system }, ...historial, { role: 'user', content: user }],
      },
      timeoutMs: this.options.timeoutMs ?? 20_000,
    });

    return payload.choices?.[0]?.message?.content ?? '';
  }
}

// Estructura de la respuesta que se espera recibir desde la API de OpenAI.
interface RespuestaOpenAi {
  choices?: { message?: { content?: string } }[];
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

async function* textoDelStream(
  trozos: AsyncIterable<string>,
  proveedor: 'anthropic' | 'openai',
): AsyncGenerator<string> {
  let pendiente = '';
  for await (const trozo of trozos) {
    pendiente += trozo.replace(/\r\n/g, '\n');
    let corte = pendiente.indexOf('\n\n');
    while (corte !== -1) {
      const bloque = pendiente.slice(0, corte);
      pendiente = pendiente.slice(corte + 2);
      for (const linea of bloque.split('\n')) {
        if (!linea.startsWith('data:')) continue;
        const dato = linea.slice(5).trim();
        if (dato === '[DONE]') return;
        let contenido: unknown;
        try {
          contenido = JSON.parse(dato);
        } catch {
          throw new Error('el modelo envió un evento SSE no válido');
        }
        if (!esObjeto(contenido)) continue;
        if (proveedor === 'openai') {
          const choices = contenido.choices;
          const delta = Array.isArray(choices) && esObjeto(choices[0]) ? choices[0].delta : null;
          if (esObjeto(delta) && typeof delta.content === 'string') yield delta.content;
        } else if (
          contenido.type === 'content_block_delta' &&
          esObjeto(contenido.delta) &&
          contenido.delta.type === 'text_delta' &&
          typeof contenido.delta.text === 'string'
        ) {
          yield contenido.delta.text;
        } else if (contenido.type === 'error') {
          throw new Error('el modelo devolvió un error durante el stream');
        }
      }
      corte = pendiente.indexOf('\n\n');
    }
  }
  if (pendiente.trim()) {
    const lineas = pendiente.split('\n').filter((linea) => linea.startsWith('data:'));
    for (const linea of lineas) {
      const dato = linea.slice(5).trim();
      if (dato === '[DONE]') return;
      const contenido: unknown = JSON.parse(dato);
      if (!esObjeto(contenido)) continue;
      if (proveedor === 'openai') {
        const choices = contenido.choices;
        const delta = Array.isArray(choices) && esObjeto(choices[0]) ? choices[0].delta : null;
        if (esObjeto(delta) && typeof delta.content === 'string') yield delta.content;
      } else if (contenido.type === 'content_block_delta' && esObjeto(contenido.delta) && contenido.delta.type === 'text_delta' && typeof contenido.delta.text === 'string') {
        yield contenido.delta.text;
      }
    }
  }
}

/**
 * FUNCIÓN AUXILIAR DE RESUMEN:
 * Toma el diagrama completo y crea una versión simplificada en texto.
 * Sirve para no enviarle a la IA datos innecesarios (como posiciones exactas en pantalla)
 * y así ahorrar costos y evitar confusiones.
 */
function summarize(diagram: ClassDiagram): string {
  const classes = Object.values(diagram.classes);
  if (classes.length === 0) return '(vacío)';

  // Traduce cada clase (sus nombres, atributos, métodos) a líneas de texto.
  const lines = classes.map((cls) => {
    const attributes = cls.attributes
      .map((a) => `${a.name}: ${a.type.name}${a.isIdentifier ? ' (id)' : ''}`)
      .join(', ');
    const methods = cls.methods.map((m) => `${m.name}()`).join(', ');
    const literals = cls.literals.join(', ');
    const parts = [`${cls.kind} ${cls.name}`];
    if (attributes) parts.push(`  atributos: ${attributes}`);
    if (methods) parts.push(`  métodos: ${methods}`);
    if (literals) parts.push(`  literales: ${literals}`);
    return parts.join('\n');
  });

  // Traduce las relaciones entre clases (por ejemplo: Persona 1 --asociación--> * Vehículo).
  // El id va entre corchetes al principio de la línea: sin él, el modelo no tiene forma de
  // referenciar una relación concreta al pedirle un "removeRelation" (solo ve nombres y
  // multiplicidades, que no identifican una relación de forma única si hay varias entre
  // las mismas dos clases).
  const relations = Object.values(diagram.relations).map((relation) => {
    const source = diagram.classes[relation.source.classId]?.name ?? '?';
    const target = diagram.classes[relation.target.classId]?.name ?? '?';
    return `  [id:${relation.id}] ${source} ${relation.source.multiplicity} --${relation.kind}--> ${relation.target.multiplicity} ${target}`;
  });

  return [...lines, relations.length > 0 ? `relaciones:\n${relations.join('\n')}` : ''].join('\n');
}

/**
 * FUNCIÓN AUXILIAR DE LIMPIEZA:
 * Extrae únicamente el bloque JSON de la respuesta recibida.
 * Limpia espacios extra o marcas de formato Markdown (```json) que la IA haya podido incluir por error.
 */
export function extractJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('la respuesta no contiene un objeto JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * FUNCIÓN SELECTORA (FÁBRICA):
 * Decide qué asistente activar según la configuración recibida:
 * - Si el usuario configuró una clave API -> Crea un asistente con IA (`LlmAssistant`).
 * - Si no hay clave API -> Crea el asistente básico sin conexión (`GrammarAssistant`).
 */
export function createAssistant(config: {
  llmApiKey?: string;
  llmProvider?: 'anthropic' | 'openai';
  llmBaseUrl?: string;
  llmModel?: string;
}): AssistantEngine {
  if (!config.llmApiKey) return new GrammarAssistant();
  return new LlmAssistant({
    apiKey: config.llmApiKey,
    provider: config.llmProvider,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
  });
}
