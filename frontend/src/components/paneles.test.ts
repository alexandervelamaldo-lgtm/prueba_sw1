import { describe, expect, it } from 'vitest';
import {
  ANCHO_DE_PLIEGUE,
  ANCHO_MAXIMO,
  ANCHO_MINIMO,
  abrirAcoplado,
  alternarAcoplado,
  alternarColumna,
  disposicionInicial,
  leerDisposicion,
  redimensionar,
} from './paneles';

/**
 * Pruebas de la disposición de los paneles acoplados.
 *
 * Se prueban aquí y no montando el editor porque en este proyecto no hay jsdom:
 * la lógica se sacó del hook justamente para que las reglas —cuánto mide una
 * columna, cuándo se pliega sola, qué se hace con lo que había guardado— se
 * puedan comprobar sin navegador.
 */

describe('disposición inicial', () => {
  it('en escritorio arranca con las dos columnas desplegadas', () => {
    const disposicion = disposicionInicial(false);
    expect(disposicion.izquierda.plegada).toBe(false);
    expect(disposicion.derecha.plegada).toBe(false);
  });

  /**
   * En un teléfono el lienzo es casi toda la pantalla. Arrancar con paneles
   * abiertos obliga a cerrarlos antes de poder trabajar, que es lo contrario de
   * lo que se venía a hacer.
   */
  it('en pantalla estrecha arranca con las dos columnas plegadas', () => {
    const disposicion = disposicionInicial(true);
    expect(disposicion.izquierda.plegada).toBe(true);
    expect(disposicion.derecha.plegada).toBe(true);
  });

  it('el historial empieza cerrado, que es lo que menos se mira', () => {
    expect(disposicionInicial(false).abiertos.historial).toBe(false);
    expect(disposicionInicial(false).abiertos.propiedades).toBe(true);
  });
});

describe('leer lo guardado', () => {
  it('sin nada guardado devuelve la disposición de partida', () => {
    expect(leerDisposicion(null, false)).toEqual(disposicionInicial(false));
  });

  it('un JSON roto no impide abrir el editor', () => {
    expect(leerDisposicion('{no es json', false)).toEqual(disposicionInicial(false));
    expect(leerDisposicion('null', false)).toEqual(disposicionInicial(false));
    expect(leerDisposicion('"una cadena"', false)).toEqual(disposicionInicial(false));
  });

  /**
   * Esto es lo que separa validar campo a campo de validar el objeto entero:
   * quien guardó su disposición con la versión anterior —cuando no existía el
   * panel de historial— no debe perder el ancho de sus columnas.
   */
  it('conserva los campos que entiende aunque falten otros', () => {
    const guardado = JSON.stringify({ izquierda: { ancho: 300, plegada: true } });
    const disposicion = leerDisposicion(guardado, false);

    expect(disposicion.izquierda).toEqual({ ancho: 300, plegada: true });
    expect(disposicion.derecha).toEqual(disposicionInicial(false).derecha);
    expect(disposicion.abiertos).toEqual(disposicionInicial(false).abiertos);
  });

  /**
   * `localStorage` lo puede editar cualquiera desde las herramientas del
   * navegador. Una columna de nueve mil píxeles deja la aplicación sin lienzo y
   * sin forma evidente de recuperarla.
   */
  it('recorta anchos imposibles en vez de creérselos', () => {
    const enorme = leerDisposicion(JSON.stringify({ izquierda: { ancho: 9000 } }), false);
    expect(enorme.izquierda.ancho).toBe(ANCHO_MAXIMO);

    const diminuto = leerDisposicion(JSON.stringify({ derecha: { ancho: 4 } }), false);
    expect(diminuto.derecha.ancho).toBe(ANCHO_MINIMO);

    const absurdo = leerDisposicion(
      JSON.stringify({ izquierda: { ancho: Number.NaN }, derecha: { ancho: 'ancho' } }),
      false,
    );
    expect(absurdo.izquierda.ancho).toBe(disposicionInicial(false).izquierda.ancho);
    expect(absurdo.derecha.ancho).toBe(disposicionInicial(false).derecha.ancho);
  });

  it('ignora paneles guardados que ya no existen', () => {
    const guardado = JSON.stringify({ abiertos: { arbol: false, inventado: true } });
    const disposicion = leerDisposicion(guardado, false);

    expect(disposicion.abiertos.arbol).toBe(false);
    expect(Object.keys(disposicion.abiertos).sort()).toEqual([
      'arbol',
      'historial',
      'ia',
      'paleta',
      'propiedades',
      'tablon',
      'versiones',
    ]);
  });
});

describe('redimensionar', () => {
  it('respeta el ancho pedido dentro de los límites', () => {
    expect(redimensionar({ ancho: 240, plegada: false }, 320)).toEqual({
      ancho: 320,
      plegada: false,
    });
  });

  it('no deja estrechar por debajo del mínimo ni ensanchar sin fin', () => {
    expect(redimensionar({ ancho: 240, plegada: false }, 170).ancho).toBe(ANCHO_MINIMO);
    expect(redimensionar({ ancho: 240, plegada: false }, 2000).ancho).toBe(ANCHO_MAXIMO);
  });

  /**
   * Arrastrar hasta el fondo es la forma natural de decir «quítame esto de en
   * medio». Dejar una columna de sesenta píxeles sería obedecer la letra de lo
   * pedido y no lo pedido.
   */
  it('arrastrar por debajo del pliegue pliega la columna y guarda el ancho', () => {
    const columna = redimensionar({ ancho: 260, plegada: false }, ANCHO_DE_PLIEGUE - 1);
    expect(columna).toEqual({ ancho: 260, plegada: true });
  });

  it('volver a arrastrar por encima del pliegue la despliega', () => {
    expect(redimensionar({ ancho: 260, plegada: true }, 300)).toEqual({
      ancho: 300,
      plegada: false,
    });
  });
});

describe('alternar paneles', () => {
  it('abrir un panel de una columna plegada la despliega', () => {
    const plegada = disposicionInicial(true);
    const abierta = abrirAcoplado(plegada, 'propiedades');

    expect(abierta.derecha.plegada).toBe(false);
    expect(abierta.abiertos.propiedades).toBe(true);
    // La otra columna no se toca: abrir propiedades no es pedir el árbol.
    expect(abierta.izquierda.plegada).toBe(true);
  });

  it('alternar un panel cerrado lo abre', () => {
    const inicial = disposicionInicial(false);
    expect(alternarAcoplado(inicial, 'historial').abiertos.historial).toBe(true);
  });

  /**
   * Una columna con sus dos paneles cerrados es una franja de títulos que ocupa
   * doscientos píxeles para no decir nada.
   */
  it('cerrar el último panel abierto pliega la columna entera', () => {
    const inicial = disposicionInicial(false);
    const sinArbol = alternarAcoplado(inicial, 'arbol');
    expect(sinArbol.izquierda.plegada).toBe(false); // aún queda la paleta

    const sinPaleta = alternarAcoplado(sinArbol, 'paleta');
    expect(sinPaleta.izquierda.plegada).toBe(true);
    expect(sinPaleta.derecha.plegada).toBe(false);
  });
});

describe('alternar columnas', () => {
  it('plegar una columna no cierra sus paneles', () => {
    const plegada = alternarColumna(disposicionInicial(false), 'izquierda');
    expect(plegada.izquierda.plegada).toBe(true);
    expect(plegada.abiertos.arbol).toBe(true);
  });

  /**
   * Desplegar y encontrarse una columna vacía es indistinguible de que el botón
   * no funcione.
   */
  it('desplegar una columna sin paneles abiertos abre el primero', () => {
    let disposicion = disposicionInicial(false);
    disposicion = alternarAcoplado(disposicion, 'arbol');
    disposicion = alternarAcoplado(disposicion, 'paleta');
    expect(disposicion.izquierda.plegada).toBe(true);

    const desplegada = alternarColumna(disposicion, 'izquierda');
    expect(desplegada.izquierda.plegada).toBe(false);
    expect(desplegada.abiertos.arbol).toBe(true);
    expect(desplegada.abiertos.paleta).toBe(false);
  });

  it('el ancho sobrevive a plegar y desplegar', () => {
    const ancha = { ...disposicionInicial(false), derecha: { ancho: 420, plegada: false } };
    const ida = alternarColumna(ancha, 'derecha');
    const vuelta = alternarColumna(ida, 'derecha');
    expect(vuelta.derecha).toEqual({ ancho: 420, plegada: false });
  });
});
