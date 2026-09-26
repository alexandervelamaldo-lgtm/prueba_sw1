import { validateDiagram, type ClassDiagram, type ValidationResult } from '@app/shared';
import { normalize, type NormalizeOptions } from './ir/normalize.js';
import { generateProject } from './render/generate.js';
import { toZipBuffer, writeToDisk } from './package/zip.js';
import type { GeneratedFile, GenerationIR } from './ir/types.js';

export * from './ir/types.js';
export { normalize, type NormalizeOptions } from './ir/normalize.js';
// La validación se mudó a `shared` para que el navegador pueda ejecutarla sin
// red (ver la cabecera de `shared/src/validation/validate.ts`). Se sigue
// reexportando desde aquí porque «qué hace falta para poder generar» es parte
// del contrato del generador, lo tenga escrito donde lo tenga.
export {
  validateDiagram,
  type ValidationResult,
  type ValidationIssue,
  type Severity,
} from '@app/shared';
export { buildEntityView, generateProject } from './render/generate.js';
export { render, listTemplates } from './render/engine.js';
export { buildManifiesto, renderManifiesto } from './asistente/manifiesto.js';
export { toZipBuffer, writeToDisk, writeZipToDisk, zipSize } from './package/zip.js';
export { CORPUS, tiendaDiagram, rrhhDiagram, minimoDiagram } from './fixtures/corpus.js';
export { generateFlutter } from './flutter/generate-flutter.js';

export type GenerationOutcome =
  | { ok: true; ir: GenerationIR; files: GeneratedFile[]; warnings: ValidationResult['warnings'] }
  | { ok: false; validation: ValidationResult };

/**
 * Punto de entrada del generador.
 *
 * Un diagrama inválido no es una excepción: es el resultado normal de que
 * alguien esté dibujando. Se devuelve como valor para que la interfaz pueda
 * mostrar los errores junto a los elementos afectados (RF-GEN-03) en lugar de
 * tener que capturar y traducir un error.
 */
export function generate(
  diagram: ClassDiagram,
  options: NormalizeOptions = {},
): GenerationOutcome {
  const validation = validateDiagram(diagram);
  if (!validation.ok) {
    return { ok: false, validation };
  }

  const ir = normalize(diagram, options);
  const files = generateProject(ir);
  return { ok: true, ir, files, warnings: validation.warnings };
}

/** Genera y empaqueta en un ZIP. Lanza si el diagrama no es válido. */
export async function generateZip(
  diagram: ClassDiagram,
  options: NormalizeOptions = {},
): Promise<Buffer> {
  const outcome = generate(diagram, options);
  if (!outcome.ok) {
    throw new Error(
      `El diagrama no es válido: ${outcome.validation.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return toZipBuffer(outcome.files);
}

/** Genera y vuelca a disco. Devuelve las rutas escritas. */
export async function generateToDirectory(
  diagram: ClassDiagram,
  outputDir: string,
  options: NormalizeOptions = {},
): Promise<string[]> {
  const outcome = generate(diagram, options);
  if (!outcome.ok) {
    throw new Error(
      `El diagrama no es válido: ${outcome.validation.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return writeToDisk(outcome.files, outputDir);
}
