import type { EntityIR, GenerationIR } from '../ir/types.js';
import type { EntityView } from './generate.js';

/**
 * Colección Postman (v2.1) del backend generado.
 *
 * No es una plantilla `.hbs` como el resto: construirla con `JSON.stringify`
 * evita el escapado manual de comillas que un `.hbs` obligaría, y aquí no hay
 * código Java que formatear, solo un documento JSON.
 *
 * Pensada para ejecutarse entera, en orden, contra una base vacía (el «Run» de
 * Postman o `newman run`):
 *
 * - Una carpeta por entidad concreta (las abstractas no tienen CRUD, ver
 *   `generateProject`) con listar, crear, buscar y actualizar, ordenadas para
 *   que una entidad se cree después de aquellas a las que apunta.
 * - El alta guarda el id que devuelve la API en una variable de la colección
 *   (`{{pedidoId}}`), y las demás peticiones —y las claves ajenas de las
 *   entidades que dependen de ella— usan esa variable en vez de un id
 *   inventado que la base no tiene.
 * - Los borrados van juntos en una carpeta final, en orden inverso: borrar el
 *   cliente dentro de su propia carpeta dejaría sin padre al pedido que se crea
 *   después.
 *
 * El cuerpo de ejemplo de POST/PUT sale de `requestComponents`, la misma vista
 * que ya usa `dto-request.java.hbs`: si el DTO cambia, el ejemplo cambia con él
 * sin tocar este fichero.
 */

interface PostmanUrl {
  raw: string;
  host: string[];
  path: string[];
  query?: { key: string; value: string }[];
}

interface PostmanRequest {
  method: string;
  header: { key: string; value: string }[];
  url: PostmanUrl;
  body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
}

interface PostmanEvent {
  listen: 'test';
  script: { type: 'text/javascript'; exec: string[] };
}

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  event?: PostmanEvent[];
  response?: unknown[];
}

/** Variable de la colección que guarda el id creado de una entidad: `pedidoId`. */
function variableDe(entity: EntityIR): string {
  return `${entity.varName}Id`;
}

export function buildPostmanCollection(ir: GenerationIR, entityViews: EntityView[]): string {
  const enumFirstValue = new Map(
    ir.enums.filter((e) => e.values.length > 0).map((e) => [e.className, e.values[0] as string]),
  );
  const porClase = new Map(ir.entities.map((e) => [e.className, e]));
  const ordenadas = ordenarPorDependencia(entityViews);

  const collection = {
    info: {
      name: `${ir.project.name} — API`,
      description:
        `Colección generada a partir del diagrama «${ir.project.name}». Una carpeta por ` +
        'entidad, en orden de dependencia, y una carpeta final de limpieza. Ejecutada ' +
        'entera contra el backend en {{baseUrl}} crea, consulta, actualiza y borra un ' +
        'registro de cada entidad sin editar nada a mano.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:8080', type: 'string' },
      ...ordenadas.map((view) => ({ key: variableDe(view.entity), value: '', type: 'string' })),
    ],
    item: [
      ...ordenadas.map((view) => folderForEntity(view, porClase, enumFirstValue)),
      {
        name: 'Limpieza',
        item: [...ordenadas].reverse().map((view) => {
          const { entity } = view;
          return requestItem(
            `Eliminar ${entity.className}`,
            'DELETE',
            `/api/${entity.restPath}/{{${variableDe(entity)}}}`,
            undefined,
            pruebaEstado(204),
          );
        }),
      },
    ],
  };

  return `${JSON.stringify(collection, null, 2)}\n`;
}

/**
 * Las entidades a las que apunta una a-uno van antes. Una auto-referencia no
 * cuenta (se envía `null`, ver `requestBody`), y si hubiera un ciclo las que
 * queden se añaden en su orden original en vez de perderse.
 */
function ordenarPorDependencia(views: EntityView[]): EntityView[] {
  const clases = new Set(views.map((v) => v.entity.className));
  const dependencias = new Map(
    views.map((v) => [
      v.entity.className,
      new Set(
        [...v.toOneAssociations.map((a) => a.targetClass), ...v.toManyIdLists.map((l) => l.targetClass)]
          .filter((c) => c !== v.entity.className && clases.has(c)),
      ),
    ]),
  );

  const resultado: EntityView[] = [];
  const colocadas = new Set<string>();
  let pendientes = [...views];
  while (pendientes.length > 0) {
    const listas = pendientes.filter((v) =>
      [...dependencias.get(v.entity.className)!].every((c) => colocadas.has(c)),
    );
    const siguientes = listas.length > 0 ? listas : pendientes;
    for (const v of siguientes) {
      resultado.push(v);
      colocadas.add(v.entity.className);
    }
    pendientes = pendientes.filter((v) => !colocadas.has(v.entity.className));
  }
  return resultado;
}

function folderForEntity(
  view: EntityView,
  porClase: Map<string, EntityIR>,
  enumFirstValue: Map<string, string>,
): PostmanItem {
  const { entity } = view;
  const path = `/api/${entity.restPath}`;
  const conId = `${path}/{{${variableDe(entity)}}}`;
  const body =
    view.requestComponents.length > 0 ? requestBody(view, porClase, enumFirstValue) : undefined;

  return {
    name: entity.className,
    item: [
      requestItem(`Listar ${entity.className}`, 'GET', `${path}?page=0&size=20`, undefined, pruebaEstado(200)),
      requestItem(`Crear ${entity.className}`, 'POST', path, body, [
        ...pruebaEstado(201),
        `pm.collectionVariables.set('${variableDe(entity)}', pm.response.json().id);`,
      ]),
      requestItem(`Buscar ${entity.className} por id`, 'GET', conId, undefined, pruebaEstado(200)),
      requestItem(`Actualizar ${entity.className}`, 'PUT', conId, body, pruebaEstado(200)),
    ],
  };
}

function pruebaEstado(codigo: number): string[] {
  return [`pm.test('responde ${codigo}', () => pm.response.to.have.status(${codigo}));`];
}

function requestItem(
  name: string,
  method: string,
  pathWithQuery: string,
  body: string | undefined,
  prueba: string[],
): PostmanItem {
  const [rawPath = pathWithQuery, rawQuery] = pathWithQuery.split('?');
  const url: PostmanUrl = {
    raw: `{{baseUrl}}${pathWithQuery}`,
    host: ['{{baseUrl}}'],
    path: rawPath.split('/').filter(Boolean),
  };
  if (rawQuery) {
    url.query = rawQuery.split('&').map((pair) => {
      const [key = '', value = ''] = pair.split('=');
      return { key, value };
    });
  }

  const request: PostmanRequest = {
    method,
    header: body !== undefined ? [{ key: 'Content-Type', value: 'application/json' }] : [],
    url,
  };
  if (body !== undefined) {
    request.body = { mode: 'raw', raw: body, options: { raw: { language: 'json' } } };
  }

  return {
    name,
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: prueba } }],
    request,
    response: [],
  };
}

/** Marca que `requestBody` sustituye por una variable sin comillas: un id numérico. */
const NUMERO = '__variable_numerica__';

/**
 * Cuerpo de alta y modificación, ya como texto.
 *
 * Es texto y no un objeto porque una referencia a un id numérico tiene que ir
 * sin comillas (`"clienteId": {{clienteId}}`), y eso no es JSON hasta que
 * Postman sustituye la variable.
 */
function requestBody(
  view: EntityView,
  porClase: Map<string, EntityIR>,
  enumFirstValue: Map<string, string>,
): string {
  const aUno = new Map(view.toOneAssociations.map((a) => [a.idComponentName, a]));
  const aMuchos = new Map(view.toManyIdLists.map((l) => [l.name, l]));
  const unicos = new Set(view.allFields.filter((f) => f.unique).map((f) => f.name));

  const body: Record<string, unknown> = {};
  for (const component of view.requestComponents) {
    const referencia = aUno.get(component.name);
    const lista = aMuchos.get(component.name);
    if (referencia) {
      const destino = porClase.get(referencia.targetClass);
      if (referencia.targetClass === view.entity.className || !destino) {
        body[component.name] = null;
      } else if (referencia.idJavaType === 'Long' || referencia.idJavaType === 'Integer') {
        body[component.name] = `${NUMERO}${variableDe(destino)}`;
      } else {
        body[component.name] = `{{${variableDe(destino)}}}`;
      }
    } else if (lista) {
      const destino = porClase.get(lista.targetClass);
      body[component.name] = destino ? [`{{${variableDe(destino)}}}`] : [];
    } else if (unicos.has(component.name) && component.javaType === 'String') {
      // Ejecutar la colección dos veces no debe chocar con el alta anterior.
      body[component.name] = `${component.name}-{{$timestamp}}-{{$randomInt}}`;
    } else {
      body[component.name] = exampleValue(component.javaType, component.name, enumFirstValue);
    }
  }
  return JSON.stringify(body, null, 2).replace(
    new RegExp(`"${NUMERO}(\\w+)"`, 'g'),
    (_, variable: string) => `{{${variable}}}`,
  );
}

/**
 * Valor de relleno por tipo Java, para que el cuerpo de ejemplo pase las
 * validaciones (`@NotNull`, `@NotBlank`) sin que quien prueba en Postman tenga
 * que adivinar el formato de una fecha o un UUID antes de poder pulsar «Send».
 */
function exampleValue(javaType: string, fieldName: string, enumFirstValue: Map<string, string>): unknown {
  const enumValue = enumFirstValue.get(javaType);
  if (enumValue !== undefined) return enumValue;

  switch (javaType) {
    case 'String':
      return `${fieldName}-ejemplo`;
    case 'Integer':
    case 'Short':
    case 'Long':
      return 1;
    case 'Double':
    case 'Float':
    case 'BigDecimal':
      return 100.5;
    case 'Boolean':
      return true;
    case 'LocalDate':
      return '2024-01-01';
    case 'LocalDateTime':
      return '2024-01-01T00:00:00';
    case 'Instant':
      return '2024-01-01T00:00:00Z';
    case 'LocalTime':
      return '10:00:00';
    case 'UUID':
      return '00000000-0000-0000-0000-000000000001';
    default:
      return null;
  }
}
