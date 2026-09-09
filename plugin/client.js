window.__ModuleLoader__.load({id:'messaging-agent-ui',factory:(require)=>{
  const React=require('react');
  const h=React.createElement;
  async function api(path,data){
    const r=await fetch('/message-agent/api/'+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
    const result=await r.json();if(!r.ok)throw Error(result.error||'请求失败');return result;
  }
  function Settings(){
    const [state,setState]=React.useState({rules:[],jobs:[]}),[choices,setChoices]=React.useState([]),[error,setError]=React.useState('');
    const [conversation,setConversation]=React.useState(''),[kind,setKind]=React.useState('direct');
    const [prompt,setPrompt]=React.useState('用自然、友好、简短的中文回复日常聊天；不要编造事实或代替用户作出承诺。');
    const refresh=()=>api('status').then(setState).catch(e=>setError(e.message));
    React.useEffect(()=>{refresh();const timer=setInterval(refresh,3000);return()=>clearInterval(timer);},[]);
    async function action(path,data){try{setError('');await api(path,data);refresh();}catch(e){setError(e.message);}}
    const button=(label,fn)=>h('button',{onClick:fn,style:{padding:'7px 12px',border:'1px solid #8886',borderRadius:7,marginRight:8,cursor:'pointer'}},label);
    return h('div',{style:{padding:24,maxWidth:850,display:'grid',gap:18}},
      h('h2',null,'消息助手'),h('p',null,'DeepSeek Harness 处理任务 · messaging-runtime 负责消息读写。新消息会创建可在左侧查看的独立任务。'),
      error&&h('p',{role:'alert',style:{color:'#d65'}},error),
      h('div',null,button('读取微信会话',async()=>{try{const r=await api('conversations');setChoices(r.conversations);if(r.conversations.length)setConversation(r.conversations[0].id);}catch(e){setError(e.message);}})),
      h('select',{value:conversation,onChange:e=>setConversation(e.target.value)},h('option',{value:''},'选择联系人或群组'),...choices.map(c=>h('option',{key:c.id,value:c.id},c.title))),
      h('select',{value:kind,onChange:e=>setKind(e.target.value)},h('option',{value:'direct'},'联系人'),h('option',{value:'group'},'群组')),
      h('textarea',{value:prompt,onChange:e=>setPrompt(e.target.value),rows:3,style:{padding:10,border:'1px solid #8886',borderRadius:8},'aria-label':'自动回复规则'}),
      h('div',null,button('添加规则',()=>action('rules',{conversation_id:conversation,kind,prompt}))),
      ...state.rules.map(r=>h('div',{key:r.id,style:{padding:16,border:'1px solid #8885',borderRadius:10}},h('strong',null,r.title+' · '+r.status),h('p',null,r.prompt),h('p',null,r.detail),button(r.enabled?'暂停':'启用',()=>action(r.enabled?'pause':'enable',{id:r.id})),button('保存上方提示词',()=>action('edit',{id:r.id,prompt})))),
      h('h3',null,'最近消息任务'),...state.jobs.slice(0,15).map(j=>h('div',{key:j.id},h('strong',null,j.state),h('span',null,' · '+(j.text||j.detail||j.id)))));
  }
  return {inject:['slots'],apply(ctx){ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'messaging-agent',order:15,label:()=> '消息助手'},Settings));}};
}});
