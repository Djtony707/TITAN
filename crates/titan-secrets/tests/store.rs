use tempfile::tempdir;
use titan_secrets::{SecretsStatus, SecretsStore};

#[test]
fn roundtrip_secrets_store_encrypts_payload() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("secrets.enc");
    let mut store = SecretsStore::at_path(path.clone());
    assert_eq!(store.status(), SecretsStatus::Locked);
    store.unlock("passphrase-123").expect("unlock");
    assert_eq!(store.status(), SecretsStatus::Unlocked);
    store
        .set_secret("connector:test:token", "super-secret-token")
        .expect("set secret");
    let value = store
        .get_secret("connector:test:token")
        .expect("get secret")
        .expect("value");
    assert_eq!(value, "super-secret-token");

    let raw = std::fs::read_to_string(&path).expect("read encrypted file");
    assert!(!raw.contains("super-secret-token"));

    let mut store2 = SecretsStore::at_path(path);
    store2.unlock("passphrase-123").expect("unlock again");
    let value2 = store2
        .get_secret("connector:test:token")
        .expect("get secret")
        .expect("value");
    assert_eq!(value2, "super-secret-token");
}

#[test]
fn wrong_passphrase_fails_to_unlock() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("secrets.enc");
    let mut store = SecretsStore::at_path(path.clone());
    store.unlock("correct-pass").expect("unlock");
    store
        .set_secret("connector:test:key", "value")
        .expect("set secret");
    store.lock();

    let mut fresh = SecretsStore::at_path(path);
    let err = fresh.unlock("wrong-pass").expect_err("must fail");
    assert!(err.to_string().contains("failed to decrypt"));
}
