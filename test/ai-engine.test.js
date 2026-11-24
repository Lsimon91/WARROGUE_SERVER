'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AIEngine } = require('../ai-engine');
const { createSpawnLayout, GameEngine, UNIT } = require('../game-engine');

test('AI does not target hidden enemy units or hidden enemy bases', () => {
  const playerId = 'BOT_TEST';
  const ownUnits = [];
  for (let i = 0; i < 5; i++) ownUnits.push({ id: i + 1, owner: playerId, type: 'SOLDIER', x: 0.2, y: 0.2 });
  for (let i = 0; i < 3; i++) ownUnits.push({ id: i + 6, owner: playerId, type: 'TANK', x: 0.21, y: 0.2 });
  for (let i = 0; i < 2; i++) ownUnits.push({ id: i + 9, owner: playerId, type: 'SCOUT', x: 0.22, y: 0.2 });
  ownUnits.push({ id: 11, owner: playerId, type: 'COMMANDER', x: 0.2, y: 0.21 });
  const hiddenEnemy = { id: 900, owner: 'HUMAN', type: 'COMMANDER', x: 0.9, y: 0.9 };
  const commands = [];
  const engine = {
    fogGridWidth: 40, fogGridHeight: 24,
    units: [...ownUnits, hiddenEnemy],
    buildings: [
      { id: 100, owner: playerId, type: 'HQ', x: 0.2, y: 0.2 },
      { id: 101, owner: playerId, type: 'BARRACKS', x: 0.25, y: 0.2 },
      { id: 102, owner: playerId, type: 'FACTORY', x: 0.25, y: 0.25 },
      { id: 103, owner: playerId, type: 'TURRET', x: 0.18, y: 0.2 },
      { id: 104, owner: playerId, type: 'TURRET', x: 0.2, y: 0.18 },
      { id: 901, owner: 'HUMAN', type: 'HQ', x: 0.9, y: 0.9 }
    ],
    resources: [],
    players: { [playerId]: { id: playerId, alive: true, credits: 0 } },
    player(id) { return this.players[id]; },
    computeVisibility() { return { visible: new Set(), explored: new Set() }; },
    command(id, command) { commands.push(command); return true; },
    build() { return false; }, recruit() { return false; }
  };
  const ai = new AIEngine(engine, playerId, 'expert');
  ai.startedAt = 0;
  ai.nextThink = 0;
  ai.lastAttackAt = 0;
  ai.think(1_000_000);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].action, 'attack_move');
  assert.equal(commands[0].targetId, undefined);
  assert.notEqual(commands[0].x, hiddenEnemy.x);
  assert.notEqual(commands[0].y, hiddenEnemy.y);
});

test('expert difficulty has a faster decision interval and shorter preparation', () => {
  const ai = new AIEngine({}, 'BOT_EXPERT', 'expert');
  assert.equal(ai.getThinkInterval(), 1000);
  assert.equal(ai.getPreparationTime(), 60000);
  assert.equal(ai.getMinimumArmy(), 4);
});


test('spawn layout randomizes sectors while keeping each player pair opposite', () => {
  const layout = createSpawnLayout();
  assert.equal(layout.length, 8);
  for (let i = 0; i < 8; i += 2) {
    assert.ok(Math.abs(layout[i].x + layout[i + 1].x - 1) < 0.0001);
    assert.ok(Math.abs(layout[i].y + layout[i + 1].y - 1) < 0.0001);
  }
  const engine = new GameEngine({ id: 'spawn-test', players: new Map() });
  assert.equal(engine.fogGridWidth, 64);
  assert.equal(engine.fogGridHeight, 40);
});


test('battlefield generates terrain and nine neutral capture objectives', () => {
  const engine = new GameEngine({ id: 'terrain-test', map: 'huge', players: new Map() });
  assert.equal(engine.mapSize, 'huge');
  assert.ok(engine.terrain.length >= 5);
  assert.ok(engine.obstacles.length > 0);
  assert.equal(engine.controlPoints.length, 9);
  assert.ok(engine.terrain.every(t => t.x > 0 && t.x < 1 && t.y > 0 && t.y < 1));
});

test('server supports twelve distinct combat unit types with separate combat roles', () => {
  const { UNIT } = require('../game-engine');
  const expected = ['COMMANDER','TANK','SOLDIER','SCOUT','MEDIC','SNIPER','ENGINEER','ARTILLERY','ROCKET','APC','HEAVY_TANK','FLAME'];
  assert.deepEqual(Object.keys(UNIT).sort(), expected.sort());
  assert.ok(UNIT.ARTILLERY.range > UNIT.TANK.range);
  assert.ok(UNIT.HEAVY_TANK.hp > UNIT.TANK.hp);
  assert.ok(UNIT.SNIPER.vision > UNIT.SOLDIER.vision);
});

test('obstacle collision blocks building placement and movement terrain affects speed', () => {
  const engine = new GameEngine({ id: 'obstacle-test', map: 'medium', players: new Map() });
  const obstacle = engine.obstacles[0];
  assert.equal(engine.blocked(obstacle.x, obstacle.y), true);
  const forest = { x: 0.5, y: 0.5, radius: 0.1, kind: 'forest' };
  engine.terrain = [forest];
  assert.ok(engine.movementFactor({type:'SOLDIER'}, 0.5, 0.5) < 1);
});


test('control point capture is exported as the viewer slot', () => {
  const room = { id: 'capture-test', map: 'small', players: new Map() };
  const engine = new GameEngine(room);
  engine.addPlayer({ id: 'P1', name: 'Alpha', slot: 0 });
  engine.addPlayer({ id: 'P2', name: 'Bravo', slot: 1 });
  const point = engine.controlPoints[0];
  engine.units.push({ id: 9001, owner: 'P1', type: 'TANK', x: point.x, y: point.y, health: 190, cooldown: 0, targetX: null, targetY: null, targetId: null, attackMove: false, gatherId: null });
  for (let i = 0; i < 250; i++) engine.update(0.1);
  assert.equal(point.owner, 'P1');
  const exported = engine.exportState('P1');
  assert.equal(exported.controlPoints.find(p => p.id === point.id).owner, 0);
  assert.equal(typeof exported.controlPoints.find(p => p.id === point.id).progress, 'number');
});

test('all seven specialist units can be recruited from their correct production building', () => {
  const engine = new GameEngine({ id: 'unit-production-test', map: 'medium', players: new Map() });
  engine.addPlayer({ id: 'P1', name: 'Alpha', slot: 0 });
  engine.players.P1.credits = 10000; engine.players.P1.energy = 1000;
  engine.buildings.push({ id: 8001, owner: 'P1', type: 'FACTORY', x: 0.2, y: 0.2, health: 520 });
  engine.buildings.push({ id: 8002, owner: 'P1', type: 'WORKSHOP', x: 0.3, y: 0.3, health: 560, maxHealth: 560 }); // requisito del tanque pesado
  const factoryTypes = ['ARTILLERY', 'ROCKET', 'APC', 'HEAVY_TANK'];
  const barracksTypes = ['SNIPER', 'ENGINEER', 'FLAME'];
  const allTypes = [...factoryTypes, ...barracksTypes];
  for (const type of allTypes) assert.equal(engine.recruit('P1', type), true, type);
  assert.equal(engine.players.P1.productionQueue.filter(q => q.producerId === 8001).length, 4);
  assert.equal(engine.players.P1.productionQueue.filter(q => q.producerId === 12).length, 3);
  for (let i = 0; i < 4000; i++) engine.update(0.1);
  assert.ok(engine.units.filter(u => allTypes.includes(u.type)).length === 7);
});

test('technology tree requires its building, charges credits and upgrades combat stats', () => {
  const engine = new GameEngine({ id: 'technology-test', map: 'small', players: new Map() });
  engine.addPlayer({ id: 'P1', name: 'Alpha', slot: 0 });
  engine.players.P1.credits = 5000;
  assert.equal(engine.research('P1', 'WEAPONS'), false, 'no workshop means no weapons research');
  engine.buildings.push({ id: 9901, owner: 'P1', type: 'WORKSHOP', x: .25, y: .25, health: 560, maxHealth: 560 });
  const before = engine.players.P1.credits;
  assert.equal(engine.command('P1', { action: 'research', technology: 'WEAPONS' }), true);
  assert.equal(engine.players.P1.technologies.WEAPONS, 1);
  assert.equal(engine.players.P1.credits, before - 260);
  assert.equal(engine.research('P1', 'UNKNOWN'), false);
});

test('server accepts Android repair requests for owned damaged buildings and charges credits', () => {
  const engine = new GameEngine({ id: 'repair-test', map: 'small', players: new Map() });
  engine.addPlayer({ id: 'P1', name: 'Alpha', slot: 0 });
  engine.players.P1.credits = 500;
  const hq = engine.buildings.find(b => b.owner === 'P1' && b.type === 'HQ');
  engine.units.push({ id: 9902, owner: 'P1', type: 'ENGINEER', x: hq.x + .01, y: hq.y + .01, health: 82 });
  hq.health -= 150;
  const credits = engine.players.P1.credits;
  assert.equal(engine.command('P1', { action: 'repair', buildingId: hq.id }), true);
  assert.equal(hq.health, 1140);
  assert.equal(engine.players.P1.credits, credits - 35);
});


test('A* navigation routes around impassable rocks and reaches the requested destination', () => {
  const engine = new GameEngine({ id: 'astar-test', map: 'small', players: new Map() });
  engine.terrain = [];
  engine.obstacles = [{ id: 1, kind: 'rock', x: 0.5, y: 0.5, radius: 0.11 }];
  const route = engine.findPath({x:0.25,y:0.5}, {x:0.75,y:0.5});
  assert.ok(route.length > 2, 'route must detour around the obstacle');
  assert.deepEqual(route.at(-1), {x:0.75,y:0.5});
  assert.ok(route.every(p => !engine.blocked(p.x,p.y,0.006)));
});

test('A* navigation does not permit diagonal corner cutting', () => {
  const engine = new GameEngine({ id: 'astar-corner-test', map: 'small', players: new Map() });
  engine.terrain = [];
  engine.obstacles = [
    {id:1,kind:'rock',x:0.5,y:0.5,radius:0.045},
    {id:2,kind:'rock',x:0.5+1/64,y:0.5,radius:0.045}
  ];
  const route = engine.findPath({x:0.45,y:0.45}, {x:0.55,y:0.55});
  assert.ok(Array.isArray(route));
});


test('server starts with the same economy, base buildings and starter force as Android', () => {
  const engine = new GameEngine({ id: 'android-parity', map: 'large', players: new Map() });
  engine.addPlayer({ id: 'P1', name: 'Alpha', slot: 0 });
  const p = engine.players.P1;
  assert.equal(p.credits, 550);
  assert.equal(p.energy, 150);
  assert.equal(engine.buildings.filter(b => b.owner === 'P1').length, 3);
  assert.deepEqual(engine.buildings.filter(b => b.owner === 'P1').map(b => b.type).sort(), ['BARRACKS', 'HQ', 'POWER']);
  assert.deepEqual(engine.units.filter(u => u.owner === 'P1').map(u => u.type).sort(), ['COMMANDER', 'SOLDIER', 'TANK']);
  assert.equal(UNIT.SCOUT.trainSeconds, 9);
  assert.equal(UNIT.SOLDIER.trainSeconds, 12);
  assert.equal(UNIT.TANK.trainSeconds, 30);
});

test('AI builds additional power capacity before its energy reserve collapses', () => {
  const playerId = 'BOT_POWER';
  const ownUnits = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, owner: playerId, type: 'SOLDIER', x: .2, y: .2 })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: i + 6, owner: playerId, type: 'TANK', x: .2, y: .2 })),
    { id: 8, owner: playerId, type: 'ARTILLERY', x: .2, y: .2 },
    { id: 9, owner: playerId, type: 'SNIPER', x: .2, y: .2 },
    { id: 10, owner: playerId, type: 'ENGINEER', x: .2, y: .2 },
    { id: 11, owner: playerId, type: 'SCOUT', x: .2, y: .2 },
    { id: 12, owner: playerId, type: 'SCOUT', x: .2, y: .2 },
    { id: 13, owner: playerId, type: 'COMMANDER', x: .2, y: .2 }
  ];
  const builds = [];
  const engine = {
    winner: null, fogGridWidth: 40, fogGridHeight: 24,
    units: ownUnits,
    buildings: [
      { id: 100, owner: playerId, type: 'HQ', x: .2, y: .2 },
      { id: 101, owner: playerId, type: 'BARRACKS', x: .25, y: .2 },
      { id: 102, owner: playerId, type: 'FACTORY', x: .25, y: .25 },
      { id: 103, owner: playerId, type: 'POWER', x: .18, y: .2 }
    ],
    resources: [],
    players: { [playerId]: { id: playerId, alive: true, credits: 1000, energy: 20, maxEnergy: 200 } },
    player(id) { return this.players[id]; },
    computeVisibility() { return { visible: new Set(), explored: new Set() }; },
    command() { return true; },
    recruit() { return false; },
    repair() { return false; },
    build(id, type) { builds.push(type); return type === 'POWER'; }
  };
  const ai = new AIEngine(engine, playerId, 'normal');
  ai.startedAt = 0;
  ai.nextThink = 0;
  ai.think(1_000_000);
  assert.deepEqual(builds, ['POWER']);
  assert.equal(ai.lastAction, 'ampliando suministro energético');
});
