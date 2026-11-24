'use strict';

const { UNIT, BUILDING } = require('./game-engine');

const dist = (a, b) =>
  Math.hypot(a.x - b.x, a.y - b.y);

class AIEngine {
  constructor(engine, playerId, difficulty = 'normal', learning = null) {
    this.engine = engine;
    this.playerId = playerId;
    this.difficulty = ['easy', 'normal', 'hard', 'expert'].includes(String(difficulty).toLowerCase()) ? String(difficulty).toLowerCase() : 'normal';
    this.learning = learning || {};
    this.decisions = { defense: 0, economy: 0, expansion: 0, attack: 0 };
    this.adaptation = { aggression: Math.max(-0.2, Math.min(0.2, Number(this.learning.aggression) || 0)), caution: Math.max(-0.2, Math.min(0.2, Number(this.learning.caution) || 0)) };

    this.nextThink = 0;
    this.startedAt = Date.now();

    this.phase = 'development';
    this.lastAction = '';

    this.lastAttackAt = 0;
    const baseCooldown = this.difficulty === 'expert' ? 24000 : this.difficulty === 'hard' ? 32000 : this.difficulty === 'easy' ? 60000 : 45000;
    this.attackCooldown = Math.max(20000, Math.min(75000, Math.round(baseCooldown * (1 - this.adaptation.aggression + this.adaptation.caution * 0.5))));
  }

  getThinkInterval() {
    if (this.difficulty === 'expert') return 1000;
    if (this.difficulty === 'hard') return 1800;
    if (this.difficulty === 'easy') return 3800;
    return 2800;
  }

  getPreparationTime() {
    if (this.difficulty === 'expert') return 60000;
    if (this.difficulty === 'hard') return 90000;
    if (this.difficulty === 'easy') return 210000;
    return Math.round(150000 * (1 - this.adaptation.aggression + this.adaptation.caution));
  }

  getMinimumArmy() {
    const base = this.difficulty === 'expert' ? 4 : this.difficulty === 'hard' ? 5 : this.difficulty === 'easy' ? 9 : 7;
    return Math.max(4, Math.min(11, Math.round(base + this.adaptation.caution * 8 - this.adaptation.aggression * 5)));
  }

  getEnemyNearBase(base, enemies, radius = 0.19) {
    return enemies
      .filter(enemy => dist(base, enemy) <= radius)
      .sort((a, b) =>
        dist(base, a) - dist(base, b)
      )[0] || null;
  }

  think(now = Date.now()) {
    if (now < this.nextThink || this.engine.winner) return;

    this.nextThink = now + this.getThinkInterval();

    const e = this.engine;
    const p = e.player(this.playerId);

    if (!p || !p.alive) return;

    const own = e.units.filter(
      u => u.owner === this.playerId
    );

    // La IA solo recibe objetivos enemigos que están dentro de su visión
    // actual. No consulta posiciones ocultas ni puntos de aparición rivales.
    const visibility = e.computeVisibility(this.playerId);
    const visible = visibility.visible;
    const isCurrentlyVisible = object => {
      const gx = Math.floor(object.x * e.fogGridWidth);
      const gy = Math.floor(object.y * e.fogGridHeight);
      return visible.has(`${gx},${gy}`);
    };
    const isExplored = object => {
      const gx = Math.floor(object.x * e.fogGridWidth);
      const gy = Math.floor(object.y * e.fogGridHeight);
      return visibility.explored.has(`${gx},${gy}`);
    };
    const enemies = e.units.filter(
      u => u.owner !== this.playerId && isCurrentlyVisible(u)
    );

    const enemyBuildings = e.buildings.filter(
      b => b.owner !== this.playerId && isCurrentlyVisible(b)
    );

    const base = e.buildings.find(
      b => b.owner === this.playerId && b.type === 'HQ'
    );

    if (!base) return;

    const barracks = e.buildings.filter(
      b => b.owner === this.playerId &&
        b.type === 'BARRACKS'
    ).length;

    const factories = e.buildings.filter(
      b => b.owner === this.playerId &&
        b.type === 'FACTORY'
    ).length;

    const turrets = e.buildings.filter(
      b => b.owner === this.playerId &&
        b.type === 'TURRET'
    ).length;
    const powerPlants = e.buildings.filter(
      b => b.owner === this.playerId && b.type === 'POWER'
    ).length;
    const radarCount = e.buildings.filter(
      b => b.owner === this.playerId && b.type === 'RADAR'
    ).length;

    const soldiers = own.filter(
      u => u.type === 'SOLDIER'
    ).length;

    const tanks = own.filter(u => u.type === 'TANK' || u.type === 'HEAVY_TANK').length;
    const artillery = own.filter(u => u.type === 'ARTILLERY').length;
    const snipers = own.filter(u => u.type === 'SNIPER').length;
    const engineers = own.filter(u => u.type === 'ENGINEER').length;

    const scouts = own.filter(
      u => u.type === 'SCOUT'
    ).length;

    const army = own.filter(
      u => u.type !== 'COMMANDER' &&
        u.type !== 'MEDIC'
    );

    const commander = own.find(
      u => u.type === 'COMMANDER'
    );

    const elapsed = now - this.startedAt;
    const prepared = elapsed >= this.getPreparationTime();

    const nearbyEnemy = this.getEnemyNearBase(
      base,
      enemies,
      0.19
    );

    // 1. Defensa: solo reacciona ante enemigos cercanos.
    if (nearbyEnemy) {
      const defenders = army.filter(
        u => dist(u, base) <= 0.24
      );

      if (defenders.length > 0) {
        e.command(this.playerId, {
          action: 'attack',
          unitIds: defenders.map(u => u.id),
          targetId: nearbyEnemy.id
        });

        this.decisions.defense++;
        this.lastAction = 'defendiendo la base';
        return;
      }
    }

    // 2. Economía: recolectar sin enviar al comandante al enemigo.
    const nearResource = e.resources
      .filter(n => n.amount > 0 && isExplored(n))
      .sort((a, b) =>
        dist(base, a) - dist(base, b)
      )[0];

    if (
      commander &&
      nearResource &&
      commander.gatherId == null &&
      p.credits < 900
    ) {
      e.command(this.playerId, {
        action: 'gather',
        unitId: commander.id,
        resourceId: nearResource.id
      });

      this.decisions.economy++;
      this.lastAction = 'recolectando recursos';
      return;
    }

    // 3. Construcción inicial.
    if (
      barracks === 0 &&
      p.credits >= BUILDING.BARRACKS.cost
    ) {
      const offset = base.x < 0.5 ? 0.075 : -0.075;

      e.build(
        this.playerId,
        'BARRACKS',
        base.x + offset,
        base.y + 0.065
      ) || e.build(this.playerId, 'BARRACKS');

      this.decisions.expansion++;
      this.lastAction = 'construyendo cuartel';
      return;
    }

    if (
      barracks > 0 &&
      factories === 0 &&
      p.credits >= BUILDING.FACTORY.cost &&
      soldiers >= 2
    ) {
      const offset = base.x < 0.5 ? 0.12 : -0.12;

      e.build(
        this.playerId,
        'FACTORY',
        base.x + offset,
        base.y - 0.085
      ) || e.build(this.playerId, 'FACTORY');

      this.lastAction = 'construyendo fábrica';
      return;
    }

    // 4. Gestión energética: evita que la producción se paralice por falta
    // de capacidad. Amplía la red antes de seguir acumulando edificios caros.
    const energyRatio = (p.energy || 0) / Math.max(1, p.maxEnergy || 200);
    if (powerPlants < 2 && energyRatio < 0.68 && p.credits >= BUILDING.POWER.cost) {
      if (e.build(this.playerId, 'POWER')) {
        this.lastAction = 'ampliando suministro energético';
        this.decisions.economy++;
        return;
      }
    }

    // Ingenieros priorizan reparar instalaciones dañadas que estén a su alcance.
    if (engineers > 0) {
      const damaged = e.buildings
        .filter(b => b.owner === this.playerId && b.health < (b.maxHealth || BUILDING[b.type]?.hp || 300) * 0.72)
        .sort((a, b) => (a.health / (a.maxHealth || BUILDING[a.type]?.hp || 300)) - (b.health / (b.maxHealth || BUILDING[b.type]?.hp || 300)));
      for (const target of damaged) {
        if (e.repair(this.playerId, target.id)) {
          this.lastAction = 'ingenieros reparando instalaciones';
          this.decisions.defense++;
          return;
        }
      }
    }

    // Radar propio amplía la exploración y reduce la dependencia de patrullas.
    if (radarCount === 0 && powerPlants > 0 && p.credits >= BUILDING.RADAR.cost && energyRatio > 0.45) {
      if (e.build(this.playerId, 'RADAR')) {
        this.lastAction = 'desplegando radar de exploración';
        this.decisions.expansion++;
        return;
      }
    }

    // 5. Defensa estática. No construye torretas por detectar
    // cualquier jugador al otro lado del mapa. Prueba varias
    // posiciones alrededor de la base y, si ninguna sirve,
    // sigue con el resto de decisiones (antes se quedaba atascada).
    if (
      turrets < 2 &&
      p.credits >= BUILDING.TURRET.cost &&
      elapsed > 45000
    ) {
      const sx = base.x < 0.5 ? 1 : -1;
      const sy = base.y < 0.5 ? 1 : -1;

      const spots = [
        [0.13 * sx, 0.02 * sy],
        [0.02 * sx, 0.13 * sy],
        [0.14 * sx, 0.12 * sy],
        [-0.02 * sx, -0.1 * sy],
        [0.2 * sx, 0.0],
        [0.0, 0.2 * sy]
      ];

      const built = spots.some(([dx, dy]) =>
        e.build(this.playerId, 'TURRET', base.x + dx, base.y + dy)
      ) || e.build(this.playerId, 'TURRET');

      if (built) {
        this.lastAction = 'reforzando defensa';
        return;
      }
    }

    // 6. Producción de tropas.
    if (
      barracks > 0 &&
      soldiers < (this.difficulty === 'expert' ? 9 : this.difficulty === 'hard' ? 7 : this.difficulty === 'easy' ? 4 : 5) &&
      p.credits >= UNIT.SOLDIER.cost
    ) {
      e.recruit(this.playerId, 'SOLDIER');
      this.lastAction = 'entrenando soldados';
      return;
    }

    if (factories > 0 && tanks < (this.difficulty === 'expert' ? 4 : this.difficulty === 'hard' ? 3 : 2) && p.credits >= UNIT.TANK.cost) {
      e.recruit(this.playerId, 'TANK'); this.lastAction = 'produciendo tanques'; return;
    }
    if (factories > 0 && artillery < (this.difficulty === 'expert' ? 2 : 1) && p.credits >= UNIT.ARTILLERY.cost) {
      e.recruit(this.playerId, 'ARTILLERY'); this.lastAction = 'desplegando artillería'; return;
    }
    if (barracks > 0 && snipers < (this.difficulty === 'expert' ? 2 : 1) && p.credits >= UNIT.SNIPER.cost) {
      e.recruit(this.playerId, 'SNIPER'); this.lastAction = 'entrenando francotiradores'; return;
    }
    if (barracks > 0 && engineers < 1 && p.credits >= UNIT.ENGINEER.cost) {
      e.recruit(this.playerId, 'ENGINEER'); this.lastAction = 'desplegando ingenieros'; return;
    }

    if (
      scouts < (this.difficulty === 'expert' ? 4 : this.difficulty === 'hard' ? 3 : 2) &&
      soldiers >= 3 &&
      p.credits >= UNIT.SCOUT.cost
    ) {
      e.recruit(this.playerId, 'SCOUT');
      this.lastAction = 'produciendo exploradores';
      return;
    }

    // 7. No atacar hasta terminar la preparación.
    if (!prepared) {
      this.phase = 'development';
      this.lastAction = 'desarrollando la base';
      return;
    }

    this.phase = 'ready';

    // 8. Atacar solamente si hay ejército suficiente y se
    // ha cumplido el tiempo entre ofensivas.
    if (
      army.length >= this.getMinimumArmy() &&
      now - this.lastAttackAt >= this.attackCooldown
    ) {
      // No se escoge un objetivo de cualquier parte del mapa.
      // Solo enemigos detectados cerca de unidades propias.
      const visibleTargets = [
        ...enemies,
        ...enemyBuildings
      ].filter(target =>
        army.some(unit =>
          dist(unit, target) <=
          (UNIT[unit.type]?.vision || 0.12)
        )
      );

      if (visibleTargets.length > 0) {
        const target = visibleTargets.sort(
          (a, b) =>
            dist(base, a) - dist(base, b)
        )[0];

        e.command(this.playerId, {
          action: 'attack',
          unitIds: army.map(u => u.id),
          targetId: target.id
        });

        this.lastAttackAt = now;
        this.decisions.attack++;
        this.lastAction = 'ataque organizado';
        return;
      }

      // Sin contactos visibles, la IA explora un sector estratégico del
      // mapa en lugar de consultar la aparición o base oculta de un rival.
      // El centro es una zona pública de interés, no una coordenada enemiga.
      const center = { x: 0.5, y: 0.5 };
      const angle = ((this.playerId.length * 37 + this.decisions.expansion * 53 + this.decisions.attack * 97) % 360) * Math.PI / 180;
      const radius = this.difficulty === 'expert' ? 0.22 : 0.17;
      const goal = {
        x: Math.max(0.05, Math.min(0.95, center.x + Math.cos(angle) * radius)),
        y: Math.max(0.05, Math.min(0.95, center.y + Math.sin(angle) * radius))
      };
      e.command(this.playerId, {
        action: 'attack_move',
        unitIds: army.map(u => u.id),
        x: goal.x,
        y: goal.y
      });
      this.lastAttackAt = now;
      this.decisions.attack++;
      this.lastAction = 'explorando sector de avance';
      return;
    }

    this.lastAction = 'defendiendo y explorando';
  }
}

module.exports = { AIEngine };