import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── Supabase ─────────────────────────────────────────────────────────────────
async function getMatchesFromSupabase(): Promise<any[] | null> {
  try {
    const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return null

    const sb   = createClient(url, key)
    const now  = new Date().toISOString()
    const end  = new Date(Date.now() + 8 * 86_400_000).toISOString()

    const { data: matches, error } = await sb
      .from('matches')
      .select('*, home_team:teams!home_team_id(name), away_team:teams!away_team_id(name)')
      .eq('sport', 'nba')
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

// ── ESPN fallback ─────────────────────────────────────────────────────────────
const ESPN_NBA = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'

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
  if (NBA_STRENGTH[name]) return NBA_STRENGTH[name]
  const key = Object.keys(NBA_STRENGTH).find(k => name.includes(k.split(' ').pop()!))
  return key ? NBA_STRENGTH[key] : 0.50
}

function generateOdds(homeStr: number, awayStr: number) {
  const adjHome = Math.min(0.85, homeStr + 0.05)
  const adjAway = Math.max(0.15, awayStr - 0.05)
  const total = adjHome + adjAway
  const pHome = adjHome / total
  const pAway = adjAway / total
  const margin = 0.045
  return {
    homeOdd: +((1 / pHome) * (1 - margin)).toFixed(2),
    awayOdd: +((1 / pAway) * (1 - margin)).toFixed(2),
    pHome, pAway,
  }
}

function espnStatus(s: string) {
  if (s.includes('SCHEDULED') || s.includes('PRE')) return 'scheduled'
  if (s.includes('IN_PROGRESS') || s.includes('LIVE')) return 'live'
  return 'finished'
}

async function getMatchesFromESPN(): Promise<any[]> {
  const today = new Date()
  const end   = new Date(today.getTime() + 8 * 86_400_000)
  const fmt   = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')
  const res   = await fetch(`${ESPN_NBA}?dates=${fmt(today)}-${fmt(end)}`, {
    next: { revalidate: 3600 },
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return []
  const data   = await res.json()
  const events: any[] = data.events || []

  return events.map((e: any) => {
    const comp     = e.competitions?.[0]
    if (!comp) return null
    const homeComp = comp.competitors?.find((c: any) => c.homeAway === 'home')
    const awayComp = comp.competitors?.find((c: any) => c.homeAway === 'away')
    const homeName = homeComp?.team?.displayName || 'Local'
    const awayName = awayComp?.team?.displayName || 'Visitante'
    const { homeOdd, awayOdd, pHome, pAway } = generateOdds(
      getStrength(homeName), getStrength(awayName)
    )
    const isHomeFav = pHome >= pAway
    const confidence = Math.max(pHome, pAway)
    const ev = +(confidence * (isHomeFav ? homeOdd : awayOdd) - 1).toFixed(4)

    return {
      id: e.id,
      home_team: { name: homeName },
      away_team: { name: awayName },
      match_date: e.date,
      status: espnStatus(comp.status?.type?.name || ''),
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
        suggested_amount_cop: ev > 0.07 ? 45000 : ev > 0.04 ? 28000 : ev > 0.02 ? 15000 : 0,
      },
    }
  }).filter(Boolean)
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    // 1. Try Supabase (real scraped data)
    const sbMatches = await getMatchesFromSupabase()
    if (sbMatches && sbMatches.length > 0) {
      return NextResponse.json({ matches: sbMatches, source: 'supabase', count: sbMatches.length })
    }

    // 2. Fall back to ESPN live data
    const espnMatches = await getMatchesFromESPN()
    return NextResponse.json({ matches: espnMatches, source: 'espn', count: espnMatches.length })
  } catch (err) {
    console.error('[/api/nba/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
