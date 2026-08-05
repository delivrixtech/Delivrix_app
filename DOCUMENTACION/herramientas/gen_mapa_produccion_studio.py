#!/usr/bin/env python3
"""Mapa de arquitectura — Delivrix en produccion sobre la Mac Studio.

Mismo lenguaje visual canonico que gen_mapa_arquitectura.py (estilo paper).
Ver ese archivo para las reglas del molde y las dos trampas verificadas.

Uso:
    python3 DOCUMENTACION/herramientas/gen_mapa_produccion_studio.py salida.html
"""

W, H = 1660, 1060
P = []
def add(s): P.append(s)

YEL  = "#fdeaa8"
ORA  = "#f8cfa0"
BLU  = "#bcd9f0"
GRN  = "#c4e3bf"
PNK  = "#f6c3c3"
PUR  = "#d9cdea"
GREY = "#eceff3"

def esc(t): return t.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def panel(x, y, w, h, title):
    add(f'<text x="{x}" y="{y-9}" class="ttl">{esc(title)}</text>')
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="11" '
        f'fill="var(--paper)" stroke="var(--stroke)" stroke-width="1.3"/>')

def block(x, y, w, h, dash=False):
    d = ' stroke-dasharray="4 3"' if dash else ''
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="var(--block)" '
        f'stroke="var(--stroke-soft)" stroke-width="0.7"{d}/>')

def box(cx, y, w, h, fill, label, sub=None, dash=False):
    x = cx - w/2
    d = ' stroke-dasharray="3 2.5"' if dash else ''
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="{fill}" '
        f'stroke="var(--stroke)" stroke-width="0.8"{d}/>')
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

def xn(x, y, txt):
    add(f'<text x="{x}" y="{y}" class="xn">{esc(txt)}</text>')

def io(x, y, txt):
    add(f'<text x="{x}" y="{y}" class="io">{esc(txt)}</text>')

# ===========================================================================
# PANEL 1 — la Studio por dentro
# ===========================================================================
panel(24, 46, 380, 470, "La Studio por dentro  ·  el stack en produccion")
cx = 214
io(cx, 70, "encendido / reinicio — sin login de nadie")
arrow(cx, 74, cx, 92)
_,_,b = box(cx, 92, 250, 32, PUR, "launchd", "RunAtLoad + KeepAlive · nativo de macOS")
arrow(cx, b, cx, b+16)

by = b + 16
block(56, by, 316, 250)
add(f'<text x="{cx}" y="{by+18}" class="zt">servicios · /Library/LaunchDaemons</text>')
r1 = by + 30
box(cx-78, r1,      146, 34, ORA, "gateway :3000", "OpenClaw + API")
box(cx+78, r1,      146, 34, BLU, "panel :5173", "UI del operador")
box(cx-78, r1+50,   146, 34, ORA, "warmup daemon", "vueltas + hilos")
box(cx+78, r1+50,   146, 34, ORA, "agente monitor", "consulta a la mini")
box(cx-78, r1+100,  146, 34, ORA, "cupo", "renueva cada 6 h")
box(cx+78, r1+100,  146, 34, BLU, "PostgreSQL 16", "brew · pgvector")
box(cx, r1+152,     220, 30, BLU, "gateway.env + llaves SSH", "solo en disco, 600")
xn(360, by+244, "×6 servicios")

# bucle KeepAlive: del bloque de vuelta a launchd
line([(56, by+120), (40, by+120), (40, 108), (cx-131, 108)])
arrow(cx-131, 108, cx-125, 108)
add('<text x="36" y="332" class="capL" transform="rotate(-90 36 332)">si uno muere → relanzado</text>')

arrow(cx, by+250, cx, by+266)
box(cx, by+266, 250, 32, PUR, "watchdog cada 5 min", "curl /health → kickstart si cuelga")
add(f'<text x="{cx}" y="{by+322}" class="cap">nada corre en screen, terminal ni VS Code</text>')

# ===========================================================================
# PANEL 2 — lo que intenta interrumpir vs lo que lo impide
# ===========================================================================
panel(436, 46, 620, 470, "Todo lo que intenta interrumpir, y que lo impide")
hy = 86
for lbl, x in (("el evento", 470), ("la defensa", 680), ("resultado", 900)):
    add(f'<text x="{x}" y="{hy-8}" class="th">{esc(lbl)}</text>')
add(f'<line x1="458" y1="{hy}" x2="1034" y2="{hy}" stroke="var(--stroke-soft)" stroke-width="0.7"/>')

rows = [
    ("corte de luz",            "Miami + generadores",    "pmset autorestart 1",      "no aplica",            "y si pasara, enciende sola"),
    ("kernel panic / se cuelga","bug del SO",             "restart-on-freeze",        "arriba en ~2 min",     "reinicio automatico"),
    ("un proceso muere",        "bug, OOM",               "launchd KeepAlive",        "relanzado",            "en segundos"),
    ("vivo pero colgado",       "leccion de la flota",    "watchdog /health",         "kickstart",            "a lo sumo 5 min"),
    ("actualizacion de macOS",  "la mas peligrosa",       "automaticas APAGADAS",     "ventana elegida",      "tu decides cuando"),
]
ry = hy + 24
for ev, evs, df, res, ress in rows:
    box(560, ry, 200, 34, PNK, ev, evs if evs else None)
    arrow(662, ry+17, 688, ry+17)
    box(790, ry, 200, 34, PUR, df)
    arrow(892, ry+17, 918, ry+17)
    box(975+ (0), ry, 0+150, 34, GRN, res, ress)
    ry += 52

ny = ry + 14
for t in (
    "Ademas: pmset sleep 0 — la Studio JAMAS se duerme (el modo de falla que hoy mata todo en la laptop).",
    "FileVault OFF en esta maquina: si no, tras cada reinicio espera una contrasena que nadie va a teclear",
    "y NADA arranca. La Studio no viaja: esta fija en el sitio de Miami.",
    "La luz dejo de ser un riesgo: el sitio tiene generadores. Queda como riesgo compartido la RED y",
    "la ubicacion — las dos Macs siguen detras del mismo enlace. Eso lo resuelve Tampa, no un UPS.",
):
    add(f'<text x="458" y="{ny}" class="capL">{esc(t)}</text>')
    ny += 15

# ===========================================================================
# PANEL 3 — red: solo Tailscale
# ===========================================================================
panel(1088, 46, 300, 470, "La red  ·  solo Tailscale, cero internet publico")
cx3 = 1238
io(cx3, 70, "iPhone / MacBook — desde cualquier lugar")
arrow(cx3, 74, cx3, 92)
_,_,b = box(cx3, 92, 220, 32, PUR, "Tailscale", "WireGuard cifrado · 0 puertos abiertos")
arrow(cx3, b, cx3, b+16)
_,_,b = box(cx3, b+16, 230, 36, ORA, "Studio · produccion", "100.87.218.46")
sy = b
# dos salidas: mini y flota
line([(cx3, sy), (cx3, sy+14), (cx3-62, sy+14), (cx3-62, sy+26)])
arrow(cx3-62, sy+26, cx3-62, sy+32)
line([(cx3, sy+14), (cx3+62, sy+14), (cx3+62, sy+26)])
arrow(cx3+62, sy+26, cx3+62, sy+32)
box(cx3-62, sy+34, 116, 40, YEL, "mini", "Qwen3.6 · $0")
_,_,fb = box(cx3+62, sy+34, 116, 40, BLU, "flota 58 nodos", "SSH + SMTP")
arrow(cx3+62, fb, cx3+62, fb+14)
box(cx3+62, fb+14, 130, 36, PNK, "correo real", "Gmail · Yahoo · etc.")
box(cx3, fb+72, 240, 40, ORA, "bastion Tampa · Hivelocity", "colo propio — los proximos SMTPs", dash=True)
ny3 = fb + 136
for t in ("El panel NO se parte con Vercel:",
          "el frontend proxya al gateway y el",
          "gateway guarda llaves de 58 nodos.",
          "Verlo desde internet = entrar al",
          "tailnet, no exponer la maquina."):
    add(f'<text x="1110" y="{ny3}" class="capL">{esc(t)}</text>')
    ny3 += 15

# ===========================================================================
# PANEL 4 — el relevo: que conmuta solo y que exige tu decision
# ===========================================================================
panel(24, 570, 520, 400, "Si la Studio cae  ·  que sigue solo y que te espera a vos")
cx4 = 284
io(cx4, 594, "la Studio deja de responder")
arrow(cx4, 598, cx4, 614)
_,_,b = box(cx4, 614, 200, 30, PNK, "Studio caida")
ys = b + 16
# centros explicitos: con offsets a ojo las cajas se pisaban (el solapamiento no se ve leyendo
# el codigo — hay que abrirlo en el navegador, como dice el molde).
centros = (100, 222, 344, 466)
for cxx in centros:
    line([(cx4, b), (cx4, b+9), (cxx, b+9), (cxx, ys+4)])
    arrow(cxx, ys+4, cxx, ys+9)
box(centros[0], ys+11, 108, 44, GRN, "la flota sigue", "Postfix envia sin la Mac")
box(centros[1], ys+11, 108, 44, YEL, "warmup pausa", "no retrocede")
box(centros[2], ys+11, 108, 44, BLU, "la mini avisa", "3 fallos · 30 min")
box(centros[3], ys+11, 108, 44, PUR, "vos decidis", "nadie conmuta solo")

# el camino humano de activacion, con sus interlocks
ay = ys + 72
arrow(centros[3], ys+55, centros[3], ay-4)
add(f'<text x="{cx4}" y="{ay+2}" class="zt">activar-cerebro.sh  ·  los interlocks</item>'.replace("</item>", "</text>"))
iy = ay + 10
for i, (t, s) in enumerate((
    ("se niega si la Studio responde", "por LAN y por Tailscale"),
    ("pregunta a la flota", "los nodos ven a los dos cerebros"),
    ("reconstruye el dia", "desde los nodos, no del respaldo"),
    ("arranca a MEDIO tope 24h", "ni un split-brain cruza el umbral"),
)):
    box(cx4, iy + i*36, 300, 30, PUR, t, s)
    if i < 3:
        arrow(cx4, iy + i*36 + 30, cx4, iy + (i+1)*36)
xn(462, iy + 74, "~2-5 min,")
xn(462, iy + 87, "con tu OK")

ny4 = iy + 4*36 + 14
for t in (
    "Por que no es automatico: pausar el warmup no cuesta reputacion (solo deja de avanzar), pero DOS",
    "emisores duplican el volumen y pueden cruzar el umbral permanente de Gmail. Con 2 maquinas no hay",
    "arbitro que distinga 'la otra murio' de 'se corto la red': el humano ES el fencing.",
    "Respaldos: repo en GitHub + pg_dump nocturno hacia la mini + gateway.env cifrado.",
):
    add(f'<text x="46" y="{ny4}" class="capL">{esc(t)}</text>')
    ny4 += 14

# ===========================================================================
# PANEL 5 — actualizar sin interrumpir
# ===========================================================================
panel(576, 570, 480, 400, "Actualizar delivrix app  ·  sin parar la produccion")
cx5 = 816
io(cx5, 594, "hay version nueva en produ")
arrow(cx5, 598, cx5, 616)
_,_,b = box(cx5, 616, 240, 32, PUR, "ssh studio (por Tailscale)", "desde donde estes")
arrow(cx5, b, cx5, b+14)
_,_,b = box(cx5, b+14, 240, 32, BLU, "git fetch + merge --ff-only", "misma regla de siempre")
arrow(cx5, b, cx5, b+14)
_,_,b = box(cx5, b+14, 240, 32, PUR, "launchctl kickstart -k", "reinicia solo lo que cambio")
arrow(cx5, b, cx5, b+14)
_,_,b = box(cx5, b+14, 240, 34, GRN, "servicios de vuelta", "corte de SEGUNDOS")
arrow(cx5, b, cx5, b+14)
box(cx5, b+14, 240, 34, GRN, "el daemon retoma", "hilos y cupo donde iban")
ny5 = b + 62
for t in (
    "Los reinicios de segundos son inocuos: la flota ni se entera",
    "(Postfix sigue) y el warmup retoma la vuelta siguiente. Lo",
    "letal era horas muerta porque una laptop se durmio.",
    "",
    "Un proceso largo NO se entera de un commit: sin kickstart",
    "sigue corriendo la version que tenia en memoria.",
    "",
    "El script se NIEGA a desplegar si la laptop todavia tiene",
    "su propio daemon de warmup vivo: serian dos emisores.",
):
    add(f'<text x="598" y="{ny5}" class="capL">{esc(t)}</text>')
    ny5 += 13

# ===========================================================================
# PANEL 6 — leyenda
# ===========================================================================
panel(1088, 570, 300, 400, "Que dice el color")
ly = 606
leg = [
    (PNK, "el evento que interrumpe", "o efecto real hacia afuera"),
    (PUR, "defensa / supervision", "launchd, watchdog, Tailscale"),
    (ORA, "proceso del stack", "lo que tiene que vivir 24/7"),
    (BLU, "dato / transporte", "DB, red, deploy"),
    (GRN, "sigue funcionando solo", "sin intervencion de nadie"),
    (YEL, "el modelo", "Qwen3.6 en la mini"),
]
for fill, t, s in leg:
    add(f'<rect x="1110" y="{ly-11}" width="26" height="16" rx="4" fill="{fill}" '
        f'stroke="var(--stroke)" stroke-width="0.8"/>')
    add(f'<text x="1146" y="{ly}" class="lg">{esc(t)}</text>')
    add(f'<text x="1146" y="{ly+12}" class="capL">{esc(s)}</text>')
    ly += 36
add(f'<line x1="1110" y1="{ly-4}" x2="1366" y2="{ly-4}" stroke="var(--stroke-soft)" stroke-width="0.7"/>')
add(f'<text x="1110" y="{ly+16}" class="capL">Linea punteada = todavia no existe</text>')
add(f'<text x="1110" y="{ly+30}" class="capL">(bastion Tampa: contratado, sin cablear).</text>')
add(f'<text x="1110" y="{ly+54}" class="lg">Arreglado en el camino</text>')
for i, t in enumerate((
    "El lock anti-duplicados duraba ~10 s:",
    "se tomaba sobre el POOL, y pg-pool",
    "cierra los ociosos. Un segundo daemon",
    "podia correr — ya con UNA sola Mac.",
    "Arreglado y verificado contra la base.",
)):
    add(f'<text x="1110" y="{ly+70+i*14}" class="capL">{esc(t)}</text>')

svg = f'''<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-label="Arquitectura de produccion de Delivrix sobre la Mac Studio">
  <defs>
    <marker id="ah" viewBox="0 0 8 8" refX="6.4" refY="4" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,1 L6.4,4 L0,7 z" fill="var(--stroke)"/>
    </marker>
  </defs>
  {"".join(P)}
</svg>'''

html = f'''<meta charset="utf-8">
<title>Delivrix · produccion en la Mac Studio</title>

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
  .lg  {{ font-size: 10px; font-weight: 600; }}
</style>

<div class="wrap">
  <h1>Delivrix en produccion · la Studio que jamas se detiene</h1>
  <p class="sub">
    El cerebro (gateway + warmup + OpenClaw) se muda de la laptop a la Mac Studio como servidor real:
    launchd lo levanta sin que nadie haga login y lo relanza si muere. La flota de 58 nodos nunca
    dependio de una Mac — lo que se blinda aca es el cerebro que la dirige. La mini no queda ociosa:
    es el modelo local, el destino del respaldo y el vigia que mira a la Studio desde afuera.
  </p>
  <div class="sheet">{svg}</div>
</div>
'''

import pathlib, sys
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "mapa-produccion-studio.html")
out.write_text(html, encoding="utf-8")
print(f"escrito · {out} · {len(html)} chars · {len(P)} piezas svg")
