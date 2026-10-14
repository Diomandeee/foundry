# Python stdlib collection trajectory delta skill

Status: `Diagnostic`

## Activation Boundary

- task family is collection
- candidate path is one of src/collection_tools.py
- starter function matches one of chunked_list, dedupe_preserve_order, flatten_one_level, rotate, windowed

## Do Not Activate When

- diagnostic only for shared failures: py_v1_chunked_list

## Evidence

- Repairs: none
- Regressions: none
- Shared failures: py_v1_chunked_list

## Usage Rule

This package records persistent failures. It is not an activation skill.
