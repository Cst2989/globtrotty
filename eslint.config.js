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
//
// Coverage notes on the selector below, recorded so nobody re-derives these
// by hand later:
//
// - `?? 0n` (BigInt zero) IS caught, verified empirically with
//   `count ?? 0n` under this exact parser/config — it reports. This matters
//   because `bigint` is the actual money type here (`Spend`'s three fields,
//   `readSpendFailClosed`'s return), so `?? 0n` is the realistic dangerous
//   spelling, not `?? 0`. The match is incidental, not a designed feature of
//   `right.value=0`: Babel gives a BigInt literal node a real `bigint`-typed
//   `value` (`0n === 0` is `false` in JS), but esquery's `[attr=value]`
//   comparator (esquery/dist/esquery.js, the `case '='` / `case 'literal'`
//   branch) does not compare types — it does
//   `"".concat(selectorValue) === "".concat(nodeValue)`, i.e. it stringifies
//   both sides and compares strings. `String(0n)` and `String(0)` are both
//   `"0"`, so they match. This errs safe (it catches more than the spec's
//   literal wording), but it is a side effect of how esquery happens to
//   compare literals, not a guarantee — a future esquery/parser change could
//   alter it. Don't remove the BigInt case from a future regression check
//   just because the selector "shouldn't" match it by type.
//
// - The selector does NOT catch a disguised right-hand literal, e.g.
//   `count ?? (0 as number)`, `count ?? (0)!`, or `count ?? +0` — each wraps
//   or reshapes the `0` so `right.type` is no longer exactly `'Literal'`.
//   This is inherent to matching `right.type === 'Literal'` precisely, holds
//   under any parser, and matches no code in this repo today. Noted so the
//   selector is not assumed watertight against every right-hand disguise.
import babelParser from '@babel/eslint-parser'

export default [
  {
    files: ['src/repo/**/*.ts'],
    languageOptions: {
      // `ecmaVersion` is left unset (defaults apply) — harmless at this
      // syntax-only scope; revisit if this config is ever extended beyond
      // the one rule above.
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
