// Qué versión y qué commit corre ESTA instancia.
//
// Hasta hoy no había forma de saberlo desde afuera: /health no decía ni versión ni commit, y el
// único camino era entrar por SSH y hacer `git rev-parse`. Con dos máquinas (laptop de desarrollo
// y Studio de producción) eso deja de ser un detalle: "¿esto que veo ya tiene el fix?" no puede
// contestarse mirando.
//
// La versión sale del CHANGELOG.md — su primer encabezado ES la versión. Una sola fuente que un
// humano escribe cuando decide que 1.0 pasó a 1.5, y que la máquina lee sin que nadie sincronice
// nada.

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Relativo AL MÓDULO, no al cwd: los servicios de launchd no arrancan desde la raíz del repo.
const CHANGELOG_PATH = fileURLToPath(new URL("../../../CHANGELOG.md", import.meta.url));

/** Lo que se le muestra al agente: las últimas versiones, no el histórico entero. */
const MAX_CHANGELOG_CHARS = 1200;

export interface BuildInfo {
  /** Del primer encabezado del CHANGELOG (ej. "1.0"). null si no se pudo leer. */
  version: string | null;
  /** Commit con el que ARRANCÓ este proceso. */
  commit: string | null;
  /** Las versiones más recientes del changelog, recortadas. */
  changelog: string | null;
}

/** Extrae la versión del primer encabezado. Puro y testeable. */
export function leerVersion(texto: string): string | null {
  const m = texto.match(/^#\s*v?([0-9]+\.[0-9]+[^\s—-]*)/m);
  return m ? m[1] : null;
}

// ponytail: el commit se resuelve UNA vez al arrancar. Si un deploy no reinicia el gateway (por
// ejemplo tocó solo el panel), el commit reportado queda viejo — pero entonces tampoco cambió el
// código del gateway, así que no miente sobre lo que corre. Si algún día importa, releerlo por
// mtime de .git/HEAD.
let commitCache: string | null | undefined;
function resolverCommit(): string | null {
  if (commitCache !== undefined) return commitCache;
  try {
    commitCache = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || null;
  } catch {
    commitCache = null; // sin git (tarball, contenedor): degrada, no rompe
  }
  return commitCache;
}

// Caché por mtime, mismo criterio que el system prompt: editar el CHANGELOG se toma solo, sin
// reiniciar el gateway. Es lo que hace que subir la versión sea un commit y nada más.
let cache: { mtimeMs: number; info: BuildInfo } | null = null;

export async function buildInfo(): Promise<BuildInfo> {
  const commit = resolverCommit();
  try {
    const { mtimeMs } = await stat(CHANGELOG_PATH);
    if (cache && cache.mtimeMs === mtimeMs) return { ...cache.info, commit };
    const texto = await readFile(CHANGELOG_PATH, "utf8");
    const info: BuildInfo = {
      version: leerVersion(texto),
      commit,
      changelog: recortar(texto, MAX_CHANGELOG_CHARS)
    };
    cache = { mtimeMs, info };
    return info;
  } catch {
    // Sin CHANGELOG el sistema funciona igual; simplemente no sabe qué versión es.
    return { version: null, commit, changelog: null };
  }
}

/** Recorta por LÍMITE DE VERSIÓN, no a mitad de una frase: un changelog cortado engaña. */
export function recortar(texto: string, max: number): string {
  const limpio = texto.trim();
  if (limpio.length <= max) return limpio;
  const corte = limpio.lastIndexOf("\n# ", max);
  return corte > 0 ? limpio.slice(0, corte).trimEnd() : limpio.slice(0, max).trimEnd();
}
