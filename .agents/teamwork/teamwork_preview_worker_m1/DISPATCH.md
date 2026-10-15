## 2026-10-12T17:22:37Z

You are worker_m1.
Your working directory: C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m1
Project root directory: C:\Users\Geko\orca\workspaces\orca-upstream\main

Mandatory reading:

1. C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\ORIGINAL_REQUEST.md
2. C:\Users\Geko\orca\workspaces\orca-upstream\main\PROJECT.md
3. C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_1\survey_rust.md
4. C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_explorer_survey_1\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Task — Milestone 1: Rust Native Subsystem Integration

1. Source tree porting from MIgration (C:\Users\Geko\orca\workspaces\orca-upstream\MIgration) to main (C:\Users\Geko\orca\workspaces\orca-upstream\main):
   - Copy rust-toolchain.toml and Cargo.lock from MIgration to main.
   - Copy directory crates/orca-protocol from MIgration/crates/orca-protocol to main/crates/orca-protocol.
   - Copy directory crates/orca-pty from MIgration/crates/orca-pty to main/crates/orca-pty.
   - Copy directory crates/orcad from MIgration/crates/orcad to main/crates/orcad.
   - Create root Cargo.toml in main with:
     ```toml
     [workspace]
     members = [
         "crates/orca-protocol",
         "crates/orca-pty",
         "crates/orcad",
     ]
     resolver = "2"
     ```
     (Note: Do NOT include orca-desktop or orca-cli in Cargo.toml workspace members).
   - Ensure /target/ is added to .gitignore in main.
2. Build and Test Verification:
   - Run `cargo check --workspace` in main and verify it completes with exit code 0.
   - Run `cargo test -p orcad -p orca-pty -p orca-protocol` in main and verify all tests pass with exit code 0.
   - Run `cargo build --release -p orcad` in main and verify target\release\orcad.exe is generated.
3. Goal Progress Update:
   - Run `node out/cli/index.js goal complete 1`
   - Run `node out/cli/index.js goal complete 2`
   - Verify with `node out/cli/index.js goal status`
4. File write ownership:
   You own Cargo.toml, Cargo.lock, rust-toolchain.toml, .gitignore, and anything under crates/orca-protocol/, crates/orca-pty/, crates/orcad/. Do not touch Electron/TypeScript files in this milestone.
5. Deliverables:
   - Write comprehensive report to C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m1\changes.md
   - Write structured handoff report to C:\Users\Geko\orca\workspaces\orca-upstream\main\.agents\teamwork\teamwork_preview_worker_m1\handoff.md
   - Send completion message back to orchestrator_1 (conversation ID: f6a3f2e3-2858-4e06-a899-3b302da57ca2).
