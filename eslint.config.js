import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['archive/**', 'fixtures/**', 'node_modules/**', 'dist/**', '.claude/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-control-regex': 'off',
    },
  },
  { files: ['test/**'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
