# GTM Metrics Tracker

Gate: Kickstarter pre-launch demand readiness

Target: before launch, email list >= 1,000, Kickstarter followers >= 300, public testimonials >= 8, and first-day likely backers >= 50. By 2026-09-30, minimum checkpoint is email list >= 500 and Kickstarter followers >= 150.

## Summary

| Field | Value |
| --- | --- |
| Last updated | TBD |
| Owner | TBD |
| GTM analyzer report path | TBD |
| CRM export folder | TBD |
| Kickstarter dashboard export link | TBD |
| Decision | Not ready / Conditional / Ready |

## Weekly Snapshot

| Week Ending | Email List | KS Followers | Testimonials | First-day Likely Backers | Education Leads | Business Leads | Source Export Link | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| TBD | 0 | 0 | 0 | 0 | 0 | 0 | TBD | Not ready |

## GTM Analyzer

Use the GTM metrics analyzer after exporting weekly snapshots as CSV or JSON:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:gtm-metrics -- /path/to/gtm-snapshots.csv --out /tmp/gtm-report.json
```

Required input fields:

| Field | Required | Notes |
| --- | --- | --- |
| `week_ending` | Yes | Weekly snapshot date, preferably `YYYY-MM-DD` |
| `email_list` | Yes | Valid opted-in launch update list |
| `ks_followers` | Yes | Kickstarter pre-launch page followers |
| `testimonials` | Yes | Consent-backed public testimonials |
| `first_day_likely_backers` | Yes | Leads tagged as likely first-day supporters |
| `education_leads` | Yes | Teacher, tutor, school, creator, training leads |
| `business_leads` | Yes | Sales, consulting, product, design, engineering, workshop, or meeting-heavy leads |
| `source_export_link` | Yes for review | CRM, Kickstarter dashboard, testimonial, or interview-note export link |
| `decision` | No | Weekly decision or action note |

Paste the generated JSON summary here before weekly GTM review:

```json
{}
```

## Metric Definitions

| Metric | Counts When | Source |
| --- | --- | --- |
| Email list | User opted into InkLoop launch updates and has valid contact consent | CRM/export snapshot |
| KS followers | Kickstarter pre-launch page followers from dashboard | Kickstarter dashboard |
| Public testimonials | Permission-backed quote or clip usable on page/video | Consent record and asset link |
| First-day likely backers | Tagged lead with explicit buy intent or internal commitment confidence | CRM tag or interview note |
| Education leads | Teacher, tutor, school, education creator, or training lead | CRM segment |
| Business leads | Sales, consulting, workshop, product, management, or meeting-heavy team | CRM segment |

## Testimonials

| ID | Segment | Name / Alias | Consent Status | Quote / Clip Link | Asset Type | Page Use | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T-001 | Education / Business | TBD | Not requested / Approved / Rejected | TBD | Text / Video / Screenshot | TBD | TBD |

## Funnel Notes

| Date | Channel | Experiment | Spend | New Emails | New KS Followers | Quality Notes | Next Action |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| TBD | TBD | TBD | 0 | 0 | 0 | TBD | TBD |

## Gate Decision

| Question | Answer |
| --- | --- |
| Are 2026-09-30 checkpoint targets met? | TBD |
| Are final launch targets on track? | TBD |
| Which segment is stronger: education or business? | TBD |
| Is there enough evidence to film the campaign video? | TBD |
| What claim or audience should be narrowed? | TBD |

Decision notes:

TBD
