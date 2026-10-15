/**
 * @vitest-environment happy-dom
 */
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT } from '@/constants/terminal'
import { requestActiveTerminalPaneSplit } from './request-active-terminal-pane-split'
import { SortableTabContextMenu } from './SortableTabContextMenu'

type MockTabRecord = {
  id: string
  ptyId?: string | null
  worktreeId?: string
  title?: string
  launchAgent?: string
  launchAccountId?: string
  customTitle?: string | null
  color?: string | null
  sortOrder?: number
  createdAt?: number
  [key: string]: unknown
}

type MockStoreState = {
  keybindings: Record<string, unknown>
  unifiedTabsByWorktree: Record<string, MockTabRecord[]>
  groupsByWorktree: Record<string, unknown>
  tabsByWorktree?: Record<string, MockTabRecord[]>
  [key: string]: unknown
}

type MockStore = {
  dropUnifiedTab: ReturnType<typeof vi.fn>
  state: MockStoreState
}

const storeMock: MockStore = vi.hoisted(() => ({
  dropUnifiedTab: vi.fn(),
  state: {
    keybindings: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {}
  }
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  formatShortcutLabel: () => '⌘D',
  useOptionalShortcutLabel: () => '⌘D'
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => children
}))

vi.mock('lucide-react', () => ({
  ArrowDown: () => null,
  ArrowLeft: () => null,
  ArrowRight: () => null,
  ArrowUp: () => null,
  Columns2: () => null,
  Copy: () => null,
  ListX: () => null,
  MessageSquare: () => null,
  PanelBottomClose: () => null,
  PanelLeftClose: () => null,
  PanelRightClose: () => null,
  Pencil: () => null,
  Pin: () => null,
  PinOff: () => null,
  SquareTerminal: () => null,
  Check: () => null,
  User: () => null,
  X: () => null
}))

type MockAccount = {
  id: string
  alias?: string | null
  email?: string | null
  subject?: string | null
  color?: string | null
  emoji?: string | null
}

type AccountsMock = {
  accounts: MockAccount[]
  activeAccount: MockAccount | null
}

const accountsMock: AccountsMock = vi.hoisted(() => ({
  accounts: [],
  activeAccount: null
}))

vi.mock('@/hooks/useAntigravityAccounts', () => ({
  useAntigravityAccounts: () => ({
    state: null,
    accounts: accountsMock.accounts,
    activeAccount: accountsMock.activeAccount,
    getAccountById: (id: string) => accountsMock.accounts.find((a) => a.id === id) ?? null
  }),
  setCachedAntigravityAccountsState: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('./TabSessionSurfaceSwitchMenuItems', () => ({
  TabSessionSurfaceSwitchMenuItems: ({
    tab,
    nativeChat,
    leadingSeparator
  }: {
    tab: { id: string }
    nativeChat?: { sessionId: string }
    leadingSeparator: boolean
  }) => (
    <div
      data-testid="session-surface-switch"
      data-tab-id={tab.id}
      data-structured-session-id={nativeChat?.sessionId ?? ''}
      data-leading-separator={String(leadingSeparator)}
    />
  )
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: MockStoreState) => unknown) => selector(storeMock.state),
    {
      getState: () => storeMock.state,
      setState: (
        updater:
          | Partial<MockStoreState>
          | ((prev: MockStoreState) => Partial<MockStoreState> | MockStoreState)
      ) => {
        if (typeof updater === 'function') {
          const next = updater(storeMock.state)
          storeMock.state = { ...storeMock.state, ...next }
        } else if (updater && typeof updater === 'object') {
          storeMock.state = { ...storeMock.state, ...updater }
        }
      }
    }
  )
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderMenu(overrides: Partial<ComponentProps<typeof SortableTabContextMenu>> = {}): {
  container: HTMLDivElement
  root: Root
  onActivate: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onActivate = vi.fn()
  act(() => {
    root.render(
      <SortableTabContextMenu
        tab={{ id: 'term-1', worktreeId: 'wt-1', color: null }}
        unifiedTabId="tab-1"
        groupId="group-1"
        isActive
        open
        point={{ x: 0, y: 0 }}
        tabCount={2}
        hasTabsToRight
        hasTabsToLeft
        isPinned={false}
        onOpenChange={vi.fn()}
        onActivate={onActivate}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseToLeft={vi.fn()}
        onRenameOpen={vi.fn()}
        onSetTabColor={vi.fn()}
        onTogglePin={vi.fn()}
        {...overrides}
      />
    )
  })
  mounted.push({ container, root })
  return { container, root, onActivate }
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`)
  }
  return button
}

function getSurfaceSwitchMarker(container: HTMLElement): Element {
  const marker = container.querySelector('[data-testid="session-surface-switch"]')
  if (!marker) {
    throw new Error('Missing session surface switch items')
  }
  return marker
}

function getLastSplitEvent(spy: ReturnType<typeof vi.spyOn>): CustomEvent {
  const event = spy.mock.calls.at(-1)?.[0]
  if (!(event instanceof CustomEvent)) {
    throw new Error('Expected a split request event')
  }
  return event
}

beforeEach(() => {
  accountsMock.accounts = [
    {
      id: 'acc-1',
      alias: 'Work',
      email: 'work@example.com',
      subject: null,
      color: '#3b82f6',
      emoji: null
    },
    {
      id: 'acc-2',
      alias: 'Personal',
      email: 'personal@example.com',
      subject: null,
      color: '#10b981',
      emoji: null
    }
  ]
  accountsMock.activeAccount = accountsMock.accounts[0]

  storeMock.dropUnifiedTab.mockReset()
  storeMock.state = {
    keybindings: {},
    dropUnifiedTab: storeMock.dropUnifiedTab,
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: 'tab-1',
          tabOrder: ['tab-1', 'tab-2']
        }
      ]
    },
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'term-1',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'bash',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'terminal',
          entityId: 'term-1',
          label: 'bash',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  }
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  vi.restoreAllMocks()
})

describe('requestActiveTerminalPaneSplit', () => {
  it('dispatches the active terminal pane split event', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    requestActiveTerminalPaneSplit({ tabId: 'term-1', direction: 'vertical' })

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const event = dispatchSpy.mock.calls[0]?.[0] as CustomEvent
    expect(event.type).toBe(REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT)
    expect(event.detail).toEqual({
      tabId: 'term-1',
      direction: 'vertical'
    })
  })
})

describe('SortableTabContextMenu', () => {
  it.each([false, true])(
    'copies the workspace ID of an inactive tab (pinned: %s)',
    async (isPinned) => {
      const writeClipboardText = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      const onRenameOpen = vi.fn()
      const apiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { ui: { writeClipboardText } }
      })
      try {
        const { container, onActivate } = renderMenu({
          isActive: false,
          isPinned,
          onClose,
          onRenameOpen
        })
        await act(async () => getButton(container, 'Copy Tab ID').click())
        expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('orcaTabId: tab-1')
        expect(onActivate).not.toHaveBeenCalled()
        expect(onClose).not.toHaveBeenCalled()
        expect(onRenameOpen).not.toHaveBeenCalled()
      } finally {
        if (apiDescriptor) {
          Object.defineProperty(window, 'api', apiDescriptor)
        } else {
          Reflect.deleteProperty(window, 'api')
        }
      }
    }
  )

  it('does not expose a native/terminal view switch', () => {
    const { container } = renderMenu()

    expect(container.textContent).not.toContain('Switch to terminal view')
    expect(container.textContent).not.toContain('Switch to chat view')
  })

  it('hides switching a terminal-view tab into chat view', () => {
    const { container } = renderMenu({ canToggleViewMode: true, onToggleViewMode: vi.fn() })

    expect(container.textContent).not.toContain('Switch to chat view')
  })

  it('keeps the way back for a tab already in chat view, in the chat/CLI move section', () => {
    const onToggleViewMode = vi.fn()
    const { container } = renderMenu({
      canToggleViewMode: true,
      isChatView: true,
      onToggleViewMode
    })
    const marker = getSurfaceSwitchMarker(container)

    expect(getButton(container, 'Switch to terminal view').compareDocumentPosition(marker)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(marker.getAttribute('data-leading-separator')).toBe('false')
    act(() => getButton(container, 'Switch to terminal view').click())
    expect(onToggleViewMode).toHaveBeenCalled()
  })

  it('offers the session-history chat/CLI move right above Pin Tab', () => {
    const { container } = renderMenu({ nativeChat: { sessionId: 'orca-chat-1', agent: 'codex' } })
    const marker = getSurfaceSwitchMarker(container)

    expect(marker.getAttribute('data-tab-id')).toBe('term-1')
    expect(marker.getAttribute('data-structured-session-id')).toBe('orca-chat-1')
    expect(marker.getAttribute('data-leading-separator')).toBe('true')
    expect(getButton(container, 'Split terminal').compareDocumentPosition(marker)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(marker.compareDocumentPosition(getButton(container, 'Pin Tab'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('dispatches split requests and activates inactive terminal tabs first', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const { container, onActivate } = renderMenu({ isActive: false })

    act(() => getButton(container, 'Split terminal right').click())
    expect(onActivate).toHaveBeenCalledWith('term-1')
    expect(getLastSplitEvent(dispatchSpy).detail).toEqual({
      tabId: 'term-1',
      direction: 'vertical'
    })

    dispatchSpy.mockClear()
    act(() => getButton(container, 'Split terminal down').click())
    expect(getLastSplitEvent(dispatchSpy).detail).toEqual({
      tabId: 'term-1',
      direction: 'horizontal'
    })
  })

  it('renders split actions and routes directions to the move path', () => {
    storeMock.dropUnifiedTab.mockReturnValue(true)
    const { container } = renderMenu()

    expect(container.textContent).toContain('Move Tab to Split')
    expect(container.textContent).toContain('Split terminal')

    act(() => getButton(container, 'Right').click())
    expect(storeMock.dropUnifiedTab).toHaveBeenCalledWith('tab-1', {
      groupId: 'group-1',
      splitDirection: 'right'
    })
  })

  it('hides terminal-only split actions for structured chat tabs', () => {
    const { container } = renderMenu({ canSplitTerminal: false })

    expect(container.textContent).toContain('Move Tab to Split')
    expect(container.textContent).not.toContain('Split terminal')
  })

  it('routes the directional close actions to their handlers with the tab id', () => {
    const onCloseOthers = vi.fn()
    const onCloseToRight = vi.fn()
    const onCloseToLeft = vi.fn()
    const { container } = renderMenu({
      onCloseOthers,
      onCloseToRight,
      onCloseToLeft
    })

    act(() => getButton(container, 'Close Others').click())
    expect(onCloseOthers).toHaveBeenCalledWith('term-1')

    act(() => getButton(container, 'Close Tabs To The Right').click())
    expect(onCloseToRight).toHaveBeenCalledWith('term-1')

    act(() => getButton(container, 'Close Tabs To The Left').click())
    expect(onCloseToLeft).toHaveBeenCalledWith('term-1')
  })

  it('disables directional closes when no tabs exist on that side', () => {
    const { container } = renderMenu({
      hasTabsToLeft: false,
      hasTabsToRight: false
    })

    expect(getButton(container, 'Close Tabs To The Left').disabled).toBe(true)
    expect(getButton(container, 'Close Tabs To The Right').disabled).toBe(true)
  })

  it('hides move-tab split actions for a single-tab group', () => {
    storeMock.state = {
      ...storeMock.state,
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'tab-1',
            tabOrder: ['tab-1']
          }
        ]
      }
    }
    const { container } = renderMenu()

    expect(container.textContent).not.toContain('Move Tab to Split')
    expect(container.textContent).toContain('Split terminal right')
  })

  it('does not render an Account submenu when the tab is not an Antigravity agent', () => {
    const { container } = renderMenu({
      tab: {
        id: 'term-1',
        worktreeId: 'wt-1',
        color: null
      }
    })

    expect(container.textContent).not.toContain('Account')
  })

  it('renders an Account submenu when tab.launchAgent is antigravity', () => {
    const { container } = renderMenu({
      tab: {
        id: 'term-1',
        worktreeId: 'wt-1',
        launchAgent: 'antigravity',
        launchAccountId: 'acc-1',
        color: null
      }
    })

    expect(container.textContent).toContain('Account')
    expect(container.textContent).toContain('Work (work@example.com)')
    expect(container.textContent).toContain('Personal (personal@example.com)')
  })

  it('updates tab.launchAccountId in store when selecting another account', () => {
    const { container } = renderMenu({
      tab: {
        id: 'term-1',
        worktreeId: 'wt-1',
        launchAgent: 'antigravity',
        launchAccountId: 'acc-1',
        color: null
      }
    })

    act(() => getButton(container, 'Personal (personal@example.com)').click())

    const tabs = storeMock.state.tabsByWorktree?.['wt-1']
    expect(tabs?.[0]?.launchAccountId).toBe('acc-2')

    const unifiedTabs = storeMock.state.unifiedTabsByWorktree['wt-1']
    expect(unifiedTabs?.[0]?.launchAccountId).toBe('acc-2')
  })

  it('renders disabled "No saved accounts" when Antigravity has no accounts', () => {
    accountsMock.accounts = []
    accountsMock.activeAccount = null

    const { container } = renderMenu({
      tab: {
        id: 'term-1',
        worktreeId: 'wt-1',
        launchAgent: 'antigravity',
        color: null
      }
    })

    expect(container.textContent).toContain('Account')
    expect(container.textContent).toContain('No saved accounts')
    expect(getButton(container, 'No saved accounts').disabled).toBe(true)
  })
})
