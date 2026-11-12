import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import * as Tabs from '@radix-ui/react-tabs';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { usePipeline } from '../store/pipelineStore';
import { useRunStream } from '../hooks/useRunStream';
import { Canvas } from '../components/Canvas';
import { NodePalette } from '../components/NodePalette';
import { ConfigPanel } from '../components/ConfigPanel';
import { RunPanel } from '../components/RunPanel';
import { PipelineList } from '../components/PipelineList';
import { Toolbar } from '../components/Toolbar';

export function Builder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const load = usePipeline((s) => s.load);
  const selectedId = usePipeline((s) => s.selectedId);
  const [tab, setTab] = useState<'block' | 'run'>('block');

  useEffect(() => {
    if (!id) return load({ id: null, name: 'Untitled pipeline', graph: { nodes: [], edges: [] } });
    if (usePipeline.getState().pipelineId === id) return; // just saved; keep canvas state
    api(`/api/pipelines/${id}`)
      .then(({ pipeline }) => load({ id: pipeline.id, name: pipeline.name, graph: pipeline.graph }))
      .catch((e) => {
        toast.error(errorMessage(e));
        navigate('/', { replace: true });
      });
  }, [id, load, navigate]);

  useEffect(() => {
    if (selectedId) setTab('block');
  }, [selectedId]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (usePipeline.getState().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useRunStream((status, error) => {
    if (status === 'SUCCESS') toast.success('Run finished');
    else if (status === 'CANCELLED') toast('Run cancelled');
    else toast.error(error ?? 'Run failed');
  });

  const tabClass =
    'press flex-1 border-b-2 border-transparent py-2.5 text-[13px] font-medium text-muted data-[state=active]:border-ink data-[state=active]:text-ink';

  return (
    <ReactFlowProvider>
      <div className="flex min-h-0 flex-1 flex-col">
        <Toolbar onRunStarted={() => setTab('run')} />
        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 space-y-6 overflow-y-auto border-r border-line bg-surface p-3">
            <NodePalette />
            <PipelineList />
          </aside>
          <main className="min-w-0 flex-1">
            <Canvas />
          </main>
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-surface">
            <Tabs.Root value={tab} onValueChange={(v) => setTab(v as 'block' | 'run')}>
              <Tabs.List className="sticky top-0 z-10 flex border-b border-line bg-surface px-4" aria-label="Side panel">
                <Tabs.Trigger value="block" className={tabClass}>Block</Tabs.Trigger>
                <Tabs.Trigger value="run" className={tabClass}>Run</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="block" className="focus:outline-none">
                <ConfigPanel />
              </Tabs.Content>
              <Tabs.Content value="run" className="focus:outline-none">
                <RunPanel />
              </Tabs.Content>
            </Tabs.Root>
          </aside>
        </div>
      </div>
    </ReactFlowProvider>
  );
}
