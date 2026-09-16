window.__ModuleLoader__.load({id:'messaging-agent-ui',factory:(require)=>{
  const React=require('react');
  const h=React.createElement;
  const {useEffect,useRef,useState,useSyncExternalStore,useCallback}=React;

  async function api(path,data){
    const response=await fetch('/message-agent/api/'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){const error=Error(result.error||'操作没有完成，请稍后再试');error.code=result.code;error.dev=result.dev||null;throw error;}
    return result;
  }
  async function mutate(path,method,data){
    const response=await fetch('/message-agent/api/'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){const error=Error(result.error||'操作没有完成，请稍后再试');error.code=result.code;error.dev=result.dev||null;throw error;}
    return result;
  }
  async function loadInbox(signal){
    const items=[];let cursor='';
    for(let page=0;page<20;page++){
      const response=await fetch('/message-agent/api/inbox?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{signal});
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw Error(result.error||'暂时无法读取消息');
      items.push(...(result.items||[]));cursor=result.nextCursor||'';if(!cursor)break;
    }
    return {items};
  }

  const C={bg:'var(--dsw-alias-bg-base)',panel:'var(--dsw-alias-bg-layer-1)',hover:'var(--dsw-alias-bg-layer-2)',border:'var(--dsw-alias-border-l1)',text:'var(--dsw-alias-label-primary)',text2:'var(--dsw-alias-label-secondary)',text3:'var(--dsw-alias-label-tertiary)',brand:'var(--dsw-alias-brand-primary)',error:'var(--dsw-alias-state-error-primary)',ok:'var(--dsw-alias-state-success-primary)',warn:'var(--dsw-alias-state-warn-primary)'};
  const button=(primary,danger,quiet)=>({minHeight:44,padding:'10px 18px',border:'1px solid '+(danger?C.error:primary?C.brand:quiet?'transparent':C.border),borderRadius:10,cursor:'pointer',background:primary?C.brand:'transparent',color:danger?C.error:primary?'var(--dsw-alias-bg-base)':quiet?C.text2:C.text,fontSize:14,fontWeight:primary?600:400,boxSizing:'border-box'});
  const small=(primary,danger)=>({...button(primary,danger),minHeight:36,padding:'7px 13px',fontSize:13});
  const field={width:'100%',boxSizing:'border-box',minHeight:46,padding:'11px 13px',border:'1px solid '+C.border,borderRadius:10,background:C.panel,color:C.text,fontSize:15};
  const dateField={...field,minHeight:44,minWidth:150,fontSize:14};
  const pill=(color)=>({display:'inline-flex',alignItems:'center',padding:'3px 11px',borderRadius:99,border:'1px solid '+(color||C.border),color:color||C.text2,fontSize:13,whiteSpace:'nowrap',lineHeight:1.5});
  const card={padding:18,border:'1px solid '+C.border,borderRadius:14,background:C.panel,marginBottom:14};
  const hint={fontSize:13,color:C.text3,lineHeight:1.7};
  const h1={margin:'0 0 6px',fontSize:23,color:C.text};
  const h2={margin:'0 0 12px',fontSize:16,color:C.text};
  const h3={margin:'0 0 10px',fontSize:15,color:C.text};

  // Every label answers "what does this mean for me", never which subsystem produced it.
  const PROCESSING={paused:'自动回复已暂停',listening:'自动回复中',waiting_visible:'等这个联系人出现在微信里',waiting_connection:'暂时读不到微信',settling:'发现新消息',starting:'正在启动',queued:'排队中',generating:'正在准备回复',ready:'回复已备好',sending:'正在发送',blocked:'需要你处理',needs_user:'需要你处理',resyncing:'正在重新读取'};
  const JOB={queued:'排队中',generating:'正在准备回复',ready:'回复已备好',sending:'正在发送',sent:'已发送',failed:'没有处理成功',cancelled:'已取消',uncertain:'发送结果待确认',not_sent:'没有发出去',done:'处理完成',skipped:'无需回复',skip:'无需回复',needs_user:'交给你处理',expired:'已过期'};
  const RULE_STATUS={blocked:'需要你处理',needs_user:'需要你处理',waiting_connection:'暂时读不到微信',listening:'自动回复中',paused:'自动回复已暂停',waiting_visible:'等它出现在微信列表'};
  const FILTERS=[['all','全部'],['pending','待我处理'],['processing','处理中'],['error','需要检查']];
  const GROUPS_TODAY={decide:'需要你决定',confirm:'等你确认发送',todos:'我记的待办',handled:'助手已处理'};

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
  function Toggle({on,onClick,busy,disabled,label}){
    return h('button',{onClick,disabled:busy||disabled,'aria-pressed':!!on,
      style:{display:'inline-flex',alignItems:'center',gap:9,minHeight:40,padding:'8px 14px',borderRadius:99,cursor:busy||disabled?'default':'pointer',
        border:'1px solid '+(on?C.brand:C.border),background:on?C.hover:'transparent',color:on?C.brand:C.text2,fontSize:14,opacity:disabled?0.5:1}},
      h('span',{style:{width:34,height:18,borderRadius:99,background:on?C.brand:C.border,position:'relative',flexShrink:0,transition:'background .15s'}},
        h('span',{style:{position:'absolute',top:2,left:on?18:2,width:14,height:14,borderRadius:'50%',background:C.bg,transition:'left .15s'}})),
      busy?'正在保存…':label);
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
    return h('img',{src:'/message-agent/assets/brand/message-agent-symbol.png',width:size,height:size,className,alt:'','aria-hidden':'true',
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
  function Notice({error,dev,code}){
    if(!error&&!dev&&!code)return null;
    return h('div',null,
      error&&h('div',{role:'alert',style:{padding:'11px 13px',borderRadius:10,border:'1px solid '+C.error,color:C.error,fontSize:14,lineHeight:1.6,marginBottom:12}},error),
      h(DevBox,{dev,code}));
  }
  function Status({item}){
    if(item.bucket==='pending')return h('span',{style:pill(C.warn)},'等你处理');
    if(item.bucket==='processing')return h('span',{style:pill(C.brand)},PROCESSING[item.processingState]||'处理中');
    if(item.bucket==='error')return h('span',{style:pill(C.error)},'需要检查');
    if(!item.rule.enabled)return h('span',{style:pill()},'自动回复已暂停');
    return h('span',{style:pill(C.ok)},'自动回复中');
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

  // ---- inbox ---------------------------------------------------------------
  function InboxList({store,items,narrow}){
    const {contactKey,filter}=useStore(store),[query,setQuery]=useState(''),listRef=useRef(null);
    const needle=query.trim().toLowerCase();
    const shown=items.filter(item=>(filter==='all'||item.bucket===filter)&&(!needle||item.identity.title.toLowerCase().includes(needle)||(item.summary||'').toLowerCase().includes(needle)));
    function onKey(event){
      if(!['ArrowDown','ArrowUp','Enter',' '].includes(event.key))return;
      const nodes=[...listRef.current.querySelectorAll('[data-inbox-item]')],index=nodes.indexOf(document.activeElement);
      if(event.key==='Enter'||event.key===' '){if(index>=0)nodes[index].click();return;}
      event.preventDefault();
      const next=event.key==='ArrowDown'?Math.min(nodes.length-1,index+1):Math.max(0,index-1);
      if(nodes[next])nodes[next].focus();
    }
    return h('section',{style:{display:'flex',flexDirection:'column',height:'100%',minWidth:0},'aria-label':'消息列表'},
      h('header',{style:{padding:narrow?'14px 14px 10px':'18px 18px 12px',borderBottom:'1px solid '+C.border}},
        h('h1',{style:{...h1,fontSize:20,marginBottom:12}},'消息'),
        h('input',{value:query,onChange:event=>setQuery(event.target.value),placeholder:'搜索联系人或内容','aria-label':'搜索消息',style:field}),
        h('div',{style:{display:'flex',gap:8,overflowX:'auto',paddingTop:11}},FILTERS.map(([value,label])=>
          h('button',{key:value,onClick:()=>store.set({filter:value}),'aria-pressed':filter===value,style:{...pill(filter===value?C.brand:null),background:filter===value?C.hover:'transparent',cursor:'pointer',minHeight:36}} ,label)))),
      h('div',{ref:listRef,role:'listbox',onKeyDown:onKey,style:{flex:1,overflowY:'auto'}},
        !shown.length&&h('p',{style:{padding:24,textAlign:'center',color:C.text3,fontSize:14,lineHeight:1.8}},needle?'没有找到相关消息':'这里暂时没有内容'),
        shown.map(item=>h(Row,{key:item.key,title:item.identity.title,right:relativeTime(item.updatedAt),meta:item.attentionReason||item.summary||PROCESSING[item.processingState]||'等待新消息',active:contactKey===item.key,inboxItem:true,onClick:()=>store.set({contactKey:item.key,tab:'messages'})},
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:8}},h(Status,{item}),item.identity.kind==='group'&&h('span',{style:{fontSize:13,color:C.text3}},'群聊'))))));
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
  function answerListItems(text){
    const items=[];
    for(const raw of String(text||'').split('\n')){
      const match=raw.match(/^\s*(?:[-*+]\s*)?(?:\[[ xX]?\]|[☐□])\s*(.{2,80}?)\s*$/);
      if(match)items.push(match[1].replace(/[*`]/g,'').replace(/[。；;,，]+$/,'').trim());
    }
    return items.filter(Boolean).slice(0,8);
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
        setNote('✓ 已记下 '+items.length+' 条待办，在「今天要做的」里');
        onChanged&&onChanged();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    async function saveFollowup(){
      setBusy(true);setError('');setNote('');
      try{
        await api('customers/'+conversationKey+'/followups',{kind:'助手摘要',note:answer.answer,evidence:toolText(answer.tools)});
        setNote('✓ 已存为跟进记录');
        onChanged&&onChanged();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    const items=answer?answerListItems(answer.answer):[];
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
        answer&&h('div',{style:{border:'1px solid '+C.border,borderRadius:12,background:C.panel,marginBottom:10,maxHeight:'44vh',overflowY:'auto'}},
          h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline',padding:'11px 15px',borderBottom:'1px solid '+C.border,position:'sticky',top:0,background:C.panel}},
            h('span',{style:{fontSize:13,color:C.text3,minWidth:0,wordBreak:'break-word'}},'你问：'+asked),
            h('button',{onClick:()=>{setAnswer(null);setNote('');},'aria-label':'关闭回答',style:{...small(false,false,true),flexShrink:0}},'关闭')),
          h('p',{style:{margin:0,padding:'14px 15px',fontSize:15,lineHeight:1.85,color:C.text,whiteSpace:'pre-wrap',wordBreak:'break-word'}},answer.answer),
          !!items.length&&h('div',{style:{padding:'0 15px 14px'}},
            h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:6}},
              h('span',{style:{fontSize:13,color:C.text3}},'以上可以直接变成待办'),
              h('button',{onClick:()=>addTodos(items),disabled:busy,style:small(true)},busy?'正在记…':'全部记成待办')),
            items.map((item,index)=>h('div',{key:item+index,style:{display:'flex',gap:10,alignItems:'flex-start',padding:'9px 0',borderTop:'1px solid '+C.border}},
              h('span',{style:{flex:1,minWidth:0,fontSize:14,color:C.text2,lineHeight:1.7}},item),
              h('button',{onClick:()=>addTodos([item]),disabled:busy,style:{...small(false),flexShrink:0}},'记成待办')))),
          h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center',padding:'0 15px 14px'}},
            h('button',{onClick:saveFollowup,disabled:busy,style:small(false)},busy?'正在保存…':'存为跟进记录'),
            evidence&&h('span',{style:{fontSize:13,color:C.text3}},evidence),
            note&&h('span',{style:{fontSize:13,color:C.ok,lineHeight:1.6}},note))),
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
    const todos=(data?.todos||[]).filter(todo=>todo.state==='open'),doneTodos=(data?.todos||[]).filter(todo=>todo.state!=='open');
    const followups=data?.followups||[];

    async function run(action){setBusy(true);setActionError('');try{await action();onChanged();}catch(e){setActionError(e.message);}finally{setBusy(false);}}
    const saveCustomer=()=>run(()=>api('customers/'+customerKey,{stage,nextStep,note}));
    const addTodo=(_,text,dueAt)=>run(()=>api('todos',{conversationKey:customerKey,title:text,dueAt,source:'manual'}));
    const addFollowup=(_,text)=>run(()=>api('customers/'+customerKey+'/followups',{kind:'记录',note:text}));
    const finish=todo=>run(()=>api('todos/'+todo.id+'/done',{}));
    const postpone=todo=>run(()=>api('todos/'+todo.id+'/reopen',{dueAt:fromDateInput(toDateInput(dayStart(1))).toISOString()}));
    const removeTodo=todo=>run(()=>api('todos/'+todo.id+'/delete',{}));

    function todoLine(todo,index){
      const due=dueInfo(todo.dueAt);
      return h('div',{key:todo.id,style:{display:'flex',gap:12,alignItems:'flex-start',padding:'12px 15px',borderTop:index?'1px solid '+C.border:'none'}},
        h('button',{onClick:()=>finish(todo),disabled:busy,title:'标记完成','aria-label':'标记完成','data-todo-toggle':'open',
          style:{width:22,height:22,marginTop:2,borderRadius:6,border:'1px solid '+C.border,background:'transparent',cursor:'pointer',flexShrink:0,color:C.text3,fontSize:13,lineHeight:1,padding:0}},'✓'),
        h('div',{style:{flex:1,minWidth:0}},
          h('div',{style:{fontSize:15,color:C.text,lineHeight:1.6,wordBreak:'break-word'}},todo.title),
          (due||todo.source==='assistant')&&h('div',{style:{display:'flex',gap:8,marginTop:5,flexWrap:'wrap'}},
            due&&h('span',{style:pill(due.color)},due.text),
            todo.source==='assistant'&&h('span',{style:{fontSize:13,color:C.text3}},'助手记的'))),
        h('div',{style:{display:'flex',gap:6,flexShrink:0}},
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
    const header=h('header',{style:{position:'sticky',top:0,zIndex:1,padding:'14px 20px',borderBottom:'1px solid '+C.border,background:C.bg,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}},
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
  const SCOPE_TABS=[['attention','待我处理'],['new','新消息'],['all','全部']];
  const CLASS_LABEL={reply:'需要回复',action:'需要处理',fyi:'只需了解',unknown:'无法判断'};
  const CLASS_PILL={reply:C.warn,action:C.brand,fyi:null,unknown:C.text3};
  const ACTION_CLASSES=['reply','action','fyi','unknown'];

  function CenterRow({item,active,onClick}){
    const suggestion=item.classified?CLASS_LABEL[item.classification]:'待判断';
    const meta=(item.summary&&item.summary.length)?firstLine(item.summary[0],44):(item.read?'已读取正文':'尚未读取正文');
    const extra=[
      item.following===false?'已忽略':'',
      item.pendingDrafts>0?'草稿待确认':'',
      item.openTodos>0?(item.openTodos+' 件待办'):'',
      item.automationState==='active'?'自动回复：开':'',
      item.automationProblem?'自动回复异常':''
    ].filter(Boolean).join(' · ');
    return h(Row,{key:item.key,title:item.identity.title,right:item.lastActivityAt?relativeTime(item.lastActivityAt):'',meta,active,inboxItem:true,onClick},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,marginTop:8,flexWrap:'wrap'}},
        h('span',{style:pill(item.classified?CLASS_PILL[item.classification]:C.text3)},suggestion),
        item.newCount!=null&&h('span',{style:{fontSize:13,color:C.text3}},item.newCount+' 条已整理'),
        item.identity.kind==='group'&&h('span',{style:{fontSize:13,color:C.text3}},'群聊')),
      extra&&h('div',{style:{marginTop:6,fontSize:13,color:C.text3}},extra));
  }

  function CenterDigest({items,onStart,onMarkAll}){
    const [since,setSince]=useState(0);
    useEffect(()=>{const now=Date.now()/1000,prev=Number(localStorage.getItem('ma-last-opened')||0);setSince(prev);localStorage.setItem('ma-last-opened',String(now));},[]);
    if(!since)return null;
    const fresh=items.filter(item=>item.lastActivityAt&&item.lastActivityAt>since);
    if(!fresh.length)return null;
    const reply=fresh.filter(item=>item.classified&&item.classification==='reply').length;
    const action=fresh.filter(item=>item.classified&&item.classification==='action').length;
    return h('div',{style:{margin:'0 12px 12px',padding:12,borderRadius:12,border:'1px solid '+C.border,background:C.panel}},
      h('div',{style:{fontSize:13,color:C.text3,marginBottom:6}},'从 '+relativeTime(since)+' 到现在'),
      h('p',{style:{margin:0,fontSize:14,color:C.text,lineHeight:1.7}},fresh.length+' 个会话有新消息，其中 '+reply+' 个需要回复、'+action+' 件需要处理。'),
      h('div',{style:{display:'flex',gap:10,marginTop:10,flexWrap:'wrap'}},
        h('button',{onClick:onStart,style:small(true)},'从最重要的开始'),
        h('button',{onClick:onMarkAll,style:small(false)},'全部标为已看')));
  }

  function CenterList({store,items,narrow}){
    const {contactKey}=useStore(store),[query,setQuery]=useState('');
    const needle=query.trim().toLowerCase();
    const shown=items.filter(item=>!needle||item.identity.title.toLowerCase().includes(needle)||(item.summary||[]).join(' ').toLowerCase().includes(needle));
    return h('section',{style:{display:'flex',flexDirection:'column',height:'100%',minWidth:0},'aria-label':'消息列表'},
      h('header',{style:{padding:narrow?'14px 14px 10px':'18px 18px 12px',borderBottom:'1px solid '+C.border}},
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,marginBottom:12}},
          h('h1',{style:{...h1,fontSize:20,margin:0}},'最近整理'),
          h('button',{onClick:()=>store.set({contactKey:null}),style:small(false)},'整理消息')),
        h('input',{value:query,onChange:event=>setQuery(event.target.value),placeholder:'搜索整理记录','aria-label':'搜索消息',style:field})),
      h('div',{style:{flex:1,overflowY:'auto'}},
        !shown.length&&h('p',{style:{padding:24,textAlign:'center',color:C.text3,fontSize:14,lineHeight:1.8}},needle?'没有找到相关记录':'还没有整理记录'),
        shown.map(item=>h(CenterRow,{key:item.key,item,active:contactKey===item.key,onClick:()=>store.set({contactKey:item.key})}))));
  }

  function OrganizerHome({items,onChanged,store,narrow}){
    const [text,setText]=useState(''),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false);
    const [answer,setAnswer]=useState(null),[error,setError]=useState(''),[note,setNote]=useState('');
    const quick=[
      ['整理最近消息','查看微信当前可见的最近会话，读取最多 5 个最值得关注的会话，告诉我发生了什么，并列出需要我处理的事项。'],
      ['找出需要回复的','查看最近会话，找出明确在等我回复的人。只给必要背景和建议回复方向，不要发送。'],
      ['提取待办','从最近相关消息中提取需要我本人完成的事情；不需要回复的也要列出来。'],
      ['看看有没有遗漏','检查最近会话里是否有日期、承诺、文件、付款或决定被我遗漏。']
    ];
    async function run(request){
      const value=String(request??text).trim();if(!value||busy)return;
      setBusy(true);setError('');setNote('');setAnswer(null);
      try{setAnswer(await api('message-center/organize',{text:value}));setText('');onChanged();}
      catch(e){setError(e.message);}finally{setBusy(false);}
    }
    async function refresh(){
      setRefreshing(true);setError('');setNote('');
      try{const result=await api('message-center/refresh',{});setNote(result.observationMessage||('已看到微信当前列表里的 '+result.visibleCount+' 个会话，没有打开聊天。'));await onChanged();}
      catch(e){setError(e.message);}finally{setRefreshing(false);}
    }
    const todos=answer?answerListItems(answer.answer):[];
    async function addTodos(){
      setBusy(true);setError('');
      try{for(const item of todos)await api('todos',{title:firstLine(item,40),detail:item,source:'assistant'});setNote('✓ 已把 '+todos.length+' 件事放进「今天要做的」');}
      catch(e){setError(e.message);}finally{setBusy(false);}
    }
    return h('section',{style:{flex:1,minWidth:0,height:'100%',overflowY:'auto'}},
      h('div',{style:{maxWidth:820,padding:narrow?'22px 16px 42px':'38px 42px 60px',margin:'0 auto'}},
        h('h1',{style:{...h1,fontSize:28,marginBottom:8}},'你想整理什么？'),
        h('p',{style:{...hint,fontSize:14,margin:'0 0 22px'}},'只有你发起整理时，助手才会查看微信；不会在后台持续监听，也不会发送消息。自动回复仍按单独配置运行。'),
        h(Notice,{error}),
        note&&h('p',{style:{color:C.ok,fontSize:14,lineHeight:1.7,margin:'0 0 14px'}},note),
        h('div',{style:{display:'grid',gridTemplateColumns:narrow?'1fr':'repeat(2,minmax(0,1fr))',gap:12,marginBottom:18}},
          quick.map(([title,prompt],index)=>h('button',{key:title,onClick:()=>run(prompt),disabled:busy,
            style:{textAlign:'left',padding:'16px 17px',borderRadius:14,border:'1px solid '+C.border,background:index===0?C.hover:C.panel,color:C.text,cursor:busy?'default':'pointer',minHeight:92}},
            h('strong',{style:{display:'block',fontSize:16,marginBottom:7}},title),
            h('span',{style:{fontSize:13,color:C.text3,lineHeight:1.6}},firstLine(prompt,42))))),
        h('div',{style:{display:'flex',gap:10,alignItems:'center',padding:10,border:'1px solid '+C.border,borderRadius:14,background:C.panel}},
          h('input',{value:text,onChange:event=>setText(event.target.value),onKeyDown:event=>{if(event.key==='Enter')run();},
            placeholder:'例如：帮我看看最近有没有要确认时间的消息','aria-label':'输入整理需求',style:{...field,border:'none',background:'transparent',flex:1,minWidth:0}}),
          h('button',{onClick:()=>run(),disabled:busy||!text.trim(),style:button(true)},busy?'正在整理…':'开始整理')),
        h('div',{style:{display:'flex',alignItems:'center',gap:10,marginTop:11,flexWrap:'wrap'}},
          h('button',{onClick:refresh,disabled:refreshing||busy,style:small(false)},refreshing?'正在查看…':'只刷新会话列表'),
          h('span',{style:{fontSize:12,color:C.text3}},'这个操作不会打开聊天，也不会清未读红点。')),
        busy&&h('div',{style:{marginTop:18,padding:'13px 15px',borderRadius:12,background:C.panel,color:C.text2,fontSize:14}},'正在按你的要求读取和整理；遇到微信正在使用时会跳过，不会在后台反复重试。'),
        answer&&h('div',{style:{marginTop:22,border:'1px solid '+C.border,borderRadius:14,background:C.panel,overflow:'hidden'}},
          h('div',{style:{padding:'12px 16px',borderBottom:'1px solid '+C.border,fontSize:13,color:C.text3}},'整理结果'),
          h('p',{style:{margin:0,padding:'16px 17px',whiteSpace:'pre-wrap',lineHeight:1.85,fontSize:15,color:C.text}},answer.answer),
          !!todos.length&&h('div',{style:{padding:'0 17px 16px'}},h('button',{onClick:addTodos,disabled:busy,style:small(true)},'把 '+todos.length+' 件事加入今天要做的'))),
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
    const d=detail.data,drafts=d?.drafts||[],messages=d?.messages||[],todos=(d?.todos||[]).filter(todo=>todo.state==='open');
    async function run(fn,optimistic){
      setBusy(true);setError('');setErrorDev(null);setNote('');
      const state=optimistic?.state??{};
      if(optimistic){setLocal(old=>({...old,...state}));setNote(optimistic.note);}
      try{await fn();onChanged();detail.refresh();}
      catch(e){
        setError(e.message);setErrorDev(e.dev||null);setNote('');
        // Put the screen back the way the server still reports it, so a refused action never
        // leaves a "✓ 已标为已看" behind. `state` defaults to {} because several actions only
        // carry a note — reading `optimistic.state` here threw a TypeError out of the catch,
        // which turned every failed 读取这条会话 into an unhandled rejection.
        setLocal(old=>{const next={...old};for(const key of Object.keys(state))delete next[key];return next;});
      }finally{setBusy(false);}
    }
    // 是不是还在「今天要做的」里，以服务端为准（`actionState` 走的是同一个 latestAction
    // 判定）；本地只覆盖点下去那一瞬间，成功之后交给刷新接管。
    const isDeferred=local.deferred!==undefined?local.deferred:item.actionState==='deferred';
    const seen=()=>run(()=>api('message-center/'+item.key+'/seen',{}),
      {state:{seen:true,deferred:false},note:'✓ 已标为已看，也从「今天要做的」里收起来了。'});
    const defer=()=>run(()=>api('message-center/'+item.key+'/defer',{}),
      {state:{deferred:true,seen:true},note:'✓ 已经放进「今天要做的」。'});
    const complete=()=>run(()=>api('message-center/'+item.key+'/complete',{}),
      {state:{deferred:false,seen:true},note:'✓ 这条处理完了。'});
    const draft=()=>run(()=>api('message-center/'+item.key+'/drafts',{}),
      {note:'✓ 草稿已备好，确认之后才会发出。'});
    const read=()=>run(()=>api('message-center/'+item.key+'/read',{}),
      {note:'✓ 已读取这条会话的正文。'});
    const addTodo=()=>{if(!todoText.trim()&&!(item.summary&&item.summary.length)){setError('先写一句要做什么');return;}run(()=>api('message-center/'+item.key+'/todos',{title:todoText.trim()||item.summary[0],source:'message'}),{note:'✓ 已记成待办，在「今天要做的」里。'});setTodoOpen(false);};
    const reclassify=classification=>run(()=>api('message-center/'+item.key+'/reclassify',{classification,reason:''}),
      {note:'✓ 已改成「'+CLASS_LABEL[classification]+'」。'});
    const follow=following=>run(()=>api('message-center/'+item.key+'/follow',{following}),
      {state:following?{seen:true}:{},note:following?'✓ 已恢复关注。':'✓ 已忽略这个会话，它不会再进队列。'});
    const classLabel=CLASS_LABEL[item.classification]||'无法判断';
    const primary=item.classification==='reply'?h('button',{onClick:draft,disabled:busy,style:button(true)},busy?'正在…':'AI 帮我起草')
      :item.classification==='action'?h('button',{onClick:()=>setTodoOpen(value=>!value),style:button(true)},'记为待办')
      :item.classification==='fyi'?h('button',{onClick:seen,disabled:busy||local.seen,style:button(true)},local.seen?'✓ 已标为已看':'标为已看')
      :h('button',{onClick:read,disabled:busy,style:button(true)},'查看原消息');
    return h('section',{style:{flex:1,display:'flex',flexDirection:'column',minWidth:0,minHeight:0},'aria-label':item.identity.title+'的消息详情'},
      h('header',{style:{position:'sticky',top:0,zIndex:1,padding:'14px 20px',borderBottom:'1px solid '+C.border,background:C.bg,display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12}},
        h('div',{style:{display:'flex',alignItems:'center',gap:12,minWidth:0,flex:'1 1 auto'}},
          narrow&&h('button',{onClick:()=>store.set({contactKey:null}),'aria-label':'返回消息列表',style:{...small(false),padding:'8px 12px',flexShrink:0}},'←'),
          h('div',{style:{minWidth:0}},
            h('h2',{style:{margin:0,fontSize:20,color:C.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},item.identity.title),
            h('p',{style:{margin:'4px 0 0',fontSize:13,color:C.text3}},(item.identity.kind==='group'?'微信群聊':'微信联系人')
              +(isDeferred?' · 已放进今天要做的':local.seen?' · 已看':(item.newCount!=null?(' · '+item.newCount+' 条新消息'):' · 有新动态'))))),
        h('div',{style:{display:'flex',alignItems:'center',gap:8,flexShrink:0}},
          h('span',{style:pill(item.classified?CLASS_PILL[item.classification]:C.text3)},item.classified?classLabel:'待判断'),
          item.following===false
            ? h('button',{onClick:()=>follow(true),disabled:busy,style:small(false)},'恢复关注')
            : h('button',{onClick:()=>follow(false),disabled:busy,style:small(false,false,true)},'忽略这个会话'))),
      h('div',{style:{flex:1,overflowY:'auto',minWidth:0}},
      h('div',{style:{padding:'20px 20px 24px',maxWidth:780}},
        h(Notice,{error:error||detail.error,dev:errorDev||detail.errorDev,code:errorDev?.code||detail.errorCode}),
        note&&h('p',{style:{color:C.ok,fontSize:14,margin:'0 0 12px'}},note),
        // 它现在在「今天要做的」里等着。这一页要能直接把它处理掉，而不是只把人送走：
        // 以前这里只有一个「去看看」，用户必须先跳过去再点一次，这一页却还挂着它。
        isDeferred&&h('div',{style:{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',padding:'11px 13px',borderRadius:10,border:'1px solid '+C.border,background:C.panel,marginBottom:14}},
          h('strong',{style:{fontSize:14,color:C.text}},'还在「今天要做的」里等你'),
          h('button',{onClick:complete,disabled:busy,style:small(true)},'处理完了'),
          h('button',{onClick:()=>store.set({tab:'today'}),style:small(false)},'去看看')),
        (item.summary&&item.summary.length>0)&&h(Section,{title:'这段时间发生了什么',meta:'AI 总结'},
          h('ul',{style:{margin:'4px 0 0',paddingLeft:20}},item.summary.map(point=>h('li',{key:point,style:{fontSize:14,color:C.text2,lineHeight:1.85,wordBreak:'break-word'}},point)))),
        h('div',{style:{padding:'12px 14px',borderRadius:12,border:'1px solid '+C.border,background:C.panel,marginBottom:20}},
          h('strong',{style:{fontSize:15,color:C.text}},'助手判断：'+classLabel),
          item.classificationReason&&h('p',{style:{margin:'7px 0 0',color:C.text2,fontSize:14,lineHeight:1.75}},item.classificationReason),
          // 「无法判断」有两种完全不同的原因：模型看了内容主动弃权，或者根本没读到内容。
          // 后者是读取故障，必须能看见它到底错在哪，否则这一行永远停在「待判断」。
          h('div',{style:{marginTop:10}},
            h(DevBox,{dev:item.classificationError?{
              code:item.classificationError.code,
              message:item.classificationError.message,
              detail:item.classificationError.detail,
              at:item.classificationError.at?new Date(item.classificationError.at*1000).toLocaleString('zh-CN'):''
            }:null,label:'这次为什么没判断出来'}))),
        h(Section,{title:'这条你要怎么处理'},
          h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
            primary,
            h('button',{onClick:defer,disabled:busy,style:button(false)},isDeferred?'已放进今天要做的':'稍后处理'),
            h('button',{onClick:seen,disabled:busy||local.seen,style:button(false)},local.seen?'✓ 已标为已看':'标为已看')),
          h('div',{style:{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}},
            ACTION_CLASSES.filter(c=>c!==item.classification).map(c=>h('button',{key:c,onClick:()=>reclassify(c),disabled:busy,style:small(false,false,true)},'其实是'+CLASS_LABEL[c]))),
          todoOpen&&h('div',{style:{marginTop:12,border:'1px solid '+C.border,borderRadius:12,padding:12,background:C.panel}},
            h('input',{value:todoText,onChange:event=>setTodoText(event.target.value),placeholder:'要做什么？'+(item.summary&&item.summary.length?'（默认：'+firstLine(item.summary[0],20)+'）':''),style:field}),
            h('div',{style:{display:'flex',gap:10,marginTop:10}},
              h('button',{onClick:addTodo,disabled:busy,style:button(true)},busy?'正在保存…':'记成待办'),
              h('button',{onClick:()=>setTodoOpen(false),style:button(false)},'取消')))),
        !!todos.length&&h(Section,{title:'待办',meta:'未完成 '+todos.length+' 件'},todos.map(todo=>h('div',{key:todo.id,style:{display:'flex',gap:10,alignItems:'flex-start',padding:'9px 0',borderBottom:'1px solid '+C.border}},
          h('span',{style:{flex:1,minWidth:0,fontSize:14,color:C.text2,lineHeight:1.7}},todo.title),
          todo.dueAt&&h('span',{style:{fontSize:13,color:C.text3}},dueInfo(todo.dueAt).text)))),
        !!drafts.length&&h(Section,{title:'回复草稿',meta:'等你确认'},drafts.map(draft=>h(DraftCard,{key:draft.id,draft,onChanged:detail.refresh}))),
        h(Fold,{title:'原始消息',meta:item.newCount!=null?(item.newCount+' 条新'):'还没读'},
          !messages.length
            ? h('div',null,
                h('p',{style:hint},'助手还没有读这条会话的正文。'),
                h('button',{onClick:read,disabled:busy,style:small(true)},'读取这条会话（会消掉它在微信里的未读红点）'))
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
      ||item.openTodos>0||item.pendingDrafts>0||item.actionState==='deferred');
    // Only judge "the selected conversation is gone" against a payload that was actually
    // fetched for the scope we are showing now. Jumping here from 「今天要做的」 sets the
    // scope to `all` and the selection at the same time, while `items` still holds the
    // previous scope's page — which of course does not contain it, so the selection was
    // cleared on the spot. That is why 「去看看」 looked like it did nothing.
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

  function NoConversations({store}){
    const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
    async function read(){setBusy(true);setError('');try{const result=await api('conversations');setMessage('读到 '+result.conversations.length+' 个微信里当前显示的聊天。');}catch(e){setError(e.message);}finally{setBusy(false);}}
    return h(Empty,{title:'还没有联系人',text:'第一步：从微信读取你当前的聊天列表。第二步：挑出要跟进的人加进来，之后所有的跟进记录和待办都存在这里。'},
      h('button',{onClick:read,disabled:busy,style:button(true)},busy?'正在读取微信…':'从微信读取聊天'),
      message&&h('p',{style:{color:C.ok,lineHeight:1.8,fontSize:14}},message),
      h(Notice,{error}),
      message&&h('button',{onClick:()=>store.set({tab:'automation'}),style:{...button(false),marginTop:12}},'添加要跟进的联系人'));
  }

  function RuleCard({rule,onAction}){
    const [editing,setEditing]=useState(false),[prompt,setPrompt]=useState(rule.prompt),[busy,setBusy]=useState(false),[error,setError]=useState('');
    useEffect(()=>{if(!editing)setPrompt(rule.prompt);},[rule.prompt,editing]);
    async function run(path,data){setBusy(true);setError('');try{await onAction(path,data);if(path==='edit')setEditing(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function remove(){if(!window.confirm('删除「'+rule.title+'」的自动回复吗？\n\n删除后会立即停止自动回复，历史发送记录和跟进记录都会保留。'))return;await run('delete',{id:rule.id});}
    return h('article',{style:card},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}},
        h('div',null,
          h('strong',{style:{display:'block',fontSize:17,color:C.text}},rule.title),
          h('span',{style:{fontSize:13,color:C.text3}},rule.kind==='group'?'微信群聊':'微信联系人')),
        h('span',{style:pill(rule.enabled?C.ok:null)},rule.enabled?'自动回复中':'自动回复已暂停')),
      h(Notice,{error}),
      editing?h('div',{style:{marginTop:14}},
        h('label',{style:{display:'block',fontSize:14,color:C.text2,marginBottom:6}},'希望助手怎样回复这个人？'),
        h('textarea',{value:prompt,onChange:event=>setPrompt(event.target.value),rows:4,style:{...field,resize:'vertical',lineHeight:1.7}}),
        h('p',{style:{...hint,marginTop:8}},'保存后会先暂停自动回复，你确认没问题再重新开启。'),
        h('div',{style:{display:'flex',gap:10}},
          h('button',{disabled:busy,onClick:()=>run('edit',{id:rule.id,prompt}),style:button(true)},busy?'正在保存…':'保存'),
          h('button',{disabled:busy,onClick:()=>{setEditing(false);setPrompt(rule.prompt);},style:button(false)},'取消')))
      :h(React.Fragment,null,
        h('p',{style:{margin:'14px 0',color:C.text2,fontSize:14,lineHeight:1.8,whiteSpace:'pre-wrap'}},rule.prompt),
        rule.detail&&h('p',{style:{padding:'10px 12px',borderRadius:8,background:C.bg,color:C.text3,fontSize:13,lineHeight:1.7}},rule.detail),
        h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
          h('button',{disabled:busy,onClick:()=>run(rule.enabled?'pause':'enable',{id:rule.id}),style:button(!rule.enabled)},rule.enabled?'暂停自动回复':'开启自动回复'),
          h('button',{disabled:busy,onClick:()=>setEditing(true),style:button(false)},'改回复方式'),
          h('button',{disabled:busy,onClick:remove,style:button(false,true)},'删除'))));
  }

  function AddContact({onAdded,purpose}){
    const [open,setOpen]=useState(false),[choices,setChoices]=useState([]),[conversation,setConversation]=useState(''),[prompt,setPrompt]=useState('用自然、友好、简短的中文回复日常聊天；不确定的事情交给我处理。'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[isGroup,setIsGroup]=useState(false);
    async function scan(){setBusy(true);setError('');try{const result=await api('conversations');setChoices(result.conversations||[]);if(result.conversations?.length)setConversation(result.conversations[0].id);}catch(e){setError(e.message);}finally{setBusy(false);}}
    // The visible WeChat list cannot tell a group from a one-to-one chat (the runtime reports
    // "unknown" for every row), so the person adding it says which it is instead.
    async function add(){const selected=choices.find(choice=>choice.id===conversation);if(!selected){setError('请先选择一个联系人或群聊');return;}setBusy(true);setError('');try{await api('rules',{conversation_id:selected.id,prompt,kind:isGroup?'group':'direct'});setOpen(false);setChoices([]);setConversation('');setIsGroup(false);onAdded();}catch(e){setError(e.message);}finally{setBusy(false);}}
    const crm=purpose==='crm';
    if(!open)return h('button',{onClick:()=>{setOpen(true);scan();},style:button(true)},crm?'＋ 添加要跟进的联系人':'＋ 添加自动回复');
    return h('section',{style:{padding:18,border:'1px solid '+C.brand,borderRadius:14,margin:'16px 0',maxWidth:680,background:C.panel}},
      h('h3',{style:h3},crm?'添加要跟进的联系人':'添加自动回复'),
      crm&&h('p',{style:{...hint,marginBottom:12}},'先用「从微信读取」把聊天列表读进来，再挑出要跟进的人。加进来只是让它出现在工作台，自动回复保持关闭，你随时可以打开。'),
      h(Notice,{error}),
      h('label',{style:{display:'block',fontSize:14,color:C.text2,marginBottom:6}},'1. 选择联系人或群聊'),
      h('div',{style:{display:'flex',gap:10,marginBottom:10,flexWrap:'wrap'}},
        h('select',{value:conversation,onChange:event=>setConversation(event.target.value),style:{...field,flex:'1 1 300px'}},
          !choices.length&&h('option',{value:''},busy?'正在读取微信…':'没有读到聊天，先点右边刷新'),
          choices.map(choice=>h('option',{key:choice.id,value:choice.id},choice.title))),
        h('button',{onClick:scan,disabled:busy,style:button(false)},busy?'正在读取…':'重新读取微信')),
      // 微信列表分不出群聊和单聊，所以由添加的人指明；默认按联系人处理。
      h('label',{style:{display:'flex',alignItems:'center',gap:10,marginBottom:16,cursor:'pointer',minHeight:44}},
        h('input',{type:'checkbox',checked:isGroup,onChange:event=>setIsGroup(event.target.checked),style:{width:20,height:20,accentColor:'var(--dsw-alias-brand-primary)',cursor:'pointer'}}),
        h('span',{style:{fontSize:14,color:C.text}},'这是一个群聊'),
        h('span',{style:{fontSize:13,color:C.text3}},'（不勾选就当作单聊联系人）')),
      h('label',{style:{display:'block',fontSize:14,color:C.text2,marginBottom:6}},'2. 要自动回复的话，告诉助手怎么回'),
      h('textarea',{value:prompt,onChange:event=>setPrompt(event.target.value),rows:4,style:{...field,resize:'vertical',lineHeight:1.7}}),
      h('p',{style:{...hint,marginTop:8}},crm?'不想让它自动回复也可以，保持关闭就行。':'添加后默认关闭，检查无误再开启。'),
      h('div',{style:{display:'flex',gap:10,marginTop:12}},
        h('button',{onClick:add,disabled:busy,style:button(true)},busy?'请稍等…':'确定添加'),
        h('button',{onClick:()=>setOpen(false),disabled:busy,style:button(false)},'取消')));
  }

  // ---- 今天要做的 -----------------------------------------------------------
  function TodoRow({todo,onAction,busy}){
    const due=dueInfo(todo.dueAt),done=todo.state!=='open';
    return h('div',{style:{display:'flex',gap:12,alignItems:'flex-start',padding:'13px 15px',borderBottom:'1px solid '+C.border}},
      // 以前未完成时这个方框是空的（done?'✓':''），用户看不出它能点——"这个待办怎么标记完成？"。
      // 现在未完成也给一个浅灰勾，语义一眼可辨；悬停再高亮成品牌色。
      h('button',{onClick:()=>onAction(done?'reopen':'done',todo),disabled:busy,title:done?'重新打开':'标记完成','aria-label':done?'重新打开':'标记完成',
        'data-todo-toggle':done?'done':'open',
        style:{width:22,height:22,marginTop:2,borderRadius:6,border:'1px solid '+(done?C.ok:C.border),background:done?C.ok:'transparent',cursor:'pointer',flexShrink:0,color:done?'var(--dsw-alias-bg-base)':C.text3,fontSize:13,lineHeight:1,padding:0}},'✓'),
      h('div',{style:{flex:1,minWidth:0}},
        h('div',{style:{fontSize:15,color:done?C.text3:C.text,lineHeight:1.6,textDecoration:done?'line-through':'none',wordBreak:'break-word'}},todo.title),
        todo.detail&&todo.detail!==todo.title&&h('p',{style:{margin:'5px 0 0',fontSize:13,color:C.text2,lineHeight:1.7,whiteSpace:'pre-wrap',maxHeight:60,overflow:'hidden'}},todo.detail),
        h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:6,flexWrap:'wrap'}},
          due&&h('span',{style:pill(due.color)},due.text),
          todo.identity&&h('span',{style:{fontSize:13,color:C.text3}},'来自 '+todo.identity.title),
          todo.source==='assistant'&&h('span',{style:{fontSize:13,color:C.text3}},'助手记的'),
          !todo.identity&&h('span',{style:{fontSize:13,color:C.text3}},'自己记的'))),
      !done&&h('div',{style:{display:'flex',gap:6,flexShrink:0}},
        h('button',{onClick:()=>onAction('tomorrow',todo),disabled:busy,style:small(false)},'明天'),
        h('button',{onClick:()=>onAction('delete',todo),disabled:busy,style:small(false,true)},'删除')));
  }

  function TodayPage({store,ctx}){
    const today=usePoller(true,()=>api('today'),8000),[busy,setBusy]=useState(false),[error,setError]=useState(''),[adding,setAdding]=useState(false);
    const data=today.data,counts=data?.counts||{decide:0,confirm:0,todos:0,overdue:0};
    async function act(action,entry){
      setBusy(true);setError('');
      try{
        if(action==='done')await api('todos/'+entry.todoId+'/done',{});
        else if(action==='reopen')await api('todos/'+entry.todoId+'/reopen',{});
        else if(action==='tomorrow')await api('todos/'+entry.todoId+'/reopen',{dueAt:fromDateInput(toDateInput(dayStart(1))).toISOString()});
        else if(action==='delete')await api('todos/'+entry.todoId+'/delete',{});
        // 「需要你决定」里的会话：处理完了就收起来。以前这一页只有「去看看」，用户必须跳到
        // 另一页才能把它消掉，而它自己却一直挂在这一页上。
        else if(action==='complete')await api('message-center/'+entry.conversationKey+'/complete',{});
        today.refresh();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    async function addTodo(_,text,dueAt){try{await api('todos',{title:text,dueAt,source:'manual'});setAdding(false);today.refresh();}catch(e){setError(e.message);}}
    const go=(key)=>{store.set({tab:'messages',contactKey:key,scope:'all'});};
    const total=counts.decide+counts.confirm+counts.todos;
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:860}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:16,flexWrap:'wrap'}},
          h('div',null,
            h('h1',h1,'今天要做的'),
            h('p',{style:{margin:'0 0 4px',color:C.text2,fontSize:14,lineHeight:1.8}},total?('还有 '+total+' 件事等你。做完的就自动收起来。'):'今天没有等你处理的事。')),
          h('button',{onClick:()=>setAdding(true),style:button(true)},'＋ 加一条待办')),
        h(Notice,{error:error||today.error}),
        counts.overdue>0&&h('p',{style:{margin:'0 0 16px',color:C.error,fontSize:14}},'其中 '+counts.overdue+' 件已经逾期，建议先处理。'),
        (data?.groups||[]).filter(group=>group.key!=='handled').map(group=>{
          const items=group.key==='todos'&&adding?[...group.items,{id:'__new',kind:'new'}]:group.items;
          return h('section',{key:group.key,style:{marginBottom:26}},
            h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,marginBottom:8}},
              h('h2',{style:{...h2,margin:0}},group.title+(items.length?(' · '+items.length+' 件'):'')),
              group.hint&&h('span',{style:{fontSize:13,color:C.text3}},group.hint)),
            !items.length&&h('p',{style:{...hint,padding:'10px 0'}},group.key==='decide'?'没有需要你决定的事。':group.key==='confirm'?'没有等你确认的回复。':'还没有待办，点右上角「加一条待办」。'),
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
                    entry.kind==='draft'
                      ? h('button',{onClick:()=>go(entry.conversationKey),style:small(true)},'去看草稿')
                      : h(React.Fragment,null,
                          h('button',{onClick:()=>act('complete',entry),disabled:busy,style:small(true)},'处理完了'),
                          h('button',{onClick:()=>go(entry.conversationKey),disabled:busy,style:small(false)},'去看看')),
                    due&&h('span',{style:pill(C.warn)},'快到时间了'))});
              })));
        }),
        (data?.groups||[]).filter(group=>group.key==='handled').map(group=>
          h('details',{key:group.key,style:{borderTop:'1px solid '+C.border,paddingTop:16,marginBottom:20}},
            h('summary',{style:{fontSize:15,color:C.text}},'助手已处理'+(group.items.length?('（'+group.items.length+' 个会话）'):'')),
            !group.items.length&&h('p',{style:hint},'还没有已处理的记录。'),
            group.items.map(entry=>h(Row,{key:entry.id,title:entry.identity.title,right:relativeTime(entry.updatedAt),meta:JOB[entry.state]||('已处理'+(entry.detail?(' · '+firstLine(entry.detail,60)):''))}))))));
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
    async function action(path,data){await api(path,data);status.refresh();}
    const rules=status.data?.rules||[];
    const restore=settings.data?.settings?.auto_restore_window===true;
    async function toggleRestore(){
      setSaving(true);setSettingError('');
      try{await api('settings',{auto_restore_window:!restore});settings.refresh();}
      catch(e){setSettingError(e.message);}finally{setSaving(false);}
    }
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:900}},
        h('h1',h1,'自动回复'),
        h('p',{style:{margin:'0 0 6px',color:C.text2,fontSize:14,lineHeight:1.8,maxWidth:640}},'这里管理助手自动发送的回复：哪些规则在跑、助手替你回复得怎么样。'),
        h('p',{style:{margin:'0 0 18px',color:C.text3,fontSize:13,lineHeight:1.8,maxWidth:640}},'所有新消息和需要你本人处理的事，请到「消息」查看 —— 这里不包含全部消息。'),
        h(Notice,{error:settingError||status.error}),
        h('section',{style:{...card,display:'flex',justifyContent:'space-between',alignItems:'center',gap:16,flexWrap:'wrap'}},
          h('div',{style:{minWidth:240,flex:1}},
            h('strong',{style:{display:'block',fontSize:15,color:C.text}}, '微信被最小化时自动拉回'),
            h('span',{style:{fontSize:13,color:C.text3,lineHeight:1.7}},'微信收进托盘时自动回复会停摆。打开后，助手最多每分钟把窗口拉回一次，不会抢你的焦点。')),
          h('button',{onClick:toggleRestore,disabled:saving||!settings.data,role:'switch','aria-checked':restore,style:{...small(restore),minWidth:104}},
            saving?'正在保存…':(restore?'已打开':'已关闭'))),
        h(AddContact,{onAdded:status.refresh}),
        status.loading&&!status.data&&h('p',{style:hint},'正在读取…'),
        !status.loading&&!rules.length&&h('p',{style:{padding:'24px 0',color:C.text3,fontSize:14}},'还没有自动回复。点上面的按钮添加第一个。'),
        rules.map(rule=>h(RuleCard,{key:rule.id,rule,onAction:action})),
        !!status.data?.jobs?.length&&h('details',{style:{marginTop:22,paddingTop:14,borderTop:'1px solid '+C.border}},
          h('summary',{style:{cursor:'pointer',fontSize:15,color:C.text}},'最近处理记录'),
          foldJobRuns(status.data.jobs).slice(0,15).map(({count,job})=>h('div',{key:job.id,style:{padding:'10px 0',borderBottom:'1px solid '+C.border,fontSize:14}},
            h('strong',{style:{color:job.state==='failed'||job.state==='uncertain'?C.error:C.text}},JOB[job.state]||'已处理'),
            h('span',{style:{color:C.text2}},' · '+firstLine(job.text||job.detail||'',70)+(count>1?'（同类 '+count+' 条）':'')))))));
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
    const label={display:'block',fontSize:13,color:C.text2,marginBottom:5};
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
        h('div',null,h('strong',{style:{fontSize:17,color:C.text}},p.name),h('span',{style:{fontSize:13,color:C.text3}},'第 '+p.revision+' 版')),
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
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState(null);
    async function scan(){setBusy(true);setError('');try{const r=await api('conversations');setChoices(r.conversations||[]);if(r.conversations?.length)setConversation(r.conversations[0].id);}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function analyze(){const selected=choices.find(c=>c.id===conversation);if(!selected){setError('请先选一个会话');return;}setBusy(true);setError('');try{const r=await api('context/profiles/analyze',{provider:'wechat-main',conversation:selected.id});setResult(r);}catch(e){setError(e.message);}finally{setBusy(false);}}
    return h('div',{style:{...card,padding:16}},
      h('div',{style:{fontSize:16,color:C.text}},'从聊天分析说话方式'),
      h('p',{style:{...hint,margin:'6px 0 12px'}},'选一个会话，助手会读你最近发过的消息，总结你平时怎么说话，生成一份「说话方式」。生成的是草稿，你确认无误、点「启用」后才会真正用上（自动回复和拟稿都会用它）。'),
      h(Notice,{error}),
      h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
        h('select',{value:conversation,onChange:event=>setConversation(event.target.value),style:{...field,flex:'1 1 260px'}},
          !choices.length&&h('option',{value:''},busy?'正在读取微信…':'没有读到会话，点右边读取'),
          choices.map(c=>h('option',{key:c.id,value:c.id},c.title))),
        h('button',{onClick:scan,disabled:busy,style:button(false)},busy?'正在读取…':'重新读取微信')),
      result&&h('div',{style:{marginTop:12,border:'1px solid '+C.border,borderRadius:12,padding:12,background:C.panel}},
        h('div',{style:{fontSize:14,color:C.text,marginBottom:6}},'已生成「'+result.profile.name+'」（草稿，'+result.outgoingCount+' 条我方消息）'),
        result.summary&&h('p',{style:{margin:0,fontSize:14,color:C.text2,lineHeight:1.7}},result.summary),
        (result.profile.rules?.preference||[]).length>0&&h('p',{style:{margin:'6px 0 0',fontSize:13,color:C.text3,lineHeight:1.7}},'风格：'+(result.profile.rules.preference.join('；'))),
        h('button',{onClick:onDone,style:{...small(true),marginTop:10}},'去查看并确认')),
      !result&&h('div',{style:{display:'flex',gap:10,marginTop:12,flexWrap:'wrap'}},
        h('button',{onClick:analyze,disabled:busy||!conversation,style:button(true)},busy?'正在分析…':'开始分析'),
        h('button',{onClick:onDone,disabled:busy,style:button(false)},'取消')));
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
    const label={display:'block',fontSize:13,color:C.text2,marginBottom:5};
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
          style:{...field,resize:'vertical',lineHeight:1.7,background:C.bg}}),
        fileNote&&h('p',{style:{...hint,marginTop:8}},fileNote)),
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginTop:12}},
        h('div',null,h('label',{style:label},'这些条目统一归到'),h('select',{value:kind,onChange:event=>setKind(event.target.value),style:field},KNOWLEDGE_KINDS.map(([value,text])=>h('option',{key:value,value:value},text)))),
        h('div',null,h('label',{style:label},'统一风险等级'),h('select',{value:risk,onChange:event=>setRisk(event.target.value),style:field},KNOWLEDGE_RISK.map(([value,text])=>h('option',{key:value,value:value},text))))),
      // 切分粒度没有唯一正解，与其替他决定，不如让他点一下就看结果。
      h('div',{style:{marginTop:12}},
        h('label',{style:label},'怎么切'),
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
    const label={display:'block',fontSize:13,color:C.text2,marginBottom:5};
    return h('div',{style:{...card,padding:16}},
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}},
        h('div',null,h('label',{style:label},'分类'),h('select',{value:kind,onChange:event=>setKind(event.target.value),style:field},KNOWLEDGE_KINDS.map(([value,text])=>h('option',{key:value,value:value},text)))),
        h('div',null,h('label',{style:label},'风险等级'),h('select',{value:risk,onChange:event=>setRisk(event.target.value),style:field},KNOWLEDGE_RISK.map(([value,text])=>h('option',{key:value,value:value},text))))),
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
        h('div',null,h('strong',{style:{fontSize:16,color:C.text}},k.title),h('span',{style:{fontSize:13,color:C.text3}},'第 '+k.revision+' 版 · '+(KNOWLEDGE_KINDS.find(item=>item[0]===k.kind)||[k.kind,k.kind])[1])),
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
        h('h1',h1,'回复配置'),
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
        h('h1',h1,'设置'),
        h(Notice,{error:modelError||status.error||settings.error||catalog.error}),
        h('section',{style:card},
          h('div',{style:{display:'flex',alignItems:'center',gap:12}},
            h('span',{style:{fontSize:22,color:ok?C.ok:C.text3}},'●'),
            h('div',null,
              h('strong',{style:{display:'block',fontSize:16,color:C.text}},ok?'消息服务运行正常':'正在检查消息服务'),
              h('span',{style:{fontSize:13,color:C.text3}},data?('已接入 '+data.rules.length+' 个联系人'):'请稍等…'))),
           h('p',{style:{marginTop:16,color:C.text2,fontSize:14,lineHeight:1.8}},'聊天内容、跟进记录和待办都存在这台电脑上。使用云端模型时，为了完成你的要求，相关聊天内容会发送给模型服务。')),
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'消息整理方式'),
          h('strong',{style:{display:'block',fontSize:15,color:C.text,marginBottom:7}},'按需整理，不持续监听'),
          h('p',{style:{...hint,margin:0}},'只有你在「消息」页发起整理或主动打开某个会话时，助手才会读取微信。读取正文可能会切换会话并清掉未读红点；页面刷新和后台轮询不会操作微信。自动回复是独立功能，仍按你启用的联系人规则运行。')),
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'自动回复模型'),
          h('p',{style:{...hint,margin:'0 0 12px'}},'只影响后台自动消息任务，不会改变你在聊天页手动选择的模型。修改后从下一条新消息开始生效。'),
          h('select',{value:autoModel,onChange:changeAutoModel,disabled:savingModel||!settings.data||!models.length,'aria-label':'自动回复模型',style:field},
            !models.length&&h('option',{value:''},catalog.loading?'正在读取模型…':'暂无可用模型'),
            models.map(model=>h('option',{key:model.id,value:model.id},model.name===model.id?model.id:(model.name+' · '+model.id)))),
          savingModel&&h('p',{style:{...hint,margin:'8px 0 0'}},'正在保存…')),
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'开发者模式'),
          h('p',{style:{...hint,margin:'0 0 12px'}},'打开后，界面上出错的地方会多出一块折叠的「开发者详情」：Runtime 的错误码、它自己的原文、调用栈和读取到的条数，都可以一键复制。定位「读不到消息」「助手判断不出来」时用它。上线前关掉即可，用户侧不会看到任何原始报错。原始日志另外逐条记在数据目录的 dev-errors.log 里。'),
          h(DevToggle,{})),
        h('section',{style:{...card,marginTop:16}},
          h('h3',h3,'数据保存在哪'),
          h('p',{style:{...hint,margin:'0'}},'联系人、跟进记录和待办存在本机的 crm.db；自动回复的规则和发送记录存在 reply.db。两个文件都在程序的数据目录里，可以直接备份。')),
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

  const NAV=[['messages','消息'],['today','今天要做的'],['customers','联系人'],['automation','自动回复'],['context','回复配置']];
  const NAV_ICON={messages:'messages',today:'today',customers:'contacts',automation:'automation',context:'context'};
  function NavEntry({store,wide}){
    const {open,pending}=useStore(store);
    return h('button',{onClick:()=>store.set({open:!open,cover:true}),title:'消息助手',
      style:{display:'flex',alignItems:'center',gap:10,width:'100%',minHeight:44,padding:'10px 12px',border:'none',borderRadius:10,cursor:'pointer',background:open?C.hover:'transparent',color:C.text,fontSize:14}},
      h(Icon,{name:'messages',size:18}),wide&&h('span',null,'消息助手'),
      !!pending&&h('span',{style:{marginLeft:wide?'auto':0,minWidth:22,height:22,padding:'0 6px',borderRadius:11,background:C.error,color:'var(--dsw-alias-bg-base)',fontSize:12,display:'inline-flex',alignItems:'center',justifyContent:'center'}},pending));
  }
  /**
   * Closed used to mean "hand the screen back to the DSH web UI", which is a developer
   * surface: workspaces, model pickers, tool JSON. The product covers it instead and keeps
   * a discreet way back in for whoever is building the thing.
   */
  function Cover({store}){
    return h('div',{'data-ma':'cover',style:{position:'fixed',inset:0,zIndex:60,background:C.bg,color:C.text,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14,padding:32,textAlign:'center'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:10}},h(Icon,{name:'messages',size:28}),h('strong',{style:{fontSize:21}},'消息助手')),
      h('p',{style:{margin:0,color:C.text3,fontSize:14,lineHeight:1.85,maxWidth:380}},
        '消息、待办和跟进记录都在这里。关掉界面不会停止工作，助手仍在后台替你处理消息。'),
      h('button',{onClick:()=>store.set({open:true}),style:{...button(true),minWidth:200,marginTop:6}},'打开消息助手'),
      h('button',{onClick:()=>store.set({cover:false}),
        style:{marginTop:6,border:'none',background:'transparent',color:C.text3,fontSize:13,cursor:'pointer',textDecoration:'underline'}},'进入开发者界面'));
  }
  function Workbench({ctx,store}){
    const {open,cover,tab}=useStore(store),[narrow,setNarrow]=useState(()=>matchMedia('(max-width: 900px)').matches),closeRef=useRef(null);
    useEffect(()=>{const media=matchMedia('(max-width: 900px)'),change=()=>setNarrow(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
    useEffect(()=>{if(!open)return;const key=event=>{if(event.key==='Escape')store.set({open:false});};document.addEventListener('keydown',key);closeRef.current?.focus();return()=>document.removeEventListener('keydown',key);},[open,store]);
    // The badge has to stay live while the workbench is closed, so this poller runs
    // regardless of the overlay's visibility.
    const badge=usePoller(true,()=>api('today'),10000);
    useEffect(()=>{const pending=badge.data?.counts?.attention??0;if(pending!==store.get().pending)store.set({pending});},[badge.data,store]);
    if(!cover)return null;
    if(!open)return h(Cover,{store});
    const items=NAV.map(([value,label])=>h('button',{key:value,onClick:()=>store.set({tab:value}),'aria-current':tab===value?'page':undefined,title:label,
      style:{minHeight:narrow?62:46,padding:narrow?'8px 4px':'11px 12px',border:'none',borderRadius:10,cursor:'pointer',textAlign:'center',background:tab===value?C.hover:'transparent',color:tab===value?C.text:C.text2,fontSize:narrow?11:14,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:4}},
      h(Icon,{name:NAV_ICON[value],size:20}),narrow?h('span',null,label):null));
    const wideItems=NAV.map(([value,label])=>h('button',{key:value,onClick:()=>store.set({tab:value}),'aria-current':tab===value?'page':undefined,title:label,
      style:{minHeight:46,padding:'11px 12px',border:'none',borderRadius:10,cursor:'pointer',textAlign:'left',background:tab===value?C.hover:'transparent',color:tab===value?C.text:C.text2,fontSize:14,display:'flex',alignItems:'center',gap:10}},
      h(Icon,{name:NAV_ICON[value],size:18}),label,
      value==='today'&&store.get().pending?h('span',{style:{marginLeft:'auto',minWidth:22,height:22,padding:'0 6px',borderRadius:11,background:C.error,color:'var(--dsw-alias-bg-base)',fontSize:12,display:'inline-flex',alignItems:'center',justifyContent:'center'}},store.get().pending):null));
    return h('div',{role:'dialog','aria-modal':'true','aria-label':'消息助手','data-ma':'root',
      style:{position:'fixed',inset:0,zIndex:60,display:'flex',background:C.bg,pointerEvents:'auto',color:C.text}},
      h('style',null,'[data-ma] button:focus-visible,[data-ma] input:focus-visible,[data-ma] textarea:focus-visible,[data-ma] select:focus-visible{outline:3px solid var(--dsw-alias-brand-primary);outline-offset:2px}[data-ma] button:disabled{opacity:.55;cursor:not-allowed}[data-ma] summary{cursor:pointer}[data-ma] [data-todo-toggle="open"]:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}[data-ma] .ma-pulse{animation:ma-pulse 1.3s ease-in-out infinite}@keyframes ma-pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.1)}}'),
      h('nav',{'data-ma':'nav','aria-label':'主要功能',style:{width:narrow?84:200,flexShrink:0,padding:'16px 10px',borderRight:'1px solid '+C.border,background:C.panel,display:'flex',flexDirection:'column',gap:6}},
        h('div',{style:{padding:'2px 10px 16px',fontSize:narrow?18:18,fontWeight:700}},narrow?'助手':'消息助手'),
        narrow?items:wideItems,
        h('div',{style:{flex:1}}),
        h('button',{onClick:()=>store.set({tab:'settings'}),'aria-current':tab==='settings'?'page':undefined,title:'设置',
          style:{minHeight:46,padding:'11px 12px',border:'none',borderRadius:10,cursor:'pointer',textAlign:narrow?'center':'left',background:tab==='settings'?C.hover:'transparent',color:C.text2,fontSize:14,display:'flex',alignItems:'center',gap:10,justifyContent:narrow?'center':'flex-start'}},
          h(Icon,{name:'settings',size:18}),narrow?null:'设置'),
        h('button',{ref:closeRef,onClick:()=>store.set({open:false}),title:'关闭',style:{minHeight:42,padding:'9px 12px',border:'none',background:'transparent',color:C.text3,cursor:'pointer',fontSize:14,textAlign:narrow?'center':'left'}},narrow?'关闭':'关闭工作台')),
      h('main',{'data-ma':'main',style:{flex:1,minWidth:0,height:'100%',display:'flex'}},
        tab==='messages'?h(MessagesPage,{store,ctx,narrow})
          :tab==='today'?h(TodayPage,{store,ctx})
          :tab==='customers'?h(CustomersPage,{store,ctx,narrow})
          :tab==='automation'?h(AutomationPage)
          :tab==='context'?h(ContextPage)
          :h(SettingsPage)));
  }
  const TOOL_NAMES=['mcp__messaging__list_conversations','mcp__messaging__read_messages','mcp__messaging__sync_conversation','mcp__messaging__search_messages','mcp__messaging__send_message','mcp__messaging__reply_message','mcp__messaging__get_send_status','submit_reply_decision'];
  return{inject:['slots','sessions'],apply(ctx){
    const saved=readSaved(),store=createStore({open:saved.open===undefined?true:saved.open,cover:saved.cover===undefined?true:saved.cover,tab:saved.tab||'messages',contactKey:saved.contactKey||null,customerKey:saved.customerKey||null,filter:saved.filter||'all',scope:saved.scope||'attention',order:saved.order||'recent',pending:0});
    ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'message-agent-workbench',order:5,label:()=> '消息助手'},({wide})=>h(NavEntry,{store,wide})));
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
