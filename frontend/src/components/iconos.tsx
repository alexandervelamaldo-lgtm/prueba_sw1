import type { ReactNode } from 'react';
import type { ClassKind, RelationKind } from '@app/shared';

/**
 * Los iconos de la interfaz, dibujados.
 *
 * Antes cada botón llevaba un carácter de la fuente del sistema: `🕘` para el
 * historial, `◧` y `◨` para las columnas, `▭ ◻ ▱ ≡` para los tipos de clase.
 * Funciona hasta que se mira en otra máquina. Un pictograma Unicode lo dibuja la
 * fuente instalada, no la aplicación: `🕘` sale a color en Windows, plano en
 * Linux y con otro grosor en macOS; `▱` no existe en muchas fuentes y se cae al
 * rectángulo vacío; y ninguno de los dos se alinea con la línea base del texto
 * que tiene al lado, así que la barra queda con los símbolos bailando medio
 * píxel arriba y abajo. Es exactamente el aspecto que delata que una interfaz se
 * montó deprisa.
 *
 * Dibujarlos aquí cuesta un fichero y los fija: mismo trazo, mismo tamaño y
 * mismo color en todas partes, y heredan `currentColor`, así que un botón
 * deshabilitado o activo arrastra su icono al color que le toque sin una sola
 * regla extra.
 *
 * No se instala una librería de iconos. Son treinta y seis; una librería trae
 * varios miles, un `package.json` más largo y un árbol de dependencias que
 * auditar, para usar el uno por ciento.
 */

/*
  Todo se dibuja en una rejilla de 16×16 con trazo de 1 píxel.

  Las líneas rectas van en coordenadas terminadas en `.5` a propósito: un trazo
  de un píxel centrado en una coordenada entera se reparte medio píxel a cada
  lado y el navegador lo pinta en dos columnas grises en vez de una negra. Medio
  píxel de desplazamiento es la diferencia entre un borde nítido y uno borroso, y
  a 16 px se nota.
*/
export type NombreIcono =
  | 'atras'
  | 'imagen'
  | 'importar'
  | 'exportar'
  | 'deshacer'
  | 'rehacer'
  | 'historial'
  | 'columna-izquierda'
  | 'columna-derecha'
  | 'tema-claro'
  | 'tema-oscuro'
  | 'mas'
  | 'cerrar'
  | 'puntero'
  | 'clase'
  | 'interfaz'
  | 'abstracta'
  | 'enumeracion'
  | 'asociacion'
  | 'clase-asociacion'
  | 'agregacion'
  | 'composicion'
  | 'herencia'
  | 'realizacion'
  | 'dependencia'
  | 'desplegar'
  | 'plegar'
  | 'microfono'
  | 'altavoz'
  | 'altavoz-mudo'
  | 'llave'
  | 'alerta'
  | 'comprobado'
  | 'modulo'
  | 'comunicacion'
  | 'revisar'
  | 'encuadrar'
  | 'personas'
  | 'enviar'
  | 'papelera'
  | 'reproducir'
  | 'pausa'
  | 'mensajes';

/** El punteado de las relaciones que en UML se dibujan con línea discontinua. */
const PUNTEADO = '2 1.6';

const TRAZOS: Record<NombreIcono, ReactNode> = {
  atras: <path d="M10 3.5 5.5 8l4.5 4.5" />,

  imagen: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" />
      <circle cx="5.5" cy="6.5" r="1.2" />
      <path d="M2 12.5 6 8.5l2.5 2.5L11 8.5l3 4" />
    </>
  ),

  /* Importar es una flecha que entra en la bandeja; exportar, una que sale. La
     bandeja es la misma en los dos para que se lean como pareja. */
  importar: (
    <>
      <path d="M8 1.5v7M5.5 6 8 8.5 10.5 6" />
      <path d="M2.5 10.5v3h11v-3" />
    </>
  ),
  exportar: (
    <>
      <path d="M8 8.5v-7M5.5 4 8 1.5 10.5 4" />
      <path d="M2.5 10.5v3h11v-3" />
    </>
  ),

  deshacer: (
    <>
      <path d="M4.5 6.5h5.5a3.5 3.5 0 0 1 0 7H6" />
      <path d="M7 3.5 4 6.5l3 3" />
    </>
  ),
  rehacer: (
    <>
      <path d="M11.5 6.5H6a3.5 3.5 0 0 0 0 7h4" />
      <path d="M9 3.5l3 3-3 3" />
    </>
  ),

  historial: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5V8l2.5 2" />
    </>
  ),

  /* La columna que se muestra va rellena y la otra hueca: se ve de un vistazo
     cuál de los dos botones controla qué lado, sin leer el rótulo. */
  'columna-izquierda': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" />
      <path d="M6.5 2.5v11" />
      <path d="M2 3h4v10H2z" fill="currentColor" stroke="none" />
    </>
  ),
  'columna-derecha': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" />
      <path d="M9.5 2.5v11" />
      <path d="M10 3h4v10h-4z" fill="currentColor" stroke="none" />
    </>
  ),

  'tema-claro': (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4" />
    </>
  ),
  'tema-oscuro': <path d="M13 9.6A5.6 5.6 0 0 1 6.4 3 5.5 5.5 0 1 0 13 9.6z" />,

  mas: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  cerrar: <path d="M4 4l8 8M12 4l-8 8" />,

  puntero: <path d="M4.5 2.5v9.6l2.4-2.3 1.5 3.6 1.7-.8-1.6-3.4h3.2z" />,

  /*
    Los cuatro tipos de clase se distinguen por lo que UML usa para
    distinguirlos, no por una forma inventada: la caja con su cabecera es la
    clase; el círculo con el palo es la piruleta de una interfaz; la caja de
    borde discontinuo es la abstracta; y la caja con renglones dentro es la
    enumeración, que es una lista de valores.
  */
  clase: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" />
      <path d="M2.5 6.5h11" />
    </>
  ),
  interfaz: (
    <>
      <circle cx="11" cy="8" r="2.5" />
      <path d="M2.5 8h6" />
    </>
  ),
  abstracta: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" strokeDasharray={PUNTEADO} />
      <path d="M2.5 6.5h11" />
    </>
  ),
  enumeracion: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" />
      <path d="M2.5 6.5h11M5 8.5h6M5 10.5h6" />
    </>
  ),

  /*
    Las seis relaciones se dibujan con su terminación de UML, que es la que
    aparece luego en el lienzo: rombo hueco la agregación, rombo relleno la
    composición, triángulo hueco la herencia, lo mismo con línea discontinua la
    realización, y punta abierta la dependencia. El icono enseña la notación en
    vez de sustituirla por un adorno.
  */
  asociacion: <path d="M2 8.5h12" />,
  /* La relación normal (línea continua) con su clase colgando de una línea
     discontinua hacia el medio: es la lectura estándar de la notación UML de
     clase de asociación, y la línea punteada la distingue de una simple
     clase intermedia dibujada a mano por el usuario. */
  'clase-asociacion': (
    <>
      <path d="M1.5 5h13" />
      <path d="M8 5v3.5" strokeDasharray={PUNTEADO} />
      <rect x="4.5" y="8.5" width="7" height="5" />
    </>
  ),
  agregacion: (
    <>
      <path d="M8 8.5h6" />
      <path d="M2 8.5l3-2 3 2-3 2z" />
    </>
  ),
  composicion: (
    <>
      <path d="M8 8.5h6" />
      <path d="M2 8.5l3-2 3 2-3 2z" fill="currentColor" />
    </>
  ),
  herencia: (
    <>
      <path d="M2 8.5h6" />
      <path d="M8 5.5l4 3-4 3z" />
    </>
  ),
  realizacion: (
    <>
      <path d="M2 8.5h6" strokeDasharray={PUNTEADO} />
      <path d="M8 5.5l4 3-4 3z" />
    </>
  ),
  dependencia: (
    <>
      <path d="M2 8.5h9.5" strokeDasharray={PUNTEADO} />
      <path d="M8.8 5.8 12 8.5l-3.2 2.7" />
    </>
  ),

  desplegar: <path d="M6 4l4 4-4 4" />,
  plegar: <path d="M4 6l4 4 4-4" />,

  microfono: (
    <>
      <rect x="6" y="1.5" width="4" height="7.5" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
      <path d="M8 12v2.5" />
    </>
  ),
  altavoz: (
    <>
      <path d="M3.5 6.5h2L8.5 4v8L5.5 9.5h-2z" />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  'altavoz-mudo': (
    <>
      <path d="M3.5 6.5h2L8.5 4v8L5.5 9.5h-2z" />
      <path d="M11 6l3.5 4M14.5 6l-3.5 4" />
    </>
  ),

  llave: (
    <>
      <circle cx="5" cy="8" r="2.5" />
      <path d="M7.5 8H14M12 8v2.5M10 8v2" />
    </>
  ),
  alerta: (
    <>
      <path d="M8 2.5 14.5 13.5h-13z" />
      <path d="M8 6.5v3.4" />
      <circle cx="8" cy="11.8" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  comprobado: <path d="M3 8.5 6.5 12 13 4" />,

  /* Un módulo es una caja isométrica: la misma metáfora que usa cualquier
     herramienta para «paquete que contiene cosas», y se distingue de la caja
     plana de `clase` sin necesidad de rótulo. */
  modulo: (
    <>
      <path d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3z" />
      <path d="M2.5 5.5 8 8.5l5.5-3M8 8.5v5" />
    </>
  ),

  /* Dos objetos y el mensaje que va de uno al otro: exactamente lo que es un
     diagrama de comunicación. La flecha va sobre la línea, no en su punta, que
     es la notación de UML y lo que distingue esto de una simple asociación. */
  comunicacion: (
    <>
      <rect x="1.5" y="2.5" width="5" height="4" />
      <rect x="9.5" y="9.5" width="5" height="4" />
      <path d="M4 6.5v3.5a1.5 1.5 0 0 0 1.5 1.5H9" />
      <path d="M6.5 8.5 8.5 6.5 8.5 10.5z" />
    </>
  ),

  /* Una lupa sobre la caja de una clase: mirar de cerca lo que ya está
     dibujado. No es `alerta` a propósito —el triángulo diría «hay un problema»
     antes de haber mirado— ni `comprobado`, que diría lo contrario. */
  revisar: (
    <>
      <path d="M1.5 3.5h7v2h-7z" />
      <path d="M1.5 5.5v6h4" />
      <circle cx="10.5" cy="9" r="3.2" />
      <path d="M12.8 11.3 14.8 13.3" />
    </>
  ),

  /* Cuatro escuadras y una caja dentro: el diagrama entero encajado en la
     pantalla. Las esquinas se dibujan sueltas, sin cerrar el marco, porque un
     rectángulo completo con otro dentro se lee como «ventana» —lo que hacen
     `columna-izquierda` y `columna-derecha`— y esto no abre nada, mueve la
     vista. */
  encuadrar: (
    <>
      <path d="M1.5 5.5v-4h4" />
      <path d="M10.5 1.5h4v4" />
      <path d="M14.5 10.5v4h-4" />
      <path d="M5.5 14.5h-4v-4" />
      <rect x="5.5" y="5.5" width="5" height="5" rx="1" />
    </>
  ),

  /* Dos personas, no una silueta con una flecha saliendo.
     ----------------------------------------------------
     El icono de «compartir» más habitual —tres nodos unidos por dos líneas— es
     el de mandar un fichero a otra aplicación, y aquí eso ya existe: es lo que
     hacen «exportar XMI» y «generar». Lo que abre este botón es la lista de
     **quién** entra al proyecto y con qué permiso, así que lo que se dibuja son
     personas.

     La segunda va detrás y recortada por el borde: con dos figuras enteras y
     del mismo tamaño el dibujo se lee como «dos», que es un número, y no como
     «un grupo», que es lo que hay que entender cuando el proyecto tiene seis
     miembros. */
  personas: (
    <>
      <circle cx="6" cy="5.4" r="2.6" />
      <path d="M1.6 13.4c0-2.4 2-4.1 4.4-4.1s4.4 1.7 4.4 4.1" />
      <circle cx="11.9" cy="6.3" r="1.9" />
      <path d="M11.4 10.1c1.8-.1 3.1 1.3 3.1 3.3" />
    </>
  ),

  /* El avión de papel de toda la vida, con el pliegue central marcado: sin él
     la silueta sola se lee como un triángulo cualquiera. */
  enviar: (
    <>
      <path d="M14.5 1.5 1.5 7l5 2.2z" />
      <path d="M14.5 1.5 6.5 9.2l1.4 5.3z" />
    </>
  ),

  /* Una papelera, no una cruz. La cruz es «cerrar» —que ya existe— y aquí lo
     que se hace es retirar un mensaje del hilo de todo el proyecto: conviene
     que el dibujo pese lo que pesa la acción. */
  papelera: (
    <>
      <path d="M2.5 4.5h11" />
      <path d="M6 4.5v-2h4v2" />
      <path d="M3.9 4.5l.7 9.5h6.8l.7-9.5" />
      <path d="M6.6 7v4.5M9.4 7v4.5" />
    </>
  ),

  /* Un bocadillo con tres puntos: conversación, no notificación. El rabillo
     cae a la izquierda, que es de donde viene lo que dicen los demás; un
     bocadillo con el rabillo a la derecha se lee como «lo que dije yo». */
  mensajes: (
    <>
      <path d="M2 3.5h12v7.5H6.5L3.5 14v-3H2z" />
      <circle cx="5.6" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="8" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),

  reproducir: <path d="M5 3.2 12.5 8 5 12.8z" />,
  pausa: (
    <>
      <path d="M5.5 3.5v9" />
      <path d="M10.5 3.5v9" />
    </>
  ),
};

/** Los nombres válidos, para que las pruebas puedan recorrerlos todos. */
export const NOMBRES_ICONO = Object.keys(TRAZOS) as NombreIcono[];

/*
  Qué icono le toca a cada cosa del modelo.

  Las dos tablas viven aquí y no en cada componente para que la paleta, el
  explorador y el panel de propiedades enseñen el mismo dibujo para lo mismo. Que
  el botón que crea una composición y la fila que la describe usen glifos
  distintos es de las cosas que hacen que una interfaz se sienta improvisada, y
  ocurre sola en cuanto la correspondencia está escrita en tres sitios.

  Van tipadas contra `RelationKind` y `ClassKind` de `shared`: si mañana el
  modelo gana un tipo de relación, esto deja de compilar hasta que alguien le
  dibuje su icono. Es justo lo que se quiere: mejor un error de compilación que
  un botón en blanco.
*/
export const ICONO_RELACION: Record<RelationKind, NombreIcono> = {
  association: 'asociacion',
  aggregation: 'agregacion',
  composition: 'composicion',
  inheritance: 'herencia',
  realization: 'realizacion',
  dependency: 'dependencia',
};

export const ICONO_CLASE: Record<ClassKind, NombreIcono> = {
  class: 'clase',
  interface: 'interfaz',
  abstract: 'abstracta',
  enum: 'enumeracion',
};

export interface IconoProps {
  nombre: NombreIcono;
  /** Clase extra, para los pocos sitios que necesitan girarlo o encogerlo. */
  className?: string;
}

/**
 * Un icono nunca lleva significado él solo.
 *
 * Sale siempre con `aria-hidden`: quien no ve la pantalla no oye «imagen», oye
 * lo que diga el `aria-label` o el texto del botón que lo contiene. Un icono
 * anunciado por su cuenta solo añade ruido —«gráfico, gráfico, gráfico»— antes
 * de la etiqueta que de verdad informa.
 */
export function Icono({ nombre, className }: IconoProps): JSX.Element {
  return (
    <svg
      className={className ? `icono ${className}` : 'icono'}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {TRAZOS[nombre]}
    </svg>
  );
}
