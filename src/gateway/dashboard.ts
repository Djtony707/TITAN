/**
 * TITAN — Mission Control Dashboard
 * Full-featured web GUI: auth, working chat, config editor, live data.
 */

export function getMissionControlHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TITAN Mission Control</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0e1a;--bg2:#111827;--bg3:#1a1f36;--bg4:#252b48;
  --accent:#06b6d4;--accent2:#8b5cf6;--accent3:#10b981;--accent4:#f59e0b;
  --error:#ef4444;--warn:#f59e0b;
  --text:#e2e8f0;--text-dim:#94a3b8;--text-bright:#f8fafc;
  --border:#2a3050;--glow:0 0 20px rgba(6,182,212,.15);
  --radius:12px;--radius-sm:8px;
}
body{font-family:'Inter','Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;height:100vh;overflow:hidden}

/* Sidebar */
.sidebar{width:240px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.logo-area{padding:20px;border-bottom:1px solid var(--border);text-align:center}
.logo-area h1{font-size:22px;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:2px}
.logo-area .version{font-size:11px;color:var(--text-dim);margin-top:4px;font-family:'JetBrains Mono',monospace}
.nav{flex:1;padding:12px 8px;overflow-y:auto}
.nav-section{font-size:10px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.5px;padding:12px 12px 6px;margin-top:8px}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:var(--radius-sm);cursor:pointer;color:var(--text-dim);font-size:13px;font-weight:500;transition:all .15s;user-select:none}
.nav-item:hover{background:var(--bg3);color:var(--text)}
.nav-item.active{background:linear-gradient(135deg,rgba(6,182,212,.15),rgba(139,92,246,.1));color:var(--accent);border:1px solid rgba(6,182,212,.2)}
.nav-item .icon{font-size:16px;width:20px;text-align:center}
.sidebar-footer{padding:12px;border-top:1px solid var(--border)}
.logout-btn{width:100%;padding:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:var(--radius-sm);color:#ef4444;font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.logout-btn:hover{background:rgba(239,68,68,.2)}

/* Main */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.topbar{height:56px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 24px;flex-shrink:0}
.topbar h2{font-size:16px;font-weight:600}
.topbar .status{display:flex;gap:16px;align-items:center}
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--accent3);box-shadow:0 0 8px var(--accent3);animation:pulse 2s infinite}
.status-dot.offline{background:var(--error);box-shadow:0 0 8px var(--error);animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.status-label{font-size:12px;color:var(--text-dim)}

.content{flex:1;overflow-y:auto;padding:24px}
.panel{display:none}
.panel.active{display:block}

/* Cards */
.card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:20px;box-shadow:var(--glow);margin-bottom:20px}
.card h3{font-size:14px;font-weight:600;margin-bottom:16px;color:var(--text-bright)}
.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px}

/* Stat cards */
.stat-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:16px;position:relative;overflow:hidden}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:var(--radius) var(--radius) 0 0}
.stat-card.cyan::before{background:linear-gradient(90deg,var(--accent),transparent)}
.stat-card.purple::before{background:linear-gradient(90deg,var(--accent2),transparent)}
.stat-card.green::before{background:linear-gradient(90deg,var(--accent3),transparent)}
.stat-card.amber::before{background:linear-gradient(90deg,var(--accent4),transparent)}
.stat-label{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px}
.stat-value{font-size:28px;font-weight:700;margin-top:4px;font-family:'JetBrains Mono',monospace}
.stat-sub{font-size:11px;color:var(--text-dim);margin-top:4px}

/* Tables */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;border-bottom:2px solid var(--border);color:var(--text-dim);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600}
td{padding:10px 12px;border-bottom:1px solid var(--border)}
tr:hover{background:rgba(6,182,212,.03)}

/* Badges */
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600}
.badge.active{background:rgba(16,185,129,.15);color:var(--accent3)}
.badge.idle{background:rgba(148,163,184,.1);color:var(--text-dim)}
.badge.error{background:rgba(239,68,68,.15);color:var(--error)}
.badge.warn{background:rgba(245,158,11,.15);color:var(--warn)}
.badge.info{background:rgba(6,182,212,.15);color:var(--accent)}

/* Chat */
.chat-wrap{display:flex;flex-direction:column;height:calc(100vh - 140px)}
.chat-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:75%;padding:12px 16px;border-radius:16px;font-size:14px;line-height:1.6;animation:fadeIn .2s;white-space:pre-wrap;word-break:break-word}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.msg.user{align-self:flex-end;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-bottom-right-radius:4px}
.msg.assistant{align-self:flex-start;background:var(--bg3);border:1px solid var(--border);border-bottom-left-radius:4px}
.msg .meta{font-size:11px;opacity:.6;margin-top:6px}
.chat-input-area{padding:16px;border-top:1px solid var(--border);display:flex;gap:12px;flex-shrink:0}
.chat-input-area input{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;color:var(--text);font-size:14px;outline:none;transition:border .2s}
.chat-input-area input:focus{border-color:var(--accent)}
.chat-input-area button{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;padding:12px 24px;border-radius:var(--radius);font-weight:600;cursor:pointer;font-size:14px;transition:transform .1s,opacity .2s}
.chat-input-area button:hover{transform:scale(1.02)}
.chat-input-area button:disabled{opacity:.5;cursor:not-allowed;transform:none}

/* Buttons */
.btn{padding:8px 16px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.btn:hover{background:var(--bg4);border-color:var(--accent)}
.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff}
.btn.primary:hover{opacity:.9;background:linear-gradient(135deg,var(--accent),var(--accent2))}
.btn.danger{background:rgba(239,68,68,.1);border-color:var(--error);color:var(--error)}
.btn.danger:hover{background:rgba(239,68,68,.2)}

/* Form inputs */
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.form-group input,.form-group select{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;color:var(--text);font-size:13px;outline:none;transition:border .2s}
.form-group input:focus,.form-group select:focus{border-color:var(--accent)}
.form-group select option{background:var(--bg3)}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.form-actions{display:flex;gap:12px;margin-top:20px}

/* Security audit items */
.audit-item{padding:10px 14px;margin-bottom:8px;border-radius:var(--radius-sm);display:flex;align-items:flex-start;gap:10px;font-size:13px}
.audit-item.error{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#fca5a5}
.audit-item.warn{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);color:#fcd34d}
.audit-item.info{background:rgba(6,182,212,.05);border:1px solid rgba(6,182,212,.15);color:var(--text-dim)}

/* Scrollbar */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--border)}

/* Empty state */
.empty-state{text-align:center;padding:40px;color:var(--text-dim)}
.empty-state .icon{font-size:48px;margin-bottom:12px}
.empty-state p{font-size:14px}

/* Toast */
#toast{position:fixed;bottom:24px;right:24px;background:var(--bg4);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 20px;font-size:13px;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none}
#toast.show{opacity:1}
#toast.success{border-color:var(--accent3);color:var(--accent3)}
#toast.error{border-color:var(--error);color:var(--error)}

/* Session Viewer Modal */
#session-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(10,14,26,0.85);backdrop-filter:blur(8px);z-index:9900;display:none;align-items:center;justify-content:center;opacity:0;transition:opacity 0.3s}
#session-modal.show{display:flex;opacity:1}
.sm-card{background:var(--bg2);border:1px solid var(--border);border-radius:16px;width:700px;max-width:92%;height:80vh;display:flex;flex-direction:column;box-shadow:0 25px 80px rgba(0,0,0,0.6);transform:scale(0.95);transition:transform 0.3s}
#session-modal.show .sm-card{transform:scale(1)}
.sm-header{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--bg3);border-radius:16px 16px 0 0}
.sm-header h3{font-size:16px;font-weight:600;color:var(--text-bright);display:flex;align-items:center;gap:10px}
.sm-close{background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer;transition:color 0.2s}
.sm-close:hover{color:var(--text)}
.sm-body{flex:1;overflow-y:auto;padding:24px;background:var(--bg)}
.sm-history{font-family:'JetBrains Mono',monospace;font-size:12px;white-space:pre-wrap;color:var(--text-dim);line-height:1.5}

/* Onboarding Modal - Premium OpenClaw Aesthetic */
#onboarding-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(10,14,26,0.85);backdrop-filter:blur(8px);z-index:9999;display:none;align-items:center;justify-content:center;opacity:0;transition:opacity 0.4s cubic-bezier(0.4, 0, 0.2, 1)}
#onboarding-modal.show{display:flex;opacity:1}
.ob-card{background:var(--bg2);border:1px solid rgba(6,182,212,0.3);border-radius:24px;width:540px;max-width:92%;box-shadow:0 25px 80px rgba(0,0,0,0.6), 0 0 40px rgba(6,182,212,0.1);overflow:hidden;display:flex;flex-direction:column;transform:scale(0.95);transition:transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)}
#onboarding-modal.show .ob-card{transform:scale(1)}
.ob-header{padding:32px 32px 24px;text-align:center;position:relative;overflow:hidden}
.ob-header::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(circle, rgba(6,182,212,0.1) 0%, transparent 60%);z-index:0;pointer-events:none}
.ob-header-content{position:relative;z-index:1}
.ob-icon{width:64px;height:64px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 16px;box-shadow:0 10px 20px rgba(6,182,212,0.3)}
.ob-header h2{font-size:24px;font-weight:700;margin-bottom:8px;background:linear-gradient(135deg,#fff,var(--text-dim));-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:0.5px}
.ob-header p{color:var(--text-dim);font-size:14px;line-height:1.5}
.ob-progress{display:flex;justify-content:center;gap:8px;margin-top:20px}
.ob-dot{width:8px;height:8px;border-radius:50%;background:var(--border);transition:all 0.3s}
.ob-dot.active{background:var(--accent);transform:scale(1.2);box-shadow:0 0 10px var(--accent)}
.ob-dot.done{background:var(--accent2)}
.ob-body{padding:0 32px 32px;flex:1;position:relative}
.ob-step{display:none;animation:slideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;opacity:0}
@keyframes slideIn{0%{opacity:0;transform:translateX(20px)}100%{opacity:1;transform:translateX(0)}}
.ob-step.active{display:block}
.ob-step-title{font-size:18px;font-weight:600;margin-bottom:8px;color:var(--text-bright)}
.ob-step-desc{color:var(--text-dim);font-size:13px;margin-bottom:24px;line-height:1.5}
.ob-footer{padding:20px 32px;border-top:1px solid rgba(255,255,255,0.05);display:flex;justify-content:space-between;background:rgba(0,0,0,0.2)}
.provider-box{border:1px solid var(--border);padding:18px;border-radius:12px;margin-bottom:12px;cursor:pointer;transition:all 0.2s;background:var(--bg3);display:flex;align-items:flex-start;gap:16px}
.provider-box:hover{border-color:rgba(6,182,212,0.5);transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,0.2)}
.provider-box.selected{border-color:var(--accent);background:linear-gradient(145deg,rgba(6,182,212,0.1),rgba(139,92,246,0.05));box-shadow:0 0 0 1px var(--accent) inset}
.provider-icon{font-size:24px;background:rgba(255,255,255,0.05);width:40px;height:40px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.provider-box strong{display:block;margin-bottom:6px;font-size:15px;color:var(--text-bright)}
.provider-box p{font-size:13px;color:var(--text-dim);line-height:1.4}
.ob-btn{padding:12px 24px;border-radius:10px;font-weight:600;font-size:14px;cursor:pointer;transition:all 0.2s;border:none}
.ob-btn-secondary{background:transparent;color:var(--text-dim);border:1px solid var(--border)}
.ob-btn-secondary:hover{background:var(--bg3);color:var(--text)}
.ob-btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;box-shadow:0 4px 15px rgba(6,182,212,0.3)}
.ob-btn-primary:hover{opacity:0.9;transform:translateY(-1px);box-shadow:0 6px 20px rgba(6,182,212,0.4)}
.ob-btn-primary:disabled{opacity:0.6;cursor:not-allowed;transform:none}

/* ── Premium Enhancements ─────────────────────────────────── */

/* Light theme */
[data-theme="light"]{
  --bg:#f0f2f5;--bg2:#ffffff;--bg3:#f8f9fa;--bg4:#e9ecef;
  --text:#1a1a2e;--text-dim:#6c757d;--text-bright:#000;
  --border:#dee2e6;--glow:0 0 20px rgba(6,182,212,.08);
}
[data-theme="light"] .msg.user{color:#fff}
[data-theme="light"] .msg.assistant{background:#fff;border-color:#dee2e6;color:#1a1a2e}
[data-theme="light"] .msg.assistant code{background:rgba(6,182,212,.1);color:#0e7490}
[data-theme="light"] .msg.assistant pre{background:#f8f9fa;border-color:#dee2e6;color:#1a1a2e}
[data-theme="light"] .nav-item.active{background:rgba(6,182,212,.08);border-color:rgba(6,182,212,.2)}
[data-theme="light"] .chat-input-area input{background:#fff;border-color:#dee2e6;color:#1a1a2e}
[data-theme="light"] .badge.active{background:rgba(16,185,129,.1);color:#059669}
[data-theme="light"] .badge.error{background:rgba(239,68,68,.1);color:#dc2626}
[data-theme="light"] .ob-header h2{background:linear-gradient(135deg,#1a1a2e,var(--text-dim));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
[data-theme="light"] table td{color:#1a1a2e}
[data-theme="light"] #logs-container{background:#fff;color:#1a1a2e}
[data-theme="light"] .sidebar{background:#fff;border-color:#dee2e6}
[data-theme="light"] .topbar{background:#fff;border-color:#dee2e6}
[data-theme="light"] .footer-bar{background:#fff;border-color:#dee2e6;color:#6c757d}

/* Glassmorphism cards */
.card{background:rgba(17,24,39,.75);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
[data-theme="light"] .card{background:rgba(255,255,255,.8)}
.stat-card{background:rgba(26,31,54,.6);backdrop-filter:blur(8px)}
[data-theme="light"] .stat-card{background:rgba(248,249,250,.7)}

/* Panel transitions */
.panel{opacity:0;transform:translateY(8px);transition:opacity .3s ease,transform .3s ease;pointer-events:none}
.panel.active{display:block;opacity:1;transform:translateY(0);pointer-events:auto}

/* Button micro-animations */
.btn{transition:all .2s cubic-bezier(.4,0,.2,1)}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(6,182,212,.2)}
.btn:active{transform:translateY(0)}
.nav-item{transition:all .2s cubic-bezier(.4,0,.2,1)}
.nav-item:hover{transform:translateX(4px)}

/* Card reveal stagger */
@keyframes cardReveal{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.card{animation:cardReveal .4s ease backwards}
.card:nth-child(2){animation-delay:.05s}
.card:nth-child(3){animation-delay:.1s}
.card-grid .stat-card{animation:cardReveal .4s ease backwards}
.card-grid .stat-card:nth-child(1){animation-delay:0s}
.card-grid .stat-card:nth-child(2){animation-delay:.06s}
.card-grid .stat-card:nth-child(3){animation-delay:.12s}
.card-grid .stat-card:nth-child(4){animation-delay:.18s}

/* Status badge pulse */
.badge.active{animation:badgePulse 2s ease-in-out infinite}
@keyframes badgePulse{0%,100%{box-shadow:0 0 0 0 rgba(16,185,129,.3)}50%{box-shadow:0 0 0 4px rgba(16,185,129,0)}}
.badge.error{animation:badgeError 1.5s ease-in-out infinite}
@keyframes badgeError{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.3)}50%{box-shadow:0 0 0 4px rgba(239,68,68,0)}}

/* Hint banner */
.hint-banner{background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);border-radius:var(--radius-sm);padding:10px 16px;margin-bottom:16px;font-size:12px;color:var(--text-dim);display:flex;align-items:center;gap:8px;cursor:pointer;transition:opacity .3s}
.hint-banner:hover{opacity:.7}
.hint-banner .hint-icon{font-size:14px;flex-shrink:0}
.hint-banner .hint-dismiss{margin-left:auto;opacity:.5;font-size:16px}
[data-theme="light"] .hint-banner{background:rgba(6,182,212,.05);border-color:rgba(6,182,212,.15)}

/* Skeleton loading */
@keyframes skeleton{0%{background-position:-200px 0}100%{background-position:calc(200px + 100%) 0}}
.skeleton{background:linear-gradient(90deg,var(--bg3) 25%,var(--bg4) 50%,var(--bg3) 75%);background-size:200px 100%;animation:skeleton 1.5s ease-in-out infinite;border-radius:var(--radius-sm);height:20px;margin-bottom:8px}

/* Toast upgrade — top-right slide-in */
#toast{bottom:auto;top:24px;right:24px;transform:translateX(120%);opacity:1;transition:transform .4s cubic-bezier(.4,0,.2,1);pointer-events:auto;backdrop-filter:blur(8px);background:rgba(37,43,72,.95)}
#toast.show{transform:translateX(0)}

/* Typing indicator */
.typing-dots{display:flex;gap:4px;padding:12px 16px;align-items:center}
.typing-dots span{width:8px;height:8px;border-radius:50%;background:var(--text-dim);animation:typingBounce .6s ease-in-out infinite}
.typing-dots span:nth-child(2){animation-delay:.15s}
.typing-dots span:nth-child(3){animation-delay:.3s}
@keyframes typingBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

/* Chat markdown */
.msg.assistant code{background:rgba(6,182,212,.15);padding:1px 5px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px}
.msg.assistant pre{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;margin:8px 0;overflow-x:auto;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.5}
.msg.assistant strong{color:var(--text-bright)}
.msg.assistant ul,.msg.assistant ol{margin:4px 0 4px 16px}
.msg.assistant li{margin:2px 0}

/* Agent avatar */
.msg.assistant{padding-left:44px;position:relative}
.msg.assistant::before{content:'⚡';position:absolute;left:10px;top:10px;width:26px;height:26px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;line-height:26px;text-align:center}

/* Responsive sidebar */
.sidebar-toggle{display:none;position:fixed;top:12px;left:12px;z-index:100;width:40px;height:40px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:20px;color:var(--text);align-items:center;justify-content:center}
@media(max-width:1024px){
  .sidebar{position:fixed;left:-260px;top:0;bottom:0;z-index:99;transition:left .3s ease;box-shadow:4px 0 24px rgba(0,0,0,.3)}
  .sidebar.open{left:0}
  .sidebar-toggle{display:flex}
  .main{margin-left:0}
  .form-row{grid-template-columns:1fr}
}

/* Footer bar */
.footer-bar{height:32px;background:var(--bg2);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;font-size:11px;color:var(--text-dim);flex-shrink:0}
.footer-bar .footer-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:6px}
.footer-bar .footer-dot.on{background:var(--accent3);box-shadow:0 0 6px var(--accent3)}
.footer-bar .footer-dot.off{background:var(--error)}

/* Theme + sound toggles in sidebar footer */
.sidebar-toggles{display:flex;gap:6px;margin-bottom:8px}
.sidebar-toggles button{flex:1;padding:6px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-dim);font-size:11px;cursor:pointer;transition:all .15s}
.sidebar-toggles button:hover{background:var(--bg4);color:var(--text)}

/* Scrollbar refinement */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-thumb{background:rgba(148,163,184,.25);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,.4)}
*{scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.25) transparent}</style>
</head>
<body>
<button class="sidebar-toggle" data-action="toggle-sidebar">☰</button>
<aside class="sidebar" id="sidebar">
  <div class="logo-area">
    <h1>⚡ TITAN</h1>
    <div class="version" id="ver-label">Mission Control</div>
  </div>
  <nav class="nav">
    <div class="nav-section">Core</div>
    <div class="nav-item active" data-panel="overview"><span class="icon">📊</span>Overview</div>
    <div class="nav-item" data-panel="chat"><span class="icon">💬</span>WebChat</div>
    <div class="nav-item" data-panel="voice" data-load="voice"><span class="icon">🎙️</span>Voice</div>
    <div class="nav-item" data-panel="agents"><span class="icon">🤖</span>Agents</div>
    <div class="nav-section">Config</div>
    <div class="nav-item" data-panel="config" data-load="config"><span class="icon">⚙️</span>Settings</div>
    <div class="nav-item" data-panel="channels"><span class="icon">📡</span>Channels</div>
    <div class="nav-section">Tools & Data</div>
    <div class="nav-item" data-panel="skills"><span class="icon">🧩</span>Skills</div>
    <div class="nav-item" data-panel="sessions"><span class="icon">🔗</span>Sessions</div>
    <div class="nav-item" data-panel="learning"><span class="icon">🧠</span>Learning</div>
    <div class="nav-section">System</div>
    <div class="nav-item" data-panel="telemetry" data-load="telemetry"><span class="icon">📈</span>Telemetry</div>
    <div class="nav-item" data-panel="autopilot" data-load="autopilot"><span class="icon">🚁</span>Autopilot</div>
    <div class="nav-item" data-panel="security"><span class="icon">🔒</span>Security</div>
    <div class="nav-item" data-panel="logs" data-load="logs"><span class="icon">📜</span>Logs</div>
    <div class="nav-item" data-panel="workflows" data-load="workflows"><span class="icon">🔀</span>Workflows</div>
    <div class="nav-item" data-panel="graphiti" data-load="graphiti"><span class="icon">🕸️</span>Memory Graph</div>
  </nav>
  <div class="sidebar-footer">
    <div class="sidebar-toggles">
      <button data-action="toggle-theme" title="Toggle theme">🌓 Theme</button>
      <button data-action="toggle-sound" title="Toggle sounds">🔇 Sound</button>
    </div>
    <button class="logout-btn" data-action="logout">🔓 Logout</button>
  </div>
</aside>

<!-- Session Viewer Modal -->
<div id="session-modal">
  <div class="sm-card">
    <div class="sm-header">
      <h3><span style="font-size:20px">📜</span> Session History <span id="sm-id" style="font-family:monospace;font-size:12px;color:var(--text-dim);font-weight:normal"></span></h3>
      <button class="sm-close" data-action="close-session-modal">✕</button>
    </div>
    <div class="sm-body">
      <div id="sm-loading" style="text-align:center;padding:40px;color:var(--text-dim)">Fetching history...</div>
      <div id="sm-content" class="sm-history" style="display:none"></div>
    </div>
  </div>
</div>

<!-- Onboarding Modal -->
<div id="onboarding-modal">
  <div class="ob-card">
    <div class="ob-header">
      <div class="ob-header-content">
        <div class="ob-icon">⚡</div>
        <h2>Welcome to TITAN</h2>
        <p id="ob-subtitle">Let's get your local AI agent configured.</p>
        <div class="ob-progress">
          <div class="ob-dot active" id="dot-1"></div>
          <div class="ob-dot" id="dot-2"></div>
          <div class="ob-dot" id="dot-3"></div>
          <div class="ob-dot" id="dot-4"></div>
        </div>
      </div>
    </div>
    <div class="ob-body">
      <!-- Step 1: Profile -->
      <div class="ob-step active" id="ob-step-1">
        <div class="ob-step-title">1. Personalize Your Experience</div>
        <div class="ob-step-desc">TITAN adapts to your technical level and communication style.</div>
        <div class="form-group" style="margin-bottom:20px">
          <label>What should I call you?</label>
          <input type="text" id="ob-name" placeholder="e.g. Commander" style="padding:14px;font-size:15px"/>
        </div>
        <div class="form-group">
          <label>Technical Level</label>
          <select id="ob-level" style="padding:14px;font-size:14px">
            <option value="intermediate">Intermediate — I know the basics</option>
            <option value="beginner">Beginner — Explain everything cleanly</option>
            <option value="expert">Expert — Maximize density, no hand-holding</option>
          </select>
        </div>
      </div>

      <!-- Step 2: Soul -->
      <div class="ob-step" id="ob-step-2">
        <div class="ob-step-title">2. Define TITAN's Personality</div>
        <div class="ob-step-desc">Tell TITAN about yourself and how you want it to behave. This becomes its SOUL.md — the core personality prompt injected into every conversation. Edit the examples below or write your own.</div>
        <div class="form-group" style="margin-bottom:16px">
          <label>About You (what should TITAN know?)</label>
          <textarea id="ob-about-me" rows="4" style="padding:14px;font-size:14px;resize:vertical;width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);outline:none;font-family:inherit">I'm a software developer and entrepreneur. I build side projects and automate workflows. I prefer direct, practical answers over theory.</textarea>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>How should TITAN act?</label>
          <textarea id="ob-personality" rows="4" style="padding:14px;font-size:14px;resize:vertical;width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);outline:none;font-family:inherit">Be a technical partner, not a tutor. Think like an architect. Suggest better approaches proactively. Keep answers concise unless I ask for detail.</textarea>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">
          <strong>Other personality ideas:</strong>
          <ul style="margin:6px 0 0 16px;padding:0;line-height:1.8">
            <li>"Be friendly and encouraging. Explain things step by step. Use analogies."</li>
            <li>"Act like a senior engineer doing code review. Be critical but constructive."</li>
            <li>"Be witty and casual. Use humor. Keep things fun but productive."</li>
            <li>"Be a business strategist. Focus on ROI, market fit, and actionable next steps."</li>
          </ul>
        </div>
      </div>

      <!-- Step 3: Provider -->
      <div class="ob-step" id="ob-step-3">
        <div class="ob-step-title">3. Choose Your Engine</div>
        <div class="ob-step-desc">Select where TITAN should run its core reasoning loop.</div>
        
        <div class="provider-box selected" data-action="select-provider" data-radio="ob-prov-local">
          <div class="provider-icon">🦙</div>
          <div style="flex:1">
            <strong>Local (Ollama)</strong>
            <p>Free, private, runs entirely on your own hardware. Best with Kimi or Llama 3.</p>
          </div>
          <input type="radio" name="ob_provider" id="ob-prov-local" value="local" checked style="display:none" />
        </div>

        <div class="provider-box" data-action="select-provider" data-radio="ob-prov-cloud">
          <div class="provider-icon">☁️</div>
          <div style="flex:1">
            <strong>Cloud (Anthropic / OpenAI)</strong>
            <p>Requires an API key. Lightning fast complex multi-tool reasoning.</p>
          </div>
          <input type="radio" name="ob_provider" id="ob-prov-cloud" value="cloud" style="display:none" />
        </div>
      </div>

      <!-- Step 4: Autonomy -->
      <div class="ob-step" id="ob-step-4">
        <div class="ob-step-title">4. Set Guardrails</div>
        <div class="ob-step-desc">Establish how much freedom TITAN has on your machine.</div>
        <div class="form-group">
          <label>Autonomy Mode</label>
          <select id="ob-autonomy" style="padding:14px;font-size:14px">
            <option value="supervised">🟡 Supervised (Default) — Asks before running risky commands</option>
            <option value="autonomous">🟢 Autonomous — Full auto execution</option>
            <option value="locked">🔴 Locked — User must approve every tool call</option>
          </select>
        </div>
      </div>
    </div>
    <div class="ob-footer">
      <button class="ob-btn ob-btn-secondary" id="ob-btn-back" data-action="ob-prev" style="visibility:hidden">Back</button>
      <button class="ob-btn ob-btn-secondary" data-action="ob-skip" style="font-size:12px;padding:8px 16px">Skip for now</button>
      <button class="ob-btn ob-btn-primary" id="ob-btn-next" data-action="ob-next">Continue ⚡</button>
    </div>
  </div>
</div>

<main class="main">
  <header class="topbar">
    <h2 id="panel-title">📊 Overview</h2>
    <div class="status">
      <div class="status-dot" id="ws-dot"></div>
      <span class="status-label" id="ws-label">Connecting...</span>
      <span class="status-label" id="uptime-label"></span>
    </div>
  </header>

  <div class="content">
    <div id="hint-banner" class="hint-banner" style="display:none" onclick="dismissHint()">
      <span class="hint-icon">💡</span>
      <span id="hint-text"></span>
      <span class="hint-dismiss">&times;</span>
    </div>
    <!-- Overview Panel -->
    <div id="panel-overview" class="panel active">
      <div class="card-grid">
        <div class="stat-card cyan"><div class="stat-label">Active Agents</div><div class="stat-value" id="s-agents">—</div><div class="stat-sub">of 5 max</div></div>
        <div class="stat-card purple"><div class="stat-label">Sessions</div><div class="stat-value" id="s-sessions">—</div><div class="stat-sub">active</div></div>
        <div class="stat-card green"><div class="stat-label">Skills Loaded</div><div class="stat-value" id="s-skills">—</div><div class="stat-sub">built-in + custom</div></div>
        <div class="stat-card amber"><div class="stat-label">Total Requests</div><div class="stat-value" id="s-requests">—</div><div class="stat-sub">this session</div><div id="spark-tokens" style="margin-top:4px"></div></div>
        <div class="stat-card" style="border-color:#10b981"><div class="stat-label">Avg Response</div><div class="stat-value" id="s-resp-time">—</div><div class="stat-sub">ms</div><div id="spark-resp"></div></div>
        <div class="stat-card" style="border-color:#f59e0b"><div class="stat-label">Est. Cost</div><div class="stat-value" id="s-cost">—</div><div class="stat-sub">USD</div><div id="spark-cost"></div></div>
      </div>
      <div class="card">
        <h3>System Health</h3>
        <div id="health-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
          <div><span style="color:var(--text-dim);font-size:12px">Version</span><div style="font-weight:600;margin-top:4px" id="h-version">—</div></div>
          <div><span style="color:var(--text-dim);font-size:12px">Uptime</span><div style="font-weight:600;margin-top:4px" id="h-uptime">—</div></div>
          <div><span style="color:var(--text-dim);font-size:12px">Memory</span><div style="font-weight:600;margin-top:4px" id="h-memory">—</div></div>
          <div><span style="color:var(--text-dim);font-size:12px">Model</span><div style="font-weight:600;margin-top:4px;font-size:13px" id="h-model">—</div></div>
          <div><span style="color:var(--text-dim);font-size:12px">Autonomy</span><div style="font-weight:600;margin-top:4px" id="h-autonomy">—</div></div>
          <div><span style="color:var(--text-dim);font-size:12px">Tokens Used</span><div style="font-weight:600;margin-top:4px" id="h-tokens">—</div></div>
          <div><span style="color:var(--text-dim);font-size:12px">Tunnel</span><div style="font-weight:600;margin-top:4px;font-size:13px" id="h-tunnel">Disabled</div></div>
        </div>
      </div>
      <div class="card" id="cost-card" style="display:none;margin-top:20px">
        <h3>Cost Breakdown</h3>
        <div id="cost-breakdown" style="font-size:13px;color:var(--text-dim)">Loading...</div>
      </div>
      <div class="card" id="update-card" style="display:none;background:rgba(6,182,212,0.1);border:1px solid var(--accent);margin-top:20px;justify-content:space-between;align-items:center">
        <div>
          <h3 style="color:var(--accent);margin:0"><span style="font-size:18px">🚀</span> Update Available</h3>
          <p style="color:var(--text);font-size:13px;margin:4px 0 0 0">TITAN <span id="update-latest-version" style="font-weight:bold"></span> is available! Currently running <span id="update-current-version" style="font-weight:bold"></span>.</p>
        </div>
        <button class="btn" style="background:var(--accent);color:#fff" data-action="trigger-update">Update Now</button>
      </div>
    </div>

    <!-- Chat Panel -->
    <div id="panel-chat" class="panel">
      <div class="card" style="height:calc(100vh - 140px);display:flex;flex-direction:column;padding:0;overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0">
          <h3 style="margin:0">💬 WebChat — talk to TITAN directly</h3>
        </div>
        <div class="chat-messages" id="chat-messages">
          <div class="msg assistant">👋 Hello! I'm TITAN. How can I help you today?</div>
        </div>
        <div class="chat-input-area">
          <input type="text" id="chat-input" placeholder="Type a message and press Enter…"/>
          <button id="send-btn" data-action="send-chat">Send ⚡</button>
        </div>
        <div style="padding:10px 16px;border-top:1px solid var(--border);background:var(--bg2);display:flex;gap:8px;flex-shrink:0">
          <button class="btn" style="font-size:11px;padding:4px 8px" data-action="chat-status">📊 Status</button>
          <button class="btn" style="font-size:11px;padding:4px 8px" data-action="chat-reset">🔄 Reset Session</button>
          <button class="btn" style="font-size:11px;padding:4px 8px" data-action="chat-compact">📦 Compact Context</button>
        </div>
      </div>
    </div>

    <!-- Agents Panel -->
    <div id="panel-agents" class="panel">
      <div class="card">
        <h3>Spawn New Agent</h3>
        <div class="form-row">
          <div class="form-group"><label>Agent Name</label><input type="text" id="agent-name" placeholder="e.g. Code Reviewer"/></div>
          <div class="form-group"><label>Model (optional)</label><input type="text" id="agent-model" placeholder="e.g. anthropic/claude-sonnet-4-20250514"/></div>
        </div>
        <button class="btn primary" data-action="spawn-agent">⚡ Spawn Agent</button>
      </div>
      <div class="card">
        <h3>Agent Instances <span style="color:var(--text-dim);font-weight:400" id="agent-cap"></span></h3>
        <div id="agents-list"><div class="empty-state"><div class="icon">🤖</div><p>No agents running. Spawn one above.</p></div></div>
      </div>
    </div>

    <!-- Settings Panel -->
    <div id="panel-config" class="panel">
      <div class="card" style="padding:0;overflow:hidden">
        <div class="settings-tabs-nav" style="display:flex;gap:4px;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--bg3);flex-wrap:wrap">
          <button class="stab-btn active" data-stab="model" style="padding:7px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;font-weight:500;cursor:pointer;background:var(--accent);color:#fff;transition:all .15s">🤖 AI &amp; Model</button>
          <button class="stab-btn" data-stab="providers" style="padding:7px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;font-weight:500;cursor:pointer;background:var(--bg3);color:var(--text-dim);transition:all .15s">🔑 Providers</button>
          <button class="stab-btn" data-stab="channels-cfg" style="padding:7px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;font-weight:500;cursor:pointer;background:var(--bg3);color:var(--text-dim);transition:all .15s">📡 Channels</button>
          <button class="stab-btn" data-stab="security-cfg" style="padding:7px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;font-weight:500;cursor:pointer;background:var(--bg3);color:var(--text-dim);transition:all .15s">🔒 Security</button>
          <button class="stab-btn" data-stab="gateway-cfg" style="padding:7px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;font-weight:500;cursor:pointer;background:var(--bg3);color:var(--text-dim);transition:all .15s">🌐 Gateway</button>
          <button class="stab-btn" data-stab="profile-cfg" style="padding:7px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;font-weight:500;cursor:pointer;background:var(--bg3);color:var(--text-dim);transition:all .15s">👤 Profile</button>
          <button class="stab-btn" data-stab="mesh-cfg" style="padding:7px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;font-weight:500;cursor:pointer;background:var(--bg3);color:var(--text-dim);transition:all .15s">🕸 Mesh</button>
          <button class="stab-btn" data-stab="plugins-cfg" style="padding:7px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;font-weight:500;cursor:pointer;background:var(--bg3);color:var(--text-dim);transition:all .15s">🔌 Plugins</button>
        </div>

        <!-- Tab 1: AI & Model -->
        <div id="stab-model" class="stab-content" style="padding:20px;display:block">
          <div class="form-group">
            <label>Active Model</label>
            <select id="cfg-model" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;color:var(--text);font-size:13px;outline:none"><option>Loading models...</option></select>
            <div id="fallback-indicator" style="display:none;margin-top:8px;padding:8px 12px;background:rgba(255,165,0,0.1);border:1px solid rgba(255,165,0,0.3);border-radius:var(--radius-sm);font-size:12px;color:#ffa500"></div>
            <input type="text" id="cfg-model-manual" placeholder="Or type a custom model ID (e.g. ollama/my-model)" style="width:100%;margin-top:8px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;color:var(--text);font-size:13px;outline:none"/>
            <button class="btn" data-action="refresh-ollama" style="margin-top:8px;font-size:12px">🔄 Refresh Ollama Models</button>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Autonomy Mode</label>
              <select id="cfg-autonomy">
                <option value="supervised">🟡 Supervised (safe default)</option>
                <option value="autonomous">🟢 Autonomous (full auto)</option>
                <option value="locked">🔴 Locked (approve every action)</option>
              </select>
            </div>
            <div class="form-group">
              <label>Log Level</label>
              <select id="cfg-loglevel">
                <option value="info">Info (recommended)</option>
                <option value="debug">Debug (verbose)</option>
                <option value="warn">Warn (quiet)</option>
                <option value="silent">Silent</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Temperature: <span id="cfg-temp-val">0.7</span></label>
              <input type="range" id="cfg-temperature" min="0" max="2" step="0.1" value="0.7" oninput="document.getElementById('cfg-temp-val').textContent=parseFloat(this.value).toFixed(1)" style="width:100%;accent-color:var(--accent)"/>
            </div>
            <div class="form-group">
              <label>Max Tokens</label>
              <input type="number" id="cfg-maxtokens" placeholder="8192" min="256" max="200000"/>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Reasoning Effort (Supported models only)</label>
              <select id="cfg-reasoning">
                <option value="none">Disabled</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Custom System Prompt (appended after TITAN's core identity)</label>
            <textarea id="cfg-systemprompt" rows="5" placeholder="Add extra instructions for TITAN (e.g. 'Always respond in Spanish')" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;color:var(--text);font-size:13px;outline:none;resize:vertical;font-family:inherit"></textarea>
          </div>
          <div class="form-actions">
            <button class="btn primary" data-action="save-ai">💾 Save AI Settings</button>
            <button class="btn" data-action="reload-config">↺ Reset</button>
          </div>
        </div>

        <!-- Tab 2: Providers & API Keys -->
        <div id="stab-providers" class="stab-content" style="padding:20px;display:none">
          <p style="color:var(--text-dim);font-size:13px;margin-bottom:20px">🔒 Keys stored locally in <code style="background:var(--bg3);padding:2px 6px;border-radius:4px">~/.titan/titan.json</code> — never sent anywhere except the provider's API</p>
          <div class="form-group">
            <label>Anthropic API Key</label>
            <div style="display:flex;gap:8px">
              <input type="password" id="cfg-anthropic-key" placeholder="sk-ant-api03-... (leave blank to keep current)" style="flex:1"/>
              <span id="cfg-anthropic-status" style="align-self:center;font-size:12px;color:var(--text-dim)"></span>
            </div>
          </div>
          <div class="form-group">
            <label>OpenAI API Key</label>
            <div style="display:flex;gap:8px">
              <input type="password" id="cfg-openai-key" placeholder="sk-proj-... (leave blank to keep current)" style="flex:1"/>
              <span id="cfg-openai-status" style="align-self:center;font-size:12px;color:var(--text-dim)"></span>
            </div>
          </div>
          <div class="form-group">
            <label>Google API Key</label>
            <div style="display:flex;gap:8px">
              <input type="password" id="cfg-google-key" placeholder="AIza... (leave blank to keep current)" style="flex:1"/>
              <span id="cfg-google-status" style="align-self:center;font-size:12px;color:var(--text-dim)"></span>
            </div>
          </div>
          <div class="form-group">
            <label>Ollama Base URL</label>
            <div style="display:flex;gap:8px">
              <input type="text" id="cfg-ollama-url" placeholder="http://&lt;host&gt;:11434 (e.g. http://192.168.1.100:11434)" style="flex:1"/>
              <button class="btn" data-action="test-ollama">Test ⚡</button>
            </div>
            <span id="cfg-ollama-status" style="font-size:12px;color:var(--text-dim);margin-top:4px;display:block"></span>
          </div>
          <div style="border-top:1px solid var(--border);margin-top:20px;padding-top:20px">
            <h4 style="font-size:14px;margin-bottom:12px;color:var(--text-bright)">📧 Google Account (Gmail OAuth)</h4>
            <p style="color:var(--text-dim);font-size:12px;margin-bottom:12px">Connect your Google account to enable Gmail search, read, and send via Gmail API.</p>
            <div id="google-oauth-status" style="margin-bottom:12px;font-size:13px;color:var(--text-dim)">Checking...</div>
            <div class="form-group" style="margin-bottom:8px">
              <label>Google OAuth Client ID</label>
              <input type="password" id="cfg-google-oauth-id" placeholder="From Google Cloud Console" style="font-size:12px"/>
            </div>
            <div class="form-group" style="margin-bottom:12px">
              <label>Google OAuth Client Secret</label>
              <input type="password" id="cfg-google-oauth-secret" placeholder="From Google Cloud Console" style="font-size:12px"/>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn" id="google-connect-btn" data-action="connect-google">🔗 Connect Google Account</button>
              <button class="btn" id="google-disconnect-btn" data-action="disconnect-google" style="display:none;border-color:var(--error);color:var(--error)">Disconnect</button>
            </div>
          </div>
          <div class="form-actions" style="margin-top:16px">
            <button class="btn primary" data-action="save-providers">💾 Save Provider Settings</button>
          </div>
        </div>

        <!-- Tab 3: Channels -->
        <div id="stab-channels-cfg" class="stab-content" style="padding:20px;display:none">
          <p style="color:var(--text-dim);font-size:13px;margin-bottom:16px">Enable and configure messaging channels. Tokens are stored in <code style="background:var(--bg3);padding:2px 6px;border-radius:4px">~/.titan/titan.json</code>.</p>
          ${['discord', 'telegram', 'slack', 'googlechat', 'whatsapp', 'signal', 'matrix', 'msteams'].map(ch => `
          <div class="card" style="margin-bottom:12px;padding:16px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:${ch === 'whatsapp' || ch === 'signal' ? '8' : '12'}px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0">
                <input type="checkbox" id="cfg-${ch}-enabled" style="width:16px;height:16px;accent-color:var(--accent)"/>
                <strong style="font-size:14px">${ch === 'discord' ? '🎮 Discord' : ch === 'telegram' ? '✈️ Telegram' : ch === 'slack' ? '💼 Slack' : ch === 'googlechat' ? '💬 Google Chat' : ch === 'whatsapp' ? '📱 WhatsApp' : ch === 'signal' ? '🔐 Signal' : ch === 'matrix' ? '🟦 Matrix' : '🏢 MS Teams'}</strong>
              </label>
            </div>
            ${ch === 'whatsapp' ? '<p style="color:var(--warn);font-size:12px;margin-bottom:8px">⚠️ WhatsApp requires phone pairing — run <code>titan pairing</code> after enabling</p>' : ''}
            ${ch === 'signal' ? '<p style="color:var(--warn);font-size:12px;margin-bottom:8px">⚠️ Signal requires a Signal bridge service running separately</p>' : ''}
            ${ch !== 'whatsapp' ? `<div class="form-group" style="margin-bottom:8px"><label>${ch === 'googlechat' ? 'Incoming Webhook URL' : 'Bot Token'}</label><input type="password" id="cfg-${ch}-token" placeholder="${ch === 'googlechat' ? 'https://chat.googleapis.com/...' : ch + ' bot token'}" style="font-size:12px"/></div>` : ''}
            <div class="form-group" style="margin-bottom:8px">
              <label>DM Policy</label>
              <select id="cfg-${ch}-dmpolicy" style="font-size:12px">
                <option value="pairing">Pairing (users must be approved)</option>
                <option value="open">Open (anyone can DM)</option>
                <option value="closed">Closed (no DMs)</option>
              </select>
            </div>
            <button class="btn" data-action="save-channel" data-channel="${ch}" style="font-size:12px">Save ${ch}</button>
          </div>`).join('')}
        </div>

        <!-- Tab 4: Security -->
        <div id="stab-security-cfg" class="stab-content" style="padding:20px;display:none">
          <div class="form-group">
            <label>Sandbox Mode</label>
            <select id="cfg-sandbox">
              <option value="host">🖥️ Host (full access)</option>
              <option value="docker">🐳 Docker (isolated containers)</option>
              <option value="none">🚫 None (no restrictions)</option>
            </select>
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" id="cfg-shield-enabled" style="width:16px;height:16px;accent-color:var(--accent)" onchange="document.getElementById('shield-mode-row').style.display=this.checked?'block':'none'"/>
              Prompt Injection Shield (blocks chat-based hijacking attempts)
            </label>
          </div>
          <div id="shield-mode-row" style="display:none">
            <div class="form-group">
              <label>Shield Strictness</label>
              <select id="cfg-shield-mode">
                <option value="strict">Strict (aggressive — recommended)</option>
                <option value="standard">Standard (blocks obvious attempts only)</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Denied Tools (comma-separated — agents can NEVER use these)</label>
            <input type="text" id="cfg-denied-tools" placeholder="e.g. shell, write_file"/>
          </div>
          <div class="form-group">
            <label>Network Allowlist (comma-separated domains, * = all, blank = block all)</label>
            <input type="text" id="cfg-network-allowlist" placeholder="e.g. api.github.com, *.anthropic.com"/>
          </div>
          <div class="form-actions">
            <button class="btn primary" data-action="save-security">💾 Save Security Settings</button>
          </div>
        </div>

        <!-- Tab 5: Gateway -->
        <div id="stab-gateway-cfg" class="stab-content" style="padding:20px;display:none">
          <div class="form-group" style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:var(--radius-sm);padding:12px;margin-bottom:16px">
            <span style="color:var(--warn)">⚠️ Changing port or auth mode requires a gateway restart to take effect.</span>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Gateway Port</label>
              <input type="number" id="cfg-gateway-port" placeholder="48420"/>
            </div>
            <div class="form-group">
              <label>Auth Mode</label>
              <select id="cfg-gateway-auth" onchange="updateGatewayAuthFields()">
                <option value="none">None (open — local only)</option>
                <option value="token">Token (API key in header)</option>
                <option value="password">Password (browser login)</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Tailscale Remote Access</label>
              <select id="cfg-tailscale-mode">
                <option value="off">Off (Local Only)</option>
                <option value="serve">Serve (Tailnet Only - HTTPS)</option>
                <option value="funnel">Funnel (Public Internet - HTTPS)</option>
              </select>
            </div>
          </div>
          <div id="gateway-token-row" style="display:none">
            <div class="form-group">
              <label>Gateway Token</label>
              <input type="password" id="cfg-gateway-token" placeholder="Set a secure token"/>
            </div>
          </div>
          <div id="gateway-password-row" style="display:none">
            <div class="form-group">
              <label>Gateway Password</label>
              <input type="password" id="cfg-gateway-password" placeholder="Set a secure password"/>
            </div>
          </div>
          <div class="form-actions">
            <button class="btn primary" data-action="save-gateway">💾 Save Gateway Settings</button>
          </div>
        </div>

        <!-- Tab 6: Profile -->
        <div id="stab-profile-cfg" class="stab-content" style="padding:20px;display:none">
          <p style="color:var(--text-dim);font-size:13px;margin-bottom:16px">TITAN uses this to personalize responses — like a JARVIS that knows you.</p>
          <div class="form-row">
            <div class="form-group">
              <label>Your Name</label>
              <input type="text" id="cfg-profile-name" placeholder="e.g. Alex"/>
            </div>
            <div class="form-group">
              <label>Technical Level</label>
              <select id="cfg-profile-level">
                <option value="beginner">Beginner — explain everything in plain English</option>
                <option value="intermediate">Intermediate — I know the basics</option>
                <option value="expert">Expert — no hand-holding</option>
                <option value="unknown">Unset</option>
              </select>
            </div>
          </div>
          <div class="form-group" style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;font-size:13px;color:var(--text-dim)">
            <span id="cfg-profile-stats">Loading profile stats...</span>
          </div>
          <div class="form-actions" style="margin-bottom:20px">
            <button class="btn primary" data-action="save-profile">💾 Save Profile</button>
          </div>
          <div style="border-top:1px solid var(--border);padding-top:20px">
            <h4 style="font-size:14px;margin-bottom:8px;color:var(--text-bright)">🧬 SOUL.md — Personality Prompt</h4>
            <p style="color:var(--text-dim);font-size:12px;margin-bottom:12px">This file is injected into every conversation. Edit it to shape how TITAN behaves.</p>
            <textarea id="cfg-soul-content" rows="12" placeholder="# SOUL.md\n\nDefine TITAN's personality here..." style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;color:var(--text);font-size:13px;outline:none;resize:vertical;font-family:'JetBrains Mono','Fira Code',monospace;line-height:1.5"></textarea>
            <div class="form-actions" style="margin-top:8px">
              <button class="btn primary" data-action="save-soul">💾 Save SOUL.md</button>
            </div>
          </div>
        </div>

        <!-- Tab 7: Mesh Networking -->
        <div id="stab-mesh-cfg" class="stab-content" style="padding:20px;display:none">
          <p style="color:var(--text-dim);font-size:13px;margin-bottom:16px">Connect up to 5 TITAN nodes together to share models and API keys across machines.</p>

          <div id="mesh-status-bar" style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;font-size:13px;color:var(--text-dim);margin-bottom:16px">
            Loading mesh status...
          </div>

          <h4 style="font-size:14px;margin-bottom:8px;color:var(--text-bright)">Pending Peers</h4>
          <p style="color:var(--text-dim);font-size:12px;margin-bottom:8px">Discovered machines waiting for your approval.</p>
          <div id="mesh-pending-list" style="margin-bottom:20px">
            <div style="color:var(--text-dim);font-size:13px;padding:8px">No pending peers</div>
          </div>

          <h4 style="font-size:14px;margin-bottom:8px;color:var(--text-bright)">Connected Peers</h4>
          <div id="mesh-peers-list" style="margin-bottom:16px">
            <div style="color:var(--text-dim);font-size:13px;padding:8px">No connected peers</div>
          </div>

          <div class="form-actions">
            <button class="btn" data-action="refresh-mesh">🔄 Refresh</button>
          </div>
        </div>

        <!-- Tab 8: Plugins -->
        <div id="stab-plugins-cfg" class="stab-content" style="padding:20px;display:none">
          <p style="color:var(--text-dim);font-size:13px;margin-bottom:16px">Context Engine plugins extend how TITAN assembles and compacts conversation context.</p>
          <div id="plugins-info-list" style="margin-bottom:16px">
            <div style="color:var(--text-dim);font-size:13px;padding:8px">No plugins loaded</div>
          </div>
          <div class="form-actions">
            <button class="btn" data-action="refresh-plugins">🔄 Refresh</button>
          </div>
        </div>

      </div>
    </div>

    <!-- Channels Panel -->
    <div id="panel-channels" class="panel">
      <div class="card">
        <h3>Channel Status</h3>
        <p style="color:var(--text-dim);font-size:13px;margin-bottom:16px">To configure channel tokens, edit <code style="background:var(--bg3);padding:2px 6px;border-radius:4px">~/.titan/titan.json</code> or re-run <code style="background:var(--bg3);padding:2px 6px;border-radius:4px">titan onboard</code>.</p>
        <div id="channels-list">Loading...</div>
      </div>
    </div>

    <!-- Skills Panel -->
    <div id="panel-skills" class="panel">
      <div class="card">
        <h3>Installed Skills</h3>
        <div id="skills-list">Loading...</div>
      </div>
    </div>

    <!-- Sessions Panel -->
    <div id="panel-sessions" class="panel">
      <div class="card">
        <h3>Active Sessions</h3>
        <div id="sessions-list">Loading...</div>
      </div>
    </div>

    <!-- Learning Panel -->
    <div id="panel-learning" class="panel">
      <div class="card-grid">
        <div class="stat-card cyan"><div class="stat-label">Knowledge Entries</div><div class="stat-value" id="l-entries">—</div></div>
        <div class="stat-card purple"><div class="stat-label">Tools Tracked</div><div class="stat-value" id="l-tools">—</div></div>
        <div class="stat-card green"><div class="stat-label">Error Patterns</div><div class="stat-value" id="l-errors">—</div></div>
        <div class="stat-card amber"><div class="stat-label">User Corrections</div><div class="stat-value" id="l-corrections">—</div></div>
      </div>
      <div class="card">
        <h3>About the Learning Engine</h3>
        <p style="color:var(--text-dim);font-size:13px;line-height:1.6">TITAN's continuous learning engine records every tool execution, user correction, and successful pattern. It builds a knowledge base that is injected into every system prompt — making TITAN more effective with each interaction. Knowledge is stored in <code style="background:var(--bg3);padding:2px 6px;border-radius:4px">~/.titan/knowledge.json</code>.</p>
      </div>
    </div>

    <!-- Security Panel -->
    <div id="panel-security" class="panel">
      <div class="card">
        <h3>Security Audit</h3>
        <div id="security-audit">Loading...</div>
      </div>
    </div>

    <!-- Logs Panel -->
    <div id="panel-logs" class="panel">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px">
          <h3 style="margin:0">📜 Live Logs</h3>
          <div style="display:flex;gap:8px;align-items:center;flex:1;max-width:400px">
            <input id="log-filter" type="text" placeholder="Filter logs…" oninput="filterLogs()" style="flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 12px;color:var(--text);font-size:13px;outline:none"/>
            <button class="btn" data-action="refresh-logs" style="padding:6px 14px;font-size:12px">↻ Refresh</button>
          </div>
        </div>
        <div id="logs-container" style="font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.6;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;max-height:calc(100vh - 280px);overflow-y:auto;white-space:pre-wrap;word-break:break-all">Loading...</div>
      </div>
    </div>

    <!-- Memory Graph Panel -->
    <div id="panel-workflows" class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="display:flex;gap:8px">
          <button class="btn" onclick="wfNew()">+ New Workflow</button>
          <button class="btn" onclick="wfImportYaml()">Import YAML</button>
        </div>
        <span id="wf-count" style="color:#94a3b8;font-size:13px"></span>
      </div>
      <div id="wf-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px"></div>
      <div id="wf-editor" style="display:none;margin-top:16px">
        <div style="background:rgba(17,24,39,0.7);border:1px solid #2a3050;border-radius:12px;padding:20px">
          <h3 id="wf-editor-title" style="color:#06b6d4;margin-bottom:16px">New Workflow</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div><label style="font-size:11px;color:#94a3b8;text-transform:uppercase">Name</label><input id="wf-name" class="input" placeholder="My Workflow"></div>
            <div><label style="font-size:11px;color:#94a3b8;text-transform:uppercase">Slash Command</label><input id="wf-slash" class="input" placeholder="my-workflow"></div>
          </div>
          <div style="margin-bottom:16px"><label style="font-size:11px;color:#94a3b8;text-transform:uppercase">Description</label><input id="wf-desc" class="input" placeholder="What does this workflow do?" style="width:100%"></div>
          <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;color:#06b6d4;font-weight:600">Steps</span>
            <button class="btn" onclick="wfAddStep()" style="font-size:12px;padding:4px 12px">+ Step</button>
          </div>
          <div id="wf-steps" style="display:flex;flex-direction:column;gap:8px"></div>
          <div style="margin-top:16px">
            <canvas id="wf-canvas" width="700" height="120" style="width:100%;border:1px solid #2a3050;border-radius:8px;background:rgba(10,14,26,0.5)"></canvas>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn" onclick="wfSave()" style="background:#06b6d4;color:#0a0e1a">Save Workflow</button>
            <button class="btn" onclick="wfExportYaml()">Export YAML</button>
            <button class="btn" onclick="wfCancel()" style="opacity:0.7">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <div id="panel-graphiti" class="panel">
      <div class="card-grid">
        <div class="stat-card cyan"><div class="stat-label">Graph Status</div><div class="stat-value" id="g-neo4j" style="font-size:18px">—</div></div>
        <div class="stat-card purple"><div class="stat-label">Episodes</div><div class="stat-value" id="g-mcp">—</div></div>
        <div class="stat-card green"><div class="stat-label">Entities</div><div class="stat-value" id="g-nodes">—</div></div>
        <div class="stat-card amber"><div class="stat-label">Edges</div><div class="stat-value" id="g-edges">—</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">🕸️ Memory Graph</h3>
          <div style="display:flex;gap:8px">
            <button class="btn" data-action="refresh-graphiti" style="font-size:12px;padding:6px 14px">↻ Refresh</button>
            <button class="btn danger" data-action="clear-graph" style="font-size:12px;padding:6px 14px">🗑 Clear Graph</button>
            <button class="btn danger" data-action="clear-all-data" style="font-size:12px;padding:6px 14px">⚠ Reset All Data</button>
          </div>
        </div>
        <div id="graphiti-status" style="display:none;color:var(--text-dim);font-size:13px;margin-bottom:16px;padding:10px;background:var(--bg3);border-radius:var(--radius-sm)">
          Run <code style="background:var(--bg);padding:2px 6px;border-radius:4px">titan graphiti --init</code> to initialize the native graph memory.
        </div>
        <canvas id="graphiti-canvas" width="800" height="420" style="width:100%;background:var(--bg3);border-radius:var(--radius-sm);cursor:pointer;display:none"></canvas>
        <div id="graphiti-empty" style="display:none;text-align:center;color:var(--text-dim);padding:60px 20px;font-size:13px">
          No entities in graph memory yet. Start chatting — TITAN will build memories automatically via entity extraction.
        </div>
        <div id="graph-entity-detail" style="display:none;margin-top:16px;padding:16px;background:var(--bg3);border-radius:var(--radius-sm);border:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h4 id="ged-name" style="margin:0;font-size:15px"></h4>
            <span id="ged-type" class="badge info"></span>
          </div>
          <div id="ged-aliases" style="font-size:12px;color:var(--text-dim);margin-top:6px"></div>
          <ul id="ged-facts" style="font-size:13px;margin:10px 0 0;padding-left:18px"></ul>
          <div id="ged-seen" style="font-size:11px;color:var(--text-dim);margin-top:8px"></div>
        </div>
        <div id="graphiti-node-list" style="display:none;margin-top:16px"></div>
      </div>
    </div>

    <!-- Telemetry Panel -->
    <div id="panel-telemetry" class="panel">
      <div class="card-grid">
        <div class="stat-card cyan"><div class="stat-label">Total Requests</div><div class="stat-value" id="tm-requests">—</div></div>
        <div class="stat-card purple"><div class="stat-label">Avg Latency</div><div class="stat-value" id="tm-latency" style="font-size:20px">—</div></div>
        <div class="stat-card green"><div class="stat-label">Error Rate</div><div class="stat-value" id="tm-error-rate">—</div></div>
        <div class="stat-card amber"><div class="stat-label">Total Errors</div><div class="stat-value" id="tm-errors">—</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">Top Tools by Usage</h3>
          <button class="btn" data-action="refresh-telemetry" style="font-size:12px;padding:6px 14px">↻ Refresh</button>
        </div>
        <table>
          <thead><tr><th>Tool</th><th>Calls</th></tr></thead>
          <tbody id="tm-top-tools"><tr><td colspan="2" style="color:var(--text-dim)">No data yet</td></tr></tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>Token Usage</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px">
          <div class="stat-card cyan"><div class="stat-label">Prompt Tokens</div><div class="stat-value" id="tm-prompt-tokens" style="font-size:20px">—</div></div>
          <div class="stat-card purple"><div class="stat-label">Completion Tokens</div><div class="stat-value" id="tm-completion-tokens" style="font-size:20px">—</div></div>
        </div>
      </div>
      <div style="margin-top:12px;font-size:12px;color:var(--text-dim)">Prometheus endpoint: <code style="background:var(--bg3);padding:2px 8px;border-radius:4px">GET /metrics</code></div>
    </div>

    <!-- Autopilot Panel -->
    <div id="panel-autopilot" class="panel">
      <div class="card-grid">
        <div class="stat-card cyan"><div class="stat-label">Status</div><div class="stat-value" id="ap-status" style="font-size:18px">—</div></div>
        <div class="stat-card purple"><div class="stat-label">Schedule</div><div class="stat-value" id="ap-schedule" style="font-size:14px">—</div></div>
        <div class="stat-card green"><div class="stat-label">Total Runs</div><div class="stat-value" id="ap-total">—</div></div>
        <div class="stat-card amber"><div class="stat-label">Last Run</div><div class="stat-value" id="ap-last" style="font-size:14px">—</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">🚁 Autopilot</h3>
          <div style="display:flex;gap:8px">
            <button class="btn" data-action="refresh-autopilot" style="font-size:12px;padding:6px 14px">↻ Refresh</button>
            <button class="btn" data-action="run-autopilot" style="font-size:12px;padding:6px 14px;background:var(--accent);color:#fff">▶ Run Now</button>
          </div>
        </div>
        <div id="autopilot-info" style="color:var(--text-dim);font-size:13px;margin-bottom:16px;padding:10px;background:var(--bg3);border-radius:var(--radius-sm)">
          Autopilot runs tasks on a schedule using your <code style="background:var(--bg);padding:2px 6px;border-radius:4px">AUTOPILOT.md</code> checklist. Configure in Settings or <code style="background:var(--bg);padding:2px 6px;border-radius:4px">titan.json</code>.
        </div>
        <table class="table" id="autopilot-history-table">
          <thead><tr><th>Run</th><th>Started</th><th>Duration</th><th>Tasks</th><th>Result</th></tr></thead>
          <tbody id="autopilot-history"></tbody>
        </table>
        <div id="autopilot-empty" style="display:none;text-align:center;color:var(--text-dim);padding:40px 20px;font-size:13px">
          No autopilot runs yet. Click "Run Now" or enable the schedule in Settings.
        </div>
      </div>
    </div>

    <!-- Voice Panel -->
    <div id="panel-voice" class="panel">
      <div class="card-grid">
        <div class="stat-card cyan"><div class="stat-label">LiveKit Server</div><div class="stat-value" id="voice-status" style="font-size:16px">Checking...</div></div>
        <div class="stat-card purple"><div class="stat-label">LiveKit URL</div><div class="stat-value" id="voice-livekit-url" style="font-size:12px">—</div></div>
        <div class="stat-card green"><div class="stat-label">TTS Voice</div><div class="stat-value" id="voice-tts-voice" style="font-size:14px">—</div></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">Voice Chat</h3>
        </div>

        <div style="text-align:center;padding:40px 20px">
          <p style="color:var(--text-dim);margin-bottom:24px;font-size:14px;line-height:1.6">
            Voice chat uses LiveKit with a dedicated React UI featuring audio visualizers,<br>
            transcripts, interruption handling, and WebRTC-powered audio.
          </p>
          <div style="display:flex;gap:12px;justify-content:center;align-items:center;flex-wrap:wrap">
            <input id="voice-ui-url" type="text" value="http://localhost:3000" style="width:280px;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:13px;font-family:monospace"/>
            <button class="btn" data-action="voice-open" style="font-size:14px;padding:10px 24px">Open Voice Chat</button>
          </div>
          <p style="color:var(--text-dim);margin-top:20px;font-size:12px">
            Powered by <a href="https://github.com/livekit/agent-starter-react" target="_blank" style="color:var(--accent)">LiveKit agent-starter-react</a>
            &mdash; runs locally on Titan PC
          </p>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3 style="margin:0 0 12px 0">Architecture</h3>
        <pre style="font-size:11px;color:var(--text-dim);line-height:1.5;margin:0;overflow-x:auto">Browser (agent-starter-react, port 3000)
  |  WebRTC
LiveKit Server (Docker, port 7880)
  |  LiveKit Agents SDK
Python Agent (titan-voice-agent)
  +-- STT: faster-whisper (GPU)
  +-- LLM: Ollama qwen3.5:35b
  +-- TTS: Kokoro (CPU)
  |
TITAN Gateway (Mini PC, port 48420)</pre>
      </div>
    </div>

  </div>
  <div class="footer-bar">
    <span><span class="footer-dot on" id="footer-ws-dot"></span><span id="footer-status">Connected</span> · v<span id="footer-ver">—</span></span>
    <span>Up <span id="footer-uptime">0m</span> · <span id="footer-skills">0</span> skills · <span id="footer-nodes">0</span> nodes</span>
  </div>
</main>

<div id="toast"></div>

<script>
// ── Auth ──────────────────────────────────────────────────────────
const token = localStorage.getItem('titan_token');
if (!token) { location.href = '/login'; }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') };
}

function logout() {
  localStorage.removeItem('titan_token');
  location.href = '/login';
}

let toastTimer;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3000);
}

// ── Theme toggle ──────────────────────────────────────────────
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('titan_theme', next);
}
(function initTheme(){const t=localStorage.getItem('titan_theme');if(t)document.documentElement.setAttribute('data-theme',t);})();

// ── Sound toggle ──────────────────────────────────────────────
let soundEnabled = localStorage.getItem('titan_sound') === 'true';
function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('titan_sound', String(soundEnabled));
  const btn = document.querySelector('[data-action="toggle-sound"]');
  if (btn) btn.textContent = soundEnabled ? '🔊 Sound' : '🔇 Sound';
}
(function initSound(){const btn=document.querySelector('[data-action="toggle-sound"]');if(btn)btn.textContent=soundEnabled?'🔊 Sound':'🔇 Sound';})();

// ── Simple markdown renderer for assistant messages ──────────
function renderMarkdown(text) {
  let s = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Code blocks
  s = s.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>');
  // Inline code
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Headers
  s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^### (.+)$/gm, '<h3 style="font-size:15px;margin:12px 0 6px">$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2 style="font-size:17px;margin:14px 0 8px">$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1 style="font-size:20px;margin:16px 0 10px">$1</h1>');
  // Horizontal rule
  s = s.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:12px 0"/>');
  // Bold and italic
  s = s.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  // Links
  s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Lists
  s = s.replace(/^- (.+)$/gm, '<li>$1</li>');
  s = s.replace(new RegExp('(<li>.*</li>[\\n]?)+', 'g'), '<ul>$&</ul>');
  // Numbered lists
  s = s.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
  // Simple table support (| col | col |)
  s = s.replace(/^\\|(.+)\\|$/gm, function(match, inner) {
    const cells = inner.split('|').map(c => c.trim());
    return '<tr>' + cells.map(c => '<td style="padding:4px 8px;border:1px solid var(--border)">' + c + '</td>').join('') + '</tr>';
  });
  s = s.replace(/(<tr>.*<\\/tr>[\\n]?)+/g, '<table style="border-collapse:collapse;margin:8px 0;font-size:13px">$&</table>');
  return s;
}

// ── Animated counter ──────────────────────────────────────────
function animateValue(el, end) {
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  if (start === end || isNaN(end)) { el.textContent = end; return; }
  const duration = 600;
  const startTime = performance.now();
  function step(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (end - start) * eased);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Event delegation ──────────────────────────────────────────
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-panel]');
  if (target) {
    showPanel(target.dataset.panel, target);
    if (target.dataset.load === 'config') { loadConfig(); populateModels(); loadProfileTab(); }
    if (target.dataset.load === 'logs') startLogs();
    if (target.dataset.load === 'workflows') loadWorkflows();
    if (target.dataset.load === 'graphiti') loadGraphiti();
    if (target.dataset.load === 'autopilot') loadAutopilot();
    if (target.dataset.load === 'telemetry') loadTelemetry();
    if (target.dataset.load === 'voice') loadVoicePanel();
    // Close sidebar on mobile
    document.getElementById('sidebar')?.classList.remove('open');
  }
  // Settings tab buttons
  const stab = e.target.closest('[data-stab]');
  if (stab) {
    showStab(stab.dataset.stab);
    return;
  }
  const action = e.target.closest('[data-action]');
  if (action) {
    const a = action.dataset.action;
    if (a === 'logout') logout();
    if (a === 'toggle-theme') toggleTheme();
    if (a === 'toggle-sound') toggleSound();
    if (a === 'toggle-sidebar') document.getElementById('sidebar')?.classList.toggle('open');
    if (a === 'send-chat') sendChat();
    if (a === 'chat-status') { document.getElementById('chat-input').value='/status'; sendChat(); }
    if (a === 'chat-reset') { if(confirm('Reset the current chat session?')) { document.getElementById('chat-input').value='/reset'; sendChat(); } }
    if (a === 'chat-compact') { document.getElementById('chat-input').value='/compact'; sendChat(); }
    if (a === 'spawn-agent') spawnAgent();
    if (a === 'save-ai') saveAIConfig();
    if (a === 'save-providers') saveProviderSettings();
    if (a === 'save-security') saveSecuritySettings();
    if (a === 'save-gateway') saveGatewaySettings();
    if (a === 'save-profile') saveProfileSettings();
    if (a === 'reload-config') loadConfig();
    if (a === 'refresh-ollama') refreshOllamaModels();
    if (a === 'test-ollama') testOllamaConnection();
    if (a === 'refresh-mesh') loadMeshPanel();
    if (a === 'voice-open') { const url = document.getElementById('voice-ui-url').value.trim(); if (url) window.open(url, '_blank'); }
    if (a === 'refresh-plugins') loadPluginsPanel();
    if (a === 'refresh-logs') loadLogs();
    if (a === 'refresh-telemetry') loadTelemetry();
    if (a === 'refresh-graphiti') loadGraphiti();
    if (a === 'clear-graph') clearGraphData();
    if (a === 'clear-all-data') clearAllData();
    if (a === 'refresh-autopilot') loadAutopilot();
    if (a === 'run-autopilot') runAutopilotNow();
    if (a === 'trigger-update') triggerUpdate();
    if (a === 'connect-google') connectGoogle();
    if (a === 'disconnect-google') disconnectGoogleAccount();
    if (a === 'save-soul') saveSoulMd();
    if (a === 'close-session-modal') closeSessionModal();
    if (a === 'save-channel') saveChannelSettings(action.dataset.channel);
    if (a === 'ob-prev') obPrevStep();
    if (a === 'ob-next') obNextStep();
    if (a === 'ob-skip') { document.getElementById('onboarding-modal').classList.remove('show'); fetch('/api/profile',{method:'POST',headers:authHeaders(),body:JSON.stringify({name:'User'})}); }
    if (a === 'select-provider') {
      const radioId = action.dataset.radio;
      if (radioId) document.getElementById(radioId).checked = true;
      document.querySelectorAll('.provider-box').forEach(b => b.classList.remove('selected'));
      action.classList.add('selected');
    }
    if (a === 'stop-agent') stopAgent(action.dataset.id);
    if (a === 'show-session') { e.preventDefault(); showSessionModal(action.dataset.id); }
    if (a === 'stop-session') stopSession(action.dataset.id);
    if (a === 'toggle-skill') toggleSkill(action.dataset.skill);
  }
});

// ── Sparkline data & renderer ─────────────────────────────────────
const sparkTokens = [], sparkCost = [], sparkRespTime = [];
const SPARK_MAX = 20;

function renderSparkline(data, color) {
  if (data.length < 2) return '';
  const w = 120, h = 32, pad = 2;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return x + ',' + y;
  }).join(' ');
  return '<svg width="'+w+'" height="'+h+'" style="display:block;margin-top:4px"><polyline fill="none" stroke="'+color+'" stroke-width="1.5" points="'+points+'"/></svg>';
}

// ── Panel navigation ──────────────────────────────────────────────
const panelTitles = {
  overview:'📊 Overview', chat:'💬 WebChat', voice:'🎙️ Voice', agents:'🤖 Agents',
  config:'⚙️ Settings', channels:'📡 Channels', skills:'🧩 Skills',
  sessions:'🔗 Sessions', learning:'🧠 Learning', security:'🔒 Security',
  logs:'📜 Live Logs', graphiti:'🕸️ Memory Graph', autopilot:'🚁 Autopilot',
  telemetry:'📈 Telemetry', workflows:'🔀 Workflows'
};

// ── Contextual Hints ────────────────────────────────────────────────
const panelHints = {
  overview: 'Tip: Click any stat card to see detailed breakdowns and history.',
  chat: 'Tip: Use /model to switch models mid-conversation, or /help for all commands.',
  skills: "Tip: You can disable skills you don't need to reduce token usage and improve response speed.",
  config: 'Tip: Changes are saved instantly. Use the JSON editor tab for advanced configuration.',
  channels: 'Tip: Each channel can have its own allowlist — restrict who can talk to TITAN per channel.',
  security: 'Tip: Enable Shield strict mode for maximum prompt injection protection.',
  logs: 'Tip: Logs auto-scroll. Click a log entry to see the full payload.',
  sessions: 'Tip: Idle sessions are cleaned up after 30 minutes. Use /clear to reset a session.',
  learning: 'Tip: TITAN learns from corrections — say "no, do X instead" to teach preferences.',
  autopilot: 'Tip: Autopilot runs on a schedule. Add tasks to AUTOPILOT.md or use goal mode.',
  voice: 'Tip: Voice chat uses LiveKit. Run docker compose -f docker-compose.voice.yml up on Titan PC.',
  agents: 'Tip: Each agent runs independently with its own session and tool access.',
  graphiti: 'Tip: The memory graph stores relationships between entities for richer context.',
  workflows: 'Tip: Workflows are reusable multi-step recipes. Export as YAML to share with your team.',
};
let hintDismissed = false;

function showHint(panelName) {
  if (hintDismissed) return;
  const hint = panelHints[panelName];
  const banner = document.getElementById('hint-banner');
  const text = document.getElementById('hint-text');
  if (hint && banner && text) {
    text.textContent = hint;
    banner.style.display = 'flex';
  } else if (banner) {
    banner.style.display = 'none';
  }
}

function dismissHint() {
  const banner = document.getElementById('hint-banner');
  if (banner) banner.style.display = 'none';
  hintDismissed = true;
}

function showPanel(name, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  if (el) el.closest('.nav-item').classList.add('active');
  document.getElementById('panel-title').textContent = panelTitles[name] || name;
  if (name !== 'logs') stopLogs();
  showHint(name);
}

// ── WebSocket ─────────────────────────────────────────────────────
let ws;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '?token=' + encodeURIComponent(token || ''));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    document.getElementById('ws-dot').className = 'status-dot';
    document.getElementById('ws-label').textContent = '🟢 Connected';
  };
  ws.onclose = () => {
    document.getElementById('ws-dot').className = 'status-dot offline';
    document.getElementById('ws-label').textContent = '🔴 Disconnected';
    setTimeout(connectWS, 3000);
  };
  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    toast('WebSocket error — check console', 'error');
  };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) return;
    removeTyping();
    try {
      const data = JSON.parse(e.data);
      // Streaming token — accumulate in a streaming message bubble
      if (data.type === 'token' && data.data) {
        let streamDiv = document.getElementById('streaming-msg');
        if (!streamDiv) {
          removeTyping();
          streamDiv = document.createElement('div');
          streamDiv.className = 'msg assistant';
          streamDiv.id = 'streaming-msg';
          streamDiv.innerHTML = '<span class="stream-content"></span><span class="stream-cursor" style="display:inline-block;width:2px;height:1em;background:#60a5fa;margin-left:2px;animation:blink 0.7s step-end infinite;vertical-align:text-bottom"></span>';
          document.getElementById('chat-messages').appendChild(streamDiv);
        }
        const span = streamDiv.querySelector('.stream-content');
        if (span) span.textContent += data.data;
        document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;
        return;
      }
      // Streaming done — finalize the message
      if (data.type === 'done') {
        removeTyping();
        const streamDiv = document.getElementById('streaming-msg');
        if (streamDiv) {
          streamDiv.removeAttribute('id');
          const cursor = streamDiv.querySelector('.stream-cursor');
          if (cursor) cursor.remove();
          const span = streamDiv.querySelector('.stream-content');
          if (span && data.content) {
            streamDiv.innerHTML = renderMarkdown(data.content);
          }
          if (data.durationMs || data.model) {
            const m = document.createElement('div');
            m.className = 'meta';
            m.textContent = (data.model || '') + ' \u00b7 ' + (data.durationMs || 0) + 'ms' + (data.tokenUsage ? ' \u00b7 ' + (data.tokenUsage.total || 0) + ' tokens' : '');
            streamDiv.appendChild(m);
          }
        } else if (data.content) {
          appendMsg('assistant', data.content, data);
        }
        document.getElementById('send-btn').disabled = false;
        return;
      }
      // Tool call event during streaming
      if (data.type === 'tool_call' && data.name) {
        let streamDiv = document.getElementById('streaming-msg');
        if (!streamDiv) {
          removeTyping();
          streamDiv = document.createElement('div');
          streamDiv.className = 'msg assistant';
          streamDiv.id = 'streaming-msg';
          streamDiv.innerHTML = '<span class="stream-content"></span><span class="stream-cursor" style="display:inline-block;width:2px;height:1em;background:#60a5fa;margin-left:2px;animation:blink 0.7s step-end infinite;vertical-align:text-bottom"></span>';
          document.getElementById('chat-messages').appendChild(streamDiv);
        }
        const span = streamDiv.querySelector('.stream-content');
        if (span) span.textContent += '\\n[Using tool: ' + data.name + ']\\n';
        return;
      }
      // Assistant response from the agent
      if (data.type === 'message' && data.direction === 'outbound') {
        appendMsg('assistant', data.content, data);
        document.getElementById('send-btn').disabled = false;
      }
      // Legacy response type
      if (data.type === 'response') {
        appendMsg('assistant', data.content, data);
        document.getElementById('send-btn').disabled = false;
      }
      // Mesh events — auto-refresh the mesh panel
      if (data.type === 'mesh_peer_discovered') {
        toast('New TITAN node found: ' + (data.peer && data.peer.hostname || 'unknown') + ' — go to Settings > Mesh to approve');
        loadMeshPanel();
      }
      if (data.type === 'mesh_peer_approved' || data.type === 'mesh_peer_connected' || data.type === 'mesh_peer_revoked') {
        loadMeshPanel();
        fetchData();
      }
    } catch(err) { console.warn('WebSocket message parse error:', err); }
  };
}
connectWS();

// ── Chat ──────────────────────────────────────────────────────────
function appendMsg(role, content, meta) {
  const messages = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'assistant') {
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  if (meta && meta.durationMs) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = (meta.model || '') + ' · ' + meta.durationMs + 'ms' + (meta.tokenUsage ? ' · ' + (meta.tokenUsage.total || 0) + ' tokens' : '');
    div.appendChild(m);
  }
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) sendChat();
});

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  appendMsg('user', text, null);
  input.value = '';
  document.getElementById('send-btn').disabled = true;

  // Add a typing indicator with bouncing dots
  const typing = document.createElement('div');
  typing.className = 'msg assistant';
  typing.id = 'typing-indicator';
  typing.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  typing.style.opacity = '.8';
  document.getElementById('chat-messages').appendChild(typing);
  document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({type:'chat', content:text, userId:'dashboard'}));
    // Fallback: if no WS response within 60s re-enable button
    setTimeout(() => {
      const t = document.getElementById('typing-indicator');
      if (t) t.remove();
      document.getElementById('send-btn').disabled = false;
    }, 60000);
  } else {
    // HTTP fallback
    fetch('/api/message', {method:'POST', headers:authHeaders(), body:JSON.stringify({content:text})})
      .then(r => r.json())
      .then(data => {
        const t = document.getElementById('typing-indicator');
        if (t) t.remove();
        appendMsg('assistant', data.content || '(no response)', data);
        document.getElementById('send-btn').disabled = false;
      })
      .catch(() => {
        const t = document.getElementById('typing-indicator');
        if (t) t.remove();
        document.getElementById('send-btn').disabled = false;
      });
  }
}

// Remove typing indicator
function removeTyping() {
  const t = document.getElementById('typing-indicator');
  if (t) t.remove();
}

// ── Agents ────────────────────────────────────────────────────────
async function spawnAgent() {
  const name = document.getElementById('agent-name').value.trim();
  const model = document.getElementById('agent-model').value.trim();
  if (!name) { toast('Agent name is required', 'error'); return; }
  const r = await fetch('/api/agents/spawn', {method:'POST', headers:authHeaders(), body:JSON.stringify({name, model:model||undefined})});
  const data = await r.json();
  if (data.error) { toast(data.error, 'error'); }
  else { document.getElementById('agent-name').value=''; document.getElementById('agent-model').value=''; toast('Agent spawned: ' + name); fetchData(); }
}

async function stopAgent(id) {
  await fetch('/api/agents/stop', {method:'POST', headers:authHeaders(), body:JSON.stringify({agentId:id})});
  toast('Agent stopped');
  fetchData();
}

async function stopSession(id) {
  try {
    const r = await fetch('/api/sessions/' + id + '/close', {method:'POST', headers:authHeaders()});
    if (r.ok) { toast('Session closed'); fetchData(); }
    else { toast('Failed to close session', 'error'); }
  } catch(e) { toast('Failed to close session', 'error'); }
}

async function toggleSkill(name) {
  try {
    const r = await fetch('/api/skills/' + encodeURIComponent(name) + '/toggle', {method:'POST', headers:authHeaders()});
    const data = await r.json();
    if (r.ok) {
      toast('Skill "' + name + '" ' + (data.enabled ? 'enabled' : 'disabled'));
      fetchData();
    } else {
      toast(data.error || 'Failed to toggle skill', 'error');
    }
  } catch(e) { toast('Failed to toggle skill', 'error'); }
}

// ── Settings Tabs ─────────────────────────────────────────────────
function showStab(name) {
  document.querySelectorAll('.stab-btn').forEach(b => {
    b.style.background = 'var(--bg3)'; b.style.color = 'var(--text-dim)';
  });
  document.querySelectorAll('.stab-content').forEach(c => c.style.display = 'none');
  const activeBtn = [...document.querySelectorAll('.stab-btn')].find(b => b.textContent.toLowerCase().includes(name.split('-')[0]));
  if (activeBtn) { activeBtn.style.background = 'var(--accent)'; activeBtn.style.color = '#fff'; }
  const content = document.getElementById('stab-' + name);
  if (content) content.style.display = 'block';
  if (name === 'mesh-cfg') loadMeshPanel();
}

// ── Config ────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const r = await fetch('/api/config', {headers:authHeaders()});
    const cfg = await r.json();
    // Tab 1: AI & Model
    const manualInput = document.getElementById('cfg-model-manual');
    if (manualInput && cfg.agent?.model) manualInput.value = '';
    const autonomy = document.getElementById('cfg-autonomy');
    if (autonomy) autonomy.value = cfg.autonomy?.mode || 'supervised';
    const loglevel = document.getElementById('cfg-loglevel');
    if (loglevel) loglevel.value = cfg.logging?.level || 'info';
    const temp = document.getElementById('cfg-temperature');
    if (temp) { temp.value = cfg.agent?.temperature ?? 0.7; document.getElementById('cfg-temp-val').textContent = parseFloat(temp.value).toFixed(1); }
    const maxTok = document.getElementById('cfg-maxtokens');
    if (maxTok) maxTok.value = cfg.agent?.maxTokens || 8192;
    const reasoning = document.getElementById('cfg-reasoning');
    if (reasoning) reasoning.value = cfg.agent?.thinkingMode || 'none';
    const sysprompt = document.getElementById('cfg-systemprompt');
    if (sysprompt) sysprompt.value = cfg.agent?.systemPrompt || '';
    // Tab 2: Providers
    const ollamaUrl = document.getElementById('cfg-ollama-url');
    if (ollamaUrl) ollamaUrl.value = cfg.providers?.ollama?.baseUrl || 'http://localhost:11434';
    const antStatus = document.getElementById('cfg-anthropic-status');
    if (antStatus) antStatus.textContent = cfg.providers?.anthropic?.configured ? '✅ configured' : '❌ not set';
    const oaiStatus = document.getElementById('cfg-openai-status');
    if (oaiStatus) oaiStatus.textContent = cfg.providers?.openai?.configured ? '✅ configured' : '❌ not set';
    const gooStatus = document.getElementById('cfg-google-status');
    if (gooStatus) gooStatus.textContent = cfg.providers?.google?.configured ? '✅ configured' : '❌ not set';
    // Tab 3: Channels
    if (cfg.channels) {
      for (const [ch, val] of Object.entries(cfg.channels)) {
        const enEl = document.getElementById('cfg-' + ch + '-enabled');
        if (enEl) enEl.checked = val.enabled;
        const polEl = document.getElementById('cfg-' + ch + '-dmpolicy');
        if (polEl) polEl.value = val.dmPolicy || 'pairing';
      }
    }
    // Tab 4: Security
    const sandbox = document.getElementById('cfg-sandbox');
    if (sandbox) sandbox.value = cfg.security?.sandboxMode || 'host';
    const shieldEnabled = document.getElementById('cfg-shield-enabled');
    if (shieldEnabled) {
      shieldEnabled.checked = cfg.security?.shield?.enabled ?? true;
      document.getElementById('shield-mode-row').style.display = shieldEnabled.checked ? 'block' : 'none';
    }
    const shieldMode = document.getElementById('cfg-shield-mode');
    if (shieldMode) shieldMode.value = cfg.security?.shield?.mode || 'strict';
    const denied = document.getElementById('cfg-denied-tools');
    if (denied) denied.value = (cfg.security?.deniedTools || []).join(', ');
    const allowlist = document.getElementById('cfg-network-allowlist');
    if (allowlist) allowlist.value = (cfg.security?.networkAllowlist || []).join(', ');
    // Tab 5: Gateway
    const port = document.getElementById('cfg-gateway-port');
    if (port) port.value = cfg.gateway?.port || 48420;
    const authMode = document.getElementById('cfg-gateway-auth');
    if (authMode) { authMode.value = cfg.gateway?.auth?.mode || 'none'; updateGatewayAuthFields(); }
    const tailscale = document.getElementById('cfg-tailscale-mode');
    if (tailscale) tailscale.value = cfg.gateway?.tailscale?.mode || 'off';
  } catch(e) { console.error('loadConfig error:', e); }
}

async function saveAIConfig() {
  const manualVal = document.getElementById('cfg-model-manual').value.trim();
  const selectEl = document.getElementById('cfg-model');
  const modelVal = manualVal || (selectEl.value && selectEl.value !== 'Loading models...' ? selectEl.value : '');
  const body = {
    model: modelVal || undefined,
    autonomyMode: document.getElementById('cfg-autonomy').value,
    logLevel: document.getElementById('cfg-loglevel').value,
    temperature: parseFloat(document.getElementById('cfg-temperature').value),
    maxTokens: parseInt(document.getElementById('cfg-maxtokens').value) || undefined,
    thinkingMode: document.getElementById('cfg-reasoning').value !== 'none' ? document.getElementById('cfg-reasoning').value : undefined,
    systemPrompt: document.getElementById('cfg-systemprompt').value,
  };
  const r = await fetch('/api/config', {method:'POST', headers:authHeaders(), body:JSON.stringify(body)});
  const data = await r.json();
  if (data.ok) { toast('AI settings saved'); fetchData(); }
  else toast(data.error || 'Save failed', 'error');
}

async function saveProviderSettings() {
  const body = {};
  const antKey = document.getElementById('cfg-anthropic-key').value.trim();
  const oaiKey = document.getElementById('cfg-openai-key').value.trim();
  const gooKey = document.getElementById('cfg-google-key').value.trim();
  const ollamaUrl = document.getElementById('cfg-ollama-url').value.trim();
  if (antKey) body.anthropicKey = antKey;
  if (oaiKey) body.openaiKey = oaiKey;
  if (gooKey) body.googleKey = gooKey;
  if (ollamaUrl) body.ollamaUrl = ollamaUrl;
  const r = await fetch('/api/config', {method:'POST', headers:authHeaders(), body:JSON.stringify(body)});
  const data = await r.json();
  if (data.ok) { toast('Provider settings saved'); document.getElementById('cfg-anthropic-key').value=''; document.getElementById('cfg-openai-key').value=''; document.getElementById('cfg-google-key').value=''; loadConfig(); }
  else toast(data.error || 'Save failed', 'error');
}

async function testOllamaConnection() {
  const statusEl = document.getElementById('cfg-ollama-status');
  statusEl.textContent = 'Testing...';
  try {
    const r = await fetch('/api/models', {headers:authHeaders()});
    const data = await r.json();
    if (data.ollama && data.ollama.length > 0) {
      statusEl.textContent = '✅ Connected — ' + data.ollama.length + ' models found';
      statusEl.style.color = 'var(--accent3)';
    } else {
      statusEl.textContent = '❌ Ollama reachable but no models found';
      statusEl.style.color = 'var(--warn)';
    }
  } catch { statusEl.textContent = '❌ Ollama not reachable'; statusEl.style.color = 'var(--error)'; }
}

async function saveChannelSettings(ch) {
  const enEl = document.getElementById('cfg-' + ch + '-enabled');
  const tokEl = document.getElementById('cfg-' + ch + '-token');
  const polEl = document.getElementById('cfg-' + ch + '-dmpolicy');
  const val = { enabled: enEl ? enEl.checked : false, dmPolicy: polEl ? polEl.value : 'pairing' };
  if (tokEl && tokEl.value.trim()) val.token = tokEl.value.trim();
  const r = await fetch('/api/config', {method:'POST', headers:authHeaders(), body:JSON.stringify({channels:{[ch]:val}})});
  const data = await r.json();
  if (data.ok) { toast(ch + ' settings saved'); if (tokEl) tokEl.value = ''; }
  else toast(data.error || 'Save failed', 'error');
}

async function saveSecuritySettings() {
  const deniedRaw = document.getElementById('cfg-denied-tools').value.trim();
  const allowRaw = document.getElementById('cfg-network-allowlist').value.trim();
  const body = {
    sandboxMode: document.getElementById('cfg-sandbox').value,
    shieldEnabled: document.getElementById('cfg-shield-enabled').checked,
    shieldMode: document.getElementById('cfg-shield-mode').value,
    deniedTools: deniedRaw ? deniedRaw.split(',').map(s=>s.trim()).filter(Boolean) : [],
    networkAllowlist: allowRaw ? allowRaw.split(',').map(s=>s.trim()).filter(Boolean) : [],
  };
  const r = await fetch('/api/config', {method:'POST', headers:authHeaders(), body:JSON.stringify(body)});
  const data = await r.json();
  if (data.ok) toast('Security settings saved');
  else toast(data.error || 'Save failed', 'error');
}

function updateGatewayAuthFields() {
  const mode = document.getElementById('cfg-gateway-auth').value;
  document.getElementById('gateway-token-row').style.display = mode === 'token' ? 'block' : 'none';
  document.getElementById('gateway-password-row').style.display = mode === 'password' ? 'block' : 'none';
}

async function saveGatewaySettings() {
  const body = {
    gatewayPort: parseInt(document.getElementById('cfg-gateway-port').value) || undefined,
    gatewayAuthMode: document.getElementById('cfg-gateway-auth').value,
    tailscaleMode: document.getElementById('cfg-tailscale-mode')?.value || 'off'
  };
  const tokenEl = document.getElementById('cfg-gateway-token');
  const pwEl = document.getElementById('cfg-gateway-password');
  if (tokenEl && tokenEl.value.trim()) body.gatewayToken = tokenEl.value.trim();
  if (pwEl && pwEl.value.trim()) body.gatewayPassword = pwEl.value.trim();
  const r = await fetch('/api/config', {method:'POST', headers:authHeaders(), body:JSON.stringify(body)});
  const data = await r.json();
  if (data.ok) toast('Gateway settings saved — restart required for port/auth changes', 'success');
  else toast(data.error || 'Save failed', 'error');
}

async function loadProfileTab() {
  try {
    const r = await fetch('/api/profile', {headers:authHeaders()});
    const profile = await r.json();
    const nameEl = document.getElementById('cfg-profile-name');
    if (nameEl) nameEl.value = profile.name || '';
    const levelEl = document.getElementById('cfg-profile-level');
    if (levelEl) levelEl.value = profile.technicalLevel || 'unknown';
    const statsEl = document.getElementById('cfg-profile-stats');
    if (statsEl) statsEl.textContent = 'Projects tracked: ' + (profile.projectCount || 0) + ' | Goals in progress: ' + (profile.goalCount || 0);
  } catch(e) { console.error('loadProfileTab error:', e); }
  loadGoogleStatus();
  loadSoulMd();
}

async function saveProfileSettings() {
  const body = {
    name: document.getElementById('cfg-profile-name').value.trim(),
    technicalLevel: document.getElementById('cfg-profile-level').value,
  };
  const r = await fetch('/api/profile', {method:'POST', headers:authHeaders(), body:JSON.stringify(body)});
  const data = await r.json();
  if (data.ok) toast('Profile saved');
  else toast(data.error || 'Save failed', 'error');
}

// ── Google OAuth ──────────────────────────────────────────────────
async function loadGoogleStatus() {
  try {
    const r = await fetch('/api/auth/google/status', {headers:authHeaders()});
    const data = await r.json();
    const statusEl = document.getElementById('google-oauth-status');
    const connectBtn = document.getElementById('google-connect-btn');
    const disconnectBtn = document.getElementById('google-disconnect-btn');
    if (data.connected) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent3)">✅ Connected</span>' + (data.email ? ' — ' + data.email : '');
      if (connectBtn) connectBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = '';
    } else {
      if (statusEl) statusEl.textContent = '❌ Not connected';
      if (connectBtn) connectBtn.style.display = '';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
    }
  } catch(e) { console.error('Google auth check failed:', e); }
}

async function connectGoogle() {
  // First save OAuth credentials if provided
  const clientId = document.getElementById('cfg-google-oauth-id').value.trim();
  const clientSecret = document.getElementById('cfg-google-oauth-secret').value.trim();
  if (clientId || clientSecret) {
    const body = {};
    if (clientId) body.googleOAuthClientId = clientId;
    if (clientSecret) body.googleOAuthClientSecret = clientSecret;
    await fetch('/api/config', {method:'POST', headers:authHeaders(), body:JSON.stringify(body)});
  }
  // Open consent flow in new window
  window.open('/api/auth/google/start', '_blank', 'width=600,height=700');
  // Poll for connection status
  const poll = setInterval(async () => {
    const r = await fetch('/api/auth/google/status', {headers:authHeaders()});
    const data = await r.json();
    if (data.connected) {
      clearInterval(poll);
      loadGoogleStatus();
      toast('Google account connected!', 'success');
    }
  }, 3000);
  setTimeout(() => clearInterval(poll), 300000);
}

async function disconnectGoogleAccount() {
  if (!confirm('Disconnect your Google account? This will remove Gmail access.')) return;
  await fetch('/api/auth/google/disconnect', {method:'POST', headers:authHeaders()});
  loadGoogleStatus();
  toast('Google account disconnected');
}

// ── SOUL.md ───────────────────────────────────────────────────────
async function loadSoulMd() {
  try {
    const r = await fetch('/api/soul', {headers:authHeaders()});
    const data = await r.json();
    const el = document.getElementById('cfg-soul-content');
    if (el) el.value = data.content || '';
  } catch(e) { console.error('SOUL.md load failed:', e); }
}

async function saveSoulMd() {
  const content = document.getElementById('cfg-soul-content').value;
  const r = await fetch('/api/soul', {method:'POST', headers:authHeaders(), body:JSON.stringify({content})});
  const data = await r.json();
  if (data.success) toast('SOUL.md saved');
  else toast(data.error || 'Save failed', 'error');
}

// ── Model dropdown population ─────────────────────────────────────
async function populateModels() {
  try {
    const data = await fetch('/api/models', {headers:authHeaders()}).then(r=>r.json());
    const sel = document.getElementById('cfg-model');
    if (!sel) return;
    sel.innerHTML = '';
    const skip = ['current','aliases'];
    const coreProviders = ['anthropic','openai','google','ollama'];
    const allProviders = coreProviders.concat(Object.keys(data).filter(k => !skip.includes(k) && !coreProviders.includes(k)).sort());
    for (const provider of allProviders) {
      const models = data[provider];
      if (!Array.isArray(models) || models.length === 0) continue;
      const grp = document.createElement('optgroup');
      grp.label = provider === 'ollama' ? 'LOCAL (Ollama)' : provider.toUpperCase();
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        if (m === data.current) opt.selected = true;
        grp.appendChild(opt);
      }
      sel.appendChild(grp);
    }
    if (!sel.value && data.current) {
      const fallback = document.createElement('option');
      fallback.value = data.current; fallback.textContent = data.current; fallback.selected = true;
      sel.insertBefore(fallback, sel.firstChild);
    }
    // Check fallback chain state
    try {
      const fbData = await fetch('/api/fallback-state', {headers:authHeaders()}).then(r=>r.json());
      const fbEl = document.getElementById('fallback-indicator');
      if (fbEl && fbData && fbData.active) {
        fbEl.style.display = 'block';
        fbEl.innerHTML = '\u26A1 Fallback active: using <b>' + fbData.active + '</b> (primary ' + fbData.primary + ' failed)';
      } else if (fbEl) {
        fbEl.style.display = 'none';
      }
    } catch(_) { /* fallback state check is best-effort */ }
  } catch(e) { console.error('populateModels error:', e); }
}

async function refreshOllamaModels() {
  toast('Refreshing Ollama models...');
  await populateModels();
  toast('Ollama models refreshed');
}

// ── Mesh panel ───────────────────────────────────────────────────
async function loadMeshPanel() {
  const statusBar = document.getElementById('mesh-status-bar');
  const pendingList = document.getElementById('mesh-pending-list');
  const peersList = document.getElementById('mesh-peers-list');
  try {
    const [statusR, peersR, pendingR] = await Promise.all([
      fetch('/api/mesh/status', {headers:authHeaders()}),
      fetch('/api/mesh/peers', {headers:authHeaders()}),
      fetch('/api/mesh/pending', {headers:authHeaders()}),
    ]);
    const statusData = await statusR.json();
    const peersData = await peersR.json();
    const pendingData = await pendingR.json();

    if (!statusData.enabled || statusData.status === 'disabled') {
      if (statusBar) statusBar.innerHTML = '\u26a0\ufe0f Mesh not enabled. Run <code>titan mesh --init</code> on this machine.';
      return;
    }

    const peers = peersData.peers || [];
    const pending = pendingData.pending || [];
    const statusLabel = statusData.status === 'healthy' ? '\u2705' : statusData.status === 'degraded' ? '\u26a0\ufe0f' : '\u274c';
    const healthPct = Math.round((statusData.healthScore || 0) * 100);
    const discoveryLabel = (statusData.discoveryModes || []).join(', ');
    if (statusBar) {
      statusBar.innerHTML = statusLabel + ' Mesh ' + statusData.status
        + ' \u2014 <b>' + statusData.peers.connected + '</b>/' + statusData.peers.total + ' connected'
        + (statusData.peers.pending > 0 ? ', <b>' + statusData.peers.pending + '</b> pending' : '')
        + ' \u2014 health: <b>' + healthPct + '%</b>'
        + (discoveryLabel ? ' \u2014 ' + discoveryLabel : '');
    }

    // Render pending peers
    if (pendingList) {
      if (pending.length === 0) {
        pendingList.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px">No pending peers</div>';
      } else {
        pendingList.innerHTML = pending.map(function(p) {
          return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:6px;border-left:3px solid #f59e0b">'
            + '<div>'
            + '<div style="font-weight:600;font-size:13px;color:var(--text-bright)">' + p.hostname + '</div>'
            + '<div style="font-size:11px;color:var(--text-dim)">' + p.address + ':' + p.port + ' \u2014 ' + (p.models||[]).length + ' models \u2014 via ' + p.discoveredVia + '</div>'
            + '</div>'
            + '<div style="display:flex;gap:6px">'
            + '<button class="btn" style="padding:4px 10px;font-size:11px;background:#22c55e;color:#fff;border:none;border-radius:4px;cursor:pointer" data-node-id="' + p.nodeId + '" onclick="meshApprove(this.dataset.nodeId)">Approve</button>'
            + '<button class="btn" style="padding:4px 10px;font-size:11px;background:#ef4444;color:#fff;border:none;border-radius:4px;cursor:pointer" data-node-id="' + p.nodeId + '" onclick="meshReject(this.dataset.nodeId)">Reject</button>'
            + '</div></div>';
        }).join('');
      }
    }

    // Render connected peers from /api/mesh/status for enriched data
    const peerDetails = (statusData.peerDetails || peers).map(function(p) {
      var loadPct = Math.round((p.load||0)*100);
      var loadColor = loadPct < 50 ? '#22c55e' : loadPct < 80 ? '#f59e0b' : '#ef4444';
      var connBadge = p.isConnected ? '<span style="color:#22c55e">\u25cf connected</span>' : '<span style="color:#ef4444">\u25cb disconnected</span>';
      var borderStyle = p.isConnected ? 'border-left:3px solid #22c55e' : 'border-left:3px solid #ef4444';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:6px;' + borderStyle + '">'
        + '<div>'
        + '<div style="font-weight:600;font-size:13px;color:var(--text-bright)">' + p.hostname + ' ' + connBadge + '</div>'
        + '<div style="font-size:11px;color:var(--text-dim)">' + (p.address||'ws') + ':' + (p.port||'') + ' \u2014 ' + (p.models||[]).length + ' models \u2014 load: <span style="color:' + loadColor + '">' + loadPct + '%</span> \u2014 via ' + (p.discoveredVia||'unknown') + '</div>'
        + '</div>'
        + (p.isConnected ? '<button class="btn" style="padding:4px 10px;font-size:11px;background:var(--bg2);color:var(--text-dim);border:1px solid var(--border);border-radius:4px;cursor:pointer" data-node-id="' + p.nodeId + '" onclick="meshRevoke(this.dataset.nodeId)">Disconnect</button>' : '')
        + '</div>';
    }).join('');

    if (peersList) {
      if (peerDetails.length === 0) {
        peersList.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px">No connected peers</div>';
      } else {
        peersList.innerHTML = peerDetails;
      }
    }
  } catch(e) {
    if (statusBar) statusBar.innerHTML = '\u274c Cannot reach mesh API';
  }
}

async function loadPluginsPanel() {
  var list = document.getElementById('plugins-info-list');
  try {
    var r = await fetch('/api/plugins', {headers:authHeaders()});
    var data = await r.json();
    var plugins = data.plugins || [];
    if (list) {
      if (plugins.length === 0) {
        list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px">No plugins loaded</div>';
      } else {
        list.innerHTML = plugins.map(function(p) {
          return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:6px;border-left:3px solid #22c55e">'
            + '<div>'
            + '<div style="font-weight:600;font-size:13px;color:var(--text-bright)">' + p.name + '</div>'
            + '<div style="font-size:11px;color:var(--text-dim)">v' + p.version + '</div>'
            + '</div>'
            + '<span style="font-size:11px;color:#22c55e">Active</span>'
            + '</div>';
        }).join('');
      }
    }
  } catch(e) {
    if (list) list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px">Failed to load plugins</div>';
  }
}

async function meshApprove(nodeId) {
  try {
    const r = await fetch('/api/mesh/approve/' + nodeId, {method:'POST', headers:authHeaders()});
    const d = await r.json();
    if (d.approved) { toast('Peer approved and connected!', 'success'); loadMeshPanel(); }
    else toast(d.error || 'Failed to approve', 'error');
  } catch(e) { toast('Error approving peer', 'error'); }
}

async function meshReject(nodeId) {
  try {
    await fetch('/api/mesh/reject/' + nodeId, {method:'POST', headers:authHeaders()});
    toast('Peer rejected');
    loadMeshPanel();
  } catch(e) { toast('Error rejecting peer', 'error'); }
}

async function meshRevoke(nodeId) {
  if (!confirm('Disconnect this peer? You can re-approve it later.')) return;
  try {
    await fetch('/api/mesh/revoke/' + nodeId, {method:'POST', headers:authHeaders()});
    toast('Peer disconnected');
    loadMeshPanel();
  } catch(e) { toast('Error disconnecting peer', 'error'); }
}

// ── Data fetching ─────────────────────────────────────────────────
async function triggerUpdate() {
  if (!confirm('Are you sure you want to update TITAN? This will pull the latest version and build in the background.')) return;
  toast('Triggering update...');
  try {
    const r = await fetch('/api/update', {method:'POST', headers:authHeaders()});
    const data = await r.json();
    if (data.ok) toast('Update started in background. Monitor CLI for logs.', 'success');
    else toast('Update failed to start', 'error');
  } catch(e) { toast('Error starting update', 'error'); }
}

async function fetchData() {
  try {
    const [stats, sessions, skills, channelStatus, security, agents, learning, updateInfo, costs] = await Promise.all([
      fetch('/api/stats', {headers:authHeaders()}).then(r=>r.json()).catch(()=>({})),
      fetch('/api/sessions', {headers:authHeaders()}).then(r=>r.json()).catch(()=>[]),
      fetch('/api/skills', {headers:authHeaders()}).then(r=>r.json()).catch(()=>[]),
      fetch('/api/channels', {headers:authHeaders()}).then(r=>r.json()).catch(()=>[]),
      fetch('/api/security', {headers:authHeaders()}).then(r=>r.json()).catch(()=>[]),
      fetch('/api/agents', {headers:authHeaders()}).then(r=>r.json()).catch(()=>({agents:[],capacity:{current:0,max:5}})),
      fetch('/api/learning', {headers:authHeaders()}).then(r=>r.json()).catch(()=>({})),
      fetch('/api/update', {headers:authHeaders()}).then(r=>r.json()).catch(()=>({})),
      fetch('/api/costs', {headers:authHeaders()}).then(r=>r.json()).catch(()=>({})),
    ]);

    // Overview stats
    document.getElementById('s-agents').textContent = agents.capacity?.current ?? '—';
    document.getElementById('s-sessions').textContent = Array.isArray(sessions) ? sessions.length : '—';
    document.getElementById('s-skills').textContent = Array.isArray(skills) ? skills.length : '—';
    document.getElementById('s-requests').textContent = stats.totalRequests ?? '—';
    document.getElementById('agent-cap').textContent = '(' + (agents.capacity?.current||0) + '/' + (agents.capacity?.max||5) + ')';

    // Sparkline data
    if (stats.totalTokens !== undefined) {
      sparkTokens.push(stats.avgTokensPerRequest || (stats.totalTokens / Math.max(stats.totalRequests || 1, 1)));
      if (sparkTokens.length > SPARK_MAX) sparkTokens.shift();
    }
    sparkCost.push(stats.totalCost || 0);
    if (sparkCost.length > SPARK_MAX) sparkCost.shift();
    sparkRespTime.push(stats.avgResponseTime || 0);
    if (sparkRespTime.length > SPARK_MAX) sparkRespTime.shift();

    const stEl = document.getElementById('spark-tokens');
    if (stEl) stEl.innerHTML = renderSparkline(sparkTokens, '#06b6d4');
    const srEl = document.getElementById('spark-resp');
    if (srEl) srEl.innerHTML = renderSparkline(sparkRespTime, '#10b981');
    const scEl = document.getElementById('spark-cost');
    if (scEl) scEl.innerHTML = renderSparkline(sparkCost, '#f59e0b');

    // Update the new stat values
    const rtEl = document.getElementById('s-resp-time');
    if (rtEl) rtEl.textContent = stats.avgResponseTime ? Math.round(stats.avgResponseTime) : '—';
    const costEl = document.getElementById('s-cost');
    if (costEl) costEl.textContent = stats.totalCost !== undefined ? '$' + stats.totalCost.toFixed(4) : '—';

    // Health
    document.getElementById('h-version').textContent = stats.version || '—';
    const up = stats.uptime || 0;
    const upStr = up > 3600 ? Math.floor(up/3600)+'h '+Math.floor((up%3600)/60)+'m' : Math.floor(up/60)+'m '+Math.floor(up%60)+'s';
    document.getElementById('h-uptime').textContent = upStr;
    document.getElementById('uptime-label').textContent = 'Up ' + upStr;
    document.getElementById('h-memory').textContent = (stats.memoryMB || '—') + ' MB';
    document.getElementById('h-tokens').textContent = (stats.totalTokens || 0).toLocaleString();
    document.getElementById('ver-label').textContent = stats.version ? 'v' + stats.version : 'Mission Control';

    // Agents
    if (agents.agents && agents.agents.length > 0) {
      document.getElementById('agents-list').innerHTML =
        '<table><tr><th>Name</th><th>ID</th><th>Model</th><th>Messages</th><th>Status</th><th>Action</th></tr>' +
        agents.agents.map(a=>'<tr><td><strong>'+escHtml(a.name)+'</strong></td><td style="font-family:JetBrains Mono;font-size:12px;color:var(--text-dim)">'+escHtml(a.id.slice(0,8))+'</td><td style="font-size:12px">'+escHtml(a.model)+'</td><td>'+escHtml(a.messageCount)+'</td><td><span class="badge '+(a.status==='running'?'active':'idle')+'">'+escHtml(a.status)+'</span></td><td><button class="btn danger" data-action="stop-agent" data-id="'+escHtml(a.id)+'">Stop</button></td></tr>').join('')+'</table>';
    } else {
      document.getElementById('agents-list').innerHTML = '<div class="empty-state"><div class="icon">🤖</div><p>No agents running. Spawn one above.</p></div>';
    }

    // Config overview health row
    if (agents.agents) {
      try {
        const cfgR = await fetch('/api/config', {headers:authHeaders()});
        const cfg = await cfgR.json();
        document.getElementById('h-model').textContent = cfg.agent?.model || '—';
        const aMode = cfg.autonomy?.mode || '—';
        document.getElementById('h-autonomy').textContent = aMode === 'supervised' ? '🟡 ' + aMode : aMode === 'autonomous' ? '🟢 ' + aMode : '🔴 ' + aMode;
      } catch(e) {}
    }

    // Tunnel status
    try {
      const tun = await fetch('/api/tunnel/status', {headers:authHeaders()}).then(r=>r.json()).catch(()=>({}));
      const tEl = document.getElementById('h-tunnel');
      if (tEl) {
        if (tun.active) {
          tEl.innerHTML = '<a href="' + escHtml(tun.url) + '" target="_blank" style="color:var(--accent);text-decoration:none;font-size:12px">' + escHtml(tun.url) + '</a>';
        } else if (tun.error) {
          tEl.textContent = 'Error';
          tEl.style.color = 'var(--error)';
        } else {
          tEl.textContent = 'Disabled';
        }
      }
    } catch(e) {}

    // Cost breakdown
    try {
      const costCard = document.getElementById('cost-card');
      const costDiv = document.getElementById('cost-breakdown');
      if (costCard && costDiv && costs && typeof costs === 'object') {
        const entries = Object.entries(costs);
        if (entries.length > 0) {
          costCard.style.display = 'block';
          costDiv.innerHTML = '<table style="width:100%;font-size:13px"><thead><tr><th style="text-align:left">Session</th><th>Calls</th><th>Tokens</th><th>Est. USD</th></tr></thead><tbody>' +
            entries.slice(0, 10).map(([sid, c]) => {
              const cost = c;
              return '<tr><td style="font-family:monospace;font-size:11px">' + escHtml(sid.slice(0,12)) + '</td><td style="text-align:center">' + (cost.calls||0) + '</td><td style="text-align:center">' + ((cost.inputTokens||0)+(cost.outputTokens||0)).toLocaleString() + '</td><td style="text-align:right">$' + (cost.estimatedUsd||0).toFixed(5) + '</td></tr>';
            }).join('') + '</tbody></table>';
        } else {
          costCard.style.display = 'none';
        }
      }
    } catch(e) {}

    // Sessions
    if (Array.isArray(sessions) && sessions.length > 0) {
      document.getElementById('sessions-list').innerHTML =
        '<table><tr><th>ID</th><th>Channel</th><th>User</th><th>Messages</th><th>Last Active</th><th>Action</th></tr>' +
        sessions.map(s=>'<tr><td><a href="#" data-action="show-session" data-id="'+escHtml(s.id)+'" style="font-family:JetBrains Mono;font-size:12px;color:var(--accent);text-decoration:none">#'+escHtml(s.id.slice(0,8))+'</a></td><td>'+escHtml(s.channel)+'</td><td>'+escHtml(s.userId||s.user_id||'—')+'</td><td>'+escHtml(s.messageCount||s.message_count||0)+'</td><td style="font-size:12px;color:var(--text-dim)">'+escHtml(s.lastActive||'—')+'</td><td><button class="btn danger" data-action="stop-session" data-id="'+escHtml(s.id)+'">Drop</button></td></tr>').join('')+'</table>';
    } else {
      document.getElementById('sessions-list').innerHTML = '<div class="empty-state"><div class="icon">🔗</div><p>No active sessions yet. Start a conversation in WebChat.</p></div>';
    }

    // Skills
    if (Array.isArray(skills) && skills.length > 0) {
      document.getElementById('skills-list').innerHTML =
        '<table><tr><th>Skill</th><th>Version</th><th>Source</th><th>Status</th><th>Action</th></tr>' +
        skills.map(s=>'<tr><td><strong>'+escHtml(s.name)+'</strong></td><td style="font-family:JetBrains Mono;font-size:12px">'+escHtml(s.version)+'</td><td><span class="badge info">'+escHtml(s.source)+'</span></td><td><span class="badge '+(s.enabled?'active':'idle')+'">'+(s.enabled?'enabled':'disabled')+'</span></td><td><button class="btn '+(s.enabled?'danger':'success')+'" data-action="toggle-skill" data-skill="'+escHtml(s.name)+'" style="font-size:11px;padding:4px 10px">'+(s.enabled?'Disable':'Enable')+'</button></td></tr>').join('')+'</table>';
    }

    // Channels — API returns array [{name, connected}]
    if (Array.isArray(channelStatus) && channelStatus.length > 0) {
      document.getElementById('channels-list').innerHTML =
        '<table><tr><th>Channel</th><th>Status</th></tr>' +
        channelStatus.map(c=>'<tr><td><strong>'+escHtml(c.name)+'</strong></td><td><span class="badge '+(c.connected?'active':'idle')+'">'+(c.connected?'✅ Connected':'⚫ Disconnected')+'</span></td></tr>').join('')+'</table>';
    } else {
      document.getElementById('channels-list').innerHTML = '<div class="empty-state"><p>No channel data available.</p></div>';
    }

    // Security audit — array of {level, message}
    if (Array.isArray(security) && security.length > 0) {
      document.getElementById('security-audit').innerHTML =
        security.map(i=>'<div class="audit-item '+escHtml(i.level)+'">'+(i.level==='error'?'🚨':i.level==='warn'?'⚠️':'ℹ️')+' <span>'+escHtml(i.message)+'</span></div>').join('');
    } else {
      document.getElementById('security-audit').innerHTML = '<div class="audit-item info">ℹ️ <span>No security issues found.</span></div>';
    }

    // Learning
    if (learning && typeof learning === 'object') {
      document.getElementById('l-entries').textContent = learning.knowledgeEntries ?? '—';
      document.getElementById('l-tools').textContent = learning.toolsTracked ?? '—';
      document.getElementById('l-errors').textContent = learning.errorPatterns ?? '—';
      document.getElementById('l-corrections').textContent = learning.corrections ?? '—';
    }

    // Update Checker
    const updateCard = document.getElementById('update-card');
    if (updateInfo && updateInfo.isNewer && updateInfo.latest) {
      const elLatest = document.getElementById('update-latest-version');
      const elCurrent = document.getElementById('update-current-version');
      if (elLatest) elLatest.textContent = 'v' + updateInfo.latest;
      if (elCurrent) elCurrent.textContent = 'v' + updateInfo.current;
      if (updateCard) updateCard.style.display = 'flex';
    } else if (updateCard) {
      updateCard.style.display = 'none';
    }

    // Footer bar
    const fVer = document.getElementById('footer-ver');
    if (fVer) fVer.textContent = stats.version || '—';
    const fUp = document.getElementById('footer-uptime');
    if (fUp) {
      const u = stats.uptime || 0;
      fUp.textContent = u > 3600 ? Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m' : Math.floor(u/60)+'m '+Math.floor(u%60)+'s';
    }
    const fSkills = document.getElementById('footer-skills');
    if (fSkills) fSkills.textContent = Array.isArray(skills) ? skills.length : '0';
    const fNodes = document.getElementById('footer-nodes');
    try {
      const meshR = await fetch('/api/mesh/peers', {headers:authHeaders()});
      const meshData = await meshR.json();
      if (fNodes) fNodes.textContent = Array.isArray(meshData.peers) ? meshData.peers.length : '0';
    } catch(e) { if (fNodes) fNodes.textContent = '0'; }
    const wsDot = document.getElementById('footer-ws-dot');
    if (wsDot) wsDot.className = 'footer-dot ' + (ws && ws.readyState === 1 ? 'on' : 'off');

  } catch(e) { console.error('Fetch error:', e); }
}

// ── Init ──────────────────────────────────────────────────────────
fetchData();
setInterval(fetchData, 15000);

// ── Session Viewer Logic ──────────────────────────────────────────
async function showSessionModal(id) {
  const modal = document.getElementById('session-modal');
  const idSpan = document.getElementById('sm-id');
  const content = document.getElementById('sm-content');
  const loading = document.getElementById('sm-loading');

  idSpan.textContent = id;
  content.style.display = 'none';
  loading.style.display = 'block';
  modal.classList.add('show');

  try {
    const r = await fetch('/api/sessions/' + id, {headers:authHeaders()});
    if (!r.ok) throw new Error('Failed to fetch format');
    const history = await r.json();
    
    // Format JSON with 2-space indentation
    content.textContent = JSON.stringify(history, null, 2);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch(e) {
    loading.textContent = 'Error loading session history: ' + e.message;
  }
}

function closeSessionModal() {
  document.getElementById('session-modal').classList.remove('show');
}

// ── Onboarding Logic ──────────────────────────────────────────────
let obCurrentStep = 1;
const obTotalSteps = 4;

function updateObDots() {
  for (let i = 1; i <= obTotalSteps; i++) {
    const dot = document.getElementById('dot-' + i);
    if (i < obCurrentStep) {
      dot.className = 'ob-dot done';
    } else if (i === obCurrentStep) {
      dot.className = 'ob-dot active';
    } else {
      dot.className = 'ob-dot';
    }
  }
}

function obNextStep() {
  if (obCurrentStep === 1) {
    const name = document.getElementById('ob-name').value.trim();
    if (!name) { toast('Please enter a name', 'error'); return; }
  }
  
  if (obCurrentStep < obTotalSteps) {
    document.getElementById('ob-step-' + obCurrentStep).classList.remove('active');
    obCurrentStep++;
    document.getElementById('ob-step-' + obCurrentStep).classList.add('active');
    document.getElementById('ob-btn-back').style.visibility = 'visible';
    updateObDots();
    
    if (obCurrentStep === obTotalSteps) {
      document.getElementById('ob-btn-next').textContent = 'Finish Setup ⚡';
    }
  } else {
    submitOnboarding();
  }
}

function obPrevStep() {
  if (obCurrentStep > 1) {
    document.getElementById('ob-step-' + obCurrentStep).classList.remove('active');
    obCurrentStep--;
    document.getElementById('ob-step-' + obCurrentStep).classList.add('active');
    document.getElementById('ob-btn-next').textContent = 'Continue ⚡';
    updateObDots();
    
    if (obCurrentStep === 1) {
      document.getElementById('ob-btn-back').style.visibility = 'hidden';
    }
  }
}

async function submitOnboarding() {
  const btn = document.getElementById('ob-btn-next');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  try {
    // 1. Save Profile
    await fetch('/api/profile', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: document.getElementById('ob-name').value.trim(),
        technicalLevel: document.getElementById('ob-level').value
      })
    });

    // 2. Save Soul (personality)
    const aboutMe = document.getElementById('ob-about-me').value.trim();
    const personality = document.getElementById('ob-personality').value.trim();
    if (aboutMe || personality) {
      await fetch('/api/soul', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          aboutMe,
          personality,
          userName: document.getElementById('ob-name').value.trim()
        })
      });
    }

    // 3. Save Config (Provider + Autonomy)
    const providerStr = document.getElementById('ob-prov-local').checked ? 'ollama/kimi-k2.5:cloud' : 'anthropic/claude-sonnet-4-20250514';
    await fetch('/api/config', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: providerStr,
        autonomyMode: document.getElementById('ob-autonomy').value
      })
    });

    // Close Modal and Refresh
    document.getElementById('onboarding-modal').classList.remove('show');
    toast('TITAN setup complete! Welcome.', 'success');
    loadConfig();
    fetchData();
    loadProfileTab();
  } catch (e) {
    console.error('Onboarding failed', e);
    toast('Failed to save setup', 'error');
    btn.textContent = 'Try Again';
    btn.disabled = false;
  }
}

// ── Autopilot ─────────────────────────────────────────────────────
async function loadTelemetry() {
  try {
    const data = await fetch('/api/metrics/summary', {headers:authHeaders()}).then(r=>r.json());
    document.getElementById('tm-requests').textContent = String(data.totalRequests || 0);
    document.getElementById('tm-latency').textContent = (data.avgLatencyMs || 0).toFixed(1) + ' ms';
    document.getElementById('tm-error-rate').textContent = ((data.errorRate || 0) * 100).toFixed(2) + '%';
    document.getElementById('tm-errors').textContent = String(data.totalErrors || 0);
    document.getElementById('tm-prompt-tokens').textContent = (data.totalTokens?.prompt || 0).toLocaleString();
    document.getElementById('tm-completion-tokens').textContent = (data.totalTokens?.completion || 0).toLocaleString();
    const tbody = document.getElementById('tm-top-tools');
    if (data.topTools && data.topTools.length > 0) {
      tbody.innerHTML = data.topTools.map(t => '<tr><td>' + t.tool + '</td><td style="font-family:monospace;font-weight:600">' + t.count + '</td></tr>').join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="2" style="color:var(--text-dim)">No tool usage data yet</td></tr>';
    }
  } catch(e) {
    console.error('Failed to load telemetry:', e);
  }
}

async function loadAutopilot() {
  try {
    const [status, history] = await Promise.all([
      fetch('/api/autopilot/status', {headers:authHeaders()}).then(r=>r.json()).catch(()=>({})),
      fetch('/api/autopilot/history', {headers:authHeaders()}).then(r=>r.json()).catch(()=>[]),
    ]);
    const sEl = document.getElementById('ap-status');
    if (sEl) sEl.textContent = status.enabled ? (status.running ? 'Running' : 'Enabled') : 'Disabled';
    const schEl = document.getElementById('ap-schedule');
    if (schEl) schEl.textContent = status.schedule || '—';
    const totEl = document.getElementById('ap-total');
    if (totEl) totEl.textContent = Array.isArray(history) ? history.length : '0';
    const lastEl = document.getElementById('ap-last');
    if (lastEl) {
      if (Array.isArray(history) && history.length > 0) {
        const last = history[0];
        lastEl.textContent = last.startedAt ? new Date(last.startedAt).toLocaleString() : '—';
      } else {
        lastEl.textContent = 'Never';
      }
    }
    const tbody = document.getElementById('autopilot-history');
    const empty = document.getElementById('autopilot-empty');
    const table = document.getElementById('autopilot-history-table');
    if (Array.isArray(history) && history.length > 0) {
      if (table) table.style.display = '';
      if (empty) empty.style.display = 'none';
      if (tbody) tbody.innerHTML = history.slice(0, 20).map((r, i) => {
        const dur = r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : '—';
        const result = r.error ? '<span class="badge error">Error</span>' : '<span class="badge active">OK</span>';
        const started = r.startedAt ? new Date(r.startedAt).toLocaleString() : '—';
        return '<tr><td>#' + (history.length - i) + '</td><td style="font-size:12px">' + escHtml(started) + '</td><td>' + escHtml(dur) + '</td><td>' + (r.tasksCompleted || 0) + '</td><td>' + result + '</td></tr>';
      }).join('');
    } else {
      if (table) table.style.display = 'none';
      if (empty) empty.style.display = '';
    }
  } catch(e) {
    toast('Failed to load autopilot data', 'error');
  }
}

async function runAutopilotNow() {
  try {
    toast('Starting autopilot run...', 'info');
    const res = await fetch('/api/autopilot/run', {method:'POST', headers:authHeaders()});
    if (res.ok) {
      toast('Autopilot run completed', 'success');
      loadAutopilot();
    } else {
      const err = await res.json().catch(()=>({}));
      toast('Autopilot run failed: ' + (err.error || 'unknown'), 'error');
    }
  } catch(e) {
    toast('Autopilot run failed', 'error');
  }
}

// ── Graphiti ──────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Workflows Panel ──────────────────────────────────────────
let wfEditingId = null;
let wfStepCount = 0;

async function loadWorkflows() {
  try {
    const res = await authFetch('/api/recipes');
    const data = await res.json();
    const recipes = data.recipes || [];
    document.getElementById('wf-count').textContent = recipes.length + ' workflow' + (recipes.length !== 1 ? 's' : '');
    const list = document.getElementById('wf-list');
    if (recipes.length === 0) {
      list.innerHTML = '<div style="color:#94a3b8;padding:20px;text-align:center">No workflows yet. Click <b>+ New Workflow</b> to create one.</div>';
      return;
    }
    list.innerHTML = recipes.map(r => {
      const stepCount = (r.steps || []).length;
      const slash = r.slashCommand ? '<span style="color:#06b6d4">/' + esc(r.slashCommand) + '</span> · ' : '';
      const lastRun = r.lastRunAt ? 'Last run: ' + new Date(r.lastRunAt).toLocaleDateString() : 'Never run';
      return '<div style="background:rgba(17,24,39,0.7);border:1px solid #2a3050;border-radius:10px;padding:16px;cursor:pointer" onclick="wfEdit(\\'' + esc(r.id) + '\\')">' +
        '<div style="font-weight:600;color:#e2e8f0;margin-bottom:4px">' + esc(r.name) + '</div>' +
        '<div style="font-size:12px;color:#94a3b8;margin-bottom:8px">' + esc(r.description || '') + '</div>' +
        '<div style="font-size:11px;color:#64748b">' + slash + stepCount + ' step' + (stepCount !== 1 ? 's' : '') + ' · ' + lastRun + '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px">' +
          '<button class="btn" onclick="event.stopPropagation();wfRun(\\'' + esc(r.id) + '\\')" style="font-size:11px;padding:3px 10px">Run</button>' +
          '<button class="btn" onclick="event.stopPropagation();wfDelete(\\'' + esc(r.id) + '\\')" style="font-size:11px;padding:3px 10px;opacity:0.6">Delete</button>' +
        '</div></div>';
    }).join('');
  } catch (e) { console.error('loadWorkflows:', e); }
}

function wfNew() {
  wfEditingId = null;
  wfStepCount = 0;
  document.getElementById('wf-editor-title').textContent = 'New Workflow';
  document.getElementById('wf-name').value = '';
  document.getElementById('wf-slash').value = '';
  document.getElementById('wf-desc').value = '';
  document.getElementById('wf-steps').innerHTML = '';
  document.getElementById('wf-list').style.display = 'none';
  document.getElementById('wf-editor').style.display = 'block';
  wfAddStep();
  wfDrawCanvas();
}

async function wfEdit(id) {
  try {
    const res = await authFetch('/api/recipes/' + id);
    const { recipe } = await res.json();
    wfEditingId = id;
    wfStepCount = 0;
    document.getElementById('wf-editor-title').textContent = 'Edit: ' + recipe.name;
    document.getElementById('wf-name').value = recipe.name || '';
    document.getElementById('wf-slash').value = recipe.slashCommand || '';
    document.getElementById('wf-desc').value = recipe.description || '';
    document.getElementById('wf-steps').innerHTML = '';
    for (const step of recipe.steps || []) {
      wfAddStep(step.prompt, step.tool, step.awaitConfirm);
    }
    document.getElementById('wf-list').style.display = 'none';
    document.getElementById('wf-editor').style.display = 'block';
    wfDrawCanvas();
  } catch (e) { console.error('wfEdit:', e); }
}

function wfAddStep(prompt, tool, awaitConfirm) {
  const idx = wfStepCount++;
  const container = document.getElementById('wf-steps');
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:10px;background:rgba(10,14,26,0.5);border:1px solid #2a3050;border-radius:8px';
  div.id = 'wf-step-' + idx;
  div.innerHTML =
    '<span style="color:#06b6d4;font-weight:bold;min-width:24px;padding-top:8px">' + (idx + 1) + '</span>' +
    '<div style="flex:1;display:flex;flex-direction:column;gap:6px">' +
      '<textarea class="input wf-prompt" rows="2" placeholder="Step prompt... Use {{param}} for parameters" style="resize:vertical;font-size:13px">' + esc(prompt || '') + '</textarea>' +
      '<div style="display:flex;gap:8px">' +
        '<input class="input wf-tool" placeholder="Tool (optional)" value="' + esc(tool || '') + '" style="width:140px;font-size:12px">' +
        '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#94a3b8"><input type="checkbox" class="wf-confirm"' + (awaitConfirm ? ' checked' : '') + '> Confirm</label>' +
      '</div>' +
    '</div>' +
    '<button onclick="wfRemoveStep(' + idx + ')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:16px;padding:8px">✕</button>';
  container.appendChild(div);
  wfDrawCanvas();
}

function wfRemoveStep(idx) {
  const el = document.getElementById('wf-step-' + idx);
  if (el) el.remove();
  wfDrawCanvas();
}

function wfDrawCanvas() {
  const canvas = document.getElementById('wf-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const steps = document.querySelectorAll('#wf-steps > div');
  const n = steps.length;
  canvas.height = 80;
  canvas.width = canvas.parentElement.clientWidth || 700;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (n === 0) return;
  const pad = 40;
  const nodeW = 100;
  const spacing = Math.min((canvas.width - pad * 2 - nodeW) / Math.max(n - 1, 1), 160);
  for (let i = 0; i < n; i++) {
    const x = pad + i * spacing;
    const y = 30;
    // Draw connection line
    if (i > 0) {
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad + (i - 1) * spacing + nodeW, y + 12);
      ctx.lineTo(x, y + 12);
      ctx.stroke();
      // Arrow
      ctx.fillStyle = '#06b6d4';
      ctx.beginPath();
      ctx.moveTo(x, y + 12);
      ctx.lineTo(x - 6, y + 7);
      ctx.lineTo(x - 6, y + 17);
      ctx.fill();
    }
    // Draw node
    ctx.fillStyle = 'rgba(6,182,212,0.15)';
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, nodeW, 24, 6);
    ctx.fill();
    ctx.stroke();
    // Label
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Step ' + (i + 1), x + nodeW / 2, y + 16);
  }
}

async function wfSave() {
  const name = document.getElementById('wf-name').value.trim();
  if (!name) { alert('Workflow name is required'); return; }
  const id = wfEditingId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const steps = [];
  document.querySelectorAll('#wf-steps > div').forEach(div => {
    const prompt = div.querySelector('.wf-prompt')?.value?.trim();
    if (!prompt) return;
    const tool = div.querySelector('.wf-tool')?.value?.trim() || undefined;
    const awaitConfirm = div.querySelector('.wf-confirm')?.checked || false;
    steps.push({ prompt, tool, awaitConfirm: awaitConfirm || undefined });
  });
  if (steps.length === 0) { alert('Add at least one step'); return; }
  const recipe = {
    id, name,
    description: document.getElementById('wf-desc').value.trim(),
    slashCommand: document.getElementById('wf-slash').value.trim() || undefined,
    steps,
    createdAt: new Date().toISOString(),
  };
  try {
    const method = wfEditingId ? 'PUT' : 'POST';
    const url = wfEditingId ? '/api/recipes/' + id : '/api/recipes';
    await authFetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(recipe) });
    wfCancel();
    loadWorkflows();
  } catch (e) { alert('Save failed: ' + e.message); }
}

function wfCancel() {
  document.getElementById('wf-editor').style.display = 'none';
  document.getElementById('wf-list').style.display = 'grid';
}

async function wfDelete(id) {
  if (!confirm('Delete this workflow?')) return;
  try {
    await authFetch('/api/recipes/' + id, { method: 'DELETE' });
    loadWorkflows();
  } catch (e) { alert('Delete failed: ' + e.message); }
}

async function wfRun(id) {
  showPanel('chat');
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    const res = await authFetch('/api/recipes/' + id);
    const { recipe } = await res.json();
    chatInput.value = '/' + (recipe.slashCommand || recipe.id);
    chatInput.focus();
  }
}

async function wfExportYaml() {
  const name = document.getElementById('wf-name').value.trim();
  const id = wfEditingId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const steps = [];
  document.querySelectorAll('#wf-steps > div').forEach(div => {
    const prompt = div.querySelector('.wf-prompt')?.value?.trim();
    if (prompt) steps.push('  - prompt: "' + prompt.replace(/"/g, '\\\\"') + '"');
  });
  const yaml = '# TITAN Workflow: ' + name + '\\nid: ' + id + '\\nname: "' + name + '"\\n' +
    'description: "' + (document.getElementById('wf-desc').value || '') + '"\\n' +
    (document.getElementById('wf-slash').value ? 'slashCommand: ' + document.getElementById('wf-slash').value + '\\n' : '') +
    'steps:\\n' + steps.join('\\n') + '\\n';
  const blob = new Blob([yaml.replace(/\\\\n/g, '\\n')], { type: 'text/yaml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (id || 'workflow') + '.yaml';
  a.click();
}

function wfImportYaml() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.yaml,.yml';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const res = await authFetch('/api/recipes/import', { method: 'POST', headers: {'Content-Type': 'text/yaml'}, body: text });
      if (res.ok) { loadWorkflows(); } else { alert('Import failed'); }
    } catch (err) {
      // Fallback: parse YAML client-side (basic)
      const lines = text.split('\\n');
      const recipe = { steps: [], createdAt: new Date().toISOString() };
      let inSteps = false;
      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (line.startsWith('id:')) recipe.id = line.split(':').slice(1).join(':').trim().replace(/['"]/g, '');
        if (line.startsWith('name:')) recipe.name = line.split(':').slice(1).join(':').trim().replace(/['"]/g, '');
        if (line.startsWith('description:')) recipe.description = line.split(':').slice(1).join(':').trim().replace(/['"]/g, '');
        if (line.startsWith('slashCommand:')) recipe.slashCommand = line.split(':').slice(1).join(':').trim();
        if (line.startsWith('steps:')) { inSteps = true; continue; }
        if (inSteps && line.trim().startsWith('- prompt:')) {
          recipe.steps.push({ prompt: line.trim().replace(/^- prompt:\\s*["']?/, '').replace(/["']$/, '') });
        }
      }
      if (recipe.id && recipe.name && recipe.steps.length) {
        await authFetch('/api/recipes', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(recipe) });
        loadWorkflows();
      } else { alert('Invalid YAML format'); }
    }
  };
  input.click();
}

async function loadGraphiti() {
  try {
    const data = await fetch('/api/graphiti', {headers:authHeaders()}).then(r=>r.json()).catch(()=>null);
    if (!data) { toast('Failed to load Memory Graph', 'error'); return; }

    // Update stat cards
    document.getElementById('g-neo4j').textContent = data.graphReady ? '🟢 Ready' : '🔴 Error';
    document.getElementById('g-mcp').textContent = (data.episodeCount ?? 0) + ' episodes';
    document.getElementById('g-nodes').textContent = data.nodeCount ?? '—';
    document.getElementById('g-edges').textContent = data.edgeCount ?? '—';

    const canvas = document.getElementById('graphiti-canvas');
    const empty = document.getElementById('graphiti-empty');
    const status = document.getElementById('graphiti-status');
    const nodeList = document.getElementById('graphiti-node-list');

    status.style.display = 'none';

    if (!data.nodes || data.nodes.length === 0) {
      canvas.style.display = 'none';
      empty.style.display = 'block';
      nodeList.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    canvas.style.display = 'block';
    nodeList.style.display = 'block';

    // Draw graph on canvas
    drawGraphitiGraph(canvas, data.nodes, data.edges);

    // Render node list below canvas
    const typeColors = {
      person:'#06b6d4', topic:'#8b5cf6', project:'#10b981', place:'#f59e0b', fact:'#94a3b8',
      Episode:'#06b6d4', Entity:'#8b5cf6', Fact:'#10b981', Community:'#f59e0b'
    };
    nodeList.innerHTML = '<table><thead><tr><th>Label</th><th>Type</th><th>ID</th></tr></thead><tbody>' +
      data.nodes.map((n) => {
        const c = typeColors[n.type] || '#64748b';
        return '<tr><td>'+escHtml(n.label)+'</td><td><span style="color:'+c+';font-weight:600">'+escHtml(n.type)+'</span></td><td style="color:var(--text-dim);font-size:11px;font-family:monospace">'+escHtml(String(n.id).slice(0,12))+'…</td></tr>';
      }).join('') + '</tbody></table>';

    // Attach click handler for entity detail card
    canvas.onclick = (evt) => showEntityDetail(data.nodes, data.edges, canvas, evt);
  } catch(e) { toast('Failed to load Memory Graph', 'error'); console.error('Graph load error', e); }
}

async function clearGraphData() {
  if (!confirm('Clear the entire memory graph? This deletes all entities, edges, and episodes. This cannot be undone.')) return;
  try {
    const r = await fetch('/api/graphiti', {method:'DELETE', headers:authHeaders()});
    const data = await r.json();
    if (data.success) { toast('Graph cleared successfully'); loadGraphiti(); }
    else { toast(data.error || 'Failed to clear graph', 'error'); }
  } catch(e) { toast('Failed to clear graph', 'error'); }
}

async function clearAllData() {
  if (!confirm('WARNING: This will delete ALL TITAN data (graph, knowledge, memory). Are you absolutely sure?')) return;
  if (!confirm('This is irreversible. Type OK to confirm... (Click OK to proceed)')) return;
  try {
    const r = await fetch('/api/data', {method:'DELETE', headers:authHeaders()});
    const data = await r.json();
    if (data.success) { toast(data.message || 'All data cleared'); loadGraphiti(); }
    else { toast(data.error || 'Failed to clear data', 'error'); }
  } catch(e) { toast('Failed to clear data', 'error'); }
}

// ── Graph zoom/pan state ──────────────────────────────────────────
let graphZoom = 1, graphPanX = 0, graphPanY = 0;
let graphDragging = false, graphDragStartX = 0, graphDragStartY = 0;
let graphHoverNode = null;
let graphLastNodes = null, graphLastEdges = null;

function initGraphInteraction(canvas) {
  if (canvas._interactionBound) return;
  canvas._interactionBound = true;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    graphZoom = Math.max(0.3, Math.min(3, graphZoom * delta));
    if (graphLastNodes && graphLastEdges) drawGraphitiGraph(canvas, graphLastNodes, graphLastEdges);
  }, {passive:false});

  canvas.addEventListener('mousedown', (e) => {
    graphDragging = true;
    graphDragStartX = e.clientX - graphPanX;
    graphDragStartY = e.clientY - graphPanY;
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('mousemove', (e) => {
    if (graphDragging) {
      graphPanX = e.clientX - graphDragStartX;
      graphPanY = e.clientY - graphDragStartY;
      if (graphLastNodes && graphLastEdges) drawGraphitiGraph(canvas, graphLastNodes, graphLastEdges);
      return;
    }
    // Hover detection
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleX;
    const positions = canvas._positions;
    if (!positions || !graphLastNodes) return;
    let found = null;
    for (const n of graphLastNodes) {
      const p = positions[n.id];
      if (!p) continue;
      const tx = p.x * graphZoom + graphPanX;
      const ty = p.y * graphZoom + graphPanY;
      const r = (n.size || 18) * graphZoom;
      if (Math.sqrt((mx - tx) ** 2 + (my - ty) ** 2) <= r + 4) { found = n.id; break; }
    }
    if (found !== graphHoverNode) {
      graphHoverNode = found;
      canvas.style.cursor = found ? 'pointer' : 'grab';
      if (graphLastNodes && graphLastEdges) drawGraphitiGraph(canvas, graphLastNodes, graphLastEdges);
    }
  });

  canvas.addEventListener('mouseup', () => { graphDragging = false; canvas.style.cursor = 'grab'; });
  canvas.addEventListener('mouseleave', () => { graphDragging = false; canvas.style.cursor = 'grab'; });
  canvas.style.cursor = 'grab';
}

let graphSelectedNode = null;
let graphPulsePhase = 0;
let graphAnimRunning = false;

const graphTypeColors = {
  person:'#06b6d4', topic:'#8b5cf6', project:'#10b981', place:'#f59e0b', fact:'#94a3b8',
  Episode:'#06b6d4', Entity:'#8b5cf6', Fact:'#10b981', Community:'#f59e0b'
};

// Build edge connection count per node for sizing
function getNodeDegrees(nodes, edges) {
  const degrees = {};
  nodes.forEach(n => degrees[n.id] = 0);
  edges.forEach(e => {
    if (degrees[e.from] !== undefined) degrees[e.from]++;
    if (degrees[e.to] !== undefined) degrees[e.to]++;
  });
  return degrees;
}

// Get connected node IDs for a given node
function getConnectedNodes(nodeId, edges) {
  const connected = new Set();
  connected.add(nodeId);
  edges.forEach(e => {
    if (e.from === nodeId) connected.add(e.to);
    if (e.to === nodeId) connected.add(e.from);
  });
  return connected;
}

// Parse hex color to RGB array (cached)
const hexToRgbCache = {};
function hexToRgb(hex) {
  if (hexToRgbCache[hex]) return hexToRgbCache[hex];
  const rgb = [parseInt(hex.slice(1,3), 16), parseInt(hex.slice(3,5), 16), parseInt(hex.slice(5,7), 16)];
  hexToRgbCache[hex] = rgb;
  return rgb;
}

function drawGraphitiGraph(canvas, nodes, edges) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Responsive canvas sizing
  const container = canvas.parentElement;
  if (container) {
    const cw = container.clientWidth - 2;
    const ch = container.clientHeight - 2;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = Math.max(400, cw);
      canvas.height = Math.max(300, ch);
    }
  }

  const W = canvas.width, H = canvas.height;

  if (nodes.length === 0) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);
    return;
  }

  graphLastNodes = nodes;
  graphLastEdges = edges;
  initGraphInteraction(canvas);

  if (!canvas._resizeObserver) {
    canvas._resizeObserver = new ResizeObserver(() => {
      const c = canvas.parentElement;
      if (c) {
        canvas.width = Math.max(400, c.clientWidth - 2);
        canvas.height = Math.max(300, c.clientHeight - 2);
      }
    });
    canvas._resizeObserver.observe(canvas.parentElement);
  }

  // Compute force-directed layout (only recalculate if nodes changed)
  if (!canvas._positions || canvas._posNodeCount !== nodes.length) {
    canvas._positions = initForceLayout(nodes, edges, W, H, canvas);
    canvas._posNodeCount = nodes.length;
  }

  // Render first frame immediately
  renderGraph(canvas);

  // Start animation loop if not running
  if (!graphAnimRunning) startGraphAnimation(canvas);
}

// Lightweight render — called by animation loop, skips init/layout
function renderGraph(canvas) {
  if (!graphLastNodes || !graphLastEdges) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const nodes = graphLastNodes, edges = graphLastEdges;
  const W = canvas.width, H = canvas.height;
  const positions = canvas._positions;
  if (!positions) return;

  ctx.clearRect(0, 0, W, H);

  // Dot grid background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(51,65,85,0.3)';
  const gridSpacing = 20;
  for (let gx = (graphPanX % (gridSpacing * graphZoom)); gx < W; gx += gridSpacing * graphZoom) {
    for (let gy = (graphPanY % (gridSpacing * graphZoom)); gy < H; gy += gridSpacing * graphZoom) {
      ctx.fillRect(gx, gy, 1, 1);
    }
  }

  if (nodes.length === 0) return;

  // Build node lookup map (avoids O(E*N) in edge rendering)
  if (!canvas._nodeMap || canvas._nodeMapCount !== nodes.length) {
    canvas._nodeMap = {};
    nodes.forEach(n => canvas._nodeMap[n.id] = n);
    canvas._nodeMapCount = nodes.length;
  }
  const nodeMap = canvas._nodeMap;

  // Cache degrees (only recompute when graph data changes)
  if (!canvas._degrees || canvas._degreesCount !== nodes.length + edges.length) {
    canvas._degrees = getNodeDegrees(nodes, edges);
    canvas._degreesCount = nodes.length + edges.length;
  }
  const degrees = canvas._degrees;
  const connectedToSelected = graphSelectedNode ? getConnectedNodes(graphSelectedNode, edges) : null;
  const pulseGlow = 0.15 + 0.1 * Math.sin(graphPulsePhase);

  ctx.save();

  // Draw edges
  edges.forEach(e => {
    const a = positions[e.from], b = positions[e.to];
    if (!a || !b) return;
    const ax = a.x * graphZoom + graphPanX, ay = a.y * graphZoom + graphPanY;
    const bx = b.x * graphZoom + graphPanX, by = b.y * graphZoom + graphPanY;
    let edgeAlpha = 0.5;
    if (connectedToSelected) {
      edgeAlpha = (connectedToSelected.has(e.from) && connectedToSelected.has(e.to)) ? 0.7 : 0.08;
    }
    const fromNode = nodeMap[e.from];
    const toNode = nodeMap[e.to];
    const fromColor = graphTypeColors[fromNode?.type] || '#64748b';
    const toColor = graphTypeColors[toNode?.type] || '#64748b';
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const dx = bx - ax, dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    const offset = Math.min(30, len * 0.15);
    const cx2 = mx + (len > 0 ? (-dy / len) * offset : 0);
    const cy2 = my + (len > 0 ? (dx / len) * offset : 0);
    const [fr, fg, fb] = hexToRgb(fromColor);
    const [tr, tg, tb] = hexToRgb(toColor);
    const grad = ctx.createLinearGradient(ax, ay, bx, by);
    grad.addColorStop(0, 'rgba(' + fr + ',' + fg + ',' + fb + ',' + edgeAlpha + ')');
    grad.addColorStop(1, 'rgba(' + tr + ',' + tg + ',' + tb + ',' + edgeAlpha + ')');
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(cx2, cy2, bx, by);
    ctx.strokeStyle = grad;
    ctx.lineWidth = (graphHoverNode === e.from || graphHoverNode === e.to) ? 2.5 : 1.5;
    ctx.stroke();
    if (e.label && (graphHoverNode === e.from || graphHoverNode === e.to)) {
      ctx.save();
      ctx.font = Math.max(8, 10 * graphZoom) + 'px sans-serif';
      ctx.fillStyle = 'rgba(226,232,240,0.9)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 4;
      ctx.fillText(e.label, cx2, cy2);
      ctx.restore();
    }
  });

  // Draw nodes
  nodes.forEach(n => {
    const pos = positions[n.id];
    if (!pos) return;
    const color = graphTypeColors[n.type] || '#64748b';
    const [cr, cg, cb] = hexToRgb(color);
    const deg = degrees[n.id] || 0;
    const baseRadius = Math.max(14, Math.min(30, 14 + deg * 3));
    const radius = baseRadius * graphZoom;
    const tx = pos.x * graphZoom + graphPanX;
    const ty = pos.y * graphZoom + graphPanY;
    let nodeAlpha = 1.0;
    if (connectedToSelected && !connectedToSelected.has(n.id)) nodeAlpha = 0.15;

    ctx.save();
    ctx.globalAlpha = nodeAlpha;
    ctx.beginPath();
    ctx.arc(tx, ty, radius + 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (graphHoverNode === n.id ? 0.35 : pulseGlow) + ')';
    if (graphHoverNode === n.id || graphSelectedNode === n.id) {
      ctx.shadowColor = color; ctx.shadowBlur = 24;
    }
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = nodeAlpha;
    const grad = ctx.createRadialGradient(tx - radius * 0.2, ty - radius * 0.2, radius * 0.1, tx, ty, radius);
    grad.addColorStop(0, 'rgba(' + cr + ',' + cg + ',' + cb + ',0.9)');
    grad.addColorStop(0.6, 'rgba(' + cr + ',' + cg + ',' + cb + ',0.4)');
    grad.addColorStop(1, 'rgba(' + cr + ',' + cg + ',' + cb + ',0.1)');
    ctx.beginPath();
    ctx.arc(tx, ty, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (graphHoverNode === n.id ? 1 : 0.7) + ')';
    ctx.lineWidth = graphHoverNode === n.id ? 3 : (graphSelectedNode === n.id ? 3 : 1.5);
    ctx.stroke();

    const maxChars = graphZoom > 1.2 ? 16 : 12;
    const label = n.label.length > maxChars ? n.label.slice(0, maxChars - 1) + '…' : n.label;
    ctx.font = 'bold ' + Math.max(8, 11 * graphZoom) + 'px sans-serif';
    ctx.fillStyle = '#f1f5f9';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
    ctx.fillText(label, tx, ty);
    ctx.font = Math.max(6, 8 * graphZoom) + 'px sans-serif';
    ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',0.8)';
    ctx.shadowBlur = 0;
    ctx.fillText(n.type, tx, ty + radius * 0.65);
    ctx.restore();
  });

  // Legend
  ctx.save();
  const legendX = W - 110, legendY = 12;
  ctx.fillStyle = 'rgba(15,23,42,0.85)';
  ctx.strokeStyle = 'rgba(51,65,85,0.6)';
  ctx.lineWidth = 1;
  const seenTypes = new Set();
  let typeCount = 0;
  for (const [type, color] of Object.entries(graphTypeColors)) {
    if (!seenTypes.has(color + type.toLowerCase())) { seenTypes.add(color + type.toLowerCase()); typeCount++; }
  }
  ctx.beginPath();
  ctx.rect(legendX - 8, legendY - 4, 108, typeCount * 16 + 8);
  ctx.fill(); ctx.stroke();
  let ly = legendY + 8;
  seenTypes.clear();
  for (const [type, color] of Object.entries(graphTypeColors)) {
    if (seenTypes.has(color + type.toLowerCase())) continue;
    seenTypes.add(color + type.toLowerCase());
    ctx.beginPath();
    ctx.arc(legendX + 4, ly, 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.font = '9px sans-serif'; ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(type, legendX + 14, ly);
    ly += 16;
  }
  ctx.restore();

  ctx.restore();
}

// Graph animation loop — 30fps glow pulse
let graphAnimId = null;
function startGraphAnimation(canvas) {
  if (graphAnimId) cancelAnimationFrame(graphAnimId);
  graphAnimRunning = true;
  let lastFrame = 0;
  function animate(ts) {
    const panel = document.getElementById('panel-graphiti');
    if (!panel || !panel.classList.contains('active')) {
      graphAnimRunning = false;
      graphAnimId = null;
      return;
    }
    if (ts - lastFrame < 33) {
      graphAnimId = requestAnimationFrame(animate);
      return;
    }
    lastFrame = ts;
    graphPulsePhase += 0.05;
    if (canvas._forceState && canvas._forceState.remainingIterations > 0) {
      const fs = canvas._forceState;
      const itersThisFrame = Math.min(3, fs.remainingIterations);
      for (let i = 0; i < itersThisFrame; i++) {
        fs.runIteration();
      }
      fs.remainingIterations -= itersThisFrame;
      if (fs.remainingIterations <= 0) {
        canvas._forceState = null;
      }
    }
    renderGraph(canvas);
    graphAnimId = requestAnimationFrame(animate);
  }
  graphAnimId = requestAnimationFrame(animate);
}

// ── Force-directed graph layout init ─────────────────────────────
function initForceLayout(nodes, edges, W, H, canvas) {
  const positions = {};
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) * 0.38;
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    positions[n.id] = {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
      vx: 0, vy: 0
    };
  });

  const k = 80, springK = 0.05, damping = 0.8;
  const idealEdgeLen = Math.min(W, H) * 0.2;

  function runForceIteration() {
    // Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const pi = positions[nodes[i].id], pj = positions[nodes[j].id];
        const dx = pi.x - pj.x, dy = pi.y - pj.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = (k * k) / dist;
        pi.vx += (dx / dist) * force; pi.vy += (dy / dist) * force;
        pj.vx -= (dx / dist) * force; pj.vy -= (dy / dist) * force;
      }
    }
    // Edge spring attraction
    edges.forEach(e => {
      const pa = positions[e.from], pb = positions[e.to];
      if (!pa || !pb) return;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (dist - idealEdgeLen) * springK;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      pa.vx += fx; pa.vy += fy;
      pb.vx -= fx; pb.vy -= fy;
    });
    // Center gravity — pull nodes toward canvas center
    for (const n of nodes) {
      const p = positions[n.id];
      p.vx += (cx - p.x) * 0.001;
      p.vy += (cy - p.y) * 0.001;
    }
    // Apply velocities
    for (const n of nodes) {
      const p = positions[n.id];
      p.vx *= damping; p.vy *= damping;
      p.x = Math.max(40, Math.min(W - 40, p.x + p.vx * 0.1));
      p.y = Math.max(40, Math.min(H - 40, p.y + p.vy * 0.1));
    }
  }

  // Run 50 iterations synchronously for a reasonable starting layout
  for (let iter = 0; iter < 50; iter++) {
    runForceIteration();
  }

  // Store remaining animation state on canvas for animated settling
  // ~150 more iterations at 2-3 per frame ≈ 50-75 frames ≈ ~2 seconds at 30fps
  canvas._forceState = {
    remainingIterations: 150,
    runIteration: runForceIteration
  };

  return positions;
}

// ── Entity detail on canvas click ────────────────────────────────
function showEntityDetail(nodes, edges, canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const mx = (evt.clientX - rect.left) * scaleX;
  const my = (evt.clientY - rect.top) * scaleX;
  const detail = document.getElementById('graph-entity-detail');
  const positions = canvas._positions;
  if (!positions) return;
  const degrees = getNodeDegrees(nodes, edges);
  for (const n of nodes) {
    const p = positions[n.id];
    if (!p) continue;
    const deg = degrees[n.id] || 0;
    const r = Math.max(14, Math.min(30, 14 + deg * 3)) * graphZoom;
    const tx = p.x * graphZoom + graphPanX;
    const ty = p.y * graphZoom + graphPanY;
    if (Math.sqrt((mx - tx) ** 2 + (my - ty) ** 2) <= r + 4) {
      // Toggle selection — click same node to deselect
      graphSelectedNode = (graphSelectedNode === n.id) ? null : n.id;
      document.getElementById('ged-name').textContent = n.label;
      document.getElementById('ged-type').textContent = n.type;
      document.getElementById('ged-aliases').textContent = '';
      const factsEl = document.getElementById('ged-facts');
      factsEl.innerHTML = (n.facts && n.facts.length > 0)
        ? n.facts.map(f => '<li>' + escHtml(f) + '</li>').join('')
        : '<li style="color:var(--text-dim)">No facts recorded yet</li>';
      detail.style.display = 'block';
      if (graphLastNodes && graphLastEdges) drawGraphitiGraph(canvas, graphLastNodes, graphLastEdges);
      return;
    }
  }
  graphSelectedNode = null;
  detail.style.display = 'none';
  if (graphLastNodes && graphLastEdges) drawGraphitiGraph(canvas, graphLastNodes, graphLastEdges);
}

// ── Logs panel ───────────────────────────────────────────────────
let logsInterval = null;
let allLogLines = [];

async function loadLogs() {
  try {
    const r = await fetch('/api/logs?lines=200', {headers:authHeaders()});
    if (!r.ok) { toast('Failed to load logs', 'error'); return; }
    const data = await r.json();
    allLogLines = data.lines || [];
    renderLogs();
  } catch(e) { toast('Failed to load logs', 'error'); }
}

function renderLogs() {
  const filter = (document.getElementById('log-filter')?.value || '').toLowerCase();
  const lines = filter ? allLogLines.filter(l => l.toLowerCase().includes(filter)) : allLogLines;
  const container = document.getElementById('logs-container');
  if (!container) return;
  if (lines.length === 0) { container.innerHTML = '<span style="color:var(--text-dim)">No log lines found.</span>'; return; }
  container.innerHTML = lines.map(line => {
    let color = 'var(--text)';
    if (line.includes('ERROR')) color = 'var(--error)';
    else if (line.includes('WARN')) color = 'var(--warn)';
    else if (line.includes('DEBUG')) color = 'var(--text-dim)';
    return '<span style="color:' + color + ';display:block">' + escHtml(line) + '</span>';
  }).join('');
  container.scrollTop = container.scrollHeight;
}

let filterTimeout;
function filterLogs() {
  clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => { renderLogs(); }, 200);
}

function startLogs() {
  loadLogs();
  if (logsInterval) clearInterval(logsInterval);
  logsInterval = setInterval(loadLogs, 4000);
}

function stopLogs() {
  if (logsInterval) { clearInterval(logsInterval); logsInterval = null; }
}


// ── Voice Chat ──────────────────────────────────────────────────
async function loadVoicePanel() {
  try {
    const r = await fetch('/api/voice/status', {headers:authHeaders()});
    const data = await r.json();
    document.getElementById('voice-status').textContent = data.available ? 'Online' : 'Offline';
    document.getElementById('voice-status').style.color = data.available ? 'var(--accent3)' : 'var(--error)';
    document.getElementById('voice-livekit-url').textContent = data.livekitUrl || '—';
    document.getElementById('voice-tts-voice').textContent = data.ttsVoice || '—';
  } catch(e) {
    document.getElementById('voice-status').textContent = 'Error';
    document.getElementById('voice-status').style.color = 'var(--error)';
  }
}

// Check for Google OAuth callback redirect
if (window.location.search.includes('google_connected=1')) {
  window.history.replaceState({}, '', '/');
  setTimeout(() => toast('Google account connected successfully!', 'success'), 500);
}

// Check if we need to show onboarding
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const r = await fetch('/api/profile', {headers:authHeaders()});
    if (r.ok) {
      const profile = await r.json();
      if (!profile.name) {
        // Name is missing, likely first run
        document.getElementById('onboarding-modal').classList.add('show');
      }
    }
  } catch(e) {}
});
</script>
</body>
</html>`;
}
