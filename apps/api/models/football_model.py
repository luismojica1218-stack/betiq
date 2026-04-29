"""
StatIQ — Football ML Model
Architecture: Poisson (goal distribution) + XGBoost (1X2) ensemble
Output: Rich statistical insights — probabilities, expected goals, score prediction
"""
import asyncio
import logging
from math import exp, factorial
from pathlib import Path
from typing import Optional

import joblib
import numpy as np
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier

from constants import CONFIDENCE_HIGH, CONFIDENCE_MED

logger = logging.getLogger(__name__)
WEIGHTS_DIR = Path(__file__).parent / "weights"
WEIGHTS_DIR.mkdir(exist_ok=True)

XGB_PATH    = WEIGHTS_DIR / "football_xgb.pkl"
LGBM_PATH   = WEIGHTS_DIR / "football_lgbm.pkl"
SCALER_PATH = WEIGHTS_DIR / "football_scaler.pkl"

# 25 features — implied odds removed, news and weather added
FEATURE_NAMES = [
    # Home team
    "home_xg_per_game", "home_xga_per_game", "home_goals_per_game",
    "home_conceded_per_game", "home_poss", "home_win_pct",
    "home_draw_pct", "home_form_xg", "home_form_xga", "home_news_sentiment",
    # Away team
    "away_xg_per_game", "away_xga_per_game", "away_goals_per_game",
    "away_conceded_per_game", "away_poss", "away_win_pct",
    "away_draw_pct", "away_form_xg", "away_form_xga", "away_news_sentiment",
    # H2H & context
    "h2h_home_win_pct", "h2h_draw_pct",
    # League & Environment
    "league_strength", "weather_rain", "weather_wind",
]


def poisson_prob(lam: float, k: int) -> float:
    """P(X = k) for Poisson(lambda)."""
    return (lam ** k * exp(-lam)) / factorial(k)


def poisson_match_probs(lam_home: float, lam_away: float, max_goals: int = 8):
    """
    Calculate 1X2 and score distribution using independent Poisson model.
    Returns: (p_home_win, p_draw, p_away_win, score_matrix)
    """
    score_matrix = np.zeros((max_goals, max_goals))
    for i in range(max_goals):
        for j in range(max_goals):
            score_matrix[i][j] = poisson_prob(lam_home, i) * poisson_prob(lam_away, j)

    p_home_win = sum(score_matrix[i][j] for i in range(max_goals) for j in range(max_goals) if i > j)
    p_draw     = sum(score_matrix[i][j] for i in range(max_goals) for j in range(max_goals) if i == j)
    p_away_win = 1 - p_home_win - p_draw
    return p_home_win, p_draw, p_away_win, score_matrix


def btts_prob(score_matrix: np.ndarray, max_goals: int = 8) -> float:
    """Both Teams To Score probability from Poisson score matrix."""
    return sum(
        score_matrix[i][j]
        for i in range(1, max_goals)
        for j in range(1, max_goals)
    )


def over_under_prob(score_matrix: np.ndarray, line: float = 2.5, max_goals: int = 8) -> tuple:
    """P(over line) and P(under line) using score matrix."""
    over = sum(
        score_matrix[i][j]
        for i in range(max_goals)
        for j in range(max_goals)
        if i + j > line
    )
    return min(over, 0.99), max(1 - over, 0.01)


def _winner_confidence(p_max: float) -> str:
    """Map max probability to confidence label."""
    if p_max > CONFIDENCE_HIGH:
        return "alta"
    if p_max > CONFIDENCE_MED:
        return "media"
    return "baja"


def _most_likely_score(score_matrix: np.ndarray) -> str:
    """Find the (home_goals, away_goals) cell with the highest probability."""
    max_prob = -1.0
    best_i, best_j = 1, 0
    rows, cols = score_matrix.shape
    for i in range(rows):
        for j in range(cols):
            if score_matrix[i][j] > max_prob:
                max_prob = score_matrix[i][j]
                best_i, best_j = i, j
    return f"{best_i}-{best_j}"


def _goals_range(score_matrix: np.ndarray, max_goals: int = 8) -> dict:
    """Probability buckets for total goals."""
    p_0_1, p_2_3, p_4_plus, p_exactly_2 = 0.0, 0.0, 0.0, 0.0
    for i in range(max_goals):
        for j in range(max_goals):
            total = i + j
            p = score_matrix[i][j]
            if total <= 1:
                p_0_1 += p
            elif total <= 3:
                p_2_3 += p
            else:
                p_4_plus += p
            if total == 2:
                p_exactly_2 += p
    return {
        "0_1":       round(p_0_1, 4),
        "2_3":       round(p_2_3, 4),
        "4_plus":    round(p_4_plus, 4),
        "exactly_2": round(p_exactly_2, 4),
    }


class FootballPredictor:
    """
    Predicts football matches with rich statistical insights.
    Markets: 1X2 probabilities, expected goals, score prediction, BTTS, O/U, corners, first scorer.
    Architecture: Poisson + XGBoost/LightGBM ensemble (blended 60/40 then Poisson 50/ML 50).
    """

    def __init__(self):
        self.xgb: Optional[XGBClassifier]    = None
        self.lgbm: Optional[LGBMClassifier]  = None
        self.scaler: Optional[StandardScaler] = None
        self._loaded = False

    def load_models(self) -> bool:
        try:
            if XGB_PATH.exists() and LGBM_PATH.exists():
                self.xgb    = joblib.load(XGB_PATH)
                self.lgbm   = joblib.load(LGBM_PATH)
                self.scaler = joblib.load(SCALER_PATH) if SCALER_PATH.exists() else None
                self._loaded = True
                logger.info("Football models loaded")
                return True
            return False
        except Exception as e:
            logger.error(f"Error loading football models: {e}")
            return False

    def _calculate_lambda(self, team_xg: float, opponent_xga: float, league_avg: float = 1.4) -> float:
        """Dixon-Coles style lambda estimate: attacking strength x defensive weakness."""
        attack  = team_xg     / max(league_avg, 0.1)
        defence = opponent_xga / max(league_avg, 0.1)
        return max(attack * defence * league_avg, 0.2)

    def predict(self, match_data: dict) -> dict:
        """
        Main prediction method. match_data keys:
          home_stats, away_stats, h2h, league_avg_goals, league_strength
        Returns rich statistical insights — no odds, no EV, no Kelly.
        """
        h   = match_data.get("home_stats", {})
        a   = match_data.get("away_stats", {})
        h2h = match_data.get("h2h", {})

        # Poisson lambda estimates
        league_avg = match_data.get("league_avg_goals", 1.4)
        lam_home = self._calculate_lambda(
            h.get("xg_per_game", h.get("goals_per_game", league_avg)),
            a.get("xga_per_game", a.get("conceded_per_game", league_avg)),
            league_avg,
        )
        lam_away = self._calculate_lambda(
            a.get("xg_per_game", a.get("goals_per_game", league_avg)),
            h.get("xga_per_game", h.get("conceded_per_game", league_avg)),
            league_avg,
        )
        
        # Adjust lambda based on news sentiment
        h_news = match_data.get("home_news", {}).get("sentiment_score", 0.0)
        a_news = match_data.get("away_news", {}).get("sentiment_score", 0.0)
        lam_home *= (1.0 + (h_news * 0.1)) # Up to 10% boost/penalty
        lam_away *= (1.0 + (a_news * 0.1))
        
        # Adjust lambda based on weather (rain / wind reduces expected goals)
        w_rain = match_data.get("weather", {}).get("rain_mm", 0.0)
        w_wind = match_data.get("weather", {}).get("wind_kmh", 10.0)
        
        weather_penalty = 1.0
        if w_rain > 2.0:
            weather_penalty *= 0.90 # Heavy rain = 10% fewer goals
        if w_wind > 25.0:
            weather_penalty *= 0.95 # High wind = 5% fewer goals
            
        lam_home *= weather_penalty
        lam_away *= weather_penalty
        
        # Home advantage adjustment
        lam_home *= 1.10

        p_home_poisson, p_draw_poisson, p_away_poisson, score_matrix = poisson_match_probs(lam_home, lam_away)

        # ML model for 1X2
        if self._loaded and self.xgb and self.lgbm:
            feats = np.array([[
                h.get("xg_per_game", 1.4),         h.get("xga_per_game", 1.4),
                h.get("goals_per_game", 1.4),       h.get("conceded_per_game", 1.4),
                h.get("poss", 50.0),                h.get("win_pct", 0.45),
                h.get("draw_pct", 0.25),            h.get("form_xg", 1.4),
                h.get("form_xga", 1.4),             float(h_news),
                a.get("xg_per_game", 1.4),         a.get("xga_per_game", 1.4),
                a.get("goals_per_game", 1.4),       a.get("conceded_per_game", 1.4),
                a.get("poss", 50.0),                a.get("win_pct", 0.40),
                a.get("draw_pct", 0.25),            a.get("form_xg", 1.4),
                a.get("form_xga", 1.4),             float(a_news),
                h2h.get("h2h_home_win_pct", 0.45), h2h.get("h2h_draw_pct", 0.25),
                match_data.get("league_strength", 0.5), float(w_rain), float(w_wind),
            ]])
            if self.scaler:
                feats = self.scaler.transform(feats)
            proba_xgb  = self.xgb.predict_proba(feats)[0]   # [p_home, p_draw, p_away]
            proba_lgbm = self.lgbm.predict_proba(feats)[0]
            ml_probs = 0.6 * proba_xgb + 0.4 * proba_lgbm
            # Blend Poisson (50%) + ML ensemble (50%)
            p_home_win = 0.5 * p_home_poisson + 0.5 * ml_probs[0]
            p_draw     = 0.5 * p_draw_poisson  + 0.5 * ml_probs[1]
            p_away_win = 0.5 * p_away_poisson  + 0.5 * ml_probs[2]
        else:
            # Poisson only — no implied odds fallback
            p_home_win = p_home_poisson
            p_draw     = p_draw_poisson
            p_away_win = p_away_poisson

        # Normalize
        total = p_home_win + p_draw + p_away_win
        p_home_win /= total
        p_draw     /= total
        p_away_win /= total

        # Determine predicted winner and confidence
        probs = {"home": p_home_win, "draw": p_draw, "away": p_away_win}
        predicted_winner = max(probs, key=probs.__getitem__)
        p_max = probs[predicted_winner]
        winner_confidence = _winner_confidence(p_max)

        # Expected goals & totals
        exp_total_goals = lam_home + lam_away
        p_btts = btts_prob(score_matrix)
        p_over_2_5, p_under_2_5 = over_under_prob(score_matrix, 2.5)

        # Most likely scoreline
        most_likely_score = _most_likely_score(score_matrix)

        # Goals range breakdown
        goals_range = _goals_range(score_matrix)

        # Corners rough estimate
        corners_estimate = round(4.5 + (lam_home + lam_away) * 2.1, 1)

        # Home scores first probability (attack strength ratio)
        home_scores_first_pct = round(lam_home / (lam_home + lam_away), 4)

        return {
            # 1X2 probabilities
            "p_home_win":      round(p_home_win, 4),
            "p_draw":          round(p_draw, 4),
            "p_away_win":      round(p_away_win, 4),
            "predicted_winner": predicted_winner,
            "winner_confidence": winner_confidence,
            # Expected goals
            "exp_goals":  round(exp_total_goals, 2),
            "lam_home":   round(lam_home, 3),
            "lam_away":   round(lam_away, 3),
            # Goals range (most likely bracket)
            "goals_range":      goals_range,
            "most_likely_score": most_likely_score,
            # BTTS and O/U
            "p_btts":      round(p_btts, 4),
            "p_over_2_5":  round(p_over_2_5, 4),
            "p_under_2_5": round(p_under_2_5, 4),
            # Corners estimate
            "corners_estimate": corners_estimate,
            # First scorer probability
            "home_scores_first_pct": home_scores_first_pct,
            # News & Context details for UI display
            "home_news":            match_data.get("home_news", {}),
            "away_news":            match_data.get("away_news", {}),
            "weather":              match_data.get("weather", {}),
            "h2h_history":          match_data.get("h2h", {}),
            "model_version": "v5.0-stats-news-weather",
        }

    async def bootstrap_training(self, log_queue: Optional[asyncio.Queue] = None) -> dict:
        """Bootstrap: generate realistic synthetic football match data and train XGBoost 3-class (21 features)."""
        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log("Football ML Bootstrap: generando dataset sintetico...")
        np.random.seed(42)
        n = 3000
        X, y = [], []

        for _ in range(n):
            h_xg   = np.random.gamma(1.5, 0.9)
            a_xg   = np.random.gamma(1.3, 0.9)
            h_xga  = np.random.gamma(1.3, 0.9)
            a_xga  = np.random.gamma(1.5, 0.9)
            h_gol  = np.random.gamma(1.4, 0.95)
            a_gol  = np.random.gamma(1.2, 0.95)
            h_con  = np.random.gamma(1.2, 0.95)
            a_con  = np.random.gamma(1.4, 0.95)
            h_pos  = np.random.normal(52, 8)
            a_pos  = 100 - h_pos
            h_wpct = np.random.beta(4, 5)
            a_wpct = np.random.beta(3, 5)
            h_dpct = np.random.beta(2, 6)
            a_dpct = np.random.beta(2, 6)
            h_fxg  = np.random.gamma(1.4, 0.9)
            a_fxg  = np.random.gamma(1.2, 0.9)
            h_fxga = np.random.gamma(1.2, 0.9)
            a_fxga = np.random.gamma(1.4, 0.9)
            h2h_h  = np.random.beta(4, 4)
            h2h_d  = np.random.beta(2, 6)
            lstr   = np.random.uniform(0.3, 0.9)
            h_news = np.random.uniform(-1.0, 1.0)
            a_news = np.random.uniform(-1.0, 1.0)
            w_rain = np.random.exponential(1.0) # mm of rain
            w_wind = np.random.normal(15.0, 5.0) # km/h wind

            # Determine outcome based on xG advantage + home advantage (no implied odds) + news sentiment
            # Add weather impact to lambda
            w_pen = 1.0
            if w_rain > 2.0: w_pen *= 0.90
            if w_wind > 25.0: w_pen *= 0.95
            
            lam_h = max(h_xg / 1.4 * a_xga / 1.4 * 1.4 * 1.10 * (1 + h_news * 0.1) * w_pen, 0.3)
            lam_a = max(a_xg / 1.4 * h_xga / 1.4 * 1.4 * (1 + a_news * 0.1) * w_pen, 0.3)
            ph, pd, pa, _ = poisson_match_probs(lam_h, lam_a)

            rand = np.random.random()
            if rand < ph:
                label = 0   # home win
            elif rand < ph + pd:
                label = 1   # draw
            else:
                label = 2   # away win

            # 25 features — no implied odds
            X.append([
                h_xg, h_xga, h_gol, h_con, h_pos, h_wpct, h_dpct, h_fxg, h_fxga, h_news,
                a_xg, a_xga, a_gol, a_con, a_pos, a_wpct, a_dpct, a_fxg, a_fxga, a_news,
                h2h_h, h2h_d, lstr, w_rain, w_wind
            ])
            y.append(label)

        X, y = np.array(X), np.array(y)
        scaler = StandardScaler()
        Xs = scaler.fit_transform(X)

        await log(f"Dataset: {n} partidos -- {sum(y==0)} H-Win, {sum(y==1)} Draw, {sum(y==2)} A-Win")

        await log("Entrenando XGBClassifier (multi:softprob)...")
        xgb = XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            objective="multi:softprob", num_class=3,
            use_label_encoder=False, eval_metric="mlogloss",
            random_state=42, verbosity=0,
        )
        xgb.fit(Xs, y)
        xgb_cv = cross_val_score(xgb, Xs, y, cv=5, scoring="accuracy").mean()
        await log(f"XGBoost -> CV Accuracy: {xgb_cv:.3f}")

        await log("Entrenando LGBMClassifier...")
        lgbm = LGBMClassifier(
            n_estimators=200, num_leaves=31, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            objective="multiclass", num_class=3,
            random_state=42, verbose=-1,
        )
        lgbm.fit(Xs, y)
        lgbm_cv = cross_val_score(lgbm, Xs, y, cv=5, scoring="accuracy").mean()
        await log(f"LightGBM -> CV Accuracy: {lgbm_cv:.3f}")

        joblib.dump(xgb,    XGB_PATH)
        joblib.dump(lgbm,   LGBM_PATH)
        joblib.dump(scaler, SCALER_PATH)

        self.xgb = xgb
        self.lgbm = lgbm
        self.scaler = scaler
        self._loaded = True

        await log(f"Modelos guardados en {WEIGHTS_DIR}")
        await log("Football Bootstrap completado")

        return {
            "status":    "success",
            "xgb_cv":   round(xgb_cv, 4),
            "lgbm_cv":  round(lgbm_cv, 4),
            "n_samples": n,
            "n_features": len(FEATURE_NAMES),
        }


_football_predictor: Optional[FootballPredictor] = None


def get_football_predictor() -> FootballPredictor:
    global _football_predictor
    if _football_predictor is None:
        _football_predictor = FootballPredictor()
        _football_predictor.load_models()
    return _football_predictor
