// Smoke de verificación EN VIVO para los tools de Track O (+ run-state).
//
// Corre contra un gateway VIVO (tu Mac reiniciada con el branch, o produ
// post-deploy). NO toca tu infra desde CI: lo corrés vos donde vive el gateway.
//
// Uso (rellená con datos REALES de tu flota):
//   GATEWAY_BASE_URL=http://127.0.0.1:5173 \
//   DELIVRIX_READ_BOUNDARY_TOKEN=<tu x-delivrix-token> \
//   SMOKE_SERVER_SLUG=smtp-1 SMOKE_SERVER_IP=1.2.3.4 \
//   SMOKE_DKIM_DOMAIN=bizreport.com SMOKE_DKIM_SELECTOR=s2026a \
//   SMOKE_MESSAGE_ID='<delivrix-...@bizreport.com>' \
//   node --experimental-strip-types scripts/openclaw/smoke-live-verification.ts
//
// Los checks con datos faltantes se SALTAN (no fallan). read_run_state_integrity
// no necesita datos y siempre corre.

const baseUrl = (process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const token = process.env.DELIVRIX_READ_BOUNDARY_TOKEN ?? process.env.DELIVRIX_OPENCLAW_TOKEN ?? "";

interface CheckResult {
  name: string;
  ok: boolean;
}

const results: CheckResult[] = [];

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json", ...(token ? { "x-delivrix-token": token } : {}) }
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function ok(name: string, detail: string): void {
  results.push({ name, ok: true });
  console.log(`✅ ${name} — ${detail}`);
}

function review(name: string, detail: string): void {
  results.push({ name, ok: false });
  console.log(`⚠️  ${name} — ${detail}`);
}

function skip(name: string, why: string): void {
  console.log(`➖ ${name} — saltado (${why})`);
}

async function main(): Promise<void> {
  if (!token) {
    console.error("Falta DELIVRIX_READ_BOUNDARY_TOKEN (el x-delivrix-token del gateway).");
    process.exit(2);
  }
  console.log(`Gateway: ${baseUrl}\n`);

  const slug = process.env.SMOKE_SERVER_SLUG;
  const ip = process.env.SMOKE_SERVER_IP;
  const dkimDomain = process.env.SMOKE_DKIM_DOMAIN;
  const dkimSelector = process.env.SMOKE_DKIM_SELECTOR;
  const messageId = process.env.SMOKE_MESSAGE_ID;

  // 1) read_run_state_integrity — sin params, siempre corre.
  try {
    const { status, body } = await getJson("/v1/openclaw/run-state-integrity");
    if (status === 200) {
      const orphans = (body.domainsWithoutRun ?? []).join(", ") || "ninguno";
      ok("read_run_state_integrity", `ok=${body.ok} · dominios sin run: ${orphans} · runs failed: ${body.totals?.failedRuns ?? 0}`);
    } else {
      review("read_run_state_integrity", `HTTP ${status} ${JSON.stringify(body)}`);
    }
  } catch (error) {
    review("read_run_state_integrity", String(error));
  }

  // 2) read_smtp_reachability — necesita un server real.
  if (slug && ip) {
    try {
      const { status, body } = await getJson(
        `/v1/openclaw/smtp-reachability?serverSlug=${encodeURIComponent(slug)}&serverIp=${encodeURIComponent(ip)}`
      );
      if (status === 200) {
        ok("read_smtp_reachability", `inbound listening=${body.inbound?.listening} · OUTBOUND=${body.outbound?.status} · canSend=${body.canSend} · ${body.summary ?? ""}`);
      } else {
        review("read_smtp_reachability", `HTTP ${status} ${JSON.stringify(body)}`);
      }
    } catch (error) {
      review("read_smtp_reachability", String(error));
    }
  } else {
    skip("read_smtp_reachability", "definí SMOKE_SERVER_SLUG + SMOKE_SERVER_IP");
  }

  // 3) read_dkim_status — necesita un dominio real.
  if (dkimDomain) {
    const sel = dkimSelector ? `&expectedSelector=${encodeURIComponent(dkimSelector)}` : "";
    try {
      const { status, body } = await getJson(`/v1/openclaw/dkim-status?domain=${encodeURIComponent(dkimDomain)}${sel}`);
      if (status === 200) {
        const valids = (body.validSelectors ?? []).join(", ") || "ninguno";
        ok("read_dkim_status", `status=${body.status} · selectores válidos: ${valids}`);
      } else {
        review("read_dkim_status", `HTTP ${status} ${JSON.stringify(body)}`);
      }
    } catch (error) {
      review("read_dkim_status", String(error));
    }
  } else {
    skip("read_dkim_status", "definí SMOKE_DKIM_DOMAIN (y opcional SMOKE_DKIM_SELECTOR)");
  }

  // 4) read_delivery_reason — necesita server + un message-id que haya rebotado.
  if (slug && ip && messageId) {
    try {
      const { status, body } = await getJson(
        `/v1/openclaw/delivery-reason?serverSlug=${encodeURIComponent(slug)}&serverIp=${encodeURIComponent(ip)}&messageId=${encodeURIComponent(messageId)}`
      );
      if (status === 200) {
        ok("read_delivery_reason", `found=${body.found} · ${body.reason?.summary ?? "(sin reason — revisá el message-id / que el log tenga la línea status=)"}`);
      } else {
        review("read_delivery_reason", `HTTP ${status} ${JSON.stringify(body)}`);
      }
    } catch (error) {
      review("read_delivery_reason", String(error));
    }
  } else {
    skip("read_delivery_reason", "definí SMOKE_SERVER_SLUG + SMOKE_SERVER_IP + SMOKE_MESSAGE_ID");
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} checks respondieron OK.`);
  console.log("Nota: ⚠️ no siempre es bug — puede ser dato REAL (outbound 25 bloqueado, un dominio sin run, DKIM revocado). Leé el detalle.");
  console.log("El check #5 (warmup auto-pausa por placement) es manual: corré un placement-check con el rampId de un ramp activo y confirmá que el ramp queda auto_paused con auto_placement.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
