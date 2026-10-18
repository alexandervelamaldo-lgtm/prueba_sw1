import { describe, expect, it } from 'vitest';
import { createClass, createDiagram, withClass, type EventoAsistente, type Operation } from '@app/shared';
import { crearManejadorDeStream, type EstadoRespuesta } from './respuesta-en-stream';

/**
 * Qué hace el Modo IA con cada evento del stream: qué texto pinta, qué dice en
 * voz alta, qué aplica sola y qué deja esperando su «Aplicar». El ejecutor y la
 * voz son dobles que anotan; lo que se sujeta es la decisión, no la animación.
 */

const diagrama = withClass(createDiagram({ name: 'P' }), createClass({ id: 'C1', name: 'Cliente' }));
const crearPedido: Operation = { op: 'addClass', name: 'Pedido', kind: 'class' };
const crearLinea: Operation = { op: 'addClass', name: 'Linea', kind: 'class' };
const borrarCliente: Operation = { op: 'removeClass', ref: { name: 'Cliente' } };

function preparar(
  opciones: { autoAplicar?: boolean; soloLectura?: boolean; conVoz?: boolean; aplicarAMano?: boolean } = {},
) {
  const encoladas: Operation[] = [];
  const porAplicar: Operation[] = [];
  const dichas: string[] = [];
  const estados: EstadoRespuesta[] = [];
  let alAplicar: ((operacion: Operation) => void) | undefined;
  const manejador = crearManejadorDeStream({
    diagrama: () => diagrama,
    autoAplicar: opciones.autoAplicar ?? true,
    soloLectura: opciones.soloLectura ?? false,
    crearEjecutor: (avisos) => {
      alAplicar = avisos.alAplicar;
      return {
        encolar: (operacion) => {
          encoladas.push(operacion);
          if (opciones.aplicarAMano) porAplicar.push(operacion);
          else alAplicar?.(operacion);
        },
        terminar: async () => ({ aplicadas: encoladas.length, error: null }),
      };
    },
    voz:
      opciones.conVoz === false
        ? null
        : { decir: (texto) => dichas.push(texto), terminar: () => dichas.push('<fin>') },
    alCambiar: (estado) => estados.push(estado),
  });
  const enviar = (...eventos: EventoAsistente[]): void => eventos.forEach((e) => manejador.alEvento(e));
  const ultimo = (): EstadoRespuesta => estados.at(-1)!;
  /** Simula que el ejecutor termina de aplicar la siguiente operación encolada. */
  const aplicarSiguiente = (): void => {
    const operacion = porAplicar.shift();
    if (operacion) alAplicar?.(operacion);
  };
  return { manejador, enviar, encoladas, dichas, ultimo, aplicarSiguiente };
}

const op = (operacion: Operation): EventoAsistente => ({ tipo: 'operacion', operacion, descripcion: `desc ${operacion.op}` });

describe('crearManejadorDeStream', () => {
  it('pinta el texto mientras se escribe y lo fija al completarse el mensaje', () => {
    const { enviar, ultimo } = preparar();

    enviar({ tipo: 'mensaje-parcial', texto: 'Creo la' });
    expect(ultimo().texto).toBe('Creo la');
    enviar({ tipo: 'mensaje', texto: 'Creo la clase.' }, { tipo: 'mensaje-parcial', texto: '¿Algo' });

    expect(ultimo().texto).toBe('Creo la clase. ¿Algo');
  });

  it('cada mensaje completo se dice en voz alta, en orden, y la voz termina con el fin', () => {
    const { enviar, dichas } = preparar();

    enviar(
      { tipo: 'mensaje', texto: 'Uno.' },
      { tipo: 'mensaje-parcial', texto: 'Do' },
      { tipo: 'mensaje', texto: 'Dos.' },
      { tipo: 'fin', motor: 'm', confianza: 1 },
    );

    expect(dichas).toEqual(['Uno.', 'Dos.', '<fin>']);
  });

  it('las operaciones que no borran nada van al ejecutor según llegan, y se listan como aplicadas', () => {
    const { enviar, encoladas, ultimo } = preparar();

    enviar(op(crearPedido), { tipo: 'mensaje', texto: 'Y otra.' }, op(crearLinea));

    expect(encoladas).toEqual([crearPedido, crearLinea]);
    expect(ultimo().aplicadas).toEqual(['desc addClass', 'desc addClass']);
    expect(ultimo().propuesta).toEqual([]);
  });

  it('una operación que borra algo se retiene, y todo lo que llega después también', () => {
    const { enviar, encoladas, ultimo } = preparar();

    enviar(op(crearPedido), op(borrarCliente), op(crearLinea));

    expect(encoladas).toEqual([crearPedido]);
    expect(ultimo().propuesta.map((p) => p.operacion)).toEqual([borrarCliente, crearLinea]);
  });

  it('con la ejecución automática apagada, todo queda como propuesta', () => {
    const { enviar, encoladas, ultimo } = preparar({ autoAplicar: false });

    enviar(op(crearPedido));

    expect(encoladas).toEqual([]);
    expect(ultimo().propuesta).toHaveLength(1);
  });

  it('el fin guarda el motor y marca la respuesta como terminada', async () => {
    const { manejador, enviar, ultimo } = preparar();

    enviar({ tipo: 'mensaje', texto: 'Hola.' }, { tipo: 'fin', motor: 'modelo-remoto', confianza: 0.8 });
    const resultado = await manejador.terminar();

    expect(ultimo()).toMatchObject({ motor: 'modelo-remoto', terminado: true, error: null });
    expect(resultado).toEqual({ aplicadas: 0, error: null });
  });

  it('un fin sin mensajes ni operaciones pide reformular', () => {
    const { enviar, ultimo } = preparar();

    enviar({ tipo: 'fin', motor: 'm', confianza: 0 });

    expect(ultimo().texto).toBe('Orden no reconocida. Cabe reformularla con otras palabras.');
  });

  it('un error a mitad se muestra, lo ya recibido se queda y lo que llegue después se ignora', () => {
    const { enviar, encoladas, ultimo } = preparar();

    enviar(
      { tipo: 'mensaje', texto: 'Creo Pedido.' },
      op(crearPedido),
      { tipo: 'error', mensaje: 'el modelo se cortó' },
      op(crearLinea),
    );

    expect(encoladas).toEqual([crearPedido]);
    expect(ultimo()).toMatchObject({ texto: 'Creo Pedido.', error: 'el modelo se cortó', terminado: true });
  });

  it('sin voz (orden escrita) no se dice nada', () => {
    const { enviar, dichas } = preparar({ conVoz: false });

    enviar({ tipo: 'mensaje', texto: 'Hola.' }, { tipo: 'fin', motor: 'm', confianza: 1 });

    expect(dichas).toEqual([]);
  });
});

describe('crearManejadorDeStream, narración en orden', () => {
  it('un mensaje escrito después de una operación no se muestra ni se dice hasta que esa operación se aplica', () => {
    const { enviar, dichas, ultimo, aplicarSiguiente } = preparar({ aplicarAMano: true });

    enviar({ tipo: 'mensaje', texto: 'Creo Pedido.' }, op(crearPedido), { tipo: 'mensaje', texto: 'Listo.' });
    expect(ultimo().texto).toBe('Creo Pedido.');
    expect(dichas).toEqual(['Creo Pedido.']);

    aplicarSiguiente();
    expect(ultimo().texto).toBe('Creo Pedido. Listo.');
    expect(dichas).toEqual(['Creo Pedido.', 'Listo.']);
  });

  it('el texto parcial que llega mientras se aplica tampoco se adelanta', () => {
    const { enviar, ultimo, aplicarSiguiente } = preparar({ aplicarAMano: true });

    enviar(op(crearPedido), { tipo: 'mensaje-parcial', texto: 'Lis' });
    expect(ultimo().texto).toBe('');

    aplicarSiguiente();
    expect(ultimo().texto).toBe('Lis');
  });

  it('el fin espera a lo pendiente: la voz y el «terminado» llegan después del último mensaje', async () => {
    const { manejador, enviar, dichas, ultimo, aplicarSiguiente } = preparar({ aplicarAMano: true });

    enviar(op(crearPedido), { tipo: 'mensaje', texto: 'Listo.' }, { tipo: 'fin', motor: 'm', confianza: 1 });
    expect(ultimo().terminado).toBe(false);
    expect(dichas).toEqual([]);

    aplicarSiguiente();
    await manejador.terminar();
    expect(dichas).toEqual(['Listo.', '<fin>']);
    expect(ultimo()).toMatchObject({ texto: 'Listo.', terminado: true });
  });

  it('si el ejecutor se detiene antes de alcanzarlo, al terminar se muestra igual lo que quedó retenido', async () => {
    const { manejador, enviar, ultimo } = preparar({ aplicarAMano: true });

    enviar(op(crearPedido), { tipo: 'mensaje', texto: 'Listo.' }, { tipo: 'fin', motor: 'm', confianza: 1 });
    await manejador.terminar();

    expect(ultimo()).toMatchObject({ texto: 'Listo.', terminado: true });
  });
});
