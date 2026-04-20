#!/usr/bin/env python3
"""
TITAN — GAIA Benchmark Data Downloader

Downloads the GAIA validation dataset from HuggingFace.
Requires: pip install datasets huggingface_hub
Auth: huggingface-cli login (or set HF_TOKEN env var)

Usage:
    python3 src/eval/gaia-download.py
"""

import os
import json
import sys

def main():
    try:
        from datasets import load_dataset
        from huggingface_hub import snapshot_download
    except ImportError:
        print("Missing dependencies. Run:")
        print("  pip3 install datasets huggingface_hub")
        sys.exit(1)

    output_dir = os.path.expanduser("~/.titan/eval/gaia/data")
    os.makedirs(output_dir, exist_ok=True)

    print("Downloading GAIA dataset from HuggingFace...")
    print("(You must have accepted terms at https://huggingface.co/datasets/gaia-benchmark/GAIA)")
    print()

    try:
        # Download the full repo (includes attached files)
        print("Step 1/3: Downloading dataset files...")
        data_dir = snapshot_download(
            repo_id="gaia-benchmark/GAIA",
            repo_type="dataset",
            allow_patterns=["2023/**"],
        )
        print(f"  Downloaded to: {data_dir}")

        # Load validation split
        print("\nStep 2/3: Loading validation tasks...")

        # Try different config names
        ds = None
        for config in ['2023_all', '2023_level1']:
            try:
                ds = load_dataset("gaia-benchmark/GAIA", config, split="validation")
                print(f"  Loaded {len(ds)} validation tasks (config: {config})")
                break
            except Exception as e:
                print(f"  Config '{config}' failed: {e}")
                continue

        if ds is None:
            # Try loading from local parquet files
            print("  Trying local parquet files...")
            import glob
            parquet_files = glob.glob(os.path.join(data_dir, "**/*.parquet"), recursive=True)
            print(f"  Found {len(parquet_files)} parquet files:")
            for f in parquet_files:
                print(f"    {f}")

            # Try loading validation parquets
            val_files = [f for f in parquet_files if 'validation' in f.lower() or 'val' in f.lower() or 'dev' in f.lower()]
            if not val_files:
                val_files = [f for f in parquet_files if 'test' not in f.lower()]

            if val_files:
                import pyarrow.parquet as pq
                tables = []
                for f in val_files:
                    tables.append(pq.read_table(f))
                import pyarrow as pa
                table = pa.concat_tables(tables)
                records = table.to_pylist()
                print(f"  Loaded {len(records)} records from parquet")

                # Save as JSON
                output_file = os.path.join(output_dir, "gaia-validation.json")

                # Clean up records
                tasks = []
                for r in records:
                    task = {
                        "task_id": r.get("task_id", ""),
                        "Question": r.get("Question", ""),
                        "Level": r.get("Level", 0),
                        "Final answer": r.get("Final answer", ""),
                        "file_name": r.get("file_name", ""),
                        "file_path": r.get("file_path", ""),
                    }
                    if task["Question"] and task["Final answer"]:
                        tasks.append(task)

                with open(output_file, "w") as f:
                    json.dump(tasks, f, indent=2)

                print(f"\nStep 3/3: Saved {len(tasks)} tasks to {output_file}")
                print_summary(tasks)
                return

        if ds is None:
            print("\n❌ Could not load dataset. Make sure you:")
            print("   1. Accepted terms at https://huggingface.co/datasets/gaia-benchmark/GAIA")
            print("   2. Are logged in: huggingface-cli login")
            sys.exit(1)

        # Convert to list of dicts
        print("\nStep 3/3: Saving validation data...")
        tasks = []
        for item in ds:
            task = {
                "task_id": item.get("task_id", ""),
                "Question": item.get("Question", ""),
                "Level": item.get("Level", 0),
                "Final answer": item.get("Final answer", ""),
                "file_name": item.get("file_name", ""),
                "file_path": item.get("file_path", ""),
            }
            # Map file_path to the downloaded location
            if task["file_name"] and task["file_path"]:
                local_path = os.path.join(data_dir, task["file_path"])
                if os.path.exists(local_path):
                    task["file_path"] = local_path
                else:
                    # Try finding it
                    for root, dirs, files in os.walk(data_dir):
                        if task["file_name"] in files:
                            task["file_path"] = os.path.join(root, task["file_name"])
                            break
            tasks.append(task)

        output_file = os.path.join(output_dir, "gaia-validation.json")
        with open(output_file, "w") as f:
            json.dump(tasks, f, indent=2)

        print(f"  Saved {len(tasks)} tasks to {output_file}")
        print_summary(tasks)

        # Also save attachment directory location
        meta = {
            "data_dir": data_dir,
            "output_file": output_file,
            "task_count": len(tasks),
        }
        with open(os.path.join(output_dir, "meta.json"), "w") as f:
            json.dump(meta, f, indent=2)

    except Exception as e:
        print(f"\n❌ Error: {e}")
        if "gated" in str(e).lower() or "401" in str(e) or "403" in str(e):
            print("\nThis dataset is gated. You must:")
            print("  1. Go to https://huggingface.co/datasets/gaia-benchmark/GAIA")
            print("  2. Click 'Agree and access'")
            print("  3. Login: huggingface-cli login")
        sys.exit(1)


def print_summary(tasks):
    """Print a summary of the loaded tasks."""
    levels = {}
    has_files = 0
    for t in tasks:
        lvl = t.get("Level", 0)
        levels[lvl] = levels.get(lvl, 0) + 1
        if t.get("file_name"):
            has_files += 1

    print(f"\n{'='*50}")
    print(f"  GAIA Validation Set — {len(tasks)} tasks")
    print(f"{'='*50}")
    for lvl in sorted(levels.keys()):
        print(f"  Level {lvl}: {levels[lvl]} tasks")
    print(f"  With attachments: {has_files}")
    print(f"  Without attachments: {len(tasks) - has_files}")
    print(f"{'='*50}")
    print(f"\n  Ready to run:")
    print(f"  npx tsx src/eval/gaia-harness.ts --limit 5")
    print(f"  npx tsx src/eval/gaia-harness.ts --level 1")
    print(f"  npx tsx src/eval/gaia-harness.ts")
    print()


if __name__ == "__main__":
    main()
