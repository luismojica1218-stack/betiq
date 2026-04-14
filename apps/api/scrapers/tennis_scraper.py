"""
BetIQ — Tennis Scraper
Fuentes:
  - ultimatetennisstatistics.com (UTS): Rankings, H2H, stats por superficie
  - atptour.com / wtatennis.com: Schedules, player profiles
  - rushbet.co / betplay.com.co: Live odds via Playwright
"""
import asyncio
import logging
import re
import random
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from constants import HEADERS, REQUEST_DELAY_MIN, REQUEST_DELAY_MAX, MAX_RETRIES, TENNIS_TOURNAMENTS

logger = logging.getLogger(__name__)
UTS_BASE  = "https://www.ultimatetennisstatistics.com"
ATP_BASE  = "https://www.atptour.com"
WTA_BASE  = "https://www.wtatennis.com"


async def _random_delay():
    await asyncio.sleep(random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX))


async def _fetch_html(client: httpx.AsyncClient, url: str) -> Optional[str]:
    for attempt in range(MAX_RETRIES):
        try:
            await _random_delay()
            r = await client.get(url, headers=HEADERS, timeout=30.0, follow_redirects=True)
            if r.status_code == 429:
                wait = 2 ** attempt * 8
                logger.warning(f"Rate limited. Waiting {wait}s...")
                await asyncio.sleep(wait)
                continue
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.text
        except Exception as e:
            logger.warning(f"Attempt {attempt+1}/{MAX_RETRIES} failed: {e}")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(2 ** attempt * 2)
    return None


# ── UTS Scraper ───────────────────────────────────────────────────────────────

class UTSTennisScraper:
    """
    Scrapes UltimateTennisStatistics.com for:
    - Current ATP/WTA rankings (top 100)
    - H2H records between players
    - Surface win rates (hard, clay, grass, indoor)
    - Recent match form (last 20 matches)
    """

    async def scrape_rankings(
        self,
        tour: str = "ATP",  # ATP | WTA
        top_n: int = 100,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        async def log(msg: str):
            logger.info(msg)
            if log_queue: await log_queue.put({"type": "log", "message": msg})

        await log(f"🎾 UTS: cargando ranking {tour} Top {top_n}...")
        url = f"{UTS_BASE}/rankingsTable?current=1&rankType={'ELO' if tour=='ATP' else 'WTA_ELO'}&surface=H"

        players = []
        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                await log(f"⚠️ No se pudo conectar con UTS para ranking {tour}")
                return players

        soup = BeautifulSoup(html, "lxml")
        table = soup.find("table", {"id": lambda x: x and "rankings" in (x or "")}) or soup.find("table")
        if not table:
            await log("⚠️ Tabla de rankings no encontrada")
            return players

        for row in table.select("tbody tr")[:top_n]:
            cols = row.find_all(["td", "th"])
            if len(cols) < 4:
                continue
            try:
                rank_text = cols[0].get_text(strip=True).replace(".", "")
                rank = int(rank_text) if rank_text.isdigit() else len(players) + 1
                name_tag = row.find("a") or cols[1]
                name     = name_tag.get_text(strip=True) if name_tag else cols[1].get_text(strip=True)
                country  = cols[2].get_text(strip=True) if len(cols) > 2 else "?"
                elo_text = cols[3].get_text(strip=True) if len(cols) > 3 else "1500"
                elo_text = re.sub(r"[^0-9.]", "", elo_text)
                elo      = float(elo_text) if elo_text else 1500.0
                href     = name_tag.get("href", "") if hasattr(name_tag, "get") else ""
                players.append({
                    "rank": rank, "name": name, "country": country,
                    "elo": elo, "tour": tour, "profile_href": href,
                    "surface": "hard",
                })
            except (ValueError, IndexError):
                continue

        await log(f"✅ {tour} rankings: {len(players)} jugadores cargados")
        return players

    async def scrape_player_surface_stats(
        self,
        player_href: str,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> dict:
        """Scrape win rates by surface for a player."""
        async def log(msg: str): logger.info(msg)
        url = f"{UTS_BASE}{player_href}" if not player_href.startswith("http") else player_href

        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                return {}

        soup = BeautifulSoup(html, "lxml")
        stats: dict = {}

        # UTS player profile: surface win% table
        for row in soup.select("tr"):
            cells = row.find_all("td")
            if len(cells) < 3:
                continue
            surface = cells[0].get_text(strip=True).lower()
            if surface not in ("hard", "clay", "grass", "indoor", "carpet"):
                continue
            try:
                wins_text   = re.sub(r"[^0-9]", "", cells[1].get_text(strip=True))
                losses_text = re.sub(r"[^0-9]", "", cells[2].get_text(strip=True))
                wins   = int(wins_text)   if wins_text   else 0
                losses = int(losses_text) if losses_text else 0
                total  = wins + losses
                stats[surface] = {
                    "wins":    wins,
                    "losses":  losses,
                    "total":   total,
                    "win_pct": round(wins / total, 3) if total > 0 else 0.5,
                }
            except (ValueError, IndexError):
                continue
        return stats

    async def scrape_h2h(
        self,
        player1: str,
        player2: str,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> dict:
        """Scrape head-to-head record between two players from UTS."""
        encoded1 = player1.replace(" ", "+")
        encoded2 = player2.replace(" ", "+")
        url = f"{UTS_BASE}/h2h?players={encoded1}&players={encoded2}"

        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                return {"p1_wins": 0, "p2_wins": 0, "h2h_pct": 0.5}

        soup = BeautifulSoup(html, "lxml")
        h2h: dict = {"p1_wins": 0, "p2_wins": 0, "h2h_pct": 0.5}
        win_elements = soup.select("[class*='wins'], [class*='h2h']")
        numbers = [int(re.sub(r"[^0-9]", "", el.get_text()))
                   for el in win_elements if re.sub(r"[^0-9]", "", el.get_text())]
        if len(numbers) >= 2:
            h2h["p1_wins"] = numbers[0]
            h2h["p2_wins"] = numbers[1]
            total = numbers[0] + numbers[1]
            h2h["h2h_pct"] = round(numbers[0] / total, 3) if total > 0 else 0.5
        return h2h

    async def scrape_upcoming_matches(
        self,
        tour: str = "ATP",
        days_ahead: int = 10,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        """Scrape ATP/WTA upcoming tournament schedule."""
        async def log(msg: str):
            logger.info(msg)
            if log_queue: await log_queue.put({"type": "log", "message": msg})

        await log(f"📅 ATP Tour: buscando partidos próximos ({days_ahead} días)...")
        base  = ATP_BASE if tour == "ATP" else WTA_BASE
        url   = f"{base}/en/scores/current" if tour == "ATP" else f"{base}/scores/live"

        matches = []
        async with httpx.AsyncClient() as client:
            html = await _fetch_html(client, url)
            if not html:
                await log(f"⚠️ No se pudo acceder a {base} — usando datos de ejemplo")
                matches = self._demo_upcoming_matches(days_ahead)
                await log(f"✅ {len(matches)} partidos de demostración generados")
                return matches

        soup    = BeautifulSoup(html, "lxml")
        today   = datetime.now(timezone.utc)
        limit   = today + timedelta(days=days_ahead)

        for block in soup.select("[class*='match'], [class*='fixture'], [class*='event']")[:30]:
            players = block.select("[class*='player'], [class*='name']")
            if len(players) < 2:
                continue
            p1 = players[0].get_text(strip=True)
            p2 = players[1].get_text(strip=True)
            if not (p1 and p2 and p1 != p2):
                continue
            matches.append({
                "player1": p1, "player2": p2,
                "tour": tour, "sport": "tennis",
                "surface": "hard", "round": "QF",
                "tournament": "ATP Tour",
                "match_date": (today + timedelta(days=random.randint(0, days_ahead))).isoformat(),
                "status": "scheduled",
            })

        if not matches:
            # Try SofaScore before falling back to demo data
            await log(f"🔄 ATP Tour sin datos — probando SofaScore {tour}...")
            try:
                from scrapers.sofascore_scraper import run_sofascore_tennis
                sofa_matches = await run_sofascore_tennis(tour, log_queue)
                if sofa_matches:
                    # Map SofaScore format to expected format
                    matches = [{
                        "player1":    m["player1"],
                        "player2":    m["player2"],
                        "match_date": m["match_date"],
                        "tour":       m.get("tour", tour),
                        "tournament": m.get("tournament", "ATP Tour"),
                        "round":      m.get("round", ""),
                        "surface":    m.get("surface", "hard"),
                        "sport":      "tennis",
                        "status":     "scheduled",
                    } for m in sofa_matches]
                    await log(f"✅ SofaScore: {len(matches)} partidos de tenis")
                else:
                    matches = self._demo_upcoming_matches(days_ahead)
                    await log("ℹ️ Usando fixtures de demostración (HTML sin estructura esperada)")
            except Exception as e:
                logger.warning(f"SofaScore tennis fallback failed: {e}")
                matches = self._demo_upcoming_matches(days_ahead)
                await log("ℹ️ Usando fixtures de demostración (HTML sin estructura esperada)")

        await log(f"✅ {len(matches)} partidos de tenis encontrados")
        return matches

    def _demo_upcoming_matches(self, days_ahead: int) -> list[dict]:
        """Realistic demo matches when scraper can't reach site."""
        today = datetime.now(timezone.utc)
        demo = [
            ("Novak Djokovic",    "Carlos Alcaraz",    "hard",  "ATP",  "Australian Open",   1),
            ("Jannik Sinner",     "Alexander Zverev",  "clay",  "ATP",  "Roland Garros",     2),
            ("Carlos Alcaraz",    "Frances Tiafoe",    "grass", "ATP",  "Wimbledon",         3),
            ("Iga Swiatek",       "Coco Gauff",        "clay",  "WTA",  "Roland Garros",     1),
            ("Aryna Sabalenka",   "Elena Rybakina",    "hard",  "WTA",  "Australian Open",   2),
            ("Taylor Fritz",      "Ben Shelton",       "hard",  "ATP",  "US Open",           4),
            ("Holger Rune",       "Stefanos Tsitsipas","clay",  "ATP",  "Monte Carlo",       2),
            ("Daniil Medvedev",   "Grigor Dimitrov",   "hard",  "ATP",  "Miami Open",        3),
        ]
        matches = []
        for i, (p1, p2, surface, tour, tournament, day_offset) in enumerate(demo):
            matches.append({
                "id": f"tennis-demo-{i+1}",
                "player1": p1, "player2": p2,
                "surface": surface, "tour": tour,
                "tournament": tournament,
                "round": random.choice(["R32", "R16", "QF", "SF", "F"]),
                "match_date": (today + timedelta(days=day_offset)).isoformat(),
                "sport": "tennis", "status": "scheduled",
            })
        return matches


# ── Odds Scraper ──────────────────────────────────────────────────────────────

class RushbetTennisScraper:
    """Scrapes tennis odds from rushbet.co via Playwright."""

    RUSHBET_TENNIS_URL = "https://rushbet.co/deportes/#/sports/Tennis"
    BETPLAY_TENNIS_URL = "https://betplay.com.co/apuestas#sports/sr:sport:5/categories"

    async def scrape_tennis_odds(
        self,
        source: str = "rushbet",
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        async def log(msg: str):
            logger.info(msg)
            if log_queue: await log_queue.put({"type": "log", "message": msg})

        url = self.RUSHBET_TENNIS_URL if source == "rushbet" else self.BETPLAY_TENNIS_URL
        await log(f"🎾 {source.capitalize()}: scrapeando cuotas de tenis...")
        odds_list = []

        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
                )
                ctx  = await browser.new_context(user_agent=HEADERS["User-Agent"], locale="es-CO")
                page = await ctx.new_page()
                await page.goto(url, wait_until="networkidle", timeout=35000)
                await asyncio.sleep(4)

                try:
                    for sel in ["button:has-text('Aceptar')", "#onetrust-accept-btn-handler"]:
                        btn = page.locator(sel)
                        if await btn.count() > 0:
                            await btn.first.click()
                            await asyncio.sleep(1)
                            break
                except Exception:
                    pass

                for _ in range(3):
                    await page.evaluate("window.scrollBy(0, 600)")
                    await asyncio.sleep(0.7)

                await log("🔍 Extrayendo bloques de partidos de tenis...")
                blocks = await page.query_selector_all("[class*='event'], [class*='match']")
                await log(f"📋 Bloques: {len(blocks)}")

                for block in blocks[:25]:
                    try:
                        text  = await block.inner_text()
                        lines = [l.strip() for l in text.split("\n") if l.strip()]
                        players, odds_vals = [], []
                        for line in lines:
                            try:
                                val = float(line.replace(",", "."))
                                if 1.01 <= val <= 20:
                                    odds_vals.append(val)
                            except ValueError:
                                if 5 <= len(line) <= 35 and "." not in line:
                                    players.append(line)

                        if len(players) >= 2 and len(odds_vals) >= 2:
                            odds_list.append({
                                "player1":      players[0],
                                "player2":      players[1],
                                "p1_odd":       odds_vals[0],
                                "p2_odd":       odds_vals[1],
                                "ou_games_odd": odds_vals[2] if len(odds_vals) > 2 else None,
                                "bookmaker":    source,
                                "sport":        "tennis",
                                "scraped_at":   datetime.now(timezone.utc).isoformat(),
                            })
                    except Exception as e:
                        logger.debug(f"Block parse error: {e}")

                await browser.close()

        except Exception as e:
            await log(f"⚠️ Error Playwright ({source}): {e}")
            return []

        await log(f"✅ Cuotas de tenis: {len(odds_list)} partidos ({source})")
        return odds_list


# ── Entry points ──────────────────────────────────────────────────────────────

async def run_tennis_stats_scrape(
    tour: str,
    log_queue: asyncio.Queue,
) -> dict:
    scraper  = UTSTennisScraper()
    rankings = await scraper.scrape_rankings(tour=tour, top_n=100, log_queue=log_queue)
    matches  = await scraper.scrape_upcoming_matches(tour=tour, log_queue=log_queue)
    return {"rankings": rankings, "matches": matches, "tour": tour}


async def run_tennis_odds_scrape(
    source: str,
    log_queue: asyncio.Queue,
) -> dict:
    scraper = RushbetTennisScraper()
    odds    = await scraper.scrape_tennis_odds(source=source, log_queue=log_queue)
    return {"odds": odds, "source": source, "count": len(odds)}
