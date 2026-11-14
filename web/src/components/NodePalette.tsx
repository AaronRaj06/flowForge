import { useReactFlow } from '@xyflow/react';
import { NODE_TYPES } from '../lib/nodeTypes';
import { usePipeline } from '../store/pipelineStore';
import { DRAG_TYPE } from './Canvas';

const GROUPS = ['Core', 'Integrations', 'Knowledge'] as const;

export function NodePalette() {
  const addNode = usePipeline((s) => s.addNode);
  const { screenToFlowPosition, setCenter, getZoom } = useReactFlow();

  // Keyboard / click fallback for drag-and-drop: place the block to the right of the selected
  // (or last) block so it never covers it, or at the canvas centre on an empty canvas.
  const addAtCentre = (type: string) => {
    const { nodes, selectedId } = usePipeline.getState();
    const anchor = nodes.find((n) => n.id === selectedId) ?? nodes.at(-1);
    let p: { x: number; y: number };
    if (anchor) {
      p = { x: anchor.position.x + 300, y: anchor.position.y };
      while (nodes.some((n) => Math.abs(n.position.x - p.x) < 260 && Math.abs(n.position.y - p.y) < 110)) p.y += 140;
    } else {
      const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
      const c = canvas ? screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 }) : { x: 0, y: 0 };
      p = { x: c.x - 120, y: c.y - 30 };
    }
    addNode(type, p);
    if (anchor) setCenter(p.x + 120, p.y + 40, { zoom: getZoom(), duration: 200 });
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
