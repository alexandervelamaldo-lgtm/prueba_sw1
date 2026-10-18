-- Esquema de la herramienta.
--
-- Se aplica solo al arrancar con DATABASE_URL. Todo es `if not exists` porque
-- esto corre en cada arranque: es un esquema idempotente, no una migración.
-- Cuando el proyecto tenga que cambiar una columna existente hará falta una
-- herramienta de migraciones de verdad; hasta entonces, esto evita el paso
-- manual de «entra por psql y pega el fichero» que siempre se olvida.
--
-- Los nombres van en español porque el resto del dominio también.

-- Usuarios ------------------------------------------------------------------
--
-- `hash` es scrypt sobre la contraseña con `sal`, exactamente como en la
-- implementación de fichero. La base de datos no ve nunca la contraseña.

create table if not exists usuarios (
  id          uuid primary key,
  correo      text not null unique,
  nombre      text not null,
  sal         text not null,
  hash        text not null,
  creado_en   timestamptz not null default now()
);

-- Código de recuperación de un solo uso.
--
-- Va con `alter table` y no dentro del `create table` de arriba a propósito: ese
-- `create` lleva `if not exists`, así que en una base que ya existía no habría
-- añadido nada y estas dos columnas no aparecerían nunca. `add column if not
-- exists` sí es idempotente de verdad y sirve para los dos casos.
--
-- Son `null` cuando no hay código pendiente. Se guarda el hash, igual que con la
-- contraseña: quien lea la tabla no puede recuperar cuentas con lo que ve.
alter table usuarios add column if not exists sal_recuperacion  text;
alter table usuarios add column if not exists hash_recuperacion text;

-- Proyectos -----------------------------------------------------------------

create table if not exists proyectos (
  id             uuid primary key,
  nombre         text not null,
  descripcion    text not null default '',
  propietario_id uuid not null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- `propietario_id` y `miembros.usuario_id` NO llevan clave foránea contra
-- `usuarios`, y no es un descuido.
--
-- El almacén de proyectos y el proveedor de identidad son dos interfaces
-- independientes (`ProjectStore`, `IdentityProvider`), y esa independencia es
-- deliberada: la identidad definitiva la aportará Architech Enterprise
-- (Arquitectura §2.9, decisión D8), con sus usuarios fuera de esta base de
-- datos. Una foránea aquí haría imposible esa combinación —proyectos en
-- PostgreSQL, usuarios en el proveedor externo— justo cuando toque hacerla.
--
-- Dentro de un mismo almacén sí se usan, porque ahí no hay frontera que cruzar.

create table if not exists miembros (
  proyecto_id uuid not null references proyectos(id) on delete cascade,
  usuario_id  uuid not null,
  rol         text not null check (rol in ('owner', 'editor', 'viewer')),
  primary key (proyecto_id, usuario_id)
);

-- Listar «mis proyectos» es la consulta de la pantalla inicial y va por
-- usuario, que es justo el lado por el que la clave primaria no ayuda.
create index if not exists miembros_por_usuario on miembros (usuario_id);

-- Documentos colaborativos --------------------------------------------------
--
-- `estado` es el documento Yjs entero codificado con `Y.encodeStateAsUpdate`:
-- binario opaco, no consultable. Vive aparte de `proyectos` porque los ciclos
-- de vida no se parecen —los metadatos cambian una vez al mes y el documento
-- cada dos segundos— y porque una fila con un `bytea` grande reescrito
-- constantemente es exactamente lo que no conviene tener pegado a la tabla que
-- se consulta para pintar la lista de proyectos.
--
-- La clave es `text` y no `uuid`, y sin foránea contra `proyectos`: para el
-- almacén de documentos el identificador de sala es una cadena opaca. Hoy
-- coincide con el del proyecto, pero `DocumentStore` no lo exige y las pruebas
-- usan identificadores sintéticos. El borrado no queda huérfano porque
-- `RoomManager.discard()` lo hace explícito al eliminar el proyecto.

create table if not exists documentos (
  sala_id        text primary key,
  estado         bytea not null,
  actualizado_en timestamptz not null default now()
);

-- Tablón del proyecto -------------------------------------------------------
--
-- El módulo de comunicación interna: un hilo por proyecto, con mensajes de
-- texto y notas de voz. No vive en el documento Yjs porque un hilo no es un
-- CRDT; ver la cabecera de `storage/tablon.ts`.
--
-- `autor_id` es `text` y sin foránea contra `usuarios`, por la misma razón que
-- `miembros.usuario_id`: la identidad definitiva la aportará un proveedor
-- externo (decisión D8) y sus identificadores no estarán en esta base.

create table if not exists tablon_mensajes (
  id          uuid primary key,
  proyecto_id uuid not null references proyectos(id) on delete cascade,
  autor_id    text not null,
  -- Ordena el hilo; no cambia nunca.
  secuencia   bigint not null,
  -- Cursor del sondeo; vuelve a asignarse al retirar. Son dos cosas distintas
  -- y usar una sola rompe el orden del hilo o la entrega de las retiradas.
  version     bigint not null,
  creado_en   timestamptz not null default now(),
  tipo        text not null check (tipo in ('texto', 'voz')),
  texto       text not null default '',
  audio_tipo  text check (audio_tipo in ('audio/webm', 'audio/ogg', 'audio/mp4')),
  audio_bytes integer,
  audio_ms    integer,
  retirado    boolean not null default false,
  -- Dos mensajes del mismo proyecto no pueden compartir número: si el contador
  -- se corrompiera, es preferible que la inserción falle a que el hilo empiece
  -- a barajarse sin que nadie lo note.
  unique (proyecto_id, secuencia),
  unique (proyecto_id, version)
);

-- Las tres consultas del tablón van todas por proyecto y luego por uno de los
-- dos números. Sin estos índices, sondear cada pocos segundos significa un
-- recorrido completo de la tabla por cada cliente conectado.
create index if not exists tablon_por_secuencia on tablon_mensajes (proyecto_id, secuencia);
create index if not exists tablon_por_version   on tablon_mensajes (proyecto_id, version);

-- Los bytes del audio, en su propia tabla.
--
-- Mismo motivo que separa `documentos` de `proyectos`: una columna `bytea`
-- grande pegada a la tabla que se consulta cada pocos segundos para sondear es
-- exactamente lo que no conviene. Aquí se lee una vez, cuando alguien pulsa
-- reproducir. El `on delete cascade` es lo que hace que retirar un mensaje o
-- borrar el proyecto se lleve el audio sin un segundo borrado que se pueda
-- olvidar.

create table if not exists tablon_audios (
  mensaje_id uuid primary key references tablon_mensajes(id) on delete cascade,
  datos      bytea not null
);

-- Contador por proyecto.
--
-- Va en su propia tabla y no se calcula con `max(version) + 1`: entre el
-- `select` y el `insert` caben dos mensajes simultáneos, y los dos se
-- llevarían el mismo número. Un `insert … on conflict do update … returning`
-- sobre esta fila es una sola sentencia atómica, y la restricción de unicidad
-- de arriba es la red por si alguna vez deja de serlo.

create table if not exists tablon_contadores (
  proyecto_id uuid primary key references proyectos(id) on delete cascade,
  contador    bigint not null default 0
);

-- Historial del Modo IA: un hilo por proyecto, compartido por todos sus
-- integrantes, no uno por usuario.
--
-- `usuario_id` identifica quién escribió cada fila de rol `user` —igual que
-- `autor_id` en `tablon_mensajes`, y sin clave foránea por la misma razón
-- (decisión D8): la identidad definitiva la da un proveedor externo. Queda
-- `null` en las filas de rol `assistant`, que no tienen autor humano. El hilo
-- se filtra por `hilo_usuario_id` (más abajo), no por esta columna.

create table if not exists conversaciones_ia (
  id          bigserial primary key,
  proyecto_id uuid not null references proyectos(id) on delete cascade,
  usuario_id  text,
  rol         text not null check (rol in ('user', 'assistant')),
  contenido   text not null,
  creado_en   timestamptz not null default now()
);

-- `not null` de una versión anterior, en la que cada fila (también las del
-- asistente) llevaba el usuario del hilo al que pertenecía. Idempotente igual
-- que los `add column if not exists` de más arriba: en una base ya migrada
-- esta sentencia no encuentra la restricción y no hace nada.
alter table conversaciones_ia alter column usuario_id drop not null;

-- Índice de una versión anterior; lo sustituye `conversaciones_por_hilo`.
drop index if exists conversaciones_por_usuario;

-- `tipo` distingue una respuesta de las de siempre —alguien preguntó, la IA
-- contestó— de un comentario que la IA soltó sola al vigilar el diagrama
-- (`ai/vigilancia.ts`). `default 'respuesta'` cubre tanto las filas que ya
-- existían antes de esta columna como cualquier fila nueva de rol `user`, que
-- nunca necesita decir que es una `observacion`: solo las del asistente lo son,
-- y solo cuando nadie le escribió primero.
alter table conversaciones_ia add column if not exists tipo
  text not null default 'respuesta';

-- Un hilo por integrante. `hilo_usuario_id` es el dueño del hilo y va en
-- todas las filas, también en las del asistente; `usuario_id` sigue siendo
-- quién escribió la fila. Se añade como columna nueva y no se rellena a partir
-- de `usuario_id`: las filas de la época del hilo compartido mezclaban a
-- varios integrantes, sus respuestas no dicen a quién contestaban, y quedan
-- con `null`, fuera de todo hilo. Ver `storage/conversaciones.ts`.
alter table conversaciones_ia add column if not exists hilo_usuario_id text;

drop index if exists conversaciones_por_proyecto;
create index if not exists conversaciones_por_hilo
  on conversaciones_ia (proyecto_id, hilo_usuario_id, id);

-- Memoria resumida del Modo IA: lo que salió de la ventana de 20 turnos de un
-- hilo, resumido por la IA antes de podarlo. Una fila por hilo, que se
-- sobrescribe; tabla aparte porque no es un mensaje más de la conversación.
-- `usuario_id` sin clave foránea, por la misma razón que `conversaciones_ia`
-- (decisión D8).
-- Control de costos: tokens de la IA que gastó cada usuario cada día (UTC).
-- Ver `storage/uso-ia.ts`. Sin clave foránea a usuarios (decisión D8).
create table if not exists uso_ia (
  usuario_id text not null,
  dia        date not null,
  tokens     bigint not null default 0,
  primary key (usuario_id, dia)
);

create table if not exists resumenes_ia (
  proyecto_id    uuid not null references proyectos(id) on delete cascade,
  usuario_id     text not null,
  resumen        text not null,
  actualizado_en timestamptz not null default now(),
  primary key (proyecto_id, usuario_id)
);

-- Versiones del proyecto -----------------------------------------------------
--
-- Puntos de control del documento: el estado Yjs entero (otra vez
-- `Y.encodeStateAsUpdate`, como en `documentos`) en el instante en que alguien
-- decidió guardarlo. Es lo que falta para poder volver atrás: `documentos`
-- solo guarda el estado *actual* y lo sobrescribe en cada guardado, así que
-- hoy no hay ningún sitio al que restaurar algo.
--
-- Va en su propia tabla y no como filas adicionales de `documentos` por el
-- mismo motivo que separó esa tabla de `proyectos`: aquí cada fila es un blob
-- grande que además no se sobrescribe nunca, se acumula. Mezclarlo con la fila
-- que se lee y escribe en cada guardado automático sería cargar ese camino
-- caliente con historia que casi nunca se consulta.
--
-- A diferencia de `tablon_mensajes` y `conversaciones_ia`, esta tabla no lleva
-- tope ni se poda sola: una versión la crea una persona a propósito, pulsando
-- «guardar versión», no una escritura automática en cada pulsación. El ritmo
-- de llegada es otro y podar en silencio invalidaría lo que esto existe para
-- ofrecer —volver a un punto concreto—, así que la poda, si algún día hace
-- falta, es una decisión de quien usa el proyecto, no del esquema.
--
-- `autor_id` no lleva clave foránea, por la misma razón que en `tablon_mensajes`
-- y `conversaciones_ia` (decisión D8).

create table if not exists versiones_proyecto (
  id          uuid primary key,
  proyecto_id uuid not null references proyectos(id) on delete cascade,
  estado      bytea not null,
  mensaje     text not null,
  autor_id    text not null,
  creado_en   timestamptz not null default now()
);

-- La única lectura es «las versiones de este proyecto, en orden de creación»;
-- `id` no es monótono (es un UUID aleatorio) y no sirve para ordenar por su
-- cuenta, así que entra como segunda clave solo para que el orden sea
-- determinista entre dos filas con el mismo instante.
create index if not exists versiones_por_proyecto
  on versiones_proyecto (proyecto_id, creado_en, id);
