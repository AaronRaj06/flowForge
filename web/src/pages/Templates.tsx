import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, errorMessage, useAuth } from '../lib/api';
import { Button, Input, Label, Modal, cx } from '../components/ui';
import { CATEGORIES } from '../components/SaveTemplateModal';

type Variable = { key: string; description: string; defaultValue: string };
type Template = { id: string; name: string; description: string | null; category: string; public: boolean; authorId: string; author: { email: string }; variables: Variable[]; nodeCount: number };

function UseTemplateModal({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (template) setValues(Object.fromEntries(template.variables.map((v) => [v.key, v.defaultValue ?? ''])));
  }, [template]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const { pipeline } = await api(`/api/templates/${template!.id}/use`, { method: 'POST', json: { variables: values } });
      navigate(`/p/${pipeline.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!template} onOpenChange={(o) => !o && onClose()} title={`Use “${template?.name ?? ''}”`} description={template?.variables.length ? 'Fill in the template’s variables. You can change them later on the canvas.' : 'This copies the template into a new pipeline you own.'}>
      <form onSubmit={submit} className="space-y-3.5">
        {template?.variables.map((v) => (
          <div key={v.key}>
            <Label htmlFor={`v-${v.key}`} hint={v.description}>
              <span className="font-mono">{v.key}</span>
            </Label>
            <Input id={`v-${v.key}`} required value={values[v.key] ?? ''} onChange={(e) => setValues({ ...values, [v.key]: e.target.value })} />
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Create pipeline
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Templates() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [category, setCategory] = useState<string>('All');
  const [using, setUsing] = useState<Template | null>(null);
  const userId = useAuth((s) => s.user?.id);

  const load = () => api<{ templates: Template[] }>('/api/templates').then((r) => setTemplates(r.templates)).catch((e) => (toast.error(errorMessage(e)), setTemplates([])));
  useEffect(() => {
    load();
  }, []);

  const remove = async (t: Template) => {
    if (!confirm(`Delete the template “${t.name}”?`)) return;
    await api(`/api/templates/${t.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
    load();
  };

  const shown = templates?.filter((t) => category === 'All' || t.category === category) ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold">Templates</h1>
          <p className="mt-1 text-[13px] text-muted">Start from a pipeline someone already built. Public templates plus your own private ones.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-sunken p-1" role="tablist" aria-label="Category">
          {['All', ...CATEGORIES].map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={category === c}
              onClick={() => setCategory(c)}
              className={cx('press rounded-md px-3 py-1 text-[13px] font-medium', category === c ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-muted hover:text-ink')}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {templates === null ? (
        <p className="text-[13px] text-faint">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong p-10 text-center">
          <p className="font-medium">No templates here yet</p>
          <p className="mt-1 text-[13px] text-muted">Build a pipeline, then use “Save as template” in the toolbar.</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((t) => (
            <li key={t.id} className="flex flex-col rounded-xl border border-line bg-surface p-4">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-faint">
                <span className="rounded bg-sunken px-1.5 py-0.5 text-muted">{t.category}</span>
                {!t.public && <span>Private</span>}
                <span className="ml-auto">{t.nodeCount} blocks</span>
              </div>
              <h2 className="text-[14px] font-semibold">{t.name}</h2>
              <p className="mt-1 line-clamp-3 flex-1 text-[13px] text-muted">{t.description || 'No description.'}</p>
              <p className="mt-3 truncate text-[12px] text-faint">by {t.author.email}</p>
              <div className="mt-3 flex gap-2">
                <Button variant="primary" className="flex-1" onClick={() => setUsing(t)}>
                  Use this
                </Button>
                {t.authorId === userId && (
                  <Button variant="danger" onClick={() => remove(t)}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <UseTemplateModal template={using} onClose={() => setUsing(null)} />
    </div>
  );
}
