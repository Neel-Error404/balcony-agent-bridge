targetScope = 'subscription'

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

@description('Dedicated resource group for the bridge.')
param resourceGroupName string = 'rg-balcony-agent-bridge-ci'

param location string = 'centralindia'
param namespaceName string
param topicName string = 'agent-messages'
param diagnosticWorkspaceResourceId string = ''

@description('Approved static node inventory forwarded to the bridge resource module.')
@minLength(1)
@maxLength(32)
param nodes nodeDefinition[]

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
    nodes: nodes
    diagnosticWorkspaceResourceId: diagnosticWorkspaceResourceId
    tags: tags
  }
}

output resourceGroupName string = resourceGroup.name
output namespaceName string = bridge.outputs.createdNamespaceName
output topicName string = bridge.outputs.createdTopicName
