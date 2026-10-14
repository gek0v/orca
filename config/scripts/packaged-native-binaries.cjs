const { existsSync } = require('node:fs')
const { join } = require('node:path')

function findNativeBinaryCandidate(binaryName, options = {}) {
  if (options.findCandidate) {
    return options.findCandidate(binaryName)
  }
  const projectRoot = options.projectRoot || join(__dirname, '..', '..')
  const distCandidate = join(projectRoot, 'dist', 'bin', binaryName)
  const targetCandidate = join(projectRoot, 'target', 'release', binaryName)

  if (existsSync(distCandidate)) {
    return distCandidate
  }
  if (existsSync(targetCandidate)) {
    return targetCandidate
  }
  return null
}

function getPackagedNativeBinaryResources(platform, options = {}) {
  const ext = platform === 'win32' ? '.exe' : ''
  const binaries = options.includeCli !== false ? [`orcad${ext}`, `orca${ext}`] : [`orcad${ext}`]
  const resources = []

  for (const binary of binaries) {
    const candidate = findNativeBinaryCandidate(binary, options)
    if (candidate) {
      resources.push({
        from: candidate,
        to: `bin/${binary}`
      })
    }
  }

  return resources
}

module.exports = {
  findNativeBinaryCandidate,
  getPackagedNativeBinaryResources
}
