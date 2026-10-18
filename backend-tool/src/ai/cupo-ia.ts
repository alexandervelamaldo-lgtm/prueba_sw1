import { diaDeHoy, type UsoIAStore } from '../storage/uso-ia.js';

/**
 * El cupo diario de la IA de cada usuario (`LLM_LIMITE_DIARIO_TOKENS`).
 *
 * Toda llamada al modelo en nombre de alguien pasa por aquí: las rutas del
 * asistente, el resumen de la memoria y los comentarios espontáneos.
 * `reservar` decide si hay cupo y, si lo hay, deja apartada una estimación
 * mientras el pedido está en curso. Sin esa reserva, varios pedidos a la vez
 * (varias pestañas) leerían todos «todavía hay cupo» antes de que ninguno
 * sumara lo suyo, y entre todos pasarían el límite.
 *
 * La comprobación y la reserva van juntas, sin ninguna espera en medio, así
 * que dos pedidos simultáneos no pueden pasar con el mismo cupo. Las reservas
 * viven en este proceso, que es el único que sirve la API.
 */

/** Lo que se aparta por pedido en curso: algo más de lo que gasta una orden normal (~2 100 tokens). */
export const RESERVA_POR_PEDIDO = 3000;

export interface ReservaIA {
  /** Suma los tokens que informó (o estimó) una llamada al modelo. */
  registrar(tokens: number): void;
  /** Libera la reserva y suma al día lo gastado de verdad. Solo cuenta la primera vez. */
  cerrar(): Promise<void>;
}

/** Lo que necesitan de un cupo quienes llaman al modelo (y sus dobles de prueba). */
export interface CupoDeIA {
  /** `null` si quien pregunta ya no tiene cupo hoy. */
  reservar(usuarioId: string): Promise<ReservaIA | null>;
}

export class CupoIA implements CupoDeIA {
  private readonly reservado = new Map<string, number>();

  constructor(
    private readonly uso: UsoIAStore,
    private readonly limite: number | undefined,
    private readonly reservaPorPedido: number = RESERVA_POR_PEDIDO,
  ) {}

  async reservar(usuarioId: string): Promise<ReservaIA | null> {
    const apartado = this.limite ? this.reservaPorPedido : 0;
    if (this.limite) {
      const gastado = await this.uso.leer(usuarioId, diaDeHoy());
      // Desde aquí hasta apartar la reserva no hay ninguna espera.
      const enCurso = this.reservado.get(usuarioId) ?? 0;
      if (gastado + enCurso >= this.limite) return null;
    }
    this.reservado.set(usuarioId, (this.reservado.get(usuarioId) ?? 0) + apartado);

    let total = 0;
    let cerrada = false;
    return {
      registrar: (tokens) => {
        if (Number.isFinite(tokens) && tokens > 0) total += tokens;
      },
      cerrar: async () => {
        if (cerrada) return;
        cerrada = true;
        const quedan = (this.reservado.get(usuarioId) ?? 0) - apartado;
        if (quedan > 0) this.reservado.set(usuarioId, quedan);
        else this.reservado.delete(usuarioId);
        if (total <= 0) return;
        try {
          await this.uso.sumar(usuarioId, diaDeHoy(), total);
        } catch (error) {
          console.warn('No se pudo registrar el uso de la IA:', (error as Error).message);
        }
      },
    };
  }
}
