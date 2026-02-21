use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use argon2::Argon2;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};

const DEFAULT_SECRETS_FILE: &str = ".titan/secrets.enc";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretsStatus {
    Locked,
    Unlocked,
}

#[derive(Debug, Clone)]
pub struct SecretsStore {
    path: PathBuf,
    unlocked_key: Option<[u8; 32]>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    version: u32,
    salt_b64: String,
    nonce_b64: String,
    ciphertext_b64: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretMap {
    entries: BTreeMap<String, String>,
}

impl SecretsStore {
    pub fn at_path(path: PathBuf) -> Self {
        Self {
            path,
            unlocked_key: None,
        }
    }

    pub fn default_path() -> PathBuf {
        if let Ok(path) = std::env::var("TITAN_SECRETS_FILE")
            && !path.trim().is_empty()
        {
            return PathBuf::from(path);
        }
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(DEFAULT_SECRETS_FILE)
    }

    pub fn open_default() -> Self {
        Self::at_path(Self::default_path())
    }

    pub fn status(&self) -> SecretsStatus {
        if self.unlocked_key.is_some() {
            SecretsStatus::Unlocked
        } else {
            SecretsStatus::Locked
        }
    }

    pub fn lock(&mut self) {
        self.unlocked_key = None;
    }

    pub fn unlock(&mut self, passphrase: &str) -> Result<()> {
        if passphrase.trim().is_empty() {
            bail!("passphrase cannot be empty");
        }
        let mut salt = [0_u8; 16];
        if self.path.exists() {
            let envelope = read_envelope(&self.path)?;
            let decoded = base64::prelude::BASE64_STANDARD
                .decode(envelope.salt_b64)
                .with_context(|| "invalid salt in secrets store")?;
            if decoded.len() != 16 {
                bail!("invalid salt length in secrets store");
            }
            salt.copy_from_slice(&decoded);
        } else {
            rand::rng().fill_bytes(&mut salt);
            let key = derive_key(passphrase, &salt)?;
            let empty = SecretMap::default();
            write_encrypted(&self.path, &key, &salt, &empty)?;
            self.unlocked_key = Some(key);
            return Ok(());
        }

        let key = derive_key(passphrase, &salt)?;
        let _ = self.decrypt_map(&key)?;
        self.unlocked_key = Some(key);
        Ok(())
    }

    pub fn set_secret(&mut self, key_id: &str, value: &str) -> Result<()> {
        validate_key_id(key_id)?;
        if value.is_empty() {
            bail!("secret value cannot be empty");
        }
        let key = self
            .unlocked_key
            .ok_or_else(|| anyhow!("secrets store is locked"))?;
        let mut map = self.decrypt_map(&key)?;
        map.entries.insert(key_id.to_string(), value.to_string());
        let salt = read_or_create_salt(&self.path)?;
        write_encrypted(&self.path, &key, &salt, &map)
    }

    pub fn get_secret(&self, key_id: &str) -> Result<Option<String>> {
        validate_key_id(key_id)?;
        let key = self
            .unlocked_key
            .ok_or_else(|| anyhow!("secrets store is locked"))?;
        let map = self.decrypt_map(&key)?;
        Ok(map.entries.get(key_id).cloned())
    }

    pub fn delete_secret(&mut self, key_id: &str) -> Result<bool> {
        validate_key_id(key_id)?;
        let key = self
            .unlocked_key
            .ok_or_else(|| anyhow!("secrets store is locked"))?;
        let mut map = self.decrypt_map(&key)?;
        let removed = map.entries.remove(key_id).is_some();
        let salt = read_or_create_salt(&self.path)?;
        write_encrypted(&self.path, &key, &salt, &map)?;
        Ok(removed)
    }

    pub fn list_keys(&self) -> Result<Vec<String>> {
        let key = self
            .unlocked_key
            .ok_or_else(|| anyhow!("secrets store is locked"))?;
        let map = self.decrypt_map(&key)?;
        Ok(map.entries.keys().cloned().collect())
    }

    fn decrypt_map(&self, key: &[u8; 32]) -> Result<SecretMap> {
        let envelope = read_envelope(&self.path)?;
        decrypt_map_from_envelope(&envelope, key)
    }
}

fn validate_key_id(key_id: &str) -> Result<()> {
    if key_id.trim().is_empty() {
        bail!("key_id cannot be empty");
    }
    Ok(())
}

fn read_envelope(path: &Path) -> Result<Envelope> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read secrets store {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| "failed to parse secrets envelope")
}

fn read_or_create_salt(path: &Path) -> Result<[u8; 16]> {
    if path.exists() {
        let envelope = read_envelope(path)?;
        let salt = base64::prelude::BASE64_STANDARD
            .decode(envelope.salt_b64)
            .with_context(|| "invalid stored salt")?;
        if salt.len() != 16 {
            bail!("stored salt length is invalid");
        }
        let mut out = [0_u8; 16];
        out.copy_from_slice(&salt);
        Ok(out)
    } else {
        let mut salt = [0_u8; 16];
        rand::rng().fill_bytes(&mut salt);
        Ok(salt)
    }
}

fn derive_key(passphrase: &str, salt: &[u8; 16]) -> Result<[u8; 32]> {
    let mut key = [0_u8; 32];
    let argon = Argon2::default();
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|err| anyhow!("failed to derive secrets key: {err}"))?;
    Ok(key)
}

fn decrypt_map_from_envelope(envelope: &Envelope, key: &[u8; 32]) -> Result<SecretMap> {
    if envelope.version != 1 {
        bail!("unsupported secrets envelope version: {}", envelope.version);
    }
    let nonce = base64::prelude::BASE64_STANDARD
        .decode(&envelope.nonce_b64)
        .with_context(|| "invalid nonce")?;
    let ciphertext = base64::prelude::BASE64_STANDARD
        .decode(&envelope.ciphertext_b64)
        .with_context(|| "invalid ciphertext")?;
    if nonce.len() != 24 {
        bail!("invalid nonce length");
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("failed to decrypt secrets payload (wrong passphrase?)"))?;
    serde_json::from_slice(&plaintext).with_context(|| "failed to decode secrets payload")
}

fn write_encrypted(path: &Path, key: &[u8; 32], salt: &[u8; 16], map: &SecretMap) -> Result<()> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce = [0_u8; 24];
    rand::rng().fill_bytes(&mut nonce);
    let plaintext = serde_json::to_vec(map)?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| anyhow!("failed to encrypt secrets payload"))?;
    let envelope = Envelope {
        version: 1,
        salt_b64: base64::prelude::BASE64_STANDARD.encode(salt),
        nonce_b64: base64::prelude::BASE64_STANDARD.encode(nonce),
        ciphertext_b64: base64::prelude::BASE64_STANDARD.encode(ciphertext),
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create secrets dir {}", parent.display()))?;
    }
    let serialized = serde_json::to_vec_pretty(&envelope)?;
    fs::write(path, serialized)
        .with_context(|| format!("failed to write secrets store {}", path.display()))?;
    Ok(())
}
