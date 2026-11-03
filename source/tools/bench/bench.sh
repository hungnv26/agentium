#!/bin/sh
# Agentium benchmark: how fast the simulation runs a replay headless, and how the renderer
# performs playing it back in a window.
#
#   source/tools/bench/bench.sh sim    <commands.txt> [runs]        headless, prints turns/s and the final-state hash
#   source/tools/bench/bench.sh render <commands.txt> [seconds] [backend...]
#                                                       windowed replay for N seconds per backend (gl, vulkan, dummy),
#                                                       prints average and 1% low frame times from the profiler
#   source/tools/bench/bench.sh all    <commands.txt>
#
# Results are appended to bench/results/<date>.json in the repository (gitignored).
# A deterministic replay comes from any Arena match (arena/.data/matches/<id>.json -> commandsTxt).
set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GAME="${PYROGENESIS:-$ROOT/binaries/system/pyrogenesis}"
LOGS="$HOME/Library/Application Support/agentium/logs"
OUT="$ROOT/bench/results"
SUMMARY="$ROOT/source/tools/bench/bench_summary.py"
mkdir -p "$OUT"

die() {
	echo "ERROR: $*" >&2
	exit 1
}

[ -x "$GAME" ] || die "game binary not found at $GAME"
mode="${1:-}"
replay="${2:-}"
[ -n "$mode" ] && [ -f "$replay" ] || die "usage: bench.sh sim|render|all <commands.txt> [...]"
turns=$(grep -c '^turn' "$replay")
stamp=$(date +%Y-%m-%d_%H-%M-%S)
result="$OUT/$stamp.json"

sim_bench() {
	runs="${1:-2}"
	echo "sim: $turns turns, $runs run(s)"
	i=0
	while [ "$i" -lt "$runs" ]; do
		start=$(python3 -c 'import time; print(time.time())')
		hash=$("$GAME" -replay="$replay" -hashtest-full=false 2>&1 | sed -n 's/^# Final state: //p')
		end=$(python3 -c 'import time; print(time.time())')
		python3 -I "$SUMMARY" sim "$result" "$replay" "$turns" "$start" "$end" "$hash"
		i=$((i + 1))
	done
}

render_bench() {
	seconds="${1:-60}"
	shift || true
	[ $# -gt 0 ] || set -- gl
	for backend in "$@"; do
		echo "render: $backend for $seconds s"
		rm -f "$LOGS/profile2.jsonp"
		"$GAME" -replay-visual="$replay" -windowed -nosound \
			-conf=rendererbackend:"$backend" -conf=profiler2.autoenable:true -conf=vsync:false \
			-conf=adaptivefps.session:200 >/dev/null 2>&1 &
		pid=$!
		sleep "$seconds"
		# Ask the profiler to dump its buffers, then stop the game.
		curl -s -m 10 http://127.0.0.1:8000/download >/dev/null || echo "  (profiler did not answer; is profiler2.autoenable honoured?)"
		sleep 1
		kill "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
		if [ -f "$LOGS/profile2.jsonp" ]; then
			python3 -I "$SUMMARY" render "$result" "$replay" "$backend" "$seconds" "$LOGS/profile2.jsonp" "$LOGS/mainlog.html"
		else
			echo "  no profile2.jsonp written"
		fi
	done
}

case "$mode" in
sim) sim_bench "${3:-2}" ;;
render)
	shift 2
	render_bench "$@"
	;;
all)
	sim_bench 2
	render_bench 60 gl vulkan
	;;
*) die "unknown mode $mode" ;;
esac
echo "results: $result"
