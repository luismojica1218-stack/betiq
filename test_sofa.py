import asyncio
import sys
import os

# Agregamos dir actual a sys.path para import
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'apps', 'api')))

from scrapers.sofascore_scraper import SofaScoreFootballScraper

async def main():
    scraper = SofaScoreFootballScraper()
    res = await scraper.scrape_upcoming_fixtures("premier-league", 10)
    print("Found matches:", len(res))
    if len(res) > 0:
        print(res[0])

asyncio.run(main())
