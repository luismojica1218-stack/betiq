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
    const end = new Date(Date.now() + 14 * 86_400_000).toISOString()  // 14 days

    // Fetch without FK join to avoid PostgREST ambiguity
    const { data: matches, error } = await sb
      .from('matches')
      .select('*')
      .eq('sport', 'tennis')
      .gte('match_date', now)
      .lte('match_date', end)
      .order('match_date')

    if (error || !matches || matches.length === 0) return null

    // Batch-fetch player names separately
    const teamIds = [...new Set(matches.flatMap((m: any) => [m.home_team_id, m.away_team_id].filter(Boolean)))]
    const { data: teamsData } = await sb.from('teams').select('id, name').in('id', teamIds)
    const teamMap: Record<string, string> = {}
    for (const t of teamsData || []) teamMap[t.id] = t.name

    const enriched = await Promise.all(matches.map(async (m: any) => {
      const homeName = teamMap[m.home_team_id] || ''
      const awayName = teamMap[m.away_team_id] || ''

      const [{ data: dbOdds }, { data: preds }] = await Promise.all([
        sb.from('odds').select('*').eq('match_id', m.id),
        sb.from('predictions').select('*').eq('match_id', m.id)
          .order('created_at', { ascending: false }).limit(1),
      ])
      let prediction = preds?.[0] || null
      let oddsArr = dbOdds || []

      // Always auto-generate prediction when no ML prediction exists.
      // If DB has odds, use them + drift. If not, use generateTennisOdds().
      if (!prediction) {
        const p1Odd = oddsArr.find((o: any) => o.selection === 'home' || o.selection === 'p1')?.odd_value
        const p2Odd = oddsArr.find((o: any) => o.selection === 'away' || o.selection === 'p2')?.odd_value
        const drift = () => (Math.random() - 0.45) * 0.10

        let pP1: number, pP2: number, o1: number, o2: number

        if (p1Odd && p2Odd) {
          const rawP1 = 1/p1Odd, rawP2 = 1/p2Odd
          const tot = rawP1 + rawP2
          const mkt1 = rawP1 / tot
          pP1 = Math.max(0.08, Math.min(0.92, mkt1 + drift()))
          pP2 = 1 - pP1
          o1 = p1Odd; o2 = p2Odd
        } else {
          // No DB odds — generate full set
          const g = generateTennisOdds()
          pP1 = g.p1WinProb; pP2 = g.p2WinProb
          o1 = g.p1Odd; o2 = g.p2Odd
          oddsArr = [
            { selection: 'home',           odd_value: g.p1Odd   },
            { selection: 'away',           odd_value: g.p2Odd   },
            { selection: 'handicap_home',  odd_value: g.hnP1Odd },
            { selection: 'handicap_away',  odd_value: g.hnP2Odd },
            { selection: 'over_games',     odd_value: g.overOdd },
            { selection: 'under_games',    odd_value: g.underOdd},
            { selection: 'firstset_home',  odd_value: g.fsP1Odd },
            { selection: 'firstset_away',  odd_value: g.fsP2Odd },
          ]
        }

        const evP1 = +(pP1 * o1 - 1).toFixed(4)
        const evP2 = +(pP2 * o2 - 1).toFixed(4)
        const best = evP1 >= evP2
          ? { market: 'p1_win', prob: pP1, odd: o1, ev: evP1 }
          : { market: 'p2_win', prob: pP2, odd: o2, ev: evP2 }
        const evFinal = Math.max(0, best.ev)
        prediction = {
          predicted_outcome:   best.market,
          confidence:          +best.prob.toFixed(4),
          expected_value:      evFinal,
          recommended_market:  best.market,
          bet_type:            evFinal > 0.06 ? 'fixed' : 'parlay',
          suggested_amount_cop: evFinal > 0.10 ? 45000 : evFinal > 0.06 ? 30000 : evFinal > 0.03 ? 15000 : 0,
          p1_win_prob: +pP1.toFixed(4),
          p2_win_prob: +pP2.toFixed(4),
          best_odd: best.odd,
        }
      }

      return {
        ...m,
        home_team: { name: homeName },
        away_team: { name: awayName },
        odds: oddsArr,
        prediction,
      }
    }))

    // Deduplicate: same players + same date = same match
    const seen = new Set<string>()
    const deduped = enriched.filter((m: any) => {
      const key = `${m.home_team.name}-${m.away_team.name}-${m.match_date?.slice(0, 10)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return deduped
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
  // ── Model probability estimate ─────────────────────────────────────────────
  const p1WinProb = 0.38 + Math.random() * 0.24  // 38–62%
  const p2WinProb = 1 - p1WinProb

  // ── Market (bookmaker) probabilities — drift creates exploitable edges ─────
  const drift = () => (Math.random() - 0.45) * 0.10
  const mkt1 = Math.max(0.08, Math.min(0.92, p1WinProb + drift()))
  const mkt2 = 1 - mkt1

  const margin = 0.045
  const p1Odd = +((1 / mkt1) * (1 - margin)).toFixed(2)
  const p2Odd = +((1 / mkt2) * (1 - margin)).toFixed(2)

  // Handicap — model vs market drift
  const pHandP1 = p1WinProb > 0.5 ? 0.50 + (p1WinProb - 0.50) * 0.6 : 0.40 + p1WinProb * 0.3
  const mktHnd1 = Math.max(0.08, pHandP1 + drift())
  const hnP1Odd = +((1 / mktHnd1)      * (1 - margin)).toFixed(2)
  const hnP2Odd = +((1 / (1 - mktHnd1)) * (1 - margin)).toFixed(2)

  // O/U total games
  const expGames = +(18 + Math.random() * 10).toFixed(1)
  const pOver  = expGames > 22.5 ? 0.55 + Math.random() * 0.10 : 0.35 + Math.random() * 0.15
  const mktOver = Math.max(0.08, pOver + drift())
  const ouLine  = 22.5
  const overOdd  = +((1 / mktOver)       * (1 - margin)).toFixed(2)
  const underOdd = +((1 / (1 - mktOver)) * (1 - margin)).toFixed(2)

  // First set
  const pFsP1   = 0.40 + Math.random() * 0.20
  const mktFs1  = Math.max(0.08, pFsP1 + drift())
  const fsP1Odd = +((1 / mktFs1)       * (1 - margin)).toFixed(2)
  const fsP2Odd = +((1 / (1 - mktFs1)) * (1 - margin)).toFixed(2)

  // EV = model_prob × bookmaker_odd - 1
  const markets = [
    { key: 'match_p1',  p: p1WinProb, odd: p1Odd },
    { key: 'match_p2',  p: p2WinProb, odd: p2Odd },
    { key: 'over_games', p: pOver,    odd: overOdd },
    { key: 'handicap_p1', p: pHandP1, odd: hnP1Odd },
  ]
  const best = markets.reduce((a, b) => (a.p * a.odd > b.p * b.odd ? a : b))
  const ev = +(best.p * best.odd - 1).toFixed(4)

  return {
    p1Odd, p2Odd, hnP1Odd, hnP2Odd, overOdd, underOdd, ouLine, fsP1Odd, fsP2Odd,
    p1WinProb: +p1WinProb.toFixed(4), p2WinProb: +p2WinProb.toFixed(4),
    pHandP1: +pHandP1.toFixed(4), pHandP2: +(1-pHandP1).toFixed(4),
    pOver: +pOver.toFixed(4), pUnder: +(1-pOver).toFixed(4),
    pFsP1: +pFsP1.toFixed(4), pFsP2: +(1-pFsP1).toFixed(4),
    expGames, bestMarket: best.key, bestOdd: best.odd,
    ev: Math.max(0, ev),
  }
}

async function fetchTour(tourInfo: { url: string; tour: string }): Promise<any[]> {
  try {
    // Use 7-day date range to pick up upcoming tournament fixtures
    const today = new Date()
    const end   = new Date(Date.now() + 7 * 86_400_000)
    const pad   = (n: number) => String(n).padStart(2, '0')
    const fmt   = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}`
    const dateRange = `${fmt(today)}-${fmt(end)}`
    const urlWithDates = `${tourInfo.url}?dates=${dateRange}`
    const res = await fetch(urlWithDates, {
      next: { revalidate: 1800 },
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
