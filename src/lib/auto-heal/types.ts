export type IssueCategory =
  | 'missing_package'
  | 'broken_import'
  | 'version_mismatch'
  | 'orphan_module'
  | 'config_error'
  | 'build_failure';

export type RepairStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'skipped';

export interface DependencyIssue {
  id: string;
  category: IssueCategory;
  packageName?: string;
  requiredVersion?: string;
  installedVersion?: string;
  importPath?: string;
  message: string;
  detectedAt: number;
}

export interface RepairAction {
  type: 'install' | 'reinstall' | 'update' | 'remove' | 'fix_import' | 'fix_config' | 'restart';
  description: string;
  command?: string;
  target?: string;
}

export interface RepairResult {
  issueId: string;
  status: RepairStatus;
  actions: RepairAction[];
  output?: string;
  attempts: number;
  startedAt: number;
  completedAt: number;
}

export interface CircuitState {
  failures: number;
  lastFailureAt: number;
  state: 'closed' | 'open' | 'half_open';
  resetAt?: number;
}

export interface AutoHealConfig {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  circuitThreshold: number;
  circuitResetMs: number;
  enabledCategories: IssueCategory[];
  dryRun: boolean;
}

export const DEFAULT_AUTO_HEAL_CONFIG: AutoHealConfig = {
  maxRetries: 3,
  baseBackoffMs: 1000,
  maxBackoffMs: 30000,
  circuitThreshold: 5,
  circuitResetMs: 60000,
  enabledCategories: [
    'missing_package',
    'broken_import',
    'version_mismatch',
    'orphan_module',
    'config_error',
    'build_failure',
  ],
  dryRun: false,
};