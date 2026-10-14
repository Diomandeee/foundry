# Python stdlib security trajectory delta skill

Status: `Diagnostic`

## Activation Boundary

- task family is security
- candidate path is one of src/security_tools.py
- starter function matches one of redact_bearer_tokens, redact_emails, redact_ipv4_last_octet, safe_filename, validate_relative_path

## Do Not Activate When

- diagnostic only for shared failures: py_v1_safe_filename

## Evidence

- Repairs: none
- Regressions: none
- Shared failures: py_v1_safe_filename

## Usage Rule

This package records persistent failures. It is not an activation skill.
