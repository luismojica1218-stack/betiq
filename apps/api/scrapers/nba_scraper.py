"""
BetIQ — NBA Scraper
Fuentes: basketball-reference.com (stats) + ESPN API/DraftKings (odds)
"""
import asyncio
import logging
import random
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from bs4 import BeautifulSoup

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

        # ── ESPN first (basketball-reference blocked on Railway) ──────────────
        try:
            from scrapers.sofascore_scraper import get_nba_team_stats
            espn_stats = await get_nba_team_stats(log_queue=log_queue)
            if espn_stats:
                return espn_stats
        except Exception as e:
            logger.warning(f"ESPN NBA stats failed: {e}")

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


class NabaRushbetOddsScraper:
    """
    Scrapes NBA odds from the Naba (Kambi) public offer API — the same source
    Rushbet uses. Returns real decimal moneyline, handicap and totals odds.
    This is the PRIMARY source; ESPN/DraftKings is the fallback.
    """

    NABA_HEADERS = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Origin": "https://www.rushbet.co",
        "Referer": "https://www.rushbet.co/",
    }

    # Kambi brand for Rushbet Colombia
    KAMBI_BRAND = "ub"
    KAMBI_BASE  = "https://eu-offering-api.kambicdn.com/offering/v2018"

    def _normalize_team(self, raw: str) -> str:
        """Kambi returns full team names — pass through directly."""
        return raw.strip()

    async def scrape_nba_odds(
        self, log_queue: Optional[asyncio.Queue] = None
    ) -> list[dict]:
        """
        Fetch NBA odds from Naba/Rushbet (Kambi) public API.
        Returns list of dicts with real Rushbet decimal moneyline odds.
        Falls back to ESPN/DraftKings if Naba is unreachable.
        """
        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log("📡 NBA Odds: intentando Naba/Rushbet (Kambi API)...")
        odds_list = await self._try_naba(log)

        if odds_list:
            await log(f"✅ Naba/Rushbet: {len(odds_list)} partidos NBA con cuotas reales")
            return odds_list

        await log("⚠️ Naba no disponible — usando ESPN/DraftKings como fallback...")
        espn_scraper = ESPNNBAOddsScraper()
        return await espn_scraper.scrape_nba_odds(log_queue=log_queue)

    async def _try_naba(self, log) -> list[dict]:
        """Call the Kambi offer API (brand=ub) to get real Rushbet NBA moneylines."""
        url = (
            f"{self.KAMBI_BASE}/{self.KAMBI_BRAND}/listView/basketball/nba.json"
            "?lang=en_GB&market=CO&client_id=2&channel_id=1&ncid=1"
        )

        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                r = await client.get(url, headers=self.NABA_HEADERS)
                if not r.is_success:
                    logger.warning(f"Kambi Rushbet API {r.status_code} — {r.text[:100]}")
                    return []
                data = r.json()
                return self._parse_kambi_response(data)
        except Exception as e:
            logger.warning(f"Naba/Kambi connection error: {e}")
            return []

    def _parse_kambi_response(self, data: dict) -> list[dict]:
        """
        Parse Kambi listView API response.
        Structure: {events: [{event: {name, start, ...}, betOffers: [{betOfferType, outcomes: [{label, odds}]}]}]}
        Odds are in milliodds: 1240 → 1.240 decimal.
        """
        results: list[dict] = []
        today_utc = datetime.now(timezone.utc)

        for ev in data.get("events", []):
            try:
                event = ev.get("event", ev)  # Kambi wraps in {event: {...}}
                name  = event.get("name", "")

                start_str = event.get("start") or event.get("startTime") or ""
                try:
                    match_dt = datetime.fromisoformat(start_str.replace("Z", "+00:00"))
                    if match_dt < today_utc:
                        continue
                except Exception:
                    continue

                # Kambi uses "Home Team - Away Team" with " - " separator
                if " - " in name:
                    parts = name.split(" - ", 1)
                    home_name = self._normalize_team(parts[0])
                    away_name = self._normalize_team(parts[1])
                else:
                    continue

                # Find moneyline bet offer
                bet_offers = ev.get("betOffers", [])
                ml_home, ml_away = None, None

                for offer in bet_offers:
                    crit_label = offer.get("criterion", {}).get("label", "").lower()
                    offer_name = offer.get("betOfferType", {}).get("name", "").lower()

                    # Match offer: type="Match" with Moneyline criterion
                    is_ml = (
                        "moneyline" in crit_label
                        or ("match" in offer_name and "1x2" not in crit_label)
                    )
                    if not is_ml:
                        continue

                    outcomes = offer.get("outcomes", [])
                    if len(outcomes) >= 2:
                        # Outcomes are ordered: [home, away] by Kambi convention
                        # label contains the full team name
                        for outcome in outcomes:
                            label    = outcome.get("label", "")
                            odds_val = outcome.get("odds")  # milliodds: 1240 → 1.240
                            if odds_val is None:
                                continue
                            decimal_odd = round(int(odds_val) / 1000, 3)

                            if home_name.lower() in label.lower() or label.lower() in home_name.lower():
                                ml_home = decimal_odd
                            elif away_name.lower() in label.lower() or label.lower() in away_name.lower():
                                ml_away = decimal_odd

                        # Fallback: first=home, second=away (Kambi standard)
                        if ml_home is None and ml_away is None and len(outcomes) >= 2:
                            ml_home = round(int(outcomes[0]["odds"]) / 1000, 3)
                            ml_away = round(int(outcomes[1]["odds"]) / 1000, 3)

                    if ml_home and ml_away:
                        break

                if ml_home and ml_away:
                    results.append({
                        "home_team":  home_name,
                        "away_team":  away_name,
                        "ml_home":    ml_home,
                        "ml_away":    ml_away,
                        "spread":     None,
                        "ou_total":   None,
                        "ou_over":    None,
                        "ou_under":   None,
                        "bookmaker":  "rushbet",
                        "market":     "moneyline",
                        "sport":      "nba",
                        "match_date": match_dt.isoformat(),
                    })

            except Exception as e:
                logger.debug(f"Error parsing Kambi event: {e}")

        return results


class ESPNNBAOddsScraper:
    """
    Scrapes NBA odds from the public ESPN API (DraftKings spreads + OU).
    Used as FALLBACK when Naba/Rushbet (Kambi) is unavailable.
    ESPN returns: spread, over/under, and we convert American-line spread to decimal odds.
    """

    ESPN_NBA_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"

    @staticmethod
    def _american_to_decimal(american: int) -> float:
        """Convert American moneyline to decimal odds."""
        if american >= 0:
            return round(american / 100 + 1, 3)
        else:
            return round(100 / abs(american) + 1, 3)

    @staticmethod
    def _spread_to_decimal(spread: float) -> tuple[float, float]:
        """Estimate home/away decimal odds from point spread (rough approximation)."""
        base = 1.909
        adjustment = abs(spread) * 0.005
        if spread < 0:
            return round(base - adjustment, 3), round(base + adjustment, 3)
        else:
            return round(base + adjustment, 3), round(base - adjustment, 3)

    async def scrape_nba_odds(
        self, log_queue: Optional[asyncio.Queue] = None
    ) -> list[dict]:
        """
        Fetch NBA odds from ESPN (DraftKings) public API.
        Returns: [{home_team, away_team, ml_home, ml_away, spread, ou_total, bookmaker, match_date}]
        """
        odds_list = []

        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log("📡 ESPN NBA Odds (fallback): consultando API pública de ESPN (DraftKings)...")

        today = datetime.now(timezone.utc)
        end   = today + timedelta(days=7)
        date_range = f"{today.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}"
        url = f"{self.ESPN_NBA_URL}?dates={date_range}"

        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(
                    url,
                    headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"},
                    timeout=20.0,
                )
                if not r.is_success:
                    await log(f"⚠️ ESPN devolvió status {r.status_code}")
                    return []
                data = r.json()
        except Exception as e:
            await log(f"⚠️ Error conectando ESPN: {e}")
            return []

        events = data.get("events", [])
        await log(f"📋 Encontrados {len(events)} eventos ESPN NBA")

        for event in events:
            try:
                comp = event.get("competitions", [{}])[0]
                status_type = comp.get("status", {}).get("type", {}).get("name", "")

                if "FINAL" in status_type or "IN_PROGRESS" in status_type:
                    continue

                competitors = comp.get("competitors", [])
                home = next((c for c in competitors if c.get("homeAway") == "home"), None)
                away = next((c for c in competitors if c.get("homeAway") == "away"), None)
                if not (home and away):
                    continue

                home_name = home.get("team", {}).get("displayName", "")
                away_name = away.get("team", {}).get("displayName", "")
                date_str  = event.get("date", "")

                if not (home_name and away_name):
                    continue

                espn_odds = comp.get("odds", [])
                spread_val, ou_total = None, None
                ml_home, ml_away    = None, None

                if espn_odds:
                    o = espn_odds[0]
                    details    = o.get("details", "")
                    ou_total   = o.get("overUnder")
                    ml_home_am = o.get("homeTeamOdds", {}).get("moneyLine")
                    ml_away_am = o.get("awayTeamOdds", {}).get("moneyLine")

                    if details:
                        parts = details.split()
                        if len(parts) >= 2:
                            try:
                                raw_spread  = float(parts[-1])
                                spread_abbr = " ".join(parts[:-1]).upper()
                                home_abbr   = home.get("team", {}).get("abbreviation", "").upper()
                                spread_val  = raw_spread if spread_abbr == home_abbr else -raw_spread
                            except ValueError:
                                pass

                    if ml_home_am is not None:
                        try:
                            ml_home = self._american_to_decimal(int(ml_home_am))
                        except (ValueError, TypeError):
                            pass
                    if ml_away_am is not None:
                        try:
                            ml_away = self._american_to_decimal(int(ml_away_am))
                        except (ValueError, TypeError):
                            pass

                if ml_home is None or ml_away is None:
                    if spread_val is not None:
                        ml_home, ml_away = self._spread_to_decimal(spread_val)
                    else:
                        ml_home, ml_away = 1.909, 1.909

                record = {
                    "home_team":  home_name,
                    "away_team":  away_name,
                    "ml_home":    ml_home,
                    "ml_away":    ml_away,
                    "spread":     spread_val,
                    "ou_total":   float(ou_total) if ou_total is not None else None,
                    "ou_over":    float(ou_total) if ou_total is not None else None,
                    "ou_under":   float(ou_total) if ou_total is not None else None,
                    "bookmaker":  "draftkings_via_espn",
                    "market":     "moneyline",
                    "sport":      "nba",
                    "match_date": date_str,
                }
                odds_list.append(record)

            except Exception as e:
                logger.debug(f"Error parsing ESPN event: {e}")

        await log(f"✅ Cuotas obtenidas: {len(odds_list)} partidos NBA (ESPN/DraftKings fallback)")
        return odds_list


# Keep old class name as alias so nothing else breaks
RushbetNBAScraper = NabaRushbetOddsScraper


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
    """Entry point called by the FastAPI router.
    Tries Naba/Rushbet (Kambi) first, falls back to ESPN/DraftKings.
    """
    scraper = NabaRushbetOddsScraper()
    odds = await scraper.scrape_nba_odds(log_queue=log_queue)
    return {"odds": odds, "count": len(odds)}
