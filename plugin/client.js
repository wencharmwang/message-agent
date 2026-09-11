window.__ModuleLoader__.load({id:'messaging-agent-ui',factory:(require)=>{
  const React=require('react');
  const h=React.createElement;
  const {useEffect,useRef,useState,useSyncExternalStore,useCallback}=React;

  async function api(path,data){
    const response=await fetch('/message-agent/api/'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){const error=Error(result.error||'操作没有完成，请稍后再试');error.code=result.code;throw error;}
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

  function readSaved(){try{return JSON.parse(sessionStorage.getItem('message-agent-workbench')||'{}');}catch{return{};}}
  function createStore(initial){let state=initial;const listeners=new Set();return{get:()=>state,set(patch){state={...state,...patch};try{sessionStorage.setItem('message-agent-workbench',JSON.stringify({open:state.open,cover:state.cover,tab:state.tab,contactKey:state.contactKey,customerKey:state.customerKey,filter:state.filter}));}catch{}listeners.forEach(listener=>listener());},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}};}
  function useStore(store){return useSyncExternalStore(store.subscribe,store.get);}
  function usePoller(active,load,delay){
    const [state,setState]=useState({loading:true,data:null,error:''}),loadRef=useRef(load),[revision,setRevision]=useState(0);loadRef.current=load;
    useEffect(()=>{if(!active)return;let stopped=false,timer,controller,wait=800;const run=async()=>{if(stopped)return;if(document.hidden){timer=setTimeout(run,5000);return;}controller=new AbortController();try{const data=await loadRef.current(controller.signal);if(!stopped){setState({loading:false,data,error:''});wait=delay;}}catch(error){if(!stopped&&error.name!=='AbortError'){setState(old=>({...old,loading:false,error:error.message}));wait=Math.min(wait*2,30000);}}if(!stopped)timer=setTimeout(run,wait);};run();return()=>{stopped=true;clearTimeout(timer);controller&&controller.abort();};},[active,delay,revision]);
    return {...state,refresh:()=>setRevision(value=>value+1)};
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
    settings:'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0-9.2v1.9m0 9.6v1.9M17.2 10h-1.9M4.7 10H2.8M15.1 4.9l-1.3 1.3M6.2 13.8l-1.3 1.3M15.1 15.1l-1.3-1.3M6.2 6.2 4.9 4.9'
  };
  function Icon({name,size=18}){
    return h('svg',{width:size,height:size,viewBox:'0 0 20 20','aria-hidden':'true',focusable:'false',
      style:{display:'block',flexShrink:0}},
      h('path',{d:ICONS[name]||ICONS.messages,fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round'}));
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
  function Notice({error}){return error?h('div',{role:'alert',style:{padding:'11px 13px',borderRadius:10,border:'1px solid '+C.error,color:C.error,fontSize:14,lineHeight:1.6,marginBottom:12}},error):null;}
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

  function CrmSections({customerKey,identity,data,loading,error,onChanged}){
    const [busy,setBusy]=useState(false),[actionError,setActionError]=useState('');
    const [todoOpen,setTodoOpen]=useState(false),[followOpen,setFollowOpen]=useState(false);
    const [stage,setStage]=useState(''),[nextStep,setNextStep]=useState(''),[note,setNote]=useState(''),[saving,setSaving]=useState(false);
    const [showDone,setShowDone]=useState(false),[showAllFollow,setShowAllFollow]=useState(false);
    const [askText,setAskText]=useState(''),[asking,setAsking]=useState(false),[answer,setAnswer]=useState(null),[savedAs,setSavedAs]=useState('');
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

    async function ask(text){
      if(!text.trim())return;
      setAsking(true);setActionError('');setAnswer(null);setSavedAs('');
      try{const result=await api('conversations/'+customerKey+'/ask',{text});setAnswer(result);setAskText('');}catch(e){setActionError(e.message);}finally{setAsking(false);}
    }
    // Saving has to say so: a silent write left the user clicking a button that "did nothing".
    async function saveAnswer(kind){
      setBusy(true);setActionError('');setSavedAs('');
      try{
        if(kind==='todo'){
          await api('todos',{conversationKey:customerKey,title:firstLine(answer.answer,40)||'打开助手看看',detail:answer.answer,source:'assistant'});
          setSavedAs('已记成待办，在「今天要做的」里');
        } else {
          // Evidence must read like a person wrote it: never the raw MCP tool name.
          await api('customers/'+customerKey+'/followups',{kind:'助手摘要',note:answer.answer,evidence:toolText(answer.tools)});
          setSavedAs('已存为跟进记录，在下面「跟进记录」里');
        }
        onChanged();
      }catch(e){setActionError(e.message);}finally{setBusy(false);}
    }

    function todoLine(todo,index){
      const due=dueInfo(todo.dueAt);
      return h('div',{key:todo.id,style:{display:'flex',gap:12,alignItems:'flex-start',padding:'12px 15px',borderTop:index?'1px solid '+C.border:'none'}},
        h('button',{onClick:()=>finish(todo),disabled:busy,title:'标记完成','aria-label':'标记完成',
          style:{width:22,height:22,marginTop:2,borderRadius:6,border:'1px solid '+C.border,background:'transparent',cursor:'pointer',flexShrink:0,padding:0}}),
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

      h(Section,{title:'问助手'},
        h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
          h('input',{value:askText,onChange:event=>setAskText(event.target.value),onKeyDown:event=>{if(event.key==='Enter')ask(askText);},
            placeholder:'问他关于聊天记录的事，例如：我上次答应了他什么？','aria-label':'问助手',style:{...field,flex:'1 1 260px'}}),
          h('button',{onClick:()=>ask(askText),disabled:asking||!askText.trim(),style:button(true)},asking?'读消息中…':'问')),
        h('div',{style:{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}},
          h('button',{onClick:()=>ask('请总结我和「'+identity.title+'」最近的聊天要点，按结论、待办、时间线三部分回答，尽量简短。'),disabled:asking,style:small(false)},'总结最近聊天'),
          h('button',{onClick:()=>ask('根据我和「'+identity.title+'」最近的聊天，帮我拟一条得体的回复，只给我正文。'),disabled:asking,style:small(false)},'拟一条回复')),
        asking&&h('p',{style:{...hint,marginTop:12}},'助手正在读微信消息，通常十几秒，不要离开这一页。'),
        answer&&h('div',{style:{marginTop:14,border:'1px solid '+C.border,borderRadius:12,padding:14,background:C.bg}},
          h('div',{style:{fontSize:13,color:C.text3,marginBottom:8}},'助手回答'+(toolText(answer.tools)?(' · '+toolText(answer.tools)):'')),
          h('p',{style:{margin:'0 0 12px',fontSize:15,lineHeight:1.85,color:C.text,whiteSpace:'pre-wrap',wordBreak:'break-word'}},answer.answer),
          h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}},
            h('button',{onClick:()=>saveAnswer('followup'),disabled:busy,style:small(true)},busy?'正在保存…':'存为跟进记录'),
            h('button',{onClick:()=>saveAnswer('todo'),disabled:busy,style:small(false)},'记成待办'),
            savedAs&&h('span',{style:{fontSize:13,color:C.ok,lineHeight:1.6}},'✓ '+savedAs)))),

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
    async function save(){setBusy(true);setError('');try{await api('drafts/'+draft.id+'/revise',{expectedRevision:draft.revision,text});setEditing(false);onChanged();}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function cancel(){if(!window.confirm('取消这条回复草稿吗？'))return;setBusy(true);try{await api('drafts/'+draft.id+'/cancel',{});onChanged();}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function copy(){try{await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),2000);}catch{setError('复制失败了，请手动选中文字复制');}}
    return h('article',{style:{...card,padding:16}},
      h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'center'}},
        h('strong',{style:{fontSize:15,color:C.text}},open?'等你确认的回复':draft.state==='cancelled'?'已取消的草稿':'已过期的草稿'),
        h('span',{style:pill(open?C.warn:null)},'第 '+draft.revision+' 版')),
      editing?h('textarea',{value:text,onChange:event=>setText(event.target.value),rows:4,style:{...field,marginTop:12,resize:'vertical',lineHeight:1.7}})
        :h('p',{style:{margin:'12px 0',fontSize:16,lineHeight:1.85,color:C.text,whiteSpace:'pre-wrap',wordBreak:'break-word'}},draft.text),
      h(Notice,{error}),
      open&&h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
        editing?h(React.Fragment,null,
          h('button',{disabled:busy,onClick:save,style:button(true)},busy?'正在保存…':'保存修改'),
          h('button',{disabled:busy,onClick:()=>{setEditing(false);setText(draft.text);},style:button(false)},'不保存'))
        :h(React.Fragment,null,
          h('button',{disabled:busy,onClick:copy,style:button(true)},copied?'已复制，去微信粘贴':'复制正文'),
          h('button',{disabled:busy,onClick:()=>setEditing(true),style:button(false)},'改一改'),
          h('button',{disabled:busy,onClick:cancel,style:button(false,true)},'不用了'))),
      open&&h('p',{style:{...hint,marginTop:12}},'助手还不能直接替你发出去（发送确认还没接通）。复制这一段，到微信里粘给对应的人就行。'));
  }

  function ContactDetail({store,ctx,items,narrow}){
    const {contactKey}=useStore(store);
    const item=items.find(value=>value.key===contactKey);
    const [actionError,setActionError]=useState('');
    const detail=usePoller(item?.key||false,signal=>fetch('/message-agent/api/conversations/'+item.key,{signal}).then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'暂时无法读取详情');return data;}),8000);
    if(!item)return h(Empty,{title:'选一个人',text:'左边点一个联系人，就能看到和他的聊天情况、要跟进的事，以及让助手帮忙。'});
    const jobs=detail.data?.recentJobs||[],drafts=detail.data?.drafts||[];
    const header=h('header',{style:{position:'sticky',top:0,zIndex:1,padding:'14px 20px',borderBottom:'1px solid '+C.border,background:C.bg,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:12}},
        narrow&&h('button',{onClick:()=>store.set({contactKey:null}),'aria-label':'返回消息列表',style:{...small(false),padding:'8px 12px'}},'←'),
        h('div',null,
          h('h2',{style:{margin:0,fontSize:20,color:C.text}},item.identity.title),
          h('p',{style:{margin:'4px 0 0',fontSize:13,color:C.text3}},(item.identity.kind==='group'?'微信群聊':'微信联系人')+' · '+(item.rule.enabled?'自动回复中':'自动回复已暂停')))),
      item.attentionKind==='connection'&&h('button',{onClick:detail.refresh,style:button(false)},'重新检查'));
    const alertBox=item.attentionReason&&h('div',{style:{padding:'15px 16px',borderRadius:12,border:'1px solid '+(item.bucket==='error'?C.error:C.warn),marginBottom:20}},
      h('strong',{style:{fontSize:15,color:C.text}},item.bucket==='error'?'需要处理一下':'等你处理'),
      h('p',{style:{margin:'7px 0 0',color:C.text2,fontSize:14,lineHeight:1.75}},item.attentionReason),
      item.attentionKind==='send'&&h('p',{style:{margin:'7px 0 0',color:C.text3,fontSize:13,lineHeight:1.7}},
        '助手不会自动重发（避免发重复）。这条到底发出去没有，你去微信里看一眼就行 —— 监听没有中断，新消息照常处理。'),
      item.attentionKind==='connection'&&h('button',{onClick:detail.refresh,style:{...small(false),marginTop:12}},'再检查一次'),
      // A record the user cannot act on is just noise: every attention state needs a way out.
      item.attentionKind==='send'&&h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',marginTop:12}},
        h('button',{onClick:async()=>{
          setActionError('');
          try{await api('conversations/'+item.key+'/ack',{});detail.refresh();}catch(e){setActionError(e.message);}
        },style:small(true)},'知道了'),
        h('button',{onClick:detail.refresh,style:small(false)},'刷新')));
    return h('section',{style:{flex:1,overflowY:'auto',minWidth:0},'aria-label':item.identity.title+'的消息详情'},
      header,
      h('div',{style:{padding:'20px 20px 40px',maxWidth:780}},
        h(Notice,{error:actionError||detail.error}),
        alertBox,
        h(CrmSections,{customerKey:item.key,identity:item.identity,data:detail.data,loading:detail.loading,error:detail.error,onChanged:detail.refresh}),
        // A draft is the one thing that can actually leave the machine, so it keeps a
        // full block — but only when one exists. An empty section is just noise.
        !!drafts.length&&h(Section,{title:'回复草稿',meta:'等你确认'},
          drafts.map(draft=>h(DraftCard,{key:draft.id,draft,onChanged:detail.refresh}))),
        h(Fold,{title:'助手最近做了什么',meta:jobs.length?(jobs.length+' 条'):'暂无'},
          !jobs.length&&h('p',{style:hint},'还没有处理记录。'),
          jobs.map(job=>h('div',{key:job.id,style:{padding:'12px 0',borderBottom:'1px solid '+C.border}},
            h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline'}},
              h('strong',{style:{fontSize:14,color:job.state==='failed'||job.state==='uncertain'?C.error:C.text}},JOB[job.state]||'已处理'),
              h('span',{style:{fontSize:13,color:C.text3}},relativeTime(job.finished_at||job.created_at))),
            job.text&&h('p',{style:{margin:'6px 0 0',color:C.text2,fontSize:14,lineHeight:1.75,whiteSpace:'pre-wrap'}},job.text),
            job.detail&&h('p',{style:{margin:'6px 0 0',color:C.text3,fontSize:13,lineHeight:1.7}},job.detail),
            // A delivery record with no way to close it is just noise: let the user say they
            // have seen it, without touching the record itself.
            (job.state==='failed'||job.state==='uncertain')&&(job.acknowledged
              ?h('p',{style:{margin:'6px 0 0',color:C.text3,fontSize:13}},'已确认看过，不会再提醒')
              :h('button',{onClick:async()=>{
                setActionError('');
                try{await api('conversations/'+item.key+'/ack',{});detail.refresh();}catch(e){setActionError(e.message);}
              },style:{...small(false),marginTop:8}},'这条不用发了，我知道了')))))));
  }

  function MessagesPage({store,ctx,narrow}){
    const {contactKey}=useStore(store),inbox=usePoller(true,loadInbox,5000),items=inbox.data?inbox.data.items:[];
    useEffect(()=>{if(contactKey&&items.length&&!items.some(item=>item.key===contactKey))store.set({contactKey:null});},[contactKey,items.length,store]);
    if(inbox.loading&&!inbox.data)return h(Empty,{title:'正在读取消息',text:'请稍等一下…'});
    if(inbox.error&&!inbox.data)return h(Empty,{title:'暂时读不到消息',text:inbox.error},h('button',{onClick:inbox.refresh,style:button(true)},'重新读取'));
    if(!items.length)return h(NoConversations,{store});
    return h('div',{style:{display:'flex',height:'100%',width:'100%',minWidth:0}},
      (!narrow||!contactKey)&&h('div',{style:{width:narrow?'100%':360,flexShrink:0,borderRight:narrow?'none':'1px solid '+C.border}},h(InboxList,{store,items,narrow})),
      (!narrow||contactKey)&&h(ContactDetail,{store,ctx,items,narrow}));
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
      h('button',{onClick:()=>onAction(done?'reopen':'done',todo),disabled:busy,title:done?'重新打开':'标记完成','aria-label':done?'重新打开':'标记完成',
        style:{width:22,height:22,marginTop:2,borderRadius:6,border:'1px solid '+(done?C.ok:C.border),background:done?C.ok:'transparent',cursor:'pointer',flexShrink:0,color:'var(--dsw-alias-bg-base)',fontSize:13,lineHeight:1,padding:0}},done?'✓':''),
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
    async function act(action,todo){
      setBusy(true);setError('');
      try{
        if(action==='done')await api('todos/'+todo.todoId+'/done',{});
        else if(action==='reopen')await api('todos/'+todo.todoId+'/reopen',{});
        else if(action==='tomorrow')await api('todos/'+todo.todoId+'/reopen',{dueAt:fromDateInput(toDateInput(dayStart(1))).toISOString()});
        else if(action==='delete')await api('todos/'+todo.todoId+'/delete',{});
        today.refresh();
      }catch(e){setError(e.message);}finally{setBusy(false);}
    }
    async function addTodo(_,text,dueAt){try{await api('todos',{title:text,dueAt,source:'manual'});setAdding(false);today.refresh();}catch(e){setError(e.message);}}
    const go=(key)=>{store.set({tab:'messages',contactKey:key});};
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
                  children:h('div',{style:{display:'flex',gap:10,alignItems:'center',marginTop:10,flexWrap:'wrap'}},
                    entry.identity&&h('span',{style:{fontSize:13,color:C.text3}},(entry.identity.kind==='group'?'群聊 ':'')+entry.identity.title),
                    due&&h('span',{style:pill(C.warn)},'快到时间了'),
                    h('button',{onClick:()=>go(entry.conversationKey),style:small(true)},entry.kind==='draft'?'去看草稿':'去看看'))});
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
              h('button',{onClick:()=>store.set({tab:'messages',contactKey:current.key}),style:button(false)},'去看聊天记录')),
            h('div',{style:{padding:'20px 20px 60px',maxWidth:780}},
              h(CrmSections,{customerKey:current.key,identity:current.identity,data:detail.data,loading:detail.loading,error:detail.error,onChanged:()=>{detail.refresh();list.refresh();}}))));
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
        h('p',{style:{margin:'0 0 18px',color:C.text2,fontSize:14,lineHeight:1.8,maxWidth:640}},'给需要的人开启，助手会替你回日常消息；拿不准的事情会留给你。不用了随时可以暂停。'),
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
          status.data.jobs.slice(0,15).map(job=>h('div',{key:job.id,style:{padding:'10px 0',borderBottom:'1px solid '+C.border,fontSize:14}},
            h('strong',{style:{color:job.state==='failed'||job.state==='uncertain'?C.error:C.text}},JOB[job.state]||'已处理'),
            h('span',{style:{color:C.text2}},' · '+firstLine(job.text||job.detail||'',70)))))));
  }

  function SettingsPage(){
    const status=usePoller(true,()=>api('status'),10000),data=status.data;
    const ok=data&&!data.error;
    return h('div',{style:{width:'100%',overflowY:'auto'}},
      h('div',{style:{padding:'24px clamp(18px,4vw,48px) 60px',maxWidth:760}},
        h('h1',h1,'设置'),
        h(Notice,{error:status.error}),
        h('section',{style:card},
          h('div',{style:{display:'flex',alignItems:'center',gap:12}},
            h('span',{style:{fontSize:22,color:ok?C.ok:C.text3}},'●'),
            h('div',null,
              h('strong',{style:{display:'block',fontSize:16,color:C.text}},ok?'消息服务运行正常':'正在检查消息服务'),
              h('span',{style:{fontSize:13,color:C.text3}},data?('已接入 '+data.rules.length+' 个联系人'):'请稍等…'))),
          h('p',{style:{marginTop:16,color:C.text2,fontSize:14,lineHeight:1.8}},'聊天内容、跟进记录和待办都存在这台电脑上。使用云端模型时，为了完成你的要求，相关聊天内容会发送给模型服务。')),
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

  const NAV=[['messages','消息'],['today','今天要做的'],['customers','联系人'],['automation','自动回复']];
  const NAV_ICON={messages:'messages',today:'today',customers:'contacts',automation:'automation'};
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
      h('style',null,'[data-ma] button:focus-visible,[data-ma] input:focus-visible,[data-ma] textarea:focus-visible,[data-ma] select:focus-visible{outline:3px solid var(--dsw-alias-brand-primary);outline-offset:2px}[data-ma] button:disabled{opacity:.55;cursor:not-allowed}[data-ma] summary{cursor:pointer}'),
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
          :tab==='automation'?h(AutomationPage):h(SettingsPage)));
  }
  function LegacySettings(){return h('div',{style:{padding:24,maxWidth:760}},h('h2',null,'消息助手'),h('p',{style:{color:C.text2}},'日常使用请打开侧边栏里的「消息助手」。这里保留高级配置入口。'),h(SettingsPage));}
  const TOOL_NAMES=['mcp__messaging__list_conversations','mcp__messaging__read_messages','mcp__messaging__sync_conversation','mcp__messaging__search_messages','mcp__messaging__send_message','mcp__messaging__reply_message','mcp__messaging__get_send_status','submit_reply_decision'];
  return{inject:['slots','sessions'],apply(ctx){
    const saved=readSaved(),store=createStore({open:saved.open===undefined?true:saved.open,cover:saved.cover===undefined?true:saved.cover,tab:saved.tab||'messages',contactKey:saved.contactKey||null,customerKey:saved.customerKey||null,filter:saved.filter||'all',pending:0});
    ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'message-agent-workbench',order:5,label:()=> '消息助手'},({wide})=>h(NavEntry,{store,wide})));
    ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'message-agent-workbench',order:20},()=>h(Workbench,{ctx,store})));
    ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'messaging-agent',order:15,label:()=> '消息助手'},LegacySettings));
    ctx.slots.inject('tool.call.toolview',function*(){for(const key of TOOL_NAMES)yield ctx.slots.register({name:'tool.call.toolview',key},MessageToolCard);});
  }};
}});
