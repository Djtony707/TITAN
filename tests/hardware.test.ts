/**
 * TITAN — Hardware Detection Tests
 * Tests GPU detection utility for auto-tuning stall thresholds.
 * Now tests multi-vendor detection (NVIDIA, AMD ROCm, Apple Silicon).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so mock functions are available inside vi.mock() callbacks
const { mockExistsSync, mockExecSync, mockPlatform, mockArch } = vi.hoisted(() => ({
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockExecSync: vi.fn().mockImplementation(() => { throw new Error('no lspci'); }),
    mockPlatform: vi.fn().mockReturnValue('linux'),
    mockArch: vi.fn().mockReturnValue('x64'),
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
}));
vi.mock('child_process', () => ({
    execSync: mockExecSync,
    execFile: vi.fn(),
}));
vi.mock('os', () => ({
    platform: mockPlatform,
    arch: mockArch,
    homedir: vi.fn().mockReturnValue('/tmp/test-titan'),
}));

import { detectGpuVendor, resetVendorCache } from '../src/vram/gpuProbe.js';
import { detectGpu, getGpuVendor } from '../src/utils/hardware.js';

describe('Hardware Detection', () => {
    beforeEach(() => {
        mockExistsSync.mockReset().mockReturnValue(false);
        mockExecSync.mockReset().mockImplementation(() => { throw new Error('no lspci'); });
        mockPlatform.mockReset().mockReturnValue('linux');
        mockArch.mockReset().mockReturnValue('x64');
        resetVendorCache();
    });

    // ── Basic detection (backward compat) ──────────────────────
    it('detectGpu returns false when no GPU devices exist', () => {
        expect(detectGpu()).toBe(false);
    });

    it('detectGpu returns true when /dev/nvidia0 exists', () => {
        mockExistsSync.mockImplementation((path: string) => path === '/dev/nvidia0');
        expect(detectGpu()).toBe(true);
    });

    it('detectGpu returns false when /dev/kfd exists but only iGPU (no rocm-smi, no discrete lspci)', () => {
        mockExistsSync.mockImplementation((path: string) => path === '/dev/kfd');
        mockExecSync.mockImplementation(() => { throw new Error('no rocm-smi'); });
        expect(detectGpu()).toBe(false);
    });

    it('detectGpu returns true when /dev/kfd exists with rocm-smi showing VRAM', () => {
        mockExistsSync.mockImplementation((path: string) => path === '/dev/kfd');
        mockExecSync.mockImplementation((cmd: string) => {
            if (cmd.includes('rocm-smi')) return 'VRAM Total Memory (B): 8589934592';
            throw new Error('not lspci');
        });
        expect(detectGpu()).toBe(true);
    });

    it('detectGpu returns true when /dev/kfd exists with discrete AMD GPU in lspci', () => {
        mockExistsSync.mockImplementation((path: string) => path === '/dev/kfd');
        mockExecSync.mockImplementation((cmd: string) => {
            if (cmd.includes('rocm-smi')) throw new Error('rocm-smi not found');
            return '03:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800]';
        });
        expect(detectGpu()).toBe(true);
    });

    it('detectGpu returns true when /dev/kfd exists with Radeon RX in lspci', () => {
        mockExistsSync.mockImplementation((path: string) => path === '/dev/kfd');
        mockExecSync.mockImplementation((cmd: string) => {
            if (cmd.includes('rocm-smi')) throw new Error('rocm-smi not found');
            return '03:00.0 VGA compatible controller: AMD Radeon RX 7900 XTX';
        });
        expect(detectGpu()).toBe(true);
    });

    it('detectGpu returns true when lspci shows NVIDIA GPU (no /dev/nvidia0)', () => {
        mockExecSync.mockReturnValue('00:02.0 VGA compatible controller: NVIDIA Corporation GA106');
        expect(detectGpu()).toBe(true);
    });

    it('detectGpu returns false when lspci shows no GPU', () => {
        mockExecSync.mockReturnValue('00:02.0 VGA compatible controller: Intel Corporation HD Graphics');
        expect(detectGpu()).toBe(false);
    });

    it('detectGpu returns false when lspci is not available', () => {
        mockExecSync.mockImplementation(() => { throw new Error('command not found'); });
        expect(detectGpu()).toBe(false);
    });

    it('detectGpu returns false for AMD APU with Barcelo iGPU', () => {
        mockExistsSync.mockImplementation((path: string) => path === '/dev/kfd');
        mockExecSync.mockImplementation((cmd: string) => {
            if (cmd.includes('rocm-smi')) throw new Error('rocm-smi not found');
            return '05:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Barcelo (rev c1)';
        });
        expect(detectGpu()).toBe(false);
    });

    // ── Vendor detection ───────────────────────────────────────
    it('detectGpuVendor returns nvidia for /dev/nvidia0', () => {
        mockExistsSync.mockImplementation((path: string) => path === '/dev/nvidia0');
        expect(detectGpuVendor()).toBe('nvidia');
    });

    it('detectGpuVendor returns amd for /dev/kfd with rocm-smi VRAM', () => {
        mockExistsSync.mockImplementation((path: string) => path === '/dev/kfd');
        mockExecSync.mockImplementation((cmd: string) => {
            if (cmd.includes('rocm-smi')) return 'VRAM Total Memory (B): 8589934592';
            throw new Error('not lspci');
        });
        expect(detectGpuVendor()).toBe('amd');
    });

    it('detectGpuVendor returns apple on macOS arm64', () => {
        mockPlatform.mockReturnValue('darwin');
        mockArch.mockReturnValue('arm64');
        expect(detectGpuVendor()).toBe('apple');
    });

    it('detectGpuVendor returns none when no GPU found', () => {
        mockExecSync.mockImplementation(() => { throw new Error('nothing'); });
        expect(detectGpuVendor()).toBe('none');
    });

    it('getGpuVendor returns the same as detectGpuVendor', () => {
        mockPlatform.mockReturnValue('darwin');
        mockArch.mockReturnValue('arm64');
        expect(getGpuVendor()).toBe('apple');
    });

    // ── Apple Silicon ──────────────────────────────────────────
    it('detectGpu returns true on Apple Silicon (macOS arm64)', () => {
        mockPlatform.mockReturnValue('darwin');
        mockArch.mockReturnValue('arm64');
        expect(detectGpu()).toBe(true);
    });

    it('detectGpu returns true on macOS Intel with Metal support', () => {
        mockPlatform.mockReturnValue('darwin');
        mockArch.mockReturnValue('x64');
        mockExecSync.mockImplementation((cmd: string) => {
            if (cmd.includes('system_profiler')) return 'Chipset Model: AMD Radeon Pro 5500M\nMetal Family: Supported, Metal GPUFamily macOS 2';
            throw new Error('no cmd');
        });
        expect(detectGpu()).toBe(true);
    });
});
