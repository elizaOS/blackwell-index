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

# Back up the running WAL journal. The disposable test key stays inside this
# smoke-test volume; real recovery keys must be protected separately.
docker exec "$container" bun /app/src/cli.ts backup-keygen --dir /var/lib/sbx --output recovery.key >/dev/null
docker exec "$container" bun /app/src/cli.ts backup --dir /var/lib/sbx --key-file recovery.key --output recovery.bundle | \
  bun -e 'const r=JSON.parse(await Bun.stdin.text()); if(r.sourceNodeId !== process.argv[1] || r.history.valid !== true || r.reproducedSnapshots < 2 || r.privateKeysIncluded !== false || r.providerCredentialsIncluded !== false) process.exit(1);' "$original_id"
docker exec "$container" bun /app/src/cli.ts backup-inspect --dir /var/lib/sbx --key-file recovery.key --input recovery.bundle | \
  bun -e 'const r=JSON.parse(await Bun.stdin.text()); if(r.sourceNodeId !== process.argv[1] || r.history.valid !== true || r.counts.captures < 2 || r.reproducedSnapshots < 2) process.exit(1);' "$original_id"
docker exec "$container" bun -e 'import {readFileSync,statSync} from "node:fs"; for(const name of ["recovery.key","recovery.bundle"]) if((statSync(`/var/lib/sbx/${name}`).mode & 0o777) !== 0o600) process.exit(1); const bundle=JSON.parse(readFileSync("/var/lib/sbx/recovery.bundle","utf8")); if(bundle.format !== "SBX_NODE_RECOVERY_V1" || typeof bundle.ciphertext !== "string" || Object.keys(bundle).sort().join(",") !== "ciphertext,format,nonce,tag") process.exit(1);'
docker stop --time 10 "$container" >/dev/null

offline_cli() {
  docker run --rm --network none --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=volume,source=$volume,target=/var/lib/sbx" "$image" "$@"
}
restored_id="$(offline_cli restore --dir /var/lib/sbx --key-file recovery.key --input recovery.bundle --target restored | \
  bun -e 'const r=JSON.parse(await Bun.stdin.text()); if(r.sourceNodeId !== process.argv[1] || r.newNodeId === r.sourceNodeId || !/^[a-f0-9]{64}$/.test(r.newNodeId) || r.status !== "RECOVERY_REVIEW_REQUIRED" || r.history.valid !== true) process.exit(1); console.log(r.newNodeId);' "$original_id")"
offline_cli status --dir /var/lib/sbx/restored | \
  bun -e 'const r=JSON.parse(await Bun.stdin.text()); if(r.nodeId !== process.argv[1] || r.history.valid !== true || r.counts.captures < 2 || r.snapshot.publishable !== false) process.exit(1);' "$restored_id"
offline_cli reproduce --dir /var/lib/sbx/restored --sequence 1 | \
  bun -e 'const r=JSON.parse(await Bun.stdin.text()); if(r.matches !== true || r.history.valid !== true) process.exit(1);'

# Verify the safety interlock in the actual image, with a deadline so a
# regression that starts the server cannot leave CI running indefinitely.
docker run --rm --network none --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,source=$volume,target=/var/lib/sbx" --entrypoint bun "$image" -e '
  import {existsSync,readFileSync,statSync} from "node:fs";
  const root="/var/lib/sbx/restored",config=JSON.parse(readFileSync(`${root}/config/node.local.json`,"utf8"));
  if(config.collectors.length || config.peers.length || config.host !== "127.0.0.1" || config.pythManifestPath || existsSync(`${root}/data/credentials.json`)) throw new Error("Restored configuration is not isolated");
  for(const name of ["node-identity.json","node.sqlite","RECOVERY_REVIEW_REQUIRED.json"]) if((statSync(`${root}/data/${name}`).mode & 0o777) !== 0o600) throw new Error("Restored file is not private");
  for(const command of ["run","collect"]){
    const child=Bun.spawn(["bun","/app/src/cli.ts",command,"--dir",root],{stdout:"pipe",stderr:"pipe"});
    let timedOut=false; const timeout=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},5000);
    const [code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timeout);
    if(timedOut || code === 0 || !`${out}${error}`.includes("RECOVERY_REVIEW_REQUIRED")) throw new Error(`Recovery ${command} interlock failed`);
  }'
printf '%s\n' 'Container API, fail-closed readiness, persistent identity, replay, encrypted backup and isolated recovery passed.'
