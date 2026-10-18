import { memo } from 'react';
import { RELATION_KIND_LABELS, type ClassKind, type RelationKind } from '@app/shared';
import { ICONO_CLASE, ICONO_RELACION, Icono } from './iconos';

/**
 * La paleta.
 *
 * Los seis tipos de relación estaban en un desplegable al lado del botón
 * «Relación». Un desplegable esconde cinco de las seis opciones y, sobre todo,
 * esconde que existan: quien no lo abre no descubre que se pueden dibujar
 * composiciones. Aquí los seis están a la vista y el que está armado se ve
 * hundido, que es la misma información que daba el desplegable pero sin tener
 * que abrirlo para leerla.
 *
 * Cada botón lleva su icono y su palabra. El icono dibuja la notación de UML
 * —rombo hueco la agregación, relleno la composición, triángulo la herencia—,
 * que es la misma que luego aparece en el lienzo: la paleta enseña el símbolo
 * que hay que reconocer en el diagrama en vez de sustituirlo por un adorno. La
 * palabra va igualmente, porque un rombo hueco y uno relleno no se distinguen de
 * memoria y porque sin ella no hay nada que anunciar a un lector de pantalla.
 */

/*
  El icono no se escribe aquí: sale de `ICONO_CLASE` e `ICONO_RELACION`, las
  mismas tablas que usa el panel de propiedades. Repetir la correspondencia en
  cada componente es como se acaba enseñando un rombo hueco en la paleta y uno
  relleno en la ficha de la misma relación.
*/
const ELEMENTOS: { kind: ClassKind; etiqueta: string; ayuda: string }[] = [
  { kind: 'class', etiqueta: 'Clase', ayuda: 'Una tabla del modelo de datos' },
  { kind: 'interface', etiqueta: 'Interfaz', ayuda: 'Contrato sin datos: no genera tabla' },
  { kind: 'abstract', etiqueta: 'Abstracta', ayuda: 'Clase base que no se instancia' },
  { kind: 'enum', etiqueta: 'Enumeración', ayuda: 'Lista cerrada de valores posibles' },
];

const RELACIONES: { kind: RelationKind; ayuda: string }[] = [
  { kind: 'association', ayuda: 'Dos clases que se conocen' },
  { kind: 'aggregation', ayuda: 'La parte puede vivir sin el todo' },
  { kind: 'composition', ayuda: 'La parte muere con el todo' },
  { kind: 'inheritance', ayuda: 'La clase origen extiende a la destino' },
  { kind: 'realization', ayuda: 'La clase origen implementa la interfaz destino' },
  { kind: 'dependency', ayuda: 'La origen usa a la destino sin guardarla' },
];

export interface PaletaProps {
  soloLectura: boolean;
  herramienta: 'seleccion' | 'relacion';
  tipoRelacion: RelationKind;
  /**
   * La herramienta "asociación de clase" está armada. No es un `RelationKind`
   * más: sigue dibujando una asociación normal, pero además crea la clase
   * intermedia y fuerza la relación a muchos a muchos en el mismo gesto (ver
   * `crearRelacionConClaseDeAsociacion` en `EditorDiagrama`), así que se
   * rastrea aparte del tipo de relación en vez de añadir un séptimo `kind`.
   */
  claseAsociacionActiva: boolean;
  onCrear: (kind: ClassKind) => void;
  /** Arma la herramienta de relación con el tipo indicado, o la desarma si ya lo estaba. */
  onArmarRelacion: (kind: RelationKind) => void;
  /** Arma (o desarma) la herramienta de "asociación de clase". */
  onArmarClaseAsociacion: () => void;
  onSeleccionar: () => void;
}

export const Paleta = memo(function Paleta({
  soloLectura,
  herramienta,
  tipoRelacion,
  claseAsociacionActiva,
  onCrear,
  onArmarRelacion,
  onArmarClaseAsociacion,
  onSeleccionar,
}: PaletaProps): JSX.Element {
  return (
    <div className="paleta">
      <button
        type="button"
        className={`paleta__boton${herramienta === 'seleccion' ? ' paleta__boton--activo' : ''}`}
        aria-pressed={herramienta === 'seleccion'}
        onClick={onSeleccionar}
        title="Mover y seleccionar clases (Esc)"
      >
        <Icono nombre="puntero" className="paleta__simbolo" />
        Seleccionar
      </button>

      <h3 className="paleta__titulo">Elementos</h3>
      <div className="paleta__rejilla">
        {ELEMENTOS.map(({ kind, etiqueta, ayuda }) => (
          <button
            key={kind}
            type="button"
            className="paleta__boton"
            data-ia={`addClass:${kind}`}
            disabled={soloLectura}
            onClick={() => onCrear(kind)}
            title={ayuda}
          >
            <Icono nombre={ICONO_CLASE[kind]} className="paleta__simbolo" />
            {etiqueta}
          </button>
        ))}
      </div>

      <h3 className="paleta__titulo">Relaciones</h3>
      <div className="paleta__rejilla">
        {RELACIONES.map(({ kind, ayuda }) => {
          const armada = herramienta === 'relacion' && tipoRelacion === kind;
          return (
            <button
              key={kind}
              type="button"
              className={`paleta__boton${armada ? ' paleta__boton--activo' : ''}`}
              data-ia={`addRelation:${kind}`}
              disabled={soloLectura}
              aria-pressed={armada}
              onClick={() => onArmarRelacion(kind)}
              title={`${ayuda}. Arrastrar de una clase a otra.`}
            >
              <Icono nombre={ICONO_RELACION[kind]} className="paleta__simbolo" />
              {RELATION_KIND_LABELS[kind]}
            </button>
          );
        })}
        <button
          type="button"
          className={`paleta__boton${claseAsociacionActiva ? ' paleta__boton--activo' : ''}`}
          disabled={soloLectura}
          aria-pressed={claseAsociacionActiva}
          onClick={onArmarClaseAsociacion}
          title="Crea una clase intermedia y una relación muchos a muchos de una vez. Arrastrar de una clase a otra."
        >
          <Icono nombre="clase-asociacion" className="paleta__simbolo" />
          Clase de asociación
        </button>
      </div>

      {/* La instrucción vive junto a los botones que la necesitan. Antes estaba
          en el `title` del botón de relación, donde solo la lee quien deja el
          ratón quieto encima —y en un teléfono no la lee nadie. */}
      <p className="paleta__nota">
        {herramienta === 'relacion'
          ? 'Trazado activo: arrastre de una clase a otra.'
          : 'Seleccione una relación y arrastre de una clase a otra.'}
      </p>
    </div>
  );
});
