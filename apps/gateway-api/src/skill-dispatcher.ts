import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../packages/domain/src/index.ts";
import type { DnsProvider, VpsProvider } from "../../../packages/adapters/src/index.ts";
import type { ApprovalToken } from "./security/approval-token.ts";
import { createInternalHttpAdapter } from "./internal-http-adapter.ts";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";
import type { AutoRollbackManager, DnsDigFn } from "./auto-rollback.ts";
import {
  handleRoute53DomainRegisterHttp,
  type Route53DomainPurchaseAdapter
} from "./routes/domains-purchase.ts";
import {
  handleRoute53DnsUpsertHttp,
  type Route53DnsAdapter
} from "./routes/domains-dns.ts";
import {
  handleIonosDnsUpsertHttp,
  type IonosDnsUpsertAdapter
} from "./routes/dns-ionos-upsert.ts";
import {
  handleWebdockServerCreateHttp,
  type WebdockServerCreateAdapter,
  type WebdockServerDeleteAdapter
} from "./routes/webdock-servers.ts";
import {
  bindWebdockMainDomainSkillParamSchema,
  createBindWebdockMainDomainApprovalGuard,
  handleBindWebdockMainDomain,
  type BindWebdockMainDomainAdapter
} from "./routes/webdock-bind-domain.ts";
import {
  handleSmtpProvisionHttp,
  type SmtpSshRunner
} from "./routes/smtp-provisioning.ts";
import {
  handleEmailAuthConfigureHttp,
  type EmailAuthDnsAdapter
} from "./routes/domains-email-auth.ts";
import { handleEnableSmtpAuthHttp } from "./routes/enable-smtp-auth.ts";
import { handleDomainBindHttp } from "./routes/domains-bind.ts";
import { handleWarmupStartHttp } from "./routes/warmup.ts";
import {
  handleRampStartHttp,
  type RampScheduler
} from "./routes/warmup-ramp.ts";
import {
  createDomainAvailabilityCheck,
  handleSuggestSafeDomainHttp,
  suggestSafeDomainParamSchema,
  type DomainAvailabilityAdapter
} from "./routes/domains-suggest.ts";
import {
  createAuditApprovalGuard,
  handleWaitForDnsPropagationHttp,
  waitForDnsPropagationSkillParamSchema,
  type DnsResolver
} from "./routes/dns-wait.ts";
import {
  handleSendRealEmailHttp,
  sendRealEmailSkillParamSchema
} from "./routes/send-email.ts";
import {
  bindDomainParamSchema,
  configureCompleteSmtpSkillParamSchema,
  emailAuthParamSchema,
  enableSmtpAuthParamSchema,
  inspectSmtpInventoryParamSchema,
  ionosUpsertParamSchema,
  reassignDomainServerParamSchema,
  reconcileDnsToLiveSmtpParamSchema,
  resolveAmbiguousDomainParamSchema,
  retireInfrastructureAccountParamSchema,
  retireSmtpEntryParamSchema,
  route53NameserverUpdateParamSchema,
  route53RegisterParamSchema,
  route53UpsertParamSchema,
  smtpProvisionParamSchema,
  updateSmtpEntryParamSchema,
  warmupRampParamSchema,
  warmupSeedParamSchema,
  webdockCreateParamSchema,
  type SkillParamSchema
} from "./skill-schemas.ts";
import { canonicalSkillSlug } from "./skill-contracts.ts";
import {
  handleConfigureCompleteSmtp,
  type ConfigureCompleteSmtpDeps
} from "./routes/orchestrator-smtp.ts";
import {
  handleDomainNameserverUpdateHttp,
  type DomainNameserverRegistrarAdapter
} from "./routes/domain-nameservers.ts";
import {
  reassignSmtpDomainServer,
  resolveAmbiguousSmtpDomain,
  retireSmtpInventoryEntry,
  updateSmtpInventoryEntry,
  type SmtpInventoryLiveServer
} from "./smtp-inventory-management.ts";
import { reconcileDnsToLiveSmtp } from "./reconcile-dns-live-smtp.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

interface BroadcastSink {
  broadcast(event: AuditEventInput): Promise<unknown>;
}

interface KillSwitchProvider {
  enabled: boolean;
}

interface InfrastructureAccountLifecycleStore {
  retire(input: {
    providerId: string;
    accountId: string;
    accountLabel?: string;
    reason: string;
    actorId: string;
    retiredAt: string;
  }): Promise<{
    accountKey: string;
    providerId: string;
    accountId: string;
    accountLabel: string;
    lifecycleStatus: string;
    healthStatus: string;
    retiredAt?: string;
    retiredBy?: string;
    retiredReason?: string;
  }>;
}

export interface SkillDispatcherDeps {
  auditLog: AuditSink;
  workspace: OpenClawWorkspace;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  domainPurchaseAdapter: Route53DomainPurchaseAdapter & Partial<DomainNameserverRegistrarAdapter>;
  route53DnsAdapter: Route53DnsAdapter & EmailAuthDnsAdapter;
  ionosDnsAdapter: IonosDnsUpsertAdapter;
  webdockAdapter: WebdockServerCreateAdapter & Partial<BindWebdockMainDomainAdapter>;
  /**
   * Registry id->adapter para operaciones account-aware en N cuentas Webdock (5.12 multicuenta).
   * Solo cuentas write-capable (canCreate()===true). La resolucion del accountId pedido
   * cae al webdockAdapter (cuenta-1 "ops") cuando el accountId es undefined, "ops", o no
   * esta en el registry, para preservar el comportamiento single-account byte-identico.
   */
  webdockCreateAdapters?: Map<string, WebdockServerCreateAdapter & Partial<WebdockServerDeleteAdapter> & Partial<BindWebdockMainDomainAdapter>>;
  /**
   * Registry providerId->adapter para crear/borrar en proveedores NO-Webdock (Contabo, etc.).
   * Canal PARALELO HERMANO de webdockCreateAdapters. Se consulta SOLO cuando el providerId del
   * canal paralelo esta presente y != "webdock"; cualquier otro caso cae a la logica Webdock por
   * accountId UNCHANGED (single-provider byte-identico). VpsProvider es asignable estructuralmente
   * a WebdockServerCreateAdapter & Partial<WebdockServerDeleteAdapter>.
   */
  vpsProviderAdapters?: Map<string, VpsProvider>;
  /**
   * Registry dnsProviderId->adapter para DNS multiproveedor (Route53, IONOS, ...).
   * Canal futuro PARALELO HERMANO: no entra en params ni modifica hashInput/scope.
   * Etapa 2 solo lo cablea; el orquestador sigue usando Route53 por defecto.
   */
  dnsProviderAdapters?: Map<string, DnsProvider>;
  smtpSshRunner: SmtpSshRunner;
  rampScheduler: RampScheduler;
  porkbunDomainAdapter?: DomainAvailabilityAdapter;
  canvasLiveEvents?: CanvasEmitter;
  autoRollbackManager?: AutoRollbackManager;
  webhookBroadcaster?: BroadcastSink;
  dnsDigFn?: DnsDigFn;
  dnsResolver?: DnsResolver;
  readKillSwitch?: () => Promise<KillSwitchProvider> | KillSwitchProvider;
  configureSmtpDeps?: Pick<
    ConfigureCompleteSmtpDeps,
    "invokeSkill" | "submitAndAwaitApproval" | "submitRollbackProposal" | "verifyAuditChain"
  >;
  accountLifecycleStore?: InfrastructureAccountLifecycleStore;
  readSmtpInventoryLiveServers?: () => Promise<SmtpInventoryLiveServer[]>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface DispatchSkillHandlerInput {
  skill: string;
  params: unknown;
  actorId: string;
  approvalToken: ApprovalToken;
  timeoutMs?: number;
  /**
   * Cuenta Webdock destino para operaciones account-aware (create/bind/delete). Canal PARALELO:
   * NO entra a `params` (no toca el hashInput/idempotencia del orquestador). undefined
   * o "ops" => cuenta-1 (webdockAdapter), byte-identico al comportamiento de hoy.
   */
  accountId?: string;
  /**
   * Proveedor de VPS destino para operaciones account-aware. Canal PARALELO HERMANO de accountId:
   * NO entra a `params`. undefined o "webdock" => Webdock (resuelve por accountId, sin cambios).
   * Presente y != "webdock" => el vpsProviderAdapters de esa key (Contabo, etc.).
   */
  providerId?: string;
  /**
   * Proveedor DNS destino. Canal PARALELO HERMANO: NO entra a `params`. undefined/"route53"
   * preserva Route53; "ionos" exige registry DNS disponible.
   */
  dnsProviderId?: string;
  deps?: SkillDispatcherDeps;
  handlers?: Record<string, SkillHandlerEntry>;
}

export interface DispatchResult {
  ok: boolean;
  statusCode: number;
  summary: unknown;
  durationMs: number;
  settled?: Promise<DispatchResult>;
}

interface SkillHandlerTimeoutInput {
  params: Record<string, unknown>;
  deps: SkillDispatcherDeps;
  accountId?: string;
  providerId?: string;
  dnsProviderId?: string;
}

type SkillHandlerTimeoutMs = number | ((input: SkillHandlerTimeoutInput) => number);

export interface SkillDispatcher {
  dispatch(input: Omit<DispatchSkillHandlerInput, "deps" | "handlers">): Promise<DispatchResult>;
}

export interface SkillHandlerEntry {
  paramSchema: SkillParamSchema;
  timeoutMs: SkillHandlerTimeoutMs;
  canRollback: boolean;
  invoke(input: {
    request: IncomingMessage;
    response: ServerResponse;
    params: Record<string, unknown>;
    deps: SkillDispatcherDeps;
    accountId?: string;
    providerId?: string;
    dnsProviderId?: string;
  }): Promise<void>;
}

/**
 * Contabo rDNS/PTR is panel-only. Step 8 waits briefly for FCrDNS, then returns an advisory pending
 * response. Defaults: wait 180s, cap operator override at 240s, poll no faster than 5s, and keep the
 * handler cap at 300s so SSH/audit overhead cannot trigger the shared dispatcher timeout.
 */
const contaboBindFcrdnsDefaultMaxWaitMs = 180_000;
const contaboBindFcrdnsMaxWaitCapMs = 240_000;
const contaboBindFcrdnsMinPollIntervalMs = 5_000;
const contaboBindHandlerTimeoutCapMs = 300_000;
const contaboBindHandlerTimeoutPaddingMs = 60_000;

export function createSkillDispatcher(deps: SkillDispatcherDeps): SkillDispatcher {
  return {
    dispatch: (input) => dispatchSkillHandler({ ...input, deps })
  };
}

export async function dispatchSkillHandler(input: DispatchSkillHandlerInput): Promise<DispatchResult> {
  const handlers = input.handlers ?? (input.deps ? createDefaultSkillHandlerMap() : {});
  const skill = canonicalSkillSlug(input.skill);
  const entry = handlers[skill] ?? handlers[input.skill];
  if (!entry) {
    return {
      ok: false,
      statusCode: 404,
      summary: { error: "unknown_skill", skill: input.skill },
      durationMs: 0
    };
  }

  if (!input.deps) {
    return {
      ok: false,
      statusCode: 500,
      summary: { error: "dispatcher_dependencies_missing", skill: input.skill },
      durationMs: 0
    };
  }

  const paramsValidation = entry.paramSchema.safeParse(input.params);
  if (!paramsValidation.success) {
    return {
      ok: false,
      statusCode: 400,
      summary: {
        error: "params_validation_failed",
        details: paramsValidation.error.format()
      },
      durationMs: 0
    };
  }

  const unknownVpsProvider = unknownExternalVpsProviderId(input.providerId, input.deps.vpsProviderAdapters);
  if (unknownVpsProvider) {
    return {
      ok: false,
      statusCode: 422,
      summary: { error: "unknown_vps_provider", providerId: unknownVpsProvider },
      durationMs: 0
    };
  }
  const unknownDnsProvider = unknownExternalDnsProviderId(input.dnsProviderId, input.deps.dnsProviderAdapters);
  if (unknownDnsProvider) {
    return {
      ok: false,
      statusCode: 422,
      summary: { error: "unknown_dns_provider", dnsProviderId: unknownDnsProvider },
      durationMs: 0
    };
  }

  const body = {
    ...paramsValidation.data,
    actorId: input.actorId,
    approvalToken: input.approvalToken.tokenId
  };
  const { request, response, getResponse } = createInternalHttpAdapter({ body });
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? resolveSkillHandlerTimeoutMs(entry.timeoutMs, {
    params: paramsValidation.data,
    deps: input.deps,
    accountId: input.accountId,
    providerId: input.providerId,
    dnsProviderId: input.dnsProviderId
  });

  const killSwitch = await input.deps.readKillSwitch?.();
  if (killSwitch?.enabled) {
    return {
      ok: false,
      statusCode: 423,
      summary: { error: "kill_switch_armed" },
      durationMs: Date.now() - startedAt
    };
  }

  const execution = invokeAndCapture(entry, {
    request,
    response,
    params: paramsValidation.data,
    deps: input.deps,
    accountId: input.accountId,
    providerId: input.providerId,
    dnsProviderId: input.dnsProviderId,
    getResponse,
    startedAt
  });

  try {
    return await withTimeout(execution, timeoutMs);
  } catch (error) {
    if (error instanceof DispatchTimeoutError) {
      return {
        ok: false,
        statusCode: 504,
        summary: { error: "handler_timeout", timeoutMs },
        durationMs: Date.now() - startedAt,
        settled: execution
      };
    }

    return {
      ok: false,
      statusCode: 500,
      summary: { error: "handler_threw", message: errorMessage(error) },
      durationMs: Date.now() - startedAt
    };
  }
}

async function invokeAndCapture(entry: SkillHandlerEntry, input: {
  request: IncomingMessage;
  response: ServerResponse;
  params: Record<string, unknown>;
  deps: SkillDispatcherDeps;
  accountId?: string;
  providerId?: string;
  dnsProviderId?: string;
  getResponse: () => { statusCode: number; body: unknown };
  startedAt: number;
}): Promise<DispatchResult> {
  try {
    await entry.invoke({
      request: input.request,
      response: input.response,
      params: input.params,
      deps: input.deps,
      accountId: input.accountId,
      providerId: input.providerId,
      dnsProviderId: input.dnsProviderId
    });
    const captured = input.getResponse();
    return {
      ok: captured.statusCode >= 200 && captured.statusCode < 300,
      statusCode: captured.statusCode,
      summary: captured.body,
      durationMs: Date.now() - input.startedAt
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 500,
      summary: { error: "handler_threw", message: errorMessage(error) },
      durationMs: Date.now() - input.startedAt
    };
  }
}

function createDefaultSkillHandlerMap(): Record<string, SkillHandlerEntry> {
  const registerDomain: SkillHandlerEntry = {
    paramSchema: route53RegisterParamSchema,
    timeoutMs: 60_000,
    canRollback: true,
    invoke: ({ request, response, deps }) =>
      handleRoute53DomainRegisterHttp({
        request,
        response,
        auditLog: deps.auditLog,
        adapter: deps.domainPurchaseAdapter,
        workspace: deps.workspace,
        readCanvasState: deps.readCanvasState,
        env: deps.env,
        now: deps.now
      })
  };
  const route53Dns: SkillHandlerEntry = {
    paramSchema: route53UpsertParamSchema,
    timeoutMs: 30_000,
    canRollback: true,
    invoke: ({ request, response, deps }) =>
      handleRoute53DnsUpsertHttp({
        request,
        response,
        auditLog: deps.auditLog,
        adapter: deps.route53DnsAdapter,
        workspace: deps.workspace,
        getDomainNameservers: typeof deps.domainPurchaseAdapter.getDomainNameservers === "function"
          ? (domain) => deps.domainPurchaseAdapter.getDomainNameservers?.(domain) ?? Promise.resolve([])
          : undefined,
        canvasLiveEvents: deps.canvasLiveEvents,
        autoRollbackManager: deps.autoRollbackManager,
        webhookBroadcaster: deps.webhookBroadcaster,
        dnsDigFn: deps.dnsDigFn,
        readCanvasState: deps.readCanvasState,
        now: deps.now
      })
  };
  const route53NameserverUpdate: SkillHandlerEntry = {
    paramSchema: route53NameserverUpdateParamSchema,
    timeoutMs: 60_000,
    canRollback: false,
    invoke: ({ request, response, deps }) => {
      if (
        typeof deps.domainPurchaseAdapter.isNameserverUpdateEnabled !== "function" ||
        typeof deps.domainPurchaseAdapter.getDomainNameservers !== "function" ||
        typeof deps.domainPurchaseAdapter.updateDomainNameservers !== "function"
      ) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "route53_nameserver_adapter_missing" }));
        return Promise.resolve();
      }
      return handleDomainNameserverUpdateHttp({
        request,
        response,
        auditLog: deps.auditLog,
        registrarAdapter: deps.domainPurchaseAdapter as DomainNameserverRegistrarAdapter,
        dnsAdapter: deps.route53DnsAdapter,
        workspace: deps.workspace,
        canvasLiveEvents: deps.canvasLiveEvents,
        readCanvasState: deps.readCanvasState,
        readKillSwitch: async () => await deps.readKillSwitch?.() ?? { enabled: true },
        now: deps.now
      });
    }
  };
  const ionosDns: SkillHandlerEntry = {
    paramSchema: ionosUpsertParamSchema,
    timeoutMs: 30_000,
    canRollback: true,
    invoke: ({ request, response, deps }) =>
      handleIonosDnsUpsertHttp({
        request,
        response,
        auditLog: deps.auditLog,
        adapter: deps.ionosDnsAdapter,
        workspace: deps.workspace,
        readCanvasState: deps.readCanvasState,
        autoRollbackManager: deps.autoRollbackManager,
        webhookBroadcaster: deps.webhookBroadcaster,
        env: deps.env,
        now: deps.now
      })
  };
  const webdockCreate: SkillHandlerEntry = {
    paramSchema: webdockCreateParamSchema,
    timeoutMs: 120_000,
    canRollback: false,
    invoke: ({ request, response, deps, accountId, providerId }) =>
      handleWebdockServerCreateHttp({
        request,
        response,
        auditLog: deps.auditLog,
        adapter: resolveWebdockCreateAdapter(deps, accountId, providerId),
        workspace: deps.workspace,
        canvasLiveEvents: deps.canvasLiveEvents,
        readCanvasState: deps.readCanvasState,
        env: deps.env,
        providerId,
        serverAccountId: accountId,
        now: deps.now
      })
  };
  const bindWebdockMainDomain: SkillHandlerEntry = {
    paramSchema: bindWebdockMainDomainSkillParamSchema,
    timeoutMs: ({ providerId, deps }) => resolveContaboBindTiming(providerId, deps.env, 120_000).handlerTimeoutMs,
    canRollback: true,
    // providerId/accountId (canales HERMANOS) viajan por invoke: providerId enruta binds no-Webdock;
    // accountId enruta binds Webdock no-default al adapter de esa cuenta. undefined/"webdock" + ops
    // preservan el bind Webdock single-account byte-identico.
    invoke: ({ request, response, deps, accountId, providerId }) =>
      handleBindWebdockMainDomain({
        request,
        response,
        providerId,
        deps: {
          auditLog: deps.auditLog,
          approvalGuard: createBindWebdockMainDomainApprovalGuard({
            auditLog: deps.auditLog,
            readCanvasState: deps.readCanvasState,
            now: deps.now
          }),
          webdockAdapter: resolveWebdockCreateAdapter(deps, accountId, providerId) as BindWebdockMainDomainAdapter,
          vpsProviderAdapters: deps.vpsProviderAdapters,
          sshRunner: deps.smtpSshRunner,
          workspace: deps.workspace,
          now: () => (deps.now?.() ?? new Date()).getTime(),
          ...contaboBindFcrdnsDeps(providerId, deps.env)
        }
      })
  };
  const smtpProvision: SkillHandlerEntry = {
    paramSchema: smtpProvisionParamSchema,
    timeoutMs: 90_000,
    canRollback: true,
    invoke: ({ request, response, params, deps }) =>
      handleSmtpProvisionHttp({
        request,
        response,
        serverSlug: String(params.serverSlug),
        auditLog: deps.auditLog,
        sshRunner: deps.smtpSshRunner,
        workspace: deps.workspace,
        canvasLiveEvents: deps.canvasLiveEvents,
        readCanvasState: deps.readCanvasState,
        env: deps.env,
        now: deps.now
      })
  };
  const emailAuth: SkillHandlerEntry = {
    paramSchema: emailAuthParamSchema,
    timeoutMs: 30_000,
    canRollback: true,
    invoke: ({ request, response, deps }) =>
      handleEmailAuthConfigureHttp({
        request,
        response,
        auditLog: deps.auditLog,
        dnsAdapter: deps.route53DnsAdapter,
        workspace: deps.workspace,
        getDomainNameservers: typeof deps.domainPurchaseAdapter.getDomainNameservers === "function"
          ? (domain) => deps.domainPurchaseAdapter.getDomainNameservers?.(domain) ?? Promise.resolve([])
          : undefined,
        canvasLiveEvents: deps.canvasLiveEvents,
        readCanvasState: deps.readCanvasState,
        env: deps.env,
        now: deps.now
      })
  };
  const reconcileDnsToLiveSmtpHandler: SkillHandlerEntry = {
    paramSchema: reconcileDnsToLiveSmtpParamSchema,
    timeoutMs: 45_000,
    canRollback: false,
    invoke: async ({ request, response, params, deps }) => {
      const actorId = await readActorId(request);
      const liveServers = await readRequiredSmtpLiveServers(response, deps);
      if (!liveServers) return;
      const result = await reconcileDnsToLiveSmtp({
        workspace: deps.workspace,
        route53DnsAdapter: deps.route53DnsAdapter,
        auditLog: deps.auditLog,
        liveServers,
        domain: String(params.domain),
        serverSlug: String(params.serverSlug),
        ...(typeof params.serverIp === "string" ? { serverIp: params.serverIp } : {}),
        ...(typeof params.selector === "string" ? { selector: params.selector } : {}),
        actorId,
        dryRun: params.dryRun === true,
        ...(typeof params.taskId === "string" ? { taskId: params.taskId } : {}),
        ...(typeof params.repairReason === "string" ? { reason: params.repairReason } : {}),
        getDomainNameservers: typeof deps.domainPurchaseAdapter.getDomainNameservers === "function"
          ? (domain) => deps.domainPurchaseAdapter.getDomainNameservers?.(domain) ?? Promise.resolve([])
          : undefined,
        now: deps.now
      });
      writeJson(response, result.ok ? 200 : 409, result);
    }
  };
  const enableSmtpAuth: SkillHandlerEntry = {
    paramSchema: enableSmtpAuthParamSchema,
    timeoutMs: 120_000,
    canRollback: false,
    invoke: ({ request, response, deps }) =>
      handleEnableSmtpAuthHttp({
        request,
        response,
        workspace: deps.workspace,
        auditLog: deps.auditLog,
        sshRunner: deps.smtpSshRunner,
        env: deps.env,
        now: deps.now
      })
  };
  const domainBind: SkillHandlerEntry = {
    paramSchema: bindDomainParamSchema,
    timeoutMs: 15_000,
    canRollback: true,
    invoke: ({ request, response, deps }) =>
      handleDomainBindHttp({
        request,
        response,
        auditLog: deps.auditLog,
        dnsAdapter: deps.route53DnsAdapter,
        workspace: deps.workspace,
        canvasLiveEvents: deps.canvasLiveEvents,
        readCanvasState: deps.readCanvasState,
        env: deps.env,
        now: deps.now
      })
  };
  const warmupSeed: SkillHandlerEntry = {
    paramSchema: warmupSeedParamSchema,
    timeoutMs: 30_000,
    canRollback: false,
    invoke: ({ request, response, deps }) =>
      handleWarmupStartHttp({
        request,
        response,
        auditLog: deps.auditLog,
        sshRunner: deps.smtpSshRunner,
        workspace: deps.workspace,
        canvasLiveEvents: deps.canvasLiveEvents,
        readCanvasState: deps.readCanvasState,
        env: deps.env,
        now: deps.now
      })
  };
  const warmupRamp: SkillHandlerEntry = {
    paramSchema: warmupRampParamSchema,
    timeoutMs: 60_000,
    canRollback: false,
    invoke: ({ request, response, deps }) =>
      handleRampStartHttp({
        request,
        response,
        scheduler: deps.rampScheduler,
        auditLog: deps.auditLog,
        sshRunner: deps.smtpSshRunner,
        workspace: deps.workspace,
        readCanvasState: deps.readCanvasState,
        env: deps.env,
        now: deps.now
      })
  };
  const suggestSafeDomain: SkillHandlerEntry = {
    paramSchema: suggestSafeDomainParamSchema,
    timeoutMs: 30_000,
    canRollback: false,
    invoke: ({ request, response, deps }) =>
      handleSuggestSafeDomainHttp({
        request,
        response,
        deps: {
          auditLog: deps.auditLog,
          route53Availability: createDomainAvailabilityCheck(deps.domainPurchaseAdapter as unknown as DomainAvailabilityAdapter),
          porkbunAvailability: createDomainAvailabilityCheck(requiredPorkbunDomainAdapter(deps)),
          now: deps.now
        }
      })
  };
  const waitForDnsPropagation: SkillHandlerEntry = {
    paramSchema: waitForDnsPropagationSkillParamSchema,
    timeoutMs: 700_000,
    canRollback: false,
    invoke: ({ request, response, deps }) =>
      handleWaitForDnsPropagationHttp({
        request,
        response,
        auditLog: deps.auditLog,
        approvalGuard: createAuditApprovalGuard({
          auditLog: deps.auditLog,
          readCanvasState: deps.readCanvasState,
          now: deps.now
        }),
        dns: deps.dnsResolver,
        now: () => (deps.now?.() ?? new Date()).getTime(),
        readKillSwitch: deps.readKillSwitch
      })
  };
  const sendRealEmail: SkillHandlerEntry = {
    paramSchema: sendRealEmailSkillParamSchema,
    timeoutMs: 90_000,
    canRollback: false,
    invoke: ({ request, response, deps }) =>
      handleSendRealEmailHttp({
        request,
        response,
        auditLog: deps.auditLog,
        sshRunner: deps.smtpSshRunner,
        workspace: deps.workspace,
        readCanvasState: deps.readCanvasState,
        readKillSwitch: deps.readKillSwitch,
        now: deps.now
      })
  };
  const configureCompleteSmtp: SkillHandlerEntry = {
    paramSchema: configureCompleteSmtpSkillParamSchema,
    timeoutMs: 3 * 60 * 60 * 1000,
    canRollback: false,
    invoke: ({ request, response, deps }) => {
      if (!deps.configureSmtpDeps) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "configure_smtp_deps_missing" }));
        return Promise.resolve();
      }
      return handleConfigureCompleteSmtp({
        request,
        response,
        auditLog: deps.auditLog,
        canvasLiveEvents: deps.canvasLiveEvents,
        readKillSwitch: deps.readKillSwitch,
        env: deps.env,
        now: deps.now,
        ...deps.configureSmtpDeps
      });
    }
  };
  const retireInfrastructureAccount: SkillHandlerEntry = {
    paramSchema: retireInfrastructureAccountParamSchema,
    timeoutMs: 30_000,
    canRollback: false,
    invoke: async ({ request, response, params, deps }) => {
      if (!deps.accountLifecycleStore) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "account_lifecycle_store_missing" }));
        return;
      }
      const body = await readInternalJson(request);
      const actorId = typeof body.actorId === "string" && body.actorId.trim()
        ? body.actorId.trim()
        : "openclaw";
      const retiredAt = (deps.now?.() ?? new Date()).toISOString();
      const account = await deps.accountLifecycleStore.retire({
        providerId: String(params.providerId),
        accountId: String(params.accountId),
        ...(typeof params.accountLabel === "string" ? { accountLabel: params.accountLabel } : {}),
        reason: String(params.reason),
        actorId,
        retiredAt
      });
      const rollbackPlan = infrastructureAccountRetireRollbackPlan();
      await deps.auditLog.append({
        actorType: "operator",
        actorId,
        action: "oc.infrastructure.account_retired",
        targetType: "infrastructure_account",
        targetId: account.accountKey,
        riskLevel: "high",
        decision: "allow",
        metadata: {
          providerId: account.providerId,
          accountId: account.accountId,
          accountLabel: account.accountLabel,
          lifecycleStatus: account.lifecycleStatus,
          healthStatus: account.healthStatus,
          retiredAt: account.retiredAt ?? retiredAt,
          retiredBy: account.retiredBy ?? actorId,
          retiredReason: account.retiredReason ?? String(params.reason),
          sideEffects: "local-state-only",
          physicalDelete: false,
          rollbackPlan
        }
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        account,
        sideEffects: "local-state-only",
        physicalDelete: false,
        rollbackPlan
      }));
    }
  };
  const resolveAmbiguousDomain: SkillHandlerEntry = {
    paramSchema: resolveAmbiguousDomainParamSchema,
    timeoutMs: 30_000,
    canRollback: false,
    invoke: async ({ request, response, params, deps }) => {
      const actorId = await readActorId(request);
      const liveServers = await readRequiredSmtpLiveServers(response, deps);
      if (!liveServers) return;
      const result = await resolveAmbiguousSmtpDomain({
        workspace: deps.workspace,
        domain: String(params.domain),
        ...(typeof params.keepServerSlug === "string" ? { keepServerSlug: params.keepServerSlug } : {}),
        liveServers,
        actorId,
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        dryRun: params.dryRun === true,
        now: deps.now
      });
      await appendSmtpInventoryMutationAudit(deps, actorId, "oc.smtp_inventory.ambiguous_domain_resolved", result);
      writeJson(response, result.ok ? 200 : 409, result);
    }
  };
  const retireSmtpEntry: SkillHandlerEntry = {
    paramSchema: retireSmtpEntryParamSchema,
    timeoutMs: 30_000,
    canRollback: false,
    invoke: async ({ request, response, params, deps }) => {
      const actorId = await readActorId(request);
      const liveServers = await readRequiredSmtpLiveServers(response, deps);
      if (!liveServers) return;
      const result = await retireSmtpInventoryEntry({
        workspace: deps.workspace,
        domain: String(params.domain),
        serverSlug: String(params.serverSlug),
        liveServers,
        actorId,
        reason: String(params.reason),
        dryRun: params.dryRun === true,
        now: deps.now
      });
      await appendSmtpInventoryMutationAudit(deps, actorId, "oc.smtp_inventory.entry_retired", result);
      writeJson(response, result.ok ? 200 : 409, result);
    }
  };
  const reassignDomainServer: SkillHandlerEntry = {
    paramSchema: reassignDomainServerParamSchema,
    timeoutMs: 30_000,
    canRollback: false,
    invoke: async ({ request, response, params, deps }) => {
      const actorId = await readActorId(request);
      const liveServers = await readRequiredSmtpLiveServers(response, deps);
      if (!liveServers) return;
      const result = await reassignSmtpDomainServer({
        workspace: deps.workspace,
        domain: String(params.domain),
        fromServerSlug: String(params.fromServerSlug),
        toServerSlug: String(params.toServerSlug),
        liveServers,
        actorId,
        reason: String(params.reason),
        dryRun: params.dryRun === true,
        now: deps.now
      });
      await appendSmtpInventoryMutationAudit(deps, actorId, "oc.smtp_inventory.domain_reassigned", result);
      writeJson(response, result.ok ? 200 : 409, result);
    }
  };
  const updateSmtpEntry: SkillHandlerEntry = {
    paramSchema: updateSmtpEntryParamSchema,
    timeoutMs: 30_000,
    canRollback: false,
    invoke: async ({ request, response, params, deps }) => {
      const actorId = await readActorId(request);
      const liveServers = await readRequiredSmtpLiveServers(response, deps);
      if (!liveServers) return;
      const patch = {
        ...(typeof params.selector === "string" ? { selector: params.selector } : {}),
        ...(typeof params.status === "string" ? { status: params.status as "configured" | "superseded" | "retired" | "archived" } : {}),
        ...(typeof params.tlsStatus === "string" ? { tlsStatus: params.tlsStatus } : {}),
        ...(typeof params.smtpAuthStatus === "string" ? { smtpAuthStatus: params.smtpAuthStatus as "configured" } : {})
      };
      const result = await updateSmtpInventoryEntry({
        workspace: deps.workspace,
        domain: String(params.domain),
        serverSlug: String(params.serverSlug),
        patch,
        liveServers,
        actorId,
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        dryRun: params.dryRun === true,
        now: deps.now
      });
      await appendSmtpInventoryMutationAudit(deps, actorId, "oc.smtp_inventory.entry_updated", result);
      writeJson(response, result.ok ? 200 : 409, result);
    }
  };

  return {
    register_domain_route53: registerDomain,
    suggest_safe_domain: suggestSafeDomain,
    naming_suggest: suggestSafeDomain,
    upsert_dns_route53: route53Dns,
    route53_dns_upsert: route53Dns,
    update_domain_nameservers: route53NameserverUpdate,
    route53_domain_nameservers_update: route53NameserverUpdate,
    upsert_dns_ionos: ionosDns,
    ionos_dns_upsert: ionosDns,
    create_webdock_server: webdockCreate,
    provision_webdock_vps: webdockCreate,
    bind_webdock_main_domain: bindWebdockMainDomain,
    webdock_main_domain_bind: bindWebdockMainDomain,
    provision_smtp_postfix: smtpProvision,
    install_smtp_stack: smtpProvision,
    configure_email_auth: emailAuth,
    reconcile_dns_to_live_smtp: reconcileDnsToLiveSmtpHandler,
    enable_smtp_auth: enableSmtpAuth,
    bind_domain_to_server: domainBind,
    seed_warmup_pool: warmupSeed,
    start_warmup_seed: warmupSeed,
    start_warmup_ramp: warmupRamp,
    warmup_ramp_scheduler: warmupRamp,
    wait_for_dns_propagation: waitForDnsPropagation,
    dns_propagation_wait: waitForDnsPropagation,
    send_real_email: sendRealEmail,
    smtp_send_real: sendRealEmail,
    smtp_send_real_email: sendRealEmail,
    configure_complete_smtp: configureCompleteSmtp,
    configure_smtp_complete: configureCompleteSmtp,
    retire_infrastructure_account: retireInfrastructureAccount,
    retire_provider_account_local: retireInfrastructureAccount,
    resolve_ambiguous_domain: resolveAmbiguousDomain,
    retire_smtp_entry: retireSmtpEntry,
    reassign_domain_server: reassignDomainServer,
    update_smtp_entry: updateSmtpEntry
  };
}

function infrastructureAccountRetireRollbackPlan(): Record<string, unknown> {
  return {
    mode: "manual_local_state",
    canRollbackAutomatically: false,
    procedure: "Edit LOCAL_INFRASTRUCTURE_ACCOUNT_LIFECYCLE_FILE or runtime/infrastructure-account-lifecycle.json and remove the account record, or set lifecycleStatus to active and healthStatus to healthy, then rerun inventory health.",
    futureSkill: "reactivate_infrastructure_account"
  };
}

async function readInternalJson(request: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readActorId(request: AsyncIterable<unknown>): Promise<string> {
  const body = await readInternalJson(request);
  return typeof body.actorId === "string" && body.actorId.trim()
    ? body.actorId.trim()
    : "openclaw";
}

async function readRequiredSmtpLiveServers(
  response: ServerResponse,
  deps: SkillDispatcherDeps
): Promise<SmtpInventoryLiveServer[] | null> {
  if (!deps.readSmtpInventoryLiveServers) {
    writeJson(response, 503, { error: "smtp_inventory_live_source_missing" });
    return null;
  }
  return deps.readSmtpInventoryLiveServers();
}

async function appendSmtpInventoryMutationAudit(
  deps: SkillDispatcherDeps,
  actorId: string,
  action: string,
  result: { ok: boolean; domain?: string; serverSlug?: string; canonicalServerSlug?: string; status: string; dryRun: boolean; changed: boolean; reason?: string; plan?: Record<string, unknown>; error?: string }
): Promise<void> {
  await deps.auditLog.append({
    actorType: "operator",
    actorId,
    action,
    targetType: result.domain ? "domain" : "smtp_inventory",
    targetId: result.domain ?? result.serverSlug ?? "smtp-provisioning",
    riskLevel: "high",
    decision: result.ok ? "allow" : "reject",
    humanApproved: true,
    approverIds: [actorId],
    metadata: {
      domain: result.domain,
      serverSlug: result.serverSlug,
      canonicalServerSlug: result.canonicalServerSlug,
      status: result.status,
      dryRun: result.dryRun,
      changed: result.changed,
      reason: result.reason,
      error: result.error,
      sideEffects: "local-state-only",
      rollbackPlan: smtpInventoryRollbackPlan(result),
      plan: result.plan
    }
  });
}

function smtpInventoryRollbackPlan(result: { domain?: string; serverSlug?: string; plan?: Record<string, unknown> }): Record<string, unknown> {
  return {
    mode: "manual_local_state",
    canRollbackAutomatically: false,
    procedure: "Inspect SMTP inventory and apply the inverse local status/field change with update_smtp_entry. No automatic inventory backup is created by this mutation.",
    futureSkill: "inspect_smtp_inventory",
    domain: result.domain,
    serverSlug: result.serverSlug,
    previousStatus: result.plan?.previousStatus,
    previousStatuses: result.plan?.previousStatuses,
    previousValues: result.plan?.previousValues
  };
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function requiredPorkbunDomainAdapter(deps: SkillDispatcherDeps): DomainAvailabilityAdapter {
  if (!deps.porkbunDomainAdapter) {
    throw new Error("porkbun_domain_adapter_missing");
  }
  return deps.porkbunDomainAdapter;
}

/**
 * Resuelve el adapter account-aware para el provider/account pedido.
 *
 * PRECEDENCIA (canal HERMANO providerId primero): si providerId esta presente y != "webdock" y
 * vpsProviderAdapters tiene esa key, enruta a ESE proveedor (Contabo, etc.). Si providerId apunta a
 * un proveedor externo desconocido, dispatchSkillHandler falla 422 antes de invocar. En cualquier
 * otro caso (providerId ausente/"webdock") cae a la logica Webdock por accountId
 * EXISTENTE, SIN CAMBIOS:
 * - Invariante single-provider/single-account byte-identico: providerId undefined/"webdock" +
 *   accountId undefined/"ops" => el webdockAdapter de hoy (cuenta-1 "ops"), tal cual.
 * - Solo un accountId distinto presente en el registry write-capable enruta a otra cuenta; cualquier
 *   accountId desconocido cae tambien a la cuenta-1 (defensivo).
 */
function resolveWebdockCreateAdapter(
  deps: SkillDispatcherDeps,
  accountId: string | undefined,
  providerId?: string
): WebdockServerCreateAdapter & Partial<WebdockServerDeleteAdapter> & Partial<BindWebdockMainDomainAdapter> {
  // Normalizar a lowercase: la KEY del registry es lowercase ("contabo"); un providerId capitalizado
  // ("Contabo") debe seguir enrutando. Coincide con normalizeVpsProviderId del orquestador.
  const provider = providerId?.trim().toLowerCase();
  if (provider && provider !== "webdock" && deps.vpsProviderAdapters?.has(provider)) {
    // VpsProvider es asignable estructuralmente a WebdockServerCreateAdapter & Partial<...Delete>.
    return deps.vpsProviderAdapters.get(provider)!;
  }
  const normalized = accountId?.trim();
  if (!normalized || normalized === "ops" || !deps.webdockCreateAdapters) {
    return deps.webdockAdapter;
  }
  return deps.webdockCreateAdapters.get(normalized) ?? deps.webdockAdapter;
}

function unknownExternalVpsProviderId(providerId: string | undefined, adapters?: Map<string, VpsProvider>): string | null {
  const provider = providerId?.trim().toLowerCase();
  if (!provider || provider === "webdock") return null;
  return adapters?.has(provider) ? null : provider;
}

function unknownExternalDnsProviderId(providerId: string | undefined, adapters?: Map<string, DnsProvider>): string | null {
  const provider = providerId?.trim().toLowerCase();
  if (!provider || provider === "route53") return null;
  return adapters?.has(provider) ? null : provider;
}

function contaboBindFcrdnsMaxWaitMs(
  providerId: string | undefined,
  env: Record<string, string | undefined> | undefined
): number | undefined {
  if (providerId?.trim().toLowerCase() !== "contabo") return undefined;
  return boundedEnvMs(
    env?.CONTABO_FCRDNS_MAX_WAIT_MS,
    contaboBindFcrdnsDefaultMaxWaitMs,
    contaboBindFcrdnsMaxWaitCapMs
  );
}

function contaboBindFcrdnsPollIntervalMs(
  providerId: string | undefined,
  env: Record<string, string | undefined> | undefined
): number | undefined {
  if (providerId?.trim().toLowerCase() !== "contabo") return undefined;
  const parsed = Number(env?.CONTABO_FCRDNS_POLL_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(contaboBindFcrdnsMinPollIntervalMs, Math.floor(parsed));
}

function boundedEnvMs(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function contaboBindFcrdnsDeps(
  providerId: string | undefined,
  env: Record<string, string | undefined> | undefined
): { fcrdnsMaxWaitMs?: number; fcrdnsPollIntervalMs?: number } {
  const timing = resolveContaboBindTiming(providerId, env, 120_000);
  const maxWaitMs = timing.fcrdnsMaxWaitMs;
  if (maxWaitMs === undefined) return {};
  return {
    fcrdnsMaxWaitMs: maxWaitMs,
    ...(timing.fcrdnsPollIntervalMs === undefined ? {} : { fcrdnsPollIntervalMs: timing.fcrdnsPollIntervalMs })
  };
}

export function resolveContaboBindTiming(
  providerId: string | undefined,
  env: Record<string, string | undefined> | undefined,
  fallbackMs: number
): { handlerTimeoutMs: number; fcrdnsMaxWaitMs?: number; fcrdnsPollIntervalMs?: number } {
  const maxWaitMs = contaboBindFcrdnsMaxWaitMs(providerId, env);
  if (maxWaitMs === undefined) return { handlerTimeoutMs: fallbackMs };
  const handlerTimeoutMs = Math.min(
    contaboBindHandlerTimeoutCapMs,
    Math.max(fallbackMs, maxWaitMs + contaboBindHandlerTimeoutPaddingMs)
  );
  const pollIntervalMs = contaboBindFcrdnsPollIntervalMs(providerId, env);
  return {
    handlerTimeoutMs,
    fcrdnsMaxWaitMs: maxWaitMs,
    ...(pollIntervalMs === undefined ? {} : { fcrdnsPollIntervalMs: pollIntervalMs })
  };
}

function resolveSkillHandlerTimeoutMs(
  timeoutMs: SkillHandlerTimeoutMs,
  input: SkillHandlerTimeoutInput
): number {
  return typeof timeoutMs === "function" ? timeoutMs(input) : timeoutMs;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new DispatchTimeoutError(timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class DispatchTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Handler timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown dispatcher error";
}
