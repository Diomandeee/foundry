"""Prepare local catalog distribution bytes; does not upload or start services."""
import argparse
import json
import tarfile
from pathlib import Path
from common import Catalog, encode, file_hash


def package(root, output):
    catalog = Catalog(root)
    output = Path(output)
    files = [catalog.root / "catalog.json"]
    for project_id in catalog.projects:
        catalog.project(project_id)
        files.append(catalog.root / "projects" / (catalog.projects[project_id]["detailSha256"] + ".json"))
    with output.open("xb") as stream, tarfile.open(fileobj=stream, mode="w:gz", dereference=False) as archive:
        for path in sorted(set(files)):
            archive.add(path, arcname=str(path.relative_to(catalog.root)), recursive=False)
    descriptor = {"format": "foundry.catalog-distribution.v1", "status": "prepared-not-published",
                  "catalogRevision": catalog.index["revision"], "localPackage": str(output.resolve()),
                  "bytes": output.stat().st_size, "sha256": file_hash(output),
                  "object": None, "nextGate": "Owner approval for metadata publication and client activation; record real GCS generation before sync."}
    with Path(str(output) + ".prepared.json").open("xb") as stream:
        stream.write(encode(descriptor))
    return descriptor


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.catalog, args.output)))
