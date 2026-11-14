import { useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { usePipeline } from '../store/pipelineStore';
import { Button, Label, Modal, Textarea } from './ui';

const EXAMPLES = [
  'Every morning, read new rows from a Google Sheet, summarise each one with an LLM and post the summaries to Slack',
  'When a webhook arrives, classify the message as urgent or not; email urgent ones to me',
  'Answer the run input using my knowledge base and send the answer by email',
];

/** Plain English in, a ready-to-edit pipeline on the canvas out. */
export function AiBuildModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { load, nodes } = usePipeline();
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const build = async () => {
    if (nodes.length && !confirm('Replace the blocks on the canvas with the generated pipeline?')) return;
    setBusy(true);
    try {
      const { graph } = await api('/api/ai/generate', { method: 'POST', json: { description } });
      const name = description.length > 48 ? description.slice(0, 48).trim() + '…' : description;
      load({ id: null, name, graph });
      usePipeline.setState({ dirty: true });
      toast.success(`Built ${graph.nodes.length} blocks. Check the settings marked as placeholders, then Save.`);
      onOpenChange(false);
      setDescription('');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Build with AI" description="Describe the automation in plain English. The AI picks the blocks, wires them up and fills in their settings.">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          build();
        }}
      >
        <div>
          <Label htmlFor="ai-desc">What should it do?</Label>
          <Textarea id="ai-desc" rows={4} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder={EXAMPLES[0]} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="press rounded-full border border-line px-2.5 py-1 text-left text-[12px] text-muted hover:text-ink" onClick={() => setDescription(ex)}>
              {ex.length > 60 ? ex.slice(0, 60) + '…' : ex}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy} disabled={description.trim().length < 5}>
            Build pipeline
          </Button>
        </div>
      </form>
    </Modal>
  );
}
