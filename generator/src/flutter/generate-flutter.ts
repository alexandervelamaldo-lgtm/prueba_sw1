import type { EntityIR, FieldIR, GeneratedFile, GenerationIR } from '../ir/types.js';
import { inheritedAssociations, inheritedFields } from '../render/generate.js';

/**
 * Generador de frontend Flutter.
 *
 * Toma la misma IR que el generador Spring Boot y produce un proyecto Flutter
 * con modelos, servicios CRUD y formularios con dictado offline (Whisper).
 *
 * Bugs corregidos respecto a la versión anterior:
 *  - Bug 2: fromJsonExpr ya no llama javaToDart() sobre tipos Dart;
 *            los IDs UUID se mapean correctamente a String, bool a bool, etc.
 *  - Bug 3: whisper_flutter_new ^1.0.1 con API actualizada:
 *            Whisper(model: WhisperModel.base, modelDir: '...')
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type DT = 'int' | 'double' | 'bool' | 'String';

function javaToDart(javaType: string): DT {
  switch (javaType) {
    case 'Long': case 'Integer': case 'Short': case 'Byte':
    case 'int':  case 'long':
      return 'int';
    case 'Double': case 'Float': case 'BigDecimal':
    case 'float':  case 'double':
      return 'double';
    case 'Boolean': case 'boolean':
      return 'bool';
    default:
      return 'String'; // UUID, String, LocalDate*, enums
  }
}

/** Contenido de un literal Dart entre comillas simples. */
function dartTexto(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$');
}

function nullable(dt: DT, isNullable: boolean): string {
  return isNullable ? `${dt}?` : dt;
}

/**
 * Expresión fromJson correcta.
 *
 * Recibe el tipo Dart ya resuelto (DT), NO un tipo Java.
 * La versión anterior hacía javaToDart(dartType) lo que convertía
 * 'bool' → 'String' y 'int' → 'int' de casualidad.
 */
function fromJson(key: string, dt: DT, isNullable: boolean): string {
  const s = `json['${key}']`;
  if (isNullable) {
    if (dt === 'double') return `${s} != null ? (${s} as num).toDouble() : null`;
    if (dt === 'int')    return `${s} != null ? (${s} as num).toInt()    : null`;
    if (dt === 'bool')   return `${s} as bool?`;
    return `${s} as String?`;
  }
  if (dt === 'double') return `(${s} as num).toDouble()`;
  if (dt === 'int')    return `(${s} as num).toInt()`;
  if (dt === 'bool')   return `${s} as bool`;
  return `${s} as String`;
}

// ---------------------------------------------------------------------------
// Nombres
// ---------------------------------------------------------------------------

function snake(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}
function label(camel: string): string {
  return camel
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, c => c.toUpperCase())
    .trim();
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Usa el tipo de identificador normalizado por el backend para el ID Dart. */
function idDT(entity: EntityIR): DT {
  return javaToDart(entity.identifier.javaType);
}

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------

interface Campo {
  name: string;
  dt: DT;
  isNullable: boolean;
  isId: boolean;
  label: string;
  inRequest: boolean;
  /** Lista de ids de una N:M: `dt` es el tipo de cada elemento. */
  esLista?: boolean;
}

function tipoCampo(c: Campo): string {
  return c.esLista ? `List<${c.dt}>` : nullable(c.dt, c.isNullable);
}

/** Campos propios más heredados: los DTOs del backend exponen ambos. */
function camposDeEntidad(entity: EntityIR, entities: EntityIR[]): FieldIR[] {
  const byName = new Map(entities.map(e => [e.className, e]));
  return [...inheritedFields(entity, byName), ...entity.fields.filter(x => !x.isIdentifier)];
}

function campos(entity: EntityIR, entities: EntityIR[]): Campo[] {
  const out: Campo[] = [];
  out.push({ name: entity.identifier.name, dt: idDT(entity), isNullable: false, isId: true, label: 'ID', inRequest: false });
  for (const f of camposDeEntidad(entity, entities)) {
    out.push({ name: f.name, dt: javaToDart(f.javaType), isNullable: f.nullable, isId: false, label: label(f.name), inRequest: true });
  }
  const byName = new Map(entities.map(e => [e.className, e]));
  const asociaciones = [...inheritedAssociations(entity, byName), ...entity.associations];
  for (const a of asociaciones.filter(x => !x.collection && x.owning)) {
    const target = entities.find(candidate => candidate.className === a.targetClass);
    out.push({ name: `${a.fieldName}Id`, dt: target ? idDT(target) : 'int', isNullable: a.nullable, isId: false, label: label(`${a.fieldName}Id`), inRequest: true });
  }
  for (const a of asociaciones.filter(x => x.kind === 'ManyToMany' && x.owning)) {
    const target = entities.find(candidate => candidate.className === a.targetClass);
    out.push({ name: `${a.fieldName}Ids`, dt: target ? idDT(target) : 'int', isNullable: false, isId: false, label: `${label(`${a.fieldName}Ids`)} (separados por coma)`, inRequest: true, esLista: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pubspec.yaml
// ---------------------------------------------------------------------------

function nombrePaquete(ir: GenerationIR): string {
  return `${snake(ir.project.artifactId.replace(/-/g, '_') || 'app')}_flutter`;
}

function pubspec(ir: GenerationIR): string {
  return `name: ${nombrePaquete(ir)}
description: ${JSON.stringify(`Frontend Flutter para ${ir.project.name}`)}
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: ^3.3.0

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.1
  cupertino_icons: ^1.0.8
  path_provider: ^2.1.4
  # 5.x resuelve un record_linux que no implementa su propia interfaz y no compila.
  record: ^6.0.0
  # Bug 3 fix: version ^1.0.1 (^0.0.11 no existe en pub.dev).
  # API nueva: Whisper(model: WhisperModel.base, modelDir: '...')
  whisper_flutter_new: ^1.0.1
  permission_handler: ^11.3.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0

flutter:
  uses-material-design: true
  assets:
    # Coloca ggml-base-q5_1.bin aquí antes de ejecutar flutter pub get.
    # En el primer arranque la app lo copia al almacenamiento interno del
    # dispositivo (la única ruta que whisper.cpp puede abrir como fichero).
    - assets/models/
`;
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

function readme(ir: GenerationIR): string {
  return `# ${ir.project.name} — Flutter

## Backend
Edita \`lib/config/api.dart\`:
- Emulador Android: \`http://10.0.2.2:8080\`
- Dispositivo físico: \`http://192.168.X.X:8080\`
- Escritorio: \`http://localhost:8080\`

## Modelo Whisper (dictado offline)
El modelo **no se descarga automáticamente** (55 MB). Hazlo una vez:

1. Descarga \`ggml-base-q5_1.bin\` de <https://huggingface.co/ggerganov/whisper.cpp>
2. Cópialo en la carpeta \`assets/models/\` de este proyecto.

La primera vez que arranque la app verás «Preparando modelo de voz…»
mientras lo copia al almacenamiento interno. Los arranques siguientes
son instantáneos (el fichero ya existe).

Los campos de texto tienen un botón 🎤: toca → graba (rojo) → toca → transcribe (~1-3 s) → rellena el campo.

## Arrancar
El ZIP trae el código de la app, no las carpetas de cada plataforma: las crea
\`flutter create\`, que respeta el manifiesto de Android y el test ya incluidos.

\`\`\`
flutter create --platforms=android,linux .
flutter pub get
flutter run
\`\`\`

Para compilar en Android, el plugin de dictado exige el NDK 27.0.11902837. Gradle
lo instala solo la primera vez si aceptaste las licencias del SDK:

\`\`\`
flutter doctor --android-licenses
flutter build apk
\`\`\`

El dictado solo funciona en Android, iOS y macOS; en Linux la app compila y
arranca, pero sin voz. La web no está soportada: el plugin de dictado usa \`dart:ffi\`.
`;
}

// ---------------------------------------------------------------------------
// Ficheros que \`flutter create\` respeta porque ya existen
// ---------------------------------------------------------------------------

/** La plantilla de Flutter más los permisos: sin ellos no hay red en release ni micrófono. */
function manifiestoAndroid(ir: GenerationIR): string {
  return `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.RECORD_AUDIO"/>
    <application
        android:label="${nombrePaquete(ir)}"
        android:name="\${applicationName}"
        android:icon="@mipmap/ic_launcher">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:taskAffinity=""
            android:theme="@style/LaunchTheme"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
            android:hardwareAccelerated="true"
            android:windowSoftInputMode="adjustResize">
            <meta-data
              android:name="io.flutter.embedding.android.NormalTheme"
              android:resource="@style/NormalTheme"
              />
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <meta-data
            android:name="flutterEmbedding"
            android:value="2" />
    </application>
    <queries>
        <intent>
            <action android:name="android.intent.action.PROCESS_TEXT"/>
            <data android:mimeType="text/plain"/>
        </intent>
    </queries>
</manifest>
`;
}

/** Sin este fichero, \`flutter create\` añade uno que busca un \`MyApp\` que no existe. */
function testInicio(ir: GenerationIR): string {
  return `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:${nombrePaquete(ir)}/pantallas/inicio.dart';

void main() {
  testWidgets('la pantalla de inicio se muestra', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: InicioPantalla()));
    expect(find.byType(InicioPantalla), findsOneWidget);
  });
}
`;
}

// ---------------------------------------------------------------------------
// lib/config/api.dart
// ---------------------------------------------------------------------------

function apiConfig(): string {
  return `class ApiConfig {
  static const String baseUrl = 'http://10.0.2.2:8080';
}
`;
}

// ---------------------------------------------------------------------------
// lib/voz/transcriptor.dart  (Bug 3 corregido)
// ---------------------------------------------------------------------------

function transcriptor(): string {
  return `import 'dart:io';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:whisper_flutter_new/whisper_flutter_new.dart';

const _modelo = 'ggml-base-q5_1.bin';

/// Transcriptor offline. Singleton: el modelo se carga una vez.
///
/// El modelo se distribuye dentro del APK/IPA en assets/models/ y en el
/// primer arranque se copia al directorio de documentos del dispositivo,
/// que es la única ruta de fichero que whisper.cpp puede abrir. Los
/// arranques siguientes son instantáneos porque el fichero ya existe.
///
/// Bug 3 fix — API whisper_flutter_new ^1.0.1:
///   Whisper(model: WhisperModel.base, modelDir: '<carpeta>')
/// La versión anterior usaba WhisperModel.custom + modelPath, que no
/// existen en ^1.0.1 y producen "no constant named 'custom'".
class Transcriptor {
  static Whisper? _w;

  static Future<String> _dir() async {
    final d = await getApplicationDocumentsDirectory();
    return '\${d.path}/whisper';
  }

  static Future<String> rutaModelo() async => '\${await _dir()}/$_modelo';

  static Future<bool> modeloDisponible() async =>
      File(await rutaModelo()).existsSync();

  /// Copia el modelo desde los assets al almacenamiento interno del
  /// dispositivo. Solo actúa la primera vez; si el fichero ya existe
  /// devuelve inmediatamente.
  static Future<void> prepararDesdeAssets() async {
    final destino = await rutaModelo();
    if (File(destino).existsSync()) return;
    final carpeta = Directory(await _dir());
    if (!carpeta.existsSync()) carpeta.createSync(recursive: true);
    final data = await rootBundle.load('assets/models/$_modelo');
    final bytes = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    await File(destino).writeAsBytes(bytes, flush: true);
  }

  static Future<void> _init() async {
    if (_w != null) return;
    _w = Whisper(model: WhisperModel.base, modelDir: await _dir());
  }

  static Future<String> transcribir(String audioPath) async {
    try {
      if (!await modeloDisponible()) return '';
      await _init();
      final r = await _w!.transcribe(
        transcribeRequest: TranscribeRequest(audio: audioPath, isTranslate: false),
      );
      return r.text.trim();
    } catch (e) {
      // ignore: avoid_print
      print('[Transcriptor] \$e');
      return '';
    }
  }
}
`;
}

// ---------------------------------------------------------------------------
// lib/voz/grabadora.dart
// ---------------------------------------------------------------------------

function grabadora(): string {
  return `import 'dart:io';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';

/// Graba audio en WAV 16 kHz mono (formato requerido por Whisper).
class Grabadora {
  final AudioRecorder _r = AudioRecorder();
  String? _path;

  bool get grabando => _path != null;

  Future<bool> iniciar() async {
    if (!(await Permission.microphone.request()).isGranted) return false;
    final tmp = await getTemporaryDirectory();
    _path = '\${tmp.path}/w_\${DateTime.now().millisecondsSinceEpoch}.wav';
    await _r.start(
      const RecordConfig(encoder: AudioEncoder.wav, numChannels: 1, sampleRate: 16000),
      path: _path!,
    );
    return true;
  }

  Future<String?> detener() async {
    if (_path == null) return null;
    final p = _path!;
    _path = null;
    await _r.stop();
    await Future<void>.delayed(const Duration(milliseconds: 80));
    return File(p).existsSync() ? p : null;
  }

  void dispose() => _r.dispose();
}
`;
}

// ---------------------------------------------------------------------------
// lib/widgets/campo_con_voz.dart
// ---------------------------------------------------------------------------

function campoConVoz(): string {
  return `import 'package:flutter/material.dart';
import '../voz/grabadora.dart';
import '../voz/transcriptor.dart';

enum _E { inactivo, grabando, transcribiendo }

/// TextFormField con botón de micrófono para dictado offline (Whisper).
class CampoConVoz extends StatefulWidget {
  final TextEditingController controller;
  final String label;
  final bool obligatorio;

  const CampoConVoz({
    super.key,
    required this.controller,
    required this.label,
    this.obligatorio = false,
  });

  @override
  State<CampoConVoz> createState() => _CampoConVozState();
}

class _CampoConVozState extends State<CampoConVoz> {
  final _g = Grabadora();
  _E _e = _E.inactivo;

  @override
  void dispose() { _g.dispose(); super.dispose(); }

  Future<void> _tap() async {
    if (_e == _E.inactivo) {
      if (!await _g.iniciar()) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Permiso de micrófono denegado.')),
          );
        }
        return;
      }
      if (mounted) setState(() => _e = _E.grabando);
    } else if (_e == _E.grabando) {
      setState(() => _e = _E.transcribiendo);
      try {
        final ruta = await _g.detener();
        if (ruta == null) return;
        final txt = await Transcriptor.transcribir(ruta);
        if (mounted && txt.isNotEmpty) {
          widget.controller.text = txt;
          widget.controller.selection =
              TextSelection.fromPosition(TextPosition(offset: txt.length));
        }
      } finally {
        if (mounted) setState(() => _e = _E.inactivo);
      }
    }
  }

  Widget _icon() {
    switch (_e) {
      case _E.grabando:
        return const Icon(Icons.stop_circle, color: Colors.red);
      case _E.transcribiendo:
        return const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2));
      case _E.inactivo:
        return const Icon(Icons.mic_none);
    }
  }

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: widget.controller,
      decoration: InputDecoration(
        labelText: widget.label,
        border: const OutlineInputBorder(),
        suffixIcon: IconButton(
          tooltip: _e == _E.grabando ? 'Parar y transcribir' : 'Dictar',
          onPressed: _e == _E.transcribiendo ? null : _tap,
          icon: _icon(),
        ),
      ),
      validator: widget.obligatorio
          ? (v) => v == null || v.trim().isEmpty ? 'Requerido' : null
          : null,
    );
  }
}
`;
}

// ---------------------------------------------------------------------------
// Modelo Dart
// ---------------------------------------------------------------------------

function listaFromJson(c: Campo): string {
  const elemento = c.dt === 'int' ? '(e as num).toInt()' : 'e as String';
  return `(json['${c.name}'] as List? ?? const []).map((e) => ${elemento}).toList()`;
}

function modelo(entity: EntityIR, entities: EntityIR[]): string {
  const cs = campos(entity, entities);
  const name = entity.className;

  const decls = cs.map(c => `  final ${tipoCampo(c)} ${c.name};`).join('\n');
  const params = cs.map(c => c.isNullable ? `    this.${c.name},` : `    required this.${c.name},`).join('\n');
  const fjLines = cs.map(c => `      ${c.name}: ${c.esLista ? listaFromJson(c) : fromJson(c.name, c.dt, c.isNullable)},`).join('\n');
  const tjLines = cs.map(c => `      '${c.name}': ${c.name},`).join('\n');

  return `class ${name} {
${decls}

  const ${name}({
${params}
  });

  factory ${name}.fromJson(Map<String, dynamic> json) => ${name}(
${fjLines}
  );

  Map<String, dynamic> toJson() => {
${tjLines}
  };
}
`;
}

// ---------------------------------------------------------------------------
// Servicio REST
// ---------------------------------------------------------------------------

function servicio(entity: EntityIR, entities: EntityIR[]): string {
  const name = entity.className;
  const sn   = snake(name);
  const idt  = idDT(entity);
  const req  = campos(entity, entities).filter(c => c.inRequest);
  const ps   = req.map(c => `    required ${tipoCampo(c)} ${c.name},`).join('\n');
  const bd   = req.map(c => `        '${c.name}': ${c.name},`).join('\n');
  // Dart no admite una lista de parámetros con nombre vacía: `crear({})` no compila.
  const crearParams = req.length > 0 ? `{\n${ps}\n  }` : '';
  const actualizarParams = req.length > 0 ? `, {\n${ps}\n  }` : '';

  return `import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api.dart';
import '../modelos/${sn}.dart';

class ${name}Servicio {
  static const _b = '\${ApiConfig.baseUrl}/api/${entity.restPath}';

  static Future<List<${name}>> listar() async {
    final r = await http.get(Uri.parse(_b));
    _ok(r, 200);
    return ((jsonDecode(r.body) as Map)['content'] as List)
        .map((e) => ${name}.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  static Future<${name}> obtener(${idt} id) async {
    final r = await http.get(Uri.parse('\$_b/\$id'));
    _ok(r, 200);
    return ${name}.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  static Future<${name}> crear(${crearParams}) async {
    final r = await http.post(Uri.parse(_b),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
${bd}
      }),
    );
    _ok(r, 201);
    return ${name}.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  static Future<${name}> actualizar(${idt} id${actualizarParams}) async {
    final r = await http.put(Uri.parse('\$_b/\$id'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
${bd}
      }),
    );
    _ok(r, 200);
    return ${name}.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  static Future<void> eliminar(${idt} id) async {
    _ok(await http.delete(Uri.parse('\$_b/\$id')), 204);
  }

  static void _ok(http.Response r, int exp) {
    if (r.statusCode != exp) throw Exception('HTTP \${r.statusCode}: \${r.body}');
  }
}
`;
}

// ---------------------------------------------------------------------------
// Pantalla lista
// ---------------------------------------------------------------------------

function lista(entity: EntityIR, entities: EntityIR[]): string {
  const name = entity.className;
  const sn   = snake(name);
  const idt  = idDT(entity);
  const todos = camposDeEntidad(entity, entities);
  const df   = todos.find(f => javaToDart(f.javaType) === 'String')
             ?? todos[0]
             ?? entity.identifier;

  return `import 'package:flutter/material.dart';
import '../modelos/${sn}.dart';
import '../servicios/${sn}_servicio.dart';
import '${sn}_formulario.dart';

class ${name}ListaPantalla extends StatefulWidget {
  const ${name}ListaPantalla({super.key});
  @override State<${name}ListaPantalla> createState() => _S();
}

class _S extends State<${name}ListaPantalla> {
  List<${name}> _items = [];
  bool _cargando = true;
  String? _err;

  @override void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _cargando = true; _err = null; });
    try {
      final items = await ${name}Servicio.listar();
      setState(() { _items = items; _cargando = false; });
    } catch (e) {
      setState(() { _err = e.toString(); _cargando = false; });
    }
  }

  Future<void> _del(${idt} id) async {
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: const Text('Eliminar'), content: const Text('¿Eliminar este registro?'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
        TextButton(onPressed: () => Navigator.pop(context, true),  child: const Text('Eliminar')),
      ],
    ));
    if (ok != true) return;
    try { await ${name}Servicio.eliminar(id); await _load(); }
    catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: \$e'))); }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${name}'),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _load)]),
      body: _cargando ? const Center(child: CircularProgressIndicator())
          : _err != null ? Center(child: Text(_err!, style: const TextStyle(color: Colors.red)))
          : _items.isEmpty ? const Center(child: Text('No hay registros'))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView.builder(
                itemCount: _items.length,
                itemBuilder: (_, i) {
                  final item = _items[i];
                  return ListTile(
                    title: Text(item.${df.name}${df.nullable ? '?' : ''}.toString()${df.nullable ? " ?? ''" : ''}),
                    subtitle: Text('ID: \${item.${entity.identifier.name}}'),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      IconButton(icon: const Icon(Icons.edit), onPressed: () async {
                        await Navigator.push(context, MaterialPageRoute(
                          builder: (_) => ${name}FormularioPantalla(item: item)));
                        await _load();
                      }),
                      IconButton(icon: const Icon(Icons.delete, color: Colors.red),
                        onPressed: () => _del(item.${entity.identifier.name})),
                    ]),
                  );
                },
              ),
            ),
      floatingActionButton: FloatingActionButton(
        onPressed: () async {
          await Navigator.push(context, MaterialPageRoute(builder: (_) => const ${name}FormularioPantalla()));
          await _load();
        },
        child: const Icon(Icons.add),
      ),
    );
  }
}
`;
}

// ---------------------------------------------------------------------------
// Formulario (campos String → CampoConVoz, otros → TextFormField)
// ---------------------------------------------------------------------------

function formulario(entity: EntityIR, entities: EntityIR[]): string {
  const name = entity.className;
  const sn   = snake(name);
  const idt  = idDT(entity);
  const req  = campos(entity, entities).filter(c => c.inRequest);
  const vozImport = req.some(c => c.dt === 'String' && !c.esLista) ? "import '../widgets/campo_con_voz.dart';" : '';

  const ctrls   = req.map(c => c.dt === 'bool'
    ? `  bool${c.isNullable ? '?' : ''} _c${cap(c.name)} = ${c.isNullable ? 'null' : 'false'};`
    : `  late TextEditingController _c${cap(c.name)};`).join('\n');
  const initC   = req.map(c => c.esLista
    ? `    _c${cap(c.name)} = TextEditingController(text: widget.item?.${c.name}.join(', ') ?? '');`
    : c.dt === 'bool'
    ? `    _c${cap(c.name)} = widget.item?.${c.name}${c.isNullable ? '' : ' ?? false'};`
    : `    _c${cap(c.name)} = TextEditingController(text: widget.item?.${c.name}${c.isNullable ? '?' : ''}.toString() ?? '');`).join('\n');
  const dispC   = req.filter(c => c.dt !== 'bool').map(c => `    _c${cap(c.name)}.dispose();`).join('\n');

  const fields  = req.map(c => {
    const ctrl = `_c${cap(c.name)}`;
    if (c.esLista) {
      return `          TextFormField(controller: ${ctrl},
            decoration: const InputDecoration(labelText: '${c.label}', border: OutlineInputBorder())),\n          const SizedBox(height: 16),`;
    }
    if (c.dt === 'bool') {
      const value = c.isNullable ? `${ctrl} ?? false` : ctrl;
      return `          SwitchListTile(title: const Text('${c.label}'), value: ${value},
            onChanged: (value) => setState(() => ${ctrl} = value)),`;
    }
    if (c.dt === 'String') {
      return `          CampoConVoz(controller: ${ctrl}, label: '${c.label}', obligatorio: ${!c.isNullable}),\n          const SizedBox(height: 16),`;
    }
    const kb = c.dt === 'double' ? 'const TextInputType.numberWithOptions(decimal: true)'
             : c.dt === 'int'    ? 'TextInputType.number'
             : 'TextInputType.text';
    const v = c.isNullable ? '' : `validator: (v) => v == null || v.trim().isEmpty ? 'Requerido' : null,`;
    return `          TextFormField(controller: ${ctrl}, keyboardType: ${kb},
            decoration: const InputDecoration(labelText: '${c.label}', border: OutlineInputBorder()),
            ${v}),\n          const SizedBox(height: 16),`;
  }).join('\n');

  const saveArgs = req.map(c => {
    const t = `_c${cap(c.name)}.text.trim()`;
    if (c.esLista) {
      const aEntero = c.dt === 'int' ? '.map(int.parse)' : '';
      return `          ${c.name}: _c${cap(c.name)}.text.split(',').map((v) => v.trim()).where((v) => v.isNotEmpty)${aEntero}.toList(),`;
    }
    if (c.dt === 'bool') return `          ${c.name}: _c${cap(c.name)},`;
    if (c.dt === 'int')    return c.isNullable ? `          ${c.name}: ${t}.isEmpty ? null : int.tryParse(${t}),`    : `          ${c.name}: int.parse(${t}),`;
    if (c.dt === 'double') return c.isNullable ? `          ${c.name}: ${t}.isEmpty ? null : double.tryParse(${t}),` : `          ${c.name}: double.parse(${t}),`;
    return c.isNullable ? `          ${c.name}: ${t}.isEmpty ? null : ${t},` : `          ${c.name}: ${t},`;
  }).join('\n');

  return `import 'package:flutter/material.dart';
import '../modelos/${sn}.dart';
import '../servicios/${sn}_servicio.dart';
${vozImport}

class ${name}FormularioPantalla extends StatefulWidget {
  final ${name}? item;
  const ${name}FormularioPantalla({super.key, this.item});
  @override State<${name}FormularioPantalla> createState() => _S();
}

class _S extends State<${name}FormularioPantalla> {
  final _form = GlobalKey<FormState>();
  bool _busy = false;
${ctrls}

  @override void initState() { super.initState();
${initC}
  }
  @override void dispose() {
${dispC}
    super.dispose();
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      if (widget.item == null) {
        await ${name}Servicio.crear(
${saveArgs}
        );
      } else {
        await ${name}Servicio.actualizar(widget.item!.${entity.identifier.name},
${saveArgs}
        );
      }
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: \$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.item == null ? 'Crear ${name}' : 'Editar ${name}')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Form(key: _form, child: Column(children: [
${fields}
          SizedBox(width: double.infinity, child: ElevatedButton(
            onPressed: _busy ? null : _save,
            child: _busy ? const CircularProgressIndicator()
                         : Text(widget.item == null ? 'Crear' : 'Guardar'),
          )),
        ])),
      ),
    );
  }
}
`;
}

// ---------------------------------------------------------------------------
// Pantalla inicio
// ---------------------------------------------------------------------------

function inicio(entities: EntityIR[], ir: GenerationIR): string {
  const imports = entities.map(e => `import '${snake(e.className)}_lista.dart';`).join('\n');
  const cards   = entities.map(e => `      _Card(titulo: '${e.className}', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ${e.className}ListaPantalla()))),`).join('\n');

  return `import 'package:flutter/material.dart';
${imports}

class InicioPantalla extends StatelessWidget {
  const InicioPantalla({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${dartTexto(ir.project.name)}')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
${cards}
      ]),
    );
  }
}

class _Card extends StatelessWidget {
  final String titulo; final VoidCallback onTap;
  const _Card({required this.titulo, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Card(margin: const EdgeInsets.only(bottom: 12),
      child: ListTile(
        leading: const Icon(Icons.table_rows_outlined, size: 32),
        title: Text(titulo, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}
`;
}

// ---------------------------------------------------------------------------
// main.dart (con verificación de modelo Whisper al arrancar)
// ---------------------------------------------------------------------------

function main_(ir: GenerationIR): string {
  return `import 'package:flutter/material.dart';
import 'pantallas/inicio.dart';
import 'voz/transcriptor.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${dartTexto(ir.project.name)}',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue), useMaterial3: true),
      home: const _Shell(),
    );
  }
}

/// Copia el modelo Whisper desde assets al disco la primera vez que
/// arranca la app. Mientras dura la copia se muestra una pantalla de
/// espera; los arranques siguientes son instantáneos porque el fichero
/// ya existe. Si la copia falla la app sigue funcionando sin dictado.
class _Shell extends StatefulWidget {
  const _Shell();
  @override State<_Shell> createState() => _ShellState();
}
class _ShellState extends State<_Shell> {
  bool _listo = false;

  @override
  void initState() { super.initState(); _preparar(); }

  Future<void> _preparar() async {
    try { await Transcriptor.prepararDesdeAssets(); } catch (_) {}
    if (mounted) setState(() => _listo = true);
  }

  @override
  Widget build(BuildContext context) {
    if (!_listo) {
      return const Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(),
              SizedBox(height: 20),
              Text('Preparando modelo de voz…'),
              SizedBox(height: 8),
              Text('(solo ocurre la primera vez)',
                  style: TextStyle(fontSize: 12, color: Colors.grey)),
            ],
          ),
        ),
      );
    }
    return const InicioPantalla();
  }
}
`;
}

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------

export function generateFlutter(ir: GenerationIR): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const allEntities = ir.entities;
  const entities = ir.entities.filter(e => !e.isAbstract);

  files.push({ path: 'pubspec.yaml',                   content: pubspec(ir) });
  files.push({ path: 'README.md',                      content: readme(ir) });
  files.push({ path: 'android/app/src/main/AndroidManifest.xml', content: manifiestoAndroid(ir) });
  files.push({ path: 'test/widget_test.dart',          content: testInicio(ir) });
  // Carpeta de assets para el modelo Whisper. El fichero real (55 MB) lo
  // pone el desarrollador a mano; el .gitkeep garantiza que la ruta exista
  // en el ZIP y Flutter no falle al leer el directorio declarado en pubspec.
  files.push({ path: 'assets/models/.gitkeep',         content: '' });
  files.push({ path: 'lib/main.dart',                  content: main_(ir) });
  files.push({ path: 'lib/config/api.dart',            content: apiConfig() });
  files.push({ path: 'lib/voz/grabadora.dart',         content: grabadora() });
  files.push({ path: 'lib/voz/transcriptor.dart',      content: transcriptor() });
  files.push({ path: 'lib/widgets/campo_con_voz.dart', content: campoConVoz() });

  for (const e of entities) {
    const sn = snake(e.className);
    files.push({ path: `lib/modelos/${sn}.dart`,              content: modelo(e, allEntities) });
    files.push({ path: `lib/servicios/${sn}_servicio.dart`,   content: servicio(e, allEntities) });
    files.push({ path: `lib/pantallas/${sn}_lista.dart`,      content: lista(e, allEntities) });
    files.push({ path: `lib/pantallas/${sn}_formulario.dart`, content: formulario(e, allEntities) });
  }

  files.push({ path: 'lib/pantallas/inicio.dart', content: inicio(entities, ir) });

  return files;
}
