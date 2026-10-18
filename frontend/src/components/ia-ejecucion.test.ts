import { describe, expect, it } from 'vitest';
import { createClass, createDiagram, withClass, type ClassDiagram, type Operation } from '@app/shared';
import {
  clasesPorNombre,
  crearEjecutorEnCola,
  ejecutarPropuesta,
  planificarEjecucion,
  selectorDeBoton,
  type CursorIA,
  type DependenciasEjecucion,
} from './ia-ejecucion';
import type { PropuestaOperacion } from './asistente-voz';

/**
 * Pruebas de la IA que aplica sola sus cambios en el Modo IA. Sin DOM ni
 * temporizadores reales: el cursor, el lienzo y la espera son dobles que
 * anotan lo que se les pidió, porque lo que hay que sujetar es el orden de los
 * pasos y cuándo se detiene, no la animación en sí.
 */

function diagramaConCliente(): ClassDiagram {
  return withClass(createDiagram({ name: 'Proyecto' }), createClass({ id: 'C1', name: 'Cliente' }));
}

const crearPedido: Operation = { op: 'addClass', name: 'Pedido', kind: 'class' };
const atributoEmail: Operation = {
  op: 'addAttribute',
  classRef: { name: 'Cliente' },
  name: 'email',
  type: 'String',
  visibility: '-',
  isIdentifier: false,
  isNullable: true,
  isUnique: false,
};
const borrarCliente: Operation = { op: 'removeClass', ref: { name: 'Cliente' } };

function propuesta(...operaciones: Operation[]): PropuestaOperacion[] {
  return operaciones.map((operacion) => ({ operacion, descripcion: operacion.op }));
}

describe('planificarEjecucion', () => {
  const base = { autoAplicar: true, soloLectura: false };

  it('sin operaciones no hay nada que ejecutar', () => {
    expect(planificarEjecucion(diagramaConCliente(), [], base)).toBe('nada');
  });

  it('una propuesta que no borra nada se aplica sola', () => {
    expect(planificarEjecucion(diagramaConCliente(), propuesta(crearPedido, atributoEmail), base)).toBe(
      'automatico',
    );
  });

  it('una propuesta que borra algo pide confirmación', () => {
    expect(planificarEjecucion(diagramaConCliente(), propuesta(crearPedido, borrarCliente), base)).toBe(
      'confirmar',
    );
  });

  it('con el interruptor apagado, todo pide confirmación', () => {
    expect(
      planificarEjecucion(diagramaConCliente(), propuesta(crearPedido), { ...base, autoAplicar: false }),
    ).toBe('confirmar');
  });

  it('borrar un módulo pide confirmación aunque el cálculo de impacto no lo cuente', () => {
    expect(
      planificarEjecucion(diagramaConCliente(), propuesta({ op: 'removeModule', id: 'M1' }), base),
    ).toBe('confirmar');
  });

  it('en solo lectura no se aplica nada solo', () => {
    expect(
      planificarEjecucion(diagramaConCliente(), propuesta(crearPedido), { ...base, soloLectura: true }),
    ).toBe('confirmar');
  });
});

describe('selectorDeBoton', () => {
  it('crear una clase apunta al botón de la paleta de ese tipo', () => {
    expect(selectorDeBoton(crearPedido)).toBe('[data-ia="addClass:class"]');
    expect(selectorDeBoton({ op: 'addClass', name: 'Forma', kind: 'interface' })).toBe(
      '[data-ia="addClass:interface"]',
    );
  });

  it('crear una relación apunta al botón de ese tipo de relación', () => {
    expect(
      selectorDeBoton({
        op: 'addRelation',
        kind: 'composition',
        source: { name: 'Pedido' },
        target: { name: 'Linea' },
        sourceMultiplicity: '1',
        targetMultiplicity: '*',
      }),
    ).toBe('[data-ia="addRelation:composition"]');
  });

  it('una operación sin botón propio no tiene selector: el cursor va directo a la clase', () => {
    expect(selectorDeBoton(atributoEmail)).toBeNull();
  });
});

/** Dobles que anotan cada paso en un solo registro, para comprobar el orden. */
function dobles(opciones: { fallaEn?: number; conCursor?: boolean; botones?: string[] } = {}) {
  const registro: string[] = [];
  let llamadas = 0;
  const cursor: CursorIA = {
    async mover(destino) {
      registro.push(`mover:${String(destino)}`);
    },
    async clic() {
      registro.push('clic');
    },
    ocultar() {
      registro.push('ocultar');
    },
  };
  const deps: DependenciasEjecucion = {
    aplicar: (operaciones, contexto) => {
      llamadas += 1;
      registro.push(`aplicar:${operaciones.map((o) => o.op).join(',')}:${contexto?.origen ?? ''}`);
      if (opciones.fallaEn === llamadas) return { ok: false, error: 'no se pudo' };
      return { ok: true, clases: [`clase-${llamadas}`] };
    },
    contexto: { origen: 'asistente', propuestoPor: 'modelo' },
    centrar: (ids) => registro.push(`centrar:${ids.join(',')}`),
    resaltar: (id) => registro.push(`resaltar:${id}`),
    buscar: (selector) =>
      (opciones.botones ?? []).includes(selector) ? (`boton${selector}` as unknown as Element) : null,
    nodo: (id) => `nodo:${id}` as unknown as Element,
    cursor: opciones.conCursor === false ? null : cursor,
    pausaMs: 10,
    esperar: async (ms) => {
      registro.push(`esperar:${ms}`);
    },
    agrupar: () => {
      registro.push('agrupar');
      return {
        propio: (cambio) => {
          registro.push('propio');
          return cambio();
        },
        cerrar: () => registro.push('cerrar-grupo'),
      };
    },
  };
  return { deps, registro };
}

describe('ejecutarPropuesta', () => {
  it('aplica las operaciones de una en una, en orden, como un solo grupo de deshacer', async () => {
    const { deps, registro } = dobles({ conCursor: false });

    const resultado = await ejecutarPropuesta([crearPedido, atributoEmail], deps);

    expect(resultado).toEqual({ aplicadas: 2, error: null });
    expect(
      registro.filter((r) => r.startsWith('aplicar') || r.includes('grupo') || r === 'agrupar' || r === 'propio'),
    ).toEqual([
      'agrupar',
      'propio',
      'aplicar:addClass:asistente',
      'propio',
      'aplicar:addAttribute:asistente',
      'cerrar-grupo',
    ]);
  });

  it('centra y resalta la clase que tocó cada paso', async () => {
    const { deps, registro } = dobles({ conCursor: false });

    await ejecutarPropuesta([crearPedido], deps);

    expect(registro).toContain('centrar:clase-1');
    expect(registro).toContain('resaltar:clase-1');
  });

  it('con cursor, va al botón real y hace clic antes de aplicar, y luego va a la clase', async () => {
    const { deps, registro } = dobles({ botones: ['[data-ia="addClass:class"]'] });

    await ejecutarPropuesta([crearPedido], deps);

    const clave = registro.filter((r) => r.startsWith('mover') || r === 'clic' || r.startsWith('aplicar'));
    expect(clave).toEqual([
      'mover:boton[data-ia="addClass:class"]',
      'clic',
      'aplicar:addClass:asistente',
      'mover:nodo:clase-1',
    ]);
    expect(registro.at(-2)).toBe('ocultar');
  });

  it('si el botón no está en pantalla, no inventa un recorrido: aplica y va a la clase', async () => {
    const { deps, registro } = dobles({ botones: [] });

    await ejecutarPropuesta([crearPedido], deps);

    expect(registro.filter((r) => r.startsWith('mover') || r === 'clic')).toEqual(['mover:nodo:clase-1']);
  });

  it('se detiene en la primera operación que falla, cierra el grupo y lo dice', async () => {
    const { deps, registro } = dobles({ fallaEn: 2 });

    const resultado = await ejecutarPropuesta([crearPedido, atributoEmail, crearPedido], deps);

    expect(resultado).toEqual({ aplicadas: 1, error: 'no se pudo' });
    expect(registro.filter((r) => r.startsWith('aplicar'))).toHaveLength(2);
    expect(registro).toContain('ocultar');
    expect(registro.at(-1)).toBe('cerrar-grupo');
  });

  it('pausa entre pasos para que se vea cada uno, pero no después del último', async () => {
    const { deps, registro } = dobles({ conCursor: false });

    await ejecutarPropuesta([crearPedido, atributoEmail], deps);

    expect(registro.filter((r) => r === 'esperar:10')).toHaveLength(1);
  });
});

describe('ejecutarPropuesta, cuando algo se interrumpe', () => {
  it('si se cancela (se cerró el panel), no aplica el paso siguiente', async () => {
    const { deps, registro } = dobles({ conCursor: false });
    let pasos = 0;
    deps.cancelado = () => pasos >= 1;
    const aplicar = deps.aplicar;
    deps.aplicar = (operaciones, contexto) => {
      pasos += 1;
      return aplicar(operaciones, contexto);
    };

    const resultado = await ejecutarPropuesta([crearPedido, atributoEmail], deps);

    expect(resultado).toEqual({ aplicadas: 1, error: null });
    expect(registro.filter((r) => r.startsWith('aplicar'))).toHaveLength(1);
    expect(registro.at(-1)).toBe('cerrar-grupo');
  });

  it('si aplicar lanza, cierra el grupo y esconde el cursor igualmente', async () => {
    const { deps, registro } = dobles();
    deps.aplicar = () => {
      throw new Error('se rompió');
    };

    await expect(ejecutarPropuesta([crearPedido], deps)).rejects.toThrow('se rompió');
    expect(registro).toContain('ocultar');
    expect(registro.at(-1)).toBe('cerrar-grupo');
  });
});

describe('crearEjecutorEnCola (operaciones que llegan por el stream)', () => {
  it('aplica en orden lo que se va encolando, aunque llegue mientras aplica lo anterior', async () => {
    const { deps, registro } = dobles({ conCursor: false });
    const aplicadas: string[] = [];
    const ejecutor = crearEjecutorEnCola(deps, { alAplicar: (operacion) => aplicadas.push(operacion.op) });

    ejecutor.encolar(crearPedido);
    await Promise.resolve();
    ejecutor.encolar(atributoEmail);
    const resultado = await ejecutor.terminar();

    expect(resultado).toEqual({ aplicadas: 2, error: null });
    expect(aplicadas).toEqual(['addClass', 'addAttribute']);
    expect(registro.filter((r) => r.startsWith('aplicar'))).toEqual([
      'aplicar:addClass:asistente',
      'aplicar:addAttribute:asistente',
    ]);
  });

  it('un solo grupo de deshacer para todo lo encolado, que se cierra al terminar', async () => {
    const { deps, registro } = dobles({ conCursor: false });
    const ejecutor = crearEjecutorEnCola(deps);

    ejecutor.encolar(crearPedido);
    ejecutor.encolar(atributoEmail);
    await ejecutor.terminar();

    expect(registro.filter((r) => r === 'agrupar')).toHaveLength(1);
    expect(registro.at(-1)).toBe('cerrar-grupo');
  });

  it('sin nada encolado no abre grupo ni crea cursor', async () => {
    const { deps, registro } = dobles();
    const ejecutor = crearEjecutorEnCola(deps);

    expect(await ejecutor.terminar()).toEqual({ aplicadas: 0, error: null });
    expect(registro).toEqual([]);
  });

  it('tras un fallo ignora lo que se encole después', async () => {
    const { deps, registro } = dobles({ conCursor: false, fallaEn: 1 });
    const ejecutor = crearEjecutorEnCola(deps);

    ejecutor.encolar(crearPedido);
    ejecutor.encolar(atributoEmail);
    const resultado = await ejecutor.terminar();

    expect(resultado).toEqual({ aplicadas: 0, error: 'no se pudo' });
    expect(registro.filter((r) => r.startsWith('aplicar'))).toHaveLength(1);
  });
});

describe('clasesPorNombre', () => {
  it('traduce los nombres que señala la IA a ids de clase, sin distinguir mayúsculas', () => {
    expect(clasesPorNombre(diagramaConCliente(), ['cliente'])).toEqual(['C1']);
  });

  it('ignora los nombres que no están en el diagrama', () => {
    expect(clasesPorNombre(diagramaConCliente(), ['Inventada', 'Cliente'])).toEqual(['C1']);
  });
});
