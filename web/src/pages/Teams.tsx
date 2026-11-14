import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Users } from 'lucide-react';
import { api, errorMessage, useAuth } from '../lib/api';
import { Button, Input, Label, Select, cx } from '../components/ui';

type TeamRow = { id: string; name: string; role: string; members: number; pipelines: number };
type Team = {
  id: string;
  name: string;
  role: string;
  dailyTokenBudget: number | null;
  tokensToday: number;
  members: { userId: string; email: string; role: string }[];
  pipelines: { id: string; name: string }[];
};
type Event = { id: string; action: string; detail: any; createdAt: string; by: string; team: string | null };

const ROLE_HINT: Record<string, string> = {
  owner: 'Manages members, roles and the quota',
  editor: 'Edits, runs and deploys team pipelines',
  viewer: 'Sees pipelines and runs, changes nothing',
};

/** One readable line per audit event. */
function describe(e: Event) {
  const d = e.detail ?? {};
  const map: Record<string, string> = {
    'team.create': `created the team “${d.name}”`,
    'team.update': d.dailyTokenBudget !== undefined ? `set the daily token budget to ${d.dailyTokenBudget === null ? 'no limit' : Number(d.dailyTokenBudget).toLocaleString()}` : `renamed the team to “${d.name}”`,
    'member.add': `added ${d.email} as ${d.role}`,
    'member.role': `changed ${d.email} from ${d.from} to ${d.to}`,
    'member.remove': `removed ${d.email}`,
    'member.leave': 'left the team',
    'pipeline.create': `created pipeline “${d.name}”`,
    'pipeline.update': (d.changed ?? []).includes('teamId') ? `moved “${d.name}” between workspaces` : `updated “${d.name}” (${(d.changed ?? []).join(', ') || 'no changes'})`,
    'pipeline.delete': `deleted pipeline “${d.name}”`,
    'run.start': `ran “${d.pipeline}”`,
    'deployment.create': `deployed “${d.pipeline}” as ${d.type}`,
    'deployment.pause': `paused a ${d.type} deployment`,
    'deployment.resume': `resumed a ${d.type} deployment`,
    'deployment.delete': `deleted a ${d.type} deployment`,
    'approval.approve': 'approved a paused run',
    'approval.reject': 'rejected a paused run',
    'credential.create': `saved credential “${d.name}”`,
    'credential.delete': 'deleted a credential',
  };
  return map[e.action] ?? e.action;
}

function TeamDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const me = useAuth((s) => s.user);
  const [team, setTeam] = useState<Team | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [invite, setInvite] = useState({ email: '', role: 'editor' });
  const [budget, setBudget] = useState('');
  const load = () => {
    api<{ team: Team }>(`/api/teams/${id}`).then((r) => (setTeam(r.team), setBudget(r.team.dailyTokenBudget ? String(r.team.dailyTokenBudget) : ''))).catch((e) => toast.error(errorMessage(e)));
    api<{ events: Event[] }>(`/api/audit?teamId=${id}&limit=50`).then((r) => setEvents(r.events)).catch(() => {});
  };
  useEffect(load, [id]);
  if (!team) return <p className="text-[13px] text-faint">Loading…</p>;
  const owner = team.role === 'owner';

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      load();
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[16px] font-semibold">{team.name}</h2>
        <span className="text-[12px] text-muted">You’re {team.role === 'owner' ? 'an owner' : `a ${team.role}`}</span>
      </div>

      <section>
        <h3 className="mb-2 text-[13px] font-medium text-muted">Members</h3>
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {team.members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="flex-1 truncate">{m.email}{m.userId === me?.id && <span className="text-faint"> (you)</span>}</span>
              {owner ? (
<div className="w-28 shrink-0">
                <Select aria-label={`Role of ${m.email}`} value={m.role} onChange={(e) => act(() => api(`/api/teams/${id}/members/${m.userId}`, { method: 'PATCH', json: { role: e.target.value } }), `${m.email} is now ${e.target.value}`)}>
                  <option value="owner">Owner</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </Select>
                </div>
              ) : (
                <span className="text-[12px] text-muted capitalize">{m.role}</span>
              )}
              {(owner || m.userId === me?.id) && (
                <Button size="sm" variant="ghost" onClick={() => act(() => api(`/api/teams/${id}/members/${m.userId}`, { method: 'DELETE' }), m.userId === me?.id ? 'You left the team' : `Removed ${m.email}`)}>
                  {m.userId === me?.id ? 'Leave' : 'Remove'}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {owner && (
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => api(`/api/teams/${id}/members`, { method: 'POST', json: invite }), `Added ${invite.email}`).then(() => setInvite({ ...invite, email: '' }));
            }}
          >
            <div className="min-w-0 flex-1">
              <Label htmlFor="invite-email" hint="They need a Flowforge account already.">Add a member by email</Label>
              <Input id="invite-email" type="email" value={invite.email} placeholder="teammate@example.com" onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            </div>
<div className="w-28 shrink-0">
            <Select aria-label="Role for the new member" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
              <option value="owner">Owner</option>
            </Select>
            </div>
            <Button type="submit" variant="primary" disabled={!invite.email.trim()}>Add</Button>
          </form>
        )}
        <p className="mt-2 text-[12px] text-faint">{Object.entries(ROLE_HINT).map(([r, h]) => `${r[0].toUpperCase() + r.slice(1)}: ${h.toLowerCase()}`).join(' · ')}</p>
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-medium text-muted">Daily token budget</h3>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-[13px]">
            <span className="font-semibold tabular-nums">{team.tokensToday.toLocaleString()}</span> tokens used today by team pipelines
            {team.dailyTokenBudget ? <> of <span className="tabular-nums">{team.dailyTokenBudget.toLocaleString()}</span></> : ' (no team limit)'}.
          </p>
          {owner && (
            <form className="mt-3 flex items-end gap-2" onSubmit={(e) => (e.preventDefault(), act(() => api(`/api/teams/${id}`, { method: 'PATCH', json: { dailyTokenBudget: budget ? Number(budget) : null } }), 'Budget saved'))}>
              <div className="w-48">
                <Label htmlFor="team-budget" hint="Runs of team pipelines stop once it’s used. Empty = no limit.">Limit per day</Label>
                <Input id="team-budget" type="number" min={1000} value={budget} placeholder="No limit" onChange={(e) => setBudget(e.target.value)} />
              </div>
              <Button type="submit">Save budget</Button>
            </form>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-medium text-muted">Pipelines</h3>
        {team.pipelines.length === 0 ? (
          <p className="text-[13px] text-faint">None yet. Open a pipeline and pick this team in the Workspace menu next to its name.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {team.pipelines.map((p) => (
              <li key={p.id}><Link to={`/p/${p.id}`} className="block rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] hover:border-ink">{p.name}</Link></li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-medium text-muted">Activity</h3>
        {events.length === 0 ? (
          <p className="text-[13px] text-faint">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3 px-4 py-2 text-[13px]">
                <span className="min-w-0 flex-1"><span className="font-medium">{e.by}</span> {describe(e)}</span>
                <time className="shrink-0 text-[12px] text-faint tabular-nums" dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      {owner && (
        <Button variant="danger" onClick={() => act(() => api(`/api/teams/${id}`, { method: 'DELETE' }), 'Team deleted; its pipelines went back to their creators')}>
          Delete team
        </Button>
      )}
    </div>
  );
}

export function Teams() {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const load = () =>
    api<{ teams: TeamRow[] }>('/api/teams')
      .then((r) => {
        setTeams(r.teams);
        setSelected((s) => (s && r.teams.some((t) => t.id === s) ? s : r.teams[0]?.id ?? null));
      })
      .catch(() => setTeams([]));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { team } = await api('/api/teams', { method: 'POST', json: { name } });
      setName('');
      setSelected(team.id);
      toast.success(`Created ${team.name}`);
      load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="text-[20px] font-semibold">Teams</h1>
      <p className="mt-1 mb-6 text-[13px] text-muted">Share pipelines with a team. Owners manage members and the team’s token budget; editors build, run and deploy; viewers can look.</p>
      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <div className="space-y-3">
          {teams === null ? (
            <p className="text-[13px] text-faint">Loading…</p>
          ) : teams.length === 0 ? (
            <p className="text-[13px] text-faint">You’re not in a team yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {teams.map((t) => (
                <li key={t.id}>
                  <button onClick={() => setSelected(t.id)} className={cx('press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-sunken', selected === t.id ? 'bg-sunken font-medium text-ink' : 'text-muted')}>
                    <Users size={14} />
                    <span className="flex-1 truncate">{t.name}</span>
                    <span className="text-[11px] text-faint">{t.members}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={create} className="space-y-2">
            <Label htmlFor="team-name">New team</Label>
            <Input id="team-name" value={name} placeholder="Support team" onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="primary" disabled={!name.trim()} className="w-full">Create team</Button>
          </form>
        </div>
        <div>{selected ? <TeamDetail key={selected} id={selected} onChanged={load} /> : <p className="text-[13px] text-faint">Create a team to get started.</p>}</div>
      </div>
    </div>
  );
}
