import { defineConfig } from 'tsdown';

const presets = ['express', 'apache', 'nginx'] as const;

export default defineConfig({
  copy: presets.map((preset) => ({
    flatten: true,
    from: `src/templates/${preset}/*.{html,css}`,
    to: `dist/templates/${preset}`,
  })),
  entry: 'src/index.ts',
  outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
  sourcemap: true,
});
