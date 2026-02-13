# Contributing to TITAN

Thank you for your interest in contributing to TITAN! This document provides guidelines and instructions for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/titan.git`
3. Create a branch: `git checkout -b feature/your-feature-name`

## Development Setup

### Prerequisites

- Rust 1.75+
- SQLite 3.x
- Git

### Building

```bash
cd titan
cargo build --release
```

### Testing

```bash
# Run all tests
cargo test

# Run security tests
cargo test --test security

# Run integration tests
cargo test --test integration
```

### Running Security Check

```bash
./scripts/security-check.sh
```

## Contribution Guidelines

### Security First

TITAN is a security-first project. All contributions must:

- Maintain or improve security posture
- Pass the security check script
- Not introduce new vulnerabilities
- Include security considerations in PR description

### Code Style

- Follow Rust naming conventions
- Use `rustfmt` for formatting
- Run `cargo clippy` and address warnings
- Add documentation for public APIs

### Testing

- Write tests for new features
- Ensure existing tests pass
- Include security tests for sensitive code
- Test WASM sandbox boundaries

### Documentation

- Update README.md if adding features
- Add inline documentation for complex logic
- Update relevant docs in `docs/` folder
- Include examples for new capabilities

### Commit Messages

Use conventional commits:

```
feat: add new reasoning persona
fix: correct workspace path validation
docs: update security architecture
security: strengthen WASM sandbox
refactor: simplify approval workflow
test: add rate limiting tests
```

## Pull Request Process

1. Ensure all tests pass
2. Run the security check script
3. Update documentation as needed
4. Fill out the PR template completely
5. Link related issues
6. Wait for review (maintainers aim for 48-hour response)

## Code Review Criteria

PRs will be reviewed for:

- Security implications
- Code quality and style
- Test coverage
- Documentation completeness
- Performance impact
- WASM sandbox safety

## Areas Needing Help

See [GitHub Issues](https://github.com/titan/titan/issues) for:

- `good first issue` — Beginner-friendly tasks
- `help wanted` — Community assistance needed
- `security` — Security improvements
- `documentation` — Docs and guides

## Questions?

- GitHub Discussions: https://github.com/titan/titan/discussions
- Discord: https://discord.gg/titan

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on the code, not the person
- Assume good intentions

Thank you for contributing to TITAN!
