#!/bin/bash
#
# publish-examples.sh — Publish all example packages to npm
#
# Usage: ./scripts/publish-examples.sh [--dry-run]
#
# With --dry-run: shows what would be published without actually publishing
# Without flags: publishes all examples to npm (requires npm login)
#

set -euo pipefail

EXAMPLES_DIR="examples"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== DRY RUN MODE — No packages will be published ==="
fi

echo ""
echo "TITAN Examples Publisher"
echo "========================"
echo ""

# Verify we're in the TITAN root directory
if [[ ! -f "package.json" ]] || [[ ! -d "$EXAMPLES_DIR" ]]; then
  echo "Error: Run this script from the TITAN root directory."
  exit 1
fi

# Check npm authentication
if ! npm whoami &>/dev/null; then
  echo "Error: Not logged in to npm. Run 'npm login' first."
  exit 1
fi

NPM_USER=$(npm whoami)
echo "Logged in as: $NPM_USER"
echo ""

# Process each example
for dir in "$EXAMPLES_DIR"/*/; do
  if [[ ! -f "$dir/package.json" ]]; then
    continue
  fi

  PACKAGE_NAME=$(node -p "require('$dir/package.json').name")
  VERSION=$(node -p "require('$dir/package.json').version")

  echo "---"
  echo "Package: $PACKAGE_NAME"
  echo "Version: $VERSION"
  echo "Directory: $dir"

  # Build first
  echo "Building..."
  (cd "$dir" && npm run build 2>&1) || {
    echo "Build failed for $dir. Skipping."
    continue
  }

  if [[ "$DRY_RUN" == true ]]; then
    echo "[DRY RUN] Would publish $PACKAGE_NAME@$VERSION"
  else
    echo "Publishing $PACKAGE_NAME@$VERSION..."
    (cd "$dir" && npm publish --access public) || {
      echo "Publish failed for $dir"
      continue
    }
    echo "Published $PACKAGE_NAME@$VERSION"
  fi

  echo ""
done

echo "========================"
if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run complete. No packages were published."
  echo "Run without --dry-run to actually publish."
else
  echo "All examples published successfully!"
fi
echo ""
