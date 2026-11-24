'use strict';

const PLAYER_SLOTS = 8;

// Fase de paz al inicio: nadie puede hacer daño durante estos segundos.
const PEACE_SECONDS = Math.max(
  0,
  Number(process.env.PEACE_SECONDS ?? 120)
);

// Puntos de aparición repartidos por todo el mapa: primero las cuatro
// esquinas y despues los puntos medios de cada borde. Con dos jugadores
// quedan en esquinas opuestas y a mas de 1.1 de distancia.
const SPAWN_POINTS = [
  { x: 0.09, y: 0.14 },  // 0 arriba-izquierda
  { x: 0.91, y: 0.86 },  // 1 abajo-derecha (opuesta a 0)
  { x: 0.91, y: 0.14 },  // 2 arriba-derecha
  { x: 0.09, y: 0.86 },  // 3 abajo-izquierda
  { x: 0.50, y: 0.10 },  // 4 centro-arriba
  { x: 0.50, y: 0.90 },  // 5 centro-abajo
  { x: 0.07, y: 0.50 },  // 6 centro-izquierda
  { x: 0.93, y: 0.50 }   // 7 centro-derecha
];

const UNIT = {
  COMMANDER: {
    cost: 0, hp: 260, speed: 0.055,
    damage: 18, range: 0.13, cooldown: 1.1,
    vision: 0.15
  },
  TANK: {
    cost: 180, trainSeconds: 30, energy: 35, hp: 190, speed: 0.032,
    damage: 34, range: 0.12, cooldown: 1.4,
    vision: 0.13
  },
  SOLDIER: {
    cost: 70, trainSeconds: 12, energy: 12, hp: 75, speed: 0.060,
    damage: 13, range: 0.085, cooldown: 0.8,
    vision: 0.12
  },
  SCOUT: {
    cost: 50, trainSeconds: 9, energy: 10, hp: 65, speed: 0.095,
    damage: 8, range: 0.075, cooldown: 0.55,
    vision: 0.23
  },
  MEDIC: { cost: 110, trainSeconds: 18, energy: 18, hp: 65, speed: 0.058, damage: 2, range: 0.07, cooldown: 1.0, vision: 0.12, armor: 0 },
  SNIPER: { cost: 145, trainSeconds: 24, energy: 20, hp: 58, speed: 0.052, damage: 42, range: 0.22, cooldown: 2.8, vision: 0.27, armor: 0 },
  ENGINEER: { cost: 125, trainSeconds: 20, energy: 22, hp: 82, speed: 0.055, damage: 7, range: 0.075, cooldown: 1.0, vision: 0.13, armor: 1 },
  ARTILLERY: { cost: 320, trainSeconds: 45, energy: 48, hp: 115, speed: 0.022, damage: 68, range: 0.29, cooldown: 4.2, vision: 0.14, armor: 3 },
  ROCKET: { cost: 235, trainSeconds: 36, energy: 38, hp: 92, speed: 0.043, damage: 48, range: 0.19, cooldown: 2.3, vision: 0.15, armor: 2 },
  APC: { cost: 260, trainSeconds: 40, energy: 42, hp: 230, speed: 0.048, damage: 15, range: 0.105, cooldown: 1.1, vision: 0.17, armor: 5 },
  HEAVY_TANK: { cost: 420, trainSeconds: 60, energy: 70, hp: 390, speed: 0.021, damage: 62, range: 0.145, cooldown: 2.0, vision: 0.15, armor: 9 },
  FLAME: { cost: 155, trainSeconds: 26, energy: 28, hp: 105, speed: 0.051, damage: 25, range: 0.055, cooldown: 0.45, vision: 0.11, armor: 1 }
};


function createSpawnLayout() {
  const pairs = [
    [{ x: 0.09, y: 0.14 }, { x: 0.91, y: 0.86 }],
    [{ x: 0.91, y: 0.14 }, { x: 0.09, y: 0.86 }],
    [{ x: 0.50, y: 0.10 }, { x: 0.50, y: 0.90 }],
    [{ x: 0.07, y: 0.50 }, { x: 0.93, y: 0.50 }]
  ];
  // Fisher-Yates: cada partida cambia el sector asignado a cada pareja.
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return pairs.flatMap(pair => Math.random() < 0.5 ? pair : [pair[1], pair[0]])
    .map(point => ({ ...point }));
}

const BUILDING = {
  HQ:       { cost: 0, energy: 0, hp: 1200, vision: 0.16 },
  BARRACKS: { cost: 250, energy: 30, hp: 520, vision: 0.10 },
  TURRET:   { cost: 220, energy: 28, hp: 380, vision: 0.18 },
  FACTORY:  { cost: 400, energy: 55, hp: 650, vision: 0.10 },
  DEPOT:    { cost: 160, energy: 18, hp: 430, vision: 0.09 },
  RADAR:    { cost: 300, energy: 35, hp: 320, vision: 0.36 },
  POWER:    { cost: 180, energy: 0, hp: 360, vision: 0.08 },
  WORKSHOP: { cost: 340, energy: 65, hp: 560, vision: 0.10 },
  BUNKER:   { cost: 240, energy: 42, hp: 720, vision: 0.11 },
  SAM:      { cost: 280, energy: 50, hp: 410, vision: 0.20 }
};

const TECHNOLOGY = {
  WEAPONS: { max: 3, costs: [260, 430, 680], label: 'Armamento' },
  ARMOR:   { max: 3, costs: [240, 410, 650], label: 'Blindaje' },
  ENGINES: { max: 2, costs: [300, 520], label: 'Motores' },
  ECONOMY: { max: 3, costs: [350, 550, 800], label: 'Logística' },
  RADAR:   { max: 1, costs: [420], label: 'Radar avanzado' }
};

// --- Colocación de edificios (unidades de ALTO: el mapa es más ancho que alto) ---
const ASPECT = 2.35;
const BASE_RANGE = 0.52;
const FOOTPRINT = {
  HQ: 0.105, FACTORY: 0.085, BARRACKS: 0.08, WORKSHOP: 0.075, BUNKER: 0.075,
  RADAR: 0.065, SAM: 0.065, DEPOT: 0.065, POWER: 0.06, TURRET: 0.055
};
const BUILD_REQUIRES = { FACTORY: 'BARRACKS', WORKSHOP: 'FACTORY', SAM: 'RADAR' };
const UNIT_REQUIRES = { HEAVY_TANK: 'WORKSHOP' };
const VEHICLES = ['TANK', 'HEAVY_TANK', 'APC', 'ARTILLERY', 'ROCKET'];
const aDistance = (a, b) => Math.hypot((a.x - b.x) * ASPECT, a.y - b.y);

const clamp = (v, a, b) =>
  Math.max(a, Math.min(b, Number(v) || 0));

const distance = (a, b) =>
  Math.hypot(a.x - b.x, a.y - b.y);

class GameEngine {
  constructor(room) {
    this.roomId = room.id;
    this.tick = 0;
    this.time = 0;
    this.nextId = 1;

    this.players = {};
    this.units = [];
    this.buildings = [];
    this.resources = [];
    this.terrain = [];
    this.obstacles = [];
    this.controlPoints = [];

    this.winner = null;
    this.startedAt = Date.now();
    this.map = room.map || 'default';
    this.spawnPoints = createSpawnLayout();
    this.mapSize = /small|peque/i.test(this.map) ? 'small' : /huge|enorme/i.test(this.map) ? 'huge' : 'large';
    this.generateBattlefield();

    this.playerCount = Math.max(
      2,
      Math.min(PLAYER_SLOTS, room.players?.size || 2)
    );

    // Debe coincidir con la rejilla 64x40 del cliente Android para que
    // exploredCells se importe sin reinterpretar coordenadas.
    this.lastReject = '';
    this.fogGridWidth = 64;
    this.fogGridHeight = 40;
    this.explored = new Map();

    // Nueve minas neutrales: misma distribución y reservas que Android local.
    const neutralMines = [
      [0.50, 0.50, 2500], [0.30, 0.32, 2500], [0.70, 0.32, 2500],
      [0.30, 0.68, 2500], [0.70, 0.68, 2500], [0.18, 0.50, 1800],
      [0.82, 0.50, 1800], [0.50, 0.12, 1800], [0.50, 0.88, 1800]
    ];
    for (const [rx, ry, amount] of neutralMines) {
      this.resources.push({ id: this.nextId++, x: rx, y: ry, amount });
    }
  }

  generateBattlefield() {
    // Los mapas conservan coordenadas normalizadas para que Android y web compartan el protocolo.
    const count = this.mapSize === 'small' ? 10 : this.mapSize === 'large' ? 28 : this.mapSize === 'huge' ? 42 : 20;
    const seed = [...String(this.roomId)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 17);
    let state = seed || 1;
    const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
    const kinds = ['forest', 'rock', 'water', 'crater', 'highland'];
    for (let i = 0; i < count; i++) {
      const x = 0.16 + rand() * 0.68, y = 0.16 + rand() * 0.68;
      // Mantener despejadas las zonas de aparición.
      if (this.spawnPoints.some(sp => Math.hypot(sp.x - x, sp.y - y) < 0.17)) continue;
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const radius = 0.018 + rand() * (this.mapSize === 'huge' ? 0.035 : 0.025);
      this.terrain.push({ id: i + 1, kind, x, y, radius, movement: kind === 'water' || kind === 'rock' ? 0.55 : kind === 'forest' ? 0.78 : 1.08, cover: kind === 'forest' ? 0.28 : kind === 'highland' ? 0.16 : 0 });
      if (kind === 'rock' || kind === 'water') this.obstacles.push({ id: i + 1, kind, x, y, radius });
    }
    // Cinco objetivos neutrales de control, separados de los HQ.
    const sites = [{x:.5,y:.5},{x:.5,y:.20},{x:.5,y:.80},{x:.22,y:.5},{x:.78,y:.5},{x:.22,y:.25},{x:.78,y:.25},{x:.22,y:.75},{x:.78,y:.75}];
    sites.forEach((pt, i) => this.controlPoints.push({ id: i + 1, x: pt.x, y: pt.y, owner: null, progress: {}, income: 12, radius: 0.055 }));
  }

  terrainAt(x, y) {
    return this.terrain.filter(t => Math.hypot(t.x - x, t.y - y) <= t.radius);
  }

  blocked(x, y, radius = 0.012) {
    return this.obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.radius + radius);
  }

  // A* sobre una rejilla 64x40 compartida con la niebla de guerra.
  // El coste incorpora terreno lento; agua y roca son impasables.
  findPath(start, destination) {
    const W = this.fogGridWidth || 64;
    const H = this.fogGridHeight || 40;
    const toCell = (v, max) => Math.max(0, Math.min(max - 1, Math.floor(v * max)));
    const key = (x, y) => y * W + x;
    const sx = toCell(start.x, W), sy = toCell(start.y, H);
    let gx = toCell(destination.x, W), gy = toCell(destination.y, H);
    const cellPoint = (x, y) => ({ x: (x + 0.5) / W, y: (y + 0.5) / H });
    const blockedCell = (x, y) => {
      const p = cellPoint(x, y);
      return this.blocked(p.x, p.y, 0.006);
    };
    // Si el punto exacto cae en un obstáculo, busca una celda libre cercana.
    if (blockedCell(gx, gy)) {
      let found = null;
      for (let r = 1; r <= 6 && !found; r++) {
        for (let y = Math.max(0, gy-r); y <= Math.min(H-1, gy+r) && !found; y++) {
          for (let x = Math.max(0, gx-r); x <= Math.min(W-1, gx+r); x++) {
            if (!blockedCell(x, y)) { found = {x,y}; break; }
          }
        }
      }
      if (found) { gx = found.x; gy = found.y; }
    }
    if (blockedCell(gx, gy)) return [];
    const startKey = key(sx, sy), goalKey = key(gx, gy);
    if (startKey === goalKey) return [{x: destination.x, y: destination.y}];

    // Min-heap para evitar ordenar todo el conjunto abierto en cada iteración.
    const heap = [];
    const push = node => {
      heap.push(node);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].f <= node.f) break;
        heap[i] = heap[p]; i = p;
      }
      heap[i] = node;
    };
    const pop = () => {
      const root = heap[0], tail = heap.pop();
      if (heap.length) {
        let i = 0;
        while (true) {
          let c = i * 2 + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && heap[c+1].f < heap[c].f) c++;
          if (heap[c].f >= tail.f) break;
          heap[i] = heap[c]; i = c;
        }
        heap[i] = tail;
      }
      return root;
    };
    const heuristic = (x,y) => Math.hypot(gx-x, gy-y);
    const gScore = new Map([[startKey, 0]]);
    const cameFrom = new Map();
    const closed = new Set();
    push({x:sx,y:sy,k:startKey,f:heuristic(sx,sy)});
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let reached = false, visits = 0;
    while (heap.length && visits++ < W * H) {
      const cur = pop();
      if (closed.has(cur.k)) continue;
      if (cur.k === goalKey) { reached = true; break; }
      closed.add(cur.k);
      for (const [dx,dy] of dirs) {
        const x = cur.x + dx, y = cur.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= H || blockedCell(x,y)) continue;
        if (dx && dy && (blockedCell(cur.x+dx,cur.y) || blockedCell(cur.x,cur.y+dy))) continue;
        const p = cellPoint(x,y);
        const terrain = this.terrainAt(p.x,p.y);
        const slow = terrain.some(t => t.kind === 'forest') ? 1.3 :
          terrain.some(t => t.kind === 'highland') ? 0.9 : 1;
        const step = (dx && dy ? 1.4142 : 1) * slow;
        const k = key(x,y), tentative = (gScore.get(cur.k) ?? Infinity) + step;
        if (tentative >= (gScore.get(k) ?? Infinity)) continue;
        cameFrom.set(k, cur.k);
        gScore.set(k, tentative);
        push({x,y,k,f:tentative+heuristic(x,y)});
      }
    }
    if (!reached) return [];
    const cells = [];
    let cursor = goalKey;
    while (cursor !== startKey) {
      const x = cursor % W, y = Math.floor(cursor / W);
      cells.push(cellPoint(x,y));
      cursor = cameFrom.get(cursor);
      if (cursor == null) return [];
    }
    cells.reverse();
    // Reduce puntos consecutivos colineales sin alterar el recorrido.
    const compact = [];
    for (let i=0; i<cells.length; i++) {
      if (i === cells.length-1) { compact.push(cells[i]); continue; }
      const a = i === 0 ? {x:sx,y:sy} : {x:Math.round(cells[i-1].x*W-.5),y:Math.round(cells[i-1].y*H-.5)};
      const b = {x:Math.round(cells[i].x*W-.5),y:Math.round(cells[i].y*H-.5)};
      const c = {x:Math.round(cells[i+1].x*W-.5),y:Math.round(cells[i+1].y*H-.5)};
      if ((b.x-a.x)!==(c.x-b.x) || (b.y-a.y)!==(c.y-b.y)) compact.push(cells[i]);
    }
    compact.push({x:destination.x,y:destination.y});
    return compact;
  }

  setDestination(unit, x, y) {
    unit.targetX = clamp(x, 0.01, 0.99);
    unit.targetY = clamp(y, 0.01, 0.99);
    unit.destinationX = unit.targetX;
    unit.destinationY = unit.targetY;
    unit.path = this.findPath(unit, {x:unit.targetX, y:unit.targetY});
    unit.pathIndex = 0;
    if (unit.path.length) {
      unit.targetX = unit.path[0].x;
      unit.targetY = unit.path[0].y;
    }
  }

  movementFactor(unit, x, y) {
    const terrain = this.terrainAt(x, y);
    if (terrain.some(t => t.kind === 'water' || t.kind === 'rock')) return 0.35;
    if (terrain.some(t => t.kind === 'forest')) return 0.72;
    if (terrain.some(t => t.kind === 'highland')) return 1.12;
    return 1;
  }

  getSpawnPosition(slot) {
    const i = Math.max(0, Math.min(this.spawnPoints.length - 1, Number(slot) || 0));
    return { ...this.spawnPoints[i] };
  }

  /* Direccion desde la base hacia el centro del mapa. */
  inwardDirection(position) {
    return {
      sx: position.x < 0.5 ? 1 : -1,
      sy: position.y < 0.5 ? 1 : -1
    };
  }

  /* Segundos de paz que quedan (0 = ya se puede combatir). */
  peaceRemaining() {
    return Math.max(0, PEACE_SECONDS - this.time);
  }

  isPeace() {
    return this.time < PEACE_SECONDS;
  }

  addPlayer(player) {
    if (!player || !player.id) return false;
    if (this.players[player.id]) return false;

    const slot = clamp(
      player.slot,
      0,
      PLAYER_SLOTS - 1
    );

    const position = this.getSpawnPosition(slot);
    const x = position.x;
    const y = position.y;

    this.players[player.id] = {
      id: player.id,
      name: String(player.name || 'Jugador').slice(0, 20),
      slot,
      bot: !!player.bot,

      credits: 550,
      energy: 150, maxEnergy: 200, energyProduced: 0,
      productionQueue: [],
      economy: 1,
      technologies: { WEAPONS: 0, ARMOR: 0, ENGINES: 0, ECONOMY: 0, RADAR: 0 },

      alive: true,
      score: 0,

      kills: 0,
      produced: 0,
      built: 0,

      incomeTimer: 0
    };

    this.explored.set(player.id, new Set());

    this.buildings.push({
      id: this.nextId++, owner: player.id, type: 'HQ', x, y,
      health: BUILDING.HQ.hp, maxHealth: BUILDING.HQ.hp
    });
    this.buildings.push({
      id: this.nextId++, owner: player.id, type: 'POWER',
      x: clamp(x + (x < 0.5 ? 1 : -1) * 0.15, 0.03, 0.97),
      y: clamp(y - (y < 0.5 ? 1 : -1) * 0.10, 0.03, 0.97),
      health: BUILDING.POWER.hp, maxHealth: BUILDING.POWER.hp
    });
    // Base inicial igual al motor Android: HQ, planta y cuartel.
    this.buildings.push({
      id: this.nextId++, owner: player.id, type: 'BARRACKS',
      x: clamp(x + (x < 0.5 ? 1 : -1) * 0.10, 0.03, 0.97),
      y: clamp(y + (y < 0.5 ? 1 : -1) * 0.08, 0.03, 0.97),
      health: BUILDING.BARRACKS.hp, maxHealth: BUILDING.BARRACKS.hp
    });

    const dir = this.inwardDirection(position);

    // Mina propia cerca de la base (hacia el centro).
    this.resources.push({
      id: this.nextId++,
      x: clamp(x + dir.sx * 0.13, 0.04, 0.96),
      y: clamp(y + dir.sy * 0.19, 0.04, 0.96),
      amount: 2000
    });

    this.units.push({
      id: this.nextId++,
      owner: player.id,
      type: 'COMMANDER',
      x,
      y: clamp(y + dir.sy * 0.04, 0.04, 0.96),
      health: UNIT.COMMANDER.hp,
      cooldown: 0,
      targetX: null,
      targetY: null,
      targetId: null,
      attackMove: false,
      gatherId: null,
      carrying: 0,
      selected: false
    });
    // Fuerza inicial igual a Android para que online y local comiencen equilibrados.
    this.units.push({
      id: this.nextId++, owner: player.id, type: 'TANK',
      x: clamp(x + dir.sx * 0.05, 0.03, 0.97),
      y: clamp(y + dir.sy * 0.19, 0.03, 0.97),
      health: UNIT.TANK.hp, maxHealth: UNIT.TANK.hp,
      cooldown: 0, targetX: null, targetY: null, targetId: null,
      attackMove: false, gatherId: null, carrying: 0, selected: false
    });
    this.units.push({
      id: this.nextId++, owner: player.id, type: 'SOLDIER',
      x: clamp(x - dir.sx * 0.05, 0.03, 0.97),
      y: clamp(y + dir.sy * 0.19, 0.03, 0.97),
      health: UNIT.SOLDIER.hp, maxHealth: UNIT.SOLDIER.hp,
      cooldown: 0, targetX: null, targetY: null, targetId: null,
      attackMove: false, gatherId: null, carrying: 0, selected: false
    });

    return true;
  }

  removePlayer(playerId) {
    delete this.players[playerId];
    this.explored.delete(playerId);

    this.units = this.units.filter(
      u => u.owner !== playerId
    );

    this.buildings = this.buildings.filter(
      b => b.owner !== playerId
    );
  }

  player(playerId) {
    return this.players[playerId];
  }

  getPlayerBySlot(slot) {
    return Object.values(this.players).find(
      p => p.slot === Number(slot)
    );
  }

  getVisionRadius(unit) {
    return UNIT[unit.type]?.vision || 0.12;
  }

  computeVisibility(playerId) {
    const visible = new Set();
    const explored = this.explored.get(playerId) || new Set();

    const sources = [
      ...this.units
        .filter(u => u.owner === playerId)
        .map(u => ({
          x: u.x,
          y: u.y,
          radius: this.getVisionRadius(u) + ((this.player(playerId)?.technologies?.RADAR || 0) * 0.025)
        })),

      ...this.buildings
        .filter(b => b.owner === playerId)
        .map(b => ({
          x: b.x,
          y: b.y,
          radius: BUILDING[b.type]?.vision || 0.09
        }))
    ];

    for (const source of sources) {
      const minX = Math.max(
        0,
        Math.floor((source.x - source.radius) * this.fogGridWidth)
      );

      const maxX = Math.min(
        this.fogGridWidth - 1,
        Math.ceil((source.x + source.radius) * this.fogGridWidth)
      );

      const minY = Math.max(
        0,
        Math.floor((source.y - source.radius) * this.fogGridHeight)
      );

      const maxY = Math.min(
        this.fogGridHeight - 1,
        Math.ceil((source.y + source.radius) * this.fogGridHeight)
      );

      for (let gy = minY; gy <= maxY; gy++) {
        for (let gx = minX; gx <= maxX; gx++) {
          const cx = (gx + 0.5) / this.fogGridWidth;
          const cy = (gy + 0.5) / this.fogGridHeight;

          if (
            Math.hypot(cx - source.x, cy - source.y) <=
            source.radius
          ) {
            const key = `${gx},${gy}`;
            visible.add(key);
            explored.add(key);
          }
        }
      }
    }

    this.explored.set(playerId, explored);

    return { visible, explored };
  }

  isVisibleTo(playerId, object) {
    const { visible } = this.computeVisibility(playerId);

    const gx = Math.floor(object.x * this.fogGridWidth);
    const gy = Math.floor(object.y * this.fogGridHeight);

    return visible.has(`${gx},${gy}`);
  }

  recruit(playerId, type, x, y, producerBuildingId = null) {
    type = String(type || '').toUpperCase();
    this.lastReject = '';

    const spec = UNIT[type];
    const p = this.player(playerId);

    if (!spec || !p || !p.alive) { this.lastReject = 'Unidad no disponible'; return false; }
    const factoryUnits = ['TANK', 'ARTILLERY', 'ROCKET', 'APC', 'HEAVY_TANK'];
    const required = factoryUnits.includes(type) ? ['FACTORY'] : ['BARRACKS'];
    const wantedId = Number(producerBuildingId);
    let base = null;
    if (wantedId > 0) {
      base = this.buildings.find(b => b.id === wantedId && b.owner === playerId && required.includes(b.type)) || null;
    }
    if (!base) base = this.buildings.find(b => b.owner === playerId && required.includes(b.type));

    if (!base) { this.lastReject = factoryUnits.includes(type) ? 'Requiere una FÁBRICA' : 'Requiere un CUARTEL'; return false; }
    const unitReq = UNIT_REQUIRES[type];
    if (unitReq && !this.buildings.some(b => b.owner === playerId && b.type === unitReq)) { this.lastReject = `Requiere ${unitReq}`; return false; }

    const queue = p.productionQueue || (p.productionQueue = []);
    if (this.units.filter(u => u.owner === playerId).length + queue.length >= 800) { this.lastReject = 'Límite de unidades alcanzado'; return false; }
    const buildingQueueSize = queue.filter(order => Number(order.producerId) === Number(base.id)).length;
    if (buildingQueueSize >= 20) { this.lastReject = 'Cola de este edificio llena (máximo 20)'; return false; }
    // Se reserva el espacio, pero los recursos solo se cobran cuando el edificio inicia la orden.
    queue.push({ type, producerId: base.id, remaining: spec.trainSeconds || 15, total: spec.trainSeconds || 15, started: false });

    // Las unidades se crean al terminar su tiempo de fabricación.
    // (angulo aureo) hacia el interior del mapa.
    const n = this.units.filter(u => u.owner === playerId).length;
    const ang = n * 2.399963;
    const r = 0.045 + (n % 4) * 0.012;
    const dir = this.inwardDirection(base);

    const spawnX = base.x + Math.abs(Math.cos(ang)) * r * dir.sx;
    const spawnY = base.y + Math.sin(ang) * r;

    let spawn = { x: clamp(spawnX, 0.02, 0.98), y: clamp(spawnY, 0.02, 0.98) };
    if (this.blocked(spawn.x, spawn.y)) {
      const alternatives = Array.from({length: 12}, (_, i) => ({ x: clamp(spawn.x + Math.cos(i * Math.PI / 6) * 0.035, 0.02, 0.98), y: clamp(spawn.y + Math.sin(i * Math.PI / 6) * 0.035, 0.02, 0.98) }));
      spawn = alternatives.find(pt => !this.blocked(pt.x, pt.y)) || spawn;
    }
    return true;
  }

  /* Motivo por el que no se puede colocar `type` en (x, y), o null si el sitio es válido. */
  placementError(playerId, type, x, y, hq) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0.04 || x > 0.96 || y < 0.04 || y > 0.96) return 'Fuera del mapa';
    if (aDistance(hq, { x, y }) > BASE_RANGE) return 'Fuera del radio de la base';
    const f = FOOTPRINT[type] || 0.07;
    if (this.buildings.some(b => aDistance(b, { x, y }) < (FOOTPRINT[b.type] || 0.07) + f + 0.02)) return 'Demasiado cerca de otro edificio';
    if (this.obstacles.some(o => aDistance(o, { x, y }) < o.radius + f * 0.6)) return 'Terreno bloqueado';
    if (this.resources.some(r => r.amount > 0 && aDistance(r, { x, y }) < 0.05 + f * 0.6)) return 'Hay una mina en ese lugar';
    return null;
  }

  /* Primer hueco libre dentro del radio de la base, empezando hacia el centro del mapa. */
  findBuildSpot(playerId, type, hq) {
    const baseAng = Math.atan2(0.5 - hq.y, (0.5 - hq.x) * ASPECT);
    for (let r = (FOOTPRINT.HQ || 0.1) + (FOOTPRINT[type] || 0.07) + 0.03; r <= BASE_RANGE; r += 0.025) {
      for (let i = 0; i < 24; i++) {
        const step = Math.floor((i + 1) / 2);
        const sign = i % 2 === 0 ? 1 : -1;
        const ang = baseAng + sign * step * (Math.PI * 2 / 24);
        const x = hq.x + Math.cos(ang) * r / ASPECT;
        const y = hq.y + Math.sin(ang) * r;
        if (!this.placementError(playerId, type, x, y, hq)) return { x, y };
      }
    }
    return null;
  }

  build(playerId, type, x, y, builderBuildingId = null) {
    type = String(type || '').toUpperCase();
    this.lastReject = '';

    const spec = BUILDING[type];
    const p = this.player(playerId);

    if (!spec || type === 'HQ' || !p || !p.alive) {
      this.lastReject = 'Edificio no disponible';
      return false;
    }

    if (p.credits < spec.cost) { this.lastReject = `Créditos insuficientes (necesitas ${spec.cost})`; return false; }
    if (p.energy < (spec.energy || 0)) { this.lastReject = `Energía insuficiente (necesitas ${spec.energy || 0})`; return false; }

    const wantedId = Number(builderBuildingId);
    const hq = (wantedId > 0 && this.buildings.find(b => b.id === wantedId && b.owner === playerId && b.type === 'HQ')) ||
      this.buildings.find(b => b.owner === playerId && b.type === 'HQ');
    if (!hq) { this.lastReject = 'No tienes cuartel general'; return false; }

    const need = BUILD_REQUIRES[type];
    if (need && !this.buildings.some(b => b.owner === playerId && b.type === need)) { this.lastReject = `Requiere ${need}`; return false; }

    // Sin coordenadas válidas (IA, botón AUTO): hueco libre automático.
    const hasPos = x !== null && x !== undefined && x !== '' && y !== null && y !== undefined && y !== '' &&
      Number.isFinite(Number(x)) && Number.isFinite(Number(y));
    let spot = hasPos ? { x: Number(x), y: Number(y) } : this.findBuildSpot(playerId, type, hq);
    if (!spot) { this.lastReject = 'No hay espacio libre en la base'; return false; }

    const placeError = this.placementError(playerId, type, spot.x, spot.y, hq);
    if (placeError) { this.lastReject = placeError; return false; }

    p.credits -= spec.cost;
    p.energy -= spec.energy || 0;

    this.buildings.push({
      id: this.nextId++,
      owner: playerId,
      type,
      x: spot.x,
      y: spot.y,
      health: spec.hp, maxHealth: spec.hp
    });

    p.built++;
    return true;
  }

  research(playerId, technology) {
    const key = String(technology || '').toUpperCase();
    const spec = TECHNOLOGY[key];
    const p = this.player(playerId);
    if (!p || !p.alive || !spec) return false;
    p.technologies ||= { WEAPONS: 0, ARMOR: 0, ENGINES: 0, ECONOMY: 0, RADAR: 0 };
    const level = Number(p.technologies[key] || 0);
    if (level >= spec.max) return false;
    const required = key === 'WEAPONS' || key === 'ARMOR' ? ['WORKSHOP'] :
      key === 'ENGINES' ? ['WORKSHOP', 'FACTORY'] :
      key === 'ECONOMY' ? ['DEPOT'] : ['RADAR'];
    if (!required.every(type => this.buildings.some(b => b.owner === playerId && b.type === type))) return false;
    const cost = spec.costs[level];
    if (p.credits < cost) return false;
    p.credits -= cost;
    p.technologies[key] = level + 1;
    if (key === 'ECONOMY') p.economy = Math.min(5, p.economy + 1);
    if (key === 'RADAR') p.radarBonus = true;
    return true;
  }

  repair(playerId, targetId) {
    const target = this.buildings.find(b => b.id === Number(targetId) && b.owner === playerId);
    const p = this.player(playerId);
    if (!target || !p || !p.alive || target.health >= (target.maxHealth || BUILDING[target.type]?.hp || 300)) return false;
    if (p.credits < 35) { this.lastReject = 'Créditos insuficientes para reparar (35)'; return false; }
    p.credits -= 35;
    target.health = Math.min(target.maxHealth || BUILDING[target.type]?.hp || 300, target.health + 90);
    return true;
  }

  upgradeEconomy(playerId) {
    const p = this.player(playerId);

    if (!p || !p.alive) return false;
    if (p.economy >= 5 || p.credits < 500) {
      return false;
    }

    p.credits -= 500;
    p.economy++;

    return true;
  }

  command(playerId, command) {
    const c = command || {};

    const action = String(
      c.action || c.type || c.kind || ''
    ).toLowerCase();

    if (action === 'recruit' || action === 'train') {
      return this.recruit(
        playerId,
        c.unitType || c.unit || c.kind,
        c.x,
        c.y,
        c.producerBuildingId
      );
    }

    if (action === 'build') {
      return this.build(
        playerId,
        c.buildingType || c.building || c.kind,
        c.x,
        c.y,
        c.builderBuildingId
      );
    }

    if (action === 'upgrade') return this.upgradeEconomy(playerId);
    if (action === 'research' || action === 'technology') return this.research(playerId, c.technology || c.tech || c.upgrade);
    if (action === 'repair') return this.repair(playerId, c.buildingId || c.targetId);

    let ids = Array.isArray(c.unitIds)
      ? c.unitIds.map(Number)
      : [];

    if (c.unitId != null) ids.push(Number(c.unitId));
    if (c.attackerId != null) ids.push(Number(c.attackerId));

    const selected = this.units.filter(u =>
      u.owner === playerId &&
      ids.includes(Number(u.id))
    );

    if (
      action === 'move' ||
      action === 'attack_move' ||
      action === 'attack'
    ) {
      if (!selected.length) return false;

      // Formacion: un grupo no se apila en un solo punto, se reparte en
      // cuadricula centrada en el destino.
      const formation = new Map();

      if (selected.length > 1 && action !== 'attack') {
        const cols = Math.ceil(Math.sqrt(selected.length));
        const rows = Math.ceil(selected.length / cols);
        const cx = clamp(c.x ?? c.targetX, 0.01, 0.99);
        const cy = clamp(c.y ?? c.targetY, 0.01, 0.99);

        selected.forEach((u, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);

          formation.set(u.id, {
            x: clamp(cx + (col - (cols - 1) / 2) * 0.03, 0.01, 0.99),
            y: clamp(cy + (row - (rows - 1) / 2) * 0.045, 0.01, 0.99)
          });
        });
      }

      for (const u of selected) {
        u.gatherId = null;

        if (action === 'attack' && c.targetId != null) {
          // Durante la fase de paz no se pueden dar ordenes de ataque.
          if (this.isPeace()) continue;

          const targetId = Number(c.targetId);

          const target =
            this.units.find(a =>
              a.id === targetId && a.owner !== playerId
            ) ||
            this.buildings.find(a =>
              a.id === targetId && a.owner !== playerId
            );

          // No se puede ordenar atacar un enemigo que no se ve.
          if (!target || !this.isVisibleTo(playerId, target)) {
            continue;
          }

          u.targetId = target.id;
          this.setDestination(u, target.x, target.y);
          u.attackMove = false;
        } else {
          u.targetId = null;
          const spot = formation.get(u.id);

          this.setDestination(
            u,
            spot ? spot.x : clamp(c.x ?? c.targetX, 0.01, 0.99),
            spot ? spot.y : clamp(c.y ?? c.targetY, 0.01, 0.99)
          );
          u.attackMove = action === 'attack_move';
        }
      }

      return true;
    }

    if (action === 'gather') {
      if (!selected.length) return false;

      const node = this.resources.find(
        n => n.id === Number(c.resourceId)
      ) || this.resources
        .filter(n => n.amount > 0)
        .sort((a, b) =>
          distance(a, selected[0]) -
          distance(b, selected[0])
        )[0];

      if (!node) return false;

      selected.forEach(u => {
        this.setDestination(u, node.x, node.y);
        u.targetId = null;
        u.gatherId = node.id;
        u.attackMove = false;
      });

      return true;
    }

    return false;
  }

  findNearbyEnemy(unit, radius) {
    const candidates = [
      ...this.units.filter(a =>
        a.owner !== unit.owner &&
        a.health > 0 &&
        distance(unit, a) <= radius
      ),
      ...this.buildings.filter(b =>
        b.owner !== unit.owner &&
        b.health > 0 &&
        distance(unit, b) <= radius
      )
    ];

    return candidates.sort(
      (a, b) => distance(unit, a) - distance(unit, b)
    )[0] || null;
  }

  damageTarget(attacker, target, damage) {
    if (this.isPeace()) return;

    const armor = (UNIT[target.type]?.armor || (BUILDING[target.type] ? 5 : 0)) + ((this.player(target.owner)?.technologies?.ARMOR || 0) * 2);
    const weaponLevel = this.player(attacker.owner)?.technologies?.WEAPONS || 0;
    damage *= 1 + weaponLevel * 0.12;
    const cover = this.terrainAt(target.x, target.y).reduce((m, t) => Math.max(m, t.cover || 0), 0);
    target.health -= Math.max(1, damage * (1 - Math.min(0.65, armor * 0.025 + cover)));

    if (target.health > 0) return;

    const deadUnit = this.units.find(
      u => u.id === target.id
    );

    const deadBuilding = this.buildings.find(
      b => b.id === target.id
    );

    const killer = this.player(attacker.owner);

    if (killer) {
      killer.kills++;
      killer.score += 10;
    }

    this.units = this.units.filter(
      u => u.id !== target.id
    );

    this.buildings = this.buildings.filter(
      b => b.id !== target.id
    );

    if (deadBuilding?.type === 'HQ') {
      const defeated = this.player(deadBuilding.owner);
      if (defeated) defeated.alive = false;
    }

    if (deadUnit?.type === 'COMMANDER') {
      const defeated = this.player(deadUnit.owner);

      if (defeated) {
        defeated.alive = this.buildings.some(
          b => b.owner === deadUnit.owner &&
            b.type === 'HQ'
        );
      }
    }
  }

  update(dt = 0.1) {
    this.tick++;
    this.time += dt;

    // Economía.
    for (const p of Object.values(this.players)) {
      if (!p.alive) continue;

      p.incomeTimer += dt;

      if (p.incomeTimer >= 3) {
        const n = Math.floor(p.incomeTimer / 3);
        p.incomeTimer -= n * 3;
        const hqs = this.buildings.filter(b => b.owner === p.id && b.type === 'HQ').length;
        const depots = Math.min(3, this.buildings.filter(b => b.owner === p.id && b.type === 'DEPOT').length);
        const power = Math.min(3, this.buildings.filter(b => b.owner === p.id && b.type === 'POWER').length);
        p.credits += n * (12 + hqs * 3 + depots * 4 + power * 3) * Math.max(1, p.economy);
      }
      const powerPlants = this.buildings.filter(b => b.owner === p.id && b.type === 'POWER').length;
      p.maxEnergy = 100 + Math.min(5, powerPlants) * 100;
      p.energy = Math.min(p.maxEnergy, p.energy + (powerPlants > 0 ? powerPlants * dt * 2.0 : dt / 3));
      // Cada edificio productor avanza su propia cola, sin bloquear a los demás.
      const producerIds = [...new Set((p.productionQueue || []).map(order => Number(order.producerId)))];
      for (const producerId of producerIds) {
        const order = p.productionQueue.find(item => Number(item.producerId) === producerId);
        if (!order) continue;
        const producer = this.buildings.find(b => b.id === producerId && b.owner === p.id);
        if (!producer) { p.productionQueue = p.productionQueue.filter(item => Number(item.producerId) !== producerId); continue; }
        const spec = UNIT[order.type];
        if (!spec) { p.productionQueue = p.productionQueue.filter(item => item !== order); continue; }
        if (!order.started) {
          if (p.credits < spec.cost || p.energy < (spec.energy || 0)) continue; // Espera recursos; conserva turno.
          p.credits -= spec.cost;
          p.energy -= spec.energy || 0;
          order.started = true;
        }
        if (this.units.filter(u => u.owner === p.id).length >= 800) continue;
        order.remaining = Math.max(0, order.remaining - dt);
        if (order.remaining <= 0.00001) {
          const n = this.units.filter(u => u.owner === p.id).length;
          const ang = n * 2.399963, r = 0.045 + (n % 4) * 0.012, dir = this.inwardDirection(producer);
          let spawn = { x: clamp(producer.x + Math.abs(Math.cos(ang)) * r * dir.sx, 0.02, 0.98), y: clamp(producer.y + Math.sin(ang) * r, 0.02, 0.98) };
          if (this.blocked(spawn.x, spawn.y)) {
            const alt = Array.from({length: 16}, (_, i) => ({x:clamp(spawn.x+Math.cos(i*Math.PI/8)*.04,.02,.98),y:clamp(spawn.y+Math.sin(i*Math.PI/8)*.04,.02,.98)}));
            spawn = alt.find(pt => !this.blocked(pt.x,pt.y)) || spawn;
          }
          this.units.push({ id:this.nextId++, owner:p.id, type:order.type, x:spawn.x, y:spawn.y, health:spec.hp, maxHealth:spec.hp, cooldown:0, targetX:null, targetY:null, targetId:null, attackMove:false, gatherId:null, carrying:0, selected:false });
          p.produced++;
          p.productionQueue.splice(p.productionQueue.indexOf(order), 1);
        }
      }
    }

    // Movimiento, combate y recolección.
    for (const u of [...this.units]) {
      const spec = UNIT[u.type];
      if (!spec) continue;

      u.cooldown = Math.max(0, u.cooldown - dt);

      if (u.type === 'MEDIC') {
        const ally = this.units
          .filter(a =>
            a.owner === u.owner &&
            a.health < UNIT[a.type].hp
          )
          .sort((a, b) =>
            distance(u, a) - distance(u, b)
          )[0];

        if (
          ally &&
          distance(u, ally) < spec.range &&
          u.cooldown <= 0
        ) {
          ally.health = Math.min(
            UNIT[ally.type].hp,
            ally.health + 12
          );

          u.cooldown = spec.cooldown;
          continue;
        }
      }

      let target = null;

      // Mantener el objetivo que el jugador ordenó atacar.
      if (u.targetId != null) {
        target =
          this.units.find(a =>
            a.id === u.targetId &&
            a.owner !== u.owner
          ) ||
          this.buildings.find(a =>
            a.id === u.targetId &&
            a.owner !== u.owner
          );

        if (!target) {
          u.targetId = null;
        }
      }

      // Ataque automático únicamente durante attack_move
      // y dentro del radio de visión de la unidad.
      if (!target && u.attackMove) {
        target = this.findNearbyEnemy(
          u,
          this.getVisionRadius(u)
        );

        if (target) {
          u.targetId = target.id;
        }
      }

      // Defensa propia: una unidad que no tiene orden dispara a los
      // enemigos que entren en su alcance de arma, pero NO los persigue.
      // Tampoco existe adquisición global de enemigos lejanos.
      if (
        !target &&
        u.targetX == null &&
        !this.isPeace() &&
        u.type !== 'MEDIC'
      ) {
        const inRange = this.findNearbyEnemy(u, spec.range);
        if (inRange) target = inRange;
      }

      if (target && distance(u, target) <= spec.range) {
        if (u.cooldown <= 0) {
          this.damageTarget(u, target, spec.damage);
          u.cooldown = spec.cooldown;
        }
      } else if (
        target &&
        target.x != null &&
        target.y != null
      ) {
        if (u.destinationX == null || Math.hypot(u.destinationX-target.x, u.destinationY-target.y) > 0.035) {
          this.setDestination(u, target.x, target.y);
        }
      }

      if (
        (!target || distance(u, target) > spec.range) &&
        u.targetX != null &&
        u.targetY != null
      ) {
        const dx = u.targetX - u.x;
        const dy = u.targetY - u.y;
        const d = Math.hypot(dx, dy);
        const engineLevel = this.player(u.owner)?.technologies?.ENGINES || 0;
        const step = spec.speed * dt * 1.6 * (1 + engineLevel * 0.12) * this.movementFactor(u, u.x, u.y);

        if (d <= step + 0.002) {
          if (!this.blocked(u.targetX, u.targetY)) { u.x = u.targetX; u.y = u.targetY; }
          if (Array.isArray(u.path) && u.pathIndex < u.path.length - 1) {
            u.pathIndex++;
            u.targetX = u.path[u.pathIndex].x;
            u.targetY = u.path[u.pathIndex].y;
            continue;
          }
          u.path = [];
          u.pathIndex = 0;
          u.destinationX = null;
          u.destinationY = null;

          if (u.gatherId != null) {
            const node = this.resources.find(
              n => n.id === u.gatherId
            );

            const p = this.player(u.owner);

            if (node && p && node.amount > 0) {
              u.gatherTimer = (u.gatherTimer || 0) + dt;

              // 5 creditos por segundo y recolector.
              if (u.gatherTimer >= 1) {
                u.gatherTimer -= 1;

                const take = Math.min(5, node.amount);

                node.amount -= take;
                p.credits += take;
                u.carrying = (u.carrying || 0) + take;
              }
            } else {
              u.gatherId = null;
              u.targetX = null;
              u.targetY = null;
              u.path = [];
              u.pathIndex = 0;
              u.destinationX = null;
              u.destinationY = null;
              u.carrying = 0;
            }
          }

          if (!u.attackMove && u.gatherId == null) {
            u.targetX = null;
            u.targetY = null;
            u.path = [];
            u.pathIndex = 0;
            u.destinationX = null;
            u.destinationY = null;
          }
        } else if (d > 0) {
          const nx = clamp(u.x + (dx / d) * step, 0.015, 0.985);
          const ny = clamp(u.y + (dy / d) * step, 0.015, 0.985);
          if (!this.blocked(nx, ny)) { u.x = nx; u.y = ny; }
          else {
            let moved = false;
            for (const turn of [0.65, -0.65, 1.2, -1.2, 1.8, -1.8]) {
              const a = Math.atan2(dy, dx) + turn;
              const sx = clamp(u.x + Math.cos(a) * step, 0.015, 0.985);
              const sy = clamp(u.y + Math.sin(a) * step, 0.015, 0.985);
              if (!this.blocked(sx, sy)) { u.x = sx; u.y = sy; moved = true; break; }
            }
            if (!moved) { u.targetX = null; u.targetY = null; }
          }
        }
      }
    }

    // Captura territorial: presencia sostenida, neutralización antes de cambiar de dueño.
    for (const point of this.controlPoints) {
      const presence = Object.values(this.players).filter(p => p.alive).map(p => ({
        id: p.id,
        strength: this.units.filter(u => u.owner === p.id && Math.hypot(u.x - point.x, u.y - point.y) <= point.radius).reduce((sum, u) => sum + (u.type === 'COMMANDER' ? 1.5 : u.type === 'HEAVY_TANK' ? 2 : 1), 0)
      })).filter(v => v.strength > 0).sort((a, b) => b.strength - a.strength);
      if (presence.length && (!presence[1] || presence[0].strength > presence[1].strength)) {
        const contender = presence[0];
        point.progress[contender.id] = Math.min(100, (point.progress[contender.id] || 0) + dt * 5 * contender.strength);
        if (point.owner && point.owner !== contender.id) point.progress[point.owner] = Math.max(0, (point.progress[point.owner] || 0) - dt * 7);
        if ((point.progress[contender.id] || 0) >= 100) point.owner = contender.id;
      }
    }
    if (this.tick % 10 === 0) for (const point of this.controlPoints) if (point.owner && this.players[point.owner]) this.players[point.owner].credits += point.income;

    // Defensas sincronizadas con Android: alcance, daño y cadencia por tipo.
    for (const b of this.buildings.filter(
      x => x.type === 'TURRET' || x.type === 'SAM' || x.type === 'BUNKER'
    )) {
      const defense = b.type === 'SAM'
        ? { range: 0.22, every: 8, damage: 34 }
        : b.type === 'BUNKER'
          ? { range: 0.13, every: 3, damage: 12 }
          : { range: 0.15, every: 5, damage: 18 };
      if (this.tick % defense.every !== 0 || this.isPeace()) continue;
      const enemy = this.units
        .filter(u => u.owner !== b.owner && distance(b, u) < defense.range)
        .sort((a, c) => distance(b, a) - distance(b, c))[0];
      if (enemy) this.damageTarget({ owner: b.owner }, enemy, defense.damage);
    }

    // Apoyo: los talleres reparan vehículos y edificios cercanos; los ingenieros reparan edificios propios.
    if (this.tick % 20 === 0) {
      for (const w of this.buildings.filter(b => b.type === 'WORKSHOP')) {
        for (const u of this.units) {
          const max = UNIT[u.type]?.hp;
          if (u.owner === w.owner && VEHICLES.includes(u.type) && max && u.health < max && aDistance(w, u) <= 0.20) {
            u.health = Math.min(max, u.health + 8);
          }
        }
        for (const b of this.buildings) {
          if (b.owner === w.owner && b.health < b.maxHealth && aDistance(w, b) <= 0.20) b.health = Math.min(b.maxHealth, b.health + 5);
        }
      }
      for (const e of this.units.filter(u => u.type === 'ENGINEER')) {
        const hurt = this.buildings
          .filter(b => b.owner === e.owner && b.health < b.maxHealth && aDistance(e, b) <= 0.10)
          .sort((a, b) => a.health - b.health)[0];
        if (hurt) hurt.health = Math.min(hurt.maxHealth, hurt.health + 6);
      }
    }

    for (const id of Object.keys(this.players)) {
      const p = this.players[id];

      p.alive =
        this.buildings.some(
          b => b.owner === id && b.type === 'HQ'
        ) ||
        this.units.some(u => u.owner === id);
    }

    const survivors = Object.values(this.players)
      .filter(p => p.alive);

    if (
      Object.keys(this.players).length > 1 &&
      survivors.length <= 1 &&
      !this.winner
    ) {
      this.winner = survivors[0]?.id || 'draw';
    }

    // Actualizar el descubrimiento de cada jugador.
    for (const id of Object.keys(this.players)) {
      this.computeVisibility(id);
    }
  }

  exportServerState() {
    return {
      roomId: this.roomId,
      tick: this.tick,
      map: this.map,
      players: Object.values(this.players),
      units: this.units,
      buildings: this.buildings,
      resources: this.resources,
      terrain: this.terrain, obstacles: this.obstacles, controlPoints: this.controlPoints,
      winner: this.winner,
      serverTime: Date.now()
    };
  }

  /*
   * Si se pasa viewerId, se filtra el estado:
   * - Todas las unidades y edificios propios.
   * - Enemigos dentro de la visión actual.
   * - Recursos dentro de zonas exploradas.
   *
   * Sin viewerId conserva el estado completo para uso interno.
   */
  exportState(viewerId = null) {
    const players = Object.values(this.players);

    const credits = Array(PLAYER_SLOTS).fill(0);
    const energy = Array(PLAYER_SLOTS).fill(0);
    const maxEnergy = Array(PLAYER_SLOTS).fill(0);
    const productionQueues = Array.from({ length: PLAYER_SLOTS }, () => []);
    const economy = Array(PLAYER_SLOTS).fill(1);
    const active = Array(PLAYER_SLOTS).fill(false);
    const kills = Array(PLAYER_SLOTS).fill(0);
    const produced = Array(PLAYER_SLOTS).fill(0);
    const built = Array(PLAYER_SLOTS).fill(0);
    const names = Array(PLAYER_SLOTS).fill('');
    const technologies = Array.from({ length: PLAYER_SLOTS }, () => ({ WEAPONS: 0, ARMOR: 0, ENGINES: 0, ECONOMY: 0, RADAR: 0 }));

    const slotById = {};

    for (const p of players) {
      const slot = Number(p.slot);
      if (slot < 0 || slot >= PLAYER_SLOTS) continue;

      slotById[p.id] = slot;

      credits[slot] = Math.max(0, Math.floor(p.credits));
      energy[slot] = Math.max(0, Math.floor(p.energy || 0));
      maxEnergy[slot] = Math.max(0, Math.floor(p.maxEnergy || 100));
      productionQueues[slot] = (p.productionQueue || []).map(q => ({ type:q.type, remaining:Number(q.remaining), total:Number(q.total), started:!!q.started }));
      economy[slot] = Math.max(1, Math.floor(p.economy || 1));
      active[slot] = !!p.alive;
      kills[slot] = Math.max(0, Math.floor(p.kills || 0));
      produced[slot] = Math.max(0, Math.floor(p.produced || 0));
      built[slot] = Math.max(0, Math.floor(p.built || 0));
      names[slot] = String(p.name || '').slice(0, 20);
      technologies[slot] = { ...(p.technologies || {}) };
    }

    let unitsToSend = this.units;
    let buildingsToSend = this.buildings;
    let resourcesToSend = this.resources;
    let visibleCells = [];
    let exploredCells = [];

    if (viewerId && this.players[viewerId]) {
      const { visible, explored } =
        this.computeVisibility(viewerId);

      const visibleObject = object => {
        const gx = Math.floor(object.x * this.fogGridWidth);
        const gy = Math.floor(object.y * this.fogGridHeight);
        return visible.has(`${gx},${gy}`);
      };

      unitsToSend = this.units.filter(u =>
        u.owner === viewerId || visibleObject(u)
      );

      buildingsToSend = this.buildings.filter(b =>
        b.owner === viewerId || visibleObject(b)
      );

      resourcesToSend = this.resources.filter(r => {
        const gx = Math.floor(r.x * this.fogGridWidth);
        const gy = Math.floor(r.y * this.fogGridHeight);
        return explored.has(`${gx},${gy}`);
      });

      visibleCells = [...visible];
      exploredCells = [...explored];
    }

    const units = unitsToSend.map(u => ({
      id: Number(u.id),
      owner: slotById[u.owner] ?? -1,
      type: u.type,
      x: Number(u.x),
      y: Number(u.y),
      health: Number(u.health),
      maxHealth: UNIT[u.type]?.hp || 100,
      selected: !!u.selected,
      targetX: u.targetX == null ? null : Number(u.targetX),
      targetY: u.targetY == null ? null : Number(u.targetY),
      cooldown: Number(u.cooldown || 0),
      carrying: Number(u.carrying || 0)
    }));

    const buildings = buildingsToSend.map(b => ({
      id: Number(b.id),
      owner: slotById[b.owner] ?? -1,
      type: b.type,
      x: Number(b.x),
      y: Number(b.y),
      health: Number(b.health),
      maxHealth: BUILDING[b.type]?.hp || 300
    }));

    const resources = resourcesToSend.map(r => ({
      id: Number(r.id),
      x: Number(r.x),
      y: Number(r.y),
      amount: Number(r.amount)
    }));

    return {
      roomId: this.roomId,
      tick: this.tick,
      map: this.map,
      players: players.length,
      units,
      buildings,
      resources,
      terrain: this.terrain.map(t => ({ ...t })),
      obstacles: this.obstacles.map(o => ({ ...o })),
      controlPoints: this.controlPoints.map(cp => ({ id: cp.id, x: cp.x, y: cp.y, owner: cp.owner ? (slotById[cp.owner] ?? -1) : -1, progress: viewerId ? Number(cp.progress[viewerId] || 0) : 0, capturer: viewerId && cp.progress[viewerId] ? (slotById[viewerId] ?? -1) : -1 })),
      credits,
      energy,
      maxEnergy,
      productionQueues: productionQueues.flatMap((q, owner) => q.map(order => ({ owner, type:order.type, producerId:order.producerId, remainingTicks:Math.ceil(order.remaining*10), totalTicks:Math.ceil(order.total*10), started:!!order.started }))),
      economy,
      active,
      kills,
      produced,
      built,
      names,
      technologies,
      peaceRemaining: Math.ceil(this.peaceRemaining()),
      gameOver: this.winner !== null,
      winner: this.winner == null
        ? null
        : (slotById[this.winner] ?? -1),
      visibleCells,
      exploredCells,
      fogGridWidth: this.fogGridWidth,
      fogGridHeight: this.fogGridHeight,
      serverTime: Date.now()
    };
  }
}

module.exports = {
  GameEngine,
  UNIT,
  BUILDING,
  TECHNOLOGY,
  createSpawnLayout
};
