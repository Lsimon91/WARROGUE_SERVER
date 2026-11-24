'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Carga opcional de .env sin dependencia externa. Las variables del proceso prevalecen.
const LOCAL_ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(LOCAL_ENV_FILE)) {
  for (const line of fs.readFileSync(LOCAL_ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

const WebSocket = require('ws');

const { GameEngine } = require('./game-engine');
const { BotManager } = require('./bot-manager');
const { GameLoop } = require('./game-loop');
const { Persistence } = require('./persistence');


const persistence = new Persistence();

const PORT = Number(process.env.PORT || 8080);
const WSS_PORT = Number(process.env.WSS_PORT || 8443);

const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);

const IDLE_MS =
  Number(process.env.ROOM_IDLE_MINUTES || 30) * 60000;

const HEARTBEAT_MS =
  Number(process.env.HEARTBEAT_INTERVAL_MS || 25000);

const RATE_LIMIT_PER_SEC =
  Number(process.env.RATE_LIMIT_PER_SEC || 60);

const BOT_WAIT_MS =
  Number(process.env.BOT_WAIT_MS || 10000);

const AUTO_BOT_ARENA =
  String(process.env.AUTO_BOT_ARENA ?? 'true').toLowerCase() !== 'false';

const MAX_PLAYERS = 8;

const rooms = new Map();
const clients = new Map();

const now = () => Date.now();

const id = (n = 8) =>
  crypto.randomBytes(n).toString('hex');

const safeName = value =>
  String(value || 'Jugador')
    .replace(/[<>\\\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 20) || 'Jugador';

const safePlatform = value => {
  const platform = String(value || 'web').toLowerCase();

  if (
    platform === 'android' ||
    platform === 'warrogue-android'
  ) {
    return 'android';
  }

  if (
    platform === 'web' ||
    platform === 'browser' ||
    platform === 'desktop'
  ) {
    return 'web';
  }

  return 'web';
};

const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_PER_IP = 40;
const AUTH_MAX_PER_ACCOUNT_IP = 8;

function allowAuthAttempt(req, email) {
  const trustedProxy = String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';
  const forwarded = trustedProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = String(forwarded || req.socket?.remoteAddress || 'unknown').slice(0, 80);
  const identity = crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 24);
  const keys = [`ip:${ip}`, `account:${ip}:${identity}`];
  const t = now();
  for (const [key, state] of authAttempts) {
    if (t - state.startedAt >= AUTH_WINDOW_MS) authAttempts.delete(key);
  }
  const limits = [AUTH_MAX_PER_IP, AUTH_MAX_PER_ACCOUNT_IP];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let state = authAttempts.get(key);
    if (!state || t - state.startedAt >= AUTH_WINDOW_MS) {
      state = { startedAt: t, count: 0 };
      authAttempts.set(key, state);
    }
    if (state.count >= limits[i]) return false;
  }
  for (const key of keys) authAttempts.get(key).count++;
  return true;
}

const send = (ws, obj) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      console.error(
        'Error enviando mensaje:',
        e.message
      );
    }
  }

  return false;
};

const error = (ws, code, message) =>
  send(ws, {
    type: 'error',
    code,
    message
  });

function roomPublic(r) {
  const players = [...r.players.values()];

  return {
    roomId: r.id,
    name: r.name,

    players: players.length,

    humanPlayers: players.filter(
      p => !p.bot
    ).length,

    botPlayers: players.filter(
      p => p.bot
    ).length,

    maxPlayers: MAX_PLAYERS,
    status: r.status,
    map: r.map,

    createdAt: r.createdAt,
    hasAI: players.some(p => p.bot),
    autonomous: !!r.autonomous
  };
}

/*
 * Broadcast general.
 * Solo debe utilizarse para mensajes que no contengan
 * posiciones, unidades ni estados privados de la partida.
 */
function broadcast(r, obj, except = null) {
  if (!r) return;

  const raw = JSON.stringify(obj);

  for (const p of r.players.values()) {
    if (
      p.ws &&
      p.ws !== except &&
      p.ws.readyState === WebSocket.OPEN
    ) {
      try {
        p.ws.send(raw);
      } catch (e) {
        console.error(
          'Error en broadcast:',
          e.message
        );
      }
    }
  }
}

function publicPlayer(p, hostId) {
  return {
    playerId: p.id,
    id: p.id,

    name: p.name,
    slot: p.slot,

    ready: !!p.ready,
    isHost: p.id === hostId,

    isBot: !!p.bot,
    bot: !!p.bot,

    platform: p.platform || (p.bot ? 'bot' : 'web'),
    device: p.platform || (p.bot ? 'bot' : 'web'),
    clientType: p.platform || (p.bot ? 'bot' : 'web'),

    connected: p.bot || !!p.ws,
    profile: (() => {
      if (p.bot) {
        // Las cifras de IA son agregadas por dificultad, no estadísticas
        // individuales del bot de esta sala. Se etiqueta así en el cliente.
        const ai = persistence.aiProfile(p.difficulty || 'normal');
        const matches = Math.max(0, Number(ai.matches) || 0);
        const wins = Math.max(0, Number(ai.wins) || 0);
        const losses = Math.max(0, Number(ai.losses) || 0);
        const kills = Math.max(0, Number(ai.kills) || 0);
        return {
          kind: 'bot_aggregate',
          difficulty: ai.difficulty || p.difficulty || 'normal',
          rank: `IA ${String(ai.difficulty || p.difficulty || 'normal').toUpperCase()}`,
          xp: 0,
          matches,
          wins,
          losses,
          kills,
          bestStreak: 0,
          achievements: [],
          achievementDetails: [],
          winRate: matches ? Math.round(wins * 100 / matches) : 0,
          averageKills: matches ? Number((kills / matches).toFixed(1)) : 0
        };
      }
      const data = p.profileId ? persistence.publicProfile(p.profileId) : null;
      if (!data) return null;
      return {
        kind: 'player',
        name: data.name,
        rank: data.rank,
        xp: data.xp,
        matches: data.matches,
        wins: data.wins,
        losses: data.losses,
        kills: data.kills,
        bestStreak: data.bestStreak,
        achievements: data.achievements,
        achievementDetails: data.achievementDetails,
        winRate: data.winRate
      };
    })()
  };
}

/*
 * Crea una instantánea específica para un jugador.
 *
 * Si la partida está activa, se calcula su estado
 * mediante exportState(playerId).
 *
 * Nunca se entrega el estado global a un cliente.
 */
function snapshot(r, viewerId = null) {
  let gameState = null;

  if (
    r.engine &&
    viewerId &&
    (
      r.status === 'playing' ||
      r.status === 'finished'
    )
  ) {
    try {
      gameState = r.engine.exportState(viewerId);
    } catch (e) {
      console.error(
        'Error creando snapshot filtrado:',
        e.message
      );
    }
  } else if (!r.engine) {
    gameState = null;
  }

  return {
    type: 'room_snapshot',

    room: roomPublic(r),

    roomId: r.id,
    roomCode: r.id,

    hostId: r.hostId,

    players: [...r.players.values()].map(
      p => publicPlayer(p, r.hostId)
    ),

    gameState,

    revision: r.revision
  };
}

/*
 * Envía una instantánea individual a cada jugador.
 */
function broadcastSnapshot(r) {
  if (!r) return;

  for (const p of r.players.values()) {
    if (
      !p.ws ||
      p.ws.readyState !== WebSocket.OPEN
    ) {
      continue;
    }

    send(
      p.ws,
      snapshot(r, p.id)
    );
  }
}

/*
 * Estado inicial filtrado por jugador.
 * El GameLoop se ocupa de las actualizaciones siguientes.
 */
function broadcastInitialGameState(r) {
  if (!r || !r.engine) return;

  for (const p of r.players.values()) {
    if (
      !p.ws ||
      p.ws.readyState !== WebSocket.OPEN
    ) {
      continue;
    }

    try {
      const state = r.engine.exportState(p.id);

      send(p.ws, {
        type: 'game_state',
        roomId: r.id,
        revision: r.revision,
        state,
        serverAuthoritative: true
      });
    } catch (e) {
      console.error(
        'Error enviando estado inicial:',
        p.id,
        e.message
      );
    }
  }

  /*
   * Copia global solo para uso interno del servidor.
   * No se envía mediante room_snapshot.
   */
  try {
    r.gameState = r.engine.exportState();
  } catch (_) {
    r.gameState = null;
  }
}

const bots = new BotManager({
  waitMs: BOT_WAIT_MS,
  learningProvider: difficulty => persistence.aiProfile(difficulty),

  onChange: (r, message) => {
    broadcast(r, message);
    broadcastSnapshot(r);
  }
});

function createRoomObject({
  name,
  map,
  autonomous = false
}) {
  const roomId = id(5).toUpperCase();

  return {
    id: roomId,

    name: safeName(name),
    map: safeName(map || 'default'),

    status: 'lobby',

    hostId: null,

    players: new Map(),

    gameState: null,
    engine: null,

    revision: 0,

    createdAt: now(),
    updatedAt: now(),

    autonomous,

    lastStateBroadcast: 0,
    restartTimer: null
  };
}

/*
 * Inicialización de la simulación.
 * El servidor es la autoridad de la partida.
 */
function startSimulation(r) {
  if (!r || r.status === 'playing') return;

  r.status = 'playing';

  r.engine = new GameEngine(r);

  for (const p of r.players.values()) {
    r.engine.addPlayer(p);
  }

  r.gameState = null;
  r.lastStateBroadcast = 0;

  bots.start(r, r.engine);

  r.revision++;

  broadcast(r, {
    type: 'game_started',

    roomId: r.id,

    players: [...r.players.values()].map(p => ({
      playerId: p.id,
      name: p.name,
      slot: p.slot,

      isBot: !!p.bot,

      platform: p.platform || (p.bot ? 'bot' : 'web')
    })),

    revision: r.revision,

    serverAuthoritative: true
  });

  /*
   * No usar broadcast global para game_state.
   * Cada jugador recibe su propio estado filtrado.
   */
  broadcastInitialGameState(r);

  r.updatedAt = now();
}

/*
 * Entrada de un jugador.
 * Guarda la plataforma para que la web pueda identificar Android.
 */
function join(
  ws,
  r,
  name,
  asHost = false,
  platform = 'web',
  profileId = ''
) {
  if (r.status !== 'lobby') {
    error(
      ws,
      'ROOM_IN_GAME',
      'La partida ya comenzó'
    );

    return null;
  }

  /*
   * Retiramos los bots provisionales antes de comprobar
   * la capacidad de la sala.
   */
  if ([...r.players.values()].some(p => p.bot)) {
    bots.removeBots(r);

    broadcast(r, {
      type: 'bot_removed',
      reason: 'human_joined'
    });
  }

  if (r.players.size >= MAX_PLAYERS) {
    error(
      ws,
      'ROOM_FULL',
      'La sala está completa'
    );

    return null;
  }

  const playerId = id(12);

  const used = new Set(
    [...r.players.values()].map(p => p.slot)
  );

  let slot = 0;

  while (used.has(slot) && slot < MAX_PLAYERS) {
    slot++;
  }

  if (slot >= MAX_PLAYERS) {
    error(
      ws,
      'ROOM_FULL',
      'No quedan posiciones disponibles'
    );

    return null;
  }

  const clientPlatform = safePlatform(platform);

  const p = {
    id: playerId,

    name: safeName(name),
    profileId: String(profileId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),

    slot,

    ready: false,
    bot: false,

    platform: clientPlatform,
    device: clientPlatform,
    clientType: clientPlatform,

    ws
  };

  r.players.set(playerId, p);

  if (p.profileId) persistence.profile(p.profileId, p.name, clientPlatform);

  r.updatedAt = now();

  if (asHost) {
    r.hostId = playerId;
  }

  clients.set(ws, {
    roomId: r.id,
    playerId
  });

  send(ws, {
    type: 'joined',

    playerId,
    roomId: r.id,

    slot,

    isHost: r.hostId === playerId,

    playerName: p.name,

    platform: clientPlatform,
    device: clientPlatform,
    clientType: clientPlatform,

    serverAuthoritative: true
  });

  if (p.profileId) {
    send(ws, {
      type: 'profile_data',
      profile: persistence.publicProfile(p.profileId)
    });
  }

  broadcast(r, {
    type: 'player_joined',

    player: publicPlayer(p, r.hostId)
  }, ws);

  broadcastSnapshot(r);

  if (r.players.size === 1) {
    bots.schedule(r);
  } else {
    bots.cancel(r.id);
  }

  return playerId;
}

/*
 * Salida y desconexión.
 */
function leave(ws) {
  const c = clients.get(ws);

  if (!c) return;

  clients.delete(ws);

  const r = rooms.get(c.roomId);

  if (!r) return;

  const departing = r.players.get(c.playerId);

  r.players.delete(c.playerId);

  if (r.engine) {
    r.engine.removePlayer(c.playerId);
  }

  r.updatedAt = now();

  if (r.hostId === c.playerId) {
    const next = [...r.players.values()].find(
      p => !p.bot
    );

    r.hostId = next ? next.id : null;

    if (next && next.ws) {
      send(next.ws, {
        type: 'host_changed',
        playerId: next.id
      });
    }
  }

  broadcast(r, {
    type: 'player_left',
    playerId: c.playerId,
    players: r.players.size
  });

  const humans = [...r.players.values()].filter(
    p => !p.bot
  );

  /*
   * Si no quedan humanos, la partida puede continuar
   * bajo control de los bots.
   */
  if (!humans.length) {
    if (r.status === 'playing' && r.engine) {
      r.autonomous = true;

      const existing = [...r.players.values()].filter(
        p => p.bot
      );

      while (existing.length < 2) {
        const b = bots.addBot(
          r,
          `IA ${existing.length + 1}`
        );

        if (!b) break;

        existing.push(b);

        r.engine.addPlayer(b);
      }

      bots.start(r, r.engine);

      broadcast(r, {
        type: 'autonomous_match',
        roomId: r.id,
        message: 'La batalla continúa bajo control de las IA.'
      });

      broadcastSnapshot(r);

      r.updatedAt = now();

    } else if (r.players.size > 0) {
      /*
       * Último humano abandona durante el lobby.
       * Las IA pueden tomar la sala.
       */
      bots.cancel(r.id);

      r.autonomous = true;

      let existing = [...r.players.values()].filter(
        p => p.bot
      );

      while (existing.length < 2) {
        const b = bots.addBot(
          r,
          `IA ${existing.length + 1}`
        );

        if (!b) break;

        existing.push(b);
      }

      if (existing.length >= 2) {
        startSimulation(r);
      } else {
        bots.stop(r.id);
        rooms.delete(r.id);
      }

    } else {
      bots.stop(r.id);
      rooms.delete(r.id);
    }

  } else {
    broadcastSnapshot(r);

    if (
      r.status === 'lobby' &&
      humans.length === 1 &&
      ![...r.players.values()].some(p => p.bot)
    ) {
      bots.schedule(r);
    }
  }
}

/*
 * Procesamiento de mensajes WebSocket.
 */
function handle(ws, msg) {
  if (
    !msg ||
    typeof msg !== 'object' ||
    typeof msg.type !== 'string'
  ) {
    return error(
      ws,
      'BAD_MESSAGE',
      'Mensaje inválido'
    );
  }

  if ((msg.type === 'create_room' || msg.type === 'join_room') && !ws.authUser) {
    return error(ws, 'AUTH_REQUIRED', 'Debes iniciar sesión para jugar online');
  }

  const c = clients.get(ws);

  if (msg.type === 'list_rooms') {
    send(ws, {
      type: 'rooms',

      rooms: [...rooms.values()]
        .filter(r => r.status === 'lobby' && !r.autonomous)
        .map(roomPublic)
    });

    return;
  }

  if (msg.type === 'create_room') {
    if (c) {
      return error(
        ws,
        'ALREADY_IN_ROOM',
        'Ya perteneces a una sala'
      );
    }

    if (rooms.size >= MAX_ROOMS) {
      return error(
        ws,
        'SERVER_FULL',
        'Servidor lleno'
      );
    }

    const r = createRoomObject({
      name: msg.name || msg.roomName || 'Partida',
      map: msg.map
    });

    rooms.set(r.id, r);

    r.hostId = join(
      ws,
      r,
      msg.playerName || msg.name,
      true,
      msg.platform || msg.clientType || 'web',
      ws.authUser.profileId
    );

    if (r.hostId) {
      send(ws, {
        type: 'host_assigned',
        playerId: r.hostId
      });
    } else {
      rooms.delete(r.id);
    }

    return;
  }

  if (msg.type === 'join_room') {
    if (c) {
      return error(
        ws,
        'ALREADY_IN_ROOM',
        'Ya perteneces a una sala'
      );
    }

    const roomIdentifier = String(
      msg.roomId ||
      msg.roomCode ||
      msg.code ||
      ''
    ).toUpperCase();

    const r = rooms.get(roomIdentifier);

    if (!r) {
      return error(
        ws,
        'ROOM_NOT_FOUND',
        'Sala no encontrada'
      );
    }

    join(
      ws,
      r,
      msg.playerName || msg.name,
      false,
      msg.platform ||
      msg.clientType ||
      msg.device ||
      'web',
      ws.authUser.profileId
    );

    return;
  }

  if (!c) {
    return error(
      ws,
      'NOT_IN_ROOM',
      'Primero debes entrar en una sala'
    );
  }

  const r = rooms.get(c.roomId);

  const p = r && r.players.get(c.playerId);

  if (!r || !p) {
    return error(
      ws,
      'ROOM_NOT_FOUND',
      'La sala ya no existe'
    );
  }

  r.updatedAt = now();

  if (msg.type === 'leave_room') {
    leave(ws);

    send(ws, {
      type: 'left_room'
    });

    return;
  }

  if (msg.type === 'ready') {
    if (r.status !== 'lobby') return;

    p.ready = !!msg.ready;

    broadcast(r, {
      type: 'player_ready',
      playerId: p.id,
      slot: p.slot,
      ready: p.ready
    });

    broadcastSnapshot(r);

    return;
  }

  if (msg.type === 'start_game') {
    if (r.hostId !== p.id) {
      return error(
        ws,
        'HOST_ONLY',
        'Solo el anfitrión puede iniciar'
      );
    }

    if (r.players.size < 2) {
      return error(
        ws,
        'NEED_PLAYERS',
        'Se necesitan al menos 2 jugadores o esperar al rival IA'
      );
    }

    const notReady = [...r.players.values()].some(
      x => !x.bot &&
        !x.ready &&
        x.id !== r.hostId
    );

    if (notReady) {
      return error(
        ws,
        'NOT_READY',
        'Hay jugadores que no están listos'
      );
    }

    startSimulation(r);

    return;
  }

  if (msg.type === 'command') {
    if (r.status !== 'playing' || !r.engine) {
      return error(
        ws,
        'NOT_IN_GAME',
        'La partida no está activa'
      );
    }

    if (!msg.command || typeof msg.command !== 'object') {
      return error(
        ws,
        'BAD_COMMAND',
        'Orden inválida'
      );
    }

    if (JSON.stringify(msg.command).length > 8000) {
      return error(
        ws,
        'COMMAND_TOO_LARGE',
        'Orden demasiado grande'
      );
    }

    const ok = r.engine.command(
      p.id,
      msg.command
    );

    if (!ok) {
      return error(
        ws,
        'COMMAND_REJECTED',
        r.engine.lastReject || 'Orden no válida o recursos insuficientes'
      );
    }

    /*
     * La orden se anuncia, pero el estado del mapa
     * continúa llegando mediante estados filtrados.
     */
    broadcast(r, {
      type: 'command',
      playerId: p.id,
      slot: p.slot,
      command: msg.command,
      serverTime: now()
    });

    return;
  }

  if (msg.type === 'state_sync') {
    return error(
      ws,
      'SERVER_AUTHORITATIVE',
      'El estado lo simula el servidor; state_sync del cliente está deshabilitado'
    );
  }

  if (msg.type === 'chat') {
    const text = String(
      msg.text || msg.message || ''
    ).trim().slice(0, 300);

    if (text) {
      broadcast(r, {
        type: 'chat',

        playerId: p.id,
        name: p.name,

        text,

        serverTime: now()
      });
    }

    return;
  }

  if (msg.type === 'ping') {
    send(ws, {
      type: 'pong',
      serverTime: now()
    });

    return;
  }

  error(
    ws,
    'UNKNOWN_TYPE',
    'Tipo de mensaje desconocido'
  );
}

/*
 * Servidor web.
 */
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function requestHandler(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(
      String(req.url || '/').split('?')[0]
    );
  } catch (_) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  res.setHeader(
    'Referrer-Policy',
    'strict-origin-when-cross-origin'
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.socket?.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  const sendJson = (status, payload) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(status);
    res.end(JSON.stringify(payload));
  };
  const readJson = () => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > 16384) {
        settled = true;
        reject(Object.assign(new Error('Solicitud demasiado grande'), { code: 'BODY_TOO_LARGE' }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON debe ser un objeto');
        settled = true;
        resolve(body);
      } catch (e) { settled = true; reject(e); }
    });
    req.on('error', e => { if (!settled) { settled = true; reject(e); } });
  });
  if (pathname === '/api/auth/register' || pathname === '/api/auth/login') {
    if (req.method !== 'POST') return sendJson(405, { error: 'Método no permitido' });
    readJson().then(body => {
      const email = String(body.email || '').trim().toLowerCase();
      if (!allowAuthAttempt(req, email)) {
        res.setHeader('Retry-After', '900');
        return sendJson(429, { error: 'Demasiados intentos. Inténtalo más tarde.' });
      }
      const password = String(body.password || '');
      const name = safeName(body.name || email.split('@')[0] || 'Jugador');
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
        return sendJson(400, { error: 'Correo válido y contraseña de 8 a 128 caracteres requeridos' });
      }
      try {
        const account = pathname.endsWith('/register')
          ? persistence.registerAccount(email, password, name)
          : persistence.loginAccount(email, password);
        if (!account) return sendJson(401, { error: 'Correo o contraseña incorrectos' });
        const token = persistence.issueToken(account.id);
        const profile = persistence.profile(account.profileId, account.name, 'android');
        return sendJson(200, { token, profileId: account.profileId, name: account.name, profile: persistence.publicProfile(account.profileId) });
      } catch (e) {
        return sendJson(e.code === 'ACCOUNT_EXISTS' ? 409 : 400, { error: e.message || 'No se pudo crear la cuenta' });
      }
    }).catch(e => sendJson(e.code === 'BODY_TOO_LARGE' ? 413 : 400, {
      error: e.code === 'BODY_TOO_LARGE' ? 'Solicitud demasiado grande' : 'Solicitud JSON inválida'
    }));
    return;
  }
  if (pathname === '/api/auth/me') {
    if (req.method !== 'GET') return sendJson(405, { error: 'Método no permitido' });
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const account = persistence.accountForToken(auth);
    return sendJson(account ? 200 : 401, account ? { profileId: account.profileId, name: account.name, profile: persistence.publicProfile(account.profileId) } : { error: 'Sesión no válida' });
  }
  if (pathname === '/api/auth/logout') {
    if (req.method !== 'POST') return sendJson(405, { error: 'Método no permitido' });
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    persistence.revokeToken(auth);
    return sendJson(200, { ok: true });
  }

  if (pathname === '/api/ai/stats') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    res.end(JSON.stringify({ ai: persistence.aiSummary(), updatedAt: persistence.data.updatedAt || Date.now(), source: 'server' }));
    return;
  }

  if (pathname === '/api/stats') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    res.end(JSON.stringify({ ...persistence.summary(), online: clients.size, rooms: rooms.size }));
    return;
  }

  if (pathname === '/api/leaderboard') {
    const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 50);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    res.end(JSON.stringify({ players: persistence.leaderboard(limit) }));
    return;
  }

  if (pathname.startsWith('/api/profile/')) {
    const profileId = pathname.slice('/api/profile/'.length).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const profile = persistence.publicProfile(profileId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(profile ? 200 : 404);
    res.end(JSON.stringify(profile || { error: 'Perfil no encontrado' }));
    return;
  }

  if (pathname === '/health') {
    res.setHeader(
      'Content-Type',
      'application/json; charset=utf-8'
    );

    res.writeHead(200);

    res.end(JSON.stringify({
      ok: true,

      name: process.env.PUBLIC_SERVER_NAME ||
        'WARROGUE Public Server',

      rooms: rooms.size,
      clients: clients.size,

      maxPlayers: MAX_PLAYERS,

      activeGames: [...rooms.values()].filter(
        r => r.status === 'playing'
      ).length,

      bots: [...rooms.values()].reduce(
        (n, r) => n + [...r.players.values()].filter(
          p => p.bot
        ).length,
        0
      ),

      serverAuthoritative: true,

      uptime: Math.floor(process.uptime())
    }));

    return;
  }

  if (pathname === '/rooms') {
    res.setHeader(
      'Content-Type',
      'application/json; charset=utf-8'
    );

    res.writeHead(200);

    res.end(JSON.stringify({
      rooms: [...rooms.values()]
        .filter(r => r.status === 'lobby' && !r.autonomous)
        .map(roomPublic)
    }));

    return;
  }

  const relative = pathname === '/'
    ? 'index.html'
    : pathname.replace(/^\/+/, '');

  const file = path.resolve(
    PUBLIC_DIR,
    relative
  );

  if (
    file !== PUBLIC_DIR &&
    !file.startsWith(PUBLIC_DIR + path.sep)
  ) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });

      res.end('WARROGUE: recurso no encontrado');
      return;
    }

    const ext = path.extname(file).toLowerCase();

    res.writeHead(200, {
      'Content-Type':
        MIME[ext] || 'application/octet-stream',

      'Cache-Control':
        ext === '.html'
          ? 'no-cache'
          : 'public, max-age=3600'
    });

    fs.createReadStream(file).pipe(res);
  });
}

/*
 * Certificados TLS.
 */
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = process.env.TLS_KEY_FILE
  ? path.resolve(process.env.TLS_KEY_FILE)
  : path.join(CERT_DIR, 'server.key');
const CERT_FILE = process.env.TLS_CERT_FILE
  ? path.resolve(process.env.TLS_CERT_FILE)
  : path.join(CERT_DIR, 'server.crt');

let httpsServer = null;
if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
  httpsServer = https.createServer({
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE)
  }, requestHandler);
} else {
  console.warn('[TLS] Certificado no configurado. HTTPS/WSS directo desactivado; usa un proxy TLS inverso para producción.');
}

const server = http.createServer(requestHandler);
const wss = new WebSocket.Server({ server, maxPayload: 300000 });
const wssSecure = httpsServer
  ? new WebSocket.Server({ server: httpsServer, maxPayload: 300000 })
  : null;
const wsServers = wssSecure ? [wss, wssSecure] : [wss];

/*
 * Conexiones WebSocket.
 */
function handleConnection(ws, req) {
  ws.isAlive = true;
  const headerToken = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const queryToken = (() => { try { return new URL(req?.url || '/', 'http://localhost').searchParams.get('token') || ''; } catch (_) { return ''; } })();
  ws.authUser = persistence.accountForToken(headerToken || queryToken);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.rate = {
    t: now(),
    n: 0
  };

  ws.on('message', data => {
    const t = now();

    if (t - ws.rate.t >= 1000) {
      ws.rate.t = t;
      ws.rate.n = 0;
    }

    if (++ws.rate.n > RATE_LIMIT_PER_SEC) {
      if (ws.rate.n === RATE_LIMIT_PER_SEC + 1) {
        error(
          ws,
          'RATE_LIMIT',
          'Demasiados mensajes por segundo'
        );
      }

      if (ws.rate.n > RATE_LIMIT_PER_SEC * 3) {
        ws.terminate();
      }

      return;
    }

    try {
      handle(
        ws,
        JSON.parse(data.toString())
      );
    } catch (e) {
      console.error(
        'Mensaje rechazado:',
        e.message
      );

      error(
        ws,
        'BAD_JSON',
        'JSON inválido'
      );
    }
  });

  ws.on('close', () => {
    leave(ws);
  });

  ws.on('error', () => {
    leave(ws);
  });

  send(ws, {
    type: 'welcome',

    protocol: 'warrogue.server-authoritative.v2',

    maxPlayers: MAX_PLAYERS,

    serverTime: now(),

    botWaitMs: BOT_WAIT_MS
  });
}

wss.on('connection', handleConnection);

if (wssSecure) wssSecure.on('connection', handleConnection);

/*
 * Bucle central de simulación.
 */
const gameLoop = new GameLoop({
  rooms,
  bots,
  broadcast,
  onMatchFinished: (room, engine) => {
    persistence.finishMatch(room, engine);
    for (const player of room.players.values()) {
      if (!player.bot && player.profileId && player.ws) {
        send(player.ws, {
          type: 'profile_data',
          profile: persistence.publicProfile(player.profileId)
        });
      }
    }
  },
  intervalMs: 100
});

gameLoop.start();

/*
 * Heartbeat y limpieza de salas inactivas.
 */
setInterval(() => {
  for (const wssx of wsServers) {
    for (const ws of wssx.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }

  for (const [rid, r] of rooms) {
    if (now() - r.updatedAt > IDLE_MS) {
      if (
        r.autonomous &&
        r.status === 'playing'
      ) {
        r.updatedAt = now();
        continue;
      }

      if (r.restartTimer) {
        clearTimeout(r.restartTimer);
        r.restartTimer = null;
      }

      for (const p of r.players.values()) {
        if (p.ws) {
          send(p.ws, {
            type: 'room_closed',
            reason: 'idle_timeout'
          });

          p.ws.close();
        }
      }

      bots.stop(rid);
      rooms.delete(rid);
    }
  }
}, HEARTBEAT_MS).unref();

/*
 * Arena autónoma de IA.
 */
function createAutonomousArena() {
  if (
    !AUTO_BOT_ARENA ||
    rooms.size >= MAX_ROOMS
  ) {
    return;
  }

  const r = createRoomObject({
    name: 'Arena autónoma IA',
    map: 'default',
    autonomous: true
  });

  rooms.set(r.id, r);

  const a = bots.addBot(r, 'IA Alpha');
  const b = bots.addBot(r, 'IA Bravo');

  if (a && b) {
    startSimulation(r);

    r.updatedAt = now();

    console.log(
      `Arena IA iniciada: ${r.id}`
    );
  } else {
    bots.stop(r.id);
    rooms.delete(r.id);
  }
}

/*
 * Inicio de servicios.
 */
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    'WARROGUE HTTP/WS escuchando en ' + PORT
  );
});

if (httpsServer) {
  httpsServer.listen(WSS_PORT, '0.0.0.0', () => {
    console.log('WARROGUE HTTPS/WSS escuchando en ' + WSS_PORT);
  });
}

setTimeout(
  createAutonomousArena,
  1500
).unref?.();

/*
 * Cierre ordenado.
 */
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(
    '\nCerrando WARROGUE SERVER...'
  );

  gameLoop.stop();

  for (const r of rooms.values()) {
    if (r.restartTimer) {
      clearTimeout(r.restartTimer);
      r.restartTimer = null;
    }

    bots.stop(r.id);
  }

  for (const wssx of wsServers) {
    for (const ws of wssx.clients) {
      try {
        ws.close(
          1001,
          'server_shutdown'
        );
      } catch (_) {}
    }
  }

  server.close();
  if (httpsServer) httpsServer.close();

  setTimeout(() => {
    process.exit(0);
  }, 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  '[WARROGUE] Servidor inicializado.'
);
