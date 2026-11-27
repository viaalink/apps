#!/usr/bin/env bun
/**
 * Package: s3
 * Purpose: set the storage up after it started, without a person:
 *          - the bucket and the key for the vault (the key reaches that bucket only),
 *          - the people's bucket and the policy "signed-in": whoever trades an
 *            Authentik sign-in for temporary keys gets a folder of their own
 *            there, named after their user name, and nothing else,
 *          and prove the vault's key reads and writes its bucket.
 *          Safe to run on every start: what is there is left as it is.
 * Usage:   bun packages/s3/scripts/setup.ts   (from the project folder)
 * Called by: `via app setup s3` (app.yaml), which the start recipe runs.
 * Needs:   S3_PORT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_VAULT_BUCKET, S3_PEOPLE_BUCKET in .env.
 * Exit:    0 when buckets, key and policies are in place, 1 otherwise.
 *
 * @module
 */
import { S3Client } from "bun";
import { envGet, ts } from "./_setup-env.ts";

const port = envGet("S3_PORT");
const vaultBucket = envGet("S3_VAULT_BUCKET");
const peopleBucket = envGet("S3_PEOPLE_BUCKET") || "people";
const accessKeyId = envGet("S3_ACCESS_KEY_ID");
const secretAccessKey = envGet("S3_SECRET_ACCESS_KEY");
const container = envGet("S3_CONTAINER_NAME") || `${envGet("CONTAINER_PREFIX")}s3`;
if (!port || !vaultBucket || !accessKeyId || !secretAccessKey) {
  console.error("[s3] ERROR: S3_PORT, S3_VAULT_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be in .env");
  process.exit(1);
}
const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
for (const name of [vaultBucket, peopleBucket]) {
  if (!bucketName.test(name)) {
    console.error(`[s3] ERROR: "${name}" is not a bucket name (lower-case letters, digits, dots and dashes)`);
    process.exit(1);
  }
}
if (!/^[A-Za-z0-9]{3,}$/.test(accessKeyId) || secretAccessKey.length < 8 || /\s/.test(secretAccessKey)) {
  console.error(
    "[s3] ERROR: S3_ACCESS_KEY_ID must be letters and digits, S3_SECRET_ACCESS_KEY at least 8 characters without spaces",
  );
  process.exit(1);
}
const endpoint = `http://127.0.0.1:${port}`;

function fail(message: string): never {
  console.error(`[s3] ERROR: ${message}`);
  process.exit(1);
}

/**
 * MinIO's own admin tool, inside the container, as the administrator. The administrator's key is
 * already in the container's environment; what is given on `input` reaches the tool on standard
 * input, so no secret is on a command line of this machine.
 */
function mc(command: string, input = ""): { ok: boolean; out: string } {
  const script = `export MC_CONFIG_DIR=/tmp/.mc; export MC_HOST_admin="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@127.0.0.1:9000"; ${command}`;
  const run = Bun.spawnSync(["docker", "exec", "-i", container, "sh", "-c", script], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.exitCode === 0, out: `${run.stdout.toString()}\n${run.stderr.toString()}`.trim() };
}

let up = false;
for (let waited = 0; waited < 180 && !up; waited += 2) {
  try {
    up = (await fetch(`${endpoint}/minio/health/live`, { headers: { connection: "close" } })).ok;
  } catch {
    // not up yet
  }
  if (!up) await Bun.sleep(2000);
}
if (!up) fail(`the storage does not answer on ${endpoint}. Read why: docker logs ${container}`);

for (const name of [vaultBucket, peopleBucket]) {
  const made = mc(`mc mb --ignore-existing admin/${name}`);
  if (!made.ok) fail(`could not make bucket ${name}: ${made.out.slice(0, 300)}`);
}
ts(`✓ Buckets ${vaultBucket} and ${peopleBucket} are there.`);

const policies: Record<string, unknown> = {
  "vault-only": {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:ListBucket", "s3:GetBucketLocation"], Resource: [`arn:aws:s3:::${vaultBucket}`] },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${vaultBucket}/*`],
      },
    ],
  },
  // For temporary keys from an Authentik sign-in: one's own folder, named after the user name in the token.
  "signed-in": {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${peopleBucket}`],
        Condition: { StringLike: { "s3:prefix": ["${jwt:preferred_username}/*"] } },
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${peopleBucket}/\${jwt:preferred_username}/*`],
      },
    ],
  },
};
for (const [name, policy] of Object.entries(policies)) {
  const made = mc(`mc admin policy create admin ${name} /dev/stdin`, JSON.stringify(policy));
  if (!made.ok) fail(`could not store the policy ${name}: ${made.out.slice(0, 300)}`);
}

// The vault's key: an account of its own with the vault-only policy. Adding it again keeps it as it is.
const added = mc(
  `read -r key; read -r secret; mc admin user add admin "$key" "$secret"`,
  `${accessKeyId}\n${secretAccessKey}\n`,
);
if (!added.ok) fail(`could not make the vault's key: ${added.out.slice(0, 300)}`);
const info = mc(`mc admin user info admin ${accessKeyId} --json`);
if (!info.ok) fail(`the vault's key is not there after it was made: ${info.out.slice(0, 300)}`);
if (!/"policyName"\s*:\s*"vault-only"/.test(info.out)) {
  const attached = mc(`mc admin policy attach admin vault-only --user ${accessKeyId}`);
  if (!attached.ok) fail(`could not give the vault's key its policy: ${attached.out.slice(0, 300)}`);
}

// The vault's key, used the way the vault uses it.
const client = new S3Client({
  accessKeyId,
  secretAccessKey,
  bucket: vaultBucket,
  endpoint,
  region: envGet("S3_REGION") || "us-east-1",
});
const probe = ".via-setup-check";
try {
  await client.write(probe, "ok");
  const back = await client.file(probe).text();
  await client.delete(probe);
  if (back !== "ok") fail("the vault's key wrote a file and read something else back");
} catch (error) {
  fail(
    `the vault's key does not read and write bucket ${vaultBucket}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
ts(`✓ The vault's key reads and writes ${vaultBucket} on ${endpoint}.`);
ts(`  To keep your vault here: bun "${process.env["VIA_APP_DIR"] ?? "packages/s3"}/scripts/use-for-vault.ts"`);
