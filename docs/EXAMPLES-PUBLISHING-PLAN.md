# Examples Publishing Plan

This document outlines the steps to publish the example projects as scoped npm packages under `@titan-agent/`.

## Package Structure

Each example is a standalone package with:

```
examples/<name>/
├── package.json          # @titan-agent/example-<name>@1.0.0
├── tsconfig.json
├── README.md
└── src/
    └── index.ts
```

## Packages to Publish

| Package Name | Version | Directory |
|--------------|---------|-----------|
| `@titan-agent/example-basic-agent` | 1.0.0 | `examples/basic-agent/` |
| `@titan-agent/example-mission-control-extension` | 1.0.0 | `examples/mission-control-extension/` |
| `@titan-agent/example-mcp-server` | 1.0.0 | `examples/mcp-server/` |
| `@titan-agent/example-multi-agent-orchestration` | 1.0.0 | `examples/multi-agent-orchestration/` |
| `@titan-agent/example-voice-integration` | 1.0.0 | `examples/voice-integration/` |

## Pre-Publish Checklist

1. **Verify all examples build without errors:**
   ```bash
   for dir in examples/*/; do
     echo "Building $dir..."
     (cd "$dir" && npm run build)
   done
   ```

2. **Test each example against the latest TITAN version:**
   - Update `titan-agent` dependency to the current release
   - Run each example with `npm start`
   - Verify no runtime errors

3. **Update README links:**
   - Ensure all cross-references between examples work
   - Verify the main README Examples section links are correct

4. **Add .npmignore files:**
   Each example should have `.npmignore`:
   ```
   node_modules/
   dist/
   *.test.ts
   ```

5. **Create root-level publish script:**
   ```bash
   # scripts/publish-examples.sh
   for dir in examples/*/; do
     echo "Publishing $dir..."
     (cd "$dir" && npm publish --access public)
   done
   ```

## Publishing Steps

### Step 1: Build All Examples

```bash
for dir in examples/*/; do
  (cd "$dir" && npm install && npm run build)
done
```

### Step 2: Login to npm

```bash
npm login --scope=@titan-agent
# Use the TITAN npm account credentials
```

### Step 3: Publish Each Package

```bash
for dir in examples/*/; do
  (cd "$dir" && npm publish --access public)
done
```

### Step 4: Verify Publication

```bash
# Check each package on npm
for name in basic-agent mission-control-extension mcp-server multi-agent-orchestration voice-integration; do
  npm view @titan-agent/example-$name version
done
```

### Step 5: Update Main README

Add an npm badge for the examples collection:

```markdown
[![npm](https://img.shields.io/npm/v/@titan-agent/example-basic-agent?label=examples&style=flat-square)](https://www.npmjs.com/org/titan-agent)
```

## Post-Publish

After publishing, update the issue status:

1. Comment on TIT-27 with the npm package links
2. Update issue status to `completed`
3. Create a follow-up issue for future example additions

## Installation for Users

After publishing, users can install examples with:

```bash
# Install a single example
npm create @titan-agent/example basic-agent

# Or manually
npm install @titan-agent/example-basic-agent
```

## Future Considerations

- **Example templates**: Create a `create-titan-example` CLI for scaffolding
- **Umbrella package**: Consider a `@titan-agent/examples` meta-package that includes all examples
- **CI/CD integration**: Automate example publishing in GitHub Actions
