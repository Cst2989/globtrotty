import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Globetrotty',
  description: 'Plan a trip with Globetrotty',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <aside className="sidebar" aria-label="Conversations" />
          <main className="main">{children}</main>
          {/* Fix round 1 (Minor): moved inside .app-shell and pinned with
              position: fixed (see globals.css) so it's visible without
              scrolling, instead of trailing below the fold as a normal
              flow sibling. */}
          <footer className="footer">We never ask for payment or passport details.</footer>
        </div>
      </body>
    </html>
  )
}
