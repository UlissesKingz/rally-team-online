(() => {
  const socket = io();
  const app = document.querySelector('#app');
  const DISCORD_URL = 'https://discord.gg/EJCHTwQjDz';
  const COLORS = ['blue','red','green','yellow'];
  const COLOR_LABELS = { blue:'Azul', red:'Vermelha', green:'Verde', yellow:'Amarela' };
  const ROLE_LABELS = { pilot:'Piloto', copilot:'Copiloto' };
  const layout = localStorage.getItem('rallyTeamLayout') || (matchMedia('(max-width:720px)').matches ? 'mobile' : 'desktop');
  document.body.dataset.layout = layout;

  let state = null;
  let identity = loadIdentity();
  let entryMode = identity.mode === 'smartphone' ? 'smartphone' : 'online';
  let notice = '';
  let localOps = [];
  const PEN_WIDTH = 0.006;
  const ERASER_WIDTH = PEN_WIDTH * 5;
  let tool = 'draw';
  let drawing = false;
  let lastPoint = null;
  let raceTimer = null;
  let countdownTimer = null;
  let lastSentAt = 0;
  let pendingSegment = null;
  let exitConfirm = false;
  let finishSending = false;
  let finishSendTimer = null;
  let scanAnalysis = null;
  let scanSourceImage = null;
  let manualMarkerMode = false;
  let manualMarkerPoints = [];
  let scanWorkSize = null;
  let startGamePending = false;
  let restartGamePending = false;

  function loadIdentity() {
    try { return JSON.parse(sessionStorage.getItem('rallyTeamIdentity') || 'null') || {}; } catch { return {}; }
  }
  function saveIdentity(extra={}) {
    identity = { ...identity, ...extra };
    sessionStorage.setItem('rallyTeamIdentity', JSON.stringify(identity));
  }
  function clearIdentity() {
    identity = {};
    sessionStorage.removeItem('rallyTeamIdentity');
  }
  function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    const total=Math.max(0,Math.floor(ms));
    const min=Math.floor(total/60000), sec=Math.floor((total%60000)/1000), cs=Math.floor((total%1000)/10);
    return `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
  }
  function myPlayer() { return state?.players?.find(p => p.id === identity.playerId) || null; }
  function myTeam() { const p=myPlayer(); return p?.color ? state?.teams?.[p.color] : null; }
  function button(text, cls='secondary-button', attrs='') { return `<button class="${cls}" ${attrs}>${text}</button>`; }
  function brand() { return `<div class="brand-lockup"><span class="brand-mark">RT</span><div><strong>Rally Team</strong><small>Online</small></div></div>`; }
  function topLinks(includeExit=false, exitLabel='Sair') {
    return `<div class="top-actions"><a class="top-action" href="/manual.html" target="_blank">Manual</a><a class="top-action" href="${DISCORD_URL}" target="_blank" rel="noopener">Discord</a>${includeExit?`<button id="exitRoom" class="top-action danger-link">${exitLabel}</button>`:''}</div>`;
  }
  function startingOverlayMarkup(restarting=false) {
    return `<div class="start-loading-overlay" role="status" aria-live="polite"><div class="start-loading-card"><div class="rally-spinner" aria-hidden="true"></div><strong>${restarting?'Gerando nova pista…':'Gerando a pista…'}</strong><p>${restarting?'A próxima etapa já está sendo preparada. Aguarde alguns instantes.':'A partida já foi iniciada. Aguarde alguns instantes enquanto o percurso é preparado.'}</p><button type="button" id="loadingExit" class="secondary-button loading-exit">Sair da sala</button></div></div>`;
  }
  function requestStartGame() {
    if (startGamePending) return;
    startGamePending = true;
    render();
    socket.emit('startGame', {}, res => {
      if (!res?.ok) {
        startGamePending = false;
        notice = res?.error || 'Não foi possível iniciar a partida.';
        render();
        return;
      }
      notice = '';
    });
  }
  function requestRestartGame() {
    if (restartGamePending) return;
    restartGamePending = true;
    render();
    socket.emit('restartGame', {}, res => {
      if (!res?.ok) {
        restartGamePending = false;
        notice = res?.error || 'Não foi possível reiniciar a partida.';
        render();
        return;
      }
      notice = '';
    });
  }
  function bindLoadingExit() {
    const btn=document.querySelector('#loadingExit');
    if(btn) btn.onclick=()=>leaveRoom();
  }
  function setNotice(msg='') { notice=msg; render(); }
  function emitAck(event, payload, onOk) {
    socket.emit(event, payload, res => {
      if (!res?.ok) { notice = res?.error || 'Não foi possível concluir a ação.'; render(); return; }
      notice=''; if (onOk) onOk(res);
    });
  }

  function entryView() {
    const smartphone=entryMode==='smartphone';
    app.innerHTML = `<main class="entry-shell"><header class="entry-top">${brand()}${topLinks(false)}</header><section class="entry-card">
      <p class="eyebrow">Comunicação · precisão · velocidade</p><h1>${smartphone?'Piloto no papel. Copiloto no celular.':'Pilote sem ver a pista.'}</h1><p class="lead">${smartphone?'No modo Smartphone, somente os Copilotos entram na sala. O Piloto desenha na folha física A5 e a câmera faz a correção pelo acetato virtual.':'Forme uma dupla com Piloto e Copiloto. O navegador vê o percurso; o piloto recebe apenas a folha.'}</p>
      <div class="mode-switch"><button type="button" data-entry-mode="online" class="${!smartphone?'active':''}">Jogar Online</button><button type="button" data-entry-mode="smartphone" class="${smartphone?'active':''}">Smartphone</button></div>
      ${notice?`<div class="notice error">${esc(notice)}</div>`:''}
      <label>Seu nome<input id="playerName" maxlength="24" value="${esc(identity.name||'')}" placeholder="Nome"></label>
      <fieldset><legend>Dificuldade da nova sala</legend><div class="difficulty-switch"><label><input type="radio" name="difficulty" value="easy" ${identity.difficulty!=='hard'?'checked':''}><span>Fácil</span></label><label><input type="radio" name="difficulty" value="hard" ${identity.difficulty==='hard'?'checked':''}><span>Difícil</span></label></div></fieldset>
      <button id="createRoom" class="primary-button wide">Criar sala ${smartphone?'Smartphone':''}</button>
      <div class="divider"><span>ou entre em uma sala ${smartphone?'Smartphone':''}</span></div>
      <div class="join-row"><input id="roomCode" maxlength="4" autocomplete="off" placeholder="CÓDIGO"><button id="joinRoom" class="secondary-button">Entrar</button></div>
      <p class="helper">${smartphone?'A sala aceita de 1 a 4 Copilotos. Cada um joga ao lado de um Piloto com uma folha física.':'A dificuldade de uma sala existente é definida pelo anfitrião.'}</p>
      ${smartphone?'<a class="sheet-download" href="/rally-team-folha-smartphone-a5.pdf" target="_blank">Baixar folha A5 para impressão</a>':''}
      <a class="small-link" href="/device.html">Trocar versão</a>
    </section><footer>Rally Team · protótipo online</footer></main>`;
    document.querySelectorAll('[data-entry-mode]').forEach(btn=>btn.onclick=()=>{entryMode=btn.dataset.entryMode;saveIdentity({mode:entryMode});notice='';render();});
    const name=()=>document.querySelector('#playerName').value.trim();
    document.querySelector('#createRoom').onclick=()=>{
      const difficulty=document.querySelector('input[name="difficulty"]:checked').value;
      emitAck('createRoom',{name:name(),difficulty,mode:entryMode},res=>{saveIdentity({name:name(),difficulty,mode:res.mode||entryMode,roomCode:res.code,playerId:res.playerId,token:res.token});});
    };
    document.querySelector('#joinRoom').onclick=()=>{
      const code=document.querySelector('#roomCode').value.trim().toUpperCase();
      emitAck('joinRoom',{name:name(),code,mode:entryMode},res=>{entryMode=res.mode||entryMode;saveIdentity({name:name(),mode:entryMode,roomCode:res.code,playerId:res.playerId,token:res.token});});
    };
    document.querySelector('#roomCode').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));
  }

  function playerSlot(color, role) {
    const slot=state.teams[color][role];
    const me=myPlayer();
    const mine=slot?.id===me?.id;
    return `<button class="team-slot ${mine?'mine':''} ${slot?'occupied':''}" data-color="${color}" data-role="${role}" ${slot&&!mine?'disabled':''}>
      <span>${ROLE_LABELS[role]}</span><strong>${slot?esc(slot.name):'Escolher'}</strong>${slot&&!slot.connected?'<em>desconectado</em>':''}
    </button>`;
  }
  function smartphoneLobbyView() {
    const me=myPlayer();
    app.innerHTML=`<main class="lobby-shell"><header class="game-topbar">${brand()}<div class="room-pill">Sala <strong>${esc(state.code)}</strong></div>${topLinks(true,'Retornar')}</header>
      <section class="lobby-card"><div class="lobby-head"><div><p class="eyebrow">Lobby Smartphone · ${state.difficulty==='hard'?'Difícil':'Fácil'}</p><h1>Aguardando os Copilotos</h1><p>Cada pessoa conectada representa uma dupla física: Copiloto no smartphone e Piloto com papel e caneta.</p></div><div class="room-code-big"><small>Código</small><strong>${esc(state.code)}</strong><button id="copyCode">Copiar</button></div></div>
      ${notice?`<div class="notice error">${esc(notice)}</div>`:''}
      <div class="smartphone-players">${state.players.map((p,i)=>`<article class="smartphone-player team-${p.color}"><span class="team-dot"></span><div><small>Dupla ${i+1}</small><strong>${esc(p.name)}</strong></div><span class="smartphone-role">Copiloto · Equipe ${COLOR_LABELS[p.color]}</span>${!p.connected?'<em>desconectado</em>':''}</article>`).join('')}</div>
      <div class="lobby-bottom"><div><strong>${state.players.length}</strong>/4 Copiloto${state.players.length===1?'':'s'} na sala</div>${me?.id===state.hostId?`<button id="startGame" class="primary-button" ${(state.canStart&&!startGamePending)?'':'disabled'}>${startGamePending?'Gerando pista…':'Iniciar partida'}</button>`:`<span class="waiting-host">${state.status==='starting'?'O anfitrião já iniciou. Aguarde…':'Aguardando o anfitrião iniciar'}</span>`}</div>
      <p class="helper center">O anfitrião inicia quando todos os Copilotos desejados tiverem entrado. É possível jogar com 1, 2, 3 ou 4 duplas.</p><a class="sheet-download" href="/rally-team-folha-smartphone-a5.pdf" target="_blank">Abrir folha A5 para impressão</a>
      </section>${(state.status==='starting'||startGamePending)?startingOverlayMarkup():''}</main>`;
    document.querySelector('#copyCode').onclick=async()=>{try{await navigator.clipboard.writeText(state.code);document.querySelector('#copyCode').textContent='Copiado!';setTimeout(()=>{const b=document.querySelector('#copyCode');if(b)b.textContent='Copiar';},1200);}catch{}};
    const st=document.querySelector('#startGame'); if(st) st.onclick=()=>requestStartGame();
    bindLoadingExit();
    bindExit();
  }
  function lobbyView() {
    if(state.mode==='smartphone'){smartphoneLobbyView();return;}
    const me=myPlayer();
    const complete = COLORS.filter(c=>state.teams[c].pilot&&state.teams[c].copilot).length;
    app.innerHTML=`<main class="lobby-shell"><header class="game-topbar">${brand()}<div class="room-pill">Sala <strong>${esc(state.code)}</strong></div>${topLinks(true,'Retornar')}</header>
      <section class="lobby-card"><div class="lobby-head"><div><p class="eyebrow">Lobby · ${state.difficulty==='hard'?'Difícil':'Fácil'}</p><h1>Monte as duplas</h1><p>Escolham a mesma cor, com um Piloto e um Copiloto.</p></div><div class="room-code-big"><small>Código</small><strong>${esc(state.code)}</strong><button id="copyCode">Copiar</button></div></div>
      ${notice?`<div class="notice error">${esc(notice)}</div>`:''}
      <div class="teams-grid">${COLORS.map(color=>`<article class="team-card team-${color}"><div class="team-title"><span class="team-dot"></span><strong>Equipe ${COLOR_LABELS[color]}</strong>${state.teams[color].pilot&&state.teams[color].copilot?'<span class="complete-badge">Dupla pronta</span>':''}</div><div class="slots">${playerSlot(color,'pilot')}${playerSlot(color,'copilot')}</div></article>`).join('')}</div>
      <div class="lobby-bottom"><div><strong>${complete}</strong> dupla${complete===1?'':'s'} completa${complete===1?'':'s'} · ${state.players.length}/8 jogadores</div>${me?.id===state.hostId?`<button id="startGame" class="primary-button" ${(state.canStart&&!startGamePending)?'':'disabled'}>${startGamePending?'Gerando pista…':'Iniciar partida'}</button>`:`<span class="waiting-host">${state.status==='starting'?'O anfitrião já iniciou. Aguarde…':'Aguardando o anfitrião iniciar'}</span>`}</div>
      ${!state.canStart&&me?.id===state.hostId&&!startGamePending?'<p class="helper center">O botão libera quando houver pelo menos uma dupla e todos os jogadores estiverem em duplas completas.</p>':''}
      </section>${(state.status==='starting'||startGamePending)?startingOverlayMarkup():''}</main>`;
    document.querySelectorAll('.team-slot').forEach(btn=>btn.onclick=()=>emitAck('setTeam',{color:btn.dataset.color,role:btn.dataset.role}));
    document.querySelector('#copyCode').onclick=async()=>{try{await navigator.clipboard.writeText(state.code);document.querySelector('#copyCode').textContent='Copiado!';setTimeout(()=>{const b=document.querySelector('#copyCode');if(b)b.textContent='Copiar';},1200);}catch{}};
    const st=document.querySelector('#startGame'); if(st) st.onclick=()=>requestStartGame();
    bindLoadingExit();
    bindExit();
  }

  function chipsHtml() {
    const me=myPlayer(), team=myTeam();
    const nextIndex=state.chips.findIndex(owner=>!owner);
    return `<div class="chips-row">${state.chips.map((owner,i)=>{
      const claimable=state.status==='racing' && me?.role==='copilot' && !team?.finishedAt && !owner && i===nextIndex;
      const title=owner
        ? `Ficha ${i+1} — Equipe ${COLOR_LABELS[owner]}`
        : claimable
          ? 'Copiloto: clique quando considerar que o desenho chegou corretamente à próxima linha.'
          : `Ficha ${i+1}${i>nextIndex&&nextIndex>=0?' — aguarde a ficha anterior':''}`;
      return `<button type="button" class="bonus-chip ${owner?`claimed chip-${owner}`:''} ${claimable?'claimable':''}" data-chip="${i}" ${claimable?'':'disabled'} title="${esc(title)}"><strong>+5</strong><span>${i+1}</span></button>`;
    }).join('')}</div>`;
  }
  function raceHeader() {
    const me=myPlayer();
    const roleLabel=state.mode==='smartphone'?'Smartphone · Copiloto':ROLE_LABELS[me.role];
    return `<header class="game-topbar">${brand()}<div class="race-meta"><span>Sala <strong>${esc(state.code)}</strong></span><span>${state.difficulty==='hard'?'Difícil':'Fácil'}</span><span class="team-name team-text-${me.color}">Equipe ${COLOR_LABELS[me.color]}</span><span>${roleLabel}</span></div>${topLinks(true)}</header>`;
  }
  function paperMarkup(idPrefix, interactive=false) {
    return `<div class="paper-wrap ${interactive?'interactive':''}"><div class="paper-tools-slot"></div><div class="a5-paper"><canvas class="paper-base" id="${idPrefix}Base" width="740" height="1050"></canvas><canvas class="draw-layer" id="${idPrefix}Draw" width="740" height="1050"></canvas>${interactive?'<div id="pointerDot" class="pointer-dot"></div>':''}</div></div>`;
  }
  function trackCardMarkup() {
    return `<aside class="track-panel"><div class="track-panel-head"><div><small>Carta do Copiloto</small><strong>Pista da etapa</strong></div><span class="clockwise">↻ Horário</span></div><div class="track-card"><canvas id="trackCanvas" width="740" height="1050"></canvas></div><div class="start-readout">Início <strong>${esc(state.track?.startLabel||'')}</strong></div></aside>`;
  }
  function smartphoneRaceView() {
    const me=myPlayer(), team=myTeam();
    const prep=state.status==='prep', countdown=state.status==='countdown', racing=state.status==='racing';
    const finished=!!team?.finishedAt;
    if(racing&&finished&&!team?.scanSubmitted){smartphoneScanView();return;}
    const ready=!!me.ready;
    const sideNames={top:'linha vertical superior',right:'linha horizontal direita',bottom:'linha vertical inferior',left:'linha horizontal esquerda'};
    const start=team?.smartphoneStart||{side:state.track?.startSide,label:state.track?.startLabel};
    const raceClockValue=finished?fmtMs(team.elapsedMs):(racing?fmtMs(Date.now()-state.startedAt):'00:00.00');
    app.innerHTML=`<main class="game-shell smartphone-game">${raceHeader()}<section class="race-status"><div>${chipsHtml()}${racing&&!finished?'<p class="chip-guidance">Quando considerar que o Piloto chegou corretamente à próxima referência do percurso, pegue a ficha disponível.</p>':''}</div><div class="timer-card"><small>Tempo</small><strong id="raceClock">${raceClockValue}</strong></div></section>
      ${notice?`<div class="notice error compact">${esc(notice)}</div>`:''}
      <section class="smartphone-stage"><div class="stage-head"><div><p class="eyebrow">Modo Smartphone · Copiloto</p><h2>${racing?'Navegue o Piloto':'Prepare a etapa'}</h2></div><div class="live-badge">Piloto no papel físico</div></div>
        <div class="smartphone-track-wrap"><div class="smartphone-track-card">${trackCardMarkup()}</div><div class="smartphone-instructions"><strong>Seu ponto de largada</strong><span>${esc(sideNames[start?.side]||'ponto indicado')}</span><b>${esc(start?.label||state.track?.startLabel||'')}</b><p>O Piloto inicia exatamente nesse ponto da cruz central da folha e percorre a pista no sentido horário.</p></div></div>
      </section>
      <section class="ready-zone">${prep?`<button type="button" id="readyBtn" class="${ready?'secondary-button ready-active':'primary-button'}">${ready?'Pronto ✓':'Estou pronto'}</button><span>${ready?'Você está pronto. Aguardando os demais Copilotos.':'Confira a folha do Piloto e sua largada antes de confirmar.'}</span>`:''}${countdown?'<span class="waiting-race">Prepare-se para a largada.</span>':''}${racing&&!finished?`<button type="button" id="finishTeamBtn" class="primary-button finish-team-button">Concluímos</button><small>Ao concluir, seu tempo para e a câmera será aberta para corrigir a folha física.</small>`:''}${finished&&team?.scanSubmitted?`<div class="finish-banner">FOLHA ENVIADA · ${fmtMs(team.elapsedMs)} <small>Aguardando as demais duplas fotografarem suas folhas.</small></div>`:''}</section>
      ${countdown?'<div id="countdownOverlay" class="countdown-overlay"><div><small>LARGADA EM</small><strong id="countdownNumber">10</strong></div></div>':''}
    </main>`;
    if(state.track?.points)drawTrack('trackCanvas',state.track);
    document.querySelectorAll('.bonus-chip.claimable').forEach(btn=>btn.onclick=()=>emitAck('claimChip',{index:Number(btn.dataset.chip)}));
    const readyBtn=document.querySelector('#readyBtn');if(readyBtn)readyBtn.onclick=()=>emitAck('setReady',{ready:!ready});
    const finishBtn=document.querySelector('#finishTeamBtn');
    if(finishBtn)finishBtn.onclick=()=>{
      if(finishSending)return;
      finishSending=true;finishBtn.textContent='Encerrando…';finishBtn.setAttribute('aria-busy','true');
      socket.emit('finishTeam',{},res=>{
        finishSending=false;
        if(!res?.ok){notice=res?.error||'Não foi possível concluir.';render();return;}
        notice='';if(res.state){state=res.state;render();}
      });
    };
    bindExit();startTimers();
  }

  function prepRaceView() {
    if(state.mode==='smartphone'){smartphoneRaceView();return;}
    const me=myPlayer(), team=myTeam();
    const isPilot=me.role==='pilot';
    const finished=!!team?.finishedAt;
    const racing=state.status==='racing';
    const prep=state.status==='prep';
    const countdown=state.status==='countdown';
    const ready=!!me.ready;
    const myConfirmed = me.role==='pilot' ? !!team?.pilotConfirmed : !!team?.copilotConfirmed;
    const mateConfirmed = me.role==='pilot' ? !!team?.copilotConfirmed : !!team?.pilotConfirmed;
    const mateRoleLabel = me.role==='pilot' ? 'Copiloto' : 'Piloto';
    const roleMain = isPilot
      ? `<section class="pilot-stage"><div class="stage-head"><div><p class="eyebrow">Piloto</p><h2>${racing?'Desenhe o percurso':'Prepare a folha'}</h2></div>${racing&&!finished?`<div class="draw-tools"><button data-tool="draw" class="tool-btn ${tool==='draw'?'active':''}">✎ Desenhar</button><button data-tool="erase" class="tool-btn ${tool==='erase'?'active':''}">⌫ Borracha</button></div>`:''}</div>${paperMarkup('pilot',true)}<p class="paper-caption">Início: <strong>${esc(state.track?.startLabel||'')}</strong> · percurso no sentido horário.</p></section>`
      : `<section class="copilot-stage"><div class="stage-head"><div><p class="eyebrow">Copiloto</p><h2>Acompanhe e navegue</h2></div><div class="live-badge">● desenho ao vivo</div></div><div class="copilot-layout">${paperMarkup('copilot',false)}${trackCardMarkup()}</div></section>`;
    const raceClockValue=finished?fmtMs(team.finishedAt-state.startedAt):(racing?fmtMs(Date.now()-state.startedAt):'00:00.00');
    app.innerHTML=`<main class="game-shell">${raceHeader()}<section class="race-status"><div>${chipsHtml()}${racing&&me.role==='copilot'&&!finished?'<p class="chip-guidance">Quando considerar que o traço chegou corretamente à próxima linha, pegue a ficha disponível.</p>':''}</div><div class="timer-card"><small>Tempo</small><strong id="raceClock">${raceClockValue}</strong></div></section>
      ${notice?`<div class="notice error compact">${esc(notice)}</div>`:''}
      ${roleMain}
      <section class="ready-zone">${prep?`<button type="button" id="readyBtn" class="${ready?'secondary-button ready-active':'primary-button'}">${ready?'Pronto ✓':'Estou pronto'}</button><span>${team?.pilot?.ready&&team?.copilot?.ready?'Sua dupla está pronta.':'Piloto e Copiloto precisam confirmar.'}</span>`:''}${countdown?'<span class="waiting-race">Prepare-se para a largada.</span>':''}${racing&&!finished?`<button type="button" id="finishTeamBtn" class="${myConfirmed?'secondary-button':'primary-button'} finish-team-button" ${myConfirmed?'disabled aria-disabled="true"':''}>${myConfirmed?'Você confirmou ✓':'Concluímos'}</button><div class="finish-status"><span>Piloto: <strong>${team?.pilotConfirmed?'confirmou ✓':'aguardando'}</strong></span><span>Copiloto: <strong>${team?.copilotConfirmed?'confirmou ✓':'aguardando'}</strong></span><small>${myConfirmed?`Aguardando ${mateRoleLabel} confirmar.`:mateConfirmed?`${mateRoleLabel} já confirmou. Você pode concluir agora, mesmo com o desenho incompleto ou vazio.`:'A conclusão não depende do desenho. Piloto e Copiloto apenas confirmam quando quiserem encerrar.'}</small></div>`:''}${finished?`<div class="finish-banner">CONCLUÍDO · ${fmtMs(team.finishedAt-state.startedAt)} <small>Desenho bloqueado. Aguardando as demais duplas concluírem.</small></div>`:''}</section>
      ${countdown?'<div id="countdownOverlay" class="countdown-overlay"><div><small>LARGADA EM</small><strong id="countdownNumber">10</strong></div></div>':''}
    </main>`;
    const ownOps=state.drawings?.[me.color] || [];
    localOps = ownOps.slice();
    drawBase(isPilot?'pilotBase':'copilotBase', state.track?.start, state.track?.startLabel);
    renderOps(isPilot?'pilotDraw':'copilotDraw', localOps);
    if(!isPilot && state.track?.points) drawTrack('trackCanvas', state.track);
    if(isPilot && racing && !finished) bindDrawing('pilotDraw');
    document.querySelectorAll('.tool-btn').forEach(btn=>btn.onclick=()=>selectTool(btn.dataset.tool));
    document.querySelectorAll('.bonus-chip.claimable').forEach(btn=>btn.onclick=()=>emitAck('claimChip',{index:Number(btn.dataset.chip)}));
    const readyBtn=document.querySelector('#readyBtn'); if(readyBtn) readyBtn.onclick=()=>emitAck('setReady',{ready:!ready});
    const finishBtn=document.querySelector('#finishTeamBtn');
    if(finishBtn && !myConfirmed) {
      finishBtn.onclick=()=>{
        if (finishSending) return;
        finishSending = true;
        finishBtn.textContent = 'Confirmando…';
        finishBtn.setAttribute('aria-busy','true');

        // Não desabilitamos o botão antes da resposta do servidor. Isso evita
        // que uma confirmação perdida por conexão deixe a interface travada.
        clearTimeout(finishSendTimer);
        finishSendTimer = setTimeout(()=>{
          finishSending = false;
          const current=document.querySelector('#finishTeamBtn');
          if(current && !current.disabled){
            current.textContent='Concluímos';
            current.removeAttribute('aria-busy');
          }
        },4000);

        socket.emit('finishTeam', {}, res => {
          clearTimeout(finishSendTimer);
          finishSendTimer = null;
          finishSending = false;
          if (!res?.ok) {
            notice = res?.error || 'Não foi possível confirmar a conclusão.';
            render();
            return;
          }
          notice='';
          // O ACK traz o estado autoritativo. No segundo clique da última dupla
          // ele já vem com status=finished e a pontuação pronta.
          if (res.state) {
            state = res.state;
            render();
          }
        });
      };
    }
    bindExit();
    startTimers();
  }

  function smartphoneScanView() {
    const team=myTeam();
    app.innerHTML=`<main class="game-shell scan-game">${raceHeader()}<section class="scan-stage"><div class="scan-head"><div><p class="eyebrow">Etapa concluída · ${fmtMs(team?.elapsedMs)}</p><h2>Fotografe a folha do Piloto</h2><p>Enquadre os quatro marcadores pretos. O sistema corrige a perspectiva para A5 e lê somente o traço da caneta.</p></div></div>
      ${notice?`<div class="notice error compact">${esc(notice)}</div>`:''}
      <div class="scan-grid"><div class="scan-capture"><label class="primary-button camera-button" for="physicalPhoto">Abrir câmera / escolher foto</label><input id="physicalPhoto" type="file" accept="image/*" capture="environment" hidden><p class="helper">Prefira caneta preta ou azul-escura e fotografe a folha inteira, com os quatro marcadores visíveis.</p><canvas id="scanSourceCanvas" class="scan-source" width="480" height="680"></canvas><div class="scan-marker-status" id="scanMarkerStatus">Aguardando fotografia.</div><button id="manualMarkersBtn" class="secondary-button" type="button" disabled>Ajustar marcadores manualmente</button></div>
      <div class="scan-preview"><h3>Leitura normalizada</h3><div class="scan-paper"><img id="scanPreview" alt="Traço detectado na folha A5"></div><p id="scanSummary" class="helper">Depois da foto, o desenho detectado aparecerá aqui.</p><button id="submitScanBtn" class="primary-button wide" type="button" ${scanAnalysis?'':'disabled'}>Enviar para correção</button></div></div>
      <div class="ready-zone"><small>Seu tempo já está parado. A pontuação aparece quando todas as duplas enviarem suas folhas.</small></div></section></main>`;
    if(scanSourceImage)drawSourceImageToCanvas(scanSourceImage,manualMarkerPoints);
    if(scanAnalysis){
      const img=document.querySelector('#scanPreview');if(img)img.src=scanAnalysis.scanImage;
      const summary=document.querySelector('#scanSummary');if(summary)summary.textContent=`${scanAnalysis.cells.length} células com traço detectado na folha.`;
      const submit=document.querySelector('#submitScanBtn');if(submit)submit.disabled=false;
      const status=document.querySelector('#scanMarkerStatus');if(status)status.textContent='Folha reconhecida e alinhada.';
    }
    const input=document.querySelector('#physicalPhoto');
    input.onchange=async()=>{
      const file=input.files?.[0];if(!file)return;
      scanAnalysis=null;manualMarkerMode=false;manualMarkerPoints=[];
      const status=document.querySelector('#scanMarkerStatus');status.textContent='Analisando marcadores e corrigindo perspectiva…';
      try{
        const loaded=await loadImageFile(file);scanSourceImage=loaded;
        drawSourceImageToCanvas(loaded,[]);
        document.querySelector('#manualMarkersBtn').disabled=false;
        scanAnalysis=await analyzePhysicalSheet(loaded,null,state.difficulty);
        document.querySelector('#scanPreview').src=scanAnalysis.scanImage;
        document.querySelector('#scanSummary').textContent=`${scanAnalysis.cells.length} células com traço detectado. Confira visualmente antes de enviar.`;
        status.textContent='✓ Quatro marcadores detectados automaticamente.';
        document.querySelector('#submitScanBtn').disabled=false;
        drawSourceImageToCanvas(loaded,scanAnalysis.sourceMarkers);
      }catch(err){
        status.textContent=`Não consegui localizar os quatro marcadores automaticamente. ${err.message||''} Use o ajuste manual.`;
        document.querySelector('#submitScanBtn').disabled=true;
      }
    };
    document.querySelector('#manualMarkersBtn').onclick=()=>{
      if(!scanSourceImage)return;
      manualMarkerMode=true;manualMarkerPoints=[];scanAnalysis=null;
      drawSourceImageToCanvas(scanSourceImage,[]);
      document.querySelector('#scanMarkerStatus').textContent='Toque nos marcadores nesta ordem: superior esquerdo → superior direito → inferior direito → inferior esquerdo.';
      document.querySelector('#submitScanBtn').disabled=true;
    };
    const sourceCanvas=document.querySelector('#scanSourceCanvas');
    sourceCanvas.onclick=async e=>{
      if(!manualMarkerMode||!scanSourceImage)return;
      const r=sourceCanvas.getBoundingClientRect();
      manualMarkerPoints.push({x:(e.clientX-r.left)/r.width*sourceCanvas.width,y:(e.clientY-r.top)/r.height*sourceCanvas.height});
      drawSourceImageToCanvas(scanSourceImage,manualMarkerPoints);
      const names=['superior direito','inferior direito','inferior esquerdo'];
      if(manualMarkerPoints.length<4){document.querySelector('#scanMarkerStatus').textContent=`Marcador registrado. Agora toque no ${names[manualMarkerPoints.length-1]}.`;return;}
      manualMarkerMode=false;
      try{
        scanAnalysis=await analyzePhysicalSheet(scanSourceImage,manualMarkerPoints,state.difficulty,true);
        document.querySelector('#scanPreview').src=scanAnalysis.scanImage;
        document.querySelector('#scanSummary').textContent=`${scanAnalysis.cells.length} células com traço detectado. Marcadores ajustados manualmente.`;
        document.querySelector('#scanMarkerStatus').textContent='✓ Perspectiva corrigida pelos quatro pontos informados.';
        document.querySelector('#submitScanBtn').disabled=false;
      }catch(err){document.querySelector('#scanMarkerStatus').textContent='Não foi possível processar esses quatro pontos. Tente novamente.';}
    };
    document.querySelector('#submitScanBtn').onclick=()=>{
      if(!scanAnalysis)return;
      const btn=document.querySelector('#submitScanBtn');btn.disabled=true;btn.textContent='Enviando…';
      socket.emit('submitSmartphoneScan',{cells:scanAnalysis.cells,scanImage:scanAnalysis.scanImage},res=>{
        if(!res?.ok){notice=res?.error||'Não foi possível enviar a folha.';btn.disabled=false;btn.textContent='Enviar para correção';render();return;}
        notice='';scanAnalysis=null;scanSourceImage=null;manualMarkerPoints=[];
        if(res.state){state=res.state;render();}
      });
    };
    bindExit();
  }

  function resultView() {
    const me=myPlayer();
    const ranking=state.results?.ranking || [];
    const gridLabel=state.difficulty==='hard'?'384 células (96 por quadrante)':'96 células (24 por quadrante)';
    app.innerHTML=`<main class="result-shell">${raceHeader()}<section class="result-card"><p class="eyebrow">Resultado da etapa</p><h1>${ranking[0]?`Equipe ${COLOR_LABELS[ranking[0].color]} vence!`:'Resultado'}</h1>
      <p class="helper center">Correção pelo acetato virtual · ${gridLabel}. Cada célula correta alcançada vale 1 ponto.</p>
      <div class="score-table"><div class="score-row head"><span>#</span><span>Equipe</span><span>Percurso</span><span>Bônus</span><span>Total</span><span>Tempo</span></div>${ranking.map(r=>`<div class="score-row"><strong>${r.place}º</strong><span class="team-text-${r.color}">● ${COLOR_LABELS[r.color]}</span><span>${r.routeScore}/${r.targetCellCount}</span><span>+${r.bonus}</span><strong>${r.total}</strong><span>${fmtMs(r.elapsedMs)}</span></div>`).join('')}</div>
      <div class="result-gallery"><article><h3>Pista original</h3><div class="result-paper"><canvas id="resultOriginal" width="740" height="1050"></canvas></div><p>${ranking[0]?.targetCellCount ?? '—'} células válidas nesta pista</p></article>${ranking.map(r=>`<article><h3>Equipe ${COLOR_LABELS[r.color]}</h3><div class="result-paper"><canvas id="result-${r.color}" width="740" height="1050"></canvas></div><div style="display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:10px"><button type="button" class="secondary-button acetate-toggle" data-color="${r.color}" data-visible="true">Ocultar acetato</button><span><strong>${r.routeScore}/${r.targetCellCount}</strong> quadrados corretos · +${r.bonus} bônus · ${fmtMs(r.elapsedMs)}</span></div><p class="helper center">Acetato: transparente = acerto · branco = quadrado válido da pista não alcançado · escuro = fora da pista · vermelho = pista original.</p></article>`).join('')}</div>
      <div class="result-actions">${me.id===state.hostId?`<button id="restartGame" class="primary-button" ${(restartGamePending||state.status==='restarting')?'disabled':''}>${(restartGamePending||state.status==='restarting')?'Gerando nova pista…':'Reiniciar partida'}</button>`:`<span>${state.status==='restarting'?'O anfitrião está gerando uma nova pista…':'Aguardando o anfitrião para reiniciar.'}</span>`}<button id="leaveResult" class="secondary-button">Sair</button></div></section>${(state.status==='restarting'||restartGamePending)?startingOverlayMarkup(true):''}</main>`;
    drawTrack('resultOriginal', state.track);
    for(const r of ranking){
      if(state.mode==='smartphone'&&r.scanImage) drawScannedResult(`result-${r.color}`,r.scanImage,r.acetate,true);
      else drawResultWithAcetate(`result-${r.color}`, state.track?.start, r.ops || [], r.acetate, true);
    }
    document.querySelectorAll('.acetate-toggle').forEach(btn=>{
      btn.onclick=()=>{
        const color=btn.dataset.color;
        const row=ranking.find(r=>r.color===color);
        if(!row)return;
        const visible=btn.dataset.visible!=='false';
        const next=!visible;
        btn.dataset.visible=String(next);
        btn.textContent=next?'Ocultar acetato':'Ver acetato';
        if(state.mode==='smartphone'&&row.scanImage) drawScannedResult(`result-${color}`,row.scanImage,row.acetate,next);
        else drawResultWithAcetate(`result-${color}`, state.track?.start, row.ops || [], row.acetate, next);
      };
    });
    const restart=document.querySelector('#restartGame'); if(restart&&!restart.disabled) restart.onclick=()=>requestRestartGame();
    document.querySelector('#leaveResult').onclick=()=>leaveRoom();
    bindLoadingExit();
    bindExit();
  }

  function render() {
    stopTimers();
    if(!state){ entryView(); return; }
    if(state.status==='lobby' || state.status==='starting') lobbyView();
    else if(state.status==='finished' || state.status==='restarting') resultView();
    else prepRaceView();
  }

  function drawBase(id, start, label) {
    const c=document.getElementById(id); if(!c) return; const ctx=c.getContext('2d');
    const W=c.width,H=c.height; ctx.clearRect(0,0,W,H); ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
    // A divisão em quadrantes existe apenas internamente. A folha do Piloto,
    // inclusive na visualização ao vivo do Copiloto, permanece totalmente lisa.
    if(start){const x=start.x*W,y=start.y*H;ctx.strokeStyle='#111';ctx.fillStyle='#fff';ctx.lineWidth=4;ctx.beginPath();ctx.arc(x,y,12,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#111';ctx.font='bold 18px system-ui';ctx.fillText(label||'INÍCIO',Math.min(W-110,x+20),Math.max(28,y-16));ctx.font='bold 28px system-ui';ctx.fillText('↻',Math.min(W-42,x+18),y+18);}
  }
  function applyOp(ctx, canvas, op) {
    const W=canvas.width,H=canvas.height;
    ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=op.width*W;
    if(op.kind==='erase'){ctx.globalCompositeOperation='destination-out';ctx.strokeStyle='rgba(0,0,0,1)';}
    else {ctx.globalCompositeOperation='source-over';ctx.strokeStyle='#17191b';}
    ctx.beginPath();ctx.moveTo(op.from.x*W,op.from.y*H);ctx.lineTo(op.to.x*W,op.to.y*H);ctx.stroke();ctx.restore();
  }
  function renderOps(id, ops) {
    const c=document.getElementById(id); if(!c) return; const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);for(const op of ops)applyOp(ctx,c,op);
  }
  function drawTrack(id, track) {
    const c=document.getElementById(id); if(!c||!track?.points) return; const ctx=c.getContext('2d'),W=c.width,H=c.height;ctx.clearRect(0,0,W,H);ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='#151719';ctx.lineWidth=7;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();track.points.forEach((p,i)=>i?ctx.lineTo(p.x*W,p.y*H):ctx.moveTo(p.x*W,p.y*H));ctx.stroke();
    const s=track.start;ctx.fillStyle='#fff';ctx.strokeStyle='#111';ctx.lineWidth=4;ctx.beginPath();ctx.arc(s.x*W,s.y*H,11,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#111';ctx.font='bold 17px system-ui';ctx.fillText(track.startLabel||'INÍCIO',Math.min(W-100,s.x*W+18),Math.max(28,s.y*H-12));ctx.font='bold 25px system-ui';ctx.fillText('↻',Math.min(W-40,s.x*W+16),s.y*H+18);
  }
  function drawResultDrawing(id,start,ops){
    const c=document.getElementById(id);if(!c)return;const ctx=c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
    for(const op of ops)applyOp(ctx,c,op);
    if(start){ctx.strokeStyle='#111';ctx.lineWidth=4;ctx.beginPath();ctx.arc(start.x*c.width,start.y*c.height,11,0,Math.PI*2);ctx.stroke();}
  }
  function drawOriginalTrackGuide(ctx, W, H){
    const pts = state?.track?.points;
    if(!Array.isArray(pts) || !pts.length) return;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#e02020';
    ctx.lineWidth = Math.max(4, W / 120);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p,i)=>i?ctx.lineTo(p.x*W,p.y*H):ctx.moveTo(p.x*W,p.y*H));
    ctx.stroke();
    ctx.restore();
  }
  function drawAcetateOverlay(id, acetate){
    const c=document.getElementById(id);if(!c||!acetate)return;
    const ctx=c.getContext('2d'),W=c.width,H=c.height;
    const cols=Number(acetate.cols)||0, rows=Number(acetate.rows)||0;
    if(!cols||!rows)return;
    const targets=new Set(Array.isArray(acetate.targetCells)?acetate.targetCells:[]);
    const hits=new Set(Array.isArray(acetate.hitCells)?acetate.hitCells:[]);

    ctx.save();
    // Três estados do acetato virtual:
    // 1) acerto: célula válida + alcançada -> totalmente transparente;
    // 2) célula válida não alcançada -> película branca, mostrando todo o
    //    corredor de quadrados por onde a pista original passa;
    // 3) célula fora da pista -> película escura.
    for(let row=0;row<rows;row++){
      const y0=row*H/rows, y1=(row+1)*H/rows;
      for(let col=0;col<cols;col++){
        const index=row*cols+col;
        if(hits.has(index))continue;
        const x0=col*W/cols, x1=(col+1)*W/cols;
        ctx.fillStyle=targets.has(index)
          ? 'rgba(255, 255, 255, 0.70)'
          : 'rgba(9, 14, 18, 0.30)';
        ctx.fillRect(x0,y0,x1-x0,y1-y0);
      }
    }
    drawOriginalTrackGuide(ctx, W, H);
    ctx.strokeStyle='rgba(18, 24, 28, 0.30)';
    ctx.lineWidth=Math.max(1,W/740);
    ctx.beginPath();
    for(let col=0;col<=cols;col++){const x=col*W/cols;ctx.moveTo(x,0);ctx.lineTo(x,H);}
    for(let row=0;row<=rows;row++){const y=row*H/rows;ctx.moveTo(0,y);ctx.lineTo(W,y);}
    ctx.stroke();
    ctx.restore();
  }
  function drawScannedResult(id,dataUrl,acetate,showAcetate){
    const c=document.getElementById(id);if(!c)return;const ctx=c.getContext('2d'),img=new Image();
    img.onload=()=>{ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);if(showAcetate)drawAcetateOverlay(id,acetate);};
    img.src=dataUrl;
  }
  function drawResultWithAcetate(id,start,ops,acetate,showAcetate){
    drawResultDrawing(id,start,ops);
    if(showAcetate)drawAcetateOverlay(id,acetate);
  }

  function selectTool(nextTool){
    if(!['draw','erase'].includes(nextTool)) return;
    tool=nextTool;
    document.querySelectorAll('.tool-btn').forEach(btn=>btn.classList.toggle('active',btn.dataset.tool===tool));
    const dot=document.getElementById('pointerDot'); if(dot) dot.classList.toggle('erase',tool==='erase');
  }

  function canvasPoint(canvas,e){const r=canvas.getBoundingClientRect();const clientX=e.clientX??e.touches?.[0]?.clientX,clientY=e.clientY??e.touches?.[0]?.clientY;return{x:Math.max(0,Math.min(1,(clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(clientY-r.top)/r.height))};}
  function bindDrawing(id){
    const canvas=document.getElementById(id), dot=document.getElementById('pointerDot');if(!canvas)return;
    const setDot=(e,show=true)=>{if(!dot)return;const r=canvas.getBoundingClientRect();dot.style.display=show?'block':'none';if(show){dot.style.left=`${(e.clientX-r.left)}px`;dot.style.top=`${(e.clientY-r.top)}px`;dot.classList.toggle('erase',tool==='erase');}};
    const down=e=>{if(e.button!==undefined&&e.button!==0)return;e.preventDefault();drawing=true;lastPoint=canvasPoint(canvas,e);setDot(e);canvas.setPointerCapture?.(e.pointerId);};
    const move=e=>{setDot(e);if(!drawing)return;e.preventDefault();const p=canvasPoint(canvas,e);if(!lastPoint)return;const op={kind:tool,from:lastPoint,to:p,width:tool==='erase'?ERASER_WIDTH:PEN_WIDTH};applyOp(canvas.getContext('2d'),canvas,op);localOps.push(op);socket.emit('drawOp',op);lastPoint=p;};
    const up=e=>{drawing=false;lastPoint=null;canvas.releasePointerCapture?.(e.pointerId);};
    canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('pointerleave',e=>{if(!drawing)setDot(e,false);});canvas.addEventListener('pointerenter',e=>setDot(e,true));
  }
  function loadImageFile(file){
    return new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(file),img=new Image();
      img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};
      img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Não foi possível abrir a fotografia.'));};
      img.src=url;
    });
  }
  function sourceCanvasSize(img){
    const max=1000,scale=Math.min(1,max/Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height));
    return {width:Math.max(1,Math.round((img.naturalWidth||img.width)*scale)),height:Math.max(1,Math.round((img.naturalHeight||img.height)*scale))};
  }
  function drawSourceImageToCanvas(img,markers=[]){
    const c=document.querySelector('#scanSourceCanvas');if(!c||!img)return;
    scanWorkSize=sourceCanvasSize(img);c.width=scanWorkSize.width;c.height=scanWorkSize.height;
    const ctx=c.getContext('2d');ctx.drawImage(img,0,0,c.width,c.height);
    if(markers?.length){
      ctx.save();ctx.lineWidth=Math.max(3,c.width/220);ctx.font=`bold ${Math.max(14,c.width/32)}px system-ui`;
      const labels=['1','2','3','4'];
      markers.forEach((p,i)=>{ctx.strokeStyle='#ffad32';ctx.fillStyle='#ffad32';ctx.beginPath();ctx.arc(p.x,p.y,Math.max(10,c.width/45),0,Math.PI*2);ctx.stroke();ctx.fillText(labels[i]||'',p.x+8,p.y-8);});ctx.restore();
    }
  }
  function grayAt(data,index){return data[index]*0.2126+data[index+1]*0.7152+data[index+2]*0.0722;}
  function connectedDarkComponents(imageData,region){
    const {data,width:W,height:H}=imageData;
    const x0=Math.max(0,Math.floor(region.x0)),y0=Math.max(0,Math.floor(region.y0)),x1=Math.min(W,Math.ceil(region.x1)),y1=Math.min(H,Math.ceil(region.y1));
    const rw=x1-x0,rh=y1-y0,seen=new Uint8Array(rw*rh),components=[];
    const dark=(x,y)=>grayAt(data,(y*W+x)*4)<92;
    for(let yy=0;yy<rh;yy++)for(let xx=0;xx<rw;xx++){
      const idx=yy*rw+xx;if(seen[idx]||!dark(x0+xx,y0+yy))continue;
      let stack=[idx],area=0,minx=xx,maxx=xx,miny=yy,maxy=yy,sumx=0,sumy=0;seen[idx]=1;
      while(stack.length){const cur=stack.pop(),cy=Math.floor(cur/rw),cx=cur-cy*rw;area++;sumx+=cx;sumy+=cy;minx=Math.min(minx,cx);maxx=Math.max(maxx,cx);miny=Math.min(miny,cy);maxy=Math.max(maxy,cy);
        const neigh=[[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]];
        for(const [nx,ny] of neigh){if(nx<0||ny<0||nx>=rw||ny>=rh)continue;const ni=ny*rw+nx;if(seen[ni])continue;seen[ni]=1;if(dark(x0+nx,y0+ny))stack.push(ni);}
      }
      const bw=maxx-minx+1,bh=maxy-miny+1;
      components.push({area,bw,bh,minx:minx+x0,maxx:maxx+x0,miny:miny+y0,maxy:maxy+y0,x:x0+sumx/area,y:y0+sumy/area});
    }
    return components;
  }
  function haloBrightness(imageData,comp){
    const {data,width:W,height:H}=imageData,pad=Math.max(comp.bw,comp.bh)*0.7;
    const x0=Math.max(0,Math.floor(comp.minx-pad)),x1=Math.min(W-1,Math.ceil(comp.maxx+pad));
    const y0=Math.max(0,Math.floor(comp.miny-pad)),y1=Math.min(H-1,Math.ceil(comp.maxy+pad));
    let sum=0,n=0;
    for(let y=y0;y<=y1;y+=2)for(let x=x0;x<=x1;x+=2){if(x>=comp.minx&&x<=comp.maxx&&y>=comp.miny&&y<=comp.maxy)continue;sum+=grayAt(data,(y*W+x)*4);n++;}
    return n?sum/n:0;
  }
  function detectCornerMarkers(canvas){
    const ctx=canvas.getContext('2d'),img=ctx.getImageData(0,0,canvas.width,canvas.height),W=canvas.width,H=canvas.height;
    const regions=[
      {x0:0,y0:0,x1:W*.55,y1:H*.55,cx:0,cy:0},
      {x0:W*.45,y0:0,x1:W,y1:H*.55,cx:W,cy:0},
      {x0:W*.45,y0:H*.45,x1:W,y1:H,cx:W,cy:H},
      {x0:0,y0:H*.45,x1:W*.55,y1:H,cx:0,cy:H}
    ];
    const minDim=Math.min(W,H),minArea=Math.max(20,W*H*.00002),maxArea=W*H*.012;
    return regions.map(region=>{
      const comps=connectedDarkComponents(img,region).filter(c=>{
        const ratio=c.bw/Math.max(c.bh,1),size=Math.max(c.bw,c.bh);
        return c.area>=minArea&&c.area<=maxArea&&ratio>.52&&ratio<1.9&&size>minDim*.012&&size<minDim*.14;
      });
      let best=null,bestScore=Infinity;
      for(const c of comps){
        const halo=haloBrightness(img,c);if(halo<125)continue;
        const cornerDist=Math.hypot((c.x-region.cx)/W,(c.y-region.cy)/H);
        const squarePenalty=Math.abs(Math.log(c.bw/Math.max(c.bh,1)));
        const fill=c.area/(c.bw*c.bh),fillPenalty=Math.abs(fill-.55);
        const score=cornerDist*2.4+squarePenalty*.5+fillPenalty*.35-halo/1200;
        if(score<bestScore){bestScore=score;best=c;}
      }
      if(!best)throw new Error('Um dos marcadores não foi encontrado.');
      return {x:best.x,y:best.y};
    });
  }
  function solveLinear(A,b){
    const n=b.length,M=A.map((row,i)=>[...row,b[i]]);
    for(let col=0;col<n;col++){
      let pivot=col;for(let r=col+1;r<n;r++)if(Math.abs(M[r][col])>Math.abs(M[pivot][col]))pivot=r;
      if(Math.abs(M[pivot][col])<1e-10)throw new Error('Não foi possível calcular a perspectiva.');
      [M[col],M[pivot]]=[M[pivot],M[col]];
      const div=M[col][col];for(let j=col;j<=n;j++)M[col][j]/=div;
      for(let r=0;r<n;r++){if(r===col)continue;const f=M[r][col];if(!f)continue;for(let j=col;j<=n;j++)M[r][j]-=f*M[col][j];}
    }
    return M.map(row=>row[n]);
  }
  function homographyDstToSrc(dst,src){
    const A=[],b=[];
    for(let i=0;i<4;i++){
      const x=dst[i].x,y=dst[i].y,u=src[i].x,v=src[i].y;
      A.push([x,y,1,0,0,0,-u*x,-u*y]);b.push(u);
      A.push([0,0,0,x,y,1,-v*x,-v*y]);b.push(v);
    }
    const h=solveLinear(A,b);return [...h,1];
  }
  function warpPerspective(sourceCanvas,srcMarkers,outW=740,outH=1050){
    const markerX=8/148,markerY=8/210;
    const dst=[{x:markerX*(outW-1),y:markerY*(outH-1)},{x:(1-markerX)*(outW-1),y:markerY*(outH-1)},{x:(1-markerX)*(outW-1),y:(1-markerY)*(outH-1)},{x:markerX*(outW-1),y:(1-markerY)*(outH-1)}];
    const Hm=homographyDstToSrc(dst,srcMarkers),sctx=sourceCanvas.getContext('2d'),src=sctx.getImageData(0,0,sourceCanvas.width,sourceCanvas.height),out=document.createElement('canvas');out.width=outW;out.height=outH;const octx=out.getContext('2d'),odata=octx.createImageData(outW,outH);
    for(let y=0;y<outH;y++)for(let x=0;x<outW;x++){
      const den=Hm[6]*x+Hm[7]*y+1,sx=(Hm[0]*x+Hm[1]*y+Hm[2])/den,sy=(Hm[3]*x+Hm[4]*y+Hm[5])/den;
      const ox=(y*outW+x)*4;
      if(sx<0||sy<0||sx>=sourceCanvas.width||sy>=sourceCanvas.height){odata.data[ox]=odata.data[ox+1]=odata.data[ox+2]=255;odata.data[ox+3]=255;continue;}
      const ix=Math.min(sourceCanvas.width-1,Math.max(0,Math.round(sx))),iy=Math.min(sourceCanvas.height-1,Math.max(0,Math.round(sy))),si=(iy*sourceCanvas.width+ix)*4;
      odata.data[ox]=src.data[si];odata.data[ox+1]=src.data[si+1];odata.data[ox+2]=src.data[si+2];odata.data[ox+3]=255;
    }
    octx.putImageData(odata,0,0);return out;
  }
  function pointInExcludedTemplate(x,y,W,H){
    const nx=x/W,ny=y/H,mx=8/148,my=8/210,dx=5.2/148,dy=5.2/210;
    const markers=[[mx,my],[1-mx,my],[1-mx,1-my],[mx,1-my]];
    if(markers.some(([cx,cy])=>Math.abs(nx-cx)<dx&&Math.abs(ny-cy)<dy))return true;
    // A cruz central pertence à folha impressa e nunca pode virar "traço do Piloto"
    // mesmo em uma foto com sombra. A faixa excluída é muito mais estreita que uma célula.
    if(Math.abs(nx-.5)<0.006||Math.abs(ny-.5)<0.0045)return true;
    return false;
  }
  function extractInkAndCells(warped,difficulty){
    const W=warped.width,H=warped.height,ctx=warped.getContext('2d'),img=ctx.getImageData(0,0,W,H),mask=new Uint8Array(W*H),preview=document.createElement('canvas');preview.width=W;preview.height=H;const pctx=preview.getContext('2d');pctx.fillStyle='#fff';pctx.fillRect(0,0,W,H);const pimg=pctx.getImageData(0,0,W,H);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      if(pointInExcludedTemplate(x,y,W,H))continue;
      const i=(y*W+x)*4,r=img.data[i],g=img.data[i+1],b=img.data[i+2],lum=.2126*r+.7152*g+.0722*b;
      // Linhas-guia da folha são cinza-claro; caneta preta/azul escura cruza este limite.
      const dark=lum<138 && Math.min(r,g,b)<130;
      if(dark){mask[y*W+x]=1;pimg.data[i]=pimg.data[i+1]=pimg.data[i+2]=22;pimg.data[i+3]=255;}
    }
    pctx.putImageData(pimg,0,0);
    const cols=difficulty==='hard'?16:8,rows=difficulty==='hard'?24:12,cells=[];
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const x0=Math.floor(col*W/cols),x1=Math.floor((col+1)*W/cols),y0=Math.floor(row*H/rows),y1=Math.floor((row+1)*H/rows);let count=0;
      for(let y=y0;y<y1;y+=1)for(let x=x0;x<x1;x+=1)if(mask[y*W+x])count++;
      const area=(x1-x0)*(y1-y0),threshold=Math.max(14,Math.floor(area*.003));
      if(count>=threshold)cells.push(row*cols+col);
    }
    // Reduz a imagem enviada ao servidor; o traço binário comprime muito bem em PNG.
    const small=document.createElement('canvas');small.width=370;small.height=525;const sctx=small.getContext('2d');sctx.imageSmoothingEnabled=true;sctx.drawImage(preview,0,0,small.width,small.height);
    return {cells,scanImage:small.toDataURL('image/png')};
  }
  async function analyzePhysicalSheet(img,manualMarkers,difficulty,manual=false){
    const size=scanWorkSize||sourceCanvasSize(img),source=document.createElement('canvas');source.width=size.width;source.height=size.height;source.getContext('2d').drawImage(img,0,0,source.width,source.height);
    let markers;
    if(manual&&manualMarkers?.length===4)markers=manualMarkers.map(p=>({x:p.x,y:p.y}));
    else markers=detectCornerMarkers(source);
    const warped=warpPerspective(source,markers,740,1050),extracted=extractInkAndCells(warped,difficulty);
    return {...extracted,sourceMarkers:markers};
  }

  function startTimers(){
    const team=myTeam();
    if(state?.status==='racing'&&state.startedAt&&!team?.finishedAt){raceTimer=setInterval(()=>{const el=document.querySelector('#raceClock');if(el)el.textContent=fmtMs(Date.now()-state.startedAt);},31);}
    if(state?.status==='countdown'&&state.countdownEndsAt){const tick=()=>{const n=document.querySelector('#countdownNumber');if(!n)return;const remain=Math.max(0,state.countdownEndsAt-Date.now());n.textContent=remain<=0?'RALLY!':String(Math.max(1,Math.ceil(remain/1000)));};tick();countdownTimer=setInterval(tick,80);}
  }
  function stopTimers(){if(raceTimer)clearInterval(raceTimer);if(countdownTimer)clearInterval(countdownTimer);raceTimer=null;countdownTimer=null;}
  function leaveRoom(){emitAck('leaveRoom',{},()=>{state=null;scanAnalysis=null;scanSourceImage=null;manualMarkerPoints=[];clearIdentity();notice='';exitConfirm=false;render();});}
  function bindExit(){const b=document.querySelector('#exitRoom');if(!b)return;b.onclick=()=>{if(!exitConfirm){exitConfirm=true;b.textContent='Confirmar saída';setTimeout(()=>{exitConfirm=false;const x=document.querySelector('#exitRoom');if(x)x.textContent='Sair';},2500);}else leaveRoom();};}

  socket.on('roomState', next => {
    state=next;
    if (next.status !== 'lobby') startGamePending = false;
    if (next.status !== 'finished') restartGamePending = false;
    const me=next.players.find(p=>p.id===identity.playerId);
    if(me){entryMode=next.mode||entryMode;saveIdentity({roomCode:next.code,name:me.name,mode:entryMode});}
    const ownTeam = me?.color ? next.teams?.[me.color] : null;
    const ownConfirmed = me?.role==='pilot' ? ownTeam?.pilotConfirmed : me?.role==='copilot' ? ownTeam?.copilotConfirmed : false;
    if (next.status !== 'racing' || ownTeam?.finishedAt || ownConfirmed) finishSending = false;
    render();
  });
  socket.on('drawOp', ({color,op}) => {
    const me=myPlayer(); if(!me||me.color!==color||me.role!=='copilot'||!op)return;
    localOps.push(op);const c=document.querySelector('#copilotDraw');if(c)applyOp(c.getContext('2d'),c,op);
  });
  socket.on('chipClaimed', ({index,color}) => {
    if(state&&Array.isArray(state.chips)){state.chips[index]=color;const row=document.querySelectorAll('.bonus-chip')[index];if(row){row.className=`bonus-chip claimed chip-${color}`;row.title=`Ficha ${index+1} — Equipe ${COLOR_LABELS[color]}`;}}
  });
  socket.on('connect', () => {
    if(identity.roomCode&&identity.playerId&&identity.token){socket.emit('resumeSession',{code:identity.roomCode,playerId:identity.playerId,token:identity.token},res=>{if(!res?.ok){state=null;clearIdentity();render();}});}
  });
  socket.on('disconnect',()=>{notice='Conexão com o servidor interrompida. Tentando reconectar…';if(state)render();});

  if(socket.connected&&identity.roomCode&&identity.playerId&&identity.token){socket.emit('resumeSession',{code:identity.roomCode,playerId:identity.playerId,token:identity.token},res=>{if(!res?.ok){clearIdentity();render();}});} else render();
})();
