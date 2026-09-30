#!/usr/bin/env bash
# Commit and push whatever changed under data/, rebasing onto anything pushed meanwhile.
set -e
if [ -z "$(git status --porcelain data)" ]; then
  echo "No changes."
  exit 0
fi
git config user.name "sumods-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add data
git commit -m "$1"
for attempt in 1 2 3; do
  git pull --rebase && git push && exit 0
  sleep $((attempt * 5))
done
exit 1
