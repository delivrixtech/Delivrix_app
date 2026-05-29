# OPS Codex Result — OpenClaw Bedrock Direct Bridge

Fecha: 2026-05-29

## Commit

- Código: `a389a4e feat(gateway): add OpenClaw Bedrock direct bridge`

## Archivos

- Creado: `apps/gateway-api/src/openclaw-bedrock-bridge.ts`
- Creado: `apps/gateway-api/src/openclaw-bedrock-bridge.test.ts`
- Modificado: `apps/gateway-api/src/openclaw-chat.ts`
- Modificado: `apps/gateway-api/src/main.ts`
- Modificado: `apps/gateway-api/package.json`
- Modificado: `package-lock.json`

## Resultado

Implementado bridge directo OpenClaw -> AWS Bedrock Runtime con activación por `OPENCLAW_BRIDGE_KIND=bedrock`.

Comportamiento:

- Si `OPENCLAW_BRIDGE_KIND` no es `bedrock`, el gateway conserva el bridge SSH/HTTP existente.
- Si `OPENCLAW_BRIDGE_KIND=bedrock` y existen credenciales/modelo, el gateway usa `OpenClawBedrockBridge`.
- Carga system prompt desde `.audit/system-context.txt`.
- Fallback a `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md`.
- Mantiene memoria conversacional in-process por `sessionKey`.
- Emite eventos compatibles con el panel: `ASSISTANT_TYPING`, `ASSISTANT_DELTA`, `ASSISTANT_DONE`.
- Registra auditoria `oc.chat.bedrock_invoked` con `modelId`, tokens, latencia y longitud de contenido, sin persistir prompt ni respuesta literal en ese evento.

## Verificaciones

Pasaron:

```bash
node --check apps/gateway-api/src/openclaw-bedrock-bridge.ts
node --check apps/gateway-api/src/openclaw-chat.ts
node --check apps/gateway-api/src/main.ts
node --test apps/gateway-api/src/openclaw-bedrock-bridge.test.ts apps/gateway-api/src/openclaw-ssh-bridge.test.ts apps/gateway-api/src/openclaw-chat.test.ts
```

Resultado tests:

```text
tests 17
pass 17
fail 0
```

`npx --no-install tsc --noEmit --pretty false` sigue fallando por errores preexistentes del workspace (`audit/hash-chain.test.ts`, `audit/schema.ts`, `pg`, `main.ts`, `canvas-live`, `smtp-provisioning`, etc.). Se verifico que no hay errores que mencionen `openclaw-bedrock-bridge`.

## Smoke Bedrock

No ejecutado.

Motivo real:

```text
OPENCLAW_BRIDGE_KIND=ssh
AWS_BEDROCK_ACCESS_KEY_ID=<missing>
AWS_BEDROCK_SECRET_ACCESS_KEY=<missing>
AWS_BEDROCK_REGION=<missing>
AWS_BEDROCK_MODEL_ID=<missing>
```

Segun la regla dura del OPS, sin env vars Bedrock no se arranca smoke live. Costo de pruebas live: `0` tokens / `$0`.

## System Context

Existe bundle local:

```text
.audit/system-context.txt
size: 30505 bytes
```

Nota: `scripts/openclaw/build-system-context.sh` puede fallar al final por SSH Hostinger, que es el bloqueo ya clasificado en el OPS anterior. Para este adapter no bloquea porque el archivo local existe y hay fallback al prompt base.

## Proximo paso

Setear en `.env.local`:

```bash
OPENCLAW_BRIDGE_KIND=bedrock
AWS_BEDROCK_ACCESS_KEY_ID=...
AWS_BEDROCK_SECRET_ACCESS_KEY=...
AWS_BEDROCK_REGION=us-east-1
AWS_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

Despues reiniciar gateway y correr smoke contra `/health` y `/v1/openclaw/chat/send`.
