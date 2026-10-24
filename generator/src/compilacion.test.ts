import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ClassDiagram,
  createAttribute,
  createClass,
  createDiagram,
  createRelation,
} from '@app/shared';
import { minimoDiagram, rrhhDiagram, tiendaDiagram } from './fixtures/corpus.js';
import { generate, type NormalizeOptions } from './index.js';
import { generateFlutter } from './flutter/generate-flutter.js';
import { writeToDisk } from './package/zip.js';

/**
 * Compilación y arranque del código generado, de verdad.
 *
 * Las pruebas de `generator.test.ts` miran el texto que sale de las plantillas.
 * Eso no detecta un proyecto que no compila, ni una migración que no coincide
 * con las entidades —el proyecto arranca con `ddl-auto: validate`, así que esa
 * diferencia lo tumba al arrancar—, ni un identificador que la base no sabe
 * rellenar. Aquí se genera, se compila con Maven, se arranca contra un
 * PostgreSQL desechable y se crea un registro por la API.
 *
 * Se salta sola si no hay `COMPILAR_GENERADO=1`: necesita Java, Maven, Docker y
 * red la primera vez (dependencias de Maven y de pub). Para ejecutarla:
 *
 * ```
 * COMPILAR_GENERADO=1 npx vitest run generator/src/compilacion.test.ts
 * ```
 *
 * `MVN` elige el ejecutable de Maven; sin él se usa `mvn` del PATH o, si no
 * hay, la distribución que deja el wrapper en `~/.m2/wrapper/dists`. `FLUTTER`
 * hace lo mismo con Flutter (`flutter` del PATH o `~/flutter/bin/flutter`).
 */

const activa = process.env.COMPILAR_GENERADO === '1';
const MINUTOS = 60_000;

function enPath(comando: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${comando}`]).status === 0;
}

function maven(): string {
  if (process.env.MVN) return process.env.MVN;
  if (enPath('mvn')) return 'mvn';
  const dists = join(homedir(), '.m2', 'wrapper', 'dists');
  if (existsSync(dists)) {
    for (const version of readdirSync(dists).sort().reverse()) {
      for (const hash of readdirSync(join(dists, version))) {
        const binario = join(dists, version, hash, 'bin', 'mvn');
        if (existsSync(binario)) return binario;
      }
    }
  }
  throw new Error('COMPILAR_GENERADO=1 necesita Maven: ponga MVN=/ruta/a/mvn');
}

function flutter(): string {
  if (process.env.FLUTTER) return process.env.FLUTTER;
  if (enPath('flutter')) return 'flutter';
  const local = join(homedir(), 'flutter', 'bin', 'flutter');
  if (existsSync(local)) return local;
  throw new Error('COMPILAR_GENERADO=1 necesita Flutter: ponga FLUTTER=/ruta/a/flutter');
}

/** Ejecuta y devuelve la salida; lanza con la cola de la salida si falla. */
function ejecutar(comando: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync(comando, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    throw new Error(`${comando} ${args.join(' ')} falló (${r.status}):\n${salida.slice(-6000)}`);
  }
  return salida;
}

const directorios: string[] = [];

async function generarEn(diagram: ClassDiagram, options: NormalizeOptions): Promise<string> {
  const outcome = generate(diagram, options);
  if (!outcome.ok) {
    throw new Error(`Diagrama inválido: ${JSON.stringify(outcome.validation.errors)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'generado-'));
  directorios.push(dir);
  await writeToDisk(outcome.files, dir);
  return dir;
}

function empaquetar(dir: string): string {
  ejecutar(maven(), ['-q', '-B', '-DskipTests', 'package'], dir);
  const jar = readdirSync(join(dir, 'target')).find(
    (f) => f.endsWith('.jar') && !f.endsWith('-plain.jar') && !f.endsWith('.original'),
  );
  if (!jar) throw new Error(`Maven no dejó ningún .jar en ${dir}/target`);
  return join(dir, 'target', jar);
}

/** Un solo registro, sin asociaciones: lo justo para que el INSERT pruebe el identificador. */
function claseSimple(tipoId: 'Long' | 'Integer' | 'UUID' | 'String'): ClassDiagram {
  const producto = createClass({
    id: 'C1',
    name: 'Producto',
    attributes: [
      createAttribute({ id: 'A1', name: 'id', type: tipoId, isIdentifier: true }),
      createAttribute({ id: 'A2', name: 'nombre', type: 'String', isNullable: false }),
    ],
  });
  return createDiagram({ id: 'D1', name: 'Catalogo', classes: { C1: producto } });
}

/**
 * Jerarquía con columnas propias en cada nivel y una asociación desde la
 * subclase: es lo que hace falta para que SINGLE_TABLE y TABLE_PER_CLASS
 * pierdan o no columnas.
 */
function jerarquia(): ClassDiagram {
  const persona = createClass({
    id: 'C1',
    name: 'Persona',
    kind: 'abstract',
    attributes: [
      createAttribute({ id: 'A1', name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: 'A2', name: 'nombre', type: 'String', isNullable: false }),
    ],
  });
  const empleado = createClass({
    id: 'C2',
    name: 'Empleado',
    attributes: [createAttribute({ id: 'A3', name: 'salario', type: 'Decimal', isNullable: false })],
  });
  const cliente = createClass({
    id: 'C3',
    name: 'Cliente',
    attributes: [createAttribute({ id: 'A4', name: 'email', type: 'String', isUnique: true })],
  });
  const sede = createClass({
    id: 'C4',
    name: 'Sede',
    attributes: [
      createAttribute({ id: 'A5', name: 'id', type: 'Long', isIdentifier: true }),
      createAttribute({ id: 'A6', name: 'ciudad', type: 'String' }),
    ],
  });
  const diagrama = createDiagram({
    id: 'D1',
    name: 'Personas',
    classes: { C1: persona, C2: empleado, C3: cliente, C4: sede },
  });
  return {
    ...diagrama,
    relations: {
      R1: createRelation({ id: 'R1', kind: 'inheritance', sourceId: 'C2', targetId: 'C1' }),
      R2: createRelation({ id: 'R2', kind: 'inheritance', sourceId: 'C3', targetId: 'C1' }),
      R3: createRelation({
        id: 'R3',
        kind: 'association',
        sourceId: 'C2',
        targetId: 'C4',
        sourceMultiplicity: '*',
        targetMultiplicity: '0..1',
        targetRole: 'sede',
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL desechable
// ---------------------------------------------------------------------------

let contenedor: string | undefined;
let puertoPg = 0;

function arrancarPostgres(): void {
  const imagen = process.env.POSTGRES_IMAGE ?? 'postgres:16-alpine';
  contenedor = ejecutar(
    'docker',
    ['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432', imagen],
    tmpdir(),
  ).trim();
  const puerto = ejecutar('docker', ['port', contenedor, '5432/tcp'], tmpdir()).trim();
  puertoPg = Number(puerto.split(':').pop());
  for (let i = 0; i < 60; i++) {
    const r = spawnSync('docker', ['exec', contenedor, 'pg_isready', '-U', 'postgres']);
    if (r.status === 0) return;
    spawnSync('sleep', ['1']);
  }
  throw new Error('PostgreSQL no quedó listo en 60 s');
}

function crearBase(nombre: string): void {
  ejecutar('docker', ['exec', contenedor!, 'createdb', '-U', 'postgres', nombre], tmpdir());
}

interface Arrancado {
  proceso: ChildProcess;
  puerto: number;
}

/** Arranca el jar y espera a Tomcat; lanza con el log si Spring falla antes. */
function arrancar(jar: string, base: string): Promise<Arrancado> {
  return new Promise((resolver, rechazar) => {
    const proceso = spawn('java', ['-jar', jar], {
      env: {
        ...process.env,
        DB_HOST: '127.0.0.1',
        DB_PORT: String(puertoPg),
        DB_NAME: base,
        DB_USER: 'postgres',
        DB_PASSWORD: 'postgres',
        SERVER_PORT: '0',
      },
    });
    let log = '';
    const fin = setTimeout(() => {
      proceso.kill('SIGKILL');
      rechazar(new Error(`La aplicación no arrancó en 3 minutos:\n${log.slice(-6000)}`));
    }, 3 * MINUTOS);
    const leer = (trozo: Buffer) => {
      log += trozo.toString();
      const puerto = /Tomcat started on port (?:\(s\): )?(\d+)/.exec(log)?.[1];
      if (puerto && /Started \w+ in /.test(log)) {
        clearTimeout(fin);
        resolver({ proceso, puerto: Number(puerto) });
      }
    };
    proceso.stdout.on('data', leer);
    proceso.stderr.on('data', leer);
    proceso.on('exit', (codigo) => {
      clearTimeout(fin);
      rechazar(new Error(`La aplicación terminó al arrancar (${codigo}):\n${log.slice(-6000)}`));
    });
  });
}

function parar(app: Arrancado): void {
  app.proceso.removeAllListeners('exit');
  app.proceso.kill('SIGKILL');
}

/** Genera, empaqueta y arranca contra una base propia; devuelve la app arrancada. */
async function levantar(nombre: string, diagram: ClassDiagram, options: NormalizeOptions) {
  const dir = await generarEn(diagram, { ...options, databaseTarget: 'postgres' });
  const jar = empaquetar(dir);
  crearBase(nombre);
  return arrancar(jar, nombre);
}

async function crear(app: Arrancado, ruta: string, cuerpo: unknown): Promise<Record<string, unknown>> {
  const respuesta = await fetch(`http://127.0.0.1:${app.puerto}/api/${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const texto = await respuesta.text();
  expect(respuesta.status, texto).toBe(201);
  return JSON.parse(texto) as Record<string, unknown>;
}

describe.skipIf(!activa)('el código generado compila y arranca', () => {
  beforeAll(() => {
    if (enPath('docker')) arrancarPostgres();
  }, 2 * MINUTOS);

  afterAll(() => {
    if (contenedor) spawnSync('docker', ['rm', '-f', contenedor]);
    for (const dir of directorios) rmSync(dir, { recursive: true, force: true });
  });

  describe('compila con Maven', () => {
    for (const databaseTarget of ['postgres', 'mongodb', 'cassandra'] as const) {
      for (const [nombre, diagrama] of [
        ['tienda', tiendaDiagram],
        ['rrhh', rrhhDiagram],
        ['minimo', minimoDiagram],
      ] as const) {
        it(`${databaseTarget}: ${nombre}`, async () => {
          const dir = await generarEn(diagrama(), { databaseTarget });
          empaquetar(dir);
        }, 10 * MINUTOS);
      }
    }
  });

  describe('arranca contra PostgreSQL y guarda', () => {
    for (const estrategia of ['JOINED', 'SINGLE_TABLE', 'TABLE_PER_CLASS'] as const) {
      it(`herencia ${estrategia}`, async () => {
        const app = await levantar(`herencia_${estrategia.toLowerCase()}`, jerarquia(), {
          inheritanceStrategy: estrategia,
        });
        try {
          const sede = await crear(app, 'sedes', { ciudad: 'La Paz' });
          const empleado = await crear(app, 'empleados', {
            nombre: 'Ana',
            salario: 1200.5,
            sedeId: sede.id,
          });
          expect(empleado.id).not.toBeNull();
          expect(empleado.salario).toBe(1200.5);
          const cliente = await crear(app, 'clientes', { nombre: 'Beto', email: 'b@x.com' });
          expect(cliente.id).not.toBe(empleado.id);
        } finally {
          parar(app);
        }
      }, 10 * MINUTOS);
    }

    for (const tipoId of ['Long', 'Integer', 'UUID', 'String'] as const) {
      it(`identificador ${tipoId}`, async () => {
        const app = await levantar(`id_${tipoId.toLowerCase()}`, claseSimple(tipoId), {});
        try {
          const producto = await crear(app, 'productos', { nombre: 'Cuaderno' });
          expect(producto.id).toBeTruthy();
        } finally {
          parar(app);
        }
      }, 10 * MINUTOS);
    }

    it('un valor único repetido responde 409', async () => {
      const app = await levantar('unico_tienda', tiendaDiagram(), {});
      try {
        await crear(app, 'clientes', { nombre: 'Ana', email: 'ana@x.com' });
        const repetido = await fetch(`http://127.0.0.1:${app.puerto}/api/clientes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nombre: 'Otra Ana', email: 'ana@x.com' }),
        });
        expect(repetido.status, await repetido.text()).toBe(409);
      } finally {
        parar(app);
      }
    }, 10 * MINUTOS);

    it('el corpus de referencia arranca', async () => {
      for (const [nombre, diagrama] of [
        ['corpus_tienda', tiendaDiagram],
        ['corpus_rrhh', rrhhDiagram],
      ] as const) {
        parar(await levantar(nombre, diagrama(), {}));
      }
    }, 10 * MINUTOS);
  });

  describe('Flutter pasa el analizador', () => {
    for (const databaseTarget of ['postgres', 'mongodb'] as const) {
      it(databaseTarget, async () => {
        const outcome = generate(tiendaDiagram(), { databaseTarget });
        if (!outcome.ok) throw new Error('El corpus debería ser válido');
        const dir = mkdtempSync(join(tmpdir(), 'flutter-'));
        directorios.push(dir);
        await writeToDisk(generateFlutter(outcome.ir), dir);
        ejecutar(flutter(), ['pub', 'get'], dir);
        ejecutar(flutter(), ['analyze', '--no-fatal-infos'], dir);
      }, 10 * MINUTOS);
    }
  });
});
