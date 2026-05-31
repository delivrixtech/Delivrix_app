import type { KillSwitchOperation } from "../../../packages/domain/src/index.ts";

export interface LiveActionMutation {
  method: string;
  path: string;
  operation: KillSwitchOperation;
  targetType: string;
  targetId: string;
}

export function classifyLiveActionMutation(method: string | undefined, path: string): LiveActionMutation | null {
  const normalizedMethod = (method ?? "").toUpperCase();

  if (normalizedMethod === "POST" && path === "/v1/domains/route53/register") {
    return liveAction(normalizedMethod, path, "domain", "route53-register");
  }
  if (normalizedMethod === "POST" && path === "/v1/domains/route53/dns/upsert") {
    return liveAction(normalizedMethod, path, "domain", "route53-dns-upsert");
  }
  if (normalizedMethod === "DELETE" && /^\/v1\/domains\/route53\/hosted-zones\/[^/]+$/.test(path)) {
    return liveAction(normalizedMethod, path, "route53_hosted_zone", path.split("/").at(-1) ?? "unknown");
  }
  if (normalizedMethod === "POST" && path === "/v1/domains/auth/configure") {
    return liveAction(normalizedMethod, path, "domain", "email-auth-configure");
  }
  if (normalizedMethod === "POST" && path === "/v1/domains/bind") {
    return liveAction(normalizedMethod, path, "domain", "domain-bind");
  }
  if (normalizedMethod === "POST" && path === "/v1/dns/ionos/upsert") {
    return liveAction(normalizedMethod, path, "domain", "ionos-dns-upsert");
  }
  if (normalizedMethod === "POST" && path === "/v1/webdock/servers/create") {
    return liveAction(normalizedMethod, path, "webdock_server", "webdock-create");
  }
  if (normalizedMethod === "POST" && path === "/v1/skills/bind-webdock-main-domain") {
    return liveAction(normalizedMethod, path, "webdock_server", "bind-webdock-main-domain");
  }
  if (normalizedMethod === "DELETE" && /^\/v1\/webdock\/servers\/[^/]+$/.test(path)) {
    return liveAction(normalizedMethod, path, "webdock_server", decodeURIComponent(path.split("/").at(-1) ?? "unknown"));
  }
  if (normalizedMethod === "POST" && /^\/v1\/servers\/[^/]+\/provision-smtp$/.test(path)) {
    return liveAction(normalizedMethod, path, "webdock_server", decodeURIComponent(path.split("/")[3] ?? "unknown"));
  }
  if (normalizedMethod === "POST" && (path === "/v1/warmup/start" || path === "/v1/warmup/seed")) {
    return liveAction(normalizedMethod, path, "domain", "warmup-seed");
  }
  if (normalizedMethod === "POST" && path === "/v1/warmup/ramp/start") {
    return liveAction(normalizedMethod, path, "domain", "warmup-ramp-start");
  }
  if (normalizedMethod === "POST" && /^\/v1\/warmup\/ramp\/ramp-[A-Za-z0-9-]+\/resume$/.test(path)) {
    return liveAction(normalizedMethod, path, "warmup_ramp", decodeURIComponent(path.split("/")[4] ?? "unknown"));
  }
  if (normalizedMethod === "POST" && (path === "/v1/flows/onboard-sender-domain" || path === "/v1/flows/onboard-batch")) {
    return liveAction(normalizedMethod, path, "onboard_flow", path.split("/").at(-1) ?? "unknown");
  }

  return null;
}

function liveAction(
  method: string,
  path: string,
  targetType: string,
  targetId: string
): LiveActionMutation {
  return {
    method,
    path,
    operation: "apply_live_infrastructure_action",
    targetType,
    targetId
  };
}
