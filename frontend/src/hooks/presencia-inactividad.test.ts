import { describe, expect, it } from 'vitest';
import { podarCursoresParados, type Participante, type Rastro } from './usePresencia';

/**
 * Caducidad del cursor parado.
 *
 * `onPointerLeave` cubre a quien saca el ratón del lienzo. No cubre el caso
 * corriente: dejarlo quieto encima y ponerse a otra cosa. Esa flecha se queda
 * sobre el diagrama afirmando que alguien está ahí cuando no lo está, y encima
 * tapando lo que hay debajo.
 *
 * Todo esto se comprueba pasando la hora como argumento. Si dependiera del
 * reloj real, comprobar que algo caduca a los quince segundos costaría quince
 * segundos por prueba, y una suite que tarda es una suite que se deja de
 * ejecutar.
 */

const VENTANA = 15_000;

function participante(parcial: Partial<Participante> = {}): Participante {
  return {
    clientId: 1,
    nombre: 'Ana',
    color: '#739ec9',
    cursor: { x: 10, y: 10 },
    seleccion: null,
    modoIA: false,
    ...parcial,
  };
}

/** Un rastro visto hace `hace` milisegundos, en la posición indicada. */
function rastro(x: number, y: number, hace: number, ahora: number): Map<number, Rastro> {
  return new Map([[1, { x, y, en: ahora - hace }]]);
}

describe('podarCursoresParados', () => {
  const AHORA = 1_000_000;

  it('mantiene el cursor de quien se acaba de mover', () => {
    const { visibles } = podarCursoresParados(
      [participante()],
      rastro(10, 10, 2000, AHORA),
      AHORA,
      VENTANA,
    );

    expect(visibles[0]?.cursor).toEqual({ x: 10, y: 10 });
  });

  it('apaga el cursor de quien lleva demasiado quieto', () => {
    const { visibles } = podarCursoresParados(
      [participante()],
      rastro(10, 10, 20_000, AHORA),
      AHORA,
      VENTANA,
    );

    expect(visibles[0]?.cursor).toBeNull();
  });

  it('reinicia la cuenta en cuanto el cursor se mueve un píxel', () => {
    // El rastro dice que lleva veinte segundos en (10,10), pero el estado que
    // acaba de llegar lo pone en (11,10): se ha movido, luego está.
    const { visibles } = podarCursoresParados(
      [participante({ cursor: { x: 11, y: 10 } })],
      rastro(10, 10, 20_000, AHORA),
      AHORA,
      VENTANA,
    );

    expect(visibles[0]?.cursor).toEqual({ x: 11, y: 10 });
  });

  it('vuelve a mostrarlo si se mueve después de haber caducado', () => {
    // Caducar no expulsa a nadie: la persona no se fue, solo dejó de mover el
    // ratón. Al moverlo otra vez reaparece sin necesitar reconexión.
    const primera = podarCursoresParados(
      [participante()],
      rastro(10, 10, 20_000, AHORA),
      AHORA,
      VENTANA,
    );
    expect(primera.visibles[0]?.cursor).toBeNull();

    const segunda = podarCursoresParados(
      [participante({ cursor: { x: 40, y: 40 } })],
      primera.vistos,
      AHORA + 500,
      VENTANA,
    );
    expect(segunda.visibles[0]?.cursor).toEqual({ x: 40, y: 40 });
  });

  it('caduca el cursor pero no la presencia ni la selección', () => {
    /*
      La distinción que da sentido a todo esto. Quien deja el ratón quieto sigue
      en la sala: tiene que seguir contando en la barra de estado y su clase
      tiene que seguir resaltada con su color. Lo único que deja de ser cierto
      es dónde está su ratón, y es lo único que se retira.
    */
    const { visibles } = podarCursoresParados(
      [participante({ seleccion: 'Cliente' })],
      rastro(10, 10, 60_000, AHORA),
      AHORA,
      VENTANA,
    );

    expect(visibles).toHaveLength(1);
    expect(visibles[0]?.cursor).toBeNull();
    expect(visibles[0]?.seleccion).toBe('Cliente');
    expect(visibles[0]?.nombre).toBe('Ana');
    expect(visibles[0]?.color).toBe('#739ec9');
  });

  it('olvida a quien ya no está en la sala', () => {
    // Si el mapa de rastros solo creciera, una sesión larga acabaría guardando
    // una entrada por cada persona que pasó por el diagrama.
    const { vistos } = podarCursoresParados([], rastro(10, 10, 1000, AHORA), AHORA, VENTANA);

    expect(vistos.size).toBe(0);
  });

  it('no guarda rastro de quien no tiene cursor', () => {
    const { visibles, vistos } = podarCursoresParados(
      [participante({ cursor: null })],
      new Map(),
      AHORA,
      VENTANA,
    );

    expect(visibles[0]?.cursor).toBeNull();
    expect(vistos.size).toBe(0);
  });

  it('no modifica el mapa que recibe', () => {
    // Devolver un mapa nuevo en vez de tocar el de entrada es lo que permite
    // llamarla desde el render sin efectos a distancia.
    const anteriores = rastro(10, 10, 20_000, AHORA);
    const copia = new Map(anteriores);

    podarCursoresParados([participante({ cursor: { x: 99, y: 99 } })], anteriores, AHORA, VENTANA);

    expect([...anteriores]).toEqual([...copia]);
  });
});
