/**
 * Package: espocrm
 * Purpose: run a piece of PHP inside EspoCRM, with EspoCRM's own classes
 *          loaded, as the user its files belong to. Settings are read and
 *          written through EspoCRM's own config classes, so a secret lands in
 *          the file EspoCRM keeps secrets in.
 * Used by: setup.ts, connect-sign-in.ts
 *
 * @module
 */
import { envGet } from "./_setup-env.ts";

export const container = envGet("ESPOCRM_CONTAINER_NAME") || `${envGet("CONTAINER_PREFIX")}espocrm`;

const HEAD = `<?php
chdir('/var/www/html');
require 'bootstrap.php';
$app = new \\Espo\\Core\\Application();
$app->setupSystemUser();
$factory = $app->getContainer()->getByClass(\\Espo\\Core\\InjectableFactory::class);
$config = $app->getContainer()->getByClass(\\Espo\\Core\\Utils\\Config::class);
$input = json_decode(getenv('VIA_INPUT') ?: '{}', true);
`;

/** Run PHP (without the opening tag) inside EspoCRM; `input` arrives there as the array $input. */
export function php(body: string, input: unknown = {}): { ok: boolean; out: string; err: string } {
  const run = Bun.spawnSync(
    ["docker", "exec", "-i", "-u", "www-data", "-e", `VIA_INPUT=${JSON.stringify(input)}`, container, "php"],
    {
      stdin: Buffer.from(HEAD + body),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    ok: run.exitCode === 0,
    out: run.stdout.toString().trim(),
    err: (run.stderr.toString().trim() || run.stdout.toString().trim()).slice(0, 400),
  };
}
