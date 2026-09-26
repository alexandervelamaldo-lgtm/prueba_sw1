# 12. Tipos de edición y el intercambio con Enterprise Architect

> Este documento existe para defender, con archivo y línea, dos afirmaciones
> concretas del enunciado: **(1)** que la aplicación soporta al menos tres
> tipos de entrada de edición —normal, con IA, con imágenes— y **(2)** que
> importa y exporta diagramas de clases desde y hacia Enterprise Architect. No
> repite la guía de uso (eso ya está en el [documento 5](05-guia-voz-y-ocr.md));
> aquí el objetivo es otro: mostrar el código que hace cierta cada frase, y
> señalar dónde una frase suena más fuerte de lo que el código sostiene.

## 12.0 La idea que atraviesa las tres formas de editar

Antes de entrar en cada camino, una cosa que conviene decir primero porque
explica por qué los tres apartados de abajo terminan todos en el mismo sitio:

**El ratón, la IA, la voz y la importación de imágenes o XMI no escriben el
diagrama cada uno a su manera. Los cuatro producen la misma estructura de
datos —`Operation[]`— y la aplican con la misma función.**

```
shared/src/crdt/operations.ts
  └── applyOperations(doc, operaciones)   ← el único sitio que escribe
        └── applyOperation(doc, una operación)
              └── resolveClass(doc, ref)  ← busca por {id} o por {name}
```

Dos consecuencias que se repiten en todo lo que sigue:

- **Atomicidad**: `applyOperations` abre un `Y.UndoManager` sobre
  `[classesMap, relationsMap, modulesMap]` y si una operación del lote falla,
  deshace las que ya habían entrado. O entran todas, o no entra ninguna. Por
  eso un lote de la IA con tres operaciones (crear relación + dos atributos)
  puede fallar entero por un choque de nombres, como pasó en el bug real que
  se arregló en `addRelation` (ver el comentario de esa función).
- **Decisión D6** (`docs/02-arquitectura.md`, línea 744): *la IA propone,
  nunca escribe directo*. La IA, la voz y la importación de imagen/XMI generan
  `Operation[]` y las enseñan en una pantalla de revisión; solo se llaman a
  `applyOperations` cuando una persona pulsa «Aplicar». El ratón es la única
  vía que no pasa por revisión, porque cada clic ya *es* la decisión de la
  persona.

Con esto entendido, cada tipo de edición es solo «quién produce las
`Operation[]` y cómo se revisan antes de aplicarlas».

---

## 12.1 Edición normal (ratón y teclado sobre el lienzo)

| Qué | Dónde |
|---|---|
| Componente que se pinta | `frontend/src/components/LienzoFlow.tsx` (usa React Flow; `Lienzo.tsx` solo aporta el tipo `OrdenVista`, no es el componente montado) |
| Se importa en | `EditorDiagrama.tsx:18` |
| Escribe con | `applyOperations` directamente, sin pantalla de revisión |

Arrastrar una clase, dibujar una relación o escribir un atributo en el panel
de propiedades termina, en algún punto de `EditorDiagrama.tsx` o
`PantallaMovil.tsx`, en una llamada a las funciones de `useDiagrama` que
envuelven `applyOperations`. No hay nada que decir aquí que sea
controvertido: es la vía de edición de referencia contra la que se comparan
las otras tres, y es la única sin paso de revisión porque no hace falta —el
clic ya lo dio una persona mirando el lienzo.

---

## 12.2 Edición con IA

| Qué | Dónde |
|---|---|
| Prompt del sistema | `backend-tool/src/ai/assistant.ts:38` (`SYSTEM_PROMPT`) |
| Llamada desde el frontend | `frontend/src/components/Asistente.tsx:123` (`api.interpretar(...)`) |
| Fallback sin conexión | `shared/src/ai/grammar.ts` → `interpretCommand()`, usado en `Asistente.tsx:135` (si la llamada remota falla) y `:227` (dictado por voz) |
| Proveedores reales | Gemini / DeepSeek / OpenAI, vía `backend-tool/src/ai/transporte.ts` |

**Cómo funciona:** la persona escribe (o dicta) una orden en castellano
—«añade un atributo precio de tipo Float a Producto»—. El backend manda esa
frase más el `SYSTEM_PROMPT` a un LLM, que devuelve `Operation[]` en JSON. El
frontend las enseña como una propuesta con el nombre del modelo que contestó
(«modelo-remoto (gemini-3.7-flash)», que es justo lo que se veía en el bug de
la clase duplicada) y solo las aplica si la persona pulsa «Aplicar» (decisión
D6).

**Por qué existe el fallback local (`grammar.ts`):** decisión D5. Si no hay
red o el proveedor no responde, una gramática determinista y sin red
interpreta un subconjunto de órdenes (crear clase, añadir atributo, crear
relación simple). No entiende lenguaje libre como el LLM, pero no depende de
ningún servicio externo.

**Matiz para la defensa:** esto **modifica un diagrama que ya existe** con
instrucciones puntuales. No es «generar el diagrama completo a partir de una
descripción del dominio en un párrafo» — esa capacidad no está construida.
Decirlo así evita que el tribunal pida una demo que el sistema no hace.

---

## 12.3 Edición con imágenes

| Qué | Dónde |
|---|---|
| Motor de visión | `backend-tool/src/ai/vision.ts` → `OpenAiVisionEngine` |
| Instrucción para diagramas | `vision.ts:61` (`INSTRUCCION_DIAGRAMA`) |
| Rutas HTTP | `backend-tool/src/api/import.ts` — `POST …/importar-tabla/leer` y `.../proponer` |
| Pantalla de revisión | `frontend/src/components/ImportarDiagrama.tsx` |

**No es OCR clásico.** No hay Tesseract ni detección de cajas de texto: se le
manda la foto entera a un modelo de visión (protocolo compatible con OpenAI)
con una instrucción que pide el diagrama ya estructurado en JSON —clases,
atributos, métodos, relaciones con su cardinalidad—. La diferencia importa
porque un OCR clásico devuelve texto y deja sin resolver justo lo difícil
(qué es una cabecera, qué relaciona con qué); el modelo de visión sí lo
resuelve, pero se equivoca de otra manera: puede leer bien casi todo y fallar
en un detalle silencioso.

**Por qué hay una pantalla de revisión obligatoria y no un camino
automático.** El propio comentario de `vision.ts` (líneas 20–26) documenta el
caso real que motivó el diseño: contra una tabla nítida generada por
ordenador, el modelo leyó `ana@rrhh.com` como `ana@rrrh.com` y declaró
`confianza: 1.0`. Es decir, la confianza que el modelo reporta no predice si
acertó. Por eso las dos rutas del backend están separadas a propósito
(`import.ts`, líneas 20–37): `leer` solo lee la imagen y no toca el diagrama;
`proponer` recibe la tabla o el diagrama **ya revisado por una persona** y
recién ahí genera `Operation[]`. Aplicarlas es una tercera llamada explícita.

**Divergencia con el requisito original, ya reconocida en los docs.** El
requisito `RF-VIS-08` (`docs/01-requisitos.md:112`) pedía procesamiento
**local en el navegador**, sin enviar la imagen a ningún servidor. Lo que hay
implementado envía la imagen a un servidor con un modelo de visión. Está
anotado como renuncia consciente en `docs/04-plan-sprints.md:270` y en
`docs/01-requisitos.md:123`. Para la defensa: es una funcionalidad real y con
pantalla de revisión, pero **no** es «OCR local», y decirlo así evita que
parezca que se oculta la diferencia.

---

## 12.4 Import y export con Enterprise Architect

Aquí hay dos piezas de código con nombres parecidos que **no son la misma
cosa**, y confundirlas en la defensa es el error más fácil de cometer.

### A) XMI — esto es lo que funciona, y está probado contra un archivo real

| Qué | Dónde |
|---|---|
| Exportar | `shared/src/xmi/export.ts` → `diagramaAXmi(diagrama)` |
| Importar | `shared/src/xmi/import.ts` → `leerXmi(texto, diagrama)` |
| Fixture real de EA | `shared/src/xmi/fixtures/ea-comunicacion.xmi` |
| Tests contra ese fixture | `shared/src/xmi/ea.test.ts` (15 casos) |
| Botones en la UI | `EditorDiagrama.tsx:383-390` («Importar XMI…» / «Exportar XMI»), líneas `543-550` |
| Componente de importación | `frontend/src/components/ImportarXmi.tsx` |

**Qué es de verdad.** Es **XMI 2.1, el estándar de la OMG** — el mismo
formato que leen Enterprise Architect, Papyrus o StarUML. No es un protocolo
propietario de EA. Pero el comentario de cabecera de `export.ts` (líneas
37–76) documenta que el fichero se escribió primero contra la especificación
a secas, se probó abriéndolo en Enterprise Architect, **salió mal**, y se
corrigieron tres cosas concretas contra un `.xmi` real exportado por EA:

1. Las clases van dentro de un `uml:Package` (no colgando directo del
   `uml:Model`), porque si no, EA no tiene dónde meter lo importado.
2. El tipo de un extremo de asociación es un hijo `<type xmi:idref="…"/>`, no
   un atributo `type="…"` — con el atributo, EA dejaba los extremos sin tipo
   y la asociación quedaba suelta.
3. Los primitivos de UML (`String`, `Integer`…) se referencian a la
   biblioteca estándar por `href`, en vez de declararse como elementos del
   modelo — si no, EA llena el proyecto de tipos «String» que nadie dibujó.

El importador (`import.ts`) es tolerante a propósito (comentario, líneas
42–60): acepta `xmi:type` o `xsi:type`, con o sin prefijo, el estilo antiguo
de XMI 1.x, tipos como hijo o como atributo, y la marca de agregación en
cualquiera de los dos extremos — porque, como dice el propio comentario,
*«no hay una sola forma de escribir un diagrama de clases en XMI»* y el
código no se escribió con un solo fichero real de referencia por cada
variante.

**Lo que no viaja.** La posición de las cajas en el lienzo no se traduce a
las coordenadas de EA (documentado en `export.ts:62-76`): EA tiene su propio
sistema de geometría y, al importar, coloca los elementos en el navegador de
proyecto para que se compongan a mano. Entre esta herramienta y ella misma
(exportar y volver a importar aquí) no se pierde nada, porque hay un bloque
`xmi:Extension` propio (`export.ts:565-608`, `EXTENDER = 'uml-colaborativo'`)
que guarda posición, clave primaria y filas de ejemplo — cosas que el
estándar UML no contempla y que un lector ajeno simplemente ignora.

**Frase recomendada para la defensa:**
*"Exportamos e importamos XMI estándar de la OMG, contrastado y corregido
contra un fichero real exportado por Enterprise Architect — el fixture y los
15 tests están en el repositorio."*

### B) `backend-tool/src/architech/client.ts` — esto NO es lo de arriba

| Qué | Dónde |
|---|---|
| Interfaz | `ArchitechClient` (`publish`, `import`) |
| Implementación actual | `UnconfiguredArchitechClient` — **siempre** activa |
| Qué hace cada método | Lanza `ArchitechNotConfiguredError` (`status = 501`) |
| Fábrica | `createArchitechClient()` — incluso con credenciales, devuelve el cliente sin configurar |

Es un cliente para una **integración directa por API** con un sistema
llamado "Architech Enterprise" — nótese que el nombre no es literalmente
"Enterprise Architect" — cuyo contrato todavía no se ha definido con el
cliente/profesor que lo pidió. El propio archivo lo dice en su comentario de
cabecera: *"la empresa o cliente aún no ha definido cómo funciona exactamente
su sistema"*. No es un bug ni algo a medio hacer por descuido: es un stub
deliberado que falla con un mensaje claro (501 + explicación) en vez de
fingir que guardó algo que no guardó. En `docs/02-arquitectura.md` esto
corresponde a la sección 2.9, marcada como provisional, y en
`docs/README.md` a las preguntas **Q1/Q2, sin resolver**.

**Por qué importa no mezclar A y B en la defensa:** si alguien pregunta
*"¿tienen integración con Enterprise Architect?"* y se contesta enseñando
`architech/client.ts`, la respuesta correcta según el propio código es
*"no, eso da 501"* — y quedaría mal después de haber dicho que sí funciona.
La respuesta que sí sostiene el código es la de XMI (parte A). Son
capacidades distintas que comparten un nombre parecido por casualidad de
redacción del enunciado.

---

## 12.5 Resumen para la defensa

| Afirmación del enunciado | Veredicto | Con qué se sostiene |
|---|---|---|
| Edición normal | **Sí** | `LienzoFlow.tsx` → `applyOperations` |
| Edición con IA | **Sí**, con matiz | Modifica un diagrama existente con órdenes puntuales; no genera un diagrama entero desde una descripción libre. `assistant.ts` + `grammar.ts` (fallback D5), revisión obligatoria (D6) |
| Edición con imágenes | **Sí**, con matiz | Es visión por modelo, no OCR clásico; requiere revisión humana porque la confianza declarada no predice acierto (caso real documentado en `vision.ts`); diverge del `RF-VIS-08` original (local → servidor), ya reconocido en `docs/01-requisitos.md` |
| Import/export con Enterprise Architect | **Sí** | XMI 2.1 OMG, corregido y probado contra un fichero real de EA (`fixtures/ea-comunicacion.xmi`, `ea.test.ts`) |
| Integración directa vía API con "Architech Enterprise" | **No** | `architech/client.ts` es un stub que siempre devuelve 501; no confundir con el XMI de arriba |

Todas las líneas de esta tabla están verificadas leyendo el código citado en
este documento a fecha de hoy, no solo inferidas de los nombres de archivo.
