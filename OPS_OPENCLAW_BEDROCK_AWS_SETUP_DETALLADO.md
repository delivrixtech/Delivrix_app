# OPS · Setup AWS Bedrock paso a paso (en español)

> Complemento práctico del `OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK.md`.
> Aterriza con clicks exactos lo que la consola AWS no documenta clarito.
> Cuenta: `Infradelivrix (397450413307)`. Región sugerida: `us-east-1`.

## ⚠️ Alerta sobre lo que está en pantalla ahora

En la pantalla de **Crear política → Revisar y crear** tienes:

```
Servicio: Bedrock
Nivel de acceso: Limitado: Leer
Recurso: Multiple
```

Eso **NO es suficiente**. `Leer` (`bedrock:ListFoundationModels`,
`bedrock:GetFoundationModel`, etc.) solo permite consultar el catálogo
de modelos. Para que OpenClaw use Claude Sonnet 4.6 hace falta
**`bedrock:InvokeModel`** y **`bedrock:InvokeModelWithResponseStream`**,
que están en categoría **Write** dentro de la consola IAM.

**Acción inmediata:** dale a **"Editar"** (botón arriba a la derecha de
la sección "Permisos definidos en esta política") para volver a Paso 1
y arreglar permisos antes de Crear. Sigue §2 de este doc.

## Tabla de contenido

1. Habilitar Model Access en Bedrock (precondición obligatoria)
2. Crear la Policy IAM con los permisos correctos
3. Crear el IAM User y asignar la policy
4. Generar Access Keys para el user
5. Configurar AWS Budget con alertas
6. Configurar BudgetAction (gate automático de costo)
7. Cargar credenciales en OpenClaw
8. Smoke + audit (referencia al playbook principal)

---

## 1. Habilitar Model Access en Bedrock

**Esto va PRIMERO**, antes que la policy. Si lo saltas, la policy
después no sirve porque AWS bloquea el modelo a nivel de cuenta hasta
que aceptas los términos de uso del proveedor (Anthropic).

### Pasos exactos

1. En la barra superior de AWS, confirma región **`Este de EE. UU.
   (Norte de Virginia) us-east-1`** (la tienes correcta según la URL).
2. Buscador AWS arriba → escribir **"Bedrock"** → clic en **Amazon
   Bedrock**.
3. En la página de Bedrock, sidebar izquierdo, busca **"Acceso al
   modelo"** (en inglés: "Model access"). Suele estar al fondo del
   menú.
4. Botón naranja **"Modificar acceso al modelo"** (o "Manage model
   access").
5. Verás la lista de modelos. Busca y marca:
   - ✅ **Anthropic** → **Claude Sonnet 4.6** (o el nombre exacto que
     aparezca: puede ser `Claude Sonnet 4.6 (preview)`, `Claude Sonnet
     4.6`, etc.)
   - ✅ **Anthropic** → **Claude Haiku 4.5** (lo dejamos habilitado por
     si lo usamos después; no cobra mientras no se invoque)
6. Botón **"Siguiente"** abajo a la derecha.
7. AWS te pide aceptar **términos de uso de Anthropic / EULA**.
   - Responde el formulario:
     - **Company name**: tu razón social (o nombre del proyecto si
       prefieres mantenerlo personal). Ej: `Delivrix LLC`.
     - **Website**: el dominio del proyecto si lo tienes; si no, deja
       el de la cuenta personal.
     - **Use case**: pega exactamente esto (versión corta del use case
       que ya te di antes):
       ```
       Internal infrastructure operations assistant. Read-only
       observability agent that monitors our own email-sending
       infrastructure (servers, DNS health, IP reputation, sending
       capacity) and proposes supervised maintenance actions to human
       operators. All actions require human approval. No end-user-
       facing chat. No PII processed.
       ```
   - Marca **"Acepto los términos"**.
8. Botón **"Siguiente"** → **"Enviar"**.
9. Esperar aprobación: para modelos Anthropic en Bedrock suele ser
   **inmediata** (segundos). Refresca la página "Acceso al modelo" hasta
   que veas estatus `Acceso concedido` (en verde) junto a Claude
   Sonnet 4.6.

> Si aparece `En revisión` y no cambia en 5 min, no es bloqueador: puedes
> seguir con §2-§6 mientras tanto y volver a verificar §1 al final.

---

## 2. Crear la Policy IAM correcta

Aquí estás ahora mismo, pero con permisos insuficientes. Vamos a
corregir.

### 2.1 Volver a Paso 1 de la política

1. En la pantalla actual (`Revisar y crear`), botón **"Editar"** en la
   sección "Permisos definidos en esta política".
2. Eso te devuelve a **Paso 1: Especificar permisos**.

### 2.2 Cambiar a vista JSON (lo más rápido y exacto)

La UI visual de IAM es engorrosa para Bedrock. Lo más limpio es pegar
JSON directo.

1. En la parte superior del editor de permisos, hay un toggle
   **"Visual"** / **"JSON"**. Click en **"JSON"**.
2. Borra todo el contenido del editor.
3. Pega **exactamente** este JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DelivrixOpenClawInvokeBedrockModels",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-*",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-*",
        "arn:aws:bedrock:us-east-1:397450413307:inference-profile/us.anthropic.claude-sonnet-4-6-*",
        "arn:aws:bedrock:us-east-1:397450413307:inference-profile/us.anthropic.claude-haiku-4-5-*"
      ]
    },
    {
      "Sid": "DelivrixOpenClawListBedrockModels",
      "Effect": "Allow",
      "Action": [
        "bedrock:ListFoundationModels",
        "bedrock:GetFoundationModel",
        "bedrock:ListInferenceProfiles",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": "*"
    }
  ]
}
```

**Qué hace este JSON:**

- **Statement 1**: permite **invocar** (Write) solo los modelos Claude
  Sonnet 4.6 y Haiku 4.5, tanto el modelo directo como los inference
  profiles `us.*` (cross-region). El comodín `-*` al final del ARN
  cubre las versiones específicas que Anthropic publica (ej:
  `claude-sonnet-4-6-20250514-v1:0`).
- **Statement 2**: permite **listar** modelos disponibles para que
  OpenClaw pueda verificar al boot que el modelo configurado existe.

**No incluye:**
- `bedrock:CreateModel*`, `bedrock:Delete*`, ni nada que modifique
  configuración de Bedrock — solo invocar y leer catálogo.
- Acceso a otros proveedores (Cohere, Meta, Amazon Titan, etc.) — solo
  Anthropic.
- Acceso a otras regiones distintas a `us-east-1`.

4. Botón **"Siguiente"** abajo.

### 2.3 Detalles de la política

Llegas otra vez a **Paso 2: Revisar y crear**, pero ahora con los
permisos correctos.

1. **Nombre de la política**:
   ```
   DelivrixOpenClawBedrockInvoke
   ```
2. **Descripción** (opcional, pero recomendado):
   ```
   Permite a OpenClaw (operations agent) invocar Anthropic Claude
   Sonnet 4.6 y Haiku 4.5 en Bedrock us-east-1, restringido a los
   modelos aprobados por el contrato operativo del Hito 5.11.B.
   No incluye permisos de modificación de Bedrock.
   ```
3. **Sección "Permisos definidos en esta política"** ahora debe mostrar
   2 servicios:
   - Bedrock · Limitado: Leer (`ListFoundationModels`,
     `GetFoundationModel`, etc.)
   - Bedrock · Limitado: Escribir (`InvokeModel`,
     `InvokeModelWithResponseStream`)
4. Botón **"Crear política"** abajo a la derecha.

✅ Policy creada. Anota el nombre (`DelivrixOpenClawBedrockInvoke`)
para el siguiente paso.

---

## 3. Crear el IAM User y asignar la policy

### Pasos

1. Sidebar IAM → **"Usuarios"** → botón **"Crear usuario"**.
2. **Nombre de usuario**:
   ```
   delivrix-openclaw-prod
   ```
3. **NO** marques "Proporcionar acceso a la consola de administración
   de AWS" (este user es de servicio, no humano). Botón **"Siguiente"**.
4. **Establecer permisos**:
   - Opción **"Adjuntar políticas directamente"**.
   - Buscar `DelivrixOpenClawBedrockInvoke` en el filtro.
   - ✅ Marcar la policy.
   - Botón **"Siguiente"**.
5. **Revisar y crear**:
   - Etiquetas (opcional): puedes agregar `Project=Delivrix`,
     `Hito=5.11.B`, `Owner=ops`.
   - Botón **"Crear usuario"**.

✅ User creado. Te lleva de vuelta al listado.

---

## 4. Generar Access Keys

Las Access Keys son las credenciales que OpenClaw usará para llamar
Bedrock. **AWS solo las muestra una vez** — guárdalas en password
manager inmediatamente.

### Pasos

1. Listado de Usuarios → click sobre `delivrix-openclaw-prod`.
2. Pestaña **"Credenciales de seguridad"**.
3. Sección **"Claves de acceso"** → botón **"Crear clave de acceso"**.
4. AWS te pregunta el caso de uso:
   - Selecciona **"Aplicación que se ejecuta fuera de AWS"** (porque
     OpenClaw vive en Hostinger, no en AWS).
5. AWS muestra advertencia recomendando IAM Identity Center. Para MVP
   podemos saltarlo: marca **"Entiendo la recomendación anterior y
   quiero continuar creando una clave de acceso"** y siguiente.
6. **Etiqueta de descripción**:
   ```
   delivrix-openclaw-hostinger-prod-2026-05
   ```
7. Botón **"Crear clave de acceso"**.
8. AWS muestra las dos cadenas:
   - **Access Key ID** (empieza con `AKIA...`, ~20 caracteres)
   - **Secret Access Key** (40 caracteres random)
9. **Acción inmediata**:
   - Click "Mostrar" en Secret Access Key.
   - Copia **ambas cadenas** a tu password manager con el label
     `delivrix-openclaw-hostinger-prod-2026-05`.
   - **NO** las pegues en chat, repo, ni notas planas.
   - **NO** descargues el .csv que ofrece AWS si tu password manager
     no es seguro (el .csv queda en Downloads y se olvida fácil).
10. Botón **"Listo"**.

✅ Access Keys generadas. AWS ya no las muestra otra vez. Si las pierdes
   hay que rotarlas (generar otras nuevas y borrar estas).

---

## 5. Configurar AWS Budget

Esto blinda contra que un bug se gaste USD 10,000 mientras duermes.

### Pasos

1. Buscador AWS arriba → **"Billing"** → click en **AWS Billing and
   Cost Management**.
2. Sidebar izquierdo → **"Budgets"** → botón **"Create budget"**.
3. **Plantilla**: selecciona **"Customize (advanced)"**.
4. **Budget types**: marca **"Cost budget - Recommended"**.
5. Botón **"Siguiente"**.
6. **Detalles del presupuesto**:
   - **Budget name**:
     ```
     delivrix-openclaw-monthly-cap
     ```
   - **Period**: `Monthly`.
   - **Budget renewal type**: `Recurring`.
   - **Start month**: el mes actual.
   - **Budget effective date**: `Recurring budget`.
   - **Budgeting method**: `Fixed`.
   - **Enter your budgeted amount**: `100` USD.
7. **Budget scope**:
   - **Filters** → **Add filter**:
     - Dimension: `Service`
     - Values: marca solo `Amazon Bedrock`
   - Eso garantiza que el budget solo cuenta gasto Bedrock, no toda la
     cuenta AWS.
8. Botón **"Siguiente"**.
9. **Alerts**:
   - Click **"Add alert"** y crear 3 alertas:

     | Alerta | Threshold | Trigger | Email |
     | --- | --- | --- | --- |
     | 1 | 50% | Actual cost > 50% of budget | tu email |
     | 2 | 80% | Actual cost > 80% of budget | tu email |
     | 3 | 95% | Actual cost > 95% of budget | tu email |

   - En cada alerta:
     - **Threshold type**: `Percentage`.
     - **Threshold**: 50 / 80 / 95.
     - **Trigger**: `Actual`.
     - **Notification preferences**: email del operador.
10. Botón **"Siguiente"** → **"Siguiente"** → **"Create budget"**.

✅ Budget creado. Recibirás email cuando el gasto Bedrock cruce 50/80/95%
   del cap mensual.

---

## 6. Configurar BudgetAction (gate automático)

Las alertas de §5 son por email. **BudgetAction** va un paso más allá:
cuando el gasto llega al 95%, AWS **automáticamente** deshabilita la
policy de OpenClaw, deteniendo el gasto sin intervención humana.

> Este paso es opcional pero **muy recomendado**. Si lo saltas, el
> operador es responsable de responder al email de la alerta 95% en
> tiempo. Con BudgetAction, AWS apaga la cosa por ti.

### Pre-requisito: Service Role para BudgetActions

AWS necesita un IAM role especial para que el Budget pueda deshabilitar
policies por ti.

1. IAM → **Roles** → **"Crear rol"**.
2. **Tipo de entidad de confianza**: `AWS service`.
3. **Caso de uso**: busca `Budgets`. Selecciona **"AWS Budgets"** del
   listado y la opción **"Budgets - perform actions in response to alerts"**.
4. Siguiente. AWS recomienda la policy gestionada
   **`AWSBudgetsActionsRolePolicyForResourceAdministrationWithSSM`** —
   adjúntala.
5. Nombre del rol: `DelivrixBudgetActionRole`.
6. Crear rol.

### Crear el BudgetAction

1. Vuelve a **Billing → Budgets → `delivrix-openclaw-monthly-cap`** (el
   que creaste en §5).
2. Pestaña **"Budget actions"** → botón **"Create budget action"**.
3. **Acción**:
   - **IAM role**: selecciona `DelivrixBudgetActionRole`.
   - **Action type**: `Apply IAM policy`.
   - **Policy to apply**: aquí es contraintuitivo. **NO seleccionas la
     policy de OpenClaw**. Seleccionas una policy de "deny everything"
     que se le adjunta al user cuando salta la alerta.
   - Si no tienes una, créala primero (saliendo de este flujo) con este
     JSON:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Deny",
         "Action": "bedrock:*",
         "Resource": "*"
       }]
     }
     ```
     Llámala `DelivrixOpenClawBedrockDeny`. Vuelve al BudgetAction y
     selecciónala.
   - **Identity to apply to**: marca el user
     `delivrix-openclaw-prod`.
4. **Trigger**:
   - **Threshold**: `95`% del budget.
   - **Trigger type**: `Actual`.
5. **Approval**: marca `Automatic` (sin esperar firma manual; el sentido
   del gate es que actúe solo).
6. Botón **"Save action"**.

✅ BudgetAction configurada. Cuando Bedrock cobre USD 95 acumulados en
el mes, AWS automáticamente adjunta `DelivrixOpenClawBedrockDeny` al
user, y todas las llamadas posteriores devuelven 403 hasta que el
operador rote la policy o espere el siguiente mes.

---

## 7. Cargar credenciales en OpenClaw

Tres opciones, en orden de preferencia.

### Opción A — UI de OpenClaw (si soporta provider Bedrock explícito)

1. Túnel SSH activo → navegador → `http://127.0.0.1:61175`.
2. Login con gateway token.
3. **Settings → Providers**:
   - Disable: `nexos`.
   - Enable: `bedrock`.
   - Campos a llenar:
     - **AWS Access Key ID**: la que copiaste en §4 (`AKIA...`).
     - **AWS Secret Access Key**: la otra cadena.
     - **AWS Region**: `us-east-1`.
     - **Model ID**: ve a Bedrock console → Foundation models → busca
       Claude Sonnet 4.6 → botón **"Copy model ID"**. Pega aquí. Será
       algo tipo `anthropic.claude-sonnet-4-6-20250514-v1:0` (la fecha
       puede variar).
     - **Max tokens response**: `4096`.
     - **Temperature**: `0.2`.
4. Save.

### Opción B — Env vars en el container (si la UI no expone Bedrock)

```bash
ssh root@2.24.223.240
# El espacio inicial evita que bash guarde el comando en historial
 export AWS_ACCESS_KEY_ID='AKIA...'
 export AWS_SECRET_ACCESS_KEY='<secret>'
 export AWS_REGION='us-east-1'

docker exec openclaw-dtsf-openclaw-1 sh -c "
  cat > /etc/openclaw/providers.env <<'ENV'
AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_REGION=$AWS_REGION
BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6-20250514-v1:0
BEDROCK_MAX_TOKENS=4096
BEDROCK_TEMPERATURE=0.2
ENV
  chmod 600 /etc/openclaw/providers.env
"

# Limpiar de la sesión bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION
exit
```

> El `chmod 600` deja el archivo solo legible por root del container.

### Verificar antes de continuar

```bash
# Confirmar que el container tiene la env presente, SIN imprimir valores
ssh root@2.24.223.240
docker exec openclaw-dtsf-openclaw-1 env | grep -E '^AWS_|^BEDROCK_' | sed -E 's/(=.*)$/=****/' 
# Salida esperada:
#   AWS_ACCESS_KEY_ID=****
#   AWS_SECRET_ACCESS_KEY=****
#   AWS_REGION=****
#   BEDROCK_MODEL_ID=****
#   BEDROCK_MAX_TOKENS=****
#   BEDROCK_TEMPERATURE=****
```

### Reload del agent

```bash
docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f 'node server.mjs' | head -1)" \
  || docker restart openclaw-dtsf-openclaw-1
sleep 5
docker ps --filter "name=openclaw" --format "{{.Status}}"
```

---

## 8. Smoke + audit (delegar a Codex)

Esta parte la ejecuta Codex siguiendo
`OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK.md` desde el Paso 4:

1. **Smoke 1**: pedirle al agente responder literal
   `PROVIDER_SWITCH_OK_BEDROCK` para validar transport + auth + modelo.
2. **Smoke 2**: pedirle identidad + 5+ gates del norte para validar
   que el system prompt y los docs del workspace cargaron.
3. **Audit**: emitir `oc.provider.switched` en JSONL del worktree.
4. **Notion**: tarjeta Resolved en Bugs & Blockers.
5. **Si falla**: rollback a Nexos (estado conocido) + audit
   `oc.provider.switch_reverted`.

---

## Checklist de cierre (operador firma)

- [ ] §1 Model Access concedido para Anthropic Claude Sonnet 4.6 en
      `us-east-1`.
- [ ] §2 Policy `DelivrixOpenClawBedrockInvoke` creada con JSON
      correcto (`InvokeModel` + `InvokeModelWithResponseStream`).
- [ ] §3 User `delivrix-openclaw-prod` creado con la policy adjunta.
- [ ] §4 Access Keys generadas y guardadas en password manager.
      Marca `delivrix-openclaw-hostinger-prod-2026-05`.
- [ ] §5 Budget `delivrix-openclaw-monthly-cap` USD 100/mes con
      alertas 50/80/95%.
- [ ] §6 (Opcional pero recomendado) BudgetAction al 95% que adjunta
      `DelivrixOpenClawBedrockDeny` al user.
- [ ] §7 Credenciales cargadas en OpenClaw container.
- [ ] §8 Codex ejecuta smokes + audit.

---

## Riesgos comunes y diagnóstico

| Síntoma | Causa probable | Fix |
| --- | --- | --- |
| `AccessDeniedException: You don't have access to the model with the specified model ID` | Model Access no concedido en §1 | Volver a Bedrock console → Model access → habilitar Claude Sonnet 4.6 |
| `AccessDeniedException: User is not authorized to perform: bedrock:InvokeModel` | Policy IAM mal configurada | Revisar §2.2, debe tener `bedrock:InvokeModel` en `Action` (categoría Write) |
| `ValidationException: The provided model identifier is invalid` | Model ID incorrecto | Bedrock console → Foundation models → Claude Sonnet 4.6 → Copy model ID. Pegar exacto en OpenClaw config |
| `ThrottlingException: Too many requests` | Cuota AWS de la región | Esperar 30s y reintentar; si persiste, abrir Service Quota request o cambiar región |
| `Could not load credentials from any providers` | Env vars no presentes en el container | Revisar §7 verificación con `docker exec ... env | grep AWS_` |
| Llega email 50% del Budget en pocas horas | Cron del agente demasiado agresivo | Bajar frecuencia drift-monitor de 5min a 15min; o pasar a estrategia híbrida Sonnet + Haiku (Hito 5.11.C) |

---

## Referencias

- Playbook principal: `OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK.md`
- Contrato: `OPENCLAW_DELIVRIX_API_CONTRACT.md` §6 (secrets)
- Norte: `NORTE_OPERATIVO_DELIVRIX.md`
- Métricas de costo: `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md` §11.3
- AWS Bedrock docs: https://docs.aws.amazon.com/bedrock/latest/userguide/
- AWS Budgets docs: https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html
