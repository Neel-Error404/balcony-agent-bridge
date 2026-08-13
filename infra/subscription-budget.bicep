targetScope = 'subscription'

@description('Monthly budget name.')
param budgetName string = 'balcony-agent-bridge-monthly'

@description('Resource group containing only the bridge resources.')
param bridgeResourceGroupName string

@description('Monthly cost budget in the billing currency.')
@minValue(1)
param amount int = 15

@description('Budget start date on the first day of a month, for example 2026-08-01.')
param startDate string

@description('Budget end date, for example 2031-08-01.')
param endDate string

@description('Owner-approved notification email addresses. Supply only at deployment time.')
param contactEmails array

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: budgetName
  properties: {
    amount: amount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
      endDate: endDate
    }
    filter: {
      dimensions: {
        name: 'ResourceGroupName'
        operator: 'In'
        values: [
          bridgeResourceGroupName
        ]
      }
    }
    notifications: {
      Actual50Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      Actual80Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      Actual100Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
    }
  }
}
