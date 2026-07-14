import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const record = z.record(z.unknown());

export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: nonEmptyString,
});

export const AddMemoryRequestSchema = z.object({
  request_id: nonEmptyString.optional(),
  messages: z.array(MessageSchema).min(1),
  user_id: nonEmptyString,
  agent_id: nonEmptyString.optional(),
  run_id: nonEmptyString.optional(),
  actor_id: nonEmptyString.optional(),
  metadata: record.default({}),
  infer: z.boolean().default(true),
  async: z.boolean().default(false),
});

export const SearchMemoryRequestSchema = z.object({
  query: z.string(),
  user_id: nonEmptyString.optional(),
  agent_id: nonEmptyString.optional(),
  run_id: z.string().optional(),
  actor_id: z.string().optional(),
  limit: z.number().int().positive().max(50).default(10),
  filters: record.default({}),
}).refine((request) => request.user_id !== undefined || request.agent_id !== undefined, {
  message: 'Either user_id or agent_id is required',
});

export const HermesSearchRequestSchema = z.object({
  query: z.string(),
  top_k: z.number().int().positive().max(50).default(10),
  filters: z.object({
    user_id: nonEmptyString,
    agent_id: nonEmptyString.optional(),
    run_id: nonEmptyString.optional(),
    actor_id: nonEmptyString.optional(),
  }).passthrough(),
});

export const UpdateMemoryRequestSchema = z.object({
  memory: nonEmptyString.optional(),
  metadata: record.optional(),
}).refine((request) => request.memory !== undefined || request.metadata !== undefined, {
  message: 'Either memory or metadata is required',
});

export const MemoryResponseSchema = z.object({
  id: z.string(),
  memory: z.string(),
  user_id: z.string().optional(),
  agent_id: z.string().optional(),
  run_id: z.string().optional(),
  actor_id: z.string().optional(),
  score: z.number().optional(),
  metadata: record,
  created_at: z.string(),
  updated_at: z.string(),
});

export type AddMemoryRequest = z.infer<typeof AddMemoryRequestSchema>;
export type SearchMemoryRequest = z.infer<typeof SearchMemoryRequestSchema>;
export type HermesSearchRequest = z.infer<typeof HermesSearchRequestSchema>;
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequestSchema>;
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;

export type MemoryDecision =
  | { action: 'ADD'; memory: string }
  | { action: 'UPDATE'; id: string; memory: string }
  | { action: 'DELETE'; id: string }
  | { action: 'NONE'; id?: string; memory?: string };

export interface ExistingMemoryForMerge {
  id: string;
  memory: string;
}
