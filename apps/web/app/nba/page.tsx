import type { Metadata } from 'next'
import NBAPage from './NBAClient'

export const metadata: Metadata = { title: 'NBA' }

export default function Page() {
  return <NBAPage />
}
