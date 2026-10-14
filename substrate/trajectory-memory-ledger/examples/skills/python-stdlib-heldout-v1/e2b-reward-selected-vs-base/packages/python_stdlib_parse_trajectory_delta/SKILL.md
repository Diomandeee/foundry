# Python stdlib parse trajectory delta skill

Status: `Quarantined`

## Activation Boundary

- task family is parse
- candidate path is one of src/parse_tools.py
- starter function matches one of parse_bool, parse_env_lines, parse_query_string, parse_semver, parse_size_bytes

## Do Not Activate When

- do not activate until regressions are repaired: py_v1_parse_env_lines, py_v1_parse_semver
- diagnostic only for shared failures: py_v1_parse_size_bytes

## Evidence

- Repairs: py_v1_parse_query_string
- Regressions: py_v1_parse_env_lines, py_v1_parse_semver
- Shared failures: py_v1_parse_size_bytes

## Usage Rule

This skill caused or co-occurred with regressions. Use it only as diagnostic evidence for a future repair skill.
