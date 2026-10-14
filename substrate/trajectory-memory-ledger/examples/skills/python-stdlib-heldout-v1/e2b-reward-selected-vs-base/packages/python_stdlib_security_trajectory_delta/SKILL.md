# Python stdlib security trajectory delta skill

Status: `Quarantined`

## Activation Boundary

- task family is security
- candidate path is one of src/security_tools.py
- starter function matches one of redact_bearer_tokens, redact_emails, redact_ipv4_last_octet, safe_filename, validate_relative_path

## Do Not Activate When

- do not activate until regressions are repaired: py_v1_validate_relative_path

## Evidence

- Repairs: py_v1_safe_filename
- Regressions: py_v1_validate_relative_path
- Shared failures: none

## Usage Rule

This skill caused or co-occurred with regressions. Use it only as diagnostic evidence for a future repair skill.
