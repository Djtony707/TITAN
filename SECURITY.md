# Security Policy

## Supported Versions

TITAN follows [Semantic Versioning](https://semver.org/) since v1.0. Only the
latest minor on the current major receives security fixes; older minors are
considered end-of-life unless explicitly noted. The 2026.X.Y calendar-version
line predates v1.0.0 and is no longer supported — please upgrade.

| Version           | Supported     |
| ----------------- | ------------- |
| 5.4.x             | Yes (current) |
| 5.3.x             | Yes (until next minor) |
| 5.0.x – 5.2.x     | No            |
| < 5.0             | No            |
| 1.0.x             | No            |
| 2026.X.Y          | No (legacy calendar versions) |

## Reporting a Vulnerability

If you discover a security vulnerability in TITAN, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email **security@titanagent.dev** or use [GitHub's private vulnerability reporting](https://github.com/Djtony707/TITAN/security/advisories/new).

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact

### What to expect

- Acknowledgment within 48 hours
- Status update within 7 days
- Fix timeline based on severity:
  - **Critical**: Patch within 72 hours
  - **High**: Patch within 1 week
  - **Medium**: Patch in next release
  - **Low**: Tracked for future release

## Security Architecture

TITAN uses a defense-in-depth approach:

- **Sandbox Mode**: Restricts tool execution (host, docker, or none)
- **Shield**: Prompt injection detection (standard and strict modes)
- **Network Allowlist**: Controls outbound connections
- **Vault**: Encrypted secrets storage (AES-256-GCM)
- **Audit Log**: Tamper-evident logging of all tool invocations
- **Auth**: Token or password authentication for the gateway

## Responsible Disclosure

We follow coordinated disclosure. We will credit reporters in the changelog unless anonymity is requested.
