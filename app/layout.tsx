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
          {/* Fix round 1 (Important): removed the empty placeholder aside —
              the real `Sidebar` (web/components/Sidebar.tsx), rendered by
              each authenticated page, is now the only landmark named
              "Conversations". Keeping this empty one too would have left
              two elements sharing that accessible name. */}
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
