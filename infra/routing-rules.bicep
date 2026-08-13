targetScope = 'resourceGroup'

@description('Existing Service Bus namespace name.')
param namespaceName string

@description('Existing bridge topic name.')
param topicName string = 'agent-messages'

@description('Existing SYS-A subscription name.')
param sysASubscriptionName string = 'sys-a'

@description('Existing SYS-B subscription name.')
param sysBSubscriptionName string = 'sys-b'

resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2024-01-01' existing = {
  name: namespaceName
}

resource topic 'Microsoft.ServiceBus/namespaces/topics@2024-01-01' existing = {
  parent: serviceBusNamespace
  name: topicName
}

resource sysASubscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2024-01-01' existing = {
  parent: topic
  name: sysASubscriptionName
}

resource sysBSubscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2024-01-01' existing = {
  parent: topic
  name: sysBSubscriptionName
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
