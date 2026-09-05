import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.data/**', 'samples/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // Unused code is a review finding, not a warning to scroll past.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' },
      ],
      // Rows from the database and metrics documents are genuinely dynamic.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    files: ['web/src/**/*.tsx', 'web/src/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  {
    files: ['server/src/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
