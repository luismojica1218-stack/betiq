-- Add sport and notes columns to bets table
-- sport: identifies which module the bet came from (nba, football, tennis)
-- notes: stores the match display name (e.g. "Lakers vs Celtics")
ALTER TABLE public.bets ADD COLUMN IF NOT EXISTS sport text
  CHECK (sport IN ('nba', 'football', 'tennis'));
ALTER TABLE public.bets ADD COLUMN IF NOT EXISTS notes text;
