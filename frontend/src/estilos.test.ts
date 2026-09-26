import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LADO_TACTIL } from './components/barra-pulgar';

/**
 * Los criterios de aspecto, comprobados en vez de prometidos.
 *
 * Un rediseño se deshace solo. No de golpe: se deshace en el parche de dentro de
 * tres semanas que añade un `border-radius: 8px` porque el elemento nuevo «queda
 * mejor así», y en el de dentro de dos meses que mete un emoji en un botón
 * porque era más rápido que dibujar el icono. Nadie lo nota hasta que la
 * interfaz vuelve a tener el aspecto de la que se quiso cambiar.
 *
 * Aquí están escritas las reglas que definen el aspecto —radio, sombras, color
 * del acento, contraste, ausencia de pictogramas— como aserciones sobre los
 * ficheros. No sustituyen a mirar la pantalla; impiden que lo que se mira hoy se
 * pierda sin que nadie se entere.
 *
 * El contraste se calcula, no se estima. La fórmula es la de WCAG 2.1: se
 * linealiza cada canal y se pesan según la sensibilidad del ojo. Escribir «este
 * gris parece suficiente» es exactamente como se acabó con un `--texto-2` de
 * 2.6:1 en el tema claro, que era ilegible y llevaba semanas ahí.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(AQUI, 'estilos.css'), 'utf8');

/**
 * La hoja sin sus comentarios.
 *
 * Mismo motivo que en los `.tsx`: la única forma de explicar por qué `#2a1620`
 * no vale es escribirlo, y una prueba que castiga la explicación empuja a
 * borrar el porqué y dejar solo el qué. Aquí es más necesario todavía, porque
 * media hoja son comentarios que citan los colores que se retiraron.
 */
function sinComentariosCss(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* --------------------------------------------------------------------------
   Contraste
   -------------------------------------------------------------------------- */

function canal(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminancia(hex: string): number {
  const n = hex.replace('#', '');
  const largo = n.length === 3 ? n.split('').map((c) => c + c) : [n.slice(0, 2), n.slice(2, 4), n.slice(4, 6)];
  const [r, g, b] = largo.map((par) => canal(Number.parseInt(par, 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contraste(a: string, b: string): number {
  const la = luminancia(a);
  const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function canales(hex: string): [number, number, number] {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * Cuánto se aleja un color del gris: el canal más alto menos el más bajo.
 *
 * Es una medida burda —no es croma de verdad— y se usa a propósito, porque lo
 * que hay que impedir es burdo: que vuelva un amarillo de rotulador o que los
 * grises se tiñan otra vez. Una métrica perceptual exacta aquí solo añadiría
 * discusión sobre el umbral.
 */
function saturacion(hex: string): number {
  const c = canales(hex);
  return Math.max(...c) - Math.min(...c);
}

const NEUTROS = [
  '--fondo',
  '--fondo-2',
  '--fondo-3',
  '--borde',
  '--realce',
  '--borde-fuerte',
  '--texto',
  '--texto-2',
];

/**
 * Lee las variables de un bloque `:root`.
 *
 * Se leen del fichero en lugar de copiarlas aquí a propósito: una prueba que
 * afirma cosas sobre una copia de los colores deja de decir nada en cuanto
 * alguien cambia el original, y encima sigue pasando, que es peor.
 */
function tokens(selector: string): Record<string, string> {
  const inicio = CSS.indexOf(selector);
  expect(inicio, `no se encontró el bloque ${selector}`).toBeGreaterThanOrEqual(0);
  const abre = CSS.indexOf('{', inicio);
  const cierra = CSS.indexOf('}', abre);
  const cuerpo = CSS.slice(abre + 1, cierra);
  const tabla: Record<string, string> = {};
  for (const linea of cuerpo.split('\n')) {
    const m = /^\s*(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/.exec(linea);
    if (m?.[1] !== undefined && m[2] !== undefined) tabla[m[1]] = m[2];
  }
  return tabla;
}

const OSCURO = tokens(':root {');
const CLARO = tokens(":root[data-tema='claro']");

/*
  Los pares que de verdad se dan en pantalla. No se comprueba «todo contra
  todo»: eso produce fallos en combinaciones que ningún componente pinta, y las
  pruebas que fallan por casos imposibles se acaban desactivando enteras.

  4.5 es el umbral AA para texto normal. Los rótulos de esta interfaz son de
  11 y 12 px, así que ninguno se acoge al 3:1 de «texto grande».
*/
const PARES: [string, string, string][] = [
  ['--texto', '--fondo', 'texto principal sobre el lienzo'],
  ['--texto', '--fondo-2', 'texto principal sobre barra y paneles'],
  ['--texto', '--fondo-3', 'texto principal sobre un control'],
  ['--texto-2', '--fondo', 'texto secundario sobre el lienzo'],
  ['--texto-2', '--fondo-2', 'texto secundario sobre barra y paneles'],
  ['--texto-2', '--fondo-3', 'texto secundario sobre un control'],
  ['--acento', '--fondo', 'acento como texto sobre el lienzo'],
  ['--acento', '--fondo-2', 'acento como texto sobre barra y paneles'],
  ['--acento', '--fondo-3', 'acento como texto sobre un control'],
  ['--sobre-acento', '--acento', 'texto de un botón primario'],
  ['--sobre-acento', '--acento-2', 'texto de un botón primario señalado'],
  ['--error', '--fondo-2', 'un error en un formulario'],
  ['--exito', '--fondo-2', 'la conexión establecida en la barra de estado'],
  ['--aviso', '--fondo-2', 'un aviso de la revisión'],
];

describe('contraste AA en los dos temas', () => {
  for (const [tema, tabla] of [
    ['oscuro', OSCURO],
    ['claro', CLARO],
  ] as const) {
    describe(`tema ${tema}`, () => {
      for (const [frente, fondo, donde] of PARES) {
        it(`${donde}: ${frente} sobre ${fondo}`, () => {
          /*
            El tema claro solo redefine parte de las variables; las que no
            redefine las hereda del `:root` oscuro. Buscarlas en cascada es lo
            que hace la prueba fiel a lo que pinta el navegador.
          */
          const a = tabla[frente] ?? OSCURO[frente];
          const b = tabla[fondo] ?? OSCURO[fondo];
          expect(a, `${frente} no está definida`).toBeDefined();
          expect(b, `${fondo} no está definida`).toBeDefined();
          const ratio = contraste(a as string, b as string);
          expect(
            ratio,
            `${frente} (${a as string}) sobre ${fondo} (${b as string}) da ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }

  /*
    El acento tiene un techo además de un suelo, y el techo se subió a mano.

    Estuvo en 120 mientras el acento fue un azul acero, con este argumento: lo
    que se persigue no es que se lea, es que no compita con el diagrama. Al
    adoptar el aspecto de la maqueta se pasó a un cian de rango 204, sabiendo lo
    que se perdía, y el techo se movió a 210 en esa misma decisión.

    Que quede en 210 y no en 255 es lo que hace que esto siga siendo una prueba:
    deja pasar el color elegido y sigue cerrando el paso a un fucsia puro. Un
    techo que no rechaza nada no es un techo.
  */
  it('el acento no se sale de lo que se decidió', () => {
    for (const [tema, tabla] of [
      ['oscuro', OSCURO],
      ['claro', CLARO],
    ] as const) {
      const hex = (tabla['--acento'] as string).replace('#', '');
      const canales = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      const rango = Math.max(...canales) - Math.min(...canales);
      expect(rango, `el acento del tema ${tema} (#${hex}) tiene un rango de ${String(rango)}`).toBeLessThanOrEqual(210);
    }
  });

  /*
    El techo va también para los tres semánticos. Una regla que se aplica a un
    solo color no es una regla, es una excepción.

    Subió de 110 a 220 con el mismo cambio de aspecto que el acento. Lo que
    seguía siendo cierto cuando eran apagados y lo sigue siendo ahora es que el
    peligro real no es que un color grite: es que dos se confundan. De eso se
    encarga la prueba de las vías de entrada, que mide la distancia entre ellos
    y no su intensidad, y es la que de verdad protege que un aviso no se lea
    como un error.
  */
  it('los semánticos no se salen de lo que se decidió', () => {
    for (const [tema, tabla] of [
      ['oscuro', OSCURO],
      ['claro', CLARO],
    ] as const) {
      for (const nombre of ['--exito', '--aviso', '--error']) {
        const rango = saturacion((tabla[nombre] ?? OSCURO[nombre]) as string);
        expect(
          rango,
          `${nombre} del tema ${tema} (${(tabla[nombre] ?? OSCURO[nombre]) as string}) tiene un rango de ${String(rango)}`,
        ).toBeLessThanOrEqual(220);
      }
    }
  });

  /*
    La rampa es fría, pero con un límite.

    Este techo estuvo en 6 —grises estrictos— con este argumento: un acento solo
    destaca si el entorno es neutro, porque sobre un cromo que ya es azul un
    acento azul se lee como una pieza más del fondo.

    Al cambiar el acento a cian, ese argumento dejó de aplicar: un cian saturado
    se separa por croma de una rampa azul aunque compartan familia. El techo
    subió a 40, que es lo que necesita la rampa *slate* elegida —su peor caso es
    `--texto-2` con 36—.

    Cuarenta sigue siendo un techo y no una puerta abierta: deja pasar un gris
    frío y sigue rechazando que alguien pinte el fondo de azul de verdad.
  */
  it('la rampa es fría, no de colores', () => {
    for (const [tema, tabla] of [
      ['oscuro', OSCURO],
      ['claro', CLARO],
    ] as const) {
      for (const nombre of NEUTROS) {
        const valor = (tabla[nombre] ?? OSCURO[nombre]) as string;
        expect(valor, `${nombre} no está definida`).toBeDefined();
        const desviacion = saturacion(valor);
        expect(
          desviacion,
          `${nombre} del tema ${tema} (${valor}) se desvía ${String(desviacion)} puntos del gris`,
        ).toBeLessThanOrEqual(40);
      }
    }
  });
});

/* --------------------------------------------------------------------------
   Geometría: esquinas y sombras
   -------------------------------------------------------------------------- */

describe('el redondeo sale de los tokens, no de números sueltos', () => {
  /*
    Esta prueba cambió de intención, no de existencia.

    Antes prohibía el redondeo: techo de 3 px, porque una rejilla de paneles
    acoplados con esquinas redondeadas deja un triángulo de fondo entre dos
    elementos que deberían leerse como contiguos. Al adoptar el aspecto de la
    maqueta el radio pasó a 12 px y ese argumento habría dejado la prueba
    inservible.

    Lo que se conserva es lo que seguía teniendo valor: que el redondeo salga de
    un token y no de un número escrito a mano. Con tres valores —`--radio` para
    lo que flota, `--radio-ajustado` para lo que forma retícula y
    `--radio-amplio` para la superficie donde la guía contesta— la decisión de
    cuál toca se sigue tomando una vez y en un sitio. Un `border-radius: 9px`
    suelto en una regla es justo lo que empieza a deshacer un sistema.

    El tercero se añadió con la lectura automática de la guía, y es el caso que
    conviene vigilar: un token nuevo por cada pantalla que quiere verse distinta
    es la misma enfermedad que los números sueltos, solo que con nombre. Vale
    porque su uso está acotado a una superficie y porque el porqué de su forma
    está escrito en la hoja, no porque «quedaba mejor».
  */
  it('ningún radio suelto: todos salen de un token o son círculos', () => {
    const culpables: string[] = [];
    for (const [, valor] of CSS.matchAll(/border-radius:\s*([^;]+);/g)) {
      const v = (valor ?? '').trim();
      // `50%` es un círculo de verdad: el punto de presencia de cada
      // participante, el avatar y el disco de la guía. No es una esquina
      // redondeada.
      if (v === '50%' || v === '0') continue;
      if (/var\(--radio(-ajustado|-amplio)?\)/.test(v)) continue;
      // Se siguen tolerando los radios de 1 y 2 px: son el matado de un pixel
      // en un borde, no una esquina de tarjeta, y no merecen un token.
      const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
      if (px?.[1] !== undefined && Number.parseFloat(px[1]) <= 3) continue;
      culpables.push(v);
    }
    expect(culpables, `radios sueltos: ${culpables.join(', ')}`).toEqual([]);
  });

  /*
    Los tres tokens también tienen techo. Doce es el redondeo de una tarjeta;
    veinticuatro es el de una pastilla, y a partir de ahí los diálogos empiezan a
    parecer notificaciones de móvil.
  */
  it('los tokens de radio se quedan donde se decidió', () => {
    const radio = /--radio:\s*(\d+)px/.exec(CSS);
    expect(radio?.[1], 'no se encontró --radio').toBeDefined();
    expect(Number.parseInt(radio?.[1] ?? '99', 10)).toBeLessThanOrEqual(12);

    const ajustado = /--radio-ajustado:\s*(\d+)px/.exec(CSS);
    expect(ajustado?.[1], 'no se encontró --radio-ajustado').toBeDefined();
    expect(Number.parseInt(ajustado?.[1] ?? '99', 10)).toBeLessThanOrEqual(8);

    const amplio = /--radio-amplio:\s*(\d+)px/.exec(CSS);
    expect(amplio?.[1], 'no se encontró --radio-amplio').toBeDefined();
    expect(Number.parseInt(amplio?.[1] ?? '99', 10)).toBeLessThanOrEqual(24);
    // Y por abajo: si alguien lo iguala a `--radio` deja de ser una decisión y
    // pasa a ser un alias que nadie se atreve a borrar.
    expect(Number.parseInt(amplio?.[1] ?? '0', 10)).toBeGreaterThan(
      Number.parseInt(radio?.[1] ?? '99', 10),
    );
  });
});

/* --------------------------------------------------------------------------
   Sombras
   -------------------------------------------------------------------------- */

describe('la sombra dice qué capa recibe el clic, no adorna', () => {
  /*
    La sombra: permitida donde hay capas, prohibida donde hay retícula.

    Esta regla antes prohibía el desenfoque en toda la hoja, con un techo de
    4 px. El motivo era bueno —una sombra difusa dice «esto levita», que es el
    idioma de la interfaz de tarjetas, y aquí hay paneles acoplados que
    comparten canaleta y no levitan— pero estaba mal dirigida: castigaba la
    propiedad en vez del sitio. Un diálogo sobre el velo sí está en otra capa, y
    ahí la sombra no decora, informa: dice cuál de las dos superficies recibe el
    clic.

    Así que el techo se sustituye por una lista. Cinco selectores, los que de
    verdad se dibujan encima de otra cosa. Los veintiséis restantes —paneles,
    filas de árbol, campos, tarjetas del tablero— siguen sin poder llevarla, que
    es donde estaba el peligro: `.tarjeta` y `.tablero` quedan fuera a propósito,
    porque son exactamente los dos que tientan a convertir esto en un tablero de
    tarjetas flotantes.
  */
  const FLOTAN = [
    '.menu__desplegable',
    '.modal__caja',
    '.guia__caja',
    '.boton-ayuda',
    '.acceso__tarjeta',
    // La sexta es el recorrido de primer acceso, y entra por el mismo motivo
    // que `.guia__caja`: está sobre el velo, en otra capa, y la sombra dice
    // cuál de las dos superficies recibe el clic. Que la lista crezca de una en
    // una y con el porqué escrito es lo que la mantiene siendo una lista y no
    // un permiso general.
    '.recorrido__caja',
    // La burbuja y el panel del asistente flotante (Asistente.tsx,
    // modo="flotante"): la burbuja flota sobre el lienzo igual que
    // `.boton-ayuda`, y el panel que despliega flota sobre la burbuja misma.
    '.asistente-flotante__burbuja',
    '.asistente-flotante__panel',
  ];

  it('solo llevan sombra las superficies que están en otra capa', () => {
    const intrusos: string[] = [];
    for (const [, selector, cuerpo] of sinComentariosCss(CSS).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      /*
        El valor se extrae y se compara; no se descarta con `\s*(?!none)`.
        Aquello parecía decir «una sombra que no sea `none`» y en realidad no
        decía nada: `\s*` puede casar la cadena vacía, y entonces la mirada
        adelante se hace delante del espacio en vez de delante de `none` y pasa
        siempre. La primera regla `box-shadow: none` que se escribió en la hoja
        —la del `@media print` del informe— salió señalada como intrusa.
      */
      const conSombra = [...(cuerpo ?? '').matchAll(/box-shadow:\s*([^;]+)/g)].some(
        (d) => (d[1] ?? '').trim() !== 'none',
      );
      if (!conSombra) continue;
      const sel = (selector ?? '').trim();
      if (!FLOTAN.some((f) => sel.includes(f))) intrusos.push(sel);
    }
    expect(intrusos, `llevan sombra sin estar en otra capa: ${intrusos.join(' | ')}`).toEqual([]);
  });

  /*
    Y la sombra sale del token, como el color. Escribir un `rgba()` suelto aquí
    reabre justo el agujero que cerró la prueba de los colores literales: el
    tema claro solo redefine variables, así que una sombra escrita a mano se
    queda negra sobre blanco.
  */
  it('la sombra se pone con el token, no a mano', () => {
    const sueltas: string[] = [];
    for (const [, valor] of sinComentariosCss(CSS).matchAll(/box-shadow:\s*([^;]+);/g)) {
      const v = (valor ?? '').trim();
      if (v !== 'none' && v !== 'var(--sombra)') sueltas.push(v);
    }
    expect(sueltas, `sombras escritas a mano: ${sueltas.join(' | ')}`).toEqual([]);
  });

  /*
    El token también tiene techo. Veintiocho es una elevación; a partir de
    cuarenta vuelve a ser el halo de 60 px que se retiró, y la lista de arriba
    no serviría de nada si el valor permitido fuera cualquiera.
  */
  it('el desenfoque de la sombra se queda donde se decidió', () => {
    const sombra = /--sombra:\s*([^;]+);/.exec(CSS)?.[1] ?? '';
    expect(sombra, 'no se encontró --sombra').not.toBe('');
    /*
      Las medidas se sacan por posición, no buscando «px»: el desplazamiento
      horizontal se escribe `0`, sin unidad, y buscar `px` se lo salta y hace
      que el tercer valor encontrado sea la extensión en vez del desenfoque.
      Con ese fallo la prueba daba por bueno un desenfoque de 60 px, que es
      exactamente lo que existe para rechazar.
    */
    const medidas = sombra
      .replace(/[a-z-]+\([^)]*\)/g, '')
      .trim()
      .split(/\s+/)
      .filter((t) => /^-?[\d.]+/.test(t))
      .map((t) => Number.parseFloat(t));
    // Desplazamiento en x, desplazamiento en y, desenfoque, extensión.
    expect(medidas.length, `no se leyeron las medidas de --sombra: ${sombra}`).toBeGreaterThanOrEqual(3);
    expect(medidas[2] ?? 0, `desenfoque de --sombra: ${sombra}`).toBeLessThanOrEqual(40);
  });
});

/* --------------------------------------------------------------------------
   Un solo sitio donde se declara un color
   -------------------------------------------------------------------------- */

describe('los colores viven en los tokens, no sueltos por la hoja', () => {
  /*
    Esta es la prueba que habría evitado el tema claro roto.

    Había 29 colores escritos a mano por debajo de los bloques `:root`
    —`#2a1620` de fondo para un error, `#4a2530` para su borde, `#2a2410` para
    un aviso—, y `[data-tema='claro']` solo redefine variables. Resultado: al
    conmutar a claro, los diálogos de error y los avisos se quedaban en granate
    y marrón oscuro sobre blanco. Llevaba ahí desde que existe el tema claro y
    no lo había visto nadie, porque el tema claro se usa para proyectar y lo que
    se proyecta es el lienzo, no los cuadros de error.

    No basta con arreglarlos: cada literal nuevo reabre el agujero, y se cuela
    con toda naturalidad, porque escribir `#2a1620` es más rápido que pensar de
    qué token se deriva. La lista blanca está vacía y debe seguirlo.
  */
  it('ningún color literal fuera de los bloques :root', () => {
    const cuerpo = CSS.slice(CSS.indexOf('}', CSS.indexOf(":root[data-tema='claro']")) + 1);
    const sueltos = [...sinComentariosCss(cuerpo).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(sueltos, `colores sueltos: ${sueltos.join(', ')}`).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   Las vías de entrada del tablero
   -------------------------------------------------------------------------- */

/*
  Cuatro categorías pintadas de cuatro colores es exactamente el sitio por donde
  entra una paleta nueva. La tentación es escribir cuatro hexes bonitos y seguir:
  el `#4ecb8f` menta y el `#ffd24a` de rotulador que se retiraron de los
  semánticos llegaron así, un color a la vez y cada uno con su motivo.

  Se comprueban las dos propiedades que importan, no los valores: que salgan de
  tokens que ya existen —y que por tanto ya se recalculan en el tema claro y ya
  pasan por la tabla de contrastes de arriba— y que cada tramo se distinga del
  carril sobre el que se dibuja en los dos temas. Con menos de 3:1 la barra se
  convierte en un rectángulo gris.
*/
describe('la barra de vías de entrada no estrena colores', () => {
  const VIAS = ['manual', 'asistente', 'foto', 'xmi'];

  /** El token que usa de fondo `.tablero__via--<origen>`. */
  function tokenDeVia(origen: string): string | null {
    const regla = new RegExp(`\\.tablero__via--${origen}\\s*\\{([^}]*)\\}`).exec(
      sinComentariosCss(CSS),
    );
    return /background:\s*var\((--[\w-]+)\)/.exec(regla?.[1] ?? '')?.[1] ?? null;
  }

  it('las cuatro vías tienen color', () => {
    for (const via of VIAS) {
      expect(tokenDeVia(via), `.tablero__via--${via} no define un fondo con var()`).not.toBeNull();
    }
  });

  it('ninguna estrena un color: todas salen de tokens ya declarados', () => {
    for (const via of VIAS) {
      const token = tokenDeVia(via) as string;
      expect(OSCURO[token], `${token} no está en :root`).toBeDefined();
    }
  });

  /*
    `--error` queda fuera por significado, no por contraste. En esta hoja el rojo
    quiere decir «algo va mal», y que un modelo llegara por fotografía no es un
    fallo; reutilizarlo aquí enseñaría a no creerse el rojo del resto de la
    interfaz, que es donde sí hace falta.
  */
  it('ninguna vía se pinta con el color de error', () => {
    for (const via of VIAS) {
      expect(tokenDeVia(via), `la vía ${via} usa el rojo de error`).not.toBe('--error');
    }
  });

  it('cada vía se distingue del carril en los dos temas', () => {
    for (const [tema, tabla] of [
      ['oscuro', OSCURO],
      ['claro', CLARO],
    ] as const) {
      const carril = (tabla['--fondo-3'] ?? OSCURO['--fondo-3']) as string;
      for (const via of VIAS) {
        const token = tokenDeVia(via) as string;
        const color = (tabla[token] ?? OSCURO[token]) as string;
        const ratio = contraste(color, carril);
        expect(
          ratio,
          `la vía ${via} (${token}, ${color}) da ${ratio.toFixed(2)}:1 sobre el carril del tema ${tema}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  /*
    Y no vale que dos vías contiguas parezcan la misma. La barra las pone pegadas
    sin separador, así que dos colores cercanos se leen como un solo tramo y el
    reparto que se está enseñando deja de verse.
  */
  it('no hay dos vías que se confundan entre sí', () => {
    for (const [tema, tabla] of [
      ['oscuro', OSCURO],
      ['claro', CLARO],
    ] as const) {
      for (let i = 0; i < VIAS.length; i++) {
        for (let j = i + 1; j < VIAS.length; j++) {
          const de = (via: string): string => {
            const token = tokenDeVia(via) as string;
            return (tabla[token] ?? OSCURO[token]) as string;
          };
          const [a, b] = [canales(de(VIAS[i] as string)), canales(de(VIAS[j] as string))];
          const distancia = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          expect(
            distancia,
            `${VIAS[i] as string} y ${VIAS[j] as string} distan ${distancia.toFixed(0)} en el tema ${tema}`,
          ).toBeGreaterThanOrEqual(40);
        }
      }
    }
  });
});

/* --------------------------------------------------------------------------
   Colores de participante
   -------------------------------------------------------------------------- */

/*
  Viven en `usePresencia.ts`, y esa es justo la razón por la que sobrevivieron
  intactos a dos rediseños: ningún barrido del CSS los mira. Son, además, los
  colores más saturados que llega a pintar la aplicación —ficha de presencia y
  contorno de selección sobre el diagrama—, así que son los que más delatan.

  Se comprueban las tres propiedades que de verdad importan, no los hexes
  concretos: que no griten, que se pueda leer texto encima y que dos
  participantes no se confundan entre sí.
*/
describe('los colores de participante son un sistema, no ocho rotuladores', () => {
  const FUENTE = readFileSync(join(AQUI, 'hooks', 'usePresencia.ts'), 'utf8');
  const COLORES = [...FUENTE.slice(FUENTE.indexOf('const COLORES')).matchAll(/'(#[0-9a-fA-F]{6})'/g)].map(
    (m) => m[1] as string,
  );

  it('se encontraron los ocho', () => {
    expect(COLORES).toHaveLength(8);
  });

  it('ninguno está saturado por encima del techo de los semánticos', () => {
    for (const c of COLORES) {
      expect(saturacion(c), `${c} tiene un rango de ${String(saturacion(c))}`).toBeLessThanOrEqual(110);
    }
  });

  it('todos admiten la inicial en oscuro encima', () => {
    // La ficha de presencia pinta la inicial con `--sobre-acento` sobre el
    // color del participante; si el color es oscuro, la inicial desaparece.
    for (const c of COLORES) {
      const ratio = contraste(c, OSCURO['--sobre-acento'] as string);
      expect(ratio, `${c} da ${ratio.toFixed(2)}:1 con la inicial`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('se distinguen del lienzo, que es donde marcan la selección', () => {
    for (const c of COLORES) {
      const ratio = contraste(c, OSCURO['--fondo'] as string);
      expect(ratio, `${c} da ${ratio.toFixed(2)}:1 sobre el lienzo`).toBeGreaterThanOrEqual(3);
    }
  });

  it('no hay dos que se confundan entre sí', () => {
    for (let i = 0; i < COLORES.length; i++) {
      for (let j = i + 1; j < COLORES.length; j++) {
        const [a, b] = [canales(COLORES[i] as string), canales(COLORES[j] as string)];
        const distancia = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        expect(
          distancia,
          `${COLORES[i] as string} y ${COLORES[j] as string} distan ${distancia.toFixed(0)}`,
        ).toBeGreaterThanOrEqual(40);
      }
    }
  });
});

/* --------------------------------------------------------------------------
   Pictogramas
   -------------------------------------------------------------------------- */

/*
  Los glifos que se sustituyeron por iconos dibujados, uno por uno.

  Se listan en vez de comprobar rangos Unicode enteros porque un rango entero
  produce falsos positivos en los comentarios en castellano y en los ejemplos de
  cardinalidad (`1 → *`), y una prueba que grita por casos legítimos se acaba
  borrando. Esta lista es la deuda concreta que se saldó; si alguno vuelve, es
  que alguien copió un botón viejo.
*/
const PICTOGRAMAS = [
  '🕘', '◧', '◨', '▭', '◻', '▱', '≡', '✕', '⚠', '✓', '✔',
  '🎤', '🔊', '🔇', '🔑', '🖼', '⤒', '▸', '▾', '⋯', '⏱', '📋', '📁', '🗑',
];

/**
 * Los ficheros de `components/` que pueden llevar texto o glifos a la pantalla.
 *
 * Miraba solo los `.tsx`, y eso dejaba fuera justo la mitad donde vive la
 * microcopia de esta base de código. La convención de aquí es que cada pantalla
 * son dos ficheros: un `.ts` sin DOM con las decisiones y sus textos, y un
 * `.tsx` que solo dibuja. Un barrido que solo lee el que dibuja está mirando el
 * fichero que *no* contiene las cadenas.
 *
 * Se comprobó al revisar el permiso de lector de la interfaz táctil:
 * `movil-acciones.ts` llevaba «Tienes permiso de solo lectura…» y «Lo que
 * dibujes ahora se guarda…» —una de ellas, «tienes permiso», está literalmente
 * en la lista de abajo— y las dos pruebas pasaban en verde desde el día que se
 * escribieron. Ese texto se lee en un botón apagado del cajón, que es donde más
 * importa el tono, porque es el momento en que la aplicación dice que no.
 *
 * Los `.test.ts` se quedan fuera a propósito: citan las cadenas que vigilan, y
 * una prueba que castiga a otra prueba por nombrar lo que comprueba solo enseña
 * a comprobar menos.
 */
function fuentesDeComponentes(): string[] {
  const dir = join(AQUI, 'components');
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(dir, f));
}

/**
 * El fichero sin sus comentarios.
 *
 * Estas dos listas hablan de lo que sale por pantalla, y un comentario no sale
 * por pantalla. La distinción no es un tecnicismo: la única forma de explicar
 * por qué un glifo o un eslogan no valen es nombrarlos, y una prueba que
 * castiga esa explicación empuja a borrar el porqué y dejar solo el qué. Se
 * quitan los bloques `/* … *\/` y las líneas que empiezan por `//`; no se tocan
 * las `//` a media línea, porque ahí suele haber una URL dentro de una cadena y
 * cortarla escondería texto de verdad.
 */
function sinComentarios(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trimStart().startsWith('//'))
    .join('\n');
}

describe('ningún pictograma de fuente hace de control', () => {
  for (const ruta of fuentesDeComponentes()) {
    const nombre = ruta.split(/[\\/]/).pop() ?? ruta;
    it(nombre, () => {
      const texto = sinComentarios(readFileSync(ruta, 'utf8'));
      const encontrados = PICTOGRAMAS.filter((g) => texto.includes(g));
      expect(encontrados, `${nombre} todavía usa ${encontrados.join(' ')}`).toEqual([]);
    });
  }
});

/* --------------------------------------------------------------------------
   Microcopia
   -------------------------------------------------------------------------- */

/*
  El tuteo imperativo es lo que delata un texto escrito de corrido: «Arrastra»,
  «Guarda esto», «Acércate». Una herramienta se dirige a quien la usa en
  impersonal o en usted, y sobre todo no le dice lo que podría hacer a
  continuación.

  Se buscan formas concretas y no una regla gramatical: detectar el imperativo
  de segunda persona en castellano con una expresión regular es imposible sin
  falsos positivos —«importa» es a la vez verbo y sustantivo—, y aquí interesa
  más que no vuelvan las que ya se corrigieron que atrapar todas las posibles.
*/
const TUTEOS = [
  'Arrastra ', 'Guarda ', 'Acércate', 'Anótalo', 'guárdalo', 'tu gestor',
  'si olvidas', 'lo hiciste', 'tienes el fichero', 'usa «',
  // Segunda tanda: las que salieron de leer `document.body.innerText` en el
  // navegador en vez de rastrear el código. La pantalla de acceso no estaba en
  // ningún barrido estático porque su texto no contenía ninguna de las de
  // arriba, y era justo la primera pantalla que ve el tribunal.
  'Diseña ', 'No tienes cuenta', 'He olvidado', 'Puedes seguir', 'Tus cambios',
  'no tienes permiso', 'Tus proyectos', 'no tienes ningún', 'Tu código',
  'puedes invitar', 'tienes permiso', 'en tu máquina', 'Prueba con ',
  'Abre un ', 'por ti', 'confirmes',
];

describe('la microcopia no tutea', () => {
  for (const ruta of fuentesDeComponentes()) {
    const nombre = ruta.split(/[\\/]/).pop() ?? ruta;
    it(nombre, () => {
      const texto = sinComentarios(readFileSync(ruta, 'utf8'));
      const encontrados = TUTEOS.filter((t) => texto.includes(t));
      expect(encontrados, `${nombre} tutea: ${encontrados.join(' | ')}`).toEqual([]);
    });
  }
});

/* --------------------------------------------------------------------------
   Las fuentes, y que sigan estando sin conexión
   -------------------------------------------------------------------------- */

/**
 * Plus Jakarta Sans y Fira Code son las de la maqueta, y llegaban en ella por un
 * `<link>` a Google. Aquí están dentro del repositorio, y esa decisión tiene una
 * forma concreta de romperse que ninguna otra prueba vería: alguien añade un
 * peso o una familia, escribe el `@font-face`, y **no toca `sw.js`**. Con red
 * todo se ve bien. Sin red la fuente no está en la caché, el navegador no da
 * error —cae a `system-ui` en silencio— y la interfaz se ve distinta el día de
 * la defensa, que es justo el día en que se presume de que funciona sin
 * internet.
 *
 * Un fallo que solo aparece sin conexión no lo encuentra nadie mirando la
 * pantalla, así que se comprueba aquí.
 */
const SW = readFileSync(join(AQUI, '..', 'public', 'sw.js'), 'utf8');
const HTML = readFileSync(join(AQUI, '..', 'index.html'), 'utf8');

function fuentesReferenciadas(): string[] {
  return [...sinComentariosCss(CSS).matchAll(/url\('(\/fuentes\/[^']+)'\)/g)].map((m) => m[1]!);
}

describe('las fuentes se sirven desde el propio repositorio', () => {
  it('la hoja referencia alguna, y todas son rutas locales', () => {
    const rutas = fuentesReferenciadas();
    expect(rutas.length).toBeGreaterThan(0);
    expect(new Set(rutas).size).toBe(4);
  });

  it.each(fuentesReferenciadas())('«%s» existe en disco y es un WOFF2 de verdad', (ruta) => {
    const fichero = join(AQUI, '..', 'public', ruta.replace(/^\//, ''));
    const bytes = readFileSync(fichero);
    // La firma, no solo la extensión: un `.woff2` que en realidad es el HTML de
    // una página de error de la descarga pesa poco y pasaría desapercibido.
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
  });

  it.each(fuentesReferenciadas())('«%s» está en el precache del service worker', (ruta) => {
    expect(
      SW.includes(`'${ruta}'`),
      `${ruta} no aparece en ESENCIALES de sw.js: sin conexión no estará`,
    ).toBe(true);
  });

  it('no se pide ninguna fuente por red', () => {
    for (const fuente of [sinComentariosCss(CSS), HTML]) {
      expect(fuente).not.toContain('fonts.googleapis.com');
      expect(fuente).not.toContain('fonts.gstatic.com');
    }
  });

  it('las dos familias de la maqueta encabezan sus pilas', () => {
    const css = sinComentariosCss(CSS);
    expect(css).toMatch(/font: 13px\/1\.45 'Plus Jakarta Sans',/);
    expect(css).toMatch(/--mono: 'Fira Code',/);
    // Con respaldo detrás: si el `.woff2` no llegara, hay con qué pintar.
    expect(css).toMatch(/'Plus Jakarta Sans', system-ui/);
  });
});

/* --------------------------------------------------------------------------
   Las clases que el lienzo pide y la hoja tiene que dar
   -------------------------------------------------------------------------- */

/*
  Esta prueba existe por un fallo que estuvo a punto de irse tal cual.

  Al reescribir el lienzo sobre React Flow, el componente quedó pidiendo cinco
  clases —`lienzo--flow`, `lienzo__marcadores`, `lienzo__cursor`,
  `caja__conector`, `caja__ajeno`— que no existían en la hoja. Nada se quejó: el
  `tsc` pasó limpio, las 1068 pruebas pasaron y `vite build` construyó sin una
  advertencia, porque un `className` es una cadena y a nadie le consta que
  signifique algo.

  Lo que se habría visto en pantalla es peor que un error: React Flow mide su
  contenedor para saber dónde poner las cosas, y sin la altura de
  `.lienzo--flow` ese contenedor mide cero. El diagrama no sale, y lo que se
  investiga es por qué falla React Flow en vez de por qué falta una regla.

  Se comprueba la dirección que importa —que lo que se pide exista— y no la
  contraria: una regla en la hoja sin usuario en el `.tsx` es basura que
  conviene barrer, pero no rompe nada, y castigarla obligaría a listar aquí cada
  clase que solo se aplica desde un estado o desde otra hoja.
*/
describe('el lienzo no pide clases que la hoja no tenga', () => {
  const LIENZO = readFileSync(join(AQUI, 'components', 'LienzoFlow.tsx'), 'utf8');

  /**
   * Las clases propias que aparecen en los `className` del componente.
   *
   * Se descartan las de React Flow —`react-flow__*`— porque las define su hoja,
   * que se importa aparte y no es nuestra; y las que llevan `${`, porque son
   * plantillas y su valor no se conoce leyendo el fichero.
   */
  function clasesPedidas(): string[] {
    const literales = [...LIENZO.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map(
      (m) => m[1] ?? m[2] ?? '',
    );
    const sueltas = literales.flatMap((l) => l.split(/[\s${}?:'"]+/)).filter(Boolean);
    /*
      Se exige que el nombre lleve `__` o `--`, o que sea uno de los bloques que
      se usan a secas. No es un capricho: dentro de un
      `className={`caja${activa ? ' caja--activa' : ''}`}` el troceado también
      saca `activa`, que es una variable de JavaScript y no una clase. Sin este
      filtro la prueba señalaría cosas que no existen y acabaría borrada por
      pesada, que es como muere una prueba ruidosa.
    */
    const BLOQUES = ['caja', 'lienzo', 'relacion'];
    return [...new Set(sueltas)].filter(
      (c) =>
        /^[a-z][\w-]*$/.test(c) &&
        !c.startsWith('react-flow') &&
        (c.includes('__') || c.includes('--') || BLOQUES.includes(c)),
    );
  }

  it('todas las clases del componente están declaradas en la hoja', () => {
    /*
      El límite se escribe `(?![\w-])` y no `\b`. Para una expresión regular el
      guion cuenta como separador, así que `\.caja__miembro\b` casaría dentro de
      `.caja__miembro--metodo` y daría por declarada una clase que no lo está:
      justo el fallo que esta prueba existe para encontrar.
    */
    const huerfanas = clasesPedidas().filter((c) => !new RegExp(`\\.${c}(?![\\w-])`).test(CSS));
    expect(
      huerfanas,
      `el lienzo usa clases que no existen en estilos.css: ${huerfanas.join(', ')}`,
    ).toEqual([]);
  });

  /*
    Y la que sostiene el resto, comprobada aparte por lo que cuesta el fallo: sin
    altura, React Flow mide cero y no dibuja nada.
  */
  it('.lienzo--flow le da altura al contenedor que React Flow mide', () => {
    const regla = /\.lienzo--flow\s*\{([^}]*)\}/.exec(sinComentariosCss(CSS))?.[1] ?? '';
    expect(regla, 'no se encontró la regla .lienzo--flow').not.toBe('');
    expect(regla, '.lienzo--flow sin height: React Flow mediría cero').toMatch(/height:/);
  });
});

/* --------------------------------------------------------------------------
   Objetivos táctiles
   -------------------------------------------------------------------------- */

/**
 * El cuerpo de una regla, buscada por su selector exacto.
 *
 * El `(?![\w-])` del final es el mismo cuidado que en la prueba de las clases
 * huérfanas: sin él, `.barra-estado__boton` casaría dentro de
 * `.barra-estado__boton--ancho` y la prueba mediría una regla distinta de la
 * que cree estar mirando.
 */
function cuerpoDeRegla(fuente: string, selector: string): string {
  const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const encontrada = new RegExp(`${escapado}(?![\\w-])\\s*\\{([^}]*)\\}`).exec(fuente);
  expect(encontrada, `no se encontró la regla ${selector}`).not.toBeNull();
  return encontrada?.[1] ?? '';
}

/**
 * Una medida en píxeles de una declaración.
 *
 * Se ancla en principio de línea o en `;` a propósito: `height:` a secas
 * casaría también dentro de `min-height:`, y entonces la prueba leería un
 * número que no es el que pide.
 */
function pixeles(cuerpo: string, propiedad: string, donde: string): number {
  const m = new RegExp(`(?:^|;)\\s*${propiedad}:\\s*(-?\\d+)px`, 'm').exec(cuerpo);
  expect(m, `${donde} no fija ${propiedad} en píxeles`).not.toBeNull();
  return Number(m?.[1] ?? 0);
}

describe('nada que se toque con el dedo baja de LADO_TACTIL', () => {
  /*
    Esta es la prueba que justifica que `LADO_TACTIL` viva en TypeScript en vez
    de ser un número escrito en la hoja y otro escrito en el código. Sin ella
    son dos cifras independientes que coinciden hoy: la primera vez que alguien
    ajuste el CSS «para que quepa mejor», la constante seguirá diciendo 44 y la
    interfaz medirá 32, y las pruebas de `barra-pulgar.test.ts` seguirán en
    verde porque comprueban la constante, no la pantalla.
  */
  const LIMPIO = sinComentariosCss(CSS);

  /*
    Todo lo que sigue vive dentro de `@media (pointer: coarse)`, así que se
    busca a partir de ahí. Buscar en la hoja entera encontraría las reglas base
    —el control de React Flow mide 26 px con un ratón, y así está bien— y la
    prueba fallaría por lo que precisamente no hay que cambiar.
  */
  const GRUESO = LIMPIO.slice(LIMPIO.indexOf('@media (pointer: coarse)'));

  it('la hoja tiene un bloque de puntero grueso', () => {
    // Por ancho de pantalla no valdría: una tableta en horizontal es ancha y se
    // toca con el dedo, y una ventana estrecha en un escritorio no.
    expect(LIMPIO, 'no hay ningún @media (pointer: coarse) en la hoja').toContain(
      '@media (pointer: coarse)',
    );
  });

  it('los botones de la barra del pulgar', () => {
    const regla = cuerpoDeRegla(LIMPIO, '.barra-pulgar__boton');
    expect(pixeles(regla, 'min-height', '.barra-pulgar__boton')).toBeGreaterThanOrEqual(
      LADO_TACTIL,
    );
  });

  it('los controles de zoom de React Flow, que de fábrica vienen a 26', () => {
    const regla = cuerpoDeRegla(GRUESO, '.react-flow__controls-button');
    expect(pixeles(regla, 'width', 'los controles')).toBeGreaterThanOrEqual(LADO_TACTIL);
    expect(pixeles(regla, 'height', 'los controles')).toBeGreaterThanOrEqual(LADO_TACTIL);
  });

  it('los botones del aumento de la barra de estado, que medían 20', () => {
    const regla = cuerpoDeRegla(GRUESO, '.barra-estado__boton');
    expect(pixeles(regla, 'min-width', 'el botón de aumento')).toBeGreaterThanOrEqual(LADO_TACTIL);
    expect(pixeles(regla, 'height', 'el botón de aumento')).toBeGreaterThanOrEqual(LADO_TACTIL);
  });

  /*
    El conector no crece: crece su zona sensible, en un `::after` que lo
    desborda. Cambiar su caja lo movería de sitio, porque React Flow lo coloca
    con desplazamientos calculados sobre su tamaño.

    Se comprueba la suma y no el `inset` suelto, que es el número que de verdad
    importa: si mañana el punto pasa de 8 a 10 px, el desbordamiento puede
    bajar a 17 sin que nadie pierda nada.
  */
  it('la zona sensible del conector mientras se relaciona', () => {
    const punto = pixeles(cuerpoDeRegla(LIMPIO, '.caja__conector'), 'width', 'el conector');
    const desborde = pixeles(
      cuerpoDeRegla(GRUESO, '.lienzo--relacionando .caja__conector::after'),
      'inset',
      'el desbordamiento del conector',
    );
    expect(desborde, 'el inset tiene que ser negativo para agrandar, no para encoger').toBeLessThan(
      0,
    );
    expect(punto + 2 * Math.abs(desborde)).toBeGreaterThanOrEqual(LADO_TACTIL);
  });

  /*
    Y lo que no es un tamaño pero mata igual el objetivo: con navegación por
    gestos, la barrita de inicio del sistema se superpone al canto inferior. Una
    barra pegada abajo sin este hueco se ve entera y no responde en su tercio de
    abajo, que es justo por donde la alcanza un pulgar que sube desde el borde.
  */
  it('la barra del pulgar reserva el hueco de la barra del sistema', () => {
    const regla = cuerpoDeRegla(LIMPIO, '.barra-pulgar');
    expect(regla, '.barra-pulgar sin env(safe-area-inset-bottom)').toContain(
      'env(safe-area-inset-bottom)',
    );
  });
});
