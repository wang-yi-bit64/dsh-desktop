const [expectedPlatform, expectedArch] = process.argv.slice(2)

if (!expectedPlatform || !expectedArch) {
  console.error('Usage: node scripts/verify-target.mjs <platform> <arch>')
  process.exit(2)
}

if (process.platform !== expectedPlatform || process.arch !== expectedArch) {
  console.error(
    `This package must be built on ${expectedPlatform}/${expectedArch}; current runtime is ${process.platform}/${process.arch}.`
  )
  console.error('Install dependencies and run the build on the matching machine or CI runner.')
  process.exit(1)
}

console.log(`Packaging target verified: ${process.platform}/${process.arch}`)
