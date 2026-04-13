import type { Metadata } from 'next'
import ScrapingHubClient from './ScrapingHubClient'

export const metadata: Metadata = { title: 'Scraping Hub' }

export default function Page() {
  return <ScrapingHubClient />
}
