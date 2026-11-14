import { randomUUID } from 'node:crypto';
import { prisma } from '../db.ts';
import { embed } from '../llm/provider.ts';
import { encode, decode } from 'gpt-tokenizer';

/**
 * Exactly 500-token chunks with a 50-token overlap, counted with the o200k tokenizer.
 * shortcut: embedding providers tokenize slightly differently; 500 stays well under every model's input limit.
 */
export function chunkText(text: string, chunkTokens = 500, overlapTokens = 50): string[] {
  const tokens = encode(text.replace(/\s+/g, ' ').trim());
  const step = chunkTokens - overlapTokens;
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += step) {
    chunks.push(decode(tokens.slice(i, i + chunkTokens)).trim());
    if (i + chunkTokens >= tokens.length) break;
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
