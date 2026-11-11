import { describe, expect, it } from 'vitest';
import type { Participante } from '../hooks/usePresencia';
import {
  FICHAS_VISIBLES,
  inicialDe,
  listarPresentes,
  nombreLegible,
  resumirPresencia,
  rotuloDePresencia,
} from './movil-presencia';

/**
 * Pruebas de la presencia en una barra estrecha.
 *
 * Lo que se comprueba aquí no es el aspecto: es que la información siga estando
 * cuando deja de caber. El fallo que se persigue es silencioso —con cinco
 * personas dentro la barra no da ningún error, simplemente deja de decir en qué
 * proyecto se está— y por eso no lo encuentra nadie mirando la pantalla con dos
 * participantes, que es como se prueba siempre.
 */

/*
  Un participante con todo puesto, para cambiar solo el dato del que habla cada
  prueba. Los nombres de persona van en las pruebas y no aquí: el que se llame
  «Ana» es parte de lo que se está comprobando cuando se comprueba una frase.
*/
const quien = (parcial: Partial<Participante> & { clientId: number }): Participante => ({
  nombre: 'Ana',
  color: '#4a90d9',
  cursor: null,
  seleccion: null,
  modoIA: false,
  ...parcial,
});

const varios = (cuantos: number): Participante[] =>
  Array.from({ length: cuantos }, (_, i) =>
    quien({ clientId: i + 1, nombre: `Persona ${String(i + 1)}` }),
  );

/* -------------------------------------------------------------------------- */

describe('cuántas fichas caben', () => {
  it('con pocas, se pintan todas y no sobra ninguna', () => {
    const { fichas, sobran } = resumirPresencia(varios(2));
    expect(fichas).toHaveLength(2);
    expect(sobran).toBe(0);
  });

  it('nadie más: ni fichas ni número', () => {
    const { fichas, sobran } = resumirPresencia([]);
    expect(fichas).toEqual([]);
    expect(sobran).toBe(0);
  });

  it('justo en el tope todavía no se resume', () => {
    // El caso de borde que importa: con `>=` en vez de `>` aparecería un «y 0
    // más» pegado a las fichas, que es la clase de texto que hace dudar de si la
    // aplicación sabe contar.
    const { fichas, sobran } = resumirPresencia(varios(FICHAS_VISIBLES));
    expect(fichas).toHaveLength(FICHAS_VISIBLES);
    expect(sobran).toBe(0);
  });

  it('pasado el tope, la barra deja de crecer', () => {
    for (const cuantos of [4, 7, 20]) {
      const { fichas, sobran } = resumirPresencia(varios(cuantos));
      expect(fichas).toHaveLength(FICHAS_VISIBLES);
      expect(sobran).toBe(cuantos - FICHAS_VISIBLES);
    }
  });

  it('las que se pintan son las primeras, no una muestra al azar', () => {
    // `usePresencia` ordena por `clientId`, o sea por antigüedad en la sala.
    // Recortar por el final deja las fichas quietas cuando entra alguien nuevo;
    // recortar por cualquier otro sitio las reordenaría en pantalla sola.
    const { fichas } = resumirPresencia(varios(6));
    expect(fichas.map((f) => f.clientId)).toEqual([1, 2, 3]);
  });

  it('no se devuelve el mismo array que entra', () => {
    // La lista viene del estado de un hook. Devolverla tal cual invita a que
    // alguien la ordene en el componente y mute el estado de React sin saberlo.
    const entra = varios(2);
    expect(resumirPresencia(entra).fichas).not.toBe(entra);
  });
});

/* -------------------------------------------------------------------------- */

describe('la inicial de la ficha', () => {
  it('es la primera letra en mayúscula', () => {
    expect(inicialDe('ana')).toBe('A');
  });

  it('un nombre con espacios delante no deja la ficha en blanco', () => {
    expect(inicialDe('   Luis')).toBe('L');
  });

  it('un nombre vacío da algo visible en vez de un hueco', () => {
    expect(inicialDe('')).toBe('?');
    expect(inicialDe('   ')).toBe('?');
  });

  it('un correo da su primera letra, que es lo que hay', () => {
    expect(inicialDe('alex@ejemplo.com')).toBe('A');
  });
});

describe('el nombre que se lee en la lista', () => {
  it('se recorta por los lados', () => {
    expect(nombreLegible('  Ana  ')).toBe('Ana');
  });

  it('sin nombre se dice que no hay nombre, no se deja vacío', () => {
    expect(nombreLegible('')).toBe('Alguien sin nombre');
  });
});

/* -------------------------------------------------------------------------- */

describe('lo que se anuncia del grupo', () => {
  it('nadie más lo dice con palabras, no con un silencio', () => {
    expect(rotuloDePresencia([])).toBe('Nadie más en el proyecto ahora mismo');
  });

  it('una sola persona va en singular', () => {
    expect(rotuloDePresencia([quien({ clientId: 1, nombre: 'Ana' })])).toContain('Otra persona');
  });

  it('dos van con los dos nombres', () => {
    const texto = rotuloDePresencia([
      quien({ clientId: 1, nombre: 'Ana' }),
      quien({ clientId: 2, nombre: 'Luis' }),
    ]);
    expect(texto).toContain('Otras 2 personas');
    expect(texto).toContain('Ana y Luis');
  });

  it('muchas se resumen igual que en el resto de la interfaz', () => {
    // Reutiliza `nombrarAutores` a propósito: si el aviso de cambios ajenos dice
    // «Ana, Luis y 2 más», la presencia no puede decirlo de otra forma, porque
    // son la misma información vista dos veces en la misma pantalla.
    const texto = rotuloDePresencia(varios(5));
    expect(texto).toContain('Otras 5 personas');
    expect(texto).toContain('y 3 más');
  });

  it('el número va antes que los nombres', () => {
    const texto = rotuloDePresencia(varios(4));
    expect(texto.indexOf('4 personas')).toBeLessThan(texto.indexOf('Persona 1'));
  });

  it('dice que se abre una lista: es un botón, y eso hay que anunciarlo', () => {
    expect(rotuloDePresencia(varios(2))).toContain('Se abre la lista');
  });

  it('cuenta a todas, no solo a las que se ven', () => {
    // El rótulo sale de la lista entera y no de `fichas`. Si contara las fichas,
    // con seis personas dentro anunciaría tres, y sería la propia ayuda de
    // accesibilidad la que mintiera.
    expect(resumirPresencia(varios(6)).rotulo).toContain('Otras 6 personas');
  });

  it('un participante sin nombre no rompe la frase', () => {
    expect(rotuloDePresencia([quien({ clientId: 1, nombre: '  ' })])).toContain(
      'Alguien sin nombre',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('la lista de quién está y dónde', () => {
  const nombres: Record<string, string> = { 'c-1': 'Pedido', 'c-2': 'Cliente' };
  const resolver = (id: string): string | null => nombres[id] ?? null;

  it('quien no tiene nada abierto sale solo con su nombre', () => {
    const [fila] = listarPresentes([quien({ clientId: 1, nombre: 'Ana' })], resolver);
    expect(fila?.en).toBeNull();
    expect(fila?.linea).toBe('Ana');
  });

  it('quien tiene una clase abierta dice cuál', () => {
    const [fila] = listarPresentes(
      [quien({ clientId: 1, nombre: 'Ana', seleccion: 'c-1' })],
      resolver,
    );
    expect(fila?.en).toBe('Pedido');
    expect(fila?.linea).toBe('Ana, en Pedido');
  });

  it('una clase que ya no existe no deja una línea a medias', () => {
    /*
      Es el caso que de verdad pasa: alguien tiene abierta `Pedido`, otro la
      borra, y el estado de presencia sigue apuntando a un identificador que ya
      no está en el documento durante el rato que tarda en anunciarse de nuevo.
      Sin esto la línea saldría como «Ana, en null».
    */
    const [fila] = listarPresentes(
      [quien({ clientId: 1, nombre: 'Ana', seleccion: 'c-borrada' })],
      resolver,
    );
    expect(fila?.en).toBeNull();
    expect(fila?.linea).toBe('Ana');
  });

  it('conserva el color, que es lo que ata la fila a la ficha de la barra', () => {
    const [fila] = listarPresentes([quien({ clientId: 9, color: '#d94a4a' })], resolver);
    expect(fila?.color).toBe('#d94a4a');
    expect(fila?.clientId).toBe(9);
  });

  it('lista a todas, también a las que no tienen ficha en la barra', () => {
    // La lista existe precisamente para las que no caben arriba.
    expect(listarPresentes(varios(6), resolver)).toHaveLength(6);
  });

  it('nadie dentro da una lista vacía, no una fila que diga que no hay nadie', () => {
    // El texto de «no hay nadie» es del rótulo; meterlo aquí como una fila falsa
    // haría que el componente tuviera que distinguir filas de verdad de filas de
    // relleno.
    expect(listarPresentes([], resolver)).toEqual([]);
  });
});
