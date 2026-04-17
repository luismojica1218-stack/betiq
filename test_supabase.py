from apps.api.services.supabase_client import get_supabase
import sys
import json

supabase = get_supabase()
res = supabase.table("teams").select("id, name").in_("name", ["Sassuolo", "Como"]).execute()
team_ids = {t["id"]: t["name"] for t in res.data}
print("Teams:", team_ids)

if team_ids:
    res2 = supabase.table("matches").select("id, home_team_id, away_team_id").or_(
        f"home_team_id.in.({','.join(team_ids.keys())}),away_team_id.in.({','.join(team_ids.keys())})"
    ).execute()
    print("Matches:", res2.data)
    for m in res2.data:
        print(f"Match {m['id']}: Home ({team_ids.get(m['home_team_id'])}) vs Away ({team_ids.get(m['away_team_id'])})")
        res3 = supabase.table("odds").select("*").eq("match_id", m["id"]).execute()
        for odd in res3.data:
            print(f"   Odd: {odd['market']} {odd['selection']} = {odd['odd_value']}")
