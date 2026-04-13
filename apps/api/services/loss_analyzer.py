import json
from datetime import datetime, timezone
from typing import Dict, Any, List
from services.supabase_client import get_supabase

class LossAnalyzer:
    """
    Sistema de aprendizaje continuo basado en pérdidas (Loss Learning System).
    Categoriza las pérdidas y ajusta el 'bias_adjustment' de los equipos.
    (Prompt 12 del proyecto).
    """

    def analyze_loss(self, bet_id: str) -> Dict[str, Any]:
        supabase = get_supabase()

        # 1. Recuperar la apuesta perdida
        r_bet = supabase.table("parlay_bets").select("*").eq("id", bet_id).execute()
        if not r_bet.data:
            raise ValueError(f"Bet {bet_id} not found")
        
        bet = r_bet.data[0]
        legs = bet.get("bet_legs", [])
        
        # En el caso de Parlay, analizaremos las patas perdidas (asumimos todas para este prototype)
        # En un sistema en producción real, deberíamos marcar individualmente qué leg falló.
        for leg in legs:
            confidence = float(leg.get("prob", 0.5))
            ev = float(leg.get("ev", 0.0))
            odd = float(leg.get("odd", 1.9))
            
            # 4. Categorizar automáticamente la pérdida
            category = "variance"
            description = "Pérdida esperada estadísticamente. La confianza era menor al 62%."
            penalty = 0.0
            
            if confidence >= 0.72:
                category = "model_overconfidence"
                description = "El modelo sobrestimó la probabilidad real del equipo. Confianza > 72%."
                penalty = -0.05
            elif ev < 0.03:
                category = "odds_value_poor"
                description = "La cuota no tenía valor real (EV < 3%)."
            elif odd < 1.4:
                category = "heavy_favorite_loss"
                description = "Caída de gran favorito. Considerar posibles lesiones o fatiga ignorada."
                penalty = -0.03
            
            # 5. Guardar en loss_analysis
            supabase.table("loss_analysis").insert({
                "bet_id": bet_id,
                "category": category,
                "description": description,
                "confidence_at_time": confidence,
                "ev_at_time": ev,
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()

            # 6. Actualizar bias_adjustment en match team (simplificado)
            # Find matching team from selection string loosely
            team_name = leg.get("selection", "").replace(" gana", "").replace(" 1er Set", "").strip()
            
            if penalty < 0:
                t_res = supabase.table("teams").select("id, bias_adjustment").ilike("name", f"%{team_name}%").execute()
                if t_res.data:
                    t_id = t_res.data[0]["id"]
                    t_bias = t_res.data[0].get("bias_adjustment") or {}
                    
                    current_penalty = t_bias.get("confidence_penalty", 0.0)
                    t_bias["confidence_penalty"] = round(current_penalty + penalty, 3)
                    t_bias["applied_until"] = (datetime.now(timezone.utc) + __import__('datetime').timedelta(days=14)).isoformat()
                    t_bias["reason"] = category
                    
                    supabase.table("teams").update({"bias_adjustment": t_bias}).eq("id", t_id).execute()

        # Update bet status
        supabase.table("parlay_bets").update({"status": "lost"}).eq("id", bet_id).execute()

        return {
            "status": "success",
            "message": "Análisis completado y guardado.",
            "legs_analyzed": len(legs)
        }

    def get_patterns(self, user_id: str, min_sample: int = 2) -> List[Dict[str, str]]:
        supabase = get_supabase()
        
        # Pull recent lost bets user
        r_bets = supabase.table("parlay_bets").select("id").eq("user_id", user_id).eq("status", "lost").execute()
        if not r_bets.data or len(r_bets.data) < min_sample:
            return [{
                "title": "Datos insuficientes",
                "description": "Necesitamos analizar más apuestas perdidas para encontrar patrones estadísticos con tu estilo.",
                "type": "info"
            }]

        bet_ids = [b["id"] for b in r_bets.data]
        
        # Query loss analysis
        r_loss = supabase.table("loss_analysis").select("category, ev_at_time").in_("bet_id", bet_ids).execute()
        analysis = r_loss.data or []
        
        patterns = []
        
        cat_counts = {}
        for a in analysis:
            cat_counts[a["category"]] = cat_counts.get(a["category"], 0) + 1
            
        total = len(analysis)

        if cat_counts.get("model_overconfidence", 0) / max(total, 1) > 0.4:
            patterns.append({
                "title": "Exceso de Confianza",
                "description": "El 40%+ de tus fallos provienen de grandes favoritos. Reduce el stake en mercados < 1.40 odds.",
                "type": "warning"
            })
            
        if cat_counts.get("odds_value_poor", 0) / max(total, 1) > 0.3:
            patterns.append({
                "title": "Valor Ignorado",
                "description": "Estás añadiendo a tus parlays selecciones con EV casi nulo o negativo. Filtra estrictamente por EV > 5%.",
                "type": "danger"
            })
            
        if not patterns:
            patterns.append({
                "title": "Pérdidas por Varianza",
                "description": "Tus fallos están dentro del margen estadístico normal del modelo. Mantén la disciplina con el tamaño de tu stake.",
                "type": "success"
            })
            
        return patterns
