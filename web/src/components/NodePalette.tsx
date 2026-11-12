import { useReactFlow } from '@xyflow/react';
import { NODE_TYPES } from '../lib/nodeTypes';
import { usePipeline } from '../store/pipelineStore';
import { DRAG_TYPE } from './Canvas';

const GROUPS = ['Core', 'Integrations', 'Knowledge'] as const;

export function NodePalette() {
  const addNode = usePipeline((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();

  // Keyboard / click fallback for drag-and-drop: drop near the canvas centre.
  const addAtCentre = (type: string) => {
    const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
    const p = canvas ? screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 }) : { x: 0, y: 0 };
    const jitter = (usePipeline.getState().nodes.length % 5) * 24;
    addNode(type, { x: p.x - 120 + jitter, y: p.y - 30 + jitter });
  };

  return (
    <div className="space-y-4">
      {GROUPS.map((g) => (
        <section key={g}>
          <h3 className="mb-1.5 px-1 text-[11px] font-medium tracking-wide text-faint uppercase">{g}</h3>
          <ul className="space-y-0.5">
            {NODE_TYPES.filter((m) => m.group === g).map((m) => (
              <li key={m.type}>
                <button
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, m.type);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => addAtCentre(m.type)}
                  title="Drag onto the canvas, or click to add"
                  className="press flex w-full cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink hover:bg-sunken active:cursor-grabbing"
                >
                  <m.icon size={15} className="text-muted" />
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
