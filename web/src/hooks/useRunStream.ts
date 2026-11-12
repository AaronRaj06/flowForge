import { useEffect } from 'react';
import { useAuth } from '../lib/api';
import { usePipeline } from '../store/pipelineStore';

/** Streams node events for the active run and mirrors them into the store. */
export function useRunStream(onDone?: (status: string, error?: string) => void) {
  const runId = usePipeline((s) => s.run.runId);
  const running = usePipeline((s) => s.run.status === 'running');
  const token = useAuth((s) => s.token);

  useEffect(() => {
    if (!runId || !running || !token) return;
    const es = new EventSource(`/api/runs/${runId}/stream?token=${encodeURIComponent(token)}`);
    const { setNodeStatus, finishRun } = usePipeline.getState();

    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      if (e.type === 'node') {
        setNodeStatus(e.nodeId, { status: e.status, output: e.output, error: e.error ?? undefined });
      } else if (e.type === 'done') {
        finishRun({ status: e.status, error: e.error ?? undefined, output: e.output });
        onDone?.(e.status, e.error);
        es.close();
      }
    };
    // EventSource retries on its own; the server replays the snapshot on reconnect.
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, running, token]);
}
