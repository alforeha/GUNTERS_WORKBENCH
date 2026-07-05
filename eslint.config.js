import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dist-electron', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'electron/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-useless-assignment': 'off',
    },
  },
);
