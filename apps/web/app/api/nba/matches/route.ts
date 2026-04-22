import { NextResponse } from 'next/server'

const ESPN_NBA_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
const ESPN_NBA_STANDINGS  = 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings'
const ODDS_API_KEY        = process.env.ODDS_API_KEY || ''
const ODDS_API_URL        = 'https://api.the-odds-api.com/v4/sports/basketball_nba/odds'

// Pythagorean expectation exponent (Morey, calibrated for NBA)
const PYTH_EXP      = 13.91
const HOME_ADV_PTS  = 3.2
const SCORE_SD      = 12
const LEAGUE_AVG_PTS = 113.5

async function apiFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, { next: { revalidate: 1800 }, headers: { Accept: 'application/json' } })
    return res.ok ? await res.json() : null
  } catch { return null }
}

interface TeamQuality { ptsFor: number; ptsAgainst: number; winRate: number; gp: number }

async function fetchStandings(): Promise<Record<string, TeamQuality>> {
  const data = await apiFetch(ESPN_NBA_STANDINGS)
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
      const wins    = get(['wins', 'W'])   || 0
      const losses  = get(['losses', 'L']) || 0
      const gp      = (wins + losses) || 1
      const winPct  = get(['winPercent', 'PCT', 'leagueWinPercent'])
      quality[name] = {
        ptsFor:     get(['avgPointsFor',     'PPG', 'ppg', 'avgPoints'])    || LEAGUE_AVG_PTS,
        ptsAgainst: get(['avgPointsAgainst', 'OPP PPG', 'oppg'])            || LEAGUE_AVG_PTS,
        winRate:    Math.max(0.05, Math.min(0.95, winPct ?? wins / gp)),
        gp,
      }
    }
  }
  return quality
}

// Fetch real bookmaker odds from The Odds API
interface BookmakerOdds { homeOdd: number; awayOdd: number; bookmaker: string }
async function fetchRealOdds(): Promise<Map<string, BookmakerOdds>> {
  const map = new Map<string, BookmakerOdds>()
  if (!ODDS_API_KEY) return map

  const url = `${ODDS_API_URL}?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=decimal&bookmakers=draftkings,fanduel,betmgm`
  const data = await apiFetch(url)
  if (!Array.isArray(data)) return map

  for (const game of data) {
    const home = game.home_team as string
    const away = game.away_team as string
    // Pick best odds across bookmakers (highest for each side)
    let bestHomeOdd = 0, bestAwayOdd = 0, bookmakerName = ''
    for (const bk of (game.bookmakers || [])) {
      const market = bk.markets?.find((m: any) => m.key === 'h2h')
      if (!market) continue
      const homeOut = market.outcomes?.find((o: any) => o.name === home)
      const awayOut = market.outcomes?.find((o: any) => o.name === away)
      if (homeOut?.price > bestHomeOdd) { bestHomeOdd = homeOut.price; bookmakerName = bk.title }
      if (awayOut?.price > bestAwayOdd)   bestAwayOdd = awayOut.price
    }
    if (bestHomeOdd > 1 && bestAwayOdd > 1) {
      const key = normalizeTeam(home) + '|' + normalizeTeam(away)
      map.set(key, { homeOdd: bestHomeOdd, awayOdd: bestAwayOdd, bookmaker: bookmakerName })
    }
  }
  return map
}

// Normalize team name for fuzzy matching
function normalizeTeam(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim()
    .replace('trail blazers', 'blazers')
    .replace('timberwolves', 'wolves')
}

function pythagorean(f: number, a: number): number {
  if (f <= 0 || a <= 0) return 0.5
  return f ** PYTH_EXP / (f ** PYTH_EXP + a ** PYTH_EXP)
}

function spreadToWinProb(spread: number): number {
  return 1 / (1 + Math.exp(-spread / (SCORE_SD * 0.58)))
}

function netRating(pyth: number): number { return 30 * (pyth - 0.5) }

function shrinkPts(raw: number, gp: number, mean: number, k = 15): number {
  return (raw * gp + mean * k) / (gp + k)
}

function stableFloat(seed: string, offset = 0): number {
  let h = (offset + 1) * 2654435761
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 2654435761)
  return ((h >>> 0) % 10000) / 10000
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

function findRealOdds(
  homeName: string, awayName: string,
  oddsMap: Map<string, BookmakerOdds>
): BookmakerOdds | null {
  const key = normalizeTeam(homeName) + '|' + normalizeTeam(awayName)
  if (oddsMap.has(key)) return oddsMap.get(key)!
  // Try partial match
  for (const [k, v] of oddsMap) {
    const [h, a] = k.split('|')
    const homeMatch = normalizeTeam(homeName).includes(h.split(' ').pop()!) || h.includes(normalizeTeam(homeName).split(' ').pop()!)
    const awayMatch = normalizeTeam(awayName).includes(a.split(' ').pop()!) || a.includes(normalizeTeam(awayName).split(' ').pop()!)
    if (homeMatch && awayMatch) return v
  }
  return null
}

export async function GET() {
  try {
    const today = new Date()
    const end   = new Date(today.getTime() + 8 * 86_400_000)
    const fmt   = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')
    const sbURL = `${ESPN_NBA_SCOREBOARD}?dates=${fmt(today)}-${fmt(end)}`

    const [standingsData, scoreboardData, realOddsMap] = await Promise.all([
      fetchStandings(),
      apiFetch(sbURL),
      fetchRealOdds(),
    ])

    const hasRealOdds = realOddsMap.size > 0
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

      // Model probability (Pythagorean)
      const homeQ  = findQuality(homeName, standingsData)
      const awayQ  = findQuality(awayName, standingsData)
      const hF     = shrinkPts(homeQ.ptsFor,     homeQ.gp, LEAGUE_AVG_PTS)
      const hA     = shrinkPts(homeQ.ptsAgainst, homeQ.gp, LEAGUE_AVG_PTS)
      const aF     = shrinkPts(awayQ.ptsFor,     awayQ.gp, LEAGUE_AVG_PTS)
      const aA     = shrinkPts(awayQ.ptsAgainst, awayQ.gp, LEAGUE_AVG_PTS)
      const homePyth = pythagorean(hF, hA)
      const awayPyth = pythagorean(aF, aA)
      const spread   = netRating(homePyth) - netRating(awayPyth) + HOME_ADV_PTS
      const pHome    = Math.max(0.08, Math.min(0.92, spreadToWinProb(spread)))
      const pAway    = 1 - pHome

      // O/U
      const estTotal = (hF + aF + hA + aA) / 2
      const ouLine   = +(estTotal * 0.65 + (2 * LEAGUE_AVG_PTS) * 0.35).toFixed(1)
      const pOver    = Math.max(0.35, Math.min(0.65, 0.50 + (stableFloat(e.id, 2) - 0.50) * 0.10))

      // Use real odds if available, otherwise projected
      const realOdds = findRealOdds(homeName, awayName, realOddsMap)
      let homeOdd: number, awayOdd: number, oddsSource: string

      if (realOdds) {
        homeOdd   = realOdds.homeOdd
        awayOdd   = realOdds.awayOdd
        oddsSource = realOdds.bookmaker
      } else {
        // Projected odds (model-based fallback, clearly labeled)
        const PROJ_MARGIN = 0.045
        const drift  = (stableFloat(e.id, 0) - 0.50) * 0.18
        const mktH   = Math.max(0.08, Math.min(0.92, pHome + drift))
        homeOdd   = +((1 / mktH)       * (1 - PROJ_MARGIN)).toFixed(2)
        awayOdd   = +((1 / (1 - mktH)) * (1 - PROJ_MARGIN)).toFixed(2)
        oddsSource = 'proyectado'
      }

      const overOdd  = +((1 / pOver)       * 0.955).toFixed(2)
      const underOdd = +((1 / (1 - pOver)) * 0.955).toFixed(2)

      // EV = model probability × bookmaker odd - 1
      const markets = [
        { market: 'home',  prob: pHome,      odd: homeOdd,  ev: +(pHome      * homeOdd  - 1).toFixed(4) },
        { market: 'away',  prob: pAway,      odd: awayOdd,  ev: +(pAway      * awayOdd  - 1).toFixed(4) },
        { market: 'over',  prob: pOver,      odd: overOdd,  ev: +(pOver      * overOdd  - 1).toFixed(4) },
        { market: 'under', prob: 1 - pOver,  odd: underOdd, ev: +((1-pOver)  * underOdd - 1).toFixed(4) },
      ]
      const best = markets.reduce((a, b) => a.ev > b.ev ? a : b)

      matches.push({
        id: e.id,
        home_team:  { name: homeName },
        away_team:  { name: awayName },
        match_date: e.date,
        status:     statusName.includes('IN_PROGRESS') ? 'live' : 'scheduled',
        league:     'NBA',
        odds: [
          { selection: 'home',  odd_value: homeOdd,  bookmaker: oddsSource },
          { selection: 'away',  odd_value: awayOdd,  bookmaker: oddsSource },
          { selection: 'over',  odd_value: overOdd,  bookmaker: oddsSource },
          { selection: 'under', odd_value: underOdd, bookmaker: oddsSource },
        ],
        prediction: {
          predicted_outcome:    best.market,
          confidence:           +best.prob.toFixed(4),
          expected_value:       best.ev,
          bet_type:             best.ev >= 0.08 ? 'parlay' : best.ev >= 0.05 ? 'fixed' : null,
          suggested_amount_cop: best.ev > 0.08 ? 45000 : best.ev > 0.05 ? 28000 : best.ev > 0.02 ? 15000 : 0,
          p_home: +pHome.toFixed(4),
          p_away: +pAway.toFixed(4),
          spread: +spread.toFixed(1),
          ou_line: ouLine,
          odds_source: oddsSource,
          real_odds: !!realOdds,
        },
      })
    }

    matches.sort((a, b) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime())
    return NextResponse.json({
      matches,
      source: hasRealOdds ? 'espn+odds-api' : 'espn+proyectado',
      has_real_odds: hasRealOdds,
      count: matches.length,
    })
  } catch (err) {
    console.error('[/api/nba/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
