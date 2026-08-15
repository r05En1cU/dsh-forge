// Build the webui client bundle for dsh-plugin-demo into
// `window.__ModuleLoader__.load({ id, factory })` form (classic <script>).
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const ID = 'dsh-plugin-demo'
const EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/cordis']

const result = await build({
  entryPoints: [join(root, 'src/client.js')],
  outfile: join(root, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

if (result.errors.length > 0) {
  throw new Error(`client bundle build failed:\n${result.errors.map((e) => e.text).join('\n')}`)
}

const text = await import('node:fs').then((fs) => fs.readFileSync(join(root, 'client.js'), 'utf8'))
if (text.includes('import.meta')) {
  throw new Error('client bundle contains import.meta')
}
console.log(`built client.js (${text.length} bytes)`)
