/**
 * WorkspaceBrowser — Pieza 4 del sprint demo viernes (Bloque 10 Acto 2).
 *
 * Vista del workspace persistente de OpenClaw (/data/.openclaw/workspace/)
 * Muestra el árbol de carpetas (skills, executions, learnings, inventory)
 * con click-to-expand y preview de archivos seleccionados.
 *
 * Esto es lo que el operador abre en el Acto 2 de la demo para mostrar que
 * el agente RECUERDA: cada ejecución dejó rastro, cada falla generó lesson,
 * el inventory tiene el estado actual del mundo según OpenClaw.
 *
 * Endpoints backend (Codex Bloque 10 follow-up):
 *   GET /v1/openclaw/workspace/tree?path=<dir>
 *   GET /v1/openclaw/workspace/file?path=<file>
 *
 * Mientras Codex no los exponga, este componente usa dataset demo con shape
 * realista para que la demo del viernes funcione visualmente. Cuando los
 * endpoints estén live, el fallback se descarta automáticamente.
 */

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, File, FileText, Folder, FolderOpen, Sparkles } from "lucide-react";

/* ============================================================
 * Tipos del contrato
 * ============================================================ */

export type WorkspaceNodeKind = "directory" | "file";

export interface WorkspaceNode {
  name: string;
  path: string;
  kind: WorkspaceNodeKind;
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

export interface WorkspaceTreeResponse {
  path: string;
  nodes: WorkspaceNode[];
  source: { kind: "live" | "mock"; trusted: boolean };
}

export interface WorkspaceFileResponse {
  path: string;
  content: string;
  mimeType: string;
  size: number;
  source: { kind: "live" | "mock"; trusted: boolean };
}

/* ============================================================
 * Dataset demo (fallback hasta que Codex exponga endpoints)
 * ============================================================ */

const DEMO_TREE: Record<string, WorkspaceNode[]> = {
  "/": [
    { name: "executions", path: "/executions", kind: "directory", modifiedAt: new Date().toISOString() },
    { name: "learnings", path: "/learnings", kind: "directory", modifiedAt: new Date(Date.now() - 86400000).toISOString() },
    { name: "skills", path: "/skills", kind: "directory", modifiedAt: new Date(Date.now() - 86400000 * 2).toISOString() },
    { name: "inventory", path: "/inventory", kind: "directory", modifiedAt: new Date(Date.now() - 3600000).toISOString() }
  ],
  "/executions": [
    { name: "2026-05-29", path: "/executions/2026-05-29", kind: "directory", modifiedAt: new Date().toISOString() },
    { name: "2026-05-28", path: "/executions/2026-05-28", kind: "directory", modifiedAt: new Date(Date.now() - 86400000).toISOString() }
  ],
  "/executions/2026-05-29": [
    {
      name: "1100-register_domain_route53-delivrix-mail.com-success.md",
      path: "/executions/2026-05-29/1100-register_domain_route53-delivrix-mail.com-success.md",
      kind: "file",
      size: 412,
      mimeType: "text/markdown",
      modifiedAt: new Date().toISOString()
    },
    {
      name: "1102-provision_webdock_vps-mail-delivrix-1-success.md",
      path: "/executions/2026-05-29/1102-provision_webdock_vps-mail-delivrix-1-success.md",
      kind: "file",
      size: 658,
      mimeType: "text/markdown",
      modifiedAt: new Date().toISOString()
    },
    {
      name: "1104-configure_email_auth-delivrix-mail.com-success.md",
      path: "/executions/2026-05-29/1104-configure_email_auth-delivrix-mail.com-success.md",
      kind: "file",
      size: 892,
      mimeType: "text/markdown",
      modifiedAt: new Date().toISOString()
    },
    {
      name: "1108-install_smtp_stack-mail-delivrix-1-success.md",
      path: "/executions/2026-05-29/1108-install_smtp_stack-mail-delivrix-1-success.md",
      kind: "file",
      size: 1240,
      mimeType: "text/markdown",
      modifiedAt: new Date().toISOString()
    }
  ],
  "/learnings": [
    {
      name: "2026-05-27-webdock-port-25-blocked.md",
      path: "/learnings/2026-05-27-webdock-port-25-blocked.md",
      kind: "file",
      size: 540,
      mimeType: "text/markdown",
      modifiedAt: new Date(Date.now() - 86400000).toISOString()
    },
    {
      name: "auto-2026-05-27-install_smtp_stack-libsasl2-missing.md",
      path: "/learnings/auto-2026-05-27-install_smtp_stack-libsasl2-missing.md",
      kind: "file",
      size: 320,
      mimeType: "text/markdown",
      modifiedAt: new Date(Date.now() - 86400000).toISOString()
    }
  ],
  "/skills": [
    {
      name: "register_domain_route53.v1.md",
      path: "/skills/register_domain_route53.v1.md",
      kind: "file",
      size: 412,
      mimeType: "text/markdown"
    },
    {
      name: "provision_webdock_vps.v1.md",
      path: "/skills/provision_webdock_vps.v1.md",
      kind: "file",
      size: 380,
      mimeType: "text/markdown"
    },
    {
      name: "install_smtp_stack.v1.md",
      path: "/skills/install_smtp_stack.v1.md",
      kind: "file",
      size: 610,
      mimeType: "text/markdown"
    }
  ],
  "/inventory": [
    { name: "domains.json", path: "/inventory/domains.json", kind: "file", size: 1842, mimeType: "application/json" },
    { name: "servers.json", path: "/inventory/servers.json", kind: "file", size: 940, mimeType: "application/json" },
    {
      name: "warmup-progress.json",
      path: "/inventory/warmup-progress.json",
      kind: "file",
      size: 524,
      mimeType: "application/json"
    }
  ]
};

const DEMO_FILES: Record<string, string> = {
  "/executions/2026-05-29/1100-register_domain_route53-delivrix-mail.com-success.md":
    "# register_domain_route53 · delivrix-mail.com · SUCCESS\n\n**Skill:** register_domain_route53.v1\n**Args:** { domain: \"delivrix-mail.com\", years: 1, autoRenew: true }\n**Resultado:** registrationOk · operationId=op-aws-12345 · costo=$11.00 USD\n**Duración:** 8.4s\n**Pre-flight learnings aplicados:** ninguno\n\n## Evidencia\n- AWS operationId: op-aws-12345\n- Expiry: 2027-05-29\n- AdminContact: encrypted-ref://delivrix-admin-2026\n- Audit chain hash: 7f9c2a1e...\n",
  "/executions/2026-05-29/1102-provision_webdock_vps-mail-delivrix-1-success.md":
    "# provision_webdock_vps · mail-delivrix-1 · SUCCESS\n\n**Skill:** provision_webdock_vps.v1\n**Args:** { profile: \"bit\", location: \"fi\", hostname: \"mail-delivrix-1\", image: \"ubuntu-2404\" }\n**Resultado:** serverSlug=webdock-vps-87421 · ipv4=185.232.x.x · estado=running\n**Duración:** 94s (polling 5s × 19 ciclos hasta status:finished)\n**Pre-flight learnings aplicados:** [webdock-port-25-blocked.md] → ticket port 25 abierto al inicio\n\n## Evidencia\n- Webdock event_id: evt-67890\n- Costo mensual: $5.40 USD\n- SSH key: encrypted-ref://delivrix-ops-2026\n- Audit chain hash: 4e8b1f3c...\n",
  "/learnings/2026-05-27-webdock-port-25-blocked.md":
    "# Webdock bloquea port 25 por defecto en cuentas nuevas\n\n**Fecha:** 2026-05-27\n**Skill afectada:** install_smtp_stack\n**Severidad:** alta · bloqueante para SMTP\n\n## Root cause\nWebdock por política anti-spam bloquea el port 25 outbound en todas las cuentas nuevas hasta que el operador abra un ticket pidiendo desbloqueo. El ticket toma 24-48h de respuesta humana.\n\n## Fix preventivo\nAntes de invocar install_smtp_stack en un VPS Webdock, abrir ticket de desbloqueo port 25 al momento de provisionar el VPS (no al final). Así para cuando install_smtp_stack corra, el port está listo.\n\n## Aplicabilidad\nTodos los provision_webdock_vps en cuentas con menos de 30 días o sin historial de SMTP.\n\n## Validado en\nDemo viernes 29-may-2026 — aplicado preventivamente, instalación SMTP exitosa al primer intento.",
  "/learnings/auto-2026-05-27-install_smtp_stack-libsasl2-missing.md":
    "# install_smtp_stack falla en Ubuntu 24.04 sin libsasl2-modules\n\n**Generada automáticamente:** 2026-05-27 14:23:18 UTC\n**Skill:** install_smtp_stack.v1\n**Error original:** `postfix: warning: SASL authentication failure: cannot connect to saslauthd server`\n\n## Root cause\nUbuntu 24.04 minimal image no incluye libsasl2-modules. Postfix se instala pero la autenticación SASL falla en el primer envío de email.\n\n## Fix sugerido\nAgregar `libsasl2-modules` al apt-get install de install_smtp_stack:\n\n```bash\napt-get install -y postfix opendkim opendkim-tools certbot libsasl2-modules\n```\n\n## Aplicado a\nskill install_smtp_stack.v2 (pendiente revisión).",
  "/inventory/domains.json":
    "{\n  \"generatedAt\": \"2026-05-29T11:08:42Z\",\n  \"domains\": [\n    {\n      \"domain\": \"delivrix-mail.com\",\n      \"registrar\": \"route53\",\n      \"registeredAt\": \"2026-05-29T11:00:12Z\",\n      \"expiresAt\": \"2027-05-29\",\n      \"dnsZoneId\": \"Z123ABC\",\n      \"serverIp\": \"185.232.x.x\",\n      \"warmupStatus\": \"day-1\",\n      \"emailAuth\": { \"spf\": true, \"dkim\": true, \"dmarc\": true }\n    },\n    {\n      \"domain\": \"annualcorpfilings.com\",\n      \"registrar\": \"ionos\",\n      \"registeredAt\": \"2025-11-12T08:00:00Z\",\n      \"warmupStatus\": \"active\",\n      \"emailAuth\": { \"spf\": true, \"dkim\": true, \"dmarc\": true }\n    }\n  ],\n  \"total\": 17\n}",
  "/inventory/servers.json":
    "{\n  \"generatedAt\": \"2026-05-29T11:08:42Z\",\n  \"servers\": [\n    {\n      \"slug\": \"webdock-vps-87421\",\n      \"hostname\": \"mail-delivrix-1\",\n      \"ipv4\": \"185.232.x.x\",\n      \"provider\": \"webdock\",\n      \"profile\": \"bit\",\n      \"location\": \"fi\",\n      \"smtpReady\": true,\n      \"port25Status\": \"unblocked\",\n      \"bindedDomains\": [\"delivrix-mail.com\"]\n    }\n  ],\n  \"total\": 1\n}",
  "/skills/register_domain_route53.v1.md":
    "# Skill: register_domain_route53\n\n**Version:** v1\n**Adapter:** packages/adapters/src/aws-route53-domains-adapter.ts\n\n## Args\n- domain: string (FQDN sin trailing dot)\n- years: 1 | 2 | 3 | 5\n- autoRenew: boolean (default true)\n\n## Pre-conditions\n- AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true\n- DELIVRIX_ADMIN_CONTACT_JSON presente\n- Cap mensual no excedido\n- Audit artifact approvado por operador\n\n## Outputs\n- operationId: AWS op ID para tracking\n- expectedExpiry: ISO date\n- costUsd: float\n\n## Audit events\n- oc.domain.register_blocked (si pre-conditions fallan)\n- oc.domain.registered (success)\n"
};

/* ============================================================
 * Hooks
 * ============================================================ */

const STALE_MS = 30_000;

function useWorkspaceTree(path: string) {
  return useQuery({
    queryKey: ["workspace", "tree", path],
    queryFn: async (): Promise<WorkspaceTreeResponse> => {
      try {
        const res = await fetch(`/v1/openclaw/workspace/tree?path=${encodeURIComponent(path)}`, {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store"
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as WorkspaceTreeResponse;
      } catch {
        // Fallback a dataset demo mientras Codex expone el endpoint
        return {
          path,
          nodes: DEMO_TREE[path] ?? [],
          source: { kind: "mock", trusted: false }
        };
      }
    },
    staleTime: STALE_MS,
    retry: false
  });
}

function useWorkspaceFile(path: string | null) {
  return useQuery({
    queryKey: ["workspace", "file", path],
    queryFn: async (): Promise<WorkspaceFileResponse> => {
      if (!path) throw new Error("no path");
      try {
        const res = await fetch(`/v1/openclaw/workspace/file?path=${encodeURIComponent(path)}`, {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store"
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as WorkspaceFileResponse;
      } catch {
        const content = DEMO_FILES[path] ?? "(archivo no disponible en demo dataset · esperando endpoint Codex)";
        return {
          path,
          content,
          mimeType: path.endsWith(".json") ? "application/json" : "text/markdown",
          size: content.length,
          source: { kind: "mock", trusted: false }
        };
      }
    },
    enabled: path != null,
    staleTime: STALE_MS,
    retry: false
  });
}

/* ============================================================
 * <WorkspaceBrowser> — root
 * ============================================================ */

export function WorkspaceBrowser() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["/", "/executions", "/executions/2026-05-29"]));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const fileQuery = useWorkspaceFile(selectedPath);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  return (
    <div className="flex flex-col" style={{ flex: 1, minHeight: 0 }}>
      <WorkspaceHeader selectedPath={selectedPath} onClearSelection={() => setSelectedPath(null)} />
      <div className="flex flex-1 min-h-0">
        <div
          className="flex flex-col overflow-y-auto"
          style={{
            width: selectedPath ? "40%" : "100%",
            minWidth: 200,
            borderRight: selectedPath ? "1px solid var(--color-border)" : "none",
            padding: "8px 4px",
            transition: "width 200ms ease"
          }}
        >
          <WorkspaceTreeNode
            path="/"
            level={0}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggleExpand={toggleExpanded}
            onSelectFile={handleSelectFile}
          />
        </div>
        {selectedPath ? (
          <div className="flex flex-col" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <WorkspaceFilePreview fileQuery={fileQuery} path={selectedPath} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceHeader({
  selectedPath,
  onClearSelection
}: {
  selectedPath: string | null;
  onClearSelection: () => void;
}) {
  return (
    <div
      className="flex items-center"
      style={{
        padding: "10px 14px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)",
        gap: 8
      }}
    >
      <Sparkles size={12} strokeWidth={1.75} style={{ color: "var(--color-accent-tertiary)" }} />
      <span
        className="font-[family-name:var(--font-caption)] font-semibold uppercase"
        style={{ fontSize: 10, letterSpacing: "0.6px", color: "var(--color-text-tertiary)" }}
      >
        Workspace OpenClaw
      </span>
      <span
        className="font-[family-name:var(--font-mono)]"
        style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
      >
        /data/.openclaw/workspace
      </span>
      {selectedPath ? (
        <>
          <span style={{ flex: 1 }} aria-hidden="true" />
          <button
            type="button"
            onClick={onClearSelection}
            className="font-[family-name:var(--font-mono)] hover:text-[var(--color-text-primary)]"
            style={{
              fontSize: 10,
              color: "var(--color-text-tertiary)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "2px 6px"
            }}
          >
            cerrar preview
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Tree recursive renderer
 * ============================================================ */

function WorkspaceTreeNode({
  path,
  level,
  expanded,
  selectedPath,
  onToggleExpand,
  onSelectFile
}: {
  path: string;
  level: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleExpand: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isExpanded = expanded.has(path);
  const tree = useWorkspaceTree(isExpanded ? path : "");

  return (
    <div className="flex flex-col">
      {tree.isLoading && isExpanded ? (
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)", padding: "4px 12px", paddingLeft: 12 + level * 14 }}
        >
          cargando…
        </span>
      ) : null}
      {(tree.data?.nodes ?? []).map((node) => {
        const isExp = expanded.has(node.path);
        const isSel = selectedPath === node.path;
        return (
          <div key={node.path} className="flex flex-col">
            <button
              type="button"
              onClick={() => {
                if (node.kind === "directory") onToggleExpand(node.path);
                else onSelectFile(node.path);
              }}
              className="flex items-center transition-colors"
              style={{
                gap: 6,
                padding: "4px 10px",
                paddingLeft: 10 + level * 14,
                background: isSel ? "var(--color-surface-sunken)" : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                width: "100%"
              }}
            >
              {node.kind === "directory" ? (
                <>
                  {isExp ? (
                    <ChevronDown size={11} strokeWidth={2} style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }} />
                  ) : (
                    <ChevronRight size={11} strokeWidth={2} style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }} />
                  )}
                  {isExp ? (
                    <FolderOpen size={12} strokeWidth={1.75} style={{ color: "var(--color-accent-tertiary)", flexShrink: 0 }} />
                  ) : (
                    <Folder size={12} strokeWidth={1.75} style={{ color: "var(--color-text-secondary)", flexShrink: 0 }} />
                  )}
                </>
              ) : (
                <>
                  <span style={{ width: 11, flexShrink: 0 }} aria-hidden="true" />
                  {node.mimeType === "application/json" ? (
                    <File size={12} strokeWidth={1.75} style={{ color: "var(--color-info)", flexShrink: 0 }} />
                  ) : (
                    <FileText size={12} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }} />
                  )}
                </>
              )}
              <span
                className="font-[family-name:var(--font-mono)] truncate"
                style={{
                  fontSize: 11.5,
                  color: isSel ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                  fontWeight: isSel ? 500 : 400,
                  flex: 1,
                  minWidth: 0
                }}
              >
                {node.name}
              </span>
              {node.kind === "file" && node.size != null ? (
                <span
                  className="font-[family-name:var(--font-mono)]"
                  style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}
                >
                  {formatSize(node.size)}
                </span>
              ) : null}
            </button>
            {node.kind === "directory" && isExp ? (
              <WorkspaceTreeNode
                path={node.path}
                level={level + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggleExpand={onToggleExpand}
                onSelectFile={onSelectFile}
              />
            ) : null}
          </div>
        );
      })}
      {!tree.isLoading && (tree.data?.nodes ?? []).length === 0 && isExpanded ? (
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)", padding: "4px 12px", paddingLeft: 12 + level * 14, fontStyle: "italic" }}
        >
          (carpeta vacía)
        </span>
      ) : null}
    </div>
  );
}

/* ============================================================
 * File preview
 * ============================================================ */

function WorkspaceFilePreview({
  fileQuery,
  path
}: {
  fileQuery: ReturnType<typeof useWorkspaceFile>;
  path: string;
}) {
  if (fileQuery.isLoading) {
    return (
      <div style={{ padding: 18, color: "var(--color-text-tertiary)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
        Cargando contenido…
      </div>
    );
  }
  if (fileQuery.isError || !fileQuery.data) {
    return (
      <div style={{ padding: 18, color: "var(--color-warning)", fontSize: 12 }}>
        No se pudo cargar el archivo.
      </div>
    );
  }
  const file = fileQuery.data;
  const isJson = file.mimeType === "application/json";
  let displayContent = file.content;
  if (isJson) {
    try {
      displayContent = JSON.stringify(JSON.parse(file.content), null, 2);
    } catch {
      // dejar como está
    }
  }
  return (
    <div className="flex flex-col" style={{ flex: 1, minHeight: 0 }}>
      <div
        className="flex items-center"
        style={{
          padding: "8px 14px",
          background: "var(--color-surface-sunken)",
          borderBottom: "1px solid var(--color-border)",
          gap: 8
        }}
      >
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-primary)", fontWeight: 500 }}
        >
          {basename(file.path)}
        </span>
        <span style={{ flex: 1 }} aria-hidden="true" />
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {formatSize(file.size)} · {file.mimeType}
        </span>
        {file.source?.kind === "mock" ? (
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{
              fontSize: 9,
              padding: "1px 6px",
              borderRadius: 999,
              background: "var(--color-warning-soft)",
              color: "var(--color-warning)",
              fontWeight: 500
            }}
            title="Dataset demo — endpoint backend aún no expuesto"
          >
            mock
          </span>
        ) : null}
      </div>
      <pre
        className="font-[family-name:var(--font-mono)]"
        style={{
          fontSize: 11.5,
          lineHeight: 1.55,
          color: "var(--color-text-primary)",
          background: "var(--color-bg)",
          padding: "14px 16px",
          margin: 0,
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word"
        }}
      >
        {displayContent}
      </pre>
    </div>
  );
}

/* ============================================================
 * Helpers
 * ============================================================ */

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
