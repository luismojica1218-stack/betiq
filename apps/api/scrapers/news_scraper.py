import asyncio
import logging
from typing import Optional
import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# Basic dictionary for sentiment analysis (Spanish focus since the app is Spanish)
POSITIVE_WORDS = {
    "gana", "victoria", "triunfo", "campeón", "mejor", "excelente", "bueno", "increíble", "gol",
    "supera", "favorito", "recupera", "listo", "vuelve", "estrella", "destaca", "arrasa", "imparable",
    "renueva", "confianza", "brilla"
}

NEGATIVE_WORDS = {
    "pierde", "derrota", "cae", "lesión", "lesionado", "duda", "baja", "peor", "crisis", "problema",
    "roja", "expulsado", "tensión", "conflicto", "fracaso", "tropiezo", "decepción", "alarma",
    "quirófano", "golpe", "molestias"
}

class NewsScraper:
    """Scrapes news from public RSS feeds and performs a lightweight lexical sentiment analysis."""
    
    def __init__(self):
        self.base_url = "https://news.google.com/rss/search"

    async def get_team_news_sentiment(self, query: str, log_queue: Optional[asyncio.Queue] = None) -> dict:
        """
        Fetch recent news for a query (team/player) via Google News RSS and analyze sentiment.
        Returns a dict with sentiment score (-1.0 to 1.0) and top headlines.
        """
        async def log(msg: str):
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        # Encode query properly for URL
        from urllib.parse import quote_plus
        safe_query = quote_plus(f"{query} deportes")
        url = f"{self.base_url}?q={safe_query}&hl=es-419&gl=US&ceid=US:es-419"
        
        headlines = []
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url)
                if r.is_success:
                    # Parse XML feed
                    soup = BeautifulSoup(r.content, "xml")
                    items = soup.find_all("item", limit=5)
                    for item in items:
                        title = item.title.text if item.title else ""
                        if title:
                            # Clean up title (remove publisher suffix usually after " - ")
                            clean_title = title.split(" - ")[0]
                            headlines.append(clean_title)
        except Exception as e:
            logger.warning(f"Error fetching news for {query}: {e}")
            
        if not headlines:
            # Fallback mock for testing or if blocked
            headlines = [f"Últimas novedades sobre {query}", f"Preparativos del próximo partido de {query}"]

        # Calculate sentiment
        total_score = 0
        words_found = 0
        
        for h in headlines:
            # Simple tokenization
            words = h.lower().replace(",", "").replace(".", "").replace(":", "").split()
            for w in words:
                if w in POSITIVE_WORDS:
                    total_score += 1
                    words_found += 1
                elif w in NEGATIVE_WORDS:
                    total_score -= 1
                    words_found += 1

        sentiment_score = 0.0
        if words_found > 0:
            sentiment_score = total_score / words_found
            
        # Bound between -1.0 and 1.0
        sentiment_score = max(-1.0, min(1.0, sentiment_score))
        
        sentiment_label = "Neutral"
        if sentiment_score > 0.2:
            sentiment_label = "Positivo"
        elif sentiment_score < -0.2:
            sentiment_label = "Negativo"

        return {
            "query": query,
            "sentiment_score": round(sentiment_score, 2),
            "sentiment_label": sentiment_label,
            "headlines": headlines[:3] # Return top 3 for UI
        }
