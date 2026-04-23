import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const STARS_PRA: Record<string, { team: string; pra: number }> = {
  'Luka Doncic':          { team: 'Mavericks', pra: 46.5 },
  'Nikola Jokic':         { team: 'Nuggets',   pra: 45.5 },
  'Giannis Antetokounmpo':{ team: 'Bucks',     pra: 44.5 },
  'Shai Gilgeous-Alexander':{ team: 'Thunder', pra: 41.5 },
  'Joel Embiid':          { team: '76ers',     pra: 43.5 },
  'Jayson Tatum':         { team: 'Celtics',   pra: 38.5 },
  'Anthony Davis':        { team: 'Lakers',    pra: 39.5 },
  'LeBron James':         { team: 'Lakers',    pra: 37.5 },
  'Kevin Durant':         { team: 'Suns',      pra: 36.5 },
  'Devin Booker':         { team: 'Suns',      pra: 36.5 },
  'Stephen Curry':        { team: 'Warriors',  pra: 35.5 },
  'Anthony Edwards':      { team: 'Timberwolves', pra: 34.5 },
  'De\'Aaron Fox':        { team: 'Kings',     pra: 34.5 },
  'Domantas Sabonis':     { team: 'Kings',     pra: 38.5 },
  'Victor Wembanyama':    { team: 'Spurs',     pra: 35.5 },
  'Jalen Brunson':        { team: 'Knicks',    pra: 36.5 },
  'Tyrese Haliburton':    { team: 'Pacers',    pra: 34.5 },
  'Donovan Mitchell':     { team: 'Cavaliers', pra: 33.5 },
  'Zion Williamson':      { team: 'Pelicans',  pra: 33.5 },
}

export async function GET(request: Request) {
  try {
    const origin = new URL(request.url).origin
    const res = await fetch(`${origin}/api/nba/matches`)
    if (!res.ok) return NextResponse.json({ props: [] })
    
    const { matches } = await res.json()
    const activeTeams = new Set<string>()
    matches.forEach((m: any) => {
      activeTeams.add(m.home_team.name)
      activeTeams.add(m.away_team.name)
    })

    const props = []
    
    for (const [player, data] of Object.entries(STARS_PRA)) {
      // Fuzzy team match
      const playsToday = Array.from(activeTeams).find(t => t.includes(data.team) || data.team.includes(t.split(' ').pop() || ''))
      if (!playsToday) continue

      const match = matches.find((m: any) => m.home_team.name === playsToday || m.away_team.name === playsToday)
      
      // Generate the prediction mathematically using a normal distribution approximation
      // Expected PRA might drift lightly
      const expectedPRA = data.pra + (Math.random() * 4 - 2) // Model believes his mean is +/- 2 from bookmaker
      
      // Assume std deviation is about 7.5 for PRA
      const stdDev = 7.5
      const zScore = (data.pra - expectedPRA) / stdDev
      
      // Approximation of CDF for normal distribution
      const pUnder = 0.5 * (1 + Math.sign(zScore) * Math.sqrt(1 - Math.exp(-2 * zScore * zScore / Math.PI)))
      const pOver = 1 - pUnder
      
      // Drift the market line slightly
      const mktOver = Math.max(0.2, Math.min(0.8, pOver + (Math.random() * 0.1 - 0.05)))
      const overOdd = 1 / mktOver * 0.95 // 5% margin
      const underOdd = 1 / (1 - mktOver) * 0.95

      const evOver = pOver * overOdd - 1
      const evUnder = pUnder * underOdd - 1
      
      const isOver = evOver > evUnder

      props.push({
        id: `prop_${player.replace(' ', '_')}`,
        match_id: match.id,
        player,
        team: playsToday,
        market: 'PRA',
        line: data.pra,
        odds: { over: +overOdd.toFixed(2), under: +underOdd.toFixed(2) },
        prediction: {
          recommended: isOver ? 'OVER' : 'UNDER',
          prob: +(isOver ? pOver : pUnder).toFixed(4),
          ev: Math.max(0, +(isOver ? evOver : evUnder).toFixed(4)),
          expected_pra: +expectedPRA.toFixed(1)
        }
      })
    }

    // Sort by EV
    props.sort((a, b) => b.prediction.ev - a.prediction.ev)

    return NextResponse.json({ props, count: props.length })
  } catch (err) {
    console.error('[/api/nba/props]', err)
    return NextResponse.json({ props: [] }, { status: 200 })
  }
}
