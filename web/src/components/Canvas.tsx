import { useCallback, type DragEvent } from 'react';
import { ReactFlow, Background, Controls, MiniMap, useReactFlow, BackgroundVariant, type OnSelectionChangeParams } from '@xyflow/react';
import { usePipeline } from '../store/pipelineStore';
import { nodeTypes } from './nodes';
import { META } from '../lib/nodeTypes';

export const DRAG_TYPE = 'application/x-flowforge-node';

const MINIMAP_COLORS: Record<string, string> = {
  running: '#2f7cf6',
  success: '#1f9d55',
  error: '#d93636',
  auth_error: '#d93636',
};

export function Canvas() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, select } = usePipeline();
  const { screenToFlowPosition } = useReactFlow();

  // Must be stable: React Flow re-subscribes (and re-fires) when this identity changes.
  const onSelectionChange = useCallback(
    ({ nodes: sel }: OnSelectionChangeParams) => {
      const id = sel.length === 1 ? sel[0].id : null;
      if (usePipeline.getState().selectedId !== id) select(id);
    },
    [select],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = e.dataTransfer.getData(DRAG_TYPE);
      if (!META[type]) return;
      e.preventDefault();
      // Centre the 240px-wide node under the cursor.
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNode(type, { x: p.x - 120, y: p.y - 30 });
    },
    [screenToFlowPosition, addNode],
  );

  return (
    <div className="relative h-full" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onNodeClick={() => usePipeline.getState().focusBlock()}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#d6d5ce" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(n) => MINIMAP_COLORS[(n.data as any).status] ?? '#cfcdc5'}
          maskColor="rgb(246 246 243 / 0.7)"
        />
      </ReactFlow>
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="max-w-xs text-center">
            <p className="text-[15px] font-medium">Drag a block onto the canvas</p>
            <p className="mt-1 text-[13px] text-muted">Start with an LLM block, then connect blocks from right handle to left handle.</p>
          </div>
        </div>
      )}
    </div>
  );
}
