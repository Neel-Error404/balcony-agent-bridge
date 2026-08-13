# Azure Infrastructure

The recommended deployment creates a dedicated Central India Service Bus
Standard namespace. The namespace uses Microsoft Entra authentication only,
with one topic and one session-enabled filtered subscription per machine.

## Approval Boundary

Do not deploy these templates until the owner approves:

- Azure subscription and resource group.
- Namespace name and Central India placement.
- SYS-A and SYS-B managed identity mappings.
- Service Bus sender and receiver role assignments.
- Public Microsoft Entra-authenticated networking.
- Existing Log Analytics workspace, if diagnostics are enabled.
- The USD 15 monthly budget and notification recipients.

The template creates one dedicated user-assigned managed identity per machine
and grants only sender/receiver data-plane roles. Attaching those identities to
the existing VMs is a separate owner-approved operation after deployment.

Environment-specific workspace IDs, resource IDs, VM mappings, client IDs, and
email addresses must remain in untracked machine-local configuration.

## Safe Sequence

1. Install or make available a pinned Bicep CLI.
2. Run a local Bicep build for `deploy.bicep`, `main.bicep`, and the budget.
3. Copy `example.parameters.json` to an ignored machine-local parameter file.
4. Run subscription `what-if` for `deploy.bicep`.
5. Review every create and role-assignment operation.
6. Deploy the Service Bus template only after approval.
7. Run a separate subscription-scope budget `what-if`.
8. Deploy the budget only after approval.
9. Run the bounded live Azure integration suite.

Do not use complete deployment mode. Do not reuse or modify the existing shared
Service Bus namespace unless the owner explicitly changes the architecture
decision.
