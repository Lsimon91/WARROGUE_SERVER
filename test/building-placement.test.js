'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameEngine } = require('../game-engine');

function setup(id = 'placement-test') {
  const engine = new GameEngine({ id, map: 'small', players: new Map() });
  engine.obstacles.length = 0;
  engine.addPlayer({ id: 'P1', slot: 0, name: 'Uno' });
  engine.players.P1.credits = 5000; engine.players.P1.energy = 1000;
  const hq = engine.buildings.find(b => b.owner === 'P1' && b.type === 'HQ');
  return { engine, hq };
}

test('el servidor rechaza edificios amontonados sobre otro edificio', () => {
  const { engine, hq } = setup();
  const before = engine.buildings.length;
  assert.equal(engine.build('P1', 'BARRACKS', hq.x + 0.01, hq.y + 0.01), false);
  assert.equal(engine.buildings.length, before);
});

test('el servidor rechaza construir fuera del radio de la base', () => {
  const { engine, hq } = setup();
  const x = hq.x < 0.5 ? hq.x + 0.6 : hq.x - 0.6;
  assert.equal(engine.build('P1', 'DEPOT', x, hq.y), false);
});

test('construcción automática: varios edificios dentro de la base sin solaparse', () => {
  const { engine, hq } = setup();
  assert.equal(engine.build('P1', 'DEPOT'), true);
  assert.equal(engine.build('P1', 'RADAR'), true);
  assert.equal(engine.build('P1', 'TURRET'), true);
  const mine = engine.buildings.filter(b => b.owner === 'P1');
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const d = Math.hypot((mine[i].x - mine[j].x) * 2.35, mine[i].y - mine[j].y);
      assert.ok(d >= 0.12, `edificios ${mine[i].type} y ${mine[j].type} demasiado juntos (${d.toFixed(3)})`);
    }
    const dh = Math.hypot((mine[i].x - hq.x) * 2.35, mine[i].y - hq.y);
    assert.ok(dh <= 0.52 + 1e-9, `${mine[i].type} fuera del radio de la base`);
  }
});

test('requisitos: fábrica necesita cuartel, taller necesita fábrica, SAM necesita radar', () => {
  const { engine } = setup();
  engine.buildings = engine.buildings.filter(b => !(b.owner === 'P1' && b.type === 'BARRACKS'));
  assert.equal(engine.build('P1', 'FACTORY'), false);
  assert.equal(engine.build('P1', 'WORKSHOP'), false);
  assert.equal(engine.build('P1', 'SAM'), false);
  assert.equal(engine.build('P1', 'BARRACKS'), true);
  assert.equal(engine.build('P1', 'FACTORY'), true);
  assert.equal(engine.build('P1', 'WORKSHOP'), true);
  assert.equal(engine.build('P1', 'RADAR'), true);
  assert.equal(engine.build('P1', 'SAM'), true);
});

test('el tanque pesado requiere taller y la unidad sale del edificio elegido', () => {
  const { engine } = setup();
  engine.build('P1', 'BARRACKS'); engine.build('P1', 'FACTORY');
  assert.equal(engine.recruit('P1', 'HEAVY_TANK'), false);
  engine.build('P1', 'WORKSHOP');
  const f = engine.buildings.find(b => b.type === 'FACTORY');
  assert.equal(engine.recruit('P1', 'HEAVY_TANK', undefined, undefined, f.id), true);
});

test('depósitos y energía aumentan los ingresos periódicos', () => {
  const a = setup('income-a'); const b = setup('income-b');
  b.engine.build('P1', 'DEPOT'); b.engine.build('P1', 'POWER');
  a.engine.players.P1.credits = 0; b.engine.players.P1.credits = 0;
  for (let i = 0; i < 60; i++) { a.engine.update(0.1); b.engine.update(0.1); }
  assert.ok(b.engine.players.P1.credits > a.engine.players.P1.credits);
});

test('el taller repara vehículos cercanos', () => {
  const { engine } = setup();
  engine.build('P1', 'BARRACKS'); engine.build('P1', 'FACTORY'); engine.build('P1', 'WORKSHOP');
  engine.players.P1.energy = 1000;
  engine.recruit('P1', 'TANK');
  for (let i = 0; i < 250; i++) engine.update(0.1);
  const tank = engine.units.find(u => u.type === 'TANK');
  const workshop = engine.buildings.find(b => b.type === 'WORKSHOP');
  tank.x = workshop.x; tank.y = workshop.y; tank.targetX = null; tank.targetY = null;
  tank.health = 50;
  for (let i = 0; i < 100; i++) engine.update(0.1);
  assert.ok(tank.health > 50);
});

test('el servidor explica por qué rechaza una orden de construir', () => {
  const { engine } = setup('reject-reason');
  engine.buildings = engine.buildings.filter(b => !(b.owner === 'P1' && b.type === 'BARRACKS'));
  assert.equal(engine.build('P1', 'FACTORY'), false);
  assert.match(engine.lastReject, /BARRACKS/);
  engine.players.P1.credits = 0;
  assert.equal(engine.build('P1', 'BARRACKS'), false);
  assert.match(engine.lastReject, /Créditos/);
});


test('la producción consume energía y no crea la unidad hasta completar su tiempo', () => {
  const { engine } = setup('timed-production');
  engine.players.P1.energy = 180;
  const barracks = engine.buildings.find(b => b.owner === 'P1' && b.type === 'BARRACKS');
  const initialSoldiers = engine.units.filter(u => u.owner === 'P1' && u.type === 'SOLDIER').length;
  assert.equal(engine.recruit('P1', 'SOLDIER', undefined, undefined, barracks.id), true);
  assert.equal(engine.units.filter(u => u.owner === 'P1' && u.type === 'SOLDIER').length, initialSoldiers);
  assert.equal(engine.players.P1.productionQueue[0].remaining, 12);
  for (let i = 0; i < 119; i++) engine.update(0.1);
  assert.equal(engine.units.filter(u => u.owner === 'P1' && u.type === 'SOLDIER').length, initialSoldiers);
  engine.update(0.1);
  assert.equal(engine.units.filter(u => u.owner === 'P1' && u.type === 'SOLDIER').length, initialSoldiers + 1);
});

test('construir sin energía es rechazado y la producción espera recursos sin perder su turno', () => {
  const { engine } = setup('energy-rejection');
  engine.players.P1.energy = 0;
  assert.equal(engine.build('P1', 'BARRACKS'), false);
  assert.match(engine.lastReject, /Energía/);
  engine.players.P1.energy = 5;
  assert.equal(engine.recruit('P1', 'SOLDIER'), true);
  const order = engine.players.P1.productionQueue[0];
  assert.equal(order.started, false);
  const remaining = order.remaining;
  for (let i = 0; i < 10; i++) engine.update(0.1);
  assert.equal(order.remaining, remaining, 'el tiempo no avanza mientras faltan recursos');
  assert.equal(order.started, false);
  for (let i = 0; i < 60; i++) engine.update(0.1);
  assert.equal(order.started, true, 'reanuda automáticamente al recuperar energía');
  assert.ok(order.remaining < remaining, 'el tiempo comienza a avanzar al iniciar');
});


test('cada edificio productor admite hasta 20 órdenes y mantiene colas separadas', () => {
  const { engine } = setup('per-building-queue');
  engine.players.P1.credits = 9999;
  engine.players.P1.energy = 999;
  const firstBarracks = engine.buildings.find(b => b.owner === 'P1' && b.type === 'BARRACKS');
  const secondBarracks = { id: 9901, owner: 'P1', type: 'BARRACKS', x: 0.25, y: 0.25, health: 520, maxHealth: 520 };
  engine.buildings.push(secondBarracks);
  for (let i = 0; i < 20; i++) assert.equal(engine.recruit('P1', 'SOLDIER', null, null, firstBarracks.id), true);
  assert.equal(engine.recruit('P1', 'SOLDIER', null, null, firstBarracks.id), false);
  assert.match(engine.lastReject, /máximo 20/);
  assert.equal(engine.recruit('P1', 'SOLDIER', null, null, secondBarracks.id), true, 'otro cuartel conserva su propia cola');
  assert.equal(engine.players.P1.productionQueue.filter(q => q.producerId === firstBarracks.id).length, 20);
  assert.equal(engine.players.P1.productionQueue.filter(q => q.producerId === secondBarracks.id).length, 1);
});
