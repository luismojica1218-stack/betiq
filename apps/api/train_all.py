import asyncio
from models.nba_model import get_predictor as get_nba
from models.football_model import get_football_predictor as get_fb
from models.tennis_model import get_tennis_predictor as get_ten

async def main():
    print("Training NBA...")
    nba = get_nba()
    await nba.bootstrap_training()
    
    print("Training Football...")
    fb = get_fb()
    await fb.bootstrap_training()
    
    print("Training Tennis...")
    ten = get_ten()
    await ten.bootstrap_training()

if __name__ == "__main__":
    asyncio.run(main())
