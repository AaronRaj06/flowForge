import { Router } from 'express';
import multer from 'multer';
// The package root runs a debug self-test under ESM; the lib entry doesn't.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { prisma } from '../db.ts';
import { HttpError } from './http.ts';
import { ingest } from '../kb/knowledge.ts';

export const kbRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

kbRouter.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Attach a file in the "file" field');
  const name = file.originalname.slice(0, 200);
  const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(name);
  if (!isPdf && !/^text\//.test(file.mimetype) && !/\.(txt|md|markdown|csv)$/i.test(name)) {
    throw new HttpError(400, 'Upload a plain text, Markdown or PDF file');
  }
  let text: string;
  try {
    text = isPdf ? (await pdfParse(file.buffer)).text : file.buffer.toString('utf8');
  } catch {
    throw new HttpError(400, 'Could not read that PDF');
  }
  try {
    res.status(201).json({ sourceFile: name, chunks: await ingest(req.userId, name, text) });
  } catch (err) {
    if ((err as Error).message.startsWith('No readable text')) throw new HttpError(400, (err as Error).message);
    throw err;
  }
});

kbRouter.get('/', async (req, res) => {
  const groups = await prisma.knowledgeChunk.groupBy({
    by: ['sourceFile'],
    where: { userId: req.userId },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
  });
  res.json({ sources: groups.map((g) => ({ sourceFile: g.sourceFile, chunks: g._count._all, createdAt: g._max.createdAt })) });
});

kbRouter.delete('/:sourceFile', async (req, res) => {
  await prisma.knowledgeChunk.deleteMany({ where: { userId: req.userId, sourceFile: req.params.sourceFile } });
  res.status(204).end();
});
