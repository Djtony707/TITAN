/**
 * TITAN — Team Mode RBAC Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { testHome } = vi.hoisted(() => {
    const { join } = require('path');
    const { tmpdir } = require('os');
    return { testHome: join(tmpdir(), `titan-test-teams-${Date.now()}`) };
});

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: testHome,
    TITAN_VERSION: '2026.9.2',
    TITAN_NAME: 'TITAN',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    createTeam, getTeam, getTeamByName, listTeams, listUserTeams, deleteTeam, updateTeam,
    addMember, removeMember, updateMemberRole, createInvite, acceptInvite,
    getEffectivePermissions, isToolAllowed, hasMinimumRole, getUserRole,
    setRolePermissions, getTeamStats, resetTeamsCache,
} from '../src/security/teams.js';

beforeEach(() => {
    mkdirSync(testHome, { recursive: true });
    resetTeamsCache();
});

afterEach(() => {
    try { rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Team CRUD ───────────────────────────────────────────────
describe('Team CRUD', () => {
    it('should create a team', () => {
        const team = createTeam('alpha', 'tony');
        expect(team.name).toBe('alpha');
        expect(team.ownerId).toBe('tony');
        expect(team.members).toHaveLength(1);
        expect(team.members[0].role).toBe('owner');
        expect(team.members[0].status).toBe('active');
    });

    it('should reject duplicate team names', () => {
        createTeam('beta', 'tony');
        expect(() => createTeam('beta', 'tony')).toThrow('already exists');
    });

    it('should get team by ID and name', () => {
        const team = createTeam('gamma', 'tony');
        expect(getTeam(team.id)?.name).toBe('gamma');
        expect(getTeamByName('gamma')?.id).toBe(team.id);
    });

    it('should list all teams', () => {
        createTeam('t1', 'tony');
        createTeam('t2', 'tony');
        expect(listTeams()).toHaveLength(2);
    });

    it('should list teams for a specific user', () => {
        const t1 = createTeam('u1', 'tony');
        createTeam('u2', 'other');
        addMember(t1.id, 'tony', 'bob', 'operator');
        expect(listUserTeams('tony')).toHaveLength(1);
        expect(listUserTeams('bob')).toHaveLength(1);
        expect(listUserTeams('nobody')).toHaveLength(0);
    });

    it('should delete a team (owner only)', () => {
        const team = createTeam('del', 'tony');
        expect(() => deleteTeam(team.id, 'other')).toThrow('Only the team owner');
        expect(deleteTeam(team.id, 'tony')).toBe(true);
        expect(listTeams()).toHaveLength(0);
    });

    it('should update team name and description', () => {
        const team = createTeam('upd', 'tony', 'Original desc');
        const updated = updateTeam(team.id, 'tony', { name: 'updated', description: 'New desc' });
        expect(updated.name).toBe('updated');
        expect(updated.description).toBe('New desc');
    });
});

// ─── Members ─────────────────────────────────────────────────
describe('Member Management', () => {
    it('should add a member directly', () => {
        const team = createTeam('mem', 'tony');
        const member = addMember(team.id, 'tony', 'alice', 'operator', 'Alice');
        expect(member.userId).toBe('alice');
        expect(member.role).toBe('operator');
        expect(member.displayName).toBe('Alice');
        expect(getTeam(team.id)!.members).toHaveLength(2);
    });

    it('should reject adding duplicate active member', () => {
        const team = createTeam('dup', 'tony');
        addMember(team.id, 'tony', 'alice', 'operator');
        expect(() => addMember(team.id, 'tony', 'alice', 'viewer')).toThrow('already an active member');
    });

    it('should prevent non-admin from adding members', () => {
        const team = createTeam('perm', 'tony');
        addMember(team.id, 'tony', 'viewer1', 'viewer');
        expect(() => addMember(team.id, 'viewer1', 'bob', 'operator')).toThrow('Insufficient permissions');
    });

    it('should remove a member', () => {
        const team = createTeam('rem', 'tony');
        addMember(team.id, 'tony', 'alice', 'operator');
        expect(removeMember(team.id, 'tony', 'alice')).toBe(true);
        const member = getTeam(team.id)!.members.find(m => m.userId === 'alice');
        expect(member?.status).toBe('revoked');
    });

    it('should not allow removing the owner', () => {
        const team = createTeam('own', 'tony');
        expect(() => removeMember(team.id, 'tony', 'tony')).toThrow('Cannot remove the team owner');
    });

    it('should allow self-removal', () => {
        const team = createTeam('self', 'tony');
        addMember(team.id, 'tony', 'alice', 'operator');
        expect(removeMember(team.id, 'alice', 'alice')).toBe(true);
    });

    it('should update member role', () => {
        const team = createTeam('role', 'tony');
        addMember(team.id, 'tony', 'alice', 'operator');
        const updated = updateMemberRole(team.id, 'tony', 'alice', 'admin');
        expect(updated.role).toBe('admin');
    });

    it('should prevent escalation above own role', () => {
        const team = createTeam('esc', 'tony');
        addMember(team.id, 'tony', 'admin1', 'admin');
        expect(() => updateMemberRole(team.id, 'admin1', 'admin1', 'owner')).toThrow('Cannot assign a role higher');
    });
});

// ─── Invites ─────────────────────────────────────────────────
describe('Invite System', () => {
    it('should create and accept an invite', () => {
        const team = createTeam('inv', 'tony');
        const code = createInvite(team.id, 'tony', 'operator');
        expect(typeof code).toBe('string');
        expect(code.length).toBe(32);

        const result = acceptInvite(code, 'bob', 'Bob');
        expect(result.team.id).toBe(team.id);
        expect(result.member.role).toBe('operator');
        expect(result.member.displayName).toBe('Bob');
    });

    it('should reject invalid invite code', () => {
        expect(() => acceptInvite('invalid-code', 'bob')).toThrow('Invalid invite code');
    });

    it('should reject expired invites', () => {
        const team = createTeam('exp', 'tony');
        const code = createInvite(team.id, 'tony', 'operator', -1); // negative hours = already expired
        expect(() => acceptInvite(code, 'bob')).toThrow('expired');
    });

    it('should reject joining same team twice', () => {
        const team = createTeam('twice', 'tony');
        const code1 = createInvite(team.id, 'tony', 'operator');
        acceptInvite(code1, 'bob');
        const code2 = createInvite(team.id, 'tony', 'operator');
        expect(() => acceptInvite(code2, 'bob')).toThrow('Already a member');
    });

    it('should prevent viewers from creating invites', () => {
        const team = createTeam('vinv', 'tony');
        addMember(team.id, 'tony', 'viewer1', 'viewer');
        expect(() => createInvite(team.id, 'viewer1')).toThrow('Insufficient permissions');
    });
});

// ─── RBAC Permissions ────────────────────────────────────────
describe('RBAC Engine', () => {
    it('should return correct default permissions per role', () => {
        const team = createTeam('rbac', 'tony');
        addMember(team.id, 'tony', 'admin1', 'admin');
        addMember(team.id, 'tony', 'op1', 'operator');
        addMember(team.id, 'tony', 'view1', 'viewer');

        const ownerPerms = getEffectivePermissions(team.id, 'tony');
        expect(ownerPerms.canManageMembers).toBe(true);
        expect(ownerPerms.canManageSettings).toBe(true);
        expect(ownerPerms.canManageAgents).toBe(true);
        expect(ownerPerms.maxSessions).toBe(50);

        const adminPerms = getEffectivePermissions(team.id, 'admin1');
        expect(adminPerms.canManageMembers).toBe(true);
        expect(adminPerms.maxSessions).toBe(25);

        const opPerms = getEffectivePermissions(team.id, 'op1');
        expect(opPerms.canManageMembers).toBe(false);
        expect(opPerms.canUseApi).toBe(true);

        const viewerPerms = getEffectivePermissions(team.id, 'view1');
        expect(viewerPerms.canUseApi).toBe(false);
        expect(viewerPerms.canViewAudit).toBe(true);
    });

    it('should check tool access correctly', () => {
        const team = createTeam('tools', 'tony');
        addMember(team.id, 'tony', 'op1', 'operator');
        addMember(team.id, 'tony', 'view1', 'viewer');

        // Operator has wildcard access
        expect(isToolAllowed(team.id, 'op1', 'shell')).toBe(true);
        expect(isToolAllowed(team.id, 'op1', 'web_search')).toBe(true);

        // Viewer has deny wildcard
        expect(isToolAllowed(team.id, 'view1', 'shell')).toBe(false);
    });

    it('should apply per-role permission overrides', () => {
        const team = createTeam('override', 'tony');
        addMember(team.id, 'tony', 'op1', 'operator');

        // Override operator: deny shell
        setRolePermissions(team.id, 'tony', 'operator', {
            deniedTools: ['shell', 'exec'],
        });

        expect(isToolAllowed(team.id, 'op1', 'shell')).toBe(false);
        expect(isToolAllowed(team.id, 'op1', 'web_search')).toBe(true);
    });

    it('should support glob patterns for tools', () => {
        const team = createTeam('glob', 'tony');
        addMember(team.id, 'tony', 'op1', 'operator');

        setRolePermissions(team.id, 'tony', 'operator', {
            deniedTools: ['web_*'],
        });

        expect(isToolAllowed(team.id, 'op1', 'web_search')).toBe(false);
        expect(isToolAllowed(team.id, 'op1', 'web_fetch')).toBe(false);
        expect(isToolAllowed(team.id, 'op1', 'shell')).toBe(true);
    });

    it('should check minimum role', () => {
        const team = createTeam('hier', 'tony');
        addMember(team.id, 'tony', 'op1', 'operator');
        addMember(team.id, 'tony', 'view1', 'viewer');

        expect(hasMinimumRole(team.id, 'tony', 'owner')).toBe(true);
        expect(hasMinimumRole(team.id, 'op1', 'operator')).toBe(true);
        expect(hasMinimumRole(team.id, 'op1', 'admin')).toBe(false);
        expect(hasMinimumRole(team.id, 'view1', 'operator')).toBe(false);
    });

    it('should get user role', () => {
        const team = createTeam('urole', 'tony');
        addMember(team.id, 'tony', 'op1', 'operator');

        expect(getUserRole(team.id, 'tony')).toBe('owner');
        expect(getUserRole(team.id, 'op1')).toBe('operator');
        expect(getUserRole(team.id, 'nobody')).toBeNull();
    });

    it('should prevent modifying owner permissions', () => {
        const team = createTeam('nomod', 'tony');
        expect(() => setRolePermissions(team.id, 'tony', 'owner', { canManageMembers: false })).toThrow('Cannot override owner');
    });

    it('should return viewer perms for non-members', () => {
        const team = createTeam('nonmem', 'tony');
        const perms = getEffectivePermissions(team.id, 'stranger');
        expect(perms.canUseApi).toBe(false);
        expect(perms.canManageMembers).toBe(false);
    });
});

// ─── Team Stats ──────────────────────────────────────────────
describe('Team Stats', () => {
    it('should return correct stats', () => {
        const team = createTeam('stats', 'tony');
        addMember(team.id, 'tony', 'admin1', 'admin');
        addMember(team.id, 'tony', 'op1', 'operator');
        addMember(team.id, 'tony', 'op2', 'operator');
        removeMember(team.id, 'tony', 'op2'); // revoke one

        const stats = getTeamStats(team.id);
        expect(stats).not.toBeNull();
        expect(stats!.memberCount).toBe(4); // total including revoked
        expect(stats!.activeCount).toBe(3); // tony + admin1 + op1
        expect(stats!.roleBreakdown.owner).toBe(1);
        expect(stats!.roleBreakdown.admin).toBe(1);
        expect(stats!.roleBreakdown.operator).toBe(1);
    });

    it('should return null for nonexistent team', () => {
        expect(getTeamStats('nonexistent')).toBeNull();
    });
});

// ─── Persistence ─────────────────────────────────────────────
describe('Persistence', () => {
    it('should persist teams across cache resets', () => {
        createTeam('persist', 'tony');
        resetTeamsCache();
        expect(listTeams()).toHaveLength(1);
        expect(listTeams()[0].name).toBe('persist');
    });
});

// ─── Re-activation ──────────────────────────────────────────
describe('Member Re-activation', () => {
    it('should allow revoked members to rejoin via invite', () => {
        const team = createTeam('rejoin', 'tony');
        addMember(team.id, 'tony', 'alice', 'operator');
        removeMember(team.id, 'tony', 'alice');

        const code = createInvite(team.id, 'tony', 'admin');
        const result = acceptInvite(code, 'alice');
        expect(result.member.role).toBe('admin');
        expect(result.member.status).toBe('active');
    });
});
