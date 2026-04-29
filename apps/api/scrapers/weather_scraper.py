import logging
import httpx
from typing import Dict, Any

logger = logging.getLogger(__name__)

# Basic dictionary to map leagues or popular teams to approximate coordinates (lat, lon)
# This is a fallback to get general weather patterns for a region.
GEO_MAP = {
    "premier-league": (52.5, -1.5), # Central UK
    "la-liga": (40.4, -3.7),        # Madrid
    "bundesliga": (51.1, 10.4),     # Central Germany
    "serie-a": (41.9, 12.5),        # Rome
    "ligue-1": (46.2, 2.2),         # Central France
    "champions-league": (48.8, 2.3),# Paris fallback
    "liga-colombiana": (4.7, -74.0),# Bogota
    "libertadores": (-23.5, -46.6), # Sao Paulo fallback
    "ATP": (48.8, 2.3),             # Default fallback
    "WTA": (48.8, 2.3)
}

class WeatherScraper:
    def __init__(self):
        self.base_url = "https://api.open-meteo.com/v1/forecast"
        
    async def get_weather(self, league: str, team_name: str = "") -> Dict[str, Any]:
        """
        Fetches current weather for a given league/team using Open-Meteo.
        Returns weather conditions: temperature, rain, wind_speed.
        """
        # Resolve coordinates
        lat, lon = GEO_MAP.get(league, (48.8, 2.3)) # Default to Paris
        
        # We could add specific team coordinates here if we want to be more precise
        if "manchester" in team_name.lower():
            lat, lon = 53.48, -2.24
        elif "london" in team_name.lower() or "arsenal" in team_name.lower() or "chelsea" in team_name.lower():
            lat, lon = 51.5, -0.12
        elif "madrid" in team_name.lower():
            lat, lon = 40.4, -3.7
        elif "barcelona" in team_name.lower():
            lat, lon = 41.38, 2.15
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                params = {
                    "latitude": lat,
                    "longitude": lon,
                    "current": ["temperature_2m", "precipitation", "wind_speed_10m"],
                    "timezone": "auto"
                }
                response = await client.get(self.base_url, params=params)
                response.raise_for_status()
                data = response.json()
                
                current = data.get("current", {})
                temp = current.get("temperature_2m", 20.0)
                rain = current.get("precipitation", 0.0)
                wind = current.get("wind_speed_10m", 10.0)
                
                # Create a simple label
                condition_label = "Despejado"
                if rain > 2.0:
                    condition_label = "Lluvia Fuerte"
                elif rain > 0.1:
                    condition_label = "Lluvia Ligera"
                elif wind > 25.0:
                    condition_label = "Ventoso"
                
                return {
                    "temperature": temp,
                    "rain_mm": rain,
                    "wind_kmh": wind,
                    "condition": condition_label,
                    "icon": "🌧️" if rain > 0.1 else ("🌬️" if wind > 25 else "☀️")
                }
        except Exception as e:
            logger.error(f"Error fetching weather for {team_name} in {league}: {e}")
            # Safe fallback
            return {
                "temperature": 20.0,
                "rain_mm": 0.0,
                "wind_kmh": 10.0,
                "condition": "Desconocido (Fallback)",
                "icon": "⛅"
            }
