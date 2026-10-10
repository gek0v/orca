# Flota de Agentes: Migración de Orca a Rust

Esta carpeta define la flota de agentes especializados para ejecutar la migración del backbone de ejecución de Orca (`orcad` y `orca-cli`) a Rust, preservando compatibilidad 100% drop-in por protocolo con Electron.

## Estructura de Agentes

Cada agente está definido en su propio directorio siguiendo el formato `.agents/agents/{agent_name}/agent.md`:

```
.agents/
└── agents/
    ├── migration-coordinator/
    │   └── agent.md
    ├── protocol-engineer/
    │   └── agent.md
    ├── pty-systems-engineer/
    │   └── agent.md
    ├── daemon-architect/
    │   └── agent.md
    ├── cli-engineer/
    │   └── agent.md
    └── qa-verifier/
        └── agent.md
```

## Directorio de la Flota

| Agente | Ruta de Definición | Rol y Responsabilidad Principal |
|---|---|---|
| **Coordinador de Migración** | [`agents/migration-coordinator/agent.md`](./agents/migration-coordinator/agent.md) | Orquestación general, gestión del workspace Cargo, trazabilidad con el plan y gates de calidad. |
| **Ingeniero de Protocolo** | [`agents/protocol-engineer/agent.md`](./agents/protocol-engineer/agent.md) | Crate `orca-protocol`: Serialización serde, envelopes JSON-RPC y framing binario de 16 bytes con zero-copy. |
| **Ingeniero de Sistemas PTY** | [`agents/pty-systems-engineer/agent.md`](./agents/pty-systems-engineer/agent.md) | Crate `orca-pty`: ConPTY en Windows con Job Objects (sin `BREAKAWAY_OK`), POSIX PTYs y limpieza atómica de huérfanos. |
| **Arquitecto de Daemon** | [`agents/daemon-architect/agent.md`](./agents/daemon-architect/agent.md) | Crate `orcad`: Runtime Tokio, servidores Named Pipe / Unix Socket / WebSocket, Agent Status Store y idle exit. |
| **Ingeniero de CLI** | [`agents/cli-engineer/agent.md`](./agents/cli-engineer/agent.md) | Crate `orca-cli`: CLI nativo con `clap`, arranque <5ms, salida tabular/JSON y conexión IPC a `orcad`. |
| **Verificador de Calidad y QA** | [`agents/qa-verifier/agent.md`](./agents/qa-verifier/agent.md) | Pruebas de contrato, smoke tests (`smoke:orcad-terminal`), benchmarks de RAM/CPU y prevención de regresiones. |
