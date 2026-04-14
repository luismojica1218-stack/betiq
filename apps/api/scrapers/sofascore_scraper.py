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


async def get_football_team_stats(
    league_key: str,
    log_queue: Optional[asyncio.Queue] = None,
) -> dict[str, dict]:
    """
    Fetch team season stats from SofaScore standings.
    Returns dict keyed by team name with model-ready stats.
    Replaces fbref (blocked on Railway).
    """
    async def log(msg: str):
        logger.info(msg)
        if log_queue:
            await log_queue.put({"type": "log", "message": msg})

    tournament_id = FOOTBALL_TOURNAMENTS.get(league_key)
    if not tournament_id:
        await log(f"⚠️ Liga '{league_key}' sin ID en SofaScore")
        return {}

    await log(f"📊 SofaScore: cargando stats de {league_key}...")
    stats: dict[str, dict] = {}

    async with httpx.AsyncClient() as client:
        season_id = await _get_current_season_id(client, tournament_id)
        if not season_id:
            await log(f"⚠️ No se pudo obtener season ID para {league_key}")
            return {}

        # Fetch standings
        url = f"{SOFA_BASE}/unique-tournament/{tournament_id}/season/{season_id}/standings/total"
        data = await _fetch_json(client, url)
        if not data:
            await log(f"⚠️ SofaScore standings vacío para {league_key}")
            return {}

        rows = []
        for standings_group in data.get("standings", []):
            rows.extend(standings_group.get("rows", []))

        team_ids: dict[int, str] = {}  # id → name
        for row in rows:
            team = row.get("team", {})
            team_id = team.get("id")
            team_name = team.get("name", "")
            if not (team_id and team_name):
                continue

            played    = row.get("matches", 1) or 1
            wins      = row.get("wins", 0)
            draws     = row.get("draws", 0)
            losses    = row.get("losses", 0)
            scored    = row.get("scoresFor", 0)
            conceded  = row.get("scoresAgainst", 0)

            goals_pg    = round(scored / played, 3)
            conceded_pg = round(conceded / played, 3)
            win_pct     = round(wins / played, 3)
            draw_pct    = round(draws / played, 3)

            stats[team_name] = {
                "goals_per_game":    goals_pg,
                "conceded_per_game": conceded_pg,
                "xg_per_game":       goals_pg,     # proxy (SofaScore public API doesn't expose xG)
                "xga_per_game":      conceded_pg,  # proxy
                "win_pct":           win_pct,
                "draw_pct":          draw_pct,
                "poss":              50.0,  # default (not in public standings)
                "form_xg":           goals_pg,
                "form_xga":          conceded_pg,
                "matches":           played,
                "_team_id":          team_id,
            }
            team_ids[team_id] = team_name

        # Enrich with recent form (last 5 matches) for top teams
        for team_id, team_name in list(team_ids.items())[:20]:  # limit API calls
            form_url = f"{SOFA_BASE}/team/{team_id}/events/last/0"
            form_data = await _fetch_json(client, form_url)
            if not form_data:
                continue

            events = form_data.get("events", [])
            # Filter finished matches for this team
            finished = [
                e for e in events
                if e.get("status", {}).get("code") in (100, 120)
            ][-5:]  # last 5

            if not finished:
                continue

            form_goals, form_conceded = 0, 0
            for e in finished:
                is_home = e.get("homeTeam", {}).get("id") == team_id
                hs = e.get("homeScore", {}).get("current", 0) or 0
                as_ = e.get("awayScore", {}).get("current", 0) or 0
                if is_home:
                    form_goals    += hs
                    form_conceded += as_
                else:
                    form_goals    += as_
                    form_conceded += hs

            n = len(finished) or 1
            stats[team_name]["form_xg"]  = round(form_goals / n, 3)
            stats[team_name]["form_xga"] = round(form_conceded / n, 3)
            await asyncio.sleep(0.2)

    await log(f"✅ SofaScore stats: {len(stats)} equipos para {league_key}")
    return stats


async def get_nba_team_stats(
    log_queue: Optional[asyncio.Queue] = None,
) -> dict[str, dict]:
    """
    Fetch NBA team stats from SofaScore standings.
    Returns dict keyed by team name with model-ready stats.
    """
    async def log(msg: str):
        logger.info(msg)
        if log_queue:
            await log_queue.put({"type": "log", "message": msg})

    await log("📊 SofaScore: cargando stats NBA...")
    stats: dict[str, dict] = {}

    async with httpx.AsyncClient() as client:
        season_id = await _get_current_season_id(client, NBA_UNIQUE_TOURNAMENT_ID)
        if not season_id:
            await log("⚠️ No se pudo obtener season NBA de SofaScore")
            return {}

        url = f"{SOFA_BASE}/unique-tournament/{NBA_UNIQUE_TOURNAMENT_ID}/season/{season_id}/standings/total"
        data = await _fetch_json(client, url)
        if not data:
            await log("⚠️ SofaScore NBA standings vacío")
            return {}

        rows = []
        for grp in data.get("standings", []):
            rows.extend(grp.get("rows", []))

        for row in rows:
            team = row.get("team", {})
            name = team.get("name", "")
            if not name:
                continue

            played = row.get("matches", 1) or 1
            wins   = row.get("wins", 0)
            losses = row.get("losses", 0)
            # SofaScore standings for NBA: scoresFor = total points scored
            pts_for     = row.get("scoresFor", 0)
            pts_against = row.get("scoresAgainst", 0)

            pts_pg     = round(pts_for / played, 1)     if pts_for     else 110.0
            opp_pts_pg = round(pts_against / played, 1) if pts_against else 110.0
            win_pct    = round(wins / played, 3)

            stats[name] = {
                "pts_per_game":       pts_pg,
                "opp_pts_per_game":   opp_pts_pg,
                "fg_pct":             0.46,   # not in public standings, use league avg
                "three_p_pct":        0.36,
                "reb_per_game":       44.0,
                "ast_per_game":       24.0,
                "last5_wins_pct":     win_pct,
                "home_wins_pct":      min(win_pct * 1.1, 0.95),
                "days_rest":          2.0,
                "is_back_to_back":    0.0,
                "win_pct":            win_pct,
            }

    await log(f"✅ SofaScore NBA stats: {len(stats)} equipos")
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
