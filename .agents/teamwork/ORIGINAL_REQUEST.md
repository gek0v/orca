# Original User Request

## 2026-10-12T17:07:11Z

Integrar el daemon nativo de Orca migrado a Rust (orcad, orca-pty, orca-protocol) del worktree MIgration en la versión actual de main (manteniendo Electron como shell de escritorio), delegando la ejecución y streaming de terminales al daemon en Rust para eliminar los bloqueos continuos ("Orca no responde") y la alta latencia en Windows.

Working directory: C:\Users\Geko\orca\workspaces\orca-upstream\main
Integrity mode: development

## Active Orca Goal Tracking

Existe un objetivo activo registrado en el workspace (.orca/goals.json y .orca/CURRENT_GOAL.md):

- ID: goal-1791824736032
- A medida que se completen las subtareas, se debe ejecutar `node out/cli/index.js goal complete <id-o-índice>` para mantener actualizado el estado del objetivo.
- Para validar: `node out/cli/index.js goal validate`.

## Requirements

### R1. Integración y compilación de crates Rust

Incorporar los crates crates/orcad, crates/orca-pty, crates/orca-protocol y sus configuraciones asociadas de Cargo.toml/Cargo.lock desde el worktree MIgration (C:/Users/Geko/orca/workspaces/orca-upstream/MIgration) a main. Todos los crates deben compilar limpiamente en Windows mediante cargo build --release.

### R2. Enlace IPC y gestión de terminales con Electron

Configurar la capa de Electron en main para lanzar y supervisar el daemon nativo orcad (comunicándose mediante named pipe en Windows, e.g. \\.\pipe\orcad, o socket IPC). La creación, interacción y streaming de PTYs deben delegarse a orcad a través de ConPTY nativo, desacoplando el tráfico de terminales del bucle de eventos principal de Node/Electron.

### R3. Rendimiento y reactividad de la interfaz

Asegurar que la interacción continua con la terminal (apertura, comandos interactivos, streaming masivo de texto) no bloquee el hilo principal de la UI ni provoque el estado de cuelgue "Orca (No responde)" en el administrador de tareas de Windows.

### R4. Empaquetado y soporte en scripts de build

Actualizar los scripts de build y empaquetado (config/electron-builder.config.cjs, package.json) para que el binario de orcad se compile e incluya automáticamente dentro de los recursos de distribución en build:win.

## Acceptance Criteria

### Compilación y verificación de Rust

- [ ] cargo check --workspace y cargo test -p orcad -p orca-pty completan sin errores en Windows.
- [ ] El ejecutable orcad.exe se genera correctamente en modo release.

### Integración en el runtime de Electron

- [ ] Al iniciar la aplicación o abrir una terminal, el daemon orcad arranca y gestiona las sesiones de terminal mediante ConPTY.
- [ ] Las terminales abren sin demoras perceptibles y sin congelar la ventana de Electron.
- [ ] pnpm tc pasa sin errores de tipado en TypeScript.

### Empaquetado

- [ ] Los scripts de empaquetado para Windows reconocen e incluyen el binario compilado de orcad en el árbol de recursos de la aplicación.

## 2026-10-12T17:54:03Z

El usuario ha solicitado pausar el trabajo ("Pausa"). Por favor, pon en pausa la ejecución, no despaches nuevos subagentes o tareas, y reporta el estado exacto en el que queda el espacio de trabajo y los hitos.

## 2026-10-12T17:58:34Z

Reanudar y completar el proyecto de integración del daemon nativo en Rust (orcad, orca-pty, orca-protocol) en main, continuando desde el Hito 2 según lo documentado en PROJECT.md y la meta activa en Orca.

Working directory: C:\Users\Geko\orca\workspaces\orca-upstream\main
Integrity mode: development
Active Orca Goal: goal-1791824736032 (.orca/goals.json y .orca/CURRENT_GOAL.md)

## Estado actual del proyecto (ver PROJECT.md)

- M1 (Rust Native Subsystem): COMPLETADO y aprobado (crates portados, 109 tests pasando, orcad compilando, subtareas 1 y 2 completadas).
- M2 (Electron IPC & Packaging): CÓDIGO IMPLEMENTADO en el árbol de trabajo (orcad-native-pty-client.ts, orcad-native-pty-provider.ts, orcad-pty-spawn-plan.ts, daemon-provider-init.ts, packaged-native-binaries.cjs, electron-builder.config.cjs).
  -> Tareas inmediatas para M2:
  1.  Ejecutar y verificar tests unitarios y de integración de M2 (`pnpm test src/main/providers/orcad-native-pty-provider.test.ts`, tests de daemon-provider-init, test de electron-builder).
  2.  Ejecutar `pnpm tc` para asegurar 0 errores de TypeScript.
  3.  Pasar revisión/auditoría de Milestone 2 y marcar las subtareas 3 y 4 de la meta (`node out/cli/index.js goal complete 3` y `node out/cli/index.js goal complete 4`).
- M3 (Validación E2E, Reactividad y Validación Final):
  1.  Validar que la interfaz no se congela ("Orca no responde") bajo carga de terminales.
  2.  Validar suites de tests relevantes y marcar la subtarea 5 (`node out/cli/index.js goal complete 5`).
  3.  Ejecutar `node out/cli/index.js goal validate` para certificar la meta activa.

Llevar a cabo la orquestación, verificación y cierre del proyecto con el equipo multi-agente hasta completarlo al 100%.
