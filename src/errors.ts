export class BridgeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BridgeError";
  }
}

export class ConfigurationError extends BridgeError {
  public constructor(message: string) {
    super("CONFIGURATION_ERROR", message);
    this.name = "ConfigurationError";
  }
}

export class IdempotencyConflictError extends BridgeError {
  public constructor(idempotencyKey: string) {
    super(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key '${idempotencyKey}' is already associated with different message content`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export class StateTransitionError extends BridgeError {
  public constructor(message: string) {
    super("STATE_TRANSITION_ERROR", message);
    this.name = "StateTransitionError";
  }
}

export class DispatchConfigurationError extends BridgeError {
  public constructor(message: string, options?: ErrorOptions) {
    super("DISPATCH_CONFIGURATION_ERROR", message, options);
    this.name = "DispatchConfigurationError";
  }
}

export class DispatchRejectedError extends BridgeError {
  public constructor(message: string) {
    super("DISPATCH_REJECTED", message);
    this.name = "DispatchRejectedError";
  }
}

export class DispatchResultUnavailableError extends BridgeError {
  public constructor(message: string) {
    super("DISPATCH_RESULT_UNAVAILABLE", message);
    this.name = "DispatchResultUnavailableError";
  }
}

export class CodexExecutionError extends BridgeError {
  public constructor(
    code:
      | "CODEX_LAUNCH_FAILED"
      | "CODEX_EXIT_FAILED"
      | "CODEX_TIMED_OUT"
      | "CODEX_ABORTED"
      | "CODEX_TERMINATION_FAILED"
      | "CODEX_OUTPUT_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "CodexExecutionError";
  }
}
