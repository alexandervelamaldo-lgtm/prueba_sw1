# Generator end-to-end review fixes

Objective: fix the defects found by the 2026-11-01 end-to-end review (Codex), from diagram creation to Flutter generation.
Branch: `yimy` (owner pushes straight to `main`). Delivery: `exception-ok`, one commit per task, no PRs. Test runner: Vitest (`npx vitest run generator shared`); opt-in compile/boot check with `COMPILAR_GENERADO=1`.

## Specs

- **S1** E3-01: "la colección Postman falla con una entidad que solo tiene ID". "`Crear Reporte` responde 400; luego las operaciones por ID fallan porque la colección guarda `null`". The whole collection must pass with an id-only entity.
- **S2** E4-01: "una entidad que solo tiene ID genera Dart inválido". "`crear({})` y `actualizar(id,{})`, sintaxis Dart inválida". The app must pass `flutter analyze` with an id-only entity.
- **S3** E4-02: "el modelo Flutter pierde campos heredados". "el backend acepta y devuelve `nombre`, pero el modelo y formulario Flutter no lo pueden enviar, retener ni mostrar". Inherited fields reach models, services and forms.
- **S4** E4-03: "la app Flutter no representa relaciones N:M". "el cliente generado no puede crear ni actualizar la N:M dibujada. La API PostgreSQL generada tampoco expone esa propiedad en su DTO". Assumption: same contract as MongoDB/Cassandra, the owning side carries `<name>Ids`, in PostgreSQL too; the form takes the ids as comma-separated text. In PostgreSQL a request without the list leaves the relation untouched, because manifest-driven clients do not know about it (voice dictation stays without N:M).
- **S5** E4-04: "el build Linux falla por incompatibilidad del plugin de grabación resuelto". `flutter build linux` must compile.
- **S6** E5-01: "Flutter entrega código fuente, pero no un proyecto ejecutable por los comandos del README". "`run` informa “No supported devices connected”"; "`build apk` termina porque falta `android/app/build.gradle`". Following the README on a fresh ZIP must build an APK, and `flutter test` must not fail on the `MyApp` template test.
- **S7** E2-01: "relación `dependency` descartada sin aviso". Assumption: a dependency has no code to generate, so it stays out and the user gets a warning.
- **S8** E2-02: "literal enum cambia de minúsculas a mayúsculas sin aviso". Assumption: literals stay uppercase (Java convention, DUPLICATE_ENUM_LITERAL relies on it) and the user gets a warning.
- **S9** Found by the `mixto` corpus diagram: a subclass cannot be created when its parent has a mandatory association, because its DTO omits inherited associations ("Crear Cliente: 409").
- **S10** Found the same way: an association to an abstract class does not compile ("importa com.ejemplo.mixto.repository.PersonaRepository, que no se genera"), and its Postman reference had no variable to use.
- **S11** Found while fixing S6: a project name with `'`, `$` or `:` breaks the generated Dart and `pubspec.yaml`.

Out of scope (reported, not changed): enum and foreign-key form fields stay free text; web is not a target because `whisper_flutter_new` needs `dart:ffi`; `mvn`/`flutter` on PATH and a busy port 5432 are the reader's environment, not generator defects.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1, S2 | inline | done (RED/GREEN) | dd3f3c5 |
| T2 | S3, S9 | inline | done (RED/GREEN) | 12dbcb0, 7202676 |
| T3 | S4, S10 | inline | done (RED/GREEN) | 3e692c9, 7202676 |
| T4 | S5, S6, S11 | inline | done except APK (L4) | b421062 |
| T5 | S7, S8 | inline | done (RED/GREEN) | b30accd |
| T6 | all | Codex verifier (Risk item 5: dependencies) | pending | |

Route evidence: no Writer trigger reason; units share `generate-flutter.ts`, so the parent writes inline.

## Log

- **L1** (2026-11-01, user): "quiero que te traigas los cambios de la main, del proyecto y delegues a codex la revision del proyecto, desde la creacion de diagramas hasta la generacion de codigo con flutter, quiero que todo sirva a la perfeccion"
- **L2** `origin/main` (03a3dc2) is already contained in `yimy`: nothing to merge. Codex reviewed stage by stage (its broad run was blocked by an unavailable delegated model). Stage 1 had no reproduced defects.
- **L3** RED/GREEN observed per task. Suite: 738 passed. `COMPILAR_GENERADO=1`: 29/29 on 7202676; Flutter block 5/5 on b421062 (`flutter create`, `analyze`, `test`, `build linux`).
- **L4** `flutter build apk` NOT verified: `whisper_flutter_new` forces `ndk;27.0.11902837`, not installed here, whose licence is not accepted ("LicenceNotAcceptedException"). Setting the app's `ndkVersion` to the installed 28.2 does not help, the plugin still asks for 27. Accepting a licence is the user's decision.
- **L5** Known and left as is: in MongoDB/Cassandra a request without the N:M list empties it (pre-existing, pinned by a test), whereas PostgreSQL leaves it untouched.
