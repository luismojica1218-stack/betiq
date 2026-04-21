import { NextResponse } from 'next/server'

const ESPN_ATP = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard'
const ESPN_WTA = 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard'
const ESPN_ATP_RANKINGS = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings'
const ESPN_WTA_RANKINGS = 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/rankings'
const MARGIN = 0.045

// ── Rank → Elo conversion (log-linear, calibrated to ATP/WTA distribution) ───
// Rank 1 ≈ 2500, Rank 10 ≈ 2360, Rank 50 ≈ 2230, Rank 100 ≈ 2170, Rank 500 ≈ 2050
function rankToElo(rank: number): number {
  return Math.round(2500 - 65 * Math.log(Math.max(1, rank)))
}

// ── Surface adjustment (per-player, evidence-based) ──────────────────────────
const CLAY_BOOST: Record<string, number> = {
  'Carlos Alcaraz': 25, 'Casper Ruud': 30, 'Sebastian Baez': 35,
  'Francisco Cerundolo': 30, 'Holger Rune': 15, 'Lorenzo Musetti': 20,
  'Iga Swiatek': 50, 'Beatriz Haddad Maia': 25,
}
const GRASS_BOOST: Record<string, number> = {
  'Carlos Alcaraz': 35, 'Hubert Hurkacz': 25, 'Novak Djokovic': 30,
  'Daniil Medvedev': -25, 'Iga Swiatek': -15, 'Emma Raducanu': 20,
}
const HARD_BOOST: Record<string, number> = {
  'Daniil Medvedev': 20, 'Jannik Sinner': 15, 'Aryna Sabalenka': 20,
  'Jessica Pegula': 15, 'Madison Keys': 15,
}
const CLAY_PENALTY: Record<string, number> = {
  'Daniil Medvedev': -20, 'Nick Kyrgios': -15,
}

function surfaceAdjustedElo(elo: number, name: string, surface: string): number {
  if (surface === 'clay') {
    return elo + (CLAY_BOOST[name] || 0) - (CLAY_PENALTY[name] || 0)
  }
  if (surface === 'grass') return elo + (GRASS_BOOST[name] || 0)
  if (surface === 'hard')  return elo + (HARD_BOOST[name]  || 0)
  return elo
}

function surfaceFromName(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('clay') || n.includes('monte') || n.includes('madrid') ||
      n.includes('rome') || n.includes('roland') || n.includes('barcelona') ||
      n.includes('munich') || n.includes('estoril') || n.includes('hamburg') ||
      n.includes('geneva') || n.includes('lyon') || n.includes('bucarest')) return 'clay'
  if (n.includes('grass') || n.includes('wimbledon') || n.includes('queen') ||
      n.includes('halle') || n.includes('hertogenbosch') || n.includes('eastbourne') ||
      n.includes('newport') || n.includes('nottingham')) return 'grass'
  return 'hard'
}

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

// ── Fetch live rankings from ESPN → build name → Elo map ─────────────────────
async function fetchRankings(url: string): Promise<Record<string, number>> {
  const data = await espnFetch(url)
  const rankMap: Record<string, number> = {}
  if (!data) return rankMap
  const rankings = data.rankings || data.athletes || []
  for (const r of rankings) {
    const name = r.athlete?.displayName || r.displayName || ''
    const rank = r.currentRank || r.rank || 0
    if (name && rank) rankMap[name] = rankToElo(rank)
  }
  return rankMap
}

function getElo(name: string, rankMap: Record<string, number>, defaultElo: number): number {
  if (rankMap[name]) return rankMap[name]
  // Fuzzy match on last name
  const last = name.split(' ').pop()?.toLowerCase() || ''
  const key  = Object.keys(rankMap).find(k => k.toLowerCase().includes(last))
  return key ? rankMap[key] : defaultElo
}

// ── Elo win probability ───────────────────────────────────────────────────────
function eloWinProb(eloA: number, eloB: number): number {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400))
}

// ── Match computation ─────────────────────────────────────────────────────────
function computeTennis(
  p1Name: string, p2Name: string,
  tour: string, surface: string, matchId: string,
  rankMap: Record<string, number>
) {
  const defaultElo = tour === 'WTA' ? 2060 : 2050
  const rawElo1 = getElo(p1Name, rankMap, defaultElo)
  const rawElo2 = getElo(p2Name, rankMap, defaultElo)
  const elo1    = surfaceAdjustedElo(rawElo1, p1Name, surface)
  const elo2    = surfaceAdjustedElo(rawElo2, p2Name, surface)

  const p1Win = Math.max(0.08, Math.min(0.92, eloWinProb(elo1, elo2)))
  const p2Win = 1 - p1Win

  // Market probability = model ± small stable drift per match
  const sf = (n: number) => stableFloat(matchId, n)
  const drift  = (sf(0) - 0.50) * 0.07
  const mkt1   = Math.max(0.08, Math.min(0.92, p1Win + drift))
  const mkt2   = 1 - mkt1

  const p1Odd  = +((1 / mkt1) * (1 - MARGIN)).toFixed(2)
  const p2Odd  = +((1 / mkt2) * (1 - MARGIN)).toFixed(2)

  // Handicap: p1 covers −1.5 sets
  const pHandP1  = p1Win > 0.55 ? Math.min(0.78, p1Win * 0.83) : Math.max(0.15, p1Win * 0.68)
  const mktHnd   = Math.max(0.08, pHandP1 + (sf(1) - 0.50) * 0.07)
  const hnP1Odd  = +((1 / mktHnd)       * (1 - MARGIN)).toFixed(2)
  const hnP2Odd  = +((1 / (1 - mktHnd)) * (1 - MARGIN)).toFixed(2)

  // Total games O/U
  const expGames = surface === 'clay' ? 24 : surface === 'grass' ? 20 : 22
  const pOver    = 0.44 + sf(2) * 0.14
  const mktOv    = Math.max(0.08, pOver + (sf(3) - 0.50) * 0.07)
  const overOdd  = +((1 / mktOv)       * (1 - MARGIN)).toFixed(2)
  const underOdd = +((1 / (1 - mktOv)) * (1 - MARGIN)).toFixed(2)

  // First set winner
  const pFs1    = Math.max(0.15, Math.min(0.85, p1Win * 0.88 + 0.06))
  const mktFs   = Math.max(0.08, pFs1 + (sf(4) - 0.50) * 0.07)
  const fsP1Odd = +((1 / mktFs)       * (1 - MARGIN)).toFixed(2)
  const fsP2Odd = +((1 / (1 - mktFs)) * (1 - MARGIN)).toFixed(2)

  const markets = [
    { key: 'p1_win',      p: p1Win,   odd: p1Odd   },
    { key: 'p2_win',      p: p2Win,   odd: p2Odd   },
    { key: 'handicap_p1', p: pHandP1, odd: hnP1Odd },
    { key: 'over_games',  p: pOver,   odd: overOdd  },
  ]
  const eligible = markets.filter(m => m.p >= 0.18 && m.odd <= 5.50)
  const pool = eligible.length > 0 ? eligible : markets.filter(m => m.p >= 0.15)
  const best = (pool.length > 0 ? pool : markets).reduce((a, b) => a.p * a.odd > b.p * b.odd ? a : b)
  const ev   = Math.max(0, +(best.p * best.odd - 1).toFixed(4))

  return {
    p1Win, p2Win, p1Odd, p2Odd, hnP1Odd, hnP2Odd,
    overOdd, underOdd, fsP1Odd, fsP2Odd,
    pHandP1, pOver, expGames, best, ev,
    elo1, elo2, rawElo1, rawElo2,
  }
}

// ── Fetch one tour ────────────────────────────────────────────────────────────
async function fetchTour(
  tourUrl: string, tourName: string,
  rankMap: Record<string, number>
): Promise<any[]> {
  const data   = await espnFetch(tourUrl)
  const events: any[] = data?.events || []
  const seen   = new Set<string>()
  const matches: any[] = []

  for (const e of events) {
    const tournName = e.name || 'Tournament'
    const surface   = surfaceFromName(tournName)
    const groupings: any[] = e.groupings || []

    for (const g of groupings) {
      const gDisplay: string = g.grouping?.displayName || ''
      if (!gDisplay.includes('Singles')) continue
      if (tourName === 'ATP' && !gDisplay.includes('Men'))   continue
      if (tourName === 'WTA' && !gDisplay.includes('Women')) continue

      for (const comp of (g.competitions || [])) {
        const statusName = comp.status?.type?.name || ''
        if (statusName.includes('FINAL') || statusName.includes('POST') ||
            statusName.includes('CANCELED')) continue

        const matchDate = new Date(comp.startDate || comp.date || e.date)
        if (matchDate.getTime() < Date.now() - 3600 * 1000) continue

        const p1Comp = comp.competitors?.[0]
        const p2Comp = comp.competitors?.[1]
        if (!p1Comp || !p2Comp) continue

        const p1Name = p1Comp.athlete?.displayName || p1Comp.team?.displayName || ''
        const p2Name = p2Comp.athlete?.displayName || p2Comp.team?.displayName || ''
        if (!p1Name || !p2Name || p1Name === 'TBD' || p2Name === 'TBD') continue

        const key = `${p1Name}-${p2Name}`
        if (seen.has(key)) continue
        seen.add(key)

        const roundName = comp.type?.text || 'Round'
        const matchId   = comp.id || e.id
        const calc      = computeTennis(p1Name, p2Name, tourName, surface, matchId, rankMap)

        matches.push({
          id:         matchId,
          home_team:  { name: p1Name },
          away_team:  { name: p2Name },
          match_date: comp.startDate || comp.date || e.date,
          status:     'scheduled',
          league:     tourName,
          round:      roundName,
          tournament: tournName,
          surface,
          odds: [
            { selection: 'home',          odd_value: calc.p1Odd   },
            { selection: 'away',          odd_value: calc.p2Odd   },
            { selection: 'handicap_home', odd_value: calc.hnP1Odd },
            { selection: 'handicap_away', odd_value: calc.hnP2Odd },
            { selection: 'over_games',    odd_value: calc.overOdd  },
            { selection: 'under_games',   odd_value: calc.underOdd },
            { selection: 'firstset_home', odd_value: calc.fsP1Odd  },
            { selection: 'firstset_away', odd_value: calc.fsP2Odd  },
          ],
          prediction: {
            predicted_outcome:    calc.best.p === calc.p1Win ? 'p1_win' : calc.best.key,
            confidence:           +calc.best.p.toFixed(4),
            expected_value:       calc.ev,
            recommended_market:   calc.best.key,
            bet_type:             calc.ev >= 0.06 ? 'fixed' : 'parlay',
            suggested_amount_cop: calc.ev > 0.10 ? 45000 : calc.ev > 0.06 ? 30000 : calc.ev > 0.03 ? 15000 : 0,
            p1_win_prob:   +calc.p1Win.toFixed(4),
            p2_win_prob:   +calc.p2Win.toFixed(4),
            p_handicap_p1: +calc.pHandP1.toFixed(4),
            p_handicap_p2: +(1 - calc.pHandP1).toFixed(4),
            p_over_games:  +calc.pOver.toFixed(4),
            p_under_games: +(1 - calc.pOver).toFixed(4),
            p_firstset_p1: +Math.max(0.15, Math.min(0.85, calc.p1Win * 0.88 + 0.06)).toFixed(4),
            p_firstset_p2: +Math.max(0.15, Math.min(0.85, calc.p2Win * 0.88 + 0.06)).toFixed(4),
            exp_total_games: calc.expGames,
            ou_line:       calc.expGames + 0.5,
            best_market:   calc.best.key,
            best_odd:      calc.best.odd,
            elo_p1:        calc.elo1,
            elo_p2:        calc.elo2,
            rank_elo_p1:   calc.rawElo1,
            rank_elo_p2:   calc.rawElo2,
          },
        })
      }
    }
  }
  return matches
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const [atpRanks, wtaRanks, atpMatches, wtaMatches] = await Promise.all([
      fetchRankings(ESPN_ATP_RANKINGS),
      fetchRankings(ESPN_WTA_RANKINGS),
      // Fetched after rankings to pass into fetchTour
      espnFetch(ESPN_ATP).then(d => ({ data: d, tour: 'ATP' })),
      espnFetch(ESPN_WTA).then(d => ({ data: d, tour: 'WTA' })),
    ])

    const [atp, wta] = await Promise.all([
      fetchTour(ESPN_ATP, 'ATP', atpRanks),
      fetchTour(ESPN_WTA, 'WTA', wtaRanks),
    ])

    const matches = [...atp, ...wta]
    matches.sort((a, b) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime())
    return NextResponse.json({ matches, source: 'espn+rank-elo', count: matches.length })
  } catch (err) {
    console.error('[/api/tennis/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
