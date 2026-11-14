import { Router } from 'express';
import { prisma } from '../db.ts';
import { encrypt } from '../lib/crypto.ts';
import { CREDENTIAL_TYPES } from '../integrations/keyed/index.ts';
import { HttpError } from './http.ts';

/** One place for the API keys key-based blocks use. Secrets go in, never come back out. */
export const credentialsRouter = Router();
const fields = { id: true, name: true, type: true, createdAt: true } as const;

credentialsRouter.get('/', async (req, res) => {
  const credentials = await prisma.credential.findMany({ where: { userId: req.userId }, select: fields, orderBy: { createdAt: 'desc' } });
  res.json({ credentials, types: Object.fromEntries(Object.entries(CREDENTIAL_TYPES).map(([k, v]) => [k, { label: v.label, secret: v.secret }])) });
});

credentialsRouter.post('/', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const type = String(req.body?.type ?? '');
  const secret = String(req.body?.secret ?? '').trim();
  const t = CREDENTIAL_TYPES[type];
  if (!t) throw new HttpError(400, `type must be one of ${Object.keys(CREDENTIAL_TYPES).join(', ')}`);
  if (!name || name.length > 60) throw new HttpError(400, 'Give the credential a name (up to 60 characters)');
  if (!t.check.test(secret)) throw new HttpError(400, `That doesn’t look like a ${t.label} ${t.secret.toLowerCase()}`);
  if (await prisma.credential.findFirst({ where: { userId: req.userId, name } })) throw new HttpError(409, `You already have a credential called “${name}”`);
  const credential = await prisma.credential.create({ data: { userId: req.userId, name, type, secret: encrypt(secret) }, select: fields });
  res.status(201).json({ credential });
});

credentialsRouter.delete('/:id', async (req, res) => {
  const { count } = await prisma.credential.deleteMany({ where: { id: req.params.id, userId: req.userId } });
  if (!count) throw new HttpError(404, 'Credential not found');
  res.status(204).end();
});
