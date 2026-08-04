// Probe READ-ONLY de la API Contabo: lista productos VPS + imagenes Ubuntu
// disponibles para la cuenta, SIN comprar nada (solo GET).
// Objetivo: confirmar el productId/imageId/region exactos antes de crear, sin adivinar.
//
// Correr desde la raiz del repo en el Mac (con las creds del gateway):
//   node --env-file=config/gateway.env scripts/contabo-probe.mjs
//
// No imprime secretos (solo redacta el token).

const AUTH_URL = "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";
const API = "https://api.contabo.com";
const env = process.env;

const need = ["CONTABO_CLIENT_ID", "CONTABO_CLIENT_SECRET", "CONTABO_API_USER", "CONTABO_API_PASSWORD"];
const missing = need.filter((k) => !env[k] || String(env[k]).trim() === "");
if (missing.length) {
  console.error("FALTAN creds en el env:", missing.join(", "));
  console.error("Corre con: node --env-file=config/gateway.env scripts/contabo-probe.mjs");
  process.exit(1);
}

function rid() {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

// 1) OAuth2 password grant (mismo flujo que el adapter)
const tokenRes = await fetch(AUTH_URL, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams({
    client_id: env.CONTABO_CLIENT_ID,
    client_secret: env.CONTABO_CLIENT_SECRET,
    username: env.CONTABO_API_USER,
    password: env.CONTABO_API_PASSWORD,
    grant_type: "password"
  })
});
const tokenJson = await tokenRes.json().catch(() => ({}));
if (!tokenJson.access_token) {
  console.error("TOKEN FALLO status", tokenRes.status, "->", JSON.stringify(tokenJson).slice(0, 400));
  process.exit(1);
}
console.log("TOKEN OK (status " + tokenRes.status + ")");
const accessToken = tokenJson.access_token;

async function get(path) {
  const r = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, "x-request-id": rid(), accept: "application/json" }
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

// 2) PRODUCTS (que VPS puede ordenar la cuenta)
const prod = await get("/v1/compute/products?size=200");
console.log("\n=== PRODUCTS (status " + prod.status + ") ===");
const pdata = Array.isArray(prod.json) ? prod.json : (prod.json.data || []);
if (!pdata.length) {
  console.log("(sin data; respuesta cruda) ->", JSON.stringify(prod.json).slice(0, 1200));
} else {
  for (const p of pdata) {
    const id = p.productId || p.id || "?";
    const name = p.name || p.shortDescription || p.description || "";
    const regions = (p.availableRegions || p.regions || p.dataCenters || []);
    const regStr = Array.isArray(regions) ? regions.join(",") : "";
    console.log("  " + id + "  |  " + name + (regStr ? "  |  regions: " + regStr : ""));
  }
}

// 3) IMAGES Ubuntu (que imageId usar)
const img = await get("/v1/compute/images?standardImage=true&name=Ubuntu&size=100");
console.log("\n=== UBUNTU IMAGES (status " + img.status + ") ===");
const idata = Array.isArray(img.json) ? img.json : (img.json.data || []);
if (!idata.length) {
  console.log("(sin data; respuesta cruda) ->", JSON.stringify(img.json).slice(0, 800));
} else {
  for (const i of idata) {
    console.log("  " + (i.imageId || i.id) + "  |  " + (i.name || "") + "  |  v" + (i.version || "") + "  |  " + (i.osType || ""));
  }
}

// 4) INSTANCES (confirmar IP del VPS ya creado: contabo-203386827)
const inst = await get("/v1/compute/instances?size=50");
console.log("\n=== INSTANCES (status " + inst.status + ") ===");
const insdata = Array.isArray(inst.json) ? inst.json : (inst.json.data || []);
if (!insdata.length) {
  console.log("(sin data) ->", JSON.stringify(inst.json).slice(0, 600));
} else {
  for (const i of insdata) {
    const ip = (i.ipConfig && i.ipConfig.v4 && i.ipConfig.v4.ip) || i.ipv4 || "";
    console.log("  instanceId " + (i.instanceId || i.id) + "  |  " + (i.displayName || "") + "  |  status: " + (i.status || "") + "  |  ip: " + (ip || "(sin IP aun)"));
  }
}

console.log("\nListo. Pegame esta salida.");
