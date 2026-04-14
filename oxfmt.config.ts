import { defineConfig } from 'oxfmt';

export default defineConfig({
  ignorePatterns: ['dist/**', 'coverage/**', 'src/templates/**/*.css', 'src/templates/**/*.html'],
  printWidth: 160,
  singleQuote: true,
  sortImports: true,
});
