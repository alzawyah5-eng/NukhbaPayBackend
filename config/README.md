# Catalogue configuration

[catalogue-policies.example.json](catalogue-policies.example.json) records the
choices a future tenant or channel policy can make. It is a review template
with no runtime loader. Nulls and empty arrays leave the decisions open.
Version and effective time identify a policy once approved. Runtime connections
and secret references continue to use the existing [environment template](../.env.example).

| Setting | Options to review |
| --- | --- |
| `selection.objective` | `CONTRIBUTION_PER_PRODUCT`, `TOTAL_CONTRIBUTION`, or `CONTRIBUTION_AND_RELIABILITY`. Define the volume horizon for total contribution and the reliability weighting for the combined objective. |
| `selection.timing` | `AT_PUBLICATION`, `AT_CHECKOUT`, or `DEFAULT_WITH_CONTROLLED_FALLBACK`. Define checkout price validity, fallback eligibility and who may authorize it. |
| `refresh.mode` | `DAILY`, `INTERVAL`, `PROVIDER_EVENT`, or `HYBRID`. Daily uses a local time and named time zone. Interval uses minutes. Provider events require a reviewed event allowlist. Hybrid combines a scheduled refresh with events. |

These choices feed the selection and refresh use cases. FX sources, pricing
rules and publication approvals have their own versioned evidence. Tenant and
channel scope must come from trusted application configuration when the template
becomes a persisted policy.


[Layer 1 configuration](acquisition-normalization.example.json) separates
disabled live composition from a synthetic policy example. An operator must
bind an approved account cost source and, for non-AED acquisition, an approved
FX source. The policy sets ages, currency and rate precision, valid dates,
permitted uses, and refresh interval. Worker limits bound batch sizes and calls.
