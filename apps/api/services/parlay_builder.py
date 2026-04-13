import itertools
import math
from typing import List, Dict, Any
from services.supabase_client import get_supabase
from constants import KELLY_FRACTION, MAX_BET_PCT

class ParlayOptimizer:
    """
    Inteligencia para sugerir parlays óptimos basados en EV.
    (Prompt 11 del proyecto).
    """

    def suggest_parlays(self, user_id: str, budget_parlay_cop: int = 50000, max_legs: int = 4) -> List[Dict[str, Any]]:
        supabase = get_supabase()

        # 1. Fetch recent high-quality predictions
        # EV > 0.08 AND confidence > 0.55
        res = supabase.table("predictions").select(
            "id, match_id, predicted_outcome, confidence, expected_value, "
            "recommended_market, bet_type, suggested_amount_cop, features_used, "
            "matches!inner(sport, league, match_date, home_team_id, away_team_id, teams!home_team_id(name), teams!away_team_id(name))"
        ).gte("expected_value", 0.08).gte("confidence", 0.55).order("expected_value", desc=True).limit(15).execute()

        predictions = res.data or []
        if not predictions:
            return []

        # Formatear legs
        legs = []
        for p in predictions:
            m = p.get("matches", {})
            h_team = m.get("teams!home_team_id", {}).get("name", "Home") if isinstance(m.get("teams!home_team_id"), dict) else "Home"
            a_team = m.get("teams!away_team_id", {}).get("name", "Away") if isinstance(m.get("teams!away_team_id"), dict) else "Away"
            
            # Recuperar cuota implícita del modelo en base a EV = prob * odd - 1 => odd = (EV + 1) / prob
            prob = float(p["confidence"])
            ev   = float(p["expected_value"])
            odd  = (ev + 1) / prob if prob > 0 else 1.0

            legs.append({
                "id": p["id"],
                "match_id": p["match_id"],
                "sport": m.get("sport", "unknown"),
                "match": f"{h_team} vs {a_team}",
                "market": p.get("recommended_market", "Moneyline"),
                "selection": p.get("predicted_outcome", ""),
                "odd": round(odd, 2),
                "prob": prob,
                "ev": ev
            })

        # 2. Generar combinaciones de 2, 3 y 4 legs
        suggestions = []
        for combo_size in range(2, min(max_legs + 1, len(legs) + 1)):
            for subset in itertools.combinations(legs, combo_size):
                # Verificar restricción simple (no combinar picks del mismo partido)
                match_ids = [l["match_id"] for l in subset]
                if len(set(match_ids)) < len(match_ids):
                    continue

                combined_odd = math.prod(l["odd"] for l in subset)
                p_real = math.prod(l["prob"] for l in subset)
                ev_parlay = (p_real * combined_odd) - 1
                roi_potential = (combined_odd - 1) * 100

                # 4. Filtrar: ev_parlay > 0.15 y combined_odd > 3.0
                if ev_parlay > 0.15 and combined_odd >= 2.0:
                    suggestions.append({
                        "legs": list(subset),
                        "combined_odd": round(combined_odd, 2),
                        "p_real": round(p_real, 4),
                        "ev_parlay": round(ev_parlay, 4),
                        "roi_potential": round(roi_potential, 1)
                    })

        # 5. Ordenar por ev_parlay descendente, retornar top 5
        suggestions.sort(key=lambda x: x["ev_parlay"], reverse=True)
        top_5 = suggestions[:5]

        # 6. Para cada parlay, calcular Kelly
        for parlay in top_5:
            ev_p = parlay["ev_parlay"]
            b = parlay["combined_odd"] - 1
            f = max(ev_p / b * KELLY_FRACTION, 0) if b > 0 else 0
            
            # Amount limits
            amount = int(min(f * budget_parlay_cop, budget_parlay_cop * MAX_BET_PCT))
            parlay["suggested_amount_cop"] = round(amount / 5000) * 5000

        return top_5
