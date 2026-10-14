# Python stdlib path trajectory delta skill

Status: `Quarantined`

## Activation Boundary

- task family is path
- candidate path is one of src/path_tools.py
- starter function matches one of common_prefix_path, extension_counts, is_subpath, normalize_segments, split_filename_version

## Do Not Activate When

- do not activate until regressions are repaired: py_v1_extension_counts
- diagnostic only for shared failures: py_v1_common_prefix_path, py_v1_normalize_segments, py_v1_split_filename_version

## Evidence

- Repairs: none
- Regressions: py_v1_extension_counts
- Shared failures: py_v1_common_prefix_path, py_v1_normalize_segments, py_v1_split_filename_version

## Usage Rule

This skill caused or co-occurred with regressions. Use it only as diagnostic evidence for a future repair skill.
