# Winget Packaging Notes

This folder contains starter manifests for publishing TITAN to WinGet.

## Expected release assets

The release workflow publishes these binaries:
- `titan-windows-x86_64.exe`
- `titan-windows-aarch64.exe`

## How to publish

1. Create a tagged GitHub release (for example `v0.1.0`).
2. Verify assets and checksums are present.
3. Update manifest files in this folder with:
   - exact version
   - installer URLs
   - SHA256 checksums
4. Submit manifests to the `microsoft/winget-pkgs` repository.

These templates are intentionally conservative and should be validated with WinGet tooling before submission.
