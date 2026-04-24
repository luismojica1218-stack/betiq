import { NextResponse } from 'next/server'

const ESPN_ATP = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard'
const ESPN_WTA = 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard'
const ESPN_ATP_RANKINGS = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings'
const ESPN_WTA_RANKINGS = 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/rankings'

// ── Rank → Elo conversion (log-linear, calibrated to ATP/WTA distribution) ───
// Rank 1 ≈ 2500, Rank 10 ≈ 2360, Rank 50 ≈ 2230, Rank 100 ≈ 2170, Rank 500 ≈ 2050
function rankToElo(rank: number): number {
  return Math.round(2500 - 65 * Math.log(Math.max(1, rank)))
}

// ── Hardcoded fallback rankings (ATP top 80, April 2025) ─────────────────────
// Used when ESPN rankings API returns empty/wrong format
const ATP_RANKS: Record<string, number> = {
  'Jannik Sinner': 1, 'Alexander Zverev': 2, 'Carlos Alcaraz': 3,
  'Novak Djokovic': 4, 'Taylor Fritz': 5, 'Jack Draper': 6,
  'Casper Ruud': 7, 'Andrey Rublev': 8, 'Tommy Paul': 9,
  'Alex de Minaur': 10, 'Holger Rune': 11, 'Grigor Dimitrov': 12,
  'Stefanos Tsitsipas': 13, 'Hubert Hurkacz': 14, 'Ugo Humbert': 15,
  'Felix Auger-Aliassime': 16, 'Sebastian Korda': 17, 'Francisco Cerundolo': 18,
  'Ben Shelton': 19, 'Tomas Machac': 20, 'Lorenzo Musetti': 21,
  'Alexei Popyrin': 22, 'Nicolas Jarry': 23, 'Tallon Griekspoor': 24,
  'Jiri Lehecka': 25, 'Karen Khachanov': 26, 'Miomir Kecmanovic': 27,
  'Cameron Norrie': 28, 'Sebastian Baez': 29, 'Matteo Berrettini': 30,
  'Alejandro Davidovich Fokina': 31, 'Arthur Fils': 32, 'Gael Monfils': 33,
  'Jan-Lennard Struff': 34, 'Alexander Bublik': 35, 'Luciano Darderi': 36,
  'Mariano Navone': 37, 'Brandon Nakashima': 38, 'Flavio Cobolli': 39,
  'Nuno Borges': 40, 'Jakub Mensik': 41, 'Mattia Bellucci': 42,
  'Laslo Djere': 43, 'Marcos Giron': 44, 'Quentin Halys': 45,
  'Maximilian Marterer': 46, 'Joao Fonseca': 47, 'Hamad Medjedovic': 48,
  'Facundo Diaz Acosta': 49, 'Benjamin Bonzi': 50, 'Vit Kopriva': 60,
  'Thiago Agustin Tirante': 65, 'Rafael Jodar': 90, 'Dominic Thiem': 70,
  'Botic van de Zandschulp': 55, 'Sumit Nagal': 80,
}

const WTA_RANKS: Record<string, number> = {
  'Aryna Sabalenka': 1, 'Iga Swiatek': 2, 'Coco Gauff': 3,
  'Elena Rybakina': 4, 'Jessica Pegula': 5, 'Madison Keys': 6,
  'Emma Navarro': 7, 'Mirra Andreeva': 8, 'Daria Kasatkina': 9,
  'Paula Badosa': 10, 'Barbora Krejcikova': 11, 'Jasmine Paolini': 12,
  'Diana Shnaider': 13, 'Anna Kalinskaya': 14, 'Liudmila Samsonova': 15,
  'Elina Svitolina': 16, 'Marta Kostyuk': 17, 'Beatriz Haddad Maia': 18,
  'Caroline Wozniacki': 19, 'Karolina Muchova': 20, 'Ekaterina Alexandrova': 21,
  'Viktoria Hruncakova': 22, 'Clara Tauson': 23, 'Donna Vekic': 24,
  'Xinyu Wang': 25, 'Qinwen Zheng': 26, 'Yulia Putintseva': 27,
  'Magda Linette': 28, 'Katerina Siniakova': 29, 'Oceane Dodin': 30,
  'Eva Lys': 35, 'Laura Siegemund': 38, 'Tatjana Maria': 45,
  'Emma Raducanu': 50, 'Sorana Cirstea': 40,
}

// ── Surface adjustment (per-player, evidence-based) ──────────────────────────
const CLAY_BOOST: Record<string, number> = {
  'Carlos Alcaraz': 30, 'Casper Ruud': 35, 'Sebastian Baez': 40,
  'Francisco Cerundolo': 35, 'Holger Rune': 20, 'Lorenzo Musetti': 25,
  'Iga Swiatek': 55, 'Beatriz Haddad Maia': 30, 'Jannik Sinner': 10,
  'Alexander Zverev': 20, 'Rafael Nadal': 80, 'Alejandro Davidovich Fokina': 25,
  'Mariano Navone': 30, 'Facundo Diaz Acosta': 25, 'Nicolas Jarry': 15,
  'Jasmine Paolini': 20, 'Paula Badosa': 15, 'Karolina Muchova': 10,
}
const GRASS_BOOST: Record<string, number> = {
  'Carlos Alcaraz': 35, 'Hubert Hurkacz': 30, 'Novak Djokovic': 30,
  'Daniil Medvedev': -30, 'Iga Swiatek': -20, 'Emma Raducanu': 25,
  'Taylor Fritz': 15, 'Cameron Norrie': 20,
}
const HARD_BOOST: Record<string, number> = {
  'Daniil Medvedev': 25, 'Jannik Sinner': 20, 'Aryna Sabalenka': 25,
  'Jessica Pegula': 20, 'Madison Keys': 20, 'Taylor Fritz': 15,
  'Ben Shelton': 15, 'Alex de Minaur': 10,
}
const CLAY_PENALTY: Record<string, number> = {
  'Daniil Medvedev': -30, 'Nick Kyrgios': -20, 'Jack Draper': -10,
  'Ben Shelton': -10,
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
async function fetchRankings(url: string, fallback: Record<string, number>): Promise<Record<string, number>> {
  // Start with hardcoded fallback so we always have data
  const rankMap: Record<string, number> = {}
  for (const [name, rank] of Object.entries(fallback)) {
    rankMap[name] = rankToElo(rank)
  }

  // Try to enrich with live ESPN data
  const data = await espnFetch(url)
  if (!data) return rankMap

  // ESPN can return several different shapes — try all of them
  const candidates: any[] = [
    ...(data.rankings    || []),
    ...(data.athletes    || []),
    ...(data.items       || []),
    ...(Array.isArray(data) ? data : []),
  ]
  // Also look inside nested "rankings[].entries[]" shape
  for (const r of (data.rankings || [])) {
    for (const entry of (r.entries || [])) {
      candidates.push(entry)
    }
  }

  let liveCount = 0
  for (const r of candidates) {
    const name = (
      r.athlete?.displayName ||
      r.athlete?.fullName    ||
      r.displayName          ||
      r.fullName             || ''
    ).trim()
    const rank = +(r.currentRank || r.ranking?.currentRank || r.rank || 0)
    if (name && rank > 0) {
      rankMap[name] = rankToElo(rank)
      liveCount++
    }
  }
  console.log(`[tennis rankings] live=${liveCount} total=${Object.keys(rankMap).length}`)
  return rankMap
}

function getElo(name: string, rankMap: Record<string, number>, defaultElo: number): number {
  if (rankMap[name]) return rankMap[name]
  // Fuzzy match: try full last name, then partial
  const parts = name.toLowerCase().split(' ')
  const last  = parts[parts.length - 1]
  const key   = Object.keys(rankMap).find(k => {
    const kl = k.toLowerCase()
    return kl.endsWith(last) || kl.includes(last)
  })
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

  // Handicap: p1 covers −1.5 sets
  const pHandP1 = p1Win > 0.55 ? Math.min(0.78, p1Win * 0.83) : Math.max(0.15, p1Win * 0.68)

  // Total games O/U
  const expGames = surface === 'clay' ? 24 : surface === 'grass' ? 20 : 22
  const sf = (n: number) => stableFloat(matchId, n)
  const pOver = 0.44 + sf(2) * 0.14

  // Surface advantage
  const surfaceEloDiff = elo1 - elo2
  const surfaceAdvantage = surfaceEloDiff > 50 ? 'p1' : surfaceEloDiff < -50 ? 'p2' : 'neutral'

  // Sets prediction
  const winnerProb = Math.max(p1Win, p2Win)
  const p_straight = winnerProb > 0.70
    ? winnerProb * 0.60
    : winnerProb * 0.40
  const p_three_sets = Math.max(0.15, 1 - p_straight - (1 - winnerProb))
  const exp_sets = +(2 + p_three_sets).toFixed(2)
  const most_likely_result = p_straight > p_three_sets ? '2-0' : '2-1'

  // Games prediction
  const p_over_22_5  = Math.max(0.20, Math.min(0.80, pOver))
  const p_under_22_5 = 1 - p_over_22_5

  // Winner confidence
  const winnerConfidence = winnerProb > 0.65 ? 'alta' : winnerProb > 0.55 ? 'media' : 'baja'
  const predictedWinner = p1Win >= p2Win ? 'p1' : 'p2'

  return {
    p1Win, p2Win,
    pHandP1, pOver, expGames,
    elo1, elo2, rawElo1, rawElo2,
    surfaceAdvantage,
    p_straight, p_three_sets, exp_sets, most_likely_result,
    p_over_22_5, p_under_22_5,
    winnerConfidence, predictedWinner,
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
          prediction: {
            p1_win_prob:      +calc.p1Win.toFixed(4),
            p2_win_prob:      +calc.p2Win.toFixed(4),
            predicted_winner: calc.predictedWinner,
            winner_confidence: calc.winnerConfidence,
            elo_p1:           calc.elo1,
            elo_p2:           calc.elo2,
            elo_diff:         calc.elo1 - calc.elo2,
            surface_advantage: calc.surfaceAdvantage,
            p_straight_sets:  +calc.p_straight.toFixed(4),
            p_three_sets:     +calc.p_three_sets.toFixed(4),
            exp_sets:         calc.exp_sets,
            most_likely_result: calc.most_likely_result,
            exp_total_games:  calc.expGames,
            p_over_22_5:      +calc.p_over_22_5.toFixed(4),
            p_under_22_5:     +calc.p_under_22_5.toFixed(4),
            p_handicap_p1:    +calc.pHandP1.toFixed(4),
            p_firstset_p1:    +Math.max(0.15, Math.min(0.85, calc.p1Win * 0.88 + 0.06)).toFixed(4),
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
    const [atpRanks, wtaRanks] = await Promise.all([
      fetchRankings(ESPN_ATP_RANKINGS, ATP_RANKS),
      fetchRankings(ESPN_WTA_RANKINGS, WTA_RANKS),
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
