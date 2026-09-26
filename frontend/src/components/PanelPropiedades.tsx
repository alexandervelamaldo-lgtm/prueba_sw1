import { useEffect, useState } from 'react';
import {
  type Aplicar,
  IDENTIFIER_TYPES,
  RELATION_KIND_LABELS,
  isToMany,
  listSupportedTypes,
  type ClassDiagram,
  type ClassKind,
  type EntradaLeida,
  type Multiplicity,
  type Operation,
  type RelationKind,
  type UmlClass,
  type UmlRelation,
  type Visibility,
} from '@app/shared';
import { HistorialDeClase } from './HistorialCambios';
import { ICONO_RELACION, Icono } from './iconos';

/**
 * Edición de la clase seleccionada.
 *
 * Todo lo que este panel hace sale en forma de `Operation`. No escribe en el
 * documento ni conoce Yjs: describe la intención y quien la aplica valida. Es la
 * misma vía que usa el asistente de voz, de modo que hay un único sitio donde
 * puede rechazarse un cambio inválido en vez de dos comportamientos que se
 * separan con el tiempo (decisión D6).
 */

export interface PanelPropiedadesProps {
  diagrama: ClassDiagram;
  clase: UmlClass | null;
  soloLectura: boolean;
  /** Para responder «¿quién creó esta clase?» sin salir del panel. */
  historial: EntradaLeida[];
  aplicar: Aplicar;
}

const VISIBILIDADES: { valor: Visibility; etiqueta: string }[] = [
  { valor: '+', etiqueta: '+ pública' },
  { valor: '-', etiqueta: '− privada' },
  { valor: '#', etiqueta: '# protegida' },
  { valor: '~', etiqueta: '~ de paquete' },
];

const TIPOS_CLASE: { valor: ClassKind; etiqueta: string }[] = [
  { valor: 'class', etiqueta: 'Clase' },
  { valor: 'abstract', etiqueta: 'Clase abstracta' },
  { valor: 'interface', etiqueta: 'Interfaz' },
  { valor: 'enum', etiqueta: 'Enumeración' },
];

/**
 * Las multiplicidades que se ofrecen en el desplegable.
 *
 * El modelo admite cualquier `n..m`, pero un desplegable con las cinco de
 * verdad usadas se rellena de un vistazo y no deja escribir `1..0`. Quien
 * necesite `2..5` puede pedirlo por voz, que sí acepta la notación completa.
 */
const MULTIPLICIDADES: { valor: Multiplicity; etiqueta: string }[] = [
  { valor: '1', etiqueta: '1 — exactamente uno' },
  { valor: '0..1', etiqueta: '0..1 — como mucho uno' },
  { valor: '*', etiqueta: '* — muchos (puede ser ninguno)' },
  { valor: '1..*', etiqueta: '1..* — al menos uno' },
];

const TIPOS_RELACION: RelationKind[] = [
  'association',
  'aggregation',
  'composition',
  'inheritance',
  'realization',
  'dependency',
];

/** La herencia no tiene cardinalidad; ponerle multiplicidades no significa nada. */
function tieneCardinalidad(kind: RelationKind): boolean {
  return kind !== 'inheritance' && kind !== 'realization';
}

/**
 * Qué va a generar esta relación, dicho en JPA.
 *
 * Se enseña porque es la única forma de que la multiplicidad deje de parecer
 * decoración del dibujo: es lo que decide si en la base de datos hay una clave
 * ajena o una tabla de unión. La regla es exactamente la del generador
 * (`isToMany` sobre cada extremo), no una aproximación: si divergieran, el panel
 * estaría prometiendo algo que el ZIP no cumple.
 */
export function mapeoJpa(relacion: UmlRelation, diagrama: ClassDiagram): string | null {
  if (!tieneCardinalidad(relacion.kind)) return '@Inheritance / extends';
  const origenMuchos = isToMany(relacion.source.multiplicity);
  const destinoMuchos = isToMany(relacion.target.multiplicity);
  if (origenMuchos && destinoMuchos) {
    if (relacion.associationClassId) {
      const nombre = diagrama.classes[relacion.associationClassId]?.name ?? '?';
      // No hay «tabla de unión» sintética que anunciar: la propia clase de
      // asociación es la tabla, con sus dos claves ajenas y sus atributos.
      return `clase de asociación «${nombre}» (dos @ManyToOne, sin @JoinTable)`;
    }
    return '@ManyToMany (con tabla de unión)';
  }
  if (!origenMuchos && !destinoMuchos) return '@OneToOne (clave ajena)';
  return '@OneToMany / @ManyToOne (clave ajena en el lado «muchos»)';
}

/**
 * Candidatas a colgarse como clase de asociación de una relación N:M.
 *
 * Se excluyen los dos extremos (una clase de asociación no puede ser a la vez
 * uno de los lados de su propia relación —lo rechaza `setAssociationClass`—),
 * las interfaces y enumeraciones (no se generan como tabla) y las clases
 * transitorias (tampoco tienen fila que guardar la clave ajena). Es la misma
 * regla que aplica `validateAssociationClasses`, adelantada aquí para no
 * ofrecer una opción que el servidor va a rechazar de todas formas.
 */
export function clasesElegiblesComoAsociacion(
  diagrama: ClassDiagram,
  relacion: UmlRelation,
): UmlClass[] {
  return Object.values(diagrama.classes).filter(
    (c) =>
      c.id !== relacion.source.classId &&
      c.id !== relacion.target.classId &&
      c.kind !== 'interface' &&
      c.kind !== 'enum' &&
      !c.transient,
  );
}

export function PanelPropiedades({
  diagrama,
  clase,
  soloLectura,
  historial,
  aplicar,
}: PanelPropiedadesProps): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [nuevoAtributo, setNuevoAtributo] = useState({ nombre: '', tipo: 'String' });
  const [nuevoLiteral, setNuevoLiteral] = useState('');

  // El campo del nombre se resincroniza al cambiar de clase, y también cuando
  // otro participante la renombra: si no, quedaría mostrando el nombre viejo y
  // el siguiente cambio local lo restauraría, deshaciendo el del compañero.
  useEffect(() => setNombre(clase?.name ?? ''), [clase?.id, clase?.name]);

  const ejecutar = (operaciones: Operation[]): void => {
    const resultado = aplicar(operaciones);
    setError(resultado.ok ? null : resultado.error);
  };

  if (!clase) {
    return (
      <div className="panel panel--vacio">
        <p className="panel__vacio">Sin selección.</p>
      </div>
    );
  }

  // Los tipos ofrecidos son los del catálogo más las clases del propio diagrama:
  // un atributo puede ser `String` o puede ser otra entidad.
  const tipos = [
    ...listSupportedTypes(),
    ...Object.values(diagrama.classes)
      .map((c) => c.name)
      .filter((n) => n !== clase.name),
  ];

  const deshabilitado = soloLectura;

  const relaciones = Object.values(diagrama.relations).filter(
    (r) => r.source.classId === clase.id || r.target.classId === clase.id,
  );

  /**
   * Cambia un solo campo de la relación.
   *
   * Se manda únicamente lo que se ha tocado, y no la relación entera, porque dos
   * personas pueden estar ajustando extremos distintos de la misma flecha a la
   * vez. Enviar el objeto completo haría que la última en guardar deshiciera el
   * cambio de la otra sin que ninguna se enterase.
   */
  const actualizarRelacion = (
    id: string,
    changes: Extract<Operation, { op: 'updateRelation' }>['changes'],
  ): void => ejecutar([{ op: 'updateRelation', id, changes }]);

  return (
    // El título ya lo pone la cabecera del panel acoplado. Repetirlo aquí dejaba
    // dos «Propiedades» seguidos, y en un lector de pantalla dos encabezados de
    // nivel 2 anidados que anuncian lo mismo.
    <div className="panel">
      {error && <p className="panel__error">{error}</p>}

      <label className="campo">
        <span>Nombre</span>
        <input
          value={nombre}
          disabled={deshabilitado}
          onChange={(e) => setNombre(e.target.value)}
          onBlur={() => {
            if (nombre.trim() && nombre !== clase.name) {
              ejecutar([{ op: 'renameClass', ref: { id: clase.id }, name: nombre.trim() }]);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setNombre(clase.name);
          }}
        />
      </label>

      <label className="campo">
        <span>Tipo</span>
        <select
          value={clase.kind}
          disabled={deshabilitado}
          onChange={(e) =>
            ejecutar([
              { op: 'setClassKind', ref: { id: clase.id }, kind: e.target.value as ClassKind },
            ])
          }
        >
          {TIPOS_CLASE.map((t) => (
            <option key={t.valor} value={t.valor}>
              {t.etiqueta}
            </option>
          ))}
        </select>
      </label>

      {clase.kind === 'enum' ? (
        <section className="panel__seccion">
          <h3>Literales</h3>
          <ul className="lista">
            {clase.literals.map((literal) => (
              <li key={literal} className="lista__fila">
                <code>{literal}</code>
              </li>
            ))}
            {clase.literals.length === 0 && <li className="lista__vacia">Sin literales</li>}
          </ul>
          <form
            className="fila-formulario"
            onSubmit={(e) => {
              e.preventDefault();
              if (!nuevoLiteral.trim()) return;
              ejecutar([
                { op: 'addEnumLiteral', classRef: { id: clase.id }, literal: nuevoLiteral.trim() },
              ]);
              setNuevoLiteral('');
            }}
          >
            <input
              placeholder="PENDIENTE"
              value={nuevoLiteral}
              disabled={deshabilitado}
              onChange={(e) => setNuevoLiteral(e.target.value)}
            />
            <button type="submit" disabled={deshabilitado}>
              Añadir
            </button>
          </form>
        </section>
      ) : (
        <section className="panel__seccion">
          <h3>Atributos</h3>
          <ul className="lista">
            {clase.attributes.map((atributo) => (
              <li key={atributo.id} className="lista__fila lista__fila--atributo">
                <select
                  className="mini"
                  value={atributo.visibility}
                  disabled={deshabilitado}
                  onChange={(e) =>
                    ejecutar([
                      {
                        op: 'updateAttribute',
                        classRef: { id: clase.id },
                        attributeName: atributo.name,
                        changes: { visibility: e.target.value as Visibility },
                      },
                    ])
                  }
                >
                  {VISIBILIDADES.map((v) => (
                    <option key={v.valor} value={v.valor}>
                      {v.valor}
                    </option>
                  ))}
                </select>

                <span className="lista__nombre">{atributo.name}</span>

                <select
                  className="mini"
                  value={atributo.type.name}
                  disabled={deshabilitado}
                  onChange={(e) =>
                    ejecutar([
                      {
                        op: 'updateAttribute',
                        classRef: { id: clase.id },
                        attributeName: atributo.name,
                        changes: { type: e.target.value },
                      },
                    ])
                  }
                >
                  {tipos.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className={`marca${atributo.isIdentifier ? ' marca--activa' : ''}`}
                  disabled={deshabilitado || !IDENTIFIER_TYPES.includes(atributo.type.name as never)}
                  title={
                    IDENTIFIER_TYPES.includes(atributo.type.name as never)
                      ? 'Marcar como clave primaria'
                      : `Una clave primaria debe ser ${IDENTIFIER_TYPES.join(', ')}`
                  }
                  onClick={() =>
                    ejecutar([
                      {
                        op: 'updateAttribute',
                        classRef: { id: clase.id },
                        attributeName: atributo.name,
                        changes: { isIdentifier: !atributo.isIdentifier },
                      },
                    ])
                  }
                >
                  <Icono nombre="llave" />
                </button>

                <button
                  type="button"
                  className="marca marca--borrar"
                  disabled={deshabilitado}
                  title="Eliminar atributo"
                  onClick={() =>
                    ejecutar([
                      {
                        op: 'removeAttribute',
                        classRef: { id: clase.id },
                        attributeName: atributo.name,
                      },
                    ])
                  }
                >
                  <Icono nombre="cerrar" />
                </button>
              </li>
            ))}
            {clase.attributes.length === 0 && <li className="lista__vacia">Sin atributos</li>}
          </ul>

          <form
            className="fila-formulario"
            onSubmit={(e) => {
              e.preventDefault();
              if (!nuevoAtributo.nombre.trim()) return;
              ejecutar([
                {
                  op: 'addAttribute',
                  classRef: { id: clase.id },
                  name: nuevoAtributo.nombre.trim(),
                  type: nuevoAtributo.tipo,
                  visibility: '-',
                  isIdentifier: false,
                  isNullable: true,
                  isUnique: false,
                },
              ]);
              setNuevoAtributo({ nombre: '', tipo: nuevoAtributo.tipo });
            }}
          >
            <input
              placeholder="nombre"
              value={nuevoAtributo.nombre}
              disabled={deshabilitado}
              onChange={(e) => setNuevoAtributo({ ...nuevoAtributo, nombre: e.target.value })}
            />
            <select
              value={nuevoAtributo.tipo}
              disabled={deshabilitado}
              onChange={(e) => setNuevoAtributo({ ...nuevoAtributo, tipo: e.target.value })}
            >
              {tipos.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button type="submit" disabled={deshabilitado}>
              Añadir
            </button>
          </form>
        </section>
      )}

      <section className="panel__seccion">
        <h3>Relaciones</h3>
        <ul className="relaciones">
          {relaciones.map((relacion) => {
            // La relación tiene una dirección fija (origen → destino) que no
            // depende de qué clase esté seleccionada. Se pinta siempre en ese
            // orden, aunque la seleccionada sea la de la derecha: invertirla
            // para que «la mía» quede primero haría que la misma relación se
            // leyera al revés según dónde hubieras hecho clic, y la dirección
            // es justo lo que decide dónde cae la clave ajena.
            const origen = diagrama.classes[relacion.source.classId];
            const destino = diagrama.classes[relacion.target.classId];
            const cardinalidad = tieneCardinalidad(relacion.kind);

            const modificar = (
              changes: Parameters<typeof actualizarRelacion>[1],
            ): void => actualizarRelacion(relacion.id, changes);

            return (
              <li key={relacion.id} className="relacion">
                <div className="relacion__cabecera">
                  <select
                    className="mini"
                    value={relacion.kind}
                    disabled={deshabilitado}
                    onChange={(e) => modificar({ kind: e.target.value as RelationKind })}
                  >
                    {TIPOS_RELACION.map((kind) => (
                      <option key={kind} value={kind}>
                        {RELATION_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="marca marca--borrar"
                    disabled={deshabilitado}
                    title="Eliminar la relación"
                    onClick={() => ejecutar([{ op: 'removeRelation', id: relacion.id }])}
                  >
                    <Icono nombre="cerrar" />
                  </button>
                </div>

                <div className="relacion__extremos">
                  <span
                    className={`relacion__clase${
                      origen?.id === clase.id ? ' relacion__clase--actual' : ''
                    }`}
                  >
                    {origen?.name ?? '?'}
                  </span>

                  {cardinalidad ? (
                    <>
                      <select
                        className="mini"
                        value={relacion.source.multiplicity}
                        disabled={deshabilitado}
                        aria-label={`Cuántos ${origen?.name ?? ''}`}
                        onChange={(e) => modificar({ sourceMultiplicity: e.target.value })}
                      >
                        {MULTIPLICIDADES.map((m) => (
                          <option key={m.valor} value={m.valor}>
                            {m.valor}
                          </option>
                        ))}
                      </select>
                      {/* Entre las dos multiplicidades va el símbolo de la
                          relación, el mismo que la dibuja en el lienzo y el
                          mismo que tiene su botón en la paleta. */}
                      <Icono nombre={ICONO_RELACION[relacion.kind]} className="relacion__flecha" />
                      <select
                        className="mini"
                        value={relacion.target.multiplicity}
                        disabled={deshabilitado}
                        aria-label={`Cuántos ${destino?.name ?? ''}`}
                        onChange={(e) => modificar({ targetMultiplicity: e.target.value })}
                      >
                        {MULTIPLICIDADES.map((m) => (
                          <option key={m.valor} value={m.valor}>
                            {m.valor}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <Icono nombre={ICONO_RELACION[relacion.kind]} className="relacion__flecha" />
                  )}

                  <span
                    className={`relacion__clase${
                      destino?.id === clase.id ? ' relacion__clase--actual' : ''
                    }`}
                  >
                    {destino?.name ?? '?'}
                  </span>
                </div>

                {cardinalidad && (
                  <p className="relacion__lectura">
                    Un <strong>{origen?.name}</strong> tiene{' '}
                    {isToMany(relacion.target.multiplicity)
                      ? `muchos ${destino?.name ?? ''}`
                      : `un ${destino?.name ?? ''}`}
                    ; un <strong>{destino?.name}</strong> tiene{' '}
                    {isToMany(relacion.source.multiplicity)
                      ? `muchos ${origen?.name ?? ''}`
                      : `un ${origen?.name ?? ''}`}
                    .
                  </p>
                )}

                {/* Solo tiene sentido sobre una N:M real: sobre cualquier otra
                    cardinalidad la clase del lado «muchos» ya guarda esos
                    mismos datos en su propia fila. */}
                {relacion.kind === 'association' &&
                  isToMany(relacion.source.multiplicity) &&
                  isToMany(relacion.target.multiplicity) && (
                    <label className="campo campo--asociacion">
                      <span>Clase de asociación</span>
                      <select
                        className="mini"
                        value={relacion.associationClassId ?? ''}
                        disabled={deshabilitado}
                        onChange={(e) =>
                          ejecutar([
                            {
                              op: 'setAssociationClass',
                              relationId: relacion.id,
                              classRef: e.target.value ? { id: e.target.value } : null,
                            },
                          ])
                        }
                      >
                        <option value="">(ninguna — tabla de unión automática)</option>
                        {clasesElegiblesComoAsociacion(diagrama, relacion).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                <p className="relacion__mapeo">
                  <code>{mapeoJpa(relacion, diagrama)}</code>
                </p>
              </li>
            );
          })}
          {relaciones.length === 0 && (
            <li className="lista__vacia">Sin relaciones</li>
          )}
        </ul>
      </section>

      <HistorialDeClase historial={historial} classId={clase.id} />

      <button
        type="button"
        className="boton boton--peligro"
        disabled={deshabilitado}
        onClick={() => {
          // Se confirma porque borrar una clase se lleva por delante sus
          // relaciones, y eso no se ve venir mirando solo la caja seleccionada.
          if (confirm(`¿Eliminar la clase «${clase.name}» y sus relaciones?`)) {
            ejecutar([{ op: 'removeClass', ref: { id: clase.id } }]);
          }
        }}
      >
        Eliminar clase
      </button>
    </div>
  );
}
