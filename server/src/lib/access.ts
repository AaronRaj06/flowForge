import type { Prisma } from '@prisma/client';
import { prisma } from '../db.ts';
import { HttpError } from '../api/http.ts';

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: Role[] = ['owner', 'editor', 'viewer'];
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** Pipelines a user can see: their own, and those of every team they belong to. */
export const visiblePipelines = (userId: string): Prisma.PipelineWhereInput => ({
  OR: [{ userId }, { team: { members: { some: { userId } } } }],
});

/** Pipelines a user may run or change: their own, and team pipelines where they're an editor or owner. */
export const editablePipelines = (userId: string): Prisma.PipelineWhereInput => ({
  OR: [{ userId }, { team: { members: { some: { userId, role: { in: ['owner', 'editor'] } } } } }],
});

/**
 * Loads a pipeline the user may use at the given level. The creator always has full access;
 * team members get their team role. Unknown and invisible pipelines look the same (404).
 */
export async function accessPipeline(id: string, userId: string, need: 'view' | 'edit' = 'edit') {
  const found = await prisma.pipeline
    .findUnique({ where: { id }, include: { team: { select: { members: { where: { userId }, select: { role: true } } } } } })
    .catch(() => null);
  const role: Role | undefined = found?.userId === userId ? 'owner' : (found?.team?.members[0]?.role as Role | undefined);
  if (!found || !role) throw new HttpError(404, 'Pipeline not found');
  if (need === 'edit' && RANK[role] < RANK.editor) throw new HttpError(403, 'Viewers can look at this pipeline but not change, run or deploy it');
  const { team: _, ...pipeline } = found;
  return { ...pipeline, role };
}

/** The user's role in a team, or 404 if they're not a member; 403 if below the role needed. */
export async function teamRole(teamId: string, userId: string, need: Role = 'viewer'): Promise<Role> {
  const m = await prisma.membership.findUnique({ where: { teamId_userId: { teamId, userId } } }).catch(() => null);
  if (!m) throw new HttpError(404, 'Team not found');
  if (RANK[m.role as Role] < RANK[need]) throw new HttpError(403, `Only team ${need}s can do that`);
  return m.role as Role;
}

/** Records an audit event; never fails the request it describes. */
export async function audit(userId: string, action: string, opts: { teamId?: string | null; targetType?: string; targetId?: string; detail?: Record<string, unknown> } = {}) {
  await prisma.auditEvent
    .create({ data: { userId, action, teamId: opts.teamId ?? null, targetType: opts.targetType, targetId: opts.targetId, detail: (opts.detail ?? undefined) as Prisma.InputJsonValue | undefined } })
    .catch((e) => console.error('audit write failed:', e.message));
}
