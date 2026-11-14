#!/bin/bash
# gh, but every comment the agent writes carries the factory marker, so the factory never reads the agent's
# own notes as a reviewer's request (that loop used up all review rounds on a task). The agent and a person
# can share one GitHub identity, so the marker, not the login, is what tells them apart.
# Covers: gh pr|issue comment (--body/-b, --body=, --body-file/-F), gh pr review (--body/-b, --body-file/-F)
# and gh api (-f/-F/--field/--raw-field body=...). Everything else passes through untouched.
REAL=/usr/local/lib/gh-real
MARK='<!-- openfactory -->'
mark() { printf '%s\n\n%s' "$1" "$MARK"; }

case "$1 $2" in
  "pr comment" | "issue comment" | "pr review") ;;
  *)
    if [ "$1" != "api" ]; then exec "$REAL" "$@"; fi
    ;;
esac

args=()
while [ $# -gt 0 ]; do
  a="$1"
  shift
  case "$a" in
    --body | -b)
      args+=("$a" "$(mark "$1")")
      shift
      ;;
    --body=*)
      args+=("--body=$(mark "${a#--body=}")")
      ;;
    --body-file | -F)
      # In `gh api`, -F is --field (key=value), not a file.
      if [ "${args[0]:-}" = "api" ] || [ "$1" != "${1#body=}" ]; then
        case "$1" in
          body=@*) args+=("$a" "$1") ;; # a file; left as is
          body=*) args+=("$a" "body=$(mark "${1#body=}")") ;;
          *) args+=("$a" "$1") ;;
        esac
      else
        tmp=$(mktemp)
        if [ "$1" = "-" ]; then cat >"$tmp"; else cat -- "$1" >"$tmp"; fi
        printf '\n\n%s\n' "$MARK" >>"$tmp"
        args+=("$a" "$tmp")
      fi
      shift
      ;;
    -f | --field | --raw-field)
      case "$1" in
        body=*) args+=("$a" "body=$(mark "${1#body=}")") ;;
        *) args+=("$a" "$1") ;;
      esac
      shift
      ;;
    *) args+=("$a") ;;
  esac
done
exec "$REAL" "${args[@]}"
