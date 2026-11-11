/**
 * Reconocimiento de órdenes de fichero en el Modo IA («expórtalo en XMI»).
 *
 * El servidor interpreta texto libre contra un vocabulario de `Operation`
 * (crear clase, añadir atributo…): no sabe nada de exportar o importar
 * ficheros, así que ante «expórtalo en XMI» solo puede contestar que no
 * puede. Exportar a XMI, importar un XMI o importar desde una imagen no son
 * decisiones que necesiten entender la frase —son los mismos tres botones
 * fijos del menú Archivo (`EditorDiagrama.tsx`)—, así que se reconocen aquí,
 * en el cliente, antes de mandar nada al servidor.
 *
 * Misma filosofía que la gramática sin conexión (`@app/shared`, `grammar.ts`):
 * un repertorio cerrado y anclado al principio de la frase, no comprensión
 * de lenguaje natural. Anclarlo al verbo inicial es lo que evita que «crea la
 * clase Pedido y expórtalo en xmi» dispare esto en vez de ir a la IA: esa
 * orden no empieza por el verbo de archivo, así que no coincide.
 */

export type AccionArchivo = 'importar-imagen' | 'importar-xmi' | 'exportar-xmi';

const ACENTOS: Record<string, string> = {
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ú: 'u',
  ü: 'u',
  ñ: 'n',
};

function plegar(texto: string): string {
  return texto
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (caracter) => ACENTOS[caracter] ?? caracter)
    .replace(/[¿?¡!]/g, '')
    .trim();
}

/** Quita, como mucho, una muletilla inicial («por favor», «quiero que»…). */
const RELLENO_INICIAL = /^(?:por\s+favor|quiero\s+que(?:\s+lo)?|quiero|puedes|podrias|ahora)\s+/;

function quitarRelleno(texto: string): string {
  return texto.replace(RELLENO_INICIAL, '');
}

/**
 * «Expórtalo en XMI», «exporta el diagrama a xmi», «descarga el xmi».
 *
 * Incluye «expotalo» (sin la primera «r») porque es justo la forma en la que
 * llegó la orden que motivó esto: una transcripción o una errata, no un verbo
 * distinto.
 */
const EXPORTAR_XMI =
  /^(?:exporta(?:lo|la|s|me)?|exportes|exportar|expota(?:lo|la|me)?|descarga(?:lo|la|me)?|descargar|saca(?:lo|la|me)?|sacar|genera(?:lo|la|me)?|generar)\b[\s\S]*\bxmi\b/;

/**
 * «Importa un xmi», «carga el diagrama desde un xmi», «impórtame el xmi».
 *
 * Incluye «imposta(lo|la|me)?»: mismo motivo que «expotalo» en
 * `EXPORTAR_XMI» —una «r» que el dictado convierte en «s» («impórtame» oído
 * como «impóstame»)—, no un verbo distinto.
 */
const IMPORTAR_XMI =
  /^(?:importa(?:lo|la|me)?|importar|imposta(?:lo|la|me)?|carga(?:lo|la|me)?|cargar|abre|abrir)\b[\s\S]*\bxmi\b/;

/**
 * «Importa una foto», «modela desde una imagen», «lee esta captura»,
 * «impórtame desde una foto» —el «me» es el mismo pronombre de «impórtame»,
 * no un verbo distinto, y sin él la frase no anclaba a ningún verbo de la
 * lista— e «impóstame», la misma orden con la «r» oída como «s» al dictado.
 */
const IMPORTAR_IMAGEN =
  /^(?:importa(?:lo|la|me)?|importar|imposta(?:lo|la|me)?|carga(?:lo|la|me)?|cargar|modela(?:me)?|modelar|lee(?:lo|la|me)?|leer|analiza(?:lo|la|me)?|analizar)\b[\s\S]*\b(?:imagen|foto|fotografia|captura|pizarra)\b/;

/**
 * Reconoce una orden de fichero en texto ya tecleado o dictado.
 *
 * Devuelve `null` en cuanto no hay anclaje claro al verbo inicial: ante la
 * duda, la frase sigue su camino normal hacia la IA del servidor en vez de
 * disparar una acción que nadie pidió.
 */
export function reconocerAccionDeArchivo(texto: string): AccionArchivo | null {
  const plegado = quitarRelleno(plegar(texto));
  if (EXPORTAR_XMI.test(plegado)) return 'exportar-xmi';
  if (IMPORTAR_XMI.test(plegado)) return 'importar-xmi';
  if (IMPORTAR_IMAGEN.test(plegado)) return 'importar-imagen';
  return null;
}

/** Lo que el Modo IA contesta al reconocer la orden, antes de ejecutarla. */
export const MENSAJE_DE_ACCION_ARCHIVO: Record<AccionArchivo, string> = {
  'exportar-xmi': 'Exportando el diagrama a XMI.',
  'importar-xmi': 'Abro el importador de XMI.',
  'importar-imagen': 'Abro el importador desde una imagen.',
};

/** Lo que contesta si la orden es de importar pero el proyecto es de solo lectura. */
export const MENSAJE_ARCHIVO_SOLO_LECTURA =
  'No puedo hacer eso: el proyecto está en modo de solo lectura.';
