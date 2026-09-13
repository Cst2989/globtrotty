import { findSentinels, SENTINELS } from './sentinels.js'

const ROOTS = ['src', 'netlify', 'public']
const findings = findSentinels(ROOTS)
if (findings.length === 0) {
  console.log(`sentinels: ${SENTINELS.length} patterns, ${ROOTS.join(', ')}, nothing found.`)
  process.exit(0)
}
for (const f of findings) {
  const why = SENTINELS.find((s) => s.name === f.sentinel)!.why
  console.error(`${f.file}:${f.line}  ${f.sentinel}\n    ${f.excerpt}\n    ${why}`)
}
console.error(`\nsentinels: ${findings.length} finding(s). Refusing to pass.`)
process.exit(1)
