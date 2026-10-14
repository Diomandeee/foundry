# Python stdlib parse trajectory delta skill

Status: `Promoted`

## Activation Boundary

- task family is parse
- candidate path is one of src/parse_tools.py
- starter function matches one of parse_bool, parse_env_lines, parse_query_string, parse_semver, parse_size_bytes

## Evidence

- Repairs: py_v1_parse_query_string, py_v1_parse_size_bytes
- Regressions: none
- Shared failures: none

## Usage Rule

This skill passed the regression gate and may be injected by the router for matching tasks.
