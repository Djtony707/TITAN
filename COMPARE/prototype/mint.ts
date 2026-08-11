// Re-export of v7's src/receipts/mint.ts — unchanged, so the prototype
// uses the exact same action_id format as the live receipts.
let lastTs = 0;
let counter = 0;

export function mintActionId(): string {
    const now = Date.now();
    if (now === lastTs) {
        counter = (counter + 1) & 0xffff;
    } else {
        lastTs = now;
        counter = 0;
    }
    const tsHex = now.toString(16).padStart(12, '0').slice(-12);
    const counterHex = counter.toString(16).padStart(4, '0').slice(-4);
    const randomHex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${tsHex}${counterHex}${randomHex}`;
}
