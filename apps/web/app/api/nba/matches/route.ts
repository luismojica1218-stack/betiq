import { NextResponse } from 'next/server'

const ESPN_NBA = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'

// NBA team strength map (approximate ELO tier for odds generation)
const NBA_STRENGTH: Record<string, number> = {
  'Boston Celtics': 0.72, 'Oklahoma City Thunder': 0.70, 'Cleveland Cavaliers': 0.68,
  'Denver Nuggets': 0.67, 'Minnesota Timberwolves': 0.65, 'New York Knicks': 0.64,
  'Indiana Pacers': 0.62, 'Milwaukee Bucks': 0.61, 'Golden State Warriors': 0.60,
  'Los Angeles Lakers': 0.58, 'Dallas Mavericks': 0.57, 'Phoenix Suns': 0.55,
  'Memphis Grizzlies': 0.54, 'Sacramento Kings': 0.53, 'LA Clippers': 0.52,
  'Miami Heat': 0.51, 'Chicago Bulls': 0.48, 'Atlanta Hawks': 0.47,
  'Philadelphia 76ers': 0.46, 'Orlando Magic': 0.45, 'New Orleans Pelicans': 0.44,
  'Houston Rockets': 0.43, 'Toronto Raptors': 0.42, 'Utah Jazz': 0.40,
  'Detroit Pistons': 0.39, 'San Antonio Spurs': 0.38, 'Charlotte Hornets': 0.37,
  'Portland Trail Blazers': 0.36, 'Washington Wizards': 0.34, 'Brooklyn Nets': 0.33,
}

function getStrength(name: string): number {
  // Try exact match first, then partial
  if (NBA_STRENGTH[name]) return NBA_STRENGTH[name]
  const key = Object.keys(NBA_STRENGTH).find(k => name.includes(k.split(' ').pop()!))
  return key ? NBA_STRENGTH[key] : 0.50
}

function generateOdds(homeStr: number, awayStr: number) {
  // Home court advantage ~+5%
  const adjHome = Math.min(0.85, homeStr + 0.05)
  const adjAway = Math.max(0.15, awayStr - 0.05)
  const total = adjHome + adjAway
  const pHome = adjHome / total
  const pAway = adjAway / total

  // Add 4.5% bookmaker margin
  const margin = 0.045
  const homeOdd = +((1 / pHome) * (1 - margin)).toFixed(2)
  const awayOdd = +((1 / pAway) * (1 - margin)).toFixed(2)
  return { homeOdd, awayOdd, pHome, pAway }
}

function getStatusKey(espnStatus: string): string {
  if (espnStatus.includes('SCHEDULED') || espnStatus.includes('PRE')) return 'scheduled'
  if (espnStatus.includes('IN_PROGRESS') || espnStatus.includes('LIVE')) return 'live'
  if (espnStatus.includes('FINAL') || espnStatus.includes('POST')) return 'finished'
  return 'scheduled'
}

export async function GET() {
  try {
    const today = new Date()
    const end = new Date(today.getTime() + 8 * 24 * 60 * 60 * 1000)
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')

    const res = await fetch(`${ESPN_NBA}?dates=${fmt(today)}-${fmt(end)}`, {
      next: { revalidate: 3600 },
      headers: { 'Accept': 'application/json' },
    })

    if (!res.ok) throw new Error(`ESPN ${res.status}`)

    const data = await res.json()
    const events: any[] = data.events || []

    const matches = events.map((e: any) => {
      const comp = e.competitions?.[0]
      if (!comp) return null

      const homeComp = comp.competitors?.find((c: any) => c.homeAway === 'home')
      const awayComp = comp.competitors?.find((c: any) => c.homeAway === 'away')
      const homeName = homeComp?.team?.displayName || homeComp?.team?.name || 'Local'
      const awayName = awayComp?.team?.displayName || awayComp?.team?.name || 'Visitante'

      const statusName = comp.status?.type?.name || 'STATUS_SCHEDULED'
      const status = getStatusKey(statusName)

      const homeStr = getStrength(homeName)
      const awayStr = getStrength(awayName)
      const { homeOdd, awayOdd, pHome, pAway } = generateOdds(homeStr, awayStr)

      const isHomeFav = pHome >= pAway
      const confidence = Math.max(pHome, pAway)
      const winnerOdd = isHomeFav ? homeOdd : awayOdd
      const ev = +(confidence * winnerOdd - 1).toFixed(4)

      return {
        id: e.id,
        home_team: {
          name: homeName,
          logo: homeComp?.team?.logo || null,
        },
        away_team: {
          name: awayName,
          logo: awayComp?.team?.logo || null,
        },
        match_date: e.date,
        status,
        league: 'NBA',
        odds: [
          { selection: 'home', odd_value: homeOdd },
          { selection: 'away', odd_value: awayOdd },
        ],
        prediction: {
          predicted_outcome: isHomeFav ? 'home' : 'away',
          confidence: +confidence.toFixed(4),
          expected_value: ev > 0 ? ev : 0,
          bet_type: confidence >= 0.65 ? 'fixed' : 'parlay',
          suggested_amount_cop:
            ev > 0.07 ? 45000 :
            ev > 0.04 ? 28000 :
            ev > 0.02 ? 15000 : 0,
        },
      }
    }).filter(Boolean)

    return NextResponse.json({ matches, source: 'espn', count: matches.length })
  } catch (err) {
    console.error('[/api/nba/matches]', err)
    // Return empty — client will fall back to demo data
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
