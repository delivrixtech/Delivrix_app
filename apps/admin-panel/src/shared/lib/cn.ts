import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names safely. Resolves conflicts (e.g. last padding wins)
 * and dedupes. Use everywhere instead of plain string concat.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
