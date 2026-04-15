# BetIQ — Problemas sin resolver

## Stack
- **Frontend:** Next.js 14 App Router en Vercel — `apps/web/`
- **Backend:** FastAPI en Railway (Docker) — `apps/api/`
- **DB:** Supabase (PostgreSQL con RLS)
- **Repo:** `github.com/luismojica1218-stack/betiq` rama `main`

---

## Problema 1 — EV siempre 0%, cuotas idénticas 1.90/1.90

### Síntoma
Todas las tarjetas de NBA muestran exactamente 1.90 / 1.90 y EV 0.0%. El botón "Agregar apuesta" aparece deshabilitado en el 100% de los partidos.

### Causa raíz identificada
Los partidos guardados en Supabase tienen `home_team_id` / `away_team_id` = null o los UUIDs no resuelven a nombres reales al hacer el SELECT en `teams`. Cuando `teamName = ''` → `getStrength('')` devuelve 0.50 → odds simétricas → `EV = 0.50 × 1.90 − 1 = −0.05` (negativo, clampeado a 0).

### Lo que se intentó sin éxito
- FK join `teams!home_team_id` → PostgREST ambiguity, devuelve null
- Batch query `SELECT id, name FROM teams WHERE id IN (...)` → teamIds vacío porque home_team_id es null en la tabla matches
- Quality gate para detectar datos corruptos y caer a ESPN
- Rediseño completo del algoritmo en Next.js usando ESPN standings directamente (último commit `281d889`)

### Estado actual
El último commit (`281d889`) reescribió los 3 routes para no depender de Supabase: usa ESPN fixtures + ESPN standings + modelo matemático (Poisson para fútbol, Elo para tenis, pts differential para NBA). **No se sabe si esto funcionó** porque el usuario cerró la sesión antes de confirmar.

---

## Problema 2 — Partidos duplicados (misma tarjeta 4-6 veces)

### Síntoma
El mismo partido (ej. Philadelphia 76ers vs Orlando Magic) aparece 4-6 veces en el módulo.

### Causa raíz
El scraper de Railway se ejecuta múltiples veces y cada vez inserta el mismo partido en `matches` sin verificar si ya existe (no hay `ON CONFLICT` en el INSERT de matches). La deduplicación en Next.js falla porque las claves son nulas.

### Fix pendiente
Agregar `ON CONFLICT (home_team_id, away_team_id, match_date::date, sport)` al INSERT de matches en los routers Python. Requiere también agregar ese UNIQUE constraint en Supabase.

---

## Problema 3 — La Liga no aparece en el módulo de fútbol tras scraping

### Síntoma
El scraping de La Liga reporta "10 partidos guardados" pero el módulo de fútbol no los muestra. Otras ligas como Bundesliga y Serie A sí aparecen.

### Causa raíz probable
La próxima jornada de La Liga está a >8 días de distancia cuando se ejecutó el scraper. La query en Next.js filtraba `lte(match_date, now + 8 days)`. Se amplió a 14 días pero no se confirmó si funcionó.

### Fix aplicado (no confirmado)
`lte('match_date', end)` donde `end = now + 14 días`.

---

## Problema 4 — Tenis muestra datos demo, no calendario real ATP/WTA

### Síntoma
El módulo de tenis siempre muestra los mismos 4 partidos ficticios (Sinner vs Alcaraz, etc.) en lugar del calendario real.

### Causa raíz
El scraper de tenis cae a `_demo_upcoming_matches()` porque:
1. UTS (ultimatetennisstatistics.com) está bloqueado desde Railway
2. SofaScore devuelve 0 resultados para tenis en ciertos días
3. ESPN no soporta bien el parámetro `?dates=` para tenis

### Fix en el último commit
El route de tenis (`281d889`) ahora usa ESPN ATP/WTA scoreboards directamente desde Next.js con Elo estático por jugador. No depende del backend Python.

---

## Problema 5 — Stats scraper siempre falla, modelo ML entrena sin datos

### Síntoma
Al ejecutar "Scrape Stats" en el Hub, el log muestra:
```
📊 fbref: scrapeando stats de Premier League...
⚠️ No se pudo obtener stats de liga
✅ premier-league: 13 partidos guardados, 0 equipos
```

### Causa raíz
- **fbref.com** bloquea IPs de Railway → 0 team stats
- **basketball-reference.com** también bloqueado
- **UTS** (tenis) también bloqueado
- El modelo XGBoost hace bootstrap training con 0 datos reales → CV accuracy ≈ 0.61 (random) → predicciones sin valor

### Fix parcial aplicado
Se implementó `get_football_team_stats()` y `get_nba_team_stats()` usando ESPN standings API (mismo origen que funciona para fixtures). Se inyecta en `FbrefFootballScraper.scrape_team_stats()` y `NBAStatsScraper.scrape_team_season_stats()` como primer intento.

### Pendiente confirmar
Que el log cambie a `📊 ESPN: cargando standings/stats de premier-league...` con X equipos encontrados.

---

## Problema 6 — Pipeline de predicción ML no funciona end-to-end

### Síntoma
El flujo teórico es: Scrape Stats → Train → Predict → ver EV en módulos. Ningún paso conecta con el siguiente de forma funcional.

### Detalles
- **Scrape Stats** guarda fixtures en `matches` pero stats en `team_stats` (tabla con schema `stats_json jsonb`) — nunca se usa este dato para entrenar
- **Train** llama a `bootstrap_training()` que genera datos sintéticos, no lee `team_stats`
- **Predict** genera una predicción para un match_id específico pero los módulos nunca leen `predictions` de Supabase porque el FK join falla (Problema 1)
- La tabla `team_stats` tiene schema: `id, match_id (nullable), team_id, stats_json, scraped_at, source_url`

### Solución propuesta (no implementada)
Reemplazar el pipeline ML por un modelo matemático directamente en los routes de Next.js (Poisson para fútbol, Elo para tenis, pts differential para NBA), usando ESPN standings como fuente de datos. Esto elimina la dependencia de Railway para que los módulos funcionen.

---

## Problema 7 — Supabase RLS bloquea escrituras desde Railway

### Síntoma
Las políticas de RLS requieren `auth.role() = 'service_role'` para INSERT. Si `SUPABASE_SERVICE_KEY` no está bien configurada en Railway, todos los upserts fallan silenciosamente.

### Variables de entorno necesarias en Railway
```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJh...  # service_role JWT, NO la anon key
```

### Verificación
Ejecutar en la consola de Supabase:
```sql
SELECT id, name, sport FROM teams WHERE sport = 'nba' LIMIT 5;
SELECT id, home_team_id, away_team_id FROM matches WHERE sport = 'nba' LIMIT 5;
```
Si `home_team_id` es null → confirma que las escrituras fallan por RLS o key incorrecta.

---

## Resumen de archivos clave

| Archivo | Propósito | Estado |
|---|---|---|
| `apps/web/app/api/nba/matches/route.ts` | Módulo NBA — fetch ESPN + modelo | Reescrito en `281d889` |
| `apps/web/app/api/football/matches/route.ts` | Módulo fútbol — Poisson + ESPN | Reescrito en `281d889` |
| `apps/web/app/api/tennis/matches/route.ts` | Módulo tenis — Elo + ESPN | Reescrito en `281d889` |
| `apps/web/app/nba/NBAClient.tsx` | UI módulo NBA | Sin cambios recientes |
| `apps/web/app/futbol/FutbolClient.tsx` | UI módulo fútbol | Mapeado OK |
| `apps/web/app/tenis/TenisClient.tsx` | UI módulo tenis | Mapeado OK |
| `apps/api/scrapers/sofascore_scraper.py` | Stats ESPN + SofaScore | Actualizado |
| `apps/api/scrapers/football_scraper.py` | Fixtures fútbol | SofaScore→ESPN→fbref |
| `apps/api/scrapers/nba_scraper.py` | Fixtures + stats NBA | ESPN primario |
| `apps/api/routers/football.py` | Guarda en Supabase | Inserta sin ON CONFLICT |
| `apps/api/routers/nba.py` | Guarda en Supabase | Inserta sin ON CONFLICT |
| `supabase/migrations/001_initial_schema.sql` | Schema DB | Sin UNIQUE en matches |

---

## Lo que necesita solución inmediata (prioridad)

1. **Verificar** que `SUPABASE_SERVICE_KEY` (service_role) está correcta en Railway env vars
2. **Agregar** `UNIQUE (home_team_id, away_team_id, date_trunc('day', match_date), sport)` a la tabla `matches` y usar `ON CONFLICT DO NOTHING` en los routers Python
3. **Confirmar** que el commit `281d889` (rediseño ESPN+modelo matemático) resuelve EV=0 y duplicados en los módulos frontend
4. **Probar** el scraper de stats con la nueva fuente ESPN standings y verificar que aparece "X equipos con stats" en el log
