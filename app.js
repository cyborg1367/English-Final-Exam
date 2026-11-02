/* English Final Exam — static GitHub Pages client.
   Backend: Apps Script POST (simple no-cors) + READ-ONLY JSONP confirmation.
   No automatic grading or answer key is bundled.
*/
(() => {
'use strict';
const CFG=window.EXAM_CONFIG||{};
const API=String(CFG.APPS_SCRIPT_URL||'').trim();
const DEMO=!API;
const PREVIEW_REQUESTED=new URLSearchParams(window.location.search).get('preview')==='1';
const DURATION=Number(CFG.DURATION_MINUTES)||80;
// Keep preview and live sessions separate, so an old preview submission never blocks live enrollment.
const STORAGE_KEY=DEMO?'english_final_exam_preview_v2':'english_final_exam_live_v2_'+Array.from(API).reduce((h,c)=>(Math.imul(31,h)+c.charCodeAt(0))>>>0,0).toString(16);
const AUDIO_FILES={1:'assets/listening-part-1.mp3',2:'assets/listening-part-2.mp3'};
const PARTS=[
  {id:'vocabulary',name:'Vocabulary',from:1,to:36,detail:'18 points'},
  {id:'grammar',name:'Grammar',from:37,to:55,detail:'13 points'},
  {id:'reading',name:'Reading',from:56,to:63,detail:'4 points'},
  {id:'writing',name:'Writing',from:64,to:64,detail:'10 points'},
  {id:'listening',name:'Listening',from:65,to:74,detail:'10 points'}
];
const app=document.getElementById('app');
const player=document.getElementById('listening-audio');
const timerNode=document.getElementById('timer-head');
const confirmDialog=document.getElementById('confirm-dialog');
let examData=null, state=null, currentId=1, busy=false, savingTimer=null;
let activeAudio=null, playBusy=false, requestCounter=0, operationChain=Promise.resolve();
let serverOffset=0, timerJob=null, syncing=false, lastToast=0, mainRetryNeeded=false;
// After the timer reaches zero, the frozen final snapshot may be transmitted for up to 30s.
// The same transport-only window is enforced by Apps Script; it never adds writing time.
const MAIN_FINAL_GRACE_MS=30000;
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const clockMs=()=>Date.now()+serverOffset;
const isMain=()=>state&&state.stage==='MAIN';
const qs=id=>examData.questions[id-1];
const answers=()=>state.stage==='MAIN'?state.mainAnswers:state.listeningAnswers;
const displayedPart=()=>PARTS.find(p=>currentId>=p.from&&currentId<=p.to)||PARTS[0];
const hasResponse=v=>String(v??'').split(' | ').some(piece=>piece.trim().length>0);
const count=(from,to)=>Array.from({length:to-from+1},(_,i)=>String(from+i)).filter(key=>hasResponse((from<=64?state.mainAnswers:state.listeningAnswers)[key])).length;
const readingPassage=(title,body)=>`<section class="passage-card"><div class="eyebrow">Source passage</div><h3>${escapeHtml(title)}</h3><div class="passage">${escapeHtml(body)}</div></section>`;
const mmss=ms=>{const total=Math.max(0,Math.ceil(ms/1000));return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;};
const showToast=(message,timeout=3400)=>{const n=document.getElementById('toast');n.textContent=message;n.hidden=false;const stamp=++lastToast;setTimeout(()=>{if(stamp===lastToast)n.hidden=true;},timeout);};
const connection=(str,klass='')=>{const n=document.getElementById('connection-label');n.textContent=str;n.className='pill '+klass;};
const updateSaveLabel=(message,kind='')=>{const n=document.querySelector('#save-status');if(n){n.textContent=message;n.className='footer-status '+kind;}};
function persist(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch(e){/* storage optional */}}
function remembered(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');}catch(e){return null;}}
const token=()=>{if(window.crypto&&crypto.randomUUID)return crypto.randomUUID()+'-'+crypto.randomUUID();return 'exam-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);};
function useServer(s,{initial=false}={}){
  serverOffset=s.serverNow-Date.now();
  // Track what the server really holds, separately from unsaved local revisions.
  const serverMainRev=Number(s.mainRev)||0;
  if(!state){state={token:'',...s,serverMainRev};return;}
  const localMain=state.mainAnswers||{},localListen=state.listeningAnswers||{};
  const localMainRev=state.mainRev||0,localListenRev=state.listeningRev||0;
  const oldStage=state.stage;
  const remoteMain=s.mainRev>=localMainRev?s.mainAnswers:localMain;
  const remoteListen=s.listeningRev>=localListenRev?s.listeningAnswers:localListen;
  Object.assign(state,s,{serverMainRev,mainAnswers:remoteMain,listeningAnswers:remoteListen,
    mainRev:Math.max(s.mainRev,localMainRev),listeningRev:Math.max(s.listeningRev,localListenRev)});
  // The server is authoritative about whether timed questions remain editable.
  if(s.stage!=='MAIN')state.mainAnswers=s.mainAnswers;
  if(s.stage==='DONE')state.listeningAnswers=s.listeningAnswers;
  if(oldStage!==state.stage&&!initial){currentId=state.stage==='MAIN'?1:65;render();}
  persist();
}
function jsonp(action,extras={}){
  return new Promise((resolve,reject)=>{
    if(!API){reject(new Error('No Apps Script URL configured'));return;}
    const cb='__examcb_'+(++requestCounter);
    const query=new URLSearchParams({action,prefix:cb,_t:Date.now().toString(),...extras});
    const script=document.createElement('script');
    const cleanup=()=>{clearTimeout(timeout);script.remove();delete window[cb];};
    const timeout=setTimeout(()=>{cleanup();reject(new Error('Google Sheets connection timed out'));},18000);
    window[cb]=value=>{cleanup();if(value&&value.ok)resolve(value);else reject(new Error(value?.error||'Google Sheets request failed'));};
    script.onerror=()=>{cleanup();reject(new Error('Cannot reach Google Apps Script'));};
    script.src=API+(API.includes('?')?'&':'?')+query.toString();
    document.head.appendChild(script);
  });
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function readRemote(){const response=await jsonp('state',{token:state.token});useServer(response.state);return response.state;}
async function postOpaque(payload){
  await fetch(API,{method:'POST',mode:'no-cors',cache:'no-store',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify(payload),redirect:'follow'});
}
async function commit(payload,confirmed,tries=3){
  if(DEMO){localMutation(payload);persist();return state;}
  let lastError=null;
  for(let attempt=0;attempt<tries;attempt++){
    try{await postOpaque(payload);}catch(e){lastError=e;}
    for(let attemptRead=0;attemptRead<4;attemptRead++){
      await wait(350+attemptRead*350);
      try{const remote=await readRemote();if(confirmed(remote))return remote;}
      catch(e){lastError=e;}
    }
  }
  throw new Error('No server confirmation received. '+(lastError?lastError.message:'Check your connection.'));
}
function serialized(op){const result=operationChain.catch(()=>{}).then(op);operationChain=result;return result;}
function localMutation(p){
  const now=Date.now();
  if(p.action==='saveMain'||p.action==='sealMain'){
    if(state.stage!=='MAIN')return;
    if(p.action==='saveMain'&&now>=state.deadline)return;
    if(now>state.deadline+MAIN_FINAL_GRACE_MS){state.stage='LISTENING';state.mainLockedAt=state.deadline;return;}
    if(p.revision>=state.mainRev){state.mainRev=p.revision;state.mainAnswers={...p.answers};}
    if(p.action==='sealMain'){state.mainLockedAt=Math.min(now,state.deadline);state.stage='LISTENING';}
  }else if(p.action==='claimPlay'){
    if(state.stage!=='LISTENING')throw new Error('Listening is not open');
    if(!state.claimIds.includes(p.requestId)){
      const key=p.audio===1?'audio1Plays':'audio2Plays';
      if(state[key]>=2)throw new Error('Playback limit reached');
      state[key]++;state.claimIds.push(p.requestId);
    }
  }else if(p.action==='saveListening'||p.action==='finish'){
    if(state.stage!=='LISTENING')return;
    if(p.revision>=state.listeningRev){state.listeningRev=p.revision;state.listeningAnswers={...p.answers};}
    if(p.action==='finish'){state.stage='DONE';state.listeningSubmittedAt=now;}
  }
}
function nextRevision(last){return Math.max(Date.now(),Number(last||0)+1);}
function setAnswer(questionId,value){
  if(!state||busy||state.stage==='DONE'||(state.stage==='MAIN'&&(state.pendingMainSeal||clockMs()>=state.deadline)))return;
  const target=state.stage==='MAIN'?'mainAnswers':'listeningAnswers';
  state[target][questionId]=value;
  state[state.stage==='MAIN'?'mainRev':'listeningRev']=nextRevision(state[state.stage==='MAIN'?'mainRev':'listeningRev']);
  persist();refreshNavigation();updateSaveLabel('Unsaved changes');
  clearTimeout(savingTimer);savingTimer=setTimeout(()=>{saveAnswers().catch(err=>{connection('Connection issue','red');updateSaveLabel('Not saved · Retry');showToast(err.message,5000);});},900);
}
function saveAnswers(){
  if(!state||state.stage==='DONE'||(state.stage==='MAIN'&&state.pendingMainSeal))return Promise.resolve();
  const stage=state.stage;
  const p=stage==='MAIN'?{action:'saveMain',token:state.token,revision:state.mainRev,answers:{...state.mainAnswers}}
                            :{action:'saveListening',token:state.token,revision:state.listeningRev,answers:{...state.listeningAnswers}};
  return serialized(async()=>{
    if(state.stage!==stage)return;
    if(stage==='MAIN'&&clockMs()>=state.deadline)return;
    syncing=true;updateSaveLabel('Saving…');
    try{
      const done=await commit(p,s=>s.stage!==(stage==='MAIN'?'MAIN':'LISTENING') ||
        (stage==='MAIN'?s.mainRev:s.listeningRev)>=p.revision,2);
      if(done.stage!==stage&&state.stage!==stage)render();
      connection(DEMO?'Preview only':'Connected',DEMO?'gold':'green');
      updateSaveLabel('Answers saved','saved');
    }finally{syncing=false;}
  });
}
function advanceWindow(){
  if(!state)return;
  document.getElementById('student-head').textContent=state.studentName||'';
  timerNode.hidden=state.stage!=='MAIN';
  if(state.stage==='MAIN'){
    const remaining=state.deadline-clockMs();
    timerNode.textContent=mmss(remaining);
    timerNode.classList.toggle('urgent',remaining<5*60000);
    if((remaining<=0||state.pendingMainSeal)&&!busy&&!mainRetryNeeded){
      lockTimedSection(true).catch(err=>{
        connection('Connection issue','red');showToast(err.message,6000);
      });
    }
  }
}
function navGroups(){
  const allowed=state.stage==='MAIN'?PARTS.slice(0,4):PARTS.slice(4);
  return allowed.map(p=>{
    if(p.id==='listening'){
      return `<div class="sidebar-section"><div class="navigator-label">Listening sections</div>
      ${[1,2].map(part=>{const lo=part===1?65:70,hi=part===1?69:74;return `<button type="button" class="listening-nav ${currentId===lo?'active':''}" data-listening-part="${part}"><span class="listening-nav-title">Part ${part} · ${part===1?'Animal facts':'Celebrations'}</span><span class="listening-nav-detail">Questions ${lo}–${hi} · <span data-listening-progress="${part}">${count(lo,hi)} / 5 answered</span></span></button>`;}).join('')}</div>`;
    }
    const nav=Array.from({length:p.to-p.from+1},(_,i)=>{
      const id=p.from+i, val=(p.from<=64?state.mainAnswers:state.listeningAnswers)[id];
      return `<button class="qnav ${hasResponse(val)?'answered':''} ${id===currentId?'current':''} ${flags.has(id)?'flagged':''}" data-jump="${id}" title="Question ${id}" type="button">${id}</button>`;
    }).join('');
    return `<div class="sidebar-section"><div class="navigator-label">${escapeHtml(p.name)}</div><div class="question-grid">${nav}</div></div>`;
  }).join('');
}
const flags=new Set();
function refreshNavigation(){
  if(!state)return;
  const from=isMain()?1:65,to=isMain()?64:74,total=to-from+1,n=count(from,to);
  const bar=document.querySelector('.progress-track span');if(bar)bar.style.width=(100*n/total)+'%';
  const nspan=document.getElementById('progress-number');if(nspan)nspan.textContent=`${n} / ${total} answered`;
  const pctNode=document.getElementById('progress-pct');if(pctNode)pctNode.textContent=Math.round(100*n/total)+'%';
  document.querySelectorAll('.qnav[data-jump]').forEach(el=>{
    const id=Number(el.dataset.jump),set=(id<=64?state.mainAnswers:state.listeningAnswers);
    el.classList.toggle('answered',hasResponse(set[id]));
  });
  document.querySelectorAll('[data-listening-progress]').forEach(el=>{const part=Number(el.dataset.listeningProgress);el.textContent=count(part===1?65:70,part===1?69:74)+' / 5 answered';});
  const confirmNode=document.getElementById('confirm-count');if(confirmNode)confirmNode.textContent=`${count(1,64)} / 64`;
}
function sidebar(){
  const from=isMain()?1:65,to=isMain()?64:74,n=count(from,to);
  return `<aside class="sidebar"><div class="side-title">Your progress</div><div class="progress-track"><span style="width:${100*n/(to-from+1)}%"></span></div>
    <div class="progress-copy"><span id="progress-number">${n} / ${to-from+1} answered</span><span id="progress-pct">${Math.round(100*n/(to-from+1))}%</span></div>
    <div class="sidebar-nav">${navGroups()}</div>
    <div class="side-note">${isMain()?'You can change answers until the ${DURATION}-minute deadline. Once locked, this stage cannot be reopened.':'Listening is untimed. Each recording may be played only twice, with no pause, replay within a play, or seeking.'}</div>
    ${isMain()?'<button type="button" class="button primary full" data-action="confirm-main">Finish timed section →</button>':'<button type="button" class="button primary full" data-action="confirm-listening">Submit final exam →</button>'}
  </aside>`;
}
function blankValues(value,number){
  // Existing answers from the earlier version may be comma-separated.
  const raw=String(value||'');
  const parts=raw.includes(' | ')?raw.split(' | '):(raw.includes(',')?raw.split(','):raw?[raw]:[]);
  return Array.from({length:number},(_,i)=>(parts[i]||'').trim());
}
function inlineBlanks(q,value){
  const chunks=q.prompt.split(/_{4,}/g);
  const number=chunks.length-1,values=blankValues(value,number);
  return `<div class="answer-label">Fill in each blank separately</div><div class="inline-sentence">${chunks.map((segment,i)=>
    escapeHtml(segment)+(i<number?`<input class="inline-blank" type="text" data-answer="${q.id}" data-blank-index="${i}" data-blank-total="${number}" aria-label="Question ${q.id}, blank ${i+1} of ${number}" autocomplete="off" spellcheck="false" placeholder="Blank ${i+1}" value="${escapeHtml(values[i])}">`:'')
  ).join('')}</div><div class="hint-box">Write one missing word or verb form in each box.</div>`;
}
function answerMarkup(q){
  const value=String(answers()[q.id]||'');
  if(q.kind==='single'){
    return `<div class="answer-label">Choose one answer</div><div class="options">${q.options.map((v,i)=>{
      const k=String.fromCharCode(65+i),chosen=value===k;
      return `<label class="option ${chosen?'selected':''}"><input type="radio" name="answer-${q.id}" data-answer="${q.id}" value="${k}" ${chosen?'checked':''}><span class="option-letter">${k}</span><span class="option-text">${escapeHtml(v)}</span></label>`;
    }).join('')}</div>`;
  }
  if(q.kind==='select'){
    const uniqueGroup=q.id>=21&&q.id<=26?[21,22,23,24,25,26]:q.id>=70&&q.id<=74?[70,71,72,73,74]:[];
    const selectedElsewhere=new Set(uniqueGroup.filter(i=>i!==q.id).map(i=>String(answers()[i]||'')));
    return `<div class="answer-label">Select one answer</div><select class="answer-select" data-answer="${q.id}"><option value="">Select an option…</option>${q.options.map((v,i)=>`<option value="${escapeHtml(v)}" ${value===v?'selected':''} ${selectedElsewhere.has(v)&&value!==v?'disabled':''}>${escapeHtml(v)}</option>`).join('')}</select>`;
  }
  if(q.kind==='text' && [50,52,54,55].includes(q.id))return inlineBlanks(q,value);
  const label=q.kind==='writing'?'Your blog post':q.kind==='textarea'?'Rewrite the complete sentence':'Your answer';
  if(q.kind==='writing'||q.kind==='textarea'){
    const countWords=value.trim()?value.trim().split(/\s+/).length:0;
    return `<div class="answer-label">${label}</div><textarea class="answer-textarea ${q.kind==='writing'?'writing':''}" data-answer="${q.id}" spellcheck="false" placeholder="Type your answer here…">${escapeHtml(value)}</textarea>
    ${q.kind==='writing'?`<div class="writing-info"><span>Write 50–80 words.</span><span id="word-count" class="${countWords>=50&&countWords<=80?'good':'warn'}">${countWords} words</span></div>`:''}`;
  }
  return `<div class="answer-label">${label}</div><input type="text" class="answer-field" autocomplete="off" spellcheck="false" data-answer="${q.id}" value="${escapeHtml(value)}" placeholder="Type your answer…">${q.id>=50&&q.id<=55?'<div class="hint-box">For questions with multiple blanks, enter the missing forms in order, separated by commas.</div>':''}`;
}
function relatedPassage(q){
  if(q.hint==='cloze')return readingPassage('Travelling and cities',examData.cloze);
  if(q.hint==='reading')return readingPassage('Digital habits across generations',examData.reading);
  if(q.hint==='menu')return `<section class="passage-card"><div class="eyebrow">Vocabulary · Illustrated menu</div><img class="menu-image" src="assets/menu.jpeg" alt="Restaurant menu with starters, main courses and desserts. Use this image to complete blanks 27 through 32."></section>`;
  return '';
}
function mainQuestion(){
  const q=qs(currentId),section=displayedPart();
  const passage=relatedPassage(q);
  let extra='';
  if(q.id>=21&&q.id<=26)extra=`<div class="word-chip-row">${examData.wordBank.map(x=>`<span class="word-chip">${escapeHtml(x)}</span>`).join('')}</div>`;
  return `<div class="workspace"><div class="workspace-intro"><div><div class="eyebrow">Stage 01 · Timed exam</div><h2>${escapeHtml(section.name)}</h2><p>${escapeHtml(q.subsection)} · ${escapeHtml(section.detail)}</p></div>
    <div class="workspace-top-meta"><span class="pill green">Timed · ${DURATION} minutes</span><span class="pill">Q ${currentId} / 64</span></div></div>
    <div class="${passage?'passage-layout':''}">${passage}<section class="question-card"><div class="question-top"><span class="eyebrow">Question ${currentId}</span><span class="pill ${flags.has(currentId)?'gold':''}">${flags.has(currentId)?'Flagged for review':'Manual grading'}</span></div>
    <div class="question-title">${escapeHtml(q.prompt)}</div>${extra}${answerMarkup(q)}${footer()}</section></div>
    <div class="footer-line"><span>You may revisit any timed question before submitting this stage.</span><span>Answers are saved automatically.</span></div></div>`;
}
function footer(){
  const min=isMain()?1:65,max=isMain()?64:74;
  const isLast=currentId===max;
  return `<div class="question-footer"><button class="button ${flags.has(currentId)?'flag-active':''}" data-action="flag" type="button">${flags.has(currentId)?'★ Review marked':'☆ Mark for review'}</button>
  <div class="nav-actions"><button class="button" data-action="prev" ${currentId===min?'disabled':''}>← Previous</button><button class="button primary" data-action="${isLast?(isMain()?'confirm-main':'confirm-listening'):'next'}">${isLast?(isMain()?'Finish timed section':'Submit final exam'):'Next →'}</button></div></div>
  <div class="footer-line"><span id="save-status" class="footer-status saved">Answers saved</span><span>Question ${currentId} of ${max}</span></div>`;
}
function audioCard(part){
  const used=part===1?state.audio1Plays:state.audio2Plays;
  const rem=Math.max(0,2-used);
  const partTitle=part===1?'Part 1 · Animal facts':'Part 2 · Celebrations';
  const isPlaying=activeAudio===part && !player.paused;
  const reserved=state.reservedAudio===part;
  const disabled=playBusy || activeAudio!==null || (rem===0 && !reserved);
  return `<section class="audio-card"><div class="audio-head"><div><strong>${partTitle}</strong><p>Recording ${part} · ${part===1?'Questions 65–69':'Questions 70–74'}</p></div><span class="pill ${rem===0?'red':'gold'}">${rem} ${rem===1?'play':'plays'} left</span></div>
    <div class="audio-actions"><button class="button primary" data-action="play-${part}" ${disabled?'disabled':''}>${isPlaying?'▶ Playing…':playBusy?'Preparing…':reserved?'▶ Start reserved audio':rem===0?'Playback limit reached':'▶ Play recording'}</button><div class="audio-progress"><span id="audio-progress-${part}" style="width:${isPlaying&&player.duration?100*player.currentTime/player.duration:0}%"></span></div><span class="small muted mono">${isPlaying&&Number.isFinite(player.duration)?mmss(player.duration*1000-player.currentTime*1000):'2 plays max'}</span></div>
    <div class="audio-note">A play is used when you press Play, even if you refresh or close the page. No pause, resume, replay inside the recording or seeking.</div></section>`;
}
function listeningQuestion(){
  const part=currentId<=69?1:2;
  const first=part===1?65:70,last=part===1?69:74;
  const label=part===1?'Part 1 · Animal facts':'Part 2 · Celebrations';
  const questions=Array.from({length:5},(_,i)=>qs(first+i));
  return `<div class="workspace listening-workspace"><div class="workspace-intro"><div><div class="eyebrow">Stage 02 · Untimed exam</div><h2>Listening · Part ${part}</h2><p>${escapeHtml(label)} · Questions ${first}–${last}</p></div><div class="workspace-top-meta"><span class="pill green">No time limit</span><span class="pill">${count(first,last)} / 5 answered</span></div></div>
  <section class="listening-intro"><div><h3>Listen carefully.</h3><p class="small muted">All five questions for this recording are shown below. You may play the recording at most twice.</p></div><span class="pill gold">No pause / No seek</span></section>
  ${audioCard(part)}
  <div class="listening-questions">${questions.map(q=>`<section class="question-card listening-question" id="question-${q.id}"><div class="question-top"><span class="eyebrow">Question ${q.id}</span><span class="pill">${q.id<=69?'True / False':'Match the speaker'}</span></div><div class="question-title">${escapeHtml(q.prompt)}</div>${answerMarkup(q)}</section>`).join('')}</div>
  <div class="listening-page-actions"><span id="save-status" class="footer-status saved">Answers saved</span><div class="nav-actions">${part===2?'<button class="button" data-action="listening-prev" type="button">← Part 1</button>':''}<button class="button primary" type="button" data-action="${part===1?'listening-next':'confirm-listening'}">${part===1?'Continue to Part 2 →':'Submit final exam →'}</button></div></div>
  <div class="footer-line"><span>Every recording has a separate two-play limit.</span><span>Part ${part} of 2</span></div></div>`;
}
function entry(){
  timerNode.hidden=true;
  document.getElementById('student-head').textContent='';
  app.innerHTML=`<section class="login-layout"><div class="login-story"><div class="eyebrow">Learn. Think. Express.</div><h1>Every word<br>has meaning.</h1><p>A structured assessment of your English skills, from vocabulary and grammar to reading, writing and listening.</p><div class="story-art" aria-hidden="true"><div class="story-orbit"></div><div class="story-orbit second"></div><div class="story-book"></div></div><div class="story-bottom"><div class="eyebrow">Your instructor</div><strong>${escapeHtml(CFG.INSTRUCTOR||'Course Instructor')}</strong><div class="small" style="color:#bdd3c7">English Final Assessment</div></div></div>
    <form class="login-form" id="entry-form"><div class="eyebrow">Ready when you are</div><h2>Enter your assessment</h2><p>First complete the ${DURATION}-minute section. Listening follows separately, with only two plays available per audio.</p>
      <div class="overview-facts"><div class="fact"><strong>74</strong><span>Questions</span></div><div class="fact"><strong>${DURATION}</strong><span>Timed minutes</span></div><div class="fact"><strong>2</strong><span>Exam stages</span></div></div>
      <label class="field-label" for="student-name">Full name</label><input class="field" id="student-name" name="name" type="text" required minlength="2" maxlength="120" placeholder="Enter your full name" autocomplete="name">
      <label class="field-label" for="student-id">Student ID</label><input class="field" id="student-id" name="studentId" type="text" required minlength="2" maxlength="80" placeholder="Enter your student ID" autocomplete="off">
      <p class="form-error" id="entry-error" role="alert"></p><button class="button primary full" type="submit" id="entry-start">Start timed section →</button>
      <div class="rules"><strong>Exam rules</strong><ul><li>The first 64 questions have one shared ${DURATION}-minute timer.</li><li>When the first stage ends, it locks permanently. No return is possible.</li><li>Listening has no time limit. Each recording can be started only twice, with no pause or seeking.</li><li>Your instructor grades all responses manually.</li></ul></div>
    </form></section>`;
  document.getElementById('entry-form').addEventListener('submit',start);
}
async function start(e){
  e.preventDefault();
  const name=document.getElementById('student-name').value.trim(),studentId=document.getElementById('student-id').value.trim();
  const err=document.getElementById('entry-error'),button=document.getElementById('entry-start');
  if(name.length<2||studentId.length<2){err.textContent='Enter your name and student ID.';return;}
  button.disabled=true;err.textContent='Starting your exam…';
  const t=token(),now=Date.now();
  state={token:t,studentId,studentName:name,examId:'PREVIEW-'+Math.floor(now/1000),stage:'MAIN',startedAt:now,deadline:now+DURATION*60000,
    mainLockedAt:null,mainRev:0,mainAnswers:{},audio1Plays:0,audio2Plays:0,claimIds:[],listeningRev:0,listeningAnswers:{},listeningSubmittedAt:null};
  try{
    if(!DEMO){
      await commit({action:'start',token:t,studentId,studentName:name},s=>!!s.examId,3);
    }
    persist();currentId=1;render();
  }catch(error){err.textContent=error.message+' Please retry, or contact your instructor.';button.disabled=false;state=null;}
}
function render(){
  if(!state){entry();return;}
  document.getElementById('student-head').textContent=state.studentName;
  if(state.stage==='DONE'){completed();return;}
  if(state.stage==='LISTENING'&&state.pendingMainSeal){
    if(DEMO||Number(state.serverMainRev||0)>=state.pendingMainSeal.revision){
      delete state.pendingMainSeal;persist();
    }else{
      timerNode.hidden=true;
      app.innerHTML='<section class="retry-panel"><h2>The timed stage is locked.</h2><p>The server has locked the exam, but could not confirm the last Writing changes. Earlier autosaved answers remain recorded. Contact the instructor; these responses cannot be edited or resent.</p></section>';
      return;
    }
  }
  if(state.stage==='MAIN'&&(state.pendingMainSeal||clockMs()>=state.deadline)){
    app.innerHTML=`<div class="loading-panel"><strong>Your timed section is closed.</strong><p>Transferring the final saved answers, including Writing. No further edits are allowed…</p></div>`;
    advanceWindow();return;
  }
  if(state.stage==='MAIN'&&(currentId<1||currentId>64))currentId=1;
  if(state.stage==='LISTENING'&&(currentId<65||currentId>74))currentId=65;
  timerNode.hidden=state.stage!=='MAIN';
  app.innerHTML=`<div class="exam-layout">${sidebar()}<div>${state.stage==='MAIN'?mainQuestion():listeningQuestion()}</div></div>`;
  refreshNavigation();advanceWindow();
}
function completed(){
  timerNode.hidden=true;
  const local=DEMO?'This is a preview. No responses have been sent to Google Sheets.':'Your responses have been received for instructor review.';
  app.innerHTML=`<div class="completed-wrap"><div class="completion-icon">✓</div><div class="eyebrow">Assessment completed</div><h1>Exam submitted.</h1><p>Thank you, ${escapeHtml(state.studentName)}. ${local} Your answers are now locked. Scores and correct answers are not shown.</p>
  <div class="complete-stats"><div><strong>${count(1,64)} / 64</strong><span>Timed questions answered</span></div><div><strong>${count(65,74)} / 10</strong><span>Listening questions answered</span></div></div>
  <div class="hint-box" style="margin-top:22px">Exam reference: <strong>${escapeHtml(state.examId)}</strong><br>Instructor grading is completed separately in Google Sheets.</div></div>`;
}
function move(delta){if(!isMain())return;const next=currentId+delta;if(next<1||next>64)return;currentId=next;render();window.scrollTo({top:0,behavior:'smooth'});}
function choosePage(id){if(state.stage!=='MAIN'||id<1||id>64)return;currentId=id;render();window.scrollTo({top:0,behavior:'smooth'});}
function chooseListeningPart(part){
  if(!state||state.stage!=='LISTENING'||(part!==1&&part!==2))return;
  if(playBusy||activeAudio!==null){showToast('The recording must finish before switching Listening pages.');return;}
  currentId=part===1?65:70;render();window.scrollTo({top:0,behavior:'smooth'});
}
function showMainConfirm(){if(!isMain()||busy)return;document.getElementById('confirm-count').textContent=`${count(1,64)} / 64`;
  document.getElementById('confirm-remaining').textContent=mmss(state.deadline-clockMs());confirmDialog.showModal();}
async function lockTimedSection(auto=false){
  if(!state||state.stage!=='MAIN'||busy)return;
  clearTimeout(savingTimer);
  busy=true;mainRetryNeeded=false;
  if(confirmDialog.open)confirmDialog.close();
  // Capture exactly what the student had entered when their time expired (or
  // when they voluntarily submitted). This snapshot is immutable on retries.
  // Persist before requesting the network, so a refresh cannot reopen editing.
  if(!state.pendingMainSeal){
    state.pendingMainSeal={action:'sealMain',token:state.token,revision:state.mainRev,answers:{...state.mainAnswers}};
    persist();
  }
  const p=state.pendingMainSeal;
  app.innerHTML='<div class="loading-panel"><strong>Timed section locked.</strong><p>Sending your final answers, including Writing, to Google Sheets…</p></div>';
  connection('Saving final answers…','gold');
  try{
    // Do not wait for queued autosaves: a slow earlier request must not delay
    // the deadline snapshot past the server's transfer-only grace window.
    await commit(p,s=>(s.stage==='LISTENING'||s.stage==='DONE')&&s.mainRev>=p.revision,4);
    delete state.pendingMainSeal;
    state.serverMainRev=p.revision;
    persist();
    currentId=65;render();
    connection(DEMO?'Preview only':'Connected',DEMO?'gold':'green');
    showToast(auto?'Time is up. Your final timed answers were saved.':'Timed answers submitted and locked. Welcome to Listening.');
  }catch(error){
    mainRetryNeeded=true;
    if(state.stage==='LISTENING'){render();}
    else app.innerHTML='<section class="retry-panel"><h2>Timed section is locked.</h2><p>We could not confirm that the final answers reached Google Sheets. You cannot edit them. Check your connection and retry the saved snapshot. If the 30-second transfer window has expired, contact your instructor.</p><button class="button primary" data-action="retry-main">Retry final save</button></section>';
    throw error;
  }finally{busy=false;}
}
async function finishListening(){
  if(!state||state.stage!=='LISTENING'||busy)return;
  if(activeAudio!==null||playBusy){showToast('Wait for the recording to finish before submitting.');return;}
  const yes=window.confirm(`Submit your final exam?\n\nYou answered ${count(65,74)} of 10 Listening questions. After submission, all answers are locked.`);
  if(!yes)return;
  clearTimeout(savingTimer);busy=true;connection('Submitting…','gold');
  try{
    const p={action:'finish',token:state.token,revision:state.listeningRev,answers:{...state.listeningAnswers}};
    await serialized(()=>commit(p,s=>s.stage==='DONE',4));
    render();connection(DEMO?'Preview only':'Submitted',DEMO?'gold':'green');
  }catch(error){showToast(error.message,6500);connection('Submission not confirmed','red');}
  finally{busy=false;}
}
async function playRecording(which){
  if(!state||state.stage!=='LISTENING'||playBusy||activeAudio!==null)return;
  const field=which===1?'audio1Plays':'audio2Plays';
  if(state[field]>=2){showToast('This audio has reached its two-play limit.');return;}
  playBusy=true;const requestId=token();render();
  try{
    const p={action:'claimPlay',token:state.token,audio:which,requestId};
    await serialized(()=>commit(p,s=>Array.isArray(s.claimIds)&&s.claimIds.includes(requestId),4));
    activeAudio=which;player.src=AUDIO_FILES[which];player.load();
    try{await player.play();}
    catch(err){
      // Some mobile browsers require a second gesture after a network request.
      // The play was already reserved: next tap may start it without using another.
      state.reservedAudio=which;persist();activeAudio=null;
      showToast('Playback reserved. Tap "Start reserved audio" to play it.',6000);
    }
  }catch(error){showToast(error.message,6500);connection('Playback confirmation failed','red');}
  finally{playBusy=false;render();}
}
function playReserved(){
  if(!state.reservedAudio)return;
  const id=state.reservedAudio;
  if(activeAudio!==null)return;
  activeAudio=id;player.src=AUDIO_FILES[id];player.load();
  player.play().then(()=>{delete state.reservedAudio;persist();render();}).catch(()=>{activeAudio=null;showToast('Please press the playback button again.');render();});
}
function setupListeners(){
  app.addEventListener('input',e=>{
    const element=e.target;if(!element.dataset.answer)return;
    const id=Number(element.dataset.answer);
    if(element.dataset.blankIndex!==undefined){
      const total=Number(element.dataset.blankTotal),parts=blankValues(state.mainAnswers[id],total);
      parts[Number(element.dataset.blankIndex)]=element.value.trim();
      setAnswer(id,parts.join(' | '));
    }else if(element.type==='text'||element.tagName==='TEXTAREA')setAnswer(id,element.value);
    if(id===64){const n=document.querySelector('#word-count');if(n){const words=element.value.trim()?element.value.trim().split(/\s+/).length:0;n.textContent=words+' words';n.className=words>=50&&words<=80?'good':'warn';}}
  });
  app.addEventListener('change',e=>{
    const el=e.target;if(!el.dataset.answer)return;
    if(el.tagName==='SELECT'||el.type==='radio'){
      setAnswer(Number(el.dataset.answer),el.value);
      if(el.type==='radio'){
        el.closest('.question-card').querySelectorAll('.option').forEach(x=>x.classList.toggle('selected',x.contains(el)&&el.checked));
      }
    }
  });
  app.addEventListener('click',e=>{
    const page=e.target.closest('[data-jump]');if(page){choosePage(Number(page.dataset.jump));return;}
    const section=e.target.closest('[data-listening-part]');if(section){chooseListeningPart(Number(section.dataset.listeningPart));return;}
    const control=e.target.closest('[data-action]');if(!control)return;
    const action=control.dataset.action;
    if(action==='next')move(1);else if(action==='prev')move(-1);
    else if(action==='flag'){flags.has(currentId)?flags.delete(currentId):flags.add(currentId);render();}
    else if(action==='confirm-main')showMainConfirm();
    else if(action==='confirm-listening')finishListening();
    else if(action==='retry-main'){mainRetryNeeded=false;lockTimedSection(true).catch(()=>{});}
    else if(action==='listening-next')chooseListeningPart(2);
    else if(action==='listening-prev')chooseListeningPart(1);
    else if(action==='play-1'||action==='play-2'){
      if(state.reservedAudio===Number(action.slice(-1)))playReserved();
      else playRecording(Number(action.slice(-1)));
    }
  });
  document.getElementById('cancel-confirm').addEventListener('click',()=>confirmDialog.close());
  document.getElementById('yes-confirm').addEventListener('click',()=>lockTimedSection(false).catch(()=>{}));
  player.addEventListener('timeupdate',()=>{
    if(activeAudio===null||!player.duration)return;
    const n=document.getElementById('audio-progress-'+activeAudio);
    if(n)n.style.width=(100*player.currentTime/player.duration)+'%';
  });
  player.addEventListener('ended',()=>{activeAudio=null;player.removeAttribute('src');player.load();render();});
  player.addEventListener('pause',()=>{
    if(activeAudio!==null&&!player.ended){
      // Browser/system interruption consumes this play. Never resume it.
      activeAudio=null;player.removeAttribute('src');player.load();render();
      showToast('Playback was interrupted. That play has been used.');
    }
  });
  window.addEventListener('pagehide',()=>{persist();});
  timerJob=setInterval(advanceWindow,250);
  // If page was left open while another tab finished/locked, sync with server.
  setInterval(()=>{if(state&&!DEMO&&state.stage!=='DONE'&&!busy)readRemote().catch(()=>{});},45000);
  setInterval(()=>{if(state&&!busy&&state.stage!=='DONE'&&!syncing){
    const t=state.stage==='MAIN'?'mainRev':'listeningRev';
    if(state[t]>0)saveAnswers().catch(()=>{});
  }},30000);
}
async function init(){
  setupListeners();
  if(DEMO){document.getElementById('preview-banner').hidden=false;connection('Not connected','red');}
  else connection('Connecting…');
  try{const res=await fetch('questions.json',{cache:'no-store'});if(!res.ok)throw new Error('questions.json could not be loaded');examData=await res.json();
    if(examData.questions.length!==74)throw new Error('Expected 74 questions');
  }catch(e){app.innerHTML=`<section class="retry-panel"><h2>Could not load exam</h2><p>${escapeHtml(e.message)}. Open this folder through a local web server or GitHub Pages, not a file:// URL.</p></section>`;return;}
  if(DEMO&&!PREVIEW_REQUESTED){
    app.innerHTML=`<section class="retry-panel"><div class="eyebrow">Setup required</div><h2>Google Sheets is not connected</h2><p>The Apps Script URL is missing in <code>config.js</code>. This exam cannot start until your instructor connects Google Sheets. To try an offline preview intentionally, add <code>?preview=1</code> to the page URL.</p></section>`;
    return;
  }
  if(DEMO)connection('Preview only','gold');
  const cached=remembered();
  if(cached&&cached.token){
    state=cached;
    if(!DEMO){
      try{const remote=await jsonp('state',{token:cached.token});useServer(remote.state,{initial:true});connection('Connected','green');}
      catch(e){
        // Do not start a new session or unlock anything if the server is unavailable.
        connection('Connection issue','red');
        app.innerHTML=`<section class="retry-panel"><h2>Unable to restore session</h2><p>${escapeHtml(e.message)}. Your local responses remain here. Refresh after reconnecting.</p><button type="button" class="button primary" onclick="location.reload()">Retry connection</button></section>`;
        return;
      }
    }
    currentId=state.stage==='MAIN'?1:65;render();
    if(!DEMO&&state.stage==='MAIN'&&state.mainRev>0&&state.mainRev>Number(cached.serverMainRev||0)&&clockMs()<state.deadline)saveAnswers().catch(()=>{});
  }else{state=null;entry();if(!DEMO){jsonp('ping').then(()=>connection('Connected','green')).catch(()=>connection('Connection issue','red'));}}
}
init();
})();
