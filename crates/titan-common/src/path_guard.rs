use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};

/// Canonicalizes and validates a workspace root directory used by tools/skills.
pub fn canonicalize_existing_dir(path: &Path) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("failed to canonicalize workspace root {}", path.display()))?;
    if !canonical.is_dir() {
        bail!("workspace root is not a directory: {}", canonical.display());
    }
    Ok(canonical)
}

/// Resolves an existing path and enforces it stays inside the workspace root.
pub fn resolve_existing_path_within(root: &Path, raw: &str) -> Result<PathBuf> {
    let candidate = if raw.trim().is_empty() {
        root.to_path_buf()
    } else {
        let p = PathBuf::from(raw.trim());
        if p.is_absolute() { p } else { root.join(p) }
    };
    let canonical = candidate
        .canonicalize()
        .with_context(|| format!("failed to resolve path {}", candidate.display()))?;
    if !canonical.starts_with(root) {
        bail!("path escapes workspace boundary");
    }
    Ok(canonical)
}

/// Resolves a write target and enforces its canonical parent stays inside the workspace root.
pub fn resolve_write_path_within(root: &Path, raw: &str) -> Result<PathBuf> {
    if raw.trim().is_empty() {
        bail!("write_file requires '<path>::<content>' input");
    }
    let p = PathBuf::from(raw.trim());
    let absolute = if p.is_absolute() { p } else { root.join(p) };
    let parent = absolute
        .parent()
        .ok_or_else(|| anyhow!("write path must have a parent"))?;
    fs::create_dir_all(parent)?;
    let canonical_parent = parent
        .canonicalize()
        .with_context(|| format!("failed to resolve parent {}", parent.display()))?;
    if !canonical_parent.starts_with(root) {
        bail!("write path escapes workspace boundary");
    }
    Ok(canonical_parent.join(
        absolute
            .file_name()
            .ok_or_else(|| anyhow!("write path missing file name"))?,
    ))
}
