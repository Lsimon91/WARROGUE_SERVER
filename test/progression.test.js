'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const P = require('../progression');
const { Persistence } = require('../persistence');

test('un rango exige XP y victorias: mucho XP sin victorias no asciende', () => {
  assert.equal(P.evaluate({ xp: 50000, wins: 0 }).rank, 'RECLUTA');
  assert.equal(P.evaluate({ xp: 900, wins: 6 }).rank, 'CABO');
  assert.equal(P.evaluate({ xp: 900, wins: 5 }).rank, 'SOLDADO');
  assert.equal(P.evaluate({ xp: 45000, wins: 300 }).rank, 'GENERAL');
  assert.equal(P.evaluate({ xp: 45000, wins: 299 }).rank, 'GENERAL DE DIVISIÓN');
});

test('los rangos son más difíciles que en la versión anterior (8 rangos, GENERAL a 9000 XP)', () => {
  assert.ok(P.RANKS.length > 8);
  assert.ok(P.RANKS.at(-1).xp >= 9000 * 4);
  for (let i = 1; i < P.RANKS.length; i++) {
    assert.ok(P.RANKS[i].xp > P.RANKS[i - 1].xp && P.RANKS[i].wins > P.RANKS[i - 1].wins);
  }
});

test('hay más logros que antes y ids únicos', () => {
  assert.ok(P.ACHIEVEMENTS.length >= 20);
  assert.equal(new Set(P.ACHIEVEMENTS.map(a => a.id)).size, P.ACHIEVEMENTS.length);
});

test('las medallas tienen 4 niveles crecientes y se conceden por nivel', () => {
  for (const m of P.MEDALS) {
    assert.equal(m.tiers.length, 4);
    for (let i = 1; i < 4; i++) assert.ok(m.tiers[i] > m.tiers[i - 1], m.id);
  }
  const state = P.evaluate({ kills: 1000, wins: 14 });
  const combat = state.medals.find(m => m.id === 'combat');
  const victory = state.medals.find(m => m.id === 'victory');
  assert.equal(combat.tierName, 'PLATA');
  assert.equal(victory.tier, -1);
  const rate = P.evaluate({ matches: 29, wins: 29 }).medals.find(m => m.id === 'tactician');
  assert.equal(rate.tier, -1, 'la efectividad exige 30 partidas');
});

test('logros especiales: relámpago, estratega y medallas', () => {
  assert.ok(!P.evaluate({ matches: 1, wins: 1, fastestWin: 600 }).achievements.includes('blitz'));
  assert.ok(P.evaluate({ matches: 1, wins: 1, fastestWin: 400 }).achievements.includes('blitz'));
  assert.ok(!P.evaluate({ matches: 39, wins: 39 }).achievements.includes('strategist_60'));
  assert.ok(P.evaluate({ matches: 40, wins: 30 }).achievements.includes('strategist_60'));
});

test('XP por partida: bots valen menos, partidas cortas casi nada, kills limitadas', () => {
  const vsHuman = P.matchXp('win', 10, 900, 1);
  const vsBot = P.matchXp('win', 10, 900, P.BOT_XP_FACTOR.easy);
  assert.ok(vsHuman > vsBot);
  assert.ok(P.matchXp('win', 10, 60, 1) < vsHuman / 3);
  assert.equal(P.matchXp('win', 500, 900, 1), P.matchXp('win', 30, 900, 1));
  assert.ok(P.matchXp('loss', 0, 900, 1) < P.matchXp('draw', 0, 900, 1));
  assert.ok(P.matchXp('draw', 0, 900, 1) < P.matchXp('win', 0, 900, 1));
});

test('el servidor registra empates, mejor partida y victoria más rápida', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrogue-prog-'));
  try {
    const db = new Persistence(path.join(dir, 'w.json'));
    const mk = (winner, secs, kills) => ({
      room: { id: 'R' + Math.random(), players: new Map([
        ['a', { id: 'a', profileId: 'pa', name: 'A', platform: 'android', bot: false }],
        ['b', { id: 'b', profileId: 'pb', name: 'B', platform: 'android', bot: false }]]) },
      engine: { winner, startedAt: Date.now() - secs * 1000, players: { a: { kills }, b: { kills: 1 } } }
    });
    let m = mk('a', 600, 12); db.finishMatch(m.room, m.engine);
    m = mk('draw', 700, 3); db.finishMatch(m.room, m.engine);
    m = mk('a', 400, 20); db.finishMatch(m.room, m.engine);
    const a = db.publicProfile('pa');
    assert.equal(a.matches, 3); assert.equal(a.wins, 2); assert.equal(a.draws, 1); assert.equal(a.losses, 0);
    assert.equal(a.fastestWin, 400); assert.equal(a.bestKills, 20); assert.equal(a.longest, 700);
    assert.equal(a.bestStreak, 1, 'el empate corta la racha');
    assert.ok(a.achievements.includes('blitz'));
    const b = db.publicProfile('pb');
    assert.equal(b.losses, 2); assert.equal(b.draws, 1);
    assert.ok(b.xp < a.xp);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('el cliente Android (Progression.kt) usa las MISMAS tablas que el servidor', () => {
  const file = path.join(__dirname, '..', '..', '..', 'app', 'WARROGUE_SDK37', 'app', 'src', 'main', 'java', 'com', 'warrogue', 'game', 'Progression.kt');
  if (!fs.existsSync(file)) return;   // el servidor puede desplegarse sin el proyecto Android
  const kt = fs.readFileSync(file, 'utf8');
  const ranks = [...kt.matchAll(/Rank\("([^"]+)",\s*(\d+),\s*(\d+)\)/g)].map(m => ({ name: m[1], xp: +m[2], wins: +m[3] }));
  assert.deepEqual(ranks, P.RANKS);
  const medals = [...kt.matchAll(/Medal\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g)]
    .map(m => ({ id: m[1], title: m[2], stat: m[3], tiers: [+m[4], +m[5], +m[6], +m[7]] }));
  assert.deepEqual(medals, P.MEDALS);
  const ach = [...kt.matchAll(/Ach\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*(\d+),\s*(\d+),\s*"([^"]*)"\)/g)]
    .map(m => ({ id: m[1], title: m[2], kind: m[3], stat: m[4], target: +m[5], minMatches: +m[6], desc: m[7] }));
  assert.equal(ach.length, P.ACHIEVEMENTS.length);
  ach.forEach((a, i) => {
    const s = P.ACHIEVEMENTS[i];
    assert.deepEqual([a.id, a.title, a.kind, a.stat, a.target, a.minMatches, a.desc],
      [s.id, s.title, s.kind, s.stat, s.target, s.minMatches || 0, s.desc], s.id);
  });
  assert.match(kt, new RegExp(`PROGRESSION_VERSION\\s*=\\s*${P.PROGRESSION_VERSION}\\b`));
  for (const [k, v] of Object.entries(P.BOT_XP_FACTOR)) assert.match(kt, new RegExp(`"${k}"\\s+to\\s+${String(v).replace('.', '\\.')}`));
});
