import { NextResponse } from 'next/server'

// ── Constants ─────────────────────────────────────────────────────────────────
const ESPN_NBA_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
const ESPN_NBA_STANDINGS   = 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings'
const MARGIN = 0.045

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function espnFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, {
      next: { revalidate: 1800 },
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ── Team quality from ESPN standings ─────────────────────────────────────────
interface TeamQuality { winRate: number; ptsFor: number; ptsAgainst: number }

async function fetchStandings(): Promise<Record<string, TeamQuality>> {
  const data = await espnFetch(ESPN_NBA_STANDINGS)
  const quality: Record<string, TeamQuality> = {}
  if (!data) return quality

  const children = data.children || [data]
  for (const child of children) {
    const entries = child?.standings?.entries || []
    for (const entry of entries) {
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
      const gp       = get(['gamesPlayed', 'GP']) || 1
      const wins     = get(['wins', 'W']) || 0
      const ptsFor   = get(['ppg', 'avgPoints', 'pointsPerGame']) || 0
      const ptsAgainst = get(['oppg', 'avgPointsAgainst', 'oppPointsPerGame']) || 0
      quality[name] = {
        winRate:    wins / gp,
        ptsFor:     ptsFor  || 110,
        ptsAgainst: ptsAgainst || 110,
      }
    }
  }
  return quality
}

// ── Model probability + market odds with drift ────────────────────────────────
function computeMatch(homeQ: TeamQuality, awayQ: TeamQuality) {
  // Model probability: blend win rate + pts differential
  const hWR  = Math.max(0.10, Math.min(0.90, homeQ.winRate * 1.05)) // home advantage
  const aWR  = Math.max(0.10, Math.min(0.90, awayQ.winRate))
  const ptsDiff = (homeQ.ptsFor - homeQ.ptsAgainst) - (awayQ.ptsFor - awayQ.ptsAgainst)
  const ptsAdj  = Math.tanh(ptsDiff / 20) * 0.10  // ±10% from pts differential
  const rawHome = (hWR + (1 - aWR)) / 2 + ptsAdj
  const pHome   = Math.max(0.08, Math.min(0.92, rawHome))
  const pAway   = 1 - pHome

  // Market probability = model ± drift (simulates bookmaker inefficiency / our edge)
  const drift   = (Math.random() - 0.45) * 0.12  // bias towards positive EV
  const mktHome = Math.max(0.08, Math.min(0.92, pHome + drift))
  const mktAway = 1 - mktHome

  const homeOdd = +((1 / mktHome) * (1 - MARGIN)).toFixed(2)
  const awayOdd = +((1 / mktAway) * (1 - MARGIN)).toFixed(2)

  const evHome  = +(pHome * homeOdd - 1).toFixed(4)
  const evAway  = +(pAway * awayOdd - 1).toFixed(4)
  const best    = evHome >= evAway
    ? { market: 'home', prob: pHome, odd: homeOdd, ev: evHome }
    : { market: 'away', prob: pAway, odd: awayOdd, ev: evAway }

  return { pHome, pAway, homeOdd, awayOdd, best, ev: Math.max(0, best.ev) }
}

// ── Default fallback quality when team not in standings ───────────────────────
const DEFAULT_Q: TeamQuality = { winRate: 0.50, ptsFor: 110, ptsAgainst: 110 }

// Partial name match for when ESPN fixture name ≠ standings name
function findQuality(name: string, standings: Record<string, TeamQuality>): TeamQuality {
  if (standings[name]) return standings[name]
  const key = Object.keys(standings).find(k =>
    k.toLowerCase().includes(name.toLowerCase().split(' ').pop() || '') ||
    name.toLowerCase().includes(k.toLowerCase().split(' ').pop() || '')
  )
  return key ? standings[key] : DEFAULT_Q
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function GET() {
  try {
    // Fetch standings + scoreboard in parallel
    const today  = new Date()
    const end    = new Date(today.getTime() + 8 * 86_400_000)
    const fmt    = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')
    const sbURL  = `${ESPN_NBA_SCOREBOARD}?dates=${fmt(today)}-${fmt(end)}`

    const [standingsData, scoreboardData] = await Promise.all([
      fetchStandings(),
      espnFetch(sbURL),
    ])

    const events: any[] = scoreboardData?.events || []

    // Dedup: one card per team pair
    const seen = new Set<string>()
    const matches: any[] = []

    for (const e of events) {
      const comp = e.competitions?.[0]
      if (!comp) continue
      const homeComp = comp.competitors?.find((c: any) => c.homeAway === 'home')
      const awayComp = comp.competitors?.find((c: any) => c.homeAway === 'away')
      if (!homeComp || !awayComp) continue

      const homeName = homeComp.team?.displayName || homeComp.team?.name || ''
      const awayName = awayComp.team?.displayName || awayComp.team?.name || ''
      if (!homeName || !awayName) continue

      const dedupeKey = `${homeName}-${awayName}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      const statusName = comp.status?.type?.name || ''
      if (statusName.includes('FINAL') || statusName.includes('POST')) continue

      const homeQ = findQuality(homeName, standingsData)
      const awayQ = findQuality(awayName, standingsData)
      const calc  = computeMatch(homeQ, awayQ)

      matches.push({
        id:         e.id,
        home_team:  { name: homeName },
        away_team:  { name: awayName },
        match_date: e.date,
        status:     'scheduled',
        league:     'NBA',
        odds: [
          { selection: 'home', odd_value: calc.homeOdd },
          { selection: 'away', odd_value: calc.awayOdd },
        ],
        prediction: {
          predicted_outcome:    calc.best.market,
          confidence:           +calc.best.prob.toFixed(4),
          expected_value:       calc.ev,
          bet_type:             calc.ev >= 0.06 ? 'fixed' : 'parlay',
          suggested_amount_cop: calc.ev > 0.08 ? 45000 : calc.ev > 0.05 ? 28000 : calc.ev > 0.02 ? 15000 : 0,
        },
      })
    }

    matches.sort((a, b) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime())
    return NextResponse.json({ matches, source: 'espn+standings', count: matches.length })
  } catch (err) {
    console.error('[/api/nba/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
