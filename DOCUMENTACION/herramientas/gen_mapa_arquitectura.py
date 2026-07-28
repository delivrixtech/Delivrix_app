#!/usr/bin/env python3
"""Mapa de arquitectura de Delivrix — ESTILO CANONICO.

Todo diagrama de arquitectura del proyecto se entrega en este lenguaje visual: el de los
papers de arquitecturas de transformers (MHA / DeltaNet / Kimi Linear comparados en
paneles). No es decoracion: la familiaridad del formato es lo que lo hace legible de un
vistazo. Es una decision del owner, no una preferencia de quien lo genere.

Reglas del molde (las primitivas de abajo ya las implementan):
  panel()   marco fino redondeado, TITULO AFUERA arriba a la izquierda
  block()   bloque gris interno que envuelve el stack que se repite
  box()     cajita pastel chica con borde fino
  plus()    nodo suma donde las ramas se vuelven a juntar
  line()    polilinea para bypass residual y para fan-out
  expand()  dos diagonales de una caja al panel de zoom
  xn()      "×N" abajo a la derecha, FUERA del bloque gris
  dash=True todo lo punteado significa: todavia no existe

El color significa algo y va con leyenda:
  rosa = escritura con efecto real   verde = lectura sin efecto   violeta = gate/control
  naranja = bloque principal         azul = dato/transporte       amarillo = modelo

Uso:
    python3 DOCUMENTACION/herramientas/gen_mapa_arquitectura.py salida.html

Dos trampas verificadas al modificarlo:
  1. El CSS pisa los atributos de presentacion de SVG. Un text-anchor="start" inline queda
     centrado si la clase dice middle, y el texto se desborda al panel vecino. Por eso
     existe .capL aparte de .cap — se cambia de clase, no de atributo.
  2. Los solapamientos NO se ven leyendo el codigo. Abrirlo en el navegador antes de
     publicarlo.
"""

W, H = 1660, 1030
P = []          # piezas svg
def add(s): P.append(s)

# --- paleta del paper -------------------------------------------------------
YEL  = "#fdeaa8"   # norm
ORA  = "#f8cfa0"   # bloque principal (atencion / agente)
BLU  = "#bcd9f0"   # mlp / salida de datos
GRN  = "#c4e3bf"   # linear / lectura
PNK  = "#f6c3c3"   # conv / escritura
PUR  = "#d9cdea"   # gate
GREY = "#eceff3"   # panel interno
STK  = "#1c1c1c"

def esc(t): return t.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def panel(x, y, w, h, title):
    add(f'<text x="{x}" y="{y-9}" class="ttl">{esc(title)}</text>')
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="11" '
        f'fill="var(--paper)" stroke="var(--stroke)" stroke-width="1.3"/>')

def block(x, y, w, h, dash=False):
    d = ' stroke-dasharray="4 3"' if dash else ''
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="var(--block)" '
        f'stroke="var(--stroke-soft)" stroke-width="0.7"{d}/>')

def box(cx, y, w, h, fill, label, sub=None):
    x = cx - w/2
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="{fill}" '
        f'stroke="var(--stroke)" stroke-width="0.8"/>')
    ty = y + h/2 + (0 if sub is None else -4) + 3.2
    add(f'<text x="{cx}" y="{ty}" class="bx">{esc(label)}</text>')
    if sub:
        add(f'<text x="{cx}" y="{ty+9.5}" class="sb">{esc(sub)}</text>')
    return (cx, y, y + h)

def arrow(x1, y1, x2, y2, dash=False):
    d = ' stroke-dasharray="3 2.5"' if dash else ''
    add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="var(--stroke)" '
        f'stroke-width="0.9" marker-end="url(#ah)"{d}/>')

def line(pts, dash=False):
    d = ' stroke-dasharray="3 2.5"' if dash else ''
    p = " ".join(f"{a},{b}" for a, b in pts)
    add(f'<polyline points="{p}" fill="none" stroke="var(--stroke)" stroke-width="0.9"{d}/>')

def plus(cx, cy):
    add(f'<circle cx="{cx}" cy="{cy}" r="5.6" fill="var(--paper)" stroke="var(--stroke)" stroke-width="0.9"/>')
    add(f'<line x1="{cx-2.9}" y1="{cy}" x2="{cx+2.9}" y2="{cy}" stroke="var(--stroke)" stroke-width="0.9"/>')
    add(f'<line x1="{cx}" y1="{cy-2.9}" x2="{cx}" y2="{cy+2.9}" stroke="var(--stroke)" stroke-width="0.9"/>')

def bypass(cx, y_from, y_to, dx=-999):
    """linea residual que sale, baja por la izquierda y vuelve al nodo suma"""
    line([(cx, y_from), (dx, y_from), (dx, y_to), (cx - 6.4, y_to)])

def xn(x, y, txt):
    add(f'<text x="{x}" y="{y}" class="xn">{esc(txt)}</text>')

def expand(bx1, by1, bx2, by2, zx, zy, zw, zh):
    """dos diagonales de la caja al panel de zoom, como en el paper"""
    add(f'<line x1="{bx2}" y1="{by1}" x2="{zx}" y2="{zy}" stroke="var(--stroke-soft)" stroke-width="0.7"/>')
    add(f'<line x1="{bx2}" y1="{by2}" x2="{zx}" y2="{zy+zh}" stroke="var(--stroke-soft)" stroke-width="0.7"/>')

def io(x, y, txt, up=True):
    add(f'<text x="{x}" y="{y}" class="io">{esc(txt)}</text>')

# ===========================================================================
# PANEL 1 — OpenClaw: crear SMTPs
# ===========================================================================
panel(24, 46, 300, 470, "OpenClaw · crear SMTPs  (Claude, sin cambios)")
block(46, 78, 256, 360)
cx = 174
io(cx, 70, "operador")
arrow(cx, 72, cx, 90)
_,_,b = box(cx, 90, 150, 26, BLU, "chat del panel")
arrow(cx, b, cx, b+14)
_,_,b = box(cx, b+14, 190, 26, ORA, "OpenClawBedrockBridge")
arrow(cx, b, cx, b+14)
_,_,b = box(cx, b+14, 150, 30, YEL, "Claude · Bedrock", "hoy Sonnet 4.6")
arrow(cx, b, cx, b+14)
_,_,b = box(cx, b+14, 160, 26, BLU, "processToolUse")
arrow(cx, b, cx, b+14)
gy = b+14
_,_,b = box(cx, gy, 170, 30, PUR, "ApprovalGate", "firma humana")
arrow(cx, b, cx, b+16)
box(cx, b+16, 190, 30, PNK, "efecto real", "dominio · VPS · DNS")
xn(268, 452, "×1 por acción")
add('<text x="174" y="500" class="cap">único camino que escribe</text>')

# ===========================================================================
# PANEL 2 — Abanico de diagnóstico (M1) + zoom del turno
# ===========================================================================
panel(356, 46, 700, 470, "Abanico de diagnóstico  ·  M1 construido")
block(378, 78, 268, 388)
cx = 512
io(cx, 70, "POST /agents/warmup/audit")
arrow(cx, 72, cx, 90)
_,_,b = box(cx, 90, 176, 30, PUR, "token + rate limit", "3 por minuto")
arrow(cx, b, cx, b+13)
_,_,b = box(cx, b+13, 176, 30, PUR, "kill switch", "fail-closed")
arrow(cx, b, cx, b+13)
_,_,b = box(cx, b+13, 200, 30, BLU, "loadWarmupFleet", "59 dominios")
arrow(cx, b, cx, b+13)
fy = b+13
_,_,b = box(cx, fy, 176, 30, BLU, "runFanOut", "semáforo · 4")
# fan-out a los agentes
fan_y = b + 22
for i, ox in enumerate((-96, -32, 32, 96)):
    line([(cx, b), (cx, b+11), (cx+ox, b+11), (cx+ox, fan_y-4)])
    arrow(cx+ox, fan_y-4, cx+ox, fan_y+1)
ay = fan_y + 4
for i, ox in enumerate((-96, -32, 32, 96)):
    add(f'<rect x="{cx+ox-28}" y="{ay}" width="56" height="26" rx="5" fill="{ORA}" '
        f'stroke="var(--stroke)" stroke-width="0.8"/>')
    lbl = "agente" if i < 3 else "…×59"
    add(f'<text x="{cx+ox}" y="{ay+16}" class="bx">{lbl}</text>')
xn(620, 480, "×59 dominios,  4 a la vez")

# zoom del turno de un agente
zx, zy, zw, zh = 676, 86, 356, 372
add(f'<rect x="{zx}" y="{zy}" width="{zw}" height="{zh}" rx="8" fill="var(--block)" '
    f'stroke="var(--stroke-soft)" stroke-width="0.7"/>')
add(f'<text x="{zx+zw/2}" y="{zy+17}" class="zt">un agente, por dentro</text>')
expand(cx-26, ay, cx+26, ay+26, zx, zy, zw, zh)

zc = zx + zw/2
_,_,b = box(zc, zy+28, 210, 30, YEL, "system prompt del rol", "los 2 modos de falla")
arrow(zc, b, zc, b+12)
ly = b+12
_,_,b = box(zc, ly, 150, 26, ORA, "modelo")
arrow(zc, b, zc, b+12)
# fan-out a las 5 tools
ty = b + 30
xs = [zc-140, zc-70, zc, zc+70, zc+140]
for x in xs:
    line([(zc, b+12), (zc, b+19), (x, b+19), (x, ty-3)])
    arrow(x, ty-3, x, ty+1)
names = ["reach", "reason", "dkim", "mx", "invent"]
for x, n in zip(xs, names):
    add(f'<rect x="{x-30}" y="{ty+4}" width="60" height="24" rx="5" fill="{GRN}" '
        f'stroke="var(--stroke)" stroke-width="0.8"/>')
    add(f'<text x="{x}" y="{ty+19}" class="bx">{n}</text>')
add(f'<text x="{zc}" y="{ty+42}" class="cap">5 tools · todas de lectura</text>')

# retorno al modelo (bucle de turnos) con nodo suma
my = ty + 58
plus(zc, my)
for x in xs:
    line([(x, ty+28), (x, my-14), (zc, my-14)])
line([(zc, my-14), (zc, my-5.6)])
line([(zc+5.6, my), (zc+150, my), (zc+150, ly+13), (zc+76, ly+13)])
arrow(zc+76, ly+13, zc+66, ly+13)
add(f'<text x="{zc+92}" y="{my-6}" class="xn">tool_result  ×6 turnos</text>')
arrow(zc, my+6, zc, my+20)
box(zc, my+20, 200, 30, GRN, "veredicto", "con evidencia archivo:línea")

# ===========================================================================
# PANEL 3 — M2: el cerebro del abanico
# ===========================================================================
panel(1088, 46, 300, 400, "El cerebro del abanico  ·  M2")
block(1110, 78, 256, 236)
cx = 1238
io(cx, 70, "el agente pide pensar")
arrow(cx, 72, cx, 90)
_,_,b = box(cx, 90, 200, 30, BLU, "AgentModelClient", "modelId · invoke()")
arrow(cx, b, cx, b+14)
ty2 = b+14
_,_,b = box(cx, ty2, 214, 34, BLU, "traducción de formato",
            "tool_use ↔ tool_calls")
# dos backends
by = b + 26
for ox in (-64, 64):
    line([(cx, b), (cx, b+13), (cx+ox, b+13), (cx+ox, by-3)])
    arrow(cx+ox, by-3, cx+ox, by+1)
box(cx-64, by+4, 112, 34, YEL, "Mac local", "LM Studio · $0")
box(cx+64, by+4, 112, 34, YEL, "Claude", "Bedrock · respaldo")
xn(1310, 328, "×1 · se elige por rol")
add(f'<text x="1238" y="356" class="cap">la única frontera con un modelo</text>')
add(f'<text x="1238" y="372" class="cap">agents/ no importa nada del bridge</text>')
add(f'<text x="1238" y="388" class="cap">de OpenClaw — son caminos separados</text>')

# ===========================================================================
# PANEL 4 — Fase 3
# ===========================================================================
panel(24, 570, 300, 420, "Delegación  ·  Fase 3  (no existe)")
block(46, 602, 256, 352, dash=True)
cx = 174
io(cx, 594, "tarea del operador")
arrow(cx, 596, cx, 614)
_,_,b = box(cx, 614, 176, 30, YEL, "orquestador", "Claude")
arrow(cx, b, cx, b+13)
_,_,b = box(cx, b+13, 176, 26, BLU, "delegate_to_*")
dy = b + 24
for ox in (-72, 0, 72):
    line([(cx, b), (cx, b+11), (cx+ox, b+11), (cx+ox, dy-3)], dash=True)
    arrow(cx+ox, dy-3, cx+ox, dy+1, dash=True)
for ox, n in ((-72, "dns"), (0, "smtp"), (72, "warmup")):
    add(f'<rect x="{cx+ox-32}" y="{dy+4}" width="64" height="26" rx="5" fill="{ORA}" '
        f'stroke="var(--stroke)" stroke-width="0.8" stroke-dasharray="3 2.5"/>')
    add(f'<text x="{cx+ox}" y="{dy+20}" class="bx">{n}</text>')
py = dy + 46
plus(cx, py)
for ox in (-72, 0, 72):
    line([(cx+ox, dy+30), (cx+ox, py-12), (cx, py-12)], dash=True)
line([(cx, py-12), (cx, py-5.6)], dash=True)
arrow(cx, py+6, cx, py+20, dash=True)
box(cx, py+20, 190, 30, PUR, "QA senior verifica", "antes de pedir firma")
xn(250, 968, "×N seniors")

# ===========================================================================
# PANEL 5 — la decisión abierta
# ===========================================================================
panel(356, 570, 700, 380, "La decisión abierta  ·  costo por corrida de los 59 dominios")
rows = [
    ("Mac local · gpt-oss-20b / Qwen3-30B", "$0", "$0", "¿tool-calling a 6 turnos? sin medir", YEL),
    ("Sonnet 5 + prompt caching",           "$2.78", "$371", "camino conocido", GRN),
    ("Opus 5 + prompt caching",             "$4.63", "$927", "= lo que hoy pagás sin optimizar", GRN),
]
hy = 612
for lbl, x in (("cerebro", 380), ("1 corrida", 700), ("cada 6 h · mes", 800), ("el riesgo", 920)):
    add(f'<text x="{x}" y="{hy}" class="th">{esc(lbl)}</text>')
add(f'<line x1="378" y1="{hy+7}" x2="1034" y2="{hy+7}" stroke="var(--stroke-soft)" stroke-width="0.7"/>')
ry = hy + 30
for lbl, c1, c2, risk, fill in rows:
    add(f'<rect x="378" y="{ry-15}" width="300" height="22" rx="4" fill="{fill}" '
        f'stroke="var(--stroke)" stroke-width="0.7"/>')
    add(f'<text x="386" y="{ry}" class="tdl">{esc(lbl)}</text>')
    add(f'<text x="700" y="{ry}" class="td">{esc(c1)}</text>')
    add(f'<text x="800" y="{ry}" class="td">{esc(c2)}</text>')
    add(f'<text x="920" y="{ry}" class="td">{esc(risk)}</text>')
    ry += 40
notes = [
    "El 71 % del input de una corrida es el mismo prefijo reenviado: system prompt + tool specs,",
    "idénticos en los 6 turnos de los 59 agentes. Cachearlo es −40 % en cualquier modelo — pesa",
    "más que la elección de cerebro.",
    "",
    "La concurrencia 4 la puso la FLOTA, no el modelo: cada agente abre SSH contra un nodo y no",
    "hay pool en ninguna capa de abajo. Los 59 se diagnostican igual, de a 4 por vez.",
]
ny = ry + 6
for n in notes:
    add(f'<text x="378" y="{ny}" class="capL">{esc(n)}</text>')
    ny += 15

# ===========================================================================
# PANEL 6 — leyenda
# ===========================================================================
panel(1088, 500, 300, 420, "Qué dice el color")
ly2 = 536
leg = [
    (BLU, "código determinista", "decide el código"),
    (ORA, "un modelo piensa acá", "agente / bridge"),
    (YEL, "el modelo en sí", "y su prompt"),
    (GRN, "lectura · sin efecto", "no puede romper nada"),
    (PNK, "escritura · efecto real", "compra, provisiona, envía"),
    (PUR, "gate de seguridad", "token, kill switch, firma"),
]
for fill, t, s in leg:
    add(f'<rect x="1110" y="{ly2-11}" width="26" height="16" rx="4" fill="{fill}" '
        f'stroke="var(--stroke)" stroke-width="0.8"/>')
    add(f'<text x="1146" y="{ly2}" class="lg">{esc(t)}</text>')
    add(f'<text x="1146" y="{ly2+12}" class="capL">{esc(s)}</text>')
    ly2 += 40
add(f'<line x1="1110" y1="{ly2-4}" x2="1366" y2="{ly2-4}" stroke="var(--stroke-soft)" stroke-width="0.7"/>')
add(f'<text x="1110" y="{ly2+18}" class="capL">Un panel sin rosa no puede</text>')
add(f'<text x="1110" y="{ly2+33}" class="capL">tocar el mundo real.</text>')
add(f'<text x="1110" y="{ly2+56}" class="capL">Línea punteada = todavía</text>')
add(f'<text x="1110" y="{ly2+71}" class="capL">no existe.</text>')

svg = f'''<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-label="Mapa de arquitectura de los caminos de IA de Delivrix">
  <defs>
    <marker id="ah" viewBox="0 0 8 8" refX="6.4" refY="4" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,1 L6.4,4 L0,7 z" fill="var(--stroke)"/>
    </marker>
  </defs>
  {"".join(P)}
</svg>'''

html = f'''<title>Delivrix · mapa de los caminos de IA</title>

<style>
  :root {{
    --paper: #ffffff;
    --ground: #f2f3f5;
    --block: {GREY};
    --stroke: #1c1c1c;
    --stroke-soft: #9aa3ad;
    --ink: #14181d;
    --ink-2: #59636e;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }}
  /* Se compromete con un solo mundo visual, como el paper de referencia:
     diagrama tecnico sobre papel blanco. En oscuro se atenua el fondo de la
     pagina pero la lamina sigue siendo blanca — igual que un poster impreso. */
  @media (prefers-color-scheme: dark) {{ :root {{ --ground: #14181d; --ink: #e6ebf1; --ink-2: #97a3af; }} }}
  :root[data-theme="dark"] {{ --ground: #14181d; --ink: #e6ebf1; --ink-2: #97a3af; }}
  :root[data-theme="light"] {{ --ground: #f2f3f5; --ink: #14181d; --ink-2: #59636e; }}

  body {{
    margin: 0; padding: clamp(16px, 3vw, 34px);
    background: var(--ground); color: var(--ink);
    font-family: var(--sans);
  }}
  .wrap {{ max-width: 1700px; margin: 0 auto; }}
  h1 {{ font-size: 19px; font-weight: 600; letter-spacing: -0.015em; margin: 0 0 4px; }}
  .sub {{ font-size: 13px; color: var(--ink-2); margin: 0 0 18px; max-width: 74ch; }}
  .sheet {{
    background: var(--paper); border-radius: 12px; padding: 10px;
    overflow-x: auto; box-shadow: 0 1px 3px rgba(0,0,0,.12);
  }}
  svg {{ display: block; min-width: 1240px; width: 100%; height: auto; }}

  text {{ font-family: var(--sans); fill: #1c1c1c; }}
  .ttl {{ font-size: 12.5px; font-weight: 600; }}
  .zt  {{ font-size: 10.5px; font-weight: 600; text-anchor: middle; fill: #4b5560; }}
  .bx  {{ font-size: 9.6px; text-anchor: middle; }}
  .sb  {{ font-size: 8.2px; text-anchor: middle; fill: #4b5560; }}
  .io  {{ font-size: 9px; text-anchor: middle; fill: #4b5560; }}
  .xn  {{ font-size: 9.4px; text-anchor: middle; fill: #4b5560; }}
  .cap {{ font-size: 8.8px; text-anchor: middle; fill: #55606b; }}
  .capL {{ font-size: 8.8px; text-anchor: start; fill: #55606b; }}
  .th  {{ font-size: 8.6px; fill: #6b7681; letter-spacing: .06em; text-transform: uppercase; }}
  .tdl {{ font-size: 9.6px; }}
  .td  {{ font-size: 9.6px; fill: #2a333c; }}
  .lg  {{ font-size: 10px; font-weight: 600; }}
</style>

<div class="wrap">
  <h1>Dónde piensa cada IA, y qué puede tocar</h1>
  <p class="sub">
    Dos caminos de modelo, ya independientes en el código: <code>agents/</code> no importa nada del
    bridge de OpenClaw. Por eso se puede cambiar el cerebro de uno sin tocar el otro.
  </p>
  <div class="sheet">{svg}</div>
</div>
'''

import pathlib, sys
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "mapa-arquitectura.html")
out.write_text(html, encoding="utf-8")
print(f"escrito · {out} · {len(html)} chars · {len(P)} piezas svg")
