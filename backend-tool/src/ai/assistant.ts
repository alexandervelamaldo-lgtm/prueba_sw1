import type { AssistantResponse, ClassDiagram } from '@app/shared';
import { interpretCommand, listSupportedTypes, parseAssistantResponse } from '@app/shared';
import { pedirAlModelo } from './transporte.js';

/**
 * Explicación general del módulo:
 * Este archivo gestiona el "asistente inteligente" para crear diagramas.
 * Funciona con dos motores: 
 * 1. Un modelo de inteligencia artificial (cuando hay internet).
 * 2. Una gramática local fija (cuando no hay internet o falla el modelo).
 */

// Define la "plantilla" o contrato que debe cumplir cualquier motor de asistente:
// debe tener un nombre y una función para interpretar lo que pide el usuario.
export interface AssistantEngine {
  readonly name: string;
  interpret(prompt: string, diagram: ClassDiagram): Promise<AssistantResponse>;
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
}

// INSTRUCCIONES SECRETAS PARA LA IA (System Prompt):
// Este texto en mayúsculas es la "nota de entrenamiento" que se le envía a la IA
// para indicarle exactamente cómo debe comportarse, qué operaciones puede hacer
// y exigirle que responda ÚNICAMENTE en un formato estructurado (JSON).
const SYSTEM_PROMPT = `Eres un asistente de modelado UML. Traduces peticiones en castellano a operaciones sobre un diagrama de clases.

Respondes ÚNICAMENTE con un objeto JSON, sin texto alrededor y sin vallas de código, con esta forma:
{"operations": [...], "confidence": 0.0-1.0, "clarification": string|null, "explanation": string}

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
- Si la petición es ambigua o falta un dato, devuelve "operations": [] y explica qué falta en "clarification". No adivines.
- No elimines nada que el usuario no haya pedido eliminar explícitamente.
- "setSeedRows" sustituye TODAS las filas de datos de ejemplo de la clase. Úsala solo si el usuario dicta el contenido completo; para añadir una fila a las que ya hay, repite las anteriores. Las claves de cada fila son nombres de atributos de esa clase, y todos los valores van como texto.
- "removeSeedRow" usa índice de base 1, tal como se dice: «borra la segunda fila» es index 2.
- "associationClassName" en "addRelation" es opcional y solo tiene efecto si la relación es muchos a muchos (ambas multiplicidades "*" o "0..*", etc.): crea de una vez la clase intermedia con ese nombre y la cuelga de la relación. Úsalo cuando el usuario pida una "clase de asociación" o una "clase intermedia" entre dos clases con relación N:M; para colgar una clase que ya existe sobre una relación N:M ya creada usa "setAssociationClass" en su lugar.
- Los datos de ejemplo son filas de una tabla del proyecto generado, no registros de una base de datos en producción: no hay ninguna operación que borre datos reales, y no debes ofrecerla.
- Cada línea de relación del resumen del diagrama actual trae su id real entre corchetes, por ejemplo «[id:r1] A 1 --association--> * B»: cópialo tal cual en "removeRelation" cuando haya que borrar esa relación. No inventes ni adivines un id: si la relación a borrar no aparece con su id en el resumen, no propongas "removeRelation" y dilo en "explanation".

Patrón de diseño — clase de asociación (clase intermedia sobre una relación muchos a muchos):
Cuando el usuario pida "crear una clase intermedia", "clase de asociación", "romper una relación muchos a muchos" o "normalizar una relación N:M" entre dos clases A y B, usa "setAssociationClass" en vez de fabricar relaciones 1:N a mano: es la forma real que tiene este modelo de decir "esta clase es la tabla de unión de esa relación N:M" (igual que la "Association Class" de StarUML/Visual Paradigm), y el generador ya sabe convertirla en las dos claves ajenas sin que haga falta partir la relación en dos.
1. Localiza A, B y la relación N:M entre ambas en el resumen del diagrama actual (necesitas su id real, el que aparece entre corchetes).
2. Si el usuario no dio nombre para la clase, elige uno lógico (p. ej. "ADetalle", "BA" o un sustantivo compuesto propio del dominio).
3. Si el usuario no dio atributos para la clase, añade los que sean razonables para el dominio (cantidad, subtotal, fecha, etc.); si ninguno es razonable, créala sin atributos propios en vez de preguntar.
4. Crea la clase ("addClass") y sus atributos ("addAttribute"), si hacía falta crearla.
5. Cuélgala de la relación N:M con {"op":"setAssociationClass","relationId":"<id real de esa relación>","classRef":{"name":"<nombre de la clase>"}}.
6. No crees relaciones 1:N nuevas ni elimines la relación N:M original: "setAssociationClass" reutiliza esa misma relación, no la reemplaza ni la duplica.
7. Si no puedes identificar con certeza el id real de la relación N:M en el resumen, no propongas "setAssociationClass": dilo en "explanation" y pide al usuario que señale la relación en el lienzo.
Para quitarle a una relación su clase de asociación sin borrar la clase, usa "setAssociationClass" con "classRef": null.`;

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
  async interpret(prompt: string, diagram: ClassDiagram): Promise<AssistantResponse> {
    try {
      // 1. Envía el texto y el dibujo actual a la IA.
      const raw = await this.ask(prompt, diagram);
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

  // FUNCIÓN PRIVADA DE COMUNICACIÓN CON LA IA:
  // Se encarga de empaquetar la petición y enviarla por internet según el proveedor (Anthropic u OpenAI).
  private async ask(prompt: string, diagram: ClassDiagram): Promise<string> {
    // Prepara las instrucciones agregando los tipos de datos válidos.
    const system = SYSTEM_PROMPT.replace('TIPOS', listSupportedTypes().join(', '));
    // Crea el mensaje combinando el diagrama actual y la petición del usuario.
    const user = `Diagrama actual:\n${summarize(diagram)}\n\nPetición: ${prompt}`;
    const defectos = DEFECTOS[this.provider];
    const baseUrl = (this.options.baseUrl ?? defectos.baseUrl).replace(/\/+$/, '');
    const model = this.options.model ?? defectos.model;

    // Caso A: Si el proveedor elegido es Anthropic (Claude).
    if (this.provider === 'anthropic') {
      const payload = await pedirAlModelo<{ content?: { type: string; text?: string }[] }>({
        url: `${baseUrl}/v1/messages`,
        headers: {
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model,
          max_tokens: 2048,
          system,
          messages: [
            { role: 'user', content: user },
            { role: 'assistant', content: '{' }, // Obliga a la IA a empezar respondiendo en formato JSON.
          ],
        },
        timeoutMs: this.options.timeoutMs ?? 20_000,
      });
      return `{${payload.content?.find((block) => block.type === 'text')?.text ?? ''}`;
    }

    // Caso B: Si el proveedor elegido es OpenAI (ChatGPT) u otro compatible.
    const payload = await pedirAlModelo<RespuestaOpenAi>({
      url: `${baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: {
        model,
        max_tokens: 2048,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
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