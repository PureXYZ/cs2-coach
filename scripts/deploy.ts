/**
 * One-command deploy to the cloud host: `npm run deploy`
 *
 * SSHes into DEPLOY_HOST (set in .env, e.g. root@203.0.113.7), pulls the latest
 * main from GitHub, rebuilds the Docker image, and restarts the container.
 *
 * Deploys what's on GitHub — commit and push first. The restart drops the bot
 * from voice for ~30s; run /coach join afterwards.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";

const host = process.env.DEPLOY_HOST;
if (!host) {
  console.error("Set DEPLOY_HOST in .env (e.g. DEPLOY_HOST=root@203.0.113.7)");
  process.exit(1);
}

// The actual deploy logic lives on the host at /root/deploy.sh (documented in
// docs/HOSTING.md) so the manual path and GitHub Actions run the exact same steps.
const remote = "bash /root/deploy.sh";

console.log(`Deploying GitHub main to ${host} ...`);
const result = spawnSync("ssh", [host, remote], { stdio: "inherit" });
if (result.error) {
  console.error("Could not run ssh:", result.error.message);
  process.exit(1);
}
if (result.status === 0) {
  console.log("\nDeployed. If the coach was in voice, run /coach join again.");
}
process.exit(result.status ?? 1);
