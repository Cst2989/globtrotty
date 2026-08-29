// Enforces spec section 7's fail-closed money rule:
//
//   "Any limit protecting money denies the request when it cannot confirm
//   current usage. `count ?? 0` is a banned pattern; a lint rule enforces it."
//
// `count ?? 0` turns "I could not confirm how much was spent" into "zero was
// spent", which silently disables a spend ceiling at exactly the moment the
// database (or whatever produced `count`) is unhealthy and the ceiling is
// needed most. See the doc comment on `readSpendFailClosed` in
// src/repo/spend.ts for the full reasoning this rule exists to protect.
//
// Scope: src/repo/** only, not the whole repo. Repo-wide was tried first and
// produced a genuine false positive at src/gates/pipeline.ts:86
// (`args.round ?? 0`, a retry-round counter that has nothing to do with
// money) — `?? 0` is a legitimate way to default an ordinary counter, and
// only becomes dangerous around spend/usage reads. src/repo/** is where
// database reads that feed money ceilings live today (recordSpend,
// readSpendFailClosed) and where Plan 3's new spend-recording code will
// land, so scoping here is deliberate, not an attempt to dodge violations.
//
// Parser: @babel/eslint-parser + @babel/preset-typescript, not
// @typescript-eslint/parser. The repo pins "typescript": "^7.0.2" (the new
// native TS compiler), and @typescript-eslint/parser 8.68.0 hard-refuses to
// run against TS 7 ("typescript-eslint does not support TS 7.0.", tracked at
// https://github.com/typescript-eslint/typescript-eslint/issues/10940). This
// rule needs only a syntax-level TS-aware parser (no type information), and
// Babel's TypeScript support parses TS syntax on its own without touching
// the `typescript` package at all, so it is unaffected by that version gap.
import babelParser from '@babel/eslint-parser'

export default [
  {
    files: ['src/repo/**/*.ts'],
    languageOptions: {
      parser: babelParser,
      sourceType: 'module',
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ['@babel/preset-typescript'],
        },
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "LogicalExpression[operator='??'][right.type='Literal'][right.value=0]",
          message:
            "'?? 0' is banned here: this is a fail-closed money guardrail (spec §7). " +
            "Converting 'could not confirm current usage' into 'zero spent' disables a " +
            'spend ceiling at exactly the moment the read failed. If the value is ' +
            'legitimately absent (e.g. a fresh row that has never been written), make ' +
            'that explicit — e.g. `rows.length ? BigInt(rows[0].col) : 0n` — so the zero ' +
            'is a confirmed reading, not a guess standing in for a failed one. See the ' +
            'doc comment on readSpendFailClosed in src/repo/spend.ts.',
        },
      ],
    },
  },
]
