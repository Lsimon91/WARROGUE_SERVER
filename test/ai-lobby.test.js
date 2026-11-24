'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Persistence } = require('../persistence');
const { GameEngine } = require('../game-engine');

test('AI dossier has persistent independent statistics for all five difficulties', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrogue-ai-dossier-'));
  try {
    const db = new Persistence(path.join(dir, 'data.json'));
    const room = { id: 'AI-DOSSIER', aiStatsRecorded: false, players: new Map([
      ['bot', { id: 'bot', bot: true, difficulty: 'commander' }]
    ]) };
    const engine = { winner: 'bot', startedAt: Date.now() - 30000, players: {
      bot: { kills: 9, produced: 17, built: 6, score: 240 }
    } };
    db.recordAIMatch(room, engine);
    const profile = db.publicAIProfile('commander');
    assert.equal(profile.matches, 1);
    assert.equal(profile.wins, 1);
    assert.equal(profile.kills, 9);
    assert.equal(profile.produced, 17);
    assert.equal(profile.built, 6);
    assert.ok(profile.xp > 0);
    assert.equal(db.publicAIProfile('expert').matches, 0);
    assert.deepEqual(db.aiSummary().map(x => x.difficulty), ['easy','normal','hard','expert','commander']);
    const afterRestart = new Persistence(path.join(dir, 'data.json'));
    assert.equal(afterRestart.publicAIProfile('commander').matches, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('viewer snapshot excludes hidden enemy units and private enemy movement/economy', () => {
  const room = { id: 'FOG-TEST', players: new Map() };
  const engine = new GameEngine(room);
  const a = { id: 'human', name: 'Human', slot: 0, bot: false };
  const b = { id: 'bot', name: 'Bot', slot: 1, bot: true };
  room.players.set(a.id, a); room.players.set(b.id, b);
  engine.addPlayer(a); engine.addPlayer(b);
  const enemy = engine.units.find(u => u.owner === 'bot');
  enemy.x = 0.5; enemy.y = 0.5; enemy.targetX = 0.8; enemy.targetY = 0.8;
  // Keep enemy beyond the human's current vision.
  const hq = engine.buildings.find(x => x.owner === 'human' && x.type === 'HQ');
  enemy.x = hq.x < 0.5 ? 0.92 : 0.08;
  enemy.y = hq.y < 0.5 ? 0.92 : 0.08;
  const state = engine.exportState('human');
  assert.equal(state.units.some(u => u.owner === 1), false);
  assert.equal(state.credits[1], 0);
  assert.equal(state.kills[1], 0);
});


test('visibility checks exact distance, not the whole coarse fog cell', () => {
  const room = { id: 'FOG-CELL', players: new Map() };
  const engine = new GameEngine(room);
  const human = { id: 'human', name: 'Human', slot: 0 };
  const bot = { id: 'bot', name: 'Bot', slot: 1, bot: true };
  room.players.set(human.id, human); room.players.set(bot.id, bot);
  engine.addPlayer(human); engine.addPlayer(bot);
  const hq = engine.buildings.find(b => b.owner === 'human' && b.type === 'HQ');
  // Aísla el HQ como única fuente de visión para comprobar el límite exacto.
  engine.units = engine.units.filter(u => u.owner !== 'human');
  const radius = 0.14;
  const direction = hq.x < 0.5 ? 1 : -1;
  const near = { owner: 'bot', x: hq.x + direction * (radius - 0.002), y: hq.y };
  const far = { owner: 'bot', x: hq.x + direction * (radius + 0.002), y: hq.y };
  assert.equal(engine.isVisibleTo('human', near), true);
  assert.equal(engine.isVisibleTo('human', far), false);
});
