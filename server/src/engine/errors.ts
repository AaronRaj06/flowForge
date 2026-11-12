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
  constructor(public nodeId: string, public cause: Error) {
    super(`Node ${nodeId} failed: ${cause.message}`);
    this.name = 'NodeExecutionError';
  }
}
