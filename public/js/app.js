'use strict';

/*
 * WARROGUE - Cliente web
 * Protocolo: warrogue.v1
 *
 * Funciones:
 * - Conexión WebSocket.
 * - Crear y entrar en salas.
 * - Lobby y lista de jugadores.
 * - Chat.
 * - Apertura de WARROGUE Android mediante deep link.
 * - Inicio de partida cuando Android entra y está listo.
 *
 * La simulación de combate pertenece al servidor Node.js.
 */

const $ = id => document.getElementById(id);

const CONFIG = {
    protocol: 'warrogue.v1',
    androidPackage: 'com.warrogue.game',
    reconnectDelay: 3000,
    reconnectMaxAttempts: 10,
    launchTimeout: 90000
};

let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let intentionalClose = false;

let playerId = null;
let playerName = 'Jugador';
let currentRoom = null;
let currentPlayers = [];
let isHost = false;
let isReady = false;
let gameStarted = false;

let launchStartRequested = false;
let androidLaunchTime = 0;
let startRequestSent = false;

let roomsCache = [];
const getWebProfileId = () => localStorage.getItem('warrogue_profile_id') || '';
const getAuthToken = () => localStorage.getItem('warrogue_auth_token') || '';
;

function getPlayerName() {
    const input = $('commander');
    const value = input ? input.value.trim() : '';

    return value || 'Jugador';
}

function getRoomName() {
    const input = $('roomName');
    const value = input ? input.value.trim() : '';

    return value || 'Nueva partida';
}

function getMapName() {
    const input = $('mapName');
    const value = input ? input.value.trim() : '';

    return value || 'default';
}

function getWebSocketUrl() {
    // Permite configurar un endpoint distinto cuando el portal web y el
    // WebSocket se publican en hosts/rutas diferentes (por ejemplo, proxy).
    // La URL debe inyectarse antes de cargar este archivo.
    if (typeof window.WARROGUE_WS_URL === 'string' && window.WARROGUE_WS_URL.trim()) {
        try {
            const configured = new URL(window.WARROGUE_WS_URL.trim(), window.location.href);
            if (configured.protocol === 'http:') configured.protocol = 'ws:';
            if (configured.protocol === 'https:') configured.protocol = 'wss:';
            if (configured.protocol !== 'ws:' && configured.protocol !== 'wss:') {
                throw new Error('El endpoint WebSocket debe usar ws:// o wss://');
            }
            return configured.toString();
        } catch (error) {
            console.error('WARROGUE_WS_URL no es válido; se usará el origen actual:', error);
        }
    }

    // El navegador ya conoce el puerto público real con el que se abrió
    // el portal. Así se respeta PORT/WSS_PORT del .env sin duplicar sus
    // valores en JavaScript: location.host incluye el puerto si corresponde.
    // También funciona detrás de un proxy TLS que publique el sitio en 443.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/`;
}

function setConnection(state, message) {
    const label = $('connectionLabel');
    const dot = $('statusDot');
    const metric = $('metricState');

    if (label) {
        label.textContent = message;
    }

    if (metric) {
        metric.textContent = message;
    }

    if (dot) {
        dot.classList.remove('online', 'offline', 'connecting');

        if (state === 'online') {
            dot.classList.add('online');
        } else if (state === 'connecting') {
            dot.classList.add('connecting');
        } else {
            dot.classList.add('offline');
        }
    }
}

function showToast(message, duration = 3500) {
    const toast = $('toast');

    if (!toast) {
        console.log('[WARROGUE]', message);
        return;
    }

    toast.textContent = message;
    toast.classList.add('show');

    window.clearTimeout(showToast.timer);

    showToast.timer = window.setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

function send(type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showToast('No hay conexión con el servidor.');
        return false;
    }

    socket.send(JSON.stringify({
        type,
        ...payload
    }));

    return true;
}


function formatDuration(seconds) {
    const n = Math.max(0, Number(seconds) || 0);
    const mins = Math.floor(n / 60);
    const secs = n % 60;
    return mins ? `${mins} min ${secs} s` : `${secs} s`;
}

function renderAIStats(aiRows) {
    const rows = Array.isArray(aiRows) ? aiRows : [];
    const grid = $('aiStatsGrid');
    const lobby = $('aiLobbyStats');
    const lobbyPanel = $('aiLobbyPanel');
    const hasBot = currentPlayers.some(p => p.isBot || p.bot);
    if (lobbyPanel) lobbyPanel.classList.toggle('hidden', !hasBot);

    const label = { easy: 'FÁCIL', normal: 'NORMAL', hard: 'DIFÍCIL', expert: 'EXPERTO' };
    const makeCard = (p, compact = false) => {
        const card = document.createElement('article');
        card.className = compact ? 'ai-lobby-row' : 'ai-stat-card';
        const title = document.createElement('span'); title.className = 'ai-difficulty'; title.textContent = `IA ${label[p.difficulty] || String(p.difficulty).toUpperCase()}`;
        const rate = document.createElement('strong'); rate.textContent = `${Number(p.winRate) || 0}%`;
        const summary = document.createElement('small'); summary.textContent = `${p.matches || 0} partidas · ${p.wins || 0} victorias · ${p.losses || 0} derrotas`;
        const extra = document.createElement('div'); extra.className = 'ai-card-extra';
        extra.textContent = `${p.kills || 0} bajas · ${p.averageKills || 0} bajas/partida · ${p.averageScore || 0} puntos medios`;
        const adaptation = document.createElement('div'); adaptation.className = 'ai-adaptation';
        adaptation.textContent = `Agresividad ${(Number(p.aggression || 0) * 100).toFixed(1)}% · Cautela ${(Number(p.caution || 0) * 100).toFixed(1)}%`;
        card.append(title, rate, summary, extra, adaptation);
        return card;
    };
    if (grid) {
        grid.replaceChildren();
        if (!rows.length) grid.textContent = 'Todavía no hay datos de IA registrados.';
        rows.forEach(p => grid.appendChild(makeCard(p)));
    }
    if (lobby) {
        lobby.replaceChildren();
        if (!rows.length) lobby.textContent = 'Sin registros de IA.';
        rows.forEach(p => lobby.appendChild(makeCard(p, true)));
    }
}

async function loadAIStats() {
    try {
        const response = await fetch('/api/ai/stats', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        renderAIStats(data.ai || []);
        const updated = $('aiUpdated');
        if (updated) updated.textContent = data.updatedAt ? `ACTUALIZADO ${new Date(data.updatedAt).toLocaleTimeString()}` : 'DATOS DEL SERVIDOR';
    } catch (error) {
        const updated = $('aiUpdated');
        if (updated) updated.textContent = 'SERVIDOR NO DISPONIBLE';
        console.warn('No se pudieron cargar estadísticas de IA:', error);
    }
}

async function loadCommandDashboard() {
    try {
        const [statsResponse, boardResponse, profileResponse, aiResponse] = await Promise.all([
            fetch('/api/stats', { cache: 'no-store' }),
            fetch('/api/leaderboard?limit=8', { cache: 'no-store' }),
            fetch('/api/profile/' + encodeURIComponent(getWebProfileId()), { cache: 'no-store' }),
            fetch('/api/ai/stats', { cache: 'no-store' })
        ]);
        const stats = await statsResponse.json();
        const board = await boardResponse.json();
        const profile = profileResponse.ok ? await profileResponse.json() : null;
        const aiData = aiResponse.ok ? await aiResponse.json() : { ai: [] };
        renderAIStats(aiData.ai || []);
        const aiUpdated = $('aiUpdated');
        if (aiUpdated) aiUpdated.textContent = aiData.updatedAt ? `ACTUALIZADO ${new Date(aiData.updatedAt).toLocaleTimeString()}` : 'DATOS DEL SERVIDOR';
        const put = (id, value) => { const el = $(id); if (el) el.textContent = value; };
        put('globalPlayers', stats.players || 0);
        put('globalMatches', stats.matches || 0);
        put('globalWins', stats.wins || 0);
        put('globalKills', stats.kills || 0);
        const list = $('leaderboardList');
        if (list) {
            list.replaceChildren();
            (board.players || []).forEach((p, i) => {
                const row = document.createElement('div');
                row.className = 'rank-row';
                const rank = document.createElement('b'); rank.textContent = String(i + 1).padStart(2, '0');
                const name = document.createElement('span'); name.textContent = p.name;
                const level = document.createElement('small'); level.textContent = p.rank + ' · ' + p.xp + ' XP';
                row.append(rank, name, level); list.appendChild(row);
            });
            if (!list.children.length) list.textContent = 'Aún no hay jugadores clasificados.';
        }
        const card = $('myProfile');
        if (card) {
            if (!profile) {
                card.innerHTML = '<p class="profile-empty">Crea o entra en una partida para registrar tu perfil en este navegador.</p>';
            } else {
                card.replaceChildren();
                const safeNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
                const matches = safeNumber(profile.matches);
                const wins = safeNumber(profile.wins);
                const losses = safeNumber(profile.losses);
                const draws = safeNumber(profile.draws);
                const winRate = Math.max(0, Math.min(100, safeNumber(profile.winRate)));
                const avatar = document.createElement('div');
                avatar.className = 'profile-avatar';
                avatar.textContent = String(profile.name || 'J').trim().slice(0, 1).toUpperCase();
                const identity = document.createElement('div');
                identity.className = 'profile-identity';
                const subtitle = document.createElement('p');
                subtitle.className = 'profile-subtitle';
                subtitle.textContent = 'PERFIL ONLINE · IDENTIDAD DEL SERVIDOR';
                const title = document.createElement('h3');
                title.textContent = profile.name || 'Jugador';
                const rank = document.createElement('div');
                rank.className = 'profile-rank';
                rank.textContent = '◆  ' + (profile.rank || 'RECLUTA');
                const xp = document.createElement('strong');
                xp.textContent = safeNumber(profile.xp).toLocaleString('es-ES') + ' XP';
                identity.append(subtitle, title, rank, xp);
                const hero = document.createElement('div');
                hero.className = 'profile-hero';
                hero.append(avatar, identity);
                card.append(hero);

                const metrics = document.createElement('div');
                metrics.className = 'profile-metrics';
                [
                    ['PARTIDAS', matches],
                    ['VICTORIAS', wins],
                    ['ELIMINACIONES', safeNumber(profile.kills)],
                    ['RACHA MÁXIMA', safeNumber(profile.bestStreak)]
                ].forEach(([label, value]) => {
                    const item = document.createElement('div');
                    item.className = 'profile-metric';
                    const strong = document.createElement('strong');
                    strong.textContent = Number(value).toLocaleString('es-ES');
                    const small = document.createElement('small');
                    small.textContent = label;
                    item.append(strong, small);
                    metrics.append(item);
                });
                card.append(metrics);

                const performance = document.createElement('div');
                performance.className = 'profile-performance';
                const performanceHead = document.createElement('div');
                performanceHead.className = 'profile-performance-head';
                const label = document.createElement('span');
                label.textContent = 'EFECTIVIDAD DE COMBATE';
                const percent = document.createElement('b');
                percent.textContent = winRate + '%';
                performanceHead.append(label, percent);
                const track = document.createElement('div');
                track.className = 'profile-progress';
                track.setAttribute('role', 'img');
                track.setAttribute('aria-label', 'Efectividad de combate: ' + winRate + '%');
                const fill = document.createElement('span');
                fill.style.width = winRate + '%';
                track.append(fill);
                const breakdown = document.createElement('p');
                breakdown.className = 'profile-detail';
                breakdown.textContent = `${wins} victorias · ${draws} empates · ${losses} derrotas · ${matches} partidas`;
                performance.append(performanceHead, track, breakdown);
                card.append(performance);

                const medals = document.createElement('p');
                medals.className = 'profile-medals';
                const total = (profile.achievementDetails || []).length || (profile.achievements || []).length;
                const tiers = (profile.medals || []).filter(m => m.tier >= 0).map(m => `${String(m.title || 'Medalla').replace('Medalla ', '')}: ${m.tierName}`);
                medals.textContent = `🏅 ${(profile.achievements || []).length}/${total} logros · ${profile.medalLevels || 0} niveles de medalla` +
                    (tiers.length ? ' · ' + tiers.join(' / ') : '') +
                    (profile.nextRank ? ` · Siguiente rango: ${profile.nextRank.name} (${safeNumber(profile.nextRank.xp).toLocaleString('es-ES')} XP y ${safeNumber(profile.nextRank.wins)} victorias)` : ' · Rango máximo');
                card.append(medals);
            }
        }
    } catch (e) { console.warn('No se pudo cargar el centro de estadísticas', e); }
}

function connect() {
    intentionalClose = false;

    if (socket &&
        (socket.readyState === WebSocket.OPEN ||
         socket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const url = getWebSocketUrl();

    setConnection('connecting', 'Conectando...');

    try {
        const token = getAuthToken();
        const wsUrl = token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : url;
        socket = new WebSocket(wsUrl);
    } catch (error) {
        console.error('Error creando WebSocket:', error);
        setConnection('offline', 'Error de conexión');
        scheduleReconnect();
        return;
    }

    socket.addEventListener('open', () => {
        reconnectAttempts = 0;

        setConnection('online', 'Conectado');

        showToast('Conectado al servidor WARROGUE.');

        send('list_rooms');
    });

    socket.addEventListener('message', event => {
        let message;

        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.warn('Mensaje no válido recibido:', event.data);
            return;
        }

        handleMessage(message);
    });

    socket.addEventListener('error', error => {
        console.error('WebSocket error:', error);
        setConnection('offline', 'Error de conexión');
    });

    socket.addEventListener('close', () => {
        setConnection('offline', 'Desconectado');

        if (!intentionalClose) {
            scheduleReconnect();
        }
    });
}

function scheduleReconnect() {
    if (intentionalClose || reconnectTimer) {
        return;
    }

    if (reconnectAttempts >= CONFIG.reconnectMaxAttempts) {
        showToast('No se pudo recuperar la conexión.');
        return;
    }

    reconnectAttempts++;

    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, CONFIG.reconnectDelay);
}

function handleMessage(message) {
    if (!message || !message.type) {
        return;
    }

    switch (message.type) {
        case 'welcome':
            handleWelcome(message);
            break;

        case 'rooms':
            handleRooms(message);
            break;

        case 'joined':
            handleJoined(message);
            break;

        case 'host_assigned':
            isHost = true;
            updateLobbyControls();
            break;

        case 'room_snapshot':
            handleRoomSnapshot(message);
            break;

        case 'player_ready':
            if (message.playerId === playerId) {
                isReady = !!message.ready;
            }
            break;

        case 'game_started':
            handleGameStarted(message);
            break;

        case 'game_over':
            showToast('Combate finalizado. Actualizando estadísticas de la IA…');
            window.setTimeout(loadCommandDashboard, 900);
            break;

        case 'state_sync':
            // Compatibilidad con el protocolo antiguo.
            // El combate nuevo debe ser simulado por Node.js.
            break;

        case 'game_state':
            // Estado autoritativo del servidor.
            // La aplicación Android recibe este estado directamente.
            break;

        case 'command':
            // Los comandos pertenecen al servidor de simulación.
            break;

        case 'chat':
            appendChat(message);
            break;

        case 'bot_joined':
            showToast('La IA se ha unido a la sala.');
            break;

        case 'bot_removed':
            showToast('El bot ha sido retirado de la sala.');
            break;

        case 'host_changed':
            handleHostChanged(message);
            break;

        case 'pong':
            break;

        case 'error':
            showToast(message.message || 'Error del servidor.');
            console.error('Error del servidor:', message);
            break;

        case 'left':
            clearLobby();
            break;

        default:
            console.log('Mensaje recibido:', message);
            break;
    }
}

function handleWelcome(message) {
    if (message.playerId) {
        playerId = message.playerId;
    }

    if (message.protocol &&
        message.protocol !== CONFIG.protocol) {
        console.warn(
            'Protocolo diferente:',
            message.protocol
        );
    }

    send('list_rooms');
}

function handleRooms(message) {
    roomsCache = Array.isArray(message.rooms)
        ? message.rooms
        : [];

    renderRooms();

    const metric = $('metricRooms');

    if (metric) {
        metric.textContent = String(roomsCache.length);
    }

    updatePlayerMetric();
}

function renderRooms() {
    const container = $('roomList');

    if (!container) {
        return;
    }

    container.replaceChildren();

    if (roomsCache.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-rooms';
        empty.textContent = 'No hay partidas disponibles.';
        container.appendChild(empty);
        return;
    }

    for (const room of roomsCache) {
        const item = document.createElement('div');
        item.className = 'room-item';

        const info = document.createElement('div');
        info.className = 'room-info';

        const title = document.createElement('strong');
        title.textContent = room.name || 'Partida';

        const details = document.createElement('span');

        const count = Number(room.players || 0);
        const max = Number(room.maxPlayers || 8);

        details.textContent =
            `${count}/${max} jugadores · ${room.status || 'lobby'}`;

        info.appendChild(title);
        info.appendChild(details);

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'ENTRAR';
        button.disabled = count >= max ||
            room.status === 'playing';

        button.addEventListener('click', () => {
            joinRoom(room.roomId);
        });

        item.appendChild(info);
        item.appendChild(button);

        container.appendChild(item);
    }
}

function createRoom() {
    if (!getAuthToken()) { showToast('Inicia sesión o crea una cuenta antes de desplegar una operación.'); $('authEmail')?.focus(); return; }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showToast('Primero debes conectarte al servidor.');
        return;
    }

    playerName = getPlayerName();

    send('create_room', {
        name: getRoomName(),
        map: getMapName(),
        playerName,
        profileId: getWebProfileId(),
        platform: 'web'
    });
}

function joinRoom(roomId) {
    if (!getAuthToken()) { showToast('Inicia sesión o crea una cuenta para unirte a una sala.'); $('authEmail')?.focus(); return; }
    if (!roomId) {
        return;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showToast('No hay conexión con el servidor.');
        return;
    }

    playerName = getPlayerName();

    send('join_room', {
        roomId,
        playerName,
        profileId: getWebProfileId(),
        platform: 'web'
    });
}

function handleJoined(message) {
    playerId = message.playerId || playerId;

    if (message.roomId) {
        currentRoom = {
            roomId: message.roomId,
            name: message.name || getRoomName()
        };
    }

    if (typeof message.isHost === 'boolean') {
        isHost = message.isHost;
    }

    if (message.player) {
        isHost = !!message.player.isHost;
    }

    if (message.players) {
        currentPlayers = message.players;
        updatePlayers();
    }

    showLobby();

    if (isHost) {
        showToast('Sala creada. Eres el comandante anfitrión.');
    } else {
        showToast('Te has unido a la partida.');
    }

    updateLobbyControls();

    send('list_rooms');
}

function handleRoomSnapshot(message) {
    const room = message.room || {};

    if (room.roomId) {
        currentRoom = room;
    }

    currentPlayers = Array.isArray(message.players)
        ? message.players
        : [];

    const myPlayer = currentPlayers.find(player =>
        player.playerId === playerId
    );

    if (myPlayer) {
        isHost = !!myPlayer.isHost;
        isReady = !!myPlayer.ready;
    }

    updatePlayers();
    updateLobbyControls();
    updatePlayerMetric();
    loadAIStats();

    const title = $('lobbyTitle');

    if (title) {
        title.textContent = room.name || 'Sala de partida';
    }

    const code = $('roomCode');

    if (code) {
        code.textContent = room.roomId || '';
    }

    // Si el anfitrión solicitó iniciar desde la web,
    // esperamos al jugador Android humano y listo.
    maybeStartAfterAndroidJoined();

    send('list_rooms');
}

function updatePlayers() {
    const container = $('players');

    if (!container) {
        return;
    }

    container.replaceChildren();

    for (const player of currentPlayers) {
        const item = document.createElement('div');
        item.className = 'player-item';

        const name = document.createElement('span');
        name.textContent = player.name || 'Jugador';

        const status = document.createElement('span');

        if (player.isBot || player.bot) {
            status.textContent = 'IA';
            status.className = 'player-bot';
        } else if (player.isHost) {
            status.textContent = 'ANFITRIÓN';
            status.className = 'player-host';
        } else if (player.ready) {
            status.textContent = 'LISTO';
            status.className = 'player-ready';
        } else {
            status.textContent = 'ESPERANDO';
            status.className = 'player-waiting';
        }

        item.appendChild(name);
        item.appendChild(status);

        container.appendChild(item);
    }
}

function updateLobbyControls() {
    const readyButton = $('readyBtn');
    const startButton = $('startBtn');

    if (readyButton) {
        readyButton.disabled = !currentRoom || isHost;
        readyButton.textContent = isReady
            ? 'NO LISTO'
            : 'ESTOY LISTO';
    }

    if (startButton) {
        startButton.disabled = !currentRoom ||
            !isHost ||
            gameStarted;

        startButton.textContent = launchStartRequested
            ? 'ESPERANDO ANDROID...'
            : 'INICIAR PARTIDA';
    }
}

function updatePlayerMetric() {
    const metric = $('metricPlayers');

    if (!metric) {
        return;
    }

    let count = 0;

    for (const room of roomsCache) {
        count += Number(room.players || 0);
    }

    if (currentRoom) {
        count = currentPlayers.length;
    }

    metric.textContent = String(count);
}

function showLobby() {
    const lobby = $('lobby');

    if (lobby) {
        lobby.classList.add('active');
        lobby.hidden = false;
    }
}

function clearLobby() {
    currentRoom = null;
    currentPlayers = [];
    isHost = false;
    isReady = false;
    gameStarted = false;

    launchStartRequested = false;
    androidLaunchTime = 0;
    startRequestSent = false;

    const lobby = $('lobby');

    if (lobby) {
        lobby.classList.remove('active');
        lobby.hidden = true;
    }

    updateLobbyControls();
    updatePlayers();
}

function toggleReady() {
    if (!currentRoom) {
        showToast('No estás dentro de una sala.');
        return;
    }

    if (isHost) {
        showToast('El anfitrión no necesita marcar listo.');
        return;
    }

    isReady = !isReady;

    send('ready', {
        ready: isReady
    });

    updateLobbyControls();
}

function launchAndroid() {
    if (!currentRoom || !currentRoom.roomId) {
        showToast('No hay una sala activa.');
        return;
    }

    const serverUrl = getWebSocketUrl();

    if (!serverUrl.startsWith('wss://')) {
        showToast(
            'Para abrir Android necesitas que el servidor use WSS con certificado válido.'
        );
        return;
    }

    const roomId = currentRoom.roomId;

    const query = new URLSearchParams({
        server: serverUrl,
        room: roomId,
        player: playerName,
        profileId: getWebProfileId()
    });

    const deepLink =
        `warrogue://join?${query.toString()}`;

    const intentUrl =
        `intent://join?${query.toString()}` +
        `#Intent;scheme=warrogue;` +
        `package=${CONFIG.androidPackage};` +
        `S.browser_fallback_url=${encodeURIComponent(location.href)};` +
        `end`;

    try {
        // Primero se utiliza el enlace Android.
        // El intent:// permite indicar el paquete.
        window.location.href = intentUrl;

        // Fallback para navegadores que acepten el esquema.
        window.setTimeout(() => {
            if (document.visibilityState === 'visible') {
                window.location.href = deepLink;
            }
        }, 1200);

    } catch (error) {
        console.error('No se pudo abrir WARROGUE:', error);
        showToast('No se pudo abrir la aplicación Android.');
    }
}

function startGameFromWeb() {
    if (!currentRoom) {
        showToast('Primero crea o entra en una sala.');
        return;
    }

    if (!isHost) {
        showToast('Solo el anfitrión puede iniciar la partida.');
        return;
    }

    if (gameStarted) {
        showToast('La partida ya está iniciada.');
        return;
    }

    if (launchStartRequested) {
        showToast('Esperando que Android se conecte...');
        return;
    }

    launchStartRequested = true;
    startRequestSent = false;
    androidLaunchTime = Date.now();

    updateLobbyControls();

    showToast('Abriendo WARROGUE en Android...');

    launchAndroid();

    window.setTimeout(() => {
        if (!launchStartRequested || gameStarted) {
            return;
        }

        const elapsed = Date.now() - androidLaunchTime;

        if (elapsed >= CONFIG.launchTimeout) {
            launchStartRequested = false;
            updateLobbyControls();

            showToast(
                'Android no se conectó. Comprueba que la aplicación esté instalada y el servidor accesible.',
                6000
            );
        }
    }, CONFIG.launchTimeout);
}

function isAndroidPlayer(player) {
    if (!player || player.isBot || player.bot) {
        return false;
    }

    const platform = String(
        player.platform ||
        player.device ||
        player.client ||
        player.clientType ||
        ''
    ).toLowerCase();

    return platform === 'android' ||
        platform === 'warrogue-android';
}

function maybeStartAfterAndroidJoined() {
    if (!launchStartRequested ||
        !isHost ||
        startRequestSent ||
        gameStarted) {
        return;
    }

    const androidPlayer = currentPlayers.find(player =>
        player.playerId !== playerId &&
        isAndroidPlayer(player) &&
        player.ready === true
    );

    if (!androidPlayer) {
        return;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
        startRequestSent = true;

        const sent = send('start_game');

        if (sent) {
            showToast('Android está listo. Iniciando partida...');
        } else {
            startRequestSent = false;
        }
    }
}

function handleGameStarted(message) {
    gameStarted = true;
    launchStartRequested = false;

    updateLobbyControls();

    showToast('¡La partida WARROGUE ha comenzado!', 5000);

    console.log('Partida iniciada:', message);
}

function handleHostChanged(message) {
    const newHostId = message.playerId ||
        message.hostId;

    if (newHostId) {
        isHost = newHostId === playerId;
    }

    updateLobbyControls();

    showToast(
        isHost
            ? 'Ahora eres el anfitrión.'
            : 'El anfitrión de la sala ha cambiado.'
    );
}

function appendChat(message) {
    const container = $('chatLog');

    if (!container) {
        return;
    }

    const row = document.createElement('div');
    row.className = 'chat-message';

    const name = document.createElement('strong');
    name.textContent = (message.name || 'Jugador') + ': ';

    const text = document.createElement('span');
    text.textContent = message.text || '';

    row.appendChild(name);
    row.appendChild(text);

    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
}

function sendChat(event) {
    if (event) {
        event.preventDefault();
    }

    const input = $('chatInput');

    if (!input) {
        return;
    }

    const text = input.value.trim();

    if (!text) {
        return;
    }

    send('chat', {
        text
    });

    input.value = '';
}

function leaveRoom() {
    if (!currentRoom) {
        clearLobby();
        return;
    }

    send('leave_room');

    clearLobby();

    showToast('Has salido de la sala.');
}

function refreshRooms() {
    send('list_rooms');
}

async function authenticateWeb(register) {
    const email = $('authEmail')?.value.trim() || '';
    const password = $('authPassword')?.value || '';
    if (!email || password.length < 8) { showToast('Introduce correo válido y contraseña de al menos 8 caracteres.'); return; }
    const buttons = [$('loginBtn'), $('registerBtn')]; buttons.forEach(b => { if (b) b.disabled = true; });
    try {
        const response = await fetch(register ? '/api/auth/register' : '/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, name: getPlayerName() })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Autenticación rechazada');
        localStorage.setItem('warrogue_auth_token', data.token);
        localStorage.setItem('warrogue_profile_id', data.profileId);
        const state = $('authState'); if (state) state.textContent = 'Sesión iniciada · ' + data.name + ' · progreso sincronizado';
        showToast(register ? 'Cuenta creada correctamente.' : 'Sesión iniciada correctamente.');
        if (socket) { intentionalClose = true; socket.close(); socket = null; }
        connect(); loadCommandDashboard();
    } catch (error) { showToast(error.message || 'No se pudo autenticar'); }
    finally { buttons.forEach(b => { if (b) b.disabled = false; }); }
}

function bindEvents() {
    const createButton = $('createBtn');
    const refreshButton = $('refreshBtn');
    const readyButton = $('readyBtn');
    const startButton = $('startBtn');
    const leaveButton = $('leaveBtn');
    const chatForm = $('chatForm');
    $('loginBtn')?.addEventListener('click', () => authenticateWeb(false));
    $('registerBtn')?.addEventListener('click', () => authenticateWeb(true));
    if (getAuthToken() && $('authState')) $('authState').textContent = 'Sesión guardada en este navegador.';

    if (createButton) {
        createButton.addEventListener('click', createRoom);
    }

    if (refreshButton) {
        refreshButton.addEventListener('click', refreshRooms);
    }

    if (readyButton) {
        readyButton.addEventListener('click', toggleReady);
    }

    if (startButton) {
        startButton.addEventListener('click', startGameFromWeb);
    }

    if (leaveButton) {
        leaveButton.addEventListener('click', leaveRoom);
    }

    if (chatForm) {
        chatForm.addEventListener('submit', sendChat);
    }

    const year = $('year');

    if (year) {
        year.textContent = String(new Date().getFullYear());
    }
}

function start() {
    bindEvents();
    connect();

    window.setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            send('ping');
        }
    }, 25000);
}

document.addEventListener('DOMContentLoaded', start);

window.addEventListener('load', () => { loadCommandDashboard(); setInterval(loadCommandDashboard, 15000); setInterval(loadAIStats, 10000); });
