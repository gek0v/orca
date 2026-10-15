# Forensic Investigation Report: Milestone 2 Remediation (WriteSettlement Contract & Assertions)

**Investigator**: explorer_m2_fix_1  
**Working Directory**: `C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_m2_fix_1`  
**Workspace Root**: `C:\Users\Geko\orca\workspaces\orca-upstream\main`  
**Target Milestone**: Milestone 2 (Electron IPC & Packaging Integration)  
**Status**: Read-only Investigation Complete

---

## 1. Observation

### Observation 1: Definition of the Canonical `WriteSettlement` Contract

**File**: `src/shared/pty-write-settlement.ts`, lines 10-53

```ts
export type WriteRefusalReason =
  | 'transport_disposed'
  | 'transport_queue_full'
  | 'transport_rejected_before_handoff'
  | 'payload_exceeds_transport_limit'
  | 'endpoint_disconnected'
  | 'endpoint_awaiting_recovery'
  | 'encode_failed'
  | 'provider_unavailable'
  | 'provider_refused_write'
  | 'provider_cannot_settle'

export type WriteAmbiguityReason =
  | 'transport_settlement_lost'
  | 'settlement_timeout'
  | 'endpoint_write_threw'
  | 'provider_threw_after_handoff'
  | 'partial_write'

export type WriteSettlement =
  | Readonly<{ outcome: 'accepted' }>
  | Readonly<{ outcome: 'refused'; reason: WriteRefusalReason }>
  | Readonly<{
      outcome: 'unverifiable'
      reason: WriteAmbiguityReason
      bytesHandedToTransport: boolean
    }>

export const WRITE_ACCEPTED: WriteSettlement = Object.freeze({ outcome: 'accepted' })

export function writeRefused(reason: WriteRefusalReason): WriteSettlement {
  return Object.freeze({ outcome: 'refused', reason })
}
```

**Direct Observation**:

1. `WriteSettlement` is a discriminated union of 3 frozen variants (`outcome: 'accepted'`, `outcome: 'refused'`, `outcome: 'unverifiable'`).
2. The `outcome: 'refused'` branch contains solely `reason: WriteRefusalReason`.
3. There is **no** `error` property on `WriteSettlement` or on the `refused` variant.
4. The module provides a canonical helper factory `writeRefused(reason: WriteRefusalReason): WriteSettlement` which freezes and returns the variant.

---

### Observation 2: Ad-Hoc Object Construction in `OrcadNativePtyProvider`

**File**: `src/main/providers/orcad-native-pty-provider.ts`, lines 1-3, 149-158

```ts
1: import { randomUUID } from 'node:crypto'
2: import { WRITE_ACCEPTED, type WriteSettlement } from '../../shared/pty-write-settlement'
...
149:   writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
150:     return this.client
151:       .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
152:       .then(() => WRITE_ACCEPTED)
153:       .catch((err: Error) => ({
154:         outcome: 'refused',
155:         reason: 'transport_rejected_before_handoff',
156:         error: err
157:       }))
158:   }
```

**Direct Observation**:

1. Line 2 imports only `WRITE_ACCEPTED` and type `WriteSettlement`. It does not import `writeRefused`.
2. Lines 153-157 instantiate an ad-hoc object `{ outcome: 'refused', reason: 'transport_rejected_before_handoff', error: err }`.
3. The returned object attaches an undeclared property `error: err`, which leaks a non-serializable runtime `Error` instance across the provider boundary and violates the `WriteSettlement` interface contract.
4. The returned object is not frozen, unlike canonical settlements produced by `WRITE_ACCEPTED` or `writeRefused`.

---

### Observation 3: Invalidation Origin in `orcad-native-pty-provider.test.ts`

**File**: `src/main/providers/orcad-native-pty-provider.test.ts`
In the forensic audit report (`teamwork_preview_auditor_m2_1/handoff.md`, Observation 1 & 3), the compiler failure was:

```text
src/main/providers/orcad-native-pty-provider.test.ts(223,25): error TS2339: Property 'error' does not exist on type 'Readonly<{ outcome: "refused"; reason: WriteRefusalReason; }>'.
src/main/providers/orcad-native-pty-provider.test.ts(369,25): error TS2339: Property 'error' does not exist on type 'Readonly<{ outcome: "refused"; reason: WriteRefusalReason; }>'.
```

Examining the historical test code:

```ts
221:     if (settlement.outcome === 'refused') {
222:       expect(settlement.reason).toBe('transport_rejected_before_handoff')
223:       expect(settlement.error.message).toContain('Terminal not found')
224:     }
...
367:     if (settlement.outcome === 'refused') {
368:       expect(settlement.reason).toBe('transport_rejected_before_handoff')
369:       expect(settlement.error).toBeDefined()
370:     }
```

Current state of `src/main/providers/orcad-native-pty-provider.test.ts`:

- Lines 220-224:

```ts
220:     expect(settlement.outcome).toBe('refused')
221:     if (settlement.outcome === 'refused') {
222:       expect(settlement.reason).toBe('transport_rejected_before_handoff')
223:     }
```

- Lines 365-369:

```ts
365:     expect(settlement.outcome).toBe('refused')
366:     if (settlement.outcome === 'refused') {
367:       expect(settlement.reason).toBe('transport_rejected_before_handoff')
368:     }
```

**Direct Observation**:

1. While `expect(settlement.error...)` lines were subsequently removed from the test file (allowing `tsc` to pass in isolation), `src/main/providers/orcad-native-pty-provider.ts` STILL returns `{ outcome: 'refused', reason: 'transport_rejected_before_handoff', error: err }` at runtime.
2. The unit test currently only tests `settlement.outcome` and `settlement.reason` via an `if` guard; it does not test exact object equality against canonical `writeRefused(...)`.
3. If the test asserts `expect(settlement).toEqual(writeRefused('transport_rejected_before_handoff'))`, it currently fails because the runtime object contains the undeclared property `error: [Error: ...]`.
4. The test also lacks verification of the success arm `WRITE_ACCEPTED` on an active session.

---

### Observation 4: Usage Pattern Across the Orca Codebase

Searching the repository for `writeRefused` reveals that all other providers and consumers use `writeRefused(reason)` or `{ outcome: 'refused', reason }`:

- `src/main/providers/local-pty-provider.ts`:
  ```ts
  writeWithSettlement(id: string, data: string): WriteSettlement {
    return writeLocalPty(id, data) ? WRITE_ACCEPTED : writeRefused('provider_refused_write')
  }
  ```
- `src/main/daemon/daemon-pty-session-input.ts`:
  ```ts
  return writeRefused('endpoint_awaiting_recovery')
  ```
- `src/main/ssh/ssh-multiplexer-transport-writer.ts`:
  ```ts
  return writeRefused(result.reason)
  ```
- `src/main/daemon/client.ts`:
  ```ts
  return writeRefused('endpoint_disconnected')
  ```

None of these attach an `error` property or deviate from the canonical ADT.

---

## 2. Logic Chain

1. **Contract Invariant**: Per `src/shared/pty-write-settlement.ts`, `WriteSettlement` is an immutable 3-state ADT representing settlement semantics. `reason` is an enumerated string literal (`WriteRefusalReason`), intentionally omitting any generic `Error` object to maintain cross-boundary wire and serialization integrity.
2. **Defect in Provider**: In `src/main/providers/orcad-native-pty-provider.ts` lines 153-157, returning `{ outcome: 'refused', reason: 'transport_rejected_before_handoff', error: err }` breaks contract conformance and violates the facade rule flagged by the Forensic Auditor.
3. **Defect in Test Assertions**: In `src/main/providers/orcad-native-pty-provider.test.ts`, the original assertions attempted to dereference `settlement.error.message`. Because `WriteSettlement` narrows to `Readonly<{ outcome: 'refused'; reason: WriteRefusalReason }>`, TypeScript strict property checking flagged `TS2339`.
4. **Remediation Strategy**:
   - In `orcad-native-pty-provider.ts`: Import and call `writeRefused('transport_rejected_before_handoff')` in `.catch()`. This produces an immutable, frozen, strictly compliant `WriteSettlement` object without any extraneous `error` field.
   - In `orcad-native-pty-provider.test.ts`: Import `writeRefused` and `WRITE_ACCEPTED`. Assert `expect(settlement).toEqual(writeRefused('transport_rejected_before_handoff'))` and `expect(acceptedSettlement).toEqual(WRITE_ACCEPTED)`. This guarantees deep structural equality, rejects any illegal extra fields, avoids fragile `if (settlement.outcome === ...)` branches, and complies 100% with TypeScript without casts or suppressions.

---

## 3. Caveats

- **Scope Boundary**: This investigation focuses strictly on `WriteSettlement` contract compliance in `orcad-native-pty-provider.ts` and unit test assertions in `orcad-native-pty-provider.test.ts`. Integration test timeout handling (`orcad-native-pty-provider.integration.test.ts`) is covered in parallel by `explorer_m2_fix_2`.
- **Read-Only Invariant**: As an explorer subagent, no source or test files outside `.agents/teamwork/` were edited during this investigation. All proposed changes are documented below as exact code patches for the implementation worker.

---

## 4. Conclusion & Actionable Fix Strategy

### Recommendation 1: Remediate `src/main/providers/orcad-native-pty-provider.ts`

#### Diff Patch Proposal:

```diff
--- a/src/main/providers/orcad-native-pty-provider.ts
+++ b/src/main/providers/orcad-native-pty-provider.ts
@@ -2,1 +2,1 @@
-import { WRITE_ACCEPTED, type WriteSettlement } from '../../shared/pty-write-settlement'
+import { WRITE_ACCEPTED, writeRefused, type WriteSettlement } from '../../shared/pty-write-settlement'
@@ -149,10 +149,6 @@
   writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
     return this.client
       .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
       .then(() => WRITE_ACCEPTED)
-      .catch((err: Error) => ({
-        outcome: 'refused',
-        reason: 'transport_rejected_before_handoff',
-        error: err
-      }))
+      .catch(() => writeRefused('transport_rejected_before_handoff'))
   }
```

#### Detailed Replacement Snippets:

**Line 2**:

```ts
// BEFORE:
import { WRITE_ACCEPTED, type WriteSettlement } from '../../shared/pty-write-settlement'

// AFTER:
import {
  WRITE_ACCEPTED,
  writeRefused,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
```

**Lines 149-158**:

```ts
// BEFORE:
  writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    return this.client
      .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
      .then(() => WRITE_ACCEPTED)
      .catch((err: Error) => ({
        outcome: 'refused',
        reason: 'transport_rejected_before_handoff',
        error: err
      }))
  }

// AFTER:
  writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    return this.client
      .callRpc('pty.write', { id: String(id), terminalId: String(id), data })
      .then(() => WRITE_ACCEPTED)
      .catch(() => writeRefused('transport_rejected_before_handoff'))
  }
```

---

### Recommendation 2: Remediate `src/main/providers/orcad-native-pty-provider.test.ts`

#### Detailed Replacement Snippets:

**Lines 1-5 (Imports)**:

```ts
// BEFORE:
import * as net from 'node:net'
import * as readline from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcadNativePtyProvider } from './orcad-native-pty-provider'

// AFTER:
import * as net from 'node:net'
import * as readline from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WRITE_ACCEPTED, writeRefused } from '../../shared/pty-write-settlement'
import { OrcadNativePtyProvider } from './orcad-native-pty-provider'
```

**Lines 214-224 (Active & Dead writeWithSettlement assertions)**:

```ts
// BEFORE:
// Write after shutdown - fire and forget should not throw
const writeResult = provider.write('1', 'echo after shutdown\r\n')
expect(writeResult).toBe(true)

// WriteWithSettlement for unknown/dead session where daemon returns error
const settlement = await provider.writeWithSettlement('dead', 'echo after shutdown\r\n')
expect(settlement.outcome).toBe('refused')
if (settlement.outcome === 'refused') {
  expect(settlement.reason).toBe('transport_rejected_before_handoff')
}

// AFTER:
// Write before shutdown - writeWithSettlement on healthy active session settles accepted
const acceptedSettlement = await provider.writeWithSettlement('1', 'echo active\r\n')
expect(acceptedSettlement).toEqual(WRITE_ACCEPTED)

// Write after shutdown - fire and forget should not throw
const writeResult = provider.write('1', 'echo after shutdown\r\n')
expect(writeResult).toBe(true)

// WriteWithSettlement for unknown/dead session where daemon returns error
const settlement = await provider.writeWithSettlement('dead', 'echo after shutdown\r\n')
expect(settlement).toEqual(writeRefused('transport_rejected_before_handoff'))
```

**Lines 364-369 (Disposed / Unreachable endpoint provider)**:

```ts
// BEFORE:
const settlement = await deadProvider.writeWithSettlement('1', 'echo')
expect(settlement.outcome).toBe('refused')
if (settlement.outcome === 'refused') {
  expect(settlement.reason).toBe('transport_rejected_before_handoff')
}

// AFTER:
const settlement = await deadProvider.writeWithSettlement('1', 'echo')
expect(settlement).toEqual(writeRefused('transport_rejected_before_handoff'))
```

---

## 5. Verification Method

Once the implementation worker applies the above changes, the following verification commands must be executed:

```powershell
# 1. Verify TypeScript compiles with 0 errors across all projects
pnpm tc

# 2. Specifically verify node TypeScript config
pnpm run typecheck:node

# 3. Verify the unit test suite passes cleanly with exact contract matching
pnpm test src/main/providers/orcad-native-pty-provider.test.ts

# 4. Verify code quality & linter rules (0 warnings, 0 errors)
npx oxlint src/main/providers/orcad-native-pty-provider.ts src/main/providers/orcad-native-pty-provider.test.ts
pnpm run check:code-quality:changed

# 5. Verify goal validation passes
node out/cli/index.js goal validate
```

### Invalidation Conditions:

1. Any occurrence of `error TS2339` or any type error during `pnpm tc`.
2. Any test failure in `orcad-native-pty-provider.test.ts` (e.g. if an ad-hoc object with `error` is still returned, `toEqual(writeRefused(...))` will fail).
3. Any linter error or rule violation from `oxlint`.
