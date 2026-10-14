//! RPC client and message envelopes for communication with orcad daemon.

pub mod client;
pub mod envelope;

pub use client::{OrcadClient, OrcadClientError};
pub use envelope::{RpcErrorPayload, RpcMeta, RpcRequest, RpcResponse};
