# Delivrix — Instrucciones para Claude Code

Este proyecto comparte sus instrucciones con Codex vía `AGENTS.md`. Se importan aquí para que
Claude Code siga las mismas reglas (fuente de verdad, estándares de ingeniería, y la regla de
Memoria y verdad):

@AGENTS.md

## Memoria y verdad

- Cipher (memoria) guarda SOLO decisiones, porqués y preferencias. Nunca es fuente de qué hace el código.
- Graphify (grafo) es la verdad del código: se regenera del AST, no se equivoca sobre la estructura.
- Antes de actuar sobre algo que la memoria afirme del código, verificalo contra el grafo.
- Si memoria y grafo se contradicen → gana el grafo. Marcá esa memoria como obsoleta y corregila.
- Cuando algo salga mal, registralo como lección (nodo "contested") con reflect, no como decisión válida.
