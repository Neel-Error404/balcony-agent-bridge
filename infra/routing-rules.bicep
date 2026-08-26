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

@description('Existing Service Bus namespace name.')
param namespaceName string

@description('Existing bridge topic name.')
param topicName string = 'agent-messages'

@description('Approved static node inventory. Only nodeId and subscriptionName are used by this migration template.')
@minLength(1)
@maxLength(32)
param nodes nodeDefinition[]

resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2024-01-01' existing = {
  name: namespaceName
}

resource topic 'Microsoft.ServiceBus/namespaces/topics@2024-01-01' existing = {
  parent: serviceBusNamespace
  name: topicName
}

resource subscriptions 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2024-01-01' existing = [for (node, index) in nodes: {
  parent: topic
  name: node.subscriptionName
}]

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

// Disable the legacy named filter left by the original two-node topology.
// Incremental deployments cannot delete unmanaged child resources.
resource disabledLegacyTargetFilters 'Microsoft.ServiceBus/namespaces/topics/subscriptions/rules@2024-01-01' = [for (node, index) in nodes: {
  parent: subscriptions[index]
  name: 'bridge-target'
  properties: {
    filterType: 'SqlFilter'
    sqlFilter: {
      compatibilityLevel: 20
      requiresPreprocessing: false
      sqlExpression: '1 = 0'
    }
  }
}]

output configuredSubscriptionNames array = [for node in nodes: node.subscriptionName]
