/**
 * CanvasV5Preview — Canvas Live type-aware (datos REALES).
 *
 * - Chat real: chatClient + useChatStream (/v1/openclaw/chat).
 * - Runs/ficha en vivo: useLiveCanvasStream → liveRunProgress (con identity de los
 *   cables PR #4). Si no hay runs activos, estado limpio "sin aprovisionamientos".
 * - Logs: GatewayLogTerminal real.
 *
 * Sin datos de muestra. Montaje: App.tsx caso "canvas" con ?canvasv5 (sticky).
 * No reemplaza CanvasV4. Estilos: tokens.css (var(--color-*) / var(--font-*)), scope `.cv5`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp, BadgeCheck, Box, Check, ChevronDown, CircleDollarSign, CheckCircle2,
  Copy, FileText, Folder, GitCompare, Globe, Hourglass, Inbox, Key, Loader2,
  Mail, MailCheck, Network, PanelLeftClose, PanelLeftOpen, Plus, Server, ShieldAlert, Sparkles, Square, Terminal, X, XCircle
} from "lucide-react";
import { chatClient, useChatStream, type ChatConversationSummary } from "../../shared/api/chat-client.ts";
import { useLiveCanvasStream } from "./canvas-live-client.ts";
import { SMTP_BUILD_STEPS, type LiveRunProgress } from "./smtp-live-progress.ts";
import { GatewayLogTerminal } from "./gateway-log-terminal.tsx";
import { MarkdownText } from "../../shared/ui/v2/MarkdownText.tsx";
import type { LiveArtifact, CanvasLiveArtifactKindWire, CanvasLiveArtifactPayloadWire } from "./live-tool-types.ts";

type Tab = "run" | "logs" | "files" | "diff";

const STYLE = `
.cv5{height:100%;display:flex;flex-direction:column;overflow:hidden;
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

.cv5 .chat{width:600px;flex:0 0 600px;border-right:1px solid var(--line);background:var(--bg)}
.cv5 .chead{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px}
.cv5 .collapse{margin-left:auto;width:28px;height:28px;border-radius:7px;background:none;border:1px solid transparent;color:var(--t3);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
.cv5 .collapse:hover{background:var(--s1);color:var(--t1);border-color:var(--line)}
.cv5 .reopen{width:30px;height:30px;border-radius:7px;background:var(--s2);border:1px solid var(--line2);color:var(--t2);display:flex;align-items:center;justify-content:center;cursor:pointer;margin-right:12px;flex:0 0 auto}
.cv5 .reopen:hover{background:var(--s3);color:var(--t1)}
.cv5 .convos{width:350px;flex:0 0 350px;border-right:1px solid var(--line2);background:var(--bg);display:flex;flex-direction:column;min-height:0}
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
.cv5 .convp{font-size:11.5px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
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
.cv5 .msg{max-width:350px}
.cv5 .bub.md{white-space:normal}
.cv5 .bub.md>div>:first-child{margin-top:0}.cv5 .bub.md>div>:last-child{margin-bottom:0}
.cv5 .msg.op{align-self:flex-end;align-items:flex-end}
.cv5 .msg.op .bub{background:var(--s2);border-color:var(--line2)}
.cv5 .cinput{border-top:1px solid var(--line);padding:12px;background:var(--s1)}
.cv5 .field{display:flex;align-items:center;gap:8px;background:var(--s2);border:1px solid var(--line2);border-radius:10px;padding:9px 11px}
.cv5 .field:focus-within{border-color:#4a4a4a}
.cv5 .field input{flex:1;background:none;border:none;outline:none;color:var(--t1);font:inherit;font-size:13px}
.cv5 .field input::placeholder{color:var(--t4)}
.cv5 .send{width:30px;height:30px;border-radius:8px;background:var(--acc);color:var(--accfg);border:none;display:flex;align-items:center;justify-content:center;flex:0 0 auto;cursor:pointer}
.cv5 .send:disabled{opacity:.4;cursor:not-allowed}
.cv5 .send.stop{background:var(--s3);color:var(--t1);border:1px solid var(--line2)}
.cv5 .send.stop:hover{color:var(--err);border-color:var(--errB)}

.cv5 .view{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)}
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
.cv5 .rswmenu{position:absolute;top:calc(100% + 7px);left:0;width:320px;background:var(--s2);border:1px solid var(--line2);border-radius:12px;padding:6px;z-index:41;box-shadow:0 18px 44px -14px rgba(0,0,0,.65)}
.cv5 .rswitem{display:flex;align-items:center;gap:11px;width:100%;background:none;border:none;border-radius:9px;padding:9px 10px;cursor:pointer;font:inherit;text-align:left}
.cv5 .rswitem:hover{background:var(--s3)}.cv5 .rswitem.on{background:var(--s1)}
.cv5 .rswid{flex:1;min-width:0}.cv5 .rswid b{display:block;font-size:12.5px;color:var(--t1);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv5 .rswid span{display:block;font-size:11px;color:var(--t3);font-family:var(--mono);margin-top:2px}
.cv5 .stt{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;height:25px;padding:0 11px;border-radius:999px}
.cv5 .stt.running{color:var(--ok);background:var(--okS);border:1px solid var(--okB)}
.cv5 .stt.failed{color:var(--err);background:var(--errS);border:1px solid var(--errB)}
.cv5 .stt.done{color:var(--t2);background:var(--s2);border:1px solid var(--line2)}
.cv5 .btn{display:inline-flex;align-items:center;gap:6px;height:31px;padding:0 12px;border-radius:8px;background:var(--s2);border:1px solid var(--line2);color:var(--t2);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer}
.cv5 .btn:hover{background:var(--s3);color:var(--t1)}
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
.cv5 .stat{background:var(--s1);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.cv5 .stat .l{font-size:11px;color:var(--t3);letter-spacing:.04em;text-transform:uppercase;display:flex;align-items:center;gap:7px;margin-bottom:8px;font-weight:600}
.cv5 .stat .v{font-family:var(--mono);font-size:14px;color:var(--t1);display:flex;align-items:center;gap:7px;word-break:break-all}
.cv5 .stat .v .chk{color:var(--ok);display:flex}.cv5 .stat.pend .v{color:var(--t4)}
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
.cv5 .prose{font-size:14px;line-height:1.65;color:var(--t2)}
.cv5 .prose h1,.cv5 .prose h2,.cv5 .prose h3{font-family:var(--disp);color:var(--t1);font-weight:600;line-height:1.25;margin:22px 0 10px}
.cv5 .prose h1{font-size:22px;letter-spacing:-.01em}.cv5 .prose h2{font-size:17px}.cv5 .prose h3{font-size:13.5px;letter-spacing:.02em}
.cv5 .prose>*:first-child{margin-top:0}
.cv5 .prose p{margin:0 0 12px}
.cv5 .prose strong{color:var(--t1);font-weight:600}
.cv5 .prose code{font-family:var(--mono);font-size:12.5px;background:var(--s1);border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--t1)}
.cv5 .prose ul,.cv5 .prose ol{margin:0 0 13px;padding-left:20px}.cv5 .prose li{margin:5px 0}
.cv5 .prose pre{background:var(--s1);border:1px solid var(--line);border-radius:9px;padding:14px;overflow:auto;margin:0 0 14px}
.cv5 .prose pre code{background:none;border:none;padding:0;font-size:12px;color:var(--t1)}
.cv5 .dt{width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:0 0 14px}
.cv5 .dt th{text-align:left;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--t3);font-weight:600;background:var(--s1);padding:10px 12px;border-bottom:1px solid var(--line)}
.cv5 .dt td{padding:10px 12px;border-bottom:1px solid var(--line);color:var(--t1);font-family:var(--mono);font-size:12px;vertical-align:top}
.cv5 .dt tr:last-child td{border-bottom:none}.cv5 .dt tbody tr:hover td{background:var(--s1)}
.cv5 .badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;font-family:var(--disp)}
.cv5 .badge.ok{color:var(--ok);background:var(--okS);border:1px solid var(--okB)}
.cv5 .badge.bad{color:var(--err);background:var(--errS);border:1px solid var(--errB)}
.cv5 .badge.mut{color:var(--t3);background:var(--s2);border:1px solid var(--line)}
.cv5 .raw{font-family:var(--mono);font-size:12px;color:var(--t2);background:var(--s1);border:1px solid var(--line);border-radius:10px;padding:16px;white-space:pre-wrap;word-break:break-word;line-height:1.6}
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
          <div>
            <h1>{domain}</h1>
            <div className="meta">
              {id?.providerId ? <span className="tag"><span className="i"><Server size={13} /></span>{id.providerId}</span> : null}
              {id?.smtpHost ? <span className="tag"><span className="i"><Globe size={13} /></span>{id.smtpHost}</span> : null}
            </div>
          </div>
          <div className="rgt"><div className="prog"><b>{done}</b> / {total} pasos</div></div>
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
        <div className="stat"><div className="l"><Network size={13} /> IPv4</div><div className="v">{id?.serverIpv4 ? <>{id.serverIpv4} <span className="chk"><BadgeCheck size={14} /></span></> : <span style={{ color: "var(--color-text-disabled)" }}>pendiente</span>}</div></div>
        <div className="stat"><div className="l"><Server size={13} /> Servidor</div><div className="v">{id?.serverSlug ?? <span style={{ color: "var(--color-text-disabled)" }}>pendiente</span>}</div></div>
        <div className="stat"><div className="l"><Key size={13} /> DKIM</div><div className="v">{id?.dkimPublicKey ? <span style={{ color: "var(--color-success)" }}>verificada</span> : <span style={{ color: "var(--color-text-disabled)" }}>pendiente</span>}</div></div>
        <div className="stat"><div className="l"><CircleDollarSign size={13} /> Gasto</div><div className="v">{id?.budgetSpentUsd != null ? `$${id.budgetSpentUsd.toFixed(2)}` : <span style={{ color: "var(--color-text-disabled)" }}>—</span>}</div></div>
        {id?.finalDeliveryStatus ? (
          <div className="deliv"><div className="big"><Inbox size={20} /></div><div className="info"><div className="t">Entrega</div><div className="s">{id.finalDeliveryStatus}{id.finalEmailMessageId ? ` · ${id.finalEmailMessageId}` : ""}</div></div></div>
        ) : null}
      </aside>
    </div>
  );
}

function ProseArtifact({ artifact }: { artifact: LiveArtifact }) {
  const md = [...artifact.blocks].sort((a, b) => a.order - b.order).map((b) => b.content).join("\n\n");
  return <div className="prose"><MarkdownText fontSize={14}>{md}</MarkdownText></div>;
}

function statusBadgeClass(status: string): string {
  if (/^(running|ok|pass|active|delivered|done|verificad)/i.test(status)) return "ok";
  if (/(stop|fail|listed|bounce|error|defer)/i.test(status)) return "bad";
  return "mut";
}

function InventoryArtifact({ servers }: { servers: Extract<CanvasLiveArtifactPayloadWire, { kind: "inventory" }>["servers"] }) {
  if (servers.length === 0) return <div className="prose"><p>Inventario sin servidores.</p></div>;
  return (
    <table className="dt">
      <thead><tr><th>Slug</th><th>Dominio SMTP</th><th>IPv4</th><th>Proveedor</th><th>Estado</th></tr></thead>
      <tbody>
        {servers.map((s, i) => (
          <tr key={i}>
            <td>{s.slug}</td>
            <td>{s.domain ?? "—"}</td>
            <td>{s.ipv4 ?? "—"}</td>
            <td>{s.provider ?? "—"}</td>
            <td><span className={`badge ${statusBadgeClass(s.status)}`}>{s.status}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlacklistArtifact({ payload }: { payload: Extract<CanvasLiveArtifactPayloadWire, { kind: "blacklist_report" }> }) {
  const listed = payload.checks.filter((c) => c.status === "listed").length;
  return (
    <>
      <div className="meta" style={{ marginBottom: 18 }}>
        <span className="tag"><span className="i"><Globe size={13} /></span>{payload.target}</span>
        <span className="tag">{payload.source}</span>
        <span className={`badge ${listed > 0 ? "bad" : "ok"}`}>{listed > 0 ? `${listed} en lista` : "limpia"}</span>
      </div>
      <table className="dt">
        <thead><tr><th>Lista</th><th>Estado</th><th>Nota</th></tr></thead>
        <tbody>
          {payload.checks.map((c, i) => (
            <tr key={i}>
              <td>{c.list}</td>
              <td><span className={`badge ${c.status === "pass" ? "ok" : c.status === "listed" ? "bad" : "mut"}`}>{c.status}</span></td>
              <td style={{ fontFamily: "var(--font-sans)" }}>{c.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
          <div>
            <h1>{id.domain ?? payload.runId}</h1>
            <div className="meta">
              {id.providerId ? <span className="tag"><span className="i"><Server size={13} /></span>{id.providerId}</span> : null}
              {id.smtpHost ? <span className="tag"><span className="i"><Globe size={13} /></span>{id.smtpHost}</span> : null}
            </div>
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
        <div className="stat"><div className="l"><Network size={13} /> IPv4</div><div className="v">{id.serverIpv4 ?? <span style={{ color: "var(--color-text-disabled)" }}>pendiente</span>}</div></div>
        <div className="stat"><div className="l"><Server size={13} /> Servidor</div><div className="v">{id.serverSlug ?? <span style={{ color: "var(--color-text-disabled)" }}>pendiente</span>}</div></div>
        <div className="stat"><div className="l"><Key size={13} /> DKIM</div><div className="v">{id.dkimPublicKey ? <span style={{ color: "var(--color-success)" }}>verificada</span> : <span style={{ color: "var(--color-text-disabled)" }}>pendiente</span>}</div></div>
        {id.finalDeliveryStatus ? (
          <div className="deliv"><div className="big"><Inbox size={20} /></div><div className="info"><div className="t">Entrega</div><div className="s">{id.finalDeliveryStatus}{id.finalEmailMessageId ? ` · ${id.finalEmailMessageId}` : ""}</div></div></div>
        ) : null}
      </aside>
    </div>
  );
}

function kindMeta(kind: CanvasLiveArtifactKindWire): { label: string; icon: ReactNode } {
  switch (kind) {
    case "inventory": return { label: "Inventario", icon: <Server size={12} /> };
    case "blacklist_report": return { label: "Blacklist", icon: <ShieldAlert size={12} /> };
    case "dns_zone": return { label: "Zona DNS", icon: <Globe size={12} /> };
    case "smtp_run": return { label: "SMTP run", icon: <Mail size={12} /> };
    case "plan": return { label: "Plan", icon: <FileText size={12} /> };
    case "proposal": return { label: "Propuesta", icon: <FileText size={12} /> };
    case "template": return { label: "Template", icon: <FileText size={12} /> };
    default: return { label: "Reporte", icon: <FileText size={12} /> };
  }
}

function ArtifactBody({ artifact, raw }: { artifact: LiveArtifact; raw: boolean }) {
  if (raw) {
    const dump = artifact.payload ? JSON.stringify(artifact.payload, null, 2) : artifact.blocks.slice().sort((a, b) => a.order - b.order).map((b) => b.content).join("\n\n");
    return <div className="raw">{dump}</div>;
  }
  const p = artifact.payload;
  if (p?.kind === "inventory") return <InventoryArtifact servers={p.servers} />;
  if (p?.kind === "blacklist_report") return <BlacklistArtifact payload={p} />;
  if (p?.kind === "dns_zone") return <DnsZoneTable records={p.records} domain={p.domain} />;
  if (p?.kind === "smtp_run") return <SmtpRunArtifactView payload={p} />;
  return <ProseArtifact artifact={artifact} />;
}

export function CanvasV5Preview() {
  useEffect(() => {
    chatClient.connect();
    return () => chatClient.disconnect();
  }, []);
  const chat = useChatStream(chatClient);
  const live = useLiveCanvasStream(true);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<Tab>("run");
  const [selRunId, setSelRunId] = useState<string | null>(null);
  const [swOpen, setSwOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [convos, setConvos] = useState<ChatConversationSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  const runIds = Array.from(live.liveRunProgress.keys());
  const activeRunId = selRunId && live.liveRunProgress.has(selRunId) ? selRunId : (runIds[0] ?? null);
  const run = activeRunId ? live.liveRunProgress.get(activeRunId) ?? null : null;
  const online = chat.connection !== "offline";

  // Artifact activo: el hook lo resuelve por el task activo, pero al cargar puede
  // agarrar uno viejo/mock. Gate de recencia: solo mostrarlo si es de esta sesion (<30 min).
  const rawArt = live.artifact;
  const selArt: LiveArtifact | null =
    rawArt && Date.now() - new Date(rawArt.createdAt).getTime() < 30 * 60 * 1000 ? rawArt : null;

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

  async function send() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    try { await chatClient.sendMessage(content); } catch { /* el cliente reintenta */ }
    refreshConvos();
  }

  const hasMsgs = chat.messages.length > 0 || !!chat.streaming;

  return (
    <div className="cv5">
      <style>{STYLE}</style>
      <div className="main">

        {chatOpen ? (
        <>
        <div className="convos col">
          <div className="cvhead">
            <div className="cvttl">Conversaciones</div>
            <button className="cvnew" type="button" title="Nueva conversación" onClick={newConvo}><Plus size={15} /></button>
          </div>
          <div className="cvlist">
            {convos.length === 0 ? (
              <div className="cvempty">Sin conversaciones guardadas. Escribile a OpenClaw o creá una nueva.</div>
            ) : convos.map((c) => (
              <button key={c.id} className={`conv${c.id === activeConvId ? " on" : ""}`} type="button" onClick={() => switchConvo(c.id)}>
                <div className="convt">{c.title || "Conversación"}</div>
                {c.preview ? <div className="convp">{c.preview}</div> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="chat col">
          <div className="chead">
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
              <div className={`msg${m.role === "user" ? " op" : ""}`} key={`${m.role}-${m.msgId}`}>
                <span className="role">{m.role === "user" ? "operador" : "openclaw"} · {relTime(m.timestamp)}</span>
                {m.role === "user"
                  ? <div className="bub">{m.content}</div>
                  : <div className="bub md"><MarkdownText fontSize={14} muted>{m.content}</MarkdownText></div>}
              </div>
            ))}
            {chat.streaming ? (
              <div className="msg"><span className="role">openclaw · ahora</span><div className="bub md"><MarkdownText fontSize={14} muted>{chat.streaming.deltaSoFar || "…"}</MarkdownText><Loader2 size={12} className="spin" style={{ marginLeft: 6, verticalAlign: "-1px" }} /></div></div>
            ) : null}
            {chat.lastError ? (
              <div className="bub" style={{ borderColor: "var(--color-critical-border)", color: "var(--color-critical)", background: "var(--color-critical-soft)", fontSize: 12 }}>{chat.lastError}</div>
            ) : null}
          </div>
          <div className="cinput">
            <div className="field">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send(); } }}
                placeholder="Escribile a OpenClaw…"
              />
              {chat.streaming ? (
                <button className="send stop" type="button" aria-label="Detener" title="Detener (interrumpir)" disabled={chat.interrupting} onClick={() => { void chatClient.interruptActive(); }}>{chat.interrupting ? <Loader2 size={12} className="spin" /> : <Square size={12} />}</button>
              ) : (
                <button className="send" type="button" aria-label="Enviar" disabled={!draft.trim()} onClick={() => void send()}><ArrowUp size={15} /></button>
              )}
            </div>
          </div>
        </div>
        </>
        ) : null}

        <div className="view">
          <div className="tabs">
            {!chatOpen ? <button className="reopen" type="button" title="Mostrar chat" onClick={() => setChatOpen(true)}><PanelLeftOpen size={16} /></button> : null}
            {([["run", "Vista", <Box size={15} key="r" />], ["logs", "Logs", <Terminal size={15} key="l" />], ["files", "Files", <Folder size={15} key="f" />], ["diff", "Diff", <GitCompare size={15} key="d" />]] as Array<[Tab, string, ReactNode]>).map(([id, label, icon]) => (
              <button key={id} className={`tab${tab === id ? " on" : ""}`} type="button" onClick={() => setTab(id)}>
                {icon} {label}
                {id === "run" && run && run.runStatus === "running" ? <span className="li"><span className="dot beat" /> live</span> : null}
              </button>
            ))}
            <span className="pchip"><span className="dot" style={{ width: 6, height: 6, background: live.connection === "connected" ? "var(--color-success)" : "var(--color-warning)" }} /> {live.connection}</span>
          </div>

          {tab === "logs" ? (
            <GatewayLogTerminal />
          ) : tab === "files" || tab === "diff" ? (
            <div className="empty">
              <div className="ei">{tab === "files" ? <Folder size={26} /> : <GitCompare size={26} />}</div>
              <div className="eh">{tab === "files" ? "Workspace del agente" : "Diffs de configuración"}</div>
              <div className="ep">Se cablea al {tab === "files" ? "API real de workspace (/v1/openclaw/workspace)" : "diff de main.cf / opendkim.conf / zona DNS"} en la próxima iteración. Sin datos de muestra.</div>
            </div>
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
                <div style={{ flex: 1 }} />
                <button className="btn" type="button"><FileText size={15} /> .md</button>
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
              <div className="scroll"><div className="art"><ArtifactBody artifact={selArt} raw={raw} /></div></div>
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
