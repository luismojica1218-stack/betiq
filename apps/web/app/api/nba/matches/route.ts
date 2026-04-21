import { NextResponse } from 'next/server'

const ESPN_NBA_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
const ESPN_NBA_STANDINGS  = 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings'
const MARGIN = 0.045

// Pythagorean expectation exponent (Morey, calibrated for NBA)
const PYTH_EXP = 13.91
// Home court advantage in points (historically ~3.2 pts)
const HOME_ADV_PTS = 3.2
// Score SD for logistic spread → probability
const SCORE_SD = 12
// League average pts/game (used for Bayesian shrinkage)
const LEAGUE_AVG_PTS = 113.5

function stableFloat(seed: string, offset = 0): number {
  let h = (offset + 1) * 2654435761
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 2654435761)
  return ((h >>> 0) % 10000) / 10000
}

async function espnFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, { next: { revalidate: 1800 }, headers: { Accept: 'application/json' } })
    return res.ok ? await res.json() : null
  } catch { return null }
}

interface TeamQuality { ptsFor: number; ptsAgainst: number; winRate: number; gp: number }

async function fetchStandings(): Promise<Record<string, TeamQuality>> {
  const data = await espnFetch(ESPN_NBA_STANDINGS)
  const quality: Record<string, TeamQuality> = {}
  if (!data) return quality
  for (const child of (data.children || [data])) {
    for (const entry of (child?.standings?.entries || [])) {
      const name = entry?.team?.displayName || entry?.team?.name || ''
      if (!name) continue
      const statsArr: any[] = entry.stats || []
      const get = (keys: string[]) => {
        for (const k of keys) {
          const s = statsArr.find((x: any) => x.name === k || x.abbreviation === k)
          if (s?.value != null) return parseFloat(s.value)
        }
        return null
      }
      const winPct    = get(['winPercent', 'PCT', 'leagueWinPercent'])
      const wins      = get(['wins', 'W'])   || 0
      const losses    = get(['losses', 'L']) || 0
      const gp        = (wins + losses) || 1
      const winRate   = winPct != null ? winPct : wins / gp
      const ptsFor    = get(['avgPointsFor',     'PPG', 'ppg', 'avgPoints', 'pointsPerGame']) || 0
      const ptsAgainst= get(['avgPointsAgainst', 'OPP PPG', 'oppg', 'avgPointsAllowed'])      || 0
      quality[name] = {
        ptsFor:     ptsFor     || LEAGUE_AVG_PTS,
        ptsAgainst: ptsAgainst || LEAGUE_AVG_PTS,
        winRate:    Math.max(0.05, Math.min(0.95, winRate)),
        gp,
      }
    }
  }
  return quality
}

// Pythagorean win expectation — better predictor than raw win rate
function pythagorean(f: number, a: number): number {
  if (f <= 0 || a <= 0) return 0.5
  return f ** PYTH_EXP / (f ** PYTH_EXP + a ** PYTH_EXP)
}

// Spread → win probability via logistic (calibrated to NBA score variance)
function spreadToWinProb(spread: number): number {
  return 1 / (1 + Math.exp(-spread / (SCORE_SD * 0.58)))
}

// Pythagorean → implied net rating (approximation: 30 × (pyth − 0.5))
function netRating(pyth: number): number { return 30 * (pyth - 0.5) }

// Bayesian shrinkage: pull toward league mean for small samples
function shrinkPts(raw: number, gp: number, mean: number, k = 15): number {
  return (raw * gp + mean * k) / (gp + k)
}

function computeMatch(homeQ: TeamQuality, awayQ: TeamQuality, matchId: string) {
  const hF = shrinkPts(homeQ.ptsFor,     homeQ.gp, LEAGUE_AVG_PTS)
  const hA = shrinkPts(homeQ.ptsAgainst, homeQ.gp, LEAGUE_AVG_PTS)
  const aF = shrinkPts(awayQ.ptsFor,     awayQ.gp, LEAGUE_AVG_PTS)
  const aA = shrinkPts(awayQ.ptsAgainst, awayQ.gp, LEAGUE_AVG_PTS)

  const homePyth = pythagorean(hF, hA)
  const awayPyth = pythagorean(aF, aA)
  const spread   = netRating(homePyth) - netRating(awayPyth) + HOME_ADV_PTS

  const pHome = Math.max(0.08, Math.min(0.92, spreadToWinProb(spread)))
  const pAway = 1 - pHome

  // O/U line: average expected scoring environment of both teams
  const estTotal = (hF + aF + hA + aA) / 2
  const ouLine   = +(estTotal * 0.65 + (2 * LEAGUE_AVG_PTS) * 0.35).toFixed(1)
  const pOver    = Math.max(0.35, Math.min(0.65, 0.50 + (stableFloat(matchId, 2) - 0.50) * 0.10))

  const drift   = (stableFloat(matchId, 0) - 0.50) * 0.07
  const mktHome = Math.max(0.08, Math.min(0.92, pHome + drift))
  const mktAway = 1 - mktHome
  const mktOv   = Math.max(0.35, Math.min(0.65, pOver + (stableFloat(matchId, 1) - 0.50) * 0.05))

  const homeOdd  = +((1 / mktHome)     * (1 - MARGIN)).toFixed(2)
  const awayOdd  = +((1 / mktAway)     * (1 - MARGIN)).toFixed(2)
  const overOdd  = +((1 / mktOv)       * (1 - MARGIN)).toFixed(2)
  const underOdd = +((1 / (1 - mktOv)) * (1 - MARGIN)).toFixed(2)

  const allMarkets = [
    { market: 'home',  prob: pHome,      odd: homeOdd,  ev: +(pHome      * homeOdd  - 1).toFixed(4) },
    { market: 'away',  prob: pAway,      odd: awayOdd,  ev: +(pAway      * awayOdd  - 1).toFixed(4) },
    { market: 'over',  prob: pOver,      odd: overOdd,  ev: +(pOver      * overOdd  - 1).toFixed(4) },
    { market: 'under', prob: 1 - pOver,  odd: underOdd, ev: +((1-pOver)  * underOdd - 1).toFixed(4) },
  ]
  const eligible = allMarkets.filter(m => m.prob >= 0.20 && m.odd <= 5.00)
  const pool = eligible.length > 0 ? eligible : allMarkets.filter(m => m.prob >= 0.15)
  const best = (pool.length > 0 ? pool : allMarkets).reduce((a, b) => a.ev > b.ev ? a : b)

  return {
    pHome, pAway, pOver,
    homeOdd, awayOdd, overOdd, underOdd,
    ouLine, spread: +spread.toFixed(1),
    homePyth: +homePyth.toFixed(4), awayPyth: +awayPyth.toFixed(4),
    best, ev: Math.max(0, best.ev),
  }
}

const DEFAULT_Q: TeamQuality = { ptsFor: LEAGUE_AVG_PTS, ptsAgainst: LEAGUE_AVG_PTS, winRate: 0.50, gp: 0 }

function findQuality(name: string, standings: Record<string, TeamQuality>): TeamQuality {
  if (standings[name]) return standings[name]
  const key = Object.keys(standings).find(k =>
    k.toLowerCase().includes((name.toLowerCase().split(' ').pop()) || '') ||
    name.toLowerCase().includes((k.toLowerCase().split(' ').pop()) || '')
  )
  return key ? standings[key] : DEFAULT_Q
}

export async function GET() {
  try {
    const today = new Date()
    const end   = new Date(today.getTime() + 8 * 86_400_000)
    const fmt   = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')
    const sbURL = `${ESPN_NBA_SCOREBOARD}?dates=${fmt(today)}-${fmt(end)}`

    const [standingsData, scoreboardData] = await Promise.all([
      fetchStandings(), espnFetch(sbURL),
    ])

    const seen = new Set<string>()
    const matches: any[] = []

    for (const e of (scoreboardData?.events || [])) {
      const comp     = e.competitions?.[0]
      if (!comp) continue
      const homeComp = comp.competitors?.find((c: any) => c.homeAway === 'home')
      const awayComp = comp.competitors?.find((c: any) => c.homeAway === 'away')
      if (!homeComp || !awayComp) continue
      const homeName = homeComp.team?.displayName || homeComp.team?.name || ''
      const awayName = awayComp.team?.displayName || awayComp.team?.name || ''
      if (!homeName || !awayName) continue
      const key = `${homeName}-${awayName}`
      if (seen.has(key)) continue
      seen.add(key)
      const statusName = comp.status?.type?.name || ''
      if (statusName.includes('FINAL') || statusName.includes('POST')) continue

      const calc = computeMatch(findQuality(homeName, standingsData), findQuality(awayName, standingsData), e.id)

      matches.push({
        id: e.id,
        home_team:  { name: homeName },
        away_team:  { name: awayName },
        match_date: e.date,
        status:     statusName.includes('IN_PROGRESS') ? 'live' : 'scheduled',
        league:     'NBA',
        odds: [
          { selection: 'home',  odd_value: calc.homeOdd  },
          { selection: 'away',  odd_value: calc.awayOdd  },
          { selection: 'over',  odd_value: calc.overOdd  },
          { selection: 'under', odd_value: calc.underOdd },
        ],
        prediction: {
          predicted_outcome:    calc.best.market,
          confidence:           +calc.best.prob.toFixed(4),
          expected_value:       calc.ev,
          bet_type:             calc.ev >= 0.06 ? 'fixed' : 'parlay',
          suggested_amount_cop: calc.ev > 0.08 ? 45000 : calc.ev > 0.05 ? 28000 : calc.ev > 0.02 ? 15000 : 0,
          p1_win_prob: +calc.pHome.toFixed(4),
          p2_win_prob: +calc.pAway.toFixed(4),
          p_over:      +calc.pOver.toFixed(4),
          p_under:     +(1 - calc.pOver).toFixed(4),
          spread:      calc.spread,
          ou_line:     calc.ouLine,
          pyth_home:   calc.homePyth,
          pyth_away:   calc.awayPyth,
          best_market: calc.best.market,
          best_odd:    calc.best.odd,
        },
      })
    }

    matches.sort((a, b) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime())
    return NextResponse.json({ matches, source: 'espn+pythagorean', count: matches.length })
  } catch (err) {
    console.error('[/api/nba/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
