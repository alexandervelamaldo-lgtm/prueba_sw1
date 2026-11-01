# AI mode immersive screen

Objective: pressing AI mode changes the editor into its own canvas-first screen, with a one-time particle welcome.
Branch: `yimy` (owner pushes straight to `main`). Delivery: `exception-ok`. Test runner: Vitest (`npx vitest run frontend`).

## Specs

- **S1** "cuando se aprete esa opcion el frontend debe de verse completamente diferente". Chosen layout, "Lienzo + IA": its own screen, the diagram stays the protagonist, the conversation becomes a floating bar over the canvas with the input and microphone, with its own palette. Hidden in this mode: menu bar, toolbar, right-column panels other than AI, status bar, floating assistant, thumb bar.
- **S2** "pensaba poner esto, como una bienvenida al modo IA": `ParticleTitle` as the welcome. Accepted behavior: it plays once, never loops; it starts after the wave animation; it fades out and never blocks canvas clicks; on an empty diagram it stays still until the first class exists; the gather takes about half the original 4.2 s; text "¿Qué diseñamos hoy?". With reduced motion: plain text, no canvas.
- **S3** "que se desaparezcan los apartados de abajo a la izquierda en donde salen las opciones para armar clases, y que solamente salgan las demas". In this mode the Paleta panel is hidden and the Proyecto panel stays visible. Accepted: it comes back by itself on exit and this is not saved in the panel layout.
- **S4** Entry from both the avatar and Ver > Modo IA. A **Salir** button is always visible, plus `Esc`. The mode is not persisted: reloading never starts inside it. Entering or leaving must not remount `ModoIA` or the canvas, because unmounting `ModoIA` aborts the reply and closes the microphone.
- **S5** Project constraints: no Tailwind, no shadcn, no new dependencies. Styles go in `frontend/src/estilos.css` using its tokens (`estilos.test.ts` pins colors, radii and shadows). The theme comes from `data-tema` on `<html>`, not `.dark` or `data-theme`. Drop `"use client"` and the demo.
- **S6** "quiero que despues de haberle dando una instruccion al modo IA, cargue el globo del thinking". While the AI is working (`estadoIA === 'pensando'`) inside the mode, the dotted orb from the pasted `ai-thiking-orb-and-input` shows above the floating bar with its rotating labels in Spanish. Assumption: only the orb and labels are used, because the existing chat input and replies stay and the pasted CSS has only keyframes, no `.mo-*` rules. It never blocks clicks, works in both themes, and is static with reduced motion. The welcome hides while it shows and returns without replaying.
- **S7** "ademas añade una opcion para poder intercalar entre el modo dia o noche". Assumption: a button in the AI mode header next to Salir, because the menu that holds the existing theme command is hidden there. It reuses `alternarTema`.
- **S8** From the owner's "arreglemos entonces", answering the report that the floating bar covers classes. Inside the mode, framing and centering land in the area the bar leaves free, on entry and for classes the AI creates.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1, S3, S4, S5 | delegated to agy (user request), layout fixes inline | done, awaiting owner check, uncommitted | |
| T2 | S2, S5 | delegated to agy (user request) | done, awaiting owner check, uncommitted | |
| T3 | S6, S7, S5 | delegated to agy (user request), small fixes inline | done, awaiting owner check, uncommitted | |
| T4 | S8 | inline, about 30 changed lines (RED/GREEN) | done | see `git log` for this file |

Route evidence: the owner asked to delegate this frontend work to agy. The parent owns git and verifies.

## Log

- **L1** (2026-11-01, user): "añadi una animacion, cuando se apreta el moodo IA, pero me informaron que cuando se aprete esa opcion el frontend debe de verse completamente diferente"
- **L2** (2026-11-01, user): chose "Lienzo + IA".
- **L3** (2026-11-01, user): "en breves te mandare algunos componentes que quiero que delegues a agy el frontend"
- **L4** (2026-11-01, user): "pensaba poner esto, como una bienvenida al modo IA y que se desaparezcan los apartados de abajo a la izquierda en donde salen las opciones para armar clases, y que solamente salgan las demas, pero antes de hacer eso, dime tu opinion"
- **L5** (2026-11-01, user): "ok, podriamos hacer eso", answering whether to keep the Proyecto panel after a recommendation to keep it. Read as: keep it, and accept the recommended welcome behavior.
- **L7** Parent review of agy's first delivery. Typecheck, 1139 tests and build pass, but blockers found by reading the diff: no floating bar or own palette (S1); `Esc` ignored while focus is in the chat input (S4); Ver > Modo IA turns on the microphone, which nobody asked for; an unrelated project comment deleted. One correction batch sent to agy.
- **L6** Animation commits already in: 291479a, eb31bc6. The owner confirmed the lag is gone, so S1 and S2 must not bring it back. Left out of git on purpose: `frontend/src/components/ui/`, the `@` alias in `frontend/tsconfig.json` and `frontend/vite.config.ts`, `.atl/`.
- **L8** Second delivery and parent layout fixes (phone bar position, Proyecto hidden below 900px, welcome above the bar, minimap hidden). Typecheck, 1172 tests and build pass. Real Chromium, software GL, 14 checks pass: entry from menu and avatar, no microphone from the menu, Paleta hidden and back, Esc from the chat input, Salir, no remount of `ModoIA` or canvas, reload stays out, no console errors. Screens reviewed in dark, light and phone. Not exercised: a diagram with classes (welcome fade-out and floating bar over them), a real AI reply, lag on a real GPU. Salir leaves the AI panel docked and open.
- **L9** (2026-11-01, user): "quiero que despues de haberle dando una instruccion al modo IA, cargue el globo del thinking, ademas añade una opcion para poder intercalar entre el modo dia o noche"
- **L10** T3 delivered by agy. Parent fixes: the orb survives a thinking restart during its exit, restored the original dot-radius formula, labels hidden from screen readers since the transcript already announces. Typecheck and 1181 tests pass; build passed before those fixes. Real Chromium, software GL, with the stream delayed by the test: 14 orb, theme and welcome checks and the 14 earlier ones pass, including orb with classes and welcome fade-out. Open: the floating bar covers classes in its area; a real AI reply and lag on a real GPU are not exercised. The labels rotate on a timer, they do not reflect what the AI is doing.
- **L11** (2026-11-01, user): "arreglemos entonces", answering "¿Arreglo primero lo de la barra que tapa clases y después commiteo, o preferís commitear ya?". Read as fix, then commit.
- **L12** S8 done, RED observed. Typecheck, 1183 tests and build pass. Real Chromium, software GL, 28 checks pass: classes above the bar on entry, a class created by an order lands above the bar. The order went through the offline grammar, because the test cuts the stream; a real AI reply and lag on a real GPU stay not exercised. Delivered as one commit: T1 to T4 share `EditorDiagrama.tsx` and `estilos.css`, so they do not split without artificial slices.
