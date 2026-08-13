targetScope = 'subscription'

@description('Dedicated resource group for the bridge.')
param resourceGroupName string = 'rg-balcony-agent-bridge-ci'

param location string = 'centralindia'
param namespaceName string
param topicName string = 'agent-messages'
param diagnosticWorkspaceResourceId string = ''

param tags object = {
  project: 'balcony-agent-bridge'
  managedBy: 'bicep'
  environment: 'shared'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module bridge './main.bicep' = {
  name: 'balcony-agent-bridge'
  scope: resourceGroup
  params: {
    namespaceName: namespaceName
    location: location
    topicName: topicName
    diagnosticWorkspaceResourceId: diagnosticWorkspaceResourceId
    tags: tags
  }
}

output resourceGroupName string = resourceGroup.name
output namespaceName string = bridge.outputs.createdNamespaceName
output topicName string = bridge.outputs.createdTopicName
