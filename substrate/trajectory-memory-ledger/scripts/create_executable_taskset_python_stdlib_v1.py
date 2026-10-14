#!/usr/bin/env python3
"""Create the larger Python stdlib executable held-out task suite.

The generated public task file contains prompts and starter files only. The
task-spec file contains hidden verifier tests. The oracle candidate file is
synthetic and exists only to validate that the generated task suite is
self-consistent.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from textwrap import dedent
from typing import Any


TASK_SET = "python-stdlib-heldout-v1-60"
BENCHMARK_KIND = "executable-task-bench-real-model-output"


@dataclass(frozen=True)
class Task:
    task_id: str
    module_path: str
    public_prompt: str
    starter: str
    tests: str
    solution: str


def main() -> int:
    args = parse_args()
    tasks = build_tasks()
    validate_tasks(tasks)
    write_jsonl(args.public_tasks, public_rows(tasks))
    write_jsonl(args.task_specs, task_spec_rows(tasks))
    write_jsonl(args.oracle_candidates, oracle_candidate_rows(tasks))
    write_manifest(args.manifest, tasks, args)
    print(
        json.dumps(
            {
                "task_set": TASK_SET,
                "tasks": len(tasks),
                "public_tasks": str(args.public_tasks),
                "task_specs": str(args.task_specs),
                "oracle_candidates": str(args.oracle_candidates),
                "manifest": str(args.manifest),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--public-tasks",
        type=Path,
        default=Path("examples/evaluation/executable-public-tasks-python-stdlib-heldout-v1.jsonl"),
    )
    parser.add_argument(
        "--task-specs",
        type=Path,
        default=Path("examples/evaluation/executable-taskset-python-stdlib-heldout-v1.jsonl"),
    )
    parser.add_argument(
        "--oracle-candidates",
        type=Path,
        default=Path("examples/evaluation/executable-candidates-oracle-python-stdlib-heldout-v1.jsonl"),
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("benchmarks/executable-taskset-python-stdlib-heldout-v1-manifest-2026-06-10.json"),
    )
    return parser.parse_args()


def build_tasks() -> list[Task]:
    tasks: list[Task] = []

    add(tasks, "normalize_whitespace", "text_tools", "normalize_whitespace(text)", "Collapse all whitespace runs in text to single spaces, trim leading/trailing whitespace, and return the normalized string.", """
        def normalize_whitespace(text):
            return " ".join(str(text).split())
    """, """
        self.assertEqual(fn("  alpha\\n beta\\t\\t gamma  "), "alpha beta gamma")
        self.assertEqual(fn(""), "")
        self.assertEqual(fn("already clean"), "already clean")
    """)

    add(tasks, "slugify_text", "text_tools", "slugify_text(text)", "Convert text to a URL slug: lowercase ASCII alphanumeric words, separated by single hyphens. Treat any non-alphanumeric run as a separator and strip separators at the ends.", """
        import re

        def slugify_text(text):
            return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    """, """
        self.assertEqual(fn("Hello, WORLD!! 2026"), "hello-world-2026")
        self.assertEqual(fn("  Already---Sluggy  "), "already-sluggy")
        self.assertEqual(fn("!!!"), "")
    """)

    add(tasks, "extract_hashtags", "text_tools", "extract_hashtags(text)", "Return lowercase hashtag names from text in first-seen order. A hashtag starts with # and then has one or more letters, digits, or underscores. Do not include the # symbol.", """
        import re

        def extract_hashtags(text):
            return [match.lower() for match in re.findall(r"#([A-Za-z0-9_]+)", str(text))]
    """, """
        self.assertEqual(fn("Go #Python #AI #python!"), ["python", "ai", "python"])
        self.assertEqual(fn("email x#bad ok #good_tag"), ["bad", "good_tag"])
        self.assertEqual(fn("none"), [])
    """)

    add(tasks, "strip_markdown_links", "text_tools", "strip_markdown_links(text)", "Replace Markdown inline links like [label](url) with just label. Leave other text unchanged.", """
        import re

        def strip_markdown_links(text):
            return re.sub(r"\\[([^\\]]+)\\]\\(([^)]+)\\)", r"\\1", str(text))
    """, """
        self.assertEqual(fn("Read [docs](https://x.test) now"), "Read docs now")
        self.assertEqual(fn("[A](u) and [B](v)"), "A and B")
        self.assertEqual(fn("plain"), "plain")
    """)

    add(tasks, "count_word_frequencies", "text_tools", "count_word_frequencies(text)", "Return a dict mapping lowercase words to counts. Words are contiguous letters or digits. Ignore punctuation.", """
        import re
        from collections import Counter

        def count_word_frequencies(text):
            return dict(Counter(word.lower() for word in re.findall(r"[A-Za-z0-9]+", str(text))))
    """, """
        self.assertEqual(fn("One fish, two fish. ONE!"), {"one": 2, "fish": 2, "two": 1})
        self.assertEqual(fn(""), {})
        self.assertEqual(fn("v2 v2 V3"), {"v2": 2, "v3": 1})
    """)

    add(tasks, "parse_query_string", "parse_tools", "parse_query_string(query)", "Parse a URL query string into a dict mapping each key to a list of decoded values. Ignore a leading ?. Use urllib.parse semantics for percent decoding and blank values.", """
        from urllib.parse import parse_qs

        def parse_query_string(query):
            query = str(query)
            if query.startswith("?"):
                query = query[1:]
            return parse_qs(query, keep_blank_values=True)
    """, """
        self.assertEqual(fn("?a=1&a=2&b=hello%20there&empty="), {"a": ["1", "2"], "b": ["hello there"], "empty": [""]})
        self.assertEqual(fn(""), {})
    """)

    add(tasks, "parse_env_lines", "parse_tools", "parse_env_lines(text)", "Parse .env-style lines into a dict. Ignore blank lines and lines starting with #. Split on the first equals sign. Strip surrounding whitespace from keys and values.", """
        def parse_env_lines(text):
            out = {}
            for raw in str(text).splitlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                out[key.strip()] = value.strip()
            return out
    """, """
        self.assertEqual(fn("A=1\\n # comment\\nB = two=2\\nBAD\\nEMPTY= "), {"A": "1", "B": "two=2", "EMPTY": ""})
        self.assertEqual(fn("\\n# only"), {})
    """)

    add(tasks, "parse_size_bytes", "parse_tools", "parse_size_bytes(value)", "Parse an integer size string with optional binary unit suffix B, KB, MB, or GB. Units are case-insensitive and use powers of 1024. Reject decimals, negative numbers, and unknown units with ValueError.", """
        import re

        def parse_size_bytes(value):
            match = re.fullmatch(r"\\s*(\\d+)\\s*([kmgt]?b)?\\s*", str(value), re.IGNORECASE)
            if not match:
                raise ValueError("invalid size")
            number = int(match.group(1))
            unit = (match.group(2) or "B").lower()
            factors = {"b": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3, "tb": 1024**4}
            return number * factors[unit]
    """, """
        self.assertEqual(fn("2KB"), 2048)
        self.assertEqual(fn("3 mb"), 3145728)
        self.assertEqual(fn("7"), 7)
        for bad in ["1.5MB", "-1KB", "5XB"]:
            with self.assertRaises(ValueError):
                fn(bad)
    """)

    add(tasks, "parse_semver", "parse_tools", "parse_semver(value)", "Parse a semantic version string MAJOR.MINOR.PATCH with an optional leading v. Return a tuple of three integers. Reject missing parts, non-integers, or negative numbers with ValueError.", """
        import re

        def parse_semver(value):
            match = re.fullmatch(r"v?(\\d+)\\.(\\d+)\\.(\\d+)", str(value).strip())
            if not match:
                raise ValueError("invalid semver")
            return tuple(int(part) for part in match.groups())
    """, """
        self.assertEqual(fn("v1.2.3"), (1, 2, 3))
        self.assertEqual(fn("10.0.7"), (10, 0, 7))
        for bad in ["1.2", "1.2.x", "-1.2.3"]:
            with self.assertRaises(ValueError):
                fn(bad)
    """)

    add(tasks, "parse_bool", "parse_tools", "parse_bool(value)", "Parse common boolean strings. Return True for true, yes, y, 1, on. Return False for false, no, n, 0, off. Matching is case-insensitive after stripping. Raise ValueError otherwise.", """
        def parse_bool(value):
            normalized = str(value).strip().lower()
            if normalized in {"true", "yes", "y", "1", "on"}:
                return True
            if normalized in {"false", "no", "n", "0", "off"}:
                return False
            raise ValueError("invalid boolean")
    """, """
        self.assertTrue(fn(" YES "))
        self.assertFalse(fn("off"))
        self.assertFalse(fn("0"))
        with self.assertRaises(ValueError):
            fn("maybe")
    """)

    add(tasks, "dedupe_preserve_order", "collection_tools", "dedupe_preserve_order(items)", "Return a list with duplicate items removed while preserving first-seen order. Items are hashable.", """
        def dedupe_preserve_order(items):
            seen = set()
            out = []
            for item in items:
                if item not in seen:
                    seen.add(item)
                    out.append(item)
            return out
    """, """
        self.assertEqual(fn(["a", "b", "a", "c", "b"]), ["a", "b", "c"])
        self.assertEqual(fn([]), [])
        self.assertEqual(fn([1, 1, 2]), [1, 2])
    """)

    add(tasks, "flatten_one_level", "collection_tools", "flatten_one_level(items)", "Flatten one nesting level from an iterable of iterables. Strings should be treated as scalar values, not expanded into characters.", """
        def flatten_one_level(items):
            out = []
            for item in items:
                if isinstance(item, (str, bytes)):
                    out.append(item)
                else:
                    try:
                        out.extend(item)
                    except TypeError:
                        out.append(item)
            return out
    """, """
        self.assertEqual(fn([[1, 2], (3,), "ab", 4]), [1, 2, 3, "ab", 4])
        self.assertEqual(fn([]), [])
    """)

    add(tasks, "chunked_list", "collection_tools", "chunked_list(items, size)", "Return a list of list chunks of length size. Include a final shorter chunk. Raise ValueError when size is not positive.", """
        def chunked_list(items, size):
            if size <= 0:
                raise ValueError("size must be positive")
            seq = list(items)
            return [seq[idx:idx + size] for idx in range(0, len(seq), size)]
    """, """
        self.assertEqual(fn([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
        self.assertEqual(fn((x for x in range(3)), 4), [[0, 1, 2]])
        with self.assertRaises(ValueError):
            fn([1], 0)
    """)

    add(tasks, "windowed", "collection_tools", "windowed(items, size)", "Return a list of tuples representing sliding windows of length size. Raise ValueError when size is not positive. If size is larger than the input, return an empty list.", """
        def windowed(items, size):
            if size <= 0:
                raise ValueError("size must be positive")
            seq = list(items)
            return [tuple(seq[idx:idx + size]) for idx in range(0, len(seq) - size + 1)]
    """, """
        self.assertEqual(fn([1, 2, 3, 4], 3), [(1, 2, 3), (2, 3, 4)])
        self.assertEqual(fn([1, 2], 5), [])
        with self.assertRaises(ValueError):
            fn([1], -1)
    """)

    add(tasks, "rotate", "collection_tools", "rotate(items, amount)", "Return a new list rotated left by amount positions. Negative amount rotates right. Empty input returns an empty list.", """
        def rotate(items, amount):
            seq = list(items)
            if not seq:
                return []
            shift = amount % len(seq)
            return seq[shift:] + seq[:shift]
    """, """
        self.assertEqual(fn([1, 2, 3, 4], 1), [2, 3, 4, 1])
        self.assertEqual(fn([1, 2, 3, 4], -1), [4, 1, 2, 3])
        self.assertEqual(fn([], 3), [])
    """)

    add(tasks, "group_count", "record_tools", "group_count(rows, key)", "Return a dict counting how many dictionaries in rows have each value for key. Use None for rows missing the key.", """
        def group_count(rows, key):
            out = {}
            for row in rows:
                value = row.get(key)
                out[value] = out.get(value, 0) + 1
            return out
    """, """
        self.assertEqual(fn([{"k": "a"}, {"k": "a"}, {}, {"k": "b"}], "k"), {"a": 2, None: 1, "b": 1})
        self.assertEqual(fn([], "x"), {})
    """)

    add(tasks, "group_sum", "record_tools", "group_sum(rows, key, value_key)", "Return a dict summing numeric value_key values grouped by key. Missing grouping keys use None. Missing value keys count as 0.", """
        def group_sum(rows, key, value_key):
            out = {}
            for row in rows:
                group = row.get(key)
                out[group] = out.get(group, 0) + row.get(value_key, 0)
            return out
    """, """
        rows = [{"k": "a", "v": 2}, {"k": "a", "v": 3}, {"k": "b"}, {"v": 5}]
        self.assertEqual(fn(rows, "k", "v"), {"a": 5, "b": 0, None: 5})
    """)

    add(tasks, "index_unique", "record_tools", "index_unique(rows, key)", "Return a dict mapping each row key value to the original row. Raise ValueError if a row is missing key or if duplicate key values appear.", """
        def index_unique(rows, key):
            out = {}
            for row in rows:
                if key not in row:
                    raise ValueError("missing key")
                value = row[key]
                if value in out:
                    raise ValueError("duplicate key")
                out[value] = row
            return out
    """, """
        rows = [{"id": "a", "v": 1}, {"id": "b", "v": 2}]
        indexed = fn(rows, "id")
        self.assertIs(indexed["a"], rows[0])
        with self.assertRaises(ValueError):
            fn([{"id": "x"}, {"id": "x"}], "id")
        with self.assertRaises(ValueError):
            fn([{}], "id")
    """)

    add(tasks, "project_fields", "record_tools", "project_fields(rows, fields)", "Return new dictionaries containing only the requested fields that exist in each input row. Preserve row order and field order.", """
        def project_fields(rows, fields):
            return [{field: row[field] for field in fields if field in row} for row in rows]
    """, """
        self.assertEqual(fn([{"a": 1, "b": 2}, {"b": 3, "c": 4}], ["b", "a"]), [{"b": 2, "a": 1}, {"b": 3}])
        self.assertEqual(fn([], ["x"]), [])
    """)

    add(tasks, "merge_defaults", "record_tools", "merge_defaults(row, defaults)", "Return a new dict containing defaults overwritten by row values. Do not mutate either input.", """
        def merge_defaults(row, defaults):
            merged = dict(defaults)
            merged.update(row)
            return merged
    """, """
        defaults = {"a": 1, "b": 2}
        row = {"b": 9}
        self.assertEqual(fn(row, defaults), {"a": 1, "b": 9})
        self.assertEqual(defaults, {"a": 1, "b": 2})
        self.assertEqual(row, {"b": 9})
    """)

    add(tasks, "median", "math_tools", "median(values)", "Return the median of a non-empty numeric iterable. For even counts, return the average of the two middle values. Raise ValueError for empty input.", """
        def median(values):
            seq = sorted(values)
            if not seq:
                raise ValueError("empty values")
            mid = len(seq) // 2
            if len(seq) % 2:
                return seq[mid]
            return (seq[mid - 1] + seq[mid]) / 2
    """, """
        self.assertEqual(fn([3, 1, 2]), 2)
        self.assertEqual(fn([10, 1, 5, 7]), 6.0)
        with self.assertRaises(ValueError):
            fn([])
    """)

    add(tasks, "percent_change", "math_tools", "percent_change(old, new)", "Return percentage change from old to new as (new - old) / old * 100. Raise ValueError when old is zero.", """
        def percent_change(old, new):
            if old == 0:
                raise ValueError("old cannot be zero")
            return (new - old) / old * 100
    """, """
        self.assertEqual(fn(100, 125), 25)
        self.assertEqual(fn(200, 100), -50)
        with self.assertRaises(ValueError):
            fn(0, 1)
    """)

    add(tasks, "clamp_numbers", "math_tools", "clamp_numbers(values, low, high)", "Return a list where each number is clamped into the inclusive range [low, high]. Raise ValueError if low > high.", """
        def clamp_numbers(values, low, high):
            if low > high:
                raise ValueError("low cannot exceed high")
            return [min(max(value, low), high) for value in values]
    """, """
        self.assertEqual(fn([-2, 0, 5, 9], 0, 6), [0, 0, 5, 6])
        self.assertEqual(fn([], 1, 2), [])
        with self.assertRaises(ValueError):
            fn([1], 5, 2)
    """)

    add(tasks, "moving_average", "math_tools", "moving_average(values, size)", "Return a list of moving averages over consecutive windows of length size. Raise ValueError when size is not positive.", """
        def moving_average(values, size):
            if size <= 0:
                raise ValueError("size must be positive")
            seq = list(values)
            return [sum(seq[idx:idx + size]) / size for idx in range(len(seq) - size + 1)]
    """, """
        self.assertEqual(fn([1, 2, 3, 4], 2), [1.5, 2.5, 3.5])
        self.assertEqual(fn([1], 3), [])
        with self.assertRaises(ValueError):
            fn([1], 0)
    """)

    add(tasks, "histogram_bins", "math_tools", "histogram_bins(values, bin_size)", "Return a dict mapping each floor bin start to a count. For bin_size 10, values 0..9 map to 0 and 10..19 map to 10. Raise ValueError when bin_size <= 0.", """
        import math

        def histogram_bins(values, bin_size):
            if bin_size <= 0:
                raise ValueError("bin_size must be positive")
            out = {}
            for value in values:
                start = math.floor(value / bin_size) * bin_size
                out[start] = out.get(start, 0) + 1
            return out
    """, """
        self.assertEqual(fn([0, 1, 9, 10, 11, -1], 10), {0: 3, 10: 2, -10: 1})
        with self.assertRaises(ValueError):
            fn([1], 0)
    """)

    add(tasks, "reachable_nodes", "graph_tools", "reachable_nodes(graph, start)", "graph maps nodes to iterable neighbors. Return a sorted list of all nodes reachable from start, including start. Missing start has no outgoing neighbors.", """
        def reachable_nodes(graph, start):
            seen = set()
            stack = [start]
            while stack:
                node = stack.pop()
                if node in seen:
                    continue
                seen.add(node)
                stack.extend(graph.get(node, []))
            return sorted(seen)
    """, """
        graph = {"a": ["b", "c"], "b": ["d"], "c": ["d"], "d": []}
        self.assertEqual(fn(graph, "a"), ["a", "b", "c", "d"])
        self.assertEqual(fn(graph, "z"), ["z"])
    """)

    add(tasks, "shortest_path_unweighted", "graph_tools", "shortest_path_unweighted(graph, start, goal)", "Return the shortest path as a list from start to goal in an unweighted directed graph mapping nodes to neighbor lists. Return None if goal is unreachable. Preserve neighbor order when ties exist.", """
        from collections import deque

        def shortest_path_unweighted(graph, start, goal):
            queue = deque([(start, [start])])
            seen = {start}
            while queue:
                node, path = queue.popleft()
                if node == goal:
                    return path
                for neighbor in graph.get(node, []):
                    if neighbor not in seen:
                        seen.add(neighbor)
                        queue.append((neighbor, path + [neighbor]))
            return None
    """, """
        graph = {"a": ["b", "c"], "b": ["d"], "c": ["d"], "d": []}
        self.assertEqual(fn(graph, "a", "d"), ["a", "b", "d"])
        self.assertIsNone(fn(graph, "d", "a"))
    """)

    add(tasks, "has_cycle_directed", "graph_tools", "has_cycle_directed(graph)", "Return True if a directed graph mapping nodes to neighbors has a cycle. Include neighbor-only nodes.", """
        def has_cycle_directed(graph):
            visiting = set()
            visited = set()
            nodes = set(graph)
            for neighbors in graph.values():
                nodes.update(neighbors)

            def visit(node):
                if node in visiting:
                    return True
                if node in visited:
                    return False
                visiting.add(node)
                for neighbor in graph.get(node, []):
                    if visit(neighbor):
                        return True
                visiting.remove(node)
                visited.add(node)
                return False

            return any(visit(node) for node in nodes)
    """, """
        self.assertTrue(fn({"a": ["b"], "b": ["a"]}))
        self.assertFalse(fn({"a": ["b"], "b": ["c"], "c": []}))
        self.assertFalse(fn({}))
    """)

    add(tasks, "dependency_order", "graph_tools", "dependency_order(dependencies)", "dependencies maps an item to the items it depends on. Return a deterministic list where dependencies appear before dependents. Choose lexicographically smallest available item first. Raise ValueError on cycles.", """
        import heapq

        def dependency_order(dependencies):
            nodes = set(dependencies)
            for deps in dependencies.values():
                nodes.update(deps)
            outgoing = {node: [] for node in nodes}
            indegree = {node: 0 for node in nodes}
            for item, deps in dependencies.items():
                for dep in deps:
                    outgoing[dep].append(item)
                    indegree[item] += 1
            ready = [node for node, count in indegree.items() if count == 0]
            heapq.heapify(ready)
            out = []
            while ready:
                node = heapq.heappop(ready)
                out.append(node)
                for neighbor in sorted(outgoing[node]):
                    indegree[neighbor] -= 1
                    if indegree[neighbor] == 0:
                        heapq.heappush(ready, neighbor)
            if len(out) != len(nodes):
                raise ValueError("cycle")
            return out
    """, """
        self.assertEqual(fn({"deploy": ["test", "build"], "test": ["build"], "build": []}), ["build", "test", "deploy"])
        self.assertEqual(fn({"b": ["a"], "c": ["a"]}), ["a", "b", "c"])
        with self.assertRaises(ValueError):
            fn({"a": ["b"], "b": ["a"]})
    """)

    add(tasks, "reverse_adjacency", "graph_tools", "reverse_adjacency(graph)", "Return a dict where each node maps to the sorted list of incoming neighbors from the input adjacency mapping. Include nodes that only appear as neighbors.", """
        def reverse_adjacency(graph):
            nodes = set(graph)
            incoming = {node: [] for node in nodes}
            for node, neighbors in graph.items():
                for neighbor in neighbors:
                    nodes.add(neighbor)
                    incoming.setdefault(neighbor, []).append(node)
            for node in nodes:
                incoming.setdefault(node, [])
            return {node: sorted(values) for node, values in sorted(incoming.items())}
    """, """
        self.assertEqual(fn({"a": ["b", "c"], "b": ["c"]}), {"a": [], "b": ["a"], "c": ["a", "b"]})
        self.assertEqual(fn({}), {})
    """)

    add(tasks, "days_between", "date_tools", "days_between(start, end)", "Parse start and end as ISO dates YYYY-MM-DD and return the integer day difference end - start.", """
        from datetime import date

        def days_between(start, end):
            return (date.fromisoformat(end) - date.fromisoformat(start)).days
    """, """
        self.assertEqual(fn("2026-06-01", "2026-06-10"), 9)
        self.assertEqual(fn("2026-06-10", "2026-06-01"), -9)
    """)

    add(tasks, "month_range", "date_tools", "month_range(year, month)", "Return the first and last ISO date strings for the given year and month. Raise ValueError for invalid month.", """
        import calendar

        def month_range(year, month):
            if month < 1 or month > 12:
                raise ValueError("invalid month")
            last = calendar.monthrange(year, month)[1]
            return (f"{year:04d}-{month:02d}-01", f"{year:04d}-{month:02d}-{last:02d}")
    """, """
        self.assertEqual(fn(2024, 2), ("2024-02-01", "2024-02-29"))
        self.assertEqual(fn(2026, 6), ("2026-06-01", "2026-06-30"))
        with self.assertRaises(ValueError):
            fn(2026, 13)
    """)

    add(tasks, "format_iso_date", "date_tools", "format_iso_date(parts)", "parts is a dict with year, month, and day integers. Return YYYY-MM-DD with zero padding. Let invalid values raise naturally.", """
        from datetime import date

        def format_iso_date(parts):
            return date(parts["year"], parts["month"], parts["day"]).isoformat()
    """, """
        self.assertEqual(fn({"year": 2026, "month": 6, "day": 5}), "2026-06-05")
        with self.assertRaises(ValueError):
            fn({"year": 2026, "month": 2, "day": 30})
    """)

    add(tasks, "business_days_between", "date_tools", "business_days_between(start, end)", "Return the number of weekdays from start inclusive to end exclusive. Dates are ISO YYYY-MM-DD. If end is before start, return the negative count in the reverse direction.", """
        from datetime import date, timedelta

        def business_days_between(start, end):
            start_date = date.fromisoformat(start)
            end_date = date.fromisoformat(end)
            if end_date < start_date:
                return -business_days_between(end, start)
            count = 0
            current = start_date
            while current < end_date:
                if current.weekday() < 5:
                    count += 1
                current += timedelta(days=1)
            return count
    """, """
        self.assertEqual(fn("2026-06-08", "2026-06-15"), 5)
        self.assertEqual(fn("2026-06-13", "2026-06-15"), 0)
        self.assertEqual(fn("2026-06-15", "2026-06-08"), -5)
    """)

    add(tasks, "parse_date_parts", "date_tools", "parse_date_parts(value)", "Parse an ISO date string YYYY-MM-DD and return a dict with year, month, and day integers.", """
        from datetime import date

        def parse_date_parts(value):
            parsed = date.fromisoformat(value)
            return {"year": parsed.year, "month": parsed.month, "day": parsed.day}
    """, """
        self.assertEqual(fn("2026-06-10"), {"year": 2026, "month": 6, "day": 10})
        with self.assertRaises(ValueError):
            fn("2026-02-30")
    """)

    add(tasks, "redact_emails", "security_tools", "redact_emails(text)", "Replace email-like addresses with [EMAIL]. Match a simple local@domain.tld shape. Preserve all other text.", """
        import re

        def redact_emails(text):
            return re.sub(r"\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", "[EMAIL]", str(text))
    """, """
        self.assertEqual(fn("Send to a.b@test.com and x@y.co"), "Send to [EMAIL] and [EMAIL]")
        self.assertEqual(fn("not@email"), "not@email")
    """)

    add(tasks, "redact_bearer_tokens", "security_tools", "redact_bearer_tokens(text)", "Replace Bearer followed by one non-space token with Bearer [REDACTED]. Matching is case-sensitive.", """
        import re

        def redact_bearer_tokens(text):
            return re.sub(r"Bearer\\s+\\S+", "Bearer [REDACTED]", str(text))
    """, """
        self.assertEqual(fn("Authorization: Bearer abc.def next"), "Authorization: Bearer [REDACTED] next")
        self.assertEqual(fn("bearer abc"), "bearer abc")
    """)

    add(tasks, "redact_ipv4_last_octet", "security_tools", "redact_ipv4_last_octet(text)", "Replace the last octet of IPv4 addresses with x. For example 192.168.1.42 becomes 192.168.1.x. Leave invalid addresses unchanged.", """
        import re

        def redact_ipv4_last_octet(text):
            def repl(match):
                parts = [int(group) for group in match.groups()]
                if all(0 <= part <= 255 for part in parts):
                    return f"{parts[0]}.{parts[1]}.{parts[2]}.x"
                return match.group(0)

            return re.sub(r"\\b(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\b", repl, str(text))
    """, """
        self.assertEqual(fn("from 192.168.1.42 to 10.0.0.1"), "from 192.168.1.x to 10.0.0.x")
        self.assertEqual(fn("999.1.1.1"), "999.1.1.1")
    """)

    add(tasks, "safe_filename", "security_tools", "safe_filename(name)", "Return a filesystem-safe filename: replace characters other than letters, digits, dot, underscore, or hyphen with underscores, collapse repeated underscores, and strip leading/trailing underscores. Return 'untitled' if empty.", """
        import re

        def safe_filename(name):
            cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name))
            cleaned = re.sub(r"_+", "_", cleaned).strip("_")
            return cleaned or "untitled"
    """, """
        self.assertEqual(fn("hello/world?.txt"), "hello_world_.txt")
        self.assertEqual(fn("  "), "untitled")
        self.assertEqual(fn("a__b"), "a_b")
    """)

    add(tasks, "validate_relative_path", "security_tools", "validate_relative_path(path)", "Return True if path is a safe relative path. Reject absolute paths, empty paths, and any path containing .. segments.", """
        from pathlib import PurePosixPath

        def validate_relative_path(path):
            text = str(path)
            if not text:
                return False
            candidate = PurePosixPath(text)
            return not candidate.is_absolute() and ".." not in candidate.parts
    """, """
        self.assertTrue(fn("src/app.py"))
        self.assertFalse(fn("/tmp/app.py"))
        self.assertFalse(fn("../secret"))
        self.assertFalse(fn(""))
    """)

    add(tasks, "csv_to_dicts", "data_tools", "csv_to_dicts(text)", "Parse CSV text with a header row into a list of dicts using Python's csv module. Preserve values as strings.", """
        import csv
        import io

        def csv_to_dicts(text):
            return list(csv.DictReader(io.StringIO(str(text))))
    """, """
        self.assertEqual(fn("name,age\\nAda,36\\nMo,30\\n"), [{"name": "Ada", "age": "36"}, {"name": "Mo", "age": "30"}])
        self.assertEqual(fn("a,b\\n"), [])
    """)

    add(tasks, "dicts_to_csv", "data_tools", "dicts_to_csv(rows, fieldnames)", "Serialize rows to CSV text using the given fieldnames and lineterminator '\\n'. Include the header row. Missing values should serialize as empty strings.", """
        import csv
        import io

        def dicts_to_csv(rows, fieldnames):
            handle = io.StringIO()
            writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\\n")
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
            return handle.getvalue()
    """, """
        self.assertEqual(fn([{"name": "Ada", "age": 36}, {"name": "Mo"}], ["name", "age"]), "name,age\\nAda,36\\nMo,\\n")
    """)

    add(tasks, "json_get_path", "data_tools", "json_get_path(data, path, default=None)", "Return a nested value from dict/list data using a dot-separated path. Numeric path parts index lists. Return default if any part is missing or invalid.", """
        def json_get_path(data, path, default=None):
            current = data
            for part in str(path).split("."):
                try:
                    if isinstance(current, list):
                        current = current[int(part)]
                    else:
                        current = current[part]
                except (KeyError, IndexError, ValueError, TypeError):
                    return default
            return current
    """, """
        data = {"a": {"b": [{"c": 7}]}}
        self.assertEqual(fn(data, "a.b.0.c"), 7)
        self.assertEqual(fn(data, "a.b.2.c", "missing"), "missing")
    """)

    add(tasks, "json_set_path", "data_tools", "json_set_path(data, path, value)", "Return a deep-copied dict with value assigned at a dot-separated object path. Create missing dicts as needed. Do not mutate the input.", """
        import copy

        def json_set_path(data, path, value):
            result = copy.deepcopy(data)
            current = result
            parts = str(path).split(".")
            for part in parts[:-1]:
                current = current.setdefault(part, {})
            current[parts[-1]] = value
            return result
    """, """
        original = {"a": {"b": 1}}
        result = fn(original, "a.c", 2)
        self.assertEqual(result, {"a": {"b": 1, "c": 2}})
        self.assertEqual(original, {"a": {"b": 1}})
        self.assertEqual(fn({}, "x.y", 3), {"x": {"y": 3}})
    """)

    add(tasks, "flatten_dict", "data_tools", "flatten_dict(data, sep='.')", "Flatten nested dictionaries into a single dict with joined keys. Non-dict values are leaves. Preserve insertion traversal order.", """
        def flatten_dict(data, sep="."):
            out = {}

            def walk(prefix, value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        walk(f"{prefix}{sep}{key}" if prefix else str(key), child)
                else:
                    out[prefix] = value

            walk("", data)
            return out
    """, """
        self.assertEqual(fn({"a": {"b": 1}, "c": 2}), {"a.b": 1, "c": 2})
        self.assertEqual(fn({"a": {"b": {"c": 3}}}, "/"), {"a/b/c": 3})
    """)

    add(tasks, "extension_counts", "path_tools", "extension_counts(paths)", "Return a dict counting lowercase file extensions from paths. Use an empty string for paths with no suffix.", """
        from pathlib import PurePath

        def extension_counts(paths):
            out = {}
            for path in paths:
                suffix = PurePath(str(path)).suffix.lower()
                out[suffix] = out.get(suffix, 0) + 1
            return out
    """, """
        self.assertEqual(fn(["a.TXT", "b.py", "README", "c.txt"]), {".txt": 2, ".py": 1, "": 1})
        self.assertEqual(fn([]), {})
    """)

    add(tasks, "common_prefix_path", "path_tools", "common_prefix_path(paths)", "Return the common path prefix using POSIX path semantics. Return an empty string for no paths.", """
        import posixpath

        def common_prefix_path(paths):
            seq = [str(path) for path in paths]
            if not seq:
                return ""
            return posixpath.commonpath(seq)
    """, """
        self.assertEqual(fn(["/a/b/c", "/a/b/d"]), "/a/b")
        self.assertEqual(fn(["src/a.py", "src/pkg/b.py"]), "src")
        self.assertEqual(fn([]), "")
    """)

    add(tasks, "normalize_segments", "path_tools", "normalize_segments(path)", "Normalize dot and double-slash segments in a POSIX-style path without allowing the result to escape above root for relative paths.", """
        import posixpath

        def normalize_segments(path):
            normalized = posixpath.normpath(str(path).replace("\\\\", "/"))
            return "" if normalized == "." else normalized
    """, """
        self.assertEqual(fn("a//b/./c"), "a/b/c")
        self.assertEqual(fn("a/b/../c"), "a/c")
        self.assertEqual(fn("."), "")
    """)

    add(tasks, "is_subpath", "path_tools", "is_subpath(parent, child)", "Return True if child is inside parent or equal to parent after POSIX path normalization. Treat paths as absolute or relative strings.", """
        import posixpath

        def is_subpath(parent, child):
            parent_norm = posixpath.normpath(str(parent))
            child_norm = posixpath.normpath(str(child))
            return child_norm == parent_norm or child_norm.startswith(parent_norm.rstrip("/") + "/")
    """, """
        self.assertTrue(fn("/a/b", "/a/b/c.txt"))
        self.assertTrue(fn("src", "src"))
        self.assertFalse(fn("/a/b", "/a/bad/c"))
    """)

    add(tasks, "split_filename_version", "path_tools", "split_filename_version(name)", "Split names like report-v12.txt into ('report', 12, '.txt'). If no -v<number> suffix appears before the extension, return (stem, None, suffix).", """
        import re
        from pathlib import PurePath

        def split_filename_version(name):
            path = PurePath(str(name))
            stem = path.stem
            suffix = path.suffix
            match = re.fullmatch(r"(.+)-v(\\d+)", stem)
            if match:
                return (match.group(1), int(match.group(2)), suffix)
            return (stem, None, suffix)
    """, """
        self.assertEqual(fn("report-v12.txt"), ("report", 12, ".txt"))
        self.assertEqual(fn("archive.tar"), ("archive", None, ".tar"))
    """)

    add(tasks, "validate_parentheses", "state_tools", "validate_parentheses(text)", "Return True if (), [], and {} brackets are balanced and correctly nested in text. Ignore non-bracket characters.", """
        def validate_parentheses(text):
            pairs = {")": "(", "]": "[", "}": "{"}
            opens = set(pairs.values())
            stack = []
            for char in str(text):
                if char in opens:
                    stack.append(char)
                elif char in pairs:
                    if not stack or stack.pop() != pairs[char]:
                        return False
            return not stack
    """, """
        self.assertTrue(fn("a(b[c]{d})"))
        self.assertFalse(fn("(]"))
        self.assertFalse(fn("(()"))
    """)

    add(tasks, "run_length_encode", "state_tools", "run_length_encode(items)", "Return a list of (value, count) tuples for consecutive repeated values.", """
        def run_length_encode(items):
            seq = list(items)
            if not seq:
                return []
            out = []
            current = seq[0]
            count = 1
            for item in seq[1:]:
                if item == current:
                    count += 1
                else:
                    out.append((current, count))
                    current, count = item, 1
            out.append((current, count))
            return out
    """, """
        self.assertEqual(fn(["a", "a", "b", "a"]), [("a", 2), ("b", 1), ("a", 1)])
        self.assertEqual(fn([]), [])
    """)

    add(tasks, "run_length_decode", "state_tools", "run_length_decode(pairs)", "Decode (value, count) pairs into a flat list. Raise ValueError for negative counts.", """
        def run_length_decode(pairs):
            out = []
            for value, count in pairs:
                if count < 0:
                    raise ValueError("negative count")
                out.extend([value] * count)
            return out
    """, """
        self.assertEqual(fn([("a", 2), ("b", 1)]), ["a", "a", "b"])
        self.assertEqual(fn([]), [])
        with self.assertRaises(ValueError):
            fn([("x", -1)])
    """)

    add(tasks, "collapse_ranges", "state_tools", "collapse_ranges(values)", "Collapse sorted or unsorted integers into inclusive (start, end) ranges. Return ranges sorted by start and remove duplicates.", """
        def collapse_ranges(values):
            nums = sorted(set(values))
            if not nums:
                return []
            ranges = []
            start = prev = nums[0]
            for value in nums[1:]:
                if value == prev + 1:
                    prev = value
                else:
                    ranges.append((start, prev))
                    start = prev = value
            ranges.append((start, prev))
            return ranges
    """, """
        self.assertEqual(fn([3, 1, 2, 7, 8, 8]), [(1, 3), (7, 8)])
        self.assertEqual(fn([]), [])
    """)

    add(tasks, "expand_ranges", "state_tools", "expand_ranges(ranges)", "Expand inclusive (start, end) ranges into a flat list. Raise ValueError if any start is greater than end.", """
        def expand_ranges(ranges):
            out = []
            for start, end in ranges:
                if start > end:
                    raise ValueError("invalid range")
                out.extend(range(start, end + 1))
            return out
    """, """
        self.assertEqual(fn([(1, 3), (7, 8)]), [1, 2, 3, 7, 8])
        self.assertEqual(fn([]), [])
        with self.assertRaises(ValueError):
            fn([(3, 1)])
    """)

    add(tasks, "top_k_frequent", "misc_tools", "top_k_frequent(items, k)", "Return the k most frequent items as a list ordered by descending count then item ascending. Raise ValueError if k is negative.", """
        from collections import Counter

        def top_k_frequent(items, k):
            if k < 0:
                raise ValueError("k must be non-negative")
            counts = Counter(items)
            return [item for item, _ in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:k]]
    """, """
        self.assertEqual(fn(["b", "a", "b", "c", "a", "b"], 2), ["b", "a"])
        self.assertEqual(fn(["x"], 0), [])
        with self.assertRaises(ValueError):
            fn(["x"], -1)
    """)

    add(tasks, "stable_partition", "misc_tools", "stable_partition(items, predicate)", "Return a tuple (matching, non_matching), preserving original order in each list. predicate is a callable.", """
        def stable_partition(items, predicate):
            yes, no = [], []
            for item in items:
                (yes if predicate(item) else no).append(item)
            return yes, no
    """, """
        self.assertEqual(fn([1, 2, 3, 4], lambda x: x % 2 == 0), ([2, 4], [1, 3]))
        self.assertEqual(fn([], bool), ([], []))
    """)

    add(tasks, "pairwise_deltas", "misc_tools", "pairwise_deltas(values)", "Return the differences between each adjacent pair as current minus previous.", """
        def pairwise_deltas(values):
            seq = list(values)
            return [b - a for a, b in zip(seq, seq[1:])]
    """, """
        self.assertEqual(fn([10, 13, 8]), [3, -5])
        self.assertEqual(fn([1]), [])
    """)

    add(tasks, "coalesce_intervals", "misc_tools", "coalesce_intervals(intervals)", "Return sorted non-overlapping intervals, merging intervals that overlap or touch. Raise ValueError for intervals where start > end.", """
        def coalesce_intervals(intervals):
            sorted_intervals = sorted(intervals)
            out = []
            for start, end in sorted_intervals:
                if start > end:
                    raise ValueError("invalid interval")
                if not out or start > out[-1][1]:
                    out.append([start, end])
                else:
                    out[-1][1] = max(out[-1][1], end)
            return [tuple(item) for item in out]
    """, """
        self.assertEqual(fn([(5, 7), (1, 3), (3, 5)]), [(1, 7)])
        self.assertEqual(fn([]), [])
        with self.assertRaises(ValueError):
            fn([(2, 1)])
    """)

    add(tasks, "rate_limit_events", "misc_tools", "rate_limit_events(events, window_seconds, max_events)", "events is a sorted iterable of numeric timestamps. Return the timestamps accepted by a sliding-window rate limit allowing at most max_events in any window_seconds interval. Raise ValueError for non-positive window or max_events.", """
        from collections import deque

        def rate_limit_events(events, window_seconds, max_events):
            if window_seconds <= 0 or max_events <= 0:
                raise ValueError("invalid limits")
            accepted = []
            window = deque()
            for event in events:
                while window and event - window[0] >= window_seconds:
                    window.popleft()
                if len(window) < max_events:
                    accepted.append(event)
                    window.append(event)
            return accepted
    """, """
        self.assertEqual(fn([0, 1, 2, 5, 6], 5, 2), [0, 1, 5, 6])
        with self.assertRaises(ValueError):
            fn([1], 0, 1)
    """)

    return tasks


def add(
    tasks: list[Task],
    name: str,
    module: str,
    signature: str,
    behavior: str,
    solution: str,
    test_body: str,
) -> None:
    task_id = f"py_v1_{name}"
    module_path = f"src/{module}.py"
    function_name = signature.split("(", 1)[0]
    prompt = (
        f"Implement {module_path} with {signature}. {behavior} "
        "Use only the Python standard library. Do not include tests or extra files."
    )
    starter = f"def {signature}:\n    raise NotImplementedError\n"
    tests = make_tests(module, function_name, test_body)
    tasks.append(
        Task(
            task_id=task_id,
            module_path=module_path,
            public_prompt=prompt,
            starter=starter,
            tests=tests,
            solution=clean_source(solution),
        )
    )


def make_tests(module: str, function_name: str, test_body: str) -> str:
    class_name = "".join(part.capitalize() for part in function_name.split("_")) + "Test"
    body = indent(clean_source(test_body), " " * 8)
    return (
        "import unittest\n"
        f"from src.{module} import {function_name}\n\n\n"
        f"class {class_name}(unittest.TestCase):\n"
        "    def test_behavior(self):\n"
        f"        fn = {function_name}\n"
        f"{body}\n\n\n"
        "if __name__ == '__main__':\n"
        "    unittest.main()\n"
    )


def public_rows(tasks: list[Task]) -> list[dict[str, Any]]:
    return [
        {
            "task_id": task.task_id,
            "candidate_paths": [task.module_path],
            "public_prompt": task.public_prompt,
            "starter_files": {task.module_path: task.starter},
        }
        for task in tasks
    ]


def task_spec_rows(tasks: list[Task]) -> list[dict[str, Any]]:
    return [
        {
            "task_id": task.task_id,
            "setup_files": {
                "src/__init__.py": "",
                task.module_path: task.starter,
                f"tests/test_{task.task_id}.py": task.tests,
            },
            "verifier_command": "python3 -m unittest discover -s tests",
            "timeout_ms": 5000,
            "benchmark_kind": BENCHMARK_KIND,
            "task_set": TASK_SET,
        }
        for task in tasks
    ]


def oracle_candidate_rows(tasks: list[Task]) -> list[dict[str, Any]]:
    return [
        {
            "condition": "oracle",
            "task_id": task.task_id,
            "candidate_files": {task.module_path: task.solution},
            "generated_tools": ["Oracle"],
            "tests_included": False,
            "build_included": False,
            "source_artifact": "script:create_executable_taskset_python_stdlib_v1.py",
            "synthetic": True,
        }
        for task in tasks
    ]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def write_manifest(path: Path, tasks: list[Task], args: argparse.Namespace) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    modules = sorted({task.module_path for task in tasks})
    manifest = {
        "schema": "trajectory-memory-ledger.executable_taskset_manifest.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "task_set": TASK_SET,
        "task_count": len(tasks),
        "module_count": len(modules),
        "modules": modules,
        "public_tasks": str(args.public_tasks),
        "task_specs": str(args.task_specs),
        "oracle_candidates": str(args.oracle_candidates),
        "hidden_tests_in_public_prompts": False,
        "oracle_candidates_synthetic": True,
        "claim_boundary": (
            "This manifest describes a deterministic held-out executable task suite. "
            "Oracle rows are synthetic and only validate the harness; model evidence "
            "must use non-synthetic candidate rows with hidden_tests_sent_to_model=false."
        ),
    }
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def validate_tasks(tasks: list[Task]) -> None:
    if len(tasks) != 60:
        raise SystemExit(f"expected 60 tasks, got {len(tasks)}")
    ids = [task.task_id for task in tasks]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate task ids")
    for task in tasks:
        if not task.task_id.startswith("py_v1_"):
            raise SystemExit(f"bad task id {task.task_id}")
        if not task.module_path.startswith("src/") or not task.module_path.endswith(".py"):
            raise SystemExit(f"bad module path {task.module_path}")
        compile(task.solution, task.module_path, "exec")
        compile(task.tests, f"tests/test_{task.task_id}.py", "exec")


def clean_source(source: str) -> str:
    return dedent(source).strip() + "\n"


def indent(text: str, prefix: str) -> str:
    return "".join(prefix + line if line else line for line in text.splitlines(True))


if __name__ == "__main__":
    raise SystemExit(main())
