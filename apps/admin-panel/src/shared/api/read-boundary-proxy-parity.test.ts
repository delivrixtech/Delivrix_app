import assert from "node:assert/strict";
import test from "node:test";

import { allowedProxyPaths, allowedReadPatterns } from "../../../server.mjs";
import { READ_ENDPOINTS, listReadEndpoints } from "./read-boundary.ts";

// El panel se sirve de dos maneras y cada una tiene su propio allowlist de proxy:
//   - vite.config.ts lo DERIVA de READ_ENDPOINTS, asi que nunca se desincroniza.
//   - server.mjs lo lleva a mano, asi que si se desincronizo en silencio.
// Cuando divergen, el endpoint existe, el gateway lo sirve y el panel igual muestra un 404
// "unknown_read_endpoint", pero solo con `npm run serve:admin` — con `npm run dev` (Vite)
// anda. Eso hace que el bug quede invisible en desarrollo y aparezca recien en el deploy.
// Paso de verdad: `download-all` quedo afuera, y con el las 4 rutas de warmup y las 4 de
// compra de dominios.

const alcanzable = (pathname: string): boolean =>
  allowedProxyPaths.has(pathname) || allowedReadPatterns.some((pattern) => pattern.test(pathname));

test("todo endpoint del read-boundary pasa por el proxy de server.mjs", () => {
  const faltantes = Object.entries(READ_ENDPOINTS)
    .filter(([, pathname]) => !alcanzable(pathname))
    .map(([nombre, pathname]) => `${nombre} (${pathname})`);

  assert.deepEqual(
    faltantes,
    [],
    `Estos endpoints estan declarados en el read-boundary pero server.mjs los rechaza con 404 ` +
      `unknown_read_endpoint. Agregalos a allowedProxyPaths en apps/admin-panel/server.mjs:\n  ` +
      faltantes.join("\n  ")
  );
});

test("la descarga masiva de credenciales es alcanzable por el proxy", () => {
  // Regresion puntual: es el endpoint que introdujo el bug y el unico binario del boundary.
  assert.equal(alcanzable(READ_ENDPOINTS.senderPoolCredentialsBulkDownload), true);
  assert.equal(READ_ENDPOINTS.senderPoolCredentialsBulkDownload, "/v1/sender-pool/credentials/download-all");
});

test("el proxy no expone nada fuera del read-boundary", () => {
  // La direccion contraria: allowedProxyPaths no deberia tener rutas que el boundary no declare.
  // Las de chat son la excepcion conocida (tienen su propio carril, no pasan por READ_ENDPOINTS).
  const excepciones = new Set(["/v1/openclaw/chat/conversations", "/v1/openclaw/chat/history"]);
  const declarados = new Set<string>(listReadEndpoints());

  const deMas = [...allowedProxyPaths].filter(
    (pathname) => !declarados.has(pathname) && !excepciones.has(pathname)
  );

  assert.deepEqual(deMas, [], `server.mjs proxea rutas que el read-boundary no declara: ${deMas.join(", ")}`);
});
