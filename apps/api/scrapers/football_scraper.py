"""
BetIQ — Football Scraper
Fuentes: fbref.com (stats) + betplay.com.co / rushbet.co (odds via Playwright)
Ligas: Premier League, La Liga, Bundesliga, Serie A, Ligue 1,
       Champions League, Libertadores, Copa Sudamericana, Mundial 2026
"""
import asyncio
import logging
import random
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from constants import (
    FOOTBALL_LEAGUES, REQUEST_DELAY_MIN, REQUEST_DELAY_MAX, MAX_RETRIES, HEADERS
)

logger = logging.getLogger(__name__)
FBREF_BASE  = "https://fbref.com"
ESPN_BASE   = "https://site.api.espn.com/apis/site/v2/sports/soccer"

# fbref league key → ESPN soccer league key
FBREF_TO_ESPN: dict[str, str] = {
    "premier-league":     "eng.1",
    "la-liga":            "esp.1",
    "bundesliga":         "ger.1",
    "serie-a":            "ita.1",
    "ligue-1":            "fra.1",
    "champions-league":   "uefa.champions",
    "libertadores":       "conmebol.libertadores",
    "copa-sudamericana":  "conmebol.sudamericana",
}


async def _random_delay():
    await asyncio.sleep(random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX))


async def _fetch_html(client: httpx.AsyncClient, url: str) -> Optional[str]:
    for attempt in range(MAX_RETRIES):
        try:
            await _random_delay()
            r = await client.get(url, headers=HEADERS, timeout=30.0)
            if r.status_code == 429:
                wait = 2 ** attempt * 8
                logger.warning(f"Rate limited {url}. Waiting {wait}s...")
                await asyncio.sleep(wait)
                continue
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.text
        except Exception as e:
            logger.error(f"Attempt {attempt+1}/{MAX_RETRIES} failed {url}: {e}")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(2 ** attempt * 2)
    return None


async def _espn_football_fixtures(
    league_key: str,
    league_name: str,
    log_queue: Optional[asyncio.Queue] = None,
) -> list[dict]:
    """Fallback: get upcoming fixtures from ESPN public API (no auth needed)."""
    async def log(msg: str):
        logger.info(msg)
        if log_queue:
            await log_queue.put({"type": "log", "message": msg})

    espn_key = FBREF_TO_ESPN.get(league_key)
    if not espn_key:
        return []

    # Use a 10-day date range so we catch upcoming fixtures even on non-game days
    today_dt = datetime.now(timezone.utc)
    end_dt   = today_dt + timedelta(days=10)
    date_range = f"{today_dt.strftime('%Y%m%d')}-{end_dt.strftime('%Y%m%d')}"
    url = f"{ESPN_BASE}/{espn_key}/scoreboard?dates={date_range}"
    await log(f"🔄 Usando ESPN como fuente alternativa para {league_name}...")

    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(url, headers={"Accept": "application/json"}, timeout=20.0)
            if not r.is_success:
                return []
            data = r.json()
    except Exception as e:
        logger.warning(f"ESPN fallback failed for {league_key}: {e}")
        return []

    today = datetime.now(timezone.utc)
    limit = today + timedelta(days=10)
    fixtures = []

    for event in data.get("events", []):
        comp = event.get("competitions", [{}])[0]
        competitors = comp.get("competitors", [])
        home = next((c for c in competitors if c.get("homeAway") == "home"), None)
        away = next((c for c in competitors if c.get("homeAway") == "away"), None)
        if not (home and away):
            continue

        home_name = home.get("team", {}).get("displayName") or home.get("team", {}).get("name", "")
        away_name = away.get("team", {}).get("displayName") or away.get("team", {}).get("name", "")
        date_str  = event.get("date", "")
        status_name = comp.get("status", {}).get("type", {}).get("name", "")

        if not (home_name and away_name and date_str):
            continue

        try:
            match_dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        except ValueError:
            continue

        # Only upcoming
        if match_dt < today or match_dt > limit:
            continue
        if "FINAL" in status_name or "POST" in status_name:
            continue

        fixtures.append({
            "home_team":  home_name,
            "away_team":  away_name,
            "match_date": match_dt.isoformat(),
            "league":     league_name,
            "league_key": league_key,
            "season":     "2025-26",
            "sport":      "football",
            "status":     "scheduled",
            "source":     "espn",
        })

    await log(f"✅ ESPN: {len(fixtures)} fixtures encontrados para {league_name}")
    return fixtures


class FbrefFootballScraper:
    """
    Scrapes football stats from fbref.com.
    Covers: match schedule + team season stats (per 90, xG, xGA, possession...).
    """

    async def scrape_upcoming_fixtures(
        self,
        league_key: str = "premier-league",
        days_ahead: int = 10,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        """
        Scrape upcoming fixtures for a league within N days.
        Returns: [{home_team, away_team, match_date, league, season, source_url}]
        """
        league_cfg = FOOTBALL_LEAGUES.get(league_key)
        if not league_cfg:
            return []

        season_year = f"{datetime.now().year}"
        # fbref fixture URL pattern, e.g. /en/comps/9/schedule/Premier-League-Scores-and-Fixtures
        league_name_slug = league_cfg["name"].replace(" ", "-")
        url = f"{FBREF_BASE}/en/comps/{league_cfg['fbref_id']}/schedule/{league_name_slug}-Scores-and-Fixtures"

        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log(f"⚽ fbref: cargando fixtures de {league_cfg['name']}...")
        fixtures = []
        today = datetime.now(timezone.utc)
        limit = today + timedelta(days=days_ahead)

        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                await log(f"⚠️ No se pudo conectar con fbref para {league_cfg['name']}")
                # Try ESPN first, then SofaScore as second fallback
                espn_fixtures = await _espn_football_fixtures(league_key, league_cfg["name"], log_queue)
                if espn_fixtures:
                    return espn_fixtures
                await log(f"🔄 ESPN vacío — usando SofaScore para {league_cfg['name']}...")
                from scrapers.sofascore_scraper import run_sofascore_football
                return await run_sofascore_football(league_key, log_queue)

        soup = BeautifulSoup(html, "lxml")
        table = soup.find("table", {"id": lambda x: x and "sched_" in x})
        if not table:
            await log(f"⚠️ Tabla de partidos no encontrada en {url}")
            return fixtures

        for row in table.select("tbody tr"):
            if row.get("class") in (["spacer"], ["partial_table"], ["thead"]):
                continue
            date_cell  = row.find("td", {"data-stat": "date"})
            home_cell  = row.find("td", {"data-stat": "home_team"})
            away_cell  = row.find("td", {"data-stat": "away_team"})
            score_cell = row.find("td", {"data-stat": "score"})

            if not (date_cell and home_cell and away_cell):
                continue

            # Skip already played matches
            if score_cell and score_cell.get_text(strip=True):
                continue

            date_str = date_cell.get_text(strip=True)
            try:
                match_dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                continue

            if match_dt < today or match_dt > limit:
                continue

            home_link = home_cell.find("a")
            away_link = away_cell.find("a")
            home_name = home_link.get_text(strip=True) if home_link else home_cell.get_text(strip=True)
            away_name = away_link.get_text(strip=True) if away_link else away_cell.get_text(strip=True)
            home_href = home_link.get("href", "") if home_link else ""
            away_href = away_link.get("href", "") if away_link else ""

            fixtures.append({
                "home_team":  home_name,
                "away_team":  away_name,
                "match_date": match_dt.isoformat(),
                "league":     league_cfg["name"],
                "league_key": league_key,
                "season":     "2025-26",
                "sport":      "football",
                "status":     "scheduled",
                "home_fbref_href": home_href,
                "away_fbref_href": away_href,
                "source_url": url,
            })

        await log(f"✅ {league_cfg['name']}: {len(fixtures)} partidos próximos encontrados")
        return fixtures

    async def scrape_team_stats(
        self,
        league_key: str = "premier-league",
        log_queue: Optional[asyncio.Queue] = None,
    ) -> dict[str, dict]:
        """
        Scrape team-level season stats from fbref.
        Returns: {team_name: {xg, xga, goals, conceded, possession, ...}}
        """
        league_cfg = FOOTBALL_LEAGUES.get(league_key)
        if not league_cfg:
            return {}

        league_name_slug = league_cfg["name"].replace(" ", "-")
        url = f"{FBREF_BASE}/en/comps/{league_cfg['fbref_id']}/{league_name_slug}-Stats"

        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log(f"📊 fbref: scrapeando stats de {league_cfg['name']}...")
        stats: dict[str, dict] = {}

        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                await log("⚠️ No se pudo obtener stats de liga")
                return stats

        soup = BeautifulSoup(html, "lxml")

        def get_table(table_id: str):
            return soup.find("table", {"id": table_id})

        def cell_val(row, stat: str) -> float:
            c = row.find("td", {"data-stat": stat})
            try:
                return float(c.get_text(strip=True)) if c else 0.0
            except ValueError:
                return 0.0

        # Squad Standard Stats
        std_table = get_table("stats_squads_standard_for") or get_table("stats_squads_standard_upon")
        if std_table:
            for row in std_table.select("tbody tr"):
                if row.find("th", {"data-stat": "team"}):
                    name_tag = row.find("td", {"data-stat": "team"}) or row.find("th", {"data-stat": "team"})
                    if not name_tag:
                        continue
                    team_link = name_tag.find("a")
                    name = team_link.get_text(strip=True) if team_link else name_tag.get_text(strip=True)
                    if not name:
                        continue
                    stats[name] = {
                        "goals_for":   cell_val(row, "goals"),
                        "assists":     cell_val(row, "assists"),
                        "xg":          cell_val(row, "xg"),
                        "npxg":        cell_val(row, "npxg"),
                        "xg_assist":   cell_val(row, "xg_assist"),
                        "poss":        cell_val(row, "possession"),
                        "matches":     cell_val(row, "games"),
                    }

        # Defensive stats (goals conceded, xGA)
        def_table = get_table("stats_squads_keeper_for") or get_table("stats_squads_standard_against")
        if def_table:
            for row in def_table.select("tbody tr"):
                name_tag = row.find("td", {"data-stat": "team"}) or row.find("th", {"data-stat": "team"})
                if not name_tag:
                    continue
                team_link = name_tag.find("a")
                name = team_link.get_text(strip=True) if team_link else name_tag.get_text(strip=True)
                if name in stats:
                    stats[name]["goals_against"] = cell_val(row, "goals_against") or cell_val(row, "gk_goals_against")
                    stats[name]["xga"]           = cell_val(row, "xga") or cell_val(row, "gk_psxg_net")
                    stats[name]["clean_sheets"]  = cell_val(row, "gk_clean_sheets")

        # Compute per-game if matches > 0
        for name, s in stats.items():
            m = s.get("matches") or 1
            stats[name]["goals_per_game"]     = round(s.get("goals_for", 0) / m, 3)
            stats[name]["conceded_per_game"]  = round(s.get("goals_against", 0) / m, 3)
            stats[name]["xg_per_game"]        = round(s.get("xg", 0) / m, 3)
            stats[name]["xga_per_game"]       = round(s.get("xga", 0) / m, 3)

        await log(f"✅ Stats de {len(stats)} equipos obtenidas ({league_cfg['name']})")
        return stats

    async def scrape_recent_form(
        self,
        team_href: str,
        last_n: int = 10,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> dict:
        """
        Scrape last N match results + xG for a team.
        team_href: fbref team path, e.g. '/en/squads/822bd0ba/Arsenal-Stats'
        """
        url = f"{FBREF_BASE}{team_href}"
        async def log(msg): logger.info(msg)

        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                return {}

        soup = BeautifulSoup(html, "lxml")
        table = soup.find("table", {"id": lambda x: x and "matchlogs" in (x or "")})
        if not table:
            return {}

        form_data = {"wins": 0, "draws": 0, "losses": 0, "last_n_xg": 0.0, "last_n_xga": 0.0}
        finished = []

        for row in table.select("tbody tr"):
            res_cell = row.find("td", {"data-stat": "result"})
            if not res_cell or res_cell.get_text(strip=True) not in ("W", "D", "L"):
                continue
            finished.append(row)

        recent = finished[-last_n:]
        for row in recent:
            def cv(s):
                c = row.find("td", {"data-stat": s})
                try: return float(c.get_text(strip=True)) if c else 0.0
                except: return 0.0

            res = row.find("td", {"data-stat": "result"}).get_text(strip=True)
            if res == "W": form_data["wins"]   += 1
            elif res == "D": form_data["draws"] += 1
            else: form_data["losses"] += 1
            form_data["last_n_xg"]  += cv("xg")
            form_data["last_n_xga"] += cv("xga")

        n = len(recent) or 1
        form_data["win_pct"]  = round(form_data["wins"] / n, 3)
        form_data["draw_pct"] = round(form_data["draws"] / n, 3)
        form_data["form_xg_per_game"]  = round(form_data["last_n_xg"] / n, 3)
        form_data["form_xga_per_game"] = round(form_data["last_n_xga"] / n, 3)
        return form_data


class BetplayFootballScraper:
    """Scrapes football odds from betplay.com.co via Playwright."""

    BETPLAY_URL = "https://betplay.com.co/apuestas#sports/sr:sport:1/categories"
    RUSHBET_SOCCER_URL = "https://rushbet.co/deportes/#/sports/Soccer"

    async def scrape_football_odds(
        self, source: str = "betplay", log_queue: Optional[asyncio.Queue] = None
    ) -> list[dict]:
        odds_list = []

        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        url = self.BETPLAY_URL if source == "betplay" else self.RUSHBET_SOCCER_URL
        await log(f"🎰 {source.capitalize()}: iniciando scraping de cuotas de fútbol...")

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
                await log(f"🌐 Navegando a {url}...")
                await page.goto(url, wait_until="networkidle", timeout=35000)
                await asyncio.sleep(4)

                # Accept cookies
                try:
                    for selector in ["button:has-text('Aceptar')", "button:has-text('Accept')", "#onetrust-accept-btn-handler"]:
                        btn = page.locator(selector)
                        if await btn.count() > 0:
                            await btn.first.click()
                            await asyncio.sleep(1)
                            break
                except Exception:
                    pass

                # Scroll
                for _ in range(4):
                    await page.evaluate("window.scrollBy(0, 600)")
                    await asyncio.sleep(0.8)

                await log("🔍 Extrayendo cuotas de eventos de fútbol...")

                # Extract match blocks
                blocks = await page.query_selector_all("[class*='event'], [class*='match'], [class*='market']")
                await log(f"📋 Bloques encontrados: {len(blocks)}")

                for block in blocks[:30]:
                    try:
                        text = await block.inner_text()
                        lines = [l.strip() for l in text.split("\n") if l.strip()]
                        teams, odds_vals = [], []
                        for line in lines:
                            try:
                                val = float(line.replace(",", "."))
                                if 1.01 <= val <= 30:
                                    odds_vals.append(val)
                            except ValueError:
                                if 4 <= len(line) <= 40 and not line.replace(".", "").replace(",", "").isdigit():
                                    teams.append(line)

                        if len(teams) >= 2 and len(odds_vals) >= 2:
                            odds_list.append({
                                "home_team":    teams[0],
                                "away_team":    teams[1],
                                "home_win_odd": odds_vals[0],
                                "draw_odd":     odds_vals[1] if len(odds_vals) > 1 else None,
                                "away_win_odd": odds_vals[2] if len(odds_vals) > 2 else odds_vals[1],
                                "bookmaker":    source,
                                "sport":        "football",
                                "scraped_at":   datetime.now(timezone.utc).isoformat(),
                            })
                    except Exception as e:
                        logger.debug(f"Error parsing block: {e}")

                await browser.close()

        except Exception as e:
            await log(f"⚠️ Error en scraper de {source}: {e}. Continuando sin cuotas en vivo.")
            return []

        await log(f"✅ Cuotas obtenidas: {len(odds_list)} partidos de fútbol ({source})")
        return odds_list


# ---- Entry points -----------------------------------------------------------

async def run_football_stats_scrape(
    league_key: str,
    log_queue: asyncio.Queue,
) -> dict:
    scraper = FbrefFootballScraper()
    fixtures = await scraper.scrape_upcoming_fixtures(league_key=league_key, log_queue=log_queue)
    stats    = await scraper.scrape_team_stats(league_key=league_key, log_queue=log_queue)
    return {"fixtures": fixtures, "team_stats": stats, "league": league_key}


async def run_football_odds_scrape(
    source: str,
    log_queue: asyncio.Queue,
) -> dict:
    scraper = BetplayFootballScraper()
    odds = await scraper.scrape_football_odds(source=source, log_queue=log_queue)
    return {"odds": odds, "source": source, "count": len(odds)}
