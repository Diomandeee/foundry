# Python stdlib collection trajectory delta skill

Status: `Promoted`

## Activation Boundary

- task family is collection
- candidate path is one of src/collection_tools.py
- starter function matches one of chunked_list, dedupe_preserve_order, flatten_one_level, rotate, windowed

## Evidence

- Repairs: py_v1_chunked_list
- Regressions: none
- Shared failures: none

## Usage Rule

This skill passed the regression gate and may be injected by the router for matching tasks.
