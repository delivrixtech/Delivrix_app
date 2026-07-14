/**
 * Skeleton compartido para el Suspense de cada pestaña de los contenedores
 * reorganizados (Envío / Infraestructura / Gobierno).
 */

export function TabFallback() {
  return (
    <section aria-label="Cargando pestaña" className="flex flex-col gap-4">
      <div className="h-6 w-48 animate-pulse rounded-[6px] bg-surface-sunken" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="h-36 animate-pulse rounded-[8px] bg-surface-sunken" />
        <div className="h-36 animate-pulse rounded-[8px] bg-surface-sunken" />
        <div className="h-36 animate-pulse rounded-[8px] bg-surface-sunken" />
      </div>
      <div className="h-64 animate-pulse rounded-[8px] bg-surface-sunken" />
    </section>
  );
}
