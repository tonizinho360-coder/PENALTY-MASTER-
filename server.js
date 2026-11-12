'use strict';

// Núcleo paralelo Colyseus. Não substitui nem altera o servidor Socket.IO atual.
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Room } = require('colyseus');
const {
  createRoomAuthority, addGuest, assignClub, lockClubs, bindMatch,
  authorizeCommand, snapshot, hashSecret, safeEqualHex
} = require('./authority');

const PORT = Number(process.env.PORT || 2567);
const SIGNING_SECRET = process.env.PF_COLYSEUS_SECRET;
if (!SIGNING_SECRET || SIGNING_SECRET.length < 32) {
  throw new Error('Defina PF_COLYSEUS_SECRET com pelo menos 32 caracteres.');
}

const app = express();
app.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
const httpServer = http.createServer(app);
const server = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
const roomRegistry = new Map();
const colyseusRooms = new Map();
const bridgeNonces = new Map();
const BRIDGE_SECRET = process.env.PF_BRIDGE_SECRET;

function signTicket(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SIGNING_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verifyTicket(token) {
  if (typeof token !== 'string' || token.length > 2048) throw new Error('Credencial inválida.');
  const [body, mac] = token.split('.');
  if (!body || !mac) throw new Error('Credencial inválida.');
  const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(body).digest();
  let supplied;
  try { supplied = Buffer.from(mac, 'base64url'); } catch { throw new Error('Credencial inválida.'); }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new Error('Credencial inválida.');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!data.exp || data.exp < Date.now()) throw new Error('Credencial expirada.');
  return data;
}
function issueTicket(roomId, playerId, role) {
  return signTicket({ roomId, playerId, role, exp: Date.now() + 24 * 60 * 60 * 1000 });
}
function newId() { return crypto.randomUUID(); }
function newSecret() { return crypto.randomBytes(32).toString('base64url'); }


function verifyBridgeRequest(req, rawBody) {
  if (!BRIDGE_SECRET || BRIDGE_SECRET.length < 32) throw new Error('PF_BRIDGE_SECRET não configurado.');
  const timestamp = String(req.get('x-pf-timestamp') || '');
  const nonce = String(req.get('x-pf-nonce') || '');
  const signature = String(req.get('x-pf-signature') || '');
  const time = Number(timestamp);
  if (!Number.isSafeInteger(time) || Math.abs(Date.now() - time) > 60_000) throw new Error('Assinatura expirada.');
  if (!/^[a-f0-9-]{20,80}$/i.test(nonce) || bridgeNonces.has(nonce)) throw new Error('Requisição repetida ou nonce inválido.');
  const expected = crypto.createHmac('sha256', BRIDGE_SECRET).update(`${timestamp}.${nonce}.${rawBody}`).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'hex'); } catch { throw new Error('Assinatura inválida.'); }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new Error('Assinatura inválida.');
  bridgeNonces.set(nonce, Date.now());
  for (const [key, created] of bridgeNonces) if (Date.now() - created > 120_000) bridgeNonces.delete(key);
}

function authorityFromLegacyRoom(room) {
  if (!room || room.mode !== 'tournament' || !room.tournament) throw new Error('Snapshot não é de um torneio.');
  const t = room.tournament;
  const maxPlayers = Number(t.humanSlots || room.maxPlayers);
  if (![2, 4, 8, 16].includes(maxPlayers) || !Array.isArray(room.players) || room.players.length > maxPlayers) throw new Error('Participantes do snapshot inválidos.');
  const players = room.players;
  const host = players.find(p => p.isHost);
  if (!host || !host.playerId) throw new Error('Criador do torneio não identificado.');
  // A lista autorizada vem do estado validado pelo Socket.IO: clubes humanos já escolhidos + clubes BOT.
  const clubs = players.map(p => String(p.club || '').trim()).filter(Boolean);
  const botClubs = Array.isArray(t.botClubs) ? t.botClubs.map(value => String(value || '').trim()).filter(Boolean) : [];
  const allowedClubs = [...clubs, ...botClubs];
  const authority = createRoomAuthority({ roomId: String(room.code), hostPlayerId: String(host.playerId), hostName: host.name, inviteHash: hashSecret(`bridge:${room.code}`), maxPlayers, allowedClubs });
  for (const p of players) {
    if (String(p.playerId) !== String(host.playerId)) addGuest(authority, { playerId: String(p.playerId), name: p.name });
    if (p.club) assignClub(authority, { playerId: String(p.playerId), club: p.club });
    const record = authority.players.get(String(p.playerId));
    record.connected = p.connected !== false;
  }
  if (t.status === 'ready' || t.status === 'finished') lockClubs(authority);
  authority.legacy = {
    code: String(room.code), phase: String(t.phase || ''), status: String(t.status || ''),
    bracketSlots: Number(t.bracketSlots || 0), humanSlots: maxPlayers,
    botClubs: Array.isArray(t.botClubs) ? t.botClubs.slice() : [],
    bracketOrder: Array.isArray(t.bracketOrder) ? t.bracketOrder.slice() : [],
    bracketState: t.bracketState || null, bracketRevision: Number(t.bracketRevision || 0)
  };
  const active = t.activeMatches && typeof t.activeMatches === 'object' ? t.activeMatches : {};
  for (const item of Object.values(active)) {
    if (!item || !item.matchId || !item.players || Object.keys(item.players).length !== 2) continue;
    const ids = Object.keys(item.players);
    const a = authority.players.get(ids[0]), b = authority.players.get(ids[1]);
    if (!a || !b) continue;
    bindMatch(authority, { playerId: ids[0], club: a.club, opponentPlayerId: ids[1], opponentClub: b.club, matchId: item.matchId, matchHostClub: item.matchHostClub });
    bindMatch(authority, { playerId: ids[1], club: b.club, opponentPlayerId: ids[0], opponentClub: a.club, matchId: item.matchId, matchHostClub: item.matchHostClub });
  }
  return authority;
}

app.post('/internal/bridge/tournament/sync', async (req, res) => {
  try {
    const raw = String(req.rawBody || '');
    verifyBridgeRequest(req, raw);
    const payload = JSON.parse(raw);
    const legacyRoom = payload.room;
    const incomingAuthority = authorityFromLegacyRoom(legacyRoom);
    const roomId = incomingAuthority.roomId;
    const currentAuthority = roomRegistry.get(roomId);
    let authority = incomingAuthority;
    if (currentAuthority) {
      // Mantém a mesma referência usada pela instância Colyseus já criada.
      currentAuthority.inviteHash = incomingAuthority.inviteHash;
      currentAuthority.maxPlayers = incomingAuthority.maxPlayers;
      currentAuthority.allowedClubs = incomingAuthority.allowedClubs;
      currentAuthority.phase = incomingAuthority.phase;
      currentAuthority.revision = incomingAuthority.revision;
      currentAuthority.players = incomingAuthority.players;
      currentAuthority.matches = incomingAuthority.matches;
      currentAuthority.legacy = incomingAuthority.legacy;
      authority = currentAuthority;
    } else {
      roomRegistry.set(roomId, authority);
    }
    if (!colyseusRooms.has(roomId)) {
      const created = await server.create('penalty_tournament', { roomId });
      colyseusRooms.set(roomId, created.roomId);
    }
    const connections = [...authority.players.values()].map(player => ({
      playerId: player.playerId, role: player.role,
      ticket: issueTicket(roomId, player.playerId, player.role)
    }));
    res.json({ success: true, endpoint: process.env.PF_COLYSEUS_PUBLIC_URL || null, roomId, colyseusRoomId: colyseusRooms.get(roomId), revision: authority.revision, connections });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

app.get('/health', (_req, res) => res.json({ status: 'online', service: 'penalty-fever-colyseus-pilot', rooms: roomRegistry.size }));

app.post('/api/rooms', (req, res) => {
  const roomId = newId();
  const playerId = newId();
  const inviteSecret = newSecret();
  const inviteHash = hashSecret(inviteSecret);
  const maxPlayers = Number(req.body?.maxPlayers || 2);
  let allowedClubs;
  try {
    allowedClubs = req.body?.allowedClubs;
    const authorityCheck = createRoomAuthority({ roomId, hostPlayerId: playerId, hostName: req.body?.name, inviteHash, maxPlayers, allowedClubs });
    roomRegistry.set(roomId, authorityCheck);
  } catch (error) { return res.status(400).json({ error: error.message }); }
  const authority = roomRegistry.get(roomId);
  roomRegistry.set(roomId, authority);
  const ticket = issueTicket(roomId, playerId, 'host');
  res.status(201).json({ roomId, playerId, role: 'host', ticket, inviteSecret, protocol: 'pf-colyseus-pilot-v1' });
});

app.post('/api/rooms/join', (req, res) => {
  const { roomId, inviteSecret, name } = req.body || {};
  const authority = roomRegistry.get(String(roomId || ''));
  if (!authority || !safeEqualHex(authority.inviteHash, hashSecret(inviteSecret || ''))) {
    return res.status(403).json({ error: 'Convite inválido.' });
  }
  try {
    const playerId = newId();
    addGuest(authority, { playerId, name });
    res.status(201).json({ roomId, playerId, role: 'guest', ticket: issueTicket(roomId, playerId, 'guest'), protocol: 'pf-colyseus-pilot-v1' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});

class PenaltyTournamentRoom extends Room {
  onCreate(options) {
    this.authority = roomRegistry.get(String(options.roomId || ''));
    if (!this.authority) throw new Error('Sala de autoridade não encontrada.');
    this.maxClients = this.authority.maxPlayers;
    this.setMetadata({ roomId: this.authority.roomId, protocol: 'pf-colyseus-pilot-v1' });
    this.onMessage('club:assign', (client, data = {}) => {
      try {
        const identity = client.auth;
        const result = assignClub(this.authority, { playerId: identity.playerId, club: data.club });
        this.broadcast('authority:snapshot', snapshot(this.authority));
        client.send('club:assigned', result);
      } catch (error) { client.send('authority:error', { message: error.message }); }
    });
    this.onMessage('match:lock', (client) => {
      try {
        if (client.auth.role !== 'host') throw new Error('Somente o criador pode iniciar o confronto.');
        const state = lockClubs(this.authority);
        this.broadcast('authority:snapshot', state);
      } catch (error) { client.send('authority:error', { message: error.message }); }
    });
    this.onMessage('match:bind', (client, data = {}) => {
      try {
        const result = bindMatch(this.authority, {
          playerId: client.auth.playerId, club: data.club,
          opponentPlayerId: data.opponentPlayerId, opponentClub: data.opponentClub,
          matchId: data.matchId, matchHostClub: data.matchHostClub
        });
        client.send('match:bound', result);
        if (result.ready) this.broadcast('match:ready', { matchId: result.matchId });
      } catch (error) { client.send('authority:error', { message: error.message }); }
    });
    this.onMessage('game:command', (client, data = {}) => {
      try {
        const identity = authorizeCommand(this.authority, {
          playerId: client.auth.playerId,
          club: data.club,
          matchId: data.matchId
        });
        // O piloto apenas valida identidade/propriedade; o protocolo de gameplay V20.41 será ligado numa etapa posterior.
        this.broadcast('game:authorized', { sender: identity, commandType: String(data.type || '').slice(0, 40) }, { except: client });
      } catch (error) { client.send('authority:error', { message: error.message }); }
    });
  }
  async onAuth(_client, options) {
    const ticket = verifyTicket(options?.ticket);
    if (ticket.roomId !== this.authority.roomId) throw new Error('Credencial pertence a outra sala.');
    const player = this.authority.players.get(ticket.playerId);
    if (!player || player.role !== ticket.role) throw new Error('Identidade não autorizada nesta sala.');
    return { roomId: ticket.roomId, playerId: ticket.playerId, role: ticket.role };
  }
  onJoin(client) {
    const player = this.authority.players.get(client.auth.playerId);
    player.connected = true;
    client.send('authority:snapshot', snapshot(this.authority));
  }
  async onDrop(client) {
    const player = this.authority.players.get(client.auth.playerId);
    if (player) player.connected = false;
    try { await this.allowReconnection(client, 90); }
    catch { /* O vínculo de clube continua reservado durante a vida da sala. */ }
  }
  onReconnect(client) {
    const player = this.authority.players.get(client.auth.playerId);
    if (player) player.connected = true;
    this.broadcast('authority:snapshot', snapshot(this.authority));
  }
}

server.define('penalty_tournament', PenaltyTournamentRoom);

httpServer.listen(PORT, () => console.log(`PENALTY FEVER Colyseus piloto ativo na porta ${PORT}`));
