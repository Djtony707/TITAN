export type DependencyStatus = "healthy" | "degraded" | "down" | "unknown";

export interface DependencyNode {
  id: string;
  name: string;
  type: "service" | "database" | "cache" | "queue" | "external" | "module";
  status: DependencyStatus;
  latencyMs: number;
  errorRate: number;
  lastChecked: number;
  metadata: Record<string, string>;
  dependsOn: string[];
}

export interface HealthCheckResult {
  dependencyId: string;
  status: DependencyStatus;
  latencyMs: number;
  errorRate: number;
  timestamp: number;
  message: string;
}

export interface HealthCheckConfig {
  id: string;
  name: string;
  type: DependencyNode["type"];
  checkIntervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  dependsOn: string[];
  checker: () => Promise<HealthCheckResult>;
}

export interface MonitoringSnapshot {
  timestamp: number;
  nodes: DependencyNode[];
  overallStatus: DependencyStatus;
  unhealthyCount: number;
  totalDependencies: number;
}

export interface AlertRule {
  id: string;
  dependencyId: string;
  condition: "status_change" | "latency_above" | "error_rate_above";
  threshold: number;
  cooldownMs: number;
  lastFired: number;
  handler: (alert: AlertEvent) => void;
}

export interface AlertEvent {
  ruleId: string;
  dependencyId: string;
  previousStatus: DependencyStatus;
  currentStatus: DependencyStatus;
  timestamp: number;
  message: string;
}