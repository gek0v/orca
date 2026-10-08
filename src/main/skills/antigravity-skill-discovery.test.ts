import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSkillDiscoverySources, discoverSkills } from './discovery'
import { discoverAntigravityPluginSkillSources } from './antigravity-plugin-skill-sources'
import { stablePathId } from './skill-discovery-classification'

describe('Antigravity skill discovery', () => {
  it('attributes a skill in the user configuration directory to Antigravity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-skills-user-'))
    try {
      const root = join(home, '.gemini', 'config', 'skills')
      const directory = join(root, 'review')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\nname: review\ndescription: Review a change.\n---\n'
      )
      const result = await discoverSkills({
        homeDir: home,
        includeCwd: false,
        providerRootOverrides: {}
      })
      const skill = result.skills.find((s) => s.name === 'review')
      expect(skill?.rootPaths).toContain(root)
      expect(skill?.providers).toContain('agent-skills')
      expect(result.sources.find((source) => source.id === 'home-antigravity')).toMatchObject({
        path: root,
        sourceKind: 'home',
        owner: 'antigravity',
        providers: ['agent-skills'],
        exists: true
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('discovers built-in skills in the Antigravity CLI builtin directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-skills-builtin-'))
    try {
      const root = join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills')
      const directory = join(root, 'builtin-review')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\nname: builtin-review\ndescription: Builtin review skill.\n---\n'
      )
      const result = await discoverSkills({
        homeDir: home,
        includeCwd: false,
        providerRootOverrides: {}
      })
      const skill = result.skills.find((s) => s.name === 'builtin-review')
      expect(skill).toMatchObject({
        name: 'builtin-review',
        sourceKind: 'bundled',
        providers: ['agent-skills']
      })
      expect(skill?.rootPaths).toContain(root)
      expect(
        result.sources.find((source) => source.id === 'home-antigravity-builtin')
      ).toMatchObject({
        path: root,
        sourceKind: 'bundled',
        owner: 'antigravity',
        providers: ['agent-skills'],
        exists: true
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('discovers CLI custom skills in the Antigravity CLI directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-skills-cli-'))
    try {
      const root = join(home, '.gemini', 'antigravity-cli', 'skills')
      const directory = join(root, 'cli-deploy')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\nname: cli-deploy\ndescription: Custom CLI deploy skill.\n---\n'
      )
      const result = await discoverSkills({
        homeDir: home,
        includeCwd: false,
        providerRootOverrides: {}
      })
      const skill = result.skills.find((s) => s.name === 'cli-deploy')
      expect(skill).toMatchObject({
        name: 'cli-deploy',
        sourceKind: 'home',
        providers: ['agent-skills']
      })
      expect(skill?.rootPaths).toContain(root)
      expect(result.sources.find((source) => source.id === 'home-antigravity-cli')).toMatchObject({
        path: root,
        sourceKind: 'home',
        owner: 'antigravity',
        providers: ['agent-skills'],
        exists: true
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('discovers plugin skills in the Antigravity plugins directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-skills-plugin-'))
    try {
      const pluginSkillsRoot = join(home, '.gemini', 'config', 'plugins', 'science', 'skills')
      const directory = join(pluginSkillsRoot, 'alphafold')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\nname: alphafold\ndescription: AlphaFold protein analysis.\n---\n'
      )
      const result = await discoverSkills({
        homeDir: home,
        includeCwd: false,
        providerRootOverrides: {}
      })
      const skill = result.skills.find((s) => s.name === 'alphafold')
      expect(skill).toMatchObject({
        name: 'alphafold',
        sourceKind: 'plugin',
        sourceLabel: 'Antigravity plugin science',
        providers: ['agent-skills']
      })
      expect(skill?.rootPaths).toContain(pluginSkillsRoot)
      const pluginSourceId = `antigravity-plugin-${stablePathId(pluginSkillsRoot)}`
      expect(result.sources.find((source) => source.id === pluginSourceId)).toMatchObject({
        id: pluginSourceId,
        label: 'Antigravity plugin science',
        path: pluginSkillsRoot,
        sourceKind: 'plugin',
        owner: 'antigravity',
        providers: ['agent-skills'],
        exists: true
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('discovers repository skills in <repo>/.gemini/skills', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-home-'))
    const repo = await mkdtemp(join(tmpdir(), 'orca-agy-repo-'))
    try {
      const repoSkillsRoot = join(repo, '.gemini', 'skills')
      const directory = join(repoSkillsRoot, 'repo-tool')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\nname: repo-tool\ndescription: Repository-scoped skill.\n---\n'
      )
      const result = await discoverSkills({
        homeDir: home,
        cwd: repo,
        includeCwd: true,
        providerRootOverrides: {}
      })
      const skill = result.skills.find((s) => s.name === 'repo-tool')
      expect(skill).toMatchObject({
        name: 'repo-tool',
        sourceKind: 'repo',
        providers: ['agent-skills']
      })
      expect(skill?.rootPaths).toContain(repoSkillsRoot)
      const repoSourceId = `repo-antigravity-${stablePathId(repo)}`
      expect(result.sources.find((source) => source.id === repoSourceId)).toMatchObject({
        id: repoSourceId,
        path: repoSkillsRoot,
        sourceKind: 'repo',
        owner: 'antigravity',
        providers: ['agent-skills'],
        exists: true
      })
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  describe('discoverAntigravityPluginSkillSources helper', () => {
    it('returns empty array when plugins directory does not exist', async () => {
      const home = join(tmpdir(), 'non-existent-antigravity-home-12345')
      const sources = await discoverAntigravityPluginSkillSources({
        homeDir: home
      })
      expect(sources).toEqual([])
    })

    it('ignores files and directories without skills subdirectory', async () => {
      const home = await mkdtemp(join(tmpdir(), 'orca-agy-plugins-filter-'))
      try {
        const pluginsDir = join(home, '.gemini', 'config', 'plugins')
        await mkdir(pluginsDir, { recursive: true })
        await writeFile(join(pluginsDir, 'README.md'), 'not a plugin directory')
        await mkdir(join(pluginsDir, 'no-skills-plugin'), { recursive: true })
        await writeFile(join(pluginsDir, 'no-skills-plugin', 'index.js'), 'export {}')

        const validPluginSkills = join(pluginsDir, 'valid-plugin', 'skills')
        await mkdir(validPluginSkills, { recursive: true })

        const sources = await discoverAntigravityPluginSkillSources({
          homeDir: home
        })
        expect(sources).toHaveLength(1)
        expect(sources[0]).toMatchObject({
          id: `antigravity-plugin-${stablePathId(validPluginSkills)}`,
          label: 'Antigravity plugin valid-plugin',
          path: validPluginSkills,
          sourceKind: 'plugin',
          owner: 'antigravity',
          providers: ['agent-skills']
        })
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    })
  })

  describe('execution host path format', () => {
    it.each([
      {
        pathApi: posix,
        home: '/home/remote',
        repo: '/home/remote/my-repo',
        expectedBuiltin: '/home/remote/.gemini/antigravity-cli/builtin/skills',
        expectedCli: '/home/remote/.gemini/antigravity-cli/skills',
        expectedConfig: '/home/remote/.gemini/config/skills',
        expectedRepo: '/home/remote/my-repo/.gemini/skills'
      },
      {
        pathApi: win32,
        home: 'C:\\Users\\remote',
        repo: 'C:\\Users\\remote\\my-repo',
        expectedBuiltin: 'C:\\Users\\remote\\.gemini\\antigravity-cli\\builtin\\skills',
        expectedCli: 'C:\\Users\\remote\\.gemini\\antigravity-cli\\skills',
        expectedConfig: 'C:\\Users\\remote\\.gemini\\config\\skills',
        expectedRepo: 'C:\\Users\\remote\\my-repo\\.gemini\\skills'
      }
    ])(
      'builds Antigravity roots matching host path rules: $home',
      ({ pathApi, home, repo, expectedBuiltin, expectedCli, expectedConfig, expectedRepo }) => {
        const roots = buildSkillDiscoverySources({
          homeDir: home,
          cwd: repo,
          pathApi,
          includeCwd: true
        })
        expect(roots.find((r) => r.id === 'home-antigravity-builtin')).toMatchObject({
          path: expectedBuiltin,
          owner: 'antigravity',
          sourceKind: 'bundled',
          providers: ['agent-skills']
        })
        expect(roots.find((r) => r.id === 'home-antigravity-cli')).toMatchObject({
          path: expectedCli,
          owner: 'antigravity',
          sourceKind: 'home',
          providers: ['agent-skills']
        })
        expect(roots.find((r) => r.id === 'home-antigravity')).toMatchObject({
          path: expectedConfig,
          owner: 'antigravity',
          sourceKind: 'home',
          providers: ['agent-skills']
        })
        expect(roots.find((r) => r.id === `repo-antigravity-${stablePathId(repo)}`)).toMatchObject({
          path: expectedRepo,
          owner: 'antigravity',
          sourceKind: 'repo',
          providers: ['agent-skills']
        })
      }
    )
  })
})
