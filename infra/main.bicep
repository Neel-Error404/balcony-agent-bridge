targetScope = 'resourceGroup'

@description('Globally unique Service Bus namespace name.')
@minLength(6)
@maxLength(50)
param namespaceName string

@description('Azure region for the bridge resources.')
param location string = 'centralindia'

@description('Topic used for directed bridge messages.')
param topicName string = 'agent-messages'

param sysASubscriptionName string = 'sys-a'
param sysBSubscriptionName string = 'sys-b'

param sysAIdentityName string = 'id-balcony-agent-bridge-sys-a'
param sysBIdentityName string = 'id-balcony-agent-bridge-sys-b'

@description('Optional existing Log Analytics workspace resource ID.')
param diagnosticWorkspaceResourceId string = ''

@description('Maximum broker retention. Normal messages use a shorter per-message TTL.')
param maximumMessageTimeToLive string = 'P14D'

@description('Broker duplicate detection window.')
param duplicateDetectionWindow string = 'PT10M'

@description('PeekLock duration for each subscription.')
param lockDuration string = 'PT1M'

@minValue(1)
@maxValue(100)
param maxDeliveryCount int = 10

param tags object = {
  project: 'balcony-agent-bridge'
  managedBy: 'bicep'
  environment: 'shared'
}

var senderRoleDefinitionResourceId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39'
)
var receiverRoleDefinitionResourceId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0'
)

resource sysAIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: sysAIdentityName
  location: location
  tags: tags
}

resource sysBIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: sysBIdentityName
  location: location
  tags: tags
}

resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2026-01-01' = {
  name: namespaceName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    zoneRedundant: true
  }
}

resource topic 'Microsoft.ServiceBus/namespaces/topics@2026-01-01' = {
  parent: serviceBusNamespace
  name: topicName
  properties: {
    defaultMessageTimeToLive: maximumMessageTimeToLive
    duplicateDetectionHistoryTimeWindow: duplicateDetectionWindow
    enableBatchedOperations: true
    enableExpress: false
    enablePartitioning: false
    requiresDuplicateDetection: true
    status: 'Active'
    supportOrdering: true
  }
}

resource sysASubscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2026-01-01' = {
  parent: topic
  name: sysASubscriptionName
  properties: {
    deadLetteringOnFilterEvaluationExceptions: true
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: maximumMessageTimeToLive
    enableBatchedOperations: true
    lockDuration: lockDuration
    maxDeliveryCount: maxDeliveryCount
    requiresSession: true
    status: 'Active'
  }
}

resource sysBSubscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2026-01-01' = {
  parent: topic
  name: sysBSubscriptionName
  properties: {
    deadLetteringOnFilterEvaluationExceptions: true
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: maximumMessageTimeToLive
    enableBatchedOperations: true
    lockDuration: lockDuration
    maxDeliveryCount: maxDeliveryCount
    requiresSession: true
    status: 'Active'
  }
}

resource sysAFilter 'Microsoft.ServiceBus/namespaces/topics/subscriptions/rules@2024-01-01' = {
  parent: sysASubscription
  name: 'bridge-target'
  properties: {
    filterType: 'CorrelationFilter'
    correlationFilter: {
      requiresPreprocessing: false
      properties: {
        bridgeTarget: 'SYS-A'
      }
    }
  }
}

resource sysBFilter 'Microsoft.ServiceBus/namespaces/topics/subscriptions/rules@2024-01-01' = {
  parent: sysBSubscription
  name: 'bridge-target'
  properties: {
    filterType: 'CorrelationFilter'
    correlationFilter: {
      requiresPreprocessing: false
      properties: {
        bridgeTarget: 'SYS-B'
      }
    }
  }
}

resource sysASenderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(topic.id, sysAIdentity.id, senderRoleDefinitionResourceId)
  scope: topic
  properties: {
    principalId: sysAIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: senderRoleDefinitionResourceId
  }
}

resource sysBSenderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(topic.id, sysBIdentity.id, senderRoleDefinitionResourceId)
  scope: topic
  properties: {
    principalId: sysBIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: senderRoleDefinitionResourceId
  }
}

resource sysAReceiverRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(
    sysASubscription.id,
    sysAIdentity.id,
    receiverRoleDefinitionResourceId
  )
  scope: sysASubscription
  properties: {
    principalId: sysAIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: receiverRoleDefinitionResourceId
  }
}

resource sysBReceiverRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(
    sysBSubscription.id,
    sysBIdentity.id,
    receiverRoleDefinitionResourceId
  )
  scope: sysBSubscription
  properties: {
    principalId: sysBIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: receiverRoleDefinitionResourceId
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(diagnosticWorkspaceResourceId)) {
  name: 'balcony-agent-bridge-diagnostics'
  scope: serviceBusNamespace
  properties: {
    workspaceId: diagnosticWorkspaceResourceId
    logs: [
      {
        category: 'OperationalLogs'
        enabled: true
      }
      {
        category: 'DiagnosticErrorLogs'
        enabled: true
      }
    ]
  }
}

output createdNamespaceName string = serviceBusNamespace.name
output createdTopicName string = topic.name
output createdSubscriptionNames array = [
  sysASubscription.name
  sysBSubscription.name
]
output createdIdentityNames array = [
  sysAIdentity.name
  sysBIdentity.name
]
