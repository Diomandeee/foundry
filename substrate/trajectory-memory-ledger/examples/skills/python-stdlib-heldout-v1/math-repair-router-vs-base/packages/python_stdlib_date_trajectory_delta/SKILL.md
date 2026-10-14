# Python stdlib date trajectory delta skill

Status: `Diagnostic`

## Activation Boundary

- task family is date
- candidate path is one of src/date_tools.py
- starter function matches one of business_days_between, days_between, format_iso_date, month_range, parse_date_parts

## Do Not Activate When

- diagnostic only for shared failures: py_v1_business_days_between, py_v1_format_iso_date

## Evidence

- Repairs: none
- Regressions: none
- Shared failures: py_v1_business_days_between, py_v1_format_iso_date

## Usage Rule

This package records persistent failures. It is not an activation skill.
