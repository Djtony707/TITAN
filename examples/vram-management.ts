/**
 * TITAN VRAM Management Example — GPU memory orchestration with the VRAM Manager.
 *
 * This demonstrates how to:
 * 1. Check current VRAM usage and availability
 * 2. Acquire VRAM for a model (TITAN auto-swaps other models if needed)
 * 3. List active VRAM leases
 * 4. Release VRAM when done
 *
 * Prerequisites:
 *   - NVIDIA GPU with CUDA
 *   - Running TITAN gateway (`titan gateway`)
 *
 * Run: npx tsx examples/vram-management.ts
 */

const TITAN_URL = process.env.TITAN_URL || "http://localhost:48420";

async function checkVRAM() {
  const res = await fetch(`${TITAN_URL}/api/vram`);
  if (!res.ok) {
    throw new Error(`VRAM check failed: ${res.status}`);
  }
  const data = await res.json();
  console.log("\nVRAM Status:");
  console.log(`  Total: ${data.totalMB?.toFixed(0)} MB`);
  console.log(`  Used: ${data.usedMB?.toFixed(0)} MB`);
  console.log(`  Free: ${data.freeMB?.toFixed(0)} MB`);
  console.log(`  Models loaded: ${data.models?.length || 0}`);
  return data;
}

async function checkAvailability(requiredMB: number) {
  const res = await fetch(`${TITAN_URL}/api/vram/check?mb=${requiredMB}`);
  if (!res.ok) {
    throw new Error(`Availability check failed: ${res.status}`);
  }
  const data = await res.json();
  console.log(`\nNeed ${requiredMB} MB: ${data.available ? "Available" : "Not available"}`);
  if (data.canFree) {
    console.log(`  Can free ${data.freeableMB} MB by swapping models`);
  }
  return data;
}

async function acquireVRAM(modelName: string, requiredMB: number) {
  console.log(`\nAcquiring ${requiredMB} MB for "${modelName}"...`);
  const res = await fetch(`${TITAN_URL}/api/vram/acquire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      memoryMB: requiredMB,
    }),
  });

  if (!res.ok) {
    throw new Error(`VRAM acquire failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  console.log(`  Lease ID: ${data.leaseId}`);
  console.log(`  Models swapped: ${data.swappedModels?.length || 0}`);
  if (data.warning) {
    console.log(`  Warning: ${data.warning}`);
  }
  return data;
}

async function releaseVRAM(leaseId: string) {
  console.log(`\nReleasing lease ${leaseId}...`);
  const res = await fetch(`${TITAN_URL}/api/vram/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leaseId }),
  });

  if (!res.ok) {
    throw new Error(`VRAM release failed: ${res.status}`);
  }

  const data = await res.json();
  console.log(`  Released ${data.freedMB} MB`);
  return data;
}

async function main() {
  console.log("TITAN VRAM Management Demo\n");
  console.log("=".repeat(50));

  // Step 1: Check current state
  await checkVRAM();

  // Step 2: Check if we can load a hypothetical 8GB model
  await checkAvailability(8192);

  // Step 3: Acquire VRAM for a model
  const acquireData = await acquireVRAM("llama-3.3-70b", 16384);
  const leaseId = acquireData.leaseId;

  // Step 4: Show updated state
  console.log("\nAfter allocation:");
  await checkVRAM();

  // Step 5: Release when done
  await releaseVRAM(leaseId);

  // Step 6: Final state
  console.log("\nAfter release:");
  await checkVRAM();

  console.log("\nVRAM management complete. TITAN automatically handles model swapping!");
}

main().catch(console.error);
