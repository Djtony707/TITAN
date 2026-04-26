/**
 * TITAN — Organism Alert Store
 * Simple file-backed alert storage for the organism subsystem.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ALERTS_PATH = join(homedir(), '.titan', 'organism-alerts.json');

export interface OrganismAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  source: string;
  timestamp: string;
  acknowledged: boolean;
  data?: Record<string, unknown>;
}

function readAlerts(): OrganismAlert[] {
  if (!existsSync(ALERTS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(ALERTS_PATH, 'utf-8')) as OrganismAlert[];
  } catch { return []; }
}

function writeAlerts(alerts: OrganismAlert[]): void {
  try {
    writeFileSync(ALERTS_PATH, JSON.stringify(alerts, null, 2));
  } catch { /* ignore */ }
}

export function getAlerts(): OrganismAlert[] {
  return readAlerts();
}

export function getAlertStats(): { total: number; acked: number; unacked: number } {
  const alerts = readAlerts();
  const acked = alerts.filter(a => a.acknowledged).length;
  return { total: alerts.length, acked, unacked: alerts.length - acked };
}

export function acknowledgeAlert(id: string): boolean {
  const alerts = readAlerts();
  const alert = alerts.find(a => a.id === id);
  if (!alert) return false;
  alert.acknowledged = true;
  writeAlerts(alerts);
  return true;
}

export function addAlert(alert: Omit<OrganismAlert, 'id' | 'timestamp' | 'acknowledged'>): OrganismAlert {
  const alerts = readAlerts();
  const newAlert: OrganismAlert = {
    ...alert,
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    acknowledged: false,
  };
  alerts.push(newAlert);
  writeAlerts(alerts);
  return newAlert;
}

export function deleteOldAlerts(maxAgeDays = 30): number {
  const alerts = readAlerts();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const kept = alerts.filter(a => new Date(a.timestamp).getTime() > cutoff);
  const removed = alerts.length - kept.length;
  writeAlerts(kept);
  return removed;
}

export function getAlertConfig(): Record<string, unknown> {
  return { enabled: true, maxAgeDays: 30, channels: ['ui', 'log'] };
}

export function setAlertConfig(_config: Record<string, unknown>): void {
  // Stub — persist to file if needed later
}
