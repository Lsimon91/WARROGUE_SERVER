'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Persistence } = require('../persistence');

test('profiles and match statistics survive a server restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrogue-'));
  const file = path.join(dir, 'warrogue.json');
  try {
    const first = new Persistence(file);
    first.profile('stable-player-id', 'Comandante', 'android');
    const room = {
      id: 'TEST01',
      players: new Map([['session-id', {
        id: 'session-id', profileId: 'stable-player-id',
        name: 'Comandante', platform: 'android', bot: false
      }]])
    };
    const engine = {
      winner: 'session-id',
      startedAt: Date.now() - 45000,
      players: { 'session-id': { kills: 12, produced: 4, built: 2, score: 120 } }
    };
    first.finishMatch(room, engine);

    const afterRestart = new Persistence(file);
    const profile = afterRestart.publicProfile('stable-player-id');
    assert.equal(profile.matches, 1);
    assert.equal(profile.wins, 1);
    assert.equal(profile.kills, 12);
    // Una partida de 45 s contra nadie más da muy poca XP: sigue siendo RECLUTA, pero el logro se concede.
    assert.equal(profile.rank, 'RECLUTA');
    assert.ok(profile.xp > 0 && profile.xp < 40);
    assert.ok(profile.achievements.includes('first_battle'));
    assert.ok(profile.achievements.includes('victory_1'));
    assert.equal(profile.progressionVersion, 2);
    assert.equal(afterRestart.summary().matches, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('the same stable profile id reuses one player record across different rooms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrogue-identity-'));
  const file = path.join(dir, 'warrogue.json');
  try {
    const db = new Persistence(file);
    const first = db.profile('android-web-shared-001', 'Comandante', 'android');
    first.xp = 900; first.wins = 6;
    db.save();
    const second = db.profile('android-web-shared-001', 'Comandante', 'web');
    assert.equal(Object.keys(db.data.profiles).length, 1);
    assert.equal(second.id, first.id);
    assert.equal(second.xp, 900);
    assert.equal(second.rank, 'CABO');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('online accounts hash passwords and issue revocable expiring tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrogue-auth-'));
  const file = path.join(dir, 'accounts.json');
  const store = new Persistence(file);
  const account = store.registerAccount('commander@example.com', 'correct-horse-123', 'Commander');
  assert.throws(() => store.registerAccount('commander@example.com', 'another-password', 'Duplicate'), { code: 'ACCOUNT_EXISTS' });
  assert.equal(store.loginAccount('commander@example.com', 'wrong-password'), null);
  assert.equal(store.loginAccount('commander@example.com', 'correct-horse-123').id, account.id);
  const token = store.issueToken(account.id);
  assert.equal(store.accountForToken(token).profileId, account.profileId);
  const tokenHash = require('node:crypto').createHash('sha256').update(token).digest('hex');
  store.data.tokens[tokenHash].expiresAt = Date.now() - 1;
  assert.equal(store.accountForToken(token), null);
  const secondToken = store.issueToken(account.id);
  store.revokeToken(secondToken);
  assert.equal(store.accountForToken(secondToken), null);
  fs.rmSync(dir, { recursive: true, force: true });
});


test('online AI records results and only adapts after the minimum sample threshold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrogue-ai-learning-'));
  const file = path.join(dir, 'ai.json');
  try {
    const db = new Persistence(file);
    const room = { id: 'AI01', statsRecorded: false, players: new Map([
      ['bot-1', { id: 'bot-1', bot: true, difficulty: 'normal', name: 'Rival IA' }],
      ['human-1', { id: 'human-1', bot: false, profileId: 'human-profile', name: 'Jugador' }]
    ]) };
    const engine = { winner: 'bot-1', startedAt: Date.now() - 60000, players: {
      'bot-1': { kills: 8, score: 420 }, 'human-1': { kills: 3, score: 120 }
    } };
    db.finishMatch(room, engine);
    const summary = db.aiSummary();
    assert.deepEqual(summary.map(x => x.difficulty), ['easy', 'normal', 'hard', 'expert']);
    const ai = summary.find(x => x.difficulty === 'normal');
    assert.equal(ai.matches, 1);
    assert.equal(ai.wins, 1);
    assert.equal(ai.kills, 8);
    assert.equal(ai.averageKills, 8);
    assert.equal(ai.winRate, 100);
    assert.equal(ai.aggression, 0, 'una sola muestra no debe adaptar la IA');
    // El aprendizaje se activa al alcanzar el umbral de diez partidas.
    for (let i = 0; i < 9; i++) {
      const nextRoom = { id: `AI0${i}`, statsRecorded: false, players: room.players };
      db.finishMatch(nextRoom, engine);
    }
    const adapted = db.aiSummary().find(x => x.difficulty === 'normal');
    assert.equal(adapted.matches, 10);
    assert.ok(adapted.aggression > 0);
    assert.ok(adapted.aggression <= 0.2);
    const restarted = new Persistence(file);
    assert.equal(restarted.aiProfile('normal').matches, 10);
    assert.ok(restarted.aiProfile('normal').aggression > 0);
    assert.equal(restarted.aiSummary().find(x => x.difficulty === 'normal').averageKills, 8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('atomic persistence keeps a last-known-good backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrogue-backup-'));
  const file = path.join(dir, 'warrogue.json');
  try {
    const db = new Persistence(file);
    db.profile('backup-player', 'Jugador', 'web');
    const first = fs.readFileSync(file, 'utf8');
    db.profile('backup-player', 'Jugador actualizado', 'web');
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), first);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).profiles['backup-player'].name, 'Jugador actualizado');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
