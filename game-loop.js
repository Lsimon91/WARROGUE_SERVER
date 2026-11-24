'use strict';

const { GameEngine } = require('./game-engine');

class GameLoop {
  constructor({
    rooms,
    bots,
    broadcast,
    onMatchFinished = null,
    intervalMs = 100
  }) {
    this.rooms = rooms;
    this.bots = bots;
    this.broadcast = broadcast;
    this.onMatchFinished = onMatchFinished;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.last = Date.now();
  }

  start() {
    if (this.timer) return;

    this.last = Date.now();

    this.timer = setInterval(
      () => this.step(),
      this.intervalMs
    );

    this.timer.unref?.();
  }

  /*
   * Envía un estado individual a cada jugador.
   * Nunca transmite el estado completo a todos.
   */
  broadcastPlayerStates(room, type = 'game_state') {
    if (!room || !room.engine) return;

    const now = Date.now();

    for (const player of room.players.values()) {
      if (
        !player.ws ||
        player.ws.readyState !== 1
      ) {
        continue;
      }

      let state;

      try {
        state = room.engine.exportState(player.id);
      } catch (e) {
        console.error(
          'Error generando estado para jugador:',
          player.id,
          e.message
        );

        continue;
      }

      try {
        player.ws.send(JSON.stringify({
          type,
          roomId: room.id,
          revision: room.revision,
          state,
          serverAuthoritative: true
        }));
      } catch (e) {
        console.error(
          'Error enviando estado a jugador:',
          player.id,
          e.message
        );
      }
    }

    /*
     * Se conserva una copia interna completa para el servidor.
     * Esta copia nunca se envía directamente a los clientes.
     */
    if (type === 'game_state') {
      try {
        room.gameState = room.engine.exportState();
      } catch (_) {
        room.gameState = null;
      }
    }

    room.lastStateBroadcast = now;
  }

  /*
   * Envía game_over con estado filtrado por jugador.
   */
  broadcastGameOver(room) {
    if (!room || !room.engine) return;

    for (const player of room.players.values()) {
      if (
        !player.ws ||
        player.ws.readyState !== 1
      ) {
        continue;
      }

      let state = null;

      try {
        state = room.engine.exportState(player.id);
      } catch (e) {
        console.error(
          'Error generando estado final:',
          e.message
        );
      }

      try {
        player.ws.send(JSON.stringify({
          type: 'game_over',
          roomId: room.id,
          winner: room.engine.winner,
          revision: room.revision,
          state,
          serverAuthoritative: true
        }));
      } catch (e) {
        console.error(
          'Error enviando resultado a jugador:',
          player.id,
          e.message
        );
      }
    }

    try {
      room.gameState = room.engine.exportState();
    } catch (_) {
      room.gameState = null;
    }
  }

  step() {
    const now = Date.now();

    const dt = Math.min(
      0.25,
      Math.max(0, (now - this.last) / 1000)
    );

    this.last = now;

    for (const room of this.rooms.values()) {
      if (
        room.status !== 'playing' ||
        !room.engine
      ) {
        continue;
      }

      room.engine.update(dt);

      this.bots.think(
        room,
        room.engine
      );

      room.revision++;

      /*
       * Actualización de estado cada 200 ms.
       * Cada jugador recibe exclusivamente su visión.
       */
      if (
        now - (room.lastStateBroadcast || 0) >= 200
      ) {
        this.broadcastPlayerStates(
          room,
          'game_state'
        );
      }

      /*
       * Final de partida.
       */
      if (room.engine.winner) {
        room.status = 'finished';

        try { this.onMatchFinished?.(room, room.engine); }
        catch (e) { console.error('[PERSISTENCE] No se pudo guardar resultado:', e.message); }

        this.broadcastGameOver(room);

        this.bots.stop(room.id);

        /*
         * Las arenas autónomas reinician la batalla
         * después de unos segundos.
         */
        if (
          room.autonomous &&
          !room.restartTimer
        ) {
          room.restartTimer = setTimeout(() => {
            room.restartTimer = null;

            room.engine = new GameEngine(room);
            room.statsRecorded = false;
            room.aiStatsRecorded = false;

            for (const player of room.players.values()) {
              room.engine.addPlayer(player);
            }

            room.status = 'playing';
            room.revision++;
            room.gameState = null;
            room.lastStateBroadcast = 0;

            this.bots.start(
              room,
              room.engine
            );

            this.broadcast(room, {
              type: 'autonomous_match_restarted',
              roomId: room.id,
              players: [...room.players.values()].map(p => ({
                playerId: p.id,
                name: p.name,
                slot: p.slot,
                isBot: true
              }))
            });

          }, 7000);

          room.restartTimer.unref?.();
        }
      }
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = null;
  }
}

module.exports = {
  GameLoop
};
