# GitHub SSH Key Fix

The `titan-automation` key (`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKn1iLOqnh7PNl2q40SAWp5g6melwGxwKb7LuUJB487g`) is not authorized on the `tony/titan-v8` repo.

## Steps
1. Get the public key.
2. Add it to GitHub User Settings -> SSH Keys.
3. Test `git fetch origin`.
4. Update the branch SHA.

## Status
- Key found: `~/.ssh/id_ed25519_titan.pub`
- PAT not found: `~/.github_pat` does not exist.
- API key auth failed (401).
