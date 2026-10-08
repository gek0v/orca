export type AntigravityPlatformArtifact = {
  archive: string
  archiveSha256: string
  archiveBytes: number
  binaryName: string
  binaryBytes: number
  harnessName: string
  harnessBytes: number
  args: string[]
}

export const ANTIGRAVITY_ACP_VERSION = '1.1.1'

export const ANTIGRAVITY_PLATFORM_CATALOG: Record<string, AntigravityPlatformArtifact> = {
  'darwin-aarch64': {
    archive:
      'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip',
    archiveSha256: 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189',
    archiveBytes: 316014828,
    binaryName: 'agy_acp_server.par',
    binaryBytes: 802163856,
    harnessName: 'localharness_external',
    harnessBytes: 116766704,
    args: []
  },
  'linux-x86_64': {
    archive:
      'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip',
    archiveSha256: '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df',
    archiveBytes: 681969407,
    binaryName: 'agy_acp_server.par',
    binaryBytes: 1880360328,
    harnessName: 'localharness_external',
    harnessBytes: 128966920,
    args: ['--uid=']
  },
  'linux-aarch64': {
    archive:
      'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip',
    archiveSha256: 'ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398',
    archiveBytes: 656572786,
    binaryName: 'agy_acp_server.par',
    binaryBytes: 1862073131,
    harnessName: 'localharness_external',
    harnessBytes: 122158704,
    args: ['--uid=']
  },
  'windows-x86_64': {
    archive:
      'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip',
    archiveSha256: '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8',
    archiveBytes: 468238392,
    binaryName: 'agy_acp_server.exe',
    binaryBytes: 430801616,
    harnessName: 'localharness_external.exe',
    harnessBytes: 130971800,
    args: []
  },
  'windows-aarch64': {
    archive:
      'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip',
    archiveSha256: '35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc',
    archiveBytes: 468521191,
    binaryName: 'agy_acp_server.exe',
    binaryBytes: 435075816,
    harnessName: 'localharness_external.exe',
    harnessBytes: 122455704,
    args: []
  }
}
