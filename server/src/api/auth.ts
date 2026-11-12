import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.ts';
import { HttpError } from './http.ts';

declare module 'express-serve-static-core' {
  interface Request {
    userId: string;
  }
}

const SECRET = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
};

export const signToken = (userId: string) => jwt.sign({ sub: userId }, SECRET(), { expiresIn: '7d' });

export function verifyToken(token: string): string {
  try {
    const payload = jwt.verify(token, SECRET());
    if (typeof payload === 'string' || !payload.sub) throw new Error();
    return payload.sub;
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
}

/** Bearer header; `?token=` is accepted only where browsers can't set headers (EventSource, OAuth popups). */
export function requireAuth(opts: { allowQueryToken?: boolean } = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const token = header ?? (opts.allowQueryToken ? (req.query.token as string | undefined) : undefined);
    if (!token) throw new HttpError(401, 'Sign in required');
    req.userId = verifyToken(token);
    next();
  };
}

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, 'An account with that email already exists');
  const user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 10) } });
  res.status(201).json({ token: signToken(user.id), user: { id: user.id, email } });
});

authRouter.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(String(req.body?.password ?? ''), user.passwordHash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  res.json({ token: signToken(user.id), user: { id: user.id, email } });
});

authRouter.get('/me', requireAuth(), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, email: true } });
  if (!user) throw new HttpError(401, 'Account no longer exists');
  res.json({ user });
});
