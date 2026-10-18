/** Adaptado de tldraw, `templates/agent/worker/do/closeAndParseJson.ts` (MIT). */
export function cerrarYParsearJson(texto: string): unknown | null {
  const abiertos: string[] = [];
  let enCadena = false;
  let escapado = false;

  for (const caracter of texto) {
    if (enCadena) {
      if (escapado) {
        escapado = false;
      } else if (caracter === '\\') {
        escapado = true;
      } else if (caracter === '"') {
        enCadena = false;
      }
      continue;
    }

    if (caracter === '"') {
      enCadena = true;
    } else if (caracter === '{' || caracter === '[') {
      abiertos.push(caracter);
    } else if (caracter === '}' || caracter === ']') {
      const esperado = caracter === '}' ? '{' : '[';
      if (abiertos.pop() !== esperado) return null;
    }
  }

  let cerrado = texto;
  if (enCadena) cerrado += escapado ? '\\"' : '"';
  for (let indice = abiertos.length - 1; indice >= 0; indice -= 1) {
    cerrado += abiertos[indice] === '{' ? '}' : ']';
  }

  try {
    return JSON.parse(cerrado) as unknown;
  } catch {
    return null;
  }
}
