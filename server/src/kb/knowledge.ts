import { randomUUID } from 'node:crypto';
import { prisma } from '../db.ts';
import { embed } from '../llm/provider.ts';

/**
 * ~500-token chunks with 50-token overlap.
 * shortcut: approximates tokens as 0.75 words; swap in a real tokenizer if chunk sizes must be exact.
 */
export function chunkText(text: string, chunkTokens = 500, overlapTokens = 50): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const size = Math.round(chunkTokens * 0.75);
  const step = size - Math.round(overlapTokens * 0.75);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + size).join(' '));
    if (i + size >= words.length) break;
  }
  return chunks;
}

const toVector = (v: number[]) => `[${v.join(',')}]`;

/** Replaces any earlier upload with the same file name. */
export async function ingest(userId: string, sourceFile: string, text: string) {
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('No readable text found in the file');
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += 64) vectors.push(...(await embed(chunks.slice(i, i + 64))));

  await prisma.$transaction([
    prisma.knowledgeChunk.deleteMany({ where: { userId, sourceFile } }),
    ...chunks.map((chunk, i) =>
      prisma.$executeRaw`INSERT INTO knowledge_chunks (id, "userId", "sourceFile", "chunkText", embedding, "createdAt")
        VALUES (${randomUUID()}, ${userId}, ${sourceFile}, ${chunk}, ${toVector(vectors[i])}::vector, now())`,
    ),
  ]);
  return chunks.length;
}

export async function search(userId: string, query: string, k = 5) {
  const [vector] = await embed([query]);
  return prisma.$queryRaw<{ chunkText: string; sourceFile: string; distance: number }[]>`
    SELECT "chunkText", "sourceFile", embedding <=> ${toVector(vector)}::vector AS distance
    FROM knowledge_chunks WHERE "userId" = ${userId}
    ORDER BY distance LIMIT ${k}`;
}
