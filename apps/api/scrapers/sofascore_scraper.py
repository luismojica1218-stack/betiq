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
