import { useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { usePipeline } from '../store/pipelineStore';
import { Button, Input, Label, Modal, Select, Textarea } from './ui';

export const CATEGORIES = ['Productivity', 'Marketing', 'Dev', 'Other'];

export function SaveTemplateModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const pipelineName = usePipeline((s) => s.name);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Productivity');
  const [isPublic, setPublic] = useState(true);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { template } = await api('/api/templates', {
        method: 'POST',
        json: { name: name || pipelineName, description, category, public: isPublic, graph: usePipeline.getState().getPipelineJSON() },
      });
      const vars = template.variables.length;
      toast.success(`Template saved${vars ? ` with ${vars} variable${vars > 1 ? 's' : ''}` : ''}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Save as template" description="API keys and tokens are removed. Placeholders that don’t point at a block become fill-in variables.">
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <Label htmlFor="t-name">Name</Label>
          <Input id="t-name" value={name} placeholder={pipelineName} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="t-desc">Description</Label>
          <Textarea id="t-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-16" placeholder="What does this pipeline do?" />
        </div>
        <div>
          <Label htmlFor="t-cat">Category</Label>
          <Select id="t-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </div>
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
          <span>
            <span className="block text-[13px] font-medium">Public</span>
            <span className="block text-[12px] text-muted">List it in the template gallery for everyone.</span>
          </span>
          <Switch.Root
            checked={isPublic}
            onCheckedChange={setPublic}
            className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors duration-150 data-[state=checked]:bg-accent"
          >
            <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-150 ease-[var(--ease-out)] data-[state=checked]:translate-x-[18px]" />
          </Switch.Root>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            Save template
          </Button>
        </div>
      </form>
    </Modal>
  );
}
