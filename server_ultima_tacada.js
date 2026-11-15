// Servidor de salas, chaveamento e partidas online 8 Ball Tournament.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET','POST'] } });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const matches = new Map();
const FORMATS = new Set([2,4,8,16]);
app.get('/health', (_req,res) => res.json({ ok:true, service:'8ball-tournament', rooms:rooms.size, matches:matches.size }));
app.use(express.static(path.join(__dirname,'public')));
function code(){ let value; do { value=crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase(); } while(rooms.has(value)); return value; }
function safeName(value){ const name=String(value || 'JOGADOR').trim().replace(/[<>]/g,'').slice(0,18); return name || 'JOGADOR'; }
// ALTERADO AQUI - compartilha as configurações de tempo com todos os aparelhos da sala.
function normalizeTournamentSettings(settings={}){
 const timeMode=settings.timeMode==='tempo'?'tempo':'individual';
 const rawMinutes=Number(settings.minutes);
 const minutes=Number.isFinite(rawMinutes)?Math.max(1,Math.min(60,rawMinutes)):10;
 return {timeMode,minutes,guide:settings.guide!==false};
}
function publicRoom(room){ return { code:room.code, size:room.size, hostId:room.hostId, players:room.players.map(p=>({id:p.id,name:p.name})), started:room.started, bracket:room.bracket, settings:room.settings }; }
// ALTERADO AQUI - mantém o socket atual ligado ao participante estável após reconexão.
function rebindRoomPlayer(room,playerKey,socket){
 if(!playerKey)return null;
 const player=room.players.find(p=>p.playerKey===playerKey);
 if(!player)return null;
 const oldId=player.id;player.id=socket.id;socket.join(room.code);
 if(room.hostId===oldId)room.hostId=socket.id;
 const updateBracket=entry=>{
  if(!entry||typeof entry!=="object")return;
  if(entry.playerKey===playerKey)entry.id=socket.id;
  Object.values(entry).forEach(value=>{if(Array.isArray(value))value.forEach(updateBracket);else if(value&&typeof value==="object")updateBracket(value);});
 };
 updateBracket(room.bracket);
 return player;
}
function broadcast(room){ io.to(room.code).emit('tournament:room-update',publicRoom(room)); }
function makeBracket(players){
 const shuffled=players.map(p=>({id:p.id,name:p.name,playerKey:p.playerKey||""}));
 for(let i=shuffled.length-1;i>0;i--){const j=crypto.randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
 const rounds=[];let current=shuffled;let roundIndex=0;
 while(current.length>=2){
  const matchesInRound=[];
  for(let i=0;i<current.length;i+=2){
   const a=current[i],b=current[i+1];
   matchesInRound.push({matchId:`R${roundIndex}M${i/2}`,a,b,winner:null});
  }
  rounds.push({matches:matchesInRound});
  current=matchesInRound.map((_,i)=>({id:null,name:'Vencedor '+(i+1)}));
  roundIndex++;
 }
 return rounds;
}
function replyError(ack,message){ if(typeof ack==='function')ack({ok:false,error:{message}}); }
function getRoom(codeValue){return rooms.get(String(codeValue||'').trim().toUpperCase());}
function findBracketMatch(room,matchId){
 if(!room?.bracket)return null;
 for(let roundIndex=0;roundIndex<room.bracket.length;roundIndex++){
  const round=room.bracket[roundIndex];
  const matchIndex=(round.matches||[]).findIndex(item=>item.matchId===matchId);
  if(matchIndex>=0)return {match:round.matches[matchIndex],roundIndex,matchIndex};
 }
 return null;
}
function emitBracket(room){if(room)io.to(room.code).emit('tournament:bracket-update',{code:room.code,bracket:room.bracket});}
function completeBracketMatch(room,match,roundIndex,matchIndex,options={}){
 if(!room||!match||match.completed)return null;
 const winnerSlot=options.winnerSlot===0||options.winnerSlot===1?options.winnerSlot:null;
 const winner=winnerSlot===null?null:match[winnerSlot===0?'a':'b'];
 match.winner=winner?{...winner}:null;
 match.winnerId=winner?.id??null;
 match.winnerName=winner?.name??null;
 if(options.scoreA!==undefined&&options.scoreA!==null)match.scoreA=Number(options.scoreA)||0;
 if(options.scoreB!==undefined&&options.scoreB!==null)match.scoreB=Number(options.scoreB)||0;
 match.status=String(options.status||(winner?'FINALIZADA':'ENCERRADA'));
 match.reason=options.reason||'';
 match.completed=true;match.ended=true;
 match.result={type:options.type||'score',winnerSlot,loserSlot:options.loserSlot??(winnerSlot===null?null:1-winnerSlot),scoreA:match.scoreA??null,scoreB:match.scoreB??null};
 if(winner&&roundIndex+1<room.bracket.length){
  const nextRound=room.bracket[roundIndex+1];
  const nextMatch=nextRound.matches[Math.floor(matchIndex/2)];
  if(nextMatch){const side=matchIndex%2===0?'a':'b';nextMatch[side]={...winner};}
 }
 emitBracket(room);
 return {winner:match.winner,bracket:room.bracket,result:match.result};
}
// ALTERADO AQUI - controla 60 segundos de inatividade por participante, no relógio do servidor.
const INACTIVITY_LIMIT_MS=60000;
function clearMatchInactivity(match){
 if(!match?.inactivityTimers)return;
 match.inactivityTimers.forEach(timer=>{if(timer)clearTimeout(timer);});
 match.inactivityTimers=[null,null];
}
function finishMatchByInactivity(match,loserSlot){
 if(!match||match.ended)return;
 const now=Date.now(),winnerSlot=loserSlot===0?1:0;
 const bothInactive=now-(match.lastActivity?.[winnerSlot]||0)>=INACTIVITY_LIMIT_MS;
 match.ended=true;clearMatchInactivity(match);
 const room=getRoom(match.code);
 let completed=null;
 if(room){
  const found=findBracketMatch(room,match.bracketMatchId);
  if(found)completed=completeBracketMatch(room,found.match,found.roundIndex,found.matchIndex,{
   winnerSlot:bothInactive?null:winnerSlot,type:'forfeit',status:bothInactive?'ENCERRADA POR INATIVIDADE':'ENCERRADA POR DESISTÊNCIA',
   reason:bothInactive?'Ambos os jogadores ficaram inativos.':'DESISTÊNCIA',loserSlot
  });
 }
 const result={matchId:match.id,bracketMatchId:match.bracketMatchId,code:match.code,loserSlot,winnerSlot:bothInactive?null:winnerSlot,winner:completed?.winner||null,bothInactive,bracket:room?.bracket||null};
 match.forfeit=result;
 io.to(match.id).emit('match:forfeit',result);
}
function resetMatchInactivity(match,slot){
 if(!match||match.ended||!match.started||slot<0||slot>1)return;
 if(!Array.isArray(match.lastActivity))match.lastActivity=[Date.now(),Date.now()];
 if(!Array.isArray(match.inactivityTimers))match.inactivityTimers=[null,null];
 match.lastActivity[slot]=Date.now();
 if(match.inactivityTimers[slot])clearTimeout(match.inactivityTimers[slot]);
 match.inactivityTimers[slot]=setTimeout(()=>finishMatchByInactivity(match,slot),INACTIVITY_LIMIT_MS);
}
io.on('connection',socket=>{
 socket.on('tournament:create',(data={},ack)=>{
  const size=Number(data.size); if(!FORMATS.has(size))return replyError(ack,'Formato de torneio inválido.');
  const roomCode=code();const room={code:roomCode,size,hostId:socket.id,players:[{id:socket.id,name:safeName(data.name),playerKey:String(data.playerKey||"")}],started:false,bracket:null,settings:normalizeTournamentSettings(data.settings||{})};
  rooms.set(roomCode,room);socket.join(roomCode);if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});broadcast(room);
 });
 socket.on('tournament:join',(data={},ack)=>{
  const room=getRoom(data.code);if(!room)return replyError(ack,'Sala não encontrada. Confira o código.');
  const existing=room.players.find(p=>p.id===socket.id);
  if(existing){socket.join(room.code);if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});return;}
  if(room.started){
   const rebound=rebindRoomPlayer(room,String(data.playerKey||""),socket);
   if(!rebound)return replyError(ack,'Este torneio já foi iniciado ou este aparelho não pertence à sala.');
   if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});
   broadcast(room);return;
  }
  if(room.players.length>=room.size)return replyError(ack,'Esta sala já está cheia.');
  room.players.push({id:socket.id,name:safeName(data.name),playerKey:String(data.playerKey||"")});socket.join(room.code);
  if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});broadcast(room);
 });
 socket.on('tournament:start',(data={},ack)=>{
  const room=getRoom(data.code);if(!room)return replyError(ack,'Sala não encontrada.');
  if(room.hostId!==socket.id)return replyError(ack,'Somente o criador pode iniciar o torneio.');
  if(room.started)return replyError(ack,'Este torneio já foi iniciado.');
  if(room.players.length!==room.size)return replyError(ack,'Aguarde preencher todas as vagas.');
  room.started=true;room.bracket=makeBracket(room.players);const payload={players:room.players.map(p=>({id:p.id,name:p.name})),bracket:room.bracket,settings:room.settings};
  io.to(room.code).emit('tournament:started',payload);if(typeof ack==='function')ack({ok:true,bracket:room.bracket});
 });
 // ALTERADO AQUI - cria uma sala de partida exclusiva para os dois finalistas e identifica seus lugares.
 socket.on('match:join',(data={},ack)=>{
  const room=getRoom(data.code);if(!room||!room.started)return replyError(ack,'Torneio não encontrado ou ainda não iniciado.');
  const bracketMatchId=String(data.matchId||'R0M0');
  const found=findBracketMatch(room,bracketMatchId);if(!found)return replyError(ack,'Confronto não encontrado no chaveamento.');
  const bracketMatch=found.match;
  if(bracketMatch.completed||bracketMatch.winner||bracketMatch.status)return replyError(ack,'Esta partida já foi encerrada.');
  if(!bracketMatch.a?.id||!bracketMatch.b?.id)return replyError(ack,'Este confronto ainda aguarda a definição dos dois participantes.');
  const playerKey=String(data.playerKey||'');
  let slot=bracketMatch.a.id===socket.id||!!playerKey&&bracketMatch.a.playerKey===playerKey?0:bracketMatch.b.id===socket.id||!!playerKey&&bracketMatch.b.playerKey===playerKey?1:-1;
  if(slot<0)return replyError(ack,'Somente os dois participantes deste confronto podem jogar.');
  const roomPlayer=room.players.find(p=>(playerKey&&p.playerKey===playerKey)||p.id===socket.id);
  if(roomPlayer&&roomPlayer.id!==socket.id){
   const oldId=roomPlayer.id;roomPlayer.id=socket.id;if(room.hostId===oldId)room.hostId=socket.id;
   const updatePlayer=entry=>{if(!entry||typeof entry!=='object')return;if(entry.playerKey===roomPlayer.playerKey)entry.id=socket.id;Object.values(entry).forEach(value=>{if(Array.isArray(value))value.forEach(updatePlayer);else if(value&&typeof value==='object')updatePlayer(value);});};
   updatePlayer(room.bracket);
  }
  const participant=bracketMatch[slot===0?'a':'b'];
  if(roomPlayer){participant.id=socket.id;participant.playerKey=roomPlayer.playerKey||participant.playerKey;}
  const matchId=room.code+':'+bracketMatch.matchId;
  let match=matches.get(matchId);
  if(!match){match={id:matchId,code:room.code,bracketMatchId:bracketMatch.matchId,players:[null,null],participants:[null,null],state:null,currentPlayer:0,started:false,ended:false,inactivityTimers:[null,null],lastActivity:[0,0]};matches.set(matchId,match);}
  if(match.ended){if(typeof ack==='function')ack({ok:true,matchId,slot,players:[bracketMatch.a.name,bracketMatch.b.name],state:match.state,ready:false,ended:true,forfeit:match.forfeit||null});return;}
  socket.join(room.code); // ALTERADO AQUI - mantém o participante inscrito na sala geral do torneio.
  match.players[slot]=socket.id;match.participants[slot]={...participant};socket.join(matchId);
  const playerNames=[bracketMatch.a.name,bracketMatch.b.name];
  if(typeof ack==='function')ack({ok:true,matchId,bracketMatchId,slot,players:playerNames,state:match.state,ready:match.players.every(Boolean),ended:!!match.ended,forfeit:match.forfeit||null});
  io.to(matchId).emit('match:presence',{players:match.players.map(Boolean),names:playerNames});
  if(match.players.every(Boolean)){
   match.started=true;
   if(!match.lastActivity.some(Boolean)){match.lastActivity=[Date.now(),Date.now()];resetMatchInactivity(match,0);resetMatchInactivity(match,1);}
   io.to(matchId).emit('match:ready',{matchId,names:playerNames,state:match.state,currentPlayer:match.currentPlayer});
   if(!match.state)io.to(match.players[0]).emit('match:initialize-request',{matchId});
   else io.to(matchId).emit('match:state',match.state);
  }
 });
 // ALTERADO AQUI - qualquer interação na mesa renova somente o relógio invisível daquele jogador.
 socket.on('match:activity',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));
  if(!match||!match.started||match.ended)return replyError(ack,'Partida online indisponível.');
  const slot=match.players.indexOf(socket.id);
  if(slot<0)return replyError(ack,'Você não pertence a esta partida.');
  resetMatchInactivity(match,slot);
  if(typeof ack==='function')ack({ok:true});
 });
 // ALTERADO AQUI - apenas o jogador da vez pode anunciar o início de uma tacada.
 socket.on('match:shot-start',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));if(!match||!match.started||match.ended)return replyError(ack,'Partida online indisponível.');
  const slot=match.players.indexOf(socket.id);if(slot<0||slot!==match.currentPlayer)return replyError(ack,'Ainda não é sua vez de jogar.');
  // ALTERADO AQUI - valida e transmite o estado da tacada no instante do impacto.
  // O adversário recebe posições, velocidades e dados da jogada para iniciar a mesma animação.
  if(!data.state||!Array.isArray(data.state.balls)||data.state.balls.length>16)
   return replyError(ack,'Dados da tacada inválidos.');
  const motionState=data.state;
  if(!motionState.balls.every(ball=>Number.isFinite(ball.x)&&Number.isFinite(ball.y)&&Number.isFinite(ball.vx)&&Number.isFinite(ball.vy)))
   return replyError(ack,'Posições ou velocidades da tacada inválidas.');
  io.to(match.id).emit('match:opponent-shot',{slot,name:safeName(data.name)});
  io.to(match.id).emit('match:shot-motion',{slot,state:motionState});
  if(typeof ack==='function')ack({ok:true});
 });
 // ALTERADO AQUI - retransmite snapshots durante a tacada sem alterar o estado final salvo no servidor.
 socket.on('match:shot-motion',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));
  if(!match||!match.started||match.ended)return replyError(ack,'Partida online indisponível.');
  const slot=match.players.indexOf(socket.id);
  if(slot<0||slot!==match.currentPlayer)return replyError(ack,'Tacada fora da vez.');
  const motionState=data.state;
  if(!motionState||!Array.isArray(motionState.balls)||motionState.balls.length>16)return replyError(ack,'Dados do movimento inválidos.');
  if(!motionState.balls.every(ball=>Number.isFinite(ball.x)&&Number.isFinite(ball.y)&&Number.isFinite(ball.vx)&&Number.isFinite(ball.vy)))return replyError(ack,'Posições ou velocidades inválidas.');
  socket.to(match.id).emit('match:shot-motion',{slot,state:motionState});
  if(typeof ack==='function')ack({ok:true});
 });
 // ALTERADO AQUI - recebe e replica o estado completo da mesa ao terminar cada tacada.
 socket.on('match:state',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));if(!match||!match.started||match.ended)return replyError(ack,'Partida online indisponível.');
  const slot=match.players.indexOf(socket.id);if(slot<0)return replyError(ack,'Você não pertence a esta partida.');
  if(data.initial){if(slot!==0||match.state)return replyError(ack,'Estado inicial não autorizado.');}
  else if(slot!==match.currentPlayer)return replyError(ack,'Tacada fora da vez.');
  if(data.timeout&&slot!==match.currentPlayer)return replyError(ack,'Relógio enviado fora da vez.');
  if(!data.state||!Array.isArray(data.state.balls)||data.state.balls.length>16)return replyError(ack,'Estado da mesa inválido.');
  match.state=data.state;resetMatchInactivity(match,slot);match.currentPlayer=Number(data.state.currentPlayer)===1?1:0;
  if(data.state.gameOver){
   const result=data.result||{};
   const winnerSlot=Number(result.winnerSlot);
   if(winnerSlot!==0&&winnerSlot!==1)return replyError(ack,'Resultado final sem vencedor válido.');
   match.ended=true;clearMatchInactivity(match);
   const room=getRoom(match.code),found=room&&findBracketMatch(room,match.bracketMatchId);
   if(found){
    const completed=completeBracketMatch(room,found.match,found.roundIndex,found.matchIndex,{
     winnerSlot,scoreA:result.scoreA,scoreB:result.scoreB,type:'score',status:'FINALIZADA',reason:String(result.reason||'')
    });
    match.result=completed?.result||null;
   }
  }
  io.to(match.id).emit('match:state',match.state);
  if(typeof ack==='function')ack({ok:true});
 });
 socket.on('match:chat',(data={})=>{
  const match=matches.get(String(data.roomId||''));if(!match||!match.players.includes(socket.id))return;
  io.to(match.id).emit('match:chat',{roomId:match.id,name:safeName(data.name),message:String(data.message||'').slice(0,180)});
 });
 socket.on('disconnect',()=>{
  for(const [roomCode,room] of rooms){
   if(!room.started){
    const before=room.players.length;room.players=room.players.filter(p=>p.id!==socket.id);
    if(room.players.length!==before){if(room.players.length===0){rooms.delete(roomCode);continue;}if(room.hostId===socket.id)room.hostId=room.players[0].id;broadcast(room);}
   }
  }
  for(const match of matches.values()){
   const slot=match.players.indexOf(socket.id);
   if(slot>=0)io.to(match.id).emit('match:presence',{players:match.players.map(Boolean),disconnectedSlot:slot});
  }
 });
});
server.listen(PORT,()=>console.log(`8 Ball Tournament multiplayer ativo na porta ${PORT}`));
