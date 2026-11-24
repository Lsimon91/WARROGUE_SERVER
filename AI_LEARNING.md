# WARROGUE Online AI learning

La autoridad y persistencia de la IA online residen en el servidor Node.js. Los agregados se guardan en `data/warrogue.json`, dentro de `aiProfiles`, y se consultan mediante `GET /api/ai/stats`.

Cada partida terminada contra bots registra resultados, eliminaciones, puntuación y duración. Los parámetros `aggression` y `caution` son adaptación heurística acotada, no entrenamiento neuronal. Desde esta versión no se ajustan con menos de 10 partidas por dificultad; a partir del umbral se usa una actualización gradual limitada a [-0.2, 0.2]. La IA individual Android continúa siendo independiente de estos datos.

Las estadísticas son agregadas por dificultad y no contienen conversaciones ni datos personales. Las tres dificultades se devuelven aunque todavía no tengan partidas, con contadores en cero. `updatedAt: null` significa que no existe una muestra registrada para esa dificultad.

Las migraciones existentes completan `aiProfiles` sin descartar perfiles ni resultados. Cada guardado escribe primero un archivo temporal sincronizado y conserva el estado previo en `warrogue.json.bak`. Para restaurar manualmente, detén el servidor y reemplaza `warrogue.json` por el respaldo después de verificarlo.
