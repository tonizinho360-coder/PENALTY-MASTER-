
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

const rooms = new Map();
// ALTERADO AQUI - V20.60: resultados e confirmações ficam privados até o fechamento integral da fase.
const tournamentMatchPrivateResults = new Map();
// ALTERADO AQUI - V20.48: temporizadores de tolerância exclusivos das salas do Torneio Online.
const tournamentPresenceTimers = new Map();
const TOURNAMENT_RECONNECT_GRACE_MS = 3 * 60 * 1000;
function tournamentPresenceKey(code, playerId) { return `${code}:${playerId}`; }
function clearTournamentPresenceTimer(code, playerId) {
  const key = tournamentPresenceKey(code, playerId);
  const timer = tournamentPresenceTimers.get(key);
  if (timer) clearTimeout(timer);
  tournamentPresenceTimers.delete(key);
}
function expireTournamentPlayer(code, playerId, reason) {
  const room = rooms.get(code);
  if (!room || room.mode !== "tournament" || !room.tournament || room.tournament.status !== "waiting") return;
  const index = room.players.findIndex(p => p.playerId === playerId);
  if (index < 0) return;
  const player = room.players[index];
  if (player.connected !== false) return;
  io.to(player.id).emit("tournament_presence_expired", { code, playerId, reason: reason || "Prazo de reconexão encerrado." });
  room.players.splice(index, 1);
  clearTournamentPresenceTimer(code, playerId);
  if (room.players.length && room.hostId === player.id) {
    room.hostId = room.players[0].id;
    room.players[0].isHost = true;
  }
  if (!room.players.length) rooms.delete(code);
  else sendRoomUpdate(room);
  broadcastTournamentList();
  io.to(`tournament_observers:${code}`).emit("tournament_player_expired", { code, playerId, reason: reason || "Prazo de reconexão encerrado." });
}
function startTournamentPresenceGrace(room, player, reason) {
  if (!room || room.mode !== "tournament" || !player || room.tournament.status !== "waiting") return;
  player.connected = false;
  player.disconnectedAt = Date.now();
  const key = tournamentPresenceKey(room.code, player.playerId);
  clearTournamentPresenceTimer(room.code, player.playerId);
  const timer = setTimeout(() => expireTournamentPlayer(room.code, player.playerId, reason), TOURNAMENT_RECONNECT_GRACE_MS);
  tournamentPresenceTimers.set(key, timer);
}

app.get("/", (req, res) => {
  res.send("PÊNALTI MASTER - Servidor multiplayer online!");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    rooms: rooms.size
  });
});

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function getPublicRoom(room) {
  const result = {
    code: room.code,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    players: room.players,
    state: room.state
  };

  // ALTERADO AQUI - expõe os dados extras somente nas salas de torneio.
  if (room.mode === "tournament" && room.tournament) {
    result.tournament = room.tournament;
  }

  return result;
}

// ALTERADO AQUI - regras exclusivas do Torneio Multiplayer.
const TOURNAMENT_PHASE_SLOTS = {
  oitavas: 16,
  quartas: 8,
  semi: 4
};

function tournamentReply(callback, result) {
  if (typeof callback === "function") callback(result);
}

function normalizeTournamentCode(value) {
  // ALTERADO AQUI - aceita o código com ou sem o prefixo PF- e remove espaços/separadores.
  let code = String(value || "").toUpperCase().trim().replace(/[^A-Z0-9]/g, "");
  if (code.startsWith("PF")) code = code.slice(2);
  return code.length === 6 ? `PF-${code}` : `PF-${code}`;
}

function normalizeClub(value) {
  return String(value || "").trim().slice(0, 80);
}

// ALTERADO AQUI - V20.60: monta confrontos oficiais para qualquer fase, preservando o dono humano de cada clube.
function buildTournamentMatchState(room, bracketOrder, phase) {
  const currentPhase = String(phase || room.tournament.phase || "semi");
  const humanByClub = new Map();
  room.players.forEach(player => {
    if (player.club) humanByClub.set(String(player.club).toLocaleLowerCase("pt-BR"), {
      playerId: String(player.playerId),
      name: String(player.name || "Jogador")
    });
  });

  const matches = [];
  for (let index = 0; index < bracketOrder.length; index += 2) {
    const home = bracketOrder[index];
    const away = bracketOrder[index + 1];
    if (!home || !away) continue;
    const homeOwner = humanByClub.get(String(home).toLocaleLowerCase("pt-BR")) || null;
    const awayOwner = humanByClub.get(String(away).toLocaleLowerCase("pt-BR")) || null;
    const matchType = homeOwner && awayOwner ? "player_vs_player"
      : (homeOwner || awayOwner) ? "player_vs_bot" : "bot_vs_bot";

    matches.push({
      id: `${currentPhase}-M${matches.length + 1}`,
      phase: currentPhase,
      index: matches.length,
      home,
      away,
      homePlayerId: homeOwner ? homeOwner.playerId : null,
      awayPlayerId: awayOwner ? awayOwner.playerId : null,
      type: matchType,
      status: "pending",
      result: null,
      winner: null,
      createdAt: Date.now()
    });
  }

  return {
    version: 2,
    phase: currentPhase,
    phaseStatus: "in_progress",
    matches,
    completedPhases: [],
    champion: null,
    updatedAt: Date.now()
  };
}

function tournamentPrivateResultKey(code, matchId) {
  return `${code}:${matchId}`;
}

function validTournamentGoals(value) {
  const goals = Number(value);
  return Number.isInteger(goals) && goals >= 0 && goals <= 20 ? goals : null;
}

// Desempate determinístico executado no servidor para placares empatados.
function tournamentTieBreakWinner(match) {
  const seed = `${match.id}|${match.home}|${match.away}|${match.result.homeScore}-${match.result.awayScore}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? match.home : match.away;
}

// Resultado BOT×BOT é calculado no servidor; o navegador não escolhe placar ou vencedor.
function simulateTournamentBotResult(match) {
  let seed = 2160731;
  const raw = `${match.id}|${match.home}|${match.away}|${match.phase}`;
  for (let i = 0; i < raw.length; i++) {
    seed ^= raw.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  function randomInt(max) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % (max + 1);
  }
  let homeScore = randomInt(5);
  let awayScore = randomInt(5);
  if (homeScore === awayScore) {
    if (randomInt(1) === 0) homeScore++;
    else awayScore++;
  }
  return {
    homeScore,
    awayScore,
    winner: homeScore > awayScore ? match.home : match.away,
    source: "server_bot_simulation",
    completedAt: Date.now()
  };
}

function resolveTournamentAutomaticBots(room) {
  const state = room && room.tournament && room.tournament.matchState;
  if (!state || !Array.isArray(state.matches)) return;
  state.matches.forEach(match => {
    if (match.type !== "bot_vs_bot" || match.status !== "pending") return;
    const key = tournamentPrivateResultKey(room.code, match.id);
    if (!tournamentMatchPrivateResults.has(key)) {
      tournamentMatchPrivateResults.set(key, simulateTournamentBotResult(match));
    }
  });
}

function publishTournamentMatchState(room, completedPhase) {
  const payload = {
    code: room.code,
    matchState: room.tournament.matchState
  };
  io.to(room.code).emit("tournament_match_state_updated", payload);
  io.to(`tournament_observers:${room.code}`).emit("tournament_match_state_updated", payload);
  if (completedPhase) {
    const phasePayload = { code: room.code, completedPhase, matchState: room.tournament.matchState };
    io.to(room.code).emit("tournament_phase_completed", phasePayload);
    io.to(`tournament_observers:${room.code}`).emit("tournament_phase_completed", phasePayload);
  }
}

// Só conclui uma fase quando existe resultado privado para TODOS os confrontos.
// Depois publica a fase inteira e cria a próxima com os vencedores na ordem dos confrontos.
function completeTournamentPhaseIfReady(room) {
  const state = room && room.tournament && room.tournament.matchState;
  if (!state || !Array.isArray(state.matches) || !state.matches.length) return false;
  const privateResults = state.matches.map(match => tournamentMatchPrivateResults.get(tournamentPrivateResultKey(room.code, match.id)));
  // Uma confirmação isolada de P×P ainda não é placar final e nunca pode fechar a fase.
  if (privateResults.some(result => !result || !Number.isInteger(result.homeScore) || !Number.isInteger(result.awayScore))) return false;

  const completedMatches = state.matches.map((match, index) => {
    const result = Object.assign({}, privateResults[index]);
    const winner = result.winner || (result.homeScore > result.awayScore ? match.home
      : result.awayScore > result.homeScore ? match.away : tournamentTieBreakWinner(Object.assign({}, match, { result })));
    return Object.assign({}, match, {
      status: "completed",
      result: {
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        source: result.source || "player_reports",
        completedAt: result.completedAt || Date.now()
      },
      winner
    });
  });

  const completedPhase = {
    phase: state.phase,
    matches: completedMatches,
    completedAt: Date.now()
  };
  const history = (Array.isArray(state.completedPhases) ? state.completedPhases : []).concat([completedPhase]);
  const winners = completedMatches.map(match => match.winner);
  state.phaseStatus = "completed";
  state.matches = completedMatches;
  state.completedPhases = history;
  state.updatedAt = Date.now();
  state.champion = winners.length === 1 ? winners[0] : null;

  state.matches.forEach(match => tournamentMatchPrivateResults.delete(tournamentPrivateResultKey(room.code, match.id)));

  const nextPhaseByCurrent = { oitavas: "quartas", quartas: "semi", semi: "final", final: null };
  const nextPhase = nextPhaseByCurrent[state.phase] || null;
  if (nextPhase && winners.length > 1) {
    const nextState = buildTournamentMatchState(room, winners, nextPhase);
    nextState.completedPhases = history;
    nextState.version = 2;
    room.tournament.matchState = nextState;
    resolveTournamentAutomaticBots(room);
    // Se a próxima fase for inteiramente BOT×BOT, ela também pode ser resolvida sem expor resultados parciais.
    return completeTournamentPhaseIfReady(room) || (sendRoomUpdate(room), publishTournamentMatchState(room, completedPhase), true);
  }

  state.phaseStatus = "finished";
  state.champion = winners[0] || null;
  room.tournament.status = "finished";
  room.tournament.finishedAt = Date.now();
  room.tournament.champion = state.champion;
  sendRoomUpdate(room);
  publishTournamentMatchState(room, completedPhase);
  broadcastTournamentList();
  return true;
}

function tournamentRoomForSocket(socket, code) {
  const room = rooms.get(normalizeTournamentCode(code));
  if (!room || room.mode !== "tournament") return null;
  if (!room.players.some(player => player.id === socket.id)) return null;
  return room;
}

// ALTERADO AQUI - lista pública e atualizações separadas para participantes e observadores.
function getPublicTournamentList() {
  const now = Date.now();
  // ALTERADO AQUI - remove salas de espera abandonadas; torneios em andamento não expiram por tempo.
  for (const [code, room] of rooms.entries()) {
    if (room.mode !== "tournament" || !room.tournament) continue;
    const createdAt = Number(room.tournament.createdAt || 0);
    if (room.tournament.status === "waiting" && createdAt && now - createdAt > 60 * 60 * 1000) {
      rooms.delete(code);
      io.to(`tournament_observers:${code}`).emit("tournament_room_closed", { code, reason: "A sala antiga expirou por falta de início." });
      continue;
    }
    // ALTERADO AQUI - recupera como encerrado qualquer torneio cujo estado oficial já tenha campeão.
    const officialState = room.tournament.bracketState;
    if (room.tournament.status === "ready" && officialState && String(officialState.champion || "").trim()) {
      room.tournament.status = "finished";
      room.tournament.finishedAt = Number(room.tournament.finishedAt || now);
    }
  }
  return Array.from(rooms.values())
    .filter(room => room.mode === "tournament" && room.tournament && ["waiting", "ready"].includes(room.tournament.status))
    .map(room => ({
      code: room.code,
      hostName: room.players.find(player => player.id === room.hostId)?.name || "Organizador",
      hostClub: room.players.find(player => player.id === room.hostId)?.club || "Clube não definido",
      phase: room.tournament.phase,
      status: room.tournament.status,
      playersCount: room.players.length,
      maxPlayers: room.tournament.humanSlots,
      bracketSlots: room.tournament.bracketSlots,
      createdAt: room.tournament.createdAt
    }));
}

function broadcastTournamentList() {
  io.emit("tournament_rooms_list", getPublicTournamentList());
}

function sendRoomUpdate(room) {
  const publicRoom = getPublicRoom(room);
  io.to(room.code).emit("room_updated", publicRoom);
  // Observadores recebem somente dados da chave/sala; não entram no canal de gameplay.
  if (room.mode === "tournament") {
    io.to(`tournament_observers:${room.code}`).emit("tournament_room_updated", publicRoom);
    broadcastTournamentList();
  }
}

io.on("connection", (socket) => {
  console.log("Jogador conectado:", socket.id);

  socket.on("create_room", (data = {}, callback) => {
    const mode = ["1v1", "tournament", "master_league"].includes(data.mode)
      ? data.mode
      : "1v1";

    const maxPlayers = Math.min(
      16,
      Math.max(2, Number(data.maxPlayers) || 2)
    );

    const code = generateRoomCode();

    const player = {
      id: socket.id,
      playerId: String(data.playerId || socket.id),
      name: String(data.playerName || "Jogador").slice(0, 24),
      isHost: true
    };

    const room = {
      code,
      mode,
      maxPlayers,
      hostId: socket.id,
      players: [player],
      state: null
    };

    rooms.set(code, room);
    socket.join(code);

    const result = {
      success: true,
      room: getPublicRoom(room)
    };

    if (typeof callback === "function") callback(result);

    socket.emit("room_created", result.room);
    console.log("Sala criada:", code, mode);
  });

  socket.on("join_room", (data = {}, callback) => {
    const code = String(data.code || "").toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({ success: false, error: "Sala não encontrada." });
      }
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      if (typeof callback === "function") {
        callback({ success: false, error: "Sala cheia." });
      }
      return;
    }

    if (room.players.some(p => p.playerId === String(data.playerId || ""))) {
      if (typeof callback === "function") {
        callback({ success: false, error: "Jogador já está na sala." });
      }
      return;
    }

    const player = {
      id: socket.id,
      playerId: String(data.playerId || socket.id),
      name: String(data.playerName || "Jogador").slice(0, 24),
      isHost: false
    };

    room.players.push(player);
    socket.join(code);

    const result = {
      success: true,
      room: getPublicRoom(room)
    };

    if (typeof callback === "function") callback(result);

    socket.emit("room_joined", result.room);
    sendRoomUpdate(room);

    console.log("Jogador entrou na sala:", code);
  });

  // ALTERADO AQUI - criação de sala exclusiva do Torneio Multiplayer.
  socket.on("tournament_create_room", (data = {}, callback) => {
    const code = normalizeTournamentCode(data.code);
    const creatorPlayerId = String(data.playerId || socket.id);
    // ALTERADO AQUI - ao criar um novo torneio, remove as salas antigas ainda aguardando do mesmo criador.
    for (const [oldCode, oldRoom] of rooms.entries()) {
      if (oldRoom.mode === "tournament" && oldRoom.tournament &&
          oldRoom.tournament.status === "waiting" &&
          oldRoom.players.some(player => player.isHost && player.playerId === creatorPlayerId)) {
        rooms.delete(oldCode);
        io.to(`tournament_observers:${oldCode}`).emit("tournament_room_closed", {
          code: oldCode,
          reason: "O organizador criou um novo torneio."
        });
      }
    }
    const phase = String(data.phase || "").toLowerCase();
    const bracketSlots = TOURNAMENT_PHASE_SLOTS[phase];
    const humanSlots = Number(data.participants);
    const hostClub = normalizeClub(data.club);
    const botClubs = Array.isArray(data.botClubs)
      ? data.botClubs.map(normalizeClub).filter(Boolean)
      : [];

    if (!/^PF-[A-Z0-9]{6}$/.test(code)) {
      return tournamentReply(callback, { success: false, error: "Código de sala inválido." });
    }
    if (rooms.has(code)) {
      return tournamentReply(callback, { success: false, error: "Este código já está em uso. Gere outro." });
    }
    if (!bracketSlots || ![2, 4, 8, 16].includes(humanSlots) || humanSlots > bracketSlots) {
      return tournamentReply(callback, { success: false, error: "Quantidade de participantes incompatível com a fase." });
    }
    if (!hostClub) {
      return tournamentReply(callback, { success: false, error: "Selecione seu clube antes de criar a sala." });
    }
    if (botClubs.length !== bracketSlots - humanSlots) {
      return tournamentReply(callback, {
        success: false,
        error: `Selecione exatamente ${bracketSlots - humanSlots} clube(s) BOT.`
      });
    }

    const allClubs = [hostClub, ...botClubs];
    if (new Set(allClubs.map(club => club.toLowerCase())).size !== allClubs.length) {
      return tournamentReply(callback, { success: false, error: "Não é possível repetir clubes entre jogador e BOTs." });
    }

    const player = {
      id: socket.id,
      playerId: String(data.playerId || socket.id),
      name: String(data.playerName || "Jogador").slice(0, 24),
      club: hostClub,
      connected: true,
      isHost: true
    };

    const room = {
      code,
      mode: "tournament",
      maxPlayers: humanSlots,
      hostId: socket.id,
      players: [player],
      state: null,
      observers: new Set(),
      tournament: {
        phase,
        bracketSlots,
        humanSlots,
        botClubs,
        status: "waiting",
        createdAt: Date.now()
      }
    };

    rooms.set(code, room);
    socket.join(code);

    const result = { success: true, room: getPublicRoom(room) };
    tournamentReply(callback, result);
    socket.emit("tournament_room_created", result.room);
    sendRoomUpdate(room);
    broadcastTournamentList();
    console.log("Sala de torneio criada:", code, phase, humanSlots);
  });

  // ALTERADO AQUI - entrada em sala de torneio por código PF-XXXXXX.
  socket.on("tournament_join_room", (data = {}, callback) => {
    const code = normalizeTournamentCode(data.code);
    const room = rooms.get(code);

    if (!room || room.mode !== "tournament") {
      return tournamentReply(callback, { success: false, error: "Sala de torneio não encontrada." });
    }
    if (room.tournament.status !== "waiting") {
      return tournamentReply(callback, { success: false, error: "Este torneio já foi iniciado." });
    }
    const playerId = String(data.playerId || socket.id);
    const existingPlayer = room.players.find(player => player.playerId === playerId);
    if (existingPlayer) {
      // ALTERADO AQUI - permite retomar o mesmo perfil se o socket anterior já caiu.
      const oldSocketConnected = io.sockets.sockets.has(existingPlayer.id);
      if (oldSocketConnected) {
        return tournamentReply(callback, { success: false, error: "Este perfil já está conectado a este torneio." });
      }
      const previousSocketId = existingPlayer.id;
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      clearTournamentPresenceTimer(code, playerId);
      delete existingPlayer.disconnectedAt;
      if (room.hostId === previousSocketId) room.hostId = socket.id;
      existingPlayer.name = String(data.playerName || existingPlayer.name || "Jogador").slice(0, 24);
      socket.join(code);
      const resumed = { success: true, room: getPublicRoom(room), reconnected: true };
      tournamentReply(callback, resumed);
      socket.emit("tournament_room_joined", resumed.room);
      sendRoomUpdate(room);
      console.log("Participante reconectado ao torneio:", code, existingPlayer.name);
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      return tournamentReply(callback, { success: false, error: "Todas as vagas de participantes já foram preenchidas." });
    }

    const player = {
      id: socket.id,
      playerId,
      name: String(data.playerName || "Jogador").slice(0, 24),
      club: "",
      connected: true,
      isHost: false
    };

    room.players.push(player);
    socket.join(code);

    const result = { success: true, room: getPublicRoom(room) };
    tournamentReply(callback, result);
    socket.emit("tournament_room_joined", result.room);
    sendRoomUpdate(room);
    console.log("Participante entrou no torneio:", code, player.name);
  });

  // ALTERADO AQUI - lista torneios aguardando participantes para a tela ENTRAR NO TORNEIO.
  socket.on("tournament_list_rooms", (callback) => {
    const list = getPublicTournamentList();
    tournamentReply(callback, { success: true, rooms: list });
    socket.emit("tournament_rooms_list", list);
  });

  // ALTERADO AQUI - observador acompanha somente a sala/chave, sem ocupar vaga de jogador.
  socket.on("tournament_observe_room", (data = {}, callback) => {
    const code = normalizeTournamentCode(data.code);
    const room = rooms.get(code);
    if (!room || room.mode !== "tournament" || !room.tournament || !["waiting", "ready"].includes(room.tournament.status)) {
      return tournamentReply(callback, { success: false, error: "Torneio não encontrado ou já encerrado." });
    }
    const observerChannel = `tournament_observers:${room.code}`;
    socket.join(observerChannel);
    room.observers = room.observers || new Set();
    room.observers.add(socket.id);
    const result = { success: true, room: getPublicRoom(room), observing: true };
    tournamentReply(callback, result);
    socket.emit("tournament_observe_joined", result);
  });

  // ALTERADO AQUI - saída explícita do modo observador.
  socket.on("tournament_stop_observing", (data = {}) => {
    const code = normalizeTournamentCode(data.code);
    const room = rooms.get(code);
    socket.leave(`tournament_observers:${code}`);
    if (room && room.observers) room.observers.delete(socket.id);
  });

  // ALTERADO AQUI - V20.48: presença e tolerância de 3 minutos somente na sala de espera do Torneio Online.
  socket.on("tournament_presence", (data = {}, callback) => {
    const code = normalizeTournamentCode(data.code);
    const room = rooms.get(code);
    const player = room && room.mode === "tournament" && room.players.find(p => p.playerId === String(data.playerId || "") && p.id === socket.id);
    if (!room || !player || room.tournament.status !== "waiting") {
      return tournamentReply(callback, { success: false, error: "Presença não aplicável a esta sala." });
    }
    if (data.state === "background") {
      startTournamentPresenceGrace(room, player, "O participante não retornou em até 3 minutos.");
    } else {
      clearTournamentPresenceTimer(code, player.playerId);
      player.connected = true;
      delete player.disconnectedAt;
    }
    sendRoomUpdate(room);
    tournamentReply(callback, { success: true, room: getPublicRoom(room) });
  });

  // ALTERADO AQUI - V20.48: inatividade confirmada no aparelho encerra a vaga imediatamente.
  socket.on("tournament_leave_inactive", (data = {}, callback) => {
    const code = normalizeTournamentCode(data.code);
    const room = rooms.get(code);
    if (!room || room.mode !== "tournament" || room.tournament.status !== "waiting") {
      return tournamentReply(callback, { success: false, error: "A sala não está aguardando participantes." });
    }
    const index = room.players.findIndex(p => p.id === socket.id && p.playerId === String(data.playerId || ""));
    if (index < 0) return tournamentReply(callback, { success: false, error: "Participante não encontrado." });
    const player = room.players[index];
    clearTournamentPresenceTimer(code, player.playerId);
    room.players.splice(index, 1);
    const wasHost = room.hostId === socket.id;
    if (wasHost && room.players.length) { room.hostId = room.players[0].id; room.players[0].isHost = true; }
    if (!room.players.length) rooms.delete(code);
    else sendRoomUpdate(room);
    broadcastTournamentList();
    tournamentReply(callback, { success: true });
  });

  // ALTERADO AQUI - participante escolhe/atualiza seu clube na sala.
  socket.on("tournament_select_club", (data = {}, callback) => {
    const room = tournamentRoomForSocket(socket, data.code);
    if (!room || room.tournament.status !== "waiting") {
      return tournamentReply(callback, { success: false, error: "Sala indisponível para alterar o clube." });
    }

    const player = room.players.find(item => item.id === socket.id);
    const club = normalizeClub(data.club);
    if (!club) {
      return tournamentReply(callback, { success: false, error: "Selecione um clube válido." });
    }

    const reservedClubs = [
      room.players.filter(item => item.id !== socket.id).map(item => item.club),
      room.tournament.botClubs
    ].flat().filter(Boolean).map(value => value.toLowerCase());

    if (reservedClubs.includes(club.toLowerCase())) {
      return tournamentReply(callback, { success: false, error: "Este clube já foi escolhido por outro participante ou BOT." });
    }

    player.club = club;
    tournamentReply(callback, { success: true, room: getPublicRoom(room) });
    sendRoomUpdate(room);
  });

  // ALTERADO AQUI - início somente quando humanos e clubes estão confirmados.
  socket.on("tournament_start", (data = {}, callback) => {
    // ALTERADO AQUI - Recupera a autoria pelo ID persistente do criador quando o navegador reconecta com um novo Socket ID.
    const code = normalizeTournamentCode(data.code);
    const room = rooms.get(code);
    const playerId = String(data.playerId || "");
    const hostPlayer = room && room.mode === "tournament" && room.players.find(player => player.playerId === playerId && player.isHost);
    if (room && hostPlayer && room.hostId !== socket.id) {
      const previousSocketId = hostPlayer.id;
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket && previousSocket.id !== socket.id) previousSocket.leave(room.code);
      hostPlayer.id = socket.id;
      hostPlayer.connected = true;
      room.hostId = socket.id;
      socket.join(room.code);
    }
    if (!room || room.mode !== "tournament" || room.hostId !== socket.id) {
      return tournamentReply(callback, { success: false, error: "Somente o criador pode iniciar o torneio. Reconecte-se à sala e tente novamente." });
    }
    if (room.tournament.status !== "waiting") {
      return tournamentReply(callback, { success: false, error: "Este torneio já foi iniciado." });
    }
    if (room.players.length !== room.tournament.humanSlots || room.players.some(player => player.connected === false)) {
      return tournamentReply(callback, { success: false, error: "Ainda faltam participantes conectados para preencher a sala." });
    }
    if (room.players.some(player => !player.club)) {
      return tournamentReply(callback, { success: false, error: "Todos os participantes precisam escolher um clube." });
    }

    const selectedClubs = [
      ...room.players.map(player => player.club),
      ...room.tournament.botClubs
    ];
    if (selectedClubs.length !== room.tournament.bracketSlots ||
        new Set(selectedClubs.map(club => club.toLowerCase())).size !== selectedClubs.length) {
      return tournamentReply(callback, { success: false, error: "A lista de clubes do torneio está incompleta ou contém repetidos." });
    }

    // ALTERADO AQUI - recebe e valida um único sorteio aleatório feito pelo criador; todos os celulares recebem a mesma ordem.
    const submittedOrder = Array.isArray(data.bracketOrder) ? data.bracketOrder.map(normalizeClub) : [];
    const expectedKeys = selectedClubs.map(club => club.toLocaleLowerCase("pt-BR")).sort();
    const submittedKeys = submittedOrder.map(club => club.toLocaleLowerCase("pt-BR")).sort();
    if (submittedOrder.length !== room.tournament.bracketSlots || expectedKeys.some((club, index) => club !== submittedKeys[index])) {
      return tournamentReply(callback, { success: false, error: "O sorteio recebido está incompleto ou contém clubes inválidos." });
    }
    room.tournament.bracketOrder = submittedOrder;
    // ALTERADO AQUI - V20.59: o servidor registra cada confronto e identifica sua modalidade.
    // P×P, P×BOT e BOT×BOT são definidos pelos playerIds vinculados aos clubes, nunca pelo navegador.
    room.tournament.matchState = buildTournamentMatchState(room, submittedOrder, room.tournament.phase);
    resolveTournamentAutomaticBots(room);

    room.tournament.status = "ready";
    room.tournament.startedAt = Date.now();
    room.players.forEach(player => clearTournamentPresenceTimer(room.code, player.playerId));
    sendRoomUpdate(room);
    io.to(room.code).emit("tournament_started", getPublicRoom(room));
    // ALTERADO AQUI - V20.60: publica o estado inicial; resultados BOT×BOT permanecem privados até a fase fechar.
    publishTournamentMatchState(room);
    // Se a fase tiver apenas confrontos BOT×BOT, o servidor conclui e avança sem esperar jogadores.
    completeTournamentPhaseIfReady(room);
    tournamentReply(callback, { success: true, room: getPublicRoom(room) });
    console.log("Torneio pronto para chaveamento:", room.code);
  });

  // ALTERADO AQUI - V20.60: recebe resultados por confronto e valida a titularidade do clube.
  socket.on("tournament_match_result_submit", (data = {}, callback) => {
    const room = tournamentRoomForSocket(socket, data.code);
    if (!room || room.tournament.status !== "ready") {
      return tournamentReply(callback, { success: false, error: "Torneio indisponível para registrar resultado." });
    }
    const state = room.tournament.matchState;
    const matchId = String(data.matchId || "");
    const match = state && Array.isArray(state.matches) ? state.matches.find(item => item.id === matchId) : null;
    if (!match || match.status !== "pending") {
      return tournamentReply(callback, { success: false, error: "Confronto não encontrado, já encerrado ou fora da fase atual." });
    }
    const player = room.players.find(item => item.id === socket.id);
    if (!player) return tournamentReply(callback, { success: false, error: "Participante não identificado nesta sala." });
    const playerId = String(player.playerId);
    const isHome = match.homePlayerId && playerId === String(match.homePlayerId);
    const isAway = match.awayPlayerId && playerId === String(match.awayPlayerId);
    if (!isHome && !isAway) {
      return tournamentReply(callback, { success: false, error: "Você não é responsável por nenhum clube deste confronto." });
    }

    const key = tournamentPrivateResultKey(room.code, match.id);
    let privateResult = tournamentMatchPrivateResults.get(key);
    if (match.type === "player_vs_player") {
      const goalsFor = validTournamentGoals(data.goalsFor);
      if (goalsFor === null) return tournamentReply(callback, { success: false, error: "Informe um número válido de gols (0 a 20)." });
      if (!privateResult || !privateResult.submissions) privateResult = { submissions: {}, source: "player_reports" };
      privateResult.submissions[playerId] = goalsFor;
      const homeGoals = privateResult.submissions[String(match.homePlayerId)];
      const awayGoals = privateResult.submissions[String(match.awayPlayerId)];
      if (homeGoals !== undefined && awayGoals !== undefined) {
        privateResult.homeScore = homeGoals;
        privateResult.awayScore = awayGoals;
        privateResult.source = "both_players_reported";
        privateResult.completedAt = Date.now();
        privateResult.winner = homeGoals === awayGoals ? null : (homeGoals > awayGoals ? match.home : match.away);
        tournamentMatchPrivateResults.set(key, privateResult);
      } else {
        tournamentMatchPrivateResults.set(key, privateResult);
        return tournamentReply(callback, { success: true, accepted: true, waitingForOpponent: true, message: "Seu placar foi recebido. Aguardando a confirmação do outro participante." });
      }
    } else if (match.type === "player_vs_bot") {
      const goalsFor = validTournamentGoals(data.goalsFor);
      const goalsAgainst = validTournamentGoals(data.goalsAgainst);
      if (goalsFor === null || goalsAgainst === null) {
        return tournamentReply(callback, { success: false, error: "Informe os dois placares como números válidos (0 a 20)." });
      }
      privateResult = {
        homeScore: isHome ? goalsFor : goalsAgainst,
        awayScore: isHome ? goalsAgainst : goalsFor,
        source: "assigned_player_report",
        completedAt: Date.now()
      };
      privateResult.winner = privateResult.homeScore === privateResult.awayScore ? null
        : (privateResult.homeScore > privateResult.awayScore ? match.home : match.away);
      tournamentMatchPrivateResults.set(key, privateResult);
    } else {
      return tournamentReply(callback, { success: false, error: "Resultados BOT×BOT são calculados exclusivamente pelo servidor." });
    }

    const phaseCompleted = completeTournamentPhaseIfReady(room);
    if (!phaseCompleted) {
      return tournamentReply(callback, { success: true, accepted: true, waitingForPhase: true,
        message: "Resultado recebido em sigilo. A fase só será publicada quando todos os confrontos forem concluídos." });
    }
    return tournamentReply(callback, { success: true, accepted: true, phaseCompleted: true,
      room: getPublicRoom(room), message: "Fase concluída e resultados publicados pelo servidor." });
  });

  // ALTERADO AQUI - V20.58: bloqueia snapshots livres enviados pelo navegador.
  // Os resultados e avanços do Torneio Online serão publicados somente pelo novo fluxo autoritativo do servidor.
  socket.on("tournament_state_update", (data = {}, callback) => {
    const room = tournamentRoomForSocket(socket, data.code);
    if (!room || room.tournament.status !== "ready") {
      return tournamentReply(callback, { success: false, error: "Torneio indisponível para atualizar o chaveamento." });
    }

    // Não aceitar placares, vencedores, campeão ou chaveamento completo fornecidos pelo cliente.
    console.warn("Atualização livre de chaveamento bloqueada:", room.code, "participante", socket.id);
    return tournamentReply(callback, {
      success: false,
      code: "TOURNAMENT_SERVER_AUTHORITY_REQUIRED",
      error: "Atualização de resultados desativada temporariamente. O servidor precisa validar cada partida antes de publicar a fase."
    });
  });

  socket.on("room_state", (data = {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());
    if (!room || room.hostId !== socket.id) return;

    room.state = data.state;
    socket.to(room.code).emit("room_state_updated", room.state);
  });

  socket.on("room_message", (data = {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // ALTERADO AQUI - V20.67: sinalização P×P roteada somente ao adversário oficial do confronto.
    if (data.event === "pf_tournament_game") {
      if (room.mode !== "tournament") return;
      const state = room.tournament && room.tournament.matchState;
      const matchId = String(data.matchId || "");
      const match = state && Array.isArray(state.matches)
        ? state.matches.find(item => String(item.id) === matchId && item.status === "pending")
        : null;
      const targetPlayerId = String(data.targetPlayerId || "");
      const target = room.players.find(p => String(p.playerId) === targetPlayerId && p.connected !== false);
      if (!match || !target || target.playerId === player.playerId) return;
      const senderId = String(player.playerId);
      const homeId = String(match.homePlayerId || "");
      const awayId = String(match.awayPlayerId || "");
      const authorizedPair =
        (senderId === homeId && targetPlayerId === awayId) ||
        (senderId === awayId && targetPlayerId === homeId);
      if (!authorizedPair) return;
      if (Number(data.matchIndex) < 0 || String(data.matchId) !== matchId) return;
      io.to(target.id).emit("room_message", {
        event: "pf_tournament_game",
        payload: data.payload,
        senderPlayerId: senderId,
        recipientPlayerId: targetPlayerId,
        matchIndex: Number(data.matchIndex),
        matchId: matchId
      });
      return;
    }

    socket.to(room.code).emit("room_message", {
      playerId: player.playerId,
      playerName: player.name,
      event: data.event,
      payload: data.payload
    });
  });

  socket.on("leave_room", () => {
    leavePlayerRoom(socket);
  });

  socket.on("disconnect", () => {
    // ALTERADO AQUI - preserva a vaga/perfil de torneio para permitir reconexão do mesmo celular.
    markTournamentPlayerDisconnected(socket);
    leaveObserverRooms(socket);
    leavePlayerRoom(socket);
    console.log("Jogador desconectado:", socket.id);
  });
});

// ALTERADO AQUI - mantém o participante desconectado reservado por enquanto, para reconexão.
function markTournamentPlayerDisconnected(socket) {
  for (const room of rooms.values()) {
    if (room.mode !== "tournament") continue;
    const player = room.players.find(item => item.id === socket.id);
    if (!player) continue;
    startTournamentPresenceGrace(room, player, "O participante não retornou em até 3 minutos.");
    sendRoomUpdate(room);
    broadcastTournamentList();
    return;
  }
}

function leaveObserverRooms(socket) {
  for (const [code, room] of rooms.entries()) {
    if (!room.observers || !room.observers.has(socket.id)) continue;
    room.observers.delete(socket.id);
    socket.leave(`tournament_observers:${code}`);
  }
}

// ALTERADO AQUI - remove jogadores e observadores sem misturar os canais de gameplay.
function leavePlayerRoom(socket) {
  for (const [code, room] of rooms.entries()) {
    if (room.observers && room.observers.has(socket.id)) {
      room.observers.delete(socket.id);
      socket.leave(`tournament_observers:${code}`);
    }

    const index = room.players.findIndex(player => player.id === socket.id);
    if (index === -1) continue;
    if (room.mode === "tournament" && room.players[index].connected === false) {
      sendRoomUpdate(room);
      broadcastTournamentList();
      return;
    }

    const wasHost = room.hostId === socket.id;
    room.players.splice(index, 1);
    socket.leave(code);

    if (room.players.length === 0) {
      // Mantém a sala viva enquanto houver observadores? Não: sem participantes, encerra a sala.
      rooms.delete(code);
      io.to(`tournament_observers:${code}`).emit("tournament_room_closed", {
        code,
        reason: "O torneio foi encerrado porque não há participantes conectados."
      });
      console.log("Sala encerrada:", code);
      broadcastTournamentList();
      return;
    }

    if (wasHost) {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
    }

    sendRoomUpdate(room);
    if (room.mode === "tournament") broadcastTournamentList();
    return;
  }
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PÊNALTI MASTER online na porta ${PORT}`);
});
