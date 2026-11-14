import { Router } from 'express';
import { prisma } from '../db.ts';
import { HttpError } from './http.ts';
import { audit, ROLES, teamRole, type Role } from '../lib/access.ts';
import { teamTokensUsedToday } from '../runs/create.ts';

/** Team workspaces: members share the team's pipelines with owner / editor / viewer roles. */
export const teamsRouter = Router();

const parseRole = (r: unknown): Role => {
  if (!ROLES.includes(r as Role)) throw new HttpError(400, 'role must be owner, editor or viewer');
  return r as Role;
};
const parseBudget = (v: unknown) => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1000 || n > 100_000_000) throw new HttpError(400, 'dailyTokenBudget must be a whole number from 1,000 to 100,000,000');
  return n;
};

/** Refuse changes that would leave a team without an owner. */
async function assertAnotherOwner(teamId: string, leavingUserId: string) {
  const owners = await prisma.membership.count({ where: { teamId, role: 'owner', userId: { not: leavingUserId } } });
  if (!owners) throw new HttpError(400, 'A team needs at least one owner; make someone else owner first');
}

teamsRouter.get('/', async (req, res) => {
  const rows = await prisma.membership.findMany({
    where: { userId: req.userId },
    include: { team: { include: { _count: { select: { members: true, pipelines: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ teams: rows.map((m) => ({ id: m.team.id, name: m.team.name, role: m.role, members: m.team._count.members, pipelines: m.team._count.pipelines })) });
});

teamsRouter.post('/', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 60) throw new HttpError(400, 'Give the team a name (up to 60 characters)');
  const team = await prisma.team.create({ data: { name, members: { create: { userId: req.userId, role: 'owner' } } } });
  await audit(req.userId, 'team.create', { teamId: team.id, targetType: 'team', targetId: team.id, detail: { name } });
  res.status(201).json({ team: { ...team, role: 'owner' } });
});

teamsRouter.get('/:id', async (req, res) => {
  const role = await teamRole(req.params.id, req.userId);
  const team = await prisma.team.findUniqueOrThrow({
    where: { id: req.params.id },
    include: { members: { include: { user: { select: { email: true } } }, orderBy: { createdAt: 'asc' } }, pipelines: { select: { id: true, name: true }, orderBy: { updatedAt: 'desc' } } },
  });
  res.json({
    team: {
      id: team.id,
      name: team.name,
      role,
      dailyTokenBudget: team.dailyTokenBudget,
      tokensToday: await teamTokensUsedToday(team.id),
      members: team.members.map((m) => ({ userId: m.userId, email: m.user.email, role: m.role })),
      pipelines: team.pipelines,
    },
  });
});

teamsRouter.patch('/:id', async (req, res) => {
  await teamRole(req.params.id, req.userId, 'owner');
  const data: { name?: string; dailyTokenBudget?: number | null } = {};
  if (req.body?.name !== undefined) {
    data.name = String(req.body.name).trim();
    if (!data.name || data.name.length > 60) throw new HttpError(400, 'Give the team a name (up to 60 characters)');
  }
  if (req.body?.dailyTokenBudget !== undefined) data.dailyTokenBudget = parseBudget(req.body.dailyTokenBudget);
  const team = await prisma.team.update({ where: { id: req.params.id }, data });
  await audit(req.userId, 'team.update', { teamId: team.id, targetType: 'team', targetId: team.id, detail: data });
  res.json({ team });
});

teamsRouter.delete('/:id', async (req, res) => {
  await teamRole(req.params.id, req.userId, 'owner');
  // Pipelines go back to their creators' personal workspaces (Pipeline.teamId is SET NULL).
  await prisma.team.delete({ where: { id: req.params.id } });
  await audit(req.userId, 'team.delete', { targetType: 'team', targetId: req.params.id });
  res.status(204).end();
});

teamsRouter.post('/:id/members', async (req, res) => {
  await teamRole(req.params.id, req.userId, 'owner');
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const role = parseRole(req.body?.role ?? 'editor');
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new HttpError(404, 'No Flowforge account uses that email; ask them to sign up first');
  if (await prisma.membership.findUnique({ where: { teamId_userId: { teamId: req.params.id, userId: user.id } } })) throw new HttpError(409, `${email} is already in this team`);
  await prisma.membership.create({ data: { teamId: req.params.id, userId: user.id, role } });
  await audit(req.userId, 'member.add', { teamId: req.params.id, targetType: 'user', targetId: user.id, detail: { email, role } });
  res.status(201).json({ member: { userId: user.id, email, role } });
});

teamsRouter.patch('/:id/members/:userId', async (req, res) => {
  await teamRole(req.params.id, req.userId, 'owner');
  const role = parseRole(req.body?.role);
  const m = await prisma.membership.findUnique({ where: { teamId_userId: { teamId: req.params.id, userId: req.params.userId } }, include: { user: { select: { email: true } } } });
  if (!m) throw new HttpError(404, 'Member not found');
  if (m.role === 'owner' && role !== 'owner') await assertAnotherOwner(req.params.id, m.userId);
  await prisma.membership.update({ where: { teamId_userId: { teamId: m.teamId, userId: m.userId } }, data: { role } });
  await audit(req.userId, 'member.role', { teamId: m.teamId, targetType: 'user', targetId: m.userId, detail: { email: m.user.email, from: m.role, to: role } });
  res.json({ member: { userId: m.userId, email: m.user.email, role } });
});

// Owners remove anyone; any member can remove themselves (leave).
teamsRouter.delete('/:id/members/:userId', async (req, res) => {
  const self = req.params.userId === req.userId;
  await teamRole(req.params.id, req.userId, self ? 'viewer' : 'owner');
  const m = await prisma.membership.findUnique({ where: { teamId_userId: { teamId: req.params.id, userId: req.params.userId } }, include: { user: { select: { email: true } } } });
  if (!m) throw new HttpError(404, 'Member not found');
  if (m.role === 'owner') await assertAnotherOwner(req.params.id, m.userId);
  await prisma.membership.delete({ where: { teamId_userId: { teamId: m.teamId, userId: m.userId } } });
  await audit(req.userId, self ? 'member.leave' : 'member.remove', { teamId: m.teamId, targetType: 'user', targetId: m.userId, detail: { email: m.user.email } });
  res.status(204).end();
});

/** Activity feed: a team's events (members only), or without teamId your own events everywhere. */
export const auditRouter = Router();

auditRouter.get('/', async (req, res) => {
  const teamId = req.query.teamId ? String(req.query.teamId) : null;
  if (teamId) await teamRole(teamId, req.userId);
  const events = await prisma.auditEvent.findMany({
    where: teamId ? { teamId } : { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(req.query.limit) || 100, 500),
    include: { user: { select: { email: true } }, team: { select: { name: true } } },
  });
  res.json({ events: events.map((e) => ({ id: e.id, action: e.action, targetType: e.targetType, targetId: e.targetId, detail: e.detail, createdAt: e.createdAt, by: e.user.email, team: e.team?.name ?? null })) });
});
