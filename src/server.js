'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const IDLE_MS = Number(process.env.ROOM_IDLE_MINUTES || 30) * 60000;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 25000);
const MAX_PLAYERS = 8;
const RATE_LIMIT_PER_SEC = Number(process.env.RATE_LIMIT_PER_SEC || 60);
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD_BYTES || 300000);
const MAX_STATE_BYTES = Number(process.env.MAX_STATE_BYTES || 256000);
const MAX_COMMAND_BYTES = Number(process.env.MAX_COMMAND_BYTES || 8000);
const PUBLIC_NAME = process.env.PUBLIC_SERVER_NAME || 'WARROGUE Public Server';

const rooms = new Map();
const clients = new Map();
const STARTED_AT = Date.now();

const metrics = {
    connections: 0,
    connectionsTotal: 0,
    messagesIn: 0,
    messagesOut: 0,
    roomsCreated: 0,
    roomsClosed: 0,
    gamesStarted: 0,
    commands: 0,
    chatMessages: 0,
    rejectedMessages: 0,
    peakPlayers: 0,
    peakRooms: 0,
    bytesIn: 0,
    bytesOut: 0
};

const now = () => Date.now();
const id = (n = 8) => crypto.randomBytes(n).toString('hex');

const safeName = v =>
    String(v || 'Jugador')
        .replace(/[<>\\\u0000-\u001f]/g, '')
        .trim()
        .slice(0, 20) || 'Jugador';

const send = (ws, obj) => {
    if (ws.readyState === WebSocket.OPEN) {
        const raw = JSON.stringify(obj);
        metrics.messagesOut++;
        metrics.bytesOut += Buffer.byteLength(raw);
        ws.send(raw);
    }
};

const error = (ws, code, message) => {
    metrics.rejectedMessages++;
    send(ws, { type: 'error', code, message });
};

const roomPublic = r => ({
    roomId: r.id,
    name: r.name,
    players: r.players.size,
    maxPlayers: MAX_PLAYERS,
    status: r.status,
    map: r.map,
    createdAt: r.createdAt
});

function updatePeaks() {
    metrics.peakPlayers = Math.max(metrics.peakPlayers, clients.size);
    metrics.peakRooms = Math.max(metrics.peakRooms, rooms.size);
}

function broadcast(r, obj, except = null) {
    const raw = JSON.stringify(obj);
    const size = Buffer.byteLength(raw);

    for (const p of r.players.values()) {
        if (p.ws !== except && p.ws.readyState === WebSocket.OPEN) {
            metrics.messagesOut++;
            metrics.bytesOut += size;
            p.ws.send(raw);
        }
    }
}

function snapshot(r) {
    return {
        type: 'room_snapshot',
        room: roomPublic(r),
        players: [...r.players.values()].map(p => ({
            playerId: p.id,
            name: p.name,
            slot: p.slot,
            ready: p.ready,
            isHost: p.id === r.hostId
        })),
        gameState: r.gameState,
        revision: r.revision
    };
}

function leave(ws) {
    const c = clients.get(ws);
    if (!c) return;

    clients.delete(ws);

    const r = rooms.get(c.roomId);
    if (!r) return;

    r.players.delete(c.playerId);
    r.updatedAt = now();

    if (r.hostId === c.playerId) {
        const next = r.players.values().next().value;
        r.hostId = next ? next.id : null;

        if (next) {
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

    if (!r.players.size) {
        rooms.delete(r.id);
        metrics.roomsClosed++;
    } else {
        broadcast(r, snapshot(r));
    }
}

function join(ws, r, name, asHost = false) {
    if (r.status !== 'lobby') {
        error(ws, 'ROOM_IN_GAME', 'La partida ya comenzó');
        return null;
    }

    if (r.players.size >= MAX_PLAYERS) {
        error(ws, 'ROOM_FULL', 'La sala está completa');
        return null;
    }

    const playerId = id(12);
    const used = new Set([...r.players.values()].map(p => p.slot));

    let slot = 0;
    while (used.has(slot)) slot++;

    const p = {
        id: playerId,
        name: safeName(name),
        slot,
        ready: false,
        ws
    };

    r.players.set(playerId, p);
    r.updatedAt = now();

    if (asHost) r.hostId = playerId;

    clients.set(ws, {
        roomId: r.id,
        playerId
    });

    updatePeaks();

    send(ws, {
        type: 'joined',
        playerId,
        roomId: r.id,
        slot,
        isHost: r.hostId === playerId
    });

    broadcast(r, {
        type: 'player_joined',
        player: {
            playerId,
            name: p.name,
            slot,
            ready: false,
            isHost: r.hostId === playerId
        }
    }, ws);

    broadcast(r, snapshot(r));

    return playerId;
}

function handle(ws, msg) {
    if (!msg || typeof msg !== 'object' ||
        Array.isArray(msg) || typeof msg.type !== 'string') {
        return error(ws, 'BAD_MESSAGE', 'Mensaje invalido');
    }

    const c = clients.get(ws);

    if (msg.type === 'list_rooms') {
        send(ws, {
            type: 'rooms',
            rooms: [...rooms.values()]
                .filter(r => r.status === 'lobby')
                .map(roomPublic)
        });
        return;
    }

    if (msg.type === 'create_room') {
        if (c) return error(ws, 'ALREADY_IN_ROOM', 'Ya perteneces a una sala');
        if (rooms.size >= MAX_ROOMS) return error(ws, 'SERVER_FULL', 'Servidor lleno');

        const roomId = id(5).toUpperCase();

        const r = {
            id: roomId,
            name: safeName(msg.name || 'Partida'),
            map: safeName(msg.map || 'default'),
            status: 'lobby',
            hostId: null,
            players: new Map(),
            gameState: null,
            revision: 0,
            createdAt: now(),
            updatedAt: now()
        };

        rooms.set(roomId, r);
        metrics.roomsCreated++;

        updatePeaks();

        r.hostId = join(ws, r, msg.playerName, true);

        if (r.hostId) {
            send(ws, {
                type: 'host_assigned',
                playerId: r.hostId
            });
        } else {
            rooms.delete(roomId);
            metrics.roomsClosed++;
        }

        return;
    }

    if (msg.type === 'join_room') {
        if (c) return error(ws, 'ALREADY_IN_ROOM', 'Ya perteneces a una sala');

        const r = rooms.get(String(msg.roomId || '').toUpperCase());

        if (!r) return error(ws, 'ROOM_NOT_FOUND', 'Sala no encontrada');

        join(ws, r, msg.playerName);
        return;
    }

    if (!c) return error(ws, 'NOT_IN_ROOM', 'Primero debes entrar en una sala');

    const r = rooms.get(c.roomId);
    const p = r && r.players.get(c.playerId);

    if (!r || !p) return error(ws, 'ROOM_NOT_FOUND', 'La sala ya no existe');

    r.updatedAt = now();

    if (msg.type === 'leave_room') {
        leave(ws);
        send(ws, { type: 'left_room' });
        return;
    }

    if (msg.type === 'ready') {
        p.ready = !!msg.ready;

        broadcast(r, {
            type: 'player_ready',
            playerId: p.id,
            ready: p.ready
        });

        broadcast(r, snapshot(r));
        return;
    }

    if (msg.type === 'start_game') {
        if (r.hostId !== p.id) {
            return error(ws, 'HOST_ONLY', 'Solo el anfitrion puede iniciar');
        }

        if (r.players.size < 2) {
            return error(ws, 'NEED_PLAYERS', 'Se necesitan al menos 2 jugadores');
        }

        if ([...r.players.values()].some(
            x => !x.ready && x.id !== r.hostId
        )) {
            return error(ws, 'NOT_READY', 'Hay jugadores que no están listos');
        }

        r.status = 'playing';
        r.revision++;
        metrics.gamesStarted++;

        broadcast(r, {
            type: 'game_started',
            roomId: r.id,
            players: [...r.players.values()].map(x => ({
                playerId: x.id,
                name: x.name,
                slot: x.slot
            })),
            revision: r.revision
        });

        return;
    }

    if (msg.type === 'state_sync') {
        if (r.hostId !== p.id) {
            return error(ws, 'HOST_ONLY', 'Solo el anfitrion autoritativo puede publicar el estado');
        }

        if (r.status !== 'playing') {
            return error(ws, 'NOT_IN_GAME', 'La partida no está activa');
        }

        if (typeof msg.state !== 'object' ||
            msg.state === null || Array.isArray(msg.state)) {
            return error(ws, 'BAD_STATE', 'Estado invalido');
        }

        const encoded = JSON.stringify(msg.state);

        if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) {
            return error(ws, 'STATE_TOO_LARGE', 'Estado supera el límite permitido');
        }

        r.gameState = msg.state;
        r.revision++;

        broadcast(r, {
            type: 'state_sync',
            revision: r.revision,
            state: r.gameState
        }, ws);

        return;
    }

    if (msg.type === 'command') {
        if (r.status !== 'playing') {
            return error(ws, 'NOT_IN_GAME', 'La partida no está activa');
        }

        if (typeof msg.command !== 'object' ||
            msg.command === null || Array.isArray(msg.command)) {
            return error(ws, 'BAD_COMMAND', 'Orden invalida');
        }

        const encoded = JSON.stringify(msg.command);

        if (Buffer.byteLength(encoded) > MAX_COMMAND_BYTES) {
            return error(ws, 'COMMAND_TOO_LARGE', 'Orden demasiado grande');
        }

        metrics.commands++;

        broadcast(r, {
            type: 'command',
            playerId: p.id,
            slot: p.slot,
            command: msg.command,
            serverTime: now()
        });

        return;
    }

    if (msg.type === 'chat') {
        const text = String(msg.text || '').trim().slice(0, 300);

        if (text) {
            metrics.chatMessages++;

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

    error(ws, 'UNKNOWN_TYPE', 'Tipo de mensaje desconocido');
}

function getStats() {
    let playingRooms = 0;
    let lobbyRooms = 0;
    let playersInGame = 0;

    for (const r of rooms.values()) {
        if (r.status === 'playing') {
            playingRooms++;
            playersInGame += r.players.size;
        } else {
            lobbyRooms++;
        }
    }

    const mem = process.memoryUsage();

    return {
        ok: true,
        name: PUBLIC_NAME,
        protocol: 'warrogue.v1',
        startedAt: STARTED_AT,
        serverTime: now(),
        uptimeSeconds: Math.floor(process.uptime()),
        rooms: rooms.size,
        lobbyRooms,
        playingRooms,
        clients: clients.size,
        playersInGame,
        maxRooms: MAX_ROOMS,
        maxPlayersPerRoom: MAX_PLAYERS,
        limits: {
            rateLimitPerSecond: RATE_LIMIT_PER_SEC,
            maxPayloadBytes: MAX_PAYLOAD,
            maxStateBytes: MAX_STATE_BYTES,
            maxCommandBytes: MAX_COMMAND_BYTES
        },
        metrics: { ...metrics },
        system: {
            platform: process.platform,
            node: process.version,
            cpus: os.cpus().length,
            loadAverage: os.loadavg(),
            memory: {
                rss: mem.rss,
                heapUsed: mem.heapUsed,
                heapTotal: mem.heapTotal,
                external: mem.external
            }
        }
    };
}

const server = http.createServer((req, res) => {
    const pathname = String(req.url || '/').split('?')[0];

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
            'Content-Type': 'application/json; charset=utf-8',
            Allow: 'GET, HEAD'
        });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
    }

    if (pathname === '/health') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify({
            ok: true,
            name: PUBLIC_NAME,
            rooms: rooms.size,
            clients: clients.size,
            maxPlayers: MAX_PLAYERS
        }));

        return;
    }

    if (pathname === '/stats' || pathname === '/api/stats') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify(getStats()));
        return;
    }

    if (pathname === '/rooms' || pathname === '/api/rooms') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify({
            rooms: [...rooms.values()].map(r => ({
                ...roomPublic(r),
                playersList: [...r.players.values()].map(p => ({
                    name: p.name,
                    slot: p.slot,
                    ready: p.ready,
                    isHost: p.id === r.hostId
                }))
            }))
        }));

        return;
    }

    if (pathname === '/' || pathname === '/index.html') {
        const file = path.join(__dirname, 'public', 'index.html');

        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(500, {
                    'Content-Type': 'text/plain; charset=utf-8'
                });
                res.end('Falta public/index.html');
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8'
            });

            res.end(data);
        });

        return;
    }

    res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8'
    });

    res.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocket.Server({
    server,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false
});

wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.rate = {
        t: now(),
        n: 0
    };

    metrics.connections++;
    metrics.connectionsTotal++;

    ws.on('message', data => {
        metrics.messagesIn++;
        metrics.bytesIn += data.length;

        const t = now();

        if (t - ws.rate.t >= 1000) {
            ws.rate.t = t;
            ws.rate.n = 0;
        }

        if (++ws.rate.n > RATE_LIMIT_PER_SEC) {
            if (ws.rate.n === RATE_LIMIT_PER_SEC + 1) {
                error(ws, 'RATE_LIMIT', 'Demasiados mensajes por segundo');
            }

            if (ws.rate.n > RATE_LIMIT_PER_SEC * 3) {
                ws.terminate();
            }

            return;
        }

        try {
            const msg = JSON.parse(data.toString());
            handle(ws, msg);
        } catch (_) {
            error(ws, 'BAD_JSON', 'JSON invalido');
        }
    });

    ws.on('close', () => {
        metrics.connections = Math.max(0, metrics.connections - 1);
        leave(ws);
    });

    ws.on('error', () => {});

    send(ws, {
        type: 'welcome',
        protocol: 'warrogue.v1',
        maxPlayers: MAX_PLAYERS,
        serverTime: now()
    });
});

const maintenance = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }

        ws.isAlive = false;
        ws.ping();
    }

    for (const [rid, r] of rooms) {
        if (!r.players.size || now() - r.updatedAt > IDLE_MS) {
            for (const p of r.players.values()) {
                clients.delete(p.ws);
                send(p.ws, {
                    type: 'room_closed',
                    reason: 'idle_timeout'
                });
                p.ws.close();
            }

            rooms.delete(rid);
            metrics.roomsClosed++;
        }
    }
}, HEARTBEAT_MS);

maintenance.unref();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`${PUBLIC_NAME} listening on :${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/`);
    console.log(`Health:    http://localhost:${PORT}/health`);
    console.log(`Stats:     http://localhost:${PORT}/stats`);
});

let shuttingDown = false;

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}; shutting down...`);

    clearInterval(maintenance);

    for (const ws of wss.clients) {
        try {
            ws.close(1001, 'server_shutdown');
        } catch (_) {}
    }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => shutdown(sig));
}
