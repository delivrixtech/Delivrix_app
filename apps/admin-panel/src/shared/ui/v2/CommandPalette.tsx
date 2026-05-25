/**
 * Command Palette v2 (cmd+k / ctrl+k).
 *
 * Modal centrado con search input + lista filtrable de comandos. Patrón
 * Linear / Vercel: navegación con flechas, Enter para ejecutar, Esc para
 * cerrar.
 *
 * Uso:
 *   1. Envolver el árbol con <CommandPaletteProvider commands={...}>.
 *   2. El provider escucha cmd+k / ctrl+k globalmente y abre el modal.
 *   3. Cualquier componente puede abrir manualmente con useCommandPalette().
 *
 * Comandos: array de { id, label, kbd?, group?, action, keywords? }.
 */

import { ArrowRight, Search, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

export interface PaletteCommand {
  /** Único en todo el set. */
  id: string;
  /** Texto principal mostrado en la fila. */
  label: string;
  /** Grupo opcional para mostrar headers separadores. */
  group?: string;
  /** Sufijo opcional tipo "⌘O" o "g h". */
  kbd?: string;
  /** Texto adicional para filtrar (alias, sinónimos). */
  keywords?: string[];
  /** Icon component opcional. */
  icon?: React.ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  /** Callback al ejecutar el comando. Recibe `close()` por si quieres mantener abierto. */
  action: (close: () => void) => void;
}

interface CommandPaletteContextValue {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: boolean;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function CommandPaletteProvider({
  commands,
  children
}: {
  commands: PaletteCommand[];
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  // Listener global cmd+k / ctrl+k. También Esc para cerrar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, toggle, close]);

  // Lock body scroll when open.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({ open, close, toggle, isOpen }),
    [open, close, toggle, isOpen]
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {isOpen ? <PaletteModal commands={commands} close={close} /> : null}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error("useCommandPalette must be inside <CommandPaletteProvider>");
  return ctx;
}

function PaletteModal({
  commands,
  close
}: {
  commands: PaletteCommand[];
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Filtrado simple: matchea label + keywords + group, case-insensitive.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const haystack = [
        c.label,
        c.group ?? "",
        ...(c.keywords ?? [])
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [commands, query]);

  // Reset selected al filtrar.
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Focus input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Navegación con flechas + Enter.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((idx) => Math.min(idx + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((idx) => Math.max(idx - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[selectedIdx];
        if (cmd) cmd.action(close);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selectedIdx, close]);

  // Scroll selected into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLLIElement>(
      `li[data-cmd-idx="${selectedIdx}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Agrupar comandos por group para mostrar headers.
  const grouped = useMemo(() => {
    const map = new Map<string, PaletteCommand[]>();
    for (const cmd of filtered) {
      const g = cmd.group ?? "General";
      const arr = map.get(g) ?? [];
      arr.push(cmd);
      map.set(g, arr);
    }
    return Array.from(map.entries());
  }, [filtered]);

  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Paleta de comandos"
      className="delivrix-palette-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "color-mix(in srgb, var(--color-text-primary) 35%, transparent)",
        backdropFilter: "blur(4px)",
        display: "flex",
        justifyContent: "center",
        paddingTop: "min(20vh, 140px)",
        paddingLeft: 16,
        paddingRight: 16
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="delivrix-palette-modal"
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "min(70vh, 480px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-surface-overlay)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden"
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center"
          style={{
            gap: 10,
            padding: "12px 16px",
            borderBottom: "1px solid var(--color-border)"
          }}
        >
          <Search
            size={16}
            strokeWidth={2}
            aria-hidden="true"
            style={{ color: "var(--color-text-tertiary)" }}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar comando…"
            className="font-[family-name:var(--font-sans)]"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 14,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--color-text-primary)",
              padding: 0
            }}
          />
          <button
            type="button"
            onClick={close}
            aria-label="Cerrar paleta"
            className="inline-flex items-center justify-center transition-colors hover:bg-[var(--color-surface-sunken)]"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              border: "none",
              background: "transparent",
              color: "var(--color-text-tertiary)",
              cursor: "pointer"
            }}
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* List */}
        <ul
          ref={listRef}
          className="m-0 p-0 list-none"
          style={{ flex: 1, overflowY: "auto" }}
        >
          {filtered.length === 0 ? (
            <li
              className="font-[family-name:var(--font-sans)]"
              style={{
                padding: "20px 16px",
                fontSize: 13,
                color: "var(--color-text-tertiary)",
                textAlign: "center"
              }}
            >
              Sin resultados para "{query}".
            </li>
          ) : null}

          {grouped.map(([group, items]) => {
            return (
              <div key={group}>
                <li
                  className="font-[family-name:var(--font-caption)] font-semibold uppercase"
                  style={{
                    padding: "10px 16px 6px 16px",
                    fontSize: 10,
                    letterSpacing: "var(--tracking-widest)",
                    color: "var(--color-text-tertiary)"
                  }}
                  aria-hidden="true"
                >
                  {group}
                </li>
                {items.map((cmd) => {
                  const globalIdx = filtered.indexOf(cmd);
                  const isSelected = globalIdx === selectedIdx;
                  const Icon = cmd.icon;
                  return (
                    <li
                      key={cmd.id}
                      data-cmd-idx={globalIdx}
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setSelectedIdx(globalIdx)}
                      onClick={() => cmd.action(close)}
                      className="flex items-center cursor-pointer transition-colors"
                      style={{
                        gap: 12,
                        padding: "10px 16px",
                        background: isSelected ? "var(--color-surface-sunken)" : "transparent",
                        borderLeft: isSelected ? "2px solid var(--color-accent)" : "2px solid transparent"
                      }}
                    >
                      {Icon ? (
                        <Icon size={14} strokeWidth={1.75} aria-hidden={true} />
                      ) : (
                        <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-text-tertiary)" }} />
                      )}
                      <span
                        className="font-[family-name:var(--font-sans)] truncate"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13,
                          color: "var(--color-text-primary)",
                          fontWeight: isSelected ? 600 : 500
                        }}
                      >
                        {cmd.label}
                      </span>
                      {cmd.kbd ? (
                        <kbd
                          className="font-[family-name:var(--font-mono)]"
                          style={{
                            padding: "2px 6px",
                            background: "var(--color-surface-sunken)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 4,
                            fontSize: 10,
                            color: "var(--color-text-secondary)"
                          }}
                        >
                          {cmd.kbd}
                        </kbd>
                      ) : null}
                    </li>
                  );
                })}
              </div>
            );
          })}
        </ul>

        {/* Footer hints */}
        <div
          className="flex items-center font-[family-name:var(--font-mono)]"
          style={{
            gap: 12,
            padding: "8px 16px",
            borderTop: "1px solid var(--color-border)",
            background: "var(--color-surface-sunken)",
            fontSize: 10,
            color: "var(--color-text-tertiary)"
          }}
        >
          <span>↑↓ navegar</span>
          <span>↵ ejecutar</span>
          <span>esc cerrar</span>
          <span className="flex-1" aria-hidden="true" />
          <span>{filtered.length} comandos</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
