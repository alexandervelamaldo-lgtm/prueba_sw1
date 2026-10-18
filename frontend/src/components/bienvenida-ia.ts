/**
 * El saludo con el que la IA abre el Modo IA cuando se pulsa su avatar.
 *
 * Se arma aquí, sin llamar al modelo: es lo primero que se oye y no puede
 * tardar ni gastar tokens. Tampoco se guarda en el historial del hilo; es una
 * bienvenida, no un turno de la conversación.
 */
export function textoDeBienvenida(datos: { nombre: string; proyecto: string; ahora?: Date }): string {
  const hora = (datos.ahora ?? new Date()).getHours();
  const saludo = hora >= 6 && hora < 12 ? 'Buenos días' : hora >= 12 && hora < 20 ? 'Buenas tardes' : 'Buenas noches';
  const nombre = datos.nombre.trim();
  return `¡${saludo}${nombre ? `, ${nombre}` : ''}! Soy tu asistente en «${datos.proyecto}». Puedo crear y cambiar clases, revisar tu diagrama o responder lo que quieras saber. ¿Qué quieres modelar hoy?`;
}
