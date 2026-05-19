# Decision · Multi-Approver Placeholder MVP

Fecha: 2026-05-19

Durante D+5 PM se usan identidades placeholder `op-juanes-a` y `op-juanes-b`
para validar el flujo de dos aprobadores del runbook `warming-step`.

Alcance:

- Es una decisión exclusiva del MVP local.
- La autenticación real OIDC y el mapeo de identidad humana quedan post-MVP.
- Los endpoints siguen exigiendo `X-Operator-Id` con prefijo `op-` y auditan
  cada firma.
- No se habilita ninguna mutación live contra infraestructura externa.

Motivo:

El objetivo del hito es probar quorum, consumo atómico de ApprovalTokens,
ejecución de runbook local y rollback verificable sin introducir auth real antes
de tiempo.
