import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { getPackagedNativeBinaryResources } = require('./packaged-native-binaries.cjs')

describe('packaged native binary resources', () => {
  it('includes orcad binary when present in target/release or dist/bin', () => {
    const winResources = getPackagedNativeBinaryResources('win32', { includeCli: false })
    expect(winResources).toEqual(
      expect.arrayContaining([expect.objectContaining({ to: 'bin/orcad.exe' })])
    )
  })

  it('resolves correct binary extensions for non-windows platforms', () => {
    const linuxResources = getPackagedNativeBinaryResources('linux', {
      findCandidate: (name) => `/mock/path/${name}`
    })
    expect(linuxResources).toEqual([
      { from: '/mock/path/orcad', to: 'bin/orcad' },
      { from: '/mock/path/orca', to: 'bin/orca' }
    ])
  })
})
