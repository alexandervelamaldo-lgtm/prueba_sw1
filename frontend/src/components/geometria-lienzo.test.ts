import { describe, expect, it } from 'vitest';
import { UmlClassSchema, UmlRelationSchema, type UmlClass, type UmlRelation } from '@app/shared';
import {
  ANCHO_MAXIMO,
  ANCHO_MINIMO,
  ESCALA_MAXIMA,
  ESCALA_MINIMA,
  ampliar,
  anclaje,
  cajaDe,
  desviosPorPar,
  encuadrar,
  etiquetaClase,
  limitarEscala,
  medidasDe,
  puntoEnCurva,
  puntoMedioRelacion,
  recortar,
  textoAtributo,
} from './geometria-lienzo';

/**
 * Pruebas de la geometría del lienzo.
 *
 * Lo que se comprueba aquí no lo detecta el compilador y tampoco se nota
 * leyendo el código: son propiedades del dibujo. Que dos relaciones entre las
 * mismas clases no acaben una encima de otra, que una línea salga por el borde
 * de la caja y no desde su centro, que un nombre larguísimo no desborde. Todo
 * eso compilaba igual de bien cuando estaba mal.
 */

/*
  Se construyen pasando por el esquema y no a mano: así los valores por defecto
  —el tipo de clase, la posición, el tamaño— son exactamente los mismos que en la
  aplicación, y una fixture no puede quedarse desfasada del modelo sin que estas
  pruebas se enteren. El parámetro va suelto porque lo que se escribe aquí es la
  *entrada* del esquema, donde todo lo que tiene defecto es opcional.
*/
const clase = (parcial: Record<string, unknown>): UmlClass => UmlClassSchema.parse(parcial);

const relacion = (id: string, origen: string, destino: string): UmlRelation =>
  UmlRelationSchema.parse({
    id,
    kind: 'association',
    source: { classId: origen },
    target: { classId: destino },
  });

describe('medidasDe', () => {
  it('una clase de nombre corto y sin miembros ocupa el ancho mínimo', () => {
    const medida = medidasDe(clase({ id: 'c1', name: 'Pago' }));
    expect(medida.ancho).toBe(ANCHO_MINIMO);
  });

  it('la caja crece cuando un atributo no cabría en el ancho mínimo', () => {
    const corta = medidasDe(clase({ id: 'c1', name: 'Pedido' }));
    const larga = medidasDe(
      clase({
        id: 'c2',
        name: 'Pedido',
        attributes: [
          {
            id: 'a1',
            name: 'direccionDeFacturacionCompleta',
            type: { name: 'String' },
            visibility: '+',
          },
        ],
      }),
    );
    expect(larga.ancho).toBeGreaterThan(corta.ancho);
  });

  it('por larga que sea la fila, la caja no pasa del tope', () => {
    const medida = medidasDe(
      clase({
        id: 'c1',
        name: 'Pedido',
        methods: [
          {
            id: 'm1',
            name: 'recalcularTotalConDescuentosEImpuestosAplicables',
            visibility: '+',
            parameters: [
              { name: 'porcentajeDeDescuentoSobreElSubtotal', type: { name: 'Double' } },
              { name: 'tipoImpositivoDelPaisDeEntrega', type: { name: 'Double' } },
            ],
          },
        ],
      }),
    );
    expect(medida.ancho).toBe(ANCHO_MAXIMO);
  });

  it('un nombre muy largo también ensancha la caja, no solo los miembros', () => {
    const medida = medidasDe(clase({ id: 'c1', name: 'RegistroDeAuditoriaDeAccesos' }));
    expect(medida.ancho).toBeGreaterThan(ANCHO_MINIMO);
  });

  it('el alto crece una fila por cada miembro', () => {
    const uno = medidasDe(
      clase({
        id: 'c1',
        name: 'A',
        attributes: [{ id: 'a1', name: 'a', type: { name: 'String' }, visibility: '+' }],
      }),
    );
    const dos = medidasDe(
      clase({
        id: 'c2',
        name: 'A',
        attributes: [
          { id: 'a1', name: 'a', type: { name: 'String' }, visibility: '+' },
          { id: 'a2', name: 'b', type: { name: 'String' }, visibility: '+' },
        ],
      }),
    );
    expect(dos.alto).toBeGreaterThan(uno.alto);
  });
});

describe('recortar', () => {
  it('deja intacto lo que cabe', () => {
    expect(recortar('+ id: Long', ANCHO_MINIMO)).toBe('+ id: Long');
  });

  it('lo que no cabe se corta y se marca con puntos suspensivos', () => {
    const largo = '+ direccionDeFacturacionCompletaDelCliente: String';
    const recortado = recortar(largo, ANCHO_MINIMO);
    expect(recortado.endsWith('…')).toBe(true);
    expect(recortado.length).toBeLessThan(largo.length);
  });

  it('nunca devuelve la cadena vacía, por estrecha que sea la caja', () => {
    expect(recortar('nombre', 0).length).toBeGreaterThan(0);
  });
});

describe('anclaje', () => {
  const caja = clase({ id: 'c1', name: 'A', position: { x: 100, y: 100 } });
  const medida = { ancho: 200, alto: 100 };

  it('hacia la derecha, el punto sale por el borde derecho', () => {
    const punto = anclaje(caja, medida, { x: 1000, y: 150 });
    expect(punto.x).toBeCloseTo(300);
    expect(punto.y).toBeCloseTo(150);
  });

  it('hacia arriba, el punto sale por el borde superior', () => {
    const punto = anclaje(caja, medida, { x: 200, y: -500 });
    expect(punto.y).toBeCloseTo(100);
  });

  it('el punto siempre queda sobre el borde, nunca dentro de la caja', () => {
    for (const objetivo of [
      { x: 500, y: 500 },
      { x: -400, y: 130 },
      { x: 190, y: 900 },
      { x: -50, y: -80 },
    ]) {
      const punto = anclaje(caja, medida, objetivo);
      const enBordeX = Math.abs(punto.x - 100) < 1e-6 || Math.abs(punto.x - 300) < 1e-6;
      const enBordeY = Math.abs(punto.y - 100) < 1e-6 || Math.abs(punto.y - 200) < 1e-6;
      expect(enBordeX || enBordeY).toBe(true);
    }
  });

  it('si el objetivo es el propio centro devuelve el centro en vez de dividir por cero', () => {
    const punto = anclaje(caja, medida, { x: 200, y: 150 });
    expect(Number.isFinite(punto.x)).toBe(true);
    expect(Number.isFinite(punto.y)).toBe(true);
  });
});

describe('desviosPorPar', () => {
  it('una relación sola no se desvía: la línea queda recta', () => {
    const desvios = desviosPorPar([relacion('r1', 'a', 'b')]);
    expect(desvios.get('r1')).toBe(0);
  });

  it('dos relaciones entre las mismas clases se separan a lados opuestos', () => {
    const desvios = desviosPorPar([relacion('r1', 'a', 'b'), relacion('r2', 'a', 'b')]);
    expect(desvios.get('r1')).toBe(-0.5);
    expect(desvios.get('r2')).toBe(0.5);
  });

  it('A→B y B→A cuentan como el mismo par, o volverían a superponerse', () => {
    const desvios = desviosPorPar([relacion('r1', 'a', 'b'), relacion('r2', 'b', 'a')]);
    expect(desvios.get('r1')).not.toBe(desvios.get('r2'));
  });

  it('tres entre el mismo par dejan una recta en medio y una a cada lado', () => {
    const desvios = desviosPorPar([
      relacion('r1', 'a', 'b'),
      relacion('r2', 'a', 'b'),
      relacion('r3', 'a', 'b'),
    ]);
    expect([desvios.get('r1'), desvios.get('r2'), desvios.get('r3')]).toEqual([-1, 0, 1]);
  });

  it('pares distintos no se contagian el desvío', () => {
    const desvios = desviosPorPar([relacion('r1', 'a', 'b'), relacion('r2', 'c', 'd')]);
    expect(desvios.get('r1')).toBe(0);
    expect(desvios.get('r2')).toBe(0);
  });
});

describe('puntoEnCurva', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 100, y: 0 };

  it('en t=0 y t=1 devuelve los extremos', () => {
    expect(puntoEnCurva(p0, { x: 50, y: 40 }, p1, 0)).toEqual(p0);
    expect(puntoEnCurva(p0, { x: 50, y: 40 }, p1, 1)).toEqual(p1);
  });

  it('con el control en el medio, la curva es la propia recta', () => {
    expect(puntoEnCurva(p0, { x: 50, y: 0 }, p1, 0.5)).toEqual({ x: 50, y: 0 });
  });

  it('la curva se queda a mitad de camino del punto de control', () => {
    // De aquí sale el factor del abanico: para separar 17 px hay que tirar del
    // control 34. Si esta relación cambiara, las relaciones paralelas dejarían
    // de estar donde se dijo que estarían.
    expect(puntoEnCurva(p0, { x: 50, y: 40 }, p1, 0.5).y).toBe(20);
  });
});

describe('puntoMedioRelacion', () => {
  const medida = { ancho: 200, alto: 100 };

  it('entre dos clases alineadas y sin desvío, cae justo en el medio de las dos', () => {
    const a = clase({ id: 'a', name: 'A', position: { x: 0, y: 0 } });
    const b = clase({ id: 'b', name: 'B', position: { x: 600, y: 0 } });
    const punto = puntoMedioRelacion(a, b, medida, medida, 0);
    // Centro de A: (100,50). Centro de B: (700,50). Con desvío 0 el control
    // está sobre esa misma recta, así que el punto medio de la cuadrática
    // coincide con el punto medio del segmento entre los dos anclajes.
    expect(punto.x).toBeCloseTo(400, 6);
    expect(punto.y).toBeCloseTo(50, 6);
  });

  it('con desvío, el punto medio se separa hacia el lado del abanico', () => {
    const a = clase({ id: 'a', name: 'A', position: { x: 0, y: 0 } });
    const b = clase({ id: 'b', name: 'B', position: { x: 600, y: 0 } });
    const recto = puntoMedioRelacion(a, b, medida, medida, 0);
    const desviado = puntoMedioRelacion(a, b, medida, medida, 1);
    expect(desviado.y).not.toBeCloseTo(recto.y, 6);
  });

  it('es simétrico: da igual qué clase se pase como origen', () => {
    const a = clase({ id: 'a', name: 'A', position: { x: 0, y: 0 } });
    const b = clase({ id: 'b', name: 'B', position: { x: 600, y: 300 } });
    const desdeA = puntoMedioRelacion(a, b, medida, medida, 0.5);
    const desdeB = puntoMedioRelacion(b, a, medida, medida, -0.5);
    // Invertir origen/destino y el signo del desvío es la misma curva mirada
    // desde el otro lado: mismo trazo, mismo punto medio.
    expect(desdeA.x).toBeCloseTo(desdeB.x, 6);
    expect(desdeA.y).toBeCloseTo(desdeB.y, 6);
  });

  it('reflexiva: no divide por cero y devuelve un punto a la derecha de la caja', () => {
    const a = clase({ id: 'a', name: 'A', position: { x: 50, y: 50 } });
    const punto = puntoMedioRelacion(a, a, medida, medida, 0);
    expect(Number.isFinite(punto.x)).toBe(true);
    expect(Number.isFinite(punto.y)).toBe(true);
    expect(punto.x).toBeGreaterThan(a.position.x + medida.ancho);
  });
});

describe('etiquetas del texto de una caja', () => {
  it('el atributo identificador lleva su marca, y solo él', () => {
    const conClave = clase({
      id: 'c1',
      name: 'Cliente',
      attributes: [
        { id: 'a1', name: 'id', type: { name: 'Long' }, visibility: '+', isIdentifier: true },
        { id: 'a2', name: 'correo', type: { name: 'String' }, visibility: '+' },
      ],
    });
    expect(textoAtributo(conClave.attributes[0]!)).toContain('{id}');
    expect(textoAtributo(conClave.attributes[1]!)).not.toContain('{id}');
  });

  /*
    Y la marca se mide con el resto de la fila. Era un emoji, que viene de una
    fuente distinta de la monoespaciada sobre la que está calculada
    `ANCHO_CARACTER_MIEMBRO`, así que la única fila cuya anchura no se sabía era
    precisamente la del identificador. Se comprueba que la caja crece al marcarlo
    en vez de comprobar un número: lo que hay que impedir es que la marca vuelva
    a ser invisible para la medida, no fijar cuánto ocupa.
  */
  it('la marca del identificador cuenta para la anchura de la caja', () => {
    const fila = (isIdentifier: boolean): UmlClass =>
      clase({
        id: 'c1',
        name: 'A',
        attributes: [
          { id: 'a1', name: 'identificadorDeCliente', type: { name: 'Long' }, visibility: '+', isIdentifier },
        ],
      });
    expect(medidasDe(fila(true)).ancho).toBeGreaterThan(medidasDe(fila(false)).ancho);
  });

  it('cada tipo de clase enseña su estereotipo, y una clase normal ninguno', () => {
    expect(etiquetaClase(clase({ id: 'c1', name: 'A', kind: 'interface' }))).toBe('«interface»');
    expect(etiquetaClase(clase({ id: 'c2', name: 'A', kind: 'enum' }))).toBe('«enumeration»');
    expect(etiquetaClase(clase({ id: 'c3', name: 'A', kind: 'abstract' }))).toBe('«abstract»');
    expect(etiquetaClase(clase({ id: 'c4', name: 'A', kind: 'class' }))).toBeNull();
  });
});

/*
  La vista: lo que mueven los botones de la barra de estado y el árbol.

  Son cuentas de dos líneas y por eso mismo se prueban. Un signo cambiado no
  rompe nada visible al arrancar: se nota tres pulsaciones después, cuando el
  diagrama ya se ha escapado de la pantalla y no hay forma de volver.
*/

const VENTANA = { ancho: 1000, alto: 600 };

/** El centro del área visible, en coordenadas del diagrama. */
const centroDe = (vista: { x: number; y: number; escala: number }): { x: number; y: number } => ({
  x: vista.x + VENTANA.ancho / vista.escala / 2,
  y: vista.y + VENTANA.alto / vista.escala / 2,
});

describe('limitarEscala', () => {
  it('no deja pasar de los topes por ninguno de los dos lados', () => {
    expect(limitarEscala(100)).toBe(ESCALA_MAXIMA);
    expect(limitarEscala(0.001)).toBe(ESCALA_MINIMA);
    expect(limitarEscala(1)).toBe(1);
  });
});

describe('ampliar', () => {
  it('deja quieto el centro de la ventana', () => {
    // Es la propiedad entera del botón de zoom. Si el centro se moviera, cada
    // pulsación arrastraría el diagrama hacia una esquina.
    const antes = { x: 120, y: -40, escala: 1 };
    const despues = ampliar(antes, VENTANA, 1.25);
    expect(centroDe(despues).x).toBeCloseTo(centroDe(antes).x, 6);
    expect(centroDe(despues).y).toBeCloseTo(centroDe(antes).y, 6);
  });

  it('acercar y alejar con el mismo factor devuelve la vista de partida', () => {
    const antes = { x: 120, y: -40, escala: 1 };
    const vuelta = ampliar(ampliar(antes, VENTANA, 1.25), VENTANA, 1 / 1.25);
    expect(vuelta.escala).toBeCloseTo(antes.escala, 6);
    expect(vuelta.x).toBeCloseTo(antes.x, 6);
    expect(vuelta.y).toBeCloseTo(antes.y, 6);
  });

  it('respeta los topes de escala', () => {
    expect(ampliar({ x: 0, y: 0, escala: ESCALA_MAXIMA }, VENTANA, 2).escala).toBe(ESCALA_MAXIMA);
    expect(ampliar({ x: 0, y: 0, escala: ESCALA_MINIMA }, VENTANA, 0.5).escala).toBe(ESCALA_MINIMA);
  });

  it('en el tope no mueve nada', () => {
    // Si la escala no cambia, la vista tampoco puede cambiar: al llegar al 300 %,
    // seguir pulsando «+» no debe ir desplazando el diagrama.
    const tope = { x: 33, y: 77, escala: ESCALA_MAXIMA };
    expect(ampliar(tope, VENTANA, 1.25)).toEqual(tope);
  });
});

describe('encuadrar', () => {
  const caja = (x: number, y: number): ReturnType<typeof cajaDe> =>
    cajaDe(clase({ id: `c${String(x)}-${String(y)}`, name: 'Pago', position: { x, y } }));

  it('un diagrama vacío vuelve al origen a escala 1', () => {
    // Dividir entre cero o dejar la vista donde estaba acaban en un lienzo en
    // blanco del que no se sabe volver. Pulsar «Ajustar» sin nada que ajustar
    // tiene que dejar el lienzo en un sitio conocido.
    expect(encuadrar([], VENTANA, { ajustar: true, escala: 2 })).toEqual({ x: 0, y: 0, escala: 1 });
  });

  it('centra lo que se le pide', () => {
    const primera = caja(0, 0);
    const segunda = caja(400, 200);
    const centro = centroDe(encuadrar([primera, segunda], VENTANA, { ajustar: true, escala: 1 }));
    expect(centro.x).toBeCloseTo((primera.x + segunda.x + segunda.ancho) / 2, 6);
    expect(centro.y).toBeCloseTo((primera.y + segunda.y + segunda.alto) / 2, 6);
  });

  it('con «ajustar» recalcula la escala aunque hubiera sitio de sobra', () => {
    // Una caja pequeña en una ventana grande: «Ajustar» quiere verla grande, no
    // dejarla del tamaño con el que se estaba trabajando.
    const vista = encuadrar([caja(0, 0)], VENTANA, { ajustar: true, escala: 0.5 });
    expect(vista.escala).toBeGreaterThan(0.5);
  });

  it('sin «ajustar» conserva el aumento con el que se estaba trabajando', () => {
    // Pulsar Entrar sobre una clase del árbol va hasta ella; cambiarle el zoom
    // de paso obligaría a recolocarse después de cada salto.
    const vista = encuadrar([caja(0, 0)], VENTANA, { ajustar: false, escala: 1.5 });
    expect(vista.escala).toBe(1.5);
  });

  it('sin «ajustar» reduce lo justo si de verdad no cabe', () => {
    const lejos = [caja(0, 0), caja(4000, 3000)];
    expect(encuadrar(lejos, VENTANA, { ajustar: false, escala: 3 }).escala).toBeLessThan(3);
  });

  it('nunca se sale de los topes de escala', () => {
    // Un diagrama de doscientas clases «cabría» al 4 % y sería ilegible; una
    // sola caja «cabe» al 900 % y se saldría de la pantalla.
    const enorme = [caja(0, 0), caja(40000, 30000)];
    expect(encuadrar(enorme, VENTANA, { ajustar: true, escala: 1 }).escala).toBe(ESCALA_MINIMA);
    expect(encuadrar([caja(0, 0)], VENTANA, { ajustar: true, escala: 1 }).escala).toBe(
      ESCALA_MAXIMA,
    );
  });
});
