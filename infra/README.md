# Azure Infrastructure

The recommended deployment creates a dedicated Central India Service Bus
Standard namespace. The namespace uses Microsoft Entra authentication only,
with one topic and one session-enabled filtered subscription per approved node.

## Approval Boundary

Do not deploy these templates until the owner approves:

- Azure subscription and resource group.
- Namespace name and Central India placement.
- The complete node-to-subscription-to-Entra-principal inventory.
- Service Bus sender and receiver role assignments.
- Public Microsoft Entra-authenticated networking.
- Existing Log Analytics workspace, if diagnostics are enabled.
- The USD 15 monthly budget and notification recipients.

The template does not create identities. Each node entry supplies the object ID
of an existing, separately approved Microsoft Entra service principal. The
template grants that principal sender access to the topic and receiver access
only to its own subscription. Principal IDs are not credentials, but the
node-to-principal mapping is security-sensitive and must be reviewed in full.
The what-if wrappers reject malformed or duplicate node IDs, subscription
names, and principal IDs before invoking Azure CLI.

Each subscription replaces its effective `$Default` rule with an exact
`bridgeTarget` correlation filter. This prevents the default true filter from
delivering every topic message to every node.
For an existing deployment, `routing-rules.bicep` also disables the legacy
named `bridge-target` rule so an incremental update cannot leave the old route
active.

Environment-specific workspace IDs, resource IDs, VM mappings, client IDs, and
email addresses must remain in untracked machine-local configuration.

## Safe Sequence

1. Install or make available a pinned Bicep CLI.
2. Run local Bicep lint and build checks for `deploy.bicep`, `main.bicep`,
   `routing-rules.bicep`, and the budget.
3. Copy `example.parameters.json` to an ignored machine-local parameter file.
4. Run subscription `what-if` for `deploy.bicep`.
5. Review every create and role-assignment operation.
6. Deploy the Service Bus template only after approval.
7. Run a separate subscription-scope budget `what-if`.
8. Deploy the budget only after approval.
9. Run the bounded live Azure integration suite.

The matching subscription-scope preview for `example.parameters.json` is:

```powershell
$env:BALCONY_SYSTEM_ID = "node-a"
$location = "centralindia"
$parameters = "C:\absolute\ignored\bridge.parameters.json"
.\scripts\Invoke-BridgeSubscriptionWhatIf.ps1 `
  -Location $location `
  -ParameterFile $parameters
```

After the owner approves that exact preview, the corresponding incremental
deployment command is:

```powershell
az deployment sub create `
  --location $location `
  --template-file .\infra\deploy.bicep `
  --parameters "@$parameters"
```

Budget parameters contain owner contact emails and must be a separate ignored
file. Preview and, only after separate approval, deploy it with:

```powershell
$budgetParameters = "C:\absolute\ignored\budget.parameters.json"
az deployment sub what-if `
  --location $location `
  --template-file .\infra\subscription-budget.bicep `
  --parameters "@$budgetParameters" `
  --no-pretty-print
```

Review this budget preview and obtain its separate owner approval. Only then:

```powershell
az deployment sub create `
  --location $location `
  --template-file .\infra\subscription-budget.bicep `
  --parameters "@$budgetParameters"
```

The `create` commands are examples of the approved mutation step;
documentation and local verification do not authorize running them.

Do not use complete deployment mode. Do not reuse or modify the existing shared
Service Bus namespace unless the owner explicitly changes the architecture
decision.
