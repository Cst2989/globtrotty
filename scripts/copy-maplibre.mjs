/**
 * Trip-stage pass, section 5: put MapLibre's tile worker somewhere the browser can actually
 * fetch it, and keep it in step with the installed version.
 *
 * MapLibre 6 builds its worker URL from `import.meta.url`:
 *
 *     new URL('./maplibre-gl-worker.mjs', import.meta.url)
 *
 * Under webpack that expression is rewritten to the PAGE's own URL, so the map asks for
 * `/c/<conversation-id>/maplibre-gl-worker.mjs`, gets a 404, and reports one line —
 * "Worker failed to load. Check that the worker URL is correct." — on an otherwise blank canvas.
 * The browser harness is what caught it; nothing else would have.
 *
 * So the worker and the chunk it imports are copied into `public/maplibre/` and
 * `HotelMap` points `setWorkerUrl` at the served path. Copied rather than committed: a vendored
 * bundle drifts silently the moment `maplibre-gl` is upgraded, and this runs before every `dev`
 * and every `build`, including Netlify's.
 *
 * `public/maplibre/` is gitignored for the same reason.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FROM = path.join(ROOT, 'node_modules/maplibre-gl/dist')
const TO = path.join(ROOT, 'public/maplibre')

/** The module worker, and the chunk it imports by a relative path of its own. */
const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']

fs.mkdirSync(TO, { recursive: true })
for (const file of FILES) {
  const from = path.join(FROM, file)
  if (!fs.existsSync(from)) {
    throw new Error(
      `maplibre-gl is installed without ${file}. Its dist layout changed; `
      + 'web/components/HotelMap.tsx\'s `setWorkerUrl` needs the new one.',
    )
  }
  fs.copyFileSync(from, path.join(TO, file))
}
console.log(`copied ${FILES.length} maplibre worker files into public/maplibre/`)
