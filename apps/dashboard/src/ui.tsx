import { raw } from "hono/html";
import type { Child } from "hono/jsx";

/**
 * The dashboard's design system: tokens, the app shell and a small set of primitives.
 * Server-rendered and dependency-free (one self-hosted font). Every page composes these,
 * so spacing, type and color stay consistent.
 *
 * Type scale: 12 / 13 / 14 (body) / 16 / 20 (page title) / 28 (KPI).
 * Spacing: multiples of 4. Radius: 6 (controls), 10 (cards).
 * Data colors (series-1..3) come from a CVD-validated categorical palette; status colors
 * are reserved for state and always ship with a label.
 */
export const CSS = `
@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url(/assets/inter.woff2) format("woff2")}
:root{color-scheme:light;
--bg:#f7f7f5;--panel:#ffffff;--sidebar:#f1f0ed;--hover:#e9e8e4;--active:#e3e2dd;--border:#e4e3df;--border-strong:#d3d2cc;
--text:#18181a;--text-2:#52514e;--muted:#87867f;--primary:#18181a;--primary-fg:#ffffff;
--brand:#d9480f;--brand-soft:#fde8dc;
--good:#15803d;--good-soft:#e3f4e8;--warn:#a15c00;--warn-soft:#fbefd9;--bad:#c42b2b;--bad-soft:#fbe4e2;--info:#2a5fb0;--info-soft:#e4ecf8;
--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--grid:#ecebe7;
--shadow:0 1px 2px rgba(20,20,15,.04),0 1px 1px rgba(20,20,15,.03)}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;
--bg:#111110;--panel:#191918;--sidebar:#141413;--hover:#222220;--active:#2a2a27;--border:#2a2a27;--border-strong:#3a3a36;
--text:#f0efec;--text-2:#c3c2b7;--muted:#8f8e86;--primary:#f0efec;--primary-fg:#141413;
--brand:#f07a3e;--brand-soft:#3a2216;
--good:#4cc27a;--good-soft:#16301f;--warn:#e0a63a;--warn-soft:#352914;--bad:#ef6b6b;--bad-soft:#3a1a1a;--info:#7aa7ea;--info-soft:#1b2638;
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--grid:#242422;--shadow:none}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"cv11","ss01";-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}a.link{color:var(--info)}a.link:hover{text-decoration:underline}
code,.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.t2{color:var(--text-2)}
/* shell */
.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,var(--sidebar) 247px,var(--border) 247px,var(--border) 248px,transparent 248px)}
.side{background:var(--sidebar);border-right:1px solid var(--border);padding:14px 10px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px}
.brand .mark{width:26px;height:26px;border-radius:7px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;letter-spacing:-.02em}
.brand b{font-size:14px;font-weight:600;letter-spacing:-.01em}
.search{display:flex;align-items:center;gap:8px;margin:0 2px 10px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--muted)}
.search input{border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:13px;width:100%;padding:0}
.nav{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:7px;color:var(--text-2);font-size:13.5px;font-weight:450}
.nav:hover{background:var(--hover);color:var(--text)}.nav.on{background:var(--active);color:var(--text);font-weight:550}
.nav svg{flex:none;color:var(--muted)}.nav.on svg{color:var(--text)}
.nav .count{margin-left:auto;font-size:11px;font-weight:600;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--brand);color:#fff;display:grid;place-items:center}
.sect{display:flex;align-items:center;justify-content:space-between;margin:16px 10px 4px;font-size:11.5px;font-weight:550;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.factory{display:flex;align-items:center;gap:9px;padding:6px 10px;font-weight:600;font-size:13.5px}
.factory .fi{width:20px;height:20px;border-radius:5px;background:var(--text);color:var(--bg);display:grid;place-items:center;font-size:11px;font-weight:700}
.sub .nav{padding-left:38px}
.side .foot{margin-top:auto;padding:12px 10px 2px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:center;font-size:12.5px}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted)}
.dot.good{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.dot.info{background:var(--info)}
.dot.live{box-shadow:0 0 0 3px color-mix(in srgb,var(--info) 25%,transparent);animation:pulse 1.6s infinite}
@keyframes pulse{50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--info) 10%,transparent)}}
main{min-width:0;padding:28px 36px 56px;max-width:1280px;width:100%}
.ph{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.ph h1{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.015em;margin:0}
.ph .sub{color:var(--muted);font-size:13px;margin-top:2px}
.crumb{font-size:13px;color:var(--muted);margin-bottom:6px}.crumb a:hover{color:var(--text)}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* controls */
.btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:7px;border:1px solid var(--border-strong);background:var(--panel);color:var(--text);font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;box-shadow:var(--shadow)}
.btn:hover{background:var(--hover)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}.btn.primary:hover{opacity:.9}
.btn.danger{color:var(--bad)}
.seg{display:inline-flex;gap:6px}.seg a{height:32px;padding:0 14px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:7px;font-size:13px;font-weight:550;background:var(--panel);color:var(--text-2)}
.seg a:hover{background:var(--hover)}.seg a.on{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}
.range{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);margin-left:6px}
input.in,select.in{height:32px;padding:0 10px;border:1px solid var(--border-strong);border-radius:7px;background:var(--panel);color:var(--text);font:inherit;font-size:13px}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:14px;overflow-x:auto}
.tabs a{padding:8px 12px;font-size:13px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--text)}.tabs a.on{color:var(--text);border-color:var(--text);font-weight:550}
.tabs a .c{margin-left:6px;color:var(--muted);font-weight:450}
/* surfaces */
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);padding:18px 20px;min-width:0}
.card.flush{padding:0;overflow:hidden}
.card h3{margin:0;font-size:13px;font-weight:550;color:var(--text-2);display:flex;align-items:center;gap:6px}
.card .big{font-size:28px;line-height:36px;font-weight:600;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
.card .meta{font-size:12.5px;color:var(--muted);margin-top:2px}
.card .head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.grid{display:grid;gap:16px}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.stack{display:flex;flex-direction:column;gap:16px}
.section-title{font-size:14px;font-weight:600;margin:28px 0 12px;letter-spacing:-.005em}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-2)}.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:8px;height:8px;border-radius:50%;display:inline-block}
.note{font-size:12px;color:var(--muted);margin-top:10px}
/* table */
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:10px 16px;border-bottom:1px solid var(--border);white-space:nowrap;background:var(--panel)}
.tbl td{padding:11px 16px;border-bottom:1px solid var(--border);vertical-align:middle;white-space:nowrap}
.tbl tr:last-child td{border-bottom:0}.tbl tbody tr:hover td{background:color-mix(in srgb,var(--hover) 55%,transparent)}
.tbl .r{text-align:right}.tbl .title{font-weight:500;color:var(--text)}.tbl .title:hover{text-decoration:underline}
.tbl .wrapcell{white-space:normal;min-width:240px}
.scroll{overflow-x:auto}
/* badges */
.badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;font-size:12px;font-weight:550;background:var(--hover);color:var(--text-2);white-space:nowrap}
.badge.good{background:var(--good-soft);color:var(--good)}.badge.warn{background:var(--warn-soft);color:var(--warn)}.badge.bad{background:var(--bad-soft);color:var(--bad)}.badge.info{background:var(--info-soft);color:var(--info)}
.badge .dot{width:6px;height:6px}
.chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;border:1px solid var(--border);font-size:11.5px;color:var(--text-2);background:var(--panel)}
/* lists */
.kv{display:grid;grid-template-columns:120px minmax(0,1fr);gap:9px 12px;font-size:13px}.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.empty{padding:40px 20px;text-align:center;color:var(--muted);font-size:13px}
.empty b{display:block;color:var(--text);font-size:14px;font-weight:550;margin-bottom:4px}
.flash{display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:8px;margin-bottom:18px;background:var(--info-soft);color:var(--text);font-size:13px}
.alert{padding:12px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid}
.alert.bad{background:var(--bad-soft);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}.alert.warn{background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:10px;padding:7px 0;font-size:13px;position:relative}
.timeline li:before{content:"";position:absolute;left:8px;top:22px;bottom:-8px;width:1px;background:var(--border)}
.timeline li:last-child:before{display:none}
.timeline .dot{margin-top:6px;margin-left:4px}
.turn{border:1px solid var(--border);border-radius:9px;padding:12px 14px;margin-bottom:10px;background:var(--panel)}
.turn .top{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:13px}
.turn .sum{margin-top:8px;font-size:13px;color:var(--text-2);white-space:pre-wrap;overflow-wrap:anywhere}
pre.block{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.55 ui-monospace,Menlo,monospace;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;max-height:420px;overflow:auto}
details>summary{cursor:pointer;list-style:none}details>summary::-webkit-details-marker{display:none}
.msg{display:grid;grid-template-columns:28px minmax(0,1fr);gap:12px;padding:12px 0}
.msg .av{width:28px;height:28px;border-radius:7px;display:grid;place-items:center;font-size:11px;font-weight:700}
.msg .av.agent{background:var(--brand-soft);color:var(--brand)}.msg .av.user{background:var(--info-soft);color:var(--info)}
.tool{display:flex;gap:8px;align-items:center;font:12.5px ui-monospace,Menlo,monospace;color:var(--text-2);padding:5px 10px;margin:2px 0 2px 40px;border-left:2px solid var(--border)}
.tool.bad{color:var(--bad);border-color:var(--bad)}
/* charts */
.chart{position:relative;margin-top:14px}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart .gl{stroke:var(--grid)}.chart .ax{fill:var(--muted);font-size:11px;font-family:inherit}
.chart .xh{stroke:var(--border-strong);stroke-dasharray:3 3;visibility:hidden}
.chart .tip{position:absolute;pointer-events:none;visibility:hidden;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.12);padding:8px 10px;font-size:12px;min-width:140px;z-index:5}
.chart .tip b{display:block;font-weight:600;margin-bottom:4px;color:var(--text)}
.chart .tip div{display:flex;justify-content:space-between;gap:14px;color:var(--text-2)}
.chart .tip i{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.hbar{display:flex;height:10px;border-radius:5px;overflow:hidden;gap:2px;background:var(--hover)}
.hbar span{display:block;height:100%}
.meter{height:6px;border-radius:3px;background:var(--hover);overflow:hidden}.meter span{display:block;height:100%;background:var(--series-1);border-radius:3px}
/* list rows (runs, activity, scorers) */
.grid.detail{grid-template-columns:minmax(0,1fr) 320px}
.rows{background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);overflow:hidden}
.row{display:flex;align-items:center;gap:12px;padding:9px 16px;border-bottom:1px solid var(--border);font-size:13.5px;min-height:50px}
.row:last-child{border-bottom:0}.row:hover{background:color-mix(in srgb,var(--hover) 50%,transparent)}
.row .ttl{flex:1;min-width:0}
.row .ttl a,.row .ttl b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--text)}
.row .ttl a:hover{text-decoration:underline}
.row .s2{display:block;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .chips{display:flex;gap:6px;flex:none}
.row .when{flex:none;width:64px;text-align:right;color:var(--muted);font-size:12.5px}
.row .cost{flex:none;width:58px;text-align:right;font-size:13px;color:var(--text-2)}
.row .val{flex:none;text-align:right;min-width:72px}.row .val b{font-size:16px;font-weight:600}
.av{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:10.5px;font-weight:650;background:var(--hover);color:var(--text-2);flex:none;border:1px solid var(--border)}
.si{flex:none;width:24px;height:24px;border-radius:7px;display:grid;place-items:center;background:var(--hover);color:var(--muted)}
.si.good{background:var(--good-soft);color:var(--good)}.si.warn{background:var(--warn-soft);color:var(--warn)}.si.bad{background:var(--bad-soft);color:var(--bad)}.si.info{background:var(--info-soft);color:var(--info)}
.si.live svg{animation:spin 1.4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.chip{gap:5px;height:24px;padding:0 8px;border-radius:7px;font-size:12px;white-space:nowrap}
.chip svg{color:var(--muted)}a.chip:hover{background:var(--hover)}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--panel);margin-bottom:14px}
.filters .lbl{font-size:12.5px;color:var(--muted);margin-right:4px}
.filters a{height:26px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border-radius:7px;font-size:12.5px;color:var(--text-2);border:1px solid transparent}
.filters a:hover{background:var(--hover)}.filters a.on{background:var(--active);color:var(--text);font-weight:550;border-color:var(--border-strong)}
.filters .n{color:var(--muted);font-weight:450}.filters .right{margin-left:auto;font-size:12.5px;color:var(--muted)}
.group{margin-bottom:12px}
.group>summary{display:flex;align-items:center;gap:10px;padding:10px 16px;font-weight:600;font-size:13.5px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg) 60%,var(--panel))}
.group>summary .n{color:var(--muted);font-weight:450}.group>summary .chev{transition:transform .15s;color:var(--muted);display:inline-flex}
.group:not([open])>summary .chev{transform:rotate(-90deg)}.group:not([open])>summary{border-bottom:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.tile{background:var(--panel);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:22px;display:flex;flex-direction:column;min-height:200px;color:var(--text)}
a.tile:hover{border-color:var(--border-strong);background:color-mix(in srgb,var(--hover) 25%,var(--panel))}
.tile.ghost{border-style:dashed;box-shadow:none;background:transparent}
.tile .ic{width:44px;height:44px;border-radius:11px;display:grid;place-items:center;margin-bottom:18px}
.ic.brand{background:var(--brand-soft);color:var(--brand)}.ic.info{background:var(--info-soft);color:var(--info)}.ic.good{background:var(--good-soft);color:var(--good)}.ic.warn{background:var(--warn-soft);color:var(--warn)}.ic.neutral{background:var(--hover);color:var(--text-2)}
.tile h4{margin:0 0 6px;font-size:16px;font-weight:600;letter-spacing:-.01em}
.tile p{margin:0;color:var(--text-2);font-size:13.5px;line-height:1.55}
.tile .ft{margin-top:auto;padding-top:18px;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.form-sec{padding:22px 0;border-bottom:1px solid var(--border)}.form-sec:last-child{border-bottom:0}
.form-sec h2{margin:0;font-size:15px;font-weight:600}.form-sec .d{color:var(--muted);font-size:13px;margin:2px 0 14px}
.field{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px 14px;align-items:center;font-size:13px}.field dt{color:var(--muted)}.field dd{margin:0;display:flex;gap:6px;flex-wrap:wrap}
.ptabs{display:flex;gap:4px;margin-bottom:10px}
/* mobile */
.mtop{display:none}
@media (max-width:900px){
.app{grid-template-columns:1fr;background:none}.side{display:none}
.mtop{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--sidebar);position:sticky;top:0;z-index:10}
.mtop details{position:relative}.mtop .menu{position:absolute;right:0;top:40px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:8px;width:240px;box-shadow:0 10px 30px rgba(0,0,0,.15)}
main{padding:20px 16px 48px}.g2,.g3,.g4,.grid.detail{grid-template-columns:1fr}.row .chips,.row .cost,.row .av{display:none}.field{grid-template-columns:1fr}.kv{grid-template-columns:100px minmax(0,1fr)}
}
`;

/** Crosshair + tooltip for every chart (one tiny script; charts render fine without it). */
export const CHART_JS = `
document.querySelectorAll('.chart[data-points]').forEach(function(el){
  var pts=JSON.parse(el.getAttribute('data-points')),svg=el.querySelector('svg'),tip=el.querySelector('.tip'),xh=el.querySelector('.xh');
  if(!svg||!tip||!pts.length)return;
  function hide(){tip.style.visibility='hidden';if(xh)xh.style.visibility='hidden'}
  svg.addEventListener('mouseleave',hide);
  svg.addEventListener('mousemove',function(e){
    var r=svg.getBoundingClientRect(),vb=svg.viewBox.baseVal,x=(e.clientX-r.left)*vb.width/r.width,best=pts[0];
    pts.forEach(function(p){if(Math.abs(p.x-x)<Math.abs(best.x-x))best=p});
    if(xh){xh.setAttribute('x1',best.x);xh.setAttribute('x2',best.x);xh.style.visibility='visible'}
    tip.innerHTML='';var b=document.createElement('b');b.textContent=best.label;tip.appendChild(b);
    best.rows.forEach(function(row){var d=document.createElement('div'),l=document.createElement('span'),i=document.createElement('i'),v=document.createElement('span');i.style.background=row.color;l.appendChild(i);l.appendChild(document.createTextNode(row.name));v.textContent=row.value;v.className='num';d.appendChild(l);d.appendChild(v);tip.appendChild(d)});
    var px=best.x*r.width/vb.width,left=px+14;if(left+tip.offsetWidth>r.width)left=px-tip.offsetWidth-14;
    tip.style.left=Math.max(0,left)+'px';tip.style.top='8px';tip.style.visibility='visible';
  });
});
`;

// ───────────────────────────── icons ─────────────────────────────

const ICONS: Record<string, string> = {
  runs: '<path d="M4 5h12M4 10h12M4 15h12"/><circle cx="1.5" cy="5" r=".6"/><circle cx="1.5" cy="10" r=".6"/><circle cx="1.5" cy="15" r=".6"/>',
  env: '<circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.2 2.3 2.2 12.7 0 15M10 2.5c-2.2 2.3-2.2 12.7 0 15"/>',
  apps: '<rect x="2.5" y="2.5" width="6" height="6" rx="1.5"/><rect x="11.5" y="2.5" width="6" height="6" rx="1.5"/><rect x="2.5" y="11.5" width="6" height="6" rx="1.5"/><rect x="11.5" y="11.5" width="6" height="6" rx="1.5"/>',
  key: '<circle cx="6.5" cy="13.5" r="3.5"/><path d="M9 11l8-8M14 6l2.5 2.5M12 8l2 2"/>',
  dash: '<path d="M3 17V9M8 17V3M13 17v-6M18 17v-9"/>',
  activity: '<path d="M2 10h3.5l2.5-6 4 12 2.5-6H18"/>',
  agent: '<rect x="3.5" y="6" width="13" height="10" rx="2.5"/><path d="M10 6V3M7.5 11h.01M12.5 11h.01"/>',
  auto: '<path d="M11 2 4 11h5l-1 7 7-9h-5z"/>',
  scorer: '<path d="M10 2.5 12.2 7l5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 7.7l5-.7z"/>',
  bench: '<path d="M7.5 2.5h5M8.5 2.5v5L4 15.5a1.5 1.5 0 0 0 1.3 2h9.4a1.5 1.5 0 0 0 1.3-2L11.5 7.5v-5"/>',
  versions: '<circle cx="5" cy="4.5" r="2"/><circle cx="5" cy="15.5" r="2"/><circle cx="15" cy="8" r="2"/><path d="M5 6.5v7M15 10c0 3-4 3-8.5 4.5"/>',
  search: '<circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 4 4"/>',
  ext: '<path d="M11 3h6v6M17 3l-8 8M14.5 11.5V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1h4.5"/>',
  stop: '<rect x="5" y="5" width="10" height="10" rx="1.5"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  pr: '<circle cx="5" cy="4.5" r="2"/><circle cx="5" cy="15.5" r="2"/><circle cx="15" cy="15.5" r="2"/><path d="M5 6.5v7M15 13.5V8a2 2 0 0 0-2-2H9M11 4 9 6l2 2"/>',
  cal: '<rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M3 8.5h14M7 2.5v4M13 2.5v4"/>',
  menu: '<path d="M3 6h14M3 10h14M3 14h14"/>',
  info: '<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.5h.01"/>',
  flask: '<path d="M7.5 2.5h5M8.5 2.5v5L4 15.5a1.5 1.5 0 0 0 1.3 2h9.4a1.5 1.5 0 0 0 1.3-2L11.5 7.5v-5"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  x: '<path d="m5 5 10 10M15 5 5 15"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>',
  queued: '<circle cx="10" cy="10" r="6.5" stroke-dasharray="2.6 2.6"/>',
  spin: '<path d="M10 3.5a6.5 6.5 0 1 1-6.5 6.5"/>',
  eye: '<path d="M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.2"/>',
  minus: '<path d="M5 10h10"/>',
  chat: '<path d="M3.5 4.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3h-1A1.5 1.5 0 0 1 2 12V6a1.5 1.5 0 0 1 1.5-1.5z"/>',
  code: '<path d="m7 5.5-4.5 4.5L7 14.5M13 5.5l4.5 4.5-4.5 4.5M11.5 3.5l-3 13"/>',
  doc: '<path d="M5 2.5h6.5L15.5 6.5v11H5z"/><path d="M11 2.5v4.5h4.5M7.5 11h5M7.5 14h5"/>',
  image: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="m17.5 13.5-4-4-8 7"/>',
  issue: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.2"/>',
  chev: '<path d="m5.5 7.5 4.5 4.5 4.5-4.5"/>',
  shield: '<path d="M10 2.5 16 5v5c0 3.8-2.6 6.4-6 7.5-3.4-1.1-6-3.7-6-7.5V5z"/>',
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{raw(ICONS[name] ?? "")}</svg>
  );
}

// ───────────────────────────── shell ─────────────────────────────

export type Nav = "runs" | "environments" | "apps" | "secrets" | "dashboard" | "activity" | "agents" | "automations" | "factory-runs" | "scorers" | "bench" | "versions";

export interface ShellProps {
  title: string;
  nav: Nav;
  flash: string | null;
  inboxCount?: number;
  refreshSec?: number;
  factory?: { name: string; version: string } | null;
  children: Child;
}

function NavLink({ href, icon, label, on, count }: { href: string; icon?: string; label: string; on: boolean; count?: number }) {
  return (
    <a href={href} class={`nav${on ? " on" : ""}`}>
      {icon ? <Icon name={icon} /> : null}
      <span>{label}</span>
      {count ? <span class="count">{count}</span> : null}
    </a>
  );
}

function NavItems({ p }: { p: ShellProps }) {
  const f = p.factory ?? { name: "factory", version: "" };
  return (
    <>
      <NavLink href="/runs" icon="runs" label="Runs" on={p.nav === "runs"} />
      <NavLink href="/environments" icon="env" label="Environments" on={p.nav === "environments"} />
      <NavLink href="/apps" icon="apps" label="MCPs and apps" on={p.nav === "apps"} />
      <NavLink href="/secrets" icon="key" label="Secrets" on={p.nav === "secrets"} />
      <div class="sect"><span>Factories</span></div>
      <div class="factory"><span class="fi">{f.name.slice(0, 1).toUpperCase()}</span><span>{f.name}</span>{f.version ? <span class="chip mono" style="margin-left:auto">{f.version.slice(0, 10)}</span> : null}</div>
      <div class="sub">
        <NavLink href="/" label="Dashboard" on={p.nav === "dashboard"} />
        <NavLink href="/activity" label="Activity" on={p.nav === "activity"} count={p.inboxCount} />
        <NavLink href="/agents" label="Agents" on={p.nav === "agents"} />
        <NavLink href="/automations" label="Automations" on={p.nav === "automations"} />
        <NavLink href="/runs?scope=factory" label="Runs" on={p.nav === "factory-runs"} />
        <NavLink href="/scorers" label="Scorers" on={p.nav === "scorers"} />
        <NavLink href="/bench" label="Benchmarks" on={p.nav === "bench"} />
        <NavLink href="/versions" label="Versions" on={p.nav === "versions"} />
      </div>
    </>
  );
}

export function Shell(p: ShellProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {p.refreshSec ? <meta http-equiv="refresh" content={String(p.refreshSec)} /> : null}
        <title>{`${p.title} · SlopwareFactory`}</title>
        <link rel="preload" href="/assets/inter.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <div class="mtop">
          <a href="/" class="brand" style="padding:0"><span class="mark">SF</span><b>SlopwareFactory</b></a>
          <details>
            <summary class="btn" aria-label="Menu"><Icon name="menu" /></summary>
            <div class="menu"><NavItems p={p} /></div>
          </details>
        </div>
        <div class="app">
          <aside class="side">
            <a href="/" class="brand"><span class="mark">SF</span><b>SlopwareFactory</b></a>
            <form class="search" method="get" action="/runs">
              <Icon name="search" />
              <input name="q" placeholder="Search runs" aria-label="Search runs" />
            </form>
            <NavItems p={p} />
            <div class="foot"><span class="dot good" /><span class="t2">Connected to factory</span></div>
          </aside>
          <main>
            {p.flash !== null ? <div class="flash"><Icon name="info" />{p.flash}</div> : null}
            {p.children}
          </main>
        </div>
        <script dangerouslySetInnerHTML={{ __html: CHART_JS }} />
      </body>
    </html>
  );
}

// ───────────────────────────── primitives ─────────────────────────────

export function PageHeader({ title, sub, crumb, children }: { title: Child; sub?: Child; crumb?: Child; children?: Child }) {
  return (
    <div class="ph">
      <div style="min-width:0">
        {crumb ? <div class="crumb">{crumb}</div> : null}
        <h1>{title}</h1>
        {sub ? <div class="sub">{sub}</div> : null}
      </div>
      {children ? <div class="actions">{children}</div> : null}
    </div>
  );
}

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export function Badge({ tone = "neutral", children, dot = true, live = false }: { tone?: Tone; children: Child; dot?: boolean; live?: boolean }) {
  return (
    <span class={`badge ${tone}`}>
      {dot ? <span class={`dot ${tone}${live ? " live" : ""}`} /> : null}
      {children}
    </span>
  );
}

export function Stat({ title, value, meta, hint, children }: { title: string; value: Child; meta?: Child; hint?: string; children?: Child }) {
  return (
    <div class="card">
      <h3>{title}{hint ? <span title={hint} class="muted" style="display:inline-flex"><Icon name="info" size={14} /></span> : null}</h3>
      <div class="big">{value}</div>
      {meta ? <div class="meta">{meta}</div> : null}
      {children}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: Child }) {
  return (
    <div class="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}
