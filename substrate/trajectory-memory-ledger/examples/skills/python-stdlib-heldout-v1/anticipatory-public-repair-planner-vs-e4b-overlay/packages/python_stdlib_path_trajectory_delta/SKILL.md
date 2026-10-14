# Python stdlib path trajectory delta skill

Status: `Promoted`

## Activation Boundary

- task family is path
- candidate path is one of src/path_tools.py
- starter function matches one of common_prefix_path, extension_counts, is_subpath, normalize_segments, split_filename_version

## Evidence

- Repairs: py_v1_split_filename_version
- Regressions: none
- Shared failures: none

## Usage Rule

This skill passed the regression gate and may be injected by the router for matching tasks.
