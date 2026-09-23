window.__ModuleLoader__.load({id:'messaging-agent-ui',factory:(require)=>{
  const React=require('react');
  const h=React.createElement;
  const {useEffect,useRef,useState,useSyncExternalStore,useCallback}=React;

  // 浏览器到宿主这一跳原来**没有任何超时**。宿主被重启、或连接被半开挂住时，fetch 既不
  // resolve 也不 reject —— 于是 busy 永远清不掉，按钮一直显示「正在整理…」「正在记…」，
  // 整页看起来卡死，只能刷新页面才能出来（实测就是这样卡住的）。
  // 给每个请求一个上限：超时就会走到 catch/finally，页面自己恢复。
  function apiTimeout(path){
    if(/organize$/.test(path))return 180000;              // 一次整理要读几个会话，服务端上限 120s
    if(/\/chat$/.test(path))return 180000;                // 一次对话要调模型，还要带上库快照
    if(/\/ask$/.test(path))return 180000;                 // 一次提问要调模型
    if(/context\/profiles\/analyze$/.test(path))return 180000; // 读取微信后还要归纳说话方式
    if(/\/read$/.test(path))return 120000;                // 读一条会话要真的打开聊天
    if(/message-center\/refresh$/.test(path))return 90000;
    return 45000;
  }
  async function request(path,method,data){
    let response;
    try{
      response=await fetch('/message-agent/api/'+path,{method,headers:{'Content-Type':'application/json'},
        body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(apiTimeout(path))});
    }catch(cause){
      // 超时和"连不上"要说清楚，别把它伪装成产品文案。
      const timeout=cause&&(cause.name==='TimeoutError'||cause.name==='AbortError');
      const error=Error(timeout?'这次等太久了，可能消息服务刚重启过；请再试一次。':'连不上消息服务，可能它刚重启；请再试一次。');
      error.code=timeout?'REQUEST_TIMEOUT':'REQUEST_UNREACHABLE';
      throw error;
    }
    const result=await response.json().catch(()=>({}));
    if(!response.ok){const error=Error(result.error||'操作没有完成，请稍后再试');error.code=result.code;error.dev=result.dev||null;throw error;}
    return result;
  }
  const api=(path,data)=>request(path,data===undefined?'GET':'POST',data);
  const mutate=(path,method,data)=>request(path,method,data||{});

  const C={bg:'var(--ma-canvas)',panel:'var(--ma-surface)',hover:'var(--ma-primary-soft)',border:'var(--ma-line)',text:'var(--ma-ink)',text2:'var(--ma-muted)',text3:'var(--ma-subtle)',brand:'var(--ma-primary)',error:'var(--ma-danger)',ok:'var(--ma-success)',warn:'var(--ma-warning)'};
  // 输入框和结果块必须有自己的底色。
  //
  // 主题里的 bg-base / layer-1 / layer-2 在浅色下是**同一个白色**，于是输入框和它所在的卡片
  // 长得一模一样 —— 用户看不出哪里能输入，也看不出哪句话是操作的结果（实测被指出来：
  // 「所有输入框要明显，背景要稍微不一样」「显示结果也要有不一样的背景色」）。改用叠一层
  // 半透明：浅色下压暗、深色下提亮，两种主题都成立。深色用宿主自己的
  // `body[data-ds-dark-theme]` 选择器，不猜主题。
  (function installSurfaceTokens(){
    try{
      if(document.getElementById('ma-surface-tokens'))return;
      const style=document.createElement('style');
      style.id='ma-surface-tokens';
      style.textContent=[
        ':root{--ma-canvas:#f1f5f2;--ma-surface:#ffffff;--ma-surface-raised:#fafcfa;--ma-ink:#16211c;--ma-muted:#5c6b63;--ma-subtle:#86948c;--ma-line:#e0e8e3;--ma-primary:#07c160;--ma-primary-strong:#06a854;--ma-primary-soft:#e6f8ee;--ma-success:#0e9f6e;--ma-success-soft:#e6f7f0;--ma-warning:#c77a16;--ma-warning-soft:#fff4df;--ma-danger:#cf4b5c;--ma-danger-soft:#fff0f2;--ma-field-bg:#f4f8f5;--ma-field-border:#d5e0d9;--ma-result-bg:#f3f7f4;--ma-result-border:#e0e8e3;--ma-shadow:0 12px 34px rgba(24,60,42,.09)}',
        'body[data-ds-dark-theme]{--ma-canvas:#0f1513;--ma-surface:#18201c;--ma-surface-raised:#1f2823;--ma-ink:#f1f6f3;--ma-muted:#a9b6ad;--ma-subtle:#7c8b82;--ma-line:#2c3630;--ma-primary:#2bd67b;--ma-primary-strong:#4ce393;--ma-primary-soft:#16321f;--ma-success:#4fd1a6;--ma-success-soft:#14332a;--ma-warning:#f0ae54;--ma-warning-soft:#3b3021;--ma-danger:#ff7e8f;--ma-danger-soft:#43242a;--ma-field-bg:#1f2823;--ma-field-border:#39453e;--ma-result-bg:#1f2823;--ma-result-border:#2c3630;--ma-shadow:0 16px 42px rgba(0,0,0,.34)}'
      ].join('\n');
      document.head.appendChild(style);
    }catch(e){/* 没有 document 时（源码级检查）就当没有这套 token，落到 var() 的兜底值 */}
  })();

  /**
   * Liquid Glass（苹果液态玻璃）材质层。
   *
   * 这个界面分三层看：**底层**是画布（环境色团 + 细颗粒），**内容层**是卡片与正文，
   * **功能层**是侧栏导航轨、页头、回执条这类一直悬在内容之上的东西。
   * 只有功能层用玻璃 —— 内容层保持纯色。**玻璃上不再叠玻璃**，否则整页糊成一片。
   *
   * 两个最容易做砸的点，先写在这：
   *   1) 玻璃要读得出来，背后必须有东西可折射。画布原来是一块纯色 #f4f7fc，
   *      在纯色上做 backdrop-filter 等于没做。所以底层换成了色团 + 颗粒
   *      —— 颗粒同时还是位移贴图能看见的前提（平滑渐变被弯折是看不出来的）。
   *   2) 玻璃的颜色来自背景，不是自己涂上去的。--lg-tint 只给一层极轻的提亮；
   *      全站染色等于全站没有重点，重颜色只留给主操作。
   *
   * 材质参数全部收敛在 --lg-* 里：模糊半径一改，边缘高光、阴影、描边都要跟着改，
   * 散落的魔法数字是改不动的。
   */
  (function installLiquidGlass(){
    try{
      if(document.getElementById('ma-liquid-glass'))return;
      const style=document.createElement('style');
      style.id='ma-liquid-glass';
      style.textContent=`
/* ===== 1. 令牌（浅色 / 深色 / 高对比三档） ===== */
:root{
  --lg-blur-sm:8px;--lg-blur-md:16px;--lg-blur-lg:32px;
  /* 玻璃的观感来自背景透出来的色，所以 tint 只给一层薄提亮。
     涂厚了玻璃就变成一块白板 —— 那是毛玻璃拟态，不是液态玻璃。 */
  --lg-tint:rgba(255,255,255,.26);
  --lg-tint-strong:rgba(255,255,255,.34);
  --lg-tint-soft:rgba(255,255,255,.16);
  /* 外圈极细的暗描边：浅色底上，纯白玻璃没有它就和背景粘在一起，看不出是一块玻璃 */
  --lg-hairline-out:0 0 0 .5px rgba(20,44,32,.08);
  --lg-edge:rgba(255,255,255,.6);
  --lg-hairline:rgba(20,44,32,.09);
  --lg-spec-top:rgba(255,255,255,.95);
  --lg-spec-side:rgba(255,255,255,.5);
  --lg-spec-bot:rgba(255,255,255,.6);
  --lg-shadow-1:0 1px 2px rgba(20,44,32,.07);
  --lg-shadow-2:0 10px 30px rgba(20,44,32,.1),0 2px 6px rgba(20,44,32,.05);
  --lg-shadow-3:0 26px 64px rgba(20,44,32,.16),0 4px 14px rgba(20,44,32,.06);
  /* 四向镜面高光。只做顶边会显得假 —— 光打在玻璃上，四条边都有反光，强度不均等 */
  --lg-specular:inset 0 1px 1px var(--lg-spec-top),inset 0 -1px 1px var(--lg-spec-bot),inset 1px 0 1px var(--lg-spec-side),inset -1px 0 1px var(--lg-spec-side);
  /* 圆角刻度只留四档；嵌套容器按「内 = 外 − padding」取下一档 */
  --lg-r-sm:10px;--lg-r-md:12px;--lg-r-lg:18px;--lg-r-xl:26px;
  --lg-dur-1:140ms;--lg-dur-2:280ms;--lg-dur-3:420ms;
  --lg-ease-smooth:cubic-bezier(.32,.72,0,1);
  --lg-ease-snappy:cubic-bezier(.22,1,.36,1);
  --lg-ease-interactive:cubic-bezier(.2,.9,.25,1);
  --lg-grain-opacity:.1;
  /* 内容层卡片：skill 给内容层的定义是「纯色 / 浅模糊」，所以允许一层**浅**模糊，
     但不上功能层那套厚玻璃。半透明面 + 顶部一道内高光，视觉上进入同一套材质语言，
     又不至于变成一堆玻璃叠玻璃。 */
  --lg-card-line:rgba(20,44,32,.08);
  --lg-card-shadow:0 2px 10px rgba(20,50,34,.07);
  --lg-card-bg:rgba(255,255,255,.66);
  --lg-card-rim:rgba(255,255,255,.85);
  --lg-card-sheen:linear-gradient(158deg,rgba(255,255,255,.55),rgba(255,255,255,.08) 46%,transparent 72%);
  /* 英雄区用的玻璃板底色：比卡片再厚一点，因为它是内容最上面的一层板 */
  --lg-hero-bg:rgba(255,255,255,.62);
  /* 玻璃上「再叠一层浅面」用的底色（统计片、状态徽章、侧栏底部块）。
     统一走令牌，不要在行内写死 rgba(255,255,255,...) —— 暗色档下白底配浅字会瞎。 */
  --lg-inset-bg:rgba(255,255,255,.55);
  --lg-inset-bg-soft:rgba(255,255,255,.34);
  --lg-grain:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23g)' opacity='.9'/%3E%3C/svg%3E");
}
@supports (transition-timing-function:linear(0,1)){
  :root{
    /* 由 scripts/spring-to-linear.py 生成：smooth 无回弹 / snappy 过冲 0.6% / interactive 跟手 */
    --lg-ease-smooth:linear(0,.1552,.4069,.6189,.7676,.8631,.9213,.9556,.9753,.9864,.9926,.996,.9978,.9988,.9994,.9997,.9998,.9999,1);
    --lg-ease-snappy:linear(0,.164,.4433,.6812,.8412,.9336,.98,.9996,1.0057,1.006,1.0045,1.0028,1.0015,1.0007,1.0003,1.0001,1,1,1);
    --lg-ease-interactive:linear(0,.1634,.4407,.6766,.8358,.9285,.9759,.9967,1.0039,1.005,1.004,1.0026,1.0014,1.0007,1.0003,1.0001,1,1,1);
  }
}
body[data-ds-dark-theme]{
  /* 暗底反光少，tint 要更低；但高光与阴影都要更强，否则玻璃浮不起来 */
  --lg-tint:rgba(255,255,255,.06);
  --lg-tint-strong:rgba(255,255,255,.09);
  --lg-tint-soft:rgba(255,255,255,.04);
  --lg-edge:rgba(255,255,255,.16);
  --lg-hairline:rgba(255,255,255,.1);
  --lg-spec-top:rgba(255,255,255,.5);
  --lg-spec-side:rgba(255,255,255,.16);
  --lg-spec-bot:rgba(255,255,255,.22);
  --lg-shadow-1:0 1px 2px rgba(0,0,0,.4);
  --lg-shadow-2:0 12px 34px rgba(0,0,0,.42),0 2px 8px rgba(0,0,0,.3);
  --lg-shadow-3:0 28px 70px rgba(0,0,0,.55),0 6px 18px rgba(0,0,0,.35);
  --lg-grain-opacity:.08;
  --lg-hairline-out:0 0 0 .5px rgba(255,255,255,.08);
  --lg-card-line:rgba(255,255,255,.09);
  --lg-card-shadow:0 2px 10px rgba(0,0,0,.3);
  --lg-card-bg:rgba(24,32,28,.66);
  --lg-card-rim:rgba(255,255,255,.07);
  --lg-card-sheen:linear-gradient(158deg,rgba(255,255,255,.1),rgba(255,255,255,.02) 46%,transparent 72%);
  --lg-hero-bg:rgba(30,40,35,.6);
  --lg-inset-bg:rgba(255,255,255,.08);
  --lg-inset-bg-soft:rgba(255,255,255,.05);
}

/* ===== 2. 底层：画布。玻璃的观感全部来自这层 ===== */
/* 多色色场，不是单色底 —— 玻璃的颜色是从这里透过来的。
   色团必须落在视口内、并且压在玻璃背后：色团全跑到视口外，玻璃背后就只剩一片白，
   材质做得再细也看不出来（这是这套改造最容易做砸的一点）。
   浓度按用户要求压到「淡淡的背景」：绿色只作为底色存在，不再抢主视觉；
   重颜色留给主操作和状态点。刻意不用紫 —— 紫在中文工具类产品里「AI 味」太重。 */
[data-ma="root"]{
  background:
    radial-gradient(680px 620px at 14% -6%,rgba(255,212,148,.26),transparent 66%),
    radial-gradient(560px 580px at 0% 46%,rgba(7,193,96,.2),transparent 64%),
    radial-gradient(660px 640px at 4% 104%,rgba(48,186,170,.2),transparent 64%),
    radial-gradient(760px 640px at 84% -8%,rgba(150,214,138,.18),transparent 64%),
    radial-gradient(700px 620px at 98% 74%,rgba(64,198,214,.16),transparent 64%),
    radial-gradient(620px 560px at 66% 108%,rgba(7,193,96,.14),transparent 64%),
    linear-gradient(150deg,#f3f7f4 0%,#eef3f0 50%,#f1f6f3 100%);
}
body[data-ds-dark-theme] [data-ma="root"]{
  background:
    radial-gradient(680px 620px at 14% -6%,rgba(150,110,40,.22),transparent 66%),
    radial-gradient(560px 580px at 0% 46%,rgba(7,150,80,.24),transparent 64%),
    radial-gradient(660px 640px at 4% 104%,rgba(24,122,112,.22),transparent 64%),
    radial-gradient(760px 640px at 84% -8%,rgba(72,142,72,.18),transparent 64%),
    radial-gradient(700px 620px at 98% 74%,rgba(30,122,142,.2),transparent 64%),
    radial-gradient(620px 560px at 66% 108%,rgba(7,150,80,.16),transparent 64%),
    linear-gradient(150deg,#0f1513 0%,#0b100e 50%,#0e1311 100%);
}
/* 细颗粒放最底下。它不参与叙事，只保证折射有高频细节可弯折。
   注意**不要**用 mix-blend-mode：全屏固定层上的混合模式会让每次滚动都多走一遍
   底色读取，实测中位帧 +4ms / p95 +8ms。普通混合 + 低不透明度是免费的。 */
[data-ma="root"]::before{
  content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:var(--lg-grain);background-size:140px 140px;
  opacity:var(--lg-grain-opacity);
}

/* 宿主的启动页（wordmark "HARNESS" + "Loading plugins…"）是**写死在宿主代码里**的，
   在我们的插件加载之前就渲染了 —— 插件无法阻止它出现。但它的根节点带一个稳定属性
   data-dsh-boot 属性，所以我们一加载就把可能残留的启动页收掉（正常情况下宿主自己会移除它）。 */
[data-dsh-boot]{display:none !important;}

/* 品牌插槽的窗口期遮罩：宿主先渲染它自己的 fallback（带构建版本号），
   我们的品牌注册是异步的 —— 不遮的话刷新时那一瞬间会闪出宿主的名字。
   我们的品牌挂载后给 <html> 打上 ma-brand-ready 即显示；3 秒兜底（见脚本）。 */
html:not(.ma-brand-ready) [data-slot="sidebar.brand.mark"],
html:not(.ma-brand-ready) [data-slot="sidebar.brand.name"],
html:not(.ma-brand-ready) [data-slot="conversation.hero.brand.mark"]{
  visibility:hidden !important;
}

/* ===== 3. 玻璃基类（Regular 变体，全站只用这一种） ===== */
[data-ma] .lg-glass{
  position:relative;isolation:isolate;border-radius:var(--lg-r-lg);
  background:var(--lg-tint);border:1px solid var(--lg-edge);
  box-shadow:var(--lg-hairline-out),var(--lg-shadow-2),var(--lg-specular);
  color:var(--ma-ink);
  -webkit-backdrop-filter:blur(var(--lg-blur-md)) saturate(180%) brightness(1.06);
  backdrop-filter:blur(var(--lg-blur-md)) saturate(180%) brightness(1.06);
  animation:ma-lg-in var(--lg-dur-2) var(--lg-ease-snappy) both;
  transition:box-shadow var(--lg-dur-2) var(--lg-ease-smooth);
}
/* 表面光泽：让材质看起来是光亮的，而不是磨砂的 */
[data-ma] .lg-glass::after{
  content:'';position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none;
  background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.05) 30%,transparent 62%);
  mix-blend-mode:screen;
}
@keyframes ma-lg-in{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}

/* ===== 4. 功能层 ===== */
/* 4.1 侧栏导航轨：大玻璃 = 更厚的材质（阴影更深、模糊更大） */
[data-ma] nav[data-ma="nav"]{
  height:calc(100% - 20px);margin:10px 0 10px 10px;
  padding:14px 10px;gap:6px;
  border:1px solid var(--lg-edge);border-radius:var(--lg-r-xl);
  background:var(--lg-tint-strong);
  box-shadow:var(--lg-hairline-out),var(--lg-shadow-3),var(--lg-specular);
  -webkit-backdrop-filter:blur(var(--lg-blur-lg)) saturate(180%) brightness(1.05);
  backdrop-filter:blur(var(--lg-blur-lg)) saturate(180%) brightness(1.05);
}
[data-ma] nav[data-ma="nav"][data-compact]{padding:14px 6px}

/* 4.2 页头：悬在内容之上的功能条 */
[data-ma] .lg-bar{
  margin:12px 14px 0;border:1px solid var(--lg-edge);border-radius:var(--lg-r-lg);
  background:var(--lg-tint-strong);
  box-shadow:var(--lg-hairline-out),var(--lg-shadow-2),var(--lg-specular);
  -webkit-backdrop-filter:blur(var(--lg-blur-md)) saturate(180%) brightness(1.05);
  backdrop-filter:blur(var(--lg-blur-md)) saturate(180%) brightness(1.05);
}
/* 4.2b 页面级操作条：sticky 在滚动区顶部。卡片会从它背后穿过去 ——
   全站最能看出「这是一块玻璃」的地方，也是唯一能看见折射在动的位置。
   top 留 12px，让内容能从条子上方的缝里滑过去，而不是被硬切一刀。 */
[data-ma] .ma-pagebar{
  position:sticky;top:12px;z-index:3;
  margin:0 0 16px;padding:12px 14px;
  display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;
}

/* 4.3 回执条 / 提示条：薄玻璃。左侧那道语义色条保留在行内样式里 */
[data-ma] .lg-toast{
  border-radius:var(--lg-r-md);
  background:var(--lg-tint-strong);
  box-shadow:var(--lg-hairline-out),var(--lg-shadow-1),var(--lg-specular);
  -webkit-backdrop-filter:blur(var(--lg-blur-sm)) saturate(160%) brightness(1.04);
  backdrop-filter:blur(var(--lg-blur-sm)) saturate(160%) brightness(1.04);
}

/* 4.4 英雄区统计片。英雄区现在是浅色玻璃板，所以这里不能再用 Clear 变体（白字）——
   换成玻璃上的一层浅面：深色字 + 白描边 + 顶部内高光。
   它坐在玻璃板上，所以自己没有 backdrop-filter（玻璃不叠玻璃）。 */
[data-ma] .lg-chip{
  border:1px solid var(--lg-edge);border-radius:var(--lg-r-md);
  background-color:var(--lg-inset-bg);color:var(--ma-ink);
  box-shadow:inset 0 1px 0 var(--lg-spec-top),0 4px 14px rgba(20,50,34,.08);
}

/* 4.4b 英雄区玻璃板。原来是整块绿色渐变，用户明确否掉：绿色只作淡淡的背景，
   这一块要「玻璃感觉」。材质和卡片同源（半透明面 + 表面光泽），但高光给足四向、
   阴影加深一档 —— 它是内容最上面的一层板。同样不加 backdrop-filter：背后是平滑色场，
   糊了看不出，只白付帧时间。 */
[data-ma] .lg-hero{
  position:relative;overflow:hidden;border-radius:var(--lg-r-xl);
  border:1px solid var(--lg-edge);
  background-color:var(--lg-hero-bg);
  background-image:var(--lg-card-sheen);
  box-shadow:var(--lg-shadow-3),var(--lg-specular);
  color:var(--ma-ink);
}

/* 4.5 导航项：它们坐在玻璃轨上，所以**不能用玻璃**（玻璃不叠玻璃），
   用一层不透明面代替 —— 层次来自明度差，不来自材质 */
[data-ma] .lg-navitem{
  border:0;border-radius:var(--lg-r-md);background:transparent;color:var(--ma-muted);
  transition:background var(--lg-dur-1) var(--lg-ease-smooth),color var(--lg-dur-1) var(--lg-ease-smooth),box-shadow var(--lg-dur-1) var(--lg-ease-smooth);
}
[data-ma] .lg-navitem:hover{background:var(--lg-tint);color:var(--ma-ink);box-shadow:var(--lg-shadow-1)}
/* 选中项：品牌色玻璃胶囊。它是**不透明白/浅绿面**而不是 backdrop-filter ——
   它坐在玻璃轨上，玻璃不叠玻璃。层次靠明度差 + 一道内高光 + 一层品牌色投影建立。 */
[data-ma] .lg-navitem[data-active]{
  background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(236,249,242,.8));
  color:var(--ma-ink);font-weight:600;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 0 0 1px rgba(20,44,32,.07),0 4px 14px rgba(20,50,34,.1);
}
body[data-ds-dark-theme] [data-ma] .lg-navitem[data-active]{
  background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.08));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 6px 18px rgba(0,0,0,.4);
}
/* 「回到对话框」这类次要出口压到第三级文字色，别和主导航抢注意力 */
[data-ma] .lg-navitem.lg-quiet{color:var(--ma-subtle)}

/* 侧栏底部单独成一块内嵌面。整条轨道如果从上到下都是同一块玻璃，中间那一大片空白
   会显得没做完；分出一个「foot」区，结构立刻读得出来（品牌 / 导航 / 底部出口三段）。 */
[data-ma] .lg-railfoot{
  display:flex;flex-direction:column;gap:2px;
  margin-top:4px;padding:6px;border-radius:var(--lg-r-md);
  background:var(--lg-inset-bg-soft);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.75),inset 0 0 0 1px rgba(255,255,255,.45);
}
body[data-ds-dark-theme] [data-ma] .lg-railfoot{
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px rgba(255,255,255,.06);
}

/* 4.6 主操作：唯一允许着色的地方。它常常坐在玻璃条上（玻璃不叠玻璃），
   所以做成一颗实色玻璃珠 —— 顶边一道内高光就够，不再叠 backdrop-filter。
   材质写在 button() 的行内样式里：React 的行内样式挂不了 class，
   所以走「行内定基线、类只负责交互态」这条路。
   （按钮的悬停 / 按下反馈统一在下面那段 [data-ma] button 规则里。） */

/* 4.7 导航项自己的一段过渡。选择器带类，权重高于全局的 [data-ma] button，
   否则「按下缩放」和「选中不变形」会互相打架。 */
[data-ma] .lg-navitem{transition:background var(--lg-dur-1) var(--lg-ease-smooth),color var(--lg-dur-1) var(--lg-ease-smooth),box-shadow var(--lg-dur-1) var(--lg-ease-smooth)}

/* 4.8 开关（Toggle）。原来是个 34×18 的自绘小轨，和按钮、下拉各写各的。
   统一成 iOS 那种「轨道 + 滑块」：滑块带弹簧曲线，按下有跟手感；
   开启态用主色渐变 + 内高光，和主按钮是同一颗玻璃珠的语言。 */
[data-ma] .lg-switch{
  display:inline-flex;align-items:center;gap:9px;
  min-height:34px;padding:3px 10px 3px 3px;border:0;border-radius:99px;
  background:transparent;color:var(--ma-muted);
  font-size:12px;font-weight:650;cursor:pointer;white-space:nowrap;
}
[data-ma] .lg-switch-track{
  position:relative;width:46px;height:28px;border-radius:99px;flex-shrink:0;
  background:var(--ma-line);
  box-shadow:inset 0 1px 3px rgba(20,44,32,.16);
  transition:background var(--lg-dur-2) var(--lg-ease-smooth),box-shadow var(--lg-dur-2) var(--lg-ease-smooth);
}
[data-ma] .lg-switch-knob{
  position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;
  background:#fff;
  box-shadow:0 2px 5px rgba(20,44,32,.3),inset 0 -1px 1px rgba(20,44,32,.06);
  transition:transform var(--lg-dur-2) var(--lg-ease-snappy);
}
[data-ma] .lg-switch.is-on .lg-switch-track{
  background:linear-gradient(180deg,var(--ma-primary),var(--ma-primary-strong));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 4px 12px rgba(7,193,96,.3);
}
[data-ma] .lg-switch.is-on .lg-switch-knob{transform:translateX(18px)}
[data-ma] .lg-switch.is-on{color:var(--ma-ink)}
[data-ma] .lg-switch:disabled{opacity:.5;cursor:not-allowed}
body[data-ds-dark-theme] [data-ma] .lg-switch-track{background:rgba(255,255,255,.15);box-shadow:none}
body[data-ds-dark-theme] [data-ma] .lg-switch-knob{background:#e9f0eb}

/* 4.9 展开式表单面板：标题在上、字段在下。
   它属于内容层，材质和卡片同一套（半透明 + 光泽 + 内高光），同样不加 backdrop-filter：
   背后是平滑的环境色场，糊了看不出，只是白烧帧时间。 */
[data-ma] .ma-form{
  margin:0 0 18px;padding:22px 22px 20px;box-sizing:border-box;
  border:1px solid var(--lg-card-line);border-radius:var(--lg-r-lg);
  background-color:var(--lg-card-bg);background-image:var(--lg-card-sheen);
  box-shadow:var(--lg-card-shadow),inset 0 1px 0 var(--lg-card-rim);
}
/* 宽屏分两栏：左边选人、右边写规则。挤成一列会在左侧留出一大片空白。 */
[data-ma] .ma-form-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:22px;align-items:start}
@media (max-width:1000px){[data-ma] .ma-form-grid{grid-template-columns:1fr;gap:16px}}
@media (prefers-contrast:more){
  [data-ma] .lg-switch-track{border:2px solid var(--ma-ink)}
}
@media (prefers-reduced-motion:reduce){
  [data-ma] .lg-switch-knob{transition-duration:.01ms!important}
}

/* ===== 5. 无障碍降级 —— 三条内建路径，Web 端必须自己实现 ===== */
/* 降低透明度：玻璃退化成实色，可读性优先。
   注意这里用的是 background 简写 —— 它会连 background-image（表面光泽）一起清掉，
   正是想要的：退了透明度就不该再有一层光泽。 */
@media (prefers-reduced-transparency:reduce){
  [data-ma] .lg-glass,[data-ma] .lg-bar,[data-ma] .lg-toast,[data-ma] .lg-hero,[data-ma] .lg-chip,[data-ma] nav[data-ma="nav"]{
    background:var(--ma-surface)!important;border:1px solid var(--ma-line)!important;
    -webkit-backdrop-filter:none!important;backdrop-filter:none!important;
    box-shadow:var(--lg-shadow-1)!important;
  }
  [data-ma] .lg-glass::after{display:none!important}
  [data-ma="root"]::before{display:none!important}
}
/* 提高对比度：加粗边框与文本对比 */
@media (prefers-contrast:more){
  [data-ma] .lg-glass,[data-ma] .lg-bar,[data-ma] .lg-toast,[data-ma] .lg-hero,[data-ma] .lg-chip,[data-ma] nav[data-ma="nav"]{
    background:var(--ma-surface)!important;border:2px solid var(--ma-ink)!important;
    -webkit-backdrop-filter:none!important;backdrop-filter:none!important;
  }
  [data-ma] .lg-navitem[data-active]{border:2px solid var(--ma-ink)!important}
  [data-ma] .lg-glass::after{display:none!important}
}
/* 减弱动态效果：去掉位移与形变，只保留淡入（它承载「出现」这件事） */
@media (prefers-reduced-motion:reduce){
  [data-ma] .lg-glass,[data-ma] .lg-navitem,[data-ma] .lg-bar,[data-ma] button{
    transition-duration:.01ms!important;
  }
  [data-ma] .lg-glass{animation:ma-lg-fade 200ms ease-out both!important}
  [data-ma] button:not(:disabled):active{transform:none!important}
  @keyframes ma-lg-fade{from{opacity:0}to{opacity:1}}
}
`;
      document.head.appendChild(style);
    }catch(e){/* 没有 document（源码级检查）就整层跳过：界面落回原来的纯色样式，仍然完全可用 */}
  })();

  /**
   * 液态玻璃折射运行时：给静态玻璃元素加上真实的边缘弯折（Chromium），
   * 其余浏览器自动降级为毛玻璃 —— **折射是享受，不是信息**，拿不到也完全可用。
   *
   * 原理：生成一张位移贴图（红通道编码 X 位移、蓝通道编码 Y 位移，中性 128 不位移），
   * 内部刷成中性灰把折射限制在边缘一条带里 —— 中间不弯折，字才不会糊。
   * 再用三次 feDisplacementMap 分别缩放并隔离单通道，feBlend screen 合成出边缘棱镜彩边。
   *
   * 与技能里原版的一处偏离（有意为之）：原版按「单边 > 800px 就不做折射」判，
   * 但真实成本是**面积**（贴图生成 O(w×h)），单边只是个粗略代理。1076×62 的页头
   * 面积只有 6.7 万像素，比 214×900 的导航轨（19 万）还小，按单边判会把页头误杀。
   * 这里改成面积上限 + 单边硬上限：既不误杀细长条，也拦住了「大块滚动区域」。
   */
  (function installRefractionRuntime(){
    const NS='http://www.w3.org/2000/svg';
    let uid=0,host=null;
    const CAN_REFRACT=typeof CSS!=='undefined'&&!!CSS.supports&&(
      CSS.supports('backdrop-filter','url(#ma-lg-probe)')||CSS.supports('-webkit-backdrop-filter','url(#ma-lg-probe)'));
    // 面积红线（CSS 像素）。超过就只做毛玻璃 —— 每帧 GPU 滤镜会拖垮低端机。
    const MAX_AREA=900000,MAX_SIDE=1600;
    const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
    const num=(v,dflt)=>{const n=parseFloat(v);return isNaN(n)?dflt:n;};

    function hostSvg(){
      if(host&&host.isConnected)return host;
      host=document.createElementNS(NS,'svg');
      host.setAttribute('aria-hidden','true');
      host.setAttribute('width','0');host.setAttribute('height','0');
      host.style.cssText='position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      (document.body||document.documentElement).appendChild(host);
      return host;
    }
    function roundRect(ctx,x,y,w,h,r){
      r=Math.min(r,w/2,h/2);
      ctx.beginPath();ctx.moveTo(x+r,y);
      ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);
      ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
    }
    function buildMap(w,h,o){
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(w));canvas.height=Math.max(1,Math.round(h));
      const ctx=canvas.getContext('2d');if(!ctx)return null;
      let g=ctx.createLinearGradient(0,0,canvas.width,0);
      g.addColorStop(0,'rgb(0,0,0)');g.addColorStop(1,'rgb(255,0,0)');
      ctx.fillStyle=g;ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.globalCompositeOperation='difference';
      g=ctx.createLinearGradient(0,0,0,canvas.height);
      g.addColorStop(0,'rgb(0,0,0)');g.addColorStop(1,'rgb(0,0,255)');
      ctx.fillStyle=g;ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.globalCompositeOperation='source-over';
      const short=Math.min(canvas.width,canvas.height);
      const inset=clamp(short*o.border,1.5,Math.max(1.5,short/2-1));
      const blur=o.mapBlur!=null?o.mapBlur:clamp(short*.06,1.5,18);
      if('filter' in ctx)ctx.filter='blur('+blur.toFixed(2)+'px)';
      ctx.fillStyle='rgb(128,128,128)';
      roundRect(ctx,inset,inset,canvas.width-inset*2,canvas.height-inset*2,Math.max(0,o.radius-inset));
      ctx.fill();
      if('filter' in ctx)ctx.filter='none';
      return canvas.toDataURL('image/png');
    }
    function buildFilter(id,href,scale,chroma){
      const svg=hostSvg();
      const old=svg.querySelector('#'+id);if(old)old.remove();
      const filter=document.createElementNS(NS,'filter');
      filter.setAttribute('id',id);
      filter.setAttribute('x','0');filter.setAttribute('y','0');
      filter.setAttribute('width','100%');filter.setAttribute('height','100%');
      // 必须写：SVG 滤镜默认 linearRGB，会把中性灰重映射，等于整块注入恒定幻影位移
      filter.setAttribute('color-interpolation-filters','sRGB');
      const image=document.createElementNS(NS,'feImage');
      image.setAttribute('href',href);
      image.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href',href);
      image.setAttribute('result','map');
      image.setAttribute('preserveAspectRatio','none');
      filter.appendChild(image);
      const channels=chroma>0?[
        {key:'r',matrix:'1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',k:1},
        {key:'g',matrix:'0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',k:1+chroma*.006},
        {key:'b',matrix:'0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',k:1-chroma*.006}]
        :[{key:'all',matrix:null,k:1}];
      // 单通道直路：只要位移，不要棱镜彩边。
      // 三通道那套是 3×feDisplacementMap + 3×feColorMatrix + 2×feBlend，
      // 在软件渲染的机器上每帧要多花几十毫秒；单通道把滤镜链砍到 1 个节点。
      if(channels.length===1){
        const disp=document.createElementNS(NS,'feDisplacementMap');
        disp.setAttribute('in','SourceGraphic');disp.setAttribute('in2','map');
        disp.setAttribute('scale',scale.toFixed(2));
        disp.setAttribute('xChannelSelector','R');disp.setAttribute('yChannelSelector','B');
        filter.appendChild(disp);
        svg.appendChild(filter);
        return filter;
      }
      let prev=null;
      channels.forEach((channel,index)=>{
        const disp=document.createElementNS(NS,'feDisplacementMap');
        disp.setAttribute('in','SourceGraphic');disp.setAttribute('in2','map');
        disp.setAttribute('scale',(scale*channel.k).toFixed(2));
        disp.setAttribute('xChannelSelector','R');disp.setAttribute('yChannelSelector','B');
        disp.setAttribute('result','ma-disp-'+channel.key);
        filter.appendChild(disp);
        const matrix=document.createElementNS(NS,'feColorMatrix');
        matrix.setAttribute('in','ma-disp-'+channel.key);
        matrix.setAttribute('type','matrix');matrix.setAttribute('values',channel.matrix);
        matrix.setAttribute('result','ma-ch-'+channel.key);
        filter.appendChild(matrix);
        if(index>0){
          const blend=document.createElementNS(NS,'feBlend');
          blend.setAttribute('in',prev);blend.setAttribute('in2','ma-ch-'+channel.key);
          blend.setAttribute('mode','screen');blend.setAttribute('result','ma-mix-'+index);
          filter.appendChild(blend);prev='ma-mix-'+index;
        }else prev='ma-ch-'+channel.key;
      });
      svg.appendChild(filter);
    }
    function create(el,o){
      const id='ma-lg-refract-'+(++uid);
      let raf=0,lastW=0,lastH=0,observer=null,destroyed=false;
      const fallback=()=>{
        el.style.backdropFilter='blur('+o.fallbackBlur+'px) saturate('+o.saturate+')';
        el.style.webkitBackdropFilter=el.style.backdropFilter;
      };
      if(!CAN_REFRACT){fallback();el.setAttribute('data-lg-mode','fallback');}
      function apply(){
        if(destroyed||!el.isConnected)return;
        const rect=el.getBoundingClientRect();
        const w=Math.round(rect.width),h=Math.round(rect.height);
        if(w<4||h<4)return;
        if(w===lastW&&h===lastH)return;
        lastW=w;lastH=h;
        if(w*h>MAX_AREA||Math.max(w,h)>MAX_SIDE){
          fallback();el.setAttribute('data-lg-mode','oversize');return;
        }
        const raw=parseFloat(getComputedStyle(el).borderTopLeftRadius)||0;
        const radius=o.radius!=null?o.radius:raw;
        const map=buildMap(w,h,{border:o.border,mapBlur:o.mapBlur,radius});
        if(!map)return;
        buildFilter(id,map,o.scale,o.chroma);
        const value='blur('+o.blur+'px) saturate('+o.saturate+') url(#'+id+')';
        el.style.backdropFilter=value;el.style.webkitBackdropFilter=value;
        el.setAttribute('data-lg-mode','refract');
        if(getComputedStyle(el).isolation!=='isolate')el.style.isolation='isolate';
      }
      function schedule(){if(raf)cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{raf=0;apply();});}
      function teardown(){
        destroyed=true;
        if(raf)cancelAnimationFrame(raf);
        if(observer)observer.disconnect();
        const filter=hostSvg().querySelector('#'+id);if(filter)filter.remove();
        el.style.backdropFilter='';el.style.webkitBackdropFilter='';
        el.style.isolation='';el.removeAttribute('data-lg-mode');
      }
      if(CAN_REFRACT){
        apply();
        if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(schedule);observer.observe(el);}
        else window.addEventListener('resize',schedule,{passive:true});
      }
      return {destroy:teardown,refresh(){lastW=lastH=0;schedule();}};
    }
    /* 默认值必须补全。data-* 上只写关心的那几个参数，其余落回这里 ——
       漏了默认值会拼出 saturate(undefined) 这种非法值，浏览器会把整条
       backdrop-filter 丢掉。表面症状是「折射没生效」，实际连毛玻璃也没了。 */
    const DEFAULTS={scale:-112,chroma:0,border:.09,mapBlur:null,blur:3,saturate:1.5,radius:null,fallbackBlur:16};
    function params(el){
      const d=el.dataset,o={};
      for(const key of Object.keys(DEFAULTS)){
        const raw=d[key];
        o[key]=raw!==undefined?num(raw,DEFAULTS[key]):DEFAULTS[key];
      }
      return o;
    }
    /**
     * 扫描并挂载。[data-liquid-glass] 的元素会拿到折射（或降级）。
     * 已经在档的跳过；已经从树上摘掉的实例顺手销毁 —— 否则换来换去会留下孤儿滤镜。
     */
    function scan(root){
      // 无障碍优先。这一步不能省：样式表虽然已经把玻璃退化成了实色，
      // 但折射实例仍然会被建出来、SVG 滤镜仍然会跑 —— 白烧 GPU，
      // 而且和「用户要求降低透明度」自相矛盾。
      if(!runtime.enabled())return 0;
      const scope=root||document;
      const alive=[];
      for(const el of scope.querySelectorAll('[data-liquid-glass]')){
        if(!el.__lgInstance)el.__lgInstance=create(el,params(el));
        alive.push(el.__lgInstance);
      }
      // 已经离开树的实例要销毁，否则换来换去会留下孤儿滤镜（每个都还在跑 GPU）
      runtime.instances.forEach(instance=>{if(!alive.includes(instance))instance.destroy();});
      runtime.instances=alive;
      return alive.length;
    }
    const runtime={
      instances:[],
      supportsRefraction:CAN_REFRACT,
      scan,
      /** 三条无障碍降级都要先认账：用户明确要求降低透明度 / 提高对比度时，不要折射。 */
      enabled(){
        try{
          if(!CAN_REFRACT)return false;
          if(matchMedia('(prefers-reduced-transparency: reduce)').matches)return false;
          if(matchMedia('(prefers-contrast: more)').matches)return false;
          return true;
        }catch(e){return false;}
      },
      destroy(){runtime.instances.forEach(i=>i.destroy());runtime.instances=[];}
    };
    if(typeof window!=='undefined')window.liquidGlass=runtime;
  })();
  const FIELD_BG='var(--ma-field-bg, rgba(20,44,32,.055))';
  const FIELD_BORDER='var(--ma-field-border, rgba(0,0,0,.16))';
  const RESULT_BG='var(--ma-result-bg, rgba(20,44,32,.045))';
  // ===== 控件基线：按钮 / 输入 / 下拉 / 标签 / 卡片 =====
  // 这一组是全站「可交互表面」的**唯一来源**。以前每个页面各写各的，于是按钮有四种高度、
  // 下拉是浏览器原生箭头、输入框是另一套圆角 —— 统一从这里取，别再就地写。
  //
  // 主操作 = 一颗实色玻璃珠：顶边一道内高光 + 一层主色投影。玻璃是功能层「面」的材质，
  // 按钮是控制件，而且经常坐在玻璃条上（玻璃不叠玻璃），所以按钮自己不透明 ——
  // 这样它在任何底上都是同一个可点目标。
  const button=(primary,danger,quiet)=>{
    if(primary)return {minHeight:38,padding:'8px 15px',border:'1px solid transparent',borderRadius:'var(--lg-r-sm)',cursor:'pointer',
      background:'linear-gradient(180deg,var(--ma-primary),var(--ma-primary-strong))',color:'#fff',
      fontSize:13,fontWeight:650,boxSizing:'border-box',
      boxShadow:'inset 0 1px 0 rgba(255,255,255,.42),0 8px 20px rgba(7,193,96,.3)'};
    if(danger)return {minHeight:38,padding:'8px 15px',border:'1px solid '+C.error,borderRadius:'var(--lg-r-sm)',cursor:'pointer',
      background:'transparent',color:C.error,fontSize:13,fontWeight:600,boxSizing:'border-box'};
    if(quiet)return {minHeight:38,padding:'8px 14px',border:'1px solid transparent',borderRadius:'var(--lg-r-sm)',cursor:'pointer',
      background:'transparent',color:C.text2,fontSize:13,fontWeight:600,boxSizing:'border-box'};
    // 次级操作：和输入框共用同一层表面 —— 「能点的」和「能填的」看起来应该是一类东西
    return {minHeight:38,padding:'8px 15px',border:'1px solid '+FIELD_BORDER,borderRadius:'var(--lg-r-sm)',cursor:'pointer',
      background:FIELD_BG,color:C.text,fontSize:13,fontWeight:600,boxSizing:'border-box'};
  };
  const small=(primary,danger,quiet)=>({...button(primary,danger,quiet),minHeight:32,padding:'6px 12px',fontSize:12,
    boxShadow:primary?'inset 0 1px 0 rgba(255,255,255,.35),0 3px 10px rgba(7,193,96,.22)':'none'});
  // 输入框 / 文本域。用 backgroundColor 而不是 background —— 下拉要在外面叠背景图（自绘箭头），
  // 而 background 简写会把背景图一起清掉。
  const field={width:'100%',boxSizing:'border-box',minHeight:42,padding:'9px 13px',border:'1px solid '+FIELD_BORDER,borderRadius:'var(--lg-r-sm)',backgroundColor:FIELD_BG,color:C.text,fontSize:14,outline:'none'};
  // 到期控件用 datetime-local：日期+几点。min-width 要留够，否则原生控件里的时间部分
  // 会被压成省略号（用户填的小时就看不见了）。
  const dateField={...field,minHeight:44,minWidth:186,fontSize:14};
  // 表单标签：统一走这里，别各写各的字号与字重
  const fieldLabel={display:'block',fontSize:13,color:C.text2,marginBottom:7,fontWeight:600};
  const pill=(color)=>({display:'inline-flex',alignItems:'center',padding:'3px 11px',borderRadius:99,border:'1px solid '+(color||C.border),color:color||C.text2,fontSize:13,whiteSpace:'nowrap',lineHeight:1.5});
  // 内容层卡片：skill 给内容层的定义是「纯色 / 浅模糊」，但这里**刻意不加 backdrop-filter** ——
  // 卡片背后是平滑的环境色场，糊它等于没糊，视觉收益接近零，代价却是实打实的：
  // 实测 6 张卡同时上 blur(9px) 会把滚动中位帧从 25.6ms 抬到 47.4ms。
  // 「玻璃感」由半透明面 + 表面光泽 + 顶部内高光 + 分层阴影建立，不靠模糊。
  const card={padding:20,border:'1px solid var(--lg-card-line)',borderRadius:'var(--lg-r-lg)',
    backgroundColor:'var(--lg-card-bg)',backgroundImage:'var(--lg-card-sheen)',marginBottom:14,
    boxShadow:'var(--lg-card-shadow),inset 0 1px 0 var(--lg-card-rim)'};
  const hint={fontSize:13,color:C.text3,lineHeight:1.7};
  const h1={margin:'0 0 6px',fontSize:28,lineHeight:1.25,letterSpacing:'-.02em',color:C.text};
  const h2={margin:'0 0 12px',fontSize:16,color:C.text};
  const h3={margin:'0 0 10px',fontSize:15,color:C.text};
  /**
   * 纯图标按钮（删除这类）。
   *
   * 图标和文字按钮不同，它没有可点的面积感，所以外面必须留一圈留白 —— 用户实测
   * 「太小了，看不清，操作不方便」。6px 内边距 + 16px 图标 ≈ 28px 的点击区域。
   *
   * 颜色不写在这里，交给 `.ma-iconbtn`：悬停时变色才需要 CSS（行内样式会把它盖掉）。
   */
  const iconButton={border:'none',background:'transparent',
    padding:6,lineHeight:0,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0};

  // Every label answers "what does this mean for me", never which subsystem produced it.
  const JOB={queued:'排队中',generating:'正在准备回复',ready:'回复已备好',sending:'正在发送',sent:'已发送',failed:'没有处理成功',cancelled:'已取消',uncertain:'发送结果待确认',not_sent:'没有发出去',done:'处理完成',skipped:'无需回复',skip:'无需回复',needs_user:'交给你处理',expired:'已过期'};

  // 同一个原因反复失败时，逐条铺开只会把真正要看的东西淹掉：把相邻的同类记录折成一条，
  // 只保留"最近一次 + 同类共几条"。不同原因（如发送结果待确认）仍各自成条，不会被合并。
  function foldJobRuns(list){
    const rows=[...(list||[])].sort((a,b)=>(b.finished_at||b.created_at||0)-(a.finished_at||a.created_at||0));
    const out=[];
    for(const job of rows){
      const key=String(job.state||'')+'|'+String(job.detail||'').trim(),last=out[out.length-1];
      if(last&&last.key===key){last.count++;continue;}
      out.push({key,count:1,job});
    }
    return out;
  }

  function readSaved(){try{return JSON.parse(sessionStorage.getItem('message-agent-workbench')||'{}');}catch{return{};}}
  function createStore(initial){let state=initial;const listeners=new Set();return{get:()=>state,set(patch){state={...state,...patch};try{sessionStorage.setItem('message-agent-workbench',JSON.stringify({open:state.open,cover:state.cover,tab:state.tab,contactKey:state.contactKey,customerKey:state.customerKey,filter:state.filter,scope:state.scope,order:state.order}));}catch{}listeners.forEach(listener=>listener());},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}};}
  // 第三个参数（getServerSnapshot）是给渲染冒烟测试用的：没有它，SSR 下这一句会抛
  // "Missing getServerSnapshot"，整页渲染不出来 —— 那个测试正是用来抓白屏的，不能先被它自己挡住。
  function useStore(store){return useSyncExternalStore(store.subscribe,store.get,store.get);}

  // ---- 开发者模式 -----------------------------------------------------------
  // 排查阶段「读不到消息」只看到一句「操作没有完成」就没法往下查：原因在 Runtime 的
  // 错误码、它自己的原文，以及调用栈里，而这三样在面向用户的文案里都被换掉了。打开这个
  // 开关，界面上会多出一块折叠的原始报错（可复制），导航底部也会多一个回到原生界面的入口。
  //
  // **默认关闭**。以前默认打开是因为产品本身还在搭、处理引擎就是原生的；现在首屏能看消息、
  // 能整理、能对话，原生界面（工作区/模型选择器/工具 JSON）只剩开发用途，不该占日常路径。
  // 真要看原始报错时到设置页打开即可，一次点击，不需要改代码。
  const DEV_KEY='ma-dev-mode';
  function readDevMode(){try{const raw=localStorage.getItem(DEV_KEY);return raw==='1';}catch{return false;}}
  let devMode=readDevMode();
  const devListeners=new Set();
  function setDevMode(on){devMode=!!on;try{localStorage.setItem(DEV_KEY,devMode?'1':'0');}catch{}devListeners.forEach(listener=>listener());}
  function useDevMode(){return useSyncExternalStore(listener=>{devListeners.add(listener);return()=>devListeners.delete(listener);},()=>devMode,()=>devMode);}

  /** 界面上的开关。做成真的能点，而不是一张写着「推荐设置」的说明卡。 */
  // 开关统一走 .lg-switch（样式表 4.8）。它坐在卡片里，所以不复用功能层玻璃。
  // 状态用三级同时表达：轨道颜色 + 滑块位置 + 文字 —— 不让颜色单独承载语义。
  function Toggle({on,onClick,busy,disabled,label}){
    return h('button',{onClick,disabled:busy||disabled,'aria-pressed':!!on,
      className:'lg-switch'+(on?' is-on':''),
      style:{cursor:busy||disabled?'default':'pointer',opacity:disabled?0.5:1}},
      h('span',{className:'lg-switch-track'},h('span',{className:'lg-switch-knob'})),
      h('span',null,busy?'正在保存…':label));
  }

  /**
   * 原始报错块：错误码 / Runtime 原文 / 调用栈 / 出处，一键复制成一段可粘贴的文本。
   * 只有打开开发者模式才渲染，用户看不到；关掉后 `api()` 也不会拿到 dev 字段。
   */
  function DevBox({dev,code,label}){
    const on=useDevMode(),[copied,setCopied]=useState(false);
    if(!on)return null;
    const payload={code:code||dev?.code||'',where:dev?.where||'',at:dev?.at||'',message:dev?.message||'',detail:dev?.detail||'',trace:dev?.trace||'',rawMessages:dev?.rawMessages,readableMessages:dev?.readableMessages};
    if(!payload.code&&!payload.message&&!payload.detail&&!payload.trace)return null;
    const text=JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([,value])=>value!==undefined&&value!=='')),null,2);
    const copy=()=>{try{navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),1600);}catch{}};
    return h('details',{style:{margin:'0 0 12px',border:'1px solid '+C.warn,borderRadius:10,background:C.panel,fontSize:13}},
      h('summary',{style:{cursor:'pointer',padding:'9px 12px',color:C.warn,userSelect:'none'}},(label||'开发者详情（排查用）')+(payload.code?(' · '+payload.code):'')),
      h('div',{style:{padding:'0 12px 12px',color:C.text3}},
        h('div',{style:{marginBottom:8}},h('button',{onClick:copy,style:small(false,false,true)},copied?'已复制':'复制原始信息')),
        [['where','出处'],['at','时间'],['message','错误'],['detail','Runtime 原文']].map(([key,title])=>
          payload[key]?h('div',{key,style:{lineHeight:1.8,wordBreak:'break-word'}},title+'：'+String(payload[key])):null),
        (payload.rawMessages!==undefined||payload.readableMessages!==undefined)&&h('div',{style:{lineHeight:1.8}},
          '读取结果：'+String(payload.rawMessages??'?')+' 条原始 → '+String(payload.readableMessages??'?')+' 条可读'),
        payload.trace&&h('pre',{style:{margin:'8px 0 0',padding:10,borderRadius:8,background:C.bg,border:'1px solid '+C.border,color:C.text2,fontSize:12,lineHeight:1.6,whiteSpace:'pre-wrap',wordBreak:'break-word'}},payload.trace)));
  }

  /** 界面上开关开发者模式的地方。只在设置页出现，消息页不重复放。 */
  function DevToggle(){
    const on=useDevMode();
    return h('button',{onClick:()=>setDevMode(!on),title:'开发者模式：显示原始错误码、Runtime 原文与调用栈，并在导航底部放出回到原生界面的入口。排查完关掉即可。',
      style:{...small(false,false,true),color:on?C.warn:C.text3}},
      '开发者模式：'+(on?'开':'关'));
  }
  function usePoller(active,load,delay){
    const [state,setState]=useState({loading:true,data:null,error:'',errorCode:'',errorDev:null}),loadRef=useRef(load),[revision,setRevision]=useState(0),waitersRef=useRef([]);loadRef.current=load;
    useEffect(()=>{if(!active)return;let stopped=false,timer,controller,wait=800;const once=delay<=0;const run=async()=>{if(stopped)return;if(document.hidden&&!once){timer=setTimeout(run,5000);return;}controller=new AbortController();try{const data=await loadRef.current(controller.signal);if(!stopped){setState({loading:false,data,error:'',errorCode:'',errorDev:null});wait=delay;}}catch(error){if(!stopped&&error.name!=='AbortError'){setState(old=>({...old,loading:false,error:error.message,errorCode:error.code||'',errorDev:error.dev||null}));wait=Math.min(wait*2,30000);}}finally{if(!stopped){const waiters=waitersRef.current;waitersRef.current=[];waiters.forEach(resolve=>resolve());}}if(!stopped&&!once)timer=setTimeout(run,wait);};run();return()=>{stopped=true;clearTimeout(timer);controller&&controller.abort();};},[active,delay,revision]);
    return {...state,refresh:()=>new Promise(resolve=>{waitersRef.current.push(resolve);setRevision(value=>value+1);})};
  }

  function relativeTime(value){if(!value)return'';const seconds=Math.max(0,Date.now()/1000-value);if(seconds<60)return'刚刚';if(seconds<3600)return Math.floor(seconds/60)+'分钟前';if(seconds<86400)return Math.floor(seconds/3600)+'小时前';const date=new Date(value*1000);if(seconds<86400*7)return Math.floor(seconds/86400)+'天前';return(date.getMonth()+1)+'月'+date.getDate()+'日';}
  /**
   * 消息时间，精确到分钟。
   *
   * 列表里用相对时间（"3小时前"）在聊天记录里不够用：同一段对话里每条都写"3小时前""2小时前"，
   * 既看不出先后也看不出具体时刻。这里按聊天软件的习惯给绝对时间 ——
   * 今天只给时分，昨天加"昨天"，更早给月日，跨年才带年份。
   */
  function messageTime(value){
    if(!value)return '';
    const date=new Date(value*1000),now=new Date();
    const clock=pad2(date.getHours())+':'+pad2(date.getMinutes());
    if(sameDay(date,now))return clock;
    if(sameDay(date,dayStart(-1)))return '昨天 '+clock;
    if(date.getFullYear()!==now.getFullYear())return date.getFullYear()+'年'+(date.getMonth()+1)+'月'+date.getDate()+'日 '+clock;
    return (date.getMonth()+1)+'月'+date.getDate()+'日 '+clock;
  }
  function pad2(value){return String(value).padStart(2,'0');}
  function toDateInput(date){return date.getFullYear()+'-'+pad2(date.getMonth()+1)+'-'+pad2(date.getDate());}
  /**
   * `datetime-local` 控件的取值格式：`YYYY-MM-DDTHH:mm`（**本地时区**，不带 Z）。
   *
   * 到期时间必须能定到几点：只给日期的话，服务端只能按"当天 9 点"兜底，而"几点提醒/几点做"
   * 正是这类任务的关键信息（用户提的）。
   */
  function toDateTimeInput(date){return toDateInput(date)+'T'+pad2(date.getHours())+':'+pad2(date.getMinutes());}
  function dayStart(offset){const date=new Date();date.setHours(9,0,0,0);date.setDate(date.getDate()+offset);return date;}
  function fromDateInput(value){return value?new Date(value+'T09:00:00'):null;}
  /**
   * 解析 `datetime-local` 的值。
   *
   * `new Date('2026-09-25T14:30')` 这种"日期+时间但无时区"的串，规范规定按**本地时间**解释
   * （只有纯日期串 `2026-09-25` 才被当成 UTC）—— 正是我们要的。所以不能自己拼 `Z`。
   */
  function fromDateTimeInput(value){return value?new Date(value):null;}
  function sameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}
  /**
   * 到期提示。**要带上几点** —— 既然到期时间能定到分钟，只显示"今天到期"等于把刚填的
   * 小时藏起来（用户提的"任务需要精确到几点"）。
   */
  function dueInfo(dueAt){
    if(!dueAt)return null;
    const due=new Date(dueAt*1000),now=Date.now()/1000,today=new Date(),tomorrow=dayStart(1);
    const clock=pad2(due.getHours())+':'+pad2(due.getMinutes());
    if(dueAt<now&&!sameDay(due,today))return{text:'已逾期 '+(due.getMonth()+1)+'月'+due.getDate()+'日 '+clock,color:C.error};
    if(sameDay(due,today))return{text:'今天 '+clock,color:C.warn};
    if(sameDay(due,tomorrow))return{text:'明天 '+clock,color:C.text2};
    return{text:(due.getMonth()+1)+'月'+due.getDate()+'日 '+clock,color:C.text3};
  }
  function firstLine(text,limit){const line=String(text||'').split('\n').map(part=>part.trim()).filter(Boolean)[0]||'';return line.length>limit?line.slice(0,limit)+'…':line;}

  // Monochrome icons: they inherit the surrounding text colour via currentColor, so the
  // same glyph reads correctly on a light or dark host theme. Colour emoji cannot do that.
  /** 发送用的向上箭头（主流 agent 的通用记号）。 */
  function SendArrow({size=18,color='currentColor'}){
    return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none','aria-hidden':'true'},
      h('path',{d:'M12 19V5M12 5l-6 6M12 5l6 6',stroke:color,strokeWidth:2,
        strokeLinecap:'round',strokeLinejoin:'round'}));
  }

  const ICONS={
    // 导航图标。消息 = 一个消息气泡；待办 = 方框里一个勾。
    messages:'M4 5.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9.6L6 17.4v-2.9H4A1.5 1.5 0 0 1 2.5 13V7A1.5 1.5 0 0 1 4 5.5Z',
    today:'M4.2 4.5h11.6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm2.5 5.7 1.5 1.5 2.9-2.9',
    // 设置：通用齿轮（外齿 + 内圆）。
    gear:'M10 3.2 12.6 5.6 15.9 6.6 15.1 10 15.9 13.4 12.6 14.4 10 16.8 7.4 14.4 4.1 13.4 4.9 10 4.1 6.6 7.4 5.6ZM12.3 10a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0Z',
    // 待办来源：一颗星 = 助手记的，一个人形 = 自己记的。只有图标、没有文字。
    spark:'M10 3.4l1.55 4.05L15.6 9l-4.05 1.55L10 14.6 8.45 10.55 4.4 9l4.05-1.55L10 3.4Z',
    person:'M10 9.3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 6.2c0-2.2 2.7-3.7 6-3.7s6 1.5 6 3.7',
    trash:'M4.6 5.8h10.8M8 5.8V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.3M6.3 5.8l.6 8.7a1 1 0 0 0 1 .95h4.2a1 1 0 0 0 1-.95l.6-8.7',
    // 「回到最新消息」的箭头，兼作下拉的展开指示（展开时翻转）。
    down:'M10 4.6v10.4M5.8 10.8 10 15l4.2-4.2',
    // 下拉里标记当前选中项。
    check:'M4.8 10.7 8.4 14.3 15.4 7.1',
    contacts:'M10 9.3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 6.2c0-2.2 2.7-3.7 6-3.7s6 1.5 6 3.7',
    automation:'M11.2 3 5.2 11h3.9l-1.1 6 6-8h-3.9l1.1-6Z',
    settings:'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0-9.2v1.9m0 9.6v1.9M17.2 10h-1.9M4.7 10H2.8M15.1 4.9l-1.3 1.3M6.2 13.8l-1.3 1.3M15.1 15.1l-1.3-1.3M6.2 6.2 4.9 4.9',
    context:'M4 3.5h5.5L11 5l1.5-1.5H16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-4.5L10 15.5 8.5 16.5H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z'
  };
  function Icon({name,size=18}){
    return h('svg',{width:size,height:size,viewBox:'0 0 20 20','aria-hidden':'true',focusable:'false',
      style:{display:'block',flexShrink:0}},
      h('path',{d:ICONS[name]||ICONS.messages,fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round'}));
  }

  /** The generated brand symbol stays legible from the compact sidebar size up to
   *  the blank-session hero while preserving its transparent background. */
  function BrandMark({size=24,className}){
    return h('img',{src:'/message-agent/assets/brand/message-agent-symbol.svg',width:size,height:size,className,alt:'','aria-hidden':'true',
      style:{display:'block',flexShrink:0,objectFit:'contain'}});
  }
  /** Product name beside the mark. The shell's own fallback is replaced here so
   *  the harness brand and its build-version badge never reach the user. */
  function BrandName(){
    useEffect(()=>{
      // 我们的品牌到了 —— 解除遮罩（见样式里那段窗口期说明）。
      document.documentElement.classList.add('ma-brand-ready');
      return ()=>document.documentElement.classList.remove('ma-brand-ready');
    },[]);
    return h('span',{style:{fontSize:17,fontWeight:600,letterSpacing:0,whiteSpace:'nowrap',color:'inherit'}},'Message Agent');
  }

  function Empty({title,text,children}){
    return h('div',{style:{margin:'auto',padding:36,textAlign:'center',maxWidth:460}},
      h('div',{style:{display:'flex',justifyContent:'center',marginBottom:14,color:C.text3}},h(Icon,{name:'messages',size:34})),
      h('h2',{style:{margin:'0 0 10px',fontSize:20,color:C.text}},title),
      h('p',{style:{margin:'0 0 20px',color:C.text2,lineHeight:1.8,fontSize:14}},text),children);
  }
  /** Long notes stay a few lines tall until the reader asks for the rest.
   *  Measured from the rendered box, not a character count — Chinese and English
   *  wrap at very different lengths. */
  function LongText({text,lines=4}){
    const [open,setOpen]=useState(false),[overflow,setOverflow]=useState(false),ref=useRef(null);
    const value=String(text||'');
    useEffect(()=>{setOpen(false);setOverflow(false);},[value]);
    useEffect(()=>{
      if(open)return;
      const node=ref.current;
      if(!node)return;
      const measure=()=>setOverflow(node.scrollHeight>node.clientHeight+2);
      measure();
      window.addEventListener('resize',measure);
      return()=>window.removeEventListener('resize',measure);
    },[value,open]);
    const body={margin:'6px 0 0',fontSize:14,lineHeight:1.75,color:C.text2,whiteSpace:'pre-wrap',wordBreak:'break-word'};
    const clamped={...body,display:'-webkit-box',WebkitLineClamp:lines,WebkitBoxOrient:'vertical',overflow:'hidden'};
    return h(React.Fragment,null,
      h('p',{ref,style:open?body:clamped},value),
      (overflow||open)&&h('button',{onClick:()=>setOpen(current=>!current),
        style:{marginTop:4,border:'none',padding:0,background:'transparent',color:C.text3,fontSize:13,cursor:'pointer'}},open?'收起':'展开全文'));
  }
  /**
   * 操作结果的回执块。
   *
   * 动作做完之后那句「已标为已看」，原来只是和正文同色的一行文字，混在页面里看不出来。
   * 统一成一块带自己底色的回执，左边一条状态色 —— 结果、说明文字、正文三者一眼能分开。
   */
  function Result({text,tone}){
    if(!text)return null;
    const color=tone==='error'?C.error:tone==='warn'?C.warn:tone==='plain'?C.text3:C.ok;
    // 功能层：回执条是一闪而过、悬在内容之上的反馈，用薄玻璃。
    // 左边那道语义色条留在行内 —— 它是信息，不能被材质吃掉。
    return h('div',{role:'status','aria-live':'polite','data-ma':'result',className:'lg-glass lg-toast',
      style:{padding:'10px 12px',borderLeft:'3px solid '+color,color:C.text,
        fontSize:14,lineHeight:1.7,marginBottom:12,wordBreak:'break-word'}},text);
  }
  function Notice({error,dev,code}){
    if(!error&&!dev&&!code)return null;
    return h('div',null,
      error&&h('div',{role:'alert',className:'lg-glass lg-toast',style:{padding:'10px 12px',borderLeft:'3px solid '+C.error,color:C.error,fontSize:14,lineHeight:1.6,marginBottom:12,wordBreak:'break-word'}},error),
      h(DevBox,{dev,code}));
  }
  function Row({title,meta,right,children,onClick,active,inboxItem}){
    return h('div',{role:onClick?'button':undefined,tabIndex:onClick?0:undefined,onClick,
      'data-inbox-item':inboxItem?'true':undefined,
      onKeyDown:onClick?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onClick();}}:undefined,
      style:{padding:'13px 15px',borderBottom:'1px solid '+C.border,borderLeft:active?'4px solid '+C.brand:'4px solid transparent',background:active?C.hover:'transparent',cursor:onClick?'pointer':'default',color:C.text}},
      // 标题加 minWidth:0 + break-word：没有它，一个超长的连续串（长英文、长链接）会把
      // 右边的文字挤出这一行。中文会自己换行，所以平时看不出来。
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline'}},h('strong',{style:{fontSize:15,fontWeight:600,minWidth:0,wordBreak:'break-word'}},title),right&&h('span',{style:{fontSize:13,color:C.text3,flexShrink:0}},right)),
      meta&&h('div',{style:{margin:'5px 0 0',fontSize:13,color:C.text3,lineHeight:1.6}},meta),
      children);
  }

  /**
   * 自绘下拉。
   *
   * 原生 `<select>` 展开的那一层是**操作系统画的**，CSS 一点也碰不到：面板是系统灰、行高
   * 与字号都是默认值，放进这套玻璃界面里像另一个程序（用户实测："看起来很原始，和现有
   * 项目风格不符"）。所以自己画 —— 触发器沿用输入框外观，面板套同一套卡片玻璃。
   *
   * 三个不能省的细节，否则只是"好看一点的坏控件"：
   *  1. 键盘：↑↓ 移动、Enter 选中、Esc 关闭（且**拦住冒泡**，否则会把整个面板收起来）；
   *  2. 点空白处、窗口尺寸变化都要收起来；
   *  3. 面板用 `position:fixed` + 触发器坐标 —— 卡片里有 `overflow:hidden`，absolute 面板
   *     会被裁掉；空间不够时向上翻。
   */
  function Select({value,groups=[],onChange,disabled,placeholder,ariaLabel,minWidth=200,maxHeight=300}){
    const [open,setOpen]=useState(false),[active,setActive]=useState(-1),[box,setBox]=useState(null),ref=useRef(null);
    const items=groups.reduce((all,group)=>all.concat(group.items||[]),[]);
    const current=items.find(item=>item.value===value);
    useEffect(()=>{
      if(!open)return;
      const onDoc=event=>{if(ref.current&&!ref.current.contains(event.target))setOpen(false);};
      const onResize=()=>setOpen(false);
      document.addEventListener('mousedown',onDoc);
      // 列表自己滚动**不该**收起面板：捕获阶段会把列表内部的 scroll 也报上来，
      // 用户一滚轮面板就关了、根本看不全选项（用户实测报的就是这个）。
      // 只有"面板外面"的滚动才意味着触发器位置变了，那时才关。
      const onScroll=event=>{if(ref.current&&!ref.current.contains(event.target))setOpen(false);};
      window.addEventListener('resize',onResize);
      window.addEventListener('scroll',onScroll,true);
      return()=>{document.removeEventListener('mousedown',onDoc);window.removeEventListener('resize',onResize);window.removeEventListener('scroll',onScroll,true);};
    },[open]);
    function openPanel(){
      if(disabled||!items.length)return;
      const rect=ref.current.getBoundingClientRect();
      const height=Math.min(maxHeight,items.length*38+groups.length*24+14);
      const below=window.innerHeight-rect.bottom;
      const up=below<height+12&&rect.top>below;
      setBox({left:rect.left,width:Math.max(rect.width,minWidth),height,
        ...(up?{bottom:window.innerHeight-rect.top+6}:{top:rect.bottom+6})});
      setActive(items.findIndex(item=>item.value===value));
      setOpen(true);
    }
    function pick(item){
      setOpen(false);
      if(item&&item.value!==value)onChange(item.value);
    }
    function onKeyDown(event){
      if(event.key==='Escape'){if(open){event.stopPropagation();setOpen(false);}return;}
      if(!open){
        if(event.key==='Enter'||event.key===' '||event.key==='ArrowDown'){event.preventDefault();openPanel();}
        return;
      }
      if(event.key==='ArrowDown'){event.preventDefault();setActive(index=>Math.min(index+1,items.length-1));}
      else if(event.key==='ArrowUp'){event.preventDefault();setActive(index=>Math.max(index-1,0));}
      else if(event.key==='Enter'){event.preventDefault();pick(items[active]);}
      else if(event.key==='Tab')setOpen(false);
    }
    return h('div',{ref,style:{position:'relative',minWidth:0,flex:'1 1 auto'}},
      h('button',{type:'button',onClick:()=>open?setOpen(false):openPanel(),onKeyDown,disabled:disabled||!items.length,
        'aria-haspopup':'listbox','aria-expanded':open,'aria-label':ariaLabel,
        style:{...field,display:'flex',alignItems:'center',gap:10,cursor:disabled||!items.length?'default':'pointer',textAlign:'left',minHeight:44}},
        h('span',{style:{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
          color:current?C.text:C.text3}},current?current.label:(placeholder||'请选择')),
        h('span',{style:{flexShrink:0,color:C.text3,lineHeight:0,transition:'transform var(--lg-dur-1) var(--lg-ease-smooth)',
          transform:open?'rotate(180deg)':'none'}},h(Icon,{name:'down',size:16}))),
      open&&box&&h('div',{role:'listbox','aria-label':ariaLabel,
        style:{position:'fixed',left:box.left,width:box.width,...(box.top!==undefined?{top:box.top}:{bottom:box.bottom}),
          maxHeight:box.height,overflowY:'auto',zIndex:80,padding:6,borderRadius:'var(--lg-r-lg)',
          border:'1px solid var(--lg-card-line)',backgroundColor:'var(--ma-surface)',boxShadow:'var(--ma-shadow)'}},
        groups.map((group,groupIndex)=>h('div',{key:group.label||groupIndex},
          group.label&&h('div',{style:{fontSize:11,color:C.text3,fontWeight:650,letterSpacing:'.04em',padding:'8px 10px 4px'}},group.label),
          (group.items||[]).map(item=>{
            const index=items.indexOf(item),selected=item.value===value;
            return h('button',{key:item.value,type:'button',role:'option','aria-selected':selected,
              onClick:()=>pick(item),onMouseEnter:()=>setActive(index),
              style:{display:'flex',alignItems:'center',gap:10,width:'100%',minHeight:38,padding:'8px 10px',
                borderRadius:'var(--lg-r-sm)',border:'none',cursor:'pointer',textAlign:'left',fontSize:14,
                background:index===active?'var(--lg-tint)':'transparent',
                color:selected?C.brand:C.text,fontWeight:selected?650:400}},
              h('span',{style:{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},item.label),
              selected&&h(Icon,{name:'check',size:16}));
          })))));
  }

  /**
   * 选一个微信联系人 / 群聊。
   *
   * 「添加自动回复」和「回复配置 → 从聊天分析说话方式」用的是**同一个组件** —— 两处需求
   * 完全一样（在本地联系人里找到那个人），各写一套只会慢慢长歪：之前「添加自动回复」
   * 还在提示"正在读取微信"、而且连搜索都没有，其实数据早就是本地明文副本了。
   *
   * 留空 = 最近联系的会话；输入关键词 = 本地检索（备注 / 昵称 / 微信号，含群聊）。
   */
  function ContactPicker({value,onChange,onLoaded,disabled}){
    const [choices,setChoices]=useState([]),[query,setQuery]=useState('');
    const [busy,setBusy]=useState(false),[error,setError]=useState('');
    async function load(keyword){
      setBusy(true);setError('');
      try{
        const result=keyword?await api('search_contacts',{keyword}):await api('conversations');
        const list=result.conversations||[];
        setChoices(list);
        if(onLoaded)onLoaded(list);
        // 没选过、或原来选的那个人已经不在结果里：替用户选第一个，少一次点击。
        if(list.length&&!list.some(item=>item.id===value))onChange(list[0].id);
      }catch(e){setError(e.message);}
      finally{setBusy(false);}
    }
    useEffect(()=>{load('');},[]);
    return h('div',null,
      h('div',{style:{display:'flex',gap:10,marginBottom:10,flexWrap:'wrap'}},
        h('input',{value:query,onInput:event=>setQuery(event.target.value),
          onKeyDown:event=>{if(event.key==='Enter'){event.stopPropagation();load(query.trim());}},
          'aria-label':'搜索联系人',placeholder:'搜备注 / 昵称 / 微信号；留空显示最近联系',
          style:{...field,flex:'1 1 220px'}}),
        h('button',{onClick:()=>load(query.trim()),disabled:disabled||busy,style:button(false)},busy?'读取中…':'搜索')),
      h(Select,{value,onChange,disabled:disabled||busy,ariaLabel:'选择联系人或群聊',
        placeholder:busy?'正在读取本地联系人…':(choices.length?'请选择':'没找到，换个关键词试试'),
        groups:[{items:choices.map(item=>({value:item.id,
          label:item.kind==='group'?item.title+'（群聊）':item.title}))}]}),
      error&&h('p',{style:{...hint,margin:'8px 0 0',color:C.error}},error));
  }

  // ---- shared composer: 记跟进 or 加待办 --------------------------------------
  function Composer({mode,setMode,busy,onSubmit,idleHint,fixedMode,onCancel}){
    const [text,setText]=useState(''),[due,setDue]=useState(''),[error,setError]=useState('');
    async function submit(){
      if(!text.trim()){setError('先写点内容再保存');return;}
      setError('');
      try{await onSubmit(mode,text.trim(),due?fromDateTimeInput(due).toISOString():null);setText('');setDue('');}catch(e){setError(e.message);}
    }
    const isTodo=mode==='todo';
    return h('div',{style:{border:'1px solid '+C.border,borderRadius:12,padding:14,background:C.panel}},
      !fixedMode&&h('div',{style:{display:'flex',gap:8,marginBottom:10}},
        h('button',{onClick:()=>setMode('followup'),'aria-pressed':!isTodo,style:{...small(!isTodo),borderRadius:99}},'记一条跟进'),
        h('button',{onClick:()=>setMode('todo'),'aria-pressed':isTodo,style:{...small(isTodo),borderRadius:99}},'加一条待办')),
      h('textarea',{value:text,onChange:event=>setText(event.target.value),rows:isTodo?2:3,placeholder:isTodo?'要做什么？例如：周五前回张伟的报价':'这次沟通说了什么？例如：电话确认了报价，等他周五回复','aria-label':isTodo?'待办内容':'跟进内容',style:{...field,resize:'vertical',lineHeight:1.7}}),
      isTodo&&h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:10,flexWrap:'wrap'}},
        h('span',{style:{fontSize:13,color:C.text2}},'什么时候做'),
        h('button',{onClick:()=>setDue(toDateTimeInput(dayStart(0))),style:{...small(false),borderRadius:99}},'今天'),
        h('button',{onClick:()=>setDue(toDateTimeInput(dayStart(1))),style:{...small(false),borderRadius:99}},'明天'),
        h(DateTimeField,{value:due,onChange:setDue,placeholder:'选择时间'}),
        due&&h('button',{onClick:()=>setDue(''),style:{...small(false,false,true),borderRadius:99}},'清除时间')),
      h(Notice,{error}),
      h('div',{style:{display:'flex',gap:10,alignItems:'center',marginTop:12,flexWrap:'wrap'}},
        h('button',{onClick:submit,disabled:busy,style:button(true)},busy?'正在保存…':(isTodo?'添加':'保存这条跟进')),
        h('button',{onClick:onCancel,disabled:busy,style:button(false,false,true)},'取消'),
        idleHint&&h('span',{style:hint},idleHint)));
  }

  // ---- contact workspace: 待办 / 跟进 / 问助手 / 资料 -----------------------
  // The detail column used to stack six full-width blocks with a paragraph of
  // explanation each. Everything that is not a decision or an action now folds
  // away or hides until it has content, so the first screen is: what needs me,
  // what I promised, and one box to ask about.
  function Section({title,meta,action,children}){
    return h('section',{style:{marginBottom:24}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:10}},
        h('div',{style:{display:'flex',alignItems:'baseline',gap:8,minWidth:0,flexWrap:'wrap'}},
          h('h3',{style:{...h3,margin:0}},title),
          meta&&h('span',{style:{fontSize:13,color:C.text3}} ,meta)),
        action||null),
      children);
  }
  function Fold({title,meta,children}){
    return h('details',{style:{borderTop:'1px solid '+C.border,paddingTop:14,marginBottom:20}},
      h('summary',{style:{fontSize:15,color:C.text}},
        title,meta?h('span',{style:{fontSize:13,color:C.text3,fontWeight:400}} ,' · '+meta):null),
      h('div',{style:{marginTop:12}},children));
  }
  const TOOL_LABELS={list_conversations:'读取微信会话列表',get_messages:'读取聊天记录',read_messages:'读取聊天记录',search_messages:'搜索聊天记录',sync_conversation:'同步聊天记录',observe_latest:'读取最新消息',get_unread_conversations:'读取未读会话',search_contacts:'查找联系人',get_send_status:'查询发送结果',send_message:'发送消息',reply_message:'回复消息',list_providers:'检查微信连接',diagnose_provider:'检查微信连接',get_capabilities:'读取能力列表'};
  function toolText(names){
    const labels=[...new Set((names||[]).map(name=>TOOL_LABELS[String(name).split('__').pop()]||'读取微信'))];
    return labels.join('、');
  }

  // 问助手：详情页底部的常驻入口。它背后是一个完整 agent（能读微信、查记录、动 CRM），
  // 所以这里不暴露中间步骤，只报「在处理」；结果必须能直接变成可执行的东西（待办/跟进）。
  // 只认「- [ ] 」任务语法：普通「- 」列表常用来陈述事实，误当待办会把
  // "微信窗口尺寸偏离标定"这种诊断结论也记成一条待办。
  // 客户端只认「- [ ]」这一种写法为待办（后端提示词负责标成这个格式）。
  const LIST_ITEM_LINE=/^\s*(?:[-*+]\s*)?(?:\[[ xX]?\]|[☐□])\s*(.{2,80}?)\s*$/;
  function listItemText(line){
    const match=String(line||'').match(LIST_ITEM_LINE);
    return match?match[1].replace(/[*`]/g,'').replace(/[。；;,，]+$/,'').trim():null;
  }
  function answerListItems(text){
    return String(text||'').split('\n').map(listItemText).filter(Boolean).slice(0,8);
  }

  /**
   * 答案正文，去掉已经单独呈现的那些条目。
   *
   * 「- [ ] 确认消杀安排」这类行既是答案的一部分，也是下面那份勾选清单的来源。两处都渲染
   * 同一句话，用户看到的就是同一件事写了两遍（实测被指出来过）。所以正文里把这些行摘掉，
   * 只留下真正是结论的文字；待办统一由清单那一处呈现，勾选即可。
   */
  /**
   * 助手答案的轻量 Markdown 渲染。
   *
   * 为什么自己做：助手（尤其是走 agent 的那条链路）经常回 `**结论：…**`、`1. …`、`- …`
   * 这种标记，直接当纯文本显示就会把 `**` 原样摆给用户看（用户实测提出来过）。
   * 又不能用现成的 markdown 库：这是插件页面，**不联网、没有构建步骤**，
   * 引 CDN 或打包器都不合适。支持常用的一小撮就够，代码不到百行、可控。
   *
   * 安全：全程生成 React 元素，**不用 innerHTML**，所以模型在回答里写 `<script>` 也没关系。
   */
  // 规则统一成 (captures, key) => element：捕获组一律传数组，谁要几个自己取。
  const INLINE_RULES=[
    [/\*\*([^*]+)\*\*/g,(g,key)=>h('strong',{key,style:{fontWeight:600}},g[0])],
    [/(?<!\*)\*([^*\n]+)\*(?!\*)/g,(g,key)=>h('em',{key},g[0])],
    [/`([^`\n]+)`/g,(g,key)=>h('code',{key,style:{padding:'1px 5px',borderRadius:4,
      background:'var(--lg-inset-bg)',fontFamily:'var(--font-mono)',fontSize:13}},g[0])],
    [/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,(g,key)=>h('a',{key,href:g[1],target:'_blank',
      rel:'noreferrer',style:{color:C.brand}},g[0])]
  ];
  /** 把一行里的行内标记切成 React 节点；没有标记时返回纯字符串。 */
  function inlineNodes(line,keyPrefix){
    let parts=[String(line??'')];
    for(const [pattern,build] of INLINE_RULES){
      const next=[];
      for(const part of parts){
        if(typeof part!=='string'){next.push(part);continue;}
        let last=0,match;
        pattern.lastIndex=0;
        while((match=pattern.exec(part))!==null){
          if(match.index>last)next.push(part.slice(last,match.index));
          next.push(build(match.slice(1),keyPrefix+'-'+match.index));
          last=match.index+match[0].length;
        }
        if(last<part.length)next.push(part.slice(last));
      }
      parts=next;
    }
    // 元素自己带了 key；纯字符串在数组里不需要 key
    return parts.filter(part=>part!=='');
  }
  /**
   * 整段答案 -> 一组块级节点。
   *
   * 只认这几种：标题、无序/有序列表、引用、分隔线、普通段落。**认不出的原样输出**，
   * 半懂不懂地"清理"标记比不处理更糟（会把用户该看到的内容吃掉）。
   */
  function renderMarkdown(text){
    const lines=String(text||'').split('\n');
    const blocks=[];
    let list=null, listItems=[];
    const flush=()=>{if(list){blocks.push(h(list.type,list.props,...listItems));list=null;listItems=[];}};
    lines.forEach((raw,index)=>{
      const line=raw.replace(/\s+$/,'');
      const key='md'+index;
      const bullet=/^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered=/^\s*(\d+)[.、)]\s+(.*)$/.exec(line);
      if(bullet||ordered){
        const orderedList=!!ordered;
        if(!list||list.props.ordered!==orderedList)flush();
        if(!list)list={type:'ul',props:{key:key+'-list',ordered:orderedList,
          style:{margin:'4px 0',paddingLeft:20,listStyle:orderedList?'decimal':'disc'}}};
        const content=bullet?bullet[1]:ordered[2];
        listItems.push(h('li',{key,style:{marginBottom:2}},inlineNodes(content,key)));
        return;
      }
      flush();
      if(!line.trim()){return;}
      const heading=/^(#{1,4})\s+(.*)$/.exec(line);
      if(heading){
        const size=[15,14,14,13][heading[1].length-1]||13;
        blocks.push(h('div',{key,style:{fontSize:size,fontWeight:600,color:C.text,margin:'6px 0 2px'}},
          inlineNodes(heading[2],key)));
        return;
      }
      if(/^\s*([-*_])\1{2,}\s*$/.test(line)){blocks.push(h('hr',{key,style:{border:'none',
        borderTop:'1px solid '+C.border,margin:'8px 0'}}));return;}
      const quote=/^\s*>\s?(.*)$/.exec(line);
      if(quote){
        blocks.push(h('div',{key,style:{borderLeft:'3px solid '+C.border,paddingLeft:10,
          color:C.text2,margin:'4px 0'}},inlineNodes(quote[1],key)));
        return;
      }
      blocks.push(h('div',{key,style:{margin:'3px 0'}},inlineNodes(line,key)));
    });
    flush();
    // 段落之间不要空一块：空行已经用小 margin 表达了
    return blocks.length?blocks:null;
  }

  function answerBody(text){
    const items=new Set(answerListItems(text));
    const kept=String(text||'').split('\n').filter(line=>!items.has(listItemText(line)));
    return kept.join('\n').replace(/\n{3,}/g,'\n\n').trim();
  }

  /** A rotating ring for anything the user waits on. The host theme provides the colours. */
  function Spinner({size=14}){
    return h('span',{className:'ma-spin','aria-hidden':'true',style:{width:size,height:size,
      borderRadius:'50%',border:'2px solid '+C.border,borderTopColor:C.brand,display:'inline-block',flexShrink:0}});
  }

  /**
   * 统一的勾选框：整理页选待办、今天要做的标记完成，都用这一个。
   *
   * 原来各写各的 —— 整理页用原生 checkbox，今天要做的用一个自绘的方块按钮（未完成时也显示
   * 一个灰勾）。同一个产品里"勾掉一件事"长成两个样子，用户认不出来那个方块是可以点的
   * （实测被问过"这个待办怎么标记完成"）。
   */
  function Checkbox({checked,onChange,disabled,label,style}){
    return h('input',{type:'checkbox',checked:!!checked,disabled:!!disabled,onChange,'aria-label':label,
      style:{width:18,height:18,flexShrink:0,accentColor:C.brand,margin:0,
        cursor:disabled?'default':'pointer',...style}});
  }

  // ---- 首页：消息（数据全部来自 wechat-db-lab 的明文副本）------------------------------------
  //
  // 这一页回答三个问题：**现在有什么**（关键信息）、**能做什么**（关键操作）、
  // **还想知道什么**（对话）。三块都建立在明文副本上，点开就是结果，不碰微信窗口。
  //
  // 和旧版「消息整理」页的区别：旧版整条链路是 OCR —— 先刷新可见列表拿到候选名，再让
  // 模型按名字逐个打开会话去读。一次整理要动好几回微信窗口，抢走用户正在看的会话、
  // 清掉未读红点，而且只覆盖滚在顶上的那十来行，名字被省略号截断就认不出来。
  // 新版由服务端一次读库、一次调模型，整个过程中微信窗口不参与。

  /**
   * 一个会话一行：标题 + 时间 + 预览。点开进这个人的会话视图。
   *
   * 「等你回复」用胶囊标出来而不是换个文字颜色 —— 颜色单独承载语义，在深浅两套主题里
   * 总会丢一样。
   */
  function SessionRow({session,onOpen}){
    const tags=[];
    if(session.waitingReply)tags.push(h('span',{key:'wait',style:{...pill(C.brand),fontSize:12}},'等你回复'));
    if(session.unread>0)tags.push(h('span',{key:'unread',style:{fontSize:12,color:C.warn,flexShrink:0}},'未读 '+session.unread));
    if(session.kind==='group')tags.push(h('span',{key:'group',style:{fontSize:12,color:C.text3,flexShrink:0}},'群聊'));
    return h('button',{onClick:onOpen,style:{display:'block',width:'100%',textAlign:'left',padding:'12px 14px',
      border:'none',borderTop:'1px solid '+C.border,background:'transparent',color:C.text,cursor:'pointer'}},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline'}},
        h('strong',{style:{fontSize:15,fontWeight:600,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},session.title),
        h('span',{style:{fontSize:12,color:C.text3,flexShrink:0}},relativeTime(session.lastAt))),
      h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:5,minWidth:0}},
        ...tags,
        h('span',{style:{flex:1,minWidth:0,fontSize:13,color:C.text3,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},
          (session.lastDirection==='outgoing'?'我：':'')+(session.preview||'（没有可读的文本消息）'))));
  }

  /** 首屏的一张卡：标题 + 一句说明 + 右上角操作。全页共用，保证节奏一致。 */
  function WeChatInitCard({inline}){
    const keys=usePoller(true,()=>api('wechat-keys'),20000);
    const [stage,setStage]=useState('idle');   // idle | confirm | busy
    const [error,setError]=useState(''),[note,setNote]=useState('');
    const done=!!keys.data?.keys?.configured;
    async function run(){
      setStage('busy');setError('');setNote('');
      try{
        await api('wechat-keys',{action:'scan'});
        setNote('完成');
        await keys.refresh();
      }catch(e){setError(e.message);}
      finally{setStage('idle');}
    }
    // 已经初始化过：这张卡不出现（读不到状态时也不出现，避免闪一下又消失）
    if(done||!keys.data)return null;
    if(stage==='busy')return h('p',{style:{...hint,margin:0}},'正在初始化，可能要十几秒，不要关页面。');
    if(stage==='confirm'){
      return h('div',null,
        h('p',{style:{...hint,margin:'0 0 12px',color:C.text2}},
          '这一步会读一次微信的内存来取消息密钥。微信需要在运行并且已经登录。'
          +'取到的密钥会用 Windows 的密钥保护保存在这台电脑上，以后不会再读内存。'),
        h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
          h('button',{onClick:run,style:button(true)},'确认'),
          h('button',{onClick:()=>setStage('idle'),style:button(false,false,true)},'取消')));
    }
    return h('div',null,
      h('p',{style:{...hint,margin:'0 0 12px'}},'点一下完成初始化，之后这一页就会显示聊天。'),
      inline?h('p',{style:{...hint,margin:'0 0 12px'}},'（如果已经初始化过，确认微信已登录，稍等片刻内容会自动出现。）'):null,
      h('div',{style:{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}},
        h('button',{onClick:()=>setStage('confirm'),style:button(true)},'初始化微信数据'),
        note&&h('span',{style:hint},note)),
      h(Notice,{error}));
  }

  /**
   * 模型配置。
   *
   * 用户实测的两个问题：① 装完没人告诉他模型怎么配，不配就没法用；
   * ② 只给一个 key 输入框不够 —— 得能选供应商（OpenAI / Claude / 通义 / 智谱 / Kimi / 本地…）。
   *
   * 所以做成"选一家 + 贴 key"：预设由后端给（供应商目录），用户不用知道协议、地址这些。
   * 「其它」那一项留了地址和模型名，任何 OpenAI 兼容的服务都能接。
   */
  /**
   * 语音转文字（可选）。
   *
   * 拆成两件事，因为这决定谁为它付代价：
   *   · 把语音解成声音波形 —— 解码器只有 75 KB，随包走，人人都有；
   *   · 听懂说的是什么 —— 要一个几百 MB 的模型，**由用户自己决定装不装**。
   * 所以这里既有开关，也如实报"装了没有"，并给出安装命令。
   */
  function VoiceCard(){
    const voice=usePoller(true,()=>api('voice'),20000);
    const [busy,setBusy]=useState(false),[error,setError]=useState('');
    const data=voice.data,on=!!data?.enabled;
    async function toggle(){
      setBusy(true);setError('');
      try{await api('voice',{enabled:!on});await voice.refresh();}
      catch(e){setError(e.message);}finally{setBusy(false);}
    }
    return h('section',{style:card},
      h('h2',{style:{...h2,margin:'0 0 6px'}},'语音'),
      h('p',{style:{...hint,margin:'0 0 10px'}},
        '对方发来的语音，助手默认读不到内容（微信里存的是声音，没有文字）。'
        +'打开这个开关，它会先在这台电脑上把语音转成文字再处理 —— 不联网、不花钱。'),
      h(Toggle,{on,onClick:toggle,busy,disabled:!data?.decoder,label:'把语音转成文字'}),
      data?.hint&&h('p',{style:{...hint,margin:'10px 0 0',color:C.warn}},data.hint),
      !data?.hint&&h('p',{style:{...hint,margin:'10px 0 0'}},
        on?'已开启：语音会先转成文字，再按普通消息处理。':'已关闭：语音只提示"需要你自己听一遍"。'),
      h(Notice,{error}));
  }

  function ModelSetupCard(){
    const status=usePoller(true,()=>api('status'),20000);
    const catalog=usePoller(true,()=>api('models'),60000);
    const providers=usePoller(true,()=>api('model-providers'),60000);
    const [picked,setPicked]=useState(''),[key,setKey]=useState('');
    const [baseUrl,setBaseUrl]=useState(''),[model,setModel]=useState('');
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
    const list=providers.data?.providers||[];
    const configured=providers.data?.configured||[];
    const models=catalog.data?.models||[];
    // 默认选中"还没配过的第一家"：新用户打开就能直接贴 key，不用先想选谁。
    const current=list.find(p=>p.id===picked)||list.find(p=>!configured.includes(p.id))||list[0];
    async function save(){
      if(!current)return;
      setBusy(true);setError('');setNote('');
      try{
        const result=await api('model-provider',{provider:current.id,key,baseUrl,model});
        await Promise.all([catalog.refresh(),providers.refresh()]);
        setNote(result?.message||'已保存');
        setKey('');
        if(current.id!=='custom'){setBaseUrl('');setModel('');}
      }catch(e){setError(e.message);}
      finally{setBusy(false);}
    }
    const needKey=!!current?.needsKey&&!current?.builtin;
    const canSave=!!current&&(!needKey||key.trim().length>=8)&&(current.id!=='custom'||baseUrl.trim().length>0);
    const rows=[
      h('p',{key:'state',style:{...hint,margin:'0 0 12px'}},
        models.length?('当前可用模型 '+models.length+' 个'+(status.data?.model?('，默认 '+status.data.model):''))
          :'还没有可用的模型 —— 选一家供应商、贴上它的 API key 就能用。'),
      h('div',{key:'pick',style:{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}},
        h(Select,{value:current?.id||'',
          groups:[{items:list.map(p=>({value:p.id,label:p.name+(configured.includes(p.id)?'（已配置）':''),hint:p.builtin?'内置':''}))}],
          onChange:value=>{setPicked(value);setNote('');setError('');},
          ariaLabel:'模型供应商',minWidth:260}),
        current?.keyUrl?h('a',{key:'k',href:current.keyUrl,target:'_blank',rel:'noreferrer',
            style:{fontSize:13,color:C.brand,whiteSpace:'nowrap'}},'去哪拿 key →'):null)];

    if(current?.note&&current.id!=='custom'){
      rows.push(h('p',{key:'note',style:{...hint,margin:'10px 0 0'}},current.note));
    }
    if(current?.id==='custom'){
      rows.push(h('div',{key:'custom',style:{display:'flex',gap:10,flexWrap:'wrap',marginTop:10}},
        h('input',{value:baseUrl,placeholder:'服务地址，例如 https://api.example.com/v1','aria-label':'服务地址',
          onChange:event=>setBaseUrl(event.target.value),style:{...field,flex:'1 1 260px'}}),
        h('input',{value:model,placeholder:'模型名，例如 gpt-4o','aria-label':'模型名',
          onChange:event=>setModel(event.target.value),style:{...field,flex:'0 1 200px'}})));
    }
    if(needKey){
      rows.push(h('div',{key:'key',style:{display:'flex',gap:10,flexWrap:'wrap',marginTop:10}},
        h('input',{type:'password',value:key,placeholder:current.name+' 的 API key','aria-label':'API key',
          onChange:event=>setKey(event.target.value),style:{...field,flex:'1 1 260px'}}),
        h('button',{onClick:save,disabled:busy||!canSave,style:button(true)},busy?'正在保存…':'保存并启用')));
    }else if(current&&!current.needsKey){
      rows.push(h('div',{key:'nokey',style:{marginTop:10,display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}},
        h('button',{onClick:save,disabled:busy,style:button(true)},busy?'正在保存…':'启用这家')));
    }
    if(current?.id!=='ollama-local'){
      rows.push(h('p',{key:'safe',style:{...hint,margin:'10px 0 0'}},
        'key 用 Windows 的密钥保护加密保存在这台电脑上（磁盘上不留明文），保存后立刻生效。'
        +(current?.id==='custom'?'':'同一家可以随时回来换 key。')));
    }
    rows.push(h('p',{key:'local',style:{...hint,margin:'6px 0 0'}},
      '不想用云端：选「本地模型（Ollama）」，或右键运行安装目录里的 install-local-model.ps1。'));
    rows.push(h(Notice,{key:'err',error}));
    rows.push(h(Result,{key:'ok',text:note}));
    return h('section',{style:card},
      h('h2',{style:{...h2,margin:'0 0 6px'}},'模型'),
      h('p',{style:{...hint,margin:'0 0 10px'}},
        '写回复、整理消息都要用一个大模型。选一家供应商、贴上它的 key 就能用；也可以在这台电脑上跑本地模型。'),
      h('div',null,rows));
  }

  /**
   * 首页「还没有读到会话」那张卡。内容随"初始化过没有"变：
   * 没初始化 → 一个按钮；初始化过 → 一句提示（说明是微信没登录/还没同步）。
   * 状态没回来时整张卡不出现，避免"闪一下又变"。
   */
  function WeChatEmptyCard(){
    const keys=usePoller(true,()=>api('wechat-keys'),20000);
    if(!keys.data)return null;
    if(keys.data.keys?.configured){
      return h(HomeCard,{title:'还没有读到会话'},
        h('p',{style:{...hint,margin:0}},'确认微信已登录，稍等片刻这一页会自动出现内容。'));
    }
    return h(HomeCard,{title:'还没有读到会话'},h(WeChatInitCard,{}));
  }

  /** 设置页里的同一件事：初始化完成后整块消失（用户要求：读过就别再显示）。 */
  function WeChatInitSection(){
    const keys=usePoller(true,()=>api('wechat-keys'),20000);
    if(!keys.data||keys.data.keys?.configured)return null;
    return h('section',{style:card},
      h('h2',{style:{...h2,margin:'0 0 6px'}},'微信数据'),
      h('p',{style:{...hint,margin:'0 0 10px'}},'助手要读消息，先初始化一次。'),
      h(WeChatInitCard,{}));
  }

  /**
   * 日期时间选择（自绘）。
   *
   * 为什么不用 <input type="datetime-local">：那是系统画的，和这块玻璃界面是两个风格
   * （用户实测："日历控件就是原生的，风格不协调"）。自己做一个月历 + 时间选择，
   * 和 Select 用同一套弹出逻辑（fixed 定位、点空白关闭、Esc 关闭并拦住冒泡）。
   *
   * 值格式沿用 datetime-local 的 'YYYY-MM-DDTHH:mm'，调用方不用改。
   */
  function DateTimeField({value,onChange,placeholder='选择时间',ariaLabel='到期时间'}){
    const [open,setOpen]=useState(false),[box,setBox]=useState(null),ref=useRef(null);
    const parse=text=>{
      const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(text||''));
      return match?{y:+match[1],m:+match[2]-1,d:+match[3],h:+match[4],mi:+match[5]}:null;
    };
    const current=parse(value);
    const today=new Date();
    const [cursor,setCursor]=useState(()=>current?new Date(current.y,current.m,1):new Date(today.getFullYear(),today.getMonth(),1));
    useEffect(()=>{
      if(!open)return;
      const onDoc=event=>{if(ref.current&&!ref.current.contains(event.target))setOpen(false);};
      const onKey=event=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);}};
      const onResize=()=>setOpen(false);
      // 同上：面板内部滚动（时间下拉列表）不该把整个面板关掉。
      const onScroll=event=>{if(ref.current&&!ref.current.contains(event.target))setOpen(false);};
      document.addEventListener('mousedown',onDoc);
      document.addEventListener('keydown',onKey,true);
      window.addEventListener('resize',onResize);
      window.addEventListener('scroll',onScroll,true);
      return()=>{document.removeEventListener('mousedown',onDoc);document.removeEventListener('keydown',onKey,true);window.removeEventListener('resize',onResize);window.removeEventListener('scroll',onScroll,true);};
    },[open]);
    function openPanel(){
      const rect=ref.current.getBoundingClientRect();
      const height=352,below=window.innerHeight-rect.bottom;
      const up=below<height+12&&rect.top>below;
      setBox({left:rect.left,width:Math.max(rect.width,272),...(up?{bottom:window.innerHeight-rect.top+6}:{top:rect.bottom+6})});
      setOpen(true);
    }
    const emit=(y,m,d,h,mi)=>onChange(y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0')+'T'+String(h).padStart(2,'0')+':'+String(mi).padStart(2,'0'));
    const pick=day=>emit(cursor.getFullYear(),cursor.getMonth(),day,current?current.h:9,current?current.mi:0);
    const first=new Date(cursor.getFullYear(),cursor.getMonth(),1);
    const lead=(first.getDay()+6)%7;                              // 周一开头，和国内习惯一致
    const days=new Date(cursor.getFullYear(),cursor.getMonth()+1,0).getDate();
    const cells=[];
    for(let i=0;i<lead;i++)cells.push(null);
    for(let d=1;d<=days;d++)cells.push(d);
    const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
    const isPicked=day=>!!current&&current.d===day&&sameDay(new Date(current.y,current.m,current.d),new Date(cursor.getFullYear(),cursor.getMonth(),day));
    const show=current?((current.m+1)+'月'+current.d+'日 '+String(current.h).padStart(2,'0')+':'+String(current.mi).padStart(2,'0')):'';
    const hours=Array.from({length:24},(_,i)=>({value:String(i),label:String(i).padStart(2,'0')+' 点'}));
    const minutes=[0,15,30,45].map(i=>({value:String(i),label:String(i).padStart(2,'0')+' 分'}));
    return h('div',{ref,style:{position:'relative',display:'inline-flex'}},
      h('button',{onClick:openPanel,type:'button','aria-label':ariaLabel,
        style:{...small(false),borderRadius:99,display:'inline-flex',alignItems:'center',gap:7}},
        h('span',{style:{color:show?C.text:C.text3}},show||placeholder),
        h('span',{style:{fontSize:10,color:C.text3}},'▾')),
      open&&box&&h('div',{style:{position:'fixed',left:box.left,width:box.width,zIndex:60,
          ...(box.top!==undefined?{top:box.top}:{bottom:box.bottom}),
          padding:12,borderRadius:14,background:C.panel,border:'1px solid '+C.border,
          boxShadow:'0 18px 40px rgba(24,60,42,.18)'}},
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
          h('button',{onClick:()=>setCursor(new Date(cursor.getFullYear(),cursor.getMonth()-1,1)),type:'button',style:iconButton},'‹'),
          h('strong',{style:{fontSize:14,color:C.text}},cursor.getFullYear()+'年'+(cursor.getMonth()+1)+'月'),
          h('button',{onClick:()=>setCursor(new Date(cursor.getFullYear(),cursor.getMonth()+1,1)),type:'button',style:iconButton},'›')),
        h('div',{style:{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2,marginBottom:4}},
          ['一','二','三','四','五','六','日'].map(week=>h('span',{key:week,style:{fontSize:11,color:C.text3,textAlign:'center'}},week))),
        h('div',{style:{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2}},
          cells.map((day,index)=>day===null?h('span',{key:'p'+index}):
            h('button',{key:day,type:'button',onClick:()=>pick(day),
              style:{padding:'6px 0',border:'none',borderRadius:8,fontSize:13,cursor:'pointer',
                background:isPicked(day)?C.brand:'transparent',
                color:isPicked(day)?'#fff':(sameDay(new Date(cursor.getFullYear(),cursor.getMonth(),day),today)?C.brand:C.text)}},String(day)))),
        h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:10,flexWrap:'wrap'}},
          h('span',{style:{fontSize:12,color:C.text2}},'时间'),
          h(Select,{value:String(current?current.h:9),groups:[{items:hours}],minWidth:96,
            onChange:next=>emit(current?current.y:today.getFullYear(),current?current.m:today.getMonth(),current?current.d:today.getDate(),+next,current?current.mi:0)}),
          h(Select,{value:String(current?current.mi:0),groups:[{items:minutes}],minWidth:96,
            onChange:next=>emit(current?current.y:today.getFullYear(),current?current.m:today.getMonth(),current?current.d:today.getDate(),current?current.h:9,+next)})),
        h('div',{style:{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}},
          h('button',{type:'button',onClick:()=>{const moment=new Date();emit(moment.getFullYear(),moment.getMonth(),moment.getDate(),moment.getHours(),0);setCursor(new Date(moment.getFullYear(),moment.getMonth(),1));},
            style:{...small(false),borderRadius:99}},'今天'),
          value&&h('button',{type:'button',onClick:()=>{onChange('');setOpen(false);},style:{...small(false,false,true),borderRadius:99}},'清除'),
          h('button',{type:'button',onClick:()=>setOpen(false),style:{...small(true),borderRadius:99,marginLeft:'auto'}},'完成'))));
  }

  function HomeCard({title,meta,action,children}){
    return h('section',{style:card},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:children?12:0}},
        h('div',{style:{minWidth:0}},
          h('h2',{style:{...h2,margin:0,fontSize:15}},title),
          meta&&h('span',{style:{display:'block',fontSize:12,color:C.text3,marginTop:3}},meta)),
        action||null),
      children);
  }

  /** 首屏三格数字。只放一眼能看懂的量，不做百分比、不做图表。 */
  function StatStrip({totals}){
    const cells=[['等你回复',totals.waiting,'最后一条是别人发的'],
                 ['待办',totals.todos,'还没做完的事'],
                 ['今天新消息',totals.todayMessages,'最近 24 小时内的消息条数']];
    return h('div',{style:{display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:10,marginBottom:14}},
      cells.map(([label,value,title])=>h('div',{key:label,title,
        style:{padding:'14px 15px',borderRadius:'var(--lg-r-lg)',border:'1px solid var(--lg-card-line)',
          backgroundColor:FIELD_BG,backgroundImage:'var(--lg-card-sheen)'}},
        h('strong',{style:{display:'block',fontSize:26,lineHeight:1.15,color:C.text}},String(value??0)),
        h('span',{style:{fontSize:12,color:C.text2}},label))));
  }

  /**
   * 整理结果：结论 + 需要关注的人 + 可勾选的待办。
   *
   * 待办**默认全选、但不自动入库** —— 模型给"要做的事"永远只能是建议，记成待办是用户的
   * 动作。旧版这类建议直接进待办，结果把用户不知道是什么的群聊也塞进了今天要做的事。
   */
  function OrganizeResult({result,busy,picked,added,onCheck,onAdd,onOpen}){
    // 「拟一版」：整理告诉我们"该回复谁"，这里直接把草稿写出来，用户改完点发送。
    // 发送是**唯一会动这台电脑**的动作（要打开微信窗口），所以链路上只有这一个触发点：
    // 用户点「发送」。不做二次确认（用户明确说了：不是删除）。
    const [draftOf,setDraftOf]=useState(''),[draftText,setDraftText]=useState('');
    const [draftMeta,setDraftMeta]=useState(null),[draftBusy,setDraftBusy]=useState(''),[draftNote,setDraftNote]=useState('');
    const [draftError,setDraftError]=useState('');
    async function makeDraft(item,index){
      const key=String(index);
      setDraftBusy(key);setDraftError('');setDraftNote('');
      try{
        const made=await api('reply-draft',{title:item.conversation||''});
        setDraftMeta({provider:made.provider,conversation:made.conversation,title:made.title});
        setDraftText(made.text||'');setDraftOf(key);
      }catch(e){
        setDraftError(e.message);setDraftOf('');
      }finally{setDraftBusy('');}
    }
    async function sendDraft(){
      if(!draftMeta||!draftText.trim())return;
      setDraftBusy('send');setDraftError('');setDraftNote('');
      try{
        const sent=await api('send',{provider:draftMeta.provider,conversation:draftMeta.conversation,text:draftText.trim()});
        setDraftNote(sent&&sent.status==='not_sent'?'没有发出去（'+(sent.code||'消息窗口不可用')+'）':'已发送给 '+draftMeta.title);
        setDraftOf('');
      }catch(e){setDraftError(e.message);}finally{setDraftBusy('');}
    }
    const todos=result?.todos||[];
    const focus=result?.focus||[];
    // 已经处理过的条目在服务端就被摘掉了（见 reconcileSuggestions），这里只报个数，
    // 让用户知道"不是没看见，是已经不用再看了"。
    const hidden=result?.hiddenCount||0;
    // 已加入（这一次会话里刚加的）。刷新之后服务端会直接把这条从建议里去掉，
    // 所以不再需要靠 alreadyAdded 兜底。
    const isAdded=index=>!!added[index]||!!todos[index]?.alreadyAdded;
    const chosen=todos.map((item,index)=>index).filter(index=>picked[index]!==false&&!isAdded(index));
    return h('section',{style:card},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline',marginBottom:10}},
        h('h2',{style:{...h2,margin:0,fontSize:15}},'整理结果'),
        h('span',{style:{fontSize:12,color:C.text3}},
          (result.at?relativeTime(result.at):'')+(result.sessionsRead?(' · 读了 '+result.sessionsRead+' 个会话'):''))),
      result.summary&&h('p',{style:{margin:'0 0 14px',fontSize:15,lineHeight:1.85,color:C.text,whiteSpace:'pre-wrap',wordBreak:'break-word'}},result.summary),
      !!focus.length&&h('div',{style:{marginBottom:14}},
        h('p',{style:{...hint,margin:'0 0 8px'}},'需要你关注'),
        h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.bg,overflow:'hidden'}},
          focus.map((item,index)=>h('div',{key:(item.conversation||'')+index,
            style:{display:'flex',gap:10,alignItems:'flex-start',padding:'11px 14px',borderTop:index?'1px solid '+C.border:'none'}},
            h('div',{style:{flex:1,minWidth:0}},
              h('strong',{style:{fontSize:14,color:C.text}},item.conversation||'（未指明）'),
              item.why&&h('div',{style:{fontSize:13,color:C.text2,marginTop:4,lineHeight:1.7}},item.why),
              item.action&&h('div',{style:{fontSize:13,color:C.text3,marginTop:3}},'建议：'+item.action)),
            item.username&&h('button',{onClick:()=>onOpen(item.username,item.conversation,item.kind),
              style:{...small(false),flexShrink:0}},'看看'))))),
      !!todos.length&&h('div',null,
        h('p',{style:{...hint,margin:'0 0 8px'}},'勾选要记进待办的事（默认全选）：'),
        h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.bg,overflow:'hidden'}},
          todos.map((item,index)=>h('div',{key:item.title+index,
            style:{borderTop:index?'1px solid '+C.border:'none'}},
            // 外层是 div、label 只包复选框和文字：按钮放进 label 里会被它吃掉点击
            // （点"拟一版"变成勾选复选框）。
            h('div',{style:{display:'flex',gap:10,alignItems:'flex-start',padding:'11px 14px'}},
              h('label',{style:{display:'flex',gap:10,alignItems:'flex-start',flex:1,minWidth:0,
                cursor:busy||isAdded(index)?'default':'pointer'}},
                h(Checkbox,{checked:picked[index]!==false&&!isAdded(index),disabled:busy||isAdded(index),
                  label:'记成待办：'+firstLine(item.title,20),onChange:event=>onCheck(index,event.target.checked),style:{marginTop:3}}),
                h('div',{style:{flex:1,minWidth:0}},
                  h('div',{style:{fontSize:14,color:isAdded(index)?C.text3:C.text,lineHeight:1.6,
                    textDecoration:'none',wordBreak:'break-word'}},item.title),
                  (item.detail||item.conversation)&&h('div',{style:{fontSize:12,color:C.text3,marginTop:3,lineHeight:1.6,wordBreak:'break-word'}},
                    (item.detail||'')+(item.conversation?((item.detail?' · ':'')+'来自 '+item.conversation):'')))),
              // 「拟一版」只在能确定收件人时出现：整理给的是显示名，解析不到会话就没法发。
              item.conversation&&h('button',{type:'button',disabled:!!draftBusy||busy,
                onClick:()=>makeDraft(item,index),style:{...small(false),flexShrink:0},
                title:'写一版回复草稿，你看过再发'},draftBusy===String(index)?'正在写…':'拟一版'),
              isAdded(index)&&h('span',{style:{fontSize:12,color:C.ok,flexShrink:0}},'已加入')),
            draftOf===String(index)&&h('div',{style:{margin:'0 14px 12px',padding:'12px 13px',
                border:'1px solid '+C.border,borderRadius:10,background:C.panel}},
              h('p',{style:{...hint,margin:'0 0 8px'}},
                '发给「'+(draftMeta?.title||item.conversation)+'」—— 可以改，改完点发送。'),
              h('textarea',{value:draftText,rows:4,'aria-label':'回复草稿',
                onChange:event=>setDraftText(event.target.value),
                style:{...field,width:'100%',boxSizing:'border-box',lineHeight:1.7,resize:'vertical'}}),
              h('div',{style:{display:'flex',gap:10,alignItems:'center',marginTop:10,flexWrap:'wrap'}},
                h('button',{type:'button',onClick:sendDraft,disabled:!!draftBusy||!draftText.trim(),
                  style:button(true)},draftBusy==='send'?'正在发送…':'发送'),
                h('button',{type:'button',onClick:()=>{setDraftOf('');setDraftError('');},disabled:!!draftBusy,
                  style:button(false,false,true)},'取消'),
                h('span',{style:{fontSize:12,color:C.text3}},'会打开微信窗口发出')),
              h(Notice,{error:draftError}))))),
        h('button',{onClick:onAdd,disabled:busy||!chosen.length,style:{...small(true),marginTop:12}},
          busy?'正在记…':(chosen.length?('加入选中的 '+chosen.length+' 件'):'没有选中任何条目')),
        draftNote?h('p',{style:{...hint,margin:'10px 0 0',color:C.ok}},draftNote):null,
        hidden?h('p',{style:{...hint,margin:'10px 0 0'}}, 
          '另有 '+hidden+' 条已经记进待办（或已完成），这次没有再列出来。'):null),
      !todos.length&&!focus.length&&h('p',{style:{margin:0,fontSize:14,color:C.text2,lineHeight:1.8}},'这次整理没有给出可执行的事项。'),
      h('p',{style:{...hint,margin:'12px 0 0'}},'整理只看消息本身；不会打开微信窗口，也不会发送任何消息。'));
  }

  /** 对话里的一条。用户的靠右、助手的靠左；助手答案里的「- [ ] 」可以一键记成待办。 */
  function ChatBubble({item,onAddTodos}){
    const mine=item.role==='user';
    const todos=mine?[]:answerListItems(item.text);
    const body=mine?String(item.text||''):(answerBody(item.text)||'');
    return h('div',{style:{display:'flex',justifyContent:mine?'flex-end':'flex-start',marginBottom:10}},
      h('div',{style:{maxWidth:'88%',minWidth:0,padding:'10px 13px',borderRadius:'var(--lg-r-lg)',
        border:'1px solid '+(mine?'transparent':'var(--lg-card-line)'),
        backgroundColor:mine?'var(--ma-primary-soft)':FIELD_BG,color:C.text,
        fontSize:14,lineHeight:1.75,whiteSpace:'pre-wrap',wordBreak:'break-word'}},
        mine?(body||null):(renderMarkdown(body)||body||null),
        !mine&&!!item.tools?.length&&h('div',{style:{marginTop:6,fontSize:12,color:C.text3}},'（'+toolText(item.tools)+'）'),
        !mine&&!!todos.length&&h('button',{onClick:()=>onAddTodos(todos),style:{...small(false),marginTop:9}},'把上面 '+todos.length+' 条记成待办')));
  }

  /**
   * 与消息助手的对话。
   *
   * 服务端固定用一个 harness session（messaging-home），所以模型记得住上下文；这里渲染的
   * items 来自 data/chat-log.json，只为"刷新之后还能看见刚才那几轮"。
   * 每次提问，服务端都会把一份消息快照拼进提示词 —— 助手不需要打开微信窗口读消息。
   */
  // 占位文案的样式只能靠 CSS —— `::placeholder` 没法用内联样式写，而插件没有自己的样式表。
  // 只做一件事：提示语和输入**同字号**、颜色**更淡**（默认的浏览器样式两者都不一致，
  // 用户实测："提示语的字体需要和输入保持一致，可以颜色设置淡一点点"）。
  if (typeof document !== 'undefined' && !document.getElementById('ma-ask-style')) {
    const style = document.createElement('style');
    style.id = 'ma-ask-style';
    style.textContent = '.ma-ask::placeholder{font-size:14px;color:var(--ma-subtle);opacity:1}';
    document.head.appendChild(style);
  }

  /**
   * 会随内容长高的问话框。
   *
   * 原来是个单行 `<input>`：问题一长只能看到一行（用户实测："输入文案较多时只能显示一行"）。
   * 聊天类输入的惯例：**Enter 发送、Shift+Enter 换行**；
   * 还有一个中文用户必需的细节 —— 输入法组字时按 Enter 是**选字**，不能当成发送
   * （`event.isComposing`），否则打"zhong午"选词那一下就发出去了。
   */
  function GrowingAskField({value,onChange,onSubmit,placeholder,ariaLabel,maxRows=7}){
    const ref=useRef(null);
    const lineHeight=22, padding=16;
    const cap=maxRows*lineHeight+padding;
    // 一行的高度要对齐按钮高度（32px）：22 行高 + 上下各 5px。
    // 否则单行时按钮贴底会把上边挤到只剩 2px（用户实测：「更贴近上方边缘」）。
    const oneLine=lineHeight+10;
    const resize=()=>{
      const el=ref.current;
      if(!el)return;
      // 空的时候**强制一行**：空 textarea 的 scrollHeight 往往大于一行，
      // 用它算高度会让框比一行高（删空之后尤其明显）——用户实测说"看起来很怪"。
      if(!String(value??'').length){el.style.height=oneLine+'px';el.style.overflowY='hidden';return;}
      el.style.height='auto';
      const wanted=Math.min(el.scrollHeight,cap);
      el.style.height=Math.max(oneLine,wanted)+'px';
      el.style.overflowY=el.scrollHeight>cap?'auto':'hidden';
    };
    useEffect(resize,[value]);
    return h('textarea',{ref,value,rows:1,placeholder,'aria-label':ariaLabel,className:'ma-ask',
      onChange:event=>onChange(event.target.value),
      onKeyDown:event=>{
        if(event.key!=='Enter'||event.shiftKey||event.isComposing)return;
        event.preventDefault();
        onSubmit();
      },
      // 外层那个圆角框就是它唯一的边框：这里不再画一遍（否则框里套框）。
      style:{flex:'1 1 auto',minWidth:0,resize:'none',lineHeight:lineHeight+'px',
        height:oneLine,maxHeight:cap,overflowY:'hidden',boxSizing:'border-box',
        border:'none',outline:'none',background:'transparent',color:C.text,
        // 右边留出箭头的宽度，长句换行时不会钻到箭头底下。
        fontFamily:'inherit',fontSize:14,padding:'5px 34px 5px 0'}});
  }

  function HomeChat({narrow}){
    const [items,setItems]=useState([]),[text,setText]=useState('');
    const [asking,setAsking]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
    const [loading,setLoading]=useState(true),boxRef=useRef(null);
    useEffect(()=>{
      let live=true;
      api('chat').then(result=>{if(live)setItems(result?.items||[]);})
        .catch(()=>{}).finally(()=>{if(live)setLoading(false);});
      return()=>{live=false;};
    },[]);
    useEffect(()=>{const node=boxRef.current;if(node)node.scrollTop=node.scrollHeight;},[items,asking]);
    async function submit(value){
      const question=String(value===undefined?text:value).trim();
      if(!question||asking)return;
      setAsking(true);setError('');setNote('');setText('');
      const mine={role:'user',text:question,at:Date.now()/1000};
      setItems(old=>[...old,mine]);
      try{const result=await api('chat',{text:question});setItems(result?.items||[]);}
      // 失败要把用户刚发的那句放回输入框：不然他写了半天的问题就这么没了。
      catch(e){setError(e.message);setItems(old=>old.slice(0,-1));setText(question);}
      finally{setAsking(false);}
    }
    async function clear(){
      try{await mutate('chat','PATCH');setItems([]);setError('');setNote('');}
      catch(e){setError(e.message);}
    }
    async function addTodos(list){
      setError('');setNote('');
      try{
        for(const item of list)await api('todos',{title:firstLine(item,60),source:'assistant'});
        setNote('已记下 '+list.length+' 条待办');
      }catch(e){setError(e.message);}
    }
    const quick=['最近有什么事要我处理？','谁在等我回复？','总结一下最近的群消息'];
    return h('div',{style:{display:'flex',flexDirection:'column',height:narrow?'auto':'100%',
      minHeight:narrow?380:0,minWidth:0}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,padding:'14px 18px 10px',flexShrink:0}},
        h('div',{style:{minWidth:0}},
          h('strong',{style:{fontSize:15,color:C.text}},'问助手'),
          h('span',{style:{display:'block',fontSize:12,color:C.text3,marginTop:2}},'不打开微信窗口，不会打扰你')),
        items.length?h('button',{onClick:clear,style:small(false,false,true)},'清空'):null),
      h('div',{ref:boxRef,style:{flex:1,minHeight:0,overflowY:'auto',padding:'4px 18px 12px'}},
        loading&&h('p',{style:hint},'正在读取对话…'),
        !loading&&!items.length&&h('div',{style:{padding:'10px 0 18px'}},
          h('p',{style:{...hint,margin:'0 0 12px'}},'可以直接问，例如：'),
          h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
            quick.map(question=>h('button',{key:question,onClick:()=>submit(question),style:small(false,false,true)},question)))),
        items.map((item,index)=>h(ChatBubble,{key:index,item,onAddTodos:addTodos})),
        asking&&h('div',{style:{display:'flex',alignItems:'center',gap:9,color:C.text2,fontSize:13,padding:'6px 0'}},
          h(Spinner,{size:14}),'助手在想，通常十几秒…')),
      // 输入区与上面消息之间留出间隔（用户实测：多行时会贴上去）。
      h('div',{style:{padding:'0 18px 16px',flexShrink:0,marginTop:10}},
        h(Notice,{error}),
        h(Result,{text:note}),
        // 一个整体的圆角框：文字在左，发送箭头贴在**框内**右下角。
        // 按钮不再单独占一列 —— 多行时它不会漂在中间（用户实测指出过）。
        // 用 flex 让它铺满整行（块级 textarea 在这里会被内容压窄，占位文案就"显示不全"了）；
        // 右侧内边距按箭头宽度 + 2px 给，多行时文案不会离箭头太远。
        h('div',{style:{position:'relative',display:'flex',alignItems:'flex-end',
            padding:'8px 8px 8px 12px',
            border:'1px solid var(--lg-card-line)',borderRadius:18,background:FIELD_BG}},
          h(GrowingAskField,{value:text,onChange:setText,onSubmit:submit,ariaLabel:'问助手',
            placeholder:'问助手任何关于你消息的事…'}),
          // 箭头绝对定位在右下角：一行时它自然落在视觉中心，多行时贴在右下角，
          // 不会再因为 flex 对齐而在不同状态下"跳位置"。
          h('button',{type:'button',onClick:()=>submit(),disabled:asking||!text.trim(),
            'aria-label':'发送',title:'发送',
            // 贴右下 8px —— 和输入框的内边距一致；一行时上下各 8px，对称。
            style:{position:'absolute',right:8,bottom:8,width:32,height:32,borderRadius:'50%',
              border:'none',padding:0,cursor:asking||!text.trim()?'default':'pointer',
              display:'flex',alignItems:'center',justifyContent:'center',
              background:asking||!text.trim()?C.hover:C.brand,
              color:asking||!text.trim()?C.text3:'#fff'}},
            asking?h(Spinner,{size:14}):h(SendArrow,{size:18})))));
  }

  /** 首页：关键信息 + 关键操作 + 对话。 */
  function HomePage({store,narrow}){
    // 读消息**不轮询**：进页面读一次（刷新页面=重新读），之后靠「刷新」「整理」两个按钮。
    // 原来每 8 秒重扫一次微信库，而对面的消息变化并不会那么快 —— 用户想看的时候自己会点，
    // 按需读也让"整理"这一步的 token 花在他真正要的时候（用户明确要求）。
    const home=usePoller(true,()=>api('home'),0);
    const [organizing,setOrganizing]=useState(false),[busy,setBusy]=useState(false);
    const [error,setError]=useState(''),[note,setNote]=useState('');
    const [picked,setPicked]=useState({}),[added,setAdded]=useState({});
    const data=home.data;
    const totals=data?.totals||{conversations:0,reading:0,waiting:0,todayMessages:0,todos:0,doing:0,automation:0};
    const result=data?.lastOrganize||null;
    const openConversation=(username,title,kind)=>store.set({tab:'home',contactKey:username,contactTitle:title,contactKind:kind});
    // 整理要花 token（会读消息、让模型重新看一遍），所以加一个冷却：
    // 连点两下不该跑两次，手滑重按也要等一下。读完的这一刻开始计时。
    const [cooldown,setCooldown]=useState(0);
    useEffect(()=>{if(!cooldown)return;const timer=setTimeout(()=>setCooldown(value=>value-1),1000);return()=>clearTimeout(timer);},[cooldown]);
    async function organize(){
      if(organizing||cooldown>0)return;
      setOrganizing(true);setError('');setNote('');setPicked({});setAdded({});
      try{await api('home/organize',{});await home.refresh();setCooldown(20);}
      catch(e){setError(e.message);}
      finally{setOrganizing(false);}
    }
    async function addPicked(){
      const todos=result?.todos||[];
      // 已加入 = 这次刚加的（added）或服务端说你早就记过了（alreadyAdded）。
    // 后者是关键：刷新之后 added 丢了，没有它就会又出现一个能点的按钮。
    const isAdded=index=>!!added[index]||!!todos[index]?.alreadyAdded;
    const chosen=todos.map((item,index)=>index).filter(index=>picked[index]!==false&&!isAdded(index));
      if(!chosen.length||busy)return;
      setBusy(true);setError('');setNote('');
      try{
        // 服务端对「同来源 + 同标题 + 未完成」的重复会返回已存在的那条（deduped），
        // 这里照实说，不报一个虚的数量。
        let created=0;
        for(const index of chosen){
          const item=todos[index];
          const saved=await api('todos',{title:firstLine(item.title,60),detail:item.detail,source:'assistant',
            username:item.username||undefined,conversationTitle:item.conversation||undefined,kind:item.kind});
          if(!saved.deduped)created++;
        }
        setAdded(old=>{const next={...old};chosen.forEach(index=>{next[index]=true;});return next;});
        setNote(created
          ? ('已把 '+created+' 件加进待办'+(chosen.length>created?('（另外 '+(chosen.length-created)+' 件之前已经记过）'):''))
          : '这几件之前已经记过了，没有重复添加。');
        await home.refresh();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    async function finishTodo(todo){
      setBusy(true);setError('');
      try{await api('todos/'+todo.id+'/done',{});await home.refresh();}
      catch(e){setError(e.message);}finally{setBusy(false);}
    }
    /**
     * 「我知道了」：把这条提醒收起来。
     *
     * 以前这里只有「去处理」这个跳转，跳过去也点不了任何东西，于是提醒永远消不掉
     * （用户实测报的就是这个）。这是**看过**、不是**重试** —— 发送结果不确定的那条
     * 永远不会自动重发，这一点必须写在按钮旁边。
     */
    async function ackAutomation(item){
      if(busy||!item.ruleId)return;
      setBusy(true);setError('');setNote('');
      try{
        await api('automation/ack',{ruleId:item.ruleId});
        setNote('「'+(item.title||'这条')+'」的提醒已经收起来了。');
        await home.refresh();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    if(home.loading&&!data)return h(Empty,{title:'正在打开消息',text:'正在读取消息，请稍等一下…'});
    const waiting=data?.waiting||[],recent=data?.recent||[],todos=data?.todos||[],automation=data?.automation||[];
    const opened=new Set(waiting.map(session=>session.username));
    const others=recent.filter(session=>!opened.has(session.username));
    const list=(sessions)=>h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.bg,overflow:'hidden'}},
      sessions.map(session=>h(SessionRow,{key:session.username,session,
        onOpen:()=>openConversation(session.username,session.title,session.kind)})));
    const pagebar=h('div',{className:'lg-glass ma-pagebar'},
      h('div',{style:{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',minWidth:0}},
        h('h1',{style:{...h1,fontSize:20,margin:0}},'消息'),
        // 显示「最新消息」而不是「更新于」：扫描时间每轮都变，等于永远说「刚刚」，没信息量。
        data?.latestMessageAt?h('span',{style:{fontSize:12,color:C.text3}},'最新消息 '+relativeTime(data.latestMessageAt)):null),
      // 主操作只有一条：整理消息。读消息不再轮询（刷新页面=重新读一次用来初始化），
      // 整理要花 token，所以带冷却、不给连点。
      h('button',{onClick:organize,disabled:organizing||cooldown>0,
        title:cooldown>0?('刚整理过，'+cooldown+' 秒后可以再来一次'):'让助手读一遍消息，给出结论和待办建议',
        style:{...button(true),display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8}},
        organizing?h(Spinner,{size:14}):null,
        organizing?'正在整理…':'整理消息',
        cooldown>0?h('span',{style:{opacity:.75,fontSize:12}},'（'+cooldown+'s）'):null));
    const todoCard=h(HomeCard,{title:'待办',meta:'还没做完的 '+totals.todos+' 件',
      action:h('button',{onClick:()=>store.set({tab:'todos'}),style:small(false)},'全部待办')},
      h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.bg,overflow:'hidden'}},
        todos.map((todo,index)=>h('div',{key:todo.id,style:{display:'flex',gap:11,alignItems:'flex-start',padding:'12px 14px',borderTop:index?'1px solid '+C.border:'none'}},
          h(Checkbox,{checked:false,disabled:busy,label:'标记完成：'+firstLine(todo.title,20),
            onChange:()=>finishTodo(todo),style:{marginTop:3}}),
          h('div',{style:{flex:1,minWidth:0}},
            h('div',{style:{fontSize:14,color:C.text,lineHeight:1.6,wordBreak:'break-word'}},todo.title),
            todo.who&&h('div',{style:{fontSize:12,color:C.text3,marginTop:3}},'来自 '+todo.who))))));
    const automationCard=h(HomeCard,{title:'自动回复需要你看一眼',
      action:h('button',{onClick:()=>store.set({tab:'automation'}),style:small(false,false,true)},'自动回复设置')},
      h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.bg,overflow:'hidden'}},
        automation.map((item,index)=>h('div',{key:item.key||index,style:{padding:'12px 14px',borderTop:index?'1px solid '+C.border:'none'}},
          h('strong',{style:{fontSize:14,color:C.text}},item.title||'（未命名会话）'),
          item.reason&&h('div',{style:{fontSize:13,color:C.text2,marginTop:4,lineHeight:1.7}},item.reason),
          // 只有"某条记录没确认"这种才给按钮：规则自己被拦住是状态问题，标一句"看过了"
          // 也解决不了，那种情况给按钮只会让人点了没反应。
          item.acknowledgeable&&h('button',{onClick:()=>ackAutomation(item),disabled:busy,
            style:{...small(false),marginTop:9}},busy?'正在记…':'我知道了')))),
      h('p',{style:{...hint,margin:'10px 0 0'}},'「我知道了」只是把提醒收起来。没有确认发出的那条不会自动重发。'));
    const left=h('div',{style:{flex:narrow?'0 0 auto':'1 1 auto',minWidth:0,overflowY:narrow?'visible':'auto'}},
      h('div',{style:{padding:narrow?'18px 16px 26px':'24px clamp(18px,3vw,40px) 48px',maxWidth:940,margin:'0 auto',boxSizing:'border-box'}},
        pagebar,
        h(Notice,{error,dev:home.errorDev,code:home.errorCode}),
        h(Result,{text:note}),
        h(StatStrip,{totals}),
        !totals.conversations&&h(WeChatEmptyCard,{}),
        result?h(OrganizeResult,{result,busy:busy||organizing,picked,added,
          onCheck:(index,on)=>setPicked(old=>({...old,[index]:on})),
          onAdd:addPicked,onOpen:openConversation}):null,
        waiting.length?h(HomeCard,{title:'需要你回复',meta:'最后一条是对方发的，共 '+totals.waiting+' 个'},list(waiting)):null,
        todos.length?todoCard:null,
        others.length?h(HomeCard,{title:'最近有动静',meta:'按最后一条消息的时间排序'},list(others)):null,
        automation.length?automationCard:null));
    const chat=narrow
      ? h('div',{style:{borderTop:'1px solid '+C.border,paddingTop:6}},h(HomeChat,{narrow:true}))
      : h('div',{style:{width:400,flexShrink:0,borderLeft:'1px solid '+C.border,minHeight:0,display:'flex'}},h(HomeChat,{narrow:false}));
    return h('div',{style:{display:'flex',height:'100%',width:'100%',minWidth:0,
      flexDirection:narrow?'column':'row',overflowY:narrow?'auto':'hidden'}},left,chat);
  }

  /** 一个会话一次读多少条正文。见 ConversationView 里"为什么不分批"的说明。 */
  const CHAT_LIMIT=300;

  /**
   * 一个会话：明文副本里的正文 + 它身上的待办。
   *
   * 这里**没有**「读取这条会话」按钮：旧版那一步要打开微信聊天，会挤走用户正在看的那个
   * 会话、清掉未读红点，而读到的只有屏幕上的那几行。读取随取随用，所以直接给结果。
   */
  function ConversationView({store,username,title,kind,narrow}){
    // This state belongs to ONE conversation, which is why the caller renders this component
    // with `key={username}`. Without that key React reuses the instance when the user picks
    // another contact and the fetched rows, errors and scroll position follow them around.
    const detail=usePoller(true,()=>api('home/conversation?username='+encodeURIComponent(username)
      +'&title='+encodeURIComponent(title||'')+'&limit='+CHAT_LIMIT),0);
    const data=detail.data,messages=data?.messages||[];
    const back=()=>store.set({contactKey:null,contactTitle:null,contactKind:null});
    // 和聊天软件一样：打开就停在最新一条，往上翻才看历史。
    //
    // 一次把整窗读完（CHAT_LIMIT 条）而不是分批加载：本地读库本来就便宜，而分批会把
    // 滚动位置管理变成一堆状态机（拉取后要保持视野、判到底、防抖）。窗口用满时在顶部
    // 说明一句，用户就知道上面不是"卡住了"。
    const boxRef=useRef(null),pinnedRef=useRef(false);
    const [showJump,setShowJump]=useState(false),nearBottomRef=useRef(true);
    useEffect(()=>{
      const node=boxRef.current;
      if(!node||pinnedRef.current||!messages.length)return;
      node.scrollTop=node.scrollHeight;
      pinnedRef.current=true;
    },[messages.length]);
    /**
     * 往上翻时浮出一个"回到最新"的圆按钮。
     *
     * 只在**跨越阈值**时 setState：滚动事件一秒几十次，每次 setState 就是把 300 条消息
     * 重渲一遍。这里状态只跟"是否贴着底部"这个布尔走，翻历史时不触发任何渲染。
     */
    function onScroll(event){
      const node=event.currentTarget;
      const near=node.scrollHeight-node.scrollTop-node.clientHeight<160;
      if(near!==nearBottomRef.current){
        nearBottomRef.current=near;
        setShowJump(!near);
      }
    }
    function jumpToLatest(){
      const node=boxRef.current;
      if(node)node.scrollTo({top:node.scrollHeight,behavior:'smooth'});
      nearBottomRef.current=true;
      setShowJump(false);
    }
    // 拆成命名变量再拼：这一段原来是 8 层嵌套的 h() 调用，一个括号数错就会让滚动容器
    // 被塞进"不可收缩的页头"里 —— 页面看着在，滚不动（实测踩到过）。
    const header=h('div',{style:{flexShrink:0,padding:'14px clamp(16px,3vw,32px) 12px',borderBottom:'1px solid '+C.border,
      display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}},
      h('button',{onClick:back,title:'返回消息列表',style:{...small(false),flexShrink:0}},'返回'),
      h('h1',{style:{...h1,fontSize:19,margin:0,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},
        data?.identity?.title||title||username),
      h('span',{style:{...pill(kind==='group'?C.text3:C.brand),fontSize:12,flexShrink:0}},kind==='group'?'群聊':'单聊'),
      h('span',{style:{fontSize:12,color:C.text3}},messages.length?('最近 '+messages.length+' 条'):''));
    const body=h('div',{ref:boxRef,onScroll,style:{flex:1,minHeight:0,overflowY:'auto'}},
      h('div',{style:{maxWidth:840,margin:'0 auto',padding:narrow?'14px 14px 40px':'22px 32px 48px',boxSizing:'border-box'}},
        h(Notice,{error:detail.error,dev:detail.errorDev,code:detail.errorCode}),
        // 读满一窗时在顶部说明一句：让用户知道"上面没有了"，而不是以为界面卡住。
        messages.length>=CHAT_LIMIT&&h('p',{style:{...hint,textAlign:'center',margin:'0 0 10px'}},'只显示了最近 '+CHAT_LIMIT+' 条'),
        h('section',{style:card},
          h('h2',{style:{...h2,marginBottom:12}},'聊天记录'),
          !messages.length&&h('p',{style:{...hint,margin:0}},
            detail.loading?'正在读取…':'这段时间没有文字消息（可能都是图片、语音这类内容）。'),
          messages.map((message,index)=>h(React.Fragment,{key:String(message.sort_seq||index)},
            h(MessageDay,{message,previous:messages[index-1]}),
            h(MessageBubble,{message})))),
        data&&h(ConversationTodos,{key:data.conversationKey,conversationKey:data.conversationKey,
          todos:data.todos,onChanged:detail.refresh})));
    return h('div',{style:{position:'relative',display:'flex',flexDirection:'column',height:'100%',width:'100%',minWidth:0}},
      header,body,
      // 功能层：往上翻历史时浮出的"回到最新"。圆底是刻意的 —— 它悬在聊天气泡上，
      // 方形按钮在流动的内容里读不出"这是浮层"。
      showJump&&h('button',{onClick:jumpToLatest,className:'ma-jump',title:'回到最新消息','aria-label':'回到最新消息'},
        h(Icon,{name:'down',size:20})));
  }

  /**
   * 日期分隔条：跨天时插一行"9月19日"。
   *
   * 有了它，气泡上就能只写时分（今天）——否则每条都要写"9月19日 20:04"，噪音把对话压没了。
   * 这是"时间精确到分钟"能真正读得下去的前提。
   */
  function MessageDay({message,previous}){
    const at=message?.at||0;
    if(!at)return null;
    if(previous&&sameDay(new Date(previous.at*1000),new Date(at*1000)))return null;
    const date=new Date(at*1000),now=new Date();
    const label=sameDay(date,now)?'今天'
      :sameDay(date,dayStart(-1))?'昨天'
      :(date.getFullYear()!==now.getFullYear()?date.getFullYear()+'年':'')+(date.getMonth()+1)+'月'+date.getDate()+'日';
    return h('div',{style:{display:'flex',justifyContent:'center',margin:'14px 0 10px'}},
      h('span',{style:{fontSize:12,color:C.text3,padding:'3px 10px',borderRadius:99,background:FIELD_BG,border:'1px solid '+C.border}},label));
  }

  /** 一条聊天气泡。自己的靠右、对方的靠左 —— 用对齐方向区分，不靠颜色单独承载语义。 */
  function MessageBubble({message}){
    const mine=message.direction==='outgoing';
    return h('div',{style:{display:'flex',justifyContent:mine?'flex-end':'flex-start',marginBottom:8}},
      h('div',{style:{maxWidth:'78%',minWidth:0,padding:'9px 12px',borderRadius:'var(--lg-r-lg)',
        fontSize:14,lineHeight:1.7,whiteSpace:'pre-wrap',wordBreak:'break-word',
        border:'1px solid '+(mine?'transparent':'var(--lg-card-line)'),
        backgroundColor:mine?'var(--ma-primary-soft)':FIELD_BG,color:C.text}},
        message.content,
        // 语音还没转出来时**照样先把消息显示出来**（内容是 [语音]），只挂一句"转写中"——
        // 转写在后台排队做，页面不等它。等它写完，下次刷新这条就变成文字了。
        message.pending_voice?h('span',{style:{display:'block',fontSize:11,color:C.text3,marginTop:4}},
          '正在这台电脑上转成文字…'):null,
        h('span',{style:{display:'block',fontSize:11,color:C.text3,marginTop:4}},messageTime(message.at))));
  }

  /**
   * 会话页底部：这个人身上还没做完的待办。
   *
   * 这里**只做待办**。跟进记录与联系人资料属于 CRM，而产品里暂时没有 CRM —— 摆在那儿
   * 只会让"点进来看聊天记录"的人先撞上两块"还没有填写"（用户实测抱怨过两次）。
   * 真要做 CRM 的时候统一做，不在会话页里先长一半。
   *
   * 空的时候只留一行标题 + 一个「＋ 待办」，不写"没有未完成的待办"这类空话。
   */
  function ConversationTodos({conversationKey,todos:all=[],onChanged}){
    const [adding,setAdding]=useState(false);
    const [busy,setBusy]=useState(false),[error,setError]=useState('');
    const open=all.filter(todo=>todo.state!=='done'),done=all.filter(todo=>todo.state==='done');
    async function run(fn){
      setBusy(true);setError('');
      try{await fn();onChanged();}catch(e){setError(e.message);}finally{setBusy(false);}
    }
    function todoAction(action,todo,patch){
      if(action==='delete')return run(()=>api('todos/'+todo.id+'/delete',{}));
      // 改文案 / 改到期时间走同一条 PATCH 语义的路由（POST /api/todos/<id>）。
      if(action==='edit')return run(()=>api('todos/'+todo.id,{title:patch.title,dueAt:patch.dueAt}));
      if(action==='tomorrow')return run(()=>api('todos/'+todo.id+'/reopen',
        {dueAt:fromDateInput(toDateInput(dayStart(1))).toISOString()}));
      if(action==='reopen')return run(()=>api('todos/'+todo.id+'/reopen',{}));
      return run(()=>api('todos/'+todo.id+'/'+action,{}));
    }
    return h('section',{style:card},
      h(Notice,{error}),
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10}},
        h('h2',{style:{...h2,margin:0,fontSize:15}},'待办'),
        h('button',{onClick:()=>setAdding(value=>!value),disabled:busy,style:small(adding)},adding?'收起':'＋ 待办')),
      adding&&h('div',{style:{marginTop:12}},
        h(Composer,{mode:'todo',fixedMode:true,setMode:()=>{},busy,
          onSubmit:(_,text,dueAt)=>run(()=>api('todos',{conversationKey,title:text,dueAt,source:'manual'}))})),
      !!open.length&&h('div',{style:{marginTop:12,border:'1px solid '+C.border,borderRadius:12,background:C.bg,overflow:'hidden'}},
        open.map(todo=>h(TodoRow,{key:todo.id,todo,onAction:todoAction,busy}))),
      !!done.length&&h('details',{style:{marginTop:12}},
        h('summary',{style:{cursor:'pointer',fontSize:13,color:C.text3}},'已完成 '+done.length+' 件'),
        h('div',{style:{marginTop:8,border:'1px solid '+C.border,borderRadius:12,background:C.bg,overflow:'hidden'}},
          done.slice(0,8).map(todo=>h(TodoRow,{key:todo.id,todo,onAction:todoAction,busy})))));
  }
  function CrmSections({customerKey,identity,data,loading,error,onChanged}){
    const [busy,setBusy]=useState(false),[actionError,setActionError]=useState('');
    const [todoOpen,setTodoOpen]=useState(false),[followOpen,setFollowOpen]=useState(false);
    const [stage,setStage]=useState(''),[nextStep,setNextStep]=useState(''),[note,setNote]=useState(''),[saving,setSaving]=useState(false);
    const [showDone,setShowDone]=useState(false),[showAllFollow,setShowAllFollow]=useState(false);
    const customer=data?.customer;
    useEffect(()=>{if(!customer)return;setStage(customer.stage||'');setNextStep(customer.nextStep||'');setNote(customer.note||'');},[customer&&customer.updatedAt,customerKey]);
    const dirty=customer&&(stage!==(customer.stage||'')||nextStep!==(customer.nextStep||'')||note!==(customer.note||''));
    const todos=(data?.todos||[]).filter(todo=>todo.state!=='done'),doneTodos=(data?.todos||[]).filter(todo=>todo.state==='done');
    const followups=data?.followups||[];

    async function run(action){setBusy(true);setActionError('');try{await action();onChanged();}catch(e){setActionError(e.message);}finally{setBusy(false);}}
    const saveCustomer=()=>run(()=>api('customers/'+customerKey,{stage,nextStep,note}));
    const addTodo=(_,text,dueAt)=>run(()=>api('todos',{conversationKey:customerKey,title:text,dueAt,source:'manual'}));
    const addFollowup=(_,text)=>run(()=>api('customers/'+customerKey+'/followups',{kind:'记录',note:text}));
    const finish=todo=>run(()=>api('todos/'+todo.id+'/done',{}));
    const start=todo=>run(()=>api('todos/'+todo.id+'/doing',{}));
    const postpone=todo=>run(()=>api('todos/'+todo.id+'/reopen',{dueAt:fromDateInput(toDateInput(dayStart(1))).toISOString()}));
    const removeTodo=todo=>run(()=>api('todos/'+todo.id+'/delete',{}));

    function todoLine(todo,index){
      const due=dueInfo(todo.dueAt),doing=todo.state==='doing';
      return h('div',{key:todo.id,style:{display:'flex',gap:12,alignItems:'flex-start',padding:'12px 15px',borderTop:index?'1px solid '+C.border:'none'}},
        // 勾选框和「待办」页用的是同一个组件：同一个产品里"勾掉一件事"只该有一种样子。
        h(Checkbox,{checked:false,disabled:busy,label:'标记完成：'+firstLine(todo.title,20),onChange:()=>finish(todo),style:{marginTop:3}}),
        h('div',{style:{flex:1,minWidth:0}},
          h('div',{style:{fontSize:15,color:C.text,lineHeight:1.6,wordBreak:'break-word'}},todo.title),
          h('div',{style:{display:'flex',gap:8,marginTop:5,flexWrap:'wrap'}},
            doing&&h('span',{style:pill(C.brand)},'在做'),
            due&&h('span',{style:pill(due.color)},due.text),
            todo.source==='assistant'&&h('span',{style:{fontSize:13,color:C.text3}},'助手记的'))),
        h('div',{style:{display:'flex',gap:6,flexShrink:0}},
          doing?null:h('button',{onClick:()=>start(todo),disabled:busy,style:small(false)},'在做'),
          h('button',{onClick:()=>postpone(todo),disabled:busy,style:small(false)},'明天'),
          h('button',{onClick:()=>removeTodo(todo),disabled:busy,style:small(false,true)},'删除')));
    }

    if(loading&&!data)return h('p',{style:hint},'正在读取…');
    const summary=[stage,nextStep].filter(Boolean).join(' · ');
    return h('div',null,
      h(Notice,{error:actionError||error}),

      h(Section,{title:'待办',meta:todos.length?('未完成 '+todos.length+' 件'):'',action:h('button',{onClick:()=>setTodoOpen(value=>!value),style:small(!todoOpen)},todoOpen?'收起':'＋ 加一条待办')},
        todoOpen&&h(Composer,{mode:'todo',fixedMode:true,setMode:()=>{},busy,onSubmit:addTodo,onCancel:()=>setTodoOpen(false)}),
        !todos.length&&!todoOpen&&h('p',{style:hint},'没有未完成的待办。'),
        !!todos.length&&h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.panel,overflow:'hidden'}},todos.map(todoLine)),
        doneTodos.length?h('button',{onClick:()=>setShowDone(value=>!value),style:{...small(false,false,true),marginTop:8}},showDone?'收起已完成':'已完成 '+doneTodos.length+' 件'):null,
        showDone&&doneTodos.map((todo,index)=>h('div',{key:todo.id,style:{display:'flex',gap:10,padding:'9px 0',borderBottom:'1px solid '+C.border,color:C.text3,fontSize:14}},
          h('span',{style:{flex:1,minWidth:0,color:C.text3}},todo.title)))),

      h(Section,{title:'跟进记录',meta:followups.length?('共 '+followups.length+' 条'+(customer&&customer.lastFollowupAt?(' · 最近 '+relativeTime(customer.lastFollowupAt)):'')):'',
        action:h('button',{onClick:()=>setFollowOpen(value=>!value),style:small(!followOpen)},followOpen?'收起':'＋ 记一条')},
        followOpen&&h(Composer,{mode:'followup',fixedMode:true,setMode:()=>{},busy,onSubmit:addFollowup}),
        !followups.length&&!followOpen&&h('p',{style:hint},'还没有记录。'),
        !!followups.length&&h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.panel,overflow:'hidden'}},
          followups.slice(0,showAllFollow?50:3).map((item,index)=>h('div',{key:item.id,style:{padding:'13px 15px',borderTop:index?'1px solid '+C.border:'none'}},
            h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline'}},
              h('strong',{style:{fontSize:14,color:C.text}},item.kind==='助手摘要'?'助手总结':'跟进'),
              h('span',{style:{fontSize:13,color:C.text3}},relativeTime(item.createdAt))),
            h(LongText,{text:item.note}),
            item.evidence&&h('p',{style:{margin:'5px 0 0',fontSize:13,color:C.text3}},'依据：'+item.evidence))),
          followups.length>3&&h('button',{onClick:()=>setShowAllFollow(value=>!value),
            style:{...small(false,false,true),display:'block',width:'100%',textAlign:'left',borderTop:'1px solid '+C.border,borderRadius:0}},
            showAllFollow?'收起':'看全部 '+followups.length+' 条'))),

      h(Fold,{title:'联系人资料',meta:summary||'还没有填写'},
        h('div',{style:{display:'grid',gap:10}},
          h('div',null,h('label',{style:{display:'block',fontSize:13,color:C.text2,marginBottom:5}},'现在是什么关系/阶段'),
            h('input',{value:stage,onChange:event=>setStage(event.target.value),placeholder:'例如：朋友、家人、已报价、等回款',style:field})),
          h('div',null,h('label',{style:{display:'block',fontSize:13,color:C.text2,marginBottom:5}},'下一步'),
            h('input',{value:nextStep,onChange:event=>setNextStep(event.target.value),placeholder:'例如：周五前回他电话',style:field})),
          h('div',null,h('label',{style:{display:'block',fontSize:13,color:C.text2,marginBottom:5}},'备注'),
            h('textarea',{value:note,onChange:event=>setNote(event.target.value),rows:2,placeholder:'只有你自己看得到',style:{...field,resize:'vertical',lineHeight:1.7}})),
          h('div',null,h('button',{onClick:saveCustomer,disabled:saving||!dirty,style:small(true)},saving?'正在保存…':(dirty?'保存':'已保存'))))));
  }


  function RuleCard({rule,onAction,onTop}){
    const [editing,setEditing]=useState(false),[prompt,setPrompt]=useState(rule.prompt),[busy,setBusy]=useState(false),[error,setError]=useState('');
    useEffect(()=>{if(!editing)setPrompt(rule.prompt);},[rule.prompt,editing]);
    async function run(path,data){setBusy(true);setError('');try{await onAction(path,data);if(path==='edit')setEditing(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function remove(){if(!window.confirm('删除「'+rule.title+'」的自动回复吗？\n\n删除后会立即停止自动回复，历史发送记录和跟进记录都会保留。'))return;await run('delete',{id:rule.id});}
    // SQLite serializes this flag as 0/1. Treat it as a boolean here; strict `=== true`
    // made enabled rules look disabled and sent another enable request when clicked.
    const active=!!rule.enabled;
    return h('article',{style:{...card,padding:0,overflow:'hidden',height:'100%',minHeight:270,display:'flex',flexDirection:'column',boxSizing:'border-box'}},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:16,alignItems:'center',padding:'18px 20px 15px'}},
        // 这里原来放的是「名字首字母」方块。运行时拿不到微信头像，一个字母既不代表谁、
        // 也不能帮人辨认，纯粹是块噪音 —— 去掉，标题直接顶到左边。
        h('div',{style:{minWidth:0}},
          h('strong',{style:{display:'block',fontSize:16,color:C.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},rule.title),
          h('span',{style:{fontSize:12,color:C.text3}},rule.kind==='group'?'微信群聊':'微信联系人')),
        h(Toggle,{on:active,onClick:()=>run(active?'pause':'enable',{id:rule.id}),busy,label:active?'正在监听':'监听已关闭'})),
      error&&h('div',{style:{padding:'0 20px'}},h(Notice,{error})),
      editing?h('div',{style:{padding:'0 20px 18px',flex:1}},
        h('label',{style:fieldLabel},'希望助手怎样回复这个人？'),
        h('textarea',{value:prompt,onChange:event=>setPrompt(event.target.value),rows:5,style:{...field,resize:'vertical',lineHeight:1.7}}),
        h(StylePresetPicker,{disabled:busy,onPick:setPrompt,value:prompt}),
        h(RuleMemory,{rule}),
        h('p',{style:{...hint,marginTop:8}},'只对这个人生效。改完按新规矩继续回复，不用重新开启。'),
        h('div',{style:{display:'flex',gap:10}},
          h('button',{disabled:busy,onClick:()=>run('edit',{id:rule.id,prompt}),style:button(true)},busy?'正在保存…':'保存'),
          h('button',{disabled:busy,onClick:()=>{setEditing(false);setPrompt(rule.prompt);},style:button(false)},'取消')))
      :h(React.Fragment,null,
        // 卡片里用的是输入框那一层表面，不再是画布色 —— 画布色放进卡片里会显得"漏底"
        h('div',{style:{margin:'0 20px 16px',padding:'12px 14px',borderRadius:'var(--lg-r-md)',backgroundColor:FIELD_BG,border:'1px solid var(--lg-card-line)',flex:1,minHeight:94}},
          h('div',{style:{fontSize:11,color:C.text3,marginBottom:5,fontWeight:650,letterSpacing:'.04em'}},'回复规则'),
          h('p',{title:rule.prompt,style:{margin:0,color:C.text2,fontSize:13,lineHeight:1.75,whiteSpace:'pre-wrap',display:'-webkit-box',WebkitBoxOrient:'vertical',WebkitLineClamp:5,overflow:'hidden'}},rule.prompt)),
        rule.detail&&h('p',{style:{margin:'0 20px 14px',padding:'9px 11px',borderRadius:'var(--lg-r-sm)',background:'var(--ma-warning-soft)',color:C.warn,fontSize:12,lineHeight:1.65}},rule.detail),
        h('div',{style:{display:'flex',gap:8,flexWrap:'wrap',padding:'12px 20px',borderTop:'1px solid var(--lg-card-line)',marginTop:'auto'}},
          // 置顶：监听一多，把最重要的那条顶上去比拖拽准得多，也快得多。
          onTop&&h('button',{disabled:busy,onClick:onTop,style:small(false),title:'放到最前面'},'置顶'),
          h('button',{disabled:busy,onClick:()=>setEditing(true),style:small(false)},'编辑规则'),
          h('button',{disabled:busy,onClick:remove,style:{...small(false,true),marginLeft:'auto'}},'删除'))));
  }

  /**
   * 「添加自动回复」拆成两块：触发按钮（放进页面操作条）+ 表单（渲染在内容流里）。
   *
   * 原来两者是同一个组件，点开之后**表单长在玻璃条内部** —— 操作条是 flex + space-between，
   * 于是标题被挤到最左边、表单从中间开始，左侧留出一大片空白（实测被指出来过）。
   * 改成受控模式：open 由页面给，表单永远长在内容区，标题在上、字段在下。
   */
  /**
   * 助手对这个人记住了什么（读 / 不再记）。
   *
   * 为什么放在规则编辑里：目前只有自动回复在监听这个人，
   * 产品里也没有独立的"联系人列表"（用户明确说先放这里）。
   * 「不再记这条」走 resolve 而不是删库 —— 留着历史，只是不再进提示词。
   */
  const MEMORY_KIND_LABEL={fact:'事实',preference:'偏好',commitment:'答应过',open_loop:'未了的事',event:'事件'};
  function RuleMemory({rule}){
    const [open,setOpen]=useState(false);
    const [items,setItems]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
    async function load(){
      setBusy(true);setError('');
      try{
        const query='context/memory?provider='+encodeURIComponent(rule.provider||'wechat-main')
          +'&conversation='+encodeURIComponent(rule.conversation||'');
        const result=await api(query);
        setItems(result.items||[]);
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    async function drop(id){
      setBusy(true);setError('');
      try{await api('context/memory/'+encodeURIComponent(id)+'/resolve',{});await load();}
      catch(e){setError(e.message);setBusy(false);}
    }
    const alive=(items||[]).filter(item=>item.status!=='resolved');
    return h('div',{style:{marginTop:10}},
      h('button',{type:'button',disabled:busy,style:{...small(false),borderRadius:99},
        onClick:()=>{const next=!open;setOpen(next);if(next&&items===null)load();}},
        open?'收起「记住的事」':'助手记住了什么'),
      open&&h('div',{style:{marginTop:10,border:'1px solid '+C.border,borderRadius:10,padding:'10px 12px',background:C.panel}},
        items===null?h('p',{style:{...hint,margin:0}},busy?'正在读取…':'还没读过'):
          (alive.length?alive.map(item=>h('div',{key:item.id,style:{display:'flex',gap:10,
              alignItems:'flex-start',justifyContent:'space-between',padding:'6px 0'}},
              h('div',{style:{minWidth:0}},
                h('span',{style:{fontSize:11,color:C.text3,marginRight:6}},
                  MEMORY_KIND_LABEL[item.kind]||item.kind),
                h('span',{style:{fontSize:13,color:item.status==='confirmed'?C.text:C.text2}},item.content),
                item.status!=='confirmed'&&h('span',{style:{fontSize:11,color:C.text3,marginLeft:6}},'（还没确认，暂不参与回复）')),
              h('button',{type:'button',disabled:busy,onClick:()=>drop(item.id),
                style:{...small(false,false,true),flexShrink:0}},'不再记')))
            :h('p',{style:{...hint,margin:0}},'还没有记住什么。聊几句之后它会自己总结值得长期记的事。')),
        h('p',{style:{...hint,margin:'8px 0 0'}},
          '每次回复完，助手会在后台从对话里提炼值得长期记住的事（身份、偏好、答应过的事），下次回复时带上。'),
        h(Notice,{error})));
  }

  function AddContactTrigger({purpose,onOpen}){
    return h('button',{onClick:onOpen,style:button(true)},purpose==='crm'?'＋ 添加要跟进的联系人':'＋ 自动回复');
  }
  function AddContact({onAdded,purpose,open:openProp,onClose}){
    const controlled=openProp!==undefined;
    const [uncontrolled,setUncontrolled]=useState(false);
    const open=controlled?openProp:uncontrolled;
    const setOpen=value=>{if(controlled){if(!value&&onClose)onClose();}else setUncontrolled(value);};
    const [choices,setChoices]=useState([]),[conversation,setConversation]=useState(''),[prompt,setPrompt]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[kind,setKind]=useState('direct');
    // 群聊由本地会话的类型自动判定（微信里群聊的 username 一律以 @chatroom 结尾），
    // 换人选时自动跟着变。原来摆一个勾选框让用户自己声明类型，等于问一个数据已经回答了
    // 的问题；留一个「按群聊处理 / 按单聊处理」的纠正入口就够了。
    useEffect(()=>{
      const picked=choices.find(choice=>choice.id===conversation);
      if(picked)setKind(picked.kind==='group'?'group':'direct');
    },[conversation,choices]);
    async function add(){
      if(!conversation){setError('请先选择一个联系人或群聊');return;}
      setBusy(true);setError('');
      // 一个字都没写就确认 = 采用占位里那段默认规矩（否则用户会被后端拦住，而界面上没有必填提示）。
      const finalPrompt=prompt.trim()||'用自然、友好、简短的中文回复日常聊天；不确定的事情交给我处理。';
      try{await api('rules',{conversation_id:conversation,prompt:finalPrompt,kind});setConversation('');setPrompt('');onAdded();setOpen(false);}
      catch(e){setError(e.message);}finally{setBusy(false);}
    }
    const crm=purpose==='crm';
    if(!open)return h(AddContactTrigger,{purpose,onOpen:()=>setOpen(true)});
    return h('section',{className:'ma-form','aria-label':crm?'添加要跟进的联系人':'添加自动回复'},
      h('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16,marginBottom:18}},
        h('div',null,
          h('h3',{style:{...h3,marginBottom:5}},crm?'添加要跟进的联系人':'添加自动回复'),
          h('p',{style:{...hint,margin:0}},crm
            ?'在本地联系人里挑出要跟进的人。加进来只是让它出现在工作台，自动回复保持关闭。'
            :'两步：先选人，再写回复规则。添加后默认关闭，确认无误再开启。')),
        h('button',{onClick:()=>setOpen(false),disabled:busy,style:small(false,false,true)},'关闭')),
      h(Notice,{error}),
      h('div',{className:'ma-form-grid'},
        h('div',null,
          h('label',{style:fieldLabel},'1. 选择联系人或群聊'),
          h(ContactPicker,{value:conversation,onChange:setConversation,onLoaded:setChoices,disabled:busy}),
          !crm&&h('div',{style:{display:'flex',alignItems:'center',gap:10,marginTop:12,flexWrap:'wrap'}},
            h('span',{style:pill(kind==='group'?C.brand:C.text3)},kind==='group'?'群聊':'单聊'),
            h('button',{onClick:()=>setKind(kind==='group'?'direct':'group'),disabled:busy,style:small(false)},
              kind==='group'?'按单聊处理':'按群聊处理'),
            h('span',{style:{fontSize:12,color:C.text3}},'类型从本地会话自动识别，判断错了可以改'))),
        h('div',null,
          h('label',{style:fieldLabel},'2. 要自动回复的话，告诉助手怎么回'),
          h('textarea',{value:prompt,onChange:event=>setPrompt(event.target.value),rows:5,
            placeholder:'例如：用自然、友好、简短的中文回复日常聊天；不确定的事情交给我处理。',
            style:{...field,resize:'vertical',lineHeight:1.7}}),
          !crm&&h(StylePresetPicker,{disabled:busy,onPick:setPrompt,value:prompt}),
          h('p',{style:{...hint,marginTop:8}},crm?'不想让它自动回复也可以，保持关闭就行。':'每个联系人都可以写得不一样。加好即开始监听，想停就暂停。'))),
      h('div',{style:{display:'flex',gap:10,marginTop:18,paddingTop:16,borderTop:'1px solid var(--lg-card-line)'}},
        h('button',{onClick:add,disabled:busy,style:button(true)},busy?'请稍等…':'确认'),
        h('button',{onClick:()=>setOpen(false),disabled:busy,style:button(false)},'取消')));
  }

  // ---- 待办（原来叫「今天要做的」）-------------------------------------------
  // 这一页就是待办清单本身：**要做、在做、做完**都在这张单子上。
  //
  // 以前它是另一套东西 —— 会话可以被单独挂进这一页，另有一块由模型给消息打的分类
  // 拼出来的任务区。用户的实际感受是「今天要做的和待办有什么区别」「点了不知道是什么」。
  // 现在只有一条路：要做的事就记成待办，别的都不进这一页。
  /**
   * 一条待办。
   *
   * 三条界面约定，都是用户逐条提过之后定下来的：
   *  1. 完成的不画删除线（横线是"作废"的语义）；
   *  2. 完成的不再打「已完成」标签 —— 它既然列在「已完成」下面，状态本来就清楚，再标一遍
   *     是重复（原话「自然都是已完成的条目」）。但在别处（会话页）仍然要知道状态，所以
   *     胶囊只在**不是**已完成分组里才画：调用方用 `showState` 控制。
   *  3. 谁记下的（自己 / 助手）只用一个图标表示，不写字 —— 这条信息本来就不重要。
   */
  function TodoRow({todo,onAction,busy,showState=true}){
    const due=dueInfo(todo.dueAt),done=todo.state==='done',doing=todo.state==='doing';
    const fromAssistant=todo.source==='assistant';
    const sourceTitle=fromAssistant?'助手记的':'自己记的';
    // 双击改文案与到期时间。只对**没做完**的开放 —— 做完的已经是记录，改它没有意义。
    const [editing,setEditing]=useState(false),[draft,setDraft]=useState(''),[dueDraft,setDueDraft]=useState('');
    function startEdit(){
      setDraft(todo.title);setDueDraft(todo.dueAt?toDateTimeInput(new Date(todo.dueAt*1000)):'');
      setEditing(true);
    }
    function save(){
      const title=draft.trim();
      if(!title||busy)return;   // 空标题不提交（服务端也会拒），免得存出一条没名字的事
      // 空的日期 = 清掉到期时间（服务端把 '' 归一成 null）。
      onAction('edit',todo,{title,dueAt:dueDraft?fromDateTimeInput(dueDraft).toISOString():''});
      setEditing(false);
    }
    if(editing){
      return h('div',{style:{padding:'13px 15px',borderBottom:'1px solid '+C.border}},
        h('div',{style:{display:'flex',gap:8,alignItems:'center'}},
          h('input',{value:draft,autoFocus:true,onChange:event=>setDraft(event.target.value),
            onKeyDown:event=>{
              // Esc 只退出编辑，不能再往上冒泡 —— 全局那个监听会顺手把整个面板收起来
              // （实测："修改时按 Esc 直接退出了消息助手"）。
              if(event.key==='Escape'){event.stopPropagation();setEditing(false);}
              if(event.key==='Enter'){event.stopPropagation();save();}
            },
            'aria-label':'待办文案',style:{...field,flex:1,minWidth:0}}),
          h('button',{onClick:save,disabled:busy||!draft.trim(),style:small(true)},'保存'),
          h('button',{onClick:()=>setEditing(false),disabled:busy,style:small(false)},'取消')),
        h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:9,flexWrap:'wrap'}},
          h('span',{style:{fontSize:13,color:C.text2}},'到期时间'),
          h(DateTimeField,{value:dueDraft,onChange:setDueDraft,placeholder:'选择时间'}),
          dueDraft&&h('button',{onClick:()=>setDueDraft(''),disabled:busy,style:small(false)},'清除'),
          h('span',{style:{fontSize:12,color:C.text3}},'回车保存，Esc 取消')));
    }
    return h('div',{style:{display:'flex',gap:12,alignItems:'flex-start',padding:'13px 15px',borderBottom:'1px solid '+C.border}},
      h(Checkbox,{checked:done,disabled:busy,label:done?'重新打开：「'+firstLine(todo.title,20)+'」':'标记完成：「'+firstLine(todo.title,20)+'」',
        onChange:()=>onAction(done?'reopen':'done',todo),style:{marginTop:3}}),
      h('div',{style:{flex:1,minWidth:0}},
        // 双击改文案：这是待办页最常做的一件事（助手记的那条总要自己顺一遍语句），
        // 不该为此打开一个弹窗。做完的不可双击。
        h('div',{onDoubleClick:done?undefined:startEdit,title:done?undefined:'双击修改',
          style:{fontSize:15,color:done?C.text2:C.text,lineHeight:1.6,wordBreak:'break-word',cursor:done?'default':'text'}},todo.title),
        todo.detail&&todo.detail!==todo.title&&h('p',{style:{margin:'5px 0 0',fontSize:13,color:C.text2,lineHeight:1.7,whiteSpace:'pre-wrap',maxHeight:60,overflow:'hidden'}},todo.detail),
        // 第二行拆成两栏：左边是标签与来源，**右边固定放删除**。
        // 这样无论标题多长、detail 有几行、标签有多少个，删除入口都在同一位置、不会被挤掉
        // （用户实测：有第二行文案时，来源图标和删除都看不见了）。
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginTop:6}},
          h('div',{style:{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',minWidth:0}},
            showState&&done&&h('span',{style:pill(C.ok)},'已完成'),
            doing&&h('span',{style:pill(C.brand)},'在做'),
            !done&&due&&h('span',{style:pill(due.color)},due.text),
            // 没有到期时间的也要有个时间 —— 否则一条待办看起来"什么都没说"（用户实测报的）。
            // 记的是"什么时候记下来的"，不假装它是截止时间。
            !done&&!due&&todo.createdAt&&h('span',{style:{fontSize:12,color:C.text3}},'记于 '+relativeTime(todo.createdAt)),
            todo.identity&&h('span',{style:{fontSize:13,color:C.text3}},'来自 '+todo.identity.title),
            // 来源只给图标：13px 时用户看不清，现在 16px。
            h('span',{title:sourceTitle,'aria-label':sourceTitle,style:{display:'inline-flex',alignItems:'center',color:C.text3}},
              h(Icon,{name:fromAssistant?'spark':'person',size:16}))),
          done&&h('button',{onClick:()=>onAction('delete',todo),disabled:busy,className:'ma-iconbtn',
            title:'删除这条待办','aria-label':'删除这条待办',style:iconButton},h(Icon,{name:'trash',size:16})))),
      !done&&h('div',{style:{display:'flex',gap:6,flexShrink:0}},
        h('button',{onClick:()=>onAction(doing?'reopen':'doing',todo),disabled:busy,style:small(false)},doing?'放回待办':'在做'),
        h('button',{onClick:()=>onAction('tomorrow',todo),disabled:busy,style:small(false)},'明天'),
        h('button',{onClick:()=>onAction('delete',todo),disabled:busy,style:small(false,true)},'删除')));
  }

  function TodayPage({store,ctx}){
    const today=usePoller(true,()=>api('today'),0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[adding,setAdding]=useState(false);
    // 刚勾掉的那条立刻从界面上拿掉，不等下一次轮询。
    // 用户的原话是「点击处理完了，红点过好久才会消失」—— 服务端当场就写好了，只有界面在等。
    // 这一份本地遮盖在 refresh() 真正回来之后清掉，服务端永远是最终依据。
    const [gone,setGone]=useState({});
    const data=today.data,counts=data?.counts||{todos:0,confirm:0,overdue:0,attention:0,automation:0};
    async function act(action,entry,patch){
      setBusy(true);setError('');
      const id=entry.todoId;
      if(action==='done'||action==='delete')setGone(old=>({...old,[id]:true}));
      try{
        if(action==='done')await api('todos/'+id+'/done',{});
        else if(action==='doing')await api('todos/'+id+'/doing',{});
        else if(action==='reopen')await api('todos/'+id+'/reopen',{});
        else if(action==='tomorrow')await api('todos/'+id+'/reopen',{dueAt:fromDateInput(toDateInput(dayStart(1))).toISOString()});
        else if(action==='delete')await api('todos/'+id+'/delete',{});
        // 改文案 / 改到期时间：POST /api/todos/<id>（同一条路由，服务端按字段合并）。
        else if(action==='edit')await api('todos/'+id,{title:patch.title,dueAt:patch.dueAt});
        // 侧边栏那个红点也要当场少一个，否则"处理完了"之后它还挂着。
        if(action==='done'||action==='delete')store.set({pending:Math.max(0,(store.get().pending||0)-1)});
        await today.refresh();
      }catch(e){setError(e.message);}
      finally{setGone(old=>{const next={...old};delete next[id];return next;});setBusy(false);}
    }
    async function addTodo(_,text,dueAt){try{setAdding(false);await api('todos',{title:text,dueAt,source:'manual'});await today.refresh();}catch(e){setError(e.message);}}
    /**
     * 删掉一条**已完成**的待办。
     *
     * 它挂在「已完成」那一组里，走的不是 TodoRow 的 act()，所以自己来一遍同样的乐观隐藏：
     * 点一下先让它从界面上消失，接口回来再以服务端为准（原来这里只有状态标签，没有删除）。
     */
    /**
     * 删掉一条**已完成**的处理回执（助手处理过的消息 / 你标成已看的会话）。
     *
     * 它不是待办，删的是"这份清单上的这一行"，不影响任何事实数据（那条记录在消息助手里
     * 仍然存在）。和服务端的 dismissed 清单对应。
     */
    async function dismissReceipt(entry){
      if(!entry||busy)return;
      setBusy(true);setError('');
      try{await api('receipts/dismiss',{id:entry.id});await today.refresh();}
      catch(e){setError(e.message);}finally{setBusy(false);}
    }
    async function deleteDoneTodo(entry){
      const id=entry.todoId;
      if(!id||busy)return;
      setBusy(true);setError('');
      setGone(old=>({...old,[id]:true}));
      try{await api('todos/'+id+'/delete',{});await today.refresh();}
      catch(e){setError(e.message);}
      finally{setGone(old=>{const next={...old};delete next[id];return next;});setBusy(false);}
    }
    // 待办/草稿挂的是会话 key（sha256），而会话视图要的是 DB 身份（username）。
    // 服务端把 key 换回身份，本地不做任何猜测；换不到就只说没找到，不跳一个空页面。
    const go=async(key)=>{
      if(!key)return;
      try{
        const found=await api('home/lookup?key='+encodeURIComponent(key));
        store.set({tab:'home',contactKey:found.username,contactTitle:found.title,contactKind:found.kind});
      }catch(e){setError(e.message);}
    };
    const groups=(data?.groups||[]).map(group=>({...group,items:group.items.filter(entry=>!(entry.todoId&&gone[entry.todoId]))}));
    const total=counts.todos+counts.confirm;
    // 首次加载时先给一句"正在打开"，不要先摆出空列表：接口要等 Worker 一圈（实测 0.3–0.8s），
    // 这段时间里页面会显示"没有要做的事"，然后内容突然冒出来 —— 看起来既慢又是错的。
    if(today.loading&&!data)return h('div',{style:{width:'100%',display:'flex'}},
      h(Empty,{title:'正在打开待办',text:'请稍等一下…'}));
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:860,margin:'0 auto',boxSizing:'border-box'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:16,flexWrap:'wrap'}},
          h('div',null,
            h('h1',h1,'待办'),
            h('p',{style:{margin:'0 0 4px',color:C.text2,fontSize:14,lineHeight:1.8}},total?('还有 '+total+' 件要做。勾掉就完成，做完的收在下面。'):'没有要做的事了。')),
          h('button',{onClick:()=>setAdding(true),style:button(true)},'＋ 待办')),
        h(Notice,{error:error||today.error}),
        // 自动回复自己卡住了（规则被拦住 / 读不到微信）不是"分类"，是故障，用一行指路，
        // 不占一块任务区，也不参与红点计数。
        counts.automation>0&&h('div',{style:{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',padding:'10px 12px',borderRadius:10,background:RESULT_BG,borderLeft:'3px solid '+C.warn,marginBottom:14,fontSize:14,color:C.text}},
          h('span',null,'有 '+counts.automation+' 个自动回复需要你处理。'),
          h('button',{onClick:()=>store.set({tab:'automation'}),style:small(false)},'去自动回复看看')),
        counts.overdue>0&&h('p',{style:{margin:'0 0 16px',color:C.error,fontSize:14}},'其中 '+counts.overdue+' 件已经逾期，建议先处理。'),
        groups.filter(group=>group.key!=='handled').map(group=>{
          const items=group.key==='todos'&&adding?[...group.items,{id:'__new',kind:'new'}]:group.items;
          if(group.key==='confirm'&&!items.length)return null;
          return h('section',{key:group.key,style:{marginBottom:26}},
            h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,marginBottom:8}},
              h('h2',{style:{...h2,margin:0}},group.title+(items.length?(' · '+items.length+' 件'):'')),
              group.hint&&h('span',{style:{fontSize:13,color:C.text3}},group.hint)),
            !items.length&&h('p',{style:{...hint,padding:'10px 0'}},'还没有待办。点右上角「＋ 待办」，或者在「消息」里把一件事记成待办。'),
            !!items.length&&h('div',{style:{border:'1px solid '+C.border,borderRadius:14,background:C.panel,overflow:'hidden'}},
              items.map(entry=>{
                if(entry.kind==='new')return h('div',{key:'new',style:{padding:'13px 15px'}},h(Composer,{mode:'todo',fixedMode:true,setMode:()=>{},busy,onSubmit:addTodo,onCancel:()=>setAdding(false)}));
                if(entry.kind==='todo')return h(TodoRow,{key:entry.id,todo:entry,onAction:act,busy});
                const due=entry.expiresAt&&entry.expiresAt*1000<Date.now()+3600000;
                return h(Row,{key:entry.id,title:entry.title,right:relativeTime(entry.updatedAt),meta:entry.detail,
                  // 按钮这一行只放按钮，且按钮排在最前。联系人名字交给标题（服务端保证每行
                  // 标题都带名字），提醒类的标签排在按钮之后：任何可变宽度的东西放在按钮
                  // 前面，都会把每一行的按钮推到不同位置。
                  children:h('div',{style:{display:'flex',gap:10,alignItems:'center',marginTop:10,flexWrap:'wrap'}},
                    h('button',{onClick:()=>go(entry.conversationKey),style:small(true)},'去看草稿'),
                    due&&h('span',{style:pill(C.warn)},'快到时间了'))});
              })));
        }),
        (data?.groups||[]).filter(group=>group.key==='handled').map(group=>
          h('details',{key:group.key,style:{borderTop:'1px solid '+C.border,paddingTop:16,marginBottom:20}},
            h('summary',{style:{fontSize:15,color:C.text}},group.title+'（'+group.items.length+' 条）'),
            !group.items.length&&h('p',{style:hint},'还没有已处理的记录。'),
            group.items.map(entry=>{
              // 做过的事可能是"处理了某条消息"（有联系人），也可能是"做完了某件待办"
              // （可能根本没挂联系人）。所以标题要允许只有待办自身的文字。
              const title=(entry.identity&&entry.identity.title)||entry.title||'（未命名）';
              if(entry.todo){
                // 做完了的待办：**不再标一次「已完成」**（它就列在这一组里，状态本来就清楚），
                // 也不再写"你自己记下的一件待办"（啰嗦）。第二行两栏：左来源、右删除。
                // 删除固定在右侧，标题再长也不会把它挤没。
                const fromAssistant=entry.source==='assistant',sourceTitle=fromAssistant?'助手记的':'自己记的';
                return h(Row,{key:entry.id,title,right:relativeTime(entry.updatedAt),
                  meta:h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}},
                    h('span',{title:sourceTitle,'aria-label':sourceTitle,style:{display:'inline-flex',alignItems:'center',color:C.text3}},
                      h(Icon,{name:fromAssistant?'spark':'person',size:16})),
                    h('button',{onClick:()=>deleteDoneTodo(entry),disabled:busy,className:'ma-iconbtn',
                      title:'删除这条待办','aria-label':'删除这条待办',style:iconButton},h(Icon,{name:'trash',size:16})))});
              }
              return h(Row,{key:entry.id,title,right:relativeTime(entry.updatedAt),
                // 写清是谁处理掉的、处理成了什么样。「已处理」三个字既没说人也没说事，
                // 用户看完不知道助手到底做了什么（实测被问过"助手怎么处理呢"）。
                // 删除入口和待办那条一样钉在第二行右侧 —— 这两类回执（助手处理过的消息、
                // 你标成已看的会话）也要能删掉（用户实测报的就是它们没有删除图标）。
                meta:h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}},
                  h('span',{style:{minWidth:0,wordBreak:'break-word'}},
                    (entry.actor==='you'?'你':'助手')+' · '+firstLine(entry.detail||'处理完了',60)),
                  h('button',{onClick:()=>dismissReceipt(entry),disabled:busy,className:'ma-iconbtn',
                    title:'从已完成里移除','aria-label':'从已完成里移除',style:iconButton},h(Icon,{name:'trash',size:16})))});
            })))));
  }

  // ---- 联系人 ---------------------------------------------------------------------------------------------------------------------
  function CustomersPage({store,ctx}){
    const {customerKey}=useStore(store);
    const list=usePoller(true,()=>api('customers'),10000),items=list.data?.items||[];
    const current=items.find(entry=>entry.key===customerKey);
    const [actionError,setActionError]=useState('');
    async function removeCustomer(){
      if(!current)return;
      if(!window.confirm('删除「'+current.identity.title+'」？\n\n它的跟进记录和待办会一起删掉，不能恢复。自动回复规则不受影响。'))return;
      setActionError('');
      try{await api('customers/'+current.key+'/delete',{});store.set({customerKey:null});list.refresh();}
      catch(e){setActionError(e.message);}
    }
    const detail=usePoller(current?customerKey:false,signal=>fetch('/message-agent/api/customers/'+current.key,{signal}).then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'暂时无法读取资料');return data;}),10000);
    if(list.loading&&!list.data)return h(Empty,{title:'正在读取联系人',text:'请稍等一下…'});
    if(!items.length)return h(Empty,{title:'还没有要跟进的联系人',text:'把微信里要跟进的人加进来，之后每次沟通记一句，就有完整的跟进记录和待办清单。'},
      h(AddContact,{purpose:'crm',onAdded:list.refresh}),h(Notice,{error:list.error}));
    const counts=list.data?.counts||{};
    return h('div',{style:{display:'flex',height:'100%',width:'100%',minWidth:0}},
      h('section',{style:{width:340,flexShrink:0,borderRight:'1px solid '+C.border,display:'flex',flexDirection:'column'},'aria-label':'联系人列表'},
        h('header',{style:{padding:'18px 18px 12px',borderBottom:'1px solid '+C.border}},
          h('h1',{style:{...h1,fontSize:20}},'联系人'),
          h('p',{style:{margin:'0',fontSize:13,color:C.text3,lineHeight:1.7}},items.length+' 个人 · 未完成待办 '+(counts.open??0)+' 件'),
          h('div',{style:{marginTop:14}},h(AddContact,{purpose:'crm',onAdded:list.refresh}))),
        h('div',{style:{flex:1,overflowY:'auto'}},
          items.map(entry=>h(Row,{key:entry.key,title:entry.identity.title,right:entry.openTodos>0?(entry.openTodos+' 件待办'):'',
            meta:entry.nextStep?('下一步：'+entry.nextStep):(entry.stage||(entry.lastFollowupAt?'最近跟进 '+relativeTime(entry.lastFollowupAt):'还没有跟进记录')),
            active:customerKey===entry.key,onClick:()=>store.set({customerKey:entry.key})},
            h('div',{style:{display:'flex',gap:8,marginTop:8,flexWrap:'wrap'}},
              entry.stage&&h('span',{style:pill()},entry.stage),
              entry.identity.kind==='group'&&h('span',{style:pill()},'群聊')))))) ,
      (!current)
        ? h(Empty,{title:'选一个联系人',text:'左边点一个人，就能记录ta的近况、下一步、跟进和待办。'})
        : h('section',{style:{flex:1,overflowY:'auto',minWidth:0},'aria-label':current.identity.title+'的资料'},
            h('header',{style:{padding:'18px 20px',borderBottom:'1px solid '+C.border,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}},
              h('div',null,
                h('h2',{style:{margin:0,fontSize:20,color:C.text}},current.identity.title),
                h('p',{style:{margin:'4px 0 0',fontSize:13,color:C.text3}},(current.identity.kind==='group'?'微信群聊':'微信联系人')+(current.stage?(' · '+current.stage):''))),
              h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
                h('button',{onClick:()=>store.set({tab:'messages',contactKey:current.key}),style:button(false)},'去看聊天记录'),
                h('button',{onClick:removeCustomer,style:button(false,true)},'删除联系人'))),
            h('div',{style:{padding:'20px 20px 60px',maxWidth:780}},
              h(Notice,{error:actionError}),
              h(CrmSections,{key:current.key,customerKey:current.key,identity:current.identity,data:detail.data,loading:detail.loading,error:detail.error,onChanged:()=>{detail.refresh();list.refresh();}}))));
  }

  function AutomationPage(){
    const status=usePoller(true,()=>api('status'),5000);
    const settings=usePoller(true,()=>api('settings'),15000);
    const [saving,setSaving]=useState(false),[settingError,setSettingError]=useState(''),[acking,setAcking]=useState(false);
    // 「添加」表单的开关挂在页面这一层，不挂在操作条里面 —— 见 AddContact 的说明。
    const [adding,setAdding]=useState(false);
    async function action(path,data){await api(path,data);await status.refresh();}
    const rules=status.data?.rules||[];
    const activeRules=rules.filter(rule=>rule.enabled).length;
    const attentionJobs=rules.filter(rule=>rule.enabled&&['blocked','needs_user','waiting_connection'].includes(rule.status)).length;
    // 今天到底干了多少活。用户要的是"一眼看出它在工作、而且有产出"，所以按本地零点算今天，
    // 并把"回了"和"看过了没回"分开 —— 后者也是工作，但说清楚才不显得像没动。
    const todayLine=(()=> {
      const zero=new Date();zero.setHours(0,0,0,0);
      const from=zero.getTime()/1000;
      const done=(status.data?.jobs||[]).filter(job=>(job.finished_at||job.created_at||0)>=from);
      const replied=done.filter(job=>job.state==='sent').length;
      const skipped=done.filter(job=>['skipped','skip','done','cancelled','superseded'].includes(job.state)).length;
      const failed=done.filter(job=>['failed','uncertain','not_sent','expired'].includes(job.state)).length;
      return {total:done.length,replied,skipped,failed};
    })();
    /**
     * 拖拽排序。
     *
     * 拖动过程中只记"谁在拖、拖到谁身上"，**松手才落库** —— 每经过一格都发一次请求会把
     * 顺序写成一堆中间态，而列表每 5 秒轮询一次，中途刷新就白拖了。
     * 「置顶」是给"监听很多"时的另一条路：拖到第一位要精准，置顶只需要一次点击。
     */
    const [dragIndex,setDragIndex]=useState(null),[dropIndex,setDropIndex]=useState(null);
    const ghostRef=useRef(null);
    async function saveOrder(list){
      try{await api('rules/order',{ids:list.map(rule=>rule.id)});await status.refresh();}
      catch(e){setSettingError(e.message);}
    }
    function dropOn(index){
      clearGhost();
      const dragged=rules[dragIndex];
      if(!dragged||index===dragIndex){setDragIndex(null);setDropIndex(null);return;}
      const next=[...rules];
      next.splice(dragIndex,1);
      next.splice(index,0,dragged);
      setDragIndex(null);setDropIndex(null);
      saveOrder(next);
    }
    function moveToTop(id){
      const first=rules.find(rule=>rule.id===id);
      if(!first||rules[0]?.id===id)return;
      saveOrder([first,...rules.filter(rule=>rule.id!==id)]);
    }
    /**
     * 自己造一块不透明的拖动影像。
     *
     * 浏览器默认的影像是"按下那一刻的快照"，而卡片是**玻璃底**（半透明的
     * `--lg-card-bg`），跟着光标走的那一块几乎透光，字糊在页面上看不清（用户实测：
     * 「拖动时卡片没有背景，看不清文字」）。这里复制一份、垫上实底再交给 setDragImage。
     *
     * 垫实底是靠 `.ma-drag-ghost` 那两条规则（连子元素一起压成不透明）：只给最外层涂色
     * 不够，卡片自己的半透明底在它上面，照样透光。
     */
    function dragGhost(event){
      try{
        const node=event.currentTarget,rect=node.getBoundingClientRect();
        const ghost=node.cloneNode(true);
        ghost.className='ma-drag-ghost';
        ghost.style.position='fixed';ghost.style.top='-10000px';ghost.style.left='-10000px';
        ghost.style.width=rect.width+'px';ghost.style.height=rect.height+'px';ghost.style.margin='0';
        document.body.appendChild(ghost);
        event.dataTransfer.setDragImage(ghost,24,20);
        // **不要**用 setTimeout(…,0) 移除：Chrome 要等这一帧才真的去取影像，元素提前没了
        // 就退回默认快照（还是那张透光的卡片）—— 这正是"改了还是不清晰"的原因。留到松手再清。
        ghostRef.current=ghost;
      }catch{/* 自定义影像失败不影响拖动本身 */}
    }
    function clearGhost(){
      if(ghostRef.current){ghostRef.current.remove();ghostRef.current=null;}
    }
    // 「我知道了」：把这条规则上没确认的记录标成已看过，提醒就不再出现。
    // 首页那张「自动回复需要你看一眼」的卡片点进来之后，这里也得能处理 —— 否则跳过来
    // 什么都点不了，等于把提醒永久挂着（用户实测报的就是这个）。
    async function acknowledge(ruleId){
      if(!ruleId||acking)return;
      setAcking(true);setSettingError('');
      try{await api('automation/ack',{ruleId});await status.refresh();}
      catch(e){setSettingError(e.message);}finally{setAcking(false);}
    }
    // 已经点过「知道了」的记录不再出现 —— 它在首页那边是这么过滤的，自动回复页也必须一致，
    // 否则点了按钮记录还挂在这儿，用户以为没生效。
    const reviewedJobs=new Set(status.data?.reviewedJobs||[]);
    const visibleJobs=(status.data?.jobs||[]).filter(job=>!reviewedJobs.has(job.id));
    const renderJob=({count,job})=>h('div',{key:job.id,style:{display:'flex',gap:10,alignItems:'baseline',padding:'10px 0',borderTop:'1px solid '+C.border,fontSize:13}},
      h('span',{style:{...pill(job.state==='failed'||job.state==='uncertain'?C.error:C.ok),fontSize:11,padding:'2px 8px'}},JOB[job.state]||'已处理'),
      h('span',{style:{flex:1,minWidth:0,color:C.text2,lineHeight:1.6}},firstLine(job.text||job.detail||'',80)+(count>1?'（同类 '+count+' 条）':''),),
      (job.state==='failed'||job.state==='uncertain')&&h('button',{onClick:()=>acknowledge(job.rule_id),disabled:acking,
        style:{...small(false),flexShrink:0}},acking?'正在记…':'知道了'));
    const paused=settings.data?.settings?.auto_reply_paused===true;
    async function togglePaused(){
      setSaving(true);setSettingError('');
      try{await api('settings',{auto_reply_paused:!paused});settings.refresh();}
      catch(e){setSettingError(e.message);}finally{setSaving(false);}
    }    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{width:'100%',boxSizing:'border-box',padding:'28px clamp(24px,4vw,52px) 64px',maxWidth:1180,margin:'0 auto'}},
        // 英雄区：一块玻璃板，不再是绿色大色块。装饰圆换成很淡的品牌色，
        // 只当玻璃上的折射依据，不再当主视觉。
        h('section',{className:'lg-hero',style:{padding:'28px clamp(22px,4vw,38px)',marginBottom:20}},
          h('div',{style:{position:'relative',display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:22,flexWrap:'wrap'}},
            h('div',{style:{maxWidth:600}},
              // 状态徽章：一颗状态点 + 一行字，底是玻璃上的一层浅面 ——
              // 绿色只出现在这颗点上，不再铺满整块背景。
              h('div',{style:{display:'inline-flex',alignItems:'center',gap:8,padding:'5px 11px',borderRadius:99,
                backgroundColor:'var(--lg-inset-bg)',border:'1px solid var(--lg-edge)',fontSize:12,fontWeight:600,color:C.text2,marginBottom:13}},
                h('span',{style:{width:7,height:7,borderRadius:'50%',flexShrink:0,
                  background:activeRules?C.brand:C.text3,
                  boxShadow:activeRules?'0 0 0 3px rgba(7,193,96,.18)':'none'}},),
                activeRules?'助手正在值守':'等待开启第一条规则'),
              h('h1',{style:{...h1,color:C.text,fontSize:30,marginBottom:9}},
                activeRules?'消息助手正在为你工作':'消息助手在等你的第一条规则'),
              h('p',{style:{margin:0,color:C.text2,fontSize:14,lineHeight:1.8}},
                activeRules
                  ?(todayLine.total
                    ?('今天处理了 '+todayLine.total+' 条消息，其中替你回复 '+todayLine.replied+' 条'
                      +(todayLine.skipped?('、看过没回 '+todayLine.skipped+' 条'):'')+'。'
                      +(attentionJobs?('还有 '+attentionJobs+' 件需要你看一眼。'):'没有需要你处理的事。'))
                    :'正在盯着你选中的联系人和群聊，有该回复的会先写出来再发。')
                  :'从右边「＋ 新规则」开始：选一个联系人或群聊，剩下的交给它。')),
            h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
              [[String(todayLine.total),'今天处理'],[String(todayLine.replied),'已回复'],[String(attentionJobs),'需处理']].map(([value,label])=>
                h('div',{key:label,className:'lg-chip',style:{minWidth:78,padding:'10px 13px'}},
                  h('strong',{style:{display:'block',fontSize:21,lineHeight:1.15,color:C.text}},value),
                  h('span',{style:{fontSize:11,color:C.text2}},label)))))),
        h(Notice,{error:settingError||status.error}),
        // 功能层：页面级操作条。它 sticky 在滚动区顶部，卡片从它背后穿过去 ——
        // 这一条是整页里最能看出玻璃材质的地方。
        //
        // 这里**刻意不加** data-liquid-glass：它 sticky 在滚动容器里，每一帧滚动都要重跑
        // 一遍位移滤镜链。实测（1440×900 无头 Chromium）加了折射中位帧 70ms、p95 140ms，
        // 约 14fps 的拖影；撤掉折射后中位帧 16.7ms，满帧。
        // 折射是享受不是信息，代价这么大就不值得 —— 它只留给静止不动的导航轨。
        h('div',{className:'lg-glass ma-pagebar'},
          h('div',null,h('h2',{style:{...h2,fontSize:18,marginBottom:3}},'回复对象'),
            h('p',{style:{...hint,margin:0}},'添加后默认暂停，确认规则再开启。拖动卡片可以调整顺序，最重要的放最上面。')),
          h(AddContactTrigger,{onOpen:()=>setAdding(true)})),
        // 表单渲染在内容流里：标题在上、字段在下。它不再长在操作条内部（那样会挤出一片空白）。
        // 只在展开时渲染 —— 关闭态下 AddContact 会返回触发按钮，留着就会和操作条里那个重复。
        adding&&h(AddContact,{open:true,onClose:()=>setAdding(false),onAdded:status.refresh}),
        status.loading&&!status.data&&h('p',{style:hint},'正在读取自动回复规则…'),
        !status.loading&&!rules.length&&h('section',{style:{...card,textAlign:'center',padding:'34px 24px',boxShadow:'none',borderStyle:'dashed'}},
          h('div',{style:{width:48,height:48,borderRadius:15,margin:'0 auto 12px',display:'flex',alignItems:'center',justifyContent:'center',background:C.hover,color:C.brand}},h(Icon,{name:'automation',size:24})),
          h('strong',{style:{display:'block',fontSize:16,color:C.text,marginBottom:6}},'还没有自动回复规则'),
          h('span',{style:{fontSize:13,color:C.text3}},'从一个重复咨询最多的联系人或群聊开始。')),
        !!rules.length&&h('div',{className:'ma-rule-grid',style:{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:16,alignItems:'stretch'}},
          rules.map((rule,index)=>h('div',{
            key:rule.id,draggable:true,
            onDragStart:event=>{setDragIndex(index);event.dataTransfer.effectAllowed='move';
              try{event.dataTransfer.setData('text/plain',rule.id);}catch{/* 老浏览器不支持就算了 */}
              dragGhost(event);},
            onDragOver:event=>{if(dragIndex===null)return;event.preventDefault();if(dropIndex!==index)setDropIndex(index);},
            onDragLeave:()=>{if(dropIndex===index)setDropIndex(null);},
            onDrop:event=>{event.preventDefault();dropOn(index);},
            onDragEnd:()=>{clearGhost();setDragIndex(null);setDropIndex(null);},
            // 被拖的那张：**垫实底、不淡化**。卡片自己是玻璃底，一淡化就糊在页面上读不了。
            // 落点用实线 + 品牌色，和"被拖的虚线"分开，两者不会看错。
            style:{
              ...(dragIndex===index?{backgroundColor:'var(--ma-surface)',
                outline:'2px dashed '+C.brand,outlineOffset:3,borderRadius:'var(--lg-r-lg)'}:null),
              ...(dropIndex===index&&dragIndex!==null?{backgroundColor:'var(--ma-surface)',
                outline:'2px solid '+C.brand,outlineOffset:3,borderRadius:'var(--lg-r-lg)'}:null)}},
            h(RuleCard,{rule,onAction:action,onTop:()=>moveToTop(rule.id)})))),
        h('section',{style:{...card,display:'flex',justifyContent:'space-between',alignItems:'center',gap:16,flexWrap:'wrap',marginTop:22,boxShadow:'none'}},
          h('div',{style:{display:'flex',gap:12,alignItems:'center',minWidth:240,flex:1}},
            h('span',{style:{width:38,height:38,borderRadius:12,display:'flex',alignItems:'center',justifyContent:'center',background:'var(--ma-warning-soft)',color:C.warn}},h(Icon,{name:'settings',size:18})),
            h('div',null,h('strong',{style:{display:'block',fontSize:14,color:C.text}}, '自动回复值守'),
              h('span',{style:{fontSize:12,color:C.text3,lineHeight:1.65}},'关闭后暂停自动回复：不再读取新消息、不生成也不发送回复，随时可恢复。'))),
          h(Toggle,{on:!paused,onClick:togglePaused,busy:saving,disabled:!settings.data,label:!paused?'值守中':'已暂停'})),
        !!status.data?.jobs?.length&&h('details',{style:{...card,marginTop:14,boxShadow:'none'}},
          h('summary',{style:{cursor:'pointer',fontSize:14,fontWeight:650,color:C.text}},'最近处理记录'),
          h('div',{style:{marginTop:12}},
            foldJobRuns(visibleJobs).slice(0,15).map(renderJob)))));
  }

  // ---- 回复配置：说话方式 + 知识库 ----------------------------------------
  const PROFILE_STATUS={draft:'草稿',active:'使用中',retired:'已停用'};
  const KNOWLEDGE_STATUS={draft:'草稿',published:'已发布',retired:'已停用'};
  const KNOWLEDGE_KINDS=[['faq','常见问题'],['product_usage','产品说明'],['policy','政策规则'],['playbook','话术流程'],['other','其他']];
  const KNOWLEDGE_RISK=[['low','低风险'],['medium','中风险'],['high','高风险']];
  function toLines(text){return String(text||'').split('\n').map(part=>part.trim()).filter(Boolean);}

  function ProfileForm({initial,onDone,onCancel}){
    const [name,setName]=useState(initial?.name||''),[address,setAddress]=useState(initial?.rules?.addressRule||'');
    const [hard,setHard]=useState((initial?.rules?.hard||[]).join('\n')),[pref,setPref]=useState((initial?.rules?.preference||[]).join('\n'));
    const [banned,setBanned]=useState((initial?.rules?.bannedExpressions||[]).join('\n'));
    const [busy,setBusy]=useState(false),[error,setError]=useState('');
    async function save(){
      if(!name.trim()){setError('先给这种说话方式起个名字');return;}
      const rules={addressRule:address.trim(),hard:toLines(hard),preference:toLines(pref),bannedExpressions:toLines(banned)};
      setBusy(true);setError('');
      try{
        if(initial)await mutate('context/profiles/'+initial.id,'PATCH',{name:name.trim(),rules,expectedRevision:initial.revision});
        else await api('context/profiles',{name:name.trim(),rules});
        onDone();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    const label=fieldLabel;   // 统一走控件基线里的标签，别再各写一套字号
    return h('div',{style:{...card,padding:16}},
      h('label',{style:label},'名称'),h('input',{value:name,onChange:event=>setName(event.target.value),placeholder:'例如：朋友、客户服务、销售',style:field}),
      h('div',{style:{display:'grid',gap:12,marginTop:12}},
        h('div',null,h('label',{style:label},'称呼规则（可选）'),h('input',{value:address,onChange:event=>setAddress(event.target.value),placeholder:'例如：叫对方名字，不叫「您」',style:field})),
        h('div',null,h('label',{style:label},'硬性要求（每行一条，必须遵守）'),h('textarea',{value:hard,onChange:event=>setHard(event.target.value),rows:2,placeholder:'例如：\n不要用「亲」\n不承诺发货时间',style:{...field,resize:'vertical',lineHeight:1.7}})),
        h('div',null,h('label',{style:label},'风格偏好（每行一条，尽量做到）'),h('textarea',{value:pref,onChange:event=>setPref(event.target.value),rows:2,placeholder:'例如：\n简短、口语化\n多用问句',style:{...field,resize:'vertical',lineHeight:1.7}})),
        h('div',null,h('label',{style:label},'禁用表达（每行一条，命中了就交给你）'),h('textarea',{value:banned,onChange:event=>setBanned(event.target.value),rows:2,placeholder:'例如：\n保证到账\n肯定能退',style:{...field,resize:'vertical',lineHeight:1.7}})),
      h(Notice,{error}),
      h('div',{style:{display:'flex',gap:10,marginTop:12}},
        h('button',{onClick:save,disabled:busy,style:button(true)},busy?'正在保存…':(initial?'保存修改':'创建')),
        initial&&h('button',{onClick:onCancel,disabled:busy,style:button(false)},'取消'))));
  }

  function ProfileCard({p,onAct}){
    const [editing,setEditing]=useState(false);
    const hard=p.rules?.hard||[],pref=p.rules?.preference||[],banned=p.rules?.bannedExpressions||[];
    if(editing)return h(ProfileForm,{initial:p,onDone:()=>{setEditing(false);onAct(()=>Promise.resolve());},onCancel:()=>setEditing(false)});
    return h('article',{style:card},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}},
        // 标题和「第 N 版」原来是一个块里两个行内元素，中间没有任何间隙，挤成一团。
        // 改成 flex 行 + 10px 间距 + 基线对齐：版本号是次要信息，要退到右侧一点。
        h('div',{style:{display:'flex',alignItems:'baseline',gap:10,minWidth:0,flexWrap:'wrap'}},
          h('strong',{style:{fontSize:17,color:C.text}},p.name),
          h('span',{style:{fontSize:13,color:C.text3,flexShrink:0}},'第 '+p.revision+' 版')),
        h('span',{style:pill(p.status==='active'?C.ok:p.status==='retired'?null:C.warn)},PROFILE_STATUS[p.status]||p.status)),
      p.rules?.addressRule&&h('p',{style:{margin:'10px 0 0',color:C.text2,fontSize:14}},'称呼：'+p.rules.addressRule),
      hard.length>0&&h('p',{style:{margin:'8px 0 0',color:C.text2,fontSize:14,lineHeight:1.7}},'硬性要求：'+hard.join('；')),
      pref.length>0&&h('p',{style:{margin:'6px 0 0',color:C.text3,fontSize:13,lineHeight:1.6}},'风格：'+pref.join('；')),
      banned.length>0&&h('p',{style:{margin:'6px 0 0',color:C.text3,fontSize:13,lineHeight:1.6}},'禁用：'+banned.join('；')),
      h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',marginTop:14}},
        p.status!=='active'&&h('button',{onClick:()=>onAct(()=>api('context/profiles/'+p.id+'/activate',{})),style:small(true)},'启用'),
        p.status==='active'&&h('button',{onClick:()=>onAct(()=>api('context/profiles/'+p.id+'/retire',{})),style:small(false)},'停用'),
        h('button',{onClick:()=>onAct(()=>api('context/profile-bindings',{profileId:p.id,scopeType:'default',scopeKey:'default'})),style:small(false)},'设为默认'),
        h('button',{onClick:()=>setEditing(true),style:small(false)},'编辑')));
  }

  function AnalyzeStylePanel({onDone}){
    // 选人交给 ContactPicker（和「添加自动回复」同一个组件）：加载本地联系人、搜索都归它，
    // 这里不再自己读一遍会话列表 —— 同一件事写两遍就会长歪（原来这里的"搜索"和那边的
    // "重新读取微信"就是各写各的）。
    const [choices,setChoices]=useState([]),[conversation,setConversation]=useState('');
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[errorCode,setErrorCode]=useState(''),[result,setResult]=useState(null);
    async function analyze(){
      const selected=choices.find(c=>c.id===conversation);
      if(!selected){setError('请先选一个会话');return;}
      setBusy(true);setError('');setErrorCode('');
      try{
        const r=await api('context/profiles/analyze',{provider:'wechat-main',conversation:selected.id});
        setResult(r);
      }catch(e){setErrorCode(e.code||'');setError(e.message);}
      finally{setBusy(false);}
    }
    const selected=choices.find(c=>c.id===conversation);
    return h('div',{style:{...card,padding:20,boxShadow:'var(--lg-card-shadow)',borderColor:'rgba(7,193,96,.26)'}},
      h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:6}},
        h('div',{style:{fontSize:16,fontWeight:700,color:C.text}},'从聊天分析说话方式'),
        h('span',{style:{...pill(C.ok),background:'var(--ma-success-soft)',fontSize:11}},'后台只读 · 不发消息')),
      h('p',{style:{...hint,margin:'0 0 18px',maxWidth:720}},'助手只学习你发出去的消息，生成一份可编辑的语气草稿；你确认并启用后，才会用于自动回复。'),
      h(Notice,{error,code:errorCode}),
      h('label',{style:fieldLabel},'选择一个会话'),
      h(ContactPicker,{value:conversation,onChange:setConversation,onLoaded:setChoices,disabled:busy}),
      busy&&h('div',{role:'status',style:{display:'flex',alignItems:'center',gap:12,marginTop:12,padding:'13px 15px',borderRadius:12,background:'var(--ma-primary-soft)',color:C.brand}},
        h('strong',{style:{fontSize:20,minWidth:24,textAlign:'center'}},'…'),
        h('div',null,h('strong',{style:{display:'block',fontSize:13}},'正在后台读取聊天'),
          h('span',{style:{display:'block',fontSize:12,marginTop:2}},'可以留在当前页面；只读取，不会发送消息'))),
      result&&h('div',{style:{marginTop:12,border:'1px solid var(--lg-card-line)',borderRadius:'var(--lg-r-md)',padding:14,backgroundColor:FIELD_BG}},
        h('div',{style:{fontSize:14,color:C.text,marginBottom:6}},'已生成「'+result.profile.name+'」（草稿，确认后启用）'),
        result.summary&&h('p',{style:{margin:0,fontSize:14,color:C.text2,lineHeight:1.7}},result.summary),
        (result.profile.rules?.preference||[]).length>0&&h('p',{style:{margin:'6px 0 0',fontSize:13,color:C.text3,lineHeight:1.7}},'风格：'+(result.profile.rules.preference.join('；'))),
        h('button',{onClick:onDone,style:{...small(true),marginTop:10}},'去查看并确认')),
      !result&&h('div',{style:{display:'flex',gap:10,marginTop:12,flexWrap:'wrap'}},
        h('button',{onClick:analyze,disabled:busy||!conversation,style:button(true)},error?'重新分析':'开始分析'),
        h('button',{onClick:onDone,disabled:busy,style:button(false)},busy?'正在读取…':'取消')));
  }

  function ProfilesSection({data,refresh}){
    const [open,setOpen]=useState(false),[analyzeOpen,setAnalyzeOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const items=data?.items||[];
    const act=async fn=>{setBusy(true);setError('');try{await fn();refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
    return h('section',{style:{marginBottom:34}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,marginBottom:12}},
        h('div',null,h('h2',{style:{...h2,margin:0}},'说话方式'),h('span',{style:{fontSize:13,color:C.text3}},'控制助手怎么说话、禁用哪些词')),
        h('div',{style:{display:'flex',gap:8,flexShrink:0}},
          h('button',{onClick:()=>{setAnalyzeOpen(value=>!value);setOpen(false);},style:small(!analyzeOpen)},analyzeOpen?'收起':'从聊天分析'),
          h('button',{onClick:()=>{setOpen(value=>!value);setAnalyzeOpen(false);},style:small(!open)},open?'收起':'＋ 新建'))),
      h(Notice,{error}),
      analyzeOpen&&h(AnalyzeStylePanel,{onDone:()=>{setAnalyzeOpen(false);refresh();}}),
      open&&h(ProfileForm,{onDone:()=>{setOpen(false);refresh();}}),
      !items.length&&!open&&!analyzeOpen&&h('p',{style:hint},'还没有说话方式。留空就用通用方式；点「从聊天分析」让助手从你聊过的话里学一个，或「＋ 新建」手写。'),
      items.map(p=>h(ProfileCard,{key:p.id,p,onAct:act})));
  }

  // 拖入的文件要能直接读。纯文本类浏览器自己就能读；.docx 其实是个 zip，
  // 用 DecompressionStream 解出 word/document.xml 即可，不必绕到后端。
  async function readDocxText(file){
    const bytes=new Uint8Array(await file.arrayBuffer()),view=new DataView(bytes.buffer);
    let eocd=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-66000);i--){if(view.getUint32(i,true)===0x06054b50){eocd=i;break;}}
    if(eocd<0)throw new Error('不是有效的 docx 文件');
    const total=view.getUint16(eocd+10,true);
    let offset=view.getUint32(eocd+16,true);
    for(let n=0;n<total;n++){
      if(view.getUint32(offset,true)!==0x02014b50)break;
      const method=view.getUint16(offset+10,true),size=view.getUint32(offset+20,true);
      const nameLen=view.getUint16(offset+28,true),extraLen=view.getUint16(offset+30,true),commentLen=view.getUint16(offset+32,true);
      const localOffset=view.getUint32(offset+42,true);
      const name=new TextDecoder().decode(bytes.subarray(offset+46,offset+46+nameLen));
      if(name==='word/document.xml'){
        const lNameLen=view.getUint16(localOffset+26,true),lExtraLen=view.getUint16(localOffset+28,true);
        const start=localOffset+30+lNameLen+lExtraLen,data=bytes.subarray(start,start+size);
        if(method===0)return new TextDecoder().decode(data);
        const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return await new Response(stream).text();
      }
      offset+=46+nameLen+extraLen+commentLen;
    }
    throw new Error('docx 里没找到正文');
  }
  function docxXmlToText(xml){
    return String(xml)
      .replace(/<w:tab[^>]*\/>/g,'\t').replace(/<w:br[^>]*\/>/g,'\n')
      // 段落之间留空行，切分器才有分段的依据；否则整篇会挤成一条。
      .replace(/<\/w:p>/g,'\n\n').replace(/<[^>]+>/g,'')
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&')
      .split('\n').map(line=>line.trim()).join('\n').replace(/\n{3,}/g,'\n\n').trim();
  }

  // 批量导入：知识库多半早就写好了（文档、在线文档、网站条款），一条条手敲不现实。
  // 粘贴文本、拖入文件、或填一个网址 → 自动切分成多条草稿 → 先预览再入库。
  function KnowledgeImport({onDone,onCancel}){
    const [raw,setRaw]=useState(''),[kind,setKind]=useState('faq'),[risk,setRisk]=useState('low');
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState(null);
    const [dragOver,setDragOver]=useState(false),[fileNote,setFileNote]=useState('');
    const [splitMode,setSplitMode]=useState('auto');
    const isUrl=/^https?:\/\/\S+$/i.test(raw.trim());
    async function acceptFiles(files){
      const list=[...(files||[])].filter(file=>file&&file.size>0);
      if(!list.length)return;
      setError('');setPreview(null);
      const parts=[],skipped=[];
      for(const file of list.slice(0,8)){
        const ext=(String(file.name).split('.').pop()||'').toLowerCase();
        try{
          if(/^(md|markdown|txt|csv|tsv|json|log|ya?ml|xml|html?)$/.test(ext))parts.push(await file.text());
          else if(ext==='docx')parts.push(docxXmlToText(await readDocxText(file)));
          else skipped.push(file.name);
        }catch(e){skipped.push(file.name);}
      }
      if(parts.length)setRaw(prev=>[prev,parts.join('\n\n')].filter(Boolean).join('\n\n'));
      setFileNote(parts.length?('已读入 '+parts.length+' 个文件，可以继续拖或直接预览'):'');
      if(skipped.length)setError('这些文件读不了，请把正文复制粘贴进来：'+skipped.join('、')+'（支持 md / txt / csv / json / docx）');
    }
    async function run(dry,modeOverride){
      if(!raw.trim()){setError('先粘贴内容、拖入文件，或填一个网址');return;}
      setBusy(true);setError('');
      try{
        const source=isUrl?{url:raw.trim()}:{text:raw};
        const result=await api('context/knowledge/import',{...source,kind,riskLevel:risk,dryRun:dry,mode:modeOverride||splitMode});
        if(dry)setPreview(result);else onDone(result);
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    const label=fieldLabel;   // 统一走控件基线里的标签，别再各写一套字号
    return h('div',{style:{...card,padding:16}},
      h('div',{style:{fontSize:16,color:C.text}},'把已有的资料导进来'),
      h('p',{style:{...hint,margin:'6px 0 12px'}},'拖入文件、粘贴一大段文字，或者只贴一个网页/在线文档的网址。会按标题、空行、列表自动切成多条；导入后都是草稿，确认无误再发布。'),
      h('div',{
        onDragOver:event=>{event.preventDefault();setDragOver(true);},
        onDragLeave:()=>setDragOver(false),
        onDrop:event=>{event.preventDefault();setDragOver(false);acceptFiles(event.dataTransfer&&event.dataTransfer.files);},
        style:{border:'1px dashed '+(dragOver?C.brand:C.border),borderRadius:12,padding:12,background:dragOver?C.hover:'transparent'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:10}},
          h('span',{style:{fontSize:14,color:dragOver?C.text:C.text2}},dragOver?'松手就读进来':'把文件拖到这里（支持 md / txt / csv / json / docx）'),
          h('label',{style:{...small(false),display:'inline-flex',alignItems:'center',cursor:'pointer'}},
            '选择文件',
            h('input',{type:'file',multiple:true,accept:'.md,.markdown,.txt,.csv,.tsv,.json,.log,.yml,.yaml,.xml,.html,.htm,.docx',
              onChange:event=>{acceptFiles(event.target.files);event.target.value='';},style:{display:'none'}}))),
        h('textarea',{value:raw,onChange:event=>{setRaw(event.target.value);setPreview(null);setFileNote('');},rows:8,
          placeholder:'也可以直接粘贴：产品说明、常见问答、政策条款、话术……\n\n或者只填一个网址（https://…），我会去抓正文',
          style:{...field,resize:'vertical',lineHeight:1.7}}),
        fileNote&&h('p',{style:{...hint,marginTop:8}},fileNote)),
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginTop:12}},
        h('div',null,h('label',{style:fieldLabel},'这些条目统一归到'),h(Select,{value:kind,onChange:setKind,ariaLabel:'统一归类',groups:[{items:KNOWLEDGE_KINDS.map(([value,text])=>({value,label:text}))}]})),
        h('div',null,h('label',{style:fieldLabel},'统一风险等级'),h(Select,{value:risk,onChange:setRisk,ariaLabel:'统一风险等级',groups:[{items:KNOWLEDGE_RISK.map(([value,text])=>({value,label:text}))}]}))),
      // 切分粒度没有唯一正解，与其替他决定，不如让他点一下就看结果。
      h('div',{style:{marginTop:12}},
        h('label',{style:fieldLabel},'怎么切'),
        h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
          [['auto','按标题和空行'],['item','每个列表项一条'],['block','整篇当一条']].map(([value,text])=>
            h('button',{key:value,onClick:()=>{setSplitMode(value);if(raw.trim())run(true,value);},'aria-pressed':splitMode===value,
              style:{...pill(splitMode===value?C.brand:null),background:splitMode===value?C.hover:'transparent',cursor:'pointer',minHeight:36}},text)))),
      h(Notice,{error}),
      !!preview&&h('div',{style:{marginTop:12,border:'1px solid '+C.border,borderRadius:12,padding:'12px 14px',background:C.panel}},
        h('div',{style:{fontSize:15,color:C.text,marginBottom:8}},'将导入 '+(preview.total||0)+' 条'+(preview.sourceType==='url'?'（已从网址抓取正文）':'')),
        (preview.items||[]).slice(0,20).map((item,index)=>h('div',{key:index,style:{padding:'7px 0',borderTop:index?'1px solid '+C.border:'none',fontSize:14,color:C.text2,lineHeight:1.6,wordBreak:'break-word'}},
          h('span',{style:{color:C.text3,marginRight:8}},String(index+1)+'.'),item.title)),
        (preview.items||[]).length>20&&h('p',{style:{...hint,marginTop:8}},'…还有另外 '+((preview.items||[]).length-20)+' 条')),
      h('div',{style:{display:'flex',gap:10,marginTop:14,flexWrap:'wrap'}},
        h('button',{onClick:()=>run(true),disabled:busy||!raw.trim(),style:button(false)},busy?'处理中…':'先看切成几条'),
        h('button',{onClick:()=>run(false),disabled:busy||!raw.trim(),style:button(true)},preview?('确认导入 '+preview.total+' 条'):'直接导入'),
        h('button',{onClick:onCancel,disabled:busy,style:button(false)},'取消')));
  }

  function KnowledgeForm({initial,onDone,onCancel}){
    const [kind,setKind]=useState(initial?.kind||'faq'),[title,setTitle]=useState(initial?.title||''),[content,setContent]=useState(initial?.content||''),[risk,setRisk]=useState(initial?.riskLevel||'low');
    const [busy,setBusy]=useState(false),[error,setError]=useState('');
    async function save(){
      if(!title.trim()||!content.trim()){setError('标题和内容都要填');return;}
      setBusy(true);setError('');
      try{
        if(initial)await mutate('context/knowledge/'+initial.id,'PATCH',{kind,title:title.trim(),content:content.trim(),riskLevel:risk,expectedRevision:initial.revision});
        else await api('context/knowledge',{kind,title:title.trim(),content:content.trim(),riskLevel:risk});
        onDone();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    const label=fieldLabel;   // 统一走控件基线里的标签，别再各写一套字号
    return h('div',{style:{...card,padding:16}},
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}},
        h('div',null,h('label',{style:fieldLabel},'分类'),h(Select,{value:kind,onChange:setKind,ariaLabel:'分类',groups:[{items:KNOWLEDGE_KINDS.map(([value,text])=>({value,label:text}))}]})),
        h('div',null,h('label',{style:fieldLabel},'风险等级'),h(Select,{value:risk,onChange:setRisk,ariaLabel:'风险等级',groups:[{items:KNOWLEDGE_RISK.map(([value,text])=>({value,label:text}))}]}))),
      h('div',{style:{marginTop:12}},h('label',{style:label},'标题'),h('input',{value:title,onChange:event=>setTitle(event.target.value),placeholder:'例如：营业时间、退货政策',style:field})),
      h('div',{style:{marginTop:12}},h('label',{style:label},'内容'),h('textarea',{value:content,onChange:event=>setContent(event.target.value),rows:4,placeholder:'助手能引用的事实。写清楚、不含糊，避免金额/时间这类会变的信息（那些要人工确认）。',style:{...field,resize:'vertical',lineHeight:1.7}})),
      h(Notice,{error}),
      h('div',{style:{display:'flex',gap:10,marginTop:12}},
        h('button',{onClick:save,disabled:busy,style:button(true)},busy?'正在保存…':(initial?'保存修改':'创建（存为草稿）')),
        initial&&h('button',{onClick:onCancel,disabled:busy,style:button(false)},'取消')));
  }

  function KnowledgeCard({k,onAct}){
    const [editing,setEditing]=useState(false);
    const [confirming,setConfirming]=useState(false);
    if(editing)return h(KnowledgeForm,{initial:k,onDone:()=>{setEditing(false);onAct(()=>Promise.resolve());},onCancel:()=>setEditing(false)});
    return h('article',{style:card},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}},
        // 同 ProfileCard：标题和「第 N 版 · 分类」之间给足间距，别让两段字粘在一起
        h('div',{style:{display:'flex',alignItems:'baseline',gap:10,minWidth:0,flexWrap:'wrap'}},
          h('strong',{style:{fontSize:16,color:C.text}},k.title),
          h('span',{style:{fontSize:13,color:C.text3,flexShrink:0}},'第 '+k.revision+' 版 · '+(KNOWLEDGE_KINDS.find(item=>item[0]===k.kind)||[k.kind,k.kind])[1])),
        h('div',{style:{display:'flex',gap:8,alignItems:'center'}},
          k.riskLevel&&k.riskLevel!=='low'&&h('span',{style:pill(C.warn)},(KNOWLEDGE_RISK.find(item=>item[0]===k.riskLevel)||[k.riskLevel,k.riskLevel])[1]),
          h('span',{style:pill(k.status==='published'?C.ok:k.status==='retired'?null:C.warn)},KNOWLEDGE_STATUS[k.status]||k.status))),
      h(LongText,{text:k.content}),
      // 导入来的条目留个来源痕迹，方便回头核对是哪份资料抄来的。
      k.sourceType&&k.sourceType!=='manual'&&h('p',{style:{...hint,marginTop:6,wordBreak:'break-word'}},
        k.sourceType==='url'?(k.sourceRef?('导入自 '+k.sourceRef):'从网址导入'):'粘贴导入'),
      h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',marginTop:12}},
        k.status!=='published'&&h('button',{onClick:()=>onAct(()=>api('context/knowledge/'+k.id+'/publish',{})),style:small(true)},'发布'),
        k.status==='published'&&h('button',{onClick:()=>onAct(()=>api('context/knowledge/'+k.id+'/retire',{})),style:small(false)},'停用'),
        h('button',{onClick:()=>setEditing(true),style:small(false)},'编辑'),
        // 删除是**真删**（停用只是停用）。分两步：第一次点变成"确认删除"，再点才真删 ——
        // 不用浏览器原生弹窗（和这块界面的风格不搭），也不给一次误点就丢内容的机会。
        h('button',{onClick:()=>{if(!confirming)return setConfirming(true);
            onAct(()=>mutate('context/knowledge/'+k.id,'DELETE'));},style:small(false,confirming)},confirming?'确认删除':'删除')));
  }

  /**
   * 一份导入的文档 = 界面上的**一条**知识。
   *
   * 用户实测：上传一个文档被切成很多切片，界面上一条条列着，删了好久才删完 ——
   * "切片是知识库的运行逻辑，用户根本不需要理解"。
   * 所以：默认只看文档（名字 + 几段 + 一次删掉整份）；想关心切片质量的，展开再看。
   * **切片本身不删**：检索真的靠它。
   */
  function KnowledgeDocument({name, items, onAct}){
    const [open,setOpen]=useState(false);
    const [confirming,setConfirming]=useState(false);
    const first=items[0]||{};
    return h('article',{style:card},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}},
        h('div',{style:{display:'flex',alignItems:'baseline',gap:10,minWidth:0,flexWrap:'wrap'}},
          h('strong',{style:{fontSize:16,color:C.text,wordBreak:'break-word'}},name||first.title||'导入的文档'),
          h('span',{style:{fontSize:13,color:C.text3,flexShrink:0}},'导入的文档 · 共 '+items.length+' 段')),
        h('div',{style:{display:'flex',gap:8,alignItems:'center',flexShrink:0}},
          h('span',{style:pill(items.some(i=>i.status==='published')?C.ok:null)},
            items.some(i=>i.status==='published')?'已发布':'草稿'))),
      h('p',{style:{...hint,margin:'8px 0 0'}},
        '发给助手时按段落检索，不整篇塞进去。删除会一次删掉整份文档。'),
      h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',marginTop:12}},
        h('button',{onClick:()=>{if(!confirming)return setConfirming(true);
          onAct(()=>mutate('context/knowledge?importId='+encodeURIComponent(first.metadata?.importId||''),'DELETE'));},
          style:small(false,confirming)},confirming?'确认删掉整份':'删除整份'),
        items.some(i=>i.status!=='published')&&h('button',{
          onClick:()=>onAct(()=>Promise.all(items.filter(i=>i.status!=='published')
            .map(i=>api('context/knowledge/'+i.id+'/publish',{})))),style:small(true)},'全部发布'),
        h('button',{onClick:()=>setOpen(value=>!value),style:small(false)},
          open?'收起分段（'+items.length+'）':'看看分段（'+items.length+'）')),
      open&&h('div',{style:{marginTop:10}},
        items.map(item=>h('div',{key:item.id,style:{borderTop:'1px solid '+C.border,padding:'8px 0'}},
          h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline'}},
            h('strong',{style:{fontSize:13,color:C.text2,minWidth:0,wordBreak:'break-word'}},item.title),
            h('button',{onClick:()=>onAct(()=>api('context/knowledge/'+item.id+'/retire',{})),
              style:{...small(false,false,true),flexShrink:0}},item.status==='published'?'停用这段':'不用这段')),
          h('p',{style:{margin:'4px 0 0',fontSize:12,color:C.text3,lineHeight:1.7,
            display:'-webkit-box',WebkitBoxOrient:'vertical',WebkitLineClamp:3,overflow:'hidden'}},item.content)))));
  }

  function KnowledgeSection({data,refresh,filter,setFilter}){
    const [open,setOpen]=useState(false),[importOpen,setImportOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const items=data?.items||[],shown=filter==='all'?items:items.filter(k=>k.status===filter);
    const act=async fn=>{setBusy(true);setError('');try{await fn();refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
    return h('section',{style:{marginBottom:20}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,marginBottom:12}},
        h('div',null,h('h2',{style:{...h2,margin:0}},'知识库'),h('span',{style:{fontSize:13,color:C.text3}},'助手能引用的事实，发布后才生效')),
        h('div',{style:{display:'flex',gap:8,flexShrink:0}},
          h('button',{onClick:()=>{setImportOpen(value=>!value);setOpen(false);},style:small(!importOpen)},importOpen?'收起':'批量导入'),
          h('button',{onClick:()=>{setOpen(value=>!value);setImportOpen(false);},style:small(!open)},open?'收起':'＋ 新增'))),
      // 「要不要在规则里挂知识库」这个问题在这里一次说清：不用挂。发布即可用。
      h('p',{style:{...hint,margin:'0 0 12px'}},'这里的东西是全站通用的，不用在自动回复规则里勾选：发布之后，助手回复任何人、以及给你起草回复时都会自动来里面找相关条目；找不到就不编，涉及退款、报价这类会停下来交给你。'),
      h(Notice,{error}),
      importOpen&&h(KnowledgeImport,{onDone:()=>{setImportOpen(false);refresh();},onCancel:()=>setImportOpen(false)}),
      open&&h(KnowledgeForm,{onDone:()=>{setOpen(false);refresh();}}),
      h('div',{style:{display:'flex',gap:8,flexWrap:'wrap',margin:'4px 0 14px'}},[['published','已发布'],['draft','草稿'],['retired','已停用'],['all','全部']].map(([value,text])=>
        h('button',{key:value,onClick:()=>setFilter(value),'aria-pressed':filter===value,style:{...pill(filter===value?C.brand:null),background:filter===value?C.hover:'transparent',cursor:'pointer',minHeight:36}},text))),
      !shown.length&&h('p',{style:hint},'还没有这个状态下的知识。点「＋ 新增」写一条，发布后助手遇到相关问题就能引用。'),
      // 同一份文档的切片归成一条：用户上传的是一个文档，不是 N 条知识。
      (()=>{
        const groups=[];
        for(const item of shown){
          // 老数据没有 importId（那次导入时还没这个概念）：用 sourceRef 兜一下，
          // 让从网址导入的那批也能一条看。实在认不出来的就先单独列着。
          const importId=(item.metadata&&item.metadata.importId)
            ||(item.sourceRef?('src:'+item.sourceRef):'');
          if(!importId){groups.push({key:item.id,items:[item]});continue;}
          const hit=groups.find(group=>group.key===importId);
          if(hit)hit.items.push(item);
          else groups.push({key:importId,items:[item],importName:item.metadata.importName||''});
        }
        return groups;
      })().map(group=>group.items.length>1
        ? h(KnowledgeDocument,{key:group.key,name:group.importName,items:group.items,onAct:act})
        : h(KnowledgeCard,{key:group.key,k:group.items[0],onAct:act})));
  }

  /**
   * 写"怎么回复这个人"时的预设起手文案。
   *
   * 用户的要求：**不要放全局** —— 每个人都不一样，就在自动回复的规则里配。
   * 所以这里只提供"填进去再改"的几套现成文本，配置本身留在规则里（规则自带的那段优先）。
   * 不可修改的系统契约不在这里展示：和以前一样，后台默认拼上去就行。
   */
  function StylePresetPicker({onPick,disabled,value}){
    const presets=usePoller(true,()=>api('reply-style'),300000);
    const list=presets.data?.presets||[];
    if(!list.length)return null;
    // **只在还没写规矩时出现**：写好了它就该消失（那时候它只是噪音，
    // 还会让人以为"是不是还得再选点什么"）；把内容清空它会自己回来。
    if(String(value??'').trim())return null;
    return h('div',{style:{marginTop:10}},
      h('p',{style:{...hint,margin:'0 0 8px'}},'还没写规矩？选一个现成的开始，再按这个人改：'),
      h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
        list.map(item=>h('button',{key:item.id,type:'button',disabled,style:small(false),
          onClick:()=>onPick(item.text)},item.name))));
  }

  /**
   * 导出诊断日志（只在开发者模式出现）。
   *
   * 为什么需要它：产品交付出去之后，用户遇到问题时的唯一出路是"把现场给开发者看"。
   * 让他自己翻目录找日志不现实 —— 这里一键生成一份纯文本（脱敏、能直接打开、能贴进聊天窗口）。
   */
  function DiagnosticsExport(){
    const [busy,setBusy]=useState(false),[note,setNote]=useState(''),[error,setError]=useState('');
    async function exportNow(){
      setBusy(true);setNote('');setError('');
      try{
        const result=await api('diagnostics/export');
        const blob=new Blob([result.content||''],{type:'text/plain;charset=utf-8'});
        const url=URL.createObjectURL(blob);
        const link=document.createElement('a');
        link.href=url;link.download=result.filename||'诊断.txt';
        document.body.appendChild(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),2000);
        setNote('已导出：'+(result.filename||'诊断.txt')+'（在浏览器的下载目录里）。把它发给开发者即可。');
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    return h('section',{style:{...card,marginTop:16}},
      h('h3',h3,'诊断日志'),
      h('p',{style:{...hint,margin:'0 0 12px'}},
        '遇到问题时导出一份发给开发者。内容包含版本、配置概览、运行日志和最近的错误；'
        +'**不含任何密钥或登录令牌**（导出前会再脱敏一遍）。'),
      h('button',{onClick:exportNow,disabled:busy,style:button(true)},busy?'正在整理…':'导出诊断日志'),
      note&&h('p',{style:{...hint,margin:'10px 0 0',color:C.ok}},note),
      h(Notice,{error}));
  }

  function ContextPage(){
    const profiles=usePoller(true,()=>api('context/profiles'),8000);
    const knowledge=usePoller(true,()=>api('context/knowledge'),8000);
    const [kFilter,setKFilter]=useState('published');
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:900,margin:'0 auto',boxSizing:'border-box'}},
        // 功能层：页面标题条。sticky + 玻璃，正文从它背后过。
        // 同自动回复页：滚动区里的 sticky 元素不做折射（每帧重跑滤镜，见那边的说明）。
        h('div',{className:'lg-glass ma-pagebar'},
          h('h1',{style:{...h1,margin:0}},'回复配置')),
        h('p',{style:{margin:'0 0 4px',color:C.text2,fontSize:14,lineHeight:1.8,maxWidth:640}},'这里决定助手「像谁、知道什么」。说话方式控制语气和禁用词；知识库是它能引用的可靠事实。没配的时候，助手按通用方式自然回复，涉及退款、报价、时间承诺这些会主动交给你。'),
        h(Notice,{error:profiles.error||knowledge.error}),
        h(ProfilesSection,{data:profiles.data,refresh:profiles.refresh}),
        h(KnowledgeSection,{data:knowledge.data,refresh:knowledge.refresh,filter:kFilter,setFilter:setKFilter})));
  }

  /**
   * 任务模型选择器。
   *
   * 「自动回复」和「整理消息」是两个不同任务 —— 一个要像人一样说话，一个要归纳和判断
   * 轻重 —— 模型需求不一样，所以各配各的。原来只有一个总开关，等于逼用户二选一。
   * 两份下拉共用同一份目录（`catalog`），只是选中项不同。
   */
  function TaskModelPicker({title,description,catalog,provider,model,clashHint,onPick,saving}){
    const listed=catalog.data?.models||[];
    // 不同提供方可能有同名模型，只用 id 会选错端点，所以选中值编码成「provider::model」。
    const here=entry=>entry.provider+'::'+entry.id;
    const matched=listed.some(entry=>entry.provider===provider&&entry.id===model);
    const groups=[];
    for(const entry of listed){
      let group=groups.find(item=>item.label===entry.provider);
      if(!group){group={label:entry.providerName||entry.provider,items:[]};groups.push(group);}
      group.items.push({value:here(entry),label:entry.name===entry.id?entry.id:(entry.name+' · '+entry.id)});
    }
    // 选中的组合不在目录里时（比如那个本地模型被删了），也要能在下拉里看到自己选的是什么 ——
    // 否则触发器只会显示"请选择"，用户以为自己的设置被改掉了。
    if(!matched&&model)groups.unshift({label:'当前',items:[{value:provider+'::'+model,label:provider+' · '+model}]});
    return h('section',{style:{...card,marginTop:16}},
      h('h3',h3,title),
      h('p',{style:{...hint,margin:'0 0 12px'}},description),
      clashHint&&clashHint,
      h(Select,{value:matched?provider+'::'+model:'',onChange:onPick,disabled:saving||!listed.length,
        ariaLabel:title,placeholder:catalog.loading?'正在读取模型…':'暂无可用模型',minWidth:280,groups}),
      saving&&h('p',{style:{...hint,margin:'8px 0 0'}},'正在保存…'));
  }

  function SettingsPage(){
    const status=usePoller(true,()=>api('status'),10000),data=status.data;
    const settings=usePoller(true,()=>api('settings'),15000);
    const catalog=usePoller(true,()=>api('models'),60000);
    // 一次只可能保存一个任务，所以用"哪个任务在存"而不是两个布尔。
    const [saving,setSaving]=useState(''),[modelError,setModelError]=useState('');
    const devMode=useDevMode();
    const ok=data&&!data.error;
    const autoModel=settings.data?.settings?.auto_model||data?.model||'';
    const autoProvider=settings.data?.settings?.auto_provider||'deepseek-official';
    const organizeModel=settings.data?.settings?.organize_model||data?.model||'';
    const organizeProvider=settings.data?.settings?.organize_provider||'deepseek-official';
    const assistantModel=settings.data?.settings?.assistant_model||data?.model||'';
    const assistantProvider=settings.data?.settings?.assistant_provider||'deepseek-official';
    async function saveTaskModel(task,value){
      const split=value.indexOf('::');
      if(split<0)return;
      const provider=value.slice(0,split),model=value.slice(split+2);
      setSaving(task);setModelError('');
      try{
        // 三条链路各存各的：自动回复 / 整理消息 / 问助手。
        const patch=task==='auto'?{auto_provider:provider,auto_model:model}
          :task==='assistant'?{assistant_provider:provider,assistant_model:model}
          :{organize_provider:provider,organize_model:model};
        await api('settings',patch);
        settings.refresh();status.refresh();
      }catch(e){setModelError(e.message);}finally{setSaving('');}
    }
    // ---- 模型从哪来：云端 or 本机 ----------------------------------------------
    // 三条链路（自动回复 / 整理消息 / 问助手）本来各配一次，用户容易困惑；这里给一个大选择，
    // 需要细调的再去「高级设置」。
    //
    // **踩过的坑**：这里原来直接用"当前生效的模型"往目标提供方上套 ——
    // 从本机切回云端时，把 ollama 的 qwen-dsh-16k:latest 当成了 DeepSeek 的模型名发出去，
    // 接口直接报 "The supported API model names are …"。
    // 所以每一侧都**只从自己那侧的列表里选**，并且让用户明确挑一个（云端本来就有多个）。
    const [advanced,setAdvanced]=useState(false);
    const [cloudPick,setCloudPick]=useState('');
    const [localPick,setLocalPick]=useState('');
    const listed=catalog.data?.models||[];
    // 本机提供方：名字里带 ollama / local 的都算。其余按云端处理。
    const isLocalProvider=name=>/ollama|local/i.test(String(name||''));
    const localModels=listed.filter(entry=>isLocalProvider(entry.provider));
    const cloudModels=listed.filter(entry=>!isLocalProvider(entry.provider));
    const providers=[autoProvider,organizeProvider,assistantProvider];
    const allLocal=providers.every(item=>isLocalProvider(item));
    const allCloud=providers.every(item=>!isLocalProvider(item));
    const mode=allLocal?'local':(allCloud?'cloud':'mixed');
    const modeText=allLocal?'本机模型':(allCloud?'云端模型':'自定义（见高级设置）');
    // 下拉里显示什么：先看用户刚选的；没有就看"现在真正在用的组合"是不是属于这一侧；
    // 都没有才留空（那时显示占位文案）。之前把 value 写死成空串，于是选完也不回显（用户实测）。
    const shownFor=side=>{
      const picked=side==='local'?localPick:cloudPick;
      if(picked)return picked;
      const onThisSide=side==='local'?allLocal:allCloud;
      return onThisSide?autoProvider+'::'+autoModel:'';
    };
    // 当前值不在目录里（比如那个模型被删了）也要能在下拉里看见自己 —— 否则触发器只剩占位文案，
    // 用户会以为设置被改掉了。别处 TaskModelPicker 用同一个办法。
    const itemsFor=(models,value)=>{
      const items=models.map(entry=>({value:entry.provider+'::'+entry.id,
        label:(entry.name===entry.id?entry.id:entry.name+' · '+entry.id)}));
      if(value&&!items.some(item=>item.value===value))items.unshift({value,label:value});
      return items;
    };

    async function applySide(value){
      setModelError('');
      if(!value){setModelError('还没有可用的模型。装好之后再回来选。');return;}
      for(const task of ['auto','organize','assistant']){
        await saveTaskModel(task,value);
      }
    }
    const sideRow=(key,title,note,models,value,setValue)=>
      h('div',{key,style:{border:'1px solid '+(mode===key?C.brand:C.border),borderRadius:12,
        padding:'12px 14px',background:mode===key?C.hover:C.panel}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,flexWrap:'wrap'}},
          h('strong',{style:{fontSize:14,color:C.text}},title),
          mode===key&&h('span',{style:{fontSize:12,color:C.brand}},'正在用')),
        h('p',{style:{...hint,margin:'4px 0 10px'}},note),
        h('div',{style:{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}},
          // 云端一般有好几个模型，**让用户自己挑一个** —— 替他默认一个他不满意的，
          // 下次还得回来改（用户实测就撞上过）。
          h(Select,{value:value,minWidth:240,disabled:!!saving||!models.length,
            placeholder:models.length?('选一个模型（'+models.length+' 个可用）'):'这一侧还没有模型',
            groups:[{items:itemsFor(models,value)}],
            onChange:next=>{setValue(next);applySide(next);}}),
          !models.length&&h('span',{style:{fontSize:12,color:C.text3}},
            key==='local'?'还没装本机模型（可选，见下面的说明）':'还没配置云端模型的密钥')));

    const modeCard=h('section',{style:{...card,marginTop:16}},
      h('h3',h3,'模型从哪来'),
      h('p',{style:{...hint,margin:'0 0 12px'}},
        h('span',null,'现在用的是「'+modeText+'」。'),
        '选「本机模型」时，聊天内容不会离开这台电脑 —— 问助手会读到你的消息，介意的话就选它。'),
      h('div',{style:{display:'flex',flexDirection:'column',gap:10}},
        sideRow('cloud','云端模型','快、效果好，内容会发给模型服务。',cloudModels,shownFor('cloud'),setCloudPick),
        sideRow('local','本机模型','不联网，内容不出这台电脑。',localModels,shownFor('local'),setLocalPick)),
      h('div',{style:{marginTop:12}},
        h('button',{onClick:()=>setAdvanced(value=>!value),style:{...small(false),borderRadius:99}},
          advanced?'收起高级设置':'高级设置（逐条链路的模型）')));

    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:760,margin:'0 auto',boxSizing:'border-box'}},
        // 功能层：页面标题条。sticky + 玻璃，卡片从它背后过。
        // 滚动区里的 sticky 元素不做折射，原因见自动回复页那段说明。
        h('div',{className:'lg-glass ma-pagebar'},
          h('h1',{style:{...h1,margin:0}},'设置')),
        h(Notice,{error:modelError||status.error||settings.error||catalog.error}),
        h('section',{style:card},
          h('div',{style:{display:'flex',alignItems:'center',gap:12}},
            h('span',{style:{fontSize:22,color:ok?C.ok:C.text3}},'●'),
            h('div',null,
              h('strong',{style:{display:'block',fontSize:16,color:C.text}},ok?'消息服务运行正常':'正在检查消息服务'),
              h('span',{style:{fontSize:13,color:C.text3}},data?('已接入 '+data.rules.length+' 个联系人'):'请稍等…'))),
           h('p',{style:{marginTop:16,color:C.text2,fontSize:14,lineHeight:1.8}},'自动回复规则和发送记录保存在这台电脑上。使用云端模型时，为了生成回复，相关聊天内容会发送给模型服务。')),
        // 初始化完成后这块自己消失（用户要求：已经读过就别再显示，免得反复点触发风险）。
        h(WeChatInitSection,{}),
        h(ModelSetupCard,{}),
        modeCard,
        advanced&&h(TaskModelPicker,{title:'自动回复模型',
          description:'管的是后台自动回复由谁来写。选本地模型（如「本地 Qwen」）时，那一轮回复的内容不会离开这台电脑。修改后从下一条新消息开始生效。',
          catalog,provider:autoProvider,model:autoModel,saving:saving==='auto',
          onPick:value=>saveTaskModel('auto',value)}),
        advanced&&h(TaskModelPicker,{title:'整理消息模型',
          description:'管的是点「整理消息」时由谁来读消息、归纳要点。这个任务要读懂整段上下文并判断轻重，换成本地小模型时容易读偏，建议先试几次再定。',
          catalog,provider:organizeProvider,model:organizeModel,saving:saving==='organize',
          onPick:value=>saveTaskModel('organize',value)}),
        // 语音放在整块模型配置之后：上面全是「选模型」，下面才是语音。
        advanced&&h(TaskModelPicker,{title:'问助手模型',
          description:'管的是点「问助手」时由谁来读消息、归纳要点。这个任务要读懂整段上下文并判断轻重，换成本地小模型时容易读偏，建议先试几次再定。',
          catalog,provider:assistantProvider,model:assistantModel,saving:saving==='assistant',
          onPick:value=>saveTaskModel('assistant',value)}),
        // 语音放在整块模型配置之后：上面全是「选模型」，下面才是语音。
        h(VoiceCard,{}),
        // 只有开发者模式才出现：用户遇到问题时的把现场给开发者看入口。
        devMode&&h(DiagnosticsExport,{}),
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'开发者模式'),
          h('p',{style:{...hint,margin:'0 0 12px'}},'默认关闭。打开后会多两样东西：出错的地方多一块折叠的「开发者详情」（Runtime 的错误码、原文、调用栈和读取条数，可一键复制），导航底部多一个回到原生界面的入口。原始日志另外逐条记在数据目录的 dev-errors.log 里。'),
          h(DevToggle,{})),
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'数据保存在哪'),
          h('p',{style:{...hint,margin:0}},'自动回复规则、跟进记录、待办、整理结果和对话记录都只保存在这台电脑上，不会上传。看消息与整理消息都不会打开微信窗口，也不会清掉聊天里的未读红点。')),
        data&&h('details',{style:{marginTop:16,color:C.text2}},
          h('summary',{style:{cursor:'pointer',fontSize:15}},'高级信息'),
          h('div',{style:{marginTop:12,padding:16,borderRadius:10,background:C.panel,fontSize:14,lineHeight:2,color:C.text2}},
            h('div',null,'当前模型：'+data.model),
            h('div',null,'服务启动时间：'+new Date(data.started_at*1000).toLocaleString('zh-CN')),
            h('div',null,'接入联系人：'+data.rules.length+' 个')))));
  }

  function parseBlock(block){const done=block&&Object.prototype.hasOwnProperty.call(block,'kind'),raw=(done?block.call?.argsRaw:block?.argsRaw)||'';let args={};try{args=JSON.parse(raw);}catch{}const output=done?(block.content||[]).filter(value=>value.type==='text').map(value=>value.text).join('\n'):'';return{done,args,output,error:done&&block.isError};}
  function MessageToolCard({toolName,block,inspect}){
    const model=parseBlock(block),name=toolName.split('.').pop().split('__').pop();
    let title='正在处理消息',summary='请稍等…';
    // 自动回复是全自动链路：这一步没有任何需要用户批准的动作，渲染成卡片只会让人以为
    // 「要不要点同意/拒绝」，而且会永久留在会话里。结果请看「自动回复」页的规则状态与处理记录。
    if(name==='submit_reply_decision')return null;
    if(name==='list_conversations'){title=model.done?'已读取微信会话':'正在读取微信会话';summary=model.done?'会话列表已更新':'正在连接微信';}
    else if(name==='read_messages'||name==='sync_conversation'){title=model.done?'已读取聊天内容':'正在读取聊天内容';summary=model.args.conversation_id?'已定位到指定会话':'正在定位会话';}
    else if(name==='search_messages'){title=model.done?'已完成消息搜索':'正在搜索消息';summary=model.args.query?'搜索“'+model.args.query+'”':'';}
    else if(name==='send_message'||name==='reply_message'){title=model.done?'发送请求已提交':'正在提交发送请求';summary=model.done?'最终结果以消息服务状态为准':'不会重复发送';}
    else if(name==='get_send_status'){title=model.done?'已查询发送结果':'正在查询发送结果';summary=model.output||'请稍等…';}
    if(model.error){title='消息操作没有完成';summary=(model.output||'请稍后重试').split('\n')[0];}
    return h('div',{style:{margin:'6px 0',padding:'12px 14px',border:'1px solid '+(model.error?C.error:C.border),borderRadius:10,background:C.panel}},
      h('div',{style:{display:'flex',gap:8,alignItems:'center'}},h('span',null,model.error?'⚠':'↗'),h('strong',{style:{fontSize:14,color:model.error?C.error:C.text}},title)),
      summary&&h('p',{style:{margin:'6px 0 0',fontSize:13,color:C.text2,whiteSpace:'pre-wrap',wordBreak:'break-word',lineHeight:1.7}},summary),
      inspect&&h('button',{onClick:inspect,style:{marginTop:8,border:'none',padding:0,background:'transparent',color:C.text3,fontSize:13,cursor:'pointer'}},'查看详情'));
  }

  // 首版只呈现自动回复核心。主动查消息继续走原生对话框里的 MCP，避免再造一个不稳定的整理页。
  // 首屏是「消息」：关键信息 + 关键操作 + 对话。主动查消息不再需要回到原生对话框 ——
  // 产品自己的对话区走的是同一个 Agent，而且每次提问都会带上最新消息。
  const NAV=[['home','消息'],['todos','待办'],['automation','自动回复'],['context','回复配置']];
  // 消息 = 一个消息气泡；待办 = 方框里一个勾。只保留实际用到的四个映射。
  const NAV_ICON={home:'messages',todos:'today',automation:'automation',context:'settings'};
  function NavEntry({store,wide}){
    const {open}=useStore(store);
    return h('button',{onClick:()=>store.set({open:!open,cover:true,tab:'home'}),title:'消息',
      style:{display:'flex',alignItems:'center',gap:10,width:'100%',minHeight:44,padding:'10px 12px',border:'none',borderRadius:10,cursor:'pointer',background:open?C.hover:'transparent',color:C.text,fontSize:14}},
      h(Icon,{name:'home',size:18}),wide&&h('span',null,'消息'));
  }
  /**
   * 收起来的时候的封面。
   *
   * 「回到对话框」原来直接摆在这里和导航底部 —— 那是 DSH 的原生界面（工作区、模型选择器、
   * 工具 JSON），属于开发面，不该出现在日常路径上。现在它只在开发者模式里出现：
   * 产品自己的对话区已经能聊天、能整理、能看消息。
   */
  function Cover({store}){
    const dev=useDevMode();
    return h('div',{'data-ma':'cover',style:{position:'fixed',inset:0,zIndex:60,background:C.bg,color:C.text,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14,padding:32,textAlign:'center'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:10}},h(BrandMark,{size:28}),h('strong',{style:{fontSize:21}},'消息助手')),
      h('p',{style:{margin:0,color:C.text3,fontSize:14,lineHeight:1.85,maxWidth:380}},
        '助手会继续在后台值守指定联系人。要看消息、整理消息或问助手，打开面板就行。'),
      h('button',{onClick:()=>store.set({open:true,tab:'home'}),style:{...button(true),minWidth:180,marginTop:6}},'打开消息助手'),
      dev&&h('button',{onClick:()=>store.set({cover:false}),
        style:{marginTop:6,border:'none',background:'transparent',color:C.text3,fontSize:13,cursor:'pointer'}},'回到对话框（开发）'));
  }
  /**
   * 导航轨底部：设置 + 一个**只在开发者模式出现**的出口。
   *
   * 「回到对话框」通向 DSH 原生界面（工作区/模型/工具 JSON），是开发面。产品自己的
   * 对话区已经能完成日常的事，所以这里不再把它摆在日常路径上；要排查时打开开发者模式
   * （设置页有开关）它才出现。
   */
  function RailFoot({store,narrow,tab,closeRef}){
    const dev=useDevMode();
    return h('div',{className:'lg-railfoot'},
      h('button',{onClick:()=>store.set({tab:'settings'}),'aria-current':tab==='settings'?'page':undefined,title:'设置',
        'data-active':tab==='settings'?'':undefined,className:'lg-navitem',
        style:{minHeight:46,padding:'11px 12px',cursor:'pointer',textAlign:narrow?'center':'left',fontSize:14,display:'flex',alignItems:'center',gap:10,justifyContent:narrow?'center':'flex-start'}},
        h(Icon,{name:'gear',size:18}),narrow?null:'设置'),
      dev&&h('button',{ref:closeRef,onClick:()=>store.set({open:false,cover:false}),title:'回到原生对话框（开发用）',
        className:'lg-navitem lg-quiet',style:{minHeight:42,padding:'9px 12px',cursor:'pointer',fontSize:13,textAlign:narrow?'center':'left'}},
        narrow?'原生':'← 原生对话框'));
  }
  function Workbench({ctx,store}){
    const {open,cover,tab,contactKey,contactTitle,contactKind}=useStore(store),[narrow,setNarrow]=useState(()=>matchMedia('(max-width: 900px)').matches),closeRef=useRef(null),rootRef=useRef(null);
    useEffect(()=>{const media=matchMedia('(max-width: 900px)'),change=()=>setNarrow(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
    // Esc 只做"往回退一步"，**绝不**离开产品：原来它写的是 `cover:false`，而 cover:false
    // 就是把画面交回 DSH 原生界面（工作区、模型选择器）—— 按一下 Esc 掉进开发界面，
    // 用户会以为产品崩了。现在：开着会话就先退回列表，再按一次才收起面板（停在封面）。
    //
    // 另一个坑：这个监听在 document 上，输入框里按 Esc 也会冒泡到这里 —— 实测"在待办里
    // 改文案，按 Esc 直接退出了消息助手"。所以焦点在输入类控件里时，Esc 归控件自己处理。
    useEffect(()=>{if(!open)return;const key=event=>{
      if(event.key!=='Escape')return;
      const target=event.target;
      if(target&&(target.tagName==='INPUT'||target.tagName==='TEXTAREA'||target.tagName==='SELECT'||target.isContentEditable))return;
      const state=store.get();
      if(state.contactKey)store.set({contactKey:null,contactTitle:null,contactKind:null});
      else store.set({open:false,cover:true});
    };document.addEventListener('keydown',key);closeRef.current?.focus();return()=>document.removeEventListener('keydown',key);},[open,store]);
    // 折射的挂载点。玻璃元素（页头、回执条）是各页面自己渲染出来的，出现和消失都不经过
    // Workbench 的 render，所以这里追 DOM 而不是挂在某个组件上。
    // 只在「新增节点里真的有 [data-liquid-glass]」时才重扫 —— 否则动画期间每帧都扫一遍。
    useEffect(()=>{
      const node=rootRef.current,runtime=typeof window!=='undefined'?window.liquidGlass:null;
      if(!node||!runtime)return;
      let frame=0;
      const run=()=>{frame=0;runtime.scan(node);};
      const schedule=()=>{if(!frame)frame=requestAnimationFrame(run);};
      schedule();
      const observer=new MutationObserver(records=>{
        const interesting=records.some(record=>Array.from(record.addedNodes).some(entry=>
          entry.nodeType===1&&(entry.hasAttribute('data-liquid-glass')||entry.querySelector('[data-liquid-glass]'))));
        if(interesting)schedule();
      });
      observer.observe(node,{childList:true,subtree:true});
      return ()=>{observer.disconnect();if(frame)cancelAnimationFrame(frame);};
    },[]);
    if(!cover)return null;
    if(!open)return h(Cover,{store});
    // 导航项坐在玻璃轨上，所以它自己**不能用玻璃**（玻璃不叠玻璃）。
    // 选中态靠明度差建立：一块不透明白面 + 一道内高光；材质交给底下的轨道。
    const items=NAV.map(([value,label])=>h('button',{key:value,onClick:()=>store.set({tab:value}),'aria-current':tab===value?'page':undefined,title:label,
      'data-active':tab===value?'':undefined,className:'lg-navitem',
      style:{minHeight:narrow?62:46,padding:narrow?'8px 4px':'11px 12px',cursor:'pointer',textAlign:'center',fontSize:narrow?11:14,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:4}},
      h(Icon,{name:NAV_ICON[value],size:20}),narrow?h('span',null,label):null));
    const wideItems=NAV.map(([value,label])=>h('button',{key:value,onClick:()=>store.set({tab:value}),'aria-current':tab===value?'page':undefined,title:label,
      'data-active':tab===value?'':undefined,className:'lg-navitem',
      style:{minHeight:46,padding:'11px 12px',cursor:'pointer',textAlign:'left',fontSize:14,display:'flex',alignItems:'center',gap:10}},
      h(Icon,{name:NAV_ICON[value],size:18}),label,
      null));
    return h('div',{role:'dialog','aria-modal':'true','aria-label':'自动回复管理','data-ma':'root',ref:rootRef,
      // 底层刻意不写 background：画布的环境色团与颗粒在 liquid 样式表里定义。
      // 行内样式权重最高，一旦写死就会把玻璃可折射的背景盖掉。
      style:{position:'fixed',inset:0,zIndex:60,display:'flex',pointerEvents:'auto',color:C.text,fontFamily:'Inter, ui-sans-serif, "Segoe UI", "Microsoft YaHei", sans-serif'}},
      h('style',null,'.ma-drag-ghost{background-color:var(--ma-surface)!important;background-image:none!important;opacity:1!important;box-shadow:var(--ma-shadow)!important;border-radius:12px;overflow:hidden}.ma-drag-ghost *{background-color:transparent!important;background-image:none!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}[data-ma] .ma-jump{position:absolute;right:22px;bottom:22px;width:44px;height:44px;border-radius:50%;border:1px solid var(--lg-edge);background-color:var(--lg-card-bg);background-image:var(--lg-card-sheen);box-shadow:var(--lg-card-shadow),inset 0 1px 0 var(--lg-card-rim);color:var(--ma-ink);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:4;-webkit-backdrop-filter:blur(var(--lg-blur-sm));backdrop-filter:blur(var(--lg-blur-sm))}[data-ma] .ma-jump:hover{filter:brightness(1.05)}[data-ma] .ma-iconbtn{color:var(--ma-muted);border-radius:8px;cursor:pointer;transition:background var(--lg-dur-1) var(--lg-ease-smooth),color var(--lg-dur-1) var(--lg-ease-smooth)}[data-ma] .ma-iconbtn:not(:disabled):hover{background:var(--lg-tint);color:var(--ma-danger)}[data-ma] .ma-iconbtn:disabled{opacity:.45;cursor:default}[data-ma] button{transition:background var(--lg-dur-1) var(--lg-ease-smooth),border-color var(--lg-dur-1) var(--lg-ease-smooth),color var(--lg-dur-1) var(--lg-ease-smooth),box-shadow var(--lg-dur-1) var(--lg-ease-smooth),transform var(--lg-dur-1) var(--lg-ease-interactive),filter var(--lg-dur-1) var(--lg-ease-smooth)}[data-ma] button:not(:disabled):hover{filter:brightness(1.04)}[data-ma] button:not(:disabled):active{transform:scale(.975)}[data-ma] button:focus-visible,[data-ma] input:focus-visible,[data-ma] textarea:focus-visible,[data-ma] select:focus-visible{outline:3px solid var(--ma-primary);outline-offset:2px}[data-ma] button:disabled{opacity:.55;cursor:not-allowed}[data-ma] summary{cursor:pointer}[data-ma] input[type="checkbox"]{accent-color:var(--ma-primary)}[data-ma] .ma-pulse{animation:ma-pulse 1.3s ease-in-out infinite}@keyframes ma-pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.1)}}[data-ma] .ma-spin{animation:ma-spin .8s linear infinite}@keyframes ma-spin{to{transform:rotate(360deg)}}[data-ma] .ma-track-fill{animation:ma-track 1.6s ease-in-out infinite}@keyframes ma-track{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}@media(max-width:1100px){[data-ma] .ma-rule-grid{grid-template-columns:1fr!important}}@media (prefers-reduced-motion: reduce){[data-ma] .ma-pulse,[data-ma] .ma-spin,[data-ma] .ma-track-fill{animation:none}[data-ma] .ma-track-fill{width:100%;opacity:.5}[data-ma] button:not(:disabled):active{transform:none!important}}'),
      h('nav',{'data-ma':'nav','aria-label':'主要功能',className:'lg-glass','data-compact':narrow?'':undefined,
        // 功能层：悬浮玻璃轨。padding / 描边 / 底色 / 材质全在样式表的 nav[data-ma="nav"] 里；
        // 行内只留布局 —— 宽度随窄屏变，是动态值，只能写在这。
        // data-* 是折射参数。位移含蓄一点（-96）。
        // chroma=0 是**刻意**的：棱镜彩边要走三通道滤镜链（3×位移 + 3×矩阵 + 2×混合），
        // 实测把滚动中位帧从 22ms 顶到 52ms、p95 从 33ms 顶到 102ms。想要彩边就写
        // data-chroma="7"，但先确认目标机器扛得住。
        'data-liquid-glass':'','data-scale':'-96','data-chroma':'0','data-border':'.055','data-blur':'2','data-saturate':'1.45',
        style:{width:narrow?76:214,boxSizing:'border-box',position:'relative',zIndex:2,flexShrink:0,display:'flex',flexDirection:'column'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:9,padding:'2px 8px 22px',fontSize:17,fontWeight:750,color:C.text}},
          h(BrandMark,{size:26}),narrow?null:h('span',null,'Message Agent')),
        narrow?items:wideItems,
        h('div',{style:{flex:1}}),
        // 底部出口单独成一块内嵌面：让轨道读得出「品牌 / 导航 / 底部」三段结构
        h(RailFoot,{store,narrow,tab,closeRef})),
      h('main',{'data-ma':'main',style:{flex:1,minWidth:0,height:'100%',display:'flex',overflow:'hidden',position:'relative',zIndex:1}},
        tab==='home'?(contactKey?h(ConversationView,{key:contactKey,store,username:contactKey,
            title:contactTitle,kind:contactKind,narrow}):h(HomePage,{store,narrow}))
          :tab==='todos'?h(TodayPage,{store,ctx})
          :tab==='automation'?h(AutomationPage)
          :tab==='context'?h(ContextPage)
          :h(SettingsPage)));
  }
  const TOOL_NAMES=['mcp__messaging__list_conversations','mcp__messaging__read_messages','mcp__messaging__sync_conversation','mcp__messaging__search_messages','mcp__messaging__send_message','mcp__messaging__reply_message','mcp__messaging__get_send_status','submit_reply_decision'];
  return{inject:['slots','sessions'],apply(ctx){
      // 浏览器标签标题：刷新时也会先露出一瞬间宿主的名字，这里尽早改成"消息助手"，
    // 并且它是"我们自己的名字"，宿主后来改回去也照样纠正（有变化才动，不做无意义的写）。
    const wantedTitle='消息助手';
    const pinTitle=()=>{if(document.title!==wantedTitle)document.title=wantedTitle;};
    pinTitle();
    document.addEventListener('visibilitychange',pinTitle);
    // 兜底：插件正常时品牌会立刻挂载并解除遮罩；万一注入失败，3 秒后无条件显示，
    // 不能让侧边栏一直空着（遮罩只在"我们自己就快好了"的前提下才成立）。
    setTimeout(()=>document.documentElement.classList.add('ma-brand-ready'),3000);

  const saved=readSaved(),allowedTabs=['home','todos','automation','context','settings'],store=createStore({open:saved.open===undefined?true:saved.open,cover:saved.cover===undefined?true:saved.cover,tab:allowedTabs.includes(saved.tab)?saved.tab:'home',contactKey:null,contactTitle:null,contactKind:null,customerKey:null,filter:'all',scope:'attention',order:'recent',pending:0});
    ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'message-agent-workbench',order:5,label:()=> '自动回复'},({wide})=>h(NavEntry,{store,wide})));
    ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'message-agent-workbench',order:20},()=>h(Workbench,{ctx,store})));
    ctx.slots.inject('tool.call.toolview',function*(){for(const key of TOOL_NAMES)yield ctx.slots.register({name:'tool.call.toolview',key},MessageToolCard);});
    // Product branding. The shell ships a generic mark and a build label with the
    // harness version pinned under it, and declares these three slots exactly so a
    // deployment can own them. Nested injects wait for all three declarations, so
    // the favicon-free mark and the name arrive together and leave together.
    ctx.slots.inject('sidebar.brand.mark',()=>ctx.slots.inject('sidebar.brand.name',()=>ctx.slots.inject('conversation.hero.brand.mark',function*(){
      yield ctx.slots.register({name:'sidebar.brand.mark'},BrandMark);
      yield ctx.slots.register({name:'sidebar.brand.name'},BrandName);
      yield ctx.slots.register({name:'conversation.hero.brand.mark'},BrandMark);
    })));
  }};
}});
