# Flota de Agentes: Migración de Orca a Rust

Esta carpeta define la flota de agentes especializados para ejecutar la migración del backbone de ejecución de Orca (`orcad` y `orca-cli`) a Rust, preservando compatibilidad 100% drop-in por protocolo con Electron.

## Composición de la Flota

| Agente | Archivo | Rol y Responsabilidad Principal |
|---|---|---|
| **Coordinador de Migración** | [`migration-coordinator.md`](./migration-coordinator.md) | Orquestación general, gestión del workspace Cargo, trazabilidad con el plan y gates de calidad. |
| **Ingeniero de Protocolo** | [`protocol-engineer.md`](./protocol-engineer.md) | Crate `orca-protocol`: Serialización serde, envelopes JSON-RPC y framing binario de 16 bytes con zero-copy. |
| **Ingeniero de Sistemas PTY** | [`pty-systems-engineer.md`](./pty-systems-engineer.md) | Crate `orca-pty`: ConPTY en Windows con Job Objects (sin `BREAKAWAY_OK`), POSIX PTYs y limpieza atómica de huérfanos. |
| **Arquitecto de Daemon** | [`daemon-architect.md`](./daemon-architect.md) | Crate `orcad`: Runtime Tokio, servidores Named Pipe / Unix Socket / WebSocket, Agent Status Store y idle exit. |
| **Ingeniero de CLI** | [`cli-engineer.md`](./cli-engineer.md) | Crate `orca-cli`: CLI nativo con `clap`, arranque <5ms, salida tabular/JSON y conexión IPC a `orcad`. |
| **Verificador de Calidad y QA** | [`qa-verifier.md`](./qa-verifier.md) | Pruebas de contrato, smoke tests (`smoke:orcad-terminal`), benchmarks de RAM/CPU y prevención de regresiones. |

## Reglas Globales de la Flota

1. **Invariante de Job Objects en Windows:** Ningún Job Object de PTY debe crearse con `JOB_OBJECT_LIMIT_BREAKAWAY_OK`. Los procesos hijos de Git Bash / MSYS2 no deben escapar jamás del árbol de procesos.
2. **Autoridad Única del Estado de Agentes:** El host de ejecución (`orcad`) es el único dueño de la verdad del estado de los agentes (`live`, `unverifiable`, `exited`).
3. **Compatibilidad Wire-Level:** Los envelopes JSON-RPC y los frames binarios de 16 bytes deben coincidir bit a bit con los contratos TypeScript existentes en `src/shared/`.
4. **Desarrollo Guiado por Pruebas (TDD):** Todo componente se construye escribiendo primero el test que falla, verificando la falla, implementando el código mínimo y pasando el test.
