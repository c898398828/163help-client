/**
 * Docker 管理端 · 玻璃拟态控制台
 * 视觉：背景图（月夜）透出 + 毛玻璃面板 + 网易云红强调；无背景时深色/浅色渐变 + 极光光斑缓慢漂移。
 * 主题：html[data-theme=dark|light] 两套 token；背景：html[data-bg=image|none] + --bg-image。
 * 偏好：浏览器 localStorage（mh.theme / mh.bg），<head> 里预先应用避免刷新闪色；背景列表由服务端注入。
 * 壳层：侧栏 + 主区铺满视口，日志面板吃掉剩余高度。
 * 视图：总览（状态条 / 正在播放+心跳带 / 额度卡 / 实时日志）/ 任务 / 日志 / 设置 / 诊断
 */
const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function buildPage({ authed, configured, backgrounds = [] }: { authed: boolean; configured?: boolean; backgrounds?: string[] }): string {
  const isAuthed = authed;
  const emptyHint = configured === false
    ? '尚未配置 — 打开「设置」粘贴网易云 Cookie 与密钥，保存后自动开始'
    : '暂无日志 — 领到任务后，这里会显示每一单与错误';
  // 文件名进脚本前转义 <，防止闭合 <script>；进 option 前做 HTML 转义
  const bgJson = JSON.stringify(backgrounds).replace(/</g, '\\u003c');
  const bgOptions = '<option value="none">无</option>' + backgrounds.map((b, i) => `<option value="${escHtml(b)}">${i === 0 ? '默认 · ' : ''}${escHtml(b)}</option>`).join('');
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark" data-bg="none"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>网易云音乐互助 · Docker 控制台</title>
<script>
/* 偏好预加载：在正文渲染前应用主题与背景，刷新不闪色；localStorage 不可用时只是不持久化 */
var MH_BACKGROUNDS = ${bgJson};
var MH_THEMES = ['dark', 'light'];
function mhPref(k){ try { return localStorage.getItem(k) } catch (e) { return null } }
function mhSavePref(k, v){ try { localStorage.setItem(k, v) } catch (e) {} }
function mhNormTheme(t){ return MH_THEMES.indexOf(t) >= 0 ? t : 'dark' }
function mhNormBg(b){ if (b === 'none') return 'none'; return MH_BACKGROUNDS.indexOf(b) >= 0 ? b : (MH_BACKGROUNDS[0] || 'none') }
function mhApplyPrefs(theme, bg){
  var h = document.documentElement;
  h.dataset.theme = theme;
  h.dataset.bg = bg === 'none' ? 'none' : 'image';
  h.style.setProperty('--bg-image', bg === 'none' ? 'none' : 'url(/static/' + encodeURIComponent(bg) + ')');
}
mhApplyPrefs(mhNormTheme(mhPref('mh.theme')), mhNormBg(mhPref('mh.bg')));
</script>
<style>
:root{
  --red:#EC4141; --red2:#FF6B6B; --violet:#7C5CFF;
  --mono:"JetBrains Mono","Cascadia Code","SF Mono",ui-monospace,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  --r:16px; --rs:10px; --blur:22px;
  --ease:cubic-bezier(.2,.8,.2,1);
}
:root,[data-theme=dark]{
  color-scheme:dark;
  --bg:#0E0D14; --bg2:#171522;
  --glass:rgba(24,22,34,.68); --glass2:rgba(30,27,42,.6); --glass-top:rgba(255,255,255,.07);
  --line:rgba(255,255,255,.09); --line2:rgba(255,255,255,.05); --hover:rgba(255,255,255,.04);
  --t1:#EDEBF5; --t2:#A29EB8; --t3:#777390;
  --ok:#3DDC97; --warn:#F5B93F; --err:#FF6B6B; --info:#7FA8D8;
  --redbg:rgba(236,65,65,.14);
  --scrim:linear-gradient(180deg,rgba(10,9,16,.52),rgba(10,9,16,.74));
  --log:rgba(10,9,16,.72); --input:rgba(12,11,18,.55);
  --shadow:0 12px 34px rgba(0,0,0,.38);
  --aur1:rgba(236,65,65,.22); --aur2:rgba(124,92,255,.22); --aur3:rgba(61,220,151,.10);
}
[data-theme=light]{
  color-scheme:light;
  --bg:#EEF0F6; --bg2:#F7F8FC;
  --glass:rgba(255,255,255,.72); --glass2:rgba(255,255,255,.62); --glass-top:rgba(255,255,255,.95);
  --line:rgba(22,20,40,.10); --line2:rgba(22,20,40,.06); --hover:rgba(22,20,40,.04);
  --t1:#191726; --t2:#5B5873; --t3:#8A879E;
  --ok:#17A66A; --warn:#B8780A; --err:#D93A3A; --info:#3C6FB6;
  --redbg:rgba(236,65,65,.10);
  --scrim:linear-gradient(180deg,rgba(240,242,248,.58),rgba(240,242,248,.80));
  --log:rgba(255,255,255,.68); --input:rgba(255,255,255,.72);
  --shadow:0 12px 34px rgba(30,28,60,.10);
  --aur1:rgba(236,65,65,.16); --aur2:rgba(124,92,255,.15); --aur3:rgba(61,220,151,.10);
}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{font:13px/1.55 var(--sans);color:var(--t1);background:var(--bg);min-height:100dvh;-webkit-font-smoothing:antialiased}
/* ---- 背景层：图片 + 遮罩；无图时极光 ---- */
.bg{position:fixed;inset:0;z-index:0;background:var(--bg);overflow:hidden}
[data-bg=image] .bg{background-image:var(--bg-image);background-size:cover;background-position:center;background-repeat:no-repeat}
[data-bg=image] .bg::after{content:"";position:absolute;inset:0;background:var(--scrim)}
.aur{position:absolute;border-radius:50%;filter:blur(90px);opacity:0;pointer-events:none;transition:opacity .6s ease}
[data-bg=none] .aur{opacity:1}
.a1{width:60vw;height:60vw;left:-15vw;top:-22vw;background:var(--aur1);animation:drift1 26s ease-in-out infinite alternate}
.a2{width:52vw;height:52vw;right:-14vw;top:8vh;background:var(--aur2);animation:drift2 32s ease-in-out infinite alternate}
.a3{width:44vw;height:44vw;left:28vw;bottom:-24vw;background:var(--aur3);animation:drift3 38s ease-in-out infinite alternate}
@keyframes drift1{to{transform:translate(12vw,8vh) scale(1.12)}}
@keyframes drift2{to{transform:translate(-10vw,12vh) scale(.94)}}
@keyframes drift3{to{transform:translate(-14vw,-10vh) scale(1.16)}}
/* ---- 玻璃面板 ---- */
.glass{background:var(--glass);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--glass-top);backdrop-filter:blur(var(--blur)) saturate(1.3);-webkit-backdrop-filter:blur(var(--blur)) saturate(1.3)}
/* ---- 壳层：铺满视口 ---- */
.shell{position:relative;z-index:1;display:flex;min-height:100dvh}
.side{width:212px;flex:0 0 212px;position:sticky;top:0;height:100dvh;display:flex;flex-direction:column;gap:4px;padding:18px 12px 14px;background:var(--glass2);backdrop-filter:blur(var(--blur)) saturate(1.3);-webkit-backdrop-filter:blur(var(--blur)) saturate(1.3);border-right:1px solid var(--line)}
.logo{display:flex;align-items:center;gap:10px;padding:4px 8px 18px;font-weight:800;font-size:14px;letter-spacing:.02em;white-space:nowrap}
.logo-ic{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,var(--red),var(--red2));color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 4px 14px rgba(236,65,65,.35);transition:box-shadow .3s ease}
.logo-ic.live{animation:breath 1.8s ease-in-out infinite}
.logo em{font-style:normal;font-size:10px;color:var(--t3);font-family:var(--mono);margin-left:auto}
.nav{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--rs);font-size:12.5px;color:var(--t2);cursor:pointer;user-select:none;border:1px solid transparent;transition:background .18s ease,color .18s ease,transform .18s var(--ease)}
.nav .ni{width:14px;text-align:center;font-size:11px;opacity:.75}
.nav:hover{background:var(--hover);color:var(--t1);transform:translateX(2px)}
.nav.on{background:var(--redbg);color:var(--t1);border-color:rgba(236,65,65,.28);font-weight:600}
.side .foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding:8px 4px 0;font-size:11px;color:var(--t3);font-family:var(--mono)}
.side .foot b{color:var(--red2);cursor:pointer;font-weight:600;font-family:inherit}
.tbtn{display:inline-flex;align-items:center;gap:6px;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:var(--rs);background:var(--glass);color:var(--t2);font:inherit;font-size:12px;cursor:pointer;transition:border-color .18s ease,color .18s ease,transform .18s var(--ease)}
.tbtn:hover{color:var(--t1);border-color:var(--t3);transform:translateY(-1px)}
.main{flex:1;min-width:0;display:flex;flex-direction:column;padding:18px 22px 22px}
.view{display:flex;flex-direction:column;gap:14px;flex:1;min-height:0}
.view.rise{animation:rise .28s var(--ease) both}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--t3);font-weight:700}
.sp{flex:1}
/* ---- 状态条 ---- */
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:7px;background:var(--glass2);border:1px solid var(--line);border-radius:999px;padding:6px 13px;font-size:11.5px;color:var(--t2);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.chip b{color:var(--t1);font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;background:var(--t3);flex:0 0 7px}
.dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(61,220,151,.14)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 3px rgba(245,185,63,.14)}
.dot.err{background:var(--err);box-shadow:0 0 0 3px rgba(255,107,107,.14)}
.dot.live{background:var(--red);animation:breath 1.8s ease-in-out infinite}
@keyframes breath{0%,100%{box-shadow:0 0 0 0 rgba(236,65,65,.55)}50%{box-shadow:0 0 0 7px rgba(236,65,65,0)}}
/* ---- 签名区：正在播放 + 心跳 ---- */
.now{padding:16px 18px 14px;position:relative;overflow:hidden}
.now::before{content:"";position:absolute;right:-60px;top:-80px;width:260px;height:260px;border-radius:50%;background:radial-gradient(closest-side,var(--aur2),transparent 70%);opacity:.55;pointer-events:none}
.now-head{display:flex;align-items:center;gap:9px;margin-bottom:10px;position:relative}
.now-state{font-size:12px;color:var(--t2)}
.now-time{font-family:var(--mono);font-size:12px;color:var(--t2);font-variant-numeric:tabular-nums}
.now-name{font-family:var(--mono);font-size:30px;font-weight:600;letter-spacing:-.02em;line-height:1.2;margin-bottom:12px;word-break:break-all;position:relative}
.now-name.idle{color:var(--t3);font-size:22px}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;position:relative}
.bar i{display:block;height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,var(--red),var(--red2));transition:width .5s ease;position:relative;overflow:hidden}
.bar i.playing::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent);transform:translateX(-100%);animation:shimmer 2.2s linear infinite}
@keyframes shimmer{to{transform:translateX(100%)}}
.hb{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px;position:relative}
.hb-head{display:flex;align-items:baseline;gap:8px;margin-bottom:7px}
.hb-avg{font-size:11.5px;color:var(--t3);font-family:var(--mono)}
.hb-avg b{color:var(--t2);font-weight:600}
.hb-bars{display:flex;align-items:flex-end;gap:4px;height:44px}
.hb-bars i{flex:0 0 6px;height:100%;border-radius:3px;background:linear-gradient(180deg,var(--ok),rgba(61,220,151,.3));transform-origin:bottom;box-shadow:0 0 8px rgba(61,220,151,.22)}
.hb-bars i.bad{background:linear-gradient(180deg,var(--warn),rgba(245,185,63,.3));box-shadow:0 0 8px rgba(245,185,63,.22)}
.hb-bars i:last-child{animation:barpulse 1.6s ease-in-out infinite}
.hb-bars.stale i{animation:none;background:var(--t3);box-shadow:none}
@keyframes barpulse{0%,100%{transform:scaleY(.84)}50%{transform:scaleY(1)}}
.hb-empty{font-size:11px;color:var(--t3);align-self:center}
/* ---- 数据卡 ---- */
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.card{padding:13px 14px;transition:transform .2s var(--ease),border-color .2s ease}
.card:hover{transform:translateY(-2px);border-color:rgba(236,65,65,.35)}
.card .lbl{font-size:10.5px;color:var(--t3);letter-spacing:.06em;margin-bottom:8px}
.card .v{font-family:var(--mono);font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.1}
.card .v .u{font-size:10.5px;color:var(--t3);font-weight:500;font-family:inherit;letter-spacing:0}
.card .sub{font-size:10.5px;color:var(--t3);margin-top:7px;font-family:var(--mono)}
.card .sub a{color:var(--red2);text-decoration:none;cursor:pointer}
.card .bar{margin-top:10px;height:4px}
/* ---- 面板与日志 ---- */
.panel{padding:13px 14px}
.logpanel{flex:1;min-height:0;display:flex;flex-direction:column}
.p-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.fbtn{background:transparent;border:1px solid var(--line);color:var(--t2);font:inherit;font-size:11px;padding:4px 10px;border-radius:999px;cursor:pointer;transition:border-color .18s ease,color .18s ease}
.fbtn b{font-family:var(--mono);font-weight:600;margin-left:3px;color:var(--t3)}
.fbtn:hover{color:var(--t1);border-color:var(--t3)}
.fbtn.on{background:var(--redbg);border-color:rgba(236,65,65,.5);color:var(--t1)}
.fbtn.on b{color:var(--red2)}
.follow{font-size:11px;color:var(--t3);cursor:pointer;font-family:var(--mono);padding:4px 10px;border:1px solid transparent;border-radius:999px}
.follow:hover{border-color:var(--line);color:var(--t2)}
.follow.paused{color:var(--warn);border-color:rgba(245,185,63,.35)}
.log{background:var(--log);border:1px solid var(--line2);border-radius:12px;padding:8px 4px 8px 0;overflow:auto;font-family:var(--mono);font-size:11.5px;line-height:1.75;flex:1;min-height:160px}
.lrow{display:flex;gap:10px;padding:1px 12px;border-left:2px solid transparent}
.lrow:hover{background:var(--hover)}
.lrow.new{animation:rowin .36s var(--ease) both}
@keyframes rowin{from{opacity:0;transform:translateX(-6px);background:var(--redbg)}to{opacity:1;transform:none}}
.lv-warn{border-left-color:rgba(245,185,63,.5)}
.lv-error{border-left-color:rgba(255,107,107,.6);background:rgba(255,107,107,.05)}
.lt{color:var(--t3);flex:0 0 auto;font-variant-numeric:tabular-nums}
.lb{flex:0 0 34px;color:var(--t2);font-size:10.5px;padding-top:1px}
.lv-info .lb{color:var(--info)}.lv-warn .lb{color:var(--warn)}.lv-error .lb{color:var(--err)}
.lm{color:var(--t1);min-width:0;word-break:break-word;opacity:.9}
.lempty{color:var(--t3);padding:14px 12px;font-family:var(--sans)}
/* ---- 设置/诊断 ---- */
label{display:block;font-size:11.5px;color:var(--t2);margin:14px 0 6px}
input,textarea,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:var(--rs);font:inherit;font-size:12.5px;background:var(--input);color:var(--t1);outline:none;transition:border-color .18s ease,box-shadow .18s ease}
input:focus,textarea:focus,select:focus{border-color:var(--red);box-shadow:0 0 0 3px var(--redbg)}
textarea{min-height:104px;resize:vertical;font-family:var(--mono);font-size:11.5px}
select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--t3) 50%),linear-gradient(135deg,var(--t3) 50%,transparent 50%);background-position:calc(100% - 18px) 50%,calc(100% - 13px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:34px}
button{font:inherit}
.btn{padding:9px 18px;border:none;border-radius:var(--rs);background:linear-gradient(135deg,var(--red),#f45555);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 6px 18px rgba(236,65,65,.28);transition:transform .18s var(--ease),box-shadow .18s ease}
.btn:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(236,65,65,.34)}
.btn.ghost{background:transparent;color:var(--red2);border:1px solid rgba(236,65,65,.5);margin-left:8px;box-shadow:none}
.seg{display:inline-flex;padding:3px;border:1px solid var(--line);border-radius:999px;background:var(--input);gap:2px}
.seg button{border:none;background:transparent;color:var(--t2);padding:6px 14px;border-radius:999px;cursor:pointer;font-size:12px;transition:background .18s ease,color .18s ease}
.seg button.on{background:var(--red);color:#fff;box-shadow:0 4px 12px rgba(236,65,65,.3)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.tip{font-size:11px;color:var(--t3);margin-top:12px;line-height:1.9}
.kv{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px dashed var(--line2);font-size:12.5px;color:var(--t2)}
.kv:last-child{border-bottom:none}
.kv b{color:var(--t1);font-weight:600;font-family:var(--mono);font-size:12px;text-align:right}
.tool{font-size:11.5px;color:var(--t2);padding:5px 11px;border:1px solid var(--line);border-radius:999px;background:transparent;cursor:pointer}
.tool:hover{color:var(--red2);border-color:var(--red)}
.hidden{display:none!important}
.toast{position:fixed;top:20px;right:20px;z-index:99;background:var(--glass);border:1px solid var(--line);color:var(--t1);border-radius:var(--rs);padding:10px 16px;font-size:12px;opacity:0;transform:translateY(-6px);transition:.22s var(--ease);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.toast.show{opacity:1;transform:none}
.toast.bad{border-color:rgba(255,107,107,.5);color:var(--err)}
:focus-visible{outline:2px solid var(--red);outline-offset:2px;border-radius:4px}
/* ---- 登录 ---- */
.login{position:relative;z-index:1;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:20px}
.login-card{width:min(400px,100%);padding:22px 22px 20px;animation:rise .4s var(--ease) both}
.login-card .logo{padding:0 0 16px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:720px){
  .shell{flex-direction:column}
  .side{width:100%;flex:none;position:static;height:auto;flex-direction:row;align-items:center;gap:2px;padding:8px;overflow-x:auto;scrollbar-width:none;border-right:none;border-bottom:1px solid var(--line)}
  .side::-webkit-scrollbar{display:none}
  .logo{padding:0 10px 0 4px}
  .side .foot{display:none}
  .nav{white-space:nowrap}
  .cards{grid-template-columns:1fr 1fr}
  .row2{grid-template-columns:1fr}
  .main{padding:12px}
  .now-name{font-size:22px}
}
</style></head><body>
<div class="bg" id="bg" aria-hidden="true"><i class="aur a1"></i><i class="aur a2"></i><i class="aur a3"></i></div>
${isAuthed ? `
<div class="shell">
  <aside class="side">
    <div class="logo"><span class="logo-ic" id="logoMark">♪</span>互助<em id="sideState">…</em></div>
    <a class="nav on" data-v="overview"><span class="ni">◈</span>总览</a>
    <a class="nav" data-v="task"><span class="ni">▶</span>当前任务</a>
    <a class="nav" data-v="log"><span class="ni">≡</span>日志</a>
    <a class="nav" data-v="cfg"><span class="ni">⚙</span>设置</a>
    <a class="nav" data-v="diag"><span class="ni">⊞</span>诊断</a>
    <div class="foot">
      <button class="tbtn" id="themeToggle" type="button" onclick="toggleTheme()">☀ 切换浅色</button>
      <span><span id="footver">v5.1</span> · <span id="footup">—</span></span>
      <b onclick="doLogout()">退出登录</b>
    </div>
  </aside>
  <main class="main">

    <section id="view-overview" class="view rise">
      <div class="chips" id="chips"></div>

      <div class="now glass">
        <div class="now-head">
          <span class="eyebrow">Now Playing</span>
          <i class="dot idle" id="nowDot"></i>
          <span class="now-state" id="nowState">连接中…</span>
          <span class="sp"></span>
          <span class="now-time" id="nowTime">—</span>
        </div>
        <div class="now-name idle" id="nowName">—</div>
        <div class="bar"><i id="nowBar"></i></div>
        <div class="hb">
          <div class="hb-head"><span class="eyebrow">心跳</span><span class="hb-avg">均值 <b id="hbAvg">—</b></span></div>
          <div class="hb-bars" id="hbBars"></div>
        </div>
      </div>

      <div class="cards">
        <div class="card glass"><div class="lbl">今日帮听</div><div class="v" id="help">—<span class="u"> / 9000s</span></div><div class="bar"><i id="helpBar"></i></div></div>
        <div class="card glass"><div class="lbl">今日被助</div><div class="v" id="recv">—<span class="u"> / 26次</span></div><div class="bar"><i id="recvBar"></i></div></div>
        <div class="card glass"><div class="lbl">连续运行</div><div class="v" id="up">—</div><div class="sub"><span id="jobsDone">0</span> 单已完成</div></div>
        <div class="card glass"><div class="lbl">账号</div><div class="v" style="font-size:15px" id="acct">—</div><div class="sub" id="acctInfo">—</div></div>
      </div>

      <div class="panel glass logpanel">
        <div class="p-head">
          <span class="eyebrow">实时日志</span>
          <span class="sp"></span>
          <button class="fbtn on" data-lv="all">全部<b id="cAll">0</b></button>
          <button class="fbtn" data-lv="info">信息<b id="cInfo">0</b></button>
          <button class="fbtn" data-lv="warn">警告<b id="cWarn">0</b></button>
          <button class="fbtn" data-lv="error">错误<b id="cErr">0</b></button>
          <span class="follow" id="logFollow" onclick="resumeFollow()">跟随中</span>
        </div>
        <div class="log" id="log"><div class="lempty">${emptyHint}</div></div>
      </div>
    </section>

    <section id="view-task" class="view hidden">
      <div class="chips"><span class="chip"><i class="dot" id="tDot"></i>本单进度</span></div>
      <div class="now glass">
        <div class="now-head"><span class="eyebrow">Current Job</span><span class="sp"></span><span class="now-time" id="tTime">—</span></div>
        <div class="now-name idle" id="tName">空闲中</div>
        <div class="bar"><i id="tBar"></i></div>
        <div class="hb"><div class="hb-head"><span class="eyebrow">说明</span></div>
          <div class="tip" style="margin:0">无心跳 = 无效播放：播放中每 10 秒上报一次，达到目标时长自动结算并领取下一单。</div>
        </div>
      </div>
      <div class="panel glass logpanel">
        <div class="p-head"><span class="eyebrow">近期日志</span></div>
        <div class="log" id="taskLog"><div class="lempty">${emptyHint}</div></div>
      </div>
    </section>

    <section id="view-log" class="view hidden">
      <div class="panel glass logpanel">
        <div class="p-head">
          <span class="eyebrow">全部日志</span>
          <span class="sp"></span>
          <span class="follow" id="followFull" onclick="resumeFollow()">跟随中</span>
          <button class="tool" onclick="copyDiag()">复制诊断</button>
        </div>
        <div class="log" id="fullLog"><div class="lempty">${emptyHint}</div></div>
      </div>
    </section>

    <section id="view-cfg" class="view hidden">
      <div class="panel glass">
        <div class="p-head"><span class="eyebrow">账号配置</span></div>
        <label>网易云 Cookie（完整串，含 MUSIC_U=…）</label>
        <textarea id="ncookie" placeholder="MUSIC_U=…; __csrf=…; …"></textarea>
        <label>Portal 客户端密钥（mh_ck_ 开头，个人中心获取）</label>
        <input id="nkey" placeholder="mh_ck_xxxxxxxx"/>
        <div style="margin-top:14px"><button class="btn" onclick="saveCfg()">保存并应用</button><button class="btn ghost" onclick="clearCfg()">清除配置</button></div>
        <div class="tip">保存后立即生效（Cookie 重载页面、密钥就绪即开始领单）；数据持久化于 /data，升级不丢。<br>留空的输入不会覆盖已保存值，要清空请用「清除配置」。忘记密码：./vps-setup.sh show-password</div>
      </div>
      <div class="panel glass">
        <div class="p-head"><span class="eyebrow">外观</span><span class="sp"></span><span class="tip" style="margin:0">只保存在这台浏览器里</span></div>
        <div class="row2">
          <div>
            <label>主题</label>
            <div class="seg" id="themeSeg"></div>
          </div>
          <div>
            <label>背景</label>
            <select id="bgSelect" onchange="setBackground(this.value)">${bgOptions}</select>
          </div>
        </div>
      </div>
    </section>

    <section id="view-diag" class="view hidden">
      <div class="panel glass">
        <div class="p-head"><span class="eyebrow">诊断</span><span class="sp"></span><button class="tool" onclick="diag()">重新检测</button></div>
        <div class="kv"><span>容器运行</span><b id="dg0">…</b></div>
        <div class="kv"><span>无头浏览器</span><b id="dg1">…</b></div>
        <div class="kv"><span>服务端连通</span><b id="dg2">…</b></div>
        <div class="kv"><span>心跳上报</span><b id="dg3">…</b></div>
        <div class="kv"><span>数据卷</span><b id="dg4">…</b></div>
      </div>
    </section>

  </main>
</div>
<div class="toast" id="toast"><span id="toastM">完成</span></div>
<script>
var $=function(id){return document.getElementById(id)};
var lastState={}, logFilter='all', follow=true;
var LV={info:'信息',warn:'警告',error:'错误'};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function pad(n){return String(n).padStart(2,'0')}
function hhmmss(ts){var d=new Date(ts);return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())}
function fmtClock(s){var m=Math.floor(s/60);return m+':'+pad(s%60)}
function fmtUp(s){var d=Math.floor(s/86400),h=Math.floor(s/3600)%24,m=Math.floor(s%3600/60);return (d?d+'d ':'')+h+'h '+m+'m'}
function ago(ts){var s=Math.max(0,Math.round((Date.now()-ts)/1000));if(s<60)return s+'s 前';if(s<3600)return Math.floor(s/60)+'m 前';return Math.floor(s/3600)+'h 前'}
function toast(msg,bad){$('toastM').textContent=msg;$('toast').className='toast show'+(bad?' bad':'');setTimeout(function(){$('toast').className='toast'},2600)}
/* 外观偏好：head 里已预应用；这里负责切换、持久化与控件同步 */
var prefState={theme:mhNormTheme(mhPref('mh.theme')),bg:mhNormBg(mhPref('mh.bg'))};
function syncPrefUI(){
  var t=$('themeToggle');if(t){t.textContent=prefState.theme==='dark'?'☀ 切换浅色':'☾ 切换深色';t.title=prefState.theme==='dark'?'切换到浅色主题':'切换到深色主题'}
  var seg=$('themeSeg');if(seg)seg.innerHTML=MH_THEMES.map(function(x){return '<button type="button" data-theme="'+x+'" class="'+(x===prefState.theme?'on':'')+'" onclick="setTheme(\\''+x+'\\')">'+(x==='dark'?'深色':'浅色')+'</button>'}).join('');
  var sel=$('bgSelect');if(sel)sel.value=prefState.bg;
}
function setTheme(t){prefState.theme=mhNormTheme(t);mhSavePref('mh.theme',prefState.theme);mhApplyPrefs(prefState.theme,prefState.bg);syncPrefUI()}
function toggleTheme(){setTheme(prefState.theme==='dark'?'light':'dark')}
function setBackground(b){
  if(!(b==='none'||MH_BACKGROUNDS.indexOf(b)>=0)){syncPrefUI();return} // 未知文件名：忽略并把控件拨回
  prefState.bg=b;mhSavePref('mh.bg',b);mhApplyPrefs(prefState.theme,prefState.bg);syncPrefUI();
}
syncPrefUI();
/* 导航 */
document.querySelectorAll('.nav').forEach(function(n){n.onclick=function(){
  document.querySelectorAll('.nav').forEach(function(x){x.classList.remove('on')});n.classList.add('on');
  ['overview','task','log','cfg','diag'].forEach(function(v){var s=$('view-'+v);var show=v===n.dataset.v;s.classList.toggle('hidden',!show);if(show){s.classList.remove('rise');void s.offsetWidth;s.classList.add('rise')}});
}});
/* 日志筛选与跟随 */
document.querySelectorAll('.fbtn').forEach(function(b){b.onclick=function(){
  logFilter=b.dataset.lv;
  document.querySelectorAll('.fbtn').forEach(function(x){x.classList.toggle('on',x===b)});
  renderLogs(lastState);
}});
function setFollow(on){follow=on;['logFollow','followFull'].forEach(function(id){var el=$(id);if(el){el.textContent=on?'跟随中':'已暂停 · 点击恢复';el.classList.toggle('paused',!on)}})}
function resumeFollow(){setFollow(true);renderLogs(lastState)}
['log','fullLog','taskLog'].forEach(function(id){var el=$(id);if(!el)return;el.addEventListener('scroll',function(){
  var near=el.scrollHeight-el.scrollTop-el.clientHeight<24;if(near!==follow)setFollow(near);
})});
/* 新行判定：上次渲染的末行之后才是新行；首屏或找不到末行时不标记，避免整表闪动 */
var lastLogKey=null;
function logKey(l){return l.ts+'|'+l.level+'|'+l.msg}
function renderLogs(d){
  var all=(d.logs||[]), counts={info:0,warn:0,error:0};
  all.forEach(function(l){if(counts[l.level]!=null)counts[l.level]++});
  $('cAll').textContent=all.length;$('cInfo').textContent=counts.info;$('cWarn').textContent=counts.warn;$('cErr').textContent=counts.error;
  var newFrom=-1;
  if(lastLogKey!==null){for(var i=all.length-1;i>=0;i--){if(logKey(all[i])===lastLogKey){if(i<all.length-1)newFrom=i+1;break}}}
  var rows=logFilter==='all'?all:all.filter(function(l){return l.level===logFilter});
  var empty=d.configured?'暂无日志 — 领到任务后，这里会显示每一单与错误':'尚未配置 — 打开「设置」粘贴网易云 Cookie 与密钥，保存后自动开始';
  var html=rows.length?rows.map(function(l){
    var isNew=newFrom>=0&&all.indexOf(l)>=newFrom;
    return '<div class="lrow lv-'+esc(l.level)+(isNew?' new':'')+'"><span class="lt">'+hhmmss(l.ts)+'</span><span class="lb">'+esc(LV[l.level]||l.level)+'</span><span class="lm">'+esc(l.msg)+'</span></div>';
  }).join(''):'<div class="lempty">'+empty+'</div>';
  ['log','fullLog','taskLog'].forEach(function(id){var el=$(id);if(el)el.innerHTML=html});
  ['log','fullLog','taskLog'].forEach(function(id){var el=$(id);if(el&&follow)el.scrollTop=el.scrollHeight});
  if(all.length)lastLogKey=logKey(all[all.length-1]);
}
/* 状态条 / 正在播放 / 心跳 */
function chip(cls,label,value){return '<span class="chip"><i class="dot '+cls+'"></i>'+esc(label)+(value?'<b>'+esc(value)+'</b>':'')+'</span>'}
function renderChips(d){
  var st=!d.configured?['warn','领单','未配置']:(!d.browserReady?['warn','领单','等待浏览器']:(d.job?['live','领单','正在播放']:['ok','领单','待命中']));
  var br=d.browserReady?['ok','浏览器','就绪']:['err','浏览器','未就绪'];
  var ac=!d.configured?['warn','凭证','未配置']:(d.authStatus==='logged_out'?['err','凭证','已失效 · 请重存']:['ok','凭证',d.acctName||'密钥模式']);
  var api=d.lastApi?(d.lastApi.ok?['ok','服务端',ago(d.lastApi.at)]:['err','服务端','异常 '+(d.lastApi.status||'')+' · '+ago(d.lastApi.at)]):['idle','服务端','尚无请求'];
  var hb=(d.hbIntervals&&d.hbIntervals.length)?['ok','心跳','均值 '+(d.hbIntervals.reduce(function(a,b){return a+b},0)/d.hbIntervals.length/1000).toFixed(1)+'s']:['idle','心跳','暂无'];
  $('chips').innerHTML=chip(st[0],st[1],st[2])+chip(br[0],br[1],br[2])+chip(ac[0],ac[1],ac[2])+chip(api[0],api[1],api[2])+chip(hb[0],hb[1],hb[2]);
}
function renderNow(d){
  var j=d.job;
  $('nowDot').className='dot '+(j?'live':'idle');
  $('nowState').textContent=j?'正在播放':'待命中';
  $('sideState').textContent=j?'▶':'·';
  $('logoMark').classList.toggle('live',!!j);
  document.title=(j?'▶ '+j.musicName:'待命中')+' · 互助控制台';
  var name=j?(j.musicName||'—'):'—';
  ['nowName','tName'].forEach(function(id){var el=$(id);if(el){el.textContent=id==='tName'&&!j?'空闲中':name;el.classList.toggle('idle',!j)}});
  var played=j?Math.floor((j.playedMs||0)/1000):0, target=j?Math.max(1,Math.floor((j.targetMs||0)/1000)):1;
  var txt=j?(fmtClock(played)+' / '+fmtClock(target)):((d.jobsDone||0)+' 单已完成');
  $('nowTime').textContent=txt;$('tTime').textContent=txt;
  var w=j?Math.min(100,(j.playedMs/Math.max(1,j.targetMs))*100):0;
  $('nowBar').style.width=w+'%';$('tBar').style.width=w+'%';
  $('nowBar').classList.toggle('playing',!!j);$('tBar').classList.toggle('playing',!!j);
  var td=$('tDot');if(td)td.className='dot '+(j?'live':'idle');
}
function renderHb(d){
  $('hbBars').classList.remove('stale');
  var xs=d.hbIntervals||[];
  $('hbAvg').textContent=xs.length?(xs.reduce(function(a,b){return a+b},0)/xs.length/1000).toFixed(1)+'s':'—';
  if(!xs.length){$('hbBars').innerHTML='<span class="hb-empty">暂无心跳 — 开始播放后每 10 秒一次</span>';return}
  var n=xs.length;
  $('hbBars').innerHTML=xs.map(function(v,i){
    var op=(0.35+0.65*((i+1)/n)).toFixed(2);
    var h=Math.max(30,Math.min(100,Math.round(100*10000/Math.max(v,1)))); // 越接近 10s 越高，拖长的间隔矮下去
    return '<i class="'+(v>20000?'bad':'')+'" style="opacity:'+op+';height:'+h+'%" title="'+Math.round(v/1000)+'s"></i>';
  }).join('');
}
/* 数字滚动：首次直接显示，之后在 24 帧内缓动到新值；reduced-motion 下直接跳到终值 */
var REDUCED=(function(){try{return typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){return false}})();
var raf=typeof requestAnimationFrame==='function'?requestAnimationFrame:function(fn){return setTimeout(fn,16)};
var tweens={};
function showNumber(id,value,render){
  var v=Math.max(0,Math.round(Number(value)||0)), t=tweens[id];
  if(!t||REDUCED){tweens[id]={shown:v,target:v,token:0};render(v);return}
  if(t.shown===v){t.target=v;render(v);return}
  var from=t.shown, token=++t.token, frame=0;t.target=v;
  render(from);
  (function step(){
    if(t.token!==token)return;
    frame++;var p=Math.min(1,frame/24);p=1-Math.pow(1-p,3);
    t.shown=Math.round(from+(v-from)*p);render(t.shown);
    if(p<1)raf(step);
  })();
}
function renderStats(d){
  var hl=d.helpLimit??9000, rl=d.recvLimit??26;
  // 整块一次写入（含限额），不要事后再取内层 id：innerHTML 替换会销毁旧节点
  showNumber('help',d.helpUsed||0,function(n){$('help').innerHTML=n+'<span class="u"> / '+hl+'s</span>'});
  $('helpBar').style.width=(hl>0?Math.min(100,(d.helpUsed||0)/hl*100):0)+'%';
  showNumber('recv',d.recv||0,function(n){$('recv').innerHTML=n+'<span class="u"> / '+rl+'次</span>'});
  $('recvBar').style.width=(rl>0?Math.min(100,(d.recv||0)/rl*100):0)+'%';
  $('up').textContent=fmtUp(d.uptime||0);$('footup').textContent=fmtUp(d.uptime||0);
  showNumber('jobsDone',d.jobsDone||0,function(n){$('jobsDone').textContent=String(n)});
  if(d.configured){
    $('acct').textContent=d.acctName||'密钥模式';
    $('acctInfo').textContent=(d.acctName?'已登录':'凭证已配置')+(d.credits?' · 额度 '+d.credits:'');
  }else{
    $('acct').textContent='未配置';
    $('acctInfo').innerHTML='<a onclick="goCfg()">去设置粘贴 Cookie 与密钥</a>';
  }
}
function goCfg(){var n=document.querySelector('.nav[data-v=cfg]');if(n)n.click()}
/* 轮询：同一时间只有一个请求，超时覆盖响应体读取，失败保留最后一次数据 */
var pollInFlight=null;
function markStale(){
  $('chips').innerHTML=chip('err','状态','连接中断 · 数据已过期');
  $('nowState').textContent='连接中断 · 数据已过期';
  $('nowDot').className='dot err';$('tDot').className='dot err';
  $('sideState').textContent='!';document.title='连接中断 · 互助控制台';
  $('logoMark').classList.remove('live');
  $('hbBars').classList.add('stale');
  ['dg0','dg1','dg2','dg3'].forEach(function(id){$(id).textContent='无法获取最新状态 · 数据已过期'});
}
function poll(){
  if(pollInFlight)return pollInFlight;
  var controller=new AbortController(), timer;
  var request=(async function(){
    var r=await fetch('/api/state',{signal:controller.signal,cache:'no-store'});
    if(r.status===401){location.reload();throw new Error('登录已过期')}
    if(!r.ok)throw new Error('状态请求失败：'+r.status);
    return r.json();
  })();
  var timeout=new Promise(function(resolve,reject){timer=setTimeout(function(){
    controller.abort();reject(new Error('状态请求超时'));
  },8000)});
  pollInFlight=Promise.race([request,timeout]).then(function(d){
    if(!d||typeof d.configured!=='boolean'||typeof d.browserReady!=='boolean'||!Number.isFinite(d.uptime)||!Array.isArray(d.logs)||!Array.isArray(d.hbIntervals))throw new Error('状态响应无效');
    renderChips(d);renderNow(d);renderHb(d);renderStats(d);renderLogs(d);renderDiag(d);
    lastState=d;return true;
  }).catch(function(){markStale();return false}).finally(function(){clearTimeout(timer);pollInFlight=null});
  return pollInFlight;
}
function saveCfg(){fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:$('ncookie').value,key:$('nkey').value})}).then(function(r){return r.json().catch(function(){return {}})}).then(function(d){
  if(d.ok){toast('已保存并应用');setTimeout(function(){location.reload()},600)}else toast(d.error||'保存失败',true);
}).catch(function(){toast('保存失败：网络异常',true)})}
function clearCfg(){if(!confirm('确认清除配置？'))return;fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clear:true})}).then(function(r){return r.json().catch(function(){return {}})}).then(function(d){
  if(d.ok){toast('已清除');setTimeout(function(){location.reload()},600)}else toast(d.error||'清除失败',true)})}
function doLogout(){fetch('/api/logout',{method:'POST'}).then(function(){location.reload()})}
function copyDiag(){var el=$('fullLog');navigator.clipboard.writeText(JSON.stringify({at:new Date().toISOString(),log:el?el.innerText:''}));toast('诊断信息已复制')}
function renderDiag(d){
  $('dg0').textContent='运行 '+fmtUp(d.uptime||0);
  $('dg1').textContent=d.browserReady?'就绪':'未就绪（看日志排查）';
  $('dg2').textContent=d.lastApi?(d.lastApi.ok?'正常 · '+ago(d.lastApi.at):'异常 '+(d.lastApi.status||'')+' · '+ago(d.lastApi.at)):'尚无请求';
  $('dg3').textContent=(d.hbIntervals&&d.hbIntervals.length)?('均值 '+$('hbAvg').textContent):'暂无心跳（未开始播放）';
  $('dg4').textContent='未验证（请检查 /data 挂载与持久化配置）';
}
function diag(){return poll().then(function(ok){toast(ok?'诊断完成':'诊断失败：无法获取最新状态',!ok)})}
poll(); setInterval(poll,2000);
</script>` : `
<div class="login">
  <div class="login-card glass">
    <div class="logo"><span class="logo-ic">♪</span>网易云音乐互助<em>v5.1</em></div>
    <div class="eyebrow" style="margin-bottom:12px">Docker 控制台登录</div>
    <input id="pw" type="password" placeholder="UI_PASSWORD" style="margin-bottom:12px" onkeydown="if(event.key==='Enter')document.getElementById('btn').click()"/>
    <button class="btn" id="btn" onclick="login()" style="width:100%">登 录</button>
    <div class="tip">忘记密码：./vps-setup.sh show-password</div>
  </div>
</div>
<script>
function login(){
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})})
    .then(function(r){return r.json()}).then(function(d){d.ok?location.reload():alert('密码错误')})
    .catch(function(){alert('登录请求失败')});
}
</script>`}
</body></html>`;
}
