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
@font-face{font-family:"Mona Sans";font-style:normal;font-weight:200 900;font-stretch:75% 125%;font-display:swap;src:url(/assets/mona-sans.woff2) format("woff2")}
:root{color-scheme:light;
--paper:#f4f6f6;--sheet:#ffffff;--hover:#eceff0;--active:#e3e7e8;--rule:#e1e5e6;--rule-2:#cdd3d5;
--ink:#161b1e;--ink-2:#475055;--quiet:#737c81;--on-ink:#ffffff;--hivis:#ffd400;--on-hivis:#161b1e;
--good:#1d7a4c;--warn:#9a5a00;--bad:#c0352d;--bad-wash:#fbeceb;--warn-wash:#fbf2e2;
--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--grid:#e9eced;--ref:#9aa3a8;
--ease:cubic-bezier(.2,.8,.2,1)}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;
--paper:#0e1113;--sheet:#15191c;--hover:#1d2226;--active:#242a2e;--rule:#252b2f;--rule-2:#343b40;
--ink:#e6eaec;--ink-2:#b4bcc1;--quiet:#8a9398;--on-ink:#0e1113;
--good:#4cc488;--warn:#e2a640;--bad:#f07067;--bad-wash:#2a1716;--warn-wash:#2a2112;
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--grid:#20262a;--ref:#5d666b}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--paper);color:var(--ink);font:14px/1.45 "Mona Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-stretch:100%;-webkit-font-smoothing:antialiased}
::selection{background:var(--hivis);color:var(--on-hivis)}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:4px}
a{color:inherit;text-decoration:none}a.link{text-decoration:underline;text-decoration-color:var(--rule-2);text-underline-offset:3px}a.link:hover{text-decoration-color:var(--ink)}
code,.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
.num{font-variant-numeric:tabular-nums}.muted{color:var(--quiet)}.t2{color:var(--ink-2)}
h1,h2,h3{text-wrap:balance}
/* shell */
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{border-right:1px solid var(--rule);padding:16px 12px;display:flex;flex-direction:column;gap:1px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;padding:2px 8px 18px}
.brand .mark{width:22px;height:22px;border-radius:5px;background:var(--hivis);position:relative;flex:none}
.brand .mark:after{content:"";position:absolute;inset:6px 6px 6px 6px;border:2px solid var(--on-hivis);border-radius:2px}
.brand b{font-size:15px;font-weight:650;font-stretch:112%;letter-spacing:-.01em}
.search{display:flex;align-items:center;gap:8px;margin:0 0 14px;padding:0 10px;height:32px;border:1px solid var(--rule);border-radius:6px;background:var(--sheet);color:var(--quiet)}
.search input{border:0;outline:0;background:transparent;color:var(--ink);font:inherit;font-size:13px;width:100%;padding:0}
.nav{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-radius:6px;color:var(--ink-2);font-size:14px;transition:background .12s var(--ease)}
.nav:hover{background:var(--hover);color:var(--ink)}.nav.on{background:var(--sheet);color:var(--ink);font-weight:550;box-shadow:inset 0 0 0 1px var(--rule)}
.nav svg{flex:none;color:var(--quiet)}.nav.on svg{color:var(--ink)}
.nav .count{margin-left:auto;font-size:12px;font-weight:650;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--hivis);color:var(--on-hivis);display:grid;place-items:center}
.sect{margin:22px 10px 6px;font-size:12.5px;color:var(--quiet)}
.factory{display:flex;align-items:center;gap:9px;height:32px;padding:0 10px;font-weight:600;font-size:14px}
.factory .fi{width:18px;height:18px;border-radius:4px;background:var(--ink);color:var(--on-ink);display:grid;place-items:center;font-size:11px;font-weight:700}
.factory .ver{margin-left:auto;font-weight:400;color:var(--quiet);font-size:12px}
.subnav{margin-left:18px;padding-left:10px;border-left:1px solid var(--rule)}
.side .foot{margin-top:auto;padding:12px 10px 0;display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--quiet)}
.dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--quiet)}
.dot.good{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.dot.hivis{background:var(--hivis);box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 25%,transparent)}
main{min-width:0;padding:28px 40px 64px;max-width:1240px;width:100%}
.ph{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap;min-height:36px}
.ph h1{font-size:22px;line-height:28px;font-weight:650;font-stretch:112%;letter-spacing:-.015em;margin:0}
.ph .sub{color:var(--ink-2);font-size:14px;margin-top:4px;max-width:72ch}
.crumb{font-size:13px;color:var(--quiet);margin-bottom:6px}.crumb a:hover{color:var(--ink)}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* controls */
.btn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:6px;border:1px solid var(--rule-2);background:var(--sheet);color:var(--ink);font:inherit;font-size:13.5px;font-weight:550;cursor:pointer;white-space:nowrap;transition:background .12s var(--ease)}
.btn:hover{background:var(--hover)}
.btn.primary{background:var(--ink);border-color:var(--ink);color:var(--on-ink)}.btn.primary:hover{background:color-mix(in srgb,var(--ink) 88%,var(--paper))}
.btn.danger{color:var(--bad)}
.seg{display:inline-flex;padding:2px;border:1px solid var(--rule-2);border-radius:7px;background:var(--sheet)}
.seg a{height:26px;padding:0 12px;display:grid;place-items:center;border-radius:5px;font-size:13px;font-weight:550;color:var(--ink-2);transition:background .12s var(--ease)}
.seg a:hover{background:var(--hover)}.seg a.on{background:var(--ink);color:var(--on-ink)}
.range{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--ink-2);margin-left:4px}
input.in,select.in{height:32px;padding:0 10px;border:1px solid var(--rule-2);border-radius:6px;background:var(--sheet);color:var(--ink);font:inherit;font-size:13.5px}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--rule);margin-bottom:16px;overflow-x:auto}
.tabs a{padding:8px 10px;font-size:14px;color:var(--quiet);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--ink)}.tabs a.on{color:var(--ink);border-color:var(--ink);font-weight:550}
.tabs a .c{margin-left:6px;color:var(--quiet);font-weight:400}
/* panels */
.card{background:var(--sheet);border:1px solid var(--rule);border-radius:8px;padding:20px 22px;min-width:0}
.card.flush{padding:0;overflow:hidden}
.card h3,.panel-h{margin:0;font-size:15px;font-weight:600;letter-spacing:-.005em;display:flex;align-items:center;gap:6px}
.card .big{font-size:32px;line-height:38px;font-weight:600;font-stretch:118%;letter-spacing:-.02em;margin-top:10px}
.card .meta{font-size:13px;color:var(--ink-2);margin-top:2px}
.card .head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.split>*{padding:20px 22px;min-width:0}.split>*+*{border-left:1px solid var(--rule)}
.grid{display:grid;gap:16px}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.grid.detail{grid-template-columns:minmax(0,1fr) 300px}
.stack{display:flex;flex-direction:column;gap:16px}
.section-title{font-size:15px;font-weight:600;margin:36px 0 12px;letter-spacing:-.005em;display:flex;align-items:baseline;gap:8px}
.section-title .n{color:var(--quiet);font-weight:400;font-size:14px}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--ink-2)}.legend span{display:inline-flex;align-items:center;gap:7px}
.legend i{width:10px;height:3px;border-radius:2px;display:inline-block}.legend i.sq{width:9px;height:9px;border-radius:2px}.legend i.ref{height:0;border-top:2px dashed var(--ref);background:none}
.note{font-size:13px;color:var(--quiet);margin-top:12px;max-width:80ch}
/* readout strip */
.readout{display:grid;grid-template-columns:repeat(var(--cols,4),minmax(0,1fr));background:var(--sheet);border:1px solid var(--rule);border-radius:8px;margin-bottom:16px}
.readout>div{padding:16px 20px 18px;min-width:0}.readout>div+div{border-left:1px solid var(--rule)}
.readout .k{font-size:13px;color:var(--ink-2);display:flex;align-items:center;gap:6px}
.readout .v{font-size:32px;line-height:38px;font-weight:600;font-stretch:118%;letter-spacing:-.02em;margin-top:6px}
.readout .c{font-size:12.5px;color:var(--quiet);margin-top:2px}
/* table */
.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th{text-align:left;font-weight:500;color:var(--quiet);font-size:12.5px;padding:10px 16px;border-bottom:1px solid var(--rule);white-space:nowrap}
.tbl td{padding:11px 16px;border-bottom:1px solid var(--rule);vertical-align:middle;white-space:nowrap}
.tbl tr:last-child td{border-bottom:0}.tbl tbody tr:hover td{background:var(--hover)}
.tbl .r{text-align:right}.tbl .title{font-weight:550;color:var(--ink)}.tbl .title:hover{text-decoration:underline}
.tbl .wrapcell{white-space:normal;min-width:240px}
.scroll{overflow-x:auto}
/* status words */
.badge{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:550;color:var(--ink-2);white-space:nowrap}
.badge.good{color:var(--good)}.badge.warn{color:var(--warn)}.badge.bad{color:var(--bad)}
.badge .dot{width:7px;height:7px}
.chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--rule);font-size:12.5px;color:var(--ink-2);background:var(--sheet);white-space:nowrap}
.chip svg{color:var(--quiet)}a.chip:hover{border-color:var(--rule-2);color:var(--ink)}
/* lists */
.kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px 12px;font-size:14px}.kv dt{color:var(--quiet)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.empty{padding:36px 20px;text-align:center;color:var(--quiet);font-size:14px}
.empty b{display:block;color:var(--ink);font-size:15px;font-weight:600;margin-bottom:4px}
.flash{display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:8px;margin-bottom:20px;background:var(--sheet);border:1px solid var(--rule);font-size:14px}
.flash svg{color:var(--ink)}
.alert{padding:12px 14px;border-radius:8px;font-size:14px;margin-bottom:16px}
.alert.bad{background:var(--bad-wash);color:var(--ink)}.alert.warn{background:var(--warn-wash);color:var(--ink)}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:12px;padding:6px 0;font-size:14px;position:relative}
.timeline li:before{content:"";position:absolute;left:6px;top:21px;bottom:-7px;width:1px;background:var(--rule)}
.timeline li:last-child:before{display:none}
.timeline .dot{margin-top:7px;margin-left:3px}
.turn{border-top:1px solid var(--rule);padding:14px 0}
.turn:first-child{border-top:0;padding-top:4px}
.turn .top{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:14px}
.turn .sum{margin-top:6px;font-size:14px;color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere;max-width:80ch}
pre.block{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.6 ui-monospace,Menlo,monospace;background:var(--paper);border:1px solid var(--rule);border-radius:6px;padding:14px;max-height:420px;overflow:auto}
details>summary{cursor:pointer;list-style:none}details>summary::-webkit-details-marker{display:none}
.msg{display:grid;grid-template-columns:72px minmax(0,1fr);gap:16px;padding:12px 0;border-top:1px solid var(--rule)}
.msg:first-child{border-top:0}
.msg .who{font-size:12.5px;color:var(--quiet);padding-top:2px}
.tool{display:grid;grid-template-columns:72px 16px minmax(0,1fr) auto;gap:16px;align-items:center;font:12.5px ui-monospace,Menlo,monospace;color:var(--ink-2);padding:4px 0}
.tool.bad{color:var(--bad)}
/* charts */
.chart{position:relative;margin-top:16px}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart .gl{stroke:var(--grid)}.chart .ax{fill:var(--quiet);font-size:11.5px;font-family:inherit}
.chart .refl{stroke:var(--ref);stroke-dasharray:4 4;stroke-width:1.5}
.chart .xh{stroke:var(--rule-2);visibility:hidden}
.chart .tip{position:absolute;pointer-events:none;visibility:hidden;background:var(--sheet);border:1px solid var(--rule-2);border-radius:6px;box-shadow:0 8px 24px rgba(10,20,25,.12);padding:8px 10px;font-size:12.5px;min-width:150px;z-index:5}
.chart .tip b{display:block;font-weight:600;margin-bottom:4px;color:var(--ink)}
.chart .tip div{display:flex;justify-content:space-between;gap:14px;color:var(--ink-2)}
.chart .tip i{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:6px}
.hbar{display:flex;height:8px;border-radius:2px;overflow:hidden;gap:2px}
.hbar span{display:block;height:100%;border-radius:2px}
/* run rows */
.rows{background:var(--sheet);border:1px solid var(--rule);border-radius:8px;overflow:hidden}
.row{display:grid;grid-template-columns:18px minmax(0,1fr) 78px 64px 64px;align-items:center;gap:14px;padding:10px 18px;border-top:1px solid var(--rule);font-size:14px;min-height:56px}
.rows>.row:first-child,.rows>summary+.row,.group>summary+.row{border-top:0}
.row:hover{background:var(--hover)}
.row .ttl{min-width:0}
.row .ttl a,.row .ttl b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550;color:var(--ink)}
.row .ttl a:hover{text-decoration:underline}
.row .s2{display:block;font-size:13px;color:var(--quiet);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.row .s2 .w{color:var(--ink-2);margin-right:8px}
.more{display:block;padding:12px 18px;border-top:1px solid var(--rule);font-size:13.5px}
.row .pr{font-size:13px;color:var(--ink-2);text-align:right}.row .pr a:hover{text-decoration:underline}
.row .cost{text-align:right;font-size:14px}
.row .when{text-align:right;color:var(--quiet);font-size:13px}
.row .val{text-align:right;min-width:72px}.row .val b{font-size:17px;font-weight:600;font-stretch:112%}
.row.needs{box-shadow:inset 3px 0 0 var(--hivis)}
.rowhead{display:grid;grid-template-columns:18px minmax(0,1fr) 78px 64px 64px;gap:14px;padding:0 18px 8px;font-size:12.5px;color:var(--quiet)}.rowhead span:nth-child(n+3){text-align:right}
/* status glyphs */
.si{flex:none;width:16px;height:16px;display:grid;place-items:center;color:var(--quiet)}
.si.good{color:var(--good)}.si.warn{color:var(--warn)}.si.bad{color:var(--bad)}.si.info{color:var(--ink)}
.si.live svg{animation:spin 1.2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.si.live svg{animation:none}*{transition:none!important}}
/* activity groups */
.filters{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:20px}
.filters a{height:30px;padding:0 12px;display:inline-flex;align-items:center;gap:7px;border-radius:15px;font-size:13.5px;color:var(--ink-2);border:1px solid var(--rule-2);background:var(--sheet)}
.filters a:hover{background:var(--hover)}.filters a.on{background:var(--ink);border-color:var(--ink);color:var(--on-ink)}
.filters a .n{opacity:.65}.filters .right{margin-left:auto;font-size:13px;color:var(--quiet)}
.group{margin-bottom:14px}
.group>summary{display:flex;align-items:center;gap:10px;padding:12px 18px;font-weight:600;font-size:14.5px}
.group[open]>summary{border-bottom:1px solid var(--rule)}
.group>summary .n{color:var(--quiet);font-weight:400}.group>summary .chev{transition:transform .12s var(--ease);color:var(--quiet);display:inline-flex;margin-left:auto}
.group:not([open])>summary .chev{transform:rotate(-90deg)}
/* spec sheet (agents) */
.spec{background:var(--sheet);border:1px solid var(--rule);border-radius:8px}
.spec>a,.spec>div{display:grid;grid-template-columns:200px minmax(0,1fr) 220px;gap:24px;padding:22px 24px;border-top:1px solid var(--rule);align-items:start}
.spec>:first-child{border-top:0}.spec>a:hover{background:var(--hover)}
.spec h4{margin:0;font-size:17px;font-weight:650;font-stretch:112%}
.spec .role{font-size:13px;color:var(--quiet);margin-top:2px}
.spec p{margin:0;color:var(--ink-2);font-size:14.5px;line-height:1.55;max-width:62ch}
.spec .kv{grid-template-columns:70px minmax(0,1fr);font-size:13.5px}
.form-sec{padding:24px 0;border-top:1px solid var(--rule)}.form-sec:first-child{border-top:0;padding-top:4px}
.form-sec h2{margin:0;font-size:15px;font-weight:600}.form-sec .d{color:var(--quiet);font-size:13.5px;margin:2px 0 14px}
.field{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px 16px;align-items:center;font-size:14px}.field dt{color:var(--quiet)}.field dd{margin:0;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ptabs{margin-bottom:12px}
/* scope bar */
.scope{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 12px;background:var(--sheet);border:1px solid var(--rule);border-radius:8px;margin-bottom:22px;font-size:13.5px;min-height:44px}
.scope .lbl{color:var(--quiet);font-size:12.5px}
.scope .path{display:flex;gap:6px;align-items:center}.scope .path a{font-weight:550}.scope .path a:hover{text-decoration:underline}.scope .path .sep{color:var(--quiet)}
.scope .vr{width:1px;height:20px;background:var(--rule)}
.scope .chip a{color:var(--quiet);margin-left:2px}.scope .chip a:hover{color:var(--ink)}
.scope .grow{flex:1}
.pop{position:relative}.pop>summary{display:inline-flex;align-items:center;gap:4px;color:var(--ink-2);height:26px;padding:0 6px;border-radius:5px}.pop>summary:hover{background:var(--hover)}
.pop>.menu{position:absolute;z-index:20;top:32px;left:0;min-width:240px;max-height:420px;overflow:auto;background:var(--sheet);border:1px solid var(--rule-2);border-radius:8px;box-shadow:0 12px 32px rgba(10,20,25,.14);padding:6px}
.pop.right>.menu{left:auto;right:0}
.pop .menu a{display:flex;justify-content:space-between;gap:12px;padding:7px 10px;border-radius:5px;font-size:13.5px}.pop .menu a:hover{background:var(--hover)}.pop .menu a.on{font-weight:600}
.pop .menu .h{font-size:12px;color:var(--quiet);padding:8px 10px 4px}
.pop .menu form{display:grid;gap:8px;padding:6px}.pop .menu label{display:grid;gap:4px;font-size:12.5px;color:var(--quiet)}
/* life bar: asked, agent work, PR, review, merged, after merge */
.life{display:inline-flex;gap:3px;align-items:center}.life i{width:14px;height:4px;border-radius:2px;background:var(--rule);display:block}
.life i.d{background:var(--ink)}.life i.n{background:var(--hivis);box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 20%,transparent)}.life i.ok{background:var(--good)}.life i.x{background:var(--bad)}
.trow{display:grid;grid-template-columns:18px minmax(0,1fr) 96px 72px 64px;align-items:center;gap:14px;padding:11px 18px;border-top:1px solid var(--rule);font-size:14px;min-height:58px}
.rows>.trow:first-child{border-top:0}.trow:hover{background:var(--hover)}.trow.needs{box-shadow:inset 3px 0 0 var(--hivis)}
.trow .ttl{min-width:0}.trow .ttl a{font-weight:550;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.trow .ttl a:hover{text-decoration:underline}
.trow .s2{font-size:13px;color:var(--quiet);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.trow .s2 .w{color:var(--ink-2)}
.trow .r{text-align:right;font-size:13px;color:var(--ink-2)}
/* explorer */
.xp{display:grid;grid-template-columns:240px minmax(0,1fr);gap:16px}
.xp .ctl{display:flex;flex-direction:column;gap:18px}
.xp .ctl h4{margin:0 0 6px;font-size:12.5px;font-weight:500;color:var(--quiet)}
.xp .opts{display:flex;flex-direction:column;gap:1px}.xp .opts a{padding:6px 10px;border-radius:5px;font-size:13.5px;color:var(--ink-2)}.xp .opts a:hover{background:var(--hover)}.xp .opts a.on{background:var(--ink);color:var(--on-ink);font-weight:550}
.bars{display:grid;grid-template-columns:minmax(120px,200px) minmax(0,1fr) 120px;gap:10px 14px;align-items:center;font-size:13.5px}
.bars .lab{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bars .lab a:hover{text-decoration:underline}
.bars .track{display:flex;flex-direction:column;gap:3px}
.bars .bar{height:12px;border-radius:0 3px 3px 0;min-width:2px;display:block}
.bars .val{text-align:right;font-variant-numeric:tabular-nums}.bars .val a:hover{text-decoration:underline}.bars .val .c{color:var(--quiet);font-size:12px;margin-left:4px}
.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.views a{display:block;padding:8px 10px;border-radius:6px}.views a:hover{background:var(--hover)}.views .who{font-size:12px;color:var(--quiet)}
.convo{display:flex;flex-direction:column;gap:2px}
.say{display:grid;grid-template-columns:120px minmax(0,1fr) auto;gap:14px;padding:12px 0;border-top:1px solid var(--rule);font-size:14px}
.say:first-child{border-top:0}.say .who{color:var(--quiet);font-size:13px}.say .who b{color:var(--ink);font-weight:600;display:block}.say .txt{white-space:pre-wrap;overflow-wrap:anywhere;max-width:80ch}.say .at{color:var(--quiet);font-size:12.5px}
.say.agent .who b:before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--hivis);margin-right:6px;box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 25%,transparent)}
.ask{display:flex;gap:8px;margin-top:14px}.ask textarea{flex:1;min-height:64px;padding:10px 12px;border:1px solid var(--rule-2);border-radius:8px;background:var(--sheet);color:var(--ink);font:inherit;font-size:14px;resize:vertical}
.risk{display:inline-flex;align-items:center;gap:6px;font-weight:600}.risk i{width:9px;height:9px;border-radius:50%;display:inline-block}
.risk.low i{background:var(--good)}.risk.medium i{background:var(--warn)}.risk.high i{background:var(--bad)}
.who-list a{display:flex;justify-content:space-between;padding:10px 12px;border-radius:6px;border:1px solid var(--rule);background:var(--sheet);margin-bottom:6px}.who-list a:hover{border-color:var(--ink)}
@media (max-width:900px){.xp{grid-template-columns:1fr}.bars{grid-template-columns:110px minmax(0,1fr) 90px}.trow{grid-template-columns:18px minmax(0,1fr) 64px;padding:10px 14px}.trow>:nth-child(3),.trow>:nth-child(4){display:none}.say{grid-template-columns:1fr}}
/* mobile */
.mtop{display:none}
@media (max-width:900px){
.app{grid-template-columns:1fr}.side{display:none}
.mtop{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--rule);background:var(--paper);position:sticky;top:0;z-index:10}
.mtop details{position:relative}.mtop .menu{position:absolute;right:0;top:40px;background:var(--sheet);border:1px solid var(--rule);border-radius:8px;padding:8px;width:240px;box-shadow:0 10px 30px rgba(0,0,0,.15)}
main{padding:20px 16px 48px}.g2,.g3,.g4,.grid.detail,.split{grid-template-columns:1fr}.split>*+*{border-left:0;border-top:1px solid var(--rule)}
.readout{grid-template-columns:repeat(2,minmax(0,1fr))}.readout>div:last-child:nth-child(odd){grid-column:1/-1}.split>*{overflow-x:auto}.chart{overflow-x:auto}.chart svg{min-width:560px}.readout>div:nth-child(odd){border-left:0}.readout>div:nth-child(n+3){border-top:1px solid var(--rule)}
.row,.rowhead{grid-template-columns:18px minmax(0,1fr) 56px;padding-left:14px;padding-right:14px}.row .pr,.row .cost,.rowhead span:nth-child(3),.rowhead span:nth-child(4){display:none}
.spec>a,.spec>div{grid-template-columns:1fr;gap:10px}.field,.kv{grid-template-columns:96px minmax(0,1fr)}.msg,.tool{grid-template-columns:56px minmax(0,1fr)}.tool>:nth-child(2),.tool>:nth-child(4){display:none}
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
  inbox: '<path d="M2.5 11.5 5 4h10l2.5 7.5V16a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/><path d="M2.5 11.5h4l1 2h5l1-2h4"/>',
  chart: '<path d="M3 17V9M8 17V3M13 17v-6M18 17v-9"/>',
  factory: '<path d="M2.5 17V8l5 3V8l5 3V4h5v13z"/><path d="M6 14h1.5M10 14h1.5"/>',
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
  half: '<circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/>',
  done: '<circle cx="10" cy="10" r="7.5" fill="currentColor" stroke="none"/><path d="m6.6 10.2 2.4 2.4 4.4-4.8" stroke="var(--sheet)" stroke-width="1.8"/>',
  fail: '<circle cx="10" cy="10" r="7.5" fill="currentColor" stroke="none"/><path d="m7.3 7.3 5.4 5.4M12.7 7.3l-5.4 5.4" stroke="var(--sheet)" stroke-width="1.8"/>',
  spin: '<circle cx="10" cy="10" r="6.5" opacity=".25"/><path d="M10 3.5a6.5 6.5 0 0 1 6.5 6.5" stroke-width="2"/>',
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

export type Nav = "inbox" | "tasks" | "insights" | "bench" | "factories" | "scorers" | "teams" | "none";

export interface ShellProps {
  title: string;
  nav: Nav;
  flash: string | null;
  inboxCount?: number;
  refreshSec?: number;
  factory?: { name: string; version: string } | null;
  /** Who is using the app (picked on /signin), or null. */
  viewer?: string | null;
  /** The scope bar, when the page has one. */
  scope?: Child;
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
  return (
    <>
      <NavLink href="/" icon="inbox" label="Inbox" on={p.nav === "inbox"} count={p.inboxCount} />
      <NavLink href="/tasks" icon="runs" label="Tasks" on={p.nav === "tasks"} />
      <NavLink href="/insights" icon="chart" label="Insights" on={p.nav === "insights"} />
      <NavLink href="/bench" icon="bench" label="Benchmarks" on={p.nav === "bench"} />
      <NavLink href="/factories" icon="factory" label="Factories" on={p.nav === "factories"} />
      <NavLink href="/scorers" icon="scorer" label="Scorers" on={p.nav === "scorers"} />
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
        <link rel="preload" href="/assets/mona-sans.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <div class="mtop">
          <a href="/" class="brand" style="padding:0"><span class="mark" aria-hidden="true" /><b>SlopwareFactory</b></a>
          <details>
            <summary class="btn" aria-label="Menu"><Icon name="menu" /></summary>
            <div class="menu"><NavItems p={p} /></div>
          </details>
        </div>
        <div class="app">
          <aside class="side">
            <a href="/" class="brand"><span class="mark" aria-hidden="true" /><b>SlopwareFactory</b></a>
            <form class="search" method="get" action="/tasks">
              <Icon name="search" />
              <input name="q" placeholder="Search tasks" aria-label="Search tasks" />
            </form>
            <NavItems p={p} />
            <div class="foot" style="flex-direction:column;align-items:flex-start;gap:4px">
              <span>{p.viewer ? <>Signed in as <b style="color:var(--ink);font-weight:600">{p.viewer}</b></> : "Not signed in"} · <a class="link" href="/signin">{p.viewer ? "switch" : "sign in"}</a></span>
              {p.factory?.version ? <span class="mono" title="Version the factory server runs">{p.factory.version.slice(0, 18)}</span> : null}
            </div>
          </aside>
          <main>
            {p.scope ?? null}
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
