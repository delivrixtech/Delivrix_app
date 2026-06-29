// SMTP port-25 reachability diagnostic — the antidote to the audited false alarm
// "puerto 25 bloqueado / 100% bounce".
//
// The send-path preflight only checked INBOUND port 25 (`ss -tlnp | grep :25` =
// "is postfix listening"). But a cloud VPS can listen on 25 and still be unable
// to connect OUT to a recipient MX on :25 (provider egress filter) — which is the
// real reason mail times out. Conflating the two produced wrong verdicts.
//
// This module runs, server-side over SSH, BOTH checks and reports them SEPARATELY:
//   - inbound:  is postfix active and listening on :25 (can receive)
//   - outbound: can the server open a TCP connection to a known MX on :25 (can send)
// Crucially, a probe that cannot run returns "unknown" — NEVER a false "blocked".

export type OutboundStatus = "reachable" | "blocked" | "unknown";

export interface SmtpReachability {
  inbound: {
    postfixActive: boolean;
    listening: boolean;
    detail: string;
  };
  outbound: {
    status: OutboundStatus;
    targetsTried: string[];
    reachableTarget?: string;
    banner?: string;
    detail: string;
  };
  /** true=can deliver, false=outbound blocked, null=undetermined (never a false no). */
  canSend: boolean | null;
  summary: string;
}

// Public MXs used purely as connectivity probes (we read the 220 banner, send nothing).
const DEFAULT_PROBE_TARGETS = ["gmail-smtp-in.l.google.com", "aspmx.l.google.com"];
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export interface ReachabilitySshRunner {
  run(input: {
    serverSlug: string;
    serverIp: string;
    command: string;
    timeoutMs?: number;
  }): Promise<{ stdout: string; exitCode: number }>;
}

export interface CheckSmtpReachabilityInput {
  sshRunner: ReachabilitySshRunner;
  serverSlug: string;
  serverIp: string;
  /** Override probe targets (must be valid hostnames). Defaults to public Google MXs. */
  probeTargets?: string[];
}

function safeTargets(targets: string[] | undefined): string[] {
  const candidates = (targets && targets.length > 0 ? targets : DEFAULT_PROBE_TARGETS)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => HOSTNAME_RE.test(t));
  // De-dupe, cap at 3 to keep the probe quick.
  return [...new Set(candidates)].slice(0, 3);
}

export function buildReachabilityCommand(targets: string[]): string {
  const probes = targets
    .map(
      (host) =>
        `echo "-- ${host}"; timeout 8 bash -c 'exec 3<>/dev/tcp/${host}/25 && head -c 120 <&3' 2>&1; echo "[rc=$?]"`
    )
    .join("; ");
  return [
    "echo '## INBOUND'",
    "systemctl is-active postfix 2>/dev/null || true",
    "(ss -tlnp 2>/dev/null | grep ':25 ' || echo NO_LISTEN_25)",
    "echo '## OUTBOUND'",
    probes
  ].join("; ");
}

function section(text: string, name: string): string {
  const start = text.indexOf(`## ${name}`);
  if (start === -1) return "";
  const rest = text.slice(start + `## ${name}`.length);
  const nextMarker = rest.indexOf("## ");
  return (nextMarker === -1 ? rest : rest.slice(0, nextMarker)).trim();
}

export function parseInbound(inboundText: string): SmtpReachability["inbound"] {
  const postfixActive = /(^|\n)\s*active\s*(\n|$)/.test(inboundText) || /\bactive\b/.test(firstLine(inboundText));
  const listening = !/NO_LISTEN_25/.test(inboundText) && /:25\b/.test(inboundText);
  return {
    postfixActive,
    listening,
    detail: compact(inboundText)
  };
}

export function parseOutbound(outboundText: string, targetsTried: string[]): SmtpReachability["outbound"] {
  // Split into per-target blocks delimited by "-- <host>".
  const blocks = outboundText.split(/(?=--\s)/).map((b) => b.trim()).filter(Boolean);
  let anyBlocked = false;
  let anyDetermined = false;

  for (const block of blocks) {
    const hostMatch = /^--\s+(\S+)/.exec(block);
    const host = hostMatch?.[1];
    if (!host) continue;
    if (/\b220[\s-]/.test(block)) {
      return {
        status: "reachable",
        targetsTried,
        reachableTarget: host,
        banner: extractBanner(block),
        detail: `outbound 25 OK via ${host}`
      };
    }
    if (/\[rc=124\]/.test(block) || /timed out|timeout/i.test(block)) {
      anyBlocked = true;
      anyDetermined = true;
    } else if (/Connection refused|No route to host|Network is unreachable|Connection reset/i.test(block)) {
      anyBlocked = true;
      anyDetermined = true;
    }
  }

  if (anyBlocked) {
    return {
      status: "blocked",
      targetsTried,
      detail: "outbound 25 timed out/refused on all probes (likely provider egress filter)"
    };
  }
  // Could not connect AND could not confirm a definite block → do not guess.
  return {
    status: "unknown",
    targetsTried,
    detail: anyDetermined ? "outbound 25 inconclusive" : "outbound probe produced no usable signal"
  };
}

export function interpretReachability(
  inbound: SmtpReachability["inbound"],
  outbound: SmtpReachability["outbound"]
): { canSend: boolean | null; summary: string } {
  if (outbound.status === "reachable") {
    return {
      canSend: true,
      summary: `outbound 25 OK (${outbound.reachableTarget}) → el server puede entregar; inbound listening=${inbound.listening}`
    };
  }
  if (outbound.status === "blocked") {
    return {
      canSend: false,
      summary: `outbound 25 BLOQUEADO (egress del proveedor) → este server NO entrega; inbound listening=${inbound.listening}. No es "puerto 25" en general: el inbound puede estar OK.`
    };
  }
  return {
    canSend: null,
    summary: `outbound 25 INDETERMINADO (el probe no pudo correr) → NO asumir bloqueo; reintentar. inbound listening=${inbound.listening}`
  };
}

/**
 * Runs the inbound + outbound port-25 checks on a server over SSH and returns a
 * structured, clearly-labeled verdict. Best-effort: never throws; an SSH failure
 * yields outbound "unknown" / canSend null (never a false "blocked").
 */
export async function checkSmtpReachability(
  input: CheckSmtpReachabilityInput
): Promise<SmtpReachability> {
  const targets = safeTargets(input.probeTargets);
  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: buildReachabilityCommand(targets),
      timeoutMs: 45_000
    });
    const inbound = parseInbound(section(result.stdout, "INBOUND"));
    const outbound = parseOutbound(section(result.stdout, "OUTBOUND"), targets);
    const verdict = interpretReachability(inbound, outbound);
    return { inbound, outbound, canSend: verdict.canSend, summary: verdict.summary };
  } catch (error) {
    const detail = `reachability_probe_failed: ${errorMessage(error)}`;
    return {
      inbound: { postfixActive: false, listening: false, detail },
      outbound: { status: "unknown", targetsTried: targets, detail },
      canSend: null,
      summary: `no se pudo correr el diagnóstico (SSH falló): ${errorMessage(error)} → NO asumir bloqueo`
    };
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

function extractBanner(block: string): string | undefined {
  const line = block.split(/\r?\n/).find((l) => /\b220[\s-]/.test(l));
  return line ? compact(line) : undefined;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
