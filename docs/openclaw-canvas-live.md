# OpenClaw Canvas Live

Cada respuesta de OpenClaw genera un task y un artifact en Canvas Live, sin excepcion.

El chat sigue mostrando la respuesta textual, pero el gateway tambien materializa esa respuesta como artifact visual. El tipo se infiere del contenido y del prompt del operador:

- `proposal`: propuesta accionable, compra, deploy, config con gates o aprobacion humana.
- `plan`: pasos ordenados, roadmap o implementacion.
- `template`: snippets, configs, DKIM, DMARC o bloques de codigo.
- `report`: analisis, inventario, estado o respuesta conversacional.

Si no hay estructura clara, el fallback obligatorio es `report` con un bloque `paragraph`. No existe una respuesta conversacional que viva solo en chat.

Regla para skills: si una skill responde texto al operador, debe dejar el Canvas con task + artifact. Las skills que ya emiten artifact propio deben marcar el mensaje como materializado para evitar duplicados. Las respuestas genericas se materializan automaticamente en `OpenClawChatProxy` al recibir `ASSISTANT_DONE`.

Guardrail: `proposal` y `plan` son editables y usan aprobacion/rechazo. `report` y `template` son read-only y solo permiten copiar/exportar. Ninguna compra, cambio DNS o accion irreversible se ejecuta desde el artifact sin gates y aprobacion humana.
