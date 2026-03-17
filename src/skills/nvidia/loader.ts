/**
 * TITAN — NVIDIA Skills Loader
 * Optional NVIDIA GPU-accelerated integrations: cuOpt, OpenShell, AI-Q, ASR.
 * Only loaded when TITAN_NVIDIA=1 env or nvidia.enabled=true in config.
 *
 * Licensed by NVIDIA Corporation under the NVIDIA Open Model License.
 */
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'NvidiaSkills';

export async function initNvidiaSkills(): Promise<void> {
    const config = loadConfig();
    const envEnabled = process.env.TITAN_NVIDIA === '1';
    const configEnabled = (config as Record<string, unknown>).nvidia &&
        ((config as Record<string, unknown>).nvidia as Record<string, unknown>).enabled === true;

    if (!envEnabled && !configEnabled) {
        logger.debug(COMPONENT, 'NVIDIA skills skipped (not enabled)');
        return;
    }

    logger.info(COMPONENT, 'Loading NVIDIA skills...');
    let loaded = 0;

    const nvidiaSkills = [
        ['nvidia_cuopt', () => import('./cuopt.js')],
        ['nvidia_aiq_research', () => import('./aiq_research.js')],
    ] as const;

    for (const [name, loader] of nvidiaSkills) {
        try {
            const mod = await (loader as () => Promise<{ register: () => void }>)();
            mod.register();
            loaded++;
        } catch (err) {
            logger.debug(COMPONENT, `NVIDIA skill "${name}" not loaded: ${(err as Error).message}`);
        }
    }

    if (loaded > 0) {
        logger.info(COMPONENT, `Loaded ${loaded} NVIDIA skill(s)`);
    }
}
