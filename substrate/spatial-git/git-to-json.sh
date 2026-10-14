#!/bin/bash
# git-to-json.sh - Extract git history as JSON for Spatial Git
# Usage: ./git-to-json.sh [repo_path] [max_commits]

set -e

REPO_PATH="${1:-.}"
MAX_COMMITS="${2:-100}"
OUTPUT="git-history.json"

cd "$REPO_PATH"

if [ ! -d ".git" ]; then
    echo "Error: Not a git repository: $REPO_PATH" >&2
    exit 1
fi

echo "Extracting git history from $REPO_PATH..."

# Get all branches
BRANCHES=$(git branch -a --format='%(refname:short)' | grep -v 'HEAD' | head -20)

# Start JSON
echo "{" > "$OUTPUT"
echo '  "branches": [' >> "$OUTPUT"

# Write branches
first_branch=true
for branch in $BRANCHES; do
    if [ "$first_branch" = true ]; then
        first_branch=false
    else
        echo "," >> "$OUTPUT"
    fi
    echo -n "    \"$branch\"" >> "$OUTPUT"
done
echo "" >> "$OUTPUT"
echo "  ]," >> "$OUTPUT"

# Get commits with details
echo '  "commits": [' >> "$OUTPUT"

# Format: hash|author|date|message|parent_hashes
git log --all --pretty=format:"%H|%an|%aI|%s|%P" -n "$MAX_COMMITS" | \
while IFS='|' read -r hash author date message parents; do
    # Get branch for this commit
    branch=$(git branch -a --contains "$hash" 2>/dev/null | head -1 | sed 's/^[* ]*//' | sed 's/remotes\///')
    branch="${branch:-main}"
    
    # Get changed files (limit to avoid huge commits)
    files=$(git show --name-status --format="" "$hash" 2>/dev/null | head -10 | \
        awk -F'\t' '{
            type="modified"
            if ($1 == "A") type="added"
            else if ($1 == "D") type="deleted"
            else if ($1 ~ /^R/) type="renamed"
            printf "{\"path\":\"%s\",\"type\":\"%s\"},", $NF, type
        }' | sed 's/,$//')
    
    # Escape message for JSON
    message=$(echo "$message" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | sed 's/	/ /g')
    
    # Build parent array
    parent_json=""
    for p in $parents; do
        if [ -n "$parent_json" ]; then
            parent_json="$parent_json,"
        fi
        parent_json="$parent_json\"$p\""
    done
    
    echo "    {"
    echo "      \"hash\": \"${hash:0:7}\","
    echo "      \"fullHash\": \"$hash\","
    echo "      \"author\": \"$author\","
    echo "      \"date\": \"$date\","
    echo "      \"message\": \"$message\","
    echo "      \"branch\": \"$branch\","
    echo "      \"parents\": [$parent_json],"
    echo "      \"files\": [$files]"
    echo -n "    }"
done >> "$OUTPUT"

# Check if we need to remove trailing comma and fix JSON
# This is a simple approach - in production use jq
sed -i '' 's/}$/},/' "$OUTPUT" 2>/dev/null || sed -i 's/}$/},/' "$OUTPUT"
# Remove last comma before closing bracket
sed -i '' '$ s/},$/}/' "$OUTPUT" 2>/dev/null || sed -i '$ s/},$/}/' "$OUTPUT"

echo "" >> "$OUTPUT"
echo "  ]" >> "$OUTPUT"
echo "}" >> "$OUTPUT"

# Validate JSON (if jq available)
if command -v jq &> /dev/null; then
    if jq . "$OUTPUT" > /dev/null 2>&1; then
        COMMIT_COUNT=$(jq '.commits | length' "$OUTPUT")
        BRANCH_COUNT=$(jq '.branches | length' "$OUTPUT")
        echo "✓ Exported $COMMIT_COUNT commits across $BRANCH_COUNT branches to $OUTPUT"
    else
        echo "Warning: JSON may be malformed. Consider manual review." >&2
    fi
else
    echo "✓ Exported to $OUTPUT (install jq for validation)"
fi

echo ""
echo "To visualize:"
echo "  cd $(dirname "$OUTPUT")"
echo "  python3 -m http.server 8080"
echo "  open http://localhost:8080"
