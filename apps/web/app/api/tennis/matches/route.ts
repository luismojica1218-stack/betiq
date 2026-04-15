import { NextResponse } from 'next/server'

// ── Static ATP/WTA Elo ratings (updated periodically) ────────────────────────
// Approximate Elo for top players. Used when ESPN player data is available.
const ATP_ELO: Record<string, number> = {
  'Jannik Sinner': 2420, 'Carlos Alcaraz': 2390, 'Novak Djokovic': 2340,
  'Alexander Zverev': 2280, 'Daniil Medvedev': 2270, 'Andrey Rublev': 2210,
  'Casper Ruud': 2190, 'Hubert Hurkacz': 2180, 'Taylor Fritz': 2170,
  'Tommy Paul': 2160, 'Ben Shelton': 2150, 'Grigor Dimitrov': 2140,
  'Holger Rune': 2130, 'Stefanos Tsitsipas': 2120, 'Alex De Minaur': 2110,
  'Frances Tiafoe': 2100, 'Sebastian Baez': 2090, 'Felix Auger-Aliassime': 2080,
  'Francisco Cerundolo': 2070, 'Lorenzo Musetti': 2060,
}
const WTA_ELO: Record<string, number> = {
  'Aryna Sabalenka': 2380, 'Iga Swiatek': 2360, 'Coco Gauff': 2290,
  'Elena Rybakina': 2260, 'Jessica Pegula': 2220, 'Madison Keys': 2180,
  'Barbora Krejcikova': 2170, 'Jasmine Paolini': 2160, 'Mirra Andreeva': 2150,
  'Daria Kasatkina': 2140, 'Emma Navarro': 2130, 'Anna Kalinskaya': 2120,
  'Danielle Collins': 2110, 'Paula Badosa': 2100, 'Elina Svitolina': 2090,
  'Beatriz Haddad Maia': 2080, 'Donna Vekic': 2070, 'Liudmila Samsonova': 2060,
}

const MARGIN = 0.045
const ESPN_ATP = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard'
const ESPN_WTA = 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard'

async function espnFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, {
      next: { revalidate: 1800 },
      headers: { Accept: 'application/json' },
    })
    return res.ok ? await res.json() : null
  } catch { return null }
}

// ── Elo-based win probability ─────────────────────────────────────────────────
function eloWinProb(eloA: number, eloB: number): number {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400))
}

function getElo(name: string, tour: string): number {
  const table = tour === 'WTA' ? WTA_ELO : ATP_ELO
  if (table[name]) return table[name]
  // Fuzzy match on last name
  const lastName = name.split(' ').pop()?.toLowerCase() || ''
  const key = Object.keys(table).find(k => k.toLowerCase().includes(lastName))
  if (key) return table[key]
  // Unknown player: mid-range
  return tour === 'WTA' ? 2050 : 2040
}

function surfaceFromName(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('clay') || n.includes('monte') || n.includes('madrid') ||
      n.includes('rome') || n.includes('roland') || n.includes('barcelona') ||
      n.includes('munich') || n.includes('estoril') || n.includes('hamburg')) return 'clay'
  if (n.includes('grass') || n.includes('wimbledon') || n.includes('queen') ||
      n.includes('halle') || n.includes("s-hertogenbosch") || n.includes('eastbourne')) return 'grass'
  return 'hard'
}

// Surface Elo adjustment: players have different strengths per surface
function surfaceAdjusted(elo: number, playerName: string, surface: string): number {
  // Simplified: clay specialists get +30 on clay, grass -20, hard 0
  const CLAY_BOOST: Record<string, number>  = {
    'Rafael Nadal': 60, 'Carlos Alcaraz': 20, 'Casper Ruud': 25, 'Iga Swiatek': 40,
    'Sebastian Baez': 30, 'Francisco Cerundolo': 25, 'Holger Rune': 15,
  }
  const GRASS_BOOST: Record<string, number> = {
    'Novak Djokovic': 25, 'Carlos Alcaraz': 30, 'Hubert Hurkacz': 20, 'Daniil Medvedev': -20,
  }
  if (surface === 'clay')  return elo + (CLAY_BOOST[playerName]  || 0)
  if (surface === 'grass') return elo + (GRASS_BOOST[playerName] || 0)
  return elo
}

function computeTennis(p1Name: string, p2Name: string, tour: string, surface: string) {
  const elo1 = surfaceAdjusted(getElo(p1Name, tour), p1Name, surface)
  const elo2 = surfaceAdjusted(getElo(p2Name, tour), p2Name, surface)

  const p1Win = Math.max(0.08, Math.min(0.92, eloWinProb(elo1, elo2)))
  const p2Win = 1 - p1Win

  // Market probability = model ± drift
  const drift  = (Math.random() - 0.45) * 0.10
  const mkt1   = Math.max(0.08, Math.min(0.92, p1Win + drift))
  const mkt2   = 1 - mkt1

  const p1Odd  = +((1 / mkt1) * (1 - MARGIN)).toFixed(2)
  const p2Odd  = +((1 / mkt2) * (1 - MARGIN)).toFixed(2)

  // Handicap (who covers -1.5 sets)
  const pHandP1 = p1Win > 0.55 ? Math.min(0.80, p1Win * 0.85) : Math.max(0.15, p1Win * 0.7)
  const mktHnd  = Math.max(0.08, pHandP1 + (Math.random() - 0.45) * 0.08)
  const hnP1Odd = +((1 / mktHnd) * (1 - MARGIN)).toFixed(2)
  const hnP2Odd = +((1 / (1 - mktHnd)) * (1 - MARGIN)).toFixed(2)

  // Over/under total games
  const expGames = surface === 'clay' ? 23 : surface === 'grass' ? 20 : 21
  const pOver    = 0.45 + Math.random() * 0.15
  const mktOv   = Math.max(0.08, pOver + (Math.random() - 0.45) * 0.08)
  const overOdd  = +((1 / mktOv) * (1 - MARGIN)).toFixed(2)
  const underOdd = +((1 / (1 - mktOv)) * (1 - MARGIN)).toFixed(2)

  // First set winner
  const pFs1  = Math.max(0.15, Math.min(0.85, p1Win * 0.9 + 0.05))
  const mktFs = Math.max(0.08, pFs1 + (Math.random() - 0.45) * 0.08)
  const fsP1Odd = +((1 / mktFs) * (1 - MARGIN)).toFixed(2)
  const fsP2Odd = +((1 / (1 - mktFs)) * (1 - MARGIN)).toFixed(2)

  const markets = [
    { key: 'p1_win',     p: p1Win,  odd: p1Odd  },
    { key: 'p2_win',     p: p2Win,  odd: p2Odd  },
    { key: 'handicap_p1',p: pHandP1,odd: hnP1Odd},
    { key: 'over_games', p: pOver,  odd: overOdd},
  ]
  const best = markets.reduce((a, b) => a.p * a.odd > b.p * b.odd ? a : b)
  const ev   = Math.max(0, +(best.p * best.odd - 1).toFixed(4))

  return {
    p1Win, p2Win, p1Odd, p2Odd, hnP1Odd, hnP2Odd,
    overOdd, underOdd, fsP1Odd, fsP2Odd,
    pHandP1, pOver, expGames, best, ev, elo1, elo2,
  }
}

async function fetchTour(tourUrl: string, tourName: string): Promise<any[]> {
  const today = new Date()
  const end   = new Date(Date.now() + 10 * 86_400_000)
  const fmt   = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`
  const data  = await espnFetch(`${tourUrl}?dates=${fmt(today)}-${fmt(end)}`)
  const events: any[] = data?.events || []

  const seen = new Set<string>()
  const matches: any[] = []

  for (const e of events) {
    const comp  = e.competitions?.[0]
    if (!comp) continue
    const p1Comp = comp.competitors?.[0]
    const p2Comp = comp.competitors?.[1]
    if (!p1Comp || !p2Comp) continue

    const p1Name = p1Comp.athlete?.displayName || p1Comp.team?.displayName || ''
    const p2Name = p2Comp.athlete?.displayName || p2Comp.team?.displayName || ''
    if (!p1Name || !p2Name) continue

    const key = `${p1Name}-${p2Name}`
    if (seen.has(key)) continue
    seen.add(key)

    const statusName = comp.status?.type?.name || ''
    if (statusName.includes('FINAL') || statusName.includes('POST')) continue

    const tournName = e.season?.slug || e.name || 'Tournament'
    const roundName = comp.type?.text || comp.notes?.[0]?.headline || 'Round'
    const surface   = surfaceFromName(tournName)
    const calc      = computeTennis(p1Name, p2Name, tourName, surface)

    matches.push({
      id:         e.id,
      home_team:  { name: p1Name },
      away_team:  { name: p2Name },
      match_date: e.date,
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
        { selection: 'over_games',    odd_value: calc.overOdd },
        { selection: 'under_games',   odd_value: calc.underOdd},
        { selection: 'firstset_home', odd_value: calc.fsP1Odd },
        { selection: 'firstset_away', odd_value: calc.fsP2Odd },
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
        p_firstset_p1: +Math.max(0.15, Math.min(0.85, calc.p1Win * 0.9 + 0.05)).toFixed(4),
        p_firstset_p2: +Math.max(0.15, Math.min(0.85, calc.p2Win * 0.9 + 0.05)).toFixed(4),
        exp_total_games: calc.expGames,
        ou_line:       22.5,
        best_market:   calc.best.key,
        best_odd:      calc.best.odd,
        elo_p1:        calc.elo1,
        elo_p2:        calc.elo2,
      },
    })
  }
  return matches
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const [atpMatches, wtaMatches] = await Promise.all([
      fetchTour(ESPN_ATP, 'ATP'),
      fetchTour(ESPN_WTA, 'WTA'),
    ])
    const matches = [...atpMatches, ...wtaMatches]
    matches.sort((a, b) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime())
    return NextResponse.json({ matches, source: 'espn+elo', count: matches.length })
  } catch (err) {
    console.error('[/api/tennis/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
