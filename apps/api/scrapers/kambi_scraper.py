"""
BetIQ — Kambi / Rushbet Universal Odds Scraper
================================================
Rushbet Colombia uses Kambi as its odds provider (brand = "ub").
The public Kambi listView API returns real decimal odds (milliodds ÷ 1000)
for all sports: basketball, football (soccer), and tennis.

This module replaces the old Playwright-based scrapers that fail due to
Kambi's anti-headless detection. It provides a single, reliable source of
truth for Rushbet odds across all sports.

API base: https://eu-offering-api.kambicdn.com/offering/v2018/ub/
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional, Tuple

import httpx

logger = logging.getLogger(__name__)


KAMBI_BASE    = "https://eu-offering-api.kambicdn.com/offering/v2018/ub"
KAMBI_HEADERS = {
    "Accept":     "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Origin":   "https://www.rushbet.co",
    "Referer":  "https://www.rushbet.co/",
}

# Kambi sport path segments
SPORT_PATHS = {
    "nba":      "basketball/nba",
    "football": "football",          # all football/soccer
    "tennis":   "tennis",
}

# Football league name fragments → canonical league name used in DB
FOOTBALL_LEAGUE_MAP: dict[str, str] = {
    "premier league":    "Premier League",
    "premier":           "Premier League",
    "la liga":           "La Liga",
    "primera division":  "La Liga",
    "bundesliga":        "Bundesliga",
    "serie a":           "Serie A",
    "ligue 1":           "Ligue 1",
    "champions league":  "UEFA Champions League",
    "champions":         "UEFA Champions League",
    "libertadores":      "Copa Libertadores",
    "sudamericana":      "Copa Sudamericana",
}


def _milliodds_to_decimal(milliodds: int) -> float:
    """Convert Kambi milliodds to decimal odds. E.g. 1240 → 1.240"""
    return round(int(milliodds) / 1000, 3)


def _parse_team_names(event_name: str) -> Optional[Tuple[str, str]]:
    """
    Kambi formats event names as 'Home Team - Away Team'.
    Returns (home, away) or None if unparseable.
    """
    if " - " in event_name:
        parts = event_name.split(" - ", 1)
        return parts[0].strip(), parts[1].strip()
    return None


class KambiRushbetScraper:
    """
    Universal Rushbet/Kambi odds scraper.
    Fetches real moneyline/match odds for NBA, football, and tennis.

    Usage:
        scraper = KambiRushbetScraper()
        nba_odds      = await scraper.scrape_odds("nba")
        football_odds = await scraper.scrape_odds("football")
        tennis_odds   = await scraper.scrape_odds("tennis")
    """

    async def scrape_odds(
        self,
        sport: str,
        log_queue: Optional[asyncio.Queue] = None,
    ) -> list[dict]:
        """
        Fetch current odds for the given sport from Kambi/Rushbet.
        Returns a list of dicts with keys:
            home_team / player1, away_team / player2,
            ml_home, ml_away (decimal), bookmaker, sport, match_date, league (if football)
        Falls back to ESPN (NBA only) if Kambi is unreachable.
        """
        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        sport_path = SPORT_PATHS.get(sport)
        if not sport_path:
            await log(f"⚠️ Deporte no soportado: {sport}")
            return []

        url = f"{KAMBI_BASE}/listView/{sport_path}.json?lang=en_GB&market=CO&client_id=2&channel_id=1&ncid=1"
        await log(f"📡 Kambi/Rushbet [{sport.upper()}]: consultando API...")

        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                r = await client.get(url, headers=KAMBI_HEADERS)
                if not r.is_success:
                    await log(f"⚠️ Kambi devolvió {r.status_code} para {sport} — {r.text[:80]}")
                    return await self._fallback(sport, log)
                data = r.json()
        except Exception as e:
            await log(f"⚠️ Kambi no disponible para {sport}: {e}")
            return await self._fallback(sport, log)

        if sport == "nba":
            results = self._parse_nba(data)
        elif sport == "football":
            results = self._parse_football(data)
        elif sport == "tennis":
            results = self._parse_tennis(data)
        else:
            results = []

        if not results:
            await log(f"⚠️ Kambi retornó 0 eventos para {sport} — usando fallback")
            return await self._fallback(sport, log)

        await log(f"✅ Kambi/Rushbet [{sport.upper()}]: {len(results)} partidos con cuotas reales")
        return results

    # ── NBA ────────────────────────────────────────────────────────────────────

    def _parse_nba(self, data: dict) -> list[dict]:
        results = []
        today_utc = datetime.now(timezone.utc)

        for ev in data.get("events", []):
            try:
                event = ev.get("event", ev)
                name  = event.get("name", "")

                start_str = event.get("start") or event.get("startTime") or ""
                match_dt  = _parse_datetime(start_str)
                if not match_dt or match_dt < today_utc:
                    continue

                teams = _parse_team_names(name)
                if not teams:
                    continue
                home_name, away_name = teams

                ml_home, ml_away = _extract_moneyline_2way(ev)
                if ml_home and ml_away:
                    results.append({
                        "home_team":  home_name,
                        "away_team":  away_name,
                        "ml_home":    ml_home,
                        "ml_away":    ml_away,
                        "bookmaker":  "rushbet",
                        "sport":      "nba",
                        "market":     "moneyline",
                        "match_date": match_dt.isoformat(),
                    })
            except Exception as e:
                logger.debug(f"NBA parse error: {e}")

        return results

    # ── Football ───────────────────────────────────────────────────────────────

    def _parse_football(self, data: dict) -> list[dict]:
        results = []
        today_utc = datetime.now(timezone.utc)

        for ev in data.get("events", []):
            try:
                event = ev.get("event", ev)
                name  = event.get("name", "")
                path_parts = (event.get("path") or [{}])
                # League is usually the last path element
                league_raw = path_parts[-1].get("name", "") if isinstance(path_parts, list) and path_parts else ""
                league = _map_football_league(league_raw) or league_raw

                start_str = event.get("start") or event.get("startTime") or ""
                match_dt  = _parse_datetime(start_str)
                if not match_dt or match_dt < today_utc:
                    continue

                teams = _parse_team_names(name)
                if not teams:
                    continue
                home_name, away_name = teams

                # Football is 3-way (home / draw / away)
                home_odd, draw_odd, away_odd = _extract_1x2(ev)
                if home_odd and away_odd:
                    results.append({
                        "home_team":  home_name,
                        "away_team":  away_name,
                        "ml_home":    home_odd,
                        "draw_odd":   draw_odd,
                        "ml_away":    away_odd,
                        "bookmaker":  "rushbet",
                        "sport":      "football",
                        "market":     "1X2",
                        "league":     league,
                        "match_date": match_dt.isoformat(),
                    })
            except Exception as e:
                logger.debug(f"Football parse error: {e}")

        return results

    # ── Tennis ─────────────────────────────────────────────────────────────────

    def _parse_tennis(self, data: dict) -> list[dict]:
        results = []
        today_utc = datetime.now(timezone.utc)

        for ev in data.get("events", []):
            try:
                event = ev.get("event", ev)
                name  = event.get("name", "")
                path_parts = (event.get("path") or [{}])
                tournament_raw = path_parts[-1].get("name", "") if isinstance(path_parts, list) and path_parts else ""

                start_str = event.get("start") or event.get("startTime") or ""
                match_dt  = _parse_datetime(start_str)
                if not match_dt or match_dt < today_utc:
                    continue

                teams = _parse_team_names(name)
                if not teams:
                    continue
                player1, player2 = teams

                ml_p1, ml_p2 = _extract_moneyline_2way(ev)
                if ml_p1 and ml_p2:
                    results.append({
                        "player1":    player1,
                        "player2":    player2,
                        "home_team":  player1,   # alias so saving logic stays uniform
                        "away_team":  player2,
                        "ml_home":    ml_p1,
                        "ml_away":    ml_p2,
                        "p1_odd":     ml_p1,
                        "p2_odd":     ml_p2,
                        "bookmaker":  "rushbet",
                        "sport":      "tennis",
                        "market":     "moneyline",
                        "tournament": tournament_raw,
                        "match_date": match_dt.isoformat(),
                    })
            except Exception as e:
                logger.debug(f"Tennis parse error: {e}")

        return results

    # ── Fallback ────────────────────────────────────────────────────────────────

    async def _fallback(self, sport: str, log) -> list[dict]:
        """ESPN/DraftKings fallback — only implemented for NBA."""
        if sport == "nba":
            await log("🔄 Usando ESPN/DraftKings como fallback para NBA...")
            from scrapers.nba_scraper import ESPNNBAOddsScraper
            return await ESPNNBAOddsScraper().scrape_nba_odds()
        await log(f"⚠️ Sin fallback disponible para {sport}")
        return []


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_datetime(start_str: str) -> Optional[datetime]:
    """Parse ISO datetime string to aware datetime."""
    if not start_str:
        return None
    try:
        return datetime.fromisoformat(start_str.replace("Z", "+00:00"))
    except Exception:
        return None


def _extract_moneyline_2way(ev: dict) -> Tuple[Optional[float], Optional[float]]:
    """
    Extract home and away decimal odds from a Kambi event's betOffers.
    Kambi outcomes are ordered [home, away] for 2-way markets.
    Odds label = team name (not "1"/"2").
    Returns (home_odd, away_odd) or (None, None).
    """
    event     = ev.get("event", ev)
    name      = event.get("name", "")
    teams     = _parse_team_names(name)
    home_name = teams[0] if teams else ""
    away_name = teams[1] if teams else ""

    bet_offers = ev.get("betOffers", [])
    for offer in bet_offers:
        crit  = offer.get("criterion", {}).get("label", "").lower()
        otype = offer.get("betOfferType", {}).get("name", "").lower()
        is_ml = "moneyline" in crit or ("match" in otype and "1x2" not in crit)
        if not is_ml:
            continue

        outcomes = offer.get("outcomes", [])
        ml_home, ml_away = None, None

        for out in outcomes:
            label    = out.get("label", "")
            odds_val = out.get("odds")
            if odds_val is None:
                continue
            decimal = _milliodds_to_decimal(odds_val)
            label_l = label.lower()
            if home_name and (home_name.lower() in label_l or label_l in home_name.lower()):
                ml_home = decimal
            elif away_name and (away_name.lower() in label_l or label_l in away_name.lower()):
                ml_away = decimal

        # Fallback: positional (Kambi puts home first)
        if ml_home is None and ml_away is None and len(outcomes) >= 2:
            ml_home = _milliodds_to_decimal(outcomes[0]["odds"])
            ml_away = _milliodds_to_decimal(outcomes[1]["odds"])

        if ml_home and ml_away:
            return ml_home, ml_away

    return None, None


def _extract_1x2(ev: dict) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """
    Extract home/draw/away decimal odds from a Kambi 3-way football event.
    Returns (home, draw, away).
    """
    bet_offers = ev.get("betOffers", [])
    for offer in bet_offers:
        crit  = offer.get("criterion", {}).get("label", "").lower()
        otype = offer.get("betOfferType", {}).get("name", "").lower()
        is_1x2 = "1x2" in crit or "match" in otype

        if not is_1x2:
            continue

        outcomes = offer.get("outcomes", [])
        home_odd, draw_odd, away_odd = None, None, None

        for out in outcomes:
            label    = (out.get("label") or "").lower()
            odds_val = out.get("odds")
            if odds_val is None:
                continue
            decimal = _milliodds_to_decimal(odds_val)

            # Kambi football labels: "1" / "X" / "2"  or team names
            if label in ("1", "home") or "home" in label:
                home_odd = decimal
            elif label in ("x", "draw", "empate"):
                draw_odd = decimal
            elif label in ("2", "away") or "away" in label:
                away_odd = decimal

        # Positional fallback: [home, draw, away]
        if home_odd is None and len(outcomes) >= 3:
            home_odd = _milliodds_to_decimal(outcomes[0]["odds"])
            draw_odd = _milliodds_to_decimal(outcomes[1]["odds"])
            away_odd = _milliodds_to_decimal(outcomes[2]["odds"])

        if home_odd and away_odd:
            return home_odd, draw_odd, away_odd

    return None, None, None


def _map_football_league(raw: str) -> Optional[str]:
    """Map a raw Kambi league name to the canonical name used in the DB."""
    lower = raw.lower()
    for fragment, canonical in FOOTBALL_LEAGUE_MAP.items():
        if fragment in lower:
            return canonical
    return None


# ── Convenience entry points (used by routers) ─────────────────────────────────

async def run_kambi_odds_scrape(
    sport: str,
    log_queue: asyncio.Queue,
) -> dict:
    """
    Entry point called by FastAPI routers.
    Returns {"odds": [...], "count": N}
    sport: "nba" | "football" | "tennis"
    """
    scraper = KambiRushbetScraper()
    odds = await scraper.scrape_odds(sport, log_queue=log_queue)
    return {"odds": odds, "count": len(odds)}
