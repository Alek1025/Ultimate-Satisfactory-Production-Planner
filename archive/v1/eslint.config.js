// ESLint catches likely bugs only. Formatting is left to the existing hand-written style.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'dist-app/', 'node_modules/', 'fixtures/', 'scripts/map-sources/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // File-name sanitising strips control characters on purpose.
      'no-control-regex': 'off',
      'no-useless-assignment': 'warn',
    },
  },
  {
    // Dev scripts and tests poke at raw save/Docs JSON, where `any` is the honest type.
    files: ['scripts/**', 'test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['app/**/*.tsx', 'app/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
