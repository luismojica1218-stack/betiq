"""
StatIQ — NBA ML Model
Ensemble: XGBClassifier (60%) + LGBMClassifier (40%)
Output: Rich statistical insights — win probabilities, scoring projections, pace, blowout risk
"""
import asyncio
import logging
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

XGB_PATH    = WEIGHTS_DIR / "nba_xgb.pkl"
LGBM_PATH   = WEIGHTS_DIR / "nba_lgbm.pkl"
SCALER_PATH = WEIGHTS_DIR / "nba_scaler.pkl"
FEATURES_PATH = WEIGHTS_DIR / "nba_features.pkl"

# ---- Feature names ----------------------------------------------------------
# 23 features — odds-derived features intentionally excluded
FEATURE_NAMES = [
    "home_pts_per_game", "home_opp_pts_per_game", "home_fg_pct",
    "home_three_p_pct", "home_reb_per_game", "home_ast_per_game",
    "home_last5_wins_pct", "home_home_wins_pct",
    "home_days_rest", "home_is_back_to_back",
    "away_pts_per_game", "away_opp_pts_per_game", "away_fg_pct",
    "away_three_p_pct", "away_reb_per_game", "away_ast_per_game",
    "away_last5_wins_pct", "away_away_wins_pct",
    "away_days_rest", "away_is_back_to_back",
    "h2h_home_win_pct",
    "net_rating_diff",   # home net_rating - away net_rating
    "form_diff",         # home last5 - away last5
]


def _winner_confidence(prob: float) -> str:
    """Map win probability to confidence label."""
    if prob > CONFIDENCE_HIGH:
        return "alta"
    if prob > CONFIDENCE_MED:
        return "media"
    return "baja"


def _points_range(exp_total: float) -> dict:
    """
    Approximate probability buckets for total points using linear threshold logic.
    Std of total points across NBA games ~ 12 pts.
    """
    p_under_210 = max(0.0, min(1.0, (210 - exp_total) / 24 + 0.5))
    p_over_240  = max(0.0, min(1.0, (exp_total - 240) / 24 + 0.5))
    # middle two buckets split the remaining probability
    remaining   = max(0.0, 1 - p_under_210 - p_over_240)
    p_210_225   = round(remaining * 0.55, 4)
    p_225_240   = round(remaining * 0.45, 4)
    return {
        "under_210": round(p_under_210, 4),
        "210_225":   p_210_225,
        "225_240":   p_225_240,
        "over_240":  round(p_over_240, 4),
    }


def _pace_label(avg_ppg: float) -> str:
    """Classify game pace based on average points per game."""
    if avg_ppg > 116:
        return "rapido"
    if avg_ppg > 110:
        return "moderado"
    return "lento"


class NBAPredictor:
    """
    Loads pre-trained XGB + LGBM models and predicts NBA game outcomes.
    Returns rich statistical projections — no odds, no EV, no Kelly.
    """

    def __init__(self):
        self.xgb_model: Optional[XGBClassifier]  = None
        self.lgbm_model: Optional[LGBMClassifier] = None
        self.scaler: Optional[StandardScaler]     = None
        self._loaded = False

    def load_models(self) -> bool:
        """Load serialized models from disk. Returns True if successful."""
        try:
            if XGB_PATH.exists() and LGBM_PATH.exists():
                xgb  = joblib.load(XGB_PATH)
                lgbm = joblib.load(LGBM_PATH)
                # Validate feature dimension matches current FEATURE_NAMES
                expected_n = len(FEATURE_NAMES)
                n_feats = getattr(xgb, "n_features_in_", None)
                if n_feats is not None and n_feats != expected_n:
                    logger.warning(
                        f"NBA model weights have {n_feats} features but code expects "
                        f"{expected_n}. Discarding stale weights — re-run /train."
                    )
                    return False
                self.xgb_model  = xgb
                self.lgbm_model = lgbm
                self.scaler     = joblib.load(SCALER_PATH) if SCALER_PATH.exists() else None
                self._loaded    = True
                logger.info("NBA models loaded from disk")
                return True
            else:
                logger.warning("NBA model weights not found — bootstrap training required")
                return False
        except Exception as e:
            logger.error(f"Error loading NBA models: {e}")
            return False

    def _build_features(self, match_data: dict) -> np.ndarray:
        """Build a 23-feature vector from match data dict (no odds)."""
        h   = match_data.get("home_stats", {})
        a   = match_data.get("away_stats", {})
        h2h = match_data.get("h2h", {})

        h_pts = h.get("pts_per_game", 110.0)
        a_pts = a.get("pts_per_game", 110.0)
        h_opp = h.get("opp_pts_per_game", 110.0)
        a_opp = a.get("opp_pts_per_game", 110.0)
        h_l5  = h.get("last5_wins_pct", 0.5)
        a_l5  = a.get("last5_wins_pct", 0.5)

        feats = [
            h_pts,
            h_opp,
            h.get("fg_pct", 0.46),
            h.get("three_p_pct", 0.36),
            h.get("reb_per_game", 44.0),
            h.get("ast_per_game", 25.0),
            h_l5,
            h.get("home_wins_pct", 0.55),
            float(h.get("days_rest", 2)),
            float(h.get("is_back_to_back", 0)),
            a_pts,
            a_opp,
            a.get("fg_pct", 0.46),
            a.get("three_p_pct", 0.36),
            a.get("reb_per_game", 44.0),
            a.get("ast_per_game", 25.0),
            a_l5,
            a.get("away_wins_pct", 0.45),
            float(a.get("days_rest", 2)),
            float(a.get("is_back_to_back", 0)),
            h2h.get("h2h_home_win_pct", 0.5),
            (h_pts - h_opp) - (a_pts - a_opp),  # net_rating_diff
            h_l5 - a_l5,                          # form_diff
        ]
        return np.array(feats, dtype=float).reshape(1, -1)

    def predict(self, match_data: dict) -> dict:
        """
        Predict outcome and generate statistical projections.
        match_data keys: home_stats, away_stats, h2h
        No odds, no EV, no Kelly.
        """
        h   = match_data.get("home_stats", {})
        a   = match_data.get("away_stats", {})

        feats = self._build_features(match_data)

        if self._loaded and self.xgb_model and self.lgbm_model:
            feats_scaled = self.scaler.transform(feats) if self.scaler else feats
            prob_xgb  = self.xgb_model.predict_proba(feats_scaled)[0][1]
            prob_lgbm = self.lgbm_model.predict_proba(feats_scaled)[0][1]
            home_win_prob = float(0.6 * prob_xgb + 0.4 * prob_lgbm)
        else:
            # Stats-based heuristic fallback (no odds)
            h_pts = h.get("pts_per_game", 110.0)
            a_pts = a.get("pts_per_game", 110.0)
            h_opp = h.get("opp_pts_per_game", 110.0)
            a_opp = a.get("opp_pts_per_game", 110.0)
            net_h = h_pts - h_opp
            net_a = a_pts - a_opp
            l5_h  = h.get("last5_wins_pct", 0.5)
            l5_a  = a.get("last5_wins_pct", 0.5)
            # Logistic-style: home court ~3pt advantage
            score = (net_h - net_a) * 0.03 + (l5_h - l5_a) * 0.6 + 0.08
            home_win_prob = float(1 / (1 + np.exp(-score)))
            home_win_prob = min(max(home_win_prob, 0.10), 0.90)

        away_win_prob = 1.0 - home_win_prob

        # Predicted winner and confidence
        predicted_winner  = "home" if home_win_prob >= 0.5 else "away"
        winner_confidence = _winner_confidence(max(home_win_prob, away_win_prob))

        # Scoring projections
        h_pts = h.get("pts_per_game", 110.0)
        a_pts = a.get("pts_per_game", 110.0)
        h_opp = h.get("opp_pts_per_game", 110.0)
        a_opp = a.get("opp_pts_per_game", 110.0)

        # Expected points for each team: average of own offensive output and opponent defensive yield
        home_proj_pts = round((h_pts + a_opp) / 2, 1)
        away_proj_pts = round((a_pts + h_opp) / 2, 1)
        exp_total_points = round(home_proj_pts + away_proj_pts, 1)

        top_scoring_team = "home" if home_proj_pts >= away_proj_pts else "away"

        # Points range
        points_range = _points_range(exp_total_points)

        # Pace classification based on average scoring
        avg_ppg = (h_pts + a_pts) / 2
        pace = _pace_label(avg_ppg)

        # Blowout probability: P(margin > 15 pts)
        blowout_probability = round(min(0.45, abs(home_win_prob - 0.5) * 0.85), 4)

        # Rebound and assist projections
        home_proj_reb = round(h.get("reb_per_game", 44.0), 1)
        away_proj_reb = round(a.get("reb_per_game", 44.0), 1)
        home_proj_ast = round(h.get("ast_per_game", 25.0), 1)
        away_proj_ast = round(a.get("ast_per_game", 25.0), 1)

        return {
            "home_win_prob":    round(home_win_prob, 4),
            "away_win_prob":    round(away_win_prob, 4),
            "predicted_winner": predicted_winner,
            "winner_confidence": winner_confidence,
            # Scoring insights
            "exp_total_points": exp_total_points,
            "points_range":     points_range,
            "top_scoring_team": top_scoring_team,
            # Team stat projections
            "home_proj_pts": home_proj_pts,
            "away_proj_pts": away_proj_pts,
            "home_proj_reb": home_proj_reb,
            "away_proj_reb": away_proj_reb,
            "home_proj_ast": home_proj_ast,
            "away_proj_ast": away_proj_ast,
            # Game tempo and margin
            "pace":                 pace,
            "blowout_probability":  blowout_probability,
            "model_version":        "v2.0-stats",
        }

    # ---- Bootstrap Training -------------------------------------------------

    async def bootstrap_training(self, log_queue: Optional[asyncio.Queue] = None) -> dict:
        """Generate synthetic training data (23 features, no odds) and train XGB + LGBM."""
        async def log(msg: str):
            logger.info(msg)
            if log_queue:
                await log_queue.put({"type": "log", "message": msg})

        await log("Iniciando entrenamiento bootstrap de NBA...")
        np.random.seed(42)
        n_samples = 2000
        X_list = []
        y_list = []

        for _ in range(n_samples):
            h_pts  = np.random.normal(113, 6)
            a_pts  = np.random.normal(113, 6)
            h_opp  = np.random.normal(113, 6)
            a_opp  = np.random.normal(113, 6)
            h_fg   = np.random.normal(0.462, 0.02)
            a_fg   = np.random.normal(0.462, 0.02)
            h_3p   = np.random.normal(0.362, 0.02)
            a_3p   = np.random.normal(0.362, 0.02)
            h_reb  = np.random.normal(44.5, 2)
            a_reb  = np.random.normal(44.5, 2)
            h_ast  = np.random.normal(25.2, 2)
            a_ast  = np.random.normal(25.2, 2)
            h_l5   = np.random.uniform(0.2, 0.8)
            a_l5   = np.random.uniform(0.2, 0.8)
            h_hw   = np.random.uniform(0.4, 0.75)
            a_aw   = np.random.uniform(0.35, 0.65)
            h_rest = np.random.choice([1, 2, 3, 4])
            a_rest = np.random.choice([1, 2, 3, 4])
            h_b2b  = float(h_rest == 1)
            a_b2b  = float(a_rest == 1)
            h2h    = np.random.uniform(0.3, 0.7)
            net_h  = h_pts - h_opp
            net_a  = a_pts - a_opp

            # Label based purely on team quality — no odds involved
            strength = (
                (net_h - net_a) * 0.4 +
                (h_l5 - a_l5) * 20 +
                (h_hw - 0.5) * 15 +
                (h2h - 0.5) * 10 +
                3  # home court advantage
            )
            prob_true = 1 / (1 + np.exp(-strength / 15))
            label = int(np.random.random() < prob_true)

            feats = [
                h_pts, h_opp, h_fg, h_3p, h_reb, h_ast, h_l5, h_hw, h_rest, h_b2b,
                a_pts, a_opp, a_fg, a_3p, a_reb, a_ast, a_l5, a_aw, a_rest, a_b2b,
                h2h, net_h - net_a, h_l5 - a_l5,
            ]
            X_list.append(feats)
            y_list.append(label)

        X = np.array(X_list)
        y = np.array(y_list)

        await log(f"Dataset generado: {n_samples} partidos historicos simulados")

        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        await log("Entrenando XGBClassifier...")
        xgb = XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            use_label_encoder=False, eval_metric="logloss",
            random_state=42, verbosity=0,
        )
        xgb.fit(X_scaled, y)
        xgb_cv = cross_val_score(xgb, X_scaled, y, cv=5, scoring="accuracy").mean()
        await log(f"XGBoost training done -- CV accuracy: {xgb_cv:.3f}")

        await log("Entrenando LGBMClassifier...")
        lgbm = LGBMClassifier(
            n_estimators=200, num_leaves=31, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            random_state=42, verbose=-1,
        )
        lgbm.fit(X_scaled, y)
        lgbm_cv = cross_val_score(lgbm, X_scaled, y, cv=5, scoring="accuracy").mean()
        await log(f"LightGBM training done -- CV accuracy: {lgbm_cv:.3f}")

        joblib.dump(xgb,          XGB_PATH)
        joblib.dump(lgbm,         LGBM_PATH)
        joblib.dump(scaler,       SCALER_PATH)
        joblib.dump(FEATURE_NAMES, FEATURES_PATH)

        self.xgb_model  = xgb
        self.lgbm_model = lgbm
        self.scaler     = scaler
        self._loaded    = True

        await log(f"Modelos guardados en {WEIGHTS_DIR}")
        await log("Bootstrap training completado -- StatIQ NBA listo para predecir")

        return {
            "status":        "success",
            "xgb_cv":        round(xgb_cv, 4),
            "lgbm_cv":       round(lgbm_cv, 4),
            "n_samples":     n_samples,
            "n_features":    len(FEATURE_NAMES),
            "feature_names": FEATURE_NAMES,
        }


# ---- Singleton for use in FastAPI lifespan ----------------------------------
_predictor: Optional[NBAPredictor] = None


def get_predictor() -> NBAPredictor:
    global _predictor
    if _predictor is None:
        _predictor = NBAPredictor()
        _predictor.load_models()
    return _predictor
