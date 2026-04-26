import { execSync } from 'child_process';
import type {
  DependencyIssue,
  RepairAction,
  RepairResult,
  AutoHealConfig} from './types.js';
import {
  DEFAULT_AUTO_HEAL_CONFIG,
} from './types.js';

export class MissingPackageRepair {
  private config: AutoHealConfig;

  constructor(config: AutoHealConfig = DEFAULT_AUTO_HEAL_CONFIG) {
    this.config = config;
  }

  canHandle(issue: DependencyIssue): boolean {
    return issue.category === 'missing_package' && this.config.enabledCategories.includes('missing_package');
  }

  planActions(issue: DependencyIssue): RepairAction[] {
    const pkg = issue.packageName;
    if (!pkg) return [];
    return [
      { type: 'install', description: `Install missing package ${pkg}`, command: `npm install ${pkg}` },
    ];
  }

  async execute(issue: DependencyIssue): Promise<RepairResult> {
    const startedAt = Date.now();
    const actions = this.planActions(issue);
    let output = '';
    let status: RepairResult['status'] = 'succeeded';

    if (this.config.dryRun) {
      return { issueId: issue.id, status: 'skipped', actions, output: 'DRY RUN', attempts: 1, startedAt, completedAt: Date.now() };
    }

    for (const action of actions) {
      if (!action.command) continue;
      try {
        output += execSync(action.command, { encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        status = 'failed';
        output += err.stdout || '' + (err.stderr || err.message);
      }
    }

    return { issueId: issue.id, status, actions, output, attempts: 1, startedAt, completedAt: Date.now() };
  }
}

export class BrokenImportRepair {
  private config: AutoHealConfig;

  constructor(config: AutoHealConfig = DEFAULT_AUTO_HEAL_CONFIG) {
    this.config = config;
  }

  canHandle(issue: DependencyIssue): boolean {
    return issue.category === 'broken_import' && this.config.enabledCategories.includes('broken_import');
  }

  planActions(issue: DependencyIssue): RepairAction[] {
    const actions: RepairAction[] = [];
    if (issue.packageName) {
      actions.push({ type: 'reinstall', description: `Reinstall ${issue.packageName} to fix broken import`, command: `npm install ${issue.packageName}@latest` });
    }
    if (issue.importPath) {
      actions.push({ type: 'fix_import', description: `Clear node_modules cache for ${issue.importPath}` });
    }
    return actions;
  }

  async execute(issue: DependencyIssue): Promise<RepairResult> {
    const startedAt = Date.now();
    const actions = this.planActions(issue);
    let output = '';
    let status: RepairResult['status'] = 'succeeded';

    if (this.config.dryRun) {
      return { issueId: issue.id, status: 'skipped', actions, output: 'DRY RUN', attempts: 1, startedAt, completedAt: Date.now() };
    }

    for (const action of actions) {
      if (!action.command) continue;
      try {
        output += execSync(action.command, { encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        status = 'failed';
        output += err.stdout || '' + (err.stderr || err.message);
      }
    }

    return { issueId: issue.id, status, actions, output, attempts: 1, startedAt, completedAt: Date.now() };
  }
}

export class VersionMismatchRepair {
  private config: AutoHealConfig;

  constructor(config: AutoHealConfig = DEFAULT_AUTO_HEAL_CONFIG) {
    this.config = config;
  }

  canHandle(issue: DependencyIssue): boolean {
    return issue.category === 'version_mismatch' && this.config.enabledCategories.includes('version_mismatch');
  }

  planActions(issue: DependencyIssue): RepairAction[] {
    const pkg = issue.packageName;
    const ver = issue.requiredVersion;
    if (!pkg) return [];
    const target = ver ? `${pkg}@${ver}` : `${pkg}@latest`;
    return [
      { type: 'update', description: `Update ${pkg} to ${ver || 'latest'}`, command: `npm install ${target}` },
    ];
  }

  async execute(issue: DependencyIssue): Promise<RepairResult> {
    const startedAt = Date.now();
    const actions = this.planActions(issue);
    let output = '';
    let status: RepairResult['status'] = 'succeeded';

    if (this.config.dryRun) {
      return { issueId: issue.id, status: 'skipped', actions, output: 'DRY RUN', attempts: 1, startedAt, completedAt: Date.now() };
    }

    for (const action of actions) {
      if (!action.command) continue;
      try {
        output += execSync(action.command, { encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        status = 'failed';
        output += err.stdout || '' + (err.stderr || err.message);
      }
    }

    return { issueId: issue.id, status, actions, output, attempts: 1, startedAt, completedAt: Date.now() };
  }
}

export class OrphanModuleRepair {
  private config: AutoHealConfig;

  constructor(config: AutoHealConfig = DEFAULT_AUTO_HEAL_CONFIG) {
    this.config = config;
  }

  canHandle(issue: DependencyIssue): boolean {
    return issue.category === 'orphan_module' && this.config.enabledCategories.includes('orphan_module');
  }

  planActions(issue: DependencyIssue): RepairAction[] {
    const pkg = issue.packageName;
    if (!pkg) return [];
    return [
      { type: 'remove', description: `Remove orphan package ${pkg}`, command: `npm uninstall ${pkg}` },
    ];
  }

  async execute(issue: DependencyIssue): Promise<RepairResult> {
    const startedAt = Date.now();
    const actions = this.planActions(issue);
    let output = '';
    let status: RepairResult['status'] = 'succeeded';

    if (this.config.dryRun) {
      return { issueId: issue.id, status: 'skipped', actions, output: 'DRY RUN', attempts: 1, startedAt, completedAt: Date.now() };
    }

    for (const action of actions) {
      if (!action.command) continue;
      try {
        output += execSync(action.command, { encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        status = 'failed';
        output += err.stdout || '' + (err.stderr || err.message);
      }
    }

    return { issueId: issue.id, status, actions, output, attempts: 1, startedAt, completedAt: Date.now() };
  }
}

export class ConfigErrorRepair {
  private config: AutoHealConfig;

  constructor(config: AutoHealConfig = DEFAULT_AUTO_HEAL_CONFIG) {
    this.config = config;
  }

  canHandle(issue: DependencyIssue): boolean {
    return issue.category === 'config_error' && this.config.enabledCategories.includes('config_error');
  }

  planActions(issue: DependencyIssue): RepairAction[] {
    return [
      { type: 'fix_config', description: `Regenerate package-lock.json and node_modules`, command: 'npm ci' },
    ];
  }

  async execute(issue: DependencyIssue): Promise<RepairResult> {
    const startedAt = Date.now();
    const actions = this.planActions(issue);
    let output = '';
    let status: RepairResult['status'] = 'succeeded';

    if (this.config.dryRun) {
      return { issueId: issue.id, status: 'skipped', actions, output: 'DRY RUN', attempts: 1, startedAt, completedAt: Date.now() };
    }

    for (const action of actions) {
      if (!action.command) continue;
      try {
        output += execSync(action.command, { encoding: 'utf-8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        status = 'failed';
        output += err.stdout || '' + (err.stderr || err.message);
      }
    }

    return { issueId: issue.id, status, actions, output, attempts: 1, startedAt, completedAt: Date.now() };
  }
}

export class BuildFailureRepair {
  private config: AutoHealConfig;

  constructor(config: AutoHealConfig = DEFAULT_AUTO_HEAL_CONFIG) {
    this.config = config;
  }

  canHandle(issue: DependencyIssue): boolean {
    return issue.category === 'build_failure' && this.config.enabledCategories.includes('build_failure');
  }

  planActions(issue: DependencyIssue): RepairAction[] {
    return [
      { type: 'fix_config', description: 'Clean install dependencies', command: 'rm -rf node_modules && npm install' },
      { type: 'restart', description: 'Clear Next.js build cache', command: 'rm -rf .next' },
    ];
  }

  async execute(issue: DependencyIssue): Promise<RepairResult> {
    const startedAt = Date.now();
    const actions = this.planActions(issue);
    let output = '';
    let status: RepairResult['status'] = 'succeeded';

    if (this.config.dryRun) {
      return { issueId: issue.id, status: 'skipped', actions, output: 'DRY RUN', attempts: 1, startedAt, completedAt: Date.now() };
    }

    for (const action of actions) {
      if (!action.command) continue;
      try {
        output += execSync(action.command, { encoding: 'utf-8', timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        status = 'failed';
        output += err.stdout || '' + (err.stderr || err.message);
      }
    }

    return { issueId: issue.id, status, actions, output, attempts: 1, startedAt, completedAt: Date.now() };
  }
}