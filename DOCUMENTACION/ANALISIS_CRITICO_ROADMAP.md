# Analisis critico del roadmap Delivrix

Fecha: 2026-05-01  
Base: `ROADMAP_PROYECTO.md`, tesis v3.4 y verificacion puntual de fuentes externas.

Norte operativo: `NORTE_OPERATIVO_DELIVRIX.md`. Este analisis debe leerse bajo esa frontera: Delivrix gobierna infraestructura/capacidad y NFC conserva el envio real en la fase actual.

## Veredicto ejecutivo

El roadmap es correcto como direccion estrategica, pero aun no es suficientemente seguro para ejecutarse como calendario rigido. Debe convertirse en un roadmap por gates: se avanza solo cuando se cumplen condiciones verificables, no simplemente porque llego la fecha.

La meta de MVP en 30 dias es viable si el MVP se define como control plane auditable, seguro y de bajo impacto. No es viable interpretar el MVP como capacidad productiva amplia. La meta de 1M correos/dia en septiembre puede ser posible solo si se resuelven de forma comprobada estos cinco frentes:

1. Compliance y autorizacion de destinatarios.
2. Infraestructura fisica real bajo carga.
3. Proveedor/IPs con permiso operativo claro.
4. Reputacion y warming con metricas saludables.
5. OpenClaw gradual, primero observador y luego operador limitado.

## Hallazgos criticos

### 1. "100% seguros" no existe; necesitamos seguridad por gates

Riesgo: el roadmap actual podria leerse como una secuencia garantizada. En realidad hay dependencias externas, reputacion de correo, proveedores, hardware antiguo y cumplimiento legal. Ninguno se controla al 100%.

Correccion: convertir cada fase en Go/No-Go. Si un gate falla, se congela volumen, se mantiene Webdock o se activa contingencia.

Decision recomendada: aprobar el calendario como intencion, pero gobernar ejecucion por gates.

### 2. Compliance debe ser fundacion, no modulo secundario

Riesgo: la tesis menciona CAN-SPAM, pero el roadmap debe obligar desde el primer sprint a construir opt-out, suppression list, headers correctos, direccion fisica, trazabilidad y clasificacion de mensajes. Sin esto, aumentar volumen es inaceptable.

Fuente verificada: la FTC exige, entre otros puntos, headers no enganosos, asuntos no enganosos, identificacion comercial cuando aplique, direccion postal valida, opt-out claro y atencion de bajas dentro de 10 dias habiles. Tambien indica que cada email en infraccion puede generar penalidades.  
Fuente: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business

Correccion al roadmap: Fase 1 debe incluir compliance hard-blocking. Si un job no pasa policy engine, no entra a cola.

Gate: no enviar trafico real fuera de pruebas controladas hasta que existan opt-out, suppression list y auditoria.

### 3. ARIN no debe tratarse como dependencia garantizada de 3-6 meses

Riesgo: la tesis asume ARIN /23 propio como camino paralelo relativamente directo. ARIN informa que su free pool IPv4 se agoto el 24 de septiembre de 2015. Hoy las opciones incluyen waiting list, transferencias o casos reservados. Esto reduce la certeza del /23 en calendario.

Fuentes verificadas:

- ARIN IPv4 options: https://www.arin.net/resources/guide/ipv4/
- ARIN waiting list: https://www.arin.net/resources/guide/ipv4/waiting_list/

Correccion al roadmap: ARIN debe quedar fuera de la ruta critica del MVP y del volumen de septiembre. La ruta critica real es IP leasing/transferencia/proveedor aprobado, con contrato claro.

Gate: no prometer 512 IPs propias ni fecha ARIN sin evidencia formal.

### 4. Plan C con RackNerd no se puede asumir como "comprar y enviar"

Riesgo: el roadmap documenta RackNerd como Plan C principal. Sin embargo, sus terminos prohiben SPAM. Eso no invalida un uso legitimo, pero obliga a obtener aclaracion/permiso por escrito antes de usarlo para alto volumen comercial.

Fuente verificada: RackNerd Terms of Service lista SPAM/SPIM/SPIT como actividad prohibida.  
Fuente: https://www.racknerd.com/terms-of-service

Correccion al roadmap: Plan C debe incluir preaprobacion del proveedor, descripcion del trafico, politica de listas, opt-out, complaint handling y limites.

Gate: ningun proveedor externo se usa para envio comercial hasta tener condiciones aceptadas por escrito.

### 5. El servidor IBM puede ser compatible, pero 128 GB no da margen suficiente para 300 nodos robustos

Riesgo: la tesis dice que 128 GB permite 300 VPS livianos. Puede funcionar con LXC muy ajustado, pero no es una base comoda si cada nodo usa 512 MB, mas Proxmox, PostgreSQL, Redis, Workers, logs, cache, monitoreo y margen de picos.

Fuente verificada: Lenovo indica que el System x3630 M4 tiene 12 DIMM slots y soporta maximos de memoria que dependen del tipo de modulo: hasta 192 GB con RDIMMs y hasta 384 GB con LRDIMMs.  
Fuente: https://lenovopress.lenovo.com/tips1145

Fuente verificada: Proxmox recomienda memoria para el host mas memoria adicional por cada guest, y storage rapido/redundante con SSD recomendado.  
Fuente: https://www.proxmox.com/de/proxmox-ve/systemanforderungen

Correccion al roadmap: 128 GB debe tratarse como capacidad de fase inicial, no como garantia para 300 nodos. Para 300 nodos, exigir benchmark real y considerar 192 GB/384 GB, segundo servidor o menor numero de nodos con mejor arquitectura.

Gate: no pasar de 50 sender nodes sin benchmark de CPU, RAM, I/O, red, temperatura, logs y recuperacion.

### 6. El diseno de 300 VPS debe validarse contra alternativas menos fragiles

Riesgo: 300 VPS/LXC pueden aumentar aislamiento, pero tambien aumentan superficie operativa: logs, claves, DKIM, Postfix, DNS, monitoreo, actualizaciones, fallas y costo cognitivo. Tal vez menos nodos con multiples IPs y colas aisladas por dominio/IP sea mas estable.

Correccion al roadmap: agregar un architecture spike antes de cerrar la topologia final.

Preguntas a responder:

- Cuantas instancias Postfix reales necesitamos para aislar reputacion?
- Que se gana con 300 VPS versus 30-60 nodos bien configurados?
- Donde queda el limite de I/O por logs y colas?
- Cuanto tarda restaurar 50, 100 o 300 nodos?

Gate: topologia final solo despues de pruebas comparativas.

### 7. OpenClaw autonomo en semana 4 es riesgoso si arranca ejecutando acciones reales

Riesgo: el roadmap original podia dejar la impresion de que OpenClaw pasa a ejecutar acciones autonomas al cierre del MVP. Para un sistema de correo a escala, eso es prematuro.

Correccion al roadmap:

- Etapa A: read-only, observa y reporta.
- Etapa B: supervised, propone y humano aprueba.
- Etapa C: autonomia limitada, solo acciones reversibles y de bajo impacto.
- Etapa D: autonomia ampliada tras semanas con precision medida.

Gate: OpenClaw no modifica DNS, nodos ni envio hasta tener audit log, dry-run, verificacion, rollback y kill switch probados.

### 8. La integracion con NFC debe ser por capacidad, no por envio paralelo

Riesgo: despues de leer los repos NFC, queda claro que ese sistema ya tiene gateway, worker, providers, colas, webhooks y envio real. Si Delivrix intenta enviar emails por su cuenta en paralelo durante Fase 4, se duplica responsabilidad, se rompen metricas y aumenta el riesgo reputacional.

Correccion: Delivrix/OpenClaw debe proveer infraestructura, capacidad, health, warming y reputacion. NFC debe conservar el motor de envio mientras se define un contrato formal.

Hallazgos tecnicos a bloquear por gate:

- posible mismatch en `email_providers`: gateway elimina `workerInstanceId`, pero worker todavia lo declara;
- posibles secretos o strings sensibles en documentacion interna de repos de referencia;
- acciones SSH de alto impacto en NFC deben quedar fuera de autonomia inicial;
- credenciales SMTP en texto plano no deben ser aceptadas en produccion.

Gate: antes de escribir en NFC o registrar providers reales, debe existir contrato versionado, bridge mock probado, auditoria y aprobacion humana.

### 9. La politica de "rotar IPs degradadas" debe reformularse

Riesgo: rotar IPs para seguir enviando cuando una IP se degrada puede parecer evasion de reputacion. Eso expone legal, reputacional y contractualmente.

Correccion: si una IP se degrada, la accion principal debe ser pausar, diagnosticar causa, revisar fuente/lista/campana, honrar opt-outs y corregir. Solo reasignar IP despues de resolver causa y con trafico autorizado.

Gate: ninguna rotacion automatica para sostener volumen ante complaints o blacklists. La respuesta automatica debe ser reducir o detener envio.

### 10. Falta explicitar observabilidad de entregabilidad

Riesgo: medir solo "enviado" no sirve. La plataforma necesita trazabilidad por dominio, IP, campana, lista, bounce code, deferred reason, complaint source y opt-out.

Correccion: llevar Gmail Postmaster Tools, Microsoft SNDS/JMRP cuando aplique, bounce parser, complaint ingestion, dashboards por proveedor receptor y alertas.

Gate: no escalar por encima de bajo volumen sin metricas por dominio receptor.

### 11. Single point of failure: servidor fisico unico en Popayan

Riesgo: la estrategia reduce dependencia de proveedores, pero concentra riesgo en un servidor antiguo, una ubicacion, un ISP, energia local, cooling y tunel de red.

Correccion:

- UPS probado.
- Temperatura monitoreada.
- Repuestos minimos: discos, fuentes, cables.
- Backup restaurable.
- Plan de restore en servidor alterno.
- Webdock/Plan C no solo como proveedor, sino como failover probado.

Gate: antes de trafico significativo, ejecutar simulacro de recuperacion.

## Roadmap endurecido recomendado

### Fase 0R: Revision de riesgo antes de desarrollo

Duracion: 2-3 dias.

Entregables:

- Matriz Go/No-Go.
- Compliance checklist.
- Confirmacion escrita o prevalidacion de proveedores.
- Definicion de MVP seguro: bajo volumen, auditable, con Webdock bridge.
- Arquitectura candidata A/B para 300 VPS vs menos nodos.

### Fase 1R: Nucleo seguro

No cambia el foco tecnico, pero cambia la prioridad:

1. Policy engine.
2. Suppression list.
3. Audit log.
4. Gateway.
5. Queue/Worker.
6. Admin panel minimo.

Razon: si compliance y auditoria quedan despues, todo el sistema nace torcido.

### Fase 2R: Envio controlado con Webdock

Solo trafico de prueba o volumen bajo. Medir mas de lo que se envia.

Entregables nuevos:

- Bounce parser.
- Complaint ingestion o registro manual controlado.
- Dashboard por dominio receptor.
- Kill switch probado.

### Fase 3R: Prueba de infraestructura

Antes de crecer:

- Benchmark 10, 30 y 50 nodos.
- Prueba de reinicio masivo controlado.
- Prueba de saturacion de logs.
- Prueba de backup/restore.
- Prueba de temperatura y consumo.

### Fase 4R: OpenClaw read-only

OpenClaw solo observa durante al menos 7 dias operativos o una ventana suficiente de eventos simulados.

### Fase 5R: Autonomia limitada

Acciones permitidas:

- Generar reportes.
- Recomendar pausas.
- Reiniciar servicios en sandbox.
- Pausar un nodo de prueba.

Acciones no permitidas sin humano:

- Cambios globales DNS.
- Cambios que afecten mas del 5% de flota.
- Reasignacion de IP por reputacion.
- Eliminacion de nodos.
- Aumento de volumen.

## Semaforo por frente

- Producto/backend: verde si se construye por capas.
- Compliance: amarillo/rojo hasta implementar policy engine y suppression list.
- Hardware: amarillo hasta benchmark real.
- IP/ARIN: amarillo/rojo hasta contrato o respuesta formal.
- Plan C: amarillo hasta permiso escrito del proveedor.
- OpenClaw: amarillo si empieza read-only; rojo si empieza con autonomia real inmediata.
- Calendario 1M/dia: amarillo/rojo hasta validar IPs, warming, hardware y reputacion.

## Recomendacion final

No buscaria "100% seguridad" prometida; buscaria "no hay avance sin evidencia". Con esa regla, el roadmap se vuelve mucho mas serio:

- Mayo debe entregar plataforma segura y demostrable, no volumen.
- Junio debe validar operacion limitada y reputacion.
- Julio y agosto deben ser meses de escalamiento por evidencia.
- Septiembre solo debe apuntar a 1M/dia si los gates anteriores se cumplieron sin excepciones.
