targetScope = 'resourceGroup'

@sealed()
type nodeDefinition = {
  @minLength(1)
  @maxLength(50)
  nodeId: string
  @minLength(1)
  @maxLength(50)
  subscriptionName: string
  principalId: string
}

@description('Globally unique Service Bus namespace name.')
@minLength(6)
@maxLength(50)
param namespaceName string

@description('Azure region for the bridge resources.')
param location string = 'centralindia'

@description('Topic used for directed bridge messages.')
param topicName string = 'agent-messages'

@description('Approved static node inventory. Each entry contains nodeId, subscriptionName, and the object ID of its existing Entra service principal.')
@minLength(1)
@maxLength(32)
param nodes nodeDefinition[]

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

resource subscriptions 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2026-01-01' = [for (node, index) in nodes: {
  parent: topic
  name: node.subscriptionName
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
}]

// Replacing the automatically created $Default rule prevents every node from
// receiving every message. Each subscription accepts only its exact node ID.
resource targetFilters 'Microsoft.ServiceBus/namespaces/topics/subscriptions/rules@2024-01-01' = [for (node, index) in nodes: {
  parent: subscriptions[index]
  name: '$Default'
  properties: {
    filterType: 'CorrelationFilter'
    correlationFilter: {
      requiresPreprocessing: false
      properties: {
        bridgeTarget: node.nodeId
      }
    }
  }
}]

resource senderRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (node, index) in nodes: {
  name: guid(topic.id, node.principalId, senderRoleDefinitionResourceId)
  scope: topic
  properties: {
    principalId: node.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: senderRoleDefinitionResourceId
  }
}]

resource receiverRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (node, index) in nodes: {
  name: guid(subscriptions[index].id, node.principalId, receiverRoleDefinitionResourceId)
  scope: subscriptions[index]
  properties: {
    principalId: node.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: receiverRoleDefinitionResourceId
  }
}]

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
output createdSubscriptionNames array = [for node in nodes: node.subscriptionName]
