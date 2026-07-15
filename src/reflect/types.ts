import { z } from 'zod';

const NonEmptyString = z.string().trim().min(1);

export const ReflectRequestSchema = z.object({
  query: NonEmptyString.max(4000),
  user_id: NonEmptyString,
  agent_id: NonEmptyString,
});

export const ReflectUncertaintySchema = z.enum(['low', 'medium', 'high']);
export const GraphThinkingLevelSchema = z.enum(['low', 'medium', 'high']);
const GraphEntityRefSchema = z.string().regex(/^E[1-9]\d*$/);
const GraphRelationRefSchema = z.string().regex(/^R[1-9]\d*$/);

export const GraphEntitySchema = z.object({
  ref: GraphEntityRefSchema,
  name: NonEmptyString,
  type: NonEmptyString,
}).strict();

export const GraphRelationSchema = z.object({
  ref: GraphRelationRefSchema,
  source: GraphEntityRefSchema,
  predicate: NonEmptyString,
  target: GraphEntityRefSchema,
  confidence: z.number().optional(),
}).strict();

export const GraphReflectionInputSchema = z.object({
  query: NonEmptyString.max(4000),
  entities: z.array(GraphEntitySchema),
  relations: z.array(GraphRelationSchema),
}).strict().superRefine((graph, context) => {
  const entityRefs = new Set<string>();
  graph.entities.forEach((entity, index) => {
    if (entityRefs.has(entity.ref)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entities', index, 'ref'],
        message: 'Entity references must be unique',
      });
    }
    entityRefs.add(entity.ref);
  });

  const relationRefs = new Set<string>();
  graph.relations.forEach((relation, index) => {
    if (relationRefs.has(relation.ref)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relations', index, 'ref'],
        message: 'Relation references must be unique',
      });
    }
    relationRefs.add(relation.ref);

    if (!entityRefs.has(relation.source)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relations', index, 'source'],
        message: 'Relation source must reference an entity',
      });
    }
    if (!entityRefs.has(relation.target)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relations', index, 'target'],
        message: 'Relation target must reference an entity',
      });
    }
  });
});

export const GraphReflectionResultSchema = z.object({
  result: NonEmptyString.max(4000),
  evidence_relation_refs: z.array(GraphRelationRefSchema).min(1).max(32)
    .refine((refs) => new Set(refs).size === refs.length, 'Relation references must be unique'),
}).strict();

export type ReflectRequest = z.infer<typeof ReflectRequestSchema>;
export type GraphThinkingLevel = z.infer<typeof GraphThinkingLevelSchema>;
export type GraphReflectionInput = z.infer<typeof GraphReflectionInputSchema>;
export type GraphReflectionResult = z.infer<typeof GraphReflectionResultSchema>;
