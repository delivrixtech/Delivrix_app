import { promises as dns } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  VpsProvider,
  WebdockServer,
  WebdockSetServerIdentityResult,
  WebdockSetServerMainDomainResult,
  WebdockSetServerPtrResult,
  WebdockSshCommandResult,
  WebdockSshRunner
} from "../../../../packages/adapters/src/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import {
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken
} from "../approval-guard.ts";
import { readRequestBody } from "../request-body.ts";
import type { SkillParamSchema } from "../skill-schemas.ts";
import { smtpHostForDomain } from "../smtp-naming.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { getProviderFromServerSlug } from "../server-provider.ts";
import { runWithTransientSshRetry } from "../ssh-retry.ts";

export interface BindWebdockMainDomainParams extends Record<string, unknown> {
  serverSlug: string;
  domain: string;
  setPtr: boolean;
  actorId: string;
  approvalToken: string;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface BindWebdockMainDomainSkillParams extends Record<string, unknown> {
  serverSlug: string;
  domain: string;
  setPtr: boolean;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface BindWebdockMainDomainResult {
  ok: boolean;
  serverSlug: string;
  mainDomain: string;
  previousMainDomain: string | null;
  identitySet: boolean;
  identityCallbackId?: string;
  ptrSet: boolean;
  ptrSkipReason?: "ipv4_missing" | "operator_opt_out" | "fcrdns_pending" | "set_failed";
  operatorAction?: string;
  fcrdnsVerified: boolean;
  fcrdnsStatus: "verified" | "pending";
  fcrdns?: {
    expectedA: string;
    expectedPtr: string;
    forwardA: string[];
    reversePtr: string[];
  };
  alreadyBound: boolean;
  eventId: string;
  durationMs: number;
  error?: string;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface BindWebdockMainDomainApprovalGuard {
  verify(input: {
    approvalToken: string;
    actorId: string;
  }): Promise<{ ok: boolean; eventId?: string; artifactId?: string }>;
}

export interface BindWebdockMainDomainAdapter {
  getServer(serverSlug: string): Promise<WebdockServer>;
  setServerIdentity(opts: {
    serverSlug: string;
    mainDomain: string;
    aliasDomains?: string[];
    removeDefaultAlias?: boolean;
    waitForCompletion?: boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<WebdockSetServerIdentityResult>;
  setServerMainDomain(opts: {
    serverSlug: string;
    domain: string;
    serverIp?: string | null;
    sshRunner?: WebdockSshRunner;
  }): Promise<WebdockSetServerMainDomainResult>;
  setServerPtr(opts: {
    serverSlug: string;
    ipv4: string;
    ptrValue: string;
  }): Promise<WebdockSetServerPtrResult>;
}

export interface FcrdnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
}

export interface BindWebdockMainDomainDeps {
  auditLog: AuditSink;
  approvalGuard: BindWebdockMainDomainApprovalGuard;
  webdockAdapter: BindWebdockMainDomainAdapter;
  /**
   * Registry providerId->adapter de proveedores NO-Webdock (Contabo, etc.). Canal HERMANO de
   * webdockAdapter: SOLO se consulta cuando el providerId del bind es no-Webdock y esta presente aqui
   * (-> CONTABO BIND PATH). Ausente/"webdock"/desconocido => bind Webdock (setServerIdentity) sin cambios.
   */
  vpsProviderAdapters?: Map<string, VpsProvider>;
  sshRunner?: WebdockSshRunner;
  workspace?: OpenClawWorkspace;
  now: () => number;
  fcrdnsResolver?: FcrdnsResolver;
  fcrdnsMaxWaitMs?: number;
  fcrdnsPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const approvalMaxAgeMs = 15 * 60 * 1000;
const defaultNonWebdockFcrdnsMaxWaitMs = 180_000;
const defaultFcrdnsResolver: FcrdnsResolver = {
  resolve4: (hostname) => dns.resolve4(hostname),
  reverse: (ip) => dns.reverse(ip)
};

interface FcrdnsCheckResult {
  verified: boolean;
  expectedA: string;
  expectedPtr: string;
  forwardA: string[];
  reversePtr: string[];
  forwardMatched: boolean;
  reverseMatched: boolean;
}

export const bindWebdockMainDomainParamSchema: SkillParamSchema<BindWebdockMainDomainParams> = {
  safeParse(value: unknown) {
    try {
      return { success: true, data: parseParams(value, true) };
    } catch (error) {
      const message = error instanceof BindWebdockMainDomainInputError ? error.message : "invalid_params";
      return {
        success: false,
        error: {
          issues: [message],
          format: () => ({ _errors: [message] })
        }
      };
    }
  }
};

export const bindWebdockMainDomainSkillParamSchema: SkillParamSchema<BindWebdockMainDomainSkillParams> = {
  safeParse(value: unknown) {
    try {
      const params = parseParams(value, false);
      return {
        success: true,
        data: {
          serverSlug: params.serverSlug,
          domain: params.domain,
          setPtr: params.setPtr,
          ...(params.repairReason ? { repairReason: params.repairReason } : {}),
          ...(params.explicitRepairScope ? { explicitRepairScope: params.explicitRepairScope } : {})
        }
      };
    } catch (error) {
      const message = error instanceof BindWebdockMainDomainInputError ? error.message : "invalid_params";
      return {
        success: false,
        error: {
          issues: [message],
          format: () => ({ _errors: [message] })
        }
      };
    }
  }
};

export async function handleBindWebdockMainDomain(input: {
  request: IncomingMessage;
  response: ServerResponse;
  providerId?: string;
  deps: BindWebdockMainDomainDeps;
}): Promise<void> {
  const startedAt = input.deps.now();
  const body = await readJson(input.request);
  const parsed = bindWebdockMainDomainParamSchema.safeParse(body);
  if (!parsed.success) {
    json(input.response, 400, { error: "invalid_params", details: parsed.error.format() });
    return;
  }
  const params = parsed.data;
  const approval = await input.deps.approvalGuard.verify({
    approvalToken: params.approvalToken,
    actorId: params.actorId
  });
  if (!approval.ok) {
    json(input.response, 403, { error: "approval_invalid" });
    return;
  }

  // CONTABO BIND PATH (canal HERMANO providerId): cuando el run pidio un proveedor NO-Webdock presente
  // en el registry, el server vive en ESE proveedor (slug contabo-<id>) y la API Webdock daria 404. Se
  // toma el camino del proveedor (getServer del adapter + hostname por SSH + PTR manual + FCrDNS reusado),
  // ANTES de cualquier llamada a la API Webdock. Ausente/"webdock"/desconocido => bind Webdock unchanged.
  const normalizedProviderId = input.providerId?.trim().toLowerCase();
  if (normalizedProviderId && normalizedProviderId !== "webdock") {
    const providerAdapter = input.deps.vpsProviderAdapters?.get(normalizedProviderId);
    if (providerAdapter) {
      await bindNonWebdockMainDomain({
        response: input.response,
        deps: input.deps,
        adapter: providerAdapter,
        providerId: normalizedProviderId,
        params,
        approval,
        startedAt
      });
      return;
    }
  }

  let server: WebdockServer;
  try {
    server = await input.deps.webdockAdapter.getServer(params.serverSlug);
  } catch {
    json(input.response, 404, { error: "server_not_found", slug: params.serverSlug });
    return;
  }

  const identityDomain = smtpHostForDomain(params.domain);
  const currentMainDomain = currentIdentityDomainFromServer(server);
  if (!params.setPtr) {
    json(input.response, 422, {
      error: "fcrdns_required",
      message: "Webdock SMTP identity requires FCrDNS verification; setPtr=false is not allowed for SMTP provisioning."
    });
    return;
  }
  if (!server.ipv4) {
    const event = await input.deps.auditLog.append({
      actorType: "operator",
      actorId: params.actorId,
      action: "oc.webdock.identity_pending_fcrdns",
      targetType: "webdock_server",
      targetId: params.serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [params.actorId],
      metadata: {
        serverSlug: params.serverSlug,
        domain: params.domain,
        identityDomain,
        ptrSet: false,
        ptrSkipReason: "ipv4_missing",
        approvalEventId: approval.eventId ?? null,
        approvalArtifactId: approval.artifactId ?? null
      }
    });
    await upsertDomainBinding(input.deps.workspace, {
      domain: params.domain,
      serverSlug: params.serverSlug,
      serverIp: "",
      status: "identity_pending_fcrdns"
    });
    json(input.response, 424, {
      ok: false,
      serverSlug: params.serverSlug,
      mainDomain: identityDomain,
      previousMainDomain: currentMainDomain,
      identitySet: false,
      ptrSet: false,
      ptrSkipReason: "ipv4_missing",
      fcrdnsVerified: false,
      fcrdnsStatus: "pending",
      alreadyBound: currentMainDomain === identityDomain,
      eventId: eventId(event),
      durationMs: input.deps.now() - startedAt,
      error: "ipv4_missing"
    } satisfies BindWebdockMainDomainResult);
    return;
  }

  let previousMainDomain: string | null = currentMainDomain;
  const alreadyBound = currentMainDomain === identityDomain;
  let identity: WebdockSetServerIdentityResult | null = null;
  if (!alreadyBound) {
    try {
      identity = await input.deps.webdockAdapter.setServerIdentity({
        serverSlug: params.serverSlug,
        mainDomain: identityDomain,
        aliasDomains: [],
        removeDefaultAlias: true,
        waitForCompletion: true
      });
      previousMainDomain = currentMainDomain;
    } catch (error) {
      await input.deps.auditLog.append({
        actorType: "operator",
        actorId: params.actorId,
        action: "oc.webdock.identity_set_failed",
        targetType: "webdock_server",
        targetId: params.serverSlug,
        riskLevel: "critical",
        decision: "reject",
        humanApproved: true,
        approverIds: [params.actorId],
        metadata: {
          serverSlug: params.serverSlug,
          domain: params.domain,
          identityDomain,
          previousMainDomain,
          error: errorMessage(error)
        }
      });
      json(input.response, 502, { error: "identity_set_failed", details: errorMessage(error) });
      return;
    }
  }

  const fcrdns = await verifyFcrdnsWithRetry({
    resolver: input.deps.fcrdnsResolver ?? defaultFcrdnsResolver,
    smtpHost: identityDomain,
    ipv4: server.ipv4,
    // 120s era insuficiente para un dominio fresco: el A recien escrito y el PTR de Webdock
    // tardan en ser visibles al resolver, y el run abortaba intermitente con fcrdns_pending
    // (lo que ademas gatillaba el loop de recuperacion de OpenClaw -> bedrock_invoke_error).
    // verifyFcrdnsWithRetry hace polling y retorna apenas verifica, asi que este valor es solo
    // el TECHO del caso de fallo; el caso normal cierra en pocos minutos. 15 min alinea con los
    // wait_for_dns_propagation del orquestador.
    maxWaitMs: input.deps.fcrdnsMaxWaitMs ?? 900_000,
    pollIntervalMs: input.deps.fcrdnsPollIntervalMs ?? 10_000,
    sleep: input.deps.sleep ?? sleep
  });

  if (!fcrdns.verified) {
    const event = await input.deps.auditLog.append({
      actorType: "operator",
      actorId: params.actorId,
      action: "oc.webdock.identity_pending_fcrdns",
      targetType: "webdock_server",
      targetId: params.serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [params.actorId],
      metadata: {
        serverSlug: params.serverSlug,
        domain: params.domain,
        identityDomain,
        previousMainDomain,
        identitySet: !alreadyBound,
        identityCallbackId: identity?.callbackId ?? null,
        ptrSet: false,
        ptrSkipReason: "fcrdns_pending",
        fcrdns,
        alreadyBound,
        approvalEventId: approval.eventId ?? null,
        approvalArtifactId: approval.artifactId ?? null
      }
    });
    await upsertDomainBinding(input.deps.workspace, {
      domain: params.domain,
      serverSlug: params.serverSlug,
      serverIp: server.ipv4,
      status: "identity_pending_fcrdns"
    });
    json(input.response, 424, {
      ok: false,
      serverSlug: params.serverSlug,
      mainDomain: identityDomain,
      previousMainDomain,
      identitySet: !alreadyBound,
      ...(identity?.callbackId ? { identityCallbackId: identity.callbackId } : {}),
      ptrSet: false,
      ptrSkipReason: "fcrdns_pending",
      fcrdnsVerified: false,
      fcrdnsStatus: "pending",
      fcrdns: fcrdnsSnapshot(fcrdns),
      alreadyBound,
      eventId: eventId(event),
      durationMs: input.deps.now() - startedAt,
      error: "fcrdns_pending"
    } satisfies BindWebdockMainDomainResult);
    return;
  }

  const alignedEvent = await input.deps.auditLog.append({
    actorType: "operator",
    actorId: params.actorId,
    action: "oc.webdock.identity_aligned",
    targetType: "webdock_server",
    targetId: params.serverSlug,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [params.actorId],
    metadata: {
      serverSlug: params.serverSlug,
      domain: params.domain,
      previousMainDomain,
      newMainDomain: identityDomain,
      identitySet: !alreadyBound,
      identityCallbackId: identity?.callbackId ?? null,
      removeDefaultAlias: true,
      ptrSet: true,
      fcrdns,
      alreadyBound,
      approvalEventId: approval.eventId ?? null,
      approvalArtifactId: approval.artifactId ?? null
    }
  });

  await input.deps.auditLog.append({
    actorType: "operator",
    actorId: params.actorId,
    action: "oc.webdock.main_domain_bound",
    targetType: "webdock_server",
    targetId: params.serverSlug,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [params.actorId],
    metadata: {
      serverSlug: params.serverSlug,
      previousMainDomain,
      newMainDomain: identityDomain,
      identitySet: !alreadyBound,
      identityCallbackId: identity?.callbackId ?? null,
      ptrSet: true,
      ptrSkipReason: null,
      fcrdnsVerified: true,
      alreadyBound,
      approvalEventId: approval.eventId ?? null,
      approvalArtifactId: approval.artifactId ?? null
    }
  });
  await upsertDomainBinding(input.deps.workspace, {
    domain: params.domain,
    serverSlug: params.serverSlug,
    serverIp: server.ipv4 || "",
    status: "main_domain_bound"
  });

  json(input.response, 200, {
    ok: true,
    serverSlug: params.serverSlug,
    mainDomain: identityDomain,
    previousMainDomain,
    identitySet: !alreadyBound,
    ...(identity?.callbackId ? { identityCallbackId: identity.callbackId } : {}),
    ptrSet: true,
    fcrdnsVerified: true,
    fcrdnsStatus: "verified",
    fcrdns: fcrdnsSnapshot(fcrdns),
    alreadyBound,
    eventId: eventId(alignedEvent),
    durationMs: input.deps.now() - startedAt
  } satisfies BindWebdockMainDomainResult);
}

/**
 * CONTABO BIND PATH (proveedor NO-Webdock). Espejo funcional del bind Webdock pero:
 *  - Resuelve el server por el adapter del PROVEEDOR (getServer del VpsProvider), NO la API Webdock.
 *  - Setea el HOSTNAME a smtp.<domain> por SSH (Contabo NO tiene identity API), con el MISMO runner y
 *    key de operador que usa el provisioning (step 9). Mirror de WebdockRealAdapter.setServerHostnameViaSsh.
 *  - Si el adapter expone setReverseDns(), setea el PTR por API antes del FCrDNS. Si no existe o falla,
 *    audita fallback manual y continua al verify para conservar el camino pending/reintentable.
 *  - Si FCrDNS no verifica dentro del wait acotado (operador aun no puso el PTR, o no propago), devuelve
 *    200 advisory/no-bloqueante con operatorAction; un re-run posterior puede confirmar el alignment.
 * Devuelve el MISMO BindWebdockMainDomainResult para que los steps 9-14 sigan sin cambios.
 */
async function bindNonWebdockMainDomain(input: {
  response: ServerResponse;
  deps: BindWebdockMainDomainDeps;
  adapter: VpsProvider;
  providerId: string;
  params: BindWebdockMainDomainParams;
  approval: { ok: boolean; eventId?: string; artifactId?: string };
  startedAt: number;
}): Promise<void> {
  const { response, deps, adapter, providerId, params, approval, startedAt } = input;
  const identityDomain = smtpHostForDomain(params.domain);

  // FCrDNS es obligatorio para SMTP (igual que Webdock): setPtr=false no se permite.
  if (!params.setPtr) {
    json(response, 422, {
      error: "fcrdns_required",
      message: `${providerId} SMTP identity requires FCrDNS verification; setPtr=false is not allowed for SMTP provisioning.`
    });
    return;
  }

  // Resolver el server en el PROVEEDOR (no Webdock). 404 si el adapter no lo encuentra.
  let server: WebdockServer;
  try {
    server = await adapter.getServer(params.serverSlug);
  } catch {
    json(response, 404, { error: "server_not_found", slug: params.serverSlug });
    return;
  }

  const currentMainDomain = currentIdentityDomainFromServer(server);
  const alreadyBound = currentMainDomain === identityDomain;

  // Sin IPv4 todavia (provisioning incompleto): no se puede SSH ni verificar FCrDNS. Pending/reintentable.
  if (!server.ipv4) {
    const event = await deps.auditLog.append({
      actorType: "operator",
      actorId: params.actorId,
      action: "oc.bind.contabo_identity_pending_fcrdns",
      targetType: "webdock_server",
      targetId: params.serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [params.actorId],
      metadata: {
        provider: providerId,
        serverSlug: params.serverSlug,
        domain: params.domain,
        identityDomain,
        ptrSet: false,
        ptrSkipReason: "ipv4_missing",
        approvalEventId: approval.eventId ?? null,
        approvalArtifactId: approval.artifactId ?? null
      }
    });
    await upsertDomainBinding(deps.workspace, {
      domain: params.domain,
      serverSlug: params.serverSlug,
      serverIp: "",
      status: "identity_pending_fcrdns"
    });
    json(response, 424, {
      ok: false,
      serverSlug: params.serverSlug,
      mainDomain: identityDomain,
      previousMainDomain: currentMainDomain,
      identitySet: false,
      ptrSet: false,
      ptrSkipReason: "ipv4_missing",
      fcrdnsVerified: false,
      fcrdnsStatus: "pending",
      alreadyBound,
      eventId: eventId(event),
      durationMs: deps.now() - startedAt,
      error: "ipv4_missing"
    } satisfies BindWebdockMainDomainResult);
    return;
  }

  // Setear el hostname a la FQDN por SSH (Contabo no tiene identity API). Mismo runner+key del provisioning.
  let identitySet = false;
  if (!alreadyBound) {
    try {
      await setHostnameViaSsh({
        sshRunner: deps.sshRunner,
        serverSlug: params.serverSlug,
        serverIp: server.ipv4,
        fqdn: identityDomain
      });
      identitySet = true;
    } catch (error) {
      await deps.auditLog.append({
        actorType: "operator",
        actorId: params.actorId,
        action: "oc.bind.contabo_hostname_set_failed",
        targetType: "webdock_server",
        targetId: params.serverSlug,
        riskLevel: "critical",
        decision: "reject",
        humanApproved: true,
        approverIds: [params.actorId],
        metadata: {
          provider: providerId,
          serverSlug: params.serverSlug,
          domain: params.domain,
          identityDomain,
          serverIp: server.ipv4,
          error: errorMessage(error)
        }
      });
      json(response, 502, { error: "identity_set_failed", details: errorMessage(error) });
      return;
    }
  }

  let ptrSetByApi = false;
  let ptrSetStatus: number | null = null;
  let ptrSetFailureDetail: string | null = null;
  let ptrFallbackReason: "api_unavailable" | "api_failed" | null = null;

  if (typeof adapter.setReverseDns === "function") {
    try {
      const ptrResult = await adapter.setReverseDns(server.ipv4, identityDomain);
      ptrSetStatus = ptrResult.status;
      if (ptrResult.ok) {
        ptrSetByApi = true;
        await deps.auditLog.append({
          actorType: "operator",
          actorId: params.actorId,
          action: "oc.bind.contabo_ptr_set",
          targetType: "webdock_server",
          targetId: params.serverSlug,
          riskLevel: "high",
          decision: "allow",
          humanApproved: true,
          approverIds: [params.actorId],
          metadata: {
            provider: providerId,
            serverSlug: params.serverSlug,
            serverIp: server.ipv4,
            targetPtr: identityDomain,
            status: ptrResult.status,
            approvalEventId: approval.eventId ?? null,
            approvalArtifactId: approval.artifactId ?? null
          }
        });
      } else {
        ptrFallbackReason = "api_failed";
        ptrSetFailureDetail = ptrResult.detail ?? null;
        await deps.auditLog.append({
          actorType: "operator",
          actorId: params.actorId,
          action: "oc.bind.contabo_ptr_set_failed",
          targetType: "webdock_server",
          targetId: params.serverSlug,
          riskLevel: "high",
          decision: "allow",
          humanApproved: true,
          approverIds: [params.actorId],
          metadata: {
            provider: providerId,
            serverSlug: params.serverSlug,
            serverIp: server.ipv4,
            targetPtr: identityDomain,
            status: ptrResult.status,
            detail: ptrResult.detail ?? null,
            operatorAction: contaboPtrManualFallbackAction(server.ipv4, identityDomain, providerId, ptrResult.detail),
            approvalEventId: approval.eventId ?? null,
            approvalArtifactId: approval.artifactId ?? null
          }
        });
      }
    } catch (error) {
      ptrFallbackReason = "api_failed";
      ptrSetFailureDetail = errorMessage(error);
      await deps.auditLog.append({
        actorType: "operator",
        actorId: params.actorId,
        action: "oc.bind.contabo_ptr_set_failed",
        targetType: "webdock_server",
        targetId: params.serverSlug,
        riskLevel: "high",
        decision: "allow",
        humanApproved: true,
        approverIds: [params.actorId],
        metadata: {
          provider: providerId,
          serverSlug: params.serverSlug,
          serverIp: server.ipv4,
          targetPtr: identityDomain,
          status: null,
          detail: ptrSetFailureDetail,
          operatorAction: contaboPtrManualFallbackAction(server.ipv4, identityDomain, providerId, ptrSetFailureDetail),
          approvalEventId: approval.eventId ?? null,
          approvalArtifactId: approval.artifactId ?? null
        }
      });
    }
  } else {
    ptrFallbackReason = "api_unavailable";
    await deps.auditLog.append({
      actorType: "operator",
      actorId: params.actorId,
      action: "oc.bind.contabo_manual_ptr_required",
      targetType: "webdock_server",
      targetId: params.serverSlug,
      riskLevel: "high",
      decision: "allow",
      humanApproved: true,
      approverIds: [params.actorId],
      metadata: {
        provider: providerId,
        serverSlug: params.serverSlug,
        serverIp: server.ipv4,
        targetPtr: identityDomain,
        instruction: contaboPtrManualFallbackAction(server.ipv4, identityDomain, providerId),
        approvalEventId: approval.eventId ?? null,
        approvalArtifactId: approval.artifactId ?? null
      }
    });
  }

  // FCrDNS verify REUSADO tal cual: dig -x IP == smtp.<domain> AND smtp.<domain> -> IP, con retry acotado.
  const fcrdns = await verifyFcrdnsWithRetry({
    resolver: deps.fcrdnsResolver ?? defaultFcrdnsResolver,
    smtpHost: identityDomain,
    ipv4: server.ipv4,
    maxWaitMs: deps.fcrdnsMaxWaitMs ?? defaultNonWebdockFcrdnsMaxWaitMs,
    pollIntervalMs: deps.fcrdnsPollIntervalMs ?? 10_000,
    sleep: deps.sleep ?? sleep
  });

  if (!fcrdns.verified) {
    // PTR aun no propagado (operador no lo puso, o DNS no convergio): advisory no-bloqueante.
    const operatorAction = ptrSetByApi
      ? `PTR API set ${server.ipv4} to ${identityDomain}; wait for DNS propagation, then rerun verification.`
      : contaboPtrManualFallbackAction(server.ipv4, identityDomain, providerId, ptrSetFailureDetail ?? undefined);
    const event = await deps.auditLog.append({
      actorType: "operator",
      actorId: params.actorId,
      action: "oc.bind.contabo_identity_pending_fcrdns",
      targetType: "webdock_server",
      targetId: params.serverSlug,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [params.actorId],
      metadata: {
        provider: providerId,
        serverSlug: params.serverSlug,
        domain: params.domain,
        identityDomain,
        previousMainDomain: currentMainDomain,
        identitySet,
        ptrSet: false,
        ptrSkipReason: "fcrdns_pending",
        ptrSetByApi,
        ptrSetStatus,
        ptrFallbackReason,
        ptrSetFailureDetail,
        operatorAction,
        nonBlocking: true,
        fcrdns,
        alreadyBound,
        approvalEventId: approval.eventId ?? null,
        approvalArtifactId: approval.artifactId ?? null
      }
    });
    await upsertDomainBinding(deps.workspace, {
      domain: params.domain,
      serverSlug: params.serverSlug,
      serverIp: server.ipv4,
      status: "identity_pending_fcrdns"
    });
    json(response, 200, {
      ok: true,
      serverSlug: params.serverSlug,
      mainDomain: identityDomain,
      previousMainDomain: currentMainDomain,
      identitySet,
      ptrSet: false,
      ptrSkipReason: "fcrdns_pending",
      operatorAction,
      fcrdnsVerified: false,
      fcrdnsStatus: "pending",
      fcrdns: fcrdnsSnapshot(fcrdns),
      alreadyBound,
      eventId: eventId(event),
      durationMs: deps.now() - startedAt
    } satisfies BindWebdockMainDomainResult);
    return;
  }

  const alignedEvent = await deps.auditLog.append({
    actorType: "operator",
    actorId: params.actorId,
    action: "oc.bind.contabo_identity_aligned",
    targetType: "webdock_server",
    targetId: params.serverSlug,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [params.actorId],
    metadata: {
      provider: providerId,
      serverSlug: params.serverSlug,
      domain: params.domain,
      previousMainDomain: currentMainDomain,
      newMainDomain: identityDomain,
      identitySet,
      ptrSet: true,
      ptrSetByApi,
      ptrSetStatus,
      ptrFallbackReason,
      ptrSetFailureDetail,
      fcrdns,
      alreadyBound,
      approvalEventId: approval.eventId ?? null,
      approvalArtifactId: approval.artifactId ?? null
    }
  });
  await upsertDomainBinding(deps.workspace, {
    domain: params.domain,
    serverSlug: params.serverSlug,
    serverIp: server.ipv4 || "",
    status: "main_domain_bound"
  });

  json(response, 200, {
    ok: true,
    serverSlug: params.serverSlug,
    mainDomain: identityDomain,
    previousMainDomain: currentMainDomain,
    identitySet,
    ptrSet: true,
    fcrdnsVerified: true,
    fcrdnsStatus: "verified",
    fcrdns: fcrdnsSnapshot(fcrdns),
    alreadyBound,
    eventId: eventId(alignedEvent),
    durationMs: deps.now() - startedAt
  } satisfies BindWebdockMainDomainResult);
}

/**
 * Setea el hostname del server a la FQDN por SSH: `hostnamectl set-hostname <fqdn>` + actualiza la linea
 * 127.0.1.1 de /etc/hosts. Mirror del intent de WebdockRealAdapter.setServerHostnameViaSsh (idempotente:
 * si el hostname ya es la FQDN, no-op). El runner es el mismo operador-key del provisioning.
 */
async function setHostnameViaSsh(input: {
  sshRunner?: WebdockSshRunner;
  serverSlug: string;
  serverIp: string;
  fqdn: string;
}): Promise<void> {
  const runner = input.sshRunner;
  if (!runner || (runner.isConfigured && !runner.isConfigured())) {
    throw new BindWebdockMainDomainInputError("ssh_runner_missing");
  }

  const previous = await runBindSshWithCloudInitRetry({
    runner,
    serverSlug: input.serverSlug,
    serverIp: input.serverIp,
    command: "hostname",
    timeoutMs: 15_000
  });
  if (previous.exitCode !== 0) {
    throw new BindWebdockMainDomainInputError("hostname_read_failed");
  }
  const previousHostname = lastNonEmptyLine(previous.stdout);
  if (previousHostname === input.fqdn) {
    return; // ya alineado: idempotente.
  }

  const domainArg = shellSingleQuote(input.fqdn);
  const sudo = getProviderFromServerSlug(input.serverSlug) === "contabo" ? "" : "sudo ";
  const script = [
    "set -euo pipefail",
    `domain=${domainArg}`,
    `${sudo}hostnamectl set-hostname "$domain"`,
    "if grep -qE '^127\\.0\\.1\\.1[[:space:]]+' /etc/hosts; then",
    `  ${sudo}sed -i.bak -E "s/^127\\.0\\.1\\.1[[:space:]].*/127.0.1.1 $domain/" /etc/hosts`,
    "else",
    `  printf '127.0.1.1 %s\\n' "$domain" | ${sudo}tee -a /etc/hosts >/dev/null`,
    "fi",
    "hostname"
  ].join("\n");
  const result = await runBindSshWithCloudInitRetry({
    runner,
    serverSlug: input.serverSlug,
    serverIp: input.serverIp,
    command: script,
    timeoutMs: 30_000
  });
  const hostnameAfter = lastNonEmptyLine(result.stdout);
  if (result.exitCode !== 0 || hostnameAfter !== input.fqdn) {
    throw new BindWebdockMainDomainInputError("hostname_set_failed");
  }
}

async function runBindSshWithCloudInitRetry(input: {
  runner: WebdockSshRunner;
  serverSlug: string;
  serverIp: string;
  command: string;
  timeoutMs: number;
}): Promise<WebdockSshCommandResult> {
  const execution = await runWithTransientSshRetry({
    sleep,
    operation: () => input.runner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: input.command,
      timeoutMs: input.timeoutMs
    })
  });
  return execution.result;
}

function lastNonEmptyLine(value: string): string {
  const lines = value.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function contaboPtrManualFallbackAction(ip: string, ptr: string, providerId: string, detail?: string): string {
  const suffix = detail ? ` Automatic PTR API attempt failed: ${detail}.` : "";
  return `Set rDNS/PTR for ${ip} to ${ptr} in the ${providerId} panel, then rerun verification when DNS has propagated.${suffix}`;
}

export function createBindWebdockMainDomainApprovalGuard(input: {
  auditLog: AuditSink;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  now?: () => Date;
}): BindWebdockMainDomainApprovalGuard {
  return {
    async verify({ approvalToken, actorId }) {
      if (!input.auditLog.list) return { ok: false };
      const now = input.now?.() ?? new Date();
      const events = await input.auditLog.list();
      const auditEvent = events.toReversed().find((event) => {
        if (event.actorId !== actorId) return false;
        if (!auditApprovalMatchesToken(event, approvalToken)) return false;
        const approvedAt = Date.parse(event.occurredAt);
        return Number.isFinite(approvedAt) && now.getTime() - approvedAt >= 0 && now.getTime() - approvedAt <= approvalMaxAgeMs;
      });
      if (!auditEvent) return { ok: false };
      const state = await input.readCanvasState();
      const artifact = state.artifacts.find((candidate) =>
        artifactMatchesAuditApproval({
          artifact: candidate,
          approvalEvent: auditEvent,
          approvalToken,
          now,
          maxAgeMs: approvalMaxAgeMs
        })
      );
      return artifact ? { ok: true, eventId: auditEvent.id, artifactId: artifact.artifactId } : { ok: false };
    }
  };
}

export function handleBindWebdockMainDomainError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof SyntaxError) {
    json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return true;
  }
  return false;
}

async function rollbackMainDomain(input: {
  deps: BindWebdockMainDomainDeps;
  params: BindWebdockMainDomainParams;
  previousMainDomain: string | null;
  serverIp: string;
  reason: string;
  error: unknown;
}): Promise<{ ok: boolean }> {
  if (!input.previousMainDomain) {
    await auditInconsistentState(input, "previous_main_domain_missing", null);
    return { ok: false };
  }
  try {
    await input.deps.webdockAdapter.setServerMainDomain({
      serverSlug: input.params.serverSlug,
      domain: input.previousMainDomain,
      serverIp: input.serverIp,
      sshRunner: input.deps.sshRunner
    });
    await input.deps.auditLog.append({
      actorType: "operator",
      actorId: input.params.actorId,
      action: "oc.webdock.main_domain_rollback",
      targetType: "webdock_server",
      targetId: input.params.serverSlug,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [input.params.actorId],
      metadata: {
        serverSlug: input.params.serverSlug,
        restoredMainDomain: input.previousMainDomain,
        attemptedMainDomain: input.params.domain,
        reason: input.reason,
        error: errorMessage(input.error)
      }
    });
    return { ok: true };
  } catch (rollbackError) {
    await auditInconsistentState(input, "rollback_failed", rollbackError);
    return { ok: false };
  }
}

async function auditInconsistentState(input: {
  deps: BindWebdockMainDomainDeps;
  params: BindWebdockMainDomainParams;
  previousMainDomain: string | null;
  reason: string;
  error: unknown;
}, rollbackError: string, rollbackCause: unknown): Promise<void> {
  await input.deps.auditLog.append({
    actorType: "operator",
    actorId: input.params.actorId,
    action: "oc.webdock.bind_inconsistent_state",
    targetType: "webdock_server",
    targetId: input.params.serverSlug,
    riskLevel: "critical",
    decision: "reject",
    humanApproved: true,
    approverIds: [input.params.actorId],
    metadata: {
      serverSlug: input.params.serverSlug,
      attemptedMainDomain: input.params.domain,
      previousMainDomain: input.previousMainDomain,
      reason: input.reason,
      ptrError: errorMessage(input.error),
      rollbackError,
      rollbackCause: rollbackCause ? errorMessage(rollbackCause) : null,
      requiresManualIntervention: true
    }
  });
}

function parseParams(value: unknown, requireApproval: boolean): BindWebdockMainDomainParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BindWebdockMainDomainInputError("body_must_be_object");
  }
  const input = value as Record<string, unknown>;
  return {
    serverSlug: normalizeServerSlug(input.serverSlug),
    domain: normalizeDomain(input.domain),
    setPtr: input.setPtr === undefined ? true : requiredBoolean(input.setPtr, "setPtr"),
    actorId: requireApproval ? requiredString(input.actorId, "actorId") : "dispatcher",
    approvalToken: requireApproval ? requiredString(input.approvalToken, "approvalToken") : "dispatcher",
    ...optionalRepairScope(input)
  };
}

function optionalRepairScope(input: Record<string, unknown>): {
  repairReason?: string;
  explicitRepairScope?: string;
} {
  return {
    ...(typeof input.repairReason === "string" && input.repairReason.trim().length >= 10
      ? { repairReason: input.repairReason.trim().slice(0, 500) }
      : {}),
    ...(typeof input.explicitRepairScope === "string" && input.explicitRepairScope.trim().length >= 3
      ? { explicitRepairScope: input.explicitRepairScope.trim().slice(0, 300) }
      : {})
  };
}

function currentIdentityDomainFromServer(server: WebdockServer): string | null {
  const candidates = [server.mainDomain];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      return normalizeIdentityDomain(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

async function verifyFcrdnsWithRetry(input: {
  resolver: FcrdnsResolver;
  smtpHost: string;
  ipv4: string;
  maxWaitMs: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<FcrdnsCheckResult> {
  const pollIntervalMs = Math.max(0, input.pollIntervalMs);
  const attempts = Math.max(1, Math.floor(Math.max(0, input.maxWaitMs) / Math.max(1, pollIntervalMs || 1)) + 1);
  let latest: FcrdnsCheckResult = await checkFcrdns(input);
  for (let attempt = 1; attempt < attempts && !latest.verified; attempt += 1) {
    if (pollIntervalMs > 0) {
      await input.sleep(pollIntervalMs);
    }
    latest = await checkFcrdns(input);
  }
  return latest;
}

async function checkFcrdns(input: {
  resolver: FcrdnsResolver;
  smtpHost: string;
  ipv4: string;
}): Promise<FcrdnsCheckResult> {
  const expectedPtr = normalizeDnsName(input.smtpHost);
  const forwardA = await input.resolver.resolve4(input.smtpHost).catch(() => [] as string[]);
  const reversePtr = (await input.resolver.reverse(input.ipv4).catch(() => [] as string[])).map(normalizeDnsName);
  const forwardMatched = forwardA.includes(input.ipv4);
  const reverseMatched = reversePtr.includes(expectedPtr);
  return {
    verified: forwardMatched && reverseMatched,
    expectedA: input.ipv4,
    expectedPtr: `${expectedPtr}.`,
    forwardA,
    reversePtr: reversePtr.map((value) => `${value}.`),
    forwardMatched,
    reverseMatched
  };
}

function fcrdnsSnapshot(result: FcrdnsCheckResult): BindWebdockMainDomainResult["fcrdns"] {
  return {
    expectedA: result.expectedA,
    expectedPtr: result.expectedPtr,
    forwardA: result.forwardA,
    reversePtr: result.reversePtr
  };
}

function normalizeIdentityDomain(value: unknown): string {
  const normalized = requiredString(value, "domain").toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new BindWebdockMainDomainInputError("domain_invalid_format");
  }
  return normalized;
}

function normalizeDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertDomainBinding(
  workspace: OpenClawWorkspace | undefined,
  input: {
    domain: string;
    serverSlug: string;
    serverIp: string;
    status: string;
  }
): Promise<void> {
  if (!workspace) return;
  await workspace.updateInventoryJson<{
    bindings?: Array<{
      domain: string;
      serverSlug: string | null;
      serverIp: string;
      status: string;
    }>;
  }>("domains.json", (current) => {
    const bindings = (current?.bindings ?? []).filter((entry) => entry.domain !== input.domain);
    bindings.push(input);
    return {
      ...(current ?? {}),
      bindings
    };
  }).catch(() => undefined);
}

function normalizeServerSlug(value: unknown): string {
  const normalized = requiredString(value, "serverSlug").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(normalized)) {
    throw new BindWebdockMainDomainInputError("slug_invalid_format");
  }
  return normalized;
}

function normalizeDomain(value: unknown): string {
  const normalized = requiredString(value, "domain").toLowerCase().replace(/\.$/, "");
  if (/^(mail|email|notify|noreply|alert|smtp|sender|inbox|bulk|blast)\./i.test(normalized)) {
    throw new BindWebdockMainDomainInputError("domain_has_prohibited_prefix");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new BindWebdockMainDomainInputError("domain_invalid_format");
  }
  return normalized;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BindWebdockMainDomainInputError(`${field}_required`);
  }
  return value.trim();
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new BindWebdockMainDomainInputError(`${field}_must_be_boolean`);
  }
  return value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(request);
  if (!raw) throw new SyntaxError("empty_json_body");
  return JSON.parse(raw) as unknown;
}

function eventId(event: unknown): string {
  return event && typeof event === "object" && typeof (event as { id?: unknown }).id === "string"
    ? (event as { id: string }).id
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown bind_webdock_main_domain error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

class BindWebdockMainDomainInputError extends Error {}
