WARROGUE PUBLIC SERVER — VERSION 2.5.3
=======================================

ENTRYPOINT
`npm start` ejecuta `server.js`. `src/server.js` es una rama heredada y no se ejecuta con el script principal.

COMPONENTES
- server.js: HTTP, salas, autenticación, WS/WSS y comandos.
- game-engine.js: simulación RTS autoritativa de partidas públicas.
- game-loop.js: avance de simulación y envío de estado filtrado por jugador.
- ai-engine.js / bot-manager.js: bots y decisiones heurísticas.
- persistence.js: perfiles, cuentas, tokens, resultados y estadísticas IA en JSON.
- public/: centro de mando web.

INSTALACIÓN
1. Instala Node.js 18 o superior.
2. Ejecuta `npm install`.
3. Copia `.env.example` a `.env` si necesitas ajustar variables. El servidor carga `.env` sin dependencia adicional; las variables exportadas en el proceso prevalecen.
4. Ejecuta `npm run check`, `npm test` y `npm start`.

RED Y TLS
- Por defecto HTTP/WS escucha en PORT (8080).
- HTTPS/WSS directo se activa solo si existen ambos archivos configurados por `TLS_KEY_FILE` y `TLS_CERT_FILE` (o `certs/server.key` y `certs/server.crt`).
- En producción se recomienda terminar TLS en Nginx/Caddy y reenviar HTTP y WebSocket Upgrade al puerto PORT. El cliente debe conectarse mediante `wss://tu-dominio/`.
- Sin TLS, usa el servicio solo para desarrollo o LAN de confianza. No expongas HTTP/WS sin cifrado a Internet.
- `TRUST_PROXY=true` solo detrás de un proxy confiable que sobrescriba `X-Forwarded-For`.

VARIABLES
PORT=8080, WSS_PORT=8443, MAX_ROOMS=500, ROOM_IDLE_MINUTES=30, HEARTBEAT_INTERVAL_MS=25000, RATE_LIMIT_PER_SEC=60, BOT_WAIT_MS=10000, BOT_DIFFICULTY=normal, AUTO_BOT_ARENA=true, PEACE_SECONDS=120. Ver `.env.example`.

SEGURIDAD Y PERSISTENCIA
- Autenticación: contraseñas con scrypt; tokens aleatorios almacenados como SHA-256 y caducidad de 30 días.
- Limitación: 8 intentos por combinación IP/cuenta y 40 por IP cada 15 minutos.
- Solicitudes de autenticación limitadas a 16 KiB.
- `data/warrogue.json` conserva perfiles, cuentas, partidas y métricas de IA. Cada guardado genera `data/warrogue.json.bak` con el estado anterior.
- El JSON distribuido contiene estadísticas anonimizadas y no incluye cuentas/tokens reales. En una instalación existente conserva tu propio `data/` al actualizar y realiza respaldos externos periódicos. No se soportan varias instancias escribiendo simultáneamente el mismo JSON.
- No se distribuyen certificados ni claves privadas.

IA ONLINE
Las métricas agregadas se consultan en `GET /api/ai/stats`. La adaptación de agresividad/cautela es heurística, se activa desde 10 partidas por dificultad y está acotada; no es entrenamiento neuronal.

La auditoría principal está en `../../AUDITORIA_WARROGUE_1_12_0.md`. Las limitaciones de gameplay, compilación y pruebas no realizadas se documentan allí.
