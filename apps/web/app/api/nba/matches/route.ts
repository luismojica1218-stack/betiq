import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── Supabase ─────────────────────────────────────────────────────────────────
async function getMatchesFromSupabase(): Promise<any[] | null> {
  try {
    const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return null

    const sb  = createClient(url, key)
    const now = new Date().toISOString()
    const end = new Date(Date.now() + 14 * 86_400_000).toISOString()  // 14 days

    // Step 1 — fetch matches WITHOUT FK join (join is ambiguous and returns null names)
    const { data: matches, error } = await sb
      .from('matches')
      .select('*')
      .eq('sport', 'nba')
      .gte('match_date', now)
      .lte('match_date', end)
      .order('match_date')

    if (error || !matches || matches.length === 0) return null

    // Step 2 — batch-fetch team names in a single query
    const teamIds = Array.from(new Set<string>(matches.flatMap((m: any) => [m.home_team_id, m.away_team_id].filter(Boolean))))
    const { data: teamsData } = await sb.from('teams').select('id, name').in('id', teamIds)
    const teamMap: Record<string, string> = {}
    for (const t of teamsData || []) teamMap[t.id] = t.name

    // Step 3 — enrich each match
    const enriched = await Promise.all(matches.map(async (m: any) => {
      const homeName = teamMap[m.home_team_id] || ''
      const awayName = teamMap[m.away_team_id] || ''

      const [{ data: dbOdds }, { data: preds }] = await Promise.all([
        sb.from('odds').select('*').eq('match_id', m.id),
        sb.from('predictions').select('*').eq('match_id', m.id)
          .order('created_at', { ascending: false }).limit(1),
      ])
      let prediction = preds?.[0] || null
      let finalOdds: any[] = dbOdds || []

      if (!prediction) {
        let homeOdd = finalOdds.find((o: any) => o.selection === 'home')?.odd_value
        let awayOdd = finalOdds.find((o: any) => o.selection === 'away')?.odd_value

        // No DB odds → generate from team strength lookup with drift
        if (!homeOdd || !awayOdd) {
          const g = generateOdds(getStrength(homeName), getStrength(awayName))
          homeOdd = g.homeOdd
          awayOdd = g.awayOdd
          finalOdds = [
            { selection: 'home', odd_value: homeOdd },
            { selection: 'away', odd_value: awayOdd },
          ]
        }

        const rawH = 1/homeOdd, rawA = 1/awayOdd
        const mktHome = rawH / (rawH + rawA)
        const drift = (Math.random() - 0.45) * 0.10
        const pHome = Math.max(0.08, Math.min(0.92, mktHome + drift))
        const pAway = 1 - pHome
        const evHome = +(pHome * homeOdd - 1).toFixed(4)
        const evAway = +(pAway * awayOdd - 1).toFixed(4)
        const best = evHome >= evAway
          ? { market: 'home', prob: pHome, odd: homeOdd, ev: evHome }
          : { market: 'away', prob: pAway, odd: awayOdd, ev: evAway }
        const evFinal = Math.max(0, best.ev)
        prediction = {
          predicted_outcome:    best.market,
          confidence:           +best.prob.toFixed(4),
          expected_value:       evFinal,
          bet_type:             evFinal > 0.06 ? 'fixed' : 'parlay',
          suggested_amount_cop: evFinal > 0.07 ? 45000 : evFinal > 0.04 ? 28000 : evFinal > 0.02 ? 15000 : 0,
        }
      }

      return {
        ...m,
        home_team: { name: homeName },
        away_team: { name: awayName },
        odds: finalOdds,
        prediction,
      }
    }))

    // Deduplicate: same teams + same date should only show once
    const seen = new Set<string>()
    return enriched.filter((m: any) => {
      const key = `${m.home_team.name}-${m.away_team.name}-${m.match_date?.slice(0, 10)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
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
  // Model probability estimate
  const adjHome = Math.min(0.85, homeStr + 0.05)
  const adjAway = Math.max(0.15, awayStr - 0.05)
  const total   = adjHome + adjAway
  const pHome   = adjHome / total
  const pAway   = adjAway / total

  // Market probabilities — add drift to simulate bookmaker inefficiency
  const drift = (Math.random() - 0.45) * 0.10
  const mktHome = Math.max(0.08, Math.min(0.92, pHome + drift))
  const mktAway = 1 - mktHome
  const margin  = 0.045

  const homeOdd = +((1 / mktHome) * (1 - margin)).toFixed(2)
  const awayOdd = +((1 / mktAway) * (1 - margin)).toFixed(2)

  // O/U and spread
  const pOver   = 0.45 + Math.random() * 0.15
  const mktOver = Math.max(0.15, pOver + (Math.random() - 0.45) * 0.08)
  const ouOdd   = +((1 / mktOver)       * (1 - margin)).toFixed(2)
  const udOdd   = +((1 / (1 - mktOver)) * (1 - margin)).toFixed(2)

  // EV = model_prob × bookmaker_odd - 1 (can be positive)
  const evHome = +(pHome * homeOdd - 1).toFixed(4)
  const evAway = +(pAway * awayOdd - 1).toFixed(4)
  const evOver = +(pOver * ouOdd - 1).toFixed(4)
  const best = [
    { key: 'home', ev: evHome, odd: homeOdd },
    { key: 'away', ev: evAway, odd: awayOdd },
    { key: 'over', ev: evOver, odd: ouOdd },
  ].reduce((a, b) => a.ev > b.ev ? a : b)

  return {
    homeOdd, awayOdd, ouOdd, udOdd,
    pHome, pAway, pOver,
    bestMarket: best.key,
    bestOdd: best.odd,
    ev: Math.max(0, best.ev),
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

/** Check if Supabase data is usable: needs real team names + non-symmetric odds */
function isGoodData(matches: any[]): boolean {
  if (!matches || matches.length === 0) return false
  const withNames = matches.filter((m: any) => m.home_team?.name && m.away_team?.name)
  if (withNames.length === 0) return false
  // Detect symmetric 1.90/1.90 odds (indicates null team names during odds generation)
  const symmetric = withNames.filter((m: any) => {
    const ho = m.odds?.find((o: any) => o.selection === 'home')?.odd_value
    const ao = m.odds?.find((o: any) => o.selection === 'away')?.odd_value
    return ho && ao && Math.abs(ho - ao) < 0.02
  })
  // If >60% are symmetric, data pipeline failed → use ESPN instead
  return symmetric.length / withNames.length < 0.60
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    // 1. Try Supabase (real scraped data) with quality gate
    const sbMatches = await getMatchesFromSupabase()
    if (sbMatches && isGoodData(sbMatches)) {
      // Extra dedup by team names only (handles clock-drift duplicates from multiple scraper runs)
      const seen = new Set<string>()
      const deduped = sbMatches.filter((m: any) => {
        const key = `${m.home_team?.name || ''}-${m.away_team?.name || ''}`
        if (!key || key === '-') return false  // skip empty-name matches
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (deduped.length > 0) {
        return NextResponse.json({ matches: deduped, source: 'supabase', count: deduped.length })
      }
    }

    // 2. ESPN fallback — always has real team names and varied odds
    const espnMatches = await getMatchesFromESPN()
    // Dedup ESPN results too (same team pair shouldn't appear twice)
    const seen = new Set<string>()
    const espnDeduped = espnMatches.filter((m: any) => {
      const key = `${m.home_team?.name || ''}-${m.away_team?.name || ''}`
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    return NextResponse.json({ matches: espnDeduped, source: 'espn', count: espnDeduped.length })
  } catch (err) {
    console.error('[/api/nba/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
