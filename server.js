
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
  return String(value || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").trim();
}

function normalizeClub(value) {
  return String(value || "").trim().slice(0, 80);
}

function tournamentRoomForSocket(socket, code) {
  const room = rooms.get(normalizeTournamentCode(code));
  if (!room || room.mode !== "tournament") return null;
  if (!room.players.some(player => player.id === socket.id)) return null;
  return room;
}

function sendRoomUpdate(room) {
  io.to(room.code).emit("room_updated", getPublicRoom(room));
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
      isHost: true
    };

    const room = {
      code,
      mode: "tournament",
      maxPlayers: humanSlots,
      hostId: socket.id,
      players: [player],
      state: null,
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
    if (room.players.length >= room.maxPlayers) {
      return tournamentReply(callback, { success: false, error: "Todas as vagas de participantes já foram preenchidas." });
    }

    const playerId = String(data.playerId || socket.id);
    if (room.players.some(player => player.playerId === playerId)) {
      return tournamentReply(callback, { success: false, error: "Este perfil já está nesta sala." });
    }

    const player = {
      id: socket.id,
      playerId,
      name: String(data.playerName || "Jogador").slice(0, 24),
      club: "",
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
    const room = tournamentRoomForSocket(socket, data.code);
    if (!room || room.hostId !== socket.id) {
      return tournamentReply(callback, { success: false, error: "Somente o criador pode iniciar o torneio." });
    }
    if (room.tournament.status !== "waiting") {
      return tournamentReply(callback, { success: false, error: "Este torneio já foi iniciado." });
    }
    if (room.players.length !== room.tournament.humanSlots) {
      return tournamentReply(callback, { success: false, error: "Ainda faltam participantes humanos para preencher a sala." });
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

    room.tournament.status = "ready";
    room.tournament.startedAt = Date.now();
    sendRoomUpdate(room);
    io.to(room.code).emit("tournament_started", getPublicRoom(room));
    tournamentReply(callback, { success: true, room: getPublicRoom(room) });
    console.log("Torneio pronto para chaveamento:", room.code);
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
    leavePlayerRoom(socket);
    console.log("Jogador desconectado:", socket.id);
  });
});

function leavePlayerRoom(socket) {
  for (const [code, room] of rooms.entries()) {
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index === -1) continue;

    room.players.splice(index, 1);
    socket.leave(code);

    if (room.players.length === 0) {
      rooms.delete(code);
      console.log("Sala encerrada:", code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
    }

    sendRoomUpdate(room);
    return;
  }
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PÊNALTI MASTER online na porta ${PORT}`);
});
