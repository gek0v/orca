// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import {
  createTauriPreloadApi,
  installTauriPreloadApi,
  setInitialCachedSettings
} from './tauri-preload-adapter'

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel<T> {
    onmessage?: (data: T) => void
    send(data: T): void {
      this.onmessage?.(data)
    }
  }
  return {
    invoke: vi
      .fn()
      .mockImplementation((cmd: string, args?: unknown) =>
        Promise.resolve({ cmd, args, mockResult: true })
      ),
    Channel: MockChannel
  }
})

vi.mock('@tauri-apps/api/event', () => {
  const activeListeners = new Map<string, Set<(event: { payload: unknown }) => void>>()
  return {
    listen: vi.fn().mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
      if (!activeListeners.has(event)) {
        activeListeners.set(event, new Set())
      }
      activeListeners.get(event)!.add(cb)
      const unlistenFn = vi.fn().mockImplementation(() => {
        activeListeners.get(event)?.delete(cb)
      })
      return Promise.resolve(unlistenFn)
    }),
    __activeListeners: activeListeners
  }
})

describe('Adversarial Empirical Stress Suite: Tauri Preload Adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
    // Reset initial cached settings
    setInitialCachedSettings({})
  })

  afterEach(() => {
    sessionStorage.clear()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  describe('1. settings.getSync() and stageBeforeUnloadSync() under Rapid State Updates', () => {
    it('handles 100 rapid concurrent settings.set calls maintaining cache consistency', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing rapid settings.set and getSync with key.
      const settingsApi = api.settings as unknown as {
        set: (args: Record<string, unknown>) => Promise<unknown>
        getSync: (key?: string) => unknown
      }

      // 100 rapid asynchronous updates
      const updates = Array.from({ length: 100 }, (_, i) => ({
        [`key_${i % 10}`]: `value_${i}`
      }))

      for (const update of updates) {
        void settingsApi.set(update)
      }

      // getSync must immediately reflect the latest synchronous cache state
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Checking full cache shape.
      const syncResult = settingsApi.getSync() as Record<string, unknown>
      expect(syncResult).toBeDefined()
      // Keys 0 to 9 must have the latest values (90 to 99)
      for (let k = 0; k < 10; k++) {
        expect(settingsApi.getSync(`key_${k}`)).toBe(`value_${90 + k}`)
      }

      expect(invoke).toHaveBeenCalledTimes(100)
    })

    it('correctly handles uninitialized and null cachedSettings in getSync', () => {
      // Force null cached settings
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing null cache state.
      setInitialCachedSettings(null as unknown as Record<string, unknown>)
      const api = createTauriPreloadApi()

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing getSync with key parameter.
      const settingsApi = api.settings as unknown as {
        set: (args: Record<string, unknown>) => Promise<unknown>
        getSync: (key?: string) => unknown
      }

      expect(settingsApi.getSync()).toBeNull()
      expect(settingsApi.getSync('nonExistentKey')).toBeNull()

      // Calling set when cachedSettings is null should initialize cache
      void settingsApi.set({ theme: 'dark' })
      expect(settingsApi.getSync('theme')).toBe('dark')
      expect(settingsApi.getSync()).toEqual({ theme: 'dark' })
    })

    it('manages complex nested objects and non-existent keys in settings.get', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const complexPayload = {
        theme: 'synthwave',
        nested: { deep: { alpha: 42, beta: [1, 2, 3] } },
        flags: [true, false]
      }
      vi.mocked(invoke).mockResolvedValueOnce(complexPayload)

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing settings.get and getSync with key parameter.
      const settingsApi = api.settings as unknown as {
        get: (k?: string) => Promise<unknown>
        getSync: (k?: string) => unknown
      }

      // settings.get() with key that exists
      const nestedResult = await settingsApi.get('nested')
      expect(nestedResult).toEqual({ deep: { alpha: 42, beta: [1, 2, 3] } })
      expect(settingsApi.getSync('nested')).toEqual({ deep: { alpha: 42, beta: [1, 2, 3] } })

      // settings.get() with non-existent key from backend that returns a record
      vi.mocked(invoke).mockResolvedValueOnce({ otherKey: 'val' })
      const missingResult = await settingsApi.get('missingKey')
      // If missing, verify get does not crash
      expect(missingResult).toBeDefined()
    })

    it('survives rapid successive stageBeforeUnloadSync calls with large payloads', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing stageBeforeUnloadSync with arbitrary session tree.
      const appApi = api.app as unknown as { stageBeforeUnloadSync: (args: unknown) => void }

      // Generate a ~100KB session tree
      const largeSessions = Array.from({ length: 50 }, (_, i) => ({
        id: `session-${i}`,
        repoId: `repo-${i}`,
        tabs: Array.from({ length: 10 }, (_, j) => ({
          tabId: `tab-${i}-${j}`,
          title: `Terminal ${i}-${j}`,
          scrollback: 'x'.repeat(100)
        }))
      }))

      for (let i = 0; i < 20; i++) {
        const payload = {
          iteration: i,
          sessions: largeSessions,
          ui: { activeTab: `tab-${i}-0` }
        }
        expect(() => appApi.stageBeforeUnloadSync(payload)).not.toThrow()
      }

      // Check that sessionStorage has the last serialized snapshot
      const stored = sessionStorage.getItem('orca:stage-before-unload-snapshot')
      expect(stored).toBeDefined()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Parse stored snapshot.
      const parsed = JSON.parse(stored!) as { iteration: number }
      expect(parsed.iteration).toBe(19)
      expect(invoke).toHaveBeenCalledWith('app_stage_before_unload', expect.anything())
    })

    it('safely catches circular references in stageBeforeUnloadSync without throwing', () => {
      const api = createTauriPreloadApi()
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing stageBeforeUnloadSync with circular object.
      const appApi = api.app as unknown as { stageBeforeUnloadSync: (args: unknown) => void }
      const circularObj: Record<string, unknown> = { name: 'circular' }
      circularObj.self = circularObj

      expect(() => appApi.stageBeforeUnloadSync(circularObj)).not.toThrow()
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[TauriAdapter] Failed to mirror stageBeforeUnload to sessionStorage:'
        ),
        expect.any(TypeError)
      )

      consoleErrorSpy.mockRestore()
    })
  })

  describe('2. platform.get() Conformance with PreloadApi["platform"]', () => {
    it('strictly satisfies PreloadApi["platform"] type contracts synchronously', () => {
      const api = createTauriPreloadApi()

      // Must be callable synchronously
      const platformInfo = api.platform.get()

      // Verify contract fields
      expect(typeof platformInfo).toBe('object')
      expect(platformInfo).not.toBeNull()

      // platform: NodeJS.Platform
      expect(['win32', 'darwin', 'linux']).toContain(platformInfo.platform)
      // osRelease: string
      expect(typeof platformInfo.osRelease).toBe('string')
      expect(platformInfo.osRelease.length).toBeGreaterThan(0)
      // arch: string
      expect(typeof platformInfo.arch).toBe('string')
      expect(['x64', 'arm64', 'ia32']).toContain(platformInfo.arch)
      // shell: string
      expect(typeof platformInfo.shell).toBe('string')
      expect(platformInfo.shell.length).toBeGreaterThan(0)
      // displayServer: 'wayland' | 'x11' | null
      expect(['wayland', 'x11', null]).toContain(platformInfo.displayServer)

      // Test idempotency across 50 rapid calls
      for (let i = 0; i < 50; i++) {
        const info = api.platform.get()
        expect(info.platform).toBe(platformInfo.platform)
        expect(info.shell).toBe(platformInfo.shell)
      }
    })

    it('correctly adapts platform and shell based on userAgent string', () => {
      const originalUserAgent = navigator.userAgent

      try {
        // Test Windows userAgent
        Object.defineProperty(navigator, 'userAgent', {
          value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          configurable: true
        })
        const winApi = createTauriPreloadApi()
        expect(winApi.platform.get().platform).toBe('win32')
        expect(winApi.platform.get().shell).toBe('powershell.exe')

        // Test Mac userAgent
        Object.defineProperty(navigator, 'userAgent', {
          value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          configurable: true
        })
        const macApi = createTauriPreloadApi()
        expect(macApi.platform.get().platform).toBe('darwin')
        expect(macApi.platform.get().shell).toBe('/bin/bash')

        // Test Linux userAgent
        Object.defineProperty(navigator, 'userAgent', {
          value: 'Mozilla/5.0 (X11; Linux x86_64)',
          configurable: true
        })
        const linuxApi = createTauriPreloadApi()
        expect(linuxApi.platform.get().platform).toBe('linux')
        expect(linuxApi.platform.get().shell).toBe('/bin/bash')
      } finally {
        Object.defineProperty(navigator, 'userAgent', {
          value: originalUserAgent,
          configurable: true
        })
      }
    })
  })

  describe('3. Dynamic Proxy Fallback and on* Event Unlisten Closures', () => {
    it('dispatches arbitrary unhandled domains and methods via dynamic proxy', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      // Access an arbitrary unhandled domain
      type DynamicMethodCaller = {
        customDomainService: { performComplexAction: (a: string, b: unknown) => Promise<unknown> }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing dynamic proxy domain dispatch.
      const unhandledDomain = (api as unknown as DynamicMethodCaller).customDomainService
      expect(unhandledDomain).toBeDefined()

      // Call arbitrary method
      await unhandledDomain.performComplexAction('alpha', { count: 42 })
      expect(invoke).toHaveBeenCalledWith('customDomainService_performComplexAction', {
        args: ['alpha', { count: 42 }]
      })
    })

    it('creates robust dynamic on* event listeners and cleanly unlistens', async () => {
      const api = createTauriPreloadApi()
      const { listen } = await import('@tauri-apps/api/event')

      const receivedPayloads: unknown[] = []
      const cb = (payload: unknown) => {
        receivedPayloads.push(payload)
      }

      // Dynamic domain on* subscription
      type BillingSubscriber = {
        billing: { onInvoiceCreated: (cb: (payload: unknown) => void) => () => void }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing dynamic proxy on* event subscription.
      const billingApi = (api as unknown as BillingSubscriber).billing
      const unlisten = billingApi.onInvoiceCreated(cb)
      expect(typeof unlisten).toBe('function')
      expect(listen).toHaveBeenCalledWith('billing:onInvoiceCreated', expect.any(Function))

      // Simulate event firing
      const listenCall = vi
        .mocked(listen)
        .mock.calls.find((c) => c[0] === 'billing:onInvoiceCreated')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Access mocked listener handler.
      const handlerFn = listenCall?.[1] as (event: { payload: unknown }) => void
      expect(handlerFn).toBeDefined()

      handlerFn({ payload: { invoiceId: 'inv-123', amount: 99.5 } })
      expect(receivedPayloads).toEqual([{ invoiceId: 'inv-123', amount: 99.5 }])

      // Unlisten and verify no double-event delivery
      unlisten()
      handlerFn({ payload: { invoiceId: 'inv-456', amount: 10 } })
      // Because disposed = true inside subscribeTauri, handlerFn ignores payload
      expect(receivedPayloads.length).toBe(1)

      // Subsequent unlisten calls must be idempotent and not throw
      expect(() => unlisten()).not.toThrow()
    })

    it('safely handles synchronous unlisten before listen promise resolves', async () => {
      const api = createTauriPreloadApi()

      type MetricsSubscriber = {
        metrics: { onGaugeUpdated: (cb: () => void) => () => void }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing dynamic proxy event subscription on unhandled domain.
      const metricsApi = (api as unknown as MetricsSubscriber).metrics
      const unlisten = metricsApi.onGaugeUpdated(() => {})
      // Immediately call unlisten before event mock promise tick
      expect(() => unlisten()).not.toThrow()

      // Verify that after ticks, unlisten still operates cleanly
      await Promise.resolve()
      expect(() => unlisten()).not.toThrow()
    })

    it('stress tests proxy against symbol properties and thenable checks', () => {
      const api = createTauriPreloadApi()

      // Test symbol property access on explicit override domain
      expect(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing symbol property access on explicit override domain.
        const settingsObj = api.settings as unknown as Record<symbol, unknown>
        void settingsObj[Symbol.toStringTag]
      }).not.toThrow()

      // Test symbol property access on dynamic domain
      expect(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing symbol property access on dynamic domain.
        const unknownObj = (api as unknown as Record<string, Record<symbol, unknown>>).unknownDomain
        void unknownObj[Symbol.iterator]
      }).not.toThrow()

      // Test toString and valueOf
      expect(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing string conversion on dynamic domain proxy.
        const unknownDomainProxy = (api as unknown as Record<string, unknown>).unknownDomain
        String(unknownDomainProxy)
      }).not.toThrow()
    })

    it('does not treat proxy domains as thenables (preventing infinite await hangs)', async () => {
      const api = createTauriPreloadApi()

      // Passing an object to Promise.resolve checks .then property
      // If .then returns a function that does not call resolve/reject, Promise hangs forever.
      const resolved = await Promise.race([
        Promise.resolve(api.projects).then(() => 'RESOLVED'),
        new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 100))
      ])

      expect(resolved).toBe('RESOLVED')
    })

    it('does not treat window.api itself as a thenable', async () => {
      const api = createTauriPreloadApi()
      const resolved = await Promise.race([
        Promise.resolve(api).then(() => 'RESOLVED'),
        new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 100))
      ])
      expect(resolved).toBe('RESOLVED')
    })

    it('exhaustively stress tests Symbol property lookups across ALL domain proxies without throwing', () => {
      const api = createTauriPreloadApi()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing dynamic symbol access across all domain proxies.
      const rawApi = api as unknown as Record<string, Record<string | symbol, unknown>>

      const allDomains = [
        'app',
        'settings',
        'opencodeGoCredentials',
        'credentials',
        'session',
        'orcad',
        'watcher',
        'ui',
        'platform',
        'fs',
        'pty',
        'orcaProfiles',
        'e2e',
        'repos',
        'projects',
        'projectGroups',
        'folderWorkspaces',
        'sparsePresets',
        'worktrees',
        'workspaceCleanup',
        'workspaceSpace',
        'workspacePorts',
        'feedback',
        'crashReports',
        'export',
        'gh',
        'hostedReview',
        'gl',
        'bitbucket',
        'linear',
        'jira',
        'starNag',
        'diagnostics',
        'agentAwake',
        'localhostWorktreeLabels',
        'keybindings',
        'codexAccounts',
        'claudeAccounts',
        'cli',
        'codexConfigSync',
        'preflight',
        'notifications',
        'onboarding',
        'dashboard',
        'terminalPreview',
        'macosTccPrompts',
        'developerPermissions',
        'computerUsePermissions',
        'shell',
        'skills',
        'pet',
        'browser',
        'emulator',
        'hooks',
        'ephemeralVm',
        'cache',
        'remoteWorkspace',
        'updater',
        'notebook',
        'docPreview',
        'stats',
        'memory',
        'claudeUsage',
        'codexUsage',
        'openCodeUsage',
        'museUsage',
        'antigravityUsage',
        'aiVault',
        'nativeChat',
        'git',
        'runtime',
        'runtimeEnvironments',
        'rateLimits',
        'minimaxCredentials',
        'zcodePlanCredentials',
        'grokAccounts',
        'cursorAccounts',
        'ssh',
        'automations',
        'wsl',
        'pwsh',
        'gitBash',
        'plugins',
        'agentStatus',
        'mobile',
        'speech',
        'goals',
        'unknownDomain',
        'arbitraryCustomService',
        'nonExistentSubsystem'
      ]

      const stressSymbols = [
        Symbol.toStringTag,
        Symbol.iterator,
        Symbol.asyncIterator,
        Symbol.hasInstance,
        Symbol.isConcatSpreadable,
        Symbol.toPrimitive,
        Symbol.match,
        Symbol.matchAll,
        Symbol.replace,
        Symbol.search,
        Symbol.split,
        Symbol.unscopables,
        Symbol.dispose,
        Symbol.asyncDispose,
        Symbol.for('nodejs.util.inspect.custom'),
        Symbol('adversarialSymbol'),
        Symbol('')
      ]

      // Verify root proxy against all symbols
      for (const sym of stressSymbols) {
        expect(() => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing root proxy with symbols.
          const val = (rawApi as unknown as Record<symbol, unknown>)[sym]
          expect(val).toBeUndefined()
        }).not.toThrow()
      }

      // Verify all domain proxies against all symbols and string conversion
      for (const domain of allDomains) {
        const domainProxy = rawApi[domain]
        expect(domainProxy).toBeDefined()
        for (const sym of stressSymbols) {
          expect(() => {
            const val = domainProxy[sym]
            expect(val).toBeUndefined()
          }).not.toThrow()
        }

        expect(() => String(domainProxy)).not.toThrow()
        expect(() => Object.prototype.toString.call(domainProxy)).not.toThrow()
      }

      // Verify nested object (pty.management)
      type PtyWithManagement = { management: Record<string | symbol, unknown> }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing nested pty.management symbols.
      const ptyManagement = (api.pty as unknown as PtyWithManagement).management
      expect(ptyManagement).toBeDefined()
      for (const sym of stressSymbols) {
        expect(() => {
          const val = ptyManagement[sym]
          expect(val).toBeUndefined()
        }).not.toThrow()
      }
    })

    it('exhaustively verifies Promise.resolve(api.<domain>) and await api.<domain> across ALL domains (zero hangs)', async () => {
      const api = createTauriPreloadApi()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing thenable handling across all domain proxies.
      const rawApi = api as unknown as Record<string, unknown>

      const allDomains = [
        'app',
        'settings',
        'opencodeGoCredentials',
        'credentials',
        'session',
        'orcad',
        'watcher',
        'ui',
        'platform',
        'fs',
        'pty',
        'orcaProfiles',
        'e2e',
        'repos',
        'projects',
        'projectGroups',
        'folderWorkspaces',
        'sparsePresets',
        'worktrees',
        'workspaceCleanup',
        'workspaceSpace',
        'workspacePorts',
        'feedback',
        'crashReports',
        'export',
        'gh',
        'hostedReview',
        'gl',
        'bitbucket',
        'linear',
        'jira',
        'starNag',
        'diagnostics',
        'agentAwake',
        'localhostWorktreeLabels',
        'keybindings',
        'codexAccounts',
        'claudeAccounts',
        'cli',
        'codexConfigSync',
        'preflight',
        'notifications',
        'onboarding',
        'dashboard',
        'terminalPreview',
        'macosTccPrompts',
        'developerPermissions',
        'computerUsePermissions',
        'shell',
        'skills',
        'pet',
        'browser',
        'emulator',
        'hooks',
        'ephemeralVm',
        'cache',
        'remoteWorkspace',
        'updater',
        'notebook',
        'docPreview',
        'stats',
        'memory',
        'claudeUsage',
        'codexUsage',
        'openCodeUsage',
        'museUsage',
        'antigravityUsage',
        'aiVault',
        'nativeChat',
        'git',
        'runtime',
        'runtimeEnvironments',
        'rateLimits',
        'minimaxCredentials',
        'zcodePlanCredentials',
        'grokAccounts',
        'cursorAccounts',
        'ssh',
        'automations',
        'wsl',
        'pwsh',
        'gitBash',
        'plugins',
        'agentStatus',
        'mobile',
        'speech',
        'goals',
        'unknownDomain',
        'arbitraryCustomService',
        'nonExistentSubsystem'
      ]

      // 1. Root api object
      const rootResolved = await Promise.race([
        Promise.resolve(api).then((val) => val === api),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))
      ])
      expect(rootResolved).toBe(true)

      // 2. All domain proxies: verify .then is undefined, Promise.resolve does not hang, and await resolves
      for (const domain of allDomains) {
        const target = rawApi[domain]
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Checking then property.
        expect((target as { then?: unknown })?.then).toBeUndefined()

        const resolvePromise = Promise.resolve(target)
        const resolved = await Promise.race([
          resolvePromise.then((val) => val === target),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))
        ])
        expect(resolved).toBe(true)

        const awaited = await (async () => target)()
        expect(awaited).toBe(target)
      }

      // 3. Batch resolution with Promise.all
      const allResolved = await Promise.race([
        Promise.all(allDomains.map(async (d) => await rawApi[d])),
        new Promise<unknown[]>((resolve) => setTimeout(() => resolve(['TIMEOUT']), 100))
      ])
      expect(allResolved).not.toContain('TIMEOUT')
      expect(allResolved.length).toBe(allDomains.length)

      // 4. Nested object: pty.management
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing pty.management thenable handling.
      const ptyManagement = (api.pty as unknown as { management: unknown }).management
      const ptyManagementResolved = await Promise.race([
        Promise.resolve(ptyManagement).then((val) => val === ptyManagement),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))
      ])
      expect(ptyManagementResolved).toBe(true)
    })
  })

  describe('4. React 19 / Zustand Initialization Timing & Mount Safety', () => {
    it('installs cleanly before React renders and permits safe Zustand store reads', () => {
      Reflect.set(window, '__TAURI_INTERNALS__', {})
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing null cache state.
      setInitialCachedSettings(null as unknown as Record<string, unknown>)
      installTauriPreloadApi()

      expect(window.api).toBeDefined()

      type TestStore = { settings: Record<string, unknown> | null }
      const useTestStore = create<TestStore>(() => ({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Testing synchronous store initialization against window.api.settings.getSync.
        settings: window.api.settings.getSync() as Record<string, unknown> | null
      }))

      // Verify store can access window.api synchronously without throwing or deadlocking
      expect(() => {
        const currentSettings = useTestStore.getState().settings
        expect(currentSettings).toBeNull()
      }).not.toThrow()
    })

    it('simulates React 19 StrictMode double-mount cycle without listener leakage or deadlocks', async () => {
      Reflect.set(window, '__TAURI_INTERNALS__', {})
      installTauriPreloadApi()

      // Pass 1: Mount effect
      const cleanupPass1 = window.api.settings.onChanged(() => {})
      const ptyUnlisten1 = window.api.pty.onData(() => {})

      // Pass 1: Cleanup (StrictMode unmount simulation)
      cleanupPass1()
      ptyUnlisten1()

      // Pass 2: Remount
      const cleanupPass2 = window.api.settings.onChanged(() => {})
      const ptyUnlisten2 = window.api.pty.onData(() => {})

      expect(typeof cleanupPass2).toBe('function')
      expect(typeof ptyUnlisten2).toBe('function')

      // Ensure cleanup succeeds without throwing
      expect(() => {
        cleanupPass2()
        ptyUnlisten2()
      }).not.toThrow()
    })

    it('executes store fetchSettings without hydration errors against Tauri adapter', async () => {
      Reflect.set(window, '__TAURI_INTERNALS__', {})
      installTauriPreloadApi()

      const { invoke } = await import('@tauri-apps/api/core')
      const mockSettings = {
        theme: 'dark',
        fontSize: 14,
        appFontFamily: 'system-ui'
      }
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'settings_get') {
          return Promise.resolve(mockSettings)
        }
        return Promise.resolve({})
      })

      type TestHydrationStore = {
        settings: Record<string, unknown> | null
        fetchSettings: () => Promise<void>
      }
      const useHydrationStore = create<TestHydrationStore>((set) => ({
        settings: null,
        fetchSettings: async () => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Hydrate store settings.
          const fetched = (await window.api.settings.get()) as Record<string, unknown>
          set({ settings: fetched })
        }
      }))

      // Trigger store fetchSettings
      await useHydrationStore.getState().fetchSettings()

      const updatedSettings = useHydrationStore.getState().settings
      expect(updatedSettings).toEqual(mockSettings)
    })
  })
})
