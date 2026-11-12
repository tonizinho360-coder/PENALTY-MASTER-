'use strict';

const crypto = require('node:crypto');

function signBridgeBody(rawBody, secret, now = Date.now(), nonce = crypto.randomUUID()) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('PF_BRIDGE_SECRET precisa ter pelo menos 32 caracteres.');
  const timestamp = String(now);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
  return { timestamp, nonce, signature };
}

function createLegacyRoomSnapshot(room) {
  if (!room || room.mode !== 'tournament' || !room.tournament) throw new Error('Sala de torneio inválida.');
  return {
    code: String(room.code), mode: room.mode, maxPlayers: Number(room.maxPlayers),
    players: room.players.map(p => ({
      playerId: String(p.playerId), name: String(p.name || 'Jogador'), club: String(p.club || ''),
      isHost: !!p.isHost, connected: p.connected !== false
    })),
    tournament: {
      phase: room.tournament.phase, bracketSlots: room.tournament.bracketSlots,
      humanSlots: room.tournament.humanSlots, botClubs: room.tournament.botClubs || [],
      status: room.tournament.status, bracketOrder: room.tournament.bracketOrder || [],
      bracketState: room.tournament.bracketState || null,
      bracketRevision: room.tournament.bracketRevision || 0,
      activeMatches: room.tournament.activeMatches || {}
    }
  };
}

async function syncTournamentRoom(room, { baseUrl, secret, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch não está disponível neste Node.js.');
  const body = JSON.stringify({ room: createLegacyRoomSnapshot(room) });
  const auth = signBridgeBody(body, secret);
  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/internal/bridge/tournament/sync`, {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-pf-timestamp': auth.timestamp,
      'x-pf-nonce': auth.nonce, 'x-pf-signature': auth.signature
    }, body
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || `Ponte Colyseus respondeu HTTP ${response.status}.`);
  return result;
}

function deliverColyseusCredentials(io, room, bridgeResult) {
  const byPlayer = new Map((bridgeResult.connections || []).map(item => [String(item.playerId), item]));
  for (const player of room.players) {
    const credential = byPlayer.get(String(player.playerId));
    if (credential && player.id) io.to(player.id).emit('pf_colyseus_credentials', {
      endpoint: bridgeResult.endpoint || null,
      roomId: bridgeResult.roomId,
      colyseusRoomId: bridgeResult.colyseusRoomId,
      playerId: credential.playerId,
      role: credential.role,
      ticket: credential.ticket
    });
  }
}

module.exports = { signBridgeBody, createLegacyRoomSnapshot, syncTournamentRoom, deliverColyseusCredentials };
