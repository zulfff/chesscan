#!/usr/bin/env bash
# End-to-end check of the three stages that need eyes on them:
#   detect  -> grid rect on a full screenshot
#   classify-> learn prototypes from the detected crop
#   fen     -> reconstruct the exact start FEN (and castling rights)
#
# Runs entirely on the synthetic fixtures from make_board / make_screen, so it
# needs no display and no chess site. Exits non-zero on the first bad result.
#
#   ./tools/validate-pipeline.sh          # build then validate
#   ./tools/validate-pipeline.sh --quick  # reuse target/debug binaries

set -u

cd "$(dirname "$0")/.." || exit 1
BIN=./target/debug
START="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"
START_FEN="$START w KQkq - 0 1"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/chesscan-validate.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "PASS  $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL  $*"; }

if [ "${1:-}" != "--quick" ]; then
  cargo build --quiet --bin chesscan --bin make_board --bin make_screen || exit 1
fi

# Standard start-position piece on (file, rank), rank 0 = rank 1.
piece_at() {
  local back=(R N B Q K B N R)
  case $2 in
    0) echo "${back[$1]}" ;;
    1) echo P ;;
    6) echo p ;;
    7) echo "${back[$1],,}" ;;
    *) echo . ;;
  esac
}

# Probe the cluster order with dummy labels, then label each cluster from the
# first example square the calibrator prints.
labels_for_shot() { # shot cfg orientation-flag -> comma list
  local shot=$1 cfg=$2 flip=$3
  local probe labels=() line sq f r
  probe=$(CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$shot" --calibrate \
    ${flip:+--flip} --labels ".,.,.,.,.,.,.,.,.,.,.,.,." 2>&1)
  while IFS= read -r line; do
    sq=$(sed -n 's/.*\[\([a-h][1-8]\)[^]]*\].*/\1/p' <<<"$line")
    [ -z "$sq" ] && continue
    f=$(( $(printf '%d' "'${sq:0:1}") - 97 ))
    r=$(( ${sq:1:1} - 1 ))
    labels+=("$(piece_at "$f" "$r")")
  done < <(grep -E '^  #[0-9]+' <<<"$probe")
  [ "${#labels[@]}" -eq 13 ] || return 1
  (IFS=,; echo "${labels[*]}")
}

# Detection + classification + FEN on a board pasted into UI chrome.
run_case() { # name size x y
  local name=$1 size=$2 x=$3 y=$4
  local cfg="$WORK/cfg-$name.json" board="$WORK/board-$name.png" shot="$WORK/shot-$name.png"
  "$BIN/make_board" "$board" >/dev/null || { bad "$name: make_board"; return; }
  "$BIN/make_screen" "$shot" "$x" "$y" "$size" "$board" >/dev/null \
    || { bad "$name: make_screen"; return; }

  local out rect coords gw gx gy
  out=$(CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$shot" --detect 2>&1)
  rect=$(sed -n 's/.*board detected: \([0-9]*x[0-9]*\) at \([0-9]*,[0-9]*\).*/\1 @ \2/p' <<<"$out")
  [ -n "$rect" ] || { bad "$name: no board detected ($out)"; return; }
  gw=${rect%% *}; gw=${gw%x*}
  coords=${rect#*@ }; gx=${coords%,*}; gy=${coords##*,}
  if [ "$gw" -ne "$size" ] || [ "$gx" -ne "$x" ] || [ "$gy" -ne "$y" ]; then
    bad "$name: detector returned ${gw}px at ${gx},${gy}, want ${size}px at ${x},${y}"
    return
  fi

  local labels
  labels=$(labels_for_shot "$shot" "$cfg" "") || { bad "$name: expected 13 clusters"; return; }
  CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$shot" --calibrate \
    --labels "$labels" >/dev/null 2>&1
  local snap fen
  snap=$(CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$shot" --snapshot 2>&1)
  fen=$(sed -n 's/^FEN: //p' <<<"$snap")
  if [ "$fen" = "$START_FEN" ]; then
    ok "$name: rect ${gw}px @ ${gx},${gy}; FEN exact"
  else
    bad "$name: FEN ${fen:-<none: $(tail -1 <<<"$snap")>}"
  fi
}

# Custom placement, including castling inference and flipped orientation.
fen_case() { # name placement castle flip
  local name=$1 placement=$2 castle=$3 flip=$4
  local cfg="$WORK/cfg-$name.json" board="$WORK/board-$name.png" shot="$WORK/shot-$name.png"
  "$BIN/make_board" "$board" "$placement" >/dev/null || { bad "$name: make_board"; return; }
  "$BIN/make_screen" "$shot" 620 120 640 "$board" >/dev/null \
    || { bad "$name: make_screen"; return; }
  CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$shot" --detect >/dev/null

  # file,rank -> piece from the placement string.
  local -A piece=()
  local r=7 row f i ch
  while IFS= read -r row; do
    f=0
    for ((i = 0; i < ${#row}; i++)); do
      ch=${row:$i:1}
      if [[ $ch =~ [0-9] ]]; then
        f=$((f + ch))
      else
        piece[$f,$r]=$ch
        f=$((f + 1))
      fi
    done
    r=$((r - 1))
  done < <(tr '/' '\n' <<<"$placement")

  local probe labels=() line sq lf lr
  probe=$(CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$shot" --calibrate \
    ${flip:+--flip} --labels ".,.,.,.,.,.,.,.,.,.,.,.,." 2>&1)
  while IFS= read -r line; do
    sq=$(sed -n 's/.*\[\([a-h][1-8]\)[^]]*\].*/\1/p' <<<"$line")
    [ -z "$sq" ] && continue
    lf=$(( $(printf '%d' "'${sq:0:1}") - 97 ))
    lr=$(( ${sq:1:1} - 1 ))
    labels+=("${piece[$lf,$lr]:-.}")
  done < <(grep -E '^  #[0-9]+' <<<"$probe")
  [ "${#labels[@]}" -eq 13 ] || { bad "$name: expected 13 clusters"; return; }
  local joined
  joined=$(IFS=,; echo "${labels[*]}")
  CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$shot" --calibrate \
    ${flip:+--flip} --labels "$joined" >/dev/null 2>&1

  local snap fen want="$placement w $castle - 0 1"
  snap=$(CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$shot" --snapshot ${flip:+--flip} 2>&1)
  fen=$(sed -n 's/^FEN: //p' <<<"$snap")
  if [ "$fen" = "$want" ]; then
    ok "$name: FEN exact"
  else
    bad "$name: got ${fen:-<none: $(tail -1 <<<"$snap")>}, want $want"
  fi
}

echo "chesscan pipeline validation ($WORK)"
echo
for spec in "s400 400 500 260" "s480 480 620 240" "s560 560 300 180" \
            "s640a 640 620 120" "s640b 640 120 300" "s720 720 760 90" \
            "s800 800 100 80"; do
  # shellcheck disable=SC2086
  run_case $spec
done

fen_case castled   "r2q1rk1/pp2bppp/2n1pn2/2bp4/2BP4/2N1PN2/PP2BPPP/R1BQ1RK1" -     ""
fen_case uncastled "r3k2r/pp1n1ppp/2pb1n2/3p4/3P4/2N1PN2/PP1B1PPP/R2QKB1R"     KQkq  ""
fen_case flipped   "$START"                                                     KQkq  --flip

# A page with UI chrome but no board must be rejected, not guessed at.
"$BIN/make_screen" "$WORK/shot-none.png" 620 120 0 >/dev/null
if CHESSCAN_CONFIG="$WORK/cfg-none.json" "$BIN/chesscan" \
  --file "$WORK/shot-none.png" --detect >/dev/null 2>&1; then
  bad "boardless: detector invented a rect"
else
  ok "boardless: no board reported"
fi

# A start position read after a fresh detect, from prototypes learned on a
# different crop of the same pixels: catches a one-pixel rect phase shift.
cfg=$WORK/cfg-cross.json
CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$WORK/board-s640a.png" \
  --rect 0,0,640,640 >/dev/null 2>&1
labels=$(labels_for_shot "$WORK/board-s640a.png" "$cfg" "") || labels=
if [ -n "$labels" ]; then
  CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$WORK/board-s640a.png" \
    --calibrate --labels "$labels" >/dev/null 2>&1
  CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$WORK/shot-s640a.png" --detect >/dev/null
  fen=$(CHESSCAN_CONFIG="$cfg" "$BIN/chesscan" --file "$WORK/shot-s640a.png" \
    --snapshot 2>&1 | sed -n 's/^FEN: //p')
  if [ "$fen" = "$START_FEN" ]; then
    ok "cross-crop: re-detected rect reads the calibrated board"
  else
    bad "cross-crop: got ${fen:-<none>}"
  fi
else
  bad "cross-crop: could not label bare-board clusters"
fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]