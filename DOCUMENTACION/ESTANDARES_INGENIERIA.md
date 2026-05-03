# Estandares de ingenieria Delivrix

Fecha: 2026-05-02

## Nivel esperado

Este proyecto debe construirse con criterio senior full-stack. La prioridad no es escribir codigo rapido, sino construir una plataforma mantenible, auditable, segura y preparada para operar con volumen real sin improvisacion.

## Principios no negociables

- Arquitectura modular con limites claros entre dominio, API, worker, infraestructura y adaptadores externos.
- Dominio primero: compliance, suppression list, reputacion, auditoria y politicas deben vivir en reglas explicitas y testeables.
- Adaptadores reemplazables: Webdock, Proxmox, Redis/BullMQ, PostgreSQL, DNS, AWS y OpenClaw no deben contaminar el nucleo de negocio.
- Seguridad por defecto: sin secretos hardcodeados, sin permisos amplios, sin acciones irreversibles sin aprobacion.
- Dry-run antes de efectos reales: todo flujo peligroso se prueba primero en modo seguro.
- Observabilidad desde temprano: logs utiles, audit events, estados de jobs, estados de nodos y razones de bloqueo.
- Pruebas proporcionales al riesgo: policy engine, audit log, queue, suppression list y worker deben tener cobertura antes de escalar.
- Documentacion viva: cada hito debe decir que se hizo, como se ejecuta y que sigue mockeado.

## Criterios de calidad por hito

Un hito no se considera cerrado si no cumple:

- Ejecuta sin errores.
- Tiene una ruta clara de verificacion.
- No rompe los gates de compliance.
- No introduce deuda peligrosa o comportamiento irreversible.
- Mantiene el siguiente adaptador preparado sin obligar a reescribir el dominio.
- Actualiza documentacion relevante.

## Estilo tecnico

- TypeScript estricto.
- Funciones pequenas y nombres claros.
- Validaciones en la frontera de entrada.
- Tipos compartidos en paquetes de dominio.
- Errores explicitos y auditables.
- Infraestructura declarativa cuando aplique.
- Sin acoplar reglas de negocio a frameworks.

## Separacion frontend/backend

El panel visual debe respetar estas reglas:

- El frontend consume endpoints versionados del Gateway; no lee archivos locales ni stores internos.
- El frontend no importa servicios de dominio ejecutables, adaptadores, colas ni persistencia.
- Las reglas de compliance, reputacion, kill switch, permisos OpenClaw y readiness viven en backend/dominio.
- TanStack Query maneja server state; React state maneja solo estado visual local.
- Las mutaciones desde UI requieren autenticacion, autorizacion, motivo humano, auditoria y pruebas E2E.
- Los contratos API deben ser estables, tipados y versionados antes de escalar el panel.
- Los errores deben incluir codigo, razon y severidad para que la UI no adivine.
- El panel inicia `GET-only`; ningun `POST` debe ejecutarse automaticamente al cargar una pagina.
- Las mutaciones futuras deben vivir separadas de las queries de lectura y pasar por gates de seguridad.

## Orden de construccion

1. Dominio y contratos.
2. Tests de reglas.
3. API minima.
4. Cola/worker.
5. Persistencia.
6. Observabilidad.
7. Adaptadores externos.
8. Automatizacion.
9. UI/admin panel.
10. Escalamiento.

## Regla practica

Si una decision podria afectar reputacion, compliance, dinero, infraestructura o volumen, debe tener gate, auditoria y rollback o aprobacion humana.
