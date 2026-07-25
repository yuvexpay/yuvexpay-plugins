import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_DIR = join(process.cwd(), "plugins");

function main() {
  const apiUrl = process.env.PLUGIN_PUBLISH_URL;
  const token = process.env.PLUGIN_PUBLISH_TOKEN;
  const commit = process.env.GITHUB_SHA ?? null;

  if (!apiUrl) {
    console.error("PLUGIN_PUBLISH_URL is not set");
    process.exit(1);
  }
  if (!token) {
    console.error("PLUGIN_PUBLISH_TOKEN is not set");
    process.exit(1);
  }

  const files = readdirSync(PLUGIN_DIR).filter((f) => f.endsWith(".json"));
  const manifests = files.map((f) =>
    JSON.parse(readFileSync(join(PLUGIN_DIR, f), "utf8")),
  );

  console.log(`Publishing ${manifests.length} manifest(s) from ${commit ?? "local"}`);

  return fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ manifests, prune: true, commit }),
  })
    .then(async (response) => {
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }

      if (!response.ok) {
        console.error(`Publish failed with status ${response.status}`);
        console.error(JSON.stringify(body, null, 2));
        process.exit(1);
      }

      console.log(JSON.stringify(body, null, 2));

      for (const entry of body.published ?? []) {
        console.log(`  ${entry.action.padEnd(9)} ${entry.slug}@${entry.version}`);
      }
      for (const slug of body.disabled ?? []) {
        console.log(`  disabled  ${slug}`);
      }
      for (const slug of body.reactivated ?? []) {
        console.log(`  restored  ${slug}`);
      }
    })
    .catch((error) => {
      console.error(`Publish request failed: ${error.message}`);
      process.exit(1);
    });
}

await main();
