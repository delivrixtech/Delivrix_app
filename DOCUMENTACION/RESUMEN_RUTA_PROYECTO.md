# Resumen y ruta tecnica del proyecto Delivrix

Fecha de lectura inicial: 2026-05-01  
Documento base: `Tesis_Delivrix_v3.4_BUSINESS_PLAN_MVP.pdf`, version 3.4, 24 abril 2026.

## Lectura ejecutiva

Delivrix plantea construir una plataforma propia de automatizacion de mailing sobre infraestructura controlada por la empresa. La meta documentada es llegar a 1,000,000 correos diarios sostenidos en septiembre de 2026, con un MVP funcional en 30 dias que opere 30-50 VPS virtualizados y un agente operativo llamado OpenClaw.

La tesis no describe solamente una aplicacion web. Describe un sistema operativo completo: infraestructura fisica, virtualizacion, API de orquestacion, colas, base de datos, nodos de envio, DNS, reputacion, observabilidad, backups, agente autonomo, compliance y plan de continuidad.

## Complejidad

Complejidad global: alta.

Razones principales:

- Infraestructura fisica: servidor IBM x3630 M4 antiguo, con upgrade obligatorio de RAM y almacenamiento.
- Virtualizacion masiva: objetivo de hasta 300 VPS/LXC con Postfix/OpenDKIM.
- Operacion progresiva: las IPs nuevas requieren calentamiento por semanas, no se puede escalar de golpe.
- Dependencias externas: IP leasing, ARIN, ISP empresarial, DNS IONOS/Route 53, AWS S3/Secrets, proveedores de respaldo.
- Riesgo operacional: Webdock es puente temporal y tiene riesgo documentado por reporte de abuso.
- Autonomia con IA: OpenClaw ejecuta acciones reales y necesita barandillas, auditoria, rollback y kill switch.
- Compliance: todo flujo debe sostener CAN-SPAM y buenas practicas de correo autorizado.

## Bloques del sistema

1. OpenClaw en Hostinger
   - Scheduler.
   - Skills operativas.
   - LLM router.
   - Action executor.
   - Audit log inmutable.
   - Dry-run, verificacion y rollback.

2. Servidor fisico en Popayan
   - Ubuntu Server 24.04 LTS.
   - Proxmox VE 8.
   - Gateway API.
   - Worker.
   - PostgreSQL.
   - Redis/BullMQ.
   - Pool de VPS/LXC sender nodes.

3. Capa de envio
   - Postfix.
   - OpenDKIM.
   - TLS.
   - SPF/DKIM/DMARC/PTR.
   - Registro de exitos, bounces, complaints y tiempos.

4. Servicios de soporte
   - AWS Route 53 para DNS programatico cuando aplique.
   - AWS Secrets Manager para secretos.
   - AWS S3 para backups.
   - IONOS API para dominios existentes.

5. Continuidad y contingencia
   - Webdock mantiene operacion durante transicion.
   - Plan C con proveedor VPS alternativo si se activan triggers.

## Lectura complementaria de repos NFC

El 2026-05-02 se clonaron como referencia local los repos:

- `National-Filing-Corporation/nfc-gateway`
- `National-Filing-Corporation/nfc-worker`
- `National-Filing-Corporation/nfc-frontend`

La lectura ajusta el entendimiento operativo:

- NFC ya tiene gateway, worker y frontend para operar campanas, proveedores, colas, registros, webhooks y envio.
- Delivrix no debe duplicar ni reemplazar ese envio en la Fase 4.
- OpenClaw debe enfocarse en onboarding inteligente, provision de clusters/VPS, configuracion segura de infraestructura SMTP y monitoreo.
- La integracion correcta es un bridge/API para registrar capacidad creada por Delivrix como providers/SMTP servers compatibles con NFC.
- El documento operativo de este ajuste es `FASE_4_OPENCLAW_NFC_INTEGRACION.md`.

Riesgos detectados en la referencia NFC:

- posible presencia de secretos en documentacion interna, que deben rotarse/removerse si son reales;
- contrato `email_providers` posiblemente desalineado entre gateway y worker por `workerInstanceId`;
- acciones SSH de alto impacto existen y no deben ser invocadas por OpenClaw sin aprobacion humana;
- fallback de credenciales SMTP en texto plano no debe permitirse en produccion.

## Modulos de software a desarrollar

- `gateway-api`: recibe solicitudes, valida autorizacion, politicas, presupuesto, limites y compliance.
- `worker`: procesa jobs desde BullMQ y asigna sender nodes.
- `sender-node-registry`: inventario de VPS, IPs, dominios, estado, reputacion, capacidad y etapa de warming.
- `mail-policy-engine`: limites por dominio/IP/campana, opt-out, suppression list, CAN-SPAM checks y autorizacion.
- `webdock-adapter`: puente con VPS actuales durante transicion.
- `proxmox-adapter`: creacion, pausa, reinicio y estado de VPS/LXC.
- `dns-adapter`: IONOS/Route 53 para registros rutinarios con controles de seguridad.
- `ip-reputation-service`: salud de IPs, bounces, complaints, blacklist status y cuarentena.
- `audit-log`: append-only para acciones humanas y autonomas.
- `rollback-service`: reversa acciones permitidas y escala las irreversibles.
- `admin-panel`: salud de flota, jobs, alertas, aprobaciones, reportes y kill switch.
- `openclaw-agent`: scheduler, skills, LLM router, executor, reportes y escalamiento.
- `observability`: Prometheus/Grafana, logs, metricas de envio, alertas y backups.

## Ruta MVP de 30 dias

### Semana 1: base tecnica

- Inicializar repo y arquitectura NestJS/TypeScript.
- Definir esquema PostgreSQL inicial.
- Configurar Redis/BullMQ.
- Implementar Gateway minimo.
- Implementar audit log append-only.
- Preparar manejo seguro de secretos.
- Crear base del admin panel.
- Preparar checks de compliance desde el inicio: opt-out, suppression list, headers, direccion fisica, trazabilidad.

### Semana 2: pipeline operativo

- Worker procesando jobs.
- Modelo de sender nodes.
- WebdockAdapter para operar los 3 VPS actuales como puente.
- Politicas de rate limit, presupuesto, autorizacion y seguridad.
- Primeros reportes operativos.
- Pruebas end-to-end en entorno controlado.

### Semana 3: infraestructura piloto

- Integracion inicial con Proxmox o mock compatible si el servidor aun no esta listo.
- Primer sender node nuevo registrado.
- Flujo de reputacion/IP y cuarentena.
- DNS rutinario con controles.
- Panel administrativo basico.
- Observabilidad minima: estado, colas, bounces, complaints, errores.

### Semana 4: OpenClaw MVP

- Scheduler.
- Skills iniciales: fleet-ops, alert-ops, report-ops.
- LLM router.
- Action executor con permisos acotados.
- Dry-run, verificacion post-ejecucion y rollback para acciones reversibles.
- Kill switch.
- Reporte diario.
- Demo end-to-end.

## Ruta meses 2-5

- Mes 2: mover 30% del trafico al servidor propio, 30 VPS aproximados.
- Mes 3: 100 VPS y 400k-600k correos/dia.
- Mes 4: 200 VPS y 700k-800k correos/dia.
- Mes 5: 300 VPS y 1M correos/dia, con Webdock como respaldo minimo.

## Decisiones y dependencias pendientes

Segun el cuadro de aprobacion del documento:

- Pendiente: internet empresarial Popayan con IP fija.
- Aprobado con solicitud de documentacion: IP leasing /24 USA.
- Pendiente: tramite ARIN /23 USA propio.
- Aprobado: upgrade servidor IBM.
- Aprobado: calendario de 5 meses.
- Aprobado: Plan C contingente.

Antes de actuar sobre proveedores, precios, modelos de IA o regulacion, verificar informacion actualizada en fuentes oficiales o del proveedor.

## Riesgos principales a vigilar

- Webdock empeora restricciones antes de septiembre.
- El servidor IBM no soporta carga real pese al upgrade.
- IP leased contaminada o inestable.
- Tiempos de ISP/ARIN retrasan la ruta.
- OpenClaw ejecuta accion incorrecta.
- Falta de compliance operacional en campañas reales.
- Costos de API/infraestructura superan barandillas.

## Principios de implementacion

- Construir por capas verificables.
- Mantener continuidad operativa.
- No automatizar decisiones irreversibles sin humano.
- Todo cambio de alto impacto debe tener auditoria, dry-run cuando aplique, verificacion y rollback.
- La plataforma debe servir correo autorizado y conforme a ley, no evasion de controles antiabuso.
- Las metricas de reputacion, bajas, bounces y complaints deben gobernar la capacidad de envio.
