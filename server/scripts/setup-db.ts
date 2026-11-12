// `pre` runs before `prisma db push` (the vector column needs the extension);
// `post` adds the ANN index Prisma can't express.
import { prisma } from '../src/db.ts';

if (process.argv[2] === 'pre') {
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
} else {
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)');
  console.log('database ready');
}
await prisma.$disconnect();
