# Python stdlib graph trajectory delta skill

Status: `Quarantined`

## Activation Boundary

- task family is graph
- candidate path is one of src/graph_tools.py
- starter function matches one of dependency_order, has_cycle_directed, reachable_nodes, reverse_adjacency, shortest_path_unweighted

## Do Not Activate When

- do not activate until regressions are repaired: py_v1_dependency_order

## Evidence

- Repairs: none
- Regressions: py_v1_dependency_order
- Shared failures: none

## Usage Rule

This skill caused or co-occurred with regressions. Use it only as diagnostic evidence for a future repair skill.
