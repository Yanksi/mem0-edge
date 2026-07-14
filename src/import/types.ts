import { z } from 'zod';

const sourceTimestamp = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  'Expected a valid date string',
);

export const RawMemoryMigrationItem = z.object({
  memory: z.string().refine((value) => value.trim().length > 0, 'Memory must not be empty'),
  created_at: sourceTimestamp.nullable().optional(),
  updated_at: sourceTimestamp.nullable().optional(),
});

export const RawMemoryMigrationExport = z.object({
  memories: z.array(RawMemoryMigrationItem).min(1),
});

export const DashboardMem0ImportRequest = z.object({
  user_id: z.string().trim().min(1),
  export: RawMemoryMigrationExport,
});

export type RawMemoryMigrationItem = z.infer<typeof RawMemoryMigrationItem>;
export type RawMemoryMigrationExport = z.infer<typeof RawMemoryMigrationExport>;
