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
