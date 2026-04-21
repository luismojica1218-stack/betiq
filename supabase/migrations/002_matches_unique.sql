-- Prevent duplicate matches: same teams, same day, same sport
-- Uses a unique index on expression so it works with timestamptz
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_no_duplicates
  ON public.matches (home_team_id, away_team_id, date_trunc('day', match_date), sport)
  WHERE home_team_id IS NOT NULL AND away_team_id IS NOT NULL;

-- Also prevent duplicate team_stats for the same team/source/day
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_stats_no_duplicates
  ON public.team_stats (team_id, source_url, date_trunc('day', scraped_at))
  WHERE team_id IS NOT NULL;
