# Backlog de contratos backend — Hito 5.11

Este documento enumera los endpoints/contratos que el admin panel necesita
para dejar de mostrar valores hardcoded en los slots que Pencil dibuja. Se
deriva del audit hecho en `H.16 Wave 2A` (2026-05-17) y de la spec literal
del `.pen` (`Panel Front End`).

Cada item incluye:
- **Slot UI** que hoy muestra placeholder Pencil.
- **Contrato propuesto** (path + DTO shape resumido).
- **Origen probable** del dato en el dominio existente.
- **Bloqueador**: si depende de instrumentación nueva.

El frontend ya está listo para consumirlos via `READ_ENDPOINTS`. Solo hace
falta exponer el endpoint en `apps/gateway-api/src/main.ts` y, donde sea
necesario, crear el builder en `packages/domain/src`.

---

## 1. IAM · Roles, sesiones y operadores · Pantalla Seguridad

Slots hoy hardcoded:
- Roles card · cuatro filas (Operador 4, SRE 2, Auditor externo 1, Sólo lectura 5).
- Sesiones activas card · tres filas (operador Madrid VPN, sre-01 iad,
  auditor-ext Berlín MFA).
- KPI "Roles del norte" en Seguridad y en Clústeres.

### Endpoint propuesto

`GET /v1/iam/roles`

```ts
{
  roles: Array<{
    id: string;
    name: string;
    color?: string;        // amber/green/violet/neutral
    userCount: number;
    permissions: string[]; // strings simbolicos para mostrar en chips
  }>;
}
```

`GET /v1/iam/sessions`

```ts
{
  sessions: Array<{
    actor: string;
    location: string;
    transport: "vpn" | "internal" | "mfa" | string;
    startedAt: string;
    lastSeenAt: string;
    risk: "low" | "medium" | "high";
  }>;
}
```

Origen probable: stub en `packages/domain/src/iam/` que lea `runtime/iam.json`.
No integración OAuth/SAML todavía — basta con un mock supervisado para Fase 5.

Bloqueador: ninguno técnico. Decisión sobre cuáles roles canonizar (lista
declarada en `NORTE_OPERATIVO_DELIVRIX.md` o en este documento).

---

## 2. Compliance dashboard · Pantalla Seguridad

Slots hoy hardcoded:
- Compliance row · tres cards (Cumplimiento GDPR ok, Cumplimiento operativo
  3 abiertos, Sin acciones reales MVP).
- Footer · "runbook · security-runbook.md".

### Endpoint propuesto

`GET /v1/compliance/status`

```ts
{
  controls: Array<{
    id: string;
    title: string;       // "Cumplimiento GDPR"
    state: "ok" | "warning" | "info";
    lines: string[];     // bullets que se renderean en la card
    runbookRef?: string; // path/markdown que linkea al doc operativo
  }>;
}
```

Origen probable: `packages/domain/src/compliance/` que lea un YAML/JSON con la
matriz `NORTE_OPERATIVO_DELIVRIX.md`.

Bloqueador: requiere consolidar el set de controles en un solo doc operativo.

---

## 3. Hardware audit log por host · Pantalla Hardware

Slots hoy hardcoded:
- AuditFooter · 6 filas con timestamps 2026-05-16 y actores (operador,
  system.collector, openclaw.agent, etc.).

### Endpoint propuesto

Reutilizar `GET /v1/audit-events` pero con filtros server-side por target:

```
GET /v1/audit-events?targetType=physical-host&targetId={hostId}&limit=20
```

Hoy el panel filtra client-side con `filterAuditEvents()` por keywords. El
filtro server-side mejora performance y permite incrementar el límite sin
traer el log entero.

Bloqueador: ninguno; es feature aditivo del endpoint existente.

---

## 4. OpenClaw skills · audit log con sha256 · Pantalla Aprendizaje

Slots hoy hardcoded:
- Audit strip dark · 5 filas con sha256 hashes (`curated_lesson_added`,
  `skill_evaluation_queued`, `feedback_recorded`, `lesson_promoted`,
  `skill_promotion_requested`).
- Evidencia curada · tabla 6 filas (snap-7f2a91c4 DNS drift, etc.).

### Endpoints propuestos

`GET /v1/openclaw/skills/audit`

```ts
{
  events: Array<{
    id: string;             // hash sha256
    occurredAt: string;
    action: string;         // "curated_lesson_added" | "skill_evaluation_queued" | ...
    actor: string;          // "operador" | "openclaw-eval" | "openclaw-auto"
    body: string;           // descripción humana
    skillId?: string;
    lessonId?: string;
  }>;
}
```

`GET /v1/openclaw/evidence`

```ts
{
  curated: Array<{
    snapshotId: string;     // "snap-7f2a91c4"
    type: string;           // "DNS drift" | "Promo skill" | "Evidencia humana"
    description: string;
    actor: string;
    capturedAt: string;
    mode: "get-only" | string;
    impact: "alto" | "medio" | "bajo";
  }>;
}
```

Origen probable: extender `OpenClaw` runbook para que persista evidencia y
audit. Builder `buildOpenClawSkillsAudit()` en `packages/domain/src/openclaw/`.

Bloqueador: requiere que OpenClaw genere los hashes al promover lessons.

---

## 5. OpenClaw onboarding · campos detallados de red · Pantalla Onboarding

Slots hoy hardcoded:
- SectionCard "Interfaces de red" · 4 field rows (eth0/eth1/IPMI/dominio
  público) que el contrato `onboardingState.knownInputs` no expone hoy.

### Cambio propuesto

Extender `onboardingState.knownInputs` para incluir entradas tipadas:

```ts
knownInputs: {
  hostname?: string;
  datacenter?: string;
  role?: string;
  environment?: string;
  interface_primary?: string;   // "bond0 · ENVÍO 10.42.7.21/24 · vlan 102"
  interface_management?: string;
  interface_ipmi?: string;
  public_domain?: string;
  ...
}
```

Bloqueador: definir esquema canónico junto con el operador. Hoy `knownInputs`
está tipado como `Record<string, unknown>` y el frontend ya está preparado
para leerlo con fallback `"—"`.

---

## 6. Sender nodes detallados · Pantalla Clústeres

Slots hoy hardcoded:
- Tabla cluster · columnas REP (94.2, 96.7…) y ENVIADOS (480/600k…) que no
  vienen de `data.clusters.clusters` actual.
- DetailPanel · plan warming (Día 9, Día 10, Día 14) sin contrato.

### Endpoints propuestos

Reutilizar los GET existentes que el panel aún no consume:

- `GET /v1/sender-nodes` → detalle por nodo, status, ipPool, dominio.
- `GET /v1/ip-reputation/reports` → score 94.2/96.7 por IP/clúster.
- `GET /v1/send-results` → counts enviados por cluster.
- `GET /v1/sender-node-health` → health summary por nodo.

Estos endpoints ya existen en `apps/gateway-api/src/main.ts`. Solo hace falta
agregarlos a `READ_ENDPOINTS` del panel y cablearlos.

Bloqueador: ninguno; trabajo está en frontend (próxima ronda Wave 2B).

---

## 7. Operational summary · Overview KPI deltas

Slots hoy hardcoded:
- KPI K1 "Nodos de envío" delta "+6 esta semana" → no hay endpoint que
  exponga delta semanal.
- KPI K2 "IPs en calentamiento" subtitle "día 9 / 28 prom" → no hay endpoint
  que dé el día del ciclo de warming por IP.

### Endpoint propuesto

`GET /v1/operational-summary` (ya existe pero el panel no lo consume) o
extender con:

```ts
{
  summary: {
    senderNodes: { total: number; weeklyDelta: number };
    warming: { activeIps: number; avgDayInCycle: number };
    reputation: { current: number; delta24h: number };
    ...
  };
}
```

Bloqueador: revisar `buildOperationalSummary` para incluir el delta semanal.

---

## 8. Suppression list / opt-out · Compliance · pendiente Fase 5

Slots: ninguno visual hoy. Pero el panel debe exponer una sección de
suppression entries antes de operar correo real (Mes 2+).

`GET /v1/suppression-entries` ya existe; pantalla nueva por crear.

---

## Resumen de prioridad

| Prioridad | Item | Razón |
|---|---|---|
| Alta | 6. Sender nodes detallados | El backend ya expone; solo cablear frontend (Wave 2B). |
| Alta | 7. Operational summary | El backend ya expone; solo cablear frontend (Wave 2B). |
| Alta | 5. Onboarding knownInputs | Cambio chico en domain; permite eliminar 4 placeholders. |
| Media | 1. IAM mock | Mock supervisado en domain; sin OAuth todavía. |
| Media | 2. Compliance status | Necesita consolidación de matriz operativa. |
| Media | 3. Hardware audit filter | Aditivo sobre endpoint existente. |
| Baja | 4. OpenClaw skills audit | Requiere logging adicional en OpenClaw runbook. |
| Baja | 8. Suppression list panel | Para Mes 2+ cuando se opere correo real. |

Cuando se aterricen los items de prioridad alta, el panel deja de mostrar
hardcoded en casi todos los slots visibles.

Documento operativo: `HITO_5_10_FRONTEND_UX_CLAUDE.md` (cierre Fase 5.10),
luego `HITO_5_11_*` (cierre del cableo backend).
