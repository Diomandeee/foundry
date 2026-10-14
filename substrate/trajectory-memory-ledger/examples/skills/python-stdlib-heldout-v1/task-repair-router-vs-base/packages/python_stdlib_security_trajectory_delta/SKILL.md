# Python stdlib security trajectory delta skill

Status: `Promoted`

## Activation Boundary

- task family is security
- candidate path is one of src/security_tools.py
- starter function matches one of redact_bearer_tokens, redact_emails, redact_ipv4_last_octet, safe_filename, validate_relative_path

## Evidence

- Repairs: py_v1_safe_filename
- Regressions: none
- Shared failures: none

## Usage Rule

This skill passed the regression gate and may be injected by the router for matching tasks.
