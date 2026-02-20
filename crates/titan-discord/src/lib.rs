use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::Deserialize;

const DISCORD_API_BASE: &str = "https://discord.com/api/v10";

#[derive(Debug, Clone)]
pub struct DiscordGateway {
    client: Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiscordBotIdentity {
    pub id: String,
    pub username: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiscordMessageRef {
    pub id: String,
    pub channel_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiscordInboundMessage {
    pub id: String,
    pub channel_id: String,
    pub content: String,
    pub author: DiscordMessageAuthor,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiscordMessageAuthor {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub bot: bool,
}

impl DiscordGateway {
    pub fn new(token: &str, timeout_ms: u64) -> Result<Self> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            bail!("discord token is empty");
        }

        // Use the bot token via Authorization header and a bounded timeout so
        // gateway checks fail quickly when credentials/network are invalid.
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bot {trimmed}"))
                .with_context(|| "failed to build discord authorization header")?,
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let client = Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .default_headers(headers)
            .build()
            .with_context(|| "failed to build discord HTTP client")?;

        Ok(Self { client })
    }

    pub fn healthcheck(&self) -> Result<DiscordBotIdentity> {
        let response = self
            .client
            .get(format!("{DISCORD_API_BASE}/users/@me"))
            .send()
            .with_context(|| "failed to call discord users/@me")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            bail!("discord healthcheck failed: {} {}", status.as_u16(), body);
        }
        let identity = response
            .json::<DiscordBotIdentity>()
            .with_context(|| "failed to parse discord identity")?;
        Ok(identity)
    }

    pub fn send_message(&self, channel_id: &str, content: &str) -> Result<DiscordMessageRef> {
        let channel_id = channel_id.trim();
        if channel_id.is_empty() {
            bail!("channel_id is required");
        }
        if content.trim().is_empty() {
            bail!("content is required");
        }

        let response = self
            .client
            .post(format!("{DISCORD_API_BASE}/channels/{channel_id}/messages"))
            .json(&serde_json::json!({
                "content": content,
                "allowed_mentions": { "parse": [] }
            }))
            .send()
            .with_context(|| "failed to send discord message")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            bail!("discord send failed: {} {}", status.as_u16(), body);
        }

        let message = response
            .json::<DiscordMessageRef>()
            .with_context(|| "failed to parse discord message response")?;
        Ok(message)
    }

    pub fn list_recent_messages(
        &self,
        channel_id: &str,
        after_message_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<DiscordInboundMessage>> {
        let channel_id = channel_id.trim();
        if channel_id.is_empty() {
            bail!("channel_id is required");
        }
        let bounded_limit = limit.clamp(1, 100);
        let mut request = self
            .client
            .get(format!("{DISCORD_API_BASE}/channels/{channel_id}/messages"));
        let limit_string = bounded_limit.to_string();
        request = request.query(&[("limit", limit_string)]);
        if let Some(after) = after_message_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request = request.query(&[("after", after.to_string())]);
        }
        let response = request
            .send()
            .with_context(|| "failed to fetch discord channel messages")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            bail!("discord list messages failed: {} {}", status.as_u16(), body);
        }
        let mut messages = response
            .json::<Vec<DiscordInboundMessage>>()
            .with_context(|| "failed to parse discord messages response")?;
        messages.sort_by_key(|msg| msg.id.parse::<u64>().unwrap_or_default());
        Ok(messages)
    }
}
