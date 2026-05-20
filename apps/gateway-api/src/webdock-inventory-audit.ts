import type { IncomingHttpHeaders } from "node:http";

const webdockInventorySkillInvocationHeader = "x-openclaw-skill-invocation";
const auditedSkillInvocations = new Set(["fleet-ops", "delivrix-fleet-ops"]);

export function shouldAuditWebdockInventoryPoll(headers: IncomingHttpHeaders): boolean {
  const rawHeader = headers[webdockInventorySkillInvocationHeader];
  const skillInvocation = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return typeof skillInvocation === "string" && auditedSkillInvocations.has(skillInvocation);
}
