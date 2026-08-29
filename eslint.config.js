import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'test/fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // ignoreRestSiblings: destructuring named keys off an object purely to
      // exclude them from a `...rest` (test/env.test.ts's missing-keys test) is
      // not an unused binding, it is how the rest is built.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
)
