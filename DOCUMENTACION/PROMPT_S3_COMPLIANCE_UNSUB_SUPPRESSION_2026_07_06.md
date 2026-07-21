# Brief — S3: Compliance de envío (one-click unsubscribe + suppression enforcement)

> Prompt accionable para el agente de desarrollo (VS Code / bash).
> Fecha: 2026-07-06 · Sprint: Own the Rails · Track S · **Gate duro antes de meter volumen.**
> Transversal: no depende del hardware de Fase 0; se puede hacer ya, en paralelo.

---

## 0. Objetivo

Que Delivrix cumpla lo minimo legal/tecnico para enviar en serio, sin lo cual Gmail/Outlook castigan:
1. **List-Unsubscribe one-click (RFC 8058):** Gmail muestra el boton nativo "Cancelar suscripcion".
2. **Enforcement de suppression:** NINGUN correo sale a una direccion suprimida, nunca.
3. **Direccion fisica** del remitente en el pie (CAN-SPAM).

---

## 1. Ground truth (LEER antes; no adivinar)

- `apps/gateway-api/src/routes/send-email.ts` — ruta de envio real (aca se arman headers y se dispara el SMTP).
- `packages/domain/src/mail-policy.engine.ts` — motor de politica de correo (punto natural para el gate de suppression pre-envio).
- `packages/local-store/src/local-file-suppression-list.ts` — store de la suppression list (lectura/escritura).
- `packages/domain/src/send-result-ingestion.ts` — ingesta de resultados (bounces/complaints -> alimentan suppression).
- `apps/worker/src/main.ts` — worker (si el envio a escala pasa por aca, el gate va tambien aca).

Regla: leer estos archivos, entender como se envia HOY y donde se decide "enviar o no", antes de escribir.

---

## 2. Alcance — que construir

### T1. Headers RFC 8058 en el envio (`send-email.ts`)
- Agregar en cada correo:
  - `List-Unsubscribe: <https://<dominio-propio>/u/{token}>, <mailto:unsub@<dominio>?subject=unsub>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- `{token}` = firmado (HMAC), no enumerable, codifica destinatario + campaña/stream. Sin PII en la URL en claro.

### T2. Endpoint one-click (POST)
- `POST /u/{token}` (o `/v1/unsubscribe`): valida el token, agrega la direccion a la suppression list (`local-file-suppression-list.ts`), **idempotente**, con audit. Responde 200 aunque ya estuviera suprimida.
- Aceptar el POST sin cookies ni login (asi lo llama Gmail). Rate-limit basico.

### T3. Enforcement pre-envio (el gate duro)
- En `mail-policy.engine.ts` (o el punto de decision del send path y del worker): **antes de cada envio**, consultar la suppression list. Si el destinatario esta suprimido -> NO enviar, registrar audit `suppressed`, no contarlo como bounce.
- Debe ser determinístico y estar en el hot path de TODO envio (incluye warmup y envios reales).

### T4. Direccion fisica en el pie
- Footer con direccion postal fisica del remitente (CAN-SPAM), configurable por env/tenant. No hardcodear.

---

## 3. Guardrails

- Token firmado (HMAC), idempotente, auditado. Nada enumerable.
- El enforcement es determinístico: ninguna decision de IA lo puede saltar.
- No romper el flujo de envio existente (feature-flag para activar gradual si hace falta).

## 4. Definition of Done

- Gmail (cuenta de prueba) muestra el boton nativo de unsubscribe en un correo de Delivrix.
- Un POST one-click al endpoint suprime la direccion (idempotente, audit).
- Test que prueba: **un envio a una direccion suprimida NO sale** (gate en el hot path).
- El pie trae la direccion fisica configurable.
- Suite verde; PR + QA Auditor; merge a produ; deploy local + Hostinger; `build-system-context.sh` si toca el prompt.
- Sin emojis en codigo (ASCII: OK/FALLO/->).

## 5. Primeros pasos

1. Leer `send-email.ts`, `mail-policy.engine.ts`, `local-file-suppression-list.ts`, `send-result-ingestion.ts`.
2. T3 primero (el gate de suppression es lo mas critico y protege ya).
3. Luego T1 + T2 (headers + endpoint one-click), T4 (footer).
4. Tests, PR, merge, deploy.

## 6. Nota de alcance

- S1/S2/S4/S5 (API de envio a escala, cola+workers, rotacion, reportes/unibox) son **F2+** y NO son parte de este brief. S3 es lo unico de Track S que es de sprint porque es requisito duro para enviar.
