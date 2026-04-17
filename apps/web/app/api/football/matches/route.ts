import { NextResponse } from 'next/server'

// ── Constants ─────────────────────────────────────────────────────────────────
const ESPN_SOCCER  = 'https://site.api.espn.com/apis/site/v2/sports/soccer'
const ESPN_V2      = 'https://site.api.espn.com/apis/v2/sports/soccer'
const LEAGUE_AVG   = 1.35   // average goals per team per game across top leagues
const MARGIN       = 0.05

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

// ── Fetch helper ──────────────────────────────────────────────────────────────
async function espnFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, {
      next: { revalidate: 1800 },
      headers: { Accept: 'application/json' },
    })
    return res.ok ? await res.json() : null
  } catch { return null }
}

// ── Team quality from ESPN standings ─────────────────────────────────────────
interface FootballTeamQ {
  goalsFor:     number   // goals scored per game
  goalsAgainst: number   // goals conceded per game
  winRate:      number
  drawRate:     number
}

async function fetchFootballStandings(espnSlug: string): Promise<Record<string, FootballTeamQ>> {
  const data = await espnFetch(`${ESPN_V2}/${espnSlug}/standings`)
  const quality: Record<string, FootballTeamQ> = {}
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
      const wins     = get(['wins', 'W'])          || 0
      const draws    = get(['ties', 'D', 'draws']) || 0
      const gf       = get(['pointsFor', 'GF', 'goalsFor'])       || 0
      const ga       = get(['pointsAgainst', 'GA', 'goalsAgainst'])|| 0
      quality[name] = {
        goalsFor:     gf ? +(gf / gp).toFixed(3) : LEAGUE_AVG,
        goalsAgainst: ga ? +(ga / gp).toFixed(3) : LEAGUE_AVG,
        winRate:  +(wins  / gp).toFixed(3),
        drawRate: +(draws / gp).toFixed(3),
      }
    }
  }
  return quality
}

// ── Poisson probability ───────────────────────────────────────────────────────
function poissonProb(lam: number, k: number): number {
  let p = Math.exp(-lam)
  for (let i = 1; i <= k; i++) p *= lam / i
  return p
}

function matchProbs(lamH: number, lamA: number) {
  const MAX = 8
  let pHome = 0, pDraw = 0, pAway = 0
  for (let i = 0; i < MAX; i++) {
    for (let j = 0; j < MAX; j++) {
      const p = poissonProb(lamH, i) * poissonProb(lamA, j)
      if (i > j) pHome += p
      else if (i === j) pDraw += p
      else pAway += p
    }
  }
  return { pHome, pDraw, pAway }
}

// ── Compute EV for football match ─────────────────────────────────────────────
function computeFootball(homeQ: FootballTeamQ, awayQ: FootballTeamQ) {
  // Dixon-Coles style λ
  const lamH = Math.max(0.2, (homeQ.goalsFor  / LEAGUE_AVG) * (awayQ.goalsAgainst / LEAGUE_AVG) * LEAGUE_AVG * 1.10)
  const lamA = Math.max(0.2, (awayQ.goalsFor  / LEAGUE_AVG) * (homeQ.goalsAgainst / LEAGUE_AVG) * LEAGUE_AVG)

  const { pHome: pH, pDraw: pD, pAway: pA } = matchProbs(lamH, lamA)

  // Over 2.5 model probability
  let pOver = 0
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++)
      if (i + j > 2) pOver += poissonProb(lamH, i) * poissonProb(lamA, j)
  const pOver25 = Math.min(0.95, Math.max(0.05, pOver))

  // BTTS
  const pBtts = Math.min(0.95, Math.max(0.05, (1 - poissonProb(lamH, 0)) * (1 - poissonProb(lamA, 0))))

  // Market probability = model ± drift
  const drift = () => (Math.random() - 0.45) * 0.10
  const mktH  = Math.max(0.05, Math.min(0.88, pH  + drift()))
  const mktD  = Math.max(0.05, Math.min(0.70, pD  + drift()))
  const mktA  = Math.max(0.05, 1 - mktH - mktD)
  const mktOv = Math.max(0.05, Math.min(0.95, pOver25 + drift()))
  const mktBt = Math.max(0.05, Math.min(0.95, pBtts + drift()))

  const homeOdd  = +((1 / mktH)  * (1 - MARGIN)).toFixed(2)
  const drawOdd  = +((1 / mktD)  * (1 - MARGIN)).toFixed(2)
  const awayOdd  = +((1 / mktA)  * (1 - MARGIN)).toFixed(2)
  const overOdd  = +((1 / mktOv) * (1 - MARGIN)).toFixed(2)
  const underOdd = +((1 / (1 - mktOv)) * (1 - MARGIN)).toFixed(2)
  const bttsYes  = +((1 / mktBt) * (1 - MARGIN)).toFixed(2)
  const bttsNo   = +((1 / (1 - mktBt)) * (1 - MARGIN)).toFixed(2)

  const markets = [
    { market: 'home_win', p: pH,      odd: homeOdd },
    { market: 'draw',     p: pD,      odd: drawOdd },
    { market: 'away_win', p: pA,      odd: awayOdd },
    { market: 'over_2.5', p: pOver25, odd: overOdd },
    { market: 'btts_yes', p: pBtts,   odd: bttsYes },
  ]
  const best = markets.reduce((a, b) => a.p * a.odd > b.p * b.odd ? a : b)
  const ev   = Math.max(0, +(best.p * best.odd - 1).toFixed(4))
  const expGoals = +(lamH + lamA).toFixed(1)

  return {
    homeOdd, drawOdd, awayOdd, overOdd, underOdd, bttsYes, bttsNo,
    pH: +pH.toFixed(4), pD: +pD.toFixed(4), pA: +pA.toFixed(4),
    pOver: +pOver25.toFixed(4), pBtts: +pBtts.toFixed(4),
    expGoals, best, ev,
  }
}

const DEFAULT_FOOTBALL_Q: FootballTeamQ = {
  goalsFor: LEAGUE_AVG, goalsAgainst: LEAGUE_AVG, winRate: 0.40, drawRate: 0.25,
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
  return key ? standings[key] : DEFAULT_FOOTBALL_Q
}

function statusKey(s: string): string {
  if (s.includes('FINAL') || s.includes('POST')) return 'finished'
  if (s.includes('IN_PROGRESS') || s.includes('LIVE')) return 'live'
  return 'scheduled'
}

// ── Fetch one league ──────────────────────────────────────────────────────────
async function fetchLeague(league: { key: string; name: string; espnSlug: string }): Promise<any[]> {
  const today = new Date()
  const end   = new Date(Date.now() + 10 * 86_400_000)
  const fmt   = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`
  const [scoreboardData, standingsData] = await Promise.all([
    espnFetch(`${ESPN_SOCCER}/${league.espnSlug}/scoreboard?dates=${fmt(today)}-${fmt(end)}`),
    fetchFootballStandings(league.espnSlug),
  ])

  const events: any[] = scoreboardData?.events || []
  const seen = new Set<string>()
  const matches: any[] = []

  for (const e of events) {
    const comp    = e.competitions?.[0]
    if (!comp) continue
    const homeC   = comp.competitors?.find((c: any) => c.homeAway === 'home')
    const awayC   = comp.competitors?.find((c: any) => c.homeAway === 'away')
    if (!homeC || !awayC) continue
    const homeName = homeC.team?.displayName || homeC.team?.name || ''
    const awayName = awayC.team?.displayName || awayC.team?.name || ''
    if (!homeName || !awayName) continue

    const key = `${homeName}-${awayName}`
    if (seen.has(key)) continue
    seen.add(key)

    const status = statusKey(comp.status?.type?.name || '')
    if (status === 'finished') continue

    const homeQ = findFootballQ(homeName, standingsData)
    const awayQ = findFootballQ(awayName, standingsData)
    const calc  = computeFootball(homeQ, awayQ)

    matches.push({
      id:         e.id,
      home_team:  { name: homeName, logo: homeC.team?.logo || null },
      away_team:  { name: awayName, logo: awayC.team?.logo || null },
      match_date: e.date,
      status,
      league:     league.name,
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
        p_home:     calc.pH,
        p_draw:     calc.pD,
        p_away:     calc.pA,
        p_over:     calc.pOver,
        p_btts:     calc.pBtts,
        exp_goals:  calc.expGoals,
        best_market: calc.best.market,
        best_odd:    calc.best.odd,
      },
    })
  }
  return matches
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const results = await Promise.all(LEAGUES.map(fetchLeague))
    const matches = results.flat()
    matches.sort((a, b) => new Date(a.match_date).getTime() - new Date(b.match_date).getTime())
    return NextResponse.json({ matches, source: 'espn+standings', count: matches.length })
  } catch (err) {
    console.error('[/api/football/matches]', err)
    return NextResponse.json({ matches: [] }, { status: 200 })
  }
}
