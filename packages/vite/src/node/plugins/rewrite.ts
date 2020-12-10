import _debug from 'debug'
import { Plugin, ResolvedConfig } from '..'
import chalk from 'chalk'
import { FILE_PREFIX } from './resolve'
import MagicString from 'magic-string'
import { init, parse, ImportSpecifier } from 'es-module-lexer'
import { isCSSRequest } from './css'
import slash from 'slash'
import { prettifyUrl, timeFrom } from '../utils'

const isDebug = !!process.env.DEBUG
const debugRewrite = _debug('vite:rewrite')
const debugNodeResolve = _debug('vite:resolve')

const skipRE = /\.(map|json)$/
const canSkip = (id: string) =>
  skipRE.test(id) || isCSSRequest(id) || isCSSRequest(id.slice(0, -3))

/**
 * Server-only plugin that rewrites url imports (bare modules, css/asset imports)
 * so that they can be properly handled by the server.
 *
 * - Bare module imports are resolved (by @rollup-plugin/node-resolve) to
 * absolute file paths, e.g.
 *
 *     ```js
 *     import 'foo'
 *     ```
 *     is rewritten to
 *     ```js
 *     import '/@fs//project/node_modules/foo/dist/foo.js'
 *     ```
 *
 * - CSS imports are appended with `.js` since both the js module and the actual
 * css (referenced via <link>) may go through the trasnform pipeline:
 *
 *     ```js
 *     import './style.css'
 *     ```
 *     is rewritten to
 *     ```js
 *     import './style.css.js'
 *     ```
 */
export function rewritePlugin(config: ResolvedConfig): Plugin {
  return {
    name: 'vite:rewrite',
    async transform(source, importer) {
      const prettyImporter = prettifyUrl(slash(importer), config.root)
      if (canSkip(importer)) {
        isDebug && debugRewrite(chalk.dim(`[skipped] ${prettyImporter}`))
        return null
      }

      const rewriteStart = Date.now()
      let timeSpentResolving = 0
      await init
      let imports: ImportSpecifier[] = []
      try {
        imports = parse(source)[0]
      } catch (e) {
        console.warn(
          chalk.yellow(
            `[vite] failed to parse ${chalk.cyan(
              importer
            )} for import rewrite.\nIf you are using ` +
              `JSX, make sure to named the file with the .jsx extension.`
          )
        )
        return source
      }

      if (!imports.length) {
        isDebug && debugRewrite(chalk.dim(`[no imports] ${prettyImporter}`))
        return source
      }

      let s: MagicString | undefined
      for (const { s: start, e: end, d: dynamicIndex } of imports) {
        let id = source.substring(start, end)
        const hasViteIgnore = /\/\*\s*@vite-ignore\s*\*\//.test(id)
        let hasLiteralDynamicId = false
        if (dynamicIndex >= 0) {
          // #998 remove comment
          id = id.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '')
          const literalIdMatch = id.match(/^\s*(?:'([^']+)'|"([^"]+)")\s*$/)
          if (literalIdMatch) {
            hasLiteralDynamicId = true
            id = literalIdMatch[1] || literalIdMatch[2]
          }
        }
        if (dynamicIndex === -1 || hasLiteralDynamicId) {
          // resolve bare imports:
          // e.g. `import 'foo'` -> `import '@fs/.../node_modules/foo/index.js`
          if (id[0] !== '/' && id[0] !== '.') {
            const resolveStart = Date.now()
            const resolved = await this.resolve(id, importer)
            timeSpentResolving += Date.now() - resolveStart
            if (resolved) {
              // resolved.id is now a file system path - convert it to url-like
              // this will be unwrapped in the reoslve plugin
              const prefixed = FILE_PREFIX + slash(resolved.id)
              isDebug &&
                debugNodeResolve(
                  `${timeFrom(resolveStart)} ${chalk.cyan(id)} -> ${chalk.dim(
                    prefixed
                  )}`
                )
              ;(s || (s = new MagicString(source))).overwrite(
                start,
                end,
                hasLiteralDynamicId ? `'${prefixed}'` : prefixed
              )
            } else {
              console.warn(
                chalk.yellow(`[vite] cannot resolve bare import "${id}".`)
              )
            }
          }

          // resolve CSS imports into js (so it differentiates from actual
          // CSS references from <link>)
          if (isCSSRequest(id)) {
            ;(s || (s = new MagicString(source))).appendLeft(end, '.js')
          }
        } else if (id !== 'import.meta' && !hasViteIgnore) {
          console.warn(
            chalk.yellow(`[vite] ignored dynamic import(${id}) in ${importer}.`)
          )
        }
      }

      // TODO env?
      // if (hasEnv) {
      //   debug(`    injecting import.meta.env for ${importer}`)
      //   s.prepend(
      //     `import __VITE_ENV__ from "${envPublicPath}"; ` +
      //       `import.meta.env = __VITE_ENV__; `
      //   )
      //   hasReplaced = true
      // }

      const result = s ? s.toString() : source
      isDebug &&
        debugRewrite(
          `${timeFrom(rewriteStart, timeSpentResolving)} ${chalk.dim(
            prettyImporter
          )}`
        )
      return result
    }
  }
}
