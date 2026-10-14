# Python stdlib date trajectory delta skill

Status: `Promoted`

## Activation Boundary

- task family is date
- candidate path is one of src/date_tools.py
- starter function matches one of business_days_between, days_between, format_iso_date, month_range, parse_date_parts

## Evidence

- Repairs: py_v1_business_days_between, py_v1_format_iso_date
- Regressions: none
- Shared failures: none

## Usage Rule

This skill passed the regression gate and may be injected by the router for matching tasks.
