export class CyclicDependencyError extends Error {
  constructor(public nodeIds: string[]) {
    super(`Pipeline has a cycle involving: ${nodeIds.join(', ')}`);
    this.name = 'CyclicDependencyError';
  }
}

export class MissingVariableError extends Error {
  constructor(public variable: string) {
    super(`Unknown variable {{${variable}}}`);
    this.name = 'MissingVariableError';
  }
}

export class InvalidGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGraphError';
  }
}

/** Integration token missing, revoked, or refresh failed — UI shows a reconnect prompt. */
export class AuthError extends Error {
  constructor(public provider: string, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class NodeExecutionError extends Error {
  /** Set by runPipeline: tokens spent before the failure. */
  tokensUsed?: number;
  constructor(public nodeId: string, public cause: Error, name?: string) {
    super(`${name || `Node ${nodeId}`} failed: ${cause.message}`);
    this.name = 'NodeExecutionError';
  }
}

/** Thrown by an approval block that has no decision yet: the run pauses until someone decides. */
export class ApprovalPending extends Error {
  /** Set by runPipeline so the run can resume from here. */
  context?: Record<string, any>;
  tokensUsed?: number;
  constructor(public nodeId: string, public request: string) {
    super(`Waiting for approval at ${nodeId}`);
    this.name = 'ApprovalPending';
  }
}
