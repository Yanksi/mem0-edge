import { Hono } from 'hono';
import type { Env, MemoryJob } from './env';
import { handleMemoryQueue } from './queue';
import { dashboardRoutes } from './routes/dashboard';
import { entitiesRoutes, relationshipsRoutes } from './routes/entities';
import { hermesRoutes } from './routes/hermes';
import { memoriesRoutes } from './routes/memories';

export const app = new Hono<{ Bindings: Env }>();

app.onError((_error, context) => context.json({ error: 'Internal server error' }, 500));
app.get('/health', (context) => context.json({ ok: true, service: 'mem0-edge' }));
app.route('/dashboard', dashboardRoutes);
app.route('/', hermesRoutes);
app.route('/v1/memories', memoriesRoutes);
app.route('/v1', hermesRoutes);
app.route('/v1/entities', entitiesRoutes);
app.route('/v1/relationships', relationshipsRoutes);

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<MemoryJob>, env: Env) => handleMemoryQueue(batch, env),
};
