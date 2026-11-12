import type { NodeProps } from '@xyflow/react';
import type { PipelineNode } from '../../store/pipelineStore';
import { BaseNode } from './BaseNode';

export const ConditionalNode = (props: NodeProps<PipelineNode>) => <BaseNode {...props} />;
