/**
 * Bench mode (v7.1) — TITAN_BENCH=1 silences every background LLM consumer
 * so benchmarks measure the MODEL, not the model fighting TITAN's own life
 * loop for the same GPU. Discovered the hard way: provider-flip restarts
 * wake Soma/GEPA/heartbeat/graph-extraction, which 429-storm the flipped
 * endpoint concurrently with eval traffic.
 *
 * Never enable in normal operation — it turns the living desk off.
 */
export function isBenchMode(): boolean {
    return process.env.TITAN_BENCH === '1';
}
