#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Prune old, unused production Docker image tags left by consecutive deploys.

Dry-run is the default. Pass --execute to remove candidates.

Usage:
  scripts/prune-production-images.sh [options]

Options:
  --execute                 Actually remove image tags. Default only prints the plan.
  --compose-file PATH       Compose file path. Default: docker-compose.prod.yml.
  --env-file PATH           Env file used by compose. Default: .env.
  --keep-recent N           Keep this many recent unused tags per repository. Default: 3.
  --min-age-hours HOURS     Only remove unused tags older than this. Default: 24.
  --repo IMAGE_REPOSITORY   Extra repository to scan. Can be passed more than once.
  --tag-pattern PATTERN     Bash glob for removable tags. Default: sha-*.
  --skip-dangling           Do not prune dangling images after tagged cleanup.
  -h, --help                Show this help.

The script only targets application repositories from IMAGE_NAME and WEB_IMAGE_NAME
in the env file, plus any --repo values. It never removes an image ID currently used
by an existing container.
USAGE
}

EXECUTE=0
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
KEEP_RECENT=3
MIN_AGE_HOURS=24
TAG_PATTERN="sha-*"
PRUNE_DANGLING=1
EXTRA_REPOS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      EXECUTE=1
      shift
      ;;
    --compose-file)
      COMPOSE_FILE="${2:?missing value for --compose-file}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?missing value for --env-file}"
      shift 2
      ;;
    --keep-recent)
      KEEP_RECENT="${2:?missing value for --keep-recent}"
      shift 2
      ;;
    --min-age-hours)
      MIN_AGE_HOURS="${2:?missing value for --min-age-hours}"
      shift 2
      ;;
    --repo)
      EXTRA_REPOS+=("${2:?missing value for --repo}")
      shift 2
      ;;
    --tag-pattern)
      TAG_PATTERN="${2:?missing value for --tag-pattern}"
      shift 2
      ;;
    --skip-dangling)
      PRUNE_DANGLING=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$KEEP_RECENT" =~ ^[0-9]+$ ]]; then
  echo "--keep-recent must be a non-negative integer" >&2
  exit 2
fi

if ! [[ "$MIN_AGE_HOURS" =~ ^[0-9]+$ ]]; then
  echo "--min-age-hours must be a non-negative integer" >&2
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 2
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 2
fi

read_env_value() {
  local key="$1"
  local value

  value="$(
    grep -E "^[[:space:]]*${key}=" "$ENV_FILE" \
      | tail -n 1 \
      | sed -E "s/^[[:space:]]*${key}=//" \
      | tr -d '\r'
  )"

  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

add_unique() {
  local item="$1"
  local existing

  [[ -n "$item" ]] || return 0
  for existing in "${UNIQUE_VALUES[@]}"; do
    [[ "$existing" == "$item" ]] && return 0
  done
  UNIQUE_VALUES+=("$item")
}

SERVER_REPO="$(read_env_value IMAGE_NAME || true)"
WEB_REPO="$(read_env_value WEB_IMAGE_NAME || true)"
CURRENT_TAG="$(read_env_value IMAGE_TAG || true)"
CURRENT_TAG="${CURRENT_TAG:-latest}"

UNIQUE_VALUES=()
add_unique "$SERVER_REPO"
add_unique "$WEB_REPO"
for repo in "${EXTRA_REPOS[@]}"; do
  add_unique "$repo"
done
REPOS=("${UNIQUE_VALUES[@]}")

if [[ "${#REPOS[@]}" -eq 0 ]]; then
  echo "No image repositories found. Set IMAGE_NAME/WEB_IMAGE_NAME or pass --repo." >&2
  exit 2
fi

mapfile -t USED_IMAGE_IDS < <(
  docker ps -aq \
    | xargs -r docker inspect -f '{{.Image}}' \
    | sed 's/^sha256://; s/:.*$//' \
    | sort -u
)

is_used_image_id() {
  local image_id="$1"
  local used_id

  for used_id in "${USED_IMAGE_IDS[@]}"; do
    [[ "$used_id" == "$image_id"* || "$image_id" == "$used_id"* ]] && return 0
  done
  return 1
}

image_epoch() {
  local ref="$1"
  local created

  created="$(docker image inspect -f '{{.Created}}' "$ref" 2>/dev/null || true)"
  [[ -n "$created" ]] || {
    echo 0
    return 0
  }

  date -d "$created" +%s 2>/dev/null || echo 0
}

now_epoch="$(date +%s)"
min_age_seconds=$((MIN_AGE_HOURS * 3600))
removal_refs=()

echo "Docker image cleanup"
echo "Mode: $([[ "$EXECUTE" -eq 1 ]] && echo execute || echo dry-run)"
echo "Compose file: $COMPOSE_FILE"
echo "Env file: $ENV_FILE"
echo "Current deploy tag: $CURRENT_TAG"
echo "Keep recent unused tags per repo: $KEEP_RECENT"
echo "Minimum age: ${MIN_AGE_HOURS}h"
echo "Removable tag pattern: $TAG_PATTERN"
echo

for repo in "${REPOS[@]}"; do
  echo "Scanning repository: $repo"

  mapfile -t rows < <(
    docker image ls "$repo" --format '{{.Repository}}	{{.Tag}}	{{.ID}}' \
      | while IFS=$'\t' read -r image_repo tag image_id; do
          [[ -n "$image_repo" && -n "$tag" && -n "$image_id" ]] || continue
          [[ "$tag" != "<none>" ]] || continue
          ref="${image_repo}:${tag}"
          epoch="$(image_epoch "$ref")"
          printf '%s\t%s\t%s\t%s\n' "$epoch" "$tag" "$image_id" "$ref"
        done \
      | sort -rn
  )

  if [[ "${#rows[@]}" -eq 0 ]]; then
    echo "  No local tags found for this repository."
    continue
  fi

  kept_recent=0
  for row in "${rows[@]}"; do
    IFS=$'\t' read -r epoch tag image_id ref <<< "$row"

    if [[ "$tag" == "latest" || "$tag" == "$CURRENT_TAG" ]]; then
      echo "  keep current/special: $ref"
      continue
    fi

    if [[ ! "$tag" == $TAG_PATTERN ]]; then
      echo "  keep unmatched tag: $ref"
      continue
    fi

    if is_used_image_id "$image_id"; then
      echo "  keep used by container: $ref"
      continue
    fi

    if [[ "$kept_recent" -lt "$KEEP_RECENT" ]]; then
      kept_recent=$((kept_recent + 1))
      echo "  keep rollback candidate: $ref"
      continue
    fi

    age_seconds=$((now_epoch - epoch))
    if [[ "$epoch" -le 0 || "$age_seconds" -lt "$min_age_seconds" ]]; then
      echo "  keep too new/unknown age: $ref"
      continue
    fi

    echo "  remove candidate: $ref"
    removal_refs+=("$ref")
  done
done

echo
if [[ "${#removal_refs[@]}" -eq 0 ]]; then
  echo "No tagged image candidates to remove."
else
  echo "Tagged image candidates:"
  printf '  %s\n' "${removal_refs[@]}"

  if [[ "$EXECUTE" -eq 1 ]]; then
    echo
    echo "Removing tagged image candidates..."
    docker image rm "${removal_refs[@]}" || true
  else
    echo
    echo "Dry-run only. Re-run with --execute to remove these tags."
  fi
fi

if [[ "$PRUNE_DANGLING" -eq 1 ]]; then
  echo
  if [[ "$EXECUTE" -eq 1 ]]; then
    echo "Pruning dangling images older than ${MIN_AGE_HOURS}h..."
    docker image prune -f --filter "until=${MIN_AGE_HOURS}h"
  else
    echo "Dry-run dangling prune command:"
    echo "  docker image prune -f --filter until=${MIN_AGE_HOURS}h"
  fi
fi

echo
docker system df
