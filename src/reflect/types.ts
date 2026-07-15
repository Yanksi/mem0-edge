import { z } from 'zod';

const NonEmptyString = z.string().trim().min(1);

export const ReflectRequestSchema = z.object({
  query: NonEmptyString.max(4000),
  user_id: NonEmptyString,
  agent_id: NonEmptyString,
});

export const ReflectUncertaintySchema = z.enum(['low', 'medium', 'high']);
export const GraphThinkingLevelSchema = z.enum(['low', 'medium', 'high']);
export const ReflectEvidenceRoleSchema = z.enum(['semantic_seed', 'graph_expansion']);

export const ReflectCandidateEvidenceSchema = z.object({
  id: NonEmptyString,
  memory: NonEmptyString,
  role: ReflectEvidenceRoleSchema,
});

export const GraphModelResponseSchema = z.object({
  answer: NonEmptyString,
  uncertainty: ReflectUncertaintySchema,
  evidence_ids: z.array(NonEmptyString).max(20),
  limitations: NonEmptyString.optional(),
});

export type ReflectRequest = z.infer<typeof ReflectRequestSchema>;
export type GraphModelResponse = z.infer<typeof GraphModelResponseSchema>;
export type GraphThinkingLevel = z.infer<typeof GraphThinkingLevelSchema>;
export type ReflectEvidenceRole = z.infer<typeof ReflectEvidenceRoleSchema>;
export type ReflectCandidateEvidence = z.infer<typeof ReflectCandidateEvidenceSchema>;
