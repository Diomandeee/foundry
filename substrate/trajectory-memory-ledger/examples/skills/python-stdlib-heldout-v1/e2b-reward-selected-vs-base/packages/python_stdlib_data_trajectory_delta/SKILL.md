# Python stdlib data trajectory delta skill

Status: `Quarantined`

## Activation Boundary

- task family is data
- candidate path is one of src/data_tools.py
- starter function matches one of csv_to_dicts, dicts_to_csv, flatten_dict, json_get_path, json_set_path

## Do Not Activate When

- do not activate until regressions are repaired: py_v1_dicts_to_csv, py_v1_json_set_path

## Evidence

- Repairs: none
- Regressions: py_v1_dicts_to_csv, py_v1_json_set_path
- Shared failures: none

## Usage Rule

This skill caused or co-occurred with regressions. Use it only as diagnostic evidence for a future repair skill.
