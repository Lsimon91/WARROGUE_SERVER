'use strict';

const crypto = require('crypto');
const { AIEngine } = require('./ai-engine');

const botId = () =>
  `BOT_${crypto.randomBytes(7).toString('hex')}`;

class BotManager {
  constructor(options = {}) {
    this.waitMs = Number(options.waitMs || 10000);
    this.autonomous = options.autonomous !== false;

    this.pending = new Map();
    this.ais = new Map();

    this.onChange = options.onChange || (() => {});
    this.learningProvider = options.learningProvider || (() => null);
  }

  schedule(room) {
    this.cancel(room.id);

    if (room.status !== 'lobby') return;

    const timer = setTimeout(() => {
      this.pending.delete(room.id);

      if (
        room.status !== 'lobby' ||
        room.players.size !== 1 ||
        [...room.players.values()].some(p => p.bot)
      ) {
        return;
      }

      this.addBot(room, 'Rival IA');
    }, this.waitMs);

    timer.unref?.();
    this.pending.set(room.id, timer);
  }

  cancel(roomId) {
    const timer = this.pending.get(roomId);

    if (timer) clearTimeout(timer);

    this.pending.delete(roomId);
  }

  addBot(room, name = 'Rival IA') {
    if (room.players.size >= 8) return null;

    const used = new Set(
      [...room.players.values()].map(p => p.slot)
    );

    let slot = 0;

    while (used.has(slot) && slot < 8) {
      slot++;
    }

    if (slot >= 8) return null;

    const player = {
      id: botId(),
      name,
      slot,
      ready: true,
      bot: true,
      ws: null,
      difficulty: ['easy', 'normal', 'hard', 'expert'].includes(String(process.env.BOT_DIFFICULTY || 'normal').toLowerCase())
        ? String(process.env.BOT_DIFFICULTY || 'normal').toLowerCase()
        : 'normal'
    };

    room.players.set(player.id, player);
    room.updatedAt = Date.now();

    this.onChange(room, {
      type: 'bot_joined',
      player: {
        playerId: player.id,
        name: player.name,
        slot,
        ready: true,
        isHost: false,
        isBot: true
      }
    });

    return player;
  }

  removeBots(room) {
    this.cancel(room.id);

    for (const [id, player] of room.players) {
      if (!player.bot) continue;

      room.players.delete(id);
      this.ais.delete(`${room.id}:${id}`);
    }
  }

  start(room, engine) {
    this.cancel(room.id);

    for (const player of room.players.values()) {
      if (!player.bot) continue;

      const key = `${room.id}:${player.id}`;

      this.ais.set(
        key,
        new AIEngine(
          engine,
          player.id,
          player.difficulty,
          this.learningProvider(player.difficulty)
        )
      );
    }
  }

  think(room, engine) {
    for (const player of room.players.values()) {
      if (!player.bot) continue;

      const key = `${room.id}:${player.id}`;

      let ai = this.ais.get(key);

      if (!ai) {
        ai = new AIEngine(
          engine,
          player.id,
          player.difficulty,
          this.learningProvider(player.difficulty)
        );

        this.ais.set(key, ai);
      }

      ai.think();
    }
  }

  stop(roomId) {
    this.cancel(roomId);

    for (const key of this.ais.keys()) {
      if (key.startsWith(`${roomId}:`)) {
        this.ais.delete(key);
      }
    }
  }
}

module.exports = { BotManager };