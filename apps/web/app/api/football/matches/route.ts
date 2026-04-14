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
      .eq('sport', 'football')
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
      let prediction = preds?.[0] || null

      // Auto-generate prediction from odds when no ML prediction exists yet
      if (!prediction && odds && odds.length >= 2) {
        const homeOdd = odds.find((o: any) => o.selection === 'home')?.odd_value
        const drawOdd = odds.find((o: any) => o.selection === 'draw')?.odd_value
        const awayOdd = odds.find((o: any) => o.selection === 'away')?.odd_value
        if (homeOdd && awayOdd) {
          const dOdd = drawOdd || 3.2
          const total = 1/homeOdd + 1/dOdd + 1/awayOdd
          const pHome = (1/homeOdd) / total
          const pDraw = (1/dOdd) / total
          const pAway = (1/awayOdd) / total
          const outcomes = [
            { market: 'home', prob: pHome, odd: homeOdd },
            { market: 'draw', prob: pDraw, odd: dOdd },
            { market: 'away', prob: pAway, odd: awayOdd },
          ]
          const best = outcomes.reduce((a, b) => a.prob * a.odd > b.prob * b.odd ? a : b)
          const ev = Math.max(0, +(best.prob * best.odd - 1).toFixed(4))
          prediction = {
            predicted_outcome: best.market,
            confidence: +best.prob.toFixed(4),
            expected_value: ev,
            recommended_market: best.market,
            bet_type: ev > 0.06 ? 'fixed' : 'parlay',
            suggested_amount_cop: ev > 0.08 ? 40000 : ev > 0.05 ? 25000 : ev > 0.02 ? 12000 : 0,
          }
        }
      }

      return { ...m, odds: odds || [], prediction }
    }))

    return enriched
  } catch {
    return null
  }
}

// ── ESPN Soccer league keys → display names
const LEAGUES: Array<{ key: string; name: string; slug: string }> = [
  { key: 'uefa.champions',  name: 'Champions League', slug: 'champions-league' },
  { key: 'eng.1',           name: 'Premier League',   slug: 'premier-league'  },
  { key: 'esp.1',           name: 'La Liga',           slug: 'la-liga'         },
  { key: 'ger.1',           name: 'Bundesliga',        slug: 'bundesliga'      },
  { key: 'ita.1',           name: 'Serie A',           slug: 'serie-a'         },
  { key: 'fra.1',           name: 'Ligue 1',           slug: 'ligue-1'         },
  { key: 'conmebol.libertadores', name: 'Libertadores', slug: 'libertadores'  },
]

function getStatusKey(espnStatus: string): string {
  if (espnStatus.includes('SCHEDULED') || espnStatus.includes('PRE')) return 'scheduled'
  if (espnStatus.includes('IN_PROGRESS') || espnStatus.includes('LIVE')) return 'live'
  if (espnStatus.includes('FINAL') || espnStatus.includes('POST')) return 'finished'
  return 'scheduled'
}

function generateFootballOdds() {
  // Typical European football distribution: home ~45%, draw ~25%, away ~30%
  // Add variance for each game
  const pHome = 0.35 + Math.random() * 0.25  // 35–60%
  const pDraw = 0.15 + Math.random() * 0.15  // 15–30%
  const pAway = Math.max(0.10, 1 - pHome - pDraw)

  const margin = 0.05 // 5% bookmaker margin
  const homeOdd = +((1 / pHome) * (1 - margin)).toFixed(2)
  const drawOdd = +((1 / pDraw) * (1 - margin)).toFixed(2)
  const awayOdd = +((1 / pAway) * (1 - margin)).toFixed(2)

  // Derived markets
  const pOver = 0.45 + Math.random() * 0.20  // 45–65% over 2.5
  const pBtts  = 0.40 + Math.random() * 0.25  // 40–65% BTTS

  const overOdd  = +((1 / pOver)  * (1 - margin)).toFixed(2)
  const underOdd = +((1 / (1 - pOver)) * (1 - margin)).toFixed(2)
  const bttsYes  = +((1 / pBtts)  * (1 - margin)).toFixed(2)
  const bttsNo   = +((1 / (1 - pBtts)) * (1 - margin)).toFixed(2)

  // Best market: highest EV among 1x2 + O/U + BTTS
  const markets = [
    { key: 'home',    p: pHome, odd: homeOdd },
    { key: 'draw',    p: pDraw, odd: drawOdd },
    { key: 'away',    p: pAway, odd: awayOdd },
    { key: 'over_2.5', p: pOver, odd: overOdd },
    { key: 'btts_yes', p: pBtts, odd: bttsYes },
  ]
  const best = markets.reduce((a, b) => (a.p * a.odd > b.p * b.odd ? a : b))
  const ev = +(best.p * best.odd - 1).toFixed(4)

  return {
    homeOdd, drawOdd, awayOdd,
    overOdd, underOdd, bttsYes, bttsNo,
    pHome, pDraw, pAway, pOver, pBtts,
    bestMarket: best.key as 'home'|'draw'|'away'|'over_2.5'|'btts_yes',
    bestOdd: best.odd,
    ev: ev > 0 ? ev : 0,
    expGoals: +(1.8 + Math.random() * 1.5).toFixed(1),
  }
}

async function fetchLeague(league: { key: string; name: string; slug: string }): Promise<any[]> {
  try {
    // Build a 7-day date range (e.g. 20260413-20260420) so we catch upcoming fixtures, not just today
    const today = new Date()
    const end   = new Date(Date.now() + 7 * 86_400_000)
    const pad   = (n: number) => String(n).padStart(2, '0')
    const fmt   = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}`
    const dateRange = `${fmt(today)}-${fmt(end)}`
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.key}/scoreboard?dates=${dateRange}`
    const res = await fetch(url, {
      next: { revalidate: 1800 },
      headers: { 'Accept': 'application/json' },
    })
    if (!res.ok) return []

    const data = await res.json()
    const events: any[] = data.events || []

    return events.map((e: any) => {
      const comp = e.competitions?.[0]
      if (!comp) return null

      const homeComp = comp.competitors?.find((c: any) => c.homeAway === 'home')
      const awayComp = comp.competitors?.find((c: any) => c.homeAway === 'away')
      const homeName = homeComp?.team?.displayName || homeComp?.team?.name || 'Local'
      const awayName = awayComp?.team?.displayName || awayComp?.team?.name || 'Visitante'
      const statusName = comp.status?.type?.name || 'STATUS_SCHEDULED'
      const odds = generateFootballOdds()

      // Best outcome for prediction
      const pOutcomes = { home: odds.pHome, draw: odds.pDraw, away: odds.pAway }
      const bestOutcome = (Object.entries(pOutcomes).reduce((a, b) => a[1] > b[1] ? a : b))[0]
      const confidence = Math.max(odds.pHome, odds.pDraw, odds.pAway)

      return {
        id: e.id,
        home_team: { name: homeName, logo: homeComp?.team?.logo || null },
        away_team: { name: awayName, logo: awayComp?.team?.logo || null },
        match_date: e.date,
        status: getStatusKey(statusName),
        league: league.name,
        league_slug: league.slug,
        odds: [
          { selection: 'home', odd_value: odds.homeOdd },
          { selection: 'draw', odd_value: odds.drawOdd },
          { selection: 'away', odd_value: odds.awayOdd },
          { selection: 'over_2.5', odd_value: odds.overOdd },
          { selection: 'under_2.5', odd_value: odds.underOdd },
          { selection: 'btts_yes', odd_value: odds.bttsYes },
          { selection: 'btts_no',  odd_value: odds.bttsNo  },
        ],
        prediction: {
          predicted_outcome: bestOutcome,
          confidence: +confidence.toFixed(4),
          expected_value: odds.ev,
          bet_type: odds.ev > 0.06 ? 'fixed' : 'parlay',
          suggested_amount_cop:
            odds.ev > 0.08 ? 40000 :
            odds.ev > 0.05 ? 25000 :
            odds.ev > 0.02 ? 12000 : 0,
          best_market: odds.bestMarket,
          best_odd: odds.bestOdd,
          p_home: +odds.pHome.toFixed(4),
          p_draw: +odds.pDraw.toFixed(4),
          p_away: +odds.pAway.toFixed(4),
          p_over: +odds.pOver.toFixed(4),
          p_btts:  +odds.pBtts.toFixed(4),
          exp_goals: odds.expGoals,
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
    const results = await Promise.all(LEAGUES.map(fetchLeague))
    const matches = results.flat()

    matches.sort((a: any, b: any) =>
      new Date(a.match_date).getTime() - new Date(b.match_date).getTime()
    )

    return NextResponse.json({ matches, source: 'espn', count: matches.length })
  } catch (err) {
    console.error('[/api/football/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
