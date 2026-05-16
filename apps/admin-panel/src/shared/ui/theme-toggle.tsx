import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./button.tsx";
import { Tooltip } from "./tooltip.tsx";

/**
 * Light/dark toggle. Persists to localStorage with key 'delivrix-admin-theme'.
 * Default is light per Hito 5.10 Fase B decision 2026-05-16.
 * The initial value is set by the inline script in index.html to avoid FOUC.
 */

type Theme = "light" | "dark";
const STORAGE_KEY = "delivrix-admin-theme";

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "dark" ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const next: Theme = theme === "light" ? "dark" : "light";
  const Icon = theme === "light" ? Moon : Sun;
  const hint = theme === "light" ? "Cambiar a modo oscuro" : "Cambiar a modo claro";

  return (
    <Tooltip hint={hint}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={hint}
        onClick={() => setTheme(next)}
      >
        <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}
