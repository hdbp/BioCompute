#!/usr/bin/env bash
# Per-sample FASTQ statistics (portable: bash, awk, gzip only).
# usage: fastq_stats.sh SAMPLE MIN_LEN MIN_MEANQ MAX_READS R1 [R2]
set -euo pipefail
sample="$1"; minlen="$2"; minq="$3"; maxreads="$4"; shift 4
[ $# -ge 1 ] || { echo "no FASTQ files given" >&2; exit 2; }
stats="${sample}.stats.tsv"
reads="${sample}.reads.tsv"
printf "sample\tfile\tread\treads\tbases\tmean_length\tgc_percent\tmean_quality\tpct_q30_bases\treads_pass\tpct_pass\n" > "$stats"
printf "sample\tread\tgc_percent\tmean_quality\tlength\n" > "$reads"
r=1
for f in "$@"; do
  [ -s "$f" ] || { echo "input file is missing or empty: $f" >&2; exit 3; }
  case "$f" in *.gz) reader="gzip -dc";; *) reader="cat";; esac
  limit=$(( maxreads > 0 ? maxreads * 4 : 0 ))
  { if [ "$limit" -gt 0 ]; then $reader "$f" | head -n "$limit" || true; else $reader "$f"; fi; } | awk \
    -v s="$sample" -v fn="$(basename "$f")" -v rd="F$r" -v minlen="$minlen" -v minq="$minq" -v readsout="$reads" '
    BEGIN { for (i = 33; i < 127; i++) ord[sprintf("%c", i)] = i; srand(42) }
    NR % 4 == 1 && substr($0, 1, 1) != "@" { print "malformed FASTQ record at line " NR > "/dev/stderr"; exit 4 }
    NR % 4 == 2 { seq = $0; L = length(seq); n++; b += L; g = gsub(/[GCgc]/, "", seq); gc += g }
    NR % 4 == 0 {
      q = 0; q30 = 0
      for (i = 1; i <= length($0); i++) { v = ord[substr($0, i, 1)] - 33; q += v; if (v >= 30) q30++ }
      tq += q; tq30 += q30; mq = (L ? q / L : 0)
      if (L >= minlen && mq >= minq) pass++
      if (n <= 5000) printf "%s\t%s\t%.2f\t%.2f\t%d\n", s, rd, (L ? 100 * g / L : 0), mq, L >> readsout
    }
    END {
      if (NR % 4 != 0) { print "truncated FASTQ (line count not divisible by 4)" > "/dev/stderr"; exit 5 }
      printf "%s\t%s\t%s\t%d\t%d\t%.2f\t%.2f\t%.2f\t%.2f\t%d\t%.2f\n", s, fn, rd, n, b, (n ? b / n : 0),
        (b ? 100 * gc / b : 0), (b ? tq / b : 0), (b ? 100 * tq30 / b : 0), pass, (n ? 100 * pass / n : 0)
    }' >> "$stats"
  r=$((r + 1))
done
