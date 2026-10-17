import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ensureAntigravityAccountProfile,
  getAntigravityProfileBaseDir,
  getAntigravityProfileDir,
  removeAntigravityAccountProfile
} from './native-account-profile-manager'
import { credential } from './native-account-test-fixtures'
import * as appEnvironment from '../../shared/app-environment'

describe('native-account-profile-manager', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'orca-profile-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of temporary test home
    }
  })

  describe('directory path resolution', () => {
    it('resolves base directory and profile directory with explicit homeDir', () => {
      const base = getAntigravityProfileBaseDir(tempHome)
      expect(base).toBe(join(tempHome, '.gemini', 'profiles'))

      const profile = getAntigravityProfileDir('test-account-1', tempHome)
      expect(profile).toBe(join(tempHome, '.gemini', 'profiles', 'test-account-1'))
    })

    it('falls back to getAppEnvironment().getPath("home") when homeDir is omitted', () => {
      const getPathMock = vi.fn().mockReturnValue(tempHome)
      const mockEnv: appEnvironment.AppEnvironment = {
        getPath: getPathMock,
        getAppPath: vi.fn().mockReturnValue(''),
        getVersion: vi.fn().mockReturnValue('1.0.0'),
        isPackaged: vi.fn().mockReturnValue(false),
        onWillQuit: vi.fn(),
        exit: vi.fn(),
        getAppMetrics: vi.fn().mockReturnValue([])
      }
      vi.spyOn(appEnvironment, 'hasAppEnvironment').mockReturnValue(true)
      vi.spyOn(appEnvironment, 'getAppEnvironment').mockReturnValue(mockEnv)

      const base = getAntigravityProfileBaseDir()
      expect(base).toBe(join(tempHome, '.gemini', 'profiles'))
      expect(getPathMock).toHaveBeenCalledWith('home')
    })
  })

  describe('ensureAntigravityAccountProfile', () => {
    it('creates profile enclosure, links canonical directories and writes oauth token', () => {
      const creds = credential('account-alpha')
      const profileInfo = ensureAntigravityAccountProfile('account-alpha', creds, {
        homeDir: tempHome
      })

      expect(profileInfo.accountId).toBe('account-alpha')
      expect(profileInfo.profileDir).toBe(join(tempHome, '.gemini', 'profiles', 'account-alpha'))
      expect(profileInfo.cliDir).toBe(
        join(tempHome, '.gemini', 'profiles', 'account-alpha', '.gemini', 'antigravity-cli')
      )
      expect(profileInfo.tokenPath).toBe(join(profileInfo.cliDir, 'antigravity-oauth-token'))

      expect(profileInfo.envPatch).toEqual({
        ANTIGRAVITY_PROFILE_DIR: profileInfo.cliDir,
        USERPROFILE: profileInfo.profileDir,
        HOME: profileInfo.profileDir,
        SSH_CLIENT: '127.0.0.1 0 0'
      })

      expect(existsSync(profileInfo.tokenPath)).toBe(true)
      expect(readFileSync(profileInfo.tokenPath, 'utf8')).toBe(creds)

      const canonicalCliDir = join(tempHome, '.gemini', 'antigravity-cli')
      const canonicalFolders = ['conversations', 'brain', 'skills', 'mcp']
      for (const folder of canonicalFolders) {
        const canonicalPath = join(canonicalCliDir, folder)
        const profilePath = join(profileInfo.cliDir, folder)

        expect(existsSync(canonicalPath)).toBe(true)
        expect(existsSync(profilePath)).toBe(true)
        const stat = lstatSync(profilePath)
        expect(stat.isSymbolicLink()).toBe(true)
      }

      const canonicalFiles = ['conversation_summaries.db', 'history.jsonl']
      for (const file of canonicalFiles) {
        const canonicalPath = join(canonicalCliDir, file)
        const profilePath = join(profileInfo.cliDir, file)

        expect(existsSync(canonicalPath)).toBe(true)
        expect(existsSync(profilePath)).toBe(true)
      }
    })

    it('is idempotent when called repeatedly with identical credentials', () => {
      const creds = credential('account-idempotent')
      const first = ensureAntigravityAccountProfile('account-idempotent', creds, {
        homeDir: tempHome
      })
      const firstTokenStat = lstatSync(first.tokenPath)

      const second = ensureAntigravityAccountProfile('account-idempotent', creds, {
        homeDir: tempHome
      })
      const secondTokenStat = lstatSync(second.tokenPath)

      expect(second.cliDir).toBe(first.cliDir)
      expect(secondTokenStat.mtimeMs).toBe(firstTokenStat.mtimeMs)
    })

    it('updates oauth token atomically when credentials change', () => {
      const credsV1 = credential('account-rot', 1)
      const credsV2 = credential('account-rot', 2)

      const info1 = ensureAntigravityAccountProfile('account-rot', credsV1, { homeDir: tempHome })
      expect(readFileSync(info1.tokenPath, 'utf8')).toBe(credsV1)

      const info2 = ensureAntigravityAccountProfile('account-rot', credsV2, { homeDir: tempHome })
      expect(readFileSync(info2.tokenPath, 'utf8')).toBe(credsV2)
    })

    it('Review Focus #3: conversation turns written in profile are immediately present in canonical', () => {
      const creds = credential('account-rf3')
      const profileInfo = ensureAntigravityAccountProfile('account-rf3', creds, {
        homeDir: tempHome
      })

      const canonicalCliDir = join(tempHome, '.gemini', 'antigravity-cli')
      const turnPayload = JSON.stringify({ message: 'Hello Antigravity Turn', id: 'turn-42' })
      const profileTurnPath = join(profileInfo.cliDir, 'conversations', 'turn-42.json')
      const canonicalTurnPath = join(canonicalCliDir, 'conversations', 'turn-42.json')

      writeFileSync(profileTurnPath, turnPayload, 'utf8')

      expect(existsSync(canonicalTurnPath)).toBe(true)
      expect(readFileSync(canonicalTurnPath, 'utf8')).toBe(turnPayload)

      const canonicalTurn2Payload = JSON.stringify({ message: 'Canonical Turn 2', id: 'turn-43' })
      const canonicalTurn2Path = join(canonicalCliDir, 'conversations', 'turn-43.json')
      const profileTurn2Path = join(profileInfo.cliDir, 'conversations', 'turn-43.json')

      writeFileSync(canonicalTurn2Path, canonicalTurn2Payload, 'utf8')

      expect(existsSync(profileTurn2Path)).toBe(true)
      expect(readFileSync(profileTurn2Path, 'utf8')).toBe(canonicalTurn2Payload)
    })
  })

  describe('removeAntigravityAccountProfile', () => {
    it('unlinks profile junctions without deleting canonical data or files', () => {
      const creds = credential('account-clean')
      const profileInfo = ensureAntigravityAccountProfile('account-clean', creds, {
        homeDir: tempHome
      })

      const canonicalCliDir = join(tempHome, '.gemini', 'antigravity-cli')
      const testFileInConv = join(canonicalCliDir, 'conversations', 'preserved.json')
      writeFileSync(testFileInConv, JSON.stringify({ preserved: true }), 'utf8')

      const testBrainFile = join(canonicalCliDir, 'brain', 'artifact.md')
      writeFileSync(testBrainFile, '# Artifact', 'utf8')

      removeAntigravityAccountProfile('account-clean', { homeDir: tempHome })

      expect(existsSync(profileInfo.profileDir)).toBe(false)
      expect(existsSync(profileInfo.cliDir)).toBe(false)

      expect(existsSync(canonicalCliDir)).toBe(true)
      expect(existsSync(join(canonicalCliDir, 'conversations'))).toBe(true)
      expect(existsSync(testFileInConv)).toBe(true)
      expect(readFileSync(testFileInConv, 'utf8')).toBe(JSON.stringify({ preserved: true }))

      expect(existsSync(join(canonicalCliDir, 'brain'))).toBe(true)
      expect(existsSync(testBrainFile)).toBe(true)

      expect(existsSync(join(canonicalCliDir, 'conversation_summaries.db'))).toBe(true)
      expect(existsSync(join(canonicalCliDir, 'history.jsonl'))).toBe(true)
    })

    it('safely handles non-existent account removal', () => {
      expect(() => {
        removeAntigravityAccountProfile('non-existent-account-xyz', { homeDir: tempHome })
      }).not.toThrow()
    })
  })
})
