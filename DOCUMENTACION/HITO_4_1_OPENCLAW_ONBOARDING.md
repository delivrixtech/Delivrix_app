# Hito 4.1: OpenClaw intelligent onboarding

Fecha: 2026-05-02

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.  
Documento de fase: `FASE_4_OPENCLAW_INFRAESTRUCTURA.md`.

## Objetivo

Construir el primer flujo real de OpenClaw: onboarding inteligente para infraestructura propia de mailing sobre servidor fisico.

Este hito no crea clusters todavia. Su trabajo es preguntar, validar, detectar faltantes, generar un snapshot auditable y decidir si hay suficiente informacion para pasar al Hito 4.2, `Cluster topology planner`.

## Cambios implementados

### 1. Dominio de onboarding

Archivo:

- `packages/domain/src/openclaw-onboarding.ts`

Expone:

- `getOpenClawOnboardingQuestionnaire`
- `evaluateOpenClawOnboarding`

El dominio define:

- schema de entrada para servidor fisico, Proxmox, IPs, dominios, DNS, compliance, limites, seguridad y autonomia;
- preguntas guiadas por categoria;
- validadores de datos criticos;
- decision `go`, `needs_review` o `no_go`;
- readiness score por frente;
- snapshot dry-run y auditable;
- acciones bloqueadas por seguridad.

### 2. Preguntas guiadas

El cuestionario cubre:

- modelo, CPU, RAM, storage, red, UPS y cooling;
- estado de Proxmox;
- total de IPs, tipo de IP, aprobacion del proveedor y PTR;
- dominios verificados;
- DNS y acceso API;
- opt-out, suppression list, direccion fisica, consentimiento y autorizacion del proveedor;
- limites de volumen, nodos iniciales y warming;
- manejo de secretos, auditoria y kill switch;
- modo de autonomia de OpenClaw.

### 3. Go/No-Go

OpenClaw no permite pasar al topology planner si faltan datos criticos.

Estados:

- `no_go`: faltan datos criticos o hay una condicion insegura.
- `needs_review`: los datos criticos existen, pero hay riesgos que requieren revision humana.
- `go`: los datos criticos estan completos y el siguiente paso seguro es Hito 4.2.

El snapshot siempre mantiene:

- `dryRun: true`;
- `sideEffects: none`;
- SSH deshabilitado;
- SMTP deshabilitado;
- DNS live changes deshabilitado;
- escrituras NFC deshabilitadas;
- mutaciones reales de infraestructura deshabilitadas.

### 4. Gateway API

Endpoints nuevos:

```bash
curl -s http://127.0.0.1:3000/v1/openclaw/onboarding/questionnaire
```

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/onboarding/evaluate \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local","server":{"model":"IBM System x3630 M4"}}'
```

El endpoint de evaluacion:

- acepta payload parcial o completo;
- genera snapshot de onboarding;
- audita `openclaw_onboarding.evaluated`;
- devuelve blockers, warnings, missing critical fields y preguntas recomendadas;
- no ejecuta acciones reales.

### 5. Norte operativo actualizado

`GET /v1/operating-north` ahora declara fase:

- `4.1-openclaw-intelligent-onboarding`

Accion permitida en dry-run:

- `evaluate_openclaw_onboarding`

## Criterio de salida

Hito 4.1 queda cerrado si:

- existe schema de onboarding;
- existen preguntas guiadas;
- existen validadores criticos;
- se genera snapshot auditable;
- existe decision Go/No-Go;
- el gateway expone endpoints seguros;
- la evaluacion queda auditada;
- no hay side effects externos;
- las pruebas automatizadas pasan.

## Pruebas

Comando:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Resultado esperado al cierre del hito:

- 69 pruebas pasando.

## Que queda para Hito 4.2

- Convertir un onboarding `go` o `needs_review` en topology plan.
- Calcular cantidad inicial de VPS/LXC.
- Proponer sizing por nodo.
- Asignar IP/dominio/hostname.
- Definir orden de provisioning.
- Generar riesgos por recurso.
- Mantener todo en dry-run.
