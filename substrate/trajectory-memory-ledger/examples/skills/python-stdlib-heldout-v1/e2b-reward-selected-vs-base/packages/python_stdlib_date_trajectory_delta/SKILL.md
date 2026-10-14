# Python stdlib date trajectory delta skill

Status: `Quarantined`

## Activation Boundary

- task family is date
- candidate path is one of src/date_tools.py
- starter function matches one of business_days_between, days_between, format_iso_date, month_range, parse_date_parts

## Do Not Activate When

- do not activate until regressions are repaired: py_v1_days_between

## Evidence

- Repairs: py_v1_business_days_between, py_v1_format_iso_date
- Regressions: py_v1_days_between
- Shared failures: none

## Usage Rule

This skill caused or co-occurred with regressions. Use it only as diagnostic evidence for a future repair skill.
