pub mod config;
pub mod logging;
pub mod path_guard;

pub const APP_NAME: &str = "TITAN";

pub use config::{
    ActivationMode, AutonomyMode, ChatConfig, DiscordConfig, ModelConfig, ModelProvider,
    SecurityConfig, TitanConfig,
};
