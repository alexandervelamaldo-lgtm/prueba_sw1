import { useState, useMemo } from 'react';
import { type Aplicar, describeBatchImpact, type ClassDiagram, type Operation } from '@app/shared';
import { nombreDeshacer, useTecladoFisico } from '../hooks/useDispositivo';

/**
 * Tarjeta de propuesta del asistente (RF-IA-04, RF-IA-05, decisión D6).
 *
 * Nace de `Asistente.tsx` y la comparte también `ModoIA.tsx`: las dos vistas
 * muestran lo mismo que el modelo propone y exigen el mismo botón antes de
 * tocar el diagrama, así que el cálculo de qué se pierde y la confirmación de
 * los borrados viven en un solo sitio en vez de en dos copias que un día
 * podrían dejar de coincidir.
 */

export interface Propuesta {
  operacion: Operation;
  descripcion: string;
}

export interface PropuestaOperacionesProps {
  propuestas: Propuesta[];
  diagrama: ClassDiagram;
  origen: string | null;
  aplicar: Aplicar;
  onAplicar: (resultado: { ok: true } | { ok: false; error: string }) => void;
  onDescartar: () => void;
}

export function PropuestaOperaciones({
  propuestas,
  diagrama,
  origen,
  aplicar,
  onAplicar,
  onDescartar,
}: PropuestaOperacionesProps): JSX.Element | null {
  const [confirmando, setConfirmando] = useState(false);
  const hayTeclado = useTecladoFisico();

  /**
   * Qué se pierde si se acepta la propuesta (RF-IA-05).
   *
   * Se calcula sobre el diagrama de verdad y no sobre la lista de operaciones,
   * porque la misma orden destruye cosas distintas según lo que haya: «elimina
   * la clase Pedido» se lleva por delante sus atributos, sus filas de datos y
   * las relaciones que salían de ella, y quien dictó esa frase estaba pensando
   * en una caja del lienzo, no en las tres flechas que la tocan.
   */
  const impacto = useMemo(
    () => describeBatchImpact(diagrama, propuestas.map((p) => p.operacion)),
    [diagrama, propuestas],
  );

  if (propuestas.length === 0) return null;

  const ejecutar = (): void => {
    // `origen` es el motor que interpretó la orden —el modelo remoto o la
    // gramática local—. Va al historial como proponente, separado de quien
    // pulsa este botón, que es quien responde del cambio.
    const resultado = aplicar(
      propuestas.map((p) => p.operacion),
      { origen: 'asistente', ...(origen ? { propuestoPor: origen } : {}) },
    );
    setConfirmando(false);
    if (resultado.ok) {
      onAplicar({ ok: true });
    } else {
      onAplicar({ ok: false, error: resultado.error });
    }
  };

  const aceptarTodo = (): void => {
    // Un «¿seguro?» genérico no es una confirmación: no dice qué se pierde, así
    // que quien lo lee acaba pulsando «Sí» por costumbre. Solo se interpone
    // cuando hay algo concreto que enumerar, para que interponerse signifique
    // algo cuando ocurre.
    if (impacto.destructiva && !confirmando) {
      setConfirmando(true);
      return;
    }
    ejecutar();
  };

  const descartar = (): void => {
    setConfirmando(false);
    onDescartar();
  };

  return (
    <div
      className={`asistente__propuesta${
        impacto.destructiva ? ' asistente__propuesta--destructiva' : ''
      }`}
    >
      <p className="asistente__origen">
        Propuesta de <span className="asistente__origen-badge">{origen}</span>:
      </p>
      <ol>
        {propuestas.map((p, indice) => (
          <li key={indice}>{p.descripcion}</li>
        ))}
      </ol>

      {impacto.destructiva && (
        <div className="asistente__impacto">
          <p>
            <strong>Se va a borrar</strong>, y el diagrama no conserva copia:
          </p>
          <ul>
            {impacto.perdidas.map((perdida, indice) => (
              <li key={indice}>{perdida}</li>
            ))}
          </ul>
          {/* El aparato decide el nombre del gesto: en un teléfono no hay
              Ctrl, y esta frase se lee justo antes de aceptar un borrado. */}
          <p className="asistente__impacto-nota">
            Se puede deshacer con {nombreDeshacer(hayTeclado)} mientras no cierres el proyecto.
          </p>
        </div>
      )}

      <div className="asistente__acciones">
        <button
          type="button"
          className={`boton ${
            impacto.destructiva && confirmando ? 'boton--peligro' : 'boton--primario'
          }`}
          onClick={aceptarTodo}
        >
          {impacto.destructiva && confirmando
            ? 'Sí, borrar'
            : `Aplicar ${propuestas.length === 1 ? 'el cambio' : `los ${propuestas.length} cambios`}`}
        </button>
        <button type="button" className="boton" onClick={descartar}>
          {confirmando ? 'No, cancelar' : 'Descartar'}
        </button>
      </div>
    </div>
  );
}
