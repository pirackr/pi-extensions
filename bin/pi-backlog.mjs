#!/usr/bin/env node
try {
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url);
  const { runCli } = await jiti.import('../modules/backlog/cli.ts');
  process.exitCode = await runCli(process.argv.slice(2));
} catch {
  const error = {code:'STORE_ERROR',message:'Unable to start pi-backlog; use Node >=22.19 and install package dependencies',details:{}};
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({apiVersion:1,ok:false,error})+'\n');
  else process.stderr.write(error.message+'\n');
  process.exitCode = 1;
}
