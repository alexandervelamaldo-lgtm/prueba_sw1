import { useId } from 'react';
import { motion } from 'motion/react';

/**
 * El avatar de la IA: un orbe con dos ojos que parpadean. Pulsarlo abre el
 * Modo IA y la IA saluda (ver `EditorDiagrama` y `bienvenida-ia.ts`).
 *
 * Adaptado de un componente pensado para Tailwind y shadcn. Este proyecto no
 * usa ninguno de los dos —sus estilos viven en `estilos.css`—, así que las
 * clases de utilidad pasaron a clases propias (`.avatar-ia*`) y se conservó lo
 * que hace al diseño: los degradados de cada color, el brillo, el grano y la
 * animación de pulsar con `motion`. Es un `<button>` y no un `div` con
 * `role="img"`, porque se usa para algo y tiene que poder usarse con teclado.
 *
 * `estado` le da vida: en reposo parpadea y, mientras la IA trabaja, mira a
 * un lado y a otro («pensando»). Con «menos movimiento» pedido en el sistema
 * no se anima nada (ver la hoja de estilos).
 */

export type ColorAvatarIA = 'blue' | 'cyan' | 'purple' | 'green';
export type EstadoAvatarIA = 'reposo' | 'pensando';

interface Preset {
  degradado: string;
  sombra: string;
  iris: string;
}

const BRILLO =
  'radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)';

const PRESETS: Record<ColorAvatarIA, Preset> = {
  blue: {
    degradado: 'radial-gradient(circle at 50% 45%, #0d4d9a 0%, #3d7dd8 40%, #6fb3ff 68%, #e0eeff 100%)',
    sombra: '0 0 4px 0px rgba(20,102,216,.35), 0 0 16px 6px rgba(20,102,216,.18), inset 0 0 0 1px rgba(255,255,255,.05)',
    iris: 'linear-gradient(135deg, #ffffff 0%, #d4ecff 100%)',
  },
  cyan: {
    degradado: 'radial-gradient(circle at 50% 45%, #003d66 0%, #0a8fb5 40%, #5dd4ff 68%, #cdf5ff 100%)',
    sombra: '0 0 4px 0px rgba(10,143,181,.35), 0 0 16px 6px rgba(10,143,181,.18), inset 0 0 0 1px rgba(255,255,255,.05)',
    iris: 'linear-gradient(135deg, #ffffff 0%, #d0f0ff 100%)',
  },
  purple: {
    degradado: 'radial-gradient(circle at 50% 45%, #4a0080 0%, #8b3fd1 40%, #c896ff 68%, #e8d4ff 100%)',
    sombra: '0 0 4px 0px rgba(110,46,224,.35), 0 0 16px 6px rgba(110,46,224,.18), inset 0 0 0 1px rgba(255,255,255,.05)',
    iris: 'linear-gradient(135deg, #ffffff 0%, #e0c9ff 100%)',
  },
  green: {
    degradado: 'radial-gradient(circle at 50% 45%, #0d6632 0%, #2a9d5f 40%, #6dd187 68%, #d1fadd 100%)',
    sombra: '0 0 4px 0px rgba(12,168,82,.35), 0 0 16px 6px rgba(12,168,82,.18), inset 0 0 0 1px rgba(255,255,255,.05)',
    iris: 'linear-gradient(135deg, #ffffff 0%, #c5f5d8 100%)',
  },
};

interface Props {
  onClick: () => void;
  estado?: EstadoAvatarIA;
  color?: ColorAvatarIA;
  /** Texto accesible y del `title`. */
  etiqueta?: string;
}

export function AvatarIA({
  onClick,
  estado = 'reposo',
  color = 'cyan',
  etiqueta = 'Abrir el Modo IA',
}: Props): JSX.Element {
  const id = useId().replace(/\W/g, '');
  const preset = PRESETS[color];

  return (
    <motion.button
      type="button"
      className={`avatar-ia avatar-ia--${estado}`}
      onClick={onClick}
      aria-label={etiqueta}
      title={etiqueta}
      whileTap={{ scaleX: 1.15, scaleY: 1.3 }}
      transition={{ type: 'tween', duration: 0.8, ease: [0.34, 1.56, 0.64, 1] }}
      style={{ background: preset.degradado, boxShadow: preset.sombra }}
    >
      {/* Textura: un ruido grueso y un grano fino, mezclados por encima. */}
      <svg aria-hidden="true" className="avatar-ia__textura" width="100%" height="100%">
        <defs>
          <filter id={`ruido-${id}`} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="4" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <filter id={`grano-${id}`} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="3.2" numOctaves="1" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>
        <rect width="100%" height="100%" filter={`url(#ruido-${id})`} />
        <rect width="100%" height="100%" filter={`url(#grano-${id})`} />
      </svg>
      <span aria-hidden="true" className="avatar-ia__brillo" style={{ background: BRILLO }} />
      <span aria-hidden="true" className="avatar-ia__sombra" />
      <span aria-hidden="true" className="avatar-ia__ojos">
        <span className="avatar-ia__ojo" style={{ background: preset.iris }} />
        <span className="avatar-ia__ojo avatar-ia__ojo--segundo" style={{ background: preset.iris }} />
      </span>
    </motion.button>
  );
}
