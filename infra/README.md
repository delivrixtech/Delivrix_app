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

## Resetear todo

Esto borra el volumen local `delivrix_postgres_data`.

```bash
npm run db:reset
```

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
REDIS_URL=redis://localhost:6379
```

El gateway usa estos defaults en desarrollo si las variables no existen.
