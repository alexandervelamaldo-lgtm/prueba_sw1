# Modo IA — Fase 2

Objective: conversational AI that runs operations itself (ghost cursor), with private per-collaborator sessions. Plan: `fase2-mejoras.md`.
Branch: `yimy`. Delivery: ask-on-risk. Test runner: Vitest (`npm test` at the root).

## Specs

- **S1** — "quiero que la IA sea conversacional". Acceptance: a question with no operations (for example "¿qué te parece mi diagrama?") gets a text reply from the AI instead of "Orden no reconocida".
- **S2** — "debe de ser posible mandarle mensajes y que les responda". Acceptance: typed messages in Modo IA get answers (the text path already exists in `ModoIA.tsx`; S1 makes the answers appear).
- **S3** — "estas sesiones no debe de ser compartidas con los demas que son colaboradores sino que deben de ser sesiones para cada colaborador". Acceptance: each collaborator only sees and continues their own thread per project.
- **S4** — "que pueda ejecutar las operaciones y de la sensacion de que pareciera que apreta los botones". Acceptance: the AI applies non-destructive operations itself, one at a time, with a cursor moving over the real buttons; destructive operations still ask for confirmation.
- **S5** — The remaining items of `fase2-mejoras.md` (streaming, pointing at nodes, review, collaboration, quality), in the priority order of that file.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1, S2 | inline | done | 9b85523 |
| T2 | S3 | inline | done | (this commit) |
| T3 | S4 | inline | pending | — |
| T4 | S5 (streaming) | inline | pending | — |
| T5 | S5 (rest) | — | pending | — |

## Log

- **L1** (2026-10-17): "quiero que revises el archivo "fase2_mejoras.md", en donde quiero que opinas sobre ela informacion que se encuentra ahi, quisiera implementar esas cosas, en donde no se, si me olvide mencionarlo pero tambien debe de ser posible mandarle mensajes y que les responda, y estas sesiones no debe de ser compartidas con los demas que son colaboradores sino que deben de ser sesiones para cada colaborador"
- **L2** (2026-10-17): "quiero que la IA sea conversacional y que pueda ejecutar las operaciones y de la sensacion de que pareciera que apreta los botones revisa bien ese plan o todo eso ya lo hace el proyecto actual"
- **L3**: Finding: the model can already return `operations: []` with an `explanation`, but `ModoIA.tsx:209` and `Asistente.tsx:113` replace it with "Orden no reconocida", and the system prompt only asks the model to translate orders.
- **L4**: T1 design: the model answers with `{"actions":[...],"confidence":n}`, where each action is `message`, `think` or `operation` (pattern from tldraw `templates/agent`, MIT). `parseAssistantResponse` still accepts the legacy shape. The HTTP response stays the same (`propuesta`, `explicacion`, `aclaracion`), so the mobile app is unaffected.
- **L5**: T1 RED: 8 new tests failed (4 in `backend-tool/src/ai/assistant.test.ts`, 4 in `frontend/src/components/asistente-voz.test.ts`). GREEN: 77/77 in both files; `npm run typecheck` exit 0; full suite 2043 passed, 1 failed in `backend-tool/src/storage/versiones.test.ts` ("listar devuelve los resúmenes en orden cronológico ascendente"), which also fails intermittently on the base without this change (2 of 3 runs), so it is pre-existing. ESLint cannot run: there is no `eslint.config.*` in the repo.
- **L6**: Risk: item 6 (the rewritten system prompt changes the real model's behavior, which no test covers). Independent read-only review requested from Codex (Herdr pane `wA:p3`).
- **L7**: Codex review: no blockers. Advisories: (a) the reduction to `operations` + `explanation` loses the interleaving of messages and operations; kept on purpose for T1, T3 must carry the ordered actions to the UI; (b) an empty action list still ends in "Orden no reconocida" (accepted fallback); (c) `max_tokens` raised from 2048 to 4096 because `think` and `message` actions add output.
- **L8** (2026-10-17): "vamos con esa tarea". Open decision resolved with the recommendation already given to the user: a spontaneous comment goes to the thread of whoever made the last change of the burst, whether or not they have Modo IA open.
- **L9**: T2 design: `ConversationStore` methods take `usuarioId`; the file store tags each message with `hiloDe`; Postgres adds `conversaciones_ia.hilo_usuario_id` (thread owner on every row) and index `conversaciones_por_hilo`. Legacy shared-thread rows keep a null owner and are never read. `vigilancia.ts` takes the author from the Yjs transaction origin (`connection.userId`, or `{ via: 'api', userId }` now set in `api/diagrams.ts`); no known author means no comment. The system prompt no longer describes a shared thread, and history turns are no longer prefixed with the author name.
- **L10**: T2 RED: 9 store tests, 3 watcher tests and 2 API tests failed. GREEN: backend 384 passed, 1 failed (the pre-existing `versiones.test.ts` flake); full suite 2048 passed, same single flake; `npm run typecheck` exit 0. Postgres probe on a throwaway `postgres:17-alpine` container: old schema plus legacy rows, then the new schema applied twice → legacy hidden from Ana, Ana and Beto isolated, a comment only in Beto's thread, Ana pruned to 40 messages without touching Beto, 2 legacy rows kept, indexes `conversaciones_ia_pkey,conversaciones_por_hilo`. Container and probe script removed.
- **L11**: Risk: item 1 (persisted format and schema change; legacy rows become hidden). Independent verification requested from Codex.
- **L12**: Codex verification: 1 blocker, `vigilancia.ts` kept a stale author, so an unattributed last change (or a later burst) could be commented in the previous author's private thread. Fixed: an update without an author clears it, and `revisar` consumes it; 2 regression tests (RED, then GREEN). Recheck by Codex: "blocker fixed". Backend 387 passed; `npm run typecheck` exit 0. API routes, prompt history, per-user pruning, Postgres SQL and the migration found correctly scoped.
