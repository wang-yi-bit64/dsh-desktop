import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Optional first argument: the install root whose node_modules receives the
// brand assets (defaults to the project root). prepare-harness.mjs passes
// its staging directory.
const installRoot = process.argv[2] ? path.resolve(process.argv[2]) : projectRoot
const source = path.join(projectRoot, 'build', 'icon.png')
const lightSource = path.join(projectRoot, 'build', 'logo-light.png')
const darkSource = path.join(projectRoot, 'build', 'logo-dark.png')
const destinationDirectory = path.join(
  installRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-web-frontend',
  'dist'
)
const destination = path.join(destinationDirectory, 'dsh-desktop-logo.png')
const lightDestination = path.join(destinationDirectory, 'dsh-desktop-logo-light.png')
const darkDestination = path.join(destinationDirectory, 'dsh-desktop-logo-dark.png')
const indexPath = path.join(destinationDirectory, 'index.html')
const manifestPath = path.join(destinationDirectory, 'manifest.webmanifest')

/**
 * Swap the Harness favicon links for the desktop's own.
 *
 * The href is matched rather than pinned: 0.1.2-alpha.1 moved it from
 * `/favicon.svg` to `./favicon.svg`, and either is the same link. Upstream
 * 0.2.0 split it into two scheme-gated links (`favicon-dark.svg` /
 * `favicon.svg` with `media=`), so the rule is "exactly one icon target",
 * not "exactly one tag": every icon link is replaced by the single desktop
 * link, which always wins for both schemes because the desktop icon is
 * scheme-independent. *Zero* icon links is still a failure — a frontend that
 * stopped declaring one is a change worth failing on, not one to paper over.
 * @param contents - index.html source.
 * @param file - path shown in the failure message.
 * @returns index.html with the desktop icon link.
 */
function replaceIconLink(contents, file) {
  const desktop = '<link rel="icon" type="image/png" href="/dsh-desktop-logo.png" />'
  if (contents.includes(desktop)) return contents
  const links = [...contents.matchAll(/<link rel="icon"[^>]*\/?>(?:<\/link>)?/gu)].map((m) => m[0])
  if (links.length === 0) {
    throw new Error(
      `Could not update DSH Desktop branding in ${file}: expected at least one icon link, found none`
    )
  }
  let replaced = contents
  for (const link of links) replaced = replaced.replace(link, desktop)
  return replaced
}

/**
 * Point the web manifest's icon at the desktop logo.
 *
 * Edited as JSON rather than as text: upstream added `"purpose": "any"` to the
 * entry in 0.1.2-alpha.1, which a pinned multi-line string could not survive,
 * and key order is not a contract. The entry still has to exist.
 * @param contents - manifest source.
 * @param file - path shown in the failure message.
 * @returns manifest JSON with the desktop icon.
 */
function replaceManifestIcon(contents, file) {
  const manifest = JSON.parse(contents)
  const icons = Array.isArray(manifest.icons) ? manifest.icons : []
  const target = icons.find((icon) => icon?.src === '/dsh-desktop-logo.png')
    ?? icons.find((icon) => typeof icon?.src === 'string' && icon.src.endsWith('favicon.svg'))
  if (target === undefined) {
    throw new Error(`Could not update DSH Desktop branding in ${file}: no icon entry to replace`)
  }
  target.src = '/dsh-desktop-logo.png'
  target.sizes = '1254x1254'
  target.type = 'image/png'
  return `${JSON.stringify(manifest, null, 2)}\n`
}

await mkdir(destinationDirectory, { recursive: true })
await copyFile(source, destination)
await copyFile(lightSource, lightDestination)
await copyFile(darkSource, darkDestination)

const index = await readFile(indexPath, 'utf8')
await writeFile(indexPath, replaceIconLink(index, path.relative(projectRoot, indexPath)))

const manifest = await readFile(manifestPath, 'utf8')
await writeFile(
  manifestPath,
  replaceManifestIcon(manifest, path.relative(projectRoot, manifestPath))
)

console.log(`Installed DSH Desktop brand assets: ${[
  destination,
  lightDestination,
  darkDestination
].map((file) => path.relative(projectRoot, file)).join(', ')}`)
