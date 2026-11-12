import type { NodeTypes } from '@xyflow/react';
import { NODE_TYPES } from '../../lib/nodeTypes';
import { BaseNode } from './BaseNode';
import { LLMNode } from './LLMNode';
import { HttpNode } from './HttpNode';
import { TransformNode } from './TransformNode';
import { ConditionalNode } from './ConditionalNode';

// Integration and utility nodes share the base shell; the core four have their own entry points.
export const nodeTypes: NodeTypes = {
  ...Object.fromEntries(NODE_TYPES.map((m) => [m.type, BaseNode])),
  llm: LLMNode,
  http: HttpNode,
  transform: TransformNode,
  conditional: ConditionalNode,
};
