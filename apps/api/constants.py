"""
StatIQ — Shared constants and configuration
Sports analytics platform — pure statistical insights
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

# ---- Confidence thresholds (based on probability gap) ----
CONFIDENCE_HIGH = 0.65   # p_winner > 65% -> "Alta"
CONFIDENCE_MED  = 0.55   # p_winner > 55% -> "Media"
# below 55% -> "Baja"

# ---- Scraping ----
REQUEST_DELAY_MIN = 1.0
REQUEST_DELAY_MAX = 3.0
MAX_RETRIES       = 3
