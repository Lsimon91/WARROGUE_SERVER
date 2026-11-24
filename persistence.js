'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const progression = require('./progression');

class Persistence {
  constructor(file = process.env.DATA_FILE || path.join(__dirname, 'data', 'warrogue.json')) {
    this.file = path.resolve(file);
    this.data = { version: 1, profiles: {}, accounts: {}, tokens: {}, aiProfiles: {}, matches: [], totalMatches: 0, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.profiles &&
          typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)) {
        this.data = {
          ...this.data,
          ...parsed,
          profiles: parsed.profiles,
          accounts: parsed.accounts && typeof parsed.accounts === 'object' && !Array.isArray(parsed.accounts) ? parsed.accounts : {},
          tokens: parsed.tokens && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens) ? parsed.tokens : {},
          aiProfiles: parsed.aiProfiles && typeof parsed.aiProfiles === 'object' && !Array.isArray(parsed.aiProfiles) ? parsed.aiProfiles : {},
          matches: Array.isArray(parsed.matches) ? parsed.matches : [],
          totalMatches: Math.max(0, Number(parsed.totalMatches) || 0)
        };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const backup = this.file + '.corrupt-' + Date.now();
        try { fs.copyFileSync(this.file, backup); } catch (_) {}
        console.error('[PERSISTENCE] Archivo ilegible; se inicia una base nueva. Copia:', backup);
      }
    }
  }
  registerAccount(email, password, name) {
    const normalized = String(email || '').trim().toLowerCase();
    if (Object.values(this.data.accounts).some(a => a.email === normalized)) {
      const e = new Error('Ya existe una cuenta con ese correo'); e.code = 'ACCOUNT_EXISTS'; throw e;
    }
    const id = crypto.randomUUID();
    const profileId = crypto.randomBytes(18).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const account = { id, email: normalized, name: String(name || 'Jugador').slice(0, 20), profileId, salt, passwordHash, createdAt: Date.now() };
    this.data.accounts[id] = account;
    this.profile(profileId, account.name, 'android');
    this.save();
    return account;
  }
  loginAccount(email, password) {
    const normalized = String(email || '').trim().toLowerCase();
    const account = Object.values(this.data.accounts).find(a => a.email === normalized);
    if (!account) return null;
    const actual = crypto.scryptSync(String(password), account.salt, 64);
    const expected = Buffer.from(account.passwordHash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    return account;
  }
  issueToken(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.data.tokens[crypto.createHash('sha256').update(token).digest('hex')] = { accountId, expiresAt: Date.now() + 30 * 86400000 };
    this.save();
    return token;
  }
  accountForToken(token) {
    if (!token) return null;
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const record = this.data.tokens[hash];
    if (!record || record.expiresAt < Date.now()) { delete this.data.tokens[hash]; return null; }
    return this.data.accounts[record.accountId] || null;
  }
  revokeToken(token) {
    if (!token) return;
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    delete this.data.tokens[hash]; this.save();
  }
  save() {
    this.data.updatedAt = Date.now();
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let fd = null;
    try {
      // Preserve the last known-good database before replacing it.
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch (_) {}
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
  }
  profile(profileId, name, platform = 'web') {
    // Identidad global del jugador: nunca usar roomId/playerId, que cambian en cada sala.
    const key = String(profileId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (!key) return null;
    let p = this.data.profiles[key];
    if (!p) {
      p = this.data.profiles[key] = {
        id: key, name: String(name || 'Jugador').replace(/[<>]/g, '').slice(0, 20) || 'Jugador',
        platform, createdAt: Date.now(), lastSeenAt: Date.now(),
        matches: 0, wins: 0, losses: 0, draws: 0, kills: 0, produced: 0, built: 0,
        score: 0, streak: 0, bestStreak: 0, xp: 0, rank: 'RECLUTA', achievements: [],
        seconds: 0, longest: 0, bestKills: 0, fastestWin: 0
      };
    } else {
      if (name) p.name = String(name).replace(/[<>]/g, '').slice(0, 20) || p.name;
      p.platform = platform || p.platform;
      p.lastSeenAt = Date.now();
    }
    this.updateProgress(p);
    this.save();
    return p;
  }
  /* Rango y logros se recalculan SIEMPRE desde las estadísticas (tabla única en progression.js). */
  updateProgress(p) {
    for (const k of ['seconds', 'longest', 'bestKills', 'fastestWin', 'draws']) p[k] = Math.max(0, Number(p[k]) || 0);
    p.xp = Math.max(0, Number(p.xp) || 0);
    const state = progression.evaluate(p);
    p.rank = state.rank;
    p.achievements = state.achievements;
    delete p.achievementDetails;
  }
  finishMatch(room, engine) {
    if (!engine || !engine.winner || room.statsRecorded) return;
    room.statsRecorded = true;
    const duration = Math.max(0, Math.floor((Date.now() - engine.startedAt) / 1000));
    const winner = engine.winner;
    this.recordAIMatch(room, engine);
    const trackedPlayers = [...room.players.values()].filter(player => !player.bot && player.profileId);
    if (!trackedPlayers.length) return;
    this.data.totalMatches = Math.max(0, Number(this.data.totalMatches) || 0) + 1;
    const humans = [...room.players.values()].filter(player => !player.bot);
    const bots = [...room.players.values()].filter(player => player.bot);
    for (const player of trackedPlayers) {
      const p = this.profile(player.profileId, player.name, player.platform);
      if (!p) continue;
      const stats = engine.players[player.id] || {};
      const result = winner === 'draw' ? 'draw' : (winner === player.id ? 'win' : 'loss');
      const kills = Math.max(0, Number(stats.kills) || 0);
      // Contra humanos el XP es completo; contra bots depende de su dificultad.
      const opponentFactor = humans.length > 1 ? 1
        : bots.length ? Math.max(...bots.map(b => progression.BOT_XP_FACTOR[String(b.difficulty || 'normal').toLowerCase()] ?? 0.5)) : 0.25;
      p.matches++;
      if (result === 'win') {
        p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak);
        if (!p.fastestWin || duration < p.fastestWin) p.fastestWin = duration;
      } else if (result === 'draw') { p.draws = (p.draws || 0) + 1; p.streak = 0; }
      else { p.losses++; p.streak = 0; }
      p.kills += kills;
      p.produced += Math.max(0, Number(stats.produced) || 0);
      p.built += Math.max(0, Number(stats.built) || 0);
      p.seconds = (p.seconds || 0) + duration;
      p.longest = Math.max(p.longest || 0, duration);
      p.bestKills = Math.max(p.bestKills || 0, kills);
      const earned = progression.matchXp(result, kills, duration, opponentFactor);
      p.xp += earned;
      p.score += Math.max(0, Number(stats.score) || 0);
      p.lastMatch = { result: result === 'win' ? 'VICTORIA' : result === 'draw' ? 'EMPATE' : 'DERROTA', duration, at: Date.now(), xp: earned, kills };
      this.updateProgress(p);
      this.data.matches.unshift({ id: crypto.randomUUID(), roomId: room.id, profileId: p.id, name: p.name, result: p.lastMatch.result, duration, xp: earned, at: Date.now() });
    }
    this.data.matches = this.data.matches.slice(0, 2000);
    this.save();
  }

  aiProfile(difficulty = 'normal') {
    const key = ['easy', 'normal', 'hard', 'expert'].includes(String(difficulty).toLowerCase()) ? String(difficulty).toLowerCase() : 'normal';
    if (!this.data.aiProfiles[key]) this.data.aiProfiles[key] = {
      difficulty: key, matches: 0, wins: 0, losses: 0, kills: 0,
      totalScore: 0, totalDuration: 0, aggression: 0, caution: 0,
      strategy: { defense: 0, economy: 0, expansion: 0, attack: 0 },
      updatedAt: Date.now()
    };
    return this.data.aiProfiles[key];
  }
  recordAIMatch(room, engine) {
    if (!room || !engine || !engine.winner || room.aiStatsRecorded) return;
    room.aiStatsRecorded = true;
    let changed = false;
    for (const bot of room.players.values()) {
      if (!bot.bot) continue;
      const profile = this.aiProfile(bot.difficulty);
      const stats = engine.players[bot.id] || {};
      const won = engine.winner === bot.id;
      profile.matches++;
      if (won) profile.wins++; else profile.losses++;
      profile.kills += Math.max(0, Number(stats.kills) || 0);
      profile.totalScore += Math.max(0, Number(stats.score) || 0);
      profile.totalDuration += Math.max(0, Math.floor((Date.now() - engine.startedAt) / 1000));
      // Adaptación heurística acotada: no aprende con muestras pequeñas.
      // La tasa de victoria se suaviza y solo ajusta parámetros desde 10 partidas.
      const rate = profile.wins / Math.max(1, profile.matches);
      if (profile.matches >= 10) {
        const error = rate - 0.5;
        const step = Math.max(-0.002, Math.min(0.002, error * 0.004));
        profile.aggression = Math.max(-0.2, Math.min(0.2, profile.aggression + step));
        profile.caution = Math.max(-0.2, Math.min(0.2, profile.caution - step * 0.75));
      }
      profile.winRate = Math.round(rate * 100);
      profile.updatedAt = Date.now();
      changed = true;
    }
    if (changed) this.save();
  }
  aiSummary() {
    // Siempre devolver las tres dificultades para que el panel no desaparezca
    // cuando el servidor todavía no ha registrado partidas contra bots.
    return ['easy', 'normal', 'hard', 'expert'].map(difficulty => {
      const p = this.aiProfile(difficulty);
      return {
        difficulty: p.difficulty, matches: Number(p.matches) || 0,
        wins: Number(p.wins) || 0, losses: Number(p.losses) || 0,
        winRate: p.matches ? Math.round(p.wins * 100 / p.matches) : 0,
        kills: Number(p.kills) || 0,
        averageKills: p.matches ? Number((p.kills / p.matches).toFixed(1)) : 0,
        averageScore: p.matches ? Math.round(p.totalScore / p.matches) : 0,
        averageDuration: p.matches ? Math.round(p.totalDuration / p.matches) : 0,
        aggression: Number((p.aggression || 0).toFixed(3)),
        caution: Number((p.caution || 0).toFixed(3)),
        updatedAt: p.updatedAt || null
      };
    });
  }

  publicProfile(id) {
    const p = this.data.profiles[String(id || '')];
    if (!p) return null;
    this.updateProgress(p);
    const state = progression.evaluate(p);
    const { id: pid, name, platform, createdAt, lastSeenAt, matches, wins, losses, draws, kills, produced, built, score, streak, bestStreak, xp, rank, achievements, lastMatch, seconds, longest, bestKills, fastestWin } = p;
    return {
      id: pid, name, platform, createdAt, lastSeenAt, matches, wins, losses, draws: draws || 0, kills, produced, built, score,
      streak, bestStreak, xp, rank, achievements, achievementDetails: state.achievementDetails, medals: state.medals,
      medalLevels: state.medalLevels, rankIndex: state.rankIndex, nextRank: state.nextRank, xpToNext: state.xpToNext,
      winsToNext: state.winsToNext, progressionVersion: state.version,
      seconds: seconds || 0, longest: longest || 0, bestKills: bestKills || 0, fastestWin: fastestWin || 0,
      lastMatch, winRate: matches ? Math.round(wins * 100 / matches) : 0
    };
  }
  summary() {
    const profiles = Object.values(this.data.profiles);
    return {
      players: profiles.length,
      matches: Number(this.data.totalMatches) || this.data.matches.length,
      wins: profiles.reduce((n,p) => n + p.wins, 0),
      kills: profiles.reduce((n,p) => n + p.kills, 0),
      topPlayers: profiles.slice().sort((a,b) => b.xp - a.xp || b.wins - a.wins).slice(0,10).map(p => this.publicProfile(p.id))
    };
  }
  leaderboard(limit = 50) {
    return Object.values(this.data.profiles).sort((a,b) => b.xp-a.xp || b.wins-a.wins || b.score-a.score).slice(0, Math.min(100, Math.max(1, limit))).map(p => this.publicProfile(p.id));
  }
}
module.exports = { Persistence };
