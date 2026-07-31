#!/usr/bin/env bash
# diff-scope.sh — entrada DETERMINISTA para el gate de auditoría multi-agente (skill fabrica-audit).
#
# Emite, en un formato estable y parseable, QUÉ cambió y hay que auditar. El skill lee esto y NO
# tiene que adivinar el alcance: audita exactamente lo que este script lista.
#
# Uso:
#   scripts/audit/diff-scope.sh                 # árbol de trabajo (staged+unstaged) vs HEAD
#   scripts/audit/diff-scope.sh <base>          # <base> vs HEAD  (ej: origin/produ)
#   scripts/audit/diff-scope.sh <base> <head>   # rango <base>..<head>
#
# Salida (en secciones con marcadores === para que el skill las parsee sin ambigüedad):
#   === SCOPE ===        el rango efectivo auditado
#   === FILES ===        archivos de código cambiados (apps/ y packages/, sin tests ni lockfiles)
#   === TESTS ===        archivos de test cambiados (se auditan aparte: ¿protegen las invariantes?)
#   === OTHER ===        el resto que cambió (docs, config) — se lista pero no se audita a fondo
#   === DIFF ===         el diff unificado completo del scope, para que los lentes lean el cambio real

set -euo pipefail
cd "$(dirname "$0")/../.."

BASE="${1:-}"
HEAD_REF="${2:-}"

UNTRACKED=""
if [[ -z "$BASE" ]]; then
  # Sin args: árbol de trabajo vs HEAD (el caso "antes de commitear"). Incluye UNTRACKED: un
  # módulo nuevo sin `git add` era invisible a `git diff` y el gate decía "nada que auditar" —
  # el peor modo de falla de un auditor (verde por no mirar). Ahora se listan y se auditan.
  RANGE_DESC="working tree (staged+unstaged+untracked code) vs HEAD"
  DIFF_ARGS=(HEAD --)
  # Solo untracked bajo apps/ y packages/: ese es el riesgo real (un módulo de código nuevo sin
  # `git add` que quedaría invisible). NO barremos docs/config untracked del resto del repo.
  UNTRACKED=$(git ls-files --others --exclude-standard -- apps packages)
  NAMES=$(printf '%s\n%s\n' "$(git diff --name-only HEAD)" "$UNTRACKED" | sort -u | sed '/^$/d')
elif [[ -z "$HEAD_REF" ]]; then
  RANGE_DESC="${BASE}..HEAD"
  DIFF_ARGS=("${BASE}" HEAD --)
  NAMES=$(git diff --name-only "${BASE}" HEAD)
else
  RANGE_DESC="${BASE}..${HEAD_REF}"
  DIFF_ARGS=("${BASE}" "${HEAD_REF}" --)
  NAMES=$(git diff --name-only "${BASE}" "${HEAD_REF}")
fi

is_test() { [[ "$1" =~ \.(test|spec)\.(ts|tsx|mjs|js)$ ]]; }
is_code() { [[ "$1" =~ ^(apps|packages)/.*\.(ts|tsx|mjs|js)$ ]] && ! is_test "$1"; }

CODE_FILES=(); TEST_FILES=(); OTHER_FILES=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if is_test "$f"; then TEST_FILES+=("$f")
  elif is_code "$f"; then CODE_FILES+=("$f")
  else OTHER_FILES+=("$f"); fi
done <<< "$NAMES"

# Imprime cada elemento en su línea; NADA si el array está vacío (evita la línea en blanco espuria
# que haría que un parser contara "1 archivo vacío" bajo una sección sin archivos).
print_list() { local a; for a in "$@"; do [[ -n "$a" ]] && printf '%s\n' "$a"; done; }

echo "=== SCOPE ==="
echo "$RANGE_DESC"
echo "code_files=${#CODE_FILES[@]} test_files=${#TEST_FILES[@]} other=${#OTHER_FILES[@]}"

echo "=== FILES ==="
print_list "${CODE_FILES[@]:-}"

echo "=== TESTS ==="
print_list "${TEST_FILES[@]:-}"

echo "=== OTHER ==="
print_list "${OTHER_FILES[@]:-}"

echo "=== DIFF ==="
# Untracked no aparecen en `git diff`; se muestran como archivos nuevos completos para que el gate
# los lea igual que un cambio.
git diff "${DIFF_ARGS[@]}"
if [[ -n "$UNTRACKED" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    echo "diff --git a/$f b/$f (UNTRACKED — archivo nuevo, completo)"
    git diff --no-index /dev/null "$f" 2>/dev/null || true
  done <<< "$UNTRACKED"
fi
