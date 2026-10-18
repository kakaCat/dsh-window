import { defineConfig } from 'tsdown'

// Host-half build：DSH 从编译产物加载插件，故 ship dist/index.mjs。
// @deepseek-ai/dsh-tools / cordis 必须 external：内联会打进第二份模块级调度 Symbol。
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: true,
  deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'] },
  target: 'node20',
  minify: false,
})
