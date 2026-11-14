import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Upload, FileText } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { Button } from '../components/ui';

type Source = { sourceFile: string; chunks: number; createdAt: string };

export function Knowledge() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api<{ sources: Source[] }>('/api/kb').then((r) => setSources(r.sources)).catch(() => setSources([]));
  useEffect(() => {
    load();
  }, []);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api('/api/kb/upload', { method: 'POST', body: form });
      toast.success(`Added ${r.chunks} chunk${r.chunks === 1 ? '' : 's'} from ${file.name}`);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (s: Source) => {
    await api(`/api/kb/${encodeURIComponent(s.sourceFile)}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
    load();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-[20px] font-semibold">Knowledge base</h1>
      <p className="mt-1 mb-6 text-[13px] text-muted">
        Upload text or PDF files. They’re split into 500-token chunks and embedded, so a <span className="font-medium text-ink">KB Query</span> block can pull the most relevant passages into an LLM prompt.
      </p>

      <label
        className="press flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center hover:border-ink"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) upload(f);
        }}
      >
        <Upload size={18} className="text-muted" />
        <span className="text-[13px] font-medium">{uploading ? 'Embedding…' : 'Drop a .txt, .md or .pdf file, or click to choose'}</span>
        <span className="text-[12px] text-faint">Up to 10 MB</span>
        <input ref={fileRef} type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" className="sr-only" disabled={uploading} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </label>

      <h2 className="mt-8 mb-2 text-[13px] font-medium text-muted">Sources</h2>
      {sources === null ? (
        <p className="text-[13px] text-faint">Loading…</p>
      ) : sources.length === 0 ? (
        <p className="text-[13px] text-faint">Nothing uploaded yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {sources.map((s) => (
            <li key={s.sourceFile} className="flex items-center gap-3 px-4 py-2.5">
              <FileText size={15} className="text-muted" />
              <span className="flex-1 truncate text-[13px]">{s.sourceFile}</span>
              <span className="text-[12px] text-faint tabular-nums">{s.chunks} chunks</span>
              <Button size="sm" variant="ghost" onClick={() => remove(s)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
