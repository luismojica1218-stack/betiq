"""
BetIQ — SofaScore Scraper
Fuente pública: api.sofascore.com — sin autenticación, cubre los 3 deportes.
Usada como fuente principal cuando fbref/UTS/Basketball-Reference están bloqueados.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

SOFA_BASE = "https://api.sofascore.com/api/v1"

# Common headers to avoid basic bot detection
SOFA_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "es-CO,es;q=0.9,en;q=0.8",
    "Referer": "https://www.sofascore.com/",
    "Origin": "https://www.sofascore.com",
}

# SofaScore unique tournament IDs for key competitions
FOOTBALL_TOURNAMENTS = {
    "premier-league":     17,
    "la-liga":            8,
    "bundesliga":         35,
    "serie-a":            23,
    "ligue-1":            34,
    "champions-league":   7,
    "libertadores":       384,
    "europa-league":      679,
}

NBA_UNIQUE_TOURNAMENT_ID = 132  # NBA on SofaScore


async def _fetch_json(client: httpx.AsyncClient, url: str) -> Optional[dict]:
    for attempt in range(3):
        try:
            r = await client.get(url, headers=SOFA_HEADERS, timeout=20.0, follow_redirects=True)
            if r.status_code == 429:
                await asyncio.sleep(2 ** attempt * 3)
                continue
            if r.is_success:
                return r.json()
        except Exception as e:
            logger.warning(f"SofaScore attempt {attempt+1}/3 failed for {url}: {e}")
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
    return None


class SofaScoreFootballScraper:
    """
    Scrapes upcoming football fixtures from SofaScore.
    Covers: EPL, La Liga, Bundesliga, Serie A, Ligue 1, UCL, Libertadores.
    """

    async def scrape_upcoming_fixtures(
        self,
        league_key: str = "premier-league",
        days_ahead: int = 10,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        tournament_id = FOOTBALL_TOURNAMENTS.get(league_key)
        if not tournament_id:
            await log(f"⚠️ Liga '{league_key}' no soportada en SofaScore scraper")
            return []

        await log(f"⚽ SofaScore: cargando fixtures de {league_key}...")

        fixtures: list[dict] = []
        today  = datetime.now(timezone.utc)

        async with httpx.AsyncClient() as client:
            for day_offset in range(days_ahead):
                target = today + timedelta(days=day_offset)
                date_str = target.strftime("%Y-%m-%d")
                url = f"{SOFA_BASE}/sport/football/scheduled-events/{date_str}"
                data = await _fetch_json(client, url)
                if not data:
                    continue

                events = data.get("events", [])
                for event in events:
                    # Filter by tournament
                    tid = (
                        event.get("tournament", {})
                             .get("uniqueTournament", {})
                             .get("id")
                    )
                    if tid != tournament_id:
                        continue

                    home = event.get("homeTeam", {}).get("name", "")
                    away = event.get("awayTeam", {}).get("name", "")
                    if not (home and away):
                        continue

                    # SofaScore timestamps are Unix seconds
                    ts = event.get("startTimestamp")
                    if ts:
                        match_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                    else:
                        match_dt = target.replace(hour=0, minute=0, second=0, microsecond=0)

                    # Skip already finished
                    status_code = event.get("status", {}).get("code", 0)
                    if status_code in (100, 120):  # finished / cancelled
                        continue

                    fixtures.append({
                        "home_team":  home,
                        "away_team":  away,
                        "match_date": match_dt.isoformat(),
                        "league":     league_key.replace("-", " ").title(),
                        "league_key": league_key,
                        "season":     "2025-26",
                        "sport":      "football",
                        "status":     "scheduled",
                        "source":     "sofascore",
                    })

                await asyncio.sleep(0.3)  # gentle rate limiting

        await log(f"✅ SofaScore: {len(fixtures)} fixtures para {league_key}")
        return fixtures

    async def scrape_all_leagues(
        self,
        days_ahead: int = 7,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        """Scrape all configured football leagues at once."""
        all_fixtures: list[dict] = []
        for league_key in FOOTBALL_TOURNAMENTS:
            fixtures = await self.scrape_upcoming_fixtures(
                league_key=league_key,
                days_ahead=days_ahead,
                log_queue=log_queue,
            )
            all_fixtures.extend(fixtures)
        return all_fixtures


class SofaScoreNBAScraper:
    """
    Scrapes upcoming NBA games from SofaScore.
    """

    async def scrape_upcoming_games(
        self,
        days_ahead: int = 10,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log("🏀 SofaScore: buscando partidos NBA próximos...")
        games: list[dict] = []
        today = datetime.now(timezone.utc)

        async with httpx.AsyncClient() as client:
            for day_offset in range(days_ahead):
                target = today + timedelta(days=day_offset)
                date_str = target.strftime("%Y-%m-%d")
                url = f"{SOFA_BASE}/sport/basketball/scheduled-events/{date_str}"
                data = await _fetch_json(client, url)
                if not data:
                    continue

                for event in data.get("events", []):
                    tid = (
                        event.get("tournament", {})
                             .get("uniqueTournament", {})
                             .get("id")
                    )
                    if tid != NBA_UNIQUE_TOURNAMENT_ID:
                        continue

                    home = event.get("homeTeam", {}).get("name", "")
                    away = event.get("awayTeam", {}).get("name", "")
                    if not (home and away):
                        continue

                    ts = event.get("startTimestamp")
                    match_dt = (
                        datetime.fromtimestamp(ts, tz=timezone.utc)
                        if ts else target
                    )

                    status_code = event.get("status", {}).get("code", 0)
                    if status_code in (100, 120):
                        continue

                    games.append({
                        "home_team":  home,
                        "away_team":  away,
                        "match_date": match_dt.isoformat(),
                        "status":     "scheduled",
                        "sport":      "nba",
                        "league":     "NBA",
                        "season":     "2025-26",
                        "source":     "sofascore",
                    })

                await asyncio.sleep(0.3)

        await log(f"✅ SofaScore NBA: {len(games)} partidos encontrados")
        return games


class SofaScoreTennisScraper:
    """
    Scrapes upcoming tennis matches from SofaScore.
    Covers ATP & WTA tour events.
    """

    ATP_CATEGORY_ID = 3  # SofaScore category for ATP
    WTA_CATEGORY_ID = 6  # SofaScore category for WTA

    async def scrape_upcoming_matches(
        self,
        tour: str = "ATP",
        days_ahead: int = 10,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log(f"🎾 SofaScore: buscando partidos {tour} próximos...")
        matches: list[dict] = []
        today = datetime.now(timezone.utc)
        category_id = self.ATP_CATEGORY_ID if tour == "ATP" else self.WTA_CATEGORY_ID

        async with httpx.AsyncClient() as client:
            for day_offset in range(days_ahead):
                target = today + timedelta(days=day_offset)
                date_str = target.strftime("%Y-%m-%d")
                url = f"{SOFA_BASE}/sport/tennis/scheduled-events/{date_str}"
                data = await _fetch_json(client, url)
                if not data:
                    continue

                for event in data.get("events", []):
                    # Filter by ATP/WTA category
                    cat_id = (
                        event.get("tournament", {})
                             .get("category", {})
                             .get("id")
                    )
                    if cat_id != category_id:
                        continue

                    p1 = event.get("homeTeam", {}).get("name", "")
                    p2 = event.get("awayTeam", {}).get("name", "")
                    if not (p1 and p2):
                        continue

                    ts = event.get("startTimestamp")
                    match_dt = (
                        datetime.fromtimestamp(ts, tz=timezone.utc)
                        if ts else target
                    )

                    status_code = event.get("status", {}).get("code", 0)
                    if status_code in (100, 120):
                        continue

                    tournament_name = (
                        event.get("tournament", {}).get("name", "ATP Tour")
                    )
                    round_name = event.get("roundInfo", {}).get("name", "")

                    matches.append({
                        "player1":    p1,
                        "player2":    p2,
                        "match_date": match_dt.isoformat(),
                        "tour":       tour,
                        "tournament": tournament_name,
                        "round":      round_name,
                        "surface":    "hard",  # SofaScore doesn't always provide surface
                        "sport":      "tennis",
                        "status":     "scheduled",
                        "source":     "sofascore",
                    })

                await asyncio.sleep(0.3)

        await log(f"✅ SofaScore {tour}: {len(matches)} partidos encontrados")
        return matches


# ── Stats scrapers ────────────────────────────────────────────────────────────

async def _get_current_season_id(client: httpx.AsyncClient, tournament_id: int) -> Optional[int]:
    """Get the most recent season ID for a SofaScore tournament."""
    data = await _fetch_json(client, f"{SOFA_BASE}/unique-tournament/{tournament_id}/seasons")
    if not data:
        return None
    seasons = data.get("seasons", [])
    if not seasons:
        return None
    # First season is the most recent
    return seasons[0].get("id")


# ── ESPN league key mapping ───────────────────────────────────────────────────
ESPN_FOOTBALL_KEYS = {
    "premier-league":   "eng.1",
    "la-liga":          "esp.1",
    "bundesliga":       "ger.1",
    "serie-a":          "ita.1",
    "ligue-1":          "fra.1",
    "champions-league": "uefa.champions",
    "libertadores":     "conmebol.libertadores",
}

ESPN_BASE_SITE = "https://site.api.espn.com/apis/site/v2/sports"
ESPN_V2_BASE   = "https://site.api.espn.com/apis/v2/sports"


async def _espn_fetch(url: str) -> Optional[dict]:
    """Fetch JSON from ESPN API (no auth, public)."""
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                url,
                headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"},
                timeout=20.0,
                follow_redirects=True,
            )
            if r.is_success:
                return r.json()
    except Exception as e:
        logger.warning(f"ESPN fetch failed {url}: {e}")
    return None


async def get_football_team_stats(
    league_key: str,
    log_queue: Optional[asyncio.Queue] = None,
) -> dict[str, dict]:
    """
    Fetch team season stats from ESPN standings API.
    ESPN is reliable from Railway (same source used for fixtures).
    Returns dict keyed by team name with model-ready stats.
    """
    async def log(msg: str):
        logger.info(msg)
        if log_queue:
            await log_queue.put({"type": "log", "message": msg})

    espn_key = ESPN_FOOTBALL_KEYS.get(league_key)
    if not espn_key:
        await log(f"⚠️ Liga '{league_key}' sin clave ESPN para stats")
        return {}

    await log(f"📊 ESPN: cargando standings/stats de {league_key}...")
    stats: dict[str, dict] = {}

    # ── Try ESPN standings (v2) ───────────────────────────────────────────────
    standings_url = f"{ESPN_V2_BASE}/soccer/{espn_key}/standings"
    data = await _espn_fetch(standings_url)

    if data:
        # ESPN standings response: children[].standings.entries[]
        children = data.get("children", []) or [data]
        for child in children:
            entries = child.get("standings", {}).get("entries", [])
            for entry in entries:
                team_name = entry.get("team", {}).get("displayName", "") or entry.get("team", {}).get("name", "")
                if not team_name:
                    continue
                stats_list = entry.get("stats", [])
                stat_map: dict[str, float] = {}
                for s in stats_list:
                    name_key = s.get("name") or s.get("abbreviation") or ""
                    val      = s.get("value")
                    if name_key and val is not None:
                        try:
                            stat_map[name_key] = float(val)
                        except (TypeError, ValueError):
                            pass

                played    = stat_map.get("gamesPlayed", stat_map.get("GP", 1)) or 1
                wins      = stat_map.get("wins", stat_map.get("W", 0))
                draws     = stat_map.get("ties", stat_map.get("D", stat_map.get("draws", 0)))
                scored    = stat_map.get("pointsFor", stat_map.get("GF", stat_map.get("goalsFor", 0)))
                conceded  = stat_map.get("pointsAgainst", stat_map.get("GA", stat_map.get("goalsAgainst", 0)))

                goals_pg    = round(scored   / played, 3)
                conceded_pg = round(conceded / played, 3)
                win_pct     = round(wins     / played, 3)
                draw_pct    = round(draws    / played, 3)

                stats[team_name] = {
                    "goals_per_game":    goals_pg,
                    "conceded_per_game": conceded_pg,
                    "xg_per_game":       goals_pg,
                    "xga_per_game":      conceded_pg,
                    "win_pct":           win_pct,
                    "draw_pct":          draw_pct,
                    "poss":              50.0,
                    "form_xg":           goals_pg,
                    "form_xga":          conceded_pg,
                    "matches":           int(played),
                }

    if stats:
        await log(f"✅ ESPN standings stats: {len(stats)} equipos para {league_key}")
        return stats

    # ── Fallback: compute stats from recent ESPN scoreboard results ───────────
    await log(f"🔄 ESPN standings vacío — calculando stats de resultados recientes...")
    try:
        from datetime import datetime, timedelta, timezone
        today  = datetime.now(timezone.utc)
        start  = (today - timedelta(days=90)).strftime("%Y%m%d")
        end    = today.strftime("%Y%m%d")
        sb_url = f"{ESPN_BASE_SITE}/soccer/{espn_key}/scoreboard?dates={start}-{end}&limit=200"
        sb_data = await _espn_fetch(sb_url)
        if sb_data:
            team_agg: dict[str, dict] = {}
            for event in sb_data.get("events", []):
                comp = event.get("competitions", [{}])[0]
                if comp.get("status", {}).get("type", {}).get("name", "") not in ("STATUS_FINAL", "STATUS_FULL_TIME"):
                    continue
                for side in comp.get("competitors", []):
                    name = side.get("team", {}).get("displayName") or side.get("team", {}).get("name") or ""
                    if not name:
                        continue
                    gf = int(side.get("score", 0) or 0)
                    other = next((c for c in comp.get("competitors", []) if c != side), {})
                    ga = int(other.get("score", 0) or 0)
                    won  = side.get("winner", False)
                    draw = gf == ga

                    if name not in team_agg:
                        team_agg[name] = {"played": 0, "wins": 0, "draws": 0, "gf": 0, "ga": 0}
                    team_agg[name]["played"] += 1
                    team_agg[name]["gf"]     += gf
                    team_agg[name]["ga"]     += ga
                    if won:    team_agg[name]["wins"]  += 1
                    if draw:   team_agg[name]["draws"] += 1

            for tname, agg in team_agg.items():
                p = agg["played"] or 1
                gfpg = round(agg["gf"] / p, 3)
                gapg = round(agg["ga"] / p, 3)
                stats[tname] = {
                    "goals_per_game":    gfpg,
                    "conceded_per_game": gapg,
                    "xg_per_game":       gfpg,
                    "xga_per_game":      gapg,
                    "win_pct":           round(agg["wins"]  / p, 3),
                    "draw_pct":          round(agg["draws"] / p, 3),
                    "poss":              50.0,
                    "form_xg":           gfpg,
                    "form_xga":          gapg,
                    "matches":           p,
                }
    except Exception as e:
        logger.warning(f"ESPN scoreboard stats failed: {e}")

    await log(f"✅ ESPN computed stats: {len(stats)} equipos para {league_key}")
    return stats


async def get_nba_team_stats(
    log_queue: Optional[asyncio.Queue] = None,
) -> dict[str, dict]:
    """
    Fetch NBA team stats from ESPN standings API.
    """
    async def log(msg: str):
        logger.info(msg)
        if log_queue:
            await log_queue.put({"type": "log", "message": msg})

    await log("📊 ESPN: cargando standings NBA...")
    stats: dict[str, dict] = {}

    standings_url = f"{ESPN_V2_BASE}/basketball/nba/standings"
    data = await _espn_fetch(standings_url)

    if data:
        children = data.get("children", []) or [data]
        for child in children:
            entries = child.get("standings", {}).get("entries", [])
            for entry in entries:
                team_name = (entry.get("team", {}).get("displayName") or
                             entry.get("team", {}).get("name") or "")
                if not team_name:
                    continue
                stat_map: dict[str, float] = {}
                for s in entry.get("stats", []):
                    k = s.get("name") or s.get("abbreviation") or ""
                    v = s.get("value")
                    if k and v is not None:
                        try: stat_map[k] = float(v)
                        except: pass

                played = stat_map.get("gamesPlayed", stat_map.get("GP", 1)) or 1
                wins   = stat_map.get("wins", stat_map.get("W", 0))
                pts    = stat_map.get("ppg", stat_map.get("pointsPerGame", stat_map.get("avgPoints", 110.0)))
                opp    = stat_map.get("oppg", stat_map.get("oppPointsPerGame", stat_map.get("avgPointsAgainst", 110.0)))
                win_pct = round(wins / played, 3)

                stats[team_name] = {
                    "pts_per_game":       float(pts or 110.0),
                    "opp_pts_per_game":   float(opp or 110.0),
                    "fg_pct":             stat_map.get("fieldGoalPct", stat_map.get("fgPct", 0.46)),
                    "three_p_pct":        stat_map.get("threePointPct", stat_map.get("fg3Pct", 0.36)),
                    "reb_per_game":       stat_map.get("reboundsPerGame", stat_map.get("avgRebounds", 44.0)),
                    "ast_per_game":       stat_map.get("assistsPerGame", stat_map.get("avgAssists", 24.0)),
                    "last5_wins_pct":     win_pct,
                    "home_wins_pct":      min(win_pct * 1.1, 0.95),
                    "days_rest":          2.0,
                    "is_back_to_back":    0.0,
                    "win_pct":            win_pct,
                }

    if not stats:
        # Fallback: compute from recent scoreboard
        await log("🔄 ESPN standings NBA vacío — calculando de scoreboard...")
        from datetime import datetime, timedelta, timezone
        today = datetime.now(timezone.utc)
        start = (today - timedelta(days=60)).strftime("%Y%m%d")
        end   = today.strftime("%Y%m%d")
        sb_data = await _espn_fetch(f"{ESPN_BASE_SITE}/basketball/nba/scoreboard?dates={start}-{end}&limit=200")
        if sb_data:
            agg: dict[str, dict] = {}
            for event in sb_data.get("events", []):
                comp = event.get("competitions", [{}])[0]
                if "FINAL" not in (comp.get("status", {}).get("type", {}).get("name") or ""):
                    continue
                for side in comp.get("competitors", []):
                    name = side.get("team", {}).get("displayName") or ""
                    if not name: continue
                    pts = int(side.get("score", 0) or 0)
                    other = next((c for c in comp.get("competitors", []) if c != side), {})
                    opp_pts = int(other.get("score", 0) or 0)
                    if name not in agg:
                        agg[name] = {"played": 0, "wins": 0, "pts": 0, "opp": 0}
                    agg[name]["played"] += 1
                    agg[name]["pts"]    += pts
                    agg[name]["opp"]    += opp_pts
                    if side.get("winner"): agg[name]["wins"] += 1
            for tname, a in agg.items():
                p = a["played"] or 1
                w = round(a["wins"] / p, 3)
                stats[tname] = {
                    "pts_per_game":     round(a["pts"] / p, 1),
                    "opp_pts_per_game": round(a["opp"] / p, 1),
                    "fg_pct": 0.46, "three_p_pct": 0.36, "reb_per_game": 44.0,
                    "ast_per_game": 24.0, "last5_wins_pct": w, "home_wins_pct": min(w*1.1, 0.95),
                    "days_rest": 2.0, "is_back_to_back": 0.0, "win_pct": w,
                }

    await log(f"✅ ESPN NBA stats: {len(stats)} equipos")
    return stats


# ATP/WTA category IDs in SofaScore
_ATP_CAT = 3
_WTA_CAT = 6

async def get_tennis_player_ratings(
    tour: str = "ATP",
    log_queue: Optional[asyncio.Queue] = None,
) -> dict[str, dict]:
    """
    Fetch player ratings/rankings from SofaScore.
    Returns dict keyed by player name with elo/ranking data.
    """
    async def log(msg: str):
        logger.info(msg)
        if log_queue:
            await log_queue.put({"type": "log", "message": msg})

    await log(f"🎾 SofaScore: cargando rankings {tour}...")
    ratings: dict[str, dict] = {}

    # SofaScore rankings endpoint
    # tour_type: 'atp' or 'wta'
    tour_slug = "atp" if tour == "ATP" else "wta"
    url = f"{SOFA_BASE}/rankings/{tour_slug}"

    async with httpx.AsyncClient() as client:
        data = await _fetch_json(client, url)
        if not data:
            await log(f"⚠️ No se pudo obtener rankings {tour} de SofaScore")
            return {}

        rows = data.get("rankings", [])
        for row in rows:
            player = row.get("player") or row.get("team", {})
            name = player.get("name", "")
            if not name:
                continue
            ranking = row.get("ranking", 999)
            points  = row.get("points", 0)
            # Normalise to approximate Elo: top player ≈ 2400, rank 100 ≈ 1800
            elo_approx = max(1800, 2450 - ranking * 6)
            ratings[name] = {
                "ranking": ranking,
                "points": points,
                "elo": elo_approx,
                "win_rate": max(0.30, min(0.85, 0.80 - ranking * 0.003)),
            }

    await log(f"✅ SofaScore {tour} rankings: {len(ratings)} jugadores")
    return ratings


# ── Entry points ──────────────────────────────────────────────────────────────

async def run_sofascore_football(
    league_key: str,
    log_queue: asyncio.Queue,
) -> list[dict]:
    scraper = SofaScoreFootballScraper()
    return await scraper.scrape_upcoming_fixtures(
        league_key=league_key, days_ahead=10, log_queue=log_queue
    )


async def run_sofascore_nba(log_queue: asyncio.Queue) -> list[dict]:
    scraper = SofaScoreNBAScraper()
    return await scraper.scrape_upcoming_games(days_ahead=10, log_queue=log_queue)


async def run_sofascore_tennis(
    tour: str,
    log_queue: asyncio.Queue,
) -> list[dict]:
    scraper = SofaScoreTennisScraper()
    return await scraper.scrape_upcoming_matches(tour=tour, days_ahead=10, log_queue=log_queue)
