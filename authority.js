'use strict';

const crypto = require('node:crypto');

function normalizeClub(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}
function uniqueClubs(values) {
  if (!Array.isArray(values)) throw new Error('Lista de clubes inválida.');
  const out = [], seen = new Set();
  for (const raw of values) {
    const name = String(raw ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    const key = normalizeClub(name);
    if (!key || seen.has(key)) throw new Error('A lista de clubes contém nome vazio ou repetido.');
    seen.add(key); out.push(name);
  }
  return out;
}
function createRoomAuthority({ roomId, hostPlayerId, hostName, inviteHash, maxPlayers = 2, allowedClubs = [] }) {
  if (!roomId || !hostPlayerId || !inviteHash) throw new Error('Dados iniciais da sala incompletos.');
  if (![2, 4, 8, 16].includes(Number(maxPlayers))) throw new Error('O torneio deve ter 2, 4, 8 ou 16 participantes humanos.');
  const roster = uniqueClubs(allowedClubs);
  return {
    roomId, inviteHash, maxPlayers: Number(maxPlayers), allowedClubs: roster,
    phase: 'lobby', revision: 0,
    players: new Map([[hostPlayerId, { playerId: hostPlayerId, name: String(hostName || 'Jogador 1').slice(0, 32), role: 'host', club: null, connected: false }]]),
    matches: new Map()
  };
}
function addGuest(authority, { playerId, name }) {
  if (authority.phase !== 'lobby') throw new Error('A sala já iniciou.');
  if (authority.players.size >= authority.maxPlayers) throw new Error('Todas as vagas de participantes foram preenchidas.');
  if (!playerId || authority.players.has(playerId)) throw new Error('Identidade inválida.');
  authority.players.set(playerId, { playerId, name: String(name || `Jogador ${authority.players.size + 1}`).slice(0, 32), role: 'guest', club: null, connected: false });
}
function assignClub(authority, { playerId, club }) {
  if (authority.phase !== 'lobby') throw new Error('Clubes bloqueados após o início.');
  const player = authority.players.get(playerId);
  if (!player) throw new Error('Participante não pertence à sala.');
  const normalized = normalizeClub(club);
  if (!normalized || !authority.allowedClubs.some(c => normalizeClub(c) === normalized)) throw new Error('Clube não autorizado para este torneio.');
  const owner = [...authority.players.values()].find(p => p.playerId !== playerId && normalizeClub(p.club) === normalized);
  if (owner) throw new Error('Este clube já pertence a outro participante.');
  player.club = authority.allowedClubs.find(c => normalizeClub(c) === normalized);
  authority.revision++;
  return { playerId: player.playerId, club: player.club, revision: authority.revision };
}
function lockClubs(authority) {
  if (authority.players.size !== authority.maxPlayers) throw new Error(`São necessários ${authority.maxPlayers} participantes.`);
  const players = [...authority.players.values()];
  if (players.some(p => !p.club)) throw new Error('Cada participante precisa confirmar seu clube.');
  if (new Set(players.map(p => normalizeClub(p.club))).size !== players.length) throw new Error('Os clubes precisam ser diferentes.');
  authority.phase = 'ready'; authority.revision++;
  return snapshot(authority);
}
function bindMatch(authority, { playerId, club, opponentPlayerId, opponentClub, matchId, matchHostClub }) {
  if (!['ready', 'playing'].includes(authority.phase)) throw new Error('Torneio ainda não foi iniciado.');
  const player = authority.players.get(playerId), opponent = authority.players.get(opponentPlayerId);
  const key = normalizeClub;
  if (!player || !opponent || playerId === opponentPlayerId || key(player.club) !== key(club) || key(opponent.club) !== key(opponentClub)) throw new Error('Participantes ou clubes não correspondem às identidades confirmadas.');
  if (!matchId || String(matchId).length > 100) throw new Error('Identificador de confronto inválido.');
  const hostKey = key(matchHostClub);
  if (![key(player.club), key(opponent.club)].includes(hostKey)) throw new Error('Lado inicial do confronto inválido.');
  let binding = authority.matches.get(String(matchId));
  if (!binding) binding = { matchId: String(matchId), matchHostClub: hostKey, players: new Map() };
  if (binding.matchHostClub !== hostKey) throw new Error('Os participantes informaram lados diferentes para o confronto.');
  const previous = binding.players.get(playerId);
  if (previous && (previous.club !== key(player.club) || previous.opponentPlayerId !== opponentPlayerId)) throw new Error('Vínculo deste participante já foi definido de outra forma.');
  binding.players.set(playerId, { club: key(player.club), opponentPlayerId, opponentClub: key(opponent.club) });
  if (binding.players.size > 2) throw new Error('Confronto excedeu o limite de dois participantes.');
  authority.matches.set(String(matchId), binding); authority.revision++;
  return { matchId: String(matchId), ready: binding.players.size === 2, revision: authority.revision };
}
function authorizeCommand(authority, { playerId, club, matchId }) {
  if (!['ready', 'playing'].includes(authority.phase)) throw new Error('Partida não autorizada.');
  const player = authority.players.get(playerId);
  if (!player || normalizeClub(player.club) !== normalizeClub(club)) throw new Error('Comando rejeitado: clube não pertence a esta identidade.');
  if (!matchId) throw new Error('Confronto não informado.');
  const binding = authority.matches.get(String(matchId));
  const bound = binding && binding.players.get(playerId);
  if (!bound || binding.players.size !== 2 || bound.club !== normalizeClub(club)) throw new Error('Confronto não confirmado pelos dois participantes.');
  return { playerId: player.playerId, club: player.club, role: player.role, matchId: binding.matchId };
}
function snapshot(authority) {
  return { roomId: authority.roomId, phase: authority.phase, revision: authority.revision, maxPlayers: authority.maxPlayers,
    players: [...authority.players.values()].map(p => ({ playerId: p.playerId, name: p.name, role: p.role, club: p.club, connected: p.connected })) };
}
function hashSecret(secret) { return crypto.createHash('sha256').update(String(secret)).digest('hex'); }
function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(String(a)) || !/^[a-f0-9]{64}$/i.test(String(b))) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
module.exports = { normalizeClub, createRoomAuthority, addGuest, assignClub, lockClubs, bindMatch, authorizeCommand, snapshot, hashSecret, safeEqualHex };
