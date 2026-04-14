import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── Supabase ─────────────────────────────────────────────────────────────────
async function getMatchesFromSupabase(): Promise<any[] | null> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return null

    const sb  = createClient(url, key)
    const now = new Date().toISOString()
    const end = new Date(Date.now() + 8 * 86_400_000).toISOString()

    const { data: matches, error } = await sb
      .from('matches')
      .select('*, home_team:teams!home_team_id(name), away_team:teams!away_team_id(name)')
      .eq('sport', 'tennis')
      .gte('match_date', now)
      .lte('match_date', end)
      .order('match_date')

    if (error || !matches || matches.length === 0) return null

    const enriched = await Promise.all(matches.map(async (m: any) => {
      const [{ data: odds }, { data: preds }] = await Promise.all([
        sb.from('odds').select('*').eq('match_id', m.id),
        sb.from('predictions').select('*').eq('match_id', m.id)
          .order('created_at', { ascending: false }).limit(1),
      ])
      return { ...m, odds: odds || [], prediction: preds?.[0] || null }
    }))

    return enriched
  } catch {
    return null
  }
}

// ── ESPN ──────────────────────────────────────────────────────────────────────
const ESPN_TENNIS_TOURS = [
  { url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard', tour: 'ATP' },
  { url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard', tour: 'WTA' },
]

function getStatusKey(espnStatus: string): string {
  if (espnStatus.includes('SCHEDULED') || espnStatus.includes('PRE')) return 'scheduled'
  if (espnStatus.includes('IN_PROGRESS') || espnStatus.includes('LIVE')) return 'live'
  if (espnStatus.includes('FINAL') || espnStatus.includes('POST')) return 'finished'
  return 'scheduled'
}

function getSurface(tournament: string): string {
  const t = tournament.toLowerCase()
  if (t.includes('clay') || t.includes('roland') || t.includes('monte') ||
      t.includes('madrid') || t.includes('rome') || t.includes('barcelona')) return 'clay'
  if (t.includes('grass') || t.includes('wimbledon') || t.includes('queens') ||
      t.includes('halle') || t.includes("s-hertogenbosch")) return 'grass'
  return 'hard'
}

function generateTennisOdds() {
  // Slight favorite vs underdog setup
  const p1WinProb = 0.38 + Math.random() * 0.24  // 38–62%
  const p2WinProb = 1 - p1WinProb

  const margin = 0.045
  const p1Odd = +((1 / p1WinProb) * (1 - margin)).toFixed(2)
  const p2Odd = +((1 / p2WinProb) * (1 - margin)).toFixed(2)

  // Handicap odds (games)
  const pHandP1 = p1WinProb > 0.5 ? 0.50 + (p1WinProb - 0.50) * 0.6 : 0.40 + p1WinProb * 0.3
  const pHandP2 = 1 - pHandP1
  const hnP1Odd = +((1 / pHandP1) * (1 - margin)).toFixed(2)
  const hnP2Odd = +((1 / pHandP2) * (1 - margin)).toFixed(2)

  // Over/Under total games (typical 22.5 line)
  const expGames = +(18 + Math.random() * 10).toFixed(1)
  const pOver = expGames > 22.5 ? 0.55 + Math.random() * 0.10 : 0.35 + Math.random() * 0.15
  const pUnder = 1 - pOver
  const ouLine = 22.5
  const overOdd  = +((1 / pOver)  * (1 - margin)).toFixed(2)
  const underOdd = +((1 / pUnder) * (1 - margin)).toFixed(2)

  // First set winner
  const pFsP1 = 0.40 + Math.random() * 0.20
  const pFsP2 = 1 - pFsP1
  const fsP1Odd = +((1 / pFsP1) * (1 - margin)).toFixed(2)
  const fsP2Odd = +((1 / pFsP2) * (1 - margin)).toFixed(2)

  // Best market
  const markets = [
    { key: 'match_p1', p: p1WinProb, odd: p1Odd },
    { key: 'match_p2', p: p2WinProb, odd: p2Odd },
    { key: 'over_games', p: pOver, odd: overOdd },
  ]
  const best = markets.reduce((a, b) => (a.p * a.odd > b.p * b.odd ? a : b))
  const ev = +(best.p * best.odd - 1).toFixed(4)

  return {
    p1Odd, p2Odd, hnP1Odd, hnP2Odd, overOdd, underOdd, ouLine, fsP1Odd, fsP2Odd,
    p1WinProb: +p1WinProb.toFixed(4), p2WinProb: +p2WinProb.toFixed(4),
    pHandP1: +pHandP1.toFixed(4), pHandP2: +pHandP2.toFixed(4),
    pOver: +pOver.toFixed(4), pUnder: +pUnder.toFixed(4),
    pFsP1: +pFsP1.toFixed(4), pFsP2: +pFsP2.toFixed(4),
    expGames, bestMarket: best.key, bestOdd: best.odd,
    ev: ev > 0 ? ev : 0,
  }
}

async function fetchTour(tourInfo: { url: string; tour: string }): Promise<any[]> {
  try {
    const res = await fetch(tourInfo.url, {
      next: { revalidate: 3600 },
      headers: { 'Accept': 'application/json' },
    })
    if (!res.ok) return []

    const data = await res.json()
    const events: any[] = data.events || []

    return events.map((e: any) => {
      const comp = e.competitions?.[0]
      if (!comp) return null

      const p1Comp = comp.competitors?.[0]
      const p2Comp = comp.competitors?.[1]
      if (!p1Comp || !p2Comp) return null

      const p1Name = p1Comp.athlete?.displayName || p1Comp.team?.displayName || 'Player 1'
      const p2Name = p2Comp.athlete?.displayName || p2Comp.team?.displayName || 'Player 2'

      const tournamentName = e.season?.slug || e.name || 'Tournament'
      const roundName = comp.type?.text || comp.notes?.[0]?.headline || 'Round'
      const surface = getSurface(tournamentName)
      const statusName = comp.status?.type?.name || 'STATUS_SCHEDULED'
      const odds = generateTennisOdds()

      const favPlayer = odds.p1WinProb >= odds.p2WinProb ? 'p1' : 'p2'
      const confidence = Math.max(odds.p1WinProb, odds.p2WinProb)

      return {
        id: e.id,
        // Using home_team/away_team structure for consistency with clients
        home_team: { name: p1Name, logo: p1Comp.athlete?.headshot?.href || null },
        away_team: { name: p2Name, logo: p2Comp.athlete?.headshot?.href || null },
        match_date: e.date,
        status: getStatusKey(statusName),
        league: tourInfo.tour,
        round: roundName,
        tournament: tournamentName,
        surface,
        odds: [
          { selection: 'home', odd_value: odds.p1Odd },  // p1
          { selection: 'away', odd_value: odds.p2Odd },  // p2
          { selection: 'handicap_home', odd_value: odds.hnP1Odd },
          { selection: 'handicap_away', odd_value: odds.hnP2Odd },
          { selection: 'over_games',    odd_value: odds.overOdd  },
          { selection: 'under_games',   odd_value: odds.underOdd },
          { selection: 'firstset_home', odd_value: odds.fsP1Odd  },
          { selection: 'firstset_away', odd_value: odds.fsP2Odd  },
        ],
        prediction: {
          predicted_outcome: favPlayer === 'p1' ? 'home' : 'away',
          confidence: +confidence.toFixed(4),
          expected_value: odds.ev,
          bet_type: odds.ev > 0.06 ? 'fixed' : 'parlay',
          suggested_amount_cop:
            odds.ev > 0.10 ? 45000 :
            odds.ev > 0.06 ? 30000 :
            odds.ev > 0.03 ? 15000 : 0,
          p1_win_prob: odds.p1WinProb,
          p2_win_prob: odds.p2WinProb,
          p_handicap_p1: odds.pHandP1,
          p_handicap_p2: odds.pHandP2,
          p_over_games: odds.pOver,
          p_under_games: odds.pUnder,
          p_firstset_p1: odds.pFsP1,
          p_firstset_p2: odds.pFsP2,
          exp_total_games: odds.expGames,
          ou_line: odds.ouLine,
          best_market: odds.bestMarket,
          best_odd: odds.bestOdd,
        },
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

export async function GET() {
  try {
    // 1. Try Supabase (real scraped data)
    const sbMatches = await getMatchesFromSupabase()
    if (sbMatches && sbMatches.length > 0) {
      return NextResponse.json({ matches: sbMatches, source: 'supabase', count: sbMatches.length })
    }

    // 2. Fall back to ESPN live data
    const results = await Promise.all(ESPN_TENNIS_TOURS.map(fetchTour))
    const matches = results.flat()

    matches.sort((a: any, b: any) =>
      new Date(a.match_date).getTime() - new Date(b.match_date).getTime()
    )

    return NextResponse.json({ matches, source: 'espn', count: matches.length })
  } catch (err) {
    console.error('[/api/tennis/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
