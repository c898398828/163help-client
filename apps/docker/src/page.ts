/**
 * Docker 管理端 · 深色运维控制台
 * 视觉：深墨紫底 + 网易云红强调；数据用等宽字体；「心跳」为签名元素（无心跳 = 无效播放）。
 * 视图：总览（状态条 / 正在播放+心跳带 / 额度卡 / 实时日志）/ 任务 / 日志 / 设置 / 诊断
 * 日志：本地时区、级别徽章与筛选、跟随滚动（上滚自动暂停）、空态引导。
 */
export function buildPage({ authed, configured }: { authed: boolean; configured?: boolean }): string {
  const isAuthed = authed;
  const emptyHint = configured === false
    ? '尚未配置 — 打开「设置」粘贴网易云 Cookie 与密钥，保存后自动开始'
    : '暂无日志 — 配置账号后开始领单，这里会显示每个任务与错误';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>网易云音乐互助 · Docker 控制台</title>
<style>
:root{
  --bg:#131119; --glow:#241a2b; --panel:#1A1824; --panel2:#211E2E;
  --line:#2C2939; --line2:#242132;
  --t1:#EDEBF5; --t2:#9C98B3; --t3:#8A86A0;
  --red:#EC4141; --red2:#FF6B6B; --redbg:rgba(236,65,65,.13);
  --ok:#3DDC97; --warn:#F5B93F; --err:#FF6B6B;
  --mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Consolas,"Liberation Mono",monospace;
  --r:14px; --rs:9px;
}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{
  font:13px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--t1);background:var(--bg);
  background-image:radial-gradient(1200px 420px at 12% -10%,var(--glow),transparent 70%);
  min-height:100vh;padding:26px 16px;
}
.wrap{max-width:1080px;margin:0 auto}
.dock{display:flex;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;min-height:640px}
/* ---- 侧栏 ---- */
.side{width:172px;flex:0 0 172px;background:var(--panel2);border-right:1px solid var(--line2);padding:16px 10px;display:flex;flex-direction:column;gap:3px}
.logo{display:flex;align-items:center;gap:9px;padding:2px 8px 16px;font-weight:800;font-size:14px;letter-spacing:.02em;white-space:nowrap}
.logo-ic{width:24px;height:24px;border-radius:7px;background:var(--red);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 0 0 1px rgba(255,255,255,.06) inset}
.logo em{font-style:normal;font-size:10px;color:var(--t3);font-family:var(--mono);margin-left:auto}
.nav{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:var(--rs);font-size:12.5px;color:var(--t2);cursor:pointer;user-select:none;border-left:2px solid transparent}
.nav .ni{width:14px;text-align:center;font-size:11px;opacity:.75}
.nav:hover{background:#26232f;color:var(--t1)}
.nav.on{background:var(--redbg);color:#fff;border-left-color:var(--red);font-weight:600}
.side .foot{margin-top:auto;padding:10px 11px;font-size:11px;color:var(--t3);font-family:var(--mono);line-height:1.9;display:flex;flex-direction:column;gap:1px}
.side .foot b{color:var(--red2);cursor:pointer;font-weight:600;font-family:inherit}
/* ---- 主区 ---- */
.main{flex:1;min-width:0;padding:16px 18px 20px}
.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--t3);font-weight:700}
.sp{flex:1}
/* 状态条 */
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.chip{display:inline-flex;align-items:center;gap:7px;background:var(--panel2);border:1px solid var(--line2);border-radius:999px;padding:5px 12px;font-size:11.5px;color:var(--t2)}
.chip b{color:var(--t1);font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;background:var(--t3);flex:0 0 7px}
.dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(61,220,151,.13)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 3px rgba(245,185,63,.13)}
.dot.err{background:var(--err);box-shadow:0 0 0 3px rgba(255,107,107,.13)}
.dot.live{background:var(--red);animation:breath 1.8s ease-in-out infinite}
@keyframes breath{0%,100%{box-shadow:0 0 0 0 rgba(236,65,65,.5)}50%{box-shadow:0 0 0 6px rgba(236,65,65,0)}}
/* 签名区：正在播放 + 心跳 */
.now{background:linear-gradient(180deg,#1F1C2B,#1A1824);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px 12px;margin-bottom:12px}
.now-head{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.now-state{font-size:12px;color:var(--t2)}
.now-time{font-family:var(--mono);font-size:12px;color:var(--t2);font-variant-numeric:tabular-nums}
.now-name{font-family:var(--mono);font-size:26px;font-weight:600;letter-spacing:-.01em;line-height:1.25;margin-bottom:10px;word-break:break-all}
.now-name.idle{color:var(--t3);font-size:20px}
.bar{height:5px;border-radius:3px;background:#2A2737;overflow:hidden}
.bar i{display:block;height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,var(--red),var(--red2));transition:width .5s ease}
.hb{margin-top:12px;border-top:1px dashed var(--line2);padding-top:10px}
.hb-head{display:flex;align-items:baseline;gap:8px;margin-bottom:7px}
.hb-avg{font-size:11px;color:var(--t3);font-family:var(--mono)}
.hb-avg b{color:var(--t2);font-weight:600}
.hb-bars{display:flex;align-items:flex-end;gap:3px;height:34px}
.hb-bars i{flex:0 0 4px;height:100%;border-radius:2px;background:var(--ok);opacity:.5}
.hb-bars i.bad{background:var(--warn)}
.hb-bars i:last-child{opacity:1;animation:barpulse 2s ease-in-out infinite}
@keyframes barpulse{0%,100%{transform:scaleY(.86)}50%{transform:scaleY(1)}}
.hb-empty{font-size:11px;color:var(--t3);align-self:center}
/* 数据卡 */
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
.card{background:var(--panel);border:1px solid var(--line2);border-radius:12px;padding:11px 12px}
.card .lbl{font-size:10.5px;color:var(--t3);letter-spacing:.06em;margin-bottom:7px}
.card .v{font-family:var(--mono);font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.card .v .u{font-size:10.5px;color:var(--t3);font-weight:500;font-family:inherit}
.card .sub{font-size:10.5px;color:var(--t3);margin-top:6px;font-family:var(--mono)}
.card .sub a{color:var(--red2);text-decoration:none;cursor:pointer}
.card .bar{margin-top:8px;height:4px}
/* 面板与日志 */
.panel{background:var(--panel);border:1px solid var(--line2);border-radius:12px;padding:12px 13px}
.p-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.fbtn{background:transparent;border:1px solid var(--line);color:var(--t2);font:inherit;font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer}
.fbtn b{font-family:var(--mono);font-weight:600;margin-left:3px;color:var(--t3)}
.fbtn:hover{color:var(--t1);border-color:var(--t3)}
.fbtn.on{background:var(--redbg);border-color:var(--red);color:#fff}
.fbtn.on b{color:var(--red2)}
.follow{font-size:11px;color:var(--t3);cursor:pointer;font-family:var(--mono);padding:3px 9px;border:1px solid transparent;border-radius:999px}
.follow:hover{border-color:var(--line);color:var(--t2)}
.follow.paused{color:var(--warn);border-color:rgba(245,185,63,.35)}
.log{background:#0F0E15;border:1px solid var(--line2);border-radius:10px;padding:8px 4px 8px 0;max-height:216px;overflow:auto;font-family:var(--mono);font-size:11.5px;line-height:1.75}
.log.tall{max-height:460px}
.lrow{display:flex;gap:10px;padding:1px 12px;border-left:2px solid transparent}
.lrow:hover{background:#15141d}
.lv-warn{border-left-color:rgba(245,185,63,.5)}
.lv-error{border-left-color:rgba(255,107,107,.6);background:rgba(255,107,107,.045)}
.lt{color:var(--t3);flex:0 0 auto;font-variant-numeric:tabular-nums}
.lb{flex:0 0 34px;color:var(--t2);font-size:10.5px;padding-top:1px}
.lv-info .lb{color:#7fa8d8}.lv-warn .lb{color:var(--warn)}.lv-error .lb{color:var(--err)}
.lm{color:#CFCBDF;min-width:0;word-break:break-word}
.lv-error .lm{color:#FFD9D9}
.lempty{color:var(--t3);padding:14px 12px;font-family:inherit}
/* 设置/诊断 */
label{display:block;font-size:11.5px;color:var(--t2);margin:14px 0 6px}
input,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:var(--rs);font:inherit;font-size:12.5px;background:#15131d;color:var(--t1);outline:none}
input:focus,textarea:focus{border-color:var(--red);box-shadow:0 0 0 3px var(--redbg)}
textarea{min-height:104px;resize:vertical;font-family:var(--mono);font-size:11.5px}
button{font:inherit}
.btn{padding:9px 18px;border:none;border-radius:var(--rs);background:var(--red);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer}
.btn:hover{background:#f45555}
.btn.ghost{background:transparent;color:var(--red2);border:1px solid rgba(236,65,65,.5);margin-left:8px}
.tip{font-size:11px;color:var(--t3);margin-top:12px;line-height:1.9}
.kv{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px dashed var(--line2);font-size:12.5px;color:var(--t2)}
.kv:last-child{border-bottom:none}
.kv b{color:var(--t1);font-weight:600;font-family:var(--mono);font-size:12px;text-align:right}
.tool{font-size:11.5px;color:var(--t2);padding:5px 11px;border:1px solid var(--line);border-radius:999px;background:transparent;cursor:pointer}
.tool:hover{color:var(--red2);border-color:var(--red)}
.hidden{display:none!important}
.toast{position:fixed;top:20px;right:20px;background:#26232F;border:1px solid var(--line);color:var(--t1);border-radius:var(--rs);padding:10px 16px;font-size:12px;z-index:99;opacity:0;transform:translateY(-6px);transition:.22s}
.toast.show{opacity:1;transform:none}
.toast.bad{border-color:rgba(255,107,107,.5);color:#FFD9D9}
:focus-visible{outline:2px solid var(--red);outline-offset:2px;border-radius:4px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:720px){
  body{padding:12px 8px}
  .dock{flex-direction:column;min-height:auto}
  .side{width:100%;flex:none;flex-direction:row;align-items:center;gap:2px;padding:8px;overflow-x:auto;scrollbar-width:none}
  .side::-webkit-scrollbar{display:none}
  .logo{padding:0 10px 0 4px}
  .side .foot{display:none}
  .nav{border-left:none;border-bottom:2px solid transparent;white-space:nowrap}
  .nav.on{border-left:none;border-bottom-color:var(--red)}
  .cards{grid-template-columns:1fr 1fr}
  .main{padding:12px}
  .now-name{font-size:20px}
}
</style></head><body><div class="wrap">
${isAuthed ? `
<div class="dock">
  <aside class="side">
    <div class="logo"><span class="logo-ic">♪</span>互助<em id="sideState">…</em></div>
    <a class="nav on" data-v="overview"><span class="ni">◈</span>总览</a>
    <a class="nav" data-v="task"><span class="ni">▶</span>当前任务</a>
    <a class="nav" data-v="log"><span class="ni">≡</span>日志</a>
    <a class="nav" data-v="cfg"><span class="ni">⚙</span>设置</a>
    <a class="nav" data-v="diag"><span class="ni">⊞</span>诊断</a>
    <div class="foot"><span id="footver">v5.1</span><span id="footup">—</span><b onclick="doLogout()">退出</b></div>
  </aside>
  <main class="main">

    <section id="view-overview">
      <div class="chips" id="chips"></div>

      <div class="now">
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
        <div class="card"><div class="lbl">今日帮听</div><div class="v" id="help">—<span class="u"> / 9000s</span></div><div class="bar"><i id="helpBar"></i></div></div>
        <div class="card"><div class="lbl">今日被助</div><div class="v" id="recv">—<span class="u"> / 26次</span></div><div class="bar"><i id="recvBar"></i></div></div>
        <div class="card"><div class="lbl">连续运行</div><div class="v" id="up">—</div><div class="sub"><span id="jobsDone">0</span> 单已完成</div></div>
        <div class="card"><div class="lbl">账号</div><div class="v" style="font-size:14px" id="acct">—</div><div class="sub" id="acctInfo">—</div></div>
      </div>

      <div class="panel">
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

    <section id="view-task" class="hidden">
      <div class="chips"><span class="chip"><i class="dot" id="tDot"></i>本单进度</span></div>
      <div class="now">
        <div class="now-head"><span class="eyebrow">Current Job</span><span class="sp"></span><span class="now-time" id="tTime">—</span></div>
        <div class="now-name idle" id="tName">空闲中</div>
        <div class="bar"><i id="tBar"></i></div>
        <div class="hb"><div class="hb-head"><span class="eyebrow">说明</span></div>
          <div class="tip" style="margin:0">无心跳 = 无效播放：播放中每 10 秒上报一次，达到目标时长自动结算并领取下一单。</div>
        </div>
      </div>
      <div class="panel">
        <div class="p-head"><span class="eyebrow">近期日志</span></div>
        <div class="log" id="taskLog"><div class="lempty">${emptyHint}</div></div>
      </div>
    </section>

    <section id="view-log" class="hidden">
      <div class="panel">
        <div class="p-head">
          <span class="eyebrow">全部日志</span>
          <span class="sp"></span>
          <span class="follow" id="followFull" onclick="resumeFollow()">跟随中</span>
          <button class="tool" onclick="copyDiag()">复制诊断</button>
        </div>
        <div class="log tall" id="fullLog"><div class="lempty">${emptyHint}</div></div>
      </div>
    </section>

    <section id="view-cfg" class="hidden">
      <div class="panel">
        <div class="p-head"><span class="eyebrow">配置</span></div>
        <label>网易云 Cookie（完整串，含 MUSIC_U=…）</label>
        <textarea id="ncookie" placeholder="MUSIC_U=…; __csrf=…; …"></textarea>
        <label>Portal 客户端密钥（mh_ck_ 开头，个人中心获取）</label>
        <input id="nkey" placeholder="mh_ck_xxxxxxxx"/>
        <div style="margin-top:14px"><button class="btn" onclick="saveCfg()">保存并应用</button><button class="btn ghost" onclick="clearCfg()">清除配置</button></div>
        <div class="tip">保存后立即生效（Cookie 重载页面、密钥就绪即开始领单）；数据持久化于 /data，升级不丢。<br>留空的输入不会覆盖已保存值，要清空请用「清除配置」。忘记密码：./vps-setup.sh show-password</div>
      </div>
    </section>

    <section id="view-diag" class="hidden">
      <div class="panel">
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
/* 导航 */
document.querySelectorAll('.nav').forEach(function(n){n.onclick=function(){
  document.querySelectorAll('.nav').forEach(function(x){x.classList.remove('on')});n.classList.add('on');
  ['overview','task','log','cfg','diag'].forEach(function(v){$('view-'+v).classList.toggle('hidden',v!==n.dataset.v)});
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
function renderLogs(d){
  var all=(d.logs||[]), counts={info:0,warn:0,error:0};
  all.forEach(function(l){if(counts[l.level]!=null)counts[l.level]++});
  $('cAll').textContent=all.length;$('cInfo').textContent=counts.info;$('cWarn').textContent=counts.warn;$('cErr').textContent=counts.error;
  var rows=logFilter==='all'?all:all.filter(function(l){return l.level===logFilter});
  var empty=d.configured?'暂无日志 — 配置账号后开始领单，这里会显示每个任务与错误':'尚未配置 — 打开「设置」粘贴网易云 Cookie 与密钥，保存后自动开始';
  var html=rows.length?rows.map(function(l){
    return '<div class="lrow lv-'+esc(l.level)+'"><span class="lt">'+hhmmss(l.ts)+'</span><span class="lb">'+esc(LV[l.level]||l.level)+'</span><span class="lm">'+esc(l.msg)+'</span></div>';
  }).join(''):'<div class="lempty">'+empty+'</div>';
  ['log','fullLog','taskLog'].forEach(function(id){var el=$(id);if(el)el.innerHTML=html});
  ['log','fullLog','taskLog'].forEach(function(id){var el=$(id);if(el&&follow)el.scrollTop=el.scrollHeight});
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
  document.title=(j?'▶ '+j.musicName:'待命中')+' · 互助控制台';
  var name=j?(j.musicName||'—'):'—';
  ['nowName','tName'].forEach(function(id){var el=$(id);if(el){el.textContent=id==='tName'&&!j?'空闲中':name;el.classList.toggle('idle',!j)}});
  var played=j?Math.floor((j.playedMs||0)/1000):0, target=j?Math.max(1,Math.floor((j.targetMs||0)/1000)):1;
  var txt=j?(fmtClock(played)+' / '+fmtClock(target)):((d.jobsDone||0)+' 单已完成');
  $('nowTime').textContent=txt;$('tTime').textContent=txt;
  var w=j?Math.min(100,(j.playedMs/Math.max(1,j.targetMs))*100):0;
  $('nowBar').style.width=w+'%';$('tBar').style.width=w+'%';
  var td=$('tDot');if(td)td.className='dot '+(j?'live':'idle');
}
function renderHb(d){
  var xs=d.hbIntervals||[];
  $('hbAvg').textContent=xs.length?(xs.reduce(function(a,b){return a+b},0)/xs.length/1000).toFixed(1)+'s':'—';
  if(!xs.length){$('hbBars').innerHTML='<span class="hb-empty">暂无心跳 — 开始播放后每 10 秒一次</span>';return}
  var n=xs.length;
  $('hbBars').innerHTML=xs.map(function(v,i){
    var op=(0.28+0.72*((i+1)/n)).toFixed(2);
    return '<i class="'+(v>20000?'bad':'')+'" style="opacity:'+op+'" title="'+Math.round(v/1000)+'s"></i>';
  }).join('');
}
function renderStats(d){
  var hl=d.helpLimit||9000, rl=d.recvLimit||26;
  // 一次性写入整块（含限额），不要事后再取内层 id：innerHTML 替换会销毁旧节点
  $('help').innerHTML=(d.helpUsed||0)+'<span class="u"> / '+hl+'s</span>';
  $('helpBar').style.width=Math.min(100,(d.helpUsed||0)/hl*100)+'%';
  $('recv').innerHTML=(d.recv||0)+'<span class="u"> / '+rl+'次</span>';
  $('recvBar').style.width=Math.min(100,(d.recv||0)/rl*100)+'%';
  $('up').textContent=fmtUp(d.uptime||0);$('footup').textContent=fmtUp(d.uptime||0);
  $('jobsDone').textContent=d.jobsDone||0;
  if(d.configured){
    $('acct').textContent=d.acctName||'密钥模式';
    $('acctInfo').textContent=d.acctName?'已登录':'凭证已配置';
  }else{
    $('acct').textContent='未配置';
    $('acctInfo').innerHTML='<a onclick="goCfg()">去设置粘贴 Cookie 与密钥</a>';
  }
}
function goCfg(){document.querySelector('.nav[data-v=cfg]').click()}
/* 轮询 */
function poll(){
  fetch('/api/state').then(function(r){
    if(r.status===401){location.reload();return null}
    return r.json();
  }).then(function(d){
    if(!d)return;lastState=d;
    renderChips(d);renderNow(d);renderHb(d);renderStats(d);renderLogs(d);renderDiag(d);
  }).catch(function(){});
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
  $('dg4').textContent='/data 已挂载（session.json 持久化）';
}
function diag(){renderDiag(lastState);toast('诊断完成')}
poll(); setInterval(poll,2000);
</script>` : `
<div class="dock" style="max-width:400px;margin:8vh auto;min-height:auto">
  <div style="width:100%">
    <div class="side" style="width:100%;flex-direction:row;align-items:center;padding:12px 16px;border-right:none;border-bottom:1px solid var(--line2)">
      <div class="logo" style="padding:0"><span class="logo-ic">♪</span>网易云音乐互助</div>
      <span class="sp" style="flex:1"></span><span class="tip" style="margin:0">v5.1</span>
    </div>
    <div class="main" style="padding:20px">
      <div class="eyebrow" style="margin-bottom:12px">Docker 控制台登录</div>
      <input id="pw" type="password" placeholder="UI_PASSWORD" style="margin-bottom:12px" onkeydown="if(event.key==='Enter')document.getElementById('btn').click()"/>
      <button class="btn" id="btn" onclick="login()" style="width:100%">登 录</button>
      <div class="tip">忘记密码：./vps-setup.sh show-password</div>
    </div>
  </div>
</div>
<script>
function login(){
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})})
    .then(function(r){return r.json()}).then(function(d){d.ok?location.reload():alert('密码错误')})
    .catch(function(){alert('登录请求失败')});
}
</script>`}
</div></body></html>`;
}
