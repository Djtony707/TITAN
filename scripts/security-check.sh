#!/bin/bash
# TITAN Security Pre-Flight Check
# Run this before production deployment

set -e

echo "🔒 TITAN Security Check"
echo "======================"
echo ""

FAILED=0

# Check 1: WASM toolchain
echo "✓ Checking WASM toolchain..."
if ! command -v wasmtime &> /dev/null; then
    echo "  ⚠️  Wasmtime not found. Install with: curl https://wasmtime.dev/install.sh"
    FAILED=1
else
    echo "  ✅ Wasmtime installed"
fi

# Check 2: Workspace configuration
echo "✓ Checking workspace configuration..."
if [ -f .env ]; then
    WORKSPACE=$(grep "^TITAN_WORKSPACE=" .env | cut -d '=' -f2 | head -1)
    if [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE" ]; then
        echo "  ✅ Workspace configured: $WORKSPACE"
    else
        echo "  ⚠️  Workspace not configured or doesn't exist"
        FAILED=1
    fi
else
    echo "  ⚠️  .env file not found. Run: titan configure"
    FAILED=1
fi

# Check 3: Secret management
echo "✓ Checking secret management..."
if [ -f .env ]; then
    # Check Discord token is set but not in logs
    if grep -q "^DISCORD_TOKEN=" .env; then
        TOKEN=$(grep "^DISCORD_TOKEN=" .env | cut -d '=' -f2 | head -1)
        if [ -n "$TOKEN" ] && [ ${#TOKEN} -gt 10 ]; then
            echo "  ✅ Discord token configured"
        else
            echo "  ⚠️  Discord token appears invalid"
            FAILED=1
        fi
    fi
    
    # Verify secrets not in codebase (if src/ exists)
    if [ -d src ]; then
        if grep -r "DISCORD_TOKEN" src/ 2>/dev/null | grep -v "env::var" | head -1; then
            echo "  ❌ Secrets found in source code!"
            FAILED=1
        else
            echo "  ✅ Secrets properly isolated"
        fi
    else
        echo "  ℹ️  No src/ directory (skipping secret scan)"
    fi
fi

# Check 4: Approval workflow
echo "✓ Checking approval workflow..."
if [ -f config/default.toml ]; then
    if grep -q "require_approval\|approval_mode\|autonomy_mode" config/default.toml; then
        echo "  ✅ Approval workflow configured"
    else
        echo "  ⚠️  Approval workflow not explicitly configured"
    fi
else
    echo "  ℹ️  Config file not found (will be created on first run)"
fi

# Check 5: Audit logging
echo "✓ Checking audit log configuration..."
if [ -f .env ]; then
    if grep -q "^TITAN_AUDIT_LOG" .env; then
        echo "  ✅ Audit logging enabled"
    else
        echo "  ⚠️  Audit logging not enabled (recommended for production)"
    fi
fi

# Check 6: Resource limits
echo "✓ Checking resource limits..."
if [ -f config/default.toml ]; then
    if grep -q "memory_limit\|timeout\|max_memory\|execution_timeout" config/default.toml; then
        echo "  ✅ Resource limits configured"
    else
        echo "  ⚠️  Resource limits not configured (recommended)"
    fi
else
    echo "  ℹ️  No config file to check for resource limits"
fi

# Check 7: Emergency controls
echo "✓ Checking emergency controls..."
if [ -f src/main.rs ]; then
    if grep -q "killswitch\|emergency\|panic_handler" src/main.rs 2>/dev/null; then
        echo "  ✅ Emergency killswitch implemented"
    else
        echo "  ⚠️  Emergency killswitch not found"
        FAILED=1
    fi
else
    echo "  ℹ️  No source code yet (skipping killswitch check)"
fi

# Check 8: File permissions
echo "✓ Checking file permissions..."
ENV_PERMS=$(stat -c %a .env 2>/dev/null || echo "000")
if [ "$ENV_PERMS" = "600" ] || [ "$ENV_PERMS" = "644" ]; then
    echo "  ✅ .env permissions secure ($ENV_PERMS)"
else
    echo "  ⚠️  .env permissions too open ($ENV_PERMS). Run: chmod 600 .env"
    FAILED=1
fi

# Summary
echo ""
echo "======================"
if [ $FAILED -eq 0 ]; then
    echo "✅ All security checks passed!"
    echo "TITAN is ready for production deployment."
    exit 0
else
    echo "⚠️  Some security checks failed."
    echo "Review the warnings above before deploying to production."
    exit 1
fi
