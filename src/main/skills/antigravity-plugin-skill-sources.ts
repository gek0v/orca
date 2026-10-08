import { readdir, stat } from 'node:fs/promises'
import { basename, join, type posix } from 'node:path'
import { stripUnsafeDisplayCharacters } from '../../shared/skill-display-text'
import { stablePathId, type SkillScanRoot } from './skill-discovery-sources'

export type SkillDiscoveryPathApi = Pick<typeof posix, 'basename' | 'join'>

const defaultPathApi: SkillDiscoveryPathApi = { basename, join }

export async function discoverAntigravityPluginSkillSources(args: {
  homeDir: string
  pathApi?: SkillDiscoveryPathApi
}): Promise<SkillScanRoot[]> {
  const pathApi = args.pathApi ?? defaultPathApi
  const pluginsDir = pathApi.join(args.homeDir, '.gemini', 'config', 'plugins')
  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true })
    const sortedEntries = entries.sort((a, b) => a.name.localeCompare(b.name))
    const roots: SkillScanRoot[] = []
    for (const entry of sortedEntries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue
      }
      const pluginName = entry.name
      const skillsPath = pathApi.join(pluginsDir, pluginName, 'skills')
      try {
        const skillsStat = await stat(skillsPath)
        if (skillsStat.isDirectory()) {
          roots.push({
            id: `antigravity-plugin-${stablePathId(skillsPath)}`,
            label: `Antigravity plugin ${stripUnsafeDisplayCharacters(pluginName) || pluginName}`,
            path: skillsPath,
            sourceKind: 'plugin',
            providers: ['agent-skills'],
            owner: 'antigravity'
          })
        }
      } catch {
        // Missing or inaccessible skills subdirectory
      }
    }
    return roots
  } catch {
    return []
  }
}
