// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTauriPreloadApi } from './tauri-preload-adapter'

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel<T> {
    onmessage?: (data: T) => void
    send(data: T): void {
      this.onmessage?.(data)
    }
  }
  return {
    invoke: vi.fn().mockImplementation((cmd, args) => Promise.resolve({ cmd, args })),
    Channel: MockChannel
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockImplementation((_event, _cb) => Promise.resolve(vi.fn()))
}))

function makeFrame(
  opcode: number,
  payload: Uint8Array | number[],
  opts?: { kind?: number; version?: number; streamId?: number; seq?: number }
): Uint8Array {
  const kind = opts?.kind ?? 0x74
  const version = opts?.version ?? 0x01
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
  const frame = new Uint8Array(16 + payloadBytes.length)
  frame[0] = kind
  frame[1] = version
  frame[2] = opcode
  frame[3] = 0x00 // reserved

  const dv = new DataView(frame.buffer)
  dv.setUint32(4, opts?.streamId ?? 1, true)
  dv.setUint32(8, 0, true) // seq high
  dv.setUint32(12, opts?.seq ?? 0, true) // seq low

  frame.set(payloadBytes, 16)
  return frame
}

describe('Adversarial PTY Binary Framing Stress Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  describe('1. Multibyte UTF-8 Boundary Splitting Across Frames', () => {
    it('handles 2-byte Latin UTF-8 characters split across frame boundaries without \\uFFFD', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const received: string[] = []
      const unsub = api.pty.onData((d) => received.push(d.data))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-utf8-2byte' })
      const lastCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // 'ñ' is [0xC3, 0xB1], 'é' is [0xC3, 0xA9]
      // Split 'año café': 'a' (1b), 'ñ' [0xC3 | 0xB1], 'o c' (3b), 'a' (1b), 'f' (1b), 'é' [0xC3 | 0xA9]
      const f1 = makeFrame(1, [0x61, 0xc3]) // 'a' + first byte of 'ñ'
      const f2 = makeFrame(1, [0xb1, 0x6f, 0x20, 0x63, 0x61, 0x66, 0xc3]) // second byte of 'ñ' + 'o caf' + first byte of 'é'
      const f3 = makeFrame(1, [0xa9]) // second byte of 'é'

      ch?.send(f1)
      ch?.send(f2)
      ch?.send(f3)

      const fullOutput = received.join('')
      expect(fullOutput).toBe('año café')
      expect(fullOutput.includes('\uFFFD')).toBe(false)
      unsub()
    })

    it('handles 3-byte CJK and Euro characters split at all possible byte boundaries', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const received: string[] = []
      const unsub = api.pty.onData((d) => received.push(d.data))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-utf8-3byte' })
      const lastCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // '中' is [0xE4, 0xB8, 0xAD]
      // Case A: 1 byte + 2 bytes
      ch?.send(makeFrame(1, [0xe4]))
      expect(received.length).toBe(0) // Should buffer, not emit replacement char
      ch?.send(makeFrame(1, [0xb8, 0xad]))
      expect(received.join('')).toBe('中')
      expect(received.join('').includes('\uFFFD')).toBe(false)

      received.length = 0

      // '文' is [0xE6, 0x96, 0x87]
      // Case B: 2 bytes + 1 byte
      ch?.send(makeFrame(1, [0xe6, 0x96]))
      expect(received.length).toBe(0)
      ch?.send(makeFrame(1, [0x87]))
      expect(received.join('')).toBe('文')
      expect(received.join('').includes('\uFFFD')).toBe(false)

      received.length = 0

      // '€' is [0xE2, 0x82, 0xAC]
      // Case C: 1 byte + 1 byte + 1 byte
      ch?.send(makeFrame(1, [0xe2]))
      expect(received.length).toBe(0)
      ch?.send(makeFrame(1, [0x82]))
      expect(received.length).toBe(0)
      ch?.send(makeFrame(1, [0xac]))
      expect(received.join('')).toBe('€')
      expect(received.join('').includes('\uFFFD')).toBe(false)

      unsub()
    })

    it('handles 4-byte Emojis split across 2, 3, and 4 frame boundaries without \\uFFFD', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const received: string[] = []
      const unsub = api.pty.onData((d) => received.push(d.data))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-utf8-4byte' })
      const lastCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // '🚀' is [0xF0, 0x9F, 0x9A, 0x80]
      // Split into 4 individual frames (1 byte each)
      ch?.send(makeFrame(1, [0xf0]))
      expect(received.length).toBe(0)
      ch?.send(makeFrame(1, [0x9f]))
      expect(received.length).toBe(0)
      ch?.send(makeFrame(1, [0x9a]))
      expect(received.length).toBe(0)
      ch?.send(makeFrame(1, [0x80]))
      expect(received.join('')).toBe('🚀')
      expect(received.join('').includes('\uFFFD')).toBe(false)

      received.length = 0

      // '🎉' is [0xF0, 0x9F, 0x8E, 0x89]
      // Split 2 bytes + 2 bytes
      ch?.send(makeFrame(1, [0xf0, 0x9f]))
      expect(received.length).toBe(0)
      ch?.send(makeFrame(1, [0x8e, 0x89]))
      expect(received.join('')).toBe('🎉')
      expect(received.join('').includes('\uFFFD')).toBe(false)

      received.length = 0

      // '🔥' is [0xF0, 0x9F, 0x94, 0xA5]
      // Split 3 bytes + 1 byte
      ch?.send(makeFrame(1, [0xf0, 0x9f, 0x94]))
      expect(received.length).toBe(0)
      ch?.send(makeFrame(1, [0xa5]))
      expect(received.join('')).toBe('🔥')
      expect(received.join('').includes('\uFFFD')).toBe(false)

      unsub()
    })

    it('stress tests arbitrary stream chunking of mixed UTF-8 / ANSI sequences', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const originalText =
        '\x1b[32m[Orca PTY]\x1b[0m 🚀 Multi-byte test: 日本語, Español (ñ, á), €49.99, symbols: ⚡🔥✨\r\n'
      const encodedBytes = new TextEncoder().encode(originalText)

      // Test multiple prime chunk sizes to force every possible split offset
      const chunkSizes = [1, 2, 3, 5, 7, 11, 13, 17]

      for (const size of chunkSizes) {
        const received: string[] = []
        const unsub = api.pty.onData((d) => received.push(d.data))

        const sId = `pty-stream-chunk-${size}`
        await api.pty.spawn({ cols: 80, rows: 24, sessionId: sId })
        const lastCall = vi.mocked(invoke).mock.calls.find((c) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked args.
          return (
            c[0] === 'pty_spawn' &&
            (c[1] as { descriptor?: { session_id?: string } })?.descriptor?.session_id === sId
          )
        })
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
        const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

        for (let offset = 0; offset < encodedBytes.length; offset += size) {
          const chunk = encodedBytes.subarray(offset, Math.min(offset + size, encodedBytes.length))
          ch?.send(makeFrame(1, chunk))
        }

        const reconstructed = received.join('')
        expect(reconstructed).toBe(originalText)
        expect(reconstructed.includes('\uFFFD')).toBe(false)
        unsub()
      }
    })

    it('isolates UTF-8 decoders across concurrent PTY sessions without cross-talk', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const received1: string[] = []
      const received2: string[] = []

      const unsub = api.pty.onData((d) => {
        if (d.id === 'session-1') {
          received1.push(d.data)
        }
        if (d.id === 'session-2') {
          received2.push(d.data)
        }
      })

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'session-1' })
      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'session-2' })

      const call1 = vi.mocked(invoke).mock.calls.find(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked args.
        (c) =>
          c[0] === 'pty_spawn' &&
          (c[1] as { descriptor?: { session_id?: string } })?.descriptor?.session_id === 'session-1'
      )
      const call2 = vi.mocked(invoke).mock.calls.find(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked args.
        (c) =>
          c[0] === 'pty_spawn' &&
          (c[1] as { descriptor?: { session_id?: string } })?.descriptor?.session_id === 'session-2'
      )

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch1 = (call1?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch2 = (call2?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // Session 1 receives first 2 bytes of '🚀' [0xF0, 0x9F]
      ch1?.send(makeFrame(1, [0xf0, 0x9f]))
      expect(received1.length).toBe(0)

      // Session 2 sends ASCII
      ch2?.send(makeFrame(1, new TextEncoder().encode('Hello 2')))
      expect(received2.join('')).toBe('Hello 2')

      // Session 1 completes '🚀' [0x9A, 0x80]
      ch1?.send(makeFrame(1, [0x9a, 0x80]))
      expect(received1.join('')).toBe('🚀')
      expect(received1.join('').includes('\uFFFD')).toBe(false)

      unsub()
    })
  })

  describe('2. 32-Bit Exit Code Precision & Robustness', () => {
    it('decodes boundary 32-bit exit codes: 0, 1, 255, 256, 65535, 0xC0000005, 0xFFFFFFFF', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedExit: { id: string; code: number }[] = []
      const unsub = api.pty.onExit((e) => receivedExit.push(e))

      const testCodes = [
        0,
        1,
        255,
        256, // 0x00000100 -> truncated would be 0
        65535, // 0x0000FFFF
        65536, // 0x00010000 -> truncated would be 0
        0xc0000005, // 3221225477 (NTSTATUS STATUS_ACCESS_VIOLATION) -> truncated would be 5
        0xc00000fd, // 3221225725 (NTSTATUS STATUS_STACK_OVERFLOW) -> truncated would be 253
        0xffffffff // 4294967295 (u32::MAX)
      ]

      for (let i = 0; i < testCodes.length; i++) {
        const code = testCodes[i]
        const sId = `pty-exit-${i}`
        await api.pty.spawn({ cols: 80, rows: 24, sessionId: sId })

        const lastCall = vi.mocked(invoke).mock.calls.find(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked args.
          (c) =>
            c[0] === 'pty_spawn' &&
            (c[1] as { descriptor?: { session_id?: string } })?.descriptor?.session_id === sId
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
        const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

        const exitPayload = new Uint8Array(4)
        const dv = new DataView(exitPayload.buffer)
        dv.setUint32(0, code, true)

        ch?.send(makeFrame(2, exitPayload))
        expect(receivedExit.at(-1)).toEqual({ id: sId, code })
      }

      unsub()
    })

    it('handles legacy single-byte (17 bytes) and empty (16 bytes) exit frames gracefully', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedExit: { id: string; code: number }[] = []
      const unsub = api.pty.onExit((e) => receivedExit.push(e))

      // 1. Single byte legacy exit code (17 bytes total: 16 header + 1 payload)
      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-exit-legacy' })
      const call1 = vi.mocked(invoke).mock.calls.find(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked args.
        (c) =>
          c[0] === 'pty_spawn' &&
          (c[1] as { descriptor?: { session_id?: string } })?.descriptor?.session_id ===
            'pty-exit-legacy'
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch1 = (call1?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event
      ch1?.send(makeFrame(2, [42]))
      expect(receivedExit.at(-1)).toEqual({ id: 'pty-exit-legacy', code: 42 })

      // 2. Empty exit frame (16 bytes total: 16 header + 0 payload)
      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-exit-empty' })
      const call2 = vi.mocked(invoke).mock.calls.find(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked args.
        (c) =>
          c[0] === 'pty_spawn' &&
          (c[1] as { descriptor?: { session_id?: string } })?.descriptor?.session_id ===
            'pty-exit-empty'
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch2 = (call2?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event
      ch2?.send(makeFrame(2, []))
      expect(receivedExit.at(-1)).toEqual({ id: 'pty-exit-empty', code: 0 })

      unsub()
    })

    it('correctly decodes exit code when frame is a subarray with non-zero byteOffset', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedExit: { id: string; code: number }[] = []
      const unsub = api.pty.onExit((e) => receivedExit.push(e))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-exit-offset' })
      const call = vi.mocked(invoke).mock.calls.find(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked args.
        (c) =>
          c[0] === 'pty_spawn' &&
          (c[1] as { descriptor?: { session_id?: string } })?.descriptor?.session_id ===
            'pty-exit-offset'
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (call?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // Create a larger buffer with prefix padding
      const bigBuffer = new Uint8Array(64)
      const offset = 8
      const frameSlice = bigBuffer.subarray(offset, offset + 20)
      frameSlice[0] = 0x74
      frameSlice[1] = 0x01
      frameSlice[2] = 2 // Opcode exit
      const dv = new DataView(frameSlice.buffer, frameSlice.byteOffset, frameSlice.byteLength)
      dv.setUint32(16, 0xc0000005, true)

      ch?.send(frameSlice)
      expect(receivedExit[0]).toEqual({ id: 'pty-exit-offset', code: 0xc0000005 })

      unsub()
    })

    it('correctly decodes exit code when frame is delivered as number[]', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedExit: { id: string; code: number }[] = []
      const unsub = api.pty.onExit((e) => receivedExit.push(e))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-exit-num-array' })
      const call = vi.mocked(invoke).mock.calls.find(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked args.
        (c) =>
          c[0] === 'pty_spawn' &&
          (c[1] as { descriptor?: { session_id?: string } })?.descriptor?.session_id ===
            'pty-exit-num-array'
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (call?.[1] as { on_event?: { send: (d: number[]) => void } })?.on_event

      const frameUint = makeFrame(2, [0x00, 0x01, 0x00, 0x00]) // code 256
      const numArray = Array.from(frameUint)

      ch?.send(numArray)
      expect(receivedExit[0]).toEqual({ id: 'pty-exit-num-array', code: 256 })

      unsub()
    })
  })

  describe('3. Malformed Frames Rejection & Robustness', () => {
    it('silently ignores truncated frames (< 16 bytes)', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedData: unknown[] = []
      const receivedExit: unknown[] = []
      const unsubData = api.pty.onData((d) => receivedData.push(d))
      const unsubExit = api.pty.onExit((e) => receivedExit.push(e))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-malformed-trunc' })
      const lastCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // 0 bytes
      ch?.send(new Uint8Array(0))
      // 1 byte
      ch?.send(new Uint8Array([0x74]))
      // 15 bytes
      const b15 = new Uint8Array(15)
      b15[0] = 0x74
      b15[1] = 0x01
      b15[2] = 0x01
      ch?.send(b15)

      expect(receivedData.length).toBe(0)
      expect(receivedExit.length).toBe(0)

      unsubData()
      unsubExit()
    })

    it('silently ignores frames with invalid magic kind byte (!= 0x74)', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedData: unknown[] = []
      const receivedExit: unknown[] = []
      const unsubData = api.pty.onData((d) => receivedData.push(d))
      const unsubExit = api.pty.onExit((e) => receivedExit.push(e))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-malformed-kind' })
      const lastCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // Invalid kinds: 0x00, 0x61 ('a'), 0xFF
      const f1 = makeFrame(1, [65], { kind: 0x00 })
      const f2 = makeFrame(1, [65], { kind: 0x61 })
      const f3 = makeFrame(2, [0, 0, 0, 0], { kind: 0xff })

      ch?.send(f1)
      ch?.send(f2)
      ch?.send(f3)

      expect(receivedData.length).toBe(0)
      expect(receivedExit.length).toBe(0)

      unsubData()
      unsubExit()
    })

    it('evaluates frame version validation behavior (version != 0x01)', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedData: unknown[] = []
      const receivedExit: unknown[] = []
      const unsubData = api.pty.onData((d) => receivedData.push(d))
      const unsubExit = api.pty.onExit((e) => receivedExit.push(e))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-malformed-ver' })
      const lastCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // Frame with kind 0x74, but invalid version 0x02 or 0xFF
      const fBadVer1 = makeFrame(1, [65], { version: 0x02 })
      const fBadVer2 = makeFrame(2, [0, 1, 0, 0], { version: 0xff })

      ch?.send(fBadVer1)
      ch?.send(fBadVer2)

      expect(receivedData.length).toBe(0)
      expect(receivedExit.length).toBe(0)

      unsubData()
      unsubExit()
    })

    it('silently ignores frames with unknown opcodes', async () => {
      const api = createTauriPreloadApi()
      const { invoke } = await import('@tauri-apps/api/core')

      const receivedData: unknown[] = []
      const receivedExit: unknown[] = []
      const unsubData = api.pty.onData((d) => receivedData.push(d))
      const unsubExit = api.pty.onExit((e) => receivedExit.push(e))

      await api.pty.spawn({ cols: 80, rows: 24, sessionId: 'pty-unknown-opcode' })
      const lastCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'pty_spawn')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect mocked channel.
      const ch = (lastCall?.[1] as { on_event?: { send: (d: Uint8Array) => void } })?.on_event

      // Unknown opcodes: 0, 3, 99, 255
      ch?.send(makeFrame(0, [65]))
      ch?.send(makeFrame(3, [65]))
      ch?.send(makeFrame(99, [65]))
      ch?.send(makeFrame(255, [65]))

      expect(receivedData.length).toBe(0)
      expect(receivedExit.length).toBe(0)

      unsubData()
      unsubExit()
    })
  })
})
