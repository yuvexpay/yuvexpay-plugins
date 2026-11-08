import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const SCHEMA_FILE = "schema/manifest.schema.json";
const DATA_DIR = "plugins";

function openFile(file) {
  try {
    return JSON.parse(readFileSync(resolve(file), "utf8").replace(/^﻿/, ""));
  } catch (error) {
    console.error(`error:  ${resolve(file)}: ${error.message}`);
    process.exit(2);
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const schema = openFile(SCHEMA_FILE);
let validate;
try {
  validate = ajv.compile(schema);
} catch (error) {
  console.error(`schema ${SCHEMA_FILE} is invalid`);
  console.error(`error: ${error.message}`);
  process.exit(1);
}

const files = readdirSync(DATA_DIR)
  .filter((name) => name.endsWith(".json") && !name.startsWith("."))
  .sort((a, b) => a.localeCompare(b, "en"))
  .map((name) => `${DATA_DIR}/${name}`);

let allValid = true;
for (const file of files) {
  if (validate(openFile(file))) {
    console.log(file, "valid");
  } else {
    console.error(file, "invalid");
    console.error(validate.errors);
    allValid = false;
  }
}

process.exit(allValid ? 0 : 1);
