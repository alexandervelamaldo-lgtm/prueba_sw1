import { useEffect, useRef, useState } from 'react';
import { prefiereMenosMovimiento } from './cursor-ia';
import { debeRetenerBienvenida } from './modo-ia-vista';

/**
 * Bienvenida animada con partículas para el Modo IA inmersivo.
 *
 * Adaptado de ParticleTitle: reúne las partículas una sola vez en aproximadamente
 * 2 segundos hasta formar el texto «¿Qué diseñamos hoy?». Si el diagrama está
 * vacío, retiene el mensaje fijo hasta que se cree la primera clase.
 *
 * Con movimiento reducido muestra texto plano sin lienzo ni animación de partículas.
 * Tiene `pointer-events: none` para no interceptar clics sobre el lienzo.
 */

type RGB = [number, number, number];
type Box = { x: number; y: number; w: number; h: number };
type Field = { cx: number; cy: number; rx: number; ry: number };
type Mode = 'smoke' | 'vortex' | 'sand' | 'burst' | 'sweep' | 'absorb';
type Blob = { rgb: RGB; a: number; fx: number; fy: number; fw: number; fh: number };
type Palette = { ink: RGB; page: RGB; blobs: Blob[] };

const ESCALA_MAXIMA = 1;
const TIEMPO_REUNION_MS = 2100;
const FONT_STACK = "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";

// Siempre sobre el velo oscuro, también en el tema claro: el texto es claro en
// los dos, y cambiar de tema no vuelve a armar las partículas.
const DARK: Palette = {
  ink: [248, 250, 252],
  page: [2, 6, 23],
  blobs: [
    { rgb: [86, 112, 160], a: 0.5, fx: 0.04, fy: 0.08, fw: 0.62, fh: 0.78 },
    { rgb: [140, 130, 190], a: 0.28, fx: 0.44, fy: 0.22, fw: 0.54, fh: 0.7 },
    { rgb: [150, 104, 84], a: 0.34, fx: 0.3, fy: 0.44, fw: 0.44, fh: 0.56 },
  ],
};

function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => {
  const c = clamp(t);
  return c * c * (3 - 2 * c);
};
const ease = (t: number) => {
  const c = clamp(t);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};

function blobStrength(b: Blob, A: Box, x: number, y: number): number {
  const bw = b.fw * A.w;
  const bh = b.fh * A.h;
  const cx = A.x + b.fx * A.w + bw / 2;
  const cy = A.y + b.fy * A.h + bh / 2;
  return Math.max(0, 1 - Math.hypot((x - cx) / (bw / 2), (y - cy) / (bh / 2))) * b.a;
}

function rimMask(A: Box, x: number, y: number): number {
  const r = Math.hypot((x - (A.x + A.w / 2)) / (A.w / 2), (y - (A.y + A.h / 2)) / (A.h / 2));
  return r < 0.55 ? 1 : r >= 1 ? 0 : 1 - (r - 0.55) / 0.45;
}

function glowAt(pal: Palette, A: Box, x: number, y: number): { c: RGB; s: number } {
  let [r, g, b] = pal.page;
  let vis = 0;
  const m = rimMask(A, x, y);
  for (const bl of pal.blobs) {
    const s = blobStrength(bl, A, x, y) * m;
    r = mix(r, bl.rgb[0], s);
    g = mix(g, bl.rgb[1], s);
    b = mix(b, bl.rgb[2], s);
    vis = Math.max(vis, s);
  }
  return { c: [r, g, b], s: vis };
}

function sampleFieldPoint(pal: Palette, rand: () => number, f: Field, A: Box): { x: number; y: number; c: RGB; s: number } {
  let best: { x: number; y: number; c: RGB; s: number } | null = null;
  for (let k = 0; k < 4; k++) {
    const a = rand() * 6.2832;
    const q = Math.pow(rand(), 0.6);
    const x = f.cx + Math.cos(a) * f.rx * q;
    const y = f.cy + Math.sin(a) * f.ry * q;
    const g = glowAt(pal, A, x, y);
    if (!best || g.s > best.s) best = { x, y, c: g.c, s: g.s };
  }
  return best as { x: number; y: number; c: RGB; s: number };
}

type Cell = {
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  hx: number;
  hy: number;
  nx: number;
  ny: number;
  r1: number;
  r2: number;
  r3: number;
  size: number;
  fx: number;
  fy: number;
  fc: RGB;
  lt: number;
  bend: number;
  pa: number;
};

function plan(mode: Mode, p: Cell, W: number, H: number) {
  switch (mode) {
    case 'smoke':
      return { delay: (1 - clamp(p.ny)) * 0.35 + p.r3 * 0.25, bend: (p.r1 - 0.5) * 150 };
    case 'vortex':
      return {
        delay: (Math.hypot(p.hx - W / 2, p.hy - H / 2) / Math.max(1, W)) * 0.9 + p.r3 * 0.15,
        bend: (p.r2 > 0.5 ? 1 : -1) * (90 + p.r1 * 140),
      };
    case 'sand':
      return { delay: p.nx * 0.6 + p.r3 * 0.18, bend: (p.r1 - 0.5) * 60 };
    case 'burst':
      return { delay: p.r3 * 0.1, bend: (p.r2 - 0.5) * 26 };
    case 'sweep':
      return { delay: (1 - p.nx) * 0.6 + p.r3 * 0.18, bend: -(60 + p.r1 * 90) };
    default:
      return { delay: p.r1 * 0.55, bend: (p.r2 - 0.5) * 100 };
  }
}

function bowAt(a: [number, number], b: [number, number], bend: number, t: number) {
  const e = ease(t);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const bow = Math.sin(e * Math.PI) * bend;
  return [mix(a[0], b[0], e) + (-dy / L) * bow, mix(a[1], b[1], e) + (dx / L) * bow, e] as const;
}

const rgbStr = (a: RGB, b: RGB, t: number) => {
  const c = (i: 0 | 1 | 2) => Math.max(0, Math.min(255, Math.round(mix(a[i], b[i], t))));
  return `rgb(${c(0)},${c(1)},${c(2)})`;
};

interface MotorBienvenida {
  setActive: (on: boolean) => void;
  resize: () => void;
  destroy: () => void;
}

function iniciarLienzoParticulas(
  cv: HTMLCanvasElement,
  texto: string,
  pal: Palette,
  alReunir: () => void,
): MotorBienvenida | null {
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  const textCv = document.createElement('canvas');
  let W = 0;
  let H = 0;
  let dpr = 1;
  let field: Field = { cx: 0, cy: 0, rx: 0, ry: 0 };
  let box: Box = { x: 0, y: 0, w: 0, h: 0 };
  let parts: Cell[] = [];
  const mode: Mode = 'vortex';
  let phaseStart = performance.now();
  let raf = 0;
  let active = true;
  let destroyed = false;
  let reunido = false;

  function reroll() {
    const r = createRng((Math.random() * 1e9) | 0);
    for (const p of parts) {
      const q = sampleFieldPoint(pal, r, field, box);
      p.fx = q.x;
      p.fy = q.y;
      p.fc = q.c;
    }
  }

  function build() {
    W = cv.clientWidth;
    H = cv.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, ESCALA_MAXIMA);
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    textCv.width = cv.width;
    textCv.height = cv.height;

    ctx!.setTransform(1, 0, 0, 1, 0, 0);
    const fs = W >= 1100 ? 38 : Math.max(26, Math.min(38, W * 0.05));
    const ty = H / 2;
    box = { x: 0, y: 0, w: W, h: H };
    field = { cx: W / 2, cy: H / 2, rx: Math.min(560, W * 0.4), ry: Math.min(260, H * 0.3) };

    const o = textCv.getContext('2d');
    if (!o) return;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, W, H);
    o.font = `600 ${fs}px ${FONT_STACK}`;
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    o.fillStyle = `rgba(${pal.ink.join(',')},.95)`;
    o.fillText(texto, W / 2, ty);

    const m = o.measureText(texto);
    const tw = m.width;
    const tx = W / 2;
    const X0 = Math.max(0, Math.floor((tx - tw / 2 - 10) * dpr));
    const X1 = Math.min(cv.width, Math.ceil((tx + tw / 2 + 10) * dpr));
    const Y0 = Math.max(0, Math.floor((ty - fs) * dpr));
    const Y1 = Math.min(cv.height, Math.ceil((ty + fs) * dpr));

    const d = o.getImageData(0, 0, cv.width, cv.height).data;
    let cs = Math.max(2, Math.round(3 * dpr));
    let pts: number[][];

    for (;;) {
      pts = [];
      for (let y = Y0; y < Y1; y += cs) {
        for (let x = X0; x < X1; x += cs) {
          const w = Math.min(cs, cv.width - x);
          const h = Math.min(cs, cv.height - y);
          let hit = false;
          for (let yy = y; yy < y + h && !hit; yy++) {
            for (let xx = x; xx < x + w; xx++) {
              if (d[(yy * cv.width + xx) * 4 + 3]! > 0) {
                hit = true;
                break;
              }
            }
          }
          if (hit) pts.push([x, y, w, h]);
        }
      }
      if (pts.length <= 2200) break;
      cs++;
    }

    let minX = 1e9;
    let maxX = -1e9;
    for (const p of pts) {
      p[4] = (p[0]! + p[2]! / 2) / dpr;
      p[5] = (p[1]! + p[3]! / 2) / dpr;
      if (p[4] < minX) minX = p[4];
      if (p[4] > maxX) maxX = p[4];
    }

    const r = createRng(7);
    parts = pts.map((p) => {
      const u = r();
      const size = u < 0.62 ? 0.9 + r() * 0.8 : u < 0.9 ? 1.8 + r() * 1.4 : 3.4 + r() * 3.2;
      return {
        rx: p[0]!,
        ry: p[1]!,
        rw: p[2]!,
        rh: p[3]!,
        hx: p[4]!,
        hy: p[5]!,
        nx: (p[4]! - minX) / Math.max(1, maxX - minX),
        ny: (p[5]! - (ty - fs / 2)) / fs,
        r1: r(),
        r2: r(),
        r3: r(),
        size,
        fx: 0,
        fy: 0,
        fc: [0, 0, 0] as RGB,
        lt: 0,
        bend: 0,
        pa: 0,
      };
    });

    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    reroll();
  }

  function drawRealText() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1;
    ctx.drawImage(textCv, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(now: number) {
    raf = 0;
    if (!ctx || destroyed) return;

    const prog = clamp((now - phaseStart) / TIEMPO_REUNION_MS + 0.08);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);

    for (const p of parts) {
      const pl = plan(mode, p, W, H);
      const lt = clamp((prog - pl.delay * 0.55) / 0.45);
      p.lt = lt;
      p.bend = pl.bend;
      p.pa = smooth((lt - 0.82) / 0.18);
      if (p.pa <= 0.002) continue;
      ctx.globalAlpha = p.pa;
      ctx.drawImage(textCv, p.rx, p.ry, p.rw, p.rh, p.rx, p.ry, p.rw, p.rh);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const p of parts) {
      const lt = p.lt;
      if (lt <= 0 || lt >= 1) continue;
      const a: [number, number] = [p.fx, p.fy];
      const b: [number, number] = [p.hx, p.hy];
      const q = bowAt(a, b, -p.bend, lt);
      const e = 1 - q[2];
      let alpha = 0.1 + 0.9 * (1 - smooth((e - 0.45) / 0.55));
      alpha *= smooth(lt / 0.15) * (1 - p.pa);
      if (alpha <= 0.004) continue;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = rgbStr(pal.ink, p.fc, smooth(e / 0.6));
      ctx.beginPath();
      ctx.arc(q[0], q[1], (p.size * mix(1, 1.7, smooth(e))) / 2, 0, 6.2832);
      ctx.fill();
    }

    ctx.globalAlpha = 1;

    if (prog < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      reunido = true;
      drawRealText();
      alReunir();
    }
  }

  build();
  raf = requestAnimationFrame(frame);

  return {
    setActive(on: boolean) {
      if (on === active || destroyed) return;
      active = on;
      if (on) {
        if (reunido) drawRealText();
        else {
          phaseStart = performance.now();
          raf = requestAnimationFrame(frame);
        }
      } else {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    resize() {
      if (destroyed) return;
      cancelAnimationFrame(raf);
      build();
      if (reunido) {
        drawRealText();
      } else if (active) {
        phaseStart = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    destroy() {
      destroyed = true;
      active = false;
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

export interface BienvenidaModoIAProps {
  totalClases: number;
  texto?: string;
  oculta?: boolean;
  /** Avisa de que empieza a irse: el velo que hay detrás se va con ella. */
  onDesvanecer?: () => void;
  onTerminado?: () => void;
}

export function BienvenidaModoIA({
  totalClases,
  texto = '¿Qué diseñamos hoy?',
  oculta = false,
  onDesvanecer,
  onTerminado,
}: BienvenidaModoIAProps): JSX.Element {
  const reducido = prefiereMenosMovimiento();
  const pal = DARK;

  const [reunido, setReunido] = useState(reducido);
  const [desvaneciendo, setDesvaneciendo] = useState(false);
  const lienzoRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = lienzoRef.current;
    if (reducido || !cv) return;

    const motor = iniciarLienzoParticulas(cv, texto, pal, () => setReunido(true));
    if (!motor) return;

    let visible = true;
    let tamano = `${cv.clientWidth}x${cv.clientHeight}`;
    const sincronizar = () => motor.setActive(visible && !document.hidden);

    const io = new IntersectionObserver((entradas) => {
      const ultima = entradas[entradas.length - 1];
      if (ultima) {
        visible = ultima.isIntersecting;
        sincronizar();
      }
    });
    io.observe(cv);

    let temporizadorRedimension: number | undefined;
    const ro = new ResizeObserver(() => {
      const nuevo = `${cv.clientWidth}x${cv.clientHeight}`;
      if (nuevo === tamano) return;
      tamano = nuevo;
      window.clearTimeout(temporizadorRedimension);
      temporizadorRedimension = window.setTimeout(() => motor.resize(), 150);
    });
    ro.observe(cv);

    document.addEventListener('visibilitychange', sincronizar);

    return () => {
      document.removeEventListener('visibilitychange', sincronizar);
      window.clearTimeout(temporizadorRedimension);
      io.disconnect();
      ro.disconnect();
      motor.destroy();
    };
  }, [reducido, pal, texto]);

  useEffect(() => {
    if (!reunido) return;
    if (debeRetenerBienvenida(totalClases)) return;

    const temporizadorEspera = window.setTimeout(() => {
      setDesvaneciendo(true);
      onDesvanecerRef.current?.();
    }, 1200);

    return () => window.clearTimeout(temporizadorEspera);
  }, [reunido, totalClases]);

  const onTerminadoRef = useRef(onTerminado);
  const onDesvanecerRef = useRef(onDesvanecer);
  onDesvanecerRef.current = onDesvanecer;
  useEffect(() => {
    onTerminadoRef.current = onTerminado;
  }, [onTerminado]);

  useEffect(() => {
    if (!desvaneciendo) return;

    const temporizadorDesvanecer = window.setTimeout(() => {
      onTerminadoRef.current?.();
    }, 700);

    return () => window.clearTimeout(temporizadorDesvanecer);
  }, [desvaneciendo]);

  return (
    <div
      className={`bienvenida-ia${oculta ? ' bienvenida-ia--oculta' : ''}${reducido ? ' bienvenida-ia--reducido' : ''}${desvaneciendo ? ' bienvenida-ia--desvaneciendo' : ''}`}
      aria-hidden="true"
    >
      <div className="bienvenida-ia__halo">
        {pal.blobs.map((b, i) => (
          <div
            key={i}
            className={`bienvenida-ia__blob bienvenida-ia__blob--${i}`}
            style={{
              background: `radial-gradient(closest-side, rgba(${b.rgb.join(',')},${b.a}), rgba(${b.rgb.join(',')},0) 100%)`,
            }}
          />
        ))}
      </div>

      {!reducido && <canvas ref={lienzoRef} className="bienvenida-ia__lienzo" />}

      <h2
        className={reducido ? 'bienvenida-ia__titulo' : 'bienvenida-ia__titulo-sr'}
        style={{ color: `rgba(${pal.ink.join(',')},0.95)` }}
      >
        {texto}
      </h2>
    </div>
  );
}
