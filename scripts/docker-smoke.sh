#!/bin/sh
# Exercise the built production image with empty test sources: no provider calls.
set -eu

image="${1:-blackwell-index:verify}"
resource="sbx-cli-smoke-$$"
volume="${resource}-data"
container="$resource"
cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker volume create "$volume" >/dev/null
docker run --rm --network none --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,source=$volume,target=/var/lib/sbx" \
  "$image" setup --dir /var/lib/sbx --host 0.0.0.0 --providers "" >/dev/null
docker run --detach --name "$container" --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --publish 127.0.0.1::3410 \
  --mount "type=volume,source=$volume,target=/var/lib/sbx" \
  "$image" >/dev/null

await_node() {
  required_captures="$1"
  attempt=0
  address="$(docker port "$container" 3410/tcp)"
  while [ "$attempt" -lt 30 ]; do
    if curl --fail --silent --max-time 2 "http://$address/v1/status" | \
      bun -e 'const s=JSON.parse(await Bun.stdin.text()); if(s.counts.captures < Number(process.argv[1]) || s.pyth !== "NOT_PUBLISHED") process.exit(1);' "$required_captures" 2>/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  docker logs "$container"
  return 1
}
node_id() {
  curl --fail --silent --max-time 2 "http://$address/v1/status" | \
    bun -e 'const s=JSON.parse(await Bun.stdin.text()); if(typeof s.nodeId !== "string" || !s.nodeId) process.exit(1); console.log(s.nodeId);'
}

await_node 1
curl --fail --silent --max-time 2 "http://$address/healthz" >/dev/null
readiness="$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "http://$address/v1/ready")"
[ "$readiness" = "503" ]
original_id="$(node_id)"
docker stop --time 10 "$container" >/dev/null
docker start "$container" >/dev/null
await_node 2
[ "$(node_id)" = "$original_id" ]
docker exec "$container" bun /app/src/cli.ts reproduce --dir /var/lib/sbx --sequence 1 | \
  bun -e 'const r=JSON.parse(await Bun.stdin.text()); if(r.matches !== true || r.history.valid !== true) process.exit(1);'
docker exec "$container" bun -e 'import {statSync} from "node:fs"; for (const p of ["node-identity.json","node.sqlite"]) if((statSync(`/var/lib/sbx/data/${p}`).mode & 0o777) !== 0o600) process.exit(1);'
printf '%s\n' 'Container setup, local API, unavailable-data readiness, restart identity and archived reproduction passed.'
