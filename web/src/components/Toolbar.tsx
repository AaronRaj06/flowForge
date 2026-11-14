import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Play, Save, Rocket, LayoutTemplate, Plus, Square, Sparkles, Eye } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { usePipeline } from '../store/pipelineStore';
import { parseRunInput, useRunInput } from './RunPanel';
import { Button } from './ui';
import { SaveTemplateModal } from './SaveTemplateModal';
import { DeployModal } from './DeployModal';
import { AiBuildModal } from './AiBuildModal';

export function Toolbar({ onRunStarted }: { onRunStarted: () => void }) {
  const { name, setName, dirty, pipelineId, run, getPipelineJSON, markSaved, startRun, nodes, role, teamId, setTeam } = usePipeline();
  const viewer = role === 'viewer';
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [modal, setModal] = useState<'template' | 'deploy' | 'ai' | null>(null);

  const save = async () => {
    setSaving(true);
    try {
      const body = { name, graph: getPipelineJSON() };
      const { pipeline } = pipelineId
        ? await api(`/api/pipelines/${pipelineId}`, { method: 'PUT', json: body })
        : await api('/api/pipelines', { method: 'POST', json: body });
      markSaved(pipeline.id);
      if (!pipelineId) navigate(`/p/${pipeline.id}`, { replace: true });
      toast.success('Pipeline saved');
      return pipeline.id as string;
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!nodes.length) return toast.error('Add a block before running');
    setStarting(true);
    try {
      const { runId } = await api('/api/runs', {
        method: 'POST',
        json: { graph: getPipelineJSON(), input: parseRunInput(useRunInput.getState().input), pipelineId },
      });
      startRun(runId);
      onRunStarted();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  // Teams you can put pipelines in (editor or owner).
  const [teams, setTeams] = useState<{ id: string; name: string; role: string }[]>([]);
  useEffect(() => {
    api<{ teams: { id: string; name: string; role: string }[] }>('/api/teams').then((r) => setTeams(r.teams.filter((t) => t.role !== 'viewer'))).catch(() => {});
  }, []);
  const moveTo = async (to: string) => {
    try {
      await api(`/api/pipelines/${pipelineId}`, { method: 'PUT', json: { teamId: to || null } });
      setTeam(to || null);
      toast.success(to ? `Moved to ${teams.find((t) => t.id === to)?.name}` : 'Moved to your personal workspace');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const cancel = () => run.runId && api(`/api/runs/${run.runId}/cancel`, { method: 'POST' }).catch(() => {});
  const running = run.status === 'running';

  return (
    <div className="flex h-12 items-center gap-2 border-b border-line bg-surface px-3">
      <input
        aria-label="Pipeline name"
        value={name}
        readOnly={viewer}
        onChange={(e) => setName(e.target.value)}
        className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[14px] font-semibold hover:bg-sunken focus:bg-sunken focus:outline-none"
      />
      {viewer ? (
        <span className="flex items-center gap-1 rounded bg-sunken px-2 py-1 text-[12px] text-muted" title="You’re a viewer in this pipeline’s team: you can look, but not change, run or deploy it.">
          <Eye size={13} /> View only
        </span>
      ) : (
        dirty && <span className="text-[12px] text-faint">Unsaved changes</span>
      )}
      {pipelineId && !viewer && (teams.length > 0 || teamId) && (
        <select aria-label="Workspace" value={teamId ?? ''} onChange={(e) => moveTo(e.target.value)} className="h-8 rounded-md border border-line bg-surface px-2 text-[12px] text-muted">
          <option value="">Personal</option>
          {teamId && !teams.some((t) => t.id === teamId) && <option value={teamId}>Team</option>}
          {teams.map((t) => (
            <option key={t.id} value={t.id}>Team: {t.name}</option>
          ))}
        </select>
      )}
      <Button
        variant="ghost"
        title="New pipeline"
        onClick={() => {
          if (dirty && !window.confirm('Discard unsaved changes and start a new pipeline?')) return;
          // Load directly too: navigating to "/" while already on "/" would not reset the canvas.
          usePipeline.getState().load({ id: null, name: 'Untitled pipeline', graph: { nodes: [], edges: [] } });
          navigate('/');
        }}
      >
        <Plus size={14} /> New
      </Button>
      {!viewer && <>
      <Button onClick={() => setModal('ai')} title="Describe a pipeline in plain English">
        <Sparkles size={14} /> Build with AI
      </Button>
      <Button onClick={save} loading={saving}>
        <Save size={14} /> Save
      </Button>
      <Button onClick={() => setModal('template')} disabled={!nodes.length}>
        <LayoutTemplate size={14} /> Save as template
      </Button>
      <Button
        onClick={async () => {
          if (!pipelineId || dirty) {
            const id = await save();
            if (!id) return;
          }
          setModal('deploy');
        }}
        disabled={!nodes.length}
      >
        <Rocket size={14} /> Deploy
      </Button>
      {running ? (
        <Button variant="danger" onClick={cancel} title="Stops the run before its next block">
          <Square size={12} /> Cancel run
        </Button>
      ) : (
        <Button variant="primary" onClick={runNow} loading={starting}>
          <Play size={14} /> Run
        </Button>
      )}
      </>}

      <AiBuildModal open={modal === 'ai'} onOpenChange={(o) => setModal(o ? 'ai' : null)} />
      <SaveTemplateModal open={modal === 'template'} onOpenChange={(o) => setModal(o ? 'template' : null)} />
      {pipelineId && <DeployModal open={modal === 'deploy'} onOpenChange={(o) => setModal(o ? 'deploy' : null)} pipelineId={pipelineId} />}
    </div>
  );
}
