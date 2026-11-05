#!/bin/bash
input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd')
model=$(echo "$input" | jq -r '.model.display_name')
ctx=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Shorten home dir to ~
short_cwd="${cwd/#$HOME/\~}"

# Git branch (skip locks to avoid contention)
branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)

# Build progress bar for context (10 chars wide)
ctx_display=""
if [ -n "$ctx" ]; then
    pct=$(printf '%.0f' "$ctx")
    filled=$(( pct * 10 / 100 ))
    # Green up to 40%, yellow past 40%, red past 60%.
    if [ "$pct" -gt 60 ]; then color='\033[31m'
    elif [ "$pct" -gt 40 ]; then color='\033[33m'
    else color='\033[32m'
    fi
    full="" empty=""
    for i in $(seq 1 10); do
        [ "$i" -le "$filled" ] && full="${full}█" || empty="${empty}░"
    done
    ctx_display=$(printf "[${color}%s\033[2m%s\033[0m] ${color}%d%%\033[0m" "$full" "$empty" "$pct")
fi

line=$(printf '\033[34m%s\033[0m' "$short_cwd")
[ -n "$branch" ] && line="$line $(printf '\033[33m(%s)\033[0m' "$branch")"
line="$line $(printf '\033[36m[%s]\033[0m' "$model")"
[ -n "$ctx_display" ] && line="$line $ctx_display"
printf '%s' "$line"
