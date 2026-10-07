import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gitExecFileAsync } from '../git/runner'

export function getOrcaDirectoryPath(workspacePath: string): string {
  return path.join(workspacePath, '.orca')
}

export function getGoalsJsonPath(workspacePath: string): string {
  return path.join(workspacePath, '.orca', 'goals.json')
}

export function getCurrentGoalMarkdownPath(workspacePath: string): string {
  return path.join(workspacePath, '.orca', 'CURRENT_GOAL.md')
}

export function getLastValidationLogPath(workspacePath: string): string {
  return path.join(workspacePath, '.orca', 'last_validation.log')
}

/** Resolves the info/exclude file, supporting both standard repos and linked worktrees where .git is a file. */
export async function resolveGitExcludePath(workspacePath: string): Promise<string | null> {
  const gitMarker = path.join(workspacePath, '.git')
  if (!existsSync(gitMarker)) {
    return null
  }

  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', '--git-path', 'info/exclude'], {
      cwd: workspacePath
    })
    const trimmed = stdout.trim()
    if (!trimmed) {
      return null
    }
    return path.resolve(workspacePath, trimmed)
  } catch {
    // Fallback if git binary cannot execute in current environment.
    try {
      const stat = await fs.stat(gitMarker)
      if (stat.isDirectory()) {
        return path.join(workspacePath, '.git', 'info', 'exclude')
      }
      if (stat.isFile()) {
        const content = await fs.readFile(gitMarker, 'utf8')
        const match = content.match(/^gitdir:\s*(.+)$/m)
        if (match) {
          const rawGitDir = match[1].trim()
          const gitDir = path.resolve(workspacePath, rawGitDir)
          const commonDirPath = path.join(gitDir, 'commondir')
          if (existsSync(commonDirPath)) {
            const commonDirRelative = (await fs.readFile(commonDirPath, 'utf8')).trim()
            const commonDir = path.resolve(gitDir, commonDirRelative)
            return path.join(commonDir, 'info', 'exclude')
          }
          return path.join(gitDir, 'info', 'exclude')
        }
      }
    } catch {
      return null
    }
    return null
  }
}

/** Ensures .orca/ is ignored in git exclude without modifying project-tracked .gitignore. */
export async function ensureGitExclusion(workspacePath: string): Promise<void> {
  const excludePath = await resolveGitExcludePath(workspacePath)
  if (!excludePath) {
    return
  }

  await fs.mkdir(path.dirname(excludePath), { recursive: true })

  let content = ''
  try {
    content = await fs.readFile(excludePath, 'utf8')
  } catch {
    // Exclude file does not exist yet.
  }

  const lines = content.split(/\r?\n/)
  const alreadyExcluded = lines.some((line) => {
    const trimmed = line.trim()
    return (
      trimmed === '.orca' ||
      trimmed === '.orca/' ||
      trimmed === '.orca/*' ||
      trimmed === '/.orca' ||
      trimmed === '/.orca/'
    )
  })

  if (!alreadyExcluded) {
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
    await fs.writeFile(excludePath, `${content}${separator}.orca/\n`, 'utf8')
  }
}
