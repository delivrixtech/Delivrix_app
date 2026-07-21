# Plan — Delivrix como tenant de super-administradores (Auth + RBAC + Perfil)

> 2026-07-14 · Estado: **propuesta para aprobación**. Nada implementado aún.
> Contexto: Delivrix es una **fábrica** interna. Solo entran jefes y desarrolladores con rol.
> Hoy el panel NO tiene autenticación (acceso local abierto) y el avatar/campana eran placeholders.
> Este plan construye el módulo faltante con la versión/diseño nuevo (molde Aivora en `shared/ui/aivora`).

---

## 0. Principios (no negociables)

1. **Deny-by-default**: sin sesión válida no se ve NADA. Sin permiso, la sección/acción no existe en la UI y el Gateway la rechaza (defensa en profundidad: front oculta, back valida).
2. **Auditoría primero**: toda acción administrativa (crear usuario, cambiar rol, revocar sesión, tocar kill switch) entra a la audit chain existente, firmada, append-only.
3. **Least privilege**: los roles dan lo mínimo. El super-admin es el único que gestiona usuarios/roles.
4. **El back manda**: el front filtra por UX, pero el Gateway re-verifica permiso en cada endpoint. Nunca confiar en el cliente.
5. **Reversible**: revocar sesión / bajar rol / desactivar usuario es inmediato y auditado.

---

## 1. Roles y matriz de permisos

Se reusa la semántica de roles del **norte operativo** que ya existe (`control_plane`, etc.) y se formaliza en roles de acceso al panel:

| Rol | Quién | Alcance |
|---|---|---|
| **`super_admin`** | Jefes / owners | Todo + **gestión de usuarios y roles** + kill switch + settings del tenant. Único que invita/da de baja/cambia roles. |
| **`developer`** | Devs con rol | Infraestructura, Canvas/OpenClaw, Envío, logs, dry-runs. **No** gestiona usuarios. Acciones live gated. |
| **`operator`** | Operación supervisada | Observabilidad (Vista general, Reputación, Warmup read), aprobar/rechazar propuestas dentro de su gate. Sin escritura de infra. |
| **`viewer`** | Auditoría / stakeholders | Solo lectura de todo. Cero acciones. |

Matriz (extracto — se completa en spec):

| Capacidad | super_admin | developer | operator | viewer |
|---|:--:|:--:|:--:|:--:|
| Ver Vista general / Reputación | ✅ | ✅ | ✅ | ✅ |
| Ver/operar Infraestructura, Canvas | ✅ | ✅ | 👁️ | 👁️ |
| Disparar warmup / provisioning (live) | ✅ | ✅¹ | ❌ | ❌ |
| Aprobar propuestas OpenClaw | ✅ | ✅ | ✅¹ | ❌ |
| Gestionar **kill switch** | ✅ | ❌ | ❌ | ❌ |
| **Gestionar usuarios / roles** | ✅ | ❌ | ❌ | ❌ |
| Settings del tenant | ✅ | ❌ | ❌ | ❌ |

¹ = detrás del ApprovalGate + firma existente (no cambia; se le suma el check de rol).

> Permisos como strings finos (`users:manage`, `killswitch:write`, `infra:provision`, `warmup:start`, `proposal:approve`, `panel:read`…). Los roles son **conjuntos de permisos** (editable sin recompilar).

---

## 2. Modelo de datos (Postgres — nuevas tablas)

```
users            (id, email, display_name, status[active|suspended|invited],
                  created_at, last_login_at, mfa_enabled)
roles            (id, key[super_admin|developer|operator|viewer], display_name, description)
permissions      (id, key, description)                    -- catálogo fino
role_permissions (role_id, permission_id)                  -- N:N (roles = sets)
user_roles       (user_id, role_id, granted_by, granted_at) -- un user puede tener 1+ roles
sessions         (id, user_id, issued_at, expires_at, ip, user_agent, transport, revoked_at)
invitations      (id, email, role_id, token_hash, invited_by, expires_at, accepted_at)
```

Semilla inicial: los 4 roles + su set de permisos + el/los super_admin fundadores (email allowlist en `config`, no hardcode en código).

> Nota: hoy `iamRoles`/`iamSessions` del contrato son **lecturas** derivadas. Este modelo es la **fuente de verdad** persistida que esos contratos pasarán a leer (dejan de ser mock).

---

## 3. Autenticación

**Recomendado (Fase 1): auth propia con email + contraseña + MFA (TOTP), sesión server-side.**
- Login → valida credencial (hash `argon2id`) → crea `session` (cookie httpOnly, secure, sameSite=strict) + registra en audit.
- MFA TOTP obligatorio para `super_admin` (opcional/forzable para el resto).
- Expiración de sesión + refresh; revocación inmediata desde la pantalla de sesiones.
- Rate-limit de login (Redis) + lockout tras N intentos.

**Alternativa (evaluar): SSO/OIDC** (Google Workspace de la empresa) si los jefes/devs ya viven ahí — menos password management, MFA delegado. Recomiendo empezar con auth propia (control total, sin dependencia externa) y dejar OIDC como Fase 3 opcional.

> ⚠️ Regla del proyecto: el panel **nunca** teclea/guarda credenciales de terceros; contraseñas solo hasheadas; secretos en Secrets Manager. La creación de contraseñas la hace el usuario, no un agente.

---

## 4. Backend (Gateway — NestJS)

1. **`AuthModule`**: `/v1/auth/login`, `/logout`, `/session` (me), `/mfa/setup|verify`, `/invitations/accept`. Sesión via guard.
2. **`RbacModule`**: `@RequirePermission('users:manage')` decorator + guard que valida el permiso del user de la sesión en CADA endpoint sensible. Middleware global: sin sesión → 401; sin permiso → 403 (auditado).
3. **`UsersModule`** (solo super_admin): `/v1/admin/users` CRUD, `/roles`, `/users/:id/roles`, `/invitations`, `/sessions/:id/revoke`.
4. **Cablear los contratos existentes a datos reales**: `iam/roles`, `iam/sessions`, `compliance/status` pasan a leer las tablas nuevas (dejan de ser fallback/mock — cierra hallazgos del inventario en Gobierno·Seguridad).
5. **Gating por rol de lo que ya existe**: kill switch write, warmup start, provisioning, aprobaciones — se les suma el check de permiso (sin tocar su firma/ApprovalGate).
6. **Auditoría**: cada acción admin → audit chain firmada (mismo mecanismo actual).

---

## 5. Frontend (panel — molde Aivora)

1. **Gate de arranque**: si no hay sesión (`/v1/auth/session` 401) → pantalla de **Login** (nueva, con el molde: Card + logo + form + MFA). Nada del panel se monta sin sesión.
2. **`AuthProvider` + `usePermissions()`**: expone user + permisos; helpers `can('users:manage')`.
3. **Guards de UI**:
   - `sections.ts`: cada sección/pestaña declara `requires: Permission[]`. El sidebar y el command palette **ocultan** lo no permitido.
   - Acciones (botones kill switch, "Iniciar warmup", "Aplicar" del Advisor) se ocultan/deshabilitan por permiso — no botones que prometen y fallan (misma regla anti-mock del avatar/campana).
4. **El avatar se vuelve real** (reemplaza el placeholder actual): menú con nombre + **badge de rol** + email + toggle tema + **Cerrar sesión**. Reusa `Card`/`Pill`/`Row`/`StateBadge` del molde. Dark inlay como el resto del chrome.
5. **Nueva sección `Administración`** (solo `super_admin`, grupo nuevo en el sidebar):
   - **Usuarios**: `DataTable` (email · rol · estado · último acceso · acciones) + invitar + cambiar rol + suspender. Molde Aivora, KPIs ink.
   - **Roles y permisos**: ver/editar el set de permisos por rol.
   - **Sesiones activas**: `DataTable` (actor · IP · transporte · inicio · riesgo · **revocar**) — cablea `iamSessions` real.
   - **Auditoría de acceso**: feed append-only filtrable (reusa el patrón de Gobierno·Seguridad).
6. **Login + Perfil + Admin** heredan tokens/tema/inlay automáticamente (ya está el sistema).

---

## 6. Fases (incrementos verificables, cada uno con tests + audit)

- **F1 — Auth base**: tablas + `AuthModule` + login/session/logout + `AuthProvider` + gate de arranque + Login UI. (Sin RBAC fino todavía: sesión = acceso total temporal, pero YA cierra el panel.)
- **F2 — RBAC + guards**: roles/permisos + guard backend + `usePermissions` + sidebar/acciones filtradas + avatar→menú real con rol + logout.
- **F3 — Gestión de usuarios**: sección Administración (Usuarios/Roles/Sesiones/Auditoría) + invitaciones + revocación. Cablear `iamRoles`/`iamSessions` reales.
- **F4 — MFA + endurecimiento**: TOTP (obligatorio super_admin), rate-limit/lockout, expiración/refresh, gating por rol de kill switch/warmup/provisioning.
- **F5 (opcional) — SSO/OIDC** con Google Workspace.

Cada fase: PRs chicos, tests de policy/permiso/persistencia, dry-run first, y verificación en navegador (login → rol → vistas filtradas → acciones gated) en claro y oscuro.

---

## 7. Riesgos / decisiones que necesito de vos

1. **Auth propia vs SSO Google Workspace** — recomiendo propia en F1, OIDC en F5. ¿De acuerdo?
2. **Roles iniciales** — ¿los 4 propuestos (super_admin/developer/operator/viewer) o querés otros nombres/alcances?
3. **Quiénes son los `super_admin` fundadores** (emails allowlist) — los definís vos, no van hardcodeados en código.
4. **MFA obligatorio** — ¿solo super_admin o todos?
5. **Hosting de sesión** — cookie server-side (recomendado) vs JWT. Recomiendo cookie httpOnly + sesión en Postgres/Redis.

---

## 8. Qué NO hace este plan (fuera de alcance)

- No cambia el diseño ya aprobado; lo **extiende** (Login/Perfil/Admin usan el mismo molde).
- No toca la lógica de envío/warmup/infra salvo para **sumarle el check de rol**.
- No implementa multi-tenant de clientes externos (Delivrix es fábrica interna; un solo tenant, muchos usuarios con rol).

---

**Siguiente paso**: si aprobás roles + auth propia + super_admins fundadores, arranco **F1 (Auth base)** como primer PR — cierra el panel con login real y convierte el avatar en menú de perfil, todo con el molde nuevo.
