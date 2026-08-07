// De QUIÉN es el correo que produjo este número.
//
// Por los mismos nodos SMTP pasa el correo de otro producto (otros clientes, que inyectan por
// SMTP 587 con SASL). El clasificador de salud del gateway hace grep de `status=` sobre TODO
// /var/log/mail.log sin filtrar quién inyectó, así que la reputación medida incluye tráfico ajeno.
// Medido el 2026-08-06 en el nodo de annualfiling-infra.com: 269.680 de 279.232 líneas `status=`
// correlacionan con el inyector del otro inquilino y NINGUNA con nuestro warmup — y esa bandeja
// se pinta "umbral cruzado". Sobre esa base se decidió que 36 de 58 nodos están cerrados.
//
// Mientras el gateway no separe por queue-id ↔ sasl_username, la pantalla no puede callarse la
// procedencia. Tres casos, y el tercero es el que importa para el orden de despliegue:
//
//   · modo "nuestro"  → el gateway ya separó: se declara sobre cuántos mensajes nuestros midió.
//   · modo "todo"     → el gateway declara que midió todo el tráfico del nodo.
//   · campo AUSENTE   → el gateway todavía no declara nada. NO se asume "es nuestro": se dice que
//                       la procedencia no está declarada. Así esta pantalla no depende de que el
//                       cambio del backend esté desplegado para ser honesta.

import type { CSSProperties } from "react";

import { Pill } from "./aivora";
import { textoProcedencia, type Atribucion } from "../lib/procedencia";

export { textoProcedencia };
export type { Atribucion };

export function ProcedenciaBadge({
  atribucion,
  style
}: {
  atribucion?: Atribucion | null;
  style?: CSSProperties;
}) {
  const separado = atribucion?.modo === "nuestro";
  return (
    <span style={style}>
      <Pill tone={separado ? "success" : "warning"}>{textoProcedencia(atribucion)}</Pill>
    </span>
  );
}
