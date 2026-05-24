//! Bridge between WASM plugins and the Channel trait.

use async_trait::async_trait;
use zeroclaw_api::channel::{Channel, ChannelMessage, SendMessage};

/// A channel backed by a WASM plugin.
pub struct WasmChannel {
    name: String,
    plugin_name: String,
}

impl WasmChannel {
    pub fn new(name: String, plugin_name: String) -> Self {
        Self { name, plugin_name }
    }
}

#[async_trait]
impl Channel for WasmChannel {
    fn name(&self) -> &str {
        &self.name
    }

    async fn send(&self, message: &SendMessage) -> anyhow::Result<()> {
        // Previously returned Ok(()) after a warn-log — plugin-backed
        // channels appeared operational while silently dropping every
        // outbound message. Return a hard error so plugin-channel
        // integrations FAIL LOUDLY until a real WASM bridge lands —
        // matches WasmTool::execute which already returns success=false
        // with an explicit unimplemented marker.
        anyhow::bail!(
            "WasmChannel '{}' (plugin: {}) send is not implemented. Message dropped: {}",
            self.name,
            self.plugin_name,
            message.content
        )
    }

    async fn listen(&self, _tx: tokio::sync::mpsc::Sender<ChannelMessage>) -> anyhow::Result<()> {
        // Previously returned Ok(()) — listen() appeared to succeed but
        // never bound the WASM receive callback, so no inbound message
        // would ever flow through. Return a hard error so callers see
        // the missing runtime instead of waiting indefinitely on an
        // empty channel.
        anyhow::bail!(
            "WasmChannel '{}' (plugin: {}) listen is not implemented; channel will not receive messages",
            self.name,
            self.plugin_name,
        )
    }
}
