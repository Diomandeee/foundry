"""On-demand Mac1 read relay. Binary object bytes only on stdout; no daemon."""
import argparse
import json
import sys
from cloud import CloudReader
from common import valid_hash


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gcp-project", required=True)
    parser.add_argument("--account", required=True)
    args = parser.parse_args()
    try:
        ref = json.loads(sys.stdin.buffer.readline(8193))
        if (args.gcp_project != "project-8380e794-e4d6-4ad4-aaf"
                or ref["bucket"] != "foundry-library-pilot-648527652351"
                or not ref["object"].startswith(("source-copies/fleet/20261017T231436Z/clean-source/", "catalogs/fleet/"))
                or not isinstance(ref["generation"], str) or not ref["generation"].isdigit()
                or type(ref["bytes"]) is not int or not 0 <= ref["bytes"] <= 4 * 1024**3):
            raise ValueError("outside approved read scope")
        valid_hash(ref["sha256"])
        # The cache argument is never used: streaming writes no disk content on Mac1.
        reader = CloudReader(args.gcp_project, args.account, "/private/tmp")
        reader.stream_to(ref, sys.stdout.buffer)
        sys.stdout.buffer.flush()
    except Exception:
        sys.stderr.write("Foundry scoped archive relay failed; no credential output.\n")
        sys.exit(1)
