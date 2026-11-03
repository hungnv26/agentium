#!/usr/bin/env python3
"""Summarise one benchmark run and append it to a results file (used by bench.sh).

sim:    bench_summary.py sim <result.json> <replay> <turns> <start> <end> <hash>
render: bench_summary.py render <result.json> <replay> <backend> <seconds> <profile2.jsonp> <mainlog.html>
"""

import json
import os
import platform
import re
import sys
from datetime import datetime


def load(path):
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    return {"host": f"{platform.machine()} {platform.platform()}", "runs": []}


def save(path, data):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)


def frame_times(jsonp_path):
    """Frame times of the main thread in ms, from the profiler's __framestart markers."""
    with open(jsonp_path, encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    main = text.find('"name":"main"')
    if main == -1:
        return []
    end = text.find('"name":"', main + 10)
    chunk = text[main:end if end != -1 else None]
    starts = [float(t) for t in re.findall(r'\[1,([0-9.]+),"__framestart"\]', chunk)]
    starts.sort()
    return [(b - a) * 1000 for a, b in zip(starts, starts[1:]) if 0 < b - a < 5]


def renderer_from_log(mainlog):
    """The backend and driver, from system_info.txt next to the main log."""
    info = os.path.join(os.path.dirname(mainlog), "system_info.txt")
    if not os.path.isfile(info):
        return None
    with open(info, encoding="utf-8", errors="replace") as handle:
        lines = handle.read().splitlines()
    found = [line.strip() for line in lines if re.match(r"\s*(Backend|Video Driver|GPU|Video Card)\b", line)]
    return "; ".join(found)[:160] or None


def main():
    mode = sys.argv[1]
    result_path = sys.argv[2]
    data = load(result_path)
    if mode == "sim":
        _, _, _, replay, turns, start, end, final_hash = sys.argv
        seconds = float(end) - float(start)
        run = {
            "kind": "sim",
            "at": datetime.now().isoformat(timespec="seconds"),
            "replay": replay,
            "turns": int(turns),
            "seconds": round(seconds, 2),
            "turns_per_s": round(int(turns) / seconds, 1) if seconds else None,
            "ms_per_1000_turns": round(1000 * seconds / int(turns) * 1000, 1) if int(turns) else None,
            "final_state": final_hash,
        }
        previous = [r for r in data["runs"] if r["kind"] == "sim" and r["replay"] == replay and r.get("final_state")]
        if previous and previous[-1]["final_state"] != final_hash:
            run["warning"] = "final state differs from the previous run: the replay is not deterministic"
        print(f"  {run['turns']} turns in {run['seconds']} s = {run['turns_per_s']} turns/s, final state {final_hash}" + (f"  !! {run['warning']}" if "warning" in run else ""))
    else:
        _, _, _, replay, backend, seconds, jsonp, mainlog = sys.argv
        frames = frame_times(jsonp)
        frames_sorted = sorted(frames)
        n = len(frames_sorted)
        avg = sum(frames) / n if n else None
        low1 = frames_sorted[int(n * 0.99)] if n else None
        run = {
            "kind": "render",
            "at": datetime.now().isoformat(timespec="seconds"),
            "replay": replay,
            "backend": backend,
            "seconds": float(seconds),
            "frames": n,
            "avg_frame_ms": round(avg, 2) if avg else None,
            "fps": round(1000 / avg, 1) if avg else None,
            "p99_frame_ms": round(low1, 2) if low1 else None,
            "renderer": renderer_from_log(mainlog),
        }
        print(f"  {backend}: {n} frames, avg {run['avg_frame_ms']} ms ({run['fps']} fps), 1% low {run['p99_frame_ms']} ms; {run['renderer']}")
    data["runs"].append(run)
    save(result_path, data)


if __name__ == "__main__":
    main()
