import { NextResponse } from 'next/server'

// ── League-specific calibration (historical averages, real data) ──────────────
// avgHome / avgAway = expected goals per team per game at home / away
// rho = Dixon-Coles low-score correction (negative = fewer 0-0 than Poisson predicts)
const LEAGUE_PARAMS: Record<string, { avgHome: number; avgAway: number; rho: number }> = {
  'eng.1':                 { avgHome: 1.53, avgAway: 1.15, rho: -0.13 },
  'esp.1':                 { avgHome: 1.45, avgAway: 1.09, rho: -0.10 },
  'ger.1':                 { avgHome: 1.68, avgAway: 1.29, rho: -0.11 },
  'ita.1':                 { avgHome: 1.29, avgAway: 0.97, rho: -0.12 },
  'fra.1':                 { avgHome: 1.38, avgAway: 1.04, rho: -0.10 },
  'uefa.champions':        { avgHome: 1.55, avgAway: 1.10, rho: -0.12 },
  'conmebol.libertadores': { avgHome: 1.45, avgAway: 0.95, rho: -0.10 },
  'conmebol.sudamericana': { avgHome: 1.40, avgAway: 0.90, rho: -0.10 },
}
const DEFAULT_PARAMS = { avgHome: 1.42, avgAway: 1.05, rho: -0.11 }

// Bookmaker margin per market
const MARGIN = 0.05

const LEAGUES: Array<{ key: string; name: string; espnSlug: string }> = [
  { key: 'champions-league', name: 'Champions League', espnSlug: 'uefa.champions'         },
  { key: 'premier-league',   name: 'Premier League',   espnSlug: 'eng.1'                  },
  { key: 'la-liga',          name: 'La Liga',           espnSlug: 'esp.1'                  },
  { key: 'bundesliga',       name: 'Bundesliga',        espnSlug: 'ger.1'                  },
  { key: 'serie-a',          name: 'Serie A',           espnSlug: 'ita.1'                  },
  { key: 'ligue-1',          name: 'Ligue 1',           espnSlug: 'fra.1'                  },
  { key: 'libertadores',     name: 'Copa Libertadores', espnSlug: 'conmebol.libertadores'  },
  { key: 'copa-sudamericana',name: 'Copa Sudamericana', espnSlug: 'conmebol.sudamericana'  },
]

// ── Deterministic drift per match (stable odds across requests) ───────────────
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

// ── Team quality ──────────────────────────────────────────────────────────────
interface FootballTeamQ {
  goalsFor:     number  // per game (raw)
  goalsAgainst: number  // per game (raw)
  winRate:      number
  drawRate:     number
  gp:           number  // games played (for Bayesian shrinkage)
}

async function fetchFootballStandings(espnSlug: string): Promise<Record<string, FootballTeamQ>> {
  const data = await espnFetch(`https://site.api.espn.com/apis/v2/sports/soccer/${espnSlug}/standings`)
  const quality: Record<string, FootballTeamQ> = {}
  if (!data) return quality

  const children = data.children || [data]
  for (const child of children) {
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
      const gp    = get(['gamesPlayed', 'GP']) || 1
      const wins  = get(['wins', 'W'])          || 0
      const draws = get(['ties', 'D', 'draws']) || 0
      const gfRaw = get(['pointsFor',     'GF', 'goalsFor'])
      const gaRaw = get(['pointsAgainst', 'GA', 'goalsAgainst'])
      quality[name] = {
        goalsFor:     gfRaw !== null ? Math.max(0.05, +(gfRaw / gp).toFixed(3)) : -1,
        goalsAgainst: gaRaw !== null ? Math.max(0.05, +(gaRaw / gp).toFixed(3)) : -1,
        winRate:  +(wins  / gp).toFixed(3),
        drawRate: +(draws / gp).toFixed(3),
        gp,
      }
    }
  }
  return quality
}

// ── Bayesian shrinkage: pull raw value toward league mean for small samples ───
// k = prior weight in "games" (higher = more shrinkage)
function shrink(rawPerGame: number, gp: number, leagueMean: number, k = 10): number {
  if (rawPerGame < 0) return leagueMean   // no data → league mean
  return (rawPerGame * gp + leagueMean * k) / (gp + k)
}

// ── Poisson probability P(X=k) ────────────────────────────────────────────────
function poissonP(lam: number, k: number): number {
  let p = Math.exp(-lam)
  for (let i = 1; i <= k; i++) p *= lam / i
  return p
}

// ── Dixon-Coles tau correction (adjusts joint probabilities for 0/1 scores) ──
function tau(x: number, y: number, lH: number, lA: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lH * lA * rho
  if (x === 1 && y === 0) return 1 + lA * rho
  if (x === 0 && y === 1) return 1 + lH * rho
  if (x === 1 && y === 1) return 1 - rho
  return 1
}

function matchProbs(lamH: number, lamA: number, rho: number) {
  const MAX = 8
  let pHome = 0, pDraw = 0, pAway = 0
  for (let i = 0; i < MAX; i++) {
    for (let j = 0; j < MAX; j++) {
      const p = poissonP(lamH, i) * poissonP(lamA, j) * tau(i, j, lamH, lamA, rho)
      if (i > j) pHome += p
      else if (i === j) pDraw += p
      else pAway += p
    }
  }
  // Renormalize after tau distortion
  const total = pHome + pDraw + pAway
  return { pHome: pHome/total, pDraw: pDraw/total, pAway: pAway/total }
}

// ── Compute all markets for a match ──────────────────────────────────────────
function computeFootball(
  homeQ: FootballTeamQ, awayQ: FootballTeamQ,
  matchId: string, slug: string
) {
  const lp = LEAGUE_PARAMS[slug] || DEFAULT_PARAMS
  const leagueAvg = (lp.avgHome + lp.avgAway) / 2

  // Bayesian-shrunk attack/defense strengths (relative to league average)
  const homeAtt = shrink(homeQ.goalsFor,     homeQ.gp, leagueAvg) / leagueAvg
  const homeDef = shrink(homeQ.goalsAgainst, homeQ.gp, leagueAvg) / leagueAvg
  const awayAtt = shrink(awayQ.goalsFor,     awayQ.gp, leagueAvg) / leagueAvg
  const awayDef = shrink(awayQ.goalsAgainst, awayQ.gp, leagueAvg) / leagueAvg

  // Expected goals (Dixon-Coles style)
  const lamH = Math.max(0.15, homeAtt * awayDef * lp.avgHome)
  const lamA = Math.max(0.15, awayAtt * homeDef * lp.avgAway)

  const { pHome: pH, pDraw: pD, pAway: pA } = matchProbs(lamH, lamA, lp.rho)

  // Over 2.5
  let pOver = 0
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++)
      if (i + j > 2) pOver += poissonP(lamH, i) * poissonP(lamA, j)
  pOver = Math.min(0.97, Math.max(0.03, pOver))

  // BTTS
  const pBtts = Math.min(0.95, Math.max(0.05,
    (1 - poissonP(lamH, 0)) * (1 - poissonP(lamA, 0))
  ))

  // Expected total goals
  const expGoals = +(lamH + lamA).toFixed(1)

  // Market probabilities = model ± small stable drift
  const d = (n: number) => (stableFloat(matchId, n) - 0.50) * 0.06
  const mktH  = Math.max(0.05, Math.min(0.88, pH   + d(0)))
  const mktD  = Math.max(0.05, Math.min(0.60, pD   + d(1)))
  const mktA  = Math.max(0.05, 1 - mktH - mktD)
  const mktOv = Math.max(0.05, Math.min(0.95, pOver + d(2)))
  const mktBt = Math.max(0.05, Math.min(0.95, pBtts + d(3)))

  const homeOdd  = +((1 / mktH)        * (1 - MARGIN)).toFixed(2)
  const drawOdd  = +((1 / mktD)        * (1 - MARGIN)).toFixed(2)
  const awayOdd  = +((1 / mktA)        * (1 - MARGIN)).toFixed(2)
  const overOdd  = +((1 / mktOv)       * (1 - MARGIN)).toFixed(2)
  const underOdd = +((1 / (1 - mktOv)) * (1 - MARGIN)).toFixed(2)
  const bttsYes  = +((1 / mktBt)       * (1 - MARGIN)).toFixed(2)
  const bttsNo   = +((1 / (1 - mktBt)) * (1 - MARGIN)).toFixed(2)

  // EV per market: model_prob × bookmaker_odd − 1
  const markets = [
    { market: 'home_win', label: 'Victoria local',  p: pH,    odd: homeOdd },
    { market: 'draw',     label: 'Empate',          p: pD,    odd: drawOdd },
    { market: 'away_win', label: 'Victoria visitante', p: pA, odd: awayOdd },
    { market: 'over_2.5', label: 'Más de 2.5 goles', p: pOver, odd: overOdd },
    { market: 'btts_yes', label: 'Ambos marcan',    p: pBtts, odd: bttsYes },
  ]
  // Only recommend bets with reasonable probability and odds (avoid long shots)
  const eligible = markets.filter(m => m.p >= 0.18 && m.odd <= 5.50)
  const pool = eligible.length > 0 ? eligible : markets.filter(m => m.p >= 0.15)
  const best = (pool.length > 0 ? pool : markets).reduce((a, b) => (a.p * a.odd > b.p * b.odd ? a : b))
  const ev   = Math.max(0, +(best.p * best.odd - 1).toFixed(4))

  return {
    homeOdd, drawOdd, awayOdd, overOdd, underOdd, bttsYes, bttsNo,
    pH: +pH.toFixed(4), pD: +pD.toFixed(4), pA: +pA.toFixed(4),
    pOver: +pOver.toFixed(4), pBtts: +pBtts.toFixed(4),
    expGoals, lamH: +lamH.toFixed(2), lamA: +lamA.toFixed(2),
    best, ev,
  }
}

const DEFAULT_Q: FootballTeamQ = {
  goalsFor: -1, goalsAgainst: -1, winRate: 0.33, drawRate: 0.28, gp: 0,
}

function findFootballQ(name: string, standings: Record<string, FootballTeamQ>): FootballTeamQ {
  if (standings[name]) return standings[name]
  const lc = name.toLowerCase()
  const key = Object.keys(standings).find(k => {
    const kl = k.toLowerCase()
    return kl.includes(lc) || lc.includes(kl) ||
      kl.split(' ').some(w => w.length > 3 && lc.includes(w)) ||
      lc.split(' ').some(w => w.length > 3 && kl.includes(w))
  })
  return key ? standings[key] : DEFAULT_Q
}

// ── Fetch one league ──────────────────────────────────────────────────────────
async function fetchLeague(league: { key: string; name: string; espnSlug: string }): Promise<any[]> {
  const today = new Date()
  const end   = new Date(Date.now() + 10 * 86_400_000)
  const fmt   = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`

  const [scoreboardData, standingsData] = await Promise.all([
    espnFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/scoreboard?dates=${fmt(today)}-${fmt(end)}`),
    fetchFootballStandings(league.espnSlug),
  ])

  const seen = new Set<string>()
  const matches: any[] = []

  for (const e of (scoreboardData?.events || [])) {
    const comp = e.competitions?.[0]
    if (!comp) continue
    const homeC = comp.competitors?.find((c: any) => c.homeAway === 'home')
    const awayC = comp.competitors?.find((c: any) => c.homeAway === 'away')
    if (!homeC || !awayC) continue
    const homeName = homeC.team?.displayName || homeC.team?.name || ''
    const awayName = awayC.team?.displayName || awayC.team?.name || ''
    if (!homeName || !awayName) continue

    const key = `${homeName}-${awayName}`
    if (seen.has(key)) continue
    seen.add(key)

    const statusName = comp.status?.type?.name || ''
    if (statusName.includes('FINAL') || statusName.includes('POST')) continue

    const homeQ = findFootballQ(homeName, standingsData)
    const awayQ = findFootballQ(awayName, standingsData)
    const calc  = computeFootball(homeQ, awayQ, e.id, league.espnSlug)

    matches.push({
      id:          e.id,
      home_team:   { name: homeName, logo: homeC.team?.logo || null },
      away_team:   { name: awayName, logo: awayC.team?.logo || null },
      match_date:  e.date,
      status:      statusName.includes('IN_PROGRESS') ? 'live' : 'scheduled',
      league:      league.name,
      league_slug: league.key,
      odds: [
        { selection: 'home',      odd_value: calc.homeOdd  },
        { selection: 'draw',      odd_value: calc.drawOdd  },
        { selection: 'away',      odd_value: calc.awayOdd  },
        { selection: 'over_2.5',  odd_value: calc.overOdd  },
        { selection: 'under_2.5', odd_value: calc.underOdd },
        { selection: 'btts_yes',  odd_value: calc.bttsYes  },
        { selection: 'btts_no',   odd_value: calc.bttsNo   },
      ],
      prediction: {
        predicted_outcome:    calc.best.market,
        confidence:           +calc.best.p.toFixed(4),
        expected_value:       calc.ev,
        recommended_market:   calc.best.market,
        bet_type:             calc.ev >= 0.06 ? 'fixed' : 'parlay',
        suggested_amount_cop: calc.ev > 0.08 ? 40000 : calc.ev > 0.05 ? 25000 : calc.ev > 0.02 ? 12000 : 0,
        p_home:      calc.pH,
        p_draw:      calc.pD,
        p_away:      calc.pA,
        p_over:      calc.pOver,
        p_btts:      calc.pBtts,
        exp_goals:   calc.expGoals,
        xg_home:     calc.lamH,
        xg_away:     calc.lamA,
        best_market: calc.best.market,
        best_odd:    calc.best.odd,
      },
    })
  }
  return matches
}

export async function GET() {
  try {
    const results = await Promise.all(LEAGUES.map(fetchLeague))
    const matches = results.flat()
    matches.sort((a, b) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime())
    return NextResponse.json({ matches, source: 'espn+dixon-coles', count: matches.length })
  } catch (err) {
    console.error('[/api/football/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
