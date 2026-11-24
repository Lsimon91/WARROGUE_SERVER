'use strict';
/*
 * Progresión de jugador (rangos, logros, medallas, XP).
 * FUENTE ÚNICA PARA EL SERVIDOR. El cliente Android la replica en Progression.kt;
 * test/progression.test.js comprueba que ambas tablas son idénticas.
 */
const PROGRESSION_VERSION = 2;

// Un rango exige XP *y* victorias mínimas: no se compra solo jugando derrotas.
const RANKS = [
  { name: 'RECLUTA',            xp: 0,     wins: 0 },
  { name: 'SOLDADO',            xp: 300,   wins: 2 },
  { name: 'CABO',               xp: 900,   wins: 6 },
  { name: 'SARGENTO',           xp: 1800,  wins: 12 },
  { name: 'SARGENTO PRIMERO',   xp: 3200,  wins: 22 },
  { name: 'TENIENTE',           xp: 5200,  wins: 35 },
  { name: 'CAPITÁN',            xp: 8000,  wins: 55 },
  { name: 'MAYOR',              xp: 12000, wins: 80 },
  { name: 'CORONEL',            xp: 17500, wins: 115 },
  { name: 'GENERAL DE BRIGADA', xp: 25000, wins: 160 },
  { name: 'GENERAL DE DIVISIÓN',xp: 34000, wins: 220 },
  { name: 'GENERAL',            xp: 45000, wins: 300 }
];

const TIERS = ['BRONCE', 'PLATA', 'ORO', 'PLATINO'];

// stat: campo acumulado del perfil; winRate exige >= 30 partidas.
const MEDALS = [
  { id: 'combat',    title: 'Medalla al Combate',     stat: 'kills',      tiers: [250, 1000, 3000, 8000] },
  { id: 'victory',   title: 'Medalla de Victoria',    stat: 'wins',       tiers: [15, 60, 150, 400] },
  { id: 'engineer',  title: 'Medalla de Ingeniería',  stat: 'built',      tiers: [150, 600, 1800, 5000] },
  { id: 'logistics', title: 'Medalla Logística',      stat: 'produced',   tiers: [400, 1500, 4500, 12000] },
  { id: 'service',   title: 'Medalla de Servicio',    stat: 'matches',    tiers: [40, 150, 400, 1000] },
  { id: 'streak',    title: 'Medalla de Racha',       stat: 'bestStreak', tiers: [5, 8, 12, 20] },
  { id: 'tactician', title: 'Medalla de Estratega',   stat: 'winRate',    tiers: [55, 65, 75, 85] }
];
const MEDAL_MIN_MATCHES = 30;

// kind: stat (>=), fast (0 < valor <= objetivo), rate (>= objetivo con partidas mínimas),
// rank (índice de rango >=), medals (nº total de niveles de medalla >=).
const ACHIEVEMENTS = [
  { id: 'first_battle',  title: 'Primer despliegue',      kind: 'stat',   stat: 'matches',    target: 1,    desc: 'Completa 1 partida.' },
  { id: 'victory_1',     title: 'Primera victoria',       kind: 'stat',   stat: 'wins',       target: 1,    desc: 'Gana 1 partida.' },
  { id: 'wins_10',       title: 'Vencedor',               kind: 'stat',   stat: 'wins',       target: 10,   desc: 'Gana 10 partidas.' },
  { id: 'wins_50',       title: 'As de la guerra',        kind: 'stat',   stat: 'wins',       target: 50,   desc: 'Gana 50 partidas.' },
  { id: 'wins_150',      title: 'Mariscal',               kind: 'stat',   stat: 'wins',       target: 150,  desc: 'Gana 150 partidas.' },
  { id: 'veteran_25',    title: 'Veterano',               kind: 'stat',   stat: 'matches',    target: 25,   desc: 'Juega 25 partidas.' },
  { id: 'veteran_100',   title: 'Curtido en combate',     kind: 'stat',   stat: 'matches',    target: 100,  desc: 'Juega 100 partidas.' },
  { id: 'veteran_300',   title: 'Leyenda del frente',     kind: 'stat',   stat: 'matches',    target: 300,  desc: 'Juega 300 partidas.' },
  { id: 'kills_100',     title: 'Cazador',                kind: 'stat',   stat: 'kills',      target: 100,  desc: 'Elimina 100 unidades enemigas.' },
  { id: 'kills_500',     title: 'Exterminador',           kind: 'stat',   stat: 'kills',      target: 500,  desc: 'Elimina 500 unidades enemigas.' },
  { id: 'kills_2500',    title: 'Azote del campo',        kind: 'stat',   stat: 'kills',      target: 2500, desc: 'Elimina 2500 unidades enemigas.' },
  { id: 'massacre',      title: 'Matanza',                kind: 'stat',   stat: 'bestKills',  target: 30,   desc: 'Elimina 30 unidades en una sola partida.' },
  { id: 'streak_5',      title: 'Imparable',              kind: 'stat',   stat: 'bestStreak', target: 5,    desc: 'Encadena 5 victorias seguidas.' },
  { id: 'streak_10',     title: 'Invicto',                kind: 'stat',   stat: 'bestStreak', target: 10,   desc: 'Encadena 10 victorias seguidas.' },
  { id: 'streak_20',     title: 'Intocable',              kind: 'stat',   stat: 'bestStreak', target: 20,   desc: 'Encadena 20 victorias seguidas.' },
  { id: 'builder_100',   title: 'Ingeniero',              kind: 'stat',   stat: 'built',      target: 100,  desc: 'Construye 100 edificios.' },
  { id: 'builder_500',   title: 'Arquitecto militar',     kind: 'stat',   stat: 'built',      target: 500,  desc: 'Construye 500 edificios.' },
  { id: 'producer_200',  title: 'Intendente',             kind: 'stat',   stat: 'produced',   target: 200,  desc: 'Produce 200 unidades.' },
  { id: 'producer_1000', title: 'Gran logista',           kind: 'stat',   stat: 'produced',   target: 1000, desc: 'Produce 1000 unidades.' },
  { id: 'marathon',      title: 'Resistencia',            kind: 'stat',   stat: 'longest',    target: 1800, desc: 'Aguanta una partida de 30 minutos.' },
  { id: 'blitz',         title: 'Guerra relámpago',       kind: 'fast',   stat: 'fastestWin', target: 480,  desc: 'Gana una partida en menos de 8 minutos.' },
  { id: 'strategist_60', title: 'Estratega',              kind: 'rate',   stat: 'winRate',    target: 60,   minMatches: 40,  desc: '60 % de victorias con al menos 40 partidas.' },
  { id: 'strategist_75', title: 'Maestro táctico',        kind: 'rate',   stat: 'winRate',    target: 75,   minMatches: 100, desc: '75 % de victorias con al menos 100 partidas.' },
  { id: 'officer',       title: 'Oficial',                kind: 'rank',   stat: 'rank',       target: 6,    desc: 'Alcanza el rango de CAPITÁN.' },
  { id: 'high_command',  title: 'Alto mando',             kind: 'rank',   stat: 'rank',       target: 8,    desc: 'Alcanza el rango de CORONEL.' },
  { id: 'general_staff', title: 'Estado mayor',           kind: 'rank',   stat: 'rank',       target: 11,   desc: 'Alcanza el rango de GENERAL.' },
  { id: 'decorated',     title: 'Condecorado',            kind: 'medals', stat: 'medals',     target: 6,    desc: 'Reúne 6 niveles de medalla en total.' },
  { id: 'platinum',      title: 'Pecho de platino',       kind: 'medals', stat: 'medals',     target: 16,   desc: 'Reúne 16 niveles de medalla en total.' }
];

const num = v => Math.max(0, Math.floor(Number(v) || 0));

function normalizeStats(p = {}) {
  return {
    matches: num(p.matches), wins: num(p.wins), losses: num(p.losses), draws: num(p.draws),
    kills: num(p.kills), produced: num(p.produced), built: num(p.built),
    bestStreak: num(p.bestStreak), streak: num(p.streak), seconds: num(p.seconds),
    longest: num(p.longest), bestKills: num(p.bestKills), fastestWin: num(p.fastestWin), xp: num(p.xp)
  };
}

function winRate(s) { return s.matches > 0 ? Math.floor(s.wins * 100 / s.matches) : 0; }

/* Índice del rango más alto cuyo XP y victorias se cumplen (y todos los anteriores). */
function rankIndex(s) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (s.xp >= RANKS[i].xp && s.wins >= RANKS[i].wins) idx = i; else break;
  }
  return idx;
}

function medalValue(m, s) {
  if (m.stat === 'winRate') return s.matches >= MEDAL_MIN_MATCHES ? winRate(s) : 0;
  return s[m.stat] || 0;
}

/* Nivel de medalla: -1 = ninguna, 0 = BRONCE ... 3 = PLATINO. */
function medalTier(m, s) {
  const v = medalValue(m, s);
  let tier = -1;
  m.tiers.forEach((t, i) => { if (v >= t) tier = i; });
  return tier;
}

function medalLevels(s) {
  return MEDALS.reduce((n, m) => n + (medalTier(m, s) + 1), 0);
}

function achievementValue(a, s) {
  switch (a.kind) {
    case 'rank': return rankIndex(s);
    case 'medals': return medalLevels(s);
    case 'rate': return s.matches >= a.minMatches ? winRate(s) : 0;
    default: return s[a.stat] || 0;
  }
}

function achievementUnlocked(a, s) {
  const v = achievementValue(a, s);
  return a.kind === 'fast' ? (v > 0 && v <= a.target) : v >= a.target;
}

/* XP de una partida. result: 'win' | 'loss' | 'draw'. */
const BOT_XP_FACTOR = { easy: 0.3, normal: 0.5, hard: 0.75, expert: 1 };
function matchXp(result, kills, seconds, opponentFactor = 1) {
  const base = result === 'win' ? 60 : result === 'draw' ? 25 : 15;
  let raw = base + Math.min(num(kills), 30) * 2;
  if (num(seconds) < 180) raw *= 0.25;      // partidas relámpago/abandonadas: casi nada
  raw *= Math.max(0, Math.min(1, Number(opponentFactor)));
  return Math.max(5, Math.round(raw));
}

/* Estado completo para mostrar: rango, siguiente rango, medallas y logros con progreso. */
function evaluate(profile) {
  const s = normalizeStats(profile);
  const ri = rankIndex(s);
  const next = RANKS[ri + 1] || null;
  const medals = MEDALS.map(m => {
    const tier = medalTier(m, s);
    return {
      id: m.id, title: m.title, tier, tierName: tier >= 0 ? TIERS[tier] : null,
      value: medalValue(m, s), nextTarget: m.tiers[tier + 1] ?? null
    };
  });
  const achievementDetails = ACHIEVEMENTS.map(a => ({
    id: a.id, title: a.title, desc: a.desc, unlocked: achievementUnlocked(a, s),
    progress: a.kind === 'fast' ? (achievementUnlocked(a, s) ? a.target : 0) : Math.min(achievementValue(a, s), a.target),
    target: a.target
  }));
  return {
    version: PROGRESSION_VERSION,
    rank: RANKS[ri].name, rankIndex: ri,
    nextRank: next ? { name: next.name, xp: next.xp, wins: next.wins } : null,
    xpToNext: next ? Math.max(0, next.xp - s.xp) : 0,
    winsToNext: next ? Math.max(0, next.wins - s.wins) : 0,
    medals, medalLevels: medalLevels(s),
    achievements: achievementDetails.filter(a => a.unlocked).map(a => a.id),
    achievementDetails
  };
}

module.exports = {
  PROGRESSION_VERSION, RANKS, TIERS, MEDALS, MEDAL_MIN_MATCHES, ACHIEVEMENTS, BOT_XP_FACTOR,
  normalizeStats, winRate, rankIndex, medalTier, medalLevels, achievementUnlocked, matchXp, evaluate
};
