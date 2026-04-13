-- ============================================================
-- BetIQ — Migración inicial del schema de Supabase
-- 001_initial_schema.sql
-- Abril 2026
-- ============================================================

-- 1. USERS (extiende auth.users)
CREATE TABLE IF NOT EXISTS public.users (
  id              uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  weekly_budget_cop integer DEFAULT 200000,
  strategy        text DEFAULT 'aggressive'
    CHECK (strategy IN ('aggressive', 'moderate', 'conservative')),
  fixed_pct       integer DEFAULT 50
    CHECK (fixed_pct BETWEEN 0 AND 100),
  parlay_pct      integer DEFAULT 50
    CHECK (parlay_pct BETWEEN 0 AND 100),
  created_at      timestamptz DEFAULT now()
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own" ON public.users
  FOR ALL USING (auth.uid() = id);

-- 2. TEAMS
CREATE TABLE IF NOT EXISTS public.teams (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name              text NOT NULL,
  sport             text NOT NULL CHECK (sport IN ('nba', 'football', 'tennis')),
  league            text,
  country           text,
  logo_url          text,
  external_id       text,
  bias_adjustment   jsonb DEFAULT '{}',
  created_at        timestamptz DEFAULT now()
);
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "teams_readable" ON public.teams FOR SELECT USING (true);
CREATE POLICY "teams_service_write" ON public.teams FOR INSERT WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "teams_service_update" ON public.teams FOR UPDATE USING (auth.role() = 'service_role');

-- 3. MATCHES
CREATE TABLE IF NOT EXISTS public.matches (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sport         text NOT NULL CHECK (sport IN ('nba', 'football', 'tennis')),
  league        text,
  season        text,
  round         text,
  home_team_id  uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  away_team_id  uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  match_date    timestamptz NOT NULL,
  status        text DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'live', 'finished', 'cancelled')),
  home_score    integer,
  away_score    integer,
  scraped_at    timestamptz,
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "matches_readable" ON public.matches FOR SELECT USING (true);
CREATE POLICY "matches_service_write" ON public.matches FOR INSERT WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "matches_service_update" ON public.matches FOR UPDATE USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_matches_sport_date ON public.matches (sport, match_date);
CREATE INDEX IF NOT EXISTS idx_matches_status ON public.matches (status);

-- 4. TEAM_STATS
CREATE TABLE IF NOT EXISTS public.team_stats (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  match_id    uuid REFERENCES public.matches(id) ON DELETE CASCADE,
  team_id     uuid REFERENCES public.teams(id) ON DELETE CASCADE,
  stats_json  jsonb NOT NULL DEFAULT '{}',
  scraped_at  timestamptz DEFAULT now(),
  source_url  text
);
ALTER TABLE public.team_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "team_stats_readable" ON public.team_stats FOR SELECT USING (true);
CREATE POLICY "team_stats_service_write" ON public.team_stats FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- 5. ODDS
CREATE TABLE IF NOT EXISTS public.odds (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  match_id    uuid REFERENCES public.matches(id) ON DELETE CASCADE,
  bookmaker   text NOT NULL,
  market      text NOT NULL,
  selection   text,
  odd_value   decimal(6,3) NOT NULL,
  scraped_at  timestamptz DEFAULT now()
);
ALTER TABLE public.odds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "odds_readable" ON public.odds FOR SELECT USING (true);
CREATE POLICY "odds_service_write" ON public.odds FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_odds_match_bookmaker ON public.odds (match_id, bookmaker);

-- 6. PREDICTIONS
CREATE TABLE IF NOT EXISTS public.predictions (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  match_id              uuid REFERENCES public.matches(id) ON DELETE CASCADE,
  model_version         text DEFAULT 'v1.0',
  predicted_outcome     text,
  confidence            decimal(5,4),
  expected_value        decimal(8,4),
  recommended_market    text,
  bet_type              text CHECK (bet_type IN ('fixed', 'parlay')),
  suggested_amount_cop  integer,
  features_used         jsonb DEFAULT '{}',
  created_at            timestamptz DEFAULT now()
);
ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "predictions_readable" ON public.predictions FOR SELECT USING (true);
CREATE POLICY "predictions_service_write" ON public.predictions FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_predictions_match ON public.predictions (match_id);

-- 7. BETS
CREATE TABLE IF NOT EXISTS public.bets (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               uuid REFERENCES public.users(id) ON DELETE CASCADE,
  prediction_id         uuid REFERENCES public.predictions(id) ON DELETE SET NULL,
  match_id              uuid REFERENCES public.matches(id) ON DELETE SET NULL,
  bet_type              text,
  bookmaker             text,
  market                text,
  selection             text,
  odd_at_bet            decimal(6,3),
  amount_cop            integer NOT NULL,
  potential_win_cop     integer GENERATED ALWAYS AS (ROUND(amount_cop * odd_at_bet)) STORED,
  status                text DEFAULT 'pending'
    CHECK (status IN ('pending', 'won', 'lost', 'void')),
  result_confirmed_at   timestamptz,
  profit_loss_cop       integer,
  loss_reason           text,
  bet_week              date,
  created_at            timestamptz DEFAULT now()
);
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bets_own"        ON public.bets FOR ALL    USING (auth.uid() = user_id);
CREATE POLICY "bets_own_insert" ON public.bets FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_bets_user_week ON public.bets (user_id, bet_week);

-- 8. PARLAY_BETS
CREATE TABLE IF NOT EXISTS public.parlay_bets (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           uuid REFERENCES public.users(id) ON DELETE CASCADE,
  bookmaker         text,
  total_amount_cop  integer,
  combined_odd      decimal(8,3),
  potential_win_cop integer,
  status            text DEFAULT 'pending'
    CHECK (status IN ('pending', 'won', 'lost', 'void')),
  bet_legs          jsonb NOT NULL DEFAULT '[]',
  bet_week          date,
  created_at        timestamptz DEFAULT now()
);
ALTER TABLE public.parlay_bets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "parlay_bets_own"        ON public.parlay_bets FOR ALL    USING (auth.uid() = user_id);
CREATE POLICY "parlay_bets_own_insert" ON public.parlay_bets FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_parlay_bets_user_week ON public.parlay_bets (user_id, bet_week);

-- 9. LOSS_ANALYSIS
CREATE TABLE IF NOT EXISTS public.loss_analysis (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  bet_id            uuid REFERENCES public.bets(id) ON DELETE CASCADE,
  team_id           uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  reason_category   text CHECK (reason_category IN (
    'variance',
    'model_overconfidence',
    'odds_value_poor',
    'recent_form_ignored',
    'injury_key_player'
  )),
  description       text,
  weight_adjustment jsonb DEFAULT '{}',
  created_at        timestamptz DEFAULT now()
);
ALTER TABLE public.loss_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "loss_analysis_readable" ON public.loss_analysis
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.bets b WHERE b.id = loss_analysis.bet_id AND b.user_id = auth.uid())
  );
CREATE POLICY "loss_analysis_service_write" ON public.loss_analysis
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- 10. TRIGGER — Crear usuario en tabla pública cuando se registra en auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, weekly_budget_cop, strategy, fixed_pct, parlay_pct)
  VALUES (NEW.id, 200000, 'aggressive', 50, 50)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 11. VISTA — Resumen semanal por usuario
CREATE OR REPLACE VIEW public.weekly_summary AS
SELECT
  b.user_id,
  b.bet_week,
  COUNT(*)                                            AS total_apuestas,
  SUM(b.amount_cop)                                   AS total_apostado,
  SUM(CASE WHEN b.status = 'won' THEN b.potential_win_cop ELSE 0 END) AS total_ganado,
  SUM(COALESCE(b.profit_loss_cop, 0))                 AS profit_loss_neto,
  ROUND(
    100.0 * SUM(CASE WHEN b.status = 'won' THEN 1 ELSE 0 END)::numeric
    / NULLIF(COUNT(CASE WHEN b.status IN ('won','lost') THEN 1 END), 0),
    1
  )                                                   AS tasa_exito_pct,
  ROUND(
    100.0 * SUM(COALESCE(b.profit_loss_cop, 0))::numeric
    / NULLIF(SUM(b.amount_cop), 0),
    2
  )                                                   AS roi_pct
FROM public.bets b
WHERE b.status IN ('won', 'lost', 'void', 'pending')
GROUP BY b.user_id, b.bet_week;

-- Permitir leer la vista sólo con tus propios user_id
CREATE OR REPLACE FUNCTION public.weekly_summary_security()
RETURNS SETOF public.weekly_summary AS $$
  SELECT * FROM public.weekly_summary WHERE user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER;
