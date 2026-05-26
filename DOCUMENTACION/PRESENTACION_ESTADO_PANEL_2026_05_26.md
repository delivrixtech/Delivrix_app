# Delivrix · Estado del Panel de Control

**Fecha:** martes 26 de mayo de 2026
**Entrega:** viernes 29 de mayo de 2026 (3 días hábiles)
**Audiencia:** dirección Delivrix

---

## En una frase

Delivrix tiene un panel de control operado por humanos y asistido por un agente de inteligencia artificial (OpenClaw), que permite gestionar toda la infraestructura de envío de email desde una sola pantalla, con barandillas de seguridad reales: nada crítico se ejecuta sin aprobación humana explícita.

---

## Resumen para dirección

El panel está organizado en **10 secciones funcionales** que cubren el ciclo completo de operación: desde dar de alta un servidor nuevo, hasta monitorear envíos en producción, hasta apagar todo en caso de emergencia. Cada sección tiene una función específica y todas conversan con el mismo motor de datos (el gateway), de modo que lo que ve el operador es siempre la verdad actual del sistema, no copias desfasadas.

El agente OpenClaw vive dentro del panel y trabaja codo a codo con el operador: investiga, propone, prepara planes y los entrega para aprobación. **Ninguna acción crítica (compra de dominios, deploys, kill switch) se ejecuta sin doble validación humana.** Esto es central al diseño y diferenciador frente a herramientas de competencia.

El **viernes 29 de mayo** vamos a entregar el panel con las 10 secciones operativas y el agente conectado en tiempo real. Tres mejoras quedan en el roadmap inmediato para que Canvas Live se vea espectacular en cada respuesta del agente — Codex está trabajándolas ahora mismo.

---

## Las 10 secciones del panel (lenguaje de negocio)

### 1. Vista general

**Qué hace:** primera pantalla que ve el operador al entrar. Concentra las cuatro métricas críticas de Delivrix (nodos de envío activos, en calentamiento, salud de reputación, decisiones pendientes), el pipeline de envíos en cinco etapas, las aprobaciones que esperan al operador y la salud del sistema en general.

**Por qué importa:** un operador no debería tener que abrir cinco pestañas para saber si su negocio está bien o mal. Esta pantalla responde "¿está todo bien hoy?" en menos de tres segundos.

**Estado:** operativa. Métricas en vivo, datos reales del gateway.

**Mejora para el viernes:** humanizar los identificadores de aprobaciones pendientes (hoy aparecen como `warming_gate` o `dns_drift`; debe decir "Gate de calentamiento" o "Variación DNS").

---

### 2. Onboarding

**Qué hace:** asistente guiado de seis pasos para incorporar un servidor nuevo a Delivrix. Captura identidad del servidor, IPs disponibles, dominios asociados, configuración DNS, límites de envío y permisos. Cuando todos los datos están validados, el operador solicita evaluación al agente y luego firma para activar el servidor.

**Por qué importa:** un servidor mal configurado puede quemar la reputación de toda la flota en 24 horas. El onboarding obliga al operador a recorrer cada validación antes de poner ese servidor en producción.

**Estado:** asistente cableado, botones funcionales. El agente OpenClaw evalúa el servidor cuando se lo piden.

**Mejora para el viernes:** clarificar visualmente que los campos son de solo lectura (hoy parecen editables y confunde). Mostrar el detalle de qué bloquea la evaluación cuando hay impedimentos.

---

### 3. Canvas — espacio del agente OpenClaw

**Qué hace:** es donde el operador conversa con el agente de inteligencia artificial. El chat ocupa la izquierda. La derecha es el "Canvas Live", que muestra visualmente y en tiempo real qué está haciendo el agente: qué tareas tiene activas, qué consulta está haciendo en este segundo, qué propuesta está construyendo. El operador aprueba o rechaza directo desde ahí.

**Por qué importa:** la diferencia entre una IA confiable y una caja negra es **poder ver lo que está pensando y haciendo**. Canvas Live es lo que convierte a OpenClaw de un chatbot en una herramienta operativa que dirección puede defender ante auditoría.

**Estado:** chat en vivo, agente conectado a Bedrock, propuestas generadas con calidad profesional. Canvas Live recibe eventos del agente cuando consulta APIs externas.

**Mejora para el viernes:** **prioridad máxima.** Codex está cableando el agente para que toda respuesta al operador (no solo las que tocan APIs externas) se materialice automáticamente en Canvas Live como artifact visual. Cuando el operador pida "propon comprar X.net", verá aparecer en Canvas Live: la tarea, el archivo guardado, y la propuesta entera lista para aprobar con un click.

---

### 4. Hardware

**Qué hace:** estado físico del servidor: CPU, memoria RAM, almacenamiento, temperatura del procesador, interfaces de red. Historial reciente de las tres métricas críticas. El operador puede solicitar un snapshot manual cuando OpenClaw lo recomienda.

**Por qué importa:** los problemas de hardware son la causa silenciosa de fallos en envío masivo. Detectar temperatura subiendo o disco llenándose antes de que cause un incidente le ahorra a Delivrix horas de downtime.

**Estado:** datos en vivo del recolector. Captura manual funcional.

**Mejora para el viernes:** documentación inline del formato JSON aceptado para snapshots manuales (hoy se explica en línea de ayuda; debería enlazar a un ejemplo completo).

---

### 5. Recolector

**Qué hace:** define qué fuentes alimentan a OpenClaw con datos frescos: logs del hypervisor Proxmox, métricas Prometheus, lectura de archivos del servidor, captura manual de snapshots. Cada fuente tiene su estado (lista, desactualizada, bloqueada).

**Por qué importa:** OpenClaw es tan bueno como los datos que recibe. El recolector garantiza que el agente nunca opere sobre información obsoleta.

**Estado:** fuentes listadas, captura manual operativa, tabla de campos aceptados visible.

**Mejora para el viernes:** indicador horizontal de scroll en la tabla de campos cuando se ve en pantallas pequeñas.

---

### 6. Clústeres

**Qué hace:** mapa de la flota de envío. Cuántos clústeres de servidores SMTP están activos, su salud, su reputación con proveedores externos (Gmail, Outlook, etc.) y su capacidad. Aquí también vive el **Interruptor de Corte** (Kill Switch): un botón que detiene todos los envíos de Delivrix con regla obligatoria de dos personas firmando.

**Por qué importa:** en caso de que algo salga mal (envíos fuera de control, IPs entrando en blacklist, ataque de spam), un operador puede frenar toda la operación en segundos con auditoría completa de quién lo activó y por qué.

**Estado:** vista de clústeres con datos reales. Kill Switch funcional con regla de dos personas.

**Mejora para el viernes:** sincronizar el indicador "actualizado hace X segundos" con el momento real del último fetch (hoy se desfasa). Ajustar tamaño visual del valor del Kill Switch para que se vea consistente con el resto de métricas.

---

### 7. Aprendizaje

**Qué hace:** cómo OpenClaw aprende y mejora. Cuántas habilidades (skills) tiene registradas, qué señales de readiness existen, su precisión actual, cuáles necesitan revisión humana antes de promoverse a producción. Cola de retroalimentación para que el operador entrene al agente.

**Por qué importa:** una IA en producción que no aprende se vuelve obsoleta. Esta sección permite que el equipo de Delivrix vea exactamente qué tan inteligente está siendo el agente y mejorarlo de forma supervisada.

**Estado:** datos en vivo con actualización cada 30 segundos.

**Mejora para el viernes:** copy de estados vacíos más claro (cuando no hay nada en cola, decir "Ninguna lección pendiente" en vez de simplemente vacío).

---

### 8. Seguridad

**Qué hace:** marco de gobierno completo. Roles de acceso (IAM), sesiones activas, secretos del sistema, controles de cumplimiento (privacy, compliance). Incluye una versión grande del Kill Switch con todos los gates de aprobación visibles.

**Por qué importa:** si un cliente, auditor o regulador pregunta "quién tiene acceso a qué y bajo qué condiciones", esta pantalla responde. Es la fotografía de gobernanza que Delivrix puede mostrar ante due diligence.

**Estado:** operativa con actualización en vivo.

**Mejora para el viernes:** sincronizar timer "actualizado hace X" con el momento real del último fetch (mismo bug que Clústeres). Completar tarjetas de cumplimiento (Privacy, Cumplimiento) con datos del contrato (hoy son placeholders).

---

### 9. Infraestructura

**Qué hace:** vista unificada de **todos los proveedores externos** que Delivrix usa. Hostinger (donde vive OpenClaw), Webdock (3 cuentas de VPS), AWS Route53 (DNS + dominios), Porkbun (dominios), IONOS (Cloud DNS), servidor físico propio. Permite gestionar el ecosistema completo desde una sola pantalla sin saltar entre consolas web de cada proveedor.

**Por qué importa:** Delivrix vive en seis proveedores distintos. Sin esta vista, el operador tendría que abrir seis consolas para diagnosticar un problema. Acá lo ve todo de un vistazo.

**Estado:** operativa con datos en vivo de cada proveedor.

**Mejora para el viernes:** robustecer la lógica que identifica cada proveedor por nombre (hoy depende de comparación de strings frágil; debe usar un identificador estable del contrato).

---

### 10. Dominios

**Qué hace:** buscar, evaluar y proponer compra de dominios nuevos para el sender pool. Búsqueda de disponibilidad en tiempo real contra Route53 y Porkbun. Comparación automática de precios. Sugerencias. Listado de dominios propios. Cola de propuestas en espera de aprobación humana (Fase 2 — compra real bloqueada hasta tener doble firma).

**Por qué importa:** registrar dominios para sender pool es operación recurrente. Sin esta sección, el operador tendría que abrir manualmente la consola de cada registrador, comparar precios, y registrar uno por uno. Acá OpenClaw lo prepara todo para que el operador solo apruebe.

**Estado:** operativa con Route53 y Porkbun conectados (Route53 con datos en vivo; Porkbun requiere que el operador agregue las API keys cuando esté listo).

**Mejora para el viernes:** indicador claro de que Fase 2 (compra real) está bloqueada y qué pasos faltan para habilitarla.

---

## Canvas — 5 pestañas internas

El Canvas tiene cinco pestañas que muestran el trabajo del agente desde ángulos distintos:

| Pestaña | Qué muestra | Cuándo la usa el operador |
|---|---|---|
| **Live** | Tareas activas, acción actual del agente, propuestas listas para aprobar | Siempre. Es la vista principal. |
| **Files** | Archivos que el agente lee o escribe en el servidor | Cuando quiere validar qué tocó el agente en disco. |
| **Terminal** | Comandos shell que el agente ejecuta vía SSH | Para auditoría técnica. |
| **Diff** | Cambios propuestos en configuración antes de aplicar | Cuando el agente propone modificar un archivo. |
| **Topología** | Mapa visual de relaciones entre nodos de infraestructura | Para entender dependencias entre servicios. |

**Estado:** Live operativa, recibe eventos reales. Topología renderizada. Files, Terminal y Diff con datos representativos hasta que Codex entregue endpoints definitivos (Bloque 9 en curso).

---

## Cronograma hasta el viernes 29 de mayo

### Miércoles 27 — backend agente completo

Codex termina el "Bloque 9": cada respuesta del agente se materializa automáticamente como artifact visual en Canvas Live, sin importar el tipo de pregunta. Cuando termine, el operador podrá preguntarle cualquier cosa al agente y ver inmediatamente el resultado renderizado a la derecha con botones de aprobar/exportar/copiar según corresponda.

### Jueves 28 — pulido de las 10 secciones

Claude (frontend) aplica las correcciones menores identificadas en la auditoría: humanización de identificadores en Vista general, clarificación de campos de solo lectura en Onboarding, sincronización de timestamps en Clústeres y Seguridad, indicadores faltantes en Recolector y Dominios. Aproximadamente 1 día de trabajo sostenido.

### Viernes 29 — entrega

QA final: recorrer las 10 secciones con datos reales, validar que el agente responde a 6 prompts de prueba distintos y los materializa en Canvas Live, validar Kill Switch con regla de 2 personas, validar exportar reporte a markdown. Push final a `main`. Demo grabada como respaldo.

---

## Qué queda fuera del entregable del viernes

Para no sobre-prometer, dejo explícito lo que **no** está en el alcance de esta entrega:

- **Compra real de dominios (Fase 2):** la infraestructura está, pero la activación requiere doble aprobación operativa que no se va a habilitar antes de que el equipo defina el reglamento interno de aprobaciones.
- **Bridge HTTP/WSS definitivo con Hostinger:** hoy funciona vía SSH tunnel. El bridge HTTP propio se entrega en sprint siguiente.
- **Envíos reales de email:** el panel gestiona la infraestructura. La activación de envíos masivos se hace en hito posterior cuando el sender pool esté warmeado.
- **Compute físico del servidor en Medellín:** está conectado al panel pero el flujo de provisioning automático llega en Hito 6.

---

## Riesgos identificados y mitigación

1. **Codex Bloque 9 se atrasa.** Si el extractor universal de artifacts no está el miércoles, Canvas Live se entrega con la propuesta de compra de dominios funcionando, y el resto de respuestas del agente quedan visibles en el chat aunque no se materialicen visualmente. El operador no pierde funcionalidad — solo pierde la "magia visual" en algunos casos.
2. **API keys de Porkbun pendientes.** Activación live de Porkbun depende de que el operador genere las API keys en porkbun.com. Mitigación: la sección Dominios funciona con Route53 sólo si Porkbun no se activa a tiempo.
3. **Bridge SSH inestable.** Si Hostinger tiene downtime, el chat con OpenClaw deja de funcionar. Mitigación: el resto del panel sigue operativo (las 10 secciones leen del gateway local, no de Hostinger).

---

## Una frase para cerrar la presentación

Delivrix entrega el viernes una plataforma de control con asistencia de inteligencia artificial supervisada, donde cada acción crítica requiere firma humana, donde el operador ve en tiempo real lo que el agente está haciendo, y donde toda decisión queda registrada en una cadena de auditoría inviolable. No es un chatbot con UI bonita — es una herramienta operativa lista para clientes con expectativas de gobierno serio.
