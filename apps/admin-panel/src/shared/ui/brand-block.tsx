/**
 * Brand block for the topbar. One-line, sentence case, product tone.
 * Decision 2026-05-16: "Delivrix Admin" sin eyebrow UPPERCASE.
 */

export function BrandBlock() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-8 w-8 place-items-center rounded-[var(--radius-md)] bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] text-[14px] font-medium">
        D
      </div>
      <p className="m-0 text-[15px] font-medium leading-none text-[var(--color-text-primary)]">
        Delivrix Admin
      </p>
    </div>
  );
}
