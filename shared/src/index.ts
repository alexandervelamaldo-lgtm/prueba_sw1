export * from './model/uml.js';
export * from './model/type-catalog.js';
export * from './model/naming.js';
export * from './model/capas.js';
// El diagrama de comunicación tal y como lo define UML, que no es el mismo
// tipo que el de `capas.js`: aquel describe los que esta herramienta dibuja
// sola a partir del backend generado. Ver la cabecera del fichero.
export * from './model/comunicacion-uml.js';
export * from './model/comunicacion-integridad.js';
export * from './model/id.js';
export * from './model/factory.js';
// La diferencia estructural entre dos diagramas: la usa el panel de versiones
// para comparar una versión guardada contra el diagrama en curso, sin tocar
// el CRDT. Ver la cabecera del fichero.
export * from './model/diff.js';
export * from './ops/operations.js';
export * from './ops/impact.js';
export * from './ops/import-table.js';
export * from './ops/import-diagram.js';
export * from './crdt/document.js';
export * from './crdt/comunicaciones.js';
export * from './crdt/operations.js';
export * from './crdt/historial.js';
export * from './crdt/wire.js';
export * from './crdt/provider.js';
export * from './ai/grammar.js';
export * from './xmi/xml.js';
export * from './xmi/export.js';
export * from './xmi/import.js';
// `comun.js` no se reexporta: su `AvisoXmi` ya sale por `import.js`, y dos
// `export *` con el mismo nombre lo dejarían inaccesible para quien lo importe.
export * from './xmi/comunicacion.js';
export * from './xmi/etiqueta-mensaje.js';
export * from './xmi/diagrama-comunicacion.js';
// El análisis de casos de uso, su catálogo y su escritor para Enterprise
// Architect. Van en `shared` y no en `backend-tool` porque el catálogo describe
// el sistema entero —frontend incluido— y porque así el modelo y sus pruebas
// viven en el mismo sitio.
export * from './xmi/analisis.js';
export * from './xmi/casos-de-uso.js';
export * from './xmi/catalogo-md.js';
export * from './xmi/ea-comunicacion.js';
// Contrato del manifiesto del asistente móvil. Vive en `shared` porque lo
// escribe el generador y lo lee la app: un contrato que solo conoce quien lo
// emite no es un contrato.
export * from './asistente/manifiesto.js';
// La validación bloqueante previa a generar: «¿se puede emitir Java, JPA y SQL
// de esto?». Vivía en `generator`, que el navegador no puede importar; está
// aquí para que el editor la conteste sin red. Ver la cabecera del fichero.
export * from './validation/validate.js';
// La revisión de modelado. Es una pregunta distinta de la que contesta el
// validador de arriba —«¿está bien hecho?» en vez de «¿se puede generar?»— y
// por eso vive aparte y no comparte códigos con él.
export * from './revision/revision.js';
// El plan de reparación: convierte los errores del validador en operaciones
// concretas. Nunca se aplica solo; ver la cabecera del fichero.
export * from './reparacion/reparar.js';
export * from './guia/corpus.js';
export * from './guia/buscar.js';
export * from './guia/prompt.js';
// El tablón del proyecto: el módulo de comunicación interna. Se llama tablón y
// no «comunicación» porque esa palabra ya está tomada tres veces en este
// paquete por los diagramas de comunicación UML. Ver la cabecera del fichero.
export * from './tablon/mensaje.js';
