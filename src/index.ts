import { Hono } from 'hono';
import type { Env, MemoryJob } from './env';
import { dispatchPendingMem0Imports } from './import/service';
import { handleMemoryQueue } from './queue';
import { dispatchPendingMemoryUpdates } from './memory/update-mutations';
import { dashboardRoutes } from './routes/dashboard';
import { entitiesRoutes, relationshipsRoutes } from './routes/entities';
import { hermesRoutes } from './routes/hermes';
import { memoriesRoutes } from './routes/memories';
import { reflectRoutes } from './routes/reflect';

export const app = new Hono<{ Bindings: Env }>();

app.onError((_error, context) => context.json({ error: 'Internal server error' }, 500));
app.get('/health', (context) => context.json({ ok: true, service: 'mem0-edge' }));
app.route('/dashboard', dashboardRoutes);
app.route('/', hermesRoutes);
app.route('/v1/memories', memoriesRoutes);
app.route('/v1', hermesRoutes);
app.route('/v1/entities', entitiesRoutes);
app.route('/v1/relationships', relationshipsRoutes);
app.route('/v1/reflect', reflectRoutes);

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<MemoryJob>, env: Env) => handleMemoryQueue(batch, env),
  scheduled: (_controller: ScheduledController, env: Env, context: ExecutionContext) => {
    context.waitUntil(Promise.all([
      dispatchPendingMem0Imports(env),
      dispatchPendingMemoryUpdates(env),
    ]).then(() => undefined));
  },
};
