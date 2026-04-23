"""
StatIQ — Tennis ML Model
Architecture:
  - Elo engine (surface-adjusted): match winner probability base
  - XGBoost + LightGBM ensemble: 28-feature classifier
Output: Rich statistical insights — win probabilities, sets prediction, games O/U, surface advantage
"""
import asyncio
import logging
import math
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

XGB_PATH    = WEIGHTS_DIR / "tennis_xgb.pkl"
LGBM_PATH   = WEIGHTS_DIR / "tennis_lgbm.pkl"
SCALER_PATH = WEIGHTS_DIR / "tennis_scaler.pkl"
ELO_PATH    = WEIGHTS_DIR / "tennis_elo.pkl"

# Surface Elo k-factors
SURFACE_K = {"hard": 32, "clay": 32, "grass": 32, "indoor": 24, "carpet": 24}

# 28 features — implied_p1 and implied_p2 removed
FEATURE_NAMES = [
    # Player 1
    "p1_elo", "p1_surface_elo", "p1_surface_win_pct",
    "p1_hard_pct", "p1_clay_pct", "p1_grass_pct",
    "p1_recent_win_pct", "p1_recent_sets_ratio",
    "p1_recent_aces_per_game", "p1_fatigue_days",
    "p1_ranking",
    # Player 2
    "p2_elo", "p2_surface_elo", "p2_surface_win_pct",
    "p2_hard_pct", "p2_clay_pct", "p2_grass_pct",
    "p2_recent_win_pct", "p2_recent_sets_ratio",
    "p2_recent_aces_per_game", "p2_fatigue_days",
    "p2_ranking",
    # H2H & context
    "h2h_p1_wins", "h2h_total",
    "elo_diff", "surface_elo_diff",
    "surface_code",  # 0=hard, 1=clay, 2=grass, 3=indoor
    "is_grand_slam",
]

SURFACE_MAP = {"hard": 0, "clay": 1, "grass": 2, "indoor": 3, "carpet": 3}


def elo_win_prob(elo1: float, elo2: float) -> float:
    """Classic Elo win probability for player 1."""
    return 1 / (1 + 10 ** ((elo2 - elo1) / 400))


def surface_adjust(base_elo: float, surface_delta: float) -> float:
    """Apply surface-specific Elo adjustment."""
    return base_elo + surface_delta


def _winner_confidence(prob: float) -> str:
    """Map win probability to confidence label."""
    if prob > CONFIDENCE_HIGH:
        return "alta"
    if prob > CONFIDENCE_MED:
        return "media"
    return "baja"


class EloEngine:
    """
    Maintains current Elo per player per surface.
    Can be updated incrementally as results come in.
    """
    def __init__(self):
        self.ratings: dict = {}        # player -> {surface: elo}
        self.global_ratings: dict = {} # player -> global elo

    def get(self, player: str, surface: str = "hard") -> float:
        return self.ratings.get(player, {}).get(surface, 1500.0)

    def get_global(self, player: str) -> float:
        return self.global_ratings.get(player, 1500.0)

    def update(self, winner: str, loser: str, surface: str, k: int = 32):
        for surf in [surface, "global"]:
            if surf == "global":
                p1_elo = self.get_global(winner)
                p2_elo = self.get_global(loser)
            else:
                p1_elo = self.get(winner, surf)
                p2_elo = self.get(loser, surf)

            expected = elo_win_prob(p1_elo, p2_elo)
            delta_w  = k * (1 - expected)
            delta_l  = k * (0 - (1 - expected))

            if surf == "global":
                self.global_ratings[winner] = p1_elo + delta_w
                self.global_ratings[loser]  = p2_elo + delta_l
            else:
                self.ratings.setdefault(winner, {})[surf] = p1_elo + delta_w
                self.ratings.setdefault(loser, {})[surf]  = p2_elo + delta_l

    def seed_from_rankings(self, rankings: list):
        """Initialize Elo from known rankings list."""
        for r in rankings:
            name = r.get("name", "")
            elo  = float(r.get("elo", 1500))
            surf = r.get("surface", "hard")
            self.global_ratings[name] = elo
            self.ratings.setdefault(name, {})[surf] = elo


class TennisPredictor:
    """
    Tennis match predictor.
    Returns rich statistical insights: win probs, surface advantage, sets, games O/U.
    No odds, no EV, no Kelly.
    """

    def __init__(self):
        self.xgb:    Optional[XGBClassifier]  = None
        self.lgbm:   Optional[LGBMClassifier] = None
        self.scaler: Optional[StandardScaler] = None
        self.elo_engine = EloEngine()
        self._loaded = False

    def load_models(self) -> bool:
        try:
            if XGB_PATH.exists() and LGBM_PATH.exists():
                self.xgb    = joblib.load(XGB_PATH)
                self.lgbm   = joblib.load(LGBM_PATH)
                self.scaler = joblib.load(SCALER_PATH) if SCALER_PATH.exists() else None
                if ELO_PATH.exists():
                    self.elo_engine = joblib.load(ELO_PATH)
                self._loaded = True
                logger.info("Tennis models loaded")
                return True
            return False
        except Exception as e:
            logger.error(f"Error loading tennis models: {e}")
            return False

    def _expected_games(self, p1_win_prob: float, surface: str = "hard") -> float:
        """
        Approximate expected total games based on win probability and surface.
        Higher probability -> more decisive -> fewer games.
        Clay -> more games (tougher rallies).
        """
        games_base = {"hard": 34, "clay": 37, "grass": 31, "indoor": 33, "carpet": 33}
        base = games_base.get(surface, 34)
        competitiveness = 1 - abs(p1_win_prob - 0.5) * 1.6
        return round(base + competitiveness * 5, 1)

    def predict(self, match_data: dict) -> dict:
        """
        match_data keys:
          player1, player2, surface, tour, is_grand_slam
          p1_stats, p2_stats, h2h
        No odds — all projections are Elo + ML based.
        """
        p1    = match_data.get("player1", "Player 1")
        p2    = match_data.get("player2", "Player 2")
        surf  = match_data.get("surface", "hard")
        is_gs = int(match_data.get("is_grand_slam", False))

        p1s = match_data.get("p1_stats", {})
        p2s = match_data.get("p2_stats", {})
        h2h = match_data.get("h2h", {})

        # Elo-based probabilities
        p1_elo      = self.elo_engine.get_global(p1) or float(p1s.get("elo", 1500))
        p2_elo      = self.elo_engine.get_global(p2) or float(p2s.get("elo", 1500))
        p1_surf_elo = self.elo_engine.get(p1, surf)  or float(p1s.get("surface_elo", p1_elo))
        p2_surf_elo = self.elo_engine.get(p2, surf)  or float(p2s.get("surface_elo", p2_elo))

        p_elo_global  = elo_win_prob(p1_elo, p2_elo)
        p_elo_surface = elo_win_prob(p1_surf_elo, p2_surf_elo)

        # ML if available (28 features — no implied odds)
        if self._loaded and self.xgb and self.lgbm:
            h2h_total = h2h.get("h2h_total", 0) or (h2h.get("p1_wins", 0) + h2h.get("p2_wins", 0))
            feats = np.array([[
                p1_elo, p1_surf_elo,
                p1s.get("surface_win_pct", 0.5),
                p1s.get("hard_pct", 0.5),    p1s.get("clay_pct", 0.5),  p1s.get("grass_pct", 0.5),
                p1s.get("recent_win_pct", 0.5), p1s.get("sets_ratio", 1.0),
                p1s.get("aces_per_game", 0.5), p1s.get("fatigue_days", 3),
                float(p1s.get("ranking", 50)),
                p2_elo, p2_surf_elo,
                p2s.get("surface_win_pct", 0.5),
                p2s.get("hard_pct", 0.5),    p2s.get("clay_pct", 0.5),  p2s.get("grass_pct", 0.5),
                p2s.get("recent_win_pct", 0.5), p2s.get("sets_ratio", 1.0),
                p2s.get("aces_per_game", 0.5), p2s.get("fatigue_days", 3),
                float(p2s.get("ranking", 100)),
                float(h2h.get("p1_wins", 0)), float(h2h_total),
                p1_elo - p2_elo, p1_surf_elo - p2_surf_elo,
                float(SURFACE_MAP.get(surf, 0)),
                float(is_gs),
            ]])
            if self.scaler:
                feats = self.scaler.transform(feats)
            proba_xgb  = self.xgb.predict_proba(feats)[0]   # P1 straight, tight, P2 wins
            proba_lgbm = self.lgbm.predict_proba(feats)[0]
            ml = 0.6 * proba_xgb + 0.4 * proba_lgbm
            # Blend: 40% surface elo + 30% global elo + 30% ML
            p1_win = 0.4 * p_elo_surface + 0.3 * p_elo_global + 0.3 * (ml[0] + 0.5 * ml[1])
        else:
            # Elo only (no implied odds fallback)
            p1_win = 0.6 * p_elo_surface + 0.4 * p_elo_global

        p1_win = float(min(max(p1_win, 0.05), 0.95))
        p2_win = 1.0 - p1_win

        # Predicted winner and confidence
        predicted_winner  = "p1" if p1_win >= 0.5 else "p2"
        winner_prob       = p1_win if p1_win >= 0.5 else p2_win
        winner_confidence = _winner_confidence(winner_prob)

        # Surface advantage: compare surface Elo ratings
        surf_elo_diff = p1_surf_elo - p2_surf_elo
        if surf_elo_diff > 50:
            surface_advantage = "p1"
        elif surf_elo_diff < -50:
            surface_advantage = "p2"
        else:
            surface_advantage = "neutral"

        # Sets prediction
        # p_straight: probability the winner takes the match without dropping a set
        if winner_prob > 0.7:
            p_straight = winner_prob * 0.6
        else:
            p_straight = winner_prob * 0.4
        p_straight = min(p_straight, 0.80)

        # p_three_sets: probability a deciding set is played
        p_three_sets = max(0.0, 1.0 - p_straight - (1.0 - winner_prob))
        p_three_sets = min(p_three_sets, 0.70)

        # Expected sets
        if is_gs:
            # Best of 5: expected sets between 3 and 5
            exp_sets = round(3 + p_three_sets * (5 / 3), 2)
        else:
            # Best of 3: expected sets between 2 and 3
            exp_sets = round(2 + p_three_sets * 1.0, 2)

        # Most likely result string
        if p_straight >= p_three_sets:
            if is_gs:
                most_likely_result = "3-0"
            else:
                most_likely_result = "2-0"
        else:
            if is_gs:
                most_likely_result = "3-2"
            else:
                most_likely_result = "2-1"

        # Games O/U
        exp_total_games = self._expected_games(p1_win, surf)
        ou_line = 22.5
        p_over_22_5  = round(min(max(0.5 + (exp_total_games - ou_line) * 0.05, 0.10), 0.90), 4)
        p_under_22_5 = round(1.0 - p_over_22_5, 4)

        return {
            "p1_win_prob":      round(p1_win, 4),
            "p2_win_prob":      round(p2_win, 4),
            "predicted_winner": predicted_winner,
            "winner_confidence": winner_confidence,
            "elo_p1":           round(p1_surf_elo, 1),
            "elo_p2":           round(p2_surf_elo, 1),
            "elo_diff":         round(surf_elo_diff, 1),
            "surface_advantage": surface_advantage,
            # Sets prediction
            "p_straight_sets":    round(p_straight, 4),
            "p_three_sets":       round(p_three_sets, 4),
            "exp_sets":           exp_sets,
            "most_likely_result": most_likely_result,
            # Games prediction
            "exp_total_games": exp_total_games,
            "p_over_22_5":     p_over_22_5,
            "p_under_22_5":    p_under_22_5,
            "model_version":   "v4.0-elo-stats",
        }

    async def bootstrap_training(self, log_queue: Optional[asyncio.Queue] = None) -> dict:
        """Bootstrap: generate synthetic tennis data with 28 features (no implied odds) and train models."""
        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log("Tennis Bootstrap: generando dataset sintetico...")
        np.random.seed(42)
        n = 2500
        surfaces = ["hard", "clay", "grass", "indoor"]
        X, y = [], []

        for _ in range(n):
            p1_elo      = np.random.normal(1600, 150)
            p2_elo      = np.random.normal(1600, 150)
            p1_surf_elo = p1_elo + np.random.normal(0, 50)
            p2_surf_elo = p2_elo + np.random.normal(0, 50)
            surf_code   = np.random.choice([0, 1, 2, 3])
            is_gs       = np.random.binomial(1, 0.25)

            p1_surf_pct = np.random.beta(5, 4)
            p2_surf_pct = np.random.beta(4, 5)
            p1_rank     = np.random.randint(1, 200)
            p2_rank     = np.random.randint(1, 200)
            p1_rec      = np.random.beta(5, 4)
            p2_rec      = np.random.beta(4, 5)
            p1_sets     = np.random.normal(1.5, 0.3)
            p2_sets     = np.random.normal(1.2, 0.3)
            p1_aces     = np.random.gamma(1.5, 0.5)
            p2_aces     = np.random.gamma(1.2, 0.5)
            p1_fat      = np.random.randint(0, 15)
            p2_fat      = np.random.randint(0, 15)
            h2h_p1      = np.random.randint(0, 15)
            h2h_tot     = h2h_p1 + np.random.randint(0, 15)
            elo_diff    = p1_elo - p2_elo
            selo_diff   = p1_surf_elo - p2_surf_elo

            # Label based on Elo surface — no implied odds
            p_win = elo_win_prob(p1_surf_elo, p2_surf_elo)
            # 0 = P1 wins straight, 1 = P1 wins in sets, 2 = P2 wins
            r = np.random.random()
            if r < p_win * 0.55:
                label = 0   # straight win P1
            elif r < p_win:
                label = 1   # tight win P1
            else:
                label = 2   # P2 wins

            # 28 features — no imp1/imp2
            X.append([
                p1_elo, p1_surf_elo, p1_surf_pct,
                p1_surf_pct * 0.9, p1_surf_pct * 0.7, p1_surf_pct * 0.8,
                p1_rec, p1_sets, p1_aces, float(p1_fat), float(p1_rank),
                p2_elo, p2_surf_elo, p2_surf_pct,
                p2_surf_pct * 0.9, p2_surf_pct * 0.7, p2_surf_pct * 0.8,
                p2_rec, p2_sets, p2_aces, float(p2_fat), float(p2_rank),
                float(h2h_p1), float(h2h_tot),
                elo_diff, selo_diff,
                float(surf_code), float(is_gs),
            ])
            y.append(label)

        X, y = np.array(X), np.array(y)
        scaler = StandardScaler()
        Xs = scaler.fit_transform(X)

        await log(f"Dataset: {n} partidos -- {sum(y==0)} Straight, {sum(y==1)} Tight, {sum(y==2)} Loss")

        await log("Entrenando XGBoost tennis...")
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

        await log("Entrenando LightGBM tennis...")
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

        await log(f"Modelos de tenis guardados en {WEIGHTS_DIR}")
        await log("Tennis Bootstrap completado")

        return {
            "status":     "success",
            "xgb_cv":    round(xgb_cv, 4),
            "lgbm_cv":   round(lgbm_cv, 4),
            "n_samples":  n,
            "n_features": len(FEATURE_NAMES),
        }


_tennis_predictor: Optional[TennisPredictor] = None


def get_tennis_predictor() -> TennisPredictor:
    global _tennis_predictor
    if _tennis_predictor is None:
        _tennis_predictor = TennisPredictor()
        _tennis_predictor.load_models()
    return _tennis_predictor
