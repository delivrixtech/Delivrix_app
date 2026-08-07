// De QUIÉN es el correo que produjo un número. La lógica vive acá, en .ts plano, para que el test
// del gate la pueda importar sin levantar vite (node --test no lee .tsx). El componente que la
// pinta es shared/ui/ProcedenciaBadge.tsx.

/** Espejo de `MedicionBandeja.atribucion` (apps/gateway-api/src/sender-measurement.ts). */
export interface Atribucion {
  modo: "nuestro" | "todo";
  /** Envíos NUESTROS correlacionados por queue-id en la ventana medida. */
  queueIds: number;
  /** Líneas cuyo origen quedó fuera de la rotación de logs. No se reparten: se declaran. */
  descartados: number;
}

export function textoProcedencia(atribucion: Atribucion | null | undefined): string {
  if (!atribucion || (atribucion.modo !== "nuestro" && atribucion.modo !== "todo")) {
    return "procedencia no declarada por el gateway";
  }
  if (atribucion.modo === "todo") {
    return "medido sobre TODO el correo del nodo, incluye el del otro inquilino";
  }
  const nuestros = typeof atribucion.queueIds === "number" ? atribucion.queueIds : null;
  // Los descartados NO se reparten ni se asumen nuestros: se muestran como lo que son.
  const sinAtribuir =
    typeof atribucion.descartados === "number" && atribucion.descartados > 0
      ? ` · ${atribucion.descartados.toLocaleString("es")} sin atribuir`
      : "";
  if (nuestros === null) return `medido solo sobre correo NUESTRO${sinAtribuir}`;
  return `medido sobre ${nuestros.toLocaleString("es")} envíos NUESTROS (correlacionados por queue-id)${sinAtribuir}`;
}
