
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

// ALTERADO AQUI - V20.33: valida a sequência de rodadas antes de aceitar um estado oficial.
function validateTournamentBracketSnapshot(snapshot, tournament) {
  if (!snapshot || !Array.isArray(snapshot.matches) || !Array.isArray(snapshot.teams) || !Array.isArray(snapshot.knockoutRounds)) {
    return 'Estado do chaveamento incompleto.';
  }
  const slots = Number(tournament.bracketSlots || 0);
  const phase = String(tournament.phase || '').toLowerCase();
  const expectedSlots = TOURNAMENT_PHASE_SLOTS[phase];
  if (!expectedSlots || slots !== expectedSlots) return 'Fase inicial da sala inválida.';
  const teams = snapshot.teams.map(normalizeClub);
  const expectedTeams = Array.isArray(tournament.bracketOrder) ? tournament.bracketOrder.map(normalizeClub) : [];
  const key = value => value.toLocaleLowerCase('pt-BR');
  if (teams.length !== slots || new Set(teams.map(key)).size !== slots ||
      expectedTeams.length !== slots || teams.map(key).sort().join('|') !== expectedTeams.map(key).sort().join('|')) {
    return 'Os clubes do chaveamento não correspondem aos clubes confirmados na sala.';
  }
  const startIndex = phase === 'oitavas' ? 1 : phase === 'quartas' ? 2 : 3;
  const expectedRounds = 5 - startIndex;
  const rounds = snapshot.knockoutRounds;
  if (!rounds.length || rounds.length > expectedRounds) return 'Quantidade de fases do chaveamento inválida.';
  const resolve = value => {
    if (Number.isInteger(value)) return snapshot.matches[value] || null;
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') return snapshot.matches.find(match => match && String(match.id) === value) || null;
    return null;
  };
  let previousWinners = null;
  for (let ri = 0; ri < rounds.length; ri++) {
    const round = rounds[ri];
    const refs = Array.isArray(round) ? round : (Array.isArray(round && round.matches) ? round.matches : (Array.isArray(round && round.slots) ? round.slots : []));
    const expectedCount = slots / Math.pow(2, ri + 1);
    if (refs.length !== expectedCount) return 'A quantidade de confrontos da fase está incorreta.';
    const matches = refs.map(resolve);
    if (matches.some(match => !match || !normalizeClub(match.a) || !normalizeClub(match.b) || key(match.a) === key(match.b))) {
      return 'Existe confronto vazio ou inválido no chaveamento.';
    }
    const used = matches.flatMap(match => [key(match.a), key(match.b)]);
    if (new Set(used).size !== used.length) return 'Um clube aparece mais de uma vez na mesma fase.';
    for (const match of matches) {
      const winner = normalizeClub(match.winner);
      if (winner && key(winner) !== key(match.a) && key(winner) !== key(match.b)) return 'Um vencedor não pertence ao confronto informado.';
    }
    if (ri === 0) {
      const initial = matches.flatMap(match => [key(match.a), key(match.b)]).sort();
      if (initial.join('|') !== expectedTeams.map(key).sort().join('|')) return 'A fase inicial não contém todos os clubes confirmados.';
    } else {
      if (!previousWinners || previousWinners.some(winner => !winner)) return 'Uma fase futura foi criada antes da conclusão da fase anterior.';
      const expectedPairs = [];
      for (let i = 0; i < previousWinners.length; i += 2) expectedPairs.push([key(previousWinners[i]), key(previousWinners[i + 1])]);
      const actualPairs = matches.map(match => [key(match.a), key(match.b)]);
      if (expectedPairs.length !== actualPairs.length || expectedPairs.some((pair, i) => pair[0] !== actualPairs[i][0] || pair[1] !== actualPairs[i][1])) {
        return 'Os confrontos da nova fase não correspondem aos vencedores da fase anterior.';
      }
    }
    previousWinners = matches.map(match => {
      const winner = normalizeClub(match.winner);
      return winner && (key(winner) === key(match.a) || key(winner) === key(match.b)) ? winner : '';
    });
    if (ri < rounds.length - 1 && previousWinners.some(winner => !winner)) return 'A próxima fase foi aberta antes de todos os resultados.';
  }
  if (snapshot.champion) {
    if (rounds.length !== expectedRounds || !previousWinners || previousWinners.length !== 1 || key(snapshot.champion) !== key(previousWinners[0])) {
      return 'O campeão informado não corresponde à final concluída.';
    }
  }
  return '';
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
  // ALTERADO AQUI - remove salas de espera abandonadas após 30 minutos e torneios iniciados sem atividade após 24 horas.
  for (const [code, room] of rooms.entries()) {
    if (room.mode !== "tournament" || !room.tournament) continue;
    const createdAt = Number(room.tournament.createdAt || 0);
    const lastActivityAt = Number(room.tournament.updatedAt || room.tournament.startedAt || createdAt || 0);
    const waitingExpired = room.tournament.status === "waiting" && createdAt && now - createdAt > 30 * 60 * 1000;
    const readyExpired = room.tournament.status === "ready" && lastActivityAt && now - lastActivityAt > 24 * 60 * 60 * 1000;
    if (waitingExpired || readyExpired) {
      rooms.delete(code);
      io.to(`tournament_observers:${code}`).emit("tournament_room_closed", { code, reason: "Este torneio antigo expirou e foi removido da lista." });
      continue;
    }
    // ALTERADO AQUI - recupera como encerrado qualquer torneio cujo estado oficial já tenha campeão.
    const officialState = room.tournament.bracketState;
    if (room.tournament.status === "ready" && officialState && String(officialState.champion || "").trim()) {
      room.tournament.status = "finished";
      room.tournament.finishedAt = Number(room.tournament.finishedAt || now);
    }
  }
  // ALTERADO AQUI - V20.32: mantém torneios ativos visíveis para OBSERVAR; somente salas aguardando início aceitam ENTRAR.
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

    room.tournament.status = "ready";
    room.tournament.startedAt = Date.now();
    sendRoomUpdate(room);
    io.to(room.code).emit("tournament_started", getPublicRoom(room));
    tournamentReply(callback, { success: true, room: getPublicRoom(room) });
    console.log("Torneio pronto para chaveamento:", room.code);
  });

  // ALTERADO AQUI - V20.20: recebe o resultado do chaveamento de qualquer participante e publica uma revisão oficial única.
  socket.on("tournament_state_update", (data = {}, callback) => {
    const room = tournamentRoomForSocket(socket, data.code);
    if (!room || room.tournament.status !== "ready") {
      return tournamentReply(callback, { success: false, error: "Torneio indisponível para atualizar o chaveamento." });
    }

    const snapshot = data.bracketState;
    const validationError = validateTournamentBracketSnapshot(snapshot, room.tournament);
    if (validationError) {
      return tournamentReply(callback, { success: false, error: validationError });
    }

    // ALTERADO AQUI - V20.33: impede que dois celulares publiquem sobre uma revisão antiga.
    const previousRevision = Number(room.tournament.bracketRevision || 0);
    if (data.baseRevision != null && Number(data.baseRevision) !== previousRevision) {
      return tournamentReply(callback, { success: false, error: "O chaveamento foi atualizado em outro aparelho. Aguarde a sincronização e tente novamente.", revision: previousRevision });
    }
    const revision = previousRevision + 1;
    room.tournament.bracketState = snapshot;
    room.tournament.bracketRevision = revision;
    room.tournament.lastResultBy = room.players.find(player => player.id === socket.id)?.playerId || "participant";
    room.tournament.updatedAt = Date.now();
    // ALTERADO AQUI - encerra oficialmente a sala assim que o campeão é publicado no estado sincronizado.
    if (String(snapshot.champion || "").trim()) {
      room.tournament.status = "finished";
      room.tournament.finishedAt = room.tournament.updatedAt;
    }

    const update = {
      code: room.code,
      revision,
      bracketState: room.tournament.bracketState,
      updatedAt: room.tournament.updatedAt
    };
    io.to(room.code).emit("tournament_state_updated", update);
    io.to(`tournament_observers:${room.code}`).emit("tournament_state_updated", update);
    sendRoomUpdate(room);
    tournamentReply(callback, { success: true, revision });
    console.log("Chaveamento atualizado:", room.code, "revisão", revision);
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
    player.connected = false;
    player.disconnectedAt = Date.now();
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
