import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { prefiereMenosMovimiento } from './cursor-ia';

/**
 * Efecto de distorsión y refracción de cristal estilo Lumina.
 *
 * Se dispara al pulsar el botón del Modo IA (el avatar o la opción de menú)
 * y propaga una onda expansiva de cristal con refracción, aberración
 * cromática y destello en el borde, inspirada en los shaders de Lumina.
 *
 * Utiliza WebGL nativo de alto rendimiento sin librerías externas pesadas,
 * respetando la preferencia de movimiento reducido del sistema.
 */

export interface ManejadorEfectoLumina {
  disparar: (origenX?: number, origenY?: number) => void;
}

const VERTEX_SHADER_SRC = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = (aPosition + 1.0) * 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = `
precision mediump float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform vec2 uOrigin;
uniform float uProgress;
uniform float uOpacity;
uniform float uTime;

void main() {
  if (uProgress <= 0.0 || uOpacity <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 p = gl_FragCoord.xy;
  vec2 c = uOrigin;
  float maxR = length(uResolution) * 0.95;
  float br = uProgress * maxR;
  float d = length(p - c);
  float nd = d / max(br, 0.001);

  float param = smoothstep(br + 8.0, br - 8.0, d);
  if (param <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float time = uTime * 3.5;
  vec2 dir = (d > 0.0) ? (p - c) / d : vec2(0.0);
  float wobble = sin(time + nd * 12.0) * cos(time * 0.8 + nd * 9.0) * 0.02 * nd * param;
  float ca = 0.035 * pow(smoothstep(0.4, 1.0, nd), 1.3);

  // Destello del borde de cristal (onda expansiva)
  float rim = smoothstep(0.91, 1.0, nd) * (1.0 - smoothstep(1.0, 1.035, nd));
  float edgeGlow = rim * 1.5;

  // Paleta Lumina: cian eléctrico, oro y violeta
  vec3 cianAura = vec3(0.12, 0.80, 0.98);
  vec3 oroAura = vec3(0.85, 0.70, 0.22);
  vec3 violetaAura = vec3(0.60, 0.30, 0.92);

  vec3 tonoBase = mix(cianAura, oroAura, sin(nd * 3.14159) * 0.5 + 0.5);
  tonoBase = mix(tonoBase, violetaAura, wobble * 4.0 + 0.15);

  // Separación cromática RGB
  vec3 cromatica = vec3(
    smoothstep(0.89, 0.97, nd) * ca * 7.0,
    smoothstep(0.92, 0.99, nd) * ca * 5.0,
    smoothstep(0.95, 1.02, nd) * ca * 9.0
  );

  float auraInterna = pow(nd, 2.5) * 0.14 * (1.0 - uProgress);
  vec3 color = tonoBase * (edgeGlow + auraInterna) + cromatica;
  float alfa = (edgeGlow * 1.8 + auraInterna * 1.2 + length(cromatica) * 1.4) * uOpacity * (1.0 - smoothstep(0.68, 1.0, uProgress));

  gl_FragColor = vec4(color, clamp(alfa, 0.0, 0.95));
}
`;

function crearShader(gl: WebGLRenderingContext, tipo: number, codigo: string): WebGLShader | null {
  const shader = gl.createShader(tipo);
  if (!shader) return null;
  gl.shaderSource(shader, codigo);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export interface EfectoLuminaProps {
  className?: string;
}

export const EfectoLuminaIA = forwardRef<ManejadorEfectoLumina, EfectoLuminaProps>(
  function EfectoLuminaIA(_props, ref) {
    const lienzoRef = useRef<HTMLCanvasElement | null>(null);
    const estadoRef = useRef<{
      gl: WebGLRenderingContext | null;
      programa: WebGLProgram | null;
      buffer: WebGLBuffer | null;
      animId: number | null;
      uniformes: Record<string, WebGLUniformLocation | null>;
    }>({
      gl: null,
      programa: null,
      buffer: null,
      animId: null,
      uniformes: {},
    });

    useEffect(() => {
      const lienzo = lienzoRef.current;
      if (!lienzo) return;

      let gl: WebGLRenderingContext | null = null;
      try {
        gl = lienzo.getContext('webgl', { alpha: true, antialias: false, depth: false });
      } catch {
        gl = null;
      }

      if (!gl) return;

      const vert = crearShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
      const frag = crearShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
      if (!vert || !frag) return;

      const programa = gl.createProgram();
      if (!programa) return;
      gl.attachShader(programa, vert);
      gl.attachShader(programa, frag);
      gl.linkProgram(programa);

      if (!gl.getProgramParameter(programa, gl.LINK_STATUS)) {
        gl.deleteProgram(programa);
        return;
      }

      gl.useProgram(programa);

      // Cuadrilátero que cubre toda la pantalla
      const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

      const aPosition = gl.getAttribLocation(programa, 'aPosition');
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

      const uniformes = {
        uResolution: gl.getUniformLocation(programa, 'uResolution'),
        uOrigin: gl.getUniformLocation(programa, 'uOrigin'),
        uProgress: gl.getUniformLocation(programa, 'uProgress'),
        uOpacity: gl.getUniformLocation(programa, 'uOpacity'),
        uTime: gl.getUniformLocation(programa, 'uTime'),
      };

      const ajustarTamano = () => {
        if (!lienzo || !gl) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const ancho = window.innerWidth;
        const alto = window.innerHeight;
        lienzo.width = ancho * dpr;
        lienzo.height = alto * dpr;
        gl.viewport(0, 0, lienzo.width, lienzo.height);
      };

      ajustarTamano();
      window.addEventListener('resize', ajustarTamano);

      estadoRef.current = { gl, programa, buffer, animId: null, uniformes };

      return () => {
        window.removeEventListener('resize', ajustarTamano);
        if (estadoRef.current.animId) {
          cancelAnimationFrame(estadoRef.current.animId);
        }
        if (gl && buffer) gl.deleteBuffer(buffer);
        if (gl && programa) gl.deleteProgram(programa);
      };
    }, []);

    useImperativeHandle(ref, () => ({
      disparar(origenX?: number, origenY?: number) {
        if (prefiereMenosMovimiento()) return;

        const { gl, programa, uniformes } = estadoRef.current;
        const lienzo = lienzoRef.current;
        if (!gl || !programa || !lienzo) return;

        if (estadoRef.current.animId) {
          cancelAnimationFrame(estadoRef.current.animId);
          estadoRef.current.animId = null;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const x = (origenX ?? window.innerWidth / 2) * dpr;
        // En WebGL las coordenadas Y van de abajo hacia arriba
        const y = (window.innerHeight - (origenY ?? 40)) * dpr;

        gl.useProgram(programa);
        if (uniformes.uResolution) {
          gl.uniform2f(uniformes.uResolution, lienzo.width, lienzo.height);
        }
        if (uniformes.uOrigin) {
          gl.uniform2f(uniformes.uOrigin, x, y);
        }

        const duracionMs = 1250;
        const inicio = performance.now();

        const iterar = (ahora: number) => {
          const transcurrido = ahora - inicio;
          const t = Math.min(transcurrido / duracionMs, 1.0);
          // Easing suave (power2.out)
          const progreso = 1 - (1 - t) * (1 - t);
          const opacidad = t < 0.7 ? 1.0 : (1.0 - t) / 0.3;

          gl.useProgram(programa);
          if (uniformes.uProgress) gl.uniform1f(uniformes.uProgress, progreso);
          if (uniformes.uOpacity) gl.uniform1f(uniformes.uOpacity, opacidad);
          if (uniformes.uTime) gl.uniform1f(uniformes.uTime, transcurrido * 0.001);

          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          if (t < 1.0) {
            estadoRef.current.animId = requestAnimationFrame(iterar);
          } else {
            gl.clear(gl.COLOR_BUFFER_BIT);
            estadoRef.current.animId = null;
          }
        };

        estadoRef.current.animId = requestAnimationFrame(iterar);
      },
    }));

    return (
      <canvas
        ref={lienzoRef}
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          zIndex: 9999,
        }}
      />
    );
  },
);
