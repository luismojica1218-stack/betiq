import logging
import httpx
from typing import Dict, Any
from bs4 import BeautifulSoup
import feedparser

logger = logging.getLogger(__name__)

class InjuryScraper:
    def __init__(self):
        # We use Google News RSS to search for recent injury reports for the team
        self.rss_base = "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
        self.injury_keywords = ["injury", "out", "miss", "surgery", "torn", "sprain", "fracture", "questionable", "doubtful"]

    async def get_team_injuries(self, team_name: str, sport: str = "nba") -> Dict[str, Any]:
        """
        Estimates the injury impact for a team based on recent news headlines.
        Returns an 'impact_score' from 0.0 (fully healthy) to 1.0 (devastated by injuries).
        """
        query = f'"{team_name}" {sport} injury report'
        url = self.rss_base.format(query=httpx.utils.quote(query))
        
        impact_score = 0.0
        injury_mentions = 0
        headlines = []
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url)
                if response.status_code == 200:
                    feed = feedparser.parse(response.text)
                    # Look at the top 10 articles
                    for entry in feed.entries[:10]:
                        title = entry.title.lower()
                        # If title mentions the team and an injury keyword
                        if any(kw in title for kw in self.injury_keywords):
                            injury_mentions += 1
                            headlines.append(entry.title)
                            
                    # Calculate impact
                    if injury_mentions == 0:
                        impact_score = 0.0
                    elif injury_mentions <= 2:
                        impact_score = 0.3 # Minor injuries
                    elif injury_mentions <= 5:
                        impact_score = 0.6 # Moderate impact
                    else:
                        impact_score = 0.9 # Severe impact (many reports = star player out)
                        
                    return {
                        "impact_score": impact_score,
                        "mentions": injury_mentions,
                        "status": "Saludable" if impact_score < 0.3 else ("Alertas" if impact_score < 0.7 else "Bajas Críticas"),
                        "headlines": headlines[:3]
                    }
        except Exception as e:
            logger.error(f"Error fetching injuries for {team_name}: {e}")
            
        # Fallback to healthy if fetch fails
        return {
            "impact_score": 0.0,
            "mentions": 0,
            "status": "Saludable (Fallback)",
            "headlines": []
        }
