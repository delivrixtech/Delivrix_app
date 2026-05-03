# Roadmap operativo Delivrix

Fecha de roadmap: 2026-05-01  
Base documental: `Tesis_Delivrix_v3.4_BUSINESS_PLAN_MVP.pdf` y `RESUMEN_RUTA_PROYECTO.md`.

Nota critica: este roadmap debe leerse junto con `ANALISIS_CRITICO_ROADMAP.md`. El calendario no autoriza avanzar por si solo; cada fase requiere cumplir gates tecnicos, legales, reputacionales y operativos.

## Objetivo

Construir una plataforma propia de mailing autorizado para Delivrix, con MVP funcional en 30 dias y ruta progresiva hacia 1,000,000 correos diarios sostenidos en septiembre de 2026.

El roadmap se organiza en fases verificables. Cada fase debe dejar un entregable usable, medible y auditable.

## Principios de ejecucion

- Continuidad primero: Webdock sigue operando mientras la nueva plataforma madura.
- Compliance desde el dia 1: opt-out, suppression list, direccion fisica, headers correctos, trazabilidad, bounces y complaints.
- Automatizacion con barandillas: OpenClaw solo ejecuta acciones reversibles o de bajo impacto sin aprobacion humana.
- Infraestructura progresiva: no subir volumen sin warming ni metricas saludables.
- Auditoria obligatoria: toda accion humana o autonoma queda registrada.
- Kill switch siempre disponible para OpenClaw y procesos de envio.

## Gates no negociables

El proyecto no debe aumentar volumen ni autonomia si falla alguno de estos gates:

- Gate legal/compliance: opt-out funcional, suppression list global, direccion fisica valida, headers y asuntos no enganosos, prueba de autorizacion de destinatarios y procesamiento de bajas.
- Gate reputacion: bounces, complaints, bloqueos y blacklist status bajo umbrales definidos, con pausa automatica ante degradacion.
- Gate proveedor: cualquier proveedor usado para envio debe aceptar por escrito el tipo de trafico autorizado de Delivrix y sus condiciones operativas.
- Gate infraestructura: pruebas de carga por lote antes de pasar de 30 a 100, de 100 a 200 y de 200 a 300 sender nodes.
- Gate seguridad: secretos rotados, tokens con scope minimo, audit log append-only, rollback probado y kill switch validado.
- Gate OpenClaw: primero read-only, luego supervised, luego autonomia limitada; no ejecutar acciones masivas sin etapa de observacion previa.

## Ruta critica

1. Aprobar o confirmar decisiones pendientes: internet empresarial, IP leasing, ARIN.
2. Inicializar repo y arquitectura de software.
3. Construir Gateway, Worker, PostgreSQL, Redis/BullMQ y audit log.
4. Registrar Webdock como sender bridge para continuidad.
5. Implementar politicas de envio autorizado y reputacion.
6. Agregar admin panel con visibilidad y kill switch.
7. Integrar Proxmox/sender nodes cuando el servidor fisico este listo.
8. Construir OpenClaw con permisos acotados, dry-run, verificacion y rollback.
9. Escalar por lotes con warming, metricas y gates de reputacion.

## Fase 0: Preparacion y decisiones

Periodo sugerido: 2026-05-01 a 2026-05-03

### Entregables

- Roadmap aprobado como guia de ejecucion.
- Checklist de decisiones pendientes.
- Estructura inicial del proyecto definida.
- Criterios de compliance y seguridad aceptados como no negociables.

### Decisiones a cerrar

- Internet empresarial Popayan con IP fija.
- Documentacion requerida para IP leasing /24 USA.
- Inicio o aplazamiento del tramite ARIN /23.
- Alcance exacto del MVP de software si el servidor fisico se retrasa.

### Criterio de salida

- Se puede empezar desarrollo sin bloquearse por decisiones de negocio.

## Fase 1: Base del producto y arquitectura

Periodo sugerido: 2026-05-04 a 2026-05-10

### Objetivo

Crear el esqueleto funcional de la plataforma: backend, cola, base de datos, politicas y trazabilidad.

### Entregables tecnicos

- Monorepo o estructura base del proyecto.
- Backend NestJS con configuracion TypeScript.
- PostgreSQL con migraciones iniciales.
- Redis + BullMQ configurado.
- Modulos base:
  - Gateway API.
  - Worker.
  - Audit log append-only.
  - Mail policy engine.
  - Sender node registry.
  - Suppression list.
- Variables de entorno y manejo seguro de secretos.
- Pruebas iniciales de servicios y politicas.

### Criterio de salida

- Una solicitud de envio puede entrar al Gateway, validarse, quedar auditada y convertirse en job de cola sin enviar aun correo real.

## Fase 2: Pipeline operativo con Webdock

Periodo sugerido: 2026-05-11 a 2026-05-17

### Objetivo

Conectar la plataforma a la operacion actual de manera controlada, usando Webdock como puente.

### Entregables tecnicos

- WebdockAdapter para registrar los 3 VPS existentes como sender nodes.
- Modelo de estados para sender nodes:
  - active.
  - warming.
  - paused.
  - quarantined.
  - degraded.
  - retired_pending_approval.
- Rate limits por VPS, dominio, campana y destinatario.
- Registro de resultados:
  - enviado.
  - bounce.
  - complaint.
  - deferred.
  - failed.
- Primeros reportes operativos.
- Admin panel inicial:
  - estado de colas.
  - sender nodes.
  - volumen.
  - bounces.
  - complaints.
  - acciones auditadas.

### Criterio de salida

- La plataforma puede controlar trafico de prueba o bajo volumen hacia Webdock, con politicas, auditoria y visibilidad.

## Fase 3: Infraestructura propia piloto

Periodo sugerido: 2026-05-18 a 2026-05-24

### Objetivo

Preparar la plataforma para operar sender nodes propios sobre Proxmox o, si el servidor fisico aun no esta disponible, un mock compatible para no frenar desarrollo.

### Entregables tecnicos

- ProxmoxAdapter con interfaz estable.
- Provisioning flow para sender node:
  - crear VPS/LXC.
  - asignar IP.
  - configurar Postfix.
  - configurar OpenDKIM.
  - configurar TLS.
  - registrar DNS rutinario.
  - iniciar warming.
- IP reputation service inicial.
- Cuarentena automatica por thresholds.
- Panel con acciones humanas:
  - pausar nodo.
  - reactivar nodo.
  - aprobar retiro.
  - activar kill switch.
- Backups iniciales hacia S3 o interfaz preparada.

### Criterio de salida

- Un sender node nuevo puede ser registrado y pasar por el flujo completo de preparacion, aunque el envio productivo siga limitado.

## Fase 4: OpenClaw MVP

Periodo sugerido: 2026-05-25 a 2026-05-31

Documento operativo de fase: `FASE_4_OPENCLAW_NFC_INTEGRACION.md`.

### Objetivo

Construir la primera version de OpenClaw como operador autonomo nivel 2 con permisos acotados, empezando en modo read-only/dry-run y alineado con el sistema NFC ya existente.

Ajuste tras lectura de repos NFC:

- NFC conserva el motor de envio actual.
- Delivrix/OpenClaw no reemplaza el envio en esta fase.
- Delivrix/OpenClaw provisiona, planifica y gobierna capacidad de infraestructura.
- La integracion inicial debe ser un bridge/API para registrar capacidad compatible con NFC, no un sender paralelo.

### Entregables tecnicos

- Contrato NFC read-only:
  - mapa `nfc-gateway`, `nfc-worker`, `nfc-frontend`.
  - contrato `email_providers`.
  - contrato `smtp_servers`.
  - mapeo de capacidad, limites, reputacion y warming.
- Onboarding inteligente:
  - servidor fisico.
  - Proxmox.
  - pools de IP.
  - dominios.
  - DNS.
  - Postfix/OpenDKIM/TLS.
  - warming inicial.
- Cluster topology planner:
  - plan de VPS/LXC.
  - asignacion IP/dominio.
  - limites por nodo/provider.
  - plan de riesgos.
- Scheduler:
  - health check cada 5 minutos.
  - fleet analysis cada 15 minutos.
  - IP reputation check cada 6 horas.
  - reporte diario.
- Skills iniciales:
  - fleet-ops.
  - alert-ops.
  - report-ops.
- LLM router con modo degradado sin LLM.
- Action executor.
- Dry-run para acciones sensibles.
- Verificacion post-ejecucion.
- Rollback de acciones reversibles.
- Audit log inmutable para toda accion autonoma.
- Presupuesto diario de IA.
- Kill switch probado.
- NFC bridge mock:
  - payload provider SMTP.
  - payload SMTP server.
  - health/reputation sync en simulacion.

### Criterio de salida

- OpenClaw detecta problemas simulados, propone acciones permitidas, registra auditoria, verifica resultado y genera reporte diario.
- Existe un contrato NFC documentado y un bridge mock que no envia emails ni escribe en produccion.
- El onboarding inteligente puede generar un plan de clusters/VPS sin tocar infraestructura real.

## Fase 5: MVP demostrable

Periodo sugerido: 2026-06-01 a 2026-06-07

### Objetivo

Cerrar el MVP como sistema demostrable end-to-end.

### Entregables

- Demo Gateway -> Queue -> Worker -> Sender node -> Result tracking.
- Demo admin panel.
- Demo OpenClaw con incidentes simulados.
- Runbook operativo inicial.
- Matriz de riesgos actualizada.
- Checklist de produccion limitada.

### Criterio de salida

- El sponsor puede ver una operacion controlada, auditable y con ruta clara hacia escalamiento.

## Fase 6: Escalamiento controlado mes 2

Periodo sugerido: junio 2026

### Objetivo

Mover gradualmente hasta 30% del trafico al servidor propio si las metricas lo permiten.

### Metas

- Aproximadamente 30 sender nodes.
- 100,000 a 200,000 correos/dia como capacidad objetivo.
- Webdock conserva 70% del trafico.

### Gates de avance

- Bounce rate bajo umbral definido.
- Complaint rate saludable.
- Sin blacklist critica del bloque.
- OpenClaw con >95% acciones exitosas.
- Rollback probado.
- Backups restaurables.

## Fase 7: Escalamiento controlado mes 3

Periodo sugerido: julio 2026

### Objetivo

Escalar a 100 sender nodes y repartir trafico 50/50 entre Webdock y plataforma propia.

### Metas

- 400,000 a 600,000 correos/dia de capacidad.
- Mejoras a warming, reputacion y reportes.
- Integracion mas completa con metricas por dominio/IP/campana.

### Gates de avance

- Reputacion estable por al menos 2 semanas.
- Complaints bajo limite.
- No mas del 5% de IPs en cuarentena.
- Panel permite diagnostico rapido.

## Fase 8: Escalamiento controlado mes 4

Periodo sugerido: agosto 2026

### Objetivo

Escalar a 200 sender nodes y mover 80% del trafico al servidor propio.

### Metas

- 700,000 a 800,000 correos/dia de capacidad.
- Webdock queda como respaldo activo reducido.
- OpenClaw mejora prediccion, reportes y recomendaciones.

### Gates de avance

- Disponibilidad >99.5%.
- Acciones autonomas exitosas >95%.
- Tiempo humano <30 minutos/dia.
- Sin incidentes sistemicos de bloque IP.

## Fase 9: Volumen objetivo

Periodo sugerido: septiembre 2026

### Objetivo

Alcanzar 1,000,000 correos diarios sostenidos con 300 sender nodes y Webdock como respaldo minimo.

### Metas

- 300 VPS/LXC sender nodes.
- 95-100% trafico en plataforma propia.
- Webdock 0-5% como respaldo.
- Reportes mensuales al sponsor.
- Runbook de continuidad completo.

### Criterio de salida

- La plataforma sostiene volumen objetivo con reputacion saludable, compliance operativo, auditoria completa, backups y respuesta automatizada.

## Plan C

Se activa si ocurre alguno de estos triggers:

- Segundo abuse report de Webdock en menos de 30 dias.
- Suspension total o parcial de Webdock.
- Restricciones operativas que reduzcan capacidad de forma inaceptable.
- Aumento de tarifas mayor al 30% en un mes.

Proveedor documentado como Plan C principal: RackNerd. Antes de contratar, verificar precios, politicas actuales, puerto 25, reputacion y condiciones del proveedor.

## Primer backlog recomendado

1. Crear estructura base del repo.
2. Configurar NestJS, TypeScript, lint y tests.
3. Definir modelos iniciales:
   - users/operators.
   - campaigns.
   - recipients.
   - suppression entries.
   - send jobs.
   - sender nodes.
   - IP addresses.
   - audit events.
4. Implementar Gateway API minimo.
5. Implementar BullMQ producer/worker.
6. Implementar mail policy engine.
7. Implementar audit log append-only.
8. Implementar admin panel base.
9. Implementar WebdockAdapter.
10. Implementar reportes iniciales.

## Riesgos de roadmap

- Si el servidor fisico se retrasa, se debe seguir con software usando mocks/adapters.
- Si IP leasing se retrasa, se mantiene foco en Webdock bridge y simulacion de sender nodes.
- Si ARIN se retrasa, no bloquea MVP.
- Si proveedor o modelo de IA cambia, OpenClaw debe conservar interfaz estable y router intercambiable.
- Si compliance no esta listo, no se aumenta volumen.
