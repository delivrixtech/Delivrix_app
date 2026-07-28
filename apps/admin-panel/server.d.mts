// Declaraciones minimas de server.mjs, solo para que el test de paridad de allowlists
// (src/shared/api/read-boundary-proxy-parity.test.ts) pase por tsc --noEmit.
//
// server.mjs es JavaScript plano a proposito: se ejecuta con `node server.mjs`, sin build ni
// type stripping, asi que no puede importar el read-boundary (que es TypeScript). Esa es
// justamente la razon por la que lleva su allowlist a mano y por la que el test existe.

/** Rutas exactas que el proxy de lectura deja pasar al gateway. */
export declare const allowedProxyPaths: ReadonlySet<string>;

/** Rutas de lectura con parametro en el path (por ejemplo la descarga por dominio). */
export declare const allowedReadPatterns: readonly RegExp[];
