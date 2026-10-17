import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { writeCredentialFileAtomic } from '../integration-credential-file'

export type AntigravityProfileInfo = {
  accountId: string
  profileDir: string
  cliDir: string
  tokenPath: string
  envPatch: NodeJS.ProcessEnv
}

const CANONICAL_FOLDERS = ['conversations', 'brain', 'skills', 'mcp'] as const
const CANONICAL_FILES = ['conversation_summaries.db', 'history.jsonl'] as const

function resolveHomeDir(homeDir?: string): string {
  if (homeDir) {
    return homeDir
  }
  if (hasAppEnvironment()) {
    return getAppEnvironment().getPath('home')
  }
  return homedir()
}

export function getAntigravityProfileBaseDir(homeDir?: string): string {
  return join(resolveHomeDir(homeDir), '.gemini', 'profiles')
}

export function getAntigravityProfileDir(accountId: string, homeDir?: string): string {
  return join(getAntigravityProfileBaseDir(homeDir), accountId)
}

function linkDirectory(target: string, linkPath: string): void {
  try {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      try {
        const linkTarget = readlinkSync(linkPath)
        const isMatch =
          process.platform === 'win32'
            ? resolve(linkTarget).toLowerCase() === resolve(target).toLowerCase()
            : resolve(linkTarget) === resolve(target)
        if (isMatch) {
          return
        }
      } catch {
        // Stale or broken symlink
      }
      try {
        unlinkSync(linkPath)
      } catch {
        rmdirSync(linkPath)
      }
    } else {
      return
    }
  } catch {
    // Path does not exist yet
  }

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(target, linkPath, linkType)
}

function linkFile(target: string, linkPath: string): void {
  if (!existsSync(target)) {
    writeFileSync(target, '', 'utf8')
  }

  try {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      try {
        const linkTarget = readlinkSync(linkPath)
        const isMatch =
          process.platform === 'win32'
            ? resolve(linkTarget).toLowerCase() === resolve(target).toLowerCase()
            : resolve(linkTarget) === resolve(target)
        if (isMatch) {
          return
        }
      } catch {
        // Broken symlink
      }
      unlinkSync(linkPath)
    } else if (stat.isFile()) {
      try {
        const targetStat = statSync(target)
        if (stat.ino !== 0 && stat.ino === targetStat.ino && stat.dev === targetStat.dev) {
          return
        }
      } catch {
        // Target stat failed
      }
      return
    }
  } catch {
    // Path does not exist yet
  }

  try {
    linkSync(target, linkPath)
  } catch {
    try {
      const linkType = process.platform === 'win32' ? 'file' : undefined
      symlinkSync(target, linkPath, linkType)
    } catch {
      // Best-effort linking
    }
  }
}

export function ensureAntigravityAccountProfile(
  accountId: string,
  credentialsJson: string,
  options?: { homeDir?: string }
): AntigravityProfileInfo {
  const home = resolveHomeDir(options?.homeDir)
  const canonicalCliDir = join(home, '.gemini', 'antigravity-cli')
  const profileDir = getAntigravityProfileDir(accountId, options?.homeDir)
  const cliDir = join(profileDir, '.gemini', 'antigravity-cli')

  mkdirSync(canonicalCliDir, { recursive: true, mode: 0o700 })
  for (const folder of CANONICAL_FOLDERS) {
    const canonicalFolder = join(canonicalCliDir, folder)
    if (!existsSync(canonicalFolder)) {
      mkdirSync(canonicalFolder, { recursive: true, mode: 0o700 })
    }
  }
  for (const file of CANONICAL_FILES) {
    const canonicalFile = join(canonicalCliDir, file)
    if (!existsSync(canonicalFile)) {
      writeFileSync(canonicalFile, '', 'utf8')
    }
  }

  mkdirSync(cliDir, { recursive: true, mode: 0o700 })
  for (const folder of CANONICAL_FOLDERS) {
    linkDirectory(join(canonicalCliDir, folder), join(cliDir, folder))
  }
  for (const file of CANONICAL_FILES) {
    linkFile(join(canonicalCliDir, file), join(cliDir, file))
  }

  const tokenPath = join(cliDir, 'antigravity-oauth-token')
  let shouldWrite = true
  if (existsSync(tokenPath)) {
    try {
      const existing = readFileSync(tokenPath, 'utf8')
      if (existing === credentialsJson) {
        shouldWrite = false
      }
    } catch {
      // Re-write on read error
    }
  }
  if (shouldWrite) {
    writeCredentialFileAtomic(tokenPath, Buffer.from(credentialsJson, 'utf8'))
  }

  const envPatch: NodeJS.ProcessEnv = {
    ANTIGRAVITY_PROFILE_DIR: cliDir,
    USERPROFILE: profileDir,
    HOME: profileDir,
    SSH_CLIENT: '127.0.0.1 0 0'
  }

  return {
    accountId,
    profileDir,
    cliDir,
    tokenPath,
    envPatch
  }
}

export function removeAntigravityAccountProfile(
  accountId: string,
  options?: { homeDir?: string }
): void {
  const profileDir = getAntigravityProfileDir(accountId, options?.homeDir)
  try {
    lstatSync(profileDir)
  } catch {
    return
  }

  const cliDir = join(profileDir, '.gemini', 'antigravity-cli')
  try {
    const stat = lstatSync(cliDir)
    if (stat.isDirectory()) {
      const entries = readdirSync(cliDir)
      for (const name of entries) {
        const entryPath = join(cliDir, name)
        try {
          const entryStat = lstatSync(entryPath)
          if (entryStat.isSymbolicLink()) {
            try {
              unlinkSync(entryPath)
            } catch {
              rmdirSync(entryPath)
            }
          } else {
            unlinkSync(entryPath)
          }
        } catch {
          // Best-effort cleanup per entry
        }
      }
      try {
        rmdirSync(cliDir)
      } catch {
        // Best-effort directory removal
      }
    }
  } catch {
    // cliDir did not exist
  }

  const geminiDir = join(profileDir, '.gemini')
  try {
    rmdirSync(geminiDir)
  } catch {
    // Directory not empty or missing
  }

  try {
    rmdirSync(profileDir)
  } catch {
    // Directory not empty or missing
  }
}
