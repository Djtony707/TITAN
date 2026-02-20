pub mod config;
pub mod logging;
pub mod path_guard;

pub const APP_NAME: &str = "TITAN";

pub use config::{AutonomyMode, DiscordConfig, ModelConfig, ModelProvider, TitanConfig};
