/**
 * Social Media Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates all /api/social/* routes.
 */

import { Router, type Request, type Response } from 'express';
import logger from '../../utils/logger.js';

export function createSocialRouter(): Router {
  const router = Router();

  router.get('/social/state', async (_req, res) => {
    try {
      const { loadConfig } = await import('../../config/config.js');
      const { loadState, resetDailyCounters, CONTENT_ROTATION } = await import('../../skills/builtin/fb_autopilot.js');
      const { loadQueue } = await import('../../skills/builtin/facebook.js');
      const { getEpisodesBySource } = await import('../../memory/graph.js');
      const config = loadConfig();
      const fbConfig = (config as Record<string, unknown>).facebook as Record<string, unknown> | undefined;
      const state = loadState();
      resetDailyCounters(state);
      const queue = loadQueue();
      const pending = queue.posts.filter(p => p.status === 'pending');
      // Enrich recentPosts with Graphiti content when state file lacks it
      const graphPosts = getEpisodesBySource(['facebook_post', 'facebook_autopilot'], 20);
      const recentPosts = state.postHistory.slice(-20).reverse().map(h => {
        if (h.content) return h;
        // Try to find matching content in Graphiti by date proximity
        const match = graphPosts.find(g => g.createdAt.slice(0, 16) === h.date.slice(0, 16));
        return { ...h, content: match ? match.content : undefined };
      });
      res.json({
        autopilot: {
          enabled: fbConfig?.autopilotEnabled !== false,
          postsToday: state.postsToday,
          maxPostsPerDay: Number(fbConfig?.maxPostsPerDay ?? 6),
          repliesToday: state.repliesToday,
          lastPostAt: state.lastPostAt,
          nextContentType: CONTENT_ROTATION[state.contentIndex % CONTENT_ROTATION.length],
        },
        queue: pending,
        recentPosts,
      });
    } catch (e) {
      logger.error('SocialRouter', `Social state error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Failed to load social state' });
    }
  });

  router.post('/social/autopilot/toggle', async (req, res) => {
    try {
      const { loadConfig, updateConfig } = await import('../../config/config.js');
      const config = loadConfig();
      const enabled = !!(req.body as Record<string, unknown>).enabled;
      const fb = { ...((config as Record<string, unknown>).facebook as Record<string, unknown> || {}), autopilotEnabled: enabled } as Record<string, unknown>;
      updateConfig({ facebook: fb } as Partial<typeof config>);
      res.json({ enabled });
    } catch (e) {
      logger.error('SocialRouter', `Social toggle error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Failed to toggle autopilot' });
    }
  });

  router.post('/social/post', async (req, res) => {
    try {
      const { postToPage } = await import('../../skills/builtin/facebook.js');
      const content = String((req.body as Record<string, unknown>).content || '');
      if (!content || content.length < 5) { res.status(400).json({ error: 'Content too short' }); return; }
      const result = await postToPage(content, { source: 'manual:api' });
      if (result.success) {
        res.json({ success: true, postId: result.postId });
      } else if (result.skipped) {
        res.status(409).json({ success: false, skipped: result.skipped });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (e) {
      logger.error('SocialRouter', `Social post error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Failed to post' });
    }
  });

  router.post('/social/drafts/:id/approve', async (req, res) => {
    try {
      const { loadQueue, saveQueue, postToPage, hasApiAccess } = await import('../../skills/builtin/facebook.js') as any;
      const queue = loadQueue();
      const post = queue.posts.find((p: { id: string }) => p.id === req.params.id);
      if (!post) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (post.status !== 'pending') { res.status(409).json({ error: `Already ${post.status}` }); return; }
      if (hasApiAccess()) {
        const result = await postToPage(post.content, { source: 'queue:approved' });
        if (result.success) {
          post.status = 'posted';
          post.postedAt = new Date().toISOString();
          post.fbPostId = result.postId;
        } else {
          res.status(500).json({ error: result.error || 'Post failed' });
          return;
        }
      } else {
        post.status = 'approved';
      }
      saveQueue(queue);
      res.json({ success: true, status: post.status, postId: post.fbPostId });
    } catch (e) {
      logger.error('SocialRouter', `Draft approve error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Failed to approve draft' });
    }
  });

  router.post('/social/drafts/:id/reject', async (req, res) => {
    try {
      const { loadQueue, saveQueue } = await import('../../skills/builtin/facebook.js');
      const queue = loadQueue();
      const post = queue.posts.find(p => p.id === req.params.id);
      if (!post) { res.status(404).json({ error: 'Draft not found' }); return; }
      post.status = 'rejected';
      saveQueue(queue);
      res.json({ success: true });
    } catch (e) {
      logger.error('SocialRouter', `Draft reject error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Failed to reject draft' });
    }
  });

  router.get('/social/graph-context', async (_req, res) => {
    try {
      const { getEpisodesBySource } = await import('../../memory/graph.js');
      const recentPosts = getEpisodesBySource(['facebook_post', 'facebook_autopilot'], 5);
      const topics = recentPosts.map(ep => ({
        content: ep.content.slice(0, 200),
        date: ep.createdAt,
        entities: ep.entities,
      }));
      res.json({ recentTopics: topics });
    } catch (e) {
      logger.error('SocialRouter', `Social graph context error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Failed to load graph context' });
    }
  });

  return router;
}
