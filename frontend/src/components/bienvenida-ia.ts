/**
 * El saludo con el que la IA abre el Modo IA cuando se pulsa su avatar.
 *
 * Se arma aquí, sin llamar al modelo: es lo primero que se oye y no puede
 * tardar ni gastar tokens. Tampoco se guarda en el historial del hilo; es una
 * bienvenida, no un turno de la conversación.
 */
export function textoDeBienvenida(datos: { nombre: string; ahora?: Date }): string {
  const hora = (datos.ahora ?? new Date()).getHours();
  const saludo = hora >= 6 && hora < 12 ? 'Buenos días' : hora >= 12 && hora < 20 ? 'Buenas tardes' : 'Buenas noches';
  const nombre = datos.nombre.trim();
  // Corta a propósito: un saludo y la pregunta. Enumerar lo que sabe hacer
  // alargaba lo primero que se oye, que es justo lo que menos debe tardar.
  return `¡${saludo}${nombre ? `, ${nombre}` : ''}! ¿En qué te puedo ayudar hoy?`;
}

/**
 * Si, al terminar de decir la bienvenida, el Modo IA enciende el micrófono
 * para escuchar la respuesta, como en una conversación. No lo hace si la
 * persona ya tomó la palabra (escribiendo, enviando algo o escuchando), si
 * cerró el panel, si solo puede mirar el proyecto o si el navegador no
 * reconoce voz: entonces se responde escribiendo, como siempre.
 */
export function debeEscucharTrasSaludo(estado: {
  montado: boolean;
  soloLectura: boolean;
  hayDictado: boolean;
  ocupado: boolean;
  escuchando: boolean;
  hayTexto: boolean;
}): boolean {
  return (
    estado.montado &&
    !estado.soloLectura &&
    estado.hayDictado &&
    !estado.ocupado &&
    !estado.escuchando &&
    !estado.hayTexto
  );
}

/**
 * En el modo conversación (el avatar pulsado y activo), si el Modo IA vuelve
 * a encender el micrófono: tras cada respuesta de la IA y tras un silencio
 * que apagó el micrófono, hasta que se vuelva a pulsar el avatar. Tras un
 * error del micrófono (sin permiso, sin micrófono) no insiste: sería un bucle.
 */
export function debeSeguirConversando(
  estado: Parameters<typeof debeEscucharTrasSaludo>[0] & { conversacion: boolean; huboError: boolean },
): boolean {
  return estado.conversacion && !estado.huboError && debeEscucharTrasSaludo(estado);
}
