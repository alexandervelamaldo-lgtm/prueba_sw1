# Documentación

| # | Documento | Contenido |
|---|---|---|
| 1 | [Requisitos](01-requisitos.md) | RF y RNF con identificadores trazables, matriz de trazabilidad, preguntas abiertas |
| 2 | [Arquitectura](02-arquitectura.md) | Vistas de contexto y contenedores, modelo CRDT, sincronización offline, generador, IA, integración externa |
| 3 | [Stack tecnológico](03-stack-tecnologico.md) | Elecciones por capa con alternativas descartadas, matriz de decisiones, riesgos técnicos |
| 4 | [Plan de sprints](04-plan-sprints.md) | 6 sprints, spikes de riesgo, criterios de aceptación, calendario de decisiones |
| 5 | [Guía de voz y OCR](05-guia-voz-y-ocr.md) | Uso paso a paso de las dos funcionalidades, importación y exportación en XMI, importar diagramas de comunicación desde XMI y los requisitos de formato de cada dialecto, módulos y subpaquetes, el diagrama de comunicación del backend generado, configuración de la clave, seguridad, límites conocidos del OCR |
| 6 | [Despliegue](06-despliegue.md) | De GitHub a AWS: qué revisar antes del primer commit, la imagen Docker, App Runner y ECS, la base de datos —esquema, TLS y qué está verificado y qué no— y por qué el disco efímero obliga a PostgreSQL |
| 7 | [Cuentas y contraseñas](07-cuentas-y-contrasenas.md) | Crear la cuenta, el código de recuperación de un solo uso, recuperar sin servidor de correo, la escotilla de operador, qué pasa con las sesiones abiertas y qué está probado y qué no |
| 8 | [Casos de uso](08-casos-de-uso.md) | Los diecinueve casos de uso con sus actores, participantes, flujo principal, alternativos y actividad. **Se genera**: sale del mismo sitio que los `.xmi` de `docs/uml/` |
| 9 | [Calidad, escalabilidad e innovación](09-calidad-escalabilidad-innovacion.md) | Los tres criterios de evaluación, localizados en el código: qué está verificado por una prueba, qué está implementado sin vigilar y qué sigue pendiente. Incluye el techo real del sistema y un guion de defensa de cinco minutos |
| 10 | [Asistente móvil](10-asistente-movil.md) | El teléfono contra el backend generado: el manifiesto que hace que un solo APK sirva para cualquier diagrama, el repertorio de órdenes dictadas, el ciclo hablado, la bandeja de salida cuando no hay cobertura y por qué reenviar no duplica |
| 11 | [Comunicación interna](11-comunicacion-interna.md) | El tablón del proyecto: chat y notas de voz para coordinarse mientras se modela. Quién puede escribir y por qué basta con ser `viewer`, qué queda cuando se retira un mensaje, por qué se sondea en vez de usar el WebSocket que ya hay, y el permiso de micrófono del WebView —el fallo que no da ningún error visible— |
| 12 | [Tipos de edición y XMI con Enterprise Architect](12-tipos-de-edicion-y-xmi.md) | Con archivo y línea: cómo funcionan la edición normal, con IA y con imágenes, por qué las cuatro vías de escritura convergen en una sola función, y por qué el XMI probado contra un fichero real de EA no debe confundirse con el cliente `architech/` (siempre 501) |

## Cómo leerlo

- Para entender **qué** se construye: documento 1.
- Para entender **por qué** está construido así: documento 2, sección [2.1 Principios rectores](02-arquitectura.md#21-principios-rectores) y [2.11 Decisiones registradas](02-arquitectura.md#211-decisiones-registradas).
- Para entender **con qué**: documento 3, [matriz de decisiones](03-stack-tecnologico.md#39-matriz-de-decisiones).
- Para entender **cuándo**: documento 4.
- Para **usar** el control por voz o la importación desde foto: documento 5. Empieza por [§5.0](05-guia-voz-y-ocr.md#50-qué-significa-aquí-base-de-datos-léelo-antes-que-nada), que aclara qué significa exactamente «base de datos» en esta herramienta.
- Para **intercambiar el diagrama con otra herramienta UML** (Enterprise Architect, Papyrus, StarUML): documento 5, [§5.5](05-guia-voz-y-ocr.md#55-importar-y-exportar-xmi-rf-diag-12).
- Para **generar el backend Spring Boot y comprobar qué sale antes de descargarlo** —el recuento por capas contesta si están las cuatro más el DTO sin abrir el ZIP—: documento 5, [§5.8](05-guia-voz-y-ocr.md#58-generar-el-backend-y-verlo-antes-de-descargarlo-rf-gen-13).
- Para **repartir el dominio en contextos acotados** en vez de dejar cuarenta clases en un paquete: documento 5, [§5.9](05-guia-voz-y-ocr.md#59-módulos-repartir-el-dominio-en-subpaquetes). Lo que hay que leer si la duda es si el módulo cambia de verdad lo que se genera o solo colorea cajas: el apartado «Lo que hace que no sea una etiqueta».
- Para **traer un diagrama de comunicación hecho en otra herramienta** y verlo aquí, con sus mensajes numerados y sus guardas: documento 5, [§5.14](05-guia-voz-y-ocr.md#514-importar-un-diagrama-de-comunicación-desde-xmi). Ahí están también los **requisitos de formato**: qué exige cada uno de los dos dialectos admitidos —Enterprise Architect (XMI 2.1) y UML 2.5.1 canónico—, qué se comprueba de lo importado y qué no se lee a propósito.
- Para ver **quién llama a quién dentro del backend generado** —el diagrama de comunicación de las cuatro capas, con la línea de Java que respalda cada mensaje—: documento 5, [§5.10](05-guia-voz-y-ocr.md#510-diagrama-de-comunicación-quién-llama-a-quién). No sale de las relaciones del diagrama de clases, y el apartado «De dónde salen los mensajes» explica por qué no podría salir de ahí.
- Para **usar por voz el backend que se ha generado**, desde el teléfono y sin tocar la web: documento 10. Ojo con no confundirlo con el 5: en el 5 se habla *para editar el diagrama*, en el 10 se habla *para dar de alta un pedido en la aplicación que salió de ese diagrama*. La diferencia está explicada en la tabla que abre el [documento 10](10-asistente-movil.md).
- Para entender **por qué un solo APK vale para cualquier proyecto** —el teléfono no se recompila cuando se mueve una caja del diagrama—: [§10.1](10-asistente-movil.md#101-el-manifiesto-un-solo-apk-para-cualquier-proyecto).
- Para **dictar sin cobertura** y saber qué queda apuntado y qué no se puede apuntar: [§10.6](10-asistente-movil.md#106-sin-cobertura-la-bandeja-de-salida). Si lo que se quiere es la garantía de que reenviar no duplica nada, [§10.7](10-asistente-movil.md#107-por-qué-reenviar-no-duplica).
- Para **poner el teléfono a hablar con el `localhost` del portátil** el día de la defensa: [§10.2](10-asistente-movil.md#102-puesta-en-marcha), que empieza por el `adb reverse`.
- Para **preguntarle a la aplicación cómo se hace algo** en vez de leer esto: el botón «? Ayuda» busca dentro de estos mismos documentos y contesta, con o sin conexión. Cómo funciona y cómo instalar el modelo local: [§5.7](05-guia-voz-y-ocr.md#57-la-guía-preguntar-cómo-se-hace-algo).
- Para **el análisis en UML** —casos de uso, comunicación, secuencia, actividad, clases de análisis—: documento 8, y los ficheros de `docs/uml/`, que se abren en Enterprise Architect. Los dos salen del mismo catálogo: no se editan a mano, se regeneran con `npm run diagramas --workspace @app/backend-tool`.
- Para **defender el trabajo** —qué respalda que el software tenga calidad, escale e innove, y dónde no llega—: documento 9. Empieza por [§9.1](09-calidad-escalabilidad-innovacion.md#91-cómo-leer-las-tablas), que distingue lo verificado por una prueba de lo que solo está escrito, y termina en [§9.6](09-calidad-escalabilidad-innovacion.md#96-cómo-enseñarlo-en-la-defensa).
- Para **hablar con el resto del equipo sin salir del diagrama** —el tablón del proyecto, por texto o por nota de voz—: documento 11. Ojo con no confundirlo con el «diagrama de comunicación» del documento 5: son cosas distintas que comparten palabra, y la primera línea del [documento 11](11-comunicacion-interna.md) explica por qué en el código se llama «tablón».
- Si **el micrófono no graba desde la app del teléfono** y no aparece ningún error: [§11.6](11-comunicacion-interna.md#116-el-micrófono-dentro-del-webview). El permiso hay que darlo dos veces, a dos interlocutores distintos, y dar solo el primero falla en silencio.
- Para **entrar, o para volver a entrar si se olvidó la contraseña**: documento 7. Aquí no hay «te hemos enviado un correo»; hay un código que se enseña una sola vez y conviene leer [§7.2](07-cuentas-y-contrasenas.md#72-el-código-de-recuperación) antes de cerrar esa pantalla, no después.

## Estado

Sistema construido y en funcionamiento. Los documentos 1 a 4 se escribieron antes de empezar y se conservan tal cual: son el diseño, no el acta de lo ocurrido. Donde el código se apartó de ellos, manda el código, y la diferencia está anotada en el documento 9.

De las ocho preguntas abiertas de [§1.6](01-requisitos.md#16-preguntas-abiertas), cinco las contestó el propio desarrollo y tres siguen sin contestar:

| | Estado |
|---|---|
| **Q4** — formato canónico del modelo | Resuelta. Es el de `shared/`, y de él salen tanto el generador como el manifiesto del móvil |
| **Q5** — versiones de Spring Boot y Java | Resuelta. Spring Boot 3.3.5 sobre JDK 17, verificado compilando y arrancando el proyecto generado |
| **Q6** — restricciones de despliegue | Resuelta. AWS con PostgreSQL gestionado; el porqué del descarte del disco efímero está en el documento 6 |
| **Q3** — dirección de la integración | Resuelta en la práctica: XMI en los dos sentidos con Enterprise Architect (documento 5, §5.5) |
| **Q8** — corpus de fotos de pizarra | Parcial. La lectura desde imagen funciona, pero **no se ha medido contra un corpus**: no hay cifra de acierto que defender, solo ejemplos |
| **Q1, Q2** — contrato e identidad de Architech | **Sin resolver.** La sección [2.9](02-arquitectura.md#29-integración-con-architech-enterprise) sigue siendo provisional entera |
| **Q7** — usuarios concurrentes esperados | **Sin resolver.** Los umbrales de RNF-ESC siguen siendo conjeturas; el techo real medido está en el documento 9 |

Lo que falta por hacer, y lo que está implementado pero sin una prueba que lo vigile, está en [§9.1](09-calidad-escalabilidad-innovacion.md#91-cómo-leer-las-tablas) y en las tablas que le siguen.
