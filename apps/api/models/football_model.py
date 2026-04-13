"""
BetIQ — Football ML Model
Architecture: Poisson (goal distribution) + XGBoost (1X2) + Rule-based (BTTS, O/U)
Markets: 1X2, Over/Under 2.5, BTTS, Asian Handicap
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

from constants import (
    KELLY_FRACTION, MAX_BET_PCT, MIN_CONFIDENCE, MIN_EV_FIXED, MIN_EV_PARLAY
)

logger = logging.getLogger(__name__)
WEIGHTS_DIR = Path(__file__).parent / "weights"
WEIGHTS_DIR.mkdir(exist_ok=True)

XGB_PATH    = WEIGHTS_DIR / "football_xgb.pkl"
LGBM_PATH   = WEIGHTS_DIR / "football_lgbm.pkl"
SCALER_PATH = WEIGHTS_DIR / "football_scaler.pkl"

FEATURE_NAMES = [
    # Home team
    "home_xg_per_game", "home_xga_per_game", "home_goals_per_game",
    "home_conceded_per_game", "home_poss", "home_win_pct",
    "home_draw_pct", "home_form_xg", "home_form_xga",
    # Away team
    "away_xg_per_game", "away_xga_per_game", "away_goals_per_game",
    "away_conceded_per_game", "away_poss", "away_win_pct",
    "away_draw_pct", "away_form_xg", "away_form_xga",
    # H2H & odds
    "h2h_home_win_pct", "h2h_draw_pct",
    "implied_home", "implied_draw", "implied_away",
    # League strength factor
    "league_strength",
]


def poisson_prob(lam: float, k: int) -> float:
    """P(X = k) for Poisson(λ)."""
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


def over_under_prob(score_matrix: np.ndarray, line: float = 2.5, max_goals: int = 8) -> tuple[float, float]:
    """P(over line) and P(under line) using score matrix."""
    over = sum(
        score_matrix[i][j]
        for i in range(max_goals)
        for j in range(max_goals)
        if i + j > line
    )
    return min(over, 0.99), max(1 - over, 0.01)


class FootballPredictor:
    """
    Predicts football matches across all markets:
    1X2, Over/Under 2.5, BTTS, Asian Handicap -0.5 / +0.5
    Using Poisson + XGBoost ensemble.
    """

    def __init__(self):
        self.xgb: Optional[XGBClassifier]   = None
        self.lgbm: Optional[LGBMClassifier] = None
        self.scaler: Optional[StandardScaler] = None
        self._loaded = False

    def load_models(self) -> bool:
        try:
            if XGB_PATH.exists() and LGBM_PATH.exists():
                self.xgb    = joblib.load(XGB_PATH)
                self.lgbm   = joblib.load(LGBM_PATH)
                self.scaler = joblib.load(SCALER_PATH) if SCALER_PATH.exists() else None
                self._loaded = True
                logger.info("✅ Football models loaded")
                return True
            return False
        except Exception as e:
            logger.error(f"Error loading football models: {e}")
            return False

    def _calculate_lambda(self, team_xg: float, opponent_xga: float, league_avg: float = 1.4) -> float:
        """Dixon-Coles style λ estimate: attacking strength × defensive weakness."""
        attack   = team_xg    / max(league_avg, 0.1)
        defence  = opponent_xga / max(league_avg, 0.1)
        return max(attack * defence * league_avg, 0.2)

    def _kelly(self, prob: float, odd: float, budget: int) -> int:
        if odd <= 1.0:
            return 0
        b = odd - 1
        f = (prob * b - (1 - prob)) / b
        f_adj = max(f * KELLY_FRACTION, 0)
        amount = int(min(f_adj * budget, budget * MAX_BET_PCT))
        return round(amount / 5000) * 5000

    def predict(self, match_data: dict, budget_cop: int = 200_000) -> dict:
        """
        Main prediction method. match_data keys:
          home_stats, away_stats, h2h, home_win_odd, draw_odd, away_win_odd,
          ou_over_odd, ou_under_odd, btts_yes_odd, btts_no_odd
        """
        h = match_data.get("home_stats", {})
        a = match_data.get("away_stats", {})
        h2h = match_data.get("h2h", {})

        # Odds
        home_odd   = float(match_data.get("home_win_odd", 2.5))
        draw_odd   = float(match_data.get("draw_odd", 3.2))
        away_odd   = float(match_data.get("away_win_odd", 2.8))
        ou_over    = float(match_data.get("ou_over_odd", 1.90))
        ou_under   = float(match_data.get("ou_under_odd", 1.90))
        btts_yes   = float(match_data.get("btts_yes_odd", 1.80))
        btts_no    = float(match_data.get("btts_no_odd", 2.00))

        # Implied probabilities (remove overround)
        raw_1 = 1 / home_odd
        raw_x = 1 / draw_odd
        raw_2 = 1 / away_odd
        overround = raw_1 + raw_x + raw_2
        imp_home = raw_1 / overround
        imp_draw = raw_x / overround
        imp_away = raw_2 / overround

        # Poisson λ estimates
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
                h.get("form_xga", 1.4),
                a.get("xg_per_game", 1.4),         a.get("xga_per_game", 1.4),
                a.get("goals_per_game", 1.4),       a.get("conceded_per_game", 1.4),
                a.get("poss", 50.0),                a.get("win_pct", 0.40),
                a.get("draw_pct", 0.25),            a.get("form_xg", 1.4),
                a.get("form_xga", 1.4),
                h2h.get("h2h_home_win_pct", 0.45), h2h.get("h2h_draw_pct", 0.25),
                imp_home, imp_draw, imp_away,
                match_data.get("league_strength", 0.5),
            ]])
            if self.scaler:
                feats = self.scaler.transform(feats)
            proba_xgb  = self.xgb.predict_proba(feats)[0]   # [p_home, p_draw, p_away]
            proba_lgbm = self.lgbm.predict_proba(feats)[0]
            ml_probs = 0.6 * proba_xgb + 0.4 * proba_lgbm
            # Blend Poisson + ML (50/50)
            p_home_win = 0.5 * p_home_poisson + 0.5 * ml_probs[0]
            p_draw     = 0.5 * p_draw_poisson  + 0.5 * ml_probs[1]
            p_away_win = 0.5 * p_away_poisson  + 0.5 * ml_probs[2]
        else:
            # Blend Poisson + implied odds
            p_home_win = 0.6 * p_home_poisson + 0.4 * imp_home
            p_draw     = 0.6 * p_draw_poisson  + 0.4 * imp_draw
            p_away_win = 0.6 * p_away_poisson  + 0.4 * imp_away

        # Normalize
        total = p_home_win + p_draw + p_away_win
        p_home_win /= total; p_draw /= total; p_away_win /= total

        # Expected goals & totals
        exp_total_goals = lam_home + lam_away
        p_btts_yes_calc, p_ou_over_calc, p_ou_under_calc = (
            btts_prob(score_matrix),
            *over_under_prob(score_matrix, 2.5),
        )

        # EV for each market
        ev_home  = p_home_win * home_odd - 1
        ev_draw  = p_draw     * draw_odd - 1
        ev_away  = p_away_win * away_odd - 1
        ev_over  = p_ou_over_calc  * ou_over  - 1
        ev_under = p_ou_under_calc * ou_under - 1
        ev_btts_yes = p_btts_yes_calc * btts_yes - 1
        ev_btts_no  = (1 - p_btts_yes_calc) * btts_no - 1

        # Best 1X2 market
        markets_1x2 = [
            ("home_win",  p_home_win, home_odd, ev_home),
            ("draw",      p_draw,     draw_odd, ev_draw),
            ("away_win",  p_away_win, away_odd, ev_away),
        ]
        best_1x2 = max(markets_1x2, key=lambda x: x[3])
        best_ou   = ("over_2.5", p_ou_over_calc, ou_over, ev_over) if ev_over > ev_under else ("under_2.5", p_ou_under_calc, ou_under, ev_under)
        best_btts = ("btts_yes", p_btts_yes_calc, btts_yes, ev_btts_yes) if ev_btts_yes > ev_btts_no else ("btts_no", 1 - p_btts_yes_calc, btts_no, ev_btts_no)

        # Overall best (highest EV)
        all_markets = [best_1x2, best_ou, best_btts]
        overall_best = max(all_markets, key=lambda m: m[3])

        # Kelly amounts
        bet_type = None
        if overall_best[3] >= MIN_EV_FIXED and overall_best[1] >= MIN_CONFIDENCE:
            bet_type = "fixed"
        if overall_best[3] >= MIN_EV_PARLAY:
            bet_type = "parlay"

        suggested_amount = self._kelly(overall_best[1], overall_best[2], budget_cop) if bet_type else 0

        return {
            # 1X2
            "p_home_win": round(p_home_win, 4),
            "p_draw":     round(p_draw, 4),
            "p_away_win": round(p_away_win, 4),
            # O/U
            "p_over_2_5":  round(p_ou_over_calc, 4),
            "p_under_2_5": round(p_ou_under_calc, 4),
            "exp_goals":   round(exp_total_goals, 2),
            "lam_home":    round(lam_home, 3),
            "lam_away":    round(lam_away, 3),
            # BTTS
            "p_btts_yes": round(p_btts_yes_calc, 4),
            "p_btts_no":  round(1 - p_btts_yes_calc, 4),
            # Best market
            "best_market":     overall_best[0],
            "best_prob":       round(overall_best[1], 4),
            "best_odd":        overall_best[2],
            "expected_value":  round(overall_best[3], 4),
            "bet_type":        bet_type,
            "suggested_amount_cop": suggested_amount,
            "parlay_worthy":   overall_best[3] >= MIN_EV_PARLAY,
            # EV per market
            "ev_home": round(ev_home, 4),
            "ev_draw": round(ev_draw, 4),
            "ev_away": round(ev_away, 4),
            "ev_over": round(ev_over, 4),
            "ev_under": round(ev_under,4),
            "ev_btts_yes": round(ev_btts_yes, 4),
            "ev_btts_no":  round(ev_btts_no, 4),
            "model_version": "v2.0-poisson-xgb",
        }

    async def bootstrap_training(self, log_queue: Optional[asyncio.Queue] = None) -> dict:
        """Bootstrap: generate realistic synthetic football match data and train XGBoost 3-class."""
        async def log(msg: str):
            logger.info(msg)
            if log_queue: await log_queue.put({"type": "log", "message": msg})

        await log("🚀 Football ML Bootstrap: generando dataset sintético...")
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
            imp_h  = np.random.uniform(0.3, 0.6)
            imp_d  = np.random.uniform(0.1, 0.3)
            imp_a  = 1 - imp_h - imp_d
            lstr   = np.random.uniform(0.3, 0.9)

            # Determine outcome based on xG advantage + home advantage
            lam_h = max(h_xg / 1.4 * a_xga / 1.4 * 1.4 * 1.10, 0.3)
            lam_a = max(a_xg / 1.4 * h_xga / 1.4 * 1.4, 0.3)
            ph, pd, pa, _ = poisson_match_probs(lam_h, lam_a)

            rand = np.random.random()
            if rand < ph: label = 0   # home win
            elif rand < ph + pd: label = 1  # draw
            else: label = 2            # away win

            X.append([h_xg, h_xga, h_gol, h_con, h_pos, h_wpct, h_dpct, h_fxg, h_fxga,
                       a_xg, a_xga, a_gol, a_con, a_pos, a_wpct, a_dpct, a_fxg, a_fxga,
                       h2h_h, h2h_d, imp_h, imp_d, max(imp_a, 0.01), lstr])
            y.append(label)

        X, y = np.array(X), np.array(y)
        scaler = StandardScaler()
        Xs = scaler.fit_transform(X)

        await log(f"📊 Dataset: {n} partidos — {sum(y==0)} H-Win, {sum(y==1)} Draw, {sum(y==2)} A-Win")

        await log("🤖 Entrenando XGBClassifier (multi:softprob)...")
        xgb = XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            objective="multi:softprob", num_class=3,
            use_label_encoder=False, eval_metric="mlogloss",
            random_state=42, verbosity=0,
        )
        xgb.fit(Xs, y)
        xgb_cv = cross_val_score(xgb, Xs, y, cv=5, scoring="accuracy").mean()
        await log(f"✅ XGBoost → CV Accuracy: {xgb_cv:.3f}")

        await log("🤖 Entrenando LGBMClassifier...")
        lgbm = LGBMClassifier(
            n_estimators=200, num_leaves=31, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            objective="multiclass", num_class=3,
            random_state=42, verbose=-1,
        )
        lgbm.fit(Xs, y)
        lgbm_cv = cross_val_score(lgbm, Xs, y, cv=5, scoring="accuracy").mean()
        await log(f"✅ LightGBM → CV Accuracy: {lgbm_cv:.3f}")

        joblib.dump(xgb,    XGB_PATH)
        joblib.dump(lgbm,   LGBM_PATH)
        joblib.dump(scaler, SCALER_PATH)

        self.xgb = xgb; self.lgbm = lgbm; self.scaler = scaler; self._loaded = True
        await log(f"💾 Modelos guardados en {WEIGHTS_DIR}")
        await log("🎉 Football Bootstrap completado")

        return {"status": "success", "xgb_cv": round(xgb_cv, 4), "lgbm_cv": round(lgbm_cv, 4), "n_samples": n}


_football_predictor: Optional[FootballPredictor] = None

def get_football_predictor() -> FootballPredictor:
    global _football_predictor
    if _football_predictor is None:
        _football_predictor = FootballPredictor()
        _football_predictor.load_models()
    return _football_predictor
