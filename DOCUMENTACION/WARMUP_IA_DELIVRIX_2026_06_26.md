# Calentamiento de bandejas con IA — investigación y adaptación a Delivrix

> Cómo funciona el warmup con IA en Instantly.ai y cómo hacerlo en Delivrix sobre **infraestructura propia**.
> Informe técnico citado · 2026-06-26 · Track A/E del roadmap Own the Rails.

> **Nota de honestidad técnica (leer primero).** El warmup artificial de pool recíproco (modelo Instantly/Smartlead/Mailreach) tiene en 2024-2026 un valor de señal **decreciente y debatido**, y vía la Gmail API es una **violación de los Términos de Servicio de Google** que ya tumbó al proveedor más grande del mercado (GMass, 2023). Lo único que sobrevive como legítimo es la **rampa gradual de volumen real a destinatarios reales**. Este documento describe el modelo Instantly fielmente, pero la sección 7 ("Obligaciones / Realidad") marca con precisión qué es legítimo y qué es humo. Delivrix ya tiene parte de la infraestructura construida; el cierre se ancla en eso, no en empezar de cero.

---

## 1. Cómo funciona el warmup de Instantly

### 1.1 El pool
- **Cifra defendible (on-product): "más de 1.000.000+ cuentas de email reales"** en el pool de entregabilidad. (Los blogs dicen 4.2M, marketing; usar ~1M+.)
- Son **buzones reales** (Gmail/Outlook de otros usuarios de Instantly que activaron warmup), **pero la interacción la ejecuta automatización** ("a private network of headless browsers"), no humanos.

### 1.2 Tráfico recíproco
Una vez activado: tu cuenta envía warmup a otros del pool; otros te envían a ti; todos los correos se abren automáticamente; un alto porcentaje recibe respuestas con sentimiento positivo; calienta el SMTP de envío y el IMAP de recepción, no solo la dirección.

### 1.3 Qué hace la IA exactamente
| Conducta | Qué hace |
|---|---|
| Genera contenido | Correos generados por IA, escritos para parecer conversaciones reales |
| Abre (Open Rate) | % de correos de warmup que se abren automáticamente |
| Responde (Reply rate) | % que recibe respuestas del pool (default sugerido 30%) |
| Saca de spam | Mueve los correos de warmup de spam al inbox (esto construye reputación) |
| Marca importante | % que se marca como importante (señal positiva) |
| Emula lectura | Simula scroll/lectura humana |
| Archiva (lado receptor) | Un filtro con un tag deja el warmup fuera del inbox primario |

### 1.4 Rampa gradual
- Default cuentas nuevas: **10 correos/día**, con incremento lineal (**+1/día**, cuentas viejas +2/día).
- **Techo recomendado: 30 correos/día por buzón.** Se escala con **más buzones**, no con más volumen por buzón.
- Curva canónica 30 días por buzón/día: Semana 1 = 5 · Semana 2 = 10-15 · Semana 3 = 20-25 · Semana 4 = 30.
- **Duración mínima 2 semanas** antes de campañas. El warmup **nunca se apaga** (se mantienen 20-30/día junto a las campañas).

### 1.5 Ligadura a reputación y auto-pausa
- **Warmup Health Score** = (correos warmup en inbox ÷ total enviados) × 100, ventana 7 días. Apuntar a **>90%**. Puerta a campañas: ≥2 semanas **y** score >90%.
- **Auto-pausa** si bounce sube o si los correos empiezan a caer en spam. Playbook de recuperación: reducir envíos 30-50% y re-testear placement; ante bounces altos, parar 48h y reanudar al 50% del tope previo.

---

## 2. Parámetros configurables (con defaults de Instantly)
- **Increase per day = 1** · **Daily warmup limit = 10** · **Reply rate = 30%**.
- **Warmup filter tag** (va en asunto y pie; el buzón receptor lo archiva con un filtro).
- **Weekdays only** (envía solo días hábiles, recibe siempre).
- **Read Emulation**, **Open Rate %**, **Spam Protection %** (rescate de spam), **Mark Important %**, randomización del número diario.

---

## 3. Métricas y health-score
- **Fórmula dominante:** inbox-placement sobre el propio tráfico de warmup, ventana 7 días. 90%+ bueno, 99-100% ideal.
- **Cómo se mide el placement:** vía un **seed/network inbox** que registra dónde aterrizó (primario / Promotions / spam / no-entregado).
- **Mejor modelo (compuesto ponderado, estilo Warmy):** 40% deliverability + 25% Google Postmaster (reputación + spam rate) + 20% DNS (SPF/DKIM/DMARC) + 15% inbox-placement test. 0-100 con bandas color.
- **Señales reales del proveedor:** Google Postmaster Tools v2 (spam rate + Compliance Status; **ojo: Google retiró los grados High/Medium/Low de reputación el 30-sep-2025**) y Microsoft SNDS (complaint rate, IP reputation).
- **Umbral duro de Gmail:** complaint rate **<0.10% objetivo, nunca 0.30%**.

---

## 4. Competidores (para comparar enfoques)
- **Smartlead:** pool privado curado; escalado **adaptativo** con auto-pausa, shuffle de subjects/horarios.
- **Mailreach:** 30k+ buzones reales; **rechaza el "+1/día" fijo** por un "algoritmo complejo con docenas de parámetros"; postura anti-cosmética (no calienta por industria/idioma).
- **Lemwarm:** 20k+ usuarios; **Smart Cluster** por industria + contenido único (Mailreach llama a esto "teatro de entregabilidad" — hay desacuerdo real entre vendors).
- **Warmup Inbox / Mailwarm / Warmbox:** pools 30k-50k.
- Lectura transversal: las tools serias usan **rampas adaptativas con auto-pausa**, no incrementos fijos.

---

## 5. Críticas y límites (el debate 2024-2026)
- **Parteaguas GMass (2023):** Google lo forzó a apagar su warmup; ahora lo considera **violación de ToS** de la Gmail API ("multiple accounts to... circumvent filters").
- **Consultores que lo probaron:** sin lift medible en Postmaster. Vendors lo conceden: "para 2024 ambos proveedores identificaron los rangos de IP de los servicios de warmup y bajaron el peso de la señal".
- **Por qué lo detectan:** loops recíprocos cerrados; engagement ponderado por **diversidad** de quien interactúa (no por volumen); engagement "demasiado perfecto" (replies a minutos, opens estadísticamente implausibles); IPs de bots agrupadas (AWS/Heroku); contenido plantilla repetido.
- **El espejismo:** Postmaster se ve bien durante el warmup y **la reputación se degrada en 10-14 días** al chocar con destinatarios reales.
- **Riesgos:** blacklist por asociación (pools con dominios spammy), spam-traps, y en 2025 **suspensión de cuentas/tenants** de Google que detectan conexión a plataformas de cold email.
- **El otro lado (legítimo):** la **rampa gradual de volumen real** SÍ está avalada textualmente por Google, Microsoft y Amazon SES. La crítica apunta a la **malla de engagement falso**, no a la rampa.

---

## 6. Adaptación a Delivrix (infraestructura propia)

### 6.0 Punto de partida: lo que Delivrix YA tiene
Delivrix **no parte de cero**. El repo ya tiene un sustrato de warmup funcional pero **desconectado**:

| Pieza | Archivo | Qué hace hoy | Brecha |
|---|---|---|---|
| Seed inicial | `routes/warmup.ts` | Envía 3 correos seed por SSH desde `hello@<dominio>`, firmado, idempotente, auditado | Contenido estático; sin IA; sin engagement del otro lado |
| Scheduler de rampa | `routes/warmup-ramp.ts` | Batches en el tiempo, persiste, resume-on-boot, **auto-pausa si bounce >5%** | Curva **fija** (no guiada por placement); breaker solo por bounce |
| Curvas | `domain/warmup/ramp-plan.ts` | `demo-fast` y `production-14d`; `DELIVERY_RATE_FLOOR=0.85` definido | No enforced; sin tope por buzón |
| Medición de placement | `routes/placement-check.ts` + `gmail-adapter.ts` | IMAP a un seed Gmail, clasifica inbox/spam vía X-GM-LABELS | **Read-only y desconectado** del scheduler |
| Circuit-breaker | `auto-rollback.ts` | Pausa por bounce | No consume spam-rate/placement |

**Conclusión:** Delivrix tiene rampa + persistencia + breaker-por-bounce + medición de placement. Faltan cuatro cosas: (1) engagement recíproco real entre buzones propios, (2) generación de contenido con IA local, (3) rampa **guiada por placement**, (4) breaker **por spam-rate**.

### 6.1 La diferencia estructural (y la restricción dura)
Delivrix tiene infra propia (servidor dedicado + IPs propias + SMTPs propios). Eso invierte la economía y el riesgo. **PERO:** el argumento de los críticos —el engagement solo cuenta si viene del mismo ecosistema diverso— se aplica **con más fuerza** a una malla 100% propia. Si tus SMTPs se mandan correos **solo entre ellos** (mismo rango de IP, mismos dominios), Gmail/Outlook ven exactamente el **loop recíproco cerrado en un solo rango** que es el fingerprint más fácil de detectar. **Una malla interna pura es el peor caso de detección, no el mejor.**

Por lo tanto la adaptación correcta **NO es** "replicar la malla recíproca de Instantly con mis buzones". Es un **modelo de dos planos**:
1. **Acondicionamiento de volumen (el núcleo, legítimo):** rampa gradual de volumen real desde cada IP/dominio nuevo hacia una **seed-list de buzones reales y diversos** (Gmail/Outlook/Yahoo + dominios de aliados que opten), midiendo placement real y dejando que la IA decida la pendiente.
2. **Plano recíproco interno (acotado y honesto):** intercambio entre buzones propios **solo** para calentar el stack SMTP/IMAP/DKIM y no nacer 100% en silencio — **nunca** como sustituto del engagement real ni inflado a open/reply artificiales. Marcado, auditado, con tope estricto.

### 6.2 El cerebro de IA local (Mac Studio + gpt-oss-20b)
**(A) Generador de contenido de warmup:** reemplaza el cuerpo plantilla por correos humano-realistas variados (asunto+cuerpo natural, variación léxica, hilos de 1-2 respuestas). Corre **local** (sin enviar contenido a Bedrock, gratis por token). Randomizar longitud, hora (jitter), remitente/destinatario; **no** clavar open/reply fijos. Tag de filtro **por dominio** (no global, para no crear firma compartida).

**(B) Decisor de rampa guiado por placement:** reemplaza la curva fija por una política adaptativa que consume el `placementRate` tras cada batch: si placement ≥90% y spam bajo → sube un escalón (techo ~30-50/buzón/día); si cae <80% → mantiene; si <70% o spam sube → reduce 30-50% y re-testea. Pasa de "curva determinística" a "lazo de control cerrado sobre placement real".

> La IA **decide la pendiente**; los guardrails firmados (budget, kill-switch, scope) y el breaker determinístico **acotan**. La IA nunca puede saltarse el tope por buzón ni el umbral de spam.

### 6.3 Circuit-breaker por spam-rate (no solo bounce)
Añadir un segundo disparador al `shouldAutoPauseWarmup` (hoy solo bounce):
- Fuente: `placement-check.ts` (spam vs inbox en seeds) + Google Postmaster v2 spam rate + Microsoft SNDS complaint rate.
- Umbrales: reducir si spam en seeds >10-15% del batch; **pausar duro si el complaint rate se acerca a 0.30%** (objetivo <0.10%).
- Acción: reusar `pauseRamp({reason})` con un `WarmupRampPauseReason` nuevo (`auto_spam_rate`/`auto_placement_floor`); enforcar el `DELIVERY_RATE_FLOOR=0.85` que hoy está definido pero no aplicado.

### 6.4 Seed-list propia y rotación
Seed-list **real y diversa** (no solo dominios propios): Gmail/Outlook/Yahoo de control (IMAP ya cableado vía `GMAIL_IMAP_*`) + dominios de aliados que opten. La diversidad de ESP es lo que da señal. Rotar destinatarios entre batches; rotación de IP/servidor apoyada en la selección de cuenta/servidor first-class que Delivrix ya tiene.

### 6.5 Medición de placement (cerrar el lazo)
`placement-check.ts` ya hace lo difícil. Falta: que `RampScheduler.runBatch` dispare un placement-check tras enviar (ventana ~30 min) y realimente el decisor (6.2.B) y el breaker (6.3); extender a multi-seed (varios ESP); ingesta read-only de Postmaster/SNDS.

### 6.6 Health-score propio (modelo Warmy, no el simple de Instantly)
Score compuesto: deliverability (placement sobre seeds diversos) + spam rate Postmaster + complaint SNDS + DNS. 0-100 con bandas color en el panel, sobre el `rampSnapshot` que ya existe.

### 6.7 Piezas a construir (accionable)
| # | Pieza | Estado | Trabajo |
|---|---|---|---|
| 1 | Generador de contenido IA local | Nuevo | Servicio que llama gpt-oss-20b en Mac Studio; reemplaza el render plantilla; tag por dominio; randomización |
| 2 | Decisor de rampa adaptativo | Reemplaza curva fija | Política que consume placement post-batch y elige pendiente (techo 30-50/buzón/día) |
| 3 | Circuit-breaker por spam-rate | Extiende lo existente | Disparador por spam de seeds + Postmaster; nuevo pause-reason; enforce delivery floor |
| 4 | Wire-up placement → scheduler | Conectar 2 rutas | `runBatch` dispara placement-check y realimenta decisor + breaker |
| 5 | Seed-list diversa + ingesta Postmaster/SNDS | Nuevo | Pool multi-ESP + conector read-only GPT v2 / SNDS |
| 6 | Motor recíproco interno acotado | Nuevo (opcional, honesto) | Intercambio entre buzones propios SOLO para calentar el stack, con tope, marcado y auditado |
| 7 | Health-score compuesto + UI | Nuevo | Modelo Warmy, 0-100 color, sobre `rampSnapshot` |

---

## 7. Obligaciones / Realidad (para no vender humo)

**Legítimo y defendible:**
- Rampa **gradual de volumen real** a destinatarios reales y diversos, vigilando bounce/complaint (avalado por Google/Microsoft/SES). Delivrix ya lo tiene a medio construir.
- **Autenticación impecable** (SPF/DKIM/DMARC + one-click unsubscribe): precondición, no adorno.
- **Higiene de lista + complaint rate <0.10%** (nunca 0.30%): la palanca que realmente decide placement.
- **Medición con datos del proveedor** (Postmaster v2 + SNDS), no con aperturas propias.
- Contenido **realista y variado** con IA local.

**Humo / riesgoso (NO hacer):**
- **Malla recíproca cerrada entre buzones propios en un solo rango de IP** como sustituto del engagement real: es el fingerprint más fácil de detectar.
- **Inflar open/reply a porcentajes artificiales fijos** y engagement "demasiado perfecto".
- **Warmup vía Gmail API** entre cuentas: viola ToS de Google (tumbó a GMass). Delivrix usa SMTP/IMAP propio, lo cual evita ese camino — pero el principio anti-loop sigue.
- **Prometer un "Gmail reputation score" en vivo:** Google lo retiró (sep-2025).
- **Vender warmup como "garantía de inbox":** sin lift medible; la reputación inflada colapsa en 10-14 días.

**El encuadre honesto:** lo que Delivrix construye **no es** un clon del warmup de Instantly con buzones propios. Es **acondicionamiento de IP/dominio guiado por placement real, con IA local para contenido y decisión de rampa, y breaker por spam-rate**, sobre la base de autenticación + higiene. El moat de infra propia es justo lo que permite hacer la versión **legítima** a fondo: controlas IP, contenido, cadencia y medición — no necesitas (ni te conviene) fingir engagement.

---

## Fuentes
**Instantly:** help.instantly.ai (warmup-settings, how-warm-up-works, warmup-health-score, warmup-filters); instantly.ai/email-warmup y blogs (email-warmup-process, warmup-plan-for-ai-reply-agent, slow-ramp, scaling-email-warm-up).
**Métricas/competidores:** Warmy health score; Warmup Inbox; Smartlead; Mailreach; Lemwarm.
**Proveedores (autoritativas):** Google sender guidelines (support.google.com/a/answer/81126); Google Workspace API policy; Postmaster dashboards; Microsoft Outlook high-volume reqs; SNDS; Amazon SES IP warming.
**Crítica/legitimidad:** GMass shutdown (gmass.co/blog/warmup-shutting-down); Postbox (do warmup tools work 2025); Digital Applied (2026 playbook); LiteMail (does warmup work 2026 / Workspace suspension); LeadHaste; Hotsol; Mailivery; Mailreach (Instantly review).
