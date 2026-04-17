import asyncio
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'apps', 'api')))

from scrapers.football_scraper import _espn_football_fixtures

async def main():
    res = await _espn_football_fixtures("premier-league", "Premier League")
    print("ESPN Found matches:", len(res))
    if len(res) > 0:
        print(res[0])

asyncio.run(main())
