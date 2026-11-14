import { useEffect } from 'react';
import { useAuth } from '../lib/api';
import { usePipeline } from '../store/pipelineStore';

/** Streams node events for the active run and mirrors them into the store. */
export function useRunStream(onDone?: (status: string, error?: string) => void) {
  const runId = usePipeline((s) => s.run.runId);
  // A run waiting for approval keeps its stream open, so a decision made elsewhere (email, Slack) shows up live.
  const running = usePipeline((s) => s.run.status === 'running' || s.run.status === 'WAITING');
  const token = useAuth((s) => s.token);

  useEffect(() => {
    if (!runId || !running || !token) return;
    const es = new EventSource(`/api/runs/${runId}/stream?token=${encodeURIComponent(token)}`);
    const { setNodeStatus, finishRun, resumeRun } = usePipeline.getState();

    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      if (e.type === 'node') {
        setNodeStatus(e.nodeId, { status: e.status, output: e.output, error: e.error ?? undefined, tokens: e.tokens || undefined });
      } else if (e.type === 'resumed') {
        resumeRun();
      } else if (e.type === 'done') {
        finishRun({ status: e.status, error: e.error ?? undefined, output: e.output, waiting: e.waiting });
        onDone?.(e.status, e.error);
        if (e.status !== 'WAITING') es.close();
      }
    };
    // EventSource retries on its own; the server replays the snapshot on reconnect.
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, running, token]);
}
