# Python stdlib text trajectory delta skill

Status: `Quarantined`

## Activation Boundary

- task family is text
- candidate path is one of src/text_tools.py
- starter function matches one of count_word_frequencies, extract_hashtags, normalize_whitespace, slugify_text, strip_markdown_links

## Do Not Activate When

- do not activate until regressions are repaired: py_v1_extract_hashtags

## Evidence

- Repairs: none
- Regressions: py_v1_extract_hashtags
- Shared failures: none

## Usage Rule

This skill caused or co-occurred with regressions. Use it only as diagnostic evidence for a future repair skill.
