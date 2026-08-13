# Cost Evidence And Estimates

Pricing checked on August 13, 2026 against the Azure Retail Prices API for
Central India and the official Azure Service Bus pricing terms.

## Per-Item Cost

| Item | Current cost basis | Bridge incremental estimate |
|---|---:|---:|
| Service Bus Standard base | USD 10/month per Azure subscription | USD 0/month |
| First 13 million Standard messaging operations | USD 0 | USD 0 |
| Next operation tier | USD 0.80 per million | Not reached |
| First 1,000 concurrent brokered connections | USD 0 | USD 0 |
| SYS-B user-assigned managed identity | No added identity charge | USD 0 |
| SYS-A Entra app and certificate credential | No deployed compute service | USD 0 |
| Azure Arc | Not deployed | USD 0 |
| Private endpoint and private DNS | Not deployed | USD 0 |
| Log Analytics workspace | Not deployed | USD 0 |
| Local SQLite and Windows process | Existing machine resources | USD 0 Azure |

The Standard base charge is billed once per Azure subscription, not once per
namespace. Live inspection found another Standard namespace in the same
subscription, so this bridge is not expected to add a second USD 10 base
charge. If the other Standard namespace is removed, this bridge would carry
the subscription's USD 10 monthly base charge.

## Scenario Estimate

The planning brief defines 6,000 idle, 25,000 expected, and 250,000 burst
messages per month. The estimate conservatively allows four billed broker
operations per message.

| Scenario | Messages/month | Conservative operations | Incremental Azure estimate |
|---|---:|---:|---:|
| Idle | 6,000 | 24,000 | USD 0/month |
| Expected | 25,000 | 100,000 | USD 0/month |
| Burst | 250,000 | 1,000,000 | USD 0/month |

The burst payload ceiling is about 7.63 GiB before protocol overhead. Large
evidence remains out of band, so actual traffic should be much smaller.

## Cost Guardrail

- Expected incremental cost: USD 0/month.
- Conservative operating envelope: USD 0 to USD 5/month.
- Recommended alert ceiling: USD 15/month.
- A subscription budget was not created because notification recipients and
  budget dates remain owner inputs.

This estimate excludes costs of the pre-existing SYS-B VM and any unrelated
Azure workloads because the bridge does not create or resize compute.
