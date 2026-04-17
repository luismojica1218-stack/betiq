import os
import requests
import json

from dotenv import load_dotenv
load_dotenv('apps/web/.env.local')

supabase_url = os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
supabase_key = os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')
service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')

key = service_key if service_key else supabase_key
headers = {
    'apikey': key,
    'Authorization': f'Bearer {key}',
    'Content-Type': 'application/json',
}

url = f"{supabase_url}/rest/v1/bets?select=*"
res = requests.get(url, headers=headers)
bets = res.json()

if not isinstance(bets, list):
    print("Error fetching bets:", bets)
    exit(1)

deleted = 0
for b in bets:
    mid = b.get('match_id')
    
    is_dummy = False
    if not mid:
        is_dummy = True
    elif isinstance(mid, str):
        if len(mid) < 15 or 'demo' in mid.lower() or mid.startswith('f') or mid.startswith('t') or mid.startswith('nba-'):
            is_dummy = True
    
    if is_dummy:
        print(f"Deleting dummy bet: {b['id']} with match_id {mid}")
        del_url = f"{supabase_url}/rest/v1/bets?id=eq.{b['id']}"
        requests.delete(del_url, headers=headers)
        deleted += 1

print(f"Cleanup complete. Deleted {deleted} dummy bets.")
