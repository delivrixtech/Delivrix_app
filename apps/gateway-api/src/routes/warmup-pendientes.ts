// Ruta read-only de LOS PENDIENTES DEL OPERADOR: lo que el agente detectó y no puede resolver solo.
//
// Por qué hace falta: el agente ya sabe distinguir entre lo que arregla él (frenar un dominio que
// cruzó el umbral) y lo que necesita una persona (una semilla nueva, soltar cupo, una credencial).
// Lo segundo lo anota UNA vez, con su motivo, en vez de repetirlo cada 10 minutos — que es la
// diferencia entre un agente que colabora y uno que se vuelve ruido de fondo.
//
// Pero esa lista vivía solo en un archivo del inventario. El operador no la veía en ningún lado, o
// sea que el agente estaba pidiendo cosas al vacío. Una petición que nadie recibe no es una
// petición: es un log.
//
// Puramente observacional: no escribe, no ejecuta, no manda correo.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Pendiente } from "../agents/acciones-agente.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export const PENDIENTES_FILE = "warmup-pendientes.json";

export interface PendienteExpuesto extends Pendiente {
  /** Días que lleva abierto. `null` si la fecha no se pudo leer. */
  diasAbierto: number | null;
}

export interface PendientesSnapshot {
  generadoEn: string;
  abiertos: PendienteExpuesto[];
  resueltos: PendienteExpuesto[];
  nota?: string;
}

export interface WarmupPendientesDeps {
  workspace: Pick<OpenClawWorkspace, "readInventoryJson">;
  readBoundaryToken?: string;
  now?: () => Date;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
}

export async function handleWarmupPendientes(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupPendientesDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, { readBoundaryToken: deps.readBoundaryToken }, "warmup_pendientes");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const ahora = (deps.now ?? (() => new Date()))();

  try {
    const lista = (await deps.workspace.readInventoryJson<Pendiente[]>(PENDIENTES_FILE)) ?? [];
    const conEdad = lista.map((p) => ({ ...p, diasAbierto: dias(p.abiertoEn, ahora) }));
    json(response, 200, {
      generadoEn: ahora.toISOString(),
      // Los abiertos primero y ordenados por INSISTENCIA (cuántas veces el agente los volvió a
      // detectar), no por fecha: un pendiente que reapareció quince veces es más urgente que uno
      // viejo que se vio una sola vez.
      abiertos: conEdad.filter((p) => !p.resueltoEn).sort((a, b) => b.visto - a.visto),
      resueltos: conEdad.filter((p) => p.resueltoEn)
    } satisfies PendientesSnapshot);
  } catch (error) {
    // Archivo ausente (el agente todavía no anotó nada) es el caso NORMAL, no un error: lista
    // vacía con nota. Un 500 acá haría ver como roto un sistema que simplemente no tiene nada que
    // pedir.
    void deps.logger?.warn("warmup.pendientes_read_failed", "No se pudo leer los pendientes del warmup.", {
      message: error instanceof Error ? error.message : String(error)
    });
    json(response, 200, {
      generadoEn: ahora.toISOString(),
      abiertos: [],
      resueltos: [],
      nota: "todavía no hay pendientes anotados"
    } satisfies PendientesSnapshot);
  }
}

function dias(iso: string, ahora: Date): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((ahora.getTime() - t) / 86_400_000));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}
