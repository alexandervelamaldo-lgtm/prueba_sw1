import { useEffect, useRef, useState } from 'react';
import { prefiereMenosMovimiento } from './cursor-ia';
import { estadoProgresoOrbe, siguientePasoOrbe } from './modo-ia-vista';

const ORB_R = 66;
const CANVAS = 220;
const TAU = Math.PI * 2;
const S = 0.6;
const CP = Math.cos(0.35);
const SP = Math.sin(0.35);
const C0 = CANVAS / 2;

const DURACION_ENTRADA_MS = 500;
const DURACION_SALIDA_MS = 200;
const INTERVALO_ETIQUETAS_MS = 1150;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function mulberry32(semilla: number) {
  let a = semilla;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RINGS = 16;
interface Dot {
  x: number;
  y: number;
  z: number;
  u: number;
  seed: number;
}

const DOT_LIST: Dot[] = (() => {
  const rand = mulberry32(7);
  const out: Dot[] = [];
  for (let k = 0; k < RINGS; k++) {
    const y = 1 - ((k + 0.5) / RINGS) * 2;
    const r = Math.sqrt(1 - y * y);
    const m = Math.max(4, Math.round(30 * r));
    for (let j = 0; j < m; j++) {
      const a = (j / m) * TAU + k * 0.35;
      out.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, u: (1 - y) / 2, seed: rand() * 6.283 });
    }
  }
  return out;
})();

const N = DOT_LIST.length;
const DX = Float32Array.from(DOT_LIST, (d) => d.x);
const DY = Float32Array.from(DOT_LIST, (d) => d.y);
const DZ = Float32Array.from(DOT_LIST, (d) => d.z);
const DU = Float32Array.from(DOT_LIST, (d) => d.u);
const DS = Float32Array.from(DOT_LIST, (d) => d.seed);

function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (t: number) => number {
  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let t0 = 0;
    let t1 = 1;
    let currentT = t;
    for (let i = 0; i < 8; i++) {
      const currentX =
        3 * (1 - currentT) * (1 - currentT) * currentT * p1x +
        3 * (1 - currentT) * currentT * currentT * p2x +
        currentT * currentT * currentT;
      if (Math.abs(currentX - t) < 0.001) break;
      if (t > currentX) t0 = currentT;
      else t1 = currentT;
      currentT = (t0 + t1) / 2;
    }
    return (
      3 * (1 - currentT) * (1 - currentT) * currentT * p1y +
      3 * (1 - currentT) * currentT * currentT * p2y +
      currentT * currentT * currentT
    );
  };
}

const easeOut = cubicBezier(0.22, 1, 0.36, 1);

const A_STEPS = 48;
function crearColores(tema: 'claro' | 'oscuro'): string[] {
  const [r, g, b] = tema === 'claro' ? [31, 16, 60] : [235, 235, 245];
  const out: string[] = [];
  for (let ai = 0; ai <= A_STEPS; ai++) {
    out.push(`rgba(${r},${g},${b},${(ai / A_STEPS).toFixed(3)})`);
  }
  return out;
}

const COLORES_OSCURO = crearColores('oscuro');
const COLORES_CLARO = crearColores('claro');

export interface OrbeIAProps {
  activo: boolean;
  tema: 'claro' | 'oscuro';
  onTerminado?: () => void;
}

/**
 * Orbe visual de pensamiento para el Modo IA inmersivo (S6).
 *
 * Muestra una esfera tridimensional de partículas con rotación y pulsos
 * de luz coordinados con las fases de razonamiento de la IA.
 */
export function OrbeIA({ activo, tema, onTerminado }: OrbeIAProps): JSX.Element {
  const lienzoRef = useRef<HTMLCanvasElement | null>(null);
  const onTerminadoRef = useRef(onTerminado);
  useEffect(() => {
    onTerminadoRef.current = onTerminado;
  }, [onTerminado]);

  const [reducido] = useState(() => prefiereMenosMovimiento());
  const [paso, setPaso] = useState(0);

  // Mantener referencia al valor de progreso en el orbe
  const progRef = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPaso((p) => {
        const siguiente = siguientePasoOrbe(p);
        progRef.current = siguiente.prog;
        return siguiente.paso;
      });
    }, INTERVALO_ETIQUETAS_MS);

    return () => window.clearInterval(timer);
  }, []);

  const activoRef = useRef(activo);
  useEffect(() => {
    activoRef.current = activo;
  }, [activo]);

  useEffect(() => {
    const cv = lienzoRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let dead = false;
    let time = 0;
    let last = performance.now();
    const tiempoInicio = performance.now();
    let tiempoSalida = 0;
    let alphaAlSalir = 1;
    let saliendo = false;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(CANVAS * dpr);
    cv.height = Math.round(CANVAS * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const P = {
      k: 0,
      alpha: 0,
      spin: 0.9,
      rot: 0,
      pop: 1,
      vortex: 0,
      gain: 1,
      floor: 0,
      rad: 0,
      prog: 0,
    };

    const lit = new Float32Array(N);
    const SX = new Float32Array(N);
    const SY = new Float32Array(N);
    const SR = new Float32Array(N);
    const SD = new Float32Array(N);
    const SC = new Int16Array(N);
    const pw = [1, 0, 0, 0];

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, CANVAS, CANVAS);
      time += dt;
      P.rot += P.spin * dt;
      const yaw = P.rot + P.vortex;
      const cyw = Math.cos(yaw);
      const syw = Math.sin(yaw);
      const stepW = dt / 0.35;

      for (let q = 0; q < 4; q++) {
        const objetivo = q === P.prog ? 1 : 0;
        const actual = pw[q] ?? 0;
        const d = objetivo - actual;
        const delta = Math.abs(d) <= stepW ? d : d > 0 ? stepW : -stepW;
        pw[q] = actual + delta;
      }

      const decay = Math.exp(-dt / 0.5);
      const h0 = (time * 300) % N;
      const h3 = (time * 480) % N;
      const a1 = time * 0.8;
      const b1 = Math.sin(time * 0.5) * 0.9;
      const f1x = Math.cos(b1) * Math.cos(a1);
      const f1y = Math.sin(b1);
      const f1z = Math.cos(b1) * Math.sin(a1);
      const a2 = time * 0.55 + 2.1;
      const b2 = Math.cos(time * 0.42) * 0.9;
      const f2x = Math.cos(b2) * Math.cos(a2);
      const f2y = Math.sin(b2);
      const f2z = Math.cos(b2) * Math.sin(a2);
      const lat = Math.sin(time * 2.2);
      const swirlK = P.vortex * 1.5;

      const pw0 = pw[0] ?? 0;
      const pw1 = pw[1] ?? 0;
      const pw2 = pw[2] ?? 0;
      const pw3 = pw[3] ?? 0;

      for (let n = 0; n < N; n++) {
        const dx = DX[n] ?? 0;
        const dy = DY[n] ?? 0;
        const dz = DZ[n] ?? 0;
        const u = DU[n] ?? 0;
        let pulse = 0;

        if (pw0 > 0.001) {
          let dd = Math.abs(n - h0);
          if (dd > N - dd) dd = N - dd;
          const v = Math.max(0, 1 - dd / 16);
          pulse = Math.max(pulse, v * v * pw0);
        }
        if (pw1 > 0.001) {
          const v1 = Math.max(0, (dx * f1x + dy * f1y + dz * f1z - 0.72) / 0.28);
          const v2 = Math.max(0, (dx * f2x + dy * f2y + dz * f2z - 0.72) / 0.28);
          const v = Math.max(v1, v2);
          pulse = Math.max(pulse, v * v * pw1);
        }
        if (pw2 > 0.001) {
          const e = dy - lat;
          const v = Math.max(0, 1 - (e * e) / 0.02);
          pulse = Math.max(pulse, v * v * pw2);
        }
        if (pw3 > 0.001) {
          let dd = Math.abs(n - h3);
          if (dd > N - dd) dd = N - dd;
          const v = Math.max(0, 1 - dd / 22);
          pulse = Math.max(pulse, v * v * pw3);
        }

        const l = Math.max((lit[n] ?? 0) * decay, pulse * P.gain);
        lit[n] = l;
        const ki = clamp01(P.k * (1 + S) - S * u);
        if (ki <= 0.001) {
          SC[n] = -1;
          continue;
        }

        const eo = easeOut(ki);
        const kk = eo * P.pop;
        const x1 = dx * cyw + dz * syw;
        const z1 = -dx * syw + dz * cyw;
        const y2 = dy * CP - z1 * SP;
        const z2 = dy * SP + z1 * CP;
        const f = 2.8 / (2.8 - z2);
        const depth = (z2 + 1) / 2;

        let ox = x1 * ORB_R * kk * f;
        let oy = -y2 * ORB_R * kk * f;
        if (swirlK > 0.001) {
          const sw = (1 - ki) * swirlK;
          const cc = Math.cos(sw);
          const ss = Math.sin(sw);
          const tx = ox * cc - oy * ss;
          oy = ox * ss + oy * cc;
          ox = tx;
        }

        const seed = DS[n] ?? 0;
        let a = 0.1 + 0.035 * Math.sin(seed + time * 1.6) + 0.32 * depth * depth + 0.75 * l;
        a = Math.max(a, P.floor * (0.7 + 0.3 * depth));
        if (a > 1) a = 1;
        a *= eo * P.alpha;

        SX[n] = C0 + ox;
        SY[n] = C0 + oy;
        SD[n] = depth;
        SR[n] = (1.15 * (0.45 + 0.75 * depth) * f + 0.9 * l) * (1 + P.rad) * (0.4 + 0.6 * eo);

        const ai = Math.round(a * A_STEPS);
        SC[n] = ai <= 0 ? -1 : Math.min(A_STEPS, ai);
      }

      const colores = tema === 'claro' ? COLORES_CLARO : COLORES_OSCURO;
      for (let pass = 0; pass < 2; pass++) {
        for (let n = 0; n < N; n++) {
          const c = SC[n] ?? -1;
          if (c < 0) continue;
          if (((SD[n] ?? 0) >= 0.5) !== (pass === 1)) continue;
          ctx.fillStyle = colores[c] ?? '';
          ctx.beginPath();
          ctx.arc(SX[n] ?? 0, SY[n] ?? 0, Math.max(0.2, SR[n] ?? 0.5), 0, TAU);
          ctx.fill();
        }
      }
    };

    if (reducido) {
      P.k = 1;
      P.alpha = 1;
      P.spin = 0;
      P.prog = 0;
      draw(0);
      return () => {
        dead = true;
      };
    }

    const frame = (now: number) => {
      raf = 0;
      if (dead) return;

      P.prog = progRef.current;

      if (!saliendo && !activoRef.current) {
        saliendo = true;
        tiempoSalida = now;
        alphaAlSalir = P.alpha;
      }

      // La IA puede volver a trabajar durante la salida: aplicar una propuesta
      // llega justo después de responder, y el globo no debe perderse ese tramo.
      if (saliendo && activoRef.current) saliendo = false;

      if (saliendo) {
        const transcurridoSalida = now - tiempoSalida;
        if (transcurridoSalida >= DURACION_SALIDA_MS) {
          P.alpha = 0;
          ctx.clearRect(0, 0, CANVAS, CANVAS);
          onTerminadoRef.current?.();
          return;
        }
        const factor = transcurridoSalida / DURACION_SALIDA_MS;
        P.alpha = Math.max(0, alphaAlSalir * (1 - factor));
      } else {
        const transcurridoEntrada = now - tiempoInicio;
        if (transcurridoEntrada < DURACION_ENTRADA_MS) {
          const t = easeOut(Math.min(1, transcurridoEntrada / DURACION_ENTRADA_MS));
          P.k = t;
          P.alpha = t;
        } else {
          P.k = 1;
          P.alpha = 1;
        }
      }

      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      draw(dt);

      raf = requestAnimationFrame(frame);
    };

    last = performance.now();
    raf = requestAnimationFrame(frame);

    return () => {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
  }, [reducido, tema]);

  // Manejo de salida en modo reducido
  useEffect(() => {
    if (!reducido) return;
    if (!activo) {
      const timer = window.setTimeout(() => {
        onTerminadoRef.current?.();
      }, DURACION_SALIDA_MS);
      return () => window.clearTimeout(timer);
    }
  }, [activo, reducido]);

  const infoProgreso = estadoProgresoOrbe(paso);

  return (
    // La transcripción ya anuncia las respuestas: leer una etiqueta nueva cada
    // segundo solo taparía a quien usa un lector de pantalla.
    <div className={`orbe-ia${!activo ? ' orbe-ia--saliendo' : ''}`} aria-hidden="true">
      <canvas ref={lienzoRef} className="orbe-ia__lienzo" />
      <div className="orbe-ia__etiqueta">
        <span>{infoProgreso.etiqueta}</span>
        <span
          className={`orbe-ia__puntos${reducido ? ' orbe-ia__puntos--estatico' : ''}`}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
