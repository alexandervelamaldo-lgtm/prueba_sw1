import { describe, expect, it } from 'vitest';
import { crearLectorSse, formatearEventoSse, type EventoAsistente } from './eventos-asistente.js';

/**
 * El contrato del Modo IA en streaming: el servidor escribe con
 * `formatearEventoSse` y el navegador lee con `crearLectorSse`. Lo que importa
 * es que lo que sale de un lado se lea igual en el otro aunque la red lo corte
 * por cualquier sitio.
 */

const eventos: EventoAsistente[] = [
  { tipo: 'mensaje-parcial', texto: 'Creo la cla' },
  { tipo: 'mensaje', texto: 'Creo la clase Pedido.' },
  {
    tipo: 'operacion',
    operacion: { op: 'addClass', name: 'Pedido', kind: 'class' },
    descripcion: 'Crear clase «Pedido»',
  },
  { tipo: 'fin', motor: 'modelo-remoto (prueba)', confianza: 0.9 },
];

describe('formatearEventoSse', () => {
  it('escribe un evento por bloque, con una sola línea data y una línea en blanco al final', () => {
    const texto = formatearEventoSse({ tipo: 'mensaje', texto: 'Hola\nde nuevo' });
    expect(texto).toBe('data: {"tipo":"mensaje","texto":"Hola\\nde nuevo"}\n\n');
  });
});

describe('crearLectorSse', () => {
  it('lee lo que escribió formatearEventoSse, en el mismo orden', () => {
    const leidos: EventoAsistente[] = [];
    const lector = crearLectorSse((evento) => leidos.push(evento));

    lector.empujar(eventos.map(formatearEventoSse).join(''));

    expect(leidos).toEqual(eventos);
  });

  it('un evento partido en varios trozos se lee entero, una sola vez', () => {
    const leidos: EventoAsistente[] = [];
    const lector = crearLectorSse((evento) => leidos.push(evento));
    const texto = eventos.map(formatearEventoSse).join('');

    for (const caracter of texto) lector.empujar(caracter);

    expect(leidos).toEqual(eventos);
  });

  it('acepta finales de línea \\r\\n', () => {
    const leidos: EventoAsistente[] = [];
    const lector = crearLectorSse((evento) => leidos.push(evento));

    lector.empujar(formatearEventoSse(eventos[1]!).replace(/\n/g, '\r\n'));

    expect(leidos).toEqual([eventos[1]]);
  });

  it('ignora comentarios y bloques que no son un evento conocido', () => {
    const leidos: EventoAsistente[] = [];
    const lector = crearLectorSse((evento) => leidos.push(evento));

    lector.empujar(': latido\n\n');
    lector.empujar('data: no es json\n\n');
    lector.empujar('data: {"tipo":"inventado"}\n\n');
    lector.empujar(formatearEventoSse(eventos[1]!));

    expect(leidos).toEqual([eventos[1]]);
  });
});
