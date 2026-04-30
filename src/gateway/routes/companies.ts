import { Router } from 'express';
import { logger } from '../../utils/logger.js';

const COMPONENT = 'companies-router';

export function createCompaniesRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const { listCompanies, getActiveRunners } = await import('../../agent/company.js');
      const includeArchived = _req.query.archived === 'true';
      const companies = listCompanies(includeArchived);
      const runners = getActiveRunners();
      res.json({ companies: companies.map(c => ({ ...c, runnerActive: runners.includes(c.id) })) });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/', async (req, res) => {
    try {
      const { createCompany } = await import('../../agent/company.js');
      const company = createCompany(req.body);
      res.json(company);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const { getCompany, isRunnerActive } = await import('../../agent/company.js');
      const company = getCompany(req.params.id);
      if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
      res.json({ ...company, runnerActive: isRunnerActive(company.id) });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const { updateCompany } = await import('../../agent/company.js');
      const company = updateCompany(req.params.id, req.body);
      if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
      res.json(company);
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const { deleteCompany, stopCompanyRunner } = await import('../../agent/company.js');
      stopCompanyRunner(req.params.id);
      const ok = deleteCompany(req.params.id);
      res.json({ success: ok });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // Start/stop company heartbeat runner
  router.post('/:id/start', async (req, res) => {
    try {
      const { startCompanyRunner } = await import('../../agent/company.js');
      const interval = parseInt(req.body?.intervalMs || '60000', 10);
      const ok = startCompanyRunner(req.params.id, interval);
      res.json({ success: ok, message: ok ? 'Runner started' : 'Already running or company not active' });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      const { stopCompanyRunner } = await import('../../agent/company.js');
      const ok = stopCompanyRunner(req.params.id);
      res.json({ success: ok });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // Add agent/goal to company
  router.post('/:id/agents', async (req, res) => {
    try {
      const { addAgentToCompany } = await import('../../agent/company.js');
      const agent = addAgentToCompany(req.params.id, req.body);
      if (!agent) { res.status(404).json({ error: 'Company not found' }); return; }
      res.json(agent);
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/:id/goals', async (req, res) => {
    try {
      const { addGoalToCompany } = await import('../../agent/company.js');
      const goal = addGoalToCompany(req.params.id, req.body);
      if (!goal) { res.status(404).json({ error: 'Company not found' }); return; }
      res.json(goal);
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // Company Portability (Export/Import)
  router.post('/:id/export', async (req, res) => {
    try {
      const { getCompany } = await import('../../agent/company.js');
      const { writeCompanyPackage } = await import('../../agent/companyPortability.js');
      const company = getCompany(req.params.id);
      if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
      const outPath = writeCompanyPackage(company, req.body?.outDir);
      res.json({ success: true, path: outPath, name: company.name });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/exports', async (_req, res) => {
    try {
      const { listExportedPackages } = await import('../../agent/companyPortability.js');
      res.json(listExportedPackages());
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/import', async (req, res) => {
    try {
      const { importCompanyFromDirectory, importCompanyFromMarkdown } = await import('../../agent/companyPortability.js');
      const { createCompany } = await import('../../agent/company.js');
      let imported = null;
      if (req.body?.packagePath) {
        imported = importCompanyFromDirectory(req.body.packagePath);
      } else if (req.body?.markdown) {
        imported = importCompanyFromMarkdown(req.body.markdown);
      }
      if (!imported) { res.status(400).json({ error: 'Invalid import. Provide packagePath or markdown.' }); return; }
      const company = createCompany(imported);
      res.json({ success: true, company });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  return router;
}
