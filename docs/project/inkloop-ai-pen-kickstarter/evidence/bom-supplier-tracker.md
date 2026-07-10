# BOM And Supplier Tracker

Gate: Supply and finance readiness

Target: BOM v0.2 is at least 80% complete by 2026-09-30, with two credible supplier options or backups for core components and Capture Surface materials.

## Summary

| Field | Value |
| --- | --- |
| Last updated | TBD |
| Owner | TBD |
| BOM version | v0.0 |
| Target reward SKU | Starter Kit |
| Assembly location | TBD |
| Currency | USD / CNY |
| Pricing sheet path | TBD |
| Pricing analyzer report path | TBD |
| Supplier quote folder | TBD |
| Decision | Not ready / Conditional / Ready for reward pricing |

## BOM Lines

| Category | Component | Required Spec | Primary Supplier | Backup Supplier | Unit Cost | MOQ | Lead Time Days | Quote Link | Confidence | Risk | Decision |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| Pen | MCU / sensor module | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Low | TBD | Open |
| Pen | Battery / charging | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Low | TBD | Open |
| Pen | Shell / mechanical | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Low | TBD | Open |
| Surface | A3 Capture Surface material | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Low | TBD | Open |
| Surface | A2 Capture Surface material | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Low | TBD | Open |
| Packaging | Starter Kit box | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Low | TBD | Open |
| Fulfillment | Shipping material | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Low | TBD | Open |

## Cost Rollup

| Cost Area | Unit Cost | Notes |
| --- | ---: | --- |
| Pen electronics | 0 | TBD |
| Pen mechanical | 0 | TBD |
| Capture Surface | 0 | TBD |
| Packaging | 0 | TBD |
| Assembly and QA | 0 | TBD |
| Shipping buffer | 0 | TBD |
| Warranty/failure buffer | 0 | TBD |
| Kickstarter + Stripe fees | 0 | TBD |
| AI credit buffer | 0 | TBD |
| Total estimated cost | 0 | TBD |

## Pricing Analyzer

Use the reward pricing analyzer after exporting the BOM as CSV or JSON:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- /path/to/bom.csv --out /tmp/reward-pricing-report.json
```

Required input fields:

| Field | Required | Notes |
| --- | --- | --- |
| `reward_sku` | Yes | Reward tier or kit identifier |
| `category` | Yes | Example: Pen, Surface, Packaging, Assembly, Software |
| `component` | Yes | BOM line item |
| `required` | Yes | `true` for required reward contents |
| `quantity_per_reward` | Yes | Quantity per shipped reward |
| `unit_cost_usd` | Yes | Unit cost in USD |
| `primary_supplier` | Yes for pricing review | Current supplier option |
| `backup_supplier` | Yes for pricing review | Backup supplier option |
| `quote_status` | Yes | `quoted`, `estimated`, or `unknown` |
| `confidence` | No | Low / medium / high |
| `lead_time_days` | No | Supplier lead time |
| `moq` | No | Minimum order quantity |
| `risk` | No | Pricing, delivery, quality, or certification risk |

Default fee and buffer assumptions:

| Assumption | Default |
| --- | ---: |
| Target margin | 35% |
| Kickstarter platform fee | 5% |
| Payment processing fee | 4% |
| Pledge manager fee | 2% |
| Duty/tax buffer | 8% |
| Warranty buffer | 8% |
| Contingency buffer | 12% |
| Price rounding | $5 |

`pricing_model_has_required_inputs` can pass with estimated rows. `supplier_backed_for_public_page` requires confirmed quotes and should be treated as the stricter public pricing gate.

Paste the generated JSON summary here before reward price review:

```json
{}
```

## Supplier Risk

| Risk | Component | Impact | Mitigation | Owner | Due |
| --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD | TBD |

## Gate Decision

| Question | Answer |
| --- | --- |
| Is BOM >= 80% complete? | TBD |
| Does each core line have primary and backup options? | TBD |
| Are quotes current and attached? | TBD |
| Is reward pricing supported by actual cost data? | TBD |
| What delivery risk must be disclosed? | TBD |

Decision notes:

TBD
