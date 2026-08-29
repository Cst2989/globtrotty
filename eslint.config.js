import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'test/fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
