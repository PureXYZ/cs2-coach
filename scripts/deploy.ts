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

const remote = [
  "cd /root/cs2-coach",
  "git pull --ff-only",
  "docker build -t cs2-coach .",
  "(docker rm -f coach >/dev/null 2>&1 || true)",
  "docker run -d --name coach --restart unless-stopped --env-file .env -p 3000:3000 cs2-coach",
  "sleep 5",
  "docker logs --tail 8 coach 2>&1",
].join(" && ");

console.log(`Deploying GitHub main to ${host} ...`);
const result = spawnSync("ssh", [host, remote], { stdio: "inherit" });
if (result.status === 0) {
  console.log("\nDeployed. If the coach was in voice, run /coach join again.");
}
process.exit(result.status ?? 1);
