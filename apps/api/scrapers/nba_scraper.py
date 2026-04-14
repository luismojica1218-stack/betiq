"""
BetIQ — NBA Scraper
Fuentes: basketball-reference.com (stats) + rushbet.co (odds via Playwright)
"""
import asyncio
import logging
import random
import time
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator, Optional

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from constants import REQUEST_DELAY_MIN, REQUEST_DELAY_MAX, MAX_RETRIES, HEADERS

logger = logging.getLogger(__name__)
BBALL_REF_BASE = "https://www.basketball-reference.com"


async def _random_delay():
    await asyncio.sleep(random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX))


async def _fetch_html(client: httpx.AsyncClient, url: str) -> Optional[str]:
    """Fetch HTML with retry logic and exponential backoff."""
    for attempt in range(MAX_RETRIES):
        try:
            await _random_delay()
            response = await client.get(url, headers=HEADERS, timeout=30.0)
            if response.status_code == 429:
                wait = 2 ** attempt * 5
                logger.warning(f"Rate limited on {url}, waiting {wait}s...")
                await asyncio.sleep(wait)
                continue
            response.raise_for_status()
            return response.text
        except Exception as e:
            logger.error(f"Attempt {attempt + 1}/{MAX_RETRIES} failed for {url}: {e}")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(2 ** attempt)
    return None


class NBAStatsScraper:
    """Scrapes NBA stats and schedules from basketball-reference.com"""

    def __init__(self):
        self.base_url = BBALL_REF_BASE

    async def scrape_upcoming_games(
        self, days_ahead: int = 7, log_queue: Optional[asyncio.Queue] = None
    ) -> list[dict]:
        """
        Scrape upcoming NBA games within the next N days.
        Returns list of: {home_team, away_team, date, time, league}
        """
        games = []
        today = datetime.now(timezone.utc)

        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log("🏀 NBA Scraper: iniciando búsqueda de partidos próximos...")

        # ── Primary source: ESPN NBA API (no auth, reliable from Railway) ────────
        games = await self._scrape_espn(days_ahead, log)

        # ── Fallback: basketball-reference monthly calendar ───────────────────────
        if not games:
            games = await self._scrape_schedule_page(log)

        await log(f"✅ Encontrados {len(games)} partidos próximos de NBA")
        return games

    async def _scrape_espn(self, days_ahead: int, log) -> list[dict]:
        """Primary source: ESPN NBA scoreboard API with date range. Free, no auth, works from Railway."""
        games = []
        today = datetime.now(timezone.utc)
        end   = today + timedelta(days=days_ahead)
        date_range = f"{today.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}"
        url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={date_range}"

        await log(f"📅 ESPN NBA: buscando partidos del {today.strftime('%Y-%m-%d')} al {end.strftime('%Y-%m-%d')}...")

        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(url, headers={"Accept": "application/json"}, timeout=20.0)
                if not r.is_success:
                    await log(f"⚠️ ESPN NBA devolvió status {r.status_code}")
                    return games
                data = r.json()
        except Exception as e:
            await log(f"⚠️ ESPN NBA error: {e}")
            return games

        # ESPN team abbreviation → full name map for common NBA teams
        ESPN_TEAMS: dict[str, str] = {
            "BOS": "Boston Celtics", "LAL": "Los Angeles Lakers", "GSW": "Golden State Warriors",
            "MIA": "Miami Heat", "PHX": "Phoenix Suns", "MIL": "Milwaukee Bucks",
            "DEN": "Denver Nuggets", "PHI": "Philadelphia 76ers", "BKN": "Brooklyn Nets",
            "CHI": "Chicago Bulls", "DFW": "Dallas Mavericks", "DAL": "Dallas Mavericks",
            "MEM": "Memphis Grizzlies", "MIN": "Minnesota Timberwolves", "NOP": "New Orleans Pelicans",
            "SAC": "Sacramento Kings", "CLE": "Cleveland Cavaliers", "ATL": "Atlanta Hawks",
            "TOR": "Toronto Raptors", "NYK": "New York Knicks", "IND": "Indiana Pacers",
            "OKC": "Oklahoma City Thunder", "POR": "Portland Trail Blazers", "UTA": "Utah Jazz",
            "SAS": "San Antonio Spurs", "WAS": "Washington Wizards", "ORL": "Orlando Magic",
            "CHA": "Charlotte Hornets", "HOU": "Houston Rockets", "DET": "Detroit Pistons",
        }

        for event in data.get("events", []):
            comp = event.get("competitions", [{}])[0]
            competitors = comp.get("competitors", [])
            home = next((c for c in competitors if c.get("homeAway") == "home"), None)
            away = next((c for c in competitors if c.get("homeAway") == "away"), None)
            if not (home and away):
                continue

            home_abbr = home.get("team", {}).get("abbreviation", "")
            away_abbr = away.get("team", {}).get("abbreviation", "")
            home_name = home.get("team", {}).get("displayName") or ESPN_TEAMS.get(home_abbr, home_abbr)
            away_name = away.get("team", {}).get("displayName") or ESPN_TEAMS.get(away_abbr, away_abbr)
            date_str  = event.get("date", "")
            status_type = comp.get("status", {}).get("type", {}).get("name", "")

            if "FINAL" in status_type or "POST" in status_type:
                continue
            if not (home_name and away_name and date_str):
                continue

            try:
                match_dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            except ValueError:
                continue

            games.append({
                "home_team":  home_name,
                "away_team":  away_name,
                "match_date": match_dt.isoformat(),
                "status":     "scheduled",
                "sport":      "nba",
                "league":     "NBA",
                "season":     "2025-26",
                "source":     "espn",
            })

        await log(f"✅ ESPN NBA: {len(games)} partidos encontrados")
        return games

    async def _scrape_schedule_page(self, log) -> list[dict]:
        """Fallback: scrape the monthly schedule page."""
        games = []
        today = datetime.now(timezone.utc)
        month_name = today.strftime("%B").lower()
        year = today.year
        url = f"{self.base_url}/leagues/NBA_{year}_games-{month_name}.html"

        await log(f"📋 Cargando calendario mensual: {url}")

        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                return games

        soup = BeautifulSoup(html, "lxml")
        table = soup.find("table", {"id": "schedule"})
        if not table:
            return games

        tbody = table.find("tbody")
        if not tbody:
            return games

        today_str = today.strftime("%Y-%m-%d")
        limit_str  = (today + timedelta(days=7)).strftime("%Y-%m-%d")

        for row in tbody.find_all("tr"):
            if row.get("class") == ["thead"]:
                continue
            date_cell = row.find("td", {"data-stat": "date_game"})
            if not date_cell:
                date_cell = row.find("th", {"data-stat": "date_game"})
            home_cell = row.find("td", {"data-stat": "home_team_name"})
            away_cell = row.find("td", {"data-stat": "visitor_team_name"})
            if not (date_cell and home_cell and away_cell):
                continue

            date_link = date_cell.find("a")
            game_date_str = date_link.get("href", "").replace(
                "/leagues/NBA_2026_games-", ""
            ).replace(".html", "") if date_link else ""

            raw_date = date_cell.get_text(strip=True)
            try:
                parsed_date = datetime.strptime(raw_date, "%a, %b %d, %Y")
                game_date_str = parsed_date.strftime("%Y-%m-%d")
            except Exception:
                continue

            if game_date_str < today_str or game_date_str > limit_str:
                continue

            home_team = home_cell.get_text(strip=True)
            away_team = away_cell.get_text(strip=True)

            game_link = date_cell.find("a")
            box_href  = game_link.get("href", "") if game_link else ""

            games.append({
                "match_date": f"{game_date_str}T00:00:00+00:00",
                "home_team":  home_team,
                "away_team":  away_team,
                "status":     "scheduled",
                "sport":      "nba",
                "league":     "NBA",
                "season":     "2025-26",
                "source_url": f"{self.base_url}{box_href}" if box_href else url,
            })

        return games

    async def scrape_team_season_stats(
        self, season: str = "2025-26", log_queue: Optional[asyncio.Queue] = None
    ) -> dict[str, dict]:
        """
        Scrape team-level season stats from basketball-reference.
        Returns: {team_name: {pts_per_game, opp_pts, fg_pct, ...}}
        """
        year = season.split("-")[0]
        next_year = str(int(year) + 1)
        url = f"{self.base_url}/leagues/NBA_{next_year}.html"

        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log(f"📊 Scrapeando estadísticas de temporada NBA {season}...")
        stats = {}

        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                await log("⚠️ No se pudo obtener stats de temporada")
                return stats

        soup = BeautifulSoup(html, "lxml")

        # Per-game stats table
        table_pg = soup.find("table", {"id": "per_game-team"})
        if not table_pg:
            table_pg = soup.find("table", {"id": "team-stats-per_game"})

        if table_pg:
            for row in table_pg.select("tbody tr"):
                if row.get("class") == ["thead"]:
                    continue
                team_cell = row.find("td", {"data-stat": "team_name"})
                if not team_cell:
                    continue
                name = team_cell.get_text(strip=True).replace("*", "")

                def cell_val(stat: str) -> float:
                    c = row.find("td", {"data-stat": stat})
                    try:
                        return float(c.get_text(strip=True)) if c else 0.0
                    except ValueError:
                        return 0.0

                stats[name] = {
                    "pts_per_game":     cell_val("pts"),
                    "opp_pts_per_game": cell_val("opp_pts") if row.find("td", {"data-stat": "opp_pts"}) else 0.0,
                    "fg_pct":           cell_val("fg_pct"),
                    "three_p_pct":      cell_val("fg3_pct"),
                    "ft_pct":           cell_val("ft_pct"),
                    "reb_per_game":     cell_val("trb"),
                    "ast_per_game":     cell_val("ast"),
                    "stl_per_game":     cell_val("stl"),
                    "blk_per_game":     cell_val("blk"),
                    "tov_per_game":     cell_val("tov"),
                }

        await log(f"✅ Stats obtenidas para {len(stats)} equipos NBA")
        return stats

    async def scrape_recent_form(
        self,
        team_abbr: str,
        last_n: int = 10,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        """
        Scrape last N game results for a team.
        Returns: [{result, pts, opp_pts, is_home, days_rest, is_back_to_back}]
        """
        year = datetime.now().year
        url = f"{self.base_url}/teams/{team_abbr}/2026_games.html"

        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log(f"🔄 Obteniendo forma reciente de {team_abbr} (últimos {last_n} partidos)...")
        form = []

        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                return form

        soup = BeautifulSoup(html, "lxml")
        table = soup.find("table", {"id": "games"})
        if not table:
            return form

        rows = table.select("tbody tr")
        finished_rows = [
            r for r in rows
            if r.find("td", {"data-stat": "game_result"})
            and r.find("td", {"data-stat": "game_result"}).get_text(strip=True) in ("W", "L")
        ]
        recent = finished_rows[-last_n:]
        prev_date = None

        for row in recent:
            def cell(stat: str) -> str:
                c = row.find("td", {"data-stat": stat})
                return c.get_text(strip=True) if c else ""

            date_str = cell("date_game")
            try:
                game_date = datetime.strptime(date_str, "%Y-%m-%d")
            except Exception:
                game_date = None

            days_rest = None
            is_back_to_back = False
            if game_date and prev_date:
                days_rest = (game_date - prev_date).days
                is_back_to_back = days_rest == 1
            prev_date = game_date

            loc = cell("game_location")
            is_home = loc != "@"

            try:
                pts = int(cell("pts"))
                opp_pts = int(cell("opp_pts"))
            except ValueError:
                pts, opp_pts = 0, 0

            form.append({
                "date":            date_str,
                "result":          cell("game_result"),
                "pts":             pts,
                "opp_pts":         opp_pts,
                "is_home":         is_home,
                "days_rest":       days_rest,
                "is_back_to_back": is_back_to_back,
            })

        return form

    async def scrape_head_to_head(
        self,
        home_abbr: str,
        away_abbr: str,
        last_n: int = 10,
    ) -> dict:
        """H2H win percentages between two teams over recent seasons."""
        # Simple h2h: look at last N encounters
        home_wins = 0
        total = 0
        # NOTE: Full H2H requires iterating game logs cross-referencing — 
        # returning mock structure; will be populated via bootstrap_training
        return {
            "home_abbr":       home_abbr,
            "away_abbr":       away_abbr,
            "h2h_home_win_pct": 0.5,
            "games_found":     0,
        }


class RushbetNBAScraper:
    """Scrapes NBA odds from rushbet.co using Playwright."""

    RUSHBET_NBA_URL = "https://rushbet.co/deportes/#/sports/Basketball/USA/NBA"

    async def scrape_nba_odds(
        self, log_queue: Optional[asyncio.Queue] = None
    ) -> list[dict]:
        """
        Navigate Rushbet and extract NBA odds.
        Returns: [{home_team, away_team, ml_home, ml_away, ou_total, ou_over, ou_under, spread}]
        """
        odds_list = []

        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log("🎰 Rushbet NBA: iniciando Playwright...")

        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
                )
                context = await browser.new_context(
                    user_agent=HEADERS["User-Agent"],
                    locale="es-CO",
                    timezone_id="America/Bogota",
                )
                page = await context.new_page()

                await log(f"🌐 Navegando a {self.RUSHBET_NBA_URL}...")
                await page.goto(self.RUSHBET_NBA_URL, wait_until="networkidle", timeout=30000)
                await asyncio.sleep(3)

                # Accept cookies if present
                try:
                    accept_btn = page.locator("button:has-text('Aceptar'), button:has-text('Accept')")
                    if await accept_btn.count() > 0:
                        await accept_btn.first.click()
                        await asyncio.sleep(1)
                except Exception:
                    pass

                # Scroll to load more events
                for _ in range(3):
                    await page.evaluate("window.scrollBy(0, 500)")
                    await asyncio.sleep(1)

                await log("🔍 Extrayendo cuotas de partidos NBA...")

                # Extract match blocks
                match_blocks = await page.query_selector_all("[class*='event'], [class*='match'], [class*='game']")
                await log(f"📋 Encontrados {len(match_blocks)} bloques de partidos")

                for block in match_blocks[:20]:  # Limit to first 20
                    try:
                        text = await block.inner_text()
                        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]

                        # Parse team names and odds from text
                        teams = []
                        odds_vals = []
                        for line in lines:
                            try:
                                val = float(line.replace(",", "."))
                                if 1.01 <= val <= 50.0:
                                    odds_vals.append(val)
                            except ValueError:
                                if len(line) > 3 and not any(c.isdigit() for c in line[:3]):
                                    teams.append(line)

                        if len(teams) >= 2 and len(odds_vals) >= 2:
                            odds_list.append({
                                "home_team": teams[0],
                                "away_team": teams[1],
                                "ml_home":   odds_vals[0] if len(odds_vals) > 0 else None,
                                "ml_away":   odds_vals[1] if len(odds_vals) > 1 else None,
                                "ou_total":  220.5,
                                "bookmaker": "rushbet",
                                "market":    "moneyline",
                                "sport":     "nba",
                            })
                    except Exception as e:
                        logger.debug(f"Error parsing match block: {e}")

                await browser.close()

        except Exception as e:
            await log(f"⚠️ Error en Rushbet scraper: {e}. El usuario puede ingresar cuotas manualmente.")
            # Return empty but don't crash
            return []

        await log(f"✅ Cuotas obtenidas: {len(odds_list)} partidos NBA")
        return odds_list


# -------------------- Module-level convenience functions --------------------

async def run_nba_stats_scrape(log_queue: asyncio.Queue) -> dict:
    """Entry point called by the FastAPI router. Uses SofaScore as primary source."""
    from scrapers.sofascore_scraper import SofaScoreNBAScraper, get_nba_team_stats

    async def log(msg: str):
        logger.info(msg)
        await log_queue.put({"type": "log", "message": msg})

    # Games: SofaScore → ESPN → basketball-reference
    sofa = SofaScoreNBAScraper()
    games = await sofa.scrape_upcoming_games(days_ahead=10, log_queue=log_queue)

    if not games:
        await log("🔄 SofaScore vacío — usando ESPN para NBA...")
        scraper = NBAStatsScraper()
        games = await scraper.scrape_upcoming_games(days_ahead=7, log_queue=log_queue)

    # Stats: SofaScore primary (basketball-reference blocked on Railway)
    stats = await get_nba_team_stats(log_queue=log_queue)

    if not stats:
        await log("🔄 SofaScore stats vacío — intentando basketball-reference...")
        scraper = NBAStatsScraper()
        stats = await scraper.scrape_team_season_stats(log_queue=log_queue)

    return {"games": games, "team_stats": stats, "count": len(games)}


async def run_nba_odds_scrape(log_queue: asyncio.Queue) -> dict:
    """Entry point called by the FastAPI router."""
    scraper = RushbetNBAScraper()
    odds = await scraper.scrape_nba_odds(log_queue=log_queue)
    return {"odds": odds, "count": len(odds)}
