# Fase 1 Autonomia SMTP - Defect Ledger

Fecha: 2026-06-04
Rama: `codex/fase1-autonomia`
Base verificada: `1312388` (`codex/fase0-contrato`)

## Cerrado

- F1-01 P0: `produ` no tenia Fase 0. Trabajo iniciado desde `1312388`, no desde `produ` viejo.
- F1-02 P0: el flujo `configure_complete_smtp` podia seguir pidiendo ApprovalGate por cada paso. Se agrego ejecucion por firma de plan anclada a `runId`, `scopeHash`, presupuesto, dominio y recipient, con token interno exactly-once por paso.
- F1-03 P0: `provision_smtp_postfix` se bloqueaba con `dkim_private_key_missing`. Se agrego `ensureDkimKeyPair` generate-if-missing antes de provision, reutilizado por email-auth, con privada `0600` y audit solo con hash/public key.
- F1-04 P1: no existia lectura IONOS read-only. Se agrego `GET /v1/dns/ionos/records`, tool `read_dns_ionos`, allowlist read-only y token `x-delivrix-token`.
- F1-05 P1: el agente podia improvisar subtools SMTP en vez del orquestador. El processor bloquea subtools directas de SMTP completo cuando `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE` y `OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE` estan ON, salvo reparacion puntual explicita.
- F1-06 P1: el prompt remoto/local no declaraba la disciplina de Fase 1. `OPENCLAW_SYSTEM_PROMPT.md` sube a v2.6 con `configure_complete_smtp`, una firma de plan, `read_dns_ionos` antes de upsert y prohibicion de aprobacion por texto.
- F1-07 P1: los 7 dominios sender productivos no estaban sembrados como hechos verificados. El seed episodico agrega `verified_fact` firmados por operador con `production_sender_stack_active`.

## Verificacion

- `node --test` focal Fase 1: 127/127 verde.
- `node --test scripts/db/seed-episodic.test.mjs`: 5/5 verde.
- `npm test`: 824/824 verde.
- No se tocaron los tests de contrato criptografico para cambiar HMAC/nonce/TTL. `proposals-sign.test.ts` y `proposals-reject.test.ts` quedaron verdes dentro de la suite.

## No Ejecutado En Esta Tanda

- No se hizo fast-forward de `produ`.
- No se reinicio gateway/panel local.
- No se hizo backup/push Hostinger.
- No se hizo smoke real con gasto/envio. El siguiente paso debe ser deploy con firma explicita del operador, primero dry-run y luego corrida real si el dry-run queda verde.

## Riesgos Residuales Antes De Deploy Real

- Confirmar en runtime que `.env.local` tenga `OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE=true` y `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE=true`.
- Confirmar visualmente en Canvas que la tarjeta de plan aparece como una unica aprobacion y que el progreso por paso se renderiza sin solaparse.
- Confirmar si Webdock permite PTR automatico; si no, declararlo como accion pre-run unica y no como bloqueo a mitad del flujo.
- Ejecutar `read_dns_ionos` contra zona real antes del primer `upsert_dns_ionos` vivo.
