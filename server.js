
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
  return {
    code: room.code,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    players: room.players,
    state: room.state
  };
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
