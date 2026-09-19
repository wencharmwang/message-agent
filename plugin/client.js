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
  const dateField={...field,minHeight:44,minWidth:150,fontSize:14};
  // 下拉：原生箭头每个平台长得都不一样，是这套界面里最显眼的「没设计」信号。
  // 关掉原生外观，自己画一个和图标同粗细的箭头。灰色取两档主题都成立的中性值。
  const selectField={...field,cursor:'pointer',paddingRight:36,appearance:'none',WebkitAppearance:'none',
    backgroundImage:'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'8\' viewBox=\'0 0 12 8\'%3E%3Cpath d=\'M1 1.5 6 6.5 11 1.5\' fill=\'none\' stroke=\'%237b8a81\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E")',
    backgroundRepeat:'no-repeat',backgroundPosition:'right 13px center',backgroundSize:'12px 8px'};
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
  function useStore(store){return useSyncExternalStore(store.subscribe,store.get);}

  // ---- 开发者模式 -----------------------------------------------------------
  // 排查阶段「读不到消息」只看到一句「操作没有完成」就没法往下查：原因在 Runtime 的
  // 错误码、它自己的原文，以及调用栈里，而这三样在面向用户的文案里都被换掉了。打开这个
  // 开关，界面上会多出一块折叠的原始报错（可复制）。**上线前关掉即可全部隐藏**：开关
  // 状态存在本机，服务端也有 dev_diagnostics 配置兜底，关掉后原始内容根本不会下发。
  const DEV_KEY='ma-dev-mode';
  function readDevMode(){try{const raw=localStorage.getItem(DEV_KEY);return raw===null?true:raw==='1';}catch{return true;}}
  let devMode=readDevMode();
  const devListeners=new Set();
  function setDevMode(on){devMode=!!on;try{localStorage.setItem(DEV_KEY,devMode?'1':'0');}catch{}devListeners.forEach(listener=>listener());}
  function useDevMode(){return useSyncExternalStore(listener=>{devListeners.add(listener);return()=>devListeners.delete(listener);},()=>devMode);}

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
    return h('button',{onClick:()=>setDevMode(!on),title:'开发者模式：显示原始错误码、Runtime 原文与调用栈，便于定位「读不到消息」的原因。上线前关掉即可隐藏。',
      style:{...small(false,false,true),color:on?C.warn:C.text3}},
      '开发者模式：'+(on?'开':'关'));
  }
  function usePoller(active,load,delay){
    const [state,setState]=useState({loading:true,data:null,error:'',errorCode:'',errorDev:null}),loadRef=useRef(load),[revision,setRevision]=useState(0),waitersRef=useRef([]);loadRef.current=load;
    useEffect(()=>{if(!active)return;let stopped=false,timer,controller,wait=800;const run=async()=>{if(stopped)return;if(document.hidden){timer=setTimeout(run,5000);return;}controller=new AbortController();try{const data=await loadRef.current(controller.signal);if(!stopped){setState({loading:false,data,error:'',errorCode:'',errorDev:null});wait=delay;}}catch(error){if(!stopped&&error.name!=='AbortError'){setState(old=>({...old,loading:false,error:error.message,errorCode:error.code||'',errorDev:error.dev||null}));wait=Math.min(wait*2,30000);}}finally{if(!stopped){const waiters=waitersRef.current;waitersRef.current=[];waiters.forEach(resolve=>resolve());}}if(!stopped)timer=setTimeout(run,wait);};run();return()=>{stopped=true;clearTimeout(timer);controller&&controller.abort();};},[active,delay,revision]);
    return {...state,refresh:()=>new Promise(resolve=>{waitersRef.current.push(resolve);setRevision(value=>value+1);})};
  }

  function relativeTime(value){if(!value)return'';const seconds=Math.max(0,Date.now()/1000-value);if(seconds<60)return'刚刚';if(seconds<3600)return Math.floor(seconds/60)+'分钟前';if(seconds<86400)return Math.floor(seconds/3600)+'小时前';const date=new Date(value*1000);if(seconds<86400*7)return Math.floor(seconds/86400)+'天前';return(date.getMonth()+1)+'月'+date.getDate()+'日';}
  function pad2(value){return String(value).padStart(2,'0');}
  function toDateInput(date){return date.getFullYear()+'-'+pad2(date.getMonth()+1)+'-'+pad2(date.getDate());}
  function dayStart(offset){const date=new Date();date.setHours(9,0,0,0);date.setDate(date.getDate()+offset);return date;}
  function fromDateInput(value){return value?new Date(value+'T09:00:00'):null;}
  function sameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}
  function dueInfo(dueAt){
    if(!dueAt)return null;
    const due=new Date(dueAt*1000),now=Date.now()/1000,today=new Date(),tomorrow=dayStart(1);
    if(dueAt<now&&!sameDay(due,today))return{text:'已逾期 '+(due.getMonth()+1)+'月'+due.getDate()+'日',color:C.error};
    if(sameDay(due,today))return{text:'今天到期',color:C.warn};
    if(sameDay(due,tomorrow))return{text:'明天到期',color:C.text2};
    return{text:(due.getMonth()+1)+'月'+due.getDate()+'日',color:C.text3};
  }
  function firstLine(text,limit){const line=String(text||'').split('\n').map(part=>part.trim()).filter(Boolean)[0]||'';return line.length>limit?line.slice(0,limit)+'…':line;}

  // Monochrome icons: they inherit the surrounding text colour via currentColor, so the
  // same glyph reads correctly on a light or dark host theme. Colour emoji cannot do that.
  const ICONS={
    messages:'M4 5.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9.6L6 17.4v-2.9H4A1.5 1.5 0 0 1 2.5 13V7A1.5 1.5 0 0 1 4 5.5Z',
    today:'M4.2 4.5h11.6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm2.5 5.7 1.5 1.5 2.9-2.9',
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
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline'}},h('strong',{style:{fontSize:15,fontWeight:600}},title),right&&h('span',{style:{fontSize:13,color:C.text3,flexShrink:0}},right)),
      meta&&h('div',{style:{margin:'5px 0 0',fontSize:13,color:C.text3,lineHeight:1.6}},meta),
      children);
  }

  // ---- shared composer: 记跟进 or 加待办 --------------------------------------
  function Composer({mode,setMode,busy,onSubmit,idleHint,fixedMode}){
    const [text,setText]=useState(''),[due,setDue]=useState(''),[error,setError]=useState('');
    async function submit(){
      if(!text.trim()){setError('先写点内容再保存');return;}
      setError('');
      try{await onSubmit(mode,text.trim(),due?fromDateInput(due).toISOString():null);setText('');setDue('');}catch(e){setError(e.message);}
    }
    const isTodo=mode==='todo';
    return h('div',{style:{border:'1px solid '+C.border,borderRadius:12,padding:14,background:C.panel}},
      !fixedMode&&h('div',{style:{display:'flex',gap:8,marginBottom:10}},
        h('button',{onClick:()=>setMode('followup'),'aria-pressed':!isTodo,style:{...small(!isTodo),borderRadius:99}},'记一条跟进'),
        h('button',{onClick:()=>setMode('todo'),'aria-pressed':isTodo,style:{...small(isTodo),borderRadius:99}},'加一条待办')),
      h('textarea',{value:text,onChange:event=>setText(event.target.value),rows:isTodo?2:3,placeholder:isTodo?'要做什么？例如：周五前回张伟的报价':'这次沟通说了什么？例如：电话确认了报价，等他周五回复','aria-label':isTodo?'待办内容':'跟进内容',style:{...field,resize:'vertical',lineHeight:1.7}}),
      isTodo&&h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:10,flexWrap:'wrap'}},
        h('span',{style:{fontSize:13,color:C.text2}},'什么时候做'),
        h('button',{onClick:()=>setDue(toDateInput(dayStart(0))),style:{...small(false),borderRadius:99}},'今天'),
        h('button',{onClick:()=>setDue(toDateInput(dayStart(1))),style:{...small(false),borderRadius:99}},'明天'),
        h('input',{type:'date',value:due,onChange:event=>setDue(event.target.value),'aria-label':'到期日',style:dateField}),
        due&&h('button',{onClick:()=>setDue(''),style:{...small(false,false,true),borderRadius:99}},'清除日期')),
      h(Notice,{error}),
      h('div',{style:{display:'flex',gap:10,alignItems:'center',marginTop:12,flexWrap:'wrap'}},
        h('button',{onClick:submit,disabled:busy,style:button(true)},busy?'正在保存…':(isTodo?'添加待办':'保存这条跟进')),
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

  // 整理结果留在浏览器里。整理是用户主动发起、要花十几秒到一分钟的操作，而它的产物只是
  // 「看一眼」的结果——切到「今天要做的」再回来、或者关掉面板再打开，都会让这段结果消失，
  // 用户于是被迫再整理一次（重新读微信、重新调模型）。只留最近一次，并显示它的时间。
  const ORGANIZER_KEY='ma-organizer-result';
  function readOrganizerResult(){
    try{
      const parsed=JSON.parse(localStorage.getItem(ORGANIZER_KEY)||'null');
      return parsed&&typeof parsed.answer==='string'?parsed:null;
    }catch(e){return null;}
  }
  function writeOrganizerResult(value){
    try{if(value)localStorage.setItem(ORGANIZER_KEY,JSON.stringify(value));else localStorage.removeItem(ORGANIZER_KEY);}catch(e){}
  }

  // 整理请求挂在**模块级**，不挂在组件里，也不写 localStorage。
  //
  // 请求是在发起它的那个组件里等着的：用户切走再回来，组件会重建，请求却还在跑。上一版把
  // "正在跑"存进 localStorage，回来时确实读得到"进行中"，但旧实例跑完后清掉的是那段存储 ——
  // 新实例的 state 没人通知，动画就一直转，要再切一次页面才恢复（实测被指出来过）。
  // 而纯 localStorage 方案还有更糟的一面：页面被刷新后请求已经不存在了，记录却还在，
  // 那个动画永远不会结束。模块级变量正好只跨"同一个页面内的切换"，刷掉就没有，语义是对的。
  let ORGANIZER_RUN=null;
  let ORGANIZER_RUN_ERROR='';
  const ORGANIZER_WATCHERS=new Set();
  function notifyOrganizer(){for(const watcher of ORGANIZER_WATCHERS)watcher();}

  /**
   * 整理进行中的反馈。
   *
   * 整理这条链路上没有可观察的阶段事件（刷新列表 → 模型挑会话 → 读正文 → 生成结论都在一次
   * 调用里），所以这里刻意不做假进度条：只给一个不确定的滑动条、一个真实计时和一句随耗时
   * 变化的说明。用户要的是「它在动，不是我点漏了」，不是一个编出来的百分比。
   */
  function OrganizerProgress({startedAt,restored,onStuck}){
    const [now,setNow]=useState(()=>Date.now());
    useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
    const seconds=Math.max(0,Math.round((now-startedAt)/1000));
    const stage=seconds<10?'正在查看微信当前可见的会话…'
      :seconds<40?'正在读取最相关的几个会话，并整理其中的信息…'
      :'还在读取和整理（会话越多越慢，通常不超过一分钟）…';
    return h('div',{role:'status','aria-live':'polite',style:{marginTop:18,padding:'14px 16px',borderRadius:12,border:'1px solid '+C.border,background:C.panel}},
      h('div',{style:{display:'flex',alignItems:'center',gap:9,color:C.text,fontSize:14}},h(Spinner,{size:15}),stage),
      h('div',{className:'ma-track',style:{marginTop:11,height:4,borderRadius:99,background:C.hover,overflow:'hidden'}},
        h('div',{className:'ma-track-fill',style:{height:'100%',background:C.brand,borderRadius:99}})),
      // 这一段只说真话：读不到的条目会被跳过，不承诺"过一会儿就好"（那要看具体原因），
      // 也不再提"微信正在被使用"——用户主动发起的整理不会再因为这条让开（实测就是这么被误导的）。
      h('p',{style:{...hint,margin:'9px 0 0'}},(restored?'这次整理还在进行中（你在别的页面发起的），结果出来会自动留在这一页。':'')
        +'已经等了 '+seconds+' 秒。读不到的条目会跳过并继续整理已取得的信息，不会在后台反复重试。'),
      // 真的断掉时（宿主重启、连接被挂住）要有一条自己出来的路：请求本身取消不了，
      // 但界面不必陪着它卡住 —— 之前只能刷新整页才能出来。
      seconds>180&&onStuck&&h('button',{onClick:onStuck,style:{...small(false),marginTop:10}},'好像断掉了 · 点这里重新开始'));
  }

  function AskDock({conversationKey,identity,onChanged,endpoint}){
    const [text,setText]=useState(''),[asking,setAsking]=useState(false);
    const [asked,setAsked]=useState(''),[answer,setAnswer]=useState(null);
    const [note,setNote]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const title=identity&&identity.title?identity.title:'他';
    async function submit(value){
      const question=String(value===undefined?text:value).trim();
      if(!question||asking)return;
      setAsking(true);setError('');setNote('');setAnswer(null);setAsked(question);setText('');
      try{setAnswer(await api(endpoint||('conversations/'+conversationKey+'/ask'),{text:question}));}
      catch(e){setError(e.message);}
      finally{setAsking(false);}
    }
    async function addTodos(items){
      setBusy(true);setError('');setNote('');
      try{
        for(const item of items)await api('todos',{conversationKey,title:firstLine(item,40),detail:item,source:'assistant'});
        setNote('已记下 '+items.length+' 条待办');
        onChanged&&onChanged();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    async function saveFollowup(){
      setBusy(true);setError('');setNote('');
      try{
        await api('customers/'+conversationKey+'/followups',{kind:'助手摘要',note:answer.answer,evidence:toolText(answer.tools)});
        setNote('已存为跟进记录');
        onChanged&&onChanged();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    const items=answer?answerListItems(answer.answer):[];
    // 正文与下面的待办清单不重复：清单里的条目从正文里摘掉，只在清单那处呈现。
    // 「存为跟进记录」保存的仍是完整答案（见上面的 saveFollowup），档案里不该丢东西。
    const body=answer?answerBody(answer.answer):'';
    const evidence=answer&&answer.tools&&answer.tools.length?'已读取微信记录':'';
    // 提问保持自然口语；"哪些事要我做"由后端的产品级提示词负责标成「- [ ] 」，前端不再猜格式。
    const quick=[
      ['最近有什么事要处理？','最近有什么事需要我本人处理？'],
      ['总结最近聊天要点','用几句话总结我和'+title+'最近聊天的要点。'],
      ['我答应过什么没兑现？','我答应过'+title+'什么但还没兑现？']];
    return h('div',{'data-ask':'dock',style:{flexShrink:0,borderTop:'1px solid '+C.border,background:C.bg,padding:'12px 20px 16px'}},
      h('div',{style:{maxWidth:780}},
        h(Notice,{error}),
        // 回答就落在输入框上方：不跳页、不盖住正文，读完了可以关掉。
        answer&&h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:RESULT_BG,marginBottom:10,maxHeight:'44vh',overflowY:'auto'}},
          h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline',padding:'11px 15px',borderBottom:'1px solid '+C.border,position:'sticky',top:0,background:C.panel}},
            h('span',{style:{fontSize:13,color:C.text3,minWidth:0,wordBreak:'break-word'}},'你问：'+asked),
            h('button',{onClick:()=>{setAnswer(null);setNote('');},'aria-label':'关闭回答',style:{...small(false,false,true),flexShrink:0}},'关闭')),
          body&&h('p',{style:{margin:0,padding:'14px 15px',fontSize:15,lineHeight:1.85,color:C.text,whiteSpace:'pre-wrap',wordBreak:'break-word'}},body),
          !!items.length&&h('div',{style:{padding:'0 15px 14px'}},
            h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:6}},
              h('span',{style:{fontSize:13,color:C.text3}},'以上可以直接变成待办'),
              h('button',{onClick:()=>addTodos(items),disabled:busy,style:small(true)},busy?'正在记…':'全部记成待办')),
            items.map((item,index)=>h('div',{key:item+index,style:{display:'flex',gap:10,alignItems:'flex-start',padding:'9px 0',borderTop:'1px solid '+C.border}},
              h('span',{style:{flex:1,minWidth:0,fontSize:14,color:C.text2,lineHeight:1.7}},item),
              h('button',{onClick:()=>addTodos([item]),disabled:busy,style:{...small(false),flexShrink:0}},'记成待办')))),
          h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center',padding:'0 15px 14px'}},
            h('button',{onClick:saveFollowup,disabled:busy,style:small(false)},busy?'正在保存…':'存为跟进记录'),
            evidence&&h('span',{style:{fontSize:13,color:C.text3}},evidence)),
          note&&h('div',{style:{padding:'0 15px 14px'}},h(Result,{text:note}))),
        // 运行中只说在做事，不给中间步骤。
        asking&&h('div',{style:{display:'flex',alignItems:'center',gap:9,marginBottom:9,color:C.text2,fontSize:14}},
          h('span',{className:'ma-pulse',style:{width:9,height:9,borderRadius:'50%',background:C.brand,flexShrink:0}}),
          '助手正在处理「'+asked+'」，通常十几秒，不用留在这页。'),
        h('div',{style:{display:'flex',gap:8,alignItems:'center'}},
          h('input',{value:text,onChange:event=>setText(event.target.value),
            onKeyDown:event=>{if(event.key==='Enter')submit();},
            placeholder:'问助手任何关于'+title+'和这段聊天的事，例如：最近有什么事要处理？',
            'aria-label':'问助手',style:{...field,flex:'1 1 auto',minWidth:0}}),
          h('button',{onClick:()=>submit(),disabled:asking||!text.trim(),style:{...button(true),flexShrink:0}},asking?'运行中…':'发送')),
        !answer&&!asking&&h('div',{style:{display:'flex',gap:8,marginTop:9,flexWrap:'wrap'}},
          quick.map(([label,question])=>h('button',{key:label,onClick:()=>submit(question),style:small(false,false,true)},label)))));
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
        todoOpen&&h(Composer,{mode:'todo',fixedMode:true,setMode:()=>{},busy,onSubmit:addTodo}),
        !todos.length&&!todoOpen&&h('p',{style:hint},'没有未完成的待办。'),
        !!todos.length&&h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.panel,overflow:'hidden'}},todos.map(todoLine)),
        doneTodos.length?h('button',{onClick:()=>setShowDone(value=>!value),style:{...small(false,false,true),marginTop:8}},showDone?'收起已完成':'已完成 '+doneTodos.length+' 件'):null,
        showDone&&doneTodos.map((todo,index)=>h('div',{key:todo.id,style:{display:'flex',gap:10,padding:'9px 0',borderBottom:'1px solid '+C.border,color:C.text3,fontSize:14}},
          h('span',{style:{textDecoration:'line-through',flex:1,minWidth:0}},todo.title)))),

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

  function DraftCard({draft,onChanged}){
    const [editing,setEditing]=useState(false),[text,setText]=useState(draft.text),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);
    const open=draft.state==='awaiting_confirmation';
    const SETTLED={sent:'已发送',uncertain:'发送结果待确认',approval_required:'等待你在消息服务里批准',not_sent:'没有发出',sending:'正在发送…',cancelled:'已取消的草稿',expired:'已过期的草稿'};
    const stateColor=draft.state==='sent'?C.ok:(draft.state==='uncertain'||draft.state==='approval_required'?C.warn:draft.state==='not_sent'?C.error:null);
    async function save(){setBusy(true);setError('');try{await api('drafts/'+draft.id+'/revise',{expectedRevision:draft.revision,text});setEditing(false);onChanged();}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function cancel(){if(!window.confirm('取消这条回复草稿吗？'))return;setBusy(true);try{await api('drafts/'+draft.id+'/cancel',{});onChanged();}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function confirm(){setBusy(true);setError('');try{await api('drafts/'+draft.id+'/confirm',{expectedRevision:draft.revision});onChanged();}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function copy(){try{await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),2000);}catch{setError('复制失败了，请手动选中文字复制');}}
    return h('article',{style:{...card,padding:16}},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'center'}},
        h('strong',{style:{fontSize:15,color:C.text}},SETTLED[draft.state]||(open?'等你确认的回复':draft.state)),
        h('span',{style:pill(stateColor)},'第 '+draft.revision+' 版')),
      editing?h('textarea',{value:text,onChange:event=>setText(event.target.value),rows:4,style:{...field,marginTop:12,resize:'vertical',lineHeight:1.7}})
        :h('p',{style:{margin:'12px 0',fontSize:16,lineHeight:1.85,color:C.text,whiteSpace:'pre-wrap',wordBreak:'break-word'}},draft.text),
      (draft.detail&&draft.state!=='awaiting_confirmation')&&h('p',{style:{margin:'0 0 10px',fontSize:13,color:stateColor||C.text2,lineHeight:1.7}},draft.detail),
      h(Notice,{error}),
      open&&h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
        editing?h(React.Fragment,null,
          h('button',{disabled:busy,onClick:save,style:button(true)},busy?'正在保存…':'保存修改'),
          h('button',{disabled:busy,onClick:()=>{setEditing(false);setText(draft.text);},style:button(false)},'不保存'))
        :h(React.Fragment,null,
          h('button',{disabled:busy,onClick:confirm,style:button(true)},busy?'正在发送…':'确认发送'),
          h('button',{disabled:busy,onClick:copy,style:button(false)},copied?'已复制':'复制正文'),
          h('button',{disabled:busy,onClick:()=>setEditing(true),style:button(false)},'改一改'),
          h('button',{disabled:busy,onClick:cancel,style:button(false,true)},'不用了'))),
      open&&h('p',{style:{...hint,marginTop:12}},'上面就是最终要发给「'+draft.target.title+'」的正文。点「确认发送」才会真正发出去。'));
  }

  function ContactDetail({store,ctx,items,narrow}){
    const {contactKey}=useStore(store);
    const item=items.find(value=>value.key===contactKey);
    const [actionError,setActionError]=useState('');
    // 「再检查一次」过去只是把轮询重跑一遍，状态没变时界面毫无动静，用户无法判断点中了没有。
    // 现在分三拍给反馈：按下即变「正在检查…」→ 等这一轮真正读完 → 落一行带时间的结论。
    const [checking,setChecking]=useState(false),[checkedAt,setCheckedAt]=useState(0);
    const detail=usePoller(item?.key||false,signal=>fetch('/message-agent/api/conversations/'+item.key,{signal}).then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'暂时无法读取详情');return data;}),8000);
    const check=async()=>{
      if(checking)return;
      setChecking(true);setCheckedAt(0);
      // refresh() 要等这一轮真正读完（成功或失败）才 resolve；再兜一个超时，避免永远卡在「正在检查…」。
      try{await Promise.race([detail.refresh(),new Promise(resolve=>setTimeout(resolve,8000))]);}catch{}
      setChecking(false);setCheckedAt(Date.now());
    };
    const clockTime=value=>{const date=new Date(value);return pad2(date.getHours())+':'+pad2(date.getMinutes());};
    if(!item)return h(Empty,{title:'选一个人',text:'左边点一个联系人，就能看到和他的聊天情况、要跟进的事，以及让助手帮忙。'});
    const jobs=detail.data?.recentJobs||[],drafts=detail.data?.drafts||[],jobRuns=foldJobRuns(jobs);
    // 功能层：页头是「一直悬在内容之上」的功能条，用玻璃。
    // zIndex 从 1 抬到 3：玻璃条被内容层后来的定位元素压住会显得很脏。
    const header=h('header',{className:'lg-glass lg-bar','data-liquid-glass':'','data-scale':'-72','data-chroma':'5','data-border':'.09','data-blur':'2',
      style:{position:'sticky',top:0,zIndex:3,padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:12}},
        narrow&&h('button',{onClick:()=>store.set({contactKey:null}),'aria-label':'返回消息列表',style:{...small(false),padding:'8px 12px'}},'←'),
        h('div',null,
          h('h2',{style:{margin:0,fontSize:20,color:C.text}},item.identity.title),
          h('p',{style:{margin:'4px 0 0',fontSize:13,color:C.text3}},(item.identity.kind==='group'?'微信群聊':'微信联系人')+' · '+(item.rule.enabled?'自动回复中':'自动回复已暂停')))),
      item.attentionKind==='connection'&&h('button',{onClick:check,disabled:checking,style:{...button(false),opacity:checking?0.6:1,cursor:checking?'default':'pointer'}},checking?'正在检查…':'重新检查'));
    const alertBox=item.attentionReason&&h('div',{style:{padding:'15px 16px',borderRadius:12,border:'1px solid '+(item.bucket==='error'?C.error:C.warn),marginBottom:20}},
      h('strong',{style:{fontSize:15,color:C.text}},item.bucket==='error'?'需要处理一下':'等你处理'),
      h('p',{style:{margin:'7px 0 0',color:C.text2,fontSize:14,lineHeight:1.75}},item.attentionReason),
      item.attentionKind==='send'&&h('p',{style:{margin:'7px 0 0',color:C.text3,fontSize:13,lineHeight:1.7}},
        '助手不会自动重发（避免发重复）。这条到底发出去没有，你去微信里看一眼就行 —— 监听没有中断，新消息照常处理。'),
      item.attentionKind==='connection'&&h('button',{onClick:check,disabled:checking,style:{...small(false),marginTop:12,opacity:checking?0.6:1,cursor:checking?'default':'pointer'}},checking?'正在检查…':'再检查一次'),
      // 结论必须落成文字，否则「点了没反应」还会再回来。
      item.attentionKind==='connection'&&!!checkedAt&&h('p',{style:{margin:'10px 0 0',color:C.text3,fontSize:13,lineHeight:1.7}},
        clockTime(checkedAt)+' 又检查了一次，还是读不到微信；助手会继续每 5 秒自动重试，不用一直点。'),
      // A record the user cannot act on is just noise: every attention state needs a way out.
      item.attentionKind==='send'&&h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',marginTop:12}},
        h('button',{onClick:async()=>{
          setActionError('');
          try{await api('conversations/'+item.key+'/ack',{});detail.refresh();}catch(e){setActionError(e.message);}
        },style:small(true)},'知道了'),
        h('button',{onClick:detail.refresh,style:small(false)},'刷新')));
    return h('section',{style:{flex:1,display:'flex',flexDirection:'column',minWidth:0,minHeight:0},'aria-label':item.identity.title+'的消息详情'},
      header,
      h('div',{style:{flex:1,overflowY:'auto',minWidth:0}},
      h('div',{style:{padding:'20px 20px 24px',maxWidth:780}},
        h(Notice,{error:actionError||detail.error}),
        alertBox,
        h(CrmSections,{key:item.key,customerKey:item.key,identity:item.identity,data:detail.data,loading:detail.loading,error:detail.error,onChanged:detail.refresh}),
        // A draft is the one thing that can actually leave the machine, so it keeps a
        // full block — but only when one exists. An empty section is just noise.
        !!drafts.length&&h(Section,{title:'回复草稿',meta:'等你确认'},
          drafts.map(draft=>h(DraftCard,{key:draft.id,draft,onChanged:detail.refresh}))),
        h(Fold,{title:'助手最近做了什么',meta:jobRuns.length?(jobRuns.length+' 条'):'暂无'},
          !jobRuns.length&&h('p',{style:hint},'还没有处理记录。'),
          jobRuns.map(({count,job})=>h('div',{key:job.id,style:{padding:'12px 0',borderBottom:'1px solid '+C.border}},
            h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline'}},
              h('strong',{style:{fontSize:14,color:job.state==='failed'||job.state==='uncertain'?C.error:C.text}},JOB[job.state]||'已处理'),
              h('span',{style:{fontSize:13,color:C.text3}},relativeTime(job.finished_at||job.created_at)+(count>1?' · 同类 '+count+' 条':''))),
            job.text&&h('p',{style:{margin:'6px 0 0',color:C.text2,fontSize:14,lineHeight:1.75,whiteSpace:'pre-wrap'}},job.text),
            job.detail&&h('p',{style:{margin:'6px 0 0',color:C.text3,fontSize:13,lineHeight:1.7}},job.detail),
            // A delivery record with no way to close it is just noise: let the user say they
            // have seen it, without touching the record itself.
            (job.state==='failed'||job.state==='uncertain')&&(job.acknowledged
              ?h('p',{style:{margin:'6px 0 0',color:C.text3,fontSize:13}},'已确认看过，不会再提醒')
              :h('button',{onClick:async()=>{
                setActionError('');
                try{await api('conversations/'+item.key+'/ack',{});detail.refresh();}catch(e){setActionError(e.message);}
              },style:{...small(false),marginTop:8}},'这条不用发了，我知道了'))))))),
      h(AskDock,{conversationKey:item.key,identity:item.identity,onChanged:detail.refresh}));
  }

  // ---- 消息中心 -------------------------------------------------------------
  // 「分类」这个概念已经从界面上拿掉了。
  //
  // 服务端仍然会给每条消息打一个内部标签（它只用来排序），但**不给用户看**：把一条消息
  // 标成「只需了解 / 需要回复」既不是用户自己的判断，错了还会误导 —— 用户实测就看到过
  // 「助手判断：只需了解」配着一条跟自己无关的群聊，于是以为助手要他去做点什么。
  // 这里连带删掉了几个只为展示分类而存在的组件（列表里的分类药丸、这次整理了多少条的
  // 摘要卡、改分类的入口）。
  function CenterRow({item,active,onClick}){
    const meta=(item.summary&&item.summary.length)?firstLine(item.summary[0],44):(item.read?'已读取正文':'尚未读取正文');
    const extra=[
      // 标为已看以前在列表上完全没有痕迹：服务端确实记下了（批次置为 reviewed，行状态
      // 变成 done），但这一行照旧什么都不显示，所以点完的感觉是"什么都没发生"。把它写出来。
      item.actionState==='done'?'已看':'',
      item.following===false?'已忽略':'',
      item.pendingDrafts>0?'草稿待确认':'',
      item.openTodos>0?(item.openTodos+' 件待办'):'',
      item.identityStatus==='ambiguous'?'联系人身份有冲突':'',
      item.automationState==='active'?'自动回复：开':'',
      item.automationProblem?'自动回复异常':''
    ].filter(Boolean).join(' · ');
    return h(Row,{key:item.key,title:item.identity.title,right:item.lastActivityAt?relativeTime(item.lastActivityAt):'',meta,active,inboxItem:true,onClick},
      // 这一行不再下判断（原来是一个「需要回复 / 只需了解」的药丸）。剩下的都是事实：
      // 整理了多少条、是不是群聊，以及下面那串状态。
      (item.newCount!=null||item.identity.kind==='group')&&h('div',{style:{display:'flex',gap:8,marginTop:8,flexWrap:'wrap'}},
        item.newCount!=null&&h('span',{style:{fontSize:13,color:C.text3}},item.newCount+' 条已整理'),
        item.identity.kind==='group'&&h('span',{style:{fontSize:13,color:C.text3}},'群聊')),
      extra&&h('div',{style:{marginTop:6,fontSize:13,color:C.text3}},extra));
  }

  function CenterList({store,items,narrow}){
    const {contactKey}=useStore(store),[query,setQuery]=useState('');
    const needle=query.trim().toLowerCase();
    const shown=items.filter(item=>!needle||item.identity.title.toLowerCase().includes(needle)||(item.summary||[]).join(' ').toLowerCase().includes(needle));
    return h('section',{style:{display:'flex',flexDirection:'column',height:'100%',minWidth:0},'aria-label':'消息列表'},
      h('header',{style:{padding:narrow?'14px 14px 10px':'18px 18px 12px',borderBottom:'1px solid '+C.border}},
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,marginBottom:12}},
          h('h1',{style:{...h1,fontSize:20,margin:0}},'最近整理'),
          // 「整理消息」读起来像在整理这份列表；它真正做的是回到「你想整理什么？」入口页
          // （contactKey=null），不读微信、不发请求。名字改成动作本身，回路的另一头
          // （详情页的「← 再整理一次」）也指向同一个地方。
          h('button',{onClick:()=>store.set({contactKey:null}),title:'回到「你想整理什么？」',style:small(false)},'整理新消息')),
        h('input',{value:query,onChange:event=>setQuery(event.target.value),placeholder:'搜索整理记录','aria-label':'搜索消息',style:field})),
      h('div',{style:{flex:1,overflowY:'auto'}},
        !shown.length&&h('p',{style:{padding:24,textAlign:'center',color:C.text3,fontSize:14,lineHeight:1.8}},needle?'没有找到相关记录':'还没有整理记录'),
        shown.map(item=>h(CenterRow,{key:item.key,item,active:contactKey===item.key,onClick:()=>store.set({contactKey:item.key})}))));
  }

  function OrganizerHome({items,onChanged,store,narrow}){
    const [text,setText]=useState(''),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false);
    // 结果来自浏览器里存的最近一次整理，所以切走再回来、或者关掉面板再打开都还在。
    const [stored,setStored]=useState(()=>readOrganizerResult());
    const [fresh,setFresh]=useState(false);
    // 订阅模块级的"正在跑"：切走再回来动画和计时都在，而且旧实例跑完时这一份会一起更新，
    // 不会卡住。也因为没有第二份状态，重复发起不可能发生。
    const [,bumpRun]=useState(0);
    useEffect(()=>{const watcher=()=>bumpRun(value=>value+1);ORGANIZER_WATCHERS.add(watcher);return()=>{ORGANIZER_WATCHERS.delete(watcher);};},[]);
    const running=ORGANIZER_RUN;
    const [picked,setPicked]=useState({}),[added,setAdded]=useState({});
    const [error,setError]=useState(()=>ORGANIZER_RUN_ERROR),[note,setNote]=useState('');
    useEffect(()=>{if(ORGANIZER_RUN_ERROR){setError(ORGANIZER_RUN_ERROR);ORGANIZER_RUN_ERROR='';}},[]);
    // 进行中就锁住入口：包括"别处发起、这次回来才看到"的那种。
    const locked=busy||!!running;
    const quick=[
      ['整理最近消息','查看微信当前可见的最近会话，读取最多 5 个最值得关注的会话，告诉我发生了什么，并列出需要我处理的事项。'],
      ['找出需要回复的','查看最近会话，找出明确在等我回复的人。只给必要背景和建议回复方向，不要发送。'],
      ['提取待办','从最近相关消息中提取需要我本人完成的事情；不需要回复的也要列出来。'],
      ['看看有没有遗漏','检查最近会话里是否有日期、承诺、文件、付款或决定被我遗漏。']
    ];
    async function run(request){
      const value=String(request??text).trim();if(!value||busy||ORGANIZER_RUN)return;
      ORGANIZER_RUN={asked:value,startedAt:Date.now()};
      setBusy(true);setError('');setNote('');notifyOrganizer();
      try{
        const result=await api('message-center/organize',{text:value});
        const next={answer:String(result.answer||''),asked:value,at:Date.now()/1000};
        setStored(next);writeOrganizerResult(next);
        setFresh(true);setPicked({});setAdded({});setText('');onChanged();
      }
      // 失败信息也放在模块级：这一次整理是用户在别的页面时跑完的，光 setError 会随组件一起丢掉，
      // 他回来只看到"什么都没发生"。module 级留着，谁挂载上来谁显示。
      catch(e){ORGANIZER_RUN_ERROR=e.message;}
      finally{ORGANIZER_RUN=null;notifyOrganizer();}
    }
    // 界面从"卡住"里出来。请求取消不了，但它已经不会再影响这一页（结果仍然会落到 localStorage）。
    function unstick(){
      ORGANIZER_RUN=null;setBusy(false);notifyOrganizer();
      setError('这次整理好像断掉了（消息服务可能刚重启过），可以重新开始。');
    }
    function forget(){
      writeOrganizerResult(null);setStored(null);setFresh(false);setPicked({});setAdded({});setNote('');
    }
    async function refresh(){
      setRefreshing(true);setError('');setNote('');
      try{const result=await api('message-center/refresh',{});setNote(result.observationMessage||('已看到微信当前列表里的 '+result.visibleCount+' 个会话，没有打开聊天。'));await onChanged();}
      catch(e){setError(e.message);}finally{setRefreshing(false);}
    }
    const todos=stored?answerListItems(stored.answer):[];
    // 正文里已经不包含下面那份勾选清单的条目，同一件事不会写两遍。
    const body=stored?answerBody(stored.answer):'';
    const chosen=todos.map((item,index)=>index).filter(index=>picked[index]!==false&&!added[index]);
    async function addPicked(){
      const list=chosen.map(index=>({item:todos[index],index}));
      if(!list.length||busy)return;
      setBusy(true);setError('');setNote('');
      try{
        // 服务端对「同来源 + 同标题 + 未完成」的重复会返回已存在的那条（deduped），
        // 这里照实说，不要报一个虚的数量。
        let created=0;
        for(const {item} of list){
          const saved=await api('todos',{title:firstLine(item,40),detail:item,source:'assistant'});
          if(!saved.deduped)created++;
        }
        setAdded(old=>{const next={...old};for(const {index} of list)next[index]=true;return next;});
        setNote(created
          ? ('已把 '+created+' 件加进待办'+(list.length>created?('（另外 '+(list.length-created)+' 件之前已经记过，没有重复添加）'):''))
          : '这几件之前已经记过了，没有重复添加。');
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    return h('section',{style:{flex:1,minWidth:0,height:'100%',overflowY:'auto'}},
      h('div',{style:{maxWidth:820,padding:narrow?'22px 16px 42px':'38px 42px 60px',margin:'0 auto'}},
        h('h1',{style:{...h1,fontSize:28,marginBottom:8}},'你想整理什么？'),
        h('p',{style:{...hint,fontSize:14,margin:'0 0 22px'}},'只有你发起整理时，助手才会查看微信；不会在后台持续监听，也不会发送消息。自动回复仍按单独配置运行。'),
        h(Notice,{error}),
        h(Result,{text:note}),
        h('div',{style:{display:'grid',gridTemplateColumns:narrow?'1fr':'repeat(2,minmax(0,1fr))',gap:12,marginBottom:18}},
          quick.map(([title,prompt],index)=>h('button',{key:title,onClick:()=>run(prompt),disabled:locked,
            style:{textAlign:'left',padding:'16px 17px',borderRadius:14,border:'1px solid '+C.border,background:index===0?C.hover:C.panel,color:C.text,cursor:locked?'default':'pointer',minHeight:92,opacity:locked&&!(running&&running.asked===prompt)?0.5:1}},
            h('strong',{style:{display:'flex',alignItems:'center',gap:8,fontSize:16,marginBottom:7}},
              running&&running.asked===prompt?h(Spinner,{size:15}):null,title),
            h('span',{style:{fontSize:13,color:C.text3,lineHeight:1.6}},running&&running.asked===prompt?'正在整理，结果会留在这一页…':firstLine(prompt,42))))),
        h('div',{style:{display:'flex',gap:10,alignItems:'center',padding:10,border:'1.5px solid '+FIELD_BORDER,borderRadius:14,background:FIELD_BG}},
          h('input',{value:text,onChange:event=>setText(event.target.value),onKeyDown:event=>{if(event.key==='Enter')run();},
            placeholder:'例如：帮我看看最近有没有要确认时间的消息','aria-label':'输入整理需求',style:{...field,border:'none',background:'transparent',flex:1,minWidth:0}}),
          h('button',{onClick:()=>run(),disabled:locked||!text.trim(),style:{...button(true),display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8,flexShrink:0}},
            locked&&h(Spinner,{size:14}),locked?'正在整理…':'开始整理')),
        h('div',{style:{display:'flex',alignItems:'center',gap:10,marginTop:11,flexWrap:'wrap'}},
          h('button',{onClick:refresh,disabled:refreshing||locked,style:small(false)},refreshing?'正在查看…':'只刷新会话列表'),
          h('span',{style:{fontSize:12,color:C.text3}},'这个操作不会打开聊天，也不会清未读红点。')),
        running&&h(OrganizerProgress,{startedAt:running.startedAt,restored:!busy,onStuck:unstick}),
        stored&&h('div',{style:{marginTop:22,border:'1px solid '+C.border,borderRadius:14,background:C.panel,overflow:'hidden'}},
          h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap',padding:'12px 16px',borderBottom:'1px solid '+C.border}},
            h('span',{style:{fontSize:13,color:C.text3}},fresh?'整理结果':('上次的整理结果 · '+(stored.at?relativeTime(stored.at):'之前'))),
            h('div',{style:{display:'flex',gap:8,flexShrink:0}},
              stored.asked&&h('button',{onClick:()=>run(stored.asked),disabled:locked,style:small(false,false,true)},'重新整理'),
              h('button',{onClick:forget,disabled:busy,style:small(false,false,true)},'清空'))),
          !fresh&&h('p',{style:{margin:0,padding:'11px 17px',borderBottom:'1px solid '+C.border,fontSize:13,color:C.text3,lineHeight:1.7}},'这是上一次整理的结论。微信里如果又来了新消息，点「重新整理」才会重新读取；不点就不会再动微信。'),
          stored.asked&&h('p',{style:{margin:0,padding:'11px 17px 0',fontSize:13,color:C.text3,lineHeight:1.7}},'当时的要求：'+firstLine(stored.asked,60)),
          body&&h('p',{style:{margin:0,padding:'16px 17px',whiteSpace:'pre-wrap',lineHeight:1.85,fontSize:15,color:C.text}},body),
          !body&&!todos.length&&h('p',{style:{margin:0,padding:'16px 17px',fontSize:15,color:C.text2,lineHeight:1.85}},'这次整理没有给出可执行的事项。'),
          !!todos.length&&h('div',{style:{padding:body?'4px 17px 16px':'16px 17px 16px'}},
            h('p',{style:{...hint,margin:'0 0 8px'}},'勾选要加进待办的条目（默认全选，可以只加其中几件）：'),
            todos.map((item,index)=>h('label',{key:item+index,style:{display:'flex',gap:10,alignItems:'flex-start',padding:'9px 0',borderTop:'1px solid '+C.border,cursor:busy||added[index]?'default':'pointer'}},
              h(Checkbox,{checked:picked[index]!==false&&!added[index],disabled:busy||!!added[index],label:firstLine(item,30),
                onChange:event=>setPicked(old=>({...old,[index]:event.target.checked})),style:{marginTop:4}}),
              h('span',{style:{flex:1,minWidth:0,fontSize:14,color:added[index]?C.text3:C.text2,lineHeight:1.7,textDecoration:added[index]?'line-through':'none'}},item),
              added[index]&&h('span',{style:{fontSize:13,color:C.ok,flexShrink:0}},'已加入'))),
            h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:12,flexWrap:'wrap'}},
              h('button',{onClick:addPicked,disabled:busy||!chosen.length,style:small(true)},
                busy?'正在记…':(chosen.length?('加入选中的 '+chosen.length+' 件'):'没有选中任何条目')),
              h('button',{onClick:()=>setPicked({}),disabled:busy||chosen.length===todos.length,style:small(false,false,true)},'全选'),
              h('button',{onClick:()=>{const next={};for(const index of todos.map((_,i)=>i))next[index]=false;setPicked(next);},disabled:busy||!chosen.length,style:small(false,false,true)},'全不选')))),
        narrow&&!!items.length&&h('div',{style:{marginTop:28}},
          h('h2',{style:{...h3,marginBottom:10}},'最近整理'),
          items.slice(0,8).map(item=>h('button',{key:item.key,onClick:()=>store.set({contactKey:item.key}),
            style:{display:'block',width:'100%',textAlign:'left',padding:'12px 4px',border:'none',borderTop:'1px solid '+C.border,background:'transparent',color:C.text}},
            h('strong',{style:{fontSize:14}},item.identity.title),
            h('span',{style:{display:'block',fontSize:13,color:C.text3,marginTop:4}},item.summary?.[0]||'查看整理记录'))))));
  }

  function CenterDetail({store,item,narrow,onChanged}){
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[errorDev,setErrorDev]=useState(null);
    const [todoOpen,setTodoOpen]=useState(false),[todoText,setTodoText]=useState(''),[note,setNote]=useState('');
    // What the last action did, applied the moment it is clicked. Waiting for the list poll
    // AND the detail poll to come back made a successful click look like nothing happened —
    // the server state did change (已看/已排期), the screen just never said so.
    //
    // This state belongs to ONE conversation, which is why the caller renders this component
    // with `key={item.key}`. Without that key React reuses the instance when the user picks
    // another contact and 「已看」 follows them around the whole list.
    const [local,setLocal]=useState({});
    const detail=usePoller(item.key,()=>api('message-center/'+item.key),8000);
    const d=detail.data,drafts=d?.drafts||[],messages=d?.messages||[],todos=(d?.todos||[]).filter(todo=>todo.state!=='done');
    async function run(fn,optimistic){
      setBusy(true);setError('');setErrorDev(null);setNote('');
      const state=optimistic?.state??{};
      if(optimistic){setLocal(old=>({...old,...state}));setNote(optimistic.note);}
      try{await fn();onChanged();detail.refresh();}
      catch(e){
        setError(e.message);setErrorDev(e.dev||null);setNote('');
        // Put the screen back the way the server still reports it, so a refused action never
        // leaves a "已标为已看" behind. `state` defaults to {} because several actions only
        // carry a note — reading `optimistic.state` here threw a TypeError out of the catch,
        // which turned every failed 读取这条会话 into an unhandled rejection.
        setLocal(old=>{const next={...old};for(const key of Object.keys(state))delete next[key];return next;});
      }finally{setBusy(false);}
    }
    // 「已看」以服务端为准（这次消息的批次是否已经置为 reviewed）。早先只记在组件本地状态里，
    // 于是关掉页面再进来按钮又回来了 —— 用户问的正是「标记为已看到底有什么用，下次进入还是有
    // 这个按钮」。现在标记过就换成一行「你已标为已看」，不再给按钮。
    const isSeen=local.seen!==undefined?local.seen:item.actionState==='done';
    const seen=()=>run(()=>api('message-center/'+item.key+'/seen',{}),{state:{seen:true},note:'已标为已看，不会再当作新消息提醒。'});
    const draft=()=>run(()=>api('message-center/'+item.key+'/drafts',{}),{note:'草稿已备好，确认之后才会发出。'});
    const read=()=>run(()=>api('message-center/'+item.key+'/read',{}),{note:'已读取这条会话的正文。'});
    const addTodo=()=>{if(!todoText.trim()&&!(item.summary&&item.summary.length)){setError('先写一句要做什么');return;}run(()=>api('message-center/'+item.key+'/todos',{title:todoText.trim()||item.summary[0],source:'message'}),{note:'已记成待办。'});
      setTodoOpen(false);};
    const finishTodo=todo=>run(()=>api('todos/'+todo.id+'/done',{}),{note:'这件待办做完了。'});
    const follow=following=>run(()=>api('message-center/'+item.key+'/follow',{following}),
      {state:following?{seen:true}:{},note:following?'已恢复关注。':'已忽略这个会话，它不会再进队列。'});
    const confirmIdentity=()=>run(()=>api('message-center/'+item.key+'/confirm-identity',{}),
      {state:{identityConfirmed:true},note:'已确认这个本地联系人身份。以后名称识别有轻微变化也会继续归到这里。'});
    const identityConfirmed=local.identityConfirmed||item.identityStatus==='confirmed';
    // 这几个动作里「读取这条会话」和「让助手起草回复」都要十几秒到一分钟。按钮上只换文案时，
    // 用户看到的是一个不动的界面，会以为没点上；转一圈的指示器才说明「在跑，别重复点」。
    const busyStyle={...button(true),display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8};
    return h('section',{style:{flex:1,display:'flex',flexDirection:'column',minWidth:0,minHeight:0},'aria-label':item.identity.title+'的消息详情'},
      h('header',{className:'lg-glass lg-bar','data-liquid-glass':'','data-scale':'-72','data-chroma':'5','data-border':'.09','data-blur':'2',
        style:{position:'sticky',top:0,zIndex:3,padding:'14px 20px',display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12}},
        h('div',{style:{display:'flex',alignItems:'center',gap:12,minWidth:0,flex:'1 1 auto'}},
          // 只有窄屏才需要：那时左栏被整块换掉，没有这个箭头就回不到入口页。
          // 宽屏下左栏一直在，标题行里的「整理新消息」就是回路，再放一个「再整理一次」
          // 是同一件事说两遍（实测被指出来过）。
          narrow&&h('button',{onClick:()=>store.set({contactKey:null}),'aria-label':'回到整理入口（你想整理什么？）',
            title:'回到「你想整理什么？」',style:{...small(false),padding:'8px 12px',flexShrink:0}},'←'),
          h('div',{style:{minWidth:0}},
            h('h2',{style:{margin:0,fontSize:20,color:C.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},item.identity.title),
            h('p',{style:{margin:'4px 0 0',fontSize:13,color:C.text3}},(item.identity.kind==='group'?'微信群聊':'微信联系人')
              +(isSeen?' · 已看':(item.newCount!=null?(' · '+item.newCount+' 条新消息'):' · 有新动态'))))),
        h('div',{style:{display:'flex',alignItems:'center',gap:8,flexShrink:0}},
          item.following===false
            ? h('button',{onClick:()=>follow(true),disabled:busy,style:small(false)},'恢复关注')
            : h('button',{onClick:()=>follow(false),disabled:busy,style:small(false,false,true)},'忽略这个会话'))),
      h('div',{style:{flex:1,overflowY:'auto',minWidth:0}},
      h('div',{style:{padding:'20px 20px 24px',maxWidth:780}},
        h(Notice,{error:error||detail.error,dev:errorDev||detail.errorDev,code:errorDev?.code||detail.errorCode}),
        h(Result,{text:note}),
        !identityConfirmed&&h('div',{style:{padding:'11px 13px',borderRadius:10,
          border:'1px solid '+(item.identityStatus==='ambiguous'?C.error:C.warn),background:RESULT_BG,marginBottom:14}},
          h('strong',{style:{fontSize:14,color:item.identityStatus==='ambiguous'?C.error:C.text}},
            item.identityStatus==='ambiguous'?'联系人身份有冲突':'联系人身份尚未确认'),
          h('p',{style:{margin:'5px 0 9px',fontSize:13,color:C.text2,lineHeight:1.65}},
            item.identityStatus==='ambiguous'
              ?'检测到同名或相似联系人，但现有证据不足。请先查看原消息，确认当前会话后再绑定。'
              :'当前身份由 OCR 名称和会话特征暂时建立。确认一次后，本地 UUID 会作为长期身份。'),
          h('button',{onClick:confirmIdentity,disabled:busy,style:small(true)},'确认当前联系人')),
        (item.summary&&item.summary.length>0)&&h(Section,{title:'这段时间发生了什么',meta:'AI 总结'},
          h('ul',{style:{margin:'4px 0 0',paddingLeft:20}},item.summary.map(point=>h('li',{key:point,style:{fontSize:14,color:C.text2,lineHeight:1.85,wordBreak:'break-word'}},point))),
          // 总结没出来的时候只有开发者模式能看到原因（模型弃权，或者根本没读到正文）。
          h('div',{style:{marginTop:10}},
            h(DevBox,{dev:item.classificationError?{
              code:item.classificationError.code,
              message:item.classificationError.message,
              detail:item.classificationError.detail,
              at:item.classificationError.at?new Date(item.classificationError.at*1000).toLocaleString('zh-CN'):''
            }:null,label:'这次为什么没整理出来'}))),
        // 助手不再替用户判断这条消息「属于哪一类」。要做什么由用户自己决定，所以这里
        // 把可做的动作平铺出来：起草回复、记成待办、标为已看、看原消息。
        h(Section,{title:'这条你要怎么处理',meta:(item.openTodos||0)>0?('已有 '+item.openTodos+' 件待办'):''},
          h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
            h('button',{onClick:draft,disabled:busy,style:busyStyle},busy&&h(Spinner,{size:14}),busy?'正在起草…':'让助手起草回复'),
            h('button',{onClick:()=>setTodoOpen(value=>!value),disabled:busy,style:button(false)},'记成待办'),
            // 已经标过就是一行状态，不再是按钮：带边框的药丸和旁边的按钮长得一样，看着还想点。
            isSeen
              ? h('span',{style:{display:'inline-flex',alignItems:'center',minHeight:44,padding:'10px 14px',borderRadius:10,background:RESULT_BG,color:C.text2,fontSize:14}},'你已标为已看')
              : h('button',{onClick:seen,disabled:busy,style:busyStyle},busy&&h(Spinner,{size:14}),'标为已看'),
            h('button',{onClick:read,disabled:busy,style:button(false,false,true)},busy?'正在读取…':'看原消息')),
          todoOpen&&h('div',{style:{marginTop:12,border:'1.5px solid '+FIELD_BORDER,borderRadius:12,padding:12,background:FIELD_BG}},
            h('input',{value:todoText,onChange:event=>setTodoText(event.target.value),placeholder:'要做什么？'+(item.summary&&item.summary.length?'（默认：'+firstLine(item.summary[0],20)+'）':''),style:field}),
            h('div',{style:{display:'flex',gap:10,marginTop:10}},
              h('button',{onClick:addTodo,disabled:busy,style:button(true)},busy?'正在保存…':'记成待办'),
              h('button',{onClick:()=>setTodoOpen(false),style:button(false)},'取消')))),
        !!todos.length&&h(Section,{title:'待办',meta:'未完成 '+todos.length+' 件'},
          h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.panel,overflow:'hidden'}},
            todos.map((todo,index)=>h('div',{key:todo.id,style:{display:'flex',gap:10,alignItems:'flex-start',padding:'11px 14px',borderTop:index?'1px solid '+C.border:'none'}},
              h(Checkbox,{checked:false,disabled:busy,label:'标记完成：'+firstLine(todo.title,20),onChange:()=>finishTodo(todo),style:{marginTop:3}}),
              h('div',{style:{flex:1,minWidth:0}},
                h('div',{style:{fontSize:14,color:C.text,lineHeight:1.7,wordBreak:'break-word'}},todo.title),
                h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:4,flexWrap:'wrap'}},
                  todo.state==='doing'&&h('span',{style:pill(C.brand)},'在做'),
                  todo.dueAt&&h('span',{style:pill(dueInfo(todo.dueAt).color)},dueInfo(todo.dueAt).text))))))),
        !!drafts.length&&h(Section,{title:'回复草稿',meta:'等你确认'},drafts.map(draft=>h(DraftCard,{key:draft.id,draft,onChanged:detail.refresh}))),
        h(Fold,{title:'原始消息',meta:item.newCount!=null?(item.newCount+' 条新'):'还没读'},
          !messages.length
            ? h('div',null,
                h('p',{style:hint},'助手还没有读这条会话的正文。'),
                h('button',{onClick:read,disabled:busy,style:{...small(true),display:'inline-flex',alignItems:'center',gap:8}},
                  busy&&h(Spinner,{size:13}),busy?'正在读取微信…':'读取这条会话（会消掉它在微信里的未读红点）'))
            : h('div',{style:{marginTop:4}},
                messages.slice(-30).map((message,index)=>
                  h('div',{key:index,style:{padding:'8px 0',borderBottom:'1px solid '+C.border}},
                    h('div',{style:{fontSize:12,color:C.text3,marginBottom:2}},(message.direction==='outgoing'?'我方':'对方')+(message.sender?(' · '+message.sender):'')),
                    h('p',{style:{margin:0,fontSize:14,color:C.text,lineHeight:1.7,whiteSpace:'pre-wrap',wordBreak:'break-word'}},message.content))))))),
      h(AskDock,{conversationKey:item.key,identity:item.identity,onChanged:detail.refresh,endpoint:'message-center/'+item.key+'/ask'}));
  }

  function MessagesPage({store,narrow}){
    const {contactKey}=useStore(store);
    const center=usePoller(true,()=>api('message-center?scope=all&order=recent&limit=60'),10000);
    // Old continuous-observation rows are not "整理记录". Only show conversations for
    // which the user actually read content or created an action.
    const items=(center.data?.items||[]).filter(item=>item.read||(item.summary&&item.summary.length)
      ||item.openTodos>0||item.pendingDrafts>0);
    // Only judge "the selected conversation is gone" against a payload that was actually
    // fetched for the scope we are showing now. Jumping here from a row's 「去看看」 sets the
    // scope to `all` and the selection at the same time, while `items` still holds the
    // previous scope's page — which of course does not contain it, so the selection was
    // cleared on the spot. That is why the jump looked like it did nothing.
    useEffect(()=>{
      if(!contactKey||!items.length)return;
      if(!items.some(item=>item.key===contactKey))store.set({contactKey:null});
    },[contactKey,items,store]);
    if(center.loading&&!center.data)return h(Empty,{title:'正在打开消息整理',text:'请稍等一下…'});
    if(center.error&&!center.data)return h('div',{style:{padding:24,maxWidth:640}},
      h(Empty,{title:'暂时读不到消息',text:center.error},h('button',{onClick:center.refresh,style:button(true)},'重新读取')),
      h(DevBox,{dev:center.errorDev,code:center.errorCode,label:'读取失败原因'}));
    const item=items.find(entry=>entry.key===contactKey)||null;
    return h('div',{style:{display:'flex',height:'100%',width:'100%',minWidth:0}},
      !narrow&&h('div',{style:{width:340,flexShrink:0,borderRight:'1px solid '+C.border}},h(CenterList,{store,items,narrow:false})),
      item?h(CenterDetail,{key:item.key,store,item,narrow,onChanged:center.refresh})
        :h(OrganizerHome,{items,onChanged:center.refresh,store,narrow}));
  }

  function RuleCard({rule,onAction}){
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
        h('textarea',{value:prompt,onChange:event=>setPrompt(event.target.value),rows:4,style:{...field,resize:'vertical',lineHeight:1.7}}),
        h('p',{style:{...hint,marginTop:8}},'保存后会先暂停自动回复，你确认没问题再重新开启。'),
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
  function AddContactTrigger({purpose,onOpen}){
    return h('button',{onClick:onOpen,style:button(true)},purpose==='crm'?'＋ 添加要跟进的联系人':'＋ 添加自动回复');
  }
  function AddContact({onAdded,purpose,open:openProp,onClose}){
    const controlled=openProp!==undefined;
    const [uncontrolled,setUncontrolled]=useState(false);
    const open=controlled?openProp:uncontrolled;
    const setOpen=value=>{if(controlled){if(!value&&onClose)onClose();}else setUncontrolled(value);};
    const [choices,setChoices]=useState([]),[conversation,setConversation]=useState(''),[prompt,setPrompt]=useState('用自然、友好、简短的中文回复日常聊天；不确定的事情交给我处理。'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[isGroup,setIsGroup]=useState(false);
    async function scan(){setBusy(true);setError('');try{const result=await api('conversations');setChoices(result.conversations||[]);if(result.conversations?.length)setConversation(result.conversations[0].id);}catch(e){setError(e.message);}finally{setBusy(false);}}
    // 打开就自动读一次微信。以前要用户再点一下「读取」才知道有哪些人，等于两步并成一步也没并成。
    useEffect(()=>{if(open&&!choices.length&&!busy)scan();},[open]);
    // The visible WeChat list cannot tell a group from a one-to-one chat (the runtime reports
    // "unknown" for every row), so the person adding it says which it is instead.
    async function add(){const selected=choices.find(choice=>choice.id===conversation);if(!selected){setError('请先选择一个联系人或群聊');return;}setBusy(true);setError('');try{await api('rules',{conversation_id:selected.id,prompt,kind:isGroup?'group':'direct'});setChoices([]);setConversation('');setIsGroup(false);onAdded();setOpen(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
    const crm=purpose==='crm';
    if(!open)return h(AddContactTrigger,{purpose,onOpen:()=>setOpen(true)});
    return h('section',{className:'ma-form','aria-label':crm?'添加要跟进的联系人':'添加自动回复'},
      h('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16,marginBottom:18}},
        h('div',null,
          h('h3',{style:{...h3,marginBottom:5}},crm?'添加要跟进的联系人':'添加自动回复'),
          h('p',{style:{...hint,margin:0}},crm
            ?'先用「从微信读取」把聊天列表读进来，再挑出要跟进的人。加进来只是让它出现在工作台，自动回复保持关闭。'
            :'两步：先选人，再写回复规则。添加后默认关闭，确认无误再开启。')),
        h('button',{onClick:()=>setOpen(false),disabled:busy,style:small(false,false,true)},'关闭')),
      h(Notice,{error}),
      h('div',{className:'ma-form-grid'},
        h('div',null,
          h('label',{style:fieldLabel},'1. 选择联系人或群聊'),
          h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
            h('select',{value:conversation,onChange:event=>setConversation(event.target.value),style:{...selectField,flex:'1 1 200px'},'aria-label':'选择联系人或群聊'},
              !choices.length&&h('option',{value:''},busy?'正在读取微信…':'没有读到聊天，点右边重新读取'),
              choices.map(choice=>h('option',{key:choice.id,value:choice.id},choice.title))),
            h('button',{onClick:scan,disabled:busy,style:button(false)},busy?'正在读取…':'重新读取微信')),
          // 微信列表分不出群聊和单聊，所以由添加的人指明；默认按联系人处理。
          h('label',{style:{display:'flex',alignItems:'center',gap:10,marginTop:12,cursor:'pointer',minHeight:32}},
            h('input',{type:'checkbox',checked:isGroup,onChange:event=>setIsGroup(event.target.checked),style:{width:18,height:18,accentColor:'var(--ma-primary)',cursor:'pointer',margin:0}}),
            h('span',{style:{fontSize:13,color:C.text}},'这是一个群聊'),
            h('span',{style:{fontSize:12,color:C.text3}},'（不勾选按单聊处理）'))),
        h('div',null,
          h('label',{style:fieldLabel},'2. 要自动回复的话，告诉助手怎么回'),
          h('textarea',{value:prompt,onChange:event=>setPrompt(event.target.value),rows:5,style:{...field,resize:'vertical',lineHeight:1.7}}),
          h('p',{style:{...hint,marginTop:8}},crm?'不想让它自动回复也可以，保持关闭就行。':'添加后默认关闭，检查无误再开启。'))),
      h('div',{style:{display:'flex',gap:10,marginTop:18,paddingTop:16,borderTop:'1px solid var(--lg-card-line)'}},
        h('button',{onClick:add,disabled:busy,style:button(true)},busy?'请稍等…':'确定添加'),
        h('button',{onClick:()=>setOpen(false),disabled:busy,style:button(false)},'取消')));
  }

  // ---- 待办（原来叫「今天要做的」）-------------------------------------------
  // 这一页就是待办清单本身：**要做、在做、做完**都在这张单子上。
  //
  // 以前它是另一套东西 —— 会话可以被单独挂进这一页，另有一块由模型给消息打的分类
  // 拼出来的任务区。用户的实际感受是「今天要做的和待办有什么区别」「点了不知道是什么」。
  // 现在只有一条路：要做的事就记成待办，别的都不进这一页。
  function TodoRow({todo,onAction,busy}){
    const due=dueInfo(todo.dueAt),done=todo.state==='done',doing=todo.state==='doing';
    return h('div',{style:{display:'flex',gap:12,alignItems:'flex-start',padding:'13px 15px',borderBottom:'1px solid '+C.border}},
      h(Checkbox,{checked:done,disabled:busy,label:done?'重新打开：「'+firstLine(todo.title,20)+'」':'标记完成：「'+firstLine(todo.title,20)+'」',
        onChange:()=>onAction(done?'reopen':'done',todo),style:{marginTop:3}}),
      h('div',{style:{flex:1,minWidth:0}},
        h('div',{style:{fontSize:15,color:done?C.text3:C.text,lineHeight:1.6,textDecoration:done?'line-through':'none',wordBreak:'break-word'}},todo.title),
        todo.detail&&todo.detail!==todo.title&&h('p',{style:{margin:'5px 0 0',fontSize:13,color:C.text2,lineHeight:1.7,whiteSpace:'pre-wrap',maxHeight:60,overflow:'hidden'}},todo.detail),
        h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:6,flexWrap:'wrap'}},
          doing&&h('span',{style:pill(C.brand)},'在做'),
          !done&&due&&h('span',{style:pill(due.color)},due.text),
          todo.identity&&h('span',{style:{fontSize:13,color:C.text3}},'来自 '+todo.identity.title),
          // 只留一个维度：这条是谁记下来的。
          // 原来这里是两条独立判断 —— 「助手记的」看 source、「自己记的」看有没有挂联系人 ——
          // 于是一条没有联系人的助手待办会同时出现两个标签，互相打架（用户直接说看不懂）。
          h('span',{style:{fontSize:13,color:C.text3}},todo.source==='assistant'?'助手记的':'自己记的'))),
      !done&&h('div',{style:{display:'flex',gap:6,flexShrink:0}},
        h('button',{onClick:()=>onAction(doing?'reopen':'doing',todo),disabled:busy,style:small(false)},doing?'放回待办':'在做'),
        h('button',{onClick:()=>onAction('tomorrow',todo),disabled:busy,style:small(false)},'明天'),
        h('button',{onClick:()=>onAction('delete',todo),disabled:busy,style:small(false,true)},'删除')));
  }

  function TodayPage({store,ctx}){
    const today=usePoller(true,()=>api('today'),8000),[busy,setBusy]=useState(false),[error,setError]=useState(''),[adding,setAdding]=useState(false);
    // 刚勾掉的那条立刻从界面上拿掉，不等下一次轮询。
    // 用户的原话是「点击处理完了，红点过好久才会消失」—— 服务端当场就写好了，只有界面在等。
    // 这一份本地遮盖在 refresh() 真正回来之后清掉，服务端永远是最终依据。
    const [gone,setGone]=useState({});
    const data=today.data,counts=data?.counts||{todos:0,confirm:0,overdue:0,attention:0,automation:0};
    async function act(action,entry){
      setBusy(true);setError('');
      const id=entry.todoId;
      if(action==='done'||action==='delete')setGone(old=>({...old,[id]:true}));
      try{
        if(action==='done')await api('todos/'+id+'/done',{});
        else if(action==='doing')await api('todos/'+id+'/doing',{});
        else if(action==='reopen')await api('todos/'+id+'/reopen',{});
        else if(action==='tomorrow')await api('todos/'+id+'/reopen',{dueAt:fromDateInput(toDateInput(dayStart(1))).toISOString()});
        else if(action==='delete')await api('todos/'+id+'/delete',{});
        // 侧边栏那个红点也要当场少一个，否则"处理完了"之后它还挂着。
        if(action==='done'||action==='delete')store.set({pending:Math.max(0,(store.get().pending||0)-1)});
        await today.refresh();
      }catch(e){setError(e.message);}
      finally{setGone(old=>{const next={...old};delete next[id];return next;});setBusy(false);}
    }
    async function addTodo(_,text,dueAt){try{setAdding(false);await api('todos',{title:text,dueAt,source:'manual'});await today.refresh();}catch(e){setError(e.message);}}
    const go=(key)=>{store.set({tab:'messages',contactKey:key,scope:'all'});};
    const groups=(data?.groups||[]).map(group=>({...group,items:group.items.filter(entry=>!(entry.todoId&&gone[entry.todoId]))}));
    const total=counts.todos+counts.confirm;
    // 首次加载时先给一句"正在打开"，不要先摆出空列表：接口要等 Worker 一圈（实测 0.3–0.8s），
    // 这段时间里页面会显示"没有要做的事"，然后内容突然冒出来 —— 看起来既慢又是错的。
    if(today.loading&&!data)return h('div',{style:{width:'100%',display:'flex'}},
      h(Empty,{title:'正在打开待办',text:'请稍等一下…'}));
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:860}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:16,flexWrap:'wrap'}},
          h('div',null,
            h('h1',h1,'待办'),
            h('p',{style:{margin:'0 0 4px',color:C.text2,fontSize:14,lineHeight:1.8}},total?('还有 '+total+' 件要做。勾掉就完成，做完的收在下面。'):'没有要做的事了。')),
          h('button',{onClick:()=>setAdding(true),style:button(true)},'＋ 加一条待办')),
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
            !items.length&&h('p',{style:{...hint,padding:'10px 0'}},'还没有待办。点右上角「加一条待办」，或者在「消息」里把一件事记成待办。'),
            !!items.length&&h('div',{style:{border:'1px solid '+C.border,borderRadius:14,background:C.panel,overflow:'hidden'}},
              items.map(entry=>{
                if(entry.kind==='new')return h('div',{key:'new',style:{padding:'13px 15px'}},h(Composer,{mode:'todo',fixedMode:true,setMode:()=>{},busy,onSubmit:addTodo}));
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
            group.items.map(entry=>h(Row,{key:entry.id,title:entry.identity.title,right:relativeTime(entry.updatedAt),
              // 写清是谁处理掉的、处理成了什么样。「已处理」三个字既没说人也没说事，
              // 用户看完不知道助手到底做了什么（实测被问过"助手怎么处理呢"）。
              meta:(entry.actor==='you'?'你':'助手')+' · '+firstLine(entry.detail||'处理完了',60)}))))));
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
    const [saving,setSaving]=useState(false),[settingError,setSettingError]=useState('');
    // 「添加」表单的开关挂在页面这一层，不挂在操作条里面 —— 见 AddContact 的说明。
    const [adding,setAdding]=useState(false);
    async function action(path,data){await api(path,data);await status.refresh();}
    const rules=status.data?.rules||[];
    const activeRules=rules.filter(rule=>rule.enabled).length;
    const attentionJobs=rules.filter(rule=>rule.enabled&&['blocked','needs_user','waiting_connection'].includes(rule.status)).length;
    const renderJob=({count,job})=>h('div',{key:job.id,style:{display:'flex',gap:10,alignItems:'baseline',padding:'10px 0',borderTop:'1px solid '+C.border,fontSize:13}},
      h('span',{style:{...pill(job.state==='failed'||job.state==='uncertain'?C.error:C.ok),fontSize:11,padding:'2px 8px'}},JOB[job.state]||'已处理'),
      h('span',{style:{color:C.text2,lineHeight:1.6}},firstLine(job.text||job.detail||'',80)+(count>1?'（同类 '+count+' 条）':'')));
    const paused=settings.data?.settings?.auto_reply_paused===true;
    async function togglePaused(){
      setSaving(true);setSettingError('');
      try{await api('settings',{auto_reply_paused:!paused});settings.refresh();}
      catch(e){setSettingError(e.message);}finally{setSaving(false);}
    }
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{width:'100%',boxSizing:'border-box',padding:'28px clamp(24px,4vw,52px) 64px',maxWidth:1180,margin:'0 auto'}},
        // 英雄区：一块玻璃板，不再是绿色大色块。装饰圆换成很淡的品牌色，
        // 只当玻璃上的折射依据，不再当主视觉。
        h('section',{className:'lg-hero',style:{padding:'28px clamp(22px,4vw,38px)',marginBottom:20}},
          h('span',{style:{position:'absolute',width:220,height:220,borderRadius:'50%',right:-65,top:-105,background:'rgba(7,193,96,.1)'}}),
          h('span',{style:{position:'absolute',width:130,height:130,borderRadius:'50%',right:120,bottom:-95,background:'rgba(64,198,214,.13)'}}),
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
              h('h1',{style:{...h1,color:C.text,fontSize:30,marginBottom:9}},'把重复消息交给助手'),
              h('p',{style:{margin:0,color:C.text2,fontSize:14,lineHeight:1.8}},'只监听你选中的联系人和群聊。每条规则独立启停，遇到需要本人决定的内容会停下来交给你。')),
            h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
              [[String(rules.length),'已添加'],[String(activeRules),'运行中'],[String(attentionJobs),'需处理']].map(([value,label])=>
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
            h('p',{style:{...hint,margin:0}},'添加后默认暂停，确认规则再开启。')),
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
          rules.map(rule=>h(RuleCard,{key:rule.id,rule,onAction:action}))),
        h('section',{style:{...card,display:'flex',justifyContent:'space-between',alignItems:'center',gap:16,flexWrap:'wrap',marginTop:22,boxShadow:'none'}},
          h('div',{style:{display:'flex',gap:12,alignItems:'center',minWidth:240,flex:1}},
            h('span',{style:{width:38,height:38,borderRadius:12,display:'flex',alignItems:'center',justifyContent:'center',background:'var(--ma-warning-soft)',color:C.warn}},h(Icon,{name:'settings',size:18})),
            h('div',null,h('strong',{style:{display:'block',fontSize:14,color:C.text}}, '自动回复值守'),
              h('span',{style:{fontSize:12,color:C.text3,lineHeight:1.65}},'关闭后暂停自动回复：不再读取新消息、不生成也不发送回复，随时可恢复。'))),
          h(Toggle,{on:!paused,onClick:togglePaused,busy:saving,disabled:!settings.data,label:!paused?'值守中':'已暂停'})),
        !!status.data?.jobs?.length&&h('details',{style:{...card,marginTop:14,boxShadow:'none'}},
          h('summary',{style:{cursor:'pointer',fontSize:14,fontWeight:650,color:C.text}},'最近处理记录'),
          h('div',{style:{marginTop:12}},
            foldJobRuns(status.data.jobs).slice(0,15).map(renderJob)))));
  }

  // ---- 回复配置：说话方式 + 产品与政策 ----------------------------------------
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
    const [choices,setChoices]=useState([]),[conversation,setConversation]=useState('');
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[errorCode,setErrorCode]=useState(''),[result,setResult]=useState(null);
    async function scan(){setBusy(true);setError('');setErrorCode('');try{const r=await api('conversations');setChoices(r.conversations||[]);if(r.conversations?.length)setConversation(r.conversations[0].id);}catch(e){setError(e.message);setErrorCode(e.code||'');}finally{setBusy(false);}}
    async function analyze(){
      const selected=choices.find(c=>c.id===conversation);
      if(!selected){setError('请先选一个会话');return;}
      setBusy(true);setError('');setErrorCode('');
      try{
        const r=await api('context/profiles/analyze',{provider:'wechat-main',conversation:selected.id});
        setResult(r);
      }catch(e){
        setErrorCode(e.code||'');
        setError(e.code==='conversation_unverified'
          ?'后台已经定位到这条会话，但暂时无法确认打开的是不是它。请让这条会话保持在微信左侧当前可见列表中，刷新列表后再试。'
          :e.code==='conversation_not_found'||e.code==='conversation_not_visible'
          ?'这个会话已不在微信当前可见列表中。请滚动到它所在的位置，刷新列表后再试。'
          :e.message);
      }finally{setBusy(false);}
    }
    const selected=choices.find(c=>c.id===conversation);
    return h('div',{style:{...card,padding:20,boxShadow:'var(--lg-card-shadow)',borderColor:'rgba(7,193,96,.26)'}},
      h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:6}},
        h('div',{style:{fontSize:16,fontWeight:700,color:C.text}},'从聊天分析说话方式'),
        h('span',{style:{...pill(C.ok),background:'var(--ma-success-soft)',fontSize:11}},'后台只读 · 不发消息')),
      h('p',{style:{...hint,margin:'0 0 18px',maxWidth:720}},'助手只学习你发出去的消息，生成一份可编辑的语气草稿；你确认并启用后，才会用于自动回复。'),
      h(Notice,{error,code:errorCode}),
      h('label',{style:fieldLabel},'选择一个会话'),
      h('div',{style:{display:'grid',gridTemplateColumns:'minmax(0,1fr) auto',gap:10,alignItems:'center'}},
        h('select',{value:conversation,onChange:event=>setConversation(event.target.value),disabled:busy,style:selectField},
          !choices.length&&h('option',{value:''},busy?'正在读取微信…':'先读取微信当前可见会话'),
          choices.map(c=>h('option',{key:c.id,value:c.id},c.title))),
        h('button',{onClick:scan,disabled:busy,style:button(false)},choices.length?'刷新列表':'读取会话')),
      !result&&selected&&h('div',{style:{marginTop:12,padding:'11px 13px',borderRadius:'var(--lg-r-sm)',backgroundColor:FIELD_BG,border:'1px solid var(--lg-card-line)',fontSize:12,color:C.text2,lineHeight:1.7}},
        '助手会按当前列表中的会话 ID 在后台读取，不依赖 OCR 识别出的人名，也不需要把微信切到前台。'),
      busy&&h('div',{role:'status',style:{display:'flex',alignItems:'center',gap:12,marginTop:12,padding:'13px 15px',borderRadius:12,background:'var(--ma-primary-soft)',color:C.brand}},
        h('strong',{style:{fontSize:20,minWidth:24,textAlign:'center'}},'…'),
        h('div',null,h('strong',{style:{display:'block',fontSize:13}},'正在后台读取聊天'),
          h('span',{style:{display:'block',fontSize:12,marginTop:2}},'可以留在当前页面；只读取，不会发送消息'))),
      result&&h('div',{style:{marginTop:12,border:'1px solid var(--lg-card-line)',borderRadius:'var(--lg-r-md)',padding:14,backgroundColor:FIELD_BG}},
        h('div',{style:{fontSize:14,color:C.text,marginBottom:6}},'已生成「'+result.profile.name+'」（草稿，'+result.outgoingCount+' 条我方消息）'),
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

  // 批量导入：产品与政策多半早就写好了（文档、在线文档、网站条款），一条条手敲不现实。
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
        h('div',null,h('label',{style:fieldLabel},'这些条目统一归到'),h('select',{value:kind,onChange:event=>setKind(event.target.value),style:selectField},KNOWLEDGE_KINDS.map(([value,text])=>h('option',{key:value,value:value},text)))),
        h('div',null,h('label',{style:fieldLabel},'统一风险等级'),h('select',{value:risk,onChange:event=>setRisk(event.target.value),style:selectField},KNOWLEDGE_RISK.map(([value,text])=>h('option',{key:value,value:value},text))))),
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
        h('div',null,h('label',{style:fieldLabel},'分类'),h('select',{value:kind,onChange:event=>setKind(event.target.value),style:selectField},KNOWLEDGE_KINDS.map(([value,text])=>h('option',{key:value,value:value},text)))),
        h('div',null,h('label',{style:fieldLabel},'风险等级'),h('select',{value:risk,onChange:event=>setRisk(event.target.value),style:selectField},KNOWLEDGE_RISK.map(([value,text])=>h('option',{key:value,value:value},text))))),
      h('div',{style:{marginTop:12}},h('label',{style:label},'标题'),h('input',{value:title,onChange:event=>setTitle(event.target.value),placeholder:'例如：营业时间、退货政策',style:field})),
      h('div',{style:{marginTop:12}},h('label',{style:label},'内容'),h('textarea',{value:content,onChange:event=>setContent(event.target.value),rows:4,placeholder:'助手能引用的事实。写清楚、不含糊，避免金额/时间这类会变的信息（那些要人工确认）。',style:{...field,resize:'vertical',lineHeight:1.7}})),
      h(Notice,{error}),
      h('div',{style:{display:'flex',gap:10,marginTop:12}},
        h('button',{onClick:save,disabled:busy,style:button(true)},busy?'正在保存…':(initial?'保存修改':'创建（存为草稿）')),
        initial&&h('button',{onClick:onCancel,disabled:busy,style:button(false)},'取消')));
  }

  function KnowledgeCard({k,onAct}){
    const [editing,setEditing]=useState(false);
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
        h('button',{onClick:()=>setEditing(true),style:small(false)},'编辑')));
  }

  function KnowledgeSection({data,refresh,filter,setFilter}){
    const [open,setOpen]=useState(false),[importOpen,setImportOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const items=data?.items||[],shown=filter==='all'?items:items.filter(k=>k.status===filter);
    const act=async fn=>{setBusy(true);setError('');try{await fn();refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
    return h('section',{style:{marginBottom:20}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,marginBottom:12}},
        h('div',null,h('h2',{style:{...h2,margin:0}},'产品与政策'),h('span',{style:{fontSize:13,color:C.text3}},'助手能引用的事实，发布后才生效')),
        h('div',{style:{display:'flex',gap:8,flexShrink:0}},
          h('button',{onClick:()=>{setImportOpen(value=>!value);setOpen(false);},style:small(!importOpen)},importOpen?'收起':'批量导入'),
          h('button',{onClick:()=>{setOpen(value=>!value);setImportOpen(false);},style:small(!open)},open?'收起':'＋ 新增'))),
      h(Notice,{error}),
      importOpen&&h(KnowledgeImport,{onDone:()=>{setImportOpen(false);refresh();},onCancel:()=>setImportOpen(false)}),
      open&&h(KnowledgeForm,{onDone:()=>{setOpen(false);refresh();}}),
      h('div',{style:{display:'flex',gap:8,flexWrap:'wrap',margin:'4px 0 14px'}},[['published','已发布'],['draft','草稿'],['retired','已停用'],['all','全部']].map(([value,text])=>
        h('button',{key:value,onClick:()=>setFilter(value),'aria-pressed':filter===value,style:{...pill(filter===value?C.brand:null),background:filter===value?C.hover:'transparent',cursor:'pointer',minHeight:36}},text))),
      !shown.length&&h('p',{style:hint},'还没有这个状态下的知识。点「＋ 新增」写一条，发布后助手遇到相关问题就能引用。'),
      shown.map(k=>h(KnowledgeCard,{key:k.id,k,onAct:act})));
  }

  function ContextPage(){
    const profiles=usePoller(true,()=>api('context/profiles'),8000);
    const knowledge=usePoller(true,()=>api('context/knowledge'),8000);
    const [kFilter,setKFilter]=useState('published');
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:900}},
        // 功能层：页面标题条。sticky + 玻璃，正文从它背后过。
        // 同自动回复页：滚动区里的 sticky 元素不做折射（每帧重跑滤镜，见那边的说明）。
        h('div',{className:'lg-glass ma-pagebar'},
          h('h1',{style:{...h1,margin:0}},'回复配置')),
        h('p',{style:{margin:'0 0 4px',color:C.text2,fontSize:14,lineHeight:1.8,maxWidth:640}},'这里决定助手「像谁、知道什么」。说话方式控制语气和禁用词；产品与政策是它能引用的可靠事实。没配的时候，助手按通用方式自然回复，涉及退款、报价、时间承诺这些会主动交给你。'),
        h(Notice,{error:profiles.error||knowledge.error}),
        h(ProfilesSection,{data:profiles.data,refresh:profiles.refresh}),
        h(KnowledgeSection,{data:knowledge.data,refresh:knowledge.refresh,filter:kFilter,setFilter:setKFilter})));
  }

  function SettingsPage(){
    const status=usePoller(true,()=>api('status'),10000),data=status.data;
    const settings=usePoller(true,()=>api('settings'),15000);
    const catalog=usePoller(true,()=>api('models'),60000);
    const [savingModel,setSavingModel]=useState(false),[modelError,setModelError]=useState('');
    const ok=data&&!data.error;
    const autoModel=settings.data?.settings?.auto_model||data?.model||'';
    const listedModels=catalog.data?.models||[];
    const models=autoModel&&!listedModels.some(model=>model.id===autoModel)?[{id:autoModel,name:autoModel},...listedModels]:listedModels;
    async function changeAutoModel(event){
      const model=event.target.value;
      if(!model||model===autoModel)return;
      setSavingModel(true);setModelError('');
      try{await api('settings',{auto_model:model});settings.refresh();status.refresh();}
      catch(e){setModelError(e.message);}finally{setSavingModel(false);}
    }
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:760}},
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
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'自动回复模型'),
          h('p',{style:{...hint,margin:'0 0 12px'}},'只影响后台自动消息任务，不会改变你在聊天页手动选择的模型。修改后从下一条新消息开始生效。'),
          h('select',{value:autoModel,onChange:changeAutoModel,disabled:savingModel||!settings.data||!models.length,'aria-label':'自动回复模型',style:selectField},
            !models.length&&h('option',{value:''},catalog.loading?'正在读取模型…':'暂无可用模型'),
            models.map(model=>h('option',{key:model.id,value:model.id},model.name===model.id?model.id:(model.name+' · '+model.id)))),
          savingModel&&h('p',{style:{...hint,margin:'8px 0 0'}},'正在保存…')),
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'开发者模式'),
          h('p',{style:{...hint,margin:'0 0 12px'}},'打开后，界面上出错的地方会多出一块折叠的「开发者详情」：Runtime 的错误码、它自己的原文、调用栈和读取到的条数，都可以一键复制。定位「读不到消息」「助手判断不出来」时用它。上线前关掉即可，用户侧不会看到任何原始报错。原始日志另外逐条记在数据目录的 dev-errors.log 里。'),
          h(DevToggle,{})),
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'数据保存在哪'),
          h('p',{style:{...hint,margin:'0'}},'自动回复规则和发送记录保存在本机的 reply.db。主动查询消息时，助手通过消息 MCP 按你的要求读取，不会创建后台整理任务。')),
        data&&h('details',{style:{marginTop:16,color:C.text2}},
          h('summary',{style:{cursor:'pointer',fontSize:15}},'高级信息'),
          h('div',{style:{marginTop:12,padding:16,borderRadius:10,background:C.panel,fontSize:14,lineHeight:2,color:C.text2}},
            h('div',null,'处理引擎：'+data.agent),
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
  const NAV=[['automation','自动回复'],['context','回复配置']];
  const NAV_ICON={messages:'messages',today:'today',customers:'contacts',automation:'automation',context:'context'};
  function NavEntry({store,wide}){
    const {open}=useStore(store);
    return h('button',{onClick:()=>store.set({open:!open,cover:true,tab:'automation'}),title:'自动回复',
      style:{display:'flex',alignItems:'center',gap:10,width:'100%',minHeight:44,padding:'10px 12px',border:'none',borderRadius:10,cursor:'pointer',background:open?C.hover:'transparent',color:C.text,fontSize:14}},
      h(Icon,{name:'automation',size:18}),wide&&h('span',null,'自动回复'));
  }
  /**
   * Closed used to mean "hand the screen back to the DSH web UI", which is a developer
   * surface: workspaces, model pickers, tool JSON. The product covers it instead and keeps
   * a discreet way back in for whoever is building the thing.
   */
  function Cover({store}){
    return h('div',{'data-ma':'cover',style:{position:'fixed',inset:0,zIndex:60,background:C.bg,color:C.text,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14,padding:32,textAlign:'center'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:10}},h(Icon,{name:'automation',size:28}),h('strong',{style:{fontSize:21}},'自动回复助手')),
      h('p',{style:{margin:0,color:C.text3,fontSize:14,lineHeight:1.85,maxWidth:380}},
        '助手会继续在后台值守指定联系人。想主动查某个人的消息，直接回到对话框告诉助手。'),
      h('button',{onClick:()=>store.set({open:true,tab:'automation'}),style:{...button(true),minWidth:180,marginTop:6}},'管理自动回复'),
      h('button',{onClick:()=>store.set({cover:false}),
        style:{marginTop:6,border:'none',background:'transparent',color:C.text3,fontSize:13,cursor:'pointer'}},'回到对话框'));
  }
  function Workbench({ctx,store}){
    const {open,cover,tab}=useStore(store),[narrow,setNarrow]=useState(()=>matchMedia('(max-width: 900px)').matches),closeRef=useRef(null),rootRef=useRef(null);
    useEffect(()=>{const media=matchMedia('(max-width: 900px)'),change=()=>setNarrow(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
    useEffect(()=>{if(!open)return;const key=event=>{if(event.key==='Escape')store.set({open:false,cover:false});};document.addEventListener('keydown',key);closeRef.current?.focus();return()=>document.removeEventListener('keydown',key);},[open,store]);
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
      h('style',null,'[data-ma] button{transition:background var(--lg-dur-1) var(--lg-ease-smooth),border-color var(--lg-dur-1) var(--lg-ease-smooth),color var(--lg-dur-1) var(--lg-ease-smooth),box-shadow var(--lg-dur-1) var(--lg-ease-smooth),transform var(--lg-dur-1) var(--lg-ease-interactive),filter var(--lg-dur-1) var(--lg-ease-smooth)}[data-ma] button:not(:disabled):hover{filter:brightness(1.04)}[data-ma] button:not(:disabled):active{transform:scale(.975)}[data-ma] button:focus-visible,[data-ma] input:focus-visible,[data-ma] textarea:focus-visible,[data-ma] select:focus-visible{outline:3px solid var(--ma-primary);outline-offset:2px}[data-ma] button:disabled{opacity:.55;cursor:not-allowed}[data-ma] summary{cursor:pointer}[data-ma] input[type="checkbox"]{accent-color:var(--ma-primary)}[data-ma] .ma-pulse{animation:ma-pulse 1.3s ease-in-out infinite}@keyframes ma-pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.1)}}[data-ma] .ma-spin{animation:ma-spin .8s linear infinite}@keyframes ma-spin{to{transform:rotate(360deg)}}[data-ma] .ma-track-fill{animation:ma-track 1.6s ease-in-out infinite}@keyframes ma-track{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}@media(max-width:1100px){[data-ma] .ma-rule-grid{grid-template-columns:1fr!important}}@media (prefers-reduced-motion: reduce){[data-ma] .ma-pulse,[data-ma] .ma-spin,[data-ma] .ma-track-fill{animation:none}[data-ma] .ma-track-fill{width:100%;opacity:.5}[data-ma] button:not(:disabled):active{transform:none!important}}'),
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
        h('div',{className:'lg-railfoot'},
          h('button',{onClick:()=>store.set({tab:'settings'}),'aria-current':tab==='settings'?'page':undefined,title:'设置',
            'data-active':tab==='settings'?'':undefined,className:'lg-navitem',
            style:{minHeight:46,padding:'11px 12px',cursor:'pointer',textAlign:narrow?'center':'left',fontSize:14,display:'flex',alignItems:'center',gap:10,justifyContent:narrow?'center':'flex-start'}},
            h(Icon,{name:'settings',size:18}),narrow?null:'设置'),
          h('button',{ref:closeRef,onClick:()=>store.set({open:false,cover:false}),title:'回到对话框',className:'lg-navitem lg-quiet',style:{minHeight:42,padding:'9px 12px',cursor:'pointer',fontSize:13,textAlign:narrow?'center':'left'}},narrow?'返回':'← 回到对话框'))),
      h('main',{'data-ma':'main',style:{flex:1,minWidth:0,height:'100%',display:'flex',overflow:'hidden',position:'relative',zIndex:1}},
        tab==='automation'?h(AutomationPage)
          :tab==='context'?h(ContextPage)
          :h(SettingsPage)));
  }
  const TOOL_NAMES=['mcp__messaging__list_conversations','mcp__messaging__read_messages','mcp__messaging__sync_conversation','mcp__messaging__search_messages','mcp__messaging__send_message','mcp__messaging__reply_message','mcp__messaging__get_send_status','submit_reply_decision'];
  return{inject:['slots','sessions'],apply(ctx){
    const saved=readSaved(),allowedTabs=['automation','context','settings'],store=createStore({open:saved.open===undefined?true:saved.open,cover:saved.cover===undefined?true:saved.cover,tab:allowedTabs.includes(saved.tab)?saved.tab:'automation',contactKey:null,customerKey:null,filter:'all',scope:'attention',order:'recent',pending:0});
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
