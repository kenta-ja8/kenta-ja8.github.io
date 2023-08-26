import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  schema: z.object({
    title: z.string(),
    createdAt: z
      .string()
      .or(z.date())
      .transform((val) => new Date(val)),
    updatedAt: z
      .string()
      .optional()
      .transform((str) => (str ? new Date(str) : undefined)),
    heroIcon: z.string(),
    category: z.array(z.string()),
    draft: z.boolean().optional(),
  }),
});

export const collections = { blog };
