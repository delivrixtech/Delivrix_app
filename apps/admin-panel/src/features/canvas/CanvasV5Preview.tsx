/**
 * CanvasV5Preview — Canvas Live type-aware (datos REALES).
 *
 * - Chat real: chatClient + useChatStream (/v1/openclaw/chat).
 * - Runs/ficha en vivo: useLiveCanvasStream → liveRunProgress (con identity de los
 *   cables PR #4). Si no hay runs activos, estado limpio "sin aprovisionamientos".
 * - Logs: GatewayLogTerminal real.
 *
 * Sin datos de muestra. Montaje: App.tsx caso "canvas" por defecto.
 * CanvasV4 queda como rollback temporal via ?canvasv4. Estilos: tokens.css
 * (var(--color-*) / var(--font-*)), scope `.cv5`.
 */
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight, ArrowUp, BadgeCheck, Box, Check, ChevronDown, CircleDollarSign, CheckCircle2,
  Copy, Download, FileText, Globe, Hourglass, Inbox, Key, KeyRound, Loader2,
  Mail, MailCheck, Network, PanelLeftClose, PanelLeftOpen, Paperclip, Plus, Server, ShieldAlert, Sparkles, Square, Terminal, X, XCircle,
  type LucideIcon
} from "lucide-react";
import { chatClient, useChatStream, type ChatConversationSummary, type ChatAttachmentInput } from "../../shared/api/chat-client.ts";

const ACCEPTED_ATTACHMENT_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "text/markdown"]);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 6;

function attachmentMimeOf(file: File): string {
  if (file.type) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return "";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}
import { useLiveCanvasStream } from "./canvas-live-client.ts";
import { SMTP_BUILD_STEPS, type LiveRunProgress } from "./smtp-live-progress.ts";
import { GatewayLogTerminal } from "./gateway-log-terminal.tsx";
import { usePendingOpenClawProposals, PendingOpenClawApprovalPanel } from "./PendingApprovalGate.tsx";
import { MarkdownText } from "../../shared/ui/v2/MarkdownText.tsx";
import { useConsumeIntentOnMount, useOpenClawIntent } from "../../shared/ui/v2/OpenClawIntent.tsx";
import { useToast } from "../../shared/ui/v2";
import { downloadSmtpCredential } from "../../shared/api/smtp-credentials.ts";
import { Card, SectionHead, DataTable, Pill, Button } from "../../shared/ui/aivora/index.tsx";
import type { LiveArtifact, CanvasLiveArtifactKindWire, CanvasLiveArtifactPayloadWire } from "./live-tool-types.ts";

/** Puertos SMTP estándar (constantes etiquetadas, no valores derivados por ternario muerto). */
const SMTP_SUBMISSION_PORT = 587;
const SMTP_SMTPS_PORT = 465;

type Tab = "run" | "logs";

const STYLE = `
.cv5{height:100%;display:flex;flex-direction:column;overflow:hidden;container-type:inline-size;container-name:cv5;
  --bg:var(--color-surface-sunken);--s1:var(--color-surface);--s2:var(--color-surface-raised);--s3:var(--color-accent-soft);
  --line:var(--color-border);--line2:var(--color-border-strong);
  --t1:var(--color-text-primary);--t2:var(--color-text-secondary);--t3:var(--color-text-tertiary);--t4:var(--color-text-disabled);
  --acc:var(--color-accent);--accfg:var(--color-accent-fg);
  --ok:var(--color-success);--okS:var(--color-success-soft);--okB:var(--color-success-border);
  --info:var(--color-info);--infoS:var(--color-info-soft);--infoB:var(--color-info-border);
  --warn:var(--color-warning);--warnS:var(--color-warning-soft);--warnB:var(--color-warning-border);
  --err:var(--color-critical);--errS:var(--color-critical-soft);--errB:var(--color-critical-border);
  --disp:var(--font-heading);--mono:var(--font-mono);
  background:var(--bg);color:var(--t1);font-size:14px}
.cv5 *{box-sizing:border-box}
.cv5 .main{flex:1;display:flex;min-height:0}
.cv5 .col{display:flex;flex-direction:column;min-height:0}
@keyframes cv5spin{to{transform:rotate(360deg)}}
@keyframes cv5beat{0%{box-shadow:0 0 0 0 var(--okB)}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}
.cv5 .spin{animation:cv5spin 1.3s linear infinite}
.cv5 .dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.cv5 .beat{animation:cv5beat 1.8s infinite}

.cv5 .chat{width:600px;flex:0 1 600px;min-width:0;border-right:1px solid var(--line);background:var(--bg)}
.cv5 .chead{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px}
.cv5 .collapse{margin-left:auto;width:28px;height:28px;border-radius:7px;background:none;border:1px solid transparent;color:var(--t3);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
.cv5 .collapse:hover{background:var(--s1);color:var(--t1);border-color:var(--line)}
.cv5 .reopen{width:30px;height:30px;border-radius:7px;background:var(--s2);border:1px solid var(--line2);color:var(--t2);display:flex;align-items:center;justify-content:center;cursor:pointer;margin-right:12px;flex:0 0 auto}
.cv5 .reopen:hover{background:var(--s3);color:var(--t1)}
.cv5 .convos{width:350px;flex:0 1 350px;min-width:0;border-right:1px solid var(--line2);background:var(--bg);display:flex;flex-direction:column;min-height:0}
.cv5 .cvhead{display:flex;align-items:center;gap:9px;padding:14px 14px 10px}
.cv5 .cvttl{font-family:var(--disp);font-weight:600;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--t3);flex:1}
.cv5 .cvnew{width:28px;height:28px;border-radius:7px;background:var(--s1);border:1px solid var(--line2);color:var(--t2);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
.cv5 .cvnew:hover{background:var(--s2);color:var(--t1)}
.cv5 .cvlist{flex:1;overflow:auto;padding:4px 8px 10px;display:flex;flex-direction:column;gap:2px}
.cv5 .cvempty{color:var(--t4);font-size:12px;padding:14px 8px;line-height:1.5}
.cv5 .conv{display:block;width:100%;text-align:left;border:1px solid transparent;background:none;border-radius:9px;padding:9px 10px;cursor:pointer;font:inherit}
.cv5 .conv:hover{background:var(--s1)}
.cv5 .conv.on{background:var(--s2);border-color:var(--line2)}
.cv5 .convt{font-size:13px;color:var(--t1);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv5 .chead .ic{width:26px;height:26px;border-radius:7px;background:var(--s2);border:1px solid var(--line2);display:flex;align-items:center;justify-content:center;color:var(--t2);flex:0 0 auto}
.cv5 .chead .nm{font-family:var(--disp);font-weight:600;font-size:14px}
.cv5 .chead .sub{font-size:11px;color:var(--t3);display:flex;align-items:center;gap:6px}
.cv5 .cbody{flex:1;overflow:auto;padding:20px 18px;display:flex;flex-direction:column;gap:18px}
.cv5 .cempty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;color:var(--t3);padding:30px}
.cv5 .cempty .ii{width:46px;height:46px;border-radius:11px;background:var(--s1);border:1px solid var(--line2);display:flex;align-items:center;justify-content:center;color:var(--t3)}
.cv5 .cempty .h{font-family:var(--disp);font-size:14px;color:var(--t2)}
.cv5 .cempty .p{font-size:12.5px;max-width:280px;line-height:1.55}
.cv5 .msg{display:flex;flex-direction:column;gap:5px;max-width:92%}
.cv5 .role{font-size:10px;color:var(--t4);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.cv5 .bub{padding:13px 16px;border-radius:11px;font-size:13.5px;line-height:1.7;border:1px solid var(--line);background:var(--s1);white-space:pre-wrap;word-break:break-word}
.cv5 .msg{max-width:420px}
.cv5 .msg.wide{max-width:640px}
.cv5 .bub.md{white-space:normal}
.cv5 .bub.md>div>:first-child{margin-top:0}.cv5 .bub.md>div>:last-child{margin-bottom:0}
.cv5 .msg.op{align-self:flex-end;align-items:flex-end}
.cv5 .msg.op .bub{background:var(--s2);border-color:var(--line2)}
.cv5 .cinput{border-top:1px solid var(--line);padding:12px;background:var(--s1)}
.cv5 .field{display:flex;align-items:center;gap:8px;background:var(--s2);border:1px solid var(--line2);border-radius:10px;padding:9px 11px}
.cv5 .field:focus-within{border-color:var(--color-border-focus)}
.cv5 .field input{flex:1;background:none;border:none;outline:none;color:var(--t1);font:inherit;font-size:13px}
.cv5 .field input::placeholder{color:var(--t4)}
.cv5 .send{width:30px;height:30px;border-radius:8px;background:var(--acc);color:var(--accfg);border:none;display:flex;align-items:center;justify-content:center;flex:0 0 auto;cursor:pointer}
.cv5 .send:disabled{opacity:.4;cursor:not-allowed}
.cv5 .send.stop{background:var(--s3);color:var(--t1);border:1px solid var(--line2)}
.cv5 .send.stop:hover{color:var(--err);border-color:var(--errB)}
.cv5 .attach{width:30px;height:30px;border-radius:8px;background:none;border:none;color:var(--t3);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
.cv5 .attach:hover{color:var(--t1)}
.cv5 .chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.cv5 .chip{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--t2);background:var(--s2);border:1px solid var(--line);border-radius:7px;padding:4px 7px;max-width:220px}
.cv5 .chip b{font-family:var(--disp);font-size:9px;letter-spacing:.04em;color:var(--info);background:var(--infoS);border:1px solid var(--infoB);border-radius:4px;padding:1px 5px;flex:0 0 auto}
.cv5 .chip .cnm{font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv5 .chip .cx{background:none;border:none;color:var(--t4);cursor:pointer;display:flex;padding:0;flex:0 0 auto}
.cv5 .chip .cx:hover{color:var(--err)}
.cv5 .cvcollapse{width:26px;height:26px;border-radius:7px;background:none;border:1px solid transparent;color:var(--t3);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
.cv5 .cvcollapse:hover{background:var(--s1);color:var(--t1);border-color:var(--line)}

.cv5 .view{flex:1;display:flex;flex-direction:column;min-width:400px;background:var(--bg)}
.cv5 .tabs{display:flex;align-items:center;gap:2px;padding:0 24px;height:46px;flex:0 0 46px;border-bottom:1px solid var(--line);background:var(--s1)}
.cv5 .tab{display:flex;align-items:center;gap:7px;height:46px;padding:0 13px;color:var(--t3);font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;position:relative;top:1px;background:none;border-left:none;border-right:none;border-top:none;font-family:inherit}
.cv5 .tab .cnt{font-size:11px;color:var(--t3);background:var(--s2);border:1px solid var(--line);border-radius:5px;padding:0 5px;line-height:16px}
.cv5 .tab:hover{color:var(--t1)}.cv5 .tab.on{color:var(--t1);border-bottom-color:var(--acc)}
.cv5 .tab .li{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ok);background:var(--okS);border:1px solid var(--okB);border-radius:5px;padding:0 5px;line-height:15px}
.cv5 .pchip{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;color:var(--t3);background:var(--s2);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
.cv5 .abar{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--bg)}
.cv5 .abar .kick{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--t4);font-weight:600;display:flex;align-items:center;gap:6px}
.cv5 .rswbtn{display:inline-flex;align-items:center;gap:9px;background:var(--s2);border:1px solid var(--line2);border-radius:9px;padding:7px 11px;cursor:pointer;color:var(--t1);font:inherit;margin-top:5px}
.cv5 .rswbtn:hover{background:var(--s3)}.cv5 .rswbtn svg{color:var(--t3);flex:0 0 auto}
.cv5 .rswdom{font-family:var(--mono);font-size:12.5px;color:var(--t1)}
.cv5 .rswcnt{font-family:var(--mono);font-size:11px;color:var(--t3);background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:0 6px}
.cv5 .rswback{position:fixed;inset:0;z-index:40}
.cv5 .rswmenu{position:absolute;top:calc(100% + 7px);left:0;width:320px;background:var(--s2);border:1px solid var(--line2);border-radius:12px;padding:6px;z-index:41;box-shadow:var(--shadow-lg)}
.cv5 .rswitem{display:flex;align-items:center;gap:11px;width:100%;background:none;border:none;border-radius:9px;padding:9px 10px;cursor:pointer;font:inherit;text-align:left}
.cv5 .rswitem:hover{background:var(--s3)}.cv5 .rswitem.on{background:var(--s1)}
.cv5 .rswid{flex:1;min-width:0}.cv5 .rswid b{display:block;font-size:12.5px;color:var(--t1);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv5 .rswid span{display:block;font-size:11px;color:var(--t3);font-family:var(--mono);margin-top:2px}
.cv5 .stt{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;height:25px;padding:0 11px;border-radius:999px}
.cv5 .stt.running{color:var(--ok);background:var(--okS);border:1px solid var(--okB)}
.cv5 .stt.failed{color:var(--err);background:var(--errS);border:1px solid var(--errB)}
.cv5 .stt.done{color:var(--t2);background:var(--s2);border:1px solid var(--line2)}
.cv5 .scroll{flex:1;overflow:auto;min-height:0}
.cv5 .art{padding:28px 32px 56px;max-width:1180px;width:100%;margin:0 auto}
.cv5 .runwrap{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:32px;align-items:start}
@media (max-width:1120px){.cv5 .runwrap{grid-template-columns:1fr;gap:24px}}
.cv5 .rmain{min-width:0}.cv5 .rside{display:flex;flex-direction:column;gap:12px;min-width:0}
.cv5 .hero{display:flex;align-items:flex-start;gap:16px;padding-bottom:20px;border-bottom:1px solid var(--line)}
.cv5 .hero .icn{width:44px;height:44px;border-radius:12px;background:var(--s2);border:1px solid var(--line2);display:flex;align-items:center;justify-content:center;color:var(--t1);flex:0 0 auto}
.cv5 .hero h1{font-family:var(--disp);font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1.1;margin:0;word-break:break-word}
.cv5 .meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.cv5 .tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;height:25px;padding:0 10px;border-radius:8px;background:var(--s1);border:1px solid var(--line);color:var(--t2);font-family:var(--mono)}
.cv5 .tag .i{color:var(--t3);display:flex}
.cv5 .rgt{margin-left:auto;text-align:right;display:flex;flex-direction:column;gap:7px;align-items:flex-end;flex:0 0 auto}
.cv5 .prog{font-family:var(--mono);font-size:13px;color:var(--t2)}.cv5 .prog b{color:var(--t1)}
.cv5 .pbar{height:5px;border-radius:999px;background:var(--s2);overflow:hidden;margin:18px 0 2px}
.cv5 .pbar i{display:block;height:100%;background:var(--warn);border-radius:999px}
.cv5 .chk{color:var(--ok);display:inline-flex;align-items:center}
.cv5 .sec{margin-top:28px}
.cv5 .sech{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.cv5 .sech h2{font-family:var(--disp);font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--t3);margin:0}
.cv5 .sech .n{font-size:11px;color:var(--t4);margin-left:auto;font-family:var(--mono)}
.cv5 .step{display:flex;align-items:center;gap:13px;padding:9px 0;position:relative}
.cv5 .step .sic{width:21px;height:21px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border:1px solid var(--line2);background:var(--s1);z-index:2;color:var(--t4)}
.cv5 .step.done .sic{color:var(--ok);border-color:var(--okB)}
.cv5 .step.act .sic{width:27px;height:27px;background:var(--warnS);border:1.5px solid var(--warn);color:var(--warn);box-shadow:0 0 0 4px var(--warnS)}
.cv5 .step.fail .sic{color:var(--err);border-color:var(--errB);background:var(--errS)}
.cv5 .step .ln{position:absolute;left:10px;top:16px;bottom:-9px;width:1px;background:var(--line);z-index:1}.cv5 .step.act .ln{left:13px}
.cv5 .step .snm{flex:1;font-size:13px;color:var(--t1)}.cv5 .step.pend .snm{color:var(--t4)}.cv5 .step.act .snm{font-weight:500}
.cv5 .du{font-family:var(--mono);font-size:11.5px;color:var(--t3);flex:0 0 auto}.cv5 .step.act .du{color:var(--warn)}.cv5 .step.pend .du{color:var(--t4)}
.cv5 .dns{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.cv5 .dnsh,.cv5 .drow{display:grid;grid-template-columns:60px 1fr 30px;gap:12px;align-items:center;padding:11px 13px}
.cv5 .dnsh{background:var(--s1);border-bottom:1px solid var(--line);font-weight:600;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--t3)}
.cv5 .drow{border-bottom:1px solid var(--line);font-family:var(--mono);font-size:12px}.cv5 .drow:last-child{border-bottom:none}
.cv5 .ty{font-size:10px;font-weight:600;text-align:center;color:var(--info);background:var(--infoS);border:1px solid var(--infoB);border-radius:6px;padding:3px 0;font-family:var(--disp)}
.cv5 .dnm{color:var(--t1);min-width:0}.cv5 .dnm b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cv5 .dnm span{color:var(--t3);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.cv5 .cp{width:27px;height:27px;border-radius:6px;border:1px solid var(--line);background:var(--s1);color:var(--t3);cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto}.cv5 .cp:hover{color:var(--t1)}
.cv5 .deliv{display:flex;align-items:center;gap:14px;background:var(--s1);border:1px solid var(--line2);border-radius:10px;padding:15px 16px}
.cv5 .deliv .big{width:40px;height:40px;border-radius:9px;background:var(--okS);display:flex;align-items:center;justify-content:center;color:var(--ok);flex:0 0 auto}
.cv5 .deliv .info .t{font-weight:500;font-size:14px}.cv5 .deliv .info .s{color:var(--t3);font-size:12px;font-family:var(--mono);margin-top:3px}
.cv5 .empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:50px;color:var(--t3)}
.cv5 .empty .ei{width:60px;height:60px;border-radius:15px;background:var(--s1);border:1px solid var(--line2);display:flex;align-items:center;justify-content:center;color:var(--t3)}
.cv5 .empty .eh{font-family:var(--disp);font-size:18px;color:var(--t1);font-weight:600}
.cv5 .empty .ep{font-size:13.5px;max-width:420px;line-height:1.6}
.cv5 .empty .ecode{font-family:var(--mono);font-size:12px;background:var(--s1);border:1px solid var(--line);border-radius:7px;padding:8px 12px;color:var(--t2)}
.cv5 .connpill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-family:var(--mono);color:var(--t3);background:var(--s1);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
.cv5 .kbadge,.cv5 .abar .kick .kb{display:inline-flex}
.cv5 .atitle{font-family:var(--disp);font-size:15px;color:var(--t1);font-weight:600;margin-top:5px;max-width:560px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv5 .seg{display:inline-flex;background:var(--s2);border:1px solid var(--line2);border-radius:8px;padding:2px;flex:0 0 auto}
.cv5 .seg button{height:25px;padding:0 13px;border:none;background:none;color:var(--t3);font:inherit;font-size:12px;font-weight:500;border-radius:6px;cursor:pointer}
.cv5 .seg button.on{background:var(--s3);color:var(--t1)}
.cv5 .raw{font-family:var(--mono);font-size:12px;color:var(--t2);background:var(--s1);border:1px solid var(--line);border-radius:10px;padding:16px;white-space:pre-wrap;word-break:break-word;line-height:1.6}

/* ── Responsive < lg: apilar canvas a 1 columna (convos → chat → vista/logs).
   El corte mide el ANCHO DEL CANVAS (@container sobre .cv5), no el viewport, para
   descontar el sidebar de empuje (~256px) del Shell y no recortar el panel .view. ── */
@container cv5 (max-width:1023px){
  .cv5 .main{flex-direction:column;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch}
  .cv5 .convos{width:100%;flex:0 0 auto;max-height:220px;border-right:none;border-bottom:1px solid var(--line2)}
  .cv5 .chat{width:100%;flex:0 0 auto;height:70vh;height:70dvh;border-right:none;border-bottom:1px solid var(--line)}
  .cv5 .view{width:100%;flex:0 0 auto;min-width:0;min-height:70vh;min-height:70dvh}
  .cv5 .cbody,.cv5 .cvlist,.cv5 .scroll{-webkit-overflow-scrolling:touch}
  .cv5 .cbody{padding:16px 14px}
  .cv5 .field input{font-size:16px}
  .cv5 .tabs{padding:0 12px}
  .cv5 .abar{padding:12px 14px;flex-wrap:wrap}
  .cv5 .art{padding:20px 16px 40px}
  .cv5 .rswmenu{width:min(320px,calc(100vw - 32px))}
}
`;

function relTime(ts: string): string {
  const d = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(d) || d < 0) return "ahora";
  const s = Math.floor(d / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  return `hace ${Math.floor(m / 60)}h`;
}

function fmtDur(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** Tile de dato lateral sobre Card Aivora (radius 18 + hairline + shadow). Reemplaza `.stat`. */
function StatTile({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <Card style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: 8 }}>
        <Icon size={13} /> {label}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: 7, wordBreak: "break-all" }}>
        {children}
      </div>
    </Card>
  );
}

const PENDING = <span style={{ color: "var(--color-text-disabled)" }}>pendiente</span>;

/** Pill de estado sobre el primitivo Aivora (reemplaza `.badge`). */
function StatusPill({ status, tone }: { status: string; tone?: "success" | "critical" | "neutral" }) {
  const resolved = tone ?? (statusBadgeClass(status) === "ok" ? "success" : statusBadgeClass(status) === "bad" ? "critical" : "neutral");
  return <Pill tone={resolved}>{status}</Pill>;
}

function LiveTimeline({ run }: { run: LiveRunProgress }) {
  return (
    <>
      {SMTP_BUILD_STEPS.map((def) => {
        const live = run.steps.get(def.step);
        let cls = "pend";
        let ic: ReactNode = <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "block" }} />;
        if (live?.status === "ready") { cls = "done"; ic = <Check size={12} />; }
        else if (live?.status === "error") { cls = "fail"; ic = <X size={12} />; }
        else if (live?.status === "in_progress") { cls = "act"; ic = <Loader2 size={14} className="spin" />; }
        const dur = fmtDur(live?.durationMs);
        return (
          <div key={def.step} className={`step ${cls}`}>
            <div className="sic">{ic}</div><span className="ln" />
            <span className="snm">{def.label}</span>
            <span className="du">{cls === "act" ? def.eta : cls === "pend" ? def.eta : dur || "·"}</span>
          </div>
        );
      })}
    </>
  );
}

function RunFicha({ run, runId }: { run: LiveRunProgress; runId: string }) {
  const id = run.identity;
  const domain = id?.domain ?? runId;
  const total = SMTP_BUILD_STEPS.length;
  const done = run.lastCompletedStep || 0;
  const pct = `${Math.round((done / total) * 100)}%`;
  const stCls = run.runStatus === "failed" ? "failed" : run.runStatus === "completed" ? "done" : "running";
  return (
    <div className="runwrap">
      <div className="rmain">
        <div className="hero">
          <div className="icn">{run.runStatus === "failed" ? <XCircle size={22} /> : run.runStatus === "completed" ? <MailCheck size={22} /> : <Mail size={22} />}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SectionHead
              eyebrow="Run"
              title={domain}
              subtitle={(id?.providerId || id?.smtpHost) ? (
                <div className="meta">
                  {id?.providerId ? <span className="tag"><span className="i"><Server size={13} /></span>{id.providerId}</span> : null}
                  {id?.smtpHost ? <span className="tag"><span className="i"><Globe size={13} /></span>{id.smtpHost}</span> : null}
                </div>
              ) : undefined}
              right={<div className="prog"><b>{done}</b> / {total} pasos</div>}
            />
          </div>
        </div>
        <div className="pbar"><i style={{ width: pct }} /></div>
        <div className="sec"><div className="sech"><h2>Línea de tiempo en vivo</h2><span className="n">{done} / {total}</span></div><LiveTimeline run={run} /></div>
        {id?.dnsRecords && id.dnsRecords.length > 0 ? (
          <div className="sec"><div className="sech"><h2>Zona DNS</h2><span className="n">{id.dnsRecords.length} registros</span></div>
            <div className="dns"><div className="dnsh"><span>Tipo</span><span>Nombre · valor</span><span /></div>
              {id.dnsRecords.map((r, i) => (
                <div className="drow" key={i}>
                  <span className="ty">{r.type}</span>
                  <span className="dnm"><b>{r.name}</b><span>{r.value}</span></span>
                  <button className="cp" type="button" aria-label="Copiar" onClick={() => { try { navigator.clipboard?.writeText(`${r.name} ${r.type} ${r.value}`); } catch { /* */ } }}><Copy size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <aside className="rside">
        <StatTile icon={Network} label="IPv4">{id?.serverIpv4 ? <>{id.serverIpv4} <span className="chk"><BadgeCheck size={14} /></span></> : PENDING}</StatTile>
        <StatTile icon={Server} label="Servidor">{id?.serverSlug ?? PENDING}</StatTile>
        <StatTile icon={Key} label="DKIM">{id?.dkimPublicKey ? <span style={{ color: "var(--color-success)" }}>verificada</span> : PENDING}</StatTile>
        <StatTile icon={CircleDollarSign} label="Gasto">{id?.budgetSpentUsd != null ? `$${id.budgetSpentUsd.toFixed(2)}` : <span style={{ color: "var(--color-text-disabled)" }}>—</span>}</StatTile>
        {id?.finalDeliveryStatus ? (
          <div className="deliv"><div className="big"><Inbox size={20} /></div><div className="info"><div className="t">Entrega</div><div className="s">{id.finalDeliveryStatus}{id.finalEmailMessageId ? ` · ${id.finalEmailMessageId}` : ""}</div></div></div>
        ) : null}
      </aside>
    </div>
  );
}

function ProseArtifact({ artifact }: { artifact: LiveArtifact }) {
  const md = [...artifact.blocks].sort((a, b) => a.order - b.order).map((b) => b.content).join("\n\n");
  return <MarkdownText fontSize={14}>{md}</MarkdownText>;
}

function statusBadgeClass(status: string): string {
  if (/^(running|ok|pass|active|delivered|done|verificad)/i.test(status)) return "ok";
  if (/(stop|fail|listed|bounce|error|defer)/i.test(status)) return "bad";
  return "mut";
}

function InventoryArtifact({ servers }: { servers: Extract<CanvasLiveArtifactPayloadWire, { kind: "inventory" }>["servers"] }) {
  if (servers.length === 0) return <MarkdownText fontSize={14} muted>Inventario sin servidores.</MarkdownText>;
  return (
    <DataTable
      headers={["Slug", "Dominio SMTP", "IPv4", "Proveedor", "Estado"]}
      rows={servers.map((s) => [
        s.slug,
        s.domain ?? "—",
        s.ipv4 ?? "—",
        s.provider ?? "—",
        <StatusPill status={s.status} />,
      ])}
    />
  );
}

function BlacklistArtifact({ payload }: { payload: Extract<CanvasLiveArtifactPayloadWire, { kind: "blacklist_report" }> }) {
  const listed = payload.checks.filter((c) => c.status === "listed").length;
  return (
    <>
      <div className="meta" style={{ marginBottom: 18 }}>
        <span className="tag"><span className="i"><Globe size={13} /></span>{payload.target}</span>
        <span className="tag">{payload.source}</span>
        <Pill tone={listed > 0 ? "critical" : "success"}>{listed > 0 ? `${listed} en lista` : "limpia"}</Pill>
      </div>
      <DataTable
        headers={["Lista", "Estado", "Nota"]}
        rows={payload.checks.map((c) => [
          c.list,
          <StatusPill status={c.status} tone={c.status === "pass" ? "success" : c.status === "listed" ? "critical" : "neutral"} />,
          c.note ?? "—",
        ])}
      />
    </>
  );
}

function DnsZoneTable({ records, domain }: { records: Array<{ name: string; type: string; value: string }>; domain?: string }) {
  return (
    <div className="dns">
      <div className="dnsh"><span>Tipo</span><span>Nombre · valor{domain ? ` · ${domain}` : ""}</span><span /></div>
      {records.map((r, i) => (
        <div className="drow" key={i}>
          <span className="ty">{r.type}</span>
          <span className="dnm"><b>{r.name}</b><span>{r.value}</span></span>
          <button className="cp" type="button" aria-label="Copiar" onClick={() => { try { navigator.clipboard?.writeText(`${r.name} ${r.type} ${r.value}`); } catch { /* */ } }}><Copy size={13} /></button>
        </div>
      ))}
    </div>
  );
}

function SmtpRunArtifactView({ payload }: { payload: Extract<CanvasLiveArtifactPayloadWire, { kind: "smtp_run" }> }) {
  const id = payload.identity;
  return (
    <div className="runwrap">
      <div className="rmain">
        <div className="hero">
          <div className="icn"><Mail size={22} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SectionHead
              eyebrow="SMTP run"
              title={id.domain ?? payload.runId}
              subtitle={(id.providerId || id.smtpHost) ? (
                <div className="meta">
                  {id.providerId ? <span className="tag"><span className="i"><Server size={13} /></span>{id.providerId}</span> : null}
                  {id.smtpHost ? <span className="tag"><span className="i"><Globe size={13} /></span>{id.smtpHost}</span> : null}
                </div>
              ) : undefined}
            />
          </div>
        </div>
        <div className="sec">
          <div className="sech"><h2>Pasos</h2><span className="n">{payload.steps.length}</span></div>
          {payload.steps.map((s) => {
            const cls = s.status === "done" ? "done" : s.status === "in_flight" ? "act" : "pend";
            const ic: ReactNode = s.status === "done" ? <Check size={12} /> : s.status === "in_flight" ? <Loader2 size={14} className="spin" /> : <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "block" }} />;
            return (
              <div key={s.step} className={`step ${cls}`}>
                <div className="sic">{ic}</div><span className="ln" />
                <span className="snm">{s.label ?? s.skill}</span>
                <span className="du">{fmtDur(s.durationMs) || "·"}</span>
              </div>
            );
          })}
        </div>
        {id.dnsRecords && id.dnsRecords.length > 0 ? (
          <div className="sec"><div className="sech"><h2>Zona DNS</h2><span className="n">{id.dnsRecords.length} registros</span></div><DnsZoneTable records={id.dnsRecords} /></div>
        ) : null}
      </div>
      <aside className="rside">
        <StatTile icon={Network} label="IPv4">{id.serverIpv4 ?? PENDING}</StatTile>
        <StatTile icon={Server} label="Servidor">{id.serverSlug ?? PENDING}</StatTile>
        <StatTile icon={Key} label="DKIM">{id.dkimPublicKey ? <span style={{ color: "var(--color-success)" }}>verificada</span> : PENDING}</StatTile>
        {id.finalDeliveryStatus ? (
          <div className="deliv"><div className="big"><Inbox size={20} /></div><div className="info"><div className="t">Entrega</div><div className="s">{id.finalDeliveryStatus}{id.finalEmailMessageId ? ` · ${id.finalEmailMessageId}` : ""}</div></div></div>
        ) : null}
      </aside>
    </div>
  );
}

type SmtpCredentialPayload = Extract<CanvasLiveArtifactPayloadWire, { kind: "smtp_credential" }>;

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function SmtpCredentialArtifact({ payload }: { payload: Partial<SmtpCredentialPayload> & Record<string, unknown> }) {
  const { toast } = useToast();
  const { navigateTo } = useOpenClawIntent();
  const [downloading, setDownloading] = useState(false);
  const domain = safeText(payload.domain, "dominio pendiente");
  // ANTI-MOCK: no derivar host/usuario del dominio. Si el backend no los manda, "pendiente".
  const host = safeText(payload.host, "");
  const username = safeText(payload.username, "");
  const submission = payload.ports?.submission ?? SMTP_SUBMISSION_PORT;
  const smtps = payload.ports?.smtps ?? SMTP_SMTPS_PORT;
  const hasCredential = payload.hasCredential === true && domain.includes(".");

  async function download(): Promise<void> {
    if (!hasCredential) return;
    setDownloading(true);
    try {
      await downloadSmtpCredential(domain);
      toast.success("Credencial descargada", { description: domain });
    } catch (error) {
      toast.error("No se pudo descargar", {
        description: error instanceof Error ? error.message : "Intentá desde Sender Pool."
      });
    } finally {
      setDownloading(false);
    }
  }

  const hostCell = host ? host : PENDING;
  const usernameCell = username ? username : PENDING;
  return (
    <div className="runwrap">
      <div className="rmain">
        <div className="hero">
          <div className="icn"><KeyRound size={22} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SectionHead
              eyebrow="Credencial SMTP"
              title={domain}
              subtitle={(
                <div className="meta">
                  {host ? <span className="tag"><span className="i"><Globe size={13} /></span>{host}</span> : null}
                  {username ? <span className="tag"><span className="i"><Mail size={13} /></span>{username}</span> : null}
                  <Pill tone={hasCredential ? "success" : "neutral"}>{hasCredential ? "configurada" : "pendiente"}</Pill>
                </div>
              )}
            />
          </div>
        </div>
        <div className="sec">
          <div className="sech"><h2>SMTP AUTH</h2><span className="n">2 puertos</span></div>
          <DataTable
            headers={["Modo", "Host", "Puerto", "Usuario"]}
            rows={[
              ["STARTTLS", hostCell, submission, usernameCell],
              ["SSL/TLS", hostCell, smtps, usernameCell],
            ]}
          />
        </div>
      </div>
      <aside className="rside">
        <StatTile icon={KeyRound} label="Credencial">{hasCredential ? <><span>lista</span> <span className="chk"><BadgeCheck size={14} /></span></> : PENDING}</StatTile>
        <Button variant="ghost" disabled={!hasCredential || downloading} onClick={() => { void download(); }} style={{ width: "100%" }}>
          {downloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          {downloading ? "Descargando" : "Descargar credencial"}
        </Button>
        <Button variant="ghost" onClick={() => navigateTo("sender-pool")} style={{ width: "100%" }}>
          <ArrowRight size={14} />
          Ir a Sender Pool
        </Button>
      </aside>
    </div>
  );
}

class ArtifactErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <MarkdownText fontSize={14} muted>No se pudo renderizar este artifact. La vista cruda sigue disponible.</MarkdownText>
      );
    }
    return this.props.children;
  }
}

function kindMeta(kind: CanvasLiveArtifactKindWire): { label: string; icon: ReactNode } {
  switch (kind) {
    case "inventory": return { label: "Inventario", icon: <Server size={12} /> };
    case "blacklist_report": return { label: "Blacklist", icon: <ShieldAlert size={12} /> };
    case "dns_zone": return { label: "Zona DNS", icon: <Globe size={12} /> };
    case "smtp_run": return { label: "SMTP run", icon: <Mail size={12} /> };
    case "smtp_credential": return { label: "Credencial SMTP", icon: <KeyRound size={12} /> };
    case "plan": return { label: "Plan", icon: <FileText size={12} /> };
    case "proposal": return { label: "Propuesta", icon: <FileText size={12} /> };
    case "template": return { label: "Template", icon: <FileText size={12} /> };
    default: return { label: "Reporte", icon: <FileText size={12} /> };
  }
}

function artifactRawDump(artifact: LiveArtifact): string {
  if (artifact.payload?.kind === "smtp_credential") {
    const payload = artifact.payload;
    return JSON.stringify({
      kind: "smtp_credential",
      domain: payload.domain,
      host: payload.host,
      username: payload.username,
      ports: {
        submission: payload.ports?.submission ?? SMTP_SUBMISSION_PORT,
        smtps: payload.ports?.smtps ?? SMTP_SMTPS_PORT
      },
      hasCredential: payload.hasCredential === true
    }, null, 2);
  }
  return artifact.payload
    ? JSON.stringify(artifact.payload, null, 2)
    : artifact.blocks.slice().sort((a, b) => a.order - b.order).map((b) => b.content).join("\n\n");
}

export function ArtifactBody({ artifact, raw }: { artifact: LiveArtifact; raw: boolean }) {
  if (raw) {
    return <div className="raw">{artifactRawDump(artifact)}</div>;
  }
  const p = artifact.payload;
  if (p?.kind === "inventory") return <InventoryArtifact servers={p.servers} />;
  if (p?.kind === "blacklist_report") return <BlacklistArtifact payload={p} />;
  if (p?.kind === "dns_zone") return <DnsZoneTable records={p.records} domain={p.domain} />;
  if (p?.kind === "smtp_run") return <SmtpRunArtifactView payload={p} />;
  if (p?.kind === "smtp_credential") return <SmtpCredentialArtifact payload={p} />;
  return <ProseArtifact artifact={artifact} />;
}

const SMTP_CREDENTIAL_PREVIEW_WINDOW_MS = 10 * 60 * 1000;

function canvasMessageKeyFromBedrockMsgId(msgId: string): string | null {
  const safeId = msgId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (safeId || "message").slice(0, 8) || null;
}

export function canvasMessageKeyFromTaskId(taskId: string): string | null {
  if (taskId.startsWith("bedrock:")) {
    return canvasMessageKeyFromBedrockMsgId(taskId.slice("bedrock:".length));
  }
  const match = /^chat-(.+)-\d{14}$/.exec(taskId);
  return match?.[1]?.toLowerCase() ?? null;
}

export function selectPreviewArtifact(
  candidate: LiveArtifact | null,
  artifacts: LiveArtifact[]
): LiveArtifact | null {
  if (!candidate || candidate.kind !== "report") {
    return candidate;
  }
  const candidateMessageKey = canvasMessageKeyFromTaskId(candidate.taskId);
  const candidateCreatedAtMs = Date.parse(candidate.createdAt);
  if (!candidateMessageKey || Number.isNaN(candidateCreatedAtMs)) {
    return candidate;
  }
  let selected: LiveArtifact | null = null;
  for (const artifact of artifacts) {
    if (artifact.payload?.kind !== "smtp_credential") {
      continue;
    }
    if (canvasMessageKeyFromTaskId(artifact.taskId) !== candidateMessageKey) {
      continue;
    }
    const artifactCreatedAtMs = Date.parse(artifact.createdAt);
    if (
      Number.isNaN(artifactCreatedAtMs) ||
      artifactCreatedAtMs > candidateCreatedAtMs ||
      candidateCreatedAtMs - artifactCreatedAtMs > SMTP_CREDENTIAL_PREVIEW_WINDOW_MS
    ) {
      continue;
    }
    if (!selected || artifact.createdAt.localeCompare(selected.createdAt) > 0) {
      selected = artifact;
    }
  }
  return selected ?? candidate;
}

export function CanvasV5Preview() {
  useEffect(() => {
    chatClient.connect();
    return () => chatClient.disconnect();
  }, []);
  const chat = useChatStream(chatClient);
  const live = useLiveCanvasStream(true);
  const pendingApprovals = usePendingOpenClawProposals(true);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<Tab>("run");
  const [selRunId, setSelRunId] = useState<string | null>(null);
  const [swOpen, setSwOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [convos, setConvos] = useState<ChatConversationSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  const [convosOpen, setConvosOpen] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);

  useConsumeIntentOnMount((prompt) => {
    setDraft(prompt);
    setChatOpen(true);
    setConvosOpen(true);
    window.setTimeout(() => chatInputRef.current?.focus(), 0);
  });

  const runIds = useMemo(() => Array.from(live.liveRunProgress.keys()), [live.liveRunProgress]);
  const activeRunId = selRunId && live.liveRunProgress.has(selRunId) ? selRunId : (runIds[0] ?? null);
  const run = activeRunId ? live.liveRunProgress.get(activeRunId) ?? null : null;
  const online = chat.connection !== "offline";

  // Artifact activo: el hook lo resuelve por el task activo, pero al cargar puede
  // agarrar uno viejo/mock. Gate de recencia: solo mostrarlo si es de esta sesion (<30 min).
  // El preview muestra el ultimo artifact global (el hook ya elige el mas nuevo, no un mock viejo).
  // Sin gate de recencia: filtraba trabajo legitimo de >30min. Precedencia: si hay run, el run gana.
  const selArt: LiveArtifact | null = useMemo(
    () => runIds.length === 0
      ? selectPreviewArtifact(live.latestArtifact ?? live.artifact, live.artifacts)
      : null,
    [live.artifact, live.artifacts, live.latestArtifact, runIds.length]
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages.length, chat.streaming?.deltaSoFar]);

  const ACTIVE_CONV_KEY = "delivrix.chat.active.v1";
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(ACTIVE_CONV_KEY); } catch { /* */ }
    if (stored) { chatClient.setActiveConversation(stored); setActiveConvId(stored); }
    void chatClient.fetchConversations().then(setConvos);
    void chatClient.loadHistory();
  }, []);

  const refreshConvos = () => { void chatClient.fetchConversations().then(setConvos); };

  function switchConvo(id: string) {
    if (id === activeConvId) return;
    chatClient.setActiveConversation(id);
    setActiveConvId(id);
    try { window.localStorage.setItem(ACTIVE_CONV_KEY, id); } catch { /* */ }
    void chatClient.loadHistory();
  }

  function newConvo() {
    const id = chatClient.startNewConversation();
    setActiveConvId(id);
    try { window.localStorage.setItem(ACTIVE_CONV_KEY, id); } catch { /* */ }
    refreshConvos();
  }

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const next: ChatAttachmentInput[] = [];
    for (const file of Array.from(files)) {
      const mimeType = attachmentMimeOf(file);
      if (!ACCEPTED_ATTACHMENT_MIME.has(mimeType)) continue;
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      const dataBase64 = await fileToBase64(file);
      if (dataBase64) next.push({ name: file.name, mimeType, dataBase64 });
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
  }

  async function send() {
    const content = draft.trim();
    if (!content && attachments.length === 0) return;
    const atts = attachments;
    setDraft("");
    setAttachments([]);
    try { await chatClient.sendMessage(content, atts.length > 0 ? { attachments: atts } : {}); } catch { /* el cliente reintenta */ }
    refreshConvos();
  }

  const hasMsgs = chat.messages.length > 0 || !!chat.streaming;

  return (
    <div className="cv5">
      <style>{STYLE}</style>
      <div className="main">

        {chatOpen ? (
        <>
        {convosOpen ? (
        <div className="convos col">
          <div className="cvhead">
            <div className="cvttl">Conversaciones</div>
            <button className="cvcollapse" type="button" title="Ocultar conversaciones" onClick={() => setConvosOpen(false)}><PanelLeftClose size={15} /></button>
            <button className="cvnew" type="button" title="Nueva conversación" onClick={newConvo}><Plus size={15} /></button>
          </div>
          <div className="cvlist">
            {convos.length === 0 ? (
              <div className="cvempty">Sin conversaciones guardadas. Escribile a OpenClaw o creá una nueva.</div>
            ) : convos.map((c) => (
              <button key={c.id} className={`conv${c.id === activeConvId ? " on" : ""}`} type="button" onClick={() => switchConvo(c.id)}>
                <div className="convt">{c.title || "Conversación"}</div>
              </button>
            ))}
          </div>
        </div>
        ) : null}
        <div className="chat col">
          <div className="chead">
            {!convosOpen ? <button className="reopen" type="button" title="Mostrar conversaciones" onClick={() => setConvosOpen(true)}><PanelLeftOpen size={16} /></button> : null}
            <span className="ic"><Sparkles size={15} /></span>
            <div><div className="nm">OpenClaw</div><div className="sub"><span className="dot beat" style={{ background: online ? "var(--color-success)" : "var(--color-text-disabled)" }} /> {online ? "en vivo" : "reconectando…"}</div></div>
            <button className="collapse" type="button" title="Esconder chat" onClick={() => setChatOpen(false)}><PanelLeftClose size={16} /></button>
          </div>
          <div className="cbody" ref={scrollRef}>
            {!hasMsgs ? (
              <div className="cempty">
                <div className="ii"><Sparkles size={22} /></div>
                <div className="h">Hablá con OpenClaw</div>
                <div className="p">Pedile un diagnóstico, una consulta de blacklist, o que configure un SMTP. Lo que haga aparece en vivo a la derecha.</div>
              </div>
            ) : null}
            {chat.messages.map((m) => (
              <div className={`msg${m.role === "user" ? " op" : " wide"}`} key={`${m.role}-${m.msgId}`}>
                <span className="role">{m.role === "user" ? "operador" : "openclaw"} · {relTime(m.timestamp)}</span>
                {m.role === "user"
                  ? <div className="bub">{m.content}</div>
                  : <div className="bub md"><MarkdownText fontSize={14} muted>{m.content}</MarkdownText></div>}
              </div>
            ))}
            {chat.streaming ? (
              <div className="msg wide"><span className="role">openclaw · ahora</span><div className="bub md"><MarkdownText fontSize={14} muted>{chat.streaming.deltaSoFar || "…"}</MarkdownText><Loader2 size={12} className="spin" style={{ marginLeft: 6, verticalAlign: "-1px" }} /></div></div>
            ) : null}
            {chat.lastError ? (
              <div className="bub" style={{ borderColor: "var(--color-critical-border)", color: "var(--color-critical)", background: "var(--color-critical-soft)", fontSize: 12 }}>{chat.lastError}</div>
            ) : null}
          </div>
          <div className="cinput">
            {attachments.length > 0 ? (
              <div className="chips">
                {attachments.map((a, i) => (
                  <span className="chip" key={`${a.name}-${i}`}>
                    <b>{a.mimeType.startsWith("image/") ? "IMG" : "TXT"}</b>
                    <span className="cnm">{a.name}</span>
                    <button className="cx" type="button" aria-label="Quitar" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}><X size={11} /></button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="field">
              <button className="attach" type="button" title="Adjuntar archivo o imagen" onClick={() => fileRef.current?.click()}><Paperclip size={16} /></button>
              <input ref={fileRef} type="file" multiple accept=".md,.txt,.png,.jpg,.jpeg,.webp,.gif" style={{ display: "none" }} onChange={(e) => { void addFiles(e.target.files); e.currentTarget.value = ""; }} />
              <input
                ref={chatInputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send(); } }}
                placeholder="Escribile a OpenClaw…"
              />
              {chat.streaming ? (
                <button className="send stop" type="button" aria-label="Detener" title="Detener (interrumpir)" disabled={chat.interrupting} onClick={() => { void chatClient.interruptActive(); }}>{chat.interrupting ? <Loader2 size={12} className="spin" /> : <Square size={12} />}</button>
              ) : (
                <button className="send" type="button" aria-label="Enviar" disabled={!draft.trim() && attachments.length === 0} onClick={() => void send()}><ArrowUp size={15} /></button>
              )}
            </div>
          </div>
        </div>
        </>
        ) : null}

        <div className="view">
          <div className="tabs">
            {!chatOpen ? <button className="reopen" type="button" title="Mostrar chat" onClick={() => setChatOpen(true)}><PanelLeftOpen size={16} /></button> : null}
            {([["run", "Vista", <Box size={15} key="r" />], ["logs", "Logs", <Terminal size={15} key="l" />]] as Array<[Tab, string, ReactNode]>).map(([id, label, icon]) => (
              <button key={id} className={`tab${tab === id ? " on" : ""}`} type="button" onClick={() => setTab(id)}>
                {icon} {label}
                {id === "run" && run && run.runStatus === "running" ? <span className="li"><span className="dot beat" /> live</span> : null}
              </button>
            ))}
            <span className="pchip"><span className="dot" style={{ width: 6, height: 6, background: live.connection === "connected" ? "var(--color-success)" : "var(--color-warning)" }} /> {live.connection}</span>
          </div>

          <PendingOpenClawApprovalPanel
            proposals={pendingApprovals.proposals}
            error={pendingApprovals.error}
            onRefresh={pendingApprovals.refresh}
          />

          {tab === "logs" ? (
            <GatewayLogTerminal />
          ) : run ? (
            <>
              <div className="abar">
                <div style={{ position: "relative" }}>
                  <div className="kick"><Box size={12} /> Run artifact</div>
                  <button className="rswbtn" type="button" onClick={() => setSwOpen((o) => !o)}>
                    <span className="dot" style={{ background: run.runStatus === "failed" ? "var(--color-critical)" : run.runStatus === "completed" ? "var(--color-text-disabled)" : "var(--color-success)" }} />
                    <span className="rswdom">{run.identity?.domain ?? activeRunId}</span>
                    {runIds.length > 1 ? <span className="rswcnt">{runIds.indexOf(activeRunId ?? "") + 1}/{runIds.length}</span> : null}
                    {runIds.length > 1 ? <ChevronDown size={14} /> : null}
                  </button>
                  {swOpen && runIds.length > 1 ? (
                    <>
                      <div className="rswback" onClick={() => setSwOpen(false)} />
                      <div className="rswmenu">
                        {runIds.map((rid) => {
                          const r = live.liveRunProgress.get(rid)!;
                          return (
                            <button key={rid} className={`rswitem${rid === activeRunId ? " on" : ""}`} type="button" onClick={() => { setSelRunId(rid); setSwOpen(false); }}>
                              <span className="dot" style={{ background: r.runStatus === "failed" ? "var(--color-critical)" : r.runStatus === "completed" ? "var(--color-text-disabled)" : "var(--color-success)" }} />
                              <span className="rswid"><b>{r.identity?.domain ?? rid}</b><span>{r.runStatus} · {r.lastCompletedStep}/{SMTP_BUILD_STEPS.length}</span></span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : null}
                </div>
                <span className={`stt ${run.runStatus === "failed" ? "failed" : run.runStatus === "completed" ? "done" : "running"}`}>
                  {run.runStatus === "failed" ? <><XCircle size={13} /> fallido</> : run.runStatus === "completed" ? <><CheckCircle2 size={13} /> completado</> : <><span className="dot beat" /> corriendo {run.lastCompletedStep}/{SMTP_BUILD_STEPS.length}</>}
                </span>
              </div>
              <div className="scroll"><div className="art"><RunFicha run={run} runId={activeRunId ?? ""} /></div></div>
            </>
          ) : selArt ? (
            <>
              <div className="abar">
                <div style={{ minWidth: 0 }}>
                  <div className="kick">{kindMeta(selArt.kind).icon} {kindMeta(selArt.kind).label}{selArt.version && selArt.version > 1 ? ` · v${selArt.version}` : ""}</div>
                  <div className="atitle">{selArt.title}</div>
                </div>
                <div style={{ flex: 1 }} />
                <div className="seg">
                  <button type="button" className={raw ? "" : "on"} onClick={() => setRaw(false)}>Vista</button>
                  <button type="button" className={raw ? "on" : ""} onClick={() => setRaw(true)}>Crudo</button>
                </div>
              </div>
              <div className="scroll"><div className="art"><ArtifactErrorBoundary key={selArt.id}><ArtifactBody artifact={selArt} raw={raw} /></ArtifactErrorBoundary></div></div>
            </>
          ) : (
            <div className="empty">
              <div className="ei"><Hourglass size={28} /></div>
              <div className="eh">Nada que mostrar todavía</div>
              <div className="ep">Pedile a OpenClaw un diagnóstico, un inventario, una consulta de blacklist o que configure un SMTP. El resultado aparece acá renderizado en vivo — sin datos de muestra.</div>
              <span className="connpill"><span className="dot" style={{ width: 6, height: 6, background: live.connection === "connected" ? "var(--color-success)" : "var(--color-warning)" }} /> stream {live.connection}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CanvasV5Preview;
