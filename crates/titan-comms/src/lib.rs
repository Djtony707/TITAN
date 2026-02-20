use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::Deserialize;
use serde::Serialize;
use titan_discord::DiscordGateway;

#[derive(Debug, Deserialize)]
struct OkEnvelope {
    ok: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    WhatsApp,
    Telegram,
    Discord,
    Irc,
    Slack,
    Feishu,
    GoogleChat,
    Mattermost,
    Signal,
    BlueBubbles,
    IMessage,
    MsTeams,
    Line,
    NextcloudTalk,
    Matrix,
    Nostr,
    Tlon,
    Twitch,
    Zalo,
    ZaloUser,
    WebChat,
}

impl ChannelKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::WhatsApp => "whatsapp",
            Self::Telegram => "telegram",
            Self::Discord => "discord",
            Self::Irc => "irc",
            Self::Slack => "slack",
            Self::Feishu => "feishu",
            Self::GoogleChat => "googlechat",
            Self::Mattermost => "mattermost",
            Self::Signal => "signal",
            Self::BlueBubbles => "bluebubbles",
            Self::IMessage => "imessage",
            Self::MsTeams => "msteams",
            Self::Line => "line",
            Self::NextcloudTalk => "nextcloud-talk",
            Self::Matrix => "matrix",
            Self::Nostr => "nostr",
            Self::Tlon => "tlon",
            Self::Twitch => "twitch",
            Self::Zalo => "zalo",
            Self::ZaloUser => "zalouser",
            Self::WebChat => "webchat",
        }
    }

    pub fn all() -> &'static [ChannelKind] {
        &[
            Self::WhatsApp,
            Self::Telegram,
            Self::Discord,
            Self::Irc,
            Self::Slack,
            Self::Feishu,
            Self::GoogleChat,
            Self::Mattermost,
            Self::Signal,
            Self::BlueBubbles,
            Self::IMessage,
            Self::MsTeams,
            Self::Line,
            Self::NextcloudTalk,
            Self::Matrix,
            Self::Nostr,
            Self::Tlon,
            Self::Twitch,
            Self::Zalo,
            Self::ZaloUser,
            Self::WebChat,
        ]
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "whatsapp" => Some(Self::WhatsApp),
            "telegram" => Some(Self::Telegram),
            "discord" => Some(Self::Discord),
            "irc" => Some(Self::Irc),
            "slack" => Some(Self::Slack),
            "feishu" => Some(Self::Feishu),
            "googlechat" | "google-chat" => Some(Self::GoogleChat),
            "mattermost" => Some(Self::Mattermost),
            "signal" => Some(Self::Signal),
            "bluebubbles" => Some(Self::BlueBubbles),
            "imessage" => Some(Self::IMessage),
            "msteams" | "teams" => Some(Self::MsTeams),
            "line" => Some(Self::Line),
            "nextcloud-talk" | "nextcloud" => Some(Self::NextcloudTalk),
            "matrix" => Some(Self::Matrix),
            "nostr" => Some(Self::Nostr),
            "tlon" => Some(Self::Tlon),
            "twitch" => Some(Self::Twitch),
            "zalo" => Some(Self::Zalo),
            "zalouser" | "zalo-personal" => Some(Self::ZaloUser),
            "webchat" => Some(Self::WebChat),
            _ => None,
        }
    }

    fn bridge_env_key(&self) -> String {
        format!(
            "TITAN_{}_BRIDGE_URL",
            self.as_str().replace('-', "_").to_uppercase()
        )
    }
}

#[derive(Debug, Clone)]
pub struct CommStatus {
    pub channel: String,
    pub configured: bool,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct CommSendResult {
    pub channel: String,
    pub status: String,
    pub detail: String,
}

fn status_ok(channel: &str, detail: impl Into<String>) -> CommStatus {
    CommStatus {
        channel: channel.to_string(),
        configured: true,
        status: "ok".to_string(),
        detail: detail.into(),
    }
}

fn send_result(channel: &str, detail: impl Into<String>) -> CommSendResult {
    CommSendResult {
        channel: channel.to_string(),
        status: "sent".to_string(),
        detail: detail.into(),
    }
}

fn ensure_ok_envelope(resp: reqwest::blocking::Response, operation: &str) -> Result<()> {
    let body: OkEnvelope = resp.json()?;
    if !body.ok {
        bail!("{operation} returned ok=false");
    }
    Ok(())
}

pub fn channel_status(channel: ChannelKind) -> Result<CommStatus> {
    match channel {
        ChannelKind::Discord => discord_status(),
        ChannelKind::Telegram => telegram_status(),
        ChannelKind::Slack => slack_status(),
        ChannelKind::GoogleChat => googlechat_status(),
        ChannelKind::MsTeams => msteams_status(),
        ChannelKind::WebChat => Ok(status_ok(channel.as_str(), "served by titan web dashboard")),
        other => bridge_status(other),
    }
}

pub fn channel_send(channel: ChannelKind, target: &str, message: &str) -> Result<CommSendResult> {
    if target.trim().is_empty() {
        bail!("target is required");
    }
    if message.trim().is_empty() {
        bail!("message is required");
    }
    match channel {
        ChannelKind::Discord => discord_send(target, message),
        ChannelKind::Telegram => telegram_send(target, message),
        ChannelKind::Slack => slack_send(target, message),
        ChannelKind::GoogleChat => googlechat_send(target, message),
        ChannelKind::MsTeams => msteams_send(target, message),
        ChannelKind::WebChat => Ok(CommSendResult {
            channel: channel.as_str().to_string(),
            status: "queued".to_string(),
            detail: "webchat send should be handled by dashboard websocket path".to_string(),
        }),
        other => bridge_send(other, target, message),
    }
}

fn discord_status() -> Result<CommStatus> {
    let token = std::env::var("DISCORD_BOT_TOKEN")
        .with_context(|| "missing DISCORD_BOT_TOKEN for discord channel")?;
    let gw = DiscordGateway::new(&token, 10_000)?;
    let me = gw.healthcheck()?;
    Ok(status_ok(
        "discord",
        format!("bot {} ({})", me.username, me.id),
    ))
}

fn discord_send(target: &str, message: &str) -> Result<CommSendResult> {
    let token = std::env::var("DISCORD_BOT_TOKEN")
        .with_context(|| "missing DISCORD_BOT_TOKEN for discord channel")?;
    let gw = DiscordGateway::new(&token, 10_000)?;
    let msg = gw.send_message(target, message)?;
    Ok(send_result(
        "discord",
        format!("message_id={} channel_id={}", msg.id, msg.channel_id),
    ))
}

fn telegram_status() -> Result<CommStatus> {
    let token = std::env::var("TELEGRAM_BOT_TOKEN")
        .with_context(|| "missing TELEGRAM_BOT_TOKEN for telegram channel")?;
    let client = Client::new();
    let resp = client
        .get(format!("https://api.telegram.org/bot{token}/getMe"))
        .send()?;
    if !resp.status().is_success() {
        bail!("telegram getMe failed: {}", resp.status());
    }
    ensure_ok_envelope(resp, "telegram getMe")?;
    Ok(status_ok("telegram", "bot token validated"))
}

fn telegram_send(target: &str, message: &str) -> Result<CommSendResult> {
    let token = std::env::var("TELEGRAM_BOT_TOKEN")
        .with_context(|| "missing TELEGRAM_BOT_TOKEN for telegram channel")?;
    let client = Client::new();
    let resp = client
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&serde_json::json!({
            "chat_id": target,
            "text": message
        }))
        .send()?;
    if !resp.status().is_success() {
        bail!("telegram sendMessage failed: {}", resp.status());
    }
    ensure_ok_envelope(resp, "telegram sendMessage")?;
    Ok(send_result("telegram", "message posted"))
}

fn slack_status() -> Result<CommStatus> {
    let token =
        std::env::var("SLACK_BOT_TOKEN").with_context(|| "missing SLACK_BOT_TOKEN for slack")?;
    let client = Client::new();
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    let resp = client
        .get("https://slack.com/api/auth.test")
        .headers(headers)
        .send()?;
    if !resp.status().is_success() {
        bail!("slack auth.test failed: {}", resp.status());
    }
    ensure_ok_envelope(resp, "slack auth.test")?;
    Ok(status_ok("slack", "bot token validated"))
}

fn slack_send(target: &str, message: &str) -> Result<CommSendResult> {
    let token =
        std::env::var("SLACK_BOT_TOKEN").with_context(|| "missing SLACK_BOT_TOKEN for slack")?;
    let client = Client::new();
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let resp = client
        .post("https://slack.com/api/chat.postMessage")
        .headers(headers)
        .json(&serde_json::json!({
            "channel": target,
            "text": message
        }))
        .send()?;
    if !resp.status().is_success() {
        bail!("slack chat.postMessage failed: {}", resp.status());
    }
    ensure_ok_envelope(resp, "slack chat.postMessage")?;
    Ok(send_result("slack", "message posted"))
}

fn googlechat_status() -> Result<CommStatus> {
    let url = std::env::var("GOOGLECHAT_WEBHOOK_URL")
        .with_context(|| "missing GOOGLECHAT_WEBHOOK_URL for googlechat")?;
    if url.trim().is_empty() {
        bail!("GOOGLECHAT_WEBHOOK_URL is empty");
    }
    Ok(status_ok("googlechat", "webhook configured"))
}

fn googlechat_send(_target: &str, message: &str) -> Result<CommSendResult> {
    let url = std::env::var("GOOGLECHAT_WEBHOOK_URL")
        .with_context(|| "missing GOOGLECHAT_WEBHOOK_URL for googlechat")?;
    let client = Client::new();
    let resp = client
        .post(url)
        .json(&serde_json::json!({ "text": message }))
        .send()?;
    if !resp.status().is_success() {
        bail!("googlechat webhook send failed: {}", resp.status());
    }
    Ok(send_result("googlechat", "message posted"))
}

fn msteams_status() -> Result<CommStatus> {
    let url =
        std::env::var("MSTEAMS_WEBHOOK_URL").with_context(|| "missing MSTEAMS_WEBHOOK_URL")?;
    if url.trim().is_empty() {
        bail!("MSTEAMS_WEBHOOK_URL is empty");
    }
    Ok(status_ok("msteams", "webhook configured"))
}

fn msteams_send(_target: &str, message: &str) -> Result<CommSendResult> {
    let url =
        std::env::var("MSTEAMS_WEBHOOK_URL").with_context(|| "missing MSTEAMS_WEBHOOK_URL")?;
    let client = Client::new();
    let resp = client
        .post(url)
        .json(&serde_json::json!({ "text": message }))
        .send()?;
    if !resp.status().is_success() {
        bail!("msteams webhook send failed: {}", resp.status());
    }
    Ok(send_result("msteams", "message posted"))
}

fn bridge_status(channel: ChannelKind) -> Result<CommStatus> {
    let key = channel.bridge_env_key();
    let bridge = std::env::var(&key).with_context(|| format!("missing {key}"))?;
    let client = Client::new();
    // Bridge contract uses one health probe and one send endpoint.
    let resp = client
        .get(format!("{}/health", bridge.trim_end_matches('/')))
        .send()?;
    if !resp.status().is_success() {
        bail!("bridge health failed: {}", resp.status());
    }
    Ok(status_ok(channel.as_str(), format!("bridge {}", bridge)))
}

fn bridge_send(channel: ChannelKind, target: &str, message: &str) -> Result<CommSendResult> {
    let key = channel.bridge_env_key();
    let bridge = std::env::var(&key).with_context(|| format!("missing {key}"))?;
    let client = Client::new();
    #[derive(Serialize)]
    struct BridgePayload<'a> {
        target: &'a str,
        message: &'a str,
    }
    // This stable payload keeps channel adapters decoupled from TITAN internals.
    let resp = client
        .post(format!("{}/send", bridge.trim_end_matches('/')))
        .json(&BridgePayload { target, message })
        .send()?;
    if !resp.status().is_success() {
        bail!("bridge send failed: {}", resp.status());
    }
    Ok(send_result(channel.as_str(), format!("bridge {}", bridge)))
}

#[cfg(test)]
mod tests {
    use super::ChannelKind;

    #[test]
    fn parses_channel_aliases() {
        assert_eq!(
            ChannelKind::parse("google-chat"),
            Some(ChannelKind::GoogleChat)
        );
        assert_eq!(ChannelKind::parse("teams"), Some(ChannelKind::MsTeams));
        assert_eq!(
            ChannelKind::parse("zalo-personal"),
            Some(ChannelKind::ZaloUser)
        );
        assert_eq!(
            ChannelKind::parse("nextcloud-talk"),
            Some(ChannelKind::NextcloudTalk)
        );
    }

    #[test]
    fn includes_full_channel_surface() {
        assert_eq!(ChannelKind::all().len(), 21);
        assert!(ChannelKind::all().contains(&ChannelKind::Discord));
        assert!(ChannelKind::all().contains(&ChannelKind::WebChat));
    }
}
