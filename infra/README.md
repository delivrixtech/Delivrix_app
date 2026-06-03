# Infraestructura local Delivrix

## Levantar BD + Redis

```bash
docker compose -f infra/docker-compose.yml up -d
```

## Levantar full stack containerizado

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up -d
```

El override levanta `gateway-api` en contenedor con writes reales deshabilitados por defecto.

## Migraciones

```bash
npm run db:migrate
```

## Seed datos demo

```bash
npm run db:seed
```

## Seed memoria episodica de revision

Este seed es solo para revisar retrieval grounded B1 en local. No es seed de produccion y se niega a correr con `NODE_ENV=production`, con `POSTGRES_URL` no-local o sin `OPENCLAW_OPERATOR_HMAC_SECRET`.

Flujo minimo para el operador:

```bash
docker compose -f infra/docker-compose.yml up -d
npm run db:migrate
OPENCLAW_OPERATOR_HMAC_SECRET=replace_with_local_review_secret node scripts/db/seed-episodic.mjs
```

El script inserta datos representativos mediante `insertEpisodicEntry`: `verified_fact`, `observation`, distintas `reliability`, hechos invalidados y provenance de operador con HMAC ligado a la fila de memoria. Codex no lo ejecuta contra una BD real; levantar Docker y poblar Postgres queda como accion explicita del operador.

## Resetear todo

Esto borra el volumen local `delivrix_postgres_data`.

```bash
DELIVRIX_CONFIRM_RESET=1 npm run db:reset
```

En una terminal interactiva tambien se puede ejecutar `npm run db:reset` y confirmar escribiendo `RESET`. El script se niega a correr con `NODE_ENV=production`.

## Conexión psql interactiva

```bash
docker exec -it delivrix-postgres psql -U delivrix -d delivrix_mailops
```

## Backup snapshot del volumen

```bash
mkdir -p backups
docker run --rm -v delivrix_postgres_data:/data -v "$(pwd)/backups:/backup" alpine \
  tar czf "/backup/postgres-$(date +%Y%m%d-%H%M).tar.gz" /data
```

## Hostnames OrbStack

- BD: `delivrix-postgres.orb.local:5432`
- Redis: `delivrix-redis.orb.local:6379`
- Gateway: `delivrix-dev-gateway-api.orb.local:3000`

## Variables locales

```bash
POSTGRES_URL=postgres://delivrix:delivrix_dev_password@localhost:5432/delivrix_mailops
POSTGRES_CONTAINER=delivrix-postgres
REDIS_URL=redis://localhost:6379
```

El gateway usa estos defaults en desarrollo si las variables no existen.
Los scripts DB usan el contenedor local cuando `POSTGRES_CONTAINER` apunta al compose local; si `POSTGRES_URL` apunta a un host no local y no se define `POSTGRES_CONTAINER`, ejecutan `psql` directo contra esa URL.
