# Python stdlib parse trajectory delta skill

Status: `Diagnostic`

## Activation Boundary

- task family is parse
- candidate path is one of src/parse_tools.py
- starter function matches one of parse_bool, parse_env_lines, parse_query_string, parse_semver, parse_size_bytes

## Do Not Activate When

- diagnostic only for shared failures: py_v1_parse_query_string, py_v1_parse_size_bytes

## Evidence

- Repairs: none
- Regressions: none
- Shared failures: py_v1_parse_query_string, py_v1_parse_size_bytes

## Usage Rule

This package records persistent failures. It is not an activation skill.
