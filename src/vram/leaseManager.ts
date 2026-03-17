/**
 * TITAN — VRAM Lease Manager
 * Time-bounded VRAM reservations with auto-expiry and reserve tracking.
 */
import { randomBytes } from 'crypto';
import logger from '../utils/logger.js';
import type { VRAMLease, VRAMEvent } from './types.js';

const COMPONENT = 'VRAMLeases';

export class LeaseManager {
    private leases = new Map<string, VRAMLease>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private onEvent: (event: VRAMEvent) => void;

    constructor(onEvent: (event: VRAMEvent) => void) {
        this.onEvent = onEvent;
    }

    /** Create a new time-bounded VRAM reservation */
    create(service: string, reservedMB: number, durationMs: number, meta?: {
        evictedModel?: string;
        replacementModel?: string;
    }): VRAMLease {
        const id = `vram-${randomBytes(4).toString('hex')}`;
        const now = Date.now();

        const lease: VRAMLease = {
            id,
            service,
            reservedMB,
            createdAt: now,
            expiresAt: now + durationMs,
            evictedModel: meta?.evictedModel,
            replacementModel: meta?.replacementModel,
        };

        this.leases.set(id, lease);

        // Auto-expiry timer
        const timer = setTimeout(() => {
            this.expire(id);
        }, durationMs);
        timer.unref(); // don't keep process alive
        this.timers.set(id, timer);

        logger.info(COMPONENT, `Lease created: ${id} for ${service} (${reservedMB}MB, ${Math.round(durationMs / 1000)}s)`);
        this.onEvent({ type: 'lease_created', lease });

        return lease;
    }

    /** Release a lease early (service done with VRAM) */
    release(leaseId: string): VRAMLease | null {
        const lease = this.leases.get(leaseId);
        if (!lease) return null;

        // Clear timer
        const timer = this.timers.get(leaseId);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(leaseId);
        }

        this.leases.delete(leaseId);
        logger.info(COMPONENT, `Lease released: ${leaseId} (${lease.service}, ${lease.reservedMB}MB)`);
        this.onEvent({ type: 'lease_released', leaseId, service: lease.service });

        return lease;
    }

    /** Handle lease expiry */
    private expire(leaseId: string): void {
        const lease = this.leases.get(leaseId);
        if (!lease) return;

        this.leases.delete(leaseId);
        this.timers.delete(leaseId);

        logger.info(COMPONENT, `Lease expired: ${leaseId} (${lease.service})`);
        this.onEvent({ type: 'lease_expired', leaseId, service: lease.service });
    }

    /** Get a lease by ID */
    get(leaseId: string): VRAMLease | null {
        return this.leases.get(leaseId) || null;
    }

    /** Get all active leases */
    getAll(): VRAMLease[] {
        return Array.from(this.leases.values());
    }

    /** Get total reserved MB across all active leases */
    getTotalReservedMB(): number {
        let total = 0;
        for (const lease of this.leases.values()) {
            total += lease.reservedMB;
        }
        return total;
    }

    /** Get leases for a specific service */
    getByService(service: string): VRAMLease[] {
        return Array.from(this.leases.values()).filter(l => l.service === service);
    }

    /** Release all leases for a service */
    releaseByService(service: string): VRAMLease[] {
        const released: VRAMLease[] = [];
        for (const lease of this.leases.values()) {
            if (lease.service === service) {
                const result = this.release(lease.id);
                if (result) released.push(result);
            }
        }
        return released;
    }

    /** Clean up all leases and timers */
    destroy(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.leases.clear();
    }
}
