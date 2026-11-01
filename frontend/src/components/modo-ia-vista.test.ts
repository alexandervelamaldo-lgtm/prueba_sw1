import { describe, expect, it } from 'vitest';
import type { Acoplado } from './paneles';
import {
  accionEntradaModoIA,
  botonTemaModoIA,
  debeMostrarOrbe,
  debeRetenerBienvenida,
  debeSalirConEscape,
  estadoProgresoOrbe,
  etiquetaAvatarIA,
  filtrarPanelesParaModoIA,
  panelVisibleEnModoIA,
  siguientePasoOrbe,
  paddingDeEncuadre,
  conexionConProblema,
  veloVisible,
} from './modo-ia-vista';

describe('modo-ia-vista: visibilidad de paneles', () => {
  it('fuera del Modo IA todos los paneles permanecen visibles', () => {
    const todos: Acoplado[] = ['arbol', 'paleta', 'propiedades', 'historial', 'tablon', 'ia', 'versiones'];
    for (const panel of todos) {
      expect(panelVisibleEnModoIA(panel, false)).toBe(true);
    }
  });

  it('dentro del Modo IA solo se muestran el árbol del proyecto y el panel de la IA', () => {
    expect(panelVisibleEnModoIA('arbol', true)).toBe(true);
    expect(panelVisibleEnModoIA('ia', true)).toBe(true);

    expect(panelVisibleEnModoIA('paleta', true)).toBe(false);
    expect(panelVisibleEnModoIA('propiedades', true)).toBe(false);
    expect(panelVisibleEnModoIA('historial', true)).toBe(false);
    expect(panelVisibleEnModoIA('tablon', true)).toBe(false);
    expect(panelVisibleEnModoIA('versiones', true)).toBe(false);
  });

  it('filtrarPanelesParaModoIA preserva referencias e identidades de paneles permitidos', () => {
    const izquierda: { acoplado: Acoplado; id: number }[] = [
      { acoplado: 'arbol', id: 1 },
      { acoplado: 'paleta', id: 2 },
    ];
    const derecha: { acoplado: Acoplado; id: number }[] = [
      { acoplado: 'propiedades', id: 3 },
      { acoplado: 'historial', id: 4 },
      { acoplado: 'tablon', id: 5 },
      { acoplado: 'ia', id: 6 },
      { acoplado: 'versiones', id: 7 },
    ];

    expect(filtrarPanelesParaModoIA(izquierda, false)).toBe(izquierda);
    expect(filtrarPanelesParaModoIA(derecha, false)).toBe(derecha);

    const izqFiltrada = filtrarPanelesParaModoIA(izquierda, true);
    expect(izqFiltrada).toEqual([{ acoplado: 'arbol', id: 1 }]);

    const derFiltrada = filtrarPanelesParaModoIA(derecha, true);
    expect(derFiltrada).toEqual([{ acoplado: 'ia', id: 6 }]);
  });
});

describe('modo-ia-vista: retención de la bienvenida', () => {
  it('en un diagrama vacío (0 clases) retiene la bienvenida hasta que exista la primera clase', () => {
    expect(debeRetenerBienvenida(0)).toBe(true);
  });

  it('cuando ya existen clases (1 o más) no retiene la bienvenida indefinidamente', () => {
    expect(debeRetenerBienvenida(1)).toBe(false);
    expect(debeRetenerBienvenida(5)).toBe(false);
  });
});

describe('modo-ia-vista: salida con tecla Escape', () => {
  it('Escape sale del modo si está en Modo IA y no hay diálogo modal abierto', () => {
    expect(debeSalirConEscape({ key: 'Escape' }, false, true)).toBe(true);
  });

  it('Escape no sale del modo si hay un diálogo modal abierto', () => {
    expect(debeSalirConEscape({ key: 'Escape' }, true, true)).toBe(false);
  });

  it('Escape no sale si no está en Modo IA', () => {
    expect(debeSalirConEscape({ key: 'Escape' }, false, false)).toBe(false);
  });

  it('otra tecla no sale del modo', () => {
    expect(debeSalirConEscape({ key: 'Enter' }, false, true)).toBe(false);
    expect(debeSalirConEscape({ key: 'a' }, false, true)).toBe(false);
  });
});

describe('modo-ia-vista: entrada al modo según origen (regla 3)', () => {
  it('pulsar el avatar inicia saludo, conversación con micrófono y efecto Lumina', () => {
    const accion = accionEntradaModoIA('avatar');
    expect(accion.iniciarSaludo).toBe(true);
    expect(accion.iniciarConversacion).toBe(true);
    expect(accion.dispararEfecto).toBe(true);
  });

  it('entrar por el menú (Ver > Modo IA) no inicia saludo ni micrófono pero sí dispara efecto', () => {
    const accion = accionEntradaModoIA('menu');
    expect(accion.iniciarSaludo).toBe(false);
    expect(accion.iniciarConversacion).toBe(false);
    expect(accion.dispararEfecto).toBe(true);
  });
});

describe('modo-ia-vista: etiqueta del avatar en Modo IA (regla 7)', () => {
  it('fuera del Modo IA devuelve undefined para usar la etiqueta estándar', () => {
    expect(etiquetaAvatarIA(false, false)).toBeUndefined();
    expect(etiquetaAvatarIA(false, true)).toBeUndefined();
  });

  it('en Modo IA con conversación apagada indica "Iniciar conversación"', () => {
    expect(etiquetaAvatarIA(true, false)).toBe('Iniciar conversación');
  });

  it('en Modo IA con conversación encendida indica "Salir del modo conversación"', () => {
    expect(etiquetaAvatarIA(true, true)).toBe('Salir del modo conversación');
  });
});

describe('modo-ia-vista: visibilidad del orbe (T3 - S6)', () => {
  it('se muestra solo en Modo IA mientras la IA está pensando', () => {
    expect(debeMostrarOrbe(true, 'pensando')).toBe(true);
  });

  it('no se muestra si la IA está en reposo', () => {
    expect(debeMostrarOrbe(true, 'reposo')).toBe(false);
  });

  it('no se muestra fuera del Modo IA aunque la IA esté pensando', () => {
    expect(debeMostrarOrbe(false, 'pensando')).toBe(false);
    expect(debeMostrarOrbe(false, 'reposo')).toBe(false);
  });
});

describe('modo-ia-vista: botón de alternar tema (T3 - S7)', () => {
  it('con tema oscuro ofrece cambiar a modo día con icono tema-claro', () => {
    const res = botonTemaModoIA('oscuro');
    expect(res.icono).toBe('tema-claro');
    expect(res.etiqueta).toBe('Cambiar a modo día');
  });

  it('con tema claro ofrece cambiar a modo noche con icono tema-oscuro', () => {
    const res = botonTemaModoIA('claro');
    expect(res.icono).toBe('tema-oscuro');
    expect(res.etiqueta).toBe('Cambiar a modo noche');
  });
});

describe('modo-ia-vista: etiquetas rotativas del orbe (T3 - S6)', () => {
  it('sigue la secuencia Pensando, Buscando, Analizando, Redactando', () => {
    expect(estadoProgresoOrbe(0)).toEqual({ etiqueta: 'Pensando', prog: 0 });
    expect(estadoProgresoOrbe(1)).toEqual({ etiqueta: 'Buscando', prog: 1 });
    expect(estadoProgresoOrbe(2)).toEqual({ etiqueta: 'Analizando', prog: 2 });
    expect(estadoProgresoOrbe(3)).toEqual({ etiqueta: 'Redactando', prog: 3 });
    expect(estadoProgresoOrbe(4)).toEqual({ etiqueta: 'Pensando', prog: 0 });
  });

  it('siguientePasoOrbe avanza el paso y calcula el índice cíclico', () => {
    const paso1 = siguientePasoOrbe(0);
    expect(paso1).toEqual({ paso: 1, prog: 1, etiqueta: 'Buscando' });

    const paso2 = siguientePasoOrbe(1);
    expect(paso2).toEqual({ paso: 2, prog: 2, etiqueta: 'Analizando' });

    const paso3 = siguientePasoOrbe(2);
    expect(paso3).toEqual({ paso: 3, prog: 3, etiqueta: 'Redactando' });

    const paso4 = siguientePasoOrbe(3);
    expect(paso4).toEqual({ paso: 4, prog: 0, etiqueta: 'Pensando' });
  });
});

describe('paddingDeEncuadre', () => {
  it('fuera del Modo IA deja el padding tal cual', () => {
    expect(paddingDeEncuadre(0.18, false)).toBe(0.18);
  });

  it('en el Modo IA encuadra en lo que deja libre la barra flotante', () => {
    expect(paddingDeEncuadre(0.18, true)).toEqual({
      top: 0.18,
      left: 0.18,
      right: 0.18,
      bottom: '50%',
    });
  });
});

describe('conexionConProblema', () => {
  it('no avisa con la conexión al día', () => {
    expect(conexionConProblema('conectado', true)).toBe(false);
  });

  it('avisa mientras hay cambios sin sincronizar', () => {
    expect(conexionConProblema('conectado', false)).toBe(true);
  });

  it('avisa en cualquier otro estado de la conexión', () => {
    for (const estado of ['conectando', 'desconectado', 'sin-permiso'] as const) {
      expect(conexionConProblema(estado, true)).toBe(true);
    }
  });
});

describe('veloVisible', () => {
  it('se ve con la bienvenida, con el globo o con los dos', () => {
    expect(veloVisible(true, false)).toBe(true);
    expect(veloVisible(false, true)).toBe(true);
    expect(veloVisible(true, true)).toBe(true);
  });

  it('no se ve sin ninguno de los dos', () => {
    expect(veloVisible(false, false)).toBe(false);
  });
});
