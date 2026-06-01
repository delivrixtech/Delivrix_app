import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merger de classes Tailwind utility. Resuelve conflictos (p.ej. dos
 * `bg-*` distintos toman el último). Patrón estándar de shadcn/ui.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
