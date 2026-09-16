import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'dist/**', '**/*.d.ts', '.cache/**', '.pnpm-store/**', '**/.wrangler/**'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'worker/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['worker/multiuser/**/*.ts'],
    languageOptions: { parserOptions: { projectService: false, project: './worker/local/tsconfig.json' } },
  },
];
