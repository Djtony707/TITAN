# TITAN Secrets Store

TITAN supports encrypted local connector secrets with env-var fallback.

## Storage

- File: `~/.titan/secrets.enc`
- Envelope includes: version, salt, nonce, ciphertext.
- Cipher: `XChaCha20-Poly1305`
- KDF: `Argon2id` passphrase -> 32-byte key

No plaintext secret values are stored in SQLite config tables.

## Onboarding

`onboard` prompts for a secrets passphrase:

- If provided: encrypted store is initialized/unlocked for that process.
- If skipped: env-vars-only mode (store remains locked).

## CLI

```bash
titan secrets status
titan secrets unlock
titan secrets lock
```

`unlock` is process-local and does not persist an in-memory key across separate CLI invocations.

## Runtime

For long-running processes (`titan run`, gateway/web approval paths), set:

```bash
export TITAN_SECRETS_PASSPHRASE='your passphrase'
```

This allows runtime resolution of encrypted connector secrets without writing plaintext to logs or DB rows.
