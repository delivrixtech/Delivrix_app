import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNodeOwnershipCommand,
  parseNodeOwnership,
  reconcileNodeIp,
  verifyNodeOwnership,
  type NodeOwnershipSshRunner
} from "./smtp-node-ownership.ts";

const domain = "corpfiling-ops.com";

function stdout(input: {
  hostname?: string;
  mailname?: string;
  dkim?: "present" | "absent" | "none";
  truncated?: boolean;
}): string {
  const lines = [
    "## HOSTNAME",
    input.hostname ?? "__POSTCONF_UNAVAILABLE__",
    "## MAILNAME",
    input.mailname ?? "__NO_MAILNAME__",
    "## DKIM",
    input.dkim === "present" ? "__DKIM_PRESENT__" : input.dkim === "absent" ? "__DKIM_ABSENT__" : ""
  ];
  if (!input.truncated) lines.push("## END");
  return `${lines.join("\n")}\n`;
}

test("buildNodeOwnershipCommand: siempre sale 0 y marca el fin de la salida", () => {
  const command = buildNodeOwnershipCommand(domain);
  assert.match(command, /smtp\.corpfiling-ops\.com|myhostname/);
  assert.match(command, /\/etc\/opendkim\/keys\/corpfiling-ops\.com/);
  assert.match(command, /## END/);
  // Sin `set -e`: un postconf ausente no puede tumbar el probe y disfrazarse de "no es tuyo".
  assert.equal(/set -e/.test(command), false);
  assert.match(command, /\|\| echo '__POSTCONF_UNAVAILABLE__'/);
  // El dominio va quoteado, no interpolado crudo.
  assert.match(command, /\[ -d '\/etc\/opendkim\/keys\/corpfiling-ops\.com' \]/);
});

test("buildNodeOwnershipCommand: rechaza un dominio inválido", () => {
  assert.throws(() => buildNodeOwnershipCommand("no-es-un-dominio; rm -rf /"), /invalid domain/);
});

test("parseNodeOwnership: hostname correcto + DKIM presente ⇒ owned", () => {
  const verdict = parseNodeOwnership(stdout({ hostname: `smtp.${domain}`, dkim: "present" }), domain);
  assert.equal(verdict.status, "owned");
  assert.equal(verdict.hostname, `smtp.${domain}`);
  assert.equal(verdict.dkimKeysPresent, true);
});

test("parseNodeOwnership: hostname de otro dominio ⇒ not_owned", () => {
  const verdict = parseNodeOwnership(stdout({ hostname: "smtp.otracosa.com", dkim: "present" }), domain);
  assert.equal(verdict.status, "not_owned");
  assert.match(verdict.detail, /se declara smtp\.otracosa\.com/);
});

test("parseNodeOwnership: hostname correcto pero sin claves DKIM ⇒ not_owned", () => {
  const verdict = parseNodeOwnership(stdout({ hostname: `smtp.${domain}`, dkim: "absent" }), domain);
  assert.equal(verdict.status, "not_owned");
  assert.equal(verdict.dkimKeysPresent, false);
});

test("parseNodeOwnership: sin postconf pero con /etc/mailname correcto ⇒ owned", () => {
  const verdict = parseNodeOwnership(stdout({ mailname: `smtp.${domain}`, dkim: "present" }), domain);
  assert.equal(verdict.status, "owned");
  assert.equal(verdict.hostname, null);
  assert.equal(verdict.mailname, `smtp.${domain}`);
});

test("parseNodeOwnership: salida truncada ⇒ undetermined, nunca not_owned", () => {
  const verdict = parseNodeOwnership(stdout({ hostname: "smtp.otracosa.com", dkim: "absent", truncated: true }), domain);
  assert.equal(verdict.status, "undetermined");
});

test("parseNodeOwnership: sin señal de hostname ni mailname ⇒ undetermined", () => {
  const verdict = parseNodeOwnership(stdout({ dkim: "present" }), domain);
  assert.equal(verdict.status, "undetermined");
});

test("parseNodeOwnership: DKIM indeterminado ⇒ undetermined", () => {
  const verdict = parseNodeOwnership(stdout({ hostname: `smtp.${domain}`, dkim: "none" }), domain);
  assert.equal(verdict.status, "undetermined");
});

// La regresión exacta del bug: el script viejo leía este error como "no es tuyo" y
// descartó 14 nodos vivos.
test("verifyNodeOwnership: Permission denied ⇒ undetermined con pista, NO not_owned", async () => {
  const sshRunner: NodeOwnershipSshRunner = {
    run: async () => {
      throw new Error("SSH command failed with exit 255.\nPermission denied (publickey).");
    }
  };
  const verdict = await verifyNodeOwnership({ sshRunner, domain, serverSlug: "server60", serverIp: "10.0.0.1" });
  assert.equal(verdict.status, "undetermined");
  assert.match(verdict.detail, /ownership_probe_failed/);
  assert.match(verdict.hint ?? "", /SMTP_PROVISION_SSH_USER/);
});

test("verifyNodeOwnership: timeout ⇒ undetermined con pista", async () => {
  const sshRunner: NodeOwnershipSshRunner = {
    run: async () => {
      throw new Error("SSH command timed out.");
    }
  };
  const verdict = await verifyNodeOwnership({ sshRunner, domain, serverSlug: "server60", serverIp: "10.0.0.1" });
  assert.equal(verdict.status, "undetermined");
  assert.match(verdict.hint ?? "", /apagado o filtrado/);
});

// El serverSlug es lo que hace que el runner elija root (Contabo) vs delivrixops+sudo
// (Webdock). Si no viaja, vuelve el bug.
test("verifyNodeOwnership: propaga serverSlug al runner", async () => {
  const seen: Array<{ serverSlug?: string | null; serverIp: string }> = [];
  const sshRunner: NodeOwnershipSshRunner = {
    run: async (input) => {
      seen.push({ serverSlug: input.serverSlug, serverIp: input.serverIp });
      return { stdout: stdout({ hostname: `smtp.${domain}`, dkim: "present" }), exitCode: 0 };
    }
  };
  const verdict = await verifyNodeOwnership({ sshRunner, domain, serverSlug: "server60", serverIp: "10.0.0.1" });
  assert.equal(verdict.status, "owned");
  assert.deepEqual(seen, [{ serverSlug: "server60", serverIp: "10.0.0.1" }]);
});

test("reconcileNodeIp: DNS coincide con el inventario ⇒ match", async () => {
  const result = await reconcileNodeIp({
    domain,
    inventoryIp: "10.0.0.1",
    resolve4: async () => ["10.0.0.1"]
  });
  assert.equal(result.status, "match");
});

test("reconcileNodeIp: DNS apunta a otra IP ⇒ mismatch (caso controlcorpfiling.com)", async () => {
  const result = await reconcileNodeIp({
    domain,
    inventoryIp: "193.180.211.182",
    resolve4: async () => ["45.136.70.174"]
  });
  assert.equal(result.status, "mismatch");
  assert.equal(result.dnsIp, "45.136.70.174");
});

test("reconcileNodeIp: DNS que falla no bloquea ⇒ dns_unresolved", async () => {
  const result = await reconcileNodeIp({
    domain,
    inventoryIp: "10.0.0.1",
    resolve4: async () => {
      throw new Error("queryA ENOTFOUND");
    }
  });
  assert.equal(result.status, "dns_unresolved");
  assert.deepEqual(result.dnsIps, []);
});
