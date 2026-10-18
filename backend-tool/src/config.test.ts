import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarEnv, loadConfig } from './config.js';

/**
 * El secreto de sesión firma los tokens. Si cambia entre dos arranques, todos
 * los tokens emitidos antes dejan de valer —y el síntoma que ve el usuario no
 * es «vuelve a entrar» sino «Sin conexión», porque el navegador no le deja al
 * cliente WebSocket leer el 401 del apretón de manos rechazado—. De ahí que
 * merezca una prueba propia: es una línea de configuración cuyo fallo aparece
 * disfrazado de problema de red.
 */

const temporales: string[] = [];

function dirTemporal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'config-'));
  temporales.push(dir);
  return dir;
}

afterEach(() => {
  while (temporales.length > 0) {
    const dir = temporales.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `cargarEnv` escribe en `process.env`, que es global y sobrevive al fichero de
 * pruebas. Sin deshacerlo, una prueba de aquí decidiría lo que ve otra suite
 * cargada después, y el fallo aparecería en un sitio que no tiene nada que ver.
 * Se guarda el valor anterior —incluido «no existía»— y se restaura al acabar.
 */
const tocadas = new Map<string, string | undefined>();

function anota(...claves: string[]): void {
  for (const clave of claves) {
    if (!tocadas.has(clave)) tocadas.set(clave, process.env[clave]);
  }
}

afterEach(() => {
  for (const [clave, valor] of tocadas) {
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }
  tocadas.clear();
});

describe('loadConfig', () => {
  it('usa el secreto del entorno cuando está definido', () => {
    const config = loadConfig({ SESSION_SECRET: 'secreto-del-entorno', DATA_DIR: dirTemporal() });
    expect(config.sessionSecret).toBe('secreto-del-entorno');
    expect(config.sessionSecretIsGenerated).toBe(false);
  });

  it('mantiene el mismo secreto entre arranques cuando lo genera él', () => {
    const dataDir = dirTemporal();
    const primero = loadConfig({ DATA_DIR: dataDir });
    const segundo = loadConfig({ DATA_DIR: dataDir });

    expect(primero.sessionSecretIsGenerated).toBe(true);
    expect(primero.sessionSecret).toHaveLength(64);
    expect(segundo.sessionSecret).toBe(primero.sessionSecret);
  });

  it('guarda el secreto generado junto a los datos', () => {
    const dataDir = dirTemporal();
    const config = loadConfig({ DATA_DIR: dataDir });
    expect(readFileSync(join(dataDir, 'secreto-de-sesion'), 'utf8').trim()).toBe(
      config.sessionSecret,
    );
  });

  it('da secretos distintos a instalaciones distintas', () => {
    const uno = loadConfig({ DATA_DIR: dirTemporal() });
    const otro = loadConfig({ DATA_DIR: dirTemporal() });
    expect(uno.sessionSecret).not.toBe(otro.sessionSecret);
  });

  it('sigue avisando de que el secreto no viene del entorno', () => {
    // Persistirlo quita la molestia en desarrollo pero no lo hace correcto en
    // producción: con varias instancias, cada fichero rechaza los tokens de las
    // demás. El aviso de arranque depende de esta bandera.
    expect(loadConfig({ DATA_DIR: dirTemporal() }).sessionSecretIsGenerated).toBe(true);
  });
});

/**
 * Una clave repetida dentro del mismo `.env` no rompe nada: gana la primera y
 * el programa arranca. El problema es que el fichero deja de decir la verdad.
 * Quien pega un bloque de configuración nuevo al final sin borrar el viejo ve
 * en la pantalla una cosa y el programa usa otra, y el error que acaba saliendo
 * llega del proveedor treinta minutos después señalando la variable equivocada.
 * Por eso hay pruebas de un `console.warn`, que normalmente no las merecería:
 * aquí el aviso es el único sitio donde esa diferencia se puede ver.
 */
describe('cargarEnv', () => {
  function escribeEnv(contenido: string): string {
    const ruta = join(dirTemporal(), '.env');
    writeFileSync(ruta, contenido, 'utf8');
    return ruta;
  }

  it('gana la primera aparición y avisa de la que se descarta', () => {
    anota('PRUEBA_MODELO', 'PRUEBA_INTACTA');
    delete process.env.PRUEBA_MODELO;
    delete process.env.PRUEBA_INTACTA;
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      cargarEnv(escribeEnv('PRUEBA_MODELO=arriba\nPRUEBA_INTACTA=sola\nPRUEBA_MODELO=abajo\n'));

      expect(process.env.PRUEBA_MODELO).toBe('arriba');
      expect(process.env.PRUEBA_INTACTA).toBe('sola');
      expect(avisos).toHaveBeenCalledTimes(1);
      expect(String(avisos.mock.calls[0]?.[0])).toContain('PRUEBA_MODELO');
    } finally {
      avisos.mockRestore();
    }
  });

  it('el aviso nombra la clave y nunca el valor', () => {
    // La prueba con más peso de las cuatro. En este fichero viven las claves de
    // API y la contraseña de la base de datos; un aviso que las imprimiera las
    // dejaría en cualquier recolector de registros por el que pase el proceso.
    anota('PRUEBA_API_KEY');
    delete process.env.PRUEBA_API_KEY;
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      cargarEnv(escribeEnv('PRUEBA_API_KEY=sk-secreto-de-arriba\nPRUEBA_API_KEY=sk-secreto-de-abajo\n'));

      const texto = avisos.mock.calls.map((argumentos) => argumentos.join(' ')).join('\n');
      expect(texto).toContain('PRUEBA_API_KEY');
      expect(texto).not.toContain('sk-secreto-de-arriba');
      expect(texto).not.toContain('sk-secreto-de-abajo');
    } finally {
      avisos.mockRestore();
    }
  });

  it('se calla cuando no hay ninguna repetida', () => {
    anota('PRUEBA_UNA', 'PRUEBA_OTRA');
    delete process.env.PRUEBA_UNA;
    delete process.env.PRUEBA_OTRA;
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      cargarEnv(escribeEnv('# un comentario\nPRUEBA_UNA=1\n\nPRUEBA_OTRA=2\n'));

      expect(process.env.PRUEBA_UNA).toBe('1');
      expect(avisos).not.toHaveBeenCalled();
    } finally {
      avisos.mockRestore();
    }
  });

  it('no confunde «lo puso el entorno real» con una repetición', () => {
    // Las dos acaban en el mismo `continue`, pero solo una es una errata. Que
    // el contenedor mande sobre un `.env` olvidado en el disco es la política
    // buscada, y avisar de ella entrenaría a todo el mundo a ignorar el aviso.
    anota('PRUEBA_DEL_ENTORNO');
    process.env.PRUEBA_DEL_ENTORNO = 'del-entorno';
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      cargarEnv(escribeEnv('PRUEBA_DEL_ENTORNO=del-fichero\n'));

      expect(process.env.PRUEBA_DEL_ENTORNO).toBe('del-entorno');
      expect(avisos).not.toHaveBeenCalled();
    } finally {
      avisos.mockRestore();
    }
  });
});

describe('LLM_LIMITE_DIARIO_TOKENS', () => {
  const base = { SESSION_SECRET: 'secreto' };

  it('un entero positivo es el límite diario', () => {
    expect(loadConfig({ ...base, LLM_LIMITE_DIARIO_TOKENS: '200000' }).llmLimiteDiarioTokens).toBe(200_000);
  });

  it('sin variable, o con un valor que no es un entero positivo, no hay límite', () => {
    expect(loadConfig(base).llmLimiteDiarioTokens).toBeUndefined();
    expect(loadConfig({ ...base, LLM_LIMITE_DIARIO_TOKENS: '0' }).llmLimiteDiarioTokens).toBeUndefined();
    expect(loadConfig({ ...base, LLM_LIMITE_DIARIO_TOKENS: 'mucho' }).llmLimiteDiarioTokens).toBeUndefined();
    expect(loadConfig({ ...base, LLM_LIMITE_DIARIO_TOKENS: '1.5' }).llmLimiteDiarioTokens).toBeUndefined();
  });
});

describe('ELEVENLABS_*', () => {
  const base = { SESSION_SECRET: 'secreto' };

  it('sin clave no hay voz del servidor', () => {
    expect(loadConfig(base).elevenLabsApiKey).toBeUndefined();
    expect(loadConfig({ ...base, ELEVENLABS_API_KEY: '   ' }).elevenLabsApiKey).toBeUndefined();
  });

  it('lee la clave, la voz y el modelo', () => {
    const config = loadConfig({ ...base, ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', ELEVENLABS_MODEL: 'm' });
    expect([config.elevenLabsApiKey, config.elevenLabsVoiceId, config.elevenLabsModelo]).toEqual(['k', 'v', 'm']);
  });
});

describe('GROQ_*', () => {
  const base = { SESSION_SECRET: 'secreto' };

  it('sin clave no hay transcripción del servidor; con ella, lee la clave y el modelo', () => {
    expect(loadConfig(base).groqApiKey).toBeUndefined();
    const config = loadConfig({ ...base, GROQ_API_KEY: ' g ', GROQ_TRANSCRIPTION_MODEL: 'whisper-large-v3' });
    expect([config.groqApiKey, config.groqModeloTranscripcion]).toEqual(['g', 'whisper-large-v3']);
  });
});
