import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { validateManifest } from "../scripts/validate.mjs";

const ROOT = process.cwd();
const PLUGIN_DIR = join(ROOT, "plugins");

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaAccepts = ajv.compile(
  JSON.parse(readFileSync(join(ROOT, "schema", "manifest.schema.json"), "utf8")),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function v2Manifest() {
  return {
    manifestVersion: 2,
    id: "v2-sample",
    name: "V2 sample",
    version: "1.0.0",
    developer: "Dev",
    configSchema: {
      type: "object",
      properties: { token: { type: "string", secret: true } },
      required: ["token"],
    },
    events: ["payment.paid"],
    scopes: ["data"],
    egress: ["api.exemplo.com", "api.outra.com"],
    flows: [
      {
        id: "on-paid",
        trigger: { type: "event", event: "payment.paid" },
        steps: [
          {
            id: "big-only",
            type: "condition",
            when: { left: "event.data.payment.amountCents", op: "gte", right: { value: 1000 } },
            onFalse: "stop",
          },
          {
            id: "lookup",
            type: "request",
            request: {
              method: "POST",
              url: "https://api.exemplo.com/lookup",
              headers: { authorization: "Bearer {{ config.token }}" },
              body: { id: "{{ event.data.payment.id }}" },
            },
          },
          {
            id: "push",
            type: "request",
            requires: ["steps.lookup.response.body.ok"],
            request: {
              method: "POST",
              url: "https://api.outra.com/push",
              body: { ref: "{{ steps.lookup.response.body.ref }}" },
            },
          },
        ],
      },
      {
        id: "nightly",
        trigger: { type: "schedule", cron: "0 3 * * *" },
        steps: [
          {
            id: "ping",
            type: "request",
            request: { method: "POST", url: "https://api.exemplo.com/ping" },
          },
        ],
      },
    ],
  };
}

function v1Manifest() {
  return clone(JSON.parse(readFileSync(join(PLUGIN_DIR, "ga4.json"), "utf8")));
}

function check(manifest, file = `${manifest.id}.json`) {
  return { schema: schemaAccepts(manifest), issues: validateManifest(file, manifest) };
}

describe("published manifests", () => {
  for (const file of readdirSync(PLUGIN_DIR).filter((name) => name.endsWith(".json"))) {
    test(`${file} passes the schema and the security rules`, () => {
      const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, file), "utf8"));
      const result = check(manifest, file);
      assert.equal(result.schema, true, JSON.stringify(schemaAccepts.errors));
      assert.deepEqual(result.issues, []);
    });
  }
});

describe("events", () => {
  for (const event of ["checkout.abandoned", "payment.free"]) {
    test(`an action on ${event} is accepted`, () => {
      const manifest = v1Manifest();
      manifest.events = [event];
      manifest.actions[0].on = event;
      const result = check(manifest);
      assert.equal(result.schema, true, JSON.stringify(schemaAccepts.errors));
      assert.deepEqual(result.issues, []);
    });
  }
});

describe("manifestVersion 2", () => {
  test("a manifest with flows, conditions, step outputs and a schedule is accepted", () => {
    const result = check(v2Manifest());
    assert.equal(result.schema, true, JSON.stringify(schemaAccepts.errors));
    assert.deepEqual(result.issues, []);
  });

  test("flows without manifestVersion are rejected", () => {
    const manifest = v2Manifest();
    delete manifest.manifestVersion;
    manifest.actions = v1Manifest().actions;
    const result = check(manifest);
    assert.equal(result.schema, false);
    assert.match(result.issues.join(" "), /requires "manifestVersion": 2/);
  });

  test("an unknown manifestVersion is rejected", () => {
    const result = check({ ...v2Manifest(), manifestVersion: 3 });
    assert.equal(result.schema, false);
    assert.match(result.issues.join(" "), /only supported manifestVersion is 2/);
  });

  test("a v2 manifest needs at least one action or one flow", () => {
    const result = check({ ...v2Manifest(), flows: [] });
    assert.equal(result.schema, false);
    assert.match(result.issues.join(" "), /at least one action or one flow/);
  });

  test("a v2 manifest may skip events and actions when it only has flows", () => {
    const manifest = v2Manifest();
    manifest.flows = [manifest.flows[1]];
    delete manifest.events;
    const result = check(manifest);
    assert.equal(result.schema, true, JSON.stringify(schemaAccepts.errors));
    assert.deepEqual(result.issues, []);
  });

  test("a third distinct egress host is rejected", () => {
    const manifest = v2Manifest();
    manifest.egress.push("api.terceira.com");
    assert.match(check(manifest).issues.join(" "), /egress names 3 hosts, over the limit of 2/);
  });

  test("a v1 manifest keeps the plain limit of 20 egress hosts", () => {
    const manifest = v1Manifest();
    manifest.egress.push("api.outra.com", "api.terceira.com");
    const result = check(manifest);
    assert.equal(result.schema, true);
    assert.deepEqual(result.issues, []);
  });

  test("a step host outside egress is rejected", () => {
    const manifest = v2Manifest();
    manifest.flows[0].steps[1].request.url = "https://api.desconhecida.com/lookup";
    assert.match(check(manifest).issues.join(" "), /not in the egress allowlist/);
  });

  test("a step may not read a step that runs after it", () => {
    const manifest = v2Manifest();
    manifest.flows[0].steps[1].request.body = { ref: "{{ steps.push.response.body.ref }}" };
    assert.match(check(manifest).issues.join(" "), /from a step that has not run yet/);
  });

  test("a step may only read the response of an upstream step", () => {
    const manifest = v2Manifest();
    manifest.flows[0].steps[2].request.body = { ref: "{{ steps.lookup.request.url }}" };
    assert.match(check(manifest).issues.join(" "), /may only read "steps\.lookup\.response\.\*"/);
  });

  test("a condition may not jump backwards", () => {
    const manifest = v2Manifest();
    manifest.flows[0].steps.push({
      id: "again",
      type: "condition",
      when: { left: "event.id", op: "exists" },
      onFalse: "lookup",
    });
    assert.match(check(manifest).issues.join(" "), /jumps backwards to "lookup"/);
  });

  test("the exists operator takes no right operand", () => {
    const manifest = v2Manifest();
    manifest.flows[0].steps[0].when = { left: "event.id", op: "exists", right: { value: 1 } };
    assert.match(check(manifest).issues.join(" "), /"exists" operator does not take a right operand/);
  });

  test("a predicate may not mix a comparison and a group", () => {
    const manifest = v2Manifest();
    manifest.flows[0].steps[0].when = {
      left: "event.id",
      op: "exists",
      all: [{ left: "event.id", op: "exists" }],
    };
    assert.equal(check(manifest).schema, false);
  });

  test("a schedule below the 60 minute floor is rejected", () => {
    const manifest = v2Manifest();
    manifest.flows[1].trigger.cron = "*/30 * * * *";
    assert.match(check(manifest).issues.join(" "), /fires every 30 minutes, below the floor of 60/);
  });

  test("an invalid cron expression is rejected", () => {
    const manifest = v2Manifest();
    manifest.flows[1].trigger.cron = "0 25 * * *";
    assert.match(check(manifest).issues.join(" "), /invalid cron expression/);
  });

  test("a flow may have at most 12 steps", () => {
    const manifest = v2Manifest();
    manifest.flows[1].steps = Array.from({ length: 13 }, (_, index) => ({
      id: `ping-${index}`,
      type: "request",
      request: { method: "POST", url: "https://api.exemplo.com/ping" },
    }));
    assert.match(check(manifest).issues.join(" "), /13 steps, over the limit of 12/);
  });

  test("an event trigger must be declared in events", () => {
    const manifest = v2Manifest();
    manifest.flows[0].trigger.event = "payment.refunded";
    assert.match(check(manifest).issues.join(" "), /triggers on "payment\.refunded" which is not declared/);
  });

  test('"stop" is not a valid step id', () => {
    const manifest = v2Manifest();
    manifest.flows[1].steps[0].id = "stop";
    assert.match(check(manifest).issues.join(" "), /"stop" is reserved/);
  });
});

describe("security rules", () => {
  test("a secret literal in a header is rejected like the backend publish does", () => {
    const manifest = v1Manifest();
    manifest.actions[0].request.headers = {
      authorization: `Bearer ${["sk", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_")}`,
    };
    assert.match(check(manifest).issues.join(" "), /secrets must come from configSchema/);
  });

  test("a templated host is rejected", () => {
    const manifest = v1Manifest();
    manifest.actions[0].request.url = "https://{{ config.host }}/collect";
    assert.match(check(manifest).issues.join(" "), /url host must be a literal/);
  });

  test("a private egress host is rejected", () => {
    const manifest = v1Manifest();
    manifest.egress.push("169.254.169.254");
    assert.match(check(manifest).issues.join(" "), /targets a private range/);
  });

  test("first-party infrastructure is rejected", () => {
    const manifest = v1Manifest();
    manifest.egress.push("api.yuvexpay.com");
    assert.match(check(manifest).issues.join(" "), /first-party infrastructure/);
  });

  test("an unterminated template expression is rejected", () => {
    const manifest = v1Manifest();
    manifest.actions[0].request.body.client_id = "{{ event.data.payment.id ";
    assert.match(check(manifest).issues.join(" "), /unterminated/);
  });

  test("an unknown template function is rejected", () => {
    const manifest = v1Manifest();
    manifest.actions[0].request.body.client_id = "{{ event.data.payment.id | base64 }}";
    assert.match(check(manifest).issues.join(" "), /unknown function "base64"/);
  });

  test("requires entries may not traverse the prototype chain", () => {
    const manifest = v1Manifest();
    manifest.actions[0].requires = ["event.__proto__.polluted"];
    const result = check(manifest);
    assert.equal(result.schema, false);
    assert.match(result.issues.join(" "), /traverses the prototype chain/);
  });

  test("an action must subscribe to a declared event", () => {
    const manifest = v1Manifest();
    manifest.actions[0].on = "payment.refunded";
    assert.match(check(manifest).issues.join(" "), /is not declared in events/);
  });
});
