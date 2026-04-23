import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const ESPN_NBA_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
const ESPN_NBA_STANDINGS  = 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings'

// Pythagorean model constants
const PYTH_EXP       = 13.91
const HOME_ADV_PTS   = 3.2
const SCORE_SD       = 12
const LEAGUE_AVG_PTS = 113.5

async function apiFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })
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
      const wins   = get(['wins', 'W'])   || 0
      const losses = get(['losses', 'L']) || 0
      const gp     = (wins + losses) || 1
      const winPct = get(['winPercent', 'PCT', 'leagueWinPercent'])
      quality[name] = {
        ptsFor:     get(['avgPointsFor', 'PPG', 'ppg', 'avgPoints'])    || LEAGUE_AVG_PTS,
        ptsAgainst: get(['avgPointsAgainst', 'OPP PPG', 'oppg'])        || LEAGUE_AVG_PTS,
        winRate:    Math.max(0.05, Math.min(0.95, winPct ?? wins / gp)),
        gp,
      }
    }
  }
  return quality
}

// ---- Pythagorean model ----
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
      fetchStandings(),
      apiFetch(sbURL),
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

      // Pythagorean model
      const homeQ    = findQuality(homeName, standingsData)
      const awayQ    = findQuality(awayName, standingsData)
      const hF       = shrinkPts(homeQ.ptsFor,     homeQ.gp, LEAGUE_AVG_PTS)
      const hA       = shrinkPts(homeQ.ptsAgainst, homeQ.gp, LEAGUE_AVG_PTS)
      const aF       = shrinkPts(awayQ.ptsFor,     awayQ.gp, LEAGUE_AVG_PTS)
      const aA       = shrinkPts(awayQ.ptsAgainst, awayQ.gp, LEAGUE_AVG_PTS)
      const homePyth = pythagorean(hF, hA)
      const awayPyth = pythagorean(aF, aA)
      const spread   = netRating(homePyth) - netRating(awayPyth) + HOME_ADV_PTS
      const pHome    = Math.max(0.08, Math.min(0.92, spreadToWinProb(spread)))
      const pAway    = 1 - pHome
      const modelSource = 'Pythagorean'

      // Expected points
      const homeQ2 = findQuality(homeName, standingsData)
      const awayQ2 = findQuality(awayName, standingsData)

      const expHomePts = (shrinkPts(homeQ2.ptsFor, homeQ2.gp, LEAGUE_AVG_PTS) + shrinkPts(awayQ2.ptsAgainst, awayQ2.gp, LEAGUE_AVG_PTS)) / 2
      const expAwayPts = (shrinkPts(awayQ2.ptsFor, awayQ2.gp, LEAGUE_AVG_PTS) + shrinkPts(homeQ2.ptsAgainst, homeQ2.gp, LEAGUE_AVG_PTS)) / 2
      const expTotalPts = +(expHomePts + expAwayPts).toFixed(1)

      // Points range
      const p_under_210 = Math.max(0.05, Math.min(0.80, (210 - expTotalPts) / 30 + 0.5))
      const p_210_225   = Math.max(0.05, Math.min(0.60, 0.35 - Math.abs(expTotalPts - 217) * 0.02))
      const p_225_240   = Math.max(0.05, Math.min(0.60, 0.35 - Math.abs(expTotalPts - 232) * 0.02))
      const p_over_240  = Math.max(0.05, Math.min(0.80, (expTotalPts - 240) / 30 + 0.5))

      // Top scoring team
      const topScoringTeam = expHomePts >= expAwayPts ? 'home' : 'away'

      // Pace
      const avgPts = (expHomePts + expAwayPts) / 2
      const pace = avgPts > 116 ? 'rapido' : avgPts > 110 ? 'moderado' : 'lento'

      // Blowout probability
      const blowoutProb = Math.min(0.45, Math.abs(pHome - 0.5) * 0.85)

      // Winner confidence
      const maxProb = Math.max(pHome, pAway)
      const winnerConfidence = maxProb > 0.65 ? 'alta' : maxProb > 0.55 ? 'media' : 'baja'

      matches.push({
        id: e.id,
        home_team:  { name: homeName },
        away_team:  { name: awayName },
        match_date: e.date,
        status:     statusName.includes('IN_PROGRESS') ? 'live' : 'scheduled',
        league:     'NBA',
        prediction: {
          home_win_prob:    +pHome.toFixed(4),
          away_win_prob:    +pAway.toFixed(4),
          predicted_winner: pHome >= pAway ? 'home' : 'away',
          winner_confidence: winnerConfidence,
          model_source:     modelSource,
          exp_total_points: expTotalPts,
          home_proj_pts:    +expHomePts.toFixed(1),
          away_proj_pts:    +expAwayPts.toFixed(1),
          home_proj_reb:    44.5,
          away_proj_reb:    44.5,
          home_proj_ast:    25.0,
          away_proj_ast:    25.0,
          points_range: {
            under_210: +p_under_210.toFixed(3),
            p_210_225: +p_210_225.toFixed(3),
            p_225_240: +p_225_240.toFixed(3),
            over_240:  +p_over_240.toFixed(3),
          },
          top_scoring_team:   topScoringTeam,
          pace,
          blowout_probability: +blowoutProb.toFixed(4),
        },
      })
    }

    matches.sort((a, b) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime())
    return NextResponse.json({
      matches,
      source: 'espn+pythagorean',
      count: matches.length,
    })
  } catch (err) {
    console.error('[/api/nba/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
