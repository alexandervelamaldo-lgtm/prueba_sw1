import type { ClassDiagram } from '@app/shared';

/**
 * EXPLICACIÓN GENERAL DEL MÓDULO:
 * Este archivo es un "adaptador" o "escudo" (capa anticorrupción) para conectar
 * nuestro programa con un sistema externo llamado "Architech Enterprise".
 *
 * ¿Por qué existe este archivo así?
 * Porque la empresa o cliente aún no ha definido cómo funciona exactamente su sistema
 * (faltan datos como qué contraseña usa o cómo quiere recibir los datos).
 * En lugar de inventar algo que luego falle, este código prepara "el hueco"
 * para que cuando nos den los datos reales, solo haya que cambiar este archivo.
 */

// Define la estructura de datos que representa un Proyecto en el sistema externo.
export interface ArchitechProject {
  externalId: string; // El identificador único del proyecto en el sistema externo.
  name: string;       // El nombre del proyecto.
  url?: string;       // La dirección web para ver el proyecto (opcional).
}

// Define la "plantilla" o contrato que debe cumplir la conexión con Architech:
// Cualquier cliente de Architech DEBE saber publicar e importar diagramas.
export interface ArchitechClient {
  readonly configured: boolean; // Nos dice si está listo para usarse (true/false).
  /** Publica el diagrama local enviándolo a Architech. */
  publish(diagram: ClassDiagram, projectId: string): Promise<ArchitechProject>;
  /** Importa un diagrama que ya existe en Architech para traerlo a nuestro programa. */
  import(externalId: string): Promise<ClassDiagram>;
}

/**
 * MENSAGE DE ERROR PERSONALIZADO:
 * Es una alarma especial que se activa cuando alguien intenta usar la integración
 * sin haber configurado las claves o la dirección web requeridas.
 */
export class ArchitechNotConfiguredError extends Error {
  readonly status = 501; // Código técnico de error (501 = No implementado / No configurado).
  readonly code = 'ARCHITECH_NO_CONFIGURADO';

  constructor() {
    super(
      'La integración con Architech Enterprise no está configurada. ' +
        'Falta ARCHITECH_BASE_URL y ARCHITECH_API_KEY, y el contrato de su API ' +
        'sigue pendiente de confirmar (Q1–Q4).',
    );
  }
}

/**
 * CLIENTE DESCONECTADO / POR DEFECTO:
 * Esta clase se encarga de responder "No estoy listo" si intentas hacer algo.
 * Es una medida de seguridad: prefiere dar un aviso claro de "Falta configuración"
 * en lugar de fingir que guardó el trabajo cuando en realidad no lo hizo.
 */
export class UnconfiguredArchitechClient implements ArchitechClient {
  readonly configured = false; // Indica explícitamente que NO está configurado.

  // Si intentas publicar un diagrama, detiene el proceso y lanza la alarma de error.
  async publish(): Promise<ArchitechProject> {
    throw new ArchitechNotConfiguredError();
  }

  // Si intentas importar un diagrama, detiene el proceso y lanza la alarma de error.
  async import(): Promise<ClassDiagram> {
    throw new ArchitechNotConfiguredError();
  }
}

/**
 * FUNCIÓN SELECTORA (FÁBRICA):
 * Es la encargada de revisar las credenciales al arrancar el programa:
 * 1. Revisa si le pasaron la dirección web (baseUrl) y la clave de acceso (apiKey).
 * 2. Si falta alguna de las dos, devuelve el cliente no configurado (`UnconfiguredArchitechClient`).
 * 3. En el futuro, cuando nos den el contrato real, aquí se creará el cliente verdadero.
 */
export function createArchitechClient(config: {
  architechBaseUrl?: string;
  architechApiKey?: string;
}): ArchitechClient {
  if (!config.architechBaseUrl || !config.architechApiKey) {
    return new UnconfiguredArchitechClient();
  }
  // Cuando se conozca el contrato, la implementación real se construye aquí y
  // el resto del servicio no cambia: solo depende de `ArchitechClient`.
  return new UnconfiguredArchitechClient();
}