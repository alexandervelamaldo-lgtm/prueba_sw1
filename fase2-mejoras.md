# Fase 2 — Mejoras del Modo IA

> Revisado el 2026-10-17 contra el código (rama `yimy`, commit `8927316`) y contra la plantilla `templates/agent` de tldraw (clonada en `~/proyectos/referencias/tldraw`, licencia MIT).

## Objetivo

Pasar de un "intérprete de órdenes con micrófono" a una IA que:

1. **conversa**: responde preguntas, opina y explica, no solo devuelve operaciones;
2. **ejecuta sola** lo que se le pide, sin esperar el clic en "Aplicar";
3. **parece que aprieta los botones**: un cursor recorre la interfaz mientras el diagrama cambia;
4. tiene **una sesión privada por colaborador** en cada proyecto;
5. señala el diagrama y propone cosas por su cuenta.

---

## 0. Estado actual (lo que ya hace el proyecto)

| Qué | Dónde | Estado |
|---|---|---|
| Chat por texto y por voz | `frontend/src/components/ModoIA.tsx` (`enviar`) | ✅ Existe |
| Voz del navegador (escuchar y hablar) | `frontend/src/services/voz.ts` | ✅ Existe |
| Traducir la orden a operaciones UML | `backend-tool/src/ai/assistant.ts`, `POST /:proyectoId/asistente` | ✅ Existe |
| Ejecutar operaciones | `PropuestaOperaciones` → `aplicar` | ⚠️ Solo si el usuario pulsa "Aplicar" |
| Responder preguntas sin operaciones | `ModoIA.tsx:208` | ❌ Se reemplaza por "Orden no reconocida" |
| Historial de conversación | tabla `conversaciones_ia` | ⚠️ **Compartido por proyecto**, no por usuario |
| Comentarios espontáneos de la IA | `backend-tool/src/ai/vigilancia.ts` | ⚠️ Van al hilo compartido |
| Streaming de la respuesta | `backend-tool/src/ai/transporte.ts` (`fetch` simple) | ❌ No existe |
| Cursor fantasma / `data-ia` | — | ❌ No existe |
| Librería del lienzo | `@xyflow/react` (React Flow) | ✅ Confirmada |
| Colaboración en tiempo real | `yjs` + salas (`rooms.open`) | ✅ Existe |

---

## 1. IA conversacional (prioridad 1)

**Problema:** el esquema de respuesta es `{operations, confidence, clarification, explanation}` y el frontend descarta la `explanation` cuando no hay operaciones. Por eso, si le preguntas "¿qué te parece mi diagrama?", no contesta.

**Solución (patrón tomado de tldraw):** la respuesta del modelo pasa a ser **una lista de acciones**, y el mensaje de texto es una acción más:

```json
{
  "acciones": [
    { "_tipo": "pensar", "texto": "El usuario quiere un sistema de ventas..." },
    { "_tipo": "mensaje", "texto": "Voy a crear Cliente y Pedido, y los relaciono." },
    { "_tipo": "operacion", "operacion": { "op": "addClass", "name": "Cliente" } },
    { "_tipo": "operacion", "operacion": { "op": "addClass", "name": "Pedido" } },
    { "_tipo": "mensaje", "texto": "Listo. ¿Quieres que agregue los atributos?" }
  ]
}
```

- Una respuesta de **solo `mensaje`** es válida: es una charla.
- Intercalar `mensaje` y `operacion` le da a la IA una narración natural mientras trabaja.
- `_tipo` va primero (el guion bajo hace que el modelo lo escriba primero). Esto permite reaccionar en cuanto empieza a llegar cada acción.
- La validación sigue en el backend con Zod. Las operaciones se validan igual que hoy, con el mismo esquema compartido de `shared/`.
- `describeOperation` sigue calculándose en el servidor, no lo escribe el modelo (se mantiene la decisión actual).
- **Compatibilidad:** el endpoint actual puede seguir devolviendo `propuesta` y `explicacion` a partir de la lista de acciones mientras se migra el frontend.

Referencia: `templates/agent/shared/schema/AgentActionSchemas.ts`, `client/actions/MessageActionUtil.ts`, `ThinkActionUtil.ts`.

---

## 2. Sesiones por colaborador (prioridad 2)

**Decisión:** cada colaborador tiene **su propio hilo** con la IA en cada proyecto. Los demás no lo ven.

> Esto revierte una decisión anterior. Hoy el hilo es compartido a propósito: ver el comentario de `backend-tool/src/api/assistant.ts:74` y el índice `conversaciones_por_proyecto` en `backend-tool/sql/esquema.sql`.

| Cambio | Dónde |
|---|---|
| Leer el historial por `(proyecto_id, usuario_id)` | `ConversationStore.getHistory`, `GET /asistente/historial` |
| Guardar el `usuario_id` del hilo **también** en las filas `assistant` (hoy quedan `null`) | `appendTurn` |
| Índice `(proyecto_id, usuario_id, id)` en lugar de `conversaciones_por_proyecto` | `esquema.sql` (migración idempotente) |
| Quitar del `SYSTEM_PROMPT` el párrafo "Este hilo es compartido…" y la firma de autores | `assistant.ts:89`, `conAutores` |
| Comentarios espontáneos: van **al hilo de quien hizo el cambio** que los provocó | `vigilancia.ts` (`appendComentario` recibe `usuarioId`) |
| Filas antiguas con `usuario_id = null` en `assistant` | Se dejan como historial legado; no se muestran en ningún hilo |

**Pendiente de decidir:** a quién le llega el comentario espontáneo si el cambio lo hizo otra persona que no tiene el Modo IA abierto.

---

## 3. Ejecución automática con cursor fantasma (prioridad 3)

**Objetivo:** que la IA ejecute sola y dé la sensación de usar la interfaz.

### 3.1 Ejecución automática

- Nuevo ajuste en el Modo IA: **"La IA aplica los cambios sola"** (activado por defecto).
- Las operaciones se aplican **de a una**, en el orden en que llegan, con la misma función `aplicar` de hoy.
- **Confirmación obligatoria** solo para lo destructivo: `removeClass`, `removeRelation` o más de N borrados. Ahí se muestra `PropuestaOperaciones` como hoy.
- Si el usuario es `viewer`, nunca se ejecuta nada (se respeta `requireRole`).

### 3.2 Cursor fantasma

- Los botones reales llevan un atributo `data-ia="<accion>"` (por ejemplo `data-ia="addClass"` en el botón "Nueva clase").
- Antes de aplicar cada operación, un cursor animado (un `div` con transición CSS) **viaja al botón** correspondiente, hace un "clic" visual (escala y onda) y luego viaja al lugar del lienzo donde aparece el resultado.
- Por detrás **no se disparan clics reales**: se llama a `aplicar`. El cursor es una representación visual. Disparar clics reales sería frágil (modales, foco, estados intermedios).
- Pausa breve entre operaciones (≈300–500 ms, configurable) para que se vea cada paso. Hay un botón "Saltar animación".
- Al crear o tocar una clase: se centra la cámara con `fitView({ nodes: [{ id }] })` de React Flow y se resalta el nodo unos segundos.

Referencia: tldraw no tiene cursor sobre botones, pero sí un **viewport propio del agente** y **resaltados** de lo que está tocando (`client/overlays/AgentHighlightOverlayUtil.ts`, `client/parts/AgentViewportBoundsPartUtil.ts`, `client/components/GoToAgentButton.tsx`).

### 3.3 Deshacer

- Usar `Y.UndoManager` de Yjs en lugar de construir operaciones inversas a mano (el patrón Command del plan anterior).
- Cada respuesta de la IA es un **único paso de deshacer**: se agrupan sus operaciones con un `origin` propio de la IA, para que "deshaz lo último" revierta todo lo que hizo en esa respuesta y no toque lo que hicieron otros colaboradores.

---

## 4. Streaming (prioridad 4)

**Problema:** hoy se espera la respuesta completa (`transporte.ts` hace un `fetch` simple).

**Solución (patrón tomado de tldraw):**

1. El backend pide la respuesta al modelo en modo streaming.
2. Va acumulando el texto y en cada fragmento intenta parsear el JSON **incompleto**, cerrando llaves y comillas que faltan (`closeAndParseJson`).
3. Cuando la lista `acciones` crece, la acción anterior está **completa**: se valida y se envía al frontend por **SSE** (`text/event-stream`). La acción en curso se envía marcada como `completa: false` para mostrar el texto mientras se escribe.
4. El frontend:
   - muestra los `mensaje` mientras llegan y los manda a la voz **frase por frase**;
   - ejecuta cada `operacion` **solo cuando está completa**, con el cursor fantasma.
5. Cancelar: el frontend cierra la conexión y el backend aborta la petición al modelo (`AbortController`).

Referencia: `templates/agent/worker/do/AgentService.ts` (bucle de streaming) y `worker/do/closeAndParseJson.ts`.

> El historial (`appendTurn`) se guarda al terminar el stream, con el texto completo de los mensajes y las operaciones aplicadas.

### Interrupción por voz

`@ricky0123/vad-web` detecta que el usuario empezó a hablar: se calla la voz (`speechSynthesis.cancel()`) y se cancela el stream.

---

## 5. Que la IA vea y señale el diagrama

| Mejora | Cómo |
|---|---|
| **Señalar** | Nueva acción `{ "_tipo": "señalar", "ids": [...] }`: el frontend centra la cámara y resalta esos nodos. Sirve también en charlas sin cambios ("esta clase de aquí…"). |
| **Contexto de lo que hace el usuario** | Enviar al modelo la **selección actual** y las **últimas acciones del usuario** (patrón de tldraw: `AgentUserActionTracker`, `SelectionPartUtil`). Así entiende "esta clase" o "lo que acabo de crear". |
| **Vista previa fantasma** | Solo para las operaciones que requieren confirmación (borrados): simular sobre una copia y dibujar la diferencia con borde punteado. |

---

## 6. IA proactiva

| Mejora | Cómo |
|---|---|
| **Botón "Revisar mi diagrama"** | Dos capas: reglas locales en TypeScript (clase sin atributos, nombres duplicados, ciclos de herencia, relaciones sin multiplicidad) y el LLM para lo semántico. Las reglas locales se pasan al modelo como contexto (patrón *lints* de tldraw: `AgentLintManager`). |
| **Trabajo en varios pasos** | La IA puede pedir **un paso más** para revisar lo que hizo (patrón `schedule` / `ReviewActionUtil` de tldraw). Límite fijo de pasos por pedido para no gastar sin control. |
| **Generar desde requisitos** | El usuario pega o dicta un enunciado y la IA arma el diagrama completo, narrando y con el cursor. |

---

## 7. Colaboración entre dueño y colaborador

| Mejora | Cómo |
|---|---|
| **Compartir un turno** | Como cada hilo es privado, un botón envía una respuesta o propuesta de la IA a otro integrante (por ejemplo, al tablón del proyecto, `tablon_mensajes`). |
| **"¿Qué cambió Juan desde ayer?"** | Tabla `operaciones_log(id, proyecto_id, usuario_id, lote_id, operacion, creado_en)` y una acción para que la IA la consulte y lo resuma. |
| **Avisar conflictos** | *Awareness* de Yjs: "Juan está editando Pedido". |
| **Aprobación del dueño** | Si un colaborador pide borrados grandes, quedan pendientes hasta que el dueño los apruebe (validado en el backend con `requireRole`). |

---

## 8. Calidad técnica

| Mejora | Cómo |
|---|---|
| **Memoria resumida** | Cuando el hilo pasa de 20 turnos, se resumen los anteriores y el resumen se guarda por `(proyecto, usuario)`. |
| **Pruebas de la IA** | Vitest con 20 a 30 órdenes y las acciones esperadas, incluidas charlas sin operaciones. |
| **Control de costos** | Guardar los tokens (`usage`) por usuario y poner un límite diario. |

---

## Dependencias nuevas

| Paquete | Uso | ¿Obligatorio? |
|---|---|---|
| `@ricky0123/vad-web` | Interrumpir hablando | Solo para la interrupción por voz |
| `driver.js` | Globos de explicación sobre botones | Opcional |
| Piper / Kitten TTS (servidor) | Voz más natural | Opcional |

El cursor fantasma se hace con CSS (no hace falta `framer-motion`). El parser de JSON incompleto es una función corta propia (se reescribe tomando como referencia la de tldraw, MIT).

---

## Prioridad

1. 🥇 **Conversacional**: respuesta como lista de acciones, con `mensaje` como acción válida.
2. 🥈 **Sesiones por colaborador**.
3. 🥉 **Ejecución automática + cursor fantasma + deshacer con `Y.UndoManager`**.
4. **Streaming por SSE** con voz frase por frase e interrupción.
5. Señalar nodos y contexto de selección.
6. "Revisar mi diagrama" y trabajo en varios pasos.
7. Colaboración: compartir turno, "¿qué cambió…?", aprobación del dueño.
8. Memoria resumida, pruebas de la IA y control de costos.

## Checklist

- [x] Confirmar la librería del lienzo (`@xyflow/react`).
- [x] Esquema de respuesta como lista de `acciones` (`pensar`, `mensaje`, `operacion`, `señalar`).
- [x] Frontend: mostrar respuestas de solo texto (quitar "Orden no reconocida" cuando hay `mensaje`).
- [x] Historial por `(proyecto_id, usuario_id)`, migración del índice y ajuste del `SYSTEM_PROMPT`.
- [x] Comentarios espontáneos al hilo de quien hizo el cambio.
- [x] Ajuste "La IA aplica los cambios sola" y confirmación solo para borrados.
- [x] Atributos `data-ia` en los botones y cursor fantasma.
- [x] Centrar y resaltar nodos con React Flow.
- [x] Deshacer por respuesta con `Y.UndoManager` y un `origin` propio de la IA.
- [x] Streaming por SSE con parser de JSON incompleto y cancelación.
- [x] Voz frase por frase e interrupción (con el botón del micrófono en vez de VAD, por decisión: VAD sumaba ~13,5 MB).
- [x] Selección y últimas acciones del usuario como contexto.
- [x] Reglas locales de revisión + botón "Revisar mi diagrama".
- [x] Compartir un turno con otro integrante.
- [x] Resumen "¿qué cambió…?" (con el historial del diagrama que ya existía, sin tabla `operaciones_log`).
- [ ] ~~Aprobación del dueño para borrados grandes~~ (descartado por decisión: se deja como está).
- [x] Pruebas de la IA con Vitest.
- [x] Vista previa fantasma de los borrados propuestos.
- [x] Avisar conflictos cuando la IA toca una clase que otro edita.
- [x] Memoria resumida por hilo.
- [x] Control de costos (`LLM_LIMITE_DIARIO_TOKENS`).
