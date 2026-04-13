"""
BetIQ — Shared constants and configuration
"""

# ---- Sports ----
SPORTS = ["nba", "football", "tennis"]

# ---- HTTP Headers (shared) ----
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# ---- Football leagues config (fbref IDs) ----
FOOTBALL_LEAGUES = {
    "premier-league":    {"fbref_id": "9",  "country": "England",  "name": "Premier League"},
    "la-liga":           {"fbref_id": "12", "country": "Spain",    "name": "La Liga"},
    "bundesliga":        {"fbref_id": "20", "country": "Germany",  "name": "Bundesliga"},
    "serie-a":           {"fbref_id": "11", "country": "Italy",    "name": "Serie A"},
    "ligue-1":           {"fbref_id": "13", "country": "France",   "name": "Ligue 1"},
    "champions-league":  {"fbref_id": "8",  "country": None,       "name": "Champions League"},
    "libertadores":      {"fbref_id": "14", "country": None,       "name": "Copa Libertadores"},
    "copa-sudamericana": {"fbref_id": "45", "country": None,       "name": "Copa Sudamericana"},
    "world-cup-2026":    {"fbref_id": "1",  "country": None,       "name": "Mundial FIFA 2026"},
}

# ---- Tennis ----
TENNIS_TOURNAMENTS = [
    "Australian Open", "Roland Garros", "Wimbledon", "US Open",
    "Indian Wells", "Miami Open", "Monte Carlo", "Madrid Open", "Rome Masters",
    "Canada Masters", "Cincinnati Masters", "Shanghai Masters", "Paris Masters",
    "ATP Finals", "WTA Finals", "ATP 500", "WTA 500", "ATP 250", "WTA 250"
]

# ---- Bookmakers ----
BOOKMAKERS = ["rushbet", "betplay"]

# ---- ML Thresholds ----
MIN_EV_FIXED  = 0.05   # 5% EV mínimo para apuesta fija
MIN_EV_PARLAY = 0.08   # 8% EV mínimo para incluir en parlay
MIN_CONFIDENCE = 0.55  # Confianza mínima del modelo

# ---- Kelly ----
KELLY_FRACTION   = 0.25   # Kelly al 25%
MAX_BET_PCT      = 0.20   # Máximo 20% del presupuesto en una sola apuesta

# ---- Scraping ----
REQUEST_DELAY_MIN = 1.0
REQUEST_DELAY_MAX = 3.0
MAX_RETRIES       = 3
