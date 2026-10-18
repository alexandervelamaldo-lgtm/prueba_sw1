import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listClasses,
  listRelations,
  type ClassDiagram,
  type UmlClass,
  type UmlRelation,
} from '@app/shared';
import type { Participante } from '../hooks/usePresencia';
import {
  ALTO_CABECERA,
  ALTO_FILA,
  ANCHO_MINIMO,
  PADDING,
  ampliar,
  anclaje,
  cajaDe,
  desviosPorPar,
  encuadrar,
  etiquetaClase,
  limitarEscala,
  medidasDe,
  puntoEnCurva,
  recortar,
  textoAtributo,
  textoMetodo,
  type Medida,
} from './geometria-lienzo';

/**
 * El lienzo del diagrama.
 *
 * Se dibuja con SVG y no con `<canvas>`. La razón no es estética: cada clase es
 * un elemento del DOM, así que la selección, el foco del teclado y los lectores
 * de pantalla funcionan sin que haya que reimplementarlos, y arrastrar es
 * cuestión de escuchar eventos sobre el elemento en vez de hacer detección de
 * colisiones a mano. Un `<canvas>` compensaría a partir de unos cientos de
 * elementos; un diagrama de clases que quepa en la cabeza de alguien tiene
 * decenas.
 *
 * Ese argumento estuvo cojo un tiempo: las cajas eran elementos del DOM, sí,
 * pero sin `tabindex`, así que el foco del teclado no llegaba a ellas y con el
 * teclado solo no se podía ni seleccionar una clase ni moverla. Ahora cada caja
 * se enfoca, se anuncia y se desplaza con las flechas.
 *
 * Las cuentas —cuánto mide una caja, por dónde sale una flecha, cuánto se
 * separan dos relaciones entre el mismo par— están en `geometria-lienzo.ts`,
 * que no depende de React y sí tiene pruebas.
 */

/**
 * Una orden de encuadre venida de fuera del lienzo.
 *
 * Lleva un número de serie porque lo que se pide es una acción, no un estado:
 * pulsar «Ajustar» dos veces seguidas tiene que encuadrar dos veces, y con un
 * objeto que dijera solo `{ tipo: 'ajustar' }` la segunda pulsación sería un
 * valor idéntico al anterior y no dispararía nada.
 */
export type OrdenVista =
  | { n: number; tipo: 'acercar' | 'alejar' | 'ajustar' }
  | { n: number; tipo: 'centrar'; ids: string[] };

export interface LienzoProps {
  diagrama: ClassDiagram;
  seleccion: string | null;
  participantes: Participante[];
  soloLectura: boolean;
  onSeleccionar: (id: string | null) => void;
  onMover: (id: string, x: number, y: number) => void;
  onCursor: (punto: { x: number; y: number } | null) => void;
  /** Se llama al soltar una clase sobre otra con la herramienta de relación. */
  onRelacionar: (origenId: string, destinoId: string) => void;
  /** Herramienta activa: mover clases o trazar relaciones. */
  herramienta: 'seleccion' | 'relacion';
  /** Encuadres pedidos desde la barra de estado o el árbol del proyecto. */
  orden?: OrdenVista | null;
  /** Avisa del aumento actual para que la barra de estado lo muestre. */
  onEscala?: (escala: number) => void;
  /** Lo que se perdería si se acepta un borrado propuesto (vista previa fantasma del Modo IA). */
  aBorrar?: { clases: string[]; relaciones: string[] } | null;
}

export function Lienzo({
  diagrama,
  seleccion,
  participantes,
  soloLectura,
  onSeleccionar,
  onMover,
  onCursor,
  onRelacionar,
  herramienta,
  orden,
  onEscala,
}: LienzoProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [vista, setVista] = useState({ x: 0, y: 0, escala: 1 });
  const arrastre = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [trazando, setTrazando] = useState<{ origenId: string; x: number; y: number } | null>(null);
  const paneo = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  /*
    El tamaño del lienzo, en estado y no leído del DOM al vuelo.

    Antes esto era `svgRef.current?.clientWidth ?? 1200` calculado en pleno
    render, y tenía un fallo que solo se ve fuera de un portátil quieto: nada
    provoca un render cuando el elemento cambia de tamaño. Al girar el móvil, al
    abrir el panel de propiedades —que en pantalla estrecha le quita la mitad de
    la altura— o al cambiar el navegador de ventana, el `viewBox` se quedaba con
    las medidas de antes y el diagrama salía estirado o aplastado hasta que otra
    cosa cualquiera obligaba a repintar.
  */
  const [medidaLienzo, setMedidaLienzo] = useState({ ancho: 1200, alto: 800 });
  const punteros = useRef(new Map<number, { x: number; y: number }>());
  const pellizco = useRef<{
    distancia: number;
    escala: number;
    /** Punto del diagrama que debe quedarse bajo los dos dedos. */
    ancla: { x: number; y: number };
  } | null>(null);

  const clases = listClasses(diagrama);
  const relaciones = listRelations(diagrama);
  const medidas = new Map(clases.map((c) => [c.id, medidasDe(c)]));
  const desvios = desviosPorPar(relaciones);

  /** Coordenadas del diagrama a partir de las del puntero. */
  const puntoDiagrama = useCallback(
    (evento: { clientX: number; clientY: number }): { x: number; y: number } => {
      const caja = svgRef.current?.getBoundingClientRect();
      if (!caja) return { x: 0, y: 0 };
      return {
        x: (evento.clientX - caja.left) / vista.escala + vista.x,
        y: (evento.clientY - caja.top) / vista.escala + vista.y,
      };
    },
    [vista],
  );

  const alMoverPuntero = useCallback(
    (evento: React.PointerEvent): void => {
      // Con dos dedos manda el pellizco, que se lleva más abajo con escuchadores
      // nativos. Si además corriera esto, el diagrama se movería a la vez que se
      // amplía y el resultado sería incontrolable.
      if (pellizco.current) return;

      const punto = puntoDiagrama(evento);
      onCursor(punto);

      if (paneo.current) {
        const factor = 1 / vista.escala;
        setVista((v) => ({
          ...v,
          x: paneo.current!.vx - (evento.clientX - paneo.current!.x) * factor,
          y: paneo.current!.vy - (evento.clientY - paneo.current!.y) * factor,
        }));
        return;
      }

      if (trazando) {
        setTrazando({ ...trazando, x: punto.x, y: punto.y });
        return;
      }

      if (arrastre.current && !soloLectura) {
        onMover(
          arrastre.current.id,
          Math.round(punto.x - arrastre.current.dx),
          Math.round(punto.y - arrastre.current.dy),
        );
      }
    },
    [puntoDiagrama, onCursor, onMover, soloLectura, trazando, vista.escala],
  );

  const alSoltar = useCallback((): void => {
    arrastre.current = null;
    paneo.current = null;
    setTrazando(null);
  }, []);

  /** Distancia entre los dos primeros dedos y su punto medio en la pantalla. */
  const dosDedos = (): { distancia: number; medio: { x: number; y: number } } | null => {
    const [a, b] = [...punteros.current.values()];
    if (!a || !b) return null;
    return {
      distancia: Math.hypot(b.x - a.x, b.y - a.y),
      medio: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  // El zoom con rueda se registra a mano porque React lo suscribe de forma
  // pasiva y entonces `preventDefault` no surte efecto: la página entera haría
  // scroll al intentar acercar el diagrama.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const alRodar = (evento: WheelEvent): void => {
      evento.preventDefault();
      const caja = svg.getBoundingClientRect();
      const raton = {
        x: (evento.clientX - caja.left) / vista.escala + vista.x,
        y: (evento.clientY - caja.top) / vista.escala + vista.y,
      };
      const factor = evento.deltaY < 0 ? 1.12 : 1 / 1.12;
      const escala = limitarEscala(vista.escala * factor);
      // Se recoloca la vista para que el punto bajo el cursor no se mueva: si no,
      // acercarse desplaza el diagrama y hay que recolocarlo a mano cada vez.
      setVista({
        escala,
        x: raton.x - (evento.clientX - caja.left) / escala,
        y: raton.y - (evento.clientY - caja.top) / escala,
      });
    };

    svg.addEventListener('wheel', alRodar, { passive: false });
    return () => svg.removeEventListener('wheel', alRodar);
  }, [vista]);

  /*
    Ampliar con dos dedos.

    En un móvil no hay rueda, y el lienzo lleva `touch-action: none` para poder
    arrastrar clases sin que la página haga scroll: eso también apaga el zoom del
    navegador. Sin esto, un diagrama de diez clases no cabe en la pantalla de un
    teléfono y no hay ninguna forma de alejarlo.

    Va con escuchadores nativos y en fase de captura, no con los `onPointer…` de
    React, por un motivo concreto: `Caja` llama a `stopPropagation` al recibir un
    dedo, así que el segundo dedo, si cae encima de una clase —que es justo lo
    que pasa cuando se quiere ampliar una clase— nunca llegaría a contarse. La
    captura ocurre antes de que nadie pueda pararla.
  */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const alBajar = (evento: PointerEvent): void => {
      punteros.current.set(evento.pointerId, { x: evento.clientX, y: evento.clientY });
      if (punteros.current.size !== 2) return;
      const dos = dosDedos();
      if (!dos) return;

      // Un pellizco cancela lo que hubiera empezado el primer dedo: si no, la
      // clase que se tocó primero viajaría por el lienzo mientras se amplía.
      arrastre.current = null;
      paneo.current = null;
      setTrazando(null);

      const caja = svg.getBoundingClientRect();
      pellizco.current = {
        distancia: dos.distancia,
        escala: vista.escala,
        ancla: {
          x: (dos.medio.x - caja.left) / vista.escala + vista.x,
          y: (dos.medio.y - caja.top) / vista.escala + vista.y,
        },
      };
    };

    const alMover = (evento: PointerEvent): void => {
      if (!punteros.current.has(evento.pointerId)) return;
      punteros.current.set(evento.pointerId, { x: evento.clientX, y: evento.clientY });

      const inicio = pellizco.current;
      if (!inicio || punteros.current.size < 2) return;
      const dos = dosDedos();
      if (!dos || dos.distancia === 0) return;
      evento.preventDefault();

      const escala = limitarEscala((inicio.escala * dos.distancia) / inicio.distancia);
      const caja = svg.getBoundingClientRect();
      // El mismo ajuste que en la rueda: el punto que está entre los dedos se
      // queda entre los dedos, así que se amplía lo que se está mirando.
      setVista({
        escala,
        x: inicio.ancla.x - (dos.medio.x - caja.left) / escala,
        y: inicio.ancla.y - (dos.medio.y - caja.top) / escala,
      });
    };

    const alLevantar = (evento: PointerEvent): void => {
      punteros.current.delete(evento.pointerId);
      // Al levantar un dedo no se reanuda el arrastre con el que queda: quedarían
      // el zoom y un desplazamiento pegados en el mismo gesto, con un salto en
      // medio. Se espera a que se vuelva a tocar.
      if (punteros.current.size < 2) pellizco.current = null;
    };

    const opciones = { capture: true, passive: false } as const;
    svg.addEventListener('pointerdown', alBajar, opciones);
    svg.addEventListener('pointermove', alMover, opciones);
    svg.addEventListener('pointerup', alLevantar, opciones);
    svg.addEventListener('pointercancel', alLevantar, opciones);
    return () => {
      svg.removeEventListener('pointerdown', alBajar, opciones);
      svg.removeEventListener('pointermove', alMover, opciones);
      svg.removeEventListener('pointerup', alLevantar, opciones);
      svg.removeEventListener('pointercancel', alLevantar, opciones);
    };
  }, [vista]);

  /*
    Encuadres pedidos desde fuera.

    El número de serie se compara con el último atendido en vez de dejar que las
    dependencias del efecto decidan: `clases` es un array nuevo en cada
    repintado, así que el efecto se vuelve a ejecutar constantemente y sin esta
    guarda cada movimiento de un cursor ajeno reencuadraría el lienzo.
  */
  const ultimaOrden = useRef(0);
  useEffect(() => {
    if (!orden || orden.n === ultimaOrden.current) return;
    ultimaOrden.current = orden.n;

    const ventana = { ancho: medidaLienzo.ancho, alto: medidaLienzo.alto };
    setVista((actual) => {
      if (orden.tipo === 'acercar') return ampliar(actual, ventana, 1.25);
      if (orden.tipo === 'alejar') return ampliar(actual, ventana, 1 / 1.25);
      const objetivo =
        orden.tipo === 'centrar' ? clases.filter((c) => orden.ids.includes(c.id)) : clases;
      return encuadrar(objetivo.map(cajaDe), ventana, {
        ajustar: orden.tipo === 'ajustar',
        escala: actual.escala,
      });
    });
  }, [orden, medidaLienzo, clases]);

  // La barra de estado enseña el aumento, y el aumento lo cambian cuatro cosas
  // —la rueda, el pellizco, los botones y el encuadre—. Se avisa desde el único
  // sitio por el que pasan las cuatro.
  useEffect(() => {
    onEscala?.(vista.escala);
  }, [vista.escala, onEscala]);

  // El tamaño real del elemento, observado. Ver el comentario de `medidaLienzo`.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const observador = new ResizeObserver((entradas) => {
      const caja = entradas[0]?.contentRect;
      if (!caja || caja.width === 0 || caja.height === 0) return;
      setMedidaLienzo({ ancho: Math.round(caja.width), alto: Math.round(caja.height) });
    });
    observador.observe(svg);
    return () => observador.disconnect();
  }, []);

  const { ancho, alto } = medidaLienzo;

  return (
    <svg
      ref={svgRef}
      className="lienzo"
      viewBox={`${vista.x} ${vista.y} ${ancho / vista.escala} ${alto / vista.escala}`}
      onPointerMove={alMoverPuntero}
      onPointerUp={alSoltar}
      onPointerLeave={() => {
        alSoltar();
        onCursor(null);
      }}
      onPointerCancel={alSoltar}
      onPointerDown={(evento) => {
        if (pellizco.current) return;
        if (evento.target === svgRef.current) {
          onSeleccionar(null);
          paneo.current = { x: evento.clientX, y: evento.clientY, vx: vista.x, vy: vista.y };
        }
      }}
    >
      <defs>
        <pattern id="rejilla" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="var(--borde)" strokeWidth="0.75" strokeOpacity="0.35" />
          <circle cx="24" cy="24" r="0.8" fill="var(--borde)" opacity="0.6" />
        </pattern>
        <marker id="flecha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--texto-2)" />
        </marker>
        <marker id="herencia" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse">
          <path d="M0 0L11 6L0 12z" fill="var(--fondo)" stroke="var(--texto-2)" strokeWidth="1.5" />
        </marker>
        <marker id="rombo" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="12" markerHeight="10" orient="auto-start-reverse">
          <path d="M0 5L7 0L14 5L7 10z" fill="var(--fondo)" stroke="var(--texto-2)" strokeWidth="1.5" />
        </marker>
        <marker id="rombo-lleno" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="12" markerHeight="10" orient="auto-start-reverse">
          <path d="M0 5L7 0L14 5L7 10z" fill="var(--texto-2)" />
        </marker>
      </defs>

      <rect
        x={vista.x}
        y={vista.y}
        width={ancho / vista.escala}
        height={alto / vista.escala}
        fill="url(#rejilla)"
      />

      {/* Relaciones debajo de las clases: si fueran encima, las líneas
          cruzarían por delante de los nombres y los harían ilegibles. */}
      <g className="relaciones">
        {relaciones.map((relacion) => (
          <Relacion
            key={relacion.id}
            relacion={relacion}
            diagrama={diagrama}
            medidas={medidas}
            desvio={desvios.get(relacion.id) ?? 0}
          />
        ))}
      </g>

      {trazando && (
        <TrazoEnCurso
          origen={diagrama.classes[trazando.origenId]}
          medidas={medidas}
          hacia={{ x: trazando.x, y: trazando.y }}
        />
      )}

      <g className="clases">
        {clases.map((cls) => {
          const medida = medidas.get(cls.id) ?? { ancho: ANCHO_MINIMO, alto: 80 };
          const marcadoPor = participantes.find((p) => p.seleccion === cls.id);
          return (
            <Caja
              key={cls.id}
              cls={cls}
              medida={medida}
              seleccionada={cls.id === seleccion}
              soloLectura={soloLectura}
              onDesplazar={(dx, dy) =>
                onMover(cls.id, cls.position.x + dx, cls.position.y + dy)
              }
              onEnfocar={() => onSeleccionar(cls.id)}
              colorAjeno={marcadoPor?.color ?? null}
              nombreAjeno={marcadoPor?.nombre ?? null}
              onPointerDown={(evento) => {
                evento.stopPropagation();
                // El segundo dedo de un pellizco suele caer sobre una clase.
                // Sin esto la seleccionaría y se la llevaría por delante.
                if (pellizco.current) return;
                onSeleccionar(cls.id);
                if (herramienta === 'relacion') {
                  const punto = puntoDiagrama(evento);
                  setTrazando({ origenId: cls.id, x: punto.x, y: punto.y });
                  return;
                }
                if (soloLectura) return;
                const punto = puntoDiagrama(evento);
                arrastre.current = {
                  id: cls.id,
                  dx: punto.x - cls.position.x,
                  dy: punto.y - cls.position.y,
                };
              }}
              onPointerUp={() => {
                if (trazando && trazando.origenId !== cls.id) {
                  onRelacionar(trazando.origenId, cls.id);
                }
                setTrazando(null);
              }}
            />
          );
        })}
      </g>

      <g className="cursores">
        {participantes.map((p) =>
          p.cursor ? (
            <g key={p.clientId} transform={`translate(${p.cursor.x} ${p.cursor.y})`}>
              <path d="M0 0L0 14L4 11L7 17L10 15L7 9L12 9z" fill={p.color} stroke="var(--fondo)" strokeWidth="1" />
              <rect
                x="12"
                y="10"
                width={Math.max(34, p.nombre.length * 7 + 10)}
                height="18"
                rx="3"
                fill={p.color}
              />
              <text
                x="17"
                y="23"
                fill="var(--sobre-acento)"
                fontSize="11"
                fontWeight="600"
                className="etiqueta-cursor"
              >
                {p.nombre}
              </text>
            </g>
          ) : null,
        )}
      </g>
    </svg>
  );
}

/**
 * Cuánto se mueve una clase por pulsación de flecha.
 *
 * Diez es el paso de la rejilla del fondo, así que colocar con el teclado deja
 * las cajas alineadas entre sí sin tener que apuntar. Con Shift se baja a uno
 * para el ajuste fino.
 */
const PASO_TECLADO = 10;

function Caja({
  cls,
  medida,
  seleccionada,
  soloLectura,
  colorAjeno,
  nombreAjeno,
  onDesplazar,
  onEnfocar,
  onPointerDown,
  onPointerUp,
}: {
  cls: UmlClass;
  medida: Medida;
  seleccionada: boolean;
  soloLectura: boolean;
  colorAjeno: string | null;
  nombreAjeno: string | null;
  onDesplazar: (dx: number, dy: number) => void;
  onEnfocar: () => void;
  onPointerDown: (evento: React.PointerEvent) => void;
  onPointerUp: () => void;
}): JSX.Element {
  const etiqueta = etiquetaClase(cls);
  const { ancho, alto } = medida;
  const separador = ALTO_CABECERA + cls.attributes.length * ALTO_FILA + 3;

  /**
   * Descripción para quien no ve el dibujo.
   *
   * El diagrama vive en un SVG precisamente para que cada clase sea un elemento
   * del DOM al que se pueda llegar tabulando; faltaba que ese elemento dijera
   * algo al llegar. Sin esto, un lector de pantalla anuncia «gráfico» y punto.
   */
  const descripcion = [
    etiqueta ? `${etiqueta.replaceAll('«', '').replaceAll('»', '')} ${cls.name}` : `Clase ${cls.name}`,
    cls.attributes.length > 0 && `${cls.attributes.length} atributos`,
    cls.methods.length > 0 && `${cls.methods.length} métodos`,
  ]
    .filter(Boolean)
    .join(', ');

  const alTeclear = (evento: React.KeyboardEvent<SVGGElement>): void => {
    const paso = evento.shiftKey ? 1 : PASO_TECLADO;
    const movimientos: Record<string, [number, number]> = {
      ArrowLeft: [-paso, 0],
      ArrowRight: [paso, 0],
      ArrowUp: [0, -paso],
      ArrowDown: [0, paso],
    };
    const movimiento = movimientos[evento.key];
    if (!movimiento || soloLectura) return;
    // Se para la propagación para que las flechas muevan la clase enfocada y no
    // hagan además scroll de la página por debajo.
    evento.preventDefault();
    evento.stopPropagation();
    onDesplazar(movimiento[0], movimiento[1]);
  };

  return (
    <g
      transform={`translate(${cls.position.x} ${cls.position.y})`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onKeyDown={alTeclear}
      // Llegar tabulando a una clase la selecciona, igual que pincharla: si no,
      // el panel lateral seguiría enseñando otra y se editaría la equivocada.
      onFocus={onEnfocar}
      tabIndex={0}
      role="button"
      aria-label={descripcion}
      aria-pressed={seleccionada}
      className={`caja${seleccionada ? ' caja--activa' : ''}`}
    >
      <rect
        width={ancho}
        height={alto}
        rx="6"
        className="caja__fondo"
        stroke={colorAjeno ?? (seleccionada ? 'var(--acento)' : 'var(--borde)')}
        strokeWidth={colorAjeno || seleccionada ? 2 : 1}
      />
      {etiqueta && (
        <text x={ancho / 2} y="14" textAnchor="middle" className="caja__estereotipo">
          {etiqueta}
        </text>
      )}
      <text
        x={ancho / 2}
        y={etiqueta ? 28 : 22}
        textAnchor="middle"
        className={`caja__nombre${cls.kind === 'abstract' ? ' caja__nombre--abstracta' : ''}`}
      >
        {recortar(cls.name, ancho)}
      </text>
      <line x1="0" y1={ALTO_CABECERA} x2={ancho} y2={ALTO_CABECERA} className="caja__linea" />

      {cls.attributes.map((atributo, indice) => (
        <text
          key={atributo.name}
          x={PADDING}
          y={ALTO_CABECERA + (indice + 1) * ALTO_FILA - 5}
          className="caja__miembro"
        >
          {recortar(textoAtributo(atributo), ancho)}
        </text>
      ))}

      {cls.methods.length > 0 && (
        <line x1="0" y1={separador} x2={ancho} y2={separador} className="caja__linea" />
      )}

      {cls.methods.map((metodo, indice) => (
        <text
          key={metodo.name}
          x={PADDING}
          y={ALTO_CABECERA + (cls.attributes.length + indice + 1) * ALTO_FILA + 4}
          className="caja__miembro caja__miembro--metodo"
        >
          {recortar(textoMetodo(metodo), ancho)}
        </text>
      ))}

      {nombreAjeno && (
        <text x={ancho - 4} y="-6" textAnchor="end" fontSize="10" fill={colorAjeno ?? 'var(--texto-2)'}>
          {nombreAjeno}
        </text>
      )}
    </g>
  );
}

/** Estilo de trazo y punta de flecha según el tipo de relación UML. */
function estiloRelacion(kind: UmlRelation['kind']): {
  marcadorFin?: string;
  marcadorInicio?: string;
  discontinua: boolean;
} {
  switch (kind) {
    case 'inheritance':
      return { marcadorFin: 'url(#herencia)', discontinua: false };
    case 'realization':
      return { marcadorFin: 'url(#herencia)', discontinua: true };
    case 'composition':
      return { marcadorInicio: 'url(#rombo-lleno)', discontinua: false };
    case 'aggregation':
      return { marcadorInicio: 'url(#rombo)', discontinua: false };
    case 'dependency':
      return { marcadorFin: 'url(#flecha)', discontinua: true };
    default:
      return { discontinua: false };
  }
}

/** Cuánto se abre el abanico entre relaciones que unen el mismo par. */
const SEPARACION_ABANICO = 34;

function Relacion({
  relacion,
  diagrama,
  medidas,
  desvio,
}: {
  relacion: UmlRelation;
  diagrama: ClassDiagram;
  medidas: Map<string, Medida>;
  desvio: number;
}): JSX.Element | null {
  const origen = diagrama.classes[relacion.source.classId];
  const destino = diagrama.classes[relacion.target.classId];
  // Una relación puede sobrevivir un instante a la clase que une, si el borrado
  // llega antes por el socket. Dibujar la mitad que queda daría una línea que
  // sale de la nada.
  if (!origen || !destino) return null;

  const porDefecto: Medida = { ancho: ANCHO_MINIMO, alto: 80 };
  const medidaOrigen = medidas.get(origen.id) ?? porDefecto;
  const medidaDestino = medidas.get(destino.id) ?? porDefecto;
  const estilo = estiloRelacion(relacion.kind);

  const trazo = (
    d: string,
    etiquetas: { origen: { x: number; y: number }; destino: { x: number; y: number }; centro: { x: number; y: number } },
  ): JSX.Element => (
    <g className="relacion">
      <path
        d={d}
        fill="none"
        stroke="var(--texto-2)"
        strokeWidth="1.5"
        strokeDasharray={estilo.discontinua ? '6 4' : undefined}
        markerEnd={estilo.marcadorFin}
        markerStart={estilo.marcadorInicio}
      />
      {relacion.name && (
        <text x={etiquetas.centro.x} y={etiquetas.centro.y} className="relacion__etiqueta">
          {relacion.name}
        </text>
      )}
      <text x={etiquetas.origen.x} y={etiquetas.origen.y} className="relacion__multiplicidad">
        {relacion.source.multiplicity}
      </text>
      <text x={etiquetas.destino.x} y={etiquetas.destino.y} className="relacion__multiplicidad">
        {relacion.target.multiplicity}
      </text>
    </g>
  );

  /*
    Relación reflexiva: una clase consigo misma, como el empleado que tiene un
    jefe que también es empleado. Antes esto salía de su propio centro hacia su
    propio centro, o sea una línea de longitud cero: la relación existía en el
    modelo y en el panel, y en el lienzo no se veía nada. Se dibuja como un lazo
    saliendo por el lado derecho, que es la convención en UML.
  */
  if (origen.id === destino.id) {
    const x = origen.position.x + medidaOrigen.ancho;
    const y = origen.position.y + medidaOrigen.alto / 2;
    const fondo = 70 + Math.abs(desvio) * 26;
    const d = `M ${x} ${y - 14} C ${x + fondo} ${y - 52}, ${x + fondo} ${y + 52}, ${x} ${y + 14}`;
    return trazo(d, {
      origen: { x: x + 8, y: y - 20 },
      destino: { x: x + 8, y: y + 30 },
      centro: { x: x + fondo * 0.78, y },
    });
  }

  const centroOrigen = {
    x: origen.position.x + medidaOrigen.ancho / 2,
    y: origen.position.y + medidaOrigen.alto / 2,
  };
  const centroDestino = {
    x: destino.position.x + medidaDestino.ancho / 2,
    y: destino.position.y + medidaDestino.alto / 2,
  };

  // Perpendicular unitaria a la recta que une los centros: es la dirección en la
  // que se abre el abanico y también hacia donde se apartan las cardinalidades.
  const dx = centroDestino.x - centroOrigen.x;
  const dy = centroDestino.y - centroOrigen.y;
  const largo = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / largo, y: dx / largo };

  // El punto de control tira de la curva el doble de lo que se quiere separar,
  // porque una cuadrática pasa por la mitad de camino hacia su control.
  const control = {
    x: (centroOrigen.x + centroDestino.x) / 2 + normal.x * desvio * SEPARACION_ABANICO,
    y: (centroOrigen.y + centroDestino.y) / 2 + normal.y * desvio * SEPARACION_ABANICO,
  };

  // Los extremos apuntan al control y no al otro centro: así la línea sale de la
  // caja en la dirección en la que va a curvarse, en vez de doblar nada más nacer.
  const desde = anclaje(origen, medidaOrigen, control);
  const hasta = anclaje(destino, medidaDestino, control);
  const d = `M ${desde.x} ${desde.y} Q ${control.x} ${control.y} ${hasta.x} ${hasta.y}`;

  /*
    Las cardinalidades iban a `desde.x + 8, desde.y - 4`, siempre arriba y a la
    derecha del extremo. Con una relación que baja hacia la izquierda, ese punto
    cae justo encima de su propia línea; con dos clases juntas, encima de la
    cardinalidad del otro extremo. Ahora se colocan avanzando un poco por la
    curva y apartándose de ella por la perpendicular, que es el sitio libre
    independientemente de hacia dónde vaya la relación.
  */
  const junto = (t: number): { x: number; y: number } => {
    const punto = puntoEnCurva(desde, control, hasta, t);
    const lado = desvio >= 0 ? 1 : -1;
    return { x: punto.x + normal.x * 12 * lado, y: punto.y + normal.y * 12 * lado - 2 };
  };

  const centro = puntoEnCurva(desde, control, hasta, 0.5);
  return trazo(d, {
    origen: junto(0.16),
    destino: junto(0.84),
    centro: { x: centro.x, y: centro.y - 7 },
  });
}

function TrazoEnCurso({
  origen,
  medidas,
  hacia,
}: {
  origen: UmlClass | undefined;
  medidas: Map<string, Medida>;
  hacia: { x: number; y: number };
}): JSX.Element | null {
  if (!origen) return null;
  const desde = anclaje(origen, medidas.get(origen.id) ?? { ancho: ANCHO_MINIMO, alto: 80 }, hacia);
  return (
    <line
      x1={desde.x}
      y1={desde.y}
      x2={hacia.x}
      y2={hacia.y}
      stroke="var(--acento)"
      strokeWidth="2"
      strokeDasharray="5 4"
      markerEnd="url(#flecha)"
    />
  );
}
