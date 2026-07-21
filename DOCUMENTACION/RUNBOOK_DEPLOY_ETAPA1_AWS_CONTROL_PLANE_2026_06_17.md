# RUNBOOK — Etapa 1: Control plane de Delivrix en AWS (host PRIVADO)

Fecha: 2026-06-17 · Objetivo: levantar el control plane (gateway + admin + datos) en un host AWS, **privado** (sin exponer a internet todavía). Etapa 2 = hardening (auth/SSO/allowlist). Etapa 3 = DNS `app.delivrix.com` + TLS. **No se expone público hasta la Etapa 2.**

> Recordatorio de arquitectura: el **envío de SMTP NUNCA va en este host** (sigue en Webdock/Contabo). Esto es solo el cerebro/panel → AWS no da de baja un control plane.

## Qué se mueve (verificado en el repo)

- **Datos:** `infra/docker-compose.yml` = Postgres (`pgvector/pgvector:pg16`) + Redis (`redis:7-alpine`). (Hoy en local están down y el gateway corre con fallback `local-file`; en el host conviene levantarlos para no depender del fallback.)
- **Gateway:** proceso Node — `node apps/gateway-api/src/main.ts` (hay además `apps/gateway-api/Dockerfile` si se prefiere contenerizar). Node **24** (corre los `.ts` directo, como en local).
- **Admin:** `npm run serve:admin` (server.mjs, sirve el build + proxea `/v1/*` al gateway).
- **Worker:** `node apps/worker/src/main.ts`.
- Monorepo `delivrix-mailops`, workspaces `apps/*` + `packages/*`.

## 0. Prerequisitos (los hacés vos; yo no toco credenciales ni cuentas AWS)

- Cuenta AWS con acceso a consola/CLI. Región sugerida: **us-east-1** (colocar con Bedrock que ya usás).
- Una **SSH key** para el host.
- Acceso al repo privado `github.com:delivrixtech/Delivrix_app.git` desde el host: **deploy key** (read-only) o PAT. NO subir secretos al repo.
- Tener a mano los archivos de entorno **`config/gateway.env`** y **`.env.local`** (contienen tokens/HMAC/credenciales — NUNCA están en git). Se transfieren al host de forma segura (ver paso 4).

## 1. Provisionar el host

**Opción A — Lightsail (recomendado, mientras tanto):**
- Crear instancia Lightsail: Linux/Ubuntu 22.04 o 24.04, plan **2 GB RAM / 2 vCPU** mínimo (el stack + Postgres pesan), región us-east-1.
- Adjuntar tu SSH key. NO abrir puertos públicos salvo SSH (22).

**Opción B — EC2 (más control):**
- Lanzar EC2 `t3.small` (2 GB) o `t3.medium` (4 GB, recomendado) con Ubuntu, us-east-1.
- **Security Group: solo inbound 22 (SSH) desde TU IP.** NO abrir 3000/5173/80/443 todavía (eso es Etapa 2/3).
- Disco 20-30 GB gp3.

## 2. Preparar el host (Docker + Node 24)

```bash
ssh -i <key.pem> ubuntu@<HOST_IP>
# Docker + compose plugin
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # v24.x
```

## 3. Traer el código

```bash
git clone git@github.com:delivrixtech/Delivrix_app.git delivrix && cd delivrix
# o con PAT: git clone https://<PAT>@github.com/delivrixtech/Delivrix_app.git
npm install
```

## 4. Secretos (CRÍTICO — no van en git)

Transferir los dos archivos de entorno desde tu Mac (NO commitearlos):
```bash
# desde tu Mac:
scp -i <key.pem> "config/gateway.env" ubuntu@<HOST_IP>:~/delivrix/config/gateway.env
scp -i <key.pem> ".env.local"        ubuntu@<HOST_IP>:~/delivrix/.env.local
```
Permisos restrictivos en el host: `chmod 600 ~/delivrix/config/gateway.env ~/delivrix/.env.local`.
Correr el doctor de env para confirmar que no falta nada: `bash scripts/delivrix-env-doctor.sh`.

## 5. Levantar el stack (privado)

```bash
cd ~/delivrix
# datos
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps   # postgres+redis healthy
# migraciones
npm run db:migrate
# gateway (queda en 127.0.0.1:3000 — PRIVADO)
GATEWAY_HOST=127.0.0.1 GATEWAY_PORT=3000 bash scripts/delivrix-gateway-start.sh
# admin (server.mjs; mantenerlo en loopback por ahora)
HOST=127.0.0.1 npm run serve:admin &
# worker
node apps/worker/src/main.ts &
```
Nota: dejá todo en `127.0.0.1` (loopback). NO bindear a `0.0.0.0` hasta la Etapa 2 (hardening), porque el panel tiene Kill Switch + credenciales y no puede estar accesible sin auth.

## 6. Verificar (sin exponer nada)

Desde tu Mac, túnel SSH para alcanzar los servicios privados:
```bash
ssh -i <key.pem> -L 3000:127.0.0.1:3000 -L 8080:127.0.0.1:<admin_port> ubuntu@<HOST_IP>
# en otra terminal / browser:
curl http://127.0.0.1:3000/health     # status ok, postgres/redis ok (ya no local-file)
# abrir http://127.0.0.1:8080 → el panel admin
```
Checklist de Etapa 1 OK: `/health` 200 con postgres+redis `ok`; el panel carga; el inventario responde; nada escuchando en una IP pública (verificar SG/firewall).

## 7. Qué sigue (NO en esta etapa)

- **Etapa 2 — Hardening:** auth/SSO + allowlist de IPs delante del panel/gateway (reverse proxy con auth, o Cloudflare Access / ALB + Cognito). Recién con esto se puede bindear público.
- **Etapa 3 — DNS + TLS:** `app.delivrix.com` → IP del host (Route53 o GoDaddy) + cert TLS (Caddy/nginx + Let's Encrypt o ACM). delivrix.com hoy vive en GoDaddy; se puede apuntar un A record ahí, o delegar la zona a Route53.

## Riesgos / notas
- Costo: Lightsail 2GB ~USD 12/mes; EC2 t3.medium ~USD 30/mes (mientras tanto, ok).
- Persistencia: los volúmenes `postgres_data`/`redis_data` viven en el host; backup antes de cualquier recreación.
- NO abrir 3000/5173/80/443 al mundo en esta etapa. El túnel SSH es suficiente para validar.
- OpenClaw (agente) sigue en Hostinger; este host es el gateway + panel. Si el agente debe pegarle a este gateway, eso se configura en Etapa 2/3 (con la URL pública + auth), no ahora.
