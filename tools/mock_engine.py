#!/usr/bin/env python3
"""Mock UCI engine: pretends to be Stockfish so the engine loop can be tested
without a 100MB binary. Emits fixed MultiPV lines for whatever position it gets.

usage: chesscan --engine ./tools/mock_engine.py
"""
import sys

depth = 18


def main() -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if line == "uci":
            print("id name Mockfish 1.0", flush=True)
            print("id author nobody", flush=True)
            print("option name MultiPV type spin default 1 min 1 max 500", flush=True)
            print("uciok", flush=True)
        elif line == "isready":
            print("readyok", flush=True)
        elif line.startswith("go"):
            # Three plausible opening lines, centipawns from side to move.
            lines = [
                (1, 34, "e2e4 e7e5 g1f3 b8c6"),
                (2, 22, "d2d4 d7d5 c2c4"),
                (3, 15, "g1f3 g8f6 c2c4"),
            ]
            for mpv, cp, pv in lines:
                print(
                    f"info depth {depth} multipv {mpv} score cp {cp} nodes 1200000 nps 800000 "
                    f"time 1500 pv {pv}",
                    flush=True,
                )
            print("bestmove e2e4", flush=True)
        elif line == "quit":
            return


if __name__ == "__main__":
    main()
