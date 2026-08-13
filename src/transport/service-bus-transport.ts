import {
  ClientCertificateCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import {
  ServiceBusClient,
  ServiceBusError,
  RetryMode,
  type ServiceBusMessage,
  type ServiceBusSessionReceiver,
} from "@azure/service-bus";
import type { TokenCredential } from "@azure/core-auth";

import type { BridgeConfig } from "../config.js";
import { requireServiceBusNamespace } from "../config.js";
import type { BridgeEnvelope } from "../contracts/envelope.js";
import { ConfigurationError } from "../errors.js";
import type {
  BridgeTransport,
  InboundDelivery,
} from "./transport.js";

export class ServiceBusBridgeTransport implements BridgeTransport {
  private readonly client: ServiceBusClient;
  private readonly sender;

  public constructor(
    private readonly config: BridgeConfig,
    credential?: TokenCredential,
  ) {
    const azureCredential =
      credential ?? createServiceBusCredential(config);
    this.client = new ServiceBusClient(
      requireServiceBusNamespace(config),
      azureCredential,
      {
        identifier: `balcony-agent-bridge-${config.systemId.toLowerCase()}`,
        retryOptions: {
          maxRetries: 3,
          retryDelayInMs: 1000,
          maxRetryDelayInMs: 10_000,
          mode: RetryMode.Exponential,
        },
      },
    );
    this.sender = this.client.createSender(config.topicName, {
      identifier: `balcony-agent-bridge-sender-${config.systemId.toLowerCase()}`,
    });
  }

  public async send(envelope: BridgeEnvelope): Promise<void> {
    await this.sender.sendMessages(toServiceBusMessage(envelope));
  }

  public async receiveAvailable(
    handler: (delivery: InboundDelivery) => Promise<void>,
    options?: {
      maximumMessages?: number;
      maximumWaitTimeMs?: number;
      abortSignal?: AbortSignal;
    },
  ): Promise<number> {
    let receiver: ServiceBusSessionReceiver | undefined;
    try {
      receiver = await this.client.acceptNextSession(
        this.config.topicName,
        this.config.subscriptionName,
        {
          receiveMode: "peekLock",
          maxAutoLockRenewalDurationInMs: 5 * 60 * 1000,
          ...(options?.abortSignal
            ? { abortSignal: options.abortSignal }
            : {}),
        },
      );
      const messages = await receiver.receiveMessages(
        options?.maximumMessages ?? 10,
        {
          maxWaitTimeInMs: options?.maximumWaitTimeMs ?? 5000,
          ...(options?.abortSignal
            ? { abortSignal: options.abortSignal }
            : {}),
        },
      );
      for (const message of messages) {
        const delivery: InboundDelivery = {
          body: message.body,
          brokerMessageId: String(message.messageId ?? message.sequenceNumber),
          deliveryCount: message.deliveryCount ?? 0,
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          complete: async () => receiver!.completeMessage(message),
          abandon: async () => receiver!.abandonMessage(message),
          deadLetter: async (reason, description) =>
            receiver!.deadLetterMessage(message, {
              deadLetterReason: reason,
              deadLetterErrorDescription: description.slice(0, 2000),
            }),
        };
        await handler(delivery);
      }
      return messages.length;
    } catch (error) {
      if (
        error instanceof ServiceBusError &&
        (error.code === "ServiceTimeout" ||
          error.code === "SessionCannotBeLocked")
      ) {
        return 0;
      }
      throw error;
    } finally {
      await receiver?.close();
    }
  }

  public async close(): Promise<void> {
    await this.sender.close();
    await this.client.close();
  }
}

export function createServiceBusCredential(
  config: BridgeConfig,
): TokenCredential {
  if (config.azureAuthMode === "managed_identity") {
    if (!config.managedIdentityClientId) {
      throw new ConfigurationError(
        "BALCONY_MANAGED_IDENTITY_CLIENT_ID is required " +
          "when BALCONY_AZURE_AUTH_MODE is managed_identity",
      );
    }
    return new ManagedIdentityCredential(
      config.managedIdentityClientId,
    );
  }

  const missing = [
    ["BALCONY_AZURE_TENANT_ID", config.azureTenantId],
    ["BALCONY_AZURE_CLIENT_ID", config.azureClientId],
    [
      "BALCONY_AZURE_CLIENT_CERTIFICATE_PATH",
      config.azureClientCertificatePath,
    ],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } required when BALCONY_AZURE_AUTH_MODE is client_certificate`,
    );
  }

  return new ClientCertificateCredential(
    config.azureTenantId!,
    config.azureClientId!,
    config.azureClientCertificatePath!,
  );
}

export function toServiceBusMessage(
  envelope: BridgeEnvelope,
): ServiceBusMessage {
  const ttl = envelope.expires_at_utc
    ? Math.max(
        1000,
        Date.parse(envelope.expires_at_utc) -
          Date.parse(envelope.created_at_utc),
      )
    : undefined;
  return {
    body: envelope,
    messageId: envelope.message_id,
    sessionId: envelope.conversation_id,
    subject: envelope.kind,
    contentType: "application/json",
    applicationProperties: {
      bridgeTarget: envelope.target_system,
      schemaVersion: envelope.schema_version,
      streamId: envelope.stream_id,
    },
    ...(envelope.correlation_id
      ? { correlationId: envelope.correlation_id }
      : {}),
    ...(ttl !== undefined ? { timeToLive: ttl } : {}),
  };
}
