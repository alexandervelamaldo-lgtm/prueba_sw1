import type { EntityIR, GenerationIR } from '../ir/types.js';
import type { DtoComponent, EntityView } from './generate.js';

/**
 * Colección Postman (v2.1) del backend generado.
 *
 * No es una plantilla `.hbs` como el resto: construirla con `JSON.stringify`
 * evita el escapado manual de comillas que un `.hbs` obligaría, y aquí no hay
 * código Java que formatear, solo un documento JSON.
 *
 * Una carpeta por entidad concreta (las abstractas no tienen CRUD, ver
 * `generateProject`), con las mismas cinco operaciones que expone
 * `controller.java.hbs`. El cuerpo de ejemplo de POST/PUT sale de
 * `requestComponents`, la misma vista que ya usa `dto-request.java.hbs`: si el
 * DTO cambia, el ejemplo cambia con él sin tocar este fichero.
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

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  response?: unknown[];
}

export function buildPostmanCollection(ir: GenerationIR, entityViews: EntityView[]): string {
  const enumFirstValue = new Map(
    ir.enums.filter((e) => e.values.length > 0).map((e) => [e.className, e.values[0] as string]),
  );

  const collection = {
    info: {
      name: `${ir.project.name} — API`,
      description:
        `Colección generada a partir del diagrama «${ir.project.name}». Un carpeta por ` +
        'entidad con las 4 operaciones CRUD (más el listado paginado), listas para ' +
        'ejecutar contra el backend en {{baseUrl}} sin editar nada a mano.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [{ key: 'baseUrl', value: 'http://localhost:8080', type: 'string' }],
    item: entityViews.map((view) => folderForEntity(view.entity, view.requestComponents, enumFirstValue)),
  };

  return `${JSON.stringify(collection, null, 2)}\n`;
}

function folderForEntity(
  entity: EntityIR,
  requestComponents: DtoComponent[],
  enumFirstValue: Map<string, string>,
): PostmanItem {
  const path = `/api/${entity.restPath}`;
  const ejemploId = exampleValue(entity.identifier.javaType, entity.identifier.name, enumFirstValue);
  const body = requestComponents.length > 0 ? requestBody(requestComponents, enumFirstValue) : undefined;

  return {
    name: entity.className,
    item: [
      requestItem(`Listar ${entity.className}`, 'GET', `${path}?page=0&size=20`),
      requestItem(`Buscar ${entity.className} por id`, 'GET', `${path}/${ejemploId}`),
      requestItem(`Crear ${entity.className}`, 'POST', path, body),
      requestItem(`Actualizar ${entity.className}`, 'PUT', `${path}/${ejemploId}`, body),
      requestItem(`Eliminar ${entity.className}`, 'DELETE', `${path}/${ejemploId}`),
    ],
  };
}

function requestItem(
  name: string,
  method: string,
  pathWithQuery: string,
  body?: Record<string, unknown>,
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
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }

  return { name, request, response: [] };
}

function requestBody(
  components: DtoComponent[],
  enumFirstValue: Map<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const component of components) {
    body[component.name] = exampleValue(component.javaType, component.name, enumFirstValue);
  }
  return body;
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
