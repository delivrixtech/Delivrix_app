# Runbook — Memoria y verdad: ritual Cipher + Graphify

> **Objetivo:** que la memoria del agente nunca quede sola inventando sobre el código. El grafo
> determinístico (regenerado del AST) es el contrapeso que la aterriza.
> **Fecha:** 2026-07-10 · **Alcance:** Delivrix (aplica a Claude Code y Codex).

La regla vive en `CLAUDE.md` (Claude Code) y `AGENTS.md` (Codex), sección **"Memoria y verdad"**.
Este runbook es el **ritual operativo** que la sostiene. No hay integración automática de fábrica:
son dos herramientas separadas y el pegamento es este ritual, montado una vez.

---

## 1. El reparto (quién guarda qué)

| Herramienta | Guarda | NO guarda |
|---|---|---|
| **Cipher** (memoria) | Decisiones, porqués, preferencias | Qué hace el código (estructura, firmas, dónde está algo) |
| **Graphify** (grafo) | La verdad del código: nodos/relaciones derivados del **AST** | Opiniones, decisiones, historia de por qué |

Consecuencia clave: como Cipher **no** guarda hechos del código, la memoria ni siquiera *puede*
derivar sobre "qué hace el código" — no es su trabajo. Si necesitás saber estructura, se consulta
el grafo, no la memoria.

## 2. Las reglas duras (las que el agente ya tiene en CLAUDE.md/AGENTS.md)

1. Cipher guarda SOLO decisiones, porqués y preferencias. Nunca es fuente de qué hace el código.
2. Graphify es la verdad del código: se regenera del AST, no se equivoca sobre la estructura.
3. Antes de actuar sobre algo que la memoria afirme del código, **verificalo contra el grafo**.
4. Si memoria y grafo se contradicen → **gana el grafo**. Marcá esa memoria como obsoleta y corregila.
5. Cuando algo salga mal, registralo como **lección** (nodo `contested`) con `reflect`, no como
   decisión válida.

## 3. Etiquetado de nodos (el mecanismo que ya trae Graphify)

`graphify reflect` + su overlay etiqueta cada nodo de código con su confianza, y escribe
`LESSONS.md`. El error/anotación queda **pegado al nodo de código real**, no como nota suelta que
después se lee como ley.

| Etiqueta | Significado | Cómo usarla |
|---|---|---|
| `preferred` | Forma validada/canónica de hacer esto | Seguir por default |
| `tentative` | Aún sin validar; podría cambiar | Tratar con cautela, verificar antes de copiar |
| `contested` | Se probó y **no** funcionó / dio problemas | NO repetir; leer la lección antes de tocar |

> Esto es exactamente lo que preocupaba (la "cagada sin etiquetar" que después se lee como verdad):
> queda anclada a la estructura, no flotando en la memoria.

## 4. Ritual de cierre de sesión (checkpoint anti-basura)

Correr al terminar de trabajar, para cazar lo malo **antes** de que se calcifique en "verdad":

```bash
# 1) Destila las lecciones de la sesión (incluido lo que NO funcionó) y actualiza el grafo/overlay.
graphify reflect        # regenera nodos desde el AST + etiqueta preferred/tentative/contested + LESSONS.md

# 2) Limpia o anota lo malo en la memoria: descarta la basura, marca obsoletas, corrige.
brv curate              # revisa Cipher; poda/etiqueta lo que el reflect marcó como contested u obsoleto
```

Orden importa: **primero `reflect`** (fija la verdad del código y las lecciones), **después
`curate`** (alinea la memoria contra esa verdad). Así la memoria nunca "gana" sobre el grafo.

## 5. Flujo durante la sesión (no solo al cierre)

- **Antes de actuar** sobre una afirmación de memoria acerca del código → consultá el grafo. Si el
  grafo no lo confirma, el grafo manda.
- **Si encontrás una contradicción** memoria↔grafo → gana el grafo; marcá la memoria obsoleta y
  corregila en el momento (no lo dejes para el cierre).
- **Si algo sale mal** (un intento que no funcionó) → `graphify reflect` para anclarlo como
  `contested` en el nodo, con la lección; **no** lo guardes en Cipher como si fuera una decisión válida.

## 6. Antipatrones (qué NO hacer)

- ❌ Guardar en Cipher "el archivo X hace Y" / "la función Z está en W" → eso es territorio del grafo.
- ❌ Tratar una nota de memoria vieja como verdad sin cruzarla contra el grafo.
- ❌ Registrar un error como "decisión" en memoria → se lee después como recomendación. Va como
  `contested` en el grafo, con `reflect`.
- ❌ Correr `curate` antes de `reflect` → la memoria quedaría "curada" contra una verdad no actualizada.

## 7. Resumen en una línea

**Cipher decide/prefiere; Graphify es la estructura; ante duda gana el grafo; los errores se anclan
como `contested` con `reflect`; al cerrar sesión `reflect` → `curate` limpia la basura antes de que
se vuelva ley.**
